// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { addBillingCycle, type BillingCycle } from "@opensales/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  lockSessionIdentityForMutation,
  requireSessionIdentity,
  type SessionIdentity,
} from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabaseClient, type DatabasePool } from "./database.js";
import { requestFingerprint } from "./idempotency.js";
import { assertInvoicePaymentBusinessStateLocked } from "./invoice-payment-eligibility.js";
import { advancePaidInvoice } from "./invoice-settlement.js";
import { recordInitialServicePeriod } from "./renewal-lifecycle.js";

const manualCompletionSchema = z.object({
  reason: z.string().trim().min(10).max(1_000),
});

const creditAdjustmentSchema = z.object({
  direction: z.enum(["increase", "decrease"]),
  amountMinor: z.string().regex(/^[1-9]\d*$/),
  currency: z.literal("USD"),
  reason: z.string().trim().min(10).max(1_000),
  idempotencyKey: z.string().min(8).max(128),
});

const canonicalUuid = z.uuid().transform((value) => value.toLowerCase());

const fundResolutionSchema = z
  .object({
    action: z.enum(["convert_to_credit", "allocate_invoice"]),
    amountMinor: z.string().regex(/^[1-9]\d*$/),
    invoiceId: canonicalUuid.nullable().default(null),
    reason: z.string().trim().min(10).max(1_000),
    idempotencyKey: z.string().min(8).max(128),
  })
  .superRefine((value, context) => {
    if (value.action === "allocate_invoice" && !value.invoiceId) {
      context.addIssue({
        code: "custom",
        path: ["invoiceId"],
        message: "Invoice is required when allocating funds",
      });
    }
    if (value.action === "convert_to_credit" && value.invoiceId) {
      context.addIssue({
        code: "custom",
        path: ["invoiceId"],
        message: "Invoice must be omitted when converting funds to Credit",
      });
    }
  });

const manualReceiptSchema = z.object({
  reference: z.string().trim().min(1).max(200),
  receivedAt: z.iso.datetime({ offset: true }),
  grossAmountMinor: z.string().regex(/^[1-9]\d*$/),
  feeMinor: z.string().regex(/^(0|[1-9]\d*)$/),
  currency: z.literal("USD"),
  reason: z.string().trim().min(10).max(1_000),
  idempotencyKey: z.string().min(8).max(128),
});
const manualReceiptReversalSchema = z.object({
  expectedFundReceiptId: canonicalUuid,
  expectedGrossAmountMinor: z.string().regex(/^[1-9]\d*$/),
  reason: z.string().trim().min(10).max(1_000),
  idempotencyKey: z.string().min(8).max(128),
});
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

export async function requireStaffPermission(
  pool: DatabasePool,
  user: SessionIdentity,
  permission: string,
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
      (candidate) =>
        typeof candidate === "string" &&
        candidate.length > 0 &&
        candidate.trim() === candidate,
    ) ||
    (!permissions.includes("*") && !permissions.includes(permission))
  ) {
    throw Object.assign(new Error("Staff permission is required"), { statusCode: 403 });
  }
}

export async function requireStaffActionLocked(
  client: DatabaseClient,
  user: SessionIdentity,
  permission: string,
  affectedUserIds: readonly string[] = [],
): Promise<void> {
  const identity = await lockSessionIdentityForMutation(
    client,
    user,
    affectedUserIds,
  );
  if (!identity.emailVerifiedAt || identity.userRestrictedAt) {
    throw Object.assign(new Error("Current permission and password confirmation are required"), {
      statusCode: 403,
      code: "STAFF_AUTHORIZATION_REQUIRED",
    });
  }
  const result = await client.query<{ permissions: unknown }>(
    `SELECT permissions
     FROM staff_members
     WHERE user_id = $1 AND active
     FOR UPDATE`,
    [user.userId],
  );
  const permissions = result.rows[0]?.permissions;
  const grant = await client.query(
    `SELECT id
     FROM reauth_grants
     WHERE user_id = $1
       AND session_id = $2
       AND invalidated_at IS NULL
       AND expires_at > pg_catalog.clock_timestamp()
     ORDER BY created_at DESC, id DESC
     LIMIT 1
     FOR UPDATE`,
    [user.userId, user.sessionId],
  );
  if (
    grant.rowCount !== 1 ||
    !Array.isArray(permissions) ||
    !permissions.every(
      (candidate) =>
        typeof candidate === "string" &&
        candidate.length > 0 &&
        candidate.trim() === candidate,
    ) ||
    (!permissions.includes("*") && !permissions.includes(permission))
  ) {
    throw Object.assign(new Error("Current permission and password confirmation are required"), {
      statusCode: 403,
      code: "STAFF_AUTHORIZATION_REQUIRED",
    });
  }
}

export async function requireRecentReauth(
  pool: DatabasePool,
  user: Pick<SessionIdentity, "userId" | "sessionId">,
): Promise<void> {
  const result = await pool.query(
    `SELECT rg.id
     FROM reauth_grants rg
     JOIN sessions s ON s.id = rg.session_id
     WHERE rg.user_id = $1
       AND rg.session_id = $2
       AND rg.invalidated_at IS NULL
       AND rg.expires_at > pg_catalog.clock_timestamp()
       AND s.revoked_at IS NULL
       AND s.expires_at > pg_catalog.clock_timestamp()
     LIMIT 1`,
    [user.userId, user.sessionId],
  );
  if (result.rowCount !== 1) {
    throw Object.assign(new Error("Password confirmation is required for this action"), {
      statusCode: 403,
      code: "REAUTH_REQUIRED",
    });
  }
}

