// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Page, type Route } from "@playwright/test";
import {
  fulfillNotificationInterfaceRequest,
  notificationPreferencesMockState,
} from "./helpers/notification-interfaces.js";

const clientAccountId = "00000000-0000-4000-8000-000000003101";
const userId = "00000000-0000-4000-8000-000000003102";
const quoteId = "00000000-0000-4000-8000-000000003103";
const productRevisionId = "00000000-0000-4000-8000-000000003104";
const priceId = "00000000-0000-4000-8000-000000003105";
const termsDocumentId = "00000000-0000-4000-8000-000000003106";
const aupDocumentId = "00000000-0000-4000-8000-000000003107";
const orderId = "00000000-0000-4000-8000-000000003108";
const invoiceId = "00000000-0000-4000-8000-000000003109";
const serviceId = "00000000-0000-4000-8000-000000003110";

const sessionHeaders = {
  "X-OSS-Account-Context-Version": "1",
  "X-OSS-Authorization-Epoch": "1",
};
const accountHeaders = {
  ...sessionHeaders,
  "X-OSS-Client-Account-Id": clientAccountId,
};

function fulfillJson(
  route: Route,
  json: unknown,
  options: { status?: number; account?: boolean; session?: boolean } = {},
): Promise<void> {
  const headers = options.account
    ? accountHeaders
    : options.session
      ? sessionHeaders
      : undefined;
  return route.fulfill({
    status: options.status ?? 200,
    ...(headers ? { headers } : {}),
    json,
  });
}

function isSupportDepartmentsRequest(
  request: { url(): string; method(): string },
  audience: "authenticated" | "presales",
): boolean {
  const url = new URL(request.url());
  return request.method() === "GET"
    && url.pathname === "/api/v1/support/departments"
    && [...url.searchParams.keys()].length === 1
    && url.searchParams.get("audience") === audience;
}

const legal = {
  requestedLocale: "en",
  documents: {
    terms: {
      id: termsDocumentId,
      documentId: termsDocumentId,
      locale: "en",
      fallback: false,
      revision: "1",
      version: "terms-v1",
      title: "Mock Terms",
      body: "Synthetic laboratory terms.",
    },
    aup: {
      id: aupDocumentId,
      documentId: aupDocumentId,
      locale: "en",
      fallback: false,
      revision: "1",
      version: "aup-v1",
      title: "Mock AUP",
      body: "Synthetic laboratory acceptable use policy.",
    },
    privacy: {
      id: "00000000-0000-4000-8000-000000003111",
      documentId: "00000000-0000-4000-8000-000000003111",
      locale: "en",
      fallback: false,
      revision: "1",
      version: "privacy-v1",
      title: "Mock Privacy",
      body: "Synthetic laboratory privacy text.",
    },
  },
};

function staffViewer(permission: string) {
  return {
    id: userId,
    email: "commerce-staff@example.invalid",
    locale: "en",
    clientAccountId: null,
    membershipRole: null,
    accountContextVersion: "1",
    context: null,
    verification: { email: "passed" },
    restrictions: { user: false, clientAccount: false },
    eligible: false,
    staff: { roles: ["operations"], permissions: [permission] },
  };
}

type AdminSurface = Readonly<{
  permission: string;
  endpoint: string;
  section: string;
  response: unknown;
  loadsReadEndpoint: boolean;
  entry: "direct" | "normal-login" | "mfa-login";
}>;

