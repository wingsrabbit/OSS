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
import { ZodError } from "zod";
import { digestToken } from "./auth.js";
import type { Config } from "./config.js";
import { runMigrations, transaction, type DatabasePool } from "./database.js";
import { registerAdminRoutes } from "./routes-admin.js";
import { registerCatalogAutomationRoutes } from "./routes-catalog-automation.js";
import { registerCommerceRoutes } from "./routes-commerce.js";
import { registerOrderRoutes } from "./routes-orders.js";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) {
  throw new Error("ADMIN_DATABASE_URL is required for Catalog automation policy integration");
}

const databaseName = `oss_catalog_automation_${randomUUID().replaceAll("-", "")}`;
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
  SESSION_COOKIE_NAME: "oss_catalog_automation_session",
  SESSION_TTL_HOURS: 24,
  VERIFICATION_TTL_MINUTES: 30,
  WEB_ORIGIN: "http://127.0.0.1:5173",
  MOCK_MAILBOX_URL: "http://127.0.0.1:4000",
  LAB_MAILBOX_TOKEN: "synthetic-catalog-automation-mailbox-token",
  PROVIDER_OPERATION_CAPABILITY_SECRET:
    "synthetic-catalog-automation-provider-operation-secret",
  PAYMENT_METHOD_TOKEN_KEY: Buffer.alloc(32, 131).toString("base64url"),
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY: Buffer.alloc(32, 132).toString("base64url"),
  IDENTITY_SECRET_KEY: Buffer.alloc(32, 133).toString("base64url"),
  MOCK_PAYMENT_WEBHOOK_SECRET: "synthetic-catalog-automation-payment-secret",
  MOCK_PROVISIONING_WEBHOOK_SECRET:
    "synthetic-catalog-automation-provisioning-secret",
  LAB_MAILBOX_ENABLED: false,
};

type Identity = Readonly<{
  userId: string;
  sessionId: string;
  accountId: string | null;
  cookie: string;
}>;

function json<T>(response: Readonly<{ body: string }>): T {
  return JSON.parse(response.body) as T;
}

async function createStaff(
  label: string,
  permissions: readonly string[],
  withReauth: boolean,
): Promise<Identity> {
  if (!pool) throw new Error("Database is unavailable");
  const userId = randomUUID();
  const sessionId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO users(id, email, password_hash, locale, email_verified_at)
       VALUES ($1, $2, 'synthetic-not-a-password', 'en', pg_catalog.now())`,
      [userId, `${label}-${databaseName}@example.invalid`],
    );
    await client.query(
      `INSERT INTO sessions(id, user_id, token_digest, expires_at)
       VALUES ($1, $2, $3, pg_catalog.now() + interval '1 hour')`,
      [sessionId, userId, digestToken(token)],
    );
    await client.query(
      `INSERT INTO staff_members(user_id, roles, permissions)
       VALUES ($1, ARRAY['operations']::text[], $2::jsonb)`,
      [userId, JSON.stringify(permissions)],
    );
    if (withReauth) {
      await client.query(
        `INSERT INTO reauth_grants(user_id, session_id, expires_at, created_at)
         VALUES (
           $1, $2,
           pg_catalog.clock_timestamp() + interval '14 minutes',
           pg_catalog.clock_timestamp()
         )`,
        [userId, sessionId],
      );
    }
  });
  return {
    userId,
    sessionId,
    accountId: null,
    cookie: `${config.SESSION_COOKIE_NAME}=${token}`,
  };
}

async function createCustomer(label: string): Promise<Identity> {
  if (!pool) throw new Error("Database is unavailable");
  const userId = randomUUID();
  const accountId = randomUUID();
  const sessionId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO users(id, email, password_hash, locale, email_verified_at)
       VALUES ($1, $2, 'synthetic-not-a-password', 'en', pg_catalog.now())`,
      [userId, `${label}-${databaseName}@example.invalid`],
    );
    await client.query(
      `INSERT INTO client_accounts(id, name, owner_user_id)
       VALUES ($1, $2, $3)`,
      [accountId, `${label} synthetic account`, userId],
    );
    await client.query(
      `INSERT INTO client_memberships(
         client_account_id, user_id, role, permissions
       ) VALUES ($1, $2, 'owner', '[]'::jsonb)`,
      [accountId, userId],
    );
    await client.query(
      `INSERT INTO sessions(
         id, user_id, token_digest, expires_at,
         active_client_account_id, account_context_version
       ) VALUES (
         $1, $2, $3, pg_catalog.now() + interval '1 hour', $4, 1
       )`,
      [sessionId, userId, digestToken(token), accountId],
    );
  });
  return {
    userId,
    sessionId,
    accountId,
    cookie: `${config.SESSION_COOKIE_NAME}=${token}`,
  };
}

