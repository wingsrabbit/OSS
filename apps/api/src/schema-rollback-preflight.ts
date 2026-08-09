// SPDX-License-Identifier: AGPL-3.0-or-later

import { loadConfig } from "./config.js";
import { assertSchemaCompatible, createPool } from "./database.js";

const config = loadConfig();
const pool = createPool(config);
try {
  const report = await assertSchemaCompatible(pool);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await pool.end();
}
