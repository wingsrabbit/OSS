// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import {
  EXPECTED_SCHEMA_027_HISTORY,
  assertSchema027CatalogShape,
} from "./schema-026-027-native-compatibility.js";
import { assertSchema023FoundationCatalogShape } from "./schema-022-023-native-compatibility.js";
import { assertSchema024CatalogShape } from "./schema-023-024-native-compatibility.js";
import { assertSchema025CatalogShape } from "./schema-024-025-native-compatibility.js";
import {
  SchemaRollbackPreflightError,
  type RollbackPreflightQueryable,
} from "./schema-rollback-compatibility.js";

export const SCHEMA_028 = "028_stage_c_cancellation_provider_evidence" as const;
export const SCHEMA_028_APPLICATION_GUARD = "opensales:schema-028-application" as const;

// Frozen after the Schema 028 PostgreSQL 18.4 native integration renders the
// exact reviewed catalog input.
export const SCHEMA_028_CATALOG_DIGEST =
  "a6b36ece01ade15ea46e285490ed972f2a132b9f3f65e732ec4c69d23a6e8973" as const;

export const EXPECTED_SCHEMA_028_HISTORY = [
  ...EXPECTED_SCHEMA_027_HISTORY,
  SCHEMA_028,
] as const;

export type Schema028NativePreflightReport = Readonly<{
  installedSchemaVersion: typeof SCHEMA_028;
  applicationSchemaVersion: typeof SCHEMA_028;
  mode: "native";
  safe: true;
  blockers: readonly [];
}>;

function rowRecord(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Schema 028 preflight returned an invalid database row");
  }
  return row as Record<string, unknown>;
}

async function assertSchema028HistoryExact(
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
  if (installed !== SCHEMA_028) {
    throw new SchemaRollbackPreflightError(
      installed === null
        ? `Database schema is missing; application schema ${SCHEMA_028} requires a forward migration.`
        : `Database schema ${installed} is incompatible with application schema ${SCHEMA_028}; run the dedicated forward migration and never run a down migration.`,
      installed,
    );
  }
  const history = await database.query(
    `SELECT pg_catalog.array_agg(version ORDER BY version COLLATE "C") = $1::text[]
       AS history_exact
     FROM public.schema_migrations`,
    [[...EXPECTED_SCHEMA_028_HISTORY]],
  );
  if (rowRecord(history.rows[0]).history_exact !== true) {
    throw new SchemaRollbackPreflightError(
      "Schema 028 migration history is incomplete or contains an unreviewed migration; repair forward without deleting migration history.",
      SCHEMA_028,
    );
  }
}

