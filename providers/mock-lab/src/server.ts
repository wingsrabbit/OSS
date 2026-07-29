// SPDX-License-Identifier: Apache-2.0

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { z } from "zod";

const config = z
  .object({
    PROVIDER_DATABASE_URL: z.string().min(1),
    MOCK_PAYMENT_PROVIDER_TOKEN: z.string().min(32).optional(),
    MOCK_PROVISIONING_PROVIDER_TOKEN: z.string().min(32).optional(),
    MOCK_MAIL_PROVIDER_TOKEN: z.string().min(32).optional(),
    LAB_MAILBOX_TOKEN: z.string().min(32).optional(),
    MOCK_PAYMENT_WEBHOOK_SECRET: z.string().min(32).optional(),
    MOCK_PROVISIONING_WEBHOOK_SECRET: z.string().min(32).optional(),
    CORE_CALLBACK_URL: z.url(),
    PROVIDER_HOST: z.string().default("0.0.0.0"),
    PROVIDER_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  })
  .parse(process.env);

const paymentCreateSchema = z.object({
  operationId: z.uuid(),
  paymentAttemptId: z.uuid(),
  amountMinor: z.string().regex(/^[1-9]\d*$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  scenario: z.enum([
    "success",
    "failed",
    "cancelled",
    "timeout_success",
    "duplicate_out_of_order",
    "definitive_reject",
  ]),
});

const resourceCreateSchema = z.object({
  operationId: z.uuid(),
  serviceId: z.uuid(),
  scenario: z.enum(["success", "failed", "timeout_existing"]),
});

const mailCreateSchema = z.object({
  operationId: z.uuid(),
  recipient: z.email(),
  template: z.string().min(1).max(120),
  locale: z.enum(["en", "zh-CN"]),
  subject: z.string().min(1).max(240),
  body: z.string().min(1).max(20_000),
  sensitive: z.boolean().default(false),
});

const mailboxQuerySchema = z.object({
  recipient: z.email(),
});

function requestFingerprint(scope: string, body: unknown): string {
  return createHash("sha256")
    .update(scope)
    .update("\0")
    .update(JSON.stringify(body))
    .digest("hex");
}

const pool = new pg.Pool({
  connectionString: config.PROVIDER_DATABASE_URL,
  max: 10,
  statement_timeout: 15_000,
  application_name: "opensales-mock-lab",
});

await pool.query(`
  CREATE EXTENSION IF NOT EXISTS citext;
  CREATE TABLE IF NOT EXISTS mock_payment_operations (
    operation_id uuid PRIMARY KEY,
    payment_attempt_id uuid NOT NULL,
    external_payment_id text NOT NULL UNIQUE,
    amount_minor bigint NOT NULL,
    currency text NOT NULL,
    scenario text NOT NULL,
    status text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    create_calls integer NOT NULL DEFAULT 1,
    request_fingerprint text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mock_resource_operations (
    operation_id uuid PRIMARY KEY,
    service_id uuid NOT NULL,
    external_resource_id text UNIQUE,
    scenario text NOT NULL,
    status text NOT NULL,
    ready_at timestamptz,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    create_calls integer NOT NULL DEFAULT 1,
    request_fingerprint text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mock_mail_messages (
    operation_id uuid PRIMARY KEY,
    recipient citext NOT NULL,
    template text NOT NULL,
    locale text NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    sensitive boolean NOT NULL,
    status text NOT NULL DEFAULT 'delivered',
    delivered_at timestamptz NOT NULL DEFAULT now(),
    delivery_calls integer NOT NULL DEFAULT 1,
    request_fingerprint text NOT NULL
  );
  ALTER TABLE mock_payment_operations
    ADD COLUMN IF NOT EXISTS request_fingerprint text;
  UPDATE mock_payment_operations
  SET request_fingerprint = 'legacy:' || operation_id::text
  WHERE request_fingerprint IS NULL;
  ALTER TABLE mock_payment_operations
    ALTER COLUMN request_fingerprint SET NOT NULL;
  ALTER TABLE mock_resource_operations
    ADD COLUMN IF NOT EXISTS request_fingerprint text;
  UPDATE mock_resource_operations
  SET request_fingerprint = 'legacy:' || operation_id::text
  WHERE request_fingerprint IS NULL;
  ALTER TABLE mock_resource_operations
    ALTER COLUMN request_fingerprint SET NOT NULL;
  ALTER TABLE mock_mail_messages
    ADD COLUMN IF NOT EXISTS request_fingerprint text;
  UPDATE mock_mail_messages
  SET request_fingerprint = 'legacy:' || operation_id::text
  WHERE request_fingerprint IS NULL;
  ALTER TABLE mock_mail_messages
    ALTER COLUMN request_fingerprint SET NOT NULL;
`);

const app = Fastify({
  logger: {
    level: "info",
    redact: {
      paths: ["req.headers.authorization", "req.headers.x-oss-signature"],
      censor: "[REDACTED]",
    },
  },
  bodyLimit: 128 * 1024,
});

app.addHook("onRequest", async (request, reply) => {
  if (!request.url.startsWith("/v1/")) return;
  const expectedToken =
    request.url.startsWith("/v1/payments")
      ? config.MOCK_PAYMENT_PROVIDER_TOKEN
      : request.url.startsWith("/v1/resources")
        ? config.MOCK_PROVISIONING_PROVIDER_TOKEN
        : request.url.startsWith("/v1/mailbox")
          ? config.LAB_MAILBOX_TOKEN
          : request.url === "/v1/mail"
            ? config.MOCK_MAIL_PROVIDER_TOKEN
            : undefined;
  if (!expectedToken) return reply.code(404).send({ error: "capability is not enabled" });
  const authorization = request.headers.authorization;
  const expected = Buffer.from(`Bearer ${expectedToken}`, "utf8");
  const received = Buffer.from(authorization ?? "", "utf8");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return reply.code(401).send({ error: "invalid provider credential" });
  }
});

