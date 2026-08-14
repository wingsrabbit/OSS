// SPDX-License-Identifier: Apache-2.0

import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const accountId = "00000000-0000-4000-8000-000000000024";
const userId = "00000000-0000-4000-8000-000000000124";
const sessionId = "00000000-0000-4000-8000-000000000224";
const email = "identity-security-browser@example.invalid";

type MockIdentityState = {
  authenticated: boolean;
  authorizationEpoch: string;
  contextVersion: string;
  loginMode: "normal" | "mfa";
  loginRequests: number;
  challengeCompletions: number;
  sessionEndRequests: string[];
  recoveryMailboxReads?: number;
  emailChangeInspections?: number;
  emailChangeInspectGate?: Promise<void>;
};

function identityHeaders(state: MockIdentityState): Record<string, string> {
  return {
    "X-OSS-Authorization-Epoch": state.authorizationEpoch,
    "X-OSS-Account-Context-Version": state.contextVersion,
    "X-OSS-Client-Account-Id": accountId,
  };
}

function viewer(state: MockIdentityState) {
  return {
    id: userId,
    email,
    locale: "en",
    clientAccountId: accountId,
    membershipRole: "owner",
    accountContextVersion: state.contextVersion,
    context: {
      clientAccountId: accountId,
      name: "Identity security browser account",
      role: "owner",
      permissions: ["*"],
      capabilities: [],
      version: state.contextVersion,
    },
    verification: { email: "passed" },
    restrictions: { user: false, clientAccount: false },
    eligible: true,
    staff: null,
  };
}

async function fulfillSessionJson(
  route: Route,
  state: MockIdentityState,
  json: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({ status, headers: identityHeaders(state), json });
}

