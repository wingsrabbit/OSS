// SPDX-License-Identifier: AGPL-3.0-or-later

import { open } from "node:fs/promises";
import { assertRuntimeDatabaseRoleSafe } from "@opensales/core";
import { loadConfig } from "./config.js";
import { createPool } from "./database.js";
import { issueInitialStaffBootstrapToken } from "./staff-bootstrap.js";

const config = loadConfig();
if (!config.DATABASE_RUNTIME_ROLE) {
  throw new Error("Staff bootstrap requires DATABASE_RUNTIME_ROLE");
}
const pool = createPool(config);
await assertRuntimeDatabaseRoleSafe(
  { query: async (text, values) => pool.query(text, values) },
  config.DATABASE_RUNTIME_ROLE,
);
const outputFile = process.env.BOOTSTRAP_TOKEN_OUTPUT_FILE;
if (!outputFile) {
  await pool.end();
  throw new Error("BOOTSTRAP_TOKEN_OUTPUT_FILE is required");
}
const { token, expiresAt } = await issueInitialStaffBootstrapToken(pool);
await pool.end();
const handle = await open(outputFile, "wx", 0o600);
try {
  await handle.writeFile(
    `${JSON.stringify({ token, expiresAt: expiresAt.toISOString() })}\n`,
    "utf8",
  );
} finally {
  await handle.close();
}
console.log(`Single-use staff bootstrap credential written with mode 0600 to ${outputFile}.`);
