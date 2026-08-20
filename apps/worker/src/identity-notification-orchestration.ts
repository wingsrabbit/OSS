// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  decryptIdentitySecret,
  type IdentitySecretKeyring,
} from "@opensales/core/identity-security";
import {
  renderNotificationTemplate,
  type NotificationPreferenceCategory,
  type NotificationTemplateRevision,
} from "@opensales/core";
import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import {
  getMockMailNotification,
  mockMailRequestSnapshot,
  postMockMailNotification,
  type MockMailRequestSnapshot,
  type NotificationDeliveryFact,
} from "./notification-delivery.js";

export type IdentityNotificationJob = Readonly<{
  id: string;
  job_type: string;
  unique_key: string;
  payload: Readonly<Record<string, unknown>>;
  payload_snapshot: string;
  attempts: number;
  locked_at_epoch: string;
  locked_by: string | null;
}>;

export type IdentityNotificationRuntimeConfig = Readonly<{
  workerId: string;
  providerUrl: string;
  providerToken: string;
  publicUrl: string;
  providerTimeoutMs: number;
  retryDelaySeconds: number;
  maxDeliveryAttempts: number;
  maxReconcileAttempts: number;
  scenario: "delivered" | "bounced" | "failed";
  keyring: IdentitySecretKeyring;
}>;

type OperationStatus =
  | "queued"
  | "dispatching"
  | "unknown"
  | "succeeded"
  | "failed"
  | "manual";

type BundleRow = Readonly<{
  operation_id: string;
  outbox_id: string;
  attempt_number: number;
  provider_operation_id: string;
  operation_status: OperationStatus;
  post_attempted_at: Date | null;
  last_reconciled_at: Date | null;
  reconcile_query_count: number;
  template_revision_id: string;
  template_revision: string;
  template_locale: "en" | "zh-CN";
  provider_template_ref: string;
  template_subject: string;
  template_body: string;
  template_sensitive: boolean;
  preference_category: NotificationPreferenceCategory;
  required_delivery: boolean;
  user_id: string;
  kind: "password_recovery" | "email_change";
  recipient: string;
  locale: "en" | "zh-CN";
  subject_id: string;
  encrypted_payload: string;
  encryption_key_version: number;
  expires_at: Date;
}>;

type LockedBundle = Readonly<{
  operation: BundleRow;
  subjectExact: boolean;
  subjectEligible: boolean;
  subjectTokenDigest: Buffer | null;
}>;

const jobPayloadSchema = z.object({
  outboxId: z.uuid(),
  operationId: z.uuid(),
  attemptNumber: z.number().int().min(1).max(3),
}).strict();

const decryptedPayloadSchema = z.object({
  url: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();

export class IdentityNotificationLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`identity notification durable job lease was lost: ${jobId}`);
    this.name = "IdentityNotificationLeaseLostError";
  }
}

class IdentityNotificationStateChangedError extends Error {
  constructor() {
    super("identity notification state changed concurrently");
    this.name = "IdentityNotificationStateChangedError";
  }
}

async function transaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard || undefined);
  }
}

function operationSelect(): string {
  return `SELECT operation.id AS operation_id,
                 operation.outbox_id,
                 operation.attempt_number,
                 operation.provider_operation_id,
                 operation.status AS operation_status,
                 operation.post_attempted_at,
                 operation.last_reconciled_at,
                 operation.reconcile_query_count,
                 operation.template_revision_id,
                 operation.template_revision,
                 operation.template_locale,
                 template.provider_template_ref,
                 template.subject_template AS template_subject,
                 template.body_template AS template_body,
                 template_event.sensitive AS template_sensitive,
                 template_event.preference_category,
                 template_event.required_delivery,
                 event.user_id,
                 event.kind,
                 event.recipient::text,
                 event.locale,
                 event.subject_id,
                 event.encrypted_payload,
                 event.encryption_key_version,
                 event.expires_at
          FROM public.identity_notification_delivery_operations operation
          JOIN public.identity_notification_outbox event
            ON event.id = operation.outbox_id
          JOIN public.notification_template_revisions template
            ON template.id = operation.template_revision_id
          JOIN public.notification_template_events template_event
            ON template_event.event_type = template.event_type`;
}

