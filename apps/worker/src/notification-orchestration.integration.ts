// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { claimSchema016Job } from "./job-claim.js";
import {
  NotificationLeaseLostError,
  processNotificationDeliveryJob,
  recoverStaleNotificationDeliveryJob,
  type NotificationJobLease,
  type NotificationRuntimeConfig,
} from "./notification-orchestration.js";

type ClaimedNotificationJob = pg.QueryResultRow & NotificationJobLease;
type ProviderStatus = "delivered" | "bounced" | "failed";
type PostMode =
  | "terminal"
  | "store_then_drop"
  | "retryable_without_store"
  | "mismatch"
  | "pause_terminal";
type ProviderFact = Readonly<{
  operationId: string;
  status: ProviderStatus;
  deliveredAt: string;
}>;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const workerId = `notification-integration-${randomUUID()}`;
const providerToken = `synthetic-provider-token-${randomUUID()}`;
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 8,
  connectionTimeoutMillis: 5_000,
  options: "-c search_path=pg_catalog,public",
  statement_timeout: 20_000,
  application_name: "opensales-worker-notification-integration",
});

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

const providerFacts = new Map<string, ProviderFact>();
const postModes = new Map<string, PostMode>();
const postOperationIds: string[] = [];
const getOperationIds: string[] = [];
const postBodies = new Map<string, Record<string, unknown>>();
const providerPauses = new Map<string, {
  arrived: () => void;
  release: Promise<void>;
}>();

const provider = createServer(async (request, response) => {
  try {
    if (request.headers.authorization !== `Bearer ${providerToken}`) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/v1/mail") {
      const body = await readJson(request);
      const operationId = typeof body.operationId === "string" ? body.operationId : "";
      const status = body.scenario;
      if (
        !operationId ||
        request.headers["idempotency-key"] !== operationId ||
        !["delivered", "bounced", "failed"].includes(String(status))
      ) {
        writeJson(response, 400, { error: "invalid_request" });
        return;
      }
      postOperationIds.push(operationId);
      postBodies.set(operationId, body);
      const mode = postModes.get(operationId) ?? "terminal";
      if (mode === "retryable_without_store") {
        response.writeHead(503);
        response.end();
        return;
      }
      if (mode === "mismatch") {
        writeJson(response, 202, {
          operationId: randomUUID(),
          status,
          deliveredAt: new Date().toISOString(),
        });
        return;
      }
      const existing = providerFacts.get(operationId);
      const fact = existing ?? {
        operationId,
        status: status as ProviderStatus,
        deliveredAt: new Date().toISOString(),
      };
      providerFacts.set(operationId, fact);
      if (mode === "store_then_drop") {
        request.socket.destroy();
        return;
      }
      if (mode === "pause_terminal") {
        const pause = providerPauses.get(operationId);
        if (!pause) throw new Error("Provider pause was not installed");
        pause.arrived();
        await pause.release;
      }
      writeJson(response, 202, fact);
      return;
    }
    const match = request.method === "GET"
      ? /^\/v1\/mail\/([0-9a-f-]+)$/i.exec(url.pathname)
      : null;
    if (match?.[1]) {
      const operationId = match[1];
      getOperationIds.push(operationId);
      const fact = providerFacts.get(operationId);
      if (!fact) {
        response.writeHead(404);
        response.end();
        return;
      }
      writeJson(response, 200, fact);
      return;
    }
    writeJson(response, 404, { error: "not_found" });
  } catch {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});

await new Promise<void>((resolve, reject) => {
  provider.once("error", reject);
  provider.listen(0, "127.0.0.1", () => resolve());
});
const providerAddress = provider.address() as AddressInfo;
const providerUrl = `http://127.0.0.1:${providerAddress.port}`;

function pauseProvider(operationId: string): Readonly<{
  arrived: Promise<void>;
  release: () => void;
}> {
  let markArrived!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    markArrived = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  providerPauses.set(operationId, { arrived: markArrived, release: released });
  postModes.set(operationId, "pause_terminal");
  return { arrived, release };
}

function runtimeConfig(scenario: ProviderStatus): NotificationRuntimeConfig {
  return {
    workerId,
    providerUrl,
    providerToken,
    providerTimeoutMs: 2_000,
    maxAttempts: 3,
    retryBaseDelaySeconds: 0,
    scenario,
  };
}

type Fixture = Readonly<{
  outboxId: string;
  operationId: string;
  tokenId: string;
  userId: string;
  jobId: string;
}>;

