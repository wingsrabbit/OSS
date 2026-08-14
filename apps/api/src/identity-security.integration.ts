// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import {
  decryptIdentitySecret,
  type CustomerApiKeyScope,
} from "@opensales/core/identity-security";
import { buildApp } from "./app.js";
import { digestToken, passwordHash } from "./auth.js";
import { identitySecretKeyring, type Config } from "./config.js";
import { runMigrations, transaction, type DatabasePool } from "./database.js";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) {
  throw new Error("ADMIN_DATABASE_URL is required for Identity Security integration");
}

const databaseName = `oss_identity_security_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = new URL(adminDatabaseUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = new pg.Client({ connectionString: adminDatabaseUrl });
let pool: DatabasePool | null = null;
let app: Awaited<ReturnType<typeof buildApp>>["app"] | null = null;

const config: Config = {
  DATABASE_URL: databaseUrl.toString(),
  OSS_ENV: "test",
  OSS_LOG_LEVEL: process.env.IDENTITY_INTEGRATION_DEBUG === "true" ? "error" : "silent",
  OSS_PUBLIC_URL: "http://127.0.0.1:5173",
  API_HOST: "127.0.0.1",
  API_PORT: 3000,
  GLOBAL_RATE_LIMIT_MAX: 10_000,
  SESSION_COOKIE_NAME: "oss_identity_security_session",
  SESSION_TTL_HOURS: 24,
  VERIFICATION_TTL_MINUTES: 30,
  WEB_ORIGIN: "http://127.0.0.1:5173",
  MOCK_MAILBOX_URL: "http://127.0.0.1:4000",
  LAB_MAILBOX_TOKEN: "synthetic-identity-security-mailbox-token",
  PROVIDER_OPERATION_CAPABILITY_SECRET:
    "synthetic-identity-security-operation-secret",
  PAYMENT_METHOD_TOKEN_KEY: Buffer.alloc(32, 91).toString("base64url"),
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY: Buffer.alloc(32, 92).toString("base64url"),
  IDENTITY_SECRET_KEY: Buffer.alloc(32, 93).toString("base64url"),
  MOCK_PAYMENT_WEBHOOK_SECRET: "synthetic-identity-security-payment-secret",
  MOCK_PROVISIONING_WEBHOOK_SECRET:
    "synthetic-identity-security-provisioning-secret",
  LAB_MAILBOX_ENABLED: true,
};

type Customer = Readonly<{
  userId: string;
  accountId: string;
  email: string;
  password: string;
}>;

function json<T>(response: Readonly<{ body: string }>): T {
  return JSON.parse(response.body) as T;
}

function namedCookie(
  response: Readonly<{ headers: Record<string, unknown> }>,
  name: string,
): string {
  const value = response.headers["set-cookie"];
  assert.ok(value, `response must issue the ${name} cookie`);
  const serialized = Array.isArray(value) ? value.join(", ") : String(value);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = serialized.match(new RegExp(`(?:^|,\\s*)(${escaped}=[^;,\\s]+)`));
  assert.ok(match?.[1], `response must issue the ${name} cookie`);
  return match[1];
}

function cookie(response: Readonly<{ headers: Record<string, unknown> }>): string {
  return namedCookie(response, config.SESSION_COOKIE_NAME);
}

function mailboxCookie(response: Readonly<{ headers: Record<string, unknown> }>): string {
  return namedCookie(response, "oss_lab_identity_mailbox");
}

function base32Decode(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of secret) {
    const digit = alphabet.indexOf(character);
    assert.notEqual(digit, -1, "TOTP secret must be canonical base32");
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
      value &= (1 << bits) - 1;
    }
  }
  assert.equal(value, 0, "TOTP secret must have zero residual bits");
  return Buffer.from(bytes);
}

function totpCode(secret: string, timeMs: number): string {
  const step = BigInt(Math.floor(timeMs / 30_000));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(step);
  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

async function createCustomer(label: string, emailVerified = true): Promise<Customer> {
  if (!pool) throw new Error("Database is unavailable");
  const userId = randomUUID();
  const accountId = randomUUID();
  const password = `Synthetic-${label}-password-024!`;
  const email = `${label}-${databaseName}@example.invalid`;
  const encoded = await passwordHash(password);
  await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO users(id, email, password_hash, locale, email_verified_at)
       VALUES (
         $1, $2, $3, 'en',
         CASE WHEN $4::boolean THEN pg_catalog.now() ELSE NULL END
       )`,
      [userId, email, encoded, emailVerified],
    );
    await client.query(
      `INSERT INTO client_accounts(id, name, owner_user_id)
       VALUES ($1, $2, $3)`,
      [accountId, `${label} Account`, userId],
    );
    await client.query(
      `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
       VALUES ($1, $2, 'owner', '["*"]'::jsonb)`,
      [accountId, userId],
    );
  });
  return { userId, accountId, email, password };
}

