// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { CUSTOMER_CAPABILITIES } from "@opensales/core";
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
  throw new Error("ADMIN_DATABASE_URL is required for account-context normal integration");
}

const databaseName = `oss_account_context_normal_${randomUUID().replaceAll("-", "")}`;
const testDatabaseUrl = new URL(adminDatabaseUrl);
testDatabaseUrl.pathname = `/${databaseName}`;
const admin = new pg.Client({ connectionString: adminDatabaseUrl });
let pool: pg.Pool | null = null;
let app: Awaited<ReturnType<typeof buildApp>>["app"] | null = null;

const config: Config = {
  DATABASE_URL: testDatabaseUrl.toString(),
  OSS_ENV: "test",
  OSS_LOG_LEVEL: "silent",
  OSS_PUBLIC_URL: "http://127.0.0.1:3000",
  API_HOST: "127.0.0.1",
  API_PORT: 3000,
  GLOBAL_RATE_LIMIT_MAX: 1_000,
  SESSION_COOKIE_NAME: "oss_account_context_normal_session",
  SESSION_TTL_HOURS: 24,
  VERIFICATION_TTL_MINUTES: 30,
  WEB_ORIGIN: "http://127.0.0.1:5173",
  MOCK_MAILBOX_URL: "http://127.0.0.1:4000",
  LAB_MAILBOX_TOKEN: "synthetic-account-context-normal-mailbox-token",
  PROVIDER_OPERATION_CAPABILITY_SECRET:
    "synthetic-account-context-normal-provider-capability",
  PAYMENT_METHOD_TOKEN_KEY: Buffer.alloc(32, 91).toString("base64url"),
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY: Buffer.alloc(32, 92).toString("base64url"),
  IDENTITY_SECRET_KEY: Buffer.alloc(32, 93).toString("base64url"),
  MOCK_PAYMENT_WEBHOOK_SECRET: "synthetic-account-context-normal-payment-hook",
  MOCK_PROVISIONING_WEBHOOK_SECRET:
    "synthetic-account-context-normal-provisioning-hook",
  NOTIFICATION_MAX_ATTEMPTS: 3,
  LAB_MAILBOX_ENABLED: false,
};

function responseJson<T>(response: Readonly<{ body: string }>): T {
  return JSON.parse(response.body) as T;
}

