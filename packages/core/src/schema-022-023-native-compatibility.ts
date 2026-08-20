// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import {
  EXPECTED_SCHEMA_022_HISTORY,
  assertSchema022CatalogShape,
} from "./schema-021-022-native-compatibility.js";
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
import { assertSchema021CatalogShape } from "./schema-020-021-native-compatibility.js";
import {
  SchemaRollbackPreflightError,
  type RollbackPreflightQueryable,
} from "./schema-rollback-compatibility.js";

export const SCHEMA_023 = "023_stage_c_service_operations" as const;
export const SCHEMA_023_APPLICATION_GUARD = "opensales:schema-023-application" as const;

// Frozen from the reviewed Schema 023 DDL on PostgreSQL 18.4.
export const SCHEMA_023_CATALOG_DIGEST =
  "a866c758779cf41801111243deb6d0fa7f52d5be8681ec260d9214dcb40c8476" as const;

export const EXPECTED_SCHEMA_023_HISTORY = [
  ...EXPECTED_SCHEMA_022_HISTORY,
  SCHEMA_023,
] as const;

export type Schema023NativePreflightReport = Readonly<{
  installedSchemaVersion: typeof SCHEMA_023;
  applicationSchemaVersion: typeof SCHEMA_023;
  mode: "native";
  safe: true;
  blockers: readonly [];
}>;

export type Schema023IdentityForwardExtensionPreflightReport = Readonly<{
  installedSchemaVersion: "024_stage_c_identity_security";
  applicationSchemaVersion: typeof SCHEMA_023;
  mode: "native-foundation";
  safe: true;
  blockers: readonly [];
}>;

export type Schema023NativePreflightOptions = Readonly<{
  allowSchema024IdentityExtensions?: boolean;
}>;

function rowRecord(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Schema 023 preflight returned an invalid database row");
  }
  return row as Record<string, unknown>;
}

