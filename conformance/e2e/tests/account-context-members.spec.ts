// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Page, type Request, type Route } from "@playwright/test";

const accountA = "00000000-0000-4000-8000-000000001901";
const accountB = "00000000-0000-4000-8000-000000001902";
const accountC = "00000000-0000-4000-8000-000000001907";
const viewerId = "00000000-0000-4000-8000-000000001903";
const ownerBId = "00000000-0000-4000-8000-000000001904";
const contactId = "00000000-0000-4000-8000-000000001905";
const invitationId = "00000000-0000-4000-8000-000000001906";
const occurredAt = "2026-08-10T00:00:00.123456Z";
const contextVersionHeader = "X-OSS-Account-Context-Version";
const contextIdHeader = "X-OSS-Client-Account-Id";

type Role = "owner" | "billing" | "technical" | "viewer";
type AccountContext = {
  clientAccountId: string;
  name: string;
  role: Role;
  permissions: string[];
  capabilities?: string[];
  restrictions: { membership: boolean; clientAccount: boolean };
};

const recognizedAccountCapabilities = [
  "account.contacts.manage",
  "account.contacts.read",
  "account.members.manage",
  "account.members.read",
  "billing.read",
  "billing.write",
  "orders.create",
  "services.manage",
  "support.tickets.write",
] as const;

function derivedCapabilities(context: Pick<AccountContext, "role" | "permissions" | "capabilities">): string[] {
  if (context.capabilities) return [...context.capabilities].sort();
  if (context.role === "owner") return [...recognizedAccountCapabilities];
  const result = new Set<string>(["billing.read"]);
  if (context.role === "billing") {
    result.add("orders.create");
    result.add("billing.write");
    result.add("support.tickets.write");
  } else if (context.role === "technical") {
    result.add("services.manage");
    result.add("support.tickets.write");
  }
  for (const permission of context.permissions) {
    if ((recognizedAccountCapabilities as readonly string[]).includes(permission)) result.add(permission);
  }
  return [...result].sort();
}

type MockState = {
  authenticated: boolean;
  activeId: string | null;
  version: string;
  userRestricted: boolean;
  clientRestricted: boolean;
  role: Role | null;
  permissions: string[];
  staffPermissions: string[] | null;
  contexts: AccountContext[];
  members: Array<Record<string, unknown>>;
  invitations: Array<Record<string, unknown>>;
  contacts: Array<Record<string, unknown>>;
};

type SeenRequest = {
  method: string;
  path: string;
  version: string | null;
  body: unknown;
};

function headers(state: Pick<MockState, "activeId" | "version">): Record<string, string> {
  return {
    [contextVersionHeader]: state.version,
    ...(state.activeId ? { [contextIdHeader]: state.activeId } : {}),
  };
}

function activeContext(state: MockState): AccountContext | null {
  return state.contexts.find((context) => context.clientAccountId === state.activeId) ?? null;
}

function viewer(state: MockState) {
  const context = activeContext(state);
  const verified = true;
  const eligible =
    verified &&
    !state.userRestricted &&
    Boolean(context) &&
    !context?.restrictions.membership &&
    !context?.restrictions.clientAccount;
  return {
    id: viewerId,
    email: "context-owner@example.invalid",
    locale: "en",
    clientAccountId: context?.clientAccountId ?? null,
    membershipRole: context?.role ?? null,
    accountContextVersion: state.version,
    context: context
      ? {
          clientAccountId: context.clientAccountId,
          name: context.name,
          role: context.role,
          permissions: context.permissions,
          capabilities: derivedCapabilities(context),
          version: state.version,
        }
      : null,
    verification: { email: "passed" },
    restrictions: { user: state.userRestricted, clientAccount: state.clientRestricted },
    eligible,
    staff: state.staffPermissions
      ? { roles: ["operations"], permissions: state.staffPermissions }
      : null,
  };
}

function page<T>(items: T[]) {
  return { items, limit: 25, hasMore: false, nextCursor: null };
}

function businessHistory(accountId: string, name: string) {
  return {
    warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
    account: { id: accountId, name },
    orders: [],
    invoices: [],
    payments: [],
    credit: { currency: "USD", balanceMinor: "0", transactions: [] },
    refunds: [],
    services: [],
    renewals: [],
    cancellations: [],
    tickets: [],
  };
}

function billingSummary() {
  return {
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
  };
}

function paymentSettings() {
  return {
    defaults: { savePaymentMethod: false, automaticRenewal: false },
    consentVersions: { savePaymentMethod: "mock-v1", automaticRenewal: "mock-v1" },
    methods: [],
    automaticRenewals: [],
    pendingAutomaticRenewals: [],
    serviceDecisions: [],
  };
}

function renewalFixture(status: "open" | "paid" = "open") {
  const paid = status === "paid";
  return {
    renewalId: "00000000-0000-4000-8000-000000001920",
    serviceId: "00000000-0000-4000-8000-000000001921",
    productName: "Capability renewal",
    serviceStatus: "active",
    billingCycle: "monthly",
    termStart: "2026-08-01T00:00:00.000Z",
    termEnd: "2026-09-01T00:00:00.000Z",
    invoiceId: "00000000-0000-4000-8000-000000001922",
    currency: "USD",
    totalMinor: "500",
    allocatedMinor: paid ? "500" : "0",
    dueMinor: paid ? "0" : "500",
    status,
    fundingStatus: status,
    renewalStatus: paid ? "paid" : "invoiced",
    fundedAt: paid ? occurredAt : null,
    dueAt: "2026-08-20T00:00:00.000Z",
    periodStart: "2026-09-01T00:00:00.000Z",
    periodEnd: "2026-10-01T00:00:00.000Z",
    settledAt: paid ? occurredAt : null,
    version: paid ? 2 : 1,
    reminders: [],
    lateFee: null,
    delinquency: null,
    paymentReconciliationHold: { active: false, deferralCount: "0", latestDeferredAt: null },
    automaticPayment: null,
  };
}

function emptyChargebacks(state: MockState) {
  return {
    clientAccountId: state.activeId,
    restricted: state.clientRestricted,
    creditBalanceMinor: "0",
    debtBalanceMinor: "0",
    chargebacks: [],
    unclaimedChargebacks: [],
    manualHolds: [],
  };
}

function requestBody(request: Request): unknown {
  const text = request.postData();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function installMockApi(
  pageInstance: Page,
  state: MockState,
  options: {
    omitContextHeaders?: boolean;
    intercept?: (path: string, route: Route, seen: SeenRequest[]) => Promise<boolean>;
  } = {},
): Promise<SeenRequest[]> {
  const seen: SeenRequest[] = [];
  await pageInstance.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const fact: SeenRequest = {
      method: request.method(),
      path: url.pathname,
      version: request.headers()[contextVersionHeader.toLowerCase()] ?? null,
      body: requestBody(request),
    };
    seen.push(fact);
    if (options.intercept && await options.intercept(url.pathname, route, seen)) return;
    const authenticatedHeaders = options.omitContextHeaders ? {} : headers(state);

    if (url.pathname === "/api/v1/catalog") {
      await route.fulfill({ json: { products: [] } });
    } else if (url.pathname === "/api/v1/legal/current") {
      const document = { version: "mock-v1", title: "Mock", body: "Synthetic only." };
      await route.fulfill({ json: { documents: { terms: document, aup: document, privacy: document } } });
    } else if (url.pathname === "/api/v1/auth/me") {
      if (!state.authenticated) {
        await route.fulfill({ status: 401, json: { error: "Authentication required" } });
      } else {
        await route.fulfill({ headers: authenticatedHeaders, json: viewer(state) });
      }
    } else if (url.pathname === "/api/v1/auth/account-contexts") {
      await route.fulfill({
        headers: authenticatedHeaders,
        json: {
          activeClientAccountId: state.activeId,
          accountContextVersion: state.version,
          items: state.contexts,
        },
      });
    } else if (url.pathname === "/api/v1/orders") {
      await route.fulfill({ headers: authenticatedHeaders, json: { items: [] } });
    } else if (url.pathname === "/api/v1/customer/business-history") {
      const context = activeContext(state)!;
      await route.fulfill({ headers: authenticatedHeaders, json: businessHistory(context.clientAccountId, context.name) });
    } else if (url.pathname === "/api/v1/billing/summary") {
      await route.fulfill({ headers: authenticatedHeaders, json: billingSummary() });
    } else if (url.pathname === "/api/v1/billing/payment-settings") {
      await route.fulfill({ headers: authenticatedHeaders, json: paymentSettings() });
    } else if (url.pathname === "/api/v1/billing/renewals") {
      await route.fulfill({ headers: authenticatedHeaders, json: { items: [] } });
    } else if (url.pathname === "/api/v1/billing/chargeback-status") {
      await route.fulfill({ headers: authenticatedHeaders, json: emptyChargebacks(state) });
    } else if (url.pathname === "/api/v1/tickets" || url.pathname === "/api/v1/tickets/service-options") {
      await route.fulfill({ headers: authenticatedHeaders, json: { items: [] } });
    } else if (url.pathname === "/api/v1/account/members") {
      await route.fulfill({ headers: authenticatedHeaders, json: page(state.members) });
    } else if (url.pathname === "/api/v1/account/membership-invitations") {
      await route.fulfill({ headers: authenticatedHeaders, json: page(state.invitations) });
    } else if (url.pathname === "/api/v1/account/contacts") {
      await route.fulfill({ headers: authenticatedHeaders, json: page(state.contacts) });
    } else if (url.pathname === "/api/v1/auth/reauth") {
      await route.fulfill({ headers: authenticatedHeaders, json: { expiresAt: "2026-08-10T00:15:00.000Z", fixedWindowMinutes: 15 } });
    } else {
      await route.fulfill({ status: 501, json: { error: `Unexpected mock API request: ${request.method()} ${url.pathname}` } });
      throw new Error(`Unexpected mock API request: ${request.method()} ${url.pathname}`);
    }
  });
  return seen;
}