async function createVerificationFixture(label: string): Promise<Fixture> {
  const client = await pool.connect();
  const userId = randomUUID();
  const tokenId = randomUUID();
  const outboxId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const email = `${label}-${userId}@example.invalid`;
  const expiresAt = "2099-01-01T00:00:00.000Z";
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
       VALUES (
         $1, 'notification.email_verification_requested', $2, $3
       )`,
      [outboxId, `verification:${tokenId}`, payload],
    );
    const identity = await client.query<{
      operation_id: string;
      request_fingerprint: string;
    }>(
      `SELECT
         public.opensales_notification_provider_operation_id($1, 1)::text
           AS operation_id,
         public.opensales_notification_request_fingerprint(
           'notification.email_verification_requested',
           'email-verification-v1',
           $2::jsonb
         ) AS request_fingerprint`,
      [outboxId, payload],
    );
    const operationId = identity.rows[0]?.operation_id;
    const requestFingerprint = identity.rows[0]?.request_fingerprint;
    assert.ok(operationId);
    assert.ok(requestFingerprint);
    await client.query(
      `INSERT INTO public.notification_delivery_operations(
         outbox_id, attempt_number, provider_operation_id,
         provider_installation_id, operation_origin,
         event_type, template_revision, payload_snapshot,
         recipient_user_id, recipient_subject_id, recipient_scope_id,
         recipient_kind, category, recipient, locale, request_fingerprint
       ) VALUES (
         $1, 1, $2, 'mock-mail-v1', 'application',
         'notification.email_verification_requested', 'email-verification-v1', $3,
         $4, $4, $4, 'identity_user', 'identity', $5, 'en', $6
       )`,
      [outboxId, operationId, payload, userId, email, requestFingerprint],
    );
    const job = await client.query<{ id: string }>(
      `INSERT INTO public.durable_jobs(job_type, unique_key, payload)
       VALUES ('notification.send', $1, $2)
       RETURNING id`,
      [`outbox:${outboxId}`, { outboxId }],
    );
    const jobId = job.rows[0]?.id;
    assert.ok(jobId);
    await client.query("COMMIT");
    return { outboxId, operationId, tokenId, userId, jobId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createInvitationFixture(
  label: string,
  expiry: string | Readonly<{ afterMilliseconds: number }>,
): Promise<Fixture & { invitationId: string }> {
  const client = await pool.connect();
  const userId = randomUUID();
  const accountId = randomUUID();
  const invitationId = randomUUID();
  const outboxId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const ownerEmail = `${label}-owner-${userId}@example.invalid`;
  const recipient = `${label}-recipient-${invitationId}@example.invalid`;
  const accountName = `Synthetic ${label} Account`;
  const expiresAt = typeof expiry === "string"
    ? expiry
    : (await client.query<{ expires_at: Date }>(
        `SELECT pg_catalog.clock_timestamp()
                  + pg_catalog.make_interval(secs => $1::double precision / 1000.0)
                  AS expires_at`,
        [expiry.afterMilliseconds],
      )).rows[0]!.expires_at.toISOString();
  const payload = {
    accountName,
    role: "viewer",
    permissions: [],
    invitationUrl:
      `http://127.0.0.1:5173/membership-invitations/accept?token=${token}`,
    expiresAt,
    email: recipient,
    locale: "en",
    notificationCategory: "membership_invitation",
    notificationRecipientKind: "invitation",
    notificationRecipientSubjectId: invitationId,
    notificationRecipientScopeId: accountId,
    invitationId,
    accountId,
  };
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.users(id, email, password_hash, email_verified_at)
       VALUES ($1, $2, 'synthetic-not-a-password', pg_catalog.now())`,
      [userId, ownerEmail],
    );
    await client.query(
      `INSERT INTO public.client_accounts(id, name, owner_user_id)
       VALUES ($1, $2, $3)`,
      [accountId, accountName, userId],
    );
    await client.query(
      `INSERT INTO public.client_memberships(
         client_account_id, user_id, role, permissions
       ) VALUES ($1, $2, 'owner', '["*"]'::jsonb)`,
      [accountId, userId],
    );
    await client.query(
      `INSERT INTO public.client_membership_invitations(
         id, client_account_id, email, locale, role, permissions,
         token_digest, expires_at, invited_by_user_id
       ) VALUES (
         $1, $2, $3, 'en', 'viewer', '[]'::jsonb,
         public.digest(pg_catalog.convert_to($4, 'UTF8'), 'sha256'), $5, $6
       )`,
      [invitationId, accountId, recipient, token, expiresAt, userId],
    );
    await client.query(
      `INSERT INTO public.outbox(id, event_type, unique_key, payload)
       VALUES (
         $1, 'notification.membership_invitation_requested', $2, $3
       )`,
      [outboxId, `membership-invitation:${invitationId}`, payload],
    );
    const identity = await client.query<{
      operation_id: string;
      request_fingerprint: string;
    }>(
      `SELECT
         public.opensales_notification_provider_operation_id($1, 1)::text
           AS operation_id,
         public.opensales_notification_request_fingerprint(
           'notification.membership_invitation_requested',
           'membership-invitation-v1',
           $2::jsonb
         ) AS request_fingerprint`,
      [outboxId, payload],
    );
    const operationId = identity.rows[0]?.operation_id;
    const requestFingerprint = identity.rows[0]?.request_fingerprint;
    assert.ok(operationId);
    assert.ok(requestFingerprint);
    await client.query(
      `INSERT INTO public.notification_delivery_operations(
         outbox_id, attempt_number, provider_operation_id,
         provider_installation_id, operation_origin,
         event_type, template_revision, payload_snapshot,
         invitation_id, client_account_id,
         recipient_subject_id, recipient_scope_id,
         recipient_kind, category, recipient, locale, request_fingerprint
       ) VALUES (
         $1, 1, $2, 'mock-mail-v1', 'application',
         'notification.membership_invitation_requested',
         'membership-invitation-v1', $3,
         $4, $5, $4, $5,
         'invitation', 'membership_invitation', $6, 'en', $7
       )`,
      [
        outboxId,
        operationId,
        payload,
        invitationId,
        accountId,
        recipient,
        requestFingerprint,
      ],
    );
    const job = await client.query<{ id: string }>(
      `INSERT INTO public.durable_jobs(job_type, unique_key, payload)
       VALUES ('notification.send', $1, $2)
       RETURNING id`,
      [`outbox:${outboxId}`, { outboxId }],
    );
    const jobId = job.rows[0]?.id;
    assert.ok(jobId);
    await client.query("COMMIT");
    return {
      outboxId,
      operationId,
      tokenId: invitationId,
      invitationId,
      userId,
      jobId,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function claimFixture(
  fixture: Readonly<{ outboxId: string; jobId: string }>,
): Promise<ClaimedNotificationJob> {
  const job = await claimSchema016Job<ClaimedNotificationJob>(pool, workerId);
  assert.ok(job, `expected notification job for ${fixture.outboxId}`);
  assert.equal(job.id, fixture.jobId);
  assert.equal(job.job_type, "notification.send");
  assert.deepEqual(job.payload, { outboxId: fixture.outboxId });
  return job;
}

async function claimNextNotification(): Promise<ClaimedNotificationJob> {
  const job = await claimSchema016Job<ClaimedNotificationJob>(pool, workerId);
  assert.ok(job, "expected a pending notification job");
  assert.equal(job.job_type, "notification.send");
  return job;
}

async function processClaim(
  fixture: Readonly<{ outboxId: string; jobId: string }>,
  scenario: ProviderStatus,
): Promise<void> {
  const job = await claimFixture(fixture);
  await processNotificationDeliveryJob(pool, job, runtimeConfig(scenario));
}

async function operationRows(outboxId: string): Promise<Array<{
  attempt_number: number;
  provider_operation_id: string;
  status: string;
  attempts: number;
  fact_status: string | null;
}>> {
  const result = await pool.query(
    `SELECT operation.attempt_number,
            operation.provider_operation_id::text,
            operation.status, operation.attempts,
            fact.status AS fact_status
     FROM public.notification_delivery_operations operation
     LEFT JOIN public.notification_delivery_facts fact
       ON fact.outbox_id = operation.outbox_id
      AND fact.attempt_number = operation.attempt_number
      AND fact.provider_operation_id = operation.provider_operation_id
     WHERE operation.outbox_id = $1
     ORDER BY operation.attempt_number`,
    [outboxId],
  );
  return result.rows;
}

async function jobState(jobId: string): Promise<{
  status: string;
  attempts: number;
  last_error: string | null;
}> {
  const result = await pool.query(
    `SELECT status, attempts, last_error
     FROM public.durable_jobs
     WHERE id = $1`,
    [jobId],
  );
  const row = result.rows[0];
  assert.ok(row);
  return row;
}

type RenewalNotificationFixture = Readonly<{
  outboxId: string;
  operationId: string;
  jobId: string;
  recipientKind: "account_user" | "contact";
  contactId: string | null;
}>;

type RenewalFixture = Readonly<{
  accountId: string;
  ownerUserId: string;
  owner: RenewalNotificationFixture;
  contacts: readonly RenewalNotificationFixture[];
  invoiceId: string;
  serviceId: string;
  intentId: string;
  kind: "renewal_created" | "pre_due" | "overdue_first";
  totalMinor: bigint;
}>;

let renewalSequence = 0;

function renewalTemplateRevision(
  kind: RenewalFixture["kind"],
): string {
  return `renewal-${kind.replaceAll("_", "-")}-v1`;
}

async function insertRenewalOperation(
  client: pg.PoolClient,
  input: Readonly<{
    outboxId: string;
    payload: Record<string, unknown>;
    templateRevision: string;
    recipientKind: "account_user" | "contact";
    recipientSubjectId: string;
    accountId: string;
    recipient: string;
    contactId?: string;
    ownerUserId?: string;
  }>,
): Promise<RenewalNotificationFixture> {
  const identity = await client.query<{
    operation_id: string;
    request_fingerprint: string;
  }>(
    `SELECT
       public.opensales_notification_provider_operation_id($1, 1)::text
         AS operation_id,
       public.opensales_notification_request_fingerprint(
         'notification.renewal_reminder_requested', $2, $3::jsonb
       ) AS request_fingerprint`,
    [input.outboxId, input.templateRevision, input.payload],
  );
  const operationId = identity.rows[0]?.operation_id;
  const requestFingerprint = identity.rows[0]?.request_fingerprint;
  assert.ok(operationId);
  assert.ok(requestFingerprint);
  await client.query(
    `INSERT INTO public.notification_delivery_operations(
       outbox_id, attempt_number, provider_operation_id,
       provider_installation_id, operation_origin,
       event_type, template_revision, payload_snapshot,
       contact_id, recipient_user_id, client_account_id,
       recipient_subject_id, recipient_scope_id,
       recipient_kind, category, recipient, locale, request_fingerprint
     ) VALUES (
       $1, 1, $2, 'mock-mail-v1', 'application',
       'notification.renewal_reminder_requested', $3, $4,
       $5, $6, $7, $8, $7, $9, 'billing', $10, 'en', $11
     )`,
    [
      input.outboxId,
      operationId,
      input.templateRevision,
      input.payload,
      input.contactId ?? null,
      input.ownerUserId ?? null,
      input.accountId,
      input.recipientSubjectId,
      input.recipientKind,
      input.recipient,
      requestFingerprint,
    ],
  );
  const job = await client.query<{ id: string }>(
    `INSERT INTO public.durable_jobs(job_type, unique_key, payload)
     VALUES ('notification.send', $1, $2)
     RETURNING id`,
    [`outbox:${input.outboxId}`, { outboxId: input.outboxId }],
  );
  const jobId = job.rows[0]?.id;
  assert.ok(jobId);
  return {
    outboxId: input.outboxId,
    operationId,
    jobId,
    recipientKind: input.recipientKind,
    contactId: input.contactId ?? null,
  };
}

async function createRenewalFixture(input: Readonly<{
  label: string;
  kind?: RenewalFixture["kind"];
  contactCount?: number;
  totalMinor?: bigint;
}>): Promise<RenewalFixture> {
  renewalSequence += 1;
  const client = await pool.connect();
  const kind = input.kind ?? "pre_due";
  const totalMinor = input.totalMinor ?? 1_000n;
  const ownerUserId = randomUUID();
  const accountId = randomUUID();
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const serviceId = randomUUID();
  const invoiceId = randomUUID();
  const automationRunId = randomUUID();
  const intentId = randomUUID();
  const ownerOutboxId = randomUUID();
  const ownerEmail = `${input.label}-owner-${ownerUserId}@example.invalid`;
  const dueAt = "2099-02-01T00:00:00.000Z";
  const offsetDays = kind === "pre_due" ? 7 : kind === "overdue_first" ? 1 : 0;
  const templateRevision = renewalTemplateRevision(kind);
  const priceSnapshot = {
    currency: "USD",
    billingCycle: "monthly",
    productId: `synthetic-${input.label}`,
    productName: `Synthetic ${input.label}`,
    fulfillmentMode: "automatic",
    components: [],
    oneTimeSubtotalMinor: "0",
    setupMinor: "0",
    recurringSubtotalMinor: totalMinor.toString(),
    invoiceTotalMinor: totalMinor.toString(),
  };
  const businessDate = new Date(Date.UTC(2090, 0, renewalSequence))
    .toISOString()
    .slice(0, 10);
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.users(id, email, password_hash, email_verified_at)
       VALUES ($1, $2, 'synthetic-not-a-password', pg_catalog.now())`,
      [ownerUserId, ownerEmail],
    );
    await client.query(
      `INSERT INTO public.client_accounts(id, name, owner_user_id)
       VALUES ($1, $2, $3)`,
      [accountId, `Synthetic ${input.label} Account`, ownerUserId],
    );
    await client.query(
      `INSERT INTO public.client_memberships(
         client_account_id, user_id, role, permissions
       ) VALUES ($1, $2, 'owner', '["*"]'::jsonb)`,
      [accountId, ownerUserId],
    );
    await client.query(
      `INSERT INTO public.orders(
         id, client_account_id, submitted_by_user_id, status, currency,
         price_snapshot, one_time_minor, setup_minor, recurring_minor,
         total_minor, idempotency_key, request_fingerprint
       ) VALUES (
         $1, $2, $3, 'completed', 'USD', $4,
         0, 0, $5, $5, $6, $7
       )`,
      [
        orderId,
        accountId,
        ownerUserId,
        priceSnapshot,
        totalMinor.toString(),
        `notification-order:${orderId}`,
        `notification-order-fingerprint:${orderId}`,
      ],
    );
    await client.query(
      `INSERT INTO public.order_items(
         id, order_id, product_id, product_name, fulfillment_mode,
         billing_cycle, configuration, price_snapshot
       ) VALUES (
         $1, $2, $3, $4, 'automatic', 'monthly', '{}'::jsonb, $5
       )`,
      [
        orderItemId,
        orderId,
        `synthetic-${input.label}`,
        `Synthetic ${input.label}`,
        priceSnapshot,
      ],
    );
    await client.query(
      `INSERT INTO public.services(
         id, client_account_id, order_item_id, status, billing_cycle,
         activated_at, term_start, term_end
       ) VALUES (
         $1, $2, $3, 'active', 'monthly',
         '2098-12-01T00:00:00Z', '2098-12-01T00:00:00Z',
         '2099-01-01T00:00:00Z'
       )`,
      [serviceId, accountId, orderItemId],
    );
    await client.query(
      `INSERT INTO public.invoices(
         id, client_account_id, order_id, currency, total_minor, due_at
       ) VALUES ($1, $2, NULL, 'USD', $3, $4)`,
      [invoiceId, accountId, totalMinor.toString(), dueAt],
    );
    await client.query(
      `INSERT INTO public.invoice_lines(invoice_id, kind, description, amount_minor)
       VALUES ($1, 'recurring', $2, $3)`,
      [invoiceId, `Synthetic ${input.label} renewal`, totalMinor.toString()],
    );
    await client.query(
      `INSERT INTO public.billing_automation_runs(
         id, policy_id, business_date, effective_at,
         requested_by_user_id, reason
       ) VALUES (
         $1, 'default', $2, $2::date::timestamptz,
         $3, 'Synthetic notification orchestration integration run'
       )`,
      [automationRunId, businessDate, ownerUserId],
    );
    await client.query(
      `INSERT INTO public.service_renewals(
         service_id, invoice_id, automation_run_id,
         period_start, period_end, recurring_minor, currency, price_snapshot
       ) VALUES (
         $1, $2, $3,
         '2099-01-01T00:00:00Z', '2099-02-01T00:00:00Z',
         $4, 'USD', $5
       )`,
      [serviceId, invoiceId, automationRunId, totalMinor.toString(), priceSnapshot],
    );

    const ownerPayload = {
      email: ownerEmail,
      locale: "en",
      userId: ownerUserId,
      accountId,
      notificationCategory: "billing",
      notificationRecipientKind: "account_user",
      notificationRecipientSubjectId: ownerUserId,
      notificationRecipientScopeId: accountId,
      invoiceId,
      serviceId,
      kind,
      offsetDays,
      currency: "USD",
      dueAt,
      amountDueMinor: totalMinor.toString(),
    };
    await client.query(
      `INSERT INTO public.outbox(id, event_type, unique_key, payload)
       VALUES (
         $1, 'notification.renewal_reminder_requested', $2, $3
       )`,
      [ownerOutboxId, `renewal:${invoiceId}:${kind}`, ownerPayload],
    );
    await client.query(
      `INSERT INTO public.renewal_reminder_intents(
         id, invoice_id, service_id, kind, offset_days, policy_snapshot,
         email, locale, due_at, amount_due_minor, outbox_id
       ) VALUES (
         $1, $2, $3, $4, $5, '{}'::jsonb,
         $6, 'en', $7, $8, $9
       )`,
      [
        intentId,
        invoiceId,
        serviceId,
        kind,
        offsetDays,
        ownerEmail,
        dueAt,
        totalMinor.toString(),
        ownerOutboxId,
      ],
    );
    const relationship = await client.query<{
      invoice_account_id: string;
      service_account_id: string;
      renewal_service_id: string;
      owner_user_id: string;
      invoice_currency: string;
      renewal_currency: string;
      due_at: string;
    }>(
      `SELECT invoice.client_account_id::text AS invoice_account_id,
              service.client_account_id::text AS service_account_id,
              renewal.service_id::text AS renewal_service_id,
              account.owner_user_id::text AS owner_user_id,
              invoice.currency AS invoice_currency,
              renewal.currency AS renewal_currency,
              pg_catalog.to_char(
                invoice.due_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) AS due_at
       FROM public.invoices invoice
       JOIN public.service_renewals renewal ON renewal.invoice_id = invoice.id
       JOIN public.services service ON service.id = renewal.service_id
       JOIN public.client_accounts account ON account.id = invoice.client_account_id
       WHERE invoice.id = $1`,
      [invoiceId],
    );
    assert.deepEqual(relationship.rows, [{
      invoice_account_id: accountId,
      service_account_id: accountId,
      renewal_service_id: serviceId,
      owner_user_id: ownerUserId,
      invoice_currency: "USD",
      renewal_currency: "USD",
      due_at: dueAt,
    }]);
    const validation = await client.query<{
      shape_valid: boolean;
      business_scope_valid: boolean;
      checks: Record<string, boolean>;
    }>(
      `SELECT
         (
           pg_catalog.jsonb_typeof($1::jsonb -> 'invoiceId') = 'string'
           AND $1::jsonb ->> 'invoiceId'
             ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           AND pg_catalog.jsonb_typeof($1::jsonb -> 'serviceId') = 'string'
           AND $1::jsonb ->> 'serviceId'
             ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           AND pg_catalog.jsonb_typeof($1::jsonb -> 'kind') = 'string'
           AND $1::jsonb ->> 'kind' IN ('renewal_created', 'pre_due', 'overdue_first')
           AND pg_catalog.jsonb_typeof($1::jsonb -> 'offsetDays') = 'number'
           AND public.opensales_canonical_notification_jsonb($1::jsonb -> 'offsetDays')
             ~ '^[0-9]+$'
           AND public.opensales_canonical_notification_jsonb(
             $1::jsonb -> 'offsetDays'
           )::integer BETWEEN 0 AND 90
           AND pg_catalog.jsonb_typeof($1::jsonb -> 'currency') = 'string'
           AND $1::jsonb ->> 'currency' ~ '^[A-Z]{3}$'
           AND pg_catalog.jsonb_typeof($1::jsonb -> 'dueAt') = 'string'
           AND pg_catalog.jsonb_typeof($1::jsonb -> 'amountDueMinor') = 'string'
           AND $1::jsonb ->> 'amountDueMinor' ~ '^[0-9]+$'
           AND $2 = 'renewal-' || pg_catalog.replace(
             $1::jsonb ->> 'kind', '_', '-'
           ) || '-v1'
         ) AS shape_valid,
         pg_catalog.jsonb_build_object(
           'invoiceId', pg_catalog.jsonb_typeof($1::jsonb -> 'invoiceId') = 'string'
             AND $1::jsonb ->> 'invoiceId'
               ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
           'serviceId', pg_catalog.jsonb_typeof($1::jsonb -> 'serviceId') = 'string'
             AND $1::jsonb ->> 'serviceId'
               ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
           'kind', pg_catalog.jsonb_typeof($1::jsonb -> 'kind') = 'string'
             AND $1::jsonb ->> 'kind' IN ('renewal_created', 'pre_due', 'overdue_first'),
           'offsetType', pg_catalog.jsonb_typeof($1::jsonb -> 'offsetDays') = 'number',
           'offsetCanonical', public.opensales_canonical_notification_jsonb(
             $1::jsonb -> 'offsetDays'
           ) ~ '^[0-9]+$',
           'offsetRange', public.opensales_canonical_notification_jsonb(
             $1::jsonb -> 'offsetDays'
           )::integer BETWEEN 0 AND 90,
           'currency', pg_catalog.jsonb_typeof($1::jsonb -> 'currency') = 'string'
             AND $1::jsonb ->> 'currency' ~ '^[A-Z]{3}$',
           'dueAt', pg_catalog.jsonb_typeof($1::jsonb -> 'dueAt') = 'string',
           'amountDueMinor',
             pg_catalog.jsonb_typeof($1::jsonb -> 'amountDueMinor') = 'string'
             AND $1::jsonb ->> 'amountDueMinor' ~ '^[0-9]+$',
           'template', $2 = 'renewal-' || pg_catalog.replace(
             $1::jsonb ->> 'kind', '_', '-'
           ) || '-v1'
         ) AS checks,
         EXISTS (
           SELECT 1
           FROM public.invoices invoice
           JOIN public.service_renewals renewal
             ON renewal.invoice_id = invoice.id
            AND renewal.service_id = ($1::jsonb ->> 'serviceId')::uuid
           JOIN public.services service ON service.id = renewal.service_id
           JOIN public.client_accounts account ON account.id = $3
           WHERE invoice.id = ($1::jsonb ->> 'invoiceId')::uuid
             AND invoice.client_account_id = $3
             AND service.client_account_id = $3
             AND renewal.currency = invoice.currency
             AND $1::jsonb ->> 'currency' = invoice.currency
             AND $1::jsonb ->> 'dueAt' = pg_catalog.to_char(
               invoice.due_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             )
             AND $4::uuid = account.owner_user_id
         ) AS business_scope_valid`,
      [ownerPayload, templateRevision, accountId, ownerUserId],
    );
    assert.equal(
      validation.rows[0]?.shape_valid,
      true,
      JSON.stringify({
        checks: validation.rows[0]?.checks,
        templateRevision,
        kind,
        expectedTemplate:
          `renewal-${kind.replaceAll("_", "-")}-v1`,
      }),
    );
    assert.equal(validation.rows[0]?.business_scope_valid, true);
    const owner = await insertRenewalOperation(client, {
      outboxId: ownerOutboxId,
      payload: ownerPayload,
      templateRevision,
      recipientKind: "account_user",
      recipientSubjectId: ownerUserId,
      accountId,
      ownerUserId,
      recipient: ownerEmail,
    });

    const contacts: RenewalNotificationFixture[] = [];
    for (let index = 0; index < (input.contactCount ?? 0); index += 1) {
      const contactId = randomUUID();
      const contactOutboxId = randomUUID();
      const contactEmail = `${input.label}-contact-${index + 1}-${contactId}@example.invalid`;
      await client.query(
        `INSERT INTO public.client_contacts(
           id, client_account_id, display_name, email, locale,
           notification_subscriptions
         ) VALUES ($1, $2, $3, $4, 'en', '["billing"]'::jsonb)`,
        [contactId, accountId, `Synthetic Contact ${index + 1}`, contactEmail],
      );
      const contactPayload = {
        email: contactEmail,
        locale: "en",
        contactId,
        accountId,
        notificationCategory: "billing",
        notificationRecipientKind: "contact",
        notificationRecipientSubjectId: contactId,
        notificationRecipientScopeId: accountId,
        invoiceId,
        serviceId,
        kind,
        offsetDays,
        currency: "USD",
        dueAt,
        amountDueMinor: totalMinor.toString(),
      };
      await client.query(
        `INSERT INTO public.outbox(id, event_type, unique_key, payload)
         VALUES (
           $1, 'notification.renewal_reminder_requested', $2, $3
         )`,
        [
          contactOutboxId,
          `renewal:${invoiceId}:${kind}:contact:${contactId}`,
          contactPayload,
        ],
      );
      contacts.push(await insertRenewalOperation(client, {
        outboxId: contactOutboxId,
        payload: contactPayload,
        templateRevision,
        recipientKind: "contact",
        recipientSubjectId: contactId,
        accountId,
        contactId,
        recipient: contactEmail,
      }));
    }
    await client.query("COMMIT");
    return {
      accountId,
      ownerUserId,
      owner,
      contacts,
      invoiceId,
      serviceId,
      intentId,
      kind,
      totalMinor,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertPaymentAllocation(
  queryable: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">,
  fixture: RenewalFixture,
  amountMinor: bigint,
): Promise<void> {
  const paymentAttemptId = randomUUID();
  await queryable.query(
    `INSERT INTO public.payment_attempts(
       id, client_account_id, invoice_id, provider_installation_id,
       external_payment_id, status, amount_minor, principal_minor, fee_minor,
       currency, scenario, idempotency_key, request_fingerprint,
       provider_occurred_at
     ) VALUES (
       $1, $2, $3, 'mock-payment', $4, 'succeeded', $5, $5, 0,
       'USD', 'success', $6, $7, pg_catalog.now()
     )`,
    [
      paymentAttemptId,
      fixture.accountId,
      fixture.invoiceId,
      `notification-external:${paymentAttemptId}`,
      amountMinor.toString(),
      `notification-payment:${paymentAttemptId}`,
      `notification-payment-fingerprint:${paymentAttemptId}`,
    ],
  );
  await queryable.query(
    `INSERT INTO public.payment_allocations(
       payment_attempt_id, invoice_id, amount_minor
     ) VALUES ($1, $2, $3)`,
    [paymentAttemptId, fixture.invoiceId, amountMinor.toString()],
  );
}

async function insertRenewalDispatchSuppression(
  queryable: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">,
  fixture: RenewalFixture,
  reason: string,
): Promise<void> {
  await queryable.query(
    `INSERT INTO public.renewal_notification_dispatch_suppressions(intent_id, reason)
     VALUES ($1, $2)
     ON CONFLICT (intent_id) DO NOTHING`,
    [fixture.intentId, reason],
  );
}

async function waitForBlockedQuery(fragment: string): Promise<void> {
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ blocked: boolean }>(
      `SELECT pg_catalog.bool_or(
         wait_event_type = 'Lock' AND pg_catalog.strpos(query, $1) > 0
       ) AS blocked
       FROM pg_catalog.pg_stat_activity
       WHERE datname = pg_catalog.current_database()
         AND pid <> pg_catalog.pg_backend_pid()`,
      [fragment],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for blocked PostgreSQL query: ${fragment}`);
}

try {
  const delivered = await createVerificationFixture("delivered");
  await processClaim(delivered, "delivered");
  assert.deepEqual(await operationRows(delivered.outboxId), [
    {
      attempt_number: 1,
      provider_operation_id: delivered.operationId,
      status: "succeeded",
      attempts: 1,
      fact_status: "delivered",
    },
  ]);
  assert.deepEqual(await jobState(delivered.jobId), {
    status: "completed",
    attempts: 1,
    last_error: null,
  });

  const lostResponse = await createVerificationFixture("lost-response");
  postModes.set(lostResponse.operationId, "store_then_drop");
  await processClaim(lostResponse, "delivered");
  assert.equal((await operationRows(lostResponse.outboxId))[0]?.status, "unknown");
  assert.equal((await jobState(lostResponse.jobId)).status, "pending");
  await pool.query(
    `UPDATE public.durable_jobs SET attempts = 99, available_at = pg_catalog.now()
     WHERE id = $1 AND status = 'pending'`,
    [lostResponse.jobId],
  );
  await pool.query(
    `UPDATE public.email_verification_tokens
     SET invalidated_at = pg_catalog.now()
     WHERE id = $1`,
    [lostResponse.tokenId],
  );
  await processClaim(lostResponse, "delivered");
  assert.equal((await operationRows(lostResponse.outboxId))[0]?.status, "succeeded");
  assert.equal((await jobState(lostResponse.jobId)).status, "completed");
  assert.equal(postOperationIds.filter((id) => id === lostResponse.operationId).length, 1);
  assert.equal(getOperationIds.filter((id) => id === lostResponse.operationId).length, 1);

  const staleDispatch = await createVerificationFixture("stale-dispatch");
  const staleProvider = pauseProvider(staleDispatch.operationId);
  const abandonedDispatch = processClaim(staleDispatch, "delivered");
  await staleProvider.arrived;
  assert.equal((await operationRows(staleDispatch.outboxId))[0]?.status, "dispatching");
  await pool.query(
    `UPDATE public.durable_jobs
     SET locked_at = pg_catalog.now() - interval '2 minutes'
     WHERE id = $1 AND status = 'running'`,
    [staleDispatch.jobId],
  );
  const staleCandidate = await pool.query<ClaimedNotificationJob>(
    `SELECT id, job_type, unique_key, payload,
            payload::text AS payload_snapshot, attempts,
            EXTRACT(epoch FROM locked_at)::numeric::text AS locked_at_epoch,
            locked_by
     FROM public.durable_jobs
     WHERE id = $1`,
    [staleDispatch.jobId],
  );
  const recovered = await recoverStaleNotificationDeliveryJob(
    pool,
    staleCandidate.rows[0]!,
    { lockTimeoutSeconds: 60, retryDelaySeconds: 0 },
  );
  assert.equal(recovered, true);
  assert.equal((await operationRows(staleDispatch.outboxId))[0]?.status, "unknown");
  assert.deepEqual(await jobState(staleDispatch.jobId), {
    status: "pending",
    attempts: 0,
    last_error:
      "stale potentially-sent notification will reconcile its stable Provider operation",
  });
  staleProvider.release();
  await assert.rejects(
    abandonedDispatch,
    (error: unknown) => error instanceof NotificationLeaseLostError,
  );
  await processClaim(staleDispatch, "delivered");
  assert.equal((await operationRows(staleDispatch.outboxId))[0]?.status, "succeeded");
  assert.equal((await jobState(staleDispatch.jobId)).status, "completed");
  assert.equal(postOperationIds.filter((id) => id === staleDispatch.operationId).length, 1);
  assert.equal(getOperationIds.filter((id) => id === staleDispatch.operationId).length, 1);

  const notStored = await createVerificationFixture("not-stored");
  postModes.set(notStored.operationId, "retryable_without_store");
  await processClaim(notStored, "delivered");
  assert.equal((await operationRows(notStored.outboxId))[0]?.status, "unknown");
  postModes.set(notStored.operationId, "terminal");
  await processClaim(notStored, "delivered");
  assert.equal((await operationRows(notStored.outboxId))[0]?.status, "succeeded");
  assert.equal(postOperationIds.filter((id) => id === notStored.operationId).length, 2);
  assert.equal(getOperationIds.filter((id) => id === notStored.operationId).length, 1);

  const notStoredThenWithdrawn = await createVerificationFixture(
    "not-stored-then-withdrawn",
  );
  postModes.set(notStoredThenWithdrawn.operationId, "retryable_without_store");
  await processClaim(notStoredThenWithdrawn, "delivered");
  assert.equal(
    (await operationRows(notStoredThenWithdrawn.outboxId))[0]?.status,
    "unknown",
  );
  await pool.query(
    `UPDATE public.email_verification_tokens
     SET invalidated_at = pg_catalog.now()
     WHERE id = $1`,
    [notStoredThenWithdrawn.tokenId],
  );
  postModes.set(notStoredThenWithdrawn.operationId, "terminal");
  await processClaim(notStoredThenWithdrawn, "delivered");
  assert.deepEqual(
    (await operationRows(notStoredThenWithdrawn.outboxId)).map((row) => [
      row.status,
      row.fact_status,
    ]),
    [["skipped", "skipped"]],
  );
  assert.equal(
    postOperationIds.filter((id) => id === notStoredThenWithdrawn.operationId).length,
    1,
  );
  assert.equal(
    getOperationIds.filter((id) => id === notStoredThenWithdrawn.operationId).length,
    1,
  );

  const retried = await createVerificationFixture("retried");
  await processClaim(retried, "failed");
  assert.equal((await operationRows(retried.outboxId))[0]?.status, "failed");
  await processClaim(retried, "failed");
  const attemptTwo = (await operationRows(retried.outboxId))[1];
  assert.ok(attemptTwo);
  assert.equal(attemptTwo.status, "queued");
  assert.notEqual(attemptTwo.provider_operation_id, retried.operationId);
  await processClaim(retried, "delivered");
  assert.deepEqual(
    (await operationRows(retried.outboxId)).map((row) => [row.status, row.fact_status]),
    [["failed", "failed"], ["succeeded", "delivered"]],
  );
  assert.equal((await jobState(retried.jobId)).status, "completed");

  const withdrawn = await createVerificationFixture("withdrawn");
  await pool.query(
    `UPDATE public.email_verification_tokens
     SET invalidated_at = pg_catalog.now()
     WHERE id = $1`,
    [withdrawn.tokenId],
  );
  await processClaim(withdrawn, "delivered");
  assert.deepEqual(
    (await operationRows(withdrawn.outboxId)).map((row) => [row.status, row.fact_status]),
    [["skipped", "skipped"]],
  );
  assert.equal(postOperationIds.includes(withdrawn.operationId), false);
  assert.equal((await jobState(withdrawn.jobId)).status, "completed");

  const revokedInvitation = await createInvitationFixture(
    "revoked-invitation",
    "2099-01-01T00:00:00.000Z",
  );
  await pool.query(
    `UPDATE public.client_membership_invitations
     SET revoked_at = pg_catalog.now(), updated_at = pg_catalog.now()
     WHERE id = $1`,
    [revokedInvitation.invitationId],
  );
  await processClaim(revokedInvitation, "delivered");
  assert.deepEqual(
    (await operationRows(revokedInvitation.outboxId)).map((row) => [
      row.status,
      row.fact_status,
    ]),
    [["skipped", "skipped"]],
  );
  assert.deepEqual(await jobState(revokedInvitation.jobId), {
    status: "completed",
    attempts: 1,
    last_error: null,
  });
  assert.equal(postOperationIds.includes(revokedInvitation.operationId), false);

  const expiringInvitation = await createInvitationFixture(
    "expired-invitation",
    { afterMilliseconds: 2_000 },
  );
  let invitationExpired = false;
  for (let poll = 0; poll < 200 && !invitationExpired; poll += 1) {
    const expiry = await pool.query<{ expired: boolean }>(
      `SELECT expires_at <= pg_catalog.clock_timestamp() AS expired
       FROM public.client_membership_invitations
       WHERE id = $1`,
      [expiringInvitation.invitationId],
    );
    invitationExpired = expiry.rows[0]?.expired ?? false;
    if (!invitationExpired) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.equal(invitationExpired, true, "Invitation must expire on the PostgreSQL clock");
  await processClaim(expiringInvitation, "delivered");
  assert.deepEqual(
    (await operationRows(expiringInvitation.outboxId)).map((row) => [
      row.status,
      row.fact_status,
    ]),
    [["skipped", "skipped"]],
  );
  assert.deepEqual(await jobState(expiringInvitation.jobId), {
    status: "completed",
    attempts: 1,
    last_error: null,
  });
  assert.equal(postOperationIds.includes(expiringInvitation.operationId), false);

  const mismatched = await createVerificationFixture("mismatched");
  postModes.set(mismatched.operationId, "mismatch");
  await processClaim(mismatched, "delivered");
  assert.equal((await operationRows(mismatched.outboxId))[0]?.status, "manual");
  assert.deepEqual(await jobState(mismatched.jobId), {
    status: "manual",
    attempts: 1,
    last_error: "MOCK_MAIL_POST_OPERATION_MISMATCH",
  });

  const exhausted = await createVerificationFixture("exhausted");
  await processClaim(exhausted, "failed");
  await processClaim(exhausted, "failed");
  await processClaim(exhausted, "failed");
  await processClaim(exhausted, "failed");
  await processClaim(exhausted, "failed");
  await processClaim(exhausted, "failed");
  assert.deepEqual(
    (await operationRows(exhausted.outboxId)).map((row) => [
      row.attempt_number,
      row.status,
      row.fact_status,
    ]),
    [
      [1, "failed", "failed"],
      [2, "failed", "failed"],
      [3, "failed", "failed"],
    ],
  );
  assert.deepEqual(await jobState(exhausted.jobId), {
    status: "manual",
    attempts: 1,
    last_error: "NOTIFICATION_ATTEMPT_BUDGET_EXHAUSTED",
  });

  const fanout = await createRenewalFixture({
    label: "fanout",
    contactCount: 2,
  });
  const fanoutScenarios = new Map<string, ProviderStatus>([
    [fanout.owner.outboxId, "delivered"],
    [fanout.contacts[0]!.outboxId, "failed"],
    [fanout.contacts[1]!.outboxId, "bounced"],
  ]);
  for (let index = 0; index < 3; index += 1) {
    const job = await claimNextNotification();
    const outboxId = job.payload.outboxId;
    assert.ok(outboxId);
    const scenario = fanoutScenarios.get(outboxId);
    assert.ok(scenario, `unexpected renewal fanout outbox ${outboxId}`);
    fanoutScenarios.delete(outboxId);
    await processNotificationDeliveryJob(pool, job, runtimeConfig(scenario));
  }
  assert.equal(fanoutScenarios.size, 0);
  const retriedContact = fanout.contacts[0]!;
  await processClaim(retriedContact, "delivered");
  const retriedContactAttemptTwo = (await operationRows(retriedContact.outboxId))[1];
  assert.ok(retriedContactAttemptTwo);
  assert.equal(retriedContactAttemptTwo.status, "queued");
  assert.notEqual(retriedContactAttemptTwo.provider_operation_id, retriedContact.operationId);
  await processClaim(retriedContact, "delivered");
  assert.equal((await jobState(retriedContact.jobId)).status, "completed");
  const ownerProjection = await pool.query<{
    generic_status: string;
    specialized_status: string;
    generic_operation_id: string;
    specialized_operation_id: string;
    generic_recorded_at: Date;
    specialized_recorded_at: Date;
  }>(
    `SELECT generic.status AS generic_status,
            specialized.status AS specialized_status,
            generic.provider_operation_id::text AS generic_operation_id,
            specialized.provider_operation_id::text AS specialized_operation_id,
            generic.recorded_at AS generic_recorded_at,
            specialized.recorded_at AS specialized_recorded_at
     FROM public.notification_delivery_facts generic
     JOIN public.renewal_reminder_delivery_facts specialized
       ON specialized.intent_id = $2
      AND specialized.attempt_number = generic.attempt_number
      AND specialized.provider_operation_id = generic.provider_operation_id
     WHERE generic.outbox_id = $1`,
    [fanout.owner.outboxId, fanout.intentId],
  );
  assert.deepEqual(ownerProjection.rows.map((row) => ({
    genericStatus: row.generic_status,
    specializedStatus: row.specialized_status,
    genericOperationId: row.generic_operation_id,
    specializedOperationId: row.specialized_operation_id,
    sameRecordedAt:
      row.generic_recorded_at.toISOString() === row.specialized_recorded_at.toISOString(),
  })), [{
    genericStatus: "delivered",
    specializedStatus: "delivered",
    genericOperationId: fanout.owner.operationId,
    specializedOperationId: fanout.owner.operationId,
    sameRecordedAt: true,
  }]);
  const contactFacts = await pool.query<{ status: string }>(
    `SELECT fact.status
     FROM public.notification_delivery_facts fact
     WHERE fact.outbox_id = ANY($1::uuid[])
     ORDER BY fact.status`,
    [fanout.contacts.map((contact) => contact.outboxId)],
  );
  assert.deepEqual(
    contactFacts.rows.map((row) => row.status),
    ["bounced", "delivered", "failed"],
  );
  const contactIdentity = await pool.query<{
    outbox_key_count: string;
    operation_id_count: string;
    operation_count: string;
  }>(
    `SELECT
       pg_catalog.count(DISTINCT event.unique_key)::text AS outbox_key_count,
       pg_catalog.count(DISTINCT operation.provider_operation_id)::text
         AS operation_id_count,
       pg_catalog.count(*)::text AS operation_count
     FROM public.notification_delivery_operations operation
     JOIN public.outbox event ON event.id = operation.outbox_id
     WHERE operation.outbox_id = ANY($1::uuid[])`,
    [fanout.contacts.map((contact) => contact.outboxId)],
  );
  assert.deepEqual(contactIdentity.rows, [{
    outbox_key_count: "2",
    operation_id_count: "3",
    operation_count: "3",
  }]);
  assert.equal(
    (await pool.query(
      `SELECT 1
       FROM public.renewal_reminder_delivery_facts specialized
       WHERE specialized.provider_operation_id = ANY($1::uuid[])`,
      [[
        ...fanout.contacts.map((contact) => contact.operationId),
        retriedContactAttemptTwo.provider_operation_id,
      ]],
    )).rowCount,
    0,
  );

  const ownerDeliveredBeforeCancellation = await createRenewalFixture({
    label: "owner-delivered-before-cancellation",
    contactCount: 1,
  });
  await processClaim(ownerDeliveredBeforeCancellation.owner, "delivered");
  await insertRenewalDispatchSuppression(
    pool,
    ownerDeliveredBeforeCancellation,
    "cycle-end cancellation committed after owner delivery",
  );
  const pendingContact = ownerDeliveredBeforeCancellation.contacts[0]!;
  await processClaim(pendingContact, "delivered");
  assert.deepEqual(
    (await operationRows(pendingContact.outboxId)).map((row) => [
      row.status,
      row.fact_status,
    ]),
    [["skipped", "skipped"]],
  );
  assert.equal(postOperationIds.includes(pendingContact.operationId), false);

  const partialPayment = await createRenewalFixture({ label: "partial-payment" });
  const allocationClient = await pool.connect();
  try {
    await allocationClient.query("BEGIN");
    await allocationClient.query(
      `SELECT id FROM public.invoices WHERE id = $1 FOR UPDATE`,
      [partialPayment.invoiceId],
    );
    const processing = processClaim(partialPayment.owner, "delivered");
    await waitForBlockedQuery("FROM public.invoices invoice");
    await insertPaymentAllocation(allocationClient, partialPayment, 250n);
    await allocationClient.query("COMMIT");
    await processing;
  } catch (error) {
    await allocationClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    allocationClient.release();
  }
  assert.match(String(postBodies.get(partialPayment.owner.operationId)?.body), /USD 7\.50/);

  const fullyPaid = await createRenewalFixture({ label: "fully-paid" });
  await insertPaymentAllocation(pool, fullyPaid, fullyPaid.totalMinor);
  await processClaim(fullyPaid.owner, "delivered");
  assert.deepEqual(
    (await operationRows(fullyPaid.owner.outboxId)).map((row) => [row.status, row.fact_status]),
    [["skipped", "skipped"]],
  );
  assert.equal(postOperationIds.includes(fullyPaid.owner.operationId), false);
  assert.equal(
    (await pool.query(
      `SELECT 1 FROM public.renewal_reminder_suppressions WHERE intent_id = $1`,
      [fullyPaid.intentId],
    )).rowCount,
    1,
  );
  assert.equal(
    (await pool.query(
      `SELECT 1
       FROM public.renewal_notification_dispatch_suppressions
       WHERE intent_id = $1`,
      [fullyPaid.intentId],
    )).rowCount,
    1,
  );

  const renewalCreated = await createRenewalFixture({
    label: "renewal-created-paid",
    kind: "renewal_created",
  });
  await insertPaymentAllocation(pool, renewalCreated, renewalCreated.totalMinor);
  await processClaim(renewalCreated.owner, "delivered");
  assert.equal((await operationRows(renewalCreated.owner.outboxId))[0]?.status, "succeeded");
  assert.match(
    String(postBodies.get(renewalCreated.owner.operationId)?.body),
    /USD 0\.00/,
  );

  const suppressionFirst = await createRenewalFixture({ label: "suppression-first" });
  const suppressionClient = await pool.connect();
  try {
    await suppressionClient.query("BEGIN");
    await insertRenewalDispatchSuppression(
      suppressionClient,
      suppressionFirst,
      "Synthetic cancellation committed before dispatch",
    );
    const processing = processClaim(suppressionFirst.owner, "delivered");
    await waitForBlockedQuery("FROM public.renewal_reminder_intents reminder");
    await suppressionClient.query("COMMIT");
    await processing;
  } catch (error) {
    await suppressionClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    suppressionClient.release();
  }
  assert.equal((await operationRows(suppressionFirst.owner.outboxId))[0]?.status, "skipped");
  assert.equal(postOperationIds.includes(suppressionFirst.owner.operationId), false);

  const dispatchFirst = await createRenewalFixture({ label: "dispatch-first" });
  const pausedDispatch = pauseProvider(dispatchFirst.owner.operationId);
  const dispatching = processClaim(dispatchFirst.owner, "delivered");
  await pausedDispatch.arrived;
  await insertRenewalDispatchSuppression(
    pool,
    dispatchFirst,
    "Synthetic cancellation committed after dispatch authorization",
  );
  pausedDispatch.release();
  await dispatching;
  assert.deepEqual(
    (await operationRows(dispatchFirst.owner.outboxId)).map((row) => [
      row.status,
      row.fact_status,
    ]),
    [["succeeded", "delivered"]],
  );

  const failedThenSuppressed = await createRenewalFixture({
    label: "failed-then-suppressed",
  });
  await processClaim(failedThenSuppressed.owner, "failed");
  await insertRenewalDispatchSuppression(
    pool,
    failedThenSuppressed,
    "Synthetic cancellation before a new Provider attempt",
  );
  await processClaim(failedThenSuppressed.owner, "delivered");
  const failedThenSuppressedRows = await operationRows(
    failedThenSuppressed.owner.outboxId,
  );
  assert.deepEqual(
    failedThenSuppressedRows.map((row) => [
      row.status,
      row.fact_status,
    ]),
    [["failed", "failed"], ["skipped", "skipped"]],
  );
  const failedThenSuppressedOperationIds = new Set(
    failedThenSuppressedRows.map((row) => row.provider_operation_id),
  );
  assert.equal(
    postOperationIds.filter((id) => failedThenSuppressedOperationIds.has(id)).length,
    1,
  );

  const unknownThenSuppressed = await createRenewalFixture({
    label: "unknown-then-suppressed",
  });
  postModes.set(unknownThenSuppressed.owner.operationId, "retryable_without_store");
  await processClaim(unknownThenSuppressed.owner, "delivered");
  assert.equal(
    (await operationRows(unknownThenSuppressed.owner.outboxId))[0]?.status,
    "unknown",
  );
  await insertRenewalDispatchSuppression(
    pool,
    unknownThenSuppressed,
    "business suppression committed before the GET 404 retry decision",
  );
  postModes.set(unknownThenSuppressed.owner.operationId, "terminal");
  await processClaim(unknownThenSuppressed.owner, "delivered");
  assert.deepEqual(
    (await operationRows(unknownThenSuppressed.owner.outboxId)).map((row) => [
      row.status,
      row.fact_status,
    ]),
    [["skipped", "skipped"]],
  );
  assert.equal(
    postOperationIds.filter((id) => id === unknownThenSuppressed.owner.operationId).length,
    1,
  );
  assert.equal(
    getOperationIds.filter((id) => id === unknownThenSuppressed.owner.operationId).length,
    1,
  );

  const removalFirst = await createRenewalFixture({
    label: "contact-removal-first",
    contactCount: 1,
  });
  const removalFirstContact = removalFirst.contacts[0]!;
  await pool.query(
    `UPDATE public.durable_jobs
     SET available_at = pg_catalog.now() + interval '1 day'
     WHERE id = $1`,
    [removalFirstContact.jobId],
  );
  await processClaim(removalFirst.owner, "delivered");
  await pool.query(
    `UPDATE public.durable_jobs SET available_at = pg_catalog.now() WHERE id = $1`,
    [removalFirstContact.jobId],
  );
  const removalClient = await pool.connect();
  try {
    await removalClient.query("BEGIN");
    await removalClient.query(
      `UPDATE public.client_contacts
       SET removed_at = pg_catalog.now(), updated_at = pg_catalog.now()
       WHERE id = $1`,
      [removalFirstContact.contactId],
    );
    await processClaim(removalFirstContact, "delivered");
    assert.equal((await jobState(removalFirstContact.jobId)).status, "pending");
    await removalClient.query("COMMIT");
  } catch (error) {
    await removalClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    removalClient.release();
  }
  await processClaim(removalFirstContact, "delivered");
  assert.equal((await operationRows(removalFirstContact.outboxId))[0]?.status, "skipped");
  assert.equal(postOperationIds.includes(removalFirstContact.operationId), false);

  const contactDispatchFirst = await createRenewalFixture({
    label: "contact-dispatch-first",
    contactCount: 1,
  });
  const dispatchFirstContact = contactDispatchFirst.contacts[0]!;
  await pool.query(
    `UPDATE public.durable_jobs
     SET available_at = pg_catalog.now() + interval '1 day'
     WHERE id = $1`,
    [dispatchFirstContact.jobId],
  );
  await processClaim(contactDispatchFirst.owner, "delivered");
  await pool.query(
    `UPDATE public.durable_jobs SET available_at = pg_catalog.now() WHERE id = $1`,
    [dispatchFirstContact.jobId],
  );
  const pausedContact = pauseProvider(dispatchFirstContact.operationId);
  const contactDispatching = processClaim(dispatchFirstContact, "delivered");
  await pausedContact.arrived;
  await pool.query(
    `UPDATE public.client_contacts
     SET removed_at = pg_catalog.now(), updated_at = pg_catalog.now()
     WHERE id = $1`,
    [dispatchFirstContact.contactId],
  );
  pausedContact.release();
  await contactDispatching;
  assert.equal((await operationRows(dispatchFirstContact.outboxId))[0]?.status, "succeeded");

  console.log(
      "Schema 019 notification delivery PostgreSQL journey passed: " +
      "delivered, response-lost and stale-dispatch GET reconciliation, " +
      "same-operation 404 retry, failed attempt rotation, fresh-consent skip, mismatch manual, " +
      "revoked/expired Invitation suppression, Provider-attempt budget manualization, " +
      "owner/contact fanout, current-due rendering, full-payment and cancellation " +
      "suppression, and consent races.",
  );
} finally {
  await pool.end();
  await new Promise<void>((resolve, reject) => {
    provider.close((error) => (error ? reject(error) : resolve()));
  });
}
