// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const baseUrl = process.env.SUPPORT_NORMAL_BASE_URL;
const customerCookie = process.env.SUPPORT_NORMAL_CUSTOMER_COOKIE;
const otherCustomerCookie = process.env.SUPPORT_NORMAL_OTHER_CUSTOMER_COOKIE;
const staffCookie = process.env.SUPPORT_NORMAL_STAFF_COOKIE;
const accountContextVersion = process.env.SUPPORT_NORMAL_ACCOUNT_CONTEXT_VERSION ?? "1";

if (!baseUrl || !customerCookie || !otherCustomerCookie || !staffCookie) {
  throw new Error(
    "SUPPORT_NORMAL_BASE_URL and the three SUPPORT_NORMAL_*_COOKIE values are required; " +
      "the sessions must be normal verified Customer/Customer/Support Staff sessions, and Staff must have current reauthentication",
  );
}

type ResponseResult<T> = {
  status: number;
  body: T;
  raw: string;
};

async function request<T>(
  path: string,
  input: Readonly<{
    method?: "GET" | "POST" | "DELETE";
    cookie?: string;
    accountScoped?: boolean;
    headers?: Readonly<Record<string, string>>;
    payload?: unknown;
  }> = {},
): Promise<ResponseResult<T>> {
  const response = await fetch(new URL(path, baseUrl), {
    method: input.method ?? "GET",
    headers: {
      ...(input.cookie ? { cookie: input.cookie } : {}),
      ...(input.accountScoped
        ? { "x-oss-account-context-version": accountContextVersion }
        : {}),
      ...(input.payload === undefined ? {} : { "content-type": "application/json" }),
      ...input.headers,
    },
    ...(input.payload === undefined ? {} : { body: JSON.stringify(input.payload) }),
  });
  const raw = await response.text();
  let body: T;
  try {
    body = (raw ? JSON.parse(raw) : null) as T;
  } catch {
    body = raw as T;
  }
  return { status: response.status, body, raw };
}

function expectStatus<T>(response: ResponseResult<T>, expected: number): T {
  assert.equal(response.status, expected, response.raw);
  return response.body;
}

const suffix = randomUUID().slice(0, 8);
const departmentCode = `normal-${suffix}`;
const departmentCreateKey = randomUUID();

const createdDepartment = expectStatus(
  await request<{ id: string }>("/api/v1/admin/support/departments", {
    method: "POST",
    cookie: staffCookie,
    payload: {
      code: departmentCode,
      name: `Normal Support ${suffix}`,
      description: "Ordinary Support and Presales operations",
      acceptsAuthenticated: true,
      acceptsPresales: true,
      idempotencyKey: departmentCreateKey,
    },
  }),
  201,
);

const created = expectStatus(
  await request<{
    ticket: { id: string; status: string; priority: string };
    messages: Array<{ id: string }>;
    statusHistory: Array<{ status: string }>;
    routingHistory: Array<{ department: { code: string }; summary: string }>;
  }>("/api/v1/tickets", {
    method: "POST",
    cookie: customerCookie,
    accountScoped: true,
    payload: {
      subject: `Normal Support lifecycle ${suffix}`,
      message: "Ordinary opening message for Support operations.",
      departmentCode,
      priority: "high",
      idempotencyKey: randomUUID(),
    },
  }),
  201,
);
const ticketId = created.ticket.id;
const openingMessageId = created.messages[0]?.id;
assert.ok(openingMessageId);
assert.equal(created.ticket.status, "awaiting_staff");
assert.equal(created.ticket.priority, "high");
assert.deepEqual(created.statusHistory.map((event) => event.status), ["awaiting_staff"]);
assert.deepEqual(
  created.routingHistory.map((event) => [event.summary, event.department.code]),
  [["Initial Support routing", departmentCode]],
);

expectStatus(
  await request(`/api/v1/tickets/${ticketId}`, {
    cookie: otherCustomerCookie,
    accountScoped: true,
  }),
  404,
);

const unassignedQueue = expectStatus(
  await request<{ items: Array<{ id: string }> }>(
    `/api/v1/admin/tickets?status=awaiting_staff&department=${departmentCode}&priority=high&assignee=unassigned`,
    { cookie: staffCookie },
  ),
  200,
);
assert.equal(unassignedQueue.items.some((ticket) => ticket.id === ticketId), true);

