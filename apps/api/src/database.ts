// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Config } from "./config.js";

const { Pool } = pg;
export type DatabasePool = pg.Pool;
export type DatabaseClient = pg.PoolClient;
export const REQUIRED_SCHEMA_VERSION = "011_stage_b_add_funds_chargebacks";

export function createPool(config: Config): DatabasePool {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: 20,
    statement_timeout: 15_000,
    query_timeout: 20_000,
    application_name: "opensales-api",
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

export async function runMigrations(pool: DatabasePool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtextextended('opensales:schema-migrations', 0))",
    );
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
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtextextended('opensales:schema-migrations', 0))")
      .catch(() => undefined);
    client.release();
  }
}

export async function assertSchemaCompatible(pool: DatabasePool): Promise<void> {
  const result = await pool.query<{ version: string | null }>(
    `SELECT max(version) AS version
     FROM schema_migrations`,
  );
  const installed = result.rows[0]?.version ?? null;
  if (installed !== REQUIRED_SCHEMA_VERSION) {
    throw new Error(
      `OpenSales schema ${installed ?? "missing"} is incompatible; run the dedicated migrate command for ${REQUIRED_SCHEMA_VERSION}`,
    );
  }
}
