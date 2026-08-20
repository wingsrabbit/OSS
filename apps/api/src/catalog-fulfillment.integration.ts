// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
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
import { advancePaidInvoice } from "./invoice-settlement.js";
import { registerAdminRoutes } from "./routes-admin.js";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) {
  throw new Error("ADMIN_DATABASE_URL is required for Catalog fulfillment integration");
}

const databaseName = `oss_catalog_fulfillment_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = new URL(adminDatabaseUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = new pg.Client({ connectionString: adminDatabaseUrl });
let adminConnected = false;
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
  SESSION_COOKIE_NAME: "oss_catalog_fulfillment_session",
  SESSION_TTL_HOURS: 24,
  VERIFICATION_TTL_MINUTES: 30,
  WEB_ORIGIN: "http://127.0.0.1:5173",
  MOCK_MAILBOX_URL: "http://127.0.0.1:4000",
  LAB_MAILBOX_TOKEN: "synthetic-catalog-fulfillment-mailbox-token",
  PROVIDER_OPERATION_CAPABILITY_SECRET:
    "synthetic-catalog-fulfillment-provider-operation-secret",
  PAYMENT_METHOD_TOKEN_KEY: Buffer.alloc(32, 121).toString("base64url"),
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY: Buffer.alloc(32, 122).toString("base64url"),
  IDENTITY_SECRET_KEY: Buffer.alloc(32, 123).toString("base64url"),
  MOCK_PAYMENT_WEBHOOK_SECRET: "synthetic-catalog-fulfillment-payment-secret",
  MOCK_PROVISIONING_WEBHOOK_SECRET:
    "synthetic-catalog-fulfillment-provisioning-secret",
  LAB_MAILBOX_ENABLED: false,
};

type OrderFixture = Readonly<{
  orderId: string;
  invoiceId: string;
  serviceId: string;
}>;

function json<T>(body: string): T {
  return JSON.parse(body) as T;
}

try {
  await admin.connect();
  adminConnected = true;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  pool = new pg.Pool({
    connectionString: databaseUrl.toString(),
    max: 8,
    options: "-c search_path=pg_catalog,public",
    statement_timeout: 15_000,
    application_name: "opensales-catalog-fulfillment-integration",
  });
  await runMigrations(pool);

  const customerUserId = randomUUID();
  const clientAccountId = randomUUID();
  const staffUserId = randomUUID();
  const staffSessionId = randomUUID();
  const staffToken = randomBytes(32).toString("base64url");

  await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO users(id, email, password_hash, locale, email_verified_at)
       VALUES
         ($1, $2, 'synthetic-not-a-password', 'en', pg_catalog.now()),
         ($3, $4, 'synthetic-not-a-password', 'en', pg_catalog.now())`,
      [
        customerUserId,
        `catalog-customer-${databaseName}@example.invalid`,
        staffUserId,
        `catalog-staff-${databaseName}@example.invalid`,
      ],
    );
    await client.query(
      `INSERT INTO client_accounts(id, name, owner_user_id)
       VALUES ($1, 'Synthetic Catalog Fulfillment Account', $2)`,
      [clientAccountId, customerUserId],
    );
    await client.query(
      `INSERT INTO client_memberships(
         client_account_id, user_id, role, permissions
       ) VALUES ($1, $2, 'owner', '[]'::jsonb)`,
      [clientAccountId, customerUserId],
    );
    await client.query(
      `INSERT INTO sessions(id, user_id, token_digest, expires_at)
       VALUES ($1, $2, $3, pg_catalog.now() + interval '1 hour')`,
      [staffSessionId, staffUserId, digestToken(staffToken)],
    );
    await client.query(
      `INSERT INTO staff_members(user_id, roles, permissions)
       VALUES ($1, ARRAY['operations']::text[], '["services.manual_fulfillment"]'::jsonb)`,
      [staffUserId],
    );
    await client.query(
      `INSERT INTO reauth_grants(user_id, session_id, expires_at, created_at)
       VALUES (
         $1, $2,
         pg_catalog.clock_timestamp() + interval '14 minutes',
         pg_catalog.clock_timestamp()
       )`,
      [staffUserId, staffSessionId],
    );
    await client.query(
      `INSERT INTO provider_installation_capabilities(
         provider_installation_id, provider_type, enabled, capabilities
       ) VALUES (
         'mock-provisioning-v1', 'provisioning', true,
         '["resource_create","resource_reconcile"]'::jsonb
       )`,
    );
    await client.query(
      `INSERT INTO product_groups(id, sort_order, names)
       VALUES ('catalog-fulfillment', 1, '{"en":"Catalog fulfillment"}'::jsonb)`,
    );
    for (const [productId, fulfillmentMode, bindingMode] of [
      ["automatic-zero", "automatic", "provider"],
      ["automatic-paid", "automatic", "provider"],
      ["automatic-manual", "automatic", "manual"],
      ["review-provider", "review", "provider"],
      ["review-manual", "review", "manual"],
      ["review-without-policy", "review", "none"],
      ["fully-manual", "manual", "none"],
      ["accepted-quote", "quote", "none"],
    ] as const) {
      await client.query(
        `INSERT INTO products(
           id, group_id, names, descriptions, fulfillment_mode,
           active, hidden, repeatable, option_schema
         ) VALUES (
           $1, 'catalog-fulfillment', $2, $3, $4,
           true, false, false, '[]'::jsonb
         )`,
        [
          productId,
          { en: productId },
          { en: "Synthetic normal Catalog fulfillment integration product" },
          fulfillmentMode,
        ],
      );
      if (bindingMode !== "none") {
        await client.query(
          `INSERT INTO product_service_automation_policies(
             product_id, overdue_action, provider_installation_id
           ) VALUES ($1, 'none', $2)`,
          [
            productId,
            bindingMode === "provider" ? "mock-provisioning-v1" : null,
          ],
        );
      }
    }
  });

  async function createOrder(input: Readonly<{
    productId: string;
    fulfillmentMode: "automatic" | "review" | "manual" | "quote";
    totalMinor: bigint;
    status: "waiting_payment" | "awaiting_manual";
    bindingMode: "provider" | "manual" | "none";
  }>): Promise<OrderFixture> {
    if (!pool) throw new Error("Database is unavailable");
    return transaction(pool, async (client) => {
      const order = await client.query<{ id: string }>(
        `INSERT INTO orders(
           client_account_id, submitted_by_user_id, status, currency,
           price_snapshot, one_time_minor, setup_minor, recurring_minor,
           total_minor, idempotency_key, request_fingerprint
         ) VALUES (
           $1, $2, $3, 'USD', '{}'::jsonb, $4, 0, 0, $4, $5, $6
         ) RETURNING id`,
        [
          clientAccountId,
          customerUserId,
          input.status,
          input.totalMinor.toString(),
          `order-${randomUUID()}`,
          `fingerprint-${randomUUID()}`,
        ],
      );
      const orderId = order.rows[0]?.id;
      if (!orderId) throw new Error("Unable to create Order fixture");
      const item = await client.query<{ id: string }>(
        `INSERT INTO order_items(
           order_id, client_account_id, product_id, product_name,
           fulfillment_mode, billing_cycle, configuration, price_snapshot
         ) VALUES ($1, $2, $3, $3, $4, 'monthly', '{}'::jsonb, '{}'::jsonb)
         RETURNING id`,
        [orderId, clientAccountId, input.productId, input.fulfillmentMode],
      );
      const orderItemId = item.rows[0]?.id;
      if (!orderItemId) throw new Error("Unable to create Order Item fixture");
      const invoice = await client.query<{ id: string }>(
        `INSERT INTO invoices(
           client_account_id, order_id, currency, total_minor, due_at
         ) VALUES ($1, $2, 'USD', $3, pg_catalog.now() + interval '7 days')
         RETURNING id`,
        [clientAccountId, orderId, input.totalMinor.toString()],
      );
      const invoiceId = invoice.rows[0]?.id;
      if (!invoiceId) throw new Error("Unable to create Invoice fixture");
      if (input.totalMinor > 0n) {
        await client.query(
          `INSERT INTO invoice_lines(invoice_id, kind, description, amount_minor)
           VALUES ($1, 'one_time', 'Synthetic fulfillment fixture', $2)`,
          [invoiceId, input.totalMinor.toString()],
        );
      }
      const service = await client.query<{ id: string }>(
        `INSERT INTO services(
           client_account_id, order_item_id, status, billing_cycle
         ) VALUES ($1, $2, 'pending', 'monthly') RETURNING id`,
        [clientAccountId, orderItemId],
      );
      const serviceId = service.rows[0]?.id;
      if (!serviceId) throw new Error("Unable to create Service fixture");
      if (input.bindingMode !== "none") {
        await client.query(
          `INSERT INTO service_provider_bindings(
             service_id, provider_installation_id, overdue_action_snapshot,
             capability_snapshot, product_policy_version,
             cycle_end_cancellation_mode_snapshot,
             cycle_end_cancellation_execution_mode_snapshot,
             cycle_end_cancellation_min_notice_hours_snapshot,
             cycle_end_cancellation_requirement_key_snapshot
           )
           SELECT
             $1, policy.provider_installation_id, policy.overdue_action,
             COALESCE(provider.capabilities, '[]'::jsonb), policy.version,
             policy.cycle_end_cancellation_mode,
             policy.cycle_end_cancellation_execution_mode,
             policy.cycle_end_cancellation_min_notice_hours,
             policy.cycle_end_cancellation_requirement_key
           FROM product_service_automation_policies policy
           LEFT JOIN provider_installation_capabilities provider
             ON provider.provider_installation_id = policy.provider_installation_id
           WHERE policy.product_id = $2`,
          [serviceId, input.productId],
        );
      }
      return { orderId, invoiceId, serviceId };
    });
  }

  async function allocateInvoice(invoiceId: string, totalMinor: bigint): Promise<void> {
    if (!pool) throw new Error("Database is unavailable");
    await transaction(pool, async (client) => {
      const attempt = await client.query<{ id: string }>(
        `INSERT INTO payment_attempts(
           client_account_id, invoice_id, provider_installation_id,
           external_payment_id, status, amount_minor, currency,
           scenario, idempotency_key, request_fingerprint, principal_minor
         ) VALUES (
           $1, $2, 'mock-payment-v1', $3, 'succeeded', $4,
           'USD', 'success', $5, $6, $4
         ) RETURNING id`,
        [
          clientAccountId,
          invoiceId,
          `synthetic-payment-${randomUUID()}`,
          totalMinor.toString(),
          `payment-${randomUUID()}`,
          `payment-fingerprint-${randomUUID()}`,
        ],
      );
      const paymentAttemptId = attempt.rows[0]?.id;
      if (!paymentAttemptId) throw new Error("Unable to create Payment fixture");
      await client.query(
        `INSERT INTO payment_allocations(payment_attempt_id, invoice_id, amount_minor)
         VALUES ($1, $2, $3)`,
        [paymentAttemptId, invoiceId, totalMinor.toString()],
      );
    });
  }

  app = Fastify({ logger: false });
  await app.register(cookie);
  app.setErrorHandler((
    error: FastifyError,
    _request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const statusCode =
      "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return reply.code(statusCode).send({
      error: statusCode >= 500 ? "Internal server error" : error.message,
      ...(code ? { code } : {}),
    });
  });
  await registerAdminRoutes(app, pool, config);
  const staffHeaders = { cookie: `${config.SESSION_COOKIE_NAME}=${staffToken}` };
  const reason = "Synthetic Staff reviewed eligibility and fulfillment evidence";

  async function complete(serviceId: string) {
    if (!app) throw new Error("API is unavailable");
    return app.inject({
      method: "POST",
      url: `/api/v1/admin/services/${serviceId}/complete-manual`,
      headers: staffHeaders,
      payload: { reason },
    });
  }

  const automaticZero = await createOrder({
    productId: "automatic-zero",
    fulfillmentMode: "automatic",
    totalMinor: 0n,
    status: "waiting_payment",
    bindingMode: "provider",
  });
  const automaticZeroSettlement = await transaction(pool, (client) =>
    advancePaidInvoice(client, automaticZero.invoiceId, {
      kind: "user_command",
      userId: customerUserId,
    }),
  );
  assert.equal(automaticZeroSettlement.orderStatus, "awaiting_manual");
  const beforeApproval = await pool.query<{ operations: string; jobs: string }>(
    `SELECT
       (SELECT count(*)::text FROM provider_operations WHERE subject_id = $1::uuid) AS operations,
       (SELECT count(*)::text FROM durable_jobs
        WHERE payload->>'serviceId' = $1::text) AS jobs`,
    [automaticZero.serviceId],
  );
  assert.deepEqual(beforeApproval.rows[0], { operations: "0", jobs: "0" });
  const fulfillmentQueue = await app.inject({
    method: "GET",
    url: "/api/v1/admin/manual-fulfillment",
    headers: staffHeaders,
  });
  assert.equal(fulfillmentQueue.statusCode, 200, fulfillmentQueue.body);
  const queuedAutomaticZero = json<{
    items: Array<{ serviceId: string; fulfillmentMode: string; action: string }>;
  }>(fulfillmentQueue.body).items.find((item) => item.serviceId === automaticZero.serviceId);
  assert.equal(queuedAutomaticZero?.fulfillmentMode, "automatic");
  assert.equal(queuedAutomaticZero?.action, "approve_provider_provisioning");

  const approved = await complete(automaticZero.serviceId);
  assert.equal(approved.statusCode, 200, approved.body);
  const approvedBody = json<{
    status: string;
    orderStatus: string;
    fulfillment: string;
    providerOperationId: string;
    jobId: string;
    replayed: boolean;
  }>(approved.body);
  assert.deepEqual(
    {
      status: approvedBody.status,
      orderStatus: approvedBody.orderStatus,
      fulfillment: approvedBody.fulfillment,
      replayed: approvedBody.replayed,
    },
    {
      status: "pending",
      orderStatus: "accepted",
      fulfillment: "provider_queued",
      replayed: false,
    },
  );
  const replayed = await complete(automaticZero.serviceId);
  assert.equal(replayed.statusCode, 200, replayed.body);
  const replayedBody = json<typeof approvedBody>(replayed.body);
  assert.equal(replayedBody.providerOperationId, approvedBody.providerOperationId);
  assert.equal(replayedBody.jobId, approvedBody.jobId);
  assert.equal(replayedBody.replayed, true);
  const stableQueue = await pool.query<{ operations: string; jobs: string }>(
    `SELECT
       (SELECT count(*)::text FROM provider_operations WHERE subject_id = $1::uuid) AS operations,
       (SELECT count(*)::text FROM durable_jobs
        WHERE payload->>'serviceId' = $1::text) AS jobs`,
    [automaticZero.serviceId],
  );
  assert.deepEqual(stableQueue.rows[0], { operations: "1", jobs: "1" });

  const review = await createOrder({
    productId: "review-provider",
    fulfillmentMode: "review",
    totalMinor: 0n,
    status: "awaiting_manual",
    bindingMode: "provider",
  });
  const reviewed = await complete(review.serviceId);
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  assert.equal(json<{ status: string }>(reviewed.body).status, "pending");
  const reviewState = await pool.query<{ order_status: string; service_status: string }>(
    `SELECT original_order.status AS order_status, service.status AS service_status
     FROM services service
     JOIN order_items item ON item.id = service.order_item_id
     JOIN orders original_order ON original_order.id = item.order_id
     WHERE service.id = $1`,
    [review.serviceId],
  );
  assert.deepEqual(reviewState.rows[0], {
    order_status: "accepted",
    service_status: "pending",
  });

  const missingPolicy = await createOrder({
    productId: "review-without-policy",
    fulfillmentMode: "review",
    totalMinor: 0n,
    status: "awaiting_manual",
    bindingMode: "none",
  });
  const blockedReview = await complete(missingPolicy.serviceId);
  assert.equal(blockedReview.statusCode, 409, blockedReview.body);
  assert.equal(
    json<{ code: string }>(blockedReview.body).code,
    "PROVISIONING_POLICY_UNAVAILABLE",
  );
  const blockedReviewState = await pool.query<{
    order_status: string;
    service_status: string;
    operations: string;
  }>(
    `SELECT original_order.status AS order_status,
            service.status AS service_status,
            (SELECT count(*)::text FROM provider_operations operation
             WHERE operation.subject_id = service.id) AS operations
     FROM services service
     JOIN order_items item ON item.id = service.order_item_id
     JOIN orders original_order ON original_order.id = item.order_id
     WHERE service.id = $1`,
    [missingPolicy.serviceId],
  );
  assert.deepEqual(blockedReviewState.rows[0], {
    order_status: "awaiting_manual",
    service_status: "pending",
    operations: "0",
  });

  const automaticManual = await createOrder({
    productId: "automatic-manual",
    fulfillmentMode: "automatic",
    totalMinor: 0n,
    status: "waiting_payment",
    bindingMode: "manual",
  });
  const automaticManualSettlement = await transaction(pool, (client) =>
    advancePaidInvoice(client, automaticManual.invoiceId, {
      kind: "user_command",
      userId: customerUserId,
    }),
  );
  assert.equal(automaticManualSettlement.orderStatus, "awaiting_manual");
  const manualAutomationQueue = await app.inject({
    method: "GET",
    url: "/api/v1/admin/manual-fulfillment",
    headers: staffHeaders,
  });
  assert.equal(manualAutomationQueue.statusCode, 200, manualAutomationQueue.body);
  const queuedAutomaticManual = json<{
    items: Array<{
      serviceId: string;
      action: string;
      fulfillmentExecutionMode: string;
      providerInstallationId: string | null;
    }>;
  }>(manualAutomationQueue.body).items.find(
    (item) => item.serviceId === automaticManual.serviceId,
  );
  assert.deepEqual(
    queuedAutomaticManual && {
      serviceId: queuedAutomaticManual.serviceId,
      action: queuedAutomaticManual.action,
      fulfillmentExecutionMode: queuedAutomaticManual.fulfillmentExecutionMode,
      providerInstallationId: queuedAutomaticManual.providerInstallationId,
    },
    {
      serviceId: automaticManual.serviceId,
      action: "confirm_manual_ready",
      fulfillmentExecutionMode: "manual",
      providerInstallationId: null,
    },
  );
  const automaticManualCompleted = await complete(automaticManual.serviceId);
  assert.equal(automaticManualCompleted.statusCode, 200, automaticManualCompleted.body);
  assert.equal(
    json<{ fulfillment: string }>(automaticManualCompleted.body).fulfillment,
    "manual_ready",
  );

  const reviewManual = await createOrder({
    productId: "review-manual",
    fulfillmentMode: "review",
    totalMinor: 0n,
    status: "awaiting_manual",
    bindingMode: "manual",
  });
  const reviewManualCompleted = await complete(reviewManual.serviceId);
  assert.equal(reviewManualCompleted.statusCode, 200, reviewManualCompleted.body);
  assert.equal(
    json<{ fulfillment: string }>(reviewManualCompleted.body).fulfillment,
    "manual_ready",
  );
  const manualAutomationEffects = await pool.query<{
    operations: string;
    jobs: string;
    active_services: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM provider_operations operation
        WHERE operation.subject_id = ANY($1::uuid[])) AS operations,
       (SELECT count(*)::text FROM durable_jobs job
        WHERE job.payload->>'serviceId' = ANY($2::text[])) AS jobs,
       (SELECT count(*)::text FROM services service
        WHERE service.id = ANY($1::uuid[]) AND service.status = 'active') AS active_services`,
    [
      [automaticManual.serviceId, reviewManual.serviceId],
      [automaticManual.serviceId, reviewManual.serviceId],
    ],
  );
  assert.deepEqual(manualAutomationEffects.rows[0], {
    operations: "0",
    jobs: "0",
    active_services: "2",
  });

  const manual = await createOrder({
    productId: "fully-manual",
    fulfillmentMode: "manual",
    totalMinor: 0n,
    status: "waiting_payment",
    bindingMode: "none",
  });
  const manualSettlement = await transaction(pool, (client) =>
    advancePaidInvoice(client, manual.invoiceId, {
      kind: "user_command",
      userId: customerUserId,
    }),
  );
  assert.equal(manualSettlement.orderStatus, "awaiting_manual");
  const manualReady = await complete(manual.serviceId);
  assert.equal(manualReady.statusCode, 200, manualReady.body);
  assert.equal(json<{ status: string }>(manualReady.body).status, "active");

  const quote = await createOrder({
    productId: "accepted-quote",
    fulfillmentMode: "quote",
    totalMinor: 100n,
    status: "awaiting_manual",
    bindingMode: "none",
  });
  const unpaidQuote = await complete(quote.serviceId);
  assert.equal(unpaidQuote.statusCode, 409, unpaidQuote.body);
  assert.equal(json<{ code: string }>(unpaidQuote.body).code, "INVOICE_NOT_FULLY_PAID");
  await allocateInvoice(quote.invoiceId, 100n);
  const quoteReady = await complete(quote.serviceId);
  assert.equal(quoteReady.statusCode, 200, quoteReady.body);
  assert.equal(json<{ status: string }>(quoteReady.body).status, "active");

  const automaticPaid = await createOrder({
    productId: "automatic-paid",
    fulfillmentMode: "automatic",
    totalMinor: 100n,
    status: "waiting_payment",
    bindingMode: "provider",
  });
  await allocateInvoice(automaticPaid.invoiceId, 100n);
  const automaticSettlement = await transaction(pool, (client) =>
    advancePaidInvoice(client, automaticPaid.invoiceId, {
      kind: "user_command",
      userId: customerUserId,
    }),
  );
  assert.equal(automaticSettlement.orderStatus, "accepted");
  const automaticQueue = await pool.query<{ operations: string; jobs: string }>(
    `SELECT
       (SELECT count(*)::text FROM provider_operations WHERE subject_id = $1::uuid) AS operations,
       (SELECT count(*)::text FROM durable_jobs
        WHERE payload->>'serviceId' = $1::text) AS jobs`,
    [automaticPaid.serviceId],
  );
  assert.deepEqual(automaticQueue.rows[0], { operations: "1", jobs: "1" });

  console.log(
    "Catalog fulfillment PostgreSQL 18 integration: PASS — Provider-bound zero automatic and review require explicit Staff approval before a stable Provider queue; replay preserves one operation/job; missing policy remains Pending with a clear conflict; manual-bound Automatic and Review activate through audited Staff completion with no Provider operation/job; fully manual and paid accepted Quote complete through Staff Ready confirmation; unpaid Quote is blocked; paid Provider-bound automatic remains queued normally.",
  );
} finally {
  await app?.close().catch(() => undefined);
  app = null;
  await pool?.end().catch(() => undefined);
  pool = null;
  if (adminConnected) {
    await admin.query(
      `SELECT pg_catalog.pg_terminate_backend(pid)
       FROM pg_catalog.pg_stat_activity
       WHERE datname = $1 AND pid <> pg_catalog.pg_backend_pid()`,
      [databaseName],
    ).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    adminConnected = false;
  } else {
    await admin.end().catch(() => undefined);
  }
}