const customerIdentity = expectStatus(
  await request<{ clientAccountId: string }>("/api/v1/auth/me", { cookie: customerCookie }),
  200,
);
const otherCustomerIdentity = expectStatus(
  await request<{ clientAccountId: string }>("/api/v1/auth/me", { cookie: otherCustomerCookie }),
  200,
);
const accountScopedQueue = expectStatus(
  await request<{ items: Array<{ id: string }> }>(
    `/api/v1/admin/tickets?clientAccountId=${encodeURIComponent(customerIdentity.clientAccountId)}`,
    { cookie: staffCookie },
  ),
  200,
);
assert.equal(accountScopedQueue.items.some((ticket) => ticket.id === ticketId), true);
const otherAccountQueue = expectStatus(
  await request<{ items: Array<{ id: string }> }>(
    `/api/v1/admin/tickets?clientAccountId=${encodeURIComponent(otherCustomerIdentity.clientAccountId)}`,
    { cookie: staffCookie },
  ),
  200,
);
assert.equal(otherAccountQueue.items.some((ticket) => ticket.id === ticketId), false);

const staffOptions = expectStatus(
  await request<{ items: Array<{ id: string; email: string }> }>(
    "/api/v1/admin/tickets/staff-options",
    { cookie: staffCookie },
  ),
  200,
);
const assignee = staffOptions.items[0];
assert.ok(assignee, "at least one eligible Support Staff option is required");

const assignmentKey = randomUUID();
const assignmentPayload = {
  assignedStaffUserId: assignee.id,
  reason: "Take the ordinary Support case",
  idempotencyKey: assignmentKey,
};
expectStatus(
  await request(`/api/v1/admin/tickets/${ticketId}/assignments`, {
    method: "POST",
    cookie: staffCookie,
    payload: assignmentPayload,
  }),
  201,
);
expectStatus(
  await request(`/api/v1/admin/tickets/${ticketId}/assignments`, {
    method: "POST",
    cookie: staffCookie,
    payload: assignmentPayload,
  }),
  200,
);
const routingKey = randomUUID();
const routingPayload = {
  departmentCode,
  priority: "urgent",
  reason: "Route the ordinary case to the selected department",
  idempotencyKey: routingKey,
};
expectStatus(
  await request(`/api/v1/admin/tickets/${ticketId}/routing`, {
    method: "POST",
    cookie: staffCookie,
    payload: routingPayload,
  }),
  201,
);
expectStatus(
  await request(`/api/v1/admin/tickets/${ticketId}/routing`, {
    method: "POST",
    cookie: staffCookie,
    payload: routingPayload,
  }),
  200,
);

expectStatus(
  await request(`/api/v1/admin/tickets/${ticketId}/messages`, {
    method: "POST",
    cookie: staffCookie,
    payload: {
      kind: "internal_note",
      message: "Internal handling note for Staff only.",
      idempotencyKey: randomUUID(),
    },
  }),
  201,
);

const publicReplyIdempotencyKey = randomUUID();
const publicReplyPayload = {
  kind: "public_reply",
  message: "A normal public Support reply for the customer.",
  idempotencyKey: publicReplyIdempotencyKey,
};
expectStatus(
  await request(`/api/v1/admin/tickets/${ticketId}/messages`, {
    method: "POST",
    cookie: staffCookie,
    payload: publicReplyPayload,
  }),
  201,
);
expectStatus(
  await request(`/api/v1/admin/tickets/${ticketId}/messages`, {
    method: "POST",
    cookie: staffCookie,
    payload: publicReplyPayload,
  }),
  200,
);
expectStatus(
  await request(`/api/v1/admin/tickets/${ticketId}/messages`, {
    method: "POST",
    cookie: staffCookie,
    payload: {
      ...publicReplyPayload,
      message: "A different reply must not reuse the same idempotency key.",
    },
  }),
  409,
);

const customerAfterStaff = expectStatus(
  await request<{
    ticket: { status: string };
    messages: Array<{ id: string; body: string }>;
    statusHistory: Array<Record<string, unknown>>;
    routingHistory: Array<Record<string, unknown>>;
  }>(`/api/v1/tickets/${ticketId}`, {
    cookie: customerCookie,
    accountScoped: true,
  }),
  200,
);
assert.equal(customerAfterStaff.ticket.status, "awaiting_customer");
assert.equal(
  customerAfterStaff.messages.filter((message) => message.id === publicReplyIdempotencyKey).length,
  1,
);
assert.equal(
  customerAfterStaff.messages.some((message) => message.body.includes("Internal handling")),
  false,
);
for (const event of [...customerAfterStaff.statusHistory, ...customerAfterStaff.routingHistory]) {
  assert.equal(Object.hasOwn(event, "actorUserId"), false);
  assert.equal(Object.hasOwn(event, "actorEmail"), false);
  assert.equal(Object.hasOwn(event, "reason"), false);
}

