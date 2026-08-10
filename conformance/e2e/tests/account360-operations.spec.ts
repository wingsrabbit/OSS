// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Page, type Route } from "@playwright/test";

const accountA = "00000000-0000-4000-8000-000000000401";
const accountB = "00000000-0000-4000-8000-000000000402";
const occurredAt = "2026-08-10T00:00:00.000Z";

type OperationKind = "manual_receipt" | "refund" | "ticket" | "manual_fulfillment";
type RequestFact = { method: string; path: string };
type Interceptor = (path: string, route: Route) => Promise<boolean>;

const operationCases: Array<{
  kind: OperationKind;
  permission: string;
  panel: string;
  action: string;
}> = [
  {
    kind: "manual_receipt",
    permission: "billing.manual_receipt_manage",
    panel: "Record manual receipt",
    action: "Record manual receipt",
  },
  {
    kind: "refund",
    permission: "billing.refund_manage",
    panel: "Manual refunds",
    action: "Open refund operations",
  },
  {
    kind: "ticket",
    permission: "support.tickets.manage",
    panel: "Staff support tickets",
    action: "Open ticket operations",
  },
  {
    kind: "manual_fulfillment",
    permission: "services.manual_fulfillment",
    panel: "Manual fulfillment queue",
    action: "Open manual fulfillment",
  },
];

function viewer(permissions: string[]) {
  return {
    id: "00000000-0000-4000-8000-000000000499",
    email: "operation-staff@example.invalid",
    locale: "en",
    clientAccountId: "00000000-0000-4000-8000-000000000498",
    membershipRole: "support",
    verification: { email: "passed" },
    restrictions: { user: false, clientAccount: false },
    eligible: true,
    staff: { roles: ["support"], permissions },
  };
}

function accountSearchItem(id: string, name: string) {
  return {
    id,
    name,
    owner: {
      userId: id,
      email: `${name.toLowerCase().replaceAll(" ", "-")}@example.invalid`,
      emailVerifiedAt: occurredAt,
    },
    restrictedAt: null,
    activeMemberCount: 1,
    createdAt: occurredAt,
  };
}

function accountSummary(id: string, name: string) {
  return {
    warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
    account: { id, name, createdAt: occurredAt, restrictedAt: null },
    owner: {
      userId: id,
      email: `${name.toLowerCase().replaceAll(" ", "-")}@example.invalid`,
      emailVerifiedAt: occurredAt,
      restrictedAt: null,
    },
    memberships: [],
    restrictions: [],
  };
}

function manualItem(clientAccountId: string, clientAccountName: string, suffix: string) {
  return {
    serviceId: `00000000-0000-4000-8000-0000000005${suffix}`,
    orderId: `00000000-0000-4000-8000-0000000006${suffix}`,
    clientAccountId,
    productName: `Manual service ${suffix}`,
    billingCycle: "monthly",
    clientAccountName,
    paidMinor: "500",
    totalMinor: "500",
    submittedAt: occurredAt,
  };
}

function refundCandidate(clientAccountId: string, clientAccountName: string, suffix: string) {
  return {
    receiptId: `00000000-0000-4000-8000-0000000007${suffix}`,
    invoiceId: `00000000-0000-4000-8000-0000000008${suffix}`,
    clientAccountId,
    clientAccountName,
    providerInstallationId: `provider-${suffix}`,
    externalPaymentId: `payment-${suffix}`,
    receiptAmountMinor: "500",
    refundableMinor: "500",
    referenceRefundMinor: "500",
    referenceOnly: true,
    currency: "USD",
    serviceId: null,
    termStart: null,
    termEnd: null,
    occurredAt,
  };
}

function refundRecord(clientAccountId: string, suffix: string) {
  return {
    refundId: `00000000-0000-4000-8000-0000000009${suffix}`,
    invoiceId: `00000000-0000-4000-8000-0000000008${suffix}`,
    clientAccountId,
    sourceContext: "allocated_invoice",
    receiptId: `00000000-0000-4000-8000-0000000007${suffix}`,
    destination: "original_payment",
    amountMode: "full",
    amountMinor: "500",
    currency: "USD",
    status: "manual",
    version: 1,
    securityHold: false,
    securityHoldReason: null,
    securityHoldCreatedAt: null,
    providerOperationStatus: "unknown",
    externalRefundId: null,
    lastError: "Synthetic query required",
    replayed: false,
  };
}

