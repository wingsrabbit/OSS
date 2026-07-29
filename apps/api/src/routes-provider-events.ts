// SPDX-License-Identifier: AGPL-3.0-or-later

import { addBillingCycle, canTransitionPayment, type BillingCycle, type PaymentStatus } from "@opensales/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "./config.js";
import { transaction, type DatabaseClient, type DatabasePool } from "./database.js";
import { assertProviderSignature } from "./provider-signature.js";

const paymentEventSchema = z.object({
  eventId: z.string().min(1).max(160),
  paymentAttemptId: z.uuid(),
  externalPaymentId: z.string().min(1).max(160),
  status: z.enum(["processing", "succeeded", "failed", "cancelled", "expired"]),
  amountMinor: z.string().regex(/^[1-9]\d*$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  occurredAt: z.iso.datetime(),
});

const provisioningEventSchema = z.object({
  eventId: z.string().min(1).max(160),
  providerOperationId: z.uuid(),
  status: z.enum(["succeeded", "failed"]),
  externalResourceId: z.string().min(1).max(200).optional(),
  readyAt: z.iso.datetime().optional(),
  occurredAt: z.iso.datetime(),
});

async function insertInbox(
  client: DatabaseClient,
  providerInstallationId: string,
  eventId: string,
  eventType: string,
  payload: unknown,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO provider_inbox(
       provider_installation_id, external_event_id, event_type, payload
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider_installation_id, external_event_id) DO NOTHING
     RETURNING id`,
    [providerInstallationId, eventId, eventType, payload],
  );
  return result.rowCount === 1;
}

async function auditProvider(
  client: DatabaseClient,
  action: string,
  targetType: string,
  targetId: string,
  reason: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events(
       actor_type, actor_id, action, target_type, target_id, reason, metadata
     ) VALUES ('provider', 'mock-laboratory', $1, $2, $3, $4, $5)`,
    [action, targetType, targetId, reason, metadata],
  );
}

function isAfter(previous: Date | null, next: Date): boolean {
  return !previous || next.getTime() > previous.getTime();
}

