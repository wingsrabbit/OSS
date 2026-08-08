// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertProviderTokenKeyringCoversVersions,
  fingerprintProviderTokenKey,
  fingerprintProviderTokenKeyMaterial,
  type ProviderTokenKeyring,
} from "@opensales/core/provider-token-vault";
import {
  assert014RollbackBridgeSafe,
  type SchemaRollbackPreflightReport,
} from "@opensales/core/schema-rollback-compatibility";
import {
  assert015RollbackBridgeSafe,
  SCHEMA_015_016_GUARD,
  type Schema015RollbackPreflightReport,
} from "@opensales/core/schema-015-016-rollback-compatibility";
import pg from "pg";
import { paymentMethodTokenKeyrings, type Config } from "./config.js";

const { Pool } = pg;
export type DatabasePool = pg.Pool;
export type DatabaseClient = pg.PoolClient;
export const REQUIRED_SCHEMA_VERSION = "015_stage_b_saved_payment_auto_renew";
const TOKEN_REGISTRY_EXTENSION_GUARD =
  "opensales:payment-method-token-registry-extension";

export function createPool(
  config: Config,
  applicationName = "opensales-api",
): DatabasePool {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: 20,
    statement_timeout: 15_000,
    query_timeout: 20_000,
    application_name: applicationName,
  });
}

export async function transaction<T>(
  pool: DatabasePool,
  work: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function holdPaymentMethodTokenRegistryExtensionGuard(
  pool: DatabasePool,
): Promise<() => Promise<void>> {
  const client = await pool.connect();
  let held = false;
  try {
    await client.query(
      "SELECT pg_advisory_lock_shared(hashtextextended($1, 0))",
      [TOKEN_REGISTRY_EXTENSION_GUARD],
    );
    held = true;
  } catch (error) {
    client.release(error instanceof Error ? error : true);
    throw error;
  }
  return async () => {
    if (!held) return;
    held = false;
    try {
      const result = await client.query<{ unlocked: boolean }>(
        "SELECT pg_advisory_unlock_shared(hashtextextended($1, 0)) AS unlocked",
        [TOKEN_REGISTRY_EXTENSION_GUARD],
      );
      if (result.rows[0]?.unlocked !== true) {
        throw new Error("Payment token registry extension guard was not held by its session");
      }
      client.release();
    } catch (error) {
      client.release(error instanceof Error ? error : true);
      throw error;
    }
  };
}

async function releaseGuardClient(
  client: DatabaseClient,
  guard: string,
): Promise<void> {
  try {
    const result = await client.query<{ unlocked: boolean }>(
      "SELECT pg_advisory_unlock_shared(hashtextextended($1, 0)) AS unlocked",
      [guard],
    );
    if (result.rows[0]?.unlocked !== true) {
      throw new Error(`Schema compatibility guard ${guard} was not held by its session`);
    }
    client.release();
  } catch (error) {
    client.release(error instanceof Error ? error : true);
    throw error;
  }
}

export async function holdSchema015RollbackBridgeGuard(
  pool: DatabasePool,
): Promise<() => Promise<void>> {
  const client = await pool.connect();
  let held = false;
  try {
    await client.query("SET lock_timeout = '15s'");
    await client.query("SELECT pg_advisory_lock_shared(hashtextextended($1, 0))", [
      SCHEMA_015_016_GUARD,
    ]);
    await client.query("RESET lock_timeout");
    held = true;
  } catch (error) {
    client.release(error instanceof Error ? error : true);
    throw error;
  }
  return async () => {
    if (!held) return;
    held = false;
    await releaseGuardClient(client, SCHEMA_015_016_GUARD);
  };
}

export async function tryLockPaymentMethodTokenRegistryExtension(
  client: DatabaseClient,
): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked",
    [TOKEN_REGISTRY_EXTENSION_GUARD],
  );
  return result.rows[0]?.locked === true;
}

