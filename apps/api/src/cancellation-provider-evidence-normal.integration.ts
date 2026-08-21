// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { digestToken } from "./auth.js";
import type { Config } from "./config.js";
import {
  bootstrapPaymentMethodTokenKeyrings,
  configureRuntimeDatabaseRoles,
  runMigrations,
  transaction,
  type DatabasePool,
} from "./database.js";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) {
  throw new Error("ADMIN_DATABASE_URL is required for cancellation Provider evidence integration");
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const marker = randomUUID().replaceAll("-", "");
const applicationDatabaseName = `oss_cancellation028_${marker}`;
const providerDatabaseName = `provider_cancellation028_${marker}`;
const apiRole = `c028a_${marker.slice(0, 20)}`;
const workerRole = `c028w_${marker.slice(0, 20)}`;
const apiRolePassword = `Api-${randomUUID()}-normal-runtime`;
const workerRolePassword = `Worker-${randomUUID()}-normal-runtime`;
const sessionCookieName = "oss_cancellation028_session";
const paymentProviderToken = "c028-normal-payment-provider-token-00000000";
const provisioningProviderToken = "c028-normal-provision-provider-token-000000";
const platformProviderToken = "c028-normal-platform-provider-token-000000000";
const mailProviderToken = "c028-normal-mail-provider-token-00000000000";
const mailboxToken = "c028-normal-mailbox-token-000000000000000";
const paymentWebhookSecret = "c028-normal-payment-webhook-secret-000000";
const provisioningWebhookSecret = "c028-normal-provision-webhook-secret-0000";
const capabilitySecret = "c028-normal-provider-capability-secret-0000";
const paymentTokenKey = Buffer.alloc(32, 101).toString("base64url");
const paymentLookupKey = Buffer.alloc(32, 102).toString("base64url");
const identitySecretKey = Buffer.alloc(32, 103).toString("base64url");
const admin = new pg.Client({ connectionString: adminDatabaseUrl });
const children: ManagedChild[] = [];
const createdDatabases: string[] = [];
let applicationPool: DatabasePool | null = null;
let providerPool: DatabasePool | null = null;

type ManagedChild = Readonly<{
  label: string;
  process: ChildProcessByStdio<null, Readable, Readable>;
  output: string[];
}>;

type CustomerActor = Readonly<{
  userId: string;
  accountId: string;
  sessionToken: string;
}>;

type StaffActor = Readonly<{
  userId: string;
  sessionId: string;
  sessionToken: string;
}>;

type ServiceFixture = Readonly<{
  id: string;
  externalResourceId: string;
  version: number;
}>;

type ScheduledCancellation = Readonly<{
  requestId: string;
  executionId: string;
  providerOperationId: string;
}>;

function databaseUrl(
  databaseName: string,
  credentials?: Readonly<{ username: string; password: string }>,
): string {
  const url = new URL(adminDatabaseUrl!);
  url.pathname = `/${databaseName}`;
  if (credentials) {
    url.username = credentials.username;
    url.password = credentials.password;
  }
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z][a-z0-9_]{0,62}$/);
  return `"${identifier}"`;
}

function appendTail(lines: string[], chunk: Buffer): void {
  lines.push(chunk.toString("utf8"));
  while (lines.join("").length > 24_000) lines.shift();
}

function startChild(
  label: string,
  modulePath: string,
  environment: Readonly<Record<string, string>>,
): ManagedChild {
  const child = spawn(process.execPath, [modulePath], {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => appendTail(output, chunk));
  child.stderr.on("data", (chunk: Buffer) => appendTail(output, chunk));
  child.on("error", (error) => output.push(error.message));
  const managed = { label, process: child, output };
  children.push(managed);
  return managed;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return port;
}

async function waitFor<T>(
  description: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  while (Date.now() < deadline) {
    lastValue = await read();
    if (ready(lastValue)) return lastValue;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
  }
  throw new Error(
    `Timed out waiting for ${description}; last value: ${JSON.stringify(lastValue)}`,
  );
}

async function waitForReady(child: ManagedChild, url: string): Promise<void> {
  await waitFor(
    `${child.label} readiness`,
    async () => {
      if (child.process.exitCode !== null) {
        throw new Error(
          `${child.label} exited with ${child.process.exitCode}: ${child.output.join("")}`,
        );
      }
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
        return response.status;
      } catch {
        return 0;
      }
    },
    (status) => status === 200,
    30_000,
  );
}

async function waitForWorker(child: ManagedChild): Promise<void> {
  await waitFor(
    `${child.label} startup`,
    async () => {
      if (child.process.exitCode !== null) {
        throw new Error(
          `${child.label} exited with ${child.process.exitCode}: ${child.output.join("")}`,
        );
      }
      return child.output.join("");
    },
    (output) => output.includes("OpenSales worker"),
    30_000,
  );
}

