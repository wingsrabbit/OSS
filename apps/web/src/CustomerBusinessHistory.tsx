// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { ServiceOperationsPanel } from "./ServiceOperationsPanel.js";

export type Locale = "en" | "zh-CN";

export type OrderHistory = {
  id: string;
  status: string;
  currency: string;
  totalMinor: string;
  submittedAt: string;
  items: Array<{ id: string; productName: string; billingCycle: string }>;
};

export type InvoiceSummary = {
  id: string;
  orderId: string | null;
  currency: string;
  totalMinor: string;
  allocatedMinor: string;
  paymentAllocatedMinor: string;
  creditAppliedMinor: string;
  dueMinor: string;
  status: "open" | "partially_paid" | "paid" | "cancelled";
  dueAt: string;
  createdAt: string;
};

export type PaymentHistory = {
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

export type CreditHistory = {
  currency: string;
  balanceMinor: string;
  transactions: Array<{
    id: string;
    kind: string;
    creditMinor: string;
    debitMinor: string;
    deltaMinor: string;
    sourceType: string;
    sourceId: string;
    reason: string | null;
    createdAt: string;
  }>;
};

export type RefundHistory = {
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
  cancellation: { requestId: string; effectiveAt: string; status: string } | null;
};

export type RenewalHistory = {
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

export type CancellationHistory = {
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

export type TicketHistory = {
  id: string;
  subject: string;
  status: string;
  serviceId: string | null;
  productName: string | null;
  publicMessageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type BusinessHistory = {
  warning: string;
  account: { id: string; name: string };
  orders: OrderHistory[];
  invoices: InvoiceSummary[];
  payments: PaymentHistory[];
  credit: CreditHistory;
  refunds: RefundHistory[];
  services: ServiceSummary[];
  renewals: RenewalHistory[];
  cancellations: CancellationHistory[];
  tickets: TicketHistory[];
};

type InvoiceDetail = {
  warning: string;
  invoice: InvoiceSummary & {
    lines: Array<{ id: string; kind: string; description: string; amountMinor: string }>;
  };
  payments: PaymentHistory[];
  creditApplications: Array<{ transactionId: string; amountMinor: string; createdAt: string }>;
  refunds: RefundHistory[];
  related: { orderId: string | null; serviceIds: string[]; renewalIds: string[] };
  pdfUrl: string;
};

type ServiceDetail = {
  warning: string;
  service: ServiceSummary & { externalResourceId: string | null };
  order: { id: string; status: string; currency: string; totalMinor: string; submittedAt: string };
  invoices: Array<InvoiceSummary & { kind: "initial" | "renewal" }>;
  payments: PaymentHistory[];
  periods: Array<{
    id: string;
    invoiceId: string;
    kind: string;
    start: string;
    end: string;
    grantedAt: string;
  }>;
  renewals: RenewalHistory[];
  cancellation: CancellationHistory | null;
  tickets: TicketHistory[];
  trace: {
    orderId: string;
    invoiceIds: string[];
    paymentIds: string[];
    renewalIds: string[];
    cancellationRequestId: string | null;
    ticketIds: string[];
  };
};

function usd(minor: string): string {
  const value = BigInt(minor);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}$${(absolute / 100n).toLocaleString("en-US")}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function when(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function surfaceIsActive(): boolean {
  return (window.location.pathname.replace(/\/+$/, "") || "/") === "/customer";
}

function replaceDetailQuery(kind: "invoice" | "service" | null, id?: string): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("invoice");
  url.searchParams.delete("service");
  if (kind && id) url.searchParams.set(kind, id);
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function Empty({ children }: { children: string }) {
  return <p className="muted">{children}</p>;
}

export function CustomerBusinessHistory({
  active,
  canReadHistory,
  canManageServices,
  accessFingerprint,
  clientAccountId,
  locale,
  onNotice,
  onError,
}: {
  active: boolean;
  canReadHistory: boolean;
  canManageServices: boolean;
  accessFingerprint: string;
  clientAccountId: string | null;
  locale: Locale;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [history, setHistory] = useState<BusinessHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [invoiceDetail, setInvoiceDetail] = useState<InvoiceDetail | null>(null);
  const [serviceDetail, setServiceDetail] = useState<ServiceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const activeAccountId = useRef(clientAccountId);

  useLayoutEffect(() => {
    if (activeAccountId.current === clientAccountId) return;
    activeAccountId.current = clientAccountId;
    requestGeneration.current += 1;
    detailGeneration.current += 1;
    setHistory(null);
    setInvoiceDetail(null);
    setServiceDetail(null);
    setLoading(false);
    setDetailLoading(null);
    replaceDetailQuery(null);
  }, [clientAccountId]);

  const loadHistory = useCallback(async (): Promise<boolean> => {
    if (!active || !canReadHistory || !clientAccountId || !surfaceIsActive()) return false;
    const accountId = clientAccountId;
    const generation = ++requestGeneration.current;
    setLoading(true);
    try {
      const result = await api<BusinessHistory>("/api/v1/customer/business-history");
      if (
        generation !== requestGeneration.current ||
        activeAccountId.current !== accountId ||
        !surfaceIsActive()
      ) return false;
      setHistory(result);
      return true;
    } catch (caught) {
      if (
        generation !== requestGeneration.current ||
        activeAccountId.current !== accountId ||
        !surfaceIsActive()
      ) return false;
      onError(caught instanceof Error ? caught.message : "Business history could not be loaded");
      return false;
    } finally {
      if (
        generation === requestGeneration.current &&
        activeAccountId.current === accountId &&
        surfaceIsActive()
      ) setLoading(false);
    }
  }, [active, canReadHistory, clientAccountId, onError]);

  const openInvoice = useCallback(async (invoiceId: string, updateLocation = true) => {
    if (!active || !canReadHistory || !clientAccountId || !surfaceIsActive()) return;
    const accountId = clientAccountId;
    const generation = ++detailGeneration.current;
    setDetailLoading(`invoice:${invoiceId}`);
    if (updateLocation) replaceDetailQuery("invoice", invoiceId);
    try {
      const result = await api<InvoiceDetail>(`/api/v1/customer/invoices/${invoiceId}`);
      if (
        generation !== detailGeneration.current ||
        activeAccountId.current !== accountId ||
        !surfaceIsActive()
      ) return;
      setInvoiceDetail(result);
      setServiceDetail(null);
      requestAnimationFrame(() => document.getElementById("customer-history-detail")?.scrollIntoView({ block: "start" }));
    } catch (caught) {
      if (
        generation !== detailGeneration.current ||
        activeAccountId.current !== accountId ||
        !surfaceIsActive()
      ) return;
      onError(caught instanceof Error ? caught.message : "Invoice detail could not be loaded");
    } finally {
      if (
        generation === detailGeneration.current &&
        activeAccountId.current === accountId &&
        surfaceIsActive()
      ) setDetailLoading(null);
    }
  }, [active, canReadHistory, clientAccountId, onError]);

  const openService = useCallback(async (serviceId: string, updateLocation = true) => {
    if (!active || !canReadHistory || !clientAccountId || !surfaceIsActive()) return;
    const accountId = clientAccountId;
    const generation = ++detailGeneration.current;
    setDetailLoading(`service:${serviceId}`);
    if (updateLocation) replaceDetailQuery("service", serviceId);
    try {
      const result = await api<ServiceDetail>(`/api/v1/customer/services/${serviceId}`);
      if (
        generation !== detailGeneration.current ||
        activeAccountId.current !== accountId ||
        !surfaceIsActive()
      ) return;
      setServiceDetail(result);
      setInvoiceDetail(null);
      requestAnimationFrame(() => document.getElementById("customer-history-detail")?.scrollIntoView({ block: "start" }));
    } catch (caught) {
      if (
        generation !== detailGeneration.current ||
        activeAccountId.current !== accountId ||
        !surfaceIsActive()
      ) return;
      onError(caught instanceof Error ? caught.message : "Service detail could not be loaded");
    } finally {
      if (
        generation === detailGeneration.current &&
        activeAccountId.current === accountId &&
        surfaceIsActive()
      ) setDetailLoading(null);
    }
  }, [active, canReadHistory, clientAccountId, onError]);

  useEffect(() => {
    if (!active || !canReadHistory || !clientAccountId) {
      requestGeneration.current += 1;
      detailGeneration.current += 1;
      setHistory(null);
      setInvoiceDetail(null);
      setServiceDetail(null);
      setLoading(false);
      setDetailLoading(null);
      return;
    }
    void loadHistory();
    const query = new URLSearchParams(window.location.search);
    const invoiceId = query.get("invoice");
    const serviceId = query.get("service");
    if (invoiceId) void openInvoice(invoiceId, false);
    else if (serviceId) void openService(serviceId, false);
    return () => {
      requestGeneration.current += 1;
      detailGeneration.current += 1;
    };
  }, [active, canReadHistory, clientAccountId, loadHistory, openInvoice, openService]);

  if (!active || !canReadHistory || !clientAccountId) return null;

  return (
    <section className="order-panel business-history" aria-label="Customer business history" data-testid="customer-business-history">
      <div className="history-heading">
        <div>
          <p className="eyebrow">Customer account · durable business facts</p>
          <h2>{locale === "zh-CN" ? "业务历史" : "Business history"}</h2>
          <p>
            {locale === "zh-CN"
              ? "订单、发票、付款、Credit、服务、续费、取消和工单保持为独立、可追溯的事实。"
              : "Orders, invoices, payments, Credit, services, renewals, cancellations and tickets remain separate, traceable facts."}
          </p>
        </div>
        <button disabled={loading} onClick={() => void loadHistory()}>
          {loading ? "Refreshing…" : "Refresh history"}
        </button>
      </div>

      {loading && !history && <p className="muted">Loading the saved account history…</p>}
      {history && (
        <>
          <p className="history-account" data-testid="history-account">
            {history.account.name} · <span className="mono">{history.account.id}</span>
          </p>
          <div className="history-grid">
            <article className="history-card" aria-label="Order history">
              <h3>Orders <span className="history-count">{history.orders.length}</span></h3>
              {history.orders.length === 0 ? <Empty>No orders yet.</Empty> : history.orders.map((order) => (
                <details id={`order-${order.id}`} data-testid="history-order" key={order.id}>
                  <summary>{order.items.map((item) => item.productName).join(", ")} · {order.status}</summary>
                  <span>{usd(order.totalMinor)} {order.currency} · {when(order.submittedAt)}</span>
                  {order.items.map((item) => <span key={item.id}>{item.productName} · {item.billingCycle}</span>)}
                  <span className="mono">{order.id}</span>
                </details>
              ))}
            </article>

            <article className="history-card" aria-label="Invoice history">
              <h3>Invoices <span className="history-count">{history.invoices.length}</span></h3>
              {history.invoices.length === 0 ? <Empty>No invoices yet.</Empty> : history.invoices.map((invoice) => (
                <button
                  className="history-row"
                  data-testid="history-invoice"
                  id={`invoice-${invoice.id}`}
                  key={invoice.id}
                  onClick={() => void openInvoice(invoice.id)}
                >
                  <strong>{invoice.status} · {usd(invoice.totalMinor)}</strong>
                  <span>Due {usd(invoice.dueMinor)} · {when(invoice.dueAt)}</span>
                  <span className="mono">{invoice.id}</span>
                </button>
              ))}
            </article>

            <article className="history-card" aria-label="Payment history">
              <h3>Payments <span className="history-count">{history.payments.length}</span></h3>
              {history.payments.length === 0 ? <Empty>No payment attempts yet.</Empty> : history.payments.map((payment) => (
                <details data-testid="history-payment" key={payment.id}>
                  <summary>{payment.paymentMethodCode ?? "unspecified method"} · {payment.status} · {usd(payment.amountMinor)}</summary>
                  <span>Principal {usd(payment.principalMinor)} · fee {usd(payment.feeMinor)}</span>
                  <span>Invoice <a href={`#invoice-${payment.invoiceId}`}>{payment.invoiceId}</a></span>
                  <span>{when(payment.updatedAt)}</span>
                  <span className="mono">{payment.id}</span>
                </details>
              ))}
            </article>

            <article className="history-card" aria-label="Credit history">
              <h3>Credit <span className="history-count">{history.credit.transactions.length}</span></h3>
              <p>Available balance <strong>{usd(history.credit.balanceMinor)}</strong> {history.credit.currency}</p>
              {history.credit.transactions.length === 0 ? <Empty>No Credit movements yet.</Empty> : history.credit.transactions.map((transaction) => (
                <details data-testid="history-credit-transaction" key={transaction.id}>
                  <summary>{transaction.kind} · {usd(transaction.deltaMinor)}</summary>
                  <span>Credit {usd(transaction.creditMinor)} · debit {usd(transaction.debitMinor)}</span>
                  <span>{transaction.reason ?? "No operator reason"} · {when(transaction.createdAt)}</span>
                  <span className="mono">{transaction.sourceType} · {transaction.sourceId}</span>
                </details>
              ))}
            </article>

            <article className="history-card" aria-label="Refund history">
              <h3>Refunds <span className="history-count">{history.refunds.length}</span></h3>
              {history.refunds.length === 0 ? <Empty>No refund facts yet.</Empty> : history.refunds.map((refund) => (
                <details data-testid="history-refund" key={refund.id}>
                  <summary>{refund.destination.replaceAll("_", " ")} · {refund.status} · {usd(refund.amountMinor)}</summary>
                  <span>{refund.amountMode} · {when(refund.updatedAt)}</span>
                  {refund.invoiceId && <span>Invoice <a href={`#invoice-${refund.invoiceId}`}>{refund.invoiceId}</a></span>}
                  <span className="mono">{refund.id}</span>
                </details>
              ))}
            </article>

            <article className="history-card" aria-label="Service history">
              <h3>Services <span className="history-count">{history.services.length}</span></h3>
              {history.services.length === 0 ? <Empty>No services yet.</Empty> : history.services.map((service) => (
                <button
                  className="history-row"
                  data-testid="history-service"
                  id={`service-${service.id}`}
                  key={service.id}
                  onClick={() => void openService(service.id)}
                >
                  <strong>{service.productName} · {service.status}</strong>
                  <span>{service.billingCycle} · paid through {when(service.termEnd)}</span>
                  <span className="mono">{service.id}</span>
                </button>
              ))}
            </article>

            <article className="history-card" aria-label="Renewal history">
              <h3>Renewals <span className="history-count">{history.renewals.length}</span></h3>
              {history.renewals.length === 0 ? <Empty>No renewal invoices yet.</Empty> : history.renewals.map((renewal) => (
                <details data-testid="history-renewal" key={renewal.id}>
                  <summary>{renewal.status} · {usd(renewal.totalMinor)} · due {usd(renewal.dueMinor)}</summary>
                  <span>{when(renewal.periodStart)} → {when(renewal.periodEnd)}</span>
                  <span>Invoice <a href={`#invoice-${renewal.invoiceId}`}>{renewal.invoiceId}</a></span>
                  <span>Service <a href={`#service-${renewal.serviceId}`}>{renewal.serviceId}</a></span>
                </details>
              ))}
            </article>

            <article className="history-card" aria-label="Cancellation history">
              <h3>Cancellations <span className="history-count">{history.cancellations.length}</span></h3>
              {history.cancellations.length === 0 ? <Empty>No cancellation requests yet.</Empty> : history.cancellations.map((cancellation) => (
                <details data-testid="history-cancellation" key={cancellation.requestId}>
                  <summary>{cancellation.execution?.status ?? "scheduled"} · effective {when(cancellation.effectiveAt)}</summary>
                  <span>{cancellation.reason ?? "No customer reason supplied"}</span>
                  <span>Service <a href={`#service-${cancellation.serviceId}`}>{cancellation.serviceId}</a></span>
                  <span className="mono">{cancellation.requestId}</span>
                </details>
              ))}
            </article>

            <article className="history-card" aria-label="Ticket history">
              <h3>Tickets <span className="history-count">{history.tickets.length}</span></h3>
              {history.tickets.length === 0 ? <Empty>No support tickets yet.</Empty> : history.tickets.map((ticket) => (
                <details data-testid="history-ticket" key={ticket.id}>
                  <summary>{ticket.subject} · {ticket.status.replaceAll("_", " ")}</summary>
                  <span>{ticket.publicMessageCount} public message(s) · {when(ticket.updatedAt)}</span>
                  {ticket.serviceId && <span>Service <a href={`#service-${ticket.serviceId}`}>{ticket.productName ?? ticket.serviceId}</a></span>}
                  <span className="mono">{ticket.id}</span>
                </details>
              ))}
            </article>
          </div>
        </>
      )}

      {detailLoading && <p className="muted" data-testid="history-detail-loading">Loading saved detail…</p>}
      {(invoiceDetail || serviceDetail) && (
        <article className="history-detail" id="customer-history-detail" data-testid="customer-history-detail">
          <button
            className="history-detail-close"
            onClick={() => {
              detailGeneration.current += 1;
              setInvoiceDetail(null);
              setServiceDetail(null);
              replaceDetailQuery(null);
            }}
          >
            Close detail
          </button>
          {invoiceDetail && (
            <>
              <p className="eyebrow">Invoice detail</p>
              <h3>{invoiceDetail.invoice.status} · {usd(invoiceDetail.invoice.totalMinor)}</h3>
              <p className="mono">{invoiceDetail.invoice.id}</p>
              <div className="history-facts">
                <span>Payment allocations {usd(invoiceDetail.invoice.paymentAllocatedMinor)}</span>
                <span>Credit applied {usd(invoiceDetail.invoice.creditAppliedMinor)}</span>
                <span>Due {usd(invoiceDetail.invoice.dueMinor)}</span>
                <span>Due at {when(invoiceDetail.invoice.dueAt)}</span>
              </div>
              <div className="manual-list">
                {invoiceDetail.invoice.lines.map((line) => (
                  <div className="manual-item" key={line.id}>
                    <strong>{line.description}</strong>
                    <span>{line.kind} · {usd(line.amountMinor)}</span>
                  </div>
                ))}
              </div>
              <div className="workspace-actions">
                <a
                  className="route-action"
                  data-testid="invoice-pdf-download"
                  download={`invoice-${invoiceDetail.invoice.id}.pdf`}
                  href={invoiceDetail.pdfUrl}
                >
                  Download invoice PDF
                </a>
                {invoiceDetail.related.serviceIds.map((serviceId) => (
                  <button key={serviceId} onClick={() => void openService(serviceId)}>
                    Open related service
                  </button>
                ))}
              </div>
              <p>
                Related order <a href={`#order-${invoiceDetail.related.orderId}`}>{invoiceDetail.related.orderId ?? "—"}</a>
                {invoiceDetail.related.renewalIds.length > 0 ? ` · ${invoiceDetail.related.renewalIds.length} renewal fact(s)` : ""}
              </p>
            </>
          )}
          {serviceDetail && (
            <>
              <p className="eyebrow">Service trace</p>
              <h3>{serviceDetail.service.productName} · {serviceDetail.service.status}</h3>
              <p className="mono">{serviceDetail.service.id}</p>
              <div className="history-facts">
                <span>Activated {when(serviceDetail.service.activatedAt)}</span>
                <span>Term {when(serviceDetail.service.termStart)} → {when(serviceDetail.service.termEnd)}</span>
                <span>Order {serviceDetail.order.status} · {usd(serviceDetail.order.totalMinor)}</span>
                <span>Resource {serviceDetail.service.externalResourceId ?? "not assigned"}</span>
              </div>
              <h4>Trace this service to every related fact</h4>
              <div className="trace-grid" data-testid="service-trace">
                <a href={`#order-${serviceDetail.trace.orderId}`}>Order · {serviceDetail.trace.orderId}</a>
                {serviceDetail.invoices.map((invoice) => (
                  <button key={invoice.id} onClick={() => void openInvoice(invoice.id)}>
                    Invoice ({invoice.kind}) · {invoice.id}
                  </button>
                ))}
                {serviceDetail.trace.paymentIds.map((id) => <span className="mono" key={id}>Payment · {id}</span>)}
                {serviceDetail.trace.renewalIds.map((id) => <span className="mono" key={id}>Renewal · {id}</span>)}
                {serviceDetail.trace.cancellationRequestId && <span className="mono">Cancellation · {serviceDetail.trace.cancellationRequestId}</span>}
                {serviceDetail.tickets.map((ticket) => <span key={ticket.id}>Ticket · {ticket.subject} · <span className="mono">{ticket.id}</span></span>)}
              </div>
              <ServiceOperationsPanel
                endpoint={`/api/v1/services/${serviceDetail.service.id}/operations`}
                canManage={canManageServices}
                accessFingerprint={`${accessFingerprint}:${serviceDetail.service.id}:${canManageServices ? "manage" : "read"}`}
                locale={locale}
                onNotice={onNotice}
                onError={onError}
              />
            </>
          )}
        </article>
      )}
      {history && !loading && (
        <button className="history-refresh-bottom" onClick={() => {
          void loadHistory().then((refreshed) => {
            if (refreshed) {
              onNotice(locale === "zh-CN" ? "业务历史已刷新。" : "Business history refreshed.");
            }
          });
        }}>
          Refresh all saved facts
        </button>
      )}
    </section>
  );
}
