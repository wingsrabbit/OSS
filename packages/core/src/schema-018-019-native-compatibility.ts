// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import {
  assertSchema017CatalogShape,
  SCHEMA_017,
} from "./schema-016-017-rollback-compatibility.js";
import {
  assertSchema018CatalogShape,
  SCHEMA_018,
} from "./schema-017-018-native-compatibility.js";
import {
  SchemaRollbackPreflightError,
  type RollbackPreflightQueryable,
} from "./schema-rollback-compatibility.js";

export const SCHEMA_019 = "019_stage_c_account_context_memberships_contacts" as const;
export const SCHEMA_019_APPLICATION_GUARD =
  "opensales:schema-019-application" as const;

export const SCHEMA_019_CATALOG_DIGEST =
  "305ca08b13460b1691f695348c8615741877ac25232964acd3eaa8239a8b9df7" as const;

export const EXPECTED_SCHEMA_019_HISTORY = [
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
  SCHEMA_019,
] as const;

export type Schema019NativePreflightReport = Readonly<{
  installedSchemaVersion: typeof SCHEMA_019;
  applicationSchemaVersion: typeof SCHEMA_019;
  mode: "native";
  safe: true;
  blockers: readonly [];
}>;

function rowRecord(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Schema 019 preflight returned an invalid database row");
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

export async function schema019CatalogFingerprintInput(
  database: RollbackPreflightQueryable,
  input: Readonly<{ allowSchema027NotificationTemplateExtensions?: boolean }> = {},
): Promise<Readonly<{ historyExact: boolean; fingerprintInput: string | null }>> {
  const allowSchema027NotificationTemplateExtensions =
    input.allowSchema027NotificationTemplateExtensions === true;
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
           'client_membership_invitations',
           'client_contacts',
           'client_account_owner_transfer_facts',
           'renewal_reminder_delivery_facts',
           'renewal_notification_dispatch_suppressions',
           'notification_delivery_operations',
           'notification_delivery_facts'
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
         AND (
           actual.table_name IN (
             'client_membership_invitations',
             'client_contacts',
             'client_account_owner_transfer_facts',
             'renewal_reminder_delivery_facts',
             'renewal_notification_dispatch_suppressions',
             'notification_delivery_operations',
             'notification_delivery_facts'
           )
           OR (actual.table_name = 'sessions'
               AND actual.column_name IN ('active_client_account_id', 'account_context_version'))
           OR (actual.table_name = 'client_memberships'
               AND actual.column_name IN ('restricted_at', 'updated_at'))
           OR (actual.table_name = 'order_items'
               AND actual.column_name = 'client_account_id')
           OR (actual.table_name = 'service_renewals'
               AND actual.column_name IN (
                 'client_account_id', 'schema_019_legacy_relationship'
               ))
           OR (actual.table_name = 'service_periods'
               AND actual.column_name IN (
                 'client_account_id', 'schema_019_legacy_relationship'
               ))
           OR (actual.table_name = 'payment_allocations'
               AND actual.column_name IN (
                 'client_account_id', 'schema_019_legacy_relationship'
               ))
         )
         AND NOT (
           $2::boolean
           AND actual.table_name = 'notification_delivery_operations'
           AND actual.column_name IN ('template_revision_id', 'template_locale')
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'index', actual.schemaname,
                actual.tablename, actual.indexname,
                pg_catalog.regexp_replace(actual.indexdef, '\\s+', ' ', 'g'))
       FROM pg_catalog.pg_indexes actual
       WHERE actual.schemaname = 'public'
         AND (
           actual.tablename IN (
             'client_membership_invitations',
             'client_contacts',
             'client_account_owner_transfer_facts',
             'renewal_reminder_delivery_facts',
             'renewal_notification_dispatch_suppressions',
             'notification_delivery_operations',
             'notification_delivery_facts'
           )
           OR actual.indexname IN (
             'sessions_user_active_context_idx',
             'orders_id_client_account_key',
             'orders_id_client_account_currency_key',
             'order_items_id_client_account_key',
             'invoices_id_client_account_key',
             'invoices_id_client_account_currency_key',
             'payment_attempts_id_account_invoice_key'
           )
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
           relation.relname IN (
             'client_membership_invitations',
             'client_contacts',
             'client_account_owner_transfer_facts',
             'renewal_reminder_delivery_facts',
             'renewal_notification_dispatch_suppressions',
             'notification_delivery_operations',
             'notification_delivery_facts'
           )
           OR actual.conname IN (
             'client_accounts_owner_invariant',
             'sessions_account_context_version_check',
             'sessions_active_client_account_fkey',
             'client_memberships_permissions_array_check',
             'orders_id_client_account_key',
             'orders_id_client_account_currency_key',
             'order_items_id_client_account_key',
             'order_items_order_account_fkey',
             'invoices_id_client_account_key',
             'invoices_id_client_account_currency_key',
             'invoices_order_account_currency_fkey',
             'payment_attempts_id_account_invoice_key',
             'payment_attempts_invoice_account_currency_fkey',
             'payment_allocations_attempt_invoice_account_fkey',
             'payment_allocations_invoice_account_fkey',
             'payment_allocations_schema_019_account_check',
             'services_order_item_account_fkey',
             'service_renewals_service_account_fkey',
             'service_renewals_invoice_account_currency_fkey',
             'service_renewals_schema_019_account_check',
             'service_periods_service_account_fkey',
             'service_periods_invoice_account_fkey',
             'service_periods_schema_019_account_check'
           )
         )
         AND NOT (
           $2::boolean
           AND relation.relname = 'notification_delivery_operations'
           AND actual.conname IN (
             'notification_delivery_operations_template_locale_check',
             'notification_delivery_operations_template_revision_fkey',
             'notification_delivery_operations_template_locale_not_null',
             'notification_delivery_operations_template_revision_id_not_null'
           )
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'index', relation.relname,
                index_relation.relname,
                actual.indisunique::text, actual.indisprimary::text,
                actual.indisexclusion::text, actual.indimmediate::text,
                actual.indisvalid::text, actual.indisready::text,
                actual.indislive::text, actual.indisreplident::text,
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_indexdef(index_relation.oid), '\\s+', ' ', 'g'
                ))
       FROM pg_catalog.pg_namespace namespace
       JOIN pg_catalog.pg_class relation ON relation.relnamespace = namespace.oid
       JOIN pg_catalog.pg_index actual ON actual.indrelid = relation.oid
       JOIN pg_catalog.pg_class index_relation
         ON index_relation.oid = actual.indexrelid
       WHERE namespace.nspname = 'public'
         AND index_relation.relname IN (
           'client_membership_invitations_active_email_idx',
           'client_contacts_active_email_idx',
           'notification_delivery_operations_verification_token_key'
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
         AND actual.tgname IN (
           'sessions_validate_account_context',
           'sessions_identity_immutable',
           'users_bump_identity_context_version',
           'client_memberships_identity_immutable',
           'client_memberships_invalidate_reauth',
           'client_accounts_invalidate_reauth',
           'client_accounts_prelock_reauth',
           'client_memberships_owner_invariant',
           'client_accounts_owner_invariant',
           'client_accounts_record_owner_transfer',
           'client_account_owner_transfer_facts_immutable',
           'notification_delivery_operations_guard',
           'notification_delivery_operations_recipient_guard',
           'notification_delivery_operations_terminal_fact_guard',
           'notification_delivery_operations_support_message_guard',
           'notification_outbox_immutable',
           'renewal_reminder_delivery_facts_immutable',
           'renewal_notification_dispatch_suppressions_immutable',
           'renewal_reminder_delivery_facts_projection_guard',
           'notification_delivery_facts_renewal_projection_guard',
           'order_items_fill_client_account',
           'service_renewals_fill_client_account',
           'service_periods_fill_client_account',
           'payment_allocations_fill_client_account',
           'services_account_relationship_guard',
           'service_renewals_account_relationship_guard',
           'service_periods_account_relationship_guard',
           'payment_allocations_account_relationship_guard',
           'orders_snapshot_immutable',
           'order_items_snapshot_immutable',
           'services_identity_immutable',
           'payment_attempts_identity_immutable',
           'invoices_header_immutable',
           'client_membership_invitations_identity_immutable',
           'client_contacts_identity_immutable',
           'notification_delivery_facts_status_guard',
           'notification_delivery_facts_immutable'
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'function', namespace.nspname, actual.proname,
                language.lanname, actual.provolatile::text,
                actual.prosecdef::text, actual.proleakproof::text,
                COALESCE(pg_catalog.array_to_string(actual.proconfig, ','), ''),
                pg_catalog.pg_get_function_identity_arguments(actual.oid),
                pg_catalog.pg_get_function_result(actual.oid),
                pg_catalog.regexp_replace(
                  pg_catalog.btrim(
                    CASE WHEN $2::boolean AND actual.proname =
                      'opensales_validate_notification_delivery_operation'
                    THEN pg_catalog.replace(
                      pg_catalog.replace(
                        pg_catalog.replace(
                          pg_catalog.replace(
                            actual.prosrc,
$schema027$       AND NEW.payload_snapshot ->> 'amountDueMinor' ~ '^\\d+$' THEN$schema027$,
$schema019$       AND NEW.payload_snapshot ->> 'amountDueMinor' ~ '^\\d+$'
       AND NEW.template_revision =
         'renewal-' || pg_catalog.replace(
           NEW.payload_snapshot ->> 'kind', '_', '-'
         ) || '-v1' THEN$schema019$
                          ),
$schema027$       AND NEW.payload_snapshot ->> 'executionMode' IN ('automatic', 'manual') THEN$schema027$,
$schema019$       AND NEW.payload_snapshot ->> 'executionMode' IN ('automatic', 'manual')
       AND NEW.template_revision = 'service-cancellation-scheduled-v1' THEN$schema019$
                        ),
$schema027$       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'ticketMessage') = 'string' THEN$schema027$,
$schema019$       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'ticketMessage') = 'string'
       AND NEW.template_revision = 'support-ticket-reply-v1' THEN$schema019$
                      ),
$schema027$  IF (
    COALESCE(recipient_is_valid, false)
    AND NEW.status <> 'queued'
    AND NOT (
      NEW.status = 'skipped'
      AND NEW.last_error = 'USER_NOTIFICATION_PREFERENCE_DISABLED'
      AND NEW.recipient_user_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.notification_template_events template_event
        JOIN public.user_notification_preferences preference
          ON preference.user_id = NEW.recipient_user_id
         AND preference.category = template_event.preference_category
         AND preference.channel = 'email'
        WHERE template_event.event_type = NEW.event_type
          AND NOT template_event.required_delivery
          AND NOT preference.enabled
      )
    )
  )
  OR (NOT COALESCE(recipient_is_valid, false) AND NEW.status <> 'skipped') THEN$schema027$,
$schema019$  IF (COALESCE(recipient_is_valid, false) AND NEW.status <> 'queued')
     OR (NOT COALESCE(recipient_is_valid, false) AND NEW.status <> 'skipped') THEN$schema019$
                    ) ELSE actual.prosrc END
                  ),
                  '\\s+', ' ', 'g'
                ))
       FROM pg_catalog.pg_namespace namespace
       JOIN pg_catalog.pg_proc actual ON actual.pronamespace = namespace.oid
       JOIN pg_catalog.pg_language language ON language.oid = actual.prolang
       WHERE namespace.nspname = 'public'
         AND actual.proname IN (
           'opensales_validate_session_account_context',
           'opensales_guard_session_identity',
           'opensales_bump_user_identity_context_version',
           'opensales_guard_membership_identity',
           'opensales_invalidate_membership_reauth',
           'opensales_invalidate_client_account_reauth',
           'opensales_prelock_client_account_reauth',
           'opensales_assert_client_account_owner_membership',
           'opensales_record_client_account_owner_transfer',
           'opensales_reject_client_account_owner_transfer_fact_mutation',
           'opensales_guard_notification_delivery_operation',
           'opensales_validate_notification_delivery_operation',
           'opensales_notification_utf16_sort_key',
           'opensales_canonical_notification_jsonb',
           'opensales_notification_request_fingerprint',
           'opensales_notification_provider_operation_id',
           'opensales_notification_rendered_request_fingerprint',
           'opensales_validate_terminal_notification_delivery_fact',
           'opensales_reject_renewal_notification_dispatch_suppression_mutation',
           'opensales_validate_support_notification_message',
           'opensales_validate_renewal_notification_delivery_projection',
           'opensales_guard_notification_outbox',
           'opensales_reject_service_period_mutation',
           'opensales_fill_account_relationship',
           'opensales_validate_account_relationship',
           'opensales_guard_order_snapshot',
           'opensales_guard_order_item_snapshot',
           'opensales_guard_service_identity',
           'opensales_guard_payment_attempt_identity',
           'opensales_guard_invoice_header_mutation',
           'opensales_guard_membership_invitation_identity',
           'opensales_guard_client_contact_identity',
           'opensales_validate_notification_delivery_fact',
           'opensales_reject_notification_delivery_fact_mutation'
         )
     ), fingerprint(value) AS (
       SELECT pg_catalog.string_agg(item, E'\\n' ORDER BY item COLLATE "C")
       FROM catalog_items
     )
     SELECT
       (SELECT pg_catalog.array_agg(version ORDER BY version COLLATE "C")
        FROM public.schema_migrations) = $1::text[] AS history_exact,
       (SELECT value FROM fingerprint) AS fingerprint_input`,
    [[...EXPECTED_SCHEMA_019_HISTORY], allowSchema027NotificationTemplateExtensions],
  );
  const row = rowRecord(result.rows[0]);
  return {
    historyExact: row.history_exact === true,
    fingerprintInput:
      typeof row.fingerprint_input === "string" ? row.fingerprint_input : null,
  };
}

export function schema019CatalogDigest(fingerprintInput: string | null): string | null {
  return fingerprintInput
    ? createHash("sha256").update(fingerprintInput, "utf8").digest("hex")
    : null;
}

export function assertSchema019CatalogDigest(digest: string | null): void {
  if (digest !== SCHEMA_019_CATALOG_DIGEST) {
    throw new SchemaRollbackPreflightError(
      `Schema 019 is incomplete or counterfeit: catalog digest ${String(digest)} does not match reviewed digest ${SCHEMA_019_CATALOG_DIGEST}; do not start a schema-019 application.`,
      SCHEMA_019,
    );
  }
}

export async function assertSchema019CatalogShape(
  database: RollbackPreflightQueryable,
): Promise<void> {
  const shape = await schema019CatalogFingerprintInput(database);
  if (!shape.historyExact) {
    throw new SchemaRollbackPreflightError(
      "Schema 019 migration history is incomplete or contains an unreviewed migration; repair forward without deleting migration history.",
      SCHEMA_019,
    );
  }
  assertSchema019CatalogDigest(schema019CatalogDigest(shape.fingerprintInput));
}

export async function assertSchema019NativeSafe(
  database: RollbackPreflightQueryable,
): Promise<Schema019NativePreflightReport> {
  const installed = await installedSchemaVersion(database);
  if (installed !== SCHEMA_019) {
    throw new SchemaRollbackPreflightError(
      installed === null
        ? `Database schema is missing; application schema ${SCHEMA_019} requires a forward migration.`
        : `Database schema ${installed} is incompatible with application schema ${SCHEMA_019}; run the dedicated forward migration and never run a down migration.`,
      installed,
    );
  }
  await assertSchema017CatalogShape(database, {
    expectedMigrationHistory: EXPECTED_SCHEMA_019_HISTORY,
    allowSchema019RecordedOwnerInvariant: true,
  });
  await assertSchema018CatalogShape(database);
  await assertSchema019CatalogShape(database);
  return {
    installedSchemaVersion: SCHEMA_019,
    applicationSchemaVersion: SCHEMA_019,
    mode: "native",
    safe: true,
    blockers: [],
  };
}
