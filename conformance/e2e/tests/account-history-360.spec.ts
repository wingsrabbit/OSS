// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test";

test.describe.configure({ retries: 0 });

test("customer returns to complete business history and Staff opens the same Account 360", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const unique = crypto.randomUUID();
  const email = `history-360-${unique}@example.invalid`;
  const password = `Synthetic-${unique}-History!`;
  const clientName = `History 360 ${unique.slice(0, 8)}`;
  const ticketSubject = `History ticket ${unique}`;
  const staffEmail =
    process.env.OSS_E2E_STAFF_EMAIL ?? "stage-a-browser-admin@example.invalid";
  const staffPassword =
    process.env.OSS_E2E_STAFF_PASSWORD ?? "Synthetic-Stage-A-Browser-Admin-Only!";

  await page.goto("/");
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
  const checkout = page.getByRole("dialog");
  await checkout.getByRole("button", { name: "Configure & order" }).click();
  const liveJourney = page.locator("section.order-panel").filter({ hasText: "Live customer journey" });
  await liveJourney.getByLabel("Payment method", { exact: true }).selectOption("usdt");
  await liveJourney.getByRole("button", { name: "Start mock payment" }).click();
  await expect(liveJourney.getByText("active", { exact: true })).toBeVisible({ timeout: 30_000 });

  // Return to the persisted workspace so the support service picker is sourced
  // from the newly activated service rather than its pre-purchase snapshot.
  await page.reload();
  const ticketPanel = page.locator('section[aria-label="Customer support tickets"]');
  await ticketPanel.getByLabel("Ticket subject").fill(ticketSubject);
  await ticketPanel.getByLabel("Related service").selectOption({ index: 1 });
  await ticketPanel.getByLabel("Opening message").fill(
    "Synthetic history journey links this support conversation to the active service.",
  );
  await ticketPanel.getByRole("button", { name: "Create ticket" }).click();
  await expect(ticketPanel.getByTestId("customer-ticket-thread")).toContainText(ticketSubject);

  const history = page.getByTestId("customer-business-history");
  await history.getByRole("button", { name: "Refresh history" }).click();
  await expect(history.getByTestId("history-order")).toHaveCount(1);
  await expect(history.getByTestId("history-invoice")).toHaveCount(1);
  await expect(history.getByTestId("history-payment")).toHaveCount(1);
  await expect(history.getByTestId("history-service")).toHaveCount(1);
  await expect(history.getByTestId("history-ticket")).toContainText(ticketSubject);
  const accountId = ((await history.getByTestId("history-account").locator(".mono").textContent()) ?? "").trim();
  expect(accountId).toMatch(/^[0-9a-f-]{36}$/);

  await history.getByTestId("history-invoice").click();
  const invoiceDetail = history.getByTestId("customer-history-detail");
  await expect(invoiceDetail).toContainText("Invoice detail");
  const downloadPromise = page.waitForEvent("download");
  await invoiceDetail.getByTestId("invoice-pdf-download").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^invoice-[0-9a-f-]{36}\.pdf$/);
  expect(await download.failure()).toBeNull();

  await invoiceDetail.getByRole("button", { name: "Open related service" }).click();
  await expect(history.getByTestId("service-trace")).toContainText(ticketSubject);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("link", { name: "Open customer workspace" }).click();
  await page.getByPlaceholder("Email").last().fill(email);
  await page.getByPlaceholder("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const returningHistory = page.getByTestId("customer-business-history");
  await expect(returningHistory.getByTestId("history-order")).toHaveCount(1);
  await expect(returningHistory.getByTestId("history-invoice")).toHaveCount(1);
  await expect(returningHistory.getByTestId("history-service")).toHaveCount(1);
  await expect(returningHistory.getByTestId("history-ticket")).toContainText(ticketSubject);

  await page.context().clearCookies();
  await page.goto("/admin");
  await page.getByPlaceholder("Staff email").fill(staffEmail);
  await page.getByPlaceholder("Staff password").fill(staffPassword);
  await page.getByRole("button", { name: "Sign in to Staff workspace" }).click();
  const account360 = page.getByTestId("client-account-360");

  for (const searchValue of [email, clientName, accountId]) {
    await account360.getByLabel("Search Client Accounts").fill(searchValue);
    await account360.getByRole("button", { name: "Search accounts" }).click();
    const result = account360
      .getByTestId("account360-search-results")
      .getByRole("button", { name: new RegExp(clientName) });
    await expect(result).toBeVisible();
    if (searchValue === accountId) await result.click();
  }

  await expect(account360.getByRole("heading", { name: clientName })).toBeVisible();
  await expect(account360.getByTestId("account360-memberships")).toContainText(email);
  await expect(account360.getByTestId("account360-orders")).toContainText("HKBGP VPS");
  await expect(account360.getByTestId("account360-billing")).toContainText("Invoices");
  await expect(account360.getByTestId("account360-services")).toContainText("HKBGP VPS");
  await expect(account360.getByTestId("account360-tickets")).toContainText(ticketSubject);
  await expect(account360.locator('section[aria-label="Account Contacts"]')).toBeVisible();
});
