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

  const journey = page.locator(".order-panel");
  await expect(journey.getByText("waiting payment", { exact: true })).toBeVisible();
  await expect(journey.getByText("pending", { exact: true })).toBeVisible();
  await journey.getByRole("button", { name: "Start mock payment" }).click();

  await expect(journey.getByText("paid", { exact: true })).toBeVisible();
  await expect(journey.getByText("active", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(journey.getByText(/Ready for service:/)).toBeVisible();
  await expect(journey.getByText(/Service term:/)).toBeVisible();
});
