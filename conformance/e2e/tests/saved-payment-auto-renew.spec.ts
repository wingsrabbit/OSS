// SPDX-License-Identifier: Apache-2.0

import { createHmac } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { completeCatalogCheckout } from "./helpers/catalog-checkout.js";

// This story creates settled financial and service facts. Retrying in the same
// database would create another customer after the once-per-business-day run
// already exists, so expose the first failure instead of mutating around it.
test.describe.configure({ retries: 0 });

type Renewal = {
  renewalId: string;
  invoiceId: string;
  serviceId: string;
  renewalStatus: "invoiced" | "paid" | "manual_hold" | "cancelled";
  termEnd: string;
  automaticPayment: {
    status: "processing" | "unknown" | "succeeded" | "failed" | "requires_action" | "blocked";
    attemptCount: number;
    maxAttempts: number;
    customerActionRequired: boolean;
  } | null;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Unsupported signed value");
}

function shanghaiBusinessDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

async function runAutomation(request: APIRequestContext, termEnd: string): Promise<void> {
  const secret = process.env.PROVIDER_OPERATION_CAPABILITY_SECRET;
  expect(secret, "billing automation signature secret is required").toBeTruthy();
  for (const daysBeforeTerm of [13, 12, 11, 10, 9, 8, 7, 6, 4, 3, 2, 1]) {
    const candidate = new Date(
      new Date(termEnd).getTime() - daysBeforeTerm * 24 * 60 * 60 * 1_000,
    );
    const businessDate = shanghaiBusinessDate(candidate);
    // Asia/Shanghai has a fixed UTC+08 offset. Run just after the configured
    // 09:00 local boundary so a service activated near local midnight does not
    // accidentally exercise the scheduler's intentional SCHEDULE_NOT_DUE path.
    const effectiveAt = new Date(`${businessDate}T01:05:00.000Z`);
    const body = {
      policyId: "default",
      businessDate,
      effectiveAt: effectiveAt.toISOString(),
    } as const;
    const timestamp = Date.now().toString();
    const signature = createHmac("sha256", secret!)
      .update(`${timestamp}.${canonicalJson(body)}`, "utf8")
      .digest("hex");
    const response = await request.post("/api/v1/internal/billing/automation/run", {
      headers: {
        "X-OSS-Timestamp": timestamp,
        "X-OSS-Signature": signature,
      },
      data: body,
    });
    const responseText = await response.text();
    if (response.status() === 201) return;
    expect(response.status(), responseText).toBe(200);
    const replay = JSON.parse(responseText) as { replayed?: boolean };
    expect(replay.replayed, responseText).toBe(true);
  }
  throw new Error("No fresh eligible Asia/Shanghai billing day remained in the renewal window");
}

async function renewals(page: Page): Promise<Renewal[]> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/billing/renewals");
    if (!response.ok) throw new Error(`renewal list failed with ${response.status}`);
    const body = (await response.json()) as { items: Renewal[] };
    return body.items;
  });
}

async function setProviderScenario(
  request: APIRequestContext,
  sourcePaymentAttemptId: string,
  scenario: "success" | "failed" | "requires_action" | "timeout_success",
): Promise<void> {
  const providerUrl = process.env.MOCK_PAYMENT_PROVIDER_URL;
  const providerToken = process.env.MOCK_PAYMENT_PROVIDER_TOKEN;
  expect(providerUrl).toBeTruthy();
  expect(providerToken).toBeTruthy();
  const response = await request.post(
    new URL(
      `/v1/payments/lab-methods/${sourcePaymentAttemptId}/scenario`,
      providerUrl,
    ).toString(),
    {
      headers: { Authorization: `Bearer ${providerToken}` },
      data: { scenario },
    },
  );
  expect(response.status(), await response.text()).toBe(200);
}

