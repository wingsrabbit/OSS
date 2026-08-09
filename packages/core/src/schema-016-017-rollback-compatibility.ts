// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import {
  assertSchema016NativeSafe,
  SCHEMA_016,
} from "./schema-015-016-rollback-compatibility.js";
import {
  SchemaRollbackPreflightError,
  type RollbackPreflightQueryable,
  type SchemaRollbackBlocker,
} from "./schema-rollback-compatibility.js";

export const SCHEMA_017 = "017_stage_b_manual_receipt_outflow_reports" as const;
export const SCHEMA_016_017_GUARD =
  "opensales:schema-016-017-rollback-bridge" as const;
export const SCHEMA_017_APPLICATION_GUARD =
  "opensales:schema-017-application" as const;

export const SCHEMA_017_CATALOG_DIGEST =
  "c47371a58ef68daa553745e2bb5e9e2828310f2b97100fdb2e4620ab1866c760" as const;

const EXPECTED_MIGRATION_HISTORY = [
  "001_stage_a",
  "002_staff_stage_a",
  "003_stage_a_financial_hardening",
  "004_stage_b_credit_and_fees",
  "005_stage_b_add_funds",
  "006_stage_b_unclaimed_funds",
  "007_stage_b_manual_refunds",
  "008_stage_b_refund_reconciliation",
  "009_stage_b_refund_capacity_incidents",
  "010_stage_b_unclaimed_refunds",
  "011_stage_b_add_funds_chargebacks",
  "012_stage_b_renewal_lifecycle",
  "013_stage_b_late_fee_suspension",
  "014_stage_b_cycle_end_cancellation",
  "015_stage_b_saved_payment_auto_renew",
  "016_stage_b_manual_receipts",
  SCHEMA_017,
] as const;

export type Schema017NativePreflightReport = Readonly<{
  installedSchemaVersion: typeof SCHEMA_017;
  applicationSchemaVersion: typeof SCHEMA_017;
  mode: "native";
  safe: true;
  blockers: readonly [];
}>;

export type Schema016BridgePreflightReport = Readonly<{
  installedSchemaVersion: typeof SCHEMA_016 | typeof SCHEMA_017;
  applicationSchemaVersion: typeof SCHEMA_016;
  mode: "native" | "rollback_bridge";
  safe: true;
  blockers: readonly SchemaRollbackBlocker[];
}>;

function rowRecord(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Schema 016/017 preflight returned an invalid database row");
  }
  return row as Record<string, unknown>;
}

