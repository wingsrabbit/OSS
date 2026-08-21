// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Route } from "@playwright/test";
import {
  fulfillNotificationInterfaceRequest,
  notificationPreferencesMockState,
} from "./helpers/notification-interfaces.js";

const clientAccountId = "00000000-0000-4000-8000-000000002101";
const userId = "00000000-0000-4000-8000-000000002102";
const priceId = "00000000-0000-4000-8000-000000002103";
const termsDocumentId = "00000000-0000-4000-8000-000000002104";
const aupDocumentId = "00000000-0000-4000-8000-000000002105";
const orderId = "00000000-0000-4000-8000-000000002106";
const invoiceId = "00000000-0000-4000-8000-000000002107";
const serviceId = "00000000-0000-4000-8000-000000002108";
const contextHeaders = {
  "X-OSS-Account-Context-Version": "1",
  "X-OSS-Client-Account-Id": clientAccountId,
  "X-OSS-Authorization-Epoch": "1",
};

function fulfillAccount(route: Route, json: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, headers: contextHeaders, json });
}

test("generic configurable Checkout previews exact pricing and keeps its one-time field local", async ({
  page,
}) => {
  const oneTimeValue = "Synthetic-one-time-value";
  const passwordValue = "Synthetic-console-password";
  const hostnameValue = "demo.customer.invalid";
  const notesValue = "Install during the agreed laboratory window.";
  let previewPayload: Record<string, unknown> | null = null;
  let orderPayload: Record<string, unknown> | null = null;
  let orderCreated = false;
  const notificationPreferences = notificationPreferencesMockState();

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (await fulfillNotificationInterfaceRequest(route, {
      customerPreferences: true,
      adminTemplates: false,
      preferenceState: notificationPreferences,
      headers: contextHeaders,
    })) return;

    if (path === "/api/v1/auth/me") {
      await fulfillAccount(route, {
        id: userId,
        email: "catalog-browser@example.invalid",
        locale: "en",
        clientAccountId,
        membershipRole: "owner",
        accountContextVersion: "1",
        context: {
          clientAccountId,
          name: "Catalog browser account",
          role: "owner",
          permissions: [],
          capabilities: ["orders.create"],
          version: "1",
        },
        verification: { email: "passed" },
        restrictions: { user: false, clientAccount: false },
        eligible: true,
        staff: null,
      });
      return;
    }
    if (path === "/api/v1/auth/account-contexts") {
      await fulfillAccount(route, {
        activeClientAccountId: clientAccountId,
        accountContextVersion: "1",
        items: [{
          clientAccountId,
          name: "Catalog browser account",
          role: "owner",
          permissions: [],
          capabilities: ["orders.create"],
          restrictions: { membership: false, clientAccount: false },
        }],
        limit: 25,
        hasMore: false,
        nextCursor: null,
      });
      return;
    }
    if (path === "/api/v1/catalog" && request.method() === "GET") {
      await route.fulfill({ json: {
        locale: "en",
        currency: "USD",
        products: [{
          id: "generic-configurable-plan",
          groupId: "mock-plans",
          groupName: "Mock plans",
          name: "Generic configurable plan",
          description: "Synthetic configurable product for normal Checkout behavior.",
          fulfillmentMode: "automatic",
          repeatable: false,
          optionSchema: [
            {
              code: "tier",
              type: "select",
              label: { en: "Service tier", "zh-CN": "服务等级" },
              required: true,
              values: [
                { value: "basic", label: { en: "Basic", "zh-CN": "基础" } },
                {
                  value: "pro",
                  label: { en: "Professional", "zh-CN": "专业" },
                  recurringMinor: 500,
                },
              ],
            },
            {
              code: "units",
              type: "quantity",
              label: { en: "Units", "zh-CN": "数量" },
              required: true,
              min: 1,
              max: 5,
              step: 1,
              recurringUnitMinor: 200,
              dependencies: { basic: { min: 1, max: 5 }, pro: { min: 2, max: 4 } },
            },
            {
              code: "support_window",
              type: "radio",
              label: { en: "Support window", "zh-CN": "支持时段" },
              required: true,
              values: [
                { value: "standard", label: { en: "Standard", "zh-CN": "标准" } },
                { value: "priority", label: { en: "Priority", "zh-CN": "优先" } },
              ],
            },
            {
              code: "service_hostname",
              type: "text",
              label: { en: "Service hostname", "zh-CN": "服务主机名" },
              required: true,
              minLength: 3,
              maxLength: 120,
              dependsOn: { optionCode: "tier", in: ["pro"] },
            },
            {
              code: "bootstrap_secret",
              type: "secret",
              label: { en: "Initial access phrase", "zh-CN": "初始访问短语" },
              required: true,
              minLength: 8,
              maxLength: 80,
              visibleWhen: { code: "tier", equals: "pro" },
            },
            {
              code: "console_password",
              type: "password",
              label: { en: "Console password", "zh-CN": "控制台密码" },
              required: true,
              minLength: 8,
              maxLength: 80,
              visibleWhen: { code: "support_window", equals: "priority" },
            },
            {
              code: "implementation_notes",
              type: "textarea",
              label: { en: "Implementation notes", "zh-CN": "实施备注" },
              required: true,
              minLength: 10,
              maxLength: 500,
              dependsOn: { code: "tier", equals: "pro" },
            },
          ],
          prices: [{
            id: priceId,
            revision: 3,
            productRevisionId: "00000000-0000-4000-8000-000000002109",
            productRevision: 4,
            currency: "USD",
            billingCycle: "monthly",
            oneTimeMinor: "0",
            setupMinor: "100",
            recurringMinor: "1000",
          }],
          purchasable: true,
        }],
      } });
      return;
    }
    if (path === "/api/v1/legal/current") {
      const common = { revision: "1", locale: "en" as const };
      await route.fulfill({ json: {
        requestedLocale: "en",
        documents: {
          terms: {
            ...common,
            id: termsDocumentId,
            documentId: termsDocumentId,
            version: "terms-v1",
            title: "Mock Terms",
            body: "Synthetic laboratory terms.",
          },
          aup: {
            ...common,
            id: aupDocumentId,
            documentId: aupDocumentId,
            version: "aup-v1",
            title: "Mock AUP",
            body: "Synthetic laboratory acceptable use policy.",
          },
          privacy: {
            ...common,
            id: "00000000-0000-4000-8000-000000002110",
            documentId: "00000000-0000-4000-8000-000000002110",
            version: "privacy-v1",
            title: "Mock Privacy",
            body: "Synthetic laboratory privacy text.",
          },
        },
      } });
      return;
    }
    if (path === "/api/v1/catalog/preview" && request.method() === "POST") {
      previewPayload = request.postDataJSON() as Record<string, unknown>;
      expect(previewPayload).toEqual({
        priceId,
        configuration: {
          tier: "pro",
          units: 2,
          support_window: "priority",
          service_hostname: hostnameValue,
          bootstrap_secret: oneTimeValue,
          console_password: passwordValue,
          implementation_notes: notesValue,
        },
        promotionCode: "SAVE10",
      });
      await fulfillAccount(route, {
        configuration: {
          tier: "pro",
          units: 2,
          bootstrap_secret: { provided: true },
        },
        price: {
          currency: "USD",
          billingCycle: "monthly",
          productRevision: 4,
          priceRevision: 3,
          oneTimeSubtotalMinor: "0",
          setupMinor: "100",
          recurringSubtotalMinor: "1700",
          invoiceTotalMinor: "1800",
          grossInvoiceTotalMinor: "2000",
          components: [
            { code: "base", label: "Generic configurable plan", quantity: 1, oneTimeMinor: "0", recurringMinor: "1000" },
            { code: "tier:pro", label: "tier: pro", quantity: 1, oneTimeMinor: "0", recurringMinor: "500" },
            { code: "units", label: "units", quantity: 2, oneTimeMinor: "0", recurringMinor: "200" },
          ],
          promotion: {
            code: "SAVE10",
            revision: 1,
            oneTimeDiscountMinor: "0",
            recurringDiscountMinor: "200",
          },
          supply: {
            mode: "tracked",
            units: "3",
            availableUnits: "20",
            committedUnits: "5",
            version: "2",
          },
        },
      });
      return;
    }
    if (path === "/api/v1/orders" && request.method() === "POST") {
      orderPayload = request.postDataJSON() as Record<string, unknown>;
      orderCreated = true;
      await fulfillAccount(route, { orderId, invoiceId, serviceId, orderStatus: "waiting_payment" }, 201);
      return;
    }
    if (path === `/api/v1/orders/${orderId}`) {
      await fulfillAccount(route, {
        order: { id: orderId, status: "waiting_payment", price: { productName: "Generic configurable plan", billingCycle: "monthly" } },
        invoice: {
          id: invoiceId,
          currency: "USD",
          totalMinor: "1800",
          allocatedMinor: "0",
          paymentAllocatedMinor: "0",
          creditAppliedMinor: "0",
          paymentFeeMinor: "0",
          dueMinor: "1800",
          status: "open",
        },
        payment: { status: null },
        provisioning: { status: null },
        service: {
          id: serviceId,
          status: "pending",
          activatedAt: null,
          termStart: null,
          termEnd: null,
          version: 1,
          cancellation: null,
        },
      });
      return;
    }
    if (path === "/api/v1/orders" && request.method() === "GET") {
      await fulfillAccount(route, { items: orderCreated ? [{
        orderId,
        orderStatus: "waiting_payment",
        productName: "Generic configurable plan",
        serviceId,
        serviceStatus: "pending",
        createdAt: new Date().toISOString(),
      }] : [] });
      return;
    }
    if (path === "/api/v1/quotes" && request.method() === "GET") {
      await fulfillAccount(route, { warning: "MOCK ONLY", items: [] });
      return;
    }
    if (path === "/api/v1/marketing-consent" && request.method() === "GET") {
      await fulfillAccount(route, {
        granted: false,
        policyVersion: "mock-lab-marketing-v1",
        recordedAt: null,
        defaulted: true,
      });
      return;
    }
    if (path === "/api/v1/billing/summary") {
      await fulfillAccount(route, {
        currency: "USD",
        creditBalanceMinor: "0",
        paymentMethods: [],
        addFunds: {
          enabled: false,
          allowed: false,
          minimumMinor: "5000",
          maximumMinor: "500000",
          balanceCapMinor: "1000000",
        },
      });
      return;
    }
    if (path === "/api/v1/billing/payment-settings") {
      await fulfillAccount(route, {
        defaults: { savePaymentMethod: false, automaticRenewal: false },
        consentVersions: { savePaymentMethod: "save-v1", automaticRenewal: "renew-v1" },
        methods: [],
        automaticRenewals: [],
        pendingAutomaticRenewals: [],
        serviceDecisions: [],
      });
      return;
    }
    if (path === "/api/v1/billing/renewals") {
      await fulfillAccount(route, { items: [] });
      return;
    }
    if (path === "/api/v1/billing/chargeback-status") {
      await fulfillAccount(route, {
        clientAccountId,
        restricted: false,
        creditBalanceMinor: "0",
        debtBalanceMinor: "0",
        chargebacks: [],
        unclaimedChargebacks: [],
        manualHolds: [],
      });
      return;
    }
    if (path === "/api/v1/customer/business-history") {
      await fulfillAccount(route, {
        warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
        account: { id: clientAccountId, name: "Catalog browser account" },
        orders: [],
        invoices: [],
        payments: [],
        credit: { currency: "USD", balanceMinor: "0", transactions: [] },
        refunds: [],
        services: [],
        renewals: [],
        cancellations: [],
        tickets: [],
      });
      return;
    }
    if (path === "/api/v1/tickets" || path === "/api/v1/tickets/service-options") {
      await fulfillAccount(route, { items: [] });
      return;
    }
    if (path === "/api/v1/customer/content") {
      await fulfillAccount(route, { items: [] });
      return;
    }
    if (path === "/api/v1/content") {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    await fulfillAccount(route, { items: [] });
  });

  await page.goto("/customer");
  const product = page.locator("article.product-card").filter({ hasText: "Generic configurable plan" });
  await product.getByRole("button", { name: /monthly/i }).click();
  const dialog = page.getByRole("dialog", { name: "Generic configurable plan" });

  const units = dialog.getByLabel("Units");
  await expect(units).toHaveAttribute("min", "1");
  await expect(units).toHaveAttribute("max", "5");
  await expect(dialog.getByLabel("Service hostname")).toHaveCount(0);
  await expect(dialog.getByLabel("Initial access phrase")).toHaveCount(0);
  await expect(dialog.getByLabel("Implementation notes")).toHaveCount(0);

  await dialog.getByLabel("Service tier").selectOption("basic");
  await expect(units).toHaveAttribute("min", "1");
  await expect(units).toHaveAttribute("max", "5");
  await dialog.getByLabel("Service tier").selectOption("pro");
  await expect(units).toHaveAttribute("min", "2");
  await expect(units).toHaveAttribute("max", "4");
  await units.fill("2");
  await dialog.getByLabel("Service hostname").fill(hostnameValue);
  await dialog.getByLabel("Implementation notes").fill(notesValue);
  await expect(dialog.getByLabel("Console password")).toHaveCount(0);
  await dialog.getByRole("radio", { name: "Priority" }).check();
  const passwordInput = dialog.getByLabel("Console password");
  await expect(passwordInput).toHaveAttribute("type", "password");
  await passwordInput.fill(passwordValue);
  const oneTimeInput = dialog.getByLabel("Initial access phrase");
  await expect(oneTimeInput).toHaveAttribute("type", "password");
  await oneTimeInput.fill(oneTimeValue);
  await dialog.getByLabel("Promotion code (optional)").fill("save10");
  await dialog.getByRole("button", { name: "Review total" }).click();

  const preview = dialog.getByRole("region", { name: "Order preview" });
  await expect(preview).toContainText("$18.00");
  await expect(preview).toContainText("Promotion SAVE10");
  await expect(preview).not.toContainText(oneTimeValue);
  await expect(preview).not.toContainText(passwordValue);
  await expect(page.getByText(oneTimeValue, { exact: true })).toHaveCount(0);
  await expect(page.getByText(passwordValue, { exact: true })).toHaveCount(0);
  const browserPersistence = await page.evaluate(() => ({
    url: window.location.href,
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
  }));
  expect(JSON.stringify(browserPersistence)).not.toContain(oneTimeValue);
  expect(JSON.stringify(browserPersistence)).not.toContain(passwordValue);

  const marketing = dialog.getByLabel("Marketing communications consent (optional)");
  await expect(marketing).not.toBeChecked();
  await dialog.getByLabel("Accept Terms version terms-v1").check();
  await dialog.getByLabel("Accept AUP version aup-v1").check();
  await dialog.getByRole("button", { name: "Configure & order" }).click();
  await expect(dialog).toHaveCount(0);

  expect(previewPayload).not.toBeNull();
  expect(orderPayload).toMatchObject({
    priceId,
    configuration: {
      tier: "pro",
      units: 2,
      support_window: "priority",
      service_hostname: hostnameValue,
      bootstrap_secret: oneTimeValue,
      console_password: passwordValue,
      implementation_notes: notesValue,
    },
    promotionCode: "SAVE10",
    termsVersion: "terms-v1",
    aupVersion: "aup-v1",
    termsDocumentId,
    aupDocumentId,
    legalLocale: "en",
    termsLocale: "en",
    aupLocale: "en",
    marketingConsent: false,
  });
  expect(orderPayload).not.toHaveProperty("marketingConsentPolicyVersion");

  await product.getByRole("button", { name: /monthly/i }).click();
  const reopened = page.getByRole("dialog", { name: "Generic configurable plan" });
  await reopened.getByLabel("Service tier").selectOption("pro");
  await expect(reopened.getByLabel("Initial access phrase")).toHaveValue("");
});