export async function runMigrations(pool: DatabasePool): Promise<void> {
  const client = await pool.connect();
  let migrationLockHeld = false;
  let compatibilityLockHeld = false;
  let failed = false;
  let failure: unknown;
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtextextended('opensales:schema-migrations', 0))",
    );
    migrationLockHeld = true;
    const compatibilityGuard = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [SCHEMA_015_016_GUARD],
    );
    if (compatibilityGuard.rows[0]?.locked !== true) {
      throw new Error(
        "Schema migration is blocked by a running compatibility-bridge API or Worker; stop every application process before migrating",
      );
    }
    compatibilityLockHeld = true;
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
      .sort();
    for (const migrationFile of migrationFiles) {
      const version = migrationFile.replace(/\.sql$/, "");
      const migration = await readFile(resolve(migrationsDirectory, migrationFile), "utf8");
      await client.query("BEGIN");
      try {
        const existing = await client.query<{ version: string }>(
          "SELECT version FROM schema_migrations WHERE version = $1",
          [version],
        );
        if (existing.rowCount === 0) {
          await client.query(migration);
          await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } catch (error) {
    failed = true;
    failure = error;
  }

  const cleanupErrors: unknown[] = [];
  let discardClient = false;
  const unlock = async (query: string, values?: unknown[]): Promise<void> => {
    try {
      const result = await client.query<{ unlocked: boolean }>(query, values);
      if (result.rows[0]?.unlocked !== true) {
        throw new Error("Database migration advisory lock was not held by its session");
      }
    } catch (error) {
      cleanupErrors.push(error);
      discardClient = true;
    }
  };
  if (compatibilityLockHeld) {
    await unlock("SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked", [
      SCHEMA_015_016_GUARD,
    ]);
  }
  if (migrationLockHeld) {
    await unlock(
      "SELECT pg_advisory_unlock(hashtextextended('opensales:schema-migrations', 0)) AS unlocked",
    );
  }
  client.release(discardClient ? true : undefined);

  if (failed && cleanupErrors.length > 0) {
    throw new AggregateError(
      [failure, ...cleanupErrors],
      "Schema migration failed and advisory-lock cleanup also failed",
    );
  }
  if (failed) throw failure;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Schema migration advisory-lock cleanup failed");
  }
}

export async function assertSchemaCompatible(
  pool: DatabasePool,
  input: Readonly<{ enable016RollbackBridge?: boolean }> = {},
): Promise<Schema015RollbackPreflightReport> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const report = await assert015RollbackBridgeSafe(
      {
        query: async (text, values) => client.query(text, values),
      },
      { enable016RollbackBridge: input.enable016RollbackBridge === true },
    );
    await client.query("COMMIT");
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function assert014RollbackSchemaCompatible(
  pool: DatabasePool,
  input: Readonly<{ enable015RollbackBridge: boolean }>,
): Promise<SchemaRollbackPreflightReport> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const report = await assert014RollbackBridgeSafe(
      {
        query: async (text, values) => client.query(text, values),
      },
      { enable015RollbackBridge: input.enable015RollbackBridge },
    );
    await client.query("COMMIT");
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type PaymentMethodTokenKeyTable =
  | "payment_method_token_encryption_keys"
  | "payment_method_token_lookup_keys";

