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
  EXPECTED_SCHEMA_021_HISTORY,
  assertSchema021CatalogShape,
} from "./schema-020-021-native-compatibility.js";
import {
  SchemaRollbackPreflightError,
  type RollbackPreflightQueryable,
} from "./schema-rollback-compatibility.js";

export const SCHEMA_022 = "022_stage_c_catalog_commerce_hardening" as const;
export const SCHEMA_022_APPLICATION_GUARD = "opensales:schema-022-application" as const;

// Replaced only after a fresh PostgreSQL 18 catalog review at frozen DDL.
export const SCHEMA_022_CATALOG_DIGEST =
  "d2a557eca7d8937a16c382810f8fd9cdff2cec8914bb4bfd5afde126c85671a7" as const;

export const EXPECTED_SCHEMA_022_HISTORY = [
  ...EXPECTED_SCHEMA_021_HISTORY,
  SCHEMA_022,
] as const;

export type Schema022NativePreflightReport = Readonly<{
  installedSchemaVersion: typeof SCHEMA_022;
  applicationSchemaVersion: typeof SCHEMA_022;
  mode: "native";
  safe: true;
  blockers: readonly [];
}>;

function rowRecord(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Schema 022 preflight returned an invalid database row");
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

export async function schema022CatalogFingerprintInput(
  database: RollbackPreflightQueryable,
): Promise<string | null> {
  const result = await database.query(
    `WITH catalog_items(item) AS (
       SELECT pg_catalog.concat_ws('|', 'extension', extension.extname,
                namespace.nspname, extension.extrelocatable::text)
       FROM pg_catalog.pg_extension extension
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = extension.extnamespace
       WHERE extension.extname = 'btree_gist'
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'relation', namespace.nspname, relation.relname,
                relation.relkind::text, relation.relpersistence::text,
                relation.relreplident::text, relation.relrowsecurity::text,
                relation.relforcerowsecurity::text,
                COALESCE(pg_catalog.obj_description(relation.oid, 'pg_class'), ''))
       FROM pg_catalog.pg_namespace namespace
       JOIN pg_catalog.pg_class relation ON relation.relnamespace = namespace.oid
       WHERE namespace.nspname = 'public'
         AND relation.relname = 'supply_capacity_releases'
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
         AND actual.table_name = 'supply_capacity_releases'
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
           relation.relname = 'supply_capacity_releases'
           OR (relation.relname = 'product_prices' AND actual.conname IN (
             'product_prices_valid_interval_check',
             'product_prices_validity_excl'
           ))
           OR (relation.relname = 'promotions'
               AND actual.conname = 'promotions_validity_excl')
           OR (relation.relname = 'product_supply_capacities'
               AND actual.conname = 'product_supply_capacities_projection_invariant')
           OR (relation.relname = 'supply_capacity_reservations'
               AND actual.conname = 'supply_capacity_reservations_projection_invariant')
         )
       UNION ALL
       SELECT pg_catalog.concat_ws('|', 'index', actual.schemaname,
                actual.tablename, actual.indexname,
                pg_catalog.regexp_replace(actual.indexdef, '\\s+', ' ', 'g'))
       FROM pg_catalog.pg_indexes actual
       WHERE actual.schemaname = 'public'
         AND (
           actual.tablename = 'supply_capacity_releases'
           OR (actual.tablename = 'product_prices'
               AND actual.indexname = 'product_prices_validity_excl')
           OR (actual.tablename = 'promotions'
               AND actual.indexname = 'promotions_validity_excl')
           OR (actual.tablename = 'supply_capacity_reservations'
               AND actual.indexname = 'supply_capacity_reservations_product_idx')
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
           'supply_capacity_releases_projection_guard',
           'supply_capacity_releases_apply_projection',
           'supply_capacity_releases_immutable',
           'services_release_supply_on_terminal',
           'orders_release_supply_on_terminal',
           'orders_released_supply_terminal_guard',
           'services_released_supply_terminal_guard',
           'product_supply_capacities_projection_invariant',
           'supply_capacity_reservations_projection_invariant',
           'supply_capacity_releases_projection_invariant'
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
           'opensales_validate_quote_terminal_fact',
           'opensales_validate_supply_capacity_release',
           'opensales_apply_supply_capacity_release',
           'opensales_release_supply_for_terminal_service',
           'opensales_release_supply_for_terminal_order',
           'opensales_guard_released_supply_terminal_state',
           'opensales_validate_supply_capacity_projection'
         )
     ), fingerprint(value) AS (
       SELECT pg_catalog.string_agg(item, E'\\n' ORDER BY item COLLATE "C")
       FROM catalog_items
     )
     SELECT value FROM fingerprint`,
  );
  const value = result.rows[0] ? rowRecord(result.rows[0]).value : null;
  return typeof value === "string" ? value : null;
}

export function schema022CatalogDigest(fingerprintInput: string | null): string | null {
  return fingerprintInput
    ? createHash("sha256").update(fingerprintInput, "utf8").digest("hex")
    : null;
}

export function assertSchema022CatalogDigest(digest: string | null): void {
  if (digest !== SCHEMA_022_CATALOG_DIGEST) {
    throw new SchemaRollbackPreflightError(
      `Schema 022 is incomplete or counterfeit: catalog digest ${String(digest)} does not match reviewed digest ${SCHEMA_022_CATALOG_DIGEST}; do not start a schema-022 application.`,
      SCHEMA_022,
    );
  }
}

export async function assertSchema022CatalogShape(
  database: RollbackPreflightQueryable,
): Promise<void> {
  assertSchema022CatalogDigest(
    schema022CatalogDigest(await schema022CatalogFingerprintInput(database)),
  );
}

export async function assertSchema022NativeSafe(
  database: RollbackPreflightQueryable,
): Promise<Schema022NativePreflightReport> {
  const installed = await installedSchemaVersion(database);
  if (installed !== SCHEMA_022) {
    throw new SchemaRollbackPreflightError(
      installed === null
        ? `Database schema is missing; application schema ${SCHEMA_022} requires a forward migration.`
        : `Database schema ${installed} is incompatible with application schema ${SCHEMA_022}; run the dedicated forward migration and never run a down migration.`,
      installed,
    );
  }
  const history = await database.query(
    `SELECT pg_catalog.array_agg(version ORDER BY version COLLATE "C") = $1::text[]
       AS history_exact
     FROM public.schema_migrations`,
    [[...EXPECTED_SCHEMA_022_HISTORY]],
  );
  if (rowRecord(history.rows[0]).history_exact !== true) {
    throw new SchemaRollbackPreflightError(
      "Schema 022 migration history is incomplete or contains an unreviewed migration; repair forward without deleting migration history.",
      SCHEMA_022,
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
      SCHEMA_022,
    );
  }
  await assertSchema018CatalogShape(database, {
    allowSchema021SupportExtensions: true,
  });
  const schema019Shape = await schema019CatalogFingerprintInput(database);
  assertSchema019CatalogDigest(schema019CatalogDigest(schema019Shape.fingerprintInput));
  await assertSchema020CatalogShape(database, {
    allowSchema022CommerceExtensions: true,
  });
  await assertSchema021CatalogShape(database);
  await assertSchema022CatalogShape(database);
  return {
    installedSchemaVersion: SCHEMA_022,
    applicationSchemaVersion: SCHEMA_022,
    mode: "native",
    safe: true,
    blockers: [],
  };
}
