// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Page, type Route } from "@playwright/test";

const outboxId = "10000000-0000-4000-8000-000000000001";
const operationId = "10000000-0000-4000-8000-000000000002";
const jobId = "10000000-0000-4000-8000-000000000003";
const jobUpdatedAt = "2026-08-20T08:00:00.000001Z";
const headers = {
  "X-OSS-Account-Context-Version": "1",
  "X-OSS-Authorization-Epoch": "1",
};

function expectProtectedBusinessBody(
  requestBody: Record<string, unknown>,
  expectedBusinessBody: Record<string, unknown>,
): string {
  const { intentId, ...businessBody } = requestBody;
  expect(intentId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/u));
  expect(businessBody).toEqual(expectedBusinessBody);
  expect(
    Object.keys(requestBody).some((key) =>
      ["password", "factorcode", "recoverycode", "secret", "token", "totp"]
        .includes(key.toLowerCase())),
  ).toBe(false);
  return String(intentId);
}

function viewer(
  permissions: string[],
  identity: Readonly<{ id: string; email: string }> = {
    id: "20000000-0000-4000-8000-000000000001",
    email: "notification-staff@example.invalid",
  },
) {
  return {
    id: identity.id,
    email: identity.email,
    locale: "en",
    clientAccountId: null,
    membershipRole: null,
    accountContextVersion: "1",
    authorizationEpoch: "1",
    context: null,
    verification: { email: "passed" },
    restrictions: { user: false, clientAccount: false },
    eligible: false,
    staff: { roles: ["operations"], permissions },
  };
}

function snapshot(retried: boolean, recipient = "synthetic-customer@example.invalid") {
  const delivery = {
    source: "standard",
    operationId,
    outboxId,
    attemptNumber: 1,
    eventType: "notification.email_verification_requested",
    templateRevision: "email-verification-v1",
    category: "identity",
    recipientKind: "identity_user",
    recipient,
    locale: "en",
    operationStatus: "failed",
    operationAttempts: 1,
    operationLastError: "MOCK_MAIL_FAILED",
    operationCreatedAt: "2026-08-20T07:59:00.000001Z",
    operationUpdatedAt: "2026-08-20T08:00:00.000001Z",
    outcomeStatus: "failed",
    outcomeReason: "MOCK_MAIL_FAILED",
    outcomeRecordedAt: "2026-08-20T08:00:00.000001Z",
    jobId,
    jobStatus: retried ? "pending" : "manual",
    jobLastError: retried
      ? "STAFF_NOTIFICATION_RETRY_REQUESTED"
      : "NOTIFICATION_REQUIRES_STAFF_DECISION",
    jobAvailableAt: "2026-08-20T08:00:00.000001Z",
    jobUpdatedAt: retried ? "2026-08-20T08:01:00.000001Z" : jobUpdatedAt,
    isLatest: true,
    retryable: !retried,
    retryReason: retried
      ? "The Worker already owns this delivery or has finished it"
      : "The failed attempt can append one Worker-controlled retry",
  };
  return {
    summary: {
      attentionCount: 1,
      failedCount: 1,
      unknownCount: 0,
      manualCount: retried ? 0 : 1,
      retryableCount: retried ? 0 : 1,
      oldestTask: {
        id: jobId,
        jobType: "notification.send",
        status: retried ? "pending" : "manual",
        availableAt: "2026-08-20T08:00:00.000001Z",
        createdAt: "2026-08-20T07:59:00.000001Z",
        updatedAt: retried ? "2026-08-20T08:01:00.000001Z" : jobUpdatedAt,
      },
    },
    queue: [delivery],
    history: [delivery],
    retryAudit: retried
      ? [{
          id: "30000000-0000-4000-8000-000000000001",
          actorId: "20000000-0000-4000-8000-000000000001",
          outboxId,
          reason: "Recipient facts reviewed for one normal retry",
          createdAt: "2026-08-20T08:01:00.000001Z",
        }]
      : [],
  };
}

