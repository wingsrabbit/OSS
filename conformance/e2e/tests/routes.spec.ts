// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Page, type Route } from "@playwright/test";

type MockViewer = {
  id: string;
  email: string;
  locale: "en" | "zh-CN";
  clientAccountId: string;
  membershipRole: string;
  accountContextVersion: string;
  authorizationEpoch: string;
  context: {
    clientAccountId: string;
    name: string;
    role: "owner";
    permissions: string[];
    capabilities: string[];
    version: string;
  };
  verification: { email: "passed" | "pending" };
  restrictions: { user: boolean; clientAccount: boolean };
  eligible: boolean;
  staff: { roles: string[]; permissions: unknown } | null;
};

const ownerCapabilities = [
  "account.contacts.manage",
  "account.contacts.read",
  "account.members.manage",
  "account.members.read",
  "billing.read",
  "billing.write",
  "orders.create",
  "services.manage",
  "support.tickets.write",
];

function mockViewer({
  email,
  eligible = true,
  permissions = null,
  restrictions = { user: false, clientAccount: false },
}: {
  email: string;
  eligible?: boolean;
  permissions?: unknown;
  restrictions?: { user: boolean; clientAccount: boolean };
}): MockViewer {
  const clientAccountId = "00000000-0000-4000-8000-000000000002";
  return {
    id: "00000000-0000-4000-8000-000000000001",
    email,
    locale: "en",
    clientAccountId,
    membershipRole: "owner",
    accountContextVersion: "1",
    authorizationEpoch: "1",
    context: {
      clientAccountId,
      name: "Synthetic route account",
      role: "owner",
      permissions: ["*"],
      capabilities: ownerCapabilities,
      version: "1",
    },
    verification: { email: "passed" },
    restrictions,
    eligible,
    staff: permissions === null ? null : { roles: ["support"], permissions },
  };
}

