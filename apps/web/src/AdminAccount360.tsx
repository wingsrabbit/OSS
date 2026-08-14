// SPDX-License-Identifier: AGPL-3.0-or-later

import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { NotificationDeliveryHistory } from "./NotificationDeliveryHistory.js";
import { ServiceOperationsPanel } from "./ServiceOperationsPanel.js";
import type {
  CancellationHistory,
  CreditHistory,
  InvoiceSummary,
  OrderHistory,
  PaymentHistory,
  RefundHistory,
  RenewalHistory,
  ServiceSummary,
  TicketHistory,
} from "./CustomerBusinessHistory.js";

type AccountReference = { id: string; name: string };

type SearchItem = AccountReference & {
  owner: { userId: string; email: string; emailVerifiedAt: string | null };
  restrictedAt: string | null;
  activeMemberCount: number;
  createdAt: string;
};

type SearchResponse = {
  warning: string;
  items: SearchItem[];
  hasMore: boolean;
  nextCursor: string | null;
};

type AccountSummaryResponse = {
  warning: string;
  account: AccountReference & { createdAt: string; restrictedAt: string | null };
  owner: {
    userId: string;
    email: string;
    emailVerifiedAt: string | null;
    restrictedAt: string | null;
  };
  memberships: Array<{
    userId: string;
    email: string;
    role: string;
    permissions: unknown;
    emailVerifiedAt: string | null;
    userRestrictedAt: string | null;
    membershipRestrictedAt: string | null;
    createdAt: string;
    removedAt: string | null;
  }>;
  restrictions: Array<{
    id: string;
    kind: string;
    sourceType: string;
    sourceId: string;
    reason: string;
    createdAt: string;
    releasedAt: string | null;
    releaseReason: string | null;
    active: boolean;
  }>;
};

type OrdersResponse = { warning: string; account: AccountReference; items: OrderHistory[] };

type BillingResponse = {
  warning: string;
  account: AccountReference;
  invoices: InvoiceSummary[];
  payments: PaymentHistory[];
  credit: CreditHistory;
  fundReceipts: Array<{
    id: string;
    amountMinor: string;
    allocatedMinor: string;
    availableMinor: string;
    currency: string;
    disposition: string;
    occurredAt: string;
  }>;
  refunds: RefundHistory[];
  chargebacks: Array<{
    id: string;
    principalMinor: string;
    feeMinor: string;
    externalAmountMinor: string;
    creditRecoveredMinor: string;
    debtMinor: string;
    currency: string;
    occurredAt: string;
  }>;
  debt: { currency: string; balanceMinor: string };
};

type ServicesResponse = { warning: string; account: AccountReference; items: ServiceSummary[] };
type RenewalsResponse = { warning: string; account: AccountReference; items: RenewalHistory[] };
type CancellationsResponse = { warning: string; account: AccountReference; items: CancellationHistory[] };
type TicketsResponse = {
  warning: string;
  account: AccountReference;
  items: Array<TicketHistory & { internalMessageCount: number }>;
};
type ContactsResponse = {
  warning: string;
  account: AccountReference;
  items: Array<{
    id: string;
    displayName: string;
    email: string;
    locale: "en" | "zh-CN";
    notificationSubscriptions: string[];
    createdAt: string;
    updatedAt: string;
  }>;
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
};

type Loadable<T> = { loading: boolean; data: T | null; error: string | null };

const emptyLoadable = <T,>(): Loadable<T> => ({ loading: false, data: null, error: null });

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
  return (window.location.pathname.replace(/\/+$/, "") || "/") === "/admin";
}

function permissionSetHas(permissions: ReadonlySet<string>, permission: string): boolean {
  return permissions.has("*") || permissions.has(permission);
}

function Panel<T>({
  label,
  state,
  children,
}: {
  label: string;
  state: Loadable<T>;
  children: (data: T) => ReactNode;
}) {
  return (
    <section className="account360-panel" aria-label={label}>
      <h3>{label}</h3>
      {state.loading && <p className="muted">Loading permitted facts…</p>}
      {state.error && <p className="notice error">{state.error}</p>}
      {state.data && children(state.data)}
    </section>
  );
}

export type AdminAccountAction =
  | "manual_receipt"
  | "refund"
  | "ticket"
  | "manual_fulfillment";

