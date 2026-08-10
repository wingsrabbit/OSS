// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import pg from "pg";
import { buildApp } from "./app.js";
import { digestToken } from "./auth.js";
import type { Config } from "./config.js";
import { assertSchemaCompatible, runMigrations } from "./database.js";

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

function responseJson<T>(response: Readonly<{ body: string }>): T {
  return JSON.parse(response.body) as T;
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
  MOCK_PAYMENT_WEBHOOK_SECRET: "synthetic-account-history-payment-hook",
  MOCK_PROVISIONING_WEBHOOK_SECRET:
    "synthetic-account-history-provisioning-hook",
  LAB_MAILBOX_ENABLED: false,
};

async function createFixture(label: string): Promise<Fixture> {
  if (!pool) throw new Error("Test database is not ready");
  const userId = randomUUID();
  const accountId = randomUUID();
  const sessionToken = randomBytes(32).toString("base64url");
  const email = `account-history-${label}-${databaseName}@example.invalid`;
  await pool.query(
    `INSERT INTO users(id, email, password_hash, email_verified_at)
     VALUES ($1, $2, 'synthetic-not-a-password', now())`,
    [userId, email],
  );
  await pool.query(
    `INSERT INTO client_accounts(id, name, owner_user_id)
     VALUES ($1, $2, $3)`,
    [accountId, `Synthetic ${label} Account`, userId],
  );
  await pool.query(
    `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
     VALUES ($1, $2, 'owner', '["*"]'::jsonb)`,
    [accountId, userId],
  );
  await pool.query(
    `INSERT INTO sessions(user_id, token_digest, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')`,
    [userId, digestToken(sessionToken)],
  );
  return { userId, accountId, email, sessionToken };
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
  assert.equal(compatibility.installedSchemaVersion, "018_stage_c_support_tickets");

  const customer = await createFixture("Customer Alpha");
  const otherCustomer = await createFixture("Customer Beta");
  const staff = await createFixture("Staff");
  await pool.query(
    `INSERT INTO staff_members(user_id, roles, permissions)
     VALUES ($1, ARRAY['Operations'], $2::jsonb)`,
    [staff.userId, JSON.stringify(["accounts.view", "orders.read"])],
  );

  const orderId = randomUUID();
  const itemId = randomUUID();
  const invoiceId = randomUUID();
  const paymentId = randomUUID();
  const serviceId = randomUUID();
  const renewalInvoiceId = randomUUID();
  const renewalId = randomUUID();
  const ticketId = randomUUID();
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
       VALUES ($1, 'recurring', 'Synthetic History Service - monthly', 500)`,
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
  await pool.query(
    `INSERT INTO support_tickets(
       id, client_account_id, service_id, created_by_user_id, subject
     ) VALUES ($1, $2, $3, $4, 'Synthetic account history ticket')`,
    [ticketId, customer.accountId, serviceId, customer.userId],
  );
  await pool.query(
    `INSERT INTO support_ticket_messages(
       ticket_id, author_user_id, author_type, visibility, body
     ) VALUES
       ($1, $2, 'customer', 'public', 'Synthetic customer-visible history'),
       ($1, $3, 'staff', 'internal', 'Synthetic internal account note')`,
    [ticketId, customer.userId, staff.userId],
  );

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
    invoices: Array<{ id: string; status: string }>;
    payments: Array<{ id: string }>;
    credit: { balanceMinor: string };
    services: Array<{ id: string; invoiceIds: string[] }>;
    renewals: Array<{ id: string }>;
    tickets: Array<{ id: string; publicMessageCount: number }>;
  }>(historyResponse);
  assert.deepEqual(history.orders.find((order) => order.id === orderId)?.items, [
    { id: itemId, productName: "Synthetic History Service", billingCycle: "monthly" },
  ]);
  assert.equal(history.invoices.find((invoice) => invoice.id === invoiceId)?.status, "paid");
  assert.ok(history.payments.some((payment) => payment.id === paymentId));
  assert.equal(history.credit.balanceMinor, "200");
  assert.deepEqual(
    history.services.find((service) => service.id === serviceId)?.invoiceIds.sort(),
    [invoiceId, renewalInvoiceId].sort(),
  );
  assert.ok(history.renewals.some((renewal) => renewal.id === renewalId));
  assert.equal(
    history.tickets.find((ticket) => ticket.id === ticketId)?.publicMessageCount,
    1,
  );

  const invoiceDetailResponse = await app.inject({
    method: "GET",
    url: `/api/v1/customer/invoices/${invoiceId}`,
    headers: { cookie: customerCookie },
  });
  assert.equal(invoiceDetailResponse.statusCode, 200, invoiceDetailResponse.body);
  const invoiceDetail = responseJson<{
    invoice: { id: string; lines: Array<{ amountMinor: string }> };
    related: { orderId: string; serviceIds: string[] };
    pdfUrl: string;
  }>(invoiceDetailResponse);
  assert.equal(invoiceDetail.invoice.id, invoiceId);
  assert.deepEqual(invoiceDetail.invoice.lines.map((line) => line.amountMinor), ["500"]);
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
  const parsedPdf = await PDFDocument.load(invoicePdfResponse.rawPayload);
  assert.ok(parsedPdf.getPageCount() >= 1);
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
  const summary = await app.inject({
    method: "GET",
    url: `/api/v1/admin/client-accounts/${customer.accountId}/summary`,
    headers: { cookie: staffCookie },
  });
  assert.equal(summary.statusCode, 200, summary.body);
  const summaryBody = responseJson<Record<string, unknown> & { memberships: unknown[] }>(summary);
  assert.equal("contacts" in summaryBody, false);
  assert.equal(summaryBody.memberships.length, 1);

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

  process.stdout.write(
    `accountHistoryIntegration=passed schema=${compatibility.installedSchemaVersion}` +
      ` pdfPages=${parsedPdf.getPageCount()} crossAccount404=passed` +
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
