// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import {
  SCHEMA_017_CATALOG_DIGEST,
  schema017CatalogFingerprintInput,
} from "./schema-016-017-rollback-compatibility.js";
import { assertSchema018CatalogShape } from "./schema-017-018-native-compatibility.js";
import {
  EXPECTED_SCHEMA_019_HISTORY,
  assertSchema019CatalogDigest,
  schema019CatalogDigest,
  schema019CatalogFingerprintInput,
} from "./schema-018-019-native-compatibility.js";
import {
  SchemaRollbackPreflightError,
  type RollbackPreflightQueryable,
} from "./schema-rollback-compatibility.js";

export const SCHEMA_020 = "020_stage_c_catalog_commerce" as const;
export const SCHEMA_020_APPLICATION_GUARD = "opensales:schema-020-application" as const;

export const SCHEMA_020_CATALOG_DIGEST =
  "8334a80bee85bd2ffd31859319bdab334f62447f767c1e2cfc94fc051c2e2171" as const;

export const EXPECTED_SCHEMA_020_HISTORY = [
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
  "017_stage_b_manual_receipt_outflow_reports",
  "018_stage_c_support_tickets",
  "019_stage_c_account_context_memberships_contacts",
  SCHEMA_020,
] as const;

export type Schema020NativePreflightReport = Readonly<{
  installedSchemaVersion: typeof SCHEMA_020;
  applicationSchemaVersion: typeof SCHEMA_020;
  mode: "native";
  safe: true;
  blockers: readonly [];
}>;

