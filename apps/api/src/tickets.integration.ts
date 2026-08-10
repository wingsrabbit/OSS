// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { SCHEMA_017 } from "@opensales/core/schema-016-017-rollback-compatibility";
import {
  assertSchema018NativeSafe,
  schema018CatalogDigest,
  schema018CatalogFingerprintInput,
  SCHEMA_018,
  SCHEMA_018_CATALOG_DIGEST,
} from "@opensales/core/schema-017-018-native-compatibility";
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

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for ticket integration");

const namespace = randomUUID();
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 8,
  options: "-c search_path=pg_catalog,public",
  statement_timeout: 15_000,
  application_name: "opensales-ticket-integration",
});

const config: Config = {
  DATABASE_URL: databaseUrl,
  OSS_ENV: "test",
  OSS_LOG_LEVEL: "silent",
  OSS_PUBLIC_URL: "http://127.0.0.1:3000",
  API_HOST: "127.0.0.1",
  API_PORT: 3000,
  GLOBAL_RATE_LIMIT_MAX: 1_000,
  SESSION_COOKIE_NAME: "oss_ticket_session",
  SESSION_TTL_HOURS: 24,
  VERIFICATION_TTL_MINUTES: 30,
  WEB_ORIGIN: "http://127.0.0.1:5173",
  MOCK_MAILBOX_URL: "http://127.0.0.1:4000",
  LAB_MAILBOX_TOKEN: "synthetic-ticket-mail-token-0000000000",
  PROVIDER_OPERATION_CAPABILITY_SECRET:
    "synthetic-ticket-capability-secret-0000000000",
  PAYMENT_METHOD_TOKEN_KEY: Buffer.alloc(32, 61).toString("base64url"),
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY: Buffer.alloc(32, 62).toString("base64url"),
  MOCK_PAYMENT_WEBHOOK_SECRET: "synthetic-ticket-payment-hook-000000000",
  MOCK_PROVISIONING_WEBHOOK_SECRET:
    "synthetic-ticket-provision-hook-0000000",
  LAB_MAILBOX_ENABLED: false,
};

type Fixture = {
  userId: string;
  accountId: string;
  sessionId: string;
  sessionToken: string;
};

function responseJson<T>(response: Readonly<{ body: string }>): T {
  return JSON.parse(response.body) as T;
}

