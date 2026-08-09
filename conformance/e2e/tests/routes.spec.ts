// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Page } from "@playwright/test";

type MockViewer = {
  id: string;
  email: string;
  locale: "en";
  clientAccountId: string;
  membershipRole: string;
  verification: { email: "passed" };
  eligible: boolean;
  staff: { roles: string[]; permissions: unknown } | null;
};

function mockViewer({
  email,
  eligible = true,
  permissions = null,
}: {
  email: string;
  eligible?: boolean;
  permissions?: unknown;
}): MockViewer {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    email,
    locale: "en",
    clientAccountId: "00000000-0000-4000-8000-000000000002",
    membershipRole: "owner",
    verification: { email: "passed" },
    eligible,
    staff: permissions === null ? null : { roles: ["support"], permissions },
  };
}

async function installMockApi(
  page: Page,
  viewer: MockViewer | null,
  options: { unauthorizedPath?: string } = {},
): Promise<string[]> {
  const requests: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push(path);

    if (path === "/api/v1/auth/me") {
      if (viewer) {
        await route.fulfill({ json: viewer });
      } else {
        await route.fulfill({ status: 401, json: { error: "Authentication required" } });
      }
      return;
    }
    if (path === options.unauthorizedPath) {
      await route.fulfill({ status: 401, json: { error: "Session expired" } });
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
    if (path === "/api/v1/orders") {
      await route.fulfill({ json: { items: [] } });
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
    if (path === "/api/v1/admin/add-funds-chargebacks") {
      await route.fulfill({ json: { items: [], unclaimedChargebacks: [], manualHolds: [] } });
      return;
    }
    if (path.startsWith("/api/v1/admin/")) {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    await route.fulfill({ json: {} });
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
    "Access denied — eligible Staff account required",
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
  expect(requests.filter((path) => path.startsWith("/api/v1/admin/"))).toEqual([]);
});

test("restricted wildcard Staff mounts no Admin capability or Admin fetch", async ({ page }) => {
  const requests = await installMockApi(
    page,
    mockViewer({
      email: "restricted-wildcard@example.invalid",
      eligible: false,
      permissions: ["*"],
    }),
  );

  await page.goto("/admin");
  await expect(page.getByTestId("admin-access-restricted")).toContainText(
    "Access denied — eligible Staff account required",
  );
  await expect(page.locator('section[aria-label="Staff support tickets"]')).toHaveCount(0);
  await expect(page.locator("section.admin-panel")).toHaveCount(0);
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
  await expect(page.getByTestId("limited-admin-scope")).toContainText("Ticket support only");
  await expect(page.getByTestId("full-admin-workspace")).toHaveCount(0);
  await expect(page.getByTestId("admin-access-restricted")).toHaveCount(0);
  const adminPaths = [...new Set(requests.filter((path) => path.startsWith("/api/v1/admin/")))];
  expect(adminPaths).toEqual(["/api/v1/admin/tickets"]);
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
