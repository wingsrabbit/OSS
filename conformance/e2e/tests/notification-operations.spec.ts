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

function viewer(permissions: string[]) {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    email: "notification-staff@example.invalid",
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

function snapshot(retried: boolean) {
  const delivery = {
    source: "standard",
    operationId,
    outboxId,
    attemptNumber: 1,
    eventType: "notification.email_verification_requested",
    templateRevision: "email-verification-v1",
    category: "identity",
    recipientKind: "identity_user",
    recipient: "synthetic-customer@example.invalid",
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
    onNotificationRequest?: (route: Route) => Promise<void>;
  }>,
) {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/v1/auth/me") {
      await route.fulfill({ headers, json: viewer(input.permissions) });
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
        json: { requestedLocale: "en", documents: { terms: null, aup: null, privacy: null } },
      });
      return;
    }
    if (path === "/api/v1/content") {
      await route.fulfill({ json: { requestedLocale: "en", items: [] } });
      return;
    }
    if (path === "/api/v1/auth/reauth") {
      await route.fulfill({ headers, json: { expiresAt: "2026-08-20T08:15:00.000Z" } });
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
    onNotificationRequest: async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "GET") {
        await route.fulfill({ headers, json: snapshot(retried) });
        return;
      }
      expect(path).toBe(`/api/v1/admin/notification-operations/${outboxId}/retry`);
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({
        reason: "Recipient facts reviewed for one normal retry",
        expectedJobUpdatedAt: jobUpdatedAt,
      });
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
  expect(listGets).toBe(1);
});
