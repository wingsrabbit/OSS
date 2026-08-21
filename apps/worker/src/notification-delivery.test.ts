// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverStandardNotification,
  getMockMailNotification,
  mockMailRequestFingerprint,
  mockMailRequestSnapshot,
  notificationOperationId,
  postMockMailNotification,
  renderStandardNotification,
} from "./notification-delivery.js";

const operationId = "00000000-0000-4000-8000-000000000019";
const invitationUrl =
  "http://127.0.0.1:3000/membership-invitations/accept?token=synthetic-one-time-secret";

test("notification attempt operation IDs are deterministic and attempt-scoped", () => {
  const first = notificationOperationId(
    "00000000-0000-4000-8000-000000000001",
    1,
  );
  assert.equal(
    first,
    notificationOperationId("00000000-0000-4000-8000-000000000001", 1),
  );
  assert.notEqual(
    first,
    notificationOperationId("00000000-0000-4000-8000-000000000001", 2),
  );
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("membership invitation rendering is bilingual, Mock-only, and sensitive", () => {
  for (const locale of ["en", "zh-CN"] as const) {
    const rendered = renderStandardNotification(
      "notification.membership_invitation_requested",
      {
        email: `invited-${locale}@example.invalid`,
        locale,
        accountId: "00000000-0000-4000-8000-000000000001",
        accountName: "Synthetic Account",
        role: "billing",
        invitationUrl,
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    );
    assert.equal(rendered.template, "membership-invitation-v1");
    assert.equal(rendered.locale, locale);
    assert.equal(rendered.sensitive, true);
    assert.match(rendered.body, /NOT FOR PRODUCTION/);
    assert.match(rendered.body, /Synthetic Account/);
    assert.match(rendered.body, /billing/);
    assert.match(rendered.body, /synthetic-one-time-secret/);
  }
});

test("membership invitation uses the Worker delivery request and returns a Provider fact", async () => {
  let requestUrl = "";
  const captured: {
    body?: Record<string, unknown>;
    headers?: Headers;
  } = {};
  const fakeFetch: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    captured.headers = new Headers(init?.headers);
    return new Response(
      JSON.stringify({
        operationId,
        status: "delivered",
        deliveredAt: "2030-01-01T00:00:01.000Z",
      }),
      { status: 202, headers: { "Content-Type": "application/json" } },
    );
  };

  const fact = await deliverStandardNotification({
    providerUrl: "http://127.0.0.1:4400",
    providerToken: "synthetic-mock-mail-provider-token-00000000",
    operationId,
    eventType: "notification.membership_invitation_requested",
    payload: {
      email: "invited@example.invalid",
      locale: "zh-CN",
      accountId: "00000000-0000-4000-8000-000000000001",
      accountName: "Synthetic Account",
      role: "viewer",
      invitationUrl,
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
    fetchImplementation: fakeFetch,
  });

  assert.deepEqual(fact, {
    operationId,
    status: "delivered",
    deliveredAt: "2030-01-01T00:00:01.000Z",
  });
  assert.equal(requestUrl, "http://127.0.0.1:4400/v1/mail");
  assert.equal(captured.headers?.get("idempotency-key"), operationId);
  assert.equal(captured.headers?.get("authorization"),
    "Bearer synthetic-mock-mail-provider-token-00000000");
  assert.equal(captured.body?.operationId, operationId);
  assert.equal(captured.body?.template, "membership-invitation-v1");
  assert.equal(captured.body?.sensitive, true);
});

test("unsupported notification errors never copy one-time secrets", () => {
  assert.throws(
    () =>
      renderStandardNotification("notification.unsupported", {
        email: "invited@example.invalid",
        invitationUrl,
      }),
    (error: unknown) =>
      error instanceof Error &&
      !error.message.includes("synthetic-one-time-secret"),
  );
});

test("renewal rendering freezes the dispatch-time amount in a versioned request", () => {
  const rendered = renderStandardNotification(
    "notification.renewal_reminder_requested",
    {
      email: "billing@example.invalid",
      locale: "zh-CN",
      invoiceId: "00000000-0000-4000-8000-000000000101",
      serviceId: "00000000-0000-4000-8000-000000000102",
      kind: "pre_due",
      offsetDays: 7,
      dueAt: "2030-01-08T00:00:00.000Z",
      amountDueMinor: "12345",
      currency: "USD",
    },
    "renewal-pre-due-v1",
  );
  assert.equal(rendered.template, "renewal-pre-due-v1");
  assert.equal(rendered.subject, "续费发票将在 7 天后到期");
  assert.match(rendered.body, /USD 123\.45/);
  assert.equal(rendered.sensitive, false);
  assert.throws(
    () =>
      renderStandardNotification(
        "notification.renewal_reminder_requested",
        {
          email: "billing@example.invalid",
          locale: "en",
          invoiceId: "00000000-0000-4000-8000-000000000101",
          serviceId: "00000000-0000-4000-8000-000000000102",
          kind: "pre_due",
          offsetDays: 7,
          dueAt: "2030-01-08T00:00:00.000Z",
          amountDueMinor: "12345",
          currency: "USD",
        },
        "renewal-pre-due-v2",
      ),
    /Unsupported notification event/,
  );
});

test("public support replies render bilingual sensitive notifications", () => {
  for (const locale of ["en", "zh-CN"] as const) {
    const rendered = renderStandardNotification(
      "notification.support_ticket_reply_requested",
      {
        email: `support-${locale}@example.invalid`,
        locale,
        ticketId: "00000000-0000-4000-8000-000000000201",
        ticketMessageId: "00000000-0000-4000-8000-000000000202",
        ticketSubject: "Synthetic service question",
        ticketMessage: "This is a public Staff reply.",
      },
      "support-ticket-reply-v1",
    );
    assert.equal(rendered.template, "support-ticket-reply-v1");
    assert.equal(rendered.locale, locale);
    assert.equal(rendered.sensitive, true);
    assert.match(rendered.body, /NOT FOR PRODUCTION/);
    assert.match(rendered.body, /00000000-0000-4000-8000-000000000201/);
    assert.match(rendered.body, /This is a public Staff reply\./);
  }
});

test("rendered Mock Mail request fingerprints are canonical and Unicode-stable", () => {
  const snapshot = mockMailRequestSnapshot(
    {
      recipient: "owner+test@example.invalid",
      template: "renewal-pre-due-v1",
      locale: "zh-CN",
      subject: "续费发票将在 7 天后到期",
      body: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n当前应付：USD 123.45",
      sensitive: false,
    },
    "bounced",
  );
  assert.equal(
    mockMailRequestFingerprint(snapshot),
    "1712517c53def3a62ff48eaca312b93c8986f54cfa62b90929d95e59c54f6c18",
  );
  assert.equal(
    mockMailRequestFingerprint({
      scenario: "bounced",
      sensitive: false,
      body: snapshot.body,
      subject: snapshot.subject,
      locale: "zh-CN",
      template: snapshot.template,
      recipient: snapshot.recipient,
    }),
    mockMailRequestFingerprint(snapshot),
  );
});

test("Mock Mail POST classifies terminal, unknown, and manual outcomes without response details", async () => {
  const rendered = renderStandardNotification(
    "notification.membership_invitation_requested",
    {
      email: "invited@example.invalid",
      locale: "en",
      accountId: "00000000-0000-4000-8000-000000000001",
      accountName: "Synthetic Account",
      role: "viewer",
      invitationUrl,
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
    "membership-invitation-v1",
  );
  const outcome = await postMockMailNotification({
    providerUrl: "http://127.0.0.1:4400",
    providerToken: "synthetic-provider-token",
    operationId,
    requestSnapshot: mockMailRequestSnapshot(rendered, "bounced"),
    fetchImplementation: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.operationId, operationId);
      assert.equal(body.scenario, "bounced");
      assert.equal(new Headers(init?.headers).get("idempotency-key"), operationId);
      return new Response(
        JSON.stringify({
          operationId,
          status: "bounced",
          deliveredAt: "2030-01-01T00:00:01.000Z",
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  assert.deepEqual(outcome, {
    kind: "found",
    fact: {
      operationId,
      status: "bounced",
      deliveredAt: "2030-01-01T00:00:01.000Z",
    },
  });

  for (const [status, expected] of [
    [409, { kind: "manual", code: "idempotency_conflict" }],
    [401, { kind: "manual", code: "auth" }],
    [400, { kind: "manual", code: "contract" }],
    [429, { kind: "unknown", code: "retryable_http" }],
    [503, { kind: "unknown", code: "retryable_http" }],
  ] as const) {
    const classified = await postMockMailNotification({
      providerUrl: "http://127.0.0.1:4400",
      providerToken: "synthetic-provider-token",
      operationId,
      requestSnapshot: mockMailRequestSnapshot(rendered),
      fetchImplementation: async () =>
        new Response("synthetic-one-time-secret must never be parsed", { status }),
    });
    assert.deepEqual(classified, expected);
  }

  const malformed = await postMockMailNotification({
    providerUrl: "http://127.0.0.1:4400",
    providerToken: "synthetic-provider-token",
    operationId,
    requestSnapshot: mockMailRequestSnapshot(rendered),
    fetchImplementation: async () => new Response("not-json", { status: 202 }),
  });
  assert.deepEqual(malformed, { kind: "unknown", code: "invalid_response" });

  const mismatched = await postMockMailNotification({
    providerUrl: "http://127.0.0.1:4400",
    providerToken: "synthetic-provider-token",
    operationId,
    requestSnapshot: mockMailRequestSnapshot(rendered),
    fetchImplementation: async () =>
      new Response(
        JSON.stringify({
          operationId: "00000000-0000-4000-8000-000000000020",
          status: "delivered",
          deliveredAt: "2030-01-01T00:00:01.000Z",
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      ),
  });
  assert.deepEqual(mismatched, { kind: "manual", code: "operation_mismatch" });
});

test("Mock Mail GET queries the same operation and distinguishes not-found from retry", async () => {
  let requestedUrl = "";
  const found = await getMockMailNotification({
    providerUrl: "http://127.0.0.1:4400/base",
    providerToken: "synthetic-provider-token",
    operationId,
    fetchImplementation: async (input, init) => {
      requestedUrl = String(input);
      assert.equal(init?.method, "GET");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer synthetic-provider-token",
      );
      return new Response(
        JSON.stringify({
          operationId,
          status: "failed",
          deliveredAt: "2030-01-01T00:00:02.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  assert.equal(requestedUrl, `http://127.0.0.1:4400/v1/mail/${operationId}`);
  assert.deepEqual(found, {
    kind: "found",
    fact: {
      operationId,
      status: "failed",
      deliveredAt: "2030-01-01T00:00:02.000Z",
    },
  });

  for (const [status, expected] of [
    [404, { kind: "not_found" }],
    [401, { kind: "manual", code: "auth" }],
    [429, { kind: "retry", code: "retryable_http" }],
    [500, { kind: "retry", code: "retryable_http" }],
  ] as const) {
    const classified = await getMockMailNotification({
      providerUrl: "http://127.0.0.1:4400",
      providerToken: "synthetic-provider-token",
      operationId,
      fetchImplementation: async () => new Response(null, { status }),
    });
    assert.deepEqual(classified, expected);
  }

  const mismatched = await getMockMailNotification({
    providerUrl: "http://127.0.0.1:4400",
    providerToken: "synthetic-provider-token",
    operationId,
    fetchImplementation: async () =>
      new Response(
        JSON.stringify({
          operationId: "00000000-0000-4000-8000-000000000020",
          status: "failed",
          deliveredAt: "2030-01-01T00:00:02.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });
  assert.deepEqual(mismatched, { kind: "manual", code: "operation_mismatch" });
});

test("Mock Mail transport converts thrown secrets into non-sensitive outcome codes", async () => {
  const rendered = renderStandardNotification(
    "notification.email_verification_requested",
    {
      email: "verify@example.invalid",
      locale: "en",
      verificationUrl: "http://127.0.0.1/verify?token=synthetic-one-time-secret",
    },
    "email-verification-v1",
  );
  const post = await postMockMailNotification({
    providerUrl: "http://127.0.0.1:4400",
    providerToken: "synthetic-provider-token",
    operationId,
    requestSnapshot: mockMailRequestSnapshot(rendered),
    fetchImplementation: async () => {
      throw new Error("synthetic-one-time-secret");
    },
  });
  const get = await getMockMailNotification({
    providerUrl: "http://127.0.0.1:4400",
    providerToken: "synthetic-provider-token",
    operationId,
    fetchImplementation: async () => {
      const error = new Error("synthetic-one-time-secret");
      error.name = "TimeoutError";
      throw error;
    },
  });
  assert.deepEqual(post, { kind: "unknown", code: "network" });
  assert.deepEqual(get, { kind: "retry", code: "timeout" });
  assert.doesNotMatch(JSON.stringify([post, get]), /synthetic-one-time-secret/);
});