const adminSurfaces: readonly AdminSurface[] = [
  {
    permission: "catalog.read",
    endpoint: "/api/v1/admin/catalog",
    section: "admin-catalog-section",
    response: { warning: "MOCK ONLY", groups: [], products: [], revisions: [], prices: [], supply: [] },
    loadsReadEndpoint: true,
    entry: "normal-login",
  },
  {
    permission: "catalog.manage",
    endpoint: "/api/v1/admin/catalog",
    section: "admin-catalog-section",
    response: { warning: "MOCK ONLY", groups: [], products: [], revisions: [], prices: [], supply: [] },
    loadsReadEndpoint: false,
    entry: "direct",
  },
  {
    permission: "catalog.promotions.read",
    endpoint: "/api/v1/admin/promotions",
    section: "admin-promotions-section",
    response: { warning: "MOCK ONLY", items: [] },
    loadsReadEndpoint: true,
    entry: "direct",
  },
  {
    permission: "catalog.promotions.manage",
    endpoint: "/api/v1/admin/promotions",
    section: "admin-promotions-section",
    response: { warning: "MOCK ONLY", items: [] },
    loadsReadEndpoint: false,
    entry: "direct",
  },
  {
    permission: "quotes.read",
    endpoint: "/api/v1/admin/quotes",
    section: "admin-quotes-section",
    response: { warning: "MOCK ONLY", items: [] },
    loadsReadEndpoint: true,
    entry: "mfa-login",
  },
  {
    permission: "quotes.manage",
    endpoint: "/api/v1/admin/quotes",
    section: "admin-quotes-section",
    response: { warning: "MOCK ONLY", items: [] },
    loadsReadEndpoint: false,
    entry: "direct",
  },
];

async function installAdminSurfaceMock(page: Page, surface: AdminSurface) {
  const requestedAdminPaths: string[] = [];
  const unexpected: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (isSupportDepartmentsRequest(request, "presales")) {
      await fulfillJson(route, { items: [] });
      return;
    }
    if (path === "/api/v1/catalog") {
      await fulfillJson(route, { locale: "en", currency: "USD", products: [] });
      return;
    }
    if (path === "/api/v1/legal/current") {
      await fulfillJson(route, legal);
      return;
    }
    if (path === "/api/v1/content") {
      await fulfillJson(route, { items: [] });
      return;
    }
    if (path === "/api/v1/auth/login" && method === "POST") {
      if (surface.entry === "mfa-login") {
        await fulfillJson(route, {
          challenge: {
            id: "00000000-0000-4000-8000-000000003112",
            token: "synthetic-login-challenge-token",
            methods: ["totp"],
          },
        }, { status: 202 });
      } else {
        await fulfillJson(route, {}, { session: true });
      }
      return;
    }
    if (path === "/api/v1/auth/login-challenges/complete" && method === "POST") {
      expect(surface.entry).toBe("mfa-login");
      expect(request.postDataJSON()).toMatchObject({ factorCode: "123456" });
      await fulfillJson(route, {}, { session: true });
      return;
    }
    if (path === "/api/v1/auth/me") {
      await fulfillJson(route, staffViewer(surface.permission), { session: true });
      return;
    }
    if (path.startsWith("/api/v1/admin/")) {
      requestedAdminPaths.push(`${method} ${path}`);
      if (method === "GET" && path === surface.endpoint) {
        await fulfillJson(route, surface.response, { session: true });
        return;
      }
    }
    unexpected.push(`${method} ${path}`);
    await fulfillJson(route, { error: `Unexpected request: ${method} ${path}` }, { status: 500, session: true });
  });
  return { requestedAdminPaths, unexpected };
}

for (const surface of adminSurfaces) {
  test(`a Staff User with only ${surface.permission} enters Admin and loads only its own facet`, async ({ page }) => {
    const requests = await installAdminSurfaceMock(page, surface);
    await page.goto(surface.entry === "direct" ? "/admin" : "/");

    if (surface.entry !== "direct") {
      const signIn = page.locator("form").filter({ has: page.getByRole("heading", { name: "Sign in" }) });
      await signIn.getByPlaceholder("Email").fill("commerce-staff@example.invalid");
      await signIn.getByPlaceholder("Password").fill("synthetic-password");
      await signIn.getByRole("button", { name: "Sign in" }).click();
      if (surface.entry === "mfa-login") {
        const challenge = page.getByTestId("login-factor-challenge");
        await expect(challenge).toBeVisible();
        await challenge.getByLabel("TOTP / recovery code").fill("123456");
        await challenge.getByRole("button", { name: "Complete sign in" }).click();
      }
    }

    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByTestId("admin-commerce-panel")).toBeVisible();
    await expect(page.getByTestId(surface.section)).toBeVisible();
    for (const other of adminSurfaces.filter((candidate) => candidate.section !== surface.section)) {
      await expect(page.getByTestId(other.section)).toHaveCount(0);
    }
    if (surface.loadsReadEndpoint) {
      await expect.poll(() => requests.requestedAdminPaths.length).toBeGreaterThan(0);
      expect(new Set(requests.requestedAdminPaths)).toEqual(new Set([`GET ${surface.endpoint}`]));
    } else {
      expect(requests.requestedAdminPaths).toEqual([]);
    }
    expect(requests.unexpected).toEqual([]);
  });
}