function baseState(overrides: Partial<MockState> = {}): MockState {
  return {
    authenticated: true,
    activeId: accountA,
    version: "1",
    userRestricted: false,
    clientRestricted: false,
    role: "owner",
    permissions: [],
    staffPermissions: null,
    contexts: [
      {
        clientAccountId: accountA,
        name: "Account Alpha",
        role: "owner",
        permissions: [],
        restrictions: { membership: false, clientAccount: false },
      },
    ],
    members: [],
    invitations: [],
    contacts: [],
    ...overrides,
  };
}

test("context switch sends the decimal version and discards a late response from the old account", async ({ page: browserPage }) => {
  let releaseOldHistory!: () => void;
  let oldHistoryStarted!: () => void;
  const oldHistoryGate = new Promise<void>((resolve) => { releaseOldHistory = resolve; });
  const oldHistorySeen = new Promise<void>((resolve) => { oldHistoryStarted = resolve; });
  let delayed = false;
  let contextListRequests = 0;
  const state = baseState({
    version: "90071992547409937",
    role: "viewer",
    contexts: [
      { clientAccountId: accountA, name: "Account Alpha", role: "viewer", permissions: [], restrictions: { membership: false, clientAccount: false } },
      { clientAccountId: accountB, name: "Account Beta", role: "viewer", permissions: [], restrictions: { membership: false, clientAccount: false } },
    ],
  });
  const seen = await installMockApi(browserPage, state, {
    intercept: async (path, route) => {
      if (path === "/api/v1/auth/account-contexts") contextListRequests += 1;
      if (path === "/api/v1/customer/business-history" && state.activeId === accountA && !delayed) {
        delayed = true;
        oldHistoryStarted();
        await oldHistoryGate;
        await route.fulfill({ headers: { [contextVersionHeader]: "90071992547409937", [contextIdHeader]: accountA }, json: businessHistory(accountA, "Account Alpha") });
        return true;
      }
      if (path === "/api/v1/auth/account-context") {
        const body = requestBody(route.request()) as { clientAccountId: string };
        const switchingToBeta = body.clientAccountId === accountB;
        expect(route.request().headers()[contextVersionHeader.toLowerCase()]).toBe(
          switchingToBeta ? "90071992547409937" : "90071992547409938",
        );
        state.activeId = switchingToBeta ? accountB : accountA;
        state.version = switchingToBeta ? "90071992547409938" : "90071992547409939";
        state.role = "viewer";
        await route.fulfill({
          headers: headers(state),
          json: {
            context: {
              ...state.contexts[switchingToBeta ? 1 : 0],
              version: state.version,
              restrictions: { clientAccount: false },
            },
          },
        });
        return true;
      }
      return false;
    },
  });

  await browserPage.goto("/customer");
  await oldHistorySeen;
  const switcher = browserPage.getByTestId("account-context-switcher");
  await expect(switcher).toBeVisible();
  await switcher.getByLabel("Active Client Account").selectOption(accountB);
  await switcher.getByRole("button", { name: "Switch account" }).click();
  await expect(browserPage.getByTestId("history-account")).toContainText("Account Beta");
  releaseOldHistory();
  await expect(browserPage.getByTestId("history-account")).toContainText("Account Beta");
  await expect(browserPage.getByTestId("history-account")).not.toContainText("Account Alpha");
  await browserPage.getByRole("button", { name: "简体中文" }).click();
  await switcher.getByLabel("Active Client Account").selectOption(accountA);
  await switcher.getByRole("button", { name: "切换账户" }).click();
  await expect(browserPage.getByTestId("history-account")).toContainText("Account Alpha");
  expect(seen.filter((fact) => fact.path === "/api/v1/auth/account-context" && fact.method === "PUT").map((fact) => fact.version)).toEqual([
    "90071992547409937",
    "90071992547409938",
  ]);
  // React StrictMode intentionally mounts each effect twice in the dev build:
  // exactly two calls for each A → B → A render proves the callback dependency
  // is stable and the intervening public, headerless locale fetch did not spin
  // or clear the stored account context.
  expect(contextListRequests).toBe(6);
});

test("account context pagination pins an active account beyond page one and deduplicates Load more", async ({ page: browserPage }) => {
  const state = baseState({
    activeId: accountA,
    version: "27",
    role: "viewer",
    contexts: [{ clientAccountId: accountA, name: "Pinned Active Alpha", role: "viewer", permissions: [], restrictions: { membership: false, clientAccount: false } }],
  });
  let firstPageRequests = 0;
  let nextPageRequests = 0;
  await installMockApi(browserPage, state, {
    intercept: async (path, route) => {
      if (path !== "/api/v1/auth/account-contexts") return false;
      const url = new URL(route.request().url());
      expect(url.searchParams.get("limit")).toBe("25");
      if (url.searchParams.get("cursor") === "page-two") {
        nextPageRequests += 1;
        await route.fulfill({
          headers: headers(state),
          json: {
            activeClientAccountId: accountA,
            accountContextVersion: state.version,
            items: [
              { clientAccountId: accountB, name: "Beta updated", role: "viewer", permissions: [], restrictions: { membership: false, clientAccount: false } },
              { clientAccountId: accountC, name: "Gamma", role: "viewer", permissions: [], restrictions: { membership: false, clientAccount: false } },
            ],
            limit: 25,
            hasMore: false,
            nextCursor: null,
          },
        });
      } else {
        firstPageRequests += 1;
        await route.fulfill({
          headers: headers(state),
          json: {
            activeClientAccountId: accountA,
            accountContextVersion: state.version,
            items: [{ clientAccountId: accountB, name: "Beta", role: "viewer", permissions: [], restrictions: { membership: false, clientAccount: false } }],
            limit: 25,
            hasMore: true,
            nextCursor: "page-two",
          },
        });
      }
      return true;
    },
  });

  await browserPage.goto("/customer");
  const switcher = browserPage.getByTestId("account-context-switcher");
  const select = switcher.getByLabel("Active Client Account");
  await expect(select).toHaveValue(accountA);
  await expect(select.locator(`option[value="${accountA}"]`)).toContainText("Pinned Active Alpha");
  await switcher.getByRole("button", { name: "Load more accounts" }).click();
  await expect(select.locator(`option[value="${accountC}"]`)).toContainText("Gamma");
  await expect(select.locator(`option[value="${accountB}"]`)).toHaveCount(1);
  await expect(select.locator(`option[value="${accountB}"]`)).toContainText("Beta updated");
  expect(firstPageRequests).toBeGreaterThanOrEqual(1);
  expect(nextPageRequests).toBe(1);
});

test("a mutation learns the version from a 428 error and retries with that exact header", async ({ page: browserPage }) => {
  let creates = 0;
  const state = baseState({
    contexts: [{ clientAccountId: accountA, name: "Account Alpha", role: "owner", permissions: ["*"], restrictions: { membership: false, clientAccount: false } }],
  });
  state.contacts = [];
  const seen = await installMockApi(browserPage, state, {
    omitContextHeaders: true,
    intercept: async (path, route) => {
      if (path === "/api/v1/account/contacts" && route.request().method() === "POST") {
        creates += 1;
        if (creates === 1) {
          expect(route.request().headers()[contextVersionHeader.toLowerCase()]).toBeUndefined();
          await route.fulfill({
            status: 428,
            headers: { [contextVersionHeader]: "1", [contextIdHeader]: accountA },
            json: { error: "Version required", code: "ACCOUNT_CONTEXT_VERSION_REQUIRED" },
          });
        } else {
          expect(route.request().headers()[contextVersionHeader.toLowerCase()]).toBe("1");
          const body = requestBody(route.request()) as { displayName: string; email: string };
          const contact = { id: contactId, ...body, locale: "en", notificationSubscriptions: [], createdAt: occurredAt, updatedAt: occurredAt };
          state.contacts = [contact];
          await route.fulfill({ status: 201, headers: { [contextVersionHeader]: "1", [contextIdHeader]: accountA }, json: { contact } });
        }
        return true;
      }
      return false;
    },
  });
  await browserPage.goto("/customer");
  const panel = browserPage.getByTestId("account-access-panel");
  await panel.getByLabel("Contact display name").fill("Finance Desk");
  await panel.getByLabel("Contact email").fill("finance@example.invalid");
  await panel.getByRole("button", { name: "Create Contact" }).click();
  await expect(browserPage.getByText("Version required")).toBeVisible();
  await panel.getByRole("button", { name: "Create Contact" }).click();
  await expect(panel.getByTestId("account-contact")).toContainText("Finance Desk");
  expect(creates).toBe(2);
  expect(seen.filter((fact) => fact.path === "/api/v1/account/contacts" && fact.method === "POST").map((fact) => fact.version)).toEqual([null, "1"]);
});

