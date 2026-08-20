// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import pg from "pg";
import { digestToken } from "./auth.js";
import type { Config } from "./config.js";
import { runMigrations, transaction, type DatabasePool } from "./database.js";
import { registerAuthRoutes } from "./routes-auth.js";
import { registerIdentitySecurityRoutes } from "./routes-identity-security.js";
import { registerNotificationOperationRoutes } from "./routes-notification-operations.js";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) {
  throw new Error("ADMIN_DATABASE_URL is required for Notification Operations integration");
}

const databaseName = `oss_notification_operations_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = new URL(adminDatabaseUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = new pg.Client({ connectionString: adminDatabaseUrl });
let pool: DatabasePool | null = null;

const config: Config = {
  DATABASE_URL: databaseUrl.toString(),
  OSS_ENV: "test",
  OSS_LOG_LEVEL: "silent",
  OSS_PUBLIC_URL: "http://127.0.0.1:3000",
  API_HOST: "127.0.0.1",
  API_PORT: 3000,
  GLOBAL_RATE_LIMIT_MAX: 10_000,
  SESSION_COOKIE_NAME: "oss_notification_operations_session",
  SESSION_TTL_HOURS: 24,
  VERIFICATION_TTL_MINUTES: 30,
  WEB_ORIGIN: "http://127.0.0.1:5173",
  MOCK_MAILBOX_URL: "http://127.0.0.1:4000",
  LAB_MAILBOX_TOKEN: "synthetic-notification-operations-mailbox-token",
  PROVIDER_OPERATION_CAPABILITY_SECRET:
    "synthetic-notification-operations-provider-capability",
  PAYMENT_METHOD_TOKEN_KEY: Buffer.alloc(32, 101).toString("base64url"),
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY: Buffer.alloc(32, 102).toString("base64url"),
  IDENTITY_SECRET_KEY: Buffer.alloc(32, 103).toString("base64url"),
  MOCK_PAYMENT_WEBHOOK_SECRET: "synthetic-notification-operations-payment-hook",
  MOCK_PROVISIONING_WEBHOOK_SECRET:
    "synthetic-notification-operations-provision-hook",
  NOTIFICATION_MAX_ATTEMPTS: 3,
  LAB_MAILBOX_ENABLED: false,
};

type Staff = Readonly<{
  userId: string;
  token: string;
}>;

type Fixture = Readonly<{
  outboxId: string;
  operationId: string;
  jobId: string;
}>;

type StandardFixtureState = "failed" | "unknown" | "manual";

type SnapshotDelivery = Readonly<{
  source: "standard" | "identity";
  outboxId: string;
  operationId: string;
  attemptNumber: number;
  operationStatus: string;
  outcomeStatus: string | null;
  jobStatus: string | null;
  jobUpdatedAt: string | null;
  retryable: boolean;
  retryReason: string;
  templateRevision: string | null;
  payload?: unknown;
  encryptedPayload?: unknown;
}>;

type NotificationSnapshot = Readonly<{
  summary: Readonly<{
    attentionCount: number;
    retryableCount: number;
    oldestTask: Readonly<{ id: string }> | null;
  }>;
  queue: SnapshotDelivery[];
  history: SnapshotDelivery[];
  retryAudit: Array<Readonly<{
    actorId: string;
    outboxId: string;
    reason: string;
  }>>;
}>;

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
        `Notification Operations database still has ${count} connection(s) after pool shutdown`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function createStaff(
  label: string,
  permissions: readonly string[],
  reauthenticated = true,
): Promise<Staff> {
  if (!pool) throw new Error("Notification Operations database is unavailable");
  const userId = randomUUID();
  const sessionId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO public.users(id, email, password_hash, locale, email_verified_at)
       VALUES ($1, $2, 'synthetic-not-a-password', 'en', pg_catalog.now())`,
      [userId, `notification-${label}-${userId}@example.invalid`],
    );
    await client.query(
      `INSERT INTO public.sessions(id, user_id, token_digest, expires_at)
       VALUES ($1, $2, $3, pg_catalog.now() + interval '2 hours')`,
      [sessionId, userId, digestToken(token)],
    );
    await client.query(
      `INSERT INTO public.staff_members(user_id, roles, permissions)
       VALUES ($1, ARRAY['operations']::text[], $2::jsonb)`,
      [userId, JSON.stringify(permissions)],
    );
    if (reauthenticated) {
      await client.query(
        `INSERT INTO public.reauth_grants(user_id, session_id, expires_at)
         VALUES ($1, $2, pg_catalog.now() + interval '10 minutes')`,
        [userId, sessionId],
      );
    }
  });
  return { userId, token };
}

