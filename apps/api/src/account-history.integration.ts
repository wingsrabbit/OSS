// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { LightMyRequestResponse } from "fastify";
import { PDFDocument } from "pdf-lib";
import pg from "pg";
import { buildApp } from "./app.js";
import { digestToken } from "./auth.js";
import type { Config } from "./config.js";
import {
  assertSchemaCompatible,
  REQUIRED_SCHEMA_VERSION,
  runMigrations,
  transaction,
} from "./database.js";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) {
  throw new Error("ADMIN_DATABASE_URL is required for account-history integration");
}

const databaseName = `oss_account_history_${randomUUID().replaceAll("-", "")}`;
const testDatabaseUrl = new URL(adminDatabaseUrl);
testDatabaseUrl.pathname = `/${databaseName}`;
const admin = new pg.Client({ connectionString: adminDatabaseUrl });
let pool: pg.Pool | null = null;
let app: Awaited<ReturnType<typeof buildApp>>["app"] | null = null;

type Fixture = {
  userId: string;
  accountId: string;
  email: string;
  sessionToken: string;
};

type SupportTicketFixture = {
  id: string;
  clientAccountId: string;
  serviceId?: string;
  createdByUserId: string;
  subject: string;
  departmentRevisionId: string;
  createdAt?: string;
};

