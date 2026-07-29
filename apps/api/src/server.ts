// SPDX-License-Identifier: AGPL-3.0-or-later

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { runMigrations } from "./database.js";

const config = loadConfig();
const { app, pool } = await buildApp(config);
await runMigrations(pool);
await app.listen({ host: config.API_HOST, port: config.API_PORT });