async function stopChild(child: ManagedChild): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return;
  child.process.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolveExit) => child.process.once("exit", () => resolveExit(true))),
    new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000)),
  ]);
  if (!exited && child.process.exitCode === null) {
    child.process.kill("SIGKILL");
    await new Promise<void>((resolveExit) => child.process.once("exit", () => resolveExit()));
  }
}

async function restartWorkerStop(child: ManagedChild): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return;
  child.process.kill("SIGKILL");
  await new Promise<void>((resolveExit) => child.process.once("exit", () => resolveExit()));
}

function apiEnvironment(
  applicationApiUrl: string,
  apiBaseUrl: string,
  providerBaseUrl: string,
  apiPort: number,
): Record<string, string> {
  return {
    DATABASE_URL: applicationApiUrl,
    DATABASE_RUNTIME_ROLE: apiRole,
    OSS_ENV: "test",
    OSS_LOG_LEVEL: "silent",
    OSS_PUBLIC_URL: apiBaseUrl,
    API_HOST: "127.0.0.1",
    API_PORT: String(apiPort),
    GLOBAL_RATE_LIMIT_MAX: "10000",
    SESSION_COOKIE_NAME: sessionCookieName,
    SESSION_TTL_HOURS: "24",
    VERIFICATION_TTL_MINUTES: "30",
    WEB_ORIGIN: apiBaseUrl,
    MOCK_MAILBOX_URL: providerBaseUrl,
    LAB_MAILBOX_TOKEN: mailboxToken,
    LAB_MAILBOX_ENABLED: "false",
    PROVIDER_OPERATION_CAPABILITY_SECRET: capabilitySecret,
    PAYMENT_METHOD_TOKEN_KEY: paymentTokenKey,
    PAYMENT_METHOD_TOKEN_LOOKUP_KEY: paymentLookupKey,
    IDENTITY_SECRET_KEY: identitySecretKey,
    MOCK_PAYMENT_WEBHOOK_SECRET: paymentWebhookSecret,
    MOCK_PROVISIONING_WEBHOOK_SECRET: provisioningWebhookSecret,
    NOTIFICATION_MAX_ATTEMPTS: "3",
  };
}

function workerEnvironment(
  applicationWorkerUrl: string,
  apiBaseUrl: string,
  providerBaseUrl: string,
  workerId: string,
  cancellationReconcileDispatchDelayMs = 0,
): Record<string, string> {
  return {
    DATABASE_URL: applicationWorkerUrl,
    DATABASE_RUNTIME_ROLE: workerRole,
    MOCK_PAYMENT_PROVIDER_URL: providerBaseUrl,
    MOCK_PROVISIONING_PROVIDER_URL: providerBaseUrl,
    MOCK_PROVIDER_PLATFORM_URL: providerBaseUrl,
    MOCK_MAIL_PROVIDER_URL: providerBaseUrl,
    MOCK_PAYMENT_PROVIDER_TOKEN: paymentProviderToken,
    MOCK_PROVISIONING_PROVIDER_TOKEN: provisioningProviderToken,
    MOCK_PROVIDER_PLATFORM_TOKEN: platformProviderToken,
    MOCK_MAIL_PROVIDER_TOKEN: mailProviderToken,
    OSS_PUBLIC_URL: apiBaseUrl,
    CORE_INTERNAL_URL: apiBaseUrl,
    IDENTITY_SECRET_KEY: identitySecretKey,
    PROVIDER_OPERATION_CAPABILITY_SECRET: capabilitySecret,
    PAYMENT_METHOD_TOKEN_KEY: paymentTokenKey,
    MOCK_PAYMENT_WEBHOOK_SECRET: paymentWebhookSecret,
    MOCK_PROVISIONING_WEBHOOK_SECRET: provisioningWebhookSecret,
    WORKER_ID: workerId,
    WORKER_POLL_MS: "50",
    PROVIDER_TIMEOUT_MS: "1000",
    JOB_LOCK_TIMEOUT_SECONDS: "1",
    MAX_JOB_ATTEMPTS: "8",
    RECONCILE_MAX_ATTEMPTS: "3",
    RECONCILE_BASE_DELAY_SECONDS: "1",
    CANCELLATION_RECONCILE_DISPATCH_DELAY_MS: String(
      cancellationReconcileDispatchDelayMs,
    ),
    WATCHDOG_DELAY_SECONDS: "1",
    NOTIFICATION_MAX_ATTEMPTS: "3",
    NOTIFICATION_RETRY_BASE_DELAY_SECONDS: "1",
    MOCK_RESOURCE_ACTION_SCENARIO: "success",
  };
}

