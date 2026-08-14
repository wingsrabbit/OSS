// SPDX-License-Identifier: Apache-2.0

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { z } from "zod";
import { registerProviderPlatformRoutes } from "./provider-platform.js";

const config = z
  .object({
    PROVIDER_DATABASE_URL: z.string().min(1),
    MOCK_PAYMENT_PROVIDER_TOKEN: z.string().min(32).optional(),
    MOCK_PROVISIONING_PROVIDER_TOKEN: z.string().min(32).optional(),
    MOCK_MAIL_PROVIDER_TOKEN: z.string().min(32).optional(),
    MOCK_PROVIDER_PLATFORM_TOKEN: z.string().min(32).optional(),
    MOCK_PROVIDER_PUBLIC_BASE_URL: z.url().optional(),
    LAB_MAILBOX_TOKEN: z.string().min(32).optional(),
    MOCK_PAYMENT_WEBHOOK_SECRET: z.string().min(32).optional(),
    MOCK_PROVISIONING_WEBHOOK_SECRET: z.string().min(32).optional(),
    CORE_CALLBACK_URL: z.url(),
    PROVIDER_HOST: z.string().default("0.0.0.0"),
    PROVIDER_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  })
  .parse(process.env);

const paymentCreateSchema = z
  .object({
    operationId: z.uuid(),
    paymentAttemptId: z.uuid(),
    callbackCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    customerReference: z.uuid().optional(),
    amountMinor: z.string().regex(/^[1-9]\d*$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    scenario: z.enum([
      "success",
      "failed",
      "cancelled",
      "timeout_success",
      "duplicate_out_of_order",
      "definitive_reject",
      "delayed_definitive_reject",
      "reconcile_manual",
      "success_then_reject",
      "partial_then_reject",
      "partial_then_timeout",
      "partial",
      "wrong_currency",
      "expired_late",
      "late_success",
      "automatic",
    ]),
    savePaymentMethod: z.boolean().default(false),
    paymentMethodCode: z.enum(["card", "alipay", "usdt"]).optional(),
    providerPaymentMethodToken: z.string().min(16).max(500).optional(),
  })
  .superRefine((body, context) => {
    if (body.scenario === "automatic" && !body.providerPaymentMethodToken) {
      context.addIssue({ code: "custom", path: ["providerPaymentMethodToken"], message: "automatic payment requires a saved Provider token" });
    }
    if ((body.scenario === "automatic" || body.savePaymentMethod) && !body.customerReference) {
      context.addIssue({ code: "custom", path: ["customerReference"], message: "saved payment methods require an opaque customer reference" });
    }
    if (body.scenario !== "automatic" && body.providerPaymentMethodToken) {
      context.addIssue({ code: "custom", path: ["providerPaymentMethodToken"], message: "saved Provider token is only accepted for automatic payment" });
    }
    if (body.savePaymentMethod && (!body.paymentMethodCode || body.paymentMethodCode === "usdt")) {
      context.addIssue({ code: "custom", path: ["paymentMethodCode"], message: "this payment method cannot be saved" });
    }
    if (body.savePaymentMethod && body.providerPaymentMethodToken) {
      context.addIssue({ code: "custom", path: ["savePaymentMethod"], message: "automatic payments cannot save another method" });
    }
  });

const refundCreateSchema = z.object({
  operationId: z.uuid(),
  refundId: z.uuid(),
  callbackCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  originalExternalPaymentId: z.string().min(1).max(160),
  amountMinor: z.string().regex(/^[1-9]\d*$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  scenario: z.enum(["success", "failed", "timeout_success", "duplicate_out_of_order"]),
});

const chargebackCreateSchema = z.object({
  requestId: z.uuid(),
  scenario: z.enum([
    "success",
    "duplicate",
    "wrong_amount",
    "wrong_currency",
    "wrong_external_payment",
  ]),
});

const resourceCreateSchema = z.object({
  operationId: z.uuid(),
  serviceId: z.uuid(),
  callbackCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  scenario: z.enum(["success", "failed", "timeout_existing"]),
});

const resourceActionSchema = z.object({
  operationId: z.uuid(),
  serviceId: z.uuid(),
  externalResourceId: z.string().min(1).max(200),
  callbackCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  action: z.enum(["suspend", "resume", "terminate"]),
  scenario: z.enum(["success", "failed", "timeout_success", "duplicate_out_of_order"]),
});

const mailCreateSchema = z.object({
  operationId: z.uuid(),
  recipient: z.email(),
  template: z.string().min(1).max(120),
  locale: z.enum(["en", "zh-CN"]),
  subject: z.string().min(1).max(240),
  body: z.string().min(1).max(20_000),
  sensitive: z.boolean().default(false),
  scenario: z.enum(["delivered", "bounced", "failed"]).optional(),
});

const mailOperationParamsSchema = z.object({
  operationId: z.uuid(),
});

const mailDeliveryStatusSchema = z.enum(["delivered", "bounced", "failed"]);

const mailboxQuerySchema = z.object({
  recipient: z.email(),
  operationId: z.uuid().optional(),
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

const inFlightMailWrites = new Map<string, Promise<void>>();
const incomingMailRequests = new Map<string, Promise<void>>();
const incomingMailRequestReleases = new WeakMap<object, () => void>();

function registerIncomingMailRequest(operationId: string): () => void {
  const predecessor = incomingMailRequests.get(operationId) ?? Promise.resolve();
  let resolveCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  const tail = predecessor.then(() => current);
  incomingMailRequests.set(operationId, tail);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    resolveCurrent();
    void tail.finally(() => {
      if (incomingMailRequests.get(operationId) === tail) {
        incomingMailRequests.delete(operationId);
      }
    });
  };
}

async function waitForIncomingMailRequest(operationId: string): Promise<void> {
  while (true) {
    const pending = incomingMailRequests.get(operationId);
    if (!pending) return;
    await pending;
    if (incomingMailRequests.get(operationId) === pending) return;
  }
}

async function serializeMailWrite<T>(operationId: string, work: () => Promise<T>): Promise<T> {
  const predecessor = inFlightMailWrites.get(operationId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = predecessor.then(() => current);
  inFlightMailWrites.set(operationId, tail);
  await predecessor;
  try {
    return await work();
  } finally {
    release();
    if (inFlightMailWrites.get(operationId) === tail) {
      inFlightMailWrites.delete(operationId);
    }
  }
}

async function waitForInFlightMailWrite(operationId: string): Promise<void> {
  while (true) {
    const pending = inFlightMailWrites.get(operationId);
    if (!pending) return;
    await pending;
    if (inFlightMailWrites.get(operationId) === pending) return;
  }
}

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
    callback_capability text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    create_calls integer NOT NULL DEFAULT 1,
    query_calls integer NOT NULL DEFAULT 0,
    request_fingerprint text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mock_saved_payment_methods (
    provider_token text PRIMARY KEY,
    source_payment_attempt_id uuid NOT NULL UNIQUE,
    customer_reference uuid NOT NULL,
    payment_method_code text NOT NULL CHECK (payment_method_code IN ('card', 'alipay')),
    instrument_type text NOT NULL,
    brand text NOT NULL,
    last_four text NOT NULL CHECK (last_four ~ '^[0-9]{4}$'),
    expiry_month integer NOT NULL CHECK (expiry_month BETWEEN 1 AND 12),
    expiry_year integer NOT NULL CHECK (expiry_year BETWEEN 2020 AND 2200),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalid')),
    automatic_scenario text NOT NULL DEFAULT 'success'
      CHECK (automatic_scenario IN ('success', 'failed', 'requires_action', 'timeout_success')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS mock_refund_operations (
    operation_id uuid PRIMARY KEY,
    refund_id uuid NOT NULL UNIQUE,
    original_external_payment_id text NOT NULL
      REFERENCES mock_payment_operations(external_payment_id),
    external_refund_id text NOT NULL UNIQUE,
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    scenario text NOT NULL CHECK (
      scenario IN ('success', 'failed', 'timeout_success', 'duplicate_out_of_order')
    ),
    status text NOT NULL CHECK (status IN ('succeeded', 'failed', 'unknown')),
    callback_capability text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    create_calls integer NOT NULL DEFAULT 1 CHECK (create_calls > 0),
    request_fingerprint text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mock_chargeback_operations (
    request_id uuid PRIMARY KEY,
    original_operation_id uuid NOT NULL
      REFERENCES mock_payment_operations(operation_id),
    external_chargeback_id text NOT NULL UNIQUE,
    scenario text NOT NULL CHECK (
      scenario IN (
        'success', 'duplicate', 'wrong_amount', 'wrong_currency',
        'wrong_external_payment'
      )
    ),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    create_calls integer NOT NULL DEFAULT 1 CHECK (create_calls > 0),
    request_fingerprint text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mock_resource_operations (
    operation_id uuid PRIMARY KEY,
    service_id uuid NOT NULL,
    external_resource_id text UNIQUE,
    callback_capability text NOT NULL,
    scenario text NOT NULL,
    status text NOT NULL,
    ready_at timestamptz,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    create_calls integer NOT NULL DEFAULT 1,
    request_fingerprint text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mock_resource_action_operations (
    operation_id uuid PRIMARY KEY,
    service_id uuid NOT NULL,
    external_resource_id text NOT NULL,
    callback_capability text NOT NULL,
    action text NOT NULL CHECK (action IN ('suspend', 'resume', 'terminate')),
    scenario text NOT NULL CHECK (
      scenario IN ('success', 'failed', 'timeout_success', 'duplicate_out_of_order')
    ),
    status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    action_calls integer NOT NULL DEFAULT 1 CHECK (action_calls > 0),
    query_calls integer NOT NULL DEFAULT 0 CHECK (query_calls >= 0),
    request_fingerprint text NOT NULL
  );
  ALTER TABLE mock_resource_action_operations
    ADD COLUMN IF NOT EXISTS query_calls integer NOT NULL DEFAULT 0
      CHECK (query_calls >= 0);
  ALTER TABLE mock_resource_action_operations
    DROP CONSTRAINT IF EXISTS mock_resource_action_operations_action_check;
  ALTER TABLE mock_resource_action_operations
    ADD CONSTRAINT mock_resource_action_operations_action_check
    CHECK (action IN ('suspend', 'resume', 'terminate'));
  CREATE TABLE IF NOT EXISTS mock_resource_faults (
    operation_id uuid PRIMARY KEY,
    behavior text NOT NULL CHECK (behavior IN ('callback_success_then_reject'))
  );
  CREATE TABLE IF NOT EXISTS mock_payment_fault_gates (
    operation_id uuid PRIMARY KEY,
    behavior text NOT NULL CHECK (behavior IN ('delayed_definitive_reject')),
    released_at timestamptz
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
  ALTER TABLE mock_mail_messages
    DROP CONSTRAINT IF EXISTS mock_mail_messages_status_check;
  ALTER TABLE mock_mail_messages
    ADD CONSTRAINT mock_mail_messages_status_check
    CHECK (status IN ('delivered', 'bounced', 'failed'));
  ALTER TABLE mock_payment_operations
    ADD COLUMN IF NOT EXISTS request_fingerprint text;
  ALTER TABLE mock_payment_operations
    ADD COLUMN IF NOT EXISTS callback_capability text;
  ALTER TABLE mock_payment_operations
    ADD COLUMN IF NOT EXISTS saved_method_token text
      REFERENCES mock_saved_payment_methods(provider_token);
  ALTER TABLE mock_payment_operations
    ADD COLUMN IF NOT EXISTS query_calls integer NOT NULL DEFAULT 0;
  UPDATE mock_payment_operations
  SET callback_capability = 'legacy-disabled'
  WHERE callback_capability IS NULL;
  ALTER TABLE mock_payment_operations
    ALTER COLUMN callback_capability SET NOT NULL;
  UPDATE mock_payment_operations
  SET request_fingerprint = 'legacy:' || operation_id::text
  WHERE request_fingerprint IS NULL;
  ALTER TABLE mock_payment_operations
    ALTER COLUMN request_fingerprint SET NOT NULL;
  ALTER TABLE mock_resource_operations
    ADD COLUMN IF NOT EXISTS request_fingerprint text;
  ALTER TABLE mock_resource_operations
    ADD COLUMN IF NOT EXISTS callback_capability text;
  ALTER TABLE mock_resource_operations
    ADD COLUMN IF NOT EXISTS resource_state text NOT NULL DEFAULT 'active';
  ALTER TABLE mock_resource_operations
    ADD COLUMN IF NOT EXISTS power_state text NOT NULL DEFAULT 'running';
  ALTER TABLE mock_resource_operations
    ADD COLUMN IF NOT EXISTS desired_power_state text NOT NULL DEFAULT 'running';
  ALTER TABLE mock_resource_operations
    DROP CONSTRAINT IF EXISTS mock_resource_operations_resource_state_check;
  ALTER TABLE mock_resource_operations
    ADD CONSTRAINT mock_resource_operations_resource_state_check
    CHECK (resource_state IN ('active', 'suspended', 'terminated'));
  ALTER TABLE mock_resource_operations
    DROP CONSTRAINT IF EXISTS mock_resource_operations_power_state_check;
  ALTER TABLE mock_resource_operations
    ADD CONSTRAINT mock_resource_operations_power_state_check
    CHECK (power_state IN ('running', 'stopped', 'terminated'));
  ALTER TABLE mock_resource_operations
    DROP CONSTRAINT IF EXISTS mock_resource_operations_desired_power_state_check;
  ALTER TABLE mock_resource_operations
    ADD CONSTRAINT mock_resource_operations_desired_power_state_check
    CHECK (desired_power_state IN ('running', 'stopped', 'terminated'));
  UPDATE mock_resource_operations
  SET power_state = CASE resource_state
    WHEN 'suspended' THEN 'stopped'
    WHEN 'terminated' THEN 'terminated'
    ELSE power_state
  END;
  UPDATE mock_resource_operations
  SET desired_power_state = CASE resource_state
    WHEN 'terminated' THEN 'terminated'
    ELSE desired_power_state
  END;
  UPDATE mock_resource_operations
  SET callback_capability = repeat('A', 43)
  WHERE callback_capability IS NULL;
  ALTER TABLE mock_resource_operations
    ALTER COLUMN callback_capability SET NOT NULL;
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
  CREATE INDEX IF NOT EXISTS mock_refund_operations_original_status_idx
    ON mock_refund_operations (original_external_payment_id, status);
  CREATE INDEX IF NOT EXISTS mock_chargeback_operations_original_idx
    ON mock_chargeback_operations (original_operation_id, occurred_at);
  CREATE INDEX IF NOT EXISTS mock_resource_action_service_idx
    ON mock_resource_action_operations (service_id, occurred_at);
  CREATE OR REPLACE FUNCTION opensales_guard_mock_refund_operation_mutation()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE'
       OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
       OR NEW.refund_id IS DISTINCT FROM OLD.refund_id
       OR NEW.original_external_payment_id IS DISTINCT FROM OLD.original_external_payment_id
       OR NEW.external_refund_id IS DISTINCT FROM OLD.external_refund_id
       OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.scenario IS DISTINCT FROM OLD.scenario
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.callback_capability IS DISTINCT FROM OLD.callback_capability
       OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
       OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
       OR NEW.create_calls <> OLD.create_calls + 1 THEN
      RAISE EXCEPTION
        'Mock refund operations are append-only except for idempotent create call counting';
    END IF;
    RETURN NEW;
  END;
  $$;
  DROP TRIGGER IF EXISTS mock_refund_operations_append_only ON mock_refund_operations;
  CREATE TRIGGER mock_refund_operations_append_only
  BEFORE UPDATE OR DELETE ON mock_refund_operations
  FOR EACH ROW EXECUTE FUNCTION opensales_guard_mock_refund_operation_mutation();
  CREATE OR REPLACE FUNCTION opensales_guard_mock_chargeback_operation_mutation()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE'
       OR NEW.request_id IS DISTINCT FROM OLD.request_id
       OR NEW.original_operation_id IS DISTINCT FROM OLD.original_operation_id
       OR NEW.external_chargeback_id IS DISTINCT FROM OLD.external_chargeback_id
       OR NEW.scenario IS DISTINCT FROM OLD.scenario
       OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
       OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
       OR NEW.create_calls <> OLD.create_calls + 1 THEN
      RAISE EXCEPTION
        'Mock chargeback operations are append-only except for idempotent create call counting';
    END IF;
    RETURN NEW;
  END;
  $$;
  DROP TRIGGER IF EXISTS mock_chargeback_operations_append_only
    ON mock_chargeback_operations;
  CREATE TRIGGER mock_chargeback_operations_append_only
  BEFORE UPDATE OR DELETE ON mock_chargeback_operations
  FOR EACH ROW EXECUTE FUNCTION opensales_guard_mock_chargeback_operation_mutation();
  CREATE OR REPLACE FUNCTION opensales_guard_mock_resource_action_mutation()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE'
       OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
       OR NEW.service_id IS DISTINCT FROM OLD.service_id
       OR NEW.external_resource_id IS DISTINCT FROM OLD.external_resource_id
       OR NEW.callback_capability IS DISTINCT FROM OLD.callback_capability
       OR NEW.action IS DISTINCT FROM OLD.action
       OR NEW.scenario IS DISTINCT FROM OLD.scenario
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
       OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
       OR NOT (
         (NEW.action_calls = OLD.action_calls + 1 AND NEW.query_calls = OLD.query_calls)
         OR
         (NEW.action_calls = OLD.action_calls AND NEW.query_calls = OLD.query_calls + 1)
       ) THEN
      RAISE EXCEPTION
        'Mock resource actions are append-only except for request call counting';
    END IF;
    RETURN NEW;
  END;
  $$;
  DROP TRIGGER IF EXISTS mock_resource_action_operations_append_only
    ON mock_resource_action_operations;
  CREATE TRIGGER mock_resource_action_operations_append_only
  BEFORE UPDATE OR DELETE ON mock_resource_action_operations
  FOR EACH ROW EXECUTE FUNCTION opensales_guard_mock_resource_action_mutation();
  CREATE OR REPLACE FUNCTION opensales_guard_mock_mail_message_mutation()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE'
       OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
       -- citext equality intentionally ignores case, but the stored recipient
       -- spelling is part of the immutable Provider request fingerprint.
       OR NEW.recipient::text IS DISTINCT FROM OLD.recipient::text
       OR NEW.template IS DISTINCT FROM OLD.template
       OR NEW.locale IS DISTINCT FROM OLD.locale
       OR NEW.subject IS DISTINCT FROM OLD.subject
       OR NEW.body IS DISTINCT FROM OLD.body
       OR NEW.sensitive IS DISTINCT FROM OLD.sensitive
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
       OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
       OR NEW.delivery_calls <> OLD.delivery_calls + 1 THEN
      RAISE EXCEPTION
        'Mock mail messages are append-only except for idempotent delivery call counting';
    END IF;
    RETURN NEW;
  END;
  $$;
  DROP TRIGGER IF EXISTS mock_mail_messages_append_only ON mock_mail_messages;
  CREATE TRIGGER mock_mail_messages_append_only
  BEFORE UPDATE OR DELETE ON mock_mail_messages
  FOR EACH ROW EXECUTE FUNCTION opensales_guard_mock_mail_message_mutation();
`);

const app = Fastify({
  logger: {
    level: "info",
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.x-oss-signature",
        "req.body.providerPaymentMethodToken",
        "req.body.savedPaymentMethod.providerToken",
      ],
      censor: "[REDACTED]",
    },
  },
  bodyLimit: 128 * 1024,
});

app.addHook("onRequest", async (request, reply) => {
  const requestPath = new URL(request.url, "http://127.0.0.1").pathname;
  if (requestPath === "/v1/manifest") return;
  if (!requestPath.startsWith("/v1/") && !requestPath.startsWith("/v1alpha1/")) return;
  const expectedToken =
    requestPath.startsWith("/v1alpha1/") || requestPath === "/v1/events"
      ? config.MOCK_PROVIDER_PLATFORM_TOKEN
      : requestPath.startsWith("/v1/payments") || requestPath.startsWith("/v1/refunds")
      ? config.MOCK_PAYMENT_PROVIDER_TOKEN
      : requestPath.startsWith("/v1/resources") ||
          requestPath.startsWith("/v1/resource-actions")
        ? config.MOCK_PROVISIONING_PROVIDER_TOKEN
        : requestPath.startsWith("/v1/mailbox")
          ? config.LAB_MAILBOX_TOKEN
          : requestPath === "/v1/mail" || requestPath.startsWith("/v1/mail/")
            ? config.MOCK_MAIL_PROVIDER_TOKEN
            : undefined;
  if (!expectedToken) return reply.code(404).send({ error: "capability is not enabled" });
  const authorization = request.headers.authorization;
  const expected = Buffer.from(`Bearer ${expectedToken}`, "utf8");
  const received = Buffer.from(authorization ?? "", "utf8");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return reply.code(401).send({ error: "invalid provider credential" });
  }
  if (request.method === "POST" && requestPath === "/v1/mail") {
    const idempotencyKey = request.headers["idempotency-key"];
    const parsedOperationId = z.uuid().safeParse(
      Array.isArray(idempotencyKey) ? idempotencyKey[0] : idempotencyKey,
    );
    if (parsedOperationId.success) {
      incomingMailRequestReleases.set(
        request,
        registerIncomingMailRequest(parsedOperationId.data),
      );
    }
  }
});

if (config.MOCK_PROVIDER_PLATFORM_TOKEN) {
  await registerProviderPlatformRoutes(app, pool, {
    publicBaseUrl:
      config.MOCK_PROVIDER_PUBLIC_BASE_URL ??
      `http://127.0.0.1:${config.PROVIDER_PORT}`,
    authoritativeProvisioningResources: Boolean(config.MOCK_PROVISIONING_PROVIDER_TOKEN),
  });
}

function releaseIncomingMailRequest(request: object): void {
  const release = incomingMailRequestReleases.get(request);
  if (!release) return;
  incomingMailRequestReleases.delete(request);
  release();
}

app.addHook("onError", async (request) => {
  releaseIncomingMailRequest(request);
});

app.addHook("onRequestAbort", async (request) => {
  releaseIncomingMailRequest(request);
});

app.addHook("onSend", async (_request, reply) => {
  reply.header("X-Robots-Tag", "noindex, nofollow, noarchive");
  reply.header("Cache-Control", "no-store");
  reply.header("X-Content-Type-Options", "nosniff");
});

app.addHook("onResponse", async (request) => {
  releaseIncomingMailRequest(request);
});

function signature(timestamp: string, body: unknown, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${canonicalProviderJson(body)}`, "utf8")
    .digest("hex");
}

function canonicalProviderJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Provider payload contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalProviderJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalProviderJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Provider payload contains an unsupported value");
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
  let effectiveScenario:
    | z.infer<typeof paymentCreateSchema>["scenario"]
    | "requires_action" = body.scenario;
  let savedMethodToken: string | null = null;
  if (body.scenario === "automatic") {
    const method = await pool.query<{
      provider_token: string;
      automatic_scenario: "success" | "failed" | "requires_action" | "timeout_success";
    }>(
      `SELECT provider_token, automatic_scenario
       FROM mock_saved_payment_methods
       WHERE provider_token = $1 AND customer_reference = $2 AND status = 'active'`,
      [body.providerPaymentMethodToken, body.customerReference],
    );
    const row = method.rows[0];
    if (!row) return reply.code(403).send({ error: "saved payment method is invalid or belongs to another customer" });
    savedMethodToken = row.provider_token;
    effectiveScenario = row.automatic_scenario;
  } else if (body.savePaymentMethod) {
    savedMethodToken = `mock-pm-${body.paymentAttemptId}-token`;
    await pool.query(
      `INSERT INTO mock_saved_payment_methods(
         provider_token, source_payment_attempt_id, customer_reference,
         payment_method_code, instrument_type, brand, last_four,
         expiry_month, expiry_year
       ) VALUES ($1, $2, $3, $4, 'card', $5, '4242', 12, 2032)
       ON CONFLICT (source_payment_attempt_id) DO NOTHING`,
      [
        savedMethodToken,
        body.paymentAttemptId,
        body.customerReference,
        body.paymentMethodCode,
        body.paymentMethodCode === "alipay" ? "Mock Alipay" : "Mock Visa",
      ],
    );
  }
  if (effectiveScenario === "delayed_definitive_reject") {
    await pool.query(
      `INSERT INTO mock_payment_fault_gates(operation_id, behavior)
       VALUES ($1, 'delayed_definitive_reject')
       ON CONFLICT (operation_id) DO NOTHING`,
      [body.operationId],
    );
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const gate = await pool.query<{ released: boolean }>(
        `SELECT released_at IS NOT NULL AS released
         FROM mock_payment_fault_gates
         WHERE operation_id = $1`,
        [body.operationId],
      );
      if (gate.rows[0]?.released) {
        return reply.code(400).send({ error: "synthetic delayed definitive payment rejection" });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return reply.code(503).send({ error: "synthetic definitive rejection gate timed out" });
  }
  if (effectiveScenario === "definitive_reject") {
    return reply.code(400).send({ error: "synthetic definitive payment rejection" });
  }
  const externalPaymentId = `mock-pay-${body.operationId}`;
  const fingerprint = requestFingerprint("payment.create:v1", body);
  const status =
    effectiveScenario === "failed"
      ? "failed"
      : effectiveScenario === "cancelled"
        ? "cancelled"
        : effectiveScenario === "requires_action"
          ? "requires_action"
        : "succeeded";
  const inserted = await pool.query<{
    external_payment_id: string;
    status: "succeeded" | "failed" | "cancelled" | "requires_action";
    occurred_at: Date;
  }>(
    `INSERT INTO mock_payment_operations(
       operation_id, payment_attempt_id, external_payment_id,
       amount_minor, currency, scenario, status, callback_capability
       , request_fingerprint, saved_method_token
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
      effectiveScenario,
      status,
      body.callbackCapability,
      fingerprint,
      savedMethodToken,
    ],
  );
  const operation = inserted.rows[0];
  if (!operation) {
    return reply.code(409).send({ error: "idempotency key was reused with a different payment" });
  }

  const event = {
    eventId: `payment:${body.operationId}:${operation.status}`,
    providerOperationId: body.operationId,
    paymentAttemptId: body.paymentAttemptId,
    callbackCapability: body.callbackCapability,
    externalPaymentId: operation.external_payment_id,
    status: operation.status,
    amountMinor:
      body.scenario === "partial" ||
      body.scenario === "partial_then_reject" ||
      body.scenario === "partial_then_timeout"
        ? (BigInt(body.amountMinor) / 2n || 1n).toString()
        : body.amountMinor,
    currency: body.scenario === "wrong_currency" ? "EUR" : body.currency,
    occurredAt:
      effectiveScenario === "late_success"
        ? new Date(operation.occurred_at.getTime() + 31 * 60 * 1_000).toISOString()
        : operation.occurred_at.toISOString(),
    ...(body.savePaymentMethod && savedMethodToken
      ? {
          savedPaymentMethod: {
            providerToken: savedMethodToken,
            instrumentType: "card",
            brand: body.paymentMethodCode === "alipay" ? "Mock Alipay" : "Mock Visa",
            lastFour: "4242",
            expiryMonth: 12,
            expiryYear: 2032,
          },
        }
      : {}),
  };
  if (effectiveScenario === "expired_late") {
    scheduleCallback(
      "/api/v1/provider-events/payment",
      {
        ...event,
        eventId: `${event.eventId}:expired`,
        status: "expired",
        occurredAt: new Date(operation.occurred_at.getTime() - 1).toISOString(),
      },
      20,
      callbackSecret,
    );
    scheduleCallback(
      "/api/v1/provider-events/payment",
      { ...event, eventId: `${event.eventId}:late-success` },
      60,
      callbackSecret,
    );
  } else if (effectiveScenario === "duplicate_out_of_order") {
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
  } else if (effectiveScenario === "success_then_reject") {
    await callback("/api/v1/provider-events/payment", event, callbackSecret);
    return reply.code(400).send({
      error: "synthetic rejection after Provider already reported full payment success",
    });
  } else if (effectiveScenario === "partial_then_reject") {
    await callback("/api/v1/provider-events/payment", event, callbackSecret);
    return reply.code(400).send({
      error: "synthetic rejection after Provider already reported partial funds",
    });
  } else if (effectiveScenario === "partial_then_timeout") {
    await callback("/api/v1/provider-events/payment", event, callbackSecret);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  } else if (effectiveScenario === "reconcile_manual") {
    return reply.code(503).send({
      error: "synthetic ambiguous create followed by manual reconciliation",
    });
  } else if (effectiveScenario !== "timeout_success") {
    scheduleCallback("/api/v1/provider-events/payment", event, 20, callbackSecret);
  }
  if (effectiveScenario === "timeout_success") {
    // Deliberately do not emit a callback. Core must treat the timed-out POST
    // as unknown and learn the already-settled result only through GET
    // reconciliation. This remains deterministic even with a slow Worker or a
    // large reconciliation delay.
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
  await pool.query(
    `UPDATE mock_payment_operations
     SET query_calls = query_calls + 1
     WHERE operation_id = $1`,
    [params.operationId],
  );
  const result = await pool.query<{
    callback_capability: string;
    external_payment_id: string;
    status: "succeeded" | "failed" | "cancelled" | "requires_action";
    amount_minor: string;
    currency: string;
    scenario: string;
    occurred_at: Date;
    saved_method_token: string | null;
    instrument_type: string | null;
    brand: string | null;
    last_four: string | null;
    expiry_month: number | null;
    expiry_year: number | null;
  }>(
    `SELECT operation.callback_capability, operation.external_payment_id,
            operation.status, operation.amount_minor, operation.currency,
            operation.scenario, operation.occurred_at, operation.saved_method_token,
            saved.instrument_type, saved.brand, saved.last_four,
            saved.expiry_month, saved.expiry_year
     FROM mock_payment_operations operation
     LEFT JOIN mock_saved_payment_methods saved
       ON saved.provider_token = operation.saved_method_token
     WHERE operation.operation_id = $1`,
    [params.operationId],
  );
  const row = result.rows[0];
  if (!row) return reply.code(404).send({ error: "operation not found" });
  if (row.scenario === "reconcile_manual") {
    return reply.code(422).send({ error: "synthetic reconciliation requires an operator" });
  }
  return {
    callbackCapability: row.callback_capability,
    externalPaymentId: row.external_payment_id,
    status: row.status,
    amountMinor:
      row.scenario === "partial" ||
      row.scenario === "partial_then_reject" ||
      row.scenario === "partial_then_timeout"
        ? (BigInt(row.amount_minor) / 2n || 1n).toString()
        : row.amount_minor,
    currency: row.scenario === "wrong_currency" ? "EUR" : row.currency,
    occurredAt:
      row.scenario === "late_success"
        ? new Date(row.occurred_at.getTime() + 31 * 60 * 1_000).toISOString()
        : row.occurred_at.toISOString(),
    ...(row.saved_method_token && row.instrument_type && row.brand && row.last_four
      ? {
          savedPaymentMethod: {
            providerToken: row.saved_method_token,
            instrumentType: row.instrument_type,
            brand: row.brand,
            lastFour: row.last_four,
            expiryMonth: row.expiry_month,
            expiryYear: row.expiry_year,
          },
        }
      : {}),
  };
});

app.post("/v1/payments/lab-methods/:sourcePaymentAttemptId/scenario", async (request, reply) => {
  const params = z.object({ sourcePaymentAttemptId: z.uuid() }).parse(request.params);
  const body = z
    .object({ scenario: z.enum(["success", "failed", "requires_action", "timeout_success"]) })
    .strict()
    .parse(request.body);
  const updated = await pool.query(
    `UPDATE mock_saved_payment_methods
     SET automatic_scenario = $2, updated_at = now()
     WHERE source_payment_attempt_id = $1`,
    [params.sourcePaymentAttemptId, body.scenario],
  );
  if (updated.rowCount !== 1) return reply.code(404).send({ error: "saved payment method not found" });
  return { sourcePaymentAttemptId: params.sourcePaymentAttemptId, scenario: body.scenario };
});

app.get("/v1/payments/lab-methods/:sourcePaymentAttemptId/stats", async (request, reply) => {
  const params = z.object({ sourcePaymentAttemptId: z.uuid() }).parse(request.params);
  const result = await pool.query<{
    source_payment_attempt_id: string;
    automatic_scenario: string;
    status: string;
    operation_id: string | null;
    operation_status: string | null;
    create_calls: number | null;
    query_calls: number | null;
  }>(
    `SELECT saved.source_payment_attempt_id, saved.automatic_scenario, saved.status,
            operation.operation_id, operation.status AS operation_status,
            operation.create_calls, operation.query_calls
     FROM mock_saved_payment_methods saved
     LEFT JOIN mock_payment_operations operation
       ON operation.saved_method_token = saved.provider_token
      AND operation.payment_attempt_id <> saved.source_payment_attempt_id
     WHERE saved.source_payment_attempt_id = $1
     ORDER BY operation.occurred_at, operation.operation_id`,
    [params.sourcePaymentAttemptId],
  );
  const first = result.rows[0];
  if (!first) return reply.code(404).send({ error: "saved payment method not found" });
  return {
    sourcePaymentAttemptId: first.source_payment_attempt_id,
    scenario: first.automatic_scenario,
    status: first.status,
    automaticOperations: result.rows
      .filter((row) => row.operation_id)
      .map((row) => ({
        operationId: row.operation_id,
        status: row.operation_status,
        createCalls: row.create_calls,
        queryCalls: row.query_calls,
      })),
  };
});

app.post("/v1/payments/:operationId/chargebacks", async (request, reply) => {
  const params = z.object({ operationId: z.uuid() }).parse(request.params);
  const body = chargebackCreateSchema.parse(request.body);
  const callbackSecret = config.MOCK_PAYMENT_WEBHOOK_SECRET;
  if (!callbackSecret) {
    return reply.code(503).send({ error: "chargeback callback is not configured" });
  }
  if (request.headers["idempotency-key"] !== body.requestId) {
    return reply.code(400).send({ error: "stable idempotency key is required" });
  }

  type ChargebackOperation = {
    request_id: string;
    external_chargeback_id: string;
    scenario: z.infer<typeof chargebackCreateSchema>["scenario"];
    occurred_at: Date;
    payment_attempt_id: string;
    external_payment_id: string;
    amount_minor: string;
    currency: string;
    callback_capability: string;
    create_calls: number;
  };
  const fingerprint = requestFingerprint("chargeback.create:v1", {
    originalOperationId: params.operationId,
    ...body,
  });
  const externalChargebackId = `mock-chargeback-${body.requestId}`;
  const inserted = await pool.query<ChargebackOperation>(
    `INSERT INTO mock_chargeback_operations(
       request_id, original_operation_id, external_chargeback_id,
       scenario, request_fingerprint
     )
     SELECT $1, payment.operation_id, $2, $3, $4
     FROM mock_payment_operations payment
     WHERE payment.operation_id = $5
       AND payment.status = 'succeeded'
     ON CONFLICT (request_id) DO UPDATE
       SET create_calls = mock_chargeback_operations.create_calls + 1
       WHERE mock_chargeback_operations.request_fingerprint = EXCLUDED.request_fingerprint
     RETURNING
       request_id,
       external_chargeback_id,
       scenario,
       occurred_at,
       (SELECT payment_attempt_id
          FROM mock_payment_operations
         WHERE operation_id = original_operation_id),
       (SELECT external_payment_id
          FROM mock_payment_operations
         WHERE operation_id = original_operation_id),
       (SELECT amount_minor::text
          FROM mock_payment_operations
         WHERE operation_id = original_operation_id),
       (SELECT currency
          FROM mock_payment_operations
         WHERE operation_id = original_operation_id),
       (SELECT callback_capability
          FROM mock_payment_operations
         WHERE operation_id = original_operation_id),
       create_calls`,
    [
      body.requestId,
      externalChargebackId,
      body.scenario,
      fingerprint,
      params.operationId,
    ],
  );
  const operation = inserted.rows[0];
  if (!operation) {
    const original = await pool.query(
      `SELECT status
       FROM mock_payment_operations
       WHERE operation_id = $1`,
      [params.operationId],
    );
    if (!original.rows[0]) {
      return reply.code(404).send({ error: "original payment operation not found" });
    }
    if (original.rows[0].status !== "succeeded") {
      return reply.code(409).send({ error: "only a settled payment can be charged back" });
    }
    return reply.code(409).send({ error: "idempotency key was reused with a different chargeback" });
  }

  const event = {
    eventId: `chargeback:${operation.request_id}:succeeded`,
    providerOperationId: params.operationId,
    addFundsAttemptId: operation.payment_attempt_id,
    callbackCapability: operation.callback_capability,
    originalExternalPaymentId:
      operation.scenario === "wrong_external_payment"
        ? `wrong-${operation.external_payment_id}`
        : operation.external_payment_id,
    externalChargebackId: operation.external_chargeback_id,
    status: "succeeded",
    amountMinor:
      operation.scenario === "wrong_amount"
        ? (BigInt(operation.amount_minor) + 1n).toString()
        : operation.amount_minor,
    currency: operation.scenario === "wrong_currency" ? "EUR" : operation.currency,
    occurredAt: operation.occurred_at.toISOString(),
  };
  scheduleCallback("/api/v1/provider-events/add-funds-chargeback", event, 20, callbackSecret);
  if (operation.scenario === "duplicate") {
    scheduleCallback(
      "/api/v1/provider-events/add-funds-chargeback",
      { ...event, eventId: `${event.eventId}:duplicate` },
      40,
      callbackSecret,
    );
  }
  return reply.code(202).send({
    requestId: operation.request_id,
    externalChargebackId: operation.external_chargeback_id,
    status: "succeeded",
    replayed: operation.create_calls > 1,
  });
});

app.post("/v1/refunds", async (request, reply) => {
  const body = refundCreateSchema.parse(request.body);
  const callbackSecret = config.MOCK_PAYMENT_WEBHOOK_SECRET;
  if (!callbackSecret) return reply.code(503).send({ error: "refund callback is not configured" });
  if (request.headers["idempotency-key"] !== body.operationId) {
    return reply.code(400).send({ error: "stable idempotency key is required" });
  }

  const externalRefundId = `mock-refund-${body.operationId}`;
  const fingerprint = requestFingerprint("refund.create:v1", body);
  const status = body.scenario === "failed" ? "failed" : "succeeded";
  type RefundOperation = {
    operation_id: string;
    refund_id: string;
    external_refund_id: string;
    status: "succeeded" | "failed";
    amount_minor: string;
    currency: string;
    scenario: "success" | "failed" | "timeout_success" | "duplicate_out_of_order";
    callback_capability: string;
    occurred_at: Date;
  };
  let operation: RefundOperation | undefined;
  let replayed = false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const originalResult = await client.query<{
      amount_minor: string;
      currency: string;
      status: string;
    }>(
      `SELECT amount_minor::text, currency, status
       FROM mock_payment_operations
       WHERE external_payment_id = $1
       FOR UPDATE`,
      [body.originalExternalPaymentId],
    );
    const original = originalResult.rows[0];
    if (!original) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "original payment operation not found" });
    }
    if (original.status !== "succeeded") {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "original payment is not refundable" });
    }
    if (original.currency !== body.currency) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "refund currency does not match original payment" });
    }
    if (BigInt(body.amountMinor) > BigInt(original.amount_minor)) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "refund exceeds original payment amount" });
    }

    const existingResult = await client.query<RefundOperation & { request_fingerprint: string }>(
      `SELECT operation_id, refund_id, external_refund_id, status, amount_minor::text,
              currency, scenario, callback_capability, occurred_at, request_fingerprint
       FROM mock_refund_operations
       WHERE operation_id = $1
       FOR UPDATE`,
      [body.operationId],
    );
    const existing = existingResult.rows[0];
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) {
        await client.query("ROLLBACK");
        return reply
          .code(409)
          .send({ error: "idempotency key was reused with a different refund" });
      }
      const replayResult = await client.query<RefundOperation>(
        `UPDATE mock_refund_operations
         SET create_calls = create_calls + 1
         WHERE operation_id = $1
         RETURNING operation_id, refund_id, external_refund_id, status, amount_minor::text,
                   currency, scenario, callback_capability, occurred_at`,
        [body.operationId],
      );
      operation = replayResult.rows[0];
      replayed = true;
    } else {
      const refundOwner = await client.query<{ operation_id: string }>(
        `SELECT operation_id
         FROM mock_refund_operations
         WHERE refund_id = $1
         FOR UPDATE`,
        [body.refundId],
      );
      if (refundOwner.rows[0]) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "refund is already bound to another operation" });
      }
      if (status !== "failed") {
        const reservedResult = await client.query<{ reserved_minor: string }>(
          `SELECT COALESCE(sum(amount_minor), 0)::text AS reserved_minor
           FROM mock_refund_operations
           WHERE original_external_payment_id = $1
             AND status IN ('succeeded', 'unknown')`,
          [body.originalExternalPaymentId],
        );
        const reservedMinor = BigInt(reservedResult.rows[0]?.reserved_minor ?? "0");
        if (reservedMinor + BigInt(body.amountMinor) > BigInt(original.amount_minor)) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "cumulative refunds exceed original payment amount" });
        }
      }
      const inserted = await client.query<RefundOperation>(
        `INSERT INTO mock_refund_operations(
           operation_id, refund_id, original_external_payment_id, external_refund_id,
           amount_minor, currency, scenario, status, callback_capability, request_fingerprint
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING operation_id, refund_id, external_refund_id, status, amount_minor::text,
                   currency, scenario, callback_capability, occurred_at`,
        [
          body.operationId,
          body.refundId,
          body.originalExternalPaymentId,
          externalRefundId,
          body.amountMinor,
          body.currency,
          body.scenario,
          status,
          body.callbackCapability,
          fingerprint,
        ],
      );
      operation = inserted.rows[0];
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (!operation) throw new Error("Unable to create Mock refund operation");

  const event = {
    eventId: `refund:${operation.operation_id}:${operation.status}`,
    providerOperationId: operation.operation_id,
    refundId: operation.refund_id,
    callbackCapability: operation.callback_capability,
    externalRefundId: operation.external_refund_id,
    status: operation.status,
    amountMinor: operation.amount_minor,
    currency: operation.currency,
    occurredAt: operation.occurred_at.toISOString(),
  };
  if (operation.scenario === "duplicate_out_of_order") {
    scheduleCallback("/api/v1/provider-events/refund", event, 20, callbackSecret);
    scheduleCallback(
      "/api/v1/provider-events/refund",
      {
        ...event,
        eventId: `${event.eventId}:late-failed`,
        status: "failed",
        occurredAt: new Date(operation.occurred_at.getTime() - 1).toISOString(),
      },
      40,
      callbackSecret,
    );
    scheduleCallback(
      "/api/v1/provider-events/refund",
      { ...event, eventId: `${event.eventId}:duplicate` },
      60,
      callbackSecret,
    );
  } else {
    scheduleCallback(
      "/api/v1/provider-events/refund",
      event,
      operation.scenario === "timeout_success" ? 3_500 : 20,
      callbackSecret,
    );
  }
  if (operation.scenario === "timeout_success") {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return reply.code(202).send({
    operationId: operation.operation_id,
    status: operation.status,
    replayed,
  });
});

