// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FastifyInstance } from "fastify";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { z } from "zod";
import {
  assertFinancialReadEligible,
  requireUser,
} from "./auth.js";
import type { Config } from "./config.js";
import type { DatabaseClient, DatabasePool } from "./database.js";

export const LAB_WARNING = "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY";
const PDF_LAB_WARNING = "NOT FOR PRODUCTION - MOCK PROVIDERS ONLY";

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

export async function listOrders(
  queryable: Queryable,
  clientAccountId: string,
): Promise<OrderSummary[]> {
  const result = await queryable.query<{
    order_id: string;
    order_status: string;
    currency: string;
    total_minor: string;
    submitted_at: Date;
    item_id: string | null;
    product_name: string | null;
    billing_cycle: string | null;
  }>(
    `SELECT customer_order.id AS order_id,
            customer_order.status AS order_status,
            customer_order.currency,
            customer_order.total_minor::text,
            customer_order.submitted_at,
            item.id AS item_id,
            item.product_name,
            item.billing_cycle
     FROM orders customer_order
     LEFT JOIN order_items item ON item.order_id = customer_order.id
     WHERE customer_order.client_account_id = $1
     ORDER BY customer_order.submitted_at DESC, customer_order.id DESC, item.id`,
    [clientAccountId],
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
        submittedAt: row.submitted_at.toISOString(),
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
  return [...orders.values()];
}

export async function listInvoices(
  queryable: Queryable,
  clientAccountId: string,
  invoiceId?: string,
): Promise<InvoiceSummary[]> {
  const result = await queryable.query<{
    id: string;
    order_id: string | null;
    currency: string;
    total_minor: string;
    allocated_minor: string;
    payment_minor: string;
    credit_minor: string;
    due_at: Date;
    created_at: Date;
    renewal_cancelled: boolean;
  }>(
    `SELECT invoice.id,
            invoice.order_id,
            invoice.currency,
            invoice.total_minor::text,
            allocation.allocated_minor::text,
            allocation.payment_minor::text,
            allocation.credit_minor::text,
            invoice.due_at,
            invoice.created_at,
            COALESCE(renewal.status = 'cancelled', false) AS renewal_cancelled
     FROM invoices invoice
     JOIN invoice_allocation_totals allocation ON allocation.invoice_id = invoice.id
     LEFT JOIN service_renewals renewal ON renewal.invoice_id = invoice.id
     WHERE invoice.client_account_id = $1
       AND ($2::uuid IS NULL OR invoice.id = $2::uuid)
     ORDER BY invoice.created_at DESC, invoice.id DESC`,
    [clientAccountId, invoiceId ?? null],
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
      createdAt: row.created_at.toISOString(),
    };
  });
}

