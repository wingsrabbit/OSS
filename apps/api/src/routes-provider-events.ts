// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import {
  addBillingCycle,
  canTransitionPayment,
  type BillingCycle,
  type PaymentStatus,
} from "@opensales/core";
import { providerOperationCapabilityMatches } from "@opensales/core/provider-capability";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "./config.js";
import { transaction, type DatabaseClient, type DatabasePool } from "./database.js";
import { requestFingerprint } from "./idempotency.js";
import { advancePaidInvoice } from "./invoice-settlement.js";
import { assertProviderSignature } from "./provider-signature.js";
import { freezeCompetingRefunds } from "./refund-safety.js";
import {
  handleAddFundsPaymentEvent,
  type AddFundsPaymentEvent,
} from "./add-funds-settlement.js";

const paymentEventSchema = z.object({
  eventId: z.string().min(1).max(160),
  providerOperationId: z.uuid(),
  paymentAttemptId: z.uuid(),
  callbackCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  externalPaymentId: z.string().min(1).max(160),
  status: z.enum(["processing", "succeeded", "failed", "cancelled", "expired"]),
  amountMinor: z.string().regex(/^[1-9]\d*$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  occurredAt: z.iso.datetime(),
});

const provisioningEventSchema = z.object({
  eventId: z.string().min(1).max(160),
  providerOperationId: z.uuid(),
  callbackCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  status: z.enum(["succeeded", "failed"]),
  externalResourceId: z.string().min(1).max(200).optional(),
  readyAt: z.iso.datetime().optional(),
  occurredAt: z.iso.datetime(),
});

const refundEventSchema = z.object({
  eventId: z.string().min(1).max(160),
  providerOperationId: z.uuid(),
  refundId: z.uuid(),
  callbackCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  externalRefundId: z.string().min(1).max(160),
  status: z.enum(["succeeded", "failed"]),
  amountMinor: z.string().regex(/^[1-9]\d*$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  occurredAt: z.iso.datetime(),
});

const MOCK_PAYMENT_INSTALLATION_ID = "mock-payment-v1";
const MOCK_PROVISIONING_INSTALLATION_ID = "mock-provisioning-v1";

async function insertInbox(
  client: DatabaseClient,
  providerInstallationId: string,
  eventId: string,
  eventType: string,
  payload: unknown,
): Promise<"inserted" | "duplicate" | "conflict"> {
  const storedPayload =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>), callbackCapability: "[REDACTED]" }
      : payload;
  const result = await client.query(
    `INSERT INTO provider_inbox(
       provider_installation_id, external_event_id, event_type, payload
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider_installation_id, external_event_id) DO NOTHING
     RETURNING id`,
    [providerInstallationId, eventId, eventType, storedPayload],
  );
  if (result.rowCount === 1) return "inserted";
  const existing = await client.query<{ exact_match: boolean }>(
    `SELECT (event_type = $3 AND payload = $4::jsonb) AS exact_match
     FROM provider_inbox
     WHERE provider_installation_id = $1 AND external_event_id = $2
     FOR UPDATE`,
    [providerInstallationId, eventId, eventType, JSON.stringify(storedPayload)],
  );
  return existing.rows[0]?.exact_match ? "duplicate" : "conflict";
}

async function insertRefundInbox(
  client: DatabaseClient,
  providerInstallationId: string,
  eventId: string,
  payload: Record<string, unknown>,
): Promise<"inserted" | "duplicate" | "conflict"> {
  const storedPayload = { ...payload, callbackCapability: "[REDACTED]" };
  const result = await client.query(
    `INSERT INTO provider_inbox(
       provider_installation_id, external_event_id, event_type, payload
     ) VALUES ($1, $2, 'refund.status', $3)
     ON CONFLICT (provider_installation_id, external_event_id) DO NOTHING
     RETURNING id`,
    [providerInstallationId, eventId, storedPayload],
  );
  if (result.rowCount === 1) return "inserted";
  const existing = await client.query<{ exact_match: boolean }>(
    `SELECT (event_type = 'refund.status' AND payload = $3::jsonb) AS exact_match
     FROM provider_inbox
     WHERE provider_installation_id = $1 AND external_event_id = $2
     FOR UPDATE`,
    [providerInstallationId, eventId, JSON.stringify(storedPayload)],
  );
  return existing.rows[0]?.exact_match ? "duplicate" : "conflict";
}

async function recordRefundProviderFact(
  client: DatabaseClient,
  input: {
    refundId: string;
    eventId: string;
    externalRefundId: string;
    status: "succeeded" | "failed";
    amountMinor: string;
    currency: string;
    occurredAt: Date;
  },
): Promise<string> {
  const factFingerprint = requestFingerprint("provider.refund-fact:v1", {
    refundId: input.refundId,
    externalRefundId: input.externalRefundId,
    status: input.status,
    amountMinor: input.amountMinor,
    currency: input.currency,
    occurredAt: input.occurredAt.toISOString(),
  });
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO refund_provider_facts(
       refund_id, provider_installation_id, external_event_id, external_refund_id,
       status, amount_minor, currency, occurred_at, fact_fingerprint
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (provider_installation_id, fact_fingerprint)
       DO NOTHING
     RETURNING id`,
    [
      input.refundId,
      MOCK_PAYMENT_INSTALLATION_ID,
      input.eventId,
      input.externalRefundId,
      input.status,
      input.amountMinor,
      input.currency,
      input.occurredAt,
      factFingerprint,
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = await client.query<{ id: string }>(
    `SELECT id
     FROM refund_provider_facts
     WHERE provider_installation_id = $1
       AND fact_fingerprint = $2`,
    [MOCK_PAYMENT_INSTALLATION_ID, factFingerprint],
  );
  const factId = existing.rows[0]?.id;
  if (!factId) throw new Error("Refund Provider fact could not be recorded");
  return factId;
}

async function postRefundDiscrepancy(
  client: DatabaseClient,
  input: {
    providerFactId: string;
    refundId: string;
    externalRefundId: string;
    amountMinor: string;
    currency: string;
    occurredAt: Date;
    reason: string;
  },
): Promise<boolean> {
  const authorized = await client.query<{
    amount_minor: string;
    currency: string;
  }>(
    `SELECT amount_minor::text, currency
     FROM refunds
     WHERE id = $1`,
    [input.refundId],
  );
  const snapshot = authorized.rows[0];
  if (
    !snapshot ||
    snapshot.amount_minor !== input.amountMinor ||
    snapshot.currency !== input.currency
  ) {
    return false;
  }
  const alreadySettled = await client.query(
    `SELECT id
     FROM refund_settlements
     WHERE refund_id = $1
        OR (
          provider_installation_id = $2
          AND external_refund_id = $3
        )
     UNION ALL
     SELECT id
     FROM refund_discrepancy_settlements
     WHERE refund_id = $1
        OR (
          provider_installation_id = $2
          AND external_refund_id = $3
        )`,
    [input.refundId, MOCK_PAYMENT_INSTALLATION_ID, input.externalRefundId],
  );
  if (alreadySettled.rowCount !== 0) return false;

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO refund_discrepancy_settlements(
       refund_provider_fact_id, refund_id, provider_installation_id,
       external_refund_id, amount_minor, currency, reason, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      input.providerFactId,
      input.refundId,
      MOCK_PAYMENT_INSTALLATION_ID,
      input.externalRefundId,
      input.amountMinor,
      input.currency,
      input.reason,
      input.occurredAt,
    ],
  );
  const discrepancyId = inserted.rows[0]?.id;
  if (!discrepancyId) return false;

  const journal = await client.query<{ id: string }>(
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES (
       'refund_provider_discrepancy',
       $1,
       $2,
       'Provider-reported refund requires manual allocation'
     )
     RETURNING id`,
    [discrepancyId, input.currency],
  );
  const journalId = journal.rows[0]?.id;
  if (!journalId) throw new Error("Unable to create refund discrepancy journal");
  await client.query(
    `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
     VALUES
       ($1, 'refund_discrepancy_suspense', $2, 0),
       ($1, 'mock_cash', 0, $2)`,
    [journalId, input.amountMinor],
  );
  return true;
}

async function holdRefundReceipt(
  client: DatabaseClient,
  input: {
    receiptId: string;
    refundId: string;
    providerFactId: string;
    reason: string;
  },
): Promise<boolean> {
  const inserted = await client.query(
    `INSERT INTO refund_receipt_security_holds(
       source_fund_receipt_id, refund_id, refund_provider_fact_id, reason
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (refund_provider_fact_id) DO NOTHING
     RETURNING id`,
    [input.receiptId, input.refundId, input.providerFactId, input.reason],
  );
  return inserted.rowCount === 1;
}

