// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Page, type Route } from "@playwright/test";

const accountA = "00000000-0000-4000-8000-000000000401";
const accountB = "00000000-0000-4000-8000-000000000402";
const occurredAt = "2026-08-10T00:00:00.000Z";

type OperationKind = "manual_receipt" | "refund" | "ticket" | "manual_fulfillment";
type RequestFact = { method: string; path: string; query: string; body: string | null };
type Interceptor = (path: string, route: Route) => Promise<boolean>;
let unexpectedRequests: RequestFact[] = [];

test.beforeEach(() => {
  unexpectedRequests = [];
});

test.afterEach(() => {
  expect(unexpectedRequests, "unexpected API requests").toEqual([]);
});

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

function manualReceiptItem(
  suffix: string,
  options: { unknownReport?: boolean } = {},
) {
  const reportId = `00000000-0000-4000-8000-000000000b${suffix}`;
  return {
    manualReceiptId: `00000000-0000-4000-8000-000000000c${suffix}`,
    fundReceiptId: `00000000-0000-4000-8000-000000000d${suffix}`,
    reference: `MANUAL-${suffix}`,
    receivedAt: occurredAt,
    grossAmountMinor: "500",
    feeMinor: "0",
    netAmountMinor: "500",
    allocatedMinor: "0",
    availableMinor: "500",
    capacityFrozen: options.unknownReport === true,
    currency: "USD",
    disposition: "unclaimed",
    originalSourceOutflow: {
      sourceContext: "unclaimed_funds",
      sourceAmountMinor: "500",
      confirmedOutflowMinor: "0",
      availableMinor: options.unknownReport === true ? "0" : "500",
      capacityFrozen: options.unknownReport === true,
      reports: options.unknownReport === true
        ? [{
            outflowReportId: reportId,
            outflowId: null,
            amountMinor: "500",
            currency: "USD",
            destination: "original_source",
            destinationReference: `RETURN-${suffix}`,
            observedOutcome: "unknown",
            status: "unknown",
            occurredAt: null,
            actorId: accountA,
            reason: "Synthetic unknown outflow evidence",
            createdAt: occurredAt,
            reconciliation: null,
          }]
        : [],
    },
    reversal: null,
    actorId: accountA,
    reason: "Synthetic manual receipt evidence",
    createdAt: occurredAt,
  };
}

function refundHold(clientAccountId: string, clientAccountName: string, suffix: string) {
  const providerFact = {
    factId: `00000000-0000-4000-8000-000000000e${suffix}`,
    eventId: `event-${suffix}`,
    externalRefundId: `external-refund-${suffix}`,
    status: "succeeded",
    amountMinor: "500",
    currency: "USD",
    occurredAt,
  };
  return {
    holdId: `00000000-0000-4000-8000-000000000f${suffix}`,
    receiptId: `00000000-0000-4000-8000-0000000007${suffix}`,
    receiptAmountMinor: "500",
    receiptAllocatedMinor: "500",
    confirmedSettlementMinor: "0",
    refundId: `00000000-0000-4000-8000-0000000009${suffix}`,
    invoiceId: `00000000-0000-4000-8000-0000000008${suffix}`,
    sourceContext: "allocated_invoice",
    clientAccountId,
    clientAccountName,
    refundStatus: "security_hold",
    refundVersion: 1,
    refundAmountMinor: "500",
    refundCurrency: "USD",
    reason: "Synthetic provider fact requires adjudication",
    createdAt: occurredAt,
    providerFact,
    providerFacts: [providerFact],
    discrepancy: null,
    allowedDecisions: ["dismiss_provider_claim"],
    impact: { dismissProviderClaim: "Synthetic dismissal preserves immutable evidence." },
  };
}

function refundCorrection(clientAccountId: string, clientAccountName: string, suffix: string) {
  return {
    adjudicationId: `00000000-0000-4000-8000-0000000010${suffix}`,
    holdId: `00000000-0000-4000-8000-000000000f${suffix}`,
    refundId: `00000000-0000-4000-8000-0000000009${suffix}`,
    refundVersion: 1,
    invoiceId: `00000000-0000-4000-8000-0000000008${suffix}`,
    clientAccountId,
    clientAccountName,
    receiptId: `00000000-0000-4000-8000-0000000007${suffix}`,
    providerInstallationId: `provider-${suffix}`,
    providerFact: {
      factId: `00000000-0000-4000-8000-000000000e${suffix}`,
      eventId: `event-${suffix}`,
      externalRefundId: `external-refund-${suffix}`,
      amountMinor: "500",
      currency: "USD",
      occurredAt,
    },
    discrepancyId: null,
    dismissalReason: "Synthetic prior dismissal",
    dismissedAt: occurredAt,
    impact: "Synthetic correction restores the later confirmed outflow.",
  };
}

