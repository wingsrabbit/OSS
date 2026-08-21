// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fontkit from "fontkit";
import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { z } from "zod";
import {
  assertCustomerCapability,
  assertFinancialReadEligible,
  assertIdentityReadEligible,
  requireUser,
} from "./auth.js";
import type { Config } from "./config.js";
import type { DatabaseClient, DatabasePool } from "./database.js";
import {
  collectionPage,
  decodeKeysetCursor,
  parseInitialPageQuery,
  parsePageQuery,
  type CollectionPage,
  type PageQuery,
} from "./keyset-pagination.js";

export const LAB_WARNING = "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY";
const PDF_LAB_WARNING = "NOT FOR PRODUCTION - MOCK PROVIDERS ONLY";
const INVOICE_FONT_URL = new URL(
  "../assets/fonts/NotoSansSC-VF.ttf",
  import.meta.url,
);
type PdfLibFontkit = Parameters<PDFDocument["registerFontkit"]>[0];
const pdfLibFontkit: PdfLibFontkit = {
  create(bytes) {
    const sourceFont = fontkit.create(Buffer.from(bytes));
    if (!("createSubset" in sourceFont) || !("getVariation" in sourceFont)) {
      throw new Error("Invoice font must be a single variable TrueType font");
    }
    const weightAxis = sourceFont.variationAxes.wght;
    if (!weightAxis || weightAxis.min > 400 || weightAxis.max < 400) {
      throw new Error("Invoice font must support the Regular wght=400 instance");
    }
    const font = sourceFont.getVariation({ wght: 400 });
    const createSubset = font.createSubset.bind(font);
    font.createSubset = () => {
      const subset = createSubset();
      Object.assign(subset, {
        encodeStream: () => Readable.from([subset.encode()]),
      });
      return subset;
    };
    return font as unknown as ReturnType<PdfLibFontkit["create"]>;
  },
};
let invoiceFontBytesPromise: Promise<Uint8Array> | undefined;

function loadInvoiceFontBytes(): Promise<Uint8Array> {
  invoiceFontBytesPromise ??= readFile(INVOICE_FONT_URL);
  return invoiceFontBytesPromise;
}

type Queryable = Pick<DatabasePool, "query">;

export type OrderSummary = {
  id: string;
  status: string;
  currency: string;
  totalMinor: string;
  submittedAt: string;
  items: Array<{ id: string; productName: string; billingCycle: string }>;
};

export type InvoiceStatus = "open" | "partially_paid" | "paid" | "cancelled";

export type InvoiceSummary = {
  id: string;
  orderId: string | null;
  currency: string;
  totalMinor: string;
  allocatedMinor: string;
  paymentAllocatedMinor: string;
  creditAppliedMinor: string;
  dueMinor: string;
  status: InvoiceStatus;
  dueAt: string;
  createdAt: string;
};

