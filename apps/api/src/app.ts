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
  holdSchema029ApplicationGuard,
  holdPaymentMethodTokenRegistryExtensionGuard,
  type DatabasePool,
} from "./database.js";
import {
  ACCOUNT_CONTEXT_VERSION_HEADER,
  accountContextForRequest,
  AUTHORIZATION_EPOCH_HEADER,
  authorizationEpochForRequest,
  CLIENT_ACCOUNT_CONTEXT_HEADER,
  setAccountContextForRequest,
} from "./auth.js";
import { registerAddFundsRoutes } from "./routes-add-funds.js";
import { registerAccountContextRoutes } from "./routes-account-context.js";
import { registerAuthRoutes } from "./routes-auth.js";
import { registerAdminRoutes } from "./routes-admin.js";
import { registerCatalogRoutes } from "./routes-catalog.js";
import { registerCatalogAutomationRoutes } from "./routes-catalog-automation.js";
import { registerCommerceRoutes } from "./routes-commerce.js";
import { registerBillingRoutes } from "./routes-billing.js";
import { registerChargebackRoutes } from "./routes-chargebacks.js";
import { registerClientAccountRoutes } from "./routes-client-accounts.js";
import { registerCustomerHistoryRoutes } from "./routes-customer-history.js";
import { registerOrderRoutes } from "./routes-orders.js";
import { registerManualReceiptOutflowRoutes } from "./routes-manual-receipt-outflows.js";
import { registerNotificationOperationRoutes } from "./routes-notification-operations.js";
import { registerPaymentMethodRoutes } from "./routes-payment-methods.js";
import { registerProviderEventRoutes } from "./routes-provider-events.js";
import { registerRefundRoutes } from "./routes-refunds.js";
import { registerRenewalRoutes } from "./routes-renewals.js";
import { registerServiceRoutes } from "./routes-services.js";
import { registerServiceOperationRoutes } from "./routes-service-operations.js";
import { registerServicePasswordChangeRoutes } from "./routes-service-password-changes.js";
import { registerTicketRoutes } from "./routes-tickets.js";
import { registerSupportOperationRoutes } from "./routes-support-operations.js";
import { registerIdentitySecurityRoutes } from "./routes-identity-security.js";
import { registerCustomerApiRoutes } from "./routes-customer-api.js";
import { registerContentRoutes } from "./routes-content.js";
import { registerNotificationTemplateRoutes } from "./routes-notification-templates.js";

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
          "req.headers.x-oss-presales-token",
          "req.body.password",
          "req.body.currentPassword",
          "req.body.newPassword",
          "req.body.token",
          "req.body.challengeToken",
          "req.body.resetToken",
          "req.body.emailChangeToken",
          "req.body.factorCode",
          "req.body.recoveryCode",
          "req.body.apiKey",
          "req.body.encryptedPayload",
          "req.body.encrypted_payload",
          "req.body.bootstrapToken",
          "res.body.challengeToken",
          "res.body.resetToken",
          "res.body.emailChangeToken",
          "res.body.factorCode",
          "res.body.recoveryCode",
          "res.body.apiKey",
          "res.body.encryptedPayload",
          "res.body.encrypted_payload",
          "err.challengeToken",
          "err.resetToken",
          "err.emailChangeToken",
          "err.factorCode",
          "err.recoveryCode",
          "err.apiKey",
          "err.encryptedPayload",
          "err.encrypted_payload",
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
    if (config.OSS_SCHEMA_ROLLBACK_BRIDGE === "016-to-017") {
      throw new Error(
        "Schema 029 API refuses the legacy 016-to-017 rollback bridge; use the matching historical application binary or migrate forward",
      );
    }
    releaseSchemaRollbackGuard = await holdSchema029ApplicationGuard(pool);
    releaseTokenRegistryGuard = providedPool
      ? null
      : await holdPaymentMethodTokenRegistryExtensionGuard(pool);
    app.addHook("onClose", cleanup);

    await app.register(cookie);
  app.addHook("preValidation", async (request) => {
    const authorization = request.headers.authorization;
    const sessionCookie = request.cookies[config.SESSION_COOKIE_NAME];
    if (authorization && sessionCookie) {
      throw Object.assign(
        new Error("Cookie and customer API key authentication cannot be combined"),
        { statusCode: 400, code: "AMBIGUOUS_AUTHENTICATION" },
      );
    }
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    if (authorization && !pathname.startsWith("/api/v1/customer-api/")) {
      throw Object.assign(
        new Error("Customer API keys are accepted only by /api/v1/customer-api routes"),
        { statusCode: 400, code: "API_KEY_ROUTE_REQUIRED" },
      );
    }
  });
  await app.register(cors, {
    origin: config.WEB_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposedHeaders: [
      CLIENT_ACCOUNT_CONTEXT_HEADER,
      ACCOUNT_CONTEXT_VERSION_HEADER,
      AUTHORIZATION_EPOCH_HEADER,
    ],
  });
  await app.register(rateLimit, {
    max: config.GLOBAL_RATE_LIMIT_MAX,
    timeWindow: "1 minute",
  });

  app.addHook("onSend", async (request, reply) => {
    const context = accountContextForRequest(request);
    if (context && !reply.hasHeader(ACCOUNT_CONTEXT_VERSION_HEADER)) {
      reply.header(
        ACCOUNT_CONTEXT_VERSION_HEADER,
        context.accountContextVersion,
      );
    }
    if (
      context?.clientAccountId &&
      !reply.hasHeader(CLIENT_ACCOUNT_CONTEXT_HEADER)
    ) {
      reply.header(CLIENT_ACCOUNT_CONTEXT_HEADER, context.clientAccountId);
    }
    const authorizationEpoch = authorizationEpochForRequest(request);
    if (authorizationEpoch && !reply.hasHeader(AUTHORIZATION_EPOCH_HEADER)) {
      reply.header(AUTHORIZATION_EPOCH_HEADER, authorizationEpoch);
    }
    reply.header("X-Robots-Tag", "noindex, nofollow, noarchive");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    reply.header("Cache-Control", "no-store");
  });

  app.setErrorHandler((error, request, reply) => {
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
    if (
      typeof error === "object" &&
      error !== null &&
      "currentClientAccountId" in error &&
      (typeof error.currentClientAccountId === "string" ||
        error.currentClientAccountId === null) &&
      "currentAccountContextVersion" in error &&
      typeof error.currentAccountContextVersion === "string"
    ) {
      setAccountContextForRequest(request, {
        clientAccountId: error.currentClientAccountId,
        accountContextVersion: error.currentAccountContextVersion,
      });
    }
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
  await registerIdentitySecurityRoutes(app, pool, config);
  await registerCustomerApiRoutes(app, pool, config);
  await registerAccountContextRoutes(app, pool, config);
  await registerAdminRoutes(app, pool, config);
  await registerClientAccountRoutes(app, pool, config);
  await registerCustomerHistoryRoutes(app, pool, config);
  await registerManualReceiptOutflowRoutes(app, pool, config);
  await registerBillingRoutes(app, pool, config);
  await registerChargebackRoutes(app, pool, config);
  await registerAddFundsRoutes(app, pool, config);
  await registerCatalogRoutes(app, pool, config);
  await registerCatalogAutomationRoutes(app, pool, config);
  await registerCommerceRoutes(app, pool, config);
  await registerOrderRoutes(app, pool, config);
  await registerPaymentMethodRoutes(app, pool, config);
  await registerRefundRoutes(app, pool, config);
  await registerRenewalRoutes(app, pool, config);
  await registerServiceRoutes(app, pool, config);
  await registerServiceOperationRoutes(app, pool, config);
  await registerServicePasswordChangeRoutes(app, pool, config);
  await registerTicketRoutes(app, pool, config);
  await registerSupportOperationRoutes(app, pool, config);
  await registerNotificationOperationRoutes(app, pool, config);
  await registerContentRoutes(app, pool, config);
  await registerNotificationTemplateRoutes(app, pool, config);
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
