// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import {
  assert015RollbackBridgeSafe,
  SCHEMA_016,
} from "@opensales/core/schema-015-016-rollback-compatibility";
import {
  assertSchema016RollbackBridgeSafe,
  SCHEMA_017,
} from "@opensales/core/schema-016-017-rollback-compatibility";
import {
  assert014RollbackBridgeSafe,
  SCHEMA_014,
  SCHEMA_015,
} from "@opensales/core/schema-rollback-compatibility";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the normal rollback bridge integration");
}

const target = process.env.OSS_NORMAL_ROLLBACK_BRIDGE;
if (!target) {
  throw new Error("OSS_NORMAL_ROLLBACK_BRIDGE is required");
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 2,
  options: "-c search_path=pg_catalog,public",
  statement_timeout: 15_000,
  application_name: `opensales-${target}-normal-integration`,
});

try {
  const installed = await pool.query<{ version: string | null }>(
    "SELECT pg_catalog.max(version) AS version FROM public.schema_migrations",
  );

  if (target === "014-to-015") {
    assert.equal(installed.rows[0]?.version, SCHEMA_015);
    const report = await assert014RollbackBridgeSafe(pool, {
      enable015RollbackBridge: true,
    });
    assert.deepEqual(report, {
      installedSchemaVersion: SCHEMA_015,
      applicationSchemaVersion: SCHEMA_014,
      mode: "rollback_bridge",
      safe: true,
      blockers: [],
    });
  } else if (target === "015-to-016") {
    assert.equal(installed.rows[0]?.version, SCHEMA_016);
    const report = await assert015RollbackBridgeSafe(pool, {
      enable016RollbackBridge: true,
    });
    assert.deepEqual(report, {
      installedSchemaVersion: SCHEMA_016,
      applicationSchemaVersion: SCHEMA_015,
      mode: "rollback_bridge",
      safe: true,
      blockers: [],
    });
  } else if (target === "016-to-017") {
    assert.equal(installed.rows[0]?.version, SCHEMA_017);
    const report = await assertSchema016RollbackBridgeSafe(pool, {
      enable017RollbackBridge: true,
    });
    assert.deepEqual(report, {
      installedSchemaVersion: SCHEMA_017,
      applicationSchemaVersion: SCHEMA_016,
      mode: "rollback_bridge",
      safe: true,
      blockers: [],
    });
  } else {
    throw new Error(`Unsupported normal rollback bridge target: ${target}`);
  }

  process.stdout.write(`Normal ${target} rollback bridge PostgreSQL journey: PASS\n`);
} finally {
  await pool.end();
}
