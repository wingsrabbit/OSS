// SPDX-License-Identifier: AGPL-3.0-or-later

export type DatabaseRoleBoundaryQueryable = Readonly<{
  query: (text: string, values?: unknown[]) => Promise<Readonly<{ rows: unknown[] }>>;
}>;

type RoleBoundaryRow = Readonly<{
  current_role: unknown;
  session_role: unknown;
  is_superuser: unknown;
  bypasses_rls: unknown;
  creates_roles: unknown;
  creates_databases: unknown;
  owns_database: unknown;
  owns_public_schema: unknown;
  can_create_public: unknown;
  can_set_replication_role: unknown;
  owns_or_inherits_public_objects: unknown;
  migration_insert: unknown;
  migration_update: unknown;
  migration_delete: unknown;
  migration_truncate: unknown;
  migration_trigger: unknown;
  migration_references: unknown;
}>;

function roleBoundaryRow(row: unknown): RoleBoundaryRow {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Database role boundary check returned an invalid row");
  }
  return row as RoleBoundaryRow;
}

export async function assertRuntimeDatabaseRoleSafe(
  database: DatabaseRoleBoundaryQueryable,
  expectedRole: string,
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(expectedRole)) {
    throw new Error("Expected runtime database role has an invalid identifier");
  }
  const result = await database.query(
    `SELECT
       current_user AS current_role,
       session_user AS session_role,
       role.rolsuper AS is_superuser,
       role.rolbypassrls AS bypasses_rls,
       role.rolcreaterole AS creates_roles,
       role.rolcreatedb AS creates_databases,
       database_record.datdba = role.oid AS owns_database,
       public_schema.nspowner = role.oid AS owns_public_schema,
       pg_catalog.has_schema_privilege(role.oid, public_schema.oid, 'CREATE')
         AS can_create_public,
       pg_catalog.has_parameter_privilege(
         role.oid, 'session_replication_role', 'SET'
       ) AS can_set_replication_role,
       EXISTS (
         SELECT 1
         FROM (
           SELECT relation.relowner AS owner_oid
           FROM pg_catalog.pg_class relation
           WHERE relation.relnamespace = public_schema.oid
           UNION
           SELECT procedure.proowner
           FROM pg_catalog.pg_proc procedure
           WHERE procedure.pronamespace = public_schema.oid
         ) owned
         WHERE owned.owner_oid = role.oid
            OR pg_catalog.pg_has_role(role.oid, owned.owner_oid, 'MEMBER')
       ) AS owns_or_inherits_public_objects,
       pg_catalog.has_table_privilege(
         role.oid, 'public.schema_migrations', 'INSERT'
       ) AS migration_insert,
       pg_catalog.has_table_privilege(
         role.oid, 'public.schema_migrations', 'UPDATE'
       ) AS migration_update,
       pg_catalog.has_table_privilege(
         role.oid, 'public.schema_migrations', 'DELETE'
       ) AS migration_delete,
       pg_catalog.has_table_privilege(
         role.oid, 'public.schema_migrations', 'TRUNCATE'
       ) AS migration_truncate,
       pg_catalog.has_table_privilege(
         role.oid, 'public.schema_migrations', 'TRIGGER'
       ) AS migration_trigger,
       pg_catalog.has_table_privilege(
         role.oid, 'public.schema_migrations', 'REFERENCES'
       ) AS migration_references
     FROM pg_catalog.pg_roles role
     JOIN pg_catalog.pg_database database_record
       ON database_record.datname = pg_catalog.current_database()
     JOIN pg_catalog.pg_namespace public_schema
       ON public_schema.nspname = 'public'
     WHERE role.rolname = current_user`,
  );
  const row = roleBoundaryRow(result.rows[0]);
  const unsafe =
    row.current_role !== expectedRole ||
    row.session_role !== expectedRole ||
    row.is_superuser !== false ||
    row.bypasses_rls !== false ||
    row.creates_roles !== false ||
    row.creates_databases !== false ||
    row.owns_database !== false ||
    row.owns_public_schema !== false ||
    row.can_create_public !== false ||
    row.can_set_replication_role !== false ||
    row.owns_or_inherits_public_objects !== false ||
    row.migration_insert !== false ||
    row.migration_update !== false ||
    row.migration_delete !== false ||
    row.migration_truncate !== false ||
    row.migration_trigger !== false ||
    row.migration_references !== false;
  if (unsafe) {
    throw new Error(
      `Database runtime role boundary rejected ${String(row.current_role)}; ` +
        `expected isolated role ${expectedRole} without owner, DDL, trigger, ` +
        "replication, or migration-history mutation authority",
    );
  }
}

export async function assertMigrationDatabaseRoleSafe(
  database: DatabaseRoleBoundaryQueryable,
): Promise<void> {
  const result = await database.query(
    `SELECT
       role.rolsuper
         OR (
           pg_catalog.has_schema_privilege(role.oid, public_schema.oid, 'CREATE')
           AND (
             migration_table.oid IS NULL
             OR migration_table.relowner = role.oid
             OR pg_catalog.pg_has_role(role.oid, migration_table.relowner, 'MEMBER')
           )
         ) AS migration_authorized
     FROM pg_catalog.pg_roles role
     JOIN pg_catalog.pg_namespace public_schema
       ON public_schema.nspname = 'public'
     LEFT JOIN pg_catalog.pg_class migration_table
       ON migration_table.relnamespace = public_schema.oid
      AND migration_table.relname = 'schema_migrations'
      AND migration_table.relkind = 'r'
     WHERE role.rolname = current_user`,
  );
  const row = result.rows[0];
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    (row as { migration_authorized?: unknown }).migration_authorized !== true
  ) {
    throw new Error(
      "Database migration role boundary rejected a non-owner runtime connection",
    );
  }
}