function responseJson<T>(response: Readonly<{ body: string }>): T {
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

const config: Config = {
  DATABASE_URL: testDatabaseUrl.toString(),
  OSS_ENV: "test",
  OSS_LOG_LEVEL: "silent",
  OSS_PUBLIC_URL: "http://127.0.0.1:3000",
  API_HOST: "127.0.0.1",
  API_PORT: 3000,
  GLOBAL_RATE_LIMIT_MAX: 1_000,
  SESSION_COOKIE_NAME: "oss_account_history_session",
  SESSION_TTL_HOURS: 24,
  VERIFICATION_TTL_MINUTES: 30,
  WEB_ORIGIN: "http://127.0.0.1:5173",
  MOCK_MAILBOX_URL: "http://127.0.0.1:4000",
  LAB_MAILBOX_TOKEN: "synthetic-account-history-mailbox-token",
  PROVIDER_OPERATION_CAPABILITY_SECRET:
    "synthetic-account-history-provider-capability",
  PAYMENT_METHOD_TOKEN_KEY: Buffer.alloc(32, 71).toString("base64url"),
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY: Buffer.alloc(32, 72).toString("base64url"),
  IDENTITY_SECRET_KEY: Buffer.alloc(32, 73).toString("base64url"),
  MOCK_PAYMENT_WEBHOOK_SECRET: "synthetic-account-history-payment-hook",
  MOCK_PROVISIONING_WEBHOOK_SECRET:
    "synthetic-account-history-provisioning-hook",
  NOTIFICATION_MAX_ATTEMPTS: 3,
  LAB_MAILBOX_ENABLED: false,
};

async function createFixture(label: string): Promise<Fixture> {
  if (!pool) throw new Error("Test database is not ready");
  const userId = randomUUID();
  const accountId = randomUUID();
  const sessionToken = randomBytes(32).toString("base64url");
  const email = `account-history-${label}-${databaseName}@example.invalid`;
  await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO users(id, email, password_hash, email_verified_at)
       VALUES ($1, $2, 'synthetic-not-a-password', now())`,
      [userId, email],
    );
    await client.query(
      `INSERT INTO client_accounts(id, name, owner_user_id)
       VALUES ($1, $2, $3)`,
      [accountId, `Synthetic ${label} Account`, userId],
    );
    await client.query(
      `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
       VALUES ($1, $2, 'owner', '["*"]'::jsonb)`,
      [accountId, userId],
    );
    await client.query(
      `INSERT INTO sessions(
         user_id, token_digest, expires_at,
         active_client_account_id, account_context_version
       ) VALUES ($1, $2, now() + interval '1 hour', $3, 1)`,
      [userId, digestToken(sessionToken), accountId],
    );
  });
  return { userId, accountId, email, sessionToken };
}

async function createSupportTicketFixture(
  fixture: SupportTicketFixture,
): Promise<void> {
  if (!pool) throw new Error("Test database is not ready");
  const statusEventId = randomUUID();
  await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO support_ticket_status_events(
         id, ticket_id, previous_status, status,
         actor_type, actor_user_id, reason, occurred_at
       ) VALUES (
         $1, $2, NULL, 'awaiting_staff',
         'customer', $3, 'Synthetic account history ticket created',
         COALESCE($4::timestamptz, pg_catalog.now())
       )`,
      [statusEventId, fixture.id, fixture.createdByUserId, fixture.createdAt ?? null],
    );
    await client.query(
      `INSERT INTO support_tickets(
         id, client_account_id, service_id, created_by_user_id, subject,
         department_revision_id, current_status_event_id, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         COALESCE($8::timestamptz, pg_catalog.now()),
         COALESCE($8::timestamptz, pg_catalog.now())
       )`,
      [
        fixture.id,
        fixture.clientAccountId,
        fixture.serviceId ?? null,
        fixture.createdByUserId,
        fixture.subject,
        fixture.departmentRevisionId,
        statusEventId,
        fixture.createdAt ?? null,
      ],
    );
  });
}

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  pool = new pg.Pool({
    connectionString: testDatabaseUrl.toString(),
    max: 8,
    options: "-c search_path=pg_catalog,public",
    statement_timeout: 15_000,
    application_name: "opensales-account-history-integration",
  });
  await runMigrations(pool);
  const compatibility = await assertSchemaCompatible(pool);
  assert.equal(
    compatibility.installedSchemaVersion,
    REQUIRED_SCHEMA_VERSION,
  );

  const customer = await createFixture("Customer Alpha");
  const otherCustomer = await createFixture("Customer Beta");
  const staff = await createFixture("Staff");
  await pool.query(
    `INSERT INTO staff_members(user_id, roles, permissions)
     VALUES ($1, ARRAY['Operations'], $2::jsonb)`,
    [
      staff.userId,
      JSON.stringify(["accounts.view", "orders.read", "support.tickets.manage"]),
    ],
  );
  const supportDepartment = await pool.query<{ id: string }>(
    `SELECT revision.id
     FROM support_departments department
     JOIN support_department_revisions revision
       ON revision.id = department.current_revision_id
     WHERE department.code = 'general-support'
       AND revision.accepts_authenticated`,
  );
  const supportDepartmentRevisionId = supportDepartment.rows[0]?.id;
  assert.ok(supportDepartmentRevisionId);

  const orderId = randomUUID();
  const itemId = randomUUID();
  const invoiceId = randomUUID();
  const paymentId = randomUUID();
  const serviceId = randomUUID();
  const renewalInvoiceId = randomUUID();
  const renewalId = randomUUID();
  const ticketId = randomUUID();
  const otherOrderId = randomUUID();
  const otherItemId = randomUUID();
  const otherTraceOrderId = randomUUID();
  const otherTraceItemId = randomUUID();
  const otherInvoiceId = randomUUID();
  const otherPaymentId = randomUUID();
  const otherServiceId = randomUUID();
  const otherTicketId = randomUUID();
  const standaloneInvoiceId = randomUUID();
  const unscopedTicketId = randomUUID();
  const paginationOrderIds = [randomUUID(), randomUUID(), randomUUID()];
  const paginationItemIds = [randomUUID(), randomUUID(), randomUUID()];
  const paginationServiceIds = [randomUUID(), randomUUID(), randomUUID()];
  const paginationRenewalInvoiceIds = [randomUUID(), randomUUID(), randomUUID()];
  const paginationRenewalIds = [randomUUID(), randomUUID(), randomUUID()];
  const paginationPaymentIds = [randomUUID(), randomUUID(), randomUUID()];
  const paginationTicketIds = [randomUUID(), randomUUID(), randomUUID()];
  const paginationRefundIds = [randomUUID(), randomUUID(), randomUUID()];
  const paginationCreditIds = [randomUUID(), randomUUID(), randomUUID()];
  const paginationMembershipUserIds = [randomUUID(), randomUUID(), randomUUID()];
  const priceSnapshot = {
    currency: "USD",
    billingCycle: "monthly",
    productId: "synthetic-history-service",
    productName: "Synthetic History Service",
    fulfillmentMode: "automatic",
    components: [],
    oneTimeSubtotalMinor: "0",
    setupMinor: "0",
    recurringSubtotalMinor: "500",
    invoiceTotalMinor: "500",
  };
  await pool.query(
    `INSERT INTO orders(
       id, client_account_id, submitted_by_user_id, status, currency, price_snapshot,
       one_time_minor, setup_minor, recurring_minor, total_minor,
       idempotency_key, request_fingerprint
     ) VALUES ($1, $2, $3, 'completed', 'USD', $4, 0, 0, 500, 500, $5, $6)`,
    [
      orderId,
      customer.accountId,
      customer.userId,
      priceSnapshot,
      `history-order:${orderId}`,
      `history-order-fingerprint:${orderId}`,
    ],
  );
  await pool.query(
    `INSERT INTO order_items(
       id, order_id, product_id, product_name, fulfillment_mode,
       billing_cycle, configuration, price_snapshot
     ) VALUES ($1, $2, 'synthetic-history-service', 'Synthetic History Service',
       'automatic', 'monthly', '{}'::jsonb, $3)`,
    [itemId, orderId, priceSnapshot],
  );
  const initialInvoiceClient = await pool.connect();
  try {
    await initialInvoiceClient.query("BEGIN");
    await initialInvoiceClient.query(
      `INSERT INTO invoices(id, client_account_id, order_id, currency, total_minor, due_at)
       VALUES ($1, $2, $3, 'USD', 500, now() + interval '7 days')`,
      [invoiceId, customer.accountId, orderId],
    );
    await initialInvoiceClient.query(
      `INSERT INTO invoice_lines(invoice_id, kind, description, amount_minor)
       SELECT $1,
              'recurring',
              CASE
                WHEN line_number = 1 THEN '简体中文账单明细 - 云服务月费'
                WHEN line_number = 2 THEN '香港节点带宽续费与技术支持'
                WHEN line_number = 50 THEN
                  'OSS-LONG-DESCRIPTION-BEGIN ' ||
                  pg_catalog.repeat('跨页账单内容 ', 700) ||
                  ' OSS-LONG-DESCRIPTION-END'
                ELSE 'Synthetic History Service - monthly line ' || line_number::text
              END,
              10
       FROM pg_catalog.generate_series(1, 50) AS line_number`,
      [invoiceId],
    );
    await initialInvoiceClient.query("COMMIT");
  } catch (error) {
    await initialInvoiceClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    initialInvoiceClient.release();
  }
  await pool.query(
    `INSERT INTO payment_attempts(
       id, client_account_id, invoice_id, provider_installation_id,
       external_payment_id, status, amount_minor, principal_minor,
       fee_minor, currency, scenario, idempotency_key, request_fingerprint,
       provider_occurred_at
     ) VALUES (
       $1, $2, $3, 'mock-payment', $4, 'succeeded', 500, 500,
       0, 'USD', 'success', $5, $6, now()
     )`,
    [
      paymentId,
      customer.accountId,
      invoiceId,
      `history-external:${paymentId}`,
      `history-payment:${paymentId}`,
      `history-payment-fingerprint:${paymentId}`,
    ],
  );
  await pool.query(
    `INSERT INTO payment_allocations(payment_attempt_id, invoice_id, amount_minor)
     VALUES ($1, $2, 500)`,
    [paymentId, invoiceId],
  );
  await pool.query(
    `INSERT INTO fund_receipts(
       provider_installation_id, external_payment_id, reported_payment_attempt_id,
       client_account_id, amount_minor, allocated_minor, currency, occurred_at, disposition
     ) VALUES ('mock-payment', $1, $2, $3, 500, 500, 'USD', now(), 'allocated')`,
    [`history-external:${paymentId}`, paymentId, customer.accountId],
  );
  const termResult = await pool.query<{ start_at: Date; end_at: Date }>(
    `SELECT date_trunc('second', now()) AS start_at,
            date_trunc('second', now()) + interval '1 month' AS end_at`,
  );
  const term = termResult.rows[0];
  if (!term) throw new Error("Unable to create service term fixture");
  await pool.query(
    `INSERT INTO services(
       id, client_account_id, order_item_id, status, billing_cycle,
       external_resource_id, activated_at, term_start, term_end
     ) VALUES ($1, $2, $3, 'active', 'monthly', $4, $5, $5, $6)`,
    [serviceId, customer.accountId, itemId, `mock-resource:${serviceId}`, term.start_at, term.end_at],
  );
  await pool.query(
    `INSERT INTO service_periods(
       service_id, invoice_id, period_kind, period_start, period_end, granted_at
     ) VALUES ($1, $2, 'initial', $3, $4, $3)`,
    [serviceId, invoiceId, term.start_at, term.end_at],
  );
  const renewalInvoiceClient = await pool.connect();
  try {
    await renewalInvoiceClient.query("BEGIN");
    await renewalInvoiceClient.query(
      `INSERT INTO invoices(id, client_account_id, currency, total_minor, due_at)
       VALUES ($1, $2, 'USD', 500, now() + interval '21 days')`,
      [renewalInvoiceId, customer.accountId],
    );
    await renewalInvoiceClient.query(
      `INSERT INTO invoice_lines(invoice_id, kind, description, amount_minor)
       VALUES ($1, 'recurring', 'Synthetic History Service - renewal', 500)`,
      [renewalInvoiceId],
    );
    await renewalInvoiceClient.query("COMMIT");
  } catch (error) {
    await renewalInvoiceClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    renewalInvoiceClient.release();
  }
  const automationRun = await pool.query<{ id: string }>(
    `INSERT INTO billing_automation_runs(
       policy_id, business_date, effective_at, requested_by_user_id, reason
     ) VALUES ('default', current_date, now(), $1,
       'Synthetic account history renewal fixture')
     RETURNING id`,
    [staff.userId],
  );
  await pool.query(
    `INSERT INTO service_renewals(
       id, service_id, invoice_id, automation_run_id,
       period_start, period_end, recurring_minor, currency, price_snapshot
     ) VALUES (
       $1, $2, $3, $4, $5,
       ($5::timestamptz AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC',
       500, 'USD', $6
     )`,
    [renewalId, serviceId, renewalInvoiceId, automationRun.rows[0]?.id, term.end_at, priceSnapshot],
  );
  const creditAccount = await pool.query<{ id: string }>(
    `INSERT INTO credit_accounts(client_account_id, currency)
     VALUES ($1, 'USD') RETURNING id`,
    [customer.accountId],
  );
  await pool.query(
    `INSERT INTO credit_transactions(
       credit_account_id, kind, credit_minor, debit_minor,
       source_type, source_id, actor_type, actor_id, reason,
       idempotency_key, request_fingerprint, result
     ) VALUES (
       $1, 'manual_adjustment', 200, 0, 'integration_fixture', $2,
       'staff', $3, 'Synthetic account history Credit fixture',
       $4, $5, '{}'::jsonb
     )`,
    [
      creditAccount.rows[0]?.id,
      randomUUID(),
      staff.userId,
      `history-credit:${randomUUID()}`,
      `history-credit-fingerprint:${randomUUID()}`,
    ],
  );
  await createSupportTicketFixture({
    id: ticketId,
    clientAccountId: customer.accountId,
    serviceId,
    createdByUserId: customer.userId,
    subject: "Synthetic account history ticket",
    departmentRevisionId: supportDepartmentRevisionId,
  });
  await pool.query(
    `INSERT INTO support_ticket_messages(
       ticket_id, author_user_id, author_type, visibility, body
     ) VALUES
       ($1, $2, 'customer', 'public', 'Synthetic customer-visible history'),
       ($1, $3, 'staff', 'internal', 'Synthetic internal account note')`,
    [ticketId, customer.userId, staff.userId],
  );

  await pool.query(
    `INSERT INTO orders(
       id, client_account_id, submitted_by_user_id, status, currency, price_snapshot,
       one_time_minor, setup_minor, recurring_minor, total_minor,
       idempotency_key, request_fingerprint
     ) VALUES ($1, $2, $3, 'completed', 'USD', $4, 0, 0, 500, 500, $5, $6)`,
    [
      otherOrderId,
      otherCustomer.accountId,
      otherCustomer.userId,
      priceSnapshot,
      `history-order:${otherOrderId}`,
      `history-order-fingerprint:${otherOrderId}`,
    ],
  );
  await pool.query(
    `INSERT INTO order_items(
       id, order_id, product_id, product_name, fulfillment_mode,
       billing_cycle, configuration, price_snapshot
     ) VALUES ($1, $2, 'synthetic-history-service', 'Synthetic Beta History Service',
       'automatic', 'monthly', '{}'::jsonb, $3)`,
    [otherItemId, otherOrderId, priceSnapshot],
  );
  await pool.query(
    `INSERT INTO orders(
       id, client_account_id, submitted_by_user_id, status, currency, price_snapshot,
       one_time_minor, setup_minor, recurring_minor, total_minor,
       idempotency_key, request_fingerprint
     ) VALUES ($1, $2, $3, 'completed', 'USD', $4, 0, 0, 500, 500, $5, $6)`,
    [
      otherTraceOrderId,
      otherCustomer.accountId,
      otherCustomer.userId,
      priceSnapshot,
      `history-order:${otherTraceOrderId}`,
      `history-order-fingerprint:${otherTraceOrderId}`,
    ],
  );
  await pool.query(
    `INSERT INTO order_items(
       id, order_id, product_id, product_name, fulfillment_mode,
       billing_cycle, configuration, price_snapshot
     ) VALUES ($1, $2, 'synthetic-history-service', 'Synthetic Beta Trace Item',
       'automatic', 'monthly', '{}'::jsonb, $3)`,
    [otherTraceItemId, otherTraceOrderId, priceSnapshot],
  );
  const otherInvoiceClient = await pool.connect();
  try {
    await otherInvoiceClient.query("BEGIN");
    await otherInvoiceClient.query(
      `INSERT INTO invoices(id, client_account_id, order_id, currency, total_minor, due_at)
       VALUES ($1, $2, $3, 'USD', 500, now() + interval '7 days')`,
      [otherInvoiceId, otherCustomer.accountId, otherOrderId],
    );
    await otherInvoiceClient.query(
      `INSERT INTO invoice_lines(invoice_id, kind, description, amount_minor)
       VALUES ($1, 'recurring', 'Synthetic Beta History Service - monthly', 500)`,
      [otherInvoiceId],
    );
    await otherInvoiceClient.query("COMMIT");
  } catch (error) {
    await otherInvoiceClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    otherInvoiceClient.release();
  }
  await pool.query(
    `INSERT INTO payment_attempts(
       id, client_account_id, invoice_id, provider_installation_id,
       external_payment_id, status, amount_minor, principal_minor,
       fee_minor, currency, scenario, idempotency_key, request_fingerprint,
       provider_occurred_at
     ) VALUES (
       $1, $2, $3, 'mock-payment', $4, 'succeeded', 500, 500,
       0, 'USD', 'success', $5, $6, now()
     )`,
    [
      otherPaymentId,
      otherCustomer.accountId,
      otherInvoiceId,
      `history-external:${otherPaymentId}`,
      `history-payment:${otherPaymentId}`,
      `history-payment-fingerprint:${otherPaymentId}`,
    ],
  );
  await pool.query(
    `INSERT INTO payment_allocations(payment_attempt_id, invoice_id, amount_minor)
     VALUES ($1, $2, 500)`,
    [otherPaymentId, otherInvoiceId],
  );
  await pool.query(
    `INSERT INTO fund_receipts(
       provider_installation_id, external_payment_id, reported_payment_attempt_id,
       client_account_id, amount_minor, allocated_minor, currency, occurred_at, disposition
     ) VALUES ('mock-payment', $1, $2, $3, 500, 500, 'USD', now(), 'allocated')`,
    [`history-external:${otherPaymentId}`, otherPaymentId, otherCustomer.accountId],
  );
  await pool.query(
    `INSERT INTO services(
       id, client_account_id, order_item_id, status, billing_cycle,
       external_resource_id, activated_at, term_start, term_end
     ) VALUES ($1, $2, $3, 'active', 'monthly', $4, $5, $5, $6)`,
    [
      otherServiceId,
      otherCustomer.accountId,
      otherItemId,
      `mock-resource:${otherServiceId}`,
      term.start_at,
      term.end_at,
    ],
  );
  await pool.query(
    `INSERT INTO service_periods(
       service_id, invoice_id, period_kind, period_start, period_end, granted_at
     ) VALUES ($1, $2, 'initial', $3, $4, $3)`,
    [otherServiceId, otherInvoiceId, term.start_at, term.end_at],
  );
  await createSupportTicketFixture({
    id: otherTicketId,
    clientAccountId: otherCustomer.accountId,
    serviceId: otherServiceId,
    createdByUserId: otherCustomer.userId,
    subject: "Synthetic Beta account history ticket",
    departmentRevisionId: supportDepartmentRevisionId,
  });
  await pool.query(
    `INSERT INTO support_ticket_messages(
       ticket_id, author_user_id, author_type, visibility, body
     ) VALUES ($1, $2, 'customer', 'public', 'Synthetic Beta customer-visible history')`,
    [otherTicketId, otherCustomer.userId],
  );

  await pool.query(
    `INSERT INTO invoices(id, client_account_id, currency, total_minor, due_at)
     VALUES ($1, $2, 'USD', 0, now() + interval '7 days')`,
    [standaloneInvoiceId, customer.accountId],
  );
  await createSupportTicketFixture({
    id: unscopedTicketId,
    clientAccountId: customer.accountId,
    createdByUserId: customer.userId,
    subject: "Account-level history ticket without a Service",
    departmentRevisionId: supportDepartmentRevisionId,
  });

  for (const [index, paginationOrderId] of paginationOrderIds.entries()) {
    const paginationItemId = paginationItemIds[index];
    const paginationServiceId = paginationServiceIds[index];
    const paginationRenewalInvoiceId = paginationRenewalInvoiceIds[index];
    const paginationRenewalId = paginationRenewalIds[index];
    const paginationPaymentId = paginationPaymentIds[index];
    const paginationTicketId = paginationTicketIds[index];
    if (
      !paginationItemId ||
      !paginationServiceId ||
      !paginationRenewalInvoiceId ||
      !paginationRenewalId ||
      !paginationPaymentId ||
      !paginationTicketId
    ) {
      throw new Error("Incomplete account-history pagination fixture IDs");
    }
    const fixtureAt = `2024-01-02T03:04:05.12345${6 - index}Z`;
    await pool.query(
      `INSERT INTO orders(
         id, client_account_id, submitted_by_user_id, status, currency, price_snapshot,
         one_time_minor, setup_minor, recurring_minor, total_minor,
         idempotency_key, request_fingerprint, submitted_at, updated_at
       ) VALUES (
         $1, $2, $3, 'completed', 'USD', $4,
         0, 0, 500, 500, $5, $6, $7, $7
       )`,
      [
        paginationOrderId,
        customer.accountId,
        customer.userId,
        priceSnapshot,
        `history-page-order:${paginationOrderId}`,
        `history-page-order-fingerprint:${paginationOrderId}`,
        fixtureAt,
      ],
    );
    await pool.query(
      `INSERT INTO order_items(
         id, order_id, product_id, product_name, fulfillment_mode,
         billing_cycle, configuration, price_snapshot
       ) VALUES (
         $1, $2, 'synthetic-history-service', $3,
         'automatic', 'monthly', '{}'::jsonb, $4
       )`,
      [paginationItemId, paginationOrderId, `Pagination Service ${index + 1}`, priceSnapshot],
    );
    await pool.query(
      `INSERT INTO services(
         id, client_account_id, order_item_id, status, billing_cycle,
         external_resource_id, activated_at, term_start, term_end, created_at, updated_at
       ) VALUES ($1, $2, $3, 'active', 'monthly', $4, $5, $5, $6, $7, $7)`,
      [
        paginationServiceId,
        customer.accountId,
        paginationItemId,
        `mock-resource:${paginationServiceId}`,
        term.start_at,
        term.end_at,
        fixtureAt,
      ],
    );
    const paginationInvoiceClient = await pool.connect();
    try {
      await paginationInvoiceClient.query("BEGIN");
      await paginationInvoiceClient.query(
        `INSERT INTO invoices(
           id, client_account_id, currency, total_minor, due_at, created_at
         ) VALUES ($1, $2, 'USD', 500, now() + interval '21 days', $3)`,
        [paginationRenewalInvoiceId, customer.accountId, fixtureAt],
      );
      await paginationInvoiceClient.query(
        `INSERT INTO invoice_lines(invoice_id, kind, description, amount_minor)
         VALUES ($1, 'recurring', $2, 500)`,
        [paginationRenewalInvoiceId, `Pagination renewal ${index + 1}`],
      );
      await paginationInvoiceClient.query("COMMIT");
    } catch (error) {
      await paginationInvoiceClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      paginationInvoiceClient.release();
    }
    await pool.query(
      `INSERT INTO service_renewals(
         id, service_id, invoice_id, automation_run_id,
         period_start, period_end, recurring_minor, currency, price_snapshot, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         ($5::timestamptz AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC',
         500, 'USD', $6, $7, $7
       )`,
      [
        paginationRenewalId,
        paginationServiceId,
        paginationRenewalInvoiceId,
        automationRun.rows[0]?.id,
        term.end_at,
        priceSnapshot,
        fixtureAt,
      ],
    );
    await pool.query(
      `INSERT INTO payment_attempts(
         id, client_account_id, invoice_id, provider_installation_id,
         external_payment_id, status, amount_minor, principal_minor,
         fee_minor, currency, scenario, idempotency_key, request_fingerprint,
         provider_occurred_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, 'mock-payment', $4, 'succeeded', 1, 1,
         0, 'USD', 'success', $5, $6, $7, $7, $7
       )`,
      [
        paginationPaymentId,
        customer.accountId,
        paginationRenewalInvoiceId,
        `history-page-external:${paginationPaymentId}`,
        `history-page-payment:${paginationPaymentId}`,
        `history-page-payment-fingerprint:${paginationPaymentId}`,
        fixtureAt,
      ],
    );
    await pool.query(
      `INSERT INTO fund_receipts(
         provider_installation_id, external_payment_id, reported_payment_attempt_id,
         client_account_id, amount_minor, allocated_minor, currency, occurred_at, disposition
       ) VALUES ('mock-payment', $1, $2, $3, 1, 0, 'USD', $4, 'unclaimed')`,
      [
        `history-page-external:${paginationPaymentId}`,
        paginationPaymentId,
        customer.accountId,
        fixtureAt,
      ],
    );
    await createSupportTicketFixture({
      id: paginationTicketId,
      clientAccountId: customer.accountId,
      serviceId: paginationServiceId,
      createdByUserId: customer.userId,
      subject: `Pagination history ticket ${index + 1}`,
      departmentRevisionId: supportDepartmentRevisionId,
      createdAt: fixtureAt,
    });
  }

  const customerSession = await pool.query<{ id: string }>(
    `SELECT id FROM sessions
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [customer.userId],
  );
  const customerSessionId = customerSession.rows[0]?.id;
  const sourceReceipt = await pool.query<{ id: string }>(
    "SELECT id FROM fund_receipts WHERE reported_payment_attempt_id = $1",
    [paymentId],
  );
  if (!customerSessionId || !sourceReceipt.rows[0]?.id) {
    throw new Error("Unable to resolve refund pagination fixture sources");
  }
  for (const [index, paginationRefundId] of paginationRefundIds.entries()) {
    const fixtureAt = `2024-01-02T03:04:04.12345${6 - index}Z`;
    await pool.query(
      `INSERT INTO refunds(
         id, invoice_id, client_account_id, source_fund_receipt_id,
         provider_installation_id, original_external_payment_id,
         destination, amount_mode, amount_minor, currency, status, scenario,
         requested_by_user_id, requested_session_id, requested_client_account_id,
         reason, idempotency_key, request_fingerprint, result, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, 'mock-payment', $5,
         'original_payment', 'partial', 1, 'USD', 'failed', 'failed',
         $6, $7, $3, $8, $9, $10, '{}'::jsonb, $11, $11
       )`,
      [
        paginationRefundId,
        invoiceId,
        customer.accountId,
        sourceReceipt.rows[0].id,
        `history-external:${paymentId}`,
        customer.userId,
        customerSessionId,
        `Synthetic failed refund pagination fixture ${index + 1}`,
        `history-page-refund:${paginationRefundId}`,
        `history-page-refund-fingerprint:${paginationRefundId}`,
        fixtureAt,
      ],
    );
  }

  const creditAccountId = creditAccount.rows[0]?.id;
  if (!creditAccountId) throw new Error("Unable to resolve Credit pagination fixture");
  for (const [index, paginationCreditId] of paginationCreditIds.entries()) {
    const isCredit = index !== 1;
    await pool.query(
      `INSERT INTO credit_transactions(
         id, credit_account_id, kind, credit_minor, debit_minor,
         source_type, source_id, actor_type, actor_id, reason,
         idempotency_key, request_fingerprint, result, created_at
       ) VALUES (
         $1, $2, 'manual_adjustment', $3, $4,
         'integration_fixture', $5, 'staff', $6, $7,
         $8, $9, '{}'::jsonb, $10
       )`,
      [
        paginationCreditId,
        creditAccountId,
        isCredit ? 1 : 0,
        isCredit ? 0 : 2,
        randomUUID(),
        staff.userId,
        `Synthetic pagination Credit fixture ${index + 1}`,
        `history-page-credit:${paginationCreditId}`,
        `history-page-credit-fingerprint:${paginationCreditId}`,
        `2024-01-02T03:04:03.12345${6 - index}Z`,
      ],
    );
  }

  for (const [index, membershipUserId] of paginationMembershipUserIds.entries()) {
    await pool.query(
      `INSERT INTO users(id, email, password_hash, email_verified_at)
       VALUES ($1, $2, 'synthetic-not-a-password', now())`,
      [membershipUserId, `pagination-member-${index}-${databaseName}@example.invalid`],
    );
    await pool.query(
      `INSERT INTO client_memberships(
         client_account_id, user_id, role, permissions, created_at
       ) VALUES ($1, $2, 'viewer', '[]'::jsonb, $3)`,
      [
        customer.accountId,
        membershipUserId,
        index === 0
          ? "2024-01-02T03:04:02.123454Z"
          : "2024-01-02T03:04:02.123455Z",
      ],
    );
  }

  const pageableAccounts = [
    await createFixture("Pageable-A"),
    await createFixture("Pageable-B"),
    await createFixture("Pageable-C"),
  ];

  ({ app } = await buildApp(config, pool));
  await app.ready();
  const customerCookie = `${config.SESSION_COOKIE_NAME}=${customer.sessionToken}`;
  const otherCookie = `${config.SESSION_COOKIE_NAME}=${otherCustomer.sessionToken}`;
  const staffCookie = `${config.SESSION_COOKIE_NAME}=${staff.sessionToken}`;

  const historyResponse = await app.inject({
    method: "GET",
    url: "/api/v1/customer/business-history",
    headers: { cookie: customerCookie },
  });
  assert.equal(historyResponse.statusCode, 200, historyResponse.body);
  const history = responseJson<{
    orders: Array<{ id: string; items: Array<{ id: string }> }>;
    invoices: Array<{
      id: string;
      orderId: string | null;
      allocatedMinor: string;
      status: string;
    }>;
    payments: Array<{ id: string }>;
    credit: { balanceMinor: string };
    services: Array<{ id: string; invoiceIds: string[] }>;
    renewals: Array<{ id: string; allocatedMinor: string }>;
    tickets: Array<{ id: string; productName: string | null; publicMessageCount: number }>;
    pagination: Record<
      string,
      { limit: number; hasMore: boolean; nextCursor: string | null }
    >;
  }>(historyResponse);
  assert.deepEqual(history.orders.find((order) => order.id === orderId)?.items, [
    { id: itemId, productName: "Synthetic History Service", billingCycle: "monthly" },
  ]);
  const initialInvoiceSummary = history.invoices.find((invoice) => invoice.id === invoiceId);
  assert.equal(initialInvoiceSummary?.status, "paid");
  assert.equal(initialInvoiceSummary?.allocatedMinor, "500");
  assert.ok(history.payments.some((payment) => payment.id === paymentId));
  assert.equal(history.credit.balanceMinor, "200");
  assert.deepEqual(
    history.services.find((service) => service.id === serviceId)?.invoiceIds.sort(),
    [invoiceId, renewalInvoiceId].sort(),
  );
  assert.equal(
    history.renewals.find((renewal) => renewal.id === renewalId)?.allocatedMinor,
    "0",
  );
  assert.equal(
    history.tickets.find((ticket) => ticket.id === ticketId)?.publicMessageCount,
    1,
  );
  assert.equal(
    history.tickets.find((ticket) => ticket.id === unscopedTicketId)?.productName,
    null,
  );
  assert.ok(!history.orders.some((order) => order.id === otherOrderId));
  assert.ok(!history.invoices.some((invoice) => invoice.id === otherInvoiceId));
  assert.ok(!history.payments.some((payment) => payment.id === otherPaymentId));
  assert.ok(!history.services.some((service) => service.id === otherServiceId));
  assert.ok(!history.tickets.some((ticket) => ticket.id === otherTicketId));
  assert.equal(
    history.invoices.find((invoice) => invoice.id === standaloneInvoiceId)?.orderId,
    null,
  );
  const customerFacets = [
    "orders",
    "invoices",
    "payments",
    "creditTransactions",
    "refunds",
    "services",
    "renewals",
    "cancellations",
    "tickets",
  ] as const;
  assert.deepEqual(Object.keys(history.pagination).sort(), [...customerFacets].sort());
  assert.ok(
    customerFacets.every((facet) => history.pagination[facet]?.limit === 25),
  );

  const ambiguousCustomerCursor = await app.inject({
    method: "GET",
    url: "/api/v1/customer/business-history?cursor=ambiguous",
    headers: { cookie: customerCookie },
  });
  assert.equal(ambiguousCustomerCursor.statusCode, 400, ambiguousCustomerCursor.body);

  const creditTransactionIds = await pool.query<{ id: string }>(
    `SELECT transaction.id
     FROM credit_transactions transaction
     JOIN credit_accounts account ON account.id = transaction.credit_account_id
     WHERE account.client_account_id = $1`,
    [customer.accountId],
  );
  const expectedCustomerFacetIds: Record<(typeof customerFacets)[number], string[]> = {
    orders: [orderId, ...paginationOrderIds],
    invoices: [
      invoiceId,
      renewalInvoiceId,
      standaloneInvoiceId,
      ...paginationRenewalInvoiceIds,
    ],
    payments: [paymentId, ...paginationPaymentIds],
    creditTransactions: creditTransactionIds.rows.map((row) => row.id),
    refunds: paginationRefundIds,
    services: [serviceId, ...paginationServiceIds],
    renewals: [renewalId, ...paginationRenewalIds],
    cancellations: [],
    tickets: [ticketId, unscopedTicketId, ...paginationTicketIds],
  };
  const firstCustomerCursors = new Map<string, string>();
  for (const facet of customerFacets) {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const pageQuery: string = cursor
        ? `?limit=2&cursor=${encodeURIComponent(cursor)}`
        : "?limit=2";
      const facetResponse: LightMyRequestResponse = await app.inject({
        method: "GET",
        url: `/api/v1/customer/business-history/${facet}${pageQuery}`,
        headers: { cookie: customerCookie },
      });
      assert.equal(facetResponse.statusCode, 200, `${facet}: ${facetResponse.body}`);
      const facetPage = responseJson<{
        facet: string;
        items: Array<{ id?: string; requestId?: string }>;
        limit: number;
        hasMore: boolean;
        nextCursor: string | null;
      }>(facetResponse);
      assert.equal(facetPage.facet, facet);
      assert.equal(facetPage.limit, 2);
      assert.ok(facetPage.items.length <= 2);
      for (const item of facetPage.items) {
        const id = facet === "cancellations" ? item.requestId : item.id;
        assert.ok(id, `${facet} page item must expose its stable identifier`);
        ids.push(id);
      }
      if (facetPage.hasMore) {
        assert.equal(typeof facetPage.nextCursor, "string");
        if (pages === 0 && facetPage.nextCursor) {
          firstCustomerCursors.set(facet, facetPage.nextCursor);
        }
        assertCursorPreservesPostgresMicroseconds(
          facetPage.nextCursor ?? "",
          `customer ${facet}`,
        );
      } else {
        assert.equal(facetPage.nextCursor, null);
      }
      cursor = facetPage.nextCursor;
      pages += 1;
      assert.ok(pages < 10, `${facet} pagination did not terminate`);
    } while (cursor);
    assert.equal(new Set(ids).size, ids.length, `${facet} pagination repeated an item`);
    assert.deepEqual(
      [...ids].sort(),
      [...expectedCustomerFacetIds[facet]].sort(),
      `${facet} pagination omitted or added an item`,
    );
  }

  const ticketMutationFirstResponse = await app.inject({
    method: "GET",
    url: "/api/v1/customer/business-history/tickets?limit=2",
    headers: { cookie: customerCookie },
  });
  assert.equal(
    ticketMutationFirstResponse.statusCode,
    200,
    ticketMutationFirstResponse.body,
  );
  const ticketMutationFirstPage = responseJson<{
    items: Array<{ id: string }>;
    hasMore: boolean;
    nextCursor: string | null;
  }>(ticketMutationFirstResponse);
  assert.equal(ticketMutationFirstPage.hasMore, true);
  assert.ok(ticketMutationFirstPage.nextCursor);
  assertCursorPreservesPostgresMicroseconds(
    ticketMutationFirstPage.nextCursor,
    "customer tickets before reply mutation",
  );
  const replyTargetId = paginationTicketIds.find(
    (id) => !ticketMutationFirstPage.items.some((item) => item.id === id),
  );
  assert.ok(replyTargetId, "ticket reply target must be beyond the first page");
  const replyBetweenPages = await app.inject({
    method: "POST",
    url: `/api/v1/tickets/${replyTargetId}/replies`,
    headers: {
      cookie: customerCookie,
      "x-oss-account-context-version": "1",
    },
    payload: { message: "Synthetic reply between immutable history pages" },
  });
  assert.equal(replyBetweenPages.statusCode, 201, replyBetweenPages.body);
  const ticketMutationIds = ticketMutationFirstPage.items.map((item) => item.id);
  let ticketMutationCursor: string | null = ticketMutationFirstPage.nextCursor;
  let ticketMutationPages = 1;
  while (ticketMutationCursor) {
    const nextPageResponse: LightMyRequestResponse = await app.inject({
      method: "GET",
      url:
        "/api/v1/customer/business-history/tickets?limit=2&cursor=" +
        encodeURIComponent(ticketMutationCursor),
      headers: { cookie: customerCookie },
    });
    assert.equal(nextPageResponse.statusCode, 200, nextPageResponse.body);
    const nextPage = responseJson<{
      items: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor: string | null;
    }>(nextPageResponse);
    ticketMutationIds.push(...nextPage.items.map((item) => item.id));
    if (nextPage.hasMore) {
      assert.ok(nextPage.nextCursor);
      assertCursorPreservesPostgresMicroseconds(
        nextPage.nextCursor,
        "customer tickets after reply mutation",
      );
    } else {
      assert.equal(nextPage.nextCursor, null);
    }
    ticketMutationCursor = nextPage.nextCursor;
    ticketMutationPages += 1;
    assert.ok(ticketMutationPages < 10, "ticket mutation pagination did not terminate");
  }
  assert.equal(
    new Set(ticketMutationIds).size,
    ticketMutationIds.length,
    "ticket reply between pages repeated an item",
  );
  assert.deepEqual(
    [...ticketMutationIds].sort(),
    [...expectedCustomerFacetIds.tickets].sort(),
    "ticket reply between pages omitted or added an item",
  );

  const orderCursor = firstCustomerCursors.get("orders");
  assert.ok(orderCursor);
  const facetBoundCursor = await app.inject({
    method: "GET",
    url:
      "/api/v1/customer/business-history/invoices?limit=2&cursor=" +
      encodeURIComponent(orderCursor),
    headers: { cookie: customerCookie },
  });
  assert.equal(facetBoundCursor.statusCode, 400, facetBoundCursor.body);
  const accountBoundCursor = await app.inject({
    method: "GET",
    url:
      "/api/v1/customer/business-history/orders?limit=2&cursor=" +
      encodeURIComponent(orderCursor),
    headers: { cookie: otherCookie },
  });
  assert.equal(accountBoundCursor.statusCode, 400, accountBoundCursor.body);

  const otherHistoryResponse = await app.inject({
    method: "GET",
    url: "/api/v1/customer/business-history",
    headers: { cookie: otherCookie },
  });
  assert.equal(otherHistoryResponse.statusCode, 200, otherHistoryResponse.body);
  const otherHistory = responseJson<{
    orders: Array<{ id: string }>;
    invoices: Array<{ id: string }>;
    payments: Array<{ id: string }>;
    services: Array<{ id: string }>;
    tickets: Array<{ id: string }>;
  }>(otherHistoryResponse);
  assert.ok(otherHistory.orders.some((order) => order.id === otherOrderId));
  assert.ok(otherHistory.invoices.some((invoice) => invoice.id === otherInvoiceId));
  assert.ok(otherHistory.payments.some((payment) => payment.id === otherPaymentId));
  assert.ok(otherHistory.services.some((service) => service.id === otherServiceId));
  assert.ok(otherHistory.tickets.some((ticket) => ticket.id === otherTicketId));
  assert.ok(!otherHistory.orders.some((order) => order.id === orderId));
  assert.ok(!otherHistory.invoices.some((invoice) => invoice.id === invoiceId));
  assert.ok(!otherHistory.payments.some((payment) => payment.id === paymentId));
  assert.ok(!otherHistory.services.some((service) => service.id === serviceId));
  assert.ok(!otherHistory.tickets.some((ticket) => ticket.id === ticketId));

  const invoiceDetailResponse = await app.inject({
    method: "GET",
    url: `/api/v1/customer/invoices/${invoiceId}`,
    headers: { cookie: customerCookie },
  });
  assert.equal(invoiceDetailResponse.statusCode, 200, invoiceDetailResponse.body);
  const invoiceDetail = responseJson<{
    invoice: {
      id: string;
      allocatedMinor: string;
      createdAt: string;
      lines: Array<{ description: string; amountMinor: string }>;
    };
    related: { orderId: string; serviceIds: string[] };
    pdfUrl: string;
  }>(invoiceDetailResponse);
  assert.equal(invoiceDetail.invoice.id, invoiceId);
  assert.equal(invoiceDetail.invoice.allocatedMinor, "500");
  assert.equal(invoiceDetail.invoice.lines.length, 50);
  assert.ok(invoiceDetail.invoice.lines.every((line) => line.amountMinor === "10"));
  assert.ok(
    invoiceDetail.invoice.lines.some(
      (line) => line.description === "简体中文账单明细 - 云服务月费",
    ),
  );
  assert.ok(
    invoiceDetail.invoice.lines.some(
      (line) => line.description === "香港节点带宽续费与技术支持",
    ),
  );
  const longDescription = invoiceDetail.invoice.lines.find((line) =>
    line.description.startsWith("OSS-LONG-DESCRIPTION-BEGIN ")
  )?.description;
  assert.ok(longDescription);
  assert.ok(longDescription.length > 4_000);
  assert.ok(longDescription.endsWith(" OSS-LONG-DESCRIPTION-END"));
  assert.equal(invoiceDetail.related.orderId, orderId);
  assert.deepEqual(invoiceDetail.related.serviceIds, [serviceId]);
  assert.equal(invoiceDetail.pdfUrl, `/api/v1/customer/invoices/${invoiceId}/pdf`);

  const invoicePdfResponse = await app.inject({
    method: "GET",
    url: `/api/v1/customer/invoices/${invoiceId}/pdf`,
    headers: { cookie: customerCookie },
  });
  assert.equal(invoicePdfResponse.statusCode, 200, invoicePdfResponse.body);
  assert.match(invoicePdfResponse.headers["content-type"] ?? "", /^application\/pdf/);
  assert.equal(
    invoicePdfResponse.headers["content-disposition"],
    `attachment; filename="invoice-${invoiceId}.pdf"`,
  );
  assert.equal(invoicePdfResponse.rawPayload.subarray(0, 5).toString(), "%PDF-");
  const parsedPdf = await PDFDocument.load(invoicePdfResponse.rawPayload, {
    updateMetadata: false,
  });
  assert.ok(parsedPdf.getPageCount() > 3);
  const pdfCreationDate = parsedPdf.getCreationDate();
  const pdfModificationDate = parsedPdf.getModificationDate();
  assert.ok(pdfCreationDate);
  assert.ok(pdfModificationDate);
  assert.equal(
    Math.floor(pdfCreationDate.getTime() / 1_000),
    Math.floor(new Date(invoiceDetail.invoice.createdAt).getTime() / 1_000),
  );
  assert.equal(
    Math.floor(pdfModificationDate.getTime() / 1_000),
    Math.floor(new Date(invoiceDetail.invoice.createdAt).getTime() / 1_000),
  );
  const pdfOutput = process.env.ACCOUNT_HISTORY_PDF_OUTPUT;
  if (pdfOutput) await writeFile(pdfOutput, invoicePdfResponse.rawPayload);

  const serviceDetailResponse = await app.inject({
    method: "GET",
    url: `/api/v1/customer/services/${serviceId}`,
    headers: { cookie: customerCookie },
  });
  assert.equal(serviceDetailResponse.statusCode, 200, serviceDetailResponse.body);
  const serviceDetail = responseJson<{
    service: { id: string };
    trace: {
      orderId: string;
      invoiceIds: string[];
      paymentIds: string[];
      renewalIds: string[];
      ticketIds: string[];
    };
  }>(serviceDetailResponse);
  assert.equal(serviceDetail.service.id, serviceId);
  assert.equal(serviceDetail.trace.orderId, orderId);
  assert.deepEqual(serviceDetail.trace.invoiceIds.sort(), [invoiceId, renewalInvoiceId].sort());
  assert.deepEqual(serviceDetail.trace.paymentIds, [paymentId]);
  assert.deepEqual(serviceDetail.trace.renewalIds, [renewalId]);
  assert.deepEqual(serviceDetail.trace.ticketIds, [ticketId]);

  const standaloneInvoiceResponse = await app.inject({
    method: "GET",
    url: `/api/v1/customer/invoices/${standaloneInvoiceId}`,
    headers: { cookie: customerCookie },
  });
  assert.equal(
    standaloneInvoiceResponse.statusCode,
    200,
    standaloneInvoiceResponse.body,
  );
  const standaloneInvoice = responseJson<{
    invoice: { id: string; orderId: string | null };
    related: { orderId: string | null; serviceIds: string[]; renewalIds: string[] };
  }>(standaloneInvoiceResponse);
  assert.equal(standaloneInvoice.invoice.id, standaloneInvoiceId);
  assert.equal(standaloneInvoice.invoice.orderId, null);
  assert.equal(standaloneInvoice.related.orderId, null);
  assert.deepEqual(standaloneInvoice.related.serviceIds, []);
  assert.deepEqual(standaloneInvoice.related.renewalIds, []);

  for (const url of [
    `/api/v1/customer/invoices/${invoiceId}`,
    `/api/v1/customer/invoices/${invoiceId}/pdf`,
    `/api/v1/customer/services/${serviceId}`,
  ]) {
    const crossAccount = await app.inject({
      method: "GET",
      url,
      headers: { cookie: otherCookie },
    });
    assert.equal(crossAccount.statusCode, 404, `${url}: ${crossAccount.body}`);
  }
  for (const url of [
    `/api/v1/customer/invoices/${otherInvoiceId}`,
    `/api/v1/customer/invoices/${otherInvoiceId}/pdf`,
    `/api/v1/customer/services/${otherServiceId}`,
  ]) {
    const crossAccount = await app.inject({
      method: "GET",
      url,
      headers: { cookie: customerCookie },
    });
    assert.equal(crossAccount.statusCode, 404, `${url}: ${crossAccount.body}`);
  }

  await pool.query(
    "UPDATE client_accounts SET restricted_at = now() WHERE id = $1",
    [customer.accountId],
  );
  const accountRestrictedMe = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: customerCookie },
  });
  assert.equal(accountRestrictedMe.statusCode, 200, accountRestrictedMe.body);
  const accountRestrictedBody = responseJson<{
    eligible: boolean;
    restrictions: { user: boolean; clientAccount: boolean };
  }>(accountRestrictedMe);
  assert.equal(accountRestrictedBody.eligible, false);
  assert.deepEqual(accountRestrictedBody.restrictions, {
    user: false,
    clientAccount: true,
  });
  const restrictedAccountHistory = await app.inject({
    method: "GET",
    url: "/api/v1/customer/business-history",
    headers: { cookie: customerCookie },
  });
  assert.equal(restrictedAccountHistory.statusCode, 200, restrictedAccountHistory.body);
  assert.ok(
    responseJson<{ invoices: Array<{ id: string }> }>(restrictedAccountHistory).invoices.some(
      (invoice) => invoice.id === invoiceId,
    ),
  );
  await pool.query(
    "UPDATE client_accounts SET restricted_at = NULL WHERE id = $1",
    [customer.accountId],
  );

  await pool.query("UPDATE users SET restricted_at = now() WHERE id = $1", [customer.userId]);
  const userRestrictedMe = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: customerCookie },
  });
  assert.equal(userRestrictedMe.statusCode, 200, userRestrictedMe.body);
  const userRestrictedBody = responseJson<{
    eligible: boolean;
    restrictions: { user: boolean; clientAccount: boolean };
  }>(userRestrictedMe);
  assert.equal(userRestrictedBody.eligible, false);
  assert.deepEqual(userRestrictedBody.restrictions, { user: true, clientAccount: false });
  const restrictedUserHistory = await app.inject({
    method: "GET",
    url: "/api/v1/customer/business-history",
    headers: { cookie: customerCookie },
  });
  assert.equal(restrictedUserHistory.statusCode, 403, restrictedUserHistory.body);
  await pool.query("UPDATE users SET restricted_at = NULL WHERE id = $1", [customer.userId]);

  for (const query of [
    customer.accountId,
    "Customer Alpha",
    customer.email,
  ]) {
    const search = await app.inject({
      method: "GET",
      url: `/api/v1/admin/client-accounts?query=${encodeURIComponent(query)}`,
      headers: { cookie: staffCookie },
    });
    assert.equal(search.statusCode, 200, search.body);
    assert.ok(
      responseJson<{ items: Array<{ id: string }> }>(search).items.some(
        (account) => account.id === customer.accountId,
      ),
    );
  }
  const firstSearchPage = await app.inject({
    method: "GET",
    url: "/api/v1/admin/client-accounts?query=Pageable-&limit=2",
    headers: { cookie: staffCookie },
  });
  assert.equal(firstSearchPage.statusCode, 200, firstSearchPage.body);
  const firstSearchPageBody = responseJson<{
    items: Array<{ id: string; name: string }>;
    hasMore: boolean;
    nextCursor: string | null;
  }>(firstSearchPage);
  assert.equal(firstSearchPageBody.items.length, 2);
  assert.equal(firstSearchPageBody.hasMore, true);
  assert.equal(typeof firstSearchPageBody.nextCursor, "string");
  const secondSearchPage = await app.inject({
    method: "GET",
    url:
      "/api/v1/admin/client-accounts?query=Pageable-&limit=2&cursor=" +
      encodeURIComponent(firstSearchPageBody.nextCursor ?? ""),
    headers: { cookie: staffCookie },
  });
  assert.equal(secondSearchPage.statusCode, 200, secondSearchPage.body);
  const secondSearchPageBody = responseJson<{
    items: Array<{ id: string; name: string }>;
    hasMore: boolean;
    nextCursor: string | null;
  }>(secondSearchPage);
  assert.equal(secondSearchPageBody.items.length, 1);
  assert.equal(secondSearchPageBody.hasMore, false);
  assert.equal(secondSearchPageBody.nextCursor, null);
  const pagedItems = [...firstSearchPageBody.items, ...secondSearchPageBody.items];
  assert.equal(new Set(pagedItems.map((account) => account.id)).size, 3);
  assert.deepEqual(
    pagedItems.map((account) => account.id).sort(),
    pageableAccounts.map((account) => account.accountId).sort(),
  );
  assert.deepEqual(
    pagedItems.map((account) => account.name),
    [
      "Synthetic Pageable-A Account",
      "Synthetic Pageable-B Account",
      "Synthetic Pageable-C Account",
    ],
  );
  const cursorQueryMismatch = await app.inject({
    method: "GET",
    url:
      "/api/v1/admin/client-accounts?query=Customer&limit=2&cursor=" +
      encodeURIComponent(firstSearchPageBody.nextCursor ?? ""),
    headers: { cookie: staffCookie },
  });
  assert.equal(cursorQueryMismatch.statusCode, 400, cursorQueryMismatch.body);
  const summary = await app.inject({
    method: "GET",
    url: `/api/v1/admin/client-accounts/${customer.accountId}/summary`,
    headers: { cookie: staffCookie },
  });
  assert.equal(summary.statusCode, 200, summary.body);
  const summaryBody = responseJson<Record<string, unknown> & { memberships: unknown[] }>(summary);
  assert.equal("contacts" in summaryBody, false);
  assert.equal(summaryBody.memberships.length, 4);
  const ambiguousSummaryCursor = await app.inject({
    method: "GET",
    url: `/api/v1/admin/client-accounts/${customer.accountId}/summary?cursor=ambiguous`,
    headers: { cookie: staffCookie },
  });
  assert.equal(ambiguousSummaryCursor.statusCode, 400, ambiguousSummaryCursor.body);

  const ordersPanel = await app.inject({
    method: "GET",
    url: `/api/v1/admin/client-accounts/${customer.accountId}/orders`,
    headers: { cookie: staffCookie },
  });
  assert.equal(ordersPanel.statusCode, 200, ordersPanel.body);
  for (const panel of ["billing", "services", "renewals", "cancellations", "tickets"]) {
    const forbidden = await app.inject({
      method: "GET",
      url: `/api/v1/admin/client-accounts/${customer.accountId}/${panel}`,
      headers: { cookie: staffCookie },
    });
    assert.equal(forbidden.statusCode, 403, `${panel}: ${forbidden.body}`);
  }

  await pool.query(
    `UPDATE staff_members
     SET permissions = $2::jsonb, updated_at = now()
     WHERE user_id = $1`,
    [staff.userId, JSON.stringify(["billing.read"])],
  );
  const revokedSearch = await app.inject({
    method: "GET",
    url: `/api/v1/admin/client-accounts?query=${customer.accountId}`,
    headers: { cookie: staffCookie },
  });
  assert.equal(revokedSearch.statusCode, 403);
  const revokedOrders = await app.inject({
    method: "GET",
    url: `/api/v1/admin/client-accounts/${customer.accountId}/orders`,
    headers: { cookie: staffCookie },
  });
  assert.equal(revokedOrders.statusCode, 403);
  const billingPanel = await app.inject({
    method: "GET",
    url: `/api/v1/admin/client-accounts/${customer.accountId}/billing`,
    headers: { cookie: staffCookie },
  });
  assert.equal(billingPanel.statusCode, 200, billingPanel.body);
  const billing = responseJson<{
    invoices: Array<{ id: string }>;
    payments: Array<{ id: string }>;
    credit: { balanceMinor: string };
    fundReceipts: Array<{ allocatedMinor: string }>;
  }>(billingPanel);
  assert.ok(billing.invoices.some((invoice) => invoice.id === invoiceId));
  assert.ok(billing.payments.some((payment) => payment.id === paymentId));
  assert.equal(billing.credit.balanceMinor, "200");
  assert.ok(billing.fundReceipts.some((receipt) => receipt.allocatedMinor === "500"));
  const ambiguousBillingCursor = await app.inject({
    method: "GET",
    url: `/api/v1/admin/client-accounts/${customer.accountId}/billing?cursor=ambiguous`,
    headers: { cookie: staffCookie },
  });
  assert.equal(ambiguousBillingCursor.statusCode, 400, ambiguousBillingCursor.body);

  await pool.query(
    `UPDATE staff_members
     SET permissions = $2::jsonb, updated_at = now()
     WHERE user_id = $1`,
    [staff.userId, JSON.stringify(["services.read"])],
  );
  const servicesPanel = await app.inject({
    method: "GET",
    url: `/api/v1/admin/client-accounts/${customer.accountId}/services`,
    headers: { cookie: staffCookie },
  });
  assert.equal(servicesPanel.statusCode, 200, servicesPanel.body);
  const cancellationsPanel = await app.inject({
    method: "GET",
    url: `/api/v1/admin/client-accounts/${customer.accountId}/cancellations`,
    headers: { cookie: staffCookie },
  });
  assert.equal(cancellationsPanel.statusCode, 200, cancellationsPanel.body);

  await pool.query(
    `UPDATE staff_members
     SET permissions = $2::jsonb, updated_at = now()
     WHERE user_id = $1`,
    [staff.userId, JSON.stringify(["support.tickets.manage"])],
  );
  const ticketsPanel = await app.inject({
    method: "GET",
    url: `/api/v1/admin/client-accounts/${customer.accountId}/tickets`,
    headers: { cookie: staffCookie },
  });
  assert.equal(ticketsPanel.statusCode, 200, ticketsPanel.body);
  assert.equal(
    responseJson<{ items: Array<{ id: string; internalMessageCount: number }> }>(ticketsPanel)
      .items.find((ticket) => ticket.id === ticketId)?.internalMessageCount,
    1,
  );

  await pool.query(
    `UPDATE staff_members
     SET permissions = $2::jsonb, updated_at = now()
     WHERE user_id = $1`,
    [
      staff.userId,
      JSON.stringify([
        "accounts.view",
        "orders.read",
        "billing.read",
        "services.read",
        "support.tickets.manage",
      ]),
    ],
  );

  const limitedCustomerAggregate = await app.inject({
    method: "GET",
    url: "/api/v1/customer/business-history?limit=2",
    headers: { cookie: customerCookie },
  });
  assert.equal(
    limitedCustomerAggregate.statusCode,
    200,
    limitedCustomerAggregate.body,
  );
  const limitedCustomerBody = responseJson<
    Record<string, unknown> & {
      pagination: Record<string, { limit: number; hasMore: boolean }>;
    }
  >(limitedCustomerAggregate);
  for (const facet of customerFacets) {
    const collection = facet === "creditTransactions"
      ? (limitedCustomerBody.credit as { transactions: unknown[] }).transactions
      : limitedCustomerBody[facet] as unknown[];
    assert.ok(collection.length <= 2, `${facet} aggregate page exceeded limit`);
    assert.equal(limitedCustomerBody.pagination[facet]?.limit, 2);
    assert.equal(
      limitedCustomerBody.pagination[facet]?.hasMore,
      expectedCustomerFacetIds[facet].length > 2,
    );
  }

  const limitedSummary = await app.inject({
    method: "GET",
    url: `/api/v1/admin/client-accounts/${customer.accountId}/summary?limit=2`,
    headers: { cookie: staffCookie },
  });
  assert.equal(limitedSummary.statusCode, 200, limitedSummary.body);
  const limitedSummaryBody = responseJson<{
    memberships: unknown[];
    restrictions: unknown[];
    pagination: Record<string, { limit: number; hasMore: boolean }>;
  }>(limitedSummary);
  assert.equal(limitedSummaryBody.memberships.length, 2);
  assert.equal(limitedSummaryBody.restrictions.length, 0);
  assert.equal(limitedSummaryBody.pagination.memberships?.hasMore, true);
  assert.equal(limitedSummaryBody.pagination.restrictions?.hasMore, false);

  const limitedBilling = await app.inject({
    method: "GET",
    url: `/api/v1/admin/client-accounts/${customer.accountId}/billing?limit=2`,
    headers: { cookie: staffCookie },
  });
  assert.equal(limitedBilling.statusCode, 200, limitedBilling.body);
  const limitedBillingBody = responseJson<{
    invoices: unknown[];
    payments: unknown[];
    credit: { transactions: unknown[] };
    fundReceipts: unknown[];
    refunds: unknown[];
    chargebacks: unknown[];
    pagination: Record<string, { limit: number; hasMore: boolean }>;
  }>(limitedBilling);
  for (const [facet, collection] of [
    ["invoices", limitedBillingBody.invoices],
    ["payments", limitedBillingBody.payments],
    ["creditTransactions", limitedBillingBody.credit.transactions],
    ["fundReceipts", limitedBillingBody.fundReceipts],
    ["refunds", limitedBillingBody.refunds],
    ["chargebacks", limitedBillingBody.chargebacks],
  ] as const) {
    assert.ok(collection.length <= 2, `${facet} billing aggregate page exceeded limit`);
    assert.equal(limitedBillingBody.pagination[facet]?.limit, 2);
  }
  assert.equal(limitedBillingBody.pagination.invoices?.hasMore, true);
  assert.equal(limitedBillingBody.pagination.payments?.hasMore, true);
  assert.equal(limitedBillingBody.pagination.creditTransactions?.hasMore, true);
  assert.equal(limitedBillingBody.pagination.fundReceipts?.hasMore, true);
  assert.equal(limitedBillingBody.pagination.refunds?.hasMore, true);
  assert.equal(limitedBillingBody.pagination.chargebacks?.hasMore, false);

  const membershipIds = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM client_memberships WHERE client_account_id = $1",
    [customer.accountId],
  );
  const fundReceiptIds = await pool.query<{ id: string }>(
    "SELECT id FROM fund_receipts WHERE client_account_id = $1",
    [customer.accountId],
  );
  const chargebackIds = await pool.query<{ id: string }>(
    "SELECT id FROM add_funds_chargeback_effects WHERE client_account_id = $1",
    [customer.accountId],
  );
  const adminCollections: Array<{
    name: string;
    path: string;
    idKey: "id" | "requestId" | "userId";
    expectedIds: string[];
  }> = [
    {
      name: "summary memberships",
      path: "summary/memberships",
      idKey: "userId",
      expectedIds: membershipIds.rows.map((row) => row.user_id),
    },
    {
      name: "summary restrictions",
      path: "summary/restrictions",
      idKey: "id",
      expectedIds: [],
    },
    {
      name: "orders",
      path: "orders",
      idKey: "id",
      expectedIds: expectedCustomerFacetIds.orders,
    },
    {
      name: "billing invoices",
      path: "billing/invoices",
      idKey: "id",
      expectedIds: expectedCustomerFacetIds.invoices,
    },
    {
      name: "billing payments",
      path: "billing/payments",
      idKey: "id",
      expectedIds: expectedCustomerFacetIds.payments,
    },
    {
      name: "billing Credit",
      path: "billing/creditTransactions",
      idKey: "id",
      expectedIds: expectedCustomerFacetIds.creditTransactions,
    },
    {
      name: "billing receipts",
      path: "billing/fundReceipts",
      idKey: "id",
      expectedIds: fundReceiptIds.rows.map((row) => row.id),
    },
    {
      name: "billing refunds",
      path: "billing/refunds",
      idKey: "id",
      expectedIds: expectedCustomerFacetIds.refunds,
    },
    {
      name: "billing chargebacks",
      path: "billing/chargebacks",
      idKey: "id",
      expectedIds: chargebackIds.rows.map((row) => row.id),
    },
    {
      name: "services",
      path: "services",
      idKey: "id",
      expectedIds: expectedCustomerFacetIds.services,
    },
    {
      name: "renewals",
      path: "renewals",
      idKey: "id",
      expectedIds: expectedCustomerFacetIds.renewals,
    },
    {
      name: "cancellations",
      path: "cancellations",
      idKey: "requestId",
      expectedIds: expectedCustomerFacetIds.cancellations,
    },
    {
      name: "tickets",
      path: "tickets",
      idKey: "id",
      expectedIds: expectedCustomerFacetIds.tickets,
    },
  ];
  const firstAdminCursors = new Map<string, string>();
  for (const collection of adminCollections) {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const pageQuery: string = cursor
        ? `?limit=2&cursor=${encodeURIComponent(cursor)}`
        : "?limit=2";
      const pageResponse: LightMyRequestResponse = await app.inject({
        method: "GET",
        url: `/api/v1/admin/client-accounts/${customer.accountId}/${collection.path}${pageQuery}`,
        headers: { cookie: staffCookie },
      });
      assert.equal(
        pageResponse.statusCode,
        200,
        `${collection.name}: ${pageResponse.body}`,
      );
      const pageBody = responseJson<{
        items: Array<{ id?: string; requestId?: string; userId?: string }>;
        limit: number;
        hasMore: boolean;
        nextCursor: string | null;
      }>(pageResponse);
      assert.equal(pageBody.limit, 2);
      for (const item of pageBody.items) {
        const id = item[collection.idKey];
        assert.ok(id, `${collection.name} item must expose ${collection.idKey}`);
        ids.push(id);
      }
      if (pageBody.hasMore) {
        assert.equal(typeof pageBody.nextCursor, "string");
        if (pages === 0 && pageBody.nextCursor) {
          firstAdminCursors.set(collection.path, pageBody.nextCursor);
        }
        assertCursorPreservesPostgresMicroseconds(
          pageBody.nextCursor ?? "",
          `admin ${collection.name}`,
        );
      } else {
        assert.equal(pageBody.nextCursor, null);
      }
      cursor = pageBody.nextCursor;
      pages += 1;
      assert.ok(pages < 10, `${collection.name} pagination did not terminate`);
    } while (cursor);
    assert.equal(
      new Set(ids).size,
      ids.length,
      `${collection.name} pagination repeated an item`,
    );
    assert.deepEqual(
      [...ids].sort(),
      [...collection.expectedIds].sort(),
      `${collection.name} pagination omitted or added an item`,
    );
  }

  const membershipMutationFirstResponse = await app.inject({
    method: "GET",
    url: `/api/v1/admin/client-accounts/${customer.accountId}/summary/memberships?limit=2`,
    headers: { cookie: staffCookie },
  });
  assert.equal(
    membershipMutationFirstResponse.statusCode,
    200,
    membershipMutationFirstResponse.body,
  );
  const membershipMutationFirstPage = responseJson<{
    items: Array<{ userId: string }>;
    hasMore: boolean;
    nextCursor: string | null;
  }>(membershipMutationFirstResponse);
  assert.equal(membershipMutationFirstPage.hasMore, true);
  assert.ok(membershipMutationFirstPage.nextCursor);
  assertCursorPreservesPostgresMicroseconds(
    membershipMutationFirstPage.nextCursor,
    "admin memberships before removal mutation",
  );
  const membershipToRemove = membershipMutationFirstPage.items[0]?.userId;
  assert.ok(membershipToRemove);
  assert.ok(paginationMembershipUserIds.some((id) => id === membershipToRemove));
  const removedBetweenPages = await pool.query(
    `UPDATE client_memberships
     SET removed_at = now()
     WHERE client_account_id = $1 AND user_id = $2 AND removed_at IS NULL`,
    [customer.accountId, membershipToRemove],
  );
  assert.equal(removedBetweenPages.rowCount, 1);
  const membershipMutationIds = membershipMutationFirstPage.items.map(
    (membership) => membership.userId,
  );
  let membershipMutationCursor: string | null = membershipMutationFirstPage.nextCursor;
  let membershipMutationPages = 1;
  while (membershipMutationCursor) {
    const nextPageResponse: LightMyRequestResponse = await app.inject({
      method: "GET",
      url:
        `/api/v1/admin/client-accounts/${customer.accountId}/summary/memberships` +
        `?limit=2&cursor=${encodeURIComponent(membershipMutationCursor)}`,
      headers: { cookie: staffCookie },
    });
    assert.equal(nextPageResponse.statusCode, 200, nextPageResponse.body);
    const nextPage = responseJson<{
      items: Array<{ userId: string }>;
      hasMore: boolean;
      nextCursor: string | null;
    }>(nextPageResponse);
    membershipMutationIds.push(...nextPage.items.map((membership) => membership.userId));
    if (nextPage.hasMore) {
      assert.ok(nextPage.nextCursor);
      assertCursorPreservesPostgresMicroseconds(
        nextPage.nextCursor,
        "admin memberships after removal mutation",
      );
    } else {
      assert.equal(nextPage.nextCursor, null);
    }
    membershipMutationCursor = nextPage.nextCursor;
    membershipMutationPages += 1;
    assert.ok(
      membershipMutationPages < 10,
      "membership mutation pagination did not terminate",
    );
  }
  assert.equal(
    new Set(membershipMutationIds).size,
    membershipMutationIds.length,
    "membership removal between pages repeated an item",
  );
  assert.deepEqual(
    [...membershipMutationIds].sort(),
    membershipIds.rows.map((row) => row.user_id).sort(),
    "membership removal between pages omitted or added an item",
  );

  const adminOrderCursor = firstAdminCursors.get("orders");
  assert.ok(adminOrderCursor);
  const adminFacetCursorMismatch = await app.inject({
    method: "GET",
    url:
      `/api/v1/admin/client-accounts/${customer.accountId}/services?limit=2&cursor=` +
      encodeURIComponent(adminOrderCursor),
    headers: { cookie: staffCookie },
  });
  assert.equal(adminFacetCursorMismatch.statusCode, 400, adminFacetCursorMismatch.body);

  process.stdout.write(
    `accountHistoryIntegration=passed schema=${compatibility.installedSchemaVersion}` +
      ` pdfPages=${parsedPdf.getPageCount()} crossAccount404=passed` +
      ` pagination=passed mutationStable=passed microseconds=preserved` +
      ` panelPermissions=passed permissionRevocation=passed\n`,
  );
} finally {
  if (app) await app.close().catch(() => undefined);
  if (pool) await pool.end().catch(() => undefined);
  await admin.query(
    `SELECT pg_catalog.pg_terminate_backend(pid)
     FROM pg_catalog.pg_stat_activity
     WHERE datname = $1 AND pid <> pg_catalog.pg_backend_pid()`,
    [databaseName],
  ).catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => undefined);
  await admin.end().catch(() => undefined);
}
