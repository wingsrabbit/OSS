// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import {
  assertSchema017CatalogShape,
  SCHEMA_017,
} from "./schema-016-017-rollback-compatibility.js";
import {
  SchemaRollbackPreflightError,
  type RollbackPreflightQueryable,
} from "./schema-rollback-compatibility.js";

export const SCHEMA_018 = "018_stage_c_support_tickets" as const;

export const SCHEMA_018_CATALOG_DIGEST =
  "63b02b32a49aab881882bdf4cc2e44d5595b12cbb0c3a7eecd851edd75d18429" as const;

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

export async function schema018CatalogFingerprintInput(
  database: RollbackPreflightQueryable,
): Promise<string | null> {
  const result = await database.query(
    `WITH catalog_items(item) AS (
       SELECT pg_catalog.concat_ws('|', 'relation', namespace.nspname, relation.relname,
                relation.relkind::text, relation.relpersistence::text,
                relation.relreplident::text, relation.relrowsecurity::text,
                relation.relforcerowsecurity::text)
       FROM pg_catalog.pg_namespace namespace
       JOIN pg_catalog.pg_class relation ON relation.relnamespace = namespace.oid
       WHERE namespace.nspname = 'public'
         AND relation.relname IN ('support_tickets', 'support_ticket_messages')
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
         AND actual.table_name IN ('support_tickets', 'support_ticket_messages')
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'index', actual.schemaname,
                actual.tablename, actual.indexname,
                pg_catalog.regexp_replace(actual.indexdef, '\\s+', ' ', 'g'))
       FROM pg_catalog.pg_indexes actual
       WHERE actual.schemaname = 'public'
         AND (
           actual.tablename IN ('support_tickets', 'support_ticket_messages')
           OR actual.indexname = 'services_id_client_account_key'
         )
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
           relation.relname IN ('support_tickets', 'support_ticket_messages')
           OR (
             relation.relname = 'services'
             AND actual.conname = 'services_id_client_account_key'
           )
         )
     ), fingerprint(value) AS (
       SELECT pg_catalog.string_agg(item, E'\\n' ORDER BY item COLLATE "C")
       FROM catalog_items
     )
     SELECT value AS fingerprint_input FROM fingerprint`,
  );
  const value = result.rows[0] ? rowRecord(result.rows[0]).fingerprint_input : null;
  return typeof value === "string" ? value : null;
}

export function schema018CatalogDigest(fingerprintInput: string | null): string | null {
  return fingerprintInput
    ? createHash("sha256").update(fingerprintInput, "utf8").digest("hex")
    : null;
}

export function assertSchema018CatalogDigest(digest: string | null): void {
  if (digest !== SCHEMA_018_CATALOG_DIGEST) {
    throw new SchemaRollbackPreflightError(
      `Schema 018 is incomplete or counterfeit: catalog digest ${String(digest)} does not match reviewed digest ${SCHEMA_018_CATALOG_DIGEST}; do not start a schema-018 application.`,
      SCHEMA_018,
    );
  }
}

export async function assertSchema018CatalogShape(
  database: RollbackPreflightQueryable,
): Promise<void> {
  const fingerprintInput = await schema018CatalogFingerprintInput(database);
  assertSchema018CatalogDigest(schema018CatalogDigest(fingerprintInput));
}

export async function assertSchema018NativeSafe(
  database: RollbackPreflightQueryable,
): Promise<Schema018NativePreflightReport> {
  const installed = await installedSchemaVersion(database);
  if (installed !== SCHEMA_018) {
    throw new SchemaRollbackPreflightError(
      installed === null
        ? `Database schema is missing; application schema ${SCHEMA_018} requires a forward migration.`
        : `Database schema ${installed} is incompatible with application schema ${SCHEMA_018}; run the dedicated forward migration.`,
      installed,
    );
  }
  await assertSchema017CatalogShape(database, {
    expectedMigrationHistory: EXPECTED_SCHEMA_018_HISTORY,
  });
  await assertSchema018CatalogShape(database);
  return {
    installedSchemaVersion: SCHEMA_018,
    applicationSchemaVersion: SCHEMA_018,
    mode: "native",
    safe: true,
    blockers: [],
  };
}