async function assertNative018RejectsCatalogDrift(
  statement: string,
  expected: RegExp,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(statement);
    await assert.rejects(
      assertSchema018NativeSafe({
        query: async (text: string, values?: unknown[]) => client.query(text, values),
      }),
      expected,
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function createFixture(label: string): Promise<Fixture> {
  const userId = randomUUID();
  const accountId = randomUUID();
  const sessionId = randomUUID();
  const sessionToken = randomBytes(32).toString("base64url");
  await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO users(id, email, password_hash, email_verified_at)
       VALUES ($1, $2, 'synthetic-not-a-password', now())`,
      [userId, `ticket-${label}-${namespace}@example.invalid`],
    );
    await client.query(
      `INSERT INTO client_accounts(id, name, owner_user_id)
       VALUES ($1, $2, $3)`,
      [accountId, `Synthetic Ticket ${label}`, userId],
    );
    await client.query(
      `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
       VALUES ($1, $2, 'owner', '["*"]'::jsonb)`,
      [accountId, userId],
    );
    await client.query(
      `INSERT INTO sessions(
         id, user_id, token_digest, expires_at,
         active_client_account_id, account_context_version
       ) VALUES ($1, $2, $3, now() + interval '1 hour', $4, 1)`,
      [sessionId, userId, digestToken(sessionToken), accountId],
    );
  });
  return { userId, accountId, sessionId, sessionToken };
}

async function createService(account: Fixture): Promise<string> {
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const serviceId = randomUUID();
  const snapshot = {
    currency: "USD",
    billingCycle: "monthly",
    productId: "synthetic-ticket-service",
    productName: "Synthetic Ticket Service",
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
      account.accountId,
      account.userId,
      snapshot,
      `ticket-order:${orderId}`,
      `ticket-order-fingerprint:${orderId}`,
    ],
  );
  await pool.query(
    `INSERT INTO order_items(
       id, order_id, product_id, product_name, fulfillment_mode,
       billing_cycle, configuration, price_snapshot
     ) VALUES ($1, $2, 'synthetic-ticket-service', 'Synthetic Ticket Service',
       'automatic', 'monthly', '{}'::jsonb, $3)`,
    [orderItemId, orderId, snapshot],
  );
  await pool.query(
    `INSERT INTO services(
       id, client_account_id, order_item_id, status, billing_cycle,
       activated_at, term_start, term_end
     ) VALUES ($1, $2, $3, 'active', 'monthly', now(), now(), now() + interval '1 month')`,
    [serviceId, account.accountId, orderItemId],
  );
  return serviceId;
}

let app: Awaited<ReturnType<typeof buildApp>>["app"] | null = null;
const ticketIds: string[] = [];
const fixtures: Fixture[] = [];
try {
  await runMigrations(pool, { throughVersion: SCHEMA_017 });
  await pool.query(`
    CREATE OR REPLACE FUNCTION public.opensales_validate_manual_receipt_outflow_report()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'legacy schema 017 outflow report writer';
    END
    $$;
    CREATE OR REPLACE FUNCTION public.opensales_validate_manual_receipt_outflow_reconciliation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'legacy schema 017 outflow reconciliation writer';
    END
    $$;
    CREATE OR REPLACE FUNCTION public.opensales_assert_manual_receipt_outflow_complete()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'legacy schema 017 outflow completeness writer';
    END
    $$;
  `);
  await runMigrations(pool, { throughVersion: SCHEMA_018 });
  const repairedFunctions = await pool.query<{ definition: string }>(
    `SELECT pg_catalog.pg_get_functiondef(procedure.oid) AS definition
     FROM pg_catalog.pg_proc procedure
     JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = 'public'
       AND procedure.proname IN (
         'opensales_validate_manual_receipt_outflow_report',
         'opensales_validate_manual_receipt_outflow_reconciliation',
         'opensales_assert_manual_receipt_outflow_complete'
       )
     ORDER BY procedure.proname COLLATE "C"`,
  );
  assert.equal(repairedFunctions.rowCount, 3);
  assert.ok(
    repairedFunctions.rows.every(
      (row) =>
        !row.definition.includes("legacy schema 017") &&
        (row.definition.includes("INTO credit_row") ||
          row.definition.includes("INTO effect_row")),
    ),
    "migration 018 must forward-repair every reviewed Schema 017 PG18 writer",
  );
  const catalogFingerprintInput = await schema018CatalogFingerprintInput({
    query: async (text: string, values?: unknown[]) => pool.query(text, values),
  });
  const catalogDigest = schema018CatalogDigest(catalogFingerprintInput);
  process.stdout.write(`schema018CatalogDigest=${String(catalogDigest)}\n`);
  assert.equal(
    catalogDigest,
    SCHEMA_018_CATALOG_DIGEST,
    "commit the digest emitted by the actual PostgreSQL 18 ticket catalog",
  );
  const schema018Preflight = await assertSchema018NativeSafe({
    query: async (text: string, values?: unknown[]) => pool.query(text, values),
  });
  assert.equal(schema018Preflight.installedSchemaVersion, SCHEMA_018);
  await assertNative018RejectsCatalogDrift(
    "DROP TRIGGER z_schema_017_manual_outflow_provider_rejection ON public.provider_operations",
    /Schema 017 is incomplete or counterfeit/,
  );
  await assertNative018RejectsCatalogDrift(
    "DROP INDEX public.support_tickets_staff_updated_idx",
    /Schema 018 is incomplete or counterfeit/,
  );
  await assertNative018RejectsCatalogDrift(
    "ALTER TABLE public.support_tickets DROP CONSTRAINT support_tickets_status_check",
    /Schema 018 is incomplete or counterfeit/,
  );

  await runMigrations(pool);
  const preflight = await assertSchemaCompatible(pool);
  assert.equal(preflight.installedSchemaVersion, REQUIRED_SCHEMA_VERSION);
  assert.equal(preflight.mode, "native");

  const customerA = await createFixture("customer-a");
  const customerB = await createFixture("customer-b");
  const staff = await createFixture("staff");
  fixtures.push(customerA, customerB, staff);
  const serviceA = await createService(customerA);
  await pool.query(
    `INSERT INTO staff_members(user_id, roles, permissions)
     VALUES ($1, ARRAY['Support'], '["support.tickets.manage"]'::jsonb)`,
    [staff.userId],
  );

  ({ app } = await buildApp(config, pool));
  await app.ready();
  const cookieA = `oss_ticket_session=${customerA.sessionToken}`;
  const cookieB = `oss_ticket_session=${customerB.sessionToken}`;
  const staffCookie = `oss_ticket_session=${staff.sessionToken}`;
  const customerAHeaders = {
    cookie: cookieA,
    "x-oss-account-context-version": "1",
  };
  const customerBHeaders = {
    cookie: cookieB,
    "x-oss-account-context-version": "1",
  };

  const created = await app.inject({
    method: "POST",
    url: "/api/v1/tickets",
    headers: customerAHeaders,
    payload: {
      subject: "Synthetic routing question",
      message: "Please confirm the Mock-only service handoff.",
      serviceId: serviceA,
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const createdBody = responseJson<{
    ticket: { id: string; service: { id: string } | null; status: string };
    messages: Array<{ body: string }>;
  }>(created);
  const ticketId = createdBody.ticket.id;
  ticketIds.push(ticketId);
  assert.equal(createdBody.ticket.service?.id, serviceA);
  assert.equal(createdBody.ticket.status, "awaiting_staff");
  assert.deepEqual(createdBody.messages.map((message) => message.body), [
    "Please confirm the Mock-only service handoff.",
  ]);

  const otherAccountRead = await app.inject({
    method: "GET",
    url: `/api/v1/tickets/${ticketId}`,
    headers: customerBHeaders,
  });
  assert.equal(otherAccountRead.statusCode, 404);
  const otherAccountReply = await app.inject({
    method: "POST",
    url: `/api/v1/tickets/${ticketId}/replies`,
    headers: customerBHeaders,
    payload: { message: "This must not be accepted across accounts." },
  });
  assert.equal(otherAccountReply.statusCode, 404);
  const otherAccountService = await app.inject({
    method: "POST",
    url: "/api/v1/tickets",
    headers: customerBHeaders,
    payload: {
      subject: "Wrong service association",
      message: "This account does not own the selected service.",
      serviceId: serviceA,
    },
  });
  assert.equal(otherAccountService.statusCode, 404);

  await assert.rejects(
    pool.query(
      `INSERT INTO support_tickets(
         client_account_id, service_id, created_by_user_id, subject
       ) VALUES ($1, $2, $3, 'Cross-account database association')`,
      [customerB.accountId, serviceA, customerB.userId],
    ),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "23503",
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO support_ticket_messages(
         ticket_id, author_user_id, author_type, visibility, body
       ) VALUES ($1, $2, 'customer', 'internal', 'Database must reject this')`,
      [ticketId, customerA.userId],
    ),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "23514",
  );

  const queue = await app.inject({
    method: "GET",
    url: "/api/v1/admin/tickets",
    headers: { cookie: staffCookie },
  });
  assert.equal(queue.statusCode, 200, queue.body);
  assert.ok(
    responseJson<{ items: Array<{ id: string }> }>(queue).items.some(
      (ticket) => ticket.id === ticketId,
    ),
  );

  const internalText = "Internal handoff: synthetic operator owns the next step.";
  const internal = await app.inject({
    method: "POST",
    url: `/api/v1/admin/tickets/${ticketId}/messages`,
    headers: { cookie: staffCookie },
    payload: { kind: "internal_note", message: internalText },
  });
  assert.equal(internal.statusCode, 201, internal.body);
  assert.ok(
    responseJson<{ messages: Array<{ visibility: string; body: string }> }>(internal)
      .messages.some(
        (message) => message.visibility === "internal" && message.body === internalText,
      ),
  );

  const publicText = "Public reply: the synthetic service handoff is confirmed.";
  const publicReply = await app.inject({
    method: "POST",
    url: `/api/v1/admin/tickets/${ticketId}/messages`,
    headers: { cookie: staffCookie },
    payload: { kind: "public_reply", message: publicText },
  });
  assert.equal(publicReply.statusCode, 201, publicReply.body);
  assert.equal(
    responseJson<{ ticket: { status: string } }>(publicReply).ticket.status,
    "awaiting_customer",
  );

  const customerDetail = await app.inject({
    method: "GET",
    url: `/api/v1/tickets/${ticketId}`,
    headers: customerAHeaders,
  });
  assert.equal(customerDetail.statusCode, 200, customerDetail.body);
  const customerMessages = responseJson<{
    messages: Array<Record<string, unknown> & { body: string }>;
  }>(customerDetail).messages;
  assert.deepEqual(customerMessages.map((message) => message.body), [
    "Please confirm the Mock-only service handoff.",
    publicText,
  ]);
  assert.ok(customerMessages.every((message) => !("visibility" in message)));
  assert.ok(customerMessages.every((message) => message.body !== internalText));

  const customerReply = await app.inject({
    method: "POST",
    url: `/api/v1/tickets/${ticketId}/replies`,
    headers: customerAHeaders,
    payload: { message: "Customer reply: thank you, the Mock-only handoff is clear." },
  });
  assert.equal(customerReply.statusCode, 201, customerReply.body);
  assert.equal(
    responseJson<{ ticket: { status: string } }>(customerReply).ticket.status,
    "awaiting_staff",
  );

  const counts = await pool.query<{
    public_count: string;
    internal_count: string;
  }>(
    `SELECT
       count(*) FILTER (WHERE visibility = 'public')::text AS public_count,
       count(*) FILTER (WHERE visibility = 'internal')::text AS internal_count
     FROM support_ticket_messages
     WHERE ticket_id = $1`,
    [ticketId],
  );
  assert.deepEqual(counts.rows[0], { public_count: "3", internal_count: "1" });
  process.stdout.write(
    "ticketIntegration=passed native018=passed native019=passed schema017ForwardRepair=passed inherited017Catalog=passed ticketCatalogDrift=passed ticketConstraintDrift=passed accountIsolation=passed internalVisibility=passed\n",
  );
} finally {
  if (app) await app.close().catch(() => undefined);
  if (ticketIds.length > 0) {
    await pool.query(
      "DELETE FROM audit_events WHERE target_type = 'support_ticket' AND target_id = ANY($1::text[])",
      [ticketIds],
    ).catch(() => undefined);
    await pool.query("DELETE FROM support_tickets WHERE id = ANY($1::uuid[])", [ticketIds])
      .catch(() => undefined);
  }
  const userIds = fixtures.map((fixture) => fixture.userId);
  const accountIds = fixtures.map((fixture) => fixture.accountId);
  if (userIds.length > 0) {
    await pool.query("DELETE FROM staff_members WHERE user_id = ANY($1::uuid[])", [userIds])
      .catch(() => undefined);
    await pool.query("DELETE FROM sessions WHERE user_id = ANY($1::uuid[])", [userIds])
      .catch(() => undefined);
    await pool.query("DELETE FROM services WHERE client_account_id = ANY($1::uuid[])", [accountIds])
      .catch(() => undefined);
    await pool.query(
      `DELETE FROM order_items item
       USING orders customer_order
       WHERE item.order_id = customer_order.id
         AND customer_order.client_account_id = ANY($1::uuid[])`,
      [accountIds],
    ).catch(() => undefined);
    await pool.query("DELETE FROM orders WHERE client_account_id = ANY($1::uuid[])", [accountIds])
      .catch(() => undefined);
    await pool.query("DELETE FROM client_memberships WHERE user_id = ANY($1::uuid[])", [userIds])
      .catch(() => undefined);
    await pool.query("DELETE FROM client_accounts WHERE id = ANY($1::uuid[])", [accountIds])
      .catch(() => undefined);
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds])
      .catch(() => undefined);
  }
  await pool.end().catch(() => undefined);
}