export type PaymentSummary = {
  id: string;
  invoiceId: string;
  status: string;
  amountMinor: string;
  principalMinor: string;
  feeMinor: string;
  currency: string;
  paymentMethodCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreditTransactionSummary = {
  id: string;
  kind: string;
  creditMinor: string;
  debitMinor: string;
  deltaMinor: string;
  sourceType: string;
  sourceId: string;
  reason: string;
  createdAt: string;
};

export type CreditHistory = {
  currency: string;
  balanceMinor: string;
  transactions: CreditTransactionSummary[];
};

export type RefundSummary = {
  id: string;
  invoiceId: string | null;
  status: string;
  destination: string;
  amountMode: string;
  amountMinor: string;
  currency: string;
  createdAt: string;
  updatedAt: string;
};

export type ServiceSummary = {
  id: string;
  orderId: string;
  invoiceIds: string[];
  productName: string;
  status: string;
  billingCycle: string;
  activatedAt: string | null;
  termStart: string | null;
  termEnd: string | null;
  createdAt: string;
  version: number;
  cancellation: {
    requestId: string;
    effectiveAt: string;
    status: string;
  } | null;
};

export type RenewalSummary = {
  id: string;
  serviceId: string;
  invoiceId: string;
  status: string;
  currency: string;
  totalMinor: string;
  allocatedMinor: string;
  dueMinor: string;
  periodStart: string;
  periodEnd: string;
  fundedAt: string | null;
  settledAt: string | null;
  createdAt: string;
};

export type CancellationSummary = {
  requestId: string;
  serviceId: string;
  effectiveAt: string;
  reason: string | null;
  createdAt: string;
  execution: {
    id: string;
    mode: string;
    status: string;
    completedAt: string | null;
  } | null;
};

export type TicketSummary = {
  id: string;
  subject: string;
  status: string;
  serviceId: string | null;
  productName: string | null;
  publicMessageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type NotificationDeliverySummary = {
  id: string;
  attemptNumber: number;
  eventType: string;
  templateRevision: string;
  category: string;
  recipientKind: string;
  recipient: string;
  locale: string;
  status: string;
  operationState: string;
  outcomeStatus: string | null;
  reason: string | null;
  requiresAttention: boolean;
  attempts: number;
  provider: "mock-mail-v1";
  dispatchStartedAt: string | null;
  lastCheckedAt: string | null;
  providerOccurredAt: string | null;
  recordedAt: string | null;
  createdAt: string;
};

export async function listNotificationDeliveriesPage(
  queryable: Queryable,
  clientAccountId: string,
  page: PageQuery,
  scope: string,
): Promise<CollectionPage<NotificationDeliverySummary>> {
  const cursor = decodeKeysetCursor(page.cursor, scope, clientAccountId);
  const result = await queryable.query<{
    id: string;
    attempt_number: number;
    event_type: string;
    template_revision: string;
    category: string;
    recipient_kind: string;
    recipient: string;
    locale: string;
    status: string;
    operation_state: string;
    outcome_status: string | null;
    attempts: number;
    dispatch_started_at: string | null;
    last_checked_at: string | null;
    provider_occurred_at: string | null;
    recorded_at: string | null;
    created_at_cursor: string;
  }>(
    `SELECT operation.id,
            operation.attempt_number,
            operation.event_type,
            operation.template_revision,
            operation.category,
            operation.recipient_kind,
            operation.recipient::text,
            operation.locale,
            operation.status,
            CASE
              WHEN job.status = 'manual'
               AND NOT EXISTS (
                 SELECT 1
                 FROM notification_delivery_operations newer_operation
                 WHERE newer_operation.outbox_id = operation.outbox_id
                   AND newer_operation.attempt_number > operation.attempt_number
               ) THEN 'manual'
              ELSE operation.status
            END AS operation_state,
            fact.status AS outcome_status,
            operation.attempts,
            CASE WHEN operation.dispatch_started_at IS NULL THEN NULL ELSE
              to_char(
                operation.dispatch_started_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              )
            END AS dispatch_started_at,
            CASE WHEN operation.last_checked_at IS NULL THEN NULL ELSE
              to_char(
                operation.last_checked_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              )
            END AS last_checked_at,
            CASE WHEN fact.provider_occurred_at IS NULL THEN NULL ELSE
              to_char(
                fact.provider_occurred_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              )
            END AS provider_occurred_at,
            CASE WHEN fact.recorded_at IS NULL THEN NULL ELSE
              to_char(
                fact.recorded_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              )
            END AS recorded_at,
            to_char(
              operation.created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS created_at_cursor
     FROM notification_delivery_operations operation
     LEFT JOIN notification_delivery_facts fact
       ON fact.outbox_id = operation.outbox_id
      AND fact.attempt_number = operation.attempt_number
      AND fact.provider_operation_id = operation.provider_operation_id
     LEFT JOIN durable_jobs job
       ON job.job_type = 'notification.send'
      AND job.unique_key = 'outbox:' || operation.outbox_id::text
      AND job.payload = pg_catalog.jsonb_build_object(
        'outboxId', operation.outbox_id::text
      )
     WHERE operation.client_account_id = $1
       AND (
         $2::timestamptz IS NULL
         OR (operation.created_at, operation.id) < ($2::timestamptz, $3::uuid)
       )
     ORDER BY operation.created_at DESC, operation.id DESC
     LIMIT $4`,
    [clientAccountId, cursor?.at ?? null, cursor?.id ?? null, page.limit + 1],
  );
  const items = result.rows.map((row) => ({
    id: row.id,
    attemptNumber: row.attempt_number,
    eventType: row.event_type,
    templateRevision: row.template_revision,
    category: row.category,
    recipientKind: row.recipient_kind,
    recipient: row.recipient,
    locale: row.locale,
    status: row.operation_state,
    operationState: row.operation_state,
    outcomeStatus: row.outcome_status,
    reason:
      row.operation_state === "unknown"
        ? "provider_reconciliation_required"
        : row.operation_state === "manual"
          ? "operator_attention_required"
          : row.outcome_status === "bounced"
            ? "provider_reported_bounced"
            : row.outcome_status === "failed"
              ? "provider_reported_failed"
              : row.outcome_status === "skipped"
                ? "not_sent"
                : null,
    requiresAttention:
      row.operation_state === "unknown" || row.operation_state === "manual",
    attempts: row.attempts,
    provider: "mock-mail-v1" as const,
    dispatchStartedAt: row.dispatch_started_at,
    lastCheckedAt: row.last_checked_at,
    providerOccurredAt: row.provider_occurred_at,
    recordedAt: row.recorded_at,
    createdAt: row.created_at_cursor,
  }));
  return collectionPage(items, page.limit, scope, clientAccountId, (item) => ({
    at: item.createdAt,
    id: item.id,
  }));
}

export function maskNotificationRecipient(recipient: string): string {
  const at = recipient.lastIndexOf("@");
  if (at <= 0 || at === recipient.length - 1) return "***";
  return `${recipient.slice(0, 1)}***${recipient.slice(at)}`;
}

function invoiceStatus(
  totalMinor: string,
  allocatedMinor: string,
  cancelled: boolean,
): { status: InvoiceStatus; dueMinor: string } {
  if (cancelled) return { status: "cancelled", dueMinor: "0" };
  const total = BigInt(totalMinor);
  const allocated = BigInt(allocatedMinor);
  const due = total > allocated ? total - allocated : 0n;
  return {
    status: allocated === 0n ? "open" : due > 0n ? "partially_paid" : "paid",
    dueMinor: due.toString(),
  };
}

export async function listOrdersPage(
  queryable: Queryable,
  clientAccountId: string,
  page: PageQuery,
  scope: string,
): Promise<CollectionPage<OrderSummary>> {
  const cursor = decodeKeysetCursor(page.cursor, scope, clientAccountId);
  const result = await queryable.query<{
    order_id: string;
    order_status: string;
    currency: string;
    total_minor: string;
    submitted_at_cursor: string;
    item_id: string | null;
    product_name: string | null;
    billing_cycle: string | null;
  }>(
    `WITH page_orders AS (
       SELECT customer_order.id,
              customer_order.status,
              customer_order.currency,
              customer_order.total_minor,
              customer_order.submitted_at
       FROM orders customer_order
       WHERE customer_order.client_account_id = $1
         AND (
           $2::timestamptz IS NULL
           OR (customer_order.submitted_at, customer_order.id) < ($2::timestamptz, $3::uuid)
         )
       ORDER BY customer_order.submitted_at DESC, customer_order.id DESC
       LIMIT $4
     )
     SELECT customer_order.id AS order_id,
            customer_order.status AS order_status,
            customer_order.currency,
            customer_order.total_minor::text,
            to_char(
              customer_order.submitted_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS submitted_at_cursor,
            item.id AS item_id,
            item.product_name,
            item.billing_cycle
     FROM page_orders customer_order
     LEFT JOIN order_items item ON item.order_id = customer_order.id
     ORDER BY customer_order.submitted_at DESC, customer_order.id DESC, item.id`,
    [clientAccountId, cursor?.at ?? null, cursor?.id ?? null, page.limit + 1],
  );
  const orders = new Map<string, OrderSummary>();
  for (const row of result.rows) {
    let order = orders.get(row.order_id);
    if (!order) {
      order = {
        id: row.order_id,
        status: row.order_status,
        currency: row.currency,
        totalMinor: row.total_minor,
        submittedAt: row.submitted_at_cursor,
        items: [],
      };
      orders.set(row.order_id, order);
    }
    if (row.item_id && row.product_name && row.billing_cycle) {
      order.items.push({
        id: row.item_id,
        productName: row.product_name,
        billingCycle: row.billing_cycle,
      });
    }
  }
  return collectionPage(
    [...orders.values()],
    page.limit,
    scope,
    clientAccountId,
    (order) => ({ at: order.submittedAt, id: order.id }),
  );
}

async function queryInvoices(
  queryable: Queryable,
  clientAccountId: string,
  invoiceId?: string,
  invoiceIds?: string[],
  pagination?: { page: PageQuery; scope: string },
): Promise<InvoiceSummary[]> {
  const cursor = pagination
    ? decodeKeysetCursor(
        pagination.page.cursor,
        pagination.scope,
        clientAccountId,
      )
    : null;
  const result = await queryable.query<{
    id: string;
    order_id: string | null;
    currency: string;
    total_minor: string;
    allocated_minor: string;
    payment_minor: string;
    credit_minor: string;
    due_at: Date;
    created_at_cursor: string;
    renewal_cancelled: boolean;
  }>(
    `SELECT invoice.id,
            customer_order.id AS order_id,
            invoice.currency,
            invoice.total_minor::text,
            (
              COALESCE(payment.amount_minor, 0)
              + COALESCE(fund_receipt.amount_minor, 0)
              + COALESCE(credit.amount_minor, 0)
            )::text AS allocated_minor,
            (
              COALESCE(payment.amount_minor, 0)
              + COALESCE(fund_receipt.amount_minor, 0)
            )::text AS payment_minor,
            COALESCE(credit.amount_minor, 0)::text AS credit_minor,
            invoice.due_at,
            to_char(
              invoice.created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS created_at_cursor,
            COALESCE(
              renewal.status = 'cancelled' AND renewal_service.id IS NOT NULL,
              false
            ) AS renewal_cancelled
     FROM invoices invoice
     LEFT JOIN LATERAL (
       SELECT sum(allocation.amount_minor)::bigint AS amount_minor
       FROM payment_allocations allocation
       JOIN payment_attempts attempt
         ON attempt.id = allocation.payment_attempt_id
        AND attempt.client_account_id = invoice.client_account_id
        AND attempt.invoice_id = invoice.id
       WHERE allocation.invoice_id = invoice.id
     ) payment ON true
     LEFT JOIN LATERAL (
       SELECT sum(allocation.amount_minor)::bigint AS amount_minor
       FROM fund_receipt_allocations allocation
       JOIN fund_receipts receipt
         ON receipt.id = allocation.fund_receipt_id
        AND receipt.client_account_id = invoice.client_account_id
       JOIN fund_receipt_resolutions resolution
         ON resolution.id = allocation.resolution_id
        AND resolution.fund_receipt_id = receipt.id
        AND resolution.client_account_id = invoice.client_account_id
        AND resolution.invoice_id = invoice.id
       WHERE allocation.invoice_id = invoice.id
     ) fund_receipt ON true
     LEFT JOIN LATERAL (
       SELECT sum(allocation.amount_minor)::bigint AS amount_minor
       FROM credit_allocations allocation
       JOIN credit_transactions transaction
         ON transaction.id = allocation.credit_transaction_id
       JOIN credit_accounts credit_account
         ON credit_account.id = transaction.credit_account_id
        AND credit_account.client_account_id = invoice.client_account_id
       WHERE allocation.invoice_id = invoice.id
     ) credit ON true
     LEFT JOIN orders customer_order
       ON customer_order.id = invoice.order_id
      AND customer_order.client_account_id = invoice.client_account_id
     LEFT JOIN service_renewals renewal ON renewal.invoice_id = invoice.id
     LEFT JOIN services renewal_service
       ON renewal_service.id = renewal.service_id
      AND renewal_service.client_account_id = invoice.client_account_id
     WHERE invoice.client_account_id = $1
       AND ($2::uuid IS NULL OR invoice.id = $2::uuid)
       AND ($3::uuid[] IS NULL OR invoice.id = ANY($3::uuid[]))
       ${pagination
         ? `AND (
              $4::timestamptz IS NULL
              OR (invoice.created_at, invoice.id) < ($4::timestamptz, $5::uuid)
            )`
         : ""}
     ORDER BY invoice.created_at DESC, invoice.id DESC
     ${pagination ? "LIMIT $6" : ""}`,
    pagination
      ? [
          clientAccountId,
          invoiceId ?? null,
          invoiceIds ?? null,
          cursor?.at ?? null,
          cursor?.id ?? null,
          pagination.page.limit + 1,
        ]
      : [clientAccountId, invoiceId ?? null, invoiceIds ?? null],
  );
  return result.rows.map((row) => {
    const status = invoiceStatus(
      row.total_minor,
      row.allocated_minor,
      row.renewal_cancelled,
    );
    return {
      id: row.id,
      orderId: row.order_id,
      currency: row.currency,
      totalMinor: row.total_minor,
      allocatedMinor: row.allocated_minor,
      paymentAllocatedMinor: row.payment_minor,
      creditAppliedMinor: row.credit_minor,
      dueMinor: status.dueMinor,
      status: status.status,
      dueAt: row.due_at.toISOString(),
      createdAt: row.created_at_cursor,
    };
  });
}

export function listInvoices(
  queryable: Queryable,
  clientAccountId: string,
  invoiceId?: string,
): Promise<InvoiceSummary[]> {
  return queryInvoices(queryable, clientAccountId, invoiceId, undefined);
}

function listInvoicesForIds(
  queryable: Queryable,
  clientAccountId: string,
  invoiceIds: string[],
): Promise<InvoiceSummary[]> {
  if (invoiceIds.length === 0) return Promise.resolve([]);
  return queryInvoices(queryable, clientAccountId, undefined, invoiceIds);
}

export async function listInvoicesPage(
  queryable: Queryable,
  clientAccountId: string,
  page: PageQuery,
  scope: string,
): Promise<CollectionPage<InvoiceSummary>> {
  const items = await queryInvoices(queryable, clientAccountId, undefined, undefined, {
    page,
    scope,
  });
  return collectionPage(items, page.limit, scope, clientAccountId, (invoice) => ({
    at: invoice.createdAt,
    id: invoice.id,
  }));
}

async function queryPayments(
  queryable: Queryable,
  clientAccountId: string,
  invoiceId?: string,
  invoiceIds?: string[],
  pagination?: { page: PageQuery; scope: string },
): Promise<PaymentSummary[]> {
  const cursor = pagination
    ? decodeKeysetCursor(pagination.page.cursor, pagination.scope, clientAccountId)
    : null;
  const result = await queryable.query<{
    id: string;
    invoice_id: string;
    status: string;
    amount_minor: string;
    principal_minor: string;
    fee_minor: string;
    currency: string;
    payment_method_code: string | null;
    created_at_cursor: string;
    updated_at: Date;
  }>(
    `SELECT attempt.id,
            invoice.id AS invoice_id,
            attempt.status,
            attempt.amount_minor::text,
            COALESCE(attempt.principal_minor, attempt.amount_minor - attempt.fee_minor)::text
              AS principal_minor,
            attempt.fee_minor::text,
            attempt.currency,
            attempt.payment_method_code,
            to_char(
              attempt.created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS created_at_cursor,
            attempt.updated_at
     FROM payment_attempts attempt
     JOIN invoices invoice
       ON invoice.id = attempt.invoice_id
      AND invoice.client_account_id = attempt.client_account_id
     WHERE attempt.client_account_id = $1
       AND invoice.client_account_id = $1
       AND ($2::uuid IS NULL OR attempt.invoice_id = $2::uuid)
       AND ($3::uuid[] IS NULL OR attempt.invoice_id = ANY($3::uuid[]))
       ${pagination
         ? `AND (
              $4::timestamptz IS NULL
              OR (attempt.created_at, attempt.id) < ($4::timestamptz, $5::uuid)
            )`
         : ""}
     ORDER BY attempt.created_at DESC, attempt.id DESC
     ${pagination ? "LIMIT $6" : ""}`,
    pagination
      ? [
          clientAccountId,
          invoiceId ?? null,
          invoiceIds ?? null,
          cursor?.at ?? null,
          cursor?.id ?? null,
          pagination.page.limit + 1,
        ]
      : [clientAccountId, invoiceId ?? null, invoiceIds ?? null],
  );
  return result.rows.map((row) => ({
    id: row.id,
    invoiceId: row.invoice_id,
    status: row.status,
    amountMinor: row.amount_minor,
    principalMinor: row.principal_minor,
    feeMinor: row.fee_minor,
    currency: row.currency,
    paymentMethodCode: row.payment_method_code,
    createdAt: row.created_at_cursor,
    updatedAt: row.updated_at.toISOString(),
  }));
}

export function listPayments(
  queryable: Queryable,
  clientAccountId: string,
  invoiceId?: string,
): Promise<PaymentSummary[]> {
  return queryPayments(queryable, clientAccountId, invoiceId, undefined);
}

function listPaymentsForInvoiceIds(
  queryable: Queryable,
  clientAccountId: string,
  invoiceIds: string[],
): Promise<PaymentSummary[]> {
  if (invoiceIds.length === 0) return Promise.resolve([]);
  return queryPayments(queryable, clientAccountId, undefined, invoiceIds);
}

export async function listPaymentsPage(
  queryable: Queryable,
  clientAccountId: string,
  page: PageQuery,
  scope: string,
): Promise<CollectionPage<PaymentSummary>> {
  const items = await queryPayments(queryable, clientAccountId, undefined, undefined, {
    page,
    scope,
  });
  return collectionPage(items, page.limit, scope, clientAccountId, (payment) => ({
    at: payment.createdAt,
    id: payment.id,
  }));
}

export async function loadCreditHistoryPage(
  queryable: Queryable,
  clientAccountId: string,
  page: PageQuery,
  scope: string,
): Promise<{
  credit: CreditHistory;
  pagination: CollectionPage<CreditTransactionSummary>;
}> {
  const cursor = decodeKeysetCursor(page.cursor, scope, clientAccountId);
  const account = await queryable.query<{
    id: string;
    currency: string;
    balance_minor: string;
  }>(
    `SELECT account.id,
            account.currency,
            COALESCE(sum(transaction.credit_minor - transaction.debit_minor), 0)::text
              AS balance_minor
     FROM credit_accounts account
     LEFT JOIN credit_transactions transaction
       ON transaction.credit_account_id = account.id
     WHERE account.client_account_id = $1
       AND account.currency = 'USD'
     GROUP BY account.id`,
    [clientAccountId],
  );
  const creditAccount = account.rows[0];
  if (!creditAccount) {
    const pagination = collectionPage<CreditTransactionSummary>(
      [],
      page.limit,
      scope,
      clientAccountId,
      (transaction) => ({ at: transaction.createdAt, id: transaction.id }),
    );
    return {
      credit: { currency: "USD", balanceMinor: "0", transactions: [] },
      pagination,
    };
  }
  const transactions = await queryable.query<{
    id: string;
    kind: string;
    credit_minor: string;
    debit_minor: string;
    delta_minor: string;
    source_type: string;
    source_id: string;
    reason: string;
    created_at_cursor: string;
  }>(
    `SELECT id,
            kind,
            credit_minor::text,
            debit_minor::text,
            (credit_minor - debit_minor)::text AS delta_minor,
            source_type,
            source_id,
            reason,
            to_char(
              created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS created_at_cursor
     FROM credit_transactions
     WHERE credit_account_id = $1
       AND (
         $2::timestamptz IS NULL
         OR (created_at, id) < ($2::timestamptz, $3::uuid)
       )
     ORDER BY created_at DESC, id DESC
     LIMIT $4`,
    [creditAccount.id, cursor?.at ?? null, cursor?.id ?? null, page.limit + 1],
  );
  const items = transactions.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    creditMinor: row.credit_minor,
    debitMinor: row.debit_minor,
    deltaMinor: row.delta_minor,
    sourceType: row.source_type,
    sourceId: row.source_id,
    reason: row.reason,
    createdAt: row.created_at_cursor,
  }));
  const pagination = collectionPage(
    items,
    page.limit,
    scope,
    clientAccountId,
    (transaction) => ({ at: transaction.createdAt, id: transaction.id }),
  );
  return {
    credit: {
      currency: creditAccount.currency,
      balanceMinor: creditAccount.balance_minor,
      transactions: pagination.items,
    },
    pagination,
  };
}

