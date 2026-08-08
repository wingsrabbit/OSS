// SPDX-License-Identifier: AGPL-3.0-or-later

import { loadConfig } from "./config.js";
import {
  bootstrapPaymentMethodTokenKeyrings,
  createPool,
  runMigrations,
} from "./database.js";

const config = loadConfig();
const pool = createPool(config);
await runMigrations(pool);
await bootstrapPaymentMethodTokenKeyrings(pool, config);
await pool.end();
console.log("Database migrations applied.");