test("Customer Quote preview and acceptance grant optional Marketing Consent, which remains independently withdrawable", async ({ page }) => {
  let quoteAccepted = false;
  let marketingGranted = false;
  let acceptancePayload: Record<string, unknown> | null = null;
  let withdrawalPayload: Record<string, unknown> | null = null;
  const unexpected: string[] = [];
  const notificationPreferences = notificationPreferencesMockState();

  const quote = () => ({
    quoteId,
    clientAccountId,
    createdByStaffUserId: "00000000-0000-4000-8000-000000003113",
    status: quoteAccepted ? "accepted" : "draft",
    productId: "mock-quote-plan",
    productRevisionId,
    priceId,
    productName: "Mock Quote Plan",
    fulfillmentMode: "automatic",
    billingCycle: "monthly",
    configuration: { units: 2 },
    price: { revision: 1 },
    promotionId: null,
    promotion: null,
    supply: { mode: "unlimited", units: "2" },
    currency: "USD",
    oneTimeMinor: "0",
    setupMinor: "100",
    recurringMinor: "900",
    totalMinor: "1000",
    expiresAt: "2030-01-01T00:00:00.000Z",
    createdAt: "2026-08-20T00:00:00.000Z",
    void: null,
    acceptance: quoteAccepted ? {
      acceptanceId: "00000000-0000-4000-8000-000000003114",
      acceptedByUserId: userId,
      orderId,
      invoiceId,
      acceptedAt: "2026-08-20T01:00:00.000Z",
    } : null,
  });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (await fulfillNotificationInterfaceRequest(route, {
      customerPreferences: true,
      adminTemplates: false,
      preferenceState: notificationPreferences,
      headers: accountHeaders,
    })) return;
    if (isSupportDepartmentsRequest(request, "authenticated")) {
      await fulfillJson(route, { items: [] }, { account: true });
      return;
    }
    if (path === "/api/v1/auth/me") {
      await fulfillJson(route, {
        id: userId,
        email: "quote-customer@example.invalid",
        locale: "en",
        clientAccountId,
        membershipRole: "owner",
        accountContextVersion: "1",
        context: {
          clientAccountId,
          name: "Quote customer account",
          role: "owner",
          permissions: [],
          capabilities: ["account.history.read", "orders.create"],
          version: "1",
        },
        verification: { email: "passed" },
        restrictions: { user: false, clientAccount: false },
        eligible: true,
        staff: null,
      }, { account: true });
      return;
    }
    if (path === "/api/v1/auth/account-contexts") {
      await fulfillJson(route, {
        activeClientAccountId: clientAccountId,
        accountContextVersion: "1",
        items: [{
          clientAccountId,
          name: "Quote customer account",
          role: "owner",
          permissions: [],
          capabilities: ["account.history.read", "orders.create"],
          restrictions: { membership: false, clientAccount: false },
        }],
        limit: 25,
        hasMore: false,
        nextCursor: null,
      }, { account: true });
      return;
    }
    if (path === "/api/v1/catalog") {
      await fulfillJson(route, { locale: "en", currency: "USD", products: [] });
      return;
    }
    if (path === "/api/v1/legal/current") {
      await fulfillJson(route, legal);
      return;
    }
    if (path === "/api/v1/content") {
      await fulfillJson(route, { items: [] });
      return;
    }
    if (path === "/api/v1/customer/content") {
      await fulfillJson(route, { items: [] }, { account: true });
      return;
    }
    if (path === "/api/v1/customer/business-history") {
      await fulfillJson(route, {
        warning: "MOCK ONLY",
        account: { id: clientAccountId, name: "Quote customer account" },
        orders: [], invoices: [], payments: [], refunds: [], services: [], renewals: [], cancellations: [], tickets: [],
        credit: { currency: "USD", balanceMinor: "0", transactions: [] },
      }, { account: true });
      return;
    }
    if (path === "/api/v1/customer/notification-deliveries") {
      await fulfillJson(route, {
        warning: "MOCK ONLY",
        account: { id: clientAccountId, name: "Quote customer account" },
        items: [], limit: 20, hasMore: false, nextCursor: null,
      }, { account: true });
      return;
    }
    if (path === "/api/v1/orders" && method === "GET") {
      await fulfillJson(route, { items: [] }, { account: true });
      return;
    }
    if (path === "/api/v1/billing/summary") {
      await fulfillJson(route, {
        currency: "USD",
        creditBalanceMinor: "0",
        paymentMethods: [],
        addFunds: { enabled: false, allowed: false, minimumMinor: "5000", maximumMinor: "500000", balanceCapMinor: "1000000" },
      }, { account: true });
      return;
    }
    if (path === "/api/v1/billing/payment-settings") {
      await fulfillJson(route, {
        defaults: { savePaymentMethod: false, automaticRenewal: false },
        consentVersions: { savePaymentMethod: "save-v1", automaticRenewal: "renew-v1" },
        methods: [], automaticRenewals: [], pendingAutomaticRenewals: [], serviceDecisions: [],
      }, { account: true });
      return;
    }
    if (path === "/api/v1/billing/renewals") {
      await fulfillJson(route, { items: [] }, { account: true });
      return;
    }
    if (path === "/api/v1/billing/chargeback-status") {
      await fulfillJson(route, {
        clientAccountId,
        restricted: false,
        creditBalanceMinor: "0",
        debtBalanceMinor: "0",
        chargebacks: [], unclaimedChargebacks: [], manualHolds: [],
      }, { account: true });
      return;
    }
    if (path === "/api/v1/tickets" || path === "/api/v1/tickets/service-options") {
      await fulfillJson(route, { items: [] }, { account: true });
      return;
    }
    if (path === "/api/v1/quotes" && method === "GET") {
      await fulfillJson(route, { warning: "MOCK ONLY", items: [quote()] }, { account: true });
      return;
    }
    if (path === `/api/v1/quotes/${quoteId}` && method === "GET") {
      await fulfillJson(route, { warning: "MOCK ONLY", quote: quote() }, { account: true });
      return;
    }
    if (path === `/api/v1/quotes/${quoteId}/acceptance-preview` && method === "POST") {
      expect(request.headers()["x-oss-account-context-version"]).toBe("1");
      expect(request.postDataJSON()).toMatchObject({
        termsVersion: "terms-v1",
        aupVersion: "aup-v1",
        termsDocumentId,
        aupDocumentId,
      });
      await fulfillJson(route, {
        warning: "MOCK ONLY",
        quote: quote(),
        acceptance: {
          eligible: true,
          invoiceTotalMinor: "1000",
          zeroAmount: false,
          terms: { id: termsDocumentId, version: "terms-v1", locale: "en" },
          aup: { id: aupDocumentId, version: "aup-v1", locale: "en" },
          supply: { mode: "unlimited", units: "2", availableUnits: null, committedUnits: "0", version: null },
          promotionAvailable: true,
          marketingConsentDefault: false,
          marketingConsentPolicyVersion: "mock-lab-marketing-v1",
        },
      }, { account: true });
      return;
    }
    if (path === `/api/v1/quotes/${quoteId}/accept` && method === "POST") {
      acceptancePayload = request.postDataJSON() as Record<string, unknown>;
      expect(request.headers()["x-oss-account-context-version"]).toBe("1");
      quoteAccepted = true;
      marketingGranted = acceptancePayload.marketingConsent === true;
      await fulfillJson(route, {
        acceptanceId: "00000000-0000-4000-8000-000000003114",
        quoteId,
        orderId,
        invoiceId,
        serviceId,
        orderStatus: "waiting_payment",
        replayed: false,
      }, { status: 201, account: true });
      return;
    }
    if (path === "/api/v1/marketing-consent" && method === "GET") {
      await fulfillJson(route, {
        granted: marketingGranted,
        policyVersion: "mock-lab-marketing-v1",
        recordedAt: marketingGranted ? "2026-08-20T01:00:00.000Z" : null,
        defaulted: !marketingGranted,
      }, { account: true });
      return;
    }
    if (path === "/api/v1/marketing-consent/withdraw" && method === "POST") {
      withdrawalPayload = request.postDataJSON() as Record<string, unknown>;
      expect(request.headers()["x-oss-account-context-version"]).toBe("1");
      marketingGranted = false;
      await fulfillJson(route, {
        consentEventId: "00000000-0000-4000-8000-000000003115",
        granted: false,
      }, { account: true });
      return;
    }

    unexpected.push(`${method} ${path}`);
    await fulfillJson(route, { error: `Unexpected request: ${method} ${path}` }, { status: 500, account: true });
  });

  await page.goto("/customer");
  const quotePanel = page.getByTestId("customer-quote-panel");
  await expect(quotePanel).toBeVisible();
  await quotePanel.getByRole("button", { name: "Open detail" }).click();
  await quotePanel.getByRole("button", { name: "Preview and validate Quote" }).click();
  const acceptance = quotePanel.getByTestId("customer-quote-acceptance");
  await expect(acceptance).toBeVisible();
  await acceptance.getByLabel("Accept Terms version terms-v1").check();
  await acceptance.getByLabel("Accept AUP version aup-v1").check();
  const optionalMarketing = acceptance.getByRole("checkbox").last();
  await expect(optionalMarketing).not.toBeChecked();
  await optionalMarketing.check();
  await acceptance.getByRole("button", { name: "Accept Quote and create Order/Invoice" }).click();

  await expect(quotePanel.getByText(/Accepted · Order/)).toBeVisible();
  expect(acceptancePayload).toMatchObject({
    marketingConsent: true,
    marketingConsentPolicyVersion: "mock-lab-marketing-v1",
    termsVersion: "terms-v1",
    aupVersion: "aup-v1",
  });

  const consentPanel = page.getByTestId("marketing-consent-panel");
  await consentPanel.getByRole("button", { name: "Refresh state" }).click();
  await expect(consentPanel.getByText("Granted", { exact: true })).toBeVisible();
  await consentPanel.getByRole("button", { name: "Withdraw Marketing Consent" }).click();
  await expect(consentPanel.getByText("Off", { exact: true })).toBeVisible();
  expect(withdrawalPayload).toEqual({
    idempotencyKey: expect.stringMatching(/^withdraw-marketing-/),
  });
  expect(unexpected).toEqual([]);
});

