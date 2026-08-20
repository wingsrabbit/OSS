// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Page, type Route } from "@playwright/test";
import {
  fulfillNotificationInterfaceRequest,
  notificationPreferencesMockState,
} from "./helpers/notification-interfaces.js";

const contentEntryId = "10000000-0000-4000-8000-000000000001";
const contentRevisionId = "10000000-0000-4000-8000-000000000002";
const legalDocumentId = "20000000-0000-4000-8000-000000000001";
const publishedAt = "2026-08-13T12:00:00.000Z";
const establishedSessionHeaders = {
  "X-OSS-Account-Context-Version": "1",
  "X-OSS-Authorization-Epoch": "1",
};

function legal(locale: "en" | "zh-CN") {
  const document = (
    kind: "terms" | "aup" | "privacy",
    index: number,
    resolvedLocale: "en" | "zh-CN" = locale,
  ) => ({
    id: `20000000-0000-4000-8000-00000000000${index}`,
    documentId: `20000000-0000-4000-8000-00000000000${index}`,
    kind,
    requestedLocale: locale,
    locale: resolvedLocale,
    fallback: resolvedLocale !== locale,
    revision: "1",
    version: "mock-lab-v1",
    title:
      resolvedLocale === "zh-CN"
        ? kind === "terms" ? "Mock 实验室条款" : kind === "aup" ? "Mock 实验室 AUP" : "Mock 实验室隐私说明"
        : kind === "terms" ? "Mock Laboratory Terms" : kind === "aup" ? "Mock Laboratory AUP" : "Mock Laboratory Privacy",
    body: resolvedLocale === "zh-CN" ? "仅用于合成 Mock-only 验收。" : "Synthetic Mock-only acceptance text.",
    publishedAt,
  });
  return {
    requestedLocale: locale,
    documents: {
      terms: document("terms", 1, locale === "zh-CN" ? "en" : "en"),
      aup: document("aup", 2),
      privacy: document("privacy", 3),
    },
  };
}

function publishedContent(locale: "en" | "zh-CN", customer: boolean) {
  const items = [
    {
      entryId: contentEntryId,
      revisionId: contentRevisionId,
      slug: "mock-laboratory-welcome",
      kind: "announcement",
      audience: "public",
      requestedLocale: locale,
      locale,
      fallback: false,
      revision: "1",
      title: locale === "zh-CN" ? "欢迎使用 Mock 实验室" : "Welcome to the Mock Laboratory",
      summary: locale === "zh-CN" ? "合成更新。" : "Synthetic updates.",
      body: locale === "zh-CN" ? "仅包含合成内容。" : "Only synthetic content is shown.",
      statusLevel: "information",
      publishedAt,
    },
  ];
  if (customer) {
    items.push({
      ...items[0]!,
      entryId: "10000000-0000-4000-8000-000000000003",
      revisionId: "10000000-0000-4000-8000-000000000004",
      slug: "mock-laboratory-guide",
      kind: "knowledge_base",
      audience: "customer",
      title: locale === "zh-CN" ? "Mock 实验室指南" : "Mock Laboratory Guide",
    });
  }
  return { requestedLocale: locale, items };
}

function viewer(permissions: string[], locale: "en" | "zh-CN" = "en") {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    email: "content-staff@example.invalid",
    locale,
    clientAccountId: null,
    membershipRole: null,
    accountContextVersion: "1",
    authorizationEpoch: "1",
    context: null,
    verification: { email: "passed" },
    restrictions: { user: false, clientAccount: false },
    eligible: false,
    staff: permissions.length > 0 ? { roles: ["content"], permissions } : null,
  };
}

function adminSnapshot(published: boolean) {
  return {
    entries: [{
      id: contentEntryId,
      slug: "browser-draft",
      kind: "announcement",
      audience: "public",
      locale: "en",
      current_revision_id: published ? contentRevisionId : null,
      revision_sequence: "1",
    }],
    revisions: [{
      id: contentRevisionId,
      entry_id: contentEntryId,
      locale: "en",
      revision: "1",
      title: "Browser reviewed draft",
      summary: "Synthetic browser revision",
      body: "Mock-only body",
      status_level: "information",
      published_at: published ? publishedAt : null,
      retired_at: null,
    }],
    legalDocuments: [{
      id: legalDocumentId,
      kind: "terms",
      locale: "en",
      revision: "1",
      version: "mock-lab-v1",
      title: "Required English Terms fallback",
      body: "Synthetic Mock-only acceptance text.",
      published_at: publishedAt,
      retired_at: null,
      current: true,
    }],
  };
}

