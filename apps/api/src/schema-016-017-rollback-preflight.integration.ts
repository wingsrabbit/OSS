// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertSchema016RollbackBridgeSafe,
  assertSchema017NativeSafe,
  SCHEMA_016_017_GUARD,
  SCHEMA_017,
  SCHEMA_017_CATALOG_DIGEST,
  schema017CatalogFingerprintInput,
} from "@opensales/core/schema-016-017-rollback-compatibility";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for schema 016/017 integration");

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 8,
  options: "-c search_path=pg_catalog,public",
  statement_timeout: 20_000,
  application_name: "opensales-schema-016-017-rollback-integration",
});
const queryable = {
  query: async (text: string, values?: unknown[]) => pool.query(text, values),
};

async function currentVersion(): Promise<string | null> {
  const result = await pool.query<{ version: string | null }>(
    "SELECT pg_catalog.max(version) AS version FROM public.schema_migrations",
  );
  return result.rows[0]?.version ?? null;
}

async function applyActualMigration017(): Promise<void> {
  const migrationPath = new URL(
    "../migrations/017_stage_b_manual_receipt_outflow_reports.sql",
    import.meta.url,
  );
  const migration = await readFile(migrationPath, "utf8");
  const client = await pool.connect();
  try {
    await client.query("SET search_path TO public");
    await client.query("BEGIN");
    await client.query(migration);
    await client.query(
      "INSERT INTO public.schema_migrations(version) VALUES ($1)",
      [SCHEMA_017],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

test("explicit schema-016 bridge accepts exact native 016 before migration", async () => {
  assert.equal(await currentVersion(), "016_stage_b_manual_receipts");
  const report = await assertSchema016RollbackBridgeSafe(queryable, {
    enable017RollbackBridge: true,
  });
  assert.equal(report.mode, "native");
});

test("actual migration 017 file applies and emits its PG18 catalog digest", async () => {
  await applyActualMigration017();
  assert.equal(await currentVersion(), SCHEMA_017);
  const catalog = await schema017CatalogFingerprintInput(queryable);
  assert.equal(catalog.historyExact, true);
  assert.ok(catalog.fingerprintInput);
  const digest = createHash("sha256")
    .update(catalog.fingerprintInput, "utf8")
    .digest("hex");
  process.stdout.write(`schema017CatalogDigest=${digest}\n`);
  assert.equal(
    digest,
    SCHEMA_017_CATALOG_DIGEST,
    "commit the digest emitted by the actual PostgreSQL 18 migration catalog",
  );
});

test("native 017 and an empty explicit 016 bridge use the exact catalog", async () => {
  assert.equal((await assertSchema017NativeSafe(queryable)).mode, "native");
  const bridge = await assertSchema016RollbackBridgeSafe(queryable, {
    enable017RollbackBridge: true,
  });
  assert.equal(bridge.mode, "rollback_bridge");
});

test("schema-017 marker INSERT and UPDATE conflict with a live rollback bridge", async () => {
  const guard = await pool.connect();
  const writer = await pool.connect();
  const updateTarget = randomUUID();
  try {
    await guard.query(
      "SELECT pg_catalog.pg_advisory_lock_shared(pg_catalog.hashtextextended($1, 0))",
      [SCHEMA_016_017_GUARD],
    );

    await writer.query("BEGIN");
    await writer.query("SET LOCAL lock_timeout = '250ms'");
    await writer.query(
      `INSERT INTO public.ledger_journals(
         id, source_type, source_id, currency, description
       ) VALUES ($1, 'schema_017_marker_test', $2, 'USD', 'synthetic marker update test')`,
      [updateTarget, randomUUID()],
    );
    await assert.rejects(
      writer.query(
        `INSERT INTO public.ledger_journals(
           source_type, source_id, currency, description
         ) VALUES ('manual_receipt_outflow', $1, 'USD', 'synthetic blocked insert')`,
        [randomUUID()],
      ),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error
          && (error as { code: string }).code === "55P03",
    );
    await writer.query("ROLLBACK");

    await writer.query("BEGIN");
    await writer.query("SET LOCAL lock_timeout = '250ms'");
    await assert.rejects(
      writer.query(
        "UPDATE public.ledger_journals SET source_type = 'manual_receipt_outflow' WHERE id = $1",
        [updateTarget],
      ),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error
          && (error as { code: string }).code === "55P03",
    );
    await writer.query("ROLLBACK");
  } finally {
    await writer.query("ROLLBACK").catch(() => undefined);
    writer.release();
    await guard.query(
      "SELECT pg_catalog.pg_advisory_unlock_shared(pg_catalog.hashtextextended($1, 0))",
      [SCHEMA_016_017_GUARD],
    ).catch(() => undefined);
    guard.release();
  }
});

test("017-only facts block the 016 bridge and Provider artifacts are impossible", async () => {
  const client = await pool.connect();
  const sourceId = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.ledger_journals(source_type, source_id, currency, description)
       VALUES ('manual_receipt_outflow', $1, 'USD', 'synthetic rollback blocker')`,
      [sourceId],
    );
    await assert.rejects(
      assertSchema016RollbackBridgeSafe(
        { query: async (text, values) => client.query(text, values) },
        { enable017RollbackBridge: true },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /cannot understand/);
        return true;
      },
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});

test("trigger, function, and view drift fail exact native attestation", async () => {
  const client = await pool.connect();
  try {
    const mutations = [
      "ALTER TABLE public.manual_receipt_outflow_reports DISABLE TRIGGER a_schema_017_outflow_report_marker_guard",
      `CREATE OR REPLACE FUNCTION public.opensales_reject_manual_receipt_provider_artifact()
       RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
      `CREATE OR REPLACE VIEW public.manual_receipt_outflow_capacity AS
       SELECT NULL::uuid AS manual_receipt_id, NULL::uuid AS fund_receipt_id,
              NULL::uuid AS client_account_id, NULL::text AS source_context,
              NULL::uuid AS fund_receipt_resolution_id, NULL::text AS currency,
              0::bigint AS source_amount_minor, 0::bigint AS confirmed_outflow_minor,
              false AS capacity_frozen, 0::bigint AS available_minor`,
    ];
    for (const mutation of mutations) {
      await client.query("BEGIN");
      await client.query(mutation);
      await assert.rejects(
        assertSchema017NativeSafe({
          query: async (text, values) => client.query(text, values),
        }),
        /incomplete or counterfeit/,
      );
      await client.query("ROLLBACK");
    }
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});

test.after(async () => {
  await pool.end();
});
