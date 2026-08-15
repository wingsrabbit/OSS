// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  assertSchema019NativeSafe,
  SCHEMA_019,
} from "@opensales/core/schema-018-019-native-compatibility";
import pg from "pg";
import {
  assertSchemaCompatible,
  REQUIRED_SCHEMA_VERSION,
  runMigrations,
  type DatabasePool,
} from "./database.js";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) {
  throw new Error("ADMIN_DATABASE_URL is required for Schema 019 native integration");
}

const admin = new pg.Client({ connectionString: adminDatabaseUrl });

async function withFreshDatabase(
  label: string,
  run: (pool: DatabasePool) => Promise<void>,
): Promise<void> {
  const databaseName = `oss_schema019_${label}_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(adminDatabaseUrl!);
  databaseUrl.pathname = `/${databaseName}`;
  let pool: DatabasePool | null = null;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  try {
    pool = new pg.Pool({
      connectionString: databaseUrl.toString(),
      max: 4,
      options: "-c search_path=pg_catalog,public",
      statement_timeout: 15_000,
      application_name: `opensales-schema019-${label}`,
    });
    await run(pool);
  } finally {
    await pool?.end().catch(() => undefined);
    await admin.query(
      `SELECT pg_catalog.pg_terminate_backend(pid)
       FROM pg_catalog.pg_stat_activity
       WHERE datname = $1 AND pid <> pg_catalog.pg_backend_pid()`,
      [databaseName],
    ).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  }
}

await admin.connect();
try {
  await withFreshDatabase("native", async (pool) => {
    await runMigrations(pool, { throughVersion: SCHEMA_019 });
    const report = await assertSchema019NativeSafe(pool);
    assert.equal(report.safe, true);
    assert.equal(report.installedSchemaVersion, SCHEMA_019);

    const client = await pool.connect();
    try {
      for (const statement of [
        "DROP INDEX public.client_contacts_active_email_idx",
        "DROP TRIGGER sessions_validate_account_context ON public.sessions",
      ]) {
        await client.query("BEGIN");
        try {
          await client.query(statement);
          await assert.rejects(
            assertSchema019NativeSafe({
              query: async (text, values) => client.query(text, values),
            }),
            /Schema 019 is incomplete or counterfeit/,
          );
        } finally {
          await client.query("ROLLBACK");
        }
      }
    } finally {
      client.release();
    }
  });

  await withFreshDatabase("latest", async (pool) => {
    await runMigrations(pool);
    const report = await assertSchemaCompatible(pool);
    assert.equal(report.safe, true);
    assert.equal(report.installedSchemaVersion, REQUIRED_SCHEMA_VERSION);
  });

  console.log(
    "Schema 019 PostgreSQL 18 native integration: PASS — fresh 001→019 and 001→latest startup gates accept the reviewed catalog, while selected index and trigger tampering fail closed.",
  );
} finally {
  await admin.end().catch(() => undefined);
}
