// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import {
  SCHEMA_015,
  SchemaRollbackPreflightError,
  type RollbackPreflightQueryable,
  type SchemaRollbackBlocker,
} from "./schema-rollback-compatibility.js";

export const SCHEMA_016 = "016_stage_b_manual_receipts" as const;
export const SCHEMA_015_016_GUARD =
  "opensales:schema-015-016-rollback-bridge" as const;
export const SCHEMA_016_APPLICATION_GUARD =
  "opensales:schema-016-application" as const;
export const SCHEMA_016_CATALOG_DIGEST =
  "7b832420a692160278bded019b70d5bc245bec2b007efc34c70620bb7f5a2099" as const;

export type Schema015RollbackPreflightReport = Readonly<{
  installedSchemaVersion: string;
  applicationSchemaVersion: typeof SCHEMA_015;
  mode: "native" | "rollback_bridge";
  safe: true;
  blockers: readonly SchemaRollbackBlocker[];
}>;

export type Schema016NativePreflightReport = Readonly<{
  installedSchemaVersion: typeof SCHEMA_016;
  applicationSchemaVersion: typeof SCHEMA_016;
  mode: "native";
  safe: true;
  blockers: readonly [];
}>;

function rowRecord(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Schema 015 rollback preflight returned an invalid database row");
  }
  return row as Record<string, unknown>;
}

