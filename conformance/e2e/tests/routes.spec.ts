// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test";

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
    "Access denied — Staff permission required",
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
  await expect(page.locator("section.admin-panel").first()).toBeVisible();
  await expect(page.locator('section[aria-label="Customer support tickets"]')).toHaveCount(0);
  await expect(page.locator("section.catalog")).toHaveCount(0);

  await page.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText(staffEmail)).toHaveCount(0);
  await expect(page.locator('section[aria-label="Staff support tickets"]')).toHaveCount(0);
  await expect(page.locator("section.admin-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Guest", { exact: true })).toBeVisible();
});
