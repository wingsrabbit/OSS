// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import pg from "pg";
import { assertSchema020CatalogShape } from "@opensales/core/schema-019-020-native-compatibility";
import { assertSchema021CatalogShape } from "@opensales/core/schema-020-021-native-compatibility";
import { assertSchema022CatalogShape } from "@opensales/core/schema-021-022-native-compatibility";
import { digestToken } from "./auth.js";
import { requestFingerprint } from "./idempotency.js";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { runMigrations, transaction, type DatabasePool } from "./database.js";
import { registerCatalogRoutes } from "./routes-catalog.js";
import { registerCommerceRoutes } from "./routes-commerce.js";
import { registerOrderRoutes } from "./routes-orders.js";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) {
  throw new Error("ADMIN_DATABASE_URL is required for Catalog Commerce integration");
}

const databaseName = `oss_catalog_commerce_${randomUUID().replaceAll("-", "")}`;
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
  SESSION_COOKIE_NAME: "oss_catalog_commerce_session",
  SESSION_TTL_HOURS: 24,
  VERIFICATION_TTL_MINUTES: 30,
  WEB_ORIGIN: "http://127.0.0.1:5173",
  MOCK_MAILBOX_URL: "http://127.0.0.1:4000",
  LAB_MAILBOX_TOKEN: "synthetic-catalog-commerce-mailbox-token",
  PROVIDER_OPERATION_CAPABILITY_SECRET:
    "synthetic-catalog-commerce-provider-operation-secret",
  PAYMENT_METHOD_TOKEN_KEY: Buffer.alloc(32, 111).toString("base64url"),
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY: Buffer.alloc(32, 112).toString("base64url"),
  IDENTITY_SECRET_KEY: Buffer.alloc(32, 113).toString("base64url"),
  MOCK_PAYMENT_WEBHOOK_SECRET: "synthetic-catalog-commerce-payment-secret",
  MOCK_PROVISIONING_WEBHOOK_SECRET:
    "synthetic-catalog-commerce-provisioning-secret",
  LAB_MAILBOX_ENABLED: false,
};

type Identity = Readonly<{
  userId: string;
  accountId: string | null;
  token: string;
  cookie: string;
}>;

function json<T>(response: Readonly<{ body: string }>): T {
  return JSON.parse(response.body) as T;
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
      [accountId, `${label} account`, userId],
    );
    await client.query(
      `INSERT INTO client_memberships(
         client_account_id, user_id, role, permissions
       ) VALUES ($1, $2, 'owner', '["*"]'::jsonb)`,
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
    accountId,
    token,
    cookie: `${config.SESSION_COOKIE_NAME}=${token}`,
  };
}

