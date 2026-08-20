// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Page, type Route } from "@playwright/test";
import {
  fulfillNotificationInterfaceRequest,
  notificationPreferencesMockState,
} from "./helpers/notification-interfaces.js";

const accountId = "10000000-0000-4000-8000-000000000001";
const sessionHeaders = {
  "X-OSS-Account-Context-Version": "1",
  "X-OSS-Authorization-Epoch": "1",
};
const accountHeaders = {
  ...sessionHeaders,
  "X-OSS-Client-Account-Id": accountId,
};
const occurredAt = "2026-08-20T09:00:00.000Z";
const eventType = "notification.invoice_issued";
const publishedRevisionId = "20000000-0000-4000-8000-000000000001";
const draftRevisionId = "20000000-0000-4000-8000-000000000002";
const olderDraftRevisionId = "20000000-0000-4000-8000-000000000003";

const realAppLegal = {
  requestedLocale: "en",
  documents: Object.fromEntries(
    ["terms", "aup", "privacy"].map((kind, index) => [
      kind,
      {
        id: `30000000-0000-4000-8000-00000000000${index + 1}`,
        documentId: `30000000-0000-4000-8000-00000000000${index + 1}`,
        kind,
        requestedLocale: "en",
        locale: "en",
        fallback: false,
        revision: "1",
        version: "notification-browser-v1",
        title: `Synthetic ${kind}`,
        body: "Normal Mock-only browser fixture.",
        publishedAt: occurredAt,
      },
    ]),
  ),
};

function realAppViewer(permissions: string[] | null) {
  const customer = permissions === null;
  return {
    id: "30000000-0000-4000-8000-000000000010",
    email: permissions === null
      ? "notification-customer@example.invalid"
      : "notification-staff@example.invalid",
    locale: "en",
    clientAccountId: customer ? accountId : null,
    membershipRole: customer ? "owner" : null,
    accountContextVersion: "1",
    authorizationEpoch: "1",
    context: customer
      ? {
          clientAccountId: accountId,
          name: "Notification customer account",
          role: "owner",
          permissions: [],
          capabilities: [],
          version: "1",
        }
      : null,
    verification: { email: "passed" },
    restrictions: { user: false, clientAccount: false },
    eligible: customer,
    staff: permissions === null ? null : { roles: ["operations"], permissions },
  };
}

