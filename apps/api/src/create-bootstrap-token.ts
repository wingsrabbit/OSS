// SPDX-License-Identifier: AGPL-3.0-or-later

import { open } from "node:fs/promises";
import { assertRuntimeDatabaseRoleSafe } from "@opensales/core";
import { createOpaqueToken, digestToken } from "./auth.js";
import { loadConfig } from "./config.js";
import {
  createPool,
  transaction,
} from "./database.js";

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
const token = createOpaqueToken();
const expiresAt = await transaction(pool, async (client) => {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    "opensales:staff-bootstrap",
  ]);
  const existingStaff = await client.query("SELECT 1 FROM staff_members LIMIT 1");
  if (existingStaff.rowCount !== 0) {
    throw new Error("Staff bootstrap is already complete");
  }
  await client.query(
    "UPDATE staff_bootstrap_tokens SET used_at = now() WHERE used_at IS NULL",
  );
  const inserted = await client.query<{ expires_at: Date }>(
    `INSERT INTO staff_bootstrap_tokens(token_digest, expires_at)
     VALUES ($1, pg_catalog.clock_timestamp() + interval '15 minutes')
     RETURNING expires_at`,
    [digestToken(token)],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("Unable to create Staff bootstrap token");
  return row.expires_at;
});
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
