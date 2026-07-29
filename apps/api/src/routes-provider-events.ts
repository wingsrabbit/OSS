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

export async function registerProviderEventRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.post("/api/v1/provider-events/payment", async (request, reply) => {
    const body = paymentEventSchema.parse(request.body);
    assertProviderSignature(request, config.MOCK_PROVIDER_WEBHOOK_SECRET, body);

    const outcome = await transaction(pool, async (client) => {
      if (!(await insertInbox(client, "mock-payment-v1", body.eventId, "payment.status", body))) {
        return { duplicate: true };
      }
      const attemptResult = await client.query<{
        id: string;
        client_account_id: string;
        invoice_id: string;
        status: PaymentStatus;
        amount_minor: string;
        currency: string;
      }>(
        `SELECT id, client_account_id, invoice_id, status, amount_minor, currency
         FROM payment_attempts
         WHERE id = $1
         FOR UPDATE`,
        [body.paymentAttemptId],
      );
      const attempt = attemptResult.rows[0];
      if (!attempt) {
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, reason, metadata
           ) VALUES ('provider', 'mock-payment-v1', 'payment.event_rejected', 'payment', $1, $2, $3)`,
          [body.paymentAttemptId, "unknown payment attempt", { eventId: body.eventId }],
        );
        return { rejected: true, reason: "unknown_payment_attempt" };
      }
      if (attempt.amount_minor !== body.amountMinor || attempt.currency !== body.currency) {
        await client.query(
          `UPDATE payment_attempts
           SET status = 'unknown', updated_at = now(), version = version + 1
           WHERE id = $1 AND status NOT IN ('succeeded', 'failed', 'cancelled', 'expired')`,
          [attempt.id],
        );
        await client.query(
          `UPDATE provider_operations
           SET status = 'unknown', last_error = 'amount or currency mismatch', updated_at = now()
           WHERE subject_type = 'payment' AND subject_id = $1 AND status <> 'succeeded'`,
          [attempt.id],
        );
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, reason, metadata
           ) VALUES ('provider', 'mock-payment-v1', 'payment.amount_mismatch', 'payment', $1, $2, $3)`,
          [
            attempt.id,
            "provider amount or currency does not match the Core snapshot",
            {
              expectedAmountMinor: attempt.amount_minor,
              receivedAmountMinor: body.amountMinor,
              expectedCurrency: attempt.currency,
              receivedCurrency: body.currency,
            },
          ],
        );
        return { rejected: true, reason: "amount_or_currency_mismatch" };
      }
      if (!canTransitionPayment(attempt.status, body.status)) {
        return { ignored: true, reason: "stale_or_backward_transition" };
      }

      if (body.status !== "succeeded") {
        await client.query(
          `UPDATE payment_attempts
           SET status = $2, external_payment_id = COALESCE(external_payment_id, $3),
               updated_at = now(), version = version + 1
           WHERE id = $1`,
          [attempt.id, body.status, body.externalPaymentId],
        );
        await client.query(
          `UPDATE provider_operations
           SET status = $2, external_reference = COALESCE(external_reference, $3),
               updated_at = now()
           WHERE subject_type = 'payment' AND subject_id = $1 AND status <> 'succeeded'`,
          [
            attempt.id,
            body.status === "processing" ? "running" : "failed",
            body.externalPaymentId,
          ],
        );
        return { accepted: true, status: body.status };
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
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, reason, metadata
           ) VALUES ('provider', 'mock-payment-v1', 'payment.external_id_conflict', 'payment', $1, $2, $3)`,
          [
            attempt.id,
            "external payment id is already bound to another Core attempt",
            { externalPaymentId: body.externalPaymentId },
          ],
        );
        return { rejected: true, reason: "external_payment_conflict" };
      }

      await client.query(
        `UPDATE payment_attempts
         SET status = 'succeeded', external_payment_id = $2, updated_at = now(), version = version + 1
         WHERE id = $1`,
        [attempt.id, body.externalPaymentId],
      );
      await client.query(
        `UPDATE provider_operations
         SET status = 'succeeded', external_reference = $2, last_error = NULL, updated_at = now()
         WHERE subject_type = 'payment' AND subject_id = $1`,
        [attempt.id, body.externalPaymentId],
      );
      const journalResult = await client.query<{ id: string }>(
        `INSERT INTO ledger_journals(source_type, source_id, currency, description)
         VALUES ('payment_settlement', $1, $2, 'Mock payment settlement')
         ON CONFLICT (source_type, source_id) DO UPDATE
           SET description = ledger_journals.description
         RETURNING id`,
        [attempt.id, attempt.currency],
      );
      const journalId = journalResult.rows[0]?.id;
      if (!journalId) throw new Error("Unable to record payment journal");
      const linesExist = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger_lines WHERE journal_id = $1",
        [journalId],
      );
      if (linesExist.rows[0]?.count === "0") {
        await client.query(
          `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
           VALUES
             ($1, 'mock_cash', $2, 0),
             ($1, 'accounts_receivable', 0, $2)`,
          [journalId, attempt.amount_minor],
        );
      }
      await client.query(
        `INSERT INTO payment_allocations(payment_attempt_id, invoice_id, amount_minor)
         VALUES ($1, $2, $3)
         ON CONFLICT (payment_attempt_id, invoice_id) DO NOTHING`,
        [attempt.id, attempt.invoice_id, attempt.amount_minor],
      );

      const invoiceResult = await client.query<{
        total_minor: string;
        order_id: string;
      }>(
        `SELECT total_minor, order_id
         FROM invoices
         WHERE id = $1
         FOR UPDATE`,
        [attempt.invoice_id],
      );
      const invoice = invoiceResult.rows[0];
      const allocationResult = await client.query<{ allocated_minor: string }>(
        `SELECT COALESCE(sum(amount_minor), 0)::text AS allocated_minor
         FROM payment_allocations
         WHERE invoice_id = $1`,
        [attempt.invoice_id],
      );
      const allocatedMinor = BigInt(allocationResult.rows[0]?.allocated_minor ?? "0");
      if (!invoice?.order_id || allocatedMinor < BigInt(invoice.total_minor)) {
        return { accepted: true, status: "succeeded", invoiceStatus: "partially_paid" };
      }

      const orderResult = await client.query<{
        id: string;
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
           o.id, o.submitted_by_user_id, o.client_account_id,
           oi.fulfillment_mode, s.id AS service_id,
           u.email_verified_at, u.restricted_at AS user_restricted_at,
           ca.restricted_at AS account_restricted_at, cm.removed_at
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         JOIN services s ON s.order_item_id = oi.id
         JOIN users u ON u.id = o.submitted_by_user_id
         JOIN client_accounts ca ON ca.id = o.client_account_id
         LEFT JOIN client_memberships cm
           ON cm.client_account_id = o.client_account_id
          AND cm.user_id = o.submitted_by_user_id
         WHERE o.id = $1
         FOR UPDATE OF o, s, u, ca, cm`,
        [invoice.order_id],
      );
      const order = orderResult.rows[0];
      if (!order) throw new Error("Payment is linked to an invalid order");
      const eligible =
        Boolean(order.email_verified_at) &&
        !order.user_restricted_at &&
        !order.account_restricted_at &&
        !order.removed_at;
      if (!eligible) {
        await client.query("UPDATE orders SET status = 'on_hold', updated_at = now() WHERE id = $1", [
          order.id,
        ]);
        return { accepted: true, status: "succeeded", orderStatus: "on_hold" };
      }

      if (order.fulfillment_mode === "manual" || order.fulfillment_mode === "review") {
        await client.query(
          "UPDATE orders SET status = 'awaiting_manual', updated_at = now() WHERE id = $1",
          [order.id],
        );
        return { accepted: true, status: "succeeded", orderStatus: "awaiting_manual" };
      }

      await client.query("UPDATE orders SET status = 'accepted', updated_at = now() WHERE id = $1", [
        order.id,
      ]);
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
      await client.query(
        `INSERT INTO outbox(event_type, unique_key, payload)
         VALUES ('invoice.paid', $1, $2)
         ON CONFLICT (event_type, unique_key) DO NOTHING`,
        [`invoice:${attempt.invoice_id}`, { invoiceId: attempt.invoice_id, orderId: order.id }],
      );
      return { accepted: true, status: "succeeded", orderStatus: "accepted" };
    });
    return reply.code(outcome.duplicate ? 200 : 202).send(outcome);
  });

  app.post("/api/v1/provider-events/provisioning", async (request, reply) => {
    const body = provisioningEventSchema.parse(request.body);
    assertProviderSignature(request, config.MOCK_PROVIDER_WEBHOOK_SECRET, body);
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
      const operationResult = await client.query<{
        id: string;
        subject_id: string;
        status: string;
      }>(
        `SELECT id, subject_id, status
         FROM provider_operations
         WHERE id = $1
           AND provider_installation_id = 'mock-provisioning-v1'
           AND kind IN ('resource_create', 'resource_reconcile')
         FOR UPDATE`,
        [body.providerOperationId],
      );
      const operation = operationResult.rows[0];
      if (!operation) return { rejected: true, reason: "unknown_provider_operation" };
      if (operation.status === "succeeded") return { ignored: true, reason: "already_succeeded" };
      if (body.status === "failed") {
        await client.query(
          `UPDATE provider_operations
           SET status = 'failed', updated_at = now(), last_error = 'provider reported failure'
           WHERE id = $1`,
          [operation.id],
        );
        await client.query(
          `UPDATE services SET status = 'pending', updated_at = now(), version = version + 1
           WHERE id = $1 AND status <> 'active'`,
          [operation.subject_id],
        );
        return { accepted: true, status: "failed" };
      }
      if (!body.externalResourceId || !body.readyAt) {
        return { rejected: true, reason: "success_requires_resource_and_ready_time" };
      }

      const serviceResult = await client.query<{
        id: string;
        billing_cycle: BillingCycle;
        order_id: string;
        submitted_by_user_id: string;
        email_verified_at: Date | null;
        user_restricted_at: Date | null;
        account_restricted_at: Date | null;
        removed_at: Date | null;
      }>(
        `SELECT
           s.id, s.billing_cycle, o.id AS order_id, o.submitted_by_user_id,
           u.email_verified_at, u.restricted_at AS user_restricted_at,
           ca.restricted_at AS account_restricted_at, cm.removed_at
         FROM services s
         JOIN order_items oi ON oi.id = s.order_item_id
         JOIN orders o ON o.id = oi.order_id
         JOIN users u ON u.id = o.submitted_by_user_id
         JOIN client_accounts ca ON ca.id = o.client_account_id
         LEFT JOIN client_memberships cm
           ON cm.client_account_id = o.client_account_id
          AND cm.user_id = o.submitted_by_user_id
         WHERE s.id = $1
         FOR UPDATE OF s, o, u, ca, cm`,
        [operation.subject_id],
      );
      const service = serviceResult.rows[0];
      if (!service) throw new Error("Provider operation points to an invalid service");
      const readyAt = new Date(body.readyAt);
      const termEnd = addBillingCycle(readyAt, service.billing_cycle);
      const eligible =
        Boolean(service.email_verified_at) &&
        !service.user_restricted_at &&
        !service.account_restricted_at &&
        !service.removed_at;

      await client.query(
        `UPDATE provider_operations
         SET status = 'succeeded', external_reference = $2, updated_at = now(), last_error = NULL
         WHERE id = $1`,
        [operation.id, body.externalResourceId],
      );
      if (!eligible) {
        await client.query(
          `UPDATE services
           SET status = 'provisioned_hold', external_resource_id = $2,
               updated_at = now(), version = version + 1
           WHERE id = $1`,
          [service.id, body.externalResourceId],
        );
        await client.query("UPDATE orders SET status = 'on_hold', updated_at = now() WHERE id = $1", [
          service.order_id,
        ]);
        return { accepted: true, status: "provisioned_hold" };
      }
      await client.query(
        `UPDATE services
         SET status = 'active', external_resource_id = $2, activated_at = $3,
             term_start = $3, term_end = $4, updated_at = now(), version = version + 1
         WHERE id = $1 AND activated_at IS NULL`,
        [service.id, body.externalResourceId, readyAt, termEnd],
      );
      await client.query("UPDATE orders SET status = 'completed', updated_at = now() WHERE id = $1", [
        service.order_id,
      ]);
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
