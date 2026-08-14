// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { assertSchema023FoundationCatalogShape } from "./schema-022-023-native-compatibility.js";
import {
  EXPECTED_SCHEMA_024_HISTORY,
  assertSchema024CatalogShape,
} from "./schema-023-024-native-compatibility.js";
import {
  SchemaRollbackPreflightError,
  type RollbackPreflightQueryable,
} from "./schema-rollback-compatibility.js";

export const SCHEMA_025 = "025_stage_c_content_operations" as const;
export const SCHEMA_025_APPLICATION_GUARD = "opensales:schema-025-application" as const;

// Frozen from the reviewed Schema 025 DDL on PostgreSQL 18.4.
export const SCHEMA_025_CATALOG_DIGEST =
  "1de8cb28d496e0544df6c1937d8b901c7434d02ed6949c33d4cbbf503c59876c" as const;

export const EXPECTED_SCHEMA_025_HISTORY = [
  ...EXPECTED_SCHEMA_024_HISTORY,
  SCHEMA_025,
] as const;

export type Schema025NativePreflightReport = Readonly<{
  installedSchemaVersion: typeof SCHEMA_025;
  applicationSchemaVersion: typeof SCHEMA_025;
  mode: "native";
  safe: true;
  blockers: readonly [];
}>;

function rowRecord(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Schema 025 preflight returned an invalid database row");
  }
  return row as Record<string, unknown>;
}

async function assertSchema025HistoryExact(
  database: RollbackPreflightQueryable,
): Promise<void> {
  let installed: string | null;
  try {
    const result = await database.query(
      "SELECT pg_catalog.max(version) AS version FROM public.schema_migrations",
    );
    const value = result.rows[0] ? rowRecord(result.rows[0]).version : null;
    installed = typeof value === "string" ? value : null;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : undefined;
    if (code !== "42P01") throw error;
    installed = null;
  }
  if (installed !== SCHEMA_025) {
    throw new SchemaRollbackPreflightError(
      installed === null
        ? `Database schema is missing; application schema ${SCHEMA_025} requires a forward migration.`
        : `Database schema ${installed} is incompatible with application schema ${SCHEMA_025}; run the dedicated forward migration and never run a down migration.`,
      installed,
    );
  }
  const history = await database.query(
    `SELECT pg_catalog.array_agg(version ORDER BY version COLLATE "C") = $1::text[]
       AS history_exact
     FROM public.schema_migrations`,
    [[...EXPECTED_SCHEMA_025_HISTORY]],
  );
  if (rowRecord(history.rows[0]).history_exact !== true) {
    throw new SchemaRollbackPreflightError(
      "Schema 025 migration history is incomplete or contains an unreviewed migration; repair forward without deleting migration history.",
      SCHEMA_025,
    );
  }
}