export async function requireRecentReauthLocked(
  client: DatabaseClient,
  user: Pick<SessionIdentity, "userId" | "sessionId">,
): Promise<string> {
  await lockSessionIdentityForMutation(client, user);
  const grant = await client.query<{ id: string }>(
    `SELECT id
     FROM reauth_grants
     WHERE user_id = $1
       AND session_id = $2
       AND invalidated_at IS NULL
       AND expires_at > pg_catalog.clock_timestamp()
     ORDER BY created_at DESC, id DESC
     LIMIT 1
     FOR UPDATE`,
    [user.userId, user.sessionId],
  );
  const grantId = grant.rows[0]?.id;
  if (!grantId) {
    throw Object.assign(new Error("Password confirmation is required for this action"), {
      statusCode: 403,
      code: "REAUTH_REQUIRED",
    });
  }
  return grantId;
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get(
    "/api/v1/admin/client-accounts/:clientAccountId/manual-receipts",
    async (request) => {
      const user = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, user, "billing.manual_receipt_manage");
      const params = z.object({ clientAccountId: canonicalUuid }).parse(request.params);
      const account = await pool.query<{ id: string; name: string }>(
        "SELECT id, name FROM client_accounts WHERE id = $1",
        [params.clientAccountId],
      );
      const target = account.rows[0];
      if (!target) {
        throw Object.assign(new Error("Client account not found"), { statusCode: 404 });
      }
      const receipts = await pool.query<{
        id: string;
        reference: string;
        received_at: Date;
        gross_amount_minor: string;
        fee_minor: string;
        currency: string;
        actor_id: string;
        reason: string;
        created_at: Date;
        fund_receipt_id: string;
        allocated_minor: string;
        disposition: string;
        available_minor: string;
        capacity_frozen: boolean;
        reversal_id: string | null;
        reversal_actor_id: string | null;
        reversal_reason: string | null;
        reversed_at: Date | null;
      }>(
        `SELECT
           fact.id,
           fact.reference,
           fact.received_at,
           fact.gross_amount_minor::text,
           fact.fee_minor::text,
           fact.currency,
           fact.actor_id,
           fact.reason,
           fact.created_at,
           receipt.id AS fund_receipt_id,
           receipt.allocated_minor::text,
           receipt.disposition,
           capacity.available_minor::text,
           capacity.capacity_frozen,
           reversal.id AS reversal_id,
           reversal.actor_id AS reversal_actor_id,
           reversal.reason AS reversal_reason,
           reversal.created_at AS reversed_at
         FROM manual_receipt_facts fact
         JOIN fund_receipts receipt ON receipt.reported_manual_receipt_id = fact.id
         JOIN unclaimed_fund_refund_capacity capacity
           ON capacity.fund_receipt_id = receipt.id
         LEFT JOIN manual_receipt_reversals reversal
           ON reversal.manual_receipt_id = fact.id
         WHERE fact.client_account_id = $1
         ORDER BY fact.received_at DESC, fact.id DESC`,
        [params.clientAccountId],
      );
      const outflowSources = await pool.query<{
        manual_receipt_id: string;
        source_amount_minor: string;
        confirmed_outflow_minor: string;
        available_minor: string;
        capacity_frozen: boolean;
      }>(
        `SELECT capacity.manual_receipt_id,
                capacity.source_amount_minor::text,
                capacity.confirmed_outflow_minor::text,
                capacity.available_minor::text,
                capacity.capacity_frozen
         FROM manual_receipt_outflow_capacity capacity
         WHERE capacity.client_account_id = $1
           AND capacity.source_context = 'unclaimed_funds'
           AND capacity.fund_receipt_resolution_id IS NULL`,
        [params.clientAccountId],
      );
      const outflowReports = await pool.query<{
        id: string;
        manual_receipt_id: string;
        amount_minor: string;
        currency: string;
        destination_reference: string;
        observed_outcome: "confirmed" | "unknown";
        occurred_at: Date | null;
        actor_id: string;
        reason: string;
        created_at: Date;
        outflow_id: string | null;
        reconciliation_id: string | null;
        reconciliation_outcome: "confirm_outflow" | "confirm_no_outflow" | null;
        reconciliation_occurred_at: Date | null;
        reconciliation_actor_id: string | null;
        reconciliation_reason: string | null;
        reconciled_at: Date | null;
      }>(
        `SELECT report.id,
                report.manual_receipt_id,
                report.amount_minor::text,
                report.currency,
                report.destination_reference,
                report.observed_outcome,
                report.occurred_at,
                report.actor_id,
                report.reason,
                report.created_at,
                outflow.id AS outflow_id,
                reconciliation.id AS reconciliation_id,
                reconciliation.outcome AS reconciliation_outcome,
                reconciliation.occurred_at AS reconciliation_occurred_at,
                reconciliation.actor_id AS reconciliation_actor_id,
                reconciliation.reason AS reconciliation_reason,
                reconciliation.created_at AS reconciled_at
         FROM manual_receipt_outflow_reports report
         LEFT JOIN manual_receipt_outflows outflow ON outflow.report_id = report.id
         LEFT JOIN manual_receipt_outflow_reconciliations reconciliation
           ON reconciliation.report_id = report.id
         WHERE report.client_account_id = $1
           AND report.source_context = 'unclaimed_funds'
           AND report.fund_receipt_resolution_id IS NULL
           AND report.destination = 'original_source'
         ORDER BY report.created_at DESC, report.id DESC`,
        [params.clientAccountId],
      );
      const sourceByReceipt = new Map(
        outflowSources.rows.map((source) => [source.manual_receipt_id, source]),
      );
      const reportsByReceipt = new Map<string, typeof outflowReports.rows>();
      for (const report of outflowReports.rows) {
        const reports = reportsByReceipt.get(report.manual_receipt_id) ?? [];
        reports.push(report);
        reportsByReceipt.set(report.manual_receipt_id, reports);
      }
      return {
        warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
        clientAccount: target,
        items: receipts.rows.map((row) => {
          if (
            row.reversal_id &&
            (!row.reversal_actor_id || !row.reversal_reason || !row.reversed_at)
          ) {
            throw new Error("Manual receipt reversal history is incomplete");
          }
          const outflowSource = sourceByReceipt.get(row.id);
          if (!outflowSource) {
            throw new Error("Manual receipt original-source capacity is unavailable");
          }
          return {
            manualReceiptId: row.id,
            fundReceiptId: row.fund_receipt_id,
            reference: row.reference,
            receivedAt: row.received_at.toISOString(),
            grossAmountMinor: row.gross_amount_minor,
            feeMinor: row.fee_minor,
            netAmountMinor: (
              BigInt(row.gross_amount_minor) - BigInt(row.fee_minor)
            ).toString(),
            allocatedMinor: row.allocated_minor,
            availableMinor: row.available_minor,
            capacityFrozen: row.capacity_frozen,
            currency: row.currency,
            disposition: row.disposition,
            originalSourceOutflow: {
              sourceContext: "unclaimed_funds",
              sourceAmountMinor: outflowSource.source_amount_minor,
              confirmedOutflowMinor: outflowSource.confirmed_outflow_minor,
              availableMinor: outflowSource.available_minor,
              capacityFrozen: outflowSource.capacity_frozen,
              reports: (reportsByReceipt.get(row.id) ?? []).map((report) => ({
                outflowReportId: report.id,
                outflowId: report.outflow_id,
                amountMinor: report.amount_minor,
                currency: report.currency,
                destination: "original_source",
                destinationReference: report.destination_reference,
                observedOutcome: report.observed_outcome,
                status:
                  report.observed_outcome === "confirmed"
                    ? "confirmed"
                    : report.reconciliation_outcome === "confirm_outflow"
                      ? "confirmed_outflow"
                      : report.reconciliation_outcome === "confirm_no_outflow"
                        ? "no_outflow"
                        : "unknown",
                occurredAt: report.occurred_at?.toISOString() ?? null,
                actorId: report.actor_id,
                reason: report.reason,
                createdAt: report.created_at.toISOString(),
                reconciliation: report.reconciliation_id
                  ? {
                      reconciliationId: report.reconciliation_id,
                      outcome: report.reconciliation_outcome!,
                      occurredAt:
                        report.reconciliation_occurred_at?.toISOString() ?? null,
                      actorId: report.reconciliation_actor_id!,
                      reason: report.reconciliation_reason!,
                      createdAt: report.reconciled_at!.toISOString(),
                    }
                  : null,
              })),
            },
            reversal: row.reversal_id
              ? {
                  reversalId: row.reversal_id,
                  actorId: row.reversal_actor_id!,
                  reason: row.reversal_reason!,
                  createdAt: row.reversed_at!.toISOString(),
                }
              : null,
            actorId: row.actor_id,
            reason: row.reason,
            createdAt: row.created_at.toISOString(),
          };
        }),
      };
    },
  );

  app.post(
    "/api/v1/admin/client-accounts/:clientAccountId/manual-receipts",
    async (request, reply) => {
      const user = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, user, "billing.manual_receipt_manage");
      await requireRecentReauth(pool, user);
      const params = z.object({ clientAccountId: canonicalUuid }).parse(request.params);
      const body = manualReceiptSchema.parse(request.body);
      const grossAmount = BigInt(body.grossAmountMinor);
      const fee = BigInt(body.feeMinor);
      if (grossAmount > POSTGRES_BIGINT_MAX || fee > POSTGRES_BIGINT_MAX) {
        throw Object.assign(new Error("Manual receipt amount is outside the supported range"), {
          statusCode: 400,
          code: "MANUAL_RECEIPT_AMOUNT_OUT_OF_RANGE",
        });
      }
      if (fee > grossAmount) {
        throw Object.assign(new Error("Fee cannot exceed the received gross amount"), {
          statusCode: 400,
          code: "MANUAL_RECEIPT_FEE_EXCEEDS_GROSS",
        });
      }
      const receivedAt = new Date(body.receivedAt);
      if (receivedAt.getTime() > Date.now() + 5 * 60_000) {
        throw Object.assign(new Error("Received time cannot be in the future"), {
          statusCode: 400,
          code: "MANUAL_RECEIPT_FUTURE_DATE",
        });
      }
      const fingerprint = requestFingerprint("admin.manual-receipt:v1", {
        clientAccountId: params.clientAccountId,
        reference: body.reference,
        receivedAt: receivedAt.toISOString(),
        grossAmountMinor: body.grossAmountMinor,
        feeMinor: body.feeMinor,
        currency: body.currency,
        reason: body.reason,
      });

      const outcome = await transaction(pool, async (client) => {
        await requireStaffActionLocked(client, user, "billing.manual_receipt_manage");
        const locks = [
          `manual-receipt:idempotency:${body.idempotencyKey}`,
          `manual-receipt:reference:${params.clientAccountId}:${body.reference}`,
        ].sort();
        for (const lock of locks) {
          await client.query(
            "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
            [lock],
          );
        }

        const replayResult = await client.query<{
          client_account_id: string;
          request_fingerprint: string;
          result: Record<string, unknown>;
        }>(
          `SELECT client_account_id, request_fingerprint, result
           FROM manual_receipt_facts
           WHERE idempotency_key = $1
           FOR UPDATE`,
          [body.idempotencyKey],
        );
        const replay = replayResult.rows[0];
        if (replay) {
          if (
            replay.client_account_id !== params.clientAccountId ||
            replay.request_fingerprint !== fingerprint
          ) {
            throw Object.assign(
              new Error("The idempotency key was used for a different manual receipt"),
              { statusCode: 409, code: "IDEMPOTENCY_CONFLICT" },
            );
          }
          await requireStaffActionLocked(
            client,
            user,
            "billing.manual_receipt_manage",
          );
          return { ...replay.result, replayed: true };
        }

        await requireStaffActionLocked(client, user, "billing.manual_receipt_manage");
        const target = await client.query<{ id: string }>(
          "SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE",
          [params.clientAccountId],
        );
        if (!target.rows[0]) {
          throw Object.assign(new Error("Client account not found"), { statusCode: 404 });
        }

        const conflictingReference = await client.query(
          `SELECT id
           FROM manual_receipt_facts
           WHERE client_account_id = $1 AND reference = $2
           FOR UPDATE`,
          [params.clientAccountId, body.reference],
        );
        if (conflictingReference.rowCount !== 0) {
          throw Object.assign(
            new Error("This client account already has a manual receipt with that reference"),
            { statusCode: 409, code: "MANUAL_RECEIPT_REFERENCE_CONFLICT" },
          );
        }

        const manualReceiptId = randomUUID();
        const fundReceiptId = randomUUID();
        const netAmount = grossAmount - fee;
        const result = {
          manualReceiptId,
          fundReceiptId,
          clientAccountId: params.clientAccountId,
          reference: body.reference,
          receivedAt: receivedAt.toISOString(),
          grossAmountMinor: body.grossAmountMinor,
          feeMinor: body.feeMinor,
          netAmountMinor: netAmount.toString(),
          currency: body.currency,
          disposition: "unclaimed",
          allocatedMinor: "0",
          providerUsed: false,
        };
        await client.query(
          `INSERT INTO manual_receipt_facts(
             id, client_account_id, reference, received_at,
             gross_amount_minor, fee_minor, currency, actor_id, reason,
             idempotency_key, request_fingerprint, result
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            manualReceiptId,
            params.clientAccountId,
            body.reference,
            receivedAt,
            body.grossAmountMinor,
            body.feeMinor,
            body.currency,
            user.userId,
            body.reason,
            body.idempotencyKey,
            fingerprint,
            result,
          ],
        );
        await client.query(
          `INSERT INTO fund_receipts(
             id, provider_installation_id, external_payment_id,
             reported_payment_attempt_id, reported_add_funds_attempt_id,
             reported_manual_receipt_id, client_account_id, amount_minor,
             allocated_minor, currency, occurred_at, disposition, reason
           ) VALUES (
             $1, NULL, NULL, NULL, NULL, $2, $3, $4,
             0, $5, $6, 'unclaimed', $7
           )`,
          [
            fundReceiptId,
            manualReceiptId,
            params.clientAccountId,
            body.grossAmountMinor,
            body.currency,
            receivedAt,
            body.reason,
          ],
        );
        const journal = await client.query<{ id: string }>(
          `INSERT INTO ledger_journals(
             source_type, source_id, currency, description
           ) VALUES (
             'manual_receipt', $1, $2, 'Audited manual receipt recorded as unclaimed funds'
           ) RETURNING id`,
          [manualReceiptId, body.currency],
        );
        const journalId = journal.rows[0]?.id;
        if (!journalId) throw new Error("Unable to create manual receipt journal");
        if (netAmount > 0n) {
          await client.query(
            `INSERT INTO ledger_lines(
               journal_id, account_code, debit_minor, credit_minor
             ) VALUES ($1, 'cash_clearing', $2, 0)`,
            [journalId, netAmount.toString()],
          );
        }
        if (fee > 0n) {
          await client.query(
            `INSERT INTO ledger_lines(
               journal_id, account_code, debit_minor, credit_minor
             ) VALUES ($1, 'payment_processing_expense', $2, 0)`,
            [journalId, fee.toString()],
          );
        }
        await client.query(
          `INSERT INTO ledger_lines(
             journal_id, account_code, debit_minor, credit_minor
           ) VALUES ($1, 'unclaimed_funds_liability', 0, $2)`,
          [journalId, body.grossAmountMinor],
        );
        await client.query(
          "UPDATE ledger_journals SET sealed_at = now() WHERE id = $1",
          [journalId],
        );
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, reason, metadata
           ) VALUES (
             'staff', $1, 'billing.manual_receipt_recorded',
             'manual_receipt', $2, $3, $4
           )`,
          [
            user.userId,
            manualReceiptId,
            body.reason,
            {
              fundReceiptId,
              clientAccountId: params.clientAccountId,
              reference: body.reference,
              receivedAt: receivedAt.toISOString(),
              grossAmountMinor: body.grossAmountMinor,
              feeMinor: body.feeMinor,
              netAmountMinor: netAmount.toString(),
              currency: body.currency,
              disposition: "unclaimed",
              providerUsed: false,
            },
          ],
        );
        return { ...result, replayed: false };
      });
      return reply.code(outcome.replayed ? 200 : 201).send(outcome);
    },
  );

  app.post(
    "/api/v1/admin/client-accounts/:clientAccountId/manual-receipts/:manualReceiptId/reversal",
    async (request, reply) => {
      const user = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, user, "billing.manual_receipt_manage");
      await requireStaffPermission(pool, user, "billing.unclaimed_manage");
      await requireRecentReauth(pool, user);
      const params = z
        .object({ clientAccountId: canonicalUuid, manualReceiptId: canonicalUuid })
        .parse(request.params);
      const body = manualReceiptReversalSchema.parse(request.body);
      const fingerprint = requestFingerprint("admin.manual-receipt-reversal:v1", {
        clientAccountId: params.clientAccountId,
        manualReceiptId: params.manualReceiptId,
        expectedFundReceiptId: body.expectedFundReceiptId,
        expectedGrossAmountMinor: body.expectedGrossAmountMinor,
        reason: body.reason,
      });

      const outcome = await transaction(pool, async (client) => {
        await requireStaffActionLocked(client, user, "billing.manual_receipt_manage");
        await requireStaffActionLocked(client, user, "billing.unclaimed_manage");
        const locks = [
          `manual-receipt-reversal:idempotency:${body.idempotencyKey}`,
          `manual-receipt-reversal:semantic:${params.manualReceiptId}`,
        ].sort();
        for (const lock of locks) {
          await client.query(
            "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
            [lock],
          );
        }

        const replayResult = await client.query<{
          manual_receipt_id: string;
          client_account_id: string;
          request_fingerprint: string;
          result: Record<string, unknown>;
        }>(
          `SELECT reversal.manual_receipt_id,
                  fact.client_account_id,
                  reversal.request_fingerprint,
                  reversal.result
           FROM manual_receipt_reversals reversal
           JOIN manual_receipt_facts fact ON fact.id = reversal.manual_receipt_id
           WHERE reversal.idempotency_key = $1
           FOR UPDATE OF reversal, fact`,
          [body.idempotencyKey],
        );
        const replay = replayResult.rows[0];
        if (replay) {
          if (
            replay.manual_receipt_id !== params.manualReceiptId ||
            replay.client_account_id !== params.clientAccountId ||
            replay.request_fingerprint !== fingerprint
          ) {
            throw Object.assign(
              new Error("The idempotency key was used for a different manual receipt reversal"),
              { statusCode: 409, code: "IDEMPOTENCY_CONFLICT" },
            );
          }
          await requireStaffActionLocked(client, user, "billing.manual_receipt_manage");
          await requireStaffActionLocked(client, user, "billing.unclaimed_manage");
          return { ...replay.result, replayed: true };
        }

        await requireStaffActionLocked(client, user, "billing.manual_receipt_manage");
        await requireStaffActionLocked(client, user, "billing.unclaimed_manage");
        const receiptResult = await client.query<{
          manual_receipt_id: string;
          fund_receipt_id: string;
          client_account_id: string;
          gross_amount_minor: string;
          fee_minor: string;
          currency: string;
          receipt_amount_minor: string;
          allocated_minor: string;
          disposition: string;
        }>(
          `SELECT fact.id AS manual_receipt_id,
                  receipt.id AS fund_receipt_id,
                  fact.client_account_id,
                  fact.gross_amount_minor::text,
                  fact.fee_minor::text,
                  fact.currency,
                  receipt.amount_minor::text AS receipt_amount_minor,
                  receipt.allocated_minor::text,
                  receipt.disposition
           FROM manual_receipt_facts fact
           JOIN fund_receipts receipt ON receipt.reported_manual_receipt_id = fact.id
           WHERE fact.id = $1 AND fact.client_account_id = $2
           FOR UPDATE OF fact, receipt`,
          [params.manualReceiptId, params.clientAccountId],
        );
        const receipt = receiptResult.rows[0];
        if (!receipt) {
          throw Object.assign(new Error("Manual receipt not found"), { statusCode: 404 });
        }
        if (
          receipt.fund_receipt_id !== body.expectedFundReceiptId ||
          receipt.gross_amount_minor !== body.expectedGrossAmountMinor
        ) {
          throw Object.assign(
            new Error("The manual receipt changed since it was reviewed; refresh and confirm again"),
            { statusCode: 409, code: "MANUAL_RECEIPT_STALE" },
          );
        }
        if (receipt.receipt_amount_minor !== receipt.gross_amount_minor) {
          throw new Error("Manual receipt and fund receipt amounts do not match");
        }

        const existingReversal = await client.query(
          "SELECT id FROM manual_receipt_reversals WHERE manual_receipt_id = $1",
          [params.manualReceiptId],
        );
        if (existingReversal.rowCount !== 0) {
          throw Object.assign(new Error("This manual receipt was already reversed"), {
            statusCode: 409,
            code: "MANUAL_RECEIPT_ALREADY_REVERSED",
          });
        }
        const capacityResult = await client.query<{
          reserved_refund_minor: string;
          confirmed_outflow_minor: string;
          available_minor: string;
          capacity_frozen: boolean;
        }>(
          `SELECT reserved_refund_minor::text,
                  confirmed_outflow_minor::text,
                  available_minor::text,
                  capacity_frozen
           FROM unclaimed_fund_refund_capacity
           WHERE fund_receipt_id = $1`,
          [receipt.fund_receipt_id],
        );
        const capacity = capacityResult.rows[0];
        if (!capacity) {
          throw new Error("Manual receipt refund capacity is unavailable");
        }
        const untouched =
          receipt.disposition === "unclaimed" &&
          receipt.allocated_minor === "0" &&
          capacity.reserved_refund_minor === "0" &&
          capacity.confirmed_outflow_minor === "0" &&
          capacity.available_minor === receipt.gross_amount_minor &&
          !capacity.capacity_frozen;
        if (!untouched) {
          throw Object.assign(
            new Error(
              "Only a fully untouched manual receipt can be reversed; resolve allocations or outflow evidence first",
            ),
            { statusCode: 409, code: "MANUAL_RECEIPT_REVERSAL_NOT_ALLOWED" },
          );
        }

        const reversalId = randomUUID();
        const netAmount =
          BigInt(receipt.gross_amount_minor) - BigInt(receipt.fee_minor);
        const result = {
          reversalId,
          manualReceiptId: receipt.manual_receipt_id,
          fundReceiptId: receipt.fund_receipt_id,
          clientAccountId: receipt.client_account_id,
          grossAmountMinor: receipt.gross_amount_minor,
          feeMinor: receipt.fee_minor,
          netAmountMinor: netAmount.toString(),
          currency: receipt.currency,
          disposition: "reversed",
          providerUsed: false,
          cashOutflow: false,
        };
        await client.query(
          `INSERT INTO manual_receipt_reversals(
             id, manual_receipt_id, fund_receipt_id, actor_id, reason,
             idempotency_key, request_fingerprint, result
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            reversalId,
            receipt.manual_receipt_id,
            receipt.fund_receipt_id,
            user.userId,
            body.reason,
            body.idempotencyKey,
            fingerprint,
            result,
          ],
        );
        await client.query(
          `UPDATE fund_receipts
           SET disposition = 'reversed', updated_at = now()
           WHERE id = $1`,
          [receipt.fund_receipt_id],
        );
        const journal = await client.query<{ id: string }>(
          `INSERT INTO ledger_journals(source_type, source_id, currency, description)
           VALUES (
             'manual_receipt_reversal', $1, $2,
             'Audited reversal of an untouched mistaken manual receipt'
           ) RETURNING id`,
          [reversalId, receipt.currency],
        );
        const journalId = journal.rows[0]?.id;
        if (!journalId) throw new Error("Unable to create manual receipt reversal journal");
        await client.query(
          `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
           VALUES ($1, 'unclaimed_funds_liability', $2, 0)`,
          [journalId, receipt.gross_amount_minor],
        );
        if (netAmount > 0n) {
          await client.query(
            `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
             VALUES ($1, 'cash_clearing', 0, $2)`,
            [journalId, netAmount.toString()],
          );
        }
        if (BigInt(receipt.fee_minor) > 0n) {
          await client.query(
            `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
             VALUES ($1, 'payment_processing_expense', 0, $2)`,
            [journalId, receipt.fee_minor],
          );
        }
        await client.query("UPDATE ledger_journals SET sealed_at = now() WHERE id = $1", [
          journalId,
        ]);
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, reason, metadata
           ) VALUES (
             'staff', $1, 'billing.manual_receipt_reversed',
             'manual_receipt', $2, $3, $4
           )`,
          [
            user.userId,
            receipt.manual_receipt_id,
            body.reason,
            {
              reversalId,
              fundReceiptId: receipt.fund_receipt_id,
              clientAccountId: receipt.client_account_id,
              grossAmountMinor: receipt.gross_amount_minor,
              feeMinor: receipt.fee_minor,
              netAmountMinor: netAmount.toString(),
              currency: receipt.currency,
              providerUsed: false,
              cashOutflow: false,
            },
          ],
        );
        return { ...result, replayed: false };
      });
      return reply.code(outcome.replayed ? 200 : 201).send(outcome);
    },
  );

  app.get("/api/v1/admin/funds/unclaimed", async (request) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "billing.unclaimed_manage");
    const result = await pool.query<{
      id: string;
      client_account_id: string;
      client_account_name: string;
      provider_installation_id: string | null;
      external_payment_id: string | null;
      reported_manual_receipt_id: string | null;
      manual_reference: string | null;
      amount_minor: string;
      allocated_minor: string;
      remaining_minor: string;
      reserved_refund_minor: string;
      confirmed_outflow_minor: string;
      available_minor: string;
      capacity_frozen: boolean;
      currency: string;
      occurred_at: Date;
      disposition: string;
      reason: string | null;
      suggested_invoice_id: string | null;
      created_at: Date;
    }>(
      `SELECT
         receipt.id,
         receipt.client_account_id,
         account.name AS client_account_name,
         receipt.provider_installation_id,
         receipt.external_payment_id,
         receipt.reported_manual_receipt_id,
         manual.reference AS manual_reference,
         receipt.amount_minor::text,
         receipt.allocated_minor::text,
         GREATEST(
           0,
           receipt.amount_minor
           - receipt.allocated_minor
           - capacity.confirmed_outflow_minor
         )::text AS remaining_minor,
         capacity.reserved_refund_minor::text,
         capacity.confirmed_outflow_minor::text,
         capacity.available_minor::text,
         capacity.capacity_frozen,
         receipt.currency,
         receipt.occurred_at,
         receipt.disposition,
         receipt.reason,
         payment.invoice_id AS suggested_invoice_id,
         receipt.created_at
       FROM fund_receipts receipt
       JOIN client_accounts account ON account.id = receipt.client_account_id
       JOIN unclaimed_fund_refund_capacity capacity
         ON capacity.fund_receipt_id = receipt.id
       LEFT JOIN payment_attempts payment
         ON payment.id = receipt.reported_payment_attempt_id
       LEFT JOIN manual_receipt_facts manual
         ON manual.id = receipt.reported_manual_receipt_id
       WHERE receipt.disposition <> 'reversed'
         AND (capacity.available_minor > 0
          OR capacity.reserved_refund_minor > 0
          OR capacity.capacity_frozen)
       ORDER BY receipt.created_at DESC, receipt.id`,
    );
    return {
      warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      items: result.rows.map((row) => ({
        receiptId: row.id,
        clientAccountId: row.client_account_id,
        clientAccountName: row.client_account_name,
        providerInstallationId: row.provider_installation_id,
        externalPaymentId: row.external_payment_id,
        source: row.reported_manual_receipt_id ? "manual" : "provider",
        manualReceiptId: row.reported_manual_receipt_id,
        manualReference: row.manual_reference,
        amountMinor: row.amount_minor,
        allocatedMinor: row.allocated_minor,
        remainingMinor: row.remaining_minor,
        reservedRefundMinor: row.reserved_refund_minor,
        confirmedOutflowMinor: row.confirmed_outflow_minor,
        availableMinor: row.available_minor,
        capacityFrozen: row.capacity_frozen,
        currency: row.currency,
        occurredAt: row.occurred_at.toISOString(),
        disposition: row.disposition,
        reason: row.reason,
        suggestedInvoiceId: row.suggested_invoice_id,
        createdAt: row.created_at.toISOString(),
      })),
    };
  });

  app.post("/api/v1/admin/funds/:receiptId/resolutions", async (request, reply) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "billing.unclaimed_manage");
    await requireRecentReauth(pool, user);
    const params = z.object({ receiptId: canonicalUuid }).parse(request.params);
    const body = fundResolutionSchema.parse(request.body);
    const fingerprint = requestFingerprint("admin.fund-receipt-resolution:v1", {
      receiptId: params.receiptId,
      action: body.action,
      amountMinor: body.amountMinor,
      invoiceId: body.invoiceId,
      reason: body.reason,
    });

    const outcome = await transaction(pool, async (client) => {
      const settlementIdentity = body.action === "allocate_invoice"
        ? (
            await client.query<{
              client_account_id: string;
              target_user_id: string | null;
            }>(
              `SELECT invoice.client_account_id,
                      pg_catalog.coalesce(
                        order_record.submitted_by_user_id,
                        original_order.submitted_by_user_id
                      ) AS target_user_id
               FROM invoices invoice
               LEFT JOIN orders order_record ON order_record.id = invoice.order_id
               LEFT JOIN service_renewals renewal ON renewal.invoice_id = invoice.id
               LEFT JOIN services service ON service.id = renewal.service_id
               LEFT JOIN order_items item ON item.id = service.order_item_id
               LEFT JOIN orders original_order ON original_order.id = item.order_id
               WHERE invoice.id = $1`,
              [body.invoiceId],
            )
          ).rows[0]
        : undefined;
      await requireStaffActionLocked(
        client,
        user,
        "billing.unclaimed_manage",
        settlementIdentity?.target_user_id
          ? [settlementIdentity.target_user_id]
          : [],
      );
      if (settlementIdentity) {
        await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
          settlementIdentity.client_account_id,
        ]);
        if (settlementIdentity.target_user_id) {
          await client.query(
            `SELECT client_account_id
             FROM client_memberships
             WHERE client_account_id = $1 AND user_id = $2
             FOR UPDATE`,
            [settlementIdentity.client_account_id, settlementIdentity.target_user_id],
          );
        }
      }
      const resolutionLocks = [
        `fund-receipt-resolution:idempotency:${body.idempotencyKey}`,
        `fund-receipt-resolution:semantic:${params.receiptId}:${fingerprint}`,
      ].sort();
      for (const lock of resolutionLocks) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lock]);
      }
      const requestReplayResult = await client.query<{
        fund_receipt_id: string;
        request_fingerprint: string;
        result: Record<string, unknown>;
      }>(
        `SELECT
           request.fund_receipt_id,
           request.request_fingerprint,
           resolution.result
         FROM fund_receipt_resolution_requests request
         JOIN fund_receipt_resolutions resolution ON resolution.id = request.resolution_id
         WHERE request.idempotency_key = $1
         FOR UPDATE OF request, resolution`,
        [body.idempotencyKey],
      );
      const requestReplay = requestReplayResult.rows[0];
      if (requestReplay) {
        if (
          requestReplay.fund_receipt_id !== params.receiptId ||
          requestReplay.request_fingerprint !== fingerprint
        ) {
          throw Object.assign(
            new Error("The idempotency key was used for a different fund resolution"),
            { statusCode: 409, code: "IDEMPOTENCY_CONFLICT" },
          );
        }
        await requireStaffActionLocked(client, user, "billing.unclaimed_manage");
        return { ...requestReplay.result, replayed: true };
      }

      const semanticReplayResult = await client.query<{
        id: string;
        result: Record<string, unknown>;
      }>(
        `SELECT id, result
         FROM fund_receipt_resolutions
         WHERE fund_receipt_id = $1
           AND request_fingerprint = $2
         FOR UPDATE`,
        [params.receiptId, fingerprint],
      );
      const semanticReplay = semanticReplayResult.rows[0];
      if (semanticReplay) {
        await requireStaffActionLocked(client, user, "billing.unclaimed_manage");
        await client.query(
          `INSERT INTO fund_receipt_resolution_requests(
             idempotency_key, fund_receipt_id, request_fingerprint, resolution_id
           ) VALUES ($1, $2, $3, $4)`,
          [body.idempotencyKey, params.receiptId, fingerprint, semanticReplay.id],
        );
        return { ...semanticReplay.result, replayed: true };
      }

      let invoice:
        | {
            id: string;
            client_account_id: string;
            currency: string;
            total_minor: string;
            order_id: string | null;
          }
        | undefined;
      if (body.action === "allocate_invoice") {
        const invoiceResult = await client.query<{
          id: string;
          client_account_id: string;
          currency: string;
          total_minor: string;
          order_id: string | null;
        }>(
          `SELECT id, client_account_id, currency, total_minor::text, order_id
           FROM invoices
           WHERE id = $1
           FOR UPDATE`,
          [body.invoiceId],
        );
        invoice = invoiceResult.rows[0];
        if (!invoice) {
          throw Object.assign(new Error("Invoice not found"), { statusCode: 404 });
        }
        await assertInvoicePaymentBusinessStateLocked(client, invoice.id, invoice.order_id);
      }

      await requireStaffActionLocked(client, user, "billing.unclaimed_manage");

      const receiptResult = await client.query<{
        id: string;
        client_account_id: string;
        amount_minor: string;
        allocated_minor: string;
        currency: string;
      }>(
        `SELECT id, client_account_id, amount_minor::text, allocated_minor::text, currency
         FROM fund_receipts
         WHERE id = $1
         FOR UPDATE`,
        [params.receiptId],
      );
      const receipt = receiptResult.rows[0];
      if (!receipt) {
        throw Object.assign(new Error("Fund receipt not found"), { statusCode: 404 });
      }
      const capacityResult = await client.query<{
        available_minor: string;
        capacity_frozen: boolean;
      }>(
        `SELECT available_minor::text, capacity_frozen
         FROM unclaimed_fund_refund_capacity
         WHERE fund_receipt_id = $1`,
        [params.receiptId],
      );
      const capacity = capacityResult.rows[0];
      if (!capacity) throw new Error("Fund receipt capacity is unavailable");
      const amount = BigInt(body.amountMinor);
      if (capacity.capacity_frozen) {
        throw Object.assign(
          new Error("The receipt has an unknown or security-held outflow; reconcile it first"),
          { statusCode: 409, code: "UNCLAIMED_FUNDS_CAPACITY_FROZEN" },
        );
      }
      const remaining = BigInt(capacity.available_minor);
      if (amount > remaining) {
        throw Object.assign(new Error("Resolution exceeds the remaining unclaimed funds"), {
          statusCode: 409,
          code: "FUNDS_ALREADY_RESOLVED",
        });
      }
      const resolutionId = randomUUID();
      const remainingAfter = remaining - amount;
      const commonResult = {
        resolutionId,
        receiptId: receipt.id,
        action: body.action,
        amountMinor: body.amountMinor,
        currency: receipt.currency,
        remainingMinor: remainingAfter.toString(),
      };

      let result: Record<string, unknown>;
      if (body.action === "convert_to_credit") {
        await client.query(
          `INSERT INTO credit_accounts(client_account_id, currency)
           VALUES ($1, $2)
           ON CONFLICT (client_account_id, currency) DO NOTHING`,
          [receipt.client_account_id, receipt.currency],
        );
        const creditAccount = await client.query<{ id: string }>(
          `SELECT id
           FROM credit_accounts
           WHERE client_account_id = $1 AND currency = $2
           FOR UPDATE`,
          [receipt.client_account_id, receipt.currency],
        );
        const creditAccountId = creditAccount.rows[0]?.id;
        if (!creditAccountId) throw new Error("Unable to establish Credit account");
        const balanceResult = await client.query<{ balance_minor: string }>(
          `SELECT COALESCE(sum(credit_minor - debit_minor), 0)::text AS balance_minor
           FROM credit_transactions
           WHERE credit_account_id = $1`,
          [creditAccountId],
        );
        const balance = BigInt(balanceResult.rows[0]?.balance_minor ?? "0");
        const policyResult = await client.query<{ balance_cap_minor: string }>(
          `SELECT balance_cap_minor::text
           FROM add_funds_policies
           WHERE currency = $1
           FOR SHARE`,
          [receipt.currency],
        );
        const cap = policyResult.rows[0]?.balance_cap_minor;
        if (!cap || balance + amount > BigInt(cap)) {
          throw Object.assign(new Error("Credit conversion would exceed the balance cap"), {
            statusCode: 409,
            code: "CREDIT_BALANCE_CAP",
          });
        }
        const creditTransactionId = randomUUID();
        result = {
          ...commonResult,
          creditTransactionId,
          creditBalanceMinor: (balance + amount).toString(),
        };
        await client.query(
          `INSERT INTO fund_receipt_resolutions(
             id, fund_receipt_id, client_account_id, action, amount_minor,
             currency, invoice_id, actor_id, reason, idempotency_key,
             request_fingerprint, result
           ) VALUES ($1, $2, $3, 'convert_to_credit', $4, $5, NULL, $6, $7, $8, $9, $10)`,
          [
            resolutionId,
            receipt.id,
            receipt.client_account_id,
            body.amountMinor,
            receipt.currency,
            user.userId,
            body.reason,
            body.idempotencyKey,
            fingerprint,
            result,
          ],
        );
        await client.query(
          `INSERT INTO credit_transactions(
             id, credit_account_id, kind, credit_minor, debit_minor,
             source_type, source_id, actor_type, actor_id, reason,
             idempotency_key, request_fingerprint, result
           ) VALUES (
             $1, $2, 'unclaimed_funds', $3, 0,
             'fund_receipt_resolution', $4, 'staff', $5, $6, $7, $8, $9
           )`,
          [
            creditTransactionId,
            creditAccountId,
            body.amountMinor,
            resolutionId,
            user.userId,
            body.reason,
            `unclaimed-funds-credit:${resolutionId}`,
            fingerprint,
            result,
          ],
        );
        const journal = await client.query<{ id: string }>(
          `INSERT INTO ledger_journals(source_type, source_id, currency, description)
           VALUES ('fund_receipt_resolution', $1, $2, 'Unclaimed funds converted to Credit')
           RETURNING id`,
          [resolutionId, receipt.currency],
        );
        const journalId = journal.rows[0]?.id;
        if (!journalId) throw new Error("Unable to create fund resolution journal");
        await client.query(
          `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
           VALUES
             ($1, 'unclaimed_funds_liability', $2, 0),
             ($1, 'client_credit_liability', 0, $2)`,
          [journalId, body.amountMinor],
        );
      } else {
        if (!invoice) {
          throw new Error("Locked invoice is required for a fund allocation");
        }
        if (
          invoice.client_account_id !== receipt.client_account_id ||
          invoice.currency !== receipt.currency
        ) {
          throw Object.assign(
            new Error("Fund receipt and invoice must belong to the same account and currency"),
            { statusCode: 409, code: "FUNDS_INVOICE_MISMATCH" },
          );
        }
        const allocatedResult = await client.query<{ allocated_minor: string }>(
          `SELECT allocated_minor::text
           FROM invoice_allocation_totals
           WHERE invoice_id = $1`,
          [invoice.id],
        );
        const allocated = BigInt(allocatedResult.rows[0]?.allocated_minor ?? "0");
        const due = BigInt(invoice.total_minor) - allocated;
        if (due <= 0n || amount > due) {
          throw Object.assign(new Error("Resolution exceeds the invoice amount due"), {
            statusCode: 409,
            code: "INVOICE_ALLOCATION_EXCEEDS_DUE",
          });
        }
        result = {
          ...commonResult,
          invoiceId: invoice.id,
          invoiceStatus: amount === due ? "paid" : "partially_paid",
          invoiceDueMinor: (due - amount).toString(),
        };
        await client.query(
          `INSERT INTO fund_receipt_resolutions(
             id, fund_receipt_id, client_account_id, action, amount_minor,
             currency, invoice_id, actor_id, reason, idempotency_key,
             request_fingerprint, result
           ) VALUES ($1, $2, $3, 'allocate_invoice', $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            resolutionId,
            receipt.id,
            receipt.client_account_id,
            body.amountMinor,
            receipt.currency,
            invoice.id,
            user.userId,
            body.reason,
            body.idempotencyKey,
            fingerprint,
            result,
          ],
        );
        await client.query(
          `INSERT INTO fund_receipt_allocations(
             resolution_id, fund_receipt_id, invoice_id, amount_minor
           ) VALUES ($1, $2, $3, $4)`,
          [resolutionId, receipt.id, invoice.id, body.amountMinor],
        );
        const journal = await client.query<{ id: string }>(
          `INSERT INTO ledger_journals(source_type, source_id, currency, description)
           VALUES ('fund_receipt_resolution', $1, $2, 'Unclaimed funds allocated to invoice')
           RETURNING id`,
          [resolutionId, receipt.currency],
        );
        const journalId = journal.rows[0]?.id;
        if (!journalId) throw new Error("Unable to create fund resolution journal");
        await client.query(
          `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
           VALUES
             ($1, 'unclaimed_funds_liability', $2, 0),
             ($1, 'accounts_receivable', 0, $2)`,
          [journalId, body.amountMinor],
        );
      }

      await client.query(
        `INSERT INTO fund_receipt_resolution_requests(
           idempotency_key, fund_receipt_id, request_fingerprint, resolution_id
         ) VALUES ($1, $2, $3, $4)`,
        [body.idempotencyKey, receipt.id, fingerprint, resolutionId],
      );
      await client.query(
        `UPDATE fund_receipts
         SET allocated_minor = allocated_minor + $2,
             disposition = CASE
               WHEN allocated_minor + $2 = amount_minor THEN 'allocated'
               ELSE 'partially_allocated'
             END,
             updated_at = now()
         WHERE id = $1`,
        [receipt.id, body.amountMinor],
      );
      if (body.action === "allocate_invoice" && body.invoiceId) {
        await advancePaidInvoice(client, body.invoiceId, {
          kind: "staff_manual",
          staffUserId: user.userId,
        });
      }
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, reason, metadata
         ) VALUES ('staff', $1, 'billing.unclaimed_funds_resolved',
                   'fund_receipt', $2, $3, $4)`,
        [
          user.userId,
          receipt.id,
          body.reason,
          {
            resolutionId,
            action: body.action,
            amountMinor: body.amountMinor,
            currency: receipt.currency,
            invoiceId: body.invoiceId,
            remainingMinor: remainingAfter.toString(),
          },
        ],
      );
      return { ...result, replayed: false };
    });
    return reply.code(outcome.replayed ? 200 : 201).send(outcome);
  });

  app.post(
    "/api/v1/admin/client-accounts/:clientAccountId/credit-adjustments",
    async (request, reply) => {
      const user = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, user, "billing.credit_adjust");
      await requireRecentReauth(pool, user);
      const params = z.object({ clientAccountId: z.uuid() }).parse(request.params);
      const body = creditAdjustmentSchema.parse(request.body);
      const fingerprint = requestFingerprint("admin.credit-adjustment:v1", {
        clientAccountId: params.clientAccountId,
        direction: body.direction,
        amountMinor: body.amountMinor,
        currency: body.currency,
        reason: body.reason,
      });

      const outcome = await transaction(pool, async (client) => {
        await requireStaffActionLocked(client, user, "billing.credit_adjust");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `credit-adjustment:${params.clientAccountId}:${body.currency}:${body.idempotencyKey}`,
        ]);
        const target = await client.query<{ id: string }>(
          "SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE",
          [params.clientAccountId],
        );
        if (!target.rows[0]) {
          throw Object.assign(new Error("Client account not found"), { statusCode: 404 });
        }
        const accountResult = await client.query<{ id: string }>(
          `INSERT INTO credit_accounts(client_account_id, currency)
           VALUES ($1, $2)
           ON CONFLICT (client_account_id, currency) DO NOTHING
           RETURNING id`,
          [params.clientAccountId, body.currency],
        );
        const existingAccount = accountResult.rows[0]
          ? accountResult
          : await client.query<{ id: string }>(
              `SELECT id
               FROM credit_accounts
               WHERE client_account_id = $1 AND currency = $2
               FOR UPDATE`,
              [params.clientAccountId, body.currency],
            );
        const creditAccountId = existingAccount.rows[0]?.id;
        if (!creditAccountId) throw new Error("Unable to establish Credit account");
        await client.query("SELECT id FROM credit_accounts WHERE id = $1 FOR UPDATE", [
          creditAccountId,
        ]);

        const previous = await client.query<{
          id: string;
          request_fingerprint: string;
          result: { transactionId: string; balanceMinor: string } | null;
        }>(
          `SELECT id, request_fingerprint, result
           FROM credit_transactions
           WHERE credit_account_id = $1 AND idempotency_key = $2
           FOR UPDATE`,
          [creditAccountId, body.idempotencyKey],
        );
        if (previous.rows[0]) {
          if (previous.rows[0].request_fingerprint !== fingerprint) {
            throw Object.assign(
              new Error("The idempotency key was used for a different Credit adjustment"),
              { statusCode: 409, code: "IDEMPOTENCY_CONFLICT" },
            );
          }
          const storedResult = previous.rows[0].result;
          if (!storedResult) throw new Error("Credit adjustment replay is missing its result");
          return {
            ...storedResult,
            replayed: true,
          };
        }

        const amount = BigInt(body.amountMinor);
        const current = await client.query<{ balance_minor: string }>(
          `SELECT COALESCE(sum(credit_minor - debit_minor), 0)::text AS balance_minor
           FROM credit_transactions
           WHERE credit_account_id = $1`,
          [creditAccountId],
        );
        const currentBalance = BigInt(current.rows[0]?.balance_minor ?? "0");
        if (body.direction === "decrease" && amount > currentBalance) {
          throw Object.assign(new Error("Credit adjustment would make the balance negative"), {
            statusCode: 409,
            code: "INSUFFICIENT_CREDIT",
          });
        }
        const transactionId = randomUUID();
        const resultingBalance =
          body.direction === "increase" ? currentBalance + amount : currentBalance - amount;
        const commandResult = {
          transactionId,
          balanceMinor: resultingBalance.toString(),
        };
        await client.query(
          `INSERT INTO credit_transactions(
             id, credit_account_id, kind, credit_minor, debit_minor,
             source_type, source_id, actor_type, actor_id, reason,
             idempotency_key, request_fingerprint, result
           ) VALUES (
             $1, $2, 'manual_adjustment', $3, $4,
             'admin_credit_adjustment', $1, 'staff', $5, $6, $7, $8, $9
           )`,
          [
            transactionId,
            creditAccountId,
            body.direction === "increase" ? body.amountMinor : "0",
            body.direction === "decrease" ? body.amountMinor : "0",
            user.userId,
            body.reason,
            body.idempotencyKey,
            fingerprint,
            commandResult,
          ],
        );
        const journal = await client.query<{ id: string }>(
          `INSERT INTO ledger_journals(source_type, source_id, currency, description)
           VALUES ('credit_manual_adjustment', $1, $2, 'Audited manual Credit adjustment')
           RETURNING id`,
          [transactionId, body.currency],
        );
        const journalId = journal.rows[0]?.id;
        if (!journalId) throw new Error("Unable to create Credit journal");
        if (body.direction === "increase") {
          await client.query(
            `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
             VALUES
               ($1, 'credit_adjustment_expense', $2, 0),
               ($1, 'client_credit_liability', 0, $2)`,
            [journalId, body.amountMinor],
          );
        } else {
          await client.query(
            `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
             VALUES
               ($1, 'client_credit_liability', $2, 0),
               ($1, 'credit_adjustment_recovery', 0, $2)`,
            [journalId, body.amountMinor],
          );
        }
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, reason, metadata
           ) VALUES ('staff', $1, 'billing.credit_adjusted', 'client_account', $2, $3, $4)`,
          [
            user.userId,
            params.clientAccountId,
            body.reason,
            {
              transactionId,
              direction: body.direction,
              amountMinor: body.amountMinor,
              currency: body.currency,
            },
          ],
        );
        return {
          ...commandResult,
          replayed: false,
        };
      });
      return reply.code(outcome.replayed ? 200 : 201).send(outcome);
    },
  );

  app.get("/api/v1/admin/manual-fulfillment", async (request) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "services.manual_fulfillment");
    const result = await pool.query<{
      service_id: string;
      order_id: string;
      client_account_id: string;
      product_name: string;
      billing_cycle: string;
      client_account_name: string;
      paid_minor: string;
      total_minor: string;
      submitted_at: Date;
    }>(
      `SELECT
         s.id AS service_id,
         o.id AS order_id,
         o.client_account_id,
         oi.product_name,
         oi.billing_cycle,
         ca.name AS client_account_name,
         COALESCE(alloc.allocated_minor, 0)::text AS paid_minor,
         i.total_minor,
         o.submitted_at
       FROM orders o
       JOIN client_accounts ca ON ca.id = o.client_account_id
       JOIN order_items oi ON oi.order_id = o.id
       JOIN services s ON s.order_item_id = oi.id
       JOIN invoices i ON i.order_id = o.id
       LEFT JOIN invoice_allocation_totals alloc ON alloc.invoice_id = i.id
       WHERE o.status = 'awaiting_manual'
       ORDER BY o.submitted_at`,
    );
    return {
      warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      items: result.rows.map((row) => ({
        serviceId: row.service_id,
        orderId: row.order_id,
        clientAccountId: row.client_account_id,
        productName: row.product_name,
        billingCycle: row.billing_cycle,
        clientAccountName: row.client_account_name,
        paidMinor: row.paid_minor,
        totalMinor: row.total_minor,
        submittedAt: row.submitted_at.toISOString(),
      })),
    };
  });

  app.post("/api/v1/admin/services/:serviceId/complete-manual", async (request, reply) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "services.manual_fulfillment");
    await requireRecentReauth(pool, user);
    const params = z.object({ serviceId: z.uuid() }).parse(request.params);
    const body = manualCompletionSchema.parse(request.body);

    const result = await transaction(pool, async (client) => {
      const lockPointers = await client.query<{
        invoice_id: string;
        order_id: string;
        order_item_id: string;
        submitted_by_user_id: string;
        client_account_id: string;
      }>(
        `SELECT i.id AS invoice_id,
                o.id AS order_id,
                oi.id AS order_item_id,
                o.submitted_by_user_id,
                o.client_account_id
         FROM services s
         JOIN order_items oi ON oi.id = s.order_item_id
         JOIN orders o ON o.id = oi.order_id
         JOIN invoices i ON i.order_id = o.id
         WHERE s.id = $1`,
        [params.serviceId],
      );
      const lockPointer = lockPointers.rows[0];
      await requireStaffActionLocked(
        client,
        user,
        "services.manual_fulfillment",
        lockPointer ? [lockPointer.submitted_by_user_id] : [],
      );
      if (!lockPointer) {
        throw Object.assign(new Error("Service not found"), { statusCode: 404 });
      }
      await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
        lockPointer.client_account_id,
      ]);
      await client.query(
        `SELECT client_account_id
         FROM client_memberships
         WHERE client_account_id = $1 AND user_id = $2
         FOR UPDATE`,
        [lockPointer.client_account_id, lockPointer.submitted_by_user_id],
      );
      await client.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [
        lockPointer.invoice_id,
      ]);
      await client.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [
        lockPointer.order_id,
      ]);
      await client.query("SELECT id FROM order_items WHERE id = $1 FOR UPDATE", [
        lockPointer.order_item_id,
      ]);
      await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [
        params.serviceId,
      ]);
      const serviceResult = await client.query<{
        service_id: string;
        service_status: string;
        billing_cycle: BillingCycle;
        order_id: string;
        order_status: string;
        fulfillment_mode: string;
        invoice_id: string;
        invoice_total_minor: string;
        submitted_by_user_id: string;
        email_verified_at: Date | null;
        user_restricted_at: Date | null;
        account_restricted_at: Date | null;
        removed_at: Date | null;
      }>(
        `SELECT
           s.id AS service_id,
           s.status AS service_status,
           s.billing_cycle,
           o.id AS order_id,
           o.status AS order_status,
           oi.fulfillment_mode,
           i.id AS invoice_id,
           i.total_minor AS invoice_total_minor,
           o.submitted_by_user_id,
           customer.email_verified_at,
           customer.restricted_at AS user_restricted_at,
           ca.restricted_at AS account_restricted_at,
           cm.removed_at
         FROM services s
         JOIN order_items oi ON oi.id = s.order_item_id
         JOIN orders o ON o.id = oi.order_id
         JOIN invoices i ON i.order_id = o.id
         JOIN users customer ON customer.id = o.submitted_by_user_id
         JOIN client_accounts ca ON ca.id = o.client_account_id
         JOIN client_memberships cm
           ON cm.client_account_id = o.client_account_id
          AND cm.user_id = o.submitted_by_user_id
         WHERE s.id = $1`,
        [params.serviceId],
      );
      const service = serviceResult.rows[0];
      if (!service) throw Object.assign(new Error("Service not found"), { statusCode: 404 });
      if (!["manual", "review"].includes(service.fulfillment_mode)) {
        throw Object.assign(new Error("This service is not eligible for manual fulfillment"), {
          statusCode: 409,
        });
      }
      if (service.order_status !== "awaiting_manual" || service.service_status !== "pending") {
        throw Object.assign(new Error("Service is not waiting for manual fulfillment"), {
          statusCode: 409,
        });
      }
      const allocationResult = await client.query<{ allocated_minor: string }>(
        `SELECT allocated_minor::text
         FROM invoice_allocation_totals
         WHERE invoice_id = $1`,
        [service.invoice_id],
      );
      if (
        BigInt(allocationResult.rows[0]?.allocated_minor ?? "0") <
        BigInt(service.invoice_total_minor)
      ) {
        throw Object.assign(new Error("Invoice is not fully paid"), { statusCode: 409 });
      }
      const eligible =
        Boolean(service.email_verified_at) &&
        !service.user_restricted_at &&
        !service.account_restricted_at &&
        !service.removed_at;
      if (!eligible) {
        await client.query("UPDATE orders SET status = 'on_hold', updated_at = now() WHERE id = $1", [
          service.order_id,
        ]);
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, reason
           ) VALUES ('staff', $1, 'service.manual_fulfillment_blocked', 'service', $2, $3)`,
          [user.userId, service.service_id, "customer eligibility changed; order moved to Hold"],
        );
        return {
          serviceId: service.service_id,
          status: "on_hold" as const,
          activatedAt: null,
        };
      }
      const readyAt = new Date();
      const termEnd = addBillingCycle(readyAt, service.billing_cycle);
      const activated = await client.query(
        `UPDATE services
         SET status = 'active', activated_at = $2, term_start = $2, term_end = $3,
             updated_at = now(), version = version + 1
         WHERE id = $1
           AND activated_at IS NULL
           AND status = 'pending'
         RETURNING id`,
        [service.service_id, readyAt, termEnd],
      );
      if (activated.rowCount !== 1) {
        throw Object.assign(new Error("Service state changed; review it again"), {
          statusCode: 409,
          code: "STATE_CONFLICT",
        });
      }
      const completed = await client.query(
        `UPDATE orders
         SET status = 'completed', updated_at = now(), version = version + 1
         WHERE id = $1 AND status = 'awaiting_manual'
         RETURNING id`,
        [service.order_id],
      );
      if (completed.rowCount !== 1) {
        throw Object.assign(new Error("Order state changed; review it again"), {
          statusCode: 409,
          code: "STATE_CONFLICT",
        });
      }
      await recordInitialServicePeriod(client, {
        serviceId: service.service_id,
        invoiceId: service.invoice_id,
        periodStart: readyAt,
        periodEnd: termEnd,
        grantedAt: readyAt,
      });
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, reason, metadata
         ) VALUES ('staff', $1, 'service.manual_fulfillment_completed', 'service', $2, $3, $4)`,
        [
          user.userId,
          service.service_id,
          body.reason,
          { orderId: service.order_id, readyAt: readyAt.toISOString() },
        ],
      );
      await client.query(
        `INSERT INTO outbox(event_type, unique_key, payload)
         VALUES ('service.activated', $1, $2)
         ON CONFLICT (event_type, unique_key) DO NOTHING`,
        [
          `service:${service.service_id}`,
          {
            serviceId: service.service_id,
            orderId: service.order_id,
            activatedAt: readyAt.toISOString(),
            termEnd: termEnd?.toISOString() ?? null,
            fulfillment: "manual",
          },
        ],
      );
      return { serviceId: service.service_id, status: "active", activatedAt: readyAt.toISOString() };
    });
    if (result.status === "on_hold") {
      return reply
        .code(409)
        .send({ ...result, error: "Customer eligibility changed; order moved to Hold" });
    }
    return reply.code(200).send(result);
  });
}
