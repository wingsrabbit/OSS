// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  EXPECTED_SCHEMA_028_HISTORY,
  SCHEMA_028,
  SCHEMA_028_CATALOG_DIGEST,
  assertSchema028NativeSafe,
  schema028CatalogDigest,
  schema028CatalogFingerprintInput,
} from "@opensales/core/schema-027-028-native-compatibility";
import pg from "pg";
import { digestToken } from "./auth.js";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";
import {
  holdSchema028ApplicationGuard,
  runMigrations,
  transaction,
  type DatabasePool,
} from "./database.js";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) throw new Error("ADMIN_DATABASE_URL is required for Schema 028 integration");

const databaseName = `oss_schema028_normal_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = new URL(adminDatabaseUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = new pg.Client({ connectionString: adminDatabaseUrl });
let pool: DatabasePool | null = null;

const config: Config = {
  DATABASE_URL: databaseUrl.toString(),
  OSS_ENV: "test",
  OSS_LOG_LEVEL: "silent",
  OSS_PUBLIC_URL: "http://127.0.0.1:3000",
  API_HOST: "127.0.0.1",
  API_PORT: 3000,
  GLOBAL_RATE_LIMIT_MAX: 10_000,
  SESSION_COOKIE_NAME: "oss_schema028_session",
  SESSION_TTL_HOURS: 24,
  VERIFICATION_TTL_MINUTES: 30,
  WEB_ORIGIN: "http://127.0.0.1:5173",
  MOCK_MAILBOX_URL: "http://127.0.0.1:4000",
  LAB_MAILBOX_TOKEN: "schema028-normal-mailbox-token-00000000",
  PROVIDER_OPERATION_CAPABILITY_SECRET: "schema028-normal-capability-secret-000000",
  PAYMENT_METHOD_TOKEN_KEY: Buffer.alloc(32, 91).toString("base64url"),
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY: Buffer.alloc(32, 92).toString("base64url"),
  IDENTITY_SECRET_KEY: Buffer.alloc(32, 93).toString("base64url"),
  MOCK_PAYMENT_WEBHOOK_SECRET: "schema028-normal-payment-secret-00000000",
  MOCK_PROVISIONING_WEBHOOK_SECRET: "schema028-normal-provision-secret-000000",
  NOTIFICATION_MAX_ATTEMPTS: 3,
  LAB_MAILBOX_ENABLED: false,
};

async function seedScheduledCancellation(database: DatabasePool): Promise<{
  requestId: string;
  executionId: string;
  providerOperationId: string;
  serviceId: string;
}> {
  const userId = randomUUID();
  const accountId = randomUUID();
  const sessionId = randomUUID();
  const sessionToken = randomBytes(32).toString("base64url");
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const serviceId = randomUUID();

  await transaction(database, async (client) => {
    await client.query(
      `INSERT INTO product_groups(id, sort_order, names)
       VALUES ('schema028-normal', 999,
               '{"en":"Schema 028","zh-CN":"Schema 028"}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO products(
         id, group_id, names, descriptions, fulfillment_mode, active, hidden,
         repeatable, option_schema
       ) VALUES (
         'schema028-normal', 'schema028-normal',
         '{"en":"Schema 028 cancellation","zh-CN":"Schema 028 取消"}'::jsonb,
         '{"en":"Mock-only saved row","zh-CN":"仅 Mock 保存行"}'::jsonb,
         'automatic', true, true, true, '[]'::jsonb
       ) ON CONFLICT (id) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO provider_installation_capabilities(
         provider_installation_id, provider_type, enabled, capabilities
       ) VALUES (
         'mock-provisioning-v1', 'provisioning', true,
         '["resource_create","resource_reconcile","resource_suspend","resource_resume","resource_terminate","resource.start","resource.stop","resource.reboot"]'::jsonb
       ) ON CONFLICT (provider_installation_id) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO product_service_automation_policies(
         product_id, overdue_action, provider_installation_id,
         overdue_delay_mode, overdue_delay_value, version,
         cycle_end_cancellation_mode, cycle_end_cancellation_execution_mode,
         cycle_end_cancellation_min_notice_hours, cycle_end_cancellation_requirement_key
       ) VALUES (
         'schema028-normal', 'automatic', 'mock-provisioning-v1',
         'policy_calendar_days', 5, 1, 'self_service', 'automatic', 0, NULL
       ) ON CONFLICT (product_id) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO users(id, email, password_hash, locale, email_verified_at)
       VALUES ($1, $2, 'schema028-not-a-password', 'en', clock_timestamp())`,
      [userId, `schema028-${userId}@example.invalid`],
    );
    await client.query(
      "INSERT INTO client_accounts(id, name, owner_user_id) VALUES ($1, 'Schema 028 account', $2)",
      [accountId, userId],
    );
    await client.query(
      `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
       VALUES ($1, $2, 'owner', '[]'::jsonb)`,
      [accountId, userId],
    );
    await client.query(
      `INSERT INTO sessions(
         id, user_id, token_digest, expires_at, active_client_account_id,
         account_context_version
       ) VALUES ($1, $2, $3, clock_timestamp() + interval '2 hours', $4, 1)`,
      [sessionId, userId, digestToken(sessionToken), accountId],
    );
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
        userId,
        `schema028-order-${orderId}`,
        createHash("sha256").update(orderId).digest("hex"),
      ],
    );
    await client.query(
      `INSERT INTO order_items(
         id, order_id, product_id, product_name, fulfillment_mode,
         billing_cycle, configuration, price_snapshot, client_account_id
       ) VALUES ($1, $2, 'schema028-normal', 'Schema 028 cancellation',
                 'automatic', 'monthly', '{}'::jsonb, '{}'::jsonb, $3)`,
      [orderItemId, orderId, accountId],
    );
    await client.query(
      `INSERT INTO services(
         id, client_account_id, order_item_id, status, billing_cycle,
         external_resource_id, activated_at, term_start, term_end
       ) VALUES ($1, $2, $3, 'active', 'monthly', $4,
                 clock_timestamp(), clock_timestamp(),
                 clock_timestamp() + interval '500 milliseconds')`,
      [serviceId, accountId, orderItemId, `schema028-resource-${serviceId}`],
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
              provider.capabilities, policy.version,
              policy.cycle_end_cancellation_mode,
              policy.cycle_end_cancellation_execution_mode,
              policy.cycle_end_cancellation_min_notice_hours,
              policy.cycle_end_cancellation_requirement_key
       FROM product_service_automation_policies policy
       JOIN provider_installation_capabilities provider
         ON provider.provider_installation_id = policy.provider_installation_id
       WHERE policy.product_id = 'schema028-normal'`,
      [serviceId],
    );
  });

  const built = await buildApp(config, database);
  try {
    const response = await built.app.inject({
      method: "POST",
      url: `/api/v1/services/${serviceId}/cancellation`,
      headers: {
        cookie: `${config.SESSION_COOKIE_NAME}=${sessionToken}`,
        "x-oss-account-context-version": "1",
      },
      payload: {
        expectedVersion: 1,
        reason: "Normal saved Schema 027 cancellation awaiting its paid period end",
        idempotencyKey: `schema028-cancel-${randomUUID()}`,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const body = response.json() as {
      cancellation: { requestId: string; executionMode: string };
    };
    assert.equal(body.cancellation.executionMode, "automatic");
  } finally {
    await built.app.close();
  }

  const saved = await database.query<{
    request_id: string;
    execution_id: string;
    provider_operation_id: string;
  }>(
    `SELECT request.id AS request_id, execution.id AS execution_id,
            operation.id AS provider_operation_id
     FROM service_cancellation_requests request
     JOIN service_cancellation_executions execution
       ON execution.cancellation_request_id = request.id
     JOIN provider_operations operation
       ON operation.subject_type = 'service_cancellation_execution'
      AND operation.subject_id = execution.id
      AND operation.kind = 'resource_terminate'
     WHERE request.service_id = $1`,
    [serviceId],
  );
  assert.equal(saved.rowCount, 1);
  return {
    requestId: saved.rows[0]!.request_id,
    executionId: saved.rows[0]!.execution_id,
    providerOperationId: saved.rows[0]!.provider_operation_id,
    serviceId,
  };
}

type SavedSchema027AutomaticCancellation = Readonly<{
  requestId: string;
  executionId: string;
  providerOperationId: string;
  serviceId: string;
}>;

async function saveSchema027UnknownAttempt(
  database: DatabasePool,
  saved: SavedSchema027AutomaticCancellation,
): Promise<string> {
  let dueJobId = "";
  await transaction(database, async (client) => {
    const claimed = await client.query<{ id: string }>(
      `UPDATE durable_jobs job
       SET status = 'running', attempts = 1,
           locked_at = clock_timestamp(), locked_by = 'schema027-normal-worker',
           updated_at = clock_timestamp()
       WHERE job.job_type = 'service.cancellation.due'
         AND job.unique_key = (
           SELECT operation.stable_key
           FROM provider_operations operation
           WHERE operation.id = $1
         )
         AND job.status = 'pending'
       RETURNING job.id`,
      [saved.providerOperationId],
    );
    assert.equal(claimed.rowCount, 1);
    dueJobId = claimed.rows[0]!.id;
    const execution = await client.query(
      `UPDATE service_cancellation_executions
       SET status = 'processing',
           result = '{"status":"processing","providerAction":"terminate"}'::jsonb,
           last_error = NULL, updated_at = clock_timestamp(), version = version + 1
       WHERE id = $1 AND status = 'scheduled'
       RETURNING id`,
      [saved.executionId],
    );
    const operation = await client.query(
      `UPDATE provider_operations
       SET status = 'running', attempt_count = 1,
           last_error = NULL, updated_at = clock_timestamp()
       WHERE id = $1 AND status = 'queued' AND attempt_count = 0
       RETURNING id`,
      [saved.providerOperationId],
    );
    assert.equal(execution.rowCount, 1);
    assert.equal(operation.rowCount, 1);
  });

  const reconcileJobId = randomUUID();
  await transaction(database, async (client) => {
    const reason =
      "Normal Schema 027 reconciliation budget ended without a durable Provider result";
    await client.query(
      `UPDATE provider_operations
       SET status = 'unknown', last_error = $2, updated_at = clock_timestamp()
       WHERE id = $1 AND status = 'running' AND attempt_count = 1`,
      [saved.providerOperationId, reason],
    );
    await client.query(
      `UPDATE service_cancellation_executions
       SET status = 'unknown',
           result = '{"status":"unknown","reconciliation":"query_only"}'::jsonb,
           last_error = $2, updated_at = clock_timestamp(), version = version + 1
       WHERE id = $1 AND status = 'processing'`,
      [saved.executionId, reason],
    );
    await client.query(
      `UPDATE durable_jobs
       SET status = 'completed', locked_at = NULL, locked_by = NULL,
           last_error = NULL, updated_at = clock_timestamp()
       WHERE id = $1 AND status = 'running'`,
      [dueJobId],
    );
    await client.query(
      `INSERT INTO durable_jobs(
         id, job_type, unique_key, payload, status, available_at,
         attempts, last_error, created_at, updated_at
       )
       SELECT $1, 'service.cancellation.reconcile', operation.stable_key,
              jsonb_build_object(
                'requestId', $2::text,
                'executionId', $3::text,
                'serviceId', execution.service_id::text,
                'providerOperationId', operation.id::text
              ),
              'manual', clock_timestamp(), 3, $4,
              clock_timestamp(), clock_timestamp()
       FROM provider_operations operation
       JOIN service_cancellation_executions execution ON execution.id = $3
       WHERE operation.id = $5`,
      [
        reconcileJobId,
        saved.requestId,
        saved.executionId,
        reason,
        saved.providerOperationId,
      ],
    );
    await client.query(
      `UPDATE service_cancellation_executions
       SET status = 'manual',
           result = '{"status":"manual","interventionRequired":true,"potentiallySent":true}'::jsonb,
           last_error = $2, updated_at = clock_timestamp(), version = version + 1
       WHERE id = $1 AND status = 'unknown'`,
      [saved.executionId, reason],
    );
  });
  return reconcileJobId;
}

async function saveSchema027FailedAttemptWithoutResult(
  database: DatabasePool,
  saved: SavedSchema027AutomaticCancellation,
): Promise<void> {
  let dueJobId = "";
  await transaction(database, async (client) => {
    const claimed = await client.query<{ id: string }>(
      `UPDATE durable_jobs job
       SET status = 'running', attempts = 1,
           locked_at = clock_timestamp(), locked_by = 'schema027-rejection-worker',
           updated_at = clock_timestamp()
       WHERE job.job_type = 'service.cancellation.due'
         AND job.unique_key = (
           SELECT operation.stable_key FROM provider_operations operation
           WHERE operation.id = $1
         )
         AND job.status = 'pending'
       RETURNING job.id`,
      [saved.providerOperationId],
    );
    assert.equal(claimed.rowCount, 1);
    dueJobId = claimed.rows[0]!.id;
    const execution = await client.query(
      `UPDATE service_cancellation_executions
       SET status = 'processing',
           result = '{"status":"processing","providerAction":"terminate"}'::jsonb,
           last_error = NULL, updated_at = clock_timestamp(), version = version + 1
       WHERE id = $1 AND status = 'scheduled'
       RETURNING id`,
      [saved.executionId],
    );
    const operation = await client.query(
      `UPDATE provider_operations
       SET status = 'running', attempt_count = 1,
           last_error = NULL, updated_at = clock_timestamp()
       WHERE id = $1 AND status = 'queued' AND attempt_count = 0
       RETURNING id`,
      [saved.providerOperationId],
    );
    assert.equal(execution.rowCount, 1);
    assert.equal(operation.rowCount, 1);
  });

  await transaction(database, async (client) => {
    const reason = "Normal Schema 027 Provider returned a definitive HTTP rejection";
    await client.query(
      `UPDATE provider_operations
       SET status = 'failed', last_error = $2, updated_at = clock_timestamp()
       WHERE id = $1 AND status = 'running' AND attempt_count = 1`,
      [saved.providerOperationId, reason],
    );
    await client.query(
      `UPDATE service_cancellation_executions
       SET status = 'manual',
           result = '{"status":"manual","interventionRequired":true,"potentiallySent":true}'::jsonb,
           last_error = $2, updated_at = clock_timestamp(), version = version + 1
       WHERE id = $1 AND status = 'processing'`,
      [saved.executionId, reason],
    );
    await client.query(
      `UPDATE durable_jobs
       SET status = 'manual', locked_at = NULL, locked_by = NULL,
           last_error = $2, updated_at = clock_timestamp()
       WHERE id = $1 AND status = 'running'`,
      [dueJobId, reason],
    );
  });
}

async function saveSchema027KnownUnsentPreflight(
  database: DatabasePool,
  saved: SavedSchema027AutomaticCancellation,
): Promise<void> {
  await transaction(database, async (client) => {
    const reason =
      "Normal Schema 027 Provider preflight was unavailable before terminate dispatch";
    await client.query(
      `UPDATE provider_operations
       SET status = 'failed', last_error = $2, updated_at = clock_timestamp()
       WHERE id = $1 AND status = 'queued' AND attempt_count = 0`,
      [saved.providerOperationId, reason],
    );
    await client.query(
      `UPDATE service_cancellation_executions
       SET status = 'manual',
           result = '{"status":"manual","interventionRequired":true,"potentiallySent":false}'::jsonb,
           last_error = $2, updated_at = clock_timestamp(), version = version + 1
       WHERE id = $1 AND status = 'scheduled'`,
      [saved.executionId, reason],
    );
    await client.query(
      `UPDATE durable_jobs job
       SET status = 'manual', attempts = 1, last_error = $2,
           updated_at = clock_timestamp()
       WHERE job.job_type = 'service.cancellation.due'
         AND job.unique_key = (
           SELECT operation.stable_key
           FROM provider_operations operation
           WHERE operation.id = $1
         )
         AND job.status = 'pending'`,
      [saved.providerOperationId, reason],
    );
  });
}

async function seedCompletedSchema027ManualCancellation(
  database: DatabasePool,
): Promise<{ actionId: string; createdAt: Date }> {
  const customerUserId = randomUUID();
  const staffUserId = randomUUID();
  const accountId = randomUUID();
  const customerSessionId = randomUUID();
  const staffSessionId = randomUUID();
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const serviceId = randomUUID();
  const requestId = randomUUID();
  const executionId = randomUUID();
  const dueJobId = randomUUID();
  const actionId = randomUUID();
  const requestedAt = new Date();
  const effectiveAt = new Date(requestedAt.getTime() + 500);
  await transaction(database, async (client) => {
    await client.query(
      `INSERT INTO users(id, email, password_hash, locale, email_verified_at)
       VALUES
         ($1, $2, 'schema028-manual-customer', 'en', clock_timestamp()),
         ($3, $4, 'schema028-manual-staff', 'en', clock_timestamp())`,
      [
        customerUserId,
        `schema028-manual-customer-${customerUserId}@example.invalid`,
        staffUserId,
        `schema028-manual-staff-${staffUserId}@example.invalid`,
      ],
    );
    await client.query(
      "INSERT INTO client_accounts(id, name, owner_user_id) VALUES ($1, 'Schema 027 completed manual account', $2)",
      [accountId, customerUserId],
    );
    await client.query(
      `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
       VALUES ($1, $2, 'owner', '[]'::jsonb)`,
      [accountId, customerUserId],
    );
    await client.query(
      `INSERT INTO sessions(
         id, user_id, token_digest, expires_at, active_client_account_id,
         account_context_version
       )
       VALUES
         ($1, $2, $3, clock_timestamp() + interval '2 hours', $4, 1),
         ($5, $6, $7, clock_timestamp() + interval '2 hours', NULL, 0)`,
      [
        customerSessionId,
        customerUserId,
        digestToken(randomBytes(32).toString("base64url")),
        accountId,
        staffSessionId,
        staffUserId,
        digestToken(randomBytes(32).toString("base64url")),
      ],
    );
    await client.query(
      `INSERT INTO staff_members(user_id, roles, permissions)
       VALUES ($1, ARRAY['ServiceOperations']::text[],
               '["services.read","services.manual_fulfillment"]'::jsonb)`,
      [staffUserId],
    );
    await client.query(
      `INSERT INTO reauth_grants(user_id, session_id, expires_at)
       VALUES ($1, $2, clock_timestamp() + interval '10 minutes')`,
      [staffUserId, staffSessionId],
    );
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
        `schema028-manual-order-${orderId}`,
        createHash("sha256").update(orderId).digest("hex"),
      ],
    );
    await client.query(
      `INSERT INTO order_items(
         id, order_id, product_id, product_name, fulfillment_mode,
         billing_cycle, configuration, price_snapshot, client_account_id
       ) VALUES ($1, $2, 'schema028-normal', 'Schema 027 completed manual cancellation',
                 'automatic', 'monthly', '{}'::jsonb, '{}'::jsonb, $3)`,
      [orderItemId, orderId, accountId],
    );
    await client.query(
      `INSERT INTO services(
         id, client_account_id, order_item_id, status, billing_cycle,
         activated_at, term_start, term_end
       ) VALUES ($1, $2, $3, 'active', 'monthly', clock_timestamp(),
                 clock_timestamp() - interval '1 month', $4)`,
      [serviceId, accountId, orderItemId, effectiveAt],
    );
    await client.query(
      `INSERT INTO service_provider_bindings(
         service_id, provider_installation_id, overdue_action_snapshot,
         capability_snapshot, product_policy_version,
         cycle_end_cancellation_mode_snapshot,
         cycle_end_cancellation_execution_mode_snapshot,
         cycle_end_cancellation_min_notice_hours_snapshot,
         cycle_end_cancellation_requirement_key_snapshot
       ) VALUES (
         $1, 'mock-provisioning-v1', 'automatic',
         '["resource_create","resource_reconcile","resource_suspend","resource_resume","resource_terminate","resource.start","resource.stop","resource.reboot"]'::jsonb,
         1, 'self_service', 'automatic', 0, NULL
       )`,
      [serviceId],
    );
    await client.query(
      `INSERT INTO service_cancellation_requests(
         id, service_id, client_account_id, requested_by_user_id,
         requested_session_id, effective_at, expected_service_version,
         product_policy_version, policy_snapshot, notice_qualified_at,
         authorization_ticket_id, reason, idempotency_key,
         request_fingerprint, result, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 1, 1,
         '{"schedulingMode":"self_service","executionMode":"automatic","minimumNoticeHours":0,"requirementKey":null}'::jsonb,
         $7, NULL, 'Normal completed manual cancellation saved by Schema 027',
         $8, $9, '{"status":"scheduled"}'::jsonb, $7
       )`,
      [
        requestId,
        serviceId,
        accountId,
        customerUserId,
        customerSessionId,
        effectiveAt,
        requestedAt,
        `schema028-manual-${requestId}`,
        createHash("sha256").update(requestId).digest("hex"),
      ],
    );
    await client.query(
      `UPDATE services
       SET cancellation_request_id = $2,
           cancellation_scheduled_at = $3,
           cancellation_effective_at = $4,
           updated_at = $3,
           version = version + 1
       WHERE id = $1 AND version = 1`,
      [serviceId, requestId, requestedAt, effectiveAt],
    );
    await client.query(
      `UPDATE provider_installation_capabilities
       SET enabled = false, version = version + 1, updated_at = clock_timestamp()
       WHERE provider_installation_id = 'mock-provisioning-v1'`,
    );
    await client.query(
      `INSERT INTO service_cancellation_executions(
         id, cancellation_request_id, service_id, execution_mode,
         provider_installation_id, provider_capability_snapshot, status,
         result, version, created_at, updated_at
       ) VALUES (
         $1, $2, $3, 'manual', NULL,
         '{"atBinding":["resource_create","resource_reconcile","resource_suspend","resource_resume","resource_terminate","resource.start","resource.stop","resource.reboot"],"current":["resource_create","resource_reconcile","resource_suspend","resource_resume","resource_terminate","resource.start","resource.stop","resource.reboot"]}'::jsonb,
         'scheduled', '{"status":"scheduled"}'::jsonb,
         1, $4, $4
       )`,
      [executionId, requestId, serviceId, requestedAt],
    );
    await client.query(
      `UPDATE provider_installation_capabilities
       SET enabled = true, version = version + 1, updated_at = clock_timestamp()
       WHERE provider_installation_id = 'mock-provisioning-v1'`,
    );
    await client.query(
      `INSERT INTO durable_jobs(
         id, job_type, unique_key, payload, status, available_at,
         attempts, last_error, created_at, updated_at
       ) VALUES (
         $1, 'service.cancellation.due', $2, $3, 'pending', $4, 0,
         NULL, $5, $5
       )`,
      [
        dueJobId,
        `service-cancellation:${requestId}:terminate`,
        { cancellationRequestId: requestId, executionId, serviceId },
        effectiveAt,
        requestedAt,
      ],
    );
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 650));
  await transaction(database, async (client) => {
    await client.query(
      `UPDATE service_cancellation_executions
       SET status = 'manual',
           result = '{"status":"manual","interventionRequired":true}'::jsonb,
           last_error = 'Normal Schema 027 manual delivery required Staff completion',
           updated_at = clock_timestamp(), version = version + 1
       WHERE id = $1 AND version = 1 AND status = 'scheduled'`,
      [executionId],
    );
    await client.query(
      `UPDATE durable_jobs
       SET status = 'manual', attempts = 1,
           last_error = 'Normal Schema 027 manual delivery required Staff completion',
           updated_at = clock_timestamp()
       WHERE id = $1 AND status = 'pending'`,
      [dueJobId],
    );
  });
  const completedAt = new Date();
  const actionResult = {
      actionId,
      executionId,
      serviceId,
      executionStatus: "terminated",
      serviceStatus: "terminated",
      takeoverKind: "manual_delivery",
  };
  await transaction(database, async (client) => {
    await client.query(
      `INSERT INTO service_cancellation_manual_actions(
         id, execution_id, service_id, staff_user_id, staff_session_id,
         staff_client_account_id, takeover_kind, expected_execution_version,
         expected_service_version, reason, idempotency_key,
         request_fingerprint, result, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'manual_delivery', 2, 2,
         'Normal Schema 027 Staff completed a manual delivery cancellation',
         $7, $8, $9, $10
       )`,
      [
        actionId,
        executionId,
        serviceId,
        staffUserId,
        staffSessionId,
        accountId,
        `schema028-action-${actionId}`,
        createHash("sha256").update(actionId).digest("hex"),
        actionResult,
        completedAt,
      ],
    );
    await client.query(
      `UPDATE services
       SET status = 'terminated', updated_at = $2, version = version + 1
       WHERE id = $1 AND version = 2`,
      [serviceId, completedAt],
    );
    await client.query(
      `UPDATE service_cancellation_executions
       SET status = 'terminated', result = $2, completed_at = $3,
           updated_at = $3, version = version + 1
       WHERE id = $1 AND version = 2`,
      [executionId, actionResult, completedAt],
    );
  });
  return { actionId, createdAt: completedAt };
}

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  pool = new pg.Pool({
    connectionString: databaseUrl.toString(),
    max: 8,
    application_name: "opensales-schema028-normal-integration",
    options: "-c search_path=pg_catalog,public",
  });
  await runMigrations(pool, {
    throughVersion: "027_stage_c_notification_templates_preferences",
  });
  const savedUnknown = await seedScheduledCancellation(pool);
  const savedFailedWithoutResult = await seedScheduledCancellation(pool);
  const savedKnownUnsent = await seedScheduledCancellation(pool);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 650));
  const savedReconcileJobId = await saveSchema027UnknownAttempt(pool, savedUnknown);
  await saveSchema027FailedAttemptWithoutResult(pool, savedFailedWithoutResult);
  await saveSchema027KnownUnsentPreflight(pool, savedKnownUnsent);
  const savedManualAction = await seedCompletedSchema027ManualCancellation(pool);
  await runMigrations(pool);

  const native = await assertSchema028NativeSafe(pool);
  assert.deepEqual(native, {
    installedSchemaVersion: SCHEMA_028,
    applicationSchemaVersion: SCHEMA_028,
    mode: "native",
    safe: true,
    blockers: [],
  });
  assert.deepEqual(
    (await pool.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map(
      (row) => (row as { version: string }).version,
    ),
    [...EXPECTED_SCHEMA_028_HISTORY],
  );
  assert.equal(
    schema028CatalogDigest(await schema028CatalogFingerprintInput(pool)),
    SCHEMA_028_CATALOG_DIGEST,
  );
  const forward = await pool.query<{
    operation_status: string;
    operation_attempt_count: number;
    attempt_id: string | null;
    execution_version: number | null;
    service_version: number | null;
    dispatched_at: Date | null;
    evidence_origin: string | null;
    request_snapshot: Record<string, unknown> | null;
    result_count: string;
    execution_status: string;
    reconcile_job_id: string | null;
    reconcile_job_status: string | null;
    reconcile_job_attempts: number | null;
    reconcile_job_payload: Record<string, unknown> | null;
    reconcile_job_locked_at: Date | null;
    reconcile_job_locked_by: string | null;
  }>(
    `SELECT operation.status AS operation_status,
            operation.attempt_count AS operation_attempt_count,
            attempt.id AS attempt_id,
            attempt.execution_version,
            attempt.service_version,
            attempt.dispatched_at,
            attempt.evidence_origin,
            attempt.request_snapshot,
            (SELECT count(*) FROM service_cancellation_provider_results result
             WHERE result.execution_id = $1)::text AS result_count
            , execution.status AS execution_status,
            reconcile_job.id AS reconcile_job_id,
            reconcile_job.status AS reconcile_job_status,
            reconcile_job.attempts AS reconcile_job_attempts,
            reconcile_job.payload AS reconcile_job_payload,
            reconcile_job.locked_at AS reconcile_job_locked_at,
            reconcile_job.locked_by AS reconcile_job_locked_by
     FROM provider_operations operation
     JOIN service_cancellation_executions execution
       ON execution.id = operation.subject_id
     LEFT JOIN service_cancellation_provider_attempts attempt
       ON attempt.provider_operation_id = operation.id
     LEFT JOIN durable_jobs reconcile_job
       ON reconcile_job.job_type = 'service.cancellation.reconcile'
      AND reconcile_job.unique_key = operation.stable_key
     WHERE operation.id = $2`,
    [savedUnknown.executionId, savedUnknown.providerOperationId],
  );
  const forwardedUnknown = forward.rows[0];
  assert.ok(forwardedUnknown?.attempt_id);
  assert.equal(forwardedUnknown.operation_status, "unknown");
  assert.equal(forwardedUnknown.operation_attempt_count, 1);
  assert.equal(forwardedUnknown.execution_version, null);
  assert.equal(forwardedUnknown.service_version, null);
  assert.equal(forwardedUnknown.dispatched_at, null);
  assert.equal(forwardedUnknown.evidence_origin, "schema027_forward");
  assert.deepEqual(forwardedUnknown.request_snapshot, {
    action: "terminate",
    providerOperationId: savedUnknown.providerOperationId,
    serviceId: savedUnknown.serviceId,
    externalResourceId: `schema028-resource-${savedUnknown.serviceId}`,
    legacyDispatchMetadata: "unavailable",
  });
  assert.equal(forwardedUnknown.result_count, "0");
  assert.equal(forwardedUnknown.execution_status, "manual");
  assert.equal(forwardedUnknown.reconcile_job_id, savedReconcileJobId);
  assert.equal(forwardedUnknown.reconcile_job_status, "pending");
  assert.equal(forwardedUnknown.reconcile_job_attempts, 0);
  assert.deepEqual(forwardedUnknown.reconcile_job_payload, {
    cancellationRequestId: savedUnknown.requestId,
    executionId: savedUnknown.executionId,
    serviceId: savedUnknown.serviceId,
    providerOperationId: savedUnknown.providerOperationId,
  });
  assert.equal(forwardedUnknown.reconcile_job_locked_at, null);
  assert.equal(forwardedUnknown.reconcile_job_locked_by, null);

  const forwardedFailedWithoutResult = await pool.query<{
    operation_status: string;
    operation_attempt_count: number;
    evidence_origin: string;
    execution_version: number | null;
    service_version: number | null;
    dispatched_at: Date | null;
    result_count: string;
    execution_status: string;
    reconcile_job_status: string;
    reconcile_job_attempts: number;
    reconcile_job_payload: Record<string, unknown>;
    reconcile_job_locked_at: Date | null;
    reconcile_job_locked_by: string | null;
  }>(
    `SELECT operation.status AS operation_status,
            operation.attempt_count AS operation_attempt_count,
            attempt.evidence_origin,
            attempt.execution_version,
            attempt.service_version,
            attempt.dispatched_at,
            (SELECT count(*)::text
             FROM service_cancellation_provider_results result
             WHERE result.provider_operation_id = operation.id) AS result_count,
            execution.status AS execution_status,
            reconcile_job.status AS reconcile_job_status,
            reconcile_job.attempts AS reconcile_job_attempts,
            reconcile_job.payload AS reconcile_job_payload,
            reconcile_job.locked_at AS reconcile_job_locked_at,
            reconcile_job.locked_by AS reconcile_job_locked_by
     FROM provider_operations operation
     JOIN service_cancellation_executions execution ON execution.id = operation.subject_id
     JOIN service_cancellation_provider_attempts attempt
       ON attempt.provider_operation_id = operation.id
     JOIN durable_jobs reconcile_job
       ON reconcile_job.job_type = 'service.cancellation.reconcile'
      AND reconcile_job.unique_key = operation.stable_key
     WHERE operation.id = $1`,
    [savedFailedWithoutResult.providerOperationId],
  );
  assert.deepEqual(forwardedFailedWithoutResult.rows[0], {
    operation_status: "unknown",
    operation_attempt_count: 1,
    evidence_origin: "schema027_forward",
    execution_version: null,
    service_version: null,
    dispatched_at: null,
    result_count: "0",
    execution_status: "manual",
    reconcile_job_status: "pending",
    reconcile_job_attempts: 0,
    reconcile_job_payload: {
      cancellationRequestId: savedFailedWithoutResult.requestId,
      executionId: savedFailedWithoutResult.executionId,
      serviceId: savedFailedWithoutResult.serviceId,
      providerOperationId: savedFailedWithoutResult.providerOperationId,
    },
    reconcile_job_locked_at: null,
    reconcile_job_locked_by: null,
  });

  const forwardedKnownUnsent = await pool.query<{
    operation_status: string;
    operation_attempt_count: number;
    execution_status: string;
    attempt_count: string;
    reconcile_job_count: string;
    due_job_status: string;
  }>(
    `SELECT operation.status AS operation_status,
            operation.attempt_count AS operation_attempt_count,
            execution.status AS execution_status,
            (SELECT count(*)::text
             FROM service_cancellation_provider_attempts attempt
             WHERE attempt.provider_operation_id = operation.id) AS attempt_count,
            (SELECT count(*)::text
             FROM durable_jobs reconcile_job
             WHERE reconcile_job.job_type = 'service.cancellation.reconcile'
               AND reconcile_job.unique_key = operation.stable_key) AS reconcile_job_count,
            due_job.status AS due_job_status
     FROM provider_operations operation
     JOIN service_cancellation_executions execution ON execution.id = operation.subject_id
     JOIN durable_jobs due_job
       ON due_job.job_type = 'service.cancellation.due'
      AND due_job.unique_key = operation.stable_key
     WHERE operation.id = $1`,
    [savedKnownUnsent.providerOperationId],
  );
  assert.deepEqual(forwardedKnownUnsent.rows[0], {
    operation_status: "queued",
    operation_attempt_count: 0,
    execution_status: "manual",
    attempt_count: "0",
    reconcile_job_count: "0",
    due_job_status: "manual",
  });
  const forwardedManualAction = await pool.query<{
    created_at: Date;
    completed_at: Date;
  }>(
    `SELECT created_at, completed_at
     FROM service_cancellation_manual_actions
     WHERE id = $1`,
    [savedManualAction.actionId],
  );
  assert.equal(forwardedManualAction.rowCount, 1);
  assert.equal(
    forwardedManualAction.rows[0]!.created_at.toISOString(),
    savedManualAction.createdAt.toISOString(),
  );
  assert.equal(
    forwardedManualAction.rows[0]!.completed_at.toISOString(),
    savedManualAction.createdAt.toISOString(),
  );

  const releaseGuard = await holdSchema028ApplicationGuard(pool);
  await releaseGuard();
  console.log(
    "Schema 028 PostgreSQL 18 normal integration: PASS — legitimate saved Schema 027 known-unsent, attempted-unknown, definitive-rejection-without-result, and completed manual cancellations upgraded forward without invented Provider metadata; exact reconciliation recovery, history, catalog, state, and application guard accepted.",
  );
} finally {
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
