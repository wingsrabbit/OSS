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
import { assertSchema020CatalogShape } from "./schema-019-020-native-compatibility.js";
import {
  SchemaRollbackPreflightError,
  type RollbackPreflightQueryable,
} from "./schema-rollback-compatibility.js";

export const SCHEMA_021 = "021_stage_c_support_operations" as const;
export const SCHEMA_021_APPLICATION_GUARD = "opensales:schema-021-application" as const;

// Replaced only after a fresh PostgreSQL 18 catalog review at the frozen DDL.
export const SCHEMA_021_CATALOG_DIGEST =
  "c653e40f6ad1e88951ee41005e4eead2350bb5e09b8348f909486b8db9561da9" as const;

export const EXPECTED_SCHEMA_021_HISTORY = [
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
  "020_stage_c_catalog_commerce",
  SCHEMA_021,
] as const;

export type Schema021NativePreflightReport = Readonly<{
  installedSchemaVersion: typeof SCHEMA_021;
  applicationSchemaVersion: typeof SCHEMA_021;
  mode: "native";
  safe: true;
  blockers: readonly [];
}>;

function rowRecord(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Schema 021 preflight returned an invalid database row");
  }
  return row as Record<string, unknown>;
}

async function installedSchemaVersion(
  database: RollbackPreflightQueryable,
): Promise<string | null> {
  try {
    const result = await database.query(
      "SELECT pg_catalog.max(version) AS version FROM public.schema_migrations",
    );
    const value = result.rows[0] ? rowRecord(result.rows[0]).version : null;
    return typeof value === "string" ? value : null;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    if (code === "42P01") return null;
    throw error;
  }
}

export async function schema021CatalogFingerprintInput(
  database: RollbackPreflightQueryable,
): Promise<string | null> {
  const result = await database.query(
    `WITH target_relations(name) AS (
       VALUES
         ('support_departments'),
         ('support_department_revisions'),
         ('support_department_revision_retirements'),
         ('support_ticket_status_events'),
         ('support_ticket_assignment_events'),
         ('support_ticket_routing_events'),
         ('support_ticket_attachments'),
         ('support_ticket_attachment_scan_facts'),
         ('support_ticket_attachment_deletions'),
         ('presales_inquiries'),
         ('presales_inquiry_status_events'),
         ('presales_inquiry_messages'),
         ('presales_inquiry_access_revocations'),
         ('current_support_ticket_assignments'),
         ('current_support_ticket_routing'),
         ('current_presales_inquiry_status')
     ), catalog_items(item) AS (
       SELECT pg_catalog.concat_ws('|', 'relation', namespace.nspname, relation.relname,
                relation.relkind::text, relation.relpersistence::text,
                relation.relreplident::text, relation.relrowsecurity::text,
                relation.relforcerowsecurity::text,
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
       WHERE actual.table_schema = 'public'
         AND (
           actual.table_name IN (SELECT name FROM target_relations)
           OR (actual.table_name = 'support_tickets' AND actual.column_name IN (
             'department_revision_id', 'priority', 'order_id',
             'authorization_purpose', 'current_status_event_id'
           ))
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
         AND (
           relation.relname IN (SELECT name FROM target_relations)
           OR (relation.relname = 'support_tickets' AND actual.conname IN (
             'support_tickets_priority_check',
             'support_tickets_authorization_purpose_check',
             'support_tickets_authorization_reference_check',
             'support_tickets_order_account_fkey',
             'support_tickets_department_revision_fkey',
             'support_tickets_current_status_event_fkey',
             'support_tickets_current_status_event_id_not_null',
             'support_tickets_department_revision_id_not_null',
             'support_tickets_priority_not_null',
             'support_tickets_current_state_guard'
           ))
           OR (relation.relname = 'support_ticket_messages'
             AND actual.conname IN (
               'support_ticket_messages_id_ticket_key',
               'support_ticket_messages_id_ticket_visibility_key'
             ))
           OR (relation.relname = 'support_departments'
             AND actual.conname = 'support_departments_current_revision_fkey')
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'index', actual.schemaname,
                actual.tablename, actual.indexname,
                pg_catalog.regexp_replace(actual.indexdef, '\\s+', ' ', 'g'))
       FROM pg_catalog.pg_indexes actual
       WHERE actual.schemaname = 'public'
         AND (
           actual.tablename IN (SELECT name FROM target_relations)
           OR (
             actual.tablename = 'support_ticket_messages'
             AND actual.indexname IN (
               'support_ticket_messages_id_ticket_key',
               'support_ticket_messages_id_ticket_visibility_key'
             )
           )
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
       WHERE namespace.nspname = 'public' AND NOT actual.tgisinternal
         AND actual.tgname IN (
           'support_tickets_current_state_guard',
           'support_ticket_status_event_insert_guard',
           'support_ticket_status_event_consumed_guard',
           'presales_inquiries_current_state_guard',
           'presales_status_event_insert_guard',
           'presales_status_event_consumed_guard',
           'support_departments_current_revision_guard',
           'support_department_revisions_current_guard',
           'support_department_retirements_current_guard',
           'support_ticket_assignment_guard',
           'support_ticket_routing_sequence_guard',
           'b_support_tickets_department_guard',
           'support_ticket_routing_department_guard',
           'presales_inquiries_department_guard',
           'support_department_revision_creation_guard',
           'support_department_retirement_guard',
           'support_departments_identity_guard',
           'support_department_revisions_immutable',
           'support_department_revision_retirements_immutable',
           'a_support_tickets_identity_guard',
           'support_ticket_messages_author_guard',
           'support_ticket_messages_immutable',
           'presales_inquiries_identity_guard',
           'presales_inquiry_messages_author_guard',
           'presales_inquiry_access_revocations_guard',
           'support_ticket_attachments_guard',
           'support_ticket_attachment_deletions_guard',
           'support_ticket_attachment_scan_facts_guard',
           'support_ticket_status_events_immutable',
           'support_ticket_assignment_events_immutable',
           'support_ticket_routing_events_immutable',
           'support_ticket_attachments_immutable',
           'support_ticket_attachment_deletions_immutable',
           'support_ticket_attachment_scan_facts_immutable',
           'presales_inquiry_status_events_immutable',
           'presales_inquiry_messages_immutable',
           'presales_inquiry_access_revocations_immutable'
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'function', actual.proname,
                pg_catalog.pg_get_function_identity_arguments(actual.oid),
                pg_catalog.pg_get_function_result(actual.oid), language.lanname,
                actual.provolatile::text, actual.prosecdef::text,
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_functiondef(actual.oid), '\\s+', ' ', 'g'
                ))
       FROM pg_catalog.pg_proc actual
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = actual.pronamespace
       JOIN pg_catalog.pg_language language ON language.oid = actual.prolang
       WHERE namespace.nspname = 'public'
         AND actual.proname IN (
           'opensales_reject_support_fact_mutation',
           'opensales_validate_support_ticket_state',
           'opensales_validate_support_ticket_status_event_insert',
           'opensales_validate_support_ticket_status_event_consumed',
           'opensales_validate_presales_state',
           'opensales_validate_presales_status_event_insert',
           'opensales_validate_presales_status_event_consumed',
           'opensales_guard_support_ticket_identity',
           'opensales_guard_presales_identity',
           'opensales_validate_support_assignment',
           'opensales_assign_support_routing_sequence',
           'opensales_validate_support_department_revision',
           'opensales_validate_support_department_revision_creation',
           'opensales_validate_support_department_retirement',
           'opensales_validate_support_department_current_revision',
           'opensales_guard_support_department_identity',
           'opensales_validate_support_message_author',
           'opensales_validate_presales_message_author',
           'opensales_validate_presales_access_revocation',
           'opensales_validate_support_attachment',
           'opensales_validate_support_attachment_deletion',
           'opensales_validate_support_attachment_scan_fact'
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'view', target.name,
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_viewdef(
                    pg_catalog.format('public.%I', target.name)::pg_catalog.regclass,
                    true
                  ), '\\s+', ' ', 'g'
                ))
       FROM target_relations target
       WHERE target.name LIKE 'current_%'
     ), fingerprint(value) AS (
       SELECT pg_catalog.string_agg(item, E'\\n' ORDER BY item COLLATE "C")
       FROM catalog_items
     )
     SELECT value FROM fingerprint`,
  );
  const value = result.rows[0] ? rowRecord(result.rows[0]).value : null;
  return typeof value === "string" ? value : null;
}