async function queryRefunds(
  queryable: Queryable,
  clientAccountId: string,
  invoiceId?: string,
  pagination?: { page: PageQuery; scope: string },
): Promise<RefundSummary[]> {
  const cursor = pagination
    ? decodeKeysetCursor(pagination.page.cursor, pagination.scope, clientAccountId)
    : null;
  const result = await queryable.query<{
    id: string;
    invoice_id: string | null;
    status: string;
    destination: string;
    amount_mode: string;
    amount_minor: string;
    currency: string;
    created_at_cursor: string;
    updated_at: Date;
  }>(
    `SELECT refund.id,
            invoice.id AS invoice_id,
            refund.status,
            refund.destination,
            refund.amount_mode,
            refund.amount_minor::text,
            refund.currency,
            to_char(
              refund.created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS created_at_cursor,
            refund.updated_at
     FROM refunds refund
     LEFT JOIN invoices invoice
       ON invoice.id = refund.invoice_id
      AND invoice.client_account_id = refund.client_account_id
     WHERE refund.client_account_id = $1
       AND ($2::uuid IS NULL OR invoice.id = $2::uuid)
       ${pagination
         ? `AND (
              $3::timestamptz IS NULL
              OR (refund.created_at, refund.id) < ($3::timestamptz, $4::uuid)
            )`
         : ""}
     ORDER BY refund.created_at DESC, refund.id DESC
     ${pagination ? "LIMIT $5" : ""}`,
    pagination
      ? [
          clientAccountId,
          invoiceId ?? null,
          cursor?.at ?? null,
          cursor?.id ?? null,
          pagination.page.limit + 1,
        ]
      : [clientAccountId, invoiceId ?? null],
  );
  return result.rows.map((row) => ({
    id: row.id,
    invoiceId: row.invoice_id,
    status: row.status,
    destination: row.destination,
    amountMode: row.amount_mode,
    amountMinor: row.amount_minor,
    currency: row.currency,
    createdAt: row.created_at_cursor,
    updatedAt: row.updated_at.toISOString(),
  }));
}

