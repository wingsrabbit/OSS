// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import type { DatabaseClient } from "./database.js";

export type NotificationCategory =
  | "identity"
  | "membership_invitation"
  | "billing"
  | "service"
  | "support";

export type NotificationLocale = "en" | "zh-CN";

export type NotificationRecipient =
  | Readonly<{
      kind: "identity_user";
      category: "identity";
      userId: string;
      email: string;
      locale: NotificationLocale;
    }>
  | Readonly<{
      kind: "invitation";
      category: "membership_invitation";
      invitationId: string;
      clientAccountId: string;
      email: string;
      locale: NotificationLocale;
    }>
  | Readonly<{
      kind: "contact";
      category: "billing" | "service" | "support";
      contactId: string;
      clientAccountId: string;
      email: string;
      locale: NotificationLocale;
    }>
  | Readonly<{
      kind: "account_user";
      category: "billing" | "service" | "support";
      userId: string;
      clientAccountId: string;
      email: string;
      locale: NotificationLocale;
    }>;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type NotificationPayload = Readonly<Record<string, JsonValue>>;

export type EnqueuedNotification = Readonly<{
  outboxId: string;
  providerOperationId: string;
  requestFingerprint: string;
  status: "queued" | "skipped";
}>;

type NotificationRecipientLockResult =
  | Readonly<{ status: "queued" }>
  | Readonly<{ status: "skipped"; reason: string }>;

const MOCK_MAIL_PROVIDER_INSTALLATION_ID = "mock-mail-v1";

function oneTimeTokenFromUrl(value: JsonValue | undefined, pathname: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    const tokens = parsed.searchParams.getAll("token");
    const token = tokens.length === 1 ? tokens[0] : null;
    return parsed.pathname === pathname && token && /^[A-Za-z0-9_-]{43}$/.test(token)
      ? token
      : null;
  } catch {
    return null;
  }
}