async function createStaff(
  label: string,
  permissions: readonly string[],
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
  });
  return {
    userId,
    accountId: null,
    token,
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

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  pool = new pg.Pool({
    connectionString: databaseUrl.toString(),
    max: 16,
    options: "-c search_path=pg_catalog,public",
    statement_timeout: 15_000,
    application_name: "opensales-catalog-commerce-integration",
  });
  await runMigrations(pool, {
    throughVersion: "019_stage_c_account_context_memberships_contacts",
  });
  const legacyPriceId = randomUUID();
  await pool.query(
    `INSERT INTO product_groups(id, sort_order, names)
     VALUES ('legacy-commerce', 1, '{"en":"Legacy Commerce"}'::jsonb)`,
  );
  await pool.query(
    `INSERT INTO products(
       id, group_id, names, descriptions, fulfillment_mode,
       active, hidden, repeatable, option_schema
     ) VALUES (
       'legacy-commerce-product', 'legacy-commerce',
       '{"en":"Legacy Product"}'::jsonb,
       '{"en":"Pre-Schema-020 saved Product"}'::jsonb,
       'manual', true, false, false, '[]'::jsonb
     )`,
  );
  await pool.query(
    `INSERT INTO product_prices(
       id, product_id, revision, currency, billing_cycle,
       one_time_minor, setup_minor, recurring_minor
     ) VALUES ($1, 'legacy-commerce-product', 1, 'USD', 'monthly', 0, 0, 1234)`,
    [legacyPriceId],
  );
  await runMigrations(pool, { throughVersion: "020_stage_c_catalog_commerce" });
  const upgradedLegacy = await pool.query<{
    revision_count: string;
    catalog_product_revision_id: string | null;
    recurring_minor: string;
  }>(
    `SELECT
       (SELECT pg_catalog.count(*)::text
        FROM catalog_product_revisions
        WHERE product_id = 'legacy-commerce-product') AS revision_count,
       price.catalog_product_revision_id,
       price.recurring_minor::text
     FROM product_prices price
     WHERE price.id = $1`,
    [legacyPriceId],
  );
  assert.equal(upgradedLegacy.rows[0]?.revision_count, "1");
  assert.ok(upgradedLegacy.rows[0]?.catalog_product_revision_id);
  assert.equal(upgradedLegacy.rows[0]?.recurring_minor, "1234");

  const savedCustomerUserId = randomUUID();
  const savedStaffUserId = randomUUID();
  const savedAccountId = randomUUID();
  const savedOrderId = randomUUID();
  const savedOrderItemId = randomUUID();
  const savedServiceId = randomUUID();
  await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO users(id, email, password_hash, locale, email_verified_at)
       VALUES
         ($1, $2, 'synthetic-not-a-password', 'en', pg_catalog.now()),
         ($3, $4, 'synthetic-not-a-password', 'en', pg_catalog.now())`,
      [
        savedCustomerUserId,
        `saved-customer-${databaseName}@example.invalid`,
        savedStaffUserId,
        `saved-staff-${databaseName}@example.invalid`,
      ],
    );
    await client.query(
      `INSERT INTO client_accounts(id, name, owner_user_id)
       VALUES ($1, 'Saved Schema 020 account', $2)`,
      [savedAccountId, savedCustomerUserId],
    );
    await client.query(
      `INSERT INTO client_memberships(
         client_account_id, user_id, role, permissions
       ) VALUES ($1, $2, 'owner', '["*"]'::jsonb)`,
      [savedAccountId, savedCustomerUserId],
    );
    await client.query(
      `INSERT INTO staff_members(user_id, roles, permissions)
       VALUES ($1, ARRAY['operations']::text[], '["catalog.supply.manage"]'::jsonb)`,
      [savedStaffUserId],
    );
    await client.query(
      `INSERT INTO product_supply_capacities(
         product_id, mode, available_units, committed_units,
         updated_by_staff_user_id
       ) VALUES ('legacy-commerce-product', 'tracked', 10, 2, $1)`,
      [savedStaffUserId],
    );
    await client.query(
      `INSERT INTO orders(
         id, client_account_id, submitted_by_user_id, status, currency,
         price_snapshot, one_time_minor, setup_minor, recurring_minor,
         total_minor, idempotency_key, request_fingerprint
       ) VALUES (
         $1, $2, $3, 'cancelled', 'USD', '{}'::jsonb,
         0, 0, 1234, 1234, $4, $5
       )`,
      [
        savedOrderId,
        savedAccountId,
        savedCustomerUserId,
        `saved-order-${randomUUID()}`,
        `saved-order-fingerprint-${randomUUID()}`,
      ],
    );
    await client.query(
      `INSERT INTO order_items(
         id, order_id, client_account_id, product_id, product_name,
         fulfillment_mode, billing_cycle, configuration, price_snapshot
       ) VALUES (
         $1, $2, $3, 'legacy-commerce-product', 'Legacy Product',
         'manual', 'monthly', '{}'::jsonb, '{}'::jsonb
       )`,
      [savedOrderItemId, savedOrderId, savedAccountId],
    );
    await client.query(
      `INSERT INTO services(
         id, client_account_id, order_item_id, status, billing_cycle
       ) VALUES ($1, $2, $3, 'pending', 'monthly')`,
      [savedServiceId, savedAccountId, savedOrderItemId],
    );
    await client.query(
      `INSERT INTO supply_capacity_reservations(
         client_account_id, product_id, order_id, units, capacity_snapshot
       ) VALUES ($1, 'legacy-commerce-product', $2, 2, '{}'::jsonb)`,
      [savedAccountId, savedOrderId],
    );
  });
  await runMigrations(pool);
  const nativeQueryable = {
    query: async (text: string, values?: unknown[]) => pool!.query(text, values),
  };
  await assertSchema020CatalogShape(nativeQueryable, {
    allowSchema022CommerceExtensions: true,
  });
  await assertSchema021CatalogShape(nativeQueryable);
  await assertSchema022CatalogShape(nativeQueryable);

  const catalogTamperClient = await pool.connect();
  try {
    for (const statement of [
      `CREATE OR REPLACE FUNCTION public.opensales_validate_supply_capacity_projection()
       RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public
       AS 'BEGIN RETURN NULL; END'`,
      "DROP TRIGGER orders_release_supply_on_terminal ON public.orders",
      "ALTER TABLE public.product_prices DROP CONSTRAINT product_prices_valid_interval_check",
      "DROP INDEX public.supply_capacity_reservations_product_idx",
    ]) {
      await catalogTamperClient.query("BEGIN");
      try {
        await catalogTamperClient.query(statement);
        await assert.rejects(
          assertSchema022CatalogShape({
            query: async (text, values) => catalogTamperClient.query(text, values),
          }),
          /Schema 022 is incomplete or counterfeit/,
        );
      } finally {
        await catalogTamperClient.query("ROLLBACK");
      }
    }
  } finally {
    catalogTamperClient.release();
  }
  const forwardUpgrade = await pool.query<{
    committed: string;
    releases: string;
    reason: string;
  }>(
    `SELECT
       capacity.committed_units::text AS committed,
       pg_catalog.count(release_fact.id)::text AS releases,
       pg_catalog.min(release_fact.reason) AS reason
     FROM product_supply_capacities capacity
     LEFT JOIN supply_capacity_releases release_fact
       ON release_fact.product_id = capacity.product_id
     WHERE capacity.product_id = 'legacy-commerce-product'
     GROUP BY capacity.committed_units`,
  );
  assert.deepEqual(forwardUpgrade.rows[0], {
    committed: "0",
    releases: "1",
    reason: "order_cancelled",
  });

  app = Fastify({ logger: false });
  await app.register(cookie);
  app.setErrorHandler((
    error: FastifyError,
    _request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    return reply.code(statusCode).send({
      error: error instanceof Error ? error.message : "Request failed",
      ...(code ? { code } : {}),
    });
  });
  await registerCatalogRoutes(app, pool, config);
  await registerCommerceRoutes(app, pool, config);
  await registerOrderRoutes(app, pool, config);

  const staff = await createStaff("commerce-staff", [
    "catalog.read",
    "catalog.manage",
    "catalog.pricing.manage",
    "catalog.supply.manage",
    "catalog.promotions.read",
    "catalog.promotions.manage",
    "quotes.read",
    "quotes.manage",
  ]);
  const readonlyStaff = await createStaff("commerce-readonly", [
    "catalog.read",
    "catalog.promotions.read",
    "quotes.read",
  ]);
  const customerA = await createCustomer("commerce-a");
  const customerB = await createCustomer("commerce-b");

  const deniedProduct = await app.inject({
    method: "POST",
    url: "/api/v1/admin/catalog/products",
    headers: staffHeaders(readonlyStaff),
    payload: {
      id: "denied-product",
      groupId: "laboratory",
      names: { en: "Denied" },
      descriptions: { en: "Must not exist" },
      fulfillmentMode: "manual",
      optionSchema: [],
    },
  });
  assert.equal(deniedProduct.statusCode, 403, deniedProduct.body);

  const group = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/catalog/groups/laboratory",
    headers: staffHeaders(staff),
    payload: { sortOrder: 10, names: { en: "Laboratory" } },
  });
  assert.equal(group.statusCode, 200, group.body);

  const product = await app.inject({
    method: "POST",
    url: "/api/v1/admin/catalog/products",
    headers: staffHeaders(staff),
    payload: {
      id: "mock-capacity-service",
      groupId: "laboratory",
      names: { en: "Mock Capacity Service" },
      descriptions: { en: "Synthetic capacity-bound manual service." },
      fulfillmentMode: "manual",
      optionSchema: [
        {
          code: "tier",
          type: "radio",
          required: true,
          values: [
            "basic",
            { value: "plus", recurringMinor: 25, capacityUnits: 1 },
          ],
        },
        {
          code: "units",
          type: "quantity",
          required: true,
          min: 1,
          max: 4,
          step: 1,
          recurringUnitMinor: 25,
          capacityUnitsPerUnit: 1,
        },
        {
          code: "private_note",
          type: "secret",
          required: true,
          visibleWhen: { code: "tier", equals: "plus" },
        },
      ],
    },
  });
  assert.equal(product.statusCode, 201, product.body);
  const productBody = json<{
    productId: string;
    productRevisionId: string;
  }>(product);

  const supply = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/catalog/products/mock-capacity-service/supply",
    headers: staffHeaders(staff),
    payload: { mode: "tracked", availableUnits: "10" },
  });
  assert.equal(supply.statusCode, 200, supply.body);

  const projectionClient = new pg.Client({ connectionString: databaseUrl.toString() });
  await projectionClient.connect();
  try {
    await projectionClient.query("BEGIN");
    await projectionClient.query(
      `UPDATE product_supply_capacities
       SET committed_units = 1
       WHERE product_id = 'mock-capacity-service'`,
    );
    await assert.rejects(
      projectionClient.query("COMMIT"),
      /expected 0 from active Reservations/,
      "direct SQL must not commit a drifted supply projection",
    );
  } finally {
    await projectionClient.query("ROLLBACK").catch(() => undefined);
    await projectionClient.end();
  }

  const price = await app.inject({
    method: "POST",
    url: "/api/v1/admin/catalog/products/mock-capacity-service/prices",
    headers: staffHeaders(staff),
    payload: {
      billingCycle: "monthly",
      currency: "USD",
      oneTimeMinor: "0",
      setupMinor: "0",
      recurringMinor: "100",
    },
  });
  assert.equal(price.statusCode, 201, price.body);
  const priceBody = json<{ priceId: string; revision: number }>(price);
  assert.equal(priceBody.revision, 1);

  const promotion = await app.inject({
    method: "POST",
    url: "/api/v1/admin/promotions",
    headers: staffHeaders(staff),
    payload: {
      code: "LABFREE",
      name: "One synthetic zero-order Promotion",
      productId: "mock-capacity-service",
      billingCycle: "monthly",
      discountKind: "percentage",
      applicationScope: "all",
      percentageBasisPoints: 10_000,
      maximumRedemptions: "1",
    },
  });
  assert.equal(promotion.statusCode, 201, promotion.body);

  await assert.rejects(
    pool.query(
      `INSERT INTO product_prices(
         product_id, catalog_product_revision_id, revision, currency,
         billing_cycle, one_time_minor, setup_minor, recurring_minor,
         active, valid_from
       ) VALUES ($1, $2, 999999, 'USD', 'monthly', 0, 0, 101,
                 false, pg_catalog.clock_timestamp() + interval '1 minute')`,
      [productBody.productId, productBody.productRevisionId],
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "23P01");
      return true;
    },
    "direct SQL must not create an overlapping active Product price interval",
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO promotions(
         code, revision, name, product_id, billing_cycle,
         discount_kind, application_scope, percentage_basis_points,
         active, valid_from, maximum_redemptions, created_by_staff_user_id
       ) VALUES (
         'LABFREE', 999999, 'Forbidden overlapping Promotion',
         'mock-capacity-service', 'monthly', 'percentage', 'all', 10000,
         false, pg_catalog.clock_timestamp() + interval '1 minute', 1, $1
       )`,
      [staff.userId],
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "23P01");
      return true;
    },
    "direct SQL must not create an overlapping active Promotion interval",
  );

  const preview = await app.inject({
    method: "POST",
    url: "/api/v1/catalog/preview",
    headers: customerHeaders(customerA),
    payload: {
      priceId: priceBody.priceId,
      configuration: {
        tier: "plus",
        units: 2,
        private_note: "must-never-persist",
      },
      promotionCode: "LABFREE",
    },
  });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.body.includes("must-never-persist"), false);
  assert.equal(
    json<{ price: { invoiceTotalMinor: string } }>(preview).price.invoiceTotalMinor,
    "0",
  );

  const checkoutPayload = {
    priceId: priceBody.priceId,
    configuration: {
      tier: "plus",
      units: 2,
      private_note: "must-never-persist",
    },
    promotionCode: "LABFREE",
    termsVersion: "mock-lab-v1",
    aupVersion: "mock-lab-v1",
    marketingConsent: true,
    marketingConsentPolicyVersion: "mock-lab-marketing-v1",
    idempotencyKey: `checkout-${randomUUID()}`,
  };
  const checkoutPayloadB = {
    ...checkoutPayload,
    idempotencyKey: `checkout-${randomUUID()}`,
  };
  const [checkoutA, checkoutB] = await Promise.all([
    app.inject({
      method: "POST",
      url: "/api/v1/orders",
      headers: customerHeaders(customerA),
      payload: checkoutPayload,
    }),
    app.inject({
      method: "POST",
      url: "/api/v1/orders",
      headers: customerHeaders(customerB),
      payload: checkoutPayloadB,
    }),
  ]);
  const successes = [checkoutA, checkoutB].filter((response) => response.statusCode === 201);
  const exhausted = [checkoutA, checkoutB].filter((response) => response.statusCode === 409);
  assert.equal(successes.length, 1, `${checkoutA.body}\n${checkoutB.body}`);
  assert.equal(exhausted.length, 1, `${checkoutA.body}\n${checkoutB.body}`);
  assert.equal(json<{ code: string }>(exhausted[0]!).code, "PROMOTION_EXHAUSTED");
  const winningIdentity = checkoutA.statusCode === 201 ? customerA : customerB;
  const winningPayload = checkoutA.statusCode === 201 ? checkoutPayload : checkoutPayloadB;
  const winner = successes[0]!;
  const winningOrder = json<{
    orderId: string;
    invoiceId: string;
    serviceId: string;
    orderStatus: string;
  }>(winner);
  assert.equal(winningOrder.orderStatus, "awaiting_manual");

  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/orders",
    headers: customerHeaders(winningIdentity),
    payload: winningPayload,
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(json<{ orderId: string }>(replay).orderId, winningOrder.orderId);
  const savedOrderFingerprint = await pool.query<{ request_fingerprint: string }>(
    `SELECT request_fingerprint FROM public.orders WHERE id = $1`,
    [winningOrder.orderId],
  );
  assert.equal(
    savedOrderFingerprint.rows[0]?.request_fingerprint,
    requestFingerprint("orders.create:v2", {
      priceId: winningPayload.priceId,
      configuration: winningPayload.configuration,
      termsVersion: winningPayload.termsVersion,
      aupVersion: winningPayload.aupVersion,
      promotionCode: winningPayload.promotionCode,
      marketingConsent: winningPayload.marketingConsent,
      marketingConsentPolicyVersion: winningPayload.marketingConsentPolicyVersion,
    }),
    "Schema 025 must replay a saved Schema 022 Order with its unchanged v2 fingerprint",
  );

  const commercialFacts = await pool.query<{
    promotions: string;
    reservations: string;
    committed: string;
    orders: string;
    invoices: string;
    services: string;
    legal_acceptances: string;
    unsealed: string;
  }>(
    `SELECT
       (SELECT pg_catalog.count(*)::text FROM promotion_redemptions) AS promotions,
       (SELECT pg_catalog.count(*)::text
        FROM supply_capacity_reservations
        WHERE product_id = 'mock-capacity-service') AS reservations,
       (SELECT committed_units::text FROM product_supply_capacities
        WHERE product_id = 'mock-capacity-service') AS committed,
       (SELECT pg_catalog.count(DISTINCT item.order_id)::text
        FROM order_items item
        WHERE item.product_id = 'mock-capacity-service') AS orders,
       (SELECT pg_catalog.count(DISTINCT invoice.id)::text
        FROM invoices invoice
        JOIN order_items item ON item.order_id = invoice.order_id
        WHERE item.product_id = 'mock-capacity-service') AS invoices,
       (SELECT pg_catalog.count(service.id)::text
        FROM services service
        JOIN order_items item ON item.id = service.order_item_id
        WHERE item.product_id = 'mock-capacity-service') AS services,
       (SELECT pg_catalog.count(acceptance.legal_acceptance_id)::text
        FROM order_legal_acceptances acceptance
        JOIN order_items item ON item.order_id = acceptance.order_id
        WHERE item.product_id = 'mock-capacity-service') AS legal_acceptances,
       (SELECT pg_catalog.count(*)::text FROM ledger_journals
        WHERE sealed_at IS NULL) AS unsealed`,
  );
  assert.deepEqual(commercialFacts.rows[0], {
    promotions: "1",
    reservations: "1",
    committed: "4",
    orders: "1",
    invoices: "1",
    services: "1",
    legal_acceptances: "2",
    unsealed: "0",
  });

  const consent = await app.inject({
    method: "GET",
    url: "/api/v1/marketing-consent",
    headers: customerHeaders(winningIdentity),
  });
  assert.equal(consent.statusCode, 200, consent.body);
  assert.equal(json<{ granted: boolean }>(consent).granted, true);
  const withdraw = await app.inject({
    method: "POST",
    url: "/api/v1/marketing-consent/withdraw",
    headers: customerHeaders(winningIdentity),
    payload: { idempotencyKey: `withdraw-${randomUUID()}` },
  });
  assert.equal(withdraw.statusCode, 200, withdraw.body);
  const consentAfter = await app.inject({
    method: "GET",
    url: "/api/v1/marketing-consent",
    headers: customerHeaders(winningIdentity),
  });
  assert.equal(json<{ granted: boolean }>(consentAfter).granted, false);

  await pool.query(
    `UPDATE orders
     SET status = 'rejected', updated_at = pg_catalog.clock_timestamp(),
         version = version + 1
     WHERE id = $1`,
    [winningOrder.orderId],
  );
  const releasedRejectedOrder = await pool.query<{
    committed: string;
    releases: string;
    reason: string;
  }>(
    `SELECT
       capacity.committed_units::text AS committed,
       pg_catalog.count(release_fact.id)::text AS releases,
       pg_catalog.min(release_fact.reason) AS reason
     FROM product_supply_capacities capacity
     LEFT JOIN supply_capacity_releases release_fact
       ON release_fact.product_id = capacity.product_id
     WHERE capacity.product_id = 'mock-capacity-service'
     GROUP BY capacity.committed_units`,
  );
  assert.deepEqual(releasedRejectedOrder.rows[0], {
    committed: "0",
    releases: "1",
    reason: "order_rejected",
  });
  await assert.rejects(
    pool.query(
      `UPDATE orders
       SET status = 'waiting_payment', updated_at = pg_catalog.clock_timestamp(),
           version = version + 1
       WHERE id = $1`,
      [winningOrder.orderId],
    ),
    /An Order that released tracked supply cannot leave its terminal state/,
  );

  const revision = await app.inject({
    method: "POST",
    url: "/api/v1/admin/catalog/products/mock-capacity-service/revisions",
    headers: staffHeaders(staff),
    payload: {
      groupId: "laboratory",
      names: { en: "Mock Capacity Service v2" },
      descriptions: { en: "Future Catalog changes preserve prior Order snapshots." },
      fulfillmentMode: "manual",
      active: true,
      hidden: false,
      repeatable: false,
      optionSchema: [
        { code: "units", type: "quantity", required: true, min: 1, max: 2 },
      ],
    },
  });
  assert.equal(revision.statusCode, 201, revision.body);
  const oldPreview = await app.inject({
    method: "POST",
    url: "/api/v1/catalog/preview",
    headers: customerHeaders(customerA),
    payload: {
      priceId: priceBody.priceId,
      configuration: { tier: "plus", units: 2, private_note: "old" },
    },
  });
  assert.equal(oldPreview.statusCode, 409, oldPreview.body);
  const preserved = await pool.query<{ product_name: string; product_revision: string }>(
    `SELECT item.product_name,
            item.price_snapshot ->> 'productRevision' AS product_revision
     FROM order_items item
     WHERE item.order_id = $1`,
    [winningOrder.orderId],
  );
  assert.equal(preserved.rows[0]?.product_name, "Mock Capacity Service");
  assert.equal(preserved.rows[0]?.product_revision, "1");

  const quoteProduct = await app.inject({
    method: "POST",
    url: "/api/v1/admin/catalog/products",
    headers: staffHeaders(staff),
    payload: {
      id: "mock-quote-service",
      groupId: "laboratory",
      names: { en: "Mock Quote Service" },
      descriptions: { en: "Requires explicit Staff price." },
      fulfillmentMode: "quote",
      optionSchema: [
        {
          code: "shape",
          type: "select",
          required: true,
          values: [{ value: "custom", capacityUnits: 1 }],
        },
      ],
    },
  });
  assert.equal(quoteProduct.statusCode, 201, quoteProduct.body);
  const quoteProductBody = json<{ productRevisionId: string }>(quoteProduct);
  const placeholder = await app.inject({
    method: "POST",
    url: "/api/v1/admin/catalog/products/mock-quote-service/prices",
    headers: staffHeaders(staff),
    payload: {
      billingCycle: "monthly",
      currency: "USD",
      oneTimeMinor: "0",
      setupMinor: "0",
      recurringMinor: "0",
    },
  });
  assert.equal(placeholder.statusCode, 201, placeholder.body);
  const placeholderPriceId = json<{ priceId: string }>(placeholder).priceId;
  const fakePriceQuote = await app.inject({
    method: "POST",
    url: "/api/v1/admin/quotes",
    headers: staffHeaders(staff),
    payload: {
      clientAccountId: customerA.accountId,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      idempotencyKey: `fake-quote-${randomUUID()}`,
      pricing: {
        mode: "catalog",
        priceId: placeholderPriceId,
        configuration: { shape: "custom" },
      },
    },
  });
  assert.equal(fakePriceQuote.statusCode, 409, fakePriceQuote.body);
  assert.equal(
    json<{ code: string }>(fakePriceQuote).code,
    "MANUAL_QUOTE_PRICING_REQUIRED",
  );

  const quotePayload = {
    clientAccountId: customerA.accountId,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    idempotencyKey: `manual-quote-${randomUUID()}`,
    pricing: {
      mode: "manual",
      productRevisionId: quoteProductBody.productRevisionId,
      billingCycle: "monthly",
      currency: "USD",
      oneTimeMinor: "250",
      setupMinor: "50",
      recurringMinor: "700",
      configuration: { shape: "custom" },
    },
  } as const;
  const quote = await app.inject({
    method: "POST",
    url: "/api/v1/admin/quotes",
    headers: staffHeaders(staff),
    payload: quotePayload,
  });
  assert.equal(quote.statusCode, 201, quote.body);
  const quoteId = json<{ quoteId: string }>(quote).quoteId;
  const tenantLeak = await app.inject({
    method: "GET",
    url: `/api/v1/quotes/${quoteId}`,
    headers: customerHeaders(customerB),
  });
  assert.equal(tenantLeak.statusCode, 404, tenantLeak.body);
  const acceptancePreview = await app.inject({
    method: "POST",
    url: `/api/v1/quotes/${quoteId}/acceptance-preview`,
    headers: customerHeaders(customerA),
    payload: { termsVersion: "mock-lab-v1", aupVersion: "mock-lab-v1" },
  });
  assert.equal(acceptancePreview.statusCode, 200, acceptancePreview.body);
  assert.equal(
    json<{ acceptance: { invoiceTotalMinor: string } }>(acceptancePreview)
      .acceptance.invoiceTotalMinor,
    "1000",
  );

  const expiryClient = new pg.Client({ connectionString: databaseUrl.toString() });
  await expiryClient.connect();
  try {
    const expiryQuoteId = randomUUID();
    const expiryOrderId = randomUUID();
    const expiryInvoiceId = randomUUID();
    await expiryClient.query("BEGIN");
    await expiryClient.query(
      `INSERT INTO sales_quotes(
         id, client_account_id, created_by_staff_user_id,
         product_id, catalog_product_revision_id, product_price_id,
         product_name, fulfillment_mode, billing_cycle, configuration,
         price_snapshot, promotion_id, promotion_snapshot, capacity_snapshot,
         currency, one_time_minor, setup_minor, recurring_minor, total_minor,
         expires_at, idempotency_key, request_fingerprint, created_at
       )
       SELECT
         $1, client_account_id, created_by_staff_user_id,
         product_id, catalog_product_revision_id, product_price_id,
         product_name, fulfillment_mode, billing_cycle, configuration,
         price_snapshot, promotion_id, promotion_snapshot, capacity_snapshot,
         currency, one_time_minor, setup_minor, recurring_minor, total_minor,
         pg_catalog.clock_timestamp() + interval '250 milliseconds',
         $2, $3, pg_catalog.clock_timestamp()
       FROM sales_quotes
       WHERE id = $4`,
      [
        expiryQuoteId,
        `expiry-clock-${randomUUID()}`,
        `expiry-clock-fingerprint-${randomUUID()}`,
        quoteId,
      ],
    );
    await expiryClient.query(
      `INSERT INTO orders(
         id, client_account_id, submitted_by_user_id, status, currency,
         price_snapshot, one_time_minor, setup_minor, recurring_minor,
         total_minor, idempotency_key, request_fingerprint, source_quote_id
       )
       SELECT $1, quote.client_account_id, $2, 'awaiting_manual', quote.currency,
              quote.price_snapshot, quote.one_time_minor, quote.setup_minor,
              quote.recurring_minor, quote.total_minor, $3, $4, quote.id
       FROM sales_quotes quote
       WHERE quote.id = $5`,
      [
        expiryOrderId,
        customerA.userId,
        `expiry-order-${randomUUID()}`,
        `expiry-order-fingerprint-${randomUUID()}`,
        expiryQuoteId,
      ],
    );
    await expiryClient.query(
      `INSERT INTO invoices(id, client_account_id, order_id, currency, total_minor, due_at)
       SELECT $1, client_account_id, id, currency, total_minor,
              pg_catalog.clock_timestamp() + interval '7 days'
       FROM orders
       WHERE id = $2`,
      [expiryInvoiceId, expiryOrderId],
    );
    await expiryClient.query("SELECT pg_catalog.pg_sleep(0.4)");
    await assert.rejects(
      expiryClient.query(
        `INSERT INTO sales_quote_acceptances(
           quote_id, client_account_id, accepted_by_user_id,
           order_id, invoice_id, terms_document_id, aup_document_id,
           idempotency_key, request_fingerprint
         )
         SELECT $1, $2, $3, $4, $5,
                (SELECT id FROM legal_documents
                 WHERE kind = 'terms' AND locale = 'en' AND version = 'mock-lab-v1'),
                (SELECT id FROM legal_documents
                 WHERE kind = 'aup' AND locale = 'en' AND version = 'mock-lab-v1'),
                $6, $7`,
        [
          expiryQuoteId,
          customerA.accountId,
          customerA.userId,
          expiryOrderId,
          expiryInvoiceId,
          `expiry-accept-${randomUUID()}`,
          `expiry-accept-fingerprint-${randomUUID()}`,
        ],
      ),
      /Expired Quotes cannot be accepted/,
      "Quote expiry must use the wall clock, not the transaction start",
    );
  } finally {
    await expiryClient.query("ROLLBACK").catch(() => undefined);
    await expiryClient.end();
  }

  const currentPrice = await app.inject({
    method: "POST",
    url: "/api/v1/admin/catalog/products/mock-capacity-service/prices",
    headers: staffHeaders(staff),
    payload: {
      billingCycle: "monthly",
      currency: "USD",
      oneTimeMinor: "0",
      setupMinor: "0",
      recurringMinor: "100",
    },
  });
  assert.equal(currentPrice.statusCode, 201, currentPrice.body);
  const currentPriceId = json<{ priceId: string }>(currentPrice).priceId;
  const preemptingCheckout = await app.inject({
    method: "POST",
    url: "/api/v1/orders",
    headers: customerHeaders(customerA),
    payload: {
      priceId: currentPriceId,
      configuration: { units: 1 },
      termsVersion: "mock-lab-v1",
      aupVersion: "mock-lab-v1",
      idempotencyKey: `quote:${quoteId}`,
    },
  });
  assert.equal(preemptingCheckout.statusCode, 201, preemptingCheckout.body);
  const preemptingOrder = json<{ orderId: string; serviceId: string }>(
    preemptingCheckout,
  );

  await Promise.all([
    pool.query(
      `UPDATE orders
       SET status = 'cancelled', updated_at = pg_catalog.clock_timestamp(),
           version = version + 1
       WHERE id = $1`,
      [preemptingOrder.orderId],
    ),
    pool.query(
      `UPDATE services
       SET status = 'terminated', updated_at = pg_catalog.clock_timestamp(),
           version = version + 1
       WHERE id = $1`,
      [preemptingOrder.serviceId],
    ),
  ]);
  const racedRelease = await pool.query<{
    committed: string;
    releases: string;
  }>(
    `SELECT
       capacity.committed_units::text AS committed,
       pg_catalog.count(release_fact.id)::text AS releases
     FROM product_supply_capacities capacity
     LEFT JOIN supply_capacity_releases release_fact
       ON release_fact.product_id = capacity.product_id
     WHERE capacity.product_id = 'mock-capacity-service'
     GROUP BY capacity.committed_units`,
  );
  assert.deepEqual(racedRelease.rows[0], { committed: "0", releases: "2" });
  await assert.rejects(
    pool.query(
      `UPDATE services
       SET status = 'active', updated_at = pg_catalog.clock_timestamp(),
           version = version + 1
       WHERE id = $1`,
      [preemptingOrder.serviceId],
    ),
    /A Service that released tracked supply cannot leave terminated state/,
  );
  await pool.query(
    `INSERT INTO supply_capacity_releases(
       reservation_id, client_account_id, product_id, order_id, service_id, reason
     )
     SELECT reservation_id, client_account_id, product_id, order_id, service_id, reason
     FROM supply_capacity_releases
     WHERE order_id = $1
     ON CONFLICT (reservation_id) DO NOTHING`,
    [preemptingOrder.orderId],
  );
  const afterDuplicateRelease = await pool.query<{
    committed: string;
    releases: string;
  }>(
    `SELECT
       capacity.committed_units::text AS committed,
       pg_catalog.count(release_fact.id)::text AS releases
     FROM product_supply_capacities capacity
     LEFT JOIN supply_capacity_releases release_fact
       ON release_fact.product_id = capacity.product_id
     WHERE capacity.product_id = 'mock-capacity-service'
     GROUP BY capacity.committed_units`,
  );
  assert.deepEqual(afterDuplicateRelease.rows[0], { committed: "0", releases: "2" });

  const acceptancePayload = {
    termsVersion: "mock-lab-v1",
    aupVersion: "mock-lab-v1",
    idempotencyKey: `accept-quote-${randomUUID()}`,
  };
  const acceptance = await app.inject({
    method: "POST",
    url: `/api/v1/quotes/${quoteId}/accept`,
    headers: customerHeaders(customerA),
    payload: acceptancePayload,
  });
  assert.equal(acceptance.statusCode, 201, acceptance.body);
  const acceptedOrder = json<{ orderId: string; invoiceId: string }>(acceptance);
  const acceptanceReplay = await app.inject({
    method: "POST",
    url: `/api/v1/quotes/${quoteId}/accept`,
    headers: customerHeaders(customerA),
    payload: acceptancePayload,
  });
  assert.equal(acceptanceReplay.statusCode, 200, acceptanceReplay.body);
  assert.equal(json<{ orderId: string }>(acceptanceReplay).orderId, acceptedOrder.orderId);
  const savedQuoteAcceptanceFingerprint = await pool.query<{
    request_fingerprint: string;
  }>(
    `SELECT request_fingerprint
     FROM public.sales_quote_acceptances
     WHERE quote_id = $1`,
    [quoteId],
  );
  assert.equal(
    savedQuoteAcceptanceFingerprint.rows[0]?.request_fingerprint,
    requestFingerprint("quotes.accept:v1", {
      quoteId,
      termsVersion: acceptancePayload.termsVersion,
      aupVersion: acceptancePayload.aupVersion,
      marketingConsent: false,
      marketingConsentPolicyVersion: null,
    }),
    "Schema 025 must replay a saved Schema 022 Quote acceptance with its unchanged v1 fingerprint",
  );

  const voidQuote = await app.inject({
    method: "POST",
    url: "/api/v1/admin/quotes",
    headers: staffHeaders(staff),
    payload: {
      ...quotePayload,
      idempotencyKey: `void-quote-${randomUUID()}`,
    },
  });
  assert.equal(voidQuote.statusCode, 201, voidQuote.body);
  const voidQuoteId = json<{ quoteId: string }>(voidQuote).quoteId;
  const voided = await app.inject({
    method: "POST",
    url: `/api/v1/admin/quotes/${voidQuoteId}/void`,
    headers: staffHeaders(staff),
    payload: { reason: "Synthetic customer request withdrew this Quote." },
  });
  assert.equal(voided.statusCode, 200, voided.body);
  const voidAcceptance = await app.inject({
    method: "POST",
    url: `/api/v1/quotes/${voidQuoteId}/accept`,
    headers: customerHeaders(customerA),
    payload: {
      ...acceptancePayload,
      idempotencyKey: `void-accept-${randomUUID()}`,
    },
  });
  assert.equal(voidAcceptance.statusCode, 409, voidAcceptance.body);
  assert.equal(json<{ code: string }>(voidAcceptance).code, "QUOTE_VOID");

  const expiredQuoteId = randomUUID();
  await pool.query(
    `INSERT INTO sales_quotes(
       id, client_account_id, created_by_staff_user_id,
       product_id, catalog_product_revision_id, product_price_id,
       product_name, fulfillment_mode, billing_cycle, configuration,
       price_snapshot, promotion_id, promotion_snapshot, capacity_snapshot,
       currency, one_time_minor, setup_minor, recurring_minor, total_minor,
       expires_at, idempotency_key, request_fingerprint, created_at
     )
     SELECT
       $1, client_account_id, created_by_staff_user_id,
       product_id, catalog_product_revision_id, product_price_id,
       product_name, fulfillment_mode, billing_cycle, configuration,
       price_snapshot, promotion_id, promotion_snapshot, capacity_snapshot,
       currency, one_time_minor, setup_minor, recurring_minor, total_minor,
       pg_catalog.now() - interval '1 day', $2, $3,
       pg_catalog.now() - interval '2 days'
     FROM sales_quotes
     WHERE id = $4`,
    [
      expiredQuoteId,
      `expired-quote-${randomUUID()}`,
      `expired-fingerprint-${randomUUID()}`,
      voidQuoteId,
    ],
  );
  const expiredRead = await app.inject({
    method: "GET",
    url: `/api/v1/quotes/${expiredQuoteId}`,
    headers: customerHeaders(customerA),
  });
  assert.equal(expiredRead.statusCode, 200, expiredRead.body);
  assert.equal(json<{ quote: { status: string } }>(expiredRead).quote.status, "expired");
  const expiredAcceptance = await app.inject({
    method: "POST",
    url: `/api/v1/quotes/${expiredQuoteId}/accept`,
    headers: customerHeaders(customerA),
    payload: {
      ...acceptancePayload,
      idempotencyKey: `expired-accept-${randomUUID()}`,
    },
  });
  assert.equal(expiredAcceptance.statusCode, 409, expiredAcceptance.body);
  assert.equal(json<{ code: string }>(expiredAcceptance).code, "QUOTE_EXPIRED");

  const invariants = await pool.query<{
    quote_acceptances: string;
    source_orders: string;
    source_invoices: string;
    unbalanced: string;
    leaked_secret: string;
  }>(
    `SELECT
       (SELECT pg_catalog.count(*)::text FROM sales_quote_acceptances)
         AS quote_acceptances,
       (SELECT pg_catalog.count(*)::text FROM orders
        WHERE source_quote_id IS NOT NULL) AS source_orders,
       (SELECT pg_catalog.count(*)::text
        FROM invoices invoice
        JOIN orders original_order ON original_order.id = invoice.order_id
        WHERE original_order.source_quote_id IS NOT NULL) AS source_invoices,
       (SELECT pg_catalog.count(*)::text
        FROM (
          SELECT journal.id
          FROM ledger_journals journal
          JOIN ledger_lines line ON line.journal_id = journal.id
          GROUP BY journal.id
          HAVING pg_catalog.sum(line.debit_minor) <> pg_catalog.sum(line.credit_minor)
        ) invalid) AS unbalanced,
       (SELECT pg_catalog.count(*)::text
        FROM order_items
        WHERE configuration::text LIKE '%must-never-persist%') AS leaked_secret`,
  );
  assert.deepEqual(invariants.rows[0], {
    quote_acceptances: "1",
    source_orders: "1",
    source_invoices: "1",
    unbalanced: "0",
    leaked_secret: "0",
  });

  console.log(
    "Catalog Commerce PostgreSQL 18 integration: PASS — saved Schema 020 forward upgrade, frozen Schema 020/021/022 projections and tamper rejection, Staff definitions, immutable non-overlapping price and Promotion revisions, options, Promotion exhaustion, supply reservation/release projection, zero Order, Marketing Consent withdrawal, Quote wall-clock expiry/preview/accept/replay/void and idempotency isolation, tenant isolation, legal snapshots, and balanced sealed ledgers.",
  );
} finally {
  await app?.close().catch(() => undefined);
  app = null;
  await pool?.end().catch(() => undefined);
  pool = null;
  try {
    await admin.query(
      `SELECT pg_catalog.pg_terminate_backend(pid)
       FROM pg_catalog.pg_stat_activity
       WHERE datname = $1 AND pid <> pg_catalog.pg_backend_pid()`,
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await admin.end().catch(() => undefined);
  }
}
