// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Page, type Route } from "@playwright/test";

const accountId = "10000000-0000-4000-8000-000000000001";
const ticketId = "20000000-0000-4000-8000-000000000001";
const customerMessageId = "30000000-0000-4000-8000-000000000001";
const staffMessageId = "30000000-0000-4000-8000-000000000002";
const attachmentId = "40000000-0000-4000-8000-000000000001";
const staffId = "50000000-0000-4000-8000-000000000001";
const departmentId = "60000000-0000-4000-8000-000000000001";
const inquiryId = "70000000-0000-4000-8000-000000000001";
const occurredAt = "2026-08-20T03:00:00.000Z";

const sessionHeaders = {
  "X-OSS-Account-Context-Version": "1",
  "X-OSS-Authorization-Epoch": "1",
};
const accountHeaders = {
  ...sessionHeaders,
  "X-OSS-Client-Account-Id": accountId,
};

const department = {
  id: departmentId,
  code: "general-support",
  revision: 1,
  name: "General Support",
  description: "Ordinary Support",
  acceptsAuthenticated: true,
  acceptsPresales: true,
  currentRevision: {
    id: "60000000-0000-4000-8000-000000000002",
    revision: 1,
    name: "General Support",
    description: "Ordinary Support",
    acceptsAuthenticated: true,
    acceptsPresales: true,
    createdAt: occurredAt,
  },
};

const ticket = {
  id: ticketId,
  subject: "Ordinary browser Support request",
  status: "awaiting_staff",
  service: null,
  orderId: null,
  authorizationPurpose: null,
  department: { code: department.code, name: department.name },
  priority: "high",
  publicMessageCount: 1,
  createdAt: occurredAt,
  updatedAt: occurredAt,
};

function customerDetail(attachmentVisible = true) {
  return {
    ticket,
    messages: [{
      id: customerMessageId,
      authorType: "customer",
      body: "Ordinary customer message",
      createdAt: occurredAt,
    }],
    attachments: attachmentVisible ? [{
      id: attachmentId,
      messageId: customerMessageId,
      filename: "ordinary.txt",
      contentType: "text/plain",
      sizeBytes: 18,
      uploadedByType: "customer",
      createdAt: occurredAt,
    }] : [],
    statusHistory: [{
      previousStatus: null,
      status: "awaiting_staff",
      summary: "Ticket created",
      occurredAt,
    }],
    routingHistory: [{
      department: { code: department.code, name: department.name, revision: 1 },
      priority: "high",
      summary: "Initial Support routing",
      occurredAt,
    }],
  };
}

function staffDetail() {
  return {
    ...customerDetail(),
    ticket: {
      ...ticket,
      assignedStaffUserId: staffId,
      clientAccount: { id: accountId, name: "Ordinary Customer" },
      internalMessageCount: 1,
    },
    messages: [
      {
        id: customerMessageId,
        authorType: "customer",
        visibility: "public",
        authorEmail: "customer@example.invalid",
        body: "Ordinary customer message",
        createdAt: occurredAt,
      },
      {
        id: staffMessageId,
        authorType: "staff",
        visibility: "internal",
        authorEmail: "support@example.invalid",
        body: "Staff-only browser note",
        createdAt: occurredAt,
      },
    ],
    statusHistory: [{
      id: "80000000-0000-4000-8000-000000000001",
      previousStatus: null,
      status: "awaiting_staff",
      actorType: "customer",
      actorEmail: "customer@example.invalid",
      reason: "Customer created the ticket",
      occurredAt,
    }],
    assignmentHistory: [
      {
        id: ticketId,
        assignedStaffUserId: null,
        assignedStaffEmail: null,
        actorType: "customer",
        actorEmail: "customer@example.invalid",
        sequence: 0,
        reason: "Ticket created unassigned",
        occurredAt,
      },
      {
        id: "80000000-0000-4000-8000-000000000002",
        assignedStaffUserId: staffId,
        assignedStaffEmail: "support@example.invalid",
        actorType: "staff",
        actorEmail: "support@example.invalid",
        sequence: 1,
        reason: "Take ownership",
        occurredAt,
      },
    ],
    routingHistory: [{
      id: ticketId,
      department: { code: department.code, name: department.name, revision: 1 },
      priority: "high",
      actorType: "customer",
      actorEmail: "customer@example.invalid",
      sequence: 0,
      reason: "Customer selected the initial route",
      occurredAt,
    }],
  };
}

