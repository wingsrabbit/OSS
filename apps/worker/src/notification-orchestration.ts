// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import {
  renderNotificationTemplate,
  type NotificationPreferenceCategory,
  type NotificationTemplateRevision,
  type NotificationTemplateValue,
} from "@opensales/core";
import type pg from "pg";
import {
  getMockMailNotification,
  mockMailRequestFingerprint,
  mockMailRequestSnapshot,
  notificationOperationId,
  parseMockMailRequestSnapshot,
  postMockMailNotification,
  type MockMailRequestSnapshot,
  type NotificationDeliveryFact,
  type StandardNotificationPayload,
} from "./notification-delivery.js";
import { lockSchema016StaleJob } from "./job-claim.js";

export type NotificationJobLease = Readonly<{
  id: string;
  job_type: string;
  unique_key: string;
  payload: Record<string, string>;
  payload_snapshot: string;
  attempts: number;
  locked_at_epoch: string;
  locked_by: string | null;
}>;

export type NotificationRuntimeConfig = Readonly<{
  workerId: string;
  providerUrl: string;
  providerToken: string;
  providerTimeoutMs: number;
  maxAttempts: number;
  retryBaseDelaySeconds: number;
  scenario: "delivered" | "bounced" | "failed";
}>;

type OperationStatus =
  | "queued"
  | "dispatching"
  | "unknown"
  | "succeeded"
  | "failed"
  | "skipped"
  | "manual";

type OperationRow = Readonly<{
  id: string;
  outbox_id: string;
  attempt_number: number;
  provider_operation_id: string;
  provider_installation_id: string;
  operation_origin: "application" | "schema_019_backfill";
  event_type: string;
  template_revision: string;
  template_revision_id: string;
  template_locale: "en" | "zh-CN";
  provider_template_ref: string;
  template_subject: string;
  template_body: string;
  template_sensitive: boolean;
  preference_category: NotificationPreferenceCategory;
  required_delivery: boolean;
  payload_snapshot: StandardNotificationPayload;
  rendered_request_snapshot: unknown | null;
  rendered_request_fingerprint: string | null;
  invitation_id: string | null;
  contact_id: string | null;
  recipient_user_id: string | null;
  client_account_id: string | null;
  recipient_subject_id: string;
  recipient_scope_id: string;
  recipient_kind: "identity_user" | "invitation" | "contact" | "account_user";
  category: "identity" | "membership_invitation" | "billing" | "service" | "support";
  recipient: string;
  locale: "en" | "zh-CN";
  request_fingerprint: string;
  status: OperationStatus;
  attempts: number;
  dispatch_started_at: Date | null;
  last_checked_at: Date | null;
  last_error: string | null;
  outbox_published_at: Date | null;
}>;

type DatabaseClient = pg.PoolClient;

type ConsentDecision =
  | Readonly<{ kind: "eligible" }>
  | Readonly<{ kind: "ineligible"; reason: string }>;

type RenewalDecision =
  | Readonly<{ kind: "ready"; payload: StandardNotificationPayload }>
  | Readonly<{ kind: "skip"; reason: string }>
  | Readonly<{ kind: "manual"; reason: string }>;

type DispatchPreparation =
  | Readonly<{
      kind: "dispatch";
      providerOperationId: string;
      requestSnapshot: MockMailRequestSnapshot;
    }>
  | Readonly<{ kind: "finished" }>;

export class NotificationLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`notification durable job lease was lost: ${jobId}`);
    this.name = "NotificationLeaseLostError";
  }
}

class NotificationStateChangedError extends Error {
  constructor() {
    super("notification delivery state changed concurrently");
    this.name = "NotificationStateChangedError";
  }
}

async function transaction<T>(
  pool: pg.Pool,
  work: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discardClient = true;
    }
    throw error;
  } finally {
    client.release(discardClient || undefined);
  }
}

function retryDelaySeconds(config: NotificationRuntimeConfig, attempt: number): number {
  return Math.min(
    300,
    config.retryBaseDelaySeconds * 2 ** Math.min(Math.max(attempt - 1, 0), 6),
  );
}

function operationSelect(): string {
  return `SELECT operation.id, operation.outbox_id, operation.attempt_number,
                 operation.provider_operation_id,
                 operation.provider_installation_id,
                 operation.operation_origin, operation.event_type,
                 operation.template_revision, operation.template_revision_id,
                 operation.template_locale,
                 template.provider_template_ref,
                 template.subject_template AS template_subject,
                 template.body_template AS template_body,
                 template_event.sensitive AS template_sensitive,
                 template_event.preference_category,
                 template_event.required_delivery,
                 operation.payload_snapshot,
                 operation.rendered_request_snapshot,
                 operation.rendered_request_fingerprint,
                 operation.invitation_id, operation.contact_id,
                 operation.recipient_user_id, operation.client_account_id,
                 operation.recipient_subject_id, operation.recipient_scope_id,
                 operation.recipient_kind, operation.category,
                 operation.recipient::text, operation.locale,
                 operation.request_fingerprint, operation.status,
                 operation.attempts, operation.dispatch_started_at,
                 operation.last_checked_at, operation.last_error,
                 event.published_at AS outbox_published_at
          FROM public.notification_delivery_operations operation
          JOIN public.outbox event ON event.id = operation.outbox_id
          JOIN public.notification_template_revisions template
            ON template.id = operation.template_revision_id
          JOIN public.notification_template_events template_event
            ON template_event.event_type = template.event_type`;
}

async function loadLatestOperation(
  pool: pg.Pool,
  outboxId: string,
): Promise<OperationRow | null> {
  const result = await pool.query<OperationRow>(
    `${operationSelect()}
     WHERE operation.outbox_id = $1
     ORDER BY operation.attempt_number DESC
     LIMIT 1`,
    [outboxId],
  );
  return result.rows[0] ?? null;
}