app.addHook("onSend", async (_request, reply) => {
  reply.header("X-Robots-Tag", "noindex, nofollow, noarchive");
  reply.header("Cache-Control", "no-store");
  reply.header("X-Content-Type-Options", "nosniff");
});

function signature(timestamp: string, body: unknown, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${JSON.stringify(body)}`, "utf8")
    .digest("hex");
}

async function callback(path: string, body: unknown, secret: string): Promise<void> {
  const timestamp = Date.now().toString();
  const response = await fetch(new URL(path, config.CORE_CALLBACK_URL), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-OSS-Timestamp": timestamp,
      "X-OSS-Signature": signature(timestamp, body, secret),
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Core callback failed with ${response.status}`);
}

function scheduleCallback(path: string, body: unknown, delayMs: number, secret: string): void {
  setTimeout(() => {
    void callback(path, body, secret).catch((error: unknown) => {
      app.log.error(
        { error: error instanceof Error ? error.message : "unknown" },
        "mock callback failed",
      );
    });
  }, delayMs);
}

app.get("/", async () => ({
  name: "OpenSales System Provider Lab",
  warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
}));
app.get("/health/live", async () => ({ status: "ok" }));
app.get("/health/ready", async (_request, reply) => {
  try {
    await pool.query("SELECT 1");
    return { status: "ready" };
  } catch {
    return reply.code(503).send({ status: "not_ready" });
  }
});