async function loadBundle(
  pool: pg.Pool,
  operationId: string,
  outboxId: string,
): Promise<BundleRow | null> {
  const result = await pool.query<BundleRow>(
    `${operationSelect()}
     WHERE operation.id = $1 AND operation.outbox_id = $2`,
    [operationId, outboxId],
  );
  return result.rows[0] ?? null;
}

async function lockBundle(
  client: pg.PoolClient,
  pointer: BundleRow,
  job: IdentityNotificationJob,
  config: IdentityNotificationRuntimeConfig,
  staleAfterSeconds?: number,
): Promise<LockedBundle> {
  const principal = await client.query<{
    email: string;
    locale: "en" | "zh-CN";
    restricted_at: Date | null;
    authorization_epoch: string;
  }>(
    `SELECT email::text, locale, restricted_at, authorization_epoch::text
     FROM public.users WHERE id = $1 FOR SHARE NOWAIT`,
    [pointer.user_id],
  );
  const user = principal.rows[0];
  let subjectExact = false;
  let subjectActive = false;
  let subjectTokenDigest: Buffer | null = null;
  if (pointer.kind === "password_recovery") {
    const token = await client.query<{
      user_id: string;
      expires_at: Date;
      used_at: Date | null;
      invalidated_at: Date | null;
      unexpired: boolean;
      token_digest: Buffer;
      authorization_epoch: string;
    }>(
      `SELECT user_id, expires_at, used_at, invalidated_at, token_digest,
              authorization_epoch::text,
              expires_at > pg_catalog.clock_timestamp() AS unexpired
       FROM public.password_reset_tokens
       WHERE id = $1
       FOR SHARE NOWAIT`,
      [pointer.subject_id],
    );
    const subject = token.rows[0];
    subjectExact = Boolean(
      subject && subject.user_id === pointer.user_id &&
      subject.authorization_epoch === user?.authorization_epoch &&
      subject.expires_at.getTime() === pointer.expires_at.getTime(),
    );
    subjectActive = Boolean(
      subjectExact && subject && !subject.used_at && !subject.invalidated_at && subject.unexpired,
    );
    subjectTokenDigest = subject?.token_digest ?? null;
  } else {
    const token = await client.query<{
      user_id: string;
      requested_email: string;
      expires_at: Date;
      used_at: Date | null;
      invalidated_at: Date | null;
      unexpired: boolean;
      token_digest: Buffer;
      authorization_epoch: string;
    }>(
      `SELECT user_id, requested_email::text, expires_at, used_at, invalidated_at,
              token_digest, authorization_epoch::text,
              expires_at > pg_catalog.clock_timestamp() AS unexpired
       FROM public.email_change_tokens
       WHERE id = $1
       FOR SHARE NOWAIT`,
      [pointer.subject_id],
    );
    const subject = token.rows[0];
    subjectExact = Boolean(
      subject && subject.user_id === pointer.user_id &&
      subject.authorization_epoch === user?.authorization_epoch &&
      subject.requested_email === pointer.recipient &&
      subject.expires_at.getTime() === pointer.expires_at.getTime(),
    );
    subjectActive = Boolean(
      subjectExact && subject && !subject.used_at && !subject.invalidated_at && subject.unexpired,
    );
    subjectTokenDigest = subject?.token_digest ?? null;
  }

  const outbox = await client.query(
    `SELECT id FROM public.identity_notification_outbox
     WHERE id = $1 AND user_id = $2 AND subject_id = $3
     FOR SHARE NOWAIT`,
    [pointer.outbox_id, pointer.user_id, pointer.subject_id],
  );
  const operation = await client.query<BundleRow>(
    `${operationSelect()}
     WHERE operation.id = $1 AND operation.outbox_id = $2
     FOR UPDATE OF operation`,
    [pointer.operation_id, pointer.outbox_id],
  );
  const current = operation.rows[0];
  if (!outbox.rows[0] || !current || current.operation_id !== pointer.operation_id) {
    throw new IdentityNotificationStateChangedError();
  }
  const stalePredicate = staleAfterSeconds === undefined
    ? ""
    : "AND locked_at < pg_catalog.clock_timestamp() - pg_catalog.make_interval(secs => $8)";
  const lease = await client.query(
    `SELECT id FROM public.durable_jobs
     WHERE id = $1 AND status = 'running' AND locked_by = $2
       AND attempts = $3 AND job_type = $4 AND unique_key = $5
       AND payload::text = $6
       AND extract(epoch FROM locked_at)::numeric::text = $7
       ${stalePredicate}
     FOR UPDATE`,
    [
      job.id,
      job.locked_by ?? config.workerId,
      job.attempts,
      job.job_type,
      job.unique_key,
      job.payload_snapshot,
      job.locked_at_epoch,
      ...(staleAfterSeconds === undefined ? [] : [staleAfterSeconds]),
    ],
  );
  if (!lease.rows[0]) throw new IdentityNotificationLeaseLostError(job.id);
  return {
    operation: current,
    subjectExact,
    subjectEligible: Boolean(
      subjectActive && user && !user.restricted_at &&
      user.locale === pointer.locale &&
      (pointer.kind === "email_change" || user.email === pointer.recipient),
    ),
    subjectTokenDigest,
  };
}