async function lockOutboxOperationAndJob(
  client: DatabaseClient,
  pointer: OperationRow,
  job: NotificationJobLease,
  workerId: string,
): Promise<OperationRow> {
  const outbox = await client.query(
    `SELECT id
     FROM public.outbox
     WHERE id = $1
     FOR UPDATE`,
    [pointer.outbox_id],
  );
  if (!outbox.rows[0]) throw new NotificationStateChangedError();

  const operation = await client.query<OperationRow>(
    `${operationSelect()}
     WHERE operation.outbox_id = $1
     ORDER BY operation.attempt_number DESC
     LIMIT 1
     FOR UPDATE OF operation`,
    [pointer.outbox_id],
  );
  const current = operation.rows[0];
  if (!current || current.id !== pointer.id) throw new NotificationStateChangedError();

  const lease = await client.query(
    `SELECT id
     FROM public.durable_jobs
     WHERE id = $1
       AND status = 'running'
       AND locked_by = $2
       AND attempts = $3
       AND job_type = $4
       AND unique_key = $5
       AND payload::text = $6
       AND EXTRACT(epoch FROM locked_at)::numeric::text = $7
     FOR UPDATE`,
    [
      job.id,
      workerId,
      job.attempts,
      job.job_type,
      job.unique_key,
      job.payload_snapshot,
      job.locked_at_epoch,
    ],
  );
  if (!lease.rows[0]) throw new NotificationLeaseLostError(job.id);
  return current;
}

async function updateJob(
  client: DatabaseClient,
  job: NotificationJobLease,
  config: NotificationRuntimeConfig,
  input: Readonly<{
    status: "pending" | "completed" | "manual";
    reason: string | null;
    delayAttempt?: number;
  }>,
): Promise<void> {
  const pending = input.status === "pending";
  const result = await client.query(
    `UPDATE public.durable_jobs
     SET status = $2,
         attempts = CASE WHEN $2 = 'pending' THEN 0 ELSE attempts END,
         available_at = CASE
           WHEN $2 = 'pending' THEN
             pg_catalog.now() + pg_catalog.make_interval(secs => $3)
           ELSE available_at
         END,
         locked_at = NULL,
         locked_by = NULL,
         last_error = $4,
         updated_at = pg_catalog.now()
     WHERE id = $1
       AND status = 'running'
       AND locked_by = $5
       AND attempts = $6
       AND job_type = $7
       AND unique_key = $8
       AND payload::text = $9
       AND EXTRACT(epoch FROM locked_at)::numeric::text = $10
     RETURNING id`,
    [
      job.id,
      input.status,
      pending ? retryDelaySeconds(config, input.delayAttempt ?? 1) : 0,
      input.reason?.slice(0, 1_000) ?? null,
      config.workerId,
      job.attempts,
      job.job_type,
      job.unique_key,
      job.payload_snapshot,
      job.locked_at_epoch,
    ],
  );
  if (result.rowCount !== 1) throw new NotificationLeaseLostError(job.id);
}

async function updateJobWithoutOperation(
  pool: pg.Pool,
  job: NotificationJobLease,
  config: NotificationRuntimeConfig,
  status: "pending" | "manual",
  reason: string,
): Promise<void> {
  const result = await pool.query(
    `UPDATE public.durable_jobs
     SET status = $2,
         attempts = CASE WHEN $2 = 'pending' THEN 0 ELSE attempts END,
         available_at = CASE
           WHEN $2 = 'pending' THEN
             pg_catalog.now() + pg_catalog.make_interval(secs => $3)
           ELSE available_at
         END,
         locked_at = NULL,
         locked_by = NULL,
         last_error = $4,
         updated_at = pg_catalog.now()
     WHERE id = $1
       AND status = 'running'
       AND locked_by = $5
       AND attempts = $6
       AND job_type = $7
       AND unique_key = $8
       AND payload::text = $9
       AND EXTRACT(epoch FROM locked_at)::numeric::text = $10`,
    [
      job.id,
      status,
      status === "pending" ? retryDelaySeconds(config, 1) : 0,
      reason.slice(0, 1_000),
      config.workerId,
      job.attempts,
      job.job_type,
      job.unique_key,
      job.payload_snapshot,
      job.locked_at_epoch,
    ],
  );
  if (result.rowCount !== 1) throw new NotificationLeaseLostError(job.id);
}

function oneTimeToken(value: unknown, pathname: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    const tokens = parsed.searchParams.getAll("token");
    return parsed.pathname === pathname && tokens.length === 1 &&
      /^[A-Za-z0-9_-]{43}$/.test(tokens[0] ?? "")
      ? tokens[0]!
      : null;
  } catch {
    return null;
  }
}

export async function currentUserNotificationPreferenceAllowsAtDispatch(
  client: Pick<DatabaseClient, "query">,
  input: Readonly<{
    userId: string | null;
    preferenceCategory: NotificationPreferenceCategory;
    requiredDelivery: boolean;
  }>,
): Promise<boolean> {
  if (input.requiredDelivery || !input.userId) return true;
  const result = await client.query<{ enabled: boolean }>(
    `SELECT preference.enabled
     FROM public.user_notification_preferences preference
     WHERE preference.user_id = $1
       AND preference.category = $2
       AND preference.channel = 'email'
     FOR SHARE`,
    [input.userId, input.preferenceCategory],
  );
  return result.rows[0]?.enabled ?? true;
}

async function currentUserPreferenceAllows(
  client: DatabaseClient,
  operation: OperationRow,
): Promise<boolean> {
  return currentUserNotificationPreferenceAllowsAtDispatch(client, {
    userId: operation.recipient_user_id,
    preferenceCategory: operation.preference_category,
    requiredDelivery: operation.required_delivery,
  });
}

