// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assertCustomerCapability,
  assertEligible,
  expectedAccountContextVersion,
  lockMembershipAccountForMutation,
  lockSessionContextForMutation,
  requireSessionIdentity,
  requireUser,
  type LockedAccountContext,
} from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabasePool } from "./database.js";
import { requestFingerprint } from "./idempotency.js";
import {
  enqueueNotification,
  enqueueSubscribedContactNotifications,
} from "./notification-outbox.js";
import {
  requireRecentReauth,
  requireStaffActionLocked,
  requireStaffPermission,
} from "./routes-admin.js";

const scheduleCancellationSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(3).max(1_000).optional(),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();

const completeManualCancellationSchema = z
  .object({
    expectedExecutionVersion: z.number().int().positive(),
    expectedServiceVersion: z.number().int().positive(),
    reason: z.string().trim().min(10).max(1_000),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();

type CancellationResult = {
  cancellation: {
    requestId: string;
    status: "scheduled";
    executionMode: "automatic" | "manual";
    executionStatus: "scheduled";
    effectiveAt: string;
    requestedAt: string;
  };
  serviceVersion: number;
};

type PristineRenewal = {
  renewalId: string;
  invoiceId: string;
  amountMinor: string;
  currency: string;
};

class RetryCancellationTransaction extends Error {}

function requestError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

function assertCancellationContextLocked(context: LockedAccountContext): void {
  try {
    assertCustomerCapability(context, "services.manage");
  } catch {
    throw requestError("Account is not eligible to schedule cancellation", 403, "ACCOUNT_NOT_ELIGIBLE");
  }
}

export async function registerServiceRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.post("/api/v1/services/:serviceId/cancellation", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    const expectedContextVersion = expectedAccountContextVersion(request);
    assertEligible(user);
    assertCustomerCapability(user, "services.manage");
    const params = z.object({ serviceId: z.uuid() }).parse(request.params);
    const body = scheduleCancellationSchema.parse(request.body);
    const fingerprint = requestFingerprint("services.schedule-cancellation:v1", {
      serviceId: params.serviceId,
      expectedVersion: body.expectedVersion,
      reason: body.reason ?? null,
    });

    let outcome: (CancellationResult & { replayed: boolean }) | undefined;
    for (let transactionAttempt = 0; transactionAttempt < 3; transactionAttempt += 1) {
      try {
        outcome = await transaction(pool, async (client) => {
      const sessionContext = await lockSessionContextForMutation(
        client,
        user,
        expectedContextVersion,
      );
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `service-cancellation:${user.userId}:${body.idempotencyKey}`,
      ]);
      const replay = await client.query<{
        client_account_id: string;
        request_fingerprint: string;
        result: CancellationResult;
      }>(
        `SELECT client_account_id, request_fingerprint, result
         FROM service_cancellation_requests
         WHERE requested_by_user_id = $1 AND idempotency_key = $2`,
        [user.userId, body.idempotencyKey],
      );
      const previous = replay.rows[0];
      if (previous) {
        if (
          previous.client_account_id !== user.clientAccountId ||
          previous.request_fingerprint !== fingerprint
        ) {
          throw requestError(
            "This idempotency key was already used for a different cancellation request",
            409,
            "IDEMPOTENCY_CONFLICT",
          );
        }
        const accountContext = await lockMembershipAccountForMutation(
          client,
          user,
          sessionContext,
        );
        assertCancellationContextLocked(accountContext);
        return { ...previous.result, replayed: true };
      }

      // Follow the payment path's invoice -> order -> service lock order. If
      // renewal automation creates a new invoice between the read and service
      // lock, roll this transaction back and repeat with the new invoice lock.
      const renewalPreflight = await client.query<{
        renewal_id: string;
        invoice_id: string;
        order_id: string;
        order_item_id: string;
      }>(
        `SELECT renewal.id AS renewal_id,
                renewal.invoice_id,
                original_order.id AS order_id,
                item.id AS order_item_id
         FROM service_renewals renewal
         JOIN services service ON service.id = renewal.service_id
         JOIN order_items item ON item.id = service.order_item_id
         JOIN orders original_order ON original_order.id = item.order_id
         WHERE renewal.service_id = $1
           AND renewal.status IN ('invoiced', 'manual_hold')
         ORDER BY renewal.invoice_id`,
        [params.serviceId],
      );
      const invoiceIds = renewalPreflight.rows.map((row) => row.invoice_id);
      if (invoiceIds.length > 0) {
        await client.query(
          `SELECT id FROM invoices
           WHERE id = ANY($1::uuid[])
           ORDER BY id
           FOR UPDATE`,
          [invoiceIds],
        );
      }
      const orderIds = [...new Set(renewalPreflight.rows.map((row) => row.order_id))].sort();
      if (orderIds.length > 0) {
        await client.query(
          `SELECT id FROM orders
           WHERE id = ANY($1::uuid[])
           ORDER BY id
           FOR UPDATE`,
          [orderIds],
        );
      }
      const orderItemIds = [
        ...new Set(renewalPreflight.rows.map((row) => row.order_item_id)),
      ].sort();
      if (orderItemIds.length > 0) {
        await client.query(
          `SELECT id FROM order_items
           WHERE id = ANY($1::uuid[])
           ORDER BY id
           FOR UPDATE`,
          [orderItemIds],
        );
      }

      const serviceResult = await client.query<{
        id: string;
        product_name: string;
        client_account_id: string;
        status: string;
        billing_cycle: string;
        term_end: Date | null;
        version: number;
        cancellation_request_id: string | null;
        cancellation_effective_at: Date | null;
        product_policy_version: number | null;
        cancellation_mode: "self_service" | "authenticated_ticket" | "manual_review" | "disabled" | null;
        cancellation_execution_mode: "automatic" | "manual" | null;
        cancellation_min_notice_hours: number | null;
        cancellation_requirement_key: string | null;
        binding_provider_installation_id: string | null;
        binding_capabilities: unknown;
        provider_enabled: boolean | null;
        current_capabilities: unknown;
      }>(
        `SELECT service.id,
                item.product_name,
                service.client_account_id,
                service.status,
                service.billing_cycle,
                service.term_end,
                service.version,
                service.cancellation_request_id,
                service.cancellation_effective_at,
                binding.product_policy_version,
                binding.cycle_end_cancellation_mode_snapshot AS cancellation_mode,
                binding.cycle_end_cancellation_execution_mode_snapshot
                  AS cancellation_execution_mode,
                binding.cycle_end_cancellation_min_notice_hours_snapshot
                  AS cancellation_min_notice_hours,
                binding.cycle_end_cancellation_requirement_key_snapshot
                  AS cancellation_requirement_key,
                binding.provider_installation_id AS binding_provider_installation_id,
                binding.capability_snapshot AS binding_capabilities,
                provider.enabled AS provider_enabled,
                provider.capabilities AS current_capabilities
         FROM services service
         JOIN order_items item ON item.id = service.order_item_id
         LEFT JOIN service_provider_bindings binding ON binding.service_id = service.id
         LEFT JOIN provider_installation_capabilities provider
           ON provider.provider_installation_id = binding.provider_installation_id
         WHERE service.id = $1 AND service.client_account_id = $2
         FOR UPDATE OF service`,
        [params.serviceId, user.clientAccountId],
      );
      const service = serviceResult.rows[0];
      if (!service) {
        throw requestError("Service not found", 404, "SERVICE_NOT_FOUND");
      }
      const accountContext = await lockMembershipAccountForMutation(
        client,
        user,
        sessionContext,
      );
      assertCancellationContextLocked(accountContext);
      if (service.version !== body.expectedVersion) {
        throw requestError(
          "Service changed; refresh the page and confirm cancellation again",
          409,
          "VERSION_CONFLICT",
        );
      }
      if (service.cancellation_request_id || service.cancellation_effective_at) {
        throw requestError(
          "Cancellation is already scheduled for this service",
          409,
          "CANCELLATION_ALREADY_SCHEDULED",
        );
      }
      if (
        (service.status !== "active" && service.status !== "suspended") ||
        service.billing_cycle === "one_time" ||
        !service.term_end ||
        service.term_end.getTime() <= Date.now()
      ) {
        throw requestError(
          "Only an active or suspended recurring service with a paid-through date can be cancelled at period end",
          409,
          "CANCELLATION_NOT_ALLOWED",
        );
      }
      if (service.cancellation_mode === "authenticated_ticket") {
        throw requestError(
          "This service requires a qualified authenticated Client Account termination ticket before cycle-end cancellation can be scheduled",
          409,
          "CANCELLATION_TICKET_GATE_UNAVAILABLE",
        );
      }
      if (service.cancellation_mode !== "self_service" || !service.product_policy_version) {
        throw requestError(
          "This product does not currently allow customer self-service cancellation",
          409,
          "CANCELLATION_POLICY_REVIEW_REQUIRED",
        );
      }
      const requestedAt = new Date();
      const minimumNoticeHours = service.cancellation_min_notice_hours ?? 0;
      if (
        requestedAt.getTime() >
        service.term_end.getTime() - minimumNoticeHours * 60 * 60 * 1_000
      ) {
        throw requestError(
          "The configured cancellation notice period was not met",
          409,
          "CANCELLATION_LEAD_TIME_NOT_MET",
        );
      }

      const renewalState = await client.query<{
        renewal_id: string;
        invoice_id: string;
        renewal_status: "invoiced" | "manual_hold";
        period_start: Date;
        recurring_minor: string;
        currency: string;
        invoice_total_minor: string;
        invoice_line_total_minor: string;
        recurring_lines_only: boolean;
        payment_allocated: boolean;
        credit_allocated: boolean;
        fund_allocated: boolean;
        unresolved_payment: boolean;
        payment_history: boolean;
        payment_command_history: boolean;
        fee_history: boolean;
        delinquency_history: boolean;
        service_period_exists: boolean;
        hold_resolution_exists: boolean;
      }>(
        `SELECT
           renewal.id AS renewal_id,
           renewal.invoice_id,
           renewal.status AS renewal_status,
           renewal.period_start,
           renewal.recurring_minor::text,
           renewal.currency,
           invoice.total_minor::text AS invoice_total_minor,
           COALESCE((
             SELECT sum(line.amount_minor) FROM invoice_lines line
             WHERE line.invoice_id = invoice.id
           ), 0)::text AS invoice_line_total_minor,
           COALESCE((
             SELECT bool_and(line.kind = 'recurring') FROM invoice_lines line
             WHERE line.invoice_id = invoice.id
           ), false) AS recurring_lines_only,
           EXISTS (
             SELECT 1 FROM payment_allocations allocation
             WHERE allocation.invoice_id = invoice.id
           ) AS payment_allocated,
           EXISTS (
             SELECT 1 FROM credit_allocations allocation
             WHERE allocation.invoice_id = invoice.id
           ) AS credit_allocated,
           EXISTS (
             SELECT 1 FROM fund_receipt_allocations allocation
             WHERE allocation.invoice_id = invoice.id
           ) AS fund_allocated,
           EXISTS (
             SELECT 1 FROM payment_attempts attempt
             WHERE attempt.invoice_id = invoice.id
               AND attempt.status IN ('created', 'processing', 'unknown')
           ) AS unresolved_payment,
           EXISTS (
             SELECT 1 FROM payment_attempts attempt
             WHERE attempt.invoice_id = invoice.id
           ) AS payment_history,
           EXISTS (
             SELECT 1 FROM invoice_payment_commands command
             WHERE command.invoice_id = invoice.id
           ) AS payment_command_history,
           EXISTS (
             SELECT 1 FROM invoice_fee_charges charge
             WHERE charge.invoice_id = invoice.id
           ) AS fee_history,
           (
             EXISTS (
               SELECT 1 FROM invoice_late_fee_assessments assessment
               WHERE assessment.invoice_id = invoice.id
             ) OR EXISTS (
               SELECT 1 FROM invoice_delinquency_deferrals deferral
               WHERE deferral.invoice_id = invoice.id
             ) OR EXISTS (
               SELECT 1 FROM service_suspension_cases suspension_case
               WHERE suspension_case.invoice_id = invoice.id
             )
           ) AS delinquency_history,
           EXISTS (
             SELECT 1 FROM service_periods period
             WHERE period.invoice_id = invoice.id
           ) AS service_period_exists,
           EXISTS (
             SELECT 1 FROM service_renewal_hold_resolutions resolution
             WHERE resolution.renewal_id = renewal.id
           ) AS hold_resolution_exists
         FROM service_renewals renewal
         JOIN invoices invoice ON invoice.id = renewal.invoice_id
         WHERE renewal.service_id = $1
           AND renewal.status IN ('invoiced', 'manual_hold')
         ORDER BY renewal.invoice_id
         FOR UPDATE OF renewal`,
        [service.id],
      );
      const preflightIds = renewalPreflight.rows.map((row) => row.renewal_id).sort();
      const lockedIds = renewalState.rows.map((row) => row.renewal_id).sort();
      if (
        preflightIds.length !== lockedIds.length ||
        preflightIds.some((renewalId, index) => renewalId !== lockedIds[index])
      ) {
        throw new RetryCancellationTransaction(
          "Renewal invoice appeared while cancellation locks were being acquired",
        );
      }
      if ((renewalState.rowCount ?? 0) > 1) {
        throw requestError(
          "Multiple unsettled renewals require staff review",
          409,
          "RENEWAL_FINANCIAL_FACTS_REQUIRE_REVIEW",
        );
      }
      const renewal = renewalState.rows[0];
      let pristineRenewal: PristineRenewal | null = null;
      if (renewal) {
        if (renewal.renewal_status === "manual_hold" || renewal.hold_resolution_exists) {
          throw requestError(
            "The renewal is on a staff hold and cannot be withdrawn automatically",
            409,
            "RENEWAL_HOLD_REQUIRES_STAFF",
          );
        }
        if (renewal.unresolved_payment) {
          throw requestError(
            "A renewal payment result is unknown; reconcile it before cancellation",
            409,
            "PAYMENT_RESULT_UNKNOWN",
          );
        }
        if (renewal.payment_history || renewal.payment_command_history) {
          throw requestError(
            "The renewal has payment history and requires staff review",
            409,
            "RENEWAL_PAYMENT_HISTORY_REQUIRES_REVIEW",
          );
        }
        if (renewal.delinquency_history) {
          throw requestError(
            "The renewal has delinquency actions and requires staff review",
            409,
            "RENEWAL_DELINQUENCY_REQUIRES_REVIEW",
          );
        }
        if (
          renewal.payment_allocated ||
          renewal.credit_allocated ||
          renewal.fund_allocated ||
          renewal.fee_history ||
          renewal.service_period_exists ||
          renewal.period_start.getTime() !== service.term_end.getTime() ||
          renewal.invoice_total_minor !== renewal.recurring_minor ||
          renewal.invoice_line_total_minor !== renewal.recurring_minor ||
          !renewal.recurring_lines_only
        ) {
          throw requestError(
            "The renewal has financial facts that cannot be withdrawn automatically",
            409,
            "RENEWAL_FINANCIAL_FACTS_REQUIRE_REVIEW",
          );
        }
        pristineRenewal = {
          renewalId: renewal.renewal_id,
          invoiceId: renewal.invoice_id,
          amountMinor: renewal.recurring_minor,
          currency: renewal.currency,
        };
      }

      const requestId = randomUUID();
      const executionId = randomUUID();
      const nextVersion = service.version + 1;
      const bindingCapabilities = Array.isArray(service.binding_capabilities)
        ? service.binding_capabilities.filter(
            (capability): capability is string => typeof capability === "string",
          )
        : [];
      const currentCapabilities = Array.isArray(service.current_capabilities)
        ? service.current_capabilities.filter(
            (capability): capability is string => typeof capability === "string",
          )
        : [];
      const automatic =
        service.cancellation_execution_mode === "automatic" &&
        Boolean(service.binding_provider_installation_id) &&
        bindingCapabilities.includes("resource_terminate") &&
        service.provider_enabled === true &&
        currentCapabilities.includes("resource_terminate");
      const executionMode = automatic ? "automatic" : "manual";
      const providerOperationId = automatic ? randomUUID() : null;
      const stableKey = `service-cancellation:${requestId}:terminate`;
      const result: CancellationResult = {
        cancellation: {
          requestId,
          status: "scheduled",
          executionMode,
          executionStatus: "scheduled",
          effectiveAt: service.term_end.toISOString(),
          requestedAt: requestedAt.toISOString(),
        },
        serviceVersion: nextVersion,
      };
      await client.query(
        `INSERT INTO service_cancellation_requests(
           id, service_id, client_account_id, requested_by_user_id,
           requested_session_id, effective_at, expected_service_version,
           product_policy_version, policy_snapshot, notice_qualified_at,
           authorization_ticket_id, reason, idempotency_key,
           request_fingerprint, result, created_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           (SELECT term_end FROM services WHERE id = $2),
           $6, $7, $8, $9,
           NULL, $10, $11, $12, $13, $14
         )`,
        [
          requestId,
          service.id,
          service.client_account_id,
          user.userId,
          user.sessionId,
          service.version,
          service.product_policy_version,
          {
            schedulingMode: service.cancellation_mode,
            executionMode: service.cancellation_execution_mode,
            minimumNoticeHours,
            requirementKey: service.cancellation_requirement_key,
          },
          requestedAt,
          body.reason ?? null,
          body.idempotencyKey,
          fingerprint,
          result,
          requestedAt,
        ],
      );
      const updated = await client.query(
        `UPDATE services
         SET cancellation_request_id = $2,
             cancellation_scheduled_at = $3,
             cancellation_effective_at = term_end,
             version = version + 1,
             updated_at = now()
         WHERE id = $1 AND version = $4`,
        [service.id, requestId, requestedAt, service.version],
      );
      if (updated.rowCount !== 1) {
        throw requestError(
          "Service changed; refresh the page and confirm cancellation again",
          409,
          "VERSION_CONFLICT",
        );
      }
      let renewalCancellation:
        | { renewalId: string; invoiceId: string; reversalJournalId: string }
        | null = null;
      if (pristineRenewal) {
        const renewalCancellationId = randomUUID();
        const reversalJournal = await client.query<{ id: string }>(
          `INSERT INTO ledger_journals(
             source_type, source_id, currency, description
           ) VALUES (
             'service_renewal_cancellation', $1, $2,
             'Pristine renewal invoice withdrawn for cycle-end cancellation'
           )
           RETURNING id`,
          [renewalCancellationId, pristineRenewal.currency],
        );
        const reversalJournalId = reversalJournal.rows[0]?.id;
        if (!reversalJournalId) throw new Error("Unable to record renewal reversal journal");
        await client.query(
          `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
           VALUES
             ($1, 'deferred_service_revenue', $2, 0),
             ($1, 'accounts_receivable', 0, $2)`,
          [reversalJournalId, pristineRenewal.amountMinor],
        );
        await client.query(
          "UPDATE ledger_journals SET sealed_at = now() WHERE id = $1 AND sealed_at IS NULL",
          [reversalJournalId],
        );
        await client.query(
          `INSERT INTO service_renewal_cancellations(
             id, cancellation_request_id, renewal_id, invoice_id,
             reversal_journal_id, amount_minor, currency, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            renewalCancellationId,
            requestId,
            pristineRenewal.renewalId,
            pristineRenewal.invoiceId,
            reversalJournalId,
            pristineRenewal.amountMinor,
            pristineRenewal.currency,
            requestedAt,
          ],
        );
        const cancelledRenewal = await client.query(
          `UPDATE service_renewals
           SET status = 'cancelled', updated_at = now(), version = version + 1
           WHERE id = $1 AND status = 'invoiced'
             AND funded_at IS NULL AND settled_at IS NULL`,
          [pristineRenewal.renewalId],
        );
        if (cancelledRenewal.rowCount !== 1) {
          throw new RetryCancellationTransaction(
            "Renewal changed while its cancellation was being recorded",
          );
        }
        await client.query(
          `INSERT INTO renewal_reminder_suppressions(intent_id, reason)
           SELECT reminder.id, 'renewal invoice was withdrawn for cycle-end cancellation'
           FROM renewal_reminder_intents reminder
           WHERE reminder.invoice_id = $1
             AND NOT EXISTS (
               SELECT 1 FROM renewal_reminder_delivery_facts delivery
               WHERE delivery.intent_id = reminder.id
                 AND delivery.status IN ('delivered', 'bounced')
             )
           ON CONFLICT (intent_id) DO NOTHING`,
          [pristineRenewal.invoiceId],
        );
        await client.query(
          `INSERT INTO renewal_notification_dispatch_suppressions(intent_id, reason)
           SELECT reminder.id,
                  'renewal invoice was withdrawn for cycle-end cancellation'
           FROM renewal_reminder_intents reminder
           WHERE reminder.invoice_id = $1
           ON CONFLICT (intent_id) DO NOTHING`,
          [pristineRenewal.invoiceId],
        );
        renewalCancellation = {
          renewalId: pristineRenewal.renewalId,
          invoiceId: pristineRenewal.invoiceId,
          reversalJournalId,
        };
      }
      await client.query(
        `INSERT INTO service_cancellation_executions(
           id, cancellation_request_id, service_id, execution_mode,
           provider_installation_id, provider_capability_snapshot,
           status, result, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'scheduled', $7, $8, $8)`,
        [
          executionId,
          requestId,
          service.id,
          executionMode,
          automatic ? service.binding_provider_installation_id : null,
          { atBinding: bindingCapabilities, current: currentCapabilities },
          { status: "scheduled" },
          requestedAt,
        ],
      );
      if (automatic) {
        await client.query(
          `INSERT INTO provider_operations(
             id, provider_installation_id, kind, subject_type, subject_id,
             stable_key, status
           ) VALUES (
             $1, $2, 'resource_terminate', 'service_cancellation_execution', $3,
             $4, 'queued'
           )`,
          [
            providerOperationId,
            service.binding_provider_installation_id,
            executionId,
            stableKey,
          ],
        );
      }
      await client.query(
        `INSERT INTO durable_jobs(job_type, unique_key, payload, available_at)
         VALUES (
           'service.cancellation.due', $1, $2,
           (SELECT effective_at FROM service_cancellation_requests WHERE id = $3)
         )`,
        [
          stableKey,
          {
            cancellationRequestId: requestId,
            executionId,
            serviceId: service.id,
            ...(providerOperationId ? { providerOperationId } : {}),
          },
          requestId,
        ],
      );
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, reason, metadata
         ) VALUES ('user', $1, 'service.cancellation_scheduled', 'service', $2, $3, $4)`,
        [
          user.userId,
          service.id,
          body.reason ?? "Customer scheduled cancellation at paid period end",
          {
            cancellationRequestId: requestId,
            effectiveAt: service.term_end.toISOString(),
            previousServiceVersion: service.version,
            serviceVersion: nextVersion,
            executionId,
            executionMode,
            providerOperationId,
            renewalCancellation,
          },
        ],
      );
      const notificationPayload = {
        cancellationRequestId: requestId,
        serviceId: service.id,
        productName: service.product_name,
        effectiveAt: service.term_end.toISOString(),
        executionMode,
      } as const;
      await enqueueNotification(client, {
        eventType: "notification.service_cancellation_scheduled",
        uniqueKey: `service-cancellation:${requestId}`,
        payload: notificationPayload,
        recipient: {
          kind: "account_user",
          category: "service",
          userId: user.userId,
          clientAccountId: user.clientAccountId,
          email: user.email,
          locale: user.locale === "zh-CN" ? "zh-CN" : "en",
        },
      });
      await enqueueSubscribedContactNotifications(client, {
        eventType: "notification.service_cancellation_scheduled",
        uniqueKeyPrefix: `service-cancellation:${requestId}`,
        payload: notificationPayload,
        clientAccountId: user.clientAccountId,
        category: "service",
        excludeEmails: [user.email],
      });
      return { ...result, replayed: false };
        });
        break;
      } catch (error) {
        if (error instanceof RetryCancellationTransaction && transactionAttempt < 2) {
          continue;
        }
        if (error instanceof RetryCancellationTransaction) {
          throw requestError(
            "Renewal activity is still changing; refresh and confirm cancellation again",
            409,
            "VERSION_CONFLICT",
          );
        }
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "P0001" &&
          "message" in error &&
          typeof error.message === "string" &&
          error.message.includes(
            "cycle-end cancellation request is not eligible for this service and session",
          )
        ) {
          throw requestError(
            "Service or account eligibility changed while cancellation was being scheduled",
            409,
            "CANCELLATION_STATE_CONFLICT",
          );
        }
        throw error;
      }
    }
    if (!outcome) throw new Error("Cancellation transaction produced no result");

    return reply.code(outcome.replayed ? 200 : 201).send(outcome);
  });

  app.get("/api/v1/admin/services/cancellations", async (request) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "services.manual_fulfillment");
    const result = await pool.query<{
      request_id: string;
      execution_id: string;
      service_id: string;
      service_status: string;
      client_account_name: string;
      product_name: string;
      effective_at: Date;
      execution_mode: "automatic" | "manual";
      execution_status: "scheduled" | "processing" | "unknown" | "manual" | "terminated";
      execution_version: number;
      service_version: number;
      execution_result: Record<string, unknown>;
      last_error: string | null;
      provider_operation_status: string | null;
      provider_attempt_count: number | null;
      job_status: string;
      job_last_error: string | null;
    }>(
      `SELECT cancellation_request.id AS request_id,
              execution.id AS execution_id,
              service.id AS service_id,
              service.status AS service_status,
              account.name AS client_account_name,
              item.product_name,
              cancellation_request.effective_at,
              execution.execution_mode,
              execution.status AS execution_status,
              execution.version AS execution_version,
              service.version AS service_version,
              execution.result AS execution_result,
              execution.last_error,
              operation.status AS provider_operation_status,
              operation.attempt_count AS provider_attempt_count,
              job.status AS job_status,
              job.last_error AS job_last_error
       FROM service_cancellation_requests cancellation_request
       JOIN service_cancellation_executions execution
         ON execution.cancellation_request_id = cancellation_request.id
       JOIN services service ON service.id = cancellation_request.service_id
       JOIN client_accounts account ON account.id = service.client_account_id
       JOIN order_items item ON item.id = service.order_item_id
       JOIN durable_jobs job
         ON job.job_type = 'service.cancellation.due'
        AND job.unique_key = 'service-cancellation:' || cancellation_request.id::text || ':terminate'
       LEFT JOIN provider_operations operation
         ON operation.subject_type = 'service_cancellation_execution'
        AND operation.subject_id = execution.id
        AND operation.kind = 'resource_terminate'
       ORDER BY cancellation_request.effective_at, cancellation_request.created_at`,
    );
    return {
      warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      items: result.rows.map((row) => ({
        requestId: row.request_id,
        executionId: row.execution_id,
        serviceId: row.service_id,
        serviceStatus: row.service_status,
        clientAccountName: row.client_account_name,
        productName: row.product_name,
        effectiveAt: row.effective_at.toISOString(),
        executionMode: row.execution_mode,
        executionStatus: row.execution_status,
        executionVersion: row.execution_version,
        serviceVersion: row.service_version,
        result: row.execution_result,
        lastError: row.last_error,
        providerOperation: row.provider_operation_status
          ? {
              status: row.provider_operation_status,
              attempts: row.provider_attempt_count ?? 0,
            }
          : null,
        job: { status: row.job_status, lastError: row.job_last_error },
        interventionRequired: row.execution_status === "manual",
      })),
    };
  });

  app.post(
    "/api/v1/admin/services/cancellations/:executionId/complete-manual",
    async (request, reply) => {
      const user = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, user, "services.manual_fulfillment");
      await requireRecentReauth(pool, user);
      const params = z.object({ executionId: z.uuid() }).parse(request.params);
      const body = completeManualCancellationSchema.parse(request.body);
      const fingerprint = requestFingerprint("services.complete-cycle-end-cancellation:v1", {
        executionId: params.executionId,
        expectedExecutionVersion: body.expectedExecutionVersion,
        expectedServiceVersion: body.expectedServiceVersion,
        reason: body.reason,
      });

      const outcome = await transaction(pool, async (client) => {
        await requireStaffActionLocked(client, user, "services.manual_fulfillment");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `service-cancellation-manual:${user.userId}:${body.idempotencyKey}`,
        ]);
        const replay = await client.query<{
          request_fingerprint: string;
          result: Record<string, unknown>;
        }>(
          `SELECT request_fingerprint, result
           FROM service_cancellation_manual_actions
           WHERE staff_user_id = $1 AND idempotency_key = $2`,
          [user.userId, body.idempotencyKey],
        );
        const previous = replay.rows[0];
        if (previous) {
          if (previous.request_fingerprint !== fingerprint) {
            throw requestError(
              "This idempotency key was already used for another manual cancellation action",
              409,
              "IDEMPOTENCY_CONFLICT",
            );
          }
          await requireStaffActionLocked(client, user, "services.manual_fulfillment");
          return { ...previous.result, replayed: true };
        }

        const pointerResult = await client.query<{
          execution_id: string;
          request_id: string;
          service_id: string;
          client_account_id: string;
          order_item_id: string;
          provider_operation_id: string | null;
        }>(
          `SELECT execution.id AS execution_id,
                  request.id AS request_id,
                  service.id AS service_id,
                  service.client_account_id,
                  service.order_item_id,
                  operation.id AS provider_operation_id
           FROM service_cancellation_executions execution
           JOIN service_cancellation_requests request
             ON request.id = execution.cancellation_request_id
           JOIN services service ON service.id = execution.service_id
           LEFT JOIN provider_operations operation
             ON operation.subject_type = 'service_cancellation_execution'
            AND operation.subject_id = execution.id
            AND operation.kind = 'resource_terminate'
           WHERE execution.id = $1`,
          [params.executionId],
        );
        const pointer = pointerResult.rows[0];
        if (!pointer) {
          throw requestError("Cancellation execution not found", 404, "CANCELLATION_NOT_FOUND");
        }
        // Match every customer mutation's Account -> business-object lock
        // order.  Platform Staff does not need a target Membership, but it
        // must not hold the Service while waiting for its target Account.
        const targetAccount = await client.query(
          "SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE",
          [pointer.client_account_id],
        );
        if (targetAccount.rowCount !== 1) {
          throw requestError("Client account not found", 404, "CLIENT_ACCOUNT_NOT_FOUND");
        }
        await client.query("SELECT id FROM order_items WHERE id = $1 FOR UPDATE", [
          pointer.order_item_id,
        ]);
        await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [
          pointer.service_id,
        ]);
        await client.query(
          "SELECT id FROM service_cancellation_requests WHERE id = $1 FOR UPDATE",
          [pointer.request_id],
        );
        await client.query(
          "SELECT id FROM service_cancellation_executions WHERE id = $1 FOR UPDATE",
          [pointer.execution_id],
        );
        if (pointer.provider_operation_id) {
          await client.query("SELECT id FROM provider_operations WHERE id = $1 FOR UPDATE", [
            pointer.provider_operation_id,
          ]);
        }
        await requireStaffActionLocked(client, user, "services.manual_fulfillment");

        const stateResult = await client.query<{
          execution_mode: "automatic" | "manual";
          execution_status: string;
          execution_version: number;
          effective_at: Date;
          service_status: string;
          service_version: number;
          provider_operation_status: string | null;
          provider_attempt_count: number | null;
        }>(
          `SELECT execution.execution_mode,
                  execution.status AS execution_status,
                  execution.version AS execution_version,
                  request.effective_at,
                  service.status AS service_status,
                  service.version AS service_version,
                  operation.status AS provider_operation_status,
                  operation.attempt_count AS provider_attempt_count
           FROM service_cancellation_executions execution
           JOIN service_cancellation_requests request
             ON request.id = execution.cancellation_request_id
           JOIN services service ON service.id = execution.service_id
           LEFT JOIN provider_operations operation
             ON operation.subject_type = 'service_cancellation_execution'
            AND operation.subject_id = execution.id
            AND operation.kind = 'resource_terminate'
           WHERE execution.id = $1`,
          [params.executionId],
        );
        const state = stateResult.rows[0];
        if (!state) throw new Error("Cancellation execution disappeared while locked");
        if (
          state.execution_version !== body.expectedExecutionVersion ||
          state.service_version !== body.expectedServiceVersion
        ) {
          throw requestError(
            "Cancellation or service state changed; refresh and confirm again",
            409,
            "VERSION_CONFLICT",
          );
        }
        if (
          state.execution_status !== "manual" ||
          state.effective_at.getTime() > Date.now() ||
          !["active", "suspended", "provisioned_hold"].includes(state.service_status)
        ) {
          throw requestError(
            "This cancellation is not ready for manual completion",
            409,
            "MANUAL_COMPLETION_NOT_ALLOWED",
          );
        }
        const takeoverKind =
          state.execution_mode === "manual"
            ? "manual_delivery"
            : "provider_reconciliation_takeover";
        if (
          state.execution_mode === "automatic" &&
          (!state.provider_operation_status ||
            !["unknown", "failed", "succeeded"].includes(state.provider_operation_status) ||
            (state.provider_attempt_count ?? 0) < 1)
        ) {
          throw requestError(
            "Automatic termination has no Provider evidence safe for manual takeover",
            409,
            "PROVIDER_RECONCILIATION_REQUIRED",
          );
        }

        const actionId = randomUUID();
        const completedAt = new Date();
        const result = {
          actionId,
          executionId: params.executionId,
          serviceId: pointer.service_id,
          executionStatus: "terminated",
          serviceStatus: "terminated",
          takeoverKind,
          providerCalled: false,
          completedAt: completedAt.toISOString(),
        };
        await client.query(
          `INSERT INTO service_cancellation_manual_actions(
             id, execution_id, service_id, staff_user_id, staff_session_id,
             staff_client_account_id, takeover_kind, expected_execution_version,
             expected_service_version, reason, idempotency_key,
             request_fingerprint, result, created_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
           )`,
          [
            actionId,
            params.executionId,
            pointer.service_id,
            user.userId,
            user.sessionId,
            pointer.client_account_id,
            takeoverKind,
            body.expectedExecutionVersion,
            body.expectedServiceVersion,
            body.reason,
            body.idempotencyKey,
            fingerprint,
            result,
            completedAt,
          ],
        );
        const serviceUpdate = await client.query(
          `UPDATE services
           SET status = 'terminated', updated_at = $2, version = version + 1
           WHERE id = $1 AND version = $3
             AND status IN ('active', 'suspended', 'provisioned_hold')`,
          [pointer.service_id, completedAt, body.expectedServiceVersion],
        );
        const executionUpdate = await client.query(
          `UPDATE service_cancellation_executions
           SET status = 'terminated', result = $2, last_error = NULL,
               completed_at = $3, updated_at = $3, version = version + 1
           WHERE id = $1 AND version = $4 AND status = 'manual'`,
          [params.executionId, result, completedAt, body.expectedExecutionVersion],
        );
        if (serviceUpdate.rowCount !== 1 || executionUpdate.rowCount !== 1) {
          throw requestError(
            "Cancellation or service state changed; refresh and confirm again",
            409,
            "VERSION_CONFLICT",
          );
        }
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, reason, metadata
           ) VALUES (
             'staff', $1, 'service.cancellation_manual_completed',
             'service', $2, $3, $4
           )`,
          [
            user.userId,
            pointer.service_id,
            body.reason,
            {
              actionId,
              executionId: params.executionId,
              takeoverKind,
              providerCalled: false,
              priorProviderOperationStatus: state.provider_operation_status,
              priorProviderAttemptCount: state.provider_attempt_count,
            },
          ],
        );
        return { ...result, replayed: false };
      }).catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "P0001" &&
          "message" in error &&
          typeof error.message === "string" &&
          error.message.includes(
            "manual cancellation completion lacks current authority or eligible state",
          )
        ) {
          throw requestError(
            "Manual cancellation authority or target account state changed; refresh and retry",
            409,
            "MANUAL_COMPLETION_AUTHORITY_CHANGED",
          );
        }
        throw error;
      });
      return reply.code(outcome.replayed ? 200 : 201).send(outcome);
    },
  );
}