export async function schema028CatalogFingerprintInput(
  database: RollbackPreflightQueryable,
): Promise<string | null> {
  const result = await database.query(
    `WITH target_relations(name) AS (
       VALUES
         ('service_cancellation_executions'),
         ('service_cancellation_requests'),
         ('service_cancellation_manual_actions'),
         ('service_cancellation_provider_attempts'),
         ('service_cancellation_reconciliation_queries'),
         ('service_cancellation_reconciliation_observations'),
         ('service_cancellation_provider_results'),
         ('provider_operations')
     ), target_functions(name) AS (
       VALUES
         ('opensales_reject_cancellation_evidence_mutation'),
         ('opensales_validate_service_cancellation_request'),
         ('opensales_validate_cancellation_provider_attempt'),
         ('opensales_validate_cancellation_reconciliation_query'),
         ('opensales_require_cancellation_reconciliation_attachment'),
         ('opensales_validate_cancellation_reconciliation_observation'),
         ('opensales_validate_cancellation_provider_result'),
         ('opensales_require_cancellation_operation_evidence'),
         ('opensales_guard_service_cancellation_execution_update'),
         ('opensales_guard_automatic_cancellation_service_termination'),
         ('opensales_validate_service_cancellation_manual_action'),
         ('opensales_require_service_cancellation_manual_completion')
     ), catalog_items(item) AS (
       SELECT pg_catalog.concat_ws('|', 'relation', namespace.nspname,
                relation.relname, relation.relkind::text,
                pg_catalog.pg_get_viewdef(relation.oid, true))
       FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN target_relations target ON target.name = relation.relname
       WHERE namespace.nspname = 'public'
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'column', relation.relname,
                attribute.attnum::text, attribute.attname,
                pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
                attribute.attnotnull::text,
                COALESCE(pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid), ''))
       FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN target_relations target ON target.name = relation.relname
       JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid
       LEFT JOIN pg_catalog.pg_attrdef default_value
         ON default_value.adrelid = relation.oid AND default_value.adnum = attribute.attnum
       WHERE namespace.nspname = 'public'
         AND attribute.attnum > 0 AND NOT attribute.attisdropped
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'constraint', relation.relname,
                constraint_record.conname, constraint_record.contype::text,
                constraint_record.condeferrable::text,
                constraint_record.condeferred::text,
                pg_catalog.pg_get_constraintdef(constraint_record.oid, true))
       FROM pg_catalog.pg_constraint constraint_record
       JOIN pg_catalog.pg_class relation ON relation.oid = constraint_record.conrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN target_relations target ON target.name = relation.relname
       WHERE namespace.nspname = 'public'
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'trigger', relation.relname,
                trigger_record.tgname, trigger_record.tgenabled::text,
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_triggerdef(trigger_record.oid, true), '\\s+', ' ', 'g'
                ))
       FROM pg_catalog.pg_trigger trigger_record
       JOIN pg_catalog.pg_class relation ON relation.oid = trigger_record.tgrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN target_relations target ON target.name = relation.relname
       WHERE namespace.nspname = 'public' AND NOT trigger_record.tgisinternal
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'function', namespace.nspname,
                function_record.proname,
                pg_catalog.pg_get_function_identity_arguments(function_record.oid),
                pg_catalog.pg_get_function_result(function_record.oid),
                language.lanname, function_record.provolatile::text,
                function_record.prosecdef::text,
                COALESCE(pg_catalog.array_to_string(function_record.proconfig, ','), ''),
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_functiondef(function_record.oid), '\\s+', ' ', 'g'
                ))
       FROM pg_catalog.pg_proc function_record
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = function_record.pronamespace
       JOIN pg_catalog.pg_language language ON language.oid = function_record.prolang
       JOIN target_functions target ON target.name = function_record.proname
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

export function schema028CatalogDigest(fingerprintInput: string | null): string | null {
  return fingerprintInput
    ? createHash("sha256").update(fingerprintInput, "utf8").digest("hex")
    : null;
}

export function assertSchema028CatalogDigest(digest: string | null): void {
  if (digest !== SCHEMA_028_CATALOG_DIGEST) {
    throw new SchemaRollbackPreflightError(
      `Schema 028 catalog digest ${String(digest)} does not match reviewed digest ${SCHEMA_028_CATALOG_DIGEST}; do not start a schema-028 application.`,
      SCHEMA_028,
    );
  }
}

export async function assertSchema028CatalogShape(
  database: RollbackPreflightQueryable,
): Promise<void> {
  assertSchema028CatalogDigest(
    schema028CatalogDigest(await schema028CatalogFingerprintInput(database)),
  );
}

export async function assertSchema028EvidenceState(
  database: RollbackPreflightQueryable,
): Promise<void> {
  const result = await database.query(
    `SELECT NOT EXISTS (
       SELECT 1
       FROM public.provider_operations operation
       LEFT JOIN public.service_cancellation_provider_attempts attempt
         ON attempt.provider_operation_id = operation.id
        AND attempt.execution_id = operation.subject_id
       WHERE operation.subject_type = 'service_cancellation_execution'
         AND operation.kind = 'resource_terminate'
         AND (
           operation.attempt_count NOT BETWEEN 0 AND 1
           OR (operation.attempt_count = 0 AND (operation.status <> 'queued' OR attempt.id IS NOT NULL))
           OR (operation.attempt_count = 1 AND attempt.id IS NULL)
           OR (
             operation.status IN ('succeeded', 'failed')
             AND NOT EXISTS (
               SELECT 1 FROM public.service_cancellation_provider_results provider_result
               WHERE provider_result.provider_operation_id = operation.id
                 AND provider_result.outcome = operation.status
                 AND provider_result.provider_occurred_at
                       IS NOT DISTINCT FROM operation.provider_occurred_at
             )
           )
         )
     ) AND NOT EXISTS (
       SELECT 1
       FROM public.service_cancellation_executions execution
       WHERE execution.reconciliation_query_count <> (
         SELECT count(*)::integer
         FROM public.service_cancellation_reconciliation_queries query_fact
         WHERE query_fact.execution_id = execution.id
       )
          OR execution.reconciliation_query_count NOT BETWEEN 0 AND 3
          OR (
            SELECT count(*)
            FROM public.service_cancellation_reconciliation_observations observation
            WHERE observation.execution_id = execution.id
          ) > execution.reconciliation_query_count
          OR (
            execution.execution_mode = 'automatic'
            AND execution.status = 'terminated'
            AND NOT EXISTS (
              SELECT 1
              FROM public.provider_operations operation
              JOIN public.service_cancellation_provider_results provider_result
                ON provider_result.provider_operation_id = operation.id
               AND provider_result.execution_id = execution.id
               AND provider_result.outcome = 'succeeded'
              WHERE operation.subject_type = 'service_cancellation_execution'
                AND operation.subject_id = execution.id
                AND operation.kind = 'resource_terminate'
                AND operation.status = 'succeeded'
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.service_cancellation_manual_actions manual_action
              WHERE manual_action.execution_id = execution.id
                AND manual_action.takeover_kind = 'provider_reconciliation_takeover'
            )
          )
     ) AS evidence_safe`,
  );
  if (rowRecord(result.rows[0]).evidence_safe !== true) {
    throw new SchemaRollbackPreflightError(
      "Schema 028 cancellation evidence rows are not operation/job/inbox consistent.",
      SCHEMA_028,
    );
  }
}

export async function assertSchema028NativeSafe(
  database: RollbackPreflightQueryable,
): Promise<Schema028NativePreflightReport> {
  await assertSchema028HistoryExact(database);
  await assertSchema023FoundationCatalogShape(database, {
    allowSchema027NotificationTemplateExtensions: true,
  });
  await assertSchema024CatalogShape(database, {
    allowSchema027NotificationTemplateExtensions: true,
  });
  await assertSchema025CatalogShape(database);
  // Schema 028 intentionally replaces the two Schema 026 cancellation
  // authority functions; their complete definitions and trigger bindings are
  // part of the 028 selector above. Schema 027's notification catalog remains
  // byte-for-byte frozen and is independently revalidated here.
  await assertSchema027CatalogShape(database);
  await assertSchema028CatalogShape(database);
  await assertSchema028EvidenceState(database);
  return {
    installedSchemaVersion: SCHEMA_028,
    applicationSchemaVersion: SCHEMA_028,
    mode: "native",
    safe: true,
    blockers: [],
  };
}