function renderNotification(
  operation: BundleRow,
  config: IdentityNotificationRuntimeConfig,
  subjectTokenDigest: Buffer,
): MockMailRequestSnapshot {
  const plaintext = decryptIdentitySecret(
    operation.encrypted_payload,
    operation.encryption_key_version,
    `identity-notification:${operation.kind}`,
    operation.subject_id,
    config.keyring,
  );
  const payload = decryptedPayloadSchema.parse(JSON.parse(plaintext) as unknown);
  const expectedPublic = new URL(config.publicUrl);
  const url = new URL(payload.url);
  const tokens = new URLSearchParams(url.hash.slice(1)).getAll("token");
  const expectedPath = operation.kind === "password_recovery"
    ? "/password-recovery"
    : "/email-change";
  if (
    url.origin !== expectedPublic.origin || url.pathname !== expectedPath ||
    url.search !== "" || tokens.length !== 1 ||
    !/^[A-Za-z0-9_-]{43}$/.test(tokens[0] ?? "") ||
    !createHash("sha256").update(tokens[0]!, "utf8").digest().equals(subjectTokenDigest) ||
    payload.expiresAt !== operation.expires_at.toISOString()
  ) {
    throw new Error("Identity notification encrypted payload contract is invalid");
  }
  const template: NotificationTemplateRevision = {
    revisionId: operation.template_revision_id,
    eventType: `identity.notification.${operation.kind}`,
    revisionKey: operation.template_revision,
    providerTemplateRef: operation.provider_template_ref,
    templateLocale: operation.template_locale,
    requestedLocale: operation.locale,
    fallback: operation.template_locale !== operation.locale,
    preferenceCategory: operation.preference_category,
    requiredDelivery: operation.required_delivery,
    sensitive: operation.template_sensitive,
    subjectTemplate: operation.template_subject,
    bodyTemplate: operation.template_body,
  };
  const rendered = renderNotificationTemplate(template, {
    actionUrl: payload.url,
    expiresAt: payload.expiresAt,
  });
  return mockMailRequestSnapshot({
    recipient: operation.recipient,
    template: rendered.template,
    locale: operation.locale,
    subject: rendered.subject,
    body: rendered.body,
    sensitive: rendered.sensitive,
  }, config.scenario);
}

