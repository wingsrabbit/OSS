// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  SCHEMA_023_CATALOG_DIGEST,
  assertSchema023CatalogDigest,
  schema023CatalogDigest,
  schema023CatalogFingerprintInput,
} from "@opensales/core/schema-022-023-native-compatibility";
import {
  EXPECTED_SCHEMA_028_HISTORY,
  SCHEMA_028,
} from "@opensales/core/schema-027-028-native-compatibility";
import pg from "pg";
import { digestToken, passwordHash } from "./auth.js";

const coreUrl = process.env.CORE_TEST_URL ?? "http://127.0.0.1:3000";
const providerUrl = process.env.MOCK_PROVISIONING_PROVIDER_URL ?? "http://127.0.0.1:4000";
const databaseUrl = process.env.DATABASE_URL;
const workerDatabaseUrl = process.env.SERVICE_OPERATION_WORKER_DATABASE_URL ?? databaseUrl;
const providerDatabaseUrl = process.env.PROVIDER_DATABASE_URL;
const providerToken = process.env.MOCK_PROVISIONING_PROVIDER_TOKEN;
const stateFile = process.env.SERVICE_OPERATION_STATE_FILE;
const phase = process.env.SERVICE_OPERATION_INTEGRATION_PHASE ?? "normal";
if (!databaseUrl || !providerDatabaseUrl || !providerToken) {
  throw new Error("Core and Mock Provider database configuration is required");
}

const core = new pg.Pool({
  connectionString: databaseUrl,
  max: 12,
  options: "-c search_path=pg_catalog,public",
  statement_timeout: 20_000,
  application_name: `opensales-service-operations-${phase}`,
});
const workerCore = new pg.Pool({
  connectionString: workerDatabaseUrl,
  max: 8,
  options: "-c search_path=pg_catalog,public",
  statement_timeout: 20_000,
  application_name: `opensales-service-operations-worker-${phase}`,
});
const provider = new pg.Pool({
  connectionString: providerDatabaseUrl,
  max: 6,
  statement_timeout: 20_000,
  application_name: `opensales-service-operations-provider-${phase}`,
});

const fullCapabilities = [
  "resource_create",
  "resource_reconcile",
  "resource_suspend",
  "resource_resume",
  "resource_terminate",
  "resource.start",
  "resource.stop",
  "resource.reboot",
] as const;

type Actor = Readonly<{
  userId: string;
  sessionId: string;
  token: string;
  accountId: string | null;
}>;
type ServiceFixture = Readonly<{
  serviceId: string;
  externalResourceId: string;
}>;
type OperationList = Readonly<{
  service: {
    id: string;
    status: string;
    version: number;
    resourceState: "running" | "stopped" | "terminated" | null;
    resourceRevision: number;
    availableActions: Array<"start" | "stop" | "reboot">;
  };
  items: Array<{
    requestId: string;
    action: "start" | "stop" | "reboot";
    executionMode: "automatic" | "manual";
    status: string;
    revision: number;
    resultingResourceState: string | null;
    reasonCode: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
}>;
type CreatedOperation = Readonly<{
  requestId: string;
  serviceId: string;
  action: "start" | "stop" | "reboot";
  executionMode: "automatic" | "manual";
  status: string;
  replayed: boolean;
}>;
type ServiceOperationJob = Readonly<{
  id: string;
  job_type: string;
  unique_key: string;
  payload: Record<string, string>;
  payload_snapshot: string;
  attempts: number;
  locked_at_epoch: string;
  locked_by: string | null;
}>;
type ServiceOperationRuntime = Readonly<{
  workerId: string;
  providerUrl: string;
  providerToken: string;
  providerTimeoutMs: number;
  scenario: "normal" | "failure" | "duplicate" | "out_of_order" | "timeout" | "restart";
  reconcileBaseDelaySeconds: number;
  reconcileMaxAttempts: number;
  staleLockSeconds: number;
}>;
type ServiceWorkerModule = Readonly<{
  isServiceOperationLeaseLostError(error: unknown): boolean;
  persistUnexpectedServiceOperationFailure(
    pool: pg.Pool,
    job: ServiceOperationJob,
    runtime: ServiceOperationRuntime,
    error: unknown,
  ): Promise<void>;
  processServiceOperationStart(
    pool: pg.Pool,
    job: ServiceOperationJob,
    runtime: ServiceOperationRuntime,
    hooks?: Readonly<{
      beforeDispatchAuthorizationRecheck?: () => void | Promise<void>;
      afterProviderMutation?: () => void | Promise<void>;
    }>,
  ): Promise<void>;
  processServiceOperationReconcile(
    pool: pg.Pool,
    job: ServiceOperationJob,
    runtime: ServiceOperationRuntime,
    hooks?: Readonly<{ beforeProviderGet?: () => void | Promise<void> }>,
  ): Promise<void>;
  recoverStaleServiceOperationJobs(
    pool: pg.Pool,
    runtime: ServiceOperationRuntime,
  ): Promise<number>;
}>;

async function loadServiceWorker(): Promise<ServiceWorkerModule> {
  const moduleUrl = new URL("../../worker/dist/service-operations.js", import.meta.url);
  return await import(moduleUrl.href) as ServiceWorkerModule;
}

async function claimServiceOperationJob(workerId: string): Promise<ServiceOperationJob | null> {
  const result = await workerCore.query<ServiceOperationJob>(
    `WITH candidate AS (
       SELECT id
       FROM durable_jobs
       WHERE status = 'pending'
         AND available_at <= pg_catalog.clock_timestamp()
         AND job_type IN ('service.operation.start', 'service.operation.reconcile')
       ORDER BY available_at, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE durable_jobs job
     SET status = 'running', attempts = job.attempts + 1,
         locked_at = pg_catalog.clock_timestamp(), locked_by = $1,
         updated_at = pg_catalog.clock_timestamp()
     FROM candidate
     WHERE job.id = candidate.id
     RETURNING job.id, job.job_type, job.unique_key, job.payload,
               job.payload::text AS payload_snapshot, job.attempts,
               EXTRACT(epoch FROM job.locked_at)::numeric::text AS locked_at_epoch,
               job.locked_by`,
    [workerId],
  );
  return result.rows[0] ?? null;
}

async function claimServiceOperationJobForRequest(
  workerId: string,
  requestId: string,
  jobType: "service.operation.start" | "service.operation.reconcile",
): Promise<ServiceOperationJob> {
  const result = await workerCore.query<ServiceOperationJob>(
    `UPDATE durable_jobs job
        SET status = 'running', attempts = job.attempts + 1,
            locked_at = pg_catalog.clock_timestamp(), locked_by = $1,
            updated_at = pg_catalog.clock_timestamp()
      WHERE job.job_type = $2
        AND job.payload->>'requestId' = $3
        AND job.status = 'pending'
        AND job.available_at <= pg_catalog.clock_timestamp()
      RETURNING job.id, job.job_type, job.unique_key, job.payload,
                job.payload::text AS payload_snapshot, job.attempts,
                EXTRACT(epoch FROM job.locked_at)::numeric::text AS locked_at_epoch,
                job.locked_by`,
    [workerId, jobType, requestId],
  );
  assert.equal(result.rowCount, 1, `${jobType} must have one pending claim for ${requestId}`);
  return result.rows[0]!;
}

async function withServiceWorker<T>(
  scenario: ServiceOperationRuntime["scenario"],
  work: () => Promise<T>,
): Promise<T> {
  const worker = await loadServiceWorker();
  const runtime: ServiceOperationRuntime = {
    workerId: `service-operations-integration-${scenario}-${process.pid}`,
    providerUrl,
    providerToken: process.env.MOCK_PROVIDER_PLATFORM_TOKEN ?? providerToken!,
    providerTimeoutMs: scenario === "timeout" ? 20 : 2_000,
    scenario,
    reconcileBaseDelaySeconds: 1,
    reconcileMaxAttempts: 3,
    staleLockSeconds: 2,
  };
  let stopping = false;
  let pumpFailure: unknown;
  const pump = (async () => {
    while (!stopping) {
      try {
        await worker.recoverStaleServiceOperationJobs(workerCore, runtime);
        const job = await claimServiceOperationJob(runtime.workerId);
        if (!job) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          continue;
        }
        try {
          if (job.job_type === "service.operation.start") {
            await worker.processServiceOperationStart(workerCore, job, runtime);
          } else {
            await worker.processServiceOperationReconcile(workerCore, job, runtime);
          }
        } catch (error) {
          if (worker.isServiceOperationLeaseLostError(error)) continue;
          await worker.persistUnexpectedServiceOperationFailure(workerCore, job, runtime, error);
        }
      } catch (error) {
        pumpFailure = error;
        stopping = true;
      }
    }
  })();
  try {
    const result = await work();
    if (pumpFailure) throw pumpFailure;
    return result;
  } finally {
    stopping = true;
    await pump;
    if (pumpFailure) throw pumpFailure;
  }
}

async function tx<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function expectTransactionFailure(
  description: string,
  work: (client: pg.PoolClient) => Promise<void>,
  expectedMessage?: RegExp,
): Promise<void> {
  await assert.rejects(tx(core, work), (error: unknown) => {
    assert.ok(error instanceof Error, description);
    if (expectedMessage) assert.match(error.message, expectedMessage, description);
    return true;
  });
}

async function ensureCatalog(): Promise<void> {
  await tx(core, async (client) => {
    await client.query(
      `INSERT INTO product_groups(id, sort_order, names)
       VALUES ('service-operations-integration', 999,
               '{"en":"Service operations integration","zh-CN":"服务操作集成"}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO products(
         id, group_id, names, descriptions, fulfillment_mode, active, hidden,
         repeatable, option_schema
       ) VALUES (
         'service-operations-integration', 'service-operations-integration',
         '{"en":"Synthetic daily operations","zh-CN":"合成日常操作"}'::jsonb,
         '{"en":"Mock-only integration fixture","zh-CN":"仅 Mock 集成夹具"}'::jsonb,
         'automatic', true, true, true, '[]'::jsonb
       ) ON CONFLICT (id) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO provider_installation_capabilities(
         provider_installation_id, provider_type, enabled, capabilities
       ) VALUES ('mock-provisioning-v1', 'provisioning', true, $1::jsonb)
       ON CONFLICT (provider_installation_id) DO UPDATE
       SET enabled = true,
           capabilities = EXCLUDED.capabilities,
           version = provider_installation_capabilities.version + 1,
           updated_at = now()`,
      [JSON.stringify(fullCapabilities)],
    );
    await client.query(
      `INSERT INTO product_service_automation_policies(
         product_id, overdue_action, provider_installation_id,
         overdue_delay_mode, overdue_delay_value, version,
         cycle_end_cancellation_mode, cycle_end_cancellation_execution_mode,
         cycle_end_cancellation_min_notice_hours,
         cycle_end_cancellation_requirement_key
       ) VALUES (
         'service-operations-integration', 'automatic', 'mock-provisioning-v1',
         'policy_calendar_days', 5, 1, 'self_service', 'automatic', 0, NULL
       ) ON CONFLICT (product_id) DO NOTHING`,
    );
  });
}

async function createAccountFixture(label: string): Promise<{
  owner: Actor;
  technical: Actor;
  billing: Actor;
  viewer: Actor;
}> {
  const accountId = randomUUID();
  const roles = ["owner", "technical", "billing", "viewer"] as const;
  const actors = new Map<string, Actor>();
  await tx(core, async (client) => {
    const ids = new Map(roles.map((role) => [role, randomUUID()]));
    for (const role of roles) {
      const userId = ids.get(role)!;
      await client.query(
        `INSERT INTO users(id, email, password_hash, locale, email_verified_at)
         VALUES ($1, $2, 'synthetic-not-a-password', 'en', now())`,
        [userId, `service-ops-${label}-${role}-${userId}@example.invalid`],
      );
    }
    await client.query(
      "INSERT INTO client_accounts(id, name, owner_user_id) VALUES ($1, $2, $3)",
      [accountId, `Synthetic Service Operations ${label}`, ids.get("owner")],
    );
    for (const role of roles) {
      const userId = ids.get(role)!;
      const sessionId = randomUUID();
      const token = randomBytes(32).toString("base64url");
      await client.query(
        `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
         VALUES ($1, $2, $3, '[]'::jsonb)`,
        [accountId, userId, role],
      );
      await client.query(
        `INSERT INTO sessions(
           id, user_id, token_digest, expires_at,
           active_client_account_id, account_context_version
         ) VALUES ($1, $2, $3, now() + interval '2 hours', $4, 1)`,
        [sessionId, userId, digestToken(token), accountId],
      );
      actors.set(role, { userId, sessionId, token, accountId });
    }
  });
  return {
    owner: actors.get("owner")!,
    technical: actors.get("technical")!,
    billing: actors.get("billing")!,
    viewer: actors.get("viewer")!,
  };
}

async function createStaff(label: string): Promise<Actor> {
  const userId = randomUUID();
  const sessionId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  await tx(core, async (client) => {
    await client.query(
      `INSERT INTO users(id, email, password_hash, locale, email_verified_at)
       VALUES ($1, $2, 'synthetic-not-a-password', 'en', now())`,
      [userId, `service-ops-${label}-staff-${userId}@example.invalid`],
    );
    await client.query(
      `INSERT INTO sessions(id, user_id, token_digest, expires_at, account_context_version)
       VALUES ($1, $2, $3, now() + interval '2 hours', 0)`,
      [sessionId, userId, digestToken(token)],
    );
    await client.query(
      `INSERT INTO staff_members(user_id, roles, permissions)
       VALUES ($1, ARRAY['ServiceOperations'],
               '["services.read","services.operations_manage"]'::jsonb)`,
      [userId],
    );
    await client.query(
      `INSERT INTO reauth_grants(user_id, session_id, expires_at)
       VALUES ($1, $2, now() + interval '10 minutes')`,
      [userId, sessionId],
    );
  });
  return { userId, sessionId, token, accountId: null };
}

async function createExpiringActorSession(
  actor: Actor,
  sessionTtlSeconds: number,
  reauthTtlSeconds = sessionTtlSeconds,
): Promise<Actor> {
  const sessionId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  await tx(core, async (client) => {
    await client.query(
      `INSERT INTO sessions(
         id, user_id, token_digest, expires_at,
         active_client_account_id, account_context_version
       ) VALUES ($1, $2, $3,
                 pg_catalog.clock_timestamp() + make_interval(secs => $5),
                 $4, CASE WHEN $4::uuid IS NULL THEN 0 ELSE 1 END)`,
      [sessionId, actor.userId, digestToken(token), actor.accountId, sessionTtlSeconds],
    );
    if (actor.accountId === null) {
      await client.query(
        `INSERT INTO reauth_grants(user_id, session_id, expires_at)
         VALUES ($1, $2,
                 pg_catalog.clock_timestamp() + make_interval(secs => $3))`,
        [actor.userId, sessionId, reauthTtlSeconds],
      );
    }
  });
  return { ...actor, sessionId, token };
}

