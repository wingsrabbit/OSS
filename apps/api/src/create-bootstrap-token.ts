// SPDX-License-Identifier: AGPL-3.0-or-later

import { createOpaqueToken, digestToken } from "./auth.js";
import { loadConfig } from "./config.js";
import { createPool, runMigrations } from "./database.js";

const config = loadConfig();
const pool = createPool(config);
await runMigrations(pool);
const token = createOpaqueToken();
const expiresAt = new Date(Date.now() + 15 * 60_000);
await pool.query(
  `INSERT INTO staff_bootstrap_tokens(token_digest, expires_at)
   VALUES ($1, $2)`,
  [digestToken(token), expiresAt],
);
await pool.end();
console.log(`Single-use staff bootstrap token (expires ${expiresAt.toISOString()}):`);
console.log(token);