export function AdminAccount360({
  active,
  accessFingerprint,
  permissions,
  locale,
  availableActions,
  onAction,
  onSelectedAccountChange,
  onRefreshAccess,
  onNotice,
  onError,
}: {
  active: boolean;
  accessFingerprint: string;
  permissions: ReadonlySet<string>;
  locale: "en" | "zh-CN";
  availableActions: ReadonlySet<AdminAccountAction>;
  onAction: (action: AdminAccountAction, account: AccountReference) => void;
  onSelectedAccountChange: (account: AccountReference | null) => void;
  onRefreshAccess: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [refreshingAccess, setRefreshingAccess] = useState(false);
  const [results, setResults] = useState<SearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<SearchItem | null>(null);
  const [summary, setSummary] = useState<Loadable<AccountSummaryResponse>>(emptyLoadable);
  const [orders, setOrders] = useState<Loadable<OrdersResponse>>(emptyLoadable);
  const [billing, setBilling] = useState<Loadable<BillingResponse>>(emptyLoadable);
  const [services, setServices] = useState<Loadable<ServicesResponse>>(emptyLoadable);
  const [renewals, setRenewals] = useState<Loadable<RenewalsResponse>>(emptyLoadable);
  const [cancellations, setCancellations] = useState<Loadable<CancellationsResponse>>(emptyLoadable);
  const [tickets, setTickets] = useState<Loadable<TicketsResponse>>(emptyLoadable);
  const [contacts, setContacts] = useState<Loadable<ContactsResponse>>(emptyLoadable);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const searchGeneration = useRef(0);
  const accountGeneration = useRef(0);

  const canSearch = permissionSetHas(permissions, "accounts.view");
  const canReadOrders = permissionSetHas(permissions, "orders.read");
  const canReadBilling = permissionSetHas(permissions, "billing.read");
  const canReadServices = permissionSetHas(permissions, "services.read");
  const canManageServiceOperations = permissionSetHas(permissions, "services.operations_manage");
  const canReadTickets = permissionSetHas(permissions, "support.tickets.manage");
  const canReadContacts = permissionSetHas(permissions, "accounts.contacts.read");
  const canReadNotificationHistory = permissionSetHas(permissions, "accounts.notification.read");

  function clearAccountWorkspace() {
    accountGeneration.current += 1;
    setSelected(null);
    onSelectedAccountChange(null);
    setSummary(emptyLoadable());
    setOrders(emptyLoadable());
    setBilling(emptyLoadable());
    setServices(emptyLoadable());
    setRenewals(emptyLoadable());
    setCancellations(emptyLoadable());
    setTickets(emptyLoadable());
    setContacts(emptyLoadable());
  }

  function clearSearchResults() {
    searchGeneration.current += 1;
    setResults([]);
    setHasMore(false);
    setNextCursor(null);
    setSearching(false);
    setLoadingMore(false);
    clearAccountWorkspace();
  }

  useEffect(() => {
    setQuery("");
    clearSearchResults();
    return () => {
      searchGeneration.current += 1;
      accountGeneration.current += 1;
    };
  }, [accessFingerprint, active]);

  if (!active || !canSearch) return null;

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = query.trim();
    if (!value || searching || !surfaceIsActive()) return;
    await runSearch(value, null, false);
  }

  async function runSearch(value: string, cursor: string | null, append: boolean) {
    const generation = ++searchGeneration.current;
    if (append) {
      setLoadingMore(true);
    } else {
      setSearching(true);
      setResults([]);
      setHasMore(false);
      setNextCursor(null);
      clearAccountWorkspace();
    }
    try {
      const response = await api<SearchResponse>(
        `/api/v1/admin/client-accounts?query=${encodeURIComponent(value)}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      if (generation !== searchGeneration.current || !surfaceIsActive()) return;
      setResults((current) => {
        if (!append) return response.items;
        const unique = new Map(current.map((item) => [item.id, item]));
        for (const item of response.items) unique.set(item.id, item);
        return [...unique.values()];
      });
      setHasMore(response.hasMore);
      setNextCursor(response.nextCursor);
      if (!append && response.items.length === 0) {
        onNotice("No Client Account matched that email, name or UUID.");
      }
    } catch (caught) {
      if (generation !== searchGeneration.current || !surfaceIsActive()) return;
      onError(caught instanceof Error ? caught.message : "Client Account search failed");
    } finally {
      if (generation === searchGeneration.current && surfaceIsActive()) {
        if (append) setLoadingMore(false);
        else setSearching(false);
      }
    }
  }

  async function loadMore() {
    const value = query.trim();
    if (!value || !hasMore || !nextCursor || loadingMore || !surfaceIsActive()) return;
    await runSearch(value, nextCursor, true);
  }

  function changeQuery(value: string) {
    if (value === query) return;
    setQuery(value);
    clearSearchResults();
  }

  async function refreshAccess() {
    if (refreshingAccess || !surfaceIsActive()) return;
    setRefreshingAccess(true);
    try {
      await onRefreshAccess();
    } finally {
      setRefreshingAccess(false);
    }
  }

  function openAccount(account: SearchItem) {
    const generation = ++accountGeneration.current;
    setWorkspaceRevision((current) => current + 1);
    setSelected(account);
    onSelectedAccountChange(account);
    setSummary({ loading: true, data: null, error: null });
    setOrders(canReadOrders ? { loading: true, data: null, error: null } : emptyLoadable());
    setBilling(canReadBilling ? { loading: true, data: null, error: null } : emptyLoadable());
    setServices(canReadServices ? { loading: true, data: null, error: null } : emptyLoadable());
    setRenewals(canReadBilling ? { loading: true, data: null, error: null } : emptyLoadable());
    setCancellations(canReadServices ? { loading: true, data: null, error: null } : emptyLoadable());
    setTickets(canReadTickets ? { loading: true, data: null, error: null } : emptyLoadable());
    setContacts(canReadContacts ? { loading: true, data: null, error: null } : emptyLoadable());

    const load = <T,>(path: string, setter: (value: Loadable<T>) => void) => {
      void api<T>(path)
        .then((data) => {
          if (generation === accountGeneration.current && surfaceIsActive()) {
            setter({ loading: false, data, error: null });
          }
        })
        .catch((caught: unknown) => {
          if (generation === accountGeneration.current && surfaceIsActive()) {
            setter({
              loading: false,
              data: null,
              error: caught instanceof Error ? caught.message : "Panel could not be loaded",
            });
          }
        });
    };

    const base = `/api/v1/admin/client-accounts/${account.id}`;
    load(`${base}/summary`, setSummary);
    if (canReadOrders) load(`${base}/orders`, setOrders);
    if (canReadBilling) {
      load(`${base}/billing`, setBilling);
      load(`${base}/renewals`, setRenewals);
    }
    if (canReadServices) {
      load(`${base}/services`, setServices);
      load(`${base}/cancellations`, setCancellations);
    }
    if (canReadTickets) load(`${base}/tickets`, setTickets);
    if (canReadContacts) load(`${base}/contacts`, setContacts);
  }

  async function loadMoreContacts() {
    const current = contacts.data;
    if (!selected || !current?.hasMore || !current.nextCursor || contacts.loading || !surfaceIsActive()) return;
    const account = selected;
    const generation = accountGeneration.current;
    setContacts({ ...contacts, loading: true, error: null });
    try {
      const page = await api<ContactsResponse>(
        `/api/v1/admin/client-accounts/${account.id}/contacts?cursor=${encodeURIComponent(current.nextCursor)}&limit=${current.limit}`,
      );
      if (generation !== accountGeneration.current || selected.id !== account.id || !surfaceIsActive()) return;
      const unique = new Map(current.items.map((contact) => [contact.id, contact]));
      for (const contact of page.items) unique.set(contact.id, contact);
      setContacts({ loading: false, error: null, data: { ...page, items: [...unique.values()] } });
    } catch (caught) {
      if (generation !== accountGeneration.current || !surfaceIsActive()) return;
      setContacts({
        loading: false,
        data: current,
        error: caught instanceof Error ? caught.message : locale === "zh-CN" ? "无法加载联系人" : "Contacts could not be loaded",
      });
    }
  }

  return (
    <section className="admin-panel account360" aria-label="Client Account 360" data-testid="client-account-360">
      <div className="history-heading">
        <div>
          <p className="eyebrow">Staff · permission-scoped account operations</p>
          <h2>Client Account 360</h2>
          <p>
            Search by customer email, Client Account name or exact UUID. Each panel is requested only
            when the current Staff session has its matching read permission.
          </p>
        </div>
        <button disabled={refreshingAccess} onClick={() => void refreshAccess()}>
          {refreshingAccess ? "Refreshing Staff access…" : "Refresh Staff access"}
        </button>
      </div>
      <form className="account360-search" onSubmit={search}>
        <label>
          Email, name or Client Account UUID
          <input
            aria-label="Search Client Accounts"
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            maxLength={200}
            required
          />
        </label>
        <button className="primary" disabled={searching || query.trim().length === 0} type="submit">
          {searching ? "Searching…" : "Search accounts"}
        </button>
      </form>

      {results.length > 0 && (
        <div className="account360-results" data-testid="account360-search-results">
          {results.map((account) => (
            <button key={account.id} onClick={() => openAccount(account)}>
              <strong>{account.name}</strong>
              <span>Founder {account.owner.email} · {account.owner.emailVerifiedAt ? "verified" : "pending verification"}</span>
              <span>{account.activeMemberCount} active member(s){account.restrictedAt ? " · restricted" : ""}</span>
              <span className="mono">{account.id}</span>
            </button>
          ))}
          {hasMore && (
            <button disabled={loadingMore || nextCursor === null} onClick={() => void loadMore()}>
              {loadingMore ? "Loading more…" : "Load more accounts"}
            </button>
          )}
        </div>
      )}

      {selected && (
        <div className="account360-workspace" data-testid="account360-workspace">
          <div className="history-heading">
            <div>
              <p className="eyebrow">Selected Client Account</p>
              <h2>{selected.name}</h2>
              <p className="mono">{selected.id}</p>
            </div>
            <button onClick={() => openAccount(selected)}>Refresh permitted panels</button>
          </div>

          <Panel label="Account identity, verification and restrictions" state={summary}>
            {(data) => (
              <>
                <div className="history-facts">
                  <span>Founder {data.owner.email}</span>
                  <span>Email {data.owner.emailVerifiedAt ? `verified ${when(data.owner.emailVerifiedAt)}` : "pending"}</span>
                  <span>Account {data.account.restrictedAt ? `restricted ${when(data.account.restrictedAt)}` : "unrestricted"}</span>
                  <span>Created {when(data.account.createdAt)}</span>
                </div>
                <div className="manual-list" data-testid="account360-memberships">
                  {data.memberships.map((membership) => (
                    <div className="manual-item" key={membership.userId}>
                      <strong>{membership.email} · {membership.role}</strong>
                      <span>
                        {membership.removedAt
                          ? `removed ${when(membership.removedAt)}`
                          : membership.membershipRestrictedAt
                            ? locale === "zh-CN"
                              ? `成员关系受限 ${when(membership.membershipRestrictedAt)}`
                              : `membership restricted ${when(membership.membershipRestrictedAt)}`
                            : locale === "zh-CN" ? "有效成员关系" : "active membership"}
                      </span>
                      <span>{locale === "zh-CN" ? "邮箱" : "Email"} {membership.emailVerifiedAt ? (locale === "zh-CN" ? "已验证" : "verified") : (locale === "zh-CN" ? "待验证" : "pending")}{membership.userRestrictedAt ? locale === "zh-CN" ? " · 用户受限" : " · User restricted" : ""}</span>
                    </div>
                  ))}
                </div>
                {data.restrictions.length === 0 ? (
                  <p className="muted">No account restriction facts.</p>
                ) : (
                  <div className="manual-list" data-testid="account360-restrictions">
                    {data.restrictions.map((restriction) => (
                      <div className="manual-item" key={restriction.id}>
                        <strong>{restriction.kind} · {restriction.active ? "active" : "released"}</strong>
                        <span>{restriction.reason}</span>
                        <span>{restriction.sourceType} · {when(restriction.createdAt)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {availableActions.size > 0 && (
                  <div className="account360-actions" aria-label="Client Account actions">
                    {availableActions.has("manual_receipt") && <button onClick={() => onAction("manual_receipt", data.account)}>Record manual receipt</button>}
                    {availableActions.has("refund") && <button onClick={() => onAction("refund", data.account)}>Open refund operations</button>}
                    {availableActions.has("ticket") && <button onClick={() => onAction("ticket", data.account)}>Open ticket operations</button>}
                    {availableActions.has("manual_fulfillment") && <button onClick={() => onAction("manual_fulfillment", data.account)}>Open manual fulfillment</button>}
                  </div>
                )}
              </>
            )}
          </Panel>

          {canReadContacts && (
            <Panel label={locale === "zh-CN" ? "账户联系人" : "Account Contacts"} state={contacts}>
              {(data) => (
                <>
                  {data.items.length === 0 ? <p className="muted">{locale === "zh-CN" ? "没有有效联系人。" : "No active Contacts."}</p> : (
                    <div className="manual-list" data-testid="account360-contacts">
                      {data.items.map((contact) => (
                        <article className="manual-item" key={contact.id}>
                          <strong>{contact.displayName} · {contact.email}</strong>
                          <span>{locale === "zh-CN" ? "仅为联系人——没有用户身份或客户账户成员权限" : "Contact only — no User identity or Client Account membership"}</span>
                          <span>{contact.notificationSubscriptions.join(", ") || (locale === "zh-CN" ? "未订阅通知" : "No notification subscriptions")} · {contact.locale}</span>
                        </article>
                      ))}
                    </div>
                  )}
                  {data.hasMore && (
                    <button disabled={contacts.loading || !data.nextCursor} onClick={() => void loadMoreContacts()}>
                      {contacts.loading ? (locale === "zh-CN" ? "正在加载更多联系人…" : "Loading more Contacts…") : (locale === "zh-CN" ? "加载更多联系人" : "Load more Contacts")}
                    </button>
                  )}
                </>
              )}
            </Panel>
          )}

          {canReadNotificationHistory && (
            <NotificationDeliveryHistory
              active={active && selected !== null}
              endpoint={`/api/v1/admin/client-accounts/${selected.id}/notification-deliveries`}
              accountId={selected.id}
              scopeKey={`${accessFingerprint}:${selected.id}`}
              refreshKey={workspaceRevision}
              locale={locale}
              variant="admin"
              onError={onError}
            />
          )}

          {canReadOrders && (
            <Panel label="Account orders" state={orders}>
              {(data) => data.items.length === 0 ? <p className="muted">No orders.</p> : (
                <div className="manual-list" data-testid="account360-orders">
                  {data.items.map((order) => (
                    <details className="manual-item" key={order.id}>
                      <summary>{order.items.map((item) => item.productName).join(", ")} · {order.status}</summary>
                      <span>{usd(order.totalMinor)} {order.currency} · {when(order.submittedAt)}</span>
                      <span className="mono">{order.id}</span>
                    </details>
                  ))}
                </div>
              )}
            </Panel>
          )}

          {canReadBilling && (
            <>
              <Panel label="Account billing and funds" state={billing}>
                {(data) => (
                  <div className="account360-billing" data-testid="account360-billing">
                    <div className="history-facts">
                      <span>Credit <strong>{usd(data.credit.balanceMinor)}</strong></span>
                      <span>Chargeback debt <strong>{usd(data.debt.balanceMinor)}</strong></span>
                      <span>{data.invoices.length} invoice(s)</span>
                      <span>{data.payments.length} payment attempt(s)</span>
                    </div>
                    <h4>Invoices</h4>
                    {data.invoices.length === 0 ? <p className="muted">No invoices.</p> : data.invoices.map((invoice) => (
                      <details key={invoice.id}>
                        <summary>{invoice.status} · {usd(invoice.totalMinor)} · due {usd(invoice.dueMinor)}</summary>
                        <span>Payment {usd(invoice.paymentAllocatedMinor)} · Credit {usd(invoice.creditAppliedMinor)}</span>
                        <span className="mono">{invoice.id}</span>
                      </details>
                    ))}
                    <h4>Payments</h4>
                    {data.payments.length === 0 ? <p className="muted">No payments.</p> : data.payments.map((payment) => (
                      <details key={payment.id}>
                        <summary>{payment.paymentMethodCode ?? "unspecified method"} · {payment.status} · {usd(payment.amountMinor)}</summary>
                        <span>Principal {usd(payment.principalMinor)} · fee {usd(payment.feeMinor)}</span>
                        <span className="mono">{payment.id}</span>
                      </details>
                    ))}
                    <h4>Credit movements</h4>
                    {data.credit.transactions.length === 0 ? <p className="muted">No Credit movements.</p> : data.credit.transactions.map((transaction) => (
                      <details key={transaction.id}>
                        <summary>{transaction.kind} · {usd(transaction.deltaMinor)}</summary>
                        <span>{transaction.reason ?? "No operator reason"} · {when(transaction.createdAt)}</span>
                      </details>
                    ))}
                    <h4>Fund receipts</h4>
                    {data.fundReceipts.length === 0 ? <p className="muted">No fund receipts.</p> : data.fundReceipts.map((receipt) => (
                      <details key={receipt.id}>
                        <summary>{receipt.disposition} · {usd(receipt.amountMinor)} · available {usd(receipt.availableMinor)}</summary>
                        <span>{when(receipt.occurredAt)}</span>
                        <span className="mono">{receipt.id}</span>
                      </details>
                    ))}
                    <h4>Refunds and Chargebacks</h4>
                    {data.refunds.map((refund) => <p key={refund.id}>{refund.status} refund · {usd(refund.amountMinor)} · <span className="mono">{refund.id}</span></p>)}
                    {data.chargebacks.map((chargeback) => <p key={chargeback.id}>Chargeback {usd(chargeback.externalAmountMinor)} · debt {usd(chargeback.debtMinor)} · <span className="mono">{chargeback.id}</span></p>)}
                    {data.refunds.length === 0 && data.chargebacks.length === 0 && <p className="muted">No Refund or Chargeback facts.</p>}
                  </div>
                )}
              </Panel>
              <Panel label="Account renewals" state={renewals}>
                {(data) => data.items.length === 0 ? <p className="muted">No renewals.</p> : (
                  <div className="manual-list" data-testid="account360-renewals">
                    {data.items.map((renewal) => (
                      <details className="manual-item" key={renewal.id}>
                        <summary>{renewal.status} · {usd(renewal.totalMinor)} · due {usd(renewal.dueMinor)}</summary>
                        <span>{when(renewal.periodStart)} → {when(renewal.periodEnd)}</span>
                        <span className="mono">{renewal.id}</span>
                      </details>
                    ))}
                  </div>
                )}
              </Panel>
            </>
          )}

          {canReadServices && (
            <>
              <Panel label="Account services" state={services}>
                {(data) => data.items.length === 0 ? <p className="muted">No services.</p> : (
                  <div className="manual-list" data-testid="account360-services">
                    {data.items.map((service) => (
                      <details className="manual-item" key={service.id}>
                        <summary>{service.productName} · {service.status}</summary>
                        <span>{service.billingCycle} · {when(service.termStart)} → {when(service.termEnd)}</span>
                        <span>Order {service.orderId} · {service.invoiceIds.length} invoice(s)</span>
                        <span className="mono">{service.id}</span>
                        <ServiceOperationsPanel
                          endpoint={`/api/v1/admin/client-accounts/${data.account.id}/services/${service.id}/operations`}
                          canManage={canManageServiceOperations}
                          locale={locale}
                          staff
                          onNotice={onNotice}
                          onError={onError}
                        />
                      </details>
                    ))}
                  </div>
                )}
              </Panel>
              <Panel label="Account cancellations" state={cancellations}>
                {(data) => data.items.length === 0 ? <p className="muted">No cancellations.</p> : (
                  <div className="manual-list" data-testid="account360-cancellations">
                    {data.items.map((cancellation) => (
                      <details className="manual-item" key={cancellation.requestId}>
                        <summary>{cancellation.execution?.status ?? "scheduled"} · effective {when(cancellation.effectiveAt)}</summary>
                        <span>{cancellation.reason ?? "No customer reason supplied"}</span>
                        <span className="mono">{cancellation.requestId}</span>
                      </details>
                    ))}
                  </div>
                )}
              </Panel>
            </>
          )}

          {canReadTickets && (
            <Panel label="Account tickets" state={tickets}>
              {(data) => data.items.length === 0 ? <p className="muted">No tickets.</p> : (
                <div className="manual-list" data-testid="account360-tickets">
                  {data.items.map((ticket) => (
                    <details className="manual-item" key={ticket.id}>
                      <summary>{ticket.subject} · {ticket.status.replaceAll("_", " ")}</summary>
                      <span>{ticket.publicMessageCount} public · {ticket.internalMessageCount} internal</span>
                      <span>{when(ticket.updatedAt)}</span>
                      <span className="mono">{ticket.id}</span>
                    </details>
                  ))}
                </div>
              )}
            </Panel>
          )}
        </div>
      )}
    </section>
  );
}