function rethrowNotificationRecipientLock(error: unknown): never {
  if (error && typeof error === "object" && "code" in error && error.code === "55P03") {
    throw Object.assign(new Error("Notification recipient changed concurrently; retry"), {
      statusCode: 409,
      code: "NOTIFICATION_RECIPIENT_CHANGED",
    });
  }
  throw error;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Notification payload numbers must be safe integers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

export function notificationRequestFingerprint(
  eventType: string,
  templateRevision: string,
  payload: NotificationPayload,
): string {
  return createHash("sha256")
    .update("opensales:notification-request:v2\0", "utf8")
    .update(eventType, "utf8")
    .update("\0", "utf8")
    .update(templateRevision, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(payload), "utf8")
    .digest("hex");
}

async function lockNotificationRecipient(
  client: DatabaseClient,
  eventType: string,
  payload: NotificationPayload,
  recipient: NotificationRecipient,
): Promise<NotificationRecipientLockResult> {
  const mismatch = (): never => {
    throw Object.assign(new Error("Notification recipient is no longer eligible"), {
      statusCode: 409,
      code: "NOTIFICATION_RECIPIENT_CHANGED",
    });
  };
  if (recipient.kind === "identity_user") {
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
      [recipient.userId],
    );
    const row = principal.rows[0] ?? mismatch();
    if (row.email !== recipient.email || row.locale !== recipient.locale) mismatch();
    if (eventType === "notification.email_verification_requested") {
      const verificationTokenId = payload.verificationTokenId;
      const verificationToken = oneTimeTokenFromUrl(payload.verificationUrl, "/verify");
      if (typeof verificationTokenId !== "string") mismatch();
      const exactVerificationToken = verificationToken ?? mismatch();
      const verificationTokenDigest = createHash("sha256")
        .update(exactVerificationToken, "utf8")
        .digest();
      const token = await client.query<{ eligible: boolean }>(
        `SELECT used_at IS NULL
                  AND invalidated_at IS NULL
                  AND expires_at > pg_catalog.clock_timestamp() AS eligible
         FROM public.email_verification_tokens
         WHERE id = $1
           AND user_id = $2
           AND token_digest = $3
         FOR SHARE NOWAIT`,
        [verificationTokenId, recipient.userId, verificationTokenDigest],
      );
      const tokenRow = token.rows[0] ?? mismatch();
      if (row.restricted_at || row.email_verified_at || !tokenRow.eligible) {
        return { status: "skipped", reason: "VERIFICATION_RECIPIENT_INELIGIBLE" };
      }
    }
    if (row.restricted_at) {
      return { status: "skipped", reason: "IDENTITY_RECIPIENT_INELIGIBLE" };
    }
    return { status: "queued" };
  }

  if (recipient.kind === "account_user") {
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
      [recipient.userId],
    );
    const account = await client.query<{ owner_user_id: string }>(
      `SELECT owner_user_id
       FROM public.client_accounts
       WHERE id = $1
       FOR SHARE NOWAIT`,
      [recipient.clientAccountId],
    );
    const membership = await client.query<{
      removed_at: Date | null;
      restricted_at: Date | null;
    }>(
      `SELECT removed_at, restricted_at
       FROM public.client_memberships
       WHERE user_id = $1 AND client_account_id = $2
       FOR SHARE NOWAIT`,
      [recipient.userId, recipient.clientAccountId],
    );
    const row = principal.rows[0] ?? mismatch();
    const accountRow = account.rows[0] ?? mismatch();
    const membershipRow = membership.rows[0] ?? mismatch();
    if (
      row.email !== recipient.email ||
      row.locale !== recipient.locale ||
      (eventType === "notification.renewal_reminder_requested" &&
        accountRow.owner_user_id !== recipient.userId)
    ) {
      mismatch();
    }
    if (
      !row.email_verified_at ||
      row.restricted_at ||
      membershipRow.removed_at ||
      membershipRow.restricted_at
    ) {
      return { status: "skipped", reason: "ACCOUNT_USER_RECIPIENT_INELIGIBLE" };
    }
    return { status: "queued" };
  }

  const account = await client.query(
    `SELECT id
     FROM public.client_accounts
     WHERE id = $1
     FOR SHARE NOWAIT`,
    [recipient.clientAccountId],
  );
  if (!account.rows[0]) mismatch();

  if (recipient.kind === "invitation") {
    const invitationToken = oneTimeTokenFromUrl(
      payload.invitationUrl,
      "/membership-invitations/accept",
    );
    const invitationTokenDigest = invitationToken
      ? createHash("sha256").update(invitationToken, "utf8").digest()
      : mismatch();
    const invitation = await client.query<{
      email: string;
      locale: string;
      eligible: boolean;
    }>(
      `SELECT email::text, locale,
              accepted_at IS NULL
                AND revoked_at IS NULL
                AND expires_at > pg_catalog.clock_timestamp() AS eligible
       FROM public.client_membership_invitations
       WHERE id = $1
         AND client_account_id = $2
         AND token_digest = $3
       FOR SHARE NOWAIT`,
      [
        recipient.invitationId,
        recipient.clientAccountId,
        invitationTokenDigest,
      ],
    );
    const row = invitation.rows[0] ?? mismatch();
    if (
      row.email !== recipient.email ||
      row.locale !== recipient.locale
    ) {
      mismatch();
    }
    if (!row.eligible) {
      return { status: "skipped", reason: "INVITATION_RECIPIENT_INELIGIBLE" };
    }
    return { status: "queued" };
  }

  if (recipient.kind === "contact") {
    const contact = await client.query<{
      email: string;
      locale: string;
      eligible: boolean;
    }>(
      `SELECT email::text, locale,
              removed_at IS NULL
                AND notification_subscriptions ? $3 AS eligible
       FROM public.client_contacts
       WHERE id = $1 AND client_account_id = $2
       FOR SHARE NOWAIT`,
      [recipient.contactId, recipient.clientAccountId, recipient.category],
    );
    const row = contact.rows[0] ?? mismatch();
    if (
      row.email !== recipient.email ||
      row.locale !== recipient.locale
    ) {
      mismatch();
    }
    if (!row.eligible) {
      return { status: "skipped", reason: "CONTACT_RECIPIENT_INELIGIBLE" };
    }
    return { status: "queued" };
  }

  return mismatch();
}