function rowRecord(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Schema 020 preflight returned an invalid database row");
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

export async function schema020CatalogFingerprintInput(
  database: RollbackPreflightQueryable,
): Promise<string | null> {
  const result = await database.query(
    `WITH catalog_items(item) AS (
       SELECT pg_catalog.concat_ws('|', 'relation', namespace.nspname, relation.relname,
                relation.relkind::text, relation.relpersistence::text,
                relation.relreplident::text, relation.relrowsecurity::text,
                relation.relforcerowsecurity::text,
                COALESCE(pg_catalog.obj_description(relation.oid, 'pg_class'), ''))
       FROM pg_catalog.pg_namespace namespace
       JOIN pg_catalog.pg_class relation ON relation.relnamespace = namespace.oid
       WHERE namespace.nspname = 'public'
         AND relation.relname IN (
           'catalog_product_revisions',
           'promotions',
           'product_supply_capacities',
           'sales_quotes',
           'sales_quote_voids',
           'order_legal_acceptances',
           'sales_quote_acceptances',
           'promotion_redemptions',
           'supply_capacity_reservations',
           'marketing_consent_events',
           'current_marketing_consents'
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
           'catalog_product_revisions',
           'product_prices',
           'promotions',
           'product_supply_capacities',
           'sales_quotes',
           'sales_quote_voids',
           'orders',
           'order_legal_acceptances',
           'sales_quote_acceptances',
           'promotion_redemptions',
           'supply_capacity_reservations',
           'marketing_consent_events'
         )
         AND (
           actual.table_name NOT IN ('product_prices', 'orders')
           OR actual.column_name IN (
             'catalog_product_revision_id',
             'source_quote_id'
           )
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'constraint', relation.relname, actual.conname,
                actual.contype::text, actual.convalidated::text,
                actual.condeferrable::text, actual.condeferred::text,
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_constraintdef(actual.oid, true), '\\s+', ' ', 'g'
                ))
       FROM pg_catalog.pg_constraint actual
       JOIN pg_catalog.pg_class relation ON relation.oid = actual.conrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname IN (
           'catalog_product_revisions',
           'product_prices',
           'promotions',
           'product_supply_capacities',
           'sales_quotes',
           'sales_quote_voids',
           'orders',
           'order_legal_acceptances',
           'sales_quote_acceptances',
           'promotion_redemptions',
           'supply_capacity_reservations',
           'marketing_consent_events'
         )
         AND (
           relation.relname NOT IN ('product_prices', 'orders')
           OR actual.conname IN (
             'product_prices_catalog_revision_fkey',
             'product_prices_id_product_key',
             'orders_source_quote_fkey',
             'orders_source_quote_key'
           )
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'index', actual.schemaname,
                actual.tablename, actual.indexname,
                pg_catalog.regexp_replace(actual.indexdef, '\\s+', ' ', 'g'))
       FROM pg_catalog.pg_indexes actual
       WHERE actual.schemaname = 'public'
         AND actual.tablename IN (
           'catalog_product_revisions',
           'promotions',
           'product_supply_capacities',
           'sales_quotes',
           'sales_quote_voids',
           'order_legal_acceptances',
           'sales_quote_acceptances',
           'promotion_redemptions',
           'supply_capacity_reservations',
           'marketing_consent_events'
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'trigger', relation.relname, actual.tgname,
                actual.tgenabled::text,
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_triggerdef(actual.oid, true), '\\s+', ' ', 'g'
                ))
       FROM pg_catalog.pg_trigger actual
       JOIN pg_catalog.pg_class relation ON relation.oid = actual.tgrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND NOT actual.tgisinternal
         AND actual.tgname IN (
           'catalog_product_revisions_immutable',
           'sales_quotes_immutable',
           'sales_quote_voids_immutable',
           'sales_quote_acceptances_immutable',
           'order_legal_acceptances_immutable',
           'promotion_redemptions_immutable',
           'supply_capacity_reservations_immutable',
           'marketing_consent_events_immutable',
           'marketing_consent_events_membership_guard',
           'product_prices_revision_guard',
           'promotions_revision_guard',
           'sales_quote_voids_terminal_guard',
           'sales_quote_acceptances_terminal_guard',
           'orders_source_quote_immutable'
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'function', actual.proname,
                pg_catalog.pg_get_function_identity_arguments(actual.oid),
                pg_catalog.pg_get_function_result(actual.oid),
                language.lanname,
                actual.provolatile::text, actual.prosecdef::text,
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_functiondef(actual.oid), '\\s+', ' ', 'g'
                ))
       FROM pg_catalog.pg_proc actual
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = actual.pronamespace
       JOIN pg_catalog.pg_language language ON language.oid = actual.prolang
       WHERE namespace.nspname = 'public'
         AND actual.proname IN (
           'opensales_reject_catalog_commercial_fact_mutation',
           'opensales_guard_product_price_revision',
           'opensales_guard_promotion_revision',
           'opensales_validate_quote_terminal_fact',
           'opensales_guard_order_source_quote',
           'opensales_validate_marketing_consent_event'
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'view', 'current_marketing_consents',
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_viewdef('public.current_marketing_consents'::pg_catalog.regclass, true),
                  '\\s+', ' ', 'g'
                ))
     ), fingerprint(value) AS (
       SELECT pg_catalog.string_agg(item, E'\\n' ORDER BY item COLLATE "C")
       FROM catalog_items
     )
     SELECT value FROM fingerprint`,
  );
  const value = result.rows[0] ? rowRecord(result.rows[0]).value : null;
  return typeof value === "string" ? value : null;
}

export function schema020CatalogDigest(fingerprintInput: string | null): string | null {
  return fingerprintInput
    ? createHash("sha256").update(fingerprintInput, "utf8").digest("hex")
    : null;
}

export function assertSchema020CatalogDigest(digest: string | null): void {
  if (digest !== SCHEMA_020_CATALOG_DIGEST) {
    throw new SchemaRollbackPreflightError(
      `Schema 020 is incomplete or counterfeit: catalog digest ${String(digest)} does not match reviewed digest ${SCHEMA_020_CATALOG_DIGEST}; do not start a schema-020 application.`,
      SCHEMA_020,
    );
  }
}

export async function assertSchema020CatalogShape(
  database: RollbackPreflightQueryable,
): Promise<void> {
  const fingerprintInput = await schema020CatalogFingerprintInput(database);
  assertSchema020CatalogDigest(schema020CatalogDigest(fingerprintInput));
}

export async function assertSchema020NativeSafe(
  database: RollbackPreflightQueryable,
): Promise<Schema020NativePreflightReport> {
  const installed = await installedSchemaVersion(database);
  if (installed !== SCHEMA_020) {
    throw new SchemaRollbackPreflightError(
      installed === null
        ? `Database schema is missing; application schema ${SCHEMA_020} requires a forward migration.`
        : `Database schema ${installed} is incompatible with application schema ${SCHEMA_020}; run the dedicated forward migration and never run a down migration.`,
      installed,
    );
  }
  const history = await database.query(
    `SELECT pg_catalog.array_agg(version ORDER BY version COLLATE "C") = $1::text[]
       AS history_exact
     FROM public.schema_migrations`,
    [[...EXPECTED_SCHEMA_020_HISTORY]],
  );
  if (rowRecord(history.rows[0]).history_exact !== true) {
    throw new SchemaRollbackPreflightError(
      "Schema 020 migration history is incomplete or contains an unreviewed migration; repair forward without deleting migration history.",
      SCHEMA_020,
    );
  }
  const schema017Shape = await schema017CatalogFingerprintInput(database, {
    expectedMigrationHistory: EXPECTED_SCHEMA_019_HISTORY,
    allowSchema019RecordedOwnerInvariant: true,
  });
  const schema017Digest = schema017Shape.fingerprintInput
    ? createHash("sha256").update(schema017Shape.fingerprintInput, "utf8").digest("hex")
    : null;
  if (schema017Digest !== SCHEMA_017_CATALOG_DIGEST) {
    throw new SchemaRollbackPreflightError(
      `Schema 017 foundation is incomplete or counterfeit: catalog digest ${String(schema017Digest)} does not match reviewed digest ${SCHEMA_017_CATALOG_DIGEST}.`,
      SCHEMA_020,
    );
  }
  await assertSchema018CatalogShape(database);
  const schema019Shape = await schema019CatalogFingerprintInput(database);
  assertSchema019CatalogDigest(
    schema019CatalogDigest(schema019Shape.fingerprintInput),
  );
  await assertSchema020CatalogShape(database);
  return {
    installedSchemaVersion: SCHEMA_020,
    applicationSchemaVersion: SCHEMA_020,
    mode: "native",
    safe: true,
    blockers: [],
  };
}