function ticketItem(subject: string, suffix: string) {
  return {
    id: `00000000-0000-4000-8000-000000000a${suffix}`,
    subject,
    status: "awaiting_staff",
    serviceId: null,
    productName: null,
    publicMessageCount: 1,
    internalMessageCount: 0,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

const refundReadPaths = [
  "/api/v1/admin/refund-candidates",
  "/api/v1/admin/refunds",
  "/api/v1/admin/refund-security-holds",
  "/api/v1/admin/refund-dismissal-corrections",
  "/api/v1/admin/refund-receipt-capacity-incidents",
];

async function installApi(
  page: Page,
  permissions: string[],
  interceptor?: Interceptor,
): Promise<RequestFact[]> {
  const requests: RequestFact[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push({ method: request.method(), path });
    if (interceptor && await interceptor(path, route)) return;
    if (path === "/api/v1/auth/me") {
      await route.fulfill({ json: viewer(permissions) });
      return;
    }
    if (path === "/api/v1/auth/login") {
      await route.fulfill({ json: {} });
      return;
    }
    if (path === "/api/v1/auth/reauth") {
      await route.fulfill({
        json: { expiresAt: "2026-08-10T00:15:00.000Z", fixedWindowMinutes: 15 },
      });
      return;
    }
    if (path === "/api/v1/catalog") {
      await route.fulfill({ json: { products: [] } });
      return;
    }
    if (path === "/api/v1/legal/current") {
      const document = { version: "mock-v1", title: "Mock terms", body: "Synthetic only." };
      await route.fulfill({
        json: { documents: { terms: document, aup: document, privacy: document } },
      });
      return;
    }
    if (
      path === "/api/v1/admin/manual-fulfillment" ||
      path === "/api/v1/admin/tickets" ||
      refundReadPaths.includes(path)
    ) {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    await route.fulfill({
      status: 501,
      json: { error: `Unexpected mock API request: ${request.method()} ${path}` },
    });
  });
  return requests;
}

function operationInterceptor(kind: OperationKind, includeBothAccounts: boolean): Interceptor {
  return async (path, route) => {
    if (path === "/api/v1/admin/manual-fulfillment" && kind === "manual_fulfillment") {
      await route.fulfill({
        json: {
          items: includeBothAccounts
            ? [manualItem(accountA, "Account Alpha", "01"), manualItem(accountB, "Account Beta", "02")]
            : [manualItem(accountA, "Account Alpha", "01")],
        },
      });
      return true;
    }
    if (kind === "refund" && path === "/api/v1/admin/refund-candidates") {
      await route.fulfill({
        json: {
          items: includeBothAccounts
            ? [refundCandidate(accountA, "Account Alpha", "01"), refundCandidate(accountB, "Account Beta", "02")]
            : [refundCandidate(accountA, "Account Alpha", "01")],
        },
      });
      return true;
    }
    if (kind === "refund" && path === "/api/v1/admin/refunds") {
      await route.fulfill({
        json: {
          items: includeBothAccounts
            ? [refundRecord(accountA, "01"), refundRecord(accountB, "02")]
            : [refundRecord(accountA, "01")],
        },
      });
      return true;
    }
    if (kind === "refund" && refundReadPaths.includes(path)) {
      await route.fulfill({ json: { items: [] } });
      return true;
    }
    if (kind === "ticket" && path === "/api/v1/admin/tickets") {
      await route.fulfill({
        json: {
          items: [{
            ...ticketItem("Account Alpha ticket", "01"),
            service: null,
            clientAccount: { id: accountA, name: "Account Alpha" },
          }],
        },
      });
      return true;
    }
    if (
      kind === "manual_receipt" &&
      path === `/api/v1/admin/client-accounts/${accountA}/manual-receipts`
    ) {
      await route.fulfill({
        json: { clientAccount: { id: accountA, name: "Account Alpha" }, items: [] },
      });
      return true;
    }
    return false;
  };
}

async function account360Interceptor(
  kind: OperationKind,
  path: string,
  route: Route,
): Promise<boolean> {
  if (path === "/api/v1/admin/client-accounts") {
    await route.fulfill({
      json: {
        warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
        items: [accountSearchItem(accountA, "Account Alpha"), accountSearchItem(accountB, "Account Beta")],
        limit: 20,
        hasMore: false,
        nextCursor: null,
      },
    });
    return true;
  }
  for (const [id, name] of [[accountA, "Account Alpha"], [accountB, "Account Beta"]] as const) {
    if (path === `/api/v1/admin/client-accounts/${id}/summary`) {
      await route.fulfill({ json: accountSummary(id, name) });
      return true;
    }
  }
  if (kind === "ticket" && path === `/api/v1/admin/client-accounts/${accountA}/tickets`) {
    await route.fulfill({
      json: {
        warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
        account: { id: accountA, name: "Account Alpha" },
        items: [ticketItem("Account Alpha ticket", "01")],
        limit: 25,
        hasMore: false,
        nextCursor: null,
      },
    });
    return true;
  }
  return false;
}

function adminGetPaths(requests: RequestFact[]): string[] {
  return [...new Set(
    requests
      .filter((request) => request.method === "GET" && request.path.startsWith("/api/v1/admin/"))
      .map((request) => request.path),
  )].sort();
}

for (const operation of operationCases) {
  test(`single ${operation.permission} Staff sees only its usable operation`, async ({ page }) => {
    const requests = await installApi(
      page,
      [operation.permission],
      operationInterceptor(operation.kind, false),
    );
    await page.goto("/admin");

    await expect(page.getByTestId("client-account-360")).toHaveCount(0);
    await expect(page.getByTestId("full-admin-workspace")).toHaveCount(0);
    await expect(page.locator(`[aria-label="${operation.panel}"]`)).toBeVisible();

    if (operation.kind === "manual_receipt") {
      const accountInput = page.getByLabel("Manual receipt Client Account ID");
      await expect(accountInput).toBeEditable();
      await accountInput.fill(accountA);
      await page.getByRole("button", { name: "Verify account & load history" }).click();
      await expect(page.getByTestId("manual-receipt-target")).toContainText("Account Alpha");
    } else if (operation.kind === "manual_fulfillment") {
      await expect(page.getByTestId("manual-fulfillment-item")).toContainText("Manual service 01");
    } else if (operation.kind === "refund") {
      await expect(page.getByTestId("refund-candidate")).toContainText("Account Alpha");
      await expect(page.getByTestId("refund-status")).toHaveCount(1);
    } else {
      await expect(page.getByTestId("staff-ticket-list")).toContainText("Account Alpha ticket");
    }

    for (const other of operationCases.filter((candidate) => candidate.kind !== operation.kind)) {
      await expect(page.locator(`[aria-label="${other.panel}"]`)).toHaveCount(0);
    }

    const expected = operation.kind === "manual_receipt"
      ? [`/api/v1/admin/client-accounts/${accountA}/manual-receipts`]
      : operation.kind === "manual_fulfillment"
        ? ["/api/v1/admin/manual-fulfillment"]
        : operation.kind === "refund"
          ? [...refundReadPaths].sort()
          : ["/api/v1/admin/tickets"];
    expect(adminGetPaths(requests)).toEqual(expected);
  });
}

for (const operation of operationCases) {
  test(`Account 360 fixes ${operation.permission} operations to the selected account`, async ({ page }) => {
    const requests = await installApi(
      page,
      ["accounts.view", operation.permission],
      async (path, route) => {
        if (await account360Interceptor(operation.kind, path, route)) return true;
        return operationInterceptor(operation.kind, true)(path, route);
      },
    );
    await page.goto("/admin");

    const account360 = page.getByTestId("client-account-360");
    await account360.getByLabel("Search Client Accounts").fill("Account");
    await account360.getByRole("button", { name: "Search accounts" }).click();
    await account360.getByTestId("account360-search-results")
      .getByRole("button", { name: /Account Alpha/ })
      .click();
    const actions = account360.getByLabel("Client Account actions");
    await expect(actions.getByRole("button")).toHaveCount(1);
    await actions.getByRole("button", { name: operation.action }).click();

    if (operation.kind === "ticket") {
      await expect(page.getByTestId("staff-ticket-account-context")).toContainText(accountA);
      await expect(page.getByTestId("staff-ticket-list")).toContainText("Account Alpha ticket");
      expect(adminGetPaths(requests)).not.toContain("/api/v1/admin/tickets");
    } else {
      await expect(page.getByTestId("admin-operation-account-context")).toContainText(accountA);
    }

    if (operation.kind === "manual_receipt") {
      const accountInput = page.getByLabel("Manual receipt Client Account ID");
      await expect(accountInput).toHaveValue(accountA);
      await expect(accountInput).toHaveAttribute("readonly", "");
      await page.getByRole("button", { name: "Verify account & load history" }).click();
      await expect(page.getByTestId("manual-receipt-target")).toContainText("Account Alpha");
    } else if (operation.kind === "manual_fulfillment") {
      await expect(page.getByTestId("manual-fulfillment-item")).toHaveCount(1);
      await expect(page.getByTestId("manual-fulfillment-item")).toContainText("Account Alpha");
      await expect(page.getByText("Account Beta", { exact: true })).toHaveCount(1);
    } else if (operation.kind === "refund") {
      await expect(page.getByTestId("refund-candidate")).toHaveCount(1);
      await expect(page.getByTestId("refund-candidate")).toContainText("Account Alpha");
      await expect(page.getByTestId("refund-status")).toHaveCount(1);
    }

    const forbidden = [
      "/api/v1/admin/billing/renewals",
      "/api/v1/admin/services/cancellations",
      "/api/v1/admin/funds/unclaimed",
      "/api/v1/admin/add-funds-chargebacks",
      `/api/v1/admin/client-accounts/${accountA}/orders`,
      `/api/v1/admin/client-accounts/${accountA}/billing`,
      `/api/v1/admin/client-accounts/${accountA}/services`,
      `/api/v1/admin/client-accounts/${accountA}/renewals`,
      `/api/v1/admin/client-accounts/${accountA}/cancellations`,
    ];
    expect(adminGetPaths(requests).filter((path) => forbidden.includes(path))).toEqual([]);
  });
}

test("switching Account 360 clears manual-receipt drafts and ignores the late old account", async ({ page }) => {
  let releaseHistory!: () => void;
  let markHistoryStarted!: () => void;
  let markHistoryFulfilled!: () => void;
  const historyGate = new Promise<void>((resolve) => { releaseHistory = resolve; });
  const historyStarted = new Promise<void>((resolve) => { markHistoryStarted = resolve; });
  const historyFulfilled = new Promise<void>((resolve) => { markHistoryFulfilled = resolve; });

  await installApi(
    page,
    ["accounts.view", "billing.manual_receipt_manage"],
    async (path, route) => {
      if (await account360Interceptor("manual_receipt", path, route)) return true;
      if (path === `/api/v1/admin/client-accounts/${accountA}/manual-receipts`) {
        markHistoryStarted();
        await historyGate;
        await route.fulfill({
          json: { clientAccount: { id: accountA, name: "Account Alpha" }, items: [] },
        });
        markHistoryFulfilled();
        return true;
      }
      return false;
    },
  );

  await page.goto("/admin");
  const account360 = page.getByTestId("client-account-360");
  await account360.getByLabel("Search Client Accounts").fill("Account");
  await account360.getByRole("button", { name: "Search accounts" }).click();
  const results = account360.getByTestId("account360-search-results");
  await results.getByRole("button", { name: /Account Alpha/ }).click();
  await account360.getByLabel("Client Account actions")
    .getByRole("button", { name: "Record manual receipt" })
    .click();
  await page.getByLabel("Operation password confirmation").fill("Synthetic-Reauth-Draft!");
  await page.getByLabel("Manual receipt reference").fill("ALPHA-DRAFT");
  await page.getByLabel("Manual receipt reason").fill("Synthetic Alpha evidence draft");
  await page.getByRole("button", { name: "Verify account & load history" }).click();
  await historyStarted;

  await results.getByRole("button", { name: /Account Beta/ }).click();
  await expect(page.getByLabel("Manual receipt Client Account ID")).toHaveValue("");
  await expect(page.getByLabel("Operation password confirmation")).toHaveValue("");
  await expect(page.getByLabel("Manual receipt reference")).toHaveValue("");
  await expect(page.getByLabel("Manual receipt reason")).toHaveValue("");
  await account360.getByLabel("Client Account actions")
    .getByRole("button", { name: "Record manual receipt" })
    .click();
  await expect(page.getByLabel("Manual receipt Client Account ID")).toHaveValue(accountB);

  releaseHistory();
  await historyFulfilled;
  await page.waitForTimeout(50);
  await expect(page.getByLabel("Manual receipt Client Account ID")).toHaveValue(accountB);
  await expect(page.getByTestId("manual-receipt-target")).toHaveCount(0);
  await expect(page.getByTestId("manual-receipt-history")).toHaveCount(0);
});

test("a delayed Account A refund completion cannot update or refetch Account B", async ({ page }) => {
  let releaseRefund!: () => void;
  let markRefundStarted!: () => void;
  let markRefundFulfilled!: () => void;
  const refundGate = new Promise<void>((resolve) => { releaseRefund = resolve; });
  const refundStarted = new Promise<void>((resolve) => { markRefundStarted = resolve; });
  const refundFulfilled = new Promise<void>((resolve) => { markRefundFulfilled = resolve; });
  const candidateA = refundCandidate(accountA, "Account Alpha", "01");
  const mutationPath = `/api/v1/admin/invoices/${candidateA.invoiceId}/refunds`;

  const requests = await installApi(
    page,
    ["accounts.view", "billing.refund_manage"],
    async (path, route) => {
      if (await account360Interceptor("refund", path, route)) return true;
      if (path === "/api/v1/admin/refunds") {
        await route.fulfill({ json: { items: [] } });
        return true;
      }
      if (path === mutationPath && route.request().method() === "POST") {
        markRefundStarted();
        await refundGate;
        await route.fulfill({
          json: {
            ...refundRecord(accountA, "01"),
            destination: "credit",
            status: "completed",
            providerOperationStatus: null,
            lastError: null,
          },
        });
        markRefundFulfilled();
        return true;
      }
      return operationInterceptor("refund", true)(path, route);
    },
  );

  await page.goto("/admin");
  const account360 = page.getByTestId("client-account-360");
  await account360.getByLabel("Search Client Accounts").fill("Account");
  await account360.getByRole("button", { name: "Search accounts" }).click();
  const results = account360.getByTestId("account360-search-results");
  await results.getByRole("button", { name: /Account Alpha/ }).click();
  await account360.getByLabel("Client Account actions")
    .getByRole("button", { name: "Open refund operations" })
    .click();
  await expect(page.getByTestId("refund-candidate")).toContainText("Account Alpha");
  await page.getByLabel("Operation password confirmation").fill("Synthetic-Refund-Reauth!");
  await page.getByLabel("Refund reason").fill("Synthetic refund decision evidence");
  await page.getByTestId("refund-candidate")
    .getByRole("button", { name: "Refund to Credit" })
    .click();
  await refundStarted;

  await results.getByRole("button", { name: /Account Beta/ }).click();
  await account360.getByLabel("Client Account actions")
    .getByRole("button", { name: "Open refund operations" })
    .click();
  await expect(page.getByTestId("refund-candidate")).toContainText("Account Beta");
  await page.getByLabel("Operation password confirmation").fill("Synthetic-Beta-Reauth!");
  await page.getByLabel("Refund reason").fill("Synthetic Beta decision evidence");
  const betaRefundButton = page.getByTestId("refund-candidate")
    .getByRole("button", { name: "Refund to Credit" });
  await expect(betaRefundButton).toBeEnabled();
  const candidateReadsBeforeRelease = requests.filter(
    (request) => request.method === "GET" && request.path === "/api/v1/admin/refund-candidates",
  ).length;

  releaseRefund();
  await refundFulfilled;
  await page.waitForTimeout(50);
  await expect(page.getByTestId("refund-candidate")).toContainText("Account Beta");
  await expect(page.getByTestId("refund-status")).toHaveCount(0);
  await expect(betaRefundButton).toBeEnabled();
  await expect(page.getByText("Refund confirmed as Credit with one balanced journal.", { exact: true }))
    .toHaveCount(0);
  await expect(page.locator(".notice.error")).toHaveCount(0);
  expect(requests.filter(
    (request) => request.method === "GET" && request.path === "/api/v1/admin/refund-candidates",
  )).toHaveLength(candidateReadsBeforeRelease);
});

test("same Staff permissions in a different order keep the in-flight operation queue valid", async ({ page }) => {
  let meReads = 0;
  let queueReads = 0;
  let releaseQueue!: () => void;
  let markQueueStarted!: () => void;
  const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const queueStarted = new Promise<void>((resolve) => { markQueueStarted = resolve; });

  await installApi(
    page,
    ["accounts.view", "services.manual_fulfillment"],
    async (path, route) => {
      if (path === "/api/v1/auth/me") {
        meReads += 1;
        const permissions = meReads % 2 === 0
          ? ["services.manual_fulfillment", "accounts.view"]
          : ["accounts.view", "services.manual_fulfillment"];
        await route.fulfill({ json: viewer(permissions) });
        return true;
      }
      if (await account360Interceptor("manual_fulfillment", path, route)) return true;
      if (path === "/api/v1/admin/manual-fulfillment") {
        queueReads += 1;
        markQueueStarted();
        await queueGate;
        await route.fulfill({
          json: { items: [manualItem(accountA, "Account Alpha", "01")] },
        });
        return true;
      }
      return false;
    },
  );

  await page.goto("/admin");
  await queueStarted;
  const account360 = page.getByTestId("client-account-360");
  await account360.getByLabel("Search Client Accounts").fill("Account");
  await account360.getByRole("button", { name: "Search accounts" }).click();
  await account360.getByRole("button", { name: /Account Alpha/ }).click();
  await account360.getByLabel("Client Account actions")
    .getByRole("button", { name: "Open manual fulfillment" })
    .click();

  const readsBeforeRefresh = meReads;
  await account360.getByRole("button", { name: "Refresh Staff access" }).click();
  await expect.poll(() => meReads).toBeGreaterThan(readsBeforeRefresh);
  releaseQueue();

  await expect(page.getByTestId("manual-fulfillment-item")).toContainText("Manual service 01");
  expect(queueReads).toBe(1);
});

test("changing Staff principal clears context and rejects the prior principal queue", async ({ page }) => {
  let useSecondPrincipal = false;
  let queueReads = 0;
  let releaseFirstQueue!: () => void;
  let markFirstQueueStarted!: () => void;
  const firstQueueGate = new Promise<void>((resolve) => { releaseFirstQueue = resolve; });
  const firstQueueStarted = new Promise<void>((resolve) => { markFirstQueueStarted = resolve; });

  await installApi(
    page,
    ["accounts.view", "services.manual_fulfillment"],
    async (path, route) => {
      if (path === "/api/v1/auth/me") {
        const currentViewer = viewer(["accounts.view", "services.manual_fulfillment"]);
        await route.fulfill({
          json: {
            ...currentViewer,
            id: useSecondPrincipal
              ? "00000000-0000-4000-8000-000000000497"
              : currentViewer.id,
            email: useSecondPrincipal
              ? "second-operation-staff@example.invalid"
              : currentViewer.email,
          },
        });
        return true;
      }
      if (await account360Interceptor("manual_fulfillment", path, route)) return true;
      if (path === "/api/v1/admin/manual-fulfillment") {
        queueReads += 1;
        if (queueReads === 1) {
          markFirstQueueStarted();
          await firstQueueGate;
          await route.fulfill({
            json: { items: [manualItem(accountA, "Account Alpha", "01")] },
          });
        } else {
          await route.fulfill({ json: { items: [] } });
        }
        return true;
      }
      return false;
    },
  );

  await page.goto("/admin");
  await firstQueueStarted;
  const account360 = page.getByTestId("client-account-360");
  await account360.getByLabel("Search Client Accounts").fill("Account");
  await account360.getByRole("button", { name: "Search accounts" }).click();
  await account360.getByRole("button", { name: /Account Alpha/ }).click();
  await account360.getByLabel("Client Account actions")
    .getByRole("button", { name: "Open manual fulfillment" })
    .click();
  await expect(page.getByTestId("admin-operation-account-context")).toContainText(accountA);

  useSecondPrincipal = true;
  await account360.getByRole("button", { name: "Refresh Staff access" }).click();
  await expect(page.getByTestId("admin-operation-account-context")).toHaveCount(0);
  await expect.poll(() => queueReads).toBeGreaterThanOrEqual(2);
  releaseFirstQueue();
  await page.waitForTimeout(50);

  await expect(page.getByTestId("manual-fulfillment-item")).toHaveCount(0);
  await expect(page.getByText("Manual service 01", { exact: true })).toHaveCount(0);
});

for (const statusChange of ["ineligible", "inactive"] as const) {
  test(`changing Staff to ${statusChange} invalidates the pending operation queue`, async ({ page }) => {
    let accessChanged = false;
    let releaseQueue!: () => void;
    let markQueueStarted!: () => void;
    const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });
    const queueStarted = new Promise<void>((resolve) => { markQueueStarted = resolve; });

    await installApi(
      page,
      ["accounts.view", "services.manual_fulfillment"],
      async (path, route) => {
        if (path === "/api/v1/auth/me") {
          const currentViewer = viewer(["accounts.view", "services.manual_fulfillment"]);
          await route.fulfill({
            json: accessChanged
              ? {
                  ...currentViewer,
                  eligible: statusChange === "ineligible" ? false : currentViewer.eligible,
                  staff: statusChange === "inactive" ? null : currentViewer.staff,
                }
              : currentViewer,
          });
          return true;
        }
        if (await account360Interceptor("manual_fulfillment", path, route)) return true;
        if (path === "/api/v1/admin/manual-fulfillment") {
          markQueueStarted();
          await queueGate;
          await route.fulfill({
            json: { items: [manualItem(accountA, "Account Alpha", "01")] },
          });
          return true;
        }
        return false;
      },
    );

    await page.goto("/admin");
    await queueStarted;
    const account360 = page.getByTestId("client-account-360");
    await account360.getByLabel("Search Client Accounts").fill("Account");
    await account360.getByRole("button", { name: "Search accounts" }).click();
    await account360.getByRole("button", { name: /Account Alpha/ }).click();
    await account360.getByLabel("Client Account actions")
      .getByRole("button", { name: "Open manual fulfillment" })
      .click();

    accessChanged = true;
    await account360.getByRole("button", { name: "Refresh Staff access" }).click();
    await expect(page.getByTestId("permission-admin-operations")).toHaveCount(0);
    await expect(page.locator('[aria-label="Manual fulfillment queue"]')).toHaveCount(0);
    releaseQueue();
    await page.waitForTimeout(50);
    await expect(page.getByTestId("manual-fulfillment-item")).toHaveCount(0);
  });
}