async function lockRecipientForDispatch(
  client: DatabaseClient,
  operation: OperationRow,
): Promise<ConsentDecision> {
  const invalid = (reason: string): ConsentDecision => ({ kind: "ineligible", reason });
  const payload = operation.payload_snapshot;
  if (operation.recipient_kind === "identity_user") {
    const principal = await client.query<{
      email: string;
      locale: string;
      email_verified_at: Date | null;
      restricted_at: Date | null;
    }>(
      `SELECT email::text, locale, email_verified_at, restricted_at
       FROM public.users
       WHERE id = $1
       FOR SHARE NOWAIT`,
      [operation.recipient_user_id],
    );
    const user = principal.rows[0];
    if (
      !user ||
      user.email !== operation.recipient ||
      user.locale !== operation.locale ||
      user.email_verified_at ||
      user.restricted_at
    ) {
      return invalid("IDENTITY_RECIPIENT_INELIGIBLE");
    }
    const token = oneTimeToken(payload.verificationUrl, "/verify");
    if (!token) return invalid("VERIFICATION_TOKEN_INELIGIBLE");
    const tokenId = typeof (payload as Record<string, unknown>).verificationTokenId === "string"
      ? String((payload as Record<string, unknown>).verificationTokenId)
      : null;
    const lockedToken = await client.query<{
      used_at: Date | null;
      invalidated_at: Date | null;
      eligible: boolean;
    }>(
      `SELECT used_at, invalidated_at, expires_at > pg_catalog.clock_timestamp() AS eligible
       FROM public.email_verification_tokens
       WHERE user_id = $1
         AND ($2::uuid IS NULL OR id = $2::uuid)
         AND token_digest = public.digest(
           pg_catalog.convert_to($3, 'UTF8'),
           'sha256'
         )
       FOR SHARE NOWAIT`,
      [operation.recipient_user_id, tokenId, token],
    );
    const verification = lockedToken.rows[0];
    if (
      !verification || verification.used_at || verification.invalidated_at ||
      !verification.eligible
    ) return invalid("VERIFICATION_TOKEN_INELIGIBLE");
    return await currentUserPreferenceAllows(client, operation)
      ? { kind: "eligible" }
      : invalid("USER_NOTIFICATION_PREFERENCE_DISABLED");
  }

  if (operation.recipient_kind === "account_user") {
    const principal = await client.query<{
      email: string;
      locale: string;
      email_verified_at: Date | null;
      restricted_at: Date | null;
    }>(
      `SELECT email::text, locale, email_verified_at, restricted_at
       FROM public.users
       WHERE id = $1
       FOR SHARE NOWAIT`,
      [operation.recipient_user_id],
    );
    const account = await client.query(
      `SELECT id
       FROM public.client_accounts
       WHERE id = $1
       FOR SHARE NOWAIT`,
      [operation.client_account_id],
    );
    const membership = await client.query<{
      removed_at: Date | null;
      restricted_at: Date | null;
    }>(
      `SELECT removed_at, restricted_at
       FROM public.client_memberships
       WHERE user_id = $1 AND client_account_id = $2
       FOR SHARE NOWAIT`,
      [operation.recipient_user_id, operation.client_account_id],
    );
    const user = principal.rows[0];
    const member = membership.rows[0];
    const eligible = Boolean(
      user && user.email === operation.recipient && user.locale === operation.locale &&
      user.email_verified_at && !user.restricted_at && account.rows[0] && member &&
      !member.removed_at && !member.restricted_at,
    );
    if (!eligible) return invalid("ACCOUNT_USER_RECIPIENT_INELIGIBLE");
    return await currentUserPreferenceAllows(client, operation)
      ? { kind: "eligible" }
      : invalid("USER_NOTIFICATION_PREFERENCE_DISABLED");
  }

  const account = await client.query(
    `SELECT id
     FROM public.client_accounts
     WHERE id = $1
     FOR SHARE NOWAIT`,
    [operation.client_account_id],
  );
  if (!account.rows[0]) return invalid("ACCOUNT_RECIPIENT_SCOPE_INELIGIBLE");

  if (operation.recipient_kind === "invitation") {
    const token = oneTimeToken(payload.invitationUrl, "/membership-invitations/accept");
    if (!token) return invalid("MEMBERSHIP_INVITATION_INELIGIBLE");
    const invitation = await client.query<{
      email: string;
      locale: string;
      accepted_at: Date | null;
      revoked_at: Date | null;
      eligible: boolean;
    }>(
      `SELECT email::text, locale, accepted_at, revoked_at,
              expires_at > pg_catalog.clock_timestamp() AS eligible
       FROM public.client_membership_invitations
       WHERE id = $1
         AND client_account_id = $2
         AND token_digest = public.digest(
           pg_catalog.convert_to($3, 'UTF8'),
           'sha256'
         )
       FOR SHARE NOWAIT`,
      [operation.invitation_id, operation.client_account_id, token],
    );
    const row = invitation.rows[0];
    return row && row.email === operation.recipient && row.locale === operation.locale &&
      !row.accepted_at && !row.revoked_at && row.eligible
      ? { kind: "eligible" }
      : invalid("MEMBERSHIP_INVITATION_INELIGIBLE");
  }

  const contact = await client.query<{
    email: string;
    locale: string;
    removed_at: Date | null;
    subscribed: boolean;
  }>(
    `SELECT email::text, locale, removed_at,
            notification_subscriptions ? $3 AS subscribed
     FROM public.client_contacts
     WHERE id = $1 AND client_account_id = $2
     FOR SHARE NOWAIT`,
    [operation.contact_id, operation.client_account_id, operation.category],
  );
  const row = contact.rows[0];
  return row && row.email === operation.recipient && row.locale === operation.locale &&
    !row.removed_at && row.subscribed
    ? { kind: "eligible" }
    : invalid("CONTACT_RECIPIENT_INELIGIBLE");
}

