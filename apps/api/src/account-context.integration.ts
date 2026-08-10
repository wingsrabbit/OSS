// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { assertSchema018NativeSafe } from "@opensales/core/schema-017-018-native-compatibility";
import { assertSchema019NativeSafe } from "@opensales/core/schema-018-019-native-compatibility";
import pg from "pg";
import { buildApp } from "./app.js";
import { digestToken, passwordHash } from "./auth.js";
import type { Config } from "./config.js";
import {
  assertSchemaCompatible,
  runMigrations,
  transaction,
  type DatabasePool,
} from "./database.js";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) {
  throw new Error("ADMIN_DATABASE_URL is required for account-context integration");
}

const databaseName = `oss_account_context_${randomUUID().replaceAll("-", "")}`;
const testDatabaseUrl = new URL(adminDatabaseUrl);
testDatabaseUrl.pathname = `/${databaseName}`;
const admin = new pg.Client({ connectionString: adminDatabaseUrl });
let pool: DatabasePool | null = null;
let app: Awaited<ReturnType<typeof buildApp>>["app"] | null = null;

const config: Config = {
  DATABASE_URL: testDatabaseUrl.toString(),
  OSS_ENV: "test",
  OSS_LOG_LEVEL: "silent",
  OSS_PUBLIC_URL: "http://127.0.0.1:3000",
  API_HOST: "127.0.0.1",
  API_PORT: 3000,
  GLOBAL_RATE_LIMIT_MAX: 10_000,
  SESSION_COOKIE_NAME: "oss_account_context_session",
  SESSION_TTL_HOURS: 24,
  VERIFICATION_TTL_MINUTES: 30,
  WEB_ORIGIN: "http://127.0.0.1:5173",
  MOCK_MAILBOX_URL: "http://127.0.0.1:4000",
  LAB_MAILBOX_TOKEN: "synthetic-account-context-mailbox-token",
  PROVIDER_OPERATION_CAPABILITY_SECRET:
    "synthetic-account-context-provider-capability",
  PAYMENT_METHOD_TOKEN_KEY: Buffer.alloc(32, 81).toString("base64url"),
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY: Buffer.alloc(32, 82).toString("base64url"),
  MOCK_PAYMENT_WEBHOOK_SECRET: "synthetic-account-context-payment-hook",
  MOCK_PROVISIONING_WEBHOOK_SECRET:
    "synthetic-account-context-provisioning-hook",
  LAB_MAILBOX_ENABLED: false,
};

type BaseIdentity = Readonly<{
  userId: string;
  accountIds: readonly string[];
  sessionId: string;
  sessionToken: string;
  email: string;
}>;

function json<T>(response: Readonly<{ body: string }>): T {
  return JSON.parse(response.body) as T;
}

function assertCursorPreservesPostgresMicroseconds(cursor: string, label: string): void {
  const decoded = JSON.parse(
    Buffer.from(cursor, "base64url").toString("utf8"),
  ) as { at?: unknown };
  assert.ok(typeof decoded.at === "string", `${label} cursor must carry a timestamp`);
  assert.match(
    decoded.at,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    `${label} cursor must preserve PostgreSQL microseconds`,
  );
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
}

async function expectPgCode(
  work: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(work, (error: unknown) => errorCode(error) === code);
}

async function createBaseIdentity(input: Readonly<{
  label: string;
  accountCount: number;
  passwordHash: string;
}>): Promise<BaseIdentity> {
  if (!pool) throw new Error("Test database is not ready");
  const userId = randomUUID();
  const sessionId = randomUUID();
  const sessionToken = randomBytes(32).toString("base64url");
  const email = `${input.label}-${databaseName}@example.invalid`;
  await pool.query(
    `INSERT INTO users(id, email, password_hash, email_verified_at)
     VALUES ($1, $2, $3, pg_catalog.now())`,
    [userId, email, input.passwordHash],
  );
  const accountIds: string[] = [];
  for (let index = 0; index < input.accountCount; index += 1) {
    const accountId = randomUUID();
    accountIds.push(accountId);
    await transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO client_accounts(id, name, owner_user_id)
         VALUES ($1, $2, $3)`,
        [accountId, `${input.label} Account ${index + 1}`, userId],
      );
      await client.query(
        `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
         VALUES ($1, $2, 'owner', '["*"]'::jsonb)`,
        [accountId, userId],
      );
    });
  }
  await pool.query(
    `INSERT INTO sessions(id, user_id, token_digest, expires_at)
     VALUES ($1, $2, $3, pg_catalog.now() + interval '1 hour')`,
    [sessionId, userId, digestToken(sessionToken)],
  );
  return { userId, accountIds, sessionId, sessionToken, email };
}

async function createContextMember(input: Readonly<{
  clientAccountId: string;
  role: "owner" | "billing" | "technical" | "viewer";
  permissions?: readonly string[];
  label: string;
}>): Promise<BaseIdentity> {
  if (!pool) throw new Error("Test database is not ready");
  const userId = randomUUID();
  const sessionId = randomUUID();
  const sessionToken = randomBytes(32).toString("base64url");
  const email = `${input.label}-${databaseName}@example.invalid`;
  await pool.query(
    `INSERT INTO users(id, email, password_hash, email_verified_at)
     VALUES ($1, $2, 'synthetic-not-a-password', pg_catalog.now())`,
    [userId, email],
  );
  await pool.query(
    `INSERT INTO client_memberships(
       client_account_id, user_id, role, permissions
     ) VALUES ($1, $2, $3, $4::jsonb)`,
    [
      input.clientAccountId,
      userId,
      input.role,
      JSON.stringify(input.permissions ?? []),
    ],
  );
  await pool.query(
    `INSERT INTO sessions(
       id, user_id, token_digest, expires_at,
       active_client_account_id, account_context_version
     ) VALUES (
       $1, $2, $3, pg_catalog.now() + interval '1 hour', $4, 1
     )`,
    [sessionId, userId, digestToken(sessionToken), input.clientAccountId],
  );
  return {
    userId,
    accountIds: [input.clientAccountId],
    sessionId,
    sessionToken,
    email,
  };
}

async function collectPages<
  T extends { id?: string; userId?: string; clientAccountId?: string },
>(input: Readonly<{
  url: string;
  cookie: string;
  limit?: number;
}>): Promise<Readonly<{ items: T[]; firstCursor: string | null }>> {
  if (!app) throw new Error("App is not ready");
  const items: T[] = [];
  let cursor: string | null = null;
  let firstCursor: string | null = null;
  do {
    const separator = input.url.includes("?") ? "&" : "?";
    const response: Awaited<ReturnType<NonNullable<typeof app>["inject"]>> =
      await app.inject({
      method: "GET",
      url:
        `${input.url}${separator}limit=${input.limit ?? 10}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
      headers: { cookie: input.cookie },
      });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(response.headers["x-oss-account-context-version"]);
    const page = json<{
      items: T[];
      hasMore: boolean;
      nextCursor: string | null;
    }>(response);
    items.push(...page.items);
    if (!firstCursor) firstCursor = page.nextCursor;
    assert.equal(page.hasMore, page.nextCursor !== null);
    if (page.nextCursor) {
      assertCursorPreservesPostgresMicroseconds(page.nextCursor, input.url);
    }
    cursor = page.nextCursor;
  } while (cursor);
  const ids = items.map((item) => item.id ?? item.userId ?? item.clientAccountId);
  assert.equal(new Set(ids).size, ids.length, `${input.url} returned a duplicate`);
  return { items, firstCursor };
}