async function fulfillRealAppShell(route: Route, viewer: ReturnType<typeof realAppViewer>) {
  const request = route.request();
  const url = new URL(request.url());
  const authenticatedHeaders = viewer.clientAccountId ? accountHeaders : sessionHeaders;
  if (request.method() === "GET" && url.pathname === "/api/v1/catalog") {
    await route.fulfill({ json: { products: [] } });
    return true;
  }
  if (request.method() === "GET" && url.pathname === "/api/v1/legal/current") {
    await route.fulfill({ json: realAppLegal });
    return true;
  }
  if (request.method() === "GET" && url.pathname === "/api/v1/content") {
    await route.fulfill({ json: { requestedLocale: "en", items: [] } });
    return true;
  }
  if (request.method() === "GET" && url.pathname === "/api/v1/customer/content") {
    await route.fulfill({ headers: authenticatedHeaders, json: { requestedLocale: "en", items: [] } });
    return true;
  }
  if (request.method() === "GET" && url.pathname === "/api/v1/auth/me") {
    await route.fulfill({ headers: authenticatedHeaders, json: viewer });
    return true;
  }
  if (request.method() === "GET" && url.pathname === "/api/v1/auth/account-contexts") {
    await route.fulfill({
      headers: authenticatedHeaders,
      json: {
        activeClientAccountId: viewer.clientAccountId,
        accountContextVersion: "1",
        items: viewer.context
          ? [{
              clientAccountId: viewer.context.clientAccountId,
              name: viewer.context.name,
              role: viewer.context.role,
              permissions: viewer.context.permissions,
              capabilities: viewer.context.capabilities,
              restrictions: { membership: false, clientAccount: false },
            }]
          : [],
        limit: 25,
        hasMore: false,
        nextCursor: null,
      },
    });
    return true;
  }
  if (
    request.method() === "GET" &&
    url.pathname === "/api/v1/support/departments" &&
    [...url.searchParams.keys()].length === 1 &&
    url.searchParams.get("audience") === "presales"
  ) {
    await route.fulfill({ json: { items: [] } });
    return true;
  }
  if (
    request.method() === "GET" &&
    url.pathname === "/api/v1/support/departments" &&
    [...url.searchParams.keys()].length === 1 &&
    url.searchParams.get("audience") === "authenticated"
  ) {
    await route.fulfill({ headers: authenticatedHeaders, json: { items: [] } });
    return true;
  }
  if (request.method() === "GET" && url.pathname === "/api/v1/customer/business-history") {
    await route.fulfill({
      headers: authenticatedHeaders,
      json: {
        warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
        account: { id: accountId, name: "Notification customer account" },
        orders: [],
        invoices: [],
        payments: [],
        credit: { currency: "USD", balanceMinor: "0", transactions: [] },
        refunds: [],
        services: [],
        renewals: [],
        cancellations: [],
        tickets: [],
      },
    });
    return true;
  }
  if (request.method() === "GET" && url.pathname === "/api/v1/billing/summary") {
    await route.fulfill({
      headers: authenticatedHeaders,
      json: {
        currency: "USD",
        creditBalanceMinor: "0",
        paymentMethods: [],
        addFunds: {
          enabled: false,
          allowed: false,
          minimumMinor: "100",
          maximumMinor: "10000",
          balanceCapMinor: "10000",
        },
      },
    });
    return true;
  }
  if (request.method() === "GET" && url.pathname === "/api/v1/billing/payment-settings") {
    await route.fulfill({
      headers: authenticatedHeaders,
      json: {
        defaults: { savePaymentMethod: false, automaticRenewal: false },
        consentVersions: { savePaymentMethod: "mock-v1", automaticRenewal: "mock-v1" },
        methods: [],
        automaticRenewals: [],
        pendingAutomaticRenewals: [],
        serviceDecisions: [],
      },
    });
    return true;
  }
  if (request.method() === "GET" && url.pathname === "/api/v1/billing/renewals") {
    await route.fulfill({ headers: authenticatedHeaders, json: { items: [] } });
    return true;
  }
  if (request.method() === "GET" && url.pathname === "/api/v1/billing/chargeback-status") {
    await route.fulfill({
      headers: authenticatedHeaders,
      json: {
        clientAccountId: accountId,
        restricted: false,
        creditBalanceMinor: "0",
        debtBalanceMinor: "0",
        chargebacks: [],
        unclaimedChargebacks: [],
        manualHolds: [],
      },
    });
    return true;
  }
  if (
    request.method() === "GET" &&
    (url.pathname === "/api/v1/orders" ||
      url.pathname === "/api/v1/tickets" ||
      url.pathname === "/api/v1/tickets/service-options")
  ) {
    await route.fulfill({ headers: authenticatedHeaders, json: { items: [] } });
    return true;
  }
  return false;
}

type PreferenceState = {
  billingEnabled: boolean;
  billingVersion: string;
};

function preferences(state: PreferenceState, subject = "Customer A") {
  return {
    channel: "email",
    categories: [
      {
        category: "identity",
        label: { en: `${subject} identity`, "zh-CN": `${subject} 身份` },
        mandatory: true,
        enabled: true,
        version: "1",
      },
      {
        category: "transactional",
        label: { en: "Transactional", "zh-CN": "交易" },
        mandatory: true,
        enabled: true,
        version: "1",
      },
      {
        category: "high_risk",
        label: { en: "High risk", "zh-CN": "高风险" },
        mandatory: true,
        enabled: true,
        version: "1",
      },
      {
        category: "billing",
        label: { en: `${subject} billing`, "zh-CN": `${subject} 账单` },
        mandatory: false,
        enabled: state.billingEnabled,
        version: state.billingVersion,
      },
      {
        category: "service",
        label: { en: "Service", "zh-CN": "服务" },
        mandatory: false,
        enabled: true,
        version: "2",
      },
      {
        category: "support",
        label: { en: "Support", "zh-CN": "支持" },
        mandatory: false,
        enabled: true,
        version: "3",
      },
    ],
  };
}

