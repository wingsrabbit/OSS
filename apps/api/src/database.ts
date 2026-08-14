// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertMigrationDatabaseRoleSafe } from "@opensales/core";
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
  assertSchema016NativeSafe,
  SCHEMA_015_016_GUARD,
  SCHEMA_016_APPLICATION_GUARD,
  type Schema015RollbackPreflightReport,
} from "@opensales/core/schema-015-016-rollback-compatibility";
import {
  SCHEMA_016_017_GUARD,
  SCHEMA_017_APPLICATION_GUARD,
} from "@opensales/core/schema-016-017-rollback-compatibility";
import {
  SCHEMA_019_APPLICATION_GUARD,
} from "@opensales/core/schema-018-019-native-compatibility";
import {
  SCHEMA_020_APPLICATION_GUARD,
} from "@opensales/core/schema-019-020-native-compatibility";
import {
  SCHEMA_021_APPLICATION_GUARD,
} from "@opensales/core/schema-020-021-native-compatibility";
import {
  SCHEMA_022_APPLICATION_GUARD,
} from "@opensales/core/schema-021-022-native-compatibility";
import {
  assertSchema023NativeSafe,
  SCHEMA_023,
  SCHEMA_023_APPLICATION_GUARD,
  type Schema023NativePreflightReport,
} from "@opensales/core/schema-022-023-native-compatibility";
import pg from "pg";
import { paymentMethodTokenKeyrings, type Config } from "./config.js";

const { Pool } = pg;
export type DatabasePool = pg.Pool;
export type DatabaseClient = pg.PoolClient;
export const REQUIRED_SCHEMA_VERSION = SCHEMA_023;
const TOKEN_REGISTRY_EXTENSION_GUARD =
  "opensales:payment-method-token-registry-extension";

export function createPool(
  config: Config,
  applicationName = "opensales-api",
): DatabasePool {
  return createPoolForConnection(config.DATABASE_URL, applicationName);
}