export function listRefunds(
  queryable: Queryable,
  clientAccountId: string,
  invoiceId?: string,
): Promise<RefundSummary[]> {
  return queryRefunds(queryable, clientAccountId, invoiceId);
}

export async function listRefundsPage(
  queryable: Queryable,
  clientAccountId: string,
  page: PageQuery,
  scope: string,
): Promise<CollectionPage<RefundSummary>> {
  const items = await queryRefunds(queryable, clientAccountId, undefined, {
    page,
    scope,
  });
  return collectionPage(items, page.limit, scope, clientAccountId, (refund) => ({
    at: refund.createdAt,
    id: refund.id,
  }));
}

async function queryServices(
  queryable: Queryable,
  clientAccountId: string,
  serviceId?: string,
  pagination?: { page: PageQuery; scope: string },
): Promise<ServiceSummary[]> {
  const cursor = pagination
    ? decodeKeysetCursor(pagination.page.cursor, pagination.scope, clientAccountId)
    : null;
  const result = await queryable.query<{
    id: string;
    order_id: string;
    invoice_ids: string[];
    product_name: string;
    status: string;
    billing_cycle: string;
    activated_at: Date | null;
    term_start: Date | null;
    term_end: Date | null;
    created_at_cursor: string;
    version: number;
    cancellation_request_id: string | null;
    cancellation_effective_at: Date | null;
    cancellation_status: string | null;
  }>(
    `SELECT service.id,
            customer_order.id AS order_id,
            ARRAY(
              SELECT linked_invoice.id
              FROM invoices linked_invoice
              WHERE linked_invoice.order_id = customer_order.id
                AND linked_invoice.client_account_id = service.client_account_id
              UNION
              SELECT renewal_invoice.id
              FROM service_renewals renewal
              JOIN invoices renewal_invoice
                ON renewal_invoice.id = renewal.invoice_id
               AND renewal_invoice.client_account_id = service.client_account_id
              WHERE renewal.service_id = service.id
              ORDER BY 1
            ) AS invoice_ids,
            item.product_name,
            service.status,
            service.billing_cycle,
            service.activated_at,
            service.term_start,
            service.term_end,
            to_char(
              service.created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS created_at_cursor,
            service.version,
            service.cancellation_request_id,
            service.cancellation_effective_at,
            cancellation_execution.status AS cancellation_status
     FROM services service
     JOIN order_items item ON item.id = service.order_item_id
     JOIN orders customer_order
       ON customer_order.id = item.order_id
      AND customer_order.client_account_id = service.client_account_id
     LEFT JOIN service_cancellation_executions cancellation_execution
       ON cancellation_execution.cancellation_request_id = service.cancellation_request_id
      AND cancellation_execution.service_id = service.id
     WHERE service.client_account_id = $1
       AND ($2::uuid IS NULL OR service.id = $2::uuid)
       ${pagination
         ? `AND (
              $3::timestamptz IS NULL
              OR (service.created_at, service.id) < ($3::timestamptz, $4::uuid)
            )`
         : ""}
     ORDER BY service.created_at DESC, service.id DESC
     ${pagination ? "LIMIT $5" : ""}`,
    pagination
      ? [
          clientAccountId,
          serviceId ?? null,
          cursor?.at ?? null,
          cursor?.id ?? null,
          pagination.page.limit + 1,
        ]
      : [clientAccountId, serviceId ?? null],
  );
  return result.rows.map((row) => ({
    id: row.id,
    orderId: row.order_id,
    invoiceIds: row.invoice_ids,
    productName: row.product_name,
    status: row.status,
    billingCycle: row.billing_cycle,
    activatedAt: row.activated_at?.toISOString() ?? null,
    termStart: row.term_start?.toISOString() ?? null,
    termEnd: row.term_end?.toISOString() ?? null,
    createdAt: row.created_at_cursor,
    version: row.version,
    cancellation:
      row.cancellation_request_id && row.cancellation_effective_at
        ? {
            requestId: row.cancellation_request_id,
            effectiveAt: row.cancellation_effective_at.toISOString(),
            status: row.cancellation_status ?? "scheduled",
          }
        : null,
  }));
}

export function listServices(
  queryable: Queryable,
  clientAccountId: string,
  serviceId?: string,
): Promise<ServiceSummary[]> {
  return queryServices(queryable, clientAccountId, serviceId);
}

export async function listServicesPage(
  queryable: Queryable,
  clientAccountId: string,
  page: PageQuery,
  scope: string,
): Promise<CollectionPage<ServiceSummary>> {
  const items = await queryServices(queryable, clientAccountId, undefined, {
    page,
    scope,
  });
  return collectionPage(items, page.limit, scope, clientAccountId, (service) => ({
    at: service.createdAt,
    id: service.id,
  }));
}

async function queryRenewals(
  queryable: Queryable,
  clientAccountId: string,
  serviceId?: string,
  pagination?: { page: PageQuery; scope: string },
): Promise<RenewalSummary[]> {
  const cursor = pagination
    ? decodeKeysetCursor(pagination.page.cursor, pagination.scope, clientAccountId)
    : null;
  const result = await queryable.query<{
    id: string;
    service_id: string;
    invoice_id: string;
    status: string;
    currency: string;
    total_minor: string;
    allocated_minor: string;
    period_start: Date;
    period_end: Date;
    funded_at: Date | null;
    settled_at: Date | null;
    created_at_cursor: string;
  }>(
    `SELECT renewal.id,
            service.id AS service_id,
            invoice.id AS invoice_id,
            renewal.status,
            renewal.currency,
            invoice.total_minor::text,
            (
              COALESCE(payment.amount_minor, 0)
              + COALESCE(fund_receipt.amount_minor, 0)
              + COALESCE(credit.amount_minor, 0)
            )::text AS allocated_minor,
            renewal.period_start,
            renewal.period_end,
            renewal.funded_at,
            renewal.settled_at,
            to_char(
              renewal.created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS created_at_cursor
     FROM service_renewals renewal
     JOIN services service ON service.id = renewal.service_id
     JOIN invoices invoice
       ON invoice.id = renewal.invoice_id
      AND invoice.client_account_id = service.client_account_id
     LEFT JOIN LATERAL (
       SELECT sum(allocation.amount_minor)::bigint AS amount_minor
       FROM payment_allocations allocation
       JOIN payment_attempts attempt
         ON attempt.id = allocation.payment_attempt_id
        AND attempt.client_account_id = invoice.client_account_id
        AND attempt.invoice_id = invoice.id
       WHERE allocation.invoice_id = invoice.id
     ) payment ON true
     LEFT JOIN LATERAL (
       SELECT sum(allocation.amount_minor)::bigint AS amount_minor
       FROM fund_receipt_allocations allocation
       JOIN fund_receipts receipt
         ON receipt.id = allocation.fund_receipt_id
        AND receipt.client_account_id = invoice.client_account_id
       JOIN fund_receipt_resolutions resolution
         ON resolution.id = allocation.resolution_id
        AND resolution.fund_receipt_id = receipt.id
        AND resolution.client_account_id = invoice.client_account_id
        AND resolution.invoice_id = invoice.id
       WHERE allocation.invoice_id = invoice.id
     ) fund_receipt ON true
     LEFT JOIN LATERAL (
       SELECT sum(allocation.amount_minor)::bigint AS amount_minor
       FROM credit_allocations allocation
       JOIN credit_transactions transaction
         ON transaction.id = allocation.credit_transaction_id
       JOIN credit_accounts credit_account
         ON credit_account.id = transaction.credit_account_id
        AND credit_account.client_account_id = invoice.client_account_id
       WHERE allocation.invoice_id = invoice.id
     ) credit ON true
     WHERE service.client_account_id = $1
       AND ($2::uuid IS NULL OR service.id = $2::uuid)
       ${pagination
         ? `AND (
              $3::timestamptz IS NULL
              OR (renewal.created_at, renewal.id) < ($3::timestamptz, $4::uuid)
            )`
         : ""}
     ORDER BY renewal.created_at DESC, renewal.id DESC
     ${pagination ? "LIMIT $5" : ""}`,
    pagination
      ? [
          clientAccountId,
          serviceId ?? null,
          cursor?.at ?? null,
          cursor?.id ?? null,
          pagination.page.limit + 1,
        ]
      : [clientAccountId, serviceId ?? null],
  );
  return result.rows.map((row) => {
    const due = row.status === "cancelled"
      ? 0n
      : BigInt(row.total_minor) > BigInt(row.allocated_minor)
        ? BigInt(row.total_minor) - BigInt(row.allocated_minor)
        : 0n;
    return {
      id: row.id,
      serviceId: row.service_id,
      invoiceId: row.invoice_id,
      status: row.status,
      currency: row.currency,
      totalMinor: row.total_minor,
      allocatedMinor: row.allocated_minor,
      dueMinor: due.toString(),
      periodStart: row.period_start.toISOString(),
      periodEnd: row.period_end.toISOString(),
      fundedAt: row.funded_at?.toISOString() ?? null,
      settledAt: row.settled_at?.toISOString() ?? null,
      createdAt: row.created_at_cursor,
    };
  });
}