async function login(customer: Customer): Promise<Readonly<{
  cookie: string;
  mailboxCookie: string;
  epoch: string;
  contextVersion: string;
}>> {
  if (!app) throw new Error("API is unavailable");
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: customer.email, password: customer.password },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.match(String(response.headers["x-oss-authorization-epoch"]), /^\d+$/);
  return {
    cookie: cookie(response),
    mailboxCookie: mailboxCookie(response),
    epoch: String(response.headers["x-oss-authorization-epoch"]),
    contextVersion: String(response.headers["x-oss-account-context-version"]),
  };
}

function sessionHeaders(session: Readonly<{ cookie: string; contextVersion: string }>): {
  cookie: string;
  "x-oss-account-context-version": string;
} {
  return {
    cookie: session.cookie,
    "x-oss-account-context-version": session.contextVersion,
  };
}

function rawCookieValue(serialized: string): string {
  const separator = serialized.indexOf("=");
  assert.ok(separator > 0, "cookie must contain a name and value");
  return serialized.slice(separator + 1);
}

async function assertMailboxCapability(
  session: Readonly<{
    cookie: string;
    mailboxCookie: string;
    epoch: string;
  }>,
  expectedEmail: string,
): Promise<string> {
  if (!pool) throw new Error("Database is unavailable");
  const rawCapability = rawCookieValue(session.mailboxCookie);
  const separator = rawCapability.indexOf(".");
  assert.ok(separator > 0, "mailbox capability must contain an id and secret");
  const capabilityId = rawCapability.slice(0, separator);
  const capabilitySecret = rawCapability.slice(separator + 1);
  const sessionToken = rawCookieValue(session.cookie);
  const result = await pool.query<{
    recipient: string;
    authorization_epoch: string;
    origin_session_id: string;
    current_session_id: string;
    revoked_at: Date | null;
  }>(
    `SELECT capability.recipient::text,
            capability.authorization_epoch::text,
            capability.origin_session_id,
            origin.id AS current_session_id,
            capability.revoked_at
     FROM lab_identity_mailbox_capabilities capability
     JOIN sessions origin
       ON origin.id = capability.origin_session_id
      AND origin.token_digest = $3
     WHERE capability.id = $1 AND capability.token_digest = $2`,
    [capabilityId, digestToken(capabilitySecret), digestToken(sessionToken)],
  );
  const row = result.rows[0];
  assert.ok(row, "mailbox capability must bind the current Session secret");
  assert.equal(row.recipient, expectedEmail);
  assert.equal(row.authorization_epoch, session.epoch);
  assert.equal(row.origin_session_id, row.current_session_id);
  assert.equal(row.revoked_at, null);
  return capabilityId;
}

async function notificationToken(kind: "password_recovery" | "email_change"): Promise<{
  token: string;
  outboxId: string;
  durableJobId: string;
  url: URL;
}> {
  if (!pool) throw new Error("Database is unavailable");
  const result = await pool.query<{
    id: string;
    subject_id: string;
    encrypted_payload: string;
    encryption_key_version: number;
    durable_job_id: string;
  }>(
    `SELECT event.id, event.subject_id, event.encrypted_payload,
            event.encryption_key_version, job.id AS durable_job_id
     FROM identity_notification_outbox event
     JOIN durable_jobs job
       ON job.job_type = 'identity.notification.send'
      AND job.payload ->> 'outboxId' = event.id::text
     WHERE event.kind = $1
     ORDER BY event.created_at DESC, event.id DESC
     LIMIT 1`,
    [kind],
  );
  const row = result.rows[0];
  assert.ok(row, `missing ${kind} notification`);
  const plaintext = decryptIdentitySecret(
    row.encrypted_payload,
    row.encryption_key_version,
    `identity-notification:${kind}`,
    row.subject_id,
    identitySecretKeyring(config),
  );
  const payload = JSON.parse(plaintext) as { url: string };
  const url = new URL(payload.url);
  assert.equal(url.search, "", "identity links must never carry a query string");
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  assert.ok(token, "identity link must carry its token only in the fragment");
  assert.equal(row.encrypted_payload.includes(token), false, "outbox must not expose plaintext token");
  return { token, outboxId: row.id, durableJobId: row.durable_job_id, url };
}