async function seedFoundation(database: DatabasePool): Promise<{
  customer: CustomerActor;
  staff: StaffActor;
}> {
  const customerUserId = randomUUID();
  const customerAccountId = randomUUID();
  const customerSessionId = randomUUID();
  const customerSessionToken = randomBytes(32).toString("base64url");
  const staffUserId = randomUUID();
  const staffSessionId = randomUUID();
  const staffSessionToken = randomBytes(32).toString("base64url");
  await transaction(database, async (client) => {
    await client.query(
      `INSERT INTO product_groups(id, sort_order, names)
       VALUES ('cancellation-provider-evidence-normal', 999,
               '{"en":"Cancellation evidence","zh-CN":"取消凭据"}'::jsonb)`,
    );
    await client.query(
      `INSERT INTO products(
         id, group_id, names, descriptions, fulfillment_mode, active, hidden,
         repeatable, option_schema
       ) VALUES (
         'cancellation-provider-evidence-normal',
         'cancellation-provider-evidence-normal',
         '{"en":"Cancellation evidence","zh-CN":"取消凭据"}'::jsonb,
         '{"en":"Normal Mock Provider integration","zh-CN":"正常 Mock Provider 集成"}'::jsonb,
         'automatic', true, true, true, '[]'::jsonb
       )`,
    );
    await client.query(
      `INSERT INTO provider_installation_capabilities(
         provider_installation_id, provider_type, enabled, capabilities
       ) VALUES (
         'mock-provisioning-v1', 'provisioning', true,
         '["resource_create","resource_reconcile","resource_suspend","resource_resume","resource_terminate","resource.start","resource.stop","resource.reboot"]'::jsonb
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
         'cancellation-provider-evidence-normal', 'automatic',
         'mock-provisioning-v1', 'policy_calendar_days', 5, 1,
         'self_service', 'automatic', 0, NULL
       )`,
    );
    await client.query(
      `INSERT INTO users(id, email, password_hash, locale, email_verified_at)
       VALUES
         ($1, $2, 'normal-customer-fixture', 'en', clock_timestamp()),
         ($3, $4, 'normal-staff-fixture', 'en', clock_timestamp())`,
      [
        customerUserId,
        `c028-customer-${marker}@example.invalid`,
        staffUserId,
        `c028-staff-${marker}@example.invalid`,
      ],
    );
    await client.query(
      `INSERT INTO client_accounts(id, name, owner_user_id)
       VALUES ($1, 'Cancellation evidence normal account', $2)`,
      [customerAccountId, customerUserId],
    );
    await client.query(
      `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
       VALUES ($1, $2, 'owner', '[]'::jsonb)`,
      [customerAccountId, customerUserId],
    );
    await client.query(
      `INSERT INTO sessions(
         id, user_id, token_digest, expires_at, active_client_account_id,
         account_context_version
       ) VALUES
         ($1, $2, $3, clock_timestamp() + interval '2 hours', $4, 1),
         ($5, $6, $7, clock_timestamp() + interval '2 hours', NULL, 0)`,
      [
        customerSessionId,
        customerUserId,
        digestToken(customerSessionToken),
        customerAccountId,
        staffSessionId,
        staffUserId,
        digestToken(staffSessionToken),
      ],
    );
    await client.query(
      `INSERT INTO staff_members(user_id, roles, permissions)
       VALUES (
         $1, ARRAY['ServiceOperations']::text[],
         '["services.read","services.manual_fulfillment"]'::jsonb
       )`,
      [staffUserId],
    );
  });
  return {
    customer: {
      userId: customerUserId,
      accountId: customerAccountId,
      sessionToken: customerSessionToken,
    },
    staff: {
      userId: staffUserId,
      sessionId: staffSessionId,
      sessionToken: staffSessionToken,
    },
  };
}