const deliveries = expectStatus(
  await request<{
    items: Array<{ eventType: string; templateRevision: string }>;
  }>("/api/v1/customer/notification-deliveries?limit=100", {
    cookie: customerCookie,
    accountScoped: true,
  }),
  200,
);
assert.equal(
  deliveries.items.filter(
    (item) =>
      item.eventType === "notification.support_ticket_reply_requested" &&
      item.templateRevision === "support-ticket-reply-v1",
  ).length,
  1,
);

const customerReplyIdempotencyKey = randomUUID();
const customerReplyPayload = {
  message: "The customer provides a normal follow-up.",
  idempotencyKey: customerReplyIdempotencyKey,
};
expectStatus(
  await request(`/api/v1/tickets/${ticketId}/replies`, {
    method: "POST",
    cookie: customerCookie,
    accountScoped: true,
    payload: customerReplyPayload,
  }),
  201,
);
expectStatus(
  await request(`/api/v1/tickets/${ticketId}/replies`, {
    method: "POST",
    cookie: customerCookie,
    accountScoped: true,
    payload: customerReplyPayload,
  }),
  200,
);

const attachmentContent = Buffer.from("ordinary synthetic Support attachment\n", "utf8");
const attachmentKey = randomUUID();
const attachmentPayload = {
  filename: "ordinary-support.txt",
  contentType: "text/plain",
  contentBase64: attachmentContent.toString("base64"),
  idempotencyKey: attachmentKey,
};
const uploaded = expectStatus(
  await request<{ id: string }>(
    `/api/v1/tickets/${ticketId}/messages/${openingMessageId}/attachments`,
    {
      method: "POST",
      cookie: customerCookie,
      accountScoped: true,
      payload: attachmentPayload,
    },
  ),
  201,
);
const attachmentId = uploaded.id;
const replayedUpload = expectStatus(
  await request<{ id: string }>(
    `/api/v1/tickets/${ticketId}/messages/${openingMessageId}/attachments`,
    {
      method: "POST",
      cookie: customerCookie,
      accountScoped: true,
      payload: attachmentPayload,
    },
  ),
  200,
);
assert.equal(replayedUpload.id, attachmentId);
const detailWithAttachment = expectStatus(
  await request<{ attachments: Array<{ id: string; filename: string }> }>(
    `/api/v1/tickets/${ticketId}`,
    { cookie: customerCookie, accountScoped: true },
  ),
  200,
);
assert.equal(
  detailWithAttachment.attachments.some(
    (item) => item.id === attachmentId && item.filename === "ordinary-support.txt",
  ),
  true,
);
expectStatus(
  await request(`/api/v1/tickets/${ticketId}/attachments/${attachmentId}`, {
    method: "DELETE",
    cookie: otherCustomerCookie,
    accountScoped: true,
    payload: { idempotencyKey: randomUUID() },
  }),
  404,
);
expectStatus(
  await request(`/api/v1/tickets/${ticketId}/attachments/${attachmentId}`, {
    method: "DELETE",
    cookie: customerCookie,
    accountScoped: true,
    payload: { idempotencyKey: randomUUID() },
  }),
  204,
);
expectStatus(
  await request(`/api/v1/tickets/${ticketId}/attachments/${attachmentId}`, {
    method: "DELETE",
    cookie: customerCookie,
    accountScoped: true,
    payload: { idempotencyKey: randomUUID() },
  }),
  204,
);

const closePayload = {
  status: "closed",
  reason: "Staff completed the ordinary Support case",
  idempotencyKey: randomUUID(),
};
expectStatus(
  await request(`/api/v1/admin/tickets/${ticketId}/status`, {
    method: "POST",
    cookie: staffCookie,
    payload: closePayload,
  }),
  201,
);
const onceClosed = expectStatus(
  await request<{
    statusHistory: Array<{ id: string }>;
  }>(`/api/v1/admin/tickets/${ticketId}`, { cookie: staffCookie }),
  200,
);
expectStatus(
  await request(`/api/v1/admin/tickets/${ticketId}/status`, {
    method: "POST",
    cookie: staffCookie,
    payload: closePayload,
  }),
  200,
);
const twiceClosed = expectStatus(
  await request<{
    statusHistory: Array<{ id: string }>;
  }>(`/api/v1/admin/tickets/${ticketId}`, { cookie: staffCookie }),
  200,
);
assert.equal(twiceClosed.statusHistory.length, onceClosed.statusHistory.length);

