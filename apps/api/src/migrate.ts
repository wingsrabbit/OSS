// SPDX-License-Identifier: AGPL-3.0-or-later

import { loadConfig } from "./config.js";
import {
  bootstrapPaymentMethodTokenKeyrings,
  configureRuntimeDatabaseRoles,
  createPoolForConnection,
  runMigrations,
} from "./database.js";

const config = loadConfig();
if (
  !config.MIGRATION_DATABASE_URL ||
  !config.DATABASE_API_ROLE_PASSWORD ||
  !config.DATABASE_WORKER_ROLE_PASSWORD
) {
  throw new Error(
    "Migration requires MIGRATION_DATABASE_URL plus separate API and Worker database role passwords",
  );
}
const pool = createPoolForConnection(
  config.MIGRATION_DATABASE_URL,
  "opensales-migration",
);
await runMigrations(pool);
await configureRuntimeDatabaseRoles(pool, [
  { name: "oss_api", password: config.DATABASE_API_ROLE_PASSWORD },
  { name: "oss_worker", password: config.DATABASE_WORKER_ROLE_PASSWORD },
]);
await bootstrapPaymentMethodTokenKeyrings(pool, config);
await pool.end();
console.log("Database migrations applied.");