async function auditProvider(
  client: DatabaseClient,
  providerInstallationId: string,
  action: string,
  targetType: string,
  targetId: string,
  reason: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events(
       actor_type, actor_id, action, target_type, target_id, reason, metadata
     ) VALUES ('provider', $1, $2, $3, $4, $5, $6)`,
    [providerInstallationId, action, targetType, targetId, reason, metadata],
  );
}

function isAfter(previous: Date | null, next: Date): boolean {
  return !previous || next.getTime() > previous.getTime();
}

async function recordReceipt(
  client: DatabaseClient,
  input: {
    providerInstallationId: string;
    attemptId: string;
    clientAccountId: string;
    externalPaymentId: string;
    amountMinor: string;
    currency: string;
    occurredAt: Date;
  },
): Promise<{ id: string; created: boolean; conflict: boolean }> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO fund_receipts(
       provider_installation_id, external_payment_id, reported_payment_attempt_id,
       client_account_id, amount_minor, currency, occurred_at, disposition
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'received')
     ON CONFLICT (provider_installation_id, external_payment_id) DO NOTHING
     RETURNING id`,
    [
      input.providerInstallationId,
      input.externalPaymentId,
      input.attemptId,
      input.clientAccountId,
      input.amountMinor,
      input.currency,
      input.occurredAt,
    ],
  );
  const created = inserted.rows[0];
  if (created) return { id: created.id, created: true, conflict: false };

  const existing = await client.query<{
    id: string;
    reported_payment_attempt_id: string;
    client_account_id: string;
    amount_minor: string;
    currency: string;
  }>(
    `SELECT id, reported_payment_attempt_id, client_account_id, amount_minor, currency
     FROM fund_receipts
     WHERE provider_installation_id = $1
       AND external_payment_id = $2
     FOR UPDATE`,
    [input.providerInstallationId, input.externalPaymentId],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("Fund receipt conflict could not be resolved");
  const conflict =
    row.reported_payment_attempt_id !== input.attemptId ||
    row.client_account_id !== input.clientAccountId ||
    row.amount_minor !== input.amountMinor ||
    row.currency !== input.currency;
  return { id: row.id, created: false, conflict };
}

async function postReceiptJournal(
  client: DatabaseClient,
  receiptId: string,
  currency: string,
  receivedMinor: bigint,
  allocatedMinor: bigint,
): Promise<void> {
  const journal = await client.query<{ id: string }>(
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES ('fund_receipt', $1, $2, 'External funds received')
     RETURNING id`,
    [receiptId, currency],
  );
  const journalId = journal.rows[0]?.id;
  if (!journalId) throw new Error("Unable to create receipt journal");
  const unclaimedMinor = receivedMinor - allocatedMinor;
  await client.query(
    `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
     VALUES ($1, 'mock_cash', $2, 0)`,
    [journalId, receivedMinor.toString()],
  );
  if (allocatedMinor > 0n) {
    await client.query(
      `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
       VALUES ($1, 'accounts_receivable', 0, $2)`,
      [journalId, allocatedMinor.toString()],
    );
  }
  if (unclaimedMinor > 0n) {
    await client.query(
      `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
       VALUES ($1, 'unclaimed_funds_liability', 0, $2)`,
      [journalId, unclaimedMinor.toString()],
    );
  }
}

async function reverseInvoiceCreditApplication(
  client: DatabaseClient,
  paymentAttemptId: string,
  reason: string,
): Promise<string> {
  const commandResult = await client.query<{ id: string; invoice_id: string }>(
    `SELECT id, invoice_id
     FROM invoice_payment_commands
     WHERE payment_attempt_id = $1
     FOR UPDATE`,
    [paymentAttemptId],
  );
  const command = commandResult.rows[0];
  if (!command) return "0";
  const originalResult = await client.query<{
    credit_account_id: string;
    debit_minor: string;
    currency: string;
  }>(
    `SELECT ct.credit_account_id, ct.debit_minor::text, ca.currency
     FROM credit_transactions ct
     JOIN credit_accounts ca ON ca.id = ct.credit_account_id
     WHERE ct.kind = 'invoice_application'
       AND ct.source_type = 'invoice_payment_command'
       AND ct.source_id = $1`,
    [command.id],
  );
  const original = originalResult.rows[0];
  if (!original || BigInt(original.debit_minor) === 0n) return "0";
  const priorReversal = await client.query(
    `SELECT id
     FROM credit_transactions
     WHERE kind = 'invoice_application_reversal'
       AND source_type = 'invoice_payment_command_reversal'
       AND source_id = $1`,
    [command.id],
  );
  if (priorReversal.rowCount) return original.debit_minor;

  await client.query("SELECT id FROM credit_accounts WHERE id = $1 FOR UPDATE", [
    original.credit_account_id,
  ]);
  const reversalId = randomUUID();
  await client.query(
    `INSERT INTO credit_transactions(
       id, credit_account_id, kind, credit_minor, debit_minor,
       source_type, source_id, actor_type, actor_id, reason,
       idempotency_key, request_fingerprint
     ) VALUES (
       $1, $2, 'invoice_application_reversal', $3, 0,
       'invoice_payment_command_reversal', $4, 'system', NULL, $5, $6, $7
     )`,
    [
      reversalId,
      original.credit_account_id,
      original.debit_minor,
      command.id,
      reason,
      `invoice-credit-reversal:${command.id}`,
      `invoice-credit-reversal:v1:${paymentAttemptId}`,
    ],
  );
  await client.query(
    `INSERT INTO credit_allocations(credit_transaction_id, invoice_id, amount_minor)
     VALUES ($1, $2, $3)`,
    [reversalId, command.invoice_id, `-${original.debit_minor}`],
  );
  const journal = await client.query<{ id: string }>(
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES ('invoice_credit_application_reversal', $1, $2, 'Credit restored after payment failure')
     RETURNING id`,
    [reversalId, original.currency],
  );
  const journalId = journal.rows[0]?.id;
  if (!journalId) throw new Error("Unable to create Credit reversal journal");
  await client.query(
    `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
     VALUES
       ($1, 'accounts_receivable', $2, 0),
       ($1, 'client_credit_liability', 0, $2)`,
    [journalId, original.debit_minor],
  );
  return original.debit_minor;
}