async function createService(
  database: DatabasePool,
  provider: DatabasePool,
  customer: CustomerActor,
  label: string,
  dueInMs = 2_000,
): Promise<ServiceFixture> {
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const serviceId = randomUUID();
  const externalResourceId = `c028-${label}-${serviceId}`;
  const termEnd = new Date(Date.now() + dueInMs);
  await transaction(database, async (client) => {
    await client.query(
      `INSERT INTO orders(
         id, client_account_id, submitted_by_user_id, status, currency,
         price_snapshot, one_time_minor, setup_minor, recurring_minor,
         total_minor, idempotency_key, request_fingerprint
       ) VALUES (
         $1, $2, $3, 'completed', 'USD', '{}'::jsonb,
         0, 0, 100, 100, $4, $5
       )`,
      [
        orderId,
        customer.accountId,
        customer.userId,
        `c028-order-${orderId}`,
        createHash("sha256").update(orderId).digest("hex"),
      ],
    );
    await client.query(
      `INSERT INTO order_items(
         id, order_id, product_id, product_name, fulfillment_mode,
         billing_cycle, configuration, price_snapshot, client_account_id
       ) VALUES (
         $1, $2, 'cancellation-provider-evidence-normal', $3,
         'automatic', 'monthly', '{}'::jsonb, '{}'::jsonb, $4
       )`,
      [orderItemId, orderId, `Cancellation evidence ${label}`, customer.accountId],
    );
    await client.query(
      `INSERT INTO services(
         id, client_account_id, order_item_id, status, billing_cycle,
         external_resource_id, activated_at, term_start, term_end
       ) VALUES (
         $1, $2, $3, 'active', 'monthly', $4,
         clock_timestamp(), clock_timestamp(), $5
       )`,
      [serviceId, customer.accountId, orderItemId, externalResourceId, termEnd],
    );
    await client.query(
      `INSERT INTO service_provider_bindings(
         service_id, provider_installation_id, overdue_action_snapshot,
         capability_snapshot, product_policy_version,
         cycle_end_cancellation_mode_snapshot,
         cycle_end_cancellation_execution_mode_snapshot,
         cycle_end_cancellation_min_notice_hours_snapshot,
         cycle_end_cancellation_requirement_key_snapshot
       )
       SELECT $1, policy.provider_installation_id, policy.overdue_action,
              installation.capabilities, policy.version,
              policy.cycle_end_cancellation_mode,
              policy.cycle_end_cancellation_execution_mode,
              policy.cycle_end_cancellation_min_notice_hours,
              policy.cycle_end_cancellation_requirement_key
       FROM product_service_automation_policies policy
       JOIN provider_installation_capabilities installation
         ON installation.provider_installation_id = policy.provider_installation_id
       WHERE policy.product_id = 'cancellation-provider-evidence-normal'`,
      [serviceId],
    );
  });
  await provider.query(
    `INSERT INTO mock_resource_operations(
       operation_id, service_id, external_resource_id, callback_capability,
       scenario, status, ready_at, request_fingerprint,
       resource_state, power_state, desired_power_state
     ) VALUES (
       $1, $2, $3, $4, 'success', 'succeeded', clock_timestamp(), $5,
       'active', 'running', 'running'
     )`,
    [randomUUID(), serviceId, externalResourceId, "A".repeat(43), `normal:${serviceId}`],
  );
  const version = await database.query<{ version: number }>(
    "SELECT version FROM services WHERE id = $1",
    [serviceId],
  );
  assert.equal(version.rowCount, 1);
  return { id: serviceId, externalResourceId, version: version.rows[0]!.version };
}

