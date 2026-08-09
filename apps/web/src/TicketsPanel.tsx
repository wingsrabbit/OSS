// SPDX-License-Identifier: AGPL-3.0-or-later

import { type FormEvent, useCallback, useEffect, useState } from "react";
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

type ServiceOption = { id: string; productName: string; status: string };

type Viewer = {
  id: string;
  eligible: boolean;
  staff: { roles: string[]; permissions: unknown } | null;
};

export function TicketsPanel({
  mode,
  canManageTickets = false,
  me,
  locale,
  onNotice,
  onError,
}: {
  mode: "customer" | "staff";
  canManageTickets?: boolean;
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

  const refreshCustomer = useCallback(async () => {
    if (!me?.eligible) {
      setTickets([]);
      setServices([]);
      setSelected(null);
      return;
    }
    const [ticketResult, serviceResult] = await Promise.all([
      api<{ items: TicketSummary[] }>("/api/v1/tickets"),
      api<{ items: ServiceOption[] }>("/api/v1/tickets/service-options"),
    ]);
    setTickets(ticketResult.items);
    setServices(serviceResult.items);
  }, [me?.eligible, me?.id]);

  const refreshStaff = useCallback(async () => {
    if (!me?.staff || !canManageTickets) {
      setStaffTickets([]);
      setStaffSelected(null);
      return;
    }
    const result = await api<{ items: StaffTicketSummary[] }>(
      "/api/v1/admin/tickets",
    );
    setStaffTickets(result.items);
  }, [canManageTickets, me?.id, me?.staff]);

  useEffect(() => {
    void (mode === "customer" ? refreshCustomer() : refreshStaff()).catch((caught: unknown) =>
      onError(caught instanceof Error ? caught.message : "Tickets could not be loaded"),
    );
  }, [mode, onError, refreshCustomer, refreshStaff]);

  if (mode === "customer" && !me?.eligible) return null;
  if (mode === "staff" && (!me?.staff || !canManageTickets)) return null;

  async function openCustomerTicket(ticketId: string) {
    try {
      setSelected(await api<CustomerTicketDetail>(`/api/v1/tickets/${ticketId}`));
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Ticket could not be loaded");
    }
  }

  async function createTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
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
      setSubject("");
      setOpeningMessage("");
      setServiceId("");
      setSelected(created);
      await refreshCustomer();
      onNotice(locale === "zh-CN" ? "工单已创建。" : "Support ticket created.");
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Ticket could not be created");
    } finally {
      setPending(false);
    }
  }

  async function replyAsCustomer() {
    if (!selected || customerReply.trim().length === 0 || pending) return;
    setPending(true);
    try {
      const updated = await api<CustomerTicketDetail>(
        `/api/v1/tickets/${selected.ticket.id}/replies`,
        { method: "POST", body: JSON.stringify({ message: customerReply.trim() }) },
      );
      setCustomerReply("");
      setSelected(updated);
      await refreshCustomer();
      onNotice(locale === "zh-CN" ? "回复已发送给客服。" : "Reply sent to staff.");
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Reply could not be sent");
    } finally {
      setPending(false);
    }
  }

  async function openStaffTicket(ticketId: string) {
    try {
      setStaffSelected(
        await api<StaffTicketDetail>(`/api/v1/admin/tickets/${ticketId}`),
      );
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Staff ticket could not be loaded");
    }
  }

  async function sendStaffMessage(kind: "public_reply" | "internal_note") {
    if (!staffSelected || staffReply.trim().length === 0 || pending) return;
    setPending(true);
    try {
      const updated = await api<StaffTicketDetail>(
        `/api/v1/admin/tickets/${staffSelected.ticket.id}/messages`,
        {
          method: "POST",
          body: JSON.stringify({ kind, message: staffReply.trim() }),
        },
      );
      setStaffReply("");
      setStaffSelected(updated);
      await refreshStaff();
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
      onError(caught instanceof Error ? caught.message : "Staff message could not be saved");
    } finally {
      setPending(false);
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
              ? "创建工单、可选关联自己的服务，并在同一会话中继续回复。"
              : "Create a ticket, optionally link one of your services, and continue the conversation."}
          </p>
        </div>
        <form className="ticket-compose" onSubmit={createTicket}>
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
        </form>

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
              <label>
                {locale === "zh-CN" ? "回复" : "Reply to ticket"}
                <textarea
                  aria-label="Customer ticket reply"
                  value={customerReply}
                  onChange={(event) => setCustomerReply(event.target.value)}
                  maxLength={10_000}
                />
              </label>
              <button
                className="primary"
                disabled={pending || customerReply.trim().length === 0}
                onClick={() => void replyAsCustomer()}
              >
                {locale === "zh-CN" ? "发送回复" : "Send reply"}
              </button>
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
        </section>
      )}
    </>
  );
}