async function fulfill(route: Route, json: unknown, accountScoped = false, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: accountScoped ? accountHeaders : sessionHeaders,
    body: JSON.stringify(json),
  });
}

test("required email categories stay enabled while an optional preference persists after refresh", async ({ page }) => {
  const state: PreferenceState = { billingEnabled: true, billingVersion: "4" };
  let putCount = 0;
  const putBodies: unknown[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/v1/customer/notification-preferences") {
      return fulfill(route, preferences(state), true);
    }
    if (
      request.method() === "PUT" &&
      path === "/api/v1/customer/notification-preferences/billing/email"
    ) {
      putCount += 1;
      putBodies.push(request.postDataJSON());
      state.billingEnabled = false;
      state.billingVersion = "5";
      return fulfill(
        route,
        preferences(state).categories.find((category) => category.category === "billing"),
        true,
      );
    }
    return route.fulfill({ status: 404, json: { error: `Unmocked ${request.method()} ${path}` } });
  });

  await page.goto("/notification-preferences-templates-harness.html?mode=customer");
  const panel = page.getByTestId("notification-preferences");
  await expect(panel).toBeVisible();
  for (const category of ["identity", "transactional", "high_risk"]) {
    const row = panel.getByTestId(`notification-preference-${category}`);
    await expect(row.getByRole("checkbox")).toBeChecked();
    await expect(row.getByRole("checkbox")).toBeDisabled();
    await row.getByRole("checkbox").evaluate((element: HTMLInputElement) => element.click());
  }
  expect(putCount).toBe(0);

  const billing = panel.getByTestId("notification-preference-billing");
  await billing.getByRole("checkbox").uncheck();
  await expect(page.getByLabel("Notification notice")).toContainText("email preference saved");
  expect(putCount).toBe(1);
  expect(putBodies).toEqual([{ enabled: false, expectedVersion: "4" }]);

  await page.reload();
  const refreshedBilling = page.getByTestId("notification-preference-billing");
  await expect(refreshedBilling.getByRole("checkbox")).not.toBeChecked();
  await expect(refreshedBilling).toContainText("version 5");
});

test("Chinese customer copy explains required and optional email preferences", async ({ page }) => {
  const state: PreferenceState = { billingEnabled: true, billingVersion: "4" };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/customer/notification-preferences") {
      return fulfill(route, preferences(state), true);
    }
    return route.fulfill({ status: 404, json: { error: `Unmocked ${path}` } });
  });

  await page.goto(
    "/notification-preferences-templates-harness.html?mode=customer&locale=zh-CN",
  );
  const panel = page.getByRole("region", { name: "通知偏好" });
  await expect(panel.getByRole("heading", { name: "通知偏好" })).toBeVisible();
  await expect(panel).toContainText("身份、交易和高风险通知属于必达消息，不能关闭");
  await expect(panel.getByTestId("notification-preference-billing")).toContainText("Customer A 账单");
  await expect(panel.getByTestId("notification-preference-service")).toContainText("可选邮件");
});