async function renewalDecision(
  client: DatabaseClient,
  operation: OperationRow,
): Promise<RenewalDecision> {
  if (operation.event_type !== "notification.renewal_reminder_requested") {
    return { kind: "ready", payload: operation.payload_snapshot };
  }
  const payload = operation.payload_snapshot;
  if (
    !payload.invoiceId ||
    !payload.serviceId ||
    !payload.kind ||
    !["renewal_created", "pre_due", "overdue_first"].includes(payload.kind)
  ) {
    return { kind: "manual", reason: "RENEWAL_NOTIFICATION_CONTRACT_INVALID" };
  }
  const invoice = await client.query<{ total_minor: string }>(
    `SELECT invoice.total_minor::text
     FROM public.invoices invoice
     WHERE invoice.id = $1
       AND invoice.client_account_id = $2
     FOR UPDATE OF invoice`,
    [payload.invoiceId, operation.client_account_id],
  );
  const allocation = await client.query<{ allocated_minor: string }>(
    `SELECT allocation.allocated_minor::text
     FROM public.invoice_allocation_totals allocation
     WHERE allocation.invoice_id = $1`,
    [payload.invoiceId],
  );
  const reminder = await client.query<{
    id: string;
    service_id: string;
  }>(
    `SELECT reminder.id, reminder.service_id
     FROM public.renewal_reminder_intents reminder
     WHERE reminder.invoice_id = $1 AND reminder.kind = $2
     FOR UPDATE`,
    [payload.invoiceId, payload.kind],
  );
  const invoiceRow = invoice.rows[0];
  const allocationRow = allocation.rows[0];
  const reminderRow = reminder.rows[0];
  if (
    !invoiceRow ||
    !allocationRow ||
    !reminderRow ||
    reminderRow.service_id !== payload.serviceId
  ) {
    return { kind: "manual", reason: "RENEWAL_NOTIFICATION_FACTS_UNAVAILABLE" };
  }
  const suppression = await client.query(
    `SELECT 1
     WHERE EXISTS (
       SELECT 1
       FROM public.renewal_reminder_suppressions
       WHERE intent_id = $1
     ) OR EXISTS (
       SELECT 1
       FROM public.renewal_notification_dispatch_suppressions
       WHERE intent_id = $1
     )`,
    [reminderRow.id],
  );
  if (suppression.rows[0]) {
    return { kind: "skip", reason: "RENEWAL_NOTIFICATION_SUPPRESSED" };
  }
  const currentDue = BigInt(invoiceRow.total_minor) - BigInt(allocationRow.allocated_minor);
  if (payload.kind !== "renewal_created" && currentDue <= 0n) {
    await client.query(
      `INSERT INTO public.renewal_notification_dispatch_suppressions(intent_id, reason)
       VALUES ($1, 'invoice was fully settled before reminder dispatch')
       ON CONFLICT (intent_id) DO NOTHING`,
      [reminderRow.id],
    );
    await client.query(
      `INSERT INTO public.renewal_reminder_suppressions(intent_id, reason)
       SELECT $1, 'invoice was fully settled before reminder dispatch'
       WHERE NOT EXISTS (
         SELECT 1
         FROM public.renewal_reminder_delivery_facts fact
         WHERE fact.intent_id = $1
           AND fact.status IN ('delivered', 'bounced')
       )
       ON CONFLICT (intent_id) DO NOTHING`,
      [reminderRow.id],
    );
    return { kind: "skip", reason: "RENEWAL_NOTIFICATION_FULLY_SETTLED" };
  }
  return {
    kind: "ready",
    payload: {
      ...payload,
      amountDueMinor: (currentDue > 0n ? currentDue : 0n).toString(),
    },
  };
}

async function insertSkippedFact(
  client: DatabaseClient,
  operationId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `INSERT INTO public.notification_delivery_facts(
       outbox_id, attempt_number,
       invitation_id, contact_id, recipient_user_id, client_account_id,
       recipient_subject_id, recipient_scope_id,
       recipient_kind, category, recipient, locale,
       provider_installation_id, provider_operation_id, provider_message_id,
       status, failure_reason, provider_occurred_at
     )
     SELECT operation.outbox_id, operation.attempt_number,
            operation.invitation_id, operation.contact_id,
            operation.recipient_user_id, operation.client_account_id,
            operation.recipient_subject_id, operation.recipient_scope_id,
            operation.recipient_kind, operation.category,
            operation.recipient, operation.locale,
            NULL, operation.provider_operation_id, NULL,
            'skipped', $2, NULL
     FROM public.notification_delivery_operations operation
     WHERE operation.id = $1`,
    [operationId, reason],
  );
}

async function skipCurrentOperation(
  client: DatabaseClient,
  operation: OperationRow,
  job: NotificationJobLease,
  config: NotificationRuntimeConfig,
  reason: string,
): Promise<void> {
  const updated = await client.query(
    `UPDATE public.notification_delivery_operations
     SET status = 'skipped',
         last_checked_at = CASE
           WHEN status = 'unknown' THEN pg_catalog.now()
           ELSE last_checked_at
         END,
         last_error = $2,
         updated_at = pg_catalog.now()
     WHERE id = $1 AND status IN ('queued', 'unknown')
     RETURNING id`,
    [operation.id, reason],
  );
  if (updated.rowCount !== 1) throw new NotificationStateChangedError();
  await insertSkippedFact(client, operation.id, reason);
  await client.query(
    `UPDATE public.outbox
     SET published_at = COALESCE(published_at, pg_catalog.now())
     WHERE id = $1`,
    [operation.outbox_id],
  );
  await updateJob(client, job, config, { status: "completed", reason: null });
}

async function manualCurrentOperation(
  client: DatabaseClient,
  operation: OperationRow,
  job: NotificationJobLease,
  config: NotificationRuntimeConfig,
  reason: string,
): Promise<void> {
  const updated = await client.query(
    `UPDATE public.notification_delivery_operations
     SET status = 'manual', last_checked_at = pg_catalog.now(),
         last_error = $2, updated_at = pg_catalog.now()
     WHERE id = $1 AND status IN ('queued', 'dispatching', 'unknown')
     RETURNING id`,
    [operation.id, reason],
  );
  if (updated.rowCount !== 1) throw new NotificationStateChangedError();
  await updateJob(client, job, config, { status: "manual", reason });
}

function notificationTemplateValues(
  operation: OperationRow,
  payload: StandardNotificationPayload,
): Readonly<Record<string, NotificationTemplateValue | undefined>> {
  const values: Record<string, NotificationTemplateValue | undefined> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string" || typeof value === "number") values[key] = value;
  }
  if (payload.amountDueMinor && /^\d+$/.test(payload.amountDueMinor)) {
    const amountDueMinor = BigInt(payload.amountDueMinor);
    values.amountDue = `${amountDueMinor / 100n}.${(amountDueMinor % 100n)
      .toString()
      .padStart(2, "0")}`;
  }
  if (payload.executionMode) {
    values.executionMode = operation.template_locale === "zh-CN"
      ? payload.executionMode === "automatic"
        ? "Mock Provider 自动终止"
        : "管理员人工终止"
      : payload.executionMode === "automatic"
        ? "automatic Mock Provider termination"
        : "administrator manual termination";
  }
  return values;
}

