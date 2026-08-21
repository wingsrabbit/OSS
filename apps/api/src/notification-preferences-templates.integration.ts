// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import pg from "pg";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import {
  configureRuntimeDatabaseRoles,
  createPoolForConnection,
  runMigrations,
  transaction,
  type DatabasePool,
} from "./database.js";
import { enqueueNotification } from "./notification-outbox.js";
import { resolveCurrentNotificationTemplate } from "./notification-templates.js";
import { registerAuthRoutes } from "./routes-auth.js";
import { registerNotificationTemplateRoutes } from "./routes-notification-templates.js";
import { registerTicketRoutes } from "./routes-tickets.js";
import { issueInitialStaffBootstrapToken } from "./staff-bootstrap.js";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) {
  throw new Error("ADMIN_DATABASE_URL is required for notification preferences integration");
}

const databaseName = `oss_notification_preferences_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = new URL(adminDatabaseUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = new pg.Client({ connectionString: adminDatabaseUrl });
let pool: DatabasePool | null = null;
let workerPool: DatabasePool | null = null;
let mockMailServer: Server | null = null;
const apiRole = `oss_ntp_api_${randomUUID().replaceAll("-", "")}`;
const workerRole = `oss_ntp_worker_${randomUUID().replaceAll("-", "")}`;
const apiRolePassword = `api-${randomUUID()}-${randomUUID()}`;
const workerRolePassword = `worker-${randomUUID()}-${randomUUID()}`;
const workerId = `notification-preferences-worker-${randomUUID()}`;
const providerToken = `synthetic-notification-preferences-provider-${randomUUID()}`;
const deliveredMailBodies = new Map<string, Record<string, unknown>>();
let mockMailProviderUrl: string | null = null;

const config: Config = {
  DATABASE_URL: databaseUrl.toString(),
  OSS_ENV: "test",
  OSS_LOG_LEVEL: "silent",
  OSS_PUBLIC_URL: "http://127.0.0.1:3000",
  API_HOST: "127.0.0.1",
  API_PORT: 3000,
  GLOBAL_RATE_LIMIT_MAX: 10_000,
  SESSION_COOKIE_NAME: "oss_notification_preferences_session",
  SESSION_TTL_HOURS: 24,
  VERIFICATION_TTL_MINUTES: 30,
  WEB_ORIGIN: "http://127.0.0.1:5173",
  MOCK_MAILBOX_URL: "http://127.0.0.1:4000",
  LAB_MAILBOX_TOKEN: "synthetic-notification-preference-mailbox-token",
  PROVIDER_OPERATION_CAPABILITY_SECRET:
    "synthetic-notification-preference-provider-capability",
  PAYMENT_METHOD_TOKEN_KEY: Buffer.alloc(32, 121).toString("base64url"),
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY: Buffer.alloc(32, 122).toString("base64url"),
  IDENTITY_SECRET_KEY: Buffer.alloc(32, 123).toString("base64url"),
  MOCK_PAYMENT_WEBHOOK_SECRET: "synthetic-notification-preference-payment-hook",
  MOCK_PROVISIONING_WEBHOOK_SECRET:
    "synthetic-notification-preference-provision-hook",
  NOTIFICATION_MAX_ATTEMPTS: 3,
  LAB_MAILBOX_ENABLED: false,
};

function json<T>(response: Readonly<{ body: string }>): T {
  return JSON.parse(response.body) as T;
}

async function waitForDatabaseConnectionsToClose(timeoutMilliseconds = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (true) {
    const connections = await admin.query<{ count: string }>(
      `SELECT pg_catalog.count(*)::text AS count
       FROM pg_catalog.pg_stat_activity
       WHERE datname = $1`,
      [databaseName],
    );
    const count = Number(connections.rows[0]?.count ?? "0");
    if (count === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Notification preferences database still has ${count} connection(s) after pool shutdown`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