export async function schema025CatalogFingerprintInput(
  database: RollbackPreflightQueryable,
): Promise<string | null> {
  const result = await database.query(
    `WITH target_tables(name) AS (
       VALUES
         ('legal_documents'),
         ('legal_document_channels'),
         ('legal_document_publications'),
         ('legal_document_retirements'),
         ('content_entries'),
         ('content_channels'),
         ('content_revisions'),
         ('content_revision_publications'),
         ('content_revision_retirements')
     ), target_views(name) AS (
       VALUES
         ('current_legal_documents'),
         ('current_content_revisions')
     ), target_relations(name) AS (
       SELECT name FROM target_tables
       UNION ALL
       SELECT name FROM target_views
     ), target_functions(name) AS (
       VALUES
         ('opensales_validate_content_staff_actor'),
         ('opensales_guard_immutable_content_fact'),
         ('opensales_guard_legal_channel'),
         ('opensales_prepare_legal_document_revision'),
         ('opensales_prepare_legal_publication'),
         ('opensales_prepare_legal_retirement'),
         ('opensales_validate_legal_channel_current'),
         ('opensales_guard_content_entry'),
         ('opensales_validate_content_entry_actor'),
         ('opensales_guard_content_channel'),
         ('opensales_prepare_content_channel'),
         ('opensales_validate_content_entry_channels'),
         ('opensales_prepare_content_revision'),
         ('opensales_prepare_content_publication'),
         ('opensales_prepare_content_retirement'),
         ('opensales_validate_content_channel_current')
     ), catalog_items(item) AS (
       SELECT pg_catalog.concat_ws('|', 'relation', namespace.nspname, relation.relname,
                relation.relkind::text, relation.relpersistence::text,
                relation.relreplident::text, relation.relrowsecurity::text,
                relation.relforcerowsecurity::text,
                COALESCE(pg_catalog.array_to_string(relation.reloptions, ','), ''),
                COALESCE(pg_catalog.obj_description(relation.oid, 'pg_class'), ''))
       FROM pg_catalog.pg_namespace namespace
       JOIN pg_catalog.pg_class relation ON relation.relnamespace = namespace.oid
       JOIN target_relations target ON target.name = relation.relname
       WHERE namespace.nspname = 'public'
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'column', actual.table_name,
                actual.ordinal_position::text, actual.column_name,
                actual.data_type, actual.udt_name, actual.is_nullable,
                COALESCE(actual.column_default, ''), actual.is_identity,
                COALESCE(actual.identity_generation, ''), actual.is_generated,
                COALESCE(actual.generation_expression, ''),
                COALESCE(actual.collation_name, ''))
       FROM information_schema.columns actual
       JOIN target_relations target ON target.name = actual.table_name
       WHERE actual.table_schema = 'public'
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'constraint', relation.relname, actual.conname,
                actual.contype::text, actual.convalidated::text,
                actual.condeferrable::text, actual.condeferred::text,
                actual.connoinherit::text,
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_constraintdef(actual.oid, true), '\\s+', ' ', 'g'
                ))
       FROM pg_catalog.pg_constraint actual
       JOIN pg_catalog.pg_class relation ON relation.oid = actual.conrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN target_tables target ON target.name = relation.relname
       WHERE namespace.nspname = 'public'
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'index', actual.schemaname,
                actual.tablename, actual.indexname,
                pg_catalog.regexp_replace(actual.indexdef, '\\s+', ' ', 'g'))
       FROM pg_catalog.pg_indexes actual
       JOIN target_tables target ON target.name = actual.tablename
       WHERE actual.schemaname = 'public'
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'trigger', relation.relname, actual.tgname,
                actual.tgenabled::text, actual.tgtype::text,
                actual.tgdeferrable::text, actual.tginitdeferred::text,
                procedure_namespace.nspname, procedure.proname,
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_triggerdef(actual.oid, true), '\\s+', ' ', 'g'
                ))
       FROM pg_catalog.pg_trigger actual
       JOIN pg_catalog.pg_class relation ON relation.oid = actual.tgrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_proc procedure ON procedure.oid = actual.tgfoid
       JOIN pg_catalog.pg_namespace procedure_namespace
         ON procedure_namespace.oid = procedure.pronamespace
       JOIN target_tables target ON target.name = relation.relname
       WHERE namespace.nspname = 'public' AND NOT actual.tgisinternal
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'function', namespace.nspname, actual.proname,
                pg_catalog.pg_get_function_identity_arguments(actual.oid),
                pg_catalog.pg_get_function_result(actual.oid), language.lanname,
                actual.provolatile::text, actual.prosecdef::text,
                actual.proleakproof::text,
                COALESCE(pg_catalog.array_to_string(actual.proconfig, ','), ''),
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_functiondef(actual.oid), '\\s+', ' ', 'g'
                ))
       FROM pg_catalog.pg_proc actual
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = actual.pronamespace
       JOIN pg_catalog.pg_language language ON language.oid = actual.prolang
       JOIN target_functions target ON target.name = actual.proname
       WHERE namespace.nspname = 'public'
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'view', actual.schemaname, actual.viewname,
                pg_catalog.regexp_replace(actual.definition, '\\s+', ' ', 'g'))
       FROM pg_catalog.pg_views actual
       JOIN target_views target ON target.name = actual.viewname
       WHERE actual.schemaname = 'public'
     ), fingerprint(value) AS (
       SELECT pg_catalog.string_agg(item, E'\\n' ORDER BY item COLLATE "C")
       FROM catalog_items
     )
     SELECT value FROM fingerprint`,
  );
  const value = result.rows[0] ? rowRecord(result.rows[0]).value : null;
  return typeof value === "string" ? value : null;
}

export function schema025CatalogDigest(fingerprintInput: string | null): string | null {
  return fingerprintInput
    ? createHash("sha256").update(fingerprintInput, "utf8").digest("hex")
    : null;
}

export function assertSchema025CatalogDigest(digest: string | null): void {
  if (digest !== SCHEMA_025_CATALOG_DIGEST) {
    throw new SchemaRollbackPreflightError(
      `Schema 025 is incomplete or counterfeit: catalog digest ${String(digest)} does not match reviewed digest ${SCHEMA_025_CATALOG_DIGEST}; do not start a schema-025 application.`,
      SCHEMA_025,
    );
  }
}

export async function assertSchema025CatalogShape(
  database: RollbackPreflightQueryable,
): Promise<void> {
  assertSchema025CatalogDigest(
    schema025CatalogDigest(await schema025CatalogFingerprintInput(database)),
  );
}

export async function assertSchema025NativeSafe(
  database: RollbackPreflightQueryable,
): Promise<Schema025NativePreflightReport> {
  await assertSchema025HistoryExact(database);
  await assertSchema023FoundationCatalogShape(database);
  await assertSchema024CatalogShape(database);
  await assertSchema025CatalogShape(database);
  return {
    installedSchemaVersion: SCHEMA_025,
    applicationSchemaVersion: SCHEMA_025,
    mode: "native",
    safe: true,
    blockers: [],
  };
}