function presalesDetail(staff: boolean) {
  return {
    inquiry: {
      id: inquiryId,
      visitorName: "Ordinary Visitor",
      visitorEmail: "visitor@example.invalid",
      topic: "product_question",
      subject: "Ordinary product question",
      status: "awaiting_staff",
      departmentName: department.name,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    },
    messages: [
      {
        id: "90000000-0000-4000-8000-000000000001",
        authorType: "visitor",
        ...(staff ? { visibility: "public" } : {}),
        body: "Ordinary visitor message",
        createdAt: occurredAt,
      },
      ...(staff ? [{
        id: "90000000-0000-4000-8000-000000000002",
        authorType: "staff",
        visibility: "internal",
        body: "Private Presales note",
        createdAt: occurredAt,
      }] : []),
    ],
  };
}

async function fulfill(route: Route, json: unknown, accountScoped = false) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: accountScoped ? accountHeaders : sessionHeaders,
    body: JSON.stringify(json),
  });
}

async function routeCustomer(page: Page) {
  let attachmentVisible = true;
  let uploadedAttachmentVisible = false;
  let currentStatus = ticket.status;
  const customerMessages = [...customerDetail().messages];
  const postedBodies: Array<Record<string, unknown>> = [];
  const currentDetail = () => ({
    ...customerDetail(attachmentVisible),
    ticket: { ...ticket, status: currentStatus },
    messages: customerMessages,
    attachments: [
      ...(attachmentVisible ? customerDetail(true).attachments : []),
      ...(uploadedAttachmentVisible ? [{
        id: "40000000-0000-4000-8000-000000000002",
        messageId: customerMessages.at(-1)?.id ?? customerMessageId,
        filename: "customer-upload.txt",
        contentType: "text/plain",
        sizeBytes: 21,
        uploadedByType: "customer",
        createdAt: occurredAt,
      }] : []),
    ],
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/v1/tickets") {
      return fulfill(route, { items: [ticket] }, true);
    }
    if (request.method() === "GET" && url.pathname === "/api/v1/tickets/service-options") {
      return fulfill(route, { items: [] }, true);
    }
    if (request.method() === "GET" && url.pathname === "/api/v1/support/departments") {
      return fulfill(route, { items: [department] }, true);
    }
    if (request.method() === "GET" && url.pathname === `/api/v1/tickets/${ticketId}`) {
      return fulfill(route, currentDetail(), true);
    }
    if (request.method() === "POST" && url.pathname.endsWith("/replies")) {
      const body = request.postDataJSON() as Record<string, unknown>;
      postedBodies.push(body);
      customerMessages.push({
        id: "30000000-0000-4000-8000-000000000003",
        authorType: "customer",
        body: String(body.message),
        createdAt: occurredAt,
      });
      return fulfill(route, currentDetail(), true);
    }
    if (request.method() === "POST" && url.pathname.endsWith("/attachments")) {
      const body = request.postDataJSON() as Record<string, unknown>;
      postedBodies.push(body);
      uploadedAttachmentVisible = true;
      return fulfill(route, { id: "40000000-0000-4000-8000-000000000002" }, true);
    }
    if (request.method() === "DELETE" && url.pathname.includes("/attachments/")) {
      const body = request.postDataJSON() as Record<string, unknown>;
      postedBodies.push(body);
      if (url.pathname.endsWith(attachmentId)) attachmentVisible = false;
      else uploadedAttachmentVisible = false;
      return route.fulfill({ status: 204, headers: accountHeaders, body: "" });
    }
    if (request.method() === "POST" && url.pathname.endsWith("/status")) {
      const body = request.postDataJSON() as Record<string, unknown>;
      postedBodies.push(body);
      currentStatus = body.status as typeof currentStatus;
      return fulfill(route, { ticketId, status: currentStatus }, true);
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  return { postedBodies };
}

test("customer Support component shows fields, immutable history, ordinary attachments, close and reopen controls", async ({ page }) => {
  const observed = await routeCustomer(page);
  await page.goto("/support-operations-harness.html?mode=customer");
  const panel = page.getByRole("region", { name: "Customer support tickets" });
  await expect(
    panel.getByRole("heading", { name: "My support tickets", exact: true }),
  ).toBeVisible();
  await expect(panel.getByLabel("Department")).toBeVisible();
  await expect(panel.getByLabel("Priority")).toBeVisible();
  await expect(panel.getByLabel("Related Service")).toBeVisible();
  await expect(panel.getByLabel("Related Order UUID")).toBeVisible();
  await expect(panel.getByLabel("Authorization purpose")).toBeVisible();
  await panel.getByRole("button", { name: /Ordinary browser Support request/ }).click();
  const detail = panel.getByTestId("customer-ticket-thread");
  await expect(detail.getByTestId("support-ticket-history")).toContainText("Ticket created");
  await expect(detail.getByTestId("support-ticket-history")).not.toContainText("customer@example.invalid");
  await expect(detail).toContainText("ordinary.txt");
  await expect(detail.getByTestId("support-download-unavailable")).toBeVisible();
  await expect(detail.getByRole("link")).toHaveCount(0);
  await detail.getByRole("button", { name: "Delete" }).click();
  await expect(detail).not.toContainText("ordinary.txt");
  await detail.getByLabel("Customer ticket reply").fill("Customer browser reply");
  await detail.getByRole("button", { name: "Send reply" }).click();
  await expect(detail).toContainText("Customer browser reply");
  await detail.getByLabel("Customer attachment").setInputFiles({
    name: "customer-upload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("ordinary upload bytes"),
  });
  await detail.getByRole("button", { name: "Upload attachment" }).click();
  await expect(detail).toContainText("customer-upload.txt");
  expect(observed.postedBodies.every((body) => typeof body.idempotencyKey === "string")).toBe(true);
  await expect(detail.getByRole("button", { name: "Close ticket" })).toBeVisible();
});

test("Staff Support component filters, assigns, routes, separates internal notes, and exposes department and Presales operations", async ({ page }) => {
  const observedQueueUrls: string[] = [];
  const postedPaths: string[] = [];
  const postedBodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  let assignmentAttempts = 0;
  let staffAttachmentVisible = false;
  const staffMessages = [...staffDetail().messages];
  const presalesMessages = [...presalesDetail(true).messages];
  const currentStaffDetail = () => ({
    ...staffDetail(),
    messages: staffMessages,
    attachments: [
      ...staffDetail().attachments,
      ...(staffAttachmentVisible ? [{
        id: "40000000-0000-4000-8000-000000000003",
        messageId: staffMessages.at(-1)?.id ?? staffMessageId,
        filename: "staff-upload.txt",
        contentType: "text/plain",
        sizeBytes: 19,
        uploadedByType: "staff",
        createdAt: occurredAt,
      }] : []),
    ],
  });
  const currentPresalesDetail = () => ({
    ...presalesDetail(true),
    messages: presalesMessages,
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/v1/admin/tickets") {
      observedQueueUrls.push(url.href);
      return fulfill(route, { items: [{ ...staffDetail().ticket }] });
    }
    if (request.method() === "GET" && url.pathname === "/api/v1/admin/tickets/staff-options") {
      return fulfill(route, { items: [{ id: staffId, email: "support@example.invalid", roles: ["Support"] }] });
    }
    if (request.method() === "GET" && url.pathname === "/api/v1/admin/support/departments") {
      return fulfill(route, { items: [department] });
    }
    if (request.method() === "GET" && url.pathname === "/api/v1/admin/presales/inquiries") {
      return fulfill(route, { items: [presalesDetail(true).inquiry] });
    }
    if (request.method() === "GET" && url.pathname === `/api/v1/admin/tickets/${ticketId}`) {
      return fulfill(route, currentStaffDetail());
    }
    if (request.method() === "GET" && url.pathname === `/api/v1/admin/presales/inquiries/${inquiryId}`) {
      return fulfill(route, currentPresalesDetail());
    }
    if (request.method() === "DELETE" && url.pathname.includes("/attachments/")) {
      const body = request.postDataJSON() as Record<string, unknown>;
      postedBodies.push({ path: url.pathname, body });
      staffAttachmentVisible = false;
      return route.fulfill({ status: 204, headers: sessionHeaders, body: "" });
    }
    if (request.method() === "POST") {
      postedPaths.push(url.pathname);
      const body = request.postDataJSON() as Record<string, unknown>;
      postedBodies.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/assignments")) {
        assignmentAttempts += 1;
        if (assignmentAttempts === 1) {
          return route.fulfill({
            status: 403,
            contentType: "application/json",
            headers: sessionHeaders,
            body: JSON.stringify({ error: "Reauthentication required", code: "REAUTH_REQUIRED" }),
          });
        }
      }
      if (url.pathname === `/api/v1/admin/tickets/${ticketId}/messages`) {
        staffMessages.push({
          id: "30000000-0000-4000-8000-000000000004",
          authorType: "staff",
          visibility: body.kind === "internal_note" ? "internal" : "public",
          authorEmail: "support@example.invalid",
          body: String(body.message),
          createdAt: occurredAt,
        });
        return fulfill(route, currentStaffDetail());
      }
      if (url.pathname.endsWith("/attachments")) {
        staffAttachmentVisible = true;
        return fulfill(route, { id: "40000000-0000-4000-8000-000000000003" });
      }
      if (url.pathname === `/api/v1/admin/presales/inquiries/${inquiryId}/messages`) {
        presalesMessages.push({
          id: "90000000-0000-4000-8000-000000000003",
          authorType: "staff",
          visibility: body.kind === "internal_note" ? "internal" : "public",
          body: String(body.message),
          createdAt: occurredAt,
        });
      }
      return route.fulfill({ status: 201, contentType: "application/json", headers: sessionHeaders, body: "{}" });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.goto("/support-operations-harness.html?mode=staff");
  const panel = page.getByRole("region", { name: "Staff support tickets" });
  await panel.getByLabel("Queue status").selectOption("awaiting_staff");
  await panel.getByLabel("Queue department").selectOption(department.code);
  await panel.getByLabel("Queue priority").selectOption("high");
  await panel.getByLabel("Queue assignee").selectOption(staffId);
  await panel.getByRole("button", { name: "Apply filters" }).click();
  await expect.poll(() => observedQueueUrls.some((url) =>
    url.includes("status=awaiting_staff") &&
    url.includes("department=general-support") &&
    url.includes("priority=high") &&
    url.includes(`assignee=${staffId}`),
  )).toBe(true);

  await panel.getByTestId("staff-ticket-list").getByRole("button", { name: /Ordinary browser/ }).click();
  const detail = panel.getByTestId("staff-ticket-thread");
  await expect(detail.getByTestId("support-ticket-history")).toContainText("Assignment");
  await expect(detail.getByTestId("support-ticket-history")).toContainText("Take ownership");
  await expect(detail.locator('[data-visibility="internal"]')).toContainText("Staff-only browser note");
  await detail.getByLabel("Operation reason").fill("Normal browser assignment update");
  await detail.getByRole("button", { name: "Save assignment" }).click();
  await expect(page.getByLabel("Support error")).toContainText("Reauthentication required");
  const saveAssignment = detail.getByRole("button", { name: "Save assignment" });
  await expect(saveAssignment).toBeEnabled();
  await saveAssignment.click();
  await expect.poll(() => postedBodies.filter((item) => item.path.endsWith("/assignments")).length).toBe(2);
  const assignmentBodies = postedBodies.filter((item) => item.path.endsWith("/assignments"));
  expect(assignmentBodies).toHaveLength(2);
  expect(assignmentBodies[0]?.body.idempotencyKey).toBe(assignmentBodies[1]?.body.idempotencyKey);
  await detail.getByLabel("Operation reason").fill("Normal browser routing update");
  await detail.getByRole("button", { name: "Save routing" }).click();
  await expect.poll(() => postedPaths).toContain(`/api/v1/admin/tickets/${ticketId}/assignments`);
  await expect.poll(() => postedPaths).toContain(`/api/v1/admin/tickets/${ticketId}/routing`);

  await detail.getByLabel("Staff ticket message").fill("Staff browser public reply");
  await detail.getByRole("button", { name: "Send public reply" }).click();
  await expect(detail).toContainText("Staff browser public reply");
  await detail.getByLabel("Staff attachment").setInputFiles({
    name: "staff-upload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("staff upload bytes"),
  });
  await detail.getByRole("button", { name: "Upload attachment" }).click();
  await expect(detail).toContainText("staff-upload.txt");
  await detail.getByRole("button", { name: "Delete" }).last().click();
  await expect(detail).not.toContainText("staff-upload.txt");

  const departments = page.getByRole("region", { name: "Support departments" });
  await expect(departments.getByRole("button", { name: "General Support" })).toBeVisible();
  await departments.getByRole("button", { name: "General Support" }).click();
  await departments.getByLabel("Revision reason").fill("Normal browser department revision");
  await departments.getByRole("button", { name: "Save immutable revision" }).click();
  await expect.poll(() => postedPaths).toContain(`/api/v1/admin/support/departments/${departmentId}/revisions`);

  await detail.getByLabel("Staff ticket message").fill("Ticket-only unsent draft");
  const staffPresales = page.getByRole("region", { name: "Staff Presales" });
  await staffPresales.getByRole("button", { name: /Ordinary product question/ }).click();
  await expect(staffPresales.getByTestId("staff-presales-detail")).toContainText("Private Presales note");
  await expect(staffPresales.getByLabel("Staff Presales message")).toHaveValue("");
  await staffPresales.getByLabel("Staff Presales message").fill("Staff browser Presales reply");
  await staffPresales.getByRole("button", { name: "Save Presales message" }).click();
  await expect(staffPresales).toContainText("Staff browser Presales reply");
  expect(postedBodies.filter((item) => item.path.endsWith("/messages"))
    .every((item) => typeof item.body.idempotencyKey === "string")).toBe(true);
});

test("visitor Presales component stays separate and retains only its bearer-scoped public thread", async ({ page }) => {
  const createBodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/v1/support/departments") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [department] }) });
    }
    if (request.method() === "POST" && url.pathname === "/api/v1/presales/inquiries") {
      createBodies.push(request.postDataJSON() as Record<string, unknown>);
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ inquiryId, accessToken: "a".repeat(43), status: "awaiting_staff" }),
      });
    }
    if (request.method() === "GET" && url.pathname === `/api/v1/presales/inquiries/${inquiryId}`) {
      expect(request.headers()["x-oss-presales-token"]).toBe("a".repeat(43));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(presalesDetail(false)) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.goto("/support-operations-harness.html?mode=visitor");
  const panel = page.getByRole("region", { name: "Visitor Presales" });
  await panel.getByLabel("Name").fill("Ordinary Visitor");
  await panel.getByLabel("Email").fill("visitor@example.invalid");
  await panel.getByLabel("Subject").fill("Ordinary product question");
  await panel.getByLabel("Message").fill("Ordinary visitor message");
  await panel.getByRole("button", { name: "Submit inquiry" }).click();
  const thread = panel.getByTestId("visitor-presales-thread");
  await expect(thread).toContainText("Ordinary visitor message");
  await expect(thread).not.toContainText("Private Presales note");
  expect(typeof createBodies[0]?.idempotencyKey).toBe("string");
});

