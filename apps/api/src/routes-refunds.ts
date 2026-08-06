// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabaseClient, type DatabasePool } from "./database.js";
import { requestFingerprint } from "./idempotency.js";
import { freezeCompetingRefunds } from "./refund-safety.js";
import {
  requireRecentReauth,
  requireStaffActionLocked,
  requireStaffPermission,
} from "./routes-admin.js";

const canonicalUuid = z.uuid().transform((value) => value.toLowerCase());
const positiveMinor = z.string().regex(/^[1-9]\d*$/);

const refundRequestSchema = z
  .object({
    receiptId: canonicalUuid,
    destination: z.enum(["original_payment", "credit", "none", "third_party"]),
    amountMode: z.enum(["full", "partial", "none"]),
    amountMinor: positiveMinor.nullable().default(null),
    expectedRefundableMinor: positiveMinor.nullable().default(null),
    scenario: z
      .enum(["success", "failed", "timeout_success", "duplicate_out_of_order"])
      .nullable()
      .default(null),
    reason: z.string().trim().min(10).max(1_000),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.destination === "third_party") return;
    if (value.destination === "none") {
      if (
        value.amountMode !== "none" ||
        value.amountMinor !== null ||
        value.expectedRefundableMinor !== null ||
        value.scenario !== null
      ) {
        context.addIssue({
          code: "custom",
          message:
            "No-refund decisions cannot contain an amount, refundable snapshot, or Provider scenario",
        });
      }
      return;
    }
    if (value.expectedRefundableMinor === null) {
      context.addIssue({
        code: "custom",
        path: ["expectedRefundableMinor"],
        message: "A monetary refund requires the administrator's refundable-amount snapshot",
      });
    }
    if (value.amountMode === "none") {
      context.addIssue({
        code: "custom",
        path: ["amountMode"],
        message: "A monetary refund must be full or partial",
      });
    }
    if (value.amountMode === "partial" && value.amountMinor === null) {
      context.addIssue({
        code: "custom",
        path: ["amountMinor"],
        message: "A partial refund requires an amount",
      });
    }
    if (value.amountMode === "full" && value.amountMinor !== null) {
      context.addIssue({
        code: "custom",
        path: ["amountMinor"],
        message: "A full refund uses the current server-calculated maximum",
      });
    }
    if (value.destination === "original_payment" && value.scenario === null) {
      context.addIssue({
        code: "custom",
        path: ["scenario"],
        message: "The laboratory Provider scenario is required",
      });
    }
    if (value.destination === "credit" && value.scenario !== null) {
      context.addIssue({
        code: "custom",
        path: ["scenario"],
        message: "A Credit refund does not call a Payment Provider",
      });
    }
  });

const refundHoldAdjudicationSchema = z
  .object({
    decision: z.enum([
      "accept_authorized_outflow",
      "record_unexpected_outflow",
      "dismiss_provider_claim",
    ]),
    reason: z.string().trim().min(10).max(1_000),
    idempotencyKey: z.string().min(8).max(128),
    expectedRefundVersion: z.number().int().positive(),
  })
  .strict();

const refundManualActionSchema = z
  .object({
    action: z.enum(["retry_query", "confirm_no_outflow"]),
    reason: z.string().trim().min(10).max(1_000),
    idempotencyKey: z.string().min(8).max(128),
    expectedRefundVersion: z.number().int().positive(),
  })
  .strict();

const refundAdjudicationCorrectionSchema = z
  .object({
    reason: z.string().trim().min(10).max(1_000),
    idempotencyKey: z.string().min(8).max(128),
    expectedRefundVersion: z.number().int().positive(),
  })
  .strict();

type RefundSecurityHoldRow = {
  hold_id: string;
  receipt_id: string;
  receipt_amount_minor: string;
  confirmed_settlement_minor: string;
  refund_id: string;
  invoice_id: string;
  client_account_id: string;
  client_account_name: string;
  refund_status: string;
  refund_version: number;
  refund_security_hold: boolean;
  refund_amount_minor: string;
  refund_currency: string;
  hold_reason: string;
  hold_created_at: Date;
  provider_fact_id: string;
  external_event_id: string;
  external_refund_id: string;
  provider_fact_status: "succeeded" | "failed";
  provider_amount_minor: string;
  provider_currency: string;
  provider_occurred_at: Date;
  discrepancy_id: string | null;
  discrepancy_provider_fact_id: string | null;
  discrepancy_external_refund_id: string | null;
  discrepancy_amount_minor: string | null;
  discrepancy_currency: string | null;
  discrepancy_occurred_at: Date | null;
  provider_facts: Array<{
    factId: string;
    eventId: string;
    externalRefundId: string;
    status: "succeeded" | "failed";
    amountMinor: string;
    currency: string;
    occurredAt: string;
  }>;
  existing_settlement_id: string | null;
  provider_operation_id: string;
  provider_operation_status: string;
  provider_operation_attempt_count: number;
};

type RefundHoldAdjudicationRow = {
  id: string;
  receipt_security_hold_id: string;
  refund_id: string;
  decision:
    | "accept_authorized_outflow"
    | "record_unexpected_outflow"
    | "dismiss_provider_claim";
  discrepancy_settlement_id: string | null;
  reason: string;
  request_fingerprint: string;
  created_at: Date;
};

type RefundManualActionRow = {
  id: string;
  refund_id: string;
  action: "retry_query" | "confirm_no_outflow";
  reason: string;
  idempotency_key: string;
  request_fingerprint: string;
  created_at: Date;
};

type RefundAdjudicationCorrectionRow = {
  id: string;
  adjudication_id: string;
  refund_id: string;
  discrepancy_settlement_id: string;
  reason: string;
  request_fingerprint: string;
  created_at: Date;
};

type RefundDismissalCorrectionRow = {
  adjudication_id: string;
  hold_id: string;
  refund_id: string;
  refund_version: number;
  invoice_id: string;
  client_account_id: string;
  client_account_name: string;
  receipt_id: string;
  provider_installation_id: string;
  provider_fact_id: string;
  external_event_id: string;
  external_refund_id: string;
  amount_minor: string;
  currency: string;
  occurred_at: Date;
  discrepancy_id: string | null;
  dismissal_reason: string;
  dismissed_at: Date;
};

type RefundRow = {
  id: string;
  invoice_id: string;
  client_account_id: string;
  source_fund_receipt_id: string;
  provider_installation_id: string | null;
  original_external_payment_id: string | null;
  destination: "original_payment" | "credit" | "none";
  amount_mode: "full" | "partial" | "none";
  amount_minor: string;
  currency: string;
  status: string;
  security_hold: boolean;
  receipt_security_hold?: boolean;
  receipt_security_hold_reason?: string | null;
  receipt_security_hold_created_at?: Date | null;
  scenario: string | null;
  reason: string;
  request_fingerprint: string;
  result: Record<string, unknown>;
  last_error: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  provider_operation_id?: string | null;
  provider_operation_status?: string | null;
  external_refund_id?: string | null;
};

function refundResponse(row: RefundRow, replayed: boolean): Record<string, unknown> {
  return {
    warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
    refundId: row.id,
    invoiceId: row.invoice_id,
    receiptId: row.source_fund_receipt_id,
    clientAccountId: row.client_account_id,
    destination: row.destination,
    amountMode: row.amount_mode,
    amountMinor: row.amount_minor,
    currency: row.currency,
    status: row.status,
    securityHold: row.security_hold || row.receipt_security_hold === true,
    securityHoldReason: row.receipt_security_hold_reason ?? row.last_error,
    securityHoldCreatedAt: row.receipt_security_hold_created_at?.toISOString() ?? null,
    scenario: row.scenario,
    reason: row.reason,
    result: row.result,
    lastError: row.last_error,
    version: row.version,
    providerOperationId: row.provider_operation_id ?? null,
    providerOperationStatus: row.provider_operation_status ?? null,
    externalRefundId: row.external_refund_id ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    replayed,
  };
}

function refundSecurityHoldResponse(row: RefundSecurityHoldRow): Record<string, unknown> {
  const exactAuthorizedDiscrepancy =
    row.discrepancy_id !== null &&
    row.discrepancy_external_refund_id !== null &&
    row.discrepancy_occurred_at !== null &&
    row.discrepancy_amount_minor === row.refund_amount_minor &&
    row.discrepancy_currency === row.refund_currency &&
    row.existing_settlement_id === null &&
    BigInt(row.confirmed_settlement_minor) + BigInt(row.refund_amount_minor) <=
      BigInt(row.receipt_amount_minor);
  return {
    holdId: row.hold_id,
    receiptId: row.receipt_id,
    receiptAmountMinor: row.receipt_amount_minor,
    confirmedSettlementMinor: row.confirmed_settlement_minor,
    refundId: row.refund_id,
    invoiceId: row.invoice_id,
    clientAccountId: row.client_account_id,
    clientAccountName: row.client_account_name,
    refundStatus: row.refund_status,
    refundVersion: row.refund_version,
    refundSecurityHold: row.refund_security_hold,
    refundAmountMinor: row.refund_amount_minor,
    refundCurrency: row.refund_currency,
    reason: row.hold_reason,
    createdAt: row.hold_created_at.toISOString(),
    providerFact: {
      factId: row.provider_fact_id,
      eventId: row.external_event_id,
      externalRefundId: row.external_refund_id,
      status: row.provider_fact_status,
      amountMinor: row.provider_amount_minor,
      currency: row.provider_currency,
      occurredAt: row.provider_occurred_at.toISOString(),
    },
    providerFacts: row.provider_facts,
    discrepancy: row.discrepancy_id
      ? {
          discrepancyId: row.discrepancy_id,
          providerFactId: row.discrepancy_provider_fact_id,
          externalRefundId: row.discrepancy_external_refund_id,
          amountMinor: row.discrepancy_amount_minor,
          currency: row.discrepancy_currency,
          occurredAt: row.discrepancy_occurred_at?.toISOString() ?? null,
          cashAlreadyPosted: true,
        }
      : null,
    providerOperation: {
      operationId: row.provider_operation_id,
      status: row.provider_operation_status,
      attemptCount: row.provider_operation_attempt_count,
    },
    allowedDecisions: [
      ...(exactAuthorizedDiscrepancy && row.refund_status === "manual"
        ? ["accept_authorized_outflow"]
        : []),
      ...(row.provider_fact_status === "succeeded" ? ["record_unexpected_outflow"] : []),
      "dismiss_provider_claim",
    ],
    impact: exactAuthorizedDiscrepancy
      ? {
          acceptAuthorizedOutflow:
            "Reclassifies discrepancy suspense to sales refunds; mock cash is not reduced again.",
          recordUnexpectedOutflow:
            "Keeps the verified cash outflow in discrepancy suspense without settling the refund.",
          dismissProviderClaim:
            "Posts a compensating cash/suspense journal and does not settle the refund.",
        }
      : {
          ...(row.provider_fact_status === "succeeded"
            ? {
                recordUnexpectedOutflow:
                  "Records the verified cash reduction in discrepancy suspense without settling the refund.",
              }
            : {}),
          dismissProviderClaim:
            "Closes this claim without a financial journal; immutable Provider facts remain visible.",
        },
  };
}

