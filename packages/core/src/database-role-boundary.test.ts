// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMigrationDatabaseRoleSafe,
  assertRuntimeDatabaseRoleSafe,
} from "./database-role-boundary.js";

const safeRuntime = {
  current_role: "oss_api",
  session_role: "oss_api",
  is_superuser: false,
  bypasses_rls: false,
  creates_roles: false,
  creates_databases: false,
  owns_database: false,
  owns_public_schema: false,
  can_create_public: false,
  can_set_replication_role: false,
  owns_or_inherits_public_objects: false,
  migration_insert: false,
  migration_update: false,
  migration_delete: false,
  migration_truncate: false,
  migration_trigger: false,
  migration_references: false,
} as const;

test("runtime database role boundary accepts only the exact isolated role", async () => {
  await assert.doesNotReject(
    assertRuntimeDatabaseRoleSafe(
      { query: async () => ({ rows: [safeRuntime] }) },
      "oss_api",
    ),
  );
  await assert.rejects(
    assertRuntimeDatabaseRoleSafe(
      {
        query: async () => ({
          rows: [{ ...safeRuntime, can_create_public: true }],
        }),
      },
      "oss_api",
    ),
    /without owner, DDL, trigger, replication, or migration-history mutation authority/,
  );
  await assert.rejects(
    assertRuntimeDatabaseRoleSafe(
      { query: async () => ({ rows: [safeRuntime] }) },
      "oss_worker",
    ),
    /expected isolated role oss_worker/,
  );
});

test("migration database role boundary rejects a runtime connection", async () => {
  await assert.doesNotReject(
    assertMigrationDatabaseRoleSafe({
      query: async () => ({ rows: [{ migration_authorized: true }] }),
    }),
  );
  await assert.rejects(
    assertMigrationDatabaseRoleSafe({
      query: async () => ({ rows: [{ migration_authorized: false }] }),
    }),
    /non-owner runtime connection/,
  );
});