async function installIdentityApi(
  context: BrowserContext,
  state: MockIdentityState,
): Promise<void> {
  await context.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/catalog") {
      await route.fulfill({ json: { products: [] } });
      return;
    }
    if (path === "/api/v1/legal/current") {
      const document = { version: "identity-v1", title: "Synthetic", body: "Mock only." };
      await route.fulfill({
        json: { documents: { terms: document, aup: document, privacy: document } },
      });
      return;
    }
    if (path === "/api/v1/auth/login") {
      state.loginRequests += 1;
      if (state.loginMode === "mfa") {
        await route.fulfill({
          status: 202,
          json: {
            challenge: {
              id: "00000000-0000-4000-8000-000000000324",
              token: "mfa-browser-token-not-persisted",
              methods: ["totp", "recovery_code"],
            },
          },
        });
      } else {
        state.authenticated = true;
        await fulfillSessionJson(route, state, {
          requiresAccountContext: false,
          expiresAt: "2026-08-14T00:00:00.000Z",
        });
      }
      return;
    }
    if (path === "/api/v1/auth/login-challenges/complete") {
      state.challengeCompletions += 1;
      state.authenticated = true;
      await fulfillSessionJson(route, state, {
        requiresAccountContext: false,
        expiresAt: "2026-08-14T00:00:00.000Z",
      });
      return;
    }
    if (path === "/api/v1/auth/me") {
      if (!state.authenticated) {
        await route.fulfill({ status: 401, json: { error: "Authentication required" } });
      } else {
        await fulfillSessionJson(route, state, viewer(state));
      }
      return;
    }
    if (path === "/api/v1/auth/account-contexts") {
      if (!state.authenticated) {
        await route.fulfill({ status: 401, json: { error: "Authentication required" } });
      } else {
        await fulfillSessionJson(route, state, {
          activeClientAccountId: accountId,
          accountContextVersion: state.contextVersion,
          items: [{
            clientAccountId: accountId,
            name: "Identity security browser account",
            role: "owner",
            permissions: ["*"],
            capabilities: [],
            restrictions: { membership: false, clientAccount: false },
          }],
          limit: 25,
          hasMore: false,
          nextCursor: null,
        });
      }
      return;
    }
    if (path === "/api/v1/auth/password-recovery/complete") {
      state.sessionEndRequests.push(`${request.method()} ${path}`);
      state.authenticated = false;
      await route.fulfill({ json: { sessionEnded: true } });
      return;
    }
    if (path === "/api/v1/auth/password-recovery/request") {
      await route.fulfill({ status: 202, json: { status: "pending" } });
      return;
    }
    if (path === "/api/v1/lab/identity-mailbox/password-recovery") {
      state.recoveryMailboxReads = (state.recoveryMailboxReads ?? 0) + 1;
      const origin = new URL(request.url()).origin;
      await route.fulfill({
        json: {
          warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
          status: "delivered",
          actionUrl: `${origin}/password-recovery#token=${"R".repeat(43)}`,
        },
      });
      return;
    }
    if (!state.authenticated) {
      await route.fulfill({ status: 401, json: { error: "Authentication required" } });
      return;
    }
    if (path === "/api/v1/security/email-change/inspect") {
      state.emailChangeInspections = (state.emailChangeInspections ?? 0) + 1;
      await state.emailChangeInspectGate;
      await fulfillSessionJson(route, state, {
        warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
        requestedEmail: "new-identity-mailbox@example.invalid",
      });
      return;
    }
    if (path === "/api/v1/customer/business-history") {
      await fulfillSessionJson(route, state, {
        warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
        account: { id: accountId, name: "Identity security browser account" },
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
    if (path === "/api/v1/customer/notification-deliveries") {
      await fulfillSessionJson(route, state, {
        warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
        account: { id: accountId, name: "Identity security browser account" },
        items: [],
        limit: 20,
        hasMore: false,
        nextCursor: null,
      });
      return;
    }
    if (path === "/api/v1/billing/summary") {
      await fulfillSessionJson(route, state, {
        currency: "USD",
        creditBalanceMinor: "0",
        paymentMethods: [{
          code: "card",
          name: "Mock card",
          feeBasisPoints: 0,
          addFundsEnabled: false,
          savedMethodEnabled: true,
          automaticRenewalEnabled: true,
        }],
        addFunds: {
          enabled: false,
          allowed: false,
          minimumMinor: "100",
          maximumMinor: "10000",
          balanceCapMinor: "10000",
        },
      });
      return;
    }
    if (path === "/api/v1/billing/payment-settings") {
      await fulfillSessionJson(route, state, {
        defaults: { savePaymentMethod: false, automaticRenewal: false },
        consentVersions: { savePaymentMethod: "mock-v1", automaticRenewal: "mock-v1" },
        methods: [],
        automaticRenewals: [],
        pendingAutomaticRenewals: [],
        serviceDecisions: [],
      });
      return;
    }
    if (path === "/api/v1/billing/renewals") {
      await fulfillSessionJson(route, state, { items: [] });
      return;
    }
    if (path === "/api/v1/billing/chargeback-status") {
      await fulfillSessionJson(route, state, {
        clientAccountId: accountId,
        restricted: false,
        creditBalanceMinor: "0",
        debtBalanceMinor: "0",
        chargebacks: [],
        unclaimedChargebacks: [],
        manualHolds: [],
      });
      return;
    }
    if (path === "/api/v1/tickets" || path === "/api/v1/tickets/service-options") {
      await fulfillSessionJson(route, state, { items: [] });
      return;
    }
    if (
      path === "/api/v1/account/members" ||
      path === "/api/v1/account/membership-invitations" ||
      path === "/api/v1/account/contacts"
    ) {
      await fulfillSessionJson(route, state, {
        items: [],
        limit: 25,
        hasMore: false,
        nextCursor: null,
      });
      return;
    }
    if (path === "/api/v1/orders") {
      await fulfillSessionJson(route, state, { items: [] });
      return;
    }
    if (path === "/api/v1/security") {
      await fulfillSessionJson(route, state, {
        warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
        email,
        authorizationEpoch: state.authorizationEpoch,
        totp: { enabled: false, recoveryCodesRemaining: "0" },
        activeSessions: "2",
        activeApiKeys: "0",
        later: ["WebAuthn", "SSO", "SMS"],
      });
      return;
    }
    if (path === "/api/v1/security/sessions" && request.method() === "GET") {
      await fulfillSessionJson(route, state, {
        items: [{
          id: sessionId,
          current: true,
          status: "active",
          createdAt: "2026-08-13T00:00:00.000Z",
          expiresAt: "2026-08-14T00:00:00.000Z",
          revokedAt: null,
        }],
      });
      return;
    }
    if (path === "/api/v1/security/api-keys") {
      await fulfillSessionJson(route, state, { items: [] });
      return;
    }
    if (
      (path === "/api/v1/security/sessions/revoke-all" && request.method() === "POST") ||
      (path === `/api/v1/security/sessions/${sessionId}` && request.method() === "DELETE")
    ) {
      state.sessionEndRequests.push(`${request.method()} ${path}`);
      state.authenticated = false;
      await fulfillSessionJson(route, state, { sessionEnded: true, revokedCount: 2 });
      return;
    }
    await fulfillSessionJson(route, state, { items: [] });
  });
}

