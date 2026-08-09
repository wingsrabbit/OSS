// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
import {
  holdSchema016RollbackBridgeGuard,
  holdSchema017ApplicationGuard,
  runMigrations,
} from "./database.js";

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

test("explicit schema-016 bridge accepts exact native 016 before migration", async () => {
  assert.equal(await currentVersion(), "016_stage_b_manual_receipts");
  const report = await assertSchema016RollbackBridgeSafe(queryable, {
    enable017RollbackBridge: true,
  });
  assert.equal(report.mode, "native");

  const releaseGuard = await holdSchema016RollbackBridgeGuard(pool);
  try {
    await assert.rejects(
      runMigrations(pool),
      /running schema-016\/017 bridge API or Worker/,
    );
  } finally {
    await releaseGuard();
  }
});

test("actual migration 017 file applies and emits its PG18 catalog digest", async () => {
  await runMigrations(pool);
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

  const releaseGuard = await holdSchema017ApplicationGuard(pool);
  try {
    await assert.rejects(
      runMigrations(pool),
      /running schema-017 API or Worker/,
    );
  } finally {
    await releaseGuard();
  }
  await runMigrations(pool);
});

test("role-schema and public built-in shadows cannot spoof schema 017", async () => {
  const client = await pool.connect();
  try {
    const role = await client.query<{ current_user: string }>(
      "SELECT current_user",
    );
    const roleName = role.rows[0]?.current_user;
    assert.ok(roleName);
    const quotedRoleSchema = `"${roleName.replaceAll('"', '""')}"`;
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${quotedRoleSchema}`);
    await client.query(
      `CREATE TABLE ${quotedRoleSchema}.schema_migrations(
         version text PRIMARY KEY, applied_at timestamptz NOT NULL
       )`,
    );
    await client.query(
      `INSERT INTO ${quotedRoleSchema}.schema_migrations(version, applied_at)
       VALUES ('999_counterfeit', pg_catalog.now())`,
    );
    await client.query(
      `CREATE FUNCTION public.max(text) RETURNS text
       LANGUAGE sql IMMUTABLE AS 'SELECT $1'`,
    );
    await client.query(`SET LOCAL search_path TO "$user", public`);
    assert.equal(
      (await assertSchema017NativeSafe({
        query: async (text, values) => client.query(text, values),
      })).installedSchemaVersion,
      SCHEMA_017,
    );
    await client.query("ROLLBACK");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});

test("known pending job claims have the pinned selective index path", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.durable_jobs(
         id, job_type, unique_key, payload, status, available_at, created_at
       )
       SELECT pg_catalog.gen_random_uuid(), 'future.unknown',
              'schema-017-index-unknown-' || series::text,
              '{}'::jsonb, 'pending',
              pg_catalog.now() - interval '1 minute',
              pg_catalog.now() - interval '1 minute'
       FROM pg_catalog.generate_series(1, 4000) series`,
    );
    await client.query(
      `INSERT INTO public.durable_jobs(
         job_type, unique_key, payload, status, available_at, created_at
       ) VALUES (
         'notification.send', 'schema-017-index-known', '{}', 'pending',
         pg_catalog.now(), pg_catalog.now()
       )`,
    );
    await client.query("ANALYZE public.durable_jobs");
    await client.query("SET LOCAL enable_seqscan = off");
    const explained = await client.query<{ "QUERY PLAN": unknown }>(
      `EXPLAIN (FORMAT JSON)
       SELECT id
       FROM public.durable_jobs
       WHERE status = 'pending'
         AND job_type IN ('notification.send', 'payment.start')
         AND available_at <= pg_catalog.now()
       ORDER BY available_at, created_at
       LIMIT 1`,
    );
    assert.match(
      JSON.stringify(explained.rows[0]?.["QUERY PLAN"]),
      /durable_jobs_pending_type_available_created_idx/,
    );
    await client.query("ROLLBACK");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});

test("schema-017 marker INSERT and UPDATE conflict with a live rollback bridge", async () => {
  const guard = await pool.connect();
  const writer = await pool.connect();
  const updateTarget = randomUUID();
  try {
    await pool.query(
      `INSERT INTO public.durable_jobs(
         id, job_type, unique_key, payload, status
       ) VALUES ($1, 'notification.send', $2, $3::jsonb, 'pending')`,
      [
        updateTarget,
        `schema-017-marker-update-${updateTarget}`,
        JSON.stringify({ messageId: updateTarget }),
      ],
    );
    await guard.query(
      "SELECT pg_catalog.pg_advisory_lock_shared(pg_catalog.hashtextextended($1, 0))",
      [SCHEMA_016_017_GUARD],
    );

    await writer.query("BEGIN");
    await writer.query("SET LOCAL lock_timeout = '250ms'");
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
        `UPDATE public.durable_jobs
         SET payload = $2::jsonb
         WHERE id = $1`,
        [
          updateTarget,
          JSON.stringify({ manualReceiptOutflowReportId: randomUUID() }),
        ],
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
    await pool.query("DELETE FROM public.durable_jobs WHERE id = $1", [updateTarget]);
  }
});

test("017-only facts block the 016 bridge", async () => {
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

test("a claimed running job cannot be changed into a schema-017 job", async () => {
  const client = await pool.connect();
  const jobId = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.durable_jobs(
         id, job_type, unique_key, payload, status
       ) VALUES ($1, 'notification.send', $2, $3::jsonb, 'pending')`,
      [jobId, `schema-017-running-job-${jobId}`, JSON.stringify({ messageId: jobId })],
    );
    await client.query(
      "UPDATE public.durable_jobs SET payload = $2::jsonb WHERE id = $1",
      [jobId, JSON.stringify({ messageId: jobId, retry: "allowed-while-pending" })],
    );
    await client.query(
      `UPDATE public.durable_jobs
       SET status = 'running', locked_at = pg_catalog.now(), locked_by = 'schema-017-test'
       WHERE id = $1`,
      [jobId],
    );
    await client.query(
      `UPDATE public.durable_jobs
       SET last_error = 'legitimate running lease metadata update',
           updated_at = pg_catalog.now()
       WHERE id = $1`,
      [jobId],
    );
    await client.query("SAVEPOINT before_running_delete");
    await assert.rejects(
      client.query("DELETE FROM public.durable_jobs WHERE id = $1", [jobId]),
      /running durable job cannot be deleted/,
    );
    await client.query("ROLLBACK TO SAVEPOINT before_running_delete");
    await client.query("SAVEPOINT before_identity_attack");
    await assert.rejects(
      client.query(
        `UPDATE public.durable_jobs
         SET status = 'completed',
             job_type = 'manual_receipt_outflow.reconcile',
             payload = $2::jsonb
         WHERE id = $1`,
        [jobId, JSON.stringify({ manualReceiptOutflowReportId: randomUUID() })],
      ),
      /running durable job cannot change type, identity, or payload/,
    );
    await client.query("ROLLBACK TO SAVEPOINT before_identity_attack");
    const unchanged = await client.query<{
      status: string;
      job_type: string;
      payload: Record<string, unknown>;
    }>(
      "SELECT status, job_type, payload FROM public.durable_jobs WHERE id = $1",
      [jobId],
    );
    assert.equal(unchanged.rows[0]?.status, "running");
    assert.equal(unchanged.rows[0]?.job_type, "notification.send");
    assert.deepEqual(unchanged.rows[0]?.payload, {
      messageId: jobId,
      retry: "allowed-while-pending",
    });
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
