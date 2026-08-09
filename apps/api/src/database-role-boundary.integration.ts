// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { assertRuntimeDatabaseRoleSafe } from "@opensales/core";
import pg from "pg";
import {
  configureRuntimeDatabaseRoles,
  createPoolForConnection,
  runMigrations,
  type DatabasePool,
} from "./database.js";

const ownerUrl = process.env.DATABASE_URL;
const apiPassword = process.env.DATABASE_API_ROLE_PASSWORD;
const workerPassword = process.env.DATABASE_WORKER_ROLE_PASSWORD;
if (!ownerUrl || !apiPassword || !workerPassword) {
  throw new Error(
    "database role integration requires DATABASE_URL and both runtime role passwords",
  );
}

function roleUrl(role: string, password: string): string {
  const parsed = new URL(ownerUrl!);
  parsed.username = role;
  parsed.password = password;
  return parsed.toString();
}

async function expectDenied(pool: DatabasePool, statement: string): Promise<void> {
  await assert.rejects(
    pool.query(statement),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "42501",
  );
}

test("migration and runtime roles remain separated under real PostgreSQL", async () => {
  const owner = createPoolForConnection(ownerUrl, "role-boundary-owner");
  await configureRuntimeDatabaseRoles(owner, [
    { name: "oss_api", password: apiPassword },
    { name: "oss_worker", password: workerPassword },
  ]);
  const ownerIdentity = await owner.query<{ role_name: string }>(
    "SELECT current_user AS role_name",
  );
  const migrationRole = ownerIdentity.rows[0]?.role_name;
  assert.match(migrationRole ?? "", /^[a-z][a-z0-9_]{0,62}$/);

  for (const runtime of [
    { name: "oss_api", password: apiPassword },
    { name: "oss_worker", password: workerPassword },
  ]) {
    const pool = createPoolForConnection(
      roleUrl(runtime.name, runtime.password),
      `role-boundary-${runtime.name}`,
    );
    await assertRuntimeDatabaseRoleSafe(
      { query: async (text, values) => pool.query(text, values) },
      runtime.name,
    );

    const jobId = randomUUID();
    await pool.query(
      `INSERT INTO public.durable_jobs(
         id, job_type, unique_key, payload, status, available_at
       ) VALUES ($1, 'notification.send', $2, '{}'::jsonb, 'pending', pg_catalog.now())`,
      [jobId, `role-boundary:${runtime.name}:${jobId}`],
    );
    await pool.query("DELETE FROM public.durable_jobs WHERE id = $1", [jobId]);

    await expectDenied(
      pool,
      "ALTER TABLE public.fund_receipts DISABLE TRIGGER fund_receipts_external_facts_append_only",
    );
    await expectDenied(
      pool,
      `CREATE OR REPLACE FUNCTION public.opensales_reject_ledger_mutation()
       RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`,
    );
    await expectDenied(
      pool,
      "INSERT INTO public.schema_migrations(version) VALUES ('999_runtime_attack')",
    );
    await expectDenied(
      pool,
      "UPDATE public.schema_migrations SET applied_at = pg_catalog.now()",
    );
    await expectDenied(pool, "DELETE FROM public.schema_migrations");
    await expectDenied(pool, "TRUNCATE public.schema_migrations");
    await expectDenied(pool, "CREATE TABLE public.runtime_attack(id integer)");
    await expectDenied(pool, "SET session_replication_role = replica");
    await expectDenied(pool, `SET ROLE ${migrationRole}`);
    await assert.rejects(runMigrations(pool), /migration role boundary rejected/);
    await pool.end();
  }

  await assert.rejects(
    assertRuntimeDatabaseRoleSafe(
      { query: async (text, values) => owner.query(text, values) },
      "oss_api",
    ),
    /Database runtime role boundary rejected/,
  );
  await owner.end();
});