async function fillHomeLogin(page: Page): Promise<void> {
  const form = page.locator("form").filter({ has: page.getByRole("heading", { name: "Sign in" }) });
  await form.getByPlaceholder("Email").fill(email);
  await form.getByPlaceholder("Password", { exact: true }).fill("Synthetic-browser-password-024!");
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("normal and MFA browser sign-in both establish the required authorization epoch", async ({
  page,
  context,
}) => {
  const state: MockIdentityState = {
    authenticated: false,
    authorizationEpoch: "7",
    contextVersion: "11",
    loginMode: "normal",
    loginRequests: 0,
    challengeCompletions: 0,
    sessionEndRequests: [],
  };
  await installIdentityApi(context, state);

  await page.goto("/");
  await fillHomeLogin(page);
  await expect(page).toHaveURL(/\/customer$/);
  await expect(page.getByRole("heading", { name: email, exact: true })).toBeVisible();
  expect(state.loginRequests).toBe(1);
  expect(await page.evaluate(async () => {
    const modulePath = "/src/api.ts";
    const client = await import(modulePath);
    return client.getAccountContextSnapshot();
  })).toEqual({
    clientAccountId: accountId,
    version: "11",
    authorizationEpoch: "7",
    generation: expect.any(Number),
  });

  await page.close();
  const mfaPage = await context.newPage();
  state.authenticated = false;
  state.loginMode = "mfa";
  state.authorizationEpoch = "8";
  state.contextVersion = "12";
  await mfaPage.goto("/");
  await fillHomeLogin(mfaPage);
  await expect(mfaPage.getByTestId("login-factor-challenge")).toBeVisible();
  await expect(mfaPage).toHaveURL(/\/$/);
  await mfaPage.getByLabel("TOTP / recovery code", { exact: true }).fill("123456");
  await mfaPage.getByRole("button", { name: "Complete sign in" }).click();
  await expect(mfaPage).toHaveURL(/\/customer$/);
  await expect(mfaPage.getByRole("heading", { name: email, exact: true })).toBeVisible();
  expect(state.challengeCompletions).toBe(1);
  expect(await mfaPage.evaluate(async () => {
    const modulePath = "/src/api.ts";
    const client = await import(modulePath);
    return client.getAccountContextSnapshot();
  })).toEqual({
    clientAccountId: accountId,
    version: "12",
    authorizationEpoch: "8",
    generation: expect.any(Number),
  });
});

test("current-session and revoke-all boundaries unmount both Security tabs immediately", async ({
  context,
}) => {
  const state: MockIdentityState = {
    authenticated: true,
    authorizationEpoch: "21",
    contextVersion: "31",
    loginMode: "normal",
    loginRequests: 0,
    challengeCompletions: 0,
    sessionEndRequests: [],
  };
  await installIdentityApi(context, state);

  for (const ending of ["current", "all"] as const) {
    state.authenticated = true;
    const source = await context.newPage();
    const peer = await context.newPage();
    await Promise.all([source.goto("/security"), peer.goto("/security")]);
    await Promise.all([
      expect(source.getByTestId("security-page")).toContainText(email),
      expect(peer.getByTestId("security-page")).toContainText(email),
    ]);
    if (ending === "current") {
      const current = source.locator('section[aria-label="Session management"] article').filter({
        hasText: "Current session",
      });
      await current.getByRole("button", { name: "Revoke", exact: true }).click();
    } else {
      await source.getByRole("button", { name: "Revoke all and sign out" }).click();
    }
    await expect(source).toHaveURL(/\/$/);
    await expect(source.getByTestId("public-access")).toBeVisible();
    await expect(peer.getByTestId("security-guest")).toBeVisible();
    await expect(peer.getByText(email, { exact: true })).toHaveCount(0);
    await Promise.all([source.close(), peer.close()]);
  }
  expect(state.sessionEndRequests).toContain(`DELETE /api/v1/security/sessions/${sessionId}`);
  expect(state.sessionEndRequests).toContain("POST /api/v1/security/sessions/revoke-all");
});

test("password recovery completion removes a signed-in customer workspace in both tabs", async ({
  context,
}) => {
  const state: MockIdentityState = {
    authenticated: true,
    authorizationEpoch: "41",
    contextVersion: "51",
    loginMode: "normal",
    loginRequests: 0,
    challengeCompletions: 0,
    sessionEndRequests: [],
  };
  await installIdentityApi(context, state);
  const recovery = await context.newPage();
  const customer = await context.newPage();
  const token = "A".repeat(43);
  await Promise.all([
    recovery.goto(`/password-recovery#token=${token}`),
    customer.goto("/customer"),
  ]);
  await expect(customer.getByRole("heading", { name: email, exact: true })).toBeVisible();
  await expect(recovery).not.toHaveURL(/token=/);
  await recovery.getByLabel("New password").fill("Synthetic-recovered-browser-password-024!");
  await recovery.getByRole("button", { name: "Reset password" }).click();
  await expect(recovery).toHaveURL(/\/$/);
  await expect(recovery.getByTestId("public-access")).toBeVisible();
  await expect(customer.getByRole("heading", { name: "Sign in to open the customer workspace" })).toBeVisible();
  await expect(customer.getByText(email, { exact: true })).toHaveCount(0);
  expect(state.sessionEndRequests).toEqual(["POST /api/v1/auth/password-recovery/complete"]);
});

test("an anonymous user can retrieve the exact Mock Mail recovery link through the public wrapper", async ({
  context,
}) => {
  const state: MockIdentityState = {
    authenticated: false,
    authorizationEpoch: "61",
    contextVersion: "71",
    loginMode: "normal",
    loginRequests: 0,
    challengeCompletions: 0,
    sessionEndRequests: [],
  };
  await installIdentityApi(context, state);
  const page = await context.newPage();
  await page.goto("/password-recovery");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send recovery link" }).click();
  await expect(page.getByTestId("password-recovery-mailbox")).toContainText(
    "Waiting for Mock Mail delivery.",
  );
  await page.getByRole("button", { name: "Refresh recovery mailbox" }).click();
  const action = page.getByRole("link", { name: "Open the one-time recovery link" });
  await expect(action).toBeVisible();
  await action.click();
  await expect(page).not.toHaveURL(/token=/);
  await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible();
  expect(state.recoveryMailboxReads).toBe(1);
});

test("email change preserves the fragment through login and cannot confirm before the exact target is inspected", async ({
  context,
}) => {
  let releaseInspection!: () => void;
  const inspectionGate = new Promise<void>((resolve) => { releaseInspection = resolve; });
  const state: MockIdentityState = {
    authenticated: false,
    authorizationEpoch: "81",
    contextVersion: "91",
    loginMode: "normal",
    loginRequests: 0,
    challengeCompletions: 0,
    sessionEndRequests: [],
    emailChangeInspectGate: inspectionGate,
  };
  await installIdentityApi(context, state);
  const page = await context.newPage();
  await page.goto(`/email-change#token=${"E".repeat(43)}`);
  await expect(page).not.toHaveURL(/token=/);
  await page.getByLabel("Current sign-in email").fill(email);
  await page.getByLabel("Password").fill("Synthetic-browser-password-024!");
  await page.getByRole("button", { name: "Sign in and continue" }).click();

  const target = page.getByTestId("email-change-target");
  await expect(target).toContainText("Verifying the link…");
  const confirm = page.getByRole("button", { name: "Confirm email change" });
  await expect(confirm).toBeDisabled();
  releaseInspection();
  await expect(target).toContainText("new-identity-mailbox@example.invalid");
  await expect(confirm).toBeEnabled();
  expect(state.loginRequests).toBe(1);
  expect(state.emailChangeInspections).toBe(1);
});
