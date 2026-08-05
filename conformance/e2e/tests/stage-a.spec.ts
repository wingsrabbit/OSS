// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test";

test("unverified customer verifies, pays, and reaches Ready for Service", async ({ page }) => {
  const unique = crypto.randomUUID();
  const email = `browser-${unique}@example.invalid`;
  const password = `Synthetic-${unique}-Password!`;

  await page.goto("/");
  await expect(page.getByText("NOT FOR PRODUCTION — MOCK PROVIDERS ONLY", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "TermRat synthetic acceptance configuration" })).toBeVisible();

  await page.getByPlaceholder("Client account name").fill("Synthetic Browser Client");
  await page.getByPlaceholder("Email").first().fill(email);
  await page.getByPlaceholder("Password (12+ characters)").fill(password);
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByText(/Account created/)).toBeVisible();

  await page.getByPlaceholder("Email").last().fill(email);
  await page.getByPlaceholder("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Email verification", { exact: true })).toBeVisible();
  await expect(page.getByText("pending", { exact: true })).toBeVisible();

  const mailboxButton = page.getByRole("button", { name: "Open my Mock Provider mailbox" });
  const verificationLink = page.getByRole("link", { name: "Use one-time verification link" });
  for (let attempt = 0; attempt < 20 && (await verificationLink.count()) === 0; attempt += 1) {
    await mailboxButton.click();
    await page.waitForTimeout(250);
  }
  await expect(verificationLink).toBeVisible();
  const verificationResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/auth/verify-email") &&
      response.request().method() === "POST",
  );
  await verificationLink.click();
  const verificationResponse = await verificationResponsePromise;
  expect(
    verificationResponse.status(),
    `Verification API response: ${await verificationResponse.text()}`,
  ).toBe(200);
  await expect(page.getByText(/Email verification: verified/)).toBeVisible();
  await expect(page.getByText(/Email verified — account is eligible/)).toBeVisible();

  const product = page.locator("article").filter({ hasText: "HKBGP VPS" }).first();
  await product.getByRole("button", { name: /monthly/i }).click();
  const checkoutDialog = page.getByRole("dialog");
  await expect(checkoutDialog.getByRole("heading", { name: "HKBGP VPS" })).toBeVisible();
  await checkoutDialog.getByRole("button", { name: "Configure & order" }).click();

  const journey = page.locator("section.order-panel").filter({ hasText: "Live customer journey" });
  await expect(journey.getByText("waiting payment", { exact: true })).toBeVisible();
  await expect(journey.getByText("pending", { exact: true })).toBeVisible();
  await expect(journey.getByText("Payment fee: $0.18", { exact: true })).toBeVisible();
  await expect(journey.getByText("External amount due: $5.18", { exact: true })).toBeVisible();
  await journey.getByLabel("Payment method", { exact: true }).selectOption("usdt");
  await expect(journey.getByText("Payment fee: $0.00", { exact: true })).toBeVisible();
  await expect(journey.getByText("External amount due: $5.00", { exact: true })).toBeVisible();
  await journey.getByLabel("Payment method", { exact: true }).selectOption("card");
  await expect(journey.getByText("Payment fee: $0.18", { exact: true })).toBeVisible();
  await journey.getByRole("button", { name: "Start mock payment" }).click();

  await expect(journey.getByText("paid", { exact: true })).toBeVisible();
  await expect(journey.getByText("Payment fee charged $0.18", { exact: true })).toBeVisible();
  await expect(journey.getByText("active", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(journey.getByText(/Ready for service:/)).toBeVisible();
  await expect(journey.getByText(/Service term:/)).toBeVisible();

  const addFunds = page.locator('section[aria-label="Add Funds"]');
  await expect(addFunds.getByRole("heading", { name: "Add usable Credit after verified settlement" }))
    .toBeVisible();
  await addFunds.getByLabel("Add Funds principal in cents").fill("5000");
  await addFunds.getByLabel("Add Funds payment method").selectOption("card");
  await expect(addFunds.getByText("Principal added to Credit: $50.00")).toBeVisible();
  await expect(addFunds.getByText("Payment fee: $1.75", { exact: true })).toBeVisible();
  await expect(addFunds.getByText("External amount due: $51.75", { exact: true })).toBeVisible();
  await addFunds.getByRole("button", { name: "Start Mock Add Funds" }).click();
  const addFundsStatus = addFunds.getByTestId("add-funds-status");
  const addFundsCommandStatus = addFundsStatus.getByTestId("status-add-funds");
  await expect(addFundsCommandStatus.getByText("succeeded", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(addFundsStatus.getByText("credited $50.00", { exact: true })).toBeVisible();
  await expect(addFunds.getByText(/Current Credit/)).toContainText("$50.00");
});

test("staff records a manual refund decision and reloads its history", async ({ page }) => {
  const staffEmail = "stage-a-browser-admin@example.invalid";
  const staffPassword = "Synthetic-Stage-A-Browser-Admin-Only!";
  const decisionIdentity = crypto.randomUUID();

  await page.goto("/");
  await page.getByPlaceholder("Email").last().fill(staffEmail);
  await page.getByPlaceholder("Password", { exact: true }).fill(staffPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  const admin = page.locator("section.admin-panel");
  await expect(
    admin.getByText("Administrator · audited billing and fulfillment", { exact: true }),
  ).toBeVisible();
  await admin
    .getByPlaceholder("Re-enter password (15-minute fixed window)")
    .fill(staffPassword);
  await admin.getByLabel("Refund reason").fill(
    `Synthetic browser operator selected no refund for decision ${decisionIdentity}`,
  );

  const candidate = admin.getByTestId("refund-candidate").first();
  await expect(candidate).toBeVisible();
  await candidate.getByRole("button", { name: "Record no refund" }).click();
  await expect(
    page.getByText("The audited no-refund decision was recorded without moving money."),
  ).toBeVisible();

  const latestBeforeReload = admin.getByTestId("refund-status-list").locator("article").first();
  await expect(latestBeforeReload).toContainText("none · $0.00");
  await expect(latestBeforeReload).toContainText("Refund declined");

  await page.reload();
  const latestAfterReload = page
    .locator("section.admin-panel")
    .getByTestId("refund-status-list")
    .locator("article")
    .first();
  await expect(latestAfterReload).toContainText("none · $0.00");
  await expect(latestAfterReload).toContainText("Refund declined");
});

test("staff sees and adjudicates a persisted Provider refund conflict", async ({ page }) => {
  const staffEmail = "stage-a-browser-admin@example.invalid";
  const staffPassword = "Synthetic-Stage-A-Browser-Admin-Only!";

  await page.goto("/");
  await page.getByPlaceholder("Email").last().fill(staffEmail);
  await page.getByPlaceholder("Password", { exact: true }).fill(staffPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  const admin = page.locator("section.admin-panel");
  const holdList = admin.getByTestId("refund-security-hold-list");
  await expect(holdList).toBeVisible();
  await expect(holdList.getByRole("heading", { name: "Provider facts requiring human adjudication" }))
    .toBeVisible();
  const hold = admin.getByTestId("refund-security-hold").first();
  await expect(hold).toContainText("Cash outflow is already isolated in discrepancy suspense");
  await expect(hold.getByRole("button", { name: "Accept authorized outflow" })).toBeVisible();
  await admin
    .getByPlaceholder("Re-enter password (15-minute fixed window)")
    .fill(staffPassword);
  await admin
    .getByLabel("Refund reason")
    .fill("Synthetic browser operator accepted the exact authorized Provider outflow");
  await hold.getByRole("button", { name: "Accept authorized outflow" }).click();
  await expect(
    page.getByText(/Authorized Provider outflow accepted; suspense was reclassified/),
  ).toBeVisible();
  await expect(admin.getByTestId("refund-security-hold")).toHaveCount(0);

  await page.reload();
  await expect(
    page.locator("section.admin-panel").getByTestId("refund-security-hold"),
  ).toHaveCount(0);
});
