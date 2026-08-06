// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test";

test("unverified customer verifies, pays, reaches Ready for Service, and sees Add Funds Chargeback debt", async ({
  page,
  request,
}) => {
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
  const addFundsStart = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/billing/add-funds") &&
      response.request().method() === "POST",
  );
  await addFunds.getByRole("button", { name: "Start Mock Add Funds" }).click();
  const addFundsStartResponse = await addFundsStart;
  expect(addFundsStartResponse.status()).toBe(202);
  const addFundsStartBody = (await addFundsStartResponse.json()) as {
    providerOperationId?: string;
  };
  expect(addFundsStartBody.providerOperationId).toMatch(/^[0-9a-f-]{36}$/);
  const addFundsStatus = addFunds.getByTestId("add-funds-status");
  const addFundsCommandStatus = addFundsStatus.getByTestId("status-add-funds");
  await expect(addFundsCommandStatus.getByText("succeeded", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(addFundsStatus.getByText("credited $50.00", { exact: true })).toBeVisible();
  await expect(addFunds.getByText(/Current Credit/)).toContainText("$50.00");

  await product.getByRole("button", { name: /monthly/i }).click();
  await expect(checkoutDialog.getByRole("heading", { name: "HKBGP VPS" })).toBeVisible();
  await checkoutDialog.getByRole("button", { name: "Configure & order" }).click();
  await expect(journey.getByText("Credit this payment: $5.00", { exact: true })).toBeVisible();
  await expect(journey.getByText("External amount due: $0.00", { exact: true })).toBeVisible();
  await journey.getByRole("button", { name: "Start mock payment" }).click();
  await expect(journey.getByText("paid", { exact: true })).toBeVisible();
  await expect(journey.getByText("active", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(addFunds.getByText(/Current Credit/)).toContainText("$45.00");

  const providerUrl = process.env.MOCK_PAYMENT_PROVIDER_URL ?? "http://127.0.0.1:4000";
  const providerToken = process.env.MOCK_PAYMENT_PROVIDER_TOKEN;
  expect(providerToken, "The browser Chargeback journey requires the synthetic Provider token")
    .toBeTruthy();
  const chargebackRequestId = crypto.randomUUID();
  const chargebackResponse = await request.post(
    new URL(
      `/v1/payments/${addFundsStartBody.providerOperationId}/chargebacks`,
      providerUrl,
    ).toString(),
    {
      headers: {
        Authorization: `Bearer ${providerToken}`,
        "Idempotency-Key": chargebackRequestId,
      },
      data: { requestId: chargebackRequestId, scenario: "duplicate" },
    },
  );
  expect(chargebackResponse.status(), await chargebackResponse.text()).toBe(202);

  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const response = await fetch("/api/v1/billing/chargeback-status");
          if (!response.ok) return null;
          return response.json() as Promise<{
            restricted: boolean;
            creditBalanceMinor: string;
            debtBalanceMinor: string;
            chargebacks: unknown[];
          }>;
        }),
      { timeout: 30_000 },
    )
    .toMatchObject({
      restricted: true,
      creditBalanceMinor: "0",
      debtBalanceMinor: "500",
      chargebacks: [{}],
    });

  await page.reload();
  const chargebackStatus = page.locator('section[aria-label="Chargeback account status"]');
  await expect(
    chargebackStatus.getByRole("heading", {
      name: "Client Account restricted after Chargeback",
    }),
  ).toBeVisible();
  await expect(chargebackStatus).toContainText("Available Credit $0.00");
  await expect(chargebackStatus).toContainText("outstanding Chargeback debt $5.00");
  const chargeback = chargebackStatus.getByTestId("customer-chargeback");
  await expect(chargeback).toHaveCount(1);
  await expect(chargeback).toContainText("External loss $51.75 · debt $5.00");
  await expect(chargeback).toContainText("Credit recovered $45.00 · original fee reversed $1.75");
  await expect(chargeback).toContainText("Account restriction: active");
});