function operationTemplateRevision(operation: OperationRow): NotificationTemplateRevision {
  return {
    revisionId: operation.template_revision_id,
    eventType: operation.event_type,
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
}

async function prepareDispatch(
  pool: pg.Pool,
  pointer: OperationRow,
  job: NotificationJobLease,
  config: NotificationRuntimeConfig,
): Promise<DispatchPreparation> {
  return transaction(pool, async (client) => {
    const consent = await lockRecipientForDispatch(client, pointer);
    const renewal = consent.kind === "eligible"
      ? await renewalDecision(client, pointer)
      : ({ kind: "ready", payload: pointer.payload_snapshot } as const);
    const operation = await lockOutboxOperationAndJob(client, pointer, job, config.workerId);
    if (!(["queued", "unknown"] as const).includes(operation.status as "queued" | "unknown")) {
      throw new NotificationStateChangedError();
    }
    if (consent.kind === "ineligible") {
      await skipCurrentOperation(client, operation, job, config, consent.reason);
      return { kind: "finished" };
    }
    if (renewal.kind === "skip") {
      await skipCurrentOperation(client, operation, job, config, renewal.reason);
      return { kind: "finished" };
    }
    if (renewal.kind === "manual") {
      await manualCurrentOperation(client, operation, job, config, renewal.reason);
      return { kind: "finished" };
    }

    let requestSnapshot: MockMailRequestSnapshot;
    try {
      if (operation.rendered_request_snapshot) {
        requestSnapshot = parseMockMailRequestSnapshot(operation.rendered_request_snapshot);
        if (
          mockMailRequestFingerprint(requestSnapshot) !==
          operation.rendered_request_fingerprint
        ) {
          throw new Error("rendered fingerprint mismatch");
        }
      } else {
        const rendered = renderNotificationTemplate(
          operationTemplateRevision(operation),
          notificationTemplateValues(operation, renewal.payload),
        );
        requestSnapshot = mockMailRequestSnapshot(
          {
            recipient: operation.recipient,
            template: rendered.template,
            locale: operation.locale,
            subject: rendered.subject,
            body: rendered.body,
            sensitive: rendered.sensitive,
          },
          config.scenario,
        );
      }
    } catch {
      await manualCurrentOperation(
        client,
        operation,
        job,
        config,
        "NOTIFICATION_RENDER_CONTRACT_INVALID",
      );
      return { kind: "finished" };
    }

    const renderedFingerprint = mockMailRequestFingerprint(requestSnapshot);
    const updated = await client.query(
      `UPDATE public.notification_delivery_operations
       SET status = 'dispatching',
           attempts = attempts + 1,
           rendered_request_snapshot = COALESCE(rendered_request_snapshot, $2),
           rendered_request_fingerprint = COALESCE(rendered_request_fingerprint, $3),
           dispatch_started_at = COALESCE(dispatch_started_at, pg_catalog.now()),
           last_error = NULL,
           updated_at = pg_catalog.now()
       WHERE id = $1 AND status IN ('queued', 'unknown')
       RETURNING provider_operation_id`,
      [operation.id, requestSnapshot, renderedFingerprint],
    );
    if (updated.rowCount !== 1) throw new NotificationStateChangedError();
    return {
      kind: "dispatch",
      providerOperationId: operation.provider_operation_id,
      requestSnapshot,
    };
  });
}

function providerFailureReason(status: NotificationDeliveryFact["status"]): string | null {
  if (status === "delivered") return null;
  return status === "bounced"
    ? "MOCK_MAIL_PROVIDER_BOUNCED"
    : "MOCK_MAIL_PROVIDER_FAILED";
}

async function insertProviderFact(
  client: DatabaseClient,
  operation: OperationRow,
  fact: NotificationDeliveryFact,
): Promise<void> {
  const reason = providerFailureReason(fact.status);
  await client.query(
    `INSERT INTO public.notification_delivery_facts(
       outbox_id, attempt_number,
       invitation_id, contact_id, recipient_user_id, client_account_id,
       recipient_subject_id, recipient_scope_id,
       recipient_kind, category, recipient, locale,
       provider_installation_id, provider_operation_id, provider_message_id,
       status, failure_reason, provider_occurred_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11, $12,
       $13, $14, $15,
       $16, $17, $18
     )`,
    [
      operation.outbox_id,
      operation.attempt_number,
      operation.invitation_id,
      operation.contact_id,
      operation.recipient_user_id,
      operation.client_account_id,
      operation.recipient_subject_id,
      operation.recipient_scope_id,
      operation.recipient_kind,
      operation.category,
      operation.recipient,
      operation.locale,
      operation.provider_installation_id,
      operation.provider_operation_id,
      operation.provider_operation_id,
      fact.status,
      reason,
      fact.deliveredAt,
    ],
  );

  if (
    operation.event_type === "notification.renewal_reminder_requested" &&
    operation.recipient_kind === "account_user"
  ) {
    await client.query(
      `INSERT INTO public.renewal_reminder_delivery_facts(
         intent_id, provider_installation_id, provider_message_id,
         status, provider_occurred_at,
         attempt_number, provider_operation_id, failure_reason
       )
       SELECT reminder.id, $2, $3, $4, $5, $6, $7, $8
       FROM public.renewal_reminder_intents reminder
       WHERE reminder.outbox_id = $1`,
      [
        operation.outbox_id,
        operation.provider_installation_id,
        operation.provider_operation_id,
        fact.status,
        fact.deliveredAt,
        operation.attempt_number,
        operation.provider_operation_id,
        reason,
      ],
    );
  }
}

async function finalizeProviderFact(
  pool: pg.Pool,
  pointer: OperationRow,
  job: NotificationJobLease,
  config: NotificationRuntimeConfig,
  fact: NotificationDeliveryFact,
): Promise<void> {
  await transaction(pool, async (client) => {
    const operation = await lockOutboxOperationAndJob(client, pointer, job, config.workerId);
    if (!(["dispatching", "unknown"] as const).includes(
      operation.status as "dispatching" | "unknown",
    )) {
      throw new NotificationStateChangedError();
    }
    if (fact.operationId !== operation.provider_operation_id) {
      await manualCurrentOperation(
        client,
        operation,
        job,
        config,
        "MOCK_MAIL_OPERATION_MISMATCH",
      );
      return;
    }
    const operationStatus = fact.status === "failed" ? "failed" : "succeeded";
    const reason = providerFailureReason(fact.status);
    const updated = await client.query(
      `UPDATE public.notification_delivery_operations
       SET status = $2, last_checked_at = pg_catalog.now(),
           last_error = $3, updated_at = pg_catalog.now()
       WHERE id = $1 AND status IN ('dispatching', 'unknown')
       RETURNING id`,
      [operation.id, operationStatus, reason],
    );
    if (updated.rowCount !== 1) throw new NotificationStateChangedError();
    await insertProviderFact(client, operation, fact);
    if (fact.status === "failed") {
      await updateJob(client, job, config, {
        status: "pending",
        reason,
        delayAttempt: operation.attempt_number,
      });
      return;
    }
    await client.query(
      `UPDATE public.outbox
       SET published_at = COALESCE(published_at, pg_catalog.now())
       WHERE id = $1`,
      [operation.outbox_id],
    );
    await updateJob(client, job, config, { status: "completed", reason: null });
  });
}

async function rescheduleUnknown(
  pool: pg.Pool,
  pointer: OperationRow,
  job: NotificationJobLease,
  config: NotificationRuntimeConfig,
  reason: string,
): Promise<void> {
  await transaction(pool, async (client) => {
    const operation = await lockOutboxOperationAndJob(client, pointer, job, config.workerId);
    if (!(["dispatching", "unknown"] as const).includes(
      operation.status as "dispatching" | "unknown",
    )) {
      throw new NotificationStateChangedError();
    }
    const updated = await client.query(
      `UPDATE public.notification_delivery_operations
       SET status = 'unknown', last_checked_at = pg_catalog.now(),
           last_error = $2, updated_at = pg_catalog.now()
       WHERE id = $1 AND status IN ('dispatching', 'unknown')
       RETURNING id`,
      [operation.id, reason],
    );
    if (updated.rowCount !== 1) throw new NotificationStateChangedError();
    await updateJob(client, job, config, {
      status: "pending",
      reason,
      delayAttempt: operation.attempts,
    });
  });
}

async function manualProviderOperation(
  pool: pg.Pool,
  pointer: OperationRow,
  job: NotificationJobLease,
  config: NotificationRuntimeConfig,
  reason: string,
): Promise<void> {
  await transaction(pool, async (client) => {
    const operation = await lockOutboxOperationAndJob(client, pointer, job, config.workerId);
    await manualCurrentOperation(client, operation, job, config, reason);
  });
}

async function dispatchPrepared(
  pool: pg.Pool,
  pointer: OperationRow,
  job: NotificationJobLease,
  config: NotificationRuntimeConfig,
  prepared: Extract<DispatchPreparation, { kind: "dispatch" }>,
): Promise<void> {
  const outcome = await postMockMailNotification({
    providerUrl: config.providerUrl,
    providerToken: config.providerToken,
    operationId: prepared.providerOperationId,
    requestSnapshot: prepared.requestSnapshot,
    timeoutMs: config.providerTimeoutMs,
  });
  const current = await loadLatestOperation(pool, pointer.outbox_id);
  if (!current || current.id !== pointer.id) throw new NotificationStateChangedError();
  if (outcome.kind === "found") {
    await finalizeProviderFact(pool, current, job, config, outcome.fact);
  } else if (outcome.kind === "unknown") {
    await rescheduleUnknown(
      pool,
      current,
      job,
      config,
      `MOCK_MAIL_POST_${outcome.code.toUpperCase()}`,
    );
  } else {
    await manualProviderOperation(
      pool,
      current,
      job,
      config,
      `MOCK_MAIL_POST_${outcome.code.toUpperCase()}`,
    );
  }
}

async function reconcileOperation(
  pool: pg.Pool,
  pointer: OperationRow,
  job: NotificationJobLease,
  config: NotificationRuntimeConfig,
): Promise<void> {
  if (pointer.status === "dispatching") {
    await transaction(pool, async (client) => {
      const operation = await lockOutboxOperationAndJob(client, pointer, job, config.workerId);
      const updated = await client.query(
        `UPDATE public.notification_delivery_operations
         SET status = 'unknown', last_checked_at = pg_catalog.now(),
             last_error = 'RECONCILING_POTENTIALLY_SENT_NOTIFICATION',
             updated_at = pg_catalog.now()
         WHERE id = $1 AND status = 'dispatching'
         RETURNING id`,
        [operation.id],
      );
      if (updated.rowCount !== 1) throw new NotificationStateChangedError();
    });
  }
  const current = await loadLatestOperation(pool, pointer.outbox_id);
  if (!current || current.id !== pointer.id || current.status !== "unknown") {
    throw new NotificationStateChangedError();
  }
  const outcome = await getMockMailNotification({
    providerUrl: config.providerUrl,
    providerToken: config.providerToken,
    operationId: current.provider_operation_id,
    timeoutMs: config.providerTimeoutMs,
  });
  if (outcome.kind === "found") {
    await finalizeProviderFact(pool, current, job, config, outcome.fact);
    return;
  }
  if (outcome.kind === "retry") {
    await rescheduleUnknown(
      pool,
      current,
      job,
      config,
      `MOCK_MAIL_GET_${outcome.code.toUpperCase()}`,
    );
    return;
  }
  if (outcome.kind === "manual") {
    await manualProviderOperation(
      pool,
      current,
      job,
      config,
      `MOCK_MAIL_GET_${outcome.code.toUpperCase()}`,
    );
    return;
  }
  if (
    current.operation_origin === "schema_019_backfill" &&
    current.outbox_published_at &&
    !current.rendered_request_snapshot
  ) {
    await manualProviderOperation(
      pool,
      current,
      job,
      config,
      "LEGACY_PUBLISHED_NOTIFICATION_NOT_FOUND_AT_PROVIDER",
    );
    return;
  }
  const prepared = await prepareDispatch(pool, current, job, config);
  if (prepared.kind === "dispatch") {
    await dispatchPrepared(pool, current, job, config, prepared);
  }
}

async function insertNextOperation(
  client: DatabaseClient,
  previous: OperationRow,
  status: "queued" | "skipped",
  reason: string | null,
): Promise<OperationRow> {
  const attemptNumber = previous.attempt_number + 1;
  const providerOperationId = notificationOperationId(previous.outbox_id, attemptNumber);
  const inserted = await client.query<OperationRow>(
    `INSERT INTO public.notification_delivery_operations(
       outbox_id, attempt_number, provider_operation_id,
       provider_installation_id, operation_origin,
       event_type, template_revision, template_revision_id, template_locale,
       payload_snapshot,
       invitation_id, contact_id, recipient_user_id, client_account_id,
       recipient_subject_id, recipient_scope_id,
       recipient_kind, category, recipient, locale, request_fingerprint,
       status, last_error
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16,
       $17, $18, $19, $20, $21, $22, $23
     )
     RETURNING *, NULL::timestamptz AS outbox_published_at`,
    [
      previous.outbox_id,
      attemptNumber,
      providerOperationId,
      previous.provider_installation_id,
      previous.operation_origin,
      previous.event_type,
      previous.template_revision,
      previous.template_revision_id,
      previous.template_locale,
      previous.payload_snapshot,
      previous.invitation_id,
      previous.contact_id,
      previous.recipient_user_id,
      previous.client_account_id,
      previous.recipient_subject_id,
      previous.recipient_scope_id,
      previous.recipient_kind,
      previous.category,
      previous.recipient,
      previous.locale,
      previous.request_fingerprint,
      status,
      reason,
    ],
  );
  const operation = inserted.rows[0];
  if (!operation) throw new Error("Unable to create notification delivery attempt");
  return operation;
}

async function createNextAttempt(
  pool: pg.Pool,
  pointer: OperationRow,
  job: NotificationJobLease,
  config: NotificationRuntimeConfig,
): Promise<void> {
  await transaction(pool, async (client) => {
    const consent = await lockRecipientForDispatch(client, pointer);
    const renewal = consent.kind === "eligible"
      ? await renewalDecision(client, pointer)
      : ({ kind: "ready", payload: pointer.payload_snapshot } as const);
    const previous = await lockOutboxOperationAndJob(client, pointer, job, config.workerId);
    if (previous.status !== "failed") throw new NotificationStateChangedError();

    if (consent.kind === "ineligible") {
      const skipped = await insertNextOperation(client, previous, "skipped", consent.reason);
      await insertSkippedFact(client, skipped.id, consent.reason);
      await client.query(
        `UPDATE public.outbox
         SET published_at = COALESCE(published_at, pg_catalog.now())
         WHERE id = $1`,
        [previous.outbox_id],
      );
      await updateJob(client, job, config, { status: "completed", reason: null });
      return;
    }

    if (renewal.kind === "manual") {
      await updateJob(client, job, config, {
        status: "manual",
        reason: renewal.reason,
      });
      return;
    }

    if (renewal.kind === "skip") {
      const queued = await insertNextOperation(client, previous, "queued", null);
      await client.query(
        `UPDATE public.notification_delivery_operations
         SET status = 'skipped', last_error = $2, updated_at = pg_catalog.now()
         WHERE id = $1 AND status = 'queued'`,
        [queued.id, renewal.reason],
      );
      await insertSkippedFact(client, queued.id, renewal.reason);
      await client.query(
        `UPDATE public.outbox
         SET published_at = COALESCE(published_at, pg_catalog.now())
         WHERE id = $1`,
        [previous.outbox_id],
      );
      await updateJob(client, job, config, { status: "completed", reason: null });
      return;
    }

    if (previous.attempt_number >= config.maxAttempts) {
      await updateJob(client, job, config, {
        status: "manual",
        reason: "NOTIFICATION_ATTEMPT_BUDGET_EXHAUSTED",
      });
      return;
    }

    await insertNextOperation(client, previous, "queued", null);
    await updateJob(client, job, config, {
      status: "pending",
      reason: "NOTIFICATION_RETRY_SCHEDULED",
      delayAttempt: previous.attempt_number,
    });
  });
}

async function finishTerminalOperation(
  pool: pg.Pool,
  pointer: OperationRow,
  job: NotificationJobLease,
  config: NotificationRuntimeConfig,
): Promise<void> {
  await transaction(pool, async (client) => {
    const operation = await lockOutboxOperationAndJob(client, pointer, job, config.workerId);
    if (operation.status === "succeeded" || operation.status === "skipped") {
      await client.query(
        `UPDATE public.outbox
         SET published_at = COALESCE(published_at, pg_catalog.now())
         WHERE id = $1`,
        [operation.outbox_id],
      );
      await updateJob(client, job, config, { status: "completed", reason: null });
      return;
    }
    if (operation.status === "manual") {
      await updateJob(client, job, config, {
        status: "manual",
        reason: operation.last_error ?? "NOTIFICATION_REQUIRES_MANUAL_REVIEW",
      });
      return;
    }
    throw new NotificationStateChangedError();
  });
}

function strictOutboxId(job: NotificationJobLease): string | null {
  if (
    job.job_type !== "notification.send" ||
    Object.keys(job.payload).length !== 1 ||
    !job.payload.outboxId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      job.payload.outboxId,
    )
  ) {
    return null;
  }
  return job.payload.outboxId;
}