type WorkerNotificationJob = Readonly<{
  id: string;
  job_type: string;
  unique_key: string;
  payload: Record<string, string>;
  payload_snapshot: string;
  attempts: number;
  locked_at_epoch: string;
  locked_by: string | null;
}>;

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  pool = new pg.Pool({
    connectionString: databaseUrl.toString(),
    max: 10,
    options: "-c search_path=pg_catalog,public",
    statement_timeout: 20_000,
    application_name: "opensales-notification-preferences-integration",
  });
  await runMigrations(pool);
  await configureRuntimeDatabaseRoles(pool, [
    { name: apiRole, password: apiRolePassword },
    { name: workerRole, password: workerRolePassword },
  ]);
  await pool.end();
  const runtimeDatabaseUrl = new URL(databaseUrl);
  runtimeDatabaseUrl.username = apiRole;
  runtimeDatabaseUrl.password = apiRolePassword;
  pool = createPoolForConnection(
    runtimeDatabaseUrl.toString(),
    "opensales-notification-preferences-api-runtime",
  );
  const workerDatabaseUrl = new URL(databaseUrl);
  workerDatabaseUrl.username = workerRole;
  workerDatabaseUrl.password = workerRolePassword;
  workerPool = createPoolForConnection(
    workerDatabaseUrl.toString(),
    "opensales-notification-preferences-worker-runtime",
  );

  const app = Fastify({ logger: false });
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "Invalid request", details: error.issues });
    }
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number(error.statusCode)
        : 500;
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    return reply.code(statusCode).send({
      error: error instanceof Error ? error.message : "Request failed",
      ...(code ? { code } : {}),
    });
  });
  await registerAuthRoutes(app, pool, config);
  await registerTicketRoutes(app, pool, config);
  await registerNotificationTemplateRoutes(app, pool, config);
  await app.ready();

  mockMailServer = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${providerToken}`) {
        response.writeHead(401);
        response.end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "POST" || url.pathname !== "/v1/mail") {
        response.writeHead(404);
        response.end();
        return;
      }
      const body = await requestJson(request);
      const operationId = typeof body.operationId === "string" ? body.operationId : "";
      if (
        !operationId ||
        request.headers["idempotency-key"] !== operationId ||
        body.scenario !== "delivered"
      ) {
        response.writeHead(400);
        response.end();
        return;
      }
      deliveredMailBodies.set(operationId, body);
      response.writeHead(202, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        operationId,
        status: "delivered",
        deliveredAt: new Date().toISOString(),
      }));
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    mockMailServer!.once("error", reject);
    mockMailServer!.listen(0, "127.0.0.1", resolve);
  });
  mockMailProviderUrl =
    `http://127.0.0.1:${(mockMailServer.address() as AddressInfo).port}`;

  const jobClaimModuleUrl = new URL(
    ["../../worker/dist/", "job-claim.js"].join(""),
    import.meta.url,
  );
  const notificationModuleUrl = new URL(
    ["../../worker/dist/", "notification-orchestration.js"].join(""),
    import.meta.url,
  );
  const jobClaimModule = await import(jobClaimModuleUrl.href) as Readonly<{
    claimSchema016Job<T>(
      pool: DatabasePool,
      workerId: string,
    ): Promise<T | null>;
  }>;
  const notificationModule = await import(notificationModuleUrl.href) as Readonly<{
    processNotificationDeliveryJob(
      pool: DatabasePool,
      job: WorkerNotificationJob,
      input: Readonly<{
        workerId: string;
        providerUrl: string;
        providerToken: string;
        providerTimeoutMs: number;
        maxAttempts: number;
        retryBaseDelaySeconds: number;
        scenario: "delivered";
      }>,
    ): Promise<void>;
  }>;
  const workerRuntimeConfig = {
    workerId,
    providerUrl: mockMailProviderUrl,
    providerToken,
    providerTimeoutMs: 2_000,
    maxAttempts: 3,
    retryBaseDelaySeconds: 1,
    scenario: "delivered" as const,
  };

  try {
    const email = `notification-preference-${randomUUID()}@example.invalid`;
    const password = "Mock-Laboratory-Only-027!";
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email,
        password,
        locale: "en",
        clientName: "Notification preferences normal integration",
      },
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const principal = json<{ userId: string; clientAccountId: string }>(registered);

    const verification = await pool.query<{
      verification_url: string;
      verification_token_id: string;
      expires_at: string;
    }>(
      `SELECT payload ->> 'verificationUrl' AS verification_url,
              payload ->> 'verificationTokenId' AS verification_token_id,
              payload ->> 'expiresAt' AS expires_at
       FROM public.outbox
       WHERE event_type = 'notification.email_verification_requested'
         AND payload ->> 'userId' = $1`,
      [principal.userId],
    );
    const verificationUrl = verification.rows[0]?.verification_url;
    assert.ok(verificationUrl);
    const verificationTokenId = verification.rows[0]?.verification_token_id;
    const verificationExpiresAt = verification.rows[0]?.expires_at;
    assert.ok(verificationTokenId);
    assert.ok(verificationExpiresAt);

    const replayedRegistration = await transaction(pool, (client) => enqueueNotification(client, {
      eventType: "notification.email_verification_requested",
      uniqueKey: `registration:${principal.userId}`,
      payload: {
        verificationTokenId,
        verificationUrl,
        expiresAt: verificationExpiresAt,
      },
      recipient: {
        kind: "identity_user",
        category: "identity",
        userId: principal.userId,
        email,
        locale: "en",
      },
    }));
    assert.equal(replayedRegistration.status, "queued");
    const registrationAttempt = await pool.query<{
      operation_count: string;
      template_revision: string;
      template_locale: string;
    }>(
      `SELECT pg_catalog.count(*) OVER ()::text AS operation_count,
              template_revision, template_locale
       FROM public.notification_delivery_operations
       WHERE outbox_id = $1`,
      [replayedRegistration.outboxId],
    );
    assert.deepEqual(registrationAttempt.rows[0], {
      operation_count: "1",
      template_revision: "email-verification-v1",
      template_locale: "en",
    });

    const verificationToken = new URL(verificationUrl).searchParams.get("token");
    assert.ok(verificationToken);
    const verified = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email",
      payload: { token: verificationToken },
    });
    assert.equal(verified.statusCode, 200, verified.body);
    assert.deepEqual(json(verified), { status: "verified" });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password },
    });
    assert.equal(login.statusCode, 200, login.body);
    const session = login.cookies.find(
      (candidate) => candidate.name === config.SESSION_COOKIE_NAME,
    );
    assert.ok(session);
    const headers = { cookie: `${session.name}=${session.value}` };
    const accountContextVersion = login.headers["x-oss-account-context-version"];
    assert.equal(typeof accountContextVersion, "string");
    const accountHeaders = {
      ...headers,
      "x-oss-account-context-version": accountContextVersion as string,
    };

    const ticketSubject = "Notification preferences normal journey";
    const createdTicket = await app.inject({
      method: "POST",
      url: "/api/v1/tickets",
      headers: accountHeaders,
      payload: {
        subject: ticketSubject,
        message: "Create an ordinary Support ticket for notification delivery checks.",
      },
    });
    assert.equal(createdTicket.statusCode, 201, createdTicket.body);
    const ticketId = json<{ ticket: { id: string } }>(createdTicket).ticket.id;

    const initial = await app.inject({
      method: "GET",
      url: "/api/v1/customer/notification-preferences",
      headers,
    });
    assert.equal(initial.statusCode, 200, initial.body);
    const initialCategories = json<{
      channel: string;
      categories: Array<{
        category: string;
        mandatory: boolean;
        enabled: boolean;
        version: string;
      }>;
    }>(initial);
    assert.equal(initialCategories.channel, "email");
    assert.equal(initialCategories.categories.length, 6);
    assert.ok(
      initialCategories.categories
        .filter((category) => category.mandatory)
        .every((category) => category.enabled && category.version === "0"),
    );

    const required = await app.inject({
      method: "PUT",
      url: "/api/v1/customer/notification-preferences/identity/email",
      headers,
      payload: { enabled: false, expectedVersion: "0" },
    });
    assert.equal(required.statusCode, 409, required.body);
    assert.equal(json<{ code: string }>(required).code, "NOTIFICATION_PREFERENCE_REQUIRED");

    const disabled = await app.inject({
      method: "PUT",
      url: "/api/v1/customer/notification-preferences/support/email",
      headers,
      payload: { enabled: false, expectedVersion: "0" },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.deepEqual(
      {
        category: json<{ category: string }>(disabled).category,
        enabled: json<{ enabled: boolean }>(disabled).enabled,
        version: json<{ version: string }>(disabled).version,
      },
      { category: "support", enabled: false, version: "1" },
    );

    const bootstrapCredential = await issueInitialStaffBootstrapToken(pool);
    const bootstrapped = await app.inject({
      method: "POST",
      url: "/api/v1/admin/bootstrap",
      headers,
      payload: { bootstrapToken: bootstrapCredential.token },
    });
    assert.equal(bootstrapped.statusCode, 201, bootstrapped.body);
    const reauthenticated = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reauth",
      headers,
      payload: { password },
    });
    assert.equal(reauthenticated.statusCode, 200, reauthenticated.body);

    const disabledMessageId = randomUUID();
    const disabledMessage = "This ordinary public Staff reply must honor the disabled preference.";
    const disabledReply = await app.inject({
      method: "POST",
      url: `/api/v1/admin/tickets/${ticketId}/messages`,
      headers,
      payload: {
        kind: "public_reply",
        message: disabledMessage,
        idempotencyKey: disabledMessageId,
      },
    });
    assert.equal(disabledReply.statusCode, 201, disabledReply.body);
    const disabledSupportAttempt = await pool.query<{
      status: string;
      last_error: string;
      operation_count: string;
    }>(
      `SELECT status, last_error,
              pg_catalog.count(*) OVER ()::text AS operation_count
       FROM public.notification_delivery_operations operation
       JOIN public.outbox event ON event.id = operation.outbox_id
       WHERE event.unique_key = $1`,
      [`support-ticket-reply:${disabledMessageId}`],
    );
    assert.deepEqual(disabledSupportAttempt.rows[0], {
      status: "skipped",
      last_error: "USER_NOTIFICATION_PREFERENCE_DISABLED",
      operation_count: "1",
    });

    const locale = await app.inject({
      method: "PUT",
      url: "/api/v1/auth/locale",
      headers,
      payload: { locale: "zh-CN" },
    });
    assert.equal(locale.statusCode, 200, locale.body);
    const enabled = await app.inject({
      method: "PUT",
      url: "/api/v1/customer/notification-preferences/support/email",
      headers,
      payload: { enabled: true, expectedVersion: "1" },
    });
    assert.equal(enabled.statusCode, 200, enabled.body);
    assert.equal(json<{ version: string }>(enabled).version, "2");

    const frozenMessageId = randomUUID();
    const frozenMessage = "The initially selected template revision must remain immutable.";
    const frozenReply = await app.inject({
      method: "POST",
      url: `/api/v1/admin/tickets/${ticketId}/messages`,
      headers,
      payload: {
        kind: "public_reply",
        message: frozenMessage,
        idempotencyKey: frozenMessageId,
      },
    });
    assert.equal(frozenReply.statusCode, 201, frozenReply.body);
    const frozenSupportAttempt = await pool.query<{
      outbox_id: string;
      status: string;
      template_revision: string;
      template_locale: string;
    }>(
      `SELECT operation.outbox_id::text, operation.status,
              operation.template_revision, operation.template_locale
       FROM public.notification_delivery_operations operation
       JOIN public.outbox event ON event.id = operation.outbox_id
       WHERE event.unique_key = $1 AND operation.attempt_number = 1`,
      [`support-ticket-reply:${frozenMessageId}`],
    );
    assert.deepEqual(
      {
        status: frozenSupportAttempt.rows[0]?.status,
        templateRevision: frozenSupportAttempt.rows[0]?.template_revision,
        templateLocale: frozenSupportAttempt.rows[0]?.template_locale,
      },
      {
        status: "queued",
        templateRevision: "support-ticket-reply-v1",
        templateLocale: "zh-CN",
      },
    );
    const frozenSupportOutboxId = frozenSupportAttempt.rows[0]?.outbox_id;
    assert.ok(frozenSupportOutboxId);
    const frozenSupportInput = {
      eventType: "notification.support_ticket_reply_requested",
      uniqueKey: `support-ticket-reply:${frozenMessageId}`,
      payload: {
        ticketId,
        ticketMessageId: frozenMessageId,
        ticketSubject,
        ticketMessage: frozenMessage,
      },
      recipient: {
        kind: "account_user" as const,
        category: "support" as const,
        userId: principal.userId,
        clientAccountId: principal.clientAccountId,
        email,
        locale: "zh-CN" as const,
      },
    };

    const preferenceFacts = await pool.query<{ change_count: string }>(
      `SELECT pg_catalog.count(*)::text AS change_count
       FROM public.user_notification_preference_changes
       WHERE user_id = $1 AND category = 'support' AND channel = 'email'`,
      [principal.userId],
    );
    assert.equal(preferenceFacts.rows[0]?.change_count, "2");

    const chineseTemplate = await resolveCurrentNotificationTemplate(
      pool,
      "notification.support_ticket_reply_requested",
      "zh-CN",
    );
    assert.equal(chineseTemplate.templateLocale, "zh-CN");
    assert.equal(chineseTemplate.revisionKey, "support-ticket-reply-v1");
    assert.equal(chineseTemplate.fallback, false);

    const registry = await app.inject({
      method: "GET",
      url: "/api/v1/admin/notification-templates",
      headers,
    });
    assert.equal(registry.statusCode, 200, registry.body);
    const registryBody = json<{
      events: Array<{
        eventType: string;
        locales: Array<{
          locale: string;
          channelVersion: string;
          currentRevisionId: string | null;
          fallback: boolean;
        }>;
      }>;
    }>(registry);
    const supportEvent = registryBody.events.find(
      (event) => event.eventType === "notification.support_ticket_reply_requested",
    );
    const supportChineseChannel = supportEvent?.locales.find(
      (channel) => channel.locale === "zh-CN",
    );
    const supportEnglishChannel = supportEvent?.locales.find(
      (channel) => channel.locale === "en",
    );
    assert.equal(supportChineseChannel?.channelVersion, "1");
    assert.ok(supportChineseChannel?.currentRevisionId);
    assert.equal(supportEnglishChannel?.channelVersion, "1");
    assert.ok(supportEnglishChannel?.currentRevisionId);

    const missingRequiredVariable = await app.inject({
      method: "POST",
      url: "/api/v1/admin/notification-templates/notification.email_verification_requested/revisions",
      headers,
      payload: {
        intentId: randomUUID(),
        locale: "en",
        subjectTemplate: "Verification message",
        bodyTemplate:
          "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\nThis draft omits its action URL.",
        reason: "Prove required variables cannot be omitted",
      },
    });
    assert.equal(missingRequiredVariable.statusCode, 400, missingRequiredVariable.body);
    assert.equal(
      json<{ code: string }>(missingRequiredVariable).code,
      "NOTIFICATION_TEMPLATE_VARIABLE_REQUIRED",
    );

    const englishRetirement = await app.inject({
      method: "POST",
      url: `/api/v1/admin/notification-templates/notification.support_ticket_reply_requested/revisions/${supportEnglishChannel!.currentRevisionId}/retire`,
      headers,
      payload: {
        intentId: randomUUID(),
        reason: "Prove the English fallback cannot be removed",
        expectedChannelVersion: supportEnglishChannel!.channelVersion,
      },
    });
    assert.equal(englishRetirement.statusCode, 409, englishRetirement.body);
    assert.equal(
      json<{ code: string }>(englishRetirement).code,
      "NOTIFICATION_TEMPLATE_ENGLISH_FALLBACK_REQUIRED",
    );

    const createdOlderRevision = await app.inject({
      method: "POST",
      url: "/api/v1/admin/notification-templates/notification.support_ticket_reply_requested/revisions",
      headers,
      payload: {
        intentId: randomUUID(),
        locale: "zh-CN",
        subjectTemplate: "支持工单回复：{{ticketSubject}}",
        bodyTemplate:
          "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n工单：{{ticketId}}\n\n{{ticketMessage}}",
        reason: "Create the older reviewed Chinese support revision",
      },
    });
    assert.equal(createdOlderRevision.statusCode, 201, createdOlderRevision.body);
    const olderDraft = json<{
      revisionId: string;
      revisionKey: string;
      revisionNumber: string;
    }>(createdOlderRevision);
    assert.equal(olderDraft.revisionNumber, "2");

    const newerRevisionIntentId = randomUUID();
    const newerRevisionPayload = {
      intentId: newerRevisionIntentId,
      locale: "zh-CN",
      subjectTemplate: "支持工单最新回复：{{ticketSubject}}",
      bodyTemplate:
        "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n工单：{{ticketId}}\n\n最新回复：{{ticketMessage}}",
      reason: "Create the newer reviewed Chinese support revision",
    };
    const createdNewerRevision = await app.inject({
      method: "POST",
      url: "/api/v1/admin/notification-templates/notification.support_ticket_reply_requested/revisions",
      headers,
      payload: newerRevisionPayload,
    });
    assert.equal(createdNewerRevision.statusCode, 201, createdNewerRevision.body);
    const newerDraft = json<{
      revisionId: string;
      revisionKey: string;
      revisionNumber: string;
    }>(createdNewerRevision);
    assert.equal(newerDraft.revisionNumber, "3");

    const replayedNewerRevision = await app.inject({
      method: "POST",
      url: "/api/v1/admin/notification-templates/notification.support_ticket_reply_requested/revisions",
      headers,
      payload: newerRevisionPayload,
    });
    assert.equal(
      replayedNewerRevision.statusCode,
      createdNewerRevision.statusCode,
      replayedNewerRevision.body,
    );
    assert.equal(replayedNewerRevision.body, createdNewerRevision.body);
    const conflictingNewerRevision = await app.inject({
      method: "POST",
      url: "/api/v1/admin/notification-templates/notification.support_ticket_reply_requested/revisions",
      headers,
      payload: {
        ...newerRevisionPayload,
        subjectTemplate: "同一 intent 不可承载不同模板",
      },
    });
    assert.equal(conflictingNewerRevision.statusCode, 409, conflictingNewerRevision.body);
    assert.equal(
      json<{ code: string }>(conflictingNewerRevision).code,
      "STAFF_ACTION_INTENT_CONFLICT",
    );
    const newerRevisionFacts = await pool.query<{
      revision_count: string;
      ledger_count: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT
         (SELECT pg_catalog.count(*)::text
          FROM public.notification_template_revisions revision
          WHERE revision.id = $1) AS revision_count,
         pg_catalog.count(*)::text AS ledger_count,
         pg_catalog.min(event.metadata::text)::jsonb AS metadata
       FROM public.audit_events event
       WHERE event.actor_type = 'staff'
         AND event.actor_id = $2
         AND event.target_type = 'staff_action_intent'
         AND event.target_id = $3`,
      [newerDraft.revisionId, principal.userId, newerRevisionIntentId],
    );
    assert.deepEqual(
      {
        revisionCount: newerRevisionFacts.rows[0]?.revision_count,
        ledgerCount: newerRevisionFacts.rows[0]?.ledger_count,
        metadataKeys: Object.keys(newerRevisionFacts.rows[0]?.metadata ?? {}).sort(),
      },
      {
        revisionCount: "1",
        ledgerCount: "1",
        metadataKeys: ["requestFingerprint", "responseBody", "responseStatus"],
      },
    );

    const published = await app.inject({
      method: "POST",
      url: `/api/v1/admin/notification-templates/notification.support_ticket_reply_requested/revisions/${newerDraft.revisionId}/publish`,
      headers,
      payload: {
        intentId: randomUUID(),
        reason: "Publish the reviewed Chinese support revision",
        expectedChannelVersion: supportChineseChannel!.channelVersion,
      },
    });
    assert.equal(published.statusCode, 201, published.body);
    assert.equal(json<{ channelVersion: string }>(published).channelVersion, "2");
    const replacedChineseTemplate = await resolveCurrentNotificationTemplate(
      pool,
      "notification.support_ticket_reply_requested",
      "zh-CN",
    );
    assert.equal(replacedChineseTemplate.revisionId, newerDraft.revisionId);
    assert.equal(replacedChineseTemplate.revisionKey, newerDraft.revisionKey);

    const replayedPublication = await app.inject({
      method: "POST",
      url: `/api/v1/admin/notification-templates/notification.support_ticket_reply_requested/revisions/${newerDraft.revisionId}/publish`,
      headers,
      payload: {
        intentId: randomUUID(),
        reason: "Publish the reviewed Chinese support revision",
        expectedChannelVersion: supportChineseChannel!.channelVersion,
      },
    });
    assert.equal(replayedPublication.statusCode, 200, replayedPublication.body);
    assert.equal(json<{ replayed: boolean }>(replayedPublication).replayed, true);

    const stalePublication = await app.inject({
      method: "POST",
      url: `/api/v1/admin/notification-templates/notification.support_ticket_reply_requested/revisions/${olderDraft.revisionId}/publish`,
      headers,
      payload: {
        intentId: randomUUID(),
        reason: "A newer revision must not be replaced by this older draft",
        expectedChannelVersion: "2",
      },
    });
    assert.equal(stalePublication.statusCode, 409, stalePublication.body);
    assert.equal(
      json<{ code: string }>(stalePublication).code,
      "NOTIFICATION_TEMPLATE_REVISION_NOT_NEWER",
    );

    const replayedFrozenSupport = await transaction(pool, (client) =>
      enqueueNotification(client, frozenSupportInput));
    assert.equal(replayedFrozenSupport.outboxId, frozenSupportOutboxId);
    const frozenAttempt = await pool.query<{
      operation_count: string;
      template_revision: string;
      template_locale: string;
    }>(
      `SELECT pg_catalog.count(*) OVER ()::text AS operation_count,
              template_revision, template_locale
       FROM public.notification_delivery_operations
       WHERE outbox_id = $1`,
      [frozenSupportOutboxId],
    );
    assert.deepEqual(frozenAttempt.rows[0], {
      operation_count: "1",
      template_revision: "support-ticket-reply-v1",
      template_locale: "zh-CN",
    });

    let processedFrozenSupport = false;
    for (let processed = 0; processed < 4 && !processedFrozenSupport; processed += 1) {
      const claimedJob: WorkerNotificationJob | null =
        await jobClaimModule.claimSchema016Job<WorkerNotificationJob>(
        workerPool,
        workerId,
      );
      assert.ok(claimedJob, "expected a pending normal notification Worker job");
      assert.equal(claimedJob.job_type, "notification.send");
      await notificationModule.processNotificationDeliveryJob(
        workerPool,
        claimedJob,
        workerRuntimeConfig,
      );
      processedFrozenSupport = claimedJob.payload.outboxId === frozenSupportOutboxId;
    }
    assert.equal(processedFrozenSupport, true);
    const deliveredFrozenAttempt = await pool.query<{
      status: string;
      template_revision: string;
      provider_operation_id: string;
      fact_status: string | null;
    }>(
      `SELECT operation.status, operation.template_revision,
              operation.provider_operation_id::text,
              fact.status AS fact_status
       FROM public.notification_delivery_operations operation
       LEFT JOIN public.notification_delivery_facts fact
         ON fact.outbox_id = operation.outbox_id
        AND fact.attempt_number = operation.attempt_number
        AND fact.provider_operation_id = operation.provider_operation_id
       WHERE operation.outbox_id = $1 AND operation.attempt_number = 1`,
      [frozenSupportOutboxId],
    );
    assert.deepEqual(
      {
        status: deliveredFrozenAttempt.rows[0]?.status,
        templateRevision: deliveredFrozenAttempt.rows[0]?.template_revision,
        factStatus: deliveredFrozenAttempt.rows[0]?.fact_status,
      },
      {
        status: "succeeded",
        templateRevision: "support-ticket-reply-v1",
        factStatus: "delivered",
      },
    );
    const frozenMail = deliveredMailBodies.get(
      deliveredFrozenAttempt.rows[0]!.provider_operation_id,
    );
    assert.ok(frozenMail, "expected the real Worker request to be visible in Mock Mail");
    assert.equal(frozenMail.template, "support-ticket-reply-v1");
    assert.equal(frozenMail.locale, "zh-CN");
    assert.equal(frozenMail.recipient, email);
    assert.match(String(frozenMail.body), new RegExp(frozenMessage));
    assert.doesNotMatch(String(frozenMail.body), /最新回复：/);

    const currentMessageId = randomUUID();
    const currentReply = await app.inject({
      method: "POST",
      url: `/api/v1/admin/tickets/${ticketId}/messages`,
      headers,
      payload: {
        kind: "public_reply",
        message: "This ordinary reply must select the newly published revision.",
        idempotencyKey: currentMessageId,
      },
    });
    assert.equal(currentReply.statusCode, 201, currentReply.body);
    const currentAttempt = await pool.query<{
      outbox_id: string;
      status: string;
      template_revision: string;
    }>(
      `SELECT operation.outbox_id::text, operation.status, operation.template_revision
       FROM public.notification_delivery_operations operation
       JOIN public.outbox event ON event.id = operation.outbox_id
       WHERE event.unique_key = $1 AND operation.attempt_number = 1`,
      [`support-ticket-reply:${currentMessageId}`],
    );
    assert.equal(currentAttempt.rows[0]?.status, "queued");
    assert.equal(currentAttempt.rows[0]?.template_revision, newerDraft.revisionKey);
    const currentOutboxId = currentAttempt.rows[0]?.outbox_id;
    assert.ok(currentOutboxId);

    const disabledBeforeDequeue = await app.inject({
      method: "PUT",
      url: "/api/v1/customer/notification-preferences/support/email",
      headers,
      payload: { enabled: false, expectedVersion: "2" },
    });
    assert.equal(disabledBeforeDequeue.statusCode, 200, disabledBeforeDequeue.body);
    assert.deepEqual(
      {
        enabled: json<{ enabled: boolean }>(disabledBeforeDequeue).enabled,
        version: json<{ version: string }>(disabledBeforeDequeue).version,
      },
      { enabled: false, version: "3" },
    );

    const currentJob = await jobClaimModule.claimSchema016Job<WorkerNotificationJob>(
      workerPool,
      workerId,
    );
    assert.ok(currentJob, "expected the newly published revision Worker job");
    assert.equal(currentJob.job_type, "notification.send");
    assert.equal(currentJob.payload.outboxId, currentOutboxId);
    await notificationModule.processNotificationDeliveryJob(
      workerPool,
      currentJob,
      workerRuntimeConfig,
    );
    const currentAfterDequeue = await pool.query<{
      status: string;
      last_error: string | null;
      template_revision: string;
      fact_status: string | null;
      fact_failure_reason: string | null;
    }>(
      `SELECT operation.status, operation.last_error, operation.template_revision,
              fact.status AS fact_status,
              fact.failure_reason AS fact_failure_reason
       FROM public.notification_delivery_operations operation
       LEFT JOIN public.notification_delivery_facts fact
         ON fact.outbox_id = operation.outbox_id
        AND fact.attempt_number = operation.attempt_number
        AND fact.provider_operation_id = operation.provider_operation_id
       WHERE operation.outbox_id = $1 AND operation.attempt_number = 1`,
      [currentOutboxId],
    );
    assert.deepEqual(currentAfterDequeue.rows[0], {
      status: "skipped",
      last_error: "USER_NOTIFICATION_PREFERENCE_DISABLED",
      template_revision: newerDraft.revisionKey,
      fact_status: "skipped",
      fact_failure_reason: "USER_NOTIFICATION_PREFERENCE_DISABLED",
    });
    assert.equal(deliveredMailBodies.size, 1);

    const concurrentPreferenceUpdates = await Promise.all([
      app.inject({
        method: "PUT",
        url: "/api/v1/customer/notification-preferences/support/email",
        headers,
        payload: { enabled: true, expectedVersion: "3" },
      }),
      app.inject({
        method: "PUT",
        url: "/api/v1/customer/notification-preferences/support/email",
        headers,
        payload: { enabled: true, expectedVersion: "3" },
      }),
    ]);
    assert.deepEqual(
      concurrentPreferenceUpdates.map((response) => response.statusCode).sort(),
      [200, 409],
    );
    const stalePreferenceUpdate = concurrentPreferenceUpdates.find(
      (response) => response.statusCode === 409,
    );
    assert.equal(
      json<{ code: string }>(stalePreferenceUpdate!).code,
      "NOTIFICATION_PREFERENCE_STALE",
    );

    const retired = await app.inject({
      method: "POST",
      url: `/api/v1/admin/notification-templates/notification.support_ticket_reply_requested/revisions/${newerDraft.revisionId}/retire`,
      headers,
      payload: {
        intentId: randomUUID(),
        reason: "Retire the current Chinese support revision to use English fallback",
        expectedChannelVersion: "2",
      },
    });
    assert.equal(retired.statusCode, 201, retired.body);
    assert.equal(json<{ channelVersion: string }>(retired).channelVersion, "3");
    const replayedRetirement = await app.inject({
      method: "POST",
      url: `/api/v1/admin/notification-templates/notification.support_ticket_reply_requested/revisions/${newerDraft.revisionId}/retire`,
      headers,
      payload: {
        intentId: randomUUID(),
        reason: "Retire the current Chinese support revision to use English fallback",
        expectedChannelVersion: "2",
      },
    });
    assert.equal(replayedRetirement.statusCode, 200, replayedRetirement.body);
    assert.equal(json<{ replayed: boolean }>(replayedRetirement).replayed, true);
    const fallbackTemplate = await resolveCurrentNotificationTemplate(
      pool,
      "notification.support_ticket_reply_requested",
      "zh-CN",
    );
    assert.equal(fallbackTemplate.templateLocale, "en");
    assert.equal(fallbackTemplate.requestedLocale, "zh-CN");
    assert.equal(fallbackTemplate.fallback, true);
    assert.equal(fallbackTemplate.revisionKey, "support-ticket-reply-v1");

    console.log(
      "Notification preferences/templates PostgreSQL 18 integration: PASS — real registration and verification, required preference, optional enqueue/dequeue checks, Staff create/publish/retire, English fallback, immutable revision delivery through Mock Mail, monotonic publication, and same-intent replay.",
    );
  } finally {
    await app.close();
  }
} finally {
  const cleanupErrors: unknown[] = [];
  if (mockMailServer) {
    try {
      await new Promise<void>((resolve, reject) =>
        mockMailServer!.close((error) => error ? reject(error) : resolve()),
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await workerPool?.end();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await pool?.end();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await waitForDatabaseConnectionsToClose();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await admin.query(`DROP ROLE IF EXISTS "${apiRole}"`);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await admin.query(`DROP ROLE IF EXISTS "${workerRole}"`);
  } catch (error) {
    cleanupErrors.push(error);
  } finally {
    try {
      await admin.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "Notification preferences integration cleanup failed",
    );
  }
}