export function notificationProviderOperationId(
  outboxId: string,
  attemptNumber: number,
): string {
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error("Notification attempt number must be a positive integer");
  }
  const bytes = createHash("sha256")
    .update(`opensales:notification:${outboxId}:${attemptNumber}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function operationIdentity(recipient: NotificationRecipient): Readonly<{
  invitationId: string | null;
  contactId: string | null;
  recipientUserId: string | null;
  clientAccountId: string | null;
  recipientSubjectId: string;
  recipientScopeId: string;
}> {
  switch (recipient.kind) {
    case "identity_user":
      return {
        invitationId: null,
        contactId: null,
        recipientUserId: recipient.userId,
        clientAccountId: null,
        recipientSubjectId: recipient.userId,
        recipientScopeId: recipient.userId,
      };
    case "invitation":
      return {
        invitationId: recipient.invitationId,
        contactId: null,
        recipientUserId: null,
        clientAccountId: recipient.clientAccountId,
        recipientSubjectId: recipient.invitationId,
        recipientScopeId: recipient.clientAccountId,
      };
    case "contact":
      return {
        invitationId: null,
        contactId: recipient.contactId,
        recipientUserId: null,
        clientAccountId: recipient.clientAccountId,
        recipientSubjectId: recipient.contactId,
        recipientScopeId: recipient.clientAccountId,
      };
    case "account_user":
      return {
        invitationId: null,
        contactId: null,
        recipientUserId: recipient.userId,
        clientAccountId: recipient.clientAccountId,
        recipientSubjectId: recipient.userId,
        recipientScopeId: recipient.clientAccountId,
      };
  }
}

function payloadWithRecipient(
  payload: NotificationPayload,
  recipient: NotificationRecipient,
): NotificationPayload {
  const identity = operationIdentity(recipient);
  return {
    ...payload,
    email: recipient.email,
    locale: recipient.locale,
    notificationCategory: recipient.category,
    notificationRecipientKind: recipient.kind,
    notificationRecipientSubjectId: identity.recipientSubjectId,
    notificationRecipientScopeId: identity.recipientScopeId,
    ...(identity.invitationId ? { invitationId: identity.invitationId } : {}),
    ...(identity.contactId ? { contactId: identity.contactId } : {}),
    ...(identity.recipientUserId ? { userId: identity.recipientUserId } : {}),
    ...(identity.clientAccountId ? { accountId: identity.clientAccountId } : {}),
  };
}

function sameOperationSnapshot(
  row: Readonly<{
    provider_operation_id: string;
    provider_installation_id: string;
    operation_origin: string;
    event_type: string;
    template_revision: string;
    payload_snapshot: NotificationPayload;
    invitation_id: string | null;
    contact_id: string | null;
    recipient_user_id: string | null;
    client_account_id: string | null;
    recipient_subject_id: string;
    recipient_scope_id: string;
    recipient_kind: string;
    category: string;
    recipient: string;
    locale: string;
    request_fingerprint: string;
  }>,
  expected: Readonly<{
    providerOperationId: string;
    eventType: string;
    templateRevision: string;
    payload: NotificationPayload;
    invitationId: string | null;
    contactId: string | null;
    recipientUserId: string | null;
    clientAccountId: string | null;
    recipientSubjectId: string;
    recipientScopeId: string;
    recipient: NotificationRecipient;
    requestFingerprint: string;
  }>,
): boolean {
  return (
    row.provider_operation_id === expected.providerOperationId &&
    row.provider_installation_id === MOCK_MAIL_PROVIDER_INSTALLATION_ID &&
    row.operation_origin === "application" &&
    row.event_type === expected.eventType &&
    row.template_revision === expected.templateRevision &&
    canonicalJson(row.payload_snapshot) === canonicalJson(expected.payload) &&
    row.invitation_id === expected.invitationId &&
    row.contact_id === expected.contactId &&
    row.recipient_user_id === expected.recipientUserId &&
    row.client_account_id === expected.clientAccountId &&
    row.recipient_subject_id === expected.recipientSubjectId &&
    row.recipient_scope_id === expected.recipientScopeId &&
    row.recipient_kind === expected.recipient.kind &&
    row.category === expected.recipient.category &&
    row.recipient === expected.recipient.email &&
    row.locale === expected.recipient.locale &&
    row.request_fingerprint === expected.requestFingerprint
  );
}

export async function enqueueNotification(
  client: DatabaseClient,
  input: Readonly<{
    eventType: string;
    templateRevision: string;
    uniqueKey: string;
    payload: NotificationPayload;
    recipient: NotificationRecipient;
  }>,
): Promise<EnqueuedNotification> {
  const payload = payloadWithRecipient(input.payload, input.recipient);
  const requestFingerprint = notificationRequestFingerprint(
    input.eventType,
    input.templateRevision,
    payload,
  );
  let recipientState: NotificationRecipientLockResult;
  try {
    recipientState = await lockNotificationRecipient(
      client,
      input.eventType,
      input.payload,
      input.recipient,
    );
  } catch (error) {
    rethrowNotificationRecipientLock(error);
  }
  try {
    await client.query(
      "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
      [`notification-outbox:${input.eventType}:${input.uniqueKey}`],
    );

  const existingOutbox = await client.query<{ id: string; payload: NotificationPayload }>(
    `SELECT id, payload
     FROM public.outbox
     WHERE event_type = $1 AND unique_key = $2
     FOR UPDATE`,
    [input.eventType, input.uniqueKey],
  );
  let outboxId = existingOutbox.rows[0]?.id;
  if (outboxId) {
    const existingFingerprint = notificationRequestFingerprint(
      input.eventType,
      input.templateRevision,
      existingOutbox.rows[0]!.payload,
    );
    if (existingFingerprint !== requestFingerprint) {
      throw new Error("Notification outbox key was reused with a different immutable request");
    }
  } else {
    const insertedOutbox = await client.query<{ id: string }>(
      `INSERT INTO public.outbox(event_type, unique_key, payload)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [input.eventType, input.uniqueKey, payload],
    );
    outboxId = insertedOutbox.rows[0]?.id;
  }
  if (!outboxId) throw new Error("Unable to create notification outbox event");

  const providerOperationId = notificationProviderOperationId(outboxId, 1);
  const identity = operationIdentity(input.recipient);
  const existingOperation = await client.query<{
    provider_operation_id: string;
    provider_installation_id: string;
    operation_origin: string;
    event_type: string;
    template_revision: string;
    payload_snapshot: NotificationPayload;
    invitation_id: string | null;
    contact_id: string | null;
    recipient_user_id: string | null;
    client_account_id: string | null;
    recipient_subject_id: string;
    recipient_scope_id: string;
    recipient_kind: string;
    category: string;
    recipient: string;
    locale: string;
    request_fingerprint: string;
    status: string;
  }>(
    `SELECT provider_operation_id, provider_installation_id, operation_origin,
            event_type, template_revision, payload_snapshot,
            invitation_id, contact_id, recipient_user_id, client_account_id,
            recipient_subject_id, recipient_scope_id, recipient_kind,
            category, recipient::text, locale, request_fingerprint, status
     FROM public.notification_delivery_operations
     WHERE outbox_id = $1 AND attempt_number = 1
     FOR UPDATE`,
    [outboxId],
  );
  const operation = existingOperation.rows[0];
  let notificationStatus: "queued" | "skipped" = recipientState.status;
  const skippedReason = recipientState.status === "skipped"
    ? recipientState.reason
    : "RECIPIENT_INELIGIBLE_AT_EVENT_COMMIT";
  const expectedOperation = {
    providerOperationId,
    eventType: input.eventType,
    templateRevision: input.templateRevision,
    payload,
    ...identity,
    recipient: input.recipient,
    requestFingerprint,
  };
  if (operation) {
    if (!sameOperationSnapshot(operation, expectedOperation)) {
      throw new Error("Notification delivery operation does not match its immutable outbox");
    }
    notificationStatus = operation.status === "skipped" ? "skipped" : "queued";
  } else {
    await client.query(
      `INSERT INTO public.notification_delivery_operations(
         outbox_id, attempt_number, provider_operation_id,
         provider_installation_id, operation_origin,
         event_type, template_revision, payload_snapshot,
         invitation_id, contact_id,
         recipient_user_id, client_account_id,
         recipient_subject_id, recipient_scope_id,
         recipient_kind, category, recipient, locale, request_fingerprint,
         status, last_error
       ) VALUES (
         $1, 1, $2, $3, 'application', $4, $5, $6,
         $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17, $18, $19
       )`,
      [
        outboxId,
        providerOperationId,
        MOCK_MAIL_PROVIDER_INSTALLATION_ID,
        input.eventType,
        input.templateRevision,
        payload,
        identity.invitationId,
        identity.contactId,
        identity.recipientUserId,
        identity.clientAccountId,
        identity.recipientSubjectId,
        identity.recipientScopeId,
        input.recipient.kind,
        input.recipient.category,
        input.recipient.email,
        input.recipient.locale,
        requestFingerprint,
        notificationStatus,
        notificationStatus === "skipped" ? skippedReason : null,
      ],
    );
  }

  if (notificationStatus === "skipped") {
    await client.query(
      `INSERT INTO public.notification_delivery_facts(
         outbox_id, attempt_number,
         invitation_id, contact_id, recipient_user_id, client_account_id,
         recipient_subject_id, recipient_scope_id,
         recipient_kind, category, recipient, locale,
         provider_operation_id, status, failure_reason
       )
       SELECT operation.outbox_id, operation.attempt_number,
              operation.invitation_id, operation.contact_id,
              operation.recipient_user_id, operation.client_account_id,
              operation.recipient_subject_id, operation.recipient_scope_id,
              operation.recipient_kind, operation.category,
              operation.recipient, operation.locale,
              operation.provider_operation_id, 'skipped', $2
       FROM public.notification_delivery_operations operation
       WHERE operation.outbox_id = $1 AND operation.attempt_number = 1
       ON CONFLICT (outbox_id, attempt_number) DO NOTHING`,
      [outboxId, skippedReason],
    );
    await client.query(
      `UPDATE public.outbox
       SET published_at = COALESCE(published_at, pg_catalog.now())
       WHERE id = $1`,
      [outboxId],
    );
  }

  await client.query(
    `INSERT INTO public.durable_jobs(
       job_type, unique_key, payload, status, last_error
     )
     VALUES ('notification.send', $1, $2, $3, $4)
     ON CONFLICT (job_type, unique_key) DO NOTHING`,
    [
      `outbox:${outboxId}`,
      { outboxId },
      notificationStatus === "skipped" ? "completed" : "pending",
      notificationStatus === "skipped" ? skippedReason : null,
    ],
  );
    return { outboxId, providerOperationId, requestFingerprint, status: notificationStatus };
  } catch (error) {
    rethrowNotificationRecipientLock(error);
  }
}