function registry(stage: "initial" | "draft" | "published" | "retired") {
  const hasDraft = stage !== "initial";
  const draftPublished = stage === "published" || stage === "retired";
  const draftRetired = stage === "retired";
  const chineseCurrentRevisionId = stage === "published"
    ? draftRevisionId
    : publishedRevisionId;
  const chineseCurrentRevisionKey = stage === "published"
    ? "invoice-issued-v2"
    : "invoice-issued-en-v1";
  return {
    events: [{
      eventType,
      preferenceCategory: "billing",
      requiredDelivery: false,
      sensitive: false,
      allowedVariables: ["invoiceNumber"],
      requiredVariables: ["invoiceNumber"],
      locales: [
        {
          locale: "en",
          currentRevisionId: publishedRevisionId,
          currentRevisionKey: "invoice-issued-en-v1",
          channelVersion: "1",
          fallback: false,
        },
        {
          locale: "zh-CN",
          currentRevisionId: chineseCurrentRevisionId,
          currentRevisionKey: chineseCurrentRevisionKey,
          channelVersion: stage === "initial" || stage === "draft" ? "0" : stage === "published" ? "1" : "2",
          fallback: stage !== "published",
        },
      ],
      revisions: [
        {
          id: publishedRevisionId,
          locale: "en",
          revisionKey: "invoice-issued-en-v1",
          revisionNumber: "1",
          status: "current",
          subjectTemplate: "Invoice ready",
          bodyTemplate: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\nYour invoice is ready.",
          createdAt: occurredAt,
          publishedAt: occurredAt,
          retiredAt: null,
        },
        ...(hasDraft ? [{
          id: draftRevisionId,
          locale: "zh-CN" as const,
          revisionKey: "invoice-issued-v2",
          revisionNumber: "2",
          status: draftRetired ? "retired" : draftPublished ? "current" : "draft",
          subjectTemplate: "发票 {{invoiceNumber}} 已就绪",
          bodyTemplate: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n发票已可供查看。",
          createdAt: "2026-08-20T09:02:00.000Z",
          publishedAt: draftPublished ? "2026-08-20T09:05:00.000Z" : null,
          retiredAt: draftRetired ? "2026-08-20T09:06:00.000Z" : null,
        }] : []),
      ],
    }],
  };
}

function registryWithOlderDraft() {
  const snapshot = registry("published");
  const event = snapshot.events[0]!;
  return {
    events: [{
      ...event,
      revisions: [
        ...event.revisions,
        {
          id: olderDraftRevisionId,
          locale: "zh-CN" as const,
          revisionKey: "invoice-issued-zh-v1",
          revisionNumber: "1",
          status: "draft",
          subjectTemplate: "发票 {{invoiceNumber}}",
          bodyTemplate:
            "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n发票 {{invoiceNumber}} 已可查看。",
          createdAt: "2026-08-20T09:01:00.000Z",
          publishedAt: null,
          retiredAt: null,
        },
      ],
    }],
  };
}

test("read-only Staff sees the template registry without write controls", async ({ page }) => {
  let listGets = 0;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET" && path === "/api/v1/admin/notification-templates") {
      listGets += 1;
      return fulfill(route, registry("initial"));
    }
    return route.fulfill({ status: 404, json: { error: `Unmocked ${path}` } });
  });

  await page.goto("/notification-preferences-templates-harness.html?mode=admin&read=1");
  const panel = page.getByTestId("notification-template-registry");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(eventType);
  await expect(panel.getByTestId("notification-template-create")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Publish revision" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Retire current revision" })).toHaveCount(0);
  await expect(panel.getByLabel("Current password confirmation")).toHaveCount(0);
  expect(listGets).toBe(1);
});

test("each Staff template permission exposes only its own normal action", async ({ page }) => {
  let snapshotStage: "draft" | "published" = "draft";
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET" && path === "/api/v1/admin/notification-templates") {
      return fulfill(route, registry(snapshotStage));
    }
    return route.fulfill({ status: 404, json: { error: `Unmocked ${path}` } });
  });

  await page.goto(
    "/notification-preferences-templates-harness.html?mode=admin&read=1&create=1",
  );
  const panel = page.getByTestId("notification-template-registry");
  await expect(panel.getByTestId("notification-template-create")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Publish revision" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Retire current revision" })).toHaveCount(0);

  await page.evaluate(() => {
    const harness = (globalThis as typeof globalThis & {
      notificationPreferencesTemplatesHarness: {
        update: (next: Record<string, unknown>) => void;
      };
    }).notificationPreferencesTemplatesHarness;
    harness.update({
      accessFingerprint: "publish-only",
      canCreate: false,
      canPublish: true,
      canRetire: false,
    });
  });
  await expect(panel.getByTestId("notification-template-create")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Publish revision" })).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Retire current revision" })).toHaveCount(0);

  snapshotStage = "published";
  await page.evaluate(() => {
    const harness = (globalThis as typeof globalThis & {
      notificationPreferencesTemplatesHarness: {
        update: (next: Record<string, unknown>) => void;
      };
    }).notificationPreferencesTemplatesHarness;
    harness.update({
      accessFingerprint: "retire-only",
      canCreate: false,
      canPublish: false,
      canRetire: true,
    });
  });
  await expect(panel.getByTestId("notification-template-create")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Publish revision" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Retire current revision" })).toHaveCount(1);
});