function refundCapacityIncident(
  clientAccountId: string,
  clientAccountName: string,
  suffix: string,
) {
  return {
    incidentId: `00000000-0000-4000-8000-0000000011${suffix}`,
    receiptId: `00000000-0000-4000-8000-0000000007${suffix}`,
    receiptSequence: suffix,
    source: {
      type: "dismissal_correction",
      correctionId: `00000000-0000-4000-8000-0000000010${suffix}`,
    },
    refundId: `00000000-0000-4000-8000-0000000009${suffix}`,
    invoiceId: `00000000-0000-4000-8000-0000000008${suffix}`,
    sourceContext: "allocated_invoice",
    clientAccountId,
    clientAccountName,
    receiptAllocatedMinor: "500",
    allocatedContributionMinor: "500",
    confirmedProviderOutflowMinor: "500",
    confirmedDispositionMinor: "1000",
    confirmedCompensationMinor: "500",
    receiptAmountMinor: "500",
    overageMinor: "500",
    currency: "USD",
    reason: "Synthetic receipt capacity overage",
    createdAt: occurredAt,
    isCurrentSnapshot: true,
    status: "awaiting_acknowledgement",
    acknowledgement: null,
    requiresReauthentication: true,
    allowedAction: "acknowledge_manual_recovery",
    impact: "Synthetic manual recovery remains required.",
  };
}

