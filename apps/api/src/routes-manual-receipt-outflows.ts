// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser, type AuthenticatedUser } from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabaseClient, type DatabasePool } from "./database.js";
import { requestFingerprint } from "./idempotency.js";
import {
  requireRecentReauth,
  requireRecentReauthLocked,
  requireStaffActionLocked,
  requireStaffPermission,
} from "./routes-admin.js";

const canonicalUuid = z.uuid().transform((value) => value.toLowerCase());
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

const outflowReportSchema = z
  .object({
    expectedAvailableMinor: z.string().regex(/^(0|[1-9]\d*)$/),
    amountMinor: z.string().regex(/^[1-9]\d*$/),
    currency: z.literal("USD"),
    destination: z.literal("original_source"),
    destinationReference: z.string().trim().min(1).max(200),
    observedOutcome: z.enum(["confirmed", "unknown"]),
    occurredAt: z.iso.datetime({ offset: true }).nullable(),
    reason: z.string().trim().min(10).max(1_000),
    idempotencyKey: z.string().min(8).max(128),
  })
  .superRefine((value, context) => {
    if (value.observedOutcome === "confirmed" && !value.occurredAt) {
      context.addIssue({
        code: "custom",
        path: ["occurredAt"],
        message: "Confirmed outflow requires an occurrence time",
      });
    }
    if (value.observedOutcome === "unknown" && value.occurredAt) {
      context.addIssue({
        code: "custom",
        path: ["occurredAt"],
        message: "Unknown outflow must not invent an occurrence time",
      });
    }
  });

const outflowReconciliationSchema = z
  .object({
    outcome: z.enum(["confirm_outflow", "confirm_no_outflow"]),
    occurredAt: z.iso.datetime({ offset: true }).nullable(),
    reason: z.string().trim().min(10).max(1_000),
    idempotencyKey: z.string().min(8).max(128),
  })
  .superRefine((value, context) => {
    if (value.outcome === "confirm_outflow" && !value.occurredAt) {
      context.addIssue({
        code: "custom",
        path: ["occurredAt"],
        message: "Confirmed outflow requires an occurrence time",
      });
    }
    if (value.outcome === "confirm_no_outflow" && value.occurredAt) {
      context.addIssue({
        code: "custom",
        path: ["occurredAt"],
        message: "No-outflow reconciliation must not invent an occurrence time",
      });
    }
  });

type OriginalSource = {
  manual_receipt_id: string;
  fund_receipt_id: string;
  client_account_id: string;
  currency: string;
  received_at: Date;
  source_amount_minor: string;
  confirmed_outflow_minor: string;
  capacity_frozen: boolean;
  available_minor: string;
};

type StoredOutcome = Record<string, unknown>;

async function requireOutflowStaffActionLocked(
  client: DatabaseClient,
  user: AuthenticatedUser,
): Promise<string> {
  await requireStaffActionLocked(client, user, "billing.manual_receipt_manage");
  await requireStaffActionLocked(client, user, "billing.refund_manage");
  return requireRecentReauthLocked(client, user);
}

async function lockOriginalSource(
  client: DatabaseClient,
  clientAccountId: string,
  manualReceiptId: string,
): Promise<OriginalSource> {
  const locked = await client.query(
    `SELECT receipt.id
     FROM manual_receipt_facts fact
     JOIN fund_receipts receipt ON receipt.reported_manual_receipt_id = fact.id
     WHERE fact.id = $1 AND fact.client_account_id = $2
     FOR UPDATE OF fact, receipt`,
    [manualReceiptId, clientAccountId],
  );
  if (locked.rowCount !== 1) {
    throw Object.assign(new Error("Manual receipt not found"), { statusCode: 404 });
  }
  const source = await client.query<OriginalSource>(
    `SELECT capacity.manual_receipt_id,
            capacity.fund_receipt_id,
            capacity.client_account_id,
            capacity.currency,
            fact.received_at,
            capacity.source_amount_minor::text,
            capacity.confirmed_outflow_minor::text,
            capacity.capacity_frozen,
            capacity.available_minor::text
     FROM manual_receipt_outflow_capacity capacity
     JOIN manual_receipt_facts fact ON fact.id = capacity.manual_receipt_id
     WHERE capacity.manual_receipt_id = $1
       AND capacity.client_account_id = $2
       AND capacity.source_context = 'unclaimed_funds'
       AND capacity.fund_receipt_resolution_id IS NULL`,
    [manualReceiptId, clientAccountId],
  );
  const row = source.rows[0];
  if (!row) throw new Error("Manual receipt original-source capacity is unavailable");
  return row;
}

