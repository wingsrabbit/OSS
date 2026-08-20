// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import {
  EXPECTED_SCHEMA_023_HISTORY,
  assertSchema023NativeSafe,
} from "./schema-022-023-native-compatibility.js";
import {
  SchemaRollbackPreflightError,
  type RollbackPreflightQueryable,
} from "./schema-rollback-compatibility.js";

export const SCHEMA_024 = "024_stage_c_identity_security" as const;
export const SCHEMA_024_APPLICATION_GUARD = "opensales:schema-024-application" as const;

// Frozen from the reviewed Schema 024 DDL on PostgreSQL 18.4.
export const SCHEMA_024_CATALOG_DIGEST =
  "7b896c95ab08a0a61c460b5f3566a5a4f50fade34cdc95f2633beb5e0076e934" as const;

export const EXPECTED_SCHEMA_024_HISTORY = [
  ...EXPECTED_SCHEMA_023_HISTORY,
  SCHEMA_024,
] as const;

export type Schema024NativePreflightReport = Readonly<{
  installedSchemaVersion: typeof SCHEMA_024;
  applicationSchemaVersion: typeof SCHEMA_024;
  mode: "native";
  safe: true;
  blockers: readonly [];
}>;

function rowRecord(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Schema 024 preflight returned an invalid database row");
  }
  return row as Record<string, unknown>;
}