function barrier() {
  let release!: () => void;
  let arrive!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  return { gate, reached, release, arrive };
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

function staffTicketDetail(subject: string, suffix: string) {
  return {
    ticket: {
      ...ticketItem(subject, suffix),
      service: null,
      clientAccount: { id: accountA, name: "Account Alpha" },
    },
    messages: [{
      id: `00000000-0000-4000-8000-0000000013${suffix}`,
      authorType: "customer",
      visibility: "public",
      authorEmail: "account-alpha@example.invalid",
      body: "Synthetic customer opening message",
      createdAt: occurredAt,
    }],
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
    const url = new URL(request.url());
    const path = url.pathname;
    const fact = {
      method: request.method(),
      path,
      query: url.search,
      body: request.postData(),
    };
    requests.push(fact);
    if (interceptor && await interceptor(path, route)) return;
    if (path === "/api/v1/auth/me") {
      await route.fulfill({ json: viewer(permissions) });
      return;
    }
    if (path === "/api/v1/auth/login") {
      await route.fulfill({ json: {} });
      return;
    }
    if (path === "/api/v1/auth/logout") {
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
    unexpectedRequests.push(fact);
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

async function openAccountOperation(
  page: Page,
  accountName: "Account Alpha" | "Account Beta",
  action: string,
) {
  const account360 = page.getByTestId("client-account-360");
  if (await account360.getByTestId("account360-search-results").count() === 0) {
    await account360.getByLabel("Search Client Accounts").fill("Account");
    await account360.getByRole("button", { name: "Search accounts" }).click();
  }
  await account360.getByTestId("account360-search-results")
    .getByRole("button", { name: new RegExp(accountName) })
    .click();
  await account360.getByLabel("Client Account actions")
    .getByRole("button", { name: action })
    .click();
  return account360;
}

async function loadManualReceiptHistory(page: Page) {
  await page.getByRole("button", { name: "Verify account & load history" }).click();
  await expect(page.getByTestId("manual-receipt-target")).toBeVisible();
}

type RefundMutationKind =
  | "decision"
  | "hold"
  | "manual_action"
  | "correction"
  | "capacity";

function refundMutationButton(page: Page, kind: RefundMutationKind) {
  if (kind === "decision") {
    return page.getByTestId("refund-candidate")
      .getByRole("button", { name: "Refund to Credit" });
  }
  if (kind === "hold") {
    return page.getByTestId("refund-security-hold")
      .getByRole("button", { name: "Dismiss Provider claim" });
  }
  if (kind === "manual_action") {
    return page.getByTestId("refund-status")
      .getByRole("button", { name: "Retry Provider query only" });
  }
  if (kind === "correction") {
    return page.getByTestId("refund-dismissal-correction")
      .getByRole("button", { name: "Confirm later evidence of outflow" });
  }
  return page.getByTestId("refund-receipt-capacity-incident")
    .getByRole("button", { name: "Acknowledge and take manual recovery" });
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

test("same Staff permissions in a different order keep an in-flight manual history valid", async ({ page }) => {
  let meReads = 0;
  const history = barrier();

  await installApi(
    page,
    ["accounts.view", "billing.manual_receipt_manage"],
    async (path, route) => {
      if (path === "/api/v1/auth/me") {
        meReads += 1;
        const permissions = meReads % 2 === 0
          ? ["billing.manual_receipt_manage", "accounts.view"]
          : ["accounts.view", "billing.manual_receipt_manage"];
        await route.fulfill({ json: viewer(permissions) });
        return true;
      }
      if (await account360Interceptor("manual_receipt", path, route)) return true;
      if (path === `/api/v1/admin/client-accounts/${accountA}/manual-receipts`) {
        history.arrive();
        await history.gate;
        await route.fulfill({
          json: {
            clientAccount: { id: accountA, name: "Account Alpha" },
            items: [manualReceiptItem("01")],
          },
        });
        return true;
      }
      return false;
    },
  );

  await page.goto("/admin");
  const account360 = await openAccountOperation(
    page,
    "Account Alpha",
    "Record manual receipt",
  );
  await page.getByRole("button", { name: "Verify account & load history" }).click();
  await history.reached;

  const readsBeforeRefresh = meReads;
  await account360.getByRole("button", { name: "Refresh Staff access" }).click();
  await expect.poll(() => meReads).toBeGreaterThan(readsBeforeRefresh);
  history.release();

  await expect(page.getByTestId("manual-receipt-history-item")).toContainText("MANUAL-01");
  await expect(page.getByRole("button", { name: "Verify account & load history" })).toBeEnabled();
});

for (const manualMutation of ["record", "reversal"] as const) {
  test(`same-principal permission reorder does not strand manual ${manualMutation}`, async ({ page }) => {
    let meReads = 0;
    const reauth = barrier();
    const receipt = manualReceiptItem("01");
    const historyPath = `/api/v1/admin/client-accounts/${accountA}/manual-receipts`;
    const mutationPath = manualMutation === "record"
      ? historyPath
      : `${historyPath}/${receipt.manualReceiptId}/reversal`;
    const requests = await installApi(
      page,
      ["accounts.view", "billing.manual_receipt_manage", "billing.unclaimed_manage"],
      async (path, route) => {
        if (path === "/api/v1/auth/me") {
          meReads += 1;
          const permissions = meReads % 2 === 0
            ? ["billing.unclaimed_manage", "billing.manual_receipt_manage", "accounts.view"]
            : ["accounts.view", "billing.manual_receipt_manage", "billing.unclaimed_manage"];
          await route.fulfill({ json: viewer(permissions) });
          return true;
        }
        if (path === historyPath && route.request().method() === "GET") {
          await route.fulfill({
            json: {
              clientAccount: { id: accountA, name: "Account Alpha" },
              items: manualMutation === "reversal" ? [receipt] : [],
            },
          });
          return true;
        }
        if (path === "/api/v1/auth/reauth" && route.request().method() === "POST") {
          reauth.arrive();
          await reauth.gate;
          await route.fulfill({
            json: { expiresAt: "2026-08-10T00:15:00.000Z", fixedWindowMinutes: 15 },
          });
          return true;
        }
        if (path === mutationPath && route.request().method() === "POST") {
          await route.fulfill({
            json: manualMutation === "record"
              ? {
                  manualReceiptId: receipt.manualReceiptId,
                  fundReceiptId: receipt.fundReceiptId,
                  clientAccountId: accountA,
                  reference: "SYNTHETIC-REORDER-RECEIPT",
                  receivedAt: occurredAt,
                  grossAmountMinor: "10000",
                  feeMinor: "0",
                  netAmountMinor: "10000",
                  currency: "USD",
                  disposition: "unclaimed",
                  allocatedMinor: "0",
                  providerUsed: false,
                  replayed: false,
                }
              : {
                  reversalId: "00000000-0000-4000-8000-000000001202",
                  manualReceiptId: receipt.manualReceiptId,
                  fundReceiptId: receipt.fundReceiptId,
                  clientAccountId: accountA,
                  grossAmountMinor: "500",
                  feeMinor: "0",
                  netAmountMinor: "500",
                  currency: "USD",
                  disposition: "reversed",
                  providerUsed: false,
                  cashOutflow: false,
                  replayed: false,
                },
          });
          return true;
        }
        if (await account360Interceptor("manual_receipt", path, route)) return true;
        return false;
      },
    );

    await page.goto("/admin");
    const account360 = await openAccountOperation(
      page,
      "Account Alpha",
      "Record manual receipt",
    );
    await loadManualReceiptHistory(page);
    await page.getByLabel("Operation password confirmation").fill("Synthetic-Reorder-Reauth!");
    if (manualMutation === "record") {
      await page.getByLabel("Manual receipt reference").fill("SYNTHETIC-REORDER-RECEIPT");
      await page.getByLabel("Manual receipt reason")
        .fill("Synthetic same-principal permission reorder evidence");
      await page.getByTestId("permission-admin-operations")
        .getByRole("button", { name: "Record manual receipt", exact: true })
        .click();
    } else {
      await page.getByRole("button", { name: "Review reversal" }).click();
      await page.getByLabel("Manual receipt reversal reason")
        .fill("Synthetic same-principal reversal reorder evidence");
      await page.getByRole("button", { name: "Reverse incorrect receipt" }).click();
    }
    await reauth.reached;

    const readsBeforeRefresh = meReads;
    await account360.getByRole("button", { name: "Refresh Staff access" }).click();
    await expect.poll(() => meReads).toBeGreaterThan(readsBeforeRefresh);
    const mutationResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === mutationPath &&
      response.request().method() === "POST",
    );
    reauth.release();
    await mutationResponse;

    if (manualMutation === "record") {
      await expect(page.getByTestId("manual-receipt-outcome")).toBeVisible();
      await expect(page.getByTestId("permission-admin-operations")
        .getByRole("button", { name: "Record manual receipt", exact: true })).toBeVisible();
      await expect(page.getByLabel("Manual receipt reference")).toBeEditable();
    } else {
      await expect(page.getByTestId("manual-receipt-reversal-outcome")).toBeVisible();
      await expect(page.getByRole("button", { name: "Review reversal" })).toBeEnabled();
    }
    expect(requests.filter((request) =>
      request.method === "POST" && request.path === mutationPath
    )).toHaveLength(1);
    await expect(page.getByLabel("Operation password confirmation")).toHaveValue("");
  });
}

test("changing Staff principal during reversal reauth prevents the old principal POST", async ({ page }) => {
  let secondPrincipal = false;
  let reversalPosts = 0;
  const reauth = barrier();
  const receipt = manualReceiptItem("01");
  const reversalPath =
    `/api/v1/admin/client-accounts/${accountA}/manual-receipts/${receipt.manualReceiptId}/reversal`;
  const requests = await installApi(
    page,
    ["accounts.view", "billing.manual_receipt_manage", "billing.unclaimed_manage"],
    async (path, route) => {
      if (path === "/api/v1/auth/me") {
        const current = viewer([
          "accounts.view",
          "billing.manual_receipt_manage",
          "billing.unclaimed_manage",
        ]);
        await route.fulfill({
          json: secondPrincipal
            ? {
                ...current,
                id: "00000000-0000-4000-8000-000000000496",
                email: "replacement-money-staff@example.invalid",
              }
            : current,
        });
        return true;
      }
      if (await account360Interceptor("manual_receipt", path, route)) return true;
      if (path === `/api/v1/admin/client-accounts/${accountA}/manual-receipts`) {
        await route.fulfill({
          json: {
            clientAccount: { id: accountA, name: "Account Alpha" },
            items: [receipt],
          },
        });
        return true;
      }
      if (path === "/api/v1/auth/reauth" && route.request().method() === "POST") {
        reauth.arrive();
        await reauth.gate;
        await route.fulfill({
          json: { expiresAt: "2026-08-10T00:15:00.000Z", fixedWindowMinutes: 15 },
        });
        return true;
      }
      if (path === reversalPath && route.request().method() === "POST") {
        reversalPosts += 1;
        await route.fulfill({
          json: {
            reversalId: "00000000-0000-4000-8000-000000001201",
            manualReceiptId: receipt.manualReceiptId,
            fundReceiptId: receipt.fundReceiptId,
            clientAccountId: accountA,
            grossAmountMinor: "500",
            feeMinor: "0",
            netAmountMinor: "500",
            currency: "USD",
            disposition: "reversed",
            providerUsed: false,
            cashOutflow: false,
            replayed: false,
          },
        });
        return true;
      }
      return false;
    },
  );

  await page.goto("/admin");
  const account360 = await openAccountOperation(
    page,
    "Account Alpha",
    "Record manual receipt",
  );
  await loadManualReceiptHistory(page);
  await page.getByRole("button", { name: "Review reversal" }).click();
  await page.getByLabel("Manual receipt reversal reason")
    .fill("Synthetic independent evidence proves the receipt was mistaken");
  await page.getByLabel("Operation password confirmation").fill("Synthetic-Reversal-Reauth!");
  await page.getByRole("button", { name: "Reverse incorrect receipt" }).click();
  await reauth.reached;

  secondPrincipal = true;
  await account360.getByRole("button", { name: "Refresh Staff access" }).click();
  await expect(page.getByTestId("admin-operation-account-context")).toHaveCount(0);
  const reauthResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/v1/auth/reauth",
  );
  reauth.release();
  await reauthResponse;

  expect(reversalPosts).toBe(0);
  expect(requests.filter((request) => request.path === reversalPath)).toEqual([]);
  await expect(page.getByTestId("manual-receipt-reversal-outcome")).toHaveCount(0);
});

for (const accessChange of ["principal", "revocation"] as const) {
  test(`a delayed ticket reply cannot survive Staff ${accessChange}`, async ({ page }) => {
    let changed = false;
    const reply = barrier();
    const ticket = staffTicketDetail("Account Alpha ticket", "01");
    const messagePath = `/api/v1/admin/tickets/${ticket.ticket.id}/messages`;
    const requests = await installApi(
      page,
      ["accounts.view", "support.tickets.manage"],
      async (path, route) => {
        if (path === "/api/v1/auth/me") {
          const permissions = changed && accessChange === "revocation"
            ? ["accounts.view"]
            : ["accounts.view", "support.tickets.manage"];
          const current = viewer(permissions);
          await route.fulfill({
            json: changed && accessChange === "principal"
              ? {
                  ...current,
                  id: "00000000-0000-4000-8000-000000000495",
                  email: "replacement-ticket-staff@example.invalid",
                }
              : current,
          });
          return true;
        }
        if (await account360Interceptor("ticket", path, route)) return true;
        if (path === `/api/v1/admin/tickets/${ticket.ticket.id}`) {
          await route.fulfill({ json: ticket });
          return true;
        }
        if (path === messagePath && route.request().method() === "POST") {
          reply.arrive();
          await reply.gate;
          await route.fulfill({
            json: {
              ...ticket,
              messages: [
                ...ticket.messages,
                {
                  id: "00000000-0000-4000-8000-000000001401",
                  authorType: "staff",
                  visibility: "public",
                  authorEmail: "operation-staff@example.invalid",
                  body: "Synthetic delayed staff reply",
                  createdAt: occurredAt,
                },
              ],
            },
          });
          return true;
        }
        return false;
      },
    );

    await page.goto("/admin");
    const account360 = await openAccountOperation(
      page,
      "Account Alpha",
      "Open ticket operations",
    );
    await page.getByTestId("staff-ticket-list")
      .getByRole("button", { name: /Account Alpha ticket/ })
      .click();
    await expect(page.getByTestId("staff-ticket-thread")).toBeVisible();
    await page.getByLabel("Staff ticket message").fill("Synthetic delayed staff reply");
    await page.getByRole("button", { name: "Send public reply" }).click();
    await reply.reached;

    changed = true;
    await account360.getByRole("button", { name: "Refresh Staff access" }).click();
    await expect(page.getByTestId("staff-ticket-thread")).toHaveCount(0);
    const scopedReadsBeforeRelease = requests.filter((request) =>
      request.method === "GET" &&
      request.path === `/api/v1/admin/client-accounts/${accountA}/tickets`
    ).length;
    const replyResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === messagePath,
    );
    reply.release();
    await replyResponse;

    expect(requests.filter((request) =>
      request.method === "GET" &&
      request.path === `/api/v1/admin/client-accounts/${accountA}/tickets`
    )).toHaveLength(scopedReadsBeforeRelease);
    await expect(page.getByText("Public reply sent.", { exact: true })).toHaveCount(0);
    await expect(page.locator(".notice.error")).toHaveCount(0);
  });
}

test("switching Account A to B during manual-receipt reauth prevents the Account A POST", async ({ page }) => {
  const reauth = barrier();
  let recordPosts = 0;
  const recordPath = `/api/v1/admin/client-accounts/${accountA}/manual-receipts`;
  const requests = await installApi(
    page,
    ["accounts.view", "billing.manual_receipt_manage"],
    async (path, route) => {
      if (
        path === `/api/v1/admin/client-accounts/${accountA}/manual-receipts` &&
        route.request().method() === "GET"
      ) {
        await route.fulfill({
          json: { clientAccount: { id: accountA, name: "Account Alpha" }, items: [] },
        });
        return true;
      }
      if (path === "/api/v1/auth/reauth" && route.request().method() === "POST") {
        reauth.arrive();
        await reauth.gate;
        await route.fulfill({
          json: { expiresAt: "2026-08-10T00:15:00.000Z", fixedWindowMinutes: 15 },
        });
        return true;
      }
      if (path === recordPath && route.request().method() === "POST") {
        recordPosts += 1;
        await route.fulfill({ json: {} });
        return true;
      }
      if (await account360Interceptor("manual_receipt", path, route)) return true;
      return false;
    },
  );

  await page.goto("/admin");
  const account360 = await openAccountOperation(
    page,
    "Account Alpha",
    "Record manual receipt",
  );
  await loadManualReceiptHistory(page);
  await page.getByLabel("Manual receipt reference").fill("SYNTHETIC-A-RECEIPT");
  await page.getByLabel("Manual receipt reason")
    .fill("Synthetic independent evidence for Account Alpha receipt");
  await page.getByLabel("Operation password confirmation").fill("Synthetic-Record-Reauth!");
  await page.getByTestId("permission-admin-operations")
    .getByRole("button", { name: "Record manual receipt", exact: true })
    .click();
  await reauth.reached;

  await account360.getByTestId("account360-search-results")
    .getByRole("button", { name: /Account Beta/ })
    .click();
  await account360.getByLabel("Client Account actions")
    .getByRole("button", { name: "Record manual receipt" })
    .click();
  await expect(page.getByLabel("Manual receipt Client Account ID")).toHaveValue(accountB);
  const reauthResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/v1/auth/reauth",
  );
  reauth.release();
  await reauthResponse;

  expect(recordPosts).toBe(0);
  expect(requests.filter((request) =>
    request.method === "POST" && request.path === recordPath
  )).toEqual([]);
  await expect(page.getByLabel("Manual receipt reference")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Verify account & load history" })).toBeEnabled();
});

test("signing out during manual-receipt reauth prevents the abandoned POST", async ({ page }) => {
  const reauth = barrier();
  const recordPath = `/api/v1/admin/client-accounts/${accountA}/manual-receipts`;
  const requests = await installApi(
    page,
    ["accounts.view", "billing.manual_receipt_manage"],
    async (path, route) => {
      if (
        path === recordPath &&
        route.request().method() === "GET"
      ) {
        await route.fulfill({
          json: { clientAccount: { id: accountA, name: "Account Alpha" }, items: [] },
        });
        return true;
      }
      if (path === "/api/v1/auth/reauth" && route.request().method() === "POST") {
        reauth.arrive();
        await reauth.gate;
        try {
          await route.fulfill({
            json: { expiresAt: "2026-08-10T00:15:00.000Z", fixedWindowMinutes: 15 },
          });
        } catch {
          // The hard sign-out navigation is allowed to abort the old document's reauth request.
        }
        return true;
      }
      if (path === recordPath && route.request().method() === "POST") {
        await route.fulfill({ json: {} });
        return true;
      }
      if (await account360Interceptor("manual_receipt", path, route)) return true;
      return false;
    },
  );

  await page.goto("/admin");
  await openAccountOperation(page, "Account Alpha", "Record manual receipt");
  await loadManualReceiptHistory(page);
  await page.getByLabel("Manual receipt reference").fill("SYNTHETIC-LOGOUT-RECEIPT");
  await page.getByLabel("Manual receipt reason")
    .fill("Synthetic independent evidence for the logout race");
  await page.getByLabel("Operation password confirmation").fill("Synthetic-Logout-Reauth!");
  await page.getByTestId("permission-admin-operations")
    .getByRole("button", { name: "Record manual receipt", exact: true })
    .click();
  await reauth.reached;

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
  reauth.release();

  expect(requests.filter((request) =>
    request.method === "POST" && request.path === recordPath
  )).toEqual([]);
  expect(requests.filter((request) => request.path === "/api/v1/auth/logout")).toHaveLength(1);
});

for (const outflowKind of ["report", "reconciliation"] as const) {
  test(`a delayed original-source ${outflowKind} cannot refresh or notify after scope invalidation`, async ({ page }) => {
    let refundPermissionRevoked = false;
    const mutation = barrier();
    const receipt = manualReceiptItem("01", { unknownReport: outflowKind === "reconciliation" });
    const basePath =
      `/api/v1/admin/client-accounts/${accountA}/manual-receipts/${receipt.manualReceiptId}/outflow-reports`;
    const mutationPath = outflowKind === "report"
      ? basePath
      : `${basePath}/${receipt.originalSourceOutflow.reports[0]!.outflowReportId}/reconciliation`;
    const historyPath = `/api/v1/admin/client-accounts/${accountA}/manual-receipts`;
    const requests = await installApi(
      page,
      ["accounts.view", "billing.manual_receipt_manage", "billing.refund_manage"],
      async (path, route) => {
        if (path === "/api/v1/auth/me") {
          await route.fulfill({
            json: viewer(refundPermissionRevoked
              ? ["accounts.view", "billing.manual_receipt_manage"]
              : ["accounts.view", "billing.manual_receipt_manage", "billing.refund_manage"]),
          });
          return true;
        }
        if (path === historyPath && route.request().method() === "GET") {
          await route.fulfill({
            json: {
              clientAccount: { id: accountA, name: "Account Alpha" },
              items: [receipt],
            },
          });
          return true;
        }
        if (path === mutationPath && route.request().method() === "POST") {
          mutation.arrive();
          await mutation.gate;
          await route.fulfill({
            json: {
              status: outflowKind === "report" ? "confirmed" : "no_outflow",
              replayed: false,
            },
          });
          return true;
        }
        if (await account360Interceptor("manual_receipt", path, route)) return true;
        return false;
      },
    );

    await page.goto("/admin");
    const account360 = await openAccountOperation(
      page,
      "Account Alpha",
      "Record manual receipt",
    );
    await loadManualReceiptHistory(page);
    await page.getByLabel("Operation password confirmation").fill("Synthetic-Outflow-Reauth!");
    if (outflowKind === "report") {
      await page.getByRole("button", { name: "Report original-source outflow" }).click();
      await page.getByLabel("Original-source destination reference").fill("SYNTHETIC-RETURN-01");
      await page.getByLabel("Original-source outflow reason")
        .fill("Synthetic independent evidence confirms the original-source return");
      await page.getByRole("button", { name: "Record outflow report" }).click();
    } else {
      await page.getByRole("button", { name: "Reconcile unknown result" }).click();
      await page.getByLabel("Unknown outflow final result").selectOption("confirm_no_outflow");
      await page.getByLabel("Unknown outflow reconciliation reason")
        .fill("Synthetic independent evidence confirms no money left the account");
      await page.getByRole("button", { name: "Record final result" }).click();
    }
    await mutation.reached;

    if (outflowKind === "report") {
      await account360.getByTestId("account360-search-results")
        .getByRole("button", { name: /Account Beta/ })
        .click();
      await account360.getByLabel("Client Account actions")
        .getByRole("button", { name: "Record manual receipt" })
        .click();
      await expect(page.getByLabel("Manual receipt Client Account ID")).toHaveValue(accountB);
    } else {
      refundPermissionRevoked = true;
      await account360.getByRole("button", { name: "Refresh Staff access" }).click();
      await expect(page.getByTestId("manual-receipt-original-source-outflow")).toHaveCount(0);
    }
    const historyReadsBeforeRelease = requests.filter((request) =>
      request.method === "GET" && request.path === historyPath
    ).length;
    const mutationResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === mutationPath,
    );
    mutation.release();
    await mutationResponse;

    expect(requests.filter((request) =>
      request.method === "GET" && request.path === historyPath
    )).toHaveLength(historyReadsBeforeRelease);
    const mutationFacts = requests.filter((request) =>
      request.method === "POST" && request.path === mutationPath
    );
    expect(mutationFacts).toHaveLength(1);
    expect(mutationFacts[0]!.query).toBe("");
    expect(JSON.parse(mutationFacts[0]!.body ?? "{}")).toMatchObject(
      outflowKind === "report"
        ? { destination: "original_source", destinationReference: "SYNTHETIC-RETURN-01" }
        : { outcome: "confirm_no_outflow" },
    );
    await expect(page.getByText(/Recorded .*original-source outflow/)).toHaveCount(0);
    await expect(page.getByText(/Recorded no-outflow reconciliation/)).toHaveCount(0);
    await expect(page.locator(".notice.error")).toHaveCount(0);
  });
}

test("an Account A fulfillment follow-up cannot replace Account B queue state", async ({ page }) => {
  let queueReads = 0;
  const followUp = barrier();
  const itemA = manualItem(accountA, "Account Alpha", "01");
  const itemB = manualItem(accountB, "Account Beta", "02");
  const completionPath = `/api/v1/admin/services/${itemA.serviceId}/complete-manual`;
  const requests = await installApi(
    page,
    ["accounts.view", "services.manual_fulfillment"],
    async (path, route) => {
      if (await account360Interceptor("manual_fulfillment", path, route)) return true;
      if (path === "/api/v1/admin/manual-fulfillment") {
        queueReads += 1;
        if (queueReads === 1) {
          await route.fulfill({ json: { items: [itemA, itemB] } });
        } else {
          followUp.arrive();
          await followUp.gate;
          await route.fulfill({
            json: { items: [manualItem(accountA, "Stale Account Alpha", "99")] },
          });
        }
        return true;
      }
      if (path === completionPath && route.request().method() === "POST") {
        await route.fulfill({ json: {} });
        return true;
      }
      return false;
    },
  );

  await page.goto("/admin");
  const account360 = await openAccountOperation(
    page,
    "Account Alpha",
    "Open manual fulfillment",
  );
  await expect(page.getByTestId("manual-fulfillment-item")).toContainText("Account Alpha");
  await page.getByLabel("Operation password confirmation").fill("Synthetic-Fulfillment-Reauth!");
  await page.getByPlaceholder("Reason and delivery evidence (10+ characters)")
    .fill("Synthetic delivery evidence for Account Alpha");
  await page.getByRole("button", { name: "Confirm Ready for Service" }).click();
  await followUp.reached;

  await account360.getByTestId("account360-search-results")
    .getByRole("button", { name: /Account Beta/ })
    .click();
  await account360.getByLabel("Client Account actions")
    .getByRole("button", { name: "Open manual fulfillment" })
    .click();
  await expect(page.getByTestId("manual-fulfillment-item")).toContainText("Account Beta");
  const followUpResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/v1/admin/manual-fulfillment",
  );
  followUp.release();
  await followUpResponse;

  await expect(page.getByTestId("manual-fulfillment-item")).toContainText("Account Beta");
  await expect(page.getByText("Stale Account Alpha", { exact: true })).toHaveCount(0);
  await expect(page.getByText(
    "Manual service marked Ready for Service with an audited activation time.",
    { exact: true },
  )).toHaveCount(0);
  expect(requests.filter((request) => request.path === completionPath)).toHaveLength(1);
  expect(JSON.parse(
    requests.find((request) => request.path === completionPath)!.body ?? "{}",
  )).toEqual({ reason: "Synthetic delivery evidence for Account Alpha" });
  expect(queueReads).toBe(2);
});

