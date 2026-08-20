// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  EXPECTED_SCHEMA_027_HISTORY,
  SCHEMA_027,
  SCHEMA_027_CATALOG_DIGEST,
  assertSchema027NativeSafe,
  schema027CatalogDigest,
  schema027CatalogFingerprintInput,
} from "@opensales/core/schema-026-027-native-compatibility";
import {
  SCHEMA_026,
} from "@opensales/core/schema-025-026-native-compatibility";
import pg from "pg";
import {
  assertSchemaCompatible,
  holdSchema027ApplicationGuard,
  runMigrations,
  type DatabasePool,
} from "./database.js";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) {
  throw new Error("ADMIN_DATABASE_URL is required for Schema 027 native integration");
}

const databaseName = `oss_schema027_normal_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = new URL(adminDatabaseUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = new pg.Client({ connectionString: adminDatabaseUrl });
let pool: DatabasePool | null = null;

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  pool = new pg.Pool({
    connectionString: databaseUrl.toString(),
    max: 8,
    options: "-c search_path=pg_catalog,public",
    statement_timeout: 20_000,
    application_name: "opensales-schema027-normal-integration",
  });

  await runMigrations(pool, { throughVersion: SCHEMA_026 });
  const savedSchema026 = await pool.query<{ version: string; migration_count: string }>(
    `SELECT pg_catalog.max(version) AS version,
            pg_catalog.count(*)::text AS migration_count
     FROM public.schema_migrations`,
  );
  assert.equal(savedSchema026.rows[0]?.version, SCHEMA_026);
  assert.equal(
    Number(savedSchema026.rows[0]?.migration_count),
    EXPECTED_SCHEMA_027_HISTORY.length - 1,
  );

  await runMigrations(pool, { throughVersion: SCHEMA_027 });
  const native = await assertSchema027NativeSafe(pool);
  assert.deepEqual(native, {
    installedSchemaVersion: SCHEMA_027,
    applicationSchemaVersion: SCHEMA_027,
    mode: "native",
    safe: true,
    blockers: [],
  });
  await assert.rejects(
    assertSchemaCompatible(pool),
    /027_stage_c_notification_templates_preferences.*028_stage_c_cancellation_provider_evidence/,
  );
  assert.equal(
    schema027CatalogDigest(await schema027CatalogFingerprintInput(pool)),
    SCHEMA_027_CATALOG_DIGEST,
  );

  const registry = await pool.query<{
    categories: string;
    events: string;
    revisions: string;
    channels: string;
    current_templates: string;
    preferences: string;
  }>(
    `SELECT
       (SELECT pg_catalog.count(*)::text
        FROM public.notification_preference_categories) AS categories,
       (SELECT pg_catalog.count(*)::text
        FROM public.notification_template_events) AS events,
       (SELECT pg_catalog.count(*)::text
        FROM public.notification_template_revisions) AS revisions,
       (SELECT pg_catalog.count(*)::text
        FROM public.notification_template_channels) AS channels,
       (SELECT pg_catalog.count(*)::text
        FROM public.current_notification_templates) AS current_templates,
       (SELECT pg_catalog.count(*)::text
        FROM public.user_notification_preferences) AS preferences`,
  );
  assert.deepEqual(registry.rows[0], {
    categories: "6",
    events: "7",
    revisions: "20",
    channels: "14",
    current_templates: "14",
    preferences: "0",
  });

  const requiredCategories = await pool.query<{ category: string }>(
    `SELECT category
     FROM public.notification_preference_categories
     WHERE required_delivery
     ORDER BY category COLLATE "C"`,
  );
  assert.deepEqual(
    requiredCategories.rows.map((row) => row.category),
    ["high_risk", "identity", "transactional"],
  );

  const locales = await pool.query<{ event_type: string; locale_count: string }>(
    `SELECT event_type, pg_catalog.count(*)::text AS locale_count
     FROM public.current_notification_templates
     GROUP BY event_type
     ORDER BY event_type COLLATE "C"`,
  );
  assert.equal(locales.rowCount, 7);
  assert.ok(locales.rows.every((row) => row.locale_count === "2"));

  const releaseGuard = await holdSchema027ApplicationGuard(pool);
  await releaseGuard();

  console.log(
    "Schema 027 PostgreSQL 18 normal integration: PASS — saved Schema 026 upgraded forward, exact history/catalog accepted, bilingual registry seeded, required categories fixed, and application guard acquired/released.",
  );
} finally {
  await pool?.end().catch(() => undefined);
  if (adminDatabaseUrl) {
    await admin.query(
      `SELECT pg_catalog.pg_terminate_backend(pid)
       FROM pg_catalog.pg_stat_activity
       WHERE datname = $1 AND pid <> pg_catalog.pg_backend_pid()`,
      [databaseName],
    ).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => undefined);
  }
  await admin.end().catch(() => undefined);
}