async function updateJob(
  client: pg.PoolClient,
  job: IdentityNotificationJob,
  config: IdentityNotificationRuntimeConfig,
  status: "pending" | "completed" | "manual",
  reason: string | null,
): Promise<void> {
  const result = await client.query(
    `UPDATE public.durable_jobs
     SET status = $2,
         available_at = CASE WHEN $2 = 'pending'
           THEN pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => $3)
           ELSE available_at END,
         locked_at = NULL, locked_by = NULL, last_error = $4,
         updated_at = pg_catalog.clock_timestamp()
     WHERE id = $1 AND status = 'running' AND locked_by = $5
       AND attempts = $6 AND job_type = $7 AND unique_key = $8
       AND payload::text = $9
       AND extract(epoch FROM locked_at)::numeric::text = $10
     RETURNING id`,
    [
      job.id,
      status,
      config.retryDelaySeconds,
      reason,
      job.locked_by ?? config.workerId,
      job.attempts,
      job.job_type,
      job.unique_key,
      job.payload_snapshot,
      job.locked_at_epoch,
    ],
  );
  if (result.rowCount !== 1) throw new IdentityNotificationLeaseLostError(job.id);
}

async function insertFact(
  client: pg.PoolClient,
  operation: BundleRow,
  status: "delivered" | "bounced" | "failed" | "manual",
  reason: string | null,
  providerOccurredAt: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO public.identity_notification_delivery_facts(
       outbox_id, attempt_number, provider_operation_id, status,
       failure_reason, provider_occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      operation.outbox_id,
      operation.attempt_number,
      operation.provider_operation_id,
      status,
      reason,
      providerOccurredAt,
    ],
  );
}