async function expectDatabaseReject(statement: string, values: readonly unknown[]): Promise<void> {
  if (!pool) throw new Error("Database is unavailable");
  await assert.rejects(pool.query(statement, [...values]));
}

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  pool = new pg.Pool({
    connectionString: databaseUrl.toString(),
    max: 16,
    options: "-c search_path=pg_catalog,public",
    statement_timeout: 20_000,
    application_name: "opensales-identity-security-integration",
  });
  await runMigrations(pool, { throughVersion: "024_stage_c_identity_security" });
  ({ app } = await buildApp(config, pool));

  const primary = await createCustomer("primary");
  const other = await createCustomer("other");
  const registration = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email: `registration-${databaseName}@example.invalid`,
      password: "Synthetic-registration-password-024!",
      clientName: "Synthetic registration account",
      locale: "en",
    },
  });
  assert.equal(registration.statusCode, 201, registration.body);
  assert.doesNotMatch(
    String(registration.headers["set-cookie"] ?? ""),
    /oss_lab_identity_mailbox=/,
    "registration alone must not prove possession of the recovery mailbox",
  );

  const verificationCustomer = await createCustomer("verification", false);
  const verificationSession = await login(verificationCustomer);
  const unverifiedCapabilityId = await assertMailboxCapability(
    verificationSession,
    verificationCustomer.email,
  );
  const verificationToken = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO email_verification_tokens(user_id, token_digest, expires_at)
     VALUES ($1, $2, pg_catalog.clock_timestamp() + interval '30 minutes')`,
    [verificationCustomer.userId, digestToken(verificationToken)],
  );
  const verification = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify-email",
    headers: {
      cookie: `${verificationSession.cookie}; ${verificationSession.mailboxCookie}`,
    },
    payload: { token: verificationToken },
  });
  assert.equal(verification.statusCode, 200, verification.body);
  assert.equal(json<{ status: string }>(verification).status, "verified");
  const verifiedEpoch = await pool.query<{ authorization_epoch: string }>(
    `SELECT authorization_epoch::text FROM users WHERE id = $1`,
    [verificationCustomer.userId],
  );
  const verifiedSession = {
    ...verificationSession,
    mailboxCookie: mailboxCookie(verification),
    epoch: verifiedEpoch.rows[0]!.authorization_epoch,
  };
  const verifiedCapabilityId = await assertMailboxCapability(
    verifiedSession,
    verificationCustomer.email,
  );
  assert.notEqual(verifiedCapabilityId, unverifiedCapabilityId);
  const retiredUnverifiedCapability = await pool.query<{ revoked: boolean }>(
    `SELECT revoked_at IS NOT NULL AS revoked
     FROM lab_identity_mailbox_capabilities WHERE id = $1`,
    [unverifiedCapabilityId],
  );
  assert.equal(retiredUnverifiedCapability.rows[0]?.revoked, true);

  let session = await login(primary);
  assert.match(session.epoch, /^\d+$/);
  const initialMailboxCapabilityId = await assertMailboxCapability(session, primary.email);
  const verificationOrigin = await pool.query<{ id: string }>(
    `SELECT id FROM sessions WHERE token_digest = $1`,
    [digestToken(rawCookieValue(verificationSession.cookie))],
  );
  await expectDatabaseReject(
    `INSERT INTO lab_identity_mailbox_capabilities(
       user_id, origin_session_id, recipient, authorization_epoch,
       token_digest, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       pg_catalog.clock_timestamp() + interval '30 days'
     )`,
    [
      primary.userId,
      verificationOrigin.rows[0]!.id,
      primary.email,
      session.epoch,
      randomBytes(32),
    ],
  );
  await expectDatabaseReject(
    `UPDATE lab_identity_mailbox_capabilities
     SET recipient = $2 WHERE id = $1`,
    [initialMailboxCapabilityId, `forged-${databaseName}@example.invalid`],
  );
  await expectDatabaseReject(
    `DELETE FROM lab_identity_mailbox_capabilities WHERE id = $1`,
    [initialMailboxCapabilityId],
  );

  const bearerOnCookieRoute = await app.inject({
    method: "GET",
    url: "/api/v1/security",
    headers: { authorization: `Bearer oss_lab_${randomUUID()}_${randomBytes(32).toString("base64url")}` },
  });
  assert.equal(bearerOnCookieRoute.statusCode, 400, bearerOnCookieRoute.body);
  assert.equal(json<{ code: string }>(bearerOnCookieRoute).code, "API_KEY_ROUTE_REQUIRED");

  const ambiguousCookieRoute = await app.inject({
    method: "GET",
    url: "/api/v1/security",
    headers: {
      cookie: session.cookie,
      authorization: `Bearer oss_lab_${randomUUID()}_${randomBytes(32).toString("base64url")}`,
    },
  });
  assert.equal(ambiguousCookieRoute.statusCode, 400, ambiguousCookieRoute.body);
  assert.equal(json<{ code: string }>(ambiguousCookieRoute).code, "AMBIGUOUS_AUTHENTICATION");

  const apiKeyIdempotencyKey = randomUUID();
  const createKey = await app.inject({
    method: "POST",
    url: "/api/v1/security/api-keys",
    headers: sessionHeaders(session),
    payload: {
      name: "Read and support key",
      scopes: ["support.write", "account.read", "support.read"] satisfies CustomerApiKeyScope[],
      idempotencyKey: apiKeyIdempotencyKey,
      password: primary.password,
    },
  });
  assert.equal(createKey.statusCode, 201, createKey.body);
  const keyBody = json<{ id: string; apiKey: string; scopes: string[] }>(createKey);
  assert.match(keyBody.apiKey, /^oss_lab_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(keyBody.scopes, ["account.read", "support.read", "support.write"]);
  const replayKey = await app.inject({
    method: "POST",
    url: "/api/v1/security/api-keys",
    headers: sessionHeaders(session),
    payload: {
      name: "Read and support key",
      scopes: ["support.read", "account.read", "support.write"],
      idempotencyKey: apiKeyIdempotencyKey,
      password: primary.password,
    },
  });
  assert.equal(replayKey.statusCode, 409, replayKey.body);
  assert.equal(json<{ code: string }>(replayKey).code, "SECRET_ALREADY_ISSUED");
  assert.equal(replayKey.body.includes(keyBody.apiKey), false);

  const keyRead = await app.inject({
    method: "GET",
    url: "/api/v1/customer-api/account",
    headers: { authorization: `Bearer ${keyBody.apiKey}` },
  });
  assert.equal(keyRead.statusCode, 200, keyRead.body);
  assert.equal(keyRead.headers["x-oss-authorization-epoch"], session.epoch);
  const ambiguousKeyRoute = await app.inject({
    method: "GET",
    url: "/api/v1/customer-api/account",
    headers: { authorization: `Bearer ${keyBody.apiKey}`, cookie: session.cookie },
  });
  assert.equal(ambiguousKeyRoute.statusCode, 400, ambiguousKeyRoute.body);

  await expectDatabaseReject(
    `INSERT INTO customer_api_keys(
       user_id, client_account_id, name, scopes, token_digest,
       idempotency_key, request_fingerprint
     ) VALUES ($1, $2, 'duplicate scopes',
               ARRAY['account.read','account.read']::text[], $3, $4, $5)`,
    [primary.userId, primary.accountId, randomBytes(32), randomUUID(), randomBytes(32)],
  );
  await expectDatabaseReject(
    `INSERT INTO customer_api_keys(
       user_id, client_account_id, name, scopes, token_digest,
       idempotency_key, request_fingerprint
     ) VALUES ($1, $2, 'unordered scopes',
               ARRAY['support.read','account.read']::text[], $3, $4, $5)`,
    [primary.userId, primary.accountId, randomBytes(32), randomUUID(), randomBytes(32)],
  );

  const enrollment = await app.inject({
    method: "POST",
    url: "/api/v1/security/totp/enroll",
    headers: sessionHeaders(session),
    payload: { password: primary.password, idempotencyKey: randomUUID() },
  });
  assert.equal(enrollment.statusCode, 201, enrollment.body);
  const enrollmentBody = json<{ challengeId: string; secret: string }>(enrollment);
  const databaseClock = await pool.query<{ now_ms: string }>(
    `SELECT pg_catalog.floor(
       extract(epoch FROM pg_catalog.clock_timestamp()) * 1000
     )::bigint::text AS now_ms`,
  );
  const nowMs = Number(databaseClock.rows[0]!.now_ms);
  const confirm = await app.inject({
    method: "POST",
    url: "/api/v1/security/totp/confirm",
    headers: sessionHeaders(session),
    payload: {
      challengeId: enrollmentBody.challengeId,
      code: totpCode(enrollmentBody.secret, nowMs - 30_000),
    },
  });
  assert.equal(confirm.statusCode, 201, confirm.body);
  assert.notEqual(confirm.headers["x-oss-authorization-epoch"], session.epoch);
  session = {
    ...session,
    mailboxCookie: mailboxCookie(confirm),
    epoch: String(confirm.headers["x-oss-authorization-epoch"]),
    contextVersion: String(confirm.headers["x-oss-account-context-version"]),
  };
  const enabledMailboxCapabilityId = await assertMailboxCapability(session, primary.email);
  assert.notEqual(enabledMailboxCapabilityId, initialMailboxCapabilityId);
  const retiredInitialMailbox = await pool.query<{ revoked: boolean }>(
    `SELECT revoked_at IS NOT NULL AS revoked
     FROM lab_identity_mailbox_capabilities WHERE id = $1`,
    [initialMailboxCapabilityId],
  );
  assert.equal(retiredInitialMailbox.rows[0]?.revoked, true);

  const challengeLogin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: primary.email, password: primary.password },
  });
  assert.equal(challengeLogin.statusCode, 202, challengeLogin.body);
  assert.equal(challengeLogin.headers["set-cookie"], undefined);
  const challenge = json<{
    challenge: { id: string; token: string };
  }>(challengeLogin).challenge;
  const completeChallenge = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login-challenges/complete",
    payload: {
      challengeId: challenge.id,
      challengeToken: challenge.token,
      factorCode: totpCode(enrollmentBody.secret, nowMs),
    },
  });
  assert.equal(completeChallenge.statusCode, 200, completeChallenge.body);
  assert.match(String(completeChallenge.headers["x-oss-authorization-epoch"]), /^\d+$/);
  let mfaSession = {
    cookie: cookie(completeChallenge),
    mailboxCookie: mailboxCookie(completeChallenge),
    epoch: String(completeChallenge.headers["x-oss-authorization-epoch"]),
    contextVersion: String(completeChallenge.headers["x-oss-account-context-version"]),
  };
  await assertMailboxCapability(mfaSession, primary.email);

  const replayLogin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: primary.email, password: primary.password },
  });
  assert.equal(replayLogin.statusCode, 202, replayLogin.body);
  const replayChallenge = json<{ challenge: { id: string; token: string } }>(replayLogin).challenge;
  const sameStepReplay = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login-challenges/complete",
    payload: {
      challengeId: replayChallenge.id,
      challengeToken: replayChallenge.token,
      factorCode: totpCode(enrollmentBody.secret, nowMs),
    },
  });
  assert.equal(sameStepReplay.statusCode, 401, sameStepReplay.body);

  const recoveryCodes = json<{ recoveryCodes: string[] }>(confirm).recoveryCodes;
  assert.ok(recoveryCodes[0]);
  const emailChange = await app.inject({
    method: "POST",
    url: "/api/v1/security/email-change/request",
    headers: sessionHeaders(mfaSession),
    payload: {
      requestedEmail: `changed-${databaseName}@example.invalid`,
      password: primary.password,
      factorCode: recoveryCodes[0],
    },
  });
  assert.equal(emailChange.statusCode, 202, emailChange.body);
  const emailNotification = await notificationToken("email_change");
  assert.equal(emailNotification.url.pathname, "/email-change");
  const recipient = await pool.query<{ recipient: string }>(
    "SELECT recipient::text FROM identity_notification_outbox WHERE id = $1",
    [emailNotification.outboxId],
  );
  assert.equal(recipient.rows[0]?.recipient, `changed-${databaseName}@example.invalid`);
  const finishEmail = await app.inject({
    method: "POST",
    url: "/api/v1/security/email-change/complete",
    headers: sessionHeaders(mfaSession),
    payload: { token: emailNotification.token },
  });
  assert.equal(finishEmail.statusCode, 204, finishEmail.body);
  mfaSession = {
    ...mfaSession,
    mailboxCookie: mailboxCookie(finishEmail),
    epoch: String(finishEmail.headers["x-oss-authorization-epoch"]),
    contextVersion: String(finishEmail.headers["x-oss-account-context-version"]),
  };
  await assertMailboxCapability(mfaSession, `changed-${databaseName}@example.invalid`);

  const disableTotp = await app.inject({
    method: "POST",
    url: "/api/v1/security/totp/disable",
    headers: sessionHeaders(mfaSession),
    payload: { password: primary.password, factorCode: recoveryCodes[1] },
  });
  assert.equal(disableTotp.statusCode, 204, disableTotp.body);
  mfaSession = {
    ...mfaSession,
    mailboxCookie: mailboxCookie(disableTotp),
    epoch: String(disableTotp.headers["x-oss-authorization-epoch"]),
    contextVersion: String(disableTotp.headers["x-oss-account-context-version"]),
  };
  await assertMailboxCapability(mfaSession, `changed-${databaseName}@example.invalid`);
  const reenrollment = await app.inject({
    method: "POST",
    url: "/api/v1/security/totp/enroll",
    headers: sessionHeaders(mfaSession),
    payload: { password: primary.password, idempotencyKey: randomUUID() },
  });
  assert.equal(reenrollment.statusCode, 201, reenrollment.body);
  const reenrollmentBody = json<{ challengeId: string; secret: string }>(reenrollment);
  const reenableClock = await pool.query<{ now_ms: string }>(
    `SELECT pg_catalog.floor(
       extract(epoch FROM pg_catalog.clock_timestamp()) * 1000
     )::bigint::text AS now_ms`,
  );
  const reenable = await app.inject({
    method: "POST",
    url: "/api/v1/security/totp/confirm",
    headers: sessionHeaders(mfaSession),
    payload: {
      challengeId: reenrollmentBody.challengeId,
      code: totpCode(reenrollmentBody.secret, Number(reenableClock.rows[0]!.now_ms)),
    },
  });
  assert.equal(reenable.statusCode, 201, reenable.body);
  mfaSession = {
    ...mfaSession,
    mailboxCookie: mailboxCookie(reenable),
    epoch: String(reenable.headers["x-oss-authorization-epoch"]),
    contextVersion: String(reenable.headers["x-oss-account-context-version"]),
  };
  await assertMailboxCapability(mfaSession, `changed-${databaseName}@example.invalid`);
  const credentialHistory = await pool.query<{ total: string; active: string }>(
    `SELECT pg_catalog.count(*)::text AS total,
            pg_catalog.count(*) FILTER (WHERE disabled_at IS NULL)::text AS active
     FROM user_totp_credentials WHERE user_id = $1`,
    [primary.userId],
  );
  assert.deepEqual(credentialHistory.rows[0], { total: "2", active: "1" });

  const primaryCredential = await pool.query<{ id: string }>(
    `SELECT id FROM user_totp_credentials
     WHERE user_id = $1 AND disabled_at IS NULL`,
    [primary.userId],
  );
  await expectDatabaseReject(
    `INSERT INTO identity_action_facts(
       user_id, actor_session_id, action, target_id, metadata
     ) VALUES ($1, NULL, 'password.recovered', $2,
               '{"revokedApiKeyCount":0,"revokedAllSessions":true,"extra":true}'::jsonb)`,
    [primary.userId, emailNotification.outboxId],
  );
  await expectDatabaseReject(
    `INSERT INTO identity_action_facts(
       user_id, actor_session_id, action, target_id
     ) VALUES ($1, NULL, 'totp.disabled', $2)`,
    [other.userId, primaryCredential.rows[0]!.id],
  );
  await expectDatabaseReject(
    `INSERT INTO identity_password_change_events(user_id) VALUES ($1)`,
    [primary.userId],
  );
  const otherLogin = await login(other);
  const otherPeerLogin = await login(other);
  const otherPeerToken = otherPeerLogin.cookie.slice(otherPeerLogin.cookie.indexOf("=") + 1);
  const otherPeerSession = await pool.query<{ id: string }>(
    "SELECT id FROM sessions WHERE token_digest = $1",
    [digestToken(otherPeerToken)],
  );
  assert.ok(otherPeerSession.rows[0]);
  const revokeOtherSession = await app.inject({
    method: "DELETE",
    url: `/api/v1/security/sessions/${otherPeerSession.rows[0].id}`,
    headers: sessionHeaders(otherLogin),
  });
  assert.equal(revokeOtherSession.statusCode, 204, revokeOtherSession.body);
  const initiallyRevoked = await pool.query<{ revoked_transaction_id: string }>(
    `INSERT INTO sessions(
       user_id, token_digest, expires_at, revoked_at
     ) VALUES (
       $1, $2, pg_catalog.clock_timestamp() + interval '1 hour',
       pg_catalog.clock_timestamp()
     ) RETURNING revoked_transaction_id::text`,
    [other.userId, randomBytes(32)],
  );
  assert.match(initiallyRevoked.rows[0]!.revoked_transaction_id, /^[1-9][0-9]*$/);
  await expectDatabaseReject(
    `INSERT INTO sessions(
       user_id, token_digest, expires_at, revoked_at, revoked_transaction_id
     ) VALUES (
       $1, $2, pg_catalog.clock_timestamp() + interval '1 hour',
       pg_catalog.clock_timestamp(), 1
     )`,
    [other.userId, randomBytes(32)],
  );
  const expiredActorSession = await pool.query<{ id: string }>(
    `INSERT INTO sessions(
       user_id, token_digest, expires_at, created_at
     ) VALUES (
       $1, $2, pg_catalog.clock_timestamp() - interval '1 hour',
       pg_catalog.clock_timestamp() - interval '2 hours'
     ) RETURNING id`,
    [other.userId, randomBytes(32)],
  );
  await expectDatabaseReject(
    `INSERT INTO identity_action_facts(
       user_id, actor_session_id, action, metadata
     ) VALUES (
       $1, $2, 'sessions.others_revoked',
       pg_catalog.jsonb_build_object('count', 0)
     )`,
    [other.userId, expiredActorSession.rows[0]!.id],
  );
  const primarySessionId = await pool.query<{ id: string }>(
    `SELECT id FROM sessions
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [primary.userId],
  );
  await expectDatabaseReject(
    `INSERT INTO identity_action_facts(user_id, actor_session_id, action)
     VALUES ($1, $2, 'password.changed')`,
    [other.userId, primarySessionId.rows[0]!.id],
  );
  await expectDatabaseReject(
    `INSERT INTO identity_action_facts(
       user_id, actor_session_id, action, target_id
     ) VALUES ($1, $2, 'session.revoked', $2)`,
    [primary.userId, primarySessionId.rows[0]!.id],
  );
  await expectDatabaseReject(
    `INSERT INTO identity_action_facts(
       user_id, actor_session_id, action, target_id
     ) VALUES ($1, $2, 'api_key.revoked', $3)`,
    [primary.userId, primarySessionId.rows[0]!.id, keyBody.id],
  );
  await expectDatabaseReject(
    `INSERT INTO identity_action_facts(
       user_id, actor_session_id, action, target_id, metadata
     ) VALUES (
       $1, $2, 'api_key.created', $3,
       pg_catalog.jsonb_build_object(
         'name', 'Read and support key'::text,
         'scopes', ARRAY['account.read','support.read','support.write']::text[]
       )
     )`,
    [primary.userId, primarySessionId.rows[0]!.id, keyBody.id],
  );

  const epochBeforeMembership = await pool.query<{
    authorization_epoch: string;
    account_context_version: string;
  }>(
    `SELECT principal.authorization_epoch::text,
            session_record.account_context_version::text
     FROM users principal
     JOIN sessions session_record ON session_record.user_id = principal.id
     WHERE principal.id = $1 AND session_record.id = $2`,
    [primary.userId, primarySessionId.rows[0]!.id],
  );
  await transaction(pool, async (client) => {
    await client.query(
      `SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [[primary.userId, other.userId].sort()],
    );
    await client.query(
      `SELECT id FROM sessions WHERE user_id = ANY($1::uuid[])
       ORDER BY id FOR UPDATE`,
      [[primary.userId, other.userId].sort()],
    );
    await client.query(
      `SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE`,
      [primary.accountId],
    );
    await client.query(
      `SELECT user_id FROM client_memberships
       WHERE client_account_id = $1 ORDER BY user_id FOR UPDATE`,
      [primary.accountId],
    );
    await client.query(
      `INSERT INTO client_memberships(
         client_account_id, user_id, role, permissions
       ) VALUES ($1, $2, 'owner', '["*"]'::jsonb)`,
      [primary.accountId, other.userId],
    );
    await client.query(
      `UPDATE client_accounts SET owner_user_id = $2 WHERE id = $1`,
      [primary.accountId, other.userId],
    );
    await client.query(
      `UPDATE client_memberships
       SET role = 'viewer', permissions = '[]'::jsonb,
           updated_at = pg_catalog.now()
       WHERE client_account_id = $1 AND user_id = $2`,
      [primary.accountId, primary.userId],
    );
  });
  const epochAfterMembership = await pool.query<{
    authorization_epoch: string;
    account_context_version: string;
  }>(
    `SELECT principal.authorization_epoch::text,
            session_record.account_context_version::text
     FROM users principal
     JOIN sessions session_record ON session_record.user_id = principal.id
     WHERE principal.id = $1 AND session_record.id = $2`,
    [primary.userId, primarySessionId.rows[0]!.id],
  );
  assert.ok(
    BigInt(epochAfterMembership.rows[0]!.authorization_epoch) >
      BigInt(epochBeforeMembership.rows[0]!.authorization_epoch),
  );
  assert.ok(
    BigInt(epochAfterMembership.rows[0]!.account_context_version) >
      BigInt(epochBeforeMembership.rows[0]!.account_context_version),
  );
  const permissionDowngradedKey = await app.inject({
    method: "GET",
    url: "/api/v1/customer-api/account",
    headers: { authorization: `Bearer ${keyBody.apiKey}` },
  });
  assert.equal(permissionDowngradedKey.statusCode, 403, permissionDowngradedKey.body);

  const staffEpochBefore = await pool.query<{ authorization_epoch: string }>(
    `SELECT authorization_epoch::text FROM users WHERE id = $1`,
    [other.userId],
  );
  await transaction(pool, async (client) => {
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [other.userId]);
    await client.query(
      `SELECT id FROM sessions WHERE user_id = $1 ORDER BY id FOR UPDATE`,
      [other.userId],
    );
    await client.query(
      `INSERT INTO staff_members(user_id, roles, permissions)
       VALUES ($1, ARRAY['billing'], '["billing.read"]'::jsonb)`,
      [other.userId],
    );
  });
  await transaction(pool, async (client) => {
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [other.userId]);
    await client.query(
      `SELECT id FROM sessions WHERE user_id = $1 ORDER BY id FOR UPDATE`,
      [other.userId],
    );
    await client.query(
      `UPDATE staff_members
       SET roles = ARRAY['viewer'], permissions = '[]'::jsonb,
           updated_at = pg_catalog.now()
       WHERE user_id = $1`,
      [other.userId],
    );
  });
  const staffEpochAfter = await pool.query<{ authorization_epoch: string }>(
    `SELECT authorization_epoch::text FROM users WHERE id = $1`,
    [other.userId],
  );
  assert.equal(
    BigInt(staffEpochAfter.rows[0]!.authorization_epoch),
    BigInt(staffEpochBefore.rows[0]!.authorization_epoch) + 2n,
  );

  const passwordRecovery = await app.inject({
    method: "POST",
    url: "/api/v1/auth/password-recovery/request",
    payload: { email: `changed-${databaseName}@example.invalid` },
  });
  assert.equal(passwordRecovery.statusCode, 202, passwordRecovery.body);
  const resetNotification = await notificationToken("password_recovery");
  assert.equal(resetNotification.url.pathname, "/password-recovery");
  await expectDatabaseReject(
    "DELETE FROM durable_jobs WHERE id = $1",
    [resetNotification.durableJobId],
  );

  const recoveryComplete = await app.inject({
    method: "POST",
    url: "/api/v1/auth/password-recovery/complete",
    headers: { cookie: mfaSession.cookie },
    payload: {
      token: resetNotification.token,
      newPassword: "Synthetic-recovered-password-024!",
    },
  });
  assert.equal(recoveryComplete.statusCode, 200, recoveryComplete.body);
  assert.equal(json<{ sessionEnded: boolean }>(recoveryComplete).sessionEnded, true);
  assert.match(String(recoveryComplete.headers["set-cookie"]), /Max-Age=0|Expires=/i);
  assert.match(String(recoveryComplete.headers["set-cookie"]), /oss_lab_identity_mailbox=/i);
  const revoked = await pool.query<{
    active_sessions: string;
    active_keys: string;
    active_mailbox_capabilities: string;
  }>(
    `SELECT
       (SELECT pg_catalog.count(*)::text FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL) AS active_sessions,
       (SELECT pg_catalog.count(*)::text
        FROM customer_api_keys api_key
        LEFT JOIN customer_api_key_revocations revocation
          ON revocation.api_key_id = api_key.id
        WHERE api_key.user_id = $1 AND revocation.api_key_id IS NULL) AS active_keys,
       (SELECT pg_catalog.count(*)::text
        FROM lab_identity_mailbox_capabilities capability
        WHERE capability.user_id = $1 AND capability.revoked_at IS NULL)
         AS active_mailbox_capabilities`,
    [primary.userId],
  );
  assert.deepEqual(revoked.rows[0], {
    active_sessions: "0",
    active_keys: "0",
    active_mailbox_capabilities: "0",
  });
  const revokedKeyUse = await app.inject({
    method: "GET",
    url: "/api/v1/customer-api/account",
    headers: { authorization: `Bearer ${keyBody.apiKey}` },
  });
  assert.equal(revokedKeyUse.statusCode, 401, revokedKeyUse.body);

  const terminateCurrent = await app.inject({
    method: "POST",
    url: "/api/v1/security/sessions/revoke-all",
    headers: sessionHeaders(otherLogin),
  });
  assert.equal(terminateCurrent.statusCode, 200, terminateCurrent.body);
  assert.equal(json<{ sessionEnded: boolean }>(terminateCurrent).sessionEnded, true);
  assert.match(String(terminateCurrent.headers["set-cookie"]), /oss_lab_identity_mailbox=.*Max-Age=0/i);
  const terminatedOtherSession = await pool.query<{ id: string }>(
    `SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NOT NULL
     ORDER BY revoked_at DESC, id DESC LIMIT 1`,
    [other.userId],
  );
  await expectDatabaseReject(
    `INSERT INTO identity_action_facts(
       user_id, actor_session_id, action, metadata
     ) VALUES (
       $1, $2, 'sessions.all_revoked',
       pg_catalog.jsonb_build_object('count', 0)
     )`,
    [other.userId, terminatedOtherSession.rows[0]!.id],
  );
  await expectDatabaseReject(
    `INSERT INTO identity_action_facts(
       user_id, actor_session_id, action, metadata
     ) VALUES (
       $1, $2, 'sessions.others_revoked',
       pg_catalog.jsonb_build_object('count', 0)
     )`,
    [other.userId, terminatedOtherSession.rows[0]!.id],
  );

  const userEpochBefore = await pool.query<{ authorization_epoch: string }>(
    `SELECT authorization_epoch::text FROM users WHERE id = $1`,
    [other.userId],
  );
  await pool.query(
    `UPDATE users SET email_verified_at = NULL, updated_at = pg_catalog.now()
     WHERE id = $1`,
    [other.userId],
  );
  await pool.query(
    `UPDATE users SET email_verified_at = pg_catalog.now(), updated_at = pg_catalog.now()
     WHERE id = $1`,
    [other.userId],
  );
  const userEpochAfter = await pool.query<{ authorization_epoch: string }>(
    `SELECT authorization_epoch::text FROM users WHERE id = $1`,
    [other.userId],
  );
  assert.equal(
    BigInt(userEpochAfter.rows[0]!.authorization_epoch),
    BigInt(userEpochBefore.rows[0]!.authorization_epoch) + 2n,
  );

  console.log(
    "Identity Security PostgreSQL 18/API integration: PASS — exact DB-clock sessions, normal and MFA login, one-step TOTP replay denial, fragment-only encrypted recovery/email links, display-once API keys, Cookie/Bearer isolation, canonical scopes, live usage/revocation, immutable exact action facts and durable-job bundles, email change, password recovery, and explicit Session ending.",
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
    ).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => undefined);
  } finally {
    await admin.end().catch(() => undefined);
  }
}