export function createPoolForConnection(
  connectionString: string,
  applicationName: string,
): DatabasePool {
  return new Pool({
    connectionString,
    max: 20,
    connectionTimeoutMillis: 5_000,
    options: "-c search_path=pg_catalog,public",
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
      "SELECT pg_catalog.pg_advisory_lock_shared(pg_catalog.hashtextextended($1, 0))",
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
        "SELECT pg_catalog.pg_advisory_unlock_shared(pg_catalog.hashtextextended($1, 0)) AS unlocked",
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
      "SELECT pg_catalog.pg_advisory_unlock_shared(pg_catalog.hashtextextended($1, 0)) AS unlocked",
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
    await client.query(
      "SELECT pg_catalog.pg_advisory_lock_shared(pg_catalog.hashtextextended($1, 0))",
      [SCHEMA_015_016_GUARD],
    );
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

export async function holdSchema016ApplicationGuard(
  pool: DatabasePool,
): Promise<() => Promise<void>> {
  const client = await pool.connect();
  let held = false;
  try {
    await client.query("SET lock_timeout = '15s'");
    await client.query(
      "SELECT pg_catalog.pg_advisory_lock_shared(pg_catalog.hashtextextended($1, 0))",
      [SCHEMA_016_APPLICATION_GUARD],
    );
    await client.query("RESET lock_timeout");
    held = true;
  } catch (error) {
    client.release(error instanceof Error ? error : true);
    throw error;
  }
  return async () => {
    if (!held) return;
    held = false;
    await releaseGuardClient(client, SCHEMA_016_APPLICATION_GUARD);
  };
}

export async function holdSchema016RollbackBridgeGuard(
  pool: DatabasePool,
): Promise<() => Promise<void>> {
  const client = await pool.connect();
  let held = false;
  try {
    await client.query("SET lock_timeout = '15s'");
    await client.query(
      "SELECT pg_catalog.pg_advisory_lock_shared(pg_catalog.hashtextextended($1, 0))",
      [SCHEMA_016_017_GUARD],
    );
    await client.query("RESET lock_timeout");
    held = true;
  } catch (error) {
    client.release(error instanceof Error ? error : true);
    throw error;
  }
  return async () => {
    if (!held) return;
    held = false;
    await releaseGuardClient(client, SCHEMA_016_017_GUARD);
  };
}

export async function holdSchema017ApplicationGuard(
  pool: DatabasePool,
): Promise<() => Promise<void>> {
  const client = await pool.connect();
  let held = false;
  try {
    await client.query("SET lock_timeout = '15s'");
    await client.query(
      "SELECT pg_catalog.pg_advisory_lock_shared(pg_catalog.hashtextextended($1, 0))",
      [SCHEMA_017_APPLICATION_GUARD],
    );
    await client.query("RESET lock_timeout");
    held = true;
  } catch (error) {
    client.release(error instanceof Error ? error : true);
    throw error;
  }
  return async () => {
    if (!held) return;
    held = false;
    await releaseGuardClient(client, SCHEMA_017_APPLICATION_GUARD);
  };
}

export async function holdSchema019ApplicationGuard(
  pool: DatabasePool,
): Promise<() => Promise<void>> {
  const client = await pool.connect();
  let held = false;
  try {
    await client.query("SET lock_timeout = '15s'");
    await client.query(
      "SELECT pg_catalog.pg_advisory_lock_shared(pg_catalog.hashtextextended($1, 0))",
      [SCHEMA_019_APPLICATION_GUARD],
    );
    await client.query("RESET lock_timeout");
    held = true;
  } catch (error) {
    client.release(error instanceof Error ? error : true);
    throw error;
  }
  return async () => {
    if (!held) return;
    held = false;
    await releaseGuardClient(client, SCHEMA_019_APPLICATION_GUARD);
  };
}

export async function holdSchema020ApplicationGuard(
  pool: DatabasePool,
): Promise<() => Promise<void>> {
  const client = await pool.connect();
  let held = false;
  try {
    await client.query("SET lock_timeout = '15s'");
    await client.query(
      "SELECT pg_catalog.pg_advisory_lock_shared(pg_catalog.hashtextextended($1, 0))",
      [SCHEMA_020_APPLICATION_GUARD],
    );
    await client.query("RESET lock_timeout");
    held = true;
  } catch (error) {
    client.release(error instanceof Error ? error : true);
    throw error;
  }
  return async () => {
    if (!held) return;
    held = false;
    await releaseGuardClient(client, SCHEMA_020_APPLICATION_GUARD);
  };
}

export async function holdSchema021ApplicationGuard(
  pool: DatabasePool,
): Promise<() => Promise<void>> {
  const client = await pool.connect();
  let held = false;
  try {
    await client.query("SET lock_timeout = '15s'");
    await client.query(
      "SELECT pg_catalog.pg_advisory_lock_shared(pg_catalog.hashtextextended($1, 0))",
      [SCHEMA_021_APPLICATION_GUARD],
    );
    await client.query("RESET lock_timeout");
    held = true;
  } catch (error) {
    client.release(error instanceof Error ? error : true);
    throw error;
  }
  return async () => {
    if (!held) return;
    held = false;
    await releaseGuardClient(client, SCHEMA_021_APPLICATION_GUARD);
  };
}

export async function holdSchema023ApplicationGuard(
  pool: DatabasePool,
): Promise<() => Promise<void>> {
  const client = await pool.connect();
  let held = false;
  try {
    await client.query("SET lock_timeout = '15s'");
    await client.query(
      "SELECT pg_catalog.pg_advisory_lock_shared(pg_catalog.hashtextextended($1, 0))",
      [SCHEMA_023_APPLICATION_GUARD],
    );
    await client.query("RESET lock_timeout");
    held = true;
  } catch (error) {
    client.release(error instanceof Error ? error : true);
    throw error;
  }
  return async () => {
    if (!held) return;
    held = false;
    await releaseGuardClient(client, SCHEMA_023_APPLICATION_GUARD);
  };
}

export async function tryLockPaymentMethodTokenRegistryExtension(
  client: DatabaseClient,
): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    "SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended($1, 0)) AS locked",
    [TOKEN_REGISTRY_EXTENSION_GUARD],
  );
  return result.rows[0]?.locked === true;
}

export async function runMigrations(
  pool: DatabasePool,
  input: Readonly<{ throughVersion?: string }> = {},
): Promise<void> {
  const client = await pool.connect();
  let migrationLockHeld = false;
  let compatibilityLockHeld = false;
  let schema016ApplicationLockHeld = false;
  let schema016017BridgeLockHeld = false;
  let schema017ApplicationLockHeld = false;
  let schema019ApplicationLockHeld = false;
  let schema020ApplicationLockHeld = false;
  let schema021ApplicationLockHeld = false;
  let schema022ApplicationLockHeld = false;
  let schema023ApplicationLockHeld = false;
  let failed = false;
  let failure: unknown;
  try {
    await client.query("SET search_path TO public");
    await assertMigrationDatabaseRoleSafe({
      query: async (text, values) => client.query(text, values),
    });
    await client.query(
      "SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended('opensales:schema-migrations', 0))",
    );
    migrationLockHeld = true;
    const compatibilityGuard = await client.query<{ locked: boolean }>(
      "SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended($1, 0)) AS locked",
      [SCHEMA_015_016_GUARD],
    );
    if (compatibilityGuard.rows[0]?.locked !== true) {
      throw new Error(
        "Schema migration is blocked by a running compatibility-bridge API or Worker; stop every application process before migrating",
      );
    }
    compatibilityLockHeld = true;
    const schema016ApplicationGuard = await client.query<{ locked: boolean }>(
      "SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended($1, 0)) AS locked",
      [SCHEMA_016_APPLICATION_GUARD],
    );
    if (schema016ApplicationGuard.rows[0]?.locked !== true) {
      throw new Error(
        "Schema migration is blocked by a running schema-016 API or Worker; stop every application process before migrating",
      );
    }
    schema016ApplicationLockHeld = true;
    const schema016017BridgeGuard = await client.query<{ locked: boolean }>(
      "SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended($1, 0)) AS locked",
      [SCHEMA_016_017_GUARD],
    );
    if (schema016017BridgeGuard.rows[0]?.locked !== true) {
      throw new Error(
        "Schema migration is blocked by a running schema-016/017 bridge API or Worker; stop every application process before migrating",
      );
    }
    schema016017BridgeLockHeld = true;
    const schema017ApplicationGuard = await client.query<{ locked: boolean }>(
      "SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended($1, 0)) AS locked",
      [SCHEMA_017_APPLICATION_GUARD],
    );
    if (schema017ApplicationGuard.rows[0]?.locked !== true) {
      throw new Error(
        "Schema migration is blocked by a running schema-017 API or Worker; stop every application process before migrating",
      );
    }
    schema017ApplicationLockHeld = true;
    const schema019ApplicationGuard = await client.query<{ locked: boolean }>(
      "SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended($1, 0)) AS locked",
      [SCHEMA_019_APPLICATION_GUARD],
    );
    if (schema019ApplicationGuard.rows[0]?.locked !== true) {
      throw new Error(
        "Schema migration is blocked by a running schema-019 API or Worker; stop every application process before migrating",
      );
    }
    schema019ApplicationLockHeld = true;
    const schema020ApplicationGuard = await client.query<{ locked: boolean }>(
      "SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended($1, 0)) AS locked",
      [SCHEMA_020_APPLICATION_GUARD],
    );
    if (schema020ApplicationGuard.rows[0]?.locked !== true) {
      throw new Error(
        "Schema migration is blocked by a running schema-020 API or Worker; stop every application process before migrating",
      );
    }
    schema020ApplicationLockHeld = true;
    const schema021ApplicationGuard = await client.query<{ locked: boolean }>(
      "SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended($1, 0)) AS locked",
      [SCHEMA_021_APPLICATION_GUARD],
    );
    if (schema021ApplicationGuard.rows[0]?.locked !== true) {
      throw new Error(
        "Schema migration is blocked by a running schema-021 API or Worker; stop every application process before migrating",
      );
    }
    schema021ApplicationLockHeld = true;
    const schema022ApplicationGuard = await client.query<{ locked: boolean }>(
      "SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended($1, 0)) AS locked",
      [SCHEMA_022_APPLICATION_GUARD],
    );
    if (schema022ApplicationGuard.rows[0]?.locked !== true) {
      throw new Error(
        "Schema migration is blocked by a running schema-022 API or Worker; stop every application process before migrating",
      );
    }
    schema022ApplicationLockHeld = true;
    const schema023ApplicationGuard = await client.query<{ locked: boolean }>(
      "SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended($1, 0)) AS locked",
      [SCHEMA_023_APPLICATION_GUARD],
    );
    if (schema023ApplicationGuard.rows[0]?.locked !== true) {
      throw new Error(
        "Schema migration is blocked by a running schema-023 API or Worker; stop every application process before migrating",
      );
    }
    schema023ApplicationLockHeld = true;
    await client.query(
      "CREATE TABLE IF NOT EXISTS public.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
    let migrationFiles = (await readdir(migrationsDirectory))
      .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
      .sort();
    if (input.throughVersion) {
      const targetFile = `${input.throughVersion}.sql`;
      const targetIndex = migrationFiles.indexOf(targetFile);
      if (targetIndex === -1) {
        throw new Error(`Migration target ${input.throughVersion} does not exist`);
      }
      migrationFiles = migrationFiles.slice(0, targetIndex + 1);
    }
    for (const migrationFile of migrationFiles) {
      const version = migrationFile.replace(/\.sql$/, "");
      const migration = await readFile(resolve(migrationsDirectory, migrationFile), "utf8");
      await client.query("BEGIN");
      try {
        const existing = await client.query<{ version: string }>(
          "SELECT version FROM public.schema_migrations WHERE version = $1",
          [version],
        );
        if (existing.rowCount === 0) {
          await client.query(migration);
          await client.query("INSERT INTO public.schema_migrations(version) VALUES ($1)", [
            version,
          ]);
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
  try {
    await client.query("SET search_path TO pg_catalog, public");
  } catch (error) {
    cleanupErrors.push(error);
    discardClient = true;
  }
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
  if (schema023ApplicationLockHeld) {
    await unlock(
      "SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1, 0)) AS unlocked",
      [SCHEMA_023_APPLICATION_GUARD],
    );
  }
  if (schema022ApplicationLockHeld) {
    await unlock(
      "SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1, 0)) AS unlocked",
      [SCHEMA_022_APPLICATION_GUARD],
    );
  }
  if (schema021ApplicationLockHeld) {
    await unlock(
      "SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1, 0)) AS unlocked",
      [SCHEMA_021_APPLICATION_GUARD],
    );
  }
  if (schema020ApplicationLockHeld) {
    await unlock(
      "SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1, 0)) AS unlocked",
      [SCHEMA_020_APPLICATION_GUARD],
    );
  }
  if (schema019ApplicationLockHeld) {
    await unlock(
      "SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1, 0)) AS unlocked",
      [SCHEMA_019_APPLICATION_GUARD],
    );
  }
  if (schema017ApplicationLockHeld) {
    await unlock(
      "SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1, 0)) AS unlocked",
      [SCHEMA_017_APPLICATION_GUARD],
    );
  }
  if (schema016017BridgeLockHeld) {
    await unlock(
      "SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1, 0)) AS unlocked",
      [SCHEMA_016_017_GUARD],
    );
  }
  if (schema016ApplicationLockHeld) {
    await unlock(
      "SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1, 0)) AS unlocked",
      [SCHEMA_016_APPLICATION_GUARD],
    );
  }
  if (compatibilityLockHeld) {
    await unlock(
      "SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1, 0)) AS unlocked",
      [SCHEMA_015_016_GUARD],
    );
  }
  if (migrationLockHeld) {
    await unlock(
      "SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended('opensales:schema-migrations', 0)) AS unlocked",
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

export type RuntimeDatabaseRole = Readonly<{
  name: string;
  password: string;
}>;

function assertRuntimeRoleInput(role: RuntimeDatabaseRole): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role.name)) {
    throw new Error(`Invalid runtime database role identifier ${role.name}`);
  }
  if (role.password.length < 32) {
    throw new Error(`Runtime database role ${role.name} requires a 32-character password`);
  }
}

async function formattedRoleSql(
  client: DatabaseClient,
  template: string,
  values: readonly unknown[],
): Promise<string> {
  const result = await client.query<{ statement: string }>(
    "SELECT pg_catalog.format($1, VARIADIC $2::text[]) AS statement",
    [template, values.map(String)],
  );
  const statement = result.rows[0]?.statement;
  if (!statement) throw new Error("Unable to format database role boundary statement");
  return statement;
}

export async function configureRuntimeDatabaseRoles(
  pool: DatabasePool,
  roles: readonly RuntimeDatabaseRole[],
): Promise<void> {
  if (roles.length === 0) throw new Error("At least one runtime database role is required");
  const names = new Set<string>();
  for (const role of roles) {
    assertRuntimeRoleInput(role);
    if (names.has(role.name)) throw new Error(`Duplicate runtime database role ${role.name}`);
    names.add(role.name);
  }
  await transaction(pool, async (client) => {
    await assertMigrationDatabaseRoleSafe({
      query: async (text, values) => client.query(text, values),
    });
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await client.query("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC");
    await client.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC",
    );
    const databaseName = (await client.query<{ database_name: string }>(
      "SELECT pg_catalog.current_database() AS database_name",
    )).rows[0]?.database_name;
    const migrationRole = (await client.query<{ role_name: string }>(
      "SELECT current_user AS role_name",
    )).rows[0]?.role_name;
    if (!databaseName || !migrationRole) {
      throw new Error("Unable to resolve migration database identity");
    }
    for (const role of roles) {
      const existing = await client.query(
        "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1",
        [role.name],
      );
      if (existing.rowCount === 0) {
        await client.query(
          await formattedRoleSql(
            client,
            "CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L",
            [role.name, role.password],
          ),
        );
      } else {
        await client.query(
          await formattedRoleSql(
            client,
            "ALTER ROLE %I LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L",
            [role.name, role.password],
          ),
        );
      }
      await client.query(
        await formattedRoleSql(
          client,
          "REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I",
          [databaseName, role.name],
        ),
      );
      await client.query(
        await formattedRoleSql(client, "GRANT CONNECT ON DATABASE %I TO %I", [
          databaseName,
          role.name,
        ]),
      );
      await client.query(
        await formattedRoleSql(client, "REVOKE %I FROM %I", [migrationRole, role.name]),
      );
      const statements = [
        "REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I",
        "GRANT USAGE ON SCHEMA public TO %I",
        "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I",
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I",
        "REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I",
        "GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I",
        "REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I",
        "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I",
        "REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations FROM %I",
        "GRANT SELECT ON TABLE public.schema_migrations TO %I",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I",
      ] as const;
      for (const template of statements) {
        await client.query(await formattedRoleSql(client, template, [role.name]));
      }
    }
  });
}

export async function assertSchemaCompatible(
  pool: DatabasePool,
  input: Readonly<{ enable017RollbackBridge?: boolean }> = {},
): Promise<Schema023NativePreflightReport> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL search_path TO pg_catalog, public");
    if (input.enable017RollbackBridge === true) {
      throw new Error(
        "Schema 023 application startup refuses the legacy 016-to-017 rollback bridge; use the matching historical application binary or migrate forward",
      );
    }
    const report = await assertSchema023NativeSafe(
      { query: async (text: string, values?: unknown[]) => client.query(text, values) },
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

export async function assertSchema015ApplicationCompatible(
  pool: DatabasePool,
  input: Readonly<{ enable016RollbackBridge?: boolean }> = {},
): Promise<Schema015RollbackPreflightReport> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL search_path TO pg_catalog, public");
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
    await client.query("SET LOCAL search_path TO pg_catalog, public");
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
      "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('opensales:payment-method-token-rewrap', 0))",
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
      "SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('opensales:payment-method-token-rewrap', 0))",
    );
    await assertPaymentMethodTokenKeyringsCompatibleWithClient(client, config);
  });
}