async function createService(
  account: Actor,
  automatic: boolean,
  label: string,
  termSeconds = 30 * 24 * 60 * 60,
  productId = "service-operations-integration",
): Promise<ServiceFixture> {
  assert.ok(account.accountId);
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const serviceId = randomUUID();
  const externalResourceId = `mock-service-operations-${label}-${serviceId}`;
  const priceSnapshot = {
    productId,
    productName: "Synthetic daily operations",
    currency: "USD",
    billingCycle: "monthly",
    fulfillmentMode: "automatic",
    components: [
      {
        code: "base",
        label: "Synthetic daily operations",
        quantity: 1,
        oneTimeMinor: "0",
        recurringMinor: "100",
      },
    ],
    oneTimeSubtotalMinor: "0",
    setupMinor: "0",
    recurringSubtotalMinor: "100",
    invoiceTotalMinor: "100",
  };
  await tx(core, async (client) => {
    await client.query(
      `INSERT INTO orders(
         id, client_account_id, submitted_by_user_id, status, currency,
         price_snapshot, one_time_minor, setup_minor, recurring_minor,
         total_minor, idempotency_key, request_fingerprint
       ) VALUES ($1, $2, $3, 'completed', 'USD', $4,
                 0, 0, 100, 100, $5, $6)`,
      [
        orderId,
        account.accountId,
        account.userId,
        priceSnapshot,
        `service-operations-order-${orderId}`,
        createHash("sha256").update(orderId).digest("hex"),
      ],
    );
    await client.query(
      `INSERT INTO order_items(
         id, order_id, product_id, product_name, fulfillment_mode,
         billing_cycle, configuration, price_snapshot, client_account_id
       ) VALUES ($1, $2, $4,
                 'Synthetic daily operations', 'automatic', 'monthly',
                 '{}'::jsonb, $5, $3)`,
      [orderItemId, orderId, account.accountId, productId, priceSnapshot],
    );
    await client.query(
      `INSERT INTO services(
         id, client_account_id, order_item_id, status, billing_cycle,
         external_resource_id, activated_at, term_start, term_end
       ) VALUES ($1, $2, $3, 'active', 'monthly', $4, now(), now(),
                 now() + make_interval(secs => $5))`,
      [serviceId, account.accountId, orderItemId, externalResourceId, termSeconds],
    );
    if (automatic) {
      await client.query(
        `INSERT INTO service_provider_bindings(
           service_id, provider_installation_id, overdue_action_snapshot,
           capability_snapshot, product_policy_version,
           cycle_end_cancellation_mode_snapshot,
           cycle_end_cancellation_execution_mode_snapshot,
           cycle_end_cancellation_min_notice_hours_snapshot,
           cycle_end_cancellation_requirement_key_snapshot
         ) SELECT $1, policy.provider_installation_id, policy.overdue_action,
                  provider.capabilities, policy.version,
                  policy.cycle_end_cancellation_mode,
                  policy.cycle_end_cancellation_execution_mode,
                  policy.cycle_end_cancellation_min_notice_hours,
                  policy.cycle_end_cancellation_requirement_key
           FROM product_service_automation_policies policy
           JOIN provider_installation_capabilities provider
             ON provider.provider_installation_id = policy.provider_installation_id
          WHERE policy.product_id = $2`,
        [serviceId, productId],
      );
    }
  });
  await provider.query(
    `INSERT INTO mock_resource_operations(
       operation_id, service_id, external_resource_id, callback_capability,
       scenario, status, ready_at, request_fingerprint,
       resource_state, power_state, desired_power_state
     ) VALUES ($1, $2, $3, $4, 'success', 'succeeded', now(), $5,
               'active', 'running', 'running')`,
    [randomUUID(), serviceId, externalResourceId, "A".repeat(43), `fixture:${serviceId}`],
  );
  return { serviceId, externalResourceId };
}

function headers(actor: Actor): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Cookie: `oss_session=${actor.token}`,
    ...(actor.accountId ? { "X-OSS-Account-Context-Version": "1" } : {}),
  };
}

async function api<T>(
  actor: Actor,
  path: string,
  init: RequestInit = {},
  expectedStatus = 200,
): Promise<T> {
  const response = await fetch(new URL(path, coreUrl), {
    ...init,
    headers: { ...headers(actor), ...init.headers },
    redirect: "error",
  });
  const body = await response.text();
  assert.equal(
    response.status,
    expectedStatus,
    `${init.method ?? "GET"} ${path}: ${response.status} ${body}`,
  );
  return body ? JSON.parse(body) as T : undefined as T;
}

async function list(actor: Actor, serviceId: string): Promise<OperationList> {
  return api(actor, `/api/v1/services/${serviceId}/operations`);
}

