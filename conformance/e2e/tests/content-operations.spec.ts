// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Page, type Route } from "@playwright/test";

const contentEntryId = "10000000-0000-4000-8000-000000000001";
const contentRevisionId = "10000000-0000-4000-8000-000000000002";
const legalDocumentId = "20000000-0000-4000-8000-000000000001";
const publishedAt = "2026-08-13T12:00:00.000Z";

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

function viewer(permissions: string[]) {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    email: "content-staff@example.invalid",
    locale: "en",
    clientAccountId: null,
    membershipRole: null,
    accountContextVersion: "1",
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
    admin?: (route: Route, path: string) => Promise<boolean>;
  }> = {},
) {
  await page.route("**/api/v1/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const path = requestUrl.pathname;
    const locale = requestUrl.searchParams.get("locale") === "zh-CN" ? "zh-CN" : "en";
    const sessionHeaders = options.permissions === undefined
      ? {}
      : { "X-OSS-Account-Context-Version": "1" };
    if (options.admin && await options.admin(route, path)) return;
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
      await route.fulfill({ headers: sessionHeaders, json: viewer(options.permissions ?? []) });
      return;
    }
    if (path === "/api/v1/auth/account-contexts") {
      await route.fulfill({
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
  await routeCommon(page, { permissions: [] });
  await page.goto("/");
  await expect(page.getByTestId("content-mock-laboratory-welcome")).toContainText("Welcome to the Mock Laboratory");
  await expect(page.getByTestId("content-mock-laboratory-guide")).toHaveCount(0);
  await expect(page.getByTestId("legal-terms")).toContainText("Mock Laboratory Terms");
  await expect(page.getByTestId("legal-aup")).toBeVisible();
  await expect(page.getByTestId("legal-privacy")).toBeVisible();

  await page.getByRole("button", { name: "简体中文" }).click();
  await expect(page.getByTestId("content-mock-laboratory-welcome")).toContainText("欢迎使用 Mock 实验室");
  await expect(page.getByTestId("legal-terms")).toContainText("英文回退");

  await page.getByRole("link", { name: "Customer", exact: true }).click();
  await expect(page.getByTestId("content-mock-laboratory-guide")).toContainText("Mock 实验室指南");
  await expect(page.getByTestId("legal-privacy")).toContainText("Mock 实验室隐私说明");
});

test("content.read mounts immutable history without any manage control or write request", async ({ page }) => {
  const requested: string[] = [];
  await routeCommon(page, {
    permissions: ["content.read"],
    admin: async (route, path) => {
      if (path === "/api/v1/admin/content") {
        requested.push(`${route.request().method()} ${path}`);
        await route.fulfill({
          headers: { "X-OSS-Account-Context-Version": "1" },
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
          headers: { "X-OSS-Account-Context-Version": "1" },
          json: adminSnapshot(published),
        });
        return true;
      }
      if (path === "/api/v1/auth/reauth") {
        mutations.push(`${route.request().method()} ${path}`);
        expect(route.request().postDataJSON()).toEqual({ password: "Synthetic-Browser-Reauth!" });
        await route.fulfill({
          headers: { "X-OSS-Account-Context-Version": "1" },
          json: { expiresAt: "2026-08-13T12:15:00.000Z", fixedWindowMinutes: 15 },
        });
        return true;
      }
      if (path === `/api/v1/admin/content/revisions/${contentRevisionId}/publication`) {
        mutations.push(`${route.request().method()} ${path}`);
        published = true;
        await route.fulfill({
          status: 201,
          headers: { "X-OSS-Account-Context-Version": "1" },
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

test("Staff cannot retire the last English legal fallback and the real page remains renderable", async ({ page }) => {
  await routeCommon(page, {
    permissions: ["content.read", "content.manage"],
    admin: async (route, path) => {
      if (path === "/api/v1/admin/content") {
        await route.fulfill({
          headers: { "X-OSS-Account-Context-Version": "1" },
          json: adminSnapshot(false),
        });
        return true;
      }
      if (path === "/api/v1/auth/reauth") {
        await route.fulfill({
          headers: { "X-OSS-Account-Context-Version": "1" },
          json: { expiresAt: "2026-08-13T12:15:00.000Z", fixedWindowMinutes: 15 },
        });
        return true;
      }
      if (path === `/api/v1/admin/legal/documents/${legalDocumentId}/retirement`) {
        await route.fulfill({
          status: 409,
          headers: { "X-OSS-Account-Context-Version": "1" },
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
