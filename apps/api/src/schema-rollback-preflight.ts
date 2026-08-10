// SPDX-License-Identifier: AGPL-3.0-or-later

import { loadConfig } from "./config.js";
import { assertSchemaCompatible, createPool } from "./database.js";

const config = loadConfig();
const pool = createPool(config);
try {
  const report = await assertSchemaCompatible(pool, {
    enable017RollbackBridge: config.OSS_SCHEMA_ROLLBACK_BRIDGE === "016-to-017",
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await pool.end();
}