app.get("/v1/refunds/:operationId", async (request, reply) => {
  const params = z.object({ operationId: z.uuid() }).parse(request.params);
  const result = await pool.query<{
    callback_capability: string;
    external_refund_id: string;
    status: "succeeded" | "failed";
    amount_minor: string;
    currency: string;
    occurred_at: Date;
  }>(
    `SELECT callback_capability, external_refund_id, status, amount_minor::text,
            currency, occurred_at
     FROM mock_refund_operations
     WHERE operation_id = $1`,
    [params.operationId],
  );
  const row = result.rows[0];
  if (!row) return reply.code(404).send({ error: "operation not found" });
  return {
    callbackCapability: row.callback_capability,
    externalRefundId: row.external_refund_id,
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
       operation_id, service_id, external_resource_id, callback_capability,
       scenario, status, ready_at, request_fingerprint
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (operation_id) DO UPDATE
       SET create_calls = mock_resource_operations.create_calls + 1
       WHERE mock_resource_operations.request_fingerprint = EXCLUDED.request_fingerprint
     RETURNING external_resource_id, status, ready_at, occurred_at`,
    [
      body.operationId,
      body.serviceId,
      externalResourceId,
      body.callbackCapability,
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
    callbackCapability: body.callbackCapability,
    status: operation.status,
    ...(operation.external_resource_id
      ? { externalResourceId: operation.external_resource_id }
      : {}),
    ...(operation.ready_at ? { readyAt: operation.ready_at.toISOString() } : {}),
    occurredAt: operation.occurred_at.toISOString(),
  };
  const injectedFault = await pool.query<{ behavior: string }>(
    `DELETE FROM mock_resource_faults
     WHERE operation_id = $1
     RETURNING behavior`,
    [body.operationId],
  );
  if (injectedFault.rows[0]?.behavior === "callback_success_then_reject") {
    await callback("/api/v1/provider-events/provisioning", event, callbackSecret);
    return reply.code(400).send({
      error: "synthetic rejection after Provider already reported a created resource",
    });
  }
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
    callback_capability: string;
    external_resource_id: string | null;
    status: "succeeded" | "failed";
    resource_state: "active" | "suspended" | "terminated";
    ready_at: Date | null;
    occurred_at: Date;
  }>(
    `SELECT callback_capability, external_resource_id, status, resource_state,
            ready_at, occurred_at
     FROM mock_resource_operations
     WHERE operation_id = $1`,
    [params.operationId],
  );
  const row = result.rows[0];
  if (!row) return reply.code(404).send({ error: "operation not found" });
  return {
    callbackCapability: row.callback_capability,
    status: row.status,
    resourceState: row.resource_state,
    ...(row.external_resource_id ? { externalResourceId: row.external_resource_id } : {}),
    ...(row.ready_at ? { readyAt: row.ready_at.toISOString() } : {}),
    occurredAt: row.occurred_at.toISOString(),
  };
});

app.post("/v1/resource-actions", async (request, reply) => {
  const body = resourceActionSchema.parse(request.body);
  const callbackSecret = config.MOCK_PROVISIONING_WEBHOOK_SECRET;
  if (!callbackSecret) {
    return reply.code(503).send({ error: "provisioning callback is not configured" });
  }
  if (request.headers["idempotency-key"] !== body.operationId) {
    return reply.code(400).send({ error: "stable idempotency key is required" });
  }
  const fingerprint = requestFingerprint(`resource.${body.action}:v1`, body);
  const status = body.scenario === "failed" ? "failed" : "succeeded";
  type ResourceActionResult = {
    external_resource_id: string;
    action: "suspend" | "resume" | "terminate";
    status: "succeeded" | "failed";
    occurred_at: Date;
  };
  const client = await pool.connect();
  let operation: ResourceActionResult | undefined;
  try {
    await client.query("BEGIN");
    const replay = await client.query<ResourceActionResult & { request_fingerprint: string }>(
      `SELECT external_resource_id, action, status, occurred_at, request_fingerprint
       FROM mock_resource_action_operations
       WHERE operation_id = $1
       FOR UPDATE`,
      [body.operationId],
    );
    const existing = replay.rows[0];
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) {
        await client.query("ROLLBACK");
        return reply.code(409).send({
          error: "idempotency key was reused with a different action",
        });
      }
      const repeated = await client.query<ResourceActionResult>(
        `UPDATE mock_resource_action_operations
         SET action_calls = action_calls + 1
         WHERE operation_id = $1
         RETURNING external_resource_id, action, status, occurred_at`,
        [body.operationId],
      );
      operation = repeated.rows[0];
    } else {
      const resource = await client.query<{
        resource_state: "active" | "suspended" | "terminated";
      }>(
        `SELECT resource_state
         FROM mock_resource_operations
         WHERE service_id = $1
           AND external_resource_id = $2
           AND status = 'succeeded'
         FOR UPDATE`,
        [body.serviceId, body.externalResourceId],
      );
      const currentState = resource.rows[0]?.resource_state;
      if (!currentState) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "resource not found" });
      }
      const eligibleState = body.action === "suspend"
        ? currentState === "active"
        : body.action === "resume"
          ? currentState === "suspended"
          : currentState === "active" || currentState === "suspended";
      if (!eligibleState) {
        await client.query("ROLLBACK");
        return reply.code(409).send({
          error: `resource is ${currentState}; ${body.action} is not allowed from that state`,
        });
      }
      const inserted = await client.query<ResourceActionResult>(
        `INSERT INTO mock_resource_action_operations(
           operation_id, service_id, external_resource_id, callback_capability,
           action, scenario, status, request_fingerprint
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING external_resource_id, action, status, occurred_at`,
        [
          body.operationId,
          body.serviceId,
          body.externalResourceId,
          body.callbackCapability,
          body.action,
          body.scenario,
          status,
          fingerprint,
        ],
      );
      operation = inserted.rows[0];
      if (status === "succeeded") {
        await client.query(
          `UPDATE mock_resource_operations
           SET resource_state = $3,
               power_state = CASE $3
                 WHEN 'suspended' THEN 'stopped'
                 WHEN 'active' THEN desired_power_state
                 ELSE 'terminated'
               END,
               desired_power_state = CASE
                 WHEN $3 = 'terminated' THEN 'terminated'
                 ELSE desired_power_state
               END
           WHERE service_id = $1 AND external_resource_id = $2`,
          [
            body.serviceId,
            body.externalResourceId,
            body.action === "suspend"
              ? "suspended"
              : body.action === "resume"
                ? "active"
                : "terminated",
          ],
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (!operation) throw new Error("Unable to record Mock resource action");
  const event = {
    eventId: `resource-action:${body.operationId}:${operation.status}`,
    providerOperationId: body.operationId,
    callbackCapability: body.callbackCapability,
    serviceId: body.serviceId,
    externalResourceId: operation.external_resource_id,
    action: operation.action,
    status: operation.status,
    occurredAt: operation.occurred_at.toISOString(),
  };
  // The timeout-success callback deliberately arrives after the first normal
  // reconcile opportunity. This proves that Core learns the external result
  // through the Provider query rather than a conveniently early callback.
  const delayMs = body.scenario === "timeout_success" ? 8_000 : 20;
  const callbackPath = body.action === "terminate"
    ? "/api/v1/provider-events/resource-termination"
    : "/api/v1/provider-events/resource-action";
  scheduleCallback(callbackPath, event, delayMs, callbackSecret);
  if (body.scenario === "duplicate_out_of_order") {
    scheduleCallback(callbackPath, event, 40, callbackSecret);
    scheduleCallback(
      callbackPath,
      {
        ...event,
        eventId: `resource-action:${body.operationId}:stale-conflict`,
        status: operation.status === "succeeded" ? "failed" : "succeeded",
        occurredAt: new Date(operation.occurred_at.getTime() - 1_000).toISOString(),
      },
      60,
      callbackSecret,
    );
  }
  if (body.scenario === "timeout_success") {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return reply.code(202).send({
    operationId: body.operationId,
    action: operation.action,
    status: operation.status,
  });
});

app.get("/v1/resource-actions/:operationId", async (request, reply) => {
  const params = z.object({ operationId: z.uuid() }).parse(request.params);
  const result = await pool.query<{
    callback_capability: string;
    service_id: string;
    external_resource_id: string;
    action: "suspend" | "resume" | "terminate";
    status: "succeeded" | "failed";
    occurred_at: Date;
  }>(
    `UPDATE mock_resource_action_operations
     SET query_calls = query_calls + 1
     WHERE operation_id = $1
     RETURNING callback_capability, service_id, external_resource_id,
               action, status, occurred_at`,
    [params.operationId],
  );
  const row = result.rows[0];
  if (!row) return reply.code(404).send({ error: "operation not found" });
  return {
    callbackCapability: row.callback_capability,
    serviceId: row.service_id,
    externalResourceId: row.external_resource_id,
    action: row.action,
    status: row.status,
    occurredAt: row.occurred_at.toISOString(),
  };
});

app.post("/v1/mail", async (request, reply) => {
  try {
    const body = mailCreateSchema.parse(request.body);
    if (request.headers["idempotency-key"] !== body.operationId) {
      return reply.code(400).send({ error: "stable idempotency key is required" });
    }
    const normalizedBody = { ...body, scenario: body.scenario ?? "delivered" } as const;
    const fingerprint = requestFingerprint("mail.send:v1", normalizedBody);
    const result = await serializeMailWrite(normalizedBody.operationId, async () => {
      const client = await pool.connect();
      let transactionResult: pg.QueryResult<{
        status: "delivered" | "bounced" | "failed";
        delivered_at: Date;
      }>;
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`mock-mail-operation:${normalizedBody.operationId}`],
        );
        transactionResult = await client.query(
          `INSERT INTO mock_mail_messages(
             operation_id, recipient, template, locale, subject, body, sensitive,
             status, request_fingerprint
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (operation_id) DO UPDATE
             SET delivery_calls = mock_mail_messages.delivery_calls + 1
             WHERE mock_mail_messages.request_fingerprint = EXCLUDED.request_fingerprint
           RETURNING status, delivered_at`,
          [
            normalizedBody.operationId,
            normalizedBody.recipient,
            normalizedBody.template,
            normalizedBody.locale,
            normalizedBody.subject,
            normalizedBody.body,
            normalizedBody.sensitive,
            normalizedBody.scenario,
            fingerprint,
          ],
        );
        await client.query("COMMIT");
        return transactionResult;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
    if (!result.rows[0]) {
      return reply.code(409).send({ error: "idempotency key was reused with a different message" });
    }
    return reply.code(202).send({
      operationId: normalizedBody.operationId,
      status: result.rows[0]?.status ?? "delivered",
      deliveredAt: result.rows[0]?.delivered_at.toISOString(),
    });
  } finally {
    // Fastify does not run onRequestAbort/onError/onResponse when a client
    // disconnects after the complete body reached this handler. The Provider
    // must still commit or roll back before reconciliation GET can observe 404.
    releaseIncomingMailRequest(request);
  }
});

app.get("/v1/mail/:operationId", async (request, reply) => {
  const params = mailOperationParamsSchema.safeParse(request.params);
  if (!params.success) {
    return reply.code(400).send({ error: "operationId must be a UUID" });
  }
  await waitForIncomingMailRequest(params.data.operationId);
  await waitForInFlightMailWrite(params.data.operationId);
  const client = await pool.connect();
  let result: pg.QueryResult<{
    operation_id: string;
    status: "delivered" | "bounced" | "failed";
    delivered_at: Date;
  }>;
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`mock-mail-operation:${params.data.operationId}`],
    );
    result = await client.query(
      `SELECT operation_id, status, delivered_at
       FROM mock_mail_messages
       WHERE operation_id = $1`,
      [params.data.operationId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const row = result.rows[0];
  if (!row) return reply.code(404).send({ error: "operation not found" });
  return {
    operationId: row.operation_id,
    status: mailDeliveryStatusSchema.parse(row.status),
    deliveredAt: row.delivered_at.toISOString(),
  };
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
       AND ($2::uuid IS NULL OR operation_id = $2)
     ORDER BY delivered_at DESC
     LIMIT 20`,
    [query.recipient, query.operationId ?? null],
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