export function listRenewals(
  queryable: Queryable,
  clientAccountId: string,
  serviceId?: string,
): Promise<RenewalSummary[]> {
  return queryRenewals(queryable, clientAccountId, serviceId);
}

export async function listRenewalsPage(
  queryable: Queryable,
  clientAccountId: string,
  page: PageQuery,
  scope: string,
): Promise<CollectionPage<RenewalSummary>> {
  const items = await queryRenewals(queryable, clientAccountId, undefined, {
    page,
    scope,
  });
  return collectionPage(items, page.limit, scope, clientAccountId, (renewal) => ({
    at: renewal.createdAt,
    id: renewal.id,
  }));
}

async function queryCancellations(
  queryable: Queryable,
  clientAccountId: string,
  serviceId?: string,
  pagination?: { page: PageQuery; scope: string },
): Promise<CancellationSummary[]> {
  const cursor = pagination
    ? decodeKeysetCursor(pagination.page.cursor, pagination.scope, clientAccountId)
    : null;
  const result = await queryable.query<{
    request_id: string;
    service_id: string;
    effective_at: Date;
    reason: string | null;
    created_at_cursor: string;
    execution_id: string | null;
    execution_mode: string | null;
    execution_status: string | null;
    completed_at: Date | null;
  }>(
    `SELECT cancellation.id AS request_id,
            service.id AS service_id,
            cancellation.effective_at,
            cancellation.reason,
            to_char(
              cancellation.created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS created_at_cursor,
            execution.id AS execution_id,
            execution.execution_mode,
            execution.status AS execution_status,
            execution.completed_at
     FROM service_cancellation_requests cancellation
     JOIN services service
       ON service.id = cancellation.service_id
      AND service.client_account_id = cancellation.client_account_id
     LEFT JOIN service_cancellation_executions execution
       ON execution.cancellation_request_id = cancellation.id
      AND execution.service_id = cancellation.service_id
     WHERE cancellation.client_account_id = $1
       AND ($2::uuid IS NULL OR cancellation.service_id = $2::uuid)
       ${pagination
         ? `AND (
              $3::timestamptz IS NULL
              OR (cancellation.created_at, cancellation.id) < ($3::timestamptz, $4::uuid)
            )`
         : ""}
     ORDER BY cancellation.created_at DESC, cancellation.id DESC
     ${pagination ? "LIMIT $5" : ""}`,
    pagination
      ? [
          clientAccountId,
          serviceId ?? null,
          cursor?.at ?? null,
          cursor?.id ?? null,
          pagination.page.limit + 1,
        ]
      : [clientAccountId, serviceId ?? null],
  );
  return result.rows.map((row) => ({
    requestId: row.request_id,
    serviceId: row.service_id,
    effectiveAt: row.effective_at.toISOString(),
    reason: row.reason,
    createdAt: row.created_at_cursor,
    execution: row.execution_id
      ? {
          id: row.execution_id,
          mode: row.execution_mode ?? "manual",
          status: row.execution_status ?? "scheduled",
          completedAt: row.completed_at?.toISOString() ?? null,
        }
      : null,
  }));
}

export function listCancellations(
  queryable: Queryable,
  clientAccountId: string,
  serviceId?: string,
): Promise<CancellationSummary[]> {
  return queryCancellations(queryable, clientAccountId, serviceId);
}

export async function listCancellationsPage(
  queryable: Queryable,
  clientAccountId: string,
  page: PageQuery,
  scope: string,
): Promise<CollectionPage<CancellationSummary>> {
  const items = await queryCancellations(queryable, clientAccountId, undefined, {
    page,
    scope,
  });
  return collectionPage(items, page.limit, scope, clientAccountId, (cancellation) => ({
    at: cancellation.createdAt,
    id: cancellation.requestId,
  }));
}

async function queryTickets(
  queryable: Queryable,
  clientAccountId: string,
  serviceId?: string,
  pagination?: { page: PageQuery; scope: string },
): Promise<TicketSummary[]> {
  const cursor = pagination
    ? decodeKeysetCursor(pagination.page.cursor, pagination.scope, clientAccountId)
    : null;
  const result = await queryable.query<{
    id: string;
    subject: string;
    status: string;
    service_id: string | null;
    product_name: string | null;
    public_message_count: string;
    created_at_cursor: string;
    updated_at: Date;
  }>(
     `SELECT ticket.id,
            ticket.subject,
            ticket.status,
            service.id AS service_id,
            CASE WHEN ticket_order.id IS NULL THEN NULL ELSE item.product_name END
              AS product_name,
            count(message.id) FILTER (WHERE message.visibility = 'public')::text
              AS public_message_count,
            to_char(
              ticket.created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS created_at_cursor,
            ticket.updated_at
     FROM support_tickets ticket
     LEFT JOIN services service
       ON service.id = ticket.service_id
      AND service.client_account_id = ticket.client_account_id
     LEFT JOIN order_items item ON item.id = service.order_item_id
     LEFT JOIN orders ticket_order
       ON ticket_order.id = item.order_id
      AND ticket_order.client_account_id = ticket.client_account_id
     LEFT JOIN support_ticket_messages message ON message.ticket_id = ticket.id
     WHERE ticket.client_account_id = $1
       AND ($2::uuid IS NULL OR ticket.service_id = $2::uuid)
       ${pagination
         ? `AND (
              $3::timestamptz IS NULL
              OR (ticket.created_at, ticket.id) < ($3::timestamptz, $4::uuid)
            )`
         : ""}
     GROUP BY ticket.id, service.id, item.product_name, ticket_order.id
     ORDER BY ticket.created_at DESC, ticket.id DESC
     ${pagination ? "LIMIT $5" : ""}`,
    pagination
      ? [
          clientAccountId,
          serviceId ?? null,
          cursor?.at ?? null,
          cursor?.id ?? null,
          pagination.page.limit + 1,
        ]
      : [clientAccountId, serviceId ?? null],
  );
  return result.rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    status: row.status,
    serviceId: row.service_id,
    productName: row.product_name,
    publicMessageCount: Number(row.public_message_count),
    createdAt: row.created_at_cursor,
    updatedAt: row.updated_at.toISOString(),
  }));
}

export function listTickets(
  queryable: Queryable,
  clientAccountId: string,
  serviceId?: string,
): Promise<TicketSummary[]> {
  return queryTickets(queryable, clientAccountId, serviceId);
}

export async function listTicketsPage(
  queryable: Queryable,
  clientAccountId: string,
  page: PageQuery,
  scope: string,
): Promise<CollectionPage<TicketSummary>> {
  const items = await queryTickets(queryable, clientAccountId, undefined, {
    page,
    scope,
  });
  return collectionPage(items, page.limit, scope, clientAccountId, (ticket) => ({
    at: ticket.createdAt,
    id: ticket.id,
  }));
}

