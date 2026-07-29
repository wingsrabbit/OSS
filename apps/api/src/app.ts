// SPDX-License-Identifier: AGPL-3.0-or-later

import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { LAB_BANNER } from "@opensales/core";
import Fastify from "fastify";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import { createPool, type DatabasePool } from "./database.js";
import { registerAuthRoutes } from "./routes-auth.js";
import { registerAdminRoutes } from "./routes-admin.js";
import { registerCatalogRoutes } from "./routes-catalog.js";
import { registerOrderRoutes } from "./routes-orders.js";
import { registerProviderEventRoutes } from "./routes-provider-events.js";

export async function buildApp(
  config: Config,
  providedPool?: DatabasePool,
): Promise<{ app: ReturnType<typeof Fastify>; pool: DatabasePool }> {
  const app = Fastify({
    logger: {
      level: config.OSS_ENV === "test" ? "silent" : "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers.x-oss-signature",
          "req.body.password",
          "req.body.token",
          "req.body.bootstrapToken",
          "res.headers.set-cookie",
        ],
        censor: "[REDACTED]",
      },
    },
    trustProxy: config.OSS_ENV === "laboratory" ? 1 : false,
    bodyLimit: 256 * 1024,
  });
  const pool = providedPool ?? createPool(config);

  await app.register(cookie);
  await app.register(cors, {
    origin: config.WEB_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Robots-Tag", "noindex, nofollow, noarchive");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    reply.header("Cache-Control", "no-store");
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "Invalid request",
        details: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    if (statusCode >= 500) {
      app.log.error({ err: error }, "request failed");
    }
    return reply.code(statusCode).send({
      error:
        statusCode >= 500
          ? "Internal server error"
          : error instanceof Error
            ? error.message
            : "Request failed",
      ...(code ? { code } : {}),
    });
  });

  app.get("/", async () => ({
    name: "OpenSales System API",
    warning: LAB_BANNER,
    productionReady: false,
  }));
  app.get("/robots.txt", async (_request, reply) => {
    reply.type("text/plain");
    return "User-agent: *\nDisallow: /\n";
  });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  await registerAuthRoutes(app, pool, config);
  await registerAdminRoutes(app, pool, config);
  await registerCatalogRoutes(app, pool);
  await registerOrderRoutes(app, pool, config);
  await registerProviderEventRoutes(app, pool, config);

  app.addHook("onClose", async () => {
    if (!providedPool) await pool.end();
  });

  return { app, pool };
}