async function createStandardNotification(
  label: string,
  input: Readonly<{
    attemptNumber?: number;
    state?: StandardFixtureState;
  }> = {},
): Promise<Fixture> {
  if (!pool) throw new Error("Notification Operations database is unavailable");
  const client = await pool.connect();
  const userId = randomUUID();
  const tokenId = randomUUID();
  const outboxId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const email = `${label}-${userId}@example.invalid`;
  const expiresAt = "2099-01-01T00:00:00.000Z";
  const attemptNumber = input.attemptNumber ?? 1;
  const state = input.state ?? "failed";
  assert.ok(attemptNumber >= 1 && attemptNumber <= 3);
  const payload = {
    userId,
    email,
    locale: "en",
    verificationUrl: `http://127.0.0.1:5173/verify?token=${token}`,
    expiresAt,
    verificationTokenId: tokenId,
    notificationCategory: "identity",
    notificationRecipientKind: "identity_user",
    notificationRecipientSubjectId: userId,
    notificationRecipientScopeId: userId,
  };
  const rendered = {
    recipient: email,
    template: "email-verification",
    locale: "en",
    subject: "Verify your synthetic OpenSales email",
    body: "Use the one-time synthetic Mock-only verification link.",
    sensitive: true,
    scenario: "failed",
  };
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.users(id, email, password_hash)
       VALUES ($1, $2, 'synthetic-not-a-password')`,
      [userId, email],
    );
    await client.query(
      `INSERT INTO public.email_verification_tokens(
         id, user_id, token_digest, expires_at
       ) VALUES (
         $1, $2,
         public.digest(pg_catalog.convert_to($3, 'UTF8'), 'sha256'),
         $4
       )`,
      [tokenId, userId, token, expiresAt],
    );
    await client.query(
      `INSERT INTO public.outbox(id, event_type, unique_key, payload)
       VALUES ($1, 'notification.email_verification_requested', $2, $3)`,
      [outboxId, `verification:${tokenId}`, payload],
    );
    const job = await client.query<{ id: string }>(
      `INSERT INTO public.durable_jobs(job_type, unique_key, payload)
       VALUES ('notification.send', $1, $2)
       RETURNING id::text`,
      [`outbox:${outboxId}`, { outboxId }],
    );
    const jobId = job.rows[0]?.id;
    assert.ok(jobId);
    let operationId = "";
    for (let currentAttempt = 1; currentAttempt <= attemptNumber; currentAttempt += 1) {
      const identity = await client.query<{
        provider_operation_id: string;
        request_fingerprint: string;
      }>(
        `SELECT
           public.opensales_notification_provider_operation_id($1, $2)::text
             AS provider_operation_id,
           public.opensales_notification_request_fingerprint(
             'notification.email_verification_requested',
             'email-verification-v1',
             $3::jsonb
           ) AS request_fingerprint`,
        [outboxId, currentAttempt, payload],
      );
      const providerOperationId = identity.rows[0]?.provider_operation_id;
      const requestFingerprint = identity.rows[0]?.request_fingerprint;
      assert.ok(providerOperationId);
      assert.ok(requestFingerprint);
      const insertedOperation = await client.query<{ id: string }>(
        `INSERT INTO public.notification_delivery_operations(
           outbox_id, attempt_number, provider_operation_id,
           provider_installation_id, operation_origin,
           event_type, template_revision, payload_snapshot,
           recipient_user_id, recipient_subject_id, recipient_scope_id,
           recipient_kind, category, recipient, locale, request_fingerprint
         ) VALUES (
           $1, $2, $3, 'mock-mail-v1', 'application',
           'notification.email_verification_requested', 'email-verification-v1', $4,
           $5, $5, $5, 'identity_user', 'identity', $6, 'en', $7
         )
         RETURNING id::text`,
        [
          outboxId,
          currentAttempt,
          providerOperationId,
          payload,
          userId,
          email,
          requestFingerprint,
        ],
      );
      operationId = insertedOperation.rows[0]?.id ?? "";
      assert.ok(operationId);

      const currentState = currentAttempt < attemptNumber ? "failed" : state;
      if (currentState === "manual") {
        await client.query(
          `UPDATE public.notification_delivery_operations
           SET status = 'manual', last_error = 'NOTIFICATION_REQUIRES_STAFF_DECISION',
               updated_at = GREATEST(updated_at + interval '1 microsecond',
                                    pg_catalog.clock_timestamp())
           WHERE id = $1`,
          [operationId],
        );
        continue;
      }

      await client.query(
        `UPDATE public.notification_delivery_operations
         SET rendered_request_snapshot = $2,
             rendered_request_fingerprint =
               public.opensales_notification_rendered_request_fingerprint($2::jsonb),
             status = 'dispatching', attempts = 1,
             dispatch_started_at = pg_catalog.clock_timestamp(),
             updated_at = GREATEST(updated_at + interval '1 microsecond',
                                  pg_catalog.clock_timestamp())
         WHERE id = $1`,
        [operationId, rendered],
      );
      await client.query(
        `UPDATE public.notification_delivery_operations
         SET status = $2,
             last_checked_at = pg_catalog.clock_timestamp(),
             last_error = $3,
             updated_at = GREATEST(updated_at + interval '1 microsecond',
                                  pg_catalog.clock_timestamp())
         WHERE id = $1`,
        [
          operationId,
          currentState,
          currentState === "unknown" ? "MOCK_MAIL_RESULT_UNKNOWN" : "MOCK_MAIL_FAILED",
        ],
      );
      if (currentState === "failed") {
        await client.query(
          `INSERT INTO public.notification_delivery_facts(
             outbox_id, attempt_number,
             recipient_user_id, recipient_subject_id, recipient_scope_id,
             recipient_kind, category, recipient, locale,
             provider_installation_id, provider_operation_id, provider_message_id,
             status, failure_reason, provider_occurred_at
           ) VALUES (
             $1, $2, $3, $3, $3, 'identity_user', 'identity', $4, 'en',
             'mock-mail-v1', $5, $6, 'failed', 'MOCK_MAIL_FAILED',
             pg_catalog.clock_timestamp()
           )`,
          [
            outboxId,
            currentAttempt,
            userId,
            email,
            providerOperationId,
            `mock-message-${outboxId}-${currentAttempt}`,
          ],
        );
      }
    }
    await client.query(
      `UPDATE public.durable_jobs
       SET status = $2, attempts = 1,
           last_error = $3,
           updated_at = GREATEST(updated_at + interval '1 microsecond',
                                pg_catalog.clock_timestamp())
       WHERE id = $1`,
      [
        jobId,
        state === "unknown" ? "pending" : "manual",
        state === "unknown"
          ? "NOTIFICATION_RECONCILIATION_PENDING"
          : "NOTIFICATION_REQUIRES_STAFF_DECISION",
      ],
    );
    await client.query("COMMIT");
    return { outboxId, operationId, jobId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createIdentityNotification(app: ReturnType<typeof Fastify>): Promise<string> {
  if (!pool) throw new Error("Notification Operations database is unavailable");
  const userId = randomUUID();
  const email = `identity-${userId}@example.invalid`;
  await pool.query(
    `INSERT INTO public.users(id, email, password_hash, locale, email_verified_at)
     VALUES ($1, $2, 'synthetic-not-a-password', 'en', pg_catalog.now())`,
    [userId, email],
  );
  const requested = await app.inject({
    method: "POST",
    url: "/api/v1/auth/password-recovery/request",
    payload: { email },
  });
  assert.equal(requested.statusCode, 202, requested.body);
  const outbox = await pool.query<{ id: string }>(
    `SELECT id::text FROM public.identity_notification_outbox
     WHERE user_id = $1 AND kind = 'password_recovery'`,
    [userId],
  );
  const outboxId = outbox.rows[0]?.id;
  assert.ok(outboxId);
  return outboxId;
}

async function buildTestApp(maximumAttempts: number): Promise<ReturnType<typeof Fastify>> {
  if (!pool) throw new Error("Notification Operations database is unavailable");
  const app = Fastify({ logger: false });
  const testConfig: Config = {
    ...config,
    NOTIFICATION_MAX_ATTEMPTS: maximumAttempts,
  };
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
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
  await registerAuthRoutes(app, pool, testConfig);
  await registerIdentitySecurityRoutes(app, pool, testConfig);
  await registerNotificationOperationRoutes(app, pool, testConfig);
  await app.ready();
  return app;
}

function deliveryFor(
  snapshot: NotificationSnapshot,
  outboxId: string,
  collection: "queue" | "history" = "queue",
): SnapshotDelivery {
  const delivery = snapshot[collection].find((candidate) => candidate.outboxId === outboxId);
  assert.ok(delivery, `Expected ${collection} delivery for ${outboxId}`);
  return delivery;
}

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  pool = new pg.Pool({
    connectionString: databaseUrl.toString(),
    max: 10,
    options: "-c search_path=pg_catalog,public",
    statement_timeout: 15_000,
    application_name: "opensales-notification-operations-integration",
  });
  await runMigrations(pool);

  const manager = await createStaff("manager", ["notifications.read", "notifications.retry"]);
  const retryOnly = await createStaff("retry-only", ["notifications.retry"]);
  const reader = await createStaff("reader", ["notifications.read"]);
  const outsider = await createStaff("outsider", []);
  const noReauth = await createStaff("no-reauth", ["notifications.retry"], false);

  const failed = await createStandardNotification("failed");
  const unknown = await createStandardNotification("unknown", { state: "unknown" });
  const manual = await createStandardNotification("manual", { state: "manual" });
  const budgetOneAtOne = await createStandardNotification("budget-one-at-one");
  const budgetTwoAtOne = await createStandardNotification("budget-two-at-one");
  const budgetTwoAtTwo = await createStandardNotification("budget-two-at-two", {
    attemptNumber: 2,
  });
  const budgetThreeAtTwo = await createStandardNotification("budget-three-at-two", {
    attemptNumber: 2,
  });
  const budgetThreeAtThree = await createStandardNotification("budget-three-at-three", {
    attemptNumber: 3,
  });

  const [appOne, appTwo, appThree] = await Promise.all([
    buildTestApp(1),
    buildTestApp(2),
    buildTestApp(3),
  ]);

  try {
    const cookieFor = (staff: Staff) => ({
      cookie: `${config.SESSION_COOKIE_NAME}=${staff.token}`,
    });
    const readSnapshot = async (
      app: ReturnType<typeof Fastify>,
      staff: Staff = reader,
    ): Promise<NotificationSnapshot> => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/notification-operations",
        headers: cookieFor(staff),
      });
      assert.equal(response.statusCode, 200, response.body);
      return json<NotificationSnapshot>(response);
    };
    const rejectedRetry = async (
      app: ReturnType<typeof Fastify>,
      staff: Staff,
      fixture: Readonly<{ outboxId: string }>,
      expectedJobUpdatedAt: string,
      expectedCode: string,
    ): Promise<void> => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/notification-operations/${fixture.outboxId}/retry`,
        headers: cookieFor(staff),
        payload: {
          reason: "Normal product retry eligibility review",
          expectedJobUpdatedAt,
        },
      });
      assert.equal(response.statusCode, expectedCode === "STAFF_AUTHORIZATION_REQUIRED" ? 403 : 409, response.body);
      assert.equal(json<{ code: string }>(response).code, expectedCode);
    };

    const forbidden = await appThree.inject({
      method: "GET",
      url: "/api/v1/admin/notification-operations",
      headers: cookieFor(outsider),
    });
    assert.equal(forbidden.statusCode, 403, forbidden.body);

    const identityOutboxId = await createIdentityNotification(appThree);
    const snapshotThree = await readSnapshot(appThree);
    assert.ok(snapshotThree.summary.attentionCount >= 8);
    assert.ok(snapshotThree.summary.retryableCount >= 5);
    assert.ok(snapshotThree.summary.oldestTask);

    const failedDelivery = deliveryFor(snapshotThree, failed.outboxId);
    assert.deepEqual(
      {
        outboxId: failedDelivery.outboxId,
        operationId: failedDelivery.operationId,
        operationStatus: failedDelivery.operationStatus,
        outcomeStatus: failedDelivery.outcomeStatus,
        jobStatus: failedDelivery.jobStatus,
        retryable: failedDelivery.retryable,
        templateRevision: failedDelivery.templateRevision,
      },
      {
        outboxId: failed.outboxId,
        operationId: failed.operationId,
        operationStatus: "failed",
        outcomeStatus: "failed",
        jobStatus: "manual",
        retryable: true,
        templateRevision: "email-verification-v1",
      },
    );
    assert.equal("payload" in failedDelivery, false);
    assert.equal("encryptedPayload" in failedDelivery, false);
    assert.match(
      failedDelivery.jobUpdatedAt ?? "",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    );

    const identityDelivery = deliveryFor(snapshotThree, identityOutboxId, "history");
    assert.equal(identityDelivery.source, "identity");
    assert.equal(identityDelivery.retryable, false);
    assert.match(identityDelivery.retryReason, /identity workflow/i);
    assert.equal("payload" in identityDelivery, false);
    assert.equal("encryptedPayload" in identityDelivery, false);
    assert.ok(identityDelivery.jobUpdatedAt);

    const readerRetry = await appThree.inject({
      method: "POST",
      url: `/api/v1/admin/notification-operations/${failed.outboxId}/retry`,
      headers: cookieFor(reader),
      payload: {
        reason: "Synthetic reader must not retry",
        expectedJobUpdatedAt: failedDelivery.jobUpdatedAt,
      },
    });
    assert.equal(readerRetry.statusCode, 403, readerRetry.body);

    await rejectedRetry(
      appThree,
      noReauth,
      failed,
      failedDelivery.jobUpdatedAt!,
      "STAFF_AUTHORIZATION_REQUIRED",
    );

    const staleRetry = await appThree.inject({
      method: "POST",
      url: `/api/v1/admin/notification-operations/${failed.outboxId}/retry`,
      headers: cookieFor(retryOnly),
      payload: {
        reason: "Synthetic stale retry",
        expectedJobUpdatedAt: "2020-01-01T00:00:00.000000Z",
      },
    });
    assert.equal(staleRetry.statusCode, 409, staleRetry.body);
    assert.equal(json<{ code: string }>(staleRetry).code, "NOTIFICATION_RETRY_STALE");

    const unknownDelivery = deliveryFor(snapshotThree, unknown.outboxId);
    assert.equal(unknownDelivery.retryable, false);
    assert.match(unknownDelivery.retryReason, /reconcile/);
    await rejectedRetry(
      appThree,
      manager,
      unknown,
      unknownDelivery.jobUpdatedAt!,
      "NOTIFICATION_RETRY_NOT_ALLOWED",
    );

    const manualDelivery = deliveryFor(snapshotThree, manual.outboxId);
    assert.equal(manualDelivery.retryable, false);
    assert.match(manualDelivery.retryReason, /cannot be reopened/);
    await rejectedRetry(
      appThree,
      manager,
      manual,
      manualDelivery.jobUpdatedAt!,
      "NOTIFICATION_RETRY_NOT_ALLOWED",
    );

    const identityRetry = await appThree.inject({
      method: "POST",
      url: `/api/v1/admin/notification-operations/${identityOutboxId}/retry`,
      headers: cookieFor(manager),
      payload: {
        reason: "Identity recovery remains in its dedicated workflow",
        expectedJobUpdatedAt: identityDelivery.jobUpdatedAt,
      },
    });
    assert.equal(identityRetry.statusCode, 404, identityRetry.body);
    assert.equal(json<{ code: string }>(identityRetry).code, "NOTIFICATION_NOT_FOUND");

    const snapshotOne = await readSnapshot(appOne);
    const oneAtOne = deliveryFor(snapshotOne, budgetOneAtOne.outboxId);
    assert.equal(oneAtOne.retryable, false);
    assert.match(oneAtOne.retryReason, /configured 1-attempt/);
    await rejectedRetry(
      appOne,
      manager,
      budgetOneAtOne,
      oneAtOne.jobUpdatedAt!,
      "NOTIFICATION_RETRY_NOT_ALLOWED",
    );

    const snapshotTwo = await readSnapshot(appTwo);
    const twoAtOne = deliveryFor(snapshotTwo, budgetTwoAtOne.outboxId);
    const twoAtTwo = deliveryFor(snapshotTwo, budgetTwoAtTwo.outboxId);
    assert.equal(twoAtOne.retryable, true);
    assert.equal(twoAtTwo.retryable, false);
    assert.match(twoAtTwo.retryReason, /configured 2-attempt/);
    const acceptedAtTwo = await appTwo.inject({
      method: "POST",
      url: `/api/v1/admin/notification-operations/${budgetTwoAtOne.outboxId}/retry`,
      headers: cookieFor(manager),
      payload: {
        reason: "Budget two permits attempt one recovery",
        expectedJobUpdatedAt: twoAtOne.jobUpdatedAt,
      },
    });
    assert.equal(acceptedAtTwo.statusCode, 201, acceptedAtTwo.body);
    await rejectedRetry(
      appTwo,
      manager,
      budgetTwoAtTwo,
      twoAtTwo.jobUpdatedAt!,
      "NOTIFICATION_RETRY_NOT_ALLOWED",
    );

    const threeAtTwo = deliveryFor(snapshotThree, budgetThreeAtTwo.outboxId);
    const threeAtThree = deliveryFor(snapshotThree, budgetThreeAtThree.outboxId);
    assert.equal(threeAtTwo.retryable, true);
    assert.equal(threeAtThree.retryable, false);
    assert.match(threeAtThree.retryReason, /configured 3-attempt/);
    const acceptedAtThree = await appThree.inject({
      method: "POST",
      url: `/api/v1/admin/notification-operations/${budgetThreeAtTwo.outboxId}/retry`,
      headers: cookieFor(manager),
      payload: {
        reason: "Budget three permits attempt two recovery",
        expectedJobUpdatedAt: threeAtTwo.jobUpdatedAt,
      },
    });
    assert.equal(acceptedAtThree.statusCode, 201, acceptedAtThree.body);
    await rejectedRetry(
      appThree,
      manager,
      budgetThreeAtThree,
      threeAtThree.jobUpdatedAt!,
      "NOTIFICATION_RETRY_NOT_ALLOWED",
    );

    const retried = await appThree.inject({
      method: "POST",
      url: `/api/v1/admin/notification-operations/${failed.outboxId}/retry`,
      headers: cookieFor(retryOnly),
      payload: {
        reason: "Recipient facts were reviewed; schedule one normal retry",
        expectedJobUpdatedAt: failedDelivery.jobUpdatedAt,
      },
    });
    assert.equal(retried.statusCode, 201, retried.body);
    assert.deepEqual(
      {
        outboxId: json<{ outboxId: string }>(retried).outboxId,
        failedAttemptNumber: json<{ failedAttemptNumber: number }>(retried).failedAttemptNumber,
        jobStatus: json<{ jobStatus: string }>(retried).jobStatus,
      },
      { outboxId: failed.outboxId, failedAttemptNumber: 1, jobStatus: "pending" },
    );

    const durableFact = await pool.query<{
      status: string;
      attempts: number;
      available: boolean;
      unlocked: boolean;
      audit_count: string;
    }>(
      `SELECT job.status, job.attempts,
              job.available_at <= pg_catalog.clock_timestamp() AS available,
              job.locked_at IS NULL AND job.locked_by IS NULL AS unlocked,
              (SELECT pg_catalog.count(*)::text
               FROM public.audit_events event
               WHERE event.action = 'notification.retry_requested'
                 AND event.target_id = $2
                 AND event.actor_id = $3::text) AS audit_count
       FROM public.durable_jobs job
       WHERE job.id = $1`,
      [failed.jobId, failed.outboxId, retryOnly.userId],
    );
    assert.deepEqual(durableFact.rows[0], {
      status: "pending",
      attempts: 0,
      available: true,
      unlocked: true,
      audit_count: "1",
    });

    const duplicate = await appThree.inject({
      method: "POST",
      url: `/api/v1/admin/notification-operations/${failed.outboxId}/retry`,
      headers: cookieFor(retryOnly),
      payload: {
        reason: "Synthetic duplicate click",
        expectedJobUpdatedAt: failedDelivery.jobUpdatedAt,
      },
    });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    assert.equal(json<{ code: string }>(duplicate).code, "NOTIFICATION_RETRY_STALE");
    const auditCount = await pool.query<{ count: string }>(
      `SELECT pg_catalog.count(*)::text AS count
       FROM public.audit_events
       WHERE action = 'notification.retry_requested'
         AND target_id = $1`,
      [failed.outboxId],
    );
    assert.equal(auditCount.rows[0]?.count, "1");

    const afterSnapshot = await readSnapshot(appThree, manager);
    const updatedQueue = deliveryFor(afterSnapshot, failed.outboxId);
    assert.equal(updatedQueue.retryable, false);
    assert.match(updatedQueue.retryReason, /Worker already owns/);
    const retryAudit = afterSnapshot.retryAudit.find((item) => item.outboxId === failed.outboxId);
    assert.ok(retryAudit);
    assert.deepEqual(
      {
        actorId: retryAudit.actorId,
        outboxId: retryAudit.outboxId,
        reason: retryAudit.reason,
      },
      {
        actorId: retryOnly.userId,
        outboxId: failed.outboxId,
        reason: "Recipient facts were reviewed; schedule one normal retry",
      },
    );
  } finally {
    await Promise.all([appOne.close(), appTwo.close(), appThree.close()]);
  }

  process.stdout.write("Notification Operations PG18 integration: PASS\n");
} finally {
  try {
    if (pool) await pool.end();
    await waitForDatabaseConnectionsToClose();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await admin.end();
  }
}
