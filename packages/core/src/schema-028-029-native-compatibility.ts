// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { assertSchema023FoundationCatalogShape } from "./schema-022-023-native-compatibility.js";
import { assertSchema024CatalogShape } from "./schema-023-024-native-compatibility.js";
import { assertSchema025CatalogShape } from "./schema-024-025-native-compatibility.js";
import { assertSchema027CatalogShape } from "./schema-026-027-native-compatibility.js";
import {
  EXPECTED_SCHEMA_028_HISTORY,
  assertSchema028EvidenceState,
} from "./schema-027-028-native-compatibility.js";
import {
  SchemaRollbackPreflightError,
  type RollbackPreflightQueryable,
} from "./schema-rollback-compatibility.js";

export const SCHEMA_029 = "029_stage_c_service_password_changes" as const;
export const SCHEMA_029_APPLICATION_GUARD = "opensales:schema-029-application" as const;

// Frozen after the Schema 029 PostgreSQL 18.4 native integration renders the
// exact reviewed catalog input.
export const SCHEMA_029_CATALOG_DIGEST =
  "3acb734032e6d78643bcc7e832b7a615ceb825c5b481cf591b30317a691c135d" as const;

export const EXPECTED_SCHEMA_029_HISTORY = [
  ...EXPECTED_SCHEMA_028_HISTORY,
  SCHEMA_029,
] as const;

export type Schema029NativePreflightReport = Readonly<{
  installedSchemaVersion: typeof SCHEMA_029;
  applicationSchemaVersion: typeof SCHEMA_029;
  mode: "native";
  safe: true;
  blockers: readonly [];
}>;

function rowRecord(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Schema 029 preflight returned an invalid database row");
  }
  return row as Record<string, unknown>;
}

async function assertSchema029HistoryExact(
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
  if (installed !== SCHEMA_029) {
    throw new SchemaRollbackPreflightError(
      installed === null
        ? `Database schema is missing; application schema ${SCHEMA_029} requires a forward migration.`
        : `Database schema ${installed} is incompatible with application schema ${SCHEMA_029}; run the dedicated forward migration and never run a down migration.`,
      installed,
    );
  }
  const history = await database.query(
    `SELECT pg_catalog.array_agg(version ORDER BY version COLLATE "C") = $1::text[]
       AS history_exact
     FROM public.schema_migrations`,
    [[...EXPECTED_SCHEMA_029_HISTORY]],
  );
  if (rowRecord(history.rows[0]).history_exact !== true) {
    throw new SchemaRollbackPreflightError(
      "Schema 029 migration history is incomplete or contains an unreviewed migration; repair forward without deleting migration history.",
      SCHEMA_029,
    );
  }
}