for (const mutationKind of [
  "decision",
  "hold",
  "manual_action",
  "correction",
  "capacity",
] as const) {
  test(`an Account A ${mutationKind} refund follow-up cannot overwrite Account B`, async ({ page }) => {
    const followUp = barrier();
    const candidateA = refundCandidate(accountA, "Account Alpha", "01");
    const candidateB = refundCandidate(accountB, "Account Beta", "02");
    const recordA = refundRecord(accountA, "01");
    const recordB = refundRecord(accountB, "02");
    const holdA = refundHold(accountA, "Account Alpha", "01");
    const holdB = refundHold(accountB, "Account Beta", "02");
    const correctionA = refundCorrection(accountA, "Account Alpha", "01");
    const correctionB = refundCorrection(accountB, "Account Beta", "02");
    const capacityA = refundCapacityIncident(accountA, "Account Alpha", "01");
    const capacityB = refundCapacityIncident(accountB, "Account Beta", "02");
    const primaryPath = {
      decision: "/api/v1/admin/refund-candidates",
      hold: "/api/v1/admin/refund-security-holds",
      manual_action: "/api/v1/admin/refunds",
      correction: "/api/v1/admin/refund-dismissal-corrections",
      capacity: "/api/v1/admin/refund-receipt-capacity-incidents",
    }[mutationKind];
    const mutationPath = {
      decision: `/api/v1/admin/invoices/${candidateA.invoiceId}/refunds`,
      hold: `/api/v1/admin/refund-security-holds/${holdA.holdId}/adjudications`,
      manual_action: `/api/v1/admin/refunds/${recordA.refundId}/manual-actions`,
      correction: `/api/v1/admin/refund-adjudications/${correctionA.adjudicationId}/corrections`,
      capacity:
        `/api/v1/admin/refund-receipt-capacity-incidents/${capacityA.incidentId}/acknowledgements`,
    }[mutationKind];
    const initialItems: Record<string, unknown[]> = {
      "/api/v1/admin/refund-candidates": mutationKind === "decision"
        ? [candidateA, candidateB]
        : [],
      "/api/v1/admin/refunds": mutationKind === "manual_action"
        ? [recordA, recordB]
        : [],
      "/api/v1/admin/refund-security-holds": mutationKind === "hold"
        ? [holdA, holdB]
        : [],
      "/api/v1/admin/refund-dismissal-corrections": mutationKind === "correction"
        ? [correctionA, correctionB]
        : [],
      "/api/v1/admin/refund-receipt-capacity-incidents": mutationKind === "capacity"
        ? [capacityA, capacityB]
        : [],
    };
    const staleItems: Record<RefundMutationKind, unknown[]> = {
      decision: [refundCandidate(accountA, "Stale Account Alpha", "99")],
      hold: [refundHold(accountA, "Stale Account Alpha", "99")],
      manual_action: [refundRecord(accountA, "99")],
      correction: [refundCorrection(accountA, "Stale Account Alpha", "99")],
      capacity: [refundCapacityIncident(accountA, "Stale Account Alpha", "99")],
    };
    const readCounts = new Map<string, number>();
    const requests = await installApi(
      page,
      ["accounts.view", "billing.refund_manage"],
      async (path, route) => {
        if (refundReadPaths.includes(path)) {
          const count = (readCounts.get(path) ?? 0) + 1;
          readCounts.set(path, count);
          if (path === primaryPath && count > 1) {
            followUp.arrive();
            await followUp.gate;
            await route.fulfill({ json: { items: staleItems[mutationKind] } });
          } else {
            await route.fulfill({ json: { items: initialItems[path] ?? [] } });
          }
          return true;
        }
        if (path === mutationPath && route.request().method() === "POST") {
          await route.fulfill({
            json: mutationKind === "decision"
              ? {
                  ...recordA,
                  destination: "credit",
                  status: "completed",
                  providerOperationStatus: null,
                  lastError: null,
                }
              : { replayed: false },
          });
          return true;
        }
        if (await account360Interceptor("refund", path, route)) return true;
        return false;
      },
    );

    await page.goto("/admin");
    const account360 = await openAccountOperation(
      page,
      "Account Alpha",
      "Open refund operations",
    );
    await page.getByLabel("Operation password confirmation").fill("Synthetic-Refund-Reauth!");
    await page.getByLabel("Refund reason")
      .fill(`Synthetic ${mutationKind} refund evidence for Account Alpha`);
    await expect(refundMutationButton(page, mutationKind)).toBeEnabled();
    await refundMutationButton(page, mutationKind).click();
    await followUp.reached;

    await account360.getByTestId("account360-search-results")
      .getByRole("button", { name: /Account Beta/ })
      .click();
    await account360.getByLabel("Client Account actions")
      .getByRole("button", { name: "Open refund operations" })
      .click();
    await page.getByLabel("Operation password confirmation").fill("Synthetic-Beta-Reauth!");
    await page.getByLabel("Refund reason")
      .fill(`Synthetic ${mutationKind} refund evidence for Account Beta`);
    const betaAction = refundMutationButton(page, mutationKind);
    await expect(betaAction).toBeEnabled();

    const followUpResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === primaryPath,
    );
    followUp.release();
    await followUpResponse;

    await expect(betaAction).toBeEnabled();
    expect(readCounts.get(primaryPath)).toBe(2);
    const mutationFacts = requests.filter((request) =>
      request.method === "POST" && request.path === mutationPath
    );
    expect(mutationFacts).toHaveLength(1);
    expect(mutationFacts[0]!.query).toBe("");
    expect(JSON.parse(mutationFacts[0]!.body ?? "{}")).toMatchObject({
      reason: `Synthetic ${mutationKind} refund evidence for Account Alpha`,
    });
    await expect(page.getByText("Stale Account Alpha", { exact: true })).toHaveCount(0);
    await expect(page.locator(".notice.error")).toHaveCount(0);
  });
}

