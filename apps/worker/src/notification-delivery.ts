// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { z } from "zod";

export type StandardNotificationPayload = Readonly<{
  userId?: string;
  invitationId?: string;
  email?: string;
  locale?: string;
  verificationUrl?: string;
  expiresAt?: string;
  cancellationRequestId?: string;
  serviceId?: string;
  productName?: string;
  effectiveAt?: string;
  executionMode?: "automatic" | "manual";
  accountId?: string;
  accountName?: string;
  role?: "owner" | "billing" | "technical" | "viewer";
  invitationUrl?: string;
  invoiceId?: string;
  kind?: "renewal_created" | "pre_due" | "overdue_first";
  offsetDays?: number;
  dueAt?: string;
  amountDueMinor?: string;
  currency?: string;
  ticketId?: string;
  ticketMessageId?: string;
  ticketSubject?: string;
  ticketMessage?: string;
}>;

export function notificationOperationId(
  outboxId: string,
  attemptNumber: number,
): string {
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error("Notification attempt number must be a positive integer");
  }
  const bytes = createHash("sha256")
    .update(`opensales:notification:${outboxId}:${attemptNumber}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type RenderedStandardNotification = Readonly<{
  recipient: string;
  template: string;
  locale: "en" | "zh-CN";
  subject: string;
  body: string;
  sensitive: boolean;
}>;

export type MockMailRequestSnapshot = RenderedStandardNotification &
  Readonly<{ scenario: "delivered" | "bounced" | "failed" }>;

export type NotificationDeliveryFact = Readonly<{
  operationId: string;
  status: "delivered" | "bounced" | "failed";
  deliveredAt: string;
}>;

export type MockMailPostOutcome =
  | Readonly<{ kind: "found"; fact: NotificationDeliveryFact }>
  | Readonly<{
      kind: "unknown";
      code: "timeout" | "network" | "retryable_http" | "invalid_response";
    }>
  | Readonly<{
      kind: "manual";
      code: "idempotency_conflict" | "auth" | "contract" | "operation_mismatch";
    }>;

export type MockMailGetOutcome =
  | Readonly<{ kind: "found"; fact: NotificationDeliveryFact }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{
      kind: "retry";
      code: "timeout" | "network" | "retryable_http" | "invalid_response";
    }>
  | Readonly<{ kind: "manual"; code: "auth" | "contract" | "operation_mismatch" }>;

const providerFactSchema = z
  .object({
    operationId: z.uuid(),
    status: z.enum(["delivered", "bounced", "failed"]),
    deliveredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const mockMailRequestSnapshotSchema = z
  .object({
    recipient: z.email(),
    template: z.string().min(1).max(120),
    locale: z.enum(["en", "zh-CN"]),
    subject: z.string().min(1).max(240),
    body: z.string().min(1).max(20_000),
    sensitive: z.boolean(),
    scenario: z.enum(["delivered", "bounced", "failed"]),
  })
  .strict();

export function mockMailRequestSnapshot(
  rendered: RenderedStandardNotification,
  scenario: "delivered" | "bounced" | "failed" = "delivered",
): MockMailRequestSnapshot {
  return mockMailRequestSnapshotSchema.parse({ ...rendered, scenario });
}

export function parseMockMailRequestSnapshot(value: unknown): MockMailRequestSnapshot {
  return mockMailRequestSnapshotSchema.parse(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Mock Mail request numbers must be safe integers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value) {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Mock Mail request snapshot is not canonical JSON");
}

export function mockMailRequestFingerprint(snapshot: MockMailRequestSnapshot): string {
  return createHash("sha256")
    .update("opensales:mock-mail-rendered-request:v1\0", "utf8")
    .update(canonicalJson(snapshot), "utf8")
    .digest("hex");
}

function unsupported(eventType: string): Error {
  // Never include payload values here: verification and invitation payloads
  // contain one-time secrets that must not be copied into Worker logs.
  return new Error(`Unsupported notification event: ${eventType}`);
}

export function renderStandardNotification(
  eventType: string,
  payload: StandardNotificationPayload,
  templateRevision?: string,
): RenderedStandardNotification {
  if (!payload.email) throw unsupported(eventType);
  const locale = payload.locale === "zh-CN" ? "zh-CN" : "en";
  if (
    eventType === "notification.email_verification_requested" &&
    (!templateRevision || templateRevision === "email-verification-v1") &&
    payload.verificationUrl
  ) {
    const subject =
      locale === "zh-CN"
        ? "验证 OpenSales System 实验室账号"
        : "Verify your OpenSales System laboratory account";
    return {
      recipient: payload.email,
      template: "email-verification",
      locale,
      subject,
      body:
        locale === "zh-CN"
          ? `NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n${payload.verificationUrl}\n\n到期时间：${payload.expiresAt ?? "unknown"}`
          : `NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n${payload.verificationUrl}\n\nExpires: ${payload.expiresAt ?? "unknown"}`,
      sensitive: true,
    };
  }
  if (
    eventType === "notification.membership_invitation_requested" &&
    (!templateRevision || templateRevision === "membership-invitation-v1") &&
    payload.accountId &&
    payload.accountName &&
    payload.role &&
    payload.invitationUrl &&
    payload.expiresAt
  ) {
    const subject =
      locale === "zh-CN"
        ? "加入 OpenSales System 实验室客户账户"
        : "Join an OpenSales System laboratory Client Account";
    return {
      recipient: payload.email,
      template: "membership-invitation-v1",
      locale,
      subject,
      body:
        locale === "zh-CN"
          ? `NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n${subject}\n客户账户：${payload.accountName}\n账户 ID：${payload.accountId}\n角色：${payload.role}\n邀请链接：${payload.invitationUrl}\n到期时间：${payload.expiresAt}`
          : `NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n${subject}\nClient Account: ${payload.accountName}\nAccount ID: ${payload.accountId}\nRole: ${payload.role}\nInvitation link: ${payload.invitationUrl}\nExpires: ${payload.expiresAt}`,
      sensitive: true,
    };
  }
  if (
    eventType === "notification.service_cancellation_scheduled" &&
    (!templateRevision || templateRevision === "service-cancellation-scheduled-v1") &&
    payload.cancellationRequestId &&
    payload.serviceId &&
    payload.productName &&
    payload.effectiveAt &&
    (payload.executionMode === "automatic" || payload.executionMode === "manual")
  ) {
    const subject =
      locale === "zh-CN"
        ? "服务已安排在账期末取消"
        : "Service cancellation scheduled for period end";
    return {
      recipient: payload.email,
      template: "service-cancellation-scheduled-v1",
      locale,
      subject,
      body:
        locale === "zh-CN"
          ? `NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n${subject}\n产品：${payload.productName}\n服务：${payload.serviceId}\n生效时间：${payload.effectiveAt}\n执行方式：${payload.executionMode === "automatic" ? "Mock Provider 自动终止" : "管理员人工终止"}`
          : `NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n${subject}\nProduct: ${payload.productName}\nService: ${payload.serviceId}\nEffective at: ${payload.effectiveAt}\nExecution: ${payload.executionMode === "automatic" ? "automatic Mock Provider termination" : "administrator manual termination"}`,
      sensitive: false,
    };
  }
  if (
    eventType === "notification.renewal_reminder_requested" &&
    payload.invoiceId &&
    payload.serviceId &&
    payload.kind &&
    typeof payload.offsetDays === "number" &&
    Number.isInteger(payload.offsetDays) &&
    payload.offsetDays >= 0 &&
    payload.offsetDays <= 90 &&
    payload.dueAt &&
    payload.amountDueMinor &&
    /^\d+$/.test(payload.amountDueMinor) &&
    payload.currency &&
    /^[A-Z]{3}$/.test(payload.currency) &&
    (!templateRevision ||
      templateRevision === `renewal-${payload.kind.replaceAll("_", "-")}-v1`)
  ) {
    const amountDueMinor = BigInt(payload.amountDueMinor);
    const amount = `${amountDueMinor / 100n}.${(amountDueMinor % 100n)
      .toString()
      .padStart(2, "0")}`;
    const labels =
      locale === "zh-CN"
        ? {
            renewal_created: "续费发票已创建",
            pre_due: `续费发票将在 ${payload.offsetDays} 天后到期`,
            overdue_first: `续费发票已逾期 ${payload.offsetDays} 天`,
          }
        : {
            renewal_created: "Renewal invoice created",
            pre_due: `Renewal invoice is due in ${payload.offsetDays} days`,
            overdue_first: `Renewal invoice is ${payload.offsetDays} days overdue`,
          };
    const subject = labels[payload.kind];
    return {
      recipient: payload.email,
      template: `renewal-${payload.kind.replaceAll("_", "-")}-v1`,
      locale,
      subject,
      body:
        locale === "zh-CN"
          ? `NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n${subject}\n发票：${payload.invoiceId}\n服务：${payload.serviceId}\n到期时间：${payload.dueAt}\n当前应付：${payload.currency} ${amount}`
          : `NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n${subject}\nInvoice: ${payload.invoiceId}\nService: ${payload.serviceId}\nDue: ${payload.dueAt}\nAmount due: ${payload.currency} ${amount}`,
      sensitive: false,
    };
  }
  if (
    eventType === "notification.support_ticket_reply_requested" &&
    (!templateRevision || templateRevision === "support-ticket-reply-v1") &&
    payload.ticketId &&
    payload.ticketMessageId &&
    payload.ticketSubject &&
    payload.ticketMessage
  ) {
    const subject =
      locale === "zh-CN"
        ? `工单回复：${payload.ticketSubject}`
        : `Ticket reply: ${payload.ticketSubject}`;
    return {
      recipient: payload.email,
      template: "support-ticket-reply-v1",
      locale,
      subject,
      body:
        locale === "zh-CN"
          ? `NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n工单：${payload.ticketId}\n\n${payload.ticketMessage}`
          : `NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\nTicket: ${payload.ticketId}\n\n${payload.ticketMessage}`,
      sensitive: true,
    };
  }
  throw unsupported(eventType);
}

function transportFailure(error: unknown): "timeout" | "network" {
  return error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
    ? "timeout"
    : "network";
}

async function parseProviderFact(
  response: Response,
  operationId: string,
): Promise<
  | Readonly<{ kind: "found"; fact: NotificationDeliveryFact }>
  | Readonly<{ kind: "mismatch" }>
  | Readonly<{ kind: "invalid" }>
> {
  try {
    const fact = providerFactSchema.parse(await response.json());
    return fact.operationId === operationId
      ? { kind: "found", fact }
      : { kind: "mismatch" };
  } catch {
    return { kind: "invalid" };
  }
}

export async function postMockMailNotification(input: Readonly<{
  providerUrl: string;
  providerToken: string;
  operationId: string;
  requestSnapshot: MockMailRequestSnapshot;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}>): Promise<MockMailPostOutcome> {
  const request = input.fetchImplementation ?? fetch;
  let response: Response;
  try {
    response = await request(new URL("/v1/mail", input.providerUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.providerToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.operationId,
      },
      body: JSON.stringify({
        operationId: input.operationId,
        ...input.requestSnapshot,
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
      redirect: "error",
    });
  } catch (error) {
    return { kind: "unknown", code: transportFailure(error) };
  }
  if (response.status === 409) return { kind: "manual", code: "idempotency_conflict" };
  if (response.status === 401 || response.status === 403) {
    return { kind: "manual", code: "auth" };
  }
  if ([408, 425, 429].includes(response.status) || response.status >= 500) {
    return { kind: "unknown", code: "retryable_http" };
  }
  if (response.status !== 202) {
    return response.status >= 200 && response.status < 300
      ? { kind: "unknown", code: "invalid_response" }
      : { kind: "manual", code: "contract" };
  }
  const parsed = await parseProviderFact(response, input.operationId);
  if (parsed.kind === "found") return parsed;
  return parsed.kind === "mismatch"
    ? { kind: "manual", code: "operation_mismatch" }
    : { kind: "unknown", code: "invalid_response" };
}

export async function getMockMailNotification(input: Readonly<{
  providerUrl: string;
  providerToken: string;
  operationId: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}>): Promise<MockMailGetOutcome> {
  const request = input.fetchImplementation ?? fetch;
  let response: Response;
  try {
    response = await request(
      new URL(`/v1/mail/${encodeURIComponent(input.operationId)}`, input.providerUrl),
      {
        method: "GET",
        headers: { Authorization: `Bearer ${input.providerToken}` },
        signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
        redirect: "error",
      },
    );
  } catch (error) {
    return { kind: "retry", code: transportFailure(error) };
  }
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401 || response.status === 403) {
    return { kind: "manual", code: "auth" };
  }
  if ([408, 425, 429].includes(response.status) || response.status >= 500) {
    return { kind: "retry", code: "retryable_http" };
  }
  if (response.status !== 200) {
    return response.status >= 200 && response.status < 300
      ? { kind: "retry", code: "invalid_response" }
      : { kind: "manual", code: "contract" };
  }
  const parsed = await parseProviderFact(response, input.operationId);
  if (parsed.kind === "found") return parsed;
  return parsed.kind === "mismatch"
    ? { kind: "manual", code: "operation_mismatch" }
    : { kind: "retry", code: "invalid_response" };
}

export async function deliverStandardNotification(input: Readonly<{
  providerUrl: string;
  providerToken: string;
  operationId: string;
  eventType: string;
  payload: StandardNotificationPayload;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}>): Promise<NotificationDeliveryFact> {
  const rendered = renderStandardNotification(input.eventType, input.payload);
  const outcome = await postMockMailNotification({
    providerUrl: input.providerUrl,
    providerToken: input.providerToken,
    operationId: input.operationId,
    requestSnapshot: mockMailRequestSnapshot(rendered),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: input.fetchImplementation }),
  });
  if (outcome.kind === "found") return outcome.fact;
  throw new Error(`Mock Mail notification did not return a terminal fact (${outcome.code})`);
}
