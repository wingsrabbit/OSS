// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  SCHEMA_015,
  SchemaRollbackPreflightError,
  type RollbackPreflightQueryable,
  type SchemaRollbackBlocker,
} from "./schema-rollback-compatibility.js";

export const SCHEMA_016 = "016_stage_b_manual_receipts" as const;
export const SCHEMA_015_016_GUARD =
  "opensales:schema-015-016-rollback-bridge" as const;

export type Schema015RollbackPreflightReport = Readonly<{
  installedSchemaVersion: string;
  applicationSchemaVersion: typeof SCHEMA_015;
  mode: "native" | "rollback_bridge";
  safe: true;
  blockers: readonly SchemaRollbackBlocker[];
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
    result = await database.query("SELECT max(version) AS version FROM schema_migrations");
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

async function assertSchema016Shape(database: RollbackPreflightQueryable): Promise<void> {
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
         AND pg_get_constraintdef(actual.oid) ILIKE '%' || required.fragment_a || '%'
         AND (required.fragment_b IS NULL
              OR pg_get_constraintdef(actual.oid) ILIKE '%' || required.fragment_b || '%')
         AND (required.fragment_c IS NULL
              OR pg_get_constraintdef(actual.oid) ILIKE '%' || required.fragment_c || '%')
     ), required_triggers(table_name, trigger_name) AS (
       VALUES
         ('manual_receipt_facts', 'manual_receipt_facts_append_only'),
         ('manual_receipt_facts', 'manual_receipt_fact_completeness_guard'),
         ('manual_receipt_reversals', 'manual_receipt_reversals_append_only'),
         ('manual_receipt_reversals', 'manual_receipt_reversal_completeness_guard'),
         ('manual_receipt_outflows', 'manual_receipt_outflows_append_only'),
         ('manual_receipt_outflows', 'manual_receipt_outflow_completeness_guard'),
         ('refunds', 'manual_receipt_provider_refund_guard'),
         ('fund_receipt_resolutions', 'manual_receipt_resolution_guard')
     ), trigger_shape AS (
       SELECT count(*) = (SELECT count(*) FROM required_triggers) AS valid
       FROM required_triggers required
       JOIN pg_class relation ON relation.relname = required.table_name
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                                AND namespace.nspname = 'public'
       JOIN pg_trigger actual ON actual.tgrelid = relation.oid
                             AND actual.tgname = required.trigger_name
                             AND NOT actual.tgisinternal
                             AND actual.tgenabled <> 'D'
     )
     SELECT
       to_regclass('public.manual_receipt_facts') IS NOT NULL
         AND to_regclass('public.manual_receipt_reversals') IS NOT NULL
         AND to_regclass('public.manual_receipt_outflows') IS NOT NULL
         AND (SELECT valid FROM column_shape) AS has_columns,
       (SELECT valid FROM constraint_shape) AS has_constraints,
       (SELECT valid FROM trigger_shape) AS has_triggers,
       to_regclass('public.unclaimed_fund_refund_capacity') IS NOT NULL
         AND pg_get_viewdef('public.unclaimed_fund_refund_capacity'::regclass, true)
               ILIKE '%manual_receipt_reversals%'
         AND pg_get_viewdef('public.unclaimed_fund_refund_capacity'::regclass, true)
               ILIKE '%manual_receipt_outflows%' AS has_capacity_view`,
  );
  const shape = rowRecord(result.rows[0]);
  if (
    shape.has_columns !== true ||
    shape.has_constraints !== true ||
    shape.has_triggers !== true ||
    shape.has_capacity_view !== true
  ) {
    throw new SchemaRollbackPreflightError(
      "Schema 016 is incomplete or counterfeit; do not start the 015 rollback bridge. Deploy a compatible application and repair forward without a down migration.",
      SCHEMA_016,
    );
  }
}

async function schema016Blockers(
  database: RollbackPreflightQueryable,
): Promise<readonly SchemaRollbackBlocker[]> {
  const result = await database.query(
    `WITH blocker_counts(code, count) AS (
       SELECT 'manual_receipt_facts', count(*)::bigint FROM manual_receipt_facts
       UNION ALL
       SELECT 'manual_receipt_reversals', count(*)::bigint FROM manual_receipt_reversals
       UNION ALL
       SELECT 'manual_receipt_outflows', count(*)::bigint FROM manual_receipt_outflows
       UNION ALL
       SELECT 'manual_fund_receipts', count(*)::bigint
       FROM fund_receipts
       WHERE reported_manual_receipt_id IS NOT NULL OR disposition = 'reversed'
       UNION ALL
       SELECT 'manual_fund_resolutions', count(*)::bigint
       FROM fund_receipt_resolutions resolution
       JOIN fund_receipts receipt ON receipt.id = resolution.fund_receipt_id
       WHERE receipt.reported_manual_receipt_id IS NOT NULL
       UNION ALL
       SELECT 'manual_fund_allocations', count(*)::bigint
       FROM fund_receipt_allocations allocation
       JOIN fund_receipts receipt ON receipt.id = allocation.fund_receipt_id
       WHERE receipt.reported_manual_receipt_id IS NOT NULL
       UNION ALL
       SELECT 'manual_refunds', count(*)::bigint
       FROM refunds refund
       JOIN fund_receipts receipt ON receipt.id = refund.source_fund_receipt_id
       WHERE receipt.reported_manual_receipt_id IS NOT NULL
       UNION ALL
       SELECT 'manual_ledger_journals', count(*)::bigint
       FROM ledger_journals journal
       WHERE journal.source_type IN (
         'manual_receipt', 'manual_receipt_reversal', 'manual_receipt_outflow'
       )
       UNION ALL
       SELECT 'manual_provider_operations', count(*)::bigint
       FROM provider_operations operation
       WHERE operation.subject_type IN ('manual_receipt', 'manual_receipt_outflow')
       UNION ALL
       SELECT 'manual_durable_jobs', count(*)::bigint
       FROM durable_jobs job
       WHERE job.payload ? 'manualReceiptId'
          OR job.payload ? 'manualReceiptOutflowId'
          OR job.job_type LIKE 'manual_receipt.%'
       UNION ALL
       SELECT 'manual_provider_inbox', count(*)::bigint
       FROM provider_inbox inbox
       WHERE inbox.payload ? 'manualReceiptId'
          OR inbox.payload ? 'manualReceiptOutflowId'
       UNION ALL
       SELECT 'manual_outbox', count(*)::bigint
       FROM outbox event
       WHERE event.payload ? 'manualReceiptId'
          OR event.payload ? 'manualReceiptOutflowId'
          OR event.event_type LIKE 'manual_receipt.%'
     )
     SELECT code, count::text AS count
     FROM blocker_counts
     WHERE count > 0
     ORDER BY code`,
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

  await assertSchema016Shape(database);
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