expectStatus(
  await request(`/api/v1/tickets/${ticketId}/status`, {
    method: "POST",
    cookie: customerCookie,
    accountScoped: true,
    payload: {
      status: "awaiting_staff",
      reason: "Customer needs the case reopened",
      idempotencyKey: randomUUID(),
    },
  }),
  201,
);

const completeHistory = expectStatus(
  await request<{
    ticket: { status: string; assignedStaffUserId: string };
    statusHistory: Array<{ status: string }>;
    assignmentHistory: Array<{ sequence: number; assignedStaffUserId: string | null }>;
    routingHistory: Array<{ sequence: number; priority: string; department: { code: string } }>;
  }>(`/api/v1/admin/tickets/${ticketId}`, { cookie: staffCookie }),
  200,
);
assert.equal(completeHistory.ticket.status, "awaiting_staff");
assert.equal(completeHistory.ticket.assignedStaffUserId, assignee.id);
assert.deepEqual(completeHistory.assignmentHistory.map((event) => event.sequence), [0, 1]);
assert.deepEqual(completeHistory.routingHistory.map((event) => event.sequence), [0, 1]);
assert.equal(completeHistory.routingHistory[1]?.priority, "urgent");

expectStatus(
  await request(
    `/api/v1/admin/support/departments/${createdDepartment.id}/revisions`,
    {
      method: "POST",
      cookie: staffCookie,
      payload: {
        name: `Normal Support Revised ${suffix}`,
        description: "A later immutable ordinary Support department revision",
        acceptsAuthenticated: true,
        acceptsPresales: true,
        reason: "Exercise normal department revision history",
        idempotencyKey: randomUUID(),
      },
    },
  ),
  201,
);
const immutableRouteHistory = expectStatus(
  await request<{
    routingHistory: Array<{ department: { name: string; revision: number } }>;
  }>(`/api/v1/admin/tickets/${ticketId}`, { cookie: staffCookie }),
  200,
);
assert.equal(immutableRouteHistory.routingHistory[1]?.department.revision, 1);
assert.equal(immutableRouteHistory.routingHistory[1]?.department.name, `Normal Support ${suffix}`);

const inquiry = expectStatus(
  await request<{ inquiryId: string; accessToken: string }>("/api/v1/presales/inquiries", {
    method: "POST",
    payload: {
      visitorName: "Normal Visitor",
      visitorEmail: `normal-${suffix}@example.invalid`,
      topic: "product_question",
      subject: `Normal Presales inquiry ${suffix}`,
      message: "An ordinary Presales product question.",
      departmentCode,
      idempotencyKey: randomUUID(),
    },
  }),
  201,
);
const presalesHeaders = { "x-oss-presales-token": inquiry.accessToken };
expectStatus(
  await request(`/api/v1/presales/inquiries/${inquiry.inquiryId}/replies`, {
    method: "POST",
    headers: presalesHeaders,
    payload: { message: "An ordinary visitor follow-up.", idempotencyKey: randomUUID() },
  }),
  201,
);
expectStatus(
  await request(`/api/v1/admin/presales/inquiries/${inquiry.inquiryId}/messages`, {
    method: "POST",
    cookie: staffCookie,
    payload: {
      kind: "internal_note",
      message: "Private Presales handling note.",
      idempotencyKey: randomUUID(),
    },
  }),
  201,
);
expectStatus(
  await request(`/api/v1/admin/presales/inquiries/${inquiry.inquiryId}/messages`, {
    method: "POST",
    cookie: staffCookie,
    payload: {
      kind: "public_reply",
      message: "A normal public Presales response.",
      idempotencyKey: randomUUID(),
    },
  }),
  201,
);
const visitorView = expectStatus(
  await request<{
    inquiry: { status: string };
    messages: Array<{ body: string }>;
  }>(`/api/v1/presales/inquiries/${inquiry.inquiryId}`, { headers: presalesHeaders }),
  200,
);
assert.equal(visitorView.inquiry.status, "awaiting_visitor");
assert.equal(
  visitorView.messages.some((item) => item.body === "Private Presales handling note."),
  false,
);
assert.equal(
  visitorView.messages.some((item) => item.body === "A normal public Presales response."),
  true,
);

process.stdout.write("Support operations normal public-API integration: PASS\n");
