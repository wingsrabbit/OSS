// SPDX-License-Identifier: AGPL-3.0-or-later

import { pathToFileURL } from "node:url";
import {
  decryptProviderTokenWithKeyring,
  digestProviderToken,
  encryptProviderToken,
  providerTokenKeyForVersion,
} from "@opensales/core/provider-token-vault";
import { loadConfig, paymentMethodTokenKeyrings, type Config } from "./config.js";
import {
  assertSchemaCompatible,
  createPool,
  registerPaymentMethodTokenKeyringsForRotation,
  transaction,
  tryLockPaymentMethodTokenRegistryExtension,
  type DatabasePool,
} from "./database.js";
import { requestFingerprint } from "./idempotency.js";

type RotationInput = Readonly<{
  actorId: string;
  reason: string;
  limit: number;
  confirmApiWorkerStopped: boolean;
}>;

type SavedMethodSecretRow = Readonly<{
  id: string;
  client_account_id: string;
  provider_token_ciphertext: string;
  encryption_key_version: number;
  lookup_key_version: number;
  version: number;
}>;

export type PaymentMethodTokenRotationResult = Readonly<{
  rotated: number;
  remaining: number;
  activeEncryptionKeyVersion: number;
  activeLookupKeyVersion: number;
}>;

function validateRotationInput(input: RotationInput): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_.@-]{2,119}$/.test(input.actorId)) {
    throw new Error("Rotation actor must be a stable 3-120 character operator identifier");
  }
  if (input.reason.length < 3 || input.reason.length > 500) {
    throw new Error("Rotation reason must contain 3-500 characters");
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
    throw new Error("Rotation batch limit must be an integer from 1 through 1000");
  }
}