async function registerTokenKeyring(
  client: DatabaseClient,
  table: PaymentMethodTokenKeyTable,
  keyring: ProviderTokenKeyring,
  kind: "encryption" | "lookup",
): Promise<number[]> {
  const registeredVersions: number[] = [];
  for (const [version, key] of keyring.keys) {
    const materialFingerprint = fingerprintProviderTokenKeyMaterial(key);
    await client.query(
      `INSERT INTO payment_method_token_key_materials(
         material_fingerprint, key_kind, key_version
       ) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [materialFingerprint, kind, version],
    );
    const materialRegistration = await client.query<{
      key_kind: "encryption" | "lookup";
      key_version: number;
    }>(
      `SELECT key_kind, key_version
       FROM payment_method_token_key_materials
       WHERE material_fingerprint = $1
       FOR SHARE`,
      [materialFingerprint],
    );
    if (
      materialRegistration.rows[0]?.key_kind !== kind ||
      materialRegistration.rows[0]?.key_version !== version
    ) {
      throw new Error(
        `Payment method token key material cannot be reused for ${kind} version ${version}`,
      );
    }
    const inserted = await client.query<{ version: number }>(
      `INSERT INTO ${table}(version, key_fingerprint)
       VALUES ($1, $2)
       ON CONFLICT (version) DO NOTHING
       RETURNING version`,
      [version, fingerprintProviderTokenKey(key, kind, version)],
    );
    if (inserted.rows[0]) registeredVersions.push(inserted.rows[0].version);
  }
  return registeredVersions;
}

async function assertRegisteredTokenKeyring(
  client: DatabaseClient,
  table: PaymentMethodTokenKeyTable,
  keyring: ProviderTokenKeyring,
  kind: "encryption" | "lookup",
): Promise<void> {
  const materials = await client.query<{
    key_kind: "encryption" | "lookup";
    key_version: number;
    material_fingerprint: Buffer;
  }>(
    `SELECT key_kind, key_version, material_fingerprint
     FROM payment_method_token_key_materials
     WHERE key_kind = $1
     ORDER BY key_version
     FOR SHARE`,
    [kind],
  );
  const registered = await client.query<{ version: number; key_fingerprint: Buffer }>(
    `SELECT version, key_fingerprint FROM ${table} ORDER BY version FOR SHARE`,
  );
  if (registered.rowCount === 0) {
    throw new Error(`Payment method token ${kind} key registry is empty`);
  }
  const fingerprints = new Map(
    registered.rows.map((row) => [row.version, row.key_fingerprint] as const),
  );
  const materialFingerprints = new Map(
    materials.rows.map((row) => [row.key_version, row.material_fingerprint] as const),
  );
  for (const [version, key] of keyring.keys) {
    const fingerprint = fingerprints.get(version);
    if (!fingerprint) {
      throw new Error(
        `Payment method token ${kind} key version ${version} is not registered`,
      );
    }
    if (!fingerprint.equals(fingerprintProviderTokenKey(key, kind, version))) {
      throw new Error(
        `Payment method token ${kind} key material does not match registered version ${version}`,
      );
    }
    if (
      !materialFingerprints
        .get(version)
        ?.equals(fingerprintProviderTokenKeyMaterial(key))
    ) {
      throw new Error(
        `Payment method token ${kind} key material registry does not match version ${version}`,
      );
    }
  }
  const maximumRegisteredVersion = registered.rows.at(-1)?.version ?? 0;
  if (keyring.activeVersion < maximumRegisteredVersion) {
    throw new Error(
      `Payment method token ${kind} active version is older than registered version ${maximumRegisteredVersion}`,
    );
  }
}

async function assertPaymentMethodTokenKeyringsCompatibleWithClient(
  client: DatabaseClient,
  config: Config,
): Promise<void> {
  const keyrings = paymentMethodTokenKeyrings(config);
  await assertRegisteredTokenKeyring(
    client,
    "payment_method_token_encryption_keys",
    keyrings.encryption,
    "encryption",
  );
  await assertRegisteredTokenKeyring(
    client,
    "payment_method_token_lookup_keys",
    keyrings.lookup,
    "lookup",
  );
    const stored = await client.query<{
      encryption_versions: number[] | null;
      lookup_versions: number[] | null;
    }>(
      `SELECT array_agg(DISTINCT encryption_key_version ORDER BY encryption_key_version)
                AS encryption_versions,
              array_agg(DISTINCT lookup_key_version ORDER BY lookup_key_version)
                AS lookup_versions
       FROM saved_payment_methods`,
    );
    assertProviderTokenKeyringCoversVersions(
      keyrings.encryption,
      stored.rows[0]?.encryption_versions ?? [],
      "encryption",
    );
    assertProviderTokenKeyringCoversVersions(
      keyrings.lookup,
      stored.rows[0]?.lookup_versions ?? [],
      "lookup",
    );
}

export async function bootstrapPaymentMethodTokenKeyrings(
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  const keyrings = paymentMethodTokenKeyrings(config);
  await transaction(pool, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('opensales:payment-method-token-rewrap', 0))",
    );
    const counts = await client.query<{
      encryption_count: string;
      lookup_count: string;
      material_count: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM payment_method_token_encryption_keys) AS encryption_count,
         (SELECT count(*)::text FROM payment_method_token_lookup_keys) AS lookup_count,
         (SELECT count(*)::text FROM payment_method_token_key_materials) AS material_count`,
    );
    const encryptionCount = Number(counts.rows[0]?.encryption_count ?? "0");
    const lookupCount = Number(counts.rows[0]?.lookup_count ?? "0");
    const materialCount = Number(counts.rows[0]?.material_count ?? "0");
    if (
      (encryptionCount === 0) !== (lookupCount === 0) ||
      (encryptionCount === 0) !== (materialCount === 0)
    ) {
      throw new Error("Payment method token key registries are inconsistent");
    }
    if (encryptionCount === 0) {
      await registerTokenKeyring(
        client,
        "payment_method_token_encryption_keys",
        keyrings.encryption,
        "encryption",
      );
      await registerTokenKeyring(
        client,
        "payment_method_token_lookup_keys",
        keyrings.lookup,
        "lookup",
      );
    }
    await assertPaymentMethodTokenKeyringsCompatibleWithClient(client, config);
  });
}

export async function registerPaymentMethodTokenKeyringsForRotation(
  client: DatabaseClient,
  config: Config,
): Promise<Readonly<{ encryptionVersions: number[]; lookupVersions: number[] }>> {
  const keyrings = paymentMethodTokenKeyrings(config);
  const encryptionVersions = await registerTokenKeyring(
    client,
    "payment_method_token_encryption_keys",
    keyrings.encryption,
    "encryption",
  );
  const lookupVersions = await registerTokenKeyring(
    client,
    "payment_method_token_lookup_keys",
    keyrings.lookup,
    "lookup",
  );
  await assertPaymentMethodTokenKeyringsCompatibleWithClient(client, config);
  return { encryptionVersions, lookupVersions };
}

export async function assertPaymentMethodTokenKeyringsCompatible(
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  await transaction(pool, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock_shared(hashtextextended('opensales:payment-method-token-rewrap', 0))",
    );
    await assertPaymentMethodTokenKeyringsCompatibleWithClient(client, config);
  });
}