export function schema021CatalogDigest(fingerprintInput: string | null): string | null {
  return fingerprintInput
    ? createHash("sha256").update(fingerprintInput, "utf8").digest("hex")
    : null;
}

export function assertSchema021CatalogDigest(digest: string | null): void {
  if (digest !== SCHEMA_021_CATALOG_DIGEST) {
    throw new SchemaRollbackPreflightError(
      `Schema 021 is incomplete or counterfeit: catalog digest ${String(digest)} does not match reviewed digest ${SCHEMA_021_CATALOG_DIGEST}; do not start a schema-021 application.`,
      SCHEMA_021,
    );
  }
}

export async function assertSchema021CatalogShape(
  database: RollbackPreflightQueryable,
): Promise<void> {
  assertSchema021CatalogDigest(
    schema021CatalogDigest(await schema021CatalogFingerprintInput(database)),
  );
}

export async function assertSchema021NativeSafe(
  database: RollbackPreflightQueryable,
): Promise<Schema021NativePreflightReport> {
  const installed = await installedSchemaVersion(database);
  if (installed !== SCHEMA_021) {
    throw new SchemaRollbackPreflightError(
      installed === null
        ? `Database schema is missing; application schema ${SCHEMA_021} requires a forward migration.`
        : `Database schema ${installed} is incompatible with application schema ${SCHEMA_021}; run the dedicated forward migration and never run a down migration.`,
      installed,
    );
  }
  const history = await database.query(
    `SELECT pg_catalog.array_agg(version ORDER BY version COLLATE "C") = $1::text[]
       AS history_exact
     FROM public.schema_migrations`,
    [[...EXPECTED_SCHEMA_021_HISTORY]],
  );
  if (rowRecord(history.rows[0]).history_exact !== true) {
    throw new SchemaRollbackPreflightError(
      "Schema 021 migration history is incomplete or contains an unreviewed migration; repair forward without deleting migration history.",
      SCHEMA_021,
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
      SCHEMA_021,
    );
  }
  await assertSchema018CatalogShape(database, {
    allowSchema021SupportExtensions: true,
  });
  const schema019Shape = await schema019CatalogFingerprintInput(database);
  assertSchema019CatalogDigest(schema019CatalogDigest(schema019Shape.fingerprintInput));
  await assertSchema020CatalogShape(database);
  await assertSchema021CatalogShape(database);
  return {
    installedSchemaVersion: SCHEMA_021,
    applicationSchemaVersion: SCHEMA_021,
    mode: "native",
    safe: true,
    blockers: [],
  };
}