async function waitForBlockedQuery(fragment: string): Promise<void> {
  if (!pool) throw new Error("Test database is not ready");
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ blocked: boolean }>(
      `SELECT pg_catalog.bool_or(
         wait_event_type = 'Lock' AND pg_catalog.strpos(query, $1) > 0
       ) AS blocked
       FROM pg_catalog.pg_stat_activity
       WHERE datname = pg_catalog.current_database()
         AND pid <> pg_catalog.pg_backend_pid()`,
      [fragment],
    );
    if (result.rows[0]?.blocked) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for blocked PostgreSQL query: ${fragment}`);
}

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  pool = new pg.Pool({
    connectionString: testDatabaseUrl.toString(),
    max: 16,
    options: "-c search_path=pg_catalog,public",
    statement_timeout: 15_000,
    application_name: "opensales-account-context-integration",
  });

  await runMigrations(pool, { throughVersion: "018_stage_c_support_tickets" });
  const loginPassword = "synthetic-account-context-password";
  const loginPasswordHash = await passwordHash(loginPassword);
  const owner = await createBaseIdentity({
    label: "single-owner",
    accountCount: 1,
    passwordHash: loginPasswordHash,
  });
  const multi = await createBaseIdentity({
    label: "multi-owner",
    accountCount: 2,
    passwordHash: loginPasswordHash,
  });
  const contextPager = await createBaseIdentity({
    label: "context-pager",
    accountCount: 31,
    passwordHash: loginPasswordHash,
  });
  const ownerAccountId = owner.accountIds[0];
  const secondAccountId = multi.accountIds[0];
  const thirdAccountId = multi.accountIds[1];
  if (!ownerAccountId || !secondAccountId || !thirdAccountId) {
    throw new Error("Unable to create account-context fixtures");
  }

  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const manualHistoryOrderItemId = randomUUID();
  const suppressedReminderOrderItemId = randomUUID();
  const serviceId = randomUUID();
  const manualHistoryServiceId = randomUUID();
  const suppressedReminderServiceId = randomUUID();
  const invoiceId = randomUUID();
  const manualHistoryInvoiceId = randomUUID();
  const suppressedReminderInvoiceId = randomUUID();
  const manualHistoryAutomationRunId = randomUUID();
  const paymentAttemptId = randomUUID();
  const reminderIntentIds = [randomUUID(), randomUUID(), randomUUID()] as const;
  const reminderFactIds = [randomUUID(), randomUUID(), randomUUID()] as const;
  const reminderOperationIds = [randomUUID(), randomUUID(), randomUUID()] as const;
  const suppressedReminderIntentId = randomUUID();
  const suppressedReminderOutboxId = randomUUID();
  const priceSnapshot = {
    currency: "USD",
    billingCycle: "monthly",
    productId: "synthetic-context-product",
    productName: "Synthetic Context Product",
    fulfillmentMode: "automatic",
    components: [],
    oneTimeSubtotalMinor: "0",
    setupMinor: "0",
    recurringSubtotalMinor: "500",
    invoiceTotalMinor: "500",
  };
  await pool.query(
    `INSERT INTO orders(
       id, client_account_id, submitted_by_user_id, status, currency,
       price_snapshot, one_time_minor, setup_minor, recurring_minor,
       total_minor, idempotency_key, request_fingerprint
     ) VALUES (
       $1, $2, $3, 'completed', 'USD', $4, 0, 0, 500, 500, $5, $6
     )`,
    [
      orderId,
      ownerAccountId,
      owner.userId,
      priceSnapshot,
      `context-order:${orderId}`,
      `context-order-fingerprint:${orderId}`,
    ],
  );
  await pool.query(
    `INSERT INTO order_items(
       id, order_id, product_id, product_name, fulfillment_mode,
       billing_cycle, configuration, price_snapshot
     ) VALUES (
       $1, $2, 'synthetic-context-product', 'Synthetic Context Product',
       'automatic', 'monthly', '{}'::jsonb, $3
     )`,
    [orderItemId, orderId, priceSnapshot],
  );
  await pool.query(
    `INSERT INTO services(
       id, client_account_id, order_item_id, status, billing_cycle
     ) VALUES ($1, $2, $3, 'pending', 'monthly')`,
    [serviceId, ownerAccountId, orderItemId],
  );
  await pool.query(
    `INSERT INTO order_items(
       id, order_id, product_id, product_name, fulfillment_mode,
       billing_cycle, configuration, price_snapshot
     ) VALUES (
       $1, $2, 'synthetic-renewal-history-product',
       'Synthetic Renewal History Product',
       'automatic', 'monthly', '{}'::jsonb, $3
     )`,
    [manualHistoryOrderItemId, orderId, priceSnapshot],
  );
  await pool.query(
    `INSERT INTO services(
       id, client_account_id, order_item_id, status, billing_cycle,
       activated_at, term_start, term_end
     ) VALUES (
       $1, $2, $3, 'active', 'monthly',
       '2026-01-01T00:00:00.000Z'::timestamptz,
       '2026-01-01T00:00:00.000Z'::timestamptz,
       '2026-02-01T00:00:00.000Z'::timestamptz
     )`,
    [manualHistoryServiceId, ownerAccountId, manualHistoryOrderItemId],
  );
  await pool.query(
    `INSERT INTO order_items(
       id, order_id, product_id, product_name, fulfillment_mode,
       billing_cycle, configuration, price_snapshot
     ) VALUES (
       $1, $2, 'synthetic-suppressed-renewal-product',
       'Synthetic Suppressed Renewal Product',
       'automatic', 'monthly', '{}'::jsonb, $3
     )`,
    [suppressedReminderOrderItemId, orderId, priceSnapshot],
  );
  await pool.query(
    `INSERT INTO services(
       id, client_account_id, order_item_id, status, billing_cycle,
       activated_at, term_start, term_end
     ) VALUES (
       $1, $2, $3, 'active', 'monthly',
       '2026-01-01T00:00:00.000Z'::timestamptz,
       '2026-01-01T00:00:00.000Z'::timestamptz,
       '2026-02-01T00:00:00.000Z'::timestamptz
     )`,
    [
      suppressedReminderServiceId,
      ownerAccountId,
      suppressedReminderOrderItemId,
    ],
  );
  const invoiceClient = await pool.connect();
  try {
    await invoiceClient.query("BEGIN");
    await invoiceClient.query(
      `INSERT INTO invoices(
         id, client_account_id, order_id, currency, total_minor, due_at
       ) VALUES ($1, $2, $3, 'USD', 500, pg_catalog.now() + interval '7 days')`,
      [invoiceId, ownerAccountId, orderId],
    );
    await invoiceClient.query(
      `INSERT INTO invoice_lines(invoice_id, kind, description, amount_minor)
       VALUES ($1, 'recurring', 'Synthetic Context Product', 500)`,
      [invoiceId],
    );
    await invoiceClient.query(
      `INSERT INTO invoices(
         id, client_account_id, order_id, currency, total_minor, due_at
       ) VALUES (
         $1, $2, NULL, 'USD', 500, '2026-02-01T00:00:00.000Z'::timestamptz
       )`,
      [manualHistoryInvoiceId, ownerAccountId],
    );
    await invoiceClient.query(
      `INSERT INTO invoice_lines(invoice_id, kind, description, amount_minor)
       VALUES ($1, 'recurring', 'Synthetic Manual Notification Retry', 500)`,
      [manualHistoryInvoiceId],
    );
    await invoiceClient.query(
      `INSERT INTO invoices(
         id, client_account_id, order_id, currency, total_minor, due_at
       ) VALUES (
         $1, $2, NULL, 'USD', 500, '2026-02-01T00:00:00.000Z'::timestamptz
       )`,
      [suppressedReminderInvoiceId, ownerAccountId],
    );
    await invoiceClient.query(
      `INSERT INTO invoice_lines(invoice_id, kind, description, amount_minor)
       VALUES ($1, 'recurring', 'Synthetic Suppressed Renewal', 500)`,
      [suppressedReminderInvoiceId],
    );
    await invoiceClient.query("COMMIT");
  } catch (error) {
    await invoiceClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    invoiceClient.release();
  }
  await pool.query(
    `INSERT INTO billing_automation_runs(
       id, policy_id, business_date, effective_at,
       requested_by_user_id, reason
     ) VALUES (
       $1, 'default', '2026-01-31',
       '2026-01-31T00:00:00.000Z'::timestamptz,
       $2, 'Synthetic renewal notification relationship fixture'
     )`,
    [manualHistoryAutomationRunId, owner.userId],
  );
  await pool.query(
    `INSERT INTO service_renewals(
       service_id, invoice_id, automation_run_id,
       period_start, period_end, recurring_minor, currency, price_snapshot
     ) VALUES (
       $1, $2, $3,
       '2026-02-01T00:00:00.000Z'::timestamptz,
       '2026-03-01T00:00:00.000Z'::timestamptz,
       500, 'USD', $4
     )`,
    [
      manualHistoryServiceId,
      manualHistoryInvoiceId,
      manualHistoryAutomationRunId,
      priceSnapshot,
    ],
  );
  await pool.query(
    `INSERT INTO service_renewals(
       service_id, invoice_id, automation_run_id,
       period_start, period_end, recurring_minor, currency, price_snapshot
     ) VALUES (
       $1, $2, $3,
       '2026-02-01T00:00:00.000Z'::timestamptz,
       '2026-03-01T00:00:00.000Z'::timestamptz,
       500, 'USD', $4
     )`,
    [
      suppressedReminderServiceId,
      suppressedReminderInvoiceId,
      manualHistoryAutomationRunId,
      priceSnapshot,
    ],
  );
  await pool.query(
    `INSERT INTO payment_attempts(
       id, client_account_id, invoice_id, provider_installation_id,
       external_payment_id, status, amount_minor, principal_minor, fee_minor,
       currency, scenario, idempotency_key, request_fingerprint,
       provider_occurred_at
     ) VALUES (
       $1, $2, $3, 'mock-payment', $4, 'succeeded', 500, 500, 0,
       'USD', 'success', $5, $6, pg_catalog.now()
     )`,
    [
      paymentAttemptId,
      secondAccountId,
      invoiceId,
      `context-external:${paymentAttemptId}`,
      `context-payment:${paymentAttemptId}`,
      `context-payment-fingerprint:${paymentAttemptId}`,
    ],
  );
  await pool.query(
    `INSERT INTO payment_allocations(payment_attempt_id, invoice_id, amount_minor)
     VALUES ($1, $2, 500)`,
    [paymentAttemptId, invoiceId],
  );
  for (const [index, status] of ["delivered", "failed", "failed"].entries()) {
    const outboxId = reminderOperationIds[index];
    const kind =
      index === 0 ? "renewal_created" : index === 1 ? "pre_due" : "overdue_first";
    const reminderInvoiceId = manualHistoryInvoiceId;
    const reminderServiceId = manualHistoryServiceId;
    const dueAt = "2026-02-01T00:00:00.000Z";
    await pool.query(
      `INSERT INTO outbox(id, event_type, unique_key, payload, published_at)
       VALUES (
         $1, 'notification.renewal_reminder_requested', $2, $3,
         '2026-01-15T10:11:13Z'::timestamptz + $4::integer * interval '1 second'
       )`,
      [
        outboxId,
        `renewal:${reminderInvoiceId}:${kind}`,
        {
          email: owner.email,
          locale: "en",
          invoiceId: reminderInvoiceId,
          serviceId: reminderServiceId,
          kind,
          offsetDays: 0,
          currency: "USD",
          dueAt,
          amountDueMinor: "500",
        },
        index,
      ],
    );
    await pool.query(
      `INSERT INTO durable_jobs(
         job_type, unique_key, payload, status, attempts, updated_at
       ) VALUES (
         'notification.send', $1, $2, 'completed', 1,
         '2026-01-15T10:11:14Z'::timestamptz + $3::integer * interval '1 second'
       )`,
      [`outbox:${outboxId}`, { outboxId }, index],
    );
    await pool.query(
      `INSERT INTO renewal_reminder_intents(
         id, invoice_id, service_id, kind, offset_days, policy_snapshot,
         email, locale, due_at, amount_due_minor, outbox_id
       ) VALUES (
         $1, $2, $3, $4, 0, '{}'::jsonb, $5, 'en',
         '2026-02-01T00:00:00Z'::timestamptz, 500, $6
       )`,
      [
        reminderIntentIds[index],
        reminderInvoiceId,
        reminderServiceId,
        kind,
        owner.email,
        outboxId,
      ],
    );
    await pool.query(
      `INSERT INTO renewal_reminder_delivery_facts(
         id, intent_id, provider_installation_id, provider_message_id,
         status, provider_occurred_at, recorded_at
       ) VALUES (
         $1, $2, 'mock-mail-v1', $3, $4,
         '2026-01-15T10:11:12Z'::timestamptz + $5::integer * interval '1 second',
         '2026-01-15T10:12:12Z'::timestamptz + $5::integer * interval '1 second'
       )`,
      [
        reminderFactIds[index],
        reminderIntentIds[index],
        reminderOperationIds[index],
        status,
        index,
      ],
    );
  }
  const suppressedKind = "overdue_first";
  const suppressedDueAt = "2026-02-01T00:00:00.000Z";
  await pool.query(
    `INSERT INTO outbox(id, event_type, unique_key, payload)
     VALUES ($1, 'notification.renewal_reminder_requested', $2, $3)`,
    [
      suppressedReminderOutboxId,
      `renewal:${suppressedReminderInvoiceId}:${suppressedKind}`,
      {
        email: owner.email,
        locale: "en",
        invoiceId: suppressedReminderInvoiceId,
        serviceId: suppressedReminderServiceId,
        kind: suppressedKind,
        offsetDays: 0,
        currency: "USD",
        dueAt: suppressedDueAt,
        amountDueMinor: "500",
      },
    ],
  );
  await pool.query(
    `INSERT INTO durable_jobs(job_type, unique_key, payload)
     VALUES ('notification.send', $1, $2)`,
    [
      `outbox:${suppressedReminderOutboxId}`,
      { outboxId: suppressedReminderOutboxId },
    ],
  );
  await pool.query(
    `INSERT INTO renewal_reminder_intents(
       id, invoice_id, service_id, kind, offset_days, policy_snapshot,
       email, locale, due_at, amount_due_minor, outbox_id
     ) VALUES (
       $1, $2, $3, $4, 0, '{}'::jsonb, $5, 'en', $6, 500, $7
     )`,
    [
      suppressedReminderIntentId,
      suppressedReminderInvoiceId,
      suppressedReminderServiceId,
      suppressedKind,
      owner.email,
      suppressedDueAt,
      suppressedReminderOutboxId,
    ],
  );
  await pool.query(
    `INSERT INTO renewal_reminder_suppressions(intent_id, reason)
     VALUES ($1, 'Synthetic cancellation suppression before dispatch')`,
    [suppressedReminderIntentId],
  );

  await assert.rejects(
    runMigrations(pool),
    /payment attempt .* Client Account.*currency differs/i,
  );
  const prematureColumn = await pool.query<{ count: string }>(
    `SELECT pg_catalog.count(*)::text AS count
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'sessions'
       AND column_name = 'active_client_account_id'`,
  );
  assert.equal(prematureColumn.rows[0]?.count, "0");
  await pool.query(
    "UPDATE payment_attempts SET client_account_id = $2 WHERE id = $1",
    [paymentAttemptId, ownerAccountId],
  );
  await pool.query("UPDATE services SET billing_cycle = 'annual' WHERE id = $1", [
    serviceId,
  ]);
  await assert.rejects(
    runMigrations(pool),
    /service .* billing cycle differs from its Order Item/i,
  );
  await pool.query("UPDATE services SET billing_cycle = 'monthly' WHERE id = $1", [
    serviceId,
  ]);
  await runMigrations(pool);

  const deliveredDispatchSuppression = await pool.query(
    `INSERT INTO renewal_notification_dispatch_suppressions(intent_id, reason)
     VALUES ($1, 'Cycle-end cancellation withdrew future recipient dispatch')
     ON CONFLICT (intent_id) DO NOTHING
     RETURNING intent_id`,
    [reminderIntentIds[0]],
  );
  assert.equal(deliveredDispatchSuppression.rowCount, 1);
  const replayedDispatchSuppression = await pool.query(
    `INSERT INTO renewal_notification_dispatch_suppressions(intent_id, reason)
     VALUES ($1, 'A replay cannot rewrite the original withdrawal reason')
     ON CONFLICT (intent_id) DO NOTHING
     RETURNING intent_id`,
    [reminderIntentIds[0]],
  );
  assert.equal(replayedDispatchSuppression.rowCount, 0);
  const deliveredFactAfterDispatchSuppression = await pool.query<{
    dispatch_suppressions: string;
    delivered_facts: string;
  }>(
    `SELECT
       (SELECT pg_catalog.count(*)::text
        FROM renewal_notification_dispatch_suppressions suppression
        WHERE suppression.intent_id = $1) AS dispatch_suppressions,
       (SELECT pg_catalog.count(*)::text
        FROM renewal_reminder_delivery_facts delivery
        WHERE delivery.intent_id = $1 AND delivery.status = 'delivered') AS delivered_facts`,
    [reminderIntentIds[0]],
  );
  assert.deepEqual(deliveredFactAfterDispatchSuppression.rows[0], {
    dispatch_suppressions: "1",
    delivered_facts: "1",
  });
  await expectPgCode(
    () =>
      pool!.query(
        `INSERT INTO renewal_notification_dispatch_suppressions(intent_id, reason)
         VALUES ($1, '   ')`,
        [reminderIntentIds[1]],
      ),
    "23514",
  );
  await expectPgCode(
    () =>
      pool!.query(
        `UPDATE renewal_notification_dispatch_suppressions
         SET reason = 'Rewritten suppression'
         WHERE intent_id = $1`,
        [reminderIntentIds[0]],
      ),
    "P0001",
  );
  await expectPgCode(
    () =>
      pool!.query(
        `DELETE FROM renewal_notification_dispatch_suppressions
         WHERE intent_id = $1`,
        [reminderIntentIds[0]],
      ),
    "P0001",
  );

  const eligibilityUserId = randomUUID();
  const eligibilitySessionId = randomUUID();
  const eligibilityExpiredSessionId = randomUUID();
  const eligibilityRevokedSessionId = randomUUID();
  const eligibilitySessionToken = randomBytes(32).toString("base64url");
  const eligibilityVerificationToken = randomBytes(32).toString("base64url");
  const eligibilityEmail = `identity-eligibility-${databaseName}@example.invalid`;
  await pool.query(
    `INSERT INTO users(id, email, password_hash)
     VALUES ($1, $2, 'synthetic-not-a-password')`,
    [eligibilityUserId, eligibilityEmail],
  );
  await pool.query(
    `INSERT INTO client_memberships(
       client_account_id, user_id, role, permissions
     ) VALUES ($1, $2, 'viewer', '[]'::jsonb)`,
    [ownerAccountId, eligibilityUserId],
  );
  await pool.query(
    `INSERT INTO sessions(
       id, user_id, token_digest, expires_at,
       active_client_account_id, account_context_version
     ) VALUES (
       $1, $2, $3, pg_catalog.now() + interval '1 hour', $4, 1
     )`,
    [
      eligibilitySessionId,
      eligibilityUserId,
      digestToken(eligibilitySessionToken),
      ownerAccountId,
    ],
  );
  await pool.query(
    `INSERT INTO sessions(
       id, user_id, token_digest, expires_at, revoked_at,
       active_client_account_id, account_context_version
     ) VALUES
       (
         $1, $3, $4, pg_catalog.now() - interval '1 hour', NULL,
         $6, 1
       ),
       (
         $2, $3, $5, pg_catalog.now() + interval '1 hour', pg_catalog.now(),
         $6, 1
       )`,
    [
      eligibilityExpiredSessionId,
      eligibilityRevokedSessionId,
      eligibilityUserId,
      digestToken(randomBytes(32).toString("base64url")),
      digestToken(randomBytes(32).toString("base64url")),
      ownerAccountId,
    ],
  );
  await pool.query(
    `INSERT INTO email_verification_tokens(
       user_id, token_digest, expires_at
     ) VALUES ($1, $2, pg_catalog.now() + interval '30 minutes')`,
    [eligibilityUserId, digestToken(eligibilityVerificationToken)],
  );

  const lockOrderUserId = randomUUID();
  const lockOrderSessionId = randomUUID();
  await pool.query(
    `INSERT INTO users(id, email, password_hash, email_verified_at)
     VALUES ($1, $2, 'synthetic-not-a-password', pg_catalog.now())`,
    [
      lockOrderUserId,
      `identity-lock-order-${databaseName}@example.invalid`,
    ],
  );
  await pool.query(
    `INSERT INTO client_memberships(
       client_account_id, user_id, role, permissions
     ) VALUES ($1, $2, 'viewer', '[]'::jsonb)`,
    [ownerAccountId, lockOrderUserId],
  );
  await pool.query(
    `INSERT INTO sessions(
       id, user_id, token_digest, expires_at,
       active_client_account_id, account_context_version
     ) VALUES (
       $1, $2, $3, pg_catalog.now() + interval '1 hour', $4, 1
     )`,
    [
      lockOrderSessionId,
      lockOrderUserId,
      digestToken(randomBytes(32).toString("base64url")),
      ownerAccountId,
    ],
  );

  const sessionFirstClient = await pool.connect();
  const userFirstClient = await pool.connect();
  try {
    await sessionFirstClient.query("BEGIN");
    await sessionFirstClient.query(
      "SELECT id FROM sessions WHERE id = $1 FOR UPDATE",
      [lockOrderSessionId],
    );
    await userFirstClient.query("BEGIN");
    await expectPgCode(
      () =>
        userFirstClient.query(
          `UPDATE users
           SET restricted_at = pg_catalog.now(), updated_at = pg_catalog.now()
           WHERE id = $1`,
          [lockOrderUserId],
        ),
      "55P03",
    );
    await userFirstClient.query("ROLLBACK");
    await sessionFirstClient.query("ROLLBACK");

    const failedClosedIdentity = await pool.query<{
      restricted_at: Date | null;
      account_context_version: string;
      active_client_account_id: string | null;
    }>(
      `SELECT principal.restricted_at,
              session_record.account_context_version::text,
              session_record.active_client_account_id
       FROM users principal
       JOIN sessions session_record ON session_record.user_id = principal.id
       WHERE principal.id = $1 AND session_record.id = $2`,
      [lockOrderUserId, lockOrderSessionId],
    );
    assert.deepEqual(failedClosedIdentity.rows[0], {
      restricted_at: null,
      account_context_version: "1",
      active_client_account_id: ownerAccountId,
    });

    await userFirstClient.query("BEGIN");
    await userFirstClient.query(
      `UPDATE users
       SET restricted_at = pg_catalog.now(), updated_at = pg_catalog.now()
       WHERE id = $1`,
      [lockOrderUserId],
    );
    await sessionFirstClient.query("BEGIN");
    const blockedSessionUpdate = sessionFirstClient.query(
      `UPDATE /* identity-version-session-after-user */ sessions
       SET account_context_version = account_context_version + 1
       WHERE id = $1`,
      [lockOrderSessionId],
    );
    await waitForBlockedQuery("identity-version-session-after-user");
    await userFirstClient.query("COMMIT");
    await blockedSessionUpdate;
    await sessionFirstClient.query("ROLLBACK");
  } catch (error) {
    await sessionFirstClient.query("ROLLBACK").catch(() => undefined);
    await userFirstClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    sessionFirstClient.release();
    userFirstClient.release();
  }
  const userFirstIdentity = await pool.query<{
    restricted: boolean;
    account_context_version: string;
    active_client_account_id: string | null;
  }>(
    `SELECT principal.restricted_at IS NOT NULL AS restricted,
            session_record.account_context_version::text,
            session_record.active_client_account_id
     FROM users principal
     JOIN sessions session_record ON session_record.user_id = principal.id
     WHERE principal.id = $1 AND session_record.id = $2`,
    [lockOrderUserId, lockOrderSessionId],
  );
  assert.deepEqual(userFirstIdentity.rows[0], {
    restricted: true,
    account_context_version: "2",
    active_client_account_id: ownerAccountId,
  });
  await pool.query(
    `UPDATE users
     SET restricted_at = NULL, updated_at = pg_catalog.now()
     WHERE id = $1`,
    [lockOrderUserId],
  );
  const restoredLockOrderSession = await pool.query<{
    account_context_version: string;
    active_client_account_id: string | null;
  }>(
    `SELECT account_context_version::text, active_client_account_id
     FROM sessions WHERE id = $1`,
    [lockOrderSessionId],
  );
  assert.deepEqual(restoredLockOrderSession.rows[0], {
    account_context_version: "3",
    active_client_account_id: ownerAccountId,
  });

  const crossServiceRenewalOutboxId = randomUUID();
  const crossServiceRenewalPayload = {
    email: owner.email,
    locale: "en",
    userId: owner.userId,
    accountId: ownerAccountId,
    notificationCategory: "billing",
    notificationRecipientKind: "account_user",
    notificationRecipientSubjectId: owner.userId,
    notificationRecipientScopeId: ownerAccountId,
    invoiceId: suppressedReminderInvoiceId,
    serviceId: manualHistoryServiceId,
    kind: "renewal_created",
    offsetDays: 0,
    currency: "USD",
    dueAt: "2026-02-01T00:00:00.000Z",
    amountDueMinor: "500",
  } as const;
  await pool.query(
    `INSERT INTO outbox(id, event_type, unique_key, payload)
     VALUES (
       $1, 'notification.renewal_reminder_requested', $2, $3
     )`,
    [
      crossServiceRenewalOutboxId,
      `renewal:${suppressedReminderInvoiceId}:renewal_created`,
      crossServiceRenewalPayload,
    ],
  );
  await expectPgCode(
    () =>
      pool!.query(
        `INSERT INTO notification_delivery_operations(
           outbox_id, attempt_number, provider_operation_id,
           provider_installation_id, event_type, template_revision,
           payload_snapshot, recipient_user_id, client_account_id,
           recipient_subject_id, recipient_scope_id,
           recipient_kind, category, recipient, locale, request_fingerprint
         ) VALUES (
           $1, 1, opensales_notification_provider_operation_id($1, 1),
           'mock-mail-v1', 'notification.renewal_reminder_requested',
           'renewal-renewal-created-v1', $2, $3, $4, $3, $4,
           'account_user', 'billing', $5, 'en',
           opensales_notification_request_fingerprint(
             'notification.renewal_reminder_requested',
             'renewal-renewal-created-v1', $2
           )
         )`,
        [
          crossServiceRenewalOutboxId,
          crossServiceRenewalPayload,
          owner.userId,
          ownerAccountId,
          owner.email,
        ],
      ),
    "P0001",
  );

  const upgradedReminderFacts = await pool.query<{
    id: string;
    intent_id: string;
    attempt_number: number;
    provider_operation_id: string;
    provider_message_id: string;
    status: string;
    provider_occurred_at: Date;
    recorded_at: Date;
  }>(
    `SELECT id, intent_id, attempt_number, provider_operation_id,
            provider_message_id, status, provider_occurred_at, recorded_at
     FROM renewal_reminder_delivery_facts
     WHERE id = ANY($1::uuid[])
     ORDER BY id`,
    [[...reminderFactIds]],
  );
  assert.equal(upgradedReminderFacts.rowCount, 3);
  for (const fact of upgradedReminderFacts.rows) {
    const index = reminderFactIds.indexOf(
      fact.id as (typeof reminderFactIds)[number],
    );
    assert.notEqual(index, -1);
    assert.equal(fact.intent_id, reminderIntentIds[index]);
    assert.equal(fact.attempt_number, 1);
    assert.equal(fact.provider_operation_id, reminderOperationIds[index]);
    assert.equal(fact.provider_message_id, reminderOperationIds[index]);
    assert.equal(fact.status, index === 0 ? "delivered" : "failed");
    assert.equal(
      fact.provider_occurred_at.toISOString(),
      new Date(Date.UTC(2026, 0, 15, 10, 11, 12 + index)).toISOString(),
    );
    assert.equal(
      fact.recorded_at.toISOString(),
      new Date(Date.UTC(2026, 0, 15, 10, 12, 12 + index)).toISOString(),
    );
  }
  const projectedReminderDeliveries = await pool.query<{
    outbox_id: string;
    attempt_number: number;
    provider_operation_id: string;
    operation_origin: string;
    operation_status: string;
    fact_status: string | null;
    job_status: string;
    job_attempts: number;
    published_at: Date | null;
  }>(
    `SELECT operation.outbox_id, operation.attempt_number,
            operation.provider_operation_id, operation.operation_origin,
            operation.status AS operation_status,
            fact.status AS fact_status,
            job.status AS job_status, job.attempts AS job_attempts,
            event.published_at
     FROM notification_delivery_operations operation
     JOIN outbox event ON event.id = operation.outbox_id
     JOIN durable_jobs job
       ON job.job_type = 'notification.send'
      AND job.unique_key = 'outbox:' || event.id::text
      AND job.payload = pg_catalog.jsonb_build_object('outboxId', event.id::text)
     LEFT JOIN notification_delivery_facts fact
       ON fact.outbox_id = operation.outbox_id
      AND fact.attempt_number = operation.attempt_number
      AND fact.provider_operation_id = operation.provider_operation_id
     WHERE operation.outbox_id = ANY($1::uuid[])
     ORDER BY operation.outbox_id, operation.attempt_number`,
    [[...reminderOperationIds]],
  );
  const deliveredProjection = projectedReminderDeliveries.rows.filter(
    (row) => row.outbox_id === reminderOperationIds[0],
  );
  assert.deepEqual(
    deliveredProjection.map((row) => ({
      attempt: row.attempt_number,
      providerOperationId: row.provider_operation_id,
      origin: row.operation_origin,
      operationStatus: row.operation_status,
      factStatus: row.fact_status,
      jobStatus: row.job_status,
      jobAttempts: row.job_attempts,
      published: row.published_at !== null,
    })),
    [
      {
        attempt: 1,
        providerOperationId: reminderOperationIds[0],
        origin: "schema_019_backfill",
        operationStatus: "succeeded",
        factStatus: "delivered",
        jobStatus: "completed",
        jobAttempts: 1,
        published: true,
      },
    ],
  );
  const failedProjection = projectedReminderDeliveries.rows.filter(
    (row) => row.outbox_id === reminderOperationIds[1],
  );
  assert.equal(failedProjection.length, 2);
  assert.deepEqual(
    failedProjection.map((row) => ({
      attempt: row.attempt_number,
      operationStatus: row.operation_status,
      factStatus: row.fact_status,
      jobStatus: row.job_status,
      jobAttempts: row.job_attempts,
      published: row.published_at !== null,
    })),
    [
      {
        attempt: 1,
        operationStatus: "failed",
        factStatus: "failed",
        jobStatus: "pending",
        jobAttempts: 0,
        published: false,
      },
      {
        attempt: 2,
        operationStatus: "queued",
        factStatus: null,
        jobStatus: "pending",
        jobAttempts: 0,
        published: false,
      },
    ],
  );
  const suppressedProjection = await pool.query<{
    operation_status: string;
    operation_origin: string;
    fact_status: string;
    job_status: string;
    job_attempts: number;
    published: boolean;
  }>(
    `SELECT operation.status AS operation_status,
            operation.operation_origin,
            fact.status AS fact_status,
            job.status AS job_status,
            job.attempts AS job_attempts,
            event.published_at IS NOT NULL AS published
     FROM notification_delivery_operations operation
     JOIN notification_delivery_facts fact
       ON fact.outbox_id = operation.outbox_id
      AND fact.attempt_number = operation.attempt_number
      AND fact.provider_operation_id = operation.provider_operation_id
     JOIN outbox event ON event.id = operation.outbox_id
     JOIN durable_jobs job
       ON job.job_type = 'notification.send'
      AND job.unique_key = 'outbox:' || event.id::text
      AND job.payload = pg_catalog.jsonb_build_object('outboxId', event.id::text)
     WHERE operation.outbox_id = $1 AND operation.attempt_number = 1`,
    [suppressedReminderOutboxId],
  );
  assert.deepEqual(suppressedProjection.rows[0], {
    operation_status: "skipped",
    operation_origin: "schema_019_backfill",
    fact_status: "skipped",
    job_status: "completed",
    job_attempts: 0,
    published: true,
  });
  const ownerBaselineFact = await pool.query<{
    previous_owner_user_id: string | null;
    new_owner_user_id: string;
    source: string;
  }>(
    `SELECT previous_owner_user_id, new_owner_user_id, source
     FROM client_account_owner_transfer_facts
     WHERE client_account_id = $1
     ORDER BY recorded_at, id
     LIMIT 1`,
    [ownerAccountId],
  );
  assert.deepEqual(ownerBaselineFact.rows[0], {
    previous_owner_user_id: null,
    new_owner_user_id: owner.userId,
    source: "schema_019_baseline",
  });
  const notificationOutboxId = randomUUID();
  const notificationUserId = randomUUID();
  const notificationTokenId = randomUUID();
  const notificationToken = randomBytes(32).toString("base64url");
  const notificationEmail = `notification-${notificationUserId}@example.invalid`;
  const notificationExpiresAt = "2099-01-01T00:00:00.000Z";
  const notificationPayload = {
    userId: notificationUserId,
    email: notificationEmail,
    locale: "en",
    verificationUrl:
      `http://127.0.0.1:5173/verify?token=${notificationToken}`,
    expiresAt: notificationExpiresAt,
    verificationTokenId: notificationTokenId,
    notificationCategory: "identity",
    notificationRecipientKind: "identity_user",
    notificationRecipientSubjectId: notificationUserId,
    notificationRecipientScopeId: notificationUserId,
  };
  await pool.query(
    `INSERT INTO users(id, email, password_hash)
     VALUES ($1, $2, 'synthetic-not-a-password')`,
    [notificationUserId, notificationEmail],
  );
  await pool.query(
    `INSERT INTO email_verification_tokens(
       id, user_id, token_digest, expires_at
     ) VALUES ($1, $2, $3, $4)`,
    [
      notificationTokenId,
      notificationUserId,
      digestToken(notificationToken),
      notificationExpiresAt,
    ],
  );
  await pool.query(
    `INSERT INTO outbox(id, event_type, unique_key, payload)
     VALUES ($1, 'notification.email_verification_requested', $2, $3)`,
    [notificationOutboxId, `verification:${notificationTokenId}`, notificationPayload],
  );
  const notificationIdentity = await pool.query<{
    provider_operation_id: string;
    request_fingerprint: string;
  }>(
    `SELECT
       opensales_notification_provider_operation_id($1, 1)::text
         AS provider_operation_id,
       opensales_notification_request_fingerprint(
         'notification.email_verification_requested',
         'email-verification-v1',
         $2::jsonb
       ) AS request_fingerprint`,
    [notificationOutboxId, notificationPayload],
  );
  const notificationOperationId =
    notificationIdentity.rows[0]?.provider_operation_id;
  const notificationRequestFingerprint =
    notificationIdentity.rows[0]?.request_fingerprint;
  assert.ok(notificationOperationId);
  assert.ok(notificationRequestFingerprint);
  await pool.query(
    `INSERT INTO notification_delivery_operations(
       outbox_id, attempt_number, provider_operation_id,
       provider_installation_id, event_type, template_revision,
       payload_snapshot, recipient_user_id, recipient_subject_id,
       recipient_scope_id, recipient_kind,
       category, recipient, locale, request_fingerprint
     ) VALUES (
       $1, 1, $2, 'mock-mail-v1',
       'notification.email_verification_requested', 'email-verification-v1',
       $3, $4, $4, $4, 'identity_user',
       'identity', $5, 'en', $6
     )`,
    [
      notificationOutboxId,
      notificationOperationId,
      notificationPayload,
      notificationUserId,
      notificationEmail,
      notificationRequestFingerprint,
    ],
  );
  const insertDuplicateVerificationOperation = async (
    outboxId: string,
  ): Promise<void> => {
    await pool!.query(
      `INSERT INTO notification_delivery_operations(
         outbox_id, attempt_number, provider_operation_id,
         provider_installation_id, event_type, template_revision,
         payload_snapshot, recipient_user_id, recipient_subject_id,
         recipient_scope_id, recipient_kind,
         category, recipient, locale, request_fingerprint
       ) VALUES (
         $1, 1, opensales_notification_provider_operation_id($1, 1),
         'mock-mail-v1', 'notification.email_verification_requested',
         'email-verification-v1', $2, $3, $3, $3, 'identity_user',
         'identity', $4, 'en', opensales_notification_request_fingerprint(
           'notification.email_verification_requested',
           'email-verification-v1', $2
         )
       )`,
      [outboxId, notificationPayload, notificationUserId, notificationEmail],
    );
  };
  const unreviewedVerificationKeyOutboxId = randomUUID();
  await pool.query(
    `INSERT INTO outbox(id, event_type, unique_key, payload)
     VALUES ($1, 'notification.email_verification_requested', $2, $3)`,
    [
      unreviewedVerificationKeyOutboxId,
      `unreviewed-verification:${notificationTokenId}`,
      notificationPayload,
    ],
  );
  await expectPgCode(
    () => insertDuplicateVerificationOperation(unreviewedVerificationKeyOutboxId),
    "P0001",
  );
  const duplicateVerificationTokenOutboxId = randomUUID();
  await pool.query(
    `INSERT INTO outbox(id, event_type, unique_key, payload)
     VALUES ($1, 'notification.email_verification_requested', $2, $3)`,
    [
      duplicateVerificationTokenOutboxId,
      `registration:${notificationUserId}`,
      notificationPayload,
    ],
  );
  await expectPgCode(
    () => insertDuplicateVerificationOperation(duplicateVerificationTokenOutboxId),
    "23505",
  );
  const {
    verificationTokenId: _omittedVerificationTokenId,
    ...malformedVerificationPayload
  } = notificationPayload;
  assert.equal(_omittedVerificationTokenId, notificationTokenId);
  const malformedVerificationOutboxId = randomUUID();
  await pool.query(
    `INSERT INTO outbox(id, event_type, unique_key, payload)
     VALUES ($1, 'notification.email_verification_requested', $2, $3)`,
    [
      malformedVerificationOutboxId,
      `invitation-registration:${notificationUserId}`,
      malformedVerificationPayload,
    ],
  );
  await expectPgCode(
    () =>
      pool!.query(
        `INSERT INTO notification_delivery_operations(
           outbox_id, attempt_number, provider_operation_id,
           provider_installation_id, event_type, template_revision,
           payload_snapshot, recipient_user_id, recipient_subject_id,
           recipient_scope_id, recipient_kind,
           category, recipient, locale, request_fingerprint,
           status, last_error
         ) VALUES (
           $1, 1, opensales_notification_provider_operation_id($1, 1),
           'mock-mail-v1', 'notification.email_verification_requested',
           'email-verification-v1', $2, $3, $3, $3, 'identity_user',
           'identity', $4, 'en', opensales_notification_request_fingerprint(
             'notification.email_verification_requested',
             'email-verification-v1', $2
           ),
           'skipped', 'Malformed snapshots must never become skipped facts'
         )`,
        [
          malformedVerificationOutboxId,
          malformedVerificationPayload,
          notificationUserId,
          notificationEmail,
        ],
      ),
    "P0001",
  );
  await expectPgCode(
    () =>
      pool!.query(
        `INSERT INTO notification_delivery_facts(
           outbox_id, attempt_number, recipient_user_id, recipient_kind,
           recipient_subject_id, recipient_scope_id,
           category, recipient, locale, provider_operation_id, status
         ) VALUES (
           $1, 1, $2, 'identity_user', $2, $2,
           'identity', $3, 'en', $4, 'skipped'
         )`,
        [
          notificationOutboxId,
          notificationUserId,
          notificationEmail,
          notificationOperationId,
        ],
      ),
    "P0001",
  );
  await expectPgCode(
    () =>
      pool!.query(
        `INSERT INTO notification_delivery_facts(
           outbox_id, attempt_number, recipient_user_id, recipient_kind,
           recipient_subject_id, recipient_scope_id,
           category, recipient, locale, provider_installation_id,
           provider_operation_id, provider_message_id, status,
           failure_reason, provider_occurred_at
         ) VALUES (
           $1, 1, $2, 'identity_user', $2, $2,
           'identity', $3, 'en', 'mock-mail-v1',
           $4, ($4::uuid)::text, 'failed',
           'synthetic mismatched operation status', pg_catalog.now()
         )`,
        [
          notificationOutboxId,
          notificationUserId,
          notificationEmail,
          notificationOperationId,
        ],
      ),
    "P0001",
  );
  const notificationClient = await pool.connect();
  let skippedNotificationFact: pg.QueryResult<{ id: string }>;
  try {
    await notificationClient.query("BEGIN");
    await notificationClient.query(
      `UPDATE notification_delivery_operations
       SET status = 'skipped', last_checked_at = pg_catalog.now(),
           last_error = 'synthetic Provider lookup confirmed no delivery',
           updated_at = pg_catalog.now()
       WHERE provider_operation_id = $1`,
      [notificationOperationId],
    );
    skippedNotificationFact = await notificationClient.query<{ id: string }>(
      `INSERT INTO notification_delivery_facts(
         outbox_id, attempt_number, recipient_user_id, recipient_kind,
         recipient_subject_id, recipient_scope_id,
         category, recipient, locale, provider_operation_id, status, failure_reason
       ) VALUES (
         $1, 1, $2, 'identity_user', $2, $2,
         'identity', $3, 'en', $4, 'skipped',
         'synthetic Provider lookup confirmed no delivery'
       )
       RETURNING id`,
      [
        notificationOutboxId,
        notificationUserId,
        notificationEmail,
        notificationOperationId,
      ],
    );
    await notificationClient.query("COMMIT");
  } catch (error) {
    await notificationClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    notificationClient.release();
  }
  assert.equal(skippedNotificationFact.rowCount, 1);
  await expectPgCode(
    () =>
      pool!.query(
        `UPDATE notification_delivery_operations
         SET recipient = 'rewritten@example.invalid'
         WHERE provider_operation_id = $1`,
        [notificationOperationId],
      ),
    "P0001",
  );
  await expectPgCode(
    () =>
      pool!.query(
        `UPDATE notification_delivery_operations
         SET recipient = pg_catalog.upper(recipient::text)::citext
         WHERE provider_operation_id = $1`,
        [notificationOperationId],
      ),
    "P0001",
  );
  await expectPgCode(
    () =>
      pool!.query(
        `UPDATE notification_delivery_operations
         SET status = 'dispatching'
         WHERE provider_operation_id = $1`,
        [notificationOperationId],
      ),
    "P0001",
  );
  await expectPgCode(
    () =>
      pool!.query(
        `UPDATE notification_delivery_operations
         SET request_fingerprint = $2
         WHERE provider_operation_id = $1`,
        [notificationOperationId, "b".repeat(64)],
      ),
    "P0001",
  );
  await expectPgCode(
    () =>
      pool!.query(
        `UPDATE notification_delivery_operations
         SET last_checked_at = NULL
         WHERE provider_operation_id = $1`,
        [notificationOperationId],
      ),
    "P0001",
  );
  await expectPgCode(
    () =>
      pool!.query(
        "UPDATE notification_delivery_facts SET recipient = recipient WHERE id = $1",
        [skippedNotificationFact.rows[0]?.id],
      ),
    "P0001",
  );
  await expectPgCode(
    () =>
      pool!.query(
        `INSERT INTO notification_delivery_facts(
           outbox_id, attempt_number, recipient_user_id, recipient_kind,
           recipient_subject_id, recipient_scope_id,
           category, recipient, locale, provider_operation_id, status
         ) VALUES (
           $1, 2, $2, 'identity_user', $2, $2,
           'identity', $3, 'en', $4, 'skipped'
         )`,
        [notificationOutboxId, notificationUserId, notificationEmail, randomUUID()],
    ),
    "P0001",
  );

  const malformedInvitationId = randomUUID();
  const malformedInvitationOutboxId = randomUUID();
  const malformedInvitationToken = randomBytes(32).toString("base64url");
  const malformedInvitationEmail =
    `malformed-invitation-${malformedInvitationId}@example.invalid`;
  const malformedInvitationExpiresAt = "2099-01-01T00:00:00.000Z";
  const malformedInvitationPayload = {
    accountId: ownerAccountId,
    accountName: "single-owner Account 1",
    email: malformedInvitationEmail,
    locale: "en",
    role: "viewer",
    permissions: [],
    invitationId: malformedInvitationId,
    invitationUrl: "http://127.0.0.1:5173/membership-invitations/accept?token=malformed",
    expiresAt: malformedInvitationExpiresAt,
    notificationCategory: "membership_invitation",
    notificationRecipientKind: "invitation",
    notificationRecipientSubjectId: malformedInvitationId,
    notificationRecipientScopeId: ownerAccountId,
  };
  await pool.query(
    `INSERT INTO client_membership_invitations(
       id, client_account_id, email, locale, role, permissions,
       token_digest, expires_at, invited_by_user_id
     ) VALUES ($1, $2, $3, 'en', 'viewer', '[]'::jsonb, $4, $5, $6)`,
    [
      malformedInvitationId,
      ownerAccountId,
      malformedInvitationEmail,
      digestToken(malformedInvitationToken),
      malformedInvitationExpiresAt,
      owner.userId,
    ],
  );
  await pool.query(
    `INSERT INTO outbox(id, event_type, unique_key, payload)
     VALUES ($1, 'notification.membership_invitation_requested', $2, $3)`,
    [
      malformedInvitationOutboxId,
      `membership-invitation:${malformedInvitationId}`,
      malformedInvitationPayload,
    ],
  );
  await expectPgCode(
    () =>
      pool!.query(
        `INSERT INTO notification_delivery_operations(
           outbox_id, attempt_number, provider_operation_id,
           provider_installation_id, event_type, template_revision,
           payload_snapshot, invitation_id, client_account_id,
           recipient_subject_id, recipient_scope_id, recipient_kind,
           category, recipient, locale, request_fingerprint,
           status, last_error
         ) VALUES (
           $1, 1, opensales_notification_provider_operation_id($1, 1),
           'mock-mail-v1', 'notification.membership_invitation_requested',
           'membership-invitation-v1', $2, $3, $4, $3, $4,
           'invitation', 'membership_invitation', $5, 'en',
           opensales_notification_request_fingerprint(
             'notification.membership_invitation_requested',
             'membership-invitation-v1', $2
           ),
           'skipped', 'Malformed Invitations must never become skipped facts'
         )`,
        [
          malformedInvitationOutboxId,
          malformedInvitationPayload,
          malformedInvitationId,
          ownerAccountId,
          malformedInvitationEmail,
        ],
      ),
    "P0001",
  );

  const snapshotContactId = randomUUID();
  const snapshotContactEmail = `snapshot-${snapshotContactId}@example.invalid`;
  const contactOutboxId = randomUUID();
  const runtimeInvoice = await pool.query<{
    currency: string;
    due_at: Date;
  }>(
    `SELECT currency, due_at
     FROM invoices
     WHERE id = $1`,
    [manualHistoryInvoiceId],
  );
  assert.ok(runtimeInvoice.rows[0]);
  const renewalRuntimeBusinessPayload = {
    invoiceId: manualHistoryInvoiceId,
    serviceId: manualHistoryServiceId,
    kind: "pre_due",
    offsetDays: 7,
    currency: runtimeInvoice.rows[0].currency,
    dueAt: runtimeInvoice.rows[0].due_at.toISOString(),
    amountDueMinor: "500",
  } as const;
  const contactPayload = {
    email: snapshotContactEmail,
    locale: "en",
    contactId: snapshotContactId,
    accountId: ownerAccountId,
    notificationCategory: "billing",
    notificationRecipientKind: "contact",
    notificationRecipientSubjectId: snapshotContactId,
    notificationRecipientScopeId: ownerAccountId,
    ...renewalRuntimeBusinessPayload,
  };
  const contactTemplateRevision = "renewal-pre-due-v1";
  await pool.query(
    `INSERT INTO client_contacts(
       id, client_account_id, display_name, email, locale,
       notification_subscriptions
     ) VALUES ($1, $2, 'Snapshot Contact', $3, 'en', '["billing"]'::jsonb)`,
    [snapshotContactId, ownerAccountId, snapshotContactEmail],
  );
  await pool.query(
    `INSERT INTO outbox(id, event_type, unique_key, payload)
     VALUES ($1, 'notification.renewal_reminder_requested', $2, $3)`,
    [
      contactOutboxId,
      `renewal:${manualHistoryInvoiceId}:pre_due:contact:${snapshotContactId}`,
      contactPayload,
    ],
  );
  const contactNotificationIdentity = await pool.query<{
    attempt_1_id: string;
    attempt_2_id: string;
    attempt_3_id: string;
    request_fingerprint: string;
  }>(
    `SELECT
       opensales_notification_provider_operation_id($1, 1)::text AS attempt_1_id,
       opensales_notification_provider_operation_id($1, 2)::text AS attempt_2_id,
       opensales_notification_provider_operation_id($1, 3)::text AS attempt_3_id,
       opensales_notification_request_fingerprint($2, $3, $4::jsonb)
         AS request_fingerprint`,
    [
      contactOutboxId,
      "notification.renewal_reminder_requested",
      contactTemplateRevision,
      contactPayload,
    ],
  );
  const contactFirstOperationId =
    contactNotificationIdentity.rows[0]?.attempt_1_id;
  const contactSkippedOperationId =
    contactNotificationIdentity.rows[0]?.attempt_2_id;
  const contactThirdOperationId =
    contactNotificationIdentity.rows[0]?.attempt_3_id;
  const contactRequestFingerprint =
    contactNotificationIdentity.rows[0]?.request_fingerprint;
  assert.ok(contactFirstOperationId);
  assert.ok(contactSkippedOperationId);
  assert.ok(contactThirdOperationId);
  assert.ok(contactRequestFingerprint);
  await pool.query(
    `INSERT INTO notification_delivery_operations(
       outbox_id, attempt_number, provider_operation_id,
       provider_installation_id, event_type, template_revision,
       payload_snapshot, contact_id, client_account_id,
       recipient_subject_id, recipient_scope_id, recipient_kind,
       category, recipient, locale, request_fingerprint
     ) VALUES (
       $1, 1, $2, 'mock-mail-v1', $3, $4, $5,
       $6, $7, $6, $7, 'contact', 'billing', $8, 'en', $9
     )`,
    [
      contactOutboxId,
      contactFirstOperationId,
      "notification.renewal_reminder_requested",
      contactTemplateRevision,
      contactPayload,
      snapshotContactId,
      ownerAccountId,
      snapshotContactEmail,
      contactRequestFingerprint,
    ],
  );
  const contactRenderedSnapshot = {
    recipient: snapshotContactEmail,
    template: contactTemplateRevision,
    locale: "en",
    subject: "Synthetic renewal contact notification",
    body: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
    sensitive: false,
    scenario: "failed",
  };
  await pool.query(
    `UPDATE notification_delivery_operations
     SET status = 'dispatching', attempts = attempts + 1,
         dispatch_started_at = pg_catalog.now(),
         rendered_request_snapshot = $2,
         rendered_request_fingerprint =
           opensales_notification_rendered_request_fingerprint($2::jsonb),
         updated_at = pg_catalog.now()
     WHERE provider_operation_id = $1`,
    [contactFirstOperationId, contactRenderedSnapshot],
  );
  const contactFailureClient = await pool.connect();
  try {
    await contactFailureClient.query("BEGIN");
    await contactFailureClient.query(
      `UPDATE notification_delivery_operations
       SET status = 'failed', last_checked_at = pg_catalog.now(),
           last_error = 'synthetic explicit Provider failure',
           updated_at = pg_catalog.now()
       WHERE provider_operation_id = $1`,
      [contactFirstOperationId],
    );
    await contactFailureClient.query(
      `INSERT INTO notification_delivery_facts(
         outbox_id, attempt_number, contact_id, client_account_id,
         recipient_subject_id, recipient_scope_id, recipient_kind,
         category, recipient, locale, provider_installation_id,
         provider_operation_id, provider_message_id, status,
         failure_reason, provider_occurred_at
       ) VALUES (
         $1, 1, $2, $3, $2, $3, 'contact',
         'billing', $4, 'en', 'mock-mail-v1',
         $5::uuid, ($5::uuid)::text, 'failed',
         'synthetic explicit Provider failure', pg_catalog.now()
       )`,
      [
        contactOutboxId,
        snapshotContactId,
        ownerAccountId,
        snapshotContactEmail,
        contactFirstOperationId,
      ],
    );
    await contactFailureClient.query("COMMIT");
  } catch (error) {
    await contactFailureClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    contactFailureClient.release();
  }
  await pool.query(
    `UPDATE client_contacts
     SET removed_at = pg_catalog.now(), updated_at = pg_catalog.now()
     WHERE id = $1`,
    [snapshotContactId],
  );
  await expectPgCode(
    () =>
      pool!.query(
        `INSERT INTO notification_delivery_operations(
           outbox_id, attempt_number, provider_operation_id,
           provider_installation_id, event_type, template_revision,
           payload_snapshot, contact_id, client_account_id,
           recipient_subject_id, recipient_scope_id, recipient_kind,
           category, recipient, locale, request_fingerprint, status
         ) VALUES (
           $1, 2, $2, 'mock-mail-v1', $3, $4, $5, $6, $7,
           $6, $7, 'contact', 'billing', $8, 'en', $9, 'queued'
         )`,
        [
          contactOutboxId,
          contactSkippedOperationId,
          "notification.renewal_reminder_requested",
          contactTemplateRevision,
          contactPayload,
          snapshotContactId,
          ownerAccountId,
          snapshotContactEmail,
          contactRequestFingerprint,
        ],
      ),
    "P0001",
  );
  await expectPgCode(
    () =>
      pool!.query(
        `INSERT INTO notification_delivery_operations(
           outbox_id, attempt_number, provider_operation_id,
           provider_installation_id, event_type, template_revision,
           payload_snapshot, contact_id, client_account_id,
           recipient_subject_id, recipient_scope_id, recipient_kind,
           category, recipient, locale, request_fingerprint, status
         ) VALUES (
           $1, 2, $2, 'mock-mail-v1', $3, $4, $5, $6, $7,
           $6, $7, 'contact', 'billing', upper($8)::citext, 'en', $9, 'skipped'
         )`,
        [
          contactOutboxId,
          contactSkippedOperationId,
          "notification.renewal_reminder_requested",
          contactTemplateRevision,
          contactPayload,
          snapshotContactId,
          ownerAccountId,
          snapshotContactEmail,
          contactRequestFingerprint,
        ],
      ),
    "P0001",
  );
  const contactSkippedClient = await pool.connect();
  try {
    await contactSkippedClient.query("BEGIN");
    await contactSkippedClient.query(
      `INSERT INTO notification_delivery_operations(
         outbox_id, attempt_number, provider_operation_id,
         provider_installation_id, event_type, template_revision,
         payload_snapshot, contact_id, client_account_id,
         recipient_subject_id, recipient_scope_id, recipient_kind,
         category, recipient, locale, request_fingerprint, status, last_error
       ) VALUES (
         $1, 2, $2, 'mock-mail-v1', $3, $4, $5, $6, $7,
         $6, $7, 'contact', 'billing', $8, 'en', $9, 'skipped',
         'Contact was removed before a retry could be dispatched'
       )`,
      [
        contactOutboxId,
        contactSkippedOperationId,
        "notification.renewal_reminder_requested",
        contactTemplateRevision,
        contactPayload,
        snapshotContactId,
        ownerAccountId,
        snapshotContactEmail,
        contactRequestFingerprint,
      ],
    );
    await contactSkippedClient.query(
      `INSERT INTO notification_delivery_facts(
         outbox_id, attempt_number, contact_id, client_account_id,
         recipient_subject_id, recipient_scope_id, recipient_kind,
         category, recipient, locale, provider_operation_id, status,
         failure_reason
       ) VALUES (
         $1, 2, $2, $3, $2, $3, 'contact',
         'billing', $4, 'en', $5, 'skipped',
         'Contact was removed before a retry could be dispatched'
       )`,
      [
        contactOutboxId,
        snapshotContactId,
        ownerAccountId,
        snapshotContactEmail,
        contactSkippedOperationId,
      ],
    );
    await contactSkippedClient.query("COMMIT");
  } catch (error) {
    await contactSkippedClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    contactSkippedClient.release();
  }
  await expectPgCode(
    () =>
      pool!.query(
        `INSERT INTO notification_delivery_operations(
           outbox_id, attempt_number, provider_operation_id,
           provider_installation_id, event_type, template_revision,
           payload_snapshot, contact_id, client_account_id,
           recipient_subject_id, recipient_scope_id, recipient_kind,
           category, recipient, locale, request_fingerprint, status
         ) VALUES (
           $1, 3, $2, 'mock-mail-v1', $3, $4, $5, $6, $7,
           $6, $7, 'contact', 'billing', $8, 'en', $9, 'skipped'
         )`,
        [
          contactOutboxId,
          contactThirdOperationId,
          "notification.renewal_reminder_requested",
          contactTemplateRevision,
          contactPayload,
          snapshotContactId,
          ownerAccountId,
          snapshotContactEmail,
          contactRequestFingerprint,
        ],
      ),
    "P0001",
  );

  const secondSnapshotContactId = randomUUID();
  const secondSnapshotContactEmail =
    `snapshot-second-${secondSnapshotContactId}@example.invalid`;
  const secondContactOutboxId = randomUUID();
  const secondContactPayload = {
    email: secondSnapshotContactEmail,
    locale: "en",
    contactId: secondSnapshotContactId,
    accountId: ownerAccountId,
    notificationCategory: "billing",
    notificationRecipientKind: "contact",
    notificationRecipientSubjectId: secondSnapshotContactId,
    notificationRecipientScopeId: ownerAccountId,
    ...renewalRuntimeBusinessPayload,
  };
  await pool.query(
    `INSERT INTO client_contacts(
       id, client_account_id, display_name, email, locale,
       notification_subscriptions
     ) VALUES (
       $1, $2, 'Second Snapshot Contact', $3, 'en', '["billing"]'::jsonb
     )`,
    [secondSnapshotContactId, ownerAccountId, secondSnapshotContactEmail],
  );
  await pool.query(
    `INSERT INTO outbox(id, event_type, unique_key, payload)
     VALUES ($1, 'notification.renewal_reminder_requested', $2, $3)`,
    [
      secondContactOutboxId,
      `renewal:${manualHistoryInvoiceId}:pre_due:contact:${secondSnapshotContactId}`,
      secondContactPayload,
    ],
  );
  const secondContactIdentity = await pool.query<{
    provider_operation_id: string;
    request_fingerprint: string;
  }>(
    `SELECT
       opensales_notification_provider_operation_id($1, 1)::text
         AS provider_operation_id,
       opensales_notification_request_fingerprint(
         'notification.renewal_reminder_requested',
         'renewal-pre-due-v1', $2::jsonb
       ) AS request_fingerprint`,
    [secondContactOutboxId, secondContactPayload],
  );
  const secondContactOperationId =
    secondContactIdentity.rows[0]?.provider_operation_id;
  const secondContactRequestFingerprint =
    secondContactIdentity.rows[0]?.request_fingerprint;
  assert.ok(secondContactOperationId);
  assert.ok(secondContactRequestFingerprint);
  await pool.query(
    `INSERT INTO notification_delivery_operations(
       outbox_id, attempt_number, provider_operation_id,
       provider_installation_id, event_type, template_revision,
       payload_snapshot, contact_id, client_account_id,
       recipient_subject_id, recipient_scope_id, recipient_kind,
       category, recipient, locale, request_fingerprint
     ) VALUES (
       $1, 1, $2, 'mock-mail-v1',
       'notification.renewal_reminder_requested', 'renewal-pre-due-v1',
       $3, $4, $5, $4, $5, 'contact',
       'billing', $6, 'en', $7
     )`,
    [
      secondContactOutboxId,
      secondContactOperationId,
      secondContactPayload,
      secondSnapshotContactId,
      ownerAccountId,
      secondSnapshotContactEmail,
      secondContactRequestFingerprint,
    ],
  );
  const secondContactClient = await pool.connect();
  try {
    const renderedSnapshot = {
      recipient: secondSnapshotContactEmail,
      template: "renewal-pre-due-v1",
      locale: "en",
      subject: "Synthetic second renewal contact notification",
      body: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      sensitive: false,
      scenario: "delivered",
    };
    const providerOccurredAt = "2026-01-19T10:11:12Z";
    await secondContactClient.query("BEGIN");
    await secondContactClient.query(
      `UPDATE notification_delivery_operations
       SET status = 'dispatching', attempts = attempts + 1,
           dispatch_started_at = pg_catalog.now(),
           rendered_request_snapshot = $2,
           rendered_request_fingerprint =
             opensales_notification_rendered_request_fingerprint($2::jsonb),
           updated_at = pg_catalog.now()
       WHERE provider_operation_id = $1`,
      [secondContactOperationId, renderedSnapshot],
    );
    await secondContactClient.query(
      `UPDATE notification_delivery_operations
       SET status = 'succeeded', last_checked_at = pg_catalog.now(),
           updated_at = pg_catalog.now()
       WHERE provider_operation_id = $1`,
      [secondContactOperationId],
    );
    await secondContactClient.query(
      `INSERT INTO notification_delivery_facts(
         outbox_id, attempt_number, contact_id, client_account_id,
         recipient_subject_id, recipient_scope_id, recipient_kind,
         category, recipient, locale, provider_installation_id,
         provider_operation_id, provider_message_id, status,
         provider_occurred_at
       ) VALUES (
         $1, 1, $2, $3, $2, $3, 'contact',
         'billing', $4, 'en', 'mock-mail-v1',
         $5::uuid, $5::text, 'delivered', $6
       )`,
      [
        secondContactOutboxId,
        secondSnapshotContactId,
        ownerAccountId,
        secondSnapshotContactEmail,
        secondContactOperationId,
        providerOccurredAt,
      ],
    );
    await secondContactClient.query("COMMIT");
  } catch (error) {
    await secondContactClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    secondContactClient.release();
  }
  const secondContactProjection = await pool.query<{ count: string }>(
    `SELECT pg_catalog.count(*)::text AS count
     FROM notification_delivery_facts fact
     LEFT JOIN renewal_reminder_intents reminder
       ON reminder.outbox_id = fact.outbox_id
     WHERE fact.outbox_id = $1
       AND fact.recipient_kind = 'contact'
       AND reminder.id IS NULL`,
    [secondContactOutboxId],
  );
  assert.equal(secondContactProjection.rows[0]?.count, "1");

  const wrongCategoryOutboxId = randomUUID();
  const wrongCategoryContactId = randomUUID();
  const wrongCategoryContactEmail =
    `wrong-category-${wrongCategoryContactId}@example.invalid`;
  const wrongCategoryPayload = {
    email: wrongCategoryContactEmail,
    locale: "en",
    contactId: wrongCategoryContactId,
    accountId: ownerAccountId,
    notificationCategory: "service",
    notificationRecipientKind: "contact",
    notificationRecipientSubjectId: wrongCategoryContactId,
    notificationRecipientScopeId: ownerAccountId,
    ...renewalRuntimeBusinessPayload,
  };
  await pool.query(
    `INSERT INTO client_contacts(
       id, client_account_id, display_name, email, locale,
       notification_subscriptions
     ) VALUES (
       $1, $2, 'Wrong category Contact', $3, 'en', '["service"]'::jsonb
     )`,
    [wrongCategoryContactId, ownerAccountId, wrongCategoryContactEmail],
  );
  await pool.query(
    `INSERT INTO outbox(id, event_type, unique_key, payload)
     VALUES ($1, 'notification.renewal_reminder_requested', $2, $3)`,
    [
      wrongCategoryOutboxId,
      `renewal:${manualHistoryInvoiceId}:pre_due:contact:${wrongCategoryContactId}`,
      wrongCategoryPayload,
    ],
  );
  await expectPgCode(
    () =>
      pool!.query(
        `INSERT INTO notification_delivery_operations(
           outbox_id, attempt_number, provider_operation_id,
           provider_installation_id, event_type, template_revision,
           payload_snapshot, contact_id, client_account_id,
           recipient_subject_id, recipient_scope_id, recipient_kind,
           category, recipient, locale, request_fingerprint,
           status, last_error
         ) VALUES (
           $1, 1, opensales_notification_provider_operation_id($1, 1),
           'mock-mail-v1', 'notification.renewal_reminder_requested',
           'renewal-pre-due-v1', $2, $3, $4, $3, $4, 'contact',
           'service', $5, 'en',
           opensales_notification_request_fingerprint(
             'notification.renewal_reminder_requested',
             'renewal-pre-due-v1', $2
           ),
           'skipped', 'Synthetic category mismatch must fail closed'
         )`,
        [
          wrongCategoryOutboxId,
          wrongCategoryPayload,
          wrongCategoryContactId,
          ownerAccountId,
          wrongCategoryContactEmail,
        ],
      ),
    "P0001",
  );

  const malformedContactId = randomUUID();
  const malformedContactEmail =
    `malformed-contact-${malformedContactId}@example.invalid`;
  const malformedContactOutboxId = randomUUID();
  const malformedContactPayload = {
    email: malformedContactEmail,
    locale: "en",
    contactId: malformedContactId,
    accountId: ownerAccountId,
    notificationCategory: "billing",
    notificationRecipientKind: "contact",
    notificationRecipientSubjectId: malformedContactId,
    notificationRecipientScopeId: secondAccountId,
    ...renewalRuntimeBusinessPayload,
  };
  await pool.query(
    `INSERT INTO client_contacts(
       id, client_account_id, display_name, email, locale,
       notification_subscriptions
     ) VALUES (
       $1, $2, 'Malformed snapshot Contact', $3, 'en', '["billing"]'::jsonb
     )`,
    [malformedContactId, ownerAccountId, malformedContactEmail],
  );
  await pool.query(
    `INSERT INTO outbox(id, event_type, unique_key, payload)
     VALUES ($1, 'notification.renewal_reminder_requested', $2, $3)`,
    [
      malformedContactOutboxId,
      `renewal:${manualHistoryInvoiceId}:pre_due:contact:${malformedContactId}`,
      malformedContactPayload,
    ],
  );
  await expectPgCode(
    () =>
      pool!.query(
        `INSERT INTO notification_delivery_operations(
           outbox_id, attempt_number, provider_operation_id,
           provider_installation_id, event_type, template_revision,
           payload_snapshot, contact_id, client_account_id,
           recipient_subject_id, recipient_scope_id, recipient_kind,
           category, recipient, locale, request_fingerprint,
           status, last_error
         ) VALUES (
           $1, 1, opensales_notification_provider_operation_id($1, 1),
           'mock-mail-v1', 'notification.renewal_reminder_requested',
           'renewal-pre-due-v1', $2, $3, $4, $3, $4,
           'contact', 'billing', $5, 'en',
           opensales_notification_request_fingerprint(
             'notification.renewal_reminder_requested',
             'renewal-pre-due-v1', $2
           ),
           'skipped', 'Malformed Contact snapshots must fail closed'
         )`,
        [
          malformedContactOutboxId,
          malformedContactPayload,
          malformedContactId,
          ownerAccountId,
          malformedContactEmail,
        ],
      ),
    "P0001",
  );

  const assertExtraKeyContactRejected = async (
    status: "queued" | "skipped",
  ): Promise<void> => {
    const contactId = randomUUID();
    const contactEmail = `extra-key-${status}-${contactId}@example.invalid`;
    const outboxId = randomUUID();
    const payload = {
      email: contactEmail,
      locale: "en",
      contactId,
      accountId: ownerAccountId,
      notificationCategory: "billing",
      notificationRecipientKind: "contact",
      notificationRecipientSubjectId: contactId,
      notificationRecipientScopeId: ownerAccountId,
      ...renewalRuntimeBusinessPayload,
      unreviewedSecret: "must-not-become-an-immutable-notification-snapshot",
    };
    await pool!.query(
      `INSERT INTO client_contacts(
         id, client_account_id, display_name, email, locale,
         notification_subscriptions, removed_at
       ) VALUES (
         $1, $2, 'Extra key Contact', $3, 'en', '["billing"]'::jsonb,
         CASE WHEN $4 = 'skipped' THEN pg_catalog.now() ELSE NULL END
       )`,
      [contactId, ownerAccountId, contactEmail, status],
    );
    await pool!.query(
      `INSERT INTO outbox(id, event_type, unique_key, payload)
       VALUES ($1, 'notification.renewal_reminder_requested', $2, $3)`,
      [
        outboxId,
        `renewal:${manualHistoryInvoiceId}:pre_due:contact:${contactId}`,
        payload,
      ],
    );
    await expectPgCode(
      () =>
        pool!.query(
          `INSERT INTO notification_delivery_operations(
             outbox_id, attempt_number, provider_operation_id,
             provider_installation_id, event_type, template_revision,
             payload_snapshot, contact_id, client_account_id,
             recipient_subject_id, recipient_scope_id, recipient_kind,
             category, recipient, locale, request_fingerprint,
             status, last_error
           ) VALUES (
             $1, 1, opensales_notification_provider_operation_id($1, 1),
             'mock-mail-v1', 'notification.renewal_reminder_requested',
             'renewal-pre-due-v1', $2, $3, $4, $3, $4,
             'contact', 'billing', $5, 'en',
             opensales_notification_request_fingerprint(
               'notification.renewal_reminder_requested',
               'renewal-pre-due-v1', $2
             ),
             $6,
             CASE WHEN $6 = 'skipped'
               THEN 'Removed Contact would otherwise be skipped' ELSE NULL END
           )`,
          [outboxId, payload, contactId, ownerAccountId, contactEmail, status],
        ),
      "P0001",
    );
  };
  await assertExtraKeyContactRejected("queued");
  await assertExtraKeyContactRejected("skipped");

  const malformedCancellationRequestId = randomUUID();
  const malformedCancellationOutboxId = randomUUID();
  const malformedCancellationPayload = {
    email: owner.email,
    locale: "en",
    userId: owner.userId,
    accountId: ownerAccountId,
    notificationCategory: "service",
    notificationRecipientKind: "account_user",
    notificationRecipientSubjectId: owner.userId,
    notificationRecipientScopeId: ownerAccountId,
    cancellationRequestId: malformedCancellationRequestId,
    productName: "Synthetic Context Product",
    effectiveAt: "2099-01-01T00:00:00.000Z",
    executionMode: "automatic",
  };
  await pool.query(
    `INSERT INTO outbox(id, event_type, unique_key, payload)
     VALUES ($1, 'notification.service_cancellation_scheduled', $2, $3)`,
    [
      malformedCancellationOutboxId,
      `service-cancellation:${malformedCancellationRequestId}`,
      malformedCancellationPayload,
    ],
  );
  await expectPgCode(
    () =>
      pool!.query(
        `INSERT INTO notification_delivery_operations(
           outbox_id, attempt_number, provider_operation_id,
           provider_installation_id, event_type, template_revision,
           payload_snapshot, recipient_user_id, client_account_id,
           recipient_subject_id, recipient_scope_id, recipient_kind,
           category, recipient, locale, request_fingerprint,
           status, last_error
         ) VALUES (
           $1, 1, opensales_notification_provider_operation_id($1, 1),
           'mock-mail-v1', 'notification.service_cancellation_scheduled',
           'service-cancellation-scheduled-v1', $2, $3, $4, $3, $4,
           'account_user', 'service', $5, 'en',
           opensales_notification_request_fingerprint(
             'notification.service_cancellation_scheduled',
             'service-cancellation-scheduled-v1', $2
           ),
           'skipped', 'Malformed business snapshots must fail closed'
         )`,
        [
          malformedCancellationOutboxId,
          malformedCancellationPayload,
          owner.userId,
          ownerAccountId,
          owner.email,
        ],
      ),
    "P0001",
  );

  const supportNotificationTicketId = randomUUID();
  const otherSupportNotificationTicketId = randomUUID();
  const publicSupportMessageId = randomUUID();
  const internalSupportMessageId = randomUUID();
  const crossTicketSupportMessageId = randomUUID();
  const rewrittenSupportMessageId = randomUUID();
  const malformedSupportMessageId = randomUUID();
  const supportSubject = "Schema 019 notification message binding";
  const publicSupportBody = "Exact public Staff reply for notification evidence";
  await pool.query(
    `INSERT INTO support_tickets(
       id, client_account_id, created_by_user_id, subject
     ) VALUES ($1, $3, $4, $5), ($2, $3, $4, 'Other notification Ticket')`,
    [
      supportNotificationTicketId,
      otherSupportNotificationTicketId,
      ownerAccountId,
      owner.userId,
      supportSubject,
    ],
  );
  await pool.query(
    `INSERT INTO support_ticket_messages(
       id, ticket_id, author_user_id, author_type, visibility, body
     ) VALUES
       ($1, $4, $5, 'staff', 'public', $6),
       ($2, $4, $5, 'staff', 'internal', 'Internal Staff note'),
       ($3, $7, $5, 'staff', 'public', 'Reply on another Ticket'),
       ($8, $4, $5, 'staff', 'public', 'Original body before mismatch'),
       ($9, $4, $5, 'staff', 'public', 'Malformed recipient snapshot body')`,
    [
      publicSupportMessageId,
      internalSupportMessageId,
      crossTicketSupportMessageId,
      supportNotificationTicketId,
      owner.userId,
      publicSupportBody,
      otherSupportNotificationTicketId,
      rewrittenSupportMessageId,
      malformedSupportMessageId,
    ],
  );
  const supportNotificationPayload = (
    ticketMessageId: string,
    ticketMessage: string,
  ) => ({
    email: owner.email,
    locale: "en",
    userId: owner.userId,
    accountId: ownerAccountId,
    notificationCategory: "support",
    notificationRecipientKind: "account_user",
    notificationRecipientSubjectId: owner.userId,
    notificationRecipientScopeId: ownerAccountId,
    ticketId: supportNotificationTicketId,
    ticketMessageId,
    ticketSubject: supportSubject,
    ticketMessage,
  });
  const insertSupportNotificationOperation = async (
    client: pg.PoolClient,
    outboxId: string,
    payload: ReturnType<typeof supportNotificationPayload>,
  ): Promise<void> => {
    await client.query(
      `INSERT INTO notification_delivery_operations(
         outbox_id, attempt_number, provider_operation_id,
         provider_installation_id, event_type, template_revision,
         payload_snapshot, recipient_user_id, client_account_id,
         recipient_subject_id, recipient_scope_id, recipient_kind,
         category, recipient, locale, request_fingerprint
       ) VALUES (
         $1, 1, opensales_notification_provider_operation_id($1, 1),
         'mock-mail-v1', 'notification.support_ticket_reply_requested',
         'support-ticket-reply-v1', $2, $3, $4, $3, $4,
         'account_user', 'support', $5, 'en',
         opensales_notification_request_fingerprint(
           'notification.support_ticket_reply_requested',
           'support-ticket-reply-v1', $2
         )
       )`,
      [outboxId, payload, owner.userId, ownerAccountId, owner.email],
    );
  };
  const createSupportNotificationOutbox = async (
    payload: ReturnType<typeof supportNotificationPayload>,
  ): Promise<string> => {
    const outboxId = randomUUID();
    await pool!.query(
      `INSERT INTO outbox(id, event_type, unique_key, payload)
       VALUES ($1, 'notification.support_ticket_reply_requested', $2, $3)`,
      [
        outboxId,
        `support-ticket-reply:${payload.ticketMessageId}`,
        payload,
      ],
    );
    return outboxId;
  };
  const exactSupportPayload = supportNotificationPayload(
    publicSupportMessageId,
    publicSupportBody,
  );
  const exactSupportOutboxId = await createSupportNotificationOutbox(
    exactSupportPayload,
  );
  await transaction(pool, async (client) => {
    await insertSupportNotificationOperation(
      client,
      exactSupportOutboxId,
      exactSupportPayload,
    );
  });
  const malformedSupportPayload = {
    ...supportNotificationPayload(
      malformedSupportMessageId,
      "Malformed recipient snapshot body",
    ),
    userId: randomUUID(),
  };
  const malformedSupportOutboxId = await createSupportNotificationOutbox(
    malformedSupportPayload,
  );
  await expectPgCode(
    () =>
      pool!.query(
        `INSERT INTO notification_delivery_operations(
           outbox_id, attempt_number, provider_operation_id,
           provider_installation_id, event_type, template_revision,
           payload_snapshot, recipient_user_id, client_account_id,
           recipient_subject_id, recipient_scope_id, recipient_kind,
           category, recipient, locale, request_fingerprint,
           status, last_error
         ) VALUES (
           $1, 1, opensales_notification_provider_operation_id($1, 1),
           'mock-mail-v1', 'notification.support_ticket_reply_requested',
           'support-ticket-reply-v1', $2, $3, $4, $3, $4,
           'account_user', 'support', $5, 'en',
           opensales_notification_request_fingerprint(
             'notification.support_ticket_reply_requested',
             'support-ticket-reply-v1', $2
           ),
           'skipped', 'Malformed account User snapshots must fail closed'
         )`,
        [
          malformedSupportOutboxId,
          malformedSupportPayload,
          owner.userId,
          ownerAccountId,
          owner.email,
        ],
      ),
    "P0001",
  );

  for (const invalid of [
    {
      payload: supportNotificationPayload(randomUUID(), publicSupportBody),
    },
    {
      payload: supportNotificationPayload(
        crossTicketSupportMessageId,
        "Reply on another Ticket",
      ),
    },
    {
      payload: supportNotificationPayload(internalSupportMessageId, "Internal Staff note"),
    },
    {
      payload: supportNotificationPayload(
        rewrittenSupportMessageId,
        "A body that does not match the immutable Staff message",
      ),
    },
  ]) {
    const outboxId = await createSupportNotificationOutbox(invalid.payload);
    await expectPgCode(async () => {
      const client = await pool!.connect();
      try {
        await client.query("BEGIN");
        await insertSupportNotificationOperation(client, outboxId, invalid.payload);
        await client.query(
          "SET CONSTRAINTS notification_delivery_operations_support_message_guard IMMEDIATE",
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }, "P0001");
  }

  await expectPgCode(async () => {
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      const providerOperationId = randomUUID();
      await client.query(
        `INSERT INTO renewal_reminder_delivery_facts(
           id, intent_id, attempt_number, provider_installation_id,
           provider_operation_id, provider_message_id, status,
           provider_occurred_at, recorded_at
         ) VALUES (
           $1, $2, 2, 'mock-mail-v1', $3::uuid, $3::text, 'delivered',
           '2026-01-16T10:11:12Z'::timestamptz,
           '2026-01-16T10:12:12Z'::timestamptz
         )`,
        [randomUUID(), reminderIntentIds[0], providerOperationId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }, "P0001");

  const failedRetryOperationId = failedProjection.find(
    (row) => row.attempt_number === 2,
  )?.provider_operation_id;
  assert.ok(failedRetryOperationId);
  await expectPgCode(async () => {
    const client = await pool!.connect();
    const providerOccurredAt = "2026-01-17T10:11:12Z";
    const recordedAt = "2026-01-17T10:12:12Z";
    const renderedSnapshot = {
      recipient: owner.email,
      template: "renewal-pre-due-v1",
      locale: "en",
      subject: "Synthetic renewal retry",
      body: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      sensitive: false,
      scenario: "delivered",
    };
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE notification_delivery_operations
         SET status = 'dispatching', attempts = attempts + 1,
             dispatch_started_at = pg_catalog.now(),
             rendered_request_snapshot = $2,
             rendered_request_fingerprint =
               opensales_notification_rendered_request_fingerprint($2::jsonb),
             updated_at = pg_catalog.now()
         WHERE provider_operation_id = $1`,
        [failedRetryOperationId, renderedSnapshot],
      );
      await client.query(
        `UPDATE notification_delivery_operations
         SET status = 'succeeded', last_checked_at = pg_catalog.now(),
             updated_at = pg_catalog.now()
         WHERE provider_operation_id = $1`,
        [failedRetryOperationId],
      );
      await client.query(
        `INSERT INTO notification_delivery_facts(
           outbox_id, attempt_number, recipient_user_id, client_account_id,
           recipient_subject_id, recipient_scope_id, recipient_kind,
           category, recipient, locale, provider_installation_id,
           provider_operation_id, provider_message_id, status,
           provider_occurred_at, recorded_at
         ) VALUES (
           $1, 2, $2, $3, $2, $3, 'account_user',
           'billing', $4, 'en', 'mock-mail-v1',
           $5::uuid, $5::text, 'delivered', $6, $7
         )`,
        [
          reminderOperationIds[1],
          owner.userId,
          ownerAccountId,
          owner.email,
          failedRetryOperationId,
          providerOccurredAt,
          recordedAt,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }, "P0001");

  await pool.query(
    `INSERT INTO client_memberships(
       client_account_id, user_id, role, permissions
     ) VALUES ($1, $2, 'owner', '["*"]'::jsonb)`,
    [ownerAccountId, multi.userId],
  );
  await pool.query(
    "UPDATE client_accounts SET owner_user_id = $2 WHERE id = $1",
    [ownerAccountId, multi.userId],
  );
  const transferredDuringRetry = await pool.query<{ owner_user_id: string }>(
    "SELECT owner_user_id FROM client_accounts WHERE id = $1",
    [ownerAccountId],
  );
  assert.equal(transferredDuringRetry.rows[0]?.owner_user_id, multi.userId);

  const pairedRetryClient = await pool.connect();
  const pairedProviderOccurredAt = "2026-01-18T10:11:12Z";
  const pairedRecordedAt = "2026-01-18T10:12:12Z";
  const pairedRenderedSnapshot = {
    recipient: owner.email,
    template: "renewal-pre-due-v1",
    locale: "en",
    subject: "Synthetic renewal retry after owner transfer",
    body: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
    sensitive: false,
    scenario: "delivered",
  };
  try {
    await pairedRetryClient.query("BEGIN");
    await pairedRetryClient.query(
      `UPDATE notification_delivery_operations
       SET status = 'dispatching', attempts = attempts + 1,
           dispatch_started_at = pg_catalog.now(),
           rendered_request_snapshot = $2,
           rendered_request_fingerprint =
             opensales_notification_rendered_request_fingerprint($2::jsonb),
           updated_at = pg_catalog.now()
       WHERE provider_operation_id = $1`,
      [failedRetryOperationId, pairedRenderedSnapshot],
    );
    await pairedRetryClient.query(
      `UPDATE notification_delivery_operations
       SET status = 'succeeded', last_checked_at = pg_catalog.now(),
           updated_at = pg_catalog.now()
       WHERE provider_operation_id = $1`,
      [failedRetryOperationId],
    );
    await pairedRetryClient.query(
      `INSERT INTO notification_delivery_facts(
         outbox_id, attempt_number, recipient_user_id, client_account_id,
         recipient_subject_id, recipient_scope_id, recipient_kind,
         category, recipient, locale, provider_installation_id,
         provider_operation_id, provider_message_id, status,
         provider_occurred_at, recorded_at
       ) VALUES (
         $1, 2, $2, $3, $2, $3, 'account_user',
         'billing', $4, 'en', 'mock-mail-v1',
         $5::uuid, $5::text, 'delivered', $6, $7
       )`,
      [
        reminderOperationIds[1],
        owner.userId,
        ownerAccountId,
        owner.email,
        failedRetryOperationId,
        pairedProviderOccurredAt,
        pairedRecordedAt,
      ],
    );
    await pairedRetryClient.query(
      `INSERT INTO renewal_reminder_delivery_facts(
         id, intent_id, attempt_number, provider_installation_id,
         provider_operation_id, provider_message_id, status,
         provider_occurred_at, recorded_at
       ) VALUES (
         $1, $2, 2, 'mock-mail-v1', $3::uuid, $3::text, 'delivered', $4, $5
       )`,
      [
        randomUUID(),
        reminderIntentIds[1],
        failedRetryOperationId,
        pairedProviderOccurredAt,
        pairedRecordedAt,
      ],
    );
    await pairedRetryClient.query("COMMIT");
  } catch (error) {
    await pairedRetryClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    pairedRetryClient.release();
  }
  await pool.query(
    "UPDATE client_accounts SET owner_user_id = $2 WHERE id = $1",
    [ownerAccountId, owner.userId],
  );
  const pairedRetryProjection = await pool.query<{
    generic_status: string;
    specialized_status: string;
    recipient_user_id: string;
  }>(
    `SELECT fact.status AS generic_status,
            renewal_fact.status AS specialized_status,
            fact.recipient_user_id
     FROM notification_delivery_facts fact
     JOIN renewal_reminder_delivery_facts renewal_fact
       ON renewal_fact.provider_operation_id = fact.provider_operation_id
      AND renewal_fact.attempt_number = fact.attempt_number
     WHERE fact.outbox_id = $1 AND fact.attempt_number = 2`,
    [reminderOperationIds[1]],
  );
  assert.deepEqual(pairedRetryProjection.rows[0], {
    generic_status: "delivered",
    specialized_status: "delivered",
    recipient_user_id: owner.userId,
  });

  const manualHistoryOutboxId = reminderOperationIds[2];
  const manualHistoryIntentId = reminderIntentIds[2];
  assert.ok(manualHistoryOutboxId);
  assert.ok(manualHistoryIntentId);
  const manualHistoryRenderedSnapshot = {
    recipient: owner.email,
    template: "renewal-overdue-first-v1",
    locale: "en",
    subject: "Synthetic exhausted notification retry",
    body: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
    sensitive: false,
    scenario: "failed",
  } as const;
  const recordFailedRenewalAttempt = async (
    attemptNumber: number,
  ): Promise<string> =>
    transaction(pool!, async (client) => {
      const operation = await client.query<{ provider_operation_id: string }>(
        `SELECT provider_operation_id
         FROM notification_delivery_operations
         WHERE outbox_id = $1 AND attempt_number = $2
         FOR UPDATE`,
        [manualHistoryOutboxId, attemptNumber],
      );
      const providerOperationId = operation.rows[0]?.provider_operation_id;
      assert.ok(providerOperationId);
      await client.query(
        `UPDATE notification_delivery_operations
         SET status = 'dispatching', attempts = attempts + 1,
             dispatch_started_at = pg_catalog.now(),
             rendered_request_snapshot = $3,
             rendered_request_fingerprint =
               opensales_notification_rendered_request_fingerprint($3::jsonb),
             updated_at = pg_catalog.now()
         WHERE outbox_id = $1 AND attempt_number = $2`,
        [manualHistoryOutboxId, attemptNumber, manualHistoryRenderedSnapshot],
      );
      await client.query(
        `UPDATE notification_delivery_operations
         SET status = 'failed', last_checked_at = pg_catalog.now(),
             last_error = 'Synthetic Mock Mail failure exhausted retry budget',
             updated_at = pg_catalog.now()
         WHERE outbox_id = $1 AND attempt_number = $2`,
        [manualHistoryOutboxId, attemptNumber],
      );
      const providerOccurredAt = new Date(
        Date.UTC(2026, 0, 20, 10, 0, attemptNumber),
      );
      await client.query(
        `INSERT INTO notification_delivery_facts(
           outbox_id, attempt_number,
           invitation_id, contact_id, recipient_user_id, client_account_id,
           recipient_subject_id, recipient_scope_id,
           recipient_kind, category, recipient, locale,
           provider_installation_id, provider_operation_id,
           provider_message_id, status, failure_reason,
           provider_occurred_at, recorded_at
         )
         SELECT
           operation.outbox_id, operation.attempt_number,
           operation.invitation_id, operation.contact_id,
           operation.recipient_user_id, operation.client_account_id,
           operation.recipient_subject_id, operation.recipient_scope_id,
           operation.recipient_kind, operation.category,
           operation.recipient, operation.locale,
           operation.provider_installation_id,
           operation.provider_operation_id,
           operation.provider_operation_id::text,
           'failed', 'Synthetic Mock Mail failure exhausted retry budget',
           $3, $3
         FROM notification_delivery_operations operation
         WHERE operation.outbox_id = $1 AND operation.attempt_number = $2`,
        [manualHistoryOutboxId, attemptNumber, providerOccurredAt],
      );
      await client.query(
        `INSERT INTO renewal_reminder_delivery_facts(
           id, intent_id, attempt_number, provider_installation_id,
           provider_operation_id, provider_message_id, status,
           failure_reason, provider_occurred_at, recorded_at
         ) VALUES (
           $1, $2, $3, 'mock-mail-v1', $4::uuid, ($4::uuid)::text, 'failed',
           'Synthetic Mock Mail failure exhausted retry budget', $5, $5
         )`,
        [
          randomUUID(),
          manualHistoryIntentId,
          attemptNumber,
          providerOperationId,
          providerOccurredAt,
        ],
      );
      return providerOperationId;
    });

  await recordFailedRenewalAttempt(2);
  const manualHistoryOperation = await pool.query<{ id: string }>(
    `INSERT INTO notification_delivery_operations(
       outbox_id, attempt_number, provider_operation_id,
       provider_installation_id, operation_origin,
       event_type, template_revision, payload_snapshot,
       invitation_id, contact_id, recipient_user_id, client_account_id,
       recipient_subject_id, recipient_scope_id,
       recipient_kind, category, recipient, locale, request_fingerprint
     )
     SELECT
       operation.outbox_id, 3,
       opensales_notification_provider_operation_id(operation.outbox_id, 3),
       operation.provider_installation_id, operation.operation_origin,
       operation.event_type, operation.template_revision,
       operation.payload_snapshot, operation.invitation_id,
       operation.contact_id, operation.recipient_user_id,
       operation.client_account_id, operation.recipient_subject_id,
       operation.recipient_scope_id, operation.recipient_kind,
       operation.category, operation.recipient, operation.locale,
       operation.request_fingerprint
     FROM notification_delivery_operations operation
     WHERE operation.outbox_id = $1 AND operation.attempt_number = 1
     RETURNING id`,
    [manualHistoryOutboxId],
  );
  const manualHistoryOperationId = manualHistoryOperation.rows[0]?.id;
  assert.ok(manualHistoryOperationId);
  await recordFailedRenewalAttempt(3);
  await pool.query(
    `UPDATE durable_jobs
     SET status = 'manual', locked_at = NULL, locked_by = NULL,
         last_error = 'Synthetic notification retry budget exhausted',
         updated_at = pg_catalog.now()
     WHERE job_type = 'notification.send'
       AND unique_key = 'outbox:' || $1::uuid::text
       AND payload = pg_catalog.jsonb_build_object('outboxId', $1::uuid::text)`,
    [manualHistoryOutboxId],
  );

  await pool.query(
    `WITH ranked AS (
       SELECT client_account_id,
              pg_catalog.row_number() OVER (ORDER BY client_account_id) AS sequence
       FROM client_memberships
       WHERE user_id = $1
     )
     UPDATE client_memberships membership
     SET created_at =
       '2020-02-01T00:00:00.000000Z'::timestamptz +
       ranked.sequence * interval '1 microsecond'
     FROM ranked
     WHERE membership.user_id = $1
       AND membership.client_account_id = ranked.client_account_id`,
    [contextPager.userId],
  );

  const compatible = await assertSchemaCompatible(pool);
  assert.equal(
    compatible.installedSchemaVersion,
    "019_stage_c_account_context_memberships_contacts",
  );
  await assert.rejects(
    assertSchemaCompatible(pool, { enable017RollbackBridge: true }),
    /refuses the legacy 016-to-017 rollback bridge/,
  );
  await assert.rejects(
    assertSchema018NativeSafe({
      query: async (text: string, values?: unknown[]) => pool!.query(text, values),
    }),
    /incompatible with application schema 018_stage_c_support_tickets/,
  );

  for (const index of [
    "client_membership_invitations_active_email_idx",
    "client_contacts_active_email_idx",
    "notification_delivery_operations_verification_token_key",
  ] as const) {
    const catalogDriftClient = await pool.connect();
    try {
      await catalogDriftClient.query("BEGIN");
      await catalogDriftClient.query(`DROP INDEX ${index}`);
      await assert.rejects(
        assertSchema019NativeSafe({
          query: async (text: string, values?: unknown[]) =>
            catalogDriftClient.query(text, values),
        }),
        /Schema 019 is incomplete or counterfeit/,
      );
      await catalogDriftClient.query("ROLLBACK");
    } catch (error) {
      await catalogDriftClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      catalogDriftClient.release();
    }
  }

  for (const [table, trigger] of [
    ["sessions", "sessions_identity_immutable"],
    ["users", "users_bump_identity_context_version"],
    ["orders", "orders_snapshot_immutable"],
    ["order_items", "order_items_snapshot_immutable"],
    ["services", "services_identity_immutable"],
    ["payment_attempts", "payment_attempts_identity_immutable"],
    ["client_membership_invitations", "client_membership_invitations_identity_immutable"],
    ["client_contacts", "client_contacts_identity_immutable"],
    ["client_accounts", "client_accounts_record_owner_transfer"],
    ["client_account_owner_transfer_facts", "client_account_owner_transfer_facts_immutable"],
    ["notification_delivery_operations", "notification_delivery_operations_guard"],
    ["notification_delivery_operations", "notification_delivery_operations_recipient_guard"],
    ["renewal_reminder_delivery_facts", "renewal_reminder_delivery_facts_immutable"],
    [
      "renewal_notification_dispatch_suppressions",
      "renewal_notification_dispatch_suppressions_immutable",
    ],
    ["notification_delivery_facts", "notification_delivery_facts_immutable"],
  ] as const) {
    const immutableDriftClient = await pool.connect();
    try {
      await immutableDriftClient.query("BEGIN");
      await immutableDriftClient.query(`DROP TRIGGER ${trigger} ON ${table}`);
      await assert.rejects(
        assertSchema019NativeSafe({
          query: async (text: string, values?: unknown[]) =>
            immutableDriftClient.query(text, values),
        }),
        /Schema (017|019) is incomplete or counterfeit/,
      );
      await immutableDriftClient.query("ROLLBACK");
    } catch (error) {
      await immutableDriftClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      immutableDriftClient.release();
    }
  }

  const inheritedCatalogDriftClient = await pool.connect();
  try {
    await inheritedCatalogDriftClient.query("BEGIN");
    await inheritedCatalogDriftClient.query(
      `CREATE FUNCTION public.schema_019_unreviewed_client_account_trigger()
       RETURNS trigger
       LANGUAGE plpgsql
       SET search_path = pg_catalog, public
       AS $$ BEGIN RETURN NEW; END $$`,
    );
    await inheritedCatalogDriftClient.query(
      `CREATE TRIGGER schema_019_unreviewed_client_account_trigger
       BEFORE UPDATE ON public.client_accounts
       FOR EACH ROW
       EXECUTE FUNCTION public.schema_019_unreviewed_client_account_trigger()`,
    );
    await assert.rejects(
      assertSchema019NativeSafe({
        query: async (text: string, values?: unknown[]) =>
          inheritedCatalogDriftClient.query(text, values),
      }),
      /Schema 017 is incomplete or counterfeit/,
    );
    await inheritedCatalogDriftClient.query("ROLLBACK");
  } catch (error) {
    await inheritedCatalogDriftClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    inheritedCatalogDriftClient.release();
  }

  const upgradedSessions = await pool.query<{
    id: string;
    active_client_account_id: string | null;
    account_context_version: string;
  }>(
    `SELECT id, active_client_account_id, account_context_version::text
     FROM sessions WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [[owner.sessionId, multi.sessionId]],
  );
  const ownerSession = upgradedSessions.rows.find((row) => row.id === owner.sessionId);
  const multiSession = upgradedSessions.rows.find((row) => row.id === multi.sessionId);
  assert.equal(ownerSession?.active_client_account_id, ownerAccountId);
  assert.equal(ownerSession?.account_context_version, "1");
  assert.equal(multiSession?.active_client_account_id, null);
  assert.equal(multiSession?.account_context_version, "0");
  const relationshipBackfill = await pool.query<{
    item_order_id: string;
    item_client_account_id: string;
    allocation_invoice_id: string;
    allocation_client_account_id: string | null;
    allocation_legacy: boolean;
  }>(
    `SELECT item.order_id AS item_order_id,
            item.client_account_id AS item_client_account_id,
            allocation.invoice_id AS allocation_invoice_id,
            allocation.client_account_id AS allocation_client_account_id,
            allocation.schema_019_legacy_relationship AS allocation_legacy
     FROM order_items item
     JOIN payment_allocations allocation ON allocation.payment_attempt_id = $2
     WHERE item.id = $1`,
    [orderItemId, paymentAttemptId],
  );
  assert.deepEqual(relationshipBackfill.rows[0], {
    item_order_id: orderId,
    item_client_account_id: ownerAccountId,
    allocation_invoice_id: invoiceId,
    allocation_client_account_id: null,
    allocation_legacy: true,
  });

  ({ app } = await buildApp(config, pool));
  await app.ready();
  const ownerCookie = `${config.SESSION_COOKIE_NAME}=${owner.sessionToken}`;
  const multiCookie = `${config.SESSION_COOKIE_NAME}=${multi.sessionToken}`;

  const eligibilityCookie =
    `${config.SESSION_COOKIE_NAME}=${eligibilitySessionToken}`;
  const unverifiedEligibilityMe = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: eligibilityCookie },
  });
  assert.equal(
    unverifiedEligibilityMe.statusCode,
    200,
    unverifiedEligibilityMe.body,
  );
  assert.equal(
    unverifiedEligibilityMe.headers["x-oss-account-context-version"],
    "1",
  );
  assert.equal(
    unverifiedEligibilityMe.headers["x-oss-client-account-id"],
    undefined,
  );
  assert.equal(
    json<{ clientAccountId: string | null }>(unverifiedEligibilityMe)
      .clientAccountId,
    null,
  );
  assert.equal(json<{ context: unknown }>(unverifiedEligibilityMe).context, null);

  const verifiedEligibility = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify-email",
    payload: { token: eligibilityVerificationToken },
  });
  assert.equal(verifiedEligibility.statusCode, 200, verifiedEligibility.body);
  assert.equal(
    json<{ status: string }>(verifiedEligibility).status,
    "verified",
  );
  const verifiedEligibilityMe = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: eligibilityCookie },
  });
  assert.equal(verifiedEligibilityMe.statusCode, 200, verifiedEligibilityMe.body);
  assert.equal(
    verifiedEligibilityMe.headers["x-oss-account-context-version"],
    "2",
  );
  assert.equal(
    verifiedEligibilityMe.headers["x-oss-client-account-id"],
    ownerAccountId,
  );
  assert.equal(
    json<{ clientAccountId: string | null }>(verifiedEligibilityMe)
      .clientAccountId,
    ownerAccountId,
  );
  assert.equal(
    json<{ context: { clientAccountId: string } }>(verifiedEligibilityMe)
      .context.clientAccountId,
    ownerAccountId,
  );

  await pool.query(
    `UPDATE users
     SET restricted_at = pg_catalog.now(), updated_at = pg_catalog.now()
     WHERE id = $1`,
    [eligibilityUserId],
  );
  const restrictedEligibilityMe = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: eligibilityCookie },
  });
  assert.equal(
    restrictedEligibilityMe.statusCode,
    200,
    restrictedEligibilityMe.body,
  );
  assert.equal(
    restrictedEligibilityMe.headers["x-oss-account-context-version"],
    "3",
  );
  assert.equal(
    restrictedEligibilityMe.headers["x-oss-client-account-id"],
    undefined,
  );
  assert.equal(
    json<{ clientAccountId: string | null }>(restrictedEligibilityMe)
      .clientAccountId,
    null,
  );
  assert.equal(json<{ context: unknown }>(restrictedEligibilityMe).context, null);
  assert.deepEqual(
    json<{ restrictions: unknown }>(restrictedEligibilityMe).restrictions,
    { user: true, clientAccount: false },
  );

  await pool.query(
    `UPDATE users
     SET restricted_at = NULL, updated_at = pg_catalog.now()
     WHERE id = $1`,
    [eligibilityUserId],
  );
  const restoredEligibilityMe = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: eligibilityCookie },
  });
  assert.equal(restoredEligibilityMe.statusCode, 200, restoredEligibilityMe.body);
  assert.equal(
    restoredEligibilityMe.headers["x-oss-account-context-version"],
    "4",
  );
  assert.equal(
    restoredEligibilityMe.headers["x-oss-client-account-id"],
    ownerAccountId,
  );
  assert.equal(
    json<{ clientAccountId: string | null }>(restoredEligibilityMe)
      .clientAccountId,
    ownerAccountId,
  );
  const restoredEligibilitySessions = await pool.query<{
    id: string;
    account_context_version: string;
    active_client_account_id: string | null;
  }>(
    `SELECT id, account_context_version::text, active_client_account_id
     FROM sessions WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [[
      eligibilitySessionId,
      eligibilityExpiredSessionId,
      eligibilityRevokedSessionId,
    ]],
  );
  const restoredActiveEligibilitySession = restoredEligibilitySessions.rows.find(
    (row) => row.id === eligibilitySessionId,
  );
  const restoredExpiredEligibilitySession = restoredEligibilitySessions.rows.find(
    (row) => row.id === eligibilityExpiredSessionId,
  );
  const unchangedRevokedEligibilitySession = restoredEligibilitySessions.rows.find(
    (row) => row.id === eligibilityRevokedSessionId,
  );
  assert.deepEqual(restoredActiveEligibilitySession, {
    id: eligibilitySessionId,
    account_context_version: "4",
    active_client_account_id: ownerAccountId,
  });
  assert.deepEqual(restoredExpiredEligibilitySession, {
    id: eligibilityExpiredSessionId,
    account_context_version: "4",
    active_client_account_id: ownerAccountId,
  });
  assert.deepEqual(unchangedRevokedEligibilitySession, {
    id: eligibilityRevokedSessionId,
    account_context_version: "1",
    active_client_account_id: ownerAccountId,
  });

  const ownerMe = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: ownerCookie },
  });
  assert.equal(ownerMe.statusCode, 200, ownerMe.body);
  assert.equal(ownerMe.headers["x-oss-client-account-id"], ownerAccountId);
  assert.equal(ownerMe.headers["x-oss-account-context-version"], "1");
  assert.deepEqual(json<{ restrictions: unknown }>(ownerMe).restrictions, {
    user: false,
    clientAccount: false,
  });
  assert.deepEqual(
    json<{ context: { capabilities: string[] } }>(ownerMe).context.capabilities,
    [
      "account.contacts.manage",
      "account.contacts.read",
      "account.history.read",
      "account.members.manage",
      "account.members.read",
      "billing.read",
      "billing.write",
      "orders.create",
      "services.manage",
      "support.tickets.write",
    ],
  );

  const customerNotificationHistory = await collectPages<{
    id: string;
    recipient: string;
    provider: string;
    status: string;
    operationState: string;
    outcomeStatus: string | null;
    reason: string | null;
    requiresAttention: boolean;
    attemptNumber: number;
    createdAt: string;
  }>({
    url: "/api/v1/customer/notification-deliveries",
    cookie: ownerCookie,
    limit: 1,
  });
  const expectedCustomerNotificationCount = await pool.query<{ count: string }>(
    `SELECT pg_catalog.count(*)::text AS count
     FROM notification_delivery_operations
     WHERE client_account_id = $1`,
    [ownerAccountId],
  );
  assert.equal(
    customerNotificationHistory.items.length,
    Number(expectedCustomerNotificationCount.rows[0]?.count ?? "0"),
  );
  assert.ok(customerNotificationHistory.items.length > 1);
  for (const item of customerNotificationHistory.items) {
    assert.match(item.recipient, /^.\*\*\*@[^@]+$/);
    assert.equal(item.provider, "mock-mail-v1");
    assert.ok(item.status.length > 0);
    assert.ok(!("outboxId" in item));
    assert.ok(!("providerOperationId" in item));
    assert.ok(!("providerMessageId" in item));
    assert.ok(!("payload" in item));
    assert.ok(!("body" in item));
    assert.ok(!("token" in item));
  }
  const manualNotificationHistory = customerNotificationHistory.items.find(
    (item) => item.id === manualHistoryOperationId,
  );
  assert.deepEqual(
    manualNotificationHistory && {
      attemptNumber: manualNotificationHistory.attemptNumber,
      status: manualNotificationHistory.status,
      operationState: manualNotificationHistory.operationState,
      outcomeStatus: manualNotificationHistory.outcomeStatus,
      reason: manualNotificationHistory.reason,
      requiresAttention: manualNotificationHistory.requiresAttention,
    },
    {
      attemptNumber: 3,
      status: "manual",
      operationState: "manual",
      outcomeStatus: "failed",
      reason: "operator_attention_required",
      requiresAttention: true,
    },
  );

  const multiLogin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: multi.email, password: loginPassword },
  });
  assert.equal(multiLogin.statusCode, 409, multiLogin.body);
  assert.equal(json<{ code: string }>(multiLogin).code, "ACCOUNT_CONTEXT_REQUIRED");
  assert.ok(multiLogin.headers["set-cookie"]);
  assert.equal(multiLogin.headers["x-oss-account-context-version"], "0");
  assert.equal(multiLogin.headers["x-oss-client-account-id"], undefined);
  const loginContextCookie = String(multiLogin.headers["set-cookie"]).split(";", 1)[0];
  assert.ok(loginContextCookie);
  const loginContexts = await app.inject({
    method: "GET",
    url: "/api/v1/auth/account-contexts",
    headers: { cookie: loginContextCookie },
  });
  assert.equal(loginContexts.statusCode, 200, loginContexts.body);
  assert.equal(
    json<{ items: unknown[] }>(loginContexts).items.length,
    2,
  );
  const loginContextSelection = await app.inject({
    method: "PUT",
    url: "/api/v1/auth/account-context",
    headers: {
      cookie: loginContextCookie,
      "x-oss-account-context-version": "0",
    },
    payload: { clientAccountId: thirdAccountId },
  });
  assert.equal(loginContextSelection.statusCode, 200, loginContextSelection.body);
  assert.equal(
    loginContextSelection.headers["x-oss-client-account-id"],
    thirdAccountId,
  );

  const pagerLogin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: contextPager.email, password: loginPassword },
  });
  assert.equal(pagerLogin.statusCode, 409, pagerLogin.body);
  const pagerCookie = String(pagerLogin.headers["set-cookie"]).split(";", 1)[0];
  assert.ok(pagerCookie);
  const pagedContexts = await collectPages<{ clientAccountId: string }>({
    url: "/api/v1/auth/account-contexts",
    cookie: pagerCookie,
    limit: 7,
  });
  assert.equal(pagedContexts.items.length, contextPager.accountIds.length);

  const contextWithoutVersion = await app.inject({
    method: "PUT",
    url: "/api/v1/auth/account-context",
    headers: { cookie: multiCookie },
    payload: { clientAccountId: secondAccountId },
  });
  assert.equal(contextWithoutVersion.statusCode, 428, contextWithoutVersion.body);
  const switched = await app.inject({
    method: "PUT",
    url: "/api/v1/auth/account-context",
    headers: {
      cookie: multiCookie,
      "x-oss-account-context-version": "0",
    },
    payload: { clientAccountId: secondAccountId },
  });
  assert.equal(switched.statusCode, 200, switched.body);
  assert.equal(switched.headers["x-oss-client-account-id"], secondAccountId);
  assert.equal(switched.headers["x-oss-account-context-version"], "1");
  const staleSwitch = await app.inject({
    method: "PUT",
    url: "/api/v1/auth/account-context",
    headers: {
      cookie: multiCookie,
      "x-oss-account-context-version": "0",
    },
    payload: { clientAccountId: thirdAccountId },
  });
  assert.equal(staleSwitch.statusCode, 409, staleSwitch.body);
  assert.equal(json<{ code: string }>(staleSwitch).code, "ACCOUNT_CONTEXT_STALE");
  assert.equal(staleSwitch.headers["x-oss-account-context-version"], "1");
  assert.equal(staleSwitch.headers["x-oss-client-account-id"], secondAccountId);

  const mixedMembership = await createContextMember({
    clientAccountId: ownerAccountId,
    role: "viewer",
    label: "mixed-restriction",
  });
  await pool.query(
    `INSERT INTO client_memberships(
       client_account_id, user_id, role, permissions, restricted_at
     ) VALUES ($1, $2, 'viewer', '[]'::jsonb, pg_catalog.now())`,
    [secondAccountId, mixedMembership.userId],
  );
  await pool.query(
    "UPDATE users SET password_hash = $2 WHERE id = $1",
    [mixedMembership.userId, loginPasswordHash],
  );
  const mixedMembershipLogin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: mixedMembership.email, password: loginPassword },
  });
  assert.equal(mixedMembershipLogin.statusCode, 409, mixedMembershipLogin.body);
  assert.equal(
    mixedMembershipLogin.headers["x-oss-account-context-version"],
    "0",
  );

  const restrictedOwner = await createContextMember({
    clientAccountId: ownerAccountId,
    role: "viewer",
    label: "restricted-only",
  });
  await pool.query(
    `UPDATE client_memberships
     SET restricted_at = pg_catalog.now(), updated_at = pg_catalog.now()
     WHERE client_account_id = $1 AND user_id = $2`,
    [ownerAccountId, restrictedOwner.userId],
  );
  await pool.query(
    "UPDATE users SET password_hash = $2 WHERE id = $1",
    [restrictedOwner.userId, loginPasswordHash],
  );
  const restrictedOnlyLogin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: restrictedOwner.email, password: loginPassword },
  });
  assert.equal(restrictedOnlyLogin.statusCode, 409, restrictedOnlyLogin.body);
  assert.equal(
    restrictedOnlyLogin.headers["x-oss-account-context-version"],
    "0",
  );

  const target = await createContextMember({
    clientAccountId: ownerAccountId,
    role: "billing",
    permissions: ["account.contacts.read"],
    label: "concurrent-target",
  });
  const staleHeaderMember = await createContextMember({
    clientAccountId: ownerAccountId,
    role: "billing",
    label: "stale-response-header",
  });
  const staleHeaderBlocker = await pool.connect();
  try {
    await staleHeaderBlocker.query("BEGIN");
    await staleHeaderBlocker.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
      staleHeaderMember.userId,
    ]);
    const staleHeaderMutation = app.inject({
      method: "POST",
      url: "/api/v1/tickets",
      headers: {
        cookie: `${config.SESSION_COOKIE_NAME}=${staleHeaderMember.sessionToken}`,
        "x-oss-account-context-version": "1",
      },
      payload: {
        subject: "Membership-wins stale response",
        message: "This mutation must return the newly locked context version",
      },
    });
    await waitForBlockedQuery("WHERE id = ANY($1::uuid[])");
    await pool.query(
      `UPDATE client_memberships
       SET restricted_at = pg_catalog.now(), updated_at = pg_catalog.now()
       WHERE client_account_id = $1 AND user_id = $2`,
      [ownerAccountId, staleHeaderMember.userId],
    );
    await staleHeaderBlocker.query("COMMIT");
    const staleHeaderResponse = await staleHeaderMutation;
    assert.equal(staleHeaderResponse.statusCode, 409, staleHeaderResponse.body);
    assert.equal(
      json<{ code: string }>(staleHeaderResponse).code,
      "ACCOUNT_CONTEXT_STALE",
    );
    assert.equal(staleHeaderResponse.headers["x-oss-account-context-version"], "2");
    assert.equal(staleHeaderResponse.headers["x-oss-client-account-id"], undefined);
  } catch (error) {
    await staleHeaderBlocker.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    staleHeaderBlocker.release();
  }
  const loginRaceMember = await createContextMember({
    clientAccountId: ownerAccountId,
    role: "billing",
    label: "login-membership-race",
  });
  await pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [
    loginRaceMember.userId,
    loginPasswordHash,
  ]);
  const inviteeUserId = randomUUID();
  const inviteeSessionId = randomUUID();
  const inviteeToken = randomBytes(32).toString("base64url");
  const inviteeEmail = `invited-${databaseName}@example.invalid`;
  await pool.query(
    `INSERT INTO users(id, email, password_hash, email_verified_at)
     VALUES ($1, $2, 'synthetic-not-a-password', pg_catalog.now())`,
    [inviteeUserId, inviteeEmail],
  );
  await pool.query(
    `INSERT INTO sessions(id, user_id, token_digest, expires_at)
     VALUES ($1, $2, $3, pg_catalog.now() + interval '1 hour')`,
    [inviteeSessionId, inviteeUserId, digestToken(inviteeToken)],
  );
  const inviteeCookie = `${config.SESSION_COOKIE_NAME}=${inviteeToken}`;

  await pool.query(
    `INSERT INTO reauth_grants(user_id, session_id, expires_at)
     VALUES
       ($1, $2, pg_catalog.now() + interval '15 minutes'),
       ($3, $4, pg_catalog.now() + interval '15 minutes')`,
    [owner.userId, owner.sessionId, target.userId, target.sessionId],
  );

  async function assertLoginMembershipRace(input: Readonly<{
    membershipFirst: boolean;
    action: "restrict" | "remove";
  }>): Promise<void> {
    if (!pool || !app) throw new Error("Account-context race fixture is unavailable");
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
        loginRaceMember.userId,
      ]);
      const startLogin = () =>
        app!.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { email: loginRaceMember.email, password: loginPassword },
        });
      const startMembershipMutation = () =>
        app!.inject({
          method: input.action === "restrict" ? "PATCH" : "DELETE",
          url: `/api/v1/account/members/${loginRaceMember.userId}`,
          headers: {
            cookie: ownerCookie,
            "x-oss-account-context-version": "1",
          },
          ...(input.action === "restrict" ? { payload: { restricted: true } } : {}),
        });

      let loginPromise: ReturnType<typeof startLogin>;
      let membershipPromise: ReturnType<typeof startMembershipMutation>;
      if (input.membershipFirst) {
        membershipPromise = startMembershipMutation();
        await waitForBlockedQuery("WHERE id = ANY($1::uuid[])");
        loginPromise = startLogin();
        await waitForBlockedQuery("restricted_at AS user_restricted_at");
      } else {
        loginPromise = startLogin();
        await waitForBlockedQuery("restricted_at AS user_restricted_at");
        membershipPromise = startMembershipMutation();
        await waitForBlockedQuery("WHERE id = ANY($1::uuid[])");
      }
      await blocker.query("COMMIT");
      const [login, membership] = await Promise.all([loginPromise, membershipPromise]);
      assert.equal(membership.statusCode, 200, membership.body);
      assert.equal(
        login.statusCode,
        input.membershipFirst ? 409 : 200,
        login.body,
      );
    } catch (error) {
      await blocker.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      blocker.release();
    }
    const invalidContexts = await pool.query<{ count: string }>(
      `SELECT pg_catalog.count(*)::text AS count
       FROM sessions session_record
       LEFT JOIN client_memberships membership
         ON membership.client_account_id = session_record.active_client_account_id
        AND membership.user_id = session_record.user_id
       WHERE session_record.user_id = $1
         AND session_record.active_client_account_id IS NOT NULL
         AND (
           membership.user_id IS NULL
           OR membership.removed_at IS NOT NULL
           OR membership.restricted_at IS NOT NULL
         )`,
      [loginRaceMember.userId],
    );
    assert.equal(invalidContexts.rows[0]?.count, "0");
  }

  await assertLoginMembershipRace({ membershipFirst: false, action: "restrict" });
  const unrestrictedRaceMember = await app.inject({
    method: "PATCH",
    url: `/api/v1/account/members/${loginRaceMember.userId}`,
    headers: {
      cookie: ownerCookie,
      "x-oss-account-context-version": "1",
    },
    payload: { restricted: false },
  });
  assert.equal(unrestrictedRaceMember.statusCode, 200, unrestrictedRaceMember.body);
  await assertLoginMembershipRace({ membershipFirst: true, action: "remove" });

  const directRaceMember = await createContextMember({
    clientAccountId: ownerAccountId,
    role: "billing",
    label: "direct-session-membership-race",
  });
  const directSessionId = randomUUID();
  const sessionWriter = await pool.connect();
  const membershipWriter = await pool.connect();
  try {
    await sessionWriter.query("BEGIN");
    await sessionWriter.query(
      `INSERT INTO sessions(
         id, user_id, token_digest, expires_at,
         active_client_account_id, account_context_version
       ) VALUES ($1, $2, $3, pg_catalog.now() + interval '1 hour', $4, 1)`,
      [
        directSessionId,
        directRaceMember.userId,
        digestToken(randomBytes(32).toString("base64url")),
        ownerAccountId,
      ],
    );
    const restriction = membershipWriter.query(
      `UPDATE client_memberships
       SET restricted_at = pg_catalog.now(), updated_at = pg_catalog.now()
       WHERE client_account_id = $1 AND user_id = $2`,
      [ownerAccountId, directRaceMember.userId],
    );
    await waitForBlockedQuery("SET restricted_at = pg_catalog.now()");
    await sessionWriter.query("COMMIT");
    await restriction;
  } catch (error) {
    await sessionWriter.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    sessionWriter.release();
    membershipWriter.release();
  }
  const directRaceContext = await pool.query<{
    active_client_account_id: string | null;
    account_context_version: string;
  }>(
    `SELECT active_client_account_id, account_context_version::text
     FROM sessions WHERE id = $1`,
    [directSessionId],
  );
  assert.deepEqual(directRaceContext.rows[0], {
    active_client_account_id: null,
    account_context_version: "2",
  });

  const directSwitchRaceMember = await createContextMember({
    clientAccountId: ownerAccountId,
    role: "billing",
    label: "direct-context-switch-race",
  });
  await pool.query(
    `INSERT INTO client_memberships(
       client_account_id, user_id, role, permissions
     ) VALUES ($1, $2, 'billing', '[]'::jsonb)`,
    [secondAccountId, directSwitchRaceMember.userId],
  );
  const membershipFirst = await pool.connect();
  try {
    await membershipFirst.query("BEGIN");
    await membershipFirst.query(
      `UPDATE client_memberships
       SET restricted_at = pg_catalog.now(), updated_at = pg_catalog.now()
       WHERE client_account_id = $1 AND user_id = $2`,
      [secondAccountId, directSwitchRaceMember.userId],
    );
    await expectPgCode(
      () =>
        pool!.query(
          `UPDATE sessions
           SET active_client_account_id = $2, account_context_version = 2
           WHERE id = $1`,
          [directSwitchRaceMember.sessionId, secondAccountId],
        ),
      "55P03",
    );
    await membershipFirst.query("COMMIT");
  } catch (error) {
    await membershipFirst.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    membershipFirst.release();
  }
  const membershipFirstContext = await pool.query<{
    active_client_account_id: string | null;
    account_context_version: string;
  }>(
    `SELECT active_client_account_id, account_context_version::text
     FROM sessions WHERE id = $1`,
    [directSwitchRaceMember.sessionId],
  );
  assert.deepEqual(membershipFirstContext.rows[0], {
    active_client_account_id: ownerAccountId,
    account_context_version: "1",
  });

  await pool.query(
    `UPDATE client_memberships
     SET restricted_at = NULL, updated_at = pg_catalog.now()
     WHERE client_account_id = $1 AND user_id = $2`,
    [secondAccountId, directSwitchRaceMember.userId],
  );
  const sessionFirst = await pool.connect();
  try {
    await sessionFirst.query("BEGIN");
    await sessionFirst.query(
      `UPDATE sessions
       SET active_client_account_id = $2, account_context_version = 2
       WHERE id = $1`,
      [directSwitchRaceMember.sessionId, secondAccountId],
    );
    const restriction = pool.query(
      `UPDATE client_memberships
       SET restricted_at = pg_catalog.now(), updated_at = pg_catalog.now()
       WHERE client_account_id = $1 AND user_id = $2`,
      [secondAccountId, directSwitchRaceMember.userId],
    );
    await waitForBlockedQuery("SET restricted_at = pg_catalog.now()");
    await sessionFirst.query("COMMIT");
    await restriction;
  } catch (error) {
    await sessionFirst.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    sessionFirst.release();
  }
  const sessionFirstContext = await pool.query<{
    active_client_account_id: string | null;
    account_context_version: string;
  }>(
    `SELECT active_client_account_id, account_context_version::text
     FROM sessions WHERE id = $1`,
    [directSwitchRaceMember.sessionId],
  );
  assert.deepEqual(sessionFirstContext.rows[0], {
    active_client_account_id: null,
    account_context_version: "3",
  });
  await pool.query(
    `INSERT INTO staff_members(user_id, roles, permissions)
     VALUES (
       $1, ARRAY['Operations'],
       '["accounts.contacts.read","accounts.notification.read"]'::jsonb
     )`,
    [owner.userId],
  );
  const staffNotificationHistory = await app.inject({
    method: "GET",
    url:
      `/api/v1/admin/client-accounts/${ownerAccountId}` +
      "/notification-deliveries?limit=1",
    headers: { cookie: ownerCookie },
  });
  assert.equal(staffNotificationHistory.statusCode, 200, staffNotificationHistory.body);
  const staffNotificationPage = json<{
    items: Array<Record<string, unknown> & { recipient: string }>;
    hasMore: boolean;
    nextCursor: string | null;
  }>(staffNotificationHistory);
  assert.equal(staffNotificationPage.items.length, 1);
  assert.match(staffNotificationPage.items[0]!.recipient, /^.\*\*\*@[^@]+$/);
  assert.equal(staffNotificationPage.hasMore, true);
  assert.ok(staffNotificationPage.nextCursor);
  assertCursorPreservesPostgresMicroseconds(
    staffNotificationPage.nextCursor!,
    "admin notification deliveries",
  );
  for (const forbidden of [
    "outboxId",
    "providerOperationId",
    "providerMessageId",
    "payload",
    "body",
    "token",
  ]) {
    assert.ok(!(forbidden in staffNotificationPage.items[0]!));
  }
  const otherAccountNotificationHistory = await app.inject({
    method: "GET",
    url:
      `/api/v1/admin/client-accounts/${secondAccountId}` +
      "/notification-deliveries",
    headers: { cookie: ownerCookie },
  });
  assert.equal(
    otherAccountNotificationHistory.statusCode,
    200,
    otherAccountNotificationHistory.body,
  );
  assert.deepEqual(
    json<{ items: unknown[] }>(otherAccountNotificationHistory).items,
    [],
  );

  const billingCapabilityMember = await createContextMember({
    clientAccountId: ownerAccountId,
    role: "billing",
    label: "capability-billing",
  });
  const technicalCapabilityMember = await createContextMember({
    clientAccountId: ownerAccountId,
    role: "technical",
    label: "capability-technical",
  });
  const viewerCapabilityMember = await createContextMember({
    clientAccountId: ownerAccountId,
    role: "viewer",
    label: "capability-viewer",
  });
  const explicitViewerCapabilityMember = await createContextMember({
    clientAccountId: ownerAccountId,
    role: "viewer",
    permissions: [
      "orders.create",
      "billing.write",
      "services.manage",
      "support.tickets.write",
    ],
    label: "capability-viewer-explicit",
  });
  const capabilityRoles = [
    { role: "owner", cookie: ownerCookie },
    {
      role: "billing",
      cookie: `${config.SESSION_COOKIE_NAME}=${billingCapabilityMember.sessionToken}`,
    },
    {
      role: "technical",
      cookie: `${config.SESSION_COOKIE_NAME}=${technicalCapabilityMember.sessionToken}`,
    },
    {
      role: "viewer",
      cookie: `${config.SESSION_COOKIE_NAME}=${viewerCapabilityMember.sessionToken}`,
    },
  ] as const;
  for (const actor of capabilityRoles) {
    const notificationHistory = await app.inject({
      method: "GET",
      url: "/api/v1/customer/notification-deliveries?limit=1",
      headers: { cookie: actor.cookie },
    });
    assert.equal(
      notificationHistory.statusCode,
      200,
      `${actor.role} notification history: ${notificationHistory.body}`,
    );
    const notificationPage = json<{
      items: Array<{ recipient: string }>;
      nextCursor: string | null;
    }>(notificationHistory);
    assert.equal(notificationPage.items.length, 1);
    assert.match(notificationPage.items[0]!.recipient, /^.\*\*\*@[^@]+$/);
    assert.ok(notificationPage.nextCursor);
    assertCursorPreservesPostgresMicroseconds(
      notificationPage.nextCursor!,
      `${actor.role} customer notification deliveries`,
    );
  }
  const representativeMutations = [
    ["POST", "/api/v1/orders"],
    ["POST", "/api/v1/billing/add-funds/quotes"],
    ["POST", `/api/v1/services/${randomUUID()}/cancellation`],
    ["POST", "/api/v1/tickets"],
  ] as const;
  for (const actor of capabilityRoles) {
    for (const [method, url] of representativeMutations) {
      const response = await app.inject({
        method,
        url,
        headers: { cookie: actor.cookie },
        payload: {},
      });
      assert.equal(
        response.statusCode,
        428,
        `${actor.role} ${method} ${url}: ${response.body}`,
      );
      assert.equal(
        json<{ code: string }>(response).code,
        "ACCOUNT_CONTEXT_VERSION_REQUIRED",
      );
    }
  }

  const capabilityPreflightMatrix = [
    {
      path: "/api/v1/orders",
      allowed: new Set(["owner", "billing"]),
    },
    {
      path: "/api/v1/billing/add-funds/quotes",
      allowed: new Set(["owner", "billing"]),
    },
    {
      path: `/api/v1/services/${randomUUID()}/cancellation`,
      allowed: new Set(["owner", "technical"]),
    },
    {
      path: "/api/v1/tickets",
      allowed: new Set(["owner", "billing", "technical"]),
    },
  ] as const;
  for (const actor of capabilityRoles) {
    for (const entry of capabilityPreflightMatrix) {
      const response = await app.inject({
        method: "POST",
        url: entry.path,
        headers: {
          cookie: actor.cookie,
          "x-oss-account-context-version": "1",
        },
        payload: {},
      });
      assert.equal(
        response.statusCode,
        entry.allowed.has(actor.role) ? 400 : 403,
        `${actor.role} capability preflight ${entry.path}: ${response.body}`,
      );
    }
  }
  for (const entry of capabilityPreflightMatrix) {
    const response = await app.inject({
      method: "POST",
      url: entry.path,
      headers: {
        cookie:
          `${config.SESSION_COOKIE_NAME}=${explicitViewerCapabilityMember.sessionToken}`,
        "x-oss-account-context-version": "1",
      },
      payload: {},
    });
    assert.equal(response.statusCode, 400, `explicit Viewer ${entry.path}: ${response.body}`);
  }

  const capabilityGroupId = `capability-group-${databaseName}`;
  const capabilityProductId = `capability-product-${databaseName}`;
  const capabilityPriceId = randomUUID();
  const capabilityTermsVersion = `capability-terms-${databaseName}`;
  const capabilityAupVersion = `capability-aup-${databaseName}`;
  await pool.query(
    `INSERT INTO product_groups(id, sort_order, names)
     VALUES ($1, 9001, '{"en":"Capability Matrix"}'::jsonb)`,
    [capabilityGroupId],
  );
  await pool.query(
    `INSERT INTO products(
       id, group_id, names, descriptions, fulfillment_mode,
       active, hidden, repeatable, option_schema
     ) VALUES (
       $1, $2, '{"en":"Capability Service"}'::jsonb,
       '{"en":"Synthetic role and explicit permission matrix"}'::jsonb,
       'manual', true, false, true, '[]'::jsonb
     )`,
    [capabilityProductId, capabilityGroupId],
  );
  await pool.query(
    `INSERT INTO product_prices(
       id, product_id, revision, currency, billing_cycle,
       one_time_minor, setup_minor, recurring_minor
     ) VALUES ($1, $2, 1, 'USD', 'monthly', 0, 0, 100)`,
    [capabilityPriceId, capabilityProductId],
  );
  await pool.query(
    `INSERT INTO product_service_automation_policies(
       product_id, overdue_action, overdue_delay_mode, overdue_delay_value,
       cycle_end_cancellation_mode,
       cycle_end_cancellation_execution_mode,
       cycle_end_cancellation_min_notice_hours
     ) VALUES (
       $1, 'none', 'policy_calendar_days', 5,
       'self_service', 'manual', 0
     )`,
    [capabilityProductId],
  );
  await pool.query(
    `INSERT INTO legal_documents(kind, locale, version, title, body)
     VALUES
       ('terms', 'en', $1, 'Capability Terms', 'Synthetic capability terms'),
       ('aup', 'en', $2, 'Capability AUP', 'Synthetic capability AUP')`,
    [capabilityTermsVersion, capabilityAupVersion],
  );
  await pool.query(
    `INSERT INTO payment_methods(
       code, display_name, provider_installation_id,
       fee_basis_points, enabled, add_funds_enabled
     ) VALUES (
       'capability_card', '{"en":"Capability Card"}'::jsonb,
       'mock-payment', 0, true, true
     )`,
  );
  await pool.query(
    `INSERT INTO add_funds_policies(
       currency, enabled, min_principal_minor,
       max_principal_minor, balance_cap_minor
     ) VALUES ('USD', true, 100, 100000, 1000000)`,
  );

  const explicitViewerCookie =
    `${config.SESSION_COOKIE_NAME}=${explicitViewerCapabilityMember.sessionToken}`;
  const capabilityCookies = {
    owner: ownerCookie,
    billing: `${config.SESSION_COOKIE_NAME}=${billingCapabilityMember.sessionToken}`,
    technical: `${config.SESSION_COOKIE_NAME}=${technicalCapabilityMember.sessionToken}`,
    viewer: `${config.SESSION_COOKIE_NAME}=${viewerCapabilityMember.sessionToken}`,
    explicitViewer: explicitViewerCookie,
  } as const;
  const createCapabilityOrder = async (
    label: string,
    cookie: string,
    expectedStatus: number,
  ): Promise<string | null> => {
    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/orders",
      headers: {
        cookie,
        "x-oss-account-context-version": "1",
      },
      payload: {
        priceId: capabilityPriceId,
        configuration: {},
        termsVersion: capabilityTermsVersion,
        aupVersion: capabilityAupVersion,
        idempotencyKey: `capability-order-${label}-${randomUUID()}`,
      },
    });
    assert.equal(response.statusCode, expectedStatus, `${label} order: ${response.body}`);
    return expectedStatus === 201
      ? json<{ orderId: string }>(response).orderId
      : null;
  };
  const ownerCapabilityOrderId = await createCapabilityOrder(
    "owner",
    capabilityCookies.owner,
    201,
  );
  const billingCapabilityOrderId = await createCapabilityOrder(
    "billing",
    capabilityCookies.billing,
    201,
  );
  await createCapabilityOrder("technical", capabilityCookies.technical, 403);
  await createCapabilityOrder("viewer", capabilityCookies.viewer, 403);
  const explicitViewerCapabilityOrderId = await createCapabilityOrder(
    "explicit-viewer",
    capabilityCookies.explicitViewer,
    201,
  );
  assert.ok(ownerCapabilityOrderId);
  assert.ok(billingCapabilityOrderId);
  assert.ok(explicitViewerCapabilityOrderId);

  const createCapabilityService = async (
    orderId: string,
    label: string,
  ): Promise<string> => {
    const item = await pool!.query<{ id: string }>(
      `SELECT id FROM order_items WHERE order_id = $1 ORDER BY id LIMIT 1`,
      [orderId],
    );
    const itemId = item.rows[0]?.id;
    assert.ok(itemId, `capability ${label} order item is required`);
    const created = await pool!.query<{ id: string }>(
      `INSERT INTO services(
         client_account_id, order_item_id, status, billing_cycle,
         external_resource_id, activated_at, term_start, term_end
       ) VALUES (
         $1, $2, 'active', 'monthly', $3,
         pg_catalog.now() - interval '1 day',
         pg_catalog.now() - interval '1 day',
         pg_catalog.now() + interval '30 days'
       )
       RETURNING id`,
      [ownerAccountId, itemId, `capability-service-${label}-${randomUUID()}`],
    );
    const createdServiceId = created.rows[0]?.id;
    assert.ok(createdServiceId);
    await pool!.query(
      `INSERT INTO service_provider_bindings(
         service_id, provider_installation_id, overdue_action_snapshot,
         capability_snapshot, product_policy_version,
         cycle_end_cancellation_mode_snapshot,
         cycle_end_cancellation_execution_mode_snapshot,
         cycle_end_cancellation_min_notice_hours_snapshot
       ) VALUES (
         $1, NULL, 'none', '[]'::jsonb, 1,
         'self_service', 'manual', 0
       )`,
      [createdServiceId],
    );
    return createdServiceId;
  };
  const ownerCapabilityServiceId = await createCapabilityService(
    ownerCapabilityOrderId,
    "owner",
  );
  const technicalCapabilityServiceId = await createCapabilityService(
    billingCapabilityOrderId,
    "technical",
  );
  const explicitViewerCapabilityServiceId = await createCapabilityService(
    explicitViewerCapabilityOrderId,
    "explicit-viewer",
  );

  const scheduleCapabilityCancellation = async (
    label: string,
    cookie: string,
    serviceId: string,
    expectedStatus: number,
  ): Promise<void> => {
    const response = await app!.inject({
      method: "POST",
      url: `/api/v1/services/${serviceId}/cancellation`,
      headers: {
        cookie,
        "x-oss-account-context-version": "1",
      },
      payload: {
        expectedVersion: 1,
        reason: `Synthetic capability cancellation by ${label}`,
        idempotencyKey: `capability-cancel-${label}-${randomUUID()}`,
      },
    });
    assert.equal(
      response.statusCode,
      expectedStatus,
      `${label} service cancellation: ${response.body}`,
    );
  };
  await scheduleCapabilityCancellation(
    "billing",
    capabilityCookies.billing,
    technicalCapabilityServiceId,
    403,
  );
  await scheduleCapabilityCancellation(
    "viewer",
    capabilityCookies.viewer,
    technicalCapabilityServiceId,
    403,
  );
  await scheduleCapabilityCancellation(
    "technical",
    capabilityCookies.technical,
    technicalCapabilityServiceId,
    201,
  );
  await scheduleCapabilityCancellation(
    "owner",
    capabilityCookies.owner,
    ownerCapabilityServiceId,
    201,
  );
  await scheduleCapabilityCancellation(
    "explicit-viewer",
    capabilityCookies.explicitViewer,
    explicitViewerCapabilityServiceId,
    201,
  );

  for (const [label, cookie, expectedStatus] of [
    ["owner", capabilityCookies.owner, 201],
    ["billing", capabilityCookies.billing, 201],
    ["technical", capabilityCookies.technical, 201],
    ["viewer", capabilityCookies.viewer, 403],
    ["explicit-viewer", capabilityCookies.explicitViewer, 201],
  ] as const) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tickets",
      headers: {
        cookie,
        "x-oss-account-context-version": "1",
      },
      payload: {
        subject: `Capability support ${label}`,
        message: `Synthetic support write capability for ${label}`,
      },
    });
    assert.equal(response.statusCode, expectedStatus, `${label} ticket: ${response.body}`);
  }

  for (const [label, cookie, expectedStatus] of [
    ["owner", capabilityCookies.owner, 201],
    ["billing", capabilityCookies.billing, 201],
    ["technical", capabilityCookies.technical, 403],
    ["viewer", capabilityCookies.viewer, 403],
    ["explicit-viewer", capabilityCookies.explicitViewer, 201],
  ] as const) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/billing/add-funds/quotes",
      headers: {
        cookie,
        "x-oss-account-context-version": "1",
      },
      payload: { principalMinor: "100", paymentMethod: "capability_card" },
    });
    assert.equal(response.statusCode, expectedStatus, `${label} Add Funds: ${response.body}`);
  }
  const deniedCapabilityFacts = await pool.query<{
    technical_orders: string;
    viewer_orders: string;
    technical_add_funds_quotes: string;
    viewer_add_funds_quotes: string;
    viewer_tickets: string;
  }>(
    `SELECT
       (SELECT pg_catalog.count(*)::text FROM orders
        WHERE submitted_by_user_id = $1) AS technical_orders,
       (SELECT pg_catalog.count(*)::text FROM orders
        WHERE submitted_by_user_id = $2) AS viewer_orders,
       (SELECT pg_catalog.count(*)::text FROM add_funds_quotes
        WHERE requested_by_user_id = $1) AS technical_add_funds_quotes,
       (SELECT pg_catalog.count(*)::text FROM add_funds_quotes
        WHERE requested_by_user_id = $2) AS viewer_add_funds_quotes,
       (SELECT pg_catalog.count(*)::text FROM support_tickets
        WHERE created_by_user_id = $2) AS viewer_tickets`,
    [technicalCapabilityMember.userId, viewerCapabilityMember.userId],
  );
  assert.deepEqual(deniedCapabilityFacts.rows[0], {
    technical_orders: "0",
    viewer_orders: "0",
    technical_add_funds_quotes: "0",
    viewer_add_funds_quotes: "0",
    viewer_tickets: "0",
  });

  const mutationMatrix = [
    ["POST", "/api/v1/orders"],
    ["POST", `/api/v1/invoices/${randomUUID()}/payments`],
    ["POST", `/api/v1/invoices/${randomUUID()}/payment-quotes`],
    ["POST", "/api/v1/billing/add-funds/quotes"],
    ["POST", "/api/v1/billing/add-funds"],
    ["POST", `/api/v1/billing/payment-methods/${randomUUID()}/default`],
    ["POST", `/api/v1/billing/payment-methods/${randomUUID()}/remove`],
    ["POST", `/api/v1/services/${randomUUID()}/automatic-renewal`],
    ["POST", `/api/v1/services/${randomUUID()}/automatic-renewal/pending-consent/withdraw`],
    ["POST", `/api/v1/services/${randomUUID()}/automatic-renewal/revoke`],
    ["POST", `/api/v1/services/${randomUUID()}/cancellation`],
    ["POST", "/api/v1/tickets"],
    ["POST", `/api/v1/tickets/${randomUUID()}/replies`],
    ["POST", "/api/v1/account/membership-invitations"],
    ["DELETE", `/api/v1/account/membership-invitations/${randomUUID()}`],
    ["PATCH", `/api/v1/account/members/${target.userId}`],
    ["DELETE", `/api/v1/account/members/${target.userId}`],
    ["POST", "/api/v1/account/contacts"],
    ["PATCH", `/api/v1/account/contacts/${randomUUID()}`],
    ["DELETE", `/api/v1/account/contacts/${randomUUID()}`],
  ] as const;
  for (const [method, url] of mutationMatrix) {
    const response = await app.inject({
      method,
      url,
      headers: { cookie: ownerCookie },
      payload: {},
    });
    assert.equal(response.statusCode, 428, `${method} ${url}: ${response.body}`);
    assert.equal(
      json<{ code: string }>(response).code,
      "ACCOUNT_CONTEXT_VERSION_REQUIRED",
    );
  }

  const staleTicket = await app.inject({
    method: "POST",
    url: "/api/v1/tickets",
    headers: {
      cookie: ownerCookie,
      "x-oss-account-context-version": "0",
    },
    payload: { subject: "Stale context ticket", message: "Must not be created" },
  });
  assert.equal(staleTicket.statusCode, 409, staleTicket.body);
  const ticket = await app.inject({
    method: "POST",
    url: "/api/v1/tickets",
    headers: {
      cookie: ownerCookie,
      "x-oss-account-context-version": "1",
    },
    payload: { subject: "Current context ticket", message: "Created once" },
  });
  assert.equal(ticket.statusCode, 201, ticket.body);
  assert.equal(ticket.headers["x-oss-client-account-id"], ownerAccountId);
  const staffTicketId = json<{ ticket: { id: string } }>(ticket).ticket.id;

  const zeroMembershipStaff = await createBaseIdentity({
    label: "staff-zero-membership",
    accountCount: 0,
    passwordHash: loginPasswordHash,
  });
  const multiMembershipStaff = await createBaseIdentity({
    label: "staff-multi-membership",
    accountCount: 2,
    passwordHash: loginPasswordHash,
  });
  const restrictedClientStaff = await createBaseIdentity({
    label: "staff-restricted-client",
    accountCount: 1,
    passwordHash: loginPasswordHash,
  });
  const restrictedUserStaff = await createBaseIdentity({
    label: "staff-restricted-user",
    accountCount: 0,
    passwordHash: loginPasswordHash,
  });
  const inactiveStaff = await createBaseIdentity({
    label: "staff-inactive",
    accountCount: 0,
    passwordHash: loginPasswordHash,
  });
  const missingPermissionStaff = await createBaseIdentity({
    label: "staff-missing-permission",
    accountCount: 0,
    passwordHash: loginPasswordHash,
  });
  const allowedStaff = [
    zeroMembershipStaff,
    multiMembershipStaff,
    restrictedClientStaff,
  ] as const;
  await pool.query(
    `INSERT INTO staff_members(user_id, roles, permissions)
     SELECT principal.user_id, ARRAY['Support'], '["support.tickets.manage"]'::jsonb
     FROM pg_catalog.unnest($1::uuid[]) AS principal(user_id)`,
    [allowedStaff.map((identity) => identity.userId)],
  );
  await pool.query(
    `INSERT INTO staff_members(user_id, roles, permissions, active)
     VALUES
       ($1, ARRAY['Support'], '["support.tickets.manage"]'::jsonb, true),
       ($2, ARRAY['Support'], '["support.tickets.manage"]'::jsonb, false),
       ($3, ARRAY['Accounts'], '["accounts.view"]'::jsonb, true)`,
    [
      restrictedUserStaff.userId,
      inactiveStaff.userId,
      missingPermissionStaff.userId,
    ],
  );
  const restrictedClientAccountId = restrictedClientStaff.accountIds[0];
  assert.ok(restrictedClientAccountId);
  await pool.query(
    `UPDATE sessions
     SET active_client_account_id = $2, account_context_version = 1
     WHERE id = $1`,
    [restrictedClientStaff.sessionId, restrictedClientAccountId],
  );
  await pool.query(
    `UPDATE client_accounts
     SET restricted_at = pg_catalog.now()
     WHERE id = $1`,
    [restrictedClientAccountId],
  );
  await pool.query(
    `UPDATE users SET restricted_at = pg_catalog.now() WHERE id = $1`,
    [restrictedUserStaff.userId],
  );

  const allowedStaffCookies = new Map<string, string>();
  for (const identity of allowedStaff) {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: identity.email, password: loginPassword },
    });
    const isRestrictedClientStaff = identity === restrictedClientStaff;
    const expectedLoginStatus = isRestrictedClientStaff ? 200 : 409;
    assert.equal(login.statusCode, expectedLoginStatus, login.body);
    if (isRestrictedClientStaff) {
      assert.equal(
        json<{ context: { clientAccountId: string } }>(login).context.clientAccountId,
        restrictedClientAccountId,
      );
      assert.equal(login.headers["x-oss-client-account-id"], restrictedClientAccountId);
      assert.equal(login.headers["x-oss-account-context-version"], "1");
    } else {
      const contextRequired = json<{ code: string; context: unknown }>(login);
      assert.equal(contextRequired.code, "ACCOUNT_CONTEXT_REQUIRED");
      assert.equal(contextRequired.context, null);
      assert.equal(login.headers["x-oss-client-account-id"], undefined);
      assert.equal(login.headers["x-oss-account-context-version"], "0");
    }
    const setCookie = login.headers["set-cookie"];
    assert.ok(setCookie);
    const staffCookie = String(setCookie).split(";", 1)[0];
    assert.ok(staffCookie);
    allowedStaffCookies.set(identity.userId, staffCookie);
    const staffMe = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: staffCookie },
    });
    assert.equal(staffMe.statusCode, 200, staffMe.body);
    const staffMeBody = json<{
      clientAccountId: string | null;
      context: { clientAccountId: string } | null;
      accountContextVersion: string;
      staff: unknown;
    }>(staffMe);
    assert.ok(staffMeBody.staff);
    assert.equal(
      staffMeBody.clientAccountId,
      isRestrictedClientStaff ? restrictedClientAccountId : null,
    );
    assert.equal(
      staffMeBody.context?.clientAccountId ?? null,
      isRestrictedClientStaff ? restrictedClientAccountId : null,
    );
    assert.equal(staffMeBody.accountContextVersion, isRestrictedClientStaff ? "1" : "0");
    const reauth = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reauth",
      headers: { cookie: staffCookie },
      payload: { password: loginPassword },
    });
    assert.equal(reauth.statusCode, 200, reauth.body);
    const adminRead = await app.inject({
      method: "GET",
      url: "/api/v1/admin/tickets",
      headers: { cookie: staffCookie },
    });
    assert.equal(adminRead.statusCode, 200, adminRead.body);
    const adminWrite = await app.inject({
      method: "POST",
      url: `/api/v1/admin/tickets/${staffTicketId}/messages`,
      headers: { cookie: staffCookie },
      payload: {
        kind: "internal_note",
        message: `Identity-scoped Staff proof ${identity.userId}`,
      },
    });
    assert.equal(adminWrite.statusCode, 201, adminWrite.body);
  }

  const restrictedClientMe = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: {
      cookie: allowedStaffCookies.get(restrictedClientStaff.userId) ?? "",
    },
  });
  assert.deepEqual(
    json<{ restrictions: unknown }>(restrictedClientMe).restrictions,
    { user: false, clientAccount: true },
  );

  const restrictedUserCookie =
    `${config.SESSION_COOKIE_NAME}=${restrictedUserStaff.sessionToken}`;
  const restrictedUserReauth = await app.inject({
    method: "POST",
    url: "/api/v1/auth/reauth",
    headers: { cookie: restrictedUserCookie },
    payload: { password: loginPassword },
  });
  assert.equal(restrictedUserReauth.statusCode, 403, restrictedUserReauth.body);
  const restrictedUserAdmin = await app.inject({
    method: "GET",
    url: "/api/v1/admin/tickets",
    headers: { cookie: restrictedUserCookie },
  });
  assert.equal(restrictedUserAdmin.statusCode, 403, restrictedUserAdmin.body);
  const restrictedUserMe = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: restrictedUserCookie },
  });
  assert.equal(restrictedUserMe.statusCode, 200, restrictedUserMe.body);
  assert.equal(
    json<{ clientAccountId: string | null }>(restrictedUserMe).clientAccountId,
    null,
  );
  assert.equal(json<{ context: unknown }>(restrictedUserMe).context, null);
  assert.equal(json<{ staff: unknown }>(restrictedUserMe).staff, null);
  assert.equal(restrictedUserMe.headers["x-oss-client-account-id"], undefined);
  const restrictedUserContexts = await app.inject({
    method: "GET",
    url: "/api/v1/auth/account-contexts",
    headers: { cookie: restrictedUserCookie },
  });
  assert.equal(restrictedUserContexts.statusCode, 403, restrictedUserContexts.body);

  const restrictedHistoryMember = await createContextMember({
    clientAccountId: ownerAccountId,
    role: "viewer",
    label: "restricted-notification-history",
  });
  await pool.query(
    "UPDATE users SET restricted_at = pg_catalog.now() WHERE id = $1",
    [restrictedHistoryMember.userId],
  );
  const restrictedNotificationHistory = await app.inject({
    method: "GET",
    url: "/api/v1/customer/notification-deliveries",
    headers: {
      cookie:
        `${config.SESSION_COOKIE_NAME}=${restrictedHistoryMember.sessionToken}`,
    },
  });
  assert.equal(
    restrictedNotificationHistory.statusCode,
    403,
    restrictedNotificationHistory.body,
  );
  assert.equal(
    json<{ code: string }>(restrictedNotificationHistory).code,
    "ACCOUNT_RESTRICTED",
  );
  assert.equal(
    restrictedNotificationHistory.headers["x-oss-client-account-id"],
    undefined,
  );
  assert.equal(
    restrictedNotificationHistory.headers["x-oss-account-context-version"],
    "2",
  );

  const unverifiedMember = await createContextMember({
    clientAccountId: ownerAccountId,
    role: "viewer",
    label: "unverified-pii-gate",
  });
  await pool.query(
    "UPDATE users SET email_verified_at = NULL, password_hash = $2 WHERE id = $1",
    [unverifiedMember.userId, loginPasswordHash],
  );
  const unverifiedLogin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: unverifiedMember.email, password: loginPassword },
  });
  assert.equal(unverifiedLogin.statusCode, 200, unverifiedLogin.body);
  assert.equal(json<{ context: unknown }>(unverifiedLogin).context, null);
  assert.equal(unverifiedLogin.headers["x-oss-client-account-id"], undefined);
  assert.equal(unverifiedLogin.headers["x-oss-account-context-version"], "1");
  const unverifiedCookie = `${config.SESSION_COOKIE_NAME}=${unverifiedMember.sessionToken}`;
  const unverifiedMe = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: unverifiedCookie },
  });
  assert.equal(unverifiedMe.statusCode, 200, unverifiedMe.body);
  assert.equal(json<{ context: unknown }>(unverifiedMe).context, null);
  assert.equal(unverifiedMe.headers["x-oss-client-account-id"], undefined);
  const unverifiedNotificationHistory = await app.inject({
    method: "GET",
    url: "/api/v1/customer/notification-deliveries",
    headers: { cookie: unverifiedCookie },
  });
  assert.equal(
    unverifiedNotificationHistory.statusCode,
    403,
    unverifiedNotificationHistory.body,
  );
  assert.equal(
    json<{ code: string }>(unverifiedNotificationHistory).code,
    "EMAIL_VERIFICATION_REQUIRED",
  );
  assert.equal(
    unverifiedNotificationHistory.headers["x-oss-client-account-id"],
    undefined,
  );
  assert.equal(
    unverifiedNotificationHistory.headers["x-oss-account-context-version"],
    "2",
  );
  for (const url of [
    "/api/v1/auth/account-contexts",
    "/api/v1/account/members",
    "/api/v1/account/membership-invitations",
    "/api/v1/account/contacts",
  ]) {
    const denied = await app.inject({
      method: "GET",
      url,
      headers: { cookie: unverifiedCookie },
    });
    assert.equal(denied.statusCode, 403, `${url}: ${denied.body}`);
  }

  const originalFetch = globalThis.fetch;
  let mailboxFetches = 0;
  config.LAB_MAILBOX_ENABLED = true;
  globalThis.fetch = async () => {
    mailboxFetches += 1;
    return new Response(
      JSON.stringify([
        {
          id: randomUUID(),
          template: "membership-invitation-v1",
          locale: "en",
          subject: "Account invitation",
          body: "https://example.invalid/invitations/secret",
          status: "delivered",
          deliveredAt: "2026-01-01T00:00:01.000Z",
        },
        {
          id: randomUUID(),
          template: "email-verification",
          locale: "en",
          subject: "Verify identity",
          body: "https://example.invalid/verify/identity-only",
          status: "delivered",
          deliveredAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const restrictedMailbox = await app.inject({
      method: "GET",
      url: "/api/v1/lab/mailbox",
      headers: { cookie: restrictedUserCookie },
    });
    assert.equal(restrictedMailbox.statusCode, 403, restrictedMailbox.body);
    assert.equal(restrictedMailbox.headers["x-oss-client-account-id"], undefined);
    assert.equal(mailboxFetches, 0);

    const unverifiedMailbox = await app.inject({
      method: "GET",
      url: "/api/v1/lab/mailbox",
      headers: { cookie: unverifiedCookie },
    });
    assert.equal(unverifiedMailbox.statusCode, 200, unverifiedMailbox.body);
    assert.equal(unverifiedMailbox.headers["x-oss-client-account-id"], undefined);
    const unverifiedMessages = json<{
      messages: Array<{ template: string; body: string }>;
    }>(unverifiedMailbox).messages;
    assert.deepEqual(
      unverifiedMessages.map((message) => message.template),
      ["email-verification"],
    );
    assert.match(unverifiedMessages[0]?.body ?? "", /identity-only/);
    assert.doesNotMatch(unverifiedMailbox.body, /invitations\/secret/);
    assert.equal(mailboxFetches, 1);
  } finally {
    globalThis.fetch = originalFetch;
    config.LAB_MAILBOX_ENABLED = false;
  }

  const restrictedClientCookie =
    allowedStaffCookies.get(restrictedClientStaff.userId) ?? "";
  const restrictedClientNotificationHistory = await app.inject({
    method: "GET",
    url: "/api/v1/customer/notification-deliveries",
    headers: { cookie: restrictedClientCookie },
  });
  assert.equal(
    restrictedClientNotificationHistory.statusCode,
    200,
    restrictedClientNotificationHistory.body,
  );
  assert.equal(
    restrictedClientNotificationHistory.headers["x-oss-client-account-id"],
    restrictedClientAccountId,
  );
  const restrictedClientNotificationPage = json<{
    account: { id: string };
    items: unknown[];
    hasMore: boolean;
    nextCursor: string | null;
  }>(restrictedClientNotificationHistory);
  assert.equal(
    restrictedClientNotificationPage.account.id,
    restrictedClientAccountId,
  );
  assert.deepEqual(restrictedClientNotificationPage.items, []);
  assert.equal(restrictedClientNotificationPage.hasMore, false);
  assert.equal(restrictedClientNotificationPage.nextCursor, null);
  for (const url of [
    "/api/v1/auth/account-contexts",
    "/api/v1/account/members",
    "/api/v1/account/membership-invitations",
    "/api/v1/account/contacts",
  ]) {
    const allowed = await app.inject({
      method: "GET",
      url,
      headers: { cookie: restrictedClientCookie },
    });
    assert.equal(allowed.statusCode, 200, `${url}: ${allowed.body}`);
  }

  for (const identity of [inactiveStaff, missingPermissionStaff] as const) {
    const staffCookie = `${config.SESSION_COOKIE_NAME}=${identity.sessionToken}`;
    const reauth = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reauth",
      headers: { cookie: staffCookie },
      payload: { password: loginPassword },
    });
    assert.equal(reauth.statusCode, 200, reauth.body);
    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/admin/tickets",
      headers: { cookie: staffCookie },
    });
    assert.equal(denied.statusCode, 403, denied.body);
    const notificationDenied: Awaited<
      ReturnType<NonNullable<typeof app>["inject"]>
    > = await app.inject({
      method: "GET",
      url:
        `/api/v1/admin/client-accounts/${ownerAccountId}` +
        "/notification-deliveries",
      headers: { cookie: staffCookie },
    });
    assert.equal(notificationDenied.statusCode, 403, notificationDenied.body);
  }

  const contactEmail = `non-identity-contact-${databaseName}@example.invalid`;
  const contactCreate = await app.inject({
    method: "POST",
    url: "/api/v1/account/contacts",
    headers: {
      cookie: ownerCookie,
      "x-oss-account-context-version": "1",
    },
    payload: {
      displayName: "Non-identity Contact",
      email: contactEmail,
      locale: "zh-CN",
      notificationSubscriptions: ["billing", "support"],
    },
  });
  assert.equal(contactCreate.statusCode, 201, contactCreate.body);
  const contactId = json<{ contact: { id: string } }>(contactCreate).contact.id;
  const contactIdentity = await pool.query<{ user_count: string; membership_count: string }>(
    `SELECT
       (SELECT pg_catalog.count(*) FROM users WHERE email = $1)::text AS user_count,
       (SELECT pg_catalog.count(*)
        FROM client_memberships membership
        JOIN users principal ON principal.id = membership.user_id
        WHERE principal.email = $1)::text AS membership_count`,
    [contactEmail],
  );
  assert.deepEqual(contactIdentity.rows[0], {
    user_count: "0",
    membership_count: "0",
  });
  const crossBusinessContactId = randomUUID();
  const crossBusinessContactEmail =
    `cross-business-${crossBusinessContactId}@example.invalid`;
  const crossBusinessOutboxId = randomUUID();
  const crossBusinessPayload = {
    email: crossBusinessContactEmail,
    locale: "en",
    contactId: crossBusinessContactId,
    accountId: secondAccountId,
    notificationCategory: "billing",
    notificationRecipientKind: "contact",
    notificationRecipientSubjectId: crossBusinessContactId,
    notificationRecipientScopeId: secondAccountId,
    ...renewalRuntimeBusinessPayload,
  };
  await pool.query(
    `INSERT INTO client_contacts(
       id, client_account_id, display_name, email, locale,
       notification_subscriptions
     ) VALUES (
       $1, $2, 'Cross-business Contact', $3, 'en', '["billing"]'::jsonb
     )`,
    [crossBusinessContactId, secondAccountId, crossBusinessContactEmail],
  );
  await pool.query(
    `INSERT INTO outbox(id, event_type, unique_key, payload)
     VALUES ($1, 'notification.renewal_reminder_requested', $2, $3)`,
    [
      crossBusinessOutboxId,
      `renewal:${manualHistoryInvoiceId}:pre_due:contact:${crossBusinessContactId}`,
      crossBusinessPayload,
    ],
  );
  await expectPgCode(
    () =>
      pool!.query(
        `INSERT INTO notification_delivery_operations(
           outbox_id, attempt_number, provider_operation_id,
           provider_installation_id, event_type, template_revision,
           payload_snapshot, contact_id, client_account_id,
           recipient_subject_id, recipient_scope_id, recipient_kind,
           category, recipient, locale, request_fingerprint
         ) VALUES (
           $1, 1, opensales_notification_provider_operation_id($1, 1),
           'mock-mail-v1', 'notification.renewal_reminder_requested',
           'renewal-pre-due-v1', $2, $3, $4,
           $3, $4, 'contact', 'billing', $5, 'en',
           opensales_notification_request_fingerprint(
             'notification.renewal_reminder_requested',
             'renewal-pre-due-v1', $2
           )
         )`,
        [
          crossBusinessOutboxId,
          crossBusinessPayload,
          crossBusinessContactId,
          secondAccountId,
          crossBusinessContactEmail,
        ],
      ),
    "P0001",
  );
  const crossAccountNotificationOutboxId = randomUUID();
  const crossAccountNotificationPayload = {
    email: contactEmail,
    locale: "zh-CN",
    contactId,
    accountId: secondAccountId,
    notificationCategory: "billing",
    notificationRecipientKind: "contact",
    notificationRecipientSubjectId: contactId,
    notificationRecipientScopeId: secondAccountId,
    ...renewalRuntimeBusinessPayload,
  };
  await pool.query(
    `INSERT INTO outbox(id, event_type, unique_key, payload)
     VALUES ($1, 'notification.renewal_reminder_requested', $2, $3)`,
    [
      crossAccountNotificationOutboxId,
      `renewal:${manualHistoryInvoiceId}:pre_due:contact:${contactId}`,
      crossAccountNotificationPayload,
    ],
  );
  await expectPgCode(
    () =>
      pool!.query(
        `INSERT INTO notification_delivery_operations(
           outbox_id, attempt_number, provider_operation_id,
           provider_installation_id, event_type, template_revision,
           payload_snapshot, contact_id, client_account_id,
           recipient_subject_id, recipient_scope_id, recipient_kind,
           category, recipient, locale, request_fingerprint
         ) VALUES (
           $1, 1, opensales_notification_provider_operation_id($1, 1),
           'mock-mail-v1', 'notification.renewal_reminder_requested',
           'renewal-pre-due-v1', $2, $3, $4,
           $3, $4, 'contact', 'billing', $5, 'zh-CN',
           opensales_notification_request_fingerprint(
             'notification.renewal_reminder_requested', 'renewal-pre-due-v1', $2
           )
         )`,
        [
          crossAccountNotificationOutboxId,
          crossAccountNotificationPayload,
          contactId,
          secondAccountId,
          contactEmail,
        ],
      ),
    "P0001",
  );

  await pool.query(
    `WITH inserted AS (
       INSERT INTO users(email, password_hash, email_verified_at)
       SELECT
         'page-member-' || item::text || '-' || $2 || '@example.invalid',
         'synthetic-not-a-password',
         pg_catalog.now()
       FROM pg_catalog.generate_series(1, 31) item
       RETURNING id
     )
     INSERT INTO client_memberships(
       client_account_id, user_id, role, permissions
     )
     SELECT $1, inserted.id, 'viewer', '[]'::jsonb FROM inserted`,
    [ownerAccountId, databaseName],
  );
  await pool.query(
    `WITH ranked AS (
       SELECT user_id,
              pg_catalog.row_number() OVER (ORDER BY user_id) AS sequence
       FROM client_memberships
       WHERE client_account_id = $1 AND role = 'viewer'
     )
     UPDATE client_memberships membership
     SET created_at =
       '2020-01-01T00:00:00.000000Z'::timestamptz +
       ranked.sequence * interval '1 microsecond'
     FROM ranked
     WHERE membership.client_account_id = $1
       AND membership.user_id = ranked.user_id`,
    [ownerAccountId],
  );
  await pool.query(
    `INSERT INTO client_contacts(
       client_account_id, display_name, email, locale,
       notification_subscriptions, created_at
     )
     SELECT
       $1,
       'Page Contact ' || item::text,
       'page-contact-' || item::text || '-' || $2 || '@example.invalid',
       'en',
       '[]'::jsonb,
       '2020-01-01T00:00:00.000000Z'::timestamptz +
         item * interval '1 microsecond'
     FROM pg_catalog.generate_series(1, 31) item`,
    [ownerAccountId, databaseName],
  );
  const invitationTokens: string[] = [];
  for (let index = 0; index < 31; index += 1) {
    const token = randomBytes(32).toString("base64url");
    invitationTokens.push(token);
    await pool.query(
      `INSERT INTO client_membership_invitations(
         client_account_id, email, role, permissions, token_digest,
         expires_at, invited_by_user_id, created_at
       ) VALUES (
         $1, $2, 'viewer', '[]'::jsonb, $3,
         '2035-01-01T00:00:00.000Z'::timestamptz, $4,
         '2020-01-01T00:00:00.000000Z'::timestamptz +
           $5::integer * interval '1 microsecond'
       )`,
      [
        ownerAccountId,
        `page-invite-${index}-${databaseName}@example.invalid`,
        digestToken(token),
        owner.userId,
        index + 1,
      ],
    );
  }

  await expectPgCode(
    () =>
      pool!.query(
        "UPDATE sessions SET expires_at = expires_at + interval '1 hour' WHERE id = $1",
        [owner.sessionId],
      ),
    "P0001",
  );
  await expectPgCode(
    () =>
      pool!.query("UPDATE sessions SET token_digest = $2 WHERE id = $1", [
        owner.sessionId,
        digestToken(randomBytes(32).toString("base64url")),
      ]),
    "P0001",
  );
  const immutableContactId = randomUUID();
  await pool.query(
    `INSERT INTO client_contacts(
       id, client_account_id, display_name, email, notification_subscriptions
     ) VALUES ($1, $2, 'Immutable Contact', $3, '[]'::jsonb)`,
    [
      immutableContactId,
      ownerAccountId,
      `immutable-contact-${databaseName}@example.invalid`,
    ],
  );
  await expectPgCode(
    () =>
      pool!.query("UPDATE client_contacts SET client_account_id = $2 WHERE id = $1", [
        immutableContactId,
        multi.accountIds[1],
      ]),
    "P0001",
  );
  await expectPgCode(
    () => pool!.query("DELETE FROM client_contacts WHERE id = $1", [immutableContactId]),
    "P0001",
  );
  await pool.query(
    `UPDATE client_contacts
     SET removed_at = pg_catalog.now(), updated_at = pg_catalog.now()
     WHERE id = $1`,
    [immutableContactId],
  );
  await expectPgCode(
    () =>
      pool!.query(
        "UPDATE client_contacts SET removed_at = NULL, updated_at = pg_catalog.now() WHERE id = $1",
        [immutableContactId],
      ),
    "P0001",
  );
  const immutableInvitationToken = randomBytes(32).toString("base64url");
  const immutableInvitationId = randomUUID();
  await pool.query(
    `INSERT INTO client_membership_invitations(
       id, client_account_id, email, role, permissions, token_digest,
       expires_at, invited_by_user_id
     ) VALUES ($1, $2, $3, 'viewer', '[]'::jsonb, $4,
       pg_catalog.now() + interval '1 day', $5)`,
    [
      immutableInvitationId,
      ownerAccountId,
      `immutable-invitation-${databaseName}@example.invalid`,
      digestToken(immutableInvitationToken),
      owner.userId,
    ],
  );
  for (const mutation of [
    ["UPDATE client_membership_invitations SET client_account_id = $2 WHERE id = $1", multi.accountIds[1]],
    ["UPDATE client_membership_invitations SET role = 'owner' WHERE id = $1", null],
    ["UPDATE client_membership_invitations SET token_digest = $2 WHERE id = $1", digestToken(randomBytes(32).toString("base64url"))],
    ["UPDATE client_membership_invitations SET email = pg_catalog.upper(email::text)::citext WHERE id = $1", null],
  ] as const) {
    await expectPgCode(
      () =>
        mutation[1] === null
          ? pool!.query(mutation[0], [immutableInvitationId])
          : pool!.query(mutation[0], [immutableInvitationId, mutation[1]]),
      "P0001",
    );
  }
  await expectPgCode(
    () =>
      pool!.query("DELETE FROM client_membership_invitations WHERE id = $1", [
        immutableInvitationId,
      ]),
    "P0001",
  );
  await pool.query(
    `UPDATE client_membership_invitations
     SET revoked_at = pg_catalog.now(), updated_at = pg_catalog.now()
     WHERE id = $1`,
    [immutableInvitationId],
  );
  await expectPgCode(
    () =>
      pool!.query(
        `UPDATE client_membership_invitations
         SET revoked_at = NULL, updated_at = pg_catalog.now()
         WHERE id = $1`,
        [immutableInvitationId],
      ),
    "P0001",
  );

  const members = await collectPages<{ userId: string }>({
    url: "/api/v1/account/members",
    cookie: ownerCookie,
  });
  const memberCount = await pool.query<{ count: string }>(
    `SELECT pg_catalog.count(*)::text AS count
     FROM client_memberships
     WHERE client_account_id = $1 AND removed_at IS NULL`,
    [ownerAccountId],
  );
  assert.equal(members.items.length, Number(memberCount.rows[0]?.count));
  const contacts = await collectPages<{ id: string }>({
    url: "/api/v1/account/contacts",
    cookie: ownerCookie,
  });
  const contactCount = await pool.query<{ count: string }>(
    `SELECT pg_catalog.count(*)::text AS count
     FROM client_contacts
     WHERE client_account_id = $1 AND removed_at IS NULL`,
    [ownerAccountId],
  );
  assert.equal(contacts.items.length, Number(contactCount.rows[0]?.count));
  const invitations = await collectPages<{ id: string }>({
    url: "/api/v1/account/membership-invitations",
    cookie: ownerCookie,
  });
  const invitationCount = await pool.query<{ count: string }>(
    `SELECT pg_catalog.count(*)::text AS count
     FROM client_membership_invitations
     WHERE client_account_id = $1`,
    [ownerAccountId],
  );
  assert.equal(invitations.items.length, Number(invitationCount.rows[0]?.count));
  assert.ok(contacts.firstCursor);
  const crossCollectionCursor = await app.inject({
    method: "GET",
    url:
      "/api/v1/account/members?limit=10&cursor=" +
      encodeURIComponent(contacts.firstCursor ?? ""),
    headers: { cookie: ownerCookie },
  });
  assert.equal(crossCollectionCursor.statusCode, 400, crossCollectionCursor.body);
  const crossAccountCursor = await app.inject({
    method: "GET",
    url:
      "/api/v1/account/contacts?limit=10&cursor=" +
      encodeURIComponent(contacts.firstCursor ?? ""),
    headers: { cookie: multiCookie },
  });
  assert.equal(crossAccountCursor.statusCode, 400, crossAccountCursor.body);

  const adminContacts = await collectPages<{ id: string }>({
    url: `/api/v1/admin/client-accounts/${ownerAccountId}/contacts`,
    cookie: ownerCookie,
  });
  assert.equal(adminContacts.items.length, contacts.items.length);
  assert.ok(adminContacts.firstCursor);
  const adminCursorWrongAccount = await app.inject({
    method: "GET",
    url:
      `/api/v1/admin/client-accounts/${secondAccountId}/contacts?limit=10&cursor=` +
      encodeURIComponent(adminContacts.firstCursor ?? ""),
    headers: { cookie: ownerCookie },
  });
  assert.equal(adminCursorWrongAccount.statusCode, 400, adminCursorWrongAccount.body);

  const invalidPermissionArray = await app.inject({
    method: "POST",
    url: "/api/v1/account/membership-invitations",
    headers: {
      cookie: ownerCookie,
      "x-oss-account-context-version": "1",
    },
    payload: {
      email: `invalid-permission-${databaseName}@example.invalid`,
      role: "viewer",
      permissions: [1],
    },
  });
  assert.equal(invalidPermissionArray.statusCode, 400, invalidPermissionArray.body);

  const invite = await app.inject({
    method: "POST",
    url: "/api/v1/account/membership-invitations",
    headers: {
      cookie: ownerCookie,
      "x-oss-account-context-version": "1",
    },
    payload: {
      email: inviteeEmail,
      locale: "zh-CN",
      role: "technical",
      permissions: ["account.contacts.read"],
    },
  });
  assert.equal(invite.statusCode, 201, invite.body);
  const createdInvitation = json<{
    invitation: { id: string; locale: "en" | "zh-CN" };
  }>(invite).invitation;
  assert.equal(createdInvitation.locale, "zh-CN");
  const inviteOutbox = await pool.query<{
    id: string;
    payload: { invitationUrl?: string; locale?: string };
    job_count: string;
    invitation_locale: "en" | "zh-CN";
  }>(
    `SELECT outbox.id, outbox.payload, invitation.locale AS invitation_locale,
            pg_catalog.count(job.id)::text AS job_count
     FROM outbox
     JOIN client_membership_invitations invitation
       ON outbox.unique_key = 'membership-invitation:' || invitation.id::text
     LEFT JOIN durable_jobs job
       ON job.job_type = 'notification.send'
      AND job.payload->>'outboxId' = outbox.id::text
     WHERE outbox.unique_key = $1
     GROUP BY outbox.id, invitation.locale`,
    [`membership-invitation:${createdInvitation.id}`],
  );
  const invitationUrl = inviteOutbox.rows[0]?.payload.invitationUrl;
  assert.equal(inviteOutbox.rows[0]?.payload.locale, "zh-CN");
  assert.equal(inviteOutbox.rows[0]?.invitation_locale, "zh-CN");
  assert.equal(inviteOutbox.rows[0]?.job_count, "1");
  assert.ok(invitationUrl);
  const acceptanceToken = new URL(invitationUrl ?? "").searchParams.get("token");
  assert.ok(acceptanceToken);
  await pool.query(
    "UPDATE outbox SET published_at = pg_catalog.now() WHERE id = $1",
    [inviteOutbox.rows[0]?.id],
  );
  const accepted = await app.inject({
    method: "POST",
    url: "/api/v1/membership-invitations/accept",
    headers: { cookie: inviteeCookie },
    payload: { token: acceptanceToken },
  });
  assert.equal(accepted.statusCode, 201, accepted.body);
  const acceptedContext = await pool.query<{
    active_client_account_id: string | null;
    account_context_version: string;
  }>(
    `SELECT active_client_account_id, account_context_version::text
     FROM sessions WHERE id = $1`,
    [inviteeSessionId],
  );
  assert.deepEqual(acceptedContext.rows[0], {
    active_client_account_id: null,
    account_context_version: "0",
  });

  const coldStartEmail = `cold-start-${databaseName}@example.invalid`;
  const coldStartInvitationToken = randomBytes(32).toString("base64url");
  const coldStartInvitationId = randomUUID();
  await pool.query(
    `INSERT INTO client_membership_invitations(
       id, client_account_id, email, locale, role, permissions, token_digest,
       expires_at, invited_by_user_id
     ) VALUES ($1, $2, $3, 'en', 'viewer', '[]'::jsonb, $4,
       pg_catalog.now() + interval '1 day', $5)`,
    [
      coldStartInvitationId,
      ownerAccountId,
      coldStartEmail,
      digestToken(coldStartInvitationToken),
      owner.userId,
    ],
  );
  const accountsBeforeColdStart = await pool.query<{ count: string }>(
    "SELECT pg_catalog.count(*)::text AS count FROM client_accounts",
  );
  const wrongColdStartEmail = await app.inject({
    method: "POST",
    url: "/api/v1/auth/invitation-registrations",
    payload: {
      token: coldStartInvitationToken,
      email: `wrong-${coldStartEmail}`,
      password: loginPassword,
      locale: "en",
    },
  });
  assert.equal(wrongColdStartEmail.statusCode, 403, wrongColdStartEmail.body);
  assert.equal(
    json<{ code: string }>(wrongColdStartEmail).code,
    "MEMBERSHIP_INVITATION_EMAIL_MISMATCH",
  );
  const coldStartRegistration = await app.inject({
    method: "POST",
    url: "/api/v1/auth/invitation-registrations",
    payload: {
      token: coldStartInvitationToken,
      email: coldStartEmail,
      password: loginPassword,
      locale: "en",
    },
  });
  assert.equal(coldStartRegistration.statusCode, 201, coldStartRegistration.body);
  const coldStartUserId = json<{
    userId: string;
    registrationMode: string;
  }>(coldStartRegistration).userId;
  assert.equal(
    json<{ registrationMode: string }>(coldStartRegistration).registrationMode,
    "membership_invitation",
  );
  const coldStartFacts = await pool.query<{
    account_count: string;
    membership_count: string;
    session_count: string;
    invitation_pending: boolean;
  }>(
    `SELECT
       (SELECT pg_catalog.count(*) FROM client_accounts)::text AS account_count,
       (SELECT pg_catalog.count(*) FROM client_memberships WHERE user_id = $1)::text
         AS membership_count,
       (SELECT pg_catalog.count(*) FROM sessions WHERE user_id = $1)::text
         AS session_count,
       (SELECT accepted_at IS NULL AND revoked_at IS NULL
        FROM client_membership_invitations WHERE id = $2) AS invitation_pending`,
    [coldStartUserId, coldStartInvitationId],
  );
  assert.deepEqual(coldStartFacts.rows[0], {
    account_count: accountsBeforeColdStart.rows[0]?.count,
    membership_count: "0",
    session_count: "0",
    invitation_pending: true,
  });
  const existingColdStartIdentity = await app.inject({
    method: "POST",
    url: "/api/v1/auth/invitation-registrations",
    payload: {
      token: coldStartInvitationToken,
      email: coldStartEmail,
      password: loginPassword,
      locale: "en",
    },
  });
  assert.equal(existingColdStartIdentity.statusCode, 409, existingColdStartIdentity.body);
  assert.equal(
    json<{ code: string }>(existingColdStartIdentity).code,
    "IDENTITY_ALREADY_EXISTS",
  );
  const coldStartVerification = await pool.query<{
    verification_url: string;
  }>(
    `SELECT payload->>'verificationUrl' AS verification_url
     FROM outbox
     WHERE unique_key = $1`,
    [`invitation-registration:${coldStartUserId}`],
  );
  const coldStartVerificationToken = new URL(
    coldStartVerification.rows[0]?.verification_url ?? "",
  ).searchParams.get("token");
  assert.ok(coldStartVerificationToken);
  const coldStartVerified = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify-email",
    payload: { token: coldStartVerificationToken },
  });
  assert.equal(coldStartVerified.statusCode, 200, coldStartVerified.body);
  const coldStartLogin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: coldStartEmail, password: loginPassword },
  });
  assert.equal(coldStartLogin.statusCode, 409, coldStartLogin.body);
  assert.equal(json<{ code: string }>(coldStartLogin).code, "ACCOUNT_CONTEXT_REQUIRED");
  assert.equal(coldStartLogin.headers["x-oss-account-context-version"], "0");
  const coldStartCookie = String(coldStartLogin.headers["set-cookie"]).split(";", 1)[0];
  const coldStartAccept = await app.inject({
    method: "POST",
    url: "/api/v1/membership-invitations/accept",
    headers: { cookie: coldStartCookie },
    payload: { token: coldStartInvitationToken },
  });
  assert.equal(coldStartAccept.statusCode, 201, coldStartAccept.body);
  assert.equal(json<{ replayed: boolean }>(coldStartAccept).replayed, false);
  const coldStartReplay = await app.inject({
    method: "POST",
    url: "/api/v1/membership-invitations/accept",
    headers: { cookie: coldStartCookie },
    payload: { token: coldStartInvitationToken },
  });
  assert.equal(coldStartReplay.statusCode, 201, coldStartReplay.body);
  assert.equal(json<{ replayed: boolean }>(coldStartReplay).replayed, true);
  const coldStartSwitch = await app.inject({
    method: "PUT",
    url: "/api/v1/auth/account-context",
    headers: {
      cookie: coldStartCookie,
      "x-oss-account-context-version": "0",
    },
    payload: { clientAccountId: ownerAccountId },
  });
  assert.equal(coldStartSwitch.statusCode, 200, coldStartSwitch.body);
  assert.equal(coldStartSwitch.headers["x-oss-account-context-version"], "1");

  const expiredAcceptedReplayToken = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO client_membership_invitations(
       client_account_id, email, role, permissions, token_digest,
       expires_at, invited_by_user_id, accepted_by_user_id, accepted_at, created_at
     ) VALUES (
       $1, $2, 'viewer', '[]'::jsonb, $3,
       pg_catalog.now() - interval '1 day', $4, $5,
       pg_catalog.now() - interval '1 day 1 hour',
       pg_catalog.now() - interval '2 days'
     )`,
    [
      ownerAccountId,
      coldStartEmail,
      digestToken(expiredAcceptedReplayToken),
      owner.userId,
      coldStartUserId,
    ],
  );
  const expiredAcceptedReplay = await app.inject({
    method: "POST",
    url: "/api/v1/membership-invitations/accept",
    headers: { cookie: coldStartCookie },
    payload: { token: expiredAcceptedReplayToken },
  });
  assert.equal(expiredAcceptedReplay.statusCode, 201, expiredAcceptedReplay.body);
  assert.equal(json<{ replayed: boolean }>(expiredAcceptedReplay).replayed, true);

  for (const status of ["revoked", "expired"] as const) {
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const email = `${status}-cold-start-${databaseName}@example.invalid`;
    await pool.query(
      `INSERT INTO client_membership_invitations(
         id, client_account_id, email, role, permissions, token_digest,
         expires_at, invited_by_user_id, revoked_at, created_at
       ) VALUES ($1, $2, $3, 'viewer', '[]'::jsonb, $4,
         CASE WHEN $6 = 'expired' THEN pg_catalog.now() - interval '1 day'
              ELSE pg_catalog.now() + interval '1 day' END,
         $5,
         CASE WHEN $6 = 'revoked' THEN pg_catalog.now() ELSE NULL END,
         CASE WHEN $6 = 'expired' THEN pg_catalog.now() - interval '2 days'
              ELSE pg_catalog.now() END)`,
      [id, ownerAccountId, email, digestToken(token), owner.userId, status],
    );
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/auth/invitation-registrations",
      payload: { token, email, password: loginPassword, locale: "en" },
    });
    assert.equal(rejected.statusCode, status === "expired" ? 410 : 409, rejected.body);
  }

  const barrier = await pool.connect();
  try {
    await barrier.query("BEGIN");
    await barrier.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
      ownerAccountId,
    ]);
    const targetCookie = `${config.SESSION_COOKIE_NAME}=${target.sessionToken}`;
    const paymentMutation = app.inject({
      method: "POST",
      url: `/api/v1/billing/payment-methods/${randomUUID()}/default`,
      headers: {
        cookie: targetCookie,
        "x-oss-account-context-version": "1",
      },
      payload: {
        expectedVersion: 1,
        idempotencyKey: `concurrent-payment-${randomUUID()}`,
      },
    });
    await waitForBlockedQuery("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE");
    const memberMutation = app.inject({
      method: "PATCH",
      url: `/api/v1/account/members/${target.userId}`,
      headers: {
        cookie: ownerCookie,
        "x-oss-account-context-version": "1",
      },
      payload: { permissions: ["account.contacts.read", "billing.settings.read"] },
    });
    await waitForBlockedQuery("FROM users");
    await barrier.query("COMMIT");
    const [paymentResult, memberResult] = await Promise.all([
      paymentMutation,
      memberMutation,
    ]);
    assert.equal(paymentResult.statusCode, 404, paymentResult.body);
    assert.equal(memberResult.statusCode, 200, memberResult.body);
  } catch (error) {
    await barrier.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    barrier.release();
  }
  const targetAfterPermissionChange = await pool.query<{
    active_client_account_id: string | null;
    account_context_version: string;
    active_reauth_count: string;
  }>(
    `SELECT session_record.active_client_account_id,
            session_record.account_context_version::text,
            (SELECT pg_catalog.count(*)
             FROM reauth_grants grant_record
             WHERE grant_record.session_id = session_record.id
               AND grant_record.invalidated_at IS NULL)::text AS active_reauth_count
     FROM sessions session_record WHERE session_record.id = $1`,
    [target.sessionId],
  );
  assert.deepEqual(targetAfterPermissionChange.rows[0], {
    active_client_account_id: ownerAccountId,
    account_context_version: "2",
    active_reauth_count: "0",
  });

  const restrictedOwnerMember = await createContextMember({
    clientAccountId: ownerAccountId,
    role: "owner",
    label: "restricted-owner-demotion",
  });
  await pool.query(
    `UPDATE client_memberships
     SET restricted_at = pg_catalog.now(), updated_at = pg_catalog.now()
     WHERE client_account_id = $1 AND user_id = $2`,
    [ownerAccountId, restrictedOwnerMember.userId],
  );
  const demotedRestrictedOwner = await app.inject({
    method: "PATCH",
    url: `/api/v1/account/members/${restrictedOwnerMember.userId}`,
    headers: {
      cookie: ownerCookie,
      "x-oss-account-context-version": "1",
    },
    payload: { role: "billing" },
  });
  assert.equal(demotedRestrictedOwner.statusCode, 200, demotedRestrictedOwner.body);
  assert.equal(
    json<{ member: { role: string; restrictions: { membership: boolean } } }>(
      demotedRestrictedOwner,
    ).member.role,
    "billing",
  );
  assert.equal(
    json<{ member: { role: string; restrictions: { membership: boolean } } }>(
      demotedRestrictedOwner,
    ).member.restrictions.membership,
    true,
  );

  const lastOwner = await app.inject({
    method: "PATCH",
    url: `/api/v1/account/members/${owner.userId}`,
    headers: {
      cookie: ownerCookie,
      "x-oss-account-context-version": "1",
    },
    payload: { restricted: true },
  });
  assert.equal(lastOwner.statusCode, 409, lastOwner.body);
  assert.equal(json<{ code: string }>(lastOwner).code, "LAST_OWNER_REQUIRED");

  const removedTarget = await app.inject({
    method: "DELETE",
    url: `/api/v1/account/members/${target.userId}`,
    headers: {
      cookie: ownerCookie,
      "x-oss-account-context-version": "1",
    },
  });
  assert.equal(removedTarget.statusCode, 200, removedTarget.body);
  const targetAfterRemoval = await pool.query<{
    active_client_account_id: string | null;
    account_context_version: string;
  }>(
    `SELECT active_client_account_id, account_context_version::text
     FROM sessions WHERE id = $1`,
    [target.sessionId],
  );
  assert.deepEqual(targetAfterRemoval.rows[0], {
    active_client_account_id: null,
    account_context_version: "3",
  });

  await expectPgCode(
    () =>
      pool!.query(
        "UPDATE client_memberships SET permissions = '[1]'::jsonb WHERE user_id = $1",
        [owner.userId],
      ),
    "23514",
  );
  await expectPgCode(
    () =>
      pool!.query(
        `INSERT INTO client_membership_invitations(
           client_account_id, email, role, permissions, token_digest,
           expires_at, invited_by_user_id
         ) VALUES ($1, $2, 'viewer', '[1]'::jsonb, $3,
           pg_catalog.now() + interval '1 day', $4)`,
        [
          ownerAccountId,
          `bad-db-permission-${databaseName}@example.invalid`,
          digestToken(randomBytes(32).toString("base64url")),
          owner.userId,
        ],
    ),
    "23514",
  );

  const sameAccountOrderId = randomUUID();
  const sameAccountOrderItemId = randomUUID();
  await pool.query(
    `INSERT INTO orders(
       id, client_account_id, submitted_by_user_id, status, currency,
       price_snapshot, one_time_minor, setup_minor, recurring_minor,
       total_minor, idempotency_key, request_fingerprint
     ) VALUES (
       $1, $2, $3, 'completed', 'USD', $4, 0, 0, 500, 500, $5, $6
     )`,
    [
      sameAccountOrderId,
      ownerAccountId,
      owner.userId,
      priceSnapshot,
      `context-same-account-order:${sameAccountOrderId}`,
      `context-same-account-order-fingerprint:${sameAccountOrderId}`,
    ],
  );
  await expectPgCode(
    () =>
      pool!.query("UPDATE orders SET submitted_by_user_id = $2 WHERE id = $1", [
        sameAccountOrderId,
        target.userId,
      ]),
    "P0001",
  );
  await expectPgCode(
    () =>
      pool!.query(
        `UPDATE orders
         SET price_snapshot = pg_catalog.jsonb_set(
           price_snapshot, '{productName}', '"Rewritten order snapshot"'::jsonb
         )
         WHERE id = $1`,
        [sameAccountOrderId],
      ),
    "P0001",
  );
  await expectPgCode(
    () =>
      pool!.query("UPDATE orders SET idempotency_key = $2 WHERE id = $1", [
        sameAccountOrderId,
        `rewritten-order-key:${sameAccountOrderId}`,
      ]),
    "P0001",
  );
  await expectPgCode(
    () => pool!.query("DELETE FROM orders WHERE id = $1", [sameAccountOrderId]),
    "P0001",
  );
  await pool.query(
    `INSERT INTO order_items(
       id, order_id, product_id, product_name, fulfillment_mode,
       billing_cycle, configuration, price_snapshot
     ) VALUES (
       $1, $2, 'synthetic-context-product', 'Synthetic Context Product',
       'automatic', 'monthly', '{}'::jsonb, $3
     )`,
    [sameAccountOrderItemId, sameAccountOrderId, priceSnapshot],
  );
  await expectPgCode(
    () =>
      pool!.query("UPDATE order_items SET order_id = $2 WHERE id = $1", [
        orderItemId,
        sameAccountOrderId,
      ]),
    "P0001",
  );
  await expectPgCode(
    () => pool!.query("DELETE FROM order_items WHERE id = $1", [orderItemId]),
    "P0001",
  );
  await expectPgCode(
    () =>
      pool!.query(
        `UPDATE order_items
         SET price_snapshot = pg_catalog.jsonb_set(
           price_snapshot, '{productName}', '"Rewritten snapshot"'::jsonb
         )
         WHERE id = $1`,
        [orderItemId],
      ),
    "P0001",
  );
  const mismatchedServiceId = randomUUID();
  await expectPgCode(
    () =>
      pool!.query(
        `INSERT INTO services(
           id, client_account_id, order_item_id, status, billing_cycle,
           external_resource_id, activated_at, term_start, term_end
         ) VALUES (
           $1, $2, $3, 'active', 'monthly', $4,
           '2026-01-01T00:00:00Z'::timestamptz,
           '2026-01-01T00:00:00Z'::timestamptz,
           '2026-02-01T00:00:00Z'::timestamptz
         )`,
        [
          mismatchedServiceId,
          secondAccountId,
          orderItemId,
          `context-mismatched-service:${mismatchedServiceId}`,
        ],
      ),
    "P0001",
  );

  await pool.query(
    `UPDATE services
     SET status = 'active', external_resource_id = $2,
         activated_at = '2026-01-01T00:00:00Z'::timestamptz,
         term_start = '2026-01-01T00:00:00Z'::timestamptz,
         term_end = '2026-02-01T00:00:00Z'::timestamptz,
         updated_at = pg_catalog.now()
     WHERE id = $1`,
    [
      serviceId,
      `context-service:${serviceId}`,
    ],
  );
  await expectPgCode(
    () =>
      pool!.query("UPDATE services SET order_item_id = $2 WHERE id = $1", [
        serviceId,
        sameAccountOrderItemId,
      ]),
    "P0001",
  );
  await expectPgCode(
    () =>
      pool!.query("UPDATE services SET billing_cycle = 'annual' WHERE id = $1", [
        serviceId,
      ]),
    "P0001",
  );
  await expectPgCode(
    () => pool!.query("DELETE FROM services WHERE id = $1", [serviceId]),
    "P0001",
  );
  const servicePeriodId = randomUUID();
  await pool.query(
    `INSERT INTO service_periods(
       id, service_id, invoice_id, period_kind,
       period_start, period_end, granted_at
     ) VALUES (
       $1, $2, $3, 'initial',
       '2026-01-01T00:00:00Z'::timestamptz,
       '2026-02-01T00:00:00Z'::timestamptz,
       '2026-01-01T00:00:00Z'::timestamptz
     )`,
    [servicePeriodId, serviceId, invoiceId],
  );
  const servicePeriodEvidence = await pool.query<{
    client_account_id: string;
    schema_019_legacy_relationship: boolean;
  }>(
    `SELECT client_account_id, schema_019_legacy_relationship
     FROM service_periods WHERE id = $1`,
    [servicePeriodId],
  );
  assert.deepEqual(servicePeriodEvidence.rows[0], {
    client_account_id: ownerAccountId,
    schema_019_legacy_relationship: false,
  });
  await expectPgCode(
    () =>
      pool!.query(
        `UPDATE service_periods
         SET schema_019_legacy_relationship = true WHERE id = $1`,
        [servicePeriodId],
      ),
    "P0001",
  );

  await expectPgCode(
    () =>
      pool!.query(
        `UPDATE payment_attempts
         SET client_account_id = $2 WHERE id = $1`,
        [paymentAttemptId, secondAccountId],
    ),
    "P0001",
  );
  await expectPgCode(
    () =>
      pool!.query(
        `UPDATE payment_allocations
         SET client_account_id = $2,
             schema_019_legacy_relationship = false
         WHERE payment_attempt_id = $1`,
        [paymentAttemptId, ownerAccountId],
      ),
    "P0001",
  );
  await expectPgCode(
    () => pool!.query("DELETE FROM payment_attempts WHERE id = $1", [paymentAttemptId]),
    "P0001",
  );

  const sameAccountInvoiceId = randomUUID();
  const sameAccountInvoiceClient = await pool.connect();
  try {
    await sameAccountInvoiceClient.query("BEGIN");
    await sameAccountInvoiceClient.query(
      `INSERT INTO invoices(
         id, client_account_id, order_id, currency, total_minor, due_at
       ) VALUES ($1, $2, $3, 'USD', 500, pg_catalog.now() + interval '7 days')`,
      [sameAccountInvoiceId, ownerAccountId, sameAccountOrderId],
    );
    await sameAccountInvoiceClient.query(
      `INSERT INTO invoice_lines(invoice_id, kind, description, amount_minor)
       VALUES ($1, 'recurring', 'Same-account immutable identity fixture', 500)`,
      [sameAccountInvoiceId],
    );
    await sameAccountInvoiceClient.query("COMMIT");
  } catch (error) {
    await sameAccountInvoiceClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    sameAccountInvoiceClient.release();
  }
  await expectPgCode(
    () =>
      pool!.query("UPDATE payment_attempts SET invoice_id = $2 WHERE id = $1", [
        paymentAttemptId,
        sameAccountInvoiceId,
      ]),
    "P0001",
  );
  const otherInvoiceId = randomUUID();
  const otherInvoiceClient = await pool.connect();
  try {
    await otherInvoiceClient.query("BEGIN");
    await otherInvoiceClient.query(
      `INSERT INTO invoices(
         id, client_account_id, currency, total_minor, due_at
       ) VALUES ($1, $2, 'USD', 500, pg_catalog.now() + interval '7 days')`,
      [otherInvoiceId, secondAccountId],
    );
    await otherInvoiceClient.query(
      `INSERT INTO invoice_lines(invoice_id, kind, description, amount_minor)
       VALUES ($1, 'recurring', 'Other account invoice', 500)`,
      [otherInvoiceId],
    );
    await otherInvoiceClient.query("COMMIT");
  } catch (error) {
    await otherInvoiceClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    otherInvoiceClient.release();
  }
  const otherPaymentAttemptId = randomUUID();
  const otherPaymentAllocationId = randomUUID();
  await pool.query(
    `INSERT INTO payment_attempts(
       id, client_account_id, invoice_id, provider_installation_id,
       external_payment_id, status, amount_minor, principal_minor, fee_minor,
       currency, scenario, idempotency_key, request_fingerprint,
       provider_occurred_at
     ) VALUES (
       $1, $2, $3, 'mock-payment', $4, 'succeeded', 500, 500, 0,
       'USD', 'success', $5, $6, pg_catalog.now()
     )`,
    [
      otherPaymentAttemptId,
      secondAccountId,
      otherInvoiceId,
      `context-external:${otherPaymentAttemptId}`,
      `context-payment:${otherPaymentAttemptId}`,
      `context-payment-fingerprint:${otherPaymentAttemptId}`,
    ],
  );
  await pool.query(
    `INSERT INTO payment_allocations(
       id, payment_attempt_id, invoice_id, amount_minor
     ) VALUES ($1, $2, $3, 500)`,
    [otherPaymentAllocationId, otherPaymentAttemptId, otherInvoiceId],
  );
  const allocationEvidence = await pool.query<{
    client_account_id: string;
    schema_019_legacy_relationship: boolean;
  }>(
    `SELECT client_account_id, schema_019_legacy_relationship
     FROM payment_allocations WHERE id = $1`,
    [otherPaymentAllocationId],
  );
  assert.deepEqual(allocationEvidence.rows[0], {
    client_account_id: secondAccountId,
    schema_019_legacy_relationship: false,
  });
  await expectPgCode(
    () =>
      pool!.query(
        `INSERT INTO payment_allocations(
           payment_attempt_id, invoice_id, amount_minor
         ) VALUES ($1, $2, 1)`,
        [paymentAttemptId, otherInvoiceId],
      ),
    "P0001",
  );
  await expectPgCode(
    () =>
      pool!.query(
        "UPDATE invoices SET due_at = due_at + interval '1 day' WHERE id = $1",
        [invoiceId],
      ),
    "P0001",
  );
  await expectPgCode(
    () => pool!.query("DELETE FROM invoices WHERE id = $1", [invoiceId]),
    "P0001",
  );
  const allowedInvoiceState = await pool.query(
    "UPDATE invoices SET total_minor = total_minor WHERE id = $1 RETURNING id",
    [invoiceId],
  );
  assert.equal(allowedInvoiceState.rowCount, 1);

  const alternateOwnerUserId = randomUUID();
  await pool.query(
    `INSERT INTO users(id, email, password_hash, email_verified_at)
     VALUES ($1, $2, 'synthetic-not-a-password', pg_catalog.now())`,
    [
      alternateOwnerUserId,
      `alternate-recorded-owner-${databaseName}@example.invalid`,
    ],
  );
  await pool.query(
    `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
     VALUES ($1, $2, 'owner', '[]'::jsonb)`,
    [ownerAccountId, alternateOwnerUserId],
  );

  const ownerInvariantClient = await pool.connect();
  try {
    await ownerInvariantClient.query("BEGIN");
    await ownerInvariantClient.query(
      "UPDATE client_memberships SET role = 'viewer' WHERE client_account_id = $1 AND user_id = $2",
      [ownerAccountId, owner.userId],
    );
    await expectPgCode(() => ownerInvariantClient.query("COMMIT"), "P0001");
    await ownerInvariantClient.query("ROLLBACK").catch(() => undefined);
  } finally {
    ownerInvariantClient.release();
  }

  const recordedOwnerPointerClient = await pool.connect();
  try {
    await recordedOwnerPointerClient.query("BEGIN");
    await recordedOwnerPointerClient.query(
      "UPDATE client_accounts SET owner_user_id = $2 WHERE id = $1",
      [ownerAccountId, mixedMembership.userId],
    );
    await expectPgCode(() => recordedOwnerPointerClient.query("COMMIT"), "P0001");
    await recordedOwnerPointerClient.query("ROLLBACK").catch(() => undefined);
  } finally {
    recordedOwnerPointerClient.release();
  }

  const transferredOwner = await app.inject({
    method: "PATCH",
    url: `/api/v1/account/members/${owner.userId}`,
    headers: {
      cookie: ownerCookie,
      "x-oss-account-context-version": "1",
    },
    payload: {
      role: "billing",
      replacementOwnerUserId: alternateOwnerUserId,
    },
  });
  assert.equal(transferredOwner.statusCode, 200, transferredOwner.body);
  const transferBody = json<{
    ownerTransfer: {
      oldOwnerUserId: string;
      newOwnerUserId: string;
      sourceAction: string;
      reason: string;
    };
  }>(transferredOwner);
  assert.deepEqual(transferBody.ownerTransfer, {
    oldOwnerUserId: owner.userId,
    newOwnerUserId: alternateOwnerUserId,
    sourceAction: "membership.patch",
    reason: "recorded owner membership role or restriction changed",
  });
  const transferEvidence = await pool.query<{
    owner_user_id: string;
    actor_id: string;
    reason: string;
    metadata: Record<string, unknown>;
    previous_owner_user_id: string;
    new_owner_user_id: string;
    source: string;
  }>(
    `SELECT account.owner_user_id,
            audit.actor_id,
            audit.reason,
            audit.metadata,
            owner_fact.previous_owner_user_id,
            owner_fact.new_owner_user_id,
            owner_fact.source
     FROM client_accounts account
     JOIN audit_events audit
       ON audit.action = 'client_account.owner_transferred'
      AND audit.target_type = 'client_account'
      AND audit.target_id = account.id::text
     JOIN client_account_owner_transfer_facts owner_fact
       ON owner_fact.client_account_id = account.id
      AND owner_fact.previous_owner_user_id = (audit.metadata->>'oldOwnerUserId')::uuid
      AND owner_fact.new_owner_user_id = (audit.metadata->>'newOwnerUserId')::uuid
      AND owner_fact.source = 'database_update'
     WHERE account.id = $1
     ORDER BY audit.created_at DESC, audit.id DESC
     LIMIT 1`,
    [ownerAccountId],
  );
  assert.equal(transferEvidence.rows[0]?.owner_user_id, alternateOwnerUserId);
  assert.equal(transferEvidence.rows[0]?.actor_id, owner.userId);
  assert.equal(transferEvidence.rows[0]?.previous_owner_user_id, owner.userId);
  assert.equal(transferEvidence.rows[0]?.new_owner_user_id, alternateOwnerUserId);
  assert.equal(transferEvidence.rows[0]?.source, "database_update");
  assert.equal(
    transferEvidence.rows[0]?.reason,
    "recorded owner membership role or restriction changed",
  );
  assert.deepEqual(transferEvidence.rows[0]?.metadata, {
    clientAccountId: ownerAccountId,
    oldOwnerUserId: owner.userId,
    newOwnerUserId: alternateOwnerUserId,
    sourceAction: "membership.patch",
    reason: "recorded owner membership role or restriction changed",
  });

  const rawOwnerUserId = randomUUID();
  await pool.query(
    `INSERT INTO users(id, email, password_hash, email_verified_at)
     VALUES ($1, $2, 'synthetic-not-a-password', pg_catalog.now())`,
    [rawOwnerUserId, `raw-owner-transfer-${databaseName}@example.invalid`],
  );
  await pool.query(
    `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
     VALUES ($1, $2, 'owner', '[]'::jsonb)`,
    [ownerAccountId, rawOwnerUserId],
  );
  await pool.query(
    "UPDATE client_accounts SET owner_user_id = $2 WHERE id = $1",
    [ownerAccountId, rawOwnerUserId],
  );
  const rawTransferFact = await pool.query<{
    id: string;
    previous_owner_user_id: string;
    new_owner_user_id: string;
    source: string;
  }>(
    `SELECT id, previous_owner_user_id, new_owner_user_id, source
     FROM client_account_owner_transfer_facts
     WHERE client_account_id = $1
     ORDER BY recorded_at DESC, id DESC
     LIMIT 1`,
    [ownerAccountId],
  );
  assert.deepEqual(
    {
      previousOwnerUserId: rawTransferFact.rows[0]?.previous_owner_user_id,
      newOwnerUserId: rawTransferFact.rows[0]?.new_owner_user_id,
      source: rawTransferFact.rows[0]?.source,
    },
    {
      previousOwnerUserId: alternateOwnerUserId,
      newOwnerUserId: rawOwnerUserId,
      source: "database_update",
    },
  );
  await expectPgCode(
    () =>
      pool!.query(
        "UPDATE client_account_owner_transfer_facts SET source = source WHERE id = $1",
        [rawTransferFact.rows[0]?.id],
      ),
    "P0001",
  );
  await expectPgCode(
    () =>
      pool!.query("DELETE FROM client_account_owner_transfer_facts WHERE id = $1", [
        rawTransferFact.rows[0]?.id,
      ]),
    "P0001",
  );

  const writeSkewOwnerUserId = randomUUID();
  await pool.query(
    `INSERT INTO users(id, email, password_hash, email_verified_at)
     VALUES ($1, $2, 'synthetic-not-a-password', pg_catalog.now())`,
    [writeSkewOwnerUserId, `owner-write-skew-${databaseName}@example.invalid`],
  );
  await pool.query(
    `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
     VALUES ($1, $2, 'owner', '[]'::jsonb)`,
    [ownerAccountId, writeSkewOwnerUserId],
  );
  const ownerPointerWriter = await pool.connect();
  const ownerRestrictionWriter = await pool.connect();
  try {
    await ownerPointerWriter.query("BEGIN");
    await ownerPointerWriter.query(
      "UPDATE client_accounts SET owner_user_id = $2 WHERE id = $1",
      [ownerAccountId, writeSkewOwnerUserId],
    );
    await ownerRestrictionWriter.query("BEGIN");
    await ownerRestrictionWriter.query(
      `UPDATE client_memberships
       SET restricted_at = pg_catalog.now(), updated_at = pg_catalog.now()
       WHERE client_account_id = $1 AND user_id = $2`,
      [ownerAccountId, writeSkewOwnerUserId],
    );
    await expectPgCode(() => ownerRestrictionWriter.query("COMMIT"), "55P03");
    await ownerRestrictionWriter.query("ROLLBACK").catch(() => undefined);
    await ownerPointerWriter.query("COMMIT");
  } catch (error) {
    await ownerPointerWriter.query("ROLLBACK").catch(() => undefined);
    await ownerRestrictionWriter.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    ownerPointerWriter.release();
    ownerRestrictionWriter.release();
  }
  const writeSkewOwnerInvariant = await pool.query<{
    owner_user_id: string;
    recorded_owner_is_active: boolean;
    active_owner_count: string;
  }>(
    `SELECT account.owner_user_id,
            pg_catalog.bool_and(
              recorded.role = 'owner'
              AND recorded.removed_at IS NULL
              AND recorded.restricted_at IS NULL
            ) AS recorded_owner_is_active,
            (SELECT pg_catalog.count(*)::text
             FROM client_memberships active_owner
             WHERE active_owner.client_account_id = account.id
               AND active_owner.role = 'owner'
               AND active_owner.removed_at IS NULL
               AND active_owner.restricted_at IS NULL) AS active_owner_count
     FROM client_accounts account
     JOIN client_memberships recorded
       ON recorded.client_account_id = account.id
      AND recorded.user_id = account.owner_user_id
     WHERE account.id = $1
     GROUP BY account.id, account.owner_user_id`,
    [ownerAccountId],
  );
  assert.equal(writeSkewOwnerInvariant.rows[0]?.owner_user_id, writeSkewOwnerUserId);
  assert.equal(writeSkewOwnerInvariant.rows[0]?.recorded_owner_is_active, true);
  assert.ok(Number(writeSkewOwnerInvariant.rows[0]?.active_owner_count ?? "0") >= 1);

  process.stdout.write(
    "accountContextIntegration=passed schema=019 " +
      "forwardPreserved=passed explicitContext=passed mutationHeaders=passed " +
      "paginationNoDuplicateOrOmission=passed microseconds=preserved " +
      "invitationAcceptance=passed " +
      "staffIdentity=passed membershipMutationConcurrency=passed " +
      "relationshipIntegrity=passed recordedOwnerInvariant=passed " +
      "ownerTransferAudit=passed ownerTransferDbFacts=passed " +
      "ownerWriteSkewSerialized=passed loginMembershipRace=passed " +
      "directSessionMembershipRace=passed\n",
  );
} finally {
  if (app) await app.close().catch(() => undefined);
  if (pool) await pool.end().catch(() => undefined);
  await admin
    .query(
      `SELECT pg_catalog.pg_terminate_backend(pid)
       FROM pg_catalog.pg_stat_activity
       WHERE datname = $1 AND pid <> pg_catalog.pg_backend_pid()`,
      [databaseName],
    )
    .catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => undefined);
  await admin.end().catch(() => undefined);
}
