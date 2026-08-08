// SPDX-License-Identifier: AGPL-3.0-or-later

import { loadConfig } from "./config.js";
import { assert014RollbackSchemaCompatible, createPool } from "./database.js";

const config = loadConfig();
const pool = createPool(config);
try {
  const report = await assert014RollbackSchemaCompatible(pool, {
    enable015RollbackBridge: config.OSS_SCHEMA_ROLLBACK_BRIDGE === "014-to-015",
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await pool.end();
}
