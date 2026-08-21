// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createIdentitySecretKeyring } from "@opensales/core/identity-security";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { buildApp } from "./app.js";
import { digestToken } from "./auth.js";
import type { Config } from "./config.js";
import {
  assertSchemaCompatible,
  REQUIRED_SCHEMA_VERSION,
  runMigrations,
} from "./database.js";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) {
  throw new Error("ADMIN_DATABASE_URL is required for Service password-change integration");
}

const PROVIDER_TRANSPORT_VERSION = "v1" as const;
const PROVIDER_CONTRACT_VERSION = "v1alpha1" as const;

type Actor = Readonly<{
  userId: string;
  sessionId: string;
  token: string;
  accountId: string | null;
}>;

type ServicePasswordChangeJob = Readonly<{
  id: string;
  job_type: string;
  unique_key: string;
  payload: Record<string, string>;
  payload_snapshot: string;
  attempts: number;
  locked_at_epoch: string;
  locked_by: string | null;
}>;

type ServicePasswordChangeRuntime = Readonly<{
  workerId: string;
  providerUrl: string;
  providerToken: string;
  providerTimeoutMs: number;
  scenario: "normal" | "failure" | "duplicate" | "out_of_order" | "timeout" | "restart";
  reconcileBaseDelaySeconds: number;
  reconcileMaxAttempts: number;
  staleLockSeconds: number;
  keyring: ReturnType<typeof createIdentitySecretKeyring>;
}>;

type PasswordChangeWorker = Readonly<{
  processServicePasswordChangeStart(
    pool: pg.Pool,
    job: ServicePasswordChangeJob,
    runtime: ServicePasswordChangeRuntime,
  ): Promise<void>;
  processServicePasswordChangeReconcile(
    pool: pg.Pool,
    job: ServicePasswordChangeJob,
    runtime: ServicePasswordChangeRuntime,
  ): Promise<void>;
  recoverStaleServicePasswordChangeJobs(
    pool: pg.Pool,
    runtime: ServicePasswordChangeRuntime,
  ): Promise<number>;
}>;

type ProviderPlatform = Readonly<{
  createProviderRequestFingerprintKeyring(
    activeVersion: number,
    activeKey: string,
    previousKeys?: string,
  ): Readonly<{ activeVersion: number; keys: ReadonlyMap<number, Buffer> }>;
  registerProviderPlatformRoutes(
    app: FastifyInstance,
    pool: pg.Pool,
    config: Readonly<{
      publicBaseUrl: string;
      authoritativeProvisioningResources?: boolean;
      requestFingerprintKeyring: Readonly<{
        activeVersion: number;
        keys: ReadonlyMap<number, Buffer>;
      }>;
    }>,
  ): Promise<void>;
}>;

type CreatedPasswordChange = Readonly<{
  requestId: string;
  serviceId: string;
  status: string;
  replayed: boolean;
}>;