async function waitFor<T>(
  description: string,
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let current: T;
  do {
    current = await read();
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(current!)}`);
}

async function waitPastDatabaseTimestamp(timestamp: Date): Promise<void> {
  const remaining = timestamp.getTime() - Date.now() + 150;
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

async function requestCustomerOperation(
  actor: Actor,
  serviceId: string,
  state: OperationList["service"],
  action: "start" | "stop" | "reboot",
  idempotencyKey = `${action}-${randomUUID()}`,
  expectedStatus = 201,
): Promise<CreatedOperation> {
  return api(
    actor,
    `/api/v1/services/${serviceId}/operations`,
    {
      method: "POST",
      body: JSON.stringify({
        action,
        expectedServiceVersion: state.version,
        expectedResourceRevision: state.resourceRevision,
        idempotencyKey,
      }),
    },
    expectedStatus,
  );
}

async function scheduleCancellation(
  actor: Actor,
  serviceId: string,
  expectedVersion: number,
): Promise<{ serviceVersion: number; cancellation: { effectiveAt: string } }> {
  return api(
    actor,
    `/api/v1/services/${serviceId}/cancellation`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedVersion,
        reason: "Synthetic cancellation independence verification",
        idempotencyKey: `cancel-${randomUUID()}`,
      }),
    },
    201,
  );
}

async function waitForResult(
  actor: Actor,
  serviceId: string,
  requestId: string,
  statuses: readonly string[],
): Promise<OperationList> {
  return waitFor(
    `${requestId} to reach ${statuses.join("/")}`,
    () => list(actor, serviceId),
    (value) => statuses.includes(value.items.find((item) => item.requestId === requestId)?.status ?? ""),
  );
}

function assertCustomerFactProjection(
  response: OperationList,
  requestId: string,
  expectedReasonCode: string | null,
): void {
  const fact = response.items.find((item) => item.requestId === requestId);
  assert.ok(fact);
  assert.deepEqual(Object.keys(fact).sort(), [
    "action",
    "createdAt",
    "executionMode",
    "reasonCode",
    "requestId",
    "resultingResourceState",
    "revision",
    "status",
    "updatedAt",
  ]);
  assert.equal(fact.reasonCode, expectedReasonCode);
  assert.ok(Date.parse(fact.updatedAt) >= Date.parse(fact.createdAt));
}

async function coreProviderOperationId(requestId: string): Promise<string> {
  const result = await core.query<{ id: string }>(
    `SELECT id::text
       FROM provider_operations
      WHERE subject_type = 'service_resource_operation' AND subject_id = $1`,
    [requestId],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0]!.id;
}

async function providerLifecycleAction(
  fixture: ServiceFixture,
  action: "suspend" | "resume",
): Promise<void> {
  const operationId = randomUUID();
  const response = await fetch(new URL("/v1/resource-actions", providerUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${providerToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": operationId,
    },
    body: JSON.stringify({
      operationId,
      serviceId: fixture.serviceId,
      externalResourceId: fixture.externalResourceId,
      callbackCapability: "B".repeat(43),
      action,
      scenario: "success",
    }),
  });
  assert.equal(response.status, 202, await response.text());
}

async function runNormal(): Promise<void> {
  await ensureCatalog();
  const account = await createAccountFixture(`normal-${randomUUID()}`);
  const other = await createAccountFixture(`other-${randomUUID()}`);
  const staff = await createStaff(`normal-${randomUUID()}`);
  const automatic = await createService(account.owner, true, "normal");
  const permissionTarget = await createService(account.owner, true, "permissions");
  const manual = await createService(account.owner, false, "manual");
  const nonMockInstallationId = `synthetic-non-mock-${randomUUID()}`;
  const nonMockProductId = `service-operations-non-mock-${randomUUID()}`;
  await tx(core, async (client) => {
    await client.query(
      `INSERT INTO provider_installation_capabilities(
         provider_installation_id, provider_type, enabled, capabilities
       ) VALUES ($1, 'provisioning', true, $2::jsonb)`,
      [nonMockInstallationId, JSON.stringify(fullCapabilities)],
    );
    await client.query(
      `INSERT INTO products(
         id, group_id, names, descriptions, fulfillment_mode, active, hidden,
         repeatable, option_schema
       ) VALUES (
         $1, 'service-operations-integration',
         '{"en":"Synthetic non-Mock selector","zh-CN":"合成非Mock选择器"}'::jsonb,
         '{"en":"Authority negative fixture","zh-CN":"权限负向夹具"}'::jsonb,
         'automatic', true, true, true, '[]'::jsonb
       )`,
      [nonMockProductId],
    );
    await client.query(
      `INSERT INTO product_service_automation_policies(
         product_id, overdue_action, provider_installation_id,
         overdue_delay_mode, overdue_delay_value, version,
         cycle_end_cancellation_mode, cycle_end_cancellation_execution_mode,
         cycle_end_cancellation_min_notice_hours
       ) VALUES ($1, 'automatic', $2, 'policy_calendar_days', 5, 1,
                 'self_service', 'automatic', 0)`,
      [nonMockProductId, nonMockInstallationId],
    );
  });
  const nonMock = await createService(
    account.owner,
    true,
    "non-mock-selector",
    30 * 24 * 60 * 60,
    nonMockProductId,
  );

  const selectorState = await list(account.owner, permissionTarget.serviceId);
  await expectTransactionFailure("raw DML cannot downgrade an available Mock capability to manual", async (client) => {
    const requestId = randomUUID();
    const fingerprint = await client.query<{ value: string }>(
      `SELECT opensales_service_operation_request_fingerprint(
         'services.daily-operation:v1',
         jsonb_build_object(
           'serviceId', $1::text,
           'action', 'stop',
           'expectedServiceVersion', $2::integer,
           'expectedResourceRevision', $3::integer
         )
       ) AS value`,
      [permissionTarget.serviceId, selectorState.service.version, selectorState.service.resourceRevision],
    );
    await client.query(
      `INSERT INTO service_resource_operation_requests(
         id, service_id, client_account_id, actor_type, actor_user_id,
         actor_session_id, action, expected_service_version,
         expected_resource_revision, execution_mode, provider_installation_id,
         provider_capability_snapshot, idempotency_key, request_fingerprint
       ) VALUES ($1, $2, $3, 'user', $4, $5, 'stop', $6, $7,
                 'manual', NULL, '{}'::jsonb, $8, $9)`,
      [
        requestId,
        permissionTarget.serviceId,
        account.owner.accountId,
        account.owner.userId,
        account.owner.sessionId,
        selectorState.service.version,
        selectorState.service.resourceRevision,
        `raw-manual-downgrade-${requestId}`,
        fingerprint.rows[0]!.value,
      ],
    );
    await client.query(
      `INSERT INTO service_resource_operation_result_facts(
         request_id, revision, status, detail, evidence
       ) VALUES ($1, 1, 'manual', 'forged manual selector downgrade',
                 '{"providerCalled":false}'::jsonb)`,
      [requestId],
    );
  });

  const nonMockState = await list(account.owner, nonMock.serviceId);
  await expectTransactionFailure("raw DML cannot force automatic dispatch to a non-Mock installation", async (client) => {
    const requestId = randomUUID();
    const providerOperationId = randomUUID();
    const selector = await client.query<{ fingerprint: string; snapshot: unknown }>(
      `SELECT opensales_service_operation_request_fingerprint(
                'services.daily-operation:v1',
                jsonb_build_object(
                  'serviceId', $1::text,
                  'action', 'stop',
                  'expectedServiceVersion', $2::integer,
                  'expectedResourceRevision', $3::integer
                )
              ) AS fingerprint,
              jsonb_build_object(
                'atBinding', binding.capability_snapshot,
                'current', provider.capabilities,
                'currentVersion', provider.version
              ) AS snapshot
         FROM service_provider_bindings binding
         JOIN provider_installation_capabilities provider
           ON provider.provider_installation_id = binding.provider_installation_id
        WHERE binding.service_id = $1::uuid`,
      [nonMock.serviceId, nonMockState.service.version, nonMockState.service.resourceRevision],
    );
    await client.query(
      `INSERT INTO service_resource_operation_requests(
         id, service_id, client_account_id, actor_type, actor_user_id,
         actor_session_id, action, expected_service_version,
         expected_resource_revision, execution_mode, provider_installation_id,
         provider_capability_snapshot, idempotency_key, request_fingerprint
       ) VALUES ($1, $2, $3, 'user', $4, $5, 'stop', $6, $7,
                 'automatic', $8, $9, $10, $11)`,
      [
        requestId,
        nonMock.serviceId,
        account.owner.accountId,
        account.owner.userId,
        account.owner.sessionId,
        nonMockState.service.version,
        nonMockState.service.resourceRevision,
        nonMockInstallationId,
        selector.rows[0]!.snapshot,
        `raw-non-mock-force-${requestId}`,
        selector.rows[0]!.fingerprint,
      ],
    );
    await client.query(
      `INSERT INTO provider_operations(
         id, provider_installation_id, kind, subject_type, subject_id,
         stable_key, status
       ) VALUES ($1, $2, 'resource.stop', 'service_resource_operation', $3,
                 $4, 'queued')`,
      [
        providerOperationId,
        nonMockInstallationId,
        requestId,
        `service-operation:${requestId}:stop`,
      ],
    );
    await client.query(
      `INSERT INTO durable_jobs(job_type, unique_key, payload)
       VALUES ('service.operation.start', $1, $2)`,
      [
        `service-operation:${requestId}:start`,
        {
          requestId,
          serviceId: nonMock.serviceId,
          providerOperationId,
        },
      ],
    );
  });

  const initial = await list(account.owner, automatic.serviceId);
  assert.deepEqual(initial.service.availableActions.sort(), ["reboot", "stop"]);
  const stableKey = `customer-stop-${randomUUID()}`;
  const stop = await requestCustomerOperation(
    account.owner,
    automatic.serviceId,
    initial.service,
    "stop",
    stableKey,
  );
  assert.equal(stop.executionMode, "automatic");
  const replay = await requestCustomerOperation(
    account.owner,
    automatic.serviceId,
    initial.service,
    "stop",
    stableKey,
    200,
  );
  assert.equal(replay.requestId, stop.requestId);
  assert.equal(replay.replayed, true);
  await api(
    account.owner,
    `/api/v1/services/${automatic.serviceId}/operations`,
    {
      method: "POST",
      body: JSON.stringify({
        action: "reboot",
        expectedServiceVersion: initial.service.version,
        expectedResourceRevision: initial.service.resourceRevision,
        idempotencyKey: stableKey,
      }),
    },
    409,
  );
  const stopped = await waitForResult(
    account.owner,
    automatic.serviceId,
    stop.requestId,
    ["succeeded"],
  );
  assert.equal(stopped.service.resourceState, "stopped");
  assert.equal(stopped.service.status, "active");
  assertCustomerFactProjection(stopped, stop.requestId, null);

  const stopProjection = await core.query<{
    service_status: string;
    desired_state: string;
    observed_state: string;
    attempt_count: number;
  }>(
    `SELECT service.status AS service_status,
            desired.state AS desired_state,
            observed.state AS observed_state,
            (SELECT count(*)::integer
             FROM service_resource_operation_attempt_facts attempt
             WHERE attempt.request_id = $2 AND attempt.attempt_kind = 'mutation') AS attempt_count
       FROM services service
       JOIN LATERAL (
         SELECT state FROM service_resource_desired_state_facts
         WHERE service_id = service.id ORDER BY desired_revision DESC LIMIT 1
       ) desired ON true
       JOIN LATERAL (
         SELECT state FROM service_resource_state_facts
         WHERE service_id = service.id ORDER BY resource_revision DESC LIMIT 1
       ) observed ON true
      WHERE service.id = $1`,
    [automatic.serviceId, stop.requestId],
  );
  assert.deepEqual(stopProjection.rows[0], {
    service_status: "active",
    desired_state: "stopped",
    observed_state: "stopped",
    attempt_count: 1,
  });

  await providerLifecycleAction(automatic, "suspend");
  await core.query("UPDATE services SET status = 'suspended', version = version + 1 WHERE id = $1", [
    automatic.serviceId,
  ]);
  await providerLifecycleAction(automatic, "resume");
  await core.query("UPDATE services SET status = 'active', version = version + 1 WHERE id = $1", [
    automatic.serviceId,
  ]);
  const lifecycle = await core.query<{
    desired_state: string;
    observed_state: string;
    service_status: string;
  }>(
    `SELECT service.status AS service_status, desired.state AS desired_state,
            observed.state AS observed_state
       FROM services service
       JOIN LATERAL (
         SELECT state FROM service_resource_desired_state_facts
         WHERE service_id = service.id ORDER BY desired_revision DESC LIMIT 1
       ) desired ON true
       JOIN LATERAL (
         SELECT state FROM service_resource_state_facts
         WHERE service_id = service.id ORDER BY resource_revision DESC LIMIT 1
       ) observed ON true
      WHERE service.id = $1`,
    [automatic.serviceId],
  );
  assert.deepEqual(lifecycle.rows[0], {
    desired_state: "stopped",
    observed_state: "stopped",
    service_status: "active",
  });
  const providerLifecycle = await provider.query<{
    resource_state: string;
    power_state: string;
    desired_power_state: string;
  }>(
    `SELECT resource_state, power_state, desired_power_state
       FROM mock_resource_operations WHERE service_id = $1`,
    [automatic.serviceId],
  );
  assert.deepEqual(providerLifecycle.rows[0], {
    resource_state: "active",
    power_state: "stopped",
    desired_power_state: "stopped",
  });
  for (const source of ["migration_snapshot", "commercial_lifecycle"] as const) {
    await expectTransactionFailure(`${source} observed state cannot be forged by runtime DML`, async (client) => {
      await client.query(
        `INSERT INTO service_resource_state_facts(
           service_id, resource_revision, state, source, cause, observed_at
         ) SELECT $1, COALESCE(max(resource_revision), 0) + 1, 'stopped', $2,
                  CASE WHEN $2 = 'commercial_lifecycle' THEN 'commercial.active'
                       ELSE 'schema.023.forged' END,
                  (SELECT updated_at FROM services WHERE id = $1)
             FROM service_resource_state_facts WHERE service_id = $1`,
        [automatic.serviceId, source],
      );
    });
    await expectTransactionFailure(`${source} desired state cannot be forged by runtime DML`, async (client) => {
      await client.query(
        `INSERT INTO service_resource_desired_state_facts(
           service_id, desired_revision, state, source, recorded_at
         ) SELECT $1, COALESCE(max(desired_revision), 0) + 1, 'running', $2,
                  (SELECT updated_at FROM services WHERE id = $1)
             FROM service_resource_desired_state_facts WHERE service_id = $1`,
        [automatic.serviceId, source],
      );
    });
  }

  const afterLifecycle = await list(account.technical, automatic.serviceId);
  const start = await requestCustomerOperation(
    account.technical,
    automatic.serviceId,
    afterLifecycle.service,
    "start",
  );
  const running = await waitForResult(
    account.technical,
    automatic.serviceId,
    start.requestId,
    ["succeeded"],
  );
  assert.equal(running.service.resourceState, "running");
  const reboot = await requestCustomerOperation(
    account.technical,
    automatic.serviceId,
    running.service,
    "reboot",
  );
  const rebooted = await waitForResult(
    account.technical,
    automatic.serviceId,
    reboot.requestId,
    ["succeeded"],
  );
  assert.equal(rebooted.service.resourceState, "running");

  for (const forbidden of [account.billing, account.viewer]) {
    await requestCustomerOperation(
      forbidden,
      permissionTarget.serviceId,
      (await list(forbidden, permissionTarget.serviceId)).service,
      "stop",
      `forbidden-${randomUUID()}`,
      403,
    );
  }
  await api(other.owner, `/api/v1/services/${automatic.serviceId}/operations`, {}, 404);

  const staffStop = await api<CreatedOperation>(
    staff,
    `/api/v1/admin/client-accounts/${account.owner.accountId}/services/${automatic.serviceId}/operations`,
    {
      method: "POST",
      body: JSON.stringify({
        action: "stop",
        expectedServiceVersion: rebooted.service.version,
        expectedResourceRevision: rebooted.service.resourceRevision,
        idempotencyKey: `staff-stop-${randomUUID()}`,
        reason: "Synthetic Staff automatic daily stop verification",
      }),
    },
    201,
  );
  assert.equal(staffStop.executionMode, "automatic");
  await waitForResult(account.owner, automatic.serviceId, staffStop.requestId, ["succeeded"]);

  const manualInitial = await list(account.owner, manual.serviceId);
  const manualRequest = await requestCustomerOperation(
    account.owner,
    manual.serviceId,
    manualInitial.service,
    "stop",
  );
  assert.equal(manualRequest.executionMode, "manual");
  await waitForResult(account.owner, manual.serviceId, manualRequest.requestId, ["manual"]);
  await expectTransactionFailure("an isolated manual attempt cannot poison the Staff queue", async (client) => {
    await client.query(
      `INSERT INTO service_resource_operation_attempt_facts(
         request_id, attempt_number, attempt_kind, actor_id, started_at
       ) VALUES ($1, 1, 'manual', $2, pg_catalog.clock_timestamp())`,
      [manualRequest.requestId, staff.userId],
    );
  });
  await expectTransactionFailure("a manual request cannot be raw-terminated as failed", async (client) => {
    await client.query(
      `INSERT INTO service_resource_operation_result_facts(
         request_id, revision, status, detail, error_code, evidence
       ) VALUES ($1, 2, 'failed', 'forged manual queue termination',
                 'forged_manual_failure', '{"providerCalled":false}'::jsonb)`,
      [manualRequest.requestId],
    );
  });
  await expectTransactionFailure("a manual request cannot forge success without Staff completion", async (client) => {
    await client.query(
      `INSERT INTO service_resource_desired_state_facts(
         service_id, operation_request_id, desired_revision, state, source, recorded_at
       ) SELECT $1, $2, COALESCE(max(desired_revision), 0) + 1,
                'stopped', 'daily_operation', pg_catalog.clock_timestamp()
           FROM service_resource_desired_state_facts WHERE service_id = $1`,
      [manual.serviceId, manualRequest.requestId],
    );
    await client.query(
      `INSERT INTO service_resource_state_facts(
         service_id, operation_request_id, resource_revision, state,
         source, cause, observed_at
       ) SELECT $1, $2, COALESCE(max(resource_revision), 0) + 1,
                'stopped', 'daily_operation', 'resource.stop', pg_catalog.clock_timestamp()
           FROM service_resource_state_facts WHERE service_id = $1`,
      [manual.serviceId, manualRequest.requestId],
    );
    await client.query(
      `INSERT INTO service_resource_operation_result_facts(
         request_id, revision, status, resource_state, provider_occurred_at, evidence
       ) VALUES ($1, 2, 'succeeded', 'stopped', pg_catalog.clock_timestamp(),
                 '{"providerCalled":true}'::jsonb)`,
      [manualRequest.requestId],
    );
  });

  const completionId = randomUUID();
  const completionReason = "Synthetic completion-only marker must fail its deferred atomic pair";
  await expectTransactionFailure("completion marker without its exact facts must be rejected", async (client) => {
    const fingerprint = await client.query<{ value: string }>(
      `SELECT opensales_service_operation_request_fingerprint(
         'admin.services.complete-manual-operation:v1',
         jsonb_build_object(
           'requestId', $1::text,
           'expectedServiceVersion', $2::integer,
           'expectedResourceRevision', $3::integer,
           'reason', $4::text
         )
       ) AS value`,
      [manualRequest.requestId, manualInitial.service.version, manualInitial.service.resourceRevision, completionReason],
    );
    const completedAt = new Date();
    await client.query(
      `INSERT INTO service_resource_operation_manual_completions(
         id, request_id, service_id, client_account_id, staff_user_id,
         staff_session_id, expected_service_version, expected_resource_revision,
         expected_desired_revision, reason, idempotency_key,
         request_fingerprint, result, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11, $12, $13)`,
      [
        completionId,
        manualRequest.requestId,
        manual.serviceId,
        account.owner.accountId,
        staff.userId,
        staff.sessionId,
        manualInitial.service.version,
        manualInitial.service.resourceRevision,
        completionReason,
        `completion-only-${completionId}`,
        fingerprint.rows[0]!.value,
        {
          actionId: completionId,
          requestId: manualRequest.requestId,
          serviceId: manual.serviceId,
          action: "stop",
          status: "succeeded",
          resourceState: "stopped",
          resourceRevision: manualInitial.service.resourceRevision + 1,
          completedAt: completedAt.toISOString(),
          providerCalled: false,
        },
        completedAt,
      ],
    );
  });

  const completed = await api<{ requestId: string; status: string; replayed: boolean }>(
    staff,
    `/api/v1/admin/service-operations/${manualRequest.requestId}/complete-manual`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedServiceVersion: manualInitial.service.version,
        expectedResourceRevision: manualInitial.service.resourceRevision,
        reason: "Synthetic Staff confirms the manual daily stop was completed",
        idempotencyKey: `manual-complete-${randomUUID()}`,
      }),
    },
    201,
  );
  assert.equal(completed.status, "succeeded");
  const manualTerminal = await list(account.owner, manual.serviceId);
  assert.equal(manualTerminal.service.resourceState, "stopped");
  assertCustomerFactProjection(manualTerminal, manualRequest.requestId, null);
  const staffTimeline = await api<{
    items: Array<Record<string, unknown>>;
  }>(
    staff,
    `/api/v1/admin/client-accounts/${account.owner.accountId}/services/${manual.serviceId}/operations`,
  );
  const staffManualFact = staffTimeline.items.find(
    (item) => item.requestId === manualRequest.requestId,
  );
  assert.ok(staffManualFact);
  assert.ok("detail" in staffManualFact);
  assert.ok("providerOperation" in staffManualFact);
  const manualProjection = await core.query<{
    attempts: number;
    provider_attempts: number;
    completions: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM service_resource_operation_attempt_facts
         WHERE request_id = $1 AND attempt_kind = 'manual') AS attempts,
       (SELECT count(*)::integer FROM service_resource_operation_attempt_facts
         WHERE request_id = $1 AND provider_operation_id IS NOT NULL) AS provider_attempts,
       (SELECT count(*)::integer FROM service_resource_operation_manual_completions
         WHERE request_id = $1) AS completions`,
    [manualRequest.requestId],
  );
  assert.deepEqual(manualProjection.rows[0], {
    attempts: 1,
    provider_attempts: 0,
    completions: 1,
  });

  await core.query(
    "UPDATE reauth_grants SET invalidated_at = now() WHERE user_id = $1 AND session_id = $2",
    [staff.userId, staff.sessionId],
  );
  const permissionState = await list(account.owner, permissionTarget.serviceId);
  await api(
    staff,
    `/api/v1/admin/client-accounts/${account.owner.accountId}/services/${permissionTarget.serviceId}/operations`,
    {
      method: "POST",
      body: JSON.stringify({
        action: "stop",
        expectedServiceVersion: permissionState.service.version,
        expectedResourceRevision: permissionState.service.resourceRevision,
        idempotencyKey: `staff-revoked-${randomUUID()}`,
        reason: "Synthetic revoked Staff reauthentication must be rejected",
      }),
    },
    403,
  );

  const startJob = await core.query<{ id: string }>(
    `SELECT id FROM durable_jobs
      WHERE job_type = 'service.operation.start'
        AND payload->>'requestId' = $1`,
    [stop.requestId],
  );
  assert.equal(startJob.rowCount, 1);
  await expectTransactionFailure("terminal service operation job cannot be revived", async (client) => {
    await client.query(
      `UPDATE durable_jobs
          SET status = 'running', attempts = attempts + 1,
              locked_at = now(), locked_by = 'synthetic-revival'
        WHERE id = $1`,
      [startJob.rows[0]!.id],
    );
  });

  await expectTransactionFailure("raw request fingerprint cannot pre-occupy an idempotency key", async (client) => {
    await client.query(
      `INSERT INTO service_resource_operation_requests(
         service_id, client_account_id, actor_type, actor_user_id,
         actor_session_id, action, expected_service_version,
         expected_resource_revision, execution_mode, provider_installation_id,
         provider_capability_snapshot, idempotency_key, request_fingerprint
       ) VALUES ($1, $2, 'user', $3, $4, 'stop', $5, $6,
                 'manual', NULL, '{}'::jsonb, $7, $8)`,
      [
        permissionTarget.serviceId,
        account.owner.accountId,
        account.owner.userId,
        account.owner.sessionId,
        permissionState.service.version,
        permissionState.service.resourceRevision,
        `raw-invalid-${randomUUID()}`,
        "0".repeat(64),
      ],
    );
  });

  const providerCalls = await provider.query<{ create_calls: number }>(
    "SELECT create_calls FROM mock_contract_operations WHERE operation_id = $1",
    [await coreProviderOperationId(stop.requestId)],
  );
  assert.equal(providerCalls.rows[0]?.create_calls, 1);
}

