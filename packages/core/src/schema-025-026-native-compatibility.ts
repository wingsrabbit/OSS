// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { assertSchema023FoundationCatalogShape } from "./schema-022-023-native-compatibility.js";
import { assertSchema024CatalogShape } from "./schema-023-024-native-compatibility.js";
import {
  EXPECTED_SCHEMA_025_HISTORY,
  assertSchema025CatalogShape,
} from "./schema-024-025-native-compatibility.js";
import {
  SchemaRollbackPreflightError,
  type RollbackPreflightQueryable,
} from "./schema-rollback-compatibility.js";

export const SCHEMA_026 = "026_stage_c_service_cancellation_authority" as const;
export const SCHEMA_026_APPLICATION_GUARD = "opensales:schema-026-application" as const;

// Frozen from the reviewed Schema 026 DDL on PostgreSQL 18.4.
export const SCHEMA_026_CATALOG_DIGEST =
  "2e80b43abbd65c13a3239cdbedf4932a3095851a72ee37b2ef4e90f608a45f80" as const;

export const EXPECTED_SCHEMA_026_HISTORY = [
  ...EXPECTED_SCHEMA_025_HISTORY,
  SCHEMA_026,
] as const;

export type Schema026NativePreflightReport = Readonly<{
  installedSchemaVersion: typeof SCHEMA_026;
  applicationSchemaVersion: typeof SCHEMA_026;
  mode: "native";
  safe: true;
  blockers: readonly [];
}>;

function rowRecord(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Schema 026 preflight returned an invalid database row");
  }
  return row as Record<string, unknown>;
}

async function assertSchema026HistoryExact(
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
  if (installed !== SCHEMA_026) {
    throw new SchemaRollbackPreflightError(
      installed === null
        ? `Database schema is missing; application schema ${SCHEMA_026} requires a forward migration.`
        : `Database schema ${installed} is incompatible with application schema ${SCHEMA_026}; run the dedicated forward migration and never run a down migration.`,
      installed,
    );
  }
  const history = await database.query(
    `SELECT pg_catalog.array_agg(version ORDER BY version COLLATE "C") = $1::text[]
       AS history_exact
     FROM public.schema_migrations`,
    [[...EXPECTED_SCHEMA_026_HISTORY]],
  );
  if (rowRecord(history.rows[0]).history_exact !== true) {
    throw new SchemaRollbackPreflightError(
      "Schema 026 migration history is incomplete or contains an unreviewed migration; repair forward without deleting migration history.",
      SCHEMA_026,
    );
  }
}

export async function schema026CatalogFingerprintInput(
  database: RollbackPreflightQueryable,
): Promise<string | null> {
  const result = await database.query(
    `WITH target_functions(name) AS (
       VALUES
         ('opensales_validate_service_cancellation_request'),
         ('opensales_validate_service_cancellation_manual_action')
     ), target_trigger_bindings(relation_name, trigger_name, function_name) AS (
       VALUES
         ('service_cancellation_requests', 'service_cancellation_requests_insert_guard',
          'opensales_validate_service_cancellation_request'),
         ('service_cancellation_manual_actions', 'service_cancellation_manual_actions_insert_guard',
          'opensales_validate_service_cancellation_manual_action')
     ), catalog_items(item) AS (
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
       JOIN target_functions target ON target.name = procedure.proname
       WHERE namespace.nspname = 'public' AND NOT actual.tgisinternal
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'missing-trigger-binding',
                target.relation_name, target.trigger_name, target.function_name)
       FROM target_trigger_bindings target
       WHERE NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_trigger actual
         JOIN pg_catalog.pg_class relation ON relation.oid = actual.tgrelid
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         JOIN pg_catalog.pg_proc procedure ON procedure.oid = actual.tgfoid
         JOIN pg_catalog.pg_namespace procedure_namespace
           ON procedure_namespace.oid = procedure.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure_namespace.nspname = 'public'
           AND NOT actual.tgisinternal
           AND relation.relname = target.relation_name
           AND actual.tgname = target.trigger_name
           AND procedure.proname = target.function_name
       )
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
     ), fingerprint(value) AS (
       SELECT pg_catalog.string_agg(item, E'\\n' ORDER BY item COLLATE "C")
       FROM catalog_items
     )
     SELECT value FROM fingerprint`,
  );
  const value = result.rows[0] ? rowRecord(result.rows[0]).value : null;
  return typeof value === "string" ? value : null;
}

export function schema026CatalogDigest(fingerprintInput: string | null): string | null {
  return fingerprintInput
    ? createHash("sha256").update(fingerprintInput, "utf8").digest("hex")
    : null;
}

export function assertSchema026CatalogDigest(digest: string | null): void {
  if (digest !== SCHEMA_026_CATALOG_DIGEST) {
    throw new SchemaRollbackPreflightError(
      `Schema 026 is incomplete or counterfeit: catalog digest ${String(digest)} does not match reviewed digest ${SCHEMA_026_CATALOG_DIGEST}; do not start a schema-026 application.`,
      SCHEMA_026,
    );
  }
}

export async function assertSchema026CatalogShape(
  database: RollbackPreflightQueryable,
): Promise<void> {
  assertSchema026CatalogDigest(
    schema026CatalogDigest(await schema026CatalogFingerprintInput(database)),
  );
}

export async function assertSchema026NativeSafe(
  database: RollbackPreflightQueryable,
): Promise<Schema026NativePreflightReport> {
  await assertSchema026HistoryExact(database);
  await assertSchema023FoundationCatalogShape(database);
  await assertSchema024CatalogShape(database);
  await assertSchema025CatalogShape(database);
  await assertSchema026CatalogShape(database);
  return {
    installedSchemaVersion: SCHEMA_026,
    applicationSchemaVersion: SCHEMA_026,
    mode: "native",
    safe: true,
    blockers: [],
  };
}