async function recordReceipt(
  client: DatabaseClient,
  input: {
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
     ) VALUES ('mock-payment-v1', $1, $2, $3, $4, $5, $6, 'received')
     ON CONFLICT (provider_installation_id, external_payment_id) DO NOTHING
     RETURNING id`,
    [
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
     WHERE provider_installation_id = 'mock-payment-v1'
       AND external_payment_id = $1
     FOR UPDATE`,
    [input.externalPaymentId],
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

export async function registerProviderEventRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.post("/api/v1/provider-events/payment", async (request, reply) => {
    const body = paymentEventSchema.parse(request.body);
    assertProviderSignature(request, config.MOCK_PAYMENT_WEBHOOK_SECRET, body);

    const outcome = await transaction(pool, async (client) => {
      if (!(await insertInbox(client, "mock-payment-v1", body.eventId, "payment.status", body))) {
        return { duplicate: true };
      }
      const occurredAt = new Date(body.occurredAt);
      const attemptResult = await client.query<{
        id: string;
        client_account_id: string;
        invoice_id: string;
        status: PaymentStatus;
        amount_minor: string;
        currency: string;
        provider_occurred_at: Date | null;
      }>(
        `SELECT id, client_account_id, invoice_id, status, amount_minor, currency,
                provider_occurred_at
         FROM payment_attempts
         WHERE id = $1
         FOR UPDATE`,
        [body.paymentAttemptId],
      );
      const attempt = attemptResult.rows[0];
      if (!attempt) {
        await auditProvider(
          client,
          "payment.event_rejected",
          "payment",
          body.paymentAttemptId,
          "unknown payment attempt",
          { eventId: body.eventId, externalPaymentId: body.externalPaymentId },
        );
        return { rejected: true, reason: "unknown_payment_attempt" };
      }

      const externalOwner = await client.query<{ id: string }>(
        `SELECT id
         FROM payment_attempts
         WHERE provider_installation_id = 'mock-payment-v1'
           AND external_payment_id = $1
           AND id <> $2`,
        [body.externalPaymentId, attempt.id],
      );
      if (externalOwner.rows[0]) {
        await auditProvider(
          client,
          "payment.external_id_conflict",
          "payment",
          attempt.id,
          "external payment id is already bound to another Core attempt",
          { externalPaymentId: body.externalPaymentId, ownerAttemptId: externalOwner.rows[0].id },
        );
        return { rejected: true, reason: "external_payment_conflict" };
      }

      if (body.status !== "succeeded") {
        if (!isAfter(attempt.provider_occurred_at, occurredAt)) {
          return { ignored: true, reason: "stale_provider_fact" };
        }
        if (!canTransitionPayment(attempt.status, body.status)) {
          return { ignored: true, reason: "stale_or_backward_transition" };
        }
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
           WHERE subject_type = 'payment' AND subject_id = $1 AND status <> 'succeeded'`,
          [
            attempt.id,
            body.status === "processing" ? "running" : "failed",
            body.externalPaymentId,
            occurredAt,
          ],
        );
        return { accepted: true, status: body.status };
      }

      const receipt = await recordReceipt(client, {
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
           WHERE subject_type = 'payment' AND subject_id = $1 AND status <> 'succeeded'`,
          [attempt.id, reason, occurredAt],
        );
        await auditProvider(
          client,
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
      const allocationResult = await client.query<{ allocated_minor: string }>(
        `SELECT COALESCE(sum(amount_minor), 0)::text AS allocated_minor
         FROM payment_allocations
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
         WHERE subject_type = 'payment' AND subject_id = $1`,
        [attempt.id, body.externalPaymentId, occurredAt],
      );

      const allocatedAfter = allocatedBefore + allocationMinor;
      if (!invoice.order_id || allocatedAfter < BigInt(invoice.total_minor)) {
        return { accepted: true, status: "succeeded", invoiceStatus: "partially_paid" };
      }
      await client.query(
        `INSERT INTO outbox(event_type, unique_key, payload)
         VALUES ('invoice.paid', $1, $2)
         ON CONFLICT (event_type, unique_key) DO NOTHING`,
        [`invoice:${attempt.invoice_id}`, { invoiceId: attempt.invoice_id, orderId: invoice.order_id }],
      );

      const orderResult = await client.query<{
        id: string;
        status: string;
        submitted_by_user_id: string;
        client_account_id: string;
        fulfillment_mode: "automatic" | "review" | "manual" | "quote";
        service_id: string;
        email_verified_at: Date | null;
        user_restricted_at: Date | null;
        account_restricted_at: Date | null;
        removed_at: Date | null;
      }>(
        `SELECT
           o.id, o.status, o.submitted_by_user_id, o.client_account_id,
           oi.fulfillment_mode, s.id AS service_id,
           u.email_verified_at, u.restricted_at AS user_restricted_at,
           ca.restricted_at AS account_restricted_at, cm.removed_at
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         JOIN services s ON s.order_item_id = oi.id
         JOIN users u ON u.id = o.submitted_by_user_id
         JOIN client_accounts ca ON ca.id = o.client_account_id
         JOIN client_memberships cm
           ON cm.client_account_id = o.client_account_id
          AND cm.user_id = o.submitted_by_user_id
         WHERE o.id = $1
         FOR UPDATE OF o, s, u, ca, cm`,
        [invoice.order_id],
      );
      const order = orderResult.rows[0];
      if (!order) throw new Error("Payment is linked to an invalid order");
      if (["completed", "cancelled", "rejected"].includes(order.status)) {
        await auditProvider(
          client,
          "payment.paid_order_terminal",
          "order",
          order.id,
          "invoice became paid after the order entered a terminal state",
          { status: order.status, receiptId: receipt.id },
        );
        return { accepted: true, status: "succeeded", orderStatus: order.status };
      }

      const eligible =
        Boolean(order.email_verified_at) &&
        !order.user_restricted_at &&
        !order.account_restricted_at &&
        !order.removed_at;
      if (!eligible) {
        await client.query(
          `UPDATE orders
           SET status = 'on_hold', updated_at = now(), version = version + 1
           WHERE id = $1 AND status IN ('waiting_payment', 'accepted', 'awaiting_manual', 'fulfilling')`,
          [order.id],
        );
        return { accepted: true, status: "succeeded", orderStatus: "on_hold" };
      }

      if (order.fulfillment_mode === "manual" || order.fulfillment_mode === "review") {
        await client.query(
          `UPDATE orders
           SET status = 'awaiting_manual', updated_at = now(), version = version + 1
           WHERE id = $1 AND status = 'waiting_payment'`,
          [order.id],
        );
        return { accepted: true, status: "succeeded", orderStatus: "awaiting_manual" };
      }

      const accepted = await client.query(
        `UPDATE orders
         SET status = 'accepted', updated_at = now(), version = version + 1
         WHERE id = $1 AND status = 'waiting_payment'
         RETURNING id`,
        [order.id],
      );
      if (accepted.rowCount !== 1) {
        return { accepted: true, status: "succeeded", orderStatus: order.status };
      }
      const operationResult = await client.query<{ id: string }>(
        `INSERT INTO provider_operations(
           provider_installation_id, kind, subject_type, subject_id, stable_key, status
         ) VALUES ('mock-provisioning-v1', 'resource_create', 'service', $1, $2, 'queued')
         ON CONFLICT (provider_installation_id, kind, stable_key) DO UPDATE
           SET updated_at = provider_operations.updated_at
         RETURNING id`,
        [order.service_id, `service:${order.service_id}`],
      );
      const operationId = operationResult.rows[0]?.id;
      if (!operationId) throw new Error("Unable to create provisioning operation");
      await client.query(
        `INSERT INTO durable_jobs(job_type, unique_key, payload)
         VALUES ('provision.start', $1, $2)
         ON CONFLICT (job_type, unique_key) DO NOTHING`,
        [
          `service:${order.service_id}`,
          { serviceId: order.service_id, providerOperationId: operationId },
        ],
      );
      return { accepted: true, status: "succeeded", orderStatus: "accepted" };
    });
    return reply.code(outcome.duplicate ? 200 : 202).send(outcome);
  });

  app.post("/api/v1/provider-events/provisioning", async (request, reply) => {
    const body = provisioningEventSchema.parse(request.body);
    assertProviderSignature(request, config.MOCK_PROVISIONING_WEBHOOK_SECRET, body);
    const outcome = await transaction(pool, async (client) => {
      if (
        !(await insertInbox(
          client,
          "mock-provisioning-v1",
          body.eventId,
          "resource.status",
          body,
        ))
      ) {
        return { duplicate: true };
      }
      const occurredAt = new Date(body.occurredAt);
      const operationResult = await client.query<{
        id: string;
        subject_id: string;
        status: string;
        created_at: Date;
        provider_occurred_at: Date | null;
      }>(
        `SELECT id, subject_id, status, created_at, provider_occurred_at
         FROM provider_operations
         WHERE id = $1
           AND provider_installation_id = 'mock-provisioning-v1'
           AND kind IN ('resource_create', 'resource_reconcile')
         FOR UPDATE`,
        [body.providerOperationId],
      );
      const operation = operationResult.rows[0];
      if (!operation) return { rejected: true, reason: "unknown_provider_operation" };
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
         WHERE s.id = $1
         FOR UPDATE OF s, o, u, ca, cm`,
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
           SET status = 'confirming', updated_at = now(), version = version + 1
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
