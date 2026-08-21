// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test";

test("customer and staff complete a public ticket conversation while internal notes stay staff-only", async ({
  page,
}) => {
  const unique = crypto.randomUUID();
  const subject = `Synthetic ticket ${unique}`;
  const email = `ticket-browser-${unique}@example.invalid`;
  const password = `Synthetic-${unique}-Ticket!`;
  const internalNote = `Internal synthetic handoff ${unique}`;
  const publicReply = `Public synthetic reply ${unique}`;
  const customerReply = `Customer synthetic follow-up ${unique}`;
  const staffEmail =
    process.env.OSS_E2E_STAFF_EMAIL ?? "stage-a-browser-admin@example.invalid";
  const staffPassword =
    process.env.OSS_E2E_STAFF_PASSWORD ?? "Synthetic-Stage-A-Browser-Admin-Only!";

  await page.goto("/");
  await page.getByPlaceholder("Client account name").fill(`Ticket Browser ${unique.slice(0, 8)}`);
  await page.getByPlaceholder("Email").first().fill(email);
  await page.getByPlaceholder("Password (12+ characters)").fill(password);
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByText(/Account created\. The verification message/)).toBeVisible();
  await page.getByPlaceholder("Email").last().fill(email);
  await page.getByPlaceholder("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/customer$/);

  const mailboxButton = page.getByRole("button", { name: "Open my Mock Provider mailbox" });
  const verificationLink = page.getByRole("link", { name: "Use one-time verification link" });
  for (let attempt = 0; attempt < 20 && (await verificationLink.count()) === 0; attempt += 1) {
    await mailboxButton.click();
    await page.waitForTimeout(250);
  }
  await expect(verificationLink).toBeVisible();
  await verificationLink.click();
  await expect(page).toHaveURL(/\/customer$/);
  await expect(page.getByText(/Email verified — account is eligible/)).toBeVisible();

  const customerPanel = page.locator('section[aria-label="Customer support tickets"]');
  await expect(customerPanel.getByRole("heading", { name: "My support tickets" })).toBeVisible();
  await customerPanel.getByLabel("Ticket subject").fill(subject);
  await customerPanel
    .getByLabel("Opening message")
    .fill("Synthetic browser request in the Mock-only laboratory.");
  await customerPanel.getByRole("button", { name: "Create ticket" }).click();
  await expect(customerPanel.getByTestId("customer-ticket-thread")).toContainText(subject);

  await page.context().clearCookies();
  await page.goto("/");
  await page.getByPlaceholder("Email").last().fill(staffEmail);
  await page
    .getByPlaceholder("Password", { exact: true })
    .fill(staffPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);

  const staffPanel = page.locator('section[aria-label="Staff support tickets"]');
  await expect(staffPanel.getByRole("heading", { name: "Ticket queue" })).toBeVisible();
  await staffPanel.getByRole("button", { name: "Apply filters" }).click();
  await staffPanel.getByTestId("staff-ticket-list").getByRole("button", { name: new RegExp(subject) }).click();
  const staffThread = staffPanel.getByTestId("staff-ticket-thread");
  await expect(staffThread).toContainText(subject);

  await staffPanel.getByLabel("Support password confirmation").fill(staffPassword);
  await staffThread.getByLabel("Staff ticket message").fill(internalNote);
  await staffThread.getByRole("button", { name: "Save internal note" }).click();
  await expect(staffThread.locator('[data-visibility="internal"]')).toContainText(internalNote);

  await staffThread.getByLabel("Staff ticket message").fill(publicReply);
  await staffThread.getByRole("button", { name: "Send public reply" }).click();
  await expect(
    staffThread.locator('[data-visibility="public"]').filter({ hasText: publicReply }),
  ).toHaveCount(1);

  await page.context().clearCookies();
  await page.goto("/");
  await page.getByPlaceholder("Email").last().fill(email);
  await page.getByPlaceholder("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/customer$/);
  const returningCustomerPanel = page.locator('section[aria-label="Customer support tickets"]');
  await returningCustomerPanel
    .getByTestId("customer-ticket-list")
    .getByRole("button", { name: new RegExp(subject) })
    .click();
  const customerThread = returningCustomerPanel.getByTestId("customer-ticket-thread");
  await expect(customerThread).toContainText(publicReply);
  await expect(customerThread).not.toContainText(internalNote);
  await customerThread.getByLabel("Customer ticket reply").fill(customerReply);
  await customerThread.getByRole("button", { name: "Send reply" }).click();
  await expect(customerThread).toContainText(customerReply);
  await expect(customerThread.getByTestId("support-ticket-history")).toContainText(
    "awaiting_customer → awaiting_staff",
  );
});
