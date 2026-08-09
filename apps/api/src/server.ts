// SPDX-License-Identifier: AGPL-3.0-or-later

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import {
  assertPaymentMethodTokenKeyringsCompatible,
  assertSchemaCompatible,
} from "./database.js";

const config = loadConfig();
let app: Awaited<ReturnType<typeof buildApp>>["app"] | null = null;
try {
  const built = await buildApp(config);
  app = built.app;
  const { pool } = built;
  const schemaPreflight = await assertSchemaCompatible(pool);
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
