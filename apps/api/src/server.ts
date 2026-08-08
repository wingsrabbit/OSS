// SPDX-License-Identifier: AGPL-3.0-or-later

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { assertSchemaCompatible } from "./database.js";

const config = loadConfig();
const { app, pool } = await buildApp(config);
const schemaPreflight = await assertSchemaCompatible(pool, {
  enable015RollbackBridge: config.OSS_SCHEMA_ROLLBACK_BRIDGE === "014-to-015",
});
app.log.info(
  {
    installedSchemaVersion: schemaPreflight.installedSchemaVersion,
    schemaMode: schemaPreflight.mode,
  },
  "schema startup preflight passed",
);
await app.listen({ host: config.API_HOST, port: config.API_PORT });