export async function schema024CatalogFingerprintInput(
  database: RollbackPreflightQueryable,
  input: Readonly<{ allowSchema027NotificationTemplateExtensions?: boolean }> = {},
): Promise<string | null> {
  const allowSchema027NotificationTemplateExtensions =
    input.allowSchema027NotificationTemplateExtensions === true;
  const result = await database.query(
    `WITH target_relations(name) AS (
       VALUES
         ('password_reset_tokens'),
         ('lab_identity_mailbox_capabilities'),
         ('email_change_tokens'),
         ('totp_enrollment_challenges'),
         ('user_totp_credentials'),
         ('totp_recovery_code_batches'),
         ('totp_recovery_codes'),
         ('totp_step_use_facts'),
         ('login_challenges'),
         ('customer_api_keys'),
         ('customer_api_key_revocations'),
         ('customer_api_key_usage_facts'),
         ('identity_notification_outbox'),
         ('identity_notification_delivery_facts'),
         ('identity_notification_delivery_operations'),
         ('identity_password_change_events'),
         ('identity_email_change_events'),
         ('identity_action_facts')
     ), target_base_columns(relation_name, column_name) AS (
       VALUES
         ('users', 'authorization_epoch'),
         ('sessions', 'revoked_transaction_id'),
         ('reauth_grants', 'factor_method')
     ), target_base_constraints(relation_name, constraint_name) AS (
       VALUES
         ('users', 'users_authorization_epoch_check'),
         ('sessions', 'sessions_revoked_transaction_check'),
         ('reauth_grants', 'reauth_grants_factor_method_check')
     ), target_triggers(name) AS (
       VALUES
         ('totp_recovery_codes_batch_insert_guard'),
         ('totp_recovery_code_batch_projection_guard'),
         ('totp_recovery_code_projection_guard'),
         ('customer_api_keys_canonical_scopes'),
         ('customer_api_key_revocations_insert_guard'),
         ('customer_api_key_usage_facts_insert_guard'),
         ('identity_notification_outbox_subject_guard'),
         ('identity_notification_delivery_operations_guard'),
         ('identity_notification_delivery_facts_insert_guard'),
         ('identity_delivery_operation_projection_guard'),
         ('identity_delivery_fact_projection_guard'),
         ('identity_notification_durable_job_guard'),
         ('identity_notification_outbox_bundle_guard'),
         ('identity_notification_operation_bundle_guard'),
         ('identity_notification_job_bundle_guard'),
         ('users_record_password_change_event'),
         ('identity_password_change_events_insert_guard'),
         ('users_record_email_change_event'),
         ('identity_email_change_events_insert_guard'),
         ('identity_action_facts_insert_guard'),
         ('customer_api_keys_immutable'),
         ('customer_api_key_revocations_immutable'),
         ('customer_api_key_usage_facts_immutable'),
         ('totp_step_use_facts_immutable'),
         ('totp_recovery_code_batches_immutable'),
         ('identity_password_change_events_immutable'),
         ('identity_email_change_events_immutable'),
         ('user_totp_credentials_guard'),
         ('identity_notification_outbox_immutable'),
         ('identity_notification_delivery_facts_immutable'),
         ('identity_action_facts_immutable'),
         ('audit_events_immutable'),
         ('password_reset_tokens_transition_guard'),
         ('email_change_tokens_transition_guard'),
         ('login_challenges_transition_guard'),
         ('lab_identity_mailbox_capabilities_guard'),
         ('sessions_revoke_lab_identity_mailbox_capability'),
         ('totp_enrollment_challenges_transition_guard'),
         ('totp_recovery_codes_transition_guard'),
         ('sessions_revocation_transaction_insert_guard'),
         ('sessions_revocation_transaction_guard'),
         ('sessions_invalidate_reauth_on_revoke'),
         ('users_bump_credential_authorization_epoch'),
         ('users_authorization_epoch_monotonic'),
         ('users_authorization_epoch_invalidate_reauth'),
         ('client_memberships_bump_authorization_epoch'),
         ('staff_members_bump_authorization_epoch')
     ), target_functions(name) AS (
       VALUES
         ('opensales_identity_envelope_key_version'),
         ('opensales_guard_totp_recovery_code_batch_insert'),
         ('opensales_validate_totp_recovery_code_batch'),
         ('opensales_validate_customer_api_key_scopes'),
         ('opensales_guard_customer_api_key_fact_insert'),
         ('opensales_identity_notification_request_fingerprint'),
         ('opensales_validate_identity_notification_outbox'),
         ('opensales_guard_identity_delivery_operation'),
         ('opensales_guard_identity_delivery_fact_insert'),
         ('opensales_validate_identity_delivery_projection'),
         ('opensales_guard_identity_notification_job'),
         ('opensales_validate_identity_notification_bundle'),
         ('opensales_record_password_change_event'),
         ('opensales_guard_password_change_event_insert'),
         ('opensales_record_email_change_event'),
         ('opensales_guard_email_change_event_insert'),
         ('opensales_guard_identity_action_fact_insert'),
         ('opensales_reject_identity_fact_mutation'),
         ('opensales_guard_totp_credential'),
         ('opensales_guard_identity_token_transition'),
         ('opensales_guard_lab_identity_mailbox_capability'),
         ('opensales_revoke_lab_identity_mailbox_capability_for_session'),
         ('opensales_guard_totp_enrollment_transition'),
         ('opensales_guard_totp_recovery_code_transition'),
         ('opensales_guard_session_revocation_transaction'),
         ('opensales_invalidate_session_reauth_on_revoke'),
         ('opensales_bump_credential_authorization_epoch'),
         ('opensales_guard_authorization_epoch'),
         ('opensales_invalidate_reauth_on_authorization_epoch'),
         ('opensales_bump_membership_authorization_epoch'),
         ('opensales_bump_staff_authorization_epoch')
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
           OR (actual.table_name, actual.column_name) IN (
             SELECT relation_name, column_name FROM target_base_columns
           )
         )
         AND NOT (
           $1::boolean
           AND actual.table_name = 'identity_notification_delivery_operations'
           AND actual.column_name IN (
             'template_revision_id', 'template_revision', 'template_locale'
           )
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'constraint', relation.relname, actual.conname,
                actual.contype::text, actual.convalidated::text,
                actual.condeferrable::text, actual.condeferred::text,
                actual.connoinherit::text,
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_constraintdef(actual.oid, true), '\\s+', ' ', 'g'
                ))
       FROM pg_catalog.pg_constraint actual
       JOIN pg_catalog.pg_class relation ON relation.oid = actual.conrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND (
           relation.relname IN (SELECT name FROM target_relations)
           OR (relation.relname, actual.conname) IN (
             SELECT relation_name, constraint_name FROM target_base_constraints
           )
         )
         AND NOT (
           $1::boolean
           AND relation.relname = 'identity_notification_delivery_operations'
           AND actual.conname IN (
             'identity_notification_operations_template_revision_check',
             'identity_notification_operations_template_locale_check',
             'identity_notification_operations_template_revision_fkey',
             'identity_notification_delivery_op_template_revision_id_not_null',
             'identity_notification_delivery_opera_template_revision_not_null',
             'identity_notification_delivery_operati_template_locale_not_null'
           )
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'index', actual.schemaname,
                actual.tablename, actual.indexname,
                pg_catalog.regexp_replace(actual.indexdef, '\\s+', ' ', 'g'))
       FROM pg_catalog.pg_indexes actual
       WHERE actual.schemaname = 'public'
         AND actual.tablename IN (SELECT name FROM target_relations)
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'trigger', relation.relname, actual.tgname,
                actual.tgenabled::text, actual.tgtype::text,
                actual.tgdeferrable::text, actual.tginitdeferred::text,
                procedure_namespace.nspname, procedure.proname,
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_triggerdef(actual.oid, true), '\\s+', ' ', 'g'
                ))
       FROM pg_catalog.pg_trigger actual
       JOIN pg_catalog.pg_class relation ON relation.oid = actual.tgrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_proc procedure ON procedure.oid = actual.tgfoid
       JOIN pg_catalog.pg_namespace procedure_namespace
         ON procedure_namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = 'public' AND NOT actual.tgisinternal
         AND (
           relation.relname IN (SELECT name FROM target_relations)
           OR actual.tgname IN (SELECT name FROM target_triggers)
         )
         AND NOT (
           $1::boolean
           AND relation.relname = 'identity_notification_delivery_operations'
           AND actual.tgname = 'identity_notification_operations_template_revision_guard'
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'function', namespace.nspname, actual.proname,
                pg_catalog.pg_get_function_identity_arguments(actual.oid),
                pg_catalog.pg_get_function_result(actual.oid), language.lanname,
                actual.provolatile::text, actual.prosecdef::text,
                actual.proleakproof::text,
                COALESCE(pg_catalog.array_to_string(actual.proconfig, ','), ''),
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_functiondef(actual.oid), '\\s+', ' ', 'g'
                ))
       FROM pg_catalog.pg_proc actual
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = actual.pronamespace
       JOIN pg_catalog.pg_language language ON language.oid = actual.prolang
       JOIN target_functions target ON target.name = actual.proname
       WHERE namespace.nspname = 'public'
     ), fingerprint(value) AS (
       SELECT pg_catalog.string_agg(item, E'\\n' ORDER BY item COLLATE "C")
       FROM catalog_items
     )
     SELECT value FROM fingerprint`,
    [allowSchema027NotificationTemplateExtensions],
  );
  const value = result.rows[0] ? rowRecord(result.rows[0]).value : null;
  return typeof value === "string" ? value : null;
}

