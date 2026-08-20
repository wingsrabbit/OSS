// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test";
import { completeCatalogCheckout } from "./helpers/catalog-checkout.js";

test.describe.configure({ retries: 0 });

test("customer and staff complete a duplicate-safe renewal through real pages", async ({ page }) => {
  test.setTimeout(180_000);
  const unique = crypto.randomUUID();
  const email = `renewal-browser-${unique}@example.invalid`;
  const password = `Synthetic-${unique}-Renewal!`;
  const clientName = `Synthetic Renewal Browser ${unique.slice(0, 8)}`;

  await page.goto("/");
  await expect(page.getByText("NOT FOR PRODUCTION — MOCK PROVIDERS ONLY", { exact: true }))
    .toBeVisible();
  await page.getByPlaceholder("Client account name").fill(clientName);
  await page.getByPlaceholder("Email").first().fill(email);
  await page.getByPlaceholder("Password (12+ characters)").fill(password);
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByText(/Account created/)).toBeVisible();

  await page.getByPlaceholder("Email").last().fill(email);
  await page.getByPlaceholder("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const mailboxButton = page.getByRole("button", { name: "Open my Mock Provider mailbox" });
  const verificationLink = page.getByRole("link", { name: "Use one-time verification link" });
  for (let attempt = 0; attempt < 20 && (await verificationLink.count()) === 0; attempt += 1) {
    await mailboxButton.click();
    await page.waitForTimeout(250);
  }
  await expect(verificationLink).toBeVisible();
  await verificationLink.click();
  await expect(page.getByText(/Email verified — account is eligible/)).toBeVisible();

  const product = page.locator("article").filter({ hasText: "HKBGP VPS" }).first();
  await product.getByRole("button", { name: /monthly/i }).click();
  const checkoutDialog = page.getByRole("dialog");
  await completeCatalogCheckout(checkoutDialog);
  const journey = page.locator("section.order-panel").filter({ hasText: "Live customer journey" });
  await journey.getByLabel("Payment method", { exact: true }).selectOption("usdt");
  await journey.getByRole("button", { name: "Start mock payment" }).click();
  await expect(journey.getByText("active", { exact: true })).toBeVisible({ timeout: 30_000 });
  const paidTerm = journey.getByLabel("Schedule service cancellation");
  await expect(paidTerm).toBeVisible();
  const originalTermEndDisplay = ((await paidTerm.locator("strong").textContent()) ?? "").trim();
  const originalTermEndMs = Date.parse(originalTermEndDisplay);
  expect(Number.isNaN(originalTermEndMs)).toBe(false);

  await page.context().clearCookies();
  await page.goto("/");
  const staffEmail = "stage-a-browser-admin@example.invalid";
  const staffPassword = "Synthetic-Stage-A-Browser-Admin-Only!";
  await page.getByPlaceholder("Email").last().fill(staffEmail);
  await page.getByPlaceholder("Password", { exact: true }).fill(staffPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  const admin = page.locator("section.admin-panel");
  const renewalAdmin = admin.locator('[aria-label="Renewal billing automation"]');
  await expect(
    renewalAdmin.getByRole("heading", {
      name: "Renewal, Late Fee and service state automation",
    }),
  ).toBeVisible();
  let completedBillingDay = false;
  for (const daysBeforeTerm of [13, 12, 11, 10, 9, 8, 7, 6, 4, 3, 2, 1]) {
    const billingEffectiveAt = new Date(
      originalTermEndMs - daysBeforeTerm * 24 * 60 * 60 * 1_000,
    );
    await renewalAdmin
      .getByLabel("Laboratory billing effective time")
      .fill(billingEffectiveAt.toISOString().slice(0, 16));
    await renewalAdmin
      .getByPlaceholder("Automation run reason (10+ characters)")
      .fill(`Browser acceptance generated the next paid service period ${unique}`);
    await admin
      .getByPlaceholder("Re-enter password (15-minute fixed window)")
      .fill(staffPassword);
    const billingResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/admin/billing/automation/run") &&
        response.request().method() === "POST",
    );
    await renewalAdmin.getByRole("button", { name: "Run billing day" }).click();
    const billingResponse = await billingResponsePromise;
    const billingResult = (await billingResponse.json()) as { replayed: boolean };
    expect(billingResponse.status()).toBe(billingResult.replayed ? 200 : 201);
    await expect(
      page.getByText(
        new RegExp(
          `${billingResult.replayed ? "Replayed" : "Completed"} Asia/Shanghai billing day`,
        ),
      ),
    ).toBeVisible();
    if (!billingResult.replayed) {
      completedBillingDay = true;
      break;
    }
  }
  expect(completedBillingDay, "a fresh eligible laboratory billing day must run").toBe(true);
  const adminRenewal = renewalAdmin
    .getByTestId("admin-renewal-item")
    .filter({ hasText: clientName });
  await expect(adminRenewal).toHaveCount(1);
  await expect(adminRenewal).toContainText("Funding open · term grant invoiced");

  await page.context().clearCookies();
  await page.goto("/");
  await page.getByPlaceholder("Email").last().fill(email);
  await page.getByPlaceholder("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  const renewalSection = page.locator('[aria-label="Service renewals"]');
  await expect(
    renewalSection.getByRole("heading", { name: "Renewal invoices and paid-through dates" }),
  ).toBeVisible();
  const renewal = renewalSection.getByTestId("renewal-item").filter({ hasText: "HKBGP VPS" });
  await expect(renewal).toHaveCount(1);
  await expect(renewal).toContainText("funding open · term grant invoiced");
  await renewal.getByLabel(/Renewal payment method/).selectOption("usdt");
  await renewal.getByLabel(/Renewal Provider scenario/).selectOption("duplicate_out_of_order");
  await renewal.getByRole("button", { name: "Pay renewal with Mock Provider" }).click();
  await expect(renewal).toContainText("funding paid · term grant paid", { timeout: 30_000 });
  await expect(renewal).toContainText("due $0.00");

  await renewalSection.getByRole("button", { name: "Open my Mock Provider mailbox" }).click();
  await expect(renewalSection.getByText("Renewal invoice created", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(renewalSection.getByText(/delivered/).first()).toBeVisible();

  await page.context().clearCookies();
  await page.goto("/");
  await page.getByPlaceholder("Email").last().fill(staffEmail);
  await page.getByPlaceholder("Password", { exact: true }).fill(staffPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const refreshedAdmin = page
    .locator('[aria-label="Renewal billing automation"]')
    .getByTestId("admin-renewal-item")
    .filter({ hasText: clientName });
  await expect(refreshedAdmin).toContainText("Funding paid · term grant paid");
  await expect(refreshedAdmin).toContainText("invoice created=delivered");
});