export async function registerProviderEventRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.post("/api/v1/provider-events/payment", async (request, reply) => {
    const body = paymentEventSchema.parse(request.body);
    assertProviderSignature(request, config.MOCK_PAYMENT_WEBHOOK_SECRET, body);

    const outcome = await transaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `provider-operation:${body.providerOperationId}`,
      ]);
      const occurredAt = new Date(body.occurredAt);
      const attemptPointer = await client.query<{ invoice_id: string }>(
        `SELECT invoice_id
         FROM payment_attempts
         WHERE id = $1 AND provider_installation_id = $2`,
        [body.paymentAttemptId, MOCK_PAYMENT_INSTALLATION_ID],
      );
      const invoiceId = attemptPointer.rows[0]?.invoice_id;
      if (!invoiceId) {
        const addFundsPointer = await client.query<{ id: string }>(
          `SELECT id
           FROM add_funds_attempts
           WHERE id = $1 AND provider_installation_id = $2`,
          [body.paymentAttemptId, MOCK_PAYMENT_INSTALLATION_ID],
        );
        if (addFundsPointer.rows[0]) {
          return handleAddFundsPaymentEvent(
            client,
            config,
            body as AddFundsPaymentEvent,
          );
        }
        await auditProvider(
          client,
          MOCK_PAYMENT_INSTALLATION_ID,
          "payment.event_rejected",
          "payment",
          body.paymentAttemptId,
          "payment attempt is unknown to the authenticated Provider installation",
          { eventId: body.eventId, externalPaymentId: body.externalPaymentId },
        );
        return { rejected: true, reason: "unknown_payment_attempt" };
      }
      await client.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [invoiceId]);
      await client.query(
        `SELECT id
         FROM payment_attempts
         WHERE id = $1 AND provider_installation_id = $2
         FOR UPDATE`,
        [body.paymentAttemptId, MOCK_PAYMENT_INSTALLATION_ID],
      );
      await client.query(
        `SELECT id
         FROM provider_operations
         WHERE id = $1
           AND subject_type = 'payment'
           AND subject_id = $2
           AND kind = 'payment_create'
           AND provider_installation_id = $3
         FOR UPDATE`,
        [
          body.providerOperationId,
          body.paymentAttemptId,
          MOCK_PAYMENT_INSTALLATION_ID,
        ],
      );
      const attemptResult = await client.query<{
        id: string;
        operation_id: string;
        operation_attempt_count: number;
        client_account_id: string;
        invoice_id: string;
        status: PaymentStatus;
        amount_minor: string;
        principal_minor: string | null;
        fee_basis_points: number;
        fee_minor: string;
        payment_method_code: string | null;
        currency: string;
        provider_occurred_at: Date | null;
        command_status: string | null;
        has_prior_receipt: boolean;
      }>(
        `SELECT pa.id, po.id AS operation_id, po.attempt_count AS operation_attempt_count,
                pa.client_account_id, pa.invoice_id,
                pa.status, pa.amount_minor, pa.principal_minor::text,
                pa.fee_basis_points, pa.fee_minor::text,
                pa.payment_method_code, pa.currency, pa.provider_occurred_at,
                (
                  SELECT command.status
                  FROM invoice_payment_commands command
                  WHERE command.payment_attempt_id = pa.id
                ) AS command_status,
                EXISTS (
                  SELECT 1
                  FROM fund_receipts receipt
                  WHERE receipt.reported_payment_attempt_id = pa.id
                ) AS has_prior_receipt
         FROM payment_attempts pa
         JOIN provider_operations po
           ON po.subject_type = 'payment'
          AND po.subject_id = pa.id
          AND po.kind = 'payment_create'
          AND po.id = $3
          AND po.provider_installation_id = $2
         WHERE pa.id = $1
           AND pa.provider_installation_id = $2`,
        [
          body.paymentAttemptId,
          MOCK_PAYMENT_INSTALLATION_ID,
          body.providerOperationId,
        ],
      );
      const attempt = attemptResult.rows[0];
      if (!attempt) {
        await auditProvider(
          client,
          MOCK_PAYMENT_INSTALLATION_ID,
          "payment.event_rejected",
          "payment",
          body.paymentAttemptId,
          "payment Attempt and Operation are not owned by the authenticated Provider installation",
          { eventId: body.eventId, externalPaymentId: body.externalPaymentId },
        );
        return { rejected: true, reason: "provider_ownership_mismatch" };
      }
      if (
        !providerOperationCapabilityMatches(
          body.callbackCapability,
          config.PROVIDER_OPERATION_CAPABILITY_SECRET,
          MOCK_PAYMENT_INSTALLATION_ID,
          attempt.operation_id,
        )
      ) {
        await auditProvider(
          client,
          MOCK_PAYMENT_INSTALLATION_ID,
          "payment.event_rejected",
          "payment",
          attempt.id,
          "payment callback capability is invalid for the Provider operation",
          { eventId: body.eventId, providerOperationId: attempt.operation_id },
        );
        return { rejected: true, reason: "invalid_operation_capability" };
      }
      if (attempt.operation_attempt_count === 0) {
        await auditProvider(
          client,
          MOCK_PAYMENT_INSTALLATION_ID,
          "payment.event_rejected",
          "payment",
          attempt.id,
          "Provider reported a payment fact before Core sent the operation",
          { eventId: body.eventId, providerOperationId: attempt.operation_id },
        );
        return { rejected: true, reason: "provider_operation_not_started" };
      }

      // Acquire the shared business identity rows before inserting any receipt.
      // The fund_receipts.client_account_id foreign key otherwise takes an
      // implicit Key Share lock on Client Account before advancePaidInvoice
      // reaches User, recreating a cross-invoice User/Account lock inversion.
      const identityPointers = await client.query<{
        order_id: string;
        service_id: string;
        submitted_by_user_id: string;
        client_account_id: string;
      }>(
        `SELECT
           o.id AS order_id,
           s.id AS service_id,
           o.submitted_by_user_id,
           o.client_account_id
         FROM invoices i
         JOIN orders o ON o.id = i.order_id
         JOIN order_items oi ON oi.order_id = o.id
         JOIN services s ON s.order_item_id = oi.id
         WHERE i.id = $1`,
        [attempt.invoice_id],
      );
      const identityPointer = identityPointers.rows[0];
      if (
        !identityPointer ||
        identityPointer.client_account_id !== attempt.client_account_id
      ) {
        await auditProvider(
          client,
          MOCK_PAYMENT_INSTALLATION_ID,
          "payment.event_rejected",
          "payment",
          attempt.id,
          "payment Attempt is linked to inconsistent Core ownership records",
          { eventId: body.eventId, providerOperationId: attempt.operation_id },
        );
        return { rejected: true, reason: "core_ownership_mismatch" };
      }
      await client.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [
        identityPointer.order_id,
      ]);
      await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [
        identityPointer.service_id,
      ]);
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
        identityPointer.submitted_by_user_id,
      ]);
      await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
        identityPointer.client_account_id,
      ]);
      await client.query(
        `SELECT client_account_id
         FROM client_memberships
         WHERE client_account_id = $1 AND user_id = $2
         FOR UPDATE`,
        [identityPointer.client_account_id, identityPointer.submitted_by_user_id],
      );
      const inboxOutcome = await insertInbox(
        client,
        MOCK_PAYMENT_INSTALLATION_ID,
        body.eventId,
        "payment.status",
        body,
      );
      if (inboxOutcome === "duplicate") {
        return { duplicate: true };
      }
      if (inboxOutcome === "conflict") {
        await auditProvider(
          client,
          MOCK_PAYMENT_INSTALLATION_ID,
          "payment.event_id_conflict",
          "payment",
          attempt.id,
          "Provider reused a payment event id with a different event type or payload",
          {
            eventId: body.eventId,
            providerOperationId: attempt.operation_id,
            externalPaymentId: body.externalPaymentId,
          },
        );
        return { rejected: true, reason: "event_id_conflict" };
      }

      const externalOwner = await client.query<{ id: string }>(
        `SELECT id
         FROM (
           SELECT id
           FROM payment_attempts
           WHERE provider_installation_id = $1
             AND external_payment_id = $2
             AND id <> $3
           UNION ALL
           SELECT id
           FROM add_funds_attempts
           WHERE provider_installation_id = $1
             AND external_payment_id = $2
         ) owners
         LIMIT 1`,
        [MOCK_PAYMENT_INSTALLATION_ID, body.externalPaymentId, attempt.id],
      );
      if (externalOwner.rows[0]) {
        await auditProvider(
          client,
          MOCK_PAYMENT_INSTALLATION_ID,
          "payment.external_id_conflict",
          "payment",
          attempt.id,
          "external payment id is already bound to another Core attempt",
          { externalPaymentId: body.externalPaymentId, ownerAttemptId: externalOwner.rows[0].id },
        );
        return { rejected: true, reason: "external_payment_conflict" };
      }

      if (body.status !== "succeeded") {
        if (attempt.command_status === "manual" || attempt.has_prior_receipt) {
          return { ignored: true, reason: "funds_receipt_requires_manual_review" };
        }
        if (!isAfter(attempt.provider_occurred_at, occurredAt)) {
          return { ignored: true, reason: "stale_provider_fact" };
        }
        if (!canTransitionPayment(attempt.status, body.status)) {
          return { ignored: true, reason: "stale_or_backward_transition" };
        }
        const creditRestoredMinor =
          body.status === "processing"
            ? "0"
            : await reverseInvoiceCreditApplication(
                client,
                attempt.id,
                `Credit restored because Provider reported payment ${body.status}`,
              );
        await client.query(
          `UPDATE payment_attempts
           SET status = $2, external_payment_id = COALESCE(external_payment_id, $3),
               provider_occurred_at = $4, updated_at = now(), version = version + 1
           WHERE id = $1`,
          [attempt.id, body.status, body.externalPaymentId, occurredAt],
        );
        await client.query(
          `UPDATE provider_operations
           SET status = $2, external_reference = COALESCE(external_reference, $3),
               provider_occurred_at = $4, updated_at = now()
           WHERE id = $1 AND status <> 'succeeded'`,
          [
            attempt.operation_id,
            body.status === "processing" ? "running" : "failed",
            body.externalPaymentId,
            occurredAt,
          ],
        );
        await client.query(
          `UPDATE invoice_payment_commands
           SET status = $2, result = $3, updated_at = now()
           WHERE payment_attempt_id = $1`,
          [
            attempt.id,
            body.status === "processing" ? "processing" : "failed",
            { paymentStatus: body.status, creditRestoredMinor },
          ],
        );
        return { accepted: true, status: body.status };
      }

      const receipt = await recordReceipt(client, {
        providerInstallationId: MOCK_PAYMENT_INSTALLATION_ID,
        attemptId: attempt.id,
        clientAccountId: attempt.client_account_id,
        externalPaymentId: body.externalPaymentId,
        amountMinor: body.amountMinor,
        currency: body.currency,
        occurredAt,
      });
      if (receipt.conflict) {
        await auditProvider(
          client,
          MOCK_PAYMENT_INSTALLATION_ID,
          "payment.receipt_conflict",
          "fund_receipt",
          receipt.id,
          "provider reused an external payment id with conflicting facts",
          { eventId: body.eventId, paymentAttemptId: attempt.id },
        );
        return { rejected: true, reason: "receipt_fact_conflict" };
      }
      if (!receipt.created) {
        return { duplicate: true, reason: "settlement_already_recorded" };
      }

      const terminalBeforeSuccess = ["failed", "cancelled", "expired", "succeeded"].includes(
        attempt.status,
      );
      const snapshotMatches =
        attempt.amount_minor === body.amountMinor && attempt.currency === body.currency;
      if (terminalBeforeSuccess || !snapshotMatches) {
        const reason = terminalBeforeSuccess
          ? `settlement arrived after payment became ${attempt.status}`
          : "provider amount or currency does not match the Core snapshot";
        await client.query(
          `UPDATE fund_receipts
           SET disposition = 'unclaimed', reason = $2, updated_at = now()
           WHERE id = $1`,
          [receipt.id, reason],
        );
        await postReceiptJournal(client, receipt.id, body.currency, BigInt(body.amountMinor), 0n);
        if (!terminalBeforeSuccess) {
          await client.query(
            `UPDATE payment_attempts
             SET status = 'unknown', provider_occurred_at = $2,
                 updated_at = now(), version = version + 1
             WHERE id = $1 AND status NOT IN ('succeeded', 'failed', 'cancelled', 'expired')`,
            [attempt.id, occurredAt],
          );
        }
        await client.query(
          `UPDATE provider_operations
           SET status = 'unknown', last_error = $2, provider_occurred_at = $3, updated_at = now()
           WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
          [attempt.operation_id, reason, occurredAt],
        );
        await client.query(
          `UPDATE invoice_payment_commands
           SET status = 'manual', result = $2, updated_at = now()
           WHERE payment_attempt_id = $1
             AND status NOT IN ('succeeded', 'failed')`,
          [
            attempt.id,
            {
              paymentStatus: "unknown",
              receiptId: receipt.id,
              reason,
            },
          ],
        );
        await auditProvider(
          client,
          MOCK_PAYMENT_INSTALLATION_ID,
          "payment.settlement_unclaimed",
          "fund_receipt",
          receipt.id,
          reason,
          {
            paymentAttemptId: attempt.id,
            expectedAmountMinor: attempt.amount_minor,
            receivedAmountMinor: body.amountMinor,
            expectedCurrency: attempt.currency,
            receivedCurrency: body.currency,
          },
        );
        return { accepted: true, status: "unclaimed", receiptId: receipt.id };
      }

      const invoiceResult = await client.query<{
        total_minor: string;
        order_id: string | null;
      }>(
        `SELECT total_minor, order_id
         FROM invoices
         WHERE id = $1
         FOR UPDATE`,
        [attempt.invoice_id],
      );
      const invoice = invoiceResult.rows[0];
      if (!invoice) throw new Error("Payment is linked to an invalid invoice");
      const feeMinor = BigInt(attempt.fee_minor);
      if (feeMinor > 0n) {
        if (
          !attempt.principal_minor ||
          !attempt.payment_method_code ||
          BigInt(attempt.amount_minor) !== BigInt(attempt.principal_minor) + feeMinor
        ) {
          throw new Error("Payment fee snapshot is inconsistent");
        }
        const feeLine = await client.query<{ id: string }>(
          `INSERT INTO invoice_lines(invoice_id, kind, description, amount_minor)
           VALUES ($1, 'payment_fee', $2, $3)
           RETURNING id`,
          [
            attempt.invoice_id,
            `Payment fee (${attempt.payment_method_code})`,
            feeMinor.toString(),
          ],
        );
        const feeLineId = feeLine.rows[0]?.id;
        if (!feeLineId) throw new Error("Unable to create payment fee line");
        await client.query(
          `INSERT INTO invoice_fee_charges(
             invoice_id, payment_attempt_id, invoice_line_id, payment_method_code,
             basis_minor, basis_points, amount_minor
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            attempt.invoice_id,
            attempt.id,
            feeLineId,
            attempt.payment_method_code,
            attempt.principal_minor,
            attempt.fee_basis_points,
            feeMinor.toString(),
          ],
        );
        await client.query(
          `UPDATE invoices
           SET total_minor = total_minor + $2
           WHERE id = $1`,
          [attempt.invoice_id, feeMinor.toString()],
        );
        const feeJournal = await client.query<{ id: string }>(
          `INSERT INTO ledger_journals(source_type, source_id, currency, description)
           VALUES ('invoice_payment_fee', $1, $2, 'External payment fee charged')
           RETURNING id`,
          [feeLineId, attempt.currency],
        );
        const feeJournalId = feeJournal.rows[0]?.id;
        if (!feeJournalId) throw new Error("Unable to create payment fee journal");
        await client.query(
          `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
           VALUES
             ($1, 'accounts_receivable', $2, 0),
             ($1, 'payment_fee_revenue', 0, $2)`,
          [feeJournalId, feeMinor.toString()],
        );
        invoice.total_minor = (BigInt(invoice.total_minor) + feeMinor).toString();
      }
      const allocationResult = await client.query<{ allocated_minor: string }>(
        `SELECT allocated_minor::text
         FROM invoice_allocation_totals
         WHERE invoice_id = $1`,
        [attempt.invoice_id],
      );
      const allocatedBefore = BigInt(allocationResult.rows[0]?.allocated_minor ?? "0");
      const dueBefore = BigInt(invoice.total_minor) - allocatedBefore;
      const receivedMinor = BigInt(body.amountMinor);
      const allocationMinor = dueBefore > 0n ? (receivedMinor < dueBefore ? receivedMinor : dueBefore) : 0n;
      if (allocationMinor > 0n) {
        await client.query(
          `INSERT INTO payment_allocations(payment_attempt_id, invoice_id, amount_minor)
           VALUES ($1, $2, $3)`,
          [attempt.id, attempt.invoice_id, allocationMinor.toString()],
        );
      }
      const disposition =
        allocationMinor === receivedMinor
          ? "allocated"
          : allocationMinor > 0n
            ? "partially_allocated"
            : "unclaimed";
      const receiptReason =
        allocationMinor === receivedMinor ? null : "funds exceed the currently allocatable invoice balance";
      await client.query(
        `UPDATE fund_receipts
         SET allocated_minor = $2, disposition = $3, reason = $4, updated_at = now()
         WHERE id = $1`,
        [receipt.id, allocationMinor.toString(), disposition, receiptReason],
      );
      await postReceiptJournal(client, receipt.id, body.currency, receivedMinor, allocationMinor);
      await client.query(
        `UPDATE payment_attempts
         SET status = 'succeeded', external_payment_id = $2, provider_occurred_at = $3,
             updated_at = now(), version = version + 1
         WHERE id = $1`,
        [attempt.id, body.externalPaymentId, occurredAt],
      );
      await client.query(
        `UPDATE provider_operations
         SET status = 'succeeded', external_reference = $2, provider_occurred_at = $3,
             last_error = NULL, updated_at = now()
         WHERE id = $1`,
        [attempt.operation_id, body.externalPaymentId, occurredAt],
      );

      const settlement = await advancePaidInvoice(client, attempt.invoice_id);
      await client.query(
        `UPDATE invoice_payment_commands
         SET status = 'succeeded', result = $2, updated_at = now()
         WHERE payment_attempt_id = $1`,
        [
          attempt.id,
          {
            paymentStatus: "succeeded",
            invoiceStatus: settlement.invoiceStatus,
            orderStatus: settlement.orderStatus ?? null,
            feeMinor: attempt.fee_minor,
          },
        ],
      );
      return {
        accepted: true,
        status: "succeeded",
        invoiceStatus: settlement.invoiceStatus,
        orderStatus: settlement.orderStatus,
      };
    });
    return reply.code(outcome.duplicate ? 200 : 202).send(outcome);
  });

  app.post("/api/v1/provider-events/refund", async (request, reply) => {
    const body = refundEventSchema.parse(request.body);
    assertProviderSignature(request, config.MOCK_PAYMENT_WEBHOOK_SECRET, body);
    const outcome = await transaction(pool, async (client) => {
      for (const lock of [
        `refund:${body.refundId}`,
        `refund-external:${body.externalRefundId}`,
      ].sort()) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lock]);
      }
      const pointer = await client.query<{ source_fund_receipt_id: string }>(
        `SELECT source_fund_receipt_id
         FROM refunds
         WHERE id = $1`,
        [body.refundId],
      );
      const receiptId = pointer.rows[0]?.source_fund_receipt_id;
      if (!receiptId) {
        return { rejected: true, reason: "unknown_refund" };
      }
      await client.query("SELECT id FROM fund_receipts WHERE id = $1 FOR UPDATE", [receiptId]);
      const refundResult = await client.query<{
        id: string;
        source_fund_receipt_id: string;
        provider_installation_id: string;
        destination: string;
        amount_minor: string;
        currency: string;
        status: string;
        security_hold: boolean;
        provider_occurred_at: Date | null;
        operation_id: string;
        operation_status: string;
        operation_attempt_count: number;
        operation_created_at: Date;
        settlement_external_refund_id: string | null;
        settlement_amount_minor: string | null;
        settlement_currency: string | null;
        settlement_occurred_at: Date | null;
      }>(
        `SELECT
           refund.id,
           refund.source_fund_receipt_id,
           refund.provider_installation_id,
           refund.destination,
           refund.amount_minor::text,
           refund.currency,
           refund.status,
           refund.security_hold,
           refund.provider_occurred_at,
           operation.id AS operation_id,
           operation.status AS operation_status,
           operation.attempt_count AS operation_attempt_count,
           operation.created_at AS operation_created_at,
           settlement.external_refund_id AS settlement_external_refund_id,
           settlement.amount_minor::text AS settlement_amount_minor,
           settlement.currency AS settlement_currency,
           settlement.occurred_at AS settlement_occurred_at
         FROM refunds refund
         JOIN provider_operations operation
           ON operation.subject_type = 'refund'
          AND operation.subject_id = refund.id
          AND operation.kind = 'refund_create'
          AND operation.id = $2
          AND operation.provider_installation_id = $3
         LEFT JOIN refund_settlements settlement ON settlement.refund_id = refund.id
         WHERE refund.id = $1
           AND refund.provider_installation_id = $3
           AND refund.destination = 'original_payment'
         FOR UPDATE OF refund, operation`,
        [body.refundId, body.providerOperationId, MOCK_PAYMENT_INSTALLATION_ID],
      );
      const refund = refundResult.rows[0];
      if (!refund) {
        return { rejected: true, reason: "provider_ownership_mismatch" };
      }
      if (
        !providerOperationCapabilityMatches(
          body.callbackCapability,
          config.PROVIDER_OPERATION_CAPABILITY_SECRET,
          MOCK_PAYMENT_INSTALLATION_ID,
          refund.operation_id,
        )
      ) {
        await auditProvider(
          client,
          MOCK_PAYMENT_INSTALLATION_ID,
          "refund.event_rejected",
          "refund",
          refund.id,
          "refund callback capability is invalid for the Provider operation",
          { eventId: body.eventId, providerOperationId: refund.operation_id },
        );
        return { rejected: true, reason: "invalid_operation_capability" };
      }
      if (refund.operation_attempt_count === 0) {
        await auditProvider(
          client,
          MOCK_PAYMENT_INSTALLATION_ID,
          "refund.event_rejected",
          "refund",
          refund.id,
          "Provider reported a refund fact before Core sent the operation",
          { eventId: body.eventId, providerOperationId: refund.operation_id },
        );
        return { rejected: true, reason: "provider_operation_not_started" };
      }
      const inboxOutcome = await insertRefundInbox(
        client,
        MOCK_PAYMENT_INSTALLATION_ID,
        body.eventId,
        body,
      );
      if (inboxOutcome === "duplicate") {
        return { duplicate: true };
      }
      const occurredAt = new Date(body.occurredAt);
      const providerFactId = await recordRefundProviderFact(client, {
        refundId: refund.id,
        eventId: body.eventId,
        externalRefundId: body.externalRefundId,
        status: body.status,
        amountMinor: body.amountMinor,
        currency: body.currency,
        occurredAt,
      });
      const adjudicatedFact = await client.query(
        `SELECT adjudication.id
         FROM refund_receipt_security_holds security_hold
         JOIN refund_security_hold_adjudications adjudication
           ON adjudication.receipt_security_hold_id = security_hold.id
         WHERE security_hold.refund_provider_fact_id = $1
         LIMIT 1`,
        [providerFactId],
      );
      if (adjudicatedFact.rowCount !== 0) {
        return { ignored: true, reason: "provider_fact_already_adjudicated" };
      }
      const ignoreTemporallyInvalidFact = async (
        reason: string,
        reasonCode: "stale_provider_fact" | "implausible_provider_occurrence_time",
      ): Promise<Record<string, unknown>> => {
        const metadata = {
          eventId: body.eventId,
          status: body.status,
          providerFactId,
          reportedOccurredAt: body.occurredAt,
          previousProviderOccurredAt: refund.provider_occurred_at?.toISOString() ?? null,
          operationCreatedAt: refund.operation_created_at.toISOString(),
          inboxConflict: inboxOutcome === "conflict",
          statePreserved: true,
          cashPostingCreated: false,
        };
        await client.query(
          `INSERT INTO refund_events(
             refund_id, event_type, actor_type, actor_id, reason, metadata
           ) VALUES ($1, 'provider_fact_ignored', 'provider', $2, $3, $4)`,
          [refund.id, MOCK_PAYMENT_INSTALLATION_ID, reason, metadata],
        );
        await auditProvider(
          client,
          MOCK_PAYMENT_INSTALLATION_ID,
          "refund.temporal_fact_ignored",
          "refund",
          refund.id,
          reason,
          metadata,
        );
        return { ignored: true, reason: reasonCode };
      };
      if (
        occurredAt.getTime() < refund.operation_created_at.getTime() - 60_000 ||
        occurredAt.getTime() > Date.now() + 5 * 60_000
      ) {
        return ignoreTemporallyInvalidFact(
          "Provider supplied an implausible refund occurrence time; Core preserved the current state and high-water mark",
          "implausible_provider_occurrence_time",
        );
      }
      if (!isAfter(refund.provider_occurred_at, occurredAt)) {
        return ignoreTemporallyInvalidFact(
          "Provider fact is stale; Core preserved the current state and high-water mark",
          "stale_provider_fact",
        );
      }
      const placeSecurityHold = async (
        reason: string,
        action: string,
        metadata: Record<string, unknown>,
        preserveReportedOutflow = true,
      ): Promise<Record<string, unknown>> => {
        const discrepancyPosted =
          body.status === "succeeded" && preserveReportedOutflow
            ? await postRefundDiscrepancy(client, {
                providerFactId,
                refundId: refund.id,
                externalRefundId: body.externalRefundId,
                amountMinor: body.amountMinor,
                currency: body.currency,
                occurredAt,
                reason,
              })
            : false;
        await holdRefundReceipt(client, {
          receiptId: refund.source_fund_receipt_id,
          refundId: refund.id,
          providerFactId,
          reason,
        });
        await client.query(
          `UPDATE refunds
           SET status = 'manual',
               security_hold = true,
               provider_occurred_at = $2,
               last_error = $3,
               result = result || $4::jsonb,
               updated_at = now(),
               version = version + 1
           WHERE id = $1`,
          [
            refund.id,
            occurredAt,
            reason,
            JSON.stringify({
              ...metadata,
              providerFactId,
              discrepancyPosted,
              externalRefundId: body.externalRefundId,
            }),
          ],
        );
        await client.query(
          `UPDATE provider_operations
           SET status = 'unknown',
               external_reference = COALESCE(external_reference, $2),
               provider_occurred_at = $3,
               last_error = $4,
               updated_at = now()
           WHERE id = $1 AND status <> 'succeeded'`,
          [refund.operation_id, body.externalRefundId, occurredAt, reason],
        );
        const frozenRefundIds = await freezeCompetingRefunds(client, {
          heldRefundId: refund.id,
          receiptId: refund.source_fund_receipt_id,
          reason: `Competing refund frozen because ${reason}`,
        });
        await client.query(
          `INSERT INTO refund_events(
             refund_id, event_type, actor_type, actor_id, reason, metadata, occurred_at
           ) VALUES ($1, 'manual', 'provider', $2, $3, $4, now())`,
          [
            refund.id,
            MOCK_PAYMENT_INSTALLATION_ID,
            reason,
            {
              ...metadata,
              providerFactId,
              discrepancyPosted,
              externalRefundId: body.externalRefundId,
              frozenRefundIds,
              providerOccurredAt: body.occurredAt,
            },
          ],
        );
        await auditProvider(
          client,
          MOCK_PAYMENT_INSTALLATION_ID,
          action,
          "refund",
          refund.id,
          reason,
          {
            ...metadata,
            providerFactId,
            discrepancyPosted,
            externalRefundId: body.externalRefundId,
            frozenRefundIds,
          },
        );
        return { accepted: true, status: "manual", reason: action, securityHold: true };
      };
      const placeSettledReceiptHold = async (
        reason: string,
        action: string,
        metadata: Record<string, unknown>,
        preserveReportedOutflow = true,
      ): Promise<Record<string, unknown>> => {
        const discrepancyPosted =
          body.status === "succeeded" && preserveReportedOutflow
            ? await postRefundDiscrepancy(client, {
                providerFactId,
                refundId: refund.id,
                externalRefundId: body.externalRefundId,
                amountMinor: body.amountMinor,
                currency: body.currency,
                occurredAt,
                reason,
              })
            : false;
        await holdRefundReceipt(client, {
          receiptId: refund.source_fund_receipt_id,
          refundId: refund.id,
          providerFactId,
          reason,
        });
        const frozenRefundIds = await freezeCompetingRefunds(client, {
          heldRefundId: refund.id,
          receiptId: refund.source_fund_receipt_id,
          reason: `Competing refund frozen because ${reason}`,
        });
        const eventMetadata = {
          ...metadata,
          providerFactId,
          discrepancyPosted,
          externalRefundId: body.externalRefundId,
          frozenRefundIds,
          providerOccurredAt: body.occurredAt,
          receiptSecurityHold: true,
        };
        await client.query(
          `INSERT INTO refund_events(
             refund_id, event_type, actor_type, actor_id, reason, metadata, occurred_at
           ) VALUES ($1, 'provider_fact_ignored', 'provider', $2, $3, $4, now())`,
          [refund.id, MOCK_PAYMENT_INSTALLATION_ID, reason, eventMetadata],
        );
        await auditProvider(
          client,
          MOCK_PAYMENT_INSTALLATION_ID,
          action,
          "refund",
          refund.id,
          reason,
          eventMetadata,
        );
        return {
          accepted: true,
          status: "succeeded",
          reason: action,
          securityHold: true,
        };
      };

      const externalOwner = await client.query<{
        refund_id: string;
        source: "settlement" | "discrepancy";
      }>(
        `SELECT owner.refund_id, owner.source
         FROM (
           SELECT refund_id, 'settlement'::text AS source
           FROM refund_settlements
           WHERE provider_installation_id = $1
             AND external_refund_id = $2
           UNION ALL
           SELECT refund_id, 'discrepancy'::text AS source
           FROM refund_discrepancy_settlements
           WHERE provider_installation_id = $1
             AND external_refund_id = $2
         ) owner
         WHERE owner.refund_id <> $3
         LIMIT 1`,
        [MOCK_PAYMENT_INSTALLATION_ID, body.externalRefundId, refund.id],
      );
      if (externalOwner.rows[0]) {
        const reason = "Provider reused an external refund id already owned by another refund";
        const metadata = {
          eventId: body.eventId,
          ownerRefundId: externalOwner.rows[0].refund_id,
          ownerSource: externalOwner.rows[0].source,
        };
        return refund.status === "succeeded"
          ? placeSettledReceiptHold(
              reason,
              "refund.external_id_conflict",
              metadata,
              false,
            )
          : placeSecurityHold(reason, "refund.external_id_conflict", metadata, false);
      }

      if (inboxOutcome === "conflict") {
        const reason = "Provider reused a refund event id with conflicting facts";
        if (refund.status !== "succeeded") {
          return placeSecurityHold(reason, "refund.event_id_conflict", {
            conflictingEventId: body.eventId,
            reportedStatus: body.status,
          });
        }
        return placeSettledReceiptHold(
          reason,
          "refund.event_id_conflict",
          {
            eventId: body.eventId,
            reportedStatus: body.status,
          },
        );
      }

      if (refund.status === "succeeded") {
        const exactCanonicalSuccess =
          body.status === "succeeded" &&
          refund.settlement_external_refund_id === body.externalRefundId &&
          refund.settlement_amount_minor === body.amountMinor &&
          refund.settlement_currency === body.currency &&
          refund.settlement_occurred_at?.getTime() === occurredAt.getTime();
        const definitelyStaleFailure =
          body.status === "failed" &&
          refund.settlement_external_refund_id === body.externalRefundId &&
          refund.settlement_amount_minor === body.amountMinor &&
          refund.settlement_currency === body.currency &&
          refund.settlement_occurred_at !== null &&
          occurredAt.getTime() <= refund.settlement_occurred_at.getTime();
        if (!exactCanonicalSuccess && !definitelyStaleFailure) {
          return placeSettledReceiptHold(
            "Provider fact conflicts with the canonical settled refund",
            "refund.settled_fact_conflict",
            {
              eventId: body.eventId,
              reportedStatus: body.status,
              canonicalExternalRefundId: refund.settlement_external_refund_id,
              canonicalAmountMinor: refund.settlement_amount_minor,
              canonicalCurrency: refund.settlement_currency,
              canonicalOccurredAt: refund.settlement_occurred_at?.toISOString() ?? null,
              reportedAmountMinor: body.amountMinor,
              reportedCurrency: body.currency,
            },
          );
        }
        await client.query(
          `INSERT INTO refund_events(
             refund_id, event_type, actor_type, actor_id, reason, metadata, occurred_at
           ) VALUES ($1, 'provider_fact_ignored', 'provider', $2, $3, $4, $5)`,
          [
            refund.id,
            MOCK_PAYMENT_INSTALLATION_ID,
            "Refund is already settled; terminal fact cannot move it backward",
            {
              eventId: body.eventId,
              status: body.status,
              providerFactId,
              canonicalDuplicate: exactCanonicalSuccess,
              staleFailure: definitelyStaleFailure,
            },
            occurredAt,
          ],
        );
        return { ignored: true, reason: "already_succeeded" };
      }
      if (refund.security_hold) {
        const discrepancyPosted =
          body.status === "succeeded"
            ? await postRefundDiscrepancy(client, {
                providerFactId,
                refundId: refund.id,
                externalRefundId: body.externalRefundId,
                amountMinor: body.amountMinor,
                currency: body.currency,
                occurredAt,
                reason: "Provider success arrived while the refund was security-held",
              })
            : false;
        const additionalHoldCreated =
          body.status === "succeeded"
            ? await holdRefundReceipt(client, {
                receiptId: refund.source_fund_receipt_id,
                refundId: refund.id,
                providerFactId,
                reason: "Additional Provider success arrived while the refund was security-held",
              })
            : false;
        await client.query(
          `INSERT INTO refund_events(
             refund_id, event_type, actor_type, actor_id, reason, metadata, occurred_at
           ) VALUES ($1, 'provider_fact_ignored', 'provider', $2, $3, $4, now())`,
          [
            refund.id,
            MOCK_PAYMENT_INSTALLATION_ID,
            "Security hold is sticky; Provider facts cannot release it",
            {
              eventId: body.eventId,
              status: body.status,
              providerFactId,
              discrepancyPosted,
              additionalHoldCreated,
              providerOccurredAt: body.occurredAt,
            },
          ],
        );
        return { accepted: true, status: "manual", reason: "security_hold" };
      }
      if (refund.status === "failed" && body.status === "succeeded") {
        return placeSecurityHold(
          "Provider reported success after previously confirming that the refund failed",
          "refund.terminal_fact_conflict",
          { eventId: body.eventId, reportedStatus: body.status },
        );
      }
      const snapshotMatches =
        body.amountMinor === refund.amount_minor && body.currency === refund.currency;
      if (!snapshotMatches) {
        return placeSecurityHold(
          "Provider refund amount or currency conflicts with the immutable Core snapshot",
          "refund.snapshot_conflict",
          {
            eventId: body.eventId,
            expectedAmountMinor: refund.amount_minor,
            reportedAmountMinor: body.amountMinor,
            expectedCurrency: refund.currency,
            reportedCurrency: body.currency,
          },
        );
      }

      if (body.status === "failed") {
        await client.query(
          `UPDATE refunds
           SET status = 'failed', provider_occurred_at = $2,
               last_error = 'Provider confirmed that no refund was settled',
               result = result || $3::jsonb, updated_at = now(), version = version + 1
           WHERE id = $1`,
          [
            refund.id,
            occurredAt,
            JSON.stringify({ externalRefundId: body.externalRefundId }),
          ],
        );
        await client.query(
          `UPDATE provider_operations
           SET status = 'failed', external_reference = COALESCE(external_reference, $2),
               provider_occurred_at = $3,
               last_error = 'Provider confirmed refund failure', updated_at = now()
           WHERE id = $1 AND status <> 'succeeded'`,
          [refund.operation_id, body.externalRefundId, occurredAt],
        );
        await client.query(
          `INSERT INTO refund_events(
             refund_id, event_type, actor_type, actor_id, reason, metadata, occurred_at
           ) VALUES ($1, 'failed', 'provider', $2, $3, $4, $5)`,
          [
            refund.id,
            MOCK_PAYMENT_INSTALLATION_ID,
            "Provider confirmed that no refund was settled",
            { eventId: body.eventId, externalRefundId: body.externalRefundId },
            occurredAt,
          ],
        );
        return { accepted: true, status: "failed" };
      }

      const receiptCapacity = await client.query<{
        receipt_amount_minor: string;
        settled_minor: string;
        active_security_hold: boolean;
      }>(
        `SELECT
           receipt.amount_minor::text AS receipt_amount_minor,
           COALESCE((
             SELECT sum(recorded_outflow.amount_minor)
             FROM (
               SELECT settlement.amount_minor
               FROM refunds settled_refund
               JOIN refund_settlements settlement
                 ON settlement.refund_id = settled_refund.id
               WHERE settled_refund.source_fund_receipt_id = receipt.id
               UNION ALL
               SELECT discrepancy.amount_minor
               FROM refunds unexpected_refund
               JOIN refund_discrepancy_settlements discrepancy
                 ON discrepancy.refund_id = unexpected_refund.id
               JOIN refund_security_hold_adjudications adjudication
                 ON adjudication.discrepancy_settlement_id = discrepancy.id
                AND adjudication.decision = 'record_unexpected_outflow'
               WHERE unexpected_refund.source_fund_receipt_id = receipt.id
                 AND discrepancy.currency = receipt.currency
               UNION ALL
               SELECT corrected_discrepancy.amount_minor
               FROM refunds corrected_refund
               JOIN refund_discrepancy_settlements corrected_discrepancy
                 ON corrected_discrepancy.refund_id = corrected_refund.id
               JOIN refund_adjudication_corrections correction
                 ON correction.discrepancy_settlement_id = corrected_discrepancy.id
               WHERE corrected_refund.source_fund_receipt_id = receipt.id
                 AND corrected_discrepancy.currency = receipt.currency
             ) recorded_outflow
           ), 0)::text AS settled_minor,
           EXISTS (
             SELECT 1
             FROM refund_receipt_security_holds security_hold
             WHERE security_hold.source_fund_receipt_id = receipt.id
               AND NOT EXISTS (
                 SELECT 1
                 FROM refund_security_hold_adjudications adjudication
                 WHERE adjudication.receipt_security_hold_id = security_hold.id
               )
           ) AS active_security_hold
         FROM fund_receipts receipt
         WHERE receipt.id = $1
         FOR UPDATE`,
        [refund.source_fund_receipt_id],
      );
      const capacity = receiptCapacity.rows[0];
      if (
        !capacity ||
        capacity.active_security_hold ||
        BigInt(capacity.settled_minor) + BigInt(body.amountMinor) >
          BigInt(capacity.receipt_amount_minor)
      ) {
        return placeSecurityHold(
          capacity?.active_security_hold
            ? "Provider reported success while the source receipt has an unresolved security hold"
            : "Provider success would exceed the immutable source receipt amount",
          "refund.receipt_capacity_conflict",
          {
            eventId: body.eventId,
            receiptAmountMinor: capacity?.receipt_amount_minor ?? null,
            settledMinor: capacity?.settled_minor ?? null,
            reportedAmountMinor: body.amountMinor,
            activeReceiptSecurityHold: capacity?.active_security_hold ?? null,
          },
        );
      }

      await client.query(
        `UPDATE refunds
         SET status = 'succeeded', provider_occurred_at = $2, last_error = NULL,
             result = result || $3::jsonb, updated_at = now(), version = version + 1
         WHERE id = $1`,
        [
          refund.id,
          occurredAt,
          JSON.stringify({ externalRefundId: body.externalRefundId }),
        ],
      );
      await client.query(
        `UPDATE provider_operations
         SET status = 'succeeded', external_reference = $2, provider_occurred_at = $3,
             last_error = NULL, updated_at = now()
         WHERE id = $1`,
        [refund.operation_id, body.externalRefundId, occurredAt],
      );
      await client.query(
        `INSERT INTO refund_settlements(
           refund_id, provider_installation_id, external_refund_id,
           destination, amount_minor, currency, occurred_at
         ) VALUES ($1, $2, $3, 'original_payment', $4, $5, $6)`,
        [
          refund.id,
          MOCK_PAYMENT_INSTALLATION_ID,
          body.externalRefundId,
          body.amountMinor,
          body.currency,
          occurredAt,
        ],
      );
      const journal = await client.query<{ id: string }>(
        `INSERT INTO ledger_journals(source_type, source_id, currency, description)
         VALUES ('refund', $1, $2, 'Confirmed manual refund to original payment method')
         RETURNING id`,
        [refund.id, body.currency],
      );
      const journalId = journal.rows[0]?.id;
      if (!journalId) throw new Error("Unable to create refund journal");
      await client.query(
        `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
         VALUES
           ($1, 'sales_refunds_and_allowances', $2, 0),
           ($1, 'mock_cash', 0, $2)`,
        [journalId, body.amountMinor],
      );
      await client.query(
        `INSERT INTO refund_events(
           refund_id, event_type, actor_type, actor_id, reason, metadata, occurred_at
         ) VALUES ($1, 'succeeded', 'provider', $2, $3, $4, $5)`,
        [
          refund.id,
          MOCK_PAYMENT_INSTALLATION_ID,
          "Provider confirmed the original-payment refund",
          { eventId: body.eventId, externalRefundId: body.externalRefundId },
          occurredAt,
        ],
      );
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, reason, metadata
         ) VALUES ('provider', $1, 'refund.settled', 'refund', $2, $3, $4)`,
        [
          MOCK_PAYMENT_INSTALLATION_ID,
          refund.id,
          "Provider confirmed the refund",
          { externalRefundId: body.externalRefundId, amountMinor: body.amountMinor },
        ],
      );
      return { accepted: true, status: "succeeded" };
    });
    return reply.code(outcome.duplicate ? 200 : 202).send(outcome);
  });

  app.post("/api/v1/provider-events/provisioning", async (request, reply) => {
    const body = provisioningEventSchema.parse(request.body);
    assertProviderSignature(request, config.MOCK_PROVISIONING_WEBHOOK_SECRET, body);
    const outcome = await transaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `provider-operation:${body.providerOperationId}`,
      ]);
      const occurredAt = new Date(body.occurredAt);
      const operationResult = await client.query<{
        id: string;
        subject_id: string;
        status: string;
        attempt_count: number;
        created_at: Date;
        provider_occurred_at: Date | null;
      }>(
        `SELECT id, subject_id, status, attempt_count, created_at, provider_occurred_at
         FROM provider_operations
         WHERE id = $1
           AND provider_installation_id = $2
           AND subject_type = 'service'
           AND kind = 'resource_create'
         FOR UPDATE`,
        [body.providerOperationId, MOCK_PROVISIONING_INSTALLATION_ID],
      );
      const operation = operationResult.rows[0];
      if (!operation) return { rejected: true, reason: "unknown_provider_operation" };
      if (
        !providerOperationCapabilityMatches(
          body.callbackCapability,
          config.PROVIDER_OPERATION_CAPABILITY_SECRET,
          MOCK_PROVISIONING_INSTALLATION_ID,
          operation.id,
        )
      ) {
        await auditProvider(
          client,
          MOCK_PROVISIONING_INSTALLATION_ID,
          "provisioning.event_rejected",
          "service",
          operation.subject_id,
          "provisioning callback capability is invalid for the Provider operation",
          { eventId: body.eventId, providerOperationId: operation.id },
        );
        return { rejected: true, reason: "invalid_operation_capability" };
      }
      if (operation.attempt_count === 0) {
        await auditProvider(
          client,
          MOCK_PROVISIONING_INSTALLATION_ID,
          "provisioning.event_rejected",
          "service",
          operation.subject_id,
          "Provider reported a resource fact before Core sent the operation",
          { eventId: body.eventId, providerOperationId: operation.id },
        );
        return { rejected: true, reason: "provider_operation_not_started" };
      }
      const provisionPointers = await client.query<{
        invoice_id: string;
        order_id: string;
        order_item_id: string;
        submitted_by_user_id: string;
        client_account_id: string;
      }>(
        `SELECT
           i.id AS invoice_id,
           o.id AS order_id,
           oi.id AS order_item_id,
           o.submitted_by_user_id,
           o.client_account_id
         FROM services s
         JOIN order_items oi ON oi.id = s.order_item_id
         JOIN orders o ON o.id = oi.order_id
         JOIN invoices i ON i.order_id = o.id
         WHERE s.id = $1`,
        [operation.subject_id],
      );
      const provisionPointer = provisionPointers.rows[0];
      if (!provisionPointer) {
        await auditProvider(
          client,
          MOCK_PROVISIONING_INSTALLATION_ID,
          "provisioning.event_rejected",
          "service",
          operation.subject_id,
          "Provider operation points to inconsistent Core service ownership records",
          { eventId: body.eventId, providerOperationId: operation.id },
        );
        return { rejected: true, reason: "core_ownership_mismatch" };
      }
      await client.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [
        provisionPointer.invoice_id,
      ]);
      await client.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [
        provisionPointer.order_id,
      ]);
      await client.query("SELECT id FROM order_items WHERE id = $1 FOR UPDATE", [
        provisionPointer.order_item_id,
      ]);
      await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [
        operation.subject_id,
      ]);
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
        provisionPointer.submitted_by_user_id,
      ]);
      await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
        provisionPointer.client_account_id,
      ]);
      await client.query(
        `SELECT client_account_id
         FROM client_memberships
         WHERE client_account_id = $1 AND user_id = $2
         FOR UPDATE`,
        [provisionPointer.client_account_id, provisionPointer.submitted_by_user_id],
      );
      const inboxOutcome = await insertInbox(
        client,
        MOCK_PROVISIONING_INSTALLATION_ID,
        body.eventId,
        "resource.status",
        body,
      );
      if (inboxOutcome === "duplicate") {
        return { duplicate: true };
      }
      if (inboxOutcome === "conflict") {
        await auditProvider(
          client,
          MOCK_PROVISIONING_INSTALLATION_ID,
          "provisioning.event_id_conflict",
          "service",
          operation.subject_id,
          "Provider reused a provisioning event id with a different event type or payload",
          { eventId: body.eventId, providerOperationId: operation.id },
        );
        return { rejected: true, reason: "event_id_conflict" };
      }
      if (!isAfter(operation.provider_occurred_at, occurredAt)) {
        return { ignored: true, reason: "stale_provider_fact" };
      }
      if (operation.status === "succeeded") return { ignored: true, reason: "already_succeeded" };

      const serviceResult = await client.query<{
        id: string;
        status: string;
        billing_cycle: BillingCycle;
        order_id: string;
        order_status: string;
        email_verified_at: Date | null;
        user_restricted_at: Date | null;
        account_restricted_at: Date | null;
        removed_at: Date | null;
      }>(
        `SELECT
           s.id, s.status, s.billing_cycle, o.id AS order_id, o.status AS order_status,
           u.email_verified_at, u.restricted_at AS user_restricted_at,
           ca.restricted_at AS account_restricted_at, cm.removed_at
         FROM services s
         JOIN order_items oi ON oi.id = s.order_item_id
         JOIN orders o ON o.id = oi.order_id
         JOIN users u ON u.id = o.submitted_by_user_id
         JOIN client_accounts ca ON ca.id = o.client_account_id
         JOIN client_memberships cm
           ON cm.client_account_id = o.client_account_id
          AND cm.user_id = o.submitted_by_user_id
         WHERE s.id = $1`,
        [operation.subject_id],
      );
      const service = serviceResult.rows[0];
      if (!service) throw new Error("Provider operation points to an invalid service");

      if (body.status === "failed") {
        await client.query(
          `UPDATE provider_operations
           SET status = 'failed', provider_occurred_at = $2, updated_at = now(),
               last_error = 'provider reported failure'
           WHERE id = $1`,
          [operation.id, occurredAt],
        );
        await client.query(
          `UPDATE services
           SET status = 'provision_failed', updated_at = now(), version = version + 1
           WHERE id = $1 AND status IN ('provisioning', 'confirming')`,
          [service.id],
        );
        await client.query(
          `UPDATE orders
           SET status = 'on_hold', updated_at = now(), version = version + 1
           WHERE id = $1 AND status IN ('accepted', 'fulfilling')`,
          [service.order_id],
        );
        return { accepted: true, status: "failed", orderStatus: "on_hold" };
      }
      if (!body.externalResourceId || !body.readyAt) {
        return { rejected: true, reason: "success_requires_resource_and_ready_time" };
      }
      if (
        !["accepted", "fulfilling"].includes(service.order_status) ||
        !["provisioning", "confirming"].includes(service.status)
      ) {
        await auditProvider(
          client,
          "mock-provisioning-v1",
          "provisioning.state_conflict",
          "service",
          service.id,
          "provider reported success for a service not awaiting provisioning",
          {
            orderStatus: service.order_status,
            serviceStatus: service.status,
            providerOperationId: operation.id,
          },
        );
        return { rejected: true, reason: "service_not_awaiting_provisioning" };
      }

      const readyAt = new Date(body.readyAt);
      const earliest = operation.created_at.getTime() - 60_000;
      const latest = Math.min(Date.now() + 5 * 60_000, occurredAt.getTime() + 60_000);
      if (
        occurredAt.getTime() < earliest ||
        occurredAt.getTime() > Date.now() + 5 * 60_000 ||
        readyAt.getTime() < earliest ||
        readyAt.getTime() > latest
      ) {
        await auditProvider(
          client,
          "mock-provisioning-v1",
          "provisioning.ready_time_rejected",
          "service",
          service.id,
          "provider supplied an implausible Ready for Service timestamp",
          {
            operationCreatedAt: operation.created_at.toISOString(),
            occurredAt: body.occurredAt,
            readyAt: body.readyAt,
          },
        );
        await client.query(
          `UPDATE provider_operations
           SET status = 'unknown', provider_occurred_at = $2,
               last_error = 'invalid Ready for Service timestamp', updated_at = now()
           WHERE id = $1`,
          [operation.id, occurredAt],
        );
        await client.query(
          `UPDATE services SET status = 'confirming', updated_at = now(), version = version + 1
           WHERE id = $1 AND status IN ('provisioning', 'confirming')`,
          [service.id],
        );
        return { rejected: true, reason: "invalid_ready_time" };
      }

      const resourceOwner = await client.query<{ id: string }>(
        "SELECT id FROM services WHERE external_resource_id = $1 AND id <> $2",
        [body.externalResourceId, service.id],
      );
      if (resourceOwner.rows[0]) {
        await auditProvider(
          client,
          "mock-provisioning-v1",
          "provisioning.resource_id_conflict",
          "service",
          service.id,
          "external resource id is already bound to another service",
          { externalResourceId: body.externalResourceId, ownerServiceId: resourceOwner.rows[0].id },
        );
        return { rejected: true, reason: "external_resource_conflict" };
      }

      const eligible =
        Boolean(service.email_verified_at) &&
        !service.user_restricted_at &&
        !service.account_restricted_at &&
        !service.removed_at;
      await client.query(
        `UPDATE provider_operations
         SET status = 'succeeded', external_reference = $2, provider_occurred_at = $3,
             updated_at = now(), last_error = NULL
         WHERE id = $1`,
        [operation.id, body.externalResourceId, occurredAt],
      );
      if (!eligible) {
        await client.query(
          `UPDATE services
           SET status = 'provisioned_hold', external_resource_id = $2,
               updated_at = now(), version = version + 1
           WHERE id = $1 AND status IN ('provisioning', 'confirming')`,
          [service.id, body.externalResourceId],
        );
        await client.query(
          `UPDATE orders
           SET status = 'on_hold', updated_at = now(), version = version + 1
           WHERE id = $1 AND status IN ('accepted', 'fulfilling')`,
          [service.order_id],
        );
        return { accepted: true, status: "provisioned_hold" };
      }

      const termEnd = addBillingCycle(readyAt, service.billing_cycle);
      const activated = await client.query(
        `UPDATE services
         SET status = 'active', external_resource_id = $2, activated_at = $3,
             term_start = $3, term_end = $4, updated_at = now(), version = version + 1
         WHERE id = $1
           AND activated_at IS NULL
           AND status IN ('provisioning', 'confirming')
         RETURNING id`,
        [service.id, body.externalResourceId, readyAt, termEnd],
      );
      if (activated.rowCount !== 1) {
        throw new Error("Service state changed while accepting provider success");
      }
      const completed = await client.query(
        `UPDATE orders
         SET status = 'completed', updated_at = now(), version = version + 1
         WHERE id = $1 AND status IN ('accepted', 'fulfilling')
         RETURNING id`,
        [service.order_id],
      );
      if (completed.rowCount !== 1) {
        throw new Error("Order state changed while activating service");
      }
      await client.query(
        `INSERT INTO outbox(event_type, unique_key, payload)
         VALUES ('service.activated', $1, $2)
         ON CONFLICT (event_type, unique_key) DO NOTHING`,
        [
          `service:${service.id}`,
          {
            serviceId: service.id,
            orderId: service.order_id,
            activatedAt: readyAt.toISOString(),
            termEnd: termEnd?.toISOString() ?? null,
          },
        ],
      );
      return { accepted: true, status: "active" };
    });
    return reply.code(outcome.duplicate ? 200 : 202).send(outcome);
  });
}