export async function schema029CatalogFingerprintInput(
  database: RollbackPreflightQueryable,
): Promise<string | null> {
  const result = await database.query(
    `WITH target_relations(name) AS (
       VALUES
         ('provider_operations'),
         ('service_cancellation_executions'),
         ('service_cancellation_requests'),
         ('service_cancellation_manual_actions'),
         ('service_cancellation_provider_attempts'),
         ('service_cancellation_reconciliation_queries'),
         ('service_cancellation_reconciliation_observations'),
         ('service_cancellation_provider_results'),
         ('service_configuration_operation_requests'),
         ('service_configuration_secret_envelopes'),
         ('service_configuration_operation_attempts'),
         ('service_configuration_operation_result_facts'),
         ('service_configuration_operation_job_transitions')
     ), target_functions(name) AS (
       VALUES
         ('opensales_reject_service_configuration_fact_mutation'),
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
         ('opensales_require_service_cancellation_manual_completion'),
         ('opensales_guard_service_configuration_secret_destruction'),
         ('opensales_service_configuration_request_fingerprint'),
         ('opensales_validate_service_configuration_request'),
         ('opensales_validate_service_configuration_envelope'),
         ('opensales_require_service_configuration_bundle'),
         ('opensales_guard_service_configuration_provider_operation'),
         ('opensales_validate_service_configuration_attempt'),
         ('opensales_validate_service_configuration_result'),
         ('opensales_guard_service_configuration_job'),
         ('opensales_validate_service_configuration_job_transition'),
         ('opensales_check_service_configuration_job_transition_commit'),
         ('opensales_check_service_configuration_result_authority'),
         ('opensales_check_service_configuration_reconcile_dispatch'),
         ('opensales_check_service_configuration_provider_projection'),
         ('opensales_check_service_configuration_envelope_projection')
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
       SELECT pg_catalog.concat_ws('|', 'index', relation.relname,
                index_record.relname,
                pg_catalog.pg_get_indexdef(index_record.oid))
       FROM pg_catalog.pg_index index_definition
       JOIN pg_catalog.pg_class relation ON relation.oid = index_definition.indrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_class index_record ON index_record.oid = index_definition.indexrelid
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

export function schema029CatalogDigest(fingerprintInput: string | null): string | null {
  return fingerprintInput
    ? createHash("sha256").update(fingerprintInput, "utf8").digest("hex")
    : null;
}

export function assertSchema029CatalogDigest(digest: string | null): void {
  if (digest !== SCHEMA_029_CATALOG_DIGEST) {
    throw new SchemaRollbackPreflightError(
      `Schema 029 catalog digest ${String(digest)} does not match reviewed digest ${SCHEMA_029_CATALOG_DIGEST}; do not start a schema-029 application.`,
      SCHEMA_029,
    );
  }
}

export async function assertSchema029CatalogShape(
  database: RollbackPreflightQueryable,
): Promise<void> {
  assertSchema029CatalogDigest(
    schema029CatalogDigest(await schema029CatalogFingerprintInput(database)),
  );
}

async function assertSchema029SecretState(
  database: RollbackPreflightQueryable,
): Promise<void> {
  const result = await database.query(
    `SELECT NOT EXISTS (
       SELECT 1
       FROM public.service_configuration_operation_requests request
       LEFT JOIN public.service_configuration_secret_envelopes envelope
         ON envelope.request_id = request.id
       LEFT JOIN public.provider_operations operation
         ON operation.subject_type = 'service_configuration_operation'
        AND operation.subject_id = request.id
       LEFT JOIN LATERAL (
         SELECT result.status
         FROM public.service_configuration_operation_result_facts result
         WHERE result.request_id = request.id
         ORDER BY result.revision DESC
         LIMIT 1
       ) latest ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::integer AS total_count,
                count(*) FILTER (
                  WHERE attempt.attempt_kind = 'mutation'
                )::integer AS mutation_count,
                count(*) FILTER (
                  WHERE attempt.attempt_kind = 'reconcile_query'
                )::integer AS reconcile_count,
                count(*) FILTER (
                  WHERE attempt.attempt_kind = 'reconcile_query'
                    AND observation.reconcile_attempt_id IS NULL
                )::integer AS outstanding_reconcile_count,
                max(attempt.attempt_number)::integer AS latest_attempt_number
         FROM public.service_configuration_operation_attempts attempt
         LEFT JOIN public.service_configuration_operation_result_facts observation
           ON observation.reconcile_attempt_id = attempt.id
         WHERE attempt.request_id = request.id
       ) attempts ON true
       LEFT JOIN public.durable_jobs start_job
         ON start_job.job_type = 'service.password_change.start'
        AND start_job.unique_key =
          'service-password-change:' || request.id::text || ':start'
       LEFT JOIN LATERAL (
         SELECT count(*)::integer AS job_count,
                count(*) FILTER (
                  WHERE job.status IN ('pending', 'running')
                )::integer AS active_count
         FROM public.durable_jobs job
         WHERE job.job_type = 'service.password_change.reconcile'
           AND job.unique_key =
             'service-password-change:' || request.id::text || ':reconcile'
       ) reconcile_jobs ON true
       WHERE envelope.request_id IS NULL
          OR operation.id IS NULL
          OR operation.kind <> 'resource.change_password'
          OR operation.provider_installation_id <> request.provider_installation_id
          OR operation.attempt_count <> attempts.mutation_count
          OR attempts.mutation_count NOT IN (0, 1)
          OR attempts.outstanding_reconcile_count NOT IN (0, 1)
          OR attempts.latest_attempt_number IS DISTINCT FROM
            CASE WHEN attempts.total_count = 0 THEN NULL ELSE attempts.total_count END
          OR start_job.id IS NULL
          OR start_job.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
            'requestId', request.id::text,
            'serviceId', request.service_id::text,
            'providerOperationId', operation.id::text
          )
          OR NOT (
            (
              latest.status IS NULL
              AND envelope.ciphertext IS NOT NULL
              AND envelope.destroyed_at IS NULL
              AND operation.status = 'queued'
              AND attempts.mutation_count = 0
              AND attempts.reconcile_count = 0
              AND start_job.status IN ('pending', 'running')
              AND reconcile_jobs.job_count = 0
            )
            OR
            (
              latest.status = 'running'
              AND envelope.ciphertext IS NOT NULL
              AND envelope.destroyed_at IS NULL
              AND operation.status = 'running'
              AND attempts.mutation_count = 1
              AND attempts.reconcile_count = 0
              AND start_job.status = 'running'
              AND reconcile_jobs.job_count = 0
            )
            OR
            (
              latest.status = 'unknown'
              AND envelope.ciphertext IS NULL
              AND envelope.destroyed_at IS NOT NULL
              AND operation.status = 'unknown'
              AND attempts.mutation_count = 1
              AND start_job.status = 'completed'
              AND reconcile_jobs.job_count = 1
              AND reconcile_jobs.active_count = 1
            )
            OR
            (
              latest.status IN ('succeeded', 'failed', 'manual')
              AND envelope.ciphertext IS NULL
              AND envelope.destroyed_at IS NOT NULL
              AND operation.status = CASE latest.status
                WHEN 'manual' THEN 'unknown'
                ELSE latest.status
              END
            )
          )
     ) AND NOT EXISTS (
       SELECT 1
       FROM public.durable_jobs job
       WHERE job.job_type IN (
         'service.password_change.start',
         'service.password_change.reconcile'
       )
         AND (
           job.payload ?| ARRAY[
             'password', 'newPassword', 'secret', 'ciphertext',
             'secretDigest', 'secret_digest'
           ]
           OR (
             SELECT count(*)
             FROM pg_catalog.jsonb_object_keys(job.payload)
           ) <> 3
         )
     ) AS secret_state_safe`,
  );
  if (rowRecord(result.rows[0]).secret_state_safe !== true) {
    throw new SchemaRollbackPreflightError(
      "Schema 029 password-change rows are not operation/job/envelope consistent.",
      SCHEMA_029,
    );
  }
}

export async function assertSchema029NativeSafe(
  database: RollbackPreflightQueryable,
): Promise<Schema029NativePreflightReport> {
  await assertSchema029HistoryExact(database);
  await assertSchema023FoundationCatalogShape(database, {
    allowSchema027NotificationTemplateExtensions: true,
    allowSchema029ServicePasswordExtensions: true,
  });
  await assertSchema024CatalogShape(database, {
    allowSchema027NotificationTemplateExtensions: true,
  });
  await assertSchema025CatalogShape(database);
  await assertSchema027CatalogShape(database);
  await assertSchema028EvidenceState(database);
  await assertSchema029CatalogShape(database);
  await assertSchema029SecretState(database);
  return {
    installedSchemaVersion: SCHEMA_029,
    applicationSchemaVersion: SCHEMA_029,
    mode: "native",
    safe: true,
    blockers: [],
  };
}