test("an Account A polling result cannot update or refetch after switching to Account B", async ({ page }) => {
  const poll = barrier();
  const recordA = { ...refundRecord(accountA, "01"), status: "processing" };
  const recordB = refundRecord(accountB, "02");
  const detailPath = `/api/v1/admin/refunds/${recordA.refundId}`;
  const requests = await installApi(
    page,
    ["accounts.view", "billing.refund_manage"],
    async (path, route) => {
      if (path === detailPath && route.request().method() === "GET") {
        poll.arrive();
        await poll.gate;
        await route.fulfill({
          json: {
            ...recordA,
            status: "completed",
            lastError: null,
            providerOperationStatus: "succeeded",
          },
        });
        return true;
      }
      if (refundReadPaths.includes(path)) {
        await route.fulfill({
          json: { items: path === "/api/v1/admin/refunds" ? [recordA, recordB] : [] },
        });
        return true;
      }
      if (await account360Interceptor("refund", path, route)) return true;
      return false;
    },
  );

  await page.goto("/admin");
  const account360 = await openAccountOperation(
    page,
    "Account Alpha",
    "Open refund operations",
  );
  await expect(page.getByTestId("refund-status")).toContainText("Refund processing");
  await poll.reached;

  await account360.getByTestId("account360-search-results")
    .getByRole("button", { name: /Account Beta/ })
    .click();
  await account360.getByLabel("Client Account actions")
    .getByRole("button", { name: "Open refund operations" })
    .click();
  await expect(page.getByTestId("refund-status")).toContainText("Refund manual");
  const refundReadsBeforeRelease = requests.filter((request) =>
    request.method === "GET" && refundReadPaths.includes(request.path)
  ).length;
  const pollResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === detailPath,
  );
  poll.release();
  await pollResponse;

  await expect(page.getByTestId("refund-status")).toContainText("Refund manual");
  await expect(page.getByText("Refund completed", { exact: true })).toHaveCount(0);
  expect(requests.filter((request) => request.path === detailPath)).toHaveLength(1);
  expect(requests.filter((request) =>
    request.method === "GET" && refundReadPaths.includes(request.path)
  )).toHaveLength(refundReadsBeforeRelease);
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
  const firstQueueResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/v1/admin/manual-fulfillment",
  );
  releaseFirstQueue();
  await firstQueueResponse;

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
    const queueResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/v1/admin/manual-fulfillment",
    );
    releaseQueue();
    await queueResponse;
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
  const queueResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/v1/admin/manual-fulfillment",
  );
  releaseQueue();
  await queueResponse;
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