test("a committed Product revision clears its form even when the following Catalog refresh fails", async ({ page }) => {
  let catalogReads = 0;
  let productCreates = 0;
  const unexpected: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/api/v1/catalog") {
      await fulfillJson(route, { locale: "en", currency: "USD", products: [] });
      return;
    }
    if (path === "/api/v1/legal/current") {
      await fulfillJson(route, legal);
      return;
    }
    if (path === "/api/v1/auth/me") {
      const viewer = staffViewer("catalog.read");
      await fulfillJson(route, {
        ...viewer,
        staff: { roles: ["operations"], permissions: ["catalog.read", "catalog.manage"] },
      }, { session: true });
      return;
    }
    if (path === "/api/v1/admin/catalog" && method === "GET") {
      catalogReads += 1;
      // React development StrictMode mounts the read effect twice. Both
      // initial reads succeed; only the post-commit refresh is unavailable.
      if (catalogReads <= 2) {
        await fulfillJson(route, {
          warning: "MOCK ONLY", groups: [], products: [], revisions: [], prices: [], supply: [],
        }, { session: true });
      } else {
        await fulfillJson(route, { error: "Catalog refresh temporarily unavailable" }, { status: 503, session: true });
      }
      return;
    }
    if (path === "/api/v1/admin/catalog/products" && method === "POST") {
      productCreates += 1;
      await fulfillJson(route, { id: "new-mock-product", revision: 1 }, { status: 201, session: true });
      return;
    }
    unexpected.push(`${method} ${path}`);
    await fulfillJson(route, { error: `Unexpected request: ${method} ${path}` }, { status: 500, session: true });
  });

  await page.goto("/admin");
  const form = page.getByTestId("catalog-product-form");
  await expect(form).toBeVisible();
  await form.getByPlaceholder("product-id").fill("new-mock-product");
  await form.getByPlaceholder("group-id").fill("mock-group");
  await form.getByPlaceholder("English name").fill("New Mock Product");
  await form.getByPlaceholder("English description").fill("A normal synthetic product revision.");
  await form.getByRole("button", { name: "Create Product" }).click();

  await expect(page.getByText(/committed, but refresh failed/i)).toBeVisible();
  await expect(form.getByPlaceholder("product-id")).toHaveValue("");
  await expect(form.getByPlaceholder("English name")).toHaveValue("");
  expect(productCreates).toBe(1);
  expect(catalogReads).toBe(3);
  expect(unexpected).toEqual([]);
});