function refundAdjudicationResponse(
  row: RefundHoldAdjudicationRow,
  replayed: boolean,
): Record<string, unknown> {
  return {
    warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
    adjudicationId: row.id,
    holdId: row.receipt_security_hold_id,
    refundId: row.refund_id,
    decision: row.decision,
    discrepancySettlementId: row.discrepancy_settlement_id,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
    replayed,
  };
}

async function lockInvoice(client: DatabaseClient, invoiceId: string): Promise<void> {
  const result = await client.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [invoiceId]);
  if (result.rowCount !== 1) {
    throw Object.assign(new Error("Invoice not found"), { statusCode: 404 });
  }
}

async function readRefund(client: DatabaseClient, refundId: string): Promise<RefundRow> {
  const result = await client.query<RefundRow>(
    `SELECT
       refund.*,
       operation.id AS provider_operation_id,
       operation.status AS provider_operation_status,
       settlement.external_refund_id,
       EXISTS (
         SELECT 1
         FROM refund_receipt_security_holds security_hold
         WHERE security_hold.source_fund_receipt_id = refund.source_fund_receipt_id
           AND NOT EXISTS (
             SELECT 1 FROM refund_security_hold_adjudications adjudication
             WHERE adjudication.receipt_security_hold_id = security_hold.id
           )
       ) AS receipt_security_hold,
       (
         SELECT security_hold.reason
         FROM refund_receipt_security_holds security_hold
         WHERE security_hold.source_fund_receipt_id = refund.source_fund_receipt_id
           AND NOT EXISTS (
             SELECT 1 FROM refund_security_hold_adjudications adjudication
             WHERE adjudication.receipt_security_hold_id = security_hold.id
           )
         ORDER BY security_hold.created_at DESC, security_hold.id DESC
         LIMIT 1
       ) AS receipt_security_hold_reason,
       (
         SELECT security_hold.created_at
         FROM refund_receipt_security_holds security_hold
         WHERE security_hold.source_fund_receipt_id = refund.source_fund_receipt_id
           AND NOT EXISTS (
             SELECT 1 FROM refund_security_hold_adjudications adjudication
             WHERE adjudication.receipt_security_hold_id = security_hold.id
           )
         ORDER BY security_hold.created_at DESC, security_hold.id DESC
         LIMIT 1
       ) AS receipt_security_hold_created_at
     FROM refunds refund
     LEFT JOIN provider_operations operation
       ON operation.subject_type = 'refund'
      AND operation.subject_id = refund.id
      AND operation.kind = 'refund_create'
     LEFT JOIN refund_settlements settlement ON settlement.refund_id = refund.id
     WHERE refund.id = $1`,
    [refundId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Refund disappeared");
  return row;
}

async function postRefundJournal(
  client: DatabaseClient,
  refundId: string,
  currency: string,
  amountMinor: string,
  destination: "original_payment" | "credit",
): Promise<void> {
  const journal = await client.query<{ id: string }>(
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES ('refund', $1, $2, 'Confirmed manual refund')
     RETURNING id`,
    [refundId, currency],
  );
  const journalId = journal.rows[0]?.id;
  if (!journalId) throw new Error("Unable to create refund journal");
  await client.query(
    `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
     VALUES ($1, 'sales_refunds_and_allowances', $2, 0),
            ($1, $3, 0, $2)`,
    [
      journalId,
      amountMinor,
      destination === "credit" ? "client_credit_liability" : "mock_cash",
    ],
  );
}

async function readActiveRefundSecurityHold(
  client: DatabaseClient,
  holdId: string,
  lock: boolean,
): Promise<RefundSecurityHoldRow | null> {
  const result = await client.query<RefundSecurityHoldRow>(
    `SELECT
       security_hold.id AS hold_id,
       security_hold.source_fund_receipt_id AS receipt_id,
       receipt.amount_minor::text AS receipt_amount_minor,
       COALESCE((
         SELECT sum(confirmed.amount_minor)
         FROM (
           SELECT settlement.amount_minor
           FROM refunds related_refund
           JOIN refund_settlements settlement ON settlement.refund_id = related_refund.id
           WHERE related_refund.source_fund_receipt_id = receipt.id
           UNION ALL
           SELECT discrepancy.amount_minor
           FROM refunds related_refund
           JOIN refund_discrepancy_settlements discrepancy
             ON discrepancy.refund_id = related_refund.id
           JOIN refund_security_hold_adjudications adjudication
             ON adjudication.discrepancy_settlement_id = discrepancy.id
            AND adjudication.decision = 'record_unexpected_outflow'
           WHERE related_refund.source_fund_receipt_id = receipt.id
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
         ) confirmed
       ), 0)::text AS confirmed_settlement_minor,
       security_hold.refund_id,
       refund.invoice_id,
       refund.client_account_id,
       account.name AS client_account_name,
       refund.status AS refund_status,
       refund.version AS refund_version,
       refund.security_hold AS refund_security_hold,
       refund.amount_minor::text AS refund_amount_minor,
       refund.currency AS refund_currency,
       security_hold.reason AS hold_reason,
       security_hold.created_at AS hold_created_at,
       fact.id AS provider_fact_id,
       fact.external_event_id,
       fact.external_refund_id,
       fact.status AS provider_fact_status,
       fact.amount_minor::text AS provider_amount_minor,
       fact.currency AS provider_currency,
       fact.occurred_at AS provider_occurred_at,
       discrepancy.id AS discrepancy_id,
       discrepancy.refund_provider_fact_id AS discrepancy_provider_fact_id,
       discrepancy.external_refund_id AS discrepancy_external_refund_id,
       discrepancy.amount_minor::text AS discrepancy_amount_minor,
       discrepancy.currency AS discrepancy_currency,
       discrepancy.occurred_at AS discrepancy_occurred_at,
       COALESCE((
         SELECT jsonb_agg(
           jsonb_build_object(
             'factId', related_fact.id,
             'eventId', related_fact.external_event_id,
             'externalRefundId', related_fact.external_refund_id,
             'status', related_fact.status,
             'amountMinor', related_fact.amount_minor::text,
             'currency', related_fact.currency,
             'occurredAt', related_fact.occurred_at
           )
           ORDER BY related_fact.created_at, related_fact.id
         )
         FROM refund_provider_facts related_fact
         WHERE related_fact.refund_id = refund.id
       ), '[]'::jsonb) AS provider_facts,
       settlement.id AS existing_settlement_id,
       operation.id AS provider_operation_id,
       operation.status AS provider_operation_status,
       operation.attempt_count AS provider_operation_attempt_count
     FROM refund_receipt_security_holds security_hold
     JOIN fund_receipts receipt ON receipt.id = security_hold.source_fund_receipt_id
     JOIN refunds refund ON refund.id = security_hold.refund_id
     JOIN client_accounts account ON account.id = refund.client_account_id
     JOIN refund_provider_facts fact ON fact.id = security_hold.refund_provider_fact_id
     JOIN provider_operations operation
       ON operation.subject_type = 'refund'
      AND operation.subject_id = refund.id
      AND operation.kind = 'refund_create'
     LEFT JOIN refund_discrepancy_settlements discrepancy
       ON discrepancy.refund_provider_fact_id = security_hold.refund_provider_fact_id
     LEFT JOIN refund_settlements settlement ON settlement.refund_id = refund.id
     WHERE security_hold.id = $1
       AND NOT EXISTS (
         SELECT 1
         FROM refund_security_hold_adjudications adjudication
         WHERE adjudication.receipt_security_hold_id = security_hold.id
       )
     ${lock ? "FOR UPDATE OF security_hold, refund, operation, fact" : ""}`,
    [holdId],
  );
  return result.rows[0] ?? null;
}

async function readRefundHoldAdjudication(
  client: DatabaseClient,
  clause: "idempotency_key" | "request_fingerprint",
  value: string,
): Promise<RefundHoldAdjudicationRow | null> {
  const result = await client.query<RefundHoldAdjudicationRow>(
    `SELECT adjudication.id, adjudication.receipt_security_hold_id,
            adjudication.refund_id, adjudication.decision,
            adjudication.discrepancy_settlement_id, adjudication.reason,
            adjudication.request_fingerprint, adjudication.created_at
     FROM refund_security_hold_adjudications adjudication
     ${
       clause === "idempotency_key"
         ? "JOIN refund_security_adjudication_aliases alias ON alias.adjudication_id = adjudication.id"
         : ""
     }
     WHERE ${clause === "idempotency_key" ? "alias.idempotency_key" : "adjudication.request_fingerprint"} = $1`,
    [value],
  );
  return result.rows[0] ?? null;
}

export async function registerRefundRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get("/api/v1/admin/refund-security-holds", async (request) => {
    const user = await requireUser(request, pool, config);
    await requireStaffPermission(pool, user, "billing.refund_adjudicate");
    const result = await pool.query<RefundSecurityHoldRow>(
      `SELECT
         security_hold.id AS hold_id,
         security_hold.source_fund_receipt_id AS receipt_id,
         receipt.amount_minor::text AS receipt_amount_minor,
         COALESCE((
           SELECT sum(confirmed.amount_minor)
           FROM (
             SELECT settlement.amount_minor
             FROM refunds related_refund
             JOIN refund_settlements settlement ON settlement.refund_id = related_refund.id
             WHERE related_refund.source_fund_receipt_id = receipt.id
             UNION ALL
             SELECT discrepancy.amount_minor
             FROM refunds related_refund
             JOIN refund_discrepancy_settlements discrepancy
               ON discrepancy.refund_id = related_refund.id
             JOIN refund_security_hold_adjudications adjudication
               ON adjudication.discrepancy_settlement_id = discrepancy.id
              AND adjudication.decision = 'record_unexpected_outflow'
             WHERE related_refund.source_fund_receipt_id = receipt.id
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
           ) confirmed
         ), 0)::text AS confirmed_settlement_minor,
         security_hold.refund_id,
         refund.invoice_id,
         refund.client_account_id,
         account.name AS client_account_name,
         refund.status AS refund_status,
         refund.version AS refund_version,
         refund.security_hold AS refund_security_hold,
         refund.amount_minor::text AS refund_amount_minor,
         refund.currency AS refund_currency,
         security_hold.reason AS hold_reason,
         security_hold.created_at AS hold_created_at,
         fact.id AS provider_fact_id,
         fact.external_event_id,
         fact.external_refund_id,
         fact.status AS provider_fact_status,
         fact.amount_minor::text AS provider_amount_minor,
         fact.currency AS provider_currency,
         fact.occurred_at AS provider_occurred_at,
         discrepancy.id AS discrepancy_id,
         discrepancy.refund_provider_fact_id AS discrepancy_provider_fact_id,
         discrepancy.external_refund_id AS discrepancy_external_refund_id,
         discrepancy.amount_minor::text AS discrepancy_amount_minor,
         discrepancy.currency AS discrepancy_currency,
         discrepancy.occurred_at AS discrepancy_occurred_at,
         COALESCE((
           SELECT jsonb_agg(
             jsonb_build_object(
               'factId', related_fact.id,
               'eventId', related_fact.external_event_id,
               'externalRefundId', related_fact.external_refund_id,
               'status', related_fact.status,
               'amountMinor', related_fact.amount_minor::text,
               'currency', related_fact.currency,
               'occurredAt', related_fact.occurred_at
             )
             ORDER BY related_fact.created_at, related_fact.id
           )
           FROM refund_provider_facts related_fact
           WHERE related_fact.refund_id = refund.id
         ), '[]'::jsonb) AS provider_facts,
         settlement.id AS existing_settlement_id,
         operation.id AS provider_operation_id,
         operation.status AS provider_operation_status,
         operation.attempt_count AS provider_operation_attempt_count
       FROM refund_receipt_security_holds security_hold
       JOIN fund_receipts receipt ON receipt.id = security_hold.source_fund_receipt_id
       JOIN refunds refund ON refund.id = security_hold.refund_id
       JOIN client_accounts account ON account.id = refund.client_account_id
       JOIN refund_provider_facts fact ON fact.id = security_hold.refund_provider_fact_id
       JOIN provider_operations operation
         ON operation.subject_type = 'refund'
        AND operation.subject_id = refund.id
        AND operation.kind = 'refund_create'
       LEFT JOIN refund_discrepancy_settlements discrepancy
         ON discrepancy.refund_provider_fact_id = security_hold.refund_provider_fact_id
       LEFT JOIN refund_settlements settlement ON settlement.refund_id = refund.id
       WHERE NOT EXISTS (
         SELECT 1
         FROM refund_security_hold_adjudications adjudication
         WHERE adjudication.receipt_security_hold_id = security_hold.id
       )
       ORDER BY security_hold.created_at, security_hold.id`,
    );
    return {
      warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      requiresReauthentication: true,
      items: result.rows.map(refundSecurityHoldResponse),
    };
  });

  app.get("/api/v1/admin/refund-dismissal-corrections", async (request) => {
    const user = await requireUser(request, pool, config);
    await requireStaffPermission(pool, user, "billing.refund_adjudicate");
    const result = await pool.query<RefundDismissalCorrectionRow>(
      `SELECT
         adjudication.id AS adjudication_id,
         security_hold.id AS hold_id,
         refund.id AS refund_id,
         refund.version AS refund_version,
         refund.invoice_id,
         refund.client_account_id,
         account.name AS client_account_name,
         refund.source_fund_receipt_id AS receipt_id,
         fact.provider_installation_id,
         fact.id AS provider_fact_id,
         fact.external_event_id,
         fact.external_refund_id,
         fact.amount_minor::text,
         fact.currency,
         fact.occurred_at,
         discrepancy.id AS discrepancy_id,
         adjudication.reason AS dismissal_reason,
         adjudication.created_at AS dismissed_at
       FROM refund_security_hold_adjudications adjudication
       JOIN refund_receipt_security_holds security_hold
         ON security_hold.id = adjudication.receipt_security_hold_id
        AND security_hold.refund_id = adjudication.refund_id
       JOIN refunds refund ON refund.id = adjudication.refund_id
       JOIN client_accounts account ON account.id = refund.client_account_id
       JOIN refund_provider_facts fact
         ON fact.id = security_hold.refund_provider_fact_id
        AND fact.refund_id = refund.id
       LEFT JOIN refund_discrepancy_settlements discrepancy
         ON discrepancy.refund_provider_fact_id = fact.id
       WHERE adjudication.decision = 'dismiss_provider_claim'
         AND fact.status = 'succeeded'
         AND NOT EXISTS (
           SELECT 1
           FROM refund_adjudication_corrections correction
           WHERE correction.adjudication_id = adjudication.id
         )
       ORDER BY adjudication.created_at, adjudication.id`,
    );
    return {
      warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      requiresReauthentication: true,
      items: result.rows.map((row) => ({
        adjudicationId: row.adjudication_id,
        holdId: row.hold_id,
        refundId: row.refund_id,
        refundVersion: row.refund_version,
        invoiceId: row.invoice_id,
        clientAccountId: row.client_account_id,
        clientAccountName: row.client_account_name,
        receiptId: row.receipt_id,
        providerInstallationId: row.provider_installation_id,
        providerFact: {
          factId: row.provider_fact_id,
          eventId: row.external_event_id,
          externalRefundId: row.external_refund_id,
          amountMinor: row.amount_minor,
          currency: row.currency,
          occurredAt: row.occurred_at.toISOString(),
        },
        discrepancyId: row.discrepancy_id,
        dismissalReason: row.dismissal_reason,
        dismissedAt: row.dismissed_at.toISOString(),
        impact:
          "Re-posts the verified cash outflow to discrepancy suspense and reserves same-currency receipt capacity; it does not settle the refund.",
      })),
    };
  });

  app.post(
    "/api/v1/admin/refund-security-holds/:holdId/adjudications",
    async (request, reply) => {
      const user = await requireUser(request, pool, config);
      await requireStaffPermission(pool, user, "billing.refund_adjudicate");
      await requireRecentReauth(pool, user);
      const params = z.object({ holdId: canonicalUuid }).parse(request.params);
      const body = refundHoldAdjudicationSchema.parse(request.body);
      const fingerprint = requestFingerprint("admin.refund-hold-adjudication:v1", {
        holdId: params.holdId,
        decision: body.decision,
        reason: body.reason,
      });

      const outcome = await transaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `refund-adjudication:idempotency:${body.idempotencyKey}`,
        ]);
        const keyReplay = await readRefundHoldAdjudication(
          client,
          "idempotency_key",
          body.idempotencyKey,
        );
        if (keyReplay) {
          await requireStaffActionLocked(client, user, "billing.refund_adjudicate");
          if (
            keyReplay.receipt_security_hold_id !== params.holdId ||
            keyReplay.request_fingerprint !== fingerprint
          ) {
            throw Object.assign(
              new Error("The idempotency key was used for another hold adjudication"),
              { statusCode: 409, code: "IDEMPOTENCY_CONFLICT" },
            );
          }
          return { adjudication: keyReplay, replayed: true };
        }

        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `refund-adjudication:fingerprint:${fingerprint}`,
        ]);
        const semanticReplay = await readRefundHoldAdjudication(
          client,
          "request_fingerprint",
          fingerprint,
        );
        if (semanticReplay) {
          await requireStaffActionLocked(client, user, "billing.refund_adjudicate");
          await client.query(
            `INSERT INTO refund_security_adjudication_aliases(
               idempotency_key, adjudication_id, request_fingerprint
             ) VALUES ($1, $2, $3)`,
            [body.idempotencyKey, semanticReplay.id, fingerprint],
          );
          return { adjudication: semanticReplay, replayed: true };
        }

        await requireStaffActionLocked(client, user, "billing.refund_adjudicate");
        const pointer = await client.query<{
          refund_id: string;
          source_fund_receipt_id: string;
          external_refund_id: string;
          provider_installation_id: string;
        }>(
          `SELECT security_hold.refund_id, security_hold.source_fund_receipt_id,
                  fact.external_refund_id, fact.provider_installation_id
           FROM refund_receipt_security_holds security_hold
           JOIN refund_provider_facts fact
             ON fact.id = security_hold.refund_provider_fact_id
            AND fact.refund_id = security_hold.refund_id
           WHERE security_hold.id = $1`,
          [params.holdId],
        );
        const target = pointer.rows[0];
        if (!target) {
          throw Object.assign(new Error("Refund security hold not found"), { statusCode: 404 });
        }
        for (const lock of [
          `refund:${target.refund_id}`,
          `refund-external:${target.external_refund_id}`,
        ].sort()) {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            lock,
          ]);
        }
        await client.query("SELECT id FROM fund_receipts WHERE id = $1 FOR UPDATE", [
          target.source_fund_receipt_id,
        ]);
        const hold = await readActiveRefundSecurityHold(client, params.holdId, true);
        if (!hold) {
          throw Object.assign(new Error("Refund security hold was already adjudicated"), {
            statusCode: 409,
            code: "REFUND_HOLD_ALREADY_ADJUDICATED",
          });
        }
        if (hold.refund_version !== body.expectedRefundVersion) {
          throw Object.assign(
            new Error("The refund changed after the hold impact was displayed; refresh first"),
            { statusCode: 409, code: "REFUND_VERSION_CONFLICT" },
          );
        }

        const canAccept =
          hold.discrepancy_id !== null &&
          hold.discrepancy_external_refund_id !== null &&
          hold.discrepancy_occurred_at !== null &&
          hold.discrepancy_amount_minor === hold.refund_amount_minor &&
          hold.discrepancy_currency === hold.refund_currency &&
          hold.existing_settlement_id === null &&
          BigInt(hold.confirmed_settlement_minor) + BigInt(hold.refund_amount_minor) <=
            BigInt(hold.receipt_amount_minor) &&
          hold.refund_status === "manual" &&
          hold.refund_security_hold;
        if (body.decision === "accept_authorized_outflow" && !canAccept) {
          throw Object.assign(
            new Error(
              "Only one exact, authorized, unsettled Provider outflow can be accepted as this refund",
            ),
            { statusCode: 422, code: "REFUND_OUTFLOW_NOT_ACCEPTABLE" },
          );
        }
        if (
          body.decision === "record_unexpected_outflow" &&
          hold.provider_fact_status !== "succeeded"
        ) {
          throw Object.assign(
            new Error("Only a held Provider success fact can be recorded as an unexpected outflow"),
            { statusCode: 422, code: "REFUND_UNEXPECTED_OUTFLOW_NOT_RECORDABLE" },
          );
        }

        await client.query("SET LOCAL opensales.refund_human_adjudication = 'on'");
        let adjudicationDiscrepancyId = hold.discrepancy_id;
        if (body.decision === "record_unexpected_outflow" && !adjudicationDiscrepancyId) {
          const existingExternalOwner = await client.query(
            `SELECT 1
             FROM (
               SELECT settlement.provider_installation_id, settlement.external_refund_id
               FROM refund_settlements settlement
               WHERE settlement.provider_installation_id = $2
                 AND settlement.external_refund_id = $1
               UNION ALL
               SELECT discrepancy.provider_installation_id, discrepancy.external_refund_id
               FROM refund_discrepancy_settlements discrepancy
               WHERE discrepancy.provider_installation_id = $2
                 AND discrepancy.external_refund_id = $1
             ) owner
             LIMIT 1`,
            [hold.external_refund_id, target.provider_installation_id],
          );
          if (existingExternalOwner.rowCount !== 0) {
            throw Object.assign(
              new Error(
                "The Provider external refund identity is already owned and cannot reduce cash again",
              ),
              { statusCode: 422, code: "REFUND_EXTERNAL_ID_ALREADY_OWNED" },
            );
          }
          const unexpectedDiscrepancy = await client.query<{ id: string }>(
            `INSERT INTO refund_discrepancy_settlements(
               refund_provider_fact_id, refund_id, provider_installation_id,
               external_refund_id, amount_minor, currency, reason, occurred_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [
              hold.provider_fact_id,
              hold.refund_id,
              target.provider_installation_id,
              hold.external_refund_id,
              hold.provider_amount_minor,
              hold.provider_currency,
              body.reason,
              hold.provider_occurred_at,
            ],
          );
          adjudicationDiscrepancyId = unexpectedDiscrepancy.rows[0]?.id ?? null;
          if (!adjudicationDiscrepancyId) {
            throw Object.assign(
              new Error(
                "The Provider external refund identity is already owned and cannot reduce cash again",
              ),
              { statusCode: 422, code: "REFUND_EXTERNAL_ID_ALREADY_OWNED" },
            );
          }
        }

        const adjudicationResult = await client.query<RefundHoldAdjudicationRow>(
          `INSERT INTO refund_security_hold_adjudications(
             receipt_security_hold_id, refund_id, decision, discrepancy_settlement_id,
             staff_user_id, staff_session_id, reason, idempotency_key,
             request_fingerprint, expected_refund_version
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id, receipt_security_hold_id, refund_id, decision,
                     discrepancy_settlement_id, reason, request_fingerprint, created_at`,
          [
            hold.hold_id,
            hold.refund_id,
            body.decision,
            adjudicationDiscrepancyId,
            user.userId,
            user.sessionId,
            body.reason,
            body.idempotencyKey,
            fingerprint,
            body.expectedRefundVersion,
          ],
        );
        const adjudication = adjudicationResult.rows[0];
        if (!adjudication) throw new Error("Unable to record refund hold adjudication");
        await client.query(
          `INSERT INTO refund_security_adjudication_aliases(
             idempotency_key, adjudication_id, request_fingerprint
           ) VALUES ($1, $2, $3)`,
          [body.idempotencyKey, adjudication.id, fingerprint],
        );
        let journalId: string | null = null;
        if (body.decision === "accept_authorized_outflow") {
          const changed = await client.query(
            `UPDATE refunds
             SET status = 'succeeded', security_hold = false, last_error = NULL,
                 provider_occurred_at = $2,
                 result = result || $3::jsonb,
                 updated_at = now(), version = version + 1
             WHERE id = $1 AND status = 'manual' AND security_hold = true AND version = $4`,
            [
              hold.refund_id,
              hold.discrepancy_occurred_at,
              JSON.stringify({
                adjudicationId: adjudication.id,
                acceptedProviderFactId: hold.discrepancy_provider_fact_id,
              }),
              body.expectedRefundVersion,
            ],
          );
          if (changed.rowCount !== 1) {
            throw Object.assign(new Error("Refund changed during adjudication"), {
              statusCode: 409,
              code: "REFUND_VERSION_CONFLICT",
            });
          }
          await client.query(
            `INSERT INTO refund_settlements(
               refund_id, provider_installation_id, external_refund_id,
               destination, amount_minor, currency, occurred_at
             ) VALUES ($1, 'mock-payment-v1', $2, 'original_payment', $3, $4, $5)`,
            [
              hold.refund_id,
              hold.discrepancy_external_refund_id,
              hold.refund_amount_minor,
              hold.refund_currency,
              hold.discrepancy_occurred_at,
            ],
          );
          await client.query(
            `UPDATE provider_operations
             SET status = 'succeeded', external_reference = $2,
                 provider_occurred_at = $3, last_error = NULL, updated_at = now()
             WHERE id = $1`,
            [
              hold.provider_operation_id,
              hold.discrepancy_external_refund_id,
              hold.discrepancy_occurred_at,
            ],
          );
          const journal = await client.query<{ id: string }>(
            `INSERT INTO ledger_journals(source_type, source_id, currency, description)
             VALUES (
               'refund_security_adjudication', $1, $2,
               'Accepted authorized refund outflow; reclassified discrepancy suspense'
             )
             RETURNING id`,
            [adjudication.id, hold.refund_currency],
          );
          journalId = journal.rows[0]?.id ?? null;
          if (!journalId) throw new Error("Unable to create refund adjudication journal");
          await client.query(
            `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
             VALUES
               ($1, 'sales_refunds_and_allowances', $2, 0),
               ($1, 'refund_discrepancy_suspense', 0, $2)`,
            [journalId, hold.refund_amount_minor],
          );
          await client.query(
            `UPDATE durable_jobs
             SET status = 'completed', locked_at = NULL, locked_by = NULL,
                 last_error = NULL, updated_at = now()
             WHERE payload->>'refundId' = $1
               AND job_type IN ('refund.start', 'refund.reconcile')
               AND status <> 'completed'`,
            [hold.refund_id],
          );
        } else {
          if (body.decision === "dismiss_provider_claim" && hold.discrepancy_id) {
            const journal = await client.query<{ id: string }>(
              `INSERT INTO ledger_journals(source_type, source_id, currency, description)
               VALUES (
                 'refund_security_adjudication', $1, $2,
                 'Dismissed Provider refund claim; reversed discrepancy suspense'
               )
               RETURNING id`,
              [adjudication.id, hold.discrepancy_currency],
            );
            journalId = journal.rows[0]?.id ?? null;
            if (!journalId) throw new Error("Unable to create refund adjudication journal");
            await client.query(
              `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
               VALUES
                 ($1, 'mock_cash', $2, 0),
                 ($1, 'refund_discrepancy_suspense', 0, $2)`,
              [journalId, hold.discrepancy_amount_minor],
            );
          }
          if (body.decision === "record_unexpected_outflow" && !hold.discrepancy_id) {
            const journal = await client.query<{ id: string }>(
              `INSERT INTO ledger_journals(source_type, source_id, currency, description)
               VALUES (
                 'refund_provider_discrepancy', $1, $2,
                 'Verified unexpected Provider outflow retained in discrepancy suspense'
               )
               RETURNING id`,
              [adjudicationDiscrepancyId, hold.provider_currency],
            );
            journalId = journal.rows[0]?.id ?? null;
            if (!journalId) throw new Error("Unable to create unexpected-outflow journal");
            await client.query(
              `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
               VALUES
                 ($1, 'refund_discrepancy_suspense', $2, 0),
                 ($1, 'mock_cash', 0, $2)`,
              [journalId, hold.provider_amount_minor],
            );
          }
          const remainingRefundHolds = await client.query(
            `SELECT security_hold.id
             FROM refund_receipt_security_holds security_hold
             WHERE security_hold.refund_id = $1
               AND NOT EXISTS (
                 SELECT 1 FROM refund_security_hold_adjudications adjudication
                 WHERE adjudication.receipt_security_hold_id = security_hold.id
               )`,
            [hold.refund_id],
          );
          if (
            remainingRefundHolds.rowCount === 0 &&
            hold.refund_status === "manual" &&
            hold.refund_security_hold
          ) {
            await client.query(
              `UPDATE refunds
               SET status = 'failed', security_hold = false,
                   last_error = $2,
                   result = (result - 'frozenByRefundId') || $3::jsonb,
                   updated_at = now(), version = version + 1
               WHERE id = $1 AND version = $4`,
              [
                hold.refund_id,
                body.decision === "record_unexpected_outflow"
                  ? "Unexpected Provider outflow recorded for manual financial reconciliation"
                  : "Provider claim dismissed after human reconciliation",
                JSON.stringify({
                  adjudicationId: adjudication.id,
                  providerClaimDismissed: body.decision === "dismiss_provider_claim",
                  unexpectedOutflowRecorded: body.decision === "record_unexpected_outflow",
                }),
                body.expectedRefundVersion,
              ],
            );
            await client.query(
              `UPDATE provider_operations
               SET status = $2, last_error = $3, updated_at = now()
               WHERE id = $1 AND status <> 'succeeded'`,
              [
                hold.provider_operation_id,
                body.decision === "record_unexpected_outflow" ? "unknown" : "failed",
                body.reason,
              ],
            );
            await client.query(
              `UPDATE durable_jobs
               SET status = 'completed', locked_at = NULL, locked_by = NULL,
                   last_error = $2, updated_at = now()
               WHERE payload->>'refundId' = $1
                 AND job_type IN ('refund.start', 'refund.reconcile')
                 AND status <> 'completed'`,
              [hold.refund_id, body.reason],
            );
          }
        }

        await client.query(
          `INSERT INTO refund_events(
             refund_id, event_type, actor_type, actor_id, reason, metadata
           ) VALUES ($1, 'adjudicated', 'staff', $2, $3, $4)`,
          [
            hold.refund_id,
            user.userId,
            body.reason,
            {
              holdId: hold.hold_id,
              adjudicationId: adjudication.id,
              decision: body.decision,
              providerFactId: hold.provider_fact_id,
              discrepancyProviderFactId: hold.discrepancy_provider_fact_id,
              discrepancySettlementId: adjudicationDiscrepancyId,
              journalId,
            },
          ],
        );

        const remainingReceiptHolds = await client.query(
          `SELECT security_hold.id
           FROM refund_receipt_security_holds security_hold
           WHERE security_hold.source_fund_receipt_id = $1
             AND NOT EXISTS (
               SELECT 1 FROM refund_security_hold_adjudications adjudication
               WHERE adjudication.receipt_security_hold_id = security_hold.id
             )`,
          [hold.receipt_id],
        );
        const resumedRefundIds: string[] = [];
        if (remainingReceiptHolds.rowCount === 0) {
          const frozen = await client.query<{ id: string; operation_id: string }>(
            `SELECT competing.id, operation.id AS operation_id
             FROM refunds competing
             JOIN provider_operations operation
               ON operation.subject_type = 'refund'
              AND operation.subject_id = competing.id
              AND operation.kind = 'refund_create'
             WHERE competing.source_fund_receipt_id = $1
               AND competing.status = 'manual'
               AND competing.security_hold = false
               AND competing.result ? 'frozenByRefundId'
             ORDER BY competing.id
             FOR UPDATE OF competing, operation`,
            [hold.receipt_id],
          );
          for (const competing of frozen.rows) {
            await client.query(
              `UPDATE refunds
               SET last_error = 'Receipt hold resolved; safe Provider reconciliation resumed',
                   result = (result - 'frozenByRefundId') || $2::jsonb,
                   updated_at = now(), version = version + 1
               WHERE id = $1`,
              [competing.id, JSON.stringify({ resumedByAdjudicationId: adjudication.id })],
            );
            await client.query(
              `UPDATE durable_jobs
               SET status = 'completed', locked_at = NULL, locked_by = NULL,
                   last_error = $2, updated_at = now()
               WHERE job_type = 'refund.start' AND payload->>'refundId' = $1`,
              [competing.id, body.reason],
            );
            await client.query(
              `INSERT INTO durable_jobs(job_type, unique_key, payload, status)
               VALUES (
                 'refund.reconcile', $1, $2, 'pending'
               )
               ON CONFLICT (job_type, unique_key) DO UPDATE
               SET payload = EXCLUDED.payload, status = 'pending', available_at = now(),
                   attempts = 0, locked_at = NULL, locked_by = NULL,
                   last_error = NULL, updated_at = now()`,
              [
                `refund:${competing.id}`,
                { refundId: competing.id, operationId: competing.operation_id },
              ],
            );
            await client.query(
              `INSERT INTO refund_events(
                 refund_id, event_type, actor_type, actor_id, reason, metadata
               ) VALUES ($1, 'adjudicated', 'staff', $2, $3, $4)`,
              [
                competing.id,
                user.userId,
                body.reason,
                { resumedAfterHoldId: hold.hold_id, adjudicationId: adjudication.id },
              ],
            );
            resumedRefundIds.push(competing.id);
          }
        }
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, reason, metadata
           ) VALUES ('staff', $1, 'refund.security_hold_adjudicated', 'refund', $2, $3, $4)`,
          [
            user.userId,
            hold.refund_id,
            body.reason,
            {
              holdId: hold.hold_id,
              adjudicationId: adjudication.id,
              decision: body.decision,
              providerFactId: hold.provider_fact_id,
              discrepancyProviderFactId: hold.discrepancy_provider_fact_id,
              discrepancySettlementId: adjudicationDiscrepancyId,
              journalId,
              remainingReceiptHolds: remainingReceiptHolds.rowCount ?? 0,
              resumedRefundIds,
            },
          ],
        );
        return { adjudication, replayed: false };
      });
      return reply
        .code(outcome.replayed ? 200 : 201)
        .send(refundAdjudicationResponse(outcome.adjudication, outcome.replayed));
    },
  );

  app.post(
    "/api/v1/admin/refund-adjudications/:adjudicationId/corrections",
    async (request, reply) => {
      const user = await requireUser(request, pool, config);
      await requireStaffPermission(pool, user, "billing.refund_adjudicate");
      await requireRecentReauth(pool, user);
      const params = z.object({ adjudicationId: canonicalUuid }).parse(request.params);
      const body = refundAdjudicationCorrectionSchema.parse(request.body);
      const fingerprint = requestFingerprint("admin.refund-adjudication-correction:v1", {
        adjudicationId: params.adjudicationId,
        reason: body.reason,
      });

      const outcome = await transaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `refund-correction:idempotency:${body.idempotencyKey}`,
        ]);
        const keyReplay = await client.query<RefundAdjudicationCorrectionRow>(
          `SELECT correction.id, correction.adjudication_id, correction.refund_id,
                  correction.discrepancy_settlement_id, correction.reason,
                  correction.request_fingerprint, correction.created_at
           FROM refund_adjudication_correction_aliases alias
           JOIN refund_adjudication_corrections correction
             ON correction.id = alias.correction_id
           WHERE alias.idempotency_key = $1`,
          [body.idempotencyKey],
        );
        const replay = keyReplay.rows[0];
        if (replay) {
          await requireStaffActionLocked(client, user, "billing.refund_adjudicate");
          if (
            replay.adjudication_id !== params.adjudicationId ||
            replay.request_fingerprint !== fingerprint
          ) {
            throw Object.assign(
              new Error("The idempotency key was used for another correction"),
              { statusCode: 409, code: "IDEMPOTENCY_CONFLICT" },
            );
          }
          return { row: replay, replayed: true };
        }

        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `refund-correction:fingerprint:${fingerprint}`,
        ]);
        const semanticReplay = await client.query<RefundAdjudicationCorrectionRow>(
          `SELECT id, adjudication_id, refund_id, discrepancy_settlement_id,
                  reason, request_fingerprint, created_at
           FROM refund_adjudication_corrections
           WHERE request_fingerprint = $1`,
          [fingerprint],
        );
        const semantic = semanticReplay.rows[0];
        if (semantic) {
          await requireStaffActionLocked(client, user, "billing.refund_adjudicate");
          await client.query(
            `INSERT INTO refund_adjudication_correction_aliases(
               idempotency_key, correction_id, request_fingerprint
             ) VALUES ($1, $2, $3)`,
            [body.idempotencyKey, semantic.id, fingerprint],
          );
          return { row: semantic, replayed: true };
        }

        await requireStaffActionLocked(client, user, "billing.refund_adjudicate");
        const pointer = await client.query<{
          refund_id: string;
          receipt_id: string;
          provider_installation_id: string;
          external_refund_id: string;
        }>(
          `SELECT adjudication.refund_id,
                  security_hold.source_fund_receipt_id AS receipt_id,
                  fact.provider_installation_id,
                  fact.external_refund_id
           FROM refund_security_hold_adjudications adjudication
           JOIN refund_receipt_security_holds security_hold
             ON security_hold.id = adjudication.receipt_security_hold_id
            AND security_hold.refund_id = adjudication.refund_id
           JOIN refund_provider_facts fact
             ON fact.id = security_hold.refund_provider_fact_id
            AND fact.refund_id = adjudication.refund_id
           WHERE adjudication.id = $1`,
          [params.adjudicationId],
        );
        const target = pointer.rows[0];
        if (!target) {
          throw Object.assign(new Error("Refund adjudication not found"), { statusCode: 404 });
        }
        for (const lock of [
          `refund:${target.refund_id}`,
          `refund-external:${target.external_refund_id}`,
        ].sort()) {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            lock,
          ]);
        }
        await client.query("SELECT id FROM fund_receipts WHERE id = $1 FOR UPDATE", [
          target.receipt_id,
        ]);

        const stateResult = await client.query<{
          adjudication_id: string;
          decision: string;
          refund_id: string;
          refund_version: number;
          provider_fact_id: string;
          provider_fact_status: string;
          provider_amount_minor: string;
          provider_currency: string;
          provider_occurred_at: Date;
          discrepancy_id: string | null;
          correction_id: string | null;
          provider_operation_id: string;
          provider_operation_status: string;
        }>(
          `SELECT
             adjudication.id AS adjudication_id,
             adjudication.decision,
             refund.id AS refund_id,
             refund.version AS refund_version,
             fact.id AS provider_fact_id,
             fact.status AS provider_fact_status,
             fact.amount_minor::text AS provider_amount_minor,
             fact.currency AS provider_currency,
             fact.occurred_at AS provider_occurred_at,
             discrepancy.id AS discrepancy_id,
             correction.id AS correction_id,
             operation.id AS provider_operation_id,
             operation.status AS provider_operation_status
           FROM refund_security_hold_adjudications adjudication
           JOIN refund_receipt_security_holds security_hold
             ON security_hold.id = adjudication.receipt_security_hold_id
            AND security_hold.refund_id = adjudication.refund_id
           JOIN refunds refund ON refund.id = adjudication.refund_id
           JOIN refund_provider_facts fact
             ON fact.id = security_hold.refund_provider_fact_id
            AND fact.refund_id = refund.id
           JOIN provider_operations operation
             ON operation.subject_type = 'refund'
            AND operation.subject_id = refund.id
            AND operation.kind = 'refund_create'
           LEFT JOIN refund_discrepancy_settlements discrepancy
             ON discrepancy.refund_provider_fact_id = fact.id
           LEFT JOIN refund_adjudication_corrections correction
             ON correction.adjudication_id = adjudication.id
           WHERE adjudication.id = $1
           FOR UPDATE OF adjudication, security_hold, refund, fact, operation`,
          [params.adjudicationId],
        );
        const state = stateResult.rows[0];
        if (!state) {
          throw Object.assign(new Error("Refund adjudication disappeared"), { statusCode: 409 });
        }
        if (state.refund_version !== body.expectedRefundVersion) {
          throw Object.assign(new Error("The refund changed; refresh before correcting"), {
            statusCode: 409,
            code: "REFUND_VERSION_CONFLICT",
          });
        }
        if (
          state.decision !== "dismiss_provider_claim" ||
          state.provider_fact_status !== "succeeded" ||
          state.correction_id !== null
        ) {
          throw Object.assign(
            new Error("Only one uncorrected dismissal of a Provider success can be corrected"),
            { statusCode: 422, code: "REFUND_DISMISSAL_NOT_CORRECTABLE" },
          );
        }

        await client.query("SET LOCAL opensales.refund_human_adjudication = 'on'");
        let discrepancyId = state.discrepancy_id;
        if (!discrepancyId) {
          const existingExternalOwner = await client.query(
            `SELECT 1
             FROM (
               SELECT provider_installation_id, external_refund_id
               FROM refund_settlements
               WHERE provider_installation_id = $2 AND external_refund_id = $1
               UNION ALL
               SELECT provider_installation_id, external_refund_id
               FROM refund_discrepancy_settlements
               WHERE provider_installation_id = $2 AND external_refund_id = $1
             ) owner
             LIMIT 1`,
            [target.external_refund_id, target.provider_installation_id],
          );
          if (existingExternalOwner.rowCount !== 0) {
            throw Object.assign(
              new Error("The Provider external refund identity is already owned"),
              { statusCode: 422, code: "REFUND_EXTERNAL_ID_ALREADY_OWNED" },
            );
          }
          const insertedDiscrepancy = await client.query<{ id: string }>(
            `INSERT INTO refund_discrepancy_settlements(
               refund_provider_fact_id, refund_id, provider_installation_id,
               external_refund_id, amount_minor, currency, reason, occurred_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [
              state.provider_fact_id,
              state.refund_id,
              target.provider_installation_id,
              target.external_refund_id,
              state.provider_amount_minor,
              state.provider_currency,
              body.reason,
              state.provider_occurred_at,
            ],
          );
          discrepancyId = insertedDiscrepancy.rows[0]?.id ?? null;
          if (!discrepancyId) throw new Error("Unable to preserve corrected Provider outflow");
        }

        const correctionResult = await client.query<RefundAdjudicationCorrectionRow>(
          `INSERT INTO refund_adjudication_corrections(
             adjudication_id, refund_id, discrepancy_settlement_id,
             staff_user_id, staff_session_id, reason, idempotency_key,
             request_fingerprint, expected_refund_version
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, adjudication_id, refund_id, discrepancy_settlement_id,
                     reason, request_fingerprint, created_at`,
          [
            state.adjudication_id,
            state.refund_id,
            discrepancyId,
            user.userId,
            user.sessionId,
            body.reason,
            body.idempotencyKey,
            fingerprint,
            body.expectedRefundVersion,
          ],
        );
        const correction = correctionResult.rows[0];
        if (!correction) throw new Error("Unable to record refund dismissal correction");
        await client.query(
          `INSERT INTO refund_adjudication_correction_aliases(
             idempotency_key, correction_id, request_fingerprint
           ) VALUES ($1, $2, $3)`,
          [body.idempotencyKey, correction.id, fingerprint],
        );
        const journal = await client.query<{ id: string }>(
          `INSERT INTO ledger_journals(source_type, source_id, currency, description)
           VALUES (
             'refund_adjudication_correction', $1, $2,
             'Corrected dismissed Provider outflow; restored discrepancy suspense and cash reduction'
           )
           RETURNING id`,
          [correction.id, state.provider_currency],
        );
        const journalId = journal.rows[0]?.id;
        if (!journalId) throw new Error("Unable to post refund correction journal");
        await client.query(
          `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
           VALUES
             ($1, 'refund_discrepancy_suspense', $2, 0),
             ($1, 'mock_cash', 0, $2)`,
          [journalId, state.provider_amount_minor],
        );
        await client.query(
          `UPDATE provider_operations
           SET status = 'succeeded',
               external_reference = $2,
               provider_occurred_at = COALESCE(
                 GREATEST(provider_occurred_at, $3::timestamptz),
                 $3::timestamptz
               ),
               last_error = NULL,
               updated_at = now()
           WHERE id = $1`,
          [
            state.provider_operation_id,
            target.external_refund_id,
            state.provider_occurred_at,
          ],
        );
        const frozenRefundIds = await freezeCompetingRefunds(client, {
          heldRefundId: state.refund_id,
          receiptId: target.receipt_id,
          reason:
            "Refund stopped because a previously dismissed Provider outflow was later confirmed and consumed source receipt capacity",
          cause: "dismissal_correction",
          correctionId: correction.id,
        });
        const changedRefund = await client.query(
          `UPDATE refunds
           SET last_error = 'A dismissed Provider outflow was later confirmed',
               result = result || $2::jsonb, updated_at = now(), version = version + 1
           WHERE id = $1 AND version = $3`,
          [
            state.refund_id,
            JSON.stringify({
              correctedAdjudicationId: state.adjudication_id,
              correctionId: correction.id,
              discrepancySettlementId: discrepancyId,
              frozenRefundIds,
              providerOperationStatus: "succeeded",
            }),
            body.expectedRefundVersion,
          ],
        );
        if (changedRefund.rowCount !== 1) {
          throw Object.assign(new Error("Refund changed during dismissal correction"), {
            statusCode: 409,
            code: "REFUND_VERSION_CONFLICT",
          });
        }
        await client.query(
          `INSERT INTO refund_events(
             refund_id, event_type, actor_type, actor_id, reason, metadata
           ) VALUES ($1, 'adjudicated', 'staff', $2, $3, $4)`,
          [
            state.refund_id,
            user.userId,
            body.reason,
            {
              adjudicationId: state.adjudication_id,
              correctionId: correction.id,
              discrepancySettlementId: discrepancyId,
              journalId,
              providerOperationId: state.provider_operation_id,
              previousProviderOperationStatus: state.provider_operation_status,
              providerOperationStatus: "succeeded",
              frozenRefundIds,
            },
          ],
        );
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, reason, metadata
           ) VALUES ('staff', $1, 'refund.dismissal_corrected', 'refund', $2, $3, $4)`,
          [
            user.userId,
            state.refund_id,
            body.reason,
            {
              adjudicationId: state.adjudication_id,
              correctionId: correction.id,
              providerFactId: state.provider_fact_id,
              discrepancySettlementId: discrepancyId,
              journalId,
              providerOperationId: state.provider_operation_id,
              previousProviderOperationStatus: state.provider_operation_status,
              providerOperationStatus: "succeeded",
              frozenRefundIds,
            },
          ],
        );
        return { row: correction, replayed: false };
      });

      return reply.code(outcome.replayed ? 200 : 201).send({
        warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
        correctionId: outcome.row.id,
        adjudicationId: outcome.row.adjudication_id,
        refundId: outcome.row.refund_id,
        discrepancySettlementId: outcome.row.discrepancy_settlement_id,
        status: "dismissed_outflow_confirmed",
        replayed: outcome.replayed,
        createdAt: outcome.row.created_at.toISOString(),
      });
    },
  );

  app.get("/api/v1/admin/refund-candidates", async (request) => {
    const user = await requireUser(request, pool, config);
    await requireStaffPermission(pool, user, "billing.refund_manage");
    const result = await pool.query<{
      receipt_id: string;
      invoice_id: string;
      client_account_id: string;
      client_account_name: string;
      provider_installation_id: string;
      external_payment_id: string;
      receipt_amount_minor: string;
      refundable_minor: string;
      currency: string;
      occurred_at: Date;
      reference_refund_minor: string | null;
      service_id: string | null;
      term_start: Date | null;
      term_end: Date | null;
    }>(
      `SELECT
         receipt.id AS receipt_id,
         invoice.id AS invoice_id,
         receipt.client_account_id,
         account.name AS client_account_name,
         receipt.provider_installation_id,
         receipt.external_payment_id,
         receipt.amount_minor::text AS receipt_amount_minor,
         (
           receipt.amount_minor
           - COALESCE(reserved.amount_minor, 0)
         )::text AS refundable_minor,
         receipt.currency,
         receipt.occurred_at,
         CASE
           WHEN service_term.service_count = 1
             AND service_term.term_start IS NOT NULL
             AND service_term.term_end > service_term.term_start
             AND recurring.amount_minor > 0
           THEN LEAST(
             receipt.amount_minor - COALESCE(reserved.amount_minor, 0),
             GREATEST(
               0,
               floor(
                 recurring.amount_minor
                 * GREATEST(0, extract(epoch FROM service_term.term_end - now()))
                 / extract(epoch FROM service_term.term_end - service_term.term_start)
               )::bigint
             )
           )::text
           ELSE NULL
         END AS reference_refund_minor,
         CASE WHEN service_term.service_count = 1 THEN service_term.service_id END AS service_id,
         CASE WHEN service_term.service_count = 1 THEN service_term.term_start END AS term_start,
         CASE WHEN service_term.service_count = 1 THEN service_term.term_end END AS term_end
       FROM fund_receipts receipt
       JOIN payment_attempts payment ON payment.id = receipt.reported_payment_attempt_id
       JOIN payment_allocations allocation
         ON allocation.payment_attempt_id = payment.id
        AND allocation.amount_minor = receipt.amount_minor
       JOIN invoices invoice ON invoice.id = allocation.invoice_id
       JOIN client_accounts account ON account.id = receipt.client_account_id
       LEFT JOIN LATERAL (
         SELECT CASE
           WHEN EXISTS (
             SELECT 1
             FROM refund_receipt_security_holds security_hold
             WHERE security_hold.source_fund_receipt_id = receipt.id
               AND NOT EXISTS (
                 SELECT 1 FROM refund_security_hold_adjudications adjudication
                 WHERE adjudication.receipt_security_hold_id = security_hold.id
               )
           )
           OR EXISTS (
             SELECT 1
             FROM refunds manual_refund
             WHERE manual_refund.source_fund_receipt_id = receipt.id
               AND manual_refund.status = 'manual'
           ) THEN receipt.amount_minor
           ELSE (
             SELECT COALESCE(sum(reserved_outflow.amount_minor), 0)::bigint
             FROM (
               SELECT reserved_refund.amount_minor
               FROM refunds reserved_refund
               WHERE reserved_refund.source_fund_receipt_id = receipt.id
                 AND reserved_refund.status IN ('queued', 'processing', 'unknown', 'succeeded')
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
             ) reserved_outflow
           )
         END AS amount_minor
       ) reserved ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(line.amount_minor), 0)::bigint AS amount_minor
         FROM invoice_lines line
         WHERE line.invoice_id = invoice.id AND line.kind = 'recurring'
       ) recurring ON true
       LEFT JOIN LATERAL (
         SELECT
           count(*)::integer AS service_count,
           min(service.id::text)::uuid AS service_id,
           min(service.term_start) AS term_start,
           min(service.term_end) AS term_end
         FROM orders order_record
         JOIN order_items item ON item.order_id = order_record.id
         JOIN services service ON service.order_item_id = item.id
         WHERE order_record.id = invoice.order_id
       ) service_term ON true
       WHERE receipt.allocated_minor = receipt.amount_minor
         AND payment.client_account_id = receipt.client_account_id
         AND payment.provider_installation_id = receipt.provider_installation_id
         AND payment.external_payment_id = receipt.external_payment_id
         AND payment.currency = receipt.currency
         AND receipt.amount_minor > COALESCE(reserved.amount_minor, 0)
       ORDER BY receipt.occurred_at DESC, receipt.id`,
    );
    return {
      warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      scope:
        "Only fully allocated invoice receipts are eligible. Add Funds and unclaimed receipts are intentionally excluded.",
      items: result.rows.map((row) => ({
        receiptId: row.receipt_id,
        invoiceId: row.invoice_id,
        clientAccountId: row.client_account_id,
        clientAccountName: row.client_account_name,
        providerInstallationId: row.provider_installation_id,
        externalPaymentId: row.external_payment_id,
        receiptAmountMinor: row.receipt_amount_minor,
        refundableMinor: row.refundable_minor,
        referenceRefundMinor: row.reference_refund_minor,
        referenceOnly: true,
        currency: row.currency,
        serviceId: row.service_id,
        termStart: row.term_start?.toISOString() ?? null,
        termEnd: row.term_end?.toISOString() ?? null,
        occurredAt: row.occurred_at.toISOString(),
      })),
    };
  });

  app.get("/api/v1/admin/refunds", async (request) => {
    const user = await requireUser(request, pool, config);
    await requireStaffPermission(pool, user, "billing.refund_manage");
    const result = await pool.query<RefundRow>(
      `SELECT
         refund.*,
         operation.id AS provider_operation_id,
         operation.status AS provider_operation_status,
         settlement.external_refund_id,
         EXISTS (
           SELECT 1
           FROM refund_receipt_security_holds security_hold
           WHERE security_hold.source_fund_receipt_id = refund.source_fund_receipt_id
             AND NOT EXISTS (
               SELECT 1
               FROM refund_security_hold_adjudications adjudication
               WHERE adjudication.receipt_security_hold_id = security_hold.id
             )
         ) AS receipt_security_hold,
         (
           SELECT security_hold.reason
           FROM refund_receipt_security_holds security_hold
           WHERE security_hold.source_fund_receipt_id = refund.source_fund_receipt_id
             AND NOT EXISTS (
               SELECT 1
               FROM refund_security_hold_adjudications adjudication
               WHERE adjudication.receipt_security_hold_id = security_hold.id
             )
           ORDER BY security_hold.created_at DESC, security_hold.id DESC
           LIMIT 1
         ) AS receipt_security_hold_reason,
         (
           SELECT security_hold.created_at
           FROM refund_receipt_security_holds security_hold
           WHERE security_hold.source_fund_receipt_id = refund.source_fund_receipt_id
             AND NOT EXISTS (
               SELECT 1
               FROM refund_security_hold_adjudications adjudication
               WHERE adjudication.receipt_security_hold_id = security_hold.id
             )
           ORDER BY security_hold.created_at DESC, security_hold.id DESC
           LIMIT 1
         ) AS receipt_security_hold_created_at
       FROM refunds refund
       LEFT JOIN provider_operations operation
         ON operation.subject_type = 'refund'
        AND operation.subject_id = refund.id
        AND operation.kind = 'refund_create'
       LEFT JOIN refund_settlements settlement ON settlement.refund_id = refund.id
       ORDER BY refund.created_at DESC, refund.id DESC
       LIMIT 100`,
    );
    return {
      warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      items: result.rows.map((row) => refundResponse(row, false)),
    };
  });

  app.get("/api/v1/admin/refunds/:refundId", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    await requireStaffPermission(pool, user, "billing.refund_manage");
    const params = z.object({ refundId: canonicalUuid }).parse(request.params);
    const result = await pool.query<RefundRow>(
      `SELECT
         refund.*,
         operation.id AS provider_operation_id,
         operation.status AS provider_operation_status,
         settlement.external_refund_id,
         EXISTS (
           SELECT 1
           FROM refund_receipt_security_holds security_hold
           WHERE security_hold.source_fund_receipt_id = refund.source_fund_receipt_id
             AND NOT EXISTS (
               SELECT 1 FROM refund_security_hold_adjudications adjudication
               WHERE adjudication.receipt_security_hold_id = security_hold.id
             )
         ) AS receipt_security_hold,
         (
           SELECT security_hold.reason
           FROM refund_receipt_security_holds security_hold
           WHERE security_hold.source_fund_receipt_id = refund.source_fund_receipt_id
             AND NOT EXISTS (
               SELECT 1 FROM refund_security_hold_adjudications adjudication
               WHERE adjudication.receipt_security_hold_id = security_hold.id
             )
           ORDER BY security_hold.created_at DESC, security_hold.id DESC
           LIMIT 1
         ) AS receipt_security_hold_reason,
         (
           SELECT security_hold.created_at
           FROM refund_receipt_security_holds security_hold
           WHERE security_hold.source_fund_receipt_id = refund.source_fund_receipt_id
             AND NOT EXISTS (
               SELECT 1 FROM refund_security_hold_adjudications adjudication
               WHERE adjudication.receipt_security_hold_id = security_hold.id
             )
           ORDER BY security_hold.created_at DESC, security_hold.id DESC
           LIMIT 1
         ) AS receipt_security_hold_created_at
       FROM refunds refund
       LEFT JOIN provider_operations operation
         ON operation.subject_type = 'refund'
        AND operation.subject_id = refund.id
        AND operation.kind = 'refund_create'
       LEFT JOIN refund_settlements settlement ON settlement.refund_id = refund.id
       WHERE refund.id = $1`,
      [params.refundId],
    );
    const row = result.rows[0];
    if (!row) return reply.code(404).send({ error: "Refund not found" });
    return refundResponse(row, false);
  });

  app.post("/api/v1/admin/refunds/:refundId/manual-actions", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    await requireStaffPermission(pool, user, "billing.refund_adjudicate");
    await requireRecentReauth(pool, user);
    const params = z.object({ refundId: canonicalUuid }).parse(request.params);
    const body = refundManualActionSchema.parse(request.body);
    const fingerprint = requestFingerprint("admin.refund-manual-action:v1", {
      refundId: params.refundId,
      action: body.action,
      reason: body.reason,
    });

    const outcome = await transaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `refund-manual-action:${body.idempotencyKey}`,
      ]);
      const existing = await client.query<RefundManualActionRow>(
        `SELECT id, refund_id, action, reason, idempotency_key, request_fingerprint, created_at
         FROM refund_manual_actions
         WHERE idempotency_key = $1`,
        [body.idempotencyKey],
      );
      const replay = existing.rows[0];
      if (replay) {
        await requireStaffActionLocked(client, user, "billing.refund_adjudicate");
        if (replay.refund_id !== params.refundId || replay.request_fingerprint !== fingerprint) {
          throw Object.assign(new Error("The idempotency key was used for another manual action"), {
            statusCode: 409,
            code: "IDEMPOTENCY_CONFLICT",
          });
        }
        return { row: replay, replayed: true };
      }

      await requireStaffActionLocked(client, user, "billing.refund_adjudicate");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `refund:${params.refundId}`,
      ]);
      const pointer = await client.query<{ source_fund_receipt_id: string }>(
        "SELECT source_fund_receipt_id FROM refunds WHERE id = $1",
        [params.refundId],
      );
      const receiptId = pointer.rows[0]?.source_fund_receipt_id;
      if (!receiptId) {
        throw Object.assign(new Error("Refund not found"), { statusCode: 404 });
      }
      await client.query("SELECT id FROM fund_receipts WHERE id = $1 FOR UPDATE", [receiptId]);
      const stateResult = await client.query<{
        refund_status: string;
        refund_version: number;
        refund_security_hold: boolean;
        destination: string;
        operation_id: string;
        operation_status: string;
        operation_attempt_count: number;
        active_receipt_hold: boolean;
      }>(
        `SELECT
           refund.status AS refund_status,
           refund.version AS refund_version,
           refund.security_hold AS refund_security_hold,
           refund.destination,
           operation.id AS operation_id,
           operation.status AS operation_status,
           operation.attempt_count AS operation_attempt_count,
           EXISTS (
             SELECT 1
             FROM refund_receipt_security_holds security_hold
             WHERE security_hold.source_fund_receipt_id = refund.source_fund_receipt_id
               AND NOT EXISTS (
                 SELECT 1 FROM refund_security_hold_adjudications adjudication
                 WHERE adjudication.receipt_security_hold_id = security_hold.id
               )
           ) AS active_receipt_hold
         FROM refunds refund
         JOIN provider_operations operation
           ON operation.subject_type = 'refund'
          AND operation.subject_id = refund.id
          AND operation.kind = 'refund_create'
         WHERE refund.id = $1
         FOR UPDATE OF refund, operation`,
        [params.refundId],
      );
      const state = stateResult.rows[0];
      if (!state) {
        throw Object.assign(new Error("Refund Provider operation not found"), { statusCode: 409 });
      }
      if (state.refund_version !== body.expectedRefundVersion) {
        throw Object.assign(new Error("The refund changed; refresh before deciding"), {
          statusCode: 409,
          code: "REFUND_VERSION_CONFLICT",
        });
      }
      if (
        state.refund_status !== "manual" ||
        state.refund_security_hold ||
        state.active_receipt_hold ||
        state.destination !== "original_payment" ||
        state.operation_attempt_count === 0 ||
        ["succeeded", "failed"].includes(state.operation_status)
      ) {
        throw Object.assign(
          new Error("Only an attempted, unsettled manual refund without a receipt hold can use this action"),
          { statusCode: 422, code: "REFUND_MANUAL_ACTION_NOT_ALLOWED" },
        );
      }

      const inserted = await client.query<RefundManualActionRow>(
        `INSERT INTO refund_manual_actions(
           refund_id, action, staff_user_id, staff_session_id, reason,
           idempotency_key, request_fingerprint, expected_refund_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, refund_id, action, reason, idempotency_key,
                   request_fingerprint, created_at`,
        [
          params.refundId,
          body.action,
          user.userId,
          user.sessionId,
          body.reason,
          body.idempotencyKey,
          fingerprint,
          body.expectedRefundVersion,
        ],
      );
      const action = inserted.rows[0];
      if (!action) throw new Error("Unable to record manual refund action");

      if (body.action === "retry_query") {
        await client.query(
          `UPDATE refunds
           SET last_error = 'Administrator scheduled a query-only Provider reconciliation',
               result = result || $2::jsonb, updated_at = now(), version = version + 1
           WHERE id = $1`,
          [params.refundId, { manualActionId: action.id, manualQueryScheduled: true }],
        );
        await client.query(
          `UPDATE provider_operations
           SET status = 'unknown', last_error = NULL, updated_at = now()
           WHERE id = $1`,
          [state.operation_id],
        );
        await client.query(
          `UPDATE durable_jobs
           SET status = 'completed', locked_at = NULL, locked_by = NULL, updated_at = now()
           WHERE job_type = 'refund.start' AND payload->>'refundId' = $1`,
          [params.refundId],
        );
        await client.query(
          `INSERT INTO durable_jobs(job_type, unique_key, payload, status)
           VALUES ('refund.reconcile', $1, $2, 'pending')
           ON CONFLICT (job_type, unique_key) DO UPDATE
           SET payload = EXCLUDED.payload, status = 'pending', available_at = now(), attempts = 0,
               locked_at = NULL, locked_by = NULL, last_error = NULL, updated_at = now()`,
          [
            `refund:${params.refundId}`,
            { refundId: params.refundId, operationId: state.operation_id },
          ],
        );
      } else {
        await client.query(
          `UPDATE refunds
           SET status = 'failed', last_error = 'Administrator confirmed no Provider outflow',
               result = result || $2::jsonb, updated_at = now(), version = version + 1
           WHERE id = $1`,
          [params.refundId, { manualActionId: action.id, confirmedNoOutflow: true }],
        );
        await client.query(
          `UPDATE provider_operations
           SET status = 'failed', last_error = $2, updated_at = now()
           WHERE id = $1`,
          [state.operation_id, body.reason],
        );
        await client.query(
          `UPDATE durable_jobs
           SET status = 'completed', locked_at = NULL, locked_by = NULL,
               last_error = $2, updated_at = now()
           WHERE payload->>'refundId' = $1
             AND job_type IN ('refund.start', 'refund.reconcile')`,
          [params.refundId, body.reason],
        );
      }

      await client.query(
        `INSERT INTO refund_events(
           refund_id, event_type, actor_type, actor_id, reason, metadata
         ) VALUES ($1, $2, 'staff', $3, $4, $5)`,
        [
          params.refundId,
          body.action === "retry_query" ? "manual" : "failed",
          user.userId,
          body.reason,
          { manualActionId: action.id, action: body.action, queryOnly: body.action === "retry_query" },
        ],
      );
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, reason, metadata
         ) VALUES ('staff', $1, $2, 'refund', $3, $4, $5)`,
        [
          user.userId,
          `refund.manual_${body.action}`,
          params.refundId,
          body.reason,
          { manualActionId: action.id, providerOperationId: state.operation_id },
        ],
      );
      return { row: action, replayed: false };
    });

    return reply.code(outcome.replayed ? 200 : 201).send({
      warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      actionId: outcome.row.id,
      refundId: outcome.row.refund_id,
      action: outcome.row.action,
      status:
        outcome.row.action === "retry_query" ? "query_scheduled" : "confirmed_no_outflow",
      replayed: outcome.replayed,
      createdAt: outcome.row.created_at.toISOString(),
    });
  });

  app.post("/api/v1/admin/invoices/:invoiceId/refunds", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    await requireStaffPermission(pool, user, "billing.refund_manage");
    await requireRecentReauth(pool, user);
    const params = z.object({ invoiceId: canonicalUuid }).parse(request.params);
    const body = refundRequestSchema.parse(request.body);
    if (body.destination === "third_party") {
      return reply.code(422).send({
        error:
          "Third-party refund destinations require authenticated ticket authorization and two-person review, which are not yet available",
        code: "THIRD_PARTY_REFUND_DESTINATION_NOT_AVAILABLE",
      });
    }
    const fingerprint = requestFingerprint("admin.manual-refund:v1", {
      invoiceId: params.invoiceId,
      receiptId: body.receiptId,
      destination: body.destination,
      amountMode: body.amountMode,
      amountMinor: body.amountMinor,
      scenario: body.scenario,
      reason: body.reason,
    });

    const outcome = await transaction(pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`refund:idempotency:${body.idempotencyKey}`],
      );
      const replayResult = await client.query<RefundRow>(
        `SELECT refund.*
         FROM refund_request_aliases alias
         JOIN refunds refund ON refund.id = alias.refund_id
         WHERE alias.idempotency_key = $1`,
        [body.idempotencyKey],
      );
      const replay = replayResult.rows[0];
      if (replay) {
        if (
          replay.invoice_id !== params.invoiceId ||
          replay.source_fund_receipt_id !== body.receiptId ||
          replay.request_fingerprint !== fingerprint
        ) {
          throw Object.assign(new Error("The idempotency key was used for another refund"), {
            statusCode: 409,
            code: "IDEMPOTENCY_CONFLICT",
          });
        }
        await lockInvoice(client, replay.invoice_id);
        await requireStaffActionLocked(client, user, "billing.refund_manage");
        await client.query("SELECT id FROM refunds WHERE id = $1 FOR UPDATE", [replay.id]);
        return { row: await readRefund(client, replay.id), replayed: true };
      }
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`refund:fingerprint:${fingerprint}`],
      );
      const semanticReplayResult = await client.query<RefundRow>(
        `SELECT * FROM refunds WHERE request_fingerprint = $1`,
        [fingerprint],
      );
      const semanticReplay = semanticReplayResult.rows[0];
      if (semanticReplay) {
        await lockInvoice(client, semanticReplay.invoice_id);
        await requireStaffActionLocked(client, user, "billing.refund_manage");
        await client.query("SELECT id FROM refunds WHERE id = $1 FOR UPDATE", [
          semanticReplay.id,
        ]);
        await client.query(
          `INSERT INTO refund_request_aliases(
             idempotency_key, refund_id, request_fingerprint
           ) VALUES ($1, $2, $3)`,
          [body.idempotencyKey, semanticReplay.id, fingerprint],
        );
        return { row: await readRefund(client, semanticReplay.id), replayed: true };
      }

      await lockInvoice(client, params.invoiceId);
      await requireStaffActionLocked(client, user, "billing.refund_manage");
      const receiptResult = await client.query<{
        id: string;
        client_account_id: string;
        provider_installation_id: string;
        external_payment_id: string;
        amount_minor: string;
        allocated_minor: string;
        currency: string;
        allocation_invoice_id: string | null;
        allocation_amount_minor: string | null;
        reserved_minor: string;
      }>(
        `SELECT
           receipt.id,
           receipt.client_account_id,
           receipt.provider_installation_id,
           receipt.external_payment_id,
           receipt.amount_minor::text,
           receipt.allocated_minor::text,
           receipt.currency,
           allocation.invoice_id AS allocation_invoice_id,
           allocation.amount_minor::text AS allocation_amount_minor,
           COALESCE(reserved.amount_minor, 0)::text AS reserved_minor
         FROM fund_receipts receipt
         JOIN payment_attempts payment ON payment.id = receipt.reported_payment_attempt_id
         LEFT JOIN payment_allocations allocation
           ON allocation.payment_attempt_id = payment.id
          AND allocation.invoice_id = $2
         LEFT JOIN LATERAL (
           SELECT CASE
             WHEN EXISTS (
               SELECT 1
               FROM refund_receipt_security_holds security_hold
               WHERE security_hold.source_fund_receipt_id = receipt.id
                 AND NOT EXISTS (
                   SELECT 1 FROM refund_security_hold_adjudications adjudication
                   WHERE adjudication.receipt_security_hold_id = security_hold.id
                 )
             )
             OR EXISTS (
               SELECT 1
               FROM refunds manual_refund
               WHERE manual_refund.source_fund_receipt_id = receipt.id
                 AND manual_refund.status = 'manual'
             ) THEN receipt.amount_minor
           ELSE (
               SELECT COALESCE(sum(reserved_outflow.amount_minor), 0)::bigint
               FROM (
                 SELECT reserved_refund.amount_minor
                 FROM refunds reserved_refund
                 WHERE reserved_refund.source_fund_receipt_id = receipt.id
                   AND reserved_refund.status IN ('queued', 'processing', 'unknown', 'succeeded')
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
               ) reserved_outflow
             )
           END AS amount_minor
         ) reserved ON true
         WHERE receipt.id = $1
           AND payment.client_account_id = receipt.client_account_id
           AND payment.provider_installation_id = receipt.provider_installation_id
           AND payment.external_payment_id = receipt.external_payment_id
           AND payment.currency = receipt.currency
         FOR UPDATE OF receipt`,
        [body.receiptId, params.invoiceId],
      );
      const receipt = receiptResult.rows[0];
      if (
        !receipt ||
        receipt.allocation_invoice_id !== params.invoiceId ||
        receipt.allocated_minor !== receipt.amount_minor ||
        receipt.allocation_amount_minor !== receipt.amount_minor
      ) {
        throw Object.assign(
          new Error("Only one fully allocated invoice receipt can be refunded in this release"),
          { statusCode: 422, code: "REFUND_SOURCE_NOT_ELIGIBLE" },
        );
      }

      const availableMinor = BigInt(receipt.amount_minor) - BigInt(receipt.reserved_minor);
      if (
        body.destination !== "none" &&
        body.expectedRefundableMinor !== availableMinor.toString()
      ) {
        throw Object.assign(
          new Error(
            "The refundable amount changed after it was displayed; refresh and confirm the decision again",
          ),
          { statusCode: 409, code: "REFUNDABLE_AMOUNT_CHANGED" },
        );
      }
      const amountMinor =
        body.destination === "none"
          ? 0n
          : body.amountMode === "full"
            ? availableMinor
            : BigInt(body.amountMinor ?? "0");
      if (body.destination !== "none" && (amountMinor <= 0n || amountMinor > availableMinor)) {
        throw Object.assign(new Error("Refund amount exceeds the current refundable amount"), {
          statusCode: 409,
          code: "REFUND_AMOUNT_EXCEEDS_AVAILABLE",
        });
      }
      if (
        body.destination === "original_payment" &&
        receipt.provider_installation_id !== "mock-payment-v1"
      ) {
        throw Object.assign(new Error("The original Payment Provider is not available"), {
          statusCode: 422,
          code: "REFUND_PROVIDER_NOT_AVAILABLE",
        });
      }

      const refundId = randomUUID();
      const status =
        body.destination === "credit"
          ? "succeeded"
          : body.destination === "none"
            ? "declined"
            : "queued";
      const result =
        body.destination === "none"
          ? { decision: "no_refund" }
          : { reservedMinor: amountMinor.toString(), destination: body.destination };
      await client.query(
        `INSERT INTO refunds(
           id, invoice_id, client_account_id, source_fund_receipt_id,
           provider_installation_id, original_external_payment_id,
           destination, amount_mode, amount_minor, currency, status, scenario,
           requested_by_user_id, requested_session_id, requested_client_account_id,
           reason, idempotency_key, request_fingerprint, result
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           $13, $14, $15, $16, $17, $18, $19
         )`,
        [
          refundId,
          params.invoiceId,
          receipt.client_account_id,
          receipt.id,
          body.destination === "original_payment" ? receipt.provider_installation_id : null,
          body.destination === "original_payment" ? receipt.external_payment_id : null,
          body.destination,
          body.amountMode,
          amountMinor.toString(),
          receipt.currency,
          status,
          body.destination === "original_payment" ? body.scenario : null,
          user.userId,
          user.sessionId,
          user.clientAccountId,
          body.reason,
          body.idempotencyKey,
          fingerprint,
          result,
        ],
      );
      await client.query(
        `INSERT INTO refund_events(
           refund_id, event_type, actor_type, actor_id, reason, metadata
         ) VALUES ($1, $2, 'staff', $3, $4, $5)`,
        [
          refundId,
          status === "declined" ? "declined" : status === "succeeded" ? "succeeded" : "requested",
          user.userId,
          body.reason,
          { destination: body.destination, amountMinor: amountMinor.toString() },
        ],
      );
      await client.query(
        `INSERT INTO refund_request_aliases(
           idempotency_key, refund_id, request_fingerprint
         ) VALUES ($1, $2, $3)`,
        [body.idempotencyKey, refundId, fingerprint],
      );

      if (body.destination === "credit") {
        const creditAccount = await client.query<{ id: string }>(
          `INSERT INTO credit_accounts(client_account_id, currency)
           VALUES ($1, $2)
           ON CONFLICT (client_account_id, currency) DO NOTHING
           RETURNING id`,
          [receipt.client_account_id, receipt.currency],
        );
        const lockedCreditAccount = creditAccount.rows[0]
          ? creditAccount
          : await client.query<{ id: string }>(
              `SELECT id
               FROM credit_accounts
               WHERE client_account_id = $1 AND currency = $2
               FOR UPDATE`,
              [receipt.client_account_id, receipt.currency],
            );
        const creditAccountId = lockedCreditAccount.rows[0]?.id;
        if (!creditAccountId) throw new Error("Unable to create Credit account");
        await client.query("SELECT id FROM credit_accounts WHERE id = $1 FOR UPDATE", [
          creditAccountId,
        ]);
        await client.query(
          `INSERT INTO credit_transactions(
             credit_account_id, kind, credit_minor, debit_minor,
             source_type, source_id, actor_type, actor_id, reason,
             idempotency_key, request_fingerprint, result
           ) VALUES ($1, 'refund', $2, 0, 'refund', $3, 'staff', $4, $5, $6, $7, $8)`,
          [
            creditAccountId,
            amountMinor.toString(),
            refundId,
            user.userId,
            body.reason,
            `refund:${refundId}`,
            fingerprint,
            { refundId, invoiceId: params.invoiceId },
          ],
        );
        await client.query(
          `INSERT INTO refund_settlements(
             refund_id, destination, amount_minor, currency, occurred_at
           ) VALUES ($1, 'credit', $2, $3, now())`,
          [refundId, amountMinor.toString(), receipt.currency],
        );
        await postRefundJournal(
          client,
          refundId,
          receipt.currency,
          amountMinor.toString(),
          "credit",
        );
      } else if (body.destination === "original_payment") {
        const operation = await client.query<{ id: string }>(
          `INSERT INTO provider_operations(
             provider_installation_id, kind, subject_type, subject_id, stable_key, status
           ) VALUES ($1, 'refund_create', 'refund', $2, $3, 'queued')
           RETURNING id`,
          [receipt.provider_installation_id, refundId, `refund:${refundId}`],
        );
        const providerOperationId = operation.rows[0]?.id;
        if (!providerOperationId) throw new Error("Unable to create refund Provider operation");
        await client.query(
          `INSERT INTO durable_jobs(job_type, unique_key, payload)
           VALUES ('refund.start', $1, $2)`,
          [
            `refund:${refundId}`,
            { refundId, providerOperationId },
          ],
        );
      }

      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, reason, metadata
         ) VALUES ('staff', $1, $2, 'refund', $3, $4, $5)`,
        [
          user.userId,
          body.destination === "none" ? "refund.declined" : "refund.requested",
          refundId,
          body.reason,
          {
            invoiceId: params.invoiceId,
            receiptId: receipt.id,
            destination: body.destination,
            amountMinor: amountMinor.toString(),
          },
        ],
      );
      return { row: await readRefund(client, refundId), replayed: false };
    });
    return reply.code(outcome.replayed ? 200 : outcome.row.status === "queued" ? 202 : 201).send(
      refundResponse(outcome.row, outcome.replayed),
    );
  });
}
