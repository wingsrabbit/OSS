// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertFinancialReadEligible, requireUser } from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabasePool } from "./database.js";
import { requestFingerprint } from "./idempotency.js";
import { advancePaidInvoice } from "./invoice-settlement.js";
import { assertProviderSignature } from "./provider-signature.js";
import { runRenewalAutomation } from "./renewal-lifecycle.js";
import {
  requireRecentReauth,
  requireStaffActionLocked,
  requireStaffPermission,
} from "./routes-admin.js";

const LAB_WARNING = "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY";

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
  pending_payment_result: boolean;
  delinquency_deferral_count: string;
  latest_delinquency_deferral_at: Date | null;
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
        WHERE deferral.invoice_id = invoice.id) AS latest_delinquency_deferral_at
     FROM service_renewals renewal
     JOIN services service ON service.id = renewal.service_id
     JOIN order_items item ON item.id = service.order_item_id
     JOIN client_accounts account ON account.id = service.client_account_id
     JOIN invoices invoice ON invoice.id = renewal.invoice_id
     JOIN invoice_allocation_totals allocation ON allocation.invoice_id = invoice.id
     LEFT JOIN renewal_reminder_intents reminder ON reminder.invoice_id = invoice.id
     LEFT JOIN outbox ON outbox.id = reminder.outbox_id
     LEFT JOIN renewal_reminder_delivery_facts delivery ON delivery.intent_id = reminder.id
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
      status: "open" | "partially_paid" | "paid";
      fundingStatus: "open" | "partially_paid" | "paid";
      renewalStatus: "invoiced" | "paid" | "manual_hold";
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
      } | null;
      paymentReconciliationHold: {
        active: boolean;
        deferralCount: string;
        latestDeferredAt: string | null;
      };
    }
  >();
  for (const row of result.rows) {
    let item = items.get(row.renewal_id);
    if (!item) {
      const total = BigInt(row.total_minor);
      const allocated = BigInt(row.allocated_minor);
      const due = total > allocated ? total - allocated : 0n;
      const fundingStatus =
        allocated === 0n ? "open" : allocated < total ? "partially_paid" : "paid";
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
        renewalStatus: row.renewal_status as "invoiced" | "paid" | "manual_hold",
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
              }
            : null,
        paymentReconciliationHold: {
          active: row.pending_payment_result,
          deferralCount: row.delinquency_deferral_count,
          latestDeferredAt: row.latest_delinquency_deferral_at?.toISOString() ?? null,
        },
      };
      items.set(row.renewal_id, item);
    }
    if (row.reminder_kind && row.reminder_created_at) {
      item.reminders.push({
        kind: row.reminder_kind,
        offsetDays: row.reminder_offset_days ?? 0,
        status: row.reminder_suppressed_at
          ? "suppressed"
          : row.reminder_delivery_status
            ? row.reminder_delivery_status
          : row.reminder_job_status === "manual"
            ? "manual"
            : (row.reminder_job_status === "pending" || row.reminder_job_status === "running") &&
                (row.reminder_job_attempts ?? 0) > 0
              ? "retrying"
              : "queued",
        createdAt: row.reminder_created_at.toISOString(),
        deliveredAt:
          row.reminder_delivery_status === "delivered"
            ? row.reminder_provider_occurred_at?.toISOString() ?? null
            : null,
        outcomeAt:
          row.reminder_suppressed_at?.toISOString() ??
          row.reminder_provider_occurred_at?.toISOString() ??
          null,
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
    const user = await requireUser(request, pool, config);
    await requireStaffPermission(pool, user, "billing.automation_manage");
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
    const user = await requireUser(request, pool, config);
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
    "/api/v1/admin/billing/renewals/:renewalId/resolve-hold",
    async (request, reply) => {
      const user = await requireUser(request, pool, config);
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
        await requireStaffActionLocked(client, user, "billing.automation_manage");
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
          kind: "staff_manual",
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