async function appendDeliveryRetry(
  client: pg.PoolClient,
  operation: BundleRow,
  config: IdentityNotificationRuntimeConfig,
): Promise<void> {
  const boundedMaximum = Math.min(3, Math.max(1, config.maxDeliveryAttempts));
  if (operation.attempt_number >= boundedMaximum) return;
  const attemptNumber = operation.attempt_number + 1;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO public.identity_notification_delivery_operations(
       outbox_id, attempt_number, provider_operation_id, request_fingerprint,
       template_revision_id, template_revision, template_locale, status
     )
     SELECT event.id, $2,
            public.opensales_notification_provider_operation_id(event.id, $2),
            public.opensales_identity_notification_request_fingerprint(
              event.id, event.user_id, event.kind, event.recipient, event.locale,
              event.subject_id, event.encrypted_payload,
              event.encryption_key_version, event.expires_at
            ),
            $3, $4, $5, 'queued'
     FROM public.identity_notification_outbox event
     WHERE event.id = $1
     RETURNING id`,
    [
      operation.outbox_id,
      attemptNumber,
      operation.template_revision_id,
      operation.template_revision,
      operation.template_locale,
    ],
  );
  const operationId = inserted.rows[0]?.id;
  if (!operationId) throw new IdentityNotificationStateChangedError();
  await client.query(
    `INSERT INTO public.durable_jobs(job_type, unique_key, payload)
     VALUES (
       'identity.notification.send',
       'identity-notification:' || $1::text || ':attempt:' || $3::text,
       pg_catalog.jsonb_build_object(
         'outboxId', $1::text,
         'operationId', $2::text,
         'attemptNumber', $3::integer
       )
     )`,
    [operation.outbox_id, operationId, attemptNumber],
  );
}

async function finishManual(
  pool: pg.Pool,
  pointer: BundleRow,
  job: IdentityNotificationJob,
  config: IdentityNotificationRuntimeConfig,
  reason: string,
  reconciled: boolean,
): Promise<void> {
  await transaction(pool, async (client) => {
    const locked = await lockBundle(client, pointer, job, config);
    const current = locked.operation;
    if (!(["queued", "dispatching", "unknown"] as const).includes(
      current.operation_status as "queued" | "dispatching" | "unknown",
    )) throw new IdentityNotificationStateChangedError();
    if (current.operation_status === "unknown" && !reconciled) {
      throw new IdentityNotificationStateChangedError();
    }
    await client.query(
      `UPDATE public.identity_notification_delivery_operations
       SET status = 'manual', last_error = $2,
           last_reconciled_at = CASE WHEN $3 THEN
             GREATEST(pg_catalog.clock_timestamp(),
                      COALESCE(last_reconciled_at, post_attempted_at) + interval '1 microsecond')
             ELSE last_reconciled_at END,
           reconcile_query_count = reconcile_query_count + CASE WHEN $3 THEN 1 ELSE 0 END,
           updated_at = GREATEST(pg_catalog.clock_timestamp(), updated_at + interval '1 microsecond')
       WHERE id = $1`,
      [current.operation_id, reason, reconciled],
    );
    await insertFact(client, current, "manual", reason, null);
    await updateJob(client, job, config, "manual", reason);
  });
}

async function finishProviderFact(
  pool: pg.Pool,
  pointer: BundleRow,
  job: IdentityNotificationJob,
  config: IdentityNotificationRuntimeConfig,
  fact: NotificationDeliveryFact,
  reconciled: boolean,
): Promise<void> {
  await transaction(pool, async (client) => {
    const locked = await lockBundle(client, pointer, job, config);
    const current = locked.operation;
    if (fact.operationId !== current.provider_operation_id) {
      throw new IdentityNotificationStateChangedError();
    }
    const allowed = reconciled
      ? current.operation_status === "unknown"
      : current.operation_status === "dispatching";
    if (!allowed) throw new IdentityNotificationStateChangedError();
    const failed = fact.status === "failed";
    await client.query(
      `UPDATE public.identity_notification_delivery_operations
       SET status = $2, last_error = $3,
           last_reconciled_at = CASE WHEN $4 THEN
             GREATEST(pg_catalog.clock_timestamp(),
                      COALESCE(last_reconciled_at, post_attempted_at) + interval '1 microsecond')
             ELSE last_reconciled_at END,
           reconcile_query_count = reconcile_query_count + CASE WHEN $4 THEN 1 ELSE 0 END,
           updated_at = GREATEST(pg_catalog.clock_timestamp(), updated_at + interval '1 microsecond')
       WHERE id = $1`,
      [
        current.operation_id,
        failed ? "failed" : "succeeded",
        failed ? "MOCK_MAIL_DELIVERY_FAILED" : null,
        reconciled,
      ],
    );
    await insertFact(
      client,
      current,
      fact.status,
      failed ? "MOCK_MAIL_DELIVERY_FAILED" : null,
      fact.deliveredAt,
    );
    await updateJob(client, job, config, "completed", null);
    if (failed && locked.subjectEligible) {
      await appendDeliveryRetry(client, current, config);
    }
  });
}

async function markUnknown(
  pool: pg.Pool,
  pointer: BundleRow,
  job: IdentityNotificationJob,
  config: IdentityNotificationRuntimeConfig,
  reason: string,
  reconciled: boolean,
): Promise<void> {
  await transaction(pool, async (client) => {
    const locked = await lockBundle(client, pointer, job, config);
    const current = locked.operation;
    if (
      (reconciled && current.operation_status !== "unknown") ||
      (!reconciled && current.operation_status !== "dispatching")
    ) throw new IdentityNotificationStateChangedError();
    if (
      reconciled &&
      current.reconcile_query_count + 1 >= Math.min(config.maxReconcileAttempts, 32)
    ) {
      await client.query(
        `UPDATE public.identity_notification_delivery_operations
         SET status = 'manual', last_error = 'MOCK_MAIL_RECONCILIATION_EXHAUSTED',
             last_reconciled_at = GREATEST(
               pg_catalog.clock_timestamp(),
               COALESCE(last_reconciled_at, post_attempted_at) + interval '1 microsecond'
             ),
             reconcile_query_count = reconcile_query_count + 1,
             updated_at = GREATEST(pg_catalog.clock_timestamp(), updated_at + interval '1 microsecond')
         WHERE id = $1`,
        [current.operation_id],
      );
      await insertFact(
        client,
        current,
        "manual",
        "MOCK_MAIL_RECONCILIATION_EXHAUSTED",
        null,
      );
      await updateJob(
        client,
        job,
        config,
        "manual",
        "MOCK_MAIL_RECONCILIATION_EXHAUSTED",
      );
      return;
    }
    await client.query(
      `UPDATE public.identity_notification_delivery_operations
       SET status = 'unknown', last_error = $2,
           last_reconciled_at = CASE WHEN $3 THEN
             GREATEST(pg_catalog.clock_timestamp(),
                      COALESCE(last_reconciled_at, post_attempted_at) + interval '1 microsecond')
             ELSE last_reconciled_at END,
           reconcile_query_count = reconcile_query_count + CASE WHEN $3 THEN 1 ELSE 0 END,
           updated_at = GREATEST(pg_catalog.clock_timestamp(), updated_at + interval '1 microsecond')
       WHERE id = $1`,
      [current.operation_id, reason, reconciled],
    );
    await updateJob(client, job, config, "pending", reason);
  });
}

async function prepareDispatch(
  pool: pg.Pool,
  pointer: BundleRow,
  job: IdentityNotificationJob,
  config: IdentityNotificationRuntimeConfig,
): Promise<Readonly<{ operation: BundleRow; request: MockMailRequestSnapshot }> | null> {
  return transaction(pool, async (client) => {
    const locked = await lockBundle(client, pointer, job, config);
    const current = locked.operation;
    if (current.operation_status !== "queued") {
      throw new IdentityNotificationStateChangedError();
    }
    if (!locked.subjectExact || !locked.subjectEligible || !locked.subjectTokenDigest) {
      const reason = !locked.subjectExact || !locked.subjectTokenDigest
        ? "IDENTITY_NOTIFICATION_SUBJECT_BINDING_MISMATCH"
        : "IDENTITY_NOTIFICATION_SUBJECT_INELIGIBLE_BEFORE_POST";
      // Keep the final eligibility decision, operation terminal projection,
      // immutable fact, and job state in this one transaction. A concurrent
      // restore must serialize either before this lock barrier or after it.
      await client.query(
        `UPDATE public.identity_notification_delivery_operations
         SET status = 'manual', last_error = $2,
             updated_at = GREATEST(pg_catalog.clock_timestamp(), updated_at + interval '1 microsecond')
         WHERE id = $1`,
        [current.operation_id, reason],
      );
      await insertFact(client, current, "manual", reason, null);
      await updateJob(client, job, config, "manual", reason);
      return null;
    }
    let request: MockMailRequestSnapshot;
    try {
      request = renderNotification(current, config, locked.subjectTokenDigest);
    } catch {
      await client.query(
        `UPDATE public.identity_notification_delivery_operations
         SET status = 'manual', last_error = 'IDENTITY_NOTIFICATION_PAYLOAD_CONTRACT_MISMATCH',
             updated_at = GREATEST(pg_catalog.clock_timestamp(), updated_at + interval '1 microsecond')
         WHERE id = $1`,
        [current.operation_id],
      );
      await insertFact(
        client,
        current,
        "manual",
        "IDENTITY_NOTIFICATION_PAYLOAD_CONTRACT_MISMATCH",
        null,
      );
      await updateJob(
        client,
        job,
        config,
        "manual",
        "IDENTITY_NOTIFICATION_PAYLOAD_CONTRACT_MISMATCH",
      );
      return null;
    }
    await client.query(
      `UPDATE public.identity_notification_delivery_operations
       SET status = 'dispatching', post_attempted_at = pg_catalog.clock_timestamp(),
           updated_at = GREATEST(pg_catalog.clock_timestamp(), updated_at + interval '1 microsecond')
       WHERE id = $1`,
      [current.operation_id],
    );
    return { operation: { ...current, operation_status: "dispatching" }, request };
  });
}

async function dispatch(
  pool: pg.Pool,
  pointer: BundleRow,
  job: IdentityNotificationJob,
  config: IdentityNotificationRuntimeConfig,
): Promise<void> {
  const prepared = await prepareDispatch(pool, pointer, job, config);
  if (!prepared) return;
  const outcome = await postMockMailNotification({
    providerUrl: config.providerUrl,
    providerToken: config.providerToken,
    operationId: prepared.operation.provider_operation_id,
    requestSnapshot: prepared.request,
    timeoutMs: config.providerTimeoutMs,
  });
  if (outcome.kind === "found") {
    await finishProviderFact(pool, prepared.operation, job, config, outcome.fact, false);
  } else if (outcome.kind === "unknown") {
    await markUnknown(
      pool,
      prepared.operation,
      job,
      config,
      `MOCK_MAIL_POST_${outcome.code.toUpperCase()}`,
      false,
    );
  } else {
    await finishManual(
      pool,
      prepared.operation,
      job,
      config,
      `MOCK_MAIL_POST_${outcome.code.toUpperCase()}`,
      false,
    );
  }
}

async function ensureUnknown(
  pool: pg.Pool,
  pointer: BundleRow,
  job: IdentityNotificationJob,
  config: IdentityNotificationRuntimeConfig,
): Promise<BundleRow> {
  if (pointer.operation_status === "unknown") return pointer;
  if (pointer.operation_status !== "dispatching") {
    throw new IdentityNotificationStateChangedError();
  }
  return transaction(pool, async (client) => {
    const locked = await lockBundle(client, pointer, job, config);
    const current = locked.operation;
    if (current.operation_status !== "dispatching") {
      throw new IdentityNotificationStateChangedError();
    }
    await client.query(
      `UPDATE public.identity_notification_delivery_operations
       SET status = 'unknown', last_error = 'RECONCILING_POTENTIALLY_SENT_IDENTITY_NOTIFICATION',
           updated_at = GREATEST(pg_catalog.clock_timestamp(), updated_at + interval '1 microsecond')
       WHERE id = $1`,
      [current.operation_id],
    );
    return { ...current, operation_status: "unknown" };
  });
}

async function reconcile(
  pool: pg.Pool,
  pointer: BundleRow,
  job: IdentityNotificationJob,
  config: IdentityNotificationRuntimeConfig,
): Promise<void> {
  const unknown = await ensureUnknown(pool, pointer, job, config);
  const outcome = await getMockMailNotification({
    providerUrl: config.providerUrl,
    providerToken: config.providerToken,
    operationId: unknown.provider_operation_id,
    timeoutMs: config.providerTimeoutMs,
  });
  if (outcome.kind === "found") {
    await finishProviderFact(pool, unknown, job, config, outcome.fact, true);
  } else if (outcome.kind === "retry") {
    await markUnknown(
      pool,
      unknown,
      job,
      config,
      `MOCK_MAIL_GET_${outcome.code.toUpperCase()}`,
      true,
    );
  } else {
    const reason = outcome.kind === "not_found"
      ? "MOCK_MAIL_GET_NOT_FOUND_AFTER_UNKNOWN_POST"
      : `MOCK_MAIL_GET_${outcome.code.toUpperCase()}`;
    // A 404 is a fresh subject barrier, not permission to issue another POST.
    // lockBundle rechecks User and exact token binding immediately before the
    // terminal manual projection.
    await finishManual(pool, unknown, job, config, reason, true);
  }
}

export async function processIdentityNotificationJob(
  pool: pg.Pool,
  job: IdentityNotificationJob,
  config: IdentityNotificationRuntimeConfig,
): Promise<void> {
  if (job.job_type !== "identity.notification.send") {
    throw new Error("Invalid identity notification job type");
  }
  const payload = jobPayloadSchema.parse(job.payload);
  const pointer = await loadBundle(pool, payload.operationId, payload.outboxId);
  if (!pointer || pointer.attempt_number !== payload.attemptNumber) {
    throw new Error("Identity notification job references a missing operation");
  }
  if (pointer.operation_status === "queued") {
    await dispatch(pool, pointer, job, config);
    return;
  }
  if (pointer.operation_status === "dispatching" || pointer.operation_status === "unknown") {
    await reconcile(pool, pointer, job, config);
    return;
  }
  throw new IdentityNotificationStateChangedError();
}

export async function persistUnexpectedIdentityNotificationFailure(
  pool: pg.Pool,
  job: IdentityNotificationJob,
  config: IdentityNotificationRuntimeConfig,
): Promise<void> {
  let payload: z.infer<typeof jobPayloadSchema>;
  try {
    payload = jobPayloadSchema.parse(job.payload);
  } catch {
    throw new IdentityNotificationStateChangedError();
  }
  const pointer = await loadBundle(pool, payload.operationId, payload.outboxId);
  if (!pointer) throw new IdentityNotificationStateChangedError();
  if (pointer.operation_status === "dispatching") {
    await markUnknown(
      pool,
      pointer,
      job,
      config,
      "IDENTITY_NOTIFICATION_INTERRUPTED_AFTER_POST_BARRIER",
      false,
    );
    return;
  }
  if (pointer.operation_status === "unknown") {
    await transaction(pool, async (client) => {
      const locked = await lockBundle(client, pointer, job, config);
      if (locked.operation.operation_status !== "unknown") {
        throw new IdentityNotificationStateChangedError();
      }
      // No reconciliation-query budget is consumed here: an unexpected local
      // interruption is not evidence that a Provider GET completed.
      await updateJob(
        client,
        job,
        config,
        "pending",
        "IDENTITY_NOTIFICATION_RECONCILIATION_INTERRUPTED",
      );
    });
    return;
  }
  if (pointer.operation_status === "queued") {
    await transaction(pool, async (client) => {
      await lockBundle(client, pointer, job, config);
      await updateJob(
        client,
        job,
        config,
        "pending",
        "IDENTITY_NOTIFICATION_KNOWN_UNSENT_RETRY",
      );
    });
    return;
  }
  throw new IdentityNotificationStateChangedError();
}

export async function recoverStaleIdentityNotificationJob(
  pool: pg.Pool,
  job: IdentityNotificationJob,
  config: IdentityNotificationRuntimeConfig,
  staleAfterSeconds: number,
): Promise<boolean> {
  let payload: z.infer<typeof jobPayloadSchema>;
  try {
    payload = jobPayloadSchema.parse(job.payload);
  } catch {
    return false;
  }
  const pointer = await loadBundle(pool, payload.operationId, payload.outboxId);
  if (!pointer) return false;
  return transaction(pool, async (client) => {
    const locked = await lockBundle(client, pointer, job, config, staleAfterSeconds);
    const current = locked.operation;
    if (current.operation_status === "queued") {
      // Claims are not delivery attempts. A queued operation is provably
      // unsent, so stale/local failures remain safely retryable without
      // consuming either the POST-attempt or GET-reconciliation budget.
      await updateJob(
        client,
        job,
        config,
        "pending",
        "IDENTITY_NOTIFICATION_KNOWN_UNSENT_STALE_LEASE",
      );
      return true;
    }
    if (current.operation_status === "dispatching") {
      await client.query(
        `UPDATE public.identity_notification_delivery_operations
         SET status = 'unknown',
             last_error = 'IDENTITY_NOTIFICATION_STALE_AFTER_POST_BARRIER',
             updated_at = GREATEST(pg_catalog.clock_timestamp(), updated_at + interval '1 microsecond')
         WHERE id = $1`,
        [current.operation_id],
      );
      await updateJob(
        client,
        job,
        config,
        "pending",
        "IDENTITY_NOTIFICATION_STALE_AFTER_POST_BARRIER",
      );
      return true;
    }
    if (current.operation_status === "unknown") {
      await updateJob(
        client,
        job,
        config,
        "pending",
        "IDENTITY_NOTIFICATION_STALE_DURING_GET_RECONCILIATION",
      );
      return true;
    }
    throw new IdentityNotificationStateChangedError();
  });
}