test("safe reads wait for login completion and an old v18 response cannot overwrite the new v0 session", async ({ page: browserPage }) => {
  let releaseLogin!: () => void;
  let loginStarted!: () => void;
  let releaseOldRead!: () => void;
  let oldReadStarted!: () => void;
  const loginGate = new Promise<void>((resolve) => { releaseLogin = resolve; });
  const loginSeen = new Promise<void>((resolve) => { loginStarted = resolve; });
  const oldReadGate = new Promise<void>((resolve) => { releaseOldRead = resolve; });
  const oldReadSeen = new Promise<void>((resolve) => { oldReadStarted = resolve; });
  let oldReadCalls = 0;
  let duringTransitionCalls = 0;
  await browserPage.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/catalog") {
      await route.fulfill({ json: { products: [] } });
    } else if (url.pathname === "/api/v1/legal/current") {
      const document = { version: "mock-v1", title: "Mock", body: "Synthetic only." };
      await route.fulfill({ json: { documents: { terms: document, aup: document, privacy: document } } });
    } else if (url.pathname === "/api/v1/test/seed") {
      await route.fulfill({ headers: { [contextVersionHeader]: "18", [contextIdHeader]: accountA }, json: { seeded: true } });
    } else if (url.pathname === "/api/v1/test/old-read") {
      oldReadCalls += 1;
      if (oldReadCalls === 1) {
        oldReadStarted();
        await oldReadGate;
        await route.fulfill({ headers: { [contextVersionHeader]: "18", [contextIdHeader]: accountA }, json: { source: "old" } });
      } else {
        await route.fulfill({ headers: { [contextVersionHeader]: "0" }, json: { source: "new" } });
      }
    } else if (url.pathname === "/api/v1/auth/login") {
      loginStarted();
      await loginGate;
      await route.fulfill({ status: 409, headers: { [contextVersionHeader]: "0" }, json: { error: "Select an account", code: "ACCOUNT_CONTEXT_REQUIRED" } });
    } else if (url.pathname === "/api/v1/test/during-transition") {
      duringTransitionCalls += 1;
      await route.fulfill({ headers: { [contextVersionHeader]: "0" }, json: { session: "new" } });
    } else {
      await route.fulfill({ status: 401, json: { error: "Authentication required" } });
    }
  });
  await browserPage.goto("/");
  await browserPage.evaluate(async () => {
    const modulePath = "/src/api.ts";
    const client = await import(modulePath);
    (globalThis as Record<string, unknown>).ossTestClient = client;
    await client.api("/api/v1/test/seed");
  });
  await browserPage.evaluate(() => {
    const client = (globalThis as Record<string, any>).ossTestClient;
    (globalThis as Record<string, unknown>).oldReadPromise = client.api("/api/v1/test/old-read");
  });
  await oldReadSeen;
  await browserPage.evaluate(() => {
    const client = (globalThis as Record<string, any>).ossTestClient;
    (globalThis as Record<string, unknown>).loginPromise = client.api("/api/v1/auth/login", { method: "POST", body: "{}" }).catch((error: { code?: string }) => error.code);
  });
  await loginSeen;
  await browserPage.evaluate(() => {
    const client = (globalThis as Record<string, any>).ossTestClient;
    (globalThis as Record<string, unknown>).duringPromise = client.api("/api/v1/test/during-transition");
  });
  const lockState = await browserPage.evaluate(async () => navigator.locks.query());
  expect((lockState.held ?? []).some((lock) => lock.name === "opensales-auth-transition-v1" && lock.mode === "exclusive")).toBe(true);
  expect((lockState.pending ?? []).some((lock) => lock.name === "opensales-auth-transition-v1" && lock.mode === "shared")).toBe(true);
  expect(duringTransitionCalls).toBe(0);
  releaseLogin();
  expect(await browserPage.evaluate(async () => await (globalThis as unknown as Record<string, Promise<unknown>>).loginPromise)).toBe("ACCOUNT_CONTEXT_REQUIRED");
  await expect.poll(() => duringTransitionCalls).toBe(1);
  releaseOldRead();
  const outcome = await browserPage.evaluate(async () => {
    const global = globalThis as Record<string, any>;
    const [oldRead, during] = await Promise.all([global.oldReadPromise, global.duringPromise]);
    return { oldRead, during, snapshot: global.ossTestClient.getAccountContextSnapshot() };
  });
  expect(outcome).toEqual({
    oldRead: { source: "new" },
    during: { session: "new" },
    snapshot: { clientAccountId: null, version: "0", generation: expect.any(Number) },
  });
  expect(oldReadCalls).toBe(2);
});

test("failed auth transitions preserve context, concurrent login fails closed, and successful logout rejects an old response", async ({ page: browserPage }) => {
  let releaseFirstLogin!: () => void;
  let firstLoginStarted!: () => void;
  let releaseOldRead!: () => void;
  let oldReadStarted!: () => void;
  const firstLoginGate = new Promise<void>((resolve) => { releaseFirstLogin = resolve; });
  const firstLoginSeen = new Promise<void>((resolve) => { firstLoginStarted = resolve; });
  const oldReadGate = new Promise<void>((resolve) => { releaseOldRead = resolve; });
  const oldReadSeen = new Promise<void>((resolve) => { oldReadStarted = resolve; });
  let loginCalls = 0;
  let logoutCalls = 0;
  let oldReadCalls = 0;
  const mutationVersions: Array<string | null> = [];
  await browserPage.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/catalog") {
      await route.fulfill({ json: { products: [] } });
    } else if (url.pathname === "/api/v1/legal/current") {
      const document = { version: "mock-v1", title: "Mock", body: "Synthetic only." };
      await route.fulfill({ json: { documents: { terms: document, aup: document, privacy: document } } });
    } else if (url.pathname === "/api/v1/test/seed") {
      await route.fulfill({ headers: { [contextVersionHeader]: "18", [contextIdHeader]: accountA }, json: {} });
    } else if (url.pathname === "/api/v1/auth/login") {
      loginCalls += 1;
      if (loginCalls === 1) {
        firstLoginStarted();
        await firstLoginGate;
      }
      await route.fulfill({ status: 401, json: { error: "Wrong credentials", code: "INVALID_CREDENTIALS" } });
    } else if (url.pathname === "/api/v1/auth/logout") {
      logoutCalls += 1;
      if (logoutCalls === 1) {
        await route.fulfill({ status: 503, headers: { [contextVersionHeader]: "18", [contextIdHeader]: accountA }, json: { error: "Temporary logout failure" } });
      } else {
        await route.fulfill({ status: 204, headers: { [contextVersionHeader]: "18", [contextIdHeader]: accountA } });
      }
    } else if (url.pathname === "/api/v1/test/mutation") {
      mutationVersions.push(route.request().headers()[contextVersionHeader.toLowerCase()] ?? null);
      await route.fulfill({ headers: { [contextVersionHeader]: "18", [contextIdHeader]: accountA }, json: { ok: true } });
    } else if (url.pathname === "/api/v1/test/old-after-logout") {
      oldReadCalls += 1;
      if (oldReadCalls === 1) {
        oldReadStarted();
        await oldReadGate;
        await route.fulfill({ headers: { [contextVersionHeader]: "18", [contextIdHeader]: accountA }, json: { source: "old" } });
      } else {
        await route.fulfill({ json: { source: "logged-out" } });
      }
    } else {
      await route.fulfill({ status: 401, json: { error: "Authentication required" } });
    }
  });
  await browserPage.goto("/");
  await browserPage.evaluate(async () => {
    const modulePath = "/src/api.ts";
    const client = await import(modulePath);
    (globalThis as Record<string, unknown>).ossTestClient = client;
    await client.api("/api/v1/test/seed");
    (globalThis as Record<string, unknown>).firstLoginPromise = client.api("/api/v1/auth/login", { method: "POST", body: "{}" }).catch((error: { code?: string }) => error.code);
  });
  await firstLoginSeen;
  const concurrentCode = await browserPage.evaluate(async () => {
    const client = (globalThis as Record<string, any>).ossTestClient;
    return client.api("/api/v1/auth/login", { method: "POST", body: "{}" }).catch((error: { code?: string }) => error.code);
  });
  expect(concurrentCode).toBe("AUTH_TRANSITION_IN_PROGRESS");
  expect(loginCalls).toBe(1);
  releaseFirstLogin();
  expect(await browserPage.evaluate(async () => await (globalThis as unknown as Record<string, Promise<unknown>>).firstLoginPromise)).toBe("INVALID_CREDENTIALS");
  await browserPage.evaluate(async () => {
    const client = (globalThis as Record<string, any>).ossTestClient;
    await client.api("/api/v1/test/mutation", { method: "POST", body: "{}" });
    await client.api("/api/v1/auth/logout", { method: "POST", body: "{}" }).catch(() => undefined);
    await client.api("/api/v1/test/mutation", { method: "POST", body: "{}" });
    (globalThis as Record<string, unknown>).oldLogoutPromise = client.api("/api/v1/test/old-after-logout");
  });
  await oldReadSeen;
  await browserPage.evaluate(async () => {
    const client = (globalThis as Record<string, any>).ossTestClient;
    await client.api("/api/v1/auth/logout", { method: "POST", body: "{}" });
  });
  releaseOldRead();
  const outcome = await browserPage.evaluate(async () => {
    const global = globalThis as Record<string, any>;
    const result = await global.oldLogoutPromise;
    return { result, snapshot: global.ossTestClient.getAccountContextSnapshot() };
  });
  expect(mutationVersions).toEqual(["18", "18"]);
  expect(outcome).toEqual({
    result: { source: "logged-out" },
    snapshot: { clientAccountId: null, version: null, generation: expect.any(Number) },
  });
  expect(oldReadCalls).toBe(2);
});

