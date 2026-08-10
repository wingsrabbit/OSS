// SPDX-License-Identifier: AGPL-3.0-or-later

import { buildApp } from "./app.js";
import { assertRuntimeDatabaseRoleSafe } from "@opensales/core";
import { loadConfig } from "./config.js";
import {
  assertPaymentMethodTokenKeyringsCompatible,
  assertSchemaCompatible,
} from "./database.js";

const config = loadConfig();
if (!config.DATABASE_RUNTIME_ROLE) {
  throw new Error("API requires DATABASE_RUNTIME_ROLE for database privilege isolation");
}
let app: Awaited<ReturnType<typeof buildApp>>["app"] | null = null;
try {
  const built = await buildApp(config);
  app = built.app;
  const { pool } = built;
  await assertRuntimeDatabaseRoleSafe(
    { query: async (text, values) => pool.query(text, values) },
    config.DATABASE_RUNTIME_ROLE,
  );
  const schemaPreflight = await assertSchemaCompatible(pool, {
    enable017RollbackBridge: config.OSS_SCHEMA_ROLLBACK_BRIDGE === "016-to-017",
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
  if (app) await app.close().catch(() => undefined);
  throw error;
}