test("committed mutation survives refresh failure and an ambiguous retry reuses exactly one intent key", async ({ page }) => {
  const replyKeys: string[] = [];
  const committedKeys = new Set<string>();
  const messages = [...customerDetail(false).messages];
  let failNextQueueRefresh = false;
  const detail = () => ({ ...customerDetail(false), messages });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/v1/tickets") {
      if (failNextQueueRefresh) {
        failNextQueueRefresh = false;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          headers: accountHeaders,
          body: JSON.stringify({ error: "Temporary refresh failure" }),
        });
      }
      return fulfill(route, { items: [ticket] }, true);
    }
    if (request.method() === "GET" && url.pathname === "/api/v1/tickets/service-options") {
      return fulfill(route, { items: [] }, true);
    }
    if (request.method() === "GET" && url.pathname === "/api/v1/support/departments") {
      return fulfill(route, { items: [department] }, true);
    }
    if (request.method() === "GET" && url.pathname === `/api/v1/tickets/${ticketId}`) {
      return fulfill(route, detail(), true);
    }
    if (request.method() === "POST" && url.pathname.endsWith("/replies")) {
      const body = request.postDataJSON() as { message: string; idempotencyKey: string };
      replyKeys.push(body.idempotencyKey);
      if (!committedKeys.has(body.idempotencyKey)) {
        committedKeys.add(body.idempotencyKey);
        messages.push({
          id: body.idempotencyKey,
          authorType: "customer",
          body: body.message,
          createdAt: occurredAt,
        });
      }
      if (replyKeys.length === 1) return route.abort("connectionreset");
      if (replyKeys.length === 2) failNextQueueRefresh = true;
      return fulfill(route, detail(), true);
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.goto("/support-operations-harness.html?mode=customer");
  const panel = page.getByRole("region", { name: "Customer support tickets" });
  await panel.getByRole("button", { name: /Ordinary browser Support request/ }).click();
  const reply = panel.getByLabel("Customer ticket reply");
  await reply.fill("Committed exactly once");
  await panel.getByRole("button", { name: "Send reply" }).click();
  await expect(page.getByLabel("Support error")).not.toHaveText("");
  await expect(reply).toHaveValue("Committed exactly once");
  await panel.getByRole("button", { name: "Send reply" }).click();
  await expect(page.getByLabel("Support notice")).toContainText("change was committed");
  await expect(reply).toHaveValue("");
  expect(replyKeys[0]).toBe(replyKeys[1]);

  await reply.fill("A new intent");
  await panel.getByRole("button", { name: "Send reply" }).click();
  await expect(reply).toHaveValue("");
  expect(replyKeys[2]).not.toBe(replyKeys[1]);
  expect(messages.filter((item) => item.body === "Committed exactly once")).toHaveLength(1);
});

test("Staff without Support management capability renders nothing and sends no API GET", async ({ page }) => {
  let requestCount = 0;
  await page.route("**/api/v1/**", async (route) => {
    requestCount += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  });
  await page.goto("/support-operations-harness.html?mode=staff&manage=0");
  await expect(page.locator("#support-operations-root")).toBeEmpty();
  expect(requestCount).toBe(0);
});