test("an older draft cannot be offered after a newer locale revision is published", async ({ page }) => {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET" && path === "/api/v1/admin/notification-templates") {
      return fulfill(route, registryWithOlderDraft());
    }
    return route.fulfill({ status: 404, json: { error: `Unmocked ${path}` } });
  });

  await page.goto(
    "/notification-preferences-templates-harness.html?mode=admin&read=1&publish=1",
  );
  const panel = page.getByTestId("notification-template-registry");
  await expect(panel.getByText("invoice-issued-zh-v1")).toBeVisible();
  await expect(panel).toContainText(
    "A newer revision is already published; this draft cannot replace it.",
  );
  await expect(panel.getByRole("button", { name: "Publish revision" })).toHaveCount(0);
});

test("Staff with all four template permissions creates, publishes, and retires a revision", async ({ page }) => {
  let stage: "initial" | "draft" | "published" | "retired" = "initial";
  const mutationBodies: Array<{ path: string; body: unknown }> = [];
  let reauthCount = 0;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/v1/admin/notification-templates") {
      return fulfill(route, registry(stage));
    }
    if (request.method() === "POST" && path === "/api/v1/auth/reauth") {
      reauthCount += 1;
      expect(request.postDataJSON()).toEqual({ password: "Synthetic-Template-Password!" });
      return fulfill(route, { expiresAt: "2026-08-20T09:15:00.000Z" });
    }
    if (request.method() === "POST") {
      mutationBodies.push({ path, body: request.postDataJSON() });
      if (path.endsWith("/revisions")) stage = "draft";
      else if (path.endsWith("/publish")) stage = "published";
      else if (path.endsWith("/retire")) stage = "retired";
      return fulfill(route, { committed: true }, false, 201);
    }
    return route.fulfill({ status: 404, json: { error: `Unmocked ${request.method()} ${path}` } });
  });

  await page.goto(
    "/notification-preferences-templates-harness.html?mode=admin&read=1&create=1&publish=1&retire=1",
  );
  const panel = page.getByTestId("notification-template-registry");
  await expect(panel).toBeVisible();
  await panel.getByLabel("Current password confirmation").fill("Synthetic-Template-Password!");
  const create = panel.getByTestId("notification-template-create");
  await create.getByLabel("Template locale").selectOption("zh-CN");
  await create.getByLabel("Subject template").fill("发票 {{invoiceNumber}} 已就绪");
  await create.getByLabel("Body template").fill(
    "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n发票已可供查看。",
  );
  await create.getByLabel("Creation reason").fill("Create reviewed Chinese revision");
  await create.getByRole("button", { name: "Create immutable draft" }).click();
  await expect(panel.getByText("invoice-issued-v2")).toBeVisible();

  await panel.getByLabel("Current password confirmation").fill("Synthetic-Template-Password!");
  await panel.getByLabel("Publication or retirement reason").fill("Publish reviewed Chinese revision");
  await panel.getByRole("button", { name: "Publish revision" }).click();
  await expect(panel.getByTestId("notification-template-locale-zh-CN")).toContainText("invoice-issued-v2");

  await panel.getByLabel("Current password confirmation").fill("Synthetic-Template-Password!");
  await panel.getByLabel("Publication or retirement reason").fill("Retire current Chinese revision");
  await panel.getByRole("button", { name: "Retire current revision" }).click();
  await expect(panel.getByTestId("notification-template-locale-zh-CN")).toContainText("invoice-issued-en-v1");
  await expect(panel.getByTestId("notification-template-locale-zh-CN")).toContainText("fallback");

  expect(reauthCount).toBe(3);
  expect(mutationBodies).toEqual([
    {
      path: `/api/v1/admin/notification-templates/${eventType}/revisions`,
      body: {
        locale: "zh-CN",
        subjectTemplate: "发票 {{invoiceNumber}} 已就绪",
        bodyTemplate: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n发票已可供查看。",
        reason: "Create reviewed Chinese revision",
      },
    },
    {
      path: `/api/v1/admin/notification-templates/${eventType}/revisions/${draftRevisionId}/publish`,
      body: {
        reason: "Publish reviewed Chinese revision",
        expectedChannelVersion: "0",
      },
    },
    {
      path: `/api/v1/admin/notification-templates/${eventType}/revisions/${draftRevisionId}/retire`,
      body: {
        reason: "Retire current Chinese revision",
        expectedChannelVersion: "1",
      },
    },
  ]);
});