async function waitForDatabaseConnectionsToClose(
  timeoutMilliseconds = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (true) {
    const connections = await admin.query<{ count: string }>(
      `SELECT pg_catalog.count(*)::text AS count
       FROM pg_catalog.pg_stat_activity
       WHERE datname = $1`,
      [databaseName],
    );
    const count = Number(connections.rows[0]?.count ?? "0");
    if (count === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Account Context normal database still has ${count} connection(s) after pool shutdown`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

function assertContextHeaders(
  response: Readonly<{ headers: Record<string, string | string[] | undefined> }>,
  expected: Readonly<{
    clientAccountId: string | null;
    accountContextVersion: string;
    authorizationEpoch: string;
  }>,
): void {
  assert.equal(
    response.headers["x-oss-client-account-id"],
    expected.clientAccountId ?? undefined,
  );
  assert.equal(
    response.headers["x-oss-account-context-version"],
    expected.accountContextVersion,
  );
  assert.equal(
    response.headers["x-oss-authorization-epoch"],
    expected.authorizationEpoch,
  );
}

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  pool = new pg.Pool({
    connectionString: testDatabaseUrl.toString(),
    max: 8,
    options: "-c search_path=pg_catalog,public",
    statement_timeout: 15_000,
    application_name: "opensales-account-context-normal-integration",
  });

  await runMigrations(pool);
  const compatibility = await assertSchemaCompatible(pool);
  assert.equal(compatibility.installedSchemaVersion, REQUIRED_SCHEMA_VERSION);

  const customerUserId = randomUUID();
  const secondAccountOwnerUserId = randomUUID();
  const staffUserId = randomUUID();
  const firstAccountId = randomUUID();
  const secondAccountId = randomUUID();
  const firstContactId = randomUUID();
  const secondContactId = randomUUID();
  const customerSessionToken = randomBytes(32).toString("base64url");
  const staffSessionToken = randomBytes(32).toString("base64url");

  await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO users(id, email, password_hash, email_verified_at)
       VALUES
         ($1, $2, 'synthetic-not-a-password', pg_catalog.now()),
         ($3, $4, 'synthetic-not-a-password', pg_catalog.now()),
         ($5, $6, 'synthetic-not-a-password', pg_catalog.now())`,
      [
        customerUserId,
        `context-normal-customer-${databaseName}@example.invalid`,
        secondAccountOwnerUserId,
        `context-normal-second-owner-${databaseName}@example.invalid`,
        staffUserId,
        `context-normal-staff-${databaseName}@example.invalid`,
      ],
    );
    await client.query(
      `INSERT INTO client_accounts(id, name, owner_user_id)
       VALUES
         ($1, 'Normal Context Alpha', $2),
         ($3, 'Normal Context Beta', $4)`,
      [firstAccountId, customerUserId, secondAccountId, secondAccountOwnerUserId],
    );
    await client.query(
      `INSERT INTO client_memberships(
         client_account_id, user_id, role, permissions, created_at
       ) VALUES
         ($1, $2, 'owner', '[]'::jsonb, '2026-01-01T00:00:01Z'),
         ($3, $4, 'owner', '[]'::jsonb, '2026-01-01T00:00:02Z'),
         ($3, $2, 'technical', '["account.contacts.read"]'::jsonb,
          '2026-01-01T00:00:03Z')`,
      [firstAccountId, customerUserId, secondAccountId, secondAccountOwnerUserId],
    );
    await client.query(
      `INSERT INTO client_contacts(
         id, client_account_id, display_name, email, locale,
         notification_subscriptions
       ) VALUES
         ($1, $2, 'Alpha Operations', 'alpha-operations@example.invalid',
          'en', '["billing"]'::jsonb),
         ($3, $4, 'Beta Operations', 'beta-operations@example.invalid',
          'zh-CN', '["service", "support"]'::jsonb)`,
      [firstContactId, firstAccountId, secondContactId, secondAccountId],
    );
    await client.query(
      `INSERT INTO staff_members(user_id, roles, permissions)
       VALUES ($1, ARRAY['Operations'], '["accounts.view"]'::jsonb)`,
      [staffUserId],
    );
    await client.query(
      `INSERT INTO sessions(
         user_id, token_digest, expires_at,
         active_client_account_id, account_context_version
       ) VALUES
         ($1, $2, pg_catalog.now() + interval '1 hour', $3, 1),
         ($4, $5, pg_catalog.now() + interval '1 hour', NULL, 0)`,
      [
        customerUserId,
        digestToken(customerSessionToken),
        firstAccountId,
        staffUserId,
        digestToken(staffSessionToken),
      ],
    );
  });

  const epochs = await pool.query<{ id: string; authorization_epoch: string }>(
    `SELECT id, authorization_epoch::text
     FROM users
     WHERE id = ANY($1::uuid[])
     ORDER BY id`,
    [[customerUserId, staffUserId]],
  );
  const customerAuthorizationEpoch = epochs.rows.find(
    (row) => row.id === customerUserId,
  )?.authorization_epoch;
  const staffAuthorizationEpoch = epochs.rows.find(
    (row) => row.id === staffUserId,
  )?.authorization_epoch;
  assert.equal(customerAuthorizationEpoch, "2");
  assert.equal(staffAuthorizationEpoch, "1");

  ({ app } = await buildApp(config, pool));
  await app.ready();
  const customerCookie = `${config.SESSION_COOKIE_NAME}=${customerSessionToken}`;
  const staffCookie = `${config.SESSION_COOKIE_NAME}=${staffSessionToken}`;

  const initialMe = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: customerCookie },
  });
  assert.equal(initialMe.statusCode, 200, initialMe.body);
  assertContextHeaders(initialMe, {
    clientAccountId: firstAccountId,
    accountContextVersion: "1",
    authorizationEpoch: customerAuthorizationEpoch,
  });
  const initialMeBody = responseJson<{
    clientAccountId: string;
    accountContextVersion: string;
    authorizationEpoch: string;
    eligible: boolean;
    context: {
      clientAccountId: string;
      name: string;
      role: string;
      permissions: string[];
      capabilities: string[];
      version: string;
    };
  }>(initialMe);
  assert.equal(initialMeBody.clientAccountId, firstAccountId);
  assert.equal(initialMeBody.accountContextVersion, "1");
  assert.equal(initialMeBody.authorizationEpoch, customerAuthorizationEpoch);
  assert.equal(initialMeBody.eligible, true);
  assert.deepEqual(initialMeBody.context, {
    clientAccountId: firstAccountId,
    name: "Normal Context Alpha",
    role: "owner",
    permissions: [],
    capabilities: [...CUSTOMER_CAPABILITIES],
    version: "1",
  });

  const initialContexts = await app.inject({
    method: "GET",
    url: "/api/v1/auth/account-contexts",
    headers: { cookie: customerCookie },
  });
  assert.equal(initialContexts.statusCode, 200, initialContexts.body);
  assertContextHeaders(initialContexts, {
    clientAccountId: firstAccountId,
    accountContextVersion: "1",
    authorizationEpoch: customerAuthorizationEpoch,
  });
  const initialContextBody = responseJson<{
    activeClientAccountId: string;
    accountContextVersion: string;
    items: Array<{
      clientAccountId: string;
      name: string;
      role: string;
      permissions: string[];
      capabilities: string[];
      restrictions: { membership: boolean; clientAccount: boolean };
      createdAt: string;
    }>;
  }>(initialContexts);
  assert.equal(initialContextBody.activeClientAccountId, firstAccountId);
  assert.equal(initialContextBody.accountContextVersion, "1");
  assert.equal(initialContextBody.items.length, 2);
  const secondContext = initialContextBody.items.find(
    (context) => context.clientAccountId === secondAccountId,
  );
  assert.ok(secondContext);
  const { createdAt: secondContextCreatedAt, ...secondContextSummary } = secondContext;
  assert.match(secondContextCreatedAt, /^2026-01-01T00:00:03\.000000Z$/);
  assert.deepEqual(secondContextSummary, {
    clientAccountId: secondAccountId,
    name: "Normal Context Beta",
    role: "technical",
    permissions: ["account.contacts.read"],
    capabilities: [
      "account.contacts.read",
      "account.history.read",
      "billing.read",
      "services.manage",
      "support.tickets.write",
    ],
    restrictions: { membership: false, clientAccount: false },
  });

  const firstContacts = await app.inject({
    method: "GET",
    url: "/api/v1/account/contacts",
    headers: { cookie: customerCookie },
  });
  assert.equal(firstContacts.statusCode, 200, firstContacts.body);
  assertContextHeaders(firstContacts, {
    clientAccountId: firstAccountId,
    accountContextVersion: "1",
    authorizationEpoch: customerAuthorizationEpoch,
  });
  assert.deepEqual(
    responseJson<{ items: Array<{ id: string; displayName: string }> }>(firstContacts)
      .items.map((contact) => ({ id: contact.id, displayName: contact.displayName })),
    [{ id: firstContactId, displayName: "Alpha Operations" }],
  );

  const switched = await app.inject({
    method: "PUT",
    url: "/api/v1/auth/account-context",
    headers: {
      cookie: customerCookie,
      "x-oss-account-context-version": "1",
    },
    payload: { clientAccountId: secondAccountId },
  });
  assert.equal(switched.statusCode, 200, switched.body);
  assertContextHeaders(switched, {
    clientAccountId: secondAccountId,
    accountContextVersion: "2",
    authorizationEpoch: customerAuthorizationEpoch,
  });
  assert.deepEqual(
    responseJson<{ context: unknown }>(switched).context,
    {
      clientAccountId: secondAccountId,
      name: "Normal Context Beta",
      role: "technical",
      permissions: ["account.contacts.read"],
      restrictions: { clientAccount: false },
      version: "2",
    },
  );

  const switchedMe = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: customerCookie },
  });
  assert.equal(switchedMe.statusCode, 200, switchedMe.body);
  assertContextHeaders(switchedMe, {
    clientAccountId: secondAccountId,
    accountContextVersion: "2",
    authorizationEpoch: customerAuthorizationEpoch,
  });
  const switchedMeBody = responseJson<{
    context: { capabilities: string[]; role: string; name: string; version: string };
  }>(switchedMe);
  assert.deepEqual(switchedMeBody.context, {
    clientAccountId: secondAccountId,
    name: "Normal Context Beta",
    role: "technical",
    permissions: ["account.contacts.read"],
    capabilities: [
      "account.contacts.read",
      "account.history.read",
      "billing.read",
      "services.manage",
      "support.tickets.write",
    ],
    version: "2",
  });

  const secondContacts = await app.inject({
    method: "GET",
    url: "/api/v1/account/contacts",
    headers: { cookie: customerCookie },
  });
  assert.equal(secondContacts.statusCode, 200, secondContacts.body);
  assertContextHeaders(secondContacts, {
    clientAccountId: secondAccountId,
    accountContextVersion: "2",
    authorizationEpoch: customerAuthorizationEpoch,
  });
  assert.deepEqual(
    responseJson<{ items: Array<{ id: string; displayName: string }> }>(secondContacts)
      .items.map((contact) => ({ id: contact.id, displayName: contact.displayName })),
    [{ id: secondContactId, displayName: "Beta Operations" }],
  );

  const staffMe = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: staffCookie },
  });
  assert.equal(staffMe.statusCode, 200, staffMe.body);
  assertContextHeaders(staffMe, {
    clientAccountId: null,
    accountContextVersion: "0",
    authorizationEpoch: staffAuthorizationEpoch,
  });
  const staffMeBody = responseJson<{
    clientAccountId: null;
    context: null;
    eligible: boolean;
    staff: { roles: string[]; permissions: string[] };
  }>(staffMe);
  assert.equal(staffMeBody.clientAccountId, null);
  assert.equal(staffMeBody.context, null);
  assert.equal(staffMeBody.eligible, false);
  assert.deepEqual(staffMeBody.staff, {
    roles: ["Operations"],
    permissions: ["accounts.view"],
  });

  await app.close();
  app = null;
  ({ app } = await buildApp(config, pool));
  await app.ready();

  const reloadedMe = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: customerCookie },
  });
  assert.equal(reloadedMe.statusCode, 200, reloadedMe.body);
  assertContextHeaders(reloadedMe, {
    clientAccountId: secondAccountId,
    accountContextVersion: "2",
    authorizationEpoch: customerAuthorizationEpoch,
  });
  assert.equal(
    responseJson<{ context: { clientAccountId: string } }>(reloadedMe).context
      .clientAccountId,
    secondAccountId,
  );

  const persistedSession = await pool.query<{
    active_client_account_id: string | null;
    account_context_version: string;
  }>(
    `SELECT active_client_account_id, account_context_version::text
     FROM sessions
     WHERE token_digest = $1`,
    [digestToken(customerSessionToken)],
  );
  assert.deepEqual(persistedSession.rows[0], {
    active_client_account_id: secondAccountId,
    account_context_version: "2",
  });

  process.stdout.write(
    `accountContextNormalIntegration=passed schema=${compatibility.installedSchemaVersion}` +
      ` initialContext=1 switchedContext=2 authorizationEpoch=${customerAuthorizationEpoch}` +
      ` accountIsolation=passed capabilities=passed reload=passed staffNullContext=passed\n`,
  );
} finally {
  try {
    if (app) await app.close();
    if (pool) await pool.end();
    await waitForDatabaseConnectionsToClose();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await admin.end();
  }
}