test("revoking an operation permission immediately unmounts it and ignores its late queue", async ({ page }) => {
  let revoked = false;
  let releaseQueue!: () => void;
  let markQueueStarted!: () => void;
  const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const queueStarted = new Promise<void>((resolve) => { markQueueStarted = resolve; });

  const requests = await installApi(
    page,
    ["accounts.view", "services.manual_fulfillment"],
    async (path, route) => {
      if (path === "/api/v1/auth/me") {
        await route.fulfill({
          json: viewer(revoked ? ["accounts.view"] : ["accounts.view", "services.manual_fulfillment"]),
        });
        return true;
      }
      if (await account360Interceptor("manual_fulfillment", path, route)) return true;
      if (path === "/api/v1/admin/manual-fulfillment") {
        markQueueStarted();
        await queueGate;
        await route.fulfill({
          json: { items: [manualItem(accountA, "Account Alpha", "01")] },
        });
        return true;
      }
      return false;
    },
  );

  await page.goto("/admin");
  await queueStarted;
  const account360 = page.getByTestId("client-account-360");
  await account360.getByLabel("Search Client Accounts").fill("Account");
  await account360.getByRole("button", { name: "Search accounts" }).click();
  await account360.getByRole("button", { name: /Account Alpha/ }).click();
  await account360.getByLabel("Client Account actions")
    .getByRole("button", { name: "Open manual fulfillment" })
    .click();
  await expect(page.getByTestId("admin-operation-account-context")).toContainText(accountA);

  revoked = true;
  await account360.getByRole("button", { name: "Refresh Staff access" }).click();
  await expect(page.getByTestId("permission-admin-operations")).toHaveCount(0);
  await expect(page.locator('[aria-label="Manual fulfillment queue"]')).toHaveCount(0);
  releaseQueue();
  await page.waitForTimeout(50);
  await expect(page.getByTestId("manual-fulfillment-item")).toHaveCount(0);
  expect(requests.filter((request) => request.path === "/api/v1/admin/manual-fulfillment"))
    .toHaveLength(1);
});

test("an accounts.view-only Staff login routes directly to Admin", async ({ page }) => {
  await installApi(page, ["accounts.view"]);
  await page.goto("/");
  const signInForm = page.locator("form").filter({
    has: page.getByRole("heading", { name: "Sign in", exact: true }),
  });
  await signInForm.getByPlaceholder("Email").fill("account-reader@example.invalid");
  await signInForm.getByPlaceholder("Password").fill("Synthetic-Account-Reader!");
  await signInForm.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByTestId("client-account-360")).toBeVisible();
  await expect(page.getByTestId("permission-admin-operations")).toHaveCount(0);
});