async function providerStats(
  request: APIRequestContext,
  sourcePaymentAttemptId: string,
): Promise<{
  automaticOperations: Array<{
    status: string;
    createCalls: number;
    queryCalls: number;
  }>;
}> {
  const providerUrl = process.env.MOCK_PAYMENT_PROVIDER_URL!;
  const providerToken = process.env.MOCK_PAYMENT_PROVIDER_TOKEN!;
  const response = await request.get(
    new URL(
      `/v1/payments/lab-methods/${sourcePaymentAttemptId}/stats`,
      providerUrl,
    ).toString(),
    { headers: { Authorization: `Bearer ${providerToken}` } },
  );
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

test("saved Provider token and service authorization drive bounded automatic renewal", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const unique = crypto.randomUUID();
  const email = `saved-auto-${unique}@example.invalid`;
  const password = `Synthetic-${unique}-Password!`;

  await page.goto("/");
  await page.getByPlaceholder("Client account name").fill("Synthetic Saved Method Client");
  await page.getByPlaceholder("Email").first().fill(email);
  await page.getByPlaceholder("Password (12+ characters)").fill(password);
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByText(/Account created/)).toBeVisible();
  await page.getByPlaceholder("Email").last().fill(email);
  await page.getByPlaceholder("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  const mailboxButton = page.getByRole("button", { name: "Open my Mock Provider mailbox" });
  const verificationLink = page.getByRole("link", { name: "Use one-time verification link" });
  for (let attempt = 0; attempt < 30 && (await verificationLink.count()) === 0; attempt += 1) {
    await mailboxButton.click();
    await page.waitForTimeout(250);
  }
  await verificationLink.click();
  await expect(page.getByText(/Email verified — account is eligible/)).toBeVisible();

  const product = page.locator("article").filter({ hasText: "HKBGP VPS" }).first();
  await product.getByRole("button", { name: /monthly/i }).click();
  await completeCatalogCheckout(page.getByRole("dialog"));
  const journey = page.locator("section.order-panel").filter({ hasText: "Live customer journey" });
  await journey.getByTestId("save-payment-method-consent").check();
  await expect(journey.getByTestId("enable-auto-renew-consent")).not.toBeChecked();
  await journey.getByTestId("checkout-payment-settings-password").fill(password);
  const initialPaymentResponse = page.waitForResponse(
    (response) =>
      /\/api\/v1\/invoices\/[0-9a-f-]+\/payments$/.test(response.url()) &&
      response.request().method() === "POST",
  );
  await journey.getByRole("button", { name: "Start mock payment" }).click();
  const initialPayment = await initialPaymentResponse;
  const initialPaymentBody = (await initialPayment.json()) as { paymentAttemptId: string };
  expect(initialPayment.status(), JSON.stringify(initialPaymentBody)).toBe(202);
  expect(initialPaymentBody.paymentAttemptId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(journey.getByText("active", { exact: true })).toBeVisible({ timeout: 30_000 });
  const savedMethod = page.getByTestId("saved-payment-method").filter({ hasText: "4242" });
  await expect(savedMethod).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("automatic-renewal-authorizations")).not.toContainText(
    "automatic renewal active",
  );

  const initialDetail = await page.evaluate(async () => {
    const orders = (await (await fetch("/api/v1/orders")).json()) as {
      items: Array<{ orderId: string }>;
    };
    return (await (
      await fetch(`/api/v1/orders/${orders.items[0]!.orderId}`)
    ).json()) as { service: { termEnd: string } };
  });
  await runAutomation(request, initialDetail.service.termEnd);
  let firstRenewal = (await renewals(page))[0]!;
  expect(firstRenewal.renewalStatus).toBe("invoiced");
  expect(firstRenewal.automaticPayment).toBeNull();

  await page.reload();
  let renewalCard = page
    .getByTestId("renewal-item")
    .filter({ hasText: firstRenewal.invoiceId });
  await renewalCard.getByRole("button", { name: "Pay renewal with Mock Provider" }).click();
  await expect(renewalCard).toContainText("term grant paid", { timeout: 30_000 });

  const settings = page.locator('section[aria-label="Payment methods and automatic renewal"]');
  if ((await settings.getByTestId("payment-settings-password").count()) > 0) {
    await settings.getByTestId("payment-settings-password").fill(password);
  } else {
    await expect(settings.getByTestId("payment-settings-reauth-active")).toBeVisible();
  }
  await savedMethod
    .getByRole("button", { name: "Enable automatic renewal for current service" })
    .click();
  await expect(settings).toContainText("automatic renewal active");

  await setProviderScenario(request, initialPaymentBody.paymentAttemptId, "timeout_success");
  const afterFirstPayment = (await renewals(page))[0]!;
  await runAutomation(request, afterFirstPayment.termEnd);
  await expect
    .poll(async () => (await renewals(page))[0]?.automaticPayment?.status, {
      timeout: 30_000,
    })
    .toBe("succeeded");
  const timeoutStats = await providerStats(request, initialPaymentBody.paymentAttemptId);
  expect(timeoutStats.automaticOperations).toHaveLength(1);
  expect(timeoutStats.automaticOperations[0]).toMatchObject({ createCalls: 1 });
  expect(timeoutStats.automaticOperations[0]!.queryCalls).toBeGreaterThanOrEqual(1);

  await setProviderScenario(request, initialPaymentBody.paymentAttemptId, "requires_action");
  const afterTimeoutRenewal = (await renewals(page))[0]!;
  await runAutomation(request, afterTimeoutRenewal.termEnd);
  await expect
    .poll(async () => (await renewals(page))[0]?.automaticPayment, { timeout: 30_000 })
    .toMatchObject({
      status: "requires_action",
      attemptCount: 1,
      maxAttempts: 1,
      customerActionRequired: true,
    });
  await page.reload();
  const actionRenewal = (await renewals(page))[0]!;
  renewalCard = page.getByTestId("renewal-item").filter({ hasText: actionRenewal.invoiceId });
  await expect(renewalCard.getByTestId("renewal-automatic-payment-status")).toContainText(
    "background retries stopped",
  );
  await page.waitForTimeout(2_500);
  const actionStats = await providerStats(request, initialPaymentBody.paymentAttemptId);
  expect(actionStats.automaticOperations).toHaveLength(2);
  expect(actionStats.automaticOperations.every((operation) => operation.createCalls === 1)).toBe(true);

  await renewalCard.getByRole("button", { name: "Pay renewal with Mock Provider" }).click();
  await expect(renewalCard).toContainText("term grant paid", { timeout: 30_000 });
  const activeAuthorization = page
    .getByTestId("automatic-renewal-authorizations")
    .locator("article")
    .filter({ hasText: "automatic renewal active" });
  if ((await settings.getByTestId("payment-settings-password").count()) > 0) {
    await settings.getByTestId("payment-settings-password").fill(password);
  }
  await activeAuthorization.getByRole("button", { name: "Revoke automatic renewal" }).click();
  await expect(activeAuthorization).toHaveCount(0);

  const afterManualAction = (await renewals(page))[0]!;
  await runAutomation(request, afterManualAction.termEnd);
  const afterRevocation = (await renewals(page))[0]!;
  expect(afterRevocation.renewalStatus).toBe("invoiced");
  expect(afterRevocation.automaticPayment).toBeNull();
  await page.waitForTimeout(1_500);
  const finalStats = await providerStats(request, initialPaymentBody.paymentAttemptId);
  expect(finalStats.automaticOperations).toHaveLength(2);
});