test("catalog.manage alone loads and commits an exact-version Provider automation policy without loading the Catalog list", async ({ page }) => {
  const productId = "review-provider-policy";
  let policyReads = 0;
  let policyWrites = 0;
  let catalogReads = 0;
  let savedPayload: Record<string, unknown> | null = null;
  const unexpected: string[] = [];

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/api/v1/catalog") {
      await fulfillJson(route, { locale: "en", currency: "USD", products: [] });
      return;
    }
    if (path === "/api/v1/legal/current") {
      await fulfillJson(route, legal);
      return;
    }
    if (path === "/api/v1/content") {
      await fulfillJson(route, { items: [] });
      return;
    }
    if (path === "/api/v1/auth/me") {
      await fulfillJson(route, staffViewer("catalog.manage"), { session: true });
      return;
    }
    if (path === "/api/v1/admin/catalog" && method === "GET") {
      catalogReads += 1;
      await fulfillJson(route, { error: "catalog.manage must not imply catalog.read" }, { status: 403, session: true });
      return;
    }
    if (
      path === `/api/v1/admin/catalog/products/${productId}/automation-policy` &&
      method === "GET"
    ) {
      policyReads += 1;
      if (policyReads === 1) {
        await fulfillJson(route, {
          warning: "MOCK ONLY",
          productId,
          fulfillmentMode: "review",
          productActive: true,
          productHidden: false,
          configured: true,
          automationMode: "provider",
          providerInstallationId: "mock-provisioning-v1",
          policyVersion: 3,
          overdueAction: "manual",
          updatedAt: "2026-08-20T01:00:00.000Z",
          capabilitySnapshot: ["resource_create"],
          requiredCapabilities: ["resource_create", "resource_reconcile"],
          missingCapabilities: ["resource_reconcile"],
          providerVersion: 7,
          providerEnabled: true,
          providerReady: false,
        }, { session: true });
      } else {
        await fulfillJson(
          route,
          { error: "Policy refresh temporarily unavailable" },
          { status: 503, session: true },
        );
      }
      return;
    }
    if (
      path === `/api/v1/admin/catalog/products/${productId}/automation-policy` &&
      method === "PUT"
    ) {
      policyWrites += 1;
      savedPayload = request.postDataJSON() as Record<string, unknown>;
      await fulfillJson(route, {
        warning: "MOCK ONLY",
        productId,
        fulfillmentMode: "review",
        productActive: true,
        productHidden: false,
        configured: true,
        automationMode: "manual",
        providerInstallationId: null,
        policyVersion: 4,
        overdueAction: "manual",
        updatedAt: "2026-08-20T02:00:00.000Z",
        capabilitySnapshot: [],
        requiredCapabilities: ["resource_create", "resource_reconcile"],
        missingCapabilities: ["resource_create", "resource_reconcile"],
        providerVersion: null,
        providerEnabled: null,
        providerReady: false,
        changed: true,
      }, { session: true });
      return;
    }
    unexpected.push(`${method} ${path}`);
    await fulfillJson(
      route,
      { error: `Unexpected request: ${method} ${path}` },
      { status: 500, session: true },
    );
  });

  await page.goto("/admin");
  const section = page.getByTestId("admin-automation-policy-section");
  await expect(section).toBeVisible();
  expect(catalogReads).toBe(0);
  const lookup = page.getByTestId("automation-policy-lookup-form");
  await lookup.getByPlaceholder("product-id").fill(productId);
  await lookup.getByRole("button", { name: "Load policy" }).click();

  const detail = page.getByTestId("automation-policy-detail");
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId("automation-policy-version")).toContainText("Policy version: v3");
  await expect(detail.getByTestId("automation-provider-readiness")).toHaveText("Provider Not Ready");
  await expect(detail.getByTestId("automation-missing-capabilities")).toContainText("resource_reconcile");
  await expect(detail.getByTestId("automation-capability-snapshot")).toContainText("resource_create");

  const form = page.getByTestId("automation-policy-form");
  await form.getByLabel("Automation mode").selectOption("manual");
  await form.getByRole("button", { name: "Save automation policy" }).click();

  await expect(detail.getByTestId("automation-policy-version")).toContainText("Policy version: v4");
  await expect(detail.getByTestId("automation-provider-readiness")).toHaveText(
    "Manual binding / Staff completion / no Provider operation or job",
  );
  await expect(page.getByText(/follow-up refresh failed.*committed v4 remains shown/i)).toBeVisible();
  expect(savedPayload).toEqual({
    automationMode: "manual",
    providerInstallationId: null,
    expectedVersion: 3,
  });
  expect(policyReads).toBe(2);
  expect(policyWrites).toBe(1);
  expect(catalogReads).toBe(0);
  expect(unexpected).toEqual([]);
});