export async function enqueueSubscribedContactNotifications(
  client: DatabaseClient,
  input: Readonly<{
    eventType: string;
    templateRevision: string;
    uniqueKeyPrefix: string;
    payload: NotificationPayload;
    clientAccountId: string;
    category: "billing" | "service" | "support";
    excludeEmails?: readonly string[];
  }>,
): Promise<readonly EnqueuedNotification[]> {
  let contactRows: Array<{
    id: string;
    email: string;
    locale: NotificationLocale;
  }> = [];
  try {
    const account = await client.query(
      `SELECT id
       FROM public.client_accounts
       WHERE id = $1
       FOR SHARE NOWAIT`,
      [input.clientAccountId],
    );
    if (!account.rows[0]) {
      throw new Error("Notification Client Account is unavailable");
    }
    const contacts = await client.query<{
      id: string;
      email: string;
      locale: NotificationLocale;
    }>(
      `SELECT contact.id, contact.email::text, contact.locale
       FROM public.client_contacts contact
       WHERE contact.client_account_id = $1
         AND contact.removed_at IS NULL
         AND contact.notification_subscriptions ? $2
         AND NOT (contact.email = ANY($3::citext[]))
       ORDER BY contact.id
       FOR SHARE OF contact NOWAIT`,
      [input.clientAccountId, input.category, [...(input.excludeEmails ?? [])]],
    );
    contactRows = contacts.rows;
  } catch (error) {
    rethrowNotificationRecipientLock(error);
  }
  const enqueued: EnqueuedNotification[] = [];
  for (const contact of contactRows) {
    enqueued.push(
      await enqueueNotification(client, {
        eventType: input.eventType,
        templateRevision: input.templateRevision,
        uniqueKey: `${input.uniqueKeyPrefix}:contact:${contact.id}`,
        payload: input.payload,
        recipient: {
          kind: "contact",
          category: input.category,
          contactId: contact.id,
          clientAccountId: input.clientAccountId,
          email: contact.email,
          locale: contact.locale,
        },
      }),
    );
  }
  return enqueued;
}