test("without read permission the Admin panel stays unmounted and sends no registry request", async ({ page }) => {
  let listGets = 0;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/admin/notification-templates") listGets += 1;
    await route.fulfill({ status: 404, json: { error: `Unexpected ${path}` } });
  });

  await page.goto(
    "/notification-preferences-templates-harness.html?mode=admin&read=0&create=1&publish=1&retire=1",
  );
  await expect(page.getByTestId("notification-template-registry")).toHaveCount(0);
  expect(listGets).toBe(0);
});

test("a late preference response from the previous subject cannot replace the current subject", async ({ page }) => {
  let getCount = 0;
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const state: PreferenceState = { billingEnabled: true, billingVersion: "4" };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path !== "/api/v1/customer/notification-preferences") {
      return route.fulfill({ status: 404, json: { error: `Unmocked ${path}` } });
    }
    getCount += 1;
    if (getCount === 1) {
      markFirstStarted();
      await firstGate;
      return fulfill(route, preferences(state, "Previous subject"), true);
    }
    return fulfill(route, preferences(state, "Current subject"), true);
  });

  await page.goto(
    "/notification-preferences-templates-harness.html?mode=customer&fingerprint=subject-a",
  );
  await firstStarted;
  await page.evaluate(() => {
    const harness = (globalThis as typeof globalThis & {
      notificationPreferencesTemplatesHarness: {
        update: (next: { accessFingerprint: string }) => void;
      };
    }).notificationPreferencesTemplatesHarness;
    harness.update({ accessFingerprint: "subject-b" });
  });
  const panel = page.getByTestId("notification-preferences");
  await expect(panel.getByTestId("notification-preference-billing")).toContainText("Current subject billing");
  releaseFirst();
  await page.waitForTimeout(100);
  await expect(panel.getByTestId("notification-preference-billing")).toContainText("Current subject billing");
  await expect(panel).not.toContainText("Previous subject");
  expect(getCount).toBe(2);
});

test("real App customer mounts personal preferences and persists one optional category", async ({ page }) => {
  const viewer = realAppViewer(null);
  const state = notificationPreferencesMockState();
  state.versions.billing = 4n;
  const unexpected: string[] = [];
  let preferenceGets = 0;
  let preferencePuts = 0;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/customer/notification-preferences") preferenceGets += 1;
    if (path === "/api/v1/customer/notification-preferences/billing/email") preferencePuts += 1;
    if (await fulfillNotificationInterfaceRequest(route, {
      customerPreferences: true,
      adminTemplates: false,
      preferenceState: state,
      headers: accountHeaders,
    })) return;
    if (await fulfillRealAppShell(route, viewer)) return;
    unexpected.push(`${request.method()} ${path}`);
    await route.fulfill({ status: 500, headers: sessionHeaders, json: { error: `Unexpected ${path}` } });
  });

  await page.goto("/customer");
  const panel = page.getByTestId("notification-preferences");
  await expect(panel).toBeVisible();
  await panel.getByTestId("notification-preference-billing").getByRole("checkbox").uncheck();
  await expect(panel.getByTestId("notification-preference-billing")).toContainText("version 5");
  expect(preferenceGets).toBeGreaterThanOrEqual(1);
  expect(preferencePuts).toBe(1);
  expect(unexpected).toEqual([]);
});