async function routeCommon(
  page: Page,
  options: Readonly<{
    permissions?: string[];
    customer?: boolean;
    viewerLocale?: () => "en" | "zh-CN";
    onLocaleChange?: (locale: "en" | "zh-CN") => void;
    admin?: (route: Route, path: string) => Promise<boolean>;
  }> = {},
) {
  const notificationPreferences = notificationPreferencesMockState();
  await page.route("**/api/v1/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const path = requestUrl.pathname;
    const locale = requestUrl.searchParams.get("locale") === "zh-CN" ? "zh-CN" : "en";
    const sessionHeaders = options.permissions === undefined
      ? {}
      : establishedSessionHeaders;
    if (options.admin && await options.admin(route, path)) return;
    if (await fulfillNotificationInterfaceRequest(route, {
      customerPreferences: options.permissions !== undefined,
      adminTemplates:
        options.permissions?.includes("*") === true ||
        options.permissions?.includes("notifications.templates.read") === true,
      preferenceState: notificationPreferences,
      headers: sessionHeaders,
    })) return;
    if (path === "/api/v1/catalog") {
      await route.fulfill({ json: { products: [] } });
      return;
    }
    if (path === "/api/v1/legal/current") {
      await route.fulfill({ json: legal(locale) });
      return;
    }
    if (path === "/api/v1/content") {
      await route.fulfill({ json: publishedContent(locale, false) });
      return;
    }
    if (path === "/api/v1/customer/content") {
      await route.fulfill({ headers: sessionHeaders, json: publishedContent(locale, true) });
      return;
    }
    if (path === "/api/v1/auth/me") {
      await route.fulfill({
        headers: sessionHeaders,
        json: viewer(options.permissions ?? [], options.viewerLocale?.() ?? "en"),
      });
      return;
    }
    if (path === "/api/v1/auth/locale" && route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { locale?: unknown };
      if (body.locale !== "en" && body.locale !== "zh-CN") {
        await route.fulfill({ status: 400, headers: sessionHeaders, json: { error: "Invalid locale" } });
        return;
      }
      options.onLocaleChange?.(body.locale);
      await route.fulfill({ headers: sessionHeaders, json: { locale: body.locale } });
      return;
    }
    if (path === "/api/v1/auth/account-contexts") {
      await route.fulfill({
        headers: sessionHeaders,
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
    await route.fulfill({ status: 404, json: { error: `Unmocked ${path}` } });
  });
}

test("public and Customer pages render only resolved published bilingual Content and legal revisions", async ({ page }) => {
  await routeCommon(page, {
    permissions: [],
    viewerLocale: () => "zh-CN",
  });
  await page.goto("/");
  await expect(page.getByTestId("content-mock-laboratory-welcome")).toContainText("Welcome to the Mock Laboratory");
  await expect(page.getByTestId("content-mock-laboratory-guide")).toHaveCount(0);
  await expect(page.getByTestId("legal-terms")).toContainText("Mock Laboratory Terms");
  await expect(page.getByTestId("legal-aup")).toBeVisible();
  await expect(page.getByTestId("legal-privacy")).toBeVisible();

  await page.getByRole("button", { name: "简体中文" }).click();
  await expect(page.getByTestId("content-mock-laboratory-welcome")).toContainText("欢迎使用 Mock 实验室");
  await expect(page.getByTestId("content-mock-laboratory-welcome").getByText("公告", { exact: true })).toBeVisible();
  await expect(page.getByTestId("legal-terms")).toContainText("英文回退");

  await page.getByRole("link", { name: "Customer", exact: true }).click();
  await expect(page.getByTestId("content-mock-laboratory-guide")).toContainText("Mock 实验室指南");
  await expect(page.getByTestId("content-mock-laboratory-guide").getByText("知识库", { exact: true })).toBeVisible();
  await expect(page.getByTestId("legal-privacy")).toContainText("Mock 实验室隐私说明");
});

test("the saved User locale survives Customer refresh and a persisted language change", async ({ page }) => {
  let persistedLocale: "en" | "zh-CN" = "zh-CN";
  const updates: Array<"en" | "zh-CN"> = [];
  await routeCommon(page, {
    permissions: [],
    viewerLocale: () => persistedLocale,
    onLocaleChange: (next) => {
      persistedLocale = next;
      updates.push(next);
    },
  });

  await page.goto("/customer");
  await expect(page.getByTestId("content-mock-laboratory-guide")).toContainText("Mock 实验室指南");
  await expect(page.getByRole("button", { name: "English" })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("content-mock-laboratory-guide")).toContainText("Mock 实验室指南");

  await page.getByRole("button", { name: "English" }).click();
  await expect.poll(() => persistedLocale).toBe("en");
  expect(updates).toEqual(["en"]);
  await page.reload();
  await expect(page.getByTestId("content-mock-laboratory-guide")).toContainText("Mock Laboratory Guide");
  await expect(page.getByRole("button", { name: "简体中文" })).toBeVisible();
});

test("login adopts the saved User locale before rendering its success notice", async ({ page }) => {
  let signedIn = false;
  const notificationPreferences = notificationPreferencesMockState();
  await page.route("**/api/v1/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const path = requestUrl.pathname;
    const locale = requestUrl.searchParams.get("locale") === "zh-CN" ? "zh-CN" : "en";
    if (await fulfillNotificationInterfaceRequest(route, {
      customerPreferences: signedIn,
      adminTemplates: false,
      preferenceState: notificationPreferences,
      headers: establishedSessionHeaders,
    })) return;
    if (path === "/api/v1/catalog") {
      await route.fulfill({ json: { products: [] } });
      return;
    }
    if (path === "/api/v1/legal/current") {
      await route.fulfill({ json: legal(locale) });
      return;
    }
    if (path === "/api/v1/content") {
      await route.fulfill({ json: publishedContent(locale, false) });
      return;
    }
    if (path === "/api/v1/customer/content") {
      await route.fulfill({
        status: signedIn ? 200 : 401,
        ...(signedIn ? { headers: establishedSessionHeaders } : {}),
        json: signedIn ? publishedContent(locale, true) : { error: "Authentication required" },
      });
      return;
    }
    if (path === "/api/v1/auth/login" && route.request().method() === "POST") {
      signedIn = true;
      await route.fulfill({
        headers: establishedSessionHeaders,
        json: { requiresAccountContext: false },
      });
      return;
    }
    if (path === "/api/v1/auth/me") {
      if (!signedIn) {
        await route.fulfill({ status: 401, json: { error: "Authentication required" } });
      } else {
        await route.fulfill({ headers: establishedSessionHeaders, json: viewer([], "zh-CN") });
      }
      return;
    }
    if (path === "/api/v1/auth/account-contexts" && signedIn) {
      await route.fulfill({
        headers: establishedSessionHeaders,
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
    await route.fulfill({ status: 404, json: { error: `Unmocked ${path}` } });
  });

  await page.goto("/customer");
  await page.getByPlaceholder("Email").last().fill("saved-zh@example.invalid");
  await page.getByPlaceholder("Password", { exact: true }).fill("Synthetic-Saved-Zh-Password!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/customer$/u);
  await expect(page.locator("main > .notice")).toContainText("已登录。");
  await expect(page.getByRole("button", { name: "English" })).toBeVisible();
  await expect(page.getByTestId("content-mock-laboratory-guide")).toContainText("Mock 实验室指南");
});

test("ordinary login routes a content.read-only Staff reviewer to Content Operations", async ({ page }) => {
  let signedIn = false;
  await page.route("**/api/v1/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const path = requestUrl.pathname;
    const locale = requestUrl.searchParams.get("locale") === "zh-CN" ? "zh-CN" : "en";
    if (path === "/api/v1/catalog") {
      await route.fulfill({ json: { products: [] } });
      return;
    }
    if (path === "/api/v1/legal/current") {
      await route.fulfill({ json: legal(locale) });
      return;
    }
    if (path === "/api/v1/content") {
      await route.fulfill({ json: publishedContent(locale, false) });
      return;
    }
    if (path === "/api/v1/auth/login" && route.request().method() === "POST") {
      signedIn = true;
      await route.fulfill({
        headers: establishedSessionHeaders,
        json: { requiresAccountContext: false },
      });
      return;
    }
    if (path === "/api/v1/auth/me") {
      if (!signedIn) {
        await route.fulfill({ status: 401, json: { error: "Authentication required" } });
      } else {
        await route.fulfill({
          headers: establishedSessionHeaders,
          json: viewer(["content.read"]),
        });
      }
      return;
    }
    if (path === "/api/v1/auth/account-contexts") {
      await route.fulfill({
        headers: establishedSessionHeaders,
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
    if (path === "/api/v1/admin/content") {
      await route.fulfill({
        headers: establishedSessionHeaders,
        json: adminSnapshot(false),
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Unmocked ${path}` } });
  });

  await page.goto("/");
  await page.getByPlaceholder("Email").last().fill("content-reviewer@example.invalid");
  await page.getByPlaceholder("Password", { exact: true }).fill("Synthetic-Content-Reviewer!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page).toHaveURL(/\/admin$/u);
  await expect(page.getByTestId("content-operations")).toBeVisible();
  await expect(page.getByText("Browser reviewed draft")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create Content entry" })).toHaveCount(0);
});

test("a late English catalog and legal response cannot overwrite the saved Chinese locale", async ({ page }) => {
  let oldRequests = 0;
  let markOldRequestsStarted!: () => void;
  let releaseOldRequests!: () => void;
  const oldRequestsStarted = new Promise<void>((resolve) => {
    markOldRequestsStarted = resolve;
  });
  const oldRequestGate = new Promise<void>((resolve) => {
    releaseOldRequests = resolve;
  });
  await routeCommon(page, {
    permissions: [],
    viewerLocale: () => "zh-CN",
    admin: async (route, path) => {
      if (path !== "/api/v1/catalog" && path !== "/api/v1/legal/current") return false;
      const locale = new URL(route.request().url()).searchParams.get("locale") === "zh-CN"
        ? "zh-CN"
        : "en";
      if (locale === "en") {
        oldRequests += 1;
        if (oldRequests === 2) markOldRequestsStarted();
        await oldRequestGate;
      }
      if (path === "/api/v1/catalog") {
        await route.fulfill({ json: { products: [] } });
      } else {
        await route.fulfill({ json: legal(locale) });
      }
      return true;
    },
  });

  await page.goto("/customer");
  await oldRequestsStarted;
  await expect(page.getByTestId("legal-privacy")).toContainText("Mock 实验室隐私说明");
  releaseOldRequests();
  await page.waitForTimeout(100);
  await expect(page.getByTestId("legal-privacy")).toContainText("Mock 实验室隐私说明");
  await expect(page.getByTestId("legal-privacy")).not.toContainText("Mock Laboratory Privacy");
});

test("Catalog and Legal failures do not discard the other successful public result", async ({ page }) => {
  await page.route("**/api/v1/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const path = requestUrl.pathname;
    const locale = requestUrl.searchParams.get("locale") === "zh-CN" ? "zh-CN" : "en";
    if (path === "/api/v1/content") {
      await route.fulfill({ json: publishedContent(locale, false) });
      return;
    }
    if (path === "/api/v1/catalog") {
      if (locale === "en") {
        await route.fulfill({ status: 503, json: { error: "Synthetic Catalog unavailable" } });
      } else {
        await route.fulfill({
          json: {
            products: [{
              id: "partial-product",
              groupId: "partial-group",
              groupName: "部分成功目录",
              name: "独立加载的中文方案",
              description: "法律读取失败时仍显示的合成目录。",
              fulfillmentMode: "automatic",
              optionSchema: [],
              purchasable: true,
              prices: [{
                id: "partial-price",
                currency: "USD",
                billingCycle: "monthly",
                oneTimeMinor: "0",
                setupMinor: "0",
                recurringMinor: "100",
              }],
            }],
          },
        });
      }
      return;
    }
    if (path === "/api/v1/legal/current") {
      if (locale === "en") {
        await route.fulfill({ json: legal("en") });
      } else {
        await route.fulfill({ status: 503, json: { error: "Synthetic Legal unavailable" } });
      }
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Unmocked ${path}` } });
  });

  await page.goto("/");
  await expect(page.getByTestId("legal-terms")).toContainText("Mock Laboratory Terms");
  await page.getByRole("button", { name: "简体中文" }).click();
  await expect(page.getByRole("heading", { name: "独立加载的中文方案" })).toBeVisible();
  await expect(page.getByTestId("legal-terms")).toHaveCount(0);
  await expect(page.locator(".notice.error")).toContainText("Synthetic Legal unavailable");
});

test("content.read mounts immutable history without any manage control or write request", async ({ page }) => {
  const requested: string[] = [];
  await routeCommon(page, {
    permissions: ["content.read"],
    admin: async (route, path) => {
      if (path === "/api/v1/admin/content") {
        requested.push(`${route.request().method()} ${path}`);
        await route.fulfill({
          headers: establishedSessionHeaders,
          json: adminSnapshot(false),
        });
        return true;
      }
      return false;
    },
  });
  await page.goto("/admin");
  await expect(page.getByTestId("content-operations")).toBeVisible();
  await expect(page.getByText("Browser reviewed draft")).toBeVisible();
  await expect(page.getByTestId(`content-revision-context-${contentRevisionId}`)).toHaveText(
    "browser-draft · Announcement · Public · en · r1",
  );
  await expect(page.getByTestId(`content-revision-body-${contentRevisionId}`)).toHaveText("Mock-only body");
  await expect(page.getByTestId(`legal-revision-body-${legalDocumentId}`)).toHaveText("Synthetic Mock-only acceptance text.");
  await expect(page.getByRole("heading", { name: "Create Content entry" })).toHaveCount(0);
  await expect(page.getByLabel("Current password confirmation")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toHaveCount(0);
  expect(requested).toEqual(["GET /api/v1/admin/content"]);
});

test("content.manage reauthenticates then publishes an immutable draft and refreshes history", async ({ page }) => {
  const mutations: string[] = [];
  let published = false;
  await routeCommon(page, {
    permissions: ["content.read", "content.manage"],
    admin: async (route, path) => {
      if (path === "/api/v1/admin/content") {
        await route.fulfill({
          headers: establishedSessionHeaders,
          json: adminSnapshot(published),
        });
        return true;
      }
      if (path === "/api/v1/auth/reauth") {
        mutations.push(`${route.request().method()} ${path}`);
        expect(route.request().postDataJSON()).toEqual({ password: "Synthetic-Browser-Reauth!" });
        await route.fulfill({
          headers: establishedSessionHeaders,
          json: { expiresAt: "2026-08-13T12:15:00.000Z", fixedWindowMinutes: 15 },
        });
        return true;
      }
      if (path === `/api/v1/admin/content/revisions/${contentRevisionId}/publication`) {
        mutations.push(`${route.request().method()} ${path}`);
        published = true;
        await route.fulfill({
          status: 201,
          headers: establishedSessionHeaders,
          json: { entryId: contentEntryId, locale: "en", replayed: false },
        });
        return true;
      }
      return false;
    },
  });
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Create Content entry" })).toBeVisible();
  await page.getByLabel("Current password confirmation").fill("Synthetic-Browser-Reauth!");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Content fact committed.")).toBeVisible();
  await expect(page.getByText("published", { exact: true })).toBeVisible();
  expect(mutations).toEqual([
    "POST /api/v1/auth/reauth",
    `POST /api/v1/admin/content/revisions/${contentRevisionId}/publication`,
  ]);
});

test("all three immutable create forms reset only after success and never raise a page error", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const mutations: string[] = [];
  let legalAttempts = 0;
  await routeCommon(page, {
    permissions: ["content.read", "content.manage"],
    admin: async (route, path) => {
      if (path === "/api/v1/admin/content") {
        await route.fulfill({ headers: establishedSessionHeaders, json: adminSnapshot(false) });
        return true;
      }
      if (path === "/api/v1/auth/reauth") {
        await route.fulfill({
          headers: establishedSessionHeaders,
          json: { expiresAt: "2026-08-13T12:15:00.000Z", fixedWindowMinutes: 15 },
        });
        return true;
      }
      if (route.request().method() === "POST" && path === "/api/v1/admin/content/entries") {
        mutations.push(path);
        await route.fulfill({
          status: 201,
          headers: establishedSessionHeaders,
          json: { entryId: contentEntryId, revision: { id: contentRevisionId } },
        });
        return true;
      }
      if (
        route.request().method() === "POST" &&
        path === `/api/v1/admin/content/entries/${contentEntryId}/revisions`
      ) {
        mutations.push(path);
        await route.fulfill({
          status: 201,
          headers: establishedSessionHeaders,
          json: { entryId: contentEntryId, revision: { id: contentRevisionId } },
        });
        return true;
      }
      if (route.request().method() === "POST" && path === "/api/v1/admin/legal/documents") {
        legalAttempts += 1;
        mutations.push(`${path}:${legalAttempts}`);
        if (legalAttempts === 1) {
          await route.fulfill({
            status: 409,
            headers: establishedSessionHeaders,
            json: { error: "Synthetic legal conflict", code: "CONTENT_CONFLICT" },
          });
        } else {
          await route.fulfill({
            status: 201,
            headers: establishedSessionHeaders,
            json: { document: { id: legalDocumentId } },
          });
        }
        return true;
      }
      return false;
    },
  });
  await page.goto("/admin");

  const password = page.getByLabel("Current password confirmation");
  const entryForm = page.locator("form").filter({ hasText: "Create Content entry" });
  await password.fill("Synthetic-Browser-Reauth!");
  await entryForm.locator('[name="slug"]').fill("form-reset-proof");
  await entryForm.locator('[name="title"]').fill("Form reset proof");
  await entryForm.locator('[name="body"]').fill("Immutable body proof");
  await entryForm.locator('[name="reason"]').fill("Prove successful reset");
  await entryForm.getByRole("button", { name: "Create immutable draft" }).click();
  await expect(entryForm.locator('[name="slug"]')).toHaveValue("");

  const revisionForm = page.locator("form").filter({ hasText: "Append Content revision" });
  await password.fill("Synthetic-Browser-Reauth!");
  await revisionForm.locator('[name="title"]').fill("Appended body proof");
  await revisionForm.locator('[name="body"]').fill("Second immutable body");
  await revisionForm.locator('[name="reason"]').fill("Prove append reset");
  await revisionForm.getByRole("button", { name: "Append draft" }).click();
  await expect(revisionForm.locator('[name="title"]')).toHaveValue("");

  const legalForm = page.locator("form").filter({ hasText: "Append legal revision" });
  await password.fill("Synthetic-Browser-Reauth!");
  await legalForm.locator('[name="version"]').fill("mock-lab-v2");
  await legalForm.locator('[name="title"]').fill("Legal response-loss proof");
  await legalForm.locator('[name="body"]').fill("Synthetic legal body");
  await legalForm.locator('[name="reason"]').fill("Preserve failed form input");
  await legalForm.getByRole("button", { name: "Append legal draft" }).click();
  await expect(legalForm.locator('[name="version"]')).toHaveValue("mock-lab-v2");
  await legalForm.getByRole("button", { name: "Append legal draft" }).click();
  await expect(legalForm.locator('[name="version"]')).toHaveValue("");

  expect(mutations).toEqual([
    "/api/v1/admin/content/entries",
    `/api/v1/admin/content/entries/${contentEntryId}/revisions`,
    "/api/v1/admin/legal/documents:1",
    "/api/v1/admin/legal/documents:2",
  ]);
  expect(pageErrors).toEqual([]);
});

test("a committed immutable draft resets once even when the history refresh fails", async ({ page }) => {
  let committed = false;
  let createCalls = 0;
  await routeCommon(page, {
    permissions: ["content.read", "content.manage"],
    admin: async (route, path) => {
      if (path === "/api/v1/admin/content") {
        if (committed) {
          await route.fulfill({
            status: 503,
            headers: establishedSessionHeaders,
            json: { error: "Synthetic history refresh unavailable" },
          });
        } else {
          await route.fulfill({ headers: establishedSessionHeaders, json: adminSnapshot(false) });
        }
        return true;
      }
      if (path === "/api/v1/auth/reauth") {
        await route.fulfill({
          headers: establishedSessionHeaders,
          json: { expiresAt: "2026-08-13T12:15:00.000Z", fixedWindowMinutes: 15 },
        });
        return true;
      }
      if (route.request().method() === "POST" && path === "/api/v1/admin/content/entries") {
        createCalls += 1;
        committed = true;
        await route.fulfill({
          status: 201,
          headers: establishedSessionHeaders,
          json: { entryId: contentEntryId, revision: { id: contentRevisionId } },
        });
        return true;
      }
      return false;
    },
  });
  await page.goto("/admin");
  const form = page.locator("form").filter({ hasText: "Create Content entry" });
  await page.getByLabel("Current password confirmation").fill("Synthetic-Browser-Reauth!");
  await form.locator('[name="slug"]').fill("committed-before-refresh");
  await form.locator('[name="title"]').fill("Committed before refresh");
  await form.locator('[name="body"]').fill("Immutable committed body");
  await form.locator('[name="reason"]').fill("Prove the commit boundary");
  await form.getByRole("button", { name: "Create immutable draft" }).click();

  await expect(form.locator('[name="slug"]')).toHaveValue("");
  await expect(page.locator(".notice.error")).toContainText(
    "Content fact committed, but history refresh failed: Synthetic history refresh unavailable",
  );
  expect(createCalls).toBe(1);
});

test("the zh-CN Staff Content workspace translates controls, states, and actions", async ({ page }) => {
  await routeCommon(page, {
    permissions: ["content.read", "content.manage"],
    viewerLocale: () => "zh-CN",
    admin: async (route, path) => {
      if (path !== "/api/v1/admin/content") return false;
      await route.fulfill({ headers: establishedSessionHeaders, json: adminSnapshot(false) });
      return true;
    },
  });
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "创建内容条目" })).toBeVisible();
  await expect(page.getByRole("option", { name: "公告" }).first()).toBeAttached();
  await expect(page.getByRole("option", { name: "运行正常" }).first()).toBeAttached();
  await expect(page.getByRole("button", { name: "发布", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "退役", exact: true })).toBeVisible();
  await expect(page.getByText("草稿", { exact: true })).toBeVisible();
  await expect(page.getByText("当前版本", { exact: true })).toBeVisible();
  await expect(page.getByTestId(`content-revision-context-${contentRevisionId}`)).toHaveText(
    "browser-draft · 公告 · 公开 · en · r1",
  );
  await expect(page.getByTestId(`legal-history-${legalDocumentId}`).getByText(/条款 · en · r1/u)).toBeVisible();
});

test("Staff cannot retire the last English legal fallback and the real page remains renderable", async ({ page }) => {
  await routeCommon(page, {
    permissions: ["content.read", "content.manage"],
    admin: async (route, path) => {
      if (path === "/api/v1/admin/content") {
        await route.fulfill({
          headers: establishedSessionHeaders,
          json: adminSnapshot(false),
        });
        return true;
      }
      if (path === "/api/v1/auth/reauth") {
        await route.fulfill({
          headers: establishedSessionHeaders,
          json: { expiresAt: "2026-08-13T12:15:00.000Z", fixedWindowMinutes: 15 },
        });
        return true;
      }
      if (path === `/api/v1/admin/legal/documents/${legalDocumentId}/retirement`) {
        await route.fulfill({
          status: 409,
          headers: establishedSessionHeaders,
          json: {
            error: "The required English legal fallback can only be replaced by publishing a newer revision",
            code: "LEGAL_ENGLISH_FALLBACK_REQUIRED",
          },
        });
        return true;
      }
      return false;
    },
  });
  await page.goto("/admin");
  await page.getByLabel("Current password confirmation").fill("Synthetic-Browser-Reauth!");
  const legalHistory = page.getByTestId(`legal-history-${legalDocumentId}`);
  await expect(legalHistory).toContainText("Required English Terms fallback");
  await legalHistory.getByRole("button", { name: "Retire", exact: true }).click();
  await expect(page.getByText(/required English legal fallback can only be replaced/)).toBeVisible();
  await expect(legalHistory).toContainText("current");
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page.getByTestId("legal-terms")).toContainText("Mock Laboratory Terms");
  await expect(page.getByTestId("legal-aup")).toBeVisible();
  await expect(page.getByTestId("legal-privacy")).toBeVisible();
});