function staffHeaders(identity: Identity): Record<string, string> {
  return { cookie: identity.cookie };
}

function customerHeaders(identity: Identity): Record<string, string> {
  return {
    cookie: identity.cookie,
    "x-oss-account-context-version": "1",
  };
}

async function createProduct(input: Readonly<{
  productId: string;
  fulfillmentMode: "automatic" | "review";
  staff: Identity;
}>): Promise<string> {
  if (!app) throw new Error("API is unavailable");
  const product = await app.inject({
    method: "POST",
    url: "/api/v1/admin/catalog/products",
    headers: staffHeaders(input.staff),
    payload: {
      id: input.productId,
      groupId: "automation-lab",
      names: { en: input.productId },
      descriptions: { en: "Synthetic normal Provider automation policy product" },
      fulfillmentMode: input.fulfillmentMode,
      optionSchema: [],
    },
  });
  assert.equal(product.statusCode, 201, product.body);
  const price = await app.inject({
    method: "POST",
    url: `/api/v1/admin/catalog/products/${input.productId}/prices`,
    headers: staffHeaders(input.staff),
    payload: {
      billingCycle: "monthly",
      currency: "USD",
      oneTimeMinor: "0",
      setupMinor: "0",
      recurringMinor: "0",
    },
  });
  assert.equal(price.statusCode, 201, price.body);
  return json<{ priceId: string }>(price).priceId;
}

async function checkout(priceId: string, customer: Identity) {
  if (!app) throw new Error("API is unavailable");
  return app.inject({
    method: "POST",
    url: "/api/v1/orders",
    headers: customerHeaders(customer),
    payload: {
      priceId,
      configuration: {},
      termsVersion: "mock-lab-v1",
      aupVersion: "mock-lab-v1",
      idempotencyKey: `automation-checkout-${randomUUID()}`,
    },
  });
}