function countValue(value: unknown, code: string): number {
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Schema 015 rollback preflight returned an invalid count for ${code}`);
  }
  return count;
}

async function installedSchemaVersion(
  database: RollbackPreflightQueryable,
): Promise<string | null> {
  let result: Readonly<{ rows: unknown[] }>;
  try {
    result = await database.query(
      "SELECT max(version) AS version FROM public.schema_migrations",
    );
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    if (code === "42P01") return null;
    throw error;
  }
  const value = result.rows[0] ? rowRecord(result.rows[0]).version : null;
  return typeof value === "string" ? value : null;
}

export async function assertSchema016CatalogShape(
  database: RollbackPreflightQueryable,
): Promise<void> {
  const result = await database.query(
    `WITH required_columns(table_name, column_name, data_type, nullable) AS (
       VALUES
         ('manual_receipt_facts', 'id', 'uuid', 'NO'),
         ('manual_receipt_facts', 'client_account_id', 'uuid', 'NO'),
         ('manual_receipt_facts', 'reference', 'text', 'NO'),
         ('manual_receipt_facts', 'received_at', 'timestamp with time zone', 'NO'),
         ('manual_receipt_facts', 'gross_amount_minor', 'bigint', 'NO'),
         ('manual_receipt_facts', 'fee_minor', 'bigint', 'NO'),
         ('manual_receipt_facts', 'currency', 'text', 'NO'),
         ('manual_receipt_facts', 'actor_id', 'uuid', 'NO'),
         ('manual_receipt_facts', 'reason', 'text', 'NO'),
         ('manual_receipt_facts', 'idempotency_key', 'text', 'NO'),
         ('manual_receipt_facts', 'request_fingerprint', 'text', 'NO'),
         ('manual_receipt_facts', 'result', 'jsonb', 'NO'),
         ('manual_receipt_facts', 'created_at', 'timestamp with time zone', 'NO'),
         ('manual_receipt_reversals', 'id', 'uuid', 'NO'),
         ('manual_receipt_reversals', 'manual_receipt_id', 'uuid', 'NO'),
         ('manual_receipt_reversals', 'fund_receipt_id', 'uuid', 'NO'),
         ('manual_receipt_reversals', 'actor_id', 'uuid', 'NO'),
         ('manual_receipt_reversals', 'reason', 'text', 'NO'),
         ('manual_receipt_reversals', 'idempotency_key', 'text', 'NO'),
         ('manual_receipt_reversals', 'request_fingerprint', 'text', 'NO'),
         ('manual_receipt_reversals', 'result', 'jsonb', 'NO'),
         ('manual_receipt_reversals', 'created_at', 'timestamp with time zone', 'NO'),
         ('manual_receipt_outflows', 'id', 'uuid', 'NO'),
         ('manual_receipt_outflows', 'manual_receipt_id', 'uuid', 'NO'),
         ('manual_receipt_outflows', 'fund_receipt_id', 'uuid', 'NO'),
         ('manual_receipt_outflows', 'amount_minor', 'bigint', 'NO'),
         ('manual_receipt_outflows', 'currency', 'text', 'NO'),
         ('manual_receipt_outflows', 'destination_reference', 'text', 'NO'),
         ('manual_receipt_outflows', 'actor_id', 'uuid', 'NO'),
         ('manual_receipt_outflows', 'reason', 'text', 'NO'),
         ('manual_receipt_outflows', 'idempotency_key', 'text', 'NO'),
         ('manual_receipt_outflows', 'request_fingerprint', 'text', 'NO'),
         ('manual_receipt_outflows', 'result', 'jsonb', 'NO'),
         ('manual_receipt_outflows', 'created_at', 'timestamp with time zone', 'NO'),
         ('fund_receipts', 'reported_manual_receipt_id', 'uuid', 'YES'),
         ('fund_receipts', 'provider_installation_id', 'text', 'YES'),
         ('fund_receipts', 'external_payment_id', 'text', 'YES')
     ), column_shape AS (
       SELECT count(*) = (SELECT count(*) FROM required_columns) AS valid
       FROM required_columns required
       JOIN information_schema.columns actual
         ON actual.table_schema = 'public'
        AND actual.table_name = required.table_name
        AND actual.column_name = required.column_name
        AND actual.data_type = required.data_type
        AND actual.is_nullable = required.nullable
     ), required_constraints(
       table_name, name, kind, fragment_a, fragment_b, fragment_c
     ) AS (
       VALUES
         ('fund_receipts', 'fund_receipts_exactly_one_source', 'c',
            'num_nonnulls', 'reported_manual_receipt_id', '= 1'),
         ('fund_receipts', 'fund_receipts_source_provider_fields', 'c',
            'reported_manual_receipt_id', 'provider_installation_id', 'external_payment_id'),
         ('fund_receipts', 'fund_receipts_disposition_check', 'c',
            'disposition', 'reversed', NULL),
         ('fund_receipts', 'fund_receipts_reported_manual_receipt_id_fkey', 'f',
            'reported_manual_receipt_id', 'manual_receipt_facts', NULL),
         ('fund_receipts', 'fund_receipts_reported_manual_receipt_id_key', 'u',
            'reported_manual_receipt_id', NULL, NULL),
         ('manual_receipt_facts', 'manual_receipt_facts_client_account_id_fkey', 'f',
            'client_account_id', 'client_accounts', NULL),
         ('manual_receipt_facts', 'manual_receipt_facts_actor_id_fkey', 'f',
            'actor_id', 'users', NULL),
         ('manual_receipt_facts', 'manual_receipt_facts_idempotency_key_key', 'u',
            'idempotency_key', NULL, NULL),
         ('manual_receipt_facts', 'manual_receipt_facts_client_account_id_reference_key', 'u',
            'client_account_id', 'reference', NULL),
         ('manual_receipt_reversals', 'manual_receipt_reversals_manual_receipt_id_fkey', 'f',
            'manual_receipt_id', 'manual_receipt_facts', NULL),
         ('manual_receipt_reversals', 'manual_receipt_reversals_fund_receipt_id_fkey', 'f',
            'fund_receipt_id', 'fund_receipts', NULL),
         ('manual_receipt_reversals', 'manual_receipt_reversals_actor_id_fkey', 'f',
            'actor_id', 'users', NULL),
         ('manual_receipt_reversals', 'manual_receipt_reversals_manual_receipt_id_key', 'u',
            'manual_receipt_id', NULL, NULL),
         ('manual_receipt_reversals', 'manual_receipt_reversals_idempotency_key_key', 'u',
            'idempotency_key', NULL, NULL),
         ('manual_receipt_outflows', 'manual_receipt_outflows_manual_receipt_id_fkey', 'f',
            'manual_receipt_id', 'manual_receipt_facts', NULL),
         ('manual_receipt_outflows', 'manual_receipt_outflows_fund_receipt_id_fkey', 'f',
            'fund_receipt_id', 'fund_receipts', NULL),
         ('manual_receipt_outflows', 'manual_receipt_outflows_actor_id_fkey', 'f',
            'actor_id', 'users', NULL),
         ('manual_receipt_outflows', 'manual_receipt_outflows_idempotency_key_key', 'u',
            'idempotency_key', NULL, NULL)
     ), constraint_shape AS (
       SELECT count(*) = (SELECT count(*) FROM required_constraints) AS valid
       FROM required_constraints required
       JOIN pg_namespace namespace ON namespace.nspname = 'public'
       JOIN pg_class relation ON relation.relnamespace = namespace.oid
                             AND relation.relname = required.table_name
       JOIN pg_constraint actual ON actual.conrelid = relation.oid
                                AND actual.conname = required.name
       WHERE actual.contype::text = required.kind
         AND actual.convalidated
         AND pg_get_constraintdef(actual.oid) ILIKE '%' || required.fragment_a || '%'
         AND (required.fragment_b IS NULL
              OR pg_get_constraintdef(actual.oid) ILIKE '%' || required.fragment_b || '%')
         AND (required.fragment_c IS NULL
              OR pg_get_constraintdef(actual.oid) ILIKE '%' || required.fragment_c || '%')
     ), required_triggers(
       table_name, trigger_name, function_name, event_fragments,
       trigger_type, is_deferrable, is_initially_deferred
     ) AS (
       VALUES
         ('manual_receipt_facts', 'manual_receipt_fact_write_guard',
            'opensales_manual_receipt_write_guard', ARRAY['BEFORE', 'INSERT']::text[], 7, false, false),
         ('manual_receipt_reversals', 'manual_receipt_reversal_write_guard',
            'opensales_manual_receipt_write_guard', ARRAY['BEFORE', 'INSERT']::text[], 7, false, false),
         ('manual_receipt_outflows', 'manual_receipt_outflow_write_guard',
            'opensales_manual_receipt_write_guard', ARRAY['BEFORE', 'INSERT']::text[], 7, false, false),
         ('manual_receipt_facts', 'manual_receipt_facts_append_only',
            'opensales_reject_manual_receipt_mutation',
            ARRAY['BEFORE', 'UPDATE', 'DELETE']::text[], 27, false, false),
         ('ledger_lines', 'manual_receipt_ledger_line_mutation_guard',
            'opensales_guard_manual_receipt_ledger_line_mutation',
            ARRAY['BEFORE', 'INSERT', 'UPDATE', 'DELETE']::text[], 31, false, false),
         ('ledger_journals', 'ledger_journals_append_only',
            'opensales_reject_ledger_mutation',
            ARRAY['BEFORE', 'UPDATE', 'DELETE']::text[], 27, false, false),
         ('manual_receipt_facts', 'manual_receipt_fact_completeness_guard',
            'opensales_assert_manual_receipt_complete', ARRAY['AFTER', 'INSERT']::text[], 5, true, true),
         ('manual_receipt_reversals', 'manual_receipt_reversals_append_only',
            'opensales_reject_manual_receipt_mutation',
            ARRAY['BEFORE', 'UPDATE', 'DELETE']::text[], 27, false, false),
         ('manual_receipt_reversals', 'manual_receipt_reversal_completeness_guard',
            'opensales_assert_manual_receipt_reversal_complete',
            ARRAY['AFTER', 'INSERT']::text[], 5, true, true),
         ('manual_receipt_outflows', 'manual_receipt_outflows_append_only',
            'opensales_reject_manual_receipt_mutation',
            ARRAY['BEFORE', 'UPDATE', 'DELETE']::text[], 27, false, false),
         ('manual_receipt_outflows', 'manual_receipt_outflow_completeness_guard',
            'opensales_assert_manual_receipt_outflow_complete',
            ARRAY['AFTER', 'INSERT']::text[], 5, true, true),
         ('refunds', 'manual_receipt_provider_refund_guard',
            'opensales_guard_manual_provider_refund',
            ARRAY['BEFORE', 'INSERT', 'UPDATE']::text[], 23, false, false),
         ('fund_receipt_resolutions', 'manual_receipt_resolution_guard',
            'opensales_guard_manual_receipt_resolution',
            ARRAY['BEFORE', 'INSERT', 'UPDATE']::text[], 23, false, false),
         ('ledger_journals', 'manual_receipt_ledger_write_guard',
            'opensales_manual_receipt_marker_write_guard',
            ARRAY['BEFORE', 'INSERT', 'UPDATE']::text[], 23, false, false),
         ('provider_operations', 'manual_receipt_provider_operation_write_guard',
            'opensales_manual_receipt_marker_write_guard',
            ARRAY['BEFORE', 'INSERT', 'UPDATE']::text[], 23, false, false),
         ('durable_jobs', 'manual_receipt_job_write_guard',
            'opensales_manual_receipt_marker_write_guard',
            ARRAY['BEFORE', 'INSERT', 'UPDATE']::text[], 23, false, false),
         ('provider_inbox', 'manual_receipt_inbox_write_guard',
            'opensales_manual_receipt_marker_write_guard',
            ARRAY['BEFORE', 'INSERT', 'UPDATE']::text[], 23, false, false),
         ('outbox', 'manual_receipt_outbox_write_guard',
            'opensales_manual_receipt_marker_write_guard',
            ARRAY['BEFORE', 'INSERT', 'UPDATE']::text[], 23, false, false),
         ('fund_receipts', 'manual_receipt_fund_receipt_write_guard',
            'opensales_manual_receipt_marker_write_guard',
            ARRAY['BEFORE', 'INSERT', 'UPDATE']::text[], 23, false, false),
         ('fund_receipts', 'fund_receipts_external_facts_append_only',
            'opensales_guard_fund_receipt_fact_mutation',
            ARRAY['BEFORE', 'UPDATE', 'DELETE']::text[], 27, false, false)
     ), trigger_shape AS (
       SELECT count(*) = (SELECT count(*) FROM required_triggers) AS valid
       FROM required_triggers required
       JOIN pg_class relation ON relation.relname = required.table_name
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                                AND namespace.nspname = 'public'
       JOIN pg_trigger actual ON actual.tgrelid = relation.oid
                             AND actual.tgname = required.trigger_name
                             AND NOT actual.tgisinternal
                             AND actual.tgenabled = 'O'
       JOIN pg_proc procedure ON procedure.oid = actual.tgfoid
       JOIN pg_namespace procedure_namespace
         ON procedure_namespace.oid = procedure.pronamespace
        AND procedure_namespace.nspname = 'public'
       WHERE procedure.proname = required.function_name
         AND actual.tgtype = required.trigger_type
         AND actual.tgdeferrable = required.is_deferrable
         AND actual.tginitdeferred = required.is_initially_deferred
         AND NOT EXISTS (
           SELECT 1
           FROM unnest(required.event_fragments) fragment
           WHERE pg_get_triggerdef(actual.oid, true) NOT ILIKE '%' || fragment || '%'
         )
     ), required_functions(function_name, definition_fragments) AS (
       VALUES
         ('opensales_manual_receipt_write_guard',
            ARRAY['pg_advisory_xact_lock',
                  'opensales:schema-015-016-rollback-bridge']::text[]),
         ('opensales_manual_receipt_marker_write_guard',
            ARRAY['pg_advisory_xact_lock',
                  'opensales:schema-015-016-rollback-bridge',
                  'manual_receipt', 'ledger_journals', 'provider_operations',
                  'durable_jobs', 'provider_inbox', 'outbox', 'fund_receipts',
                  'reported_manual_receipt_id', 'reversed']::text[]),
         ('opensales_reject_manual_receipt_mutation',
            ARRAY['RAISE EXCEPTION', 'append-only']::text[]),
         ('opensales_guard_manual_receipt_ledger_line_mutation',
            ARRAY['ledger_journals', 'sealed_at', 'manual_receipt',
                  'manual_receipt_reversal', 'manual_receipt_outflow',
                  'RAISE EXCEPTION']::text[]),
         ('opensales_guard_fund_receipt_fact_mutation',
            ARRAY['Fund receipt external facts are append-only',
                  'reported_manual_receipt_id']::text[]),
         ('opensales_reject_ledger_mutation',
            ARRAY['ledger_journals', 'OLD.sealed_at IS NULL',
                  'NEW.sealed_at IS NOT NULL', 'append-only']::text[]),
         ('opensales_assert_manual_receipt_complete',
            ARRAY['ledger_journals', 'ledger_lines', 'manual_receipt',
                  'unclaimed_funds_liability', 'cash_clearing', 'sealed_at']::text[]),
         ('opensales_assert_manual_receipt_reversal_complete',
            ARRAY['ledger_journals', 'ledger_lines', 'manual_receipt_reversal',
                  'unclaimed_funds_liability', 'cash_clearing', 'sealed_at']::text[]),
         ('opensales_assert_manual_receipt_outflow_complete',
            ARRAY['ledger_journals', 'ledger_lines', 'manual_receipt_outflow',
                  'unclaimed_funds_liability', 'cash_clearing', 'sealed_at']::text[]),
         ('opensales_guard_manual_provider_refund',
            ARRAY['reported_manual_receipt_id', 'RAISE EXCEPTION']::text[]),
         ('opensales_guard_manual_receipt_resolution',
            ARRAY['reported_manual_receipt_id', 'manual_receipt_reversals',
                  'RAISE EXCEPTION']::text[])
     ), function_shape AS (
       SELECT count(*) = (SELECT count(*) FROM required_functions) AS valid
       FROM required_functions required
       JOIN pg_namespace namespace ON namespace.nspname = 'public'
       JOIN pg_proc actual ON actual.pronamespace = namespace.oid
                          AND actual.proname = required.function_name
       WHERE NOT EXISTS (
         SELECT 1
         FROM unnest(required.definition_fragments) fragment
         WHERE pg_get_functiondef(actual.oid) NOT ILIKE '%' || fragment || '%'
       )
     ), required_view_fragments(fragment) AS (
       VALUES
         ('refunds'),
         ('refund_settlements'),
         ('refund_discrepancy_settlements'),
         ('refund_security_hold_adjudications'),
         ('refund_adjudication_corrections'),
         ('refund_receipt_security_holds'),
         ('add_funds_chargeback_holds'),
         ('add_funds_chargeback_facts'),
         ('manual_receipt_reversals'),
         ('manual_receipt_outflows'),
         ('charged_back'),
         ('unknown'),
         ('manual')
     ), catalog_items(item) AS (
       SELECT concat_ws('|', 'relation', namespace.nspname, relation.relname,
                        relation.relkind::text, relation.relpersistence::text,
                        relation.relreplident::text, relation.relrowsecurity::text,
                        relation.relforcerowsecurity::text)
       FROM pg_namespace namespace
       JOIN pg_class relation ON relation.relnamespace = namespace.oid
       WHERE namespace.nspname = 'public'
         AND relation.relname IN (
           'manual_receipt_facts',
           'manual_receipt_reversals',
           'manual_receipt_outflows'
         )
       UNION ALL
       SELECT concat_ws('|', 'column', actual.table_name,
                        actual.ordinal_position::text, actual.column_name,
                        actual.data_type, actual.udt_name, actual.is_nullable,
                        COALESCE(actual.column_default, ''),
                        actual.is_identity, COALESCE(actual.identity_generation, ''),
                        actual.is_generated, COALESCE(actual.generation_expression, ''),
                        COALESCE(actual.collation_name, ''))
       FROM information_schema.columns actual
       WHERE actual.table_schema = 'public'
         AND (
           actual.table_name IN (
             'manual_receipt_facts',
             'manual_receipt_reversals',
             'manual_receipt_outflows'
           )
           OR (actual.table_name = 'fund_receipts'
             AND actual.column_name IN (
               'reported_manual_receipt_id',
               'provider_installation_id',
               'external_payment_id'
             ))
         )
       UNION ALL
       SELECT concat_ws('|', 'constraint', relation.relname, actual.conname,
                        actual.contype::text, actual.convalidated::text,
                        actual.condeferrable::text, actual.condeferred::text,
                        actual.connoinherit::text,
                        regexp_replace(pg_get_constraintdef(actual.oid), '\\s+', ' ', 'g'))
       FROM pg_namespace namespace
       JOIN pg_class relation ON relation.relnamespace = namespace.oid
       JOIN pg_constraint actual ON actual.conrelid = relation.oid
       WHERE namespace.nspname = 'public'
         AND (
           relation.relname IN (
             'manual_receipt_facts',
             'manual_receipt_reversals',
             'manual_receipt_outflows'
           )
           OR (relation.relname = 'fund_receipts'
             AND actual.conname IN (
               'fund_receipts_reported_manual_receipt_id_fkey',
               'fund_receipts_reported_manual_receipt_id_key',
               'fund_receipts_exactly_one_source',
               'fund_receipts_source_provider_fields',
               'fund_receipts_disposition_check'
             ))
         )
       UNION ALL
       SELECT concat_ws('|', 'trigger', relation.relname, actual.tgname,
                        actual.tgenabled::text, actual.tgtype::text,
                        actual.tgdeferrable::text, actual.tginitdeferred::text,
                        procedure_namespace.nspname, procedure.proname,
                        regexp_replace(pg_get_triggerdef(actual.oid, true), '\\s+', ' ', 'g'))
       FROM pg_namespace namespace
       JOIN pg_class relation ON relation.relnamespace = namespace.oid
       JOIN pg_trigger actual ON actual.tgrelid = relation.oid
       JOIN pg_proc procedure ON procedure.oid = actual.tgfoid
       JOIN pg_namespace procedure_namespace ON procedure_namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = 'public'
         AND NOT actual.tgisinternal
         AND (
           relation.relname IN (
             'manual_receipt_facts',
             'manual_receipt_reversals',
             'manual_receipt_outflows'
           )
           OR actual.tgname IN (
             'manual_receipt_provider_refund_guard',
             'manual_receipt_resolution_guard',
             'manual_receipt_ledger_write_guard',
             'manual_receipt_provider_operation_write_guard',
             'manual_receipt_job_write_guard',
             'manual_receipt_inbox_write_guard',
             'manual_receipt_outbox_write_guard',
             'manual_receipt_fund_receipt_write_guard',
             'manual_receipt_ledger_line_mutation_guard',
             'fund_receipts_external_facts_append_only',
             'ledger_journals_append_only'
           )
         )
       UNION ALL
       SELECT concat_ws('|', 'function', namespace.nspname, actual.proname,
                        language.lanname, actual.provolatile::text,
                        actual.prosecdef::text, actual.proleakproof::text,
                        COALESCE(array_to_string(actual.proconfig, ','), ''),
                        pg_get_function_identity_arguments(actual.oid),
                        pg_get_function_result(actual.oid),
                        regexp_replace(btrim(actual.prosrc), '\\s+', ' ', 'g'))
       FROM pg_namespace namespace
       JOIN pg_proc actual ON actual.pronamespace = namespace.oid
       JOIN pg_language language ON language.oid = actual.prolang
       WHERE namespace.nspname = 'public'
         AND actual.proname IN (
           'opensales_manual_receipt_write_guard',
           'opensales_manual_receipt_marker_write_guard',
           'opensales_reject_manual_receipt_mutation',
           'opensales_guard_manual_receipt_ledger_line_mutation',
           'opensales_guard_fund_receipt_fact_mutation',
           'opensales_reject_ledger_mutation',
           'opensales_assert_manual_receipt_complete',
           'opensales_assert_manual_receipt_reversal_complete',
           'opensales_assert_manual_receipt_outflow_complete',
           'opensales_guard_manual_provider_refund',
           'opensales_guard_manual_receipt_resolution'
         )
       UNION ALL
       SELECT concat_ws('|', 'view', 'unclaimed_fund_refund_capacity',
                        regexp_replace(
                          pg_get_viewdef('public.unclaimed_fund_refund_capacity'::regclass, true),
                          '\\s+', ' ', 'g'
                        ))
     ), catalog_fingerprint(value) AS (
       SELECT string_agg(item, E'\n' ORDER BY item COLLATE "C")
       FROM catalog_items
     )
     SELECT
       (SELECT count(*) = 2
        FROM public.schema_migrations
        WHERE version IN (
          '015_stage_b_saved_payment_auto_renew',
          '016_stage_b_manual_receipts'
        )) AS has_contiguous_history,
       to_regclass('public.manual_receipt_facts') IS NOT NULL
         AND to_regclass('public.manual_receipt_reversals') IS NOT NULL
         AND to_regclass('public.manual_receipt_outflows') IS NOT NULL
         AND (SELECT valid FROM column_shape) AS has_columns,
       (SELECT valid FROM constraint_shape) AS has_constraints,
       (SELECT valid FROM trigger_shape) AS has_triggers,
       (SELECT valid FROM function_shape) AS has_functions,
       (SELECT value FROM catalog_fingerprint) AS catalog_fingerprint_input,
       to_regclass('public.unclaimed_fund_refund_capacity') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM required_view_fragments required
           WHERE pg_get_viewdef('public.unclaimed_fund_refund_capacity'::regclass, true)
                   NOT ILIKE '%' || required.fragment || '%'
         ) AS has_capacity_view`,
  );
  const shape = rowRecord(result.rows[0]);
  const catalogFingerprintInput = shape.catalog_fingerprint_input;
  const catalogDigest =
    typeof catalogFingerprintInput === "string"
      ? createHash("sha256").update(catalogFingerprintInput, "utf8").digest("hex")
      : null;
  if (catalogDigest !== SCHEMA_016_CATALOG_DIGEST) {
    throw new SchemaRollbackPreflightError(
      `Schema 016 is incomplete or counterfeit: catalog digest ${String(catalogDigest)} does not match reviewed digest ${SCHEMA_016_CATALOG_DIGEST}; do not start a schema-016 application or the 015 rollback bridge.`,
      SCHEMA_016,
    );
  }
  if (
    shape.has_contiguous_history !== true ||
    shape.has_columns !== true ||
    shape.has_constraints !== true ||
    shape.has_triggers !== true ||
    shape.has_functions !== true ||
    shape.has_capacity_view !== true
  ) {
    throw new SchemaRollbackPreflightError(
      "Schema 016 is incomplete or counterfeit; do not start a schema-016 application or the 015 rollback bridge. Deploy a compatible application and repair forward without a down migration.",
      SCHEMA_016,
    );
  }
}

export async function assertSchema016NativeSafe(
  database: RollbackPreflightQueryable,
): Promise<Schema016NativePreflightReport> {
  const installed = await installedSchemaVersion(database);
  if (installed !== SCHEMA_016) {
    throw new SchemaRollbackPreflightError(
      installed === null
        ? `Database schema is missing; application schema ${SCHEMA_016} requires a forward migration.`
        : `Database schema ${installed} is incompatible with application schema ${SCHEMA_016}; run the dedicated forward migration or the matching application version.`,
      installed,
    );
  }
  await assertSchema016CatalogShape(database);
  return {
    installedSchemaVersion: SCHEMA_016,
    applicationSchemaVersion: SCHEMA_016,
    mode: "native",
    safe: true,
    blockers: [],
  };
}

async function schema016Blockers(
  database: RollbackPreflightQueryable,
): Promise<readonly SchemaRollbackBlocker[]> {
  const result = await database.query(
    `WITH blocker_counts(code, count) AS (
       SELECT 'manual_receipt_facts', count(*)::bigint FROM public.manual_receipt_facts
       UNION ALL
       SELECT 'manual_receipt_reversals', count(*)::bigint FROM public.manual_receipt_reversals
       UNION ALL
       SELECT 'manual_receipt_outflows', count(*)::bigint FROM public.manual_receipt_outflows
       UNION ALL
       SELECT 'manual_fund_receipts', count(*)::bigint
       FROM public.fund_receipts
       WHERE reported_manual_receipt_id IS NOT NULL OR disposition = 'reversed'
       UNION ALL
       SELECT 'manual_fund_resolutions', count(*)::bigint
       FROM public.fund_receipt_resolutions resolution
       JOIN public.fund_receipts receipt ON receipt.id = resolution.fund_receipt_id
       WHERE receipt.reported_manual_receipt_id IS NOT NULL
       UNION ALL
       SELECT 'manual_fund_allocations', count(*)::bigint
       FROM public.fund_receipt_allocations allocation
       JOIN public.fund_receipts receipt ON receipt.id = allocation.fund_receipt_id
       WHERE receipt.reported_manual_receipt_id IS NOT NULL
       UNION ALL
       SELECT 'manual_refunds', count(*)::bigint
       FROM public.refunds refund
       JOIN public.fund_receipts receipt ON receipt.id = refund.source_fund_receipt_id
       WHERE receipt.reported_manual_receipt_id IS NOT NULL
       UNION ALL
       SELECT 'manual_ledger_journals', count(*)::bigint
       FROM public.ledger_journals journal
       WHERE journal.source_type IN (
         'manual_receipt', 'manual_receipt_reversal', 'manual_receipt_outflow'
       )
       UNION ALL
       SELECT 'manual_provider_operations', count(*)::bigint
       FROM public.provider_operations operation
       WHERE operation.subject_type IN ('manual_receipt', 'manual_receipt_outflow')
       UNION ALL
       SELECT 'manual_durable_jobs', count(*)::bigint
       FROM public.durable_jobs job
       WHERE job.payload ? 'manualReceiptId'
          OR job.payload ? 'manualReceiptOutflowId'
          OR job.job_type LIKE 'manual_receipt.%'
       UNION ALL
       SELECT 'manual_provider_inbox', count(*)::bigint
       FROM public.provider_inbox inbox
       WHERE inbox.payload ? 'manualReceiptId'
          OR inbox.payload ? 'manualReceiptOutflowId'
       UNION ALL
       SELECT 'manual_outbox', count(*)::bigint
       FROM public.outbox event
       WHERE event.payload ? 'manualReceiptId'
          OR event.payload ? 'manualReceiptOutflowId'
          OR event.event_type LIKE 'manual_receipt.%'
     )
     SELECT code, count::text AS count
     FROM blocker_counts
     WHERE count > 0
     ORDER BY code COLLATE "C"`,
  );
  return result.rows.map((row) => {
    const record = rowRecord(row);
    if (typeof record.code !== "string") {
      throw new Error("Schema 015 rollback preflight returned an invalid blocker code");
    }
    return Object.freeze({
      code: record.code,
      count: countValue(record.count, record.code),
    });
  });
}

export async function assert015RollbackBridgeSafe(
  database: RollbackPreflightQueryable,
  input: Readonly<{ enable016RollbackBridge: boolean }>,
): Promise<Schema015RollbackPreflightReport> {
  const installed = await installedSchemaVersion(database);
  if (!installed) {
    throw new SchemaRollbackPreflightError(
      "OpenSales schema is missing. Initialize it with the dedicated migrate command before starting the application.",
      null,
    );
  }
  if (installed === SCHEMA_015) {
    return Object.freeze({
      installedSchemaVersion: installed,
      applicationSchemaVersion: SCHEMA_015,
      mode: "native",
      safe: true,
      blockers: Object.freeze([]),
    });
  }
  if (installed !== SCHEMA_016) {
    const direction = installed < SCHEMA_015 ? "older" : "newer";
    throw new SchemaRollbackPreflightError(
      `OpenSales schema ${installed} is ${direction} than the 015 bridge supports. ${
        direction === "older"
          ? "Run the dedicated forward migration command."
          : "Deploy an application that explicitly supports that schema; do not run a down migration."
      }`,
      installed,
    );
  }
  if (!input.enable016RollbackBridge) {
    throw new SchemaRollbackPreflightError(
      "Schema 016 requires the reviewed 015 rollback bridge and explicit OSS_SCHEMA_ROLLBACK_BRIDGE=015-to-016 after the rollback runbook preflight. Ordinary 015 images must remain stopped.",
      installed,
    );
  }

  await assertSchema016CatalogShape(database);
  const blockers = await schema016Blockers(database);
  if (blockers.length > 0) {
    throw new SchemaRollbackPreflightError(
      `Rollback to the 015 bridge is blocked by 016-only business facts: ${blockers
        .map(({ code, count }) => `${code}=${count}`)
        .join(", ")}. Keep financial mutation paused and repair forward. This bridge never deletes or rewrites these facts.`,
      installed,
      blockers,
    );
  }

  return Object.freeze({
    installedSchemaVersion: installed,
    applicationSchemaVersion: SCHEMA_015,
    mode: "rollback_bridge",
    safe: true,
    blockers: Object.freeze([]),
  });
}
