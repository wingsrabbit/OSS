// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  SCHEMA_024,
  assertSchema024NativeSafe,
} from "@opensales/core/schema-023-024-native-compatibility";
import {
  EXPECTED_SCHEMA_025_HISTORY,
  SCHEMA_025,
  SCHEMA_025_CATALOG_DIGEST,
  assertSchema025NativeSafe,
  schema025CatalogDigest,
  schema025CatalogFingerprintInput,
} from "@opensales/core/schema-024-025-native-compatibility";
import {
  assertSchemaCompatible,
  holdSchema025ApplicationGuard,
  runMigrations,
  type DatabasePool,
} from "./database.js";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) {
  throw new Error("ADMIN_DATABASE_URL is required for Schema 025 native integration");
}

const admin = new pg.Client({ connectionString: adminDatabaseUrl });

async function withFreshDatabase(
  label: string,
  run: (pool: DatabasePool) => Promise<void>,
): Promise<void> {
  const databaseName = `oss_schema025_${label}_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(adminDatabaseUrl!);
  databaseUrl.pathname = `/${databaseName}`;
  let pool: DatabasePool | null = null;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  try {
    pool = new pg.Pool({
      connectionString: databaseUrl.toString(),
      max: 8,
      options: "-c search_path=pg_catalog,public",
      statement_timeout: 20_000,
      application_name: `opensales-schema025-${label}`,
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

async function assertCatalogTamperRejected(
  pool: DatabasePool,
  statement: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(statement);
      await assert.rejects(
        assertSchema025NativeSafe({
          query: async (text, values) => client.query(text, values),
        }),
        /Schema 025 is incomplete or counterfeit/,
      );
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    client.release();
  }
}

await admin.connect();
try {
  await withFreshDatabase("fresh", async (pool) => {
    await runMigrations(pool, { throughVersion: SCHEMA_024 });
    await assertSchema024NativeSafe(pool);
    await assert.rejects(assertSchema025NativeSafe(pool), new RegExp(SCHEMA_025));

    await runMigrations(pool, { throughVersion: SCHEMA_025 });
    await assert.rejects(
      assertSchema024NativeSafe(pool),
      /025_stage_c_content_operations.*024_stage_c_identity_security/,
    );
    const report = await assertSchema025NativeSafe(pool);
    assert.deepEqual(report, {
      installedSchemaVersion: SCHEMA_025,
      applicationSchemaVersion: SCHEMA_025,
      mode: "native",
      safe: true,
      blockers: [],
    });
    const fingerprint = await schema025CatalogFingerprintInput(pool);
    assert.ok(fingerprint, "Schema 025 catalog selector must produce a fingerprint");
    assert.equal(schema025CatalogDigest(fingerprint), SCHEMA_025_CATALOG_DIGEST);
    const catalogKinds = fingerprint.split("\n").reduce<Record<string, number>>(
      (counts, line) => {
        const kind = line.split("|", 1)[0]!;
        counts[kind] = (counts[kind] ?? 0) + 1;
        return counts;
      },
      {},
    );
    assert.deepEqual(catalogKinds, {
      column: 91,
      constraint: 141,
      function: 16,
      index: 20,
      relation: 11,
      trigger: 26,
      view: 2,
    });

    const history = await pool.query<{ versions: string[] }>(
      `SELECT pg_catalog.array_agg(version ORDER BY version COLLATE "C") AS versions
       FROM public.schema_migrations`,
    );
    assert.deepEqual(history.rows[0]?.versions, [...EXPECTED_SCHEMA_025_HISTORY]);
    const startup = await assertSchemaCompatible(pool);
    assert.equal(startup.installedSchemaVersion, SCHEMA_025);

    for (const statement of [
      "ALTER TABLE public.legal_documents ALTER COLUMN revision DROP NOT NULL",
      "ALTER TABLE public.content_entries DROP CONSTRAINT content_entries_kind_check",
      "ALTER TABLE public.content_channels DISABLE TRIGGER content_channels_guard",
      "ALTER FUNCTION public.opensales_validate_content_staff_actor(text, uuid, uuid) SECURITY DEFINER",
      "DROP INDEX public.content_entries_kind_audience_idx",
      "DROP VIEW public.current_content_revisions",
      "ALTER TABLE public.content_entries ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE public.content_revisions DROP CONSTRAINT content_revisions_entry_id_locale_revision_key",
      "DROP TRIGGER legal_documents_current_guard ON public.legal_documents",
      "ALTER TABLE public.legal_document_publications ALTER COLUMN reason DROP NOT NULL",
    ]) {
      await assertCatalogTamperRejected(pool, statement);
    }

    const foundationClient = await pool.connect();
    try {
      await foundationClient.query("BEGIN");
      try {
        await foundationClient.query(
          "DROP INDEX public.identity_action_facts_transaction_once",
        );
        await assert.rejects(
          assertSchema025NativeSafe({
            query: async (text, values) => foundationClient.query(text, values),
          }),
          /Schema 024 is incomplete or counterfeit/,
        );
      } finally {
        await foundationClient.query("ROLLBACK");
      }
    } finally {
      foundationClient.release();
    }

    const historyClient = await pool.connect();
    try {
      await historyClient.query("BEGIN");
      try {
        await historyClient.query(
          "DELETE FROM public.schema_migrations WHERE version = '020_stage_c_catalog_commerce'",
        );
        await assert.rejects(
          assertSchema025NativeSafe({
            query: async (text, values) => historyClient.query(text, values),
          }),
          /Schema 025 migration history is incomplete/,
        );
      } finally {
        await historyClient.query("ROLLBACK");
      }
    } finally {
      historyClient.release();
    }

    const releaseSchema025Guard = await holdSchema025ApplicationGuard(pool);
    try {
      await assert.rejects(
        runMigrations(pool, { throughVersion: SCHEMA_025 }),
        /running schema-025 API or Worker/,
      );
    } finally {
      await releaseSchema025Guard();
    }
    await assertSchema025NativeSafe(pool);
  });

  await withFreshDatabase("saved024", async (pool) => {
    await runMigrations(pool, { throughVersion: SCHEMA_024 });
    const firstId = randomUUID();
    const secondId = randomUUID();
    await pool.query(
      `INSERT INTO public.legal_documents(
         id, kind, locale, version, title, body, published_at
       ) VALUES
         ($1, 'terms', 'en', 'saved-024-v1', 'Saved 024 terms v1',
          'Synthetic saved Schema 024 legal body v1.',
          '2025-01-01T00:00:00Z'::timestamptz),
         ($2, 'terms', 'en', 'saved-024-v2', 'Saved 024 terms v2',
          'Synthetic saved Schema 024 legal body v2.',
          '2025-02-01T00:00:00Z'::timestamptz)`,
      [firstId, secondId],
    );
    const before = await pool.query<{
      id: string;
      version: string;
      title: string;
      body: string;
      published_at: Date;
    }>(
      `SELECT id, version, title, body, published_at
       FROM public.legal_documents
       WHERE id = ANY($1::uuid[])
       ORDER BY published_at, id`,
      [[firstId, secondId]],
    );

    await runMigrations(pool, { throughVersion: SCHEMA_025 });
    await assertSchema025NativeSafe(pool);
    const after = await pool.query<{
      id: string;
      version: string;
      title: string;
      body: string;
      published_at: Date;
      revision: string;
      created_source: string;
      creation_reason: string;
      retired: boolean;
      current: boolean;
    }>(
      `SELECT document.id, document.version, document.title, document.body,
              document.published_at, document.revision::text,
              document.created_source, document.creation_reason,
              retirement.document_id IS NOT NULL AS retired,
              channel.current_document_id = document.id AS current
       FROM public.legal_documents document
       JOIN public.legal_document_publications publication
         ON publication.document_id = document.id
       LEFT JOIN public.legal_document_retirements retirement
         ON retirement.document_id = document.id
       JOIN public.legal_document_channels channel
         ON channel.kind = document.kind AND channel.locale = document.locale
       WHERE document.id = ANY($1::uuid[])
       ORDER BY document.published_at, document.id`,
      [[firstId, secondId]],
    );
    assert.deepEqual(
      after.rows.map(({ revision, created_source, creation_reason, retired, current, ...row }) => row),
      before.rows,
      "024 legal facts must retain their exact identifiers, text, and timestamps",
    );
    assert.deepEqual(
      after.rows.map((row) => ({
        revision: row.revision,
        source: row.created_source,
        reason: row.creation_reason,
        retired: row.retired,
        current: row.current,
      })),
      [
        {
          revision: "1",
          source: "migration",
          reason: "Schema 025 preserved the legacy immutable legal revision",
          retired: true,
          current: false,
        },
        {
          revision: "2",
          source: "migration",
          reason: "Schema 025 preserved the legacy immutable legal revision",
          retired: false,
          current: true,
        },
      ],
    );
    const seeded = await pool.query<{
      legal_channels: string;
      content_entries: string;
      content_revisions: string;
    }>(
      `SELECT
         (SELECT pg_catalog.count(*)::text FROM public.legal_document_channels)
           AS legal_channels,
         (SELECT pg_catalog.count(*)::text FROM public.content_entries)
           AS content_entries,
         (SELECT pg_catalog.count(*)::text FROM public.content_revisions)
           AS content_revisions`,
    );
    assert.deepEqual(seeded.rows[0], {
      legal_channels: "6",
      content_entries: "3",
      content_revisions: "6",
    });
  });

  console.log(
    "Schema 025 PostgreSQL 18 native integration: PASS — fresh 001→024→025, saved 024→025, exact history/foundation/catalog, ten catalog mutation classes, and the schema-025 application guard all fail closed or preserve facts as reviewed.",
  );
} finally {
  await admin.end().catch(() => undefined);
}