async function recordOriginalSourceOutflow(
  client: DatabaseClient,
  input: {
    outflowId: string;
    reportId: string;
    source: OriginalSource;
    amountMinor: string;
    destinationReference: string;
    occurredAt: Date;
    actorId: string;
    actorSessionId: string;
    reauthGrantId: string;
    reason: string;
    idempotencyKey: string;
    fingerprint: string;
    result: StoredOutcome;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO manual_receipt_outflows(
       id, report_id, manual_receipt_id, fund_receipt_id, client_account_id,
       source_context, fund_receipt_resolution_id, amount_minor, currency,
       destination_reference, occurred_at, actor_id, actor_session_id,
       reauth_grant_id, reason, idempotency_key, request_fingerprint, result
     ) VALUES (
       $1, $2, $3, $4, $5,
       'unclaimed_funds', NULL, $6, $7,
       $8, $9, $10, $11,
       $12, $13, $14, $15, $16
     )`,
    [
      input.outflowId,
      input.reportId,
      input.source.manual_receipt_id,
      input.source.fund_receipt_id,
      input.source.client_account_id,
      input.amountMinor,
      input.source.currency,
      input.destinationReference,
      input.occurredAt,
      input.actorId,
      input.actorSessionId,
      input.reauthGrantId,
      input.reason,
      input.idempotencyKey,
      input.fingerprint,
      input.result,
    ],
  );
  const journal = await client.query<{ id: string }>(
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES (
       'manual_receipt_outflow', $1, $2,
       'Audited manual receipt return to its original source'
     ) RETURNING id`,
    [input.outflowId, input.source.currency],
  );
  const journalId = journal.rows[0]?.id;
  if (!journalId) throw new Error("Unable to create manual receipt outflow journal");
  await client.query(
    `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
     VALUES
       ($1, 'unclaimed_funds_liability', $2, 0),
       ($1, 'cash_clearing', 0, $2)`,
    [journalId, input.amountMinor],
  );
  await client.query("UPDATE ledger_journals SET sealed_at = now() WHERE id = $1", [
    journalId,
  ]);
}

export async function registerManualReceiptOutflowRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.post(
    "/api/v1/admin/client-accounts/:clientAccountId/manual-receipts/:manualReceiptId/outflow-reports",
    async (request, reply) => {
      const user = await requireUser(request, pool, config);
      await requireStaffPermission(pool, user, "billing.manual_receipt_manage");
      await requireStaffPermission(pool, user, "billing.refund_manage");
      await requireRecentReauth(pool, user);
      const params = z
        .object({ clientAccountId: canonicalUuid, manualReceiptId: canonicalUuid })
        .parse(request.params);
      const body = outflowReportSchema.parse(request.body);
      const amount = BigInt(body.amountMinor);
      const expectedAvailable = BigInt(body.expectedAvailableMinor);
      if (amount > POSTGRES_BIGINT_MAX || expectedAvailable > POSTGRES_BIGINT_MAX) {
        throw Object.assign(new Error("Outflow amount is outside the supported range"), {
          statusCode: 400,
          code: "MANUAL_RECEIPT_OUTFLOW_AMOUNT_OUT_OF_RANGE",
        });
      }
      const occurredAt = body.occurredAt ? new Date(body.occurredAt) : null;
      if (occurredAt && occurredAt.getTime() > Date.now() + 5 * 60_000) {
        throw Object.assign(new Error("Outflow occurrence time cannot be in the future"), {
          statusCode: 400,
          code: "MANUAL_RECEIPT_OUTFLOW_FUTURE_DATE",
        });
      }
      const fingerprint = requestFingerprint("admin.manual-receipt-outflow-report:v1", {
        clientAccountId: params.clientAccountId,
        manualReceiptId: params.manualReceiptId,
        sourceContext: "unclaimed_funds",
        expectedAvailableMinor: body.expectedAvailableMinor,
        amountMinor: body.amountMinor,
        currency: body.currency,
        destination: body.destination,
        destinationReference: body.destinationReference,
        observedOutcome: body.observedOutcome,
        occurredAt: occurredAt?.toISOString() ?? null,
        reason: body.reason,
      });

      const outcome = await transaction(pool, async (client) => {
        const locks = [
          `manual-receipt-outflow:idempotency:${body.idempotencyKey}`,
          `manual-receipt-outflow:source:${params.manualReceiptId}`,
        ].sort();
        for (const lock of locks) {
          await client.query(
            "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
            [lock],
          );
        }

        const replayByKey = await client.query<{
          manual_receipt_id: string;
          client_account_id: string;
          request_fingerprint: string;
          result: StoredOutcome;
        }>(
          `SELECT manual_receipt_id, client_account_id, request_fingerprint, result
           FROM manual_receipt_outflow_reports
           WHERE idempotency_key = $1
           FOR UPDATE`,
          [body.idempotencyKey],
        );
        const keyReplay = replayByKey.rows[0];
        if (keyReplay) {
          if (
            keyReplay.manual_receipt_id !== params.manualReceiptId ||
            keyReplay.client_account_id !== params.clientAccountId ||
            keyReplay.request_fingerprint !== fingerprint
          ) {
            throw Object.assign(
              new Error("The idempotency key was used for a different outflow report"),
              { statusCode: 409, code: "IDEMPOTENCY_CONFLICT" },
            );
          }
          await requireOutflowStaffActionLocked(client, user);
          return { ...keyReplay.result, replayed: true };
        }

        const semanticReplay = await client.query<{ result: StoredOutcome }>(
          `SELECT result
           FROM manual_receipt_outflow_reports
           WHERE manual_receipt_id = $1 AND request_fingerprint = $2
           FOR UPDATE`,
          [params.manualReceiptId, fingerprint],
        );
        if (semanticReplay.rows[0]) {
          await requireOutflowStaffActionLocked(client, user);
          return { ...semanticReplay.rows[0].result, replayed: true };
        }

        const reauthGrantId = await requireOutflowStaffActionLocked(client, user);
        const source = await lockOriginalSource(
          client,
          params.clientAccountId,
          params.manualReceiptId,
        );
        if (source.currency !== body.currency) {
          throw Object.assign(new Error("Outflow currency does not match the manual receipt"), {
            statusCode: 409,
            code: "MANUAL_RECEIPT_OUTFLOW_SOURCE_MISMATCH",
          });
        }
        if (source.available_minor !== body.expectedAvailableMinor) {
          throw Object.assign(
            new Error("Original-source capacity changed; refresh and review again"),
            { statusCode: 409, code: "MANUAL_RECEIPT_OUTFLOW_STALE" },
          );
        }
        if (source.capacity_frozen) {
          throw Object.assign(
            new Error("Original-source capacity is frozen by unresolved outflow evidence"),
            { statusCode: 409, code: "MANUAL_RECEIPT_OUTFLOW_RECONCILIATION_REQUIRED" },
          );
        }
        if (amount > BigInt(source.available_minor)) {
          throw Object.assign(
            new Error("Outflow exceeds the reviewed original-source capacity"),
            { statusCode: 409, code: "MANUAL_RECEIPT_OUTFLOW_CAPACITY_EXCEEDED" },
          );
        }
        if (occurredAt && occurredAt < source.received_at) {
          throw Object.assign(
            new Error("Outflow cannot occur before the manual receipt was received"),
            { statusCode: 409, code: "MANUAL_RECEIPT_OUTFLOW_SOURCE_MISMATCH" },
          );
        }
        const destinationConflict = await client.query(
          `SELECT id
           FROM manual_receipt_outflow_reports
           WHERE manual_receipt_id = $1 AND destination_reference = $2
           FOR UPDATE`,
          [params.manualReceiptId, body.destinationReference],
        );
        if (destinationConflict.rowCount !== 0) {
          throw Object.assign(
            new Error("This original-source destination reference was already reported"),
            { statusCode: 409, code: "MANUAL_RECEIPT_OUTFLOW_DESTINATION_CONFLICT" },
          );
        }

        const reportId = randomUUID();
        const outflowId = body.observedOutcome === "confirmed" ? randomUUID() : null;
        const result = {
          outflowReportId: reportId,
          outflowId,
          reconciliationId: null,
          manualReceiptId: source.manual_receipt_id,
          fundReceiptId: source.fund_receipt_id,
          clientAccountId: source.client_account_id,
          sourceContext: "unclaimed_funds" as const,
          amountMinor: body.amountMinor,
          currency: body.currency,
          destination: "original_source" as const,
          destinationReference: body.destinationReference,
          status: body.observedOutcome,
          observedOutcome: body.observedOutcome,
          occurredAt: occurredAt?.toISOString() ?? null,
          providerUsed: false as const,
        };
        await client.query(
          `INSERT INTO manual_receipt_outflow_reports(
             id, manual_receipt_id, fund_receipt_id, client_account_id,
             source_context, fund_receipt_resolution_id, amount_minor, currency,
             destination, destination_reference, observed_outcome, occurred_at,
             actor_id, actor_session_id, reauth_grant_id, reason,
             idempotency_key, request_fingerprint, result
           ) VALUES (
             $1, $2, $3, $4,
             'unclaimed_funds', NULL, $5, $6,
             'original_source', $7, $8, $9,
             $10, $11, $12, $13,
             $14, $15, $16
           )`,
          [
            reportId,
            source.manual_receipt_id,
            source.fund_receipt_id,
            source.client_account_id,
            body.amountMinor,
            body.currency,
            body.destinationReference,
            body.observedOutcome,
            occurredAt,
            user.userId,
            user.sessionId,
            reauthGrantId,
            body.reason,
            body.idempotencyKey,
            fingerprint,
            result,
          ],
        );
        if (outflowId && occurredAt) {
          await recordOriginalSourceOutflow(client, {
            outflowId,
            reportId,
            source,
            amountMinor: body.amountMinor,
            destinationReference: body.destinationReference,
            occurredAt,
            actorId: user.userId,
            actorSessionId: user.sessionId,
            reauthGrantId,
            reason: body.reason,
            idempotencyKey: body.idempotencyKey,
            fingerprint,
            result,
          });
        }
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, reason, metadata
           ) VALUES (
             'staff', $1, 'billing.manual_receipt_outflow_reported',
             'manual_receipt_outflow_report', $2, $3, $4
           )`,
          [user.userId, reportId, body.reason, result],
        );
        return { ...result, replayed: false };
      });
      return reply.code(outcome.replayed ? 200 : 201).send(outcome);
    },
  );

  app.post(
    "/api/v1/admin/client-accounts/:clientAccountId/manual-receipts/:manualReceiptId/outflow-reports/:reportId/reconciliation",
    async (request, reply) => {
      const user = await requireUser(request, pool, config);
      await requireStaffPermission(pool, user, "billing.manual_receipt_manage");
      await requireStaffPermission(pool, user, "billing.refund_manage");
      await requireRecentReauth(pool, user);
      const params = z
        .object({
          clientAccountId: canonicalUuid,
          manualReceiptId: canonicalUuid,
          reportId: canonicalUuid,
        })
        .parse(request.params);
      const body = outflowReconciliationSchema.parse(request.body);
      const occurredAt = body.occurredAt ? new Date(body.occurredAt) : null;
      if (occurredAt && occurredAt.getTime() > Date.now() + 5 * 60_000) {
        throw Object.assign(new Error("Outflow occurrence time cannot be in the future"), {
          statusCode: 400,
          code: "MANUAL_RECEIPT_OUTFLOW_FUTURE_DATE",
        });
      }
      const fingerprint = requestFingerprint("admin.manual-receipt-outflow-reconciliation:v1", {
        clientAccountId: params.clientAccountId,
        manualReceiptId: params.manualReceiptId,
        reportId: params.reportId,
        outcome: body.outcome,
        occurredAt: occurredAt?.toISOString() ?? null,
        reason: body.reason,
      });

      const outcome = await transaction(pool, async (client) => {
        const locks = [
          `manual-receipt-outflow-reconciliation:idempotency:${body.idempotencyKey}`,
          `manual-receipt-outflow:source:${params.manualReceiptId}`,
        ].sort();
        for (const lock of locks) {
          await client.query(
            "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
            [lock],
          );
        }

        const replayByKey = await client.query<{
          report_id: string;
          request_fingerprint: string;
          result: StoredOutcome;
        }>(
          `SELECT report_id, request_fingerprint, result
           FROM manual_receipt_outflow_reconciliations
           WHERE idempotency_key = $1
           FOR UPDATE`,
          [body.idempotencyKey],
        );
        const keyReplay = replayByKey.rows[0];
        if (keyReplay) {
          if (
            keyReplay.report_id !== params.reportId ||
            keyReplay.request_fingerprint !== fingerprint
          ) {
            throw Object.assign(
              new Error("The idempotency key was used for a different reconciliation"),
              { statusCode: 409, code: "IDEMPOTENCY_CONFLICT" },
            );
          }
          await requireOutflowStaffActionLocked(client, user);
          return { ...keyReplay.result, replayed: true };
        }

        const reauthGrantId = await requireOutflowStaffActionLocked(client, user);
        const reportResult = await client.query<{
          id: string;
          manual_receipt_id: string;
          fund_receipt_id: string;
          client_account_id: string;
          amount_minor: string;
          currency: string;
          destination_reference: string;
          observed_outcome: string;
          created_at: Date;
        }>(
          `SELECT report.id, report.manual_receipt_id, report.fund_receipt_id,
                  report.client_account_id, report.amount_minor::text,
                  report.currency, report.destination_reference,
                  report.observed_outcome, report.created_at
           FROM manual_receipt_outflow_reports report
           JOIN fund_receipts receipt ON receipt.id = report.fund_receipt_id
           WHERE report.id = $1
             AND report.manual_receipt_id = $2
             AND report.client_account_id = $3
             AND report.source_context = 'unclaimed_funds'
             AND report.fund_receipt_resolution_id IS NULL
             AND report.destination = 'original_source'
           FOR UPDATE OF report, receipt`,
          [params.reportId, params.manualReceiptId, params.clientAccountId],
        );
        const report = reportResult.rows[0];
        if (!report) {
          throw Object.assign(new Error("Outflow report not found"), { statusCode: 404 });
        }
        if (report.observed_outcome !== "unknown") {
          throw Object.assign(new Error("Only an unknown report can be reconciled"), {
            statusCode: 409,
            code: "MANUAL_RECEIPT_OUTFLOW_NOT_UNKNOWN",
          });
        }
        const existing = await client.query<{
          request_fingerprint: string;
          result: StoredOutcome;
        }>(
          `SELECT request_fingerprint, result
           FROM manual_receipt_outflow_reconciliations
           WHERE report_id = $1
           FOR UPDATE`,
          [params.reportId],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_fingerprint === fingerprint) {
            return { ...existing.rows[0].result, replayed: true };
          }
          throw Object.assign(new Error("This unknown outflow was already reconciled"), {
            statusCode: 409,
            code: "MANUAL_RECEIPT_OUTFLOW_ALREADY_RECONCILED",
          });
        }
        if (occurredAt && occurredAt < report.created_at) {
          throw Object.assign(
            new Error("Confirmed occurrence time cannot predate the unknown report"),
            { statusCode: 409, code: "MANUAL_RECEIPT_OUTFLOW_SOURCE_MISMATCH" },
          );
        }
        const source = await lockOriginalSource(
          client,
          params.clientAccountId,
          params.manualReceiptId,
        );
        const reconciliationId = randomUUID();
        const outflowId = body.outcome === "confirm_outflow" ? randomUUID() : null;
        const result = {
          outflowReportId: report.id,
          outflowId,
          reconciliationId,
          manualReceiptId: report.manual_receipt_id,
          fundReceiptId: report.fund_receipt_id,
          clientAccountId: report.client_account_id,
          sourceContext: "unclaimed_funds" as const,
          amountMinor: report.amount_minor,
          currency: report.currency,
          destination: "original_source" as const,
          destinationReference: report.destination_reference,
          status: body.outcome === "confirm_outflow" ? "confirmed_outflow" : "no_outflow",
          observedOutcome: "unknown" as const,
          occurredAt: occurredAt?.toISOString() ?? null,
          providerUsed: false as const,
        };
        await client.query(
          `INSERT INTO manual_receipt_outflow_reconciliations(
             id, report_id, outcome, occurred_at, actor_id, actor_session_id,
             reauth_grant_id, reason, idempotency_key, request_fingerprint, result
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            reconciliationId,
            report.id,
            body.outcome,
            occurredAt,
            user.userId,
            user.sessionId,
            reauthGrantId,
            body.reason,
            body.idempotencyKey,
            fingerprint,
            result,
          ],
        );
        if (outflowId && occurredAt) {
          await recordOriginalSourceOutflow(client, {
            outflowId,
            reportId: report.id,
            source,
            amountMinor: report.amount_minor,
            destinationReference: report.destination_reference,
            occurredAt,
            actorId: user.userId,
            actorSessionId: user.sessionId,
            reauthGrantId,
            reason: body.reason,
            idempotencyKey: body.idempotencyKey,
            fingerprint,
            result,
          });
        }
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, reason, metadata
           ) VALUES (
             'staff', $1, 'billing.manual_receipt_outflow_reconciled',
             'manual_receipt_outflow_report', $2, $3, $4
           )`,
          [user.userId, report.id, body.reason, result],
        );
        return { ...result, replayed: false };
      });
      return reply.code(outcome.replayed ? 200 : 201).send(outcome);
    },
  );
}
