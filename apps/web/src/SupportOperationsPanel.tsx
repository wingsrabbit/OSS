// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, apiDownload } from "./api.js";

type Locale = "en" | "zh-CN";
type TicketStatus = "awaiting_staff" | "awaiting_customer" | "closed";
type TicketPriority = "low" | "normal" | "high" | "urgent";
type PresalesStatus = "awaiting_staff" | "awaiting_visitor" | "closed";

type Department = {
  id?: string;
  code: string;
  revision?: number;
  name?: string;
  description?: string;
  acceptsAuthenticated?: boolean;
  acceptsPresales?: boolean;
  currentRevision?: {
    id: string;
    revision: number;
    name: string;
    description: string;
    acceptsAuthenticated: boolean;
    acceptsPresales: boolean;
    createdAt: string;
  };
};

type TicketSummary = {
  id: string;
  subject: string;
  status: TicketStatus;
  service: { id: string; productName: string } | null;
  orderId: string | null;
  authorizationPurpose: string | null;
  department: { code: string; name: string };
  priority: TicketPriority;
  publicMessageCount: number;
  createdAt: string;
  updatedAt: string;
};

type TicketMessage = {
  id: string;
  authorType: "customer" | "staff";
  visibility?: "public" | "internal";
  authorEmail?: string;
  body: string;
  createdAt: string;
};

type Attachment = {
  id: string;
  messageId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedByType: "customer" | "staff";
  scanStatus: "pending" | "clean" | "rejected" | "error";
  createdAt: string;
};

type CustomerStatusHistory = {
  previousStatus: TicketStatus | null;
  status: TicketStatus;
  summary: string;
  occurredAt: string;
};

type StaffStatusHistory = {
  id: string;
  previousStatus: TicketStatus | null;
  status: TicketStatus;
  actorType: string;
  actorEmail: string | null;
  reason: string;
  occurredAt: string;
};

type AssignmentHistory = {
  id: string;
  assignedStaffUserId: string | null;
  assignedStaffEmail: string | null;
  actorType: string;
  actorEmail: string;
  sequence: number;
  reason: string;
  occurredAt: string;
};

type CustomerRoutingHistory = {
  department: { code: string; name: string; revision: number };
  priority: TicketPriority;
  summary: string;
  occurredAt: string;
};

type StaffRoutingHistory = {
  id: string;
  department: { code: string; name: string; revision: number };
  priority: TicketPriority;
  actorType: string;
  actorEmail: string;
  sequence: number;
  reason: string;
  occurredAt: string;
};

type CustomerTicketDetail = {
  ticket: TicketSummary;
  messages: TicketMessage[];
  attachments: Attachment[];
  statusHistory: CustomerStatusHistory[];
  routingHistory: CustomerRoutingHistory[];
};

type StaffTicketSummary = TicketSummary & {
  assignedStaffUserId: string | null;
  clientAccount: { id: string; name: string };
  internalMessageCount: number;
};

type StaffTicketDetail = {
  ticket: StaffTicketSummary;
  messages: TicketMessage[];
  attachments: Attachment[];
  statusHistory: StaffStatusHistory[];
  assignmentHistory: AssignmentHistory[];
  routingHistory: StaffRoutingHistory[];
};

type StaffOption = { id: string; email: string; roles: string[] };
type ServiceOption = { id: string; productName: string; status: string };

type PresalesSummary = {
  id: string;
  visitorName: string;
  visitorEmail: string;
  topic: "general_sales" | "product_question";
  subject: string;
  status: PresalesStatus;
  departmentName: string;
  createdAt: string;
  updatedAt: string;
};

type PresalesDetail = {
  inquiry: PresalesSummary;
  messages: Array<{
    id: string;
    authorType: "visitor" | "staff";
    authorUserId?: string | null;
    visibility?: "public" | "internal";
    body: string;
    createdAt: string;
  }>;
};

type MutationPlan<T> = Readonly<{
  scope: string;
  payload: unknown;
  request: (idempotencyKey: string) => Promise<T>;
  committed?: (value: T) => void;
  refresh?: () => Promise<void>;
  success: string;
  failure: string;
}>;

export type SupportOperationsPanelProps = {
  mode: "customer" | "staff" | "visitor";
  locale: Locale;
  canReadCustomerTickets?: boolean;
  canWriteCustomerTickets?: boolean;
  canManageSupport?: boolean;
  staffAccountContext?: { id: string; name: string } | null;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
};

async function publicRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const body = await response.json().catch(() => ({})) as {
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new Error(body.error ?? body.message ?? `Request failed (${response.status})`);
  }
  return body as T;
}