async function routeApplication(
  page: Page,
  input: Readonly<{
    permissions: string[];
    currentViewer?: () => ReturnType<typeof viewer>;
    onReauthRequest?: (route: Route) => Promise<void>;
    onNotificationRequest?: (route: Route) => Promise<void>;
  }>,
) {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/v1/auth/me") {
      await route.fulfill({ headers, json: input.currentViewer?.() ?? viewer(input.permissions) });
      return;
    }
    if (path === "/api/v1/auth/account-contexts") {
      await route.fulfill({
        headers,
        json: {
          activeClientAccountId: null,
          accountContextVersion: "1",
          items: [],
          limit: 25,
          hasMore: false,
          nextCursor: null,
        },
      });
      return;
    }
    if (path === "/api/v1/catalog") {
      await route.fulfill({ json: { products: [] } });
      return;
    }
    if (path === "/api/v1/legal/current") {
      await route.fulfill({
        json: {
          requestedLocale: "en",
          documents: Object.fromEntries(
            ["terms", "aup", "privacy"].map((kind) => [
              kind,
              {
                documentId: `40000000-0000-4000-8000-0000000000${kind === "terms" ? "01" : kind === "aup" ? "02" : "03"}`,
                kind,
                locale: "en",
                requestedLocale: "en",
                fallback: false,
                revision: "1",
                version: "2026-08-20",
                title: `Synthetic ${kind}`,
                body: `Synthetic published ${kind} copy.`,
                publishedAt: "2026-08-20T07:00:00.000Z",
              },
            ]),
          ),
        },
      });
      return;
    }
    if (path === "/api/v1/content") {
      await route.fulfill({ json: { requestedLocale: "en", items: [] } });
      return;
    }
    if (path === "/api/v1/auth/reauth") {
      if (input.onReauthRequest) {
        await input.onReauthRequest(route);
      } else {
        await route.fulfill({ headers, json: { expiresAt: "2026-08-20T08:15:00.000Z" } });
      }
      return;
    }
    if (path.startsWith("/api/v1/admin/notification-operations")) {
      if (input.onNotificationRequest) {
        await input.onNotificationRequest(route);
      } else {
        await route.fulfill({ headers, json: snapshot(false) });
      }
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Unmocked ${route.request().method()} ${path}` } });
  });
}

test("Staff sees the failed queue, immutable template/attempt history, and commits one controlled retry", async ({ page }) => {
  let retried = false;
  let retryPosts = 0;
  await routeApplication(page, {
    permissions: ["notifications.read", "notifications.retry"],
    onReauthRequest: async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        password: "Synthetic-Staff-Password!",
        factorCode: "notification-recovery-1",
      });
      await route.fulfill({ headers, json: { expiresAt: "2026-08-20T08:15:00.000Z" } });
    },
    onNotificationRequest: async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "GET") {
        await route.fulfill({ headers, json: snapshot(retried) });
        return;
      }
      expect(path).toBe(`/api/v1/admin/notification-operations/${outboxId}/retry`);
      expect(route.request().method()).toBe("POST");
      expectProtectedBusinessBody(
        route.request().postDataJSON() as Record<string, unknown>,
        {
          reason: "Recipient facts reviewed for one normal retry",
          expectedJobUpdatedAt: jobUpdatedAt,
        },
      );
      retryPosts += 1;
      retried = true;
      await route.fulfill({
        status: 201,
        headers,
        json: {
          outboxId,
          failedAttemptNumber: 1,
          jobStatus: "pending",
          jobUpdatedAt: "2026-08-20T08:01:00.000001Z",
        },
      });
    },
  });

  await page.goto("/admin");
  const panel = page.getByTestId("notification-operations");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("notification-summary")).toContainText("Retryable: 1");
  await expect(panel.getByTestId("notification-oldest-task")).toContainText(jobId);
  await expect(panel.getByTestId("notification-attention-queue")).toContainText(
    "notification.email_verification_requested",
  );
  await expect(panel.getByTestId("notification-attention-queue")).toContainText(
    "email-verification-v1",
  );
  await panel.getByLabel("Current password confirmation").fill("Synthetic-Staff-Password!");
  await panel.getByLabel("Notification TOTP or recovery code").fill("notification-recovery-1");
  await panel.getByLabel("Retry reason").fill("Recipient facts reviewed for one normal retry");
  await panel.getByRole("button", { name: "Controlled single retry" }).click();

  await expect(panel.getByTestId("notification-summary")).toContainText("Retryable: 0");
  await expect(panel.getByTestId("notification-attention-queue")).toContainText(
    "The Worker already owns this delivery",
  );
  expect(retryPosts).toBe(1);
  await panel.getByTestId("notification-retry-audit").locator("summary").click();
  await expect(panel.getByTestId("notification-retry-audit")).toContainText(
    "Recipient facts reviewed for one normal retry",
  );
});

test("real App replays one delivery intent after a committed response is lost", async ({ page }) => {
  let retried = false;
  let reauthPosts = 0;
  let logicalRetryFacts = 0;
  const committedIntents = new Set<string>();
  const protectedBodies: Array<Record<string, unknown>> = [];
  await routeApplication(page, {
    permissions: ["notifications.read", "notifications.retry"],
    onReauthRequest: async (route) => {
      reauthPosts += 1;
      expect(route.request().postDataJSON()).toEqual({
        password: "Synthetic-Staff-Password!",
        factorCode: "notification-recovery-ambiguous",
      });
      await route.fulfill({ headers, json: { expiresAt: "2026-08-20T08:15:00.000Z" } });
    },
    onNotificationRequest: async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ headers, json: snapshot(retried) });
        return;
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      protectedBodies.push(body);
      const intentId = expectProtectedBusinessBody(body, {
        reason: "Recipient facts reviewed across an ambiguous response",
        expectedJobUpdatedAt: jobUpdatedAt,
      });
      if (!committedIntents.has(intentId)) {
        committedIntents.add(intentId);
        logicalRetryFacts += 1;
        retried = true;
      }
      if (protectedBodies.length === 1) {
        await route.abort("connectionfailed");
      } else {
        await route.fulfill({
          status: 201,
          headers,
          json: {
            outboxId,
            failedAttemptNumber: 1,
            jobStatus: "pending",
            jobUpdatedAt: "2026-08-20T08:01:00.000001Z",
          },
        });
      }
    },
  });

  await page.goto("/admin");
  const panel = page.getByTestId("notification-operations");
  await panel.getByLabel("Current password confirmation").fill("Synthetic-Staff-Password!");
  await panel.getByLabel("Notification TOTP or recovery code").fill(
    "notification-recovery-ambiguous",
  );
  await panel.getByLabel("Retry reason").fill(
    "Recipient facts reviewed across an ambiguous response",
  );
  await panel.getByRole("button", { name: "Controlled single retry" }).click();

  await expect(page.locator(".notice.error")).toBeVisible();
  await expect(panel.getByLabel("Retry reason")).toHaveValue(
    "Recipient facts reviewed across an ambiguous response",
  );
  await panel.getByRole("button", { name: "Controlled single retry" }).click();

  await expect(panel.getByTestId("notification-summary")).toContainText("Retryable: 0");
  expect(reauthPosts).toBe(1);
  expect(protectedBodies).toHaveLength(2);
  expect(protectedBodies[1]).toEqual(protectedBodies[0]);
  expect(logicalRetryFacts).toBe(1);
});

test("a current grant permits retry without another password while factor-only input is blocked", async ({ page }) => {
  let retried = false;
  let reauthPosts = 0;
  let retryPosts = 0;
  await routeApplication(page, {
    permissions: ["notifications.read", "notifications.retry"],
    onReauthRequest: async (route) => {
      reauthPosts += 1;
      await route.fulfill({ headers, json: { expiresAt: "2026-08-20T08:15:00.000Z" } });
    },
    onNotificationRequest: async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ headers, json: snapshot(retried) });
        return;
      }
      retryPosts += 1;
      retried = true;
      await route.fulfill({
        status: 201,
        headers,
        json: {
          outboxId,
          failedAttemptNumber: 1,
          jobStatus: "pending",
          jobUpdatedAt: "2026-08-20T08:01:00.000001Z",
        },
      });
    },
  });

  await page.goto("/admin");
  const panel = page.getByTestId("notification-operations");
  await expect(panel).toBeVisible();
  await panel.getByLabel("Retry reason").fill("Use the current normal Staff grant");
  const retry = panel.getByRole("button", { name: "Controlled single retry" });
  await panel.getByLabel("Notification TOTP or recovery code").fill("factor-without-password");
  await expect(panel.getByTestId("notification-factor-requires-password")).toBeVisible();
  await expect(retry).toBeDisabled();
  expect(retryPosts).toBe(0);

  await panel.getByLabel("Notification TOTP or recovery code").fill("");
  await retry.click();
  await expect(panel.getByTestId("notification-summary")).toContainText("Retryable: 0");
  expect(reauthPosts).toBe(0);
  expect(retryPosts).toBe(1);
});

test("failed notification MFA retains credentials and does not post a retry", async ({ page }) => {
  let retryPosts = 0;
  await routeApplication(page, {
    permissions: ["notifications.read", "notifications.retry"],
    onReauthRequest: async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        password: "Synthetic-Staff-Password!",
        factorCode: "notification-recovery-failed",
      });
      await route.fulfill({
        status: 401,
        headers,
        json: { error: "Synthetic notification reauthentication failed" },
      });
    },
    onNotificationRequest: async (route) => {
      if (route.request().method() === "POST") retryPosts += 1;
      await route.fulfill({ headers, json: snapshot(false) });
    },
  });

  await page.goto("/admin");
  const panel = page.getByTestId("notification-operations");
  await panel.getByLabel("Current password confirmation").fill("Synthetic-Staff-Password!");
  await panel.getByLabel("Notification TOTP or recovery code").fill(
    "notification-recovery-failed",
  );
  await panel.getByLabel("Retry reason").fill("Retain credentials after normal rejection");
  await panel.getByRole("button", { name: "Controlled single retry" }).click();

  await expect(page.locator(".notice.error")).toContainText(
    "Synthetic notification reauthentication failed",
  );
  await expect(panel.getByLabel("Current password confirmation")).toHaveValue(
    "Synthetic-Staff-Password!",
  );
  await expect(panel.getByLabel("Notification TOTP or recovery code")).toHaveValue(
    "notification-recovery-failed",
  );
  expect(retryPosts).toBe(0);
});

test("a committed retry is acknowledged immediately while its current-scope refresh is slow", async ({ page }) => {
  let retried = false;
  let releaseRefresh!: () => void;
  const refreshReleased = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let markRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    markRefreshStarted = resolve;
  });
  await routeApplication(page, {
    permissions: ["notifications.read", "notifications.retry"],
    onNotificationRequest: async (route) => {
      if (route.request().method() === "GET") {
        if (retried) {
          markRefreshStarted();
          await refreshReleased;
        }
        await route.fulfill({ headers, json: snapshot(retried) });
        return;
      }
      retried = true;
      await route.fulfill({
        status: 201,
        headers,
        json: {
          outboxId,
          failedAttemptNumber: 1,
          jobStatus: "pending",
          jobUpdatedAt: "2026-08-20T08:01:00.000001Z",
        },
      });
    },
  });

  await page.goto("/admin");
  const panel = page.getByTestId("notification-operations");
  await expect(panel).toBeVisible();
  await panel.getByLabel("Current password confirmation").fill("Synthetic-Staff-Password!");
  await panel.getByLabel("Retry reason").fill("Recipient facts reviewed for a slow refresh");
  await panel.getByRole("button", { name: "Controlled single retry" }).click();
  await refreshStarted;

  await expect(page.getByText("Notification retry committed; the Worker will append one new delivery attempt.")).toBeVisible();
  await expect(panel.getByLabel("Current password confirmation")).toHaveValue("");
  await expect(panel.getByLabel("Retry reason")).toHaveValue("");
  await expect(panel.getByRole("button", { name: "Controlled single retry" })).toBeDisabled();
  releaseRefresh();
  await expect(panel.getByTestId("notification-summary")).toContainText("Retryable: 0");
});

test("a committed retry reports a current-scope refresh failure without reverting the commit", async ({ page }) => {
  let retried = false;
  await routeApplication(page, {
    permissions: ["notifications.read", "notifications.retry"],
    onNotificationRequest: async (route) => {
      if (route.request().method() === "GET") {
        if (retried) {
          await route.fulfill({
            status: 503,
            headers,
            json: { error: "Synthetic notification refresh unavailable" },
          });
          return;
        }
        await route.fulfill({ headers, json: snapshot(false) });
        return;
      }
      retried = true;
      await route.fulfill({
        status: 201,
        headers,
        json: {
          outboxId,
          failedAttemptNumber: 1,
          jobStatus: "pending",
          jobUpdatedAt: "2026-08-20T08:01:00.000001Z",
        },
      });
    },
  });

  await page.goto("/admin");
  const panel = page.getByTestId("notification-operations");
  await expect(panel).toBeVisible();
  await panel.getByLabel("Current password confirmation").fill("Synthetic-Staff-Password!");
  await panel.getByLabel("Retry reason").fill("Recipient facts reviewed before refresh failure");
  await panel.getByRole("button", { name: "Controlled single retry" }).click();

  await expect(page.getByText(
    "Retry committed, but the queue refresh failed: Synthetic notification refresh unavailable",
  )).toBeVisible();
  await expect(panel.getByLabel("Current password confirmation")).toHaveValue("");
  await expect(panel.getByLabel("Retry reason")).toHaveValue("");
});

test("notifications.read alone loads the complete queue without exposing retry controls", async ({ page }) => {
  let listGets = 0;
  await routeApplication(page, {
    permissions: ["notifications.read"],
    onNotificationRequest: async (route) => {
      expect(route.request().method()).toBe("GET");
      listGets += 1;
      await route.fulfill({ headers, json: snapshot(false) });
    },
  });
  await page.goto("/admin");
  const panel = page.getByTestId("notification-operations");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("notification-attention-queue")).toContainText(
    "synthetic-customer@example.invalid",
  );
  await expect(panel.getByTestId("notification-retry-controls")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Controlled single retry" })).toHaveCount(0);
  expect(listGets).toBeGreaterThanOrEqual(1);
});

test("notifications.retry alone cannot enter Admin and sends zero queue requests", async ({ page }) => {
  let notificationRequests = 0;
  await routeApplication(page, {
    permissions: ["notifications.retry"],
    onNotificationRequest: async (route) => {
      notificationRequests += 1;
      await route.fulfill({ headers, json: snapshot(false) });
    },
  });
  await page.goto("/admin");
  await expect(page.getByTestId("admin-access-restricted")).toContainText(
    "Access denied — Staff permission required",
  );
  await expect(page.getByTestId("notification-operations")).toHaveCount(0);
  expect(notificationRequests).toBe(0);
});

test("Staff with zero notification permissions sends zero Notification Operations requests", async ({ page }) => {
  let notificationRequests = 0;
  await routeApplication(page, {
    permissions: ["content.read"],
    onNotificationRequest: async (route) => {
      notificationRequests += 1;
      await route.fulfill({ headers, json: snapshot(false) });
    },
  });
  await page.goto("/admin");
  await expect(page.getByTestId("limited-admin-scope")).toBeVisible();
  await expect(page.getByTestId("notification-operations")).toHaveCount(0);
  expect(notificationRequests).toBe(0);
});

test("leaving Admin while reauthentication is pending prevents the retry request", async ({ page }) => {
  let releaseReauthentication!: () => void;
  const reauthenticationReleased = new Promise<void>((resolve) => {
    releaseReauthentication = resolve;
  });
  let markReauthenticationStarted!: () => void;
  const reauthenticationStarted = new Promise<void>((resolve) => {
    markReauthenticationStarted = resolve;
  });
  let markReauthenticationCompleted!: () => void;
  const reauthenticationCompleted = new Promise<void>((resolve) => {
    markReauthenticationCompleted = resolve;
  });
  let retryPosts = 0;
  await routeApplication(page, {
    permissions: ["notifications.read", "notifications.retry"],
    onReauthRequest: async (route) => {
      markReauthenticationStarted();
      await reauthenticationReleased;
      await route.fulfill({ headers, json: { expiresAt: "2026-08-20T08:15:00.000Z" } });
      markReauthenticationCompleted();
    },
    onNotificationRequest: async (route) => {
      if (route.request().method() === "POST") retryPosts += 1;
      await route.fulfill({ headers, json: snapshot(false) });
    },
  });

  await page.goto("/admin");
  const panel = page.getByTestId("notification-operations");
  await expect(panel).toBeVisible();
  await panel.getByLabel("Current password confirmation").fill("Synthetic-Staff-Password!");
  await panel.getByLabel("Retry reason").fill("Recipient facts reviewed before leaving");
  await panel.getByRole("button", { name: "Controlled single retry" }).click();
  await reauthenticationStarted;
  await page.getByRole("link", { name: "Home", exact: true }).click();
  releaseReauthentication();
  await reauthenticationCompleted;
  await page.waitForTimeout(100);

  await expect(page.getByTestId("notification-operations")).toHaveCount(0);
  expect(retryPosts).toBe(0);
  await expect(page.getByText(/Notification retry committed|Notification retry failed/)).toHaveCount(0);
});

test("a retry committed after leaving Admin cannot refresh or publish stale UI state", async ({ page }) => {
  let releaseRetry!: () => void;
  const retryReleased = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  let markRetryStarted!: () => void;
  const retryStarted = new Promise<void>((resolve) => {
    markRetryStarted = resolve;
  });
  let markRetryCompleted!: () => void;
  const retryCompleted = new Promise<void>((resolve) => {
    markRetryCompleted = resolve;
  });
  let listGets = 0;
  await routeApplication(page, {
    permissions: ["notifications.read", "notifications.retry"],
    onNotificationRequest: async (route) => {
      if (route.request().method() === "GET") {
        listGets += 1;
        await route.fulfill({ headers, json: snapshot(false) });
        return;
      }
      markRetryStarted();
      await retryReleased;
      await route.fulfill({
        status: 201,
        headers,
        json: {
          outboxId,
          failedAttemptNumber: 1,
          jobStatus: "pending",
          jobUpdatedAt: "2026-08-20T08:01:00.000001Z",
        },
      });
      markRetryCompleted();
    },
  });

  await page.goto("/admin");
  const panel = page.getByTestId("notification-operations");
  await expect(panel).toBeVisible();
  await panel.getByLabel("Current password confirmation").fill("Synthetic-Staff-Password!");
  await panel.getByLabel("Retry reason").fill("Recipient facts reviewed before leaving");
  await panel.getByRole("button", { name: "Controlled single retry" }).click();
  await retryStarted;
  const listGetsBeforeLeaving = listGets;
  await page.getByRole("link", { name: "Home", exact: true }).click();
  releaseRetry();
  await retryCompleted;
  await page.waitForTimeout(100);

  await expect(page.getByTestId("notification-operations")).toHaveCount(0);
  expect(listGets).toBe(listGetsBeforeLeaving);
  await expect(page.getByText(/Notification retry committed|Notification retry failed/)).toHaveCount(0);
});

test("a slow previous Staff snapshot cannot replace the current Staff snapshot", async ({ page }) => {
  const permissions = ["accounts.view", "notifications.read"];
  const staffA = viewer(permissions, {
    id: "20000000-0000-4000-8000-00000000000a",
    email: "notification-staff-a@example.invalid",
  });
  const staffB = viewer(permissions, {
    id: "20000000-0000-4000-8000-00000000000b",
    email: "notification-staff-b@example.invalid",
  });
  let currentViewer = staffA;
  let releaseStaffA!: () => void;
  const staffAReleased = new Promise<void>((resolve) => {
    releaseStaffA = resolve;
  });
  let markStaffAStarted!: () => void;
  const staffAStarted = new Promise<void>((resolve) => {
    markStaffAStarted = resolve;
  });
  let staffARequestCount = 0;
  let staffAResponseCount = 0;
  await routeApplication(page, {
    permissions,
    currentViewer: () => currentViewer,
    onNotificationRequest: async (route) => {
      if (currentViewer.id === staffA.id) {
        staffARequestCount += 1;
        markStaffAStarted();
        await staffAReleased;
        await route.fulfill({ headers, json: snapshot(false, "staff-a-customer@example.invalid") });
        staffAResponseCount += 1;
        return;
      }
      await route.fulfill({ headers, json: snapshot(false, "staff-b-customer@example.invalid") });
    },
  });

  await page.goto("/admin");
  await staffAStarted;
  const expectedStaffAResponses = staffARequestCount;
  currentViewer = staffB;
  await page.getByTestId("client-account-360").getByRole("button", { name: "Refresh Staff access" }).click();
  const panel = page.getByTestId("notification-operations");
  await expect(panel.getByTestId("notification-attention-queue")).toContainText(
    "staff-b-customer@example.invalid",
  );
  releaseStaffA();
  await expect.poll(() => staffAResponseCount).toBe(expectedStaffAResponses);
  await page.waitForTimeout(100);

  await expect(panel.getByTestId("notification-attention-queue")).toContainText(
    "staff-b-customer@example.invalid",
  );
  await expect(panel.getByTestId("notification-attention-queue")).not.toContainText(
    "staff-a-customer@example.invalid",
  );
});
