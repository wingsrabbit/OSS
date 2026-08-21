// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assertFinancialReadEligible,
  requireSessionIdentity,
  requireUser,
  type SessionIdentity,
} from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabasePool } from "./database.js";
import { requestFingerprint } from "./idempotency.js";
import { advancePaidInvoice } from "./invoice-settlement.js";
import { assertProviderSignature } from "./provider-signature.js";
import { runRenewalAutomation } from "./renewal-lifecycle.js";
import { projectRenewalReminderStatus } from "./renewal-reminder-status.js";
import {
  requireRecentReauth,
  requireStaffActionLocked,
  requireStaffPermission,
} from "./routes-admin.js";

const LAB_WARNING = "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY";

const suspensionManualActionSchema = z
  .object({
    action: z.enum(["confirm_suspended", "confirm_restored"]),
    reason: z.string().trim().min(10).max(1_000),
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();

async function requireRenewalAdminReadPermission(
  pool: DatabasePool,
  user: SessionIdentity,
): Promise<void> {
  if (user.userRestrictedAt || !user.emailVerifiedAt) {
    throw Object.assign(new Error("Staff account is not eligible"), { statusCode: 403 });
  }
  const result = await pool.query<{ permissions: unknown }>(
    `SELECT permissions
     FROM staff_members
     WHERE user_id = $1 AND active`,
    [user.userId],
  );
  const permissions = result.rows[0]?.permissions;
  if (
    !Array.isArray(permissions) ||
    !permissions.every(
      (permission) =>
        typeof permission === "string" &&
        permission.length > 0 &&
        permission.trim() === permission,
    ) ||
    !permissions.some((permission) =>
      ["*", "billing.automation_manage", "services.suspension_manage"].includes(permission),
    )
  ) {
    throw Object.assign(new Error("Billing or service suspension permission is required"), {
      statusCode: 403,
    });
  }
}

type RenewalListRow = {
  renewal_id: string;
  service_id: string;
  client_account_id: string;
  client_account_name: string;
  product_name: string;
  service_status: string;
  billing_cycle: string;
  term_start: Date;
  term_end: Date;
  invoice_id: string;
  currency: string;
  total_minor: string;
  allocated_minor: string;
  renewal_status: string;
  funded_at: Date | null;
  due_at: Date;
  period_start: Date;
  period_end: Date;
  settled_at: Date | null;
  renewal_version: number;
  reminder_kind: "renewal_created" | "pre_due" | "overdue_first" | null;
  reminder_offset_days: number | null;
  reminder_created_at: Date | null;
  reminder_delivery_status: "delivered" | "bounced" | "failed" | null;
  reminder_provider_occurred_at: Date | null;
  reminder_generic_operation_status: string | null;
  reminder_generic_attempt_number: number | null;
  reminder_generic_fact_status: "delivered" | "bounced" | "failed" | "skipped" | null;
  reminder_generic_recorded_at: Date | null;
  reminder_generic_updated_at: Date | null;
  reminder_suppressed_at: Date | null;
  reminder_job_status: string | null;
  reminder_job_attempts: number | null;
  late_fee_disposition: "charged" | "skipped_zero" | null;
  late_fee_basis_minor: string | null;
  late_fee_basis_points: number | null;
  late_fee_amount_minor: string | null;
  late_fee_business_date: string | null;
  suspension_case_id: string | null;
  suspension_action: "automatic" | "manual" | "none" | null;
  suspension_decision_reason: string | null;
  suspension_status: string | null;
  suspension_resume_required: boolean | null;
  suspension_provider_installation_id: string | null;
  suspension_last_error: string | null;
  suspension_version: number | null;
  suspend_operation_status: string | null;
  suspend_operation_attempts: number | null;
  resume_operation_status: string | null;
  resume_operation_attempts: number | null;
  account_restricted_at: Date | null;
  all_service_renewals_settled: boolean;
  all_service_renewal_periods_granted: boolean;
  suspension_manual_action_count: string;
  latest_suspension_manual_action_at: Date | null;
  pending_payment_result: boolean;
  delinquency_deferral_count: string;
  latest_delinquency_deferral_at: Date | null;
  automatic_payment_status: "processing" | "unknown" | "succeeded" | "failed" | "requires_action" | "blocked" | null;
  automatic_payment_attempt_count: number | null;
  automatic_payment_max_attempts: number | null;
  automatic_payment_last_error: string | null;
};

async function listRenewals(pool: DatabasePool, clientAccountId?: string) {
  const result = await pool.query<RenewalListRow>(
    `SELECT
       renewal.id AS renewal_id,
       service.id AS service_id,
       account.id AS client_account_id,
       account.name AS client_account_name,
       item.product_name,
       service.status AS service_status,
       service.billing_cycle,
       service.term_start,
       service.term_end,
       invoice.id AS invoice_id,
       invoice.currency,
       invoice.total_minor::text,
       allocation.allocated_minor::text,
       renewal.status AS renewal_status,
       renewal.funded_at,
       invoice.due_at,
       renewal.period_start,
       renewal.period_end,
       renewal.settled_at,
       renewal.version AS renewal_version,
       reminder.kind AS reminder_kind,
       reminder.offset_days AS reminder_offset_days,
       reminder.created_at AS reminder_created_at,
       delivery.status AS reminder_delivery_status,
       delivery.provider_occurred_at AS reminder_provider_occurred_at,
       generic_delivery.operation_status AS reminder_generic_operation_status,
       generic_delivery.attempt_number AS reminder_generic_attempt_number,
       generic_delivery.fact_status AS reminder_generic_fact_status,
       generic_delivery.recorded_at AS reminder_generic_recorded_at,
       generic_delivery.updated_at AS reminder_generic_updated_at,
       suppression.created_at AS reminder_suppressed_at,
       job.status AS reminder_job_status,
       job.attempts AS reminder_job_attempts,
       late_fee.disposition AS late_fee_disposition,
       late_fee.basis_minor::text AS late_fee_basis_minor,
       late_fee.basis_points AS late_fee_basis_points,
       late_fee.amount_minor::text AS late_fee_amount_minor,
       late_fee.business_date::text AS late_fee_business_date,
       suspension_case.id AS suspension_case_id,
       suspension_case.action AS suspension_action,
       suspension_case.decision_reason AS suspension_decision_reason,
       suspension_case.status AS suspension_status,
       suspension_case.resume_required AS suspension_resume_required,
       suspension_case.provider_installation_id AS suspension_provider_installation_id,
       suspension_case.last_error AS suspension_last_error,
       suspension_case.version AS suspension_version,
       suspend_operation.status AS suspend_operation_status,
       suspend_operation.attempt_count AS suspend_operation_attempts,
       resume_operation.status AS resume_operation_status,
       resume_operation.attempt_count AS resume_operation_attempts,
       account.restricted_at AS account_restricted_at,
       NOT EXISTS (
         SELECT 1
         FROM service_renewals other_renewal
         JOIN invoices other_invoice ON other_invoice.id = other_renewal.invoice_id
         JOIN invoice_allocation_totals other_allocation
           ON other_allocation.invoice_id = other_invoice.id
         WHERE other_renewal.service_id = service.id
           AND other_renewal.status <> 'cancelled'
           AND other_allocation.allocated_minor < other_invoice.total_minor
       ) AS all_service_renewals_settled,
       NOT EXISTS (
         SELECT 1
         FROM service_renewals other_renewal
         WHERE other_renewal.service_id = service.id
           AND other_renewal.status NOT IN ('paid', 'cancelled')
       ) AS all_service_renewal_periods_granted,
       (SELECT count(*)::text
        FROM service_suspension_manual_actions manual_action
        WHERE manual_action.service_suspension_case_id = suspension_case.id)
         AS suspension_manual_action_count,
       (SELECT max(manual_action.created_at)
        FROM service_suspension_manual_actions manual_action
        WHERE manual_action.service_suspension_case_id = suspension_case.id)
         AS latest_suspension_manual_action_at,
       EXISTS (
         SELECT 1
         FROM payment_attempts attempt
         WHERE attempt.invoice_id = invoice.id
           AND attempt.status IN ('created', 'processing', 'unknown')
       ) AS pending_payment_result,
       (SELECT count(*)::text
        FROM invoice_delinquency_deferrals deferral
        WHERE deferral.invoice_id = invoice.id) AS delinquency_deferral_count,
       (SELECT max(deferral.created_at)
        FROM invoice_delinquency_deferrals deferral
        WHERE deferral.invoice_id = invoice.id) AS latest_delinquency_deferral_at,
       automatic_run.status AS automatic_payment_status,
       automatic_run.attempt_count AS automatic_payment_attempt_count,
       automatic_run.max_attempts AS automatic_payment_max_attempts,
       automatic_run.last_error AS automatic_payment_last_error
     FROM service_renewals renewal
     JOIN services service ON service.id = renewal.service_id
     JOIN order_items item ON item.id = service.order_item_id
     JOIN client_accounts account ON account.id = service.client_account_id
     JOIN invoices invoice ON invoice.id = renewal.invoice_id
     JOIN invoice_allocation_totals allocation ON allocation.invoice_id = invoice.id
     LEFT JOIN renewal_reminder_intents reminder ON reminder.invoice_id = invoice.id
     LEFT JOIN outbox ON outbox.id = reminder.outbox_id
     LEFT JOIN LATERAL (
       SELECT fact.status, fact.provider_occurred_at
       FROM renewal_reminder_delivery_facts fact
       WHERE fact.intent_id = reminder.id
       ORDER BY fact.attempt_number DESC
       LIMIT 1
     ) delivery ON true
     LEFT JOIN LATERAL (
       SELECT operation.status AS operation_status,
              operation.attempt_number,
              fact.status AS fact_status,
              fact.recorded_at,
              operation.updated_at
       FROM notification_delivery_operations operation
       LEFT JOIN notification_delivery_facts fact
         ON fact.outbox_id = operation.outbox_id
        AND fact.attempt_number = operation.attempt_number
        AND fact.provider_operation_id = operation.provider_operation_id
       WHERE operation.outbox_id = reminder.outbox_id
         AND operation.recipient_kind = 'account_user'
         AND operation.category = 'billing'
       ORDER BY operation.attempt_number DESC
       LIMIT 1
     ) generic_delivery ON true
     LEFT JOIN renewal_reminder_suppressions suppression ON suppression.intent_id = reminder.id
     LEFT JOIN durable_jobs job
       ON job.job_type = 'notification.send'
      AND job.unique_key = 'outbox:' || outbox.id::text
     LEFT JOIN invoice_late_fee_assessments late_fee
       ON late_fee.invoice_id = invoice.id
     LEFT JOIN service_suspension_cases suspension_case
       ON suspension_case.service_renewal_id = renewal.id
     LEFT JOIN provider_operations suspend_operation
       ON suspend_operation.subject_type = 'service_suspension_case'
      AND suspend_operation.subject_id = suspension_case.id
      AND suspend_operation.kind = 'resource_suspend'
     LEFT JOIN provider_operations resume_operation
       ON resume_operation.subject_type = 'service_suspension_case'
      AND resume_operation.subject_id = suspension_case.id
      AND resume_operation.kind = 'resource_resume'
     LEFT JOIN automatic_renewal_runs automatic_run
       ON automatic_run.service_renewal_id = renewal.id
     WHERE ($1::uuid IS NULL OR account.id = $1::uuid)
     ORDER BY renewal.created_at DESC, renewal.id, reminder.created_at, reminder.id`,
    [clientAccountId ?? null],
  );
  const items = new Map<
    string,
    {
      renewalId: string;
      serviceId: string;
      clientAccountId: string;
      clientAccountName: string;
      productName: string;
      serviceStatus: string;
      billingCycle: string;
      termStart: string;
      termEnd: string;
      invoiceId: string;
      currency: string;
      totalMinor: string;
      allocatedMinor: string;
      dueMinor: string;
      status: "open" | "partially_paid" | "paid" | "cancelled";
      fundingStatus: "open" | "partially_paid" | "paid" | "cancelled";
      renewalStatus: "invoiced" | "paid" | "manual_hold" | "cancelled";
      fundedAt: string | null;
      dueAt: string;
      periodStart: string;
      periodEnd: string;
      settledAt: string | null;
      version: number;
      reminders: Array<{
        kind: "renewal_created" | "pre_due" | "overdue_first";
        offsetDays: number;
        status:
          | "queued"
          | "delivered"
          | "bounced"
          | "failed"
          | "skipped"
          | "suppressed"
          | "retrying"
          | "manual";
        createdAt: string;
        deliveredAt: string | null;
        outcomeAt: string | null;
      }>;
      lateFee: {
        disposition: "charged" | "skipped_zero";
        basisMinor: string;
        basisPoints: number;
        amountMinor: string;
        businessDate: string;
      } | null;
      delinquency: {
        caseId: string;
        action: "automatic" | "manual" | "none";
        decisionReason: string;
        status: string;
        resumeRequired: boolean;
        providerInstallationId: string | null;
        lastError: string | null;
        version: number;
        suspendOperation: { status: string; attempts: number } | null;
        resumeOperation: { status: string; attempts: number } | null;
        manualControl: {
          allowedActions: Array<"confirm_suspended" | "confirm_restored">;
          requiresReauthentication: true;
          actionCount: string;
          latestActionAt: string | null;
          blockedReason: string | null;
          impact: {
            confirmSuspended: string;
            confirmRestored: string;
          };
        } | null;
      } | null;
      paymentReconciliationHold: {
        active: boolean;
        deferralCount: string;
        latestDeferredAt: string | null;
      };
      automaticPayment: {
        status: "processing" | "unknown" | "succeeded" | "failed" | "requires_action" | "blocked";
        attemptCount: number;
        maxAttempts: number;
        lastError: string | null;
        customerActionRequired: boolean;
      } | null;
    }
  >();
  for (const row of result.rows) {
    let item = items.get(row.renewal_id);
    if (!item) {
      const total = BigInt(row.total_minor);
      const allocated = BigInt(row.allocated_minor);
      const due =
        row.renewal_status === "cancelled"
          ? 0n
          : total > allocated
            ? total - allocated
            : 0n;
      const providerOutcomeIsManualTakeoverSafe = (status: string | null, attempts: number | null) =>
        Boolean(
          status &&
            ["unknown", "succeeded", "failed"].includes(status) &&
            (attempts ?? 0) > 0,
        );
      const automaticSuspendTakeover =
        row.suspension_action === "automatic" &&
        row.suspension_status === "manual" &&
        providerOutcomeIsManualTakeoverSafe(
          row.suspend_operation_status,
          row.suspend_operation_attempts,
        );
      const automaticRestoreTakeover =
        row.suspension_action === "automatic" &&
        row.suspension_status === "manual" &&
        (providerOutcomeIsManualTakeoverSafe(
          row.resume_operation_status,
          row.resume_operation_attempts,
        ) ||
          providerOutcomeIsManualTakeoverSafe(
            row.suspend_operation_status,
            row.suspend_operation_attempts,
          ));
      const automaticProvisionedHoldRestore =
        row.suspension_action === "automatic" &&
        row.suspension_status === "manual" &&
        row.service_status === "provisioned_hold" &&
        row.resume_operation_status === "succeeded" &&
        providerOutcomeIsManualTakeoverSafe(
          row.resume_operation_status,
          row.resume_operation_attempts,
        );
      const allowedManualActions: Array<"confirm_suspended" | "confirm_restored"> = [];
      if (
        (row.suspension_action === "manual" || automaticSuspendTakeover) &&
        row.suspension_status === "manual" &&
        row.service_status === "active" &&
        due > 0n
      ) {
        allowedManualActions.push("confirm_suspended");
      }
      if (
        (
          (
            row.suspension_action === "manual" &&
            row.suspension_status === "suspended" &&
            row.service_status === "suspended"
          ) ||
          (
            automaticRestoreTakeover && row.service_status === "suspended"
          ) ||
          (
            automaticProvisionedHoldRestore
          )
        ) &&
        row.all_service_renewals_settled &&
        row.all_service_renewal_periods_granted &&
        !row.account_restricted_at
      ) {
        allowedManualActions.push("confirm_restored");
      }
      const exposesManualControl =
        row.suspension_action === "manual" ||
        (row.suspension_action === "automatic" && row.suspension_status === "manual");
      const manualBlockedReason = !exposesManualControl
        ? null
        : allowedManualActions.length > 0
          ? null
          : row.account_restricted_at
            ? "Client Account is restricted; manual restoration is blocked."
            : row.suspension_status === "suspended" && !row.all_service_renewals_settled
              ? "At least one renewal invoice for this service is still unpaid."
              : row.suspension_status === "suspended" &&
                  !row.all_service_renewal_periods_granted
                ? "A funded renewal still needs its exact service period granted."
              : "The current service and delinquency states do not allow a manual transition.";
      const fundingStatus =
        row.renewal_status === "cancelled"
          ? "cancelled"
          : allocated === 0n
            ? "open"
            : allocated < total
              ? "partially_paid"
              : "paid";
      item = {
        renewalId: row.renewal_id,
        serviceId: row.service_id,
        clientAccountId: row.client_account_id,
        clientAccountName: row.client_account_name,
        productName: row.product_name,
        serviceStatus: row.service_status,
        billingCycle: row.billing_cycle,
        termStart: row.term_start.toISOString(),
        termEnd: row.term_end.toISOString(),
        invoiceId: row.invoice_id,
        currency: row.currency,
        totalMinor: total.toString(),
        allocatedMinor: allocated.toString(),
        dueMinor: due.toString(),
        status: fundingStatus,
        fundingStatus,
        renewalStatus: row.renewal_status as
          | "invoiced"
          | "paid"
          | "manual_hold"
          | "cancelled",
        fundedAt: row.funded_at?.toISOString() ?? null,
        dueAt: row.due_at.toISOString(),
        periodStart: row.period_start.toISOString(),
        periodEnd: row.period_end.toISOString(),
        settledAt: row.settled_at?.toISOString() ?? null,
        version: row.renewal_version,
        reminders: [],
        lateFee:
          row.late_fee_disposition &&
          row.late_fee_basis_minor !== null &&
          row.late_fee_basis_points !== null &&
          row.late_fee_amount_minor !== null &&
          row.late_fee_business_date
            ? {
                disposition: row.late_fee_disposition,
                basisMinor: row.late_fee_basis_minor,
                basisPoints: row.late_fee_basis_points,
                amountMinor: row.late_fee_amount_minor,
                businessDate: row.late_fee_business_date,
              }
            : null,
        delinquency:
          row.suspension_case_id &&
          row.suspension_action &&
          row.suspension_decision_reason &&
          row.suspension_status &&
          row.suspension_version !== null
            ? {
                caseId: row.suspension_case_id,
                action: row.suspension_action,
                decisionReason: row.suspension_decision_reason,
                status: row.suspension_status,
                resumeRequired: row.suspension_resume_required ?? false,
                providerInstallationId: row.suspension_provider_installation_id,
                lastError: row.suspension_last_error,
                version: row.suspension_version,
                suspendOperation: row.suspend_operation_status
                  ? {
                      status: row.suspend_operation_status,
                      attempts: row.suspend_operation_attempts ?? 0,
                    }
                  : null,
                resumeOperation: row.resume_operation_status
                  ? {
                      status: row.resume_operation_status,
                      attempts: row.resume_operation_attempts ?? 0,
                    }
                  : null,
                manualControl:
                  exposesManualControl
                    ? {
                        allowedActions: allowedManualActions,
                        requiresReauthentication: true,
                        actionCount: row.suspension_manual_action_count,
                        latestActionAt:
                          row.latest_suspension_manual_action_at?.toISOString() ?? null,
                        blockedReason: manualBlockedReason,
                        impact: {
                          confirmSuspended:
                            "Immediately mark this active Core service suspended for its unpaid renewal. Automatic takeovers require a prior terminal or unknown Provider operation fact. No Provider request is sent.",
                          confirmRestored:
                            "Restore a suspended service, or an automatic Provider-resumed eligibility Hold, only after every renewal invoice and period is settled and the Client Account is unrestricted. Automatic takeovers retain the prior Provider operation evidence. No Provider request is sent.",
                        },
                      }
                    : null,
              }
            : null,
        paymentReconciliationHold: {
          active: row.pending_payment_result,
          deferralCount: row.delinquency_deferral_count,
          latestDeferredAt: row.latest_delinquency_deferral_at?.toISOString() ?? null,
        },
        automaticPayment: row.automatic_payment_status
          ? {
              status: row.automatic_payment_status,
              attemptCount: row.automatic_payment_attempt_count ?? 0,
              maxAttempts: row.automatic_payment_max_attempts ?? 1,
              lastError: row.automatic_payment_last_error,
              customerActionRequired: row.automatic_payment_status === "requires_action",
            }
          : null,
      };
      items.set(row.renewal_id, item);
    }
    if (row.reminder_kind && row.reminder_created_at) {
      const reminderProjection = projectRenewalReminderStatus({
        deliveryStatus: row.reminder_delivery_status,
        providerOccurredAt: row.reminder_provider_occurred_at,
        genericOperationStatus: row.reminder_generic_operation_status,
        genericAttemptNumber: row.reminder_generic_attempt_number,
        genericFactStatus: row.reminder_generic_fact_status,
        genericRecordedAt: row.reminder_generic_recorded_at,
        genericUpdatedAt: row.reminder_generic_updated_at,
        suppressedAt: row.reminder_suppressed_at,
        jobStatus: row.reminder_job_status,
        jobAttempts: row.reminder_job_attempts,
      });
      item.reminders.push({
        kind: row.reminder_kind,
        offsetDays: row.reminder_offset_days ?? 0,
        status: reminderProjection.status,
        createdAt: row.reminder_created_at.toISOString(),
        deliveredAt:
          row.reminder_delivery_status === "delivered"
            ? row.reminder_provider_occurred_at?.toISOString() ?? null
            : null,
        outcomeAt: reminderProjection.outcomeAt?.toISOString() ?? null,
      });
    }
  }
  return [...items.values()];
}

export async function registerRenewalRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get("/api/v1/billing/renewals", async (request) => {
    const user = await requireUser(request, pool, config);
    assertFinancialReadEligible(user);
    const items = await listRenewals(pool, user.clientAccountId);
    return {
      warning: LAB_WARNING,
      items: items.map(({ clientAccountId: _id, clientAccountName: _name, ...item }) => item),
    };
  });

  app.get("/api/v1/admin/billing/renewals", async (request) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireRenewalAdminReadPermission(pool, user);
    return { warning: LAB_WARNING, items: await listRenewals(pool) };
  });

  app.post("/api/v1/internal/billing/automation/run", async (request, reply) => {
    const body = z
      .object({
        policyId: z.literal("default"),
        businessDate: z.iso.date(),
        effectiveAt: z.iso.datetime({ offset: true }),
      })
      .strict()
      .parse(request.body);
    assertProviderSignature(request, config.PROVIDER_OPERATION_CAPABILITY_SECRET, body);
    const outcome = await transaction(pool, (client) =>
      runRenewalAutomation(client, {
        requestedByUserId: null,
        reason: "Scheduled Asia/Shanghai billing automation",
        scheduledBusinessDate: body.businessDate,
        effectiveAt: new Date(body.effectiveAt),
      }),
    );
    return reply.code(outcome.replayed ? 200 : 201).send(outcome);
  });

  app.post("/api/v1/admin/billing/automation/run", async (request, reply) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "billing.automation_manage");
    await requireRecentReauth(pool, user);
    const body = z
      .object({
        reason: z.string().trim().min(10).max(1_000),
        idempotencyKey: z.string().min(8).max(128),
        effectiveAt: z.iso.datetime({ offset: true }).optional(),
      })
      .parse(request.body);
    if (body.effectiveAt && !["laboratory", "test"].includes(config.OSS_ENV)) {
      throw Object.assign(new Error("effectiveAt is available only in laboratory or test mode"), {
        statusCode: 400,
        code: "LABORATORY_ONLY",
      });
    }
    const effectiveAt = body.effectiveAt ? new Date(body.effectiveAt) : new Date();
    const fingerprint = requestFingerprint("admin.billing-automation-run:v1", {
      reason: body.reason,
      effectiveAt: body.effectiveAt ?? null,
    });
    const outcome = await transaction(pool, async (client) => {
      await requireStaffActionLocked(client, user, "billing.automation_manage");
      return runRenewalAutomation(client, {
        requestedByUserId: user.userId,
        reason: body.reason,
        idempotencyKey: body.idempotencyKey,
        requestFingerprint: fingerprint,
        effectiveAt,
      });
    });
    return reply.code(outcome.replayed ? 200 : 201).send(outcome);
  });

  app.post(
    "/api/v1/admin/billing/delinquency-cases/:caseId/manual-actions",
    async (request, reply) => {
      const user = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, user, "services.suspension_manage");
      await requireRecentReauth(pool, user);
      const params = z.object({ caseId: z.uuid() }).strict().parse(request.params);
      const body = suspensionManualActionSchema.parse(request.body);
      const fingerprint = requestFingerprint("admin.service-suspension-manual-action:v1", {
        caseId: params.caseId,
        action: body.action,
        reason: body.reason,
        expectedVersion: body.expectedVersion,
      });
      const outcome = await transaction(pool, async (client) => {
        const pointerResult = await client.query<{
          service_id: string;
          service_renewal_id: string;
          invoice_id: string;
          order_item_id: string;
          order_id: string;
          client_account_id: string;
          submitted_by_user_id: string;
          renewal_invoice_ids: string[];
        }>(
          `SELECT suspension_case.service_id,
                  suspension_case.service_renewal_id,
                  suspension_case.invoice_id,
                  service.order_item_id,
                  item.order_id,
                  service.client_account_id,
                  original_order.submitted_by_user_id,
                  ARRAY(
                    SELECT renewal_invoice.id
                    FROM service_renewals service_renewal
                    JOIN invoices renewal_invoice
                      ON renewal_invoice.id = service_renewal.invoice_id
                    WHERE service_renewal.service_id = service.id
                    ORDER BY renewal_invoice.id
                  ) AS renewal_invoice_ids
           FROM service_suspension_cases suspension_case
           JOIN services service ON service.id = suspension_case.service_id
           JOIN order_items item ON item.id = service.order_item_id
           JOIN orders original_order ON original_order.id = item.order_id
           WHERE suspension_case.id = $1`,
          [params.caseId],
        );
        const pointer = pointerResult.rows[0];
        if (!pointer) {
          throw Object.assign(new Error("Manual delinquency case not found"), {
            statusCode: 404,
          });
        }
        await requireStaffActionLocked(
          client,
          user,
          "services.suspension_manage",
          [pointer.submitted_by_user_id],
        );
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `service-suspension-manual-action:${user.userId}:${body.idempotencyKey}`,
        ]);
        const previous = await client.query<{
          request_fingerprint: string;
          result: Record<string, unknown>;
        }>(
          `SELECT request_fingerprint, result
           FROM service_suspension_manual_actions
           WHERE staff_user_id = $1 AND idempotency_key = $2
           FOR UPDATE`,
          [user.userId, body.idempotencyKey],
        );
        const replay = previous.rows[0];
        if (replay) {
          if (replay.request_fingerprint !== fingerprint) {
            throw Object.assign(
              new Error("The idempotency key was used for a different manual service action"),
              { statusCode: 409, code: "IDEMPOTENCY_CONFLICT" },
            );
          }
          return { ...replay.result, replayed: true };
        }

        // Durable jobs are the first mutable ownership boundary. Atomically
        // stop every still-pending job before taking business-row locks, then
        // lock the whole matching job set. A Worker that already claimed one
        // wins; Staff must wait for its result instead of racing a Provider POST.
        const stoppedJobs = await client.query<{ id: string }>(
          `UPDATE durable_jobs job
           SET status = 'manual',
               last_error = 'Staff requested manual service-state takeover; Provider delivery is stopped',
               updated_at = now()
           FROM provider_operations operation
           WHERE job.unique_key LIKE operation.stable_key || '%'
             AND operation.subject_type = 'service_suspension_case'
             AND operation.subject_id = $1
             AND job.status = 'pending'
           RETURNING job.id`,
          [params.caseId],
        );
        const lockedJobs = await client.query<{ id: string; status: string }>(
          `SELECT job.id, job.status
           FROM durable_jobs job
           JOIN provider_operations operation
             ON job.unique_key LIKE operation.stable_key || '%'
           WHERE operation.subject_type = 'service_suspension_case'
             AND operation.subject_id = $1
           ORDER BY job.id
           FOR UPDATE OF job`,
          [params.caseId],
        );
        if (lockedJobs.rows.some((job) => job.status === "running")) {
          throw Object.assign(
            new Error("A Provider job is already running; wait for reconciliation before takeover"),
            { statusCode: 409, code: "PROVIDER_JOB_RUNNING" },
          );
        }

        await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
          pointer.client_account_id,
        ]);
        await client.query(
          `SELECT user_id
           FROM client_memberships
           WHERE client_account_id = $1 AND user_id = $2
           FOR UPDATE`,
          [pointer.client_account_id, pointer.submitted_by_user_id],
        );

        // Invoice is the common financial root used by payment settlement. Lock
        // every renewal invoice for this service before the service/case rows so
        // restoration cannot race another allocation or a new billing period.
        await client.query(
          `SELECT id
           FROM invoices
           WHERE id = ANY($1::uuid[])
           ORDER BY id
           FOR UPDATE`,
          [pointer.renewal_invoice_ids],
        );
        await client.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [pointer.order_id]);
        await client.query("SELECT id FROM order_items WHERE id = $1 FOR UPDATE", [
          pointer.order_item_id,
        ]);
        await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [
          pointer.service_id,
        ]);
        await client.query(
          `SELECT id
           FROM service_renewals
           WHERE service_id = $1
           ORDER BY id
           FOR UPDATE`,
          [pointer.service_id],
        );
        await client.query("SELECT id FROM service_suspension_cases WHERE id = $1 FOR UPDATE", [
          params.caseId,
        ]);
        await client.query(
          `SELECT id
           FROM provider_operations
           WHERE subject_type = 'service_suspension_case' AND subject_id = $1
           ORDER BY id
           FOR UPDATE`,
          [params.caseId],
        );
        const stateResult = await client.query<{
          case_action: "automatic" | "manual" | "none";
          case_status: string;
          case_version: number;
          service_status: string;
          renewal_status: string;
          invoice_total_minor: string;
          invoice_allocated_minor: string;
          account_restricted_at: Date | null;
          has_pending_payment_result: boolean;
          all_service_renewals_settled: boolean;
          all_service_renewal_periods_granted: boolean;
          operation_id: string | null;
          operation_kind: "resource_suspend" | "resource_resume" | null;
          operation_status: string | null;
          operation_attempt_count: number | null;
          operation_last_error: string | null;
          operation_external_reference: string | null;
          operation_provider_occurred_at: Date | null;
          operation_job_status: string | null;
          operation_stable_key: string | null;
          operation_has_running_job: boolean;
        }>(
          `SELECT suspension_case.action AS case_action,
                  suspension_case.status AS case_status,
                  suspension_case.version AS case_version,
                  service.status AS service_status,
                  renewal.status AS renewal_status,
                  invoice.total_minor::text AS invoice_total_minor,
                  allocation.allocated_minor::text AS invoice_allocated_minor,
                  account.restricted_at AS account_restricted_at,
                  EXISTS (
                    SELECT 1
                    FROM payment_attempts attempt
                    WHERE attempt.invoice_id = invoice.id
                      AND attempt.status IN ('created', 'processing', 'unknown')
                  ) AS has_pending_payment_result,
                  NOT EXISTS (
                    SELECT 1
                    FROM service_renewals other_renewal
                    JOIN invoices other_invoice ON other_invoice.id = other_renewal.invoice_id
                    JOIN invoice_allocation_totals other_allocation
                      ON other_allocation.invoice_id = other_invoice.id
                    WHERE other_renewal.service_id = service.id
                      AND other_allocation.allocated_minor < other_invoice.total_minor
                  ) AS all_service_renewals_settled,
                  NOT EXISTS (
                    SELECT 1
                    FROM service_renewals other_renewal
                    WHERE other_renewal.service_id = service.id
                      AND other_renewal.status <> 'paid'
                  ) AS all_service_renewal_periods_granted,
                  operation.id AS operation_id,
                  operation.kind AS operation_kind,
                  operation.status AS operation_status,
                  operation.attempt_count AS operation_attempt_count,
                  operation.last_error AS operation_last_error,
                  operation.external_reference AS operation_external_reference,
                  operation.provider_occurred_at AS operation_provider_occurred_at,
                  operation.job_status AS operation_job_status,
                  operation.stable_key AS operation_stable_key,
                  COALESCE(operation.has_running_job, false) AS operation_has_running_job
           FROM service_suspension_cases suspension_case
           JOIN services service ON service.id = suspension_case.service_id
           JOIN client_accounts account ON account.id = service.client_account_id
           JOIN service_renewals renewal ON renewal.id = suspension_case.service_renewal_id
           JOIN invoices invoice ON invoice.id = suspension_case.invoice_id
           JOIN invoice_allocation_totals allocation ON allocation.invoice_id = invoice.id
           LEFT JOIN LATERAL (
             SELECT provider_operation.*,
                    (
                      SELECT job.status
                      FROM durable_jobs job
                      WHERE job.unique_key LIKE provider_operation.stable_key || '%'
                        AND job.job_type IN (
                          'service.suspend.start', 'service.suspend.reconcile',
                          'service.resume.start', 'service.resume.reconcile'
                        )
                      ORDER BY job.created_at DESC, job.id DESC
                      LIMIT 1
                    ) AS job_status
                    ,EXISTS (
                      SELECT 1
                      FROM durable_jobs running_job
                      WHERE running_job.unique_key LIKE provider_operation.stable_key || '%'
                        AND running_job.status = 'running'
                    ) AS has_running_job
             FROM provider_operations provider_operation
             WHERE provider_operation.subject_type = 'service_suspension_case'
               AND provider_operation.subject_id = suspension_case.id
               AND (
                 provider_operation.kind = CASE
                   WHEN $2 = 'confirm_suspended' THEN 'resource_suspend'
                   ELSE 'resource_resume'
                 END
                 OR ($2 = 'confirm_restored' AND provider_operation.kind = 'resource_suspend')
               )
             ORDER BY
               CASE
                 WHEN provider_operation.kind = CASE
                   WHEN $2 = 'confirm_suspended' THEN 'resource_suspend'
                   ELSE 'resource_resume'
                 END THEN 0
                 ELSE 1
               END,
               provider_operation.created_at DESC,
               provider_operation.id DESC
             LIMIT 1
           ) operation ON true
           WHERE suspension_case.id = $1`,
          [params.caseId, body.action],
        );
        const state = stateResult.rows[0];
        if (!state) throw new Error("Locked delinquency case disappeared");
        if (state.case_version !== body.expectedVersion) {
          throw Object.assign(
            new Error("Delinquency case changed; refresh the impact and confirm again"),
            { statusCode: 409, code: "VERSION_CONFLICT" },
          );
        }
        const providerOperationEvidence = state.operation_id
          ? {
              providerOperationId: state.operation_id,
              kind: state.operation_kind,
              status: state.operation_status,
              attemptCount: state.operation_attempt_count,
              lastError: state.operation_last_error,
              externalReference: state.operation_external_reference,
              providerOccurredAt: state.operation_provider_occurred_at?.toISOString() ?? null,
              jobStatus: state.operation_job_status,
            }
          : null;
        const terminalProviderEvidence = Boolean(
          providerOperationEvidence &&
            providerOperationEvidence.kind &&
            providerOperationEvidence.status &&
            ["unknown", "succeeded", "failed"].includes(providerOperationEvidence.status) &&
            (providerOperationEvidence.attemptCount ?? 0) > 0,
        );
        if (state.case_action === "none") {
          throw Object.assign(new Error("This product policy explicitly disallows suspension"), {
            statusCode: 409,
            code: "MANUAL_ACTION_NOT_ALLOWED",
          });
        }
        if (state.case_action === "manual" && providerOperationEvidence) {
          throw Object.assign(
            new Error("An explicit manual product unexpectedly has Provider operation evidence"),
            { statusCode: 409, code: "PROVIDER_EVIDENCE_CONFLICT" },
          );
        }
        if (
          state.case_action === "automatic" &&
          (!terminalProviderEvidence ||
            state.case_status !== "manual" ||
            state.operation_has_running_job)
        ) {
          throw Object.assign(
            new Error(
              "Automatic takeover requires a terminal or unknown attempted Provider operation and a manual case",
            ),
            { statusCode: 409, code: "PROVIDER_RECONCILIATION_REQUIRED" },
          );
        }
        const stoppedProviderJobCount = stoppedJobs.rowCount ?? 0;
        if (
          state.case_action === "automatic" &&
          body.action === "confirm_suspended" &&
          providerOperationEvidence?.kind !== "resource_suspend"
        ) {
          throw Object.assign(new Error("Manual suspension lacks a prior suspend operation fact"), {
            statusCode: 409,
            code: "PROVIDER_EVIDENCE_CONFLICT",
          });
        }

        const previousCaseStatus = state.case_status;
        const previousServiceStatus = state.service_status;
        let resultingCaseStatus: "suspended" | "resolved";
        let resultingServiceStatus: "suspended" | "active";
        if (body.action === "confirm_suspended") {
          if (
            state.case_status !== "manual" ||
            state.service_status !== "active" ||
            state.renewal_status === "paid" ||
            BigInt(state.invoice_allocated_minor) >= BigInt(state.invoice_total_minor) ||
            state.has_pending_payment_result
          ) {
            throw Object.assign(
              new Error(
                state.has_pending_payment_result
                  ? "A payment result is still being reconciled; manual suspension is blocked"
                  : "The manual case no longer has an active service with an unpaid renewal",
              ),
              { statusCode: 409, code: "MANUAL_SUSPENSION_BLOCKED" },
            );
          }
          const suspendedService = await client.query(
            `UPDATE services
             SET status = 'suspended', updated_at = now(), version = version + 1
             WHERE id = $1 AND status = 'active'
             RETURNING id`,
            [pointer.service_id],
          );
          const suspendedCase = await client.query(
            `UPDATE service_suspension_cases
             SET status = 'suspended', resume_required = false,
                 updated_at = now(), version = version + 1
             WHERE id = $1 AND action = $3 AND status = 'manual' AND version = $2
             RETURNING version`,
            [params.caseId, body.expectedVersion, state.case_action],
          );
          if (suspendedService.rowCount !== 1 || suspendedCase.rowCount !== 1) {
            throw Object.assign(new Error("Service state changed; refresh and confirm again"), {
              statusCode: 409,
              code: "VERSION_CONFLICT",
            });
          }
          resultingCaseStatus = "suspended";
          resultingServiceStatus = "suspended";
        } else {
          if (
            !(
              (
                state.case_action === "manual" &&
                state.case_status === "suspended" &&
                state.service_status === "suspended"
              ) ||
              (
                state.case_action === "automatic" &&
                state.case_status === "manual" &&
                ["suspended", "provisioned_hold"].includes(state.service_status) &&
                state.operation_kind === "resource_resume" &&
                state.operation_status === "succeeded"
              ) ||
              (
                state.case_action === "automatic" &&
                state.case_status === "manual" &&
                state.service_status === "suspended"
              )
            ) ||
            !state.all_service_renewals_settled ||
            !state.all_service_renewal_periods_granted ||
            state.account_restricted_at
          ) {
            throw Object.assign(
              new Error(
                state.account_restricted_at
                  ? "The Client Account is restricted; manual restoration is blocked"
                  : "Every renewal invoice and exact service period must be settled before restoration",
              ),
              { statusCode: 409, code: "MANUAL_RESTORATION_BLOCKED" },
            );
          }
          const restoredService = await client.query(
            `UPDATE services
             SET status = 'active', updated_at = now(), version = version + 1
             WHERE id = $1 AND status IN ('suspended', 'provisioned_hold')
             RETURNING id`,
            [pointer.service_id],
          );
          const restoredCase = await client.query(
            `UPDATE service_suspension_cases
             SET status = 'resolved', resume_required = false, resolved_at = now(),
                 updated_at = now(), version = version + 1
             WHERE id = $1 AND action = $3 AND status = $4 AND version = $2
             RETURNING version`,
            [params.caseId, body.expectedVersion, state.case_action, state.case_status],
          );
          if (restoredService.rowCount !== 1 || restoredCase.rowCount !== 1) {
            throw Object.assign(new Error("Service state changed; refresh and confirm again"), {
              statusCode: 409,
              code: "VERSION_CONFLICT",
            });
          }
          resultingCaseStatus = "resolved";
          resultingServiceStatus = "active";
        }

        const manualActionId = randomUUID();
        const recordedAt = new Date();
        const result = {
          caseId: params.caseId,
          serviceId: pointer.service_id,
          renewalId: pointer.service_renewal_id,
          invoiceId: pointer.invoice_id,
          action: body.action,
          caseAction: state.case_action,
          caseStatus: resultingCaseStatus,
          serviceStatus: resultingServiceStatus,
          version: body.expectedVersion + 1,
          providerCalled: false,
          providerOperationEvidence,
          stoppedProviderJobCount,
          manualActionId,
          recordedAt: recordedAt.toISOString(),
        };
        const manualAction = await client.query<{ id: string }>(
          `INSERT INTO service_suspension_manual_actions(
             id, service_suspension_case_id, service_id, service_renewal_id, invoice_id,
             staff_user_id, staff_session_id, case_action_snapshot,
             provider_operation_id, provider_operation_kind, provider_operation_status,
             provider_operation_attempt_count, provider_operation_evidence,
             action, reason, expected_case_version,
             previous_case_status, resulting_case_status,
             previous_service_status, resulting_service_status,
             idempotency_key, request_fingerprint, result, created_at
           ) VALUES (
             $1, $2, $3, $4, $5,
             $6, $7, $8,
             $9, $10, $11, $12, $13,
             $14, $15, $16,
             $17, $18, $19, $20,
             $21, $22, $23, $24
           )
           RETURNING id`,
          [
            manualActionId,
            params.caseId,
            pointer.service_id,
            pointer.service_renewal_id,
            pointer.invoice_id,
            user.userId,
            user.sessionId,
            state.case_action,
            state.case_action === "automatic" ? state.operation_id : null,
            state.case_action === "automatic" ? state.operation_kind : null,
            state.case_action === "automatic" ? state.operation_status : null,
            state.case_action === "automatic" ? state.operation_attempt_count : null,
            state.case_action === "automatic" ? providerOperationEvidence : null,
            body.action,
            body.reason,
            body.expectedVersion,
            previousCaseStatus,
            resultingCaseStatus,
            previousServiceStatus,
            resultingServiceStatus,
            body.idempotencyKey,
            fingerprint,
            result,
            recordedAt,
          ],
        );
        const actionRecord = manualAction.rows[0];
        if (!actionRecord) throw new Error("Unable to record manual service action");
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, reason, metadata
           ) VALUES ('staff', $1, $2, 'service_suspension_case', $3, $4, $5)`,
          [
            user.userId,
            body.action === "confirm_suspended"
              ? "service.manual_suspension_confirmed"
              : "service.manual_restoration_confirmed",
            params.caseId,
            body.reason,
            {
              manualActionId: actionRecord.id,
              serviceId: pointer.service_id,
              renewalId: pointer.service_renewal_id,
              invoiceId: pointer.invoice_id,
              previousCaseStatus,
              resultingCaseStatus,
              previousServiceStatus,
              resultingServiceStatus,
              expectedVersion: body.expectedVersion,
              caseAction: state.case_action,
              providerOperationEvidence,
              stoppedProviderJobCount,
              providerCalled: false,
            },
          ],
        );
        return { ...result, replayed: false };
      });
      return reply.code(outcome.replayed ? 200 : 201).send(outcome);
    },
  );

  app.post(
    "/api/v1/admin/billing/renewals/:renewalId/resolve-hold",
    async (request, reply) => {
      const user = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, user, "billing.automation_manage");
      await requireRecentReauth(pool, user);
      const params = z.object({ renewalId: z.uuid() }).parse(request.params);
      const body = z
        .object({
          action: z.literal("grant_period"),
          reason: z.string().trim().min(10).max(1_000),
          expectedVersion: z.number().int().positive(),
          idempotencyKey: z.string().min(8).max(128),
        })
        .parse(request.body);
      const fingerprint = requestFingerprint("admin.renewal-hold-resolution:v1", {
        renewalId: params.renewalId,
        action: body.action,
        reason: body.reason,
        expectedVersion: body.expectedVersion,
      });
      const outcome = await transaction(pool, async (client) => {
        const settlementIdentity = (
          await client.query<{
            target_user_id: string;
            client_account_id: string;
          }>(
            `SELECT original_order.submitted_by_user_id AS target_user_id,
                    service.client_account_id
             FROM service_renewals renewal
             JOIN services service ON service.id = renewal.service_id
             JOIN order_items item ON item.id = service.order_item_id
             JOIN orders original_order ON original_order.id = item.order_id
             WHERE renewal.id = $1`,
            [params.renewalId],
          )
        ).rows[0];
        await requireStaffActionLocked(
          client,
          user,
          "billing.automation_manage",
          settlementIdentity ? [settlementIdentity.target_user_id] : [],
        );
        if (settlementIdentity) {
          await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
            settlementIdentity.client_account_id,
          ]);
          await client.query(
            `SELECT user_id
             FROM client_memberships
             WHERE client_account_id = $1 AND user_id = $2
             FOR UPDATE`,
            [settlementIdentity.client_account_id, settlementIdentity.target_user_id],
          );
        }
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `renewal-hold:${user.userId}:${body.idempotencyKey}`,
        ]);
        const previous = await client.query<{
          request_fingerprint: string;
          result: Record<string, unknown>;
        }>(
          `SELECT request_fingerprint, result
           FROM service_renewal_hold_resolutions
           WHERE staff_user_id = $1 AND idempotency_key = $2
           FOR UPDATE`,
          [user.userId, body.idempotencyKey],
        );
        const replay = previous.rows[0];
        if (replay) {
          if (replay.request_fingerprint !== fingerprint) {
            throw Object.assign(
              new Error("The idempotency key was used for a different hold decision"),
              { statusCode: 409, code: "IDEMPOTENCY_CONFLICT" },
            );
          }
          return { ...replay.result, replayed: true };
        }
        const pointer = await client.query<{
          invoice_id: string;
          status: string;
          allocated_minor: string;
          total_minor: string;
        }>(
          `SELECT renewal.invoice_id, renewal.status,
                  allocation.allocated_minor::text,
                  invoice.total_minor::text
           FROM service_renewals renewal
           JOIN invoices invoice ON invoice.id = renewal.invoice_id
           JOIN invoice_allocation_totals allocation ON allocation.invoice_id = invoice.id
           WHERE renewal.id = $1`,
          [params.renewalId],
        );
        const renewal = pointer.rows[0];
        if (!renewal) {
          throw Object.assign(new Error("Renewal hold not found"), { statusCode: 404 });
        }
        if (
          renewal.status !== "manual_hold" ||
          BigInt(renewal.allocated_minor) < BigInt(renewal.total_minor)
        ) {
          throw Object.assign(new Error("Renewal is not a fully funded manual Hold"), {
            statusCode: 409,
            code: "HOLD_NOT_ACTIONABLE",
          });
        }
        const settlement = await advancePaidInvoice(client, renewal.invoice_id, {
          kind: "staff_hold_resolution",
          staffUserId: user.userId,
          expectedRenewalVersion: body.expectedVersion,
          reason: body.reason,
        });
        if (settlement.renewalStatus !== "paid") {
          throw Object.assign(
            new Error(
              "The hold remains blocked; clear the account restriction and service conflict first",
            ),
            { statusCode: 409, code: "HOLD_STILL_BLOCKED" },
          );
        }
        const result = {
          renewalId: params.renewalId,
          invoiceId: renewal.invoice_id,
          renewalStatus: settlement.renewalStatus,
          serviceStatus: settlement.serviceStatus ?? null,
        };
        await client.query(
          `INSERT INTO service_renewal_hold_resolutions(
             renewal_id, staff_user_id, action, reason, expected_version,
             idempotency_key, request_fingerprint, result
           ) VALUES ($1, $2, 'grant_period', $3, $4, $5, $6, $7)`,
          [
            params.renewalId,
            user.userId,
            body.reason,
            body.expectedVersion,
            body.idempotencyKey,
            fingerprint,
            result,
          ],
        );
        return { ...result, replayed: false };
      });
      return reply.code(outcome.replayed ? 200 : 201).send(outcome);
    },
  );
}
