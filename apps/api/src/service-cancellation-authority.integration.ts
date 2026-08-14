// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify, {
  type FastifyError,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import pg from "pg";
import { digestToken } from "./auth.js";
import type { Config } from "./config.js";
import { runMigrations, transaction, type DatabasePool } from "./database.js";
import { registerServiceRoutes } from "./routes-services.js";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) {
  throw new Error(
    "ADMIN_DATABASE_URL is required for Service Cancellation Authority integration",
  );
}

const databaseName = `oss_service_cancellation_authority_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = new URL(adminDatabaseUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = new pg.Client({ connectionString: adminDatabaseUrl });
let pool: DatabasePool | null = null;
let app: ReturnType<typeof Fastify> | null = null;

const config: Config = {
  DATABASE_URL: databaseUrl.toString(),
  OSS_ENV: "test",
  OSS_LOG_LEVEL: "silent",
  OSS_PUBLIC_URL: "http://127.0.0.1:3000",
  API_HOST: "127.0.0.1",
  API_PORT: 3000,
  GLOBAL_RATE_LIMIT_MAX: 10_000,
  SESSION_COOKIE_NAME: "oss_service_cancellation_authority_session",
  SESSION_TTL_HOURS: 24,
  VERIFICATION_TTL_MINUTES: 30,
  WEB_ORIGIN: "http://127.0.0.1:5173",
  MOCK_MAILBOX_URL: "http://127.0.0.1:4000",
  LAB_MAILBOX_TOKEN: "synthetic-cancellation-mailbox-token-000000",
  PROVIDER_OPERATION_CAPABILITY_SECRET:
    "synthetic-cancellation-provider-capability-secret",
  PAYMENT_METHOD_TOKEN_KEY: Buffer.alloc(32, 81).toString("base64url"),
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY: Buffer.alloc(32, 82).toString("base64url"),
  IDENTITY_SECRET_KEY: Buffer.alloc(32, 83).toString("base64url"),
  MOCK_PAYMENT_WEBHOOK_SECRET: "synthetic-cancellation-payment-hook-0000000",
  MOCK_PROVISIONING_WEBHOOK_SECRET:
    "synthetic-cancellation-provision-hook-0000",
  LAB_MAILBOX_ENABLED: false,
};

type CustomerActor = Readonly<{
  userId: string;
  sessionId: string;
  token: string;
  accountId: string;
  contextVersion: string;
}>;

type CustomerAccount = Readonly<{
  accountId: string;
  owner: CustomerActor;
  technical: CustomerActor;
  billing: CustomerActor;
  explicit: CustomerActor;
  wildcard: CustomerActor;
}>;

type StaffActor = Readonly<{
  userId: string;
  sessionId: string;
  token: string;
  unrelatedAccountId: string;
}>;

type ServiceFixture = Readonly<{
  serviceId: string;
  version: number;
}>;

type ManualFixture = Readonly<{
  serviceId: string;
  executionId: string;
  executionVersion: number;
  serviceVersion: number;
  targetAccountId: string;
}>;

type ScheduledCancellation = Readonly<{
  cancellation: {
    requestId: string;
    executionMode: "automatic" | "manual";
    effectiveAt: string;
  };
  serviceVersion: number;
  replayed: boolean;
}>;

function json<T>(response: Readonly<{ body: string }>): T {
  return JSON.parse(response.body) as T;
}

function pgCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
}

async function expectPgRejection(
  work: () => Promise<unknown>,
  code: string,
  message: RegExp,
): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    assert.equal(pgCode(error), code);
    assert.ok(error instanceof Error);
    assert.match(error.message, message);
    return true;
  });
}

async function ensureFoundation(database: DatabasePool): Promise<void> {
  await transaction(database, async (client) => {
    await client.query(
      `INSERT INTO public.product_groups(id, sort_order, names)
       VALUES ('service-cancellation-authority-integration', 999,
               '{"en":"Cancellation authority integration","zh-CN":"取消授权集成"}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO public.products(
         id, group_id, names, descriptions, fulfillment_mode, active, hidden,
         repeatable, option_schema
       ) VALUES (
         'service-cancellation-authority-integration',
         'service-cancellation-authority-integration',
         '{"en":"Synthetic cancellation authority","zh-CN":"合成取消授权"}'::jsonb,
         '{"en":"Mock-only integration fixture","zh-CN":"仅 Mock 集成夹具"}'::jsonb,
         'automatic', true, true, true, '[]'::jsonb
       ) ON CONFLICT (id) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO public.provider_installation_capabilities(
         provider_installation_id, provider_type, enabled, capabilities
       ) VALUES (
         'mock-provisioning-v1', 'provisioning', true,
         '["resource_create","resource_reconcile","resource_suspend","resource_resume","resource_terminate","resource.start","resource.stop","resource.reboot"]'::jsonb
       )
       ON CONFLICT (provider_installation_id) DO UPDATE
       SET enabled = true,
           capabilities = EXCLUDED.capabilities,
           version = public.provider_installation_capabilities.version + 1,
           updated_at = pg_catalog.clock_timestamp()`,
    );
    await client.query(
      `INSERT INTO public.product_service_automation_policies(
         product_id, overdue_action, provider_installation_id,
         overdue_delay_mode, overdue_delay_value, version,
         cycle_end_cancellation_mode, cycle_end_cancellation_execution_mode,
         cycle_end_cancellation_min_notice_hours,
         cycle_end_cancellation_requirement_key
       ) VALUES (
         'service-cancellation-authority-integration', 'automatic',
         'mock-provisioning-v1', 'policy_calendar_days', 5, 1,
         'self_service', 'automatic', 0, NULL
       ) ON CONFLICT (product_id) DO NOTHING`,
    );
  });
}

async function insertUser(
  client: pg.PoolClient,
  label: string,
): Promise<string> {
  const userId = randomUUID();
  await client.query(
    `INSERT INTO public.users(id, email, password_hash, locale, email_verified_at)
     VALUES ($1, $2, 'synthetic-not-a-password', 'en', pg_catalog.clock_timestamp())`,
    [userId, `cancellation-${label}-${userId}@example.invalid`],
  );
  return userId;
}

async function insertCustomerSession(
  client: pg.PoolClient,
  userId: string,
  accountId: string,
  ttlSeconds = 7_200,
): Promise<CustomerActor> {
  const sessionId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  await client.query(
    `INSERT INTO public.sessions(
       id, user_id, token_digest, expires_at,
       active_client_account_id, account_context_version
     ) VALUES (
       $1, $2, $3,
       pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => $5),
       $4, 1
     )`,
    [sessionId, userId, digestToken(token), accountId, ttlSeconds],
  );
  return { userId, sessionId, token, accountId, contextVersion: "1" };
}

async function createCustomerAccount(
  database: DatabasePool,
  label: string,
): Promise<CustomerAccount> {
  const accountId = randomUUID();
  return transaction(database, async (client) => {
    const ownerId = await insertUser(client, `${label}-owner`);
    const technicalId = await insertUser(client, `${label}-technical`);
    const billingId = await insertUser(client, `${label}-billing`);
    const explicitId = await insertUser(client, `${label}-explicit`);
    const wildcardId = await insertUser(client, `${label}-wildcard`);
    await client.query(
      `INSERT INTO public.client_accounts(id, name, owner_user_id)
       VALUES ($1, $2, $3)`,
      [accountId, `Synthetic cancellation ${label}`, ownerId],
    );
    const memberships: ReadonlyArray<readonly [string, string, readonly string[]]> = [
      [ownerId, "owner", []],
      [technicalId, "technical", []],
      [billingId, "billing", []],
      [explicitId, "viewer", ["services.manage"]],
      [wildcardId, "viewer", ["*"]],
    ];
    for (const [userId, role, permissions] of memberships) {
      await client.query(
        `INSERT INTO public.client_memberships(
           client_account_id, user_id, role, permissions
         ) VALUES ($1, $2, $3, $4::jsonb)`,
        [accountId, userId, role, JSON.stringify(permissions)],
      );
    }
    return {
      accountId,
      owner: await insertCustomerSession(client, ownerId, accountId),
      technical: await insertCustomerSession(client, technicalId, accountId),
      billing: await insertCustomerSession(client, billingId, accountId),
      explicit: await insertCustomerSession(client, explicitId, accountId),
      wildcard: await insertCustomerSession(client, wildcardId, accountId),
    };
  });
}

async function createCustomerActor(
  database: DatabasePool,
  accountId: string,
  label: string,
  role: "billing" | "technical" | "viewer",
  permissions: readonly string[] = [],
  ttlSeconds = 7_200,
): Promise<CustomerActor> {
  return transaction(database, async (client) => {
    const userId = await insertUser(client, label);
    await client.query(
      `INSERT INTO public.client_memberships(
         client_account_id, user_id, role, permissions
       ) VALUES ($1, $2, $3, $4::jsonb)`,
      [accountId, userId, role, JSON.stringify(permissions)],
    );
    return insertCustomerSession(client, userId, accountId, ttlSeconds);
  });
}

async function createCrossAccountStaff(
  database: DatabasePool,
  label: string,
  ttlSeconds = 7_200,
  reauthTtlSeconds = 600,
): Promise<StaffActor> {
  return transaction(database, async (client) => {
    const userId = await insertUser(client, `${label}-staff`);
    const unrelatedAccountId = randomUUID();
    await client.query(
      `INSERT INTO public.client_accounts(id, name, owner_user_id)
       VALUES ($1, $2, $3)`,
      [unrelatedAccountId, `Unrelated Staff-owned ${label}`, userId],
    );
    await client.query(
      `INSERT INTO public.client_memberships(
         client_account_id, user_id, role, permissions
       ) VALUES ($1, $2, 'owner', '[]'::jsonb)`,
      [unrelatedAccountId, userId],
    );
    const sessionId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    await client.query(
      `INSERT INTO public.sessions(
         id, user_id, token_digest, expires_at, account_context_version
       ) VALUES (
         $1, $2, $3,
         pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => $4), 0
       )`,
      [sessionId, userId, digestToken(token), ttlSeconds],
    );
    await client.query(
      `INSERT INTO public.staff_members(user_id, roles, permissions)
       VALUES (
         $1, ARRAY['ServiceOperations']::text[],
         '["services.read","services.manual_fulfillment"]'::jsonb
       )`,
      [userId],
    );
    await client.query(
      `INSERT INTO public.reauth_grants(user_id, session_id, expires_at)
       VALUES (
         $1, $2,
         pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => $3)
       )`,
      [userId, sessionId, reauthTtlSeconds],
    );
    return { userId, sessionId, token, unrelatedAccountId };
  });
}

async function createService(
  database: DatabasePool,
  actor: CustomerActor,
  label: string,
  termSeconds = 86_400,
): Promise<ServiceFixture> {
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const serviceId = randomUUID();
  await transaction(database, async (client) => {
    await client.query(
      `INSERT INTO public.orders(
         id, client_account_id, submitted_by_user_id, status, currency,
         price_snapshot, one_time_minor, setup_minor, recurring_minor,
         total_minor, idempotency_key, request_fingerprint
       ) VALUES (
         $1, $2, $3, 'completed', 'USD', '{}'::jsonb,
         0, 0, 100, 100, $4, $5
       )`,
      [
        orderId,
        actor.accountId,
        actor.userId,
        `cancellation-order-${orderId}`,
        createHash("sha256").update(orderId).digest("hex"),
      ],
    );
    await client.query(
      `INSERT INTO public.order_items(
         id, order_id, product_id, product_name, fulfillment_mode,
         billing_cycle, configuration, price_snapshot, client_account_id
       ) VALUES (
         $1, $2, 'service-cancellation-authority-integration',
         $3, 'automatic', 'monthly', '{}'::jsonb, '{}'::jsonb, $4
       )`,
      [orderItemId, orderId, `Synthetic ${label}`, actor.accountId],
    );
    await client.query(
      `INSERT INTO public.services(
         id, client_account_id, order_item_id, status, billing_cycle,
         external_resource_id, activated_at, term_start, term_end
       ) VALUES (
         $1, $2, $3, 'active', 'monthly', $4,
         pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
         pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => $5)
       )`,
      [serviceId, actor.accountId, orderItemId, `mock-${label}-${serviceId}`, termSeconds],
    );
    await client.query(
      `INSERT INTO public.service_provider_bindings(
         service_id, provider_installation_id, overdue_action_snapshot,
         capability_snapshot, product_policy_version,
         cycle_end_cancellation_mode_snapshot,
         cycle_end_cancellation_execution_mode_snapshot,
         cycle_end_cancellation_min_notice_hours_snapshot,
         cycle_end_cancellation_requirement_key_snapshot
       )
       SELECT $1, policy.provider_installation_id, policy.overdue_action,
              provider.capabilities, policy.version,
              policy.cycle_end_cancellation_mode,
              policy.cycle_end_cancellation_execution_mode,
              policy.cycle_end_cancellation_min_notice_hours,
              policy.cycle_end_cancellation_requirement_key
       FROM public.product_service_automation_policies policy
       JOIN public.provider_installation_capabilities provider
         ON provider.provider_installation_id = policy.provider_installation_id
       WHERE policy.product_id = 'service-cancellation-authority-integration'`,
      [serviceId],
    );
  });
  const service = await database.query<{ version: number }>(
    "SELECT version FROM public.services WHERE id = $1",
    [serviceId],
  );
  assert.equal(service.rowCount, 1);
  return { serviceId, version: service.rows[0]!.version };
}

function customerHeaders(actor: CustomerActor): Record<string, string> {
  return {
    cookie: `${config.SESSION_COOKIE_NAME}=${actor.token}`,
    "x-oss-account-context-version": actor.contextVersion,
  };
}

function staffHeaders(actor: StaffActor): Record<string, string> {
  return { cookie: `${config.SESSION_COOKIE_NAME}=${actor.token}` };
}

async function schedule(
  server: ReturnType<typeof Fastify>,
  actor: CustomerActor,
  service: ServiceFixture,
  expectedStatus = 201,
) {
  const response = await server.inject({
    method: "POST",
    url: `/api/v1/services/${service.serviceId}/cancellation`,
    headers: customerHeaders(actor),
    payload: {
      expectedVersion: service.version,
      reason: "Synthetic cycle-end cancellation authority verification",
      idempotencyKey: `cancel-${randomUUID()}`,
    },
  });
  assert.equal(response.statusCode, expectedStatus, response.body);
  return response;
}

async function setProviderEnabled(database: DatabasePool, enabled: boolean): Promise<void> {
  await database.query(
    `UPDATE public.provider_installation_capabilities
     SET enabled = $1, version = version + 1,
         updated_at = pg_catalog.clock_timestamp()
     WHERE provider_installation_id = 'mock-provisioning-v1'`,
    [enabled],
  );
}

async function prepareManualFixture(
  server: ReturnType<typeof Fastify>,
  database: DatabasePool,
  owner: CustomerActor,
  label: string,
  termSeconds = 2,
): Promise<ManualFixture> {
  const service = await createService(database, owner, label, termSeconds);
  await setProviderEnabled(database, false);
  let response;
  try {
    response = await schedule(server, owner, service);
  } finally {
    await setProviderEnabled(database, true);
  }
  const scheduled = json<ScheduledCancellation>(response!);
  assert.equal(scheduled.cancellation.executionMode, "manual");
  await waitPast(new Date(scheduled.cancellation.effectiveAt));
  const execution = await database.query<{
    execution_id: string;
    execution_version: number;
    service_version: number;
  }>(
    `UPDATE public.service_cancellation_executions execution
     SET status = 'manual',
         result = '{"status":"manual","interventionRequired":true}'::jsonb,
         last_error = 'synthetic due cancellation entered manual queue',
         updated_at = pg_catalog.clock_timestamp(),
         version = execution.version + 1
     FROM public.services service
     WHERE execution.cancellation_request_id = $1
       AND service.id = execution.service_id
       AND execution.status = 'scheduled'
     RETURNING execution.id AS execution_id,
               execution.version AS execution_version,
               service.version AS service_version`,
    [scheduled.cancellation.requestId],
  );
  assert.equal(execution.rowCount, 1);
  await database.query(
    `UPDATE public.durable_jobs
     SET status = 'manual',
         last_error = 'synthetic due cancellation entered manual queue',
         updated_at = pg_catalog.clock_timestamp()
     WHERE job_type = 'service.cancellation.due'
       AND payload->>'cancellationRequestId' = $1`,
    [scheduled.cancellation.requestId],
  );
  return {
    serviceId: service.serviceId,
    executionId: execution.rows[0]!.execution_id,
    executionVersion: execution.rows[0]!.execution_version,
    serviceVersion: execution.rows[0]!.service_version,
    targetAccountId: owner.accountId,
  };
}

async function waitPast(timestamp: Date): Promise<void> {
  const delay = timestamp.getTime() - Date.now() + 150;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

async function waitUntilBlocked(
  database: DatabasePool,
  blockerPid: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await database.query<{ blocked: boolean }>(
      `SELECT pg_catalog.bool_or(
                $1::integer = ANY(pg_catalog.pg_blocking_pids(activity.pid))
              ) AS blocked
       FROM pg_catalog.pg_stat_activity activity
       WHERE activity.datname = pg_catalog.current_database()`,
      [blockerPid],
    );
    if (result.rows[0]?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function rawCancellationRequest(
  client: pg.PoolClient,
  actor: CustomerActor,
  serviceId: string,
): Promise<void> {
  const source = await client.query<{
    term_end: Date;
    version: number;
    product_policy_version: number;
    scheduling_mode: string;
    execution_mode: string;
    minimum_notice_hours: number;
    requirement_key: string | null;
  }>(
    `SELECT service.term_end,
            service.version,
            binding.product_policy_version,
            binding.cycle_end_cancellation_mode_snapshot AS scheduling_mode,
            binding.cycle_end_cancellation_execution_mode_snapshot AS execution_mode,
            binding.cycle_end_cancellation_min_notice_hours_snapshot AS minimum_notice_hours,
            binding.cycle_end_cancellation_requirement_key_snapshot AS requirement_key
     FROM public.services service
     JOIN public.service_provider_bindings binding ON binding.service_id = service.id
     WHERE service.id = $1`,
    [serviceId],
  );
  assert.equal(source.rowCount, 1);
  const row = source.rows[0]!;
  const recordedAt = new Date();
  await client.query(
    `INSERT INTO public.service_cancellation_requests(
       id, service_id, client_account_id, requested_by_user_id,
       requested_session_id, effective_at, expected_service_version,
       product_policy_version, policy_snapshot, notice_qualified_at,
       authorization_ticket_id, reason, idempotency_key,
       request_fingerprint, result, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       NULL, 'Synthetic raw cancellation authority rejection', $11,
       $12, '{"status":"scheduled"}'::jsonb, $10
     )`,
    [
      randomUUID(),
      serviceId,
      actor.accountId,
      actor.userId,
      actor.sessionId,
      row.term_end,
      row.version,
      row.product_policy_version,
      {
        schedulingMode: row.scheduling_mode,
        executionMode: row.execution_mode,
        minimumNoticeHours: row.minimum_notice_hours,
        requirementKey: row.requirement_key,
      },
      recordedAt,
      `raw-${randomUUID()}`,
      createHash("sha256").update(randomUUID()).digest("hex"),
    ],
  );
}

async function rawManualAction(
  client: pg.PoolClient,
  staff: StaffActor,
  fixture: ManualFixture,
  targetAccountId = fixture.targetAccountId,
): Promise<void> {
  const actionId = randomUUID();
  await client.query(
    `INSERT INTO public.service_cancellation_manual_actions(
       id, execution_id, service_id, staff_user_id, staff_session_id,
       staff_client_account_id, takeover_kind, expected_execution_version,
       expected_service_version, reason, idempotency_key,
       request_fingerprint, result
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'manual_delivery', $7, $8,
       'Synthetic raw manual cancellation authority verification',
       $9, $10, $11
     )`,
    [
      actionId,
      fixture.executionId,
      fixture.serviceId,
      staff.userId,
      staff.sessionId,
      targetAccountId,
      fixture.executionVersion,
      fixture.serviceVersion,
      `manual-${randomUUID()}`,
      createHash("sha256").update(actionId).digest("hex"),
      {
        actionId,
        executionId: fixture.executionId,
        serviceId: fixture.serviceId,
        executionStatus: "terminated",
        serviceStatus: "terminated",
        takeoverKind: "manual_delivery",
        providerCalled: false,
      },
    ],
  );
}

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  pool = new pg.Pool({
    connectionString: databaseUrl.toString(),
    max: 18,
    options: "-c search_path=pg_catalog,public",
    statement_timeout: 15_000,
    application_name: "opensales-service-cancellation-authority-integration",
  });

  // Prove this is a forward upgrade over a populated Schema 025 database, not
  // a rewrite of the historical 014 migration or an empty-only fixture.
  await runMigrations(pool, { throughVersion: "025_stage_c_content_operations" });
  await ensureFoundation(pool);
  const account = await createCustomerAccount(pool, `saved-025-${randomUUID()}`);
  const savedService = await createService(pool, account.owner, "saved-schema-025");
  await runMigrations(pool);
  const migrated = await pool.query<{ version: string; service_exists: boolean }>(
    `SELECT migration.version,
            EXISTS (SELECT 1 FROM public.services WHERE id = $1) AS service_exists
     FROM public.schema_migrations migration
     WHERE migration.version = '026_stage_c_service_cancellation_authority'`,
    [savedService.serviceId],
  );
  assert.deepEqual(migrated.rows[0], {
    version: "026_stage_c_service_cancellation_authority",
    service_exists: true,
  });

  app = Fastify({ logger: false });
  await app.register(cookie);
  app.setErrorHandler((
    error: FastifyError,
    _request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number(error.statusCode)
        : 500;
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    return reply.code(statusCode).send({
      error: error instanceof Error ? error.message : "Request failed",
      ...(code ? { code } : {}),
    });
  });
  await registerServiceRoutes(app, pool, config);
  await app.ready();

  const technicalService = await createService(pool, account.owner, "technical");
  const technicalResponse = await schedule(app, account.technical, technicalService);
  assert.equal(
    json<ScheduledCancellation>(technicalResponse).cancellation.executionMode,
    "automatic",
  );

  const explicitService = await createService(pool, account.owner, "explicit");
  const explicitResponse = await schedule(app, account.explicit, explicitService);
  assert.equal(
    json<ScheduledCancellation>(explicitResponse).cancellation.executionMode,
    "automatic",
  );

  const wildcardService = await createService(pool, account.owner, "wildcard");
  const wildcardResponse = await schedule(app, account.wildcard, wildcardService);
  assert.equal(
    json<ScheduledCancellation>(wildcardResponse).cancellation.executionMode,
    "automatic",
  );

  const billingService = await createService(pool, account.owner, "billing-denied");
  const billingResponse = await schedule(app, account.billing, billingService, 403);
  assert.equal(json<{ code: string }>(billingResponse).code, "CUSTOMER_CAPABILITY_REQUIRED");
  await expectPgRejection(
    () =>
      transaction(pool!, (client) =>
        rawCancellationRequest(client, account.billing, billingService.serviceId),
      ),
    "P0001",
    /cycle-end cancellation request is not eligible for this service and session/,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM public.service_cancellation_requests WHERE service_id = $1",
        [billingService.serviceId],
      )
    ).rowCount,
    0,
  );

  // A multi-account Session may be valid, but only for its explicit active
  // context.  Native writes cannot use a membership in a non-active account.
  const otherAccount = await createCustomerAccount(pool, `other-${randomUUID()}`);
  const multiAccountUserId = randomUUID();
  const multiAccountSessionId = randomUUID();
  const multiAccountToken = randomBytes(32).toString("base64url");
  await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO public.users(id, email, password_hash, locale, email_verified_at)
       VALUES ($1, $2, 'synthetic-not-a-password', 'en', pg_catalog.clock_timestamp())`,
      [multiAccountUserId, `multi-account-${multiAccountUserId}@example.invalid`],
    );
    await client.query(
      `INSERT INTO public.client_memberships(client_account_id, user_id, role, permissions)
       VALUES
         ($1, $3, 'technical', '[]'::jsonb),
         ($2, $3, 'viewer', '[]'::jsonb)`,
      [account.accountId, otherAccount.accountId, multiAccountUserId],
    );
    await client.query(
      `INSERT INTO public.sessions(
         id, user_id, token_digest, expires_at,
         active_client_account_id, account_context_version
       ) VALUES ($1, $2, $3, pg_catalog.clock_timestamp() + interval '2 hours', $4, 1)`,
      [
        multiAccountSessionId,
        multiAccountUserId,
        digestToken(multiAccountToken),
        otherAccount.accountId,
      ],
    );
  });
  const nonActiveContextActor: CustomerActor = {
    userId: multiAccountUserId,
    sessionId: multiAccountSessionId,
    token: multiAccountToken,
    accountId: account.accountId,
    contextVersion: "1",
  };
  const nonActiveContextService = await createService(
    pool,
    account.owner,
    "non-active-context",
  );
  await expectPgRejection(
    () => transaction(pool!, (client) =>
      rawCancellationRequest(client, nonActiveContextActor, nonActiveContextService.serviceId)),
    "P0001",
    /cycle-end cancellation request is not eligible for this service and session/,
  );

  const restrictedActor = await createCustomerActor(
    pool,
    account.accountId,
    `restricted-${randomUUID()}`,
    "technical",
  );
  const restrictedService = await createService(pool, account.owner, "restricted-membership");
  await pool.query(
    `UPDATE public.client_memberships
     SET restricted_at = pg_catalog.clock_timestamp()
     WHERE client_account_id = $1 AND user_id = $2`,
    [account.accountId, restrictedActor.userId],
  );
  await expectPgRejection(
    () => transaction(pool!, (client) =>
      rawCancellationRequest(client, restrictedActor, restrictedService.serviceId)),
    "P0001",
    /cycle-end cancellation request is not eligible for this service and session/,
  );

  // The request begins while its Session is valid, then waits behind the
  // Service lock.  Only a post-lock database clock rejects the expired grant.
  const expiringCustomer = await createCustomerActor(
    pool,
    account.accountId,
    `expiring-${randomUUID()}`,
    "technical",
    [],
    2,
  );
  const expiringService = await createService(pool, account.owner, "expiring-customer");
  const customerExpiry = await pool.query<{ expires_at: Date }>(
    "SELECT expires_at FROM public.sessions WHERE id = $1",
    [expiringCustomer.sessionId],
  );
  const customerBlocker = await pool.connect();
  let customerBlockerOpen = false;
  try {
    await customerBlocker.query("BEGIN");
    customerBlockerOpen = true;
    await customerBlocker.query("SELECT id FROM public.services WHERE id = $1 FOR UPDATE", [
      expiringService.serviceId,
    ]);
    const blockerPid = await customerBlocker.query<{ pid: number }>(
      "SELECT pg_catalog.pg_backend_pid() AS pid",
    );
    const customerFreshAtStart = await pool.query<{ fresh: boolean }>(
      `SELECT pg_catalog.clock_timestamp() < expires_at AS fresh
       FROM public.sessions WHERE id = $1`,
      [expiringCustomer.sessionId],
    );
    assert.equal(customerFreshAtStart.rows[0]?.fresh, true);
    const responsePromise = schedule(app, expiringCustomer, expiringService, 409);
    await waitUntilBlocked(
      pool,
      blockerPid.rows[0]!.pid,
      "customer cancellation to wait behind its Service lock",
    );
    await waitPast(customerExpiry.rows[0]!.expires_at);
    await customerBlocker.query("COMMIT");
    customerBlockerOpen = false;
    const response = await responsePromise;
    assert.equal(json<{ code: string }>(response).code, "CANCELLATION_STATE_CONFLICT");
  } finally {
    if (customerBlockerOpen) {
      await customerBlocker.query("ROLLBACK").catch(() => undefined);
    }
    customerBlocker.release();
  }
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM public.service_cancellation_requests WHERE service_id = $1",
        [expiringService.serviceId],
      )
    ).rowCount,
    0,
  );

  const staff = await createCrossAccountStaff(pool, `cross-account-${randomUUID()}`);
  const manual = await prepareManualFixture(
    app,
    pool,
    account.owner,
    "cross-account-manual",
  );
  const membershipProof = await pool.query<{
    target_memberships: number;
    unrelated_memberships: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE client_account_id = $2)::integer AS target_memberships,
       count(*) FILTER (WHERE client_account_id = $3)::integer AS unrelated_memberships
     FROM public.client_memberships
     WHERE user_id = $1`,
    [staff.userId, manual.targetAccountId, staff.unrelatedAccountId],
  );
  assert.deepEqual(membershipProof.rows[0], {
    target_memberships: 0,
    unrelated_memberships: 1,
  });
  const manualResponse = await app.inject({
    method: "POST",
    url: `/api/v1/admin/services/cancellations/${manual.executionId}/complete-manual`,
    headers: staffHeaders(staff),
    payload: {
      expectedExecutionVersion: manual.executionVersion,
      expectedServiceVersion: manual.serviceVersion,
      reason: "Synthetic cross-account platform Staff manual cancellation completion",
      idempotencyKey: `cross-account-${randomUUID()}`,
    },
  });
  assert.equal(manualResponse.statusCode, 201, manualResponse.body);
  const completed = await pool.query<{
    service_status: string;
    execution_status: string;
    target_account_id: string;
  }>(
    `SELECT service.status AS service_status,
            execution.status AS execution_status,
            action.staff_client_account_id AS target_account_id
     FROM public.service_cancellation_manual_actions action
     JOIN public.service_cancellation_executions execution
       ON execution.id = action.execution_id
     JOIN public.services service ON service.id = action.service_id
     WHERE action.execution_id = $1`,
    [manual.executionId],
  );
  assert.deepEqual(completed.rows[0], {
    service_status: "terminated",
    execution_status: "terminated",
    target_account_id: manual.targetAccountId,
  });

  // Manual completion must join the shared Account -> Service lock order.  If
  // it waits for the target Account, another transaction can still lock its
  // Service; holding Service first would recreate an Account/Service deadlock.
  const orderedManual = await prepareManualFixture(
    app,
    pool,
    account.owner,
    "account-before-service-lock-order",
  );
  const accountBlocker = await pool.connect();
  const serviceContender = await pool.connect();
  let accountBlockerOpen = false;
  let serviceContenderOpen = false;
  try {
    await accountBlocker.query("BEGIN");
    accountBlockerOpen = true;
    await accountBlocker.query(
      "SELECT id FROM public.client_accounts WHERE id = $1 FOR UPDATE",
      [orderedManual.targetAccountId],
    );
    const blockerPid = await accountBlocker.query<{ pid: number }>(
      "SELECT pg_catalog.pg_backend_pid() AS pid",
    );
    const responsePromise = app.inject({
      method: "POST",
      url: `/api/v1/admin/services/cancellations/${orderedManual.executionId}/complete-manual`,
      headers: staffHeaders(staff),
      payload: {
        expectedExecutionVersion: orderedManual.executionVersion,
        expectedServiceVersion: orderedManual.serviceVersion,
        reason: "Synthetic Account-before-Service lock-order verification",
        idempotencyKey: `lock-order-${randomUUID()}`,
      },
    });
    await waitUntilBlocked(
      pool,
      blockerPid.rows[0]!.pid,
      "manual completion to wait behind its target Account lock",
    );

    await serviceContender.query("BEGIN");
    serviceContenderOpen = true;
    const contenderLock = await serviceContender.query(
      "SELECT id FROM public.services WHERE id = $1 FOR UPDATE NOWAIT",
      [orderedManual.serviceId],
    );
    assert.equal(contenderLock.rowCount, 1);
    await serviceContender.query("ROLLBACK");
    serviceContenderOpen = false;

    await accountBlocker.query("COMMIT");
    accountBlockerOpen = false;
    const response = await responsePromise;
    assert.equal(response.statusCode, 201, response.body);
  } finally {
    if (serviceContenderOpen) {
      await serviceContender.query("ROLLBACK").catch(() => undefined);
    }
    if (accountBlockerOpen) {
      await accountBlocker.query("ROLLBACK").catch(() => undefined);
    }
    serviceContender.release();
    accountBlocker.release();
  }

  const restrictedTargetAccount = await createCustomerAccount(
    pool,
    `restricted-target-${randomUUID()}`,
  );
  const restrictedTargetManual = await prepareManualFixture(
    app,
    pool,
    restrictedTargetAccount.owner,
    "restricted-target-manual",
  );
  await pool.query(
    `UPDATE public.client_accounts
     SET restricted_at = pg_catalog.clock_timestamp()
     WHERE id = $1`,
    [restrictedTargetManual.targetAccountId],
  );
  const restrictedTargetResponse = await app.inject({
    method: "POST",
    url: `/api/v1/admin/services/cancellations/${restrictedTargetManual.executionId}/complete-manual`,
    headers: staffHeaders(staff),
    payload: {
      expectedExecutionVersion: restrictedTargetManual.executionVersion,
      expectedServiceVersion: restrictedTargetManual.serviceVersion,
      reason: "Synthetic restricted target account must reject manual completion",
      idempotencyKey: `restricted-target-${randomUUID()}`,
    },
  });
  assert.equal(restrictedTargetResponse.statusCode, 409, restrictedTargetResponse.body);
  assert.equal(
    json<{ code: string }>(restrictedTargetResponse).code,
    "MANUAL_COMPLETION_AUTHORITY_CHANGED",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM public.service_cancellation_manual_actions WHERE execution_id = $1",
        [restrictedTargetManual.executionId],
      )
    ).rowCount,
    0,
  );

  // The target binding is still exact: substituting the Staff-owned unrelated
  // account is rejected even though that Staff has a valid membership there.
  const wrongTarget = await prepareManualFixture(
    app,
    pool,
    account.owner,
    "wrong-target-manual",
  );
  await expectPgRejection(
    () => transaction(pool!, (client) =>
      rawManualAction(client, staff, wrongTarget, staff.unrelatedAccountId)),
    "P0001",
    /manual cancellation completion lacks current authority or eligible state/,
  );

  // The API treats the entire Staff permission document as invalid when any
  // entry is malformed.  Native writes must not recover authority merely
  // because jsonb `?` can still find the valid-looking array element.
  const malformedStaff = await createCrossAccountStaff(
    pool,
    `malformed-permissions-${randomUUID()}`,
  );
  const malformedManual = await prepareManualFixture(
    app,
    pool,
    account.owner,
    "malformed-staff-permissions",
  );
  await pool.query(
    `UPDATE public.staff_members
     SET permissions = '["services.manual_fulfillment", "\\tbad"]'::jsonb
     WHERE user_id = $1`,
    [malformedStaff.userId],
  );
  await pool.query(
    `INSERT INTO public.reauth_grants(user_id, session_id, expires_at)
     VALUES ($1, $2, pg_catalog.clock_timestamp() + interval '10 minutes')`,
    [malformedStaff.userId, malformedStaff.sessionId],
  );
  const malformedAuthorityControl = await pool.query<{ active_grants: number }>(
    `SELECT count(*)::integer AS active_grants
     FROM public.reauth_grants
     WHERE user_id = $1
       AND session_id = $2
       AND invalidated_at IS NULL
       AND expires_at > pg_catalog.clock_timestamp()`,
    [malformedStaff.userId, malformedStaff.sessionId],
  );
  assert.equal(malformedAuthorityControl.rows[0]?.active_grants, 1);
  await expectPgRejection(
    () =>
      transaction(pool!, (client) =>
        rawManualAction(client, malformedStaff, malformedManual),
      ),
    "P0001",
    /manual cancellation completion lacks current authority or eligible state/,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM public.service_cancellation_manual_actions WHERE execution_id = $1",
        [malformedManual.executionId],
      )
    ).rowCount,
    0,
  );

  // Permission revocation wins while the API waits for the locked Staff row;
  // no completion fact is authored from the stale preflight read.
  const revokedStaff = await createCrossAccountStaff(pool, `revoked-${randomUUID()}`);
  const revokedManual = await prepareManualFixture(
    app,
    pool,
    account.owner,
    "revoked-staff-manual",
  );
  const revoker = await pool.connect();
  let revokerOpen = false;
  try {
    await revoker.query("BEGIN");
    revokerOpen = true;
    await revoker.query(
      "UPDATE public.staff_members SET permissions = '[]'::jsonb WHERE user_id = $1",
      [revokedStaff.userId],
    );
    const blockerPid = await revoker.query<{ pid: number }>(
      "SELECT pg_catalog.pg_backend_pid() AS pid",
    );
    const responsePromise = app.inject({
      method: "POST",
      url: `/api/v1/admin/services/cancellations/${revokedManual.executionId}/complete-manual`,
      headers: staffHeaders(revokedStaff),
      payload: {
        expectedExecutionVersion: revokedManual.executionVersion,
        expectedServiceVersion: revokedManual.serviceVersion,
        reason: "Synthetic revoked Staff completion must not author facts",
        idempotencyKey: `revoked-${randomUUID()}`,
      },
    });
    await waitUntilBlocked(
      pool,
      blockerPid.rows[0]!.pid,
      "manual completion to wait behind a revoked Staff permission row",
    );
    await revoker.query("COMMIT");
    revokerOpen = false;
    const response = await responsePromise;
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(json<{ code: string }>(response).code, "STAFF_AUTHORIZATION_REQUIRED");
  } finally {
    if (revokerOpen) await revoker.query("ROLLBACK").catch(() => undefined);
    revoker.release();
  }
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM public.service_cancellation_manual_actions WHERE execution_id = $1",
        [revokedManual.executionId],
      )
    ).rowCount,
    0,
  );

  // A raw writer starts with valid Staff Session/reauth facts, blocks on the
  // Service row, and resumes after only reauth has expired.  The Session stays
  // fresh, isolating the post-lock reauthentication clock check.
  const expiringManual = await prepareManualFixture(
    app,
    pool,
    account.owner,
    "expiring-staff-manual",
  );
  const expiringStaff = await createCrossAccountStaff(
    pool,
    `expiring-staff-${randomUUID()}`,
    7_200,
    2,
  );
  const staffExpiry = await pool.query<{
    session_expires_at: Date;
    reauth_expires_at: Date;
  }>(
    `SELECT session_record.expires_at AS session_expires_at,
            grant_record.expires_at AS reauth_expires_at
     FROM public.sessions session_record
     JOIN public.reauth_grants grant_record
       ON grant_record.session_id = session_record.id
      AND grant_record.user_id = session_record.user_id
     WHERE session_record.id = $1`,
    [expiringStaff.sessionId],
  );
  const rawBlocker = await pool.connect();
  const rawWriter = await pool.connect();
  let rawBlockerOpen = false;
  let rawWriterOpen = false;
  try {
    await rawBlocker.query("BEGIN");
    rawBlockerOpen = true;
    await rawBlocker.query("SELECT id FROM public.services WHERE id = $1 FOR UPDATE", [
      expiringManual.serviceId,
    ]);
    const blockerPid = await rawBlocker.query<{ pid: number }>(
      "SELECT pg_catalog.pg_backend_pid() AS pid",
    );
    await rawWriter.query("BEGIN");
    rawWriterOpen = true;
    const staffFreshAtStart = await rawWriter.query<{
      session_fresh: boolean;
      reauth_fresh: boolean;
    }>(
      `SELECT pg_catalog.clock_timestamp() < $1::timestamptz AS session_fresh,
              pg_catalog.clock_timestamp() < $2::timestamptz AS reauth_fresh`,
      [
        staffExpiry.rows[0]!.session_expires_at,
        staffExpiry.rows[0]!.reauth_expires_at,
      ],
    );
    assert.deepEqual(staffFreshAtStart.rows[0], {
      session_fresh: true,
      reauth_fresh: true,
    });
    const insertion = rawManualAction(rawWriter, expiringStaff, expiringManual).then(
      () => ({ ok: true as const, error: null }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await waitUntilBlocked(
      pool,
      blockerPid.rows[0]!.pid,
      "native manual action to wait behind its Service lock",
    );
    await waitPast(staffExpiry.rows[0]!.reauth_expires_at);
    const isolatedExpiry = await pool.query<{
      session_fresh: boolean;
      reauth_expired: boolean;
    }>(
      `SELECT pg_catalog.clock_timestamp() < $1::timestamptz AS session_fresh,
              pg_catalog.clock_timestamp() >= $2::timestamptz AS reauth_expired`,
      [
        staffExpiry.rows[0]!.session_expires_at,
        staffExpiry.rows[0]!.reauth_expires_at,
      ],
    );
    assert.deepEqual(isolatedExpiry.rows[0], {
      session_fresh: true,
      reauth_expired: true,
    });
    await rawBlocker.query("COMMIT");
    rawBlockerOpen = false;
    const outcome = await insertion;
    assert.equal(outcome.ok, false);
    assert.equal(pgCode(outcome.error), "P0001");
    assert.ok(outcome.error instanceof Error);
    assert.match(
      outcome.error.message,
      /manual cancellation completion lacks current authority or eligible state/,
    );
    await rawWriter.query("ROLLBACK");
    rawWriterOpen = false;
  } finally {
    if (rawBlockerOpen) await rawBlocker.query("ROLLBACK").catch(() => undefined);
    if (rawWriterOpen) await rawWriter.query("ROLLBACK").catch(() => undefined);
    rawBlocker.release();
    rawWriter.release();
  }
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM public.service_cancellation_manual_actions WHERE execution_id = $1",
        [expiringManual.executionId],
      )
    ).rowCount,
    0,
  );

  console.log("Service cancellation authority integration: PASS");
} finally {
  if (app) await app.close().catch(() => undefined);
  if (pool) await pool.end().catch(() => undefined);
  await admin
    .query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
    .catch(() => undefined);
  await admin.end().catch(() => undefined);
}