export function schema024CatalogDigest(fingerprintInput: string | null): string | null {
  return fingerprintInput
    ? createHash("sha256").update(fingerprintInput, "utf8").digest("hex")
    : null;
}

export function assertSchema024CatalogDigest(digest: string | null): void {
  if (digest !== SCHEMA_024_CATALOG_DIGEST) {
    throw new SchemaRollbackPreflightError(
      `Schema 024 is incomplete or counterfeit: catalog digest ${String(digest)} does not match reviewed digest ${SCHEMA_024_CATALOG_DIGEST}; do not start a schema-024 application.`,
      SCHEMA_024,
    );
  }
}

export async function assertSchema024CatalogShape(
  database: RollbackPreflightQueryable,
  input: Readonly<{ allowSchema027NotificationTemplateExtensions?: boolean }> = {},
): Promise<void> {
  assertSchema024CatalogDigest(
    schema024CatalogDigest(await schema024CatalogFingerprintInput(database, input)),
  );
}

export async function assertSchema024NativeSafe(
  database: RollbackPreflightQueryable,
): Promise<Schema024NativePreflightReport> {
  await assertSchema023NativeSafe(database, {
    allowSchema024IdentityExtensions: true,
  });
  await assertSchema024CatalogShape(database);
  return {
    installedSchemaVersion: SCHEMA_024,
    applicationSchemaVersion: SCHEMA_024,
    mode: "native",
    safe: true,
    blockers: [],
  };
}
