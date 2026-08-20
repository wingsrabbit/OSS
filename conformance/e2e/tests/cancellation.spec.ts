// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test";
import { completeCatalogCheckout } from "./helpers/catalog-checkout.js";

test.describe.configure({ retries: 0 });

test("customer cancellation withdraws a pristine renewal and preserves the paid service term", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const unique = crypto.randomUUID();
  const email = `cancellation-browser-${unique}@example.invalid`;
  const password = `Synthetic-${unique}-Cancellation!`;
  const clientName = `Synthetic Cancellation Browser ${unique.slice(0, 8)}`;
  const cancellationReason = `Synthetic Mock-only cycle-end cancellation ${unique}`;

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
  await expect(checkoutDialog.getByRole("heading", { name: "HKBGP VPS" })).toBeVisible();
  await completeCatalogCheckout(checkoutDialog);
  await expect(checkoutDialog).toBeHidden();

  const journey = page.locator("section.order-panel").filter({ hasText: "Live customer journey" });
  await journey.getByLabel("Payment method", { exact: true }).selectOption("usdt");
  await journey.getByRole("button", { name: "Start mock payment" }).click();
  await expect(journey.getByText("active", { exact: true })).toBeVisible({ timeout: 30_000 });

  const scheduleCancellation = journey.getByLabel("Schedule service cancellation");
  await expect(scheduleCancellation).toBeVisible();
  const originalTermEndDisplay = (
    (await scheduleCancellation.locator("strong").textContent()) ?? ""
  ).trim();
  expect(originalTermEndDisplay).not.toBe("");
  const originalTermEndMs = Date.parse(originalTermEndDisplay);
  expect(Number.isNaN(originalTermEndMs)).toBe(false);

  const staffEmail = "stage-a-browser-admin@example.invalid";
  const staffPassword = "Synthetic-Stage-A-Browser-Admin-Only!";
  await page.context().clearCookies();
  await page.goto("/");
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
      .fill(`Mock-only pristine renewal before cancellation ${unique}`);
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

  await page.context().clearCookies();
  await page.goto("/");
  await page.getByPlaceholder("Email").last().fill(email);
  await page.getByPlaceholder("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await scheduleCancellation.getByLabel("Cancellation reason (optional)").fill(cancellationReason);
  await scheduleCancellation
    .getByRole("button", { name: "Cancel at paid period end", exact: true })
    .click();

  const scheduledCancellation = journey.getByLabel("Service cancellation status");
  await expect(scheduledCancellation).toBeVisible();
  await expect(scheduledCancellation).toContainText(originalTermEndDisplay);
  await expect(scheduledCancellation).toContainText(
    "The service remains available through its current paid period.",
  );
  await expect(scheduledCancellation).toContainText(
    "No new renewal invoice will be generated. This action does not issue a refund.",
  );
  await expect(journey.getByText("active", { exact: true })).toBeVisible();

  const immediateCancelledRenewal = page
    .locator('[aria-label="Service renewals"]')
    .getByTestId("renewal-item")
    .filter({ hasText: "HKBGP VPS" });
  await expect(immediateCancelledRenewal).toContainText("funding cancelled");
  await expect(immediateCancelledRenewal).toContainText("due $0.00");

  await page.reload();
  await expect(page.getByText("NOT FOR PRODUCTION — MOCK PROVIDERS ONLY", { exact: true }))
    .toBeVisible();
  const restoredJourney = page
    .locator("section.order-panel")
    .filter({ hasText: "Live customer journey" });
  const restoredCancellation = restoredJourney.getByLabel("Service cancellation status");
  await expect(restoredCancellation).toBeVisible();
  await expect(restoredCancellation).toContainText(originalTermEndDisplay);
  await expect(restoredJourney.getByText("active", { exact: true })).toBeVisible();
  await expect(restoredCancellation).toContainText("No new renewal invoice will be generated.");
  await expect(restoredCancellation).toContainText("This action does not issue a refund.");

  const renewalSection = page.locator('[aria-label="Service renewals"]');
  const cancelledServiceRenewal = renewalSection
    .getByTestId("renewal-item")
    .filter({ hasText: "HKBGP VPS" });
  await expect(cancelledServiceRenewal).toHaveCount(1);
  await expect(cancelledServiceRenewal).toContainText("funding cancelled");
  await expect(cancelledServiceRenewal).toContainText("term grant cancelled");
  await expect(cancelledServiceRenewal).toContainText("due $0.00");
  await expect(cancelledServiceRenewal.getByTestId("renewal-cancelled")).toContainText(
    "collectible due is zero",
  );
});