test("a tab that closes after broadcasting begin cannot permanently block safe reads", async ({ page: browserPage, context }) => {
  let crashReadCalls = 0;
  await context.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/catalog") {
      await route.fulfill({ json: { products: [] } });
    } else if (url.pathname === "/api/v1/legal/current") {
      const document = { version: "mock-v1", title: "Mock", body: "Synthetic only." };
      await route.fulfill({ json: { documents: { terms: document, aup: document, privacy: document } } });
    } else if (url.pathname === "/api/v1/test/crash-read") {
      crashReadCalls += 1;
      await route.fulfill({ json: { recovered: true } });
    } else {
      await route.fulfill({ status: 401, json: { error: "Authentication required" } });
    }
  });
  const sourcePage = await context.newPage();
  await Promise.all([browserPage.goto("/"), sourcePage.goto("/")]);
  await browserPage.evaluate(async () => {
    const modulePath = "/src/api.ts";
    (globalThis as Record<string, unknown>).ossTestClient = await import(modulePath);
  });
  await sourcePage.evaluate(() => {
    const channel = new BroadcastChannel("opensales-session-epoch-v1");
    (globalThis as Record<string, unknown>).crashChannel = channel;
    void navigator.locks.request("opensales-auth-transition-v1", { mode: "exclusive" }, async () => {
      channel.postMessage({ type: "session-transition", transitionId: "crashed-tab", phase: "begin" });
      await new Promise<void>(() => undefined);
    });
  });
  await expect.poll(async () => sourcePage.evaluate(async () => {
    const state = await navigator.locks.query();
    return (state.held ?? []).some((lock) => lock.name === "opensales-auth-transition-v1" && lock.mode === "exclusive");
  })).toBe(true);
  await browserPage.evaluate(() => {
    const client = (globalThis as Record<string, any>).ossTestClient;
    (globalThis as Record<string, unknown>).crashReadPromise = client.api("/api/v1/test/crash-read");
  });
  await expect.poll(async () => browserPage.evaluate(async () => {
    const state = await navigator.locks.query();
    return (state.pending ?? []).some((lock) => lock.name === "opensales-auth-transition-v1" && lock.mode === "shared");
  })).toBe(true);
  expect(crashReadCalls).toBe(0);
  await sourcePage.close();
  expect(await browserPage.evaluate(async () => await (globalThis as unknown as Record<string, Promise<unknown>>).crashReadPromise)).toEqual({ recovered: true });
  expect(crashReadCalls).toBe(1);
});

test("stale context errors clear protected account state before refreshing the new context", async ({ page: browserPage }) => {
  const state = baseState({
    contexts: [
      { clientAccountId: accountA, name: "Account Alpha", role: "owner", permissions: ["*"], restrictions: { membership: false, clientAccount: false } },
      { clientAccountId: accountB, name: "Account Beta", role: "viewer", permissions: [], restrictions: { membership: false, clientAccount: false } },
    ],
  });
  state.contacts = [{ id: contactId, displayName: "Alpha Contact", email: "alpha@example.invalid", locale: "en", notificationSubscriptions: ["billing"], createdAt: occurredAt, updatedAt: occurredAt }];
  await installMockApi(browserPage, state, {
    intercept: async (path, route) => {
      if (path === "/api/v1/account/contacts" && route.request().method() === "POST") {
        state.activeId = accountB;
        state.version = "2";
        state.role = "viewer";
        state.contacts = [];
        await route.fulfill({ status: 409, headers: headers(state), json: { error: "Context changed", code: "ACCOUNT_CONTEXT_STALE" } });
        return true;
      }
      return false;
    },
  });
  await browserPage.goto("/customer");
  const panel = browserPage.getByTestId("account-access-panel");
  await expect(panel).toContainText("Alpha Contact");
  await panel.getByLabel("Contact display name").fill("Never created");
  await panel.getByLabel("Contact email", { exact: true }).fill("never@example.invalid");
  await panel.getByRole("button", { name: "Create Contact" }).click();
  await expect(browserPage.getByTestId("history-account")).toContainText("Account Beta");
  await expect(browserPage.getByTestId("account-access-panel")).toHaveCount(0);
  await expect(browserPage.getByText("Alpha Contact")).toHaveCount(0);
});

test("Staff identity with null customer context can open permission-scoped Admin", async ({ page: browserPage }) => {
  const state = baseState({
    activeId: null,
    version: "0",
    role: null,
    permissions: [],
    contexts: [],
    staffPermissions: ["accounts.view"],
  });
  const seen = await installMockApi(browserPage, state);
  await browserPage.goto("/admin");
  await expect(browserPage.getByTestId("client-account-360")).toBeVisible();
  await expect(browserPage.getByTestId("admin-access-restricted")).toHaveCount(0);
  expect(seen.some((fact) => fact.path.startsWith("/api/v1/account/"))).toBe(false);
});

for (const contactsAuthorized of [false, true]) {
  test(`Admin Account 360 ${contactsAuthorized ? "loads" : "does not fetch"} Contacts under the independent permission`, async ({ page: browserPage }) => {
    const state = baseState({
      activeId: null,
      version: "0",
      role: null,
      permissions: [],
      contexts: [],
      staffPermissions: contactsAuthorized
        ? ["accounts.view", "accounts.contacts.read"]
        : ["accounts.view"],
    });
    let contactFetches = 0;
    await installMockApi(browserPage, state, {
      intercept: async (path, route) => {
        if (path === "/api/v1/admin/client-accounts") {
          await route.fulfill({ headers: headers(state), json: {
            warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
            items: [{
              id: accountA,
              name: "Admin Contact Account",
              owner: { userId: viewerId, email: "founder@example.invalid", emailVerifiedAt: occurredAt },
              restrictedAt: null,
              activeMemberCount: 1,
              createdAt: occurredAt,
            }],
            hasMore: false,
            nextCursor: null,
          } });
          return true;
        }
        if (path === `/api/v1/admin/client-accounts/${accountA}/summary`) {
          await route.fulfill({ headers: headers(state), json: {
            warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
            account: { id: accountA, name: "Admin Contact Account", createdAt: occurredAt, restrictedAt: null },
            owner: { userId: viewerId, email: "founder@example.invalid", emailVerifiedAt: occurredAt, restrictedAt: null },
            memberships: [{
              userId: viewerId,
              email: "founder@example.invalid",
              role: "owner",
              permissions: ["*"],
              emailVerifiedAt: occurredAt,
              userRestrictedAt: null,
              membershipRestrictedAt: occurredAt,
              createdAt: occurredAt,
              removedAt: null,
            }],
            restrictions: [],
          } });
          return true;
        }
        if (path === `/api/v1/admin/client-accounts/${accountA}/contacts`) {
          contactFetches += 1;
          await route.fulfill({ headers: headers(state), json: {
            warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
            account: { id: accountA, name: "Admin Contact Account" },
            ...page([{ id: contactId, displayName: "Admin Billing Contact", email: "admin-contact@example.invalid", locale: "en", notificationSubscriptions: ["billing"], createdAt: occurredAt, updatedAt: occurredAt }]),
          } });
          return true;
        }
        return false;
      },
    });
    await browserPage.goto("/admin");
    const account360 = browserPage.getByTestId("client-account-360");
    await account360.getByLabel("Search Client Accounts").fill("Admin Contact Account");
    await account360.getByRole("button", { name: "Search accounts" }).click();
    await account360.getByTestId("account360-search-results").getByRole("button", { name: /Admin Contact Account/ }).click();
    await expect(account360.getByTestId("account360-memberships")).toContainText("membership restricted");
    if (contactsAuthorized) {
      await expect(account360.getByTestId("account360-contacts")).toContainText("Admin Billing Contact");
      expect(contactFetches).toBe(1);
    } else {
      await expect(account360.getByRole("heading", { name: "Account Contacts" })).toHaveCount(0);
      expect(contactFetches).toBe(0);
    }
  });
}