const databaseName = `oss_service029_normal_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = new URL(adminDatabaseUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = new pg.Client({ connectionString: adminDatabaseUrl });
let pool: pg.Pool | null = null;
let providerPool: pg.Pool | null = null;
let coreApp: Awaited<ReturnType<typeof buildApp>>["app"] | null = null;
let providerApp: FastifyInstance | null = null;
let rotatedProviderApp: FastifyInstance | null = null;
let missingFingerprintKeyProviderApp: FastifyInstance | null = null;
let mutationBarrierApp: FastifyInstance | null = null;
let reconcileBarrierApp: FastifyInstance | null = null;
let reconcileExhaustionApp: FastifyInstance | null = null;

const identityKey = Buffer.alloc(32, 109).toString("base64url");
const providerFingerprintKeyV1 = Buffer.alloc(32, 112).toString("base64url");
const providerFingerprintKeyV2 = Buffer.alloc(32, 113).toString("base64url");
const config: Config = {
  DATABASE_URL: databaseUrl.toString(),
  OSS_ENV: "test",
  OSS_LOG_LEVEL: "silent",
  OSS_PUBLIC_URL: "http://127.0.0.1:3000",
  API_HOST: "127.0.0.1",
  API_PORT: 3000,
  GLOBAL_RATE_LIMIT_MAX: 10_000,
  SESSION_COOKIE_NAME: "oss_service029_session",
  SESSION_TTL_HOURS: 24,
  VERIFICATION_TTL_MINUTES: 30,
  WEB_ORIGIN: "http://127.0.0.1:5173",
  MOCK_MAILBOX_URL: "http://127.0.0.1:4000",
  LAB_MAILBOX_TOKEN: "L".repeat(32),
  PROVIDER_OPERATION_CAPABILITY_SECRET: "C".repeat(32),
  PAYMENT_METHOD_TOKEN_KEY: Buffer.alloc(32, 107).toString("base64url"),
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY: Buffer.alloc(32, 108).toString("base64url"),
  IDENTITY_SECRET_KEY: identityKey,
  MOCK_PAYMENT_WEBHOOK_SECRET: "W".repeat(32),
  MOCK_PROVISIONING_WEBHOOK_SECRET: "V".repeat(32),
  NOTIFICATION_MAX_ATTEMPTS: 3,
  LAB_MAILBOX_ENABLED: false,
};

function cookie(actor: Actor): Record<string, string> {
  return {
    cookie: `${config.SESSION_COOKIE_NAME}=${actor.token}`,
    ...(actor.accountId ? { "x-oss-account-context-version": "1" } : {}),
  };
}

function requestBody(password: string, idempotencyKey: string, reason?: string) {
  return {
    expectedServiceVersion: 1,
    expectedResourceRevision: 1,
    idempotencyKey,
    newPassword: password,
    ...(reason ? { reason } : {}),
  };
}

async function loadWorker(): Promise<PasswordChangeWorker> {
  const url = new URL("../../worker/dist/service-password-changes.js", import.meta.url);
  return await import(url.href) as PasswordChangeWorker;
}

async function loadProviderPlatform(): Promise<ProviderPlatform> {
  const url = new URL("../../../providers/mock-lab/dist/provider-platform.js", import.meta.url);
  return await import(url.href) as ProviderPlatform;
}

async function createProviderTables(database: pg.Pool): Promise<void> {
  await database.query(`
    CREATE TABLE public.mock_resource_operations (
      operation_id uuid PRIMARY KEY,
      service_id uuid NOT NULL,
      external_resource_id text UNIQUE,
      callback_capability text NOT NULL,
      scenario text NOT NULL,
      status text NOT NULL,
      ready_at timestamptz,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      create_calls integer NOT NULL DEFAULT 1,
      request_fingerprint text NOT NULL,
      resource_state text NOT NULL DEFAULT 'active'
        CHECK (resource_state IN ('active', 'suspended', 'terminated')),
      power_state text NOT NULL DEFAULT 'running'
        CHECK (power_state IN ('running', 'stopped', 'terminated')),
      desired_power_state text NOT NULL DEFAULT 'running'
        CHECK (desired_power_state IN ('running', 'stopped', 'terminated'))
    )
  `);
}

async function seed(database: pg.Pool): Promise<{
  customer: Actor;
  staff: Actor;
  serviceIds: readonly [string, string, string, string, string];
}> {
  const customerUserId = randomUUID();
  const customerSessionId = randomUUID();
  const customerToken = randomBytes(32).toString("base64url");
  const staffUserId = randomUUID();
  const staffSessionId = randomUUID();
  const staffToken = randomBytes(32).toString("base64url");
  const accountId = randomUUID();
  const serviceIds = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ] as const;
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO product_groups(id, sort_order, names)
       VALUES ('service029-normal', 999,
               '{"en":"Service password change","zh-CN":"服务密码变更"}'::jsonb)`,
    );
    await client.query(
      `INSERT INTO products(
         id, group_id, names, descriptions, fulfillment_mode, active, hidden,
         repeatable, option_schema
       ) VALUES (
         'service029-normal', 'service029-normal',
         '{"en":"Mock password-change service","zh-CN":"Mock 密码变更服务"}'::jsonb,
         '{"en":"Mock-only normal integration","zh-CN":"仅 Mock 正常集成"}'::jsonb,
         'automatic', true, true, true, '[]'::jsonb
       )`,
    );
    await client.query(
      `INSERT INTO provider_installation_capabilities(
         provider_installation_id, provider_type, enabled, capabilities
       ) VALUES (
         'mock-provisioning-v1', 'provisioning', true,
         '["resource_create","resource_reconcile","resource_suspend","resource_resume","resource_terminate","resource.start","resource.stop","resource.reboot","resource.change_password"]'::jsonb
       )`,
    );
    await client.query(
      `INSERT INTO product_service_automation_policies(
         product_id, overdue_action, provider_installation_id,
         overdue_delay_mode, overdue_delay_value, version,
         cycle_end_cancellation_mode, cycle_end_cancellation_execution_mode,
         cycle_end_cancellation_min_notice_hours,
         cycle_end_cancellation_requirement_key
       ) VALUES (
         'service029-normal', 'automatic', 'mock-provisioning-v1',
         'policy_calendar_days', 5, 1, 'self_service', 'automatic', 0, NULL
       )`,
    );
    await client.query(
      `INSERT INTO users(id, email, password_hash, locale, email_verified_at)
       VALUES
         ($1, $2, $5, 'en', clock_timestamp()),
         ($3, $4, $6, 'en', clock_timestamp())`,
      [
        customerUserId,
        `service029-customer-${customerUserId}@example.invalid`,
        staffUserId,
        `service029-staff-${staffUserId}@example.invalid`,
        "H".repeat(32),
        "J".repeat(32),
      ],
    );
    await client.query(
      "INSERT INTO client_accounts(id, name, owner_user_id) VALUES ($1, 'Service 029 normal account', $2)",
      [accountId, customerUserId],
    );
    await client.query(
      `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
       VALUES ($1, $2, 'owner', '[]'::jsonb)`,
      [accountId, customerUserId],
    );
    await client.query(
      `INSERT INTO sessions(
         id, user_id, token_digest, expires_at,
         active_client_account_id, account_context_version
       ) VALUES
         ($1, $2, $3, clock_timestamp() + interval '2 hours', $4, 1),
         ($5, $6, $7, clock_timestamp() + interval '2 hours', NULL, 0)`,
      [
        customerSessionId,
        customerUserId,
        digestToken(customerToken),
        accountId,
        staffSessionId,
        staffUserId,
        digestToken(staffToken),
      ],
    );
    await client.query(
      `INSERT INTO staff_members(user_id, roles, permissions)
       VALUES ($1, ARRAY['ServiceOperations'],
               '["services.read","services.operations_manage"]'::jsonb)`,
      [staffUserId],
    );
    await client.query(
      `INSERT INTO reauth_grants(user_id, session_id, expires_at)
       VALUES ($1, $2, now() + interval '10 minutes')`,
      [staffUserId, staffSessionId],
    );
    for (const [index, serviceId] of serviceIds.entries()) {
      const orderId = randomUUID();
      const orderItemId = randomUUID();
      const externalResourceId = `service029-resource-${serviceId}`;
      await client.query(
        `INSERT INTO orders(
           id, client_account_id, submitted_by_user_id, status, currency,
           price_snapshot, one_time_minor, setup_minor, recurring_minor,
           total_minor, idempotency_key, request_fingerprint
         ) VALUES ($1, $2, $3, 'completed', 'USD', '{}'::jsonb,
                   0, 0, 100, 100, $4, $5)`,
        [
          orderId,
          accountId,
          customerUserId,
          `service029-order-${index}-${orderId}`,
          createHash("sha256").update(orderId).digest("hex"),
        ],
      );
      await client.query(
        `INSERT INTO order_items(
           id, order_id, product_id, product_name, fulfillment_mode,
           billing_cycle, configuration, price_snapshot, client_account_id
         ) VALUES ($1, $2, 'service029-normal', 'Mock password-change service',
                   'automatic', 'monthly', '{}'::jsonb, '{}'::jsonb, $3)`,
        [orderItemId, orderId, accountId],
      );
      await client.query(
        `INSERT INTO services(
           id, client_account_id, order_item_id, status, billing_cycle,
           external_resource_id, activated_at, term_start, term_end
         ) VALUES ($1, $2, $3, 'active', 'monthly', $4,
                   clock_timestamp(), clock_timestamp(),
                   clock_timestamp() + interval '30 days')`,
        [serviceId, accountId, orderItemId, externalResourceId],
      );
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
          WHERE policy.product_id = 'service029-normal'`,
        [serviceId],
      );
      await client.query(
        `INSERT INTO mock_resource_operations(
           operation_id, service_id, external_resource_id,
           callback_capability, scenario, status, ready_at,
           request_fingerprint, resource_state, power_state, desired_power_state
         ) VALUES ($1, $2, $3, $4, 'success', 'succeeded', clock_timestamp(),
                   $5, 'active', 'running', 'running')`,
        [randomUUID(), serviceId, externalResourceId, "S".repeat(43), `fixture:${serviceId}`],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return {
    customer: {
      userId: customerUserId,
      sessionId: customerSessionId,
      token: customerToken,
      accountId,
    },
    staff: {
      userId: staffUserId,
      sessionId: staffSessionId,
      token: staffToken,
      accountId: null,
    },
    serviceIds,
  };
}

async function claimJob(
  database: pg.Pool,
  requestId: string,
  jobType: "service.password_change.start" | "service.password_change.reconcile",
  workerId: string,
): Promise<ServicePasswordChangeJob> {
  const result = await database.query<ServicePasswordChangeJob>(
    `UPDATE durable_jobs job
        SET status = 'running', attempts = job.attempts + 1,
            locked_at = clock_timestamp(), locked_by = $1,
            updated_at = clock_timestamp()
      WHERE job.job_type = $2
        AND job.payload->>'requestId' = $3
        AND job.status = 'pending'
        AND job.available_at <= clock_timestamp()
      RETURNING job.id, job.job_type, job.unique_key, job.payload,
                job.payload::text AS payload_snapshot, job.attempts,
                EXTRACT(epoch FROM job.locked_at)::numeric::text AS locked_at_epoch,
                job.locked_by`,
    [workerId, jobType, requestId],
  );
  assert.equal(result.rowCount, 1, `${jobType} must be claimable for ${requestId}`);
  return result.rows[0]!;
}

async function assertNoPlaintext(database: pg.Pool, plaintexts: readonly string[]): Promise<void> {
  for (const plaintext of plaintexts) {
    const result = await database.query<{ leaked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM service_configuration_operation_requests row
          WHERE to_jsonb(row)::text LIKE '%' || $1 || '%'
         UNION ALL
         SELECT 1 FROM service_configuration_secret_envelopes row
          WHERE to_jsonb(row)::text LIKE '%' || $1 || '%'
         UNION ALL
         SELECT 1 FROM service_configuration_operation_attempts row
          WHERE to_jsonb(row)::text LIKE '%' || $1 || '%'
         UNION ALL
         SELECT 1 FROM service_configuration_operation_result_facts row
          WHERE to_jsonb(row)::text LIKE '%' || $1 || '%'
         UNION ALL
         SELECT 1 FROM service_configuration_operation_job_transitions row
          WHERE to_jsonb(row)::text LIKE '%' || $1 || '%'
         UNION ALL
         SELECT 1 FROM provider_operations row
          WHERE to_jsonb(row)::text LIKE '%' || $1 || '%'
         UNION ALL
         SELECT 1 FROM durable_jobs row
          WHERE row.job_type LIKE 'service.password_change.%'
            AND to_jsonb(row)::text LIKE '%' || $1 || '%'
         UNION ALL
         SELECT 1 FROM audit_events row
          WHERE row.action LIKE 'service.password_change_%'
            AND to_jsonb(row)::text LIKE '%' || $1 || '%'
         UNION ALL
         SELECT 1 FROM mock_contract_operations row
          WHERE to_jsonb(row)::text LIKE '%' || $1 || '%'
         UNION ALL
         SELECT 1 FROM mock_contract_events row
          WHERE to_jsonb(row)::text LIKE '%' || $1 || '%'
         UNION ALL
         SELECT 1 FROM mock_contract_password_change_facts row
          WHERE to_jsonb(row)::text LIKE '%' || $1 || '%'
       ) AS leaked`,
      [plaintext],
    );
    assert.equal(result.rows[0]?.leaked, false, `plaintext must not persist: ${plaintext}`);
  }
}

