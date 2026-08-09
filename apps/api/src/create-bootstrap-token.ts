// SPDX-License-Identifier: AGPL-3.0-or-later

import { open } from "node:fs/promises";
import { createOpaqueToken, digestToken } from "./auth.js";
import { loadConfig } from "./config.js";
import {
  createPool,
  transaction,
} from "./database.js";

const config = loadConfig();
const pool = createPool(config);
const outputFile = process.env.BOOTSTRAP_TOKEN_OUTPUT_FILE;
if (!outputFile) {
  await pool.end();
  throw new Error("BOOTSTRAP_TOKEN_OUTPUT_FILE is required");
}
const token = createOpaqueToken();
const expiresAt = new Date(Date.now() + 15 * 60_000);
await transaction(pool, async (client) => {
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
  await client.query(
    `INSERT INTO staff_bootstrap_tokens(token_digest, expires_at)
     VALUES ($1, $2)`,
    [digestToken(token), expiresAt],
  );
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