try {
  await admin.connect();
  adminConnected = true;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  pool = new pg.Pool({
    connectionString: databaseUrl.toString(),
    max: 12,
    options: "-c search_path=pg_catalog,public",
    statement_timeout: 15_000,
    application_name: "opensales-catalog-automation-integration",
  });
  await runMigrations(pool);

  app = Fastify({ logger: false });
  await app.register(cookie);
  app.setErrorHandler((
    error: FastifyError,
    _request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const statusCode =
      error instanceof ZodError
        ? 400
        : "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return reply.code(statusCode).send({
      error: statusCode >= 500 ? "Internal server error" : error.message,
      ...(code ? { code } : {}),
    });
  });
  await registerAdminRoutes(app, pool, config);
  await registerCatalogAutomationRoutes(app, pool, config);
  await registerCommerceRoutes(app, pool, config);
  await registerOrderRoutes(app, pool, config);

  const staff = await createStaff(
    "automation-staff",
    [
      "catalog.read",
      "catalog.manage",
      "catalog.pricing.manage",
      "services.manual_fulfillment",
    ],
    true,
  );
  const readOnlyStaff = await createStaff(
    "automation-readonly",
    ["catalog.read"],
    false,
  );
  const customer = await createCustomer("automation-customer");

  await pool.query(
    `INSERT INTO provider_installation_capabilities(
       provider_installation_id, provider_type, enabled, capabilities
     ) VALUES (
       'mock-provisioning-v1', 'provisioning', true,
       '["resource_create","resource_reconcile","resource_suspend"]'::jsonb
     )`,
  );

  const group = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/catalog/groups/automation-lab",
    headers: staffHeaders(staff),
    payload: { sortOrder: 50, names: { en: "Automation Laboratory" } },
  });
  assert.equal(group.statusCode, 200, group.body);

  const reviewPriceId = await createProduct({
    productId: "review-policy-product",
    fulfillmentMode: "review",
    staff,
  });

  const deniedRead = await app.inject({
    method: "GET",
    url: "/api/v1/admin/catalog/products/review-policy-product/automation-policy",
    headers: staffHeaders(readOnlyStaff),
  });
  assert.equal(deniedRead.statusCode, 403, deniedRead.body);

  const missingPolicy = await app.inject({
    method: "GET",
    url: "/api/v1/admin/catalog/products/review-policy-product/automation-policy",
    headers: staffHeaders(staff),
  });
  assert.equal(missingPolicy.statusCode, 200, missingPolicy.body);
  assert.deepEqual(
    {
      configured: json<{ configured: boolean }>(missingPolicy).configured,
      automationMode: json<{ automationMode: string }>(missingPolicy).automationMode,
      providerInstallationId:
        json<{ providerInstallationId: string | null }>(missingPolicy)
          .providerInstallationId,
      policyVersion: json<{ policyVersion: number | null }>(missingPolicy).policyVersion,
    },
    {
      configured: false,
      automationMode: "manual",
      providerInstallationId: null,
      policyVersion: null,
    },
  );

  const missingExpectedVersion = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/catalog/products/review-policy-product/automation-policy",
    headers: staffHeaders(staff),
    payload: {
      automationMode: "provider",
      providerInstallationId: "mock-provisioning-v1",
    },
  });
  assert.equal(missingExpectedVersion.statusCode, 400, missingExpectedVersion.body);
  const stillMissingAfterRejectedWrite = await pool.query(
    `SELECT product_id
     FROM product_service_automation_policies
     WHERE product_id = 'review-policy-product'`,
  );
  assert.equal(stillMissingAfterRejectedWrite.rowCount, 0);

  const configured = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/catalog/products/review-policy-product/automation-policy",
    headers: staffHeaders(staff),
    payload: {
      automationMode: "provider",
      providerInstallationId: "mock-provisioning-v1",
      expectedVersion: null,
    },
  });
  assert.equal(configured.statusCode, 200, configured.body);
  const configuredBody = json<{
    changed: boolean;
    policyVersion: number;
    providerReady: boolean;
    providerVersion: number;
    capabilitySnapshot: string[];
    requiredCapabilities: string[];
    missingCapabilities: string[];
  }>(configured);
  assert.equal(configuredBody.changed, true);
  assert.equal(configuredBody.policyVersion, 1);
  assert.equal(configuredBody.providerReady, true);
  assert.equal(configuredBody.providerVersion, 1);
  assert.deepEqual(configuredBody.capabilitySnapshot, [
    "resource_create",
    "resource_reconcile",
    "resource_suspend",
  ]);
  assert.deepEqual(configuredBody.requiredCapabilities, [
    "resource_create",
    "resource_reconcile",
  ]);
  assert.deepEqual(configuredBody.missingCapabilities, []);

  const reviewCheckout = await checkout(reviewPriceId, customer);
  assert.equal(reviewCheckout.statusCode, 201, reviewCheckout.body);
  const reviewOrder = json<{
    orderId: string;
    serviceId: string;
    orderStatus: string;
  }>(reviewCheckout);
  assert.equal(reviewOrder.orderStatus, "awaiting_manual");

  const bindingBefore = await pool.query<{
    provider_installation_id: string | null;
    overdue_action_snapshot: string;
    capability_snapshot: unknown;
    product_policy_version: number;
  }>(
    `SELECT provider_installation_id, overdue_action_snapshot,
            capability_snapshot, product_policy_version
     FROM service_provider_bindings
     WHERE service_id = $1`,
    [reviewOrder.serviceId],
  );
  assert.deepEqual(bindingBefore.rows[0], {
    provider_installation_id: "mock-provisioning-v1",
    overdue_action_snapshot: "manual",
    capability_snapshot: [
      "resource_create",
      "resource_reconcile",
      "resource_suspend",
    ],
    product_policy_version: 1,
  });

  const pendingV1Checkout = await checkout(reviewPriceId, customer);
  assert.equal(pendingV1Checkout.statusCode, 201, pendingV1Checkout.body);
  const pendingV1ServiceId = json<{ serviceId: string }>(pendingV1Checkout).serviceId;

  const approvalPayload = {
    reason: "Synthetic Staff reviewed this normal fulfillment request",
  };
  const approved = await app.inject({
    method: "POST",
    url: `/api/v1/admin/services/${reviewOrder.serviceId}/complete-manual`,
    headers: staffHeaders(staff),
    payload: approvalPayload,
  });
  assert.equal(approved.statusCode, 200, approved.body);
  const approvedBody = json<{
    providerOperationId: string;
    jobId: string;
    replayed: boolean;
  }>(approved);
  assert.equal(approvedBody.replayed, false);
  const replayedApproval = await app.inject({
    method: "POST",
    url: `/api/v1/admin/services/${reviewOrder.serviceId}/complete-manual`,
    headers: staffHeaders(staff),
    payload: approvalPayload,
  });
  assert.equal(replayedApproval.statusCode, 200, replayedApproval.body);
  const replayedBody = json<typeof approvedBody>(replayedApproval);
  assert.equal(replayedBody.replayed, true);
  assert.equal(replayedBody.providerOperationId, approvedBody.providerOperationId);
  assert.equal(replayedBody.jobId, approvedBody.jobId);
  const queueCount = await pool.query<{ operations: string; jobs: string }>(
    `SELECT
       (SELECT pg_catalog.count(*)::text
        FROM provider_operations
        WHERE subject_id = $1::uuid AND kind = 'resource_create') AS operations,
       (SELECT pg_catalog.count(*)::text
        FROM durable_jobs
        WHERE job_type = 'provision.start'
          AND payload->>'serviceId' = $1::text) AS jobs`,
    [reviewOrder.serviceId],
  );
  assert.deepEqual(queueCount.rows[0], { operations: "1", jobs: "1" });

  const switchedToManual = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/catalog/products/review-policy-product/automation-policy",
    headers: staffHeaders(staff),
    payload: {
      automationMode: "manual",
      providerInstallationId: null,
      expectedVersion: 1,
    },
  });
  assert.equal(switchedToManual.statusCode, 200, switchedToManual.body);
  assert.deepEqual(
    {
      changed: json<{ changed: boolean }>(switchedToManual).changed,
      automationMode: json<{ automationMode: string }>(switchedToManual).automationMode,
      providerInstallationId:
        json<{ providerInstallationId: string | null }>(switchedToManual)
          .providerInstallationId,
      policyVersion:
        json<{ policyVersion: number }>(switchedToManual).policyVersion,
      capabilitySnapshot:
        json<{ capabilitySnapshot: string[] }>(switchedToManual).capabilitySnapshot,
    },
    {
      changed: true,
      automationMode: "manual",
      providerInstallationId: null,
      policyVersion: 2,
      capabilitySnapshot: [],
    },
  );
  const bindingAfter = await pool.query<{
    provider_installation_id: string | null;
    overdue_action_snapshot: string;
    capability_snapshot: unknown;
    product_policy_version: number;
  }>(
    `SELECT provider_installation_id, overdue_action_snapshot,
            capability_snapshot, product_policy_version
     FROM service_provider_bindings
     WHERE service_id = $1`,
    [reviewOrder.serviceId],
  );
  assert.deepEqual(bindingAfter.rows[0], bindingBefore.rows[0]);

  const oldBindingApprovedAfterV2 = await app.inject({
    method: "POST",
    url: `/api/v1/admin/services/${pendingV1ServiceId}/complete-manual`,
    headers: staffHeaders(staff),
    payload: approvalPayload,
  });
  assert.equal(oldBindingApprovedAfterV2.statusCode, 200, oldBindingApprovedAfterV2.body);
  assert.equal(
    json<{ fulfillment: string }>(oldBindingApprovedAfterV2).fulfillment,
    "provider_queued",
  );
  const oldBindingAfterV2 = await pool.query<{
    provider_installation_id: string | null;
    product_policy_version: number;
    operations: string;
    jobs: string;
  }>(
    `SELECT binding.provider_installation_id,
            binding.product_policy_version,
            (SELECT pg_catalog.count(*)::text FROM provider_operations operation
             WHERE operation.subject_id = binding.service_id) AS operations,
            (SELECT pg_catalog.count(*)::text FROM durable_jobs job
             WHERE job.payload->>'serviceId' = binding.service_id::text) AS jobs
     FROM service_provider_bindings binding
     WHERE binding.service_id = $1`,
    [pendingV1ServiceId],
  );
  assert.deepEqual(oldBindingAfterV2.rows[0], {
    provider_installation_id: "mock-provisioning-v1",
    product_policy_version: 1,
    operations: "1",
    jobs: "1",
  });

  const noChange = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/catalog/products/review-policy-product/automation-policy",
    headers: staffHeaders(staff),
    payload: {
      automationMode: "manual",
      providerInstallationId: null,
      expectedVersion: 2,
    },
  });
  assert.equal(noChange.statusCode, 200, noChange.body);
  assert.equal(json<{ changed: boolean }>(noChange).changed, false);
  assert.equal(json<{ policyVersion: number }>(noChange).policyVersion, 2);

  const manualReviewCheckout = await checkout(reviewPriceId, customer);
  assert.equal(manualReviewCheckout.statusCode, 201, manualReviewCheckout.body);
  const manualReview = json<{
    serviceId: string;
    orderStatus: string;
  }>(manualReviewCheckout);
  assert.equal(manualReview.orderStatus, "awaiting_manual");
  const manualReviewCompleted = await app.inject({
    method: "POST",
    url: `/api/v1/admin/services/${manualReview.serviceId}/complete-manual`,
    headers: staffHeaders(staff),
    payload: approvalPayload,
  });
  assert.equal(manualReviewCompleted.statusCode, 200, manualReviewCompleted.body);
  assert.deepEqual(
    {
      status: json<{ status: string }>(manualReviewCompleted).status,
      fulfillment: json<{ fulfillment: string }>(manualReviewCompleted).fulfillment,
    },
    { status: "active", fulfillment: "manual_ready" },
  );
  const manualReviewSideEffects = await pool.query<{ operations: string; jobs: string }>(
    `SELECT
       (SELECT pg_catalog.count(*)::text FROM provider_operations operation
        WHERE operation.subject_id = $1::uuid) AS operations,
       (SELECT pg_catalog.count(*)::text FROM durable_jobs job
        WHERE job.payload->>'serviceId' = $1::text) AS jobs`,
    [manualReview.serviceId],
  );
  assert.deepEqual(manualReviewSideEffects.rows[0], { operations: "0", jobs: "0" });

  const manualAutomaticPriceId = await createProduct({
    productId: "automatic-manual-product",
    fulfillmentMode: "automatic",
    staff,
  });
  const manualAutomaticPolicy = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/catalog/products/automatic-manual-product/automation-policy",
    headers: staffHeaders(staff),
    payload: {
      automationMode: "manual",
      providerInstallationId: null,
      expectedVersion: null,
    },
  });
  assert.equal(manualAutomaticPolicy.statusCode, 200, manualAutomaticPolicy.body);
  const manualAutomaticCheckout = await checkout(manualAutomaticPriceId, customer);
  assert.equal(manualAutomaticCheckout.statusCode, 201, manualAutomaticCheckout.body);
  const manualAutomatic = json<{ serviceId: string; orderStatus: string }>(
    manualAutomaticCheckout,
  );
  assert.equal(manualAutomatic.orderStatus, "awaiting_manual");
  const manualAutomaticCompleted = await app.inject({
    method: "POST",
    url: `/api/v1/admin/services/${manualAutomatic.serviceId}/complete-manual`,
    headers: staffHeaders(staff),
    payload: approvalPayload,
  });
  assert.equal(manualAutomaticCompleted.statusCode, 200, manualAutomaticCompleted.body);
  assert.equal(
    json<{ fulfillment: string }>(manualAutomaticCompleted).fulfillment,
    "manual_ready",
  );
  const manualAutomaticSideEffects = await pool.query<{ operations: string; jobs: string }>(
    `SELECT
       (SELECT pg_catalog.count(*)::text FROM provider_operations operation
        WHERE operation.subject_id = $1::uuid) AS operations,
       (SELECT pg_catalog.count(*)::text FROM durable_jobs job
        WHERE job.payload->>'serviceId' = $1::text) AS jobs`,
    [manualAutomatic.serviceId],
  );
  assert.deepEqual(manualAutomaticSideEffects.rows[0], { operations: "0", jobs: "0" });

  const staleWrite = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/catalog/products/review-policy-product/automation-policy",
    headers: staffHeaders(staff),
    payload: {
      automationMode: "provider",
      providerInstallationId: "mock-provisioning-v1",
      expectedVersion: 1,
    },
  });
  assert.equal(staleWrite.statusCode, 409, staleWrite.body);
  assert.equal(
    json<{ code: string }>(staleWrite).code,
    "AUTOMATION_POLICY_VERSION_CONFLICT",
  );
  const afterStaleWrite = await pool.query<{
    provider_installation_id: string | null;
    version: number;
  }>(
    `SELECT provider_installation_id, version
     FROM product_service_automation_policies
     WHERE product_id = 'review-policy-product'`,
  );
  assert.deepEqual(afterStaleWrite.rows[0], {
    provider_installation_id: null,
    version: 2,
  });

  const missingReviewPriceId = await createProduct({
    productId: "review-policy-missing",
    fulfillmentMode: "review",
    staff,
  });
  const missingReviewCheckout = await checkout(missingReviewPriceId, customer);
  assert.equal(missingReviewCheckout.statusCode, 409, missingReviewCheckout.body);
  assert.equal(
    json<{ code: string }>(missingReviewCheckout).code,
    "SUPPLY_PREFLIGHT_FAILED",
  );

  const disabledAutomaticPriceId = await createProduct({
    productId: "automatic-provider-disabled",
    fulfillmentMode: "automatic",
    staff,
  });
  const configuredAutomatic = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/catalog/products/automatic-provider-disabled/automation-policy",
    headers: staffHeaders(staff),
    payload: {
      automationMode: "provider",
      providerInstallationId: "mock-provisioning-v1",
      expectedVersion: null,
    },
  });
  assert.equal(configuredAutomatic.statusCode, 200, configuredAutomatic.body);
  await pool.query(
    `UPDATE provider_installation_capabilities
     SET enabled = false, version = version + 1, updated_at = pg_catalog.clock_timestamp()
     WHERE provider_installation_id = 'mock-provisioning-v1'`,
  );
  const disabledSave = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/catalog/products/automatic-provider-disabled/automation-policy",
    headers: staffHeaders(staff),
    payload: {
      automationMode: "provider",
      providerInstallationId: "mock-provisioning-v1",
      expectedVersion: 1,
    },
  });
  assert.equal(disabledSave.statusCode, 409, disabledSave.body);
  assert.equal(
    json<{ code: string }>(disabledSave).code,
    "PROVISIONING_PROVIDER_UNAVAILABLE",
  );
  const disabledCheckout = await checkout(disabledAutomaticPriceId, customer);
  assert.equal(disabledCheckout.statusCode, 409, disabledCheckout.body);
  assert.equal(
    json<{ code: string }>(disabledCheckout).code,
    "SUPPLY_PREFLIGHT_FAILED",
  );

  const auditFacts = await pool.query<{ count: string }>(
    `SELECT pg_catalog.count(*)::text AS count
     FROM audit_events
     WHERE action = 'catalog.product_automation_policy_updated'
       AND target_type = 'product'`,
  );
  assert.equal(auditFacts.rows[0]?.count, "4");

  console.log(
    "Catalog automation policy PostgreSQL 18 integration: PASS — Staff configures Review/Automatic products with the enabled Mock Provisioning Provider or explicit manual mode; policy and Provider versions/capability snapshot are returned; missing expectedVersion is 400 and a stale exact version is 409 without mutation; Review approval replays the same operation/job; missing or disabled policy returns a normal 409; v1 Service bindings still approve after the Product moves to v2 manual policy.",
  );
} finally {
  await app?.close().catch(() => undefined);
  app = null;
  await pool?.end().catch(() => undefined);
  pool = null;
  if (adminConnected) {
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
    adminConnected = false;
  } else {
    await admin.end().catch(() => undefined);
  }
}