app.post("/v1/payments", async (request, reply) => {
  const body = paymentCreateSchema.parse(request.body);
  const callbackSecret = config.MOCK_PAYMENT_WEBHOOK_SECRET;
  if (!callbackSecret) return reply.code(503).send({ error: "payment callback is not configured" });
  if (request.headers["idempotency-key"] !== body.operationId) {
    return reply.code(400).send({ error: "stable idempotency key is required" });
  }
  if (body.scenario === "definitive_reject") {
    return reply.code(400).send({ error: "synthetic definitive payment rejection" });
  }
  const externalPaymentId = `mock-pay-${body.operationId}`;
  const fingerprint = requestFingerprint("payment.create:v1", body);
  const status =
    body.scenario === "failed"
      ? "failed"
      : body.scenario === "cancelled"
        ? "cancelled"
        : "succeeded";
  const inserted = await pool.query<{
    external_payment_id: string;
    status: "succeeded" | "failed" | "cancelled";
    occurred_at: Date;
  }>(
    `INSERT INTO mock_payment_operations(
       operation_id, payment_attempt_id, external_payment_id,
       amount_minor, currency, scenario, status
       , request_fingerprint
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (operation_id) DO UPDATE
       SET create_calls = mock_payment_operations.create_calls + 1
       WHERE mock_payment_operations.request_fingerprint = EXCLUDED.request_fingerprint
     RETURNING external_payment_id, status, occurred_at`,
    [
      body.operationId,
      body.paymentAttemptId,
      externalPaymentId,
      body.amountMinor,
      body.currency,
      body.scenario,
      status,
      fingerprint,
    ],
  );
  const operation = inserted.rows[0];
  if (!operation) {
    return reply.code(409).send({ error: "idempotency key was reused with a different payment" });
  }

  const event = {
    eventId: `payment:${body.operationId}:${operation.status}`,
    paymentAttemptId: body.paymentAttemptId,
    externalPaymentId: operation.external_payment_id,
    status: operation.status,
    amountMinor: body.amountMinor,
    currency: body.currency,
    occurredAt: operation.occurred_at.toISOString(),
  };
  if (body.scenario === "duplicate_out_of_order") {
    scheduleCallback("/api/v1/provider-events/payment", event, 20, callbackSecret);
    scheduleCallback(
      "/api/v1/provider-events/payment",
      { ...event, eventId: `${event.eventId}:late-failed`, status: "failed" },
      40,
      callbackSecret,
    );
    scheduleCallback(
      "/api/v1/provider-events/payment",
      { ...event, eventId: `${event.eventId}:duplicate` },
      60,
      callbackSecret,
    );
  } else {
    scheduleCallback(
      "/api/v1/provider-events/payment",
      event,
      body.scenario === "timeout_success" ? 3_500 : 20,
      callbackSecret,
    );
  }
  if (body.scenario === "timeout_success") {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return reply.code(202).send({
    operationId: body.operationId,
    status: operation.status,
    replayed: false,
  });
});

app.get("/v1/payments/:operationId", async (request, reply) => {
  const params = z.object({ operationId: z.uuid() }).parse(request.params);
  const result = await pool.query<{
    external_payment_id: string;
    status: "succeeded" | "failed" | "cancelled";
    amount_minor: string;
    currency: string;
    occurred_at: Date;
  }>(
    `SELECT external_payment_id, status, amount_minor, currency, occurred_at
     FROM mock_payment_operations
     WHERE operation_id = $1`,
    [params.operationId],
  );
  const row = result.rows[0];
  if (!row) return reply.code(404).send({ error: "operation not found" });
  return {
    externalPaymentId: row.external_payment_id,
    status: row.status,
    amountMinor: row.amount_minor,
    currency: row.currency,
    occurredAt: row.occurred_at.toISOString(),
  };
});

app.post("/v1/resources", async (request, reply) => {
  const body = resourceCreateSchema.parse(request.body);
  const callbackSecret = config.MOCK_PROVISIONING_WEBHOOK_SECRET;
  if (!callbackSecret) {
    return reply.code(503).send({ error: "provisioning callback is not configured" });
  }
  if (request.headers["idempotency-key"] !== body.operationId) {
    return reply.code(400).send({ error: "stable idempotency key is required" });
  }
  const externalResourceId = `mock-resource-${body.operationId}`;
  const fingerprint = requestFingerprint("resource.create:v1", body);
  const status = body.scenario === "failed" ? "failed" : "succeeded";
  const readyAt = status === "succeeded" ? new Date() : null;
  const inserted = await pool.query<{
    external_resource_id: string | null;
    status: "succeeded" | "failed";
    ready_at: Date | null;
    occurred_at: Date;
  }>(
    `INSERT INTO mock_resource_operations(
       operation_id, service_id, external_resource_id, scenario, status, ready_at
       , request_fingerprint
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (operation_id) DO UPDATE
       SET create_calls = mock_resource_operations.create_calls + 1
       WHERE mock_resource_operations.request_fingerprint = EXCLUDED.request_fingerprint
     RETURNING external_resource_id, status, ready_at, occurred_at`,
    [
      body.operationId,
      body.serviceId,
      externalResourceId,
      body.scenario,
      status,
      readyAt,
      fingerprint,
    ],
  );
  const operation = inserted.rows[0];
  if (!operation) {
    return reply.code(409).send({ error: "idempotency key was reused with a different resource" });
  }
  const event = {
    eventId: `resource:${body.operationId}:${operation.status}`,
    providerOperationId: body.operationId,
    status: operation.status,
    ...(operation.external_resource_id
      ? { externalResourceId: operation.external_resource_id }
      : {}),
    ...(operation.ready_at ? { readyAt: operation.ready_at.toISOString() } : {}),
    occurredAt: operation.occurred_at.toISOString(),
  };
  scheduleCallback(
    "/api/v1/provider-events/provisioning",
    event,
    body.scenario === "timeout_existing" ? 3_500 : 20,
    callbackSecret,
  );
  if (body.scenario === "timeout_existing") {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return reply.code(202).send({ operationId: body.operationId, status: operation.status });
});

app.get("/v1/resources/:operationId", async (request, reply) => {
  const params = z.object({ operationId: z.uuid() }).parse(request.params);
  const result = await pool.query<{
    external_resource_id: string | null;
    status: "succeeded" | "failed";
    ready_at: Date | null;
    occurred_at: Date;
  }>(
    `SELECT external_resource_id, status, ready_at, occurred_at
     FROM mock_resource_operations
     WHERE operation_id = $1`,
    [params.operationId],
  );
  const row = result.rows[0];
  if (!row) return reply.code(404).send({ error: "operation not found" });
  return {
    status: row.status,
    ...(row.external_resource_id ? { externalResourceId: row.external_resource_id } : {}),
    ...(row.ready_at ? { readyAt: row.ready_at.toISOString() } : {}),
    occurredAt: row.occurred_at.toISOString(),
  };
});

app.post("/v1/mail", async (request, reply) => {
  const body = mailCreateSchema.parse(request.body);
  if (request.headers["idempotency-key"] !== body.operationId) {
    return reply.code(400).send({ error: "stable idempotency key is required" });
  }
  const fingerprint = requestFingerprint("mail.send:v1", body);
  const result = await pool.query<{ status: string; delivered_at: Date }>(
    `INSERT INTO mock_mail_messages(
       operation_id, recipient, template, locale, subject, body, sensitive
       , request_fingerprint
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (operation_id) DO UPDATE
       SET delivery_calls = mock_mail_messages.delivery_calls + 1
       WHERE mock_mail_messages.request_fingerprint = EXCLUDED.request_fingerprint
     RETURNING status, delivered_at`,
    [
      body.operationId,
      body.recipient,
      body.template,
      body.locale,
      body.subject,
      body.body,
      body.sensitive,
      fingerprint,
    ],
  );
  if (!result.rows[0]) {
    return reply.code(409).send({ error: "idempotency key was reused with a different message" });
  }
  return reply.code(202).send({
    operationId: body.operationId,
    status: result.rows[0]?.status ?? "delivered",
    deliveredAt: result.rows[0]?.delivered_at.toISOString(),
  });
});

app.post("/v1/mailbox/query", async (request) => {
  const query = mailboxQuerySchema.parse(request.body);
  const result = await pool.query<{
    operation_id: string;
    template: string;
    locale: string;
    subject: string;
    body: string;
    status: string;
    delivered_at: Date;
  }>(
    `SELECT operation_id, template, locale, subject, body, status, delivered_at
     FROM mock_mail_messages
     WHERE recipient = $1
     ORDER BY delivered_at DESC
     LIMIT 20`,
    [query.recipient],
  );
  return result.rows.map((message) => ({
    id: message.operation_id,
    template: message.template,
    locale: message.locale,
    subject: message.subject,
    body: message.body,
    status: message.status,
    deliveredAt: message.delivered_at.toISOString(),
  }));
});

await app.listen({ host: config.PROVIDER_HOST, port: config.PROVIDER_PORT });
