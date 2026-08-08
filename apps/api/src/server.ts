// SPDX-License-Identifier: AGPL-3.0-or-later

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import {
  assertPaymentMethodTokenKeyringsCompatible,
  assertSchemaCompatible,
} from "./database.js";

const config = loadConfig();
const { app, pool } = await buildApp(config);
try {
  const schemaPreflight = await assertSchemaCompatible(pool, {
    enable016RollbackBridge: config.OSS_SCHEMA_ROLLBACK_BRIDGE === "015-to-016",
  });
  app.log.info(
    {
      installedSchemaVersion: schemaPreflight.installedSchemaVersion,
      schemaMode: schemaPreflight.mode,
    },
    "schema startup preflight passed",
  );
  await assertPaymentMethodTokenKeyringsCompatible(pool, config);
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (error) {
  await app.close().catch(() => undefined);
  throw error;
}