export async function schema023CatalogFingerprintInput(
  database: RollbackPreflightQueryable,
): Promise<string | null> {
  const result = await database.query(
    `WITH target_relations(name) AS (
       VALUES
         ('service_resource_state_facts'),
         ('service_resource_desired_state_facts'),
         ('service_resource_operation_requests'),
         ('service_resource_operation_attempt_facts'),
         ('service_resource_operation_result_facts'),
         ('service_resource_operation_manual_completions'),
         ('service_operation_job_transition_facts')
     ), target_functions(name) AS (
       VALUES
         ('opensales_reject_service_operation_fact_mutation'),
         ('opensales_service_operation_request_fingerprint'),
         ('opensales_validate_service_operation_request'),
         ('opensales_guard_service_resource_provider_operation'),
         ('opensales_guard_service_operation_job'),
         ('opensales_validate_service_operation_job_transition'),
         ('opensales_check_service_operation_job_transition_commit'),
         ('opensales_check_service_operation_result_authority'),
         ('opensales_check_service_operation_reconcile_attempt_commit'),
         ('opensales_record_commercial_resource_observation'),
         ('opensales_validate_service_operation_manual_completion'),
         ('opensales_validate_service_operation_result'),
         ('opensales_validate_service_resource_state_fact'),
         ('opensales_validate_service_desired_state_fact'),
         ('opensales_validate_service_operation_attempt'),
         ('opensales_check_service_operation_commit_pair'),
         ('opensales_check_service_operation_manual_completion_pair'),
         ('opensales_check_service_operation_provider_projection'),
         ('opensales_check_service_operation_request_commit')
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
       JOIN target_relations target ON target.name = actual.table_name
       WHERE actual.table_schema = 'public'
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
           OR (relation.relname = 'provider_operations'
               AND actual.conname = 'provider_operations_kind_check')
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'index', actual.schemaname,
                actual.tablename, actual.indexname,
                pg_catalog.regexp_replace(actual.indexdef, '\\s+', ' ', 'g'))
       FROM pg_catalog.pg_indexes actual
       WHERE actual.schemaname = 'public'
         AND (
           actual.tablename IN (SELECT name FROM target_relations)
           OR actual.indexname = 'provider_operations_service_resource_request_uidx'
         )
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
           OR actual.tgname IN (
             'provider_operations_service_resource_guard',
             'durable_jobs_service_operation_guard',
             'services_commercial_resource_observation'
           )
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
  );
  const value = result.rows[0] ? rowRecord(result.rows[0]).value : null;
  return typeof value === "string" ? value : null;
}

export function schema023CatalogDigest(fingerprintInput: string | null): string | null {
  return fingerprintInput
    ? createHash("sha256").update(fingerprintInput, "utf8").digest("hex")
    : null;
}

export function assertSchema023CatalogDigest(digest: string | null): void {
  if (digest !== SCHEMA_023_CATALOG_DIGEST) {
    throw new SchemaRollbackPreflightError(
      `Schema 023 is incomplete or counterfeit: catalog digest ${String(digest)} does not match reviewed digest ${SCHEMA_023_CATALOG_DIGEST}; do not start a schema-023 application.`,
      SCHEMA_023,
    );
  }
}

export async function assertSchema023CatalogShape(
  database: RollbackPreflightQueryable,
): Promise<void> {
  assertSchema023CatalogDigest(
    schema023CatalogDigest(await schema023CatalogFingerprintInput(database)),
  );
}

export function assertSchema023NativeSafe(
  database: RollbackPreflightQueryable,
): Promise<Schema023NativePreflightReport>;
export function assertSchema023NativeSafe(
  database: RollbackPreflightQueryable,
  input: Readonly<{ allowSchema024IdentityExtensions: true }>,
): Promise<Schema023IdentityForwardExtensionPreflightReport>;
export async function assertSchema023NativeSafe(
  database: RollbackPreflightQueryable,
  input: Schema023NativePreflightOptions = {},
): Promise<Schema023NativePreflightReport | Schema023IdentityForwardExtensionPreflightReport> {
  const allowSchema024IdentityExtensions =
    input.allowSchema024IdentityExtensions === true;
  const expectedInstalled = allowSchema024IdentityExtensions
    ? "024_stage_c_identity_security"
    : SCHEMA_023;
  const expectedHistory = allowSchema024IdentityExtensions
    ? [...EXPECTED_SCHEMA_023_HISTORY, "024_stage_c_identity_security"]
    : [...EXPECTED_SCHEMA_023_HISTORY];
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
  if (installed !== expectedInstalled) {
    throw new SchemaRollbackPreflightError(
      installed === null
        ? `Database schema is missing; application schema ${expectedInstalled} requires a forward migration.`
        : `Database schema ${installed} is incompatible with application schema ${expectedInstalled}; run the dedicated forward migration and never run a down migration.`,
      installed,
    );
  }
  const history = await database.query(
    `SELECT pg_catalog.array_agg(version ORDER BY version COLLATE "C") = $1::text[]
       AS history_exact
     FROM public.schema_migrations`,
    [expectedHistory],
  );
  if (rowRecord(history.rows[0]).history_exact !== true) {
    throw new SchemaRollbackPreflightError(
      "Schema 023 migration history is incomplete or contains an unreviewed migration; repair forward without deleting migration history.",
      SCHEMA_023,
    );
  }
  await assertSchema023FoundationCatalogShape(database);
  if (allowSchema024IdentityExtensions) {
    return {
      installedSchemaVersion: "024_stage_c_identity_security",
      applicationSchemaVersion: SCHEMA_023,
      mode: "native-foundation",
      safe: true,
      blockers: [],
    };
  }
  return {
    installedSchemaVersion: SCHEMA_023,
    applicationSchemaVersion: SCHEMA_023,
    mode: "native",
    safe: true,
    blockers: [],
  };
}

/**
 * Revalidates the complete Schema 023-and-earlier catalog foundation without
 * relaxing Schema 023's exact migration-history gate. Forward schemas call
 * this only after independently proving their own exact installed history.
 */
export async function assertSchema023FoundationCatalogShape(
  database: RollbackPreflightQueryable,
  input: Readonly<{ allowSchema027NotificationTemplateExtensions?: boolean }> = {},
): Promise<void> {
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
      SCHEMA_023,
    );
  }
  await assertSchema018CatalogShape(database, {
    allowSchema021SupportExtensions: true,
  });
  const schema019Shape = await schema019CatalogFingerprintInput(database, {
    allowSchema027NotificationTemplateExtensions:
      input.allowSchema027NotificationTemplateExtensions === true,
  });
  assertSchema019CatalogDigest(schema019CatalogDigest(schema019Shape.fingerprintInput));
  await assertSchema020CatalogShape(database, {
    allowSchema022CommerceExtensions: true,
  });
  await assertSchema021CatalogShape(database);
  await assertSchema022CatalogShape(database);
  await assertSchema023CatalogShape(database);
}
