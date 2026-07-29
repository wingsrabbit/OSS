// SPDX-License-Identifier: AGPL-3.0-or-later

import { loadConfig } from "./config.js";
import { createPool, runMigrations } from "./database.js";

const pool = createPool(loadConfig());
await runMigrations(pool);
await pool.end();
console.log("Database migrations applied.");
