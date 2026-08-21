// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { assertSchema023FoundationCatalogShape } from "./schema-022-023-native-compatibility.js";
import { assertSchema024CatalogShape } from "./schema-023-024-native-compatibility.js";
import { assertSchema025CatalogShape } from "./schema-024-025-native-compatibility.js";
import {
  EXPECTED_SCHEMA_026_HISTORY,
  assertSchema026CatalogShape,
} from "./schema-025-026-native-compatibility.js";
import {
  SchemaRollbackPreflightError,
  type RollbackPreflightQueryable,
} from "./schema-rollback-compatibility.js";

export const SCHEMA_027 = "027_stage_c_notification_templates_preferences" as const;
export const SCHEMA_027_APPLICATION_GUARD = "opensales:schema-027-application" as const;

// Frozen from the reviewed Schema 027 DDL on PostgreSQL 18.4.
export const SCHEMA_027_CATALOG_DIGEST =
  "88b33522945aa016bd0d35647664203468d9b6e19cb450a4da32ad4a944df106" as const;

export const EXPECTED_SCHEMA_027_HISTORY = [
  ...EXPECTED_SCHEMA_026_HISTORY,
  SCHEMA_027,
] as const;

export type Schema027NativePreflightReport = Readonly<{
  installedSchemaVersion: typeof SCHEMA_027;
  applicationSchemaVersion: typeof SCHEMA_027;
  mode: "native";
  safe: true;
  blockers: readonly [];
}>;

function rowRecord(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Schema 027 preflight returned an invalid database row");
  }
  return row as Record<string, unknown>;
}

async function assertSchema027HistoryExact(
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
  if (installed !== SCHEMA_027) {
    throw new SchemaRollbackPreflightError(
      installed === null
        ? `Database schema is missing; application schema ${SCHEMA_027} requires a forward migration.`
        : `Database schema ${installed} is incompatible with application schema ${SCHEMA_027}; run the dedicated forward migration and never run a down migration.`,
      installed,
    );
  }
  const history = await database.query(
    `SELECT pg_catalog.array_agg(version ORDER BY version COLLATE "C") = $1::text[]
       AS history_exact
     FROM public.schema_migrations`,
    [[...EXPECTED_SCHEMA_027_HISTORY]],
  );
  if (rowRecord(history.rows[0]).history_exact !== true) {
    throw new SchemaRollbackPreflightError(
      "Schema 027 migration history is incomplete or contains an unreviewed migration; repair forward without deleting migration history.",
      SCHEMA_027,
    );
  }
}

export async function schema027CatalogFingerprintInput(
  database: RollbackPreflightQueryable,
): Promise<string | null> {
  const result = await database.query(
    `WITH target_relations(name) AS (
       VALUES
         ('notification_preference_categories'),
         ('notification_template_events'),
         ('notification_template_revisions'),
         ('notification_template_publications'),
         ('notification_template_retirements'),
         ('notification_template_channels'),
         ('current_notification_templates'),
         ('user_notification_preferences'),
         ('user_notification_preference_changes'),
         ('notification_delivery_operations'),
         ('identity_notification_delivery_operations')
     ), target_functions(name) AS (
       VALUES
         ('opensales_validate_notification_template_revision'),
         ('opensales_validate_notification_template_publication'),
         ('opensales_validate_notification_template_retirement'),
         ('opensales_reject_notification_template_fact_mutation'),
         ('opensales_validate_notification_template_channel'),
         ('opensales_guard_user_notification_preference'),
         ('opensales_reject_user_notification_preference_change_mutation'),
         ('opensales_validate_notification_delivery_operation'),
         ('opensales_guard_notification_operation_template_revision'),
         ('opensales_guard_identity_operation_template_revision')
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
         ON default_value.adrelid = relation.oid
        AND default_value.adnum = attribute.attnum
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
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'seed-category', category, label::text,
                required_delivery::text)
       FROM public.notification_preference_categories
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'seed-event', event_type,
                preference_category, required_delivery::text, sensitive::text,
                allowed_variables::text, required_variables::text)
       FROM public.notification_template_events
     ), fingerprint(value) AS (
       SELECT pg_catalog.string_agg(item, E'\\n' ORDER BY item COLLATE "C")
       FROM catalog_items
     )
     SELECT value FROM fingerprint`,
  );
  const value = result.rows[0] ? rowRecord(result.rows[0]).value : null;
  return typeof value === "string" ? value : null;
}

export function schema027CatalogDigest(fingerprintInput: string | null): string | null {
  return fingerprintInput
    ? createHash("sha256").update(fingerprintInput, "utf8").digest("hex")
    : null;
}

export function assertSchema027CatalogDigest(digest: string | null): void {
  if (digest !== SCHEMA_027_CATALOG_DIGEST) {
    throw new SchemaRollbackPreflightError(
      `Schema 027 catalog digest ${String(digest)} does not match reviewed digest ${SCHEMA_027_CATALOG_DIGEST}; do not start a schema-027 application.`,
      SCHEMA_027,
    );
  }
}

export async function assertSchema027CatalogShape(
  database: RollbackPreflightQueryable,
): Promise<void> {
  assertSchema027CatalogDigest(
    schema027CatalogDigest(await schema027CatalogFingerprintInput(database)),
  );
}

export async function assertSchema027NativeSafe(
  database: RollbackPreflightQueryable,
): Promise<Schema027NativePreflightReport> {
  await assertSchema027HistoryExact(database);
  await assertSchema023FoundationCatalogShape(database, {
    allowSchema027NotificationTemplateExtensions: true,
  });
  await assertSchema024CatalogShape(database, {
    allowSchema027NotificationTemplateExtensions: true,
  });
  await assertSchema025CatalogShape(database);
  await assertSchema026CatalogShape(database);
  await assertSchema027CatalogShape(database);
  return {
    installedSchemaVersion: SCHEMA_027,
    applicationSchemaVersion: SCHEMA_027,
    mode: "native",
    safe: true,
    blockers: [],
  };
}