export async function rewrapSavedPaymentMethodTokens(
  pool: DatabasePool,
  config: Config,
  input: RotationInput,
): Promise<PaymentMethodTokenRotationResult> {
  validateRotationInput(input);
  const keyrings = paymentMethodTokenKeyrings(config);
  const activeEncryptionKey = providerTokenKeyForVersion(
    keyrings.encryption,
    keyrings.encryption.activeVersion,
  );
  const activeLookupKey = providerTokenKeyForVersion(
    keyrings.lookup,
    keyrings.lookup.activeVersion,
  );

  return transaction(pool, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('opensales:payment-method-token-rewrap', 0))",
    );
    const registeredBefore = await client.query<{
      kind: "encryption" | "lookup";
      version: number;
    }>(
      `SELECT 'encryption'::text AS kind, version
       FROM payment_method_token_encryption_keys
       UNION ALL
       SELECT 'lookup'::text AS kind, version
       FROM payment_method_token_lookup_keys`,
    );
    const registeredEncryption = new Set(
      registeredBefore.rows
        .filter((row) => row.kind === "encryption")
        .map((row) => row.version),
    );
    const registeredLookup = new Set(
      registeredBefore.rows
        .filter((row) => row.kind === "lookup")
        .map((row) => row.version),
    );
    const registryExtensionRequired =
      [...keyrings.encryption.keys.keys()].some(
        (version) => !registeredEncryption.has(version),
      ) ||
      [...keyrings.lookup.keys.keys()].some(
        (version) => !registeredLookup.has(version),
      );
    if (registryExtensionRequired) {
      if (!input.confirmApiWorkerStopped) {
        throw new Error(
          "Registering a new token key version requires --confirm-api-worker-stopped",
        );
      }
      if (!(await tryLockPaymentMethodTokenRegistryExtension(client))) {
        throw new Error(
          "Refusing token key-version registration while an API or Worker process-lifetime guard remains",
        );
      }
      // A legacy process may predate both advisory guards. Drain every token
      // INSERT/UPDATE transaction that already acquired RowExclusiveLock, then
      // keep later writers behind this transaction until the new registry and
      // every selected old row commit together. A writer released afterward
      // sees the new maximum versions and fails closed in the DB trigger.
      await client.query(
        "LOCK TABLE saved_payment_methods IN SHARE ROW EXCLUSIVE MODE",
      );
      const activeApplications = await client.query<{
        application_name: string;
        count: string;
      }>(
        `SELECT application_name, count(*)::text AS count
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND application_name IN ('opensales-api', 'opensales-worker')
         GROUP BY application_name
         ORDER BY application_name`,
      );
      if (activeApplications.rows.length > 0) {
        throw new Error(
          `Refusing first key-version registration while API or Worker database sessions remain: ${activeApplications.rows
            .map((row) => `${row.application_name}=${row.count}`)
            .join(", ")}`,
        );
      }
    }
    const registeredVersions = await registerPaymentMethodTokenKeyringsForRotation(
      client,
      config,
    );
    const registeredNewVersion =
      registeredVersions.encryptionVersions.length > 0 ||
      registeredVersions.lookupVersions.length > 0;
    if (registeredNewVersion) {
      if (!registryExtensionRequired) {
        throw new Error("Token key registry changed without an authorized extension fence");
      }
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, reason, metadata
         ) VALUES (
           'system', $1, 'payment_method.token_key_versions_registered',
           'payment_method_token_keyring', 'provider-token-vault', $2, $3
         )`,
        [
          input.actorId,
          input.reason,
          {
            encryptionVersions: registeredVersions.encryptionVersions,
            lookupVersions: registeredVersions.lookupVersions,
          },
        ],
      );
    }
    await client.query("SELECT set_config('opensales.payment_method_rewrap', 'authorized', true)");
    const candidates = await client.query<SavedMethodSecretRow>(
      `SELECT id, client_account_id, provider_token_ciphertext,
              encryption_key_version, lookup_key_version, version
       FROM saved_payment_methods
       WHERE encryption_key_version <> $1
          OR lookup_key_version <> $2
          OR provider_token_ciphertext LIKE 'v1.%'
       ORDER BY id
       LIMIT $3
       FOR UPDATE`,
      [keyrings.encryption.activeVersion, keyrings.lookup.activeVersion, input.limit],
    );

    let rotated = 0;
    for (const method of candidates.rows) {
      if (
        method.encryption_key_version > keyrings.encryption.activeVersion ||
        method.lookup_key_version > keyrings.lookup.activeVersion
      ) {
        throw new Error(`Saved payment method ${method.id} would require a prohibited key downgrade`);
      }
      const providerToken = decryptProviderTokenWithKeyring(
        method.provider_token_ciphertext,
        method.encryption_key_version,
        keyrings.encryption,
      );
      const nextCiphertext = encryptProviderToken(
        providerToken,
        activeEncryptionKey,
        keyrings.encryption.activeVersion,
      );
      const nextDigest = digestProviderToken(providerToken, activeLookupKey);
      const updated = await client.query<{ id: string }>(
        `UPDATE saved_payment_methods
         SET provider_token_ciphertext = $2,
             provider_token_digest = $3,
             encryption_key_version = $4,
             lookup_key_version = $5,
             version = version + 1,
             updated_at = clock_timestamp()
         WHERE id = $1 AND version = $6
         RETURNING id`,
        [
          method.id,
          nextCiphertext,
          nextDigest,
          keyrings.encryption.activeVersion,
          keyrings.lookup.activeVersion,
          method.version,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new Error(`Saved payment method ${method.id} changed during token rewrap`);
      }

      const auditShape = {
        savedPaymentMethodId: method.id,
        fromEncryptionKeyVersion: method.encryption_key_version,
        toEncryptionKeyVersion: keyrings.encryption.activeVersion,
        fromLookupKeyVersion: method.lookup_key_version,
        toLookupKeyVersion: keyrings.lookup.activeVersion,
      };
      const idempotencyKey = [
        "token-rewrap",
        method.id,
        method.version,
        keyrings.encryption.activeVersion,
        keyrings.lookup.activeVersion,
      ].join(":");
      await client.query(
        `INSERT INTO payment_consent_events(
           client_account_id, saved_payment_method_id, event_type,
           actor_type, actor_id, reason, idempotency_key,
           request_fingerprint, result, metadata
         ) VALUES (
           $1, $2, 'token_rewrapped', 'system', $3, $4, $5, $6,
           '{"rewrapped":true}'::jsonb, $7
         )`,
        [
          method.client_account_id,
          method.id,
          input.actorId,
          input.reason,
          idempotencyKey,
          requestFingerprint("payment-method-token-rewrap:v1", auditShape),
          auditShape,
        ],
      );
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, reason, metadata
         ) VALUES ('system', $1, 'payment_method.token_rewrapped',
                   'saved_payment_method', $2, $3, $4)`,
        [input.actorId, method.id, input.reason, auditShape],
      );
      rotated += 1;
    }

    const remainingResult = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM saved_payment_methods
       WHERE encryption_key_version <> $1
          OR lookup_key_version <> $2
          OR provider_token_ciphertext LIKE 'v1.%'`,
      [keyrings.encryption.activeVersion, keyrings.lookup.activeVersion],
    );
    return {
      rotated,
      remaining: Number(remainingResult.rows[0]?.count ?? "0"),
      activeEncryptionKeyVersion: keyrings.encryption.activeVersion,
      activeLookupKeyVersion: keyrings.lookup.activeVersion,
    };
  });
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const position = args.indexOf(name);
  return position >= 0 ? args[position + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes("--confirm-rewrap")) {
    throw new Error("Refusing to rewrap tokens without --confirm-rewrap");
  }
  const actorId = optionValue(args, "--actor");
  const reason = optionValue(args, "--reason");
  if (!actorId || !reason) {
    throw new Error("Usage requires --actor <stable-id> --reason <reason> --confirm-rewrap");
  }
  const limitText = optionValue(args, "--limit") ?? "100";
  if (!/^\d+$/.test(limitText)) throw new Error("--limit must be a positive integer");

  const config = loadConfig();
  const pool = createPool(config, "opensales-token-rotation");
  try {
    await assertSchemaCompatible(pool);
    const result = await rewrapSavedPaymentMethodTokens(pool, config, {
      actorId,
      reason,
      limit: Number(limitText),
      confirmApiWorkerStopped: args.includes("--confirm-api-worker-stopped"),
    });
    // This output intentionally contains counts and key versions only, never a token or key.
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