test("Catalog readers see Provider automation controls only on Automatic and Review products", async ({ page }) => {
  const unexpected: string[] = [];
  const product = (id: string, fulfillmentMode: "automatic" | "review" | "manual" | "quote") => ({
    id,
    groupId: "automation-lab",
    names: { en: id },
    descriptions: { en: `${id} synthetic description` },
    fulfillmentMode,
    active: true,
    hidden: false,
    repeatable: false,
    optionSchema: [],
    currentRevisionId: productRevisionId,
    currentRevision: 1,
    updatedAt: "2026-08-20T00:00:00.000Z",
  });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/api/v1/catalog") {
      await fulfillJson(route, { locale: "en", currency: "USD", products: [] });
      return;
    }
    if (path === "/api/v1/legal/current") {
      await fulfillJson(route, legal);
      return;
    }
    if (path === "/api/v1/content") {
      await fulfillJson(route, { items: [] });
      return;
    }
    if (path === "/api/v1/auth/me") {
      const viewer = staffViewer("catalog.read");
      await fulfillJson(route, {
        ...viewer,
        staff: { roles: ["operations"], permissions: ["catalog.read", "catalog.manage"] },
      }, { session: true });
      return;
    }
    if (path === "/api/v1/admin/catalog" && method === "GET") {
      await fulfillJson(route, {
        warning: "MOCK ONLY",
        groups: [],
        products: [
          product("automatic-policy-product", "automatic"),
          product("review-policy-product", "review"),
          product("manual-policy-product", "manual"),
          product("quote-policy-product", "quote"),
        ],
        revisions: [],
        prices: [],
        supply: [],
      }, { session: true });
      return;
    }
    unexpected.push(`${method} ${path}`);
    await fulfillJson(
      route,
      { error: `Unexpected request: ${method} ${path}` },
      { status: 500, session: true },
    );
  });

  await page.goto("/admin");
  const products = page.getByTestId("admin-catalog-product");
  await expect(products).toHaveCount(4);
  await expect(
    products.filter({ hasText: "automatic-policy-product" }).getByRole("button", {
      name: "Manage Provider automation",
    }),
  ).toBeVisible();
  await expect(
    products.filter({ hasText: "review-policy-product" }).getByRole("button", {
      name: "Manage Provider automation",
    }),
  ).toBeVisible();
  await expect(
    products.filter({ hasText: "manual-policy-product" }).getByRole("button", {
      name: "Manage Provider automation",
    }),
  ).toHaveCount(0);
  await expect(
    products.filter({ hasText: "quote-policy-product" }).getByRole("button", {
      name: "Manage Provider automation",
    }),
  ).toHaveCount(0);
  expect(unexpected).toEqual([]);
});