export async function withReadSnapshot<T>(
  pool: DatabasePool,
  work: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function requestError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

type InvoiceLine = {
  id: string;
  kind: string;
  description: string;
  amountMinor: string;
};

async function loadInvoiceLines(
  queryable: Queryable,
  invoiceId: string,
): Promise<InvoiceLine[]> {
  const result = await queryable.query<{
    id: string;
    kind: string;
    description: string;
    amount_minor: string;
  }>(
    `SELECT id, kind, description, amount_minor::text
     FROM invoice_lines
     WHERE invoice_id = $1
     ORDER BY id`,
    [invoiceId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    description: row.description,
    amountMinor: row.amount_minor,
  }));
}

async function loadCreditApplications(
  queryable: Queryable,
  clientAccountId: string,
  invoiceId: string,
): Promise<Array<{ transactionId: string; amountMinor: string; createdAt: string }>> {
  const result = await queryable.query<{
    transaction_id: string;
    amount_minor: string;
    created_at: Date;
  }>(
    `SELECT transaction.id AS transaction_id,
            allocation.amount_minor::text,
            allocation.created_at
     FROM credit_allocations allocation
     JOIN credit_transactions transaction
       ON transaction.id = allocation.credit_transaction_id
     JOIN credit_accounts credit_account
       ON credit_account.id = transaction.credit_account_id
     JOIN invoices invoice
       ON invoice.id = allocation.invoice_id
      AND invoice.client_account_id = credit_account.client_account_id
     WHERE allocation.invoice_id = $1
       AND invoice.client_account_id = $2
     ORDER BY allocation.created_at, allocation.id`,
    [invoiceId, clientAccountId],
  );
  return result.rows.map((row) => ({
    transactionId: row.transaction_id,
    amountMinor: row.amount_minor,
    createdAt: row.created_at.toISOString(),
  }));
}

async function loadInvoiceRelations(
  queryable: Queryable,
  clientAccountId: string,
  invoiceId: string,
): Promise<{ order_id: string | null; service_ids: string[]; renewal_ids: string[] }> {
  const result = await queryable.query<{
    order_id: string | null;
    service_ids: string[];
    renewal_ids: string[];
  }>(
    `SELECT COALESCE(
              initial_order.id,
              (
                SELECT renewal_order.id
                FROM service_renewals renewal
                JOIN services service ON service.id = renewal.service_id
                JOIN order_items item ON item.id = service.order_item_id
                JOIN orders renewal_order
                  ON renewal_order.id = item.order_id
                 AND renewal_order.client_account_id = service.client_account_id
                WHERE renewal.invoice_id = invoice.id
                  AND service.client_account_id = invoice.client_account_id
              )
            ) AS order_id,
            ARRAY(
              SELECT service.id
              FROM services service
              JOIN order_items item ON item.id = service.order_item_id
              WHERE item.order_id = initial_order.id
                AND service.client_account_id = invoice.client_account_id
              UNION
              SELECT service.id
              FROM service_renewals renewal
              JOIN services service
                ON service.id = renewal.service_id
               AND service.client_account_id = invoice.client_account_id
              WHERE renewal.invoice_id = invoice.id
              ORDER BY 1
            ) AS service_ids,
            ARRAY(
              SELECT renewal.id
              FROM service_renewals renewal
              JOIN services service
                ON service.id = renewal.service_id
               AND service.client_account_id = invoice.client_account_id
              WHERE renewal.invoice_id = invoice.id
              ORDER BY renewal.id
            ) AS renewal_ids
     FROM invoices invoice
     LEFT JOIN orders initial_order
       ON initial_order.id = invoice.order_id
      AND initial_order.client_account_id = invoice.client_account_id
     WHERE invoice.id = $1
       AND invoice.client_account_id = $2`,
    [invoiceId, clientAccountId],
  );
  return result.rows[0] ?? { order_id: null, service_ids: [], renewal_ids: [] };
}

type PdfTextRun = {
  font: PDFFont;
  text: string;
};

function pdfFontForCharacter(regular: PDFFont, unicode: PDFFont, character: string): PDFFont {
  try {
    regular.encodeText(character);
    return regular;
  } catch {
    return unicode;
  }
}

function pdfTextRuns(
  regular: PDFFont,
  unicode: PDFFont,
  characters: readonly string[],
): PdfTextRun[] {
  const runs: PdfTextRun[] = [];
  for (const character of characters) {
    const font = pdfFontForCharacter(regular, unicode, character);
    const previous = runs.at(-1);
    if (previous?.font === font) {
      previous.text += character;
    } else {
      runs.push({ font, text: character });
    }
  }
  return runs;
}

function wrapPdfText(
  regular: PDFFont,
  unicode: PDFFont,
  value: string,
  size: number,
  width: number,
): PdfTextRun[][] {
  const text = value.replace(/[\r\n\t]+/g, " ").trim();
  if (!text) return [[{ font: regular, text: "" }]];
  const lines: PdfTextRun[][] = [];
  let current: string[] = [];
  let currentWidth = 0;
  for (const character of text) {
    const font = pdfFontForCharacter(regular, unicode, character);
    const characterWidth = font.widthOfTextAtSize(character, size);
    if (current.length > 0 && currentWidth + characterWidth > width) {
      while (current.at(-1) === " ") current.pop();
      lines.push(pdfTextRuns(regular, unicode, current));
      current = character === " " ? [] : [character];
      currentWidth = character === " " ? 0 : characterWidth;
    } else {
      current.push(character);
      currentWidth += characterWidth;
    }
  }
  while (current.at(-1) === " ") current.pop();
  if (current.length > 0) lines.push(pdfTextRuns(regular, unicode, current));
  return lines;
}

function pdfFontForText(regular: PDFFont, unicode: PDFFont, value: string): PDFFont {
  try {
    regular.encodeText(value);
    return regular;
  } catch {
    return unicode;
  }
}

function drawPdfFooter(page: PDFPage, regular: PDFFont, pageNumber: number): void {
  page.drawLine({
    start: { x: 48, y: 42 },
    end: { x: 547, y: 42 },
    thickness: 0.7,
    color: rgb(0.8, 0.82, 0.85),
  });
  page.drawText("OpenSales System Mock-only Laboratory", {
    x: 48,
    y: 25,
    size: 8,
    font: regular,
    color: rgb(0.35, 0.4, 0.48),
  });
  page.drawText(`Page ${pageNumber}`, {
    x: 505,
    y: 25,
    size: 8,
    font: regular,
    color: rgb(0.35, 0.4, 0.48),
  });
}