for (const membershipRole of ["viewer", "billing", "technical"] as const) {
  test(`${membershipRole} derived capabilities keep reads mounted and expose only authorized writes`, async ({ page: browserPage }) => {
    const explicitCapabilities = membershipRole === "viewer"
      ? ["billing.read"]
      : membershipRole === "billing"
        ? ["billing.read", "billing.write", "orders.create", "support.tickets.write"]
        : ["billing.read", "services.manage", "support.tickets.write"];
    const state = baseState({
      role: membershipRole,
      contexts: [{
        clientAccountId: accountA,
        name: `${membershipRole} account`,
        role: membershipRole,
        permissions: [],
        capabilities: explicitCapabilities,
        restrictions: { membership: false, clientAccount: false },
      }],
    });
    const seen = await installMockApi(browserPage, state, {
      intercept: async (path, route) => {
        const capabilityOrderId = "00000000-0000-4000-8000-000000001924";
        const capabilityInvoiceId = "00000000-0000-4000-8000-000000001925";
        const capabilityServiceId = "00000000-0000-4000-8000-000000001926";
        if (path === "/api/v1/catalog") {
          await route.fulfill({ json: { products: [{
            id: "capability-product",
            groupId: "capability-group",
            groupName: "Capability products",
            name: "Capability plan",
            description: "Synthetic capability fixture.",
            fulfillmentMode: "automatic",
            optionSchema: [],
            purchasable: true,
            prices: [{ id: "capability-price", currency: "USD", billingCycle: "monthly", oneTimeMinor: "0", setupMinor: "0", recurringMinor: "100" }],
          }] } });
          return true;
        }
        if (path === "/api/v1/orders") {
          await route.fulfill({ headers: headers(state), json: { items: [{
            orderId: capabilityOrderId,
            orderStatus: "completed",
            productName: "Capability plan",
            serviceId: capabilityServiceId,
            serviceStatus: "active",
            createdAt: occurredAt,
          }] } });
          return true;
        }
        if (path === `/api/v1/orders/${capabilityOrderId}`) {
          await route.fulfill({ headers: headers(state), json: {
            order: { id: capabilityOrderId, status: "completed", price: { productName: "Capability plan", billingCycle: "monthly" } },
            invoice: {
              id: capabilityInvoiceId,
              currency: "USD",
              totalMinor: "100",
              allocatedMinor: "100",
              paymentAllocatedMinor: "100",
              creditAppliedMinor: "0",
              paymentFeeMinor: "0",
              dueMinor: "0",
              status: "paid",
            },
            payment: { status: "succeeded" },
            provisioning: { status: "succeeded" },
            service: {
              id: capabilityServiceId,
              status: "active",
              activatedAt: occurredAt,
              termStart: "2026-08-01T00:00:00.000Z",
              termEnd: "2026-09-01T00:00:00.000Z",
              version: 1,
              cancellation: null,
            },
          } });
          return true;
        }
        if (path === "/api/v1/billing/payment-settings") {
          await route.fulfill({ headers: headers(state), json: {
            ...paymentSettings(),
            methods: [{
              id: "saved-method-capability",
              paymentMethod: "card",
              instrumentType: "card",
              brand: "Mock Visa",
              lastFour: "4242",
              expiryMonth: 12,
              expiryYear: 2030,
              status: "active",
              default: false,
              consentVersion: "mock-v1",
              savedAt: occurredAt,
              version: 1,
            }],
          } });
          return true;
        }
        if (path === "/api/v1/billing/renewals") {
          await route.fulfill({ headers: headers(state), json: { items: [renewalFixture()] } });
          return true;
        }
        return false;
      },
    });

    await browserPage.goto("/customer");
    await expect(browserPage.getByTestId("customer-business-history")).toBeVisible();
    const tickets = browserPage.locator('section[aria-label="Customer support tickets"]');
    await expect(tickets).toBeVisible();
    await expect(tickets.getByRole("button", { name: "Create ticket" })).toHaveCount(membershipRole === "viewer" ? 0 : 1);
    const paymentPanel = browserPage.locator('section[aria-label="Payment methods and automatic renewal"]');
    await expect(paymentPanel).toBeVisible();
    await expect(paymentPanel.getByRole("button", { name: "Set as default only" })).toHaveCount(membershipRole === "billing" ? 1 : 0);
    const renewalPayment = browserPage.getByRole("button", { name: "Pay renewal with Mock Provider" });
    await expect(renewalPayment).toHaveCount(membershipRole === "billing" ? 1 : 0);
    await expect(browserPage.getByLabel(/Renewal payment method/)).toHaveCount(membershipRole === "billing" ? 1 : 0);
    await expect(browserPage.getByLabel("Schedule service cancellation")).toHaveCount(membershipRole === "technical" ? 1 : 0);
    await browserPage.locator(".product-card").getByRole("button").click();
    const orderButton = browserPage.getByRole("dialog").getByRole("button").last();
    if (membershipRole === "billing") await expect(orderButton).toBeEnabled();
    else await expect(orderButton).toBeDisabled();
    expect(seen.some((fact) => fact.method !== "GET" && !fact.path.startsWith("/api/v1/auth/"))).toBe(false);
  });
}

test("an explicit billing.write capability enables the renewal payment path", async ({ page: browserPage }) => {
  const state = baseState({
    role: "viewer",
    contexts: [{
      clientAccountId: accountA,
      name: "Explicit billing writer",
      role: "viewer",
      permissions: ["billing.write"],
      capabilities: ["billing.read", "billing.write"],
      restrictions: { membership: false, clientAccount: false },
    }],
  });
  let paid = false;
  let quotePosts = 0;
  let paymentPosts = 0;
  await installMockApi(browserPage, state, {
    intercept: async (path, route) => {
      if (path === "/api/v1/billing/renewals") {
        await route.fulfill({ headers: headers(state), json: { items: [renewalFixture(paid ? "paid" : "open")] } });
        return true;
      }
      if (path.endsWith("/payment-quotes") && route.request().method() === "POST") {
        quotePosts += 1;
        expect(route.request().headers()[contextVersionHeader.toLowerCase()]).toBe("1");
        await route.fulfill({ headers: headers(state), json: {
          quoteId: "00000000-0000-4000-8000-000000001923",
          method: "card",
          creditToApplyMinor: "0",
          externalNonFeeMinor: "500",
          feeMinor: "0",
          externalDueMinor: "500",
          expiresAt: "2026-08-10T00:15:00.000Z",
        } });
        return true;
      }
      if (path.endsWith("/payments") && route.request().method() === "POST") {
        paymentPosts += 1;
        expect(route.request().headers()[contextVersionHeader.toLowerCase()]).toBe("1");
        paid = true;
        await route.fulfill({ headers: headers(state), json: { accepted: true } });
        return true;
      }
      return false;
    },
  });
  await browserPage.goto("/customer");
  const pay = browserPage.getByRole("button", { name: "Pay renewal with Mock Provider" });
  await expect(pay).toBeVisible();
  await pay.click();
  await expect.poll(() => quotePosts).toBe(1);
  await expect.poll(() => paymentPosts).toBe(1);
  await expect(browserPage.getByText("Mock renewal payment started.", { exact: false })).toBeVisible();
});