function runtime(
  providerUrl: string,
  scenario: ServicePasswordChangeRuntime["scenario"],
): ServicePasswordChangeRuntime {
  return {
    workerId: `service029-${scenario}-${randomUUID()}`,
    providerUrl,
    providerToken: "P".repeat(32),
    providerTimeoutMs: scenario === "timeout" ? 15 : 2_000,
    scenario,
    reconcileBaseDelaySeconds: 1,
    reconcileMaxAttempts: 3,
    staleLockSeconds: 2,
    keyring: createIdentitySecretKeyring(1, identityKey),
  };
}

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  pool = new pg.Pool({
    connectionString: databaseUrl.toString(),
    max: 12,
    options: "-c search_path=pg_catalog,public",
    statement_timeout: 20_000,
    application_name: "opensales-service029-normal",
  });
  await runMigrations(pool);
  const schema = await assertSchemaCompatible(pool);
  assert.equal(schema.installedSchemaVersion, REQUIRED_SCHEMA_VERSION);
  assert.equal(schema.mode, "native");

  providerPool = new pg.Pool({
    connectionString: databaseUrl.toString(),
    max: 6,
    statement_timeout: 20_000,
    application_name: "opensales-service029-mock-provider",
  });
  await createProviderTables(providerPool);
  providerApp = Fastify({ logger: false });
  const providerPlatform = await loadProviderPlatform();
  await providerPlatform.registerProviderPlatformRoutes(providerApp, providerPool, {
    publicBaseUrl: "http://127.0.0.1",
    authoritativeProvisioningResources: true,
    requestFingerprintKeyring: providerPlatform.createProviderRequestFingerprintKeyring(
      1,
      providerFingerprintKeyV1,
    ),
  });
  missingFingerprintKeyProviderApp = Fastify({ logger: false });
  await providerPlatform.registerProviderPlatformRoutes(
    missingFingerprintKeyProviderApp,
    providerPool,
    {
      publicBaseUrl: "http://127.0.0.1",
      authoritativeProvisioningResources: true,
      requestFingerprintKeyring: providerPlatform.createProviderRequestFingerprintKeyring(
        2,
        providerFingerprintKeyV2,
      ),
    },
  );
  const providerUrl = await providerApp.listen({ host: "127.0.0.1", port: 0 });
  const fixture = await seed(pool);
  const built = await buildApp(config, pool);
  coreApp = built.app;
  await coreApp.ready();
  const worker = await loadWorker();
  const [
    customerServiceId,
    staffServiceId,
    revokedServiceId,
    timeoutServiceId,
    exhaustedServiceId,
  ] = fixture.serviceIds;
  const plaintexts = [
    `${"C".repeat(18)}!029`,
    `${"S".repeat(18)}!029`,
    `${"R".repeat(18)}!029`,
    `${"T".repeat(18)}!029`,
    `${"P".repeat(18)}!029`,
    `${"O".repeat(18)}!029`,
    `${"E".repeat(18)}!029`,
  ] as const;

  const providerReplayOperationId = randomUUID();
  const providerReplayRequest = {
    transportVersion: PROVIDER_TRANSPORT_VERSION,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    operationId: providerReplayOperationId,
    requestedAt: new Date().toISOString(),
    intentRef: randomUUID(),
    capability: "provisioning" as const,
    action: "resource.change_password" as const,
    input: {
      serviceRef: customerServiceId,
      planRef: "service029-normal",
      externalResourceRef: `service029-resource-${customerServiceId}`,
      configuration: { password: plaintexts[4] },
    },
  };
  const firstProviderReplay = await providerApp.inject({
    method: "POST",
    url: "/v1alpha1/provisioning/operations",
    headers: {
      "idempotency-key": providerReplayOperationId,
      "x-oss-lab-scenario": "normal",
    },
    payload: providerReplayRequest,
  });
  assert.equal(firstProviderReplay.statusCode, 202, firstProviderReplay.body);
  assert.equal(firstProviderReplay.headers["x-oss-idempotent-replay"], "false");
  const exactProviderReplay = await providerApp.inject({
    method: "POST",
    url: "/v1alpha1/provisioning/operations",
    headers: {
      "idempotency-key": providerReplayOperationId,
      "x-oss-lab-scenario": "normal",
    },
    payload: providerReplayRequest,
  });
  assert.equal(exactProviderReplay.statusCode, 202, exactProviderReplay.body);
  assert.equal(exactProviderReplay.headers["x-oss-idempotent-replay"], "true");
  const changedProviderReplay = await providerApp.inject({
    method: "POST",
    url: "/v1alpha1/provisioning/operations",
    headers: {
      "idempotency-key": providerReplayOperationId,
      "x-oss-lab-scenario": "normal",
    },
    payload: {
      ...providerReplayRequest,
      input: {
        ...providerReplayRequest.input,
        configuration: { password: `${"D".repeat(18)}!029` },
      },
    },
  });
  assert.equal(changedProviderReplay.statusCode, 409, changedProviderReplay.body);
  const providerReplayFact = await providerPool.query<{
    request_password: string;
    request_fingerprint: string;
    create_calls: number;
  }>(
    `SELECT request_json #>> '{input,configuration,password}' AS request_password,
            request_fingerprint, create_calls
       FROM mock_contract_operations
      WHERE operation_id = $1`,
    [providerReplayOperationId],
  );
  assert.deepEqual(providerReplayFact.rows[0], {
    request_password: "[REDACTED]",
    request_fingerprint: providerReplayFact.rows[0]!.request_fingerprint,
    create_calls: 2,
  });
  assert.match(
    providerReplayFact.rows[0]!.request_fingerprint,
    /^password-hmac-sha256-v1:1:[0-9a-f]{64}$/,
  );

  rotatedProviderApp = Fastify({ logger: false });
  await providerPlatform.registerProviderPlatformRoutes(rotatedProviderApp, providerPool, {
    publicBaseUrl: "http://127.0.0.1",
    authoritativeProvisioningResources: true,
    requestFingerprintKeyring: providerPlatform.createProviderRequestFingerprintKeyring(
      2,
      providerFingerprintKeyV2,
      `1:${providerFingerprintKeyV1}`,
    ),
  });
  const retainedKeyReplay = await rotatedProviderApp.inject({
    method: "POST",
    url: "/v1alpha1/provisioning/operations",
    headers: {
      "idempotency-key": providerReplayOperationId,
      "x-oss-lab-scenario": "normal",
    },
    payload: providerReplayRequest,
  });
  assert.equal(retainedKeyReplay.statusCode, 202, retainedKeyReplay.body);
  assert.equal(retainedKeyReplay.headers["x-oss-idempotent-replay"], "true");
  await rotatedProviderApp.close();
  rotatedProviderApp = null;

  const beforeMissingKeyReplay = await providerPool.query<{
    request_fingerprint: string;
    request_json: unknown;
    result_json: unknown;
    final_result_json: unknown;
    create_calls: number;
    reconcile_calls: number;
    updated_at: string;
  }>(
    `SELECT request_fingerprint, request_json, result_json, final_result_json,
            create_calls, reconcile_calls, updated_at::text
       FROM mock_contract_operations
      WHERE operation_id = $1`,
    [providerReplayOperationId],
  );
  const missingKeyReplay = await missingFingerprintKeyProviderApp.inject({
    method: "POST",
    url: "/v1alpha1/provisioning/operations",
    headers: {
      "idempotency-key": providerReplayOperationId,
      "x-oss-lab-scenario": "normal",
    },
    payload: providerReplayRequest,
  });
  assert.equal(missingKeyReplay.statusCode, 503, missingKeyReplay.body);
  assert.deepEqual(
    missingKeyReplay.json(),
    { error: "stored request fingerprint key version is unavailable" },
  );
  const afterMissingKeyReplay = await providerPool.query(
    `SELECT request_fingerprint, request_json, result_json, final_result_json,
            create_calls, reconcile_calls, updated_at::text
       FROM mock_contract_operations
      WHERE operation_id = $1`,
    [providerReplayOperationId],
  );
  assert.deepEqual(afterMissingKeyReplay.rows, beforeMissingKeyReplay.rows);

  const withoutReauth = await coreApp.inject({
    method: "POST",
    url: `/api/v1/services/${customerServiceId}/password-changes`,
    headers: cookie(fixture.customer),
    payload: requestBody(plaintexts[0], `customer-${randomUUID()}`),
  });
  assert.equal(withoutReauth.statusCode, 403, withoutReauth.body);
  assert.equal((withoutReauth.json() as { code: string }).code, "REAUTH_REQUIRED");
  assert.equal(
    (await pool.query("SELECT count(*)::integer AS count FROM service_configuration_operation_requests")).rows[0]!.count,
    0,
  );

  await pool.query(
    `INSERT INTO reauth_grants(user_id, session_id, expires_at)
     VALUES ($1, $2, now() + interval '10 minutes')`,
    [fixture.customer.userId, fixture.customer.sessionId],
  );
  const beforeOverlapWrites = await pool.query<{
    requests: number;
    envelopes: number;
    audits: number;
  }>(
    `SELECT
       (SELECT count(*)::integer
          FROM service_configuration_operation_requests) AS requests,
       (SELECT count(*)::integer
          FROM service_configuration_secret_envelopes) AS envelopes,
       (SELECT count(*)::integer FROM audit_events) AS audits`,
  );
  const overlapCustomer = await coreApp.inject({
    method: "POST",
    url: `/api/v1/services/${customerServiceId}/password-changes`,
    headers: cookie(fixture.customer),
    payload: requestBody(plaintexts[5], plaintexts[5]),
  });
  assert.equal(overlapCustomer.statusCode, 400, overlapCustomer.body);
  assert.equal(
    (overlapCustomer.json() as { code: string }).code,
    "SERVICE_PASSWORD_DURABLE_FIELD_CONFLICT",
  );
  const overlapStaffReason = await coreApp.inject({
    method: "POST",
    url: `/api/v1/admin/client-accounts/${fixture.customer.accountId}/services/${staffServiceId}/password-changes`,
    headers: cookie(fixture.staff),
    payload: requestBody(
      plaintexts[5],
      `staff-overlap-${randomUUID()}`,
      `Synthetic reason copied ${plaintexts[5]} into a durable field`,
    ),
  });
  assert.equal(overlapStaffReason.statusCode, 400, overlapStaffReason.body);
  assert.equal(
    (overlapStaffReason.json() as { code: string }).code,
    "SERVICE_PASSWORD_DURABLE_FIELD_CONFLICT",
  );
  const overlapStaffKey = await coreApp.inject({
    method: "POST",
    url: `/api/v1/admin/client-accounts/${fixture.customer.accountId}/services/${staffServiceId}/password-changes`,
    headers: cookie(fixture.staff),
    payload: requestBody(
      plaintexts[5],
      plaintexts[5],
      "Synthetic normal overlap rejection evidence",
    ),
  });
  assert.equal(overlapStaffKey.statusCode, 400, overlapStaffKey.body);
  assert.equal(
    (overlapStaffKey.json() as { code: string }).code,
    "SERVICE_PASSWORD_DURABLE_FIELD_CONFLICT",
  );
  const overlapWrites = await pool.query<{
    requests: number;
    envelopes: number;
    audits: number;
  }>(
    `SELECT
       (SELECT count(*)::integer
          FROM service_configuration_operation_requests) AS requests,
       (SELECT count(*)::integer
          FROM service_configuration_secret_envelopes) AS envelopes,
       (SELECT count(*)::integer FROM audit_events) AS audits`,
  );
  assert.deepEqual(overlapWrites.rows[0], beforeOverlapWrites.rows[0]);
  const customerKey = `customer-${randomUUID()}`;
  const customerCreatedResponse = await coreApp.inject({
    method: "POST",
    url: `/api/v1/services/${customerServiceId}/password-changes`,
    headers: cookie(fixture.customer),
    payload: requestBody(plaintexts[0], customerKey),
  });
  assert.equal(customerCreatedResponse.statusCode, 201, customerCreatedResponse.body);
  assert.equal(customerCreatedResponse.body.includes(plaintexts[0]), false);
  const customerCreated = customerCreatedResponse.json() as CreatedPasswordChange;
  assert.equal(customerCreated.status, "queued");
  assert.equal(customerCreated.replayed, false);

  const customerReplay = await coreApp.inject({
    method: "POST",
    url: `/api/v1/services/${customerServiceId}/password-changes`,
    headers: cookie(fixture.customer),
    payload: requestBody(plaintexts[0], customerKey),
  });
  assert.equal(customerReplay.statusCode, 200, customerReplay.body);
  assert.equal((customerReplay.json() as CreatedPasswordChange).requestId, customerCreated.requestId);
  assert.equal((customerReplay.json() as CreatedPasswordChange).replayed, true);

  const changedReplay = await coreApp.inject({
    method: "POST",
    url: `/api/v1/services/${customerServiceId}/password-changes`,
    headers: cookie(fixture.customer),
    payload: requestBody(`${"X".repeat(18)}!029`, customerKey),
  });
  assert.equal(changedReplay.statusCode, 409, changedReplay.body);
  assert.equal((changedReplay.json() as { code: string }).code, "IDEMPOTENCY_CONFLICT");
  await assertNoPlaintext(pool, plaintexts);

  let releaseMutation!: () => void;
  let markMutationStarted!: () => void;
  const mutationGate = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  const mutationStarted = new Promise<void>((resolve) => {
    markMutationStarted = resolve;
  });
  mutationBarrierApp = Fastify({ logger: false });
  mutationBarrierApp.post(
    "/v1alpha1/provisioning/operations",
    async (request, reply) => {
      markMutationStarted();
      await mutationGate;
      if (!providerApp) throw new Error("Mock mutation barrier lost its target app");
      const forwarded = await providerApp.inject({
        method: "POST",
        url: request.url,
        headers: {
          "content-type": "application/json",
          "idempotency-key": String(request.headers["idempotency-key"] ?? ""),
          "x-oss-lab-scenario": String(request.headers["x-oss-lab-scenario"] ?? "normal"),
        },
        payload: JSON.stringify(request.body),
      });
      return reply
        .code(forwarded.statusCode)
        .headers(forwarded.headers)
        .send(forwarded.body);
    },
  );
  const mutationBarrierUrl = await mutationBarrierApp.listen({ host: "127.0.0.1", port: 0 });
  const customerRuntime = runtime(mutationBarrierUrl, "normal");
  const customerJob = await claimJob(
    pool,
    customerCreated.requestId,
    "service.password_change.start",
    customerRuntime.workerId,
  );
  const customerDispatch = worker.processServicePasswordChangeStart(
    pool,
    customerJob,
    customerRuntime,
  );
  await mutationStarted;
  const inFlightSchema = await assertSchemaCompatible(pool);
  assert.equal(inFlightSchema.mode, "native");
  const inFlightState = await pool.query<{
    status: string;
    ciphertext_present: boolean;
    mutation_count: number;
    job_status: string;
  }>(
    `SELECT result.status,
            envelope.ciphertext IS NOT NULL AS ciphertext_present,
            (SELECT count(*)::integer
               FROM service_configuration_operation_attempts attempt
              WHERE attempt.request_id = request.id
                AND attempt.attempt_kind = 'mutation') AS mutation_count,
            job.status AS job_status
       FROM service_configuration_operation_requests request
       JOIN service_configuration_secret_envelopes envelope
         ON envelope.request_id = request.id
       JOIN service_configuration_operation_result_facts result
         ON result.request_id = request.id
       JOIN durable_jobs job
         ON job.job_type = 'service.password_change.start'
        AND job.payload->>'requestId' = request.id::text
      WHERE request.id = $1
      ORDER BY result.revision DESC
      LIMIT 1`,
    [customerCreated.requestId],
  );
  assert.deepEqual(inFlightState.rows[0], {
    status: "running",
    ciphertext_present: true,
    mutation_count: 1,
    job_status: "running",
  });
  releaseMutation();
  await customerDispatch;
  await mutationBarrierApp.close();
  mutationBarrierApp = null;
  const customerSaved = await pool.query<{
    result_status: string;
    ciphertext: string | null;
    destroyed_at: Date | null;
    request_json: Record<string, unknown>;
    create_calls: number;
  }>(
    `SELECT result.status AS result_status, envelope.ciphertext, envelope.destroyed_at,
            mock.request_json, mock.create_calls
       FROM service_configuration_operation_requests request
       JOIN service_configuration_secret_envelopes envelope ON envelope.request_id = request.id
       JOIN service_configuration_operation_result_facts result ON result.request_id = request.id
       JOIN provider_operations operation
         ON operation.subject_type = 'service_configuration_operation'
        AND operation.subject_id = request.id
       JOIN mock_contract_operations mock ON mock.operation_id = operation.id
      WHERE request.id = $1 AND result.status = 'succeeded'`,
    [customerCreated.requestId],
  );
  assert.equal(customerSaved.rowCount, 1);
  assert.equal(customerSaved.rows[0]!.ciphertext, null);
  assert.ok(customerSaved.rows[0]!.destroyed_at);
  assert.equal(customerSaved.rows[0]!.create_calls, 1);
  assert.equal(
    ((customerSaved.rows[0]!.request_json.input as { configuration: { password: string } })
      .configuration.password),
    "[REDACTED]",
  );

  const customerList = await coreApp.inject({
    method: "GET",
    url: `/api/v1/services/${customerServiceId}/password-changes`,
    headers: cookie(fixture.customer),
  });
  assert.equal(customerList.statusCode, 200, customerList.body);
  const customerListBody = customerList.json() as { items: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(customerListBody.items[0]!).sort(), [
    "action",
    "createdAt",
    "requestId",
    "revision",
    "status",
    "updatedAt",
  ]);
  assert.equal(customerList.body.includes(plaintexts[0]), false);

  const staffKey = `staff-${randomUUID()}`;
  const staffCreatedResponse = await coreApp.inject({
    method: "POST",
    url: `/api/v1/admin/client-accounts/${fixture.customer.accountId}/services/${staffServiceId}/password-changes`,
    headers: cookie(fixture.staff),
    payload: requestBody(
      plaintexts[1],
      staffKey,
      "Customer requested a synthetic Mock-only password rotation",
    ),
  });
  assert.equal(staffCreatedResponse.statusCode, 201, staffCreatedResponse.body);
  assert.equal(staffCreatedResponse.body.includes(plaintexts[1]), false);
  const staffCreated = staffCreatedResponse.json() as CreatedPasswordChange;
  const staffRuntime = runtime(providerUrl, "normal");
  const staffJob = await claimJob(
    pool,
    staffCreated.requestId,
    "service.password_change.start",
    staffRuntime.workerId,
  );
  await worker.processServicePasswordChangeStart(pool, staffJob, staffRuntime);
  const staffList = await coreApp.inject({
    method: "GET",
    url: `/api/v1/admin/client-accounts/${fixture.customer.accountId}/services/${staffServiceId}/password-changes`,
    headers: cookie(fixture.staff),
  });
  assert.equal(staffList.statusCode, 200, staffList.body);
  assert.equal(staffList.body.includes(plaintexts[1]), false);
  assert.equal((staffList.json() as { items: Array<{ status: string }> }).items[0]!.status, "succeeded");

  const revokedKey = `revoked-${randomUUID()}`;
  const revokedCreatedResponse = await coreApp.inject({
    method: "POST",
    url: `/api/v1/services/${revokedServiceId}/password-changes`,
    headers: cookie(fixture.customer),
    payload: requestBody(plaintexts[2], revokedKey),
  });
  assert.equal(revokedCreatedResponse.statusCode, 201, revokedCreatedResponse.body);
  const revokedCreated = revokedCreatedResponse.json() as CreatedPasswordChange;
  await pool.query(
    `UPDATE reauth_grants
        SET invalidated_at = clock_timestamp()
      WHERE user_id = $1 AND session_id = $2 AND invalidated_at IS NULL`,
    [fixture.customer.userId, fixture.customer.sessionId],
  );
  const revokedReplay = await coreApp.inject({
    method: "POST",
    url: `/api/v1/services/${revokedServiceId}/password-changes`,
    headers: cookie(fixture.customer),
    payload: requestBody(plaintexts[2], revokedKey),
  });
  assert.equal(revokedReplay.statusCode, 403, revokedReplay.body);
  assert.equal((revokedReplay.json() as { code: string }).code, "REAUTH_REQUIRED");
  const revokedRequestCount = await pool.query<{ count: number }>(
    `SELECT count(*)::integer AS count
       FROM service_configuration_operation_requests
      WHERE idempotency_key = $1`,
    [revokedKey],
  );
  assert.equal(revokedRequestCount.rows[0]?.count, 1);
  const revokedRuntime = runtime(providerUrl, "normal");
  const revokedJob = await claimJob(
    pool,
    revokedCreated.requestId,
    "service.password_change.start",
    revokedRuntime.workerId,
  );
  await worker.processServicePasswordChangeStart(pool, revokedJob, revokedRuntime);
  const revokedSaved = await pool.query<{
    status: string;
    ciphertext: string | null;
    provider_rows: number;
  }>(
    `SELECT result.status, envelope.ciphertext,
            (SELECT count(*)::integer FROM mock_contract_operations mock
              JOIN provider_operations operation ON operation.id = mock.operation_id
             WHERE operation.subject_id = request.id) AS provider_rows
       FROM service_configuration_operation_requests request
       JOIN service_configuration_secret_envelopes envelope ON envelope.request_id = request.id
       JOIN service_configuration_operation_result_facts result ON result.request_id = request.id
      WHERE request.id = $1`,
    [revokedCreated.requestId],
  );
  assert.deepEqual(revokedSaved.rows[0], {
    status: "failed",
    ciphertext: null,
    provider_rows: 0,
  });

  await pool.query(
    `INSERT INTO reauth_grants(user_id, session_id, expires_at)
     VALUES ($1, $2, now() + interval '10 minutes')`,
    [fixture.customer.userId, fixture.customer.sessionId],
  );
  const timeoutCreatedResponse = await coreApp.inject({
    method: "POST",
    url: `/api/v1/services/${timeoutServiceId}/password-changes`,
    headers: cookie(fixture.customer),
    payload: requestBody(plaintexts[3], `timeout-${randomUUID()}`),
  });
  assert.equal(timeoutCreatedResponse.statusCode, 201, timeoutCreatedResponse.body);
  const timeoutCreated = timeoutCreatedResponse.json() as CreatedPasswordChange;
  const timeoutRuntime = runtime(providerUrl, "timeout");
  const timeoutJob = await claimJob(
    pool,
    timeoutCreated.requestId,
    "service.password_change.start",
    timeoutRuntime.workerId,
  );
  await worker.processServicePasswordChangeStart(pool, timeoutJob, timeoutRuntime);
  const unknown = await pool.query<{ status: string; ciphertext: string | null }>(
    `SELECT result.status, envelope.ciphertext
       FROM service_configuration_operation_result_facts result
       JOIN service_configuration_secret_envelopes envelope ON envelope.request_id = result.request_id
      WHERE result.request_id = $1 ORDER BY result.revision DESC LIMIT 1`,
    [timeoutCreated.requestId],
  );
  assert.deepEqual(unknown.rows[0], { status: "unknown", ciphertext: null });
  await pool.query(
    `UPDATE durable_jobs SET available_at = clock_timestamp()
      WHERE job_type = 'service.password_change.reconcile'
        AND payload->>'requestId' = $1`,
    [timeoutCreated.requestId],
  );
  let releaseReconcileGet!: () => void;
  let markReconcileGetStarted!: () => void;
  const reconcileGetGate = new Promise<void>((resolve) => {
    releaseReconcileGet = resolve;
  });
  const reconcileGetStarted = new Promise<void>((resolve) => {
    markReconcileGetStarted = resolve;
  });
  const reconcileQueryIdentities: string[] = [];
  reconcileBarrierApp = Fastify({ logger: false });
  let firstBarrierRequest = true;
  reconcileBarrierApp.get(
    "/v1alpha1/provisioning/operations/:operationId",
    async (request, reply) => {
      const identity = request.headers["x-oss-reconcile-query-id"];
      if (typeof identity === "string") reconcileQueryIdentities.push(identity);
      if (firstBarrierRequest) {
        firstBarrierRequest = false;
        markReconcileGetStarted();
        await reconcileGetGate;
      }
      if (!providerApp) throw new Error("Mock Provider barrier lost its target app");
      const forwarded = await providerApp.inject({
        method: "GET",
        url: request.url,
      });
      return reply
        .code(forwarded.statusCode)
        .headers(forwarded.headers)
        .send(forwarded.body);
    },
  );
  const reconcileBarrierUrl = await reconcileBarrierApp.listen({ host: "127.0.0.1", port: 0 });
  const reconcileRuntime = runtime(reconcileBarrierUrl, "normal");
  const reconcileJob = await claimJob(
    pool,
    timeoutCreated.requestId,
    "service.password_change.reconcile",
    reconcileRuntime.workerId,
  );
  const interruptedReconcile = worker.processServicePasswordChangeReconcile(
    pool,
    reconcileJob,
    reconcileRuntime,
  );
  await reconcileGetStarted;
  const inFlightQuery = await pool.query<{
    query_count: number;
    outstanding_count: number;
  }>(
    `SELECT count(*)::integer AS query_count,
            count(*) FILTER (WHERE observation.id IS NULL)::integer AS outstanding_count
       FROM service_configuration_operation_attempts attempt
       LEFT JOIN service_configuration_operation_result_facts observation
         ON observation.reconcile_attempt_id = attempt.id
      WHERE attempt.request_id = $1
        AND attempt.attempt_kind = 'reconcile_query'`,
    [timeoutCreated.requestId],
  );
  assert.deepEqual(inFlightQuery.rows[0], { query_count: 1, outstanding_count: 1 });
  const recovered = await worker.recoverStaleServicePasswordChangeJobs(pool, {
    ...reconcileRuntime,
    staleLockSeconds: 0,
  });
  assert.equal(recovered, 1);
  releaseReconcileGet();
  await assert.rejects(interruptedReconcile, /lease was lost/);

  const resumedRuntime = runtime(reconcileBarrierUrl, "normal");
  const resumedJob = await claimJob(
    pool,
    timeoutCreated.requestId,
    "service.password_change.reconcile",
    resumedRuntime.workerId,
  );
  await worker.processServicePasswordChangeReconcile(pool, resumedJob, resumedRuntime);
  const reconciled = await pool.query<{
    status: string;
    create_calls: number;
    reconcile_calls: number;
    ciphertext: string | null;
  }>(
    `SELECT result.status, mock.create_calls, mock.reconcile_calls, envelope.ciphertext
       FROM service_configuration_operation_result_facts result
       JOIN service_configuration_secret_envelopes envelope ON envelope.request_id = result.request_id
       JOIN provider_operations operation
         ON operation.subject_type = 'service_configuration_operation'
        AND operation.subject_id = result.request_id
       JOIN mock_contract_operations mock ON mock.operation_id = operation.id
      WHERE result.request_id = $1
      ORDER BY result.revision DESC LIMIT 1`,
    [timeoutCreated.requestId],
  );
  assert.deepEqual(reconciled.rows[0], {
    status: "succeeded",
    create_calls: 1,
    reconcile_calls: 2,
    ciphertext: null,
  });
  const reconcileBudget = await pool.query<{
    query_count: number;
    observed_count: number;
    job_attempts: number;
  }>(
    `SELECT
       (SELECT count(*)::integer
          FROM service_configuration_operation_attempts attempt
         WHERE attempt.request_id = $1
           AND attempt.attempt_kind = 'reconcile_query') AS query_count,
       (SELECT count(*)::integer
          FROM service_configuration_operation_result_facts result
         WHERE result.request_id = $1
           AND result.reconcile_attempt_id IS NOT NULL) AS observed_count,
       (SELECT attempts
         FROM durable_jobs job
         WHERE job.job_type = 'service.password_change.reconcile'
           AND job.payload->>'requestId' = $1::text) AS job_attempts`,
    [timeoutCreated.requestId],
  );
  assert.deepEqual(reconcileBudget.rows[0], {
    query_count: 1,
    observed_count: 1,
    job_attempts: 2,
  });
  assert.equal(reconcileQueryIdentities.length, 2);
  assert.equal(reconcileQueryIdentities[0], reconcileQueryIdentities[1]);

  const exhaustedCreatedResponse = await coreApp.inject({
    method: "POST",
    url: `/api/v1/services/${exhaustedServiceId}/password-changes`,
    headers: cookie(fixture.customer),
    payload: requestBody(plaintexts[6], `exhausted-${randomUUID()}`),
  });
  assert.equal(exhaustedCreatedResponse.statusCode, 201, exhaustedCreatedResponse.body);
  const exhaustedCreated = exhaustedCreatedResponse.json() as CreatedPasswordChange;
  const exhaustedStartRuntime = {
    ...runtime(providerUrl, "timeout"),
    reconcileBaseDelaySeconds: 0,
  } as const;
  const exhaustedStartJob = await claimJob(
    pool,
    exhaustedCreated.requestId,
    "service.password_change.start",
    exhaustedStartRuntime.workerId,
  );
  await worker.processServicePasswordChangeStart(pool, exhaustedStartJob, exhaustedStartRuntime);

  let exhaustionGetCalls = 0;
  const exhaustionQueryIdentities: string[] = [];
  reconcileExhaustionApp = Fastify({ logger: false });
  reconcileExhaustionApp.get(
    "/v1alpha1/provisioning/operations/:operationId",
    async (request, reply) => {
      exhaustionGetCalls += 1;
      const queryIdentity = request.headers["x-oss-reconcile-query-id"];
      if (typeof queryIdentity === "string") exhaustionQueryIdentities.push(queryIdentity);
      return reply.code(503).send({ error: "synthetic normal reconciliation unavailable" });
    },
  );
  const exhaustionUrl = await reconcileExhaustionApp.listen({ host: "127.0.0.1", port: 0 });
  const exhaustionRuntime = {
    ...runtime(exhaustionUrl, "normal"),
    reconcileBaseDelaySeconds: 0,
    reconcileMaxAttempts: 3,
  } as const;
  for (let attempt = 0; attempt < exhaustionRuntime.reconcileMaxAttempts; attempt += 1) {
    const queryJob = await claimJob(
      pool,
      exhaustedCreated.requestId,
      "service.password_change.reconcile",
      exhaustionRuntime.workerId,
    );
    await worker.processServicePasswordChangeReconcile(pool, queryJob, exhaustionRuntime);
  }
  const exhaustBudgetJob = await claimJob(
    pool,
    exhaustedCreated.requestId,
    "service.password_change.reconcile",
    exhaustionRuntime.workerId,
  );
  await worker.processServicePasswordChangeReconcile(pool, exhaustBudgetJob, exhaustionRuntime);
  assert.equal(exhaustionGetCalls, 3);
  assert.equal(exhaustionQueryIdentities.length, 3);
  assert.equal(new Set(exhaustionQueryIdentities).size, 3);
  const exhaustedProjection = await pool.query<{
    result_status: string;
    error_code: string;
    operation_status: string;
    query_count: number;
    observed_count: number;
    job_status: string;
    job_attempts: number;
    ciphertext: string | null;
  }>(
    `SELECT latest.status AS result_status, latest.error_code,
            operation.status AS operation_status,
            (SELECT count(*)::integer
               FROM service_configuration_operation_attempts attempt
              WHERE attempt.request_id = request.id
                AND attempt.attempt_kind = 'reconcile_query') AS query_count,
            (SELECT count(*)::integer
               FROM service_configuration_operation_result_facts result
              WHERE result.request_id = request.id
                AND result.reconcile_attempt_id IS NOT NULL) AS observed_count,
            job.status AS job_status, job.attempts AS job_attempts, envelope.ciphertext
       FROM service_configuration_operation_requests request
       JOIN service_configuration_secret_envelopes envelope
         ON envelope.request_id = request.id
       JOIN LATERAL (
         SELECT result.status, result.error_code
         FROM service_configuration_operation_result_facts result
         WHERE result.request_id = request.id
         ORDER BY result.revision DESC LIMIT 1
       ) latest ON true
       JOIN durable_jobs job
        ON job.job_type = 'service.password_change.reconcile'
        AND job.payload->>'requestId' = request.id::text
       JOIN provider_operations operation
         ON operation.subject_type = 'service_configuration_operation'
        AND operation.subject_id = request.id
      WHERE request.id = $1`,
    [exhaustedCreated.requestId],
  );
  assert.deepEqual(exhaustedProjection.rows[0], {
    result_status: "manual",
    error_code: "reconcile_exhausted",
    operation_status: "unknown",
    query_count: 3,
    observed_count: 3,
    job_status: "manual",
    job_attempts: 4,
    ciphertext: null,
  });
  assert.equal((await assertSchemaCompatible(pool)).mode, "native");
  await reconcileExhaustionApp.close();
  reconcileExhaustionApp = null;

  await assertNoPlaintext(pool, plaintexts);
  const history = await pool.query<{
    password_change_count: number;
    plaintext_job_payloads: number;
    redacted_provider_requests: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM service_configuration_operation_requests)
         AS password_change_count,
       (SELECT count(*)::integer FROM durable_jobs
         WHERE job_type LIKE 'service.password_change.%'
           AND EXISTS (
             SELECT 1 FROM jsonb_object_keys(payload) key
             WHERE key ~* '(password|secret|credential|cipher|digest)'
           )) AS plaintext_job_payloads,
       (SELECT count(*)::integer FROM mock_contract_operations
         WHERE action = 'resource.change_password'
           AND request_json #>> '{input,configuration,password}' = '[REDACTED]')
         AS redacted_provider_requests`,
  );
  assert.deepEqual(history.rows[0], {
    password_change_count: 5,
    plaintext_job_payloads: 0,
    redacted_provider_requests: 5,
  });

  console.log(
    "Service password-change PostgreSQL 18 normal integration: PASS — Customer and Staff fresh-reauth requests, locked replay authorization, durable-field secret rejection, keyed idempotency, Worker memory-only dispatch, in-flight native startup, restart-safe GET identity reuse, bounded no-GET exhaustion to manual, retained-key Mock replay, missing-key zero-write refusal, redaction, and plaintext exclusion all held.",
  );
} finally {
  if (coreApp) await coreApp.close().catch(() => undefined);
  if (rotatedProviderApp) await rotatedProviderApp.close().catch(() => undefined);
  if (missingFingerprintKeyProviderApp) {
    await missingFingerprintKeyProviderApp.close().catch(() => undefined);
  }
  if (mutationBarrierApp) await mutationBarrierApp.close().catch(() => undefined);
  if (reconcileBarrierApp) await reconcileBarrierApp.close().catch(() => undefined);
  if (reconcileExhaustionApp) await reconcileExhaustionApp.close().catch(() => undefined);
  if (providerApp) await providerApp.close().catch(() => undefined);
  if (providerPool) await providerPool.end().catch(() => undefined);
  if (pool) await pool.end().catch(() => undefined);
  if ((admin as unknown as { _connected?: boolean })._connected) {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName],
    ).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`).catch(() => undefined);
  }
  await admin.end().catch(() => undefined);
}
