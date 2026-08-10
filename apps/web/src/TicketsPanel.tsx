// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { api } from "./api.js";

type Locale = "en" | "zh-CN";

type TicketSummary = {
  id: string;
  subject: string;
  status: "awaiting_staff" | "awaiting_customer" | "closed";
  service: { id: string; productName: string } | null;
  publicMessageCount: number;
  createdAt: string;
  updatedAt: string;
};

type CustomerMessage = {
  id: string;
  authorType: "customer" | "staff";
  body: string;
  createdAt: string;
};

type StaffMessage = CustomerMessage & {
  visibility: "public" | "internal";
  authorEmail: string;
};

type CustomerTicketDetail = {
  ticket: TicketSummary;
  messages: CustomerMessage[];
};

type StaffTicketSummary = TicketSummary & {
  clientAccount: { id: string; name: string };
  internalMessageCount: number;
};

type StaffTicketDetail = {
  ticket: StaffTicketSummary;
  messages: StaffMessage[];
};

type ScopedStaffTicketsResponse = {
  account: { id: string; name: string };
  items: Array<{
    id: string;
    subject: string;
    status: TicketSummary["status"];
    serviceId: string | null;
    productName: string | null;
    publicMessageCount: number;
    internalMessageCount: number;
    createdAt: string;
    updatedAt: string;
  }>;
  limit?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
};
type StaffRequestScope = {
  generation: number;
  token: string;
  accountId: string | null;
};
type CustomerRequestScope = {
  generation: number;
  token: string;
};

type ServiceOption = { id: string; productName: string; status: string };

type Viewer = {
  id: string;
  eligible: boolean;
  clientAccountId?: string | null;
  accountContextVersion?: string;
  staff: { roles: string[]; permissions: unknown } | null;
};

function surfaceIsActive(surface: "customer" | "staff"): boolean {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  return path === (surface === "customer" ? "/customer" : "/admin");
}