test("real App Staff mounts only the read-authorized notification template registry", async ({ page }) => {
  const viewer = realAppViewer(["notifications.templates.read"]);
  const preferenceState = notificationPreferencesMockState();
  const unexpected: string[] = [];
  let registryGets = 0;
  let customerPreferenceRequests = 0;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/admin/notification-templates") registryGets += 1;
    if (path.startsWith("/api/v1/customer/notification-preferences")) {
      customerPreferenceRequests += 1;
    }
    if (await fulfillNotificationInterfaceRequest(route, {
      customerPreferences: false,
      adminTemplates: true,
      preferenceState,
      headers: sessionHeaders,
      templateRegistry: registry("initial"),
    })) return;
    if (await fulfillRealAppShell(route, viewer)) return;
    unexpected.push(`${request.method()} ${path}`);
    await route.fulfill({ status: 500, headers: sessionHeaders, json: { error: `Unexpected ${path}` } });
  });

  await page.goto("/admin");
  const panel = page.getByTestId("notification-template-registry");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(eventType);
  await expect(panel.getByTestId("notification-template-create")).toHaveCount(0);
  await expect(page.getByTestId("notification-operations")).toHaveCount(0);
  expect(registryGets).toBeGreaterThanOrEqual(1);
  expect(customerPreferenceRequests).toBe(0);
  expect(unexpected).toEqual([]);
});

test("real App route leave invalidates pending template reauthentication before publication", async ({ page }) => {
  const viewer = realAppViewer([
    "notifications.templates.read",
    "notifications.templates.publish",
  ]);
  let markReauthStarted!: () => void;
  let releaseReauth!: () => void;
  const reauthStarted = new Promise<void>((resolve) => { markReauthStarted = resolve; });
  const reauthGate = new Promise<void>((resolve) => { releaseReauth = resolve; });
  let publishPosts = 0;
  const unexpected: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/v1/admin/notification-templates") {
      await route.fulfill({ headers: sessionHeaders, json: registry("draft") });
      return;
    }
    if (request.method() === "POST" && path === "/api/v1/auth/reauth") {
      markReauthStarted();
      await reauthGate;
      await route.fulfill({ headers: sessionHeaders, json: { expiresAt: "2026-08-20T09:15:00.000Z" } });
      return;
    }
    if (request.method() === "POST" && path.endsWith(`/revisions/${draftRevisionId}/publish`)) {
      publishPosts += 1;
      await route.fulfill({ status: 201, headers: sessionHeaders, json: { committed: true } });
      return;
    }
    if (await fulfillRealAppShell(route, viewer)) return;
    unexpected.push(`${request.method()} ${path}`);
    await route.fulfill({ status: 500, headers: sessionHeaders, json: { error: `Unexpected ${path}` } });
  });

  await page.goto("/admin");
  const panel = page.getByTestId("notification-template-registry");
  await expect(panel).toBeVisible();
  await panel.getByLabel("Current password confirmation").fill("Synthetic-Template-Password!");
  await panel.getByLabel("Publication or retirement reason").fill("Publish reviewed revision");
  await panel.getByRole("button", { name: "Publish revision" }).click();
  await reauthStarted;

  await page.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByTestId("notification-template-registry")).toHaveCount(0);
  releaseReauth();
  await page.waitForTimeout(100);

  expect(publishPosts).toBe(0);
  await expect(page.locator("main > .notice")).toHaveCount(0);
  expect(unexpected).toEqual([]);
});