export async function listPayments(
  queryable: Queryable,
  clientAccountId: string,
  invoiceId?: string,
): Promise<PaymentSummary[]> {
  const result = await queryable.query<{
    id: string;
    invoice_id: string;
    status: string;
    amount_minor: string;
    principal_minor: string;
    fee_minor: string;
    currency: string;
    payment_method_code: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT attempt.id,
            attempt.invoice_id,
            attempt.status,
            attempt.amount_minor::text,
            COALESCE(attempt.principal_minor, attempt.amount_minor - attempt.fee_minor)::text
              AS principal_minor,
            attempt.fee_minor::text,
            attempt.currency,
            attempt.payment_method_code,
            attempt.created_at,
            attempt.updated_at
     FROM payment_attempts attempt
     WHERE attempt.client_account_id = $1
       AND ($2::uuid IS NULL OR attempt.invoice_id = $2::uuid)
     ORDER BY attempt.created_at DESC, attempt.id DESC`,
    [clientAccountId, invoiceId ?? null],
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
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

export async function loadCreditHistory(
  queryable: Queryable,
  clientAccountId: string,
): Promise<CreditHistory> {
  const account = await queryable.query<{ id: string; currency: string }>(
    `SELECT id, currency
     FROM credit_accounts
     WHERE client_account_id = $1 AND currency = 'USD'`,
    [clientAccountId],
  );
  const creditAccount = account.rows[0];
  if (!creditAccount) {
    return { currency: "USD", balanceMinor: "0", transactions: [] };
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
    created_at: Date;
  }>(
    `SELECT id,
            kind,
            credit_minor::text,
            debit_minor::text,
            (credit_minor - debit_minor)::text AS delta_minor,
            source_type,
            source_id,
            reason,
            created_at
     FROM credit_transactions
     WHERE credit_account_id = $1
     ORDER BY created_at DESC, id DESC`,
    [creditAccount.id],
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
    createdAt: row.created_at.toISOString(),
  }));
  return {
    currency: creditAccount.currency,
    balanceMinor: items
      .reduce((balance, item) => balance + BigInt(item.deltaMinor), 0n)
      .toString(),
    transactions: items,
  };
}

export async function listRefunds(
  queryable: Queryable,
  clientAccountId: string,
  invoiceId?: string,
): Promise<RefundSummary[]> {
  const result = await queryable.query<{
    id: string;
    invoice_id: string | null;
    status: string;
    destination: string;
    amount_mode: string;
    amount_minor: string;
    currency: string;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id,
            invoice_id,
            status,
            destination,
            amount_mode,
            amount_minor::text,
            currency,
            created_at,
            updated_at
     FROM refunds
     WHERE client_account_id = $1
       AND ($2::uuid IS NULL OR invoice_id = $2::uuid)
     ORDER BY created_at DESC, id DESC`,
    [clientAccountId, invoiceId ?? null],
  );
  return result.rows.map((row) => ({
    id: row.id,
    invoiceId: row.invoice_id,
    status: row.status,
    destination: row.destination,
    amountMode: row.amount_mode,
    amountMinor: row.amount_minor,
    currency: row.currency,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

export async function listServices(
  queryable: Queryable,
  clientAccountId: string,
  serviceId?: string,
): Promise<ServiceSummary[]> {
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
              UNION
              SELECT renewal.invoice_id
              FROM service_renewals renewal
              WHERE renewal.service_id = service.id
              ORDER BY 1
            ) AS invoice_ids,
            item.product_name,
            service.status,
            service.billing_cycle,
            service.activated_at,
            service.term_start,
            service.term_end,
            service.version,
            service.cancellation_request_id,
            service.cancellation_effective_at,
            cancellation_execution.status AS cancellation_status
     FROM services service
     JOIN order_items item ON item.id = service.order_item_id
     JOIN orders customer_order ON customer_order.id = item.order_id
     LEFT JOIN service_cancellation_executions cancellation_execution
       ON cancellation_execution.cancellation_request_id = service.cancellation_request_id
     WHERE service.client_account_id = $1
       AND ($2::uuid IS NULL OR service.id = $2::uuid)
     ORDER BY service.created_at DESC, service.id DESC`,
    [clientAccountId, serviceId ?? null],
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

export async function listRenewals(
  queryable: Queryable,
  clientAccountId: string,
  serviceId?: string,
): Promise<RenewalSummary[]> {
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
    created_at: Date;
  }>(
    `SELECT renewal.id,
            renewal.service_id,
            renewal.invoice_id,
            renewal.status,
            renewal.currency,
            invoice.total_minor::text,
            allocation.allocated_minor::text,
            renewal.period_start,
            renewal.period_end,
            renewal.funded_at,
            renewal.settled_at,
            renewal.created_at
     FROM service_renewals renewal
     JOIN services service ON service.id = renewal.service_id
     JOIN invoices invoice ON invoice.id = renewal.invoice_id
     JOIN invoice_allocation_totals allocation ON allocation.invoice_id = invoice.id
     WHERE service.client_account_id = $1
       AND ($2::uuid IS NULL OR service.id = $2::uuid)
     ORDER BY renewal.created_at DESC, renewal.id DESC`,
    [clientAccountId, serviceId ?? null],
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
      createdAt: row.created_at.toISOString(),
    };
  });
}

export async function listCancellations(
  queryable: Queryable,
  clientAccountId: string,
  serviceId?: string,
): Promise<CancellationSummary[]> {
  const result = await queryable.query<{
    request_id: string;
    service_id: string;
    effective_at: Date;
    reason: string | null;
    created_at: Date;
    execution_id: string | null;
    execution_mode: string | null;
    execution_status: string | null;
    completed_at: Date | null;
  }>(
    `SELECT cancellation.id AS request_id,
            cancellation.service_id,
            cancellation.effective_at,
            cancellation.reason,
            cancellation.created_at,
            execution.id AS execution_id,
            execution.execution_mode,
            execution.status AS execution_status,
            execution.completed_at
     FROM service_cancellation_requests cancellation
     LEFT JOIN service_cancellation_executions execution
       ON execution.cancellation_request_id = cancellation.id
     WHERE cancellation.client_account_id = $1
       AND ($2::uuid IS NULL OR cancellation.service_id = $2::uuid)
     ORDER BY cancellation.created_at DESC, cancellation.id DESC`,
    [clientAccountId, serviceId ?? null],
  );
  return result.rows.map((row) => ({
    requestId: row.request_id,
    serviceId: row.service_id,
    effectiveAt: row.effective_at.toISOString(),
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
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

export async function listTickets(
  queryable: Queryable,
  clientAccountId: string,
  serviceId?: string,
): Promise<TicketSummary[]> {
  const result = await queryable.query<{
    id: string;
    subject: string;
    status: string;
    service_id: string | null;
    product_name: string | null;
    public_message_count: string;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT ticket.id,
            ticket.subject,
            ticket.status,
            ticket.service_id,
            item.product_name,
            count(message.id) FILTER (WHERE message.visibility = 'public')::text
              AS public_message_count,
            ticket.created_at,
            ticket.updated_at
     FROM support_tickets ticket
     LEFT JOIN services service ON service.id = ticket.service_id
     LEFT JOIN order_items item ON item.id = service.order_item_id
     LEFT JOIN support_ticket_messages message ON message.ticket_id = ticket.id
     WHERE ticket.client_account_id = $1
       AND ($2::uuid IS NULL OR ticket.service_id = $2::uuid)
     GROUP BY ticket.id, item.product_name
     ORDER BY ticket.updated_at DESC, ticket.id DESC`,
    [clientAccountId, serviceId ?? null],
  );
  return result.rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    status: row.status,
    serviceId: row.service_id,
    productName: row.product_name,
    publicMessageCount: Number(row.public_message_count),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

async function withReadSnapshot<T>(
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
     WHERE allocation.invoice_id = $1
     ORDER BY allocation.created_at, allocation.id`,
    [invoiceId],
  );
  return result.rows.map((row) => ({
    transactionId: row.transaction_id,
    amountMinor: row.amount_minor,
    createdAt: row.created_at.toISOString(),
  }));
}

async function loadInvoiceRelations(
  queryable: Queryable,
  invoiceId: string,
): Promise<{ order_id: string | null; service_ids: string[]; renewal_ids: string[] }> {
  const result = await queryable.query<{
    order_id: string | null;
    service_ids: string[];
    renewal_ids: string[];
  }>(
    `SELECT COALESCE(
              invoice.order_id,
              (
                SELECT item.order_id
                FROM service_renewals renewal
                JOIN services service ON service.id = renewal.service_id
                JOIN order_items item ON item.id = service.order_item_id
                WHERE renewal.invoice_id = invoice.id
              )
            ) AS order_id,
            ARRAY(
              SELECT service.id
              FROM services service
              JOIN order_items item ON item.id = service.order_item_id
              WHERE item.order_id = invoice.order_id
              UNION
              SELECT renewal.service_id
              FROM service_renewals renewal
              WHERE renewal.invoice_id = invoice.id
              ORDER BY 1
            ) AS service_ids,
            ARRAY(
              SELECT renewal.id
              FROM service_renewals renewal
              WHERE renewal.invoice_id = invoice.id
              ORDER BY renewal.id
            ) AS renewal_ids
     FROM invoices invoice
     WHERE invoice.id = $1`,
    [invoiceId],
  );
  return result.rows[0] ?? { order_id: null, service_ids: [], renewal_ids: [] };
}

function safePdfText(font: PDFFont, value: string): string {
  let output = "";
  for (const character of value.replace(/[\r\n\t]+/g, " ")) {
    try {
      font.encodeText(character);
      output += character;
    } catch {
      output += "?";
    }
  }
  return output;
}

function wrapPdfText(font: PDFFont, value: string, size: number, width: number): string[] {
  const text = safePdfText(font, value).trim();
  if (!text) return [""];
  const lines: string[] = [];
  let current = "";
  for (const character of text) {
    const candidate = current + character;
    if (current && font.widthOfTextAtSize(candidate, size) > width) {
      lines.push(current.trimEnd());
      current = character.trimStart();
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current.trimEnd());
  return lines;
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
  const document = await PDFDocument.create();
  document.setTitle(`OpenSales System Laboratory Invoice ${input.invoice.id}`);
  document.setAuthor("OpenSales System Mock-only Laboratory");
  document.setSubject(PDF_LAB_WARNING);
  document.setProducer("OpenSales System / pdf-lib");
  document.setCreator("OpenSales System API");
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
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
    page.drawText(label, {
      x: margin,
      y,
      size: 9,
      font: bold,
      color: rgb(0.28, 0.32, 0.38),
    });
    page.drawText(safePdfText(regular, value), {
      x: 175,
      y,
      size: 9,
      font: regular,
      color: rgb(0.1, 0.13, 0.18),
    });
    y -= 16;
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
  page.drawRectangle({
    x: margin,
    y: y - 4,
    width: pageWidth - margin * 2,
    height: 22,
    color: rgb(0.92, 0.94, 0.97),
  });
  page.drawText("Description", { x: margin + 8, y: y + 3, size: 9, font: bold });
  page.drawText("Kind", { x: 385, y: y + 3, size: 9, font: bold });
  page.drawText("Amount", { x: 480, y: y + 3, size: 9, font: bold });
  y -= 21;
  for (const line of input.invoice.lines) {
    const descriptionLines = wrapPdfText(regular, line.description, 9, 315);
    const rowHeight = Math.max(22, descriptionLines.length * 12 + 8);
    ensureSpace(rowHeight + 4);
    descriptionLines.forEach((description, index) => {
      page.drawText(description, {
        x: margin + 8,
        y: y - index * 12,
        size: 9,
        font: regular,
      });
    });
    page.drawText(safePdfText(regular, line.kind), {
      x: 385,
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
    y -= rowHeight;
    page.drawLine({
      start: { x: margin, y: y + 6 },
      end: { x: pageWidth - margin, y: y + 6 },
      thickness: 0.5,
      color: rgb(0.86, 0.88, 0.91),
    });
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
  const creditApplications = await loadCreditApplications(queryable, invoiceId);
  const refunds = await listRefunds(queryable, clientAccountId, invoiceId);
  const relations = await loadInvoiceRelations(queryable, invoiceId);
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

export async function registerCustomerHistoryRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get("/api/v1/customer/business-history", async (request) => {
    const user = await requireUser(request, pool, config);
    assertFinancialReadEligible(user);
    return withReadSnapshot(pool, async (client) => {
      const account = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM client_accounts WHERE id = $1",
        [user.clientAccountId],
      );
      const currentAccount = account.rows[0];
      if (!currentAccount) throw requestError("Client account not found", 404);
      const orders = await listOrders(client, user.clientAccountId);
      const invoices = await listInvoices(client, user.clientAccountId);
      const payments = await listPayments(client, user.clientAccountId);
      const credit = await loadCreditHistory(client, user.clientAccountId);
      const refunds = await listRefunds(client, user.clientAccountId);
      const services = await listServices(client, user.clientAccountId);
      const renewals = await listRenewals(client, user.clientAccountId);
      const cancellations = await listCancellations(client, user.clientAccountId);
      const tickets = await listTickets(client, user.clientAccountId);
      return {
        warning: LAB_WARNING,
        account: currentAccount,
        orders,
        invoices,
        payments,
        credit,
        refunds,
        services,
        renewals,
        cancellations,
        tickets,
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
         JOIN orders customer_order ON customer_order.id = item.order_id
         WHERE service.id = $1 AND service.client_account_id = $2`,
        [service.id, user.clientAccountId],
      );
      const order = orderResult.rows[0];
      if (!order) throw requestError("Service not found", 404);
      const invoices = await listInvoices(client, user.clientAccountId);
      const linkedInvoices = invoices
        .filter((invoice) => service.invoiceIds.includes(invoice.id))
        .map((invoice) => ({
          ...invoice,
          kind: invoice.orderId === service.orderId ? "initial" as const : "renewal" as const,
        }));
      const payments = (await listPayments(client, user.clientAccountId)).filter((payment) =>
        service.invoiceIds.includes(payment.invoiceId),
      );
      const periodsResult = await client.query<{
        id: string;
        invoice_id: string;
        period_kind: string;
        period_start: Date;
        period_end: Date;
        granted_at: Date;
      }>(
        `SELECT id, invoice_id, period_kind, period_start, period_end, granted_at
         FROM service_periods
         WHERE service_id = $1
         ORDER BY period_start, id`,
        [service.id],
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