export function TicketsPanel({
  mode,
  canUseCustomerSupport = false,
  canWriteCustomerSupport = false,
  canManageTickets = false,
  staffAccessFingerprint = "",
  staffAccountContext = null,
  requireStaffAccountContext = false,
  me,
  locale,
  onNotice,
  onError,
}: {
  mode: "customer" | "staff";
  canUseCustomerSupport?: boolean;
  canWriteCustomerSupport?: boolean;
  canManageTickets?: boolean;
  staffAccessFingerprint?: string;
  staffAccountContext?: { id: string; name: string } | null;
  requireStaffAccountContext?: boolean;
  me: Viewer | null;
  locale: Locale;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [selected, setSelected] = useState<CustomerTicketDetail | null>(null);
  const [staffTickets, setStaffTickets] = useState<StaffTicketSummary[]>([]);
  const [staffSelected, setStaffSelected] = useState<StaffTicketDetail | null>(null);
  const [subject, setSubject] = useState("");
  const [openingMessage, setOpeningMessage] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [customerReply, setCustomerReply] = useState("");
  const [staffReply, setStaffReply] = useState("");
  const [pending, setPending] = useState(false);
  const customerScopeToken = [
    mode,
    me?.id ?? "guest",
    me?.clientAccountId ?? "no-account",
    me?.accountContextVersion ?? "no-version",
    canUseCustomerSupport ? "allowed" : "denied",
    canWriteCustomerSupport ? "write" : "read-only",
  ].join("\u0000");
  const customerRequestGeneration = useRef(0);
  const activeCustomerScopeToken = useRef(customerScopeToken);
  const staffScopeToken = [
    mode,
    staffAccessFingerprint,
    canManageTickets ? "allowed" : "denied",
    requireStaffAccountContext ? "context-required" : "context-optional",
    staffAccountContext?.id ?? "unscoped",
  ].join("\u0000");
  const staffRequestGeneration = useRef(0);
  const staffRefreshSequence = useRef(0);
  const activeStaffScopeToken = useRef(staffScopeToken);
  const activeStaffAccountId = useRef<string | null>(staffAccountContext?.id ?? null);

  useLayoutEffect(() => {
    if (activeCustomerScopeToken.current === customerScopeToken) return;
    activeCustomerScopeToken.current = customerScopeToken;
    customerRequestGeneration.current += 1;
    setTickets([]);
    setServices([]);
    setSelected(null);
    setSubject("");
    setOpeningMessage("");
    setServiceId("");
    setCustomerReply("");
    setPending(false);
  }, [customerScopeToken]);

  const captureCustomerScope = useCallback((): CustomerRequestScope => ({
    generation: customerRequestGeneration.current,
    token: activeCustomerScopeToken.current,
  }), []);
  const customerScopeIsCurrent = useCallback((scope: CustomerRequestScope) =>
    scope.generation === customerRequestGeneration.current &&
    scope.token === activeCustomerScopeToken.current &&
    surfaceIsActive("customer"), []);

  useLayoutEffect(() => {
    const accountId = staffAccountContext?.id ?? null;
    if (activeStaffScopeToken.current === staffScopeToken) return;
    activeStaffScopeToken.current = staffScopeToken;
    activeStaffAccountId.current = accountId;
    staffRequestGeneration.current += 1;
    staffRefreshSequence.current += 1;
    setStaffTickets([]);
    setStaffSelected(null);
    setStaffReply("");
    setPending(false);
  }, [staffAccountContext?.id, staffScopeToken]);

  const captureStaffScope = useCallback((): StaffRequestScope => ({
    generation: staffRequestGeneration.current,
    token: activeStaffScopeToken.current,
    accountId: activeStaffAccountId.current,
  }), []);
  const staffScopeIsCurrent = useCallback((scope: StaffRequestScope) =>
    scope.generation === staffRequestGeneration.current &&
    scope.token === activeStaffScopeToken.current &&
    scope.accountId === activeStaffAccountId.current &&
    surfaceIsActive("staff"), []);

  const refreshCustomer = useCallback(async (expectedScope?: CustomerRequestScope) => {
    const scope = expectedScope ?? captureCustomerScope();
    if (mode !== "customer" || !surfaceIsActive("customer") || !canUseCustomerSupport) {
      if (customerScopeIsCurrent(scope)) {
        setTickets([]);
        setServices([]);
        setSelected(null);
      }
      return;
    }
    if (!customerScopeIsCurrent(scope)) return;
    const [ticketResult, serviceResult] = await Promise.all([
      api<{ items: TicketSummary[] }>("/api/v1/tickets"),
      api<{ items: ServiceOption[] }>("/api/v1/tickets/service-options"),
    ]);
    if (!customerScopeIsCurrent(scope)) return;
    setTickets(ticketResult.items);
    setServices(serviceResult.items);
  }, [canUseCustomerSupport, captureCustomerScope, customerScopeIsCurrent, me?.id, mode]);

  const refreshStaff = useCallback(async (expectedScope?: StaffRequestScope) => {
    const accountId = staffAccountContext?.id ?? null;
    const scope = expectedScope ?? captureStaffScope();
    if (
      mode !== "staff" ||
      !surfaceIsActive("staff") ||
      !canManageTickets ||
      (requireStaffAccountContext && !accountId) ||
      !staffScopeIsCurrent(scope) ||
      scope.accountId !== accountId
    ) {
      if (staffScopeIsCurrent(scope)) {
        setStaffTickets([]);
        setStaffSelected(null);
      }
      return false;
    }
    const refreshSequence = ++staffRefreshSequence.current;
    try {
      const items = accountId
        ? await api<ScopedStaffTicketsResponse>(
            `/api/v1/admin/client-accounts/${accountId}/tickets`,
          ).then((result) =>
            result.items.map((ticket) => ({
              id: ticket.id,
              subject: ticket.subject,
              status: ticket.status,
              service: ticket.serviceId
                ? { id: ticket.serviceId, productName: ticket.productName ?? "Related service" }
                : null,
              publicMessageCount: ticket.publicMessageCount,
              internalMessageCount: ticket.internalMessageCount,
              createdAt: ticket.createdAt,
              updatedAt: ticket.updatedAt,
              clientAccount: result.account,
            })),
          )
        : await api<{ items: StaffTicketSummary[] }>(
            "/api/v1/admin/tickets",
          ).then((result) => result.items);
      if (
        !staffScopeIsCurrent(scope) ||
        refreshSequence !== staffRefreshSequence.current
      ) return false;
      setStaffTickets(items);
      return true;
    } catch (caught) {
      if (
        !staffScopeIsCurrent(scope) ||
        refreshSequence !== staffRefreshSequence.current
      ) return false;
      onError(caught instanceof Error ? caught.message : "Tickets could not be loaded");
      return false;
    }
  }, [
    canManageTickets,
    captureStaffScope,
    mode,
    onError,
    requireStaffAccountContext,
    staffAccessFingerprint,
    staffAccountContext?.id,
    staffScopeIsCurrent,
  ]);

  useEffect(() => {
    if (mode === "customer") {
      const scope = captureCustomerScope();
      void refreshCustomer(scope).catch((caught: unknown) => {
        if (customerScopeIsCurrent(scope)) {
          onError(caught instanceof Error ? caught.message : "Tickets could not be loaded");
        }
      });
    } else {
      void refreshStaff();
    }
  }, [captureCustomerScope, customerScopeIsCurrent, mode, onError, refreshCustomer, refreshStaff]);

  useEffect(() => () => {
    customerRequestGeneration.current += 1;
    staffRequestGeneration.current += 1;
    staffRefreshSequence.current += 1;
  }, []);

  if (mode === "customer" && !canUseCustomerSupport) return null;
  if (mode === "staff" && (!me?.staff || !canManageTickets)) return null;

  async function openCustomerTicket(ticketId: string) {
    if (mode !== "customer" || !surfaceIsActive("customer") || !canUseCustomerSupport) return;
    const scope = captureCustomerScope();
    if (!customerScopeIsCurrent(scope)) return;
    try {
      const detail = await api<CustomerTicketDetail>(`/api/v1/tickets/${ticketId}`);
      if (!customerScopeIsCurrent(scope)) return;
      setSelected(detail);
    } catch (caught) {
      if (customerScopeIsCurrent(scope)) {
        onError(caught instanceof Error ? caught.message : "Ticket could not be loaded");
      }
    }
  }

  async function createTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode !== "customer" || !surfaceIsActive("customer") || !canWriteCustomerSupport || pending) return;
    const scope = captureCustomerScope();
    if (!customerScopeIsCurrent(scope)) return;
    setPending(true);
    try {
      const created = await api<CustomerTicketDetail>("/api/v1/tickets", {
        method: "POST",
        body: JSON.stringify({
          subject: subject.trim(),
          message: openingMessage.trim(),
          serviceId: serviceId || null,
        }),
      });
      if (!customerScopeIsCurrent(scope)) return;
      setSubject("");
      setOpeningMessage("");
      setServiceId("");
      setSelected(created);
      await refreshCustomer(scope);
      if (!customerScopeIsCurrent(scope)) return;
      onNotice(locale === "zh-CN" ? "工单已创建。" : "Support ticket created.");
    } catch (caught) {
      if (customerScopeIsCurrent(scope)) {
        onError(caught instanceof Error ? caught.message : "Ticket could not be created");
      }
    } finally {
      if (customerScopeIsCurrent(scope)) setPending(false);
    }
  }

  async function replyAsCustomer() {
    if (
      mode !== "customer" ||
      !surfaceIsActive("customer") ||
      !canWriteCustomerSupport ||
      !selected ||
      customerReply.trim().length === 0 ||
      pending
    ) return;
    const scope = captureCustomerScope();
    if (!customerScopeIsCurrent(scope)) return;
    setPending(true);
    try {
      const updated = await api<CustomerTicketDetail>(
        `/api/v1/tickets/${selected.ticket.id}/replies`,
        { method: "POST", body: JSON.stringify({ message: customerReply.trim() }) },
      );
      if (!customerScopeIsCurrent(scope)) return;
      setCustomerReply("");
      setSelected(updated);
      await refreshCustomer(scope);
      if (!customerScopeIsCurrent(scope)) return;
      onNotice(locale === "zh-CN" ? "回复已发送给客服。" : "Reply sent to staff.");
    } catch (caught) {
      if (customerScopeIsCurrent(scope)) {
        onError(caught instanceof Error ? caught.message : "Reply could not be sent");
      }
    } finally {
      if (customerScopeIsCurrent(scope)) setPending(false);
    }
  }

  async function openStaffTicket(ticketId: string) {
    const accountId = staffAccountContext?.id ?? null;
    if (
      mode !== "staff" ||
      !surfaceIsActive("staff") ||
      !canManageTickets ||
      (requireStaffAccountContext && !accountId)
    ) return;
    const scope = captureStaffScope();
    if (!staffScopeIsCurrent(scope) || scope.accountId !== accountId) return;
    try {
      const detail = await api<StaffTicketDetail>(`/api/v1/admin/tickets/${ticketId}`);
      if (
        !staffScopeIsCurrent(scope) ||
        (accountId !== null && detail.ticket.clientAccount.id !== accountId)
      ) return;
      setStaffSelected(detail);
    } catch (caught) {
      if (staffScopeIsCurrent(scope)) {
        onError(caught instanceof Error ? caught.message : "Staff ticket could not be loaded");
      }
    }
  }

  async function sendStaffMessage(kind: "public_reply" | "internal_note") {
    const accountId = staffAccountContext?.id ?? null;
    if (
      mode !== "staff" ||
      !surfaceIsActive("staff") ||
      !canManageTickets ||
      !staffSelected ||
      (requireStaffAccountContext && !accountId) ||
      (accountId !== null && staffSelected.ticket.clientAccount.id !== accountId) ||
      staffReply.trim().length === 0 ||
      pending
    ) return;
    const scope = captureStaffScope();
    if (!staffScopeIsCurrent(scope) || scope.accountId !== accountId) return;
    setPending(true);
    try {
      const updated = await api<StaffTicketDetail>(
        `/api/v1/admin/tickets/${staffSelected.ticket.id}/messages`,
        {
          method: "POST",
          body: JSON.stringify({ kind, message: staffReply.trim() }),
        },
      );
      if (
        !staffScopeIsCurrent(scope) ||
        (accountId !== null && updated.ticket.clientAccount.id !== accountId)
      ) return;
      setStaffReply("");
      setStaffSelected(updated);
      if (!await refreshStaff(scope) || !staffScopeIsCurrent(scope)) return;
      onNotice(
        kind === "internal_note"
          ? locale === "zh-CN"
            ? "内部备注已保存；客户不可见。"
            : "Internal note saved; it is not customer-visible."
          : locale === "zh-CN"
            ? "公开回复已发送。"
            : "Public reply sent.",
      );
    } catch (caught) {
      if (staffScopeIsCurrent(scope)) {
        onError(caught instanceof Error ? caught.message : "Staff message could not be saved");
      }
    } finally {
      if (staffScopeIsCurrent(scope)) setPending(false);
    }
  }

  return (
    <>
      {mode === "customer" && (
      <section className="order-panel ticket-center" aria-label="Customer support tickets">
        <div>
          <p className="eyebrow">Customer support · Mock-only</p>
          <h2>{locale === "zh-CN" ? "我的工单" : "My support tickets"}</h2>
          <p>
            {locale === "zh-CN"
              ? canWriteCustomerSupport
                ? "创建工单、可选关联自己的服务，并在同一会话中继续回复。"
                : "工单仍可查看；当前成员权限不允许创建或回复。"
              : canWriteCustomerSupport
                ? "Create a ticket, optionally link one of your services, and continue the conversation."
                : "Tickets remain readable; this membership cannot create or reply."}
          </p>
        </div>
        {canWriteCustomerSupport && <form className="ticket-compose" onSubmit={createTicket}>
          <label>
            {locale === "zh-CN" ? "主题" : "Ticket subject"}
            <input
              aria-label="Ticket subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              minLength={3}
              maxLength={160}
              required
            />
          </label>
          <label>
            {locale === "zh-CN" ? "关联服务（可选）" : "Related service (optional)"}
            <select
              aria-label="Related service"
              value={serviceId}
              onChange={(event) => setServiceId(event.target.value)}
            >
              <option value="">No related service</option>
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.productName} · {service.status}
                </option>
              ))}
            </select>
          </label>
          <label>
            {locale === "zh-CN" ? "内容" : "Opening message"}
            <textarea
              aria-label="Opening message"
              value={openingMessage}
              onChange={(event) => setOpeningMessage(event.target.value)}
              maxLength={10_000}
              required
            />
          </label>
          <button className="primary" type="submit" disabled={pending}>
            {locale === "zh-CN" ? "创建工单" : "Create ticket"}
          </button>
        </form>}

        <div className="ticket-layout">
          <div className="ticket-list" data-testid="customer-ticket-list">
            {tickets.length === 0 && <p className="muted">No tickets yet.</p>}
            {tickets.map((ticket) => (
              <button key={ticket.id} onClick={() => void openCustomerTicket(ticket.id)}>
                <strong>{ticket.subject}</strong>
                <span>{ticket.status.replaceAll("_", " ")}</span>
                {ticket.service && <span>{ticket.service.productName}</span>}
              </button>
            ))}
          </div>
          {selected && (
            <article className="ticket-thread" data-testid="customer-ticket-thread">
              <h3>{selected.ticket.subject}</h3>
              <span className="pill">{selected.ticket.status.replaceAll("_", " ")}</span>
              <div className="ticket-messages">
                {selected.messages.map((message) => (
                  <div className={`ticket-message ${message.authorType}`} key={message.id}>
                    <strong>{message.authorType === "staff" ? "Support staff" : "Customer"}</strong>
                    <p>{message.body}</p>
                    <span>{new Date(message.createdAt).toLocaleString()}</span>
                  </div>
                ))}
              </div>
              {canWriteCustomerSupport && <label>
                {locale === "zh-CN" ? "回复" : "Reply to ticket"}
                <textarea
                  aria-label="Customer ticket reply"
                  value={customerReply}
                  onChange={(event) => setCustomerReply(event.target.value)}
                  maxLength={10_000}
                />
              </label>}
              {canWriteCustomerSupport && <button
                className="primary"
                disabled={pending || customerReply.trim().length === 0}
                onClick={() => void replyAsCustomer()}
              >
                {locale === "zh-CN" ? "发送回复" : "Send reply"}
              </button>}
            </article>
          )}
        </div>
      </section>
      )}

      {mode === "staff" && me?.staff && canManageTickets && (
        <section className="admin-panel ticket-center" aria-label="Staff support tickets">
          <div>
            <p className="eyebrow">Staff support workspace</p>
            <h2>Ticket queue</h2>
            <p>Public replies are customer-visible. Internal notes stay in the staff view only.</p>
          </div>
          {staffAccountContext && (
            <p className="notice" data-testid="staff-ticket-account-context">
              Fixed Client Account: {staffAccountContext.name} · {staffAccountContext.id}
            </p>
          )}
          {requireStaffAccountContext && !staffAccountContext ? (
            <p className="muted" data-testid="staff-ticket-account-required">
              Select a Client Account in Account 360, then choose Open ticket operations.
            </p>
          ) : (
            <>
              <button onClick={() => void refreshStaff()}>Refresh ticket queue</button>
              <div className="ticket-layout">
            <div className="ticket-list" data-testid="staff-ticket-list">
              {staffTickets.map((ticket) => (
                <button key={ticket.id} onClick={() => void openStaffTicket(ticket.id)}>
                  <strong>{ticket.subject}</strong>
                  <span>{ticket.clientAccount.name}</span>
                  <span>
                    {ticket.status.replaceAll("_", " ")} · {ticket.internalMessageCount} internal
                  </span>
                </button>
              ))}
            </div>
            {staffSelected && (
              <article className="ticket-thread" data-testid="staff-ticket-thread">
                <h3>{staffSelected.ticket.subject}</h3>
                <p>{staffSelected.ticket.clientAccount.name}</p>
                <div className="ticket-messages">
                  {staffSelected.messages.map((message) => (
                    <div
                      className={`ticket-message ${message.visibility}`}
                      data-visibility={message.visibility}
                      key={message.id}
                    >
                      <strong>
                        {message.authorEmail} · {message.visibility === "internal" ? "Internal note" : "Public"}
                      </strong>
                      <p>{message.body}</p>
                      <span>{new Date(message.createdAt).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
                <label>
                  Staff message
                  <textarea
                    aria-label="Staff ticket message"
                    value={staffReply}
                    onChange={(event) => setStaffReply(event.target.value)}
                    maxLength={10_000}
                  />
                </label>
                <div className="fund-actions">
                  <button
                    className="primary"
                    disabled={pending || staffReply.trim().length === 0}
                    onClick={() => void sendStaffMessage("public_reply")}
                  >
                    Send public reply
                  </button>
                  <button
                    disabled={pending || staffReply.trim().length === 0}
                    onClick={() => void sendStaffMessage("internal_note")}
                  >
                    Save internal note
                  </button>
                </div>
              </article>
            )}
          </div>
            </>
          )}
        </section>
      )}
    </>
  );
}
