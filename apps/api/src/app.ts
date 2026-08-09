// SPDX-License-Identifier: AGPL-3.0-or-later

import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { LAB_BANNER } from "@opensales/core";
import Fastify from "fastify";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import {
  assertPaymentMethodTokenKeyringsCompatible,
  createPool,
  holdSchema016RollbackBridgeGuard,
  holdSchema017ApplicationGuard,
  holdPaymentMethodTokenRegistryExtensionGuard,
  type DatabasePool,
} from "./database.js";
import { registerAddFundsRoutes } from "./routes-add-funds.js";
import { registerAuthRoutes } from "./routes-auth.js";
import { registerAdminRoutes } from "./routes-admin.js";
import { registerCatalogRoutes } from "./routes-catalog.js";
import { registerBillingRoutes } from "./routes-billing.js";
import { registerChargebackRoutes } from "./routes-chargebacks.js";
import { registerOrderRoutes } from "./routes-orders.js";
import { registerManualReceiptOutflowRoutes } from "./routes-manual-receipt-outflows.js";
import { registerPaymentMethodRoutes } from "./routes-payment-methods.js";
import { registerProviderEventRoutes } from "./routes-provider-events.js";
import { registerRefundRoutes } from "./routes-refunds.js";
import { registerRenewalRoutes } from "./routes-renewals.js";
import { registerServiceRoutes } from "./routes-services.js";

export async function buildApp(
  config: Config,
  providedPool?: DatabasePool,
): Promise<{ app: ReturnType<typeof Fastify>; pool: DatabasePool }> {
  const app = Fastify({
    logger: {
      level:
        config.OSS_LOG_LEVEL ?? (config.OSS_ENV === "test" ? "silent" : "info"),
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
  let releaseSchemaRollbackGuard: (() => Promise<void>) | null = null;
  let releaseTokenRegistryGuard: (() => Promise<void>) | null = null;
  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    const errors: unknown[] = [];
    const releases = [releaseTokenRegistryGuard, releaseSchemaRollbackGuard].filter(
      (release): release is () => Promise<void> => release !== null,
    );
    const releaseResults = await Promise.allSettled(releases.map((release) => release()));
    for (const result of releaseResults) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    if (!providedPool) {
      try {
        await pool.end();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "OpenSales API resource cleanup failed");
    }
  };

  try {
    releaseSchemaRollbackGuard = config.OSS_SCHEMA_ROLLBACK_BRIDGE === "016-to-017"
      ? await holdSchema016RollbackBridgeGuard(pool)
      : await holdSchema017ApplicationGuard(pool);
    releaseTokenRegistryGuard = providedPool
      ? null
      : await holdPaymentMethodTokenRegistryExtensionGuard(pool);
    app.addHook("onClose", cleanup);

    await app.register(cookie);
  await app.register(cors, {
    origin: config.WEB_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(rateLimit, {
    max: config.GLOBAL_RATE_LIMIT_MAX,
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
      await assertPaymentMethodTokenKeyringsCompatible(pool, config);
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  await registerAuthRoutes(app, pool, config);
  await registerAdminRoutes(app, pool, config);
  await registerManualReceiptOutflowRoutes(app, pool, config);
  await registerBillingRoutes(app, pool, config);
  await registerChargebackRoutes(app, pool, config);
  await registerAddFundsRoutes(app, pool, config);
  await registerCatalogRoutes(app, pool);
  await registerOrderRoutes(app, pool, config);
  await registerPaymentMethodRoutes(app, pool, config);
  await registerRefundRoutes(app, pool, config);
  await registerRenewalRoutes(app, pool, config);
  await registerServiceRoutes(app, pool, config);
  await registerProviderEventRoutes(app, pool, config);

    return { app, pool };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "OpenSales API initialization and cleanup failed",
      );
    }
    throw error;
  }
}
