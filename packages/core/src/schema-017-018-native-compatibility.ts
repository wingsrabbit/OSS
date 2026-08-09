// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  SchemaRollbackPreflightError,
  type RollbackPreflightQueryable,
} from "./schema-rollback-compatibility.js";
import { SCHEMA_017 } from "./schema-016-017-rollback-compatibility.js";

export const SCHEMA_018 = "018_stage_c_support_tickets" as const;

const EXPECTED_SCHEMA_018_HISTORY = [
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
  SCHEMA_018,
] as const;

export type Schema018NativePreflightReport = Readonly<{
  installedSchemaVersion: typeof SCHEMA_018;
  applicationSchemaVersion: typeof SCHEMA_018;
  mode: "native";
  safe: true;
  blockers: readonly [];
}>;

function rowRecord(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Schema 018 preflight returned an invalid database row");
  }
  return row as Record<string, unknown>;
}

export async function assertSchema018NativeSafe(
  database: RollbackPreflightQueryable,
): Promise<Schema018NativePreflightReport> {
  const result = await database.query(
    `SELECT
       (SELECT pg_catalog.max(version) FROM public.schema_migrations)
         AS installed_schema_version,
       (SELECT pg_catalog.array_agg(version ORDER BY version COLLATE "C")
          FROM public.schema_migrations) = $1::text[] AS history_exact,
       pg_catalog.to_regclass('public.support_tickets')::text AS tickets_table,
       pg_catalog.to_regclass('public.support_ticket_messages')::text AS messages_table,
       pg_catalog.to_regclass('public.support_tickets_client_updated_idx')::text
         AS client_index,
       pg_catalog.to_regclass('public.support_ticket_messages_ticket_created_idx')::text
         AS message_index`,
    [[...EXPECTED_SCHEMA_018_HISTORY]],
  );
  const row = rowRecord(result.rows[0]);
  const installed =
    typeof row.installed_schema_version === "string"
      ? row.installed_schema_version
      : null;
  if (installed !== SCHEMA_018) {
    throw new SchemaRollbackPreflightError(
      installed === null
        ? `Database schema is missing; application schema ${SCHEMA_018} requires a forward migration.`
        : `Database schema ${installed} is incompatible with application schema ${SCHEMA_018}; run the dedicated forward migration.`,
      installed,
    );
  }
  if (
    row.history_exact !== true ||
    row.tickets_table !== "support_tickets" ||
    row.messages_table !== "support_ticket_messages" ||
    row.client_index !== "support_tickets_client_updated_idx" ||
    row.message_index !== "support_ticket_messages_ticket_created_idx"
  ) {
    throw new SchemaRollbackPreflightError(
      `Schema ${SCHEMA_018} is incomplete or contains unreviewed migration history.`,
      installed,
    );
  }
  return {
    installedSchemaVersion: SCHEMA_018,
    applicationSchemaVersion: SCHEMA_018,
    mode: "native",
    safe: true,
    blockers: [],
  };
}