test("non-Owner managers can grant their own role defaults but not roles or permissions above their derived ceiling", async ({ page: browserPage }) => {
  const manager = (role: "technical" | "billing") => ({
    userId: viewerId,
    email: "member-manager@example.invalid",
    role,
    permissions: ["account.members.manage", "account.members.read"],
    restrictions: { membership: false, user: false },
    isRecordedOwner: false,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
  const managedMember = {
    userId: ownerBId,
    email: "managed-member@example.invalid",
    role: "viewer",
    permissions: [],
    restrictions: { membership: false, user: false },
    isRecordedOwner: false,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  const state = baseState({
    role: "technical",
    contexts: [{
      clientAccountId: accountA,
      name: "Managed account",
      role: "technical",
      permissions: ["account.members.manage", "account.members.read"],
      capabilities: ["account.members.manage", "account.members.read", "billing.read", "services.manage", "support.tickets.write"],
      restrictions: { membership: false, clientAccount: false },
    }],
    members: [manager("technical"), managedMember],
  });
  const invitationBodies: Array<Record<string, unknown>> = [];
  const seen = await installMockApi(browserPage, state, {
    intercept: async (path, route) => {
      if (path !== "/api/v1/account/membership-invitations" || route.request().method() !== "POST") return false;
      const body = requestBody(route.request()) as Record<string, unknown>;
      invitationBodies.push(body);
      const invitation = {
        id: `${invitationId.slice(0, -1)}${invitationBodies.length}`,
        ...body,
        status: "pending",
        expiresAt: "2026-08-11T00:00:00.000Z",
        createdAt: occurredAt,
      };
      state.invitations = [invitation];
      await route.fulfill({ status: 201, headers: headers(state), json: { invitation } });
      return true;
    },
  });
  await browserPage.goto("/customer");
  let panel = browserPage.getByTestId("account-access-panel");
  await panel.getByLabel("Account administration password").fill("Synthetic-Manager-Password!");
  let inviteRole = panel.getByLabel("Invitation role");
  await expect(inviteRole.locator('option[value="owner"]')).toHaveCount(0);
  await expect(inviteRole.locator('option[value="billing"]')).toHaveCount(0);
  await expect(inviteRole.locator('option[value="technical"]')).toHaveCount(1);
  const technicalMemberRole = panel.getByLabel("Member role managed-member@example.invalid");
  await expect(technicalMemberRole.locator('option[value="technical"]')).toHaveCount(1);
  await expect(technicalMemberRole.locator('option[value="billing"]')).toHaveCount(0);
  await panel.getByLabel("Invitation email").fill("attempted-owner@example.invalid");
  await panel.getByLabel("Invitation permissions").fill("*");
  await panel.getByRole("button", { name: "Invite member" }).click();
  await expect(browserPage.getByText("Permission * exceeds your grant ceiling.")).toBeVisible();
  expect(seen.some((fact) => fact.path === "/api/v1/auth/reauth")).toBe(false);
  expect(invitationBodies).toHaveLength(0);
  await browserPage.getByRole("button", { name: "×" }).click();
  await panel.getByLabel("Member permissions member-manager@example.invalid").fill("*, account.members.manage");
  await panel.getByLabel("Member permissions member-manager@example.invalid").locator("xpath=ancestor::article").getByRole("button", { name: "Update member" }).click();
  await expect(browserPage.getByText("Permission * exceeds your grant ceiling.")).toBeVisible();
  await browserPage.getByRole("button", { name: "×" }).click();
  await panel.getByLabel("Invitation email").fill("technical-grant@example.invalid");
  await inviteRole.selectOption("technical");
  await panel.getByLabel("Invitation permissions").fill("services.manage");
  await panel.getByRole("button", { name: "Invite member" }).click();
  await expect.poll(() => invitationBodies.length).toBe(1);
  expect(invitationBodies[0]).toMatchObject({ role: "technical", permissions: ["services.manage"] });

  state.version = "2";
  state.role = "billing";
  state.contexts = [{
    clientAccountId: accountA,
    name: "Managed account",
    role: "billing",
    permissions: ["account.members.manage", "account.members.read"],
    capabilities: ["account.members.manage", "account.members.read", "billing.read", "billing.write", "orders.create", "support.tickets.write"],
    restrictions: { membership: false, clientAccount: false },
  }];
  state.members = [manager("billing"), managedMember];
  state.invitations = [];
  await browserPage.reload();
  panel = browserPage.getByTestId("account-access-panel");
  await panel.getByLabel("Account administration password").fill("Synthetic-Manager-Password!");
  inviteRole = panel.getByLabel("Invitation role");
  await expect(inviteRole.locator('option[value="owner"]')).toHaveCount(0);
  await expect(inviteRole.locator('option[value="technical"]')).toHaveCount(0);
  await expect(inviteRole.locator('option[value="billing"]')).toHaveCount(1);
  const billingMemberRole = panel.getByLabel("Member role managed-member@example.invalid");
  await expect(billingMemberRole.locator('option[value="billing"]')).toHaveCount(1);
  await expect(billingMemberRole.locator('option[value="technical"]')).toHaveCount(0);
  await panel.getByLabel("Invitation email").fill("billing-grant@example.invalid");
  await inviteRole.selectOption("billing");
  await panel.getByLabel("Invitation permissions").fill("billing.write");
  await panel.getByRole("button", { name: "Invite member" }).click();
  await expect.poll(() => invitationBodies.length).toBe(2);
  expect(invitationBodies[1]).toMatchObject({ role: "billing", permissions: ["billing.write"] });
});

test("restricted Client Account keeps financial and order facts read-only while support create and reply remain available", async ({ page: browserPage }) => {
  const state = baseState({
    clientRestricted: true,
    contexts: [{ clientAccountId: accountA, name: "Restricted Alpha", role: "owner", permissions: ["*"], restrictions: { membership: false, clientAccount: true } }],
  });
  let supportReplies = 0;
  const seen = await installMockApi(browserPage, state, {
    intercept: async (path, route) => {
      if (path === "/api/v1/billing/chargeback-status") {
        await route.fulfill({ headers: headers(state), json: {
          ...emptyChargebacks(state),
          restricted: true,
          debtBalanceMinor: "750",
          chargebacks: [{ id: "chargeback-1", principalMinor: "500", feeMinor: "250", externalAmountMinor: "750", creditRecoveredMinor: "0", debtMinor: "750", currency: "USD", occurredAt }],
        } });
        return true;
      }
      if (path === "/api/v1/billing/renewals") {
        await route.fulfill({ headers: headers(state), json: { items: [renewalFixture()] } });
        return true;
      }
      if (path === "/api/v1/tickets" && route.request().method() === "POST") {
        expect(route.request().headers()[contextVersionHeader.toLowerCase()]).toBe("1");
        expect(requestBody(route.request())).toEqual({
          subject: "Restriction support lifeline",
          message: "Please help while commerce remains restricted.",
          serviceId: null,
        });
        await route.fulfill({
          status: 201,
          headers: headers(state),
          json: {
            ticket: { id: "ticket-restricted", subject: "Restriction support lifeline", status: "awaiting_staff", service: null, publicMessageCount: 1, createdAt: occurredAt, updatedAt: occurredAt },
            messages: [{ id: "message-one", authorType: "customer", body: "Please help while commerce remains restricted.", createdAt: occurredAt }],
          },
        });
        return true;
      }
      if (path === "/api/v1/tickets/ticket-restricted/replies") {
        supportReplies += 1;
        expect(route.request().headers()[contextVersionHeader.toLowerCase()]).toBe("1");
        expect(requestBody(route.request())).toEqual({ message: "Adding the requested support detail." });
        await route.fulfill({
          headers: headers(state),
          json: {
            ticket: { id: "ticket-restricted", subject: "Restriction support lifeline", status: "awaiting_staff", service: null, publicMessageCount: 2, createdAt: occurredAt, updatedAt: occurredAt },
            messages: [
              { id: "message-one", authorType: "customer", body: "Please help while commerce remains restricted.", createdAt: occurredAt },
              { id: "message-two", authorType: "customer", body: "Adding the requested support detail.", createdAt: occurredAt },
            ],
          },
        });
        return true;
      }
      return false;
    },
  });
  await browserPage.goto("/customer");
  await expect(browserPage.getByTestId("customer-business-history")).toBeVisible();
  await expect(browserPage.getByRole("heading", { name: "Client Account restricted after Chargeback" })).toBeVisible();
  await expect(browserPage.getByText("$7.50").first()).toBeVisible();
  const accessPanel = browserPage.getByTestId("account-access-panel");
  await expect(accessPanel).toBeVisible();
  await expect(accessPanel.getByTestId("account-access-read-only")).toBeVisible();
  await expect(accessPanel.getByRole("button", { name: "Invite member" })).toHaveCount(0);
  await expect(accessPanel.getByRole("button", { name: "Create Contact" })).toHaveCount(0);
  await expect(browserPage.getByTestId("payment-settings-read-only")).toBeVisible();
  await expect(browserPage.getByRole("button", { name: "Pay renewal with Mock Provider" })).toHaveCount(0);
  await expect(browserPage.getByLabel(/Renewal payment method/)).toHaveCount(0);
  const ticketPanel = browserPage.locator('section[aria-label="Customer support tickets"]');
  await expect(ticketPanel).toBeVisible();
  await ticketPanel.getByLabel("Ticket subject").fill("Restriction support lifeline");
  await ticketPanel.getByLabel("Opening message").fill("Please help while commerce remains restricted.");
  await ticketPanel.getByRole("button", { name: "Create ticket" }).click();
  await expect(ticketPanel.getByTestId("customer-ticket-thread")).toContainText("Restriction support lifeline");
  await ticketPanel.getByLabel("Customer ticket reply").fill("Adding the requested support detail.");
  await ticketPanel.getByRole("button", { name: "Send reply" }).click();
  await expect.poll(() => supportReplies).toBe(1);
  await expect(ticketPanel.getByTestId("customer-ticket-thread")).toContainText("Adding the requested support detail.");
  expect(seen.some((fact) => fact.path === "/api/v1/billing/summary")).toBe(true);
  expect(seen.some((fact) => fact.path === "/api/v1/billing/chargeback-status")).toBe(true);
  expect(seen.some((fact) => fact.path === "/api/v1/orders" && fact.method === "GET")).toBe(true);
  expect(seen.some((fact) => fact.path === "/api/v1/billing/payment-settings" && fact.method === "GET")).toBe(true);
  expect(seen.some((fact) => fact.path === "/api/v1/billing/renewals" && fact.method === "GET")).toBe(true);
  expect(seen.some((fact) => fact.path === "/api/v1/tickets/service-options" && fact.method === "GET")).toBe(true);
  expect(seen.filter((fact) => fact.path === "/api/v1/tickets" && fact.method === "POST")).toHaveLength(1);
  expect(supportReplies).toBe(1);
  expect(seen.some((fact) => fact.path === "/api/v1/account/members" && fact.method === "GET")).toBe(true);
  expect(seen.some((fact) => fact.path === "/api/v1/account/membership-invitations" && fact.method === "GET")).toBe(true);
  expect(seen.some((fact) => fact.path === "/api/v1/account/contacts" && fact.method === "GET")).toBe(true);
  expect(seen.some((fact) => fact.path.startsWith("/api/v1/account/") && fact.method !== "GET")).toBe(false);
  expect(seen.some((fact) => /\/invoices\/[^/]+\/(payment-quotes|payments)$/.test(fact.path) && fact.method === "POST")).toBe(false);
});

test("invitation deep link never verifies email, survives 409 login, retries, then clears the token URL", async ({ page: browserPage }) => {
  const invitationToken = "synthetic-invitation-token-which-never-enters-storage";
  const state = baseState({ authenticated: false, activeId: null, version: "0", role: null, contexts: [] });
  let accepts = 0;
  let verifyEmailCalls = 0;
  const seen = await installMockApi(browserPage, state, {
    intercept: async (path, route) => {
      if (path === "/api/v1/auth/login") {
        state.authenticated = true;
        await route.fulfill({ status: 409, headers: headers(state), json: { error: "Select an account", code: "ACCOUNT_CONTEXT_REQUIRED", context: null, requiresAccountContext: true } });
        return true;
      }
      if (path === "/api/v1/auth/verify-email") {
        verifyEmailCalls += 1;
        await route.fulfill({ status: 500, json: { error: "Wrong endpoint" } });
        return true;
      }
      if (path === "/api/v1/membership-invitations/accept") {
        accepts += 1;
        expect(requestBody(route.request())).toEqual({ token: invitationToken });
        if (accepts === 1) {
          await route.fulfill({ status: 503, headers: headers(state), json: { error: "Temporary Mock Provider failure" } });
        } else {
          state.contexts = [{ clientAccountId: accountB, name: "Invited Beta", role: "viewer", permissions: [], restrictions: { membership: false, clientAccount: false } }];
          await route.fulfill({ status: 201, headers: headers(state), json: { membership: { clientAccountId: accountB, userId: viewerId, role: "viewer", permissions: [] }, replayed: false } });
        }
        return true;
      }
      if (path === "/api/v1/auth/account-context") {
        expect(route.request().method()).toBe("PUT");
        expect(route.request().headers()[contextVersionHeader.toLowerCase()]).toBe("0");
        expect(requestBody(route.request())).toEqual({ clientAccountId: accountB });
        state.activeId = accountB;
        state.version = "1";
        state.role = "viewer";
        await route.fulfill({
          headers: headers(state),
          json: {
            context: {
              clientAccountId: accountB,
              name: "Invited Beta",
              role: "viewer",
              permissions: [],
              restrictions: { clientAccount: false },
              version: "1",
            },
          },
        });
        return true;
      }
      return false;
    },
  });
  await browserPage.goto(`/membership-invitations/accept?token=${encodeURIComponent(invitationToken)}`);
  await browserPage.getByPlaceholder("Email").last().fill("context-owner@example.invalid");
  await browserPage.getByPlaceholder("Password", { exact: true }).fill("Synthetic-Invitation-Password!");
  await browserPage.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(browserPage.getByText("Temporary Mock Provider failure")).toBeVisible();
  expect(new URL(browserPage.url()).searchParams.get("token")).toBe(invitationToken);
  await browserPage.getByRole("button", { name: "Retry invitation acceptance" }).click();
  await expect(browserPage).toHaveURL(/\/customer$/);
  await expect(browserPage.getByTestId("account-context-switcher")).toContainText("Invited Beta");
  expect(accepts).toBe(2);
  expect(verifyEmailCalls).toBe(0);
  expect(seen.filter((fact) => fact.path === "/api/v1/membership-invitations/accept")).toHaveLength(2);
  expect(seen.filter((fact) => fact.path === "/api/v1/auth/account-context" && fact.method === "PUT")).toHaveLength(1);
  expect(await browserPage.evaluate((token) => Object.values(localStorage).includes(token), invitationToken)).toBe(false);
});

test("a brand-new invited email creates only an identity, verifies in place, accepts, and activates the invited account", async ({ page: browserPage }) => {
  const invitationToken = "synthetic-new-identity-invitation-token";
  const emailVerificationToken = "synthetic-email-verification-token";
  const invitedEmail = "brand-new-invitee@example.invalid";
  const state = baseState({ authenticated: false, activeId: null, version: "0", role: null, contexts: [] });
  let emailVerified = false;
  let appOrigin = "";
  let invitationRegistrations = 0;
  let genericRegistrations = 0;
  let accepts = 0;
  let contextSwitches = 0;
  const seen = await installMockApi(browserPage, state, {
    intercept: async (path, route) => {
      if (path === "/api/v1/auth/me" && state.authenticated) {
        const current = viewer(state);
        await route.fulfill({
          headers: headers(state),
          json: {
            ...current,
            email: invitedEmail,
            verification: { email: emailVerified ? "passed" : "pending" },
            eligible: emailVerified && current.eligible,
          },
        });
        return true;
      }
      if (path === "/api/v1/auth/invitation-registrations") {
        invitationRegistrations += 1;
        expect(route.request().method()).toBe("POST");
        expect(route.request().headers()[contextVersionHeader.toLowerCase()]).toBeUndefined();
        expect(requestBody(route.request())).toEqual({
          token: invitationToken,
          email: invitedEmail,
          password: "Synthetic-Invited-Identity!",
          locale: "en",
        });
        await route.fulfill({
          status: 201,
          json: {
            userId: viewerId,
            registrationMode: "membership_invitation",
            verification: { status: "pending", expiresAt: "2026-08-11T00:00:00.000Z" },
          },
        });
        return true;
      }
      if (path === "/api/v1/auth/register") {
        genericRegistrations += 1;
        await route.fulfill({ status: 500, json: { error: "Generic registration must not be used" } });
        return true;
      }
      if (path === "/api/v1/auth/login") {
        state.authenticated = true;
        await route.fulfill({
          status: 409,
          headers: headers(state),
          json: { error: "Select an account", code: "ACCOUNT_CONTEXT_REQUIRED", context: null, requiresAccountContext: true },
        });
        return true;
      }
      if (path === "/api/v1/lab/mailbox") {
        await route.fulfill({
          headers: headers(state),
          json: {
            messages: [
              {
                id: "mail-membership-invitation",
                subject: "Client Account membership invitation",
                body: `${appOrigin}/membership-invitations/accept?token=${invitationToken}`,
                status: "delivered",
                deliveredAt: occurredAt,
              },
              {
                id: "mail-new-invitee",
                subject: "Verify your invited identity",
                body: `${appOrigin}/verify?token=${emailVerificationToken}`,
                status: "delivered",
                deliveredAt: occurredAt,
              },
            ],
          },
        });
        return true;
      }
      if (path === "/api/v1/auth/verify-email") {
        expect(requestBody(route.request())).toEqual({ token: emailVerificationToken });
        emailVerified = true;
        await route.fulfill({ headers: headers(state), json: { status: "verified" } });
        return true;
      }
      if (path === "/api/v1/membership-invitations/accept") {
        accepts += 1;
        expect(route.request().headers()[contextVersionHeader.toLowerCase()]).toBe("0");
        expect(requestBody(route.request())).toEqual({ token: invitationToken });
        state.contexts = [{ clientAccountId: accountB, name: "Invited Beta", role: "viewer", permissions: [], restrictions: { membership: false, clientAccount: false } }];
        await route.fulfill({
          status: 201,
          headers: headers(state),
          json: { membership: { clientAccountId: accountB, userId: viewerId, role: "viewer", permissions: [] }, replayed: false },
        });
        return true;
      }
      if (path === "/api/v1/auth/account-context") {
        contextSwitches += 1;
        expect(route.request().headers()[contextVersionHeader.toLowerCase()]).toBe("0");
        expect(requestBody(route.request())).toEqual({ clientAccountId: accountB });
        state.activeId = accountB;
        state.version = "1";
        state.role = "viewer";
        await route.fulfill({
          headers: headers(state),
          json: { context: { ...state.contexts[0], version: "1", restrictions: { clientAccount: false } } },
        });
        return true;
      }
      return false;
    },
  });

  await browserPage.goto(`/membership-invitations/accept?token=${encodeURIComponent(invitationToken)}`);
  appOrigin = new URL(browserPage.url()).origin;
  const registration = browserPage.getByTestId("invitation-registration-form");
  await expect(registration.getByText("no unrelated Client Account")).toBeVisible();
  await expect(registration.locator('input[name="clientName"]')).toHaveCount(0);
  await registration.getByPlaceholder("Invited email").fill(invitedEmail);
  await registration.getByPlaceholder("Password (12+ characters)").fill("Synthetic-Invited-Identity!");
  await registration.getByRole("button", { name: "Create invited identity" }).click();
  await expect(browserPage.getByText("Invited User identity created without a Client Account")).toBeVisible();

  const loginForm = browserPage.getByRole("heading", { name: "Sign in" }).locator("xpath=ancestor::form");
  await loginForm.getByPlaceholder("Email").fill(invitedEmail);
  await loginForm.getByPlaceholder("Password", { exact: true }).fill("Synthetic-Invited-Identity!");
  await loginForm.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(browserPage.getByRole("button", { name: "Open my Mock Provider mailbox" })).toBeVisible();
  expect(seen.filter((fact) => fact.path === "/api/v1/auth/account-contexts")).toHaveLength(0);
  expect(new URL(browserPage.url()).searchParams.get("token")).toBe(invitationToken);
  await browserPage.getByRole("button", { name: "Open my Mock Provider mailbox" }).click();
  await expect(browserPage.getByText("Current membership invitation link (already open)")).toBeVisible();
  await expect(browserPage.getByRole("link", { name: "Use one-time verification link" })).toHaveCount(1);
  await browserPage.getByRole("link", { name: "Use one-time verification link" }).click();

  await expect(browserPage).toHaveURL(/\/customer$/);
  await expect(browserPage.getByTestId("account-context-switcher")).toContainText("Invited Beta");
  expect(invitationRegistrations).toBe(1);
  expect(genericRegistrations).toBe(0);
  expect(accepts).toBe(1);
  expect(contextSwitches).toBe(1);
  expect(seen.filter((fact) => fact.path === "/api/v1/auth/account-context" && fact.method === "PUT")).toHaveLength(1);
  expect(await browserPage.evaluate(
    (token) => ({
      local: Object.values(localStorage).includes(token),
      session: Object.values(sessionStorage).includes(token),
    }),
    invitationToken,
  )).toEqual({ local: false, session: false });
});

test("Chinese member, invitation and Contact journey transfers owner and immediately drops self-management", async ({ page: browserPage }) => {
  const ownerA = {
    userId: viewerId,
    email: "context-owner@example.invalid",
    role: "owner",
    permissions: ["*"],
    restrictions: { membership: false, user: false },
    isRecordedOwner: true,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  const replacement = {
    userId: ownerBId,
    email: "replacement-owner@example.invalid",
    role: "owner",
    permissions: ["*"],
    restrictions: { membership: false, user: false },
    isRecordedOwner: false,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  const state = baseState({
    contexts: [{ clientAccountId: accountA, name: "中文账户", role: "owner", permissions: ["*"], restrictions: { membership: false, clientAccount: false } }],
    members: [ownerA, replacement],
  });
  let ownerPatchBody: unknown;
  let ownerPatchSeen!: () => void;
  const ownerPatched = new Promise<void>((resolve) => { ownerPatchSeen = resolve; });
  const seen = await installMockApi(browserPage, state, {
    intercept: async (path, route) => {
      if (path === "/api/v1/account/membership-invitations" && route.request().method() === "POST") {
        const body = requestBody(route.request()) as Record<string, unknown>;
        const invitation = { id: invitationId, ...body, status: "pending", expiresAt: "2026-08-11T00:00:00.000Z", createdAt: occurredAt };
        state.invitations = [invitation];
        await route.fulfill({ status: 201, headers: headers(state), json: { invitation } });
        return true;
      }
      if (path === "/api/v1/account/contacts" && route.request().method() === "POST") {
        const body = requestBody(route.request()) as Record<string, unknown>;
        const contact = { id: contactId, ...body, createdAt: occurredAt, updatedAt: occurredAt };
        state.contacts = [contact];
        await route.fulfill({ status: 201, headers: headers(state), json: { contact } });
        return true;
      }
      if (path === `/api/v1/account/members/${viewerId}` && route.request().method() === "PATCH") {
        ownerPatchBody = requestBody(route.request());
        ownerPatchSeen();
        state.version = "2";
        state.role = "viewer";
        state.permissions = ["account.contacts.read"];
        state.contexts[0] = { ...state.contexts[0]!, role: "viewer", permissions: ["account.contacts.read"] };
        state.members = [{ ...ownerA, role: "viewer", permissions: ["account.contacts.read"], isRecordedOwner: false }, replacement];
        await route.fulfill({ headers: headers(state), json: { member: { userId: viewerId, role: "viewer", permissions: ["account.contacts.read"], restrictions: { membership: false }, updatedAt: occurredAt } } });
        return true;
      }
      return false;
    },
  });
  await browserPage.goto("/customer");
  await browserPage.getByRole("button", { name: "简体中文" }).click();
  const panel = browserPage.getByTestId("account-access-panel");
  await expect(panel.getByRole("heading", { name: "成员、邀请与联系人" })).toBeVisible();
  await panel.getByLabel("Account administration password").fill("Synthetic-Owner-Password!");
  await panel.getByLabel("Invitation email").fill("invitee@example.invalid");
  await panel.getByLabel("Invitation locale").selectOption("zh-CN");
  await panel.getByRole("button", { name: "邀请成员" }).click();
  await expect(panel.getByTestId("account-invitation")).toContainText("invitee@example.invalid");
  await panel.getByLabel("Contact display name").fill("财务通知人");
  await panel.getByLabel("Contact email").fill("finance-zh@example.invalid");
  await panel.getByRole("button", { name: "创建联系人" }).click();
  await expect(panel.getByTestId("account-contact")).toContainText("财务通知人");

  const currentMember = panel
    .getByLabel("Member role context-owner@example.invalid")
    .locator("xpath=ancestor::article[@data-testid='account-member']");
  await currentMember.getByLabel("Replacement owner context-owner@example.invalid").selectOption(ownerBId);
  await currentMember.getByLabel("Member role context-owner@example.invalid").selectOption("viewer");
  await currentMember.getByLabel("Member permissions context-owner@example.invalid").fill("account.contacts.read");
  await currentMember.getByRole("button", { name: "更新成员" }).click();
  await ownerPatched;

  expect(ownerPatchBody).toEqual({
    role: "viewer",
    permissions: ["account.contacts.read"],
    restricted: false,
    replacementOwnerUserId: ownerBId,
  });
  await expect(browserPage.getByRole("heading", { name: "客户账户成员" })).toHaveCount(0);
  await expect(browserPage.getByRole("button", { name: "创建联系人" })).toHaveCount(0);
  await expect(browserPage.locator('section[aria-label="Customer support tickets"]').getByRole("button", { name: "创建工单" })).toHaveCount(0);
  await expect(browserPage.getByTestId("payment-settings-read-only")).toBeVisible();
  await expect(browserPage.getByText("仅为联系人——没有登录或客户账户成员权限")).toBeVisible();
  const businessMutations = seen.filter((fact) => fact.method !== "GET" && fact.path.startsWith("/api/v1/account/"));
  expect(businessMutations.every((fact) => fact.version === "1")).toBe(true);
});

for (const selfChange of ["restrict", "remove"] as const) {
  test(`self ${selfChange} refreshes identity and unmounts account controls immediately`, async ({ page: browserPage }) => {
    const currentOwner = {
      userId: viewerId,
      email: "context-owner@example.invalid",
      role: "owner",
      permissions: ["*"],
      restrictions: { membership: false, user: false },
      isRecordedOwner: true,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    };
    const replacementOwner = {
      userId: ownerBId,
      email: "replacement-owner@example.invalid",
      role: "owner",
      permissions: ["*"],
      restrictions: { membership: false, user: false },
      isRecordedOwner: false,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    };
    const state = baseState({
      contexts: [{ clientAccountId: accountA, name: "Account Alpha", role: "owner", permissions: ["*"], restrictions: { membership: false, clientAccount: false } }],
      members: [currentOwner, replacementOwner],
    });
    let mutationSeen!: () => void;
    const mutationArrived = new Promise<void>((resolve) => { mutationSeen = resolve; });
    let mutationFact: SeenRequest | undefined;
    const seen = await installMockApi(browserPage, state, {
      intercept: async (path, route, facts) => {
        const method = route.request().method();
        if (
          path === `/api/v1/account/members/${viewerId}` &&
          method === (selfChange === "restrict" ? "PATCH" : "DELETE")
        ) {
          if (selfChange === "remove") {
            expect(new URL(route.request().url()).searchParams.get("replacementOwnerUserId")).toBe(ownerBId);
          }
          mutationFact = facts.at(-1);
          state.version = "2";
          state.activeId = null;
          state.role = null;
          state.permissions = [];
          state.contexts = selfChange === "restrict"
            ? [{ clientAccountId: accountA, name: "Account Alpha", role: "owner", permissions: ["*"], restrictions: { membership: true, clientAccount: false } }]
            : [];
          mutationSeen();
          await route.fulfill({
            headers: { [contextVersionHeader]: "2" },
            json: selfChange === "restrict"
              ? { member: { userId: viewerId, role: "owner", permissions: ["*"], restrictions: { membership: true }, updatedAt: occurredAt } }
              : { removed: true, userId: viewerId },
          });
          return true;
        }
        return false;
      },
    });
    await browserPage.goto("/customer");
    const panel = browserPage.getByTestId("account-access-panel");
    await panel.getByLabel("Account administration password").fill("Synthetic-Owner-Password!");
    const editor = panel
      .getByLabel("Member role context-owner@example.invalid")
      .locator("xpath=ancestor::article[@data-testid='account-member']");
    await editor.getByLabel("Replacement owner context-owner@example.invalid").selectOption(ownerBId);
    if (selfChange === "restrict") {
      await editor.getByLabel("Restrict member context-owner@example.invalid").check();
      await editor.getByRole("button", { name: "Update member" }).click();
    } else {
      await editor.getByRole("button", { name: "Remove member" }).click();
    }
    await mutationArrived;
    await expect(browserPage.getByTestId("account-access-panel")).toHaveCount(0);
    await expect(browserPage.getByRole("button", { name: /Update member|Remove member/ })).toHaveCount(0);
    expect(mutationFact?.version).toBe("1");
    if (selfChange === "restrict") {
      expect(mutationFact?.body).toEqual({
        role: "owner",
        permissions: ["*"],
        restricted: true,
        replacementOwnerUserId: ownerBId,
      });
    } else {
      expect(seen.some((fact) => fact.path === `/api/v1/account/members/${viewerId}` && fact.method === "DELETE")).toBe(true);
    }
  });
}

test("reauth released after an account switch cannot dispatch the old invitation mutation", async ({ page: browserPage }) => {
  let releaseReauth!: () => void;
  let reauthStarted!: () => void;
  const reauthGate = new Promise<void>((resolve) => { releaseReauth = resolve; });
  const sawReauth = new Promise<void>((resolve) => { reauthStarted = resolve; });
  let invitationPosts = 0;
  const state = baseState({
    contexts: [
      { clientAccountId: accountA, name: "Account Alpha", role: "owner", permissions: ["*"], restrictions: { membership: false, clientAccount: false } },
      { clientAccountId: accountB, name: "Account Beta", role: "viewer", permissions: [], restrictions: { membership: false, clientAccount: false } },
    ],
  });
  await installMockApi(browserPage, state, {
    intercept: async (path, route) => {
      if (path === "/api/v1/auth/reauth") {
        reauthStarted();
        await reauthGate;
        await route.fulfill({ headers: { [contextVersionHeader]: "1", [contextIdHeader]: accountA }, json: { expiresAt: "2026-08-10T00:15:00.000Z", fixedWindowMinutes: 15 } });
        return true;
      }
      if (path === "/api/v1/auth/account-context") {
        state.activeId = accountB;
        state.version = "2";
        state.role = "viewer";
        await route.fulfill({ headers: headers(state), json: { context: { ...state.contexts[1], version: "2", restrictions: { clientAccount: false } } } });
        return true;
      }
      if (path === "/api/v1/account/membership-invitations" && route.request().method() === "POST") {
        invitationPosts += 1;
        await route.fulfill({ status: 500, json: { error: "Must not be reached" } });
        return true;
      }
      return false;
    },
  });
  await browserPage.goto("/customer");
  const panel = browserPage.getByTestId("account-access-panel");
  await panel.getByLabel("Account administration password").fill("Synthetic-Owner-Password!");
  await panel.getByLabel("Invitation email").fill("blocked@example.invalid");
  await panel.getByRole("button", { name: "Invite member" }).click();
  await sawReauth;
  const switcher = browserPage.getByTestId("account-context-switcher");
  await switcher.getByLabel("Active Client Account").selectOption(accountB);
  await switcher.getByRole("button", { name: "Switch account" }).click();
  await expect(browserPage.getByTestId("history-account")).toContainText("Account Beta");
  releaseReauth();
  await expect(browserPage.getByText("Membership invitation queued")).toHaveCount(0);
  expect(invitationPosts).toBe(0);
});