function isLockContention(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "55P03");
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : null;
}

const TRANSIENT_NOTIFICATION_ERROR_CODES = new Set([
  "40001",
  "40003",
  "40P01",
  "55P03",
  "57014",
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "53300",
  "53400",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

export function isTransientNotificationFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  const direct =
    TRANSIENT_NOTIFICATION_ERROR_CODES.has(errorCode(error) ?? "") ||
    message === "timeout exceeded when trying to connect" ||
    message === "timeout expired" ||
    message === "Connection terminated due to connection timeout" ||
    message === "Connection terminated unexpectedly" ||
    message === "Connection terminated";
  if (direct) return true;
  const cause = error && typeof error === "object" && "cause" in error
    ? error.cause
    : null;
  return cause !== null && cause !== error && isTransientNotificationFailure(cause);
}

export async function persistUnexpectedNotificationFailure(
  pool: pg.Pool,
  job: NotificationJobLease,
  config: NotificationRuntimeConfig,
  error: unknown,
): Promise<void> {
  if (error instanceof NotificationLeaseLostError) throw error;
  const transient = isTransientNotificationFailure(error);
  await updateJobWithoutOperation(
    pool,
    job,
    config,
    transient ? "pending" : "manual",
    transient
      ? "NOTIFICATION_TRANSIENT_DATABASE_FAILURE"
      : "NOTIFICATION_INVARIANT_FAILURE_REQUIRES_MANUAL_REVIEW",
  );
}

export async function processNotificationDeliveryJob(
  pool: pg.Pool,
  job: NotificationJobLease,
  config: NotificationRuntimeConfig,
): Promise<void> {
  const outboxId = strictOutboxId(job);
  if (!outboxId) {
    await updateJobWithoutOperation(
      pool,
      job,
      config,
      "manual",
      "INVALID_NOTIFICATION_JOB_PAYLOAD",
    );
    return;
  }
  try {
    const operation = await loadLatestOperation(pool, outboxId);
    if (!operation) {
      await updateJobWithoutOperation(
        pool,
        job,
        config,
        "manual",
        "NOTIFICATION_OPERATION_MISSING",
      );
      return;
    }
    switch (operation.status) {
      case "queued": {
        const prepared = await prepareDispatch(pool, operation, job, config);
        if (prepared.kind === "dispatch") {
          await dispatchPrepared(pool, operation, job, config, prepared);
        }
        return;
      }
      case "dispatching":
      case "unknown":
        await reconcileOperation(pool, operation, job, config);
        return;
      case "failed":
        await createNextAttempt(pool, operation, job, config);
        return;
      case "succeeded":
      case "skipped":
      case "manual":
        await finishTerminalOperation(pool, operation, job, config);
        return;
    }
  } catch (error) {
    if (isLockContention(error) || error instanceof NotificationStateChangedError) {
      await updateJobWithoutOperation(
        pool,
        job,
        config,
        "pending",
        isLockContention(error)
          ? "NOTIFICATION_RECIPIENT_LOCK_BUSY"
          : "NOTIFICATION_STATE_CHANGED",
      );
      return;
    }
    throw error;
  }
}

export function notificationOutboxIdFromJob(job: NotificationJobLease): string | null {
  return strictOutboxId(job);
}

export async function recoverStaleNotificationDeliveryJob(
  pool: pg.Pool,
  candidate: NotificationJobLease,
  input: Readonly<{ lockTimeoutSeconds: number; retryDelaySeconds: number }>,
): Promise<boolean> {
  const outboxId = notificationOutboxIdFromJob(candidate);
  return transaction(pool, async (client) => {
    let operation: { id: string; status: string } | undefined;
    if (outboxId) {
      const outbox = await client.query(
        `SELECT id
         FROM public.outbox
         WHERE id = $1
         FOR UPDATE`,
        [outboxId],
      );
      if (outbox.rows[0]) {
        const operations = await client.query<{ id: string; status: string }>(
          `SELECT id, status
           FROM public.notification_delivery_operations
           WHERE outbox_id = $1
           ORDER BY attempt_number DESC
           LIMIT 1
           FOR UPDATE`,
          [outboxId],
        );
        operation = operations.rows[0];
      }
    }
    const job = await lockSchema016StaleJob<pg.QueryResultRow & NotificationJobLease>(
      client,
      candidate,
      input.lockTimeoutSeconds,
    );
    if (!job) return false;

    const updateRecoveredJob = async (
      status: "completed" | "pending" | "manual",
      reason: string | null,
    ): Promise<void> => {
      await client.query(
        `UPDATE public.durable_jobs
         SET status = $3,
             attempts = CASE WHEN $3 = 'pending' THEN 0 ELSE attempts END,
             available_at = CASE
               WHEN $3 = 'pending'
                 THEN pg_catalog.now() + pg_catalog.make_interval(secs => $4)
               ELSE available_at
             END,
             locked_at = NULL, locked_by = NULL, last_error = $5,
             updated_at = pg_catalog.now()
         WHERE id = $1 AND status = 'running' AND attempts = $2`,
        [
          job.id,
          job.attempts,
          status,
          input.retryDelaySeconds,
          reason?.slice(0, 1_000) ?? null,
        ],
      );
    };

    if (!operation) {
      await updateRecoveredJob(
        "manual",
        "stale notification job has no exact delivery operation",
      );
      return true;
    }
    if (operation.status === "dispatching") {
      await client.query(
        `UPDATE public.notification_delivery_operations
         SET status = 'unknown', last_checked_at = pg_catalog.now(),
             last_error = 'STALE_DISPATCH_REQUIRES_PROVIDER_RECONCILIATION',
             updated_at = pg_catalog.now()
         WHERE id = $1 AND status = 'dispatching'`,
        [operation.id],
      );
      await updateRecoveredJob(
        "pending",
        "stale potentially-sent notification will reconcile its stable Provider operation",
      );
      return true;
    }
    if (["queued", "unknown", "failed"].includes(operation.status)) {
      await updateRecoveredJob(
        "pending",
        "stale notification state was recovered without replaying an unverified Provider result",
      );
      return true;
    }
    if (["succeeded", "skipped"].includes(operation.status)) {
      await updateRecoveredJob("completed", null);
      return true;
    }
    await updateRecoveredJob(
      "manual",
      "notification delivery operation requires manual inspection",
    );
    return true;
  });
}