function formatPdfMoney(currency: string, minorValue: string): string {
  const minor = BigInt(minorValue);
  if (currency !== "USD") return `${currency} ${minor.toString()} minor units`;
  const sign = minor < 0n ? "-" : "";
  const absolute = minor < 0n ? -minor : minor;
  return `${sign}USD ${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function formatPdfUtcDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

export async function renderInvoicePdf(input: {
  clientAccountId: string;
  relatedOrderId: string | null;
  invoice: InvoiceSummary & { lines: InvoiceLine[] };
}): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  document.registerFontkit(pdfLibFontkit);
  document.setTitle(`OpenSales System Laboratory Invoice ${input.invoice.id}`);
  document.setAuthor("OpenSales System Mock-only Laboratory");
  document.setSubject(PDF_LAB_WARNING);
  document.setProducer("OpenSales System / pdf-lib");
  document.setCreator("OpenSales System API");
  const invoiceCreatedAt = new Date(input.invoice.createdAt);
  if (!Number.isNaN(invoiceCreatedAt.getTime())) {
    const deterministicMetadataDate = new Date(
      Math.floor(invoiceCreatedAt.getTime() / 1_000) * 1_000,
    );
    document.setCreationDate(deterministicMetadataDate);
    document.setModificationDate(deterministicMetadataDate);
  }
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const unicode = await document.embedFont(await loadInvoiceFontBytes(), {
    subset: true,
    customName: "OSSINV+NotoSansSC-Regular",
  });
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 48;
  let pageNumber = 0;
  let page!: PDFPage;
  let y = 0;

  const addPage = (): void => {
    pageNumber += 1;
    page = document.addPage([pageWidth, pageHeight]);
    page.drawRectangle({
      x: 0,
      y: pageHeight - 42,
      width: pageWidth,
      height: 42,
      color: rgb(0.7, 0.08, 0.1),
    });
    page.drawText(PDF_LAB_WARNING, {
      x: margin,
      y: pageHeight - 27,
      size: 11,
      font: bold,
      color: rgb(1, 1, 1),
    });
    y = pageHeight - 75;
  };
  const ensureSpace = (height: number): void => {
    if (y - height >= 60) return;
    drawPdfFooter(page, regular, pageNumber);
    addPage();
  };
  const drawLabelValue = (label: string, value: string): void => {
    ensureSpace(18);
    const valueFont = pdfFontForText(regular, unicode, value);
    page.drawText(label, {
      x: margin,
      y,
      size: 9,
      font: bold,
      color: rgb(0.28, 0.32, 0.38),
    });
    page.drawText(value.replace(/[\r\n\t]+/g, " "), {
      x: 175,
      y,
      size: 9,
      font: valueFont,
      color: rgb(0.1, 0.13, 0.18),
    });
    y -= 16;
  };
  const drawInvoiceLineHeader = (continued = false): void => {
    if (continued) {
      page.drawText("Immutable invoice lines (continued)", {
        x: margin,
        y,
        size: 14,
        font: bold,
        color: rgb(0.08, 0.16, 0.28),
      });
      y -= 25;
    }
    page.drawRectangle({
      x: margin,
      y: y - 4,
      width: pageWidth - margin * 2,
      height: 22,
      color: rgb(0.92, 0.94, 0.97),
    });
    page.drawText("Description", { x: margin + 8, y: y + 3, size: 9, font: bold });
    page.drawText("Kind", { x: 380, y: y + 3, size: 9, font: bold });
    page.drawText("Amount", { x: 480, y: y + 3, size: 9, font: bold });
    y -= 21;
  };

  addPage();
  page.drawText("OpenSales System Laboratory Invoice", {
    x: margin,
    y,
    size: 23,
    font: bold,
    color: rgb(0.08, 0.16, 0.28),
  });
  y -= 36;
  drawLabelValue("Invoice ID", input.invoice.id);
  drawLabelValue(
    "Order ID",
    input.invoice.orderId ?? input.relatedOrderId ?? "Renewal invoice - no order ID",
  );
  drawLabelValue("Client Account ID", input.clientAccountId);
  drawLabelValue("Status", input.invoice.status.replaceAll("_", " ").toUpperCase());
  drawLabelValue("Currency", input.invoice.currency);
  drawLabelValue("Issued", formatPdfUtcDate(input.invoice.createdAt));
  drawLabelValue("Due", formatPdfUtcDate(input.invoice.dueAt));
  y -= 10;

  ensureSpace(48);
  page.drawText("Immutable invoice lines", {
    x: margin,
    y,
    size: 14,
    font: bold,
    color: rgb(0.08, 0.16, 0.28),
  });
  y -= 25;
  drawInvoiceLineHeader();
  for (const line of input.invoice.lines) {
    const descriptionLines = wrapPdfText(regular, unicode, line.description, 9, 300);
    let descriptionOffset = 0;
    let firstChunk = true;
    while (descriptionOffset < descriptionLines.length) {
      let availableLineCount = Math.floor((y - 72) / 12);
      if (availableLineCount < 1) {
        drawPdfFooter(page, regular, pageNumber);
        addPage();
        drawInvoiceLineHeader(true);
        availableLineCount = Math.floor((y - 72) / 12);
      }
      const descriptionChunk = descriptionLines.slice(
        descriptionOffset,
        descriptionOffset + availableLineCount,
      );
      const rowHeight = Math.max(22, descriptionChunk.length * 12 + 8);
      descriptionChunk.forEach((description, index) => {
        let descriptionX = margin + 8;
        for (const run of description) {
          page.drawText(run.text, {
            x: descriptionX,
            y: y - index * 12,
            size: 9,
            font: run.font,
          });
          descriptionX += run.font.widthOfTextAtSize(run.text, 9);
        }
      });
      if (firstChunk) {
        page.drawText(line.kind.replace(/[\r\n\t]+/g, " "), {
          x: 380,
          y,
          size: 9,
          font: regular,
        });
        const amount = formatPdfMoney(input.invoice.currency, line.amountMinor);
        page.drawText(amount, {
          x: 480 - Math.max(0, regular.widthOfTextAtSize(amount, 8) - 55),
          y,
          size: 8,
          font: regular,
        });
      }
      y -= rowHeight;
      page.drawLine({
        start: { x: margin, y: y + 6 },
        end: { x: pageWidth - margin, y: y + 6 },
        thickness: 0.5,
        color: rgb(0.86, 0.88, 0.91),
      });
      descriptionOffset += descriptionChunk.length;
      firstChunk = false;
      if (descriptionOffset < descriptionLines.length) {
        drawPdfFooter(page, regular, pageNumber);
        addPage();
        drawInvoiceLineHeader(true);
      }
    }
  }

  ensureSpace(125);
  y -= 8;
  page.drawText("Allocation totals", {
    x: margin,
    y,
    size: 14,
    font: bold,
    color: rgb(0.08, 0.16, 0.28),
  });
  y -= 24;
  drawLabelValue("Invoice total", formatPdfMoney(input.invoice.currency, input.invoice.totalMinor));
  drawLabelValue(
    "Payment allocated",
    formatPdfMoney(input.invoice.currency, input.invoice.paymentAllocatedMinor),
  );
  drawLabelValue(
    "Credit allocated",
    formatPdfMoney(input.invoice.currency, input.invoice.creditAppliedMinor),
  );
  drawLabelValue(
    "Allocated total",
    formatPdfMoney(input.invoice.currency, input.invoice.allocatedMinor),
  );
  drawLabelValue("Amount due", formatPdfMoney(input.invoice.currency, input.invoice.dueMinor));

  drawPdfFooter(page, regular, pageNumber);
  return document.save({ useObjectStreams: false });
}

async function loadInvoiceDetail(
  queryable: Queryable,
  clientAccountId: string,
  invoiceId: string,
) {
  const [invoice] = await listInvoices(queryable, clientAccountId, invoiceId);
  if (!invoice) throw requestError("Invoice not found", 404);
  const lines = await loadInvoiceLines(queryable, invoiceId);
  const payments = await listPayments(queryable, clientAccountId, invoiceId);
  const creditApplications = await loadCreditApplications(
    queryable,
    clientAccountId,
    invoiceId,
  );
  const refunds = await listRefunds(queryable, clientAccountId, invoiceId);
  const relations = await loadInvoiceRelations(queryable, clientAccountId, invoiceId);
  return {
    warning: LAB_WARNING,
    invoice: { ...invoice, lines },
    payments,
    creditApplications,
    refunds,
    related: {
      orderId: relations.order_id,
      serviceIds: relations.service_ids,
      renewalIds: relations.renewal_ids,
    },
    pdfUrl: `/api/v1/customer/invoices/${invoice.id}/pdf`,
  };
}

const businessHistoryFacetSchema = z.enum([
  "orders",
  "invoices",
  "payments",
  "creditTransactions",
  "refunds",
  "services",
  "renewals",
  "cancellations",
  "tickets",
]);

type BusinessHistoryFacet = z.infer<typeof businessHistoryFacetSchema>;

function pageMetadata<T>(page: CollectionPage<T>) {
  return {
    limit: page.limit,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  };
}

async function loadBusinessHistoryFacet(
  queryable: Queryable,
  clientAccountId: string,
  facet: BusinessHistoryFacet,
  page: PageQuery,
): Promise<CollectionPage<unknown>> {
  const scope = `customer.business-history.${facet}`;
  switch (facet) {
    case "orders":
      return listOrdersPage(queryable, clientAccountId, page, scope);
    case "invoices":
      return listInvoicesPage(queryable, clientAccountId, page, scope);
    case "payments":
      return listPaymentsPage(queryable, clientAccountId, page, scope);
    case "creditTransactions":
      return (await loadCreditHistoryPage(queryable, clientAccountId, page, scope))
        .pagination;
    case "refunds":
      return listRefundsPage(queryable, clientAccountId, page, scope);
    case "services":
      return listServicesPage(queryable, clientAccountId, page, scope);
    case "renewals":
      return listRenewalsPage(queryable, clientAccountId, page, scope);
    case "cancellations":
      return listCancellationsPage(queryable, clientAccountId, page, scope);
    case "tickets":
      return listTicketsPage(queryable, clientAccountId, page, scope);
  }
}

export async function registerCustomerHistoryRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get("/api/v1/customer/notification-deliveries", async (request) => {
    const user = await requireUser(request, pool, config);
    assertIdentityReadEligible(user);
    assertCustomerCapability(user, "account.history.read");
    const page = parsePageQuery(request.query);
    return withReadSnapshot(pool, async (client) => {
      const account = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM client_accounts WHERE id = $1",
        [user.clientAccountId],
      );
      const currentAccount = account.rows[0];
      if (!currentAccount) throw requestError("Client account not found", 404);
      const collection = await listNotificationDeliveriesPage(
        client,
        user.clientAccountId,
        page,
        "customer.notification-deliveries",
      );
      return {
        warning: LAB_WARNING,
        account: currentAccount,
        ...collection,
        items: collection.items.map((item) => ({
          ...item,
          recipient: maskNotificationRecipient(item.recipient),
        })),
      };
    });
  });

  app.get("/api/v1/customer/business-history", async (request) => {
    const user = await requireUser(request, pool, config);
    assertFinancialReadEligible(user);
    const page = parseInitialPageQuery(request.query);
    return withReadSnapshot(pool, async (client) => {
      const account = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM client_accounts WHERE id = $1",
        [user.clientAccountId],
      );
      const currentAccount = account.rows[0];
      if (!currentAccount) throw requestError("Client account not found", 404);
      const orders = await listOrdersPage(
        client,
        user.clientAccountId,
        page,
        "customer.business-history.orders",
      );
      const invoices = await listInvoicesPage(
        client,
        user.clientAccountId,
        page,
        "customer.business-history.invoices",
      );
      const payments = await listPaymentsPage(
        client,
        user.clientAccountId,
        page,
        "customer.business-history.payments",
      );
      const creditResult = await loadCreditHistoryPage(
        client,
        user.clientAccountId,
        page,
        "customer.business-history.creditTransactions",
      );
      const refunds = await listRefundsPage(
        client,
        user.clientAccountId,
        page,
        "customer.business-history.refunds",
      );
      const services = await listServicesPage(
        client,
        user.clientAccountId,
        page,
        "customer.business-history.services",
      );
      const renewals = await listRenewalsPage(
        client,
        user.clientAccountId,
        page,
        "customer.business-history.renewals",
      );
      const cancellations = await listCancellationsPage(
        client,
        user.clientAccountId,
        page,
        "customer.business-history.cancellations",
      );
      const tickets = await listTicketsPage(
        client,
        user.clientAccountId,
        page,
        "customer.business-history.tickets",
      );
      return {
        warning: LAB_WARNING,
        account: currentAccount,
        orders: orders.items,
        invoices: invoices.items,
        payments: payments.items,
        credit: creditResult.credit,
        refunds: refunds.items,
        services: services.items,
        renewals: renewals.items,
        cancellations: cancellations.items,
        tickets: tickets.items,
        pagination: {
          orders: pageMetadata(orders),
          invoices: pageMetadata(invoices),
          payments: pageMetadata(payments),
          creditTransactions: pageMetadata(creditResult.pagination),
          refunds: pageMetadata(refunds),
          services: pageMetadata(services),
          renewals: pageMetadata(renewals),
          cancellations: pageMetadata(cancellations),
          tickets: pageMetadata(tickets),
        },
      };
    });
  });

  app.get("/api/v1/customer/business-history/:facet", async (request) => {
    const user = await requireUser(request, pool, config);
    assertFinancialReadEligible(user);
    const params = z.object({ facet: businessHistoryFacetSchema }).parse(request.params);
    const page = parsePageQuery(request.query);
    return withReadSnapshot(pool, async (client) => {
      const account = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM client_accounts WHERE id = $1",
        [user.clientAccountId],
      );
      const currentAccount = account.rows[0];
      if (!currentAccount) throw requestError("Client account not found", 404);
      const collection = await loadBusinessHistoryFacet(
        client,
        user.clientAccountId,
        params.facet,
        page,
      );
      return {
        warning: LAB_WARNING,
        account: currentAccount,
        facet: params.facet,
        ...collection,
      };
    });
  });

  app.get("/api/v1/customer/invoices/:invoiceId", async (request) => {
    const user = await requireUser(request, pool, config);
    assertFinancialReadEligible(user);
    const params = z.object({ invoiceId: z.uuid() }).parse(request.params);
    return withReadSnapshot(pool, (client) =>
      loadInvoiceDetail(client, user.clientAccountId, params.invoiceId),
    );
  });

  app.get("/api/v1/customer/invoices/:invoiceId/pdf", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    assertFinancialReadEligible(user);
    const params = z.object({ invoiceId: z.uuid() }).parse(request.params);
    const detail = await withReadSnapshot(pool, (client) =>
      loadInvoiceDetail(client, user.clientAccountId, params.invoiceId),
    );
    const bytes = await renderInvoicePdf({
      clientAccountId: user.clientAccountId,
      relatedOrderId: detail.related.orderId,
      invoice: detail.invoice,
    });
    return reply
      .type("application/pdf")
      .header(
        "Content-Disposition",
        `attachment; filename="invoice-${detail.invoice.id}.pdf"`,
      )
      .send(Buffer.from(bytes));
  });

  app.get("/api/v1/customer/services/:serviceId", async (request) => {
    const user = await requireUser(request, pool, config);
    assertFinancialReadEligible(user);
    const params = z.object({ serviceId: z.uuid() }).parse(request.params);
    return withReadSnapshot(pool, async (client) => {
      const service = (await listServices(client, user.clientAccountId, params.serviceId))[0];
      if (!service) throw requestError("Service not found", 404);
      const orderResult = await client.query<{
        id: string;
        status: string;
        currency: string;
        total_minor: string;
        submitted_at: Date;
        external_resource_id: string | null;
      }>(
        `SELECT customer_order.id,
                customer_order.status,
                customer_order.currency,
                customer_order.total_minor::text,
                customer_order.submitted_at,
                service.external_resource_id
         FROM services service
         JOIN order_items item ON item.id = service.order_item_id
         JOIN orders customer_order
           ON customer_order.id = item.order_id
          AND customer_order.client_account_id = service.client_account_id
         WHERE service.id = $1
           AND service.client_account_id = $2
           AND customer_order.client_account_id = $2`,
        [service.id, user.clientAccountId],
      );
      const order = orderResult.rows[0];
      if (!order) throw requestError("Service not found", 404);
      const linkedInvoices = (await listInvoicesForIds(
        client,
        user.clientAccountId,
        service.invoiceIds,
      ))
        .map((invoice) => ({
          ...invoice,
          kind: invoice.orderId === service.orderId ? "initial" as const : "renewal" as const,
        }));
      const payments = await listPaymentsForInvoiceIds(
        client,
        user.clientAccountId,
        service.invoiceIds,
      );
      const periodsResult = await client.query<{
        id: string;
        invoice_id: string;
        period_kind: string;
        period_start: Date;
        period_end: Date;
        granted_at: Date;
      }>(
        `SELECT period.id,
                invoice.id AS invoice_id,
                period.period_kind,
                period.period_start,
                period.period_end,
                period.granted_at
         FROM service_periods period
         JOIN invoices invoice
           ON invoice.id = period.invoice_id
          AND invoice.client_account_id = $2
         WHERE period.service_id = $1
         ORDER BY period.period_start, period.id`,
        [service.id, user.clientAccountId],
      );
      const periods = periodsResult.rows.map((row) => ({
        id: row.id,
        invoiceId: row.invoice_id,
        kind: row.period_kind,
        start: row.period_start.toISOString(),
        end: row.period_end.toISOString(),
        grantedAt: row.granted_at.toISOString(),
      }));
      const renewals = await listRenewals(client, user.clientAccountId, service.id);
      const cancellation = (await listCancellations(client, user.clientAccountId, service.id))[0] ?? null;
      const tickets = await listTickets(client, user.clientAccountId, service.id);
      return {
        warning: LAB_WARNING,
        service: { ...service, externalResourceId: order.external_resource_id },
        order: {
          id: order.id,
          status: order.status,
          currency: order.currency,
          totalMinor: order.total_minor,
          submittedAt: order.submitted_at.toISOString(),
        },
        invoices: linkedInvoices,
        payments,
        periods,
        renewals,
        cancellation,
        tickets,
        trace: {
          orderId: service.orderId,
          invoiceIds: linkedInvoices.map((invoice) => invoice.id),
          paymentIds: payments.map((payment) => payment.id),
          renewalIds: renewals.map((renewal) => renewal.id),
          cancellationRequestId: cancellation?.requestId ?? null,
          ticketIds: tickets.map((ticket) => ticket.id),
        },
      };
    });
  });
}