async function scheduleCancellation(
  database: DatabasePool,
  apiBaseUrl: string,
  customer: CustomerActor,
  service: ServiceFixture,
  scenario: "timeout_success" | "duplicate_out_of_order" | "failed",
): Promise<ScheduledCancellation> {
  const response = await fetch(new URL(`/api/v1/services/${service.id}/cancellation`, apiBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${sessionCookieName}=${customer.sessionToken}`,
      "x-oss-account-context-version": "1",
    },
    body: JSON.stringify({
      expectedVersion: service.version,
      reason: `Normal ${scenario} paid-period cancellation`,
      idempotencyKey: randomUUID(),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const raw = await response.text();
  assert.equal(response.status, 201, raw);
  const scheduled = JSON.parse(raw) as {
    cancellation: { requestId: string; executionMode: string };
  };
  assert.equal(scheduled.cancellation.executionMode, "automatic");
  const state = await database.query<{
    execution_id: string;
    provider_operation_id: string;
  }>(
    `SELECT execution.id AS execution_id, operation.id AS provider_operation_id
     FROM service_cancellation_executions execution
     JOIN provider_operations operation
       ON operation.subject_type = 'service_cancellation_execution'
      AND operation.subject_id = execution.id
      AND operation.kind = 'resource_terminate'
     WHERE execution.cancellation_request_id = $1`,
    [scheduled.cancellation.requestId],
  );
  assert.equal(state.rowCount, 1);
  await database.query(
    `UPDATE durable_jobs
     SET payload = payload || jsonb_build_object('scenario', $2::text)
     WHERE job_type = 'service.cancellation.due'
       AND payload->>'cancellationRequestId' = $1`,
    [scheduled.cancellation.requestId, scenario],
  );
  return {
    requestId: scheduled.cancellation.requestId,
    executionId: state.rows[0]!.execution_id,
    providerOperationId: state.rows[0]!.provider_operation_id,
  };
}

async function adminCancellationQueue(
  apiBaseUrl: string,
  staff: StaffActor,
): Promise<{
  items: Array<{
    requestId: string;
    executionId: string;
    executionStatus: string;
    executionVersion: number;
    serviceVersion: number;
    completionAllowed: boolean;
    providerOperation: {
      status: string;
      attempts: number;
      attemptId: string | null;
      reconcileQueries: number;
      latestResult: { outcome: string; source: string } | null;
    } | null;
  }>;
}> {
  const response = await fetch(new URL("/api/v1/admin/services/cancellations", apiBaseUrl), {
    headers: { cookie: `${sessionCookieName}=${staff.sessionToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  return JSON.parse(raw) as Awaited<ReturnType<typeof adminCancellationQueue>>;
}

try {
  await admin.connect();
  for (const databaseName of [applicationDatabaseName, providerDatabaseName]) {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    createdDatabases.push(databaseName);
  }

  const applicationOwnerUrl = databaseUrl(applicationDatabaseName);
  const providerOwnerUrl = databaseUrl(providerDatabaseName);
  applicationPool = new pg.Pool({
    connectionString: applicationOwnerUrl,
    max: 8,
    application_name: "opensales-cancellation028-normal-owner",
    options: "-c search_path=pg_catalog,public",
  });
  providerPool = new pg.Pool({
    connectionString: providerOwnerUrl,
    max: 8,
    application_name: "opensales-cancellation028-normal-provider-owner",
  });

  await runMigrations(applicationPool);
  const bootstrapConfig: Config = {
    DATABASE_URL: applicationOwnerUrl,
    OSS_ENV: "test",
    OSS_LOG_LEVEL: "silent",
    OSS_PUBLIC_URL: "http://127.0.0.1:3000",
    API_HOST: "127.0.0.1",
    API_PORT: 3000,
    GLOBAL_RATE_LIMIT_MAX: 10_000,
    SESSION_COOKIE_NAME: sessionCookieName,
    SESSION_TTL_HOURS: 24,
    VERIFICATION_TTL_MINUTES: 30,
    WEB_ORIGIN: "http://127.0.0.1:5173",
    MOCK_MAILBOX_URL: "http://127.0.0.1:4000",
    LAB_MAILBOX_TOKEN: mailboxToken,
    PROVIDER_OPERATION_CAPABILITY_SECRET: capabilitySecret,
    PAYMENT_METHOD_TOKEN_KEY: paymentTokenKey,
    PAYMENT_METHOD_TOKEN_LOOKUP_KEY: paymentLookupKey,
    IDENTITY_SECRET_KEY: identitySecretKey,
    MOCK_PAYMENT_WEBHOOK_SECRET: paymentWebhookSecret,
    MOCK_PROVISIONING_WEBHOOK_SECRET: provisioningWebhookSecret,
    NOTIFICATION_MAX_ATTEMPTS: 3,
    LAB_MAILBOX_ENABLED: false,
  };
  await bootstrapPaymentMethodTokenKeyrings(applicationPool, bootstrapConfig);
  await configureRuntimeDatabaseRoles(applicationPool, [
    { name: apiRole, password: apiRolePassword },
    { name: workerRole, password: workerRolePassword },
  ]);

  const providerPort = await reserveLoopbackPort();
  const apiPort = await reserveLoopbackPort();
  const providerBaseUrl = `http://127.0.0.1:${providerPort}`;
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  const applicationApiUrl = databaseUrl(applicationDatabaseName, {
    username: apiRole,
    password: apiRolePassword,
  });
  const applicationWorkerUrl = databaseUrl(applicationDatabaseName, {
    username: workerRole,
    password: workerRolePassword,
  });

  const provider = startChild(
    "Cancellation normal Mock Provider",
    join(repositoryRoot, "providers/mock-lab/dist/server.js"),
    {
      PROVIDER_DATABASE_URL: providerOwnerUrl,
      PROVIDER_HOST: "127.0.0.1",
      PROVIDER_PORT: String(providerPort),
      CORE_CALLBACK_URL: apiBaseUrl,
      MOCK_PAYMENT_PROVIDER_TOKEN: paymentProviderToken,
      MOCK_PROVISIONING_PROVIDER_TOKEN: provisioningProviderToken,
      MOCK_PROVIDER_PLATFORM_TOKEN: platformProviderToken,
      MOCK_PROVIDER_REQUEST_FINGERPRINT_KEY: Buffer.alloc(32, 29).toString("base64url"),
      MOCK_PROVIDER_REQUEST_FINGERPRINT_KEY_VERSION: "1",
      MOCK_PROVIDER_REQUEST_FINGERPRINT_PREVIOUS_KEYS: "",
      MOCK_MAIL_PROVIDER_TOKEN: mailProviderToken,
      LAB_MAILBOX_TOKEN: mailboxToken,
      MOCK_PAYMENT_WEBHOOK_SECRET: paymentWebhookSecret,
      MOCK_PROVISIONING_WEBHOOK_SECRET: provisioningWebhookSecret,
    },
  );
  await waitForReady(provider, `${providerBaseUrl}/health/ready`);

  const actors = await seedFoundation(applicationPool);
  const api = startChild(
    "Cancellation normal API",
    join(repositoryRoot, "apps/api/dist/server.js"),
    apiEnvironment(applicationApiUrl, apiBaseUrl, providerBaseUrl, apiPort),
  );
  await waitForReady(api, `${apiBaseUrl}/health/ready`);

  const timeoutService = await createService(
    applicationPool,
    providerPool,
    actors.customer,
    "restart-timeout",
    2_000,
  );
  const timeoutCancellation = await scheduleCancellation(
    applicationPool,
    apiBaseUrl,
    actors.customer,
    timeoutService,
    "timeout_success",
  );
  let worker = startChild(
    "Cancellation normal Worker before restart",
    join(repositoryRoot, "apps/worker/dist/worker.js"),
    workerEnvironment(applicationWorkerUrl, apiBaseUrl, providerBaseUrl, `c028-before-${marker}`),
  );
  await waitForWorker(worker);

  await waitFor(
    "the one timeout-success Provider mutation to be received",
    () => providerPool!.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM mock_resource_action_operations
       WHERE service_id = $1 AND action = 'terminate'`,
      [timeoutService.id],
    ),
    (result) => result.rows[0]?.count === "1",
    20_000,
  );
  await restartWorkerStop(worker);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_300));
  worker = startChild(
    "Cancellation normal Worker before GET restart",
    join(repositoryRoot, "apps/worker/dist/worker.js"),
    workerEnvironment(
      applicationWorkerUrl,
      apiBaseUrl,
      providerBaseUrl,
      `c028-before-get-${marker}`,
      5_000,
    ),
  );
  await waitForWorker(worker);

  const pendingQuery = await waitFor(
    "restart recovery to authorize a GET reconciliation",
    () => applicationPool!.query<{ id: string; external_event_id: string }>(
      `SELECT id, external_event_id
       FROM service_cancellation_reconciliation_queries
       WHERE execution_id = $1
       ORDER BY query_number`,
      [timeoutCancellation.executionId],
    ),
    (result) => result.rows.length === 1,
    20_000,
  );
  assert.ok(pendingQuery.rows[0]);
  await restartWorkerStop(worker);
  const beforeGetRestart = await providerPool.query<{ query_calls: number }>(
    `SELECT query_calls
     FROM mock_resource_action_operations
     WHERE service_id = $1 AND action = 'terminate'`,
    [timeoutService.id],
  );
  assert.equal(beforeGetRestart.rows[0]?.query_calls, 0);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_300));
  worker = startChild(
    "Cancellation normal Worker after GET restart",
    join(repositoryRoot, "apps/worker/dist/worker.js"),
    workerEnvironment(
      applicationWorkerUrl,
      apiBaseUrl,
      providerBaseUrl,
      `c028-after-get-${marker}`,
    ),
  );
  await waitForWorker(worker);

  const timeoutTerminal = await waitFor(
    "timeout-success cancellation to terminate from Provider GET evidence",
    () => applicationPool!.query<{
      execution_status: string;
      service_status: string;
      operation_status: string;
      operation_attempt_count: number;
      reconciliation_query_count: number;
      attempt_count: string;
      reconciliation_result_count: string;
      reconciliation_query_id: string | null;
    }>(
      `SELECT execution.status AS execution_status,
              service.status AS service_status,
              operation.status AS operation_status,
              operation.attempt_count AS operation_attempt_count,
              execution.reconciliation_query_count,
              (SELECT count(*)::text
               FROM service_cancellation_provider_attempts attempt
               WHERE attempt.execution_id = execution.id) AS attempt_count,
              (SELECT count(*)::text
               FROM service_cancellation_provider_results result
               WHERE result.execution_id = execution.id
                 AND result.observation_source = 'reconciliation')
                AS reconciliation_result_count,
              (SELECT result.reconciliation_query_id
               FROM service_cancellation_provider_results result
               WHERE result.execution_id = execution.id
                 AND result.observation_source = 'reconciliation'
               ORDER BY result.created_at
               LIMIT 1) AS reconciliation_query_id
       FROM service_cancellation_executions execution
       JOIN services service ON service.id = execution.service_id
       JOIN provider_operations operation
         ON operation.subject_type = 'service_cancellation_execution'
        AND operation.subject_id = execution.id
        AND operation.kind = 'resource_terminate'
       WHERE execution.id = $1`,
      [timeoutCancellation.executionId],
    ),
    (result) => result.rows[0]?.execution_status === "terminated",
    35_000,
  );
  assert.deepEqual(timeoutTerminal.rows[0], {
    execution_status: "terminated",
    service_status: "terminated",
    operation_status: "succeeded",
    operation_attempt_count: 1,
    reconciliation_query_count: 1,
    attempt_count: "1",
    reconciliation_result_count: "1",
    reconciliation_query_id: pendingQuery.rows[0].id,
  });
  const timeoutProvider = await providerPool.query<{
    action_calls: number;
    query_calls: number;
  }>(
    `SELECT action_calls, query_calls
     FROM mock_resource_action_operations
     WHERE service_id = $1 AND action = 'terminate'`,
    [timeoutService.id],
  );
  assert.deepEqual(timeoutProvider.rows[0], { action_calls: 1, query_calls: 1 });

  await waitFor(
    "the normal late timeout-success callback to be retained without a second mutation",
    () => applicationPool!.query<{ result_count: string }>(
      `SELECT count(*)::text AS result_count
       FROM service_cancellation_provider_results
       WHERE execution_id = $1`,
      [timeoutCancellation.executionId],
    ),
    (result) => Number(result.rows[0]?.result_count ?? "0") >= 2,
    15_000,
  );
  const timeoutProviderAfterLate = await providerPool.query<{
    action_calls: number;
    query_calls: number;
  }>(
    `SELECT action_calls, query_calls
     FROM mock_resource_action_operations
     WHERE service_id = $1 AND action = 'terminate'`,
    [timeoutService.id],
  );
  assert.deepEqual(timeoutProviderAfterLate.rows[0], { action_calls: 1, query_calls: 1 });

  const orderedService = await createService(
    applicationPool,
    providerPool,
    actors.customer,
    "duplicate-ordering",
  );
  const orderedCancellation = await scheduleCancellation(
    applicationPool,
    apiBaseUrl,
    actors.customer,
    orderedService,
    "duplicate_out_of_order",
  );
  await waitFor(
    "duplicate/out-of-order callbacks to reduce monotonically",
    () => applicationPool!.query<{
      execution_status: string;
      service_status: string;
      operation_status: string;
      attempt_count: number;
      immutable_attempts: string;
      succeeded_results: string;
      failed_results: string;
    }>(
      `SELECT execution.status AS execution_status,
              service.status AS service_status,
              operation.status AS operation_status,
              operation.attempt_count,
              (SELECT count(*)::text FROM service_cancellation_provider_attempts attempt
               WHERE attempt.execution_id = execution.id) AS immutable_attempts,
              (SELECT count(*)::text FROM service_cancellation_provider_results result
               WHERE result.execution_id = execution.id AND result.outcome = 'succeeded')
                AS succeeded_results,
              (SELECT count(*)::text FROM service_cancellation_provider_results result
               WHERE result.execution_id = execution.id AND result.outcome = 'failed')
                AS failed_results
       FROM service_cancellation_executions execution
       JOIN services service ON service.id = execution.service_id
       JOIN provider_operations operation
         ON operation.subject_type = 'service_cancellation_execution'
        AND operation.subject_id = execution.id
        AND operation.kind = 'resource_terminate'
       WHERE execution.id = $1`,
      [orderedCancellation.executionId],
    ),
    (result) =>
      result.rows[0]?.execution_status === "terminated" &&
      result.rows[0]?.succeeded_results === "1" &&
      result.rows[0]?.failed_results === "1",
    25_000,
  ).then((result) => {
    assert.deepEqual(result.rows[0], {
      execution_status: "terminated",
      service_status: "terminated",
      operation_status: "succeeded",
      attempt_count: 1,
      immutable_attempts: "1",
      succeeded_results: "1",
      failed_results: "1",
    });
  });
  const orderedProvider = await providerPool.query<{ action_calls: number }>(
    `SELECT action_calls
     FROM mock_resource_action_operations
     WHERE service_id = $1 AND action = 'terminate'`,
    [orderedService.id],
  );
  assert.equal(orderedProvider.rows[0]?.action_calls, 1);

  const failedService = await createService(
    applicationPool,
    providerPool,
    actors.customer,
    "failed-staff-completion",
  );
  const failedCancellation = await scheduleCancellation(
    applicationPool,
    apiBaseUrl,
    actors.customer,
    failedService,
    "failed",
  );
  const failedQueueItem = await waitFor(
    "definitive failed evidence to become the narrow Staff completion item",
    () => adminCancellationQueue(apiBaseUrl, actors.staff),
    (queue) =>
      queue.items.some(
        (item) => item.requestId === failedCancellation.requestId && item.completionAllowed,
      ),
    25_000,
  ).then((queue) => queue.items.find((item) => item.requestId === failedCancellation.requestId)!);
  assert.equal(failedQueueItem.executionStatus, "manual");
  assert.equal(failedQueueItem.providerOperation?.status, "failed");
  assert.equal(failedQueueItem.providerOperation?.attempts, 1);
  assert.ok(failedQueueItem.providerOperation?.attemptId);
  assert.equal(failedQueueItem.providerOperation?.latestResult?.outcome, "failed");

  const completionBody = {
    expectedExecutionVersion: failedQueueItem.executionVersion,
    expectedServiceVersion: failedQueueItem.serviceVersion,
    reason: "Normal Staff completion after definitive Provider failure evidence",
    idempotencyKey: randomUUID(),
  };
  const withoutReauth = await fetch(
    new URL(
      `/api/v1/admin/services/cancellations/${failedCancellation.executionId}/complete-manual`,
      apiBaseUrl,
    ),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${sessionCookieName}=${actors.staff.sessionToken}`,
      },
      body: JSON.stringify(completionBody),
      signal: AbortSignal.timeout(10_000),
    },
  );
  assert.equal(withoutReauth.status, 403, await withoutReauth.text());
  await applicationPool.query(
    `INSERT INTO reauth_grants(user_id, session_id, expires_at)
     VALUES ($1, $2, clock_timestamp() + interval '10 minutes')`,
    [actors.staff.userId, actors.staff.sessionId],
  );
  const completion = await fetch(
    new URL(
      `/api/v1/admin/services/cancellations/${failedCancellation.executionId}/complete-manual`,
      apiBaseUrl,
    ),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${sessionCookieName}=${actors.staff.sessionToken}`,
      },
      body: JSON.stringify(completionBody),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const completionRaw = await completion.text();
  assert.equal(completion.status, 201, completionRaw);
  const completionResult = JSON.parse(completionRaw) as {
    actionId: string;
    takeoverKind: string;
    providerOutcome: string;
    providerAttemptId: string;
    reconcileQueries: number;
    completedAt: string;
    replayed: boolean;
  };
  assert.equal(completionResult.takeoverKind, "provider_reconciliation_takeover");
  assert.equal(completionResult.providerOutcome, "failed");
  assert.equal(completionResult.providerAttemptId, failedQueueItem.providerOperation?.attemptId);
  assert.equal(completionResult.reconcileQueries, 0);
  assert.equal(completionResult.replayed, false);
  const completedFacts = await applicationPool.query<{
    execution_status: string;
    service_status: string;
    execution_version: number;
    service_version: number;
    completed_at: Date;
    action_completed_at: Date;
    action_result: Record<string, unknown>;
    attempts: string;
    failed_results: string;
  }>(
    `SELECT execution.status AS execution_status,
            service.status AS service_status,
            execution.version AS execution_version,
            service.version AS service_version,
            execution.completed_at,
            action.completed_at AS action_completed_at,
            action.result AS action_result,
            (SELECT count(*)::text FROM service_cancellation_provider_attempts attempt
             WHERE attempt.execution_id = execution.id) AS attempts,
            (SELECT count(*)::text FROM service_cancellation_provider_results result
             WHERE result.execution_id = execution.id AND result.outcome = 'failed')
              AS failed_results
     FROM service_cancellation_executions execution
     JOIN services service ON service.id = execution.service_id
     JOIN service_cancellation_manual_actions action ON action.execution_id = execution.id
     WHERE execution.id = $1`,
    [failedCancellation.executionId],
  );
  const completed = completedFacts.rows[0];
  assert.ok(completed);
  assert.equal(completed.execution_status, "terminated");
  assert.equal(completed.service_status, "terminated");
  assert.equal(completed.execution_version, failedQueueItem.executionVersion + 1);
  assert.equal(completed.service_version, failedQueueItem.serviceVersion + 1);
  assert.equal(completed.completed_at.toISOString(), completionResult.completedAt);
  assert.equal(completed.action_completed_at.toISOString(), completionResult.completedAt);
  const { replayed: _replayed, ...persistedCompletionResult } = completionResult;
  assert.deepEqual(completed.action_result, persistedCompletionResult);
  assert.equal(completed.attempts, "1");
  assert.equal(completed.failed_results, "1");
  const failedProvider = await providerPool.query<{ action_calls: number; query_calls: number }>(
    `SELECT action_calls, query_calls
     FROM mock_resource_action_operations
     WHERE service_id = $1 AND action = 'terminate'`,
    [failedService.id],
  );
  assert.deepEqual(failedProvider.rows[0], { action_calls: 1, query_calls: 0 });

  console.log(
    "Schema 028 cancellation Provider evidence normal integration: PASS — one mutation attempt survived Worker restart and a second restart after GET authorization while retaining one query identity; duplicate/out-of-order/late facts reduced monotonically; definitive failure required current Staff capability and reauth before exact completion.",
  );
} catch (error) {
  const diagnostics = children
    .map((child) => `${child.label}:\n${child.output.join("").trim()}`)
    .filter((entry) => !entry.endsWith(":\n"))
    .join("\n");
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}` +
      (diagnostics ? `\nService diagnostics:\n${diagnostics}` : ""),
    { cause: error },
  );
} finally {
  for (const child of children.reverse()) {
    await stopChild(child).catch(() => undefined);
  }
  if (providerPool) await providerPool.end().catch(() => undefined);
  if (applicationPool) await applicationPool.end().catch(() => undefined);
  if ((admin as unknown as { _connected?: boolean })._connected) {
    for (const databaseName of createdDatabases.reverse()) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName],
      ).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`)
        .catch(() => undefined);
    }
    for (const role of [apiRole, workerRole]) {
      await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`).catch(() => undefined);
    }
  }
  await admin.end().catch(() => undefined);
}