async function runSchemaGate(): Promise<void> {
  const reviewedInput = await schema023CatalogFingerprintInput(core);
  const reviewedDigest = schema023CatalogDigest(reviewedInput);
  assert.equal(reviewedDigest, SCHEMA_023_CATALOG_DIGEST);
  assert.doesNotThrow(() => assertSchema023CatalogDigest(reviewedDigest));
  const history = await core.query<{ version: string }>(
    `SELECT version
       FROM schema_migrations
      ORDER BY version COLLATE "C"`,
  );
  assert.deepEqual(
    history.rows.map((row) => row.version),
    [...EXPECTED_SCHEMA_028_HISTORY],
  );
  assert.equal(history.rows.at(-1)?.version, SCHEMA_028);
}

async function runTimeout(): Promise<void> {
  await ensureCatalog();
  const account = await createAccountFixture(`timeout-${randomUUID()}`);
  const fixture = await createService(account.owner, true, "timeout");
  const initial = await list(account.owner, fixture.serviceId);
  const created = await requestCustomerOperation(account.owner, fixture.serviceId, initial.service, "stop");
  const pendingJob = await core.query<{ id: string }>(
    `SELECT id FROM durable_jobs
      WHERE job_type = 'service.operation.start'
        AND payload->>'requestId' = $1`,
    [created.requestId],
  );
  assert.equal(pendingJob.rowCount, 1);
  await expectTransactionFailure("pending service job cannot skip directly to completed", async (client) => {
    await client.query(
      "UPDATE durable_jobs SET status = 'completed' WHERE id = $1",
      [pendingJob.rows[0]!.id],
    );
  });
  await expectTransactionFailure("pending service job cannot skip directly to manual", async (client) => {
    await client.query(
      "UPDATE durable_jobs SET status = 'manual', last_error = 'synthetic bypass' WHERE id = $1",
      [pendingJob.rows[0]!.id],
    );
  });
  const providerOperationId = await coreProviderOperationId(created.requestId);
  const startJob = await core.query<{ id: string }>(
    `SELECT id FROM durable_jobs
      WHERE job_type = 'service.operation.start'
        AND payload->>'requestId' = $1`,
    [created.requestId],
  );
  assert.equal(startJob.rowCount, 1);
  await expectTransactionFailure("queued service operation job payload cannot drift", async (client) => {
    await client.query(
      `UPDATE durable_jobs
          SET payload = jsonb_set(payload, '{serviceId}', to_jsonb($2::text))
        WHERE id = $1`,
      [startJob.rows[0]!.id, randomUUID()],
    );
  });
  await expectTransactionFailure("queued service operation job cannot be deleted", async (client) => {
    await client.query("DELETE FROM durable_jobs WHERE id = $1", [startJob.rows[0]!.id]);
  });
  await expectTransactionFailure("queued service Provider projection cannot be deleted", async (client) => {
    await client.query("DELETE FROM provider_operations WHERE id = $1", [providerOperationId]);
  });
  await expectTransactionFailure("wrong reconcile job cannot bind another Service", async (client) => {
    await client.query(
      `INSERT INTO durable_jobs(job_type, unique_key, payload)
       VALUES ('service.operation.reconcile', $1, $2)`,
      [
        `service-operation:${created.requestId}:reconcile`,
        {
          requestId: created.requestId,
          serviceId: randomUUID(),
          providerOperationId,
        },
      ],
    );
  });
  const terminal = await waitForResult(account.owner, fixture.serviceId, created.requestId, ["succeeded"]);
  assert.equal(terminal.service.resourceState, "stopped");
  const projection = await core.query<{
    mutation_count: number;
    reconcile_count: number;
    provider_status: string;
  }>(
    `SELECT
       count(*) FILTER (WHERE attempt.attempt_kind = 'mutation')::integer AS mutation_count,
       count(*) FILTER (WHERE attempt.attempt_kind = 'reconcile_query')::integer AS reconcile_count,
       operation.status AS provider_status
       FROM provider_operations operation
       LEFT JOIN service_resource_operation_attempt_facts attempt
         ON attempt.request_id = operation.subject_id
      WHERE operation.subject_type = 'service_resource_operation'
        AND operation.subject_id = $1
      GROUP BY operation.status`,
    [created.requestId],
  );
  assert.deepEqual(projection.rows[0], {
    mutation_count: 1,
    reconcile_count: 1,
    provider_status: "succeeded",
  });
  const calls = await provider.query<{ create_calls: number; reconcile_calls: number }>(
    "SELECT create_calls, reconcile_calls FROM mock_contract_operations WHERE operation_id = $1",
    [await coreProviderOperationId(created.requestId)],
  );
  assert.equal(calls.rows[0]?.create_calls, 1);
  assert.ok((calls.rows[0]?.reconcile_calls ?? 0) >= 1);
}

async function runProviderFailure(): Promise<void> {
  await ensureCatalog();
  const account = await createAccountFixture(`failure-${randomUUID()}`);
  const fixture = await createService(account.owner, true, "failure");
  const initial = await list(account.owner, fixture.serviceId);
  const created = await requestCustomerOperation(
    account.owner,
    fixture.serviceId,
    initial.service,
    "stop",
  );
  const terminal = await waitForResult(
    account.owner,
    fixture.serviceId,
    created.requestId,
    ["failed"],
  );
  assert.equal(terminal.service.resourceState, "running");
  assertCustomerFactProjection(terminal, created.requestId, "provider_operation_failed");
  const facts = await core.query<{ desired: number; observed: number; mutations: number }>(
    `SELECT
       (SELECT count(*)::integer FROM service_resource_desired_state_facts
         WHERE operation_request_id = $1) AS desired,
       (SELECT count(*)::integer FROM service_resource_state_facts
         WHERE operation_request_id = $1) AS observed,
       (SELECT count(*)::integer FROM service_resource_operation_attempt_facts
         WHERE request_id = $1 AND attempt_kind = 'mutation') AS mutations`,
    [created.requestId],
  );
  assert.deepEqual(facts.rows[0], { desired: 0, observed: 0, mutations: 1 });
  const calls = await provider.query<{ create_calls: number; reconcile_calls: number }>(
    "SELECT create_calls, reconcile_calls FROM mock_contract_operations WHERE operation_id = $1",
    [await coreProviderOperationId(created.requestId)],
  );
  assert.deepEqual(calls.rows[0], { create_calls: 1, reconcile_calls: 0 });
}

async function assertConcurrentOpenRequestSerialization(account: Actor): Promise<void> {
  assert.ok(account.accountId);
  const fixture = await createService(account, true, "concurrent-open-request");
  const initial = await list(account, fixture.serviceId);
  const immutable = await core.query<{ fingerprint: string; snapshot: unknown }>(
    `SELECT opensales_service_operation_request_fingerprint(
              'services.daily-operation:v1',
              jsonb_build_object(
                'serviceId', $1::uuid::text,
                'action', 'stop',
                'expectedServiceVersion', $2::integer,
                'expectedResourceRevision', $3::integer
              )
            ) AS fingerprint,
            jsonb_build_object(
              'atBinding', binding.capability_snapshot,
              'current', provider.capabilities,
              'currentVersion', provider.version
            ) AS snapshot
       FROM service_provider_bindings binding
       JOIN provider_installation_capabilities provider
         ON provider.provider_installation_id = binding.provider_installation_id
      WHERE binding.service_id = $1::uuid`,
    [fixture.serviceId, initial.service.version, initial.service.resourceRevision],
  );
  assert.equal(immutable.rowCount, 1);
  const firstRequestId = randomUUID();
  const firstOperationId = randomUUID();
  const secondRequestId = randomUUID();
  const first = await core.connect();
  const second = await core.connect();
  let firstOpen = false;
  let secondOpen = false;
  try {
    await first.query("BEGIN");
    firstOpen = true;
    await second.query("BEGIN");
    secondOpen = true;
    const insertRequest = (
      client: pg.PoolClient,
      requestId: string,
      idempotencyKey: string,
    ) => client.query(
      `INSERT INTO service_resource_operation_requests(
         id, service_id, client_account_id, actor_type, actor_user_id,
         actor_session_id, action, expected_service_version,
         expected_resource_revision, execution_mode, provider_installation_id,
         provider_capability_snapshot, idempotency_key, request_fingerprint
       ) VALUES ($1, $2, $3, 'user', $4, $5, 'stop', $6, $7,
                 'automatic', 'mock-provisioning-v1', $8, $9, $10)`,
      [
        requestId,
        fixture.serviceId,
        account.accountId,
        account.userId,
        account.sessionId,
        initial.service.version,
        initial.service.resourceRevision,
        immutable.rows[0]!.snapshot,
        idempotencyKey,
        immutable.rows[0]!.fingerprint,
      ],
    );
    await insertRequest(first, firstRequestId, `concurrent-first-${firstRequestId}`);
    await first.query(
      `INSERT INTO provider_operations(
         id, provider_installation_id, kind, subject_type, subject_id,
         stable_key, status
       ) VALUES ($1, 'mock-provisioning-v1', 'resource.stop',
                 'service_resource_operation', $2, $3, 'queued')`,
      [
        firstOperationId,
        firstRequestId,
        `service-operation:${firstRequestId}:stop`,
      ],
    );
    await first.query(
      `INSERT INTO durable_jobs(job_type, unique_key, payload)
       VALUES ('service.operation.start', $1, $2)`,
      [
        `service-operation:${firstRequestId}:start`,
        {
          requestId: firstRequestId,
          serviceId: fixture.serviceId,
          providerOperationId: firstOperationId,
        },
      ],
    );

    const secondPid = await second.query<{ pid: number }>(
      "SELECT pg_catalog.pg_backend_pid() AS pid",
    );
    const secondOutcome = insertRequest(
      second,
      secondRequestId,
      `concurrent-second-${secondRequestId}`,
    ).then(
      () => ({ ok: true as const, error: null }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await waitFor(
      "the second raw request statement to block behind canonical locks",
      () => core.query<{ waiting: boolean }>(
        `SELECT wait_event_type = 'Lock' AS waiting
           FROM pg_catalog.pg_stat_activity
          WHERE pid = $1`,
        [secondPid.rows[0]!.pid],
      ),
      (result) => result.rows[0]?.waiting === true,
      5_000,
    );
    await first.query("COMMIT");
    firstOpen = false;
    const outcome = await secondOutcome;
    assert.equal(outcome.ok, false, "the stale second statement must not create another open request");
    assert.ok(outcome.error instanceof Error);
    assert.match(outcome.error.message, /service already has an unresolved daily operation/);
    await second.query("ROLLBACK");
    secondOpen = false;
  } finally {
    if (firstOpen) await first.query("ROLLBACK").catch(() => undefined);
    if (secondOpen) await second.query("ROLLBACK").catch(() => undefined);
    first.release();
    second.release();
  }
  const projection = await core.query<{ requests: number; unresolved: number }>(
    `SELECT count(*)::integer AS requests,
            count(*) FILTER (WHERE COALESCE(latest.status, 'queued')
                                    NOT IN ('succeeded', 'failed'))::integer AS unresolved
       FROM service_resource_operation_requests request
       LEFT JOIN LATERAL (
         SELECT result.status
           FROM service_resource_operation_result_facts result
          WHERE result.request_id = request.id
          ORDER BY result.revision DESC LIMIT 1
       ) latest ON true
      WHERE request.service_id = $1`,
    [fixture.serviceId],
  );
  assert.deepEqual(projection.rows[0], { requests: 1, unresolved: 1 });
}

async function assertManualCompletionAuthorizationExpiry(account: Actor): Promise<void> {
  assert.ok(account.accountId);
  const fixture = await createService(account, false, "completion-expiry");
  const initial = await list(account, fixture.serviceId);
  const request = await requestCustomerOperation(account, fixture.serviceId, initial.service, "stop");
  assert.equal(request.executionMode, "manual");

  const projection = () => core.query<{
    completions: number;
    attempts: number;
    desired: number;
    observed: number;
    results: number;
  }>(
    `SELECT
       (SELECT count(*)::integer
          FROM service_resource_operation_manual_completions
         WHERE request_id = $1) AS completions,
       (SELECT count(*)::integer
          FROM service_resource_operation_attempt_facts
         WHERE request_id = $1) AS attempts,
       (SELECT count(*)::integer
          FROM service_resource_desired_state_facts
         WHERE operation_request_id = $1) AS desired,
       (SELECT count(*)::integer
          FROM service_resource_state_facts
         WHERE operation_request_id = $1) AS observed,
       (SELECT count(*)::integer
          FROM service_resource_operation_result_facts
         WHERE request_id = $1) AS results`,
    [request.requestId],
  );
  const initialProjection = (await projection()).rows[0]!;
  assert.deepEqual(initialProjection, {
    completions: 0,
    attempts: 0,
    desired: 0,
    observed: 0,
    results: 1,
  });

  // The API performs its first Staff/reauth check before taking business locks.
  // Hold the Service row until reauth expires and prove the post-lock DB-clock
  // check rejects the completion without authoring any of its five-way facts.
  const apiStaffIdentity = await createStaff(`completion-api-expiry-${randomUUID()}`);
  const apiStaff = await createExpiringActorSession(apiStaffIdentity, 60, 5);
  const apiExpiry = await core.query<{ expires_at: Date }>(
    `SELECT expires_at
       FROM reauth_grants
      WHERE user_id = $1 AND session_id = $2 AND invalidated_at IS NULL`,
    [apiStaff.userId, apiStaff.sessionId],
  );
  const blocker = await core.connect();
  let blockerOpen = false;
  let apiOutcome: Promise<{ ok: boolean; error: unknown }> | null = null;
  try {
    await blocker.query("BEGIN");
    blockerOpen = true;
    await blocker.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [fixture.serviceId]);
    apiOutcome = api(
      apiStaff,
      `/api/v1/admin/service-operations/${request.requestId}/complete-manual`,
      {
        method: "POST",
        body: JSON.stringify({
          expectedServiceVersion: initial.service.version,
          expectedResourceRevision: initial.service.resourceRevision,
          reason: "Synthetic Staff reauthentication expires behind the Service lock",
          idempotencyKey: `manual-api-expiry-${randomUUID()}`,
        }),
      },
      403,
    ).then(
      () => ({ ok: true, error: null }),
      (error: unknown) => ({ ok: false, error }),
    );
    await waitFor(
      "the API manual completion to wait behind the Service lock",
      () => core.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM pg_catalog.pg_stat_activity
            WHERE wait_event_type = 'Lock'
              AND query = 'SELECT id FROM services WHERE id = $1 FOR UPDATE'
         ) AS waiting`,
      ),
      (result) => result.rows[0]?.waiting === true,
      5_000,
    );
    await waitPastDatabaseTimestamp(apiExpiry.rows[0]!.expires_at);
    await blocker.query("COMMIT");
    blockerOpen = false;
    const outcome = await apiOutcome;
    assert.equal(outcome.ok, true, outcome.error instanceof Error ? outcome.error.message : undefined);
  } finally {
    if (blockerOpen) await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    if (apiOutcome) await apiOutcome.catch(() => undefined);
  }
  assert.deepEqual((await projection()).rows[0], initialProjection);

  // The native trigger independently enforces the same linearization point.
  // A raw insert begins while reauth is valid, blocks on the Service row, then
  // must fail after the exact grant expires.
  const rawStaffIdentity = await createStaff(`completion-native-expiry-${randomUUID()}`);
  const rawStaff = await createExpiringActorSession(rawStaffIdentity, 60, 5);
  const rawReason = "Synthetic raw completion waits until Staff reauthentication expires";
  const immutable = await core.query<{
    desired_revision: number;
    completed_at: Date;
    fingerprint: string;
    expires_at: Date;
  }>(
    `SELECT COALESCE((
              SELECT max(fact.desired_revision)
                FROM service_resource_desired_state_facts fact
               WHERE fact.service_id = $1
            ), 0)::integer AS desired_revision,
            pg_catalog.clock_timestamp() AS completed_at,
            opensales_service_operation_request_fingerprint(
              'admin.services.complete-manual-operation:v1',
              jsonb_build_object(
                'requestId', $2::uuid::text,
                'expectedServiceVersion', $3::integer,
                'expectedResourceRevision', $4::integer,
                'reason', $5::text
              )
            ) AS fingerprint,
            (SELECT expires_at
               FROM reauth_grants
              WHERE user_id = $6 AND session_id = $7 AND invalidated_at IS NULL)
              AS expires_at`,
    [
      fixture.serviceId,
      request.requestId,
      initial.service.version,
      initial.service.resourceRevision,
      rawReason,
      rawStaff.userId,
      rawStaff.sessionId,
    ],
  );
  const row = immutable.rows[0]!;
  const rawBlocker = await core.connect();
  const rawWriter = await core.connect();
  let rawBlockerOpen = false;
  let rawWriterOpen = false;
  let rawOutcome: Promise<{ ok: boolean; error: unknown }> | null = null;
  try {
    await rawBlocker.query("BEGIN");
    rawBlockerOpen = true;
    await rawBlocker.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [fixture.serviceId]);
    await rawWriter.query("BEGIN");
    rawWriterOpen = true;
    const writerPid = await rawWriter.query<{ pid: number }>(
      "SELECT pg_catalog.pg_backend_pid() AS pid",
    );
    const completionId = randomUUID();
    rawOutcome = rawWriter.query(
      `INSERT INTO service_resource_operation_manual_completions(
         id, request_id, service_id, client_account_id, staff_user_id,
         staff_session_id, expected_service_version, expected_resource_revision,
         expected_desired_revision, reason, idempotency_key,
         request_fingerprint, result, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        completionId,
        request.requestId,
        fixture.serviceId,
        account.accountId,
        rawStaff.userId,
        rawStaff.sessionId,
        initial.service.version,
        initial.service.resourceRevision,
        row.desired_revision,
        rawReason,
        `manual-native-expiry-${completionId}`,
        row.fingerprint,
        {
          actionId: completionId,
          requestId: request.requestId,
          serviceId: fixture.serviceId,
          action: "stop",
          status: "succeeded",
          resourceState: "stopped",
          resourceRevision: initial.service.resourceRevision + 1,
          completedAt: row.completed_at.toISOString(),
          providerCalled: false,
        },
        row.completed_at,
      ],
    ).then(
      () => ({ ok: true, error: null }),
      (error: unknown) => ({ ok: false, error }),
    );
    await waitFor(
      "the native manual completion to wait behind the Service lock",
      () => core.query<{ waiting: boolean }>(
        `SELECT wait_event_type = 'Lock' AS waiting
           FROM pg_catalog.pg_stat_activity
          WHERE pid = $1`,
        [writerPid.rows[0]!.pid],
      ),
      (result) => result.rows[0]?.waiting === true,
      5_000,
    );
    await waitPastDatabaseTimestamp(row.expires_at);
    await rawBlocker.query("COMMIT");
    rawBlockerOpen = false;
    const outcome = await rawOutcome;
    assert.equal(outcome.ok, false, "native completion must not survive reauth expiry");
    assert.ok(outcome.error instanceof Error);
    assert.match(
      outcome.error.message,
      /manual service operation completion authorization expired while acquiring business locks/,
    );
    await rawWriter.query("ROLLBACK");
    rawWriterOpen = false;
  } finally {
    if (rawBlockerOpen) await rawBlocker.query("ROLLBACK").catch(() => undefined);
    if (rawWriterOpen) await rawWriter.query("ROLLBACK").catch(() => undefined);
    rawBlocker.release();
    rawWriter.release();
  }
  assert.deepEqual((await projection()).rows[0], initialProjection);
}