function countValue(value: unknown, code: string): number {
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Schema 016/017 preflight returned an invalid count for ${code}`);
  }
  return count;
}

async function installedSchemaVersion(
  database: RollbackPreflightQueryable,
): Promise<string | null> {
  let result: Readonly<{ rows: unknown[] }>;
  try {
    result = await database.query(
      "SELECT pg_catalog.max(version) AS version FROM public.schema_migrations",
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

export async function schema017CatalogFingerprintInput(
  database: RollbackPreflightQueryable,
): Promise<Readonly<{ historyExact: boolean; fingerprintInput: string | null }>> {
  const result = await database.query(
    `WITH catalog_items(item) AS (
       SELECT pg_catalog.concat_ws('|', 'relation', namespace.nspname, relation.relname,
                relation.relkind::text, relation.relpersistence::text,
                relation.relreplident::text, relation.relrowsecurity::text,
                relation.relforcerowsecurity::text)
       FROM pg_catalog.pg_namespace namespace
       JOIN pg_catalog.pg_class relation ON relation.relnamespace = namespace.oid
       WHERE namespace.nspname = 'public'
         AND relation.relname IN (
           'durable_jobs_pending_type_available_created_idx',
           'client_account_debt_accounts',
           'client_account_debt_transactions',
           'client_accounts',
           'credit_accounts',
           'credit_allocations',
           'credit_transactions',
           'fund_receipts',
           'fund_receipt_allocations',
           'fund_receipt_resolution_requests',
           'fund_receipt_resolutions',
           'ledger_journals',
           'ledger_lines',
           'manual_receipt_facts',
           'manual_receipt_reversals',
           'manual_receipt_outflow_reports',
           'manual_receipt_outflow_reconciliations',
           'manual_receipt_credit_holds',
           'manual_receipt_credit_outflow_effects',
           'manual_receipt_credit_outflow_restrictions',
           'manual_receipt_outflows'
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'column', actual.table_name,
                actual.ordinal_position::text, actual.column_name,
                actual.data_type, actual.udt_name, actual.is_nullable,
                COALESCE(actual.column_default, ''),
                actual.is_identity, COALESCE(actual.identity_generation, ''),
                actual.is_generated, COALESCE(actual.generation_expression, ''),
                COALESCE(actual.collation_name, ''))
       FROM information_schema.columns actual
       WHERE actual.table_schema = 'public'
         AND actual.table_name IN (
           'client_account_debt_accounts',
           'client_account_debt_transactions',
           'client_accounts',
           'credit_accounts',
           'credit_allocations',
           'credit_transactions',
           'fund_receipts',
           'fund_receipt_allocations',
           'fund_receipt_resolution_requests',
           'fund_receipt_resolutions',
           'ledger_journals',
           'ledger_lines',
           'manual_receipt_facts',
           'manual_receipt_reversals',
           'manual_receipt_outflow_reports',
           'manual_receipt_outflow_reconciliations',
           'manual_receipt_credit_holds',
           'manual_receipt_credit_outflow_effects',
           'manual_receipt_credit_outflow_restrictions',
           'manual_receipt_outflows'
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'index', actual.schemaname,
                actual.tablename, actual.indexname,
                pg_catalog.regexp_replace(actual.indexdef, '\\s+', ' ', 'g'))
       FROM pg_catalog.pg_indexes actual
       WHERE actual.schemaname = 'public'
         AND actual.indexname = 'durable_jobs_pending_type_available_created_idx'
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'constraint', relation.relname, actual.conname,
                actual.contype::text, actual.convalidated::text,
                actual.condeferrable::text, actual.condeferred::text,
                actual.connoinherit::text,
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_constraintdef(actual.oid), '\\s+', ' ', 'g'
                ))
       FROM pg_catalog.pg_namespace namespace
       JOIN pg_catalog.pg_class relation ON relation.relnamespace = namespace.oid
       JOIN pg_catalog.pg_constraint actual ON actual.conrelid = relation.oid
       WHERE namespace.nspname = 'public'
         AND (
           relation.relname IN (
             'client_account_debt_accounts',
             'client_account_debt_transactions',
             'client_accounts',
             'credit_accounts',
             'credit_allocations',
             'credit_transactions',
             'fund_receipts',
             'fund_receipt_allocations',
             'fund_receipt_resolution_requests',
             'fund_receipt_resolutions',
             'ledger_journals',
             'ledger_lines',
             'manual_receipt_facts',
             'manual_receipt_reversals',
             'manual_receipt_outflow_reports',
             'manual_receipt_outflow_reconciliations',
             'manual_receipt_credit_holds',
             'manual_receipt_credit_outflow_effects',
             'manual_receipt_credit_outflow_restrictions',
             'manual_receipt_outflows'
           )
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'trigger', relation.relname, actual.tgname,
                actual.tgenabled::text, actual.tgtype::text,
                actual.tgdeferrable::text, actual.tginitdeferred::text,
                procedure_namespace.nspname, procedure.proname,
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_triggerdef(actual.oid, true), '\\s+', ' ', 'g'
                ))
       FROM pg_catalog.pg_namespace namespace
       JOIN pg_catalog.pg_class relation ON relation.relnamespace = namespace.oid
       JOIN pg_catalog.pg_trigger actual ON actual.tgrelid = relation.oid
       JOIN pg_catalog.pg_proc procedure ON procedure.oid = actual.tgfoid
       JOIN pg_catalog.pg_namespace procedure_namespace
         ON procedure_namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = 'public'
         AND NOT actual.tgisinternal
         AND (
           relation.relname IN (
             'client_account_debt_accounts',
             'client_account_debt_transactions',
             'client_accounts',
             'credit_accounts',
             'credit_allocations',
             'credit_transactions',
             'fund_receipts',
             'fund_receipt_allocations',
             'fund_receipt_resolution_requests',
             'fund_receipt_resolutions',
             'ledger_journals',
             'ledger_lines',
             'manual_receipt_facts',
             'manual_receipt_reversals',
             'manual_receipt_outflow_reports',
             'manual_receipt_outflow_reconciliations',
             'manual_receipt_credit_holds',
             'manual_receipt_credit_outflow_effects',
             'manual_receipt_credit_outflow_restrictions',
             'manual_receipt_outflows'
           )
           OR actual.tgname IN (
             'a_schema_017_ledger_marker_guard',
             'a_schema_017_credit_marker_guard',
             'a_schema_017_existing_restriction_marker_guard',
             'a_schema_017_provider_operation_marker_guard',
             'a_schema_017_job_marker_guard',
             'a_schema_017_inbox_marker_guard',
             'a_schema_017_outbox_marker_guard',
             'a_schema_017_audit_marker_guard',
             'b_schema_017_running_job_identity_guard',
             'manual_receipt_ledger_line_mutation_guard',
             'manual_receipt_provider_refund_guard',
             'manual_receipt_resolution_guard',
             'manual_receipt_ledger_write_guard',
             'manual_receipt_provider_operation_write_guard',
             'manual_receipt_job_write_guard',
             'manual_receipt_inbox_write_guard',
             'manual_receipt_outbox_write_guard',
             'manual_receipt_fund_receipt_write_guard',
             'ledger_journals_append_only',
             'z_schema_017_manual_outflow_provider_rejection'
           )
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'function', namespace.nspname, actual.proname,
                language.lanname, actual.provolatile::text,
                actual.prosecdef::text, actual.proleakproof::text,
                COALESCE(pg_catalog.array_to_string(actual.proconfig, ','), ''),
                pg_catalog.pg_get_function_identity_arguments(actual.oid),
                pg_catalog.pg_get_function_result(actual.oid),
                pg_catalog.regexp_replace(pg_catalog.btrim(actual.prosrc), '\\s+', ' ', 'g'))
       FROM pg_catalog.pg_namespace namespace
       JOIN pg_catalog.pg_proc actual ON actual.pronamespace = namespace.oid
       JOIN pg_catalog.pg_language language ON language.oid = actual.prolang
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
           'opensales_validate_manual_receipt_reversal_017',
           'opensales_guard_manual_provider_refund',
           'opensales_guard_manual_receipt_resolution',
           'opensales_reject_credit_mutation',
           'opensales_guard_credit_balance',
           'opensales_validate_unclaimed_funds_credit',
           'opensales_validate_fund_receipt_resolution',
           'opensales_guard_manual_outflow_resolution_capacity',
           'opensales_reject_fund_resolution_mutation',
           'opensales_validate_fund_resolution_request',
           'opensales_validate_fund_receipt_allocation',
           'opensales_reject_chargeback_mutation',
           'opensales_guard_debt_balance',
           'opensales_validate_chargeback_debt',
           'opensales_guard_active_account_restriction',
           'opensales_invalidate_client_account_reauth',
           'opensales_assert_journal_balanced',
           'opensales_schema_017_marker_guard',
           'opensales_guard_running_durable_job_identity',
           'opensales_reject_manual_receipt_outflow_mutation',
           'opensales_validate_manual_receipt_outflow_authorization',
           'opensales_validate_manual_receipt_outflow_report',
           'opensales_assert_manual_receipt_outflow_report_complete',
           'opensales_validate_manual_receipt_outflow_reconciliation',
           'opensales_assert_manual_receipt_outflow_reconciliation_complete',
           'opensales_validate_manual_receipt_outflow_fact',
           'opensales_validate_manual_receipt_credit_hold',
           'opensales_validate_manual_receipt_credit_outflow_effect',
           'opensales_validate_manual_receipt_outflow_credit',
           'opensales_validate_manual_receipt_outflow_debt',
           'opensales_apply_manual_receipt_outflow_restriction',
           'opensales_assert_manual_receipt_outflow_complete',
           'opensales_assert_manual_receipt_credit_outflow_complete',
           'opensales_assert_manual_receipt_outflow_marker_bound',
           'opensales_reject_manual_receipt_provider_artifact'
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'view', relation.relname,
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_viewdef(relation.oid, true), '\\s+', ' ', 'g'
                ))
       FROM pg_catalog.pg_namespace namespace
       JOIN pg_catalog.pg_class relation ON relation.relnamespace = namespace.oid
       WHERE namespace.nspname = 'public'
         AND relation.relkind = 'v'
         AND relation.relname IN (
           'manual_receipt_outflow_capacity',
           'unclaimed_fund_refund_capacity'
         )
     ), fingerprint(value) AS (
       SELECT pg_catalog.string_agg(item, E'\\n' ORDER BY item COLLATE "C")
       FROM catalog_items
     )
     SELECT
       (SELECT pg_catalog.array_agg(version ORDER BY version COLLATE "C")
        FROM public.schema_migrations) = $1::text[] AS history_exact,
       (SELECT value FROM fingerprint) AS fingerprint_input`,
    [[...EXPECTED_MIGRATION_HISTORY]],
  );
  const row = rowRecord(result.rows[0]);
  return {
    historyExact: row.history_exact === true,
    fingerprintInput:
      typeof row.fingerprint_input === "string" ? row.fingerprint_input : null,
  };
}

export async function assertSchema017CatalogShape(
  database: RollbackPreflightQueryable,
): Promise<void> {
  const shape = await schema017CatalogFingerprintInput(database);
  const digest = shape.fingerprintInput
    ? createHash("sha256").update(shape.fingerprintInput, "utf8").digest("hex")
    : null;
  if (digest !== SCHEMA_017_CATALOG_DIGEST) {
    throw new SchemaRollbackPreflightError(
      `Schema 017 is incomplete or counterfeit: catalog digest ${String(digest)} does not match reviewed digest ${SCHEMA_017_CATALOG_DIGEST}; do not start a schema-017 application or the 016 rollback bridge.`,
      SCHEMA_017,
    );
  }
  if (!shape.historyExact) {
    throw new SchemaRollbackPreflightError(
      "Schema 017 migration history is incomplete or contains an unreviewed migration; repair forward without deleting migration history.",
      SCHEMA_017,
    );
  }
}

async function schema017Blockers(
  database: RollbackPreflightQueryable,
): Promise<readonly SchemaRollbackBlocker[]> {
  const result = await database.query(
    `WITH blocker_counts(code, count) AS (
       SELECT 'manual_receipt_outflow_reports', pg_catalog.count(*)::bigint
       FROM public.manual_receipt_outflow_reports
       UNION ALL
       SELECT 'manual_receipt_outflow_reconciliations', pg_catalog.count(*)::bigint
       FROM public.manual_receipt_outflow_reconciliations
       UNION ALL
       SELECT 'manual_receipt_credit_holds', pg_catalog.count(*)::bigint
       FROM public.manual_receipt_credit_holds
       UNION ALL
       SELECT 'manual_receipt_credit_outflow_effects', pg_catalog.count(*)::bigint
       FROM public.manual_receipt_credit_outflow_effects
       UNION ALL
       SELECT 'manual_receipt_credit_outflow_restrictions', pg_catalog.count(*)::bigint
       FROM public.manual_receipt_credit_outflow_restrictions
       UNION ALL
       SELECT 'manual_receipt_outflows', pg_catalog.count(*)::bigint
       FROM public.manual_receipt_outflows
       UNION ALL
       SELECT 'manual_receipt_outflow_ledger', pg_catalog.count(*)::bigint
       FROM public.ledger_journals WHERE source_type = 'manual_receipt_outflow'
       UNION ALL
       SELECT 'manual_receipt_outflow_credit', pg_catalog.count(*)::bigint
       FROM public.credit_transactions
       WHERE kind = 'manual_receipt_outflow'
          OR source_type IN (
            'manual_receipt_outflow', 'manual_receipt_credit_outflow_effect'
          )
       UNION ALL
       SELECT 'manual_receipt_outflow_debt', pg_catalog.count(*)::bigint
       FROM public.client_account_debt_transactions
       WHERE source_type = 'manual_receipt_credit_outflow_effect'
       UNION ALL
       SELECT 'manual_receipt_outflow_account_restrictions', pg_catalog.count(*)::bigint
       FROM public.client_account_restrictions
       WHERE source_type = 'manual_receipt_credit_outflow_effect'
       UNION ALL
       SELECT 'manual_receipt_outflow_provider_operations', pg_catalog.count(*)::bigint
       FROM public.provider_operations
       WHERE subject_type IN ('manual_receipt_outflow_report', 'manual_receipt_outflow')
       UNION ALL
       SELECT 'manual_receipt_outflow_jobs', pg_catalog.count(*)::bigint
       FROM public.durable_jobs
       WHERE job_type LIKE 'manual_receipt_outflow.%'
          OR payload ? 'manualReceiptOutflowReportId'
          OR payload ? 'manualReceiptOutflowId'
       UNION ALL
       SELECT 'manual_receipt_outflow_inbox', pg_catalog.count(*)::bigint
       FROM public.provider_inbox
       WHERE payload ? 'manualReceiptOutflowReportId'
          OR payload ? 'manualReceiptOutflowId'
       UNION ALL
       SELECT 'manual_receipt_outflow_outbox', pg_catalog.count(*)::bigint
       FROM public.outbox
       WHERE event_type LIKE 'manual_receipt_outflow.%'
          OR payload ? 'manualReceiptOutflowReportId'
          OR payload ? 'manualReceiptOutflowId'
       UNION ALL
       SELECT 'manual_receipt_outflow_audit', pg_catalog.count(*)::bigint
       FROM public.audit_events
       WHERE target_type IN (
         'manual_receipt_outflow_report', 'manual_receipt_outflow'
       )
     )
     SELECT code, count::text
     FROM blocker_counts
     WHERE count > 0
     ORDER BY code COLLATE "C"`,
  );
  return result.rows.map((row) => {
    const record = rowRecord(row);
    const code = record.code;
    if (typeof code !== "string") {
      throw new Error("Schema 017 rollback preflight returned an invalid blocker code");
    }
    return Object.freeze({ code, count: countValue(record.count, code) });
  });
}

export async function assertSchema017NativeSafe(
  database: RollbackPreflightQueryable,
): Promise<Schema017NativePreflightReport> {
  const installed = await installedSchemaVersion(database);
  if (installed !== SCHEMA_017) {
    throw new SchemaRollbackPreflightError(
      installed === null
        ? `Database schema is missing; application schema ${SCHEMA_017} requires a forward migration.`
        : `Database schema ${installed} is incompatible with application schema ${SCHEMA_017}; run the dedicated forward migration or the matching application version.`,
      installed,
    );
  }
  await assertSchema017CatalogShape(database);
  return {
    installedSchemaVersion: SCHEMA_017,
    applicationSchemaVersion: SCHEMA_017,
    mode: "native",
    safe: true,
    blockers: [],
  };
}

export async function assertSchema016RollbackBridgeSafe(
  database: RollbackPreflightQueryable,
  input: Readonly<{ enable017RollbackBridge: boolean }>,
): Promise<Schema016BridgePreflightReport> {
  const installed = await installedSchemaVersion(database);
  if (installed === SCHEMA_016) {
    const native = await assertSchema016NativeSafe(database);
    return { ...native, applicationSchemaVersion: SCHEMA_016 };
  }
  if (installed !== SCHEMA_017) {
    throw new SchemaRollbackPreflightError(
      installed === null
        ? `Database schema is missing; application schema ${SCHEMA_016} requires a forward migration.`
        : installed < SCHEMA_016
          ? `Database schema ${installed} is older than application schema ${SCHEMA_016}; run the dedicated forward migration.`
          : `Database schema ${installed} is newer than the reviewed ${SCHEMA_016} rollback bridge; do not run a down migration.`,
      installed,
    );
  }
  if (!input.enable017RollbackBridge) {
    throw new SchemaRollbackPreflightError(
      "Schema 017 requires the native schema-017 application. A reviewed schema-016 rollback artifact must set OSS_SCHEMA_ROLLBACK_BRIDGE=016-to-017 explicitly.",
      installed,
    );
  }
  await assertSchema017CatalogShape(database);
  const blockers = await schema017Blockers(database);
  if (blockers.length > 0) {
    throw new SchemaRollbackPreflightError(
      "Schema 017 contains manual receipt outflow facts or artifacts that schema 016 cannot understand. Keep financial mutation stopped and repair forward or use manual takeover; do not delete facts or run a down migration.",
      installed,
      blockers,
    );
  }
  return {
    installedSchemaVersion: SCHEMA_017,
    applicationSchemaVersion: SCHEMA_016,
    mode: "rollback_bridge",
    safe: true,
    blockers: [],
  };
}