test("staff sees the affected Client Account Chargeback and its exact recovery split", async ({
  page,
}) => {
  const staffEmail = "stage-a-browser-admin@example.invalid";
  const staffPassword = "Synthetic-Stage-A-Browser-Admin-Only!";

  await page.goto("/");
  await page.getByPlaceholder("Email").last().fill(staffEmail);
  await page.getByPlaceholder("Password", { exact: true }).fill(staffPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  const admin = page.locator("section.admin-panel");
  const chargebackPanel = admin.locator('div[aria-label="Add Funds Chargebacks"]');
  await expect(chargebackPanel.getByRole("heading", { name: "Add Funds Chargebacks" }))
    .toBeVisible();
  await chargebackPanel.getByRole("button", { name: "Refresh Chargebacks" }).click();
  const chargeback = chargebackPanel
    .getByTestId("admin-chargeback")
    .filter({ hasText: "Synthetic Browser Client" })
    .last();
  await expect(chargeback).toContainText("external loss $51.75");
  await expect(chargeback).toContainText(
    "Credit recovered $45.00 · debt $5.00 · fee reversal $1.75",
  );
  await expect(chargeback).toContainText("Client Account restriction: active");
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

  const noRefundDecisions = admin
    .getByTestId("refund-status")
    .filter({ hasText: "none · $0.00" })
    .filter({ hasText: "Refund declined" });
  const noRefundCountBefore = await noRefundDecisions.count();
  const candidate = admin.getByTestId("refund-candidate").first();
  await expect(candidate).toBeVisible();
  await candidate.getByRole("button", { name: "Record no refund" }).click();
  await expect(
    page.getByText("The audited no-refund decision was recorded without moving money."),
  ).toBeVisible();

  await expect.poll(() => noRefundDecisions.count()).toBe(noRefundCountBefore + 1);

  await page.reload();
  const persistedNoRefundDecisions = page
    .locator("section.admin-panel")
    .getByTestId("refund-status")
    .filter({ hasText: "none · $0.00" })
    .filter({ hasText: "Refund declined" });
  await expect(persistedNoRefundDecisions).toHaveCount(noRefundCountBefore + 1);
});

test("staff returns unclaimed funds to the immutable original payment", async ({ page }) => {
  const staffEmail = "stage-a-browser-admin@example.invalid";
  const staffPassword = "Synthetic-Stage-A-Browser-Admin-Only!";

  await page.goto("/");
  await page.getByPlaceholder("Email").last().fill(staffEmail);
  await page.getByPlaceholder("Password", { exact: true }).fill(staffPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  const admin = page.locator("section.admin-panel");
  const receipt = admin
    .getByTestId("unclaimed-fund-item")
    .filter({ hasText: "Synthetic browser return-ready unclaimed receipt" });
  await expect(receipt).toHaveCount(1);
  const receiptId = await receipt.getAttribute("data-receipt-id");
  expect(receiptId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(receipt).toContainText("Received $");
  await expect(receipt).toContainText("Allocated $");
  await expect(receipt).toContainText("pending return $");
  await expect(receipt).toContainText("confirmed returned $");
  await expect(receipt).toContainText("actionable $");

  await admin.getByLabel("Unclaimed funds return amount mode").selectOption("full");
  await admin.getByLabel("Unclaimed funds refund Provider scenario").selectOption("success");
  await admin
    .getByLabel("Unclaimed funds return reason")
    .fill("Synthetic browser operator returns all actionable liability to its original payment");
  await admin
    .getByPlaceholder("Re-enter password (15-minute fixed window)")
    .fill(staffPassword);
  await receipt.getByRole("button", { name: "Return to original payment" }).click();
  await expect(
    page.getByText(
      "Return to the original payment requested. Funds remain reserved until the Provider result is known.",
    ),
  ).toBeVisible();

  const history = admin
    .getByTestId("refund-status")
    .filter({ hasText: `Unclaimed receipt ${receiptId}` })
    .first();
  await expect(history).toContainText("Refund succeeded", { timeout: 35_000 });
  await expect(history).toContainText("Provider succeeded");
  await expect(receipt).toHaveCount(0);

  await page.reload();
  const persistedHistory = page
    .locator("section.admin-panel")
    .getByTestId("refund-status")
    .filter({ hasText: `Unclaimed receipt ${receiptId}` })
    .first();
  await expect(persistedHistory).toContainText("Refund succeeded");
  await expect(
    page
      .locator("section.admin-panel")
      .getByTestId("unclaimed-fund-item")
      .filter({ hasText: "Synthetic browser return-ready unclaimed receipt" }),
  ).toHaveCount(0);
});

test("staff completes partial failure, full original, and Credit refund page journeys", async ({
  page,
}) => {
  const staffEmail = "stage-a-browser-admin@example.invalid";
  const staffPassword = "Synthetic-Stage-A-Browser-Admin-Only!";
  await page.goto("/");
  await page.getByPlaceholder("Email").last().fill(staffEmail);
  await page.getByPlaceholder("Password", { exact: true }).fill(staffPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  const admin = page.locator("section.admin-panel");
  const passwordInput = admin.getByPlaceholder("Re-enter password (15-minute fixed window)");
  const reasonInput = admin.getByLabel("Refund reason");
  await admin.getByLabel("Refund amount mode", { exact: true }).selectOption("partial");
  await admin.getByLabel("Refund amount in cents", { exact: true }).fill("11");
  await admin.getByLabel("Refund Provider scenario", { exact: true }).selectOption("failed");
  await passwordInput.fill(staffPassword);
  await reasonInput.fill("Synthetic browser verifies a partial original-payment refund failure");
  await admin
    .getByTestId("refund-candidate")
    .first()
    .getByRole("button", { name: "Refund original payment" })
    .click();
  await expect(passwordInput).toHaveValue("");
  const failedRefund = admin
    .getByTestId("refund-status")
    .filter({ hasText: "original payment · $0.11" })
    .first();
  await expect(failedRefund).toContainText("Refund failed", { timeout: 35_000 });

  await admin.getByLabel("Refund amount mode", { exact: true }).selectOption("full");
  await admin.getByLabel("Refund Provider scenario", { exact: true }).selectOption("success");
  await passwordInput.fill(staffPassword);
  await reasonInput.fill("Synthetic browser verifies a full original-payment refund success");
  const fullCandidate = admin.getByTestId("refund-candidate").first();
  const fullRefundableText = await fullCandidate.locator("strong").textContent();
  const fullAmount = fullRefundableText?.match(/refundable (\$[0-9.]+)/)?.[1];
  expect(fullAmount).toBeTruthy();
  const fullStatuses = admin
    .getByTestId("refund-status")
    .filter({ hasText: `original payment · ${fullAmount}` });
  const fullStatusCount = await fullStatuses.count();
  await fullCandidate.getByRole("button", { name: "Refund original payment" }).click();
  await expect(passwordInput).toHaveValue("");
  await expect.poll(() => fullStatuses.count(), { timeout: 35_000 }).toBe(fullStatusCount + 1);
  await expect(fullStatuses.first()).toContainText("Refund succeeded", { timeout: 35_000 });

  await passwordInput.fill(staffPassword);
  await reasonInput.fill("Synthetic browser verifies a full refund into customer Credit");
  const creditCandidate = admin.getByTestId("refund-candidate").first();
  const creditRefundableText = await creditCandidate.locator("strong").textContent();
  const creditAmount = creditRefundableText?.match(/refundable (\$[0-9.]+)/)?.[1];
  expect(creditAmount).toBeTruthy();
  const creditStatuses = admin
    .getByTestId("refund-status")
    .filter({ hasText: `credit · ${creditAmount}` });
  const creditStatusCount = await creditStatuses.count();
  await creditCandidate.getByRole("button", { name: "Refund to Credit" }).click();
  await expect(passwordInput).toHaveValue("");
  await expect.poll(() => creditStatuses.count()).toBe(creditStatusCount + 1);
  await expect(creditStatuses.first()).toContainText("Refund succeeded");
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
  const acceptedExternalId = (await hold.locator("span.mono").first().textContent())?.split(" · ")[0];
  expect(acceptedExternalId).toBeTruthy();
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
  await expect(
    admin.getByTestId("refund-security-hold").filter({ hasText: acceptedExternalId! }),
  ).toHaveCount(0);

  await page.reload();
  await expect(
    page
      .locator("section.admin-panel")
      .getByTestId("refund-security-hold")
      .filter({ hasText: acceptedExternalId! }),
  ).toHaveCount(0);
});

test("staff dismisses then corrects a later-confirmed Provider outflow", async ({ page }) => {
  const staffEmail = "stage-a-browser-admin@example.invalid";
  const staffPassword = "Synthetic-Stage-A-Browser-Admin-Only!";
  await page.goto("/");
  await page.getByPlaceholder("Email").last().fill(staffEmail);
  await page.getByPlaceholder("Password", { exact: true }).fill(staffPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  const admin = page.locator("section.admin-panel");
  const passwordInput = admin.getByPlaceholder("Re-enter password (15-minute fixed window)");
  const reasonInput = admin.getByLabel("Refund reason");
  const dismissalFactMarker = "mock-refund-browser-dismissal-correction:";
  const exactHold = admin
    .getByTestId("refund-security-hold")
    .filter({ hasText: dismissalFactMarker })
    .filter({ has: page.getByRole("button", { name: "Accept authorized outflow" }) })
    .first();
  await expect(exactHold).toBeVisible();
  await passwordInput.fill(staffPassword);
  await reasonInput.fill("Synthetic browser dismisses the Provider claim pending later evidence");
  await exactHold.getByRole("button", { name: "Dismiss Provider claim" }).click();
  await expect(page.getByText(/Provider claim dismissed; immutable evidence remains/)).toBeVisible();
  await expect(passwordInput).toHaveValue("");

  const correction = admin
    .getByTestId("refund-dismissal-correction")
    .filter({ hasText: dismissalFactMarker });
  await expect(correction).toBeVisible();
  await passwordInput.fill(staffPassword);
  await reasonInput.fill("Synthetic browser later confirms the dismissed Provider cash outflow");
  await correction
    .getByRole("button", { name: "Confirm later evidence of outflow" })
    .click();
  await expect(
    page.getByText(/later-confirmed Provider outflow was restored to discrepancy suspense/),
  ).toBeVisible();
  await expect(passwordInput).toHaveValue("");
  await expect(
    admin.getByTestId("refund-dismissal-correction").filter({ hasText: dismissalFactMarker }),
  ).toHaveCount(0);
  const correctedRefund = admin
    .getByTestId("refund-status")
    .filter({ hasText: dismissalFactMarker });
  await expect(correctedRefund).toContainText("Refund failed · Provider succeeded");
  await expect(correctedRefund).toContainText(
    "A dismissed Provider outflow was later confirmed",
  );
});

test("staff owns a callback-first receipt overage without hiding recovery", async ({
  page,
}) => {
  const staffEmail = "stage-a-browser-admin@example.invalid";
  const staffPassword = "Synthetic-Stage-A-Browser-Admin-Only!";
  await page.goto("/");
  await page.getByPlaceholder("Email").last().fill(staffEmail);
  await page.getByPlaceholder("Password", { exact: true }).fill(staffPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  const admin = page.locator("section.admin-panel");
  const allocatedLateIncident = admin
    .getByTestId("refund-receipt-capacity-incident")
    .filter({ hasText: "allocated/Credit contribution" })
    .last();
  await expect(allocatedLateIncident).toBeVisible();
  await expect(allocatedLateIncident).toContainText("confirmed total disposition");
  await expect(allocatedLateIncident).toContainText("Provider outflow");
  await expect(allocatedLateIncident).toContainText("manual recovery");
  const historicalIncident = admin
    .getByTestId("refund-receipt-capacity-incident")
    .filter({ hasText: "receipt overage $0.25" });
  await expect(historicalIncident).toBeVisible();
  await expect(historicalIncident).toContainText("superseded history");
  await expect(historicalIncident).toContainText(
    "Do not add this amount to the current receipt overage",
  );
  await expect(
    historicalIncident.getByRole("button", {
      name: "Acknowledge and take manual recovery",
    }),
  ).toHaveCount(0);
  const incident = admin
    .getByTestId("refund-receipt-capacity-incident")
    .filter({ hasText: "receipt overage $0.32" });
  await expect(incident).toBeVisible();
  await expect(incident).toContainText("receipt overage $0.32");
  await expect(incident).toContainText("confirmed total disposition");
  await expect(incident).toContainText(
    "current cumulative receipt overage",
  );
  await admin
    .getByPlaceholder("Re-enter password (15-minute fixed window)")
    .fill(staffPassword);
  await admin
    .getByLabel("Refund reason")
    .fill("Synthetic browser operator accepts manual recovery of the real receipt overage");
  await incident
    .getByRole("button", { name: "Acknowledge and take manual recovery" })
    .click();
  await expect(
    page.getByText(/Receipt overage acknowledged; manual financial recovery remains outstanding/),
  ).toBeVisible();
  await expect(incident).toContainText("acknowledged recovery outstanding");
  await expect(incident).toContainText("Manual recovery remains outstanding");
  await expect(
    incident.getByRole("button", { name: "Acknowledge and take manual recovery" }),
  ).toHaveCount(0);

  await page.reload();
  const persistedIncident = page
    .locator("section.admin-panel")
    .getByTestId("refund-receipt-capacity-incident")
    .filter({ hasText: "receipt overage $0.32" });
  await expect(persistedIncident).toContainText("acknowledged recovery outstanding");
  await expect(persistedIncident).toContainText("Manual recovery remains outstanding");
});

test("staff records a verified unexpected Provider outflow without settling the refund", async ({
  page,
}) => {
  const staffEmail = "stage-a-browser-admin@example.invalid";
  const staffPassword = "Synthetic-Stage-A-Browser-Admin-Only!";
  await page.goto("/");
  await page.getByPlaceholder("Email").last().fill(staffEmail);
  await page.getByPlaceholder("Password", { exact: true }).fill(staffPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  const admin = page.locator("section.admin-panel");
  const unexpectedHold = admin
    .getByTestId("refund-security-hold")
    .filter({ hasText: "No automatic financial posting was made for this claim." })
    .filter({ has: page.getByRole("button", { name: "Record verified unexpected outflow" }) })
    .first();
  await expect(unexpectedHold).toContainText("EUR");
  await admin
    .getByPlaceholder("Re-enter password (15-minute fixed window)")
    .fill(staffPassword);
  await admin
    .getByLabel("Refund reason")
    .fill("Synthetic browser verifies the unexpected wrong-currency Provider outflow");
  await unexpectedHold
    .getByRole("button", { name: "Record verified unexpected outflow" })
    .click();
  await expect(
    page.getByText(/Verified unexpected Provider outflow recorded in suspense/),
  ).toBeVisible();
});

test("staff retries an exhausted refund with a Provider query only", async ({ page }) => {
  const staffEmail = "stage-a-browser-admin@example.invalid";
  const staffPassword = "Synthetic-Stage-A-Browser-Admin-Only!";

  await page.goto("/");
  await page.getByPlaceholder("Email").last().fill(staffEmail);
  await page.getByPlaceholder("Password", { exact: true }).fill(staffPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  const admin = page.locator("section.admin-panel");
  await admin
    .getByPlaceholder("Re-enter password (15-minute fixed window)")
    .fill(staffPassword);
  await admin
    .getByLabel("Refund reason")
    .fill("Synthetic browser operator retried the exhausted Provider query only");
  const manualRefund = admin
    .getByTestId("refund-status")
    .filter({ hasText: "Refund manual" })
    .filter({ has: page.getByRole("button", { name: "Retry Provider query only" }) })
    .first();
  await expect(manualRefund).toBeVisible();
  await manualRefund.getByRole("button", { name: "Retry Provider query only" }).click();
  await expect(
    page.getByText(/Query-only Provider reconciliation scheduled/),
  ).toBeVisible();
});

test("staff confirms no outflow for an exhausted manual refund", async ({ page }) => {
  const staffEmail = "stage-a-browser-admin@example.invalid";
  const staffPassword = "Synthetic-Stage-A-Browser-Admin-Only!";
  await page.goto("/");
  await page.getByPlaceholder("Email").last().fill(staffEmail);
  await page.getByPlaceholder("Password", { exact: true }).fill(staffPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  const admin = page.locator("section.admin-panel");
  const passwordInput = admin.getByPlaceholder("Re-enter password (15-minute fixed window)");
  await passwordInput.fill(staffPassword);
  await admin
    .getByLabel("Refund reason")
    .fill("Synthetic browser confirms the exhausted request never caused Provider outflow");
  const manualRefund = admin
    .getByTestId("refund-status")
    .filter({ hasText: "Refund manual" })
    .filter({ has: page.getByRole("button", { name: "Confirm no Provider outflow" }) })
    .first();
  await expect(manualRefund).toBeVisible();
  await manualRefund.getByRole("button", { name: "Confirm no Provider outflow" }).click();
  await expect(
    page.getByText(/No Provider outflow was confirmed with an audited reason/),
  ).toBeVisible();
  await expect(passwordInput).toHaveValue("");
});