function formatDate(value: string, locale: Locale): string {
  return new Date(value).toLocaleString(locale);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function attachmentPayload(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return {
    filename: file.name,
    contentType: file.type || "text/plain",
    contentBase64: window.btoa(binary),
  };
}

function customerHistorySummary(summary: string, locale: Locale): string {
  if (locale !== "zh-CN") return summary;
  return ({
    "Ticket created": "工单已创建",
    "Ticket closed": "工单已关闭",
    "Ticket reopened": "工单已重新开启",
    "Support replied": "客服已回复",
    "Customer replied": "客户已回复",
    "Ticket status updated": "工单状态已更新",
    "Initial Support routing": "初始客服路由",
    "Support routing updated": "客服路由已更新",
  } as Record<string, string>)[summary] ?? summary;
}

function CustomerHistory({ detail, locale }: { detail: CustomerTicketDetail; locale: Locale }) {
  const tr = (en: string, zh: string) => locale === "zh-CN" ? zh : en;
  return (
    <details data-testid="support-ticket-history">
      <summary>{tr("Ticket history", "工单历史")}</summary>
      <h4>{tr("Status", "状态")}</h4>
      <ol>
        {detail.statusHistory.map((event) => (
          <li key={`${event.occurredAt}:${event.status}`}>
            {event.previousStatus ?? tr("created", "创建")} → {event.status} · {customerHistorySummary(event.summary, locale)} · {formatDate(event.occurredAt, locale)}
          </li>
        ))}
      </ol>
      <h4>{tr("Routing", "路由")}</h4>
      <ol>
        {detail.routingHistory.map((event) => (
          <li key={`${event.occurredAt}:${event.department.code}:${event.priority}`}>
            {event.department.name} r{event.department.revision} · {event.priority} · {customerHistorySummary(event.summary, locale)} · {formatDate(event.occurredAt, locale)}
          </li>
        ))}
      </ol>
    </details>
  );
}

function StaffHistory({ detail, locale }: { detail: StaffTicketDetail; locale: Locale }) {
  const tr = (en: string, zh: string) => locale === "zh-CN" ? zh : en;
  return <details data-testid="support-ticket-history">
    <summary>{tr("Complete ticket history", "完整工单历史")}</summary>
    <h4>{tr("Status", "状态")}</h4>
    <ol>{detail.statusHistory.map((event) => <li key={event.id}>
      {event.previousStatus ?? tr("created", "创建")} → {event.status} · {event.actorType}
      {event.actorEmail ? ` (${event.actorEmail})` : ""} · {event.reason} · {formatDate(event.occurredAt, locale)}
    </li>)}</ol>
    <h4>{tr("Assignment", "分配")}</h4>
    <ol>{detail.assignmentHistory.map((event) => <li key={event.id}>
      #{event.sequence} · {event.assignedStaffEmail ?? tr("Unassigned", "未分配")} · {event.reason} · {formatDate(event.occurredAt, locale)}
    </li>)}</ol>
    <h4>{tr("Routing", "路由")}</h4>
    <ol>{detail.routingHistory.map((event) => <li key={event.id}>
      #{event.sequence} · {event.department.name} r{event.department.revision} · {event.priority} · {event.reason} · {formatDate(event.occurredAt, locale)}
    </li>)}</ol>
  </details>;
}

function AttachmentList({
  attachments,
  canDelete,
  onDelete,
  onDownload,
  pending,
  locale,
}: {
  attachments: Attachment[];
  canDelete: (attachment: Attachment) => boolean;
  onDelete: (attachment: Attachment) => void;
  onDownload: (attachment: Attachment) => void;
  pending: boolean;
  locale: Locale;
}) {
  const tr = (en: string, zh: string) => locale === "zh-CN" ? zh : en;
  return (
    <section aria-label={tr("Ticket attachments", "工单附件")}>
      <h4>{tr("Attachments", "附件")}</h4>
      {attachments.length === 0 && <p className="muted">{tr("No attachments.", "暂无附件。")}</p>}
      <ul>
        {attachments.map((attachment) => (
          <li key={attachment.id}>
            {attachment.filename} · {attachment.sizeBytes} {tr("bytes", "字节")} · {attachment.uploadedByType}
            {attachment.scanStatus === "clean" ? (
              <>
                <span className="muted"> · {tr("Download available", "可下载")}</span>
                <button
                  type="button"
                  aria-label={`${tr("Download", "下载")} ${attachment.filename}`}
                  disabled={pending}
                  onClick={() => onDownload(attachment)}
                >
                  {tr("Download", "下载")}
                </button>
              </>
            ) : (
              <span className="muted"> · {tr("Download not available", "暂不可下载")}</span>
            )}
            {canDelete(attachment) && (
              <button type="button" disabled={pending} onClick={() => onDelete(attachment)}>{tr("Delete", "删除")}</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SupportOperationsPanel({
  mode,
  locale,
  canReadCustomerTickets = false,
  canWriteCustomerTickets = false,
  canManageSupport = false,
  staffAccountContext = null,
  onNotice,
  onError,
}: SupportOperationsPanelProps) {
  const tr = (en: string, zh: string) => locale === "zh-CN" ? zh : en;
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  const mutationIntents = useRef(new Map<string, { key: string; fingerprint: string }>());
  const [departments, setDepartments] = useState<Department[]>([]);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [customerDetail, setCustomerDetail] = useState<CustomerTicketDetail | null>(null);
  const customerDetailRef = useRef<CustomerTicketDetail | null>(null);
  const [staffTickets, setStaffTickets] = useState<StaffTicketSummary[]>([]);
  const [staffDetail, setStaffDetail] = useState<StaffTicketDetail | null>(null);
  const staffDetailRef = useRef<StaffTicketDetail | null>(null);
  const [staffOptions, setStaffOptions] = useState<StaffOption[]>([]);
  const [presales, setPresales] = useState<PresalesSummary[]>([]);
  const [presalesDetail, setPresalesDetail] = useState<PresalesDetail | null>(null);
  const [visitorDetail, setVisitorDetail] = useState<PresalesDetail | null>(null);
  const [visitorAccess, setVisitorAccess] = useState<{ inquiryId: string; token: string } | null>(null);

  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [departmentCode, setDepartmentCode] = useState("general-support");
  const [priority, setPriority] = useState<TicketPriority>("normal");
  const [serviceId, setServiceId] = useState("");
  const [orderId, setOrderId] = useState("");
  const [authorizationPurpose, setAuthorizationPurpose] = useState("");
  const [customerReplyText, setCustomerReplyText] = useState("");
  const [customerAttachment, setCustomerAttachment] = useState<File | null>(null);
  const [visitorReplyText, setVisitorReplyText] = useState("");

  const [queueStatus, setQueueStatus] = useState("");
  const [queueDepartment, setQueueDepartment] = useState("");
  const [queuePriority, setQueuePriority] = useState("");
  const [queueAssignee, setQueueAssignee] = useState("");
  const [assignment, setAssignment] = useState("");
  const [staffReauthPassword, setStaffReauthPassword] = useState("");
  const [staffFactorCode, setStaffFactorCode] = useState("");
  const [staffTicketReason, setStaffTicketReason] = useState("");
  const [staffTicketReplyText, setStaffTicketReplyText] = useState("");
  const [staffAttachment, setStaffAttachment] = useState<File | null>(null);
  const [presalesReason, setPresalesReason] = useState("");
  const [presalesReplyText, setPresalesReplyText] = useState("");
  const [presalesMessageKind, setPresalesMessageKind] = useState<"public_reply" | "internal_note">("public_reply");

  const [departmentEditId, setDepartmentEditId] = useState("");
  const [departmentEditCode, setDepartmentEditCode] = useState("");
  const [departmentName, setDepartmentName] = useState("");
  const [departmentDescription, setDepartmentDescription] = useState("");
  const [acceptsAuthenticated, setAcceptsAuthenticated] = useState(true);
  const [acceptsPresales, setAcceptsPresales] = useState(false);
  const [departmentReason, setDepartmentReason] = useState("");

  const [visitorName, setVisitorName] = useState("");
  const [visitorEmail, setVisitorEmail] = useState("");
  const [visitorTopic, setVisitorTopic] = useState<"general_sales" | "product_question">("general_sales");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      mutationIntents.current.clear();
    };
  }, []);

  useEffect(() => {
    customerDetailRef.current = customerDetail;
  }, [customerDetail]);

  useEffect(() => {
    staffDetailRef.current = staffDetail;
  }, [staffDetail]);

  function intentKeyFor(scope: string, payload: unknown): string {
    const fingerprint = JSON.stringify(payload);
    const current = mutationIntents.current.get(scope);
    if (current?.fingerprint === fingerprint) return current.key;
    const next = { key: crypto.randomUUID(), fingerprint };
    mutationIntents.current.set(scope, next);
    return next.key;
  }

  async function runMutation<T>(plan: MutationPlan<T>): Promise<void> {
    if (pending) return;
    const idempotencyKey = intentKeyFor(plan.scope, plan.payload);
    setPending(true);
    let value: T;
    try {
      if (mode === "staff" && staffReauthPassword.length > 0) {
        await api("/api/v1/auth/reauth", {
          method: "POST",
          body: JSON.stringify({
            password: staffReauthPassword,
            ...(staffFactorCode.trim() ? { factorCode: staffFactorCode.trim() } : {}),
          }),
        });
        if (!mounted.current) return;
        setStaffReauthPassword("");
        setStaffFactorCode("");
      }
      value = await plan.request(idempotencyKey);
    } catch (error) {
      if (!mounted.current) return;
      onError(errorMessage(error, plan.failure));
      setPending(false);
      return;
    }

    if (!mounted.current) return;

    mutationIntents.current.delete(plan.scope);
    plan.committed?.(value);
    if (plan.refresh) {
      try {
        await plan.refresh();
      } catch {
        onNotice(`${plan.success} ${tr(
          "The change was committed, but the latest data could not be refreshed. Refresh the page to verify the current view.",
          "更改已提交，但暂时无法刷新最新数据。请刷新页面核对当前视图。",
        )}`);
        setPending(false);
        return;
      }
    }
    onNotice(plan.success);
    setPending(false);
  }

  const refreshCustomer = useCallback(async () => {
    if (mode !== "customer" || !canReadCustomerTickets) return;
    const [ticketResponse, serviceResponse, departmentResponse] = await Promise.all([
      api<{ items: TicketSummary[] }>("/api/v1/tickets"),
      api<{ items: ServiceOption[] }>("/api/v1/tickets/service-options"),
      api<{ items: Department[] }>("/api/v1/support/departments?audience=authenticated"),
    ]);
    if (!mounted.current) return;
    setTickets(ticketResponse.items);
    setServices(serviceResponse.items);
    setDepartments(departmentResponse.items);
  }, [canReadCustomerTickets, mode]);

  const queueUrl = useMemo(() => {
    const query = new URLSearchParams();
    if (staffAccountContext) query.set("clientAccountId", staffAccountContext.id);
    if (queueStatus) query.set("status", queueStatus);
    if (queueDepartment) query.set("department", queueDepartment);
    if (queuePriority) query.set("priority", queuePriority);
    if (queueAssignee) query.set("assignee", queueAssignee);
    const encoded = query.toString();
    return `/api/v1/admin/tickets${encoded ? `?${encoded}` : ""}`;
  }, [queueAssignee, queueDepartment, queuePriority, queueStatus, staffAccountContext]);

  const refreshStaff = useCallback(async () => {
    if (mode !== "staff" || !canManageSupport) return;
    const [queue, options, departmentResponse, presalesResponse] = await Promise.all([
      api<{ items: StaffTicketSummary[] }>(queueUrl),
      api<{ items: StaffOption[] }>("/api/v1/admin/tickets/staff-options"),
      api<{ items: Department[] }>("/api/v1/admin/support/departments"),
      api<{ items: PresalesSummary[] }>("/api/v1/admin/presales/inquiries"),
    ]);
    if (!mounted.current) return;
    setStaffTickets(queue.items);
    setStaffOptions(options.items);
    setDepartments(departmentResponse.items);
    setPresales(presalesResponse.items);
  }, [canManageSupport, mode, queueUrl]);

  const refreshVisitorDepartments = useCallback(async () => {
    if (mode !== "visitor") return;
    const response = await publicRequest<{ items: Department[] }>(
      "/api/v1/support/departments?audience=presales",
    );
    if (!mounted.current) return;
    setDepartments(response.items);
    setDepartmentCode((current) =>
      response.items.some((item) => item.code === current)
        ? current
        : response.items[0]?.code ?? current,
    );
  }, [mode]);

  useEffect(() => {
    const run = mode === "customer"
      ? refreshCustomer()
      : mode === "staff"
        ? refreshStaff()
        : refreshVisitorDepartments();
    void run.catch((error: unknown) => {
      if (!mounted.current) return;
      onError(errorMessage(
        error,
        tr("Support data could not be loaded", "无法加载客服数据"),
      ));
    });
  }, [mode, onError, refreshCustomer, refreshStaff, refreshVisitorDepartments]);

  async function refreshCustomerDetail(ticketId: string): Promise<void> {
    setCustomerDetail(await api<CustomerTicketDetail>(`/api/v1/tickets/${ticketId}`));
  }

  async function openCustomer(ticketId: string) {
    if (customerDetail?.ticket.id !== ticketId) {
      setCustomerReplyText("");
      setCustomerAttachment(null);
    }
    try {
      await refreshCustomerDetail(ticketId);
    } catch (error) {
      onError(errorMessage(error, tr("Ticket could not be opened", "无法打开工单")));
    }
  }

  async function createTicket(event: FormEvent) {
    event.preventDefault();
    if (pending || !canWriteCustomerTickets) return;
    const payload = {
      subject,
      message,
      departmentCode,
      priority,
      serviceId: serviceId || null,
      orderId: orderId || null,
      authorizationPurpose: authorizationPurpose || null,
    };
    await runMutation<CustomerTicketDetail>({
      scope: "customer:create-ticket",
      payload,
      request: (idempotencyKey) => api<CustomerTicketDetail>("/api/v1/tickets", {
        method: "POST",
        body: JSON.stringify({ ...payload, idempotencyKey }),
      }),
      committed: (created) => {
        setCustomerDetail(created);
        setSubject("");
        setMessage("");
        setOrderId("");
        setAuthorizationPurpose("");
      },
      refresh: refreshCustomer,
      success: tr("Ticket created.", "工单已创建。"),
      failure: tr("Ticket could not be created", "无法创建工单"),
    });
  }

  async function customerReply() {
    if (!customerDetail || !customerReplyText.trim() || pending) return;
    const ticketId = customerDetail.ticket.id;
    const payload = { message: customerReplyText.trim() };
    await runMutation<CustomerTicketDetail>({
      scope: `customer:${ticketId}:reply`,
      payload,
      request: (idempotencyKey) => api<CustomerTicketDetail>(
        `/api/v1/tickets/${customerDetail.ticket.id}/replies`,
        { method: "POST", body: JSON.stringify({ ...payload, idempotencyKey }) },
      ),
      committed: (updated) => {
        setCustomerDetail(updated);
        setCustomerReplyText("");
      },
      refresh: refreshCustomer,
      success: tr("Reply added.", "回复已添加。"),
      failure: tr("Reply could not be added", "无法添加回复"),
    });
  }

  async function setCustomerStatus(status: "awaiting_staff" | "closed") {
    if (!customerDetail || pending) return;
    const ticketId = customerDetail.ticket.id;
    const payload = {
      status,
      reason: status === "closed"
        ? "Customer confirmed this request is complete"
        : "Customer needs further assistance",
    };
    await runMutation({
      scope: `customer:${ticketId}:status`,
      payload,
      request: (idempotencyKey) => api(`/api/v1/tickets/${ticketId}/status`, {
        method: "POST",
        body: JSON.stringify({ ...payload, idempotencyKey }),
      }),
      committed: () => setCustomerDetail((current) => current?.ticket.id === ticketId
        ? { ...current, ticket: { ...current.ticket, status } }
        : current),
      refresh: async () => {
        await Promise.all([refreshCustomerDetail(ticketId), refreshCustomer()]);
      },
      success: status === "closed"
        ? tr("Ticket closed.", "工单已关闭。")
        : tr("Ticket reopened.", "工单已重新开启。"),
      failure: tr("Ticket status could not be changed", "无法更改工单状态"),
    });
  }

  async function uploadCustomerAttachment() {
    if (!customerDetail || !customerAttachment || pending) return;
    const messageId = [...customerDetail.messages].reverse().find((item) => item.authorType === "customer")?.id;
    if (!messageId) return onError(tr(
      "Add a customer message before attaching a file.",
      "请先添加客户消息，再上传附件。",
    ));
    let payload: Awaited<ReturnType<typeof attachmentPayload>>;
    try {
      payload = await attachmentPayload(customerAttachment);
    } catch (error) {
      onError(errorMessage(error, tr("Attachment could not be read", "无法读取附件")));
      return;
    }
    const ticketId = customerDetail.ticket.id;
    await runMutation({
      scope: `customer:${ticketId}:message:${messageId}:attachment`,
      payload,
      request: (idempotencyKey) => api(
        `/api/v1/tickets/${ticketId}/messages/${messageId}/attachments`,
        { method: "POST", body: JSON.stringify({ ...payload, idempotencyKey }) },
      ),
      committed: () => setCustomerAttachment(null),
      refresh: async () => {
        await Promise.all([refreshCustomerDetail(ticketId), refreshCustomer()]);
      },
      success: tr("Attachment uploaded.", "附件已上传。"),
      failure: tr("Attachment could not be uploaded", "无法上传附件"),
    });
  }

  async function deleteCustomerAttachment(item: Attachment) {
    if (!customerDetail || pending) return;
    const ticketId = customerDetail.ticket.id;
    const payload = { attachmentId: item.id };
    await runMutation({
      scope: `customer:${ticketId}:attachment:${item.id}:delete`,
      payload,
      request: (idempotencyKey) => api(
        `/api/v1/tickets/${ticketId}/attachments/${item.id}`,
        { method: "DELETE", body: JSON.stringify({ idempotencyKey }) },
      ),
      committed: () => setCustomerDetail((current) => current?.ticket.id === ticketId
        ? { ...current, attachments: current.attachments.filter((attachmentItem) => attachmentItem.id !== item.id) }
        : current),
      refresh: () => refreshCustomerDetail(ticketId),
      success: tr("Attachment deleted.", "附件已删除。"),
      failure: tr("Attachment could not be deleted", "无法删除附件"),
    });
  }

  async function downloadAttachment(
    path: string,
    item: Attachment,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (pending) return;
    setPending(true);
    try {
      const blob = await apiDownload(path);
      if (!mounted.current || !isCurrent()) return;
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = item.filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      onNotice(tr("Attachment download started.", "附件下载已开始。"));
    } catch (error) {
      if (!mounted.current) return;
      onError(errorMessage(error, tr(
        "Attachment could not be downloaded",
        "无法下载附件",
      )));
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  async function downloadCustomerAttachment(item: Attachment): Promise<void> {
    const ticketId = customerDetail?.ticket.id;
    if (!ticketId) return;
    await downloadAttachment(
      `/api/v1/tickets/${ticketId}/attachments/${item.id}`,
      item,
      () => customerDetailRef.current?.ticket.id === ticketId &&
        customerDetailRef.current.attachments.some((current) => current.id === item.id),
    );
  }

  async function refreshStaffDetail(ticketId: string): Promise<void> {
    const detail = await api<StaffTicketDetail>(`/api/v1/admin/tickets/${ticketId}`);
    setStaffDetail(detail);
    setAssignment(detail.ticket.assignedStaffUserId ?? "");
    setDepartmentCode(detail.ticket.department.code);
    setPriority(detail.ticket.priority);
  }

  async function openStaff(ticketId: string) {
    setPresalesReplyText("");
    setPresalesMessageKind("public_reply");
    setPresalesReason("");
    if (staffDetail?.ticket.id !== ticketId) {
      setStaffTicketReplyText("");
      setStaffTicketReason("");
      setStaffAttachment(null);
    }
    try {
      await refreshStaffDetail(ticketId);
    } catch (error) {
      onError(errorMessage(error, tr("Ticket could not be opened", "无法打开工单")));
    }
  }

  async function staffMutation(path: string, body: Record<string, unknown>, notice: string) {
    if (!staffDetail || pending) return;
    const ticketId = staffDetail.ticket.id;
    await runMutation({
      scope: `staff:${path}`,
      payload: body,
      request: (idempotencyKey) => api(path, {
        method: "POST",
        body: JSON.stringify({ ...body, idempotencyKey }),
      }),
      committed: () => setStaffTicketReason(""),
      refresh: async () => {
        await Promise.all([refreshStaffDetail(ticketId), refreshStaff()]);
      },
      success: notice,
      failure: tr("Support operation failed", "客服操作失败"),
    });
  }

  async function sendStaffMessage(kind: "public_reply" | "internal_note") {
    if (!staffDetail || !staffTicketReplyText.trim() || pending) return;
    const ticketId = staffDetail.ticket.id;
    const payload = {
      kind,
      message: staffTicketReplyText.trim(),
    };
    await runMutation<StaffTicketDetail>({
      scope: `staff:ticket:${ticketId}:message`,
      payload,
      request: (idempotencyKey) => api<StaffTicketDetail>(
        `/api/v1/admin/tickets/${ticketId}/messages`,
        { method: "POST", body: JSON.stringify({ ...payload, idempotencyKey }) },
      ),
      committed: (updated) => {
        setStaffDetail(updated);
        setStaffTicketReplyText("");
      },
      refresh: refreshStaff,
      success: kind === "internal_note"
        ? tr("Internal note saved.", "内部备注已保存。")
        : tr("Public reply sent.", "公开回复已发送。"),
      failure: tr("Message could not be saved", "无法保存消息"),
    });
  }

  async function uploadStaffAttachment() {
    if (!staffDetail || !staffAttachment || pending) return;
    const messageId = [...staffDetail.messages].reverse().find((item) => item.authorType === "staff")?.id;
    if (!messageId) return onError(tr(
      "Add a Staff message before attaching a file.",
      "请先添加客服消息，再上传附件。",
    ));
    let payload: Awaited<ReturnType<typeof attachmentPayload>>;
    try {
      payload = await attachmentPayload(staffAttachment);
    } catch (error) {
      onError(errorMessage(error, tr("Attachment could not be read", "无法读取附件")));
      return;
    }
    const ticketId = staffDetail.ticket.id;
    await runMutation({
      scope: `staff:ticket:${ticketId}:message:${messageId}:attachment`,
      payload,
      request: (idempotencyKey) => api(
        `/api/v1/admin/tickets/${ticketId}/messages/${messageId}/attachments`,
        { method: "POST", body: JSON.stringify({ ...payload, idempotencyKey }) },
      ),
      committed: () => setStaffAttachment(null),
      refresh: async () => {
        await Promise.all([refreshStaffDetail(ticketId), refreshStaff()]);
      },
      success: tr("Attachment uploaded.", "附件已上传。"),
      failure: tr("Attachment could not be uploaded", "无法上传附件"),
    });
  }

  async function deleteStaffAttachment(item: Attachment) {
    if (!staffDetail || pending) return;
    const ticketId = staffDetail.ticket.id;
    const payload = {
      reason: staffTicketReason || "Staff removed this attachment",
      attachmentId: item.id,
    };
    await runMutation({
      scope: `staff:ticket:${ticketId}:attachment:${item.id}:delete`,
      payload,
      request: (idempotencyKey) => api(
        `/api/v1/admin/tickets/${ticketId}/attachments/${item.id}`,
        {
          method: "DELETE",
          body: JSON.stringify({ reason: payload.reason, idempotencyKey }),
        },
      ),
      committed: () => {
        setStaffTicketReason("");
        setStaffDetail((current) => current?.ticket.id === ticketId
          ? { ...current, attachments: current.attachments.filter((attachmentItem) => attachmentItem.id !== item.id) }
          : current);
      },
      refresh: () => refreshStaffDetail(ticketId),
      success: tr("Attachment deleted.", "附件已删除。"),
      failure: tr("Attachment could not be deleted", "无法删除附件"),
    });
  }

  async function downloadStaffAttachment(item: Attachment): Promise<void> {
    const ticketId = staffDetail?.ticket.id;
    if (!ticketId) return;
    await downloadAttachment(
      `/api/v1/admin/tickets/${ticketId}/attachments/${item.id}`,
      item,
      () => staffDetailRef.current?.ticket.id === ticketId &&
        staffDetailRef.current.attachments.some((current) => current.id === item.id),
    );
  }

  function editDepartment(item: Department) {
    const revision = item.currentRevision;
    setDepartmentEditId(item.id ?? "");
    setDepartmentEditCode(item.code);
    setDepartmentName(revision?.name ?? item.name ?? "");
    setDepartmentDescription(revision?.description ?? item.description ?? "");
    setAcceptsAuthenticated(revision?.acceptsAuthenticated ?? item.acceptsAuthenticated ?? true);
    setAcceptsPresales(revision?.acceptsPresales ?? item.acceptsPresales ?? false);
    setDepartmentReason("");
  }

  async function saveDepartment(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const path = departmentEditId
      ? `/api/v1/admin/support/departments/${departmentEditId}/revisions`
      : "/api/v1/admin/support/departments";
    const payload = {
      ...(!departmentEditId ? { code: departmentEditCode } : {}),
      name: departmentName,
      description: departmentDescription,
      acceptsAuthenticated,
      acceptsPresales,
      ...(departmentEditId
        ? { reason: departmentReason || "Support department details updated" }
        : {}),
    };
    await runMutation({
      scope: `staff:department:${departmentEditId || "new"}`,
      payload,
      request: (idempotencyKey) => api(path, {
        method: "POST",
        body: JSON.stringify({ ...payload, idempotencyKey }),
      }),
      committed: () => {
        setDepartmentEditId("");
        setDepartmentEditCode("");
        setDepartmentName("");
        setDepartmentDescription("");
        setDepartmentReason("");
      },
      refresh: refreshStaff,
      success: tr("Department revision saved.", "部门修订已保存。"),
      failure: tr("Department could not be saved", "无法保存部门"),
    });
  }

  async function refreshPresalesDetail(inquiryId: string): Promise<void> {
    setPresalesDetail(await api<PresalesDetail>(`/api/v1/admin/presales/inquiries/${inquiryId}`));
  }

  async function openPresales(inquiryId: string) {
    setStaffTicketReplyText("");
    setStaffTicketReason("");
    setStaffAttachment(null);
    if (presalesDetail?.inquiry.id !== inquiryId) {
      setPresalesReplyText("");
      setPresalesMessageKind("public_reply");
      setPresalesReason("");
    }
    try {
      await refreshPresalesDetail(inquiryId);
    } catch (error) {
      onError(errorMessage(error, tr("Presales inquiry could not be opened", "无法打开售前咨询")));
    }
  }

  async function staffPresalesMessage() {
    if (!presalesDetail || !presalesReplyText.trim() || pending) return;
    const inquiryId = presalesDetail.inquiry.id;
    const payload = { kind: presalesMessageKind, message: presalesReplyText.trim() };
    await runMutation({
      scope: `staff:presales:${inquiryId}:message`,
      payload,
      request: (idempotencyKey) => api(`/api/v1/admin/presales/inquiries/${inquiryId}/messages`, {
        method: "POST",
        body: JSON.stringify({ ...payload, idempotencyKey }),
      }),
      committed: () => setPresalesReplyText(""),
      refresh: async () => {
        await Promise.all([refreshPresalesDetail(inquiryId), refreshStaff()]);
      },
      success: presalesMessageKind === "internal_note"
        ? tr("Presales internal note saved.", "售前内部备注已保存。")
        : tr("Presales reply sent.", "售前回复已发送。"),
      failure: tr("Presales message could not be saved", "无法保存售前消息"),
    });
  }

  async function setPresalesStatus(status: PresalesStatus) {
    if (!presalesDetail || pending) return;
    const inquiryId = presalesDetail.inquiry.id;
    const payload = {
      status,
      reason: presalesReason || "Staff updated the Presales inquiry",
    };
    await runMutation({
      scope: `staff:presales:${inquiryId}:status`,
      payload,
      request: (idempotencyKey) => api(`/api/v1/admin/presales/inquiries/${inquiryId}/status`, {
        method: "POST",
        body: JSON.stringify({ ...payload, idempotencyKey }),
      }),
      committed: () => {
        setPresalesReason("");
        setPresalesDetail((current) => current?.inquiry.id === inquiryId
          ? { ...current, inquiry: { ...current.inquiry, status } }
          : current);
      },
      refresh: async () => {
        await Promise.all([refreshPresalesDetail(inquiryId), refreshStaff()]);
      },
      success: status === "closed"
        ? tr("Presales inquiry closed.", "售前咨询已关闭。")
        : tr("Presales inquiry reopened.", "售前咨询已重新开启。"),
      failure: tr("Presales status could not be changed", "无法更改售前状态"),
    });
  }

  async function createPresales(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const payload = {
      visitorName,
      visitorEmail,
      topic: visitorTopic,
      subject,
      message,
      departmentCode,
    };
    let committedAccess: { inquiryId: string; token: string } | null = null;
    await runMutation<{ inquiryId: string; accessToken: string }>({
      scope: "visitor:create-presales",
      payload,
      request: (idempotencyKey) => publicRequest<{ inquiryId: string; accessToken: string }>(
        "/api/v1/presales/inquiries",
        {
          method: "POST",
          body: JSON.stringify({ ...payload, idempotencyKey }),
        },
      ),
      committed: (created) => {
        committedAccess = { inquiryId: created.inquiryId, token: created.accessToken };
        setVisitorAccess(committedAccess);
        setMessage("");
      },
      refresh: async () => {
        const access = committedAccess;
        if (!access) throw new Error("Presales access was not retained");
        setVisitorDetail(await publicRequest<PresalesDetail>(
          `/api/v1/presales/inquiries/${access.inquiryId}`,
          { headers: { "X-OSS-Presales-Token": access.token } },
        ));
      },
      success: tr(
        "Presales inquiry created. Keep this page open to continue the conversation.",
        "售前咨询已创建。请保持此页面开启以继续对话。",
      ),
      failure: tr("Presales inquiry could not be created", "无法创建售前咨询"),
    });
  }

  async function visitorReply() {
    if (!visitorAccess || !visitorDetail || !visitorReplyText.trim() || pending) return;
    const access = visitorAccess;
    const payload = { message: visitorReplyText.trim() };
    await runMutation({
      scope: `visitor:presales:${access.inquiryId}:reply`,
      payload,
      request: (idempotencyKey) => publicRequest(`/api/v1/presales/inquiries/${access.inquiryId}/replies`, {
        method: "POST",
        headers: { "X-OSS-Presales-Token": visitorAccess.token },
        body: JSON.stringify({ ...payload, idempotencyKey }),
      }),
      committed: () => setVisitorReplyText(""),
      refresh: async () => setVisitorDetail(await publicRequest<PresalesDetail>(
        `/api/v1/presales/inquiries/${access.inquiryId}`,
        { headers: { "X-OSS-Presales-Token": access.token } },
      )),
      success: tr("Presales reply sent.", "售前回复已发送。"),
      failure: tr("Presales reply could not be sent", "无法发送售前回复"),
    });
  }

  async function retryVisitorThread() {
    if (!visitorAccess) return;
    try {
      setVisitorDetail(await publicRequest<PresalesDetail>(
        `/api/v1/presales/inquiries/${visitorAccess.inquiryId}`,
        { headers: { "X-OSS-Presales-Token": visitorAccess.token } },
      ));
      onNotice(tr("Conversation refreshed.", "对话已刷新。"));
    } catch (error) {
      onError(errorMessage(error, tr("Conversation could not be refreshed", "无法刷新对话")));
    }
  }

  if (mode === "customer" && !canReadCustomerTickets) return null;
  if (mode === "staff" && !canManageSupport) return null;

  if (mode === "visitor") {
    return <section className="order-panel support-operations" aria-label={tr("Visitor Presales", "访客售前咨询")}>
      <p className="eyebrow">{tr("Presales · separate from authenticated Support", "售前咨询 · 与登录后的客服工单分离")}</p>
      <h2>{tr("Ask a product question", "咨询产品问题")}</h2>
      {!visitorAccess && <form onSubmit={createPresales}>
        <label>{tr("Name", "姓名")}<input value={visitorName} onChange={(event) => setVisitorName(event.target.value)} required minLength={2} /></label>
        <label>{tr("Email", "邮箱")}<input type="email" value={visitorEmail} onChange={(event) => setVisitorEmail(event.target.value)} required /></label>
        <label>{tr("Topic", "主题类型")}<select value={visitorTopic} onChange={(event) => setVisitorTopic(event.target.value as typeof visitorTopic)}><option value="general_sales">{tr("General sales", "一般销售咨询")}</option><option value="product_question">{tr("Product question", "产品问题")}</option></select></label>
        <label>{tr("Department", "部门")}<select value={departmentCode} onChange={(event) => setDepartmentCode(event.target.value)}>{departments.map((item) => <option key={item.code} value={item.code}>{item.name ?? item.code}</option>)}</select></label>
        <label>{tr("Subject", "主题")}<input value={subject} onChange={(event) => setSubject(event.target.value)} required minLength={3} /></label>
        <label>{tr("Message", "消息")}<textarea value={message} onChange={(event) => setMessage(event.target.value)} required /></label>
        <button className="primary" disabled={pending}>{tr("Submit inquiry", "提交咨询")}</button>
      </form>}
      {visitorAccess && !visitorDetail && <section data-testid="visitor-presales-committed">
        <p>{tr(
          "Your inquiry was submitted. The conversation could not be refreshed yet.",
          "咨询已提交，但暂时无法刷新对话。",
        )}</p>
        <button disabled={pending} onClick={() => void retryVisitorThread()}>{tr("Retry refresh", "重试刷新")}</button>
      </section>}
      {visitorDetail && <article data-testid="visitor-presales-thread">
        <h3>{visitorDetail.inquiry.subject}</h3><span className="pill">{visitorDetail.inquiry.status}</span>
        {visitorDetail.messages.map((item) => <div key={item.id}><strong>{item.authorType}</strong><p>{item.body}</p></div>)}
        {visitorDetail.inquiry.status !== "closed" && <><textarea aria-label={tr("Visitor reply", "访客回复")} value={visitorReplyText} onChange={(event) => setVisitorReplyText(event.target.value)} /><button disabled={pending || !visitorReplyText.trim()} onClick={() => void visitorReply()}>{tr("Reply", "回复")}</button></>}
      </article>}
    </section>;
  }

  if (mode === "customer") {
    return <section className="order-panel support-operations" aria-label="Customer support tickets">
      <p className="eyebrow">{tr("Customer Support · Mock-only", "客户支持 · 仅 Mock")}</p><h2>{tr("My support tickets", "我的工单")}</h2>
      {canWriteCustomerTickets && <form onSubmit={createTicket}>
        <label>{tr("Subject", "主题")}<input aria-label="Ticket subject" value={subject} onChange={(event) => setSubject(event.target.value)} required minLength={3} /></label>
        <label>{tr("Department", "部门")}<select value={departmentCode} onChange={(event) => setDepartmentCode(event.target.value)}>{departments.map((item) => <option key={item.code} value={item.code}>{item.name ?? item.code}</option>)}</select></label>
        <label>{tr("Priority", "优先级")}<select value={priority} onChange={(event) => setPriority(event.target.value as TicketPriority)}>{["low", "normal", "high", "urgent"].map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>{tr("Related Service", "关联服务")}<select aria-label="Related service" value={serviceId} onChange={(event) => setServiceId(event.target.value)}><option value="">{tr("None", "无")}</option>{services.map((item) => <option key={item.id} value={item.id}>{item.productName} · {item.status}</option>)}</select></label>
        <label>{tr("Related Order UUID", "关联订单 UUID")}<input value={orderId} onChange={(event) => setOrderId(event.target.value)} placeholder={tr("Optional", "可选")} /></label>
        <label>{tr("Authorization purpose", "授权用途")}<select value={authorizationPurpose} onChange={(event) => setAuthorizationPurpose(event.target.value)}><option value="">{tr("None", "无")}</option>{["bgp", "remote_hands", "colocation_inbound", "colocation_outbound", "third_party_refund"].map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>{tr("Opening message", "首条消息")}<textarea aria-label="Opening message" value={message} onChange={(event) => setMessage(event.target.value)} required /></label>
        <button className="primary" disabled={pending}>{tr("Create ticket", "创建工单")}</button>
      </form>}
      <div className="ticket-layout"><div className="ticket-list" data-testid="customer-ticket-list">{tickets.map((ticket) => <button key={ticket.id} onClick={() => void openCustomer(ticket.id)}><strong>{ticket.subject}</strong><span>{ticket.status} · {ticket.department.name} · {ticket.priority}</span></button>)}</div>
      {customerDetail && <article className="ticket-thread" data-testid="customer-ticket-thread">
        <h3>{customerDetail.ticket.subject}</h3><p>{customerDetail.ticket.department.name} · {customerDetail.ticket.priority}</p>
        {customerDetail.messages.map((item) => <div key={item.id}><strong>{item.authorType}</strong><p>{item.body}</p></div>)}
        <CustomerHistory detail={customerDetail} locale={locale} />
        <AttachmentList locale={locale} attachments={customerDetail.attachments} canDelete={(item) => canWriteCustomerTickets && item.uploadedByType === "customer"} onDelete={(item) => void deleteCustomerAttachment(item)} onDownload={(item) => void downloadCustomerAttachment(item)} pending={pending} />
        {canWriteCustomerTickets && customerDetail.ticket.status !== "closed" && <><textarea aria-label="Customer ticket reply" value={customerReplyText} onChange={(event) => setCustomerReplyText(event.target.value)} /><button disabled={pending || !customerReplyText.trim()} onClick={() => void customerReply()}>{tr("Send reply", "发送回复")}</button><input aria-label={tr("Customer attachment", "客户附件")} type="file" accept=".txt,.log,.csv,.pdf,.png,.jpg,.jpeg" onChange={(event) => setCustomerAttachment(event.target.files?.[0] ?? null)} /><button disabled={pending || !customerAttachment} onClick={() => void uploadCustomerAttachment()}>{tr("Upload attachment", "上传附件")}</button><button disabled={pending} onClick={() => void setCustomerStatus("closed")}>{tr("Close ticket", "关闭工单")}</button></>}
        {canWriteCustomerTickets && customerDetail.ticket.status === "closed" && <button disabled={pending} onClick={() => void setCustomerStatus("awaiting_staff")}>{tr("Reopen ticket", "重新开启工单")}</button>}
      </article>}</div>
    </section>;
  }

  return <section className="admin-panel support-operations" aria-label="Staff support tickets">
    <p className="eyebrow">{tr("Staff Support workspace", "客服人员工作区")}</p>
    <h2>{tr("Ticket queue", "工单队列")}</h2>
    {staffAccountContext && <p className="notice" data-testid="staff-support-account-context">
      {tr("Fixed Client Account", "已固定客户账户")}: {staffAccountContext.name} · {staffAccountContext.id}
    </p>}
    <fieldset><legend>{tr("Staff reauthentication", "客服人员重新认证")}</legend>
      <p className="muted">{tr(
        "Enter credentials before a protected Support action when no current 15-minute grant is available.",
        "当前没有有效的 15 分钟授权时，请在受保护的客服操作前输入认证信息。",
      )}</p>
      <label>{tr("Support password confirmation", "客服操作密码确认")}<input type="password" autoComplete="current-password" value={staffReauthPassword} onChange={(event) => setStaffReauthPassword(event.target.value)} disabled={pending} /></label>
      <label>{tr("Support TOTP or recovery code", "客服操作 TOTP 或恢复码")}<input autoComplete="one-time-code" value={staffFactorCode} onChange={(event) => setStaffFactorCode(event.target.value)} disabled={pending} /></label>
    </fieldset>
    <fieldset><legend>{tr("Queue filters", "队列筛选")}</legend>
      <label>{tr("Status", "状态")}<select aria-label={tr("Queue status", "队列状态")} value={queueStatus} onChange={(event) => setQueueStatus(event.target.value)}><option value="">{tr("All", "全部")}</option>{["awaiting_staff", "awaiting_customer", "closed"].map((item) => <option key={item}>{item}</option>)}</select></label>
      <label>{tr("Department", "部门")}<select aria-label={tr("Queue department", "队列部门")} value={queueDepartment} onChange={(event) => setQueueDepartment(event.target.value)}><option value="">{tr("All", "全部")}</option>{departments.map((item) => <option key={item.code} value={item.code}>{item.currentRevision?.name ?? item.name ?? item.code}</option>)}</select></label>
      <label>{tr("Priority", "优先级")}<select aria-label={tr("Queue priority", "队列优先级")} value={queuePriority} onChange={(event) => setQueuePriority(event.target.value)}><option value="">{tr("All", "全部")}</option>{["low", "normal", "high", "urgent"].map((item) => <option key={item}>{item}</option>)}</select></label>
      <label>{tr("Assignee", "负责人")}<select aria-label={tr("Queue assignee", "队列负责人")} value={queueAssignee} onChange={(event) => setQueueAssignee(event.target.value)}><option value="">{tr("All", "全部")}</option><option value="unassigned">{tr("Unassigned", "未分配")}</option>{staffOptions.map((item) => <option key={item.id} value={item.id}>{item.email}</option>)}</select></label>
      <button onClick={() => void refreshStaff()}>{tr("Apply filters", "应用筛选")}</button>
    </fieldset>
    <div className="ticket-layout">
      <div className="ticket-list" data-testid="staff-ticket-list">{staffTickets.map((ticket) => <button key={ticket.id} onClick={() => void openStaff(ticket.id)}><strong>{ticket.subject}</strong><span>{ticket.clientAccount.name} · {ticket.status} · {ticket.department.name} · {ticket.priority}</span></button>)}</div>
      {staffDetail && <article className="ticket-thread" data-testid="staff-ticket-thread">
        <h3>{staffDetail.ticket.subject}</h3><p>{staffDetail.ticket.clientAccount.name}</p>
        <label>{tr("Assignee", "负责人")}<select value={assignment} onChange={(event) => setAssignment(event.target.value)}><option value="">{tr("Unassigned", "未分配")}</option>{staffOptions.map((item) => <option key={item.id} value={item.id}>{item.email}</option>)}</select></label>
        <label>{tr("Department", "部门")}<select value={departmentCode} onChange={(event) => setDepartmentCode(event.target.value)}>{departments.map((item) => <option key={item.code} value={item.code}>{item.currentRevision?.name ?? item.name ?? item.code}</option>)}</select></label>
        <label>{tr("Priority", "优先级")}<select value={priority} onChange={(event) => setPriority(event.target.value as TicketPriority)}>{["low", "normal", "high", "urgent"].map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>{tr("Operation reason", "操作原因")}<input value={staffTicketReason} onChange={(event) => setStaffTicketReason(event.target.value)} /></label>
        <button disabled={pending || !staffTicketReason.trim()} onClick={() => void staffMutation(`/api/v1/admin/tickets/${staffDetail.ticket.id}/assignments`, { assignedStaffUserId: assignment || null, reason: staffTicketReason }, tr("Assignment saved.", "分配已保存。"))}>{tr("Save assignment", "保存分配")}</button>
        <button disabled={pending || !staffTicketReason.trim()} onClick={() => void staffMutation(`/api/v1/admin/tickets/${staffDetail.ticket.id}/routing`, { departmentCode, priority, reason: staffTicketReason }, tr("Routing saved.", "路由已保存。"))}>{tr("Save routing", "保存路由")}</button>
        <button disabled={pending || !staffTicketReason.trim()} onClick={() => void staffMutation(`/api/v1/admin/tickets/${staffDetail.ticket.id}/status`, { status: staffDetail.ticket.status === "closed" ? "awaiting_staff" : "closed", reason: staffTicketReason }, tr("Status saved.", "状态已保存。"))}>{staffDetail.ticket.status === "closed" ? tr("Reopen", "重新开启") : tr("Close", "关闭")}</button>
        {staffDetail.messages.map((item) => <div key={item.id} data-visibility={item.visibility}><strong>{item.authorEmail ?? item.authorType} · {item.visibility}</strong><p>{item.body}</p></div>)}
        <textarea aria-label="Staff ticket message" value={staffTicketReplyText} onChange={(event) => setStaffTicketReplyText(event.target.value)} />
        <button disabled={pending || !staffTicketReplyText.trim() || staffDetail.ticket.status === "closed"} onClick={() => void sendStaffMessage("public_reply")}>{tr("Send public reply", "发送公开回复")}</button>
        <button disabled={pending || !staffTicketReplyText.trim() || staffDetail.ticket.status === "closed"} onClick={() => void sendStaffMessage("internal_note")}>{tr("Save internal note", "保存内部备注")}</button>
        <StaffHistory detail={staffDetail} locale={locale} />
        <AttachmentList locale={locale} attachments={staffDetail.attachments} canDelete={() => true} onDelete={(item) => void deleteStaffAttachment(item)} onDownload={(item) => void downloadStaffAttachment(item)} pending={pending} />
        {staffDetail.ticket.status !== "closed" && <><input aria-label={tr("Staff attachment", "客服附件")} type="file" accept=".txt,.log,.csv,.pdf,.png,.jpg,.jpeg" onChange={(event) => setStaffAttachment(event.target.files?.[0] ?? null)} /><button disabled={pending || !staffAttachment} onClick={() => void uploadStaffAttachment()}>{tr("Upload attachment", "上传附件")}</button></>}
      </article>}
    </div>
    <section aria-label={tr("Support departments", "客服部门")}><h3>{tr("Departments", "部门")}</h3>{departments.map((item) => <button key={item.code} onClick={() => editDepartment(item)}>{item.currentRevision?.name ?? item.name ?? item.code}</button>)}
      <form onSubmit={saveDepartment}>
        <label>{tr("Code", "代码")}<input value={departmentEditCode} disabled={Boolean(departmentEditId)} onChange={(event) => setDepartmentEditCode(event.target.value)} required /></label>
        <label>{tr("Name", "名称")}<input value={departmentName} onChange={(event) => setDepartmentName(event.target.value)} required /></label>
        <label>{tr("Description", "说明")}<textarea value={departmentDescription} onChange={(event) => setDepartmentDescription(event.target.value)} /></label>
        <label><input type="checkbox" checked={acceptsAuthenticated} onChange={(event) => setAcceptsAuthenticated(event.target.checked)} />{tr("Authenticated tickets", "登录客户工单")}</label>
        <label><input type="checkbox" checked={acceptsPresales} onChange={(event) => setAcceptsPresales(event.target.checked)} />{tr("Presales", "售前咨询")}</label>
        {departmentEditId && <label>{tr("Revision reason", "修订原因")}<input value={departmentReason} onChange={(event) => setDepartmentReason(event.target.value)} /></label>}
        <button disabled={pending}>{tr("Save immutable revision", "保存不可变修订")}</button>
      </form>
    </section>
    <section aria-label={tr("Staff Presales", "客服人员售前咨询")}><h3>{tr("Presales inquiries", "售前咨询")}</h3><div className="ticket-list">{presales.map((item) => <button key={item.id} onClick={() => void openPresales(item.id)}><strong>{item.subject}</strong><span>{item.visitorEmail} · {item.status}</span></button>)}</div>
      {presalesDetail && <article data-testid="staff-presales-detail">
        <h4>{presalesDetail.inquiry.subject}</h4>
        {presalesDetail.messages.map((item) => <div key={item.id} data-visibility={item.visibility}><strong>{item.authorType} · {item.visibility ?? "public"}</strong><p>{item.body}</p></div>)}
        <label>{tr("Message kind", "消息类型")}<select value={presalesMessageKind} onChange={(event) => setPresalesMessageKind(event.target.value as typeof presalesMessageKind)}><option value="public_reply">{tr("Public reply", "公开回复")}</option><option value="internal_note">{tr("Internal note", "内部备注")}</option></select></label>
        <textarea aria-label={tr("Staff Presales message", "客服售前消息")} value={presalesReplyText} onChange={(event) => setPresalesReplyText(event.target.value)} />
        <button disabled={pending || !presalesReplyText.trim() || presalesDetail.inquiry.status === "closed"} onClick={() => void staffPresalesMessage()}>{tr("Save Presales message", "保存售前消息")}</button>
        <label>{tr("Presales operation reason", "售前操作原因")}<input value={presalesReason} onChange={(event) => setPresalesReason(event.target.value)} /></label>
        <button disabled={pending || !presalesReason.trim()} onClick={() => void setPresalesStatus(presalesDetail.inquiry.status === "closed" ? "awaiting_staff" : "closed")}>{presalesDetail.inquiry.status === "closed" ? tr("Reopen Presales", "重新开启售前咨询") : tr("Close Presales", "关闭售前咨询")}</button>
      </article>}
    </section>
  </section>;
}