async function runCancellationIndependence(): Promise<void> {
  await ensureCatalog();
  const worker = await loadServiceWorker();
  const runtime: ServiceOperationRuntime = {
    workerId: `service-operations-cancellation-${process.pid}`,
    providerUrl,
    providerToken: process.env.MOCK_PROVIDER_PLATFORM_TOKEN ?? providerToken!,
    providerTimeoutMs: 2_000,
    scenario: "normal",
    reconcileBaseDelaySeconds: 0,
    reconcileMaxAttempts: 3,
    staleLockSeconds: 2,
  };
  const account = await createAccountFixture(`cancellation-${randomUUID()}`);
  const staff = await createStaff(`cancellation-${randomUUID()}`);
  await assertConcurrentOpenRequestSerialization(account.owner);
  await assertManualCompletionAuthorizationExpiry(account.owner);

  // A period-end cancellation scheduled before the daily intent is independent
  // while its paid-through timestamp remains in the future.
  const scheduledFirst = await createService(account.owner, true, "scheduled-first");
  const scheduledInitial = await list(account.owner, scheduledFirst.serviceId);
  const schedule = await scheduleCancellation(
    account.owner,
    scheduledFirst.serviceId,
    scheduledInitial.service.version,
  );
  const scheduledState = await list(account.owner, scheduledFirst.serviceId);
  assert.equal(scheduledState.service.version, schedule.serviceVersion);
  const scheduledStop = await requestCustomerOperation(
    account.owner,
    scheduledFirst.serviceId,
    scheduledState.service,
    "stop",
  );
  const scheduledJob = await claimServiceOperationJobForRequest(
    runtime.workerId,
    scheduledStop.requestId,
    "service.operation.start",
  );
  await worker.processServiceOperationStart(workerCore, scheduledJob, runtime);
  assert.equal(
    (await list(account.owner, scheduledFirst.serviceId)).items.find(
      (item) => item.requestId === scheduledStop.requestId,
    )?.status,
    "succeeded",
  );

  // A request committed before scheduling still passes the Worker's fresh
  // preflight when the schedule is the exact and only +1 Service version drift.
  const queuedThenScheduled = await createService(account.owner, true, "queued-then-scheduled");
  const queuedInitial = await list(account.owner, queuedThenScheduled.serviceId);
  const queuedStop = await requestCustomerOperation(
    account.owner,
    queuedThenScheduled.serviceId,
    queuedInitial.service,
    "stop",
  );
  await scheduleCancellation(
    account.owner,
    queuedThenScheduled.serviceId,
    queuedInitial.service.version,
  );
  const queuedJob = await claimServiceOperationJobForRequest(
    runtime.workerId,
    queuedStop.requestId,
    "service.operation.start",
  );
  await worker.processServiceOperationStart(workerCore, queuedJob, runtime);
  assert.equal(
    (await list(account.owner, queuedThenScheduled.serviceId)).items.find(
      (item) => item.requestId === queuedStop.requestId,
    )?.status,
    "succeeded",
  );
  const queuedCalls = await provider.query<{ create_calls: number }>(
    "SELECT create_calls FROM mock_contract_operations WHERE operation_id = $1",
    [await coreProviderOperationId(queuedStop.requestId)],
  );
  assert.equal(queuedCalls.rows[0]?.create_calls, 1);

  // Scheduling between an authorized POST and its Core commit is the one
  // permitted version drift. The actual Provider result still lands.
  const inFlight = await createService(account.owner, true, "in-flight-schedule");
  const inFlightInitial = await list(account.owner, inFlight.serviceId);
  const inFlightStop = await requestCustomerOperation(
    account.owner,
    inFlight.serviceId,
    inFlightInitial.service,
    "stop",
  );
  const inFlightJob = await claimServiceOperationJobForRequest(
    runtime.workerId,
    inFlightStop.requestId,
    "service.operation.start",
  );
  await worker.processServiceOperationStart(workerCore, inFlightJob, runtime, {
    afterProviderMutation: async () => {
      await scheduleCancellation(
        account.owner,
        inFlight.serviceId,
        inFlightInitial.service.version,
      );
    },
  });
  const inFlightTerminal = await list(account.owner, inFlight.serviceId);
  assert.equal(
    inFlightTerminal.items.find((item) => item.requestId === inFlightStop.requestId)?.status,
    "succeeded",
  );
  assert.equal(inFlightTerminal.service.resourceState, "stopped");

  // Identity locks prevent concurrent revocation but do not stop wall-clock
  // expiry. Both Customer and Staff dispatch therefore re-check their exact
  // session/reauth authority after every job/business/Provider lock is held.
  const expiringCustomer = await createAccountFixture(`dispatch-expiry-${randomUUID()}`);
  const expiringCustomerService = await createService(
    expiringCustomer.owner,
    true,
    "dispatch-expiring-customer",
  );
  const expiringCustomerInitial = await list(
    expiringCustomer.owner,
    expiringCustomerService.serviceId,
  );
  const expiringCustomerActor = await createExpiringActorSession(expiringCustomer.owner, 5);
  const expiringCustomerRequest = await requestCustomerOperation(
    expiringCustomerActor,
    expiringCustomerService.serviceId,
    expiringCustomerInitial.service,
    "stop",
  );
  const expiringCustomerJob = await claimServiceOperationJobForRequest(
    runtime.workerId,
    expiringCustomerRequest.requestId,
    "service.operation.start",
  );
  const customerExpiry = await core.query<{ expires_at: Date }>(
    "SELECT expires_at FROM sessions WHERE id = $1",
    [expiringCustomerActor.sessionId],
  );
  await worker.processServiceOperationStart(workerCore, expiringCustomerJob, runtime, {
    beforeDispatchAuthorizationRecheck: () =>
      waitPastDatabaseTimestamp(customerExpiry.rows[0]!.expires_at),
  });
  const expiringCustomerTerminal = await list(
    expiringCustomer.technical,
    expiringCustomerService.serviceId,
  );
  assert.equal(
    expiringCustomerTerminal.items.find(
      (item) => item.requestId === expiringCustomerRequest.requestId,
    )?.reasonCode,
    "authorization_or_state_changed",
  );
  const expiringCustomerProjection = await core.query<{
    mutation_attempts: number;
    job_status: string;
    raw_error_code: string;
  }>(
    `SELECT
       (SELECT count(*)::integer
          FROM service_resource_operation_attempt_facts attempt
         WHERE attempt.request_id = $1 AND attempt.attempt_kind = 'mutation')
         AS mutation_attempts,
       job.status AS job_status,
       (SELECT result.error_code
          FROM service_resource_operation_result_facts result
         WHERE result.request_id = $1
         ORDER BY result.revision DESC LIMIT 1) AS raw_error_code
       FROM durable_jobs job
      WHERE job.id = $2`,
    [expiringCustomerRequest.requestId, expiringCustomerJob.id],
  );
  assert.deepEqual(expiringCustomerProjection.rows[0], {
    mutation_attempts: 0,
    job_status: "completed",
    raw_error_code: "dispatch_preflight_rejected",
  });
  assert.equal(
    (await provider.query(
      "SELECT 1 FROM mock_contract_operations WHERE operation_id = $1",
      [await coreProviderOperationId(expiringCustomerRequest.requestId)],
    )).rowCount,
    0,
  );

  const nativeExpiryAccount = await createAccountFixture(`native-expiry-${randomUUID()}`);
  const nativeExpiryService = await createService(
    nativeExpiryAccount.owner,
    true,
    "native-expiring-customer",
  );
  const nativeExpiryInitial = await list(nativeExpiryAccount.owner, nativeExpiryService.serviceId);
  const nativeExpiryActor = await createExpiringActorSession(nativeExpiryAccount.owner, 5);
  const nativeExpiryRequest = await requestCustomerOperation(
    nativeExpiryActor,
    nativeExpiryService.serviceId,
    nativeExpiryInitial.service,
    "stop",
  );
  const nativeExpiryJob = await claimServiceOperationJobForRequest(
    runtime.workerId,
    nativeExpiryRequest.requestId,
    "service.operation.start",
  );
  const nativeExpiryOperationId = await coreProviderOperationId(nativeExpiryRequest.requestId);
  const nativeExpiryTimestamp = await core.query<{ expires_at: Date }>(
    "SELECT expires_at FROM sessions WHERE id = $1",
    [nativeExpiryActor.sessionId],
  );
  await waitPastDatabaseTimestamp(nativeExpiryTimestamp.rows[0]!.expires_at);
  await expectTransactionFailure(
    "the native mutation-attempt guard rechecks an expired Customer session",
    async (client) => {
      await client.query(
        `INSERT INTO service_resource_operation_attempt_facts(
           request_id, provider_operation_id, durable_job_id, durable_job_attempts,
           attempt_number, attempt_kind, actor_id, started_at
         ) VALUES ($1, $2, $3, $4, 1, 'mutation', $5,
                   pg_catalog.clock_timestamp())`,
        [
          nativeExpiryRequest.requestId,
          nativeExpiryOperationId,
          nativeExpiryJob.id,
          nativeExpiryJob.attempts,
          nativeExpiryJob.locked_by,
        ],
      );
    },
    /service operation mutation customer session is not fresh/,
  );
  await worker.processServiceOperationStart(workerCore, nativeExpiryJob, runtime);
  assert.equal(
    (await provider.query(
      "SELECT 1 FROM mock_contract_operations WHERE operation_id = $1",
      [nativeExpiryOperationId],
    )).rowCount,
    0,
  );

  const expiringStaffIdentity = await createStaff(`dispatch-expiry-${randomUUID()}`);
  const expiringStaffService = await createService(account.owner, true, "dispatch-expiring-staff");
  const expiringStaffInitial = await list(account.owner, expiringStaffService.serviceId);
  const expiringStaff = await createExpiringActorSession(expiringStaffIdentity, 60, 5);
  const expiringStaffRequest = await api<CreatedOperation>(
    expiringStaff,
    `/api/v1/admin/client-accounts/${account.owner.accountId}/services/${expiringStaffService.serviceId}/operations`,
    {
      method: "POST",
      body: JSON.stringify({
        action: "stop",
        expectedServiceVersion: expiringStaffInitial.service.version,
        expectedResourceRevision: expiringStaffInitial.service.resourceRevision,
        idempotencyKey: `staff-expiry-${randomUUID()}`,
        reason: "Synthetic Staff reauthentication expires while dispatch waits",
      }),
    },
    201,
  );
  const expiringStaffJob = await claimServiceOperationJobForRequest(
    runtime.workerId,
    expiringStaffRequest.requestId,
    "service.operation.start",
  );
  const staffExpiry = await core.query<{ expires_at: Date }>(
    `SELECT expires_at
       FROM reauth_grants
      WHERE user_id = $1 AND session_id = $2 AND invalidated_at IS NULL`,
    [expiringStaff.userId, expiringStaff.sessionId],
  );
  await worker.processServiceOperationStart(workerCore, expiringStaffJob, runtime, {
    beforeDispatchAuthorizationRecheck: () =>
      waitPastDatabaseTimestamp(staffExpiry.rows[0]!.expires_at),
  });
  const expiringStaffTerminal = await list(account.owner, expiringStaffService.serviceId);
  assert.equal(
    expiringStaffTerminal.items.find(
      (item) => item.requestId === expiringStaffRequest.requestId,
    )?.reasonCode,
    "authorization_or_state_changed",
  );
  const expiringStaffProjection = await core.query<{
    mutation_attempts: number;
    raw_error_code: string;
  }>(
    `SELECT
       count(*) FILTER (WHERE attempt.attempt_kind = 'mutation')::integer AS mutation_attempts,
       (SELECT result.error_code
          FROM service_resource_operation_result_facts result
         WHERE result.request_id = $1
         ORDER BY result.revision DESC LIMIT 1) AS raw_error_code
       FROM service_resource_operation_attempt_facts attempt
      WHERE attempt.request_id = $1`,
    [expiringStaffRequest.requestId],
  );
  assert.deepEqual(expiringStaffProjection.rows[0], {
    mutation_attempts: 0,
    raw_error_code: "dispatch_preflight_rejected",
  });
  assert.equal(
    (await provider.query(
      "SELECT 1 FROM mock_contract_operations WHERE operation_id = $1",
      [await coreProviderOperationId(expiringStaffRequest.requestId)],
    )).rowCount,
    0,
  );
  await expectTransactionFailure(
    "the native mutation-attempt guard rechecks expired Staff reauthentication",
    async (client) => {
      await client.query(
        `INSERT INTO service_resource_operation_attempt_facts(
           request_id, provider_operation_id, durable_job_id, durable_job_attempts,
           attempt_number, attempt_kind, actor_id, started_at
         ) VALUES ($1, $2, $3, $4, 1, 'mutation', $5,
                   pg_catalog.clock_timestamp())`,
        [
          expiringStaffRequest.requestId,
          await coreProviderOperationId(expiringStaffRequest.requestId),
          expiringStaffJob.id,
          expiringStaffJob.attempts,
          expiringStaffJob.locked_by,
        ],
      );
    },
    /service operation mutation Staff reauthentication is not fresh/,
  );

  // Once cancellation is effective, the API rejects a new intent atomically;
  // neither a durable job nor a Provider operation is created.
  const due = await createService(account.owner, true, "effective-before-dispatch", 2);
  const dueInitial = await list(account.owner, due.serviceId);
  const dueSchedule = await scheduleCancellation(
    account.owner,
    due.serviceId,
    dueInitial.service.version,
  );

  // Manual fallback is also usable while a scheduled cancellation is still
  // in the paid-through period, but cannot author a new resource fact once
  // that exact DB timestamp is effective even if commercial termination has
  // not yet projected the Service away from active.
  const manualDue = await createService(account.owner, true, "manual-effective-completion", 2);
  const manualDueInitial = await list(account.owner, manualDue.serviceId);
  await core.query(
    `UPDATE provider_installation_capabilities
        SET enabled = false, version = version + 1, updated_at = pg_catalog.clock_timestamp()
      WHERE provider_installation_id = 'mock-provisioning-v1'`,
  );
  const manualDueSchedule = await scheduleCancellation(
    account.owner,
    manualDue.serviceId,
    manualDueInitial.service.version,
  );
  const manualDueScheduled = await list(account.owner, manualDue.serviceId);
  const manualDueRequest = await requestCustomerOperation(
    account.owner,
    manualDue.serviceId,
    manualDueScheduled.service,
    "stop",
  );
  assert.equal(manualDueRequest.executionMode, "manual");
  await waitForResult(account.owner, manualDue.serviceId, manualDueRequest.requestId, ["manual"]);

  const waitMs = Math.max(
    Date.parse(dueSchedule.cancellation.effectiveAt),
    Date.parse(manualDueSchedule.cancellation.effectiveAt),
  ) - Date.now() + 150;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const dueState = await list(account.owner, due.serviceId);
  await api(
    account.owner,
    `/api/v1/services/${due.serviceId}/operations`,
    {
      method: "POST",
      body: JSON.stringify({
        action: "stop",
        expectedServiceVersion: dueState.service.version,
        expectedResourceRevision: dueState.service.resourceRevision,
        idempotencyKey: `due-stop-${randomUUID()}`,
      }),
    },
    409,
  );
  const dueArtifacts = await core.query<{ requests: number; jobs: number; operations: number }>(
    `SELECT
       (SELECT count(*)::integer FROM service_resource_operation_requests WHERE service_id = $1)
         AS requests,
       (SELECT count(*)::integer FROM durable_jobs job
          WHERE job.job_type IN ('service.operation.start', 'service.operation.reconcile')
            AND job.payload->>'serviceId' = $1::text) AS jobs,
       (SELECT count(*)::integer FROM provider_operations operation
          WHERE operation.subject_type = 'service_resource_operation'
            AND operation.subject_id IN (
              SELECT request.id FROM service_resource_operation_requests request
               WHERE request.service_id = $1
            )) AS operations`,
    [due.serviceId],
  );
  assert.deepEqual(dueArtifacts.rows[0], { requests: 0, jobs: 0, operations: 0 });

  const manualDueEffective = await list(account.owner, manualDue.serviceId);
  assert.equal(manualDueEffective.service.status, "active");
  await api(
    staff,
    `/api/v1/admin/service-operations/${manualDueRequest.requestId}/complete-manual`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedServiceVersion: manualDueEffective.service.version,
        expectedResourceRevision: manualDueEffective.service.resourceRevision,
        reason: "Synthetic completion after paid-through timestamp must be rejected",
        idempotencyKey: `manual-effective-${randomUUID()}`,
      }),
    },
    409,
  );

  const rawCompletionId = randomUUID();
  const rawCompletionReason = "Synthetic raw completion after cancellation effective time";
  await expectTransactionFailure(
    "the native manual-completion guard rejects an active Service after cancellation is effective",
    async (client) => {
      const snapshot = await client.query<{
        desired_revision: number;
        completed_at: Date;
        fingerprint: string;
      }>(
        `SELECT COALESCE((
                  SELECT max(fact.desired_revision)
                    FROM service_resource_desired_state_facts fact
                   WHERE fact.service_id = $1
                ), 0)::integer AS desired_revision,
                pg_catalog.clock_timestamp() AS completed_at,
                opensales_service_operation_request_fingerprint(
                  'admin.services.complete-manual-operation:v1',
                  jsonb_build_object(
                    'requestId', $2::uuid::text,
                    'expectedServiceVersion', $3::integer,
                    'expectedResourceRevision', $4::integer,
                    'reason', $5::text
                  )
                ) AS fingerprint`,
        [
          manualDue.serviceId,
          manualDueRequest.requestId,
          manualDueEffective.service.version,
          manualDueEffective.service.resourceRevision,
          rawCompletionReason,
        ],
      );
      const row = snapshot.rows[0]!;
      await client.query(
        `INSERT INTO service_resource_operation_manual_completions(
           id, request_id, service_id, client_account_id, staff_user_id,
           staff_session_id, expected_service_version, expected_resource_revision,
           expected_desired_revision, reason, idempotency_key,
           request_fingerprint, result, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          rawCompletionId,
          manualDueRequest.requestId,
          manualDue.serviceId,
          account.owner.accountId,
          staff.userId,
          staff.sessionId,
          manualDueEffective.service.version,
          manualDueEffective.service.resourceRevision,
          row.desired_revision,
          rawCompletionReason,
          `manual-effective-raw-${rawCompletionId}`,
          row.fingerprint,
          {
            actionId: rawCompletionId,
            requestId: manualDueRequest.requestId,
            serviceId: manualDue.serviceId,
            action: "stop",
            status: "succeeded",
            resourceState: "stopped",
            resourceRevision: manualDueEffective.service.resourceRevision + 1,
            completedAt: row.completed_at.toISOString(),
            providerCalled: false,
          },
          row.completed_at,
        ],
      );
    },
    /manual service operation completion does not match current state/,
  );
  const manualDueArtifacts = await core.query<{
    completions: number;
    manual_attempts: number;
    latest_status: string;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM service_resource_operation_manual_completions
         WHERE request_id = $1) AS completions,
       (SELECT count(*)::integer FROM service_resource_operation_attempt_facts
         WHERE request_id = $1 AND attempt_kind = 'manual') AS manual_attempts,
       (SELECT result.status FROM service_resource_operation_result_facts result
         WHERE result.request_id = $1 ORDER BY result.revision DESC LIMIT 1) AS latest_status`,
    [manualDueRequest.requestId],
  );
  assert.deepEqual(manualDueArtifacts.rows[0], {
    completions: 0,
    manual_attempts: 0,
    latest_status: "manual",
  });
  await core.query(
    `UPDATE provider_installation_capabilities
        SET enabled = true, version = version + 1, updated_at = pg_catalog.clock_timestamp()
      WHERE provider_installation_id = 'mock-provisioning-v1'`,
  );
}

async function runPrepareRevoked(): Promise<void> {
  assert.ok(stateFile, "SERVICE_OPERATION_STATE_FILE is required");
  await ensureCatalog();
  const account = await createAccountFixture(`revoked-${randomUUID()}`);
  const fixture = await createService(account.owner, true, "revoked");
  const initial = await list(account.owner, fixture.serviceId);
  const created = await requestCustomerOperation(account.owner, fixture.serviceId, initial.service, "stop");
  const operationId = await coreProviderOperationId(created.requestId);
  await expectTransactionFailure("a pending start job cannot authorize a mutation attempt", async (client) => {
    await client.query(
      `INSERT INTO service_resource_operation_attempt_facts(
         request_id, provider_operation_id, durable_job_id, durable_job_attempts, attempt_number,
         attempt_kind, actor_id, started_at
       ) SELECT $1, $2, job.id, job.attempts, 1,
                'mutation', 'forged-worker', pg_catalog.clock_timestamp()
           FROM durable_jobs job
          WHERE job.job_type = 'service.operation.start'
            AND job.payload->>'requestId' = $1::uuid::text`,
      [created.requestId, operationId],
    );
  });
  await expectTransactionFailure("a transition fact cannot commit without its terminal job update", async (client) => {
    const claimed = await client.query<{ id: string; attempts: number; locked_by: string }>(
      `UPDATE durable_jobs
          SET status = 'running', attempts = attempts + 1,
              locked_at = pg_catalog.clock_timestamp(), locked_by = 'raw-transition-worker',
              updated_at = pg_catalog.clock_timestamp()
        WHERE job_type = 'service.operation.start'
          AND payload->>'requestId' = $1
          AND status = 'pending'
        RETURNING id, attempts, locked_by`,
      [created.requestId],
    );
    assert.equal(claimed.rowCount, 1);
    await client.query(
      `INSERT INTO service_resource_operation_result_facts(
         request_id, revision, status, detail, error_code, evidence
       ) VALUES ($1, 1, 'failed', 'synthetic preflight rejection',
                 'dispatch_preflight_rejected', '{"providerCalled":false}'::jsonb)`,
      [created.requestId],
    );
    await client.query(
      `UPDATE provider_operations
          SET status = 'failed', last_error = 'synthetic preflight rejection', updated_at = now()
        WHERE id = $1`,
      [operationId],
    );
    await client.query(
      `INSERT INTO service_operation_job_transition_facts(
         job_id, request_id, from_status, to_status, job_attempts, worker_id
       ) VALUES ($1, $2, 'running', 'completed', $3, $4)`,
      [claimed.rows[0]!.id, created.requestId, claimed.rows[0]!.attempts, claimed.rows[0]!.locked_by],
    );
  });
  await expectTransactionFailure("a succeeded Provider projection cannot claim another resource", async (client) => {
    const claimed = await client.query<{ id: string; attempts: number }>(
      `UPDATE durable_jobs
          SET status = 'running', attempts = attempts + 1,
              locked_at = pg_catalog.clock_timestamp(), locked_by = 'raw-wrong-ref-worker',
              updated_at = pg_catalog.clock_timestamp()
        WHERE job_type = 'service.operation.start'
          AND payload->>'requestId' = $1
          AND status = 'pending'
        RETURNING id, attempts`,
      [created.requestId],
    );
    assert.equal(claimed.rowCount, 1);
    await client.query(
      `INSERT INTO service_resource_operation_attempt_facts(
         request_id, provider_operation_id, durable_job_id, durable_job_attempts, attempt_number,
         attempt_kind, actor_id, started_at
       ) VALUES ($1, $2, $3, $4, 1, 'mutation',
                 'raw-wrong-ref-worker', pg_catalog.clock_timestamp())`,
      [created.requestId, operationId, claimed.rows[0]!.id, claimed.rows[0]!.attempts],
    );
    await client.query(
      `INSERT INTO service_resource_operation_result_facts(request_id, revision, status, evidence)
       VALUES ($1, 1, 'running', '{"providerCalled":false}'::jsonb)`,
      [created.requestId],
    );
    await client.query(
      `UPDATE provider_operations
          SET status = 'running', attempt_count = 1, updated_at = now()
        WHERE id = $1`,
      [operationId],
    );
    await client.query(
      `INSERT INTO service_resource_operation_result_facts(
         request_id, revision, status, resource_state, provider_occurred_at, evidence
       ) VALUES ($1, 2, 'succeeded', 'stopped', pg_catalog.clock_timestamp(),
                 '{"providerCalled":true}'::jsonb)`,
      [created.requestId],
    );
    await client.query(
      `INSERT INTO service_resource_desired_state_facts(
         service_id, operation_request_id, desired_revision, state, source, recorded_at
       ) SELECT $1, $2, COALESCE(max(desired_revision), 0) + 1,
                'stopped', 'daily_operation', pg_catalog.clock_timestamp()
           FROM service_resource_desired_state_facts WHERE service_id = $1`,
      [fixture.serviceId, created.requestId],
    );
    await client.query(
      `INSERT INTO service_resource_state_facts(
         service_id, operation_request_id, provider_operation_id,
         resource_revision, state, source, cause, observed_at
       ) SELECT $1, $2, $3, COALESCE(max(resource_revision), 0) + 1,
                'stopped', 'daily_operation', 'resource.stop', pg_catalog.clock_timestamp()
           FROM service_resource_state_facts WHERE service_id = $1`,
      [fixture.serviceId, created.requestId, operationId],
    );
    await client.query(
      `UPDATE provider_operations
          SET status = 'succeeded', external_reference = $2, updated_at = now()
        WHERE id = $1`,
      [operationId, `another-resource-${randomUUID()}`],
    );
  });
  await core.query(
    `UPDATE provider_installation_capabilities
        SET capabilities = capabilities - 'resource.stop', version = version + 1,
            updated_at = now()
      WHERE provider_installation_id = 'mock-provisioning-v1'`,
  );
  await writeFile(stateFile, JSON.stringify({ account, fixture, created }), { mode: 0o600 });
}

async function runPrepareBrowser(): Promise<void> {
  assert.ok(stateFile, "SERVICE_OPERATION_STATE_FILE is required");
  await ensureCatalog();
  const accountLabel = `browser-${randomUUID()}`;
  const account = await createAccountFixture(accountLabel);
  const staff = await createStaff(`browser-${randomUUID()}`);
  const staffPassword = `Synthetic-Service-Operations-${randomUUID()}!`;
  const staffEmailResult = await core.query<{ email: string }>(
    "SELECT email FROM users WHERE id = $1",
    [staff.userId],
  );
  const staffEmail = staffEmailResult.rows[0]?.email;
  assert.ok(staffEmail);
  await core.query(
    `UPDATE staff_members
        SET permissions = '["services.operations_manage"]'::jsonb
      WHERE user_id = $1`,
    [staff.userId],
  );
  await core.query("UPDATE users SET password_hash = $2 WHERE id = $1", [
    staff.userId,
    await passwordHash(staffPassword),
  ]);
  const fixture = await createService(account.owner, true, "browser");
  const manualFixture = await createService(account.owner, false, "browser-manual");
  const manualInitial = await list(account.owner, manualFixture.serviceId);
  const manualRequest = await requestCustomerOperation(
    account.owner,
    manualFixture.serviceId,
    manualInitial.service,
    "stop",
  );
  await writeFile(
    stateFile,
    JSON.stringify({
      account: { id: account.owner.accountId, name: `Synthetic Service Operations ${accountLabel}` },
      owner: account.owner,
      staff,
      staffEmail,
      staffPassword,
      fixture,
      manualFixture,
      manualRequest,
      productName: "Synthetic daily operations",
    }),
    { mode: 0o600 },
  );
}

async function runVerifyRevoked(): Promise<void> {
  assert.ok(stateFile, "SERVICE_OPERATION_STATE_FILE is required");
  const saved = JSON.parse(await readFile(stateFile, "utf8")) as {
    account: { owner: Actor };
    fixture: ServiceFixture;
    created: CreatedOperation;
  };
  const terminal = await waitForResult(
    saved.account.owner,
    saved.fixture.serviceId,
    saved.created.requestId,
    ["failed"],
  );
  assert.equal(terminal.service.resourceState, "running");
  const projection = await core.query<{
    attempt_count: number;
    status: string;
    error_code: string;
    job_status: string;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM service_resource_operation_attempt_facts
         WHERE request_id = request.id) AS attempt_count,
       result.status, result.error_code, job.status AS job_status
       FROM service_resource_operation_requests request
       JOIN LATERAL (
         SELECT status, error_code FROM service_resource_operation_result_facts
          WHERE request_id = request.id ORDER BY revision DESC LIMIT 1
       ) result ON true
       JOIN durable_jobs job
         ON job.job_type = 'service.operation.start'
        AND job.payload->>'requestId' = request.id::text
      WHERE request.id = $1`,
    [saved.created.requestId],
  );
  assert.deepEqual(projection.rows[0], {
    attempt_count: 0,
    status: "failed",
    error_code: "dispatch_preflight_rejected",
    job_status: "completed",
  });
  const providerMutation = await provider.query(
    "SELECT 1 FROM mock_contract_operations WHERE operation_id = $1",
    [await coreProviderOperationId(saved.created.requestId)],
  );
  assert.equal(providerMutation.rowCount, 0);
}

async function runMismatch(): Promise<void> {
  await ensureCatalog();
  const account = await createAccountFixture(`mismatch-${randomUUID()}`);
  const fixture = await createService(account.owner, true, "mismatch");
  const initial = await list(account.owner, fixture.serviceId);
  const created = await requestCustomerOperation(account.owner, fixture.serviceId, initial.service, "stop");
  const operationId = await coreProviderOperationId(created.requestId);
  await waitFor(
    "restart Provider operation to be persisted",
    async () => {
      const result = await provider.query<{ present: boolean }>(
        "SELECT true AS present FROM mock_contract_operations WHERE operation_id = $1",
        [operationId],
      );
      return result.rows[0]?.present ?? false;
    },
    (value) => value,
  );
  const wrongOperationId = randomUUID();
  await provider.query(
    `UPDATE mock_contract_operations
        SET final_result_json = jsonb_set(final_result_json, '{operationId}', to_jsonb($2::text))
      WHERE operation_id = $1`,
    [operationId, wrongOperationId],
  );
  const terminal = await waitForResult(account.owner, fixture.serviceId, created.requestId, ["manual"]);
  assert.equal(terminal.service.resourceState, "running");
  assertCustomerFactProjection(terminal, created.requestId, "staff_action_required");
  const projection = await core.query<{
    status: string;
    error_code: string;
    mutation_count: number;
    reconcile_count: number;
    job_status: string;
  }>(
    `SELECT result.status, result.error_code,
            count(*) FILTER (WHERE attempt.attempt_kind = 'mutation')::integer AS mutation_count,
            count(*) FILTER (WHERE attempt.attempt_kind = 'reconcile_query')::integer AS reconcile_count,
            job.status AS job_status
       FROM service_resource_operation_requests request
       JOIN LATERAL (
         SELECT status, error_code FROM service_resource_operation_result_facts
          WHERE request_id = request.id ORDER BY revision DESC LIMIT 1
       ) result ON true
       LEFT JOIN service_resource_operation_attempt_facts attempt ON attempt.request_id = request.id
       JOIN durable_jobs job
         ON job.job_type = 'service.operation.reconcile'
        AND job.payload->>'requestId' = request.id::text
      WHERE request.id = $1
      GROUP BY result.status, result.error_code, job.status`,
    [created.requestId],
  );
  assert.deepEqual(projection.rows[0], {
    status: "manual",
    error_code: "provider_result_binding_mismatch",
    mutation_count: 1,
    reconcile_count: 1,
    job_status: "manual",
  });
  const calls = await provider.query<{ create_calls: number; reconcile_calls: number }>(
    "SELECT create_calls, reconcile_calls FROM mock_contract_operations WHERE operation_id = $1",
    [operationId],
  );
  assert.equal(calls.rows[0]?.create_calls, 1);
  assert.equal(calls.rows[0]?.reconcile_calls, 1);

  const resourceFixture = await createService(account.owner, true, "resource-mismatch");
  const resourceInitial = await list(account.owner, resourceFixture.serviceId);
  const resourceCreated = await requestCustomerOperation(
    account.owner,
    resourceFixture.serviceId,
    resourceInitial.service,
    "stop",
  );
  const resourceOperationId = await coreProviderOperationId(resourceCreated.requestId);
  await waitFor(
    "restart Provider resource mismatch operation to be persisted",
    async () => {
      const result = await provider.query<{ present: boolean }>(
        "SELECT true AS present FROM mock_contract_operations WHERE operation_id = $1",
        [resourceOperationId],
      );
      return result.rows[0]?.present ?? false;
    },
    (value) => value,
  );
  await provider.query(
    `UPDATE mock_contract_operations
        SET final_result_json = jsonb_set(
          final_result_json,
          '{output,externalResourceRef}',
          to_jsonb($2::text)
        )
      WHERE operation_id = $1`,
    [resourceOperationId, `wrong-resource-${randomUUID()}`],
  );
  const resourceTerminal = await waitForResult(
    account.owner,
    resourceFixture.serviceId,
    resourceCreated.requestId,
    ["manual"],
  );
  assert.equal(resourceTerminal.service.resourceState, "running");
  const resourceProjection = await core.query<{
    result_status: string;
    error_code: string;
    operation_status: string;
    external_reference: string | null;
    mutation_count: number;
    reconcile_count: number;
    job_status: string;
  }>(
    `SELECT result.status AS result_status, result.error_code,
            operation.status AS operation_status, operation.external_reference,
            count(*) FILTER (WHERE attempt.attempt_kind = 'mutation')::integer AS mutation_count,
            count(*) FILTER (WHERE attempt.attempt_kind = 'reconcile_query')::integer AS reconcile_count,
            job.status AS job_status
       FROM service_resource_operation_requests request
       JOIN provider_operations operation
         ON operation.subject_type = 'service_resource_operation'
        AND operation.subject_id = request.id
       JOIN LATERAL (
         SELECT status, error_code FROM service_resource_operation_result_facts
          WHERE request_id = request.id ORDER BY revision DESC LIMIT 1
       ) result ON true
       LEFT JOIN service_resource_operation_attempt_facts attempt ON attempt.request_id = request.id
       JOIN durable_jobs job
         ON job.job_type = 'service.operation.reconcile'
        AND job.payload->>'requestId' = request.id::text
      WHERE request.id = $1
      GROUP BY result.status, result.error_code, operation.status,
               operation.external_reference, job.status`,
    [resourceCreated.requestId],
  );
  assert.deepEqual(resourceProjection.rows[0], {
    result_status: "manual",
    error_code: "provider_contract_mismatch",
    operation_status: "unknown",
    external_reference: null,
    mutation_count: 1,
    reconcile_count: 1,
    job_status: "manual",
  });
  const resourceCalls = await provider.query<{ create_calls: number; reconcile_calls: number }>(
    "SELECT create_calls, reconcile_calls FROM mock_contract_operations WHERE operation_id = $1",
    [resourceOperationId],
  );
  assert.deepEqual(resourceCalls.rows[0], { create_calls: 1, reconcile_calls: 1 });

  // A non-cancellation Service-version drift after the Provider call must be
  // discoverable and completable from the standalone operations queue using
  // current, not request-snapshot, revisions.
  const staleStaff = await createStaff(`stale-queue-${randomUUID()}`);
  const staleFixture = await createService(account.owner, true, "stale-queue");
  const staleInitial = await list(account.owner, staleFixture.serviceId);
  const staleCreated = await requestCustomerOperation(
    account.owner,
    staleFixture.serviceId,
    staleInitial.service,
    "stop",
  );
  const staleOperationId = await coreProviderOperationId(staleCreated.requestId);
  await waitFor(
    "restart Provider stale-result operation to be persisted",
    async () => {
      const result = await provider.query<{ present: boolean }>(
        "SELECT true AS present FROM mock_contract_operations WHERE operation_id = $1",
        [staleOperationId],
      );
      return result.rows[0]?.present ?? false;
    },
    (value) => value,
  );
  await core.query(
    `UPDATE services
        SET version = version + 1, updated_at = pg_catalog.clock_timestamp()
      WHERE id = $1`,
    [staleFixture.serviceId],
  );
  await waitForResult(
    account.owner,
    staleFixture.serviceId,
    staleCreated.requestId,
    ["manual"],
  );
  type StaffQueue = {
    items: Array<{
      requestId: string;
      expectedServiceVersion: number;
      expectedResourceRevision: number;
      currentServiceVersion: number;
      currentResourceRevision: number;
      status: string;
      detail: string | null;
    }>;
  };
  const queue = await api<StaffQueue>(staleStaff, "/api/v1/admin/service-operations?status=unresolved");
  const queueItem = queue.items.find((item) => item.requestId === staleCreated.requestId);
  assert.ok(queueItem);
  assert.equal(queueItem.status, "manual");
  assert.match(queueItem.detail ?? "", /current Core service\/resource revisions changed/);
  assert.equal(queueItem.expectedServiceVersion, staleInitial.service.version);
  assert.equal(queueItem.currentServiceVersion, staleInitial.service.version + 1);
  await api(
    staleStaff,
    `/api/v1/admin/service-operations/${staleCreated.requestId}/complete-manual`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedServiceVersion: queueItem.expectedServiceVersion,
        expectedResourceRevision: queueItem.expectedResourceRevision,
        reason: "Synthetic stale Provider result reconciliation",
        idempotencyKey: `stale-old-${randomUUID()}`,
      }),
    },
    409,
  );
  await api(
    staleStaff,
    `/api/v1/admin/service-operations/${staleCreated.requestId}/complete-manual`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedServiceVersion: queueItem.currentServiceVersion,
        expectedResourceRevision: queueItem.currentResourceRevision,
        reason: "Verified current revisions and completed stale Provider result",
        idempotencyKey: `stale-current-${randomUUID()}`,
      }),
    },
    201,
  );
  const staleCompleted = await list(account.owner, staleFixture.serviceId);
  assert.equal(
    staleCompleted.items.find((item) => item.requestId === staleCreated.requestId)?.status,
    "succeeded",
  );
  assert.equal(staleCompleted.service.resourceState, "stopped");
  const staleFacts = await core.query<{ desired: number; observed: number }>(
    `SELECT
       count(*) FILTER (WHERE desired.operation_request_id = $1)::integer AS desired,
       (SELECT count(*)::integer FROM service_resource_state_facts observed
         WHERE observed.operation_request_id = $1) AS observed
       FROM service_resource_desired_state_facts desired`,
    [staleCreated.requestId],
  );
  assert.deepEqual(staleFacts.rows[0], { desired: 1, observed: 1 });
}

async function runReconcileBudget(): Promise<void> {
  await ensureCatalog();
  const worker = await loadServiceWorker();
  const runtime: ServiceOperationRuntime = {
    workerId: `service-operations-budget-${process.pid}`,
    providerUrl,
    providerToken: process.env.MOCK_PROVIDER_PLATFORM_TOKEN ?? providerToken!,
    providerTimeoutMs: 1_000,
    scenario: "restart",
    reconcileBaseDelaySeconds: 0,
    reconcileMaxAttempts: 3,
    staleLockSeconds: 1,
  };

  async function prepare(label: string) {
    const account = await createAccountFixture(`${label}-${randomUUID()}`);
    const fixture = await createService(account.owner, true, label);
    const initial = await list(account.owner, fixture.serviceId);
    const created = await requestCustomerOperation(
      account.owner,
      fixture.serviceId,
      initial.service,
      "stop",
    );
    const startJob = await claimServiceOperationJobForRequest(
      runtime.workerId,
      created.requestId,
      "service.operation.start",
    );
    await worker.processServiceOperationStart(workerCore, startJob, runtime);
    const projection = await core.query<{ status: string; operation_id: string }>(
      `SELECT result.status, operation.id::text AS operation_id
         FROM service_resource_operation_requests request
         JOIN provider_operations operation
           ON operation.subject_type = 'service_resource_operation'
          AND operation.subject_id = request.id
         JOIN LATERAL (
           SELECT status FROM service_resource_operation_result_facts
            WHERE request_id = request.id ORDER BY revision DESC LIMIT 1
         ) result ON true
        WHERE request.id = $1`,
      [created.requestId],
    );
    assert.equal(projection.rows[0]?.status, "unknown");
    const operationId = projection.rows[0]!.operation_id;
    const providerFact = await provider.query<{ final_result_json: unknown }>(
      "SELECT final_result_json FROM mock_contract_operations WHERE operation_id = $1",
      [operationId],
    );
    assert.equal(providerFact.rowCount, 1);
    return {
      account,
      fixture,
      created,
      operationId,
      finalResult: providerFact.rows[0]!.final_result_json,
    };
  }

  async function forcePending(operationId: string): Promise<void> {
    await provider.query(
      `UPDATE mock_contract_operations
          SET final_result_json = result_json
        WHERE operation_id = $1`,
      [operationId],
    );
  }

  async function processReconcile(
    requestId: string,
    selectedRuntime: ServiceOperationRuntime = runtime,
  ): Promise<void> {
    const job = await claimServiceOperationJobForRequest(
      selectedRuntime.workerId,
      requestId,
      "service.operation.reconcile",
    );
    await worker.processServiceOperationReconcile(workerCore, job, selectedRuntime);
  }

  const found = await prepare("budget-found");
  await forcePending(found.operationId);
  await expectTransactionFailure("an isolated manual result cannot poison a pending reconcile job", async (client) => {
    await client.query(
      `INSERT INTO service_resource_operation_result_facts(
         request_id, revision, status, detail, error_code, evidence
       ) VALUES ($1, 3, 'manual', 'forged manual result without Worker authority',
                 'forged_manual', '{"providerCalled":true}'::jsonb)`,
      [found.created.requestId],
    );
  });
  await expectTransactionFailure("an isolated failed result and Provider row cannot poison reconciliation", async (client) => {
    await client.query(
      `INSERT INTO service_resource_operation_result_facts(
         request_id, revision, status, detail, error_code, evidence
       ) VALUES ($1, 3, 'failed', 'forged failure without Worker authority',
                 'forged_failure', '{"providerCalled":true}'::jsonb)`,
      [found.created.requestId],
    );
    await client.query(
      `UPDATE provider_operations
          SET status = 'failed', last_error = 'forged failure', updated_at = now()
        WHERE id = $1`,
      [found.operationId],
    );
  });
  await expectTransactionFailure("a pending reconcile job cannot authorize a GET attempt", async (client) => {
    await client.query(
      `INSERT INTO service_resource_operation_attempt_facts(
         request_id, provider_operation_id, durable_job_id, durable_job_attempts, attempt_number,
         attempt_kind, actor_id, started_at
       ) SELECT $1, $2, job.id, job.attempts, 2,
                'reconcile_query', 'forged-worker', pg_catalog.clock_timestamp()
           FROM durable_jobs job
          WHERE job.job_type = 'service.operation.reconcile'
            AND job.payload->>'requestId' = $1::uuid::text`,
      [found.created.requestId, found.operationId],
    );
  });
  const crashedJob = await claimServiceOperationJobForRequest(
    runtime.workerId,
    found.created.requestId,
    "service.operation.reconcile",
  );
  await expectTransactionFailure("an exact reconcile attempt cannot commit while its lease remains active", async (client) => {
    await client.query(
      `INSERT INTO service_resource_operation_attempt_facts(
         request_id, provider_operation_id, durable_job_id, durable_job_attempts,
         attempt_number, attempt_kind, actor_id, started_at
       ) VALUES ($1, $2, $3, $4, 2, 'reconcile_query', $5,
                 pg_catalog.clock_timestamp())`,
      [
        found.created.requestId,
        found.operationId,
        crashedJob.id,
        crashedJob.attempts,
        crashedJob.locked_by,
      ],
    );
  });
  await expectTransactionFailure("a reconcile lease cannot forge a terminal result without a GET attempt", async (client) => {
    await client.query(
      `INSERT INTO service_resource_operation_result_facts(
         request_id, revision, status, detail, error_code, evidence
       ) VALUES ($1, 3, 'manual', 'forged terminal without Provider GET',
                 'forged_reconcile_terminal', '{"providerCalled":true}'::jsonb)`,
      [found.created.requestId],
    );
    await client.query(
      `INSERT INTO service_operation_job_transition_facts(
         job_id, request_id, from_status, to_status, job_attempts, worker_id
       ) VALUES ($1, $2, 'running', 'manual', $3, $4)`,
      [
        crashedJob.id,
        found.created.requestId,
        crashedJob.attempts,
        crashedJob.locked_by,
      ],
    );
    await client.query(
      `UPDATE durable_jobs
          SET status = 'manual', locked_at = NULL, locked_by = NULL,
              last_error = 'forged terminal without Provider GET',
              updated_at = pg_catalog.clock_timestamp()
        WHERE id = $1`,
      [crashedJob.id],
    );
  });
  await expectTransactionFailure("a reconcile attempt cannot borrow another Worker's lease", async (client) => {
    await client.query(
      `INSERT INTO service_resource_operation_attempt_facts(
         request_id, provider_operation_id, durable_job_id, durable_job_attempts, attempt_number,
         attempt_kind, actor_id, started_at
       ) VALUES ($1, $2, $3, $4, 2, 'reconcile_query',
                 'wrong-worker', pg_catalog.clock_timestamp())`,
      [found.created.requestId, found.operationId, crashedJob.id, crashedJob.attempts],
    );
  });
  await expectTransactionFailure("one reconcile lease cannot forge multiple GET attempts", async (client) => {
    await client.query(
      `INSERT INTO service_resource_operation_attempt_facts(
         request_id, provider_operation_id, durable_job_id, durable_job_attempts,
         attempt_number, attempt_kind, actor_id, started_at
       ) VALUES
         ($1, $2, $3, $4, 2, 'reconcile_query', $5, pg_catalog.clock_timestamp()),
         ($1, $2, $3, $4, 3, 'reconcile_query', $5, pg_catalog.clock_timestamp())`,
      [
        found.created.requestId,
        found.operationId,
        crashedJob.id,
        crashedJob.attempts,
        crashedJob.locked_by,
      ],
    );
  });
  await assert.rejects(
    worker.processServiceOperationReconcile(workerCore, crashedJob, runtime, {
      beforeProviderGet: () => {
        throw new Error("synthetic crash after reconcile preflight and before Provider GET");
      },
    }),
    /before Provider GET/,
  );
  const beforeRecovery = await core.query<{ count: number }>(
    `SELECT count(*)::integer AS count
       FROM service_resource_operation_attempt_facts
      WHERE request_id = $1 AND attempt_kind = 'reconcile_query'`,
    [found.created.requestId],
  );
  assert.equal(beforeRecovery.rows[0]?.count, 0);
  await new Promise((resolve) => setTimeout(resolve, 1_250));
  assert.ok(await worker.recoverStaleServiceOperationJobs(workerCore, runtime) >= 1);
  const afterRecovery = await core.query<{ status: string; count: number }>(
    `SELECT job.status,
            (SELECT count(*)::integer
               FROM service_resource_operation_attempt_facts attempt
              WHERE attempt.request_id = $1
                AND attempt.attempt_kind = 'reconcile_query') AS count
       FROM durable_jobs job
      WHERE job.id = $2`,
    [found.created.requestId, crashedJob.id],
  );
  assert.deepEqual(afterRecovery.rows[0], { status: "pending", count: 0 });

  await processReconcile(found.created.requestId);
  await processReconcile(found.created.requestId);
  await provider.query(
    `UPDATE mock_contract_operations
        SET final_result_json = $2::jsonb
      WHERE operation_id = $1`,
    [found.operationId, found.finalResult],
  );
  await processReconcile(found.created.requestId);
  const foundTerminal = await list(found.account.owner, found.fixture.serviceId);
  const foundFact = foundTerminal.items.find((item) => item.requestId === found.created.requestId);
  assert.equal(foundFact?.status, "succeeded");
  const foundEvidence = await core.query<{ count: number; job_status: string }>(
    `SELECT count(*) FILTER (WHERE attempt.attempt_kind = 'reconcile_query')::integer AS count,
            job.status AS job_status
       FROM service_resource_operation_attempt_facts attempt
       JOIN durable_jobs job
         ON job.job_type = 'service.operation.reconcile'
        AND job.payload->>'requestId' = attempt.request_id::text
      WHERE attempt.request_id = $1
      GROUP BY job.status`,
    [found.created.requestId],
  );
  assert.deepEqual(foundEvidence.rows[0], { count: 3, job_status: "completed" });

  const nonterminal = await prepare("budget-nonterminal");
  await forcePending(nonterminal.operationId);
  for (let actualGet = 0; actualGet < 3; actualGet += 1) {
    await processReconcile(nonterminal.created.requestId);
  }
  const nonterminalFact = (await list(nonterminal.account.owner, nonterminal.fixture.serviceId))
    .items.find((item) => item.requestId === nonterminal.created.requestId);
  assert.equal(nonterminalFact?.status, "manual");

  const transport = await prepare("budget-transport");
  await forcePending(transport.operationId);
  await processReconcile(transport.created.requestId);
  await processReconcile(transport.created.requestId);
  const unavailableRuntime: ServiceOperationRuntime = {
    ...runtime,
    workerId: `${runtime.workerId}-transport`,
    providerUrl: "http://127.0.0.1:1",
    providerTimeoutMs: 100,
  };
  await processReconcile(transport.created.requestId, unavailableRuntime);
  const transportFact = (await list(transport.account.owner, transport.fixture.serviceId))
    .items.find((item) => item.requestId === transport.created.requestId);
  assert.equal(transportFact?.status, "manual");

  for (const item of [found, nonterminal, transport]) {
    const evidence = await core.query<{ count: number }>(
      `SELECT count(*) FILTER (WHERE attempt_kind = 'reconcile_query')::integer AS count
         FROM service_resource_operation_attempt_facts
        WHERE request_id = $1`,
      [item.created.requestId],
    );
    assert.equal(evidence.rows[0]?.count, 3);
  }
  const providerCalls = await provider.query<{ operation_id: string; reconcile_calls: number }>(
    `SELECT operation_id::text, reconcile_calls
       FROM mock_contract_operations
      WHERE operation_id = ANY($1::uuid[])
      ORDER BY operation_id`,
    [[found.operationId, nonterminal.operationId, transport.operationId]],
  );
  const callsById = new Map(providerCalls.rows.map((row) => [row.operation_id, row.reconcile_calls]));
  assert.equal(callsById.get(found.operationId), 3);
  assert.equal(callsById.get(nonterminal.operationId), 3);
  assert.equal(callsById.get(transport.operationId), 2);
}

try {
  if (phase === "schema") await runSchemaGate();
  else if (phase === "normal") await withServiceWorker("normal", runNormal);
  else if (phase === "timeout") await withServiceWorker("timeout", runTimeout);
  else if (phase === "failure") await withServiceWorker("failure", runProviderFailure);
  else if (phase === "cancellation") await runCancellationIndependence();
  else if (phase === "prepare-revoked") await runPrepareRevoked();
  else if (phase === "prepare-browser") await runPrepareBrowser();
  else if (phase === "verify-revoked") {
    await withServiceWorker("normal", runVerifyRevoked);
  } else if (phase === "mismatch") {
    await withServiceWorker("restart", runMismatch);
  } else if (phase === "reconcile-budget") {
    await runReconcileBudget();
  }
  else throw new Error(`Unsupported SERVICE_OPERATION_INTEGRATION_PHASE: ${phase}`);
  console.log(`Service operations ${phase} integration: PASS`);
} finally {
  await Promise.all([core.end(), workerCore.end(), provider.end()]);
}