function withViewerSessionContext(route: Route, viewer: MockViewer | null): Route {
  if (!viewer) return route;
  return new Proxy(route, {
    get(target, property, receiver) {
      if (property === "fulfill") {
        return (options: Parameters<Route["fulfill"]>[0]) => {
          const response = options ?? {};
          return target.fulfill({
            ...response,
            headers: {
              "X-OSS-Account-Context-Version": viewer.accountContextVersion,
              "X-OSS-Client-Account-Id": viewer.clientAccountId,
              "X-OSS-Authorization-Epoch": viewer.authorizationEpoch,
              ...(response.headers ?? {}),
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

type MockViewerSource = MockViewer | null | (() => MockViewer | null);

function currentMockViewer(source: MockViewerSource): MockViewer | null {
  return typeof source === "function" ? source() : source;
}

async function installMockApi(
  page: Page,
  viewerSource: MockViewerSource,
  options: {
    unauthorizedPath?: string;
    unauthorizedError?: string;
    intercept?: (path: string, route: Route) => Promise<boolean>;
  } = {},
): Promise<string[]> {
  const requests: string[] = [];
  await page.route("**/api/v1/**", async (rawRoute) => {
    const viewer = currentMockViewer(viewerSource);
    const route = withViewerSessionContext(rawRoute, viewer);
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push(path);

    if (options.intercept && await options.intercept(path, route)) return;

    if (path === "/api/v1/auth/me") {
      if (viewer) {
        await route.fulfill({
          headers: {
            "X-OSS-Account-Context-Version": viewer.accountContextVersion,
            "X-OSS-Client-Account-Id": viewer.clientAccountId,
            "X-OSS-Authorization-Epoch": viewer.authorizationEpoch,
          },
          json: viewer,
        });
      } else {
        await route.fulfill({ status: 401, json: { error: "Authentication required" } });
      }
      return;
    }
    if (path === "/api/v1/auth/account-contexts" && viewer) {
      await route.fulfill({
        headers: {
          "X-OSS-Account-Context-Version": viewer.accountContextVersion,
          "X-OSS-Client-Account-Id": viewer.clientAccountId,
          "X-OSS-Authorization-Epoch": viewer.authorizationEpoch,
        },
        json: {
          activeClientAccountId: viewer.clientAccountId,
          accountContextVersion: viewer.accountContextVersion,
          items: [{
            clientAccountId: viewer.clientAccountId,
            name: viewer.context.name,
            role: viewer.context.role,
            permissions: viewer.context.permissions,
            capabilities: viewer.context.capabilities,
            restrictions: {
              membership: false,
              clientAccount: viewer.restrictions.clientAccount,
            },
          }],
          limit: 25,
          hasMore: false,
          nextCursor: null,
        },
      });
      return;
    }
    if (path === options.unauthorizedPath) {
      await route.fulfill({
        status: 401,
        json: { error: options.unauthorizedError ?? "Session is invalid or expired" },
      });
      return;
    }
    if (path === "/api/v1/auth/logout") {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (path === "/api/v1/auth/reauth") {
      await route.fulfill({
        json: { expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), fixedWindowMinutes: 15 },
      });
      return;
    }
    if (path === "/api/v1/catalog") {
      await route.fulfill({
        json: {
          products: [
            {
              id: "mock-product",
              groupId: "mock-group",
              groupName: "Mock plans",
              name: "Mock route plan",
              description: "Synthetic route-boundary product.",
              fulfillmentMode: "automatic",
              optionSchema: [],
              purchasable: true,
              prices: [
                {
                  id: "mock-price",
                  currency: "USD",
                  billingCycle: "monthly",
                  oneTimeMinor: "0",
                  setupMinor: "0",
                  recurringMinor: "100",
                },
              ],
            },
          ],
        },
      });
      return;
    }
    if (path === "/api/v1/legal/current") {
      const document = { version: "mock-v1", title: "Mock terms", body: "Synthetic only." };
      await route.fulfill({ json: { documents: { terms: document, aup: document, privacy: document } } });
      return;
    }
    if (path === "/api/v1/content" || path === "/api/v1/customer/content") {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (path === "/api/v1/support/departments") {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (request.method() === "GET" && path === "/api/v1/admin/service-operations") {
      await route.fulfill({
        json: {
          warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
          items: [],
        },
      });
      return;
    }
    if (request.method() === "GET" && path === "/api/v1/admin/content") {
      await route.fulfill({
        json: {
          entries: [],
          revisions: [],
          legalDocuments: [],
        },
      });
      return;
    }
    if (request.method() === "GET" && path === "/api/v1/admin/catalog") {
      await route.fulfill({
        json: {
          warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
          groups: [],
          products: [],
          revisions: [],
          prices: [],
          supply: [],
        },
      });
      return;
    }
    if (
      request.method() === "GET" &&
      (path === "/api/v1/admin/promotions" || path === "/api/v1/admin/quotes")
    ) {
      await route.fulfill({
        json: { warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY", items: [] },
      });
      return;
    }
    if (
      request.method() === "GET" &&
      (
        /^\/api\/v1\/services\/[0-9a-f-]+\/operations$/u.test(path) ||
        /^\/api\/v1\/admin\/client-accounts\/[0-9a-f-]+\/services\/[0-9a-f-]+\/operations$/u.test(path)
      )
    ) {
      const serviceId = path.split("/").at(-2) ?? "";
      await route.fulfill({
        json: {
          warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
          service: {
            id: serviceId,
            productName: "Synthetic route service",
            status: "active",
            version: 1,
            resourceState: null,
            resourceRevision: 0,
            availableActions: [],
          },
          items: [],
        },
      });
      return;
    }
    if (path === "/api/v1/orders") {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (path === "/api/v1/customer/business-history") {
      await route.fulfill({
        json: {
          warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
          account: {
            id: viewer?.clientAccountId ?? "",
            name: "Synthetic route account",
          },
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
      return;
    }
    if (path === "/api/v1/billing/summary") {
      await route.fulfill({
        json: {
          currency: "USD",
          creditBalanceMinor: "0",
          paymentMethods: [
            {
              code: "card",
              name: "Mock card",
              feeBasisPoints: 0,
              addFundsEnabled: false,
              savedMethodEnabled: true,
              automaticRenewalEnabled: true,
            },
          ],
          addFunds: {
            enabled: false,
            allowed: false,
            minimumMinor: "100",
            maximumMinor: "10000",
            balanceCapMinor: "10000",
          },
        },
      });
      return;
    }
    if (path === "/api/v1/billing/payment-settings") {
      await route.fulfill({
        json: {
          defaults: { savePaymentMethod: false, automaticRenewal: false },
          consentVersions: { savePaymentMethod: "mock-v1", automaticRenewal: "mock-v1" },
          methods: [
            {
              id: "00000000-0000-4000-8000-000000000003",
              paymentMethod: "card",
              instrumentType: "card",
              brand: "Mock Card",
              lastFour: "4242",
              expiryMonth: 12,
              expiryYear: 2030,
              status: "active",
              default: false,
              consentVersion: "mock-v1",
              savedAt: "2026-01-01T00:00:00.000Z",
              version: 1,
            },
          ],
          automaticRenewals: [],
          pendingAutomaticRenewals: [],
          serviceDecisions: [],
        },
      });
      return;
    }
    if (path === "/api/v1/billing/renewals") {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (path === "/api/v1/billing/chargeback-status") {
      await route.fulfill({
        json: {
          clientAccountId: viewer?.clientAccountId ?? "",
          restricted: false,
          creditBalanceMinor: "0",
          debtBalanceMinor: "0",
          chargebacks: [],
          unclaimedChargebacks: [],
          manualHolds: [],
        },
      });
      return;
    }
    if (path === "/api/v1/tickets" || path === "/api/v1/tickets/service-options") {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (
      path === "/api/v1/account/members" ||
      path === "/api/v1/account/membership-invitations" ||
      path === "/api/v1/account/contacts"
    ) {
      await route.fulfill({ json: { items: [], limit: 25, hasMore: false, nextCursor: null } });
      return;
    }
    if (
      path.startsWith("/api/v1/billing/payment-methods/") &&
      path.endsWith("/default")
    ) {
      await route.fulfill({ json: {} });
      return;
    }
    if (path === "/api/v1/admin/add-funds-chargebacks") {
      await route.fulfill({ json: { items: [], unclaimedChargebacks: [], manualHolds: [] } });
      return;
    }
    if (
      [
        "/api/v1/admin/tickets",
        "/api/v1/admin/tickets/staff-options",
        "/api/v1/admin/support/departments",
        "/api/v1/admin/presales/inquiries",
        "/api/v1/admin/billing/renewals",
        "/api/v1/admin/manual-fulfillment",
        "/api/v1/admin/services/cancellations",
        "/api/v1/admin/funds/unclaimed",
        "/api/v1/admin/refund-candidates",
        "/api/v1/admin/refunds",
        "/api/v1/admin/refund-security-holds",
        "/api/v1/admin/refund-dismissal-corrections",
        "/api/v1/admin/refund-receipt-capacity-incidents",
      ].includes(path)
    ) {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    await route.fulfill({
      status: 501,
      json: { error: `Unexpected mock API request: ${request.method()} ${path}` },
    });
    throw new Error(`Unexpected mock API request: ${request.method()} ${path}`);
  });
  return requests;
}

test("public, customer, and admin routes mount only their intended workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", {
    name: "Customer, billing and service operations — without vendor lock-in.",
  })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "TermRat synthetic acceptance configuration" })).toBeVisible();
  await expect(page.locator('section[aria-label="Customer support tickets"]')).toHaveCount(0);
  await expect(page.locator('section[aria-label="Staff support tickets"]')).toHaveCount(0);
  await expect(page.locator("section.admin-panel")).toHaveCount(0);

  await page.getByRole("link", { name: "Customer", exact: true }).click();
  await expect(page).toHaveURL(/\/customer$/);
  await expect(page.getByRole("heading", {
    name: "Orders, billing, services and support in one customer workspace.",
  })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in to open the customer workspace" })).toBeVisible();
  await expect(page.locator('section[aria-label="Staff support tickets"]')).toHaveCount(0);
  await expect(page.locator("section.admin-panel")).toHaveCount(0);

  await page.getByRole("link", { name: "Admin", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByTestId("admin-access-restricted")).toContainText("Sign in required");
  await expect(page.getByRole("button", { name: "Sign in to Staff workspace" })).toBeVisible();
  await expect(page.locator('section[aria-label="Customer support tickets"]')).toHaveCount(0);
  await expect(page.locator('section[aria-label="Staff support tickets"]')).toHaveCount(0);
  await expect(page.locator("section.admin-panel")).toHaveCount(0);
  await expect(page.locator("section.catalog")).toHaveCount(0);

  await page.goto("/not-a-workspace");
  await expect(page.getByRole("link", { name: "Home", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator("section.admin-panel")).toHaveCount(0);
});

test("real App visitor Presales entry clears its unsent draft after leaving Home", async ({ page }) => {
  const requests = await installMockApi(page, null);
  await page.goto("/");
  const presales = page.locator('section[aria-label="Visitor Presales"]');
  await expect(presales).toBeVisible();
  await presales.getByLabel("Name").fill("Draft Visitor");
  await presales.getByLabel("Subject").fill("Draft product question");
  await presales.getByLabel("Message").fill("This ordinary question has not been submitted.");

  await page.getByRole("link", { name: "Customer", exact: true }).click();
  await expect(presales).toHaveCount(0);
  await page.getByRole("link", { name: "Home", exact: true }).click();
  const returning = page.locator('section[aria-label="Visitor Presales"]');
  await expect(returning.getByLabel("Name")).toHaveValue("");
  await expect(returning.getByLabel("Subject")).toHaveValue("");
  await expect(returning.getByLabel("Message")).toHaveValue("");
  expect(requests.filter((path) => path === "/api/v1/support/departments").length).toBeGreaterThanOrEqual(2);
});

test("real App customer Support read and write stay account-scoped and clear drafts on navigation", async ({ page }) => {
  const requests = await installMockApi(
    page,
    mockViewer({ email: "customer-support-entry@example.invalid" }),
  );
  await page.goto("/customer");
  const support = page.locator('section[aria-label="Customer support tickets"]');
  await expect(support).toBeVisible();
  await expect(support.getByRole("button", { name: "Create ticket" })).toBeVisible();
  await support.getByLabel("Ticket subject").fill("Unsent account-scoped draft");
  await support.getByLabel("Opening message").fill("This ordinary draft must not cross routes.");
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: "Customer", exact: true }).click();
  const returning = page.locator('section[aria-label="Customer support tickets"]');
  await expect(returning.getByLabel("Ticket subject")).toHaveValue("");
  await expect(returning.getByLabel("Opening message")).toHaveValue("");
  expect(requests).toContain("/api/v1/tickets");
  expect(requests).toContain("/api/v1/tickets/service-options");
  expect(requests).toContain("/api/v1/support/departments");
  expect(requests.filter((path) => path.startsWith("/api/v1/admin/"))).toEqual([]);
});

test("customer and Staff sessions stay separated and can switch accounts through sign out", async ({
  page,
}) => {
  const unique = crypto.randomUUID();
  const customerEmail = `route-customer-${unique}@example.invalid`;
  const customerPassword = `Synthetic-${unique}-Route!`;
  const staffEmail =
    process.env.OSS_E2E_STAFF_EMAIL ?? "stage-a-browser-admin@example.invalid";
  const staffPassword =
    process.env.OSS_E2E_STAFF_PASSWORD ?? "Synthetic-Stage-A-Browser-Admin-Only!";

  const customer = {
    ...mockViewer({ email: customerEmail }),
    verification: { email: "pending" as const },
    eligible: false,
  };
  const staff = mockViewer({ email: staffEmail, permissions: ["*"] });
  let activeViewer: MockViewer | null = null;
  await installMockApi(page, () => activeViewer, {
    intercept: async (path, route) => {
      if (path === "/api/v1/auth/register") {
        await route.fulfill({ status: 201, json: { registered: true } });
        return true;
      }
      if (path === "/api/v1/auth/login") {
        const body = route.request().postDataJSON() as { email?: unknown; password?: unknown };
        const nextViewer = body.email === customerEmail && body.password === customerPassword
          ? customer
          : body.email === staffEmail && body.password === staffPassword
            ? staff
            : null;
        if (!nextViewer) {
          await route.fulfill({ status: 401, json: { error: "Invalid email or password" } });
          return true;
        }
        activeViewer = nextViewer;
        await route.fulfill({
          headers: {
            "X-OSS-Account-Context-Version": nextViewer.accountContextVersion,
            "X-OSS-Client-Account-Id": nextViewer.clientAccountId,
            "X-OSS-Authorization-Epoch": nextViewer.authorizationEpoch,
          },
          json: { requiresAccountContext: false },
        });
        return true;
      }
      if (path === "/api/v1/auth/logout") {
        activeViewer = null;
        await route.fulfill({ status: 204, body: "" });
        return true;
      }
      return false;
    },
  });

  await page.goto("/");
  await page.getByPlaceholder("Client account name").fill(`Route Customer ${unique.slice(0, 8)}`);
  await page.getByPlaceholder("Email").first().fill(customerEmail);
  await page.getByPlaceholder("Password (12+ characters)").fill(customerPassword);
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByText(/Account created\. The verification message/)).toBeVisible();
  await page.getByPlaceholder("Email").last().fill(customerEmail);
  await page.getByPlaceholder("Password", { exact: true }).fill(customerPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page).toHaveURL(/\/customer$/);
  await expect(page.getByRole("heading", { name: "Verify your email to continue" })).toBeVisible();
  await expect(page.locator('section[aria-label="Staff support tickets"]')).toHaveCount(0);
  await expect(page.locator("section.admin-panel")).toHaveCount(0);

  await page.getByRole("link", { name: "Admin", exact: true }).click();
  await expect(page.getByTestId("admin-access-restricted")).toContainText(
    "Access denied — verified, unrestricted Staff User required",
  );
  await expect(page.locator("section.admin-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText(customerEmail)).toHaveCount(0);

  await page.goto("/admin");
  await page.getByPlaceholder("Staff email").fill(staffEmail);
  await page.getByPlaceholder("Staff password").fill(staffPassword);
  await page.getByRole("button", { name: "Sign in to Staff workspace" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.locator('section[aria-label="Staff support tickets"]')).toBeVisible();
  await expect(page.getByTestId("full-admin-workspace")).toBeVisible();
  await expect(page.locator('section[aria-label="Customer support tickets"]')).toHaveCount(0);
  await expect(page.locator("section.catalog")).toHaveCount(0);

  await page.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText(staffEmail)).toHaveCount(0);
  await expect(page.locator('section[aria-label="Staff support tickets"]')).toHaveCount(0);
  await expect(page.getByTestId("full-admin-workspace")).toHaveCount(0);
  await page.getByRole("link", { name: "Admin", exact: true }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("Public access", { exact: true })).toBeVisible();
});

test("public Home stays session-neutral for a signed-in wildcard Staff account", async ({ page }) => {
  const staffEmail = "neutral-home-staff@example.invalid";
  const requests = await installMockApi(
    page,
    mockViewer({ email: staffEmail, permissions: ["*"] }),
  );

  await page.goto("/");
  await expect(page.getByTestId("public-access")).toBeVisible();
  await expect(page.getByText("Public access", { exact: true })).toBeVisible();
  await expect(page.getByText(staffEmail)).toHaveCount(0);
  await expect(page.getByText("Signed in", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open customer workspace" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Admin workspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Register", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  expect(new Set(requests)).toEqual(
    new Set(["/api/v1/catalog", "/api/v1/legal/current", "/api/v1/content", "/api/v1/support/departments"]),
  );
  const requestCountBeforeLocaleChange = requests.length;
  await page.getByRole("button", { name: "简体中文" }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(requestCountBeforeLocaleChange);
  expect(new Set(requests)).toEqual(
    new Set(["/api/v1/catalog", "/api/v1/legal/current", "/api/v1/content", "/api/v1/support/departments"]),
  );
});

test("reopening the current customer route keeps the resolved session", async ({ page }) => {
  const email = "same-route-customer@example.invalid";
  await installMockApi(page, mockViewer({ email }));

  await page.goto("/customer");
  await expect(page.getByRole("heading", { name: email, exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Customer", exact: true }).click();
  await expect(page.getByRole("heading", { name: email, exact: true })).toBeVisible();
  await expect(page.getByText("Checking session", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Checking the current session…", { exact: true })).toHaveCount(0);
});

test("reopening the current Admin route keeps the resolved Staff session", async ({ page }) => {
  const email = "same-route-staff@example.invalid";
  await installMockApi(
    page,
    mockViewer({ email, permissions: ["support.tickets.manage"] }),
  );

  await page.goto("/admin");
  await expect(page.locator('section[aria-label="Staff support tickets"]')).toBeVisible();
  await page.getByRole("link", { name: "Admin", exact: true }).click();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await expect(page.getByText("Checking session", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Checking Staff access…" })).toHaveCount(0);
  await expect(page.locator('section[aria-label="Staff support tickets"]')).toBeVisible();
});

test("same-route query popstate keeps the resolved workspace session", async ({ page }) => {
  const email = "query-history-customer@example.invalid";
  await installMockApi(page, mockViewer({ email }));

  await page.goto("/customer");
  await expect(page.getByRole("heading", { name: email, exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.history.pushState({}, "", "/customer?view=first");
    window.history.pushState({}, "", "/customer?view=second");
  });
  await page.goBack();
  await expect(page).toHaveURL(/\/customer\?view=first$/);
  await expect(page.getByRole("heading", { name: email, exact: true })).toBeVisible();
  await expect(page.getByText("Checking session", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Checking the current session…", { exact: true })).toHaveCount(0);
});

test("catalog query 401 stays on public Home without a hard-reload loop", async ({ page }) => {
  await installMockApi(page, null, {
    unauthorizedPath: "/api/v1/catalog",
    unauthorizedError: "Synthetic catalog unavailable",
  });
  const documents: string[] = [];
  const catalogRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.resourceType() === "document") documents.push(url.pathname);
    if (url.pathname === "/api/v1/catalog") catalogRequests.push(url.toString());
  });

  await page.goto("/");
  await expect(page.locator(".notice.error")).toContainText("Synthetic catalog unavailable");
  await page.waitForTimeout(250);
  expect(documents).toEqual(["/"]);
  expect(catalogRequests.length).toBeGreaterThan(0);
  expect(
    catalogRequests.every((url) => new URL(url).searchParams.get("locale") === "en"),
  ).toBe(true);
  await expect(page).toHaveURL(/\/$/);
});

test("public Content query 401 stays on Home without a hard reload", async ({ page }) => {
  await installMockApi(page, null, {
    unauthorizedPath: "/api/v1/content",
    unauthorizedError: "Synthetic Content unavailable",
  });
  const documents: string[] = [];
  const contentRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.resourceType() === "document") documents.push(url.pathname);
    if (url.pathname === "/api/v1/content") contentRequests.push(url.toString());
  });

  await page.goto("/");
  await expect(page.locator(".notice.error")).toContainText("Synthetic Content unavailable");
  await page.waitForTimeout(250);
  expect(documents).toEqual(["/"]);
  expect(contentRequests.length).toBeGreaterThan(0);
  expect(
    contentRequests.every((url) => new URL(url).searchParams.get("locale") === "en"),
  ).toBe(true);
  await expect(page).toHaveURL(/\/$/);
});

test("an expired locale mutation hard-resets the authenticated workspace", async ({ page }) => {
  const activeViewer = mockViewer({ email: "expired-locale-session@example.invalid" });
  await installMockApi(page, activeViewer, {
    intercept: async (path, route) => {
      if (path !== "/api/v1/auth/locale" || route.request().method() !== "PUT") return false;
      await route.fulfill({
        status: 401,
        json: { error: "Session is invalid or expired" },
      });
      return true;
    },
  });

  await page.goto("/customer");
  await expect(page.getByRole("banner").getByText(activeViewer.email, { exact: true })).toBeVisible();
  const rootDocument = page.waitForRequest(
    (request) => request.resourceType() === "document" && new URL(request.url()).pathname === "/",
  );
  await page.getByRole("button", { name: "简体中文" }).click();
  await rootDocument;

  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByText(activeViewer.email)).toHaveCount(0);
  await expect(page.getByTestId("customer-business-history")).toHaveCount(0);
});

test("restricted wildcard Staff mounts no Admin capability or Admin fetch", async ({ page }) => {
  const requests = await installMockApi(
    page,
    mockViewer({
      email: "restricted-wildcard@example.invalid",
      eligible: false,
      permissions: ["*"],
      restrictions: { user: true, clientAccount: false },
    }),
  );

  await page.goto("/admin");
  await expect(page.getByTestId("admin-access-restricted")).toContainText(
    "Access denied — verified, unrestricted Staff User required",
  );
  await expect(page.locator('section[aria-label="Staff support tickets"]')).toHaveCount(0);
  await expect(page.locator("section.admin-panel")).toHaveCount(0);
  expect(requests.filter((path) => path.startsWith("/api/v1/admin/"))).toEqual([]);
});

test("malformed Staff permissions fail closed without Admin fetches", async ({ page }) => {
  const requests = await installMockApi(
    page,
    mockViewer({
      email: "malformed-permissions@example.invalid",
      permissions: { wildcard: "*", tickets: true },
    }),
  );

  await page.goto("/admin");
  await expect(page.getByTestId("admin-access-restricted")).toContainText(
    "Access denied — Staff permission required",
  );
  await expect(page.locator('section[aria-label="Staff support tickets"]')).toHaveCount(0);
  await expect(page.getByTestId("full-admin-workspace")).toHaveCount(0);
  expect(requests.filter((path) => path.startsWith("/api/v1/admin/"))).toEqual([]);
});

test("limited ticket Staff mounts only its permitted panel and fetch", async ({ page }) => {
  const requests = await installMockApi(
    page,
    mockViewer({
      email: "ticket-only-staff@example.invalid",
      permissions: ["support.tickets.manage"],
    }),
  );

  await page.goto("/admin");
  await expect(page.locator('section[aria-label="Staff support tickets"]')).toBeVisible();
  await expect(page.getByTestId("limited-admin-scope")).toContainText("Permission-scoped operations");
  await expect(page.getByTestId("full-admin-workspace")).toHaveCount(0);
  await expect(page.getByTestId("admin-access-restricted")).toHaveCount(0);
  const adminPaths = [...new Set(requests.filter((path) => path.startsWith("/api/v1/admin/")))];
  expect(adminPaths).toEqual([
    "/api/v1/admin/tickets",
    "/api/v1/admin/tickets/staff-options",
    "/api/v1/admin/support/departments",
    "/api/v1/admin/presales/inquiries",
  ]);
});

test("Staff without support.tickets.manage mounts no Support panel and sends zero Support GET", async ({ page }) => {
  const requests = await installMockApi(
    page,
    mockViewer({
      email: "content-only-staff@example.invalid",
      permissions: ["content.read"],
    }),
  );
  await page.goto("/admin");
  await expect(page.locator('section[aria-label="Staff support tickets"]')).toHaveCount(0);
  const supportPaths = requests.filter((path) =>
    path === "/api/v1/admin/tickets" ||
    path === "/api/v1/admin/tickets/staff-options" ||
    path === "/api/v1/admin/support/departments" ||
    path === "/api/v1/admin/presales/inquiries",
  );
  expect(supportPaths).toEqual([]);
});

test("Account 360 ticket action replaces the global Staff queue with an exact Client Account filter", async ({ page }) => {
  const accountId = "00000000-0000-4000-8000-000000000711";
  const occurredAt = "2026-08-20T00:00:00.000Z";
  const queueUrls: URL[] = [];
  await installMockApi(
    page,
    mockViewer({
      email: "account-scoped-support@example.invalid",
      permissions: ["accounts.view", "support.tickets.manage"],
    }),
    {
      intercept: async (path, route) => {
        if (path === "/api/v1/admin/tickets" && route.request().method() === "GET") {
          queueUrls.push(new URL(route.request().url()));
          await route.fulfill({ json: { items: [] } });
          return true;
        }
        if (path === "/api/v1/admin/client-accounts") {
          await route.fulfill({ json: {
            warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
            items: [{
              id: accountId,
              name: "Scoped Support Account",
              owner: { userId: accountId, email: "scoped@example.invalid", emailVerifiedAt: occurredAt },
              restrictedAt: null,
              activeMemberCount: 1,
              createdAt: occurredAt,
            }],
            hasMore: false,
            nextCursor: null,
          } });
          return true;
        }
        if (path === `/api/v1/admin/client-accounts/${accountId}/summary`) {
          await route.fulfill({ json: {
            warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
            account: { id: accountId, name: "Scoped Support Account", createdAt: occurredAt, restrictedAt: null },
            owner: { userId: accountId, email: "scoped@example.invalid", emailVerifiedAt: occurredAt, restrictedAt: null },
            memberships: [],
            restrictions: [],
          } });
          return true;
        }
        if (path === `/api/v1/admin/client-accounts/${accountId}/tickets`) {
          await route.fulfill({ json: {
            warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
            account: { id: accountId, name: "Scoped Support Account" },
            items: [],
            limit: 25,
            hasMore: false,
            nextCursor: null,
          } });
          return true;
        }
        return false;
      },
    },
  );

  await page.goto("/admin");
  await expect.poll(() => queueUrls.some((url) => !url.searchParams.has("clientAccountId"))).toBe(true);
  const account360 = page.getByTestId("client-account-360");
  await account360.getByLabel("Search Client Accounts").fill("Scoped Support Account");
  await account360.getByRole("button", { name: "Search accounts" }).click();
  await account360.getByRole("button", { name: /Scoped Support Account/ }).click();
  await account360.getByRole("button", { name: "Open ticket operations" }).click();
  await expect(page.getByTestId("staff-support-account-context")).toContainText(accountId);
  await expect.poll(() => queueUrls.some((url) => url.searchParams.get("clientAccountId") === accountId)).toBe(true);
});

test("Client Account restriction keeps verified customer history readable while writes stay unavailable", async ({ page }) => {
  const requests = await installMockApi(
    page,
    mockViewer({
      email: "account-restricted-history@example.invalid",
      eligible: false,
      restrictions: { user: false, clientAccount: true },
    }),
  );

  await page.goto("/customer");
  await expect(page.getByTestId("customer-business-history")).toBeVisible();
  await expect(page.getByTestId("history-account")).toContainText("Synthetic route account");
  await expect(page.getByRole("heading", { name: "Purchases and account changes are unavailable" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open my Mock Provider mailbox" })).toHaveCount(0);
  expect(requests).toContain("/api/v1/customer/business-history");
  expect(requests).toContain("/api/v1/orders");
});

test("user restriction unmounts customer history without issuing its request", async ({ page }) => {
  const requests = await installMockApi(
    page,
    mockViewer({
      email: "user-restricted-history@example.invalid",
      eligible: false,
      restrictions: { user: true, clientAccount: false },
    }),
  );

  await page.goto("/customer");
  await expect(page.getByRole("heading", { name: "This user is restricted" })).toBeVisible();
  await expect(page.getByTestId("customer-business-history")).toHaveCount(0);
  expect(requests.filter((path) => path === "/api/v1/customer/business-history")).toEqual([]);
});

test("changing Client Account clears old history before the new request and ignores the late old response", async ({ page }) => {
  const accountAId = "00000000-0000-4000-8000-0000000000a1";
  const accountBId = "00000000-0000-4000-8000-0000000000b2";
  const invoiceAId = "00000000-0000-4000-8000-0000000000a3";
  const occurredAt = "2026-08-10T00:00:00.000Z";
  const invoiceA = {
    id: invoiceAId,
    orderId: null,
    currency: "USD",
    totalMinor: "500",
    allocatedMinor: "500",
    paymentAllocatedMinor: "500",
    creditAppliedMinor: "0",
    dueMinor: "0",
    status: "paid",
    dueAt: occurredAt,
    createdAt: occurredAt,
  };
  const viewerA = {
    ...mockViewer({ email: "account-a@example.invalid" }),
    clientAccountId: accountAId,
    accountContextVersion: "1",
    context: {
      clientAccountId: accountAId,
      name: "Account A saved facts",
      role: "owner" as const,
      permissions: ["*"],
      capabilities: ownerCapabilities,
      version: "1",
    },
  };
  const viewerB = {
    ...mockViewer({ email: "account-b@example.invalid" }),
    clientAccountId: accountBId,
    accountContextVersion: "2",
    context: {
      clientAccountId: accountBId,
      name: "Account B saved facts",
      role: "owner" as const,
      permissions: ["*"],
      capabilities: ownerCapabilities,
      version: "2",
    },
  };
  let serveViewerB = false;
  let delayNextAccountAHistory = false;
  let releaseLateAccountA!: () => void;
  let releaseAccountB!: () => void;
  let markLateAccountAStarted!: () => void;
  let markLateAccountAFulfilled!: () => void;
  let markAccountBStarted!: () => void;
  const lateAccountAGate = new Promise<void>((resolve) => { releaseLateAccountA = resolve; });
  const accountBGate = new Promise<void>((resolve) => { releaseAccountB = resolve; });
  const lateAccountAStarted = new Promise<void>((resolve) => { markLateAccountAStarted = resolve; });
  const lateAccountAFulfilled = new Promise<void>((resolve) => { markLateAccountAFulfilled = resolve; });
  const accountBStarted = new Promise<void>((resolve) => { markAccountBStarted = resolve; });
  const historyPayload = (id: string, name: string) => ({
    warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
    account: { id, name },
    orders: [],
    invoices: id === accountAId ? [invoiceA] : [],
    payments: [],
    credit: { currency: "USD", balanceMinor: "0", transactions: [] },
    refunds: [],
    services: [],
    renewals: [],
    cancellations: [],
    tickets: [],
  });

  await installMockApi(page, viewerA, {
    intercept: async (path, route) => {
      if (path === "/api/v1/auth/me") {
        await route.fulfill({
          headers: {
            "X-OSS-Account-Context-Version": serveViewerB ? "2" : "1",
            "X-OSS-Client-Account-Id": serveViewerB ? accountBId : accountAId,
          },
          json: serveViewerB ? viewerB : viewerA,
        });
        return true;
      }
      if (path === "/api/v1/auth/account-contexts") {
        await route.fulfill({
          headers: {
            "X-OSS-Account-Context-Version": serveViewerB ? "2" : "1",
            "X-OSS-Client-Account-Id": serveViewerB ? accountBId : accountAId,
          },
          json: {
            activeClientAccountId: serveViewerB ? accountBId : accountAId,
            accountContextVersion: serveViewerB ? "2" : "1",
            items: [
              { clientAccountId: accountAId, name: "Account A saved facts", role: "owner", permissions: ["*"], restrictions: { membership: false, clientAccount: false } },
              { clientAccountId: accountBId, name: "Account B saved facts", role: "owner", permissions: ["*"], restrictions: { membership: false, clientAccount: false } },
            ],
            limit: 25,
            hasMore: false,
            nextCursor: null,
          },
        });
        return true;
      }
      if (path === "/api/v1/auth/account-context" && route.request().method() === "PUT") {
        expect(route.request().headers()["x-oss-account-context-version"]).toBe("1");
        serveViewerB = true;
        // Keep the helper's default protected-response headers aligned with
        // the same synthetic session after the explicit context switch.
        viewerA.clientAccountId = accountBId;
        viewerA.accountContextVersion = "2";
        viewerA.context = viewerB.context;
        await route.fulfill({
          headers: {
            "X-OSS-Account-Context-Version": "2",
            "X-OSS-Client-Account-Id": accountBId,
          },
          json: { context: { ...viewerB.context, restrictions: { clientAccount: false } } },
        });
        return true;
      }
      if (path === `/api/v1/customer/invoices/${invoiceAId}`) {
        await route.fulfill({
          json: {
            warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
            invoice: { ...invoiceA, lines: [] },
            payments: [],
            creditApplications: [],
            refunds: [],
            related: { orderId: null, serviceIds: [], renewalIds: [] },
            pdfUrl: `/api/v1/customer/invoices/${invoiceAId}/pdf`,
          },
        });
        return true;
      }
      if (path !== "/api/v1/customer/business-history") return false;
      if (!serveViewerB && delayNextAccountAHistory) {
        delayNextAccountAHistory = false;
        markLateAccountAStarted();
        await lateAccountAGate;
        await route.fulfill({
          headers: { "X-OSS-Account-Context-Version": "1", "X-OSS-Client-Account-Id": accountAId },
          json: historyPayload(accountAId, "Late Account A facts"),
        });
        markLateAccountAFulfilled();
        return true;
      }
      if (serveViewerB) {
        markAccountBStarted();
        await accountBGate;
        await route.fulfill({
          headers: { "X-OSS-Account-Context-Version": "2", "X-OSS-Client-Account-Id": accountBId },
          json: historyPayload(accountBId, "Account B saved facts"),
        });
        return true;
      }
      await route.fulfill({
        headers: { "X-OSS-Account-Context-Version": "1", "X-OSS-Client-Account-Id": accountAId },
        json: historyPayload(accountAId, "Account A saved facts"),
      });
      return true;
    },
  });

  await page.goto("/customer");
  await expect(page.getByTestId("history-account")).toContainText("Account A saved facts");
  await page.getByTestId("history-invoice").click();
  await expect(page.getByTestId("customer-history-detail")).toContainText("Invoice detail");
  await expect(page).toHaveURL(new RegExp(`invoice=${invoiceAId}`));
  delayNextAccountAHistory = true;
  await page.getByTestId("customer-business-history").getByRole("button", { name: "Refresh history" }).click();
  await lateAccountAStarted;

  const switcher = page.getByTestId("account-context-switcher");
  await switcher.getByLabel("Active Client Account").selectOption(accountBId);
  await switcher.getByRole("button", { name: "Switch account" }).click();
  await accountBStarted;
  await expect(page.getByTestId("history-account")).toHaveCount(0);
  await expect(page.getByTestId("customer-history-detail")).toHaveCount(0);
  await expect(page).not.toHaveURL(/invoice=|service=/);

  releaseLateAccountA();
  await lateAccountAFulfilled;
  await page.waitForTimeout(50);
  await expect(page.getByText("Late Account A facts")).toHaveCount(0);
  await expect(page.getByTestId("history-account")).toHaveCount(0);

  releaseAccountB();
  await expect(page.getByTestId("history-account")).toContainText("Account B saved facts");
  await expect(page.getByTestId("history-account")).toContainText(accountBId);
});

test("customer history restores independent facts, detail query and invoice PDF", async ({ page }) => {
  const accountId = "00000000-0000-4000-8000-000000000101";
  const orderId = "00000000-0000-4000-8000-000000000102";
  const invoiceId = "00000000-0000-4000-8000-000000000103";
  const paymentId = "00000000-0000-4000-8000-000000000104";
  const serviceId = "00000000-0000-4000-8000-000000000105";
  const renewalId = "00000000-0000-4000-8000-000000000106";
  const cancellationId = "00000000-0000-4000-8000-000000000107";
  const ticketId = "00000000-0000-4000-8000-000000000108";
  const occurredAt = "2026-08-10T00:00:00.000Z";
  const invoice = {
    id: invoiceId,
    orderId,
    currency: "USD",
    totalMinor: "500",
    allocatedMinor: "500",
    paymentAllocatedMinor: "400",
    creditAppliedMinor: "100",
    dueMinor: "0",
    status: "paid",
    dueAt: occurredAt,
    createdAt: occurredAt,
  };
  const payment = {
    id: paymentId,
    invoiceId,
    status: "succeeded",
    amountMinor: "414",
    principalMinor: "400",
    feeMinor: "14",
    currency: "USD",
    paymentMethodCode: "card",
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  const service = {
    id: serviceId,
    orderId,
    invoiceIds: [invoiceId],
    productName: "Synthetic history plan",
    status: "active",
    billingCycle: "monthly",
    activatedAt: occurredAt,
    termStart: occurredAt,
    termEnd: "2026-09-10T00:00:00.000Z",
    version: 2,
    cancellation: { requestId: cancellationId, effectiveAt: "2026-09-10T00:00:00.000Z", status: "scheduled" },
  };
  const renewal = {
    id: renewalId,
    serviceId,
    invoiceId,
    status: "paid",
    currency: "USD",
    totalMinor: "300",
    allocatedMinor: "300",
    dueMinor: "0",
    periodStart: "2026-09-10T00:00:00.000Z",
    periodEnd: "2026-10-10T00:00:00.000Z",
    fundedAt: occurredAt,
    settledAt: occurredAt,
    createdAt: occurredAt,
  };
  const cancellation = {
    requestId: cancellationId,
    serviceId,
    effectiveAt: "2026-09-10T00:00:00.000Z",
    reason: "Synthetic cycle-end request",
    createdAt: occurredAt,
    execution: { id: cancellationId, mode: "automatic", status: "scheduled", completedAt: null },
  };
  const ticket = {
    id: ticketId,
    subject: "Synthetic linked support",
    status: "awaiting_staff",
    serviceId,
    productName: "Synthetic history plan",
    publicMessageCount: 2,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  await installMockApi(
    page,
    { ...mockViewer({ email: "history@example.invalid" }), clientAccountId: accountId },
    {
      intercept: async (path, route) => {
        if (path === "/api/v1/customer/business-history") {
          await route.fulfill({
            json: {
              warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
              account: { id: accountId, name: "Synthetic history account" },
              orders: [{
                id: orderId,
                status: "completed",
                currency: "USD",
                totalMinor: "500",
                submittedAt: occurredAt,
                items: [{ id: orderId, productName: "Synthetic history plan", billingCycle: "monthly" }],
              }],
              invoices: [invoice],
              payments: [payment],
              credit: {
                currency: "USD",
                balanceMinor: "100",
                transactions: [{
                  id: paymentId,
                  kind: "adjustment",
                  creditMinor: "100",
                  debitMinor: "0",
                  deltaMinor: "100",
                  sourceType: "credit_adjustment",
                  sourceId: paymentId,
                  reason: "Synthetic history fixture",
                  createdAt: occurredAt,
                }],
              },
              refunds: [{
                id: paymentId,
                invoiceId,
                status: "succeeded",
                destination: "credit",
                amountMode: "partial",
                amountMinor: "50",
                currency: "USD",
                createdAt: occurredAt,
                updatedAt: occurredAt,
              }],
              services: [service],
              renewals: [renewal],
              cancellations: [cancellation],
              tickets: [ticket],
            },
          });
          return true;
        }
        if (path === `/api/v1/customer/invoices/${invoiceId}`) {
          await route.fulfill({
            json: {
              warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
              invoice: {
                ...invoice,
                lines: [{ id: invoiceId, kind: "recurring", description: "Synthetic monthly plan", amountMinor: "500" }],
              },
              payments: [payment],
              creditApplications: [{ transactionId: paymentId, amountMinor: "100", createdAt: occurredAt }],
              refunds: [],
              related: { orderId, serviceIds: [serviceId], renewalIds: [renewalId] },
              pdfUrl: `/api/v1/customer/invoices/${invoiceId}/pdf`,
            },
          });
          return true;
        }
        if (path === `/api/v1/customer/invoices/${invoiceId}/pdf`) {
          await route.fulfill({
            body: "%PDF-1.4\nSynthetic invoice\n%%EOF",
            contentType: "application/pdf",
            headers: { "Content-Disposition": `attachment; filename="invoice-${invoiceId}.pdf"` },
          });
          return true;
        }
        if (path === `/api/v1/customer/services/${serviceId}`) {
          await route.fulfill({
            json: {
              warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
              service: { ...service, externalResourceId: "synthetic-resource-101" },
              order: { id: orderId, status: "completed", currency: "USD", totalMinor: "500", submittedAt: occurredAt },
              invoices: [{ ...invoice, kind: "initial" }],
              payments: [payment],
              periods: [{ id: renewalId, invoiceId, kind: "initial", start: occurredAt, end: "2026-09-10T00:00:00.000Z", grantedAt: occurredAt }],
              renewals: [renewal],
              cancellation,
              tickets: [ticket],
              trace: {
                orderId,
                invoiceIds: [invoiceId],
                paymentIds: [paymentId],
                renewalIds: [renewalId],
                cancellationRequestId: cancellationId,
                ticketIds: [ticketId],
              },
            },
          });
          return true;
        }
        return false;
      },
    },
  );

  await page.goto("/customer");
  const history = page.getByTestId("customer-business-history");
  await expect(history.getByTestId("history-account")).toContainText("Synthetic history account");
  await expect(history.getByTestId("history-order")).toHaveCount(1);
  await expect(history.getByTestId("history-payment")).toHaveCount(1);
  await expect(history.getByTestId("history-credit-transaction")).toHaveCount(1);
  await expect(history.getByTestId("history-refund")).toHaveCount(1);
  await expect(history.getByTestId("history-renewal")).toHaveCount(1);
  await expect(history.getByTestId("history-cancellation")).toHaveCount(1);
  await expect(history.getByTestId("history-ticket")).toHaveCount(1);

  await history.getByTestId("history-invoice").click();
  await expect(page).toHaveURL(new RegExp(`invoice=${invoiceId}`));
  const invoiceDetail = history.getByTestId("customer-history-detail");
  await expect(invoiceDetail).toContainText("Synthetic monthly plan");
  const downloadPromise = page.waitForEvent("download");
  await invoiceDetail.getByTestId("invoice-pdf-download").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`invoice-${invoiceId}.pdf`);

  await page.reload();
  await expect(page.getByTestId("customer-history-detail")).toContainText(invoiceId);
  await page.getByTestId("history-service").click();
  await expect(page).toHaveURL(new RegExp(`service=${serviceId}`));
  const trace = page.getByTestId("service-trace");
  await expect(trace).toContainText(orderId);
  await expect(trace).toContainText(paymentId);
  await expect(trace).toContainText(renewalId);
  await expect(trace).toContainText(cancellationId);
  await expect(trace).toContainText("Synthetic linked support");
});

test("failed customer history refresh reports only the error and never a success notice", async ({ page }) => {
  let failRefresh = false;
  await installMockApi(page, mockViewer({ email: "failed-history-refresh@example.invalid" }), {
    intercept: async (path, route) => {
      if (path !== "/api/v1/customer/business-history" || !failRefresh) return false;
      await route.fulfill({ status: 500, json: { error: "Synthetic history refresh failed" } });
      return true;
    },
  });

  await page.goto("/customer");
  const history = page.getByTestId("customer-business-history");
  await expect(history.getByTestId("history-account")).toBeVisible();
  failRefresh = true;
  await history.getByRole("button", { name: "Refresh all saved facts" }).click();
  await expect(page.locator(".notice.error")).toContainText("Synthetic history refresh failed");
  await expect(page.getByText("Business history refreshed.", { exact: true })).toHaveCount(0);
});

test("Account 360 requests only the panels granted to Staff", async ({ page }) => {
  const accountId = "00000000-0000-4000-8000-000000000201";
  const occurredAt = "2026-08-10T00:00:00.000Z";
  const requests = await installMockApi(
    page,
    mockViewer({
      email: "billing-reader@example.invalid",
      permissions: ["accounts.view", "billing.read"],
    }),
    {
      intercept: async (path, route) => {
        if (path === "/api/v1/admin/client-accounts") {
          await route.fulfill({
            json: {
              warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
              items: [{
                id: accountId,
                name: "Synthetic 360 account",
                owner: { userId: accountId, email: "owner@example.invalid", emailVerifiedAt: occurredAt },
                restrictedAt: null,
                activeMemberCount: 1,
                createdAt: occurredAt,
              }],
              hasMore: false,
              nextCursor: null,
            },
          });
          return true;
        }
        if (path === `/api/v1/admin/client-accounts/${accountId}/summary`) {
          await route.fulfill({
            json: {
              warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
              account: { id: accountId, name: "Synthetic 360 account", createdAt: occurredAt, restrictedAt: null },
              owner: { userId: accountId, email: "owner@example.invalid", emailVerifiedAt: occurredAt, restrictedAt: null },
              memberships: [{
                userId: accountId,
                email: "owner@example.invalid",
                role: "owner",
                permissions: [],
                emailVerifiedAt: occurredAt,
                userRestrictedAt: null,
                createdAt: occurredAt,
                removedAt: null,
              }],
              restrictions: [],
            },
          });
          return true;
        }
        if (path === `/api/v1/admin/client-accounts/${accountId}/billing`) {
          await route.fulfill({
            json: {
              warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
              account: { id: accountId, name: "Synthetic 360 account" },
              invoices: [],
              payments: [],
              credit: { currency: "USD", balanceMinor: "125", transactions: [] },
              fundReceipts: [],
              refunds: [],
              chargebacks: [],
              debt: { currency: "USD", balanceMinor: "0" },
            },
          });
          return true;
        }
        if (path === `/api/v1/admin/client-accounts/${accountId}/renewals`) {
          await route.fulfill({
            json: {
              warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
              account: { id: accountId, name: "Synthetic 360 account" },
              items: [],
            },
          });
          return true;
        }
        return false;
      },
    },
  );

  await page.goto("/admin");
  const workspace = page.getByTestId("client-account-360");
  const searchInput = workspace.getByLabel("Search Client Accounts");
  await expect(searchInput).toHaveAttribute("maxlength", "200");
  await searchInput.fill("owner@example.invalid");
  await workspace.getByRole("button", { name: "Search accounts" }).click();
  await workspace.getByTestId("account360-search-results").getByRole("button", { name: /Synthetic 360 account/ }).click();
  await expect(workspace.getByRole("heading", { name: "Account identity, verification and restrictions" })).toBeVisible();
  await expect(workspace.getByText("Founder owner@example.invalid", { exact: true })).toBeVisible();
  await expect(workspace.locator('section[aria-label="Account Contacts"]')).toHaveCount(0);
  await expect(workspace.getByTestId("account360-billing")).toContainText("$1.25");
  await expect(workspace.locator('section[aria-label="Account renewals"]')).toBeVisible();
  await expect(workspace.locator('section[aria-label="Account orders"]')).toHaveCount(0);
  await expect(workspace.locator('section[aria-label="Account services"]')).toHaveCount(0);
  await expect(workspace.locator('section[aria-label="Account cancellations"]')).toHaveCount(0);
  await expect(workspace.locator('section[aria-label="Account tickets"]')).toHaveCount(0);

  const accountPaths = [...new Set(requests.filter((path) => path.includes("/client-accounts")))].sort();
  expect(accountPaths).toEqual([
    "/api/v1/admin/client-accounts",
    `/api/v1/admin/client-accounts/${accountId}/billing`,
    `/api/v1/admin/client-accounts/${accountId}/renewals`,
    `/api/v1/admin/client-accounts/${accountId}/summary`,
  ].sort());
});

test("Account 360 pagination binds the cursor to the query, appends uniquely and clears on query change", async ({ page }) => {
  const occurredAt = "2026-08-10T00:00:00.000Z";
  const firstId = "00000000-0000-4000-8000-000000000221";
  const secondId = "00000000-0000-4000-8000-000000000222";
  const thirdId = "00000000-0000-4000-8000-000000000223";
  const searchUrls: URL[] = [];
  const item = (id: string, name: string) => ({
    id,
    name,
    owner: { userId: id, email: `${name.toLowerCase().replaceAll(" ", "-")}@example.invalid`, emailVerifiedAt: occurredAt },
    restrictedAt: null,
    activeMemberCount: 1,
    createdAt: occurredAt,
  });

  await installMockApi(
    page,
    mockViewer({ email: "paginated-reader@example.invalid", permissions: ["accounts.view"] }),
    {
      intercept: async (path, route) => {
        if (path === "/api/v1/admin/client-accounts") {
          const url = new URL(route.request().url());
          searchUrls.push(url);
          const query = url.searchParams.get("query");
          const cursor = url.searchParams.get("cursor");
          if (query === "Founder" && cursor === null) {
            await route.fulfill({
              json: {
                warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
                items: [item(firstId, "Founder Alpha"), item(secondId, "Founder Beta")],
                hasMore: true,
                nextCursor: "founder-page-2",
              },
            });
            return true;
          }
          if (query === "Founder" && cursor === "founder-page-2") {
            await route.fulfill({
              json: {
                warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
                items: [item(secondId, "Founder Beta updated"), item(thirdId, "Founder Gamma")],
                hasMore: false,
                nextCursor: null,
              },
            });
            return true;
          }
          await route.fulfill({
            json: {
              warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
              items: [item(thirdId, "Different Query")],
              hasMore: false,
              nextCursor: null,
            },
          });
          return true;
        }
        if (path === `/api/v1/admin/client-accounts/${firstId}/summary`) {
          await route.fulfill({
            json: {
              warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
              account: { id: firstId, name: "Founder Alpha", createdAt: occurredAt, restrictedAt: null },
              owner: { userId: firstId, email: "founder-alpha@example.invalid", emailVerifiedAt: occurredAt, restrictedAt: null },
              memberships: [],
              restrictions: [],
            },
          });
          return true;
        }
        return false;
      },
    },
  );

  await page.goto("/admin");
  const account360 = page.getByTestId("client-account-360");
  const input = account360.getByLabel("Search Client Accounts");
  await input.fill("  Founder  ");
  await account360.getByRole("button", { name: "Search accounts" }).click();
  const results = account360.getByTestId("account360-search-results");
  await expect(results.locator(":scope > button").filter({ has: page.locator("strong") })).toHaveCount(2);
  await results.getByRole("button", { name: /Founder Alpha/ }).click();
  await expect(account360.getByTestId("account360-workspace")).toBeVisible();

  await results.getByRole("button", { name: "Load more accounts" }).click();
  await expect(results.getByRole("button", { name: /Founder Gamma/ })).toBeVisible();
  await expect(results.getByRole("button", { name: /Founder Beta updated/ })).toHaveCount(1);
  await expect(results.getByRole("button", { name: "Load more accounts" })).toHaveCount(0);
  expect(searchUrls[1]?.searchParams.get("query")).toBe("Founder");
  expect(searchUrls[1]?.searchParams.get("limit")).toBe("20");
  expect(searchUrls[1]?.searchParams.get("cursor")).toBe("founder-page-2");

  await input.fill("Different");
  await expect(account360.getByTestId("account360-search-results")).toHaveCount(0);
  await expect(account360.getByTestId("account360-workspace")).toHaveCount(0);
  await account360.getByRole("button", { name: "Search accounts" }).click();
  await expect(account360.getByRole("button", { name: /Different Query/ })).toBeVisible();
  expect(searchUrls.at(-1)?.searchParams.get("query")).toBe("Different");
  expect(searchUrls.at(-1)?.searchParams.has("cursor")).toBe(false);
});

test("refreshing Staff access immediately removes a loaded Account 360 after permission revocation", async ({ page }) => {
  const accountId = "00000000-0000-4000-8000-000000000211";
  const occurredAt = "2026-08-10T00:00:00.000Z";
  const activeViewer = mockViewer({
    email: "revoked-account-reader@example.invalid",
    permissions: ["accounts.view"],
  });
  const revokedViewer = mockViewer({
    email: "revoked-account-reader@example.invalid",
    permissions: ["support.tickets.manage"],
  });
  let revoked = false;
  const requests = await installMockApi(page, activeViewer, {
    intercept: async (path, route) => {
      if (path === "/api/v1/auth/me") {
        await route.fulfill({ json: revoked ? revokedViewer : activeViewer });
        return true;
      }
      if (path === "/api/v1/admin/client-accounts") {
        await route.fulfill({
          json: {
            warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
            items: [{
              id: accountId,
              name: "Revocable Account 360",
              owner: { userId: accountId, email: "founder@example.invalid", emailVerifiedAt: occurredAt },
              restrictedAt: null,
              activeMemberCount: 1,
              createdAt: occurredAt,
            }],
            hasMore: false,
            nextCursor: null,
          },
        });
        return true;
      }
      if (path === `/api/v1/admin/client-accounts/${accountId}/summary`) {
        await route.fulfill({
          json: {
            warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
            account: { id: accountId, name: "Revocable Account 360", createdAt: occurredAt, restrictedAt: null },
            owner: { userId: accountId, email: "founder@example.invalid", emailVerifiedAt: occurredAt, restrictedAt: null },
            memberships: [{
              userId: accountId,
              email: "founder@example.invalid",
              role: "owner",
              permissions: [],
              emailVerifiedAt: occurredAt,
              userRestrictedAt: null,
              createdAt: occurredAt,
              removedAt: null,
            }],
            restrictions: [],
          },
        });
        return true;
      }
      return false;
    },
  });

  await page.goto("/admin");
  const account360 = page.getByTestId("client-account-360");
  await account360.getByLabel("Search Client Accounts").fill("founder@example.invalid");
  await account360.getByRole("button", { name: "Search accounts" }).click();
  await account360.getByRole("button", { name: /Revocable Account 360/ }).click();
  await expect(account360.getByTestId("account360-memberships")).toContainText("founder@example.invalid");
  const accountRequestCount = requests.filter((path) => path.includes("/client-accounts")).length;

  revoked = true;
  await account360.getByRole("button", { name: "Refresh Staff access" }).click();
  await expect(page.getByTestId("client-account-360")).toHaveCount(0);
  await expect(page.getByText("Revocable Account 360")).toHaveCount(0);
  await expect(page.locator('section[aria-label="Staff support tickets"]')).toBeVisible();
  await expect(page.getByTestId("limited-admin-scope")).toBeVisible();
  expect(requests.filter((path) => path.includes("/client-accounts"))).toHaveLength(accountRequestCount);
});

test("Staff visiting customer mounts customer tickets without Staff DOM or fetches", async ({ page }) => {
  const requests = await installMockApi(
    page,
    mockViewer({ email: "staff-as-customer@example.invalid", permissions: ["*"] }),
  );

  await page.goto("/customer");
  await expect(page.locator('section[aria-label="Customer support tickets"]')).toBeVisible();
  await expect(page.locator('section[aria-label="Staff support tickets"]')).toHaveCount(0);
  await expect(page.locator("section.admin-panel")).toHaveCount(0);
  expect(requests.filter((path) => path.startsWith("/api/v1/admin/"))).toEqual([]);
});

test("successful sign out performs a hard document navigation", async ({ page }) => {
  await installMockApi(page, mockViewer({ email: "logout@example.invalid" }));
  await page.goto("/customer");
  const rootDocument = page.waitForRequest(
    (request) => request.resourceType() === "document" && new URL(request.url()).pathname === "/",
  );
  await page.getByRole("button", { name: "Sign out" }).click();
  await rootDocument;
  await expect(page).toHaveURL(/\/$/);
});

test("an App protected API 401 performs a hard document navigation", async ({ page }) => {
  await installMockApi(
    page,
    mockViewer({ email: "expired-app@example.invalid" }),
    { unauthorizedPath: "/api/v1/billing/summary" },
  );
  const rootDocument = page.waitForRequest(
    (request) => request.resourceType() === "document" && new URL(request.url()).pathname === "/",
  );
  await page.goto("/customer");
  await rootDocument;
  await expect(page).toHaveURL(/\/$/);
});

test("a ticket protected API 401 performs the same hard document navigation", async ({ page }) => {
  await installMockApi(
    page,
    mockViewer({ email: "expired-ticket@example.invalid" }),
    { unauthorizedPath: "/api/v1/tickets" },
  );
  const rootDocument = page.waitForRequest(
    (request) => request.resourceType() === "document" && new URL(request.url()).pathname === "/",
  );
  await page.goto("/customer");
  await rootDocument;
  await expect(page).toHaveURL(/\/$/);
});

test("guest auth check does not hard-reload or loop", async ({ page }) => {
  await installMockApi(page, null);
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(new URL(request.url()).pathname);
  });
  await page.goto("/customer");
  await expect(page.getByRole("heading", { name: "Sign in to open the customer workspace" })).toBeVisible();
  await expect(page).toHaveURL(/\/customer$/);
  expect(documents).toEqual(["/customer"]);
});

test("reauth password rejection stays in the current workspace", async ({ page }) => {
  await installMockApi(
    page,
    mockViewer({ email: "wrong-reauth-password@example.invalid" }),
    {
      unauthorizedPath: "/api/v1/auth/reauth",
      unauthorizedError: "Password confirmation failed",
    },
  );
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(new URL(request.url()).pathname);
  });

  await page.goto("/customer");
  await page.getByTestId("payment-settings-password").fill("Synthetic-Wrong-Password!");
  await page.getByRole("button", { name: "Set as default only" }).click();
  await expect(page.locator(".notice.error")).toContainText("Password confirmation failed");
  await expect(page).toHaveURL(/\/customer$/);
  expect(documents).toEqual(["/customer"]);
});

test("delayed business history cannot mount facts after leaving customer", async ({ page }) => {
  let releaseResponse!: () => void;
  let markRequestStarted!: () => void;
  let markResponseFulfilled!: () => void;
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve; });
  const responseFulfilled = new Promise<void>((resolve) => { markResponseFulfilled = resolve; });
  await installMockApi(
    page,
    mockViewer({ email: "delayed-history@example.invalid" }),
    {
      intercept: async (path, route) => {
        if (path !== "/api/v1/customer/business-history") return false;
        markRequestStarted();
        await responseGate;
        await route.fulfill({
          json: {
            warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
            account: {
              id: "00000000-0000-4000-8000-000000000301",
              name: "Delayed history account",
            },
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
        markResponseFulfilled();
        return true;
      },
    },
  );

  await page.goto("/customer");
  await requestStarted;
  await page.getByRole("link", { name: "Home", exact: true }).click();
  releaseResponse();
  await responseFulfilled;
  await page.waitForTimeout(50);
  await expect(page.getByTestId("customer-business-history")).toHaveCount(0);
  await expect(page.getByText("Delayed history account")).toHaveCount(0);
  await expect(page.locator(".notice")).toHaveCount(0);
});

for (const sessionError of ["Session is invalid or expired", "Authentication required"]) {
  test(`reauth session error hard-navigates: ${sessionError}`, async ({ page }) => {
    await installMockApi(
      page,
      mockViewer({ email: "expired-reauth-session@example.invalid" }),
      {
        unauthorizedPath: "/api/v1/auth/reauth",
        unauthorizedError: sessionError,
      },
    );

    await page.goto("/customer");
    const rootDocument = page.waitForRequest(
      (request) => request.resourceType() === "document" && new URL(request.url()).pathname === "/",
    );
    await page.getByTestId("payment-settings-password").fill("Synthetic-Expired-Session!");
    await page.getByRole("button", { name: "Set as default only" }).click();
    await rootDocument;
    await expect(page).toHaveURL(/\/$/);
  });
}

test("delayed customer completion cannot leak notice or DOM after navigating Home", async ({
  page,
}) => {
  let releaseResponse!: () => void;
  let markRequestStarted!: () => void;
  let markResponseFulfilled!: () => void;
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve; });
  const responseFulfilled = new Promise<void>((resolve) => { markResponseFulfilled = resolve; });
  const ticketId = "00000000-0000-4000-8000-000000000010";
  const createdAt = "2026-01-01T00:00:00.000Z";
  await installMockApi(
    page,
    mockViewer({ email: "delayed-customer@example.invalid" }),
    {
      intercept: async (path, route) => {
        if (path !== "/api/v1/tickets" || route.request().method() !== "POST") return false;
        markRequestStarted();
        await responseGate;
        await route.fulfill({
          status: 201,
          json: {
            ticket: {
              id: ticketId,
              subject: "Delayed customer ticket",
              status: "awaiting_staff",
              service: null,
              publicMessageCount: 1,
              createdAt,
              updatedAt: createdAt,
            },
            messages: [
              { id: ticketId, authorType: "customer", body: "Delayed body", createdAt },
            ],
          },
        });
        markResponseFulfilled();
        return true;
      },
    },
  );

  await page.goto("/customer");
  await page.getByLabel("Ticket subject").fill("Delayed customer ticket");
  await page.getByLabel("Opening message").fill("Delayed body");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await requestStarted;
  await page.getByRole("link", { name: "Home", exact: true }).click();
  releaseResponse();
  await responseFulfilled;
  await page.waitForTimeout(50);
  await expect(page.getByText("Support ticket created.", { exact: true })).toHaveCount(0);
  await expect(page.locator('section[aria-label="Customer support tickets"]')).toHaveCount(0);
  await expect(page.locator('section[aria-label="Staff support tickets"]')).toHaveCount(0);
  await expect(page.getByTestId("full-admin-workspace")).toHaveCount(0);
});

test("delayed Staff completion cannot leak or refetch after navigating to customer", async ({
  page,
}) => {
  let releaseResponse!: () => void;
  let markRequestStarted!: () => void;
  let markResponseFulfilled!: () => void;
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve; });
  const responseFulfilled = new Promise<void>((resolve) => { markResponseFulfilled = resolve; });
  const ticketId = "00000000-0000-4000-8000-000000000020";
  const createdAt = "2026-01-01T00:00:00.000Z";
  const ticket = {
    id: ticketId,
    subject: "Delayed Staff ticket",
    status: "awaiting_staff",
    service: null,
    orderId: null,
    authorizationPurpose: null,
    department: { code: "general-support", name: "General Support" },
    priority: "normal",
    assignedStaffUserId: null,
    publicMessageCount: 1,
    createdAt,
    updatedAt: createdAt,
    clientAccount: {
      id: "00000000-0000-4000-8000-000000000002",
      name: "Delayed account",
    },
    internalMessageCount: 0,
  };
  const requests = await installMockApi(
    page,
    mockViewer({
      email: "delayed-staff@example.invalid",
      permissions: ["support.tickets.manage"],
    }),
    {
      intercept: async (path, route) => {
        if (path === "/api/v1/admin/tickets" && route.request().method() === "GET") {
          await route.fulfill({ json: { items: [ticket] } });
          return true;
        }
        if (path === `/api/v1/admin/tickets/${ticketId}`) {
          await route.fulfill({ json: {
            ticket,
            messages: [],
            attachments: [],
            statusHistory: [],
            assignmentHistory: [],
            routingHistory: [],
          } });
          return true;
        }
        if (
          path === `/api/v1/admin/tickets/${ticketId}/messages` &&
          route.request().method() === "POST"
        ) {
          markRequestStarted();
          await responseGate;
          await route.fulfill({
            status: 201,
            json: {
              ticket: { ...ticket, status: "awaiting_customer" },
              messages: [
                {
                  id: ticketId,
                  authorType: "staff",
                  visibility: "public",
                  authorEmail: "delayed-staff@example.invalid",
                  body: "Delayed public reply",
                  createdAt,
                },
              ],
              attachments: [],
              statusHistory: [],
              assignmentHistory: [],
              routingHistory: [],
            },
          });
          markResponseFulfilled();
          return true;
        }
        return false;
      },
    },
  );

  await page.goto("/admin");
  await page.getByTestId("staff-ticket-list").getByRole("button", { name: /Delayed Staff ticket/ }).click();
  const thread = page.getByTestId("staff-ticket-thread");
  await thread.getByLabel("Staff ticket message").fill("Delayed public reply");
  await thread.getByRole("button", { name: "Send public reply" }).click();
  await requestStarted;
  const staffListFetchesBeforeRelease = requests.filter(
    (path) => path === "/api/v1/admin/tickets",
  ).length;
  await page.getByRole("link", { name: "Customer", exact: true }).click();
  await expect(page.locator('section[aria-label="Customer support tickets"]')).toBeVisible();
  releaseResponse();
  await responseFulfilled;
  await page.waitForTimeout(50);
  await expect(page.getByText("Public reply sent.", { exact: true })).toHaveCount(0);
  await expect(page.locator('section[aria-label="Staff support tickets"]')).toHaveCount(0);
  await expect(page.getByTestId("full-admin-workspace")).toHaveCount(0);
  expect(requests.filter((path) => path === "/api/v1/admin/tickets").length).toBe(
    staffListFetchesBeforeRelease,
  );
});

test("delayed manual outflow completion does not refresh Admin history after leaving Admin", async ({
  page,
}) => {
  let releaseResponse!: () => void;
  let markRequestStarted!: () => void;
  let markResponseFulfilled!: () => void;
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve; });
  const responseFulfilled = new Promise<void>((resolve) => { markResponseFulfilled = resolve; });
  const clientAccountId = "00000000-0000-4000-8000-0000000000aa";
  const manualReceiptId = "00000000-0000-4000-8000-0000000000bb";
  const historyPath = `/api/v1/admin/client-accounts/${clientAccountId}/manual-receipts`;
  const outflowPath = `${historyPath}/${manualReceiptId}/outflow-reports`;
  let historyReads = 0;
  const receipt = {
    manualReceiptId,
    fundReceiptId: "00000000-0000-4000-8000-0000000000cc",
    reference: "SYNTHETIC-MANUAL-RECEIPT",
    receivedAt: "2026-01-01T00:00:00.000Z",
    grossAmountMinor: "10000",
    feeMinor: "0",
    netAmountMinor: "10000",
    allocatedMinor: "0",
    availableMinor: "10000",
    capacityFrozen: false,
    currency: "USD",
    disposition: "unclaimed",
    originalSourceOutflow: {
      sourceContext: "unclaimed_funds",
      sourceAmountMinor: "10000",
      confirmedOutflowMinor: "0",
      availableMinor: "10000",
      capacityFrozen: false,
      reports: [],
    },
    reversal: null,
    actorId: "00000000-0000-4000-8000-0000000000dd",
    reason: "Synthetic receipt fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  await installMockApi(
    page,
    mockViewer({ email: "delayed-outflow-staff@example.invalid", permissions: ["*"] }),
    {
      intercept: async (path, route) => {
        if (path === historyPath && route.request().method() === "GET") {
          historyReads += 1;
          await route.fulfill({
            json: {
              clientAccount: { id: clientAccountId, name: "Synthetic outflow target" },
              items: [receipt],
            },
          });
          return true;
        }
        if (path === outflowPath && route.request().method() === "POST") {
          markRequestStarted();
          await responseGate;
          await route.fulfill({ json: { status: "confirmed", replayed: false } });
          markResponseFulfilled();
          return true;
        }
        return false;
      },
    },
  );

  await page.goto("/admin");
  await page.getByLabel("Manual receipt Client Account ID").fill(clientAccountId);
  await page.getByRole("button", { name: "Verify account & load history" }).click();
  await expect(page.getByTestId("manual-receipt-history-item")).toBeVisible();
  await page.getByPlaceholder("Re-enter password (15-minute fixed window)").fill(
    "Synthetic-Admin-Password!",
  );
  await page.getByRole("button", { name: "Report original-source outflow" }).click();
  await page.getByLabel("Original-source destination reference").fill("SYNTHETIC-RETURN");
  await page.getByLabel("Original-source outflow reason").fill(
    "Synthetic evidence confirms this exact return",
  );
  await page.getByRole("button", { name: "Record outflow report" }).click();
  await requestStarted;
  const historyReadsBeforeLeaving = historyReads;
  await page.getByRole("link", { name: "Home", exact: true }).click();
  releaseResponse();
  await responseFulfilled;
  await page.waitForTimeout(100);
  expect(historyReads).toBe(historyReadsBeforeLeaving);
  await expect(page.getByTestId("manual-receipt-history")).toHaveCount(0);
  await expect(page.locator(".notice")).toHaveCount(0);
});

test("History navigation clears selected checkout, reauth grant, passwords and Admin drafts", async ({
  page,
}) => {
  await installMockApi(
    page,
    mockViewer({ email: "history-staff@example.invalid", permissions: ["*"] }),
  );

  await page.goto("/");
  await page.getByRole("button", { name: "monthly $1.00" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Continue in customer workspace" }).click();
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("link", { name: "Admin", exact: true }).click();
  const adminPassword = page.getByPlaceholder("Re-enter password (15-minute fixed window)");
  const creditReason = page.getByPlaceholder("Credit adjustment reason (10+ characters)");
  await adminPassword.fill("Synthetic-Admin-Draft!");
  await creditReason.fill("Synthetic sensitive draft");
  await page.goBack();
  await expect(page.getByText("Public access", { exact: true })).toBeVisible();
  await page.goForward();
  await expect(adminPassword).toHaveValue("");
  await expect(creditReason).toHaveValue("");

  await page.goBack();
  await page.getByRole("link", { name: "Customer", exact: true }).click();
  const customerPassword = page.getByTestId("payment-settings-password");
  await customerPassword.fill("Synthetic-Customer-Reauth!");
  await page.getByRole("button", { name: "Set as default only" }).click();
  await expect(page.getByTestId("payment-settings-reauth-active")).toBeVisible();
  await expect(page.getByText(/Mock Card ending 4242 is now the default/)).toBeVisible();
  await page.goBack();
  await page.goForward();
  await expect(page.getByTestId("payment-settings-reauth-active")).toHaveCount(0);
  await expect(customerPassword).toHaveValue("");
  await expect(page.getByText(/Mock Card ending 4242 is now the default/)).toHaveCount(0);
});
