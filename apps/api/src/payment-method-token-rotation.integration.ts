// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  createProviderTokenKeyring,
  decryptProviderToken,
  digestProviderToken,
  digestProviderTokenCandidates,
  encryptProviderToken,
} from "@opensales/core/provider-token-vault";
import pg from "pg";
import type { Config } from "./config.js";
import {
  assertPaymentMethodTokenKeyringsCompatible,
  bootstrapPaymentMethodTokenKeyrings,
  createPool,
  holdPaymentMethodTokenRegistryExtensionGuard,
  runMigrations,
} from "./database.js";
import { rewrapSavedPaymentMethodTokens } from "./rotate-payment-method-token-keys.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for payment token rotation integration");

const oldEncryptionKey = Buffer.alloc(32, 21).toString("base64url");
const newEncryptionKey = Buffer.alloc(32, 22).toString("base64url");
const oldLookupKey = Buffer.alloc(32, 23).toString("base64url");
const newLookupKey = Buffer.alloc(32, 24).toString("base64url");
const providerToken = "synthetic-mock-provider-payment-token-rotation";

function legacyCiphertext(token: string, encodedKey: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(encodedKey, "base64url"), nonce);
  cipher.setAAD(Buffer.from("opensales:saved-payment-method:v1", "utf8"));
  const payload = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [
    "v1",
    nonce.toString("base64url"),
    payload.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

const config: Config = {
  DATABASE_URL: databaseUrl,
  OSS_ENV: "test",
  OSS_PUBLIC_URL: "http://127.0.0.1:3000",
  API_HOST: "127.0.0.1",
  API_PORT: 3000,
  GLOBAL_RATE_LIMIT_MAX: 100,
  SESSION_COOKIE_NAME: "oss_session",
  SESSION_TTL_HOURS: 24,
  VERIFICATION_TTL_MINUTES: 30,
  WEB_ORIGIN: "http://127.0.0.1:5173",
  MOCK_MAILBOX_URL: "http://127.0.0.1:4000",
  LAB_MAILBOX_TOKEN: "synthetic-mailbox-token-for-rotation-test",
  PROVIDER_OPERATION_CAPABILITY_SECRET: "synthetic-capability-secret-for-rotation-test",
  PAYMENT_METHOD_TOKEN_KEY: newEncryptionKey,
  PAYMENT_METHOD_TOKEN_KEY_VERSION: 2,
  PAYMENT_METHOD_TOKEN_PREVIOUS_KEYS: `1:${oldEncryptionKey}`,
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY: newLookupKey,
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY_VERSION: 2,
  PAYMENT_METHOD_TOKEN_LOOKUP_PREVIOUS_KEYS: `1:${oldLookupKey}`,
  IDENTITY_SECRET_KEY: Buffer.alloc(32, 35).toString("base64url"),
  MOCK_PAYMENT_WEBHOOK_SECRET: "synthetic-payment-webhook-secret-for-rotation-test",
  MOCK_PROVISIONING_WEBHOOK_SECRET:
    "synthetic-provision-webhook-secret-for-rotation-test",
  NOTIFICATION_MAX_ATTEMPTS: 3,
  LAB_MAILBOX_ENABLED: false,
};
const {
  PAYMENT_METHOD_TOKEN_PREVIOUS_KEYS: _oldEncryptionKeys,
  PAYMENT_METHOD_TOKEN_LOOKUP_PREVIOUS_KEYS: _oldLookupKeys,
  ...v2OnlyConfig
} = config;
const v1Config: Config = {
  ...config,
  PAYMENT_METHOD_TOKEN_KEY: oldEncryptionKey,
  PAYMENT_METHOD_TOKEN_KEY_VERSION: 1,
  PAYMENT_METHOD_TOKEN_PREVIOUS_KEYS: undefined,
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY: oldLookupKey,
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY_VERSION: 1,
  PAYMENT_METHOD_TOKEN_LOOKUP_PREVIOUS_KEYS: undefined,
};

const pool = createPool(config, "opensales-token-rotation-integration");
try {
  await runMigrations(pool);
  await bootstrapPaymentMethodTokenKeyrings(pool, v1Config);
  await assertPaymentMethodTokenKeyringsCompatible(pool, v1Config);
  await assert.rejects(
    assertPaymentMethodTokenKeyringsCompatible(pool, {
      ...v1Config,
      PAYMENT_METHOD_TOKEN_KEY: Buffer.alloc(32, 31).toString("base64url"),
    }),
    /encryption key material does not match registered version 1/,
  );
  await assert.rejects(
    assertPaymentMethodTokenKeyringsCompatible(pool, {
      ...v1Config,
      PAYMENT_METHOD_TOKEN_LOOKUP_KEY: Buffer.alloc(32, 32).toString("base64url"),
    }),
    /lookup key material does not match registered version 1/,
  );
  const seed = await pool.connect();
  let methodId = "";
  let accountId = "";
  let userId = "";
  try {
    await seed.query("BEGIN");
    const user = await seed.query<{ id: string }>(
      `INSERT INTO users(email, password_hash, email_verified_at)
       VALUES ('rotation-integration@example.invalid', 'synthetic-password-hash', now())
       RETURNING id`,
    );
    userId = user.rows[0]?.id ?? "";
    if (!userId) throw new Error("Unable to seed rotation integration user");
    const account = await seed.query<{ id: string }>(
      `INSERT INTO client_accounts(name, owner_user_id)
       VALUES ('Synthetic Rotation Account', $1)
       RETURNING id`,
      [userId],
    );
    accountId = account.rows[0]?.id ?? "";
    if (!accountId) throw new Error("Unable to seed rotation integration account");
    await seed.query(
      `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
       VALUES ($1, $2, 'owner', '[]'::jsonb)`,
      [accountId, userId],
    );
    await seed.query(
      `INSERT INTO provider_installation_capabilities(
         provider_installation_id, provider_type, enabled, capabilities
       ) VALUES (
         'mock-payment-v1', 'payment', true,
         '["payment_method_setup","payment_create","payment_reconcile","payment_off_session"]'::jsonb
       )`,
    );
    await seed.query(
      `INSERT INTO payment_methods(
         code, display_name, provider_installation_id, fee_basis_points,
         saved_method_enabled, automatic_renewal_enabled
       ) VALUES (
         'mock_card_rotation', '{"en":"Synthetic card"}'::jsonb,
         'mock-payment-v1', 350, true, true
       )`,
    );
    const method = await seed.query<{ id: string }>(
      `INSERT INTO saved_payment_methods(
         client_account_id, provider_installation_id, payment_method_code,
         provider_token_ciphertext, provider_token_digest,
         encryption_key_version, lookup_key_version,
         instrument_type, brand, last_four, expiry_month, expiry_year,
         save_consent_version, saved_by_user_id
       ) VALUES (
         $1, 'mock-payment-v1', 'mock_card_rotation', $2, $3, 1, 1,
         'card', 'Synthetic', '4242', 12, 2099, 'save-v1', $4
       ) RETURNING id`,
      [
        accountId,
        legacyCiphertext(providerToken, oldEncryptionKey),
        digestProviderToken(providerToken, oldLookupKey),
        userId,
      ],
    );
    methodId = method.rows[0]?.id ?? "";
    assert.ok(methodId);
    await seed.query("COMMIT");
  } catch (error) {
    await seed.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    seed.release();
  }

  const dualReadCandidates = digestProviderTokenCandidates(
    providerToken,
    createProviderTokenKeyring(2, newLookupKey, `1:${oldLookupKey}`),
  );
  const oldDigestMatch = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM saved_payment_methods
     WHERE provider_installation_id = 'mock-payment-v1'
       AND provider_token_digest = ANY($1::bytea[])`,
    [dualReadCandidates.map(({ digest }) => digest)],
  );
  assert.equal(oldDigestMatch.rows[0]?.count, "1");
  await assert.rejects(
    assertPaymentMethodTokenKeyringsCompatible(pool, config),
    /key version 2 is not registered/,
    "readiness cannot register a newly configured key version as a side effect",
  );

  await assert.rejects(
    pool.query(
      `UPDATE saved_payment_methods
       SET provider_token_ciphertext = $2, version = version + 1, updated_at = clock_timestamp()
       WHERE id = $1`,
      [methodId, encryptProviderToken(providerToken, newEncryptionKey, 2)],
    ),
    /rewrap is not authorized or monotonic/,
  );

  await assert.rejects(
    rewrapSavedPaymentMethodTokens(pool, config, {
      actorId: "integration-key-rotation",
      reason: "synthetic missing offline confirmation",
      limit: 100,
      confirmApiWorkerStopped: false,
    }),
    /requires --confirm-api-worker-stopped/,
  );
  const simulatedApiPool = new pg.Pool({
    connectionString: databaseUrl,
    application_name: "opensales-api",
    idleTimeoutMillis: 1,
  });
  const releaseSimulatedApiGuard =
    await holdPaymentMethodTokenRegistryExtensionGuard(simulatedApiPool);
  try {
    await assert.rejects(
      rewrapSavedPaymentMethodTokens(pool, config, {
        actorId: "integration-key-rotation",
        reason: "synthetic live API lifetime-guard refusal",
        limit: 100,
        confirmApiWorkerStopped: true,
      }),
      /API or Worker process-lifetime guard remains/,
    );
  } finally {
    await releaseSimulatedApiGuard();
    await simulatedApiPool.end();
  }
  const registryAfterRefusals = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM payment_method_token_encryption_keys
     WHERE version = 2`,
  );
  assert.equal(
    registryAfterRefusals.rows[0]?.count,
    "0",
    "a refused first rotation must roll back new key registration",
  );

  const reader = await pool.connect();
  const legacyWriterPool = new pg.Pool({
    connectionString: databaseUrl,
    application_name: "synthetic-legacy-token-writer",
  });
  const legacyWriter = await legacyWriterPool.connect();
  let rotationSettled = false;
  let readerTransactionOpen = false;
  let legacyWriterTransactionOpen = false;
  let first!: Awaited<ReturnType<typeof rewrapSavedPaymentMethodTokens>>;
  try {
    await reader.query("BEGIN");
    readerTransactionOpen = true;
    await reader.query(
      "SELECT pg_advisory_xact_lock_shared(hashtextextended('opensales:payment-method-token-rewrap', 0))",
    );
    await reader.query("SELECT id FROM saved_payment_methods WHERE id = $1 FOR UPDATE", [methodId]);
    const interleavedProviderToken = `${providerToken}-interleaved-legacy-writer`;
    await legacyWriter.query("BEGIN");
    legacyWriterTransactionOpen = true;
    await legacyWriter.query(
      `INSERT INTO saved_payment_methods(
         client_account_id, provider_installation_id, payment_method_code,
         provider_token_ciphertext, provider_token_digest,
         encryption_key_version, lookup_key_version,
         instrument_type, brand, last_four, expiry_month, expiry_year,
         save_consent_version, saved_by_user_id
       ) VALUES (
         $1, 'mock-payment-v1', 'mock_card_rotation', $2, $3, 1, 1,
         'card', 'Interleaved Legacy Writer', '2222', 12, 2099, 'save-v1', $4
       )`,
      [
        accountId,
        legacyCiphertext(interleavedProviderToken, oldEncryptionKey),
        digestProviderToken(interleavedProviderToken, oldLookupKey),
        userId,
      ],
    );
    const rotationPromise = rewrapSavedPaymentMethodTokens(pool, config, {
      actorId: "integration-key-rotation",
      reason: "synthetic integration rotation",
      limit: 100,
      confirmApiWorkerStopped: true,
    });
    void rotationPromise.finally(() => {
      rotationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      rotationSettled,
      false,
      "exclusive rotation must first wait outside the saved-method reader lock",
    );
    await reader.query("COMMIT");
    readerTransactionOpen = false;
    let observedLegacyWriterFence = false;
    for (let poll = 0; poll < 200 && !observedLegacyWriterFence; poll += 1) {
      const waiting = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND application_name = 'opensales-token-rotation-integration'
           AND wait_event_type = 'Lock'
           AND query = 'LOCK TABLE saved_payment_methods IN SHARE ROW EXCLUSIVE MODE'`,
      );
      observedLegacyWriterFence = waiting.rows[0]?.count !== "0";
      if (!observedLegacyWriterFence) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.equal(
      observedLegacyWriterFence,
      true,
      "first registry extension must wait for an unguarded legacy token writer",
    );
    assert.equal(rotationSettled, false);
    await legacyWriter.query("COMMIT");
    legacyWriterTransactionOpen = false;
    first = await rotationPromise;
  } catch (error) {
    if (readerTransactionOpen) {
      await reader.query("ROLLBACK").catch(() => undefined);
    }
    if (legacyWriterTransactionOpen) {
      await legacyWriter.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    reader.release();
    legacyWriter.release();
    await legacyWriterPool.end();
  }
  assert.equal(first.rotated, 2);
  assert.equal(first.remaining, 0);
  const staleProviderToken = `${providerToken}-stale-writer`;
  await assert.rejects(
    pool.query(
      `INSERT INTO saved_payment_methods(
         client_account_id, provider_installation_id, payment_method_code,
         provider_token_ciphertext, provider_token_digest,
         encryption_key_version, lookup_key_version,
         instrument_type, brand, last_four, expiry_month, expiry_year,
         save_consent_version, saved_by_user_id
       ) VALUES (
         $1, 'mock-payment-v1', 'mock_card_rotation', $2, $3, 1, 1,
         'card', 'Stale Writer', '1111', 12, 2099, 'save-v1', $4
       )`,
      [
        accountId,
        legacyCiphertext(staleProviderToken, oldEncryptionKey),
        digestProviderToken(staleProviderToken, oldLookupKey),
        userId,
      ],
    ),
    /must use the active token key versions/,
    "a live legacy writer must fail closed after a newer version is registered",
  );
  await assert.rejects(
    assertPaymentMethodTokenKeyringsCompatible(pool, v1Config),
    /active version is older than registered version 2/,
    "a process cannot roll back after an explicitly confirmed rotation registered version 2",
  );
  await assert.rejects(
    rewrapSavedPaymentMethodTokens(
      pool,
      {
        ...config,
        PAYMENT_METHOD_TOKEN_KEY: oldEncryptionKey,
        PAYMENT_METHOD_TOKEN_KEY_VERSION: 3,
        PAYMENT_METHOD_TOKEN_PREVIOUS_KEYS: `2:${newEncryptionKey}`,
        PAYMENT_METHOD_TOKEN_LOOKUP_KEY: Buffer.alloc(32, 33).toString("base64url"),
        PAYMENT_METHOD_TOKEN_LOOKUP_KEY_VERSION: 3,
        PAYMENT_METHOD_TOKEN_LOOKUP_PREVIOUS_KEYS: `2:${newLookupKey}`,
      },
      {
        actorId: "integration-key-rotation",
        reason: "synthetic prohibited historical material reuse",
        limit: 100,
        confirmApiWorkerStopped: true,
      },
    ),
    /key material cannot be reused for encryption version 3/,
    "material registered for an old version cannot be reintroduced under a new version",
  );
  await assert.rejects(
    rewrapSavedPaymentMethodTokens(
      pool,
      {
        ...config,
        PAYMENT_METHOD_TOKEN_KEY: Buffer.alloc(32, 34).toString("base64url"),
        PAYMENT_METHOD_TOKEN_KEY_VERSION: 3,
        PAYMENT_METHOD_TOKEN_PREVIOUS_KEYS: `2:${newEncryptionKey}`,
        PAYMENT_METHOD_TOKEN_LOOKUP_KEY: oldEncryptionKey,
        PAYMENT_METHOD_TOKEN_LOOKUP_KEY_VERSION: 3,
        PAYMENT_METHOD_TOKEN_LOOKUP_PREVIOUS_KEYS: `2:${newLookupKey}`,
      },
      {
        actorId: "integration-key-rotation",
        reason: "synthetic prohibited historical cross-purpose reuse",
        limit: 100,
        confirmApiWorkerStopped: true,
      },
    ),
    /key material cannot be reused for lookup version 3/,
    "historical encryption material cannot be reused later as a lookup key",
  );

  const stored = await pool.query<{
    provider_token_ciphertext: string;
    provider_token_digest: Buffer;
    encryption_key_version: number;
    lookup_key_version: number;
    version: number;
  }>(
    `SELECT provider_token_ciphertext, provider_token_digest,
            encryption_key_version, lookup_key_version, version
     FROM saved_payment_methods WHERE id = $1`,
    [methodId],
  );
  const rotated = stored.rows[0];
  assert.ok(rotated);
  assert.equal(rotated.encryption_key_version, 2);
  assert.equal(rotated.lookup_key_version, 2);
  assert.equal(rotated.version, 2);
  assert.equal(decryptProviderToken(rotated.provider_token_ciphertext, newEncryptionKey, 2), providerToken);
  assert.ok(!rotated.provider_token_ciphertext.includes(providerToken));
  assert.deepEqual(rotated.provider_token_digest, digestProviderToken(providerToken, newLookupKey));
  await assert.doesNotReject(
    assertPaymentMethodTokenKeyringsCompatible(pool, v2OnlyConfig),
    "old keys may be removed only after every stored row uses the active versions",
  );

  const audit = await pool.query<{
    consent_events: string;
    audit_events: string;
    key_registration_events: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM payment_consent_events
        WHERE saved_payment_method_id = $1 AND event_type = 'token_rewrapped') AS consent_events,
       (SELECT count(*)::text FROM audit_events
        WHERE target_id = $1::text AND action = 'payment_method.token_rewrapped') AS audit_events,
       (SELECT count(*)::text FROM audit_events
        WHERE target_id = 'provider-token-vault'
          AND action = 'payment_method.token_key_versions_registered') AS key_registration_events`,
    [methodId],
  );
  assert.deepEqual(audit.rows[0], {
    consent_events: "1",
    audit_events: "1",
    key_registration_events: "1",
  });

  const replay = await rewrapSavedPaymentMethodTokens(pool, config, {
    actorId: "integration-key-rotation",
    reason: "synthetic integration rotation",
    limit: 100,
    confirmApiWorkerStopped: false,
  });
  assert.equal(replay.rotated, 0);
  assert.equal(replay.remaining, 0);

  process.stdout.write(
    `${JSON.stringify({
      rotated: first.rotated,
      remaining: first.remaining,
      replayRotated: replay.rotated,
      oldDigestMatchedDuringDualRead: oldDigestMatch.rows[0]?.count === "1",
      encryptionKeyVersion: rotated.encryption_key_version,
      lookupKeyVersion: rotated.lookup_key_version,
      consentEvents: audit.rows[0]?.consent_events,
      auditEvents: audit.rows[0]?.audit_events,
      keyRegistrationEvents: audit.rows[0]?.key_registration_events,
      plaintextAbsentFromCiphertext: !rotated.provider_token_ciphertext.includes(providerToken),
    })}\n`,
  );
} finally {
  await pool.end();
}
