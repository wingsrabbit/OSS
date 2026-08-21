// SPDX-License-Identifier: Apache-2.0

import type { Route } from "@playwright/test";

type PreferenceCategory = "identity" | "transactional" | "high_risk" | "billing" | "service" | "support";
type OptionalPreferenceCategory = "billing" | "service" | "support";

export type NotificationPreferencesMockState = {
  enabled: Record<OptionalPreferenceCategory, boolean>;
  versions: Record<OptionalPreferenceCategory, bigint>;
};

export function notificationPreferencesMockState(): NotificationPreferencesMockState {
  return {
    enabled: { billing: true, service: true, support: true },
    versions: { billing: 1n, service: 1n, support: 1n },
  };
}

const labels: Record<PreferenceCategory, { en: string; "zh-CN": string }> = {
  identity: { en: "Identity", "zh-CN": "身份" },
  transactional: { en: "Transactional", "zh-CN": "交易" },
  high_risk: { en: "High risk", "zh-CN": "高风险" },
  billing: { en: "Billing", "zh-CN": "账单" },
  service: { en: "Service", "zh-CN": "服务" },
  support: { en: "Support", "zh-CN": "支持" },
};

function preference(
  category: PreferenceCategory,
  state: NotificationPreferencesMockState,
) {
  const optional = category === "billing" || category === "service" || category === "support";
  return {
    category,
    label: labels[category],
    mandatory: !optional,
    enabled: optional ? state.enabled[category] : true,
    version: optional ? state.versions[category].toString() : "1",
  };
}

export function notificationPreferencesSnapshot(state: NotificationPreferencesMockState) {
  return {
    channel: "email" as const,
    categories: ([
      "identity",
      "transactional",
      "high_risk",
      "billing",
      "service",
      "support",
    ] as const).map((category) => preference(category, state)),
  };
}

export async function fulfillNotificationInterfaceRequest(
  route: Route,
  options: Readonly<{
    customerPreferences: boolean;
    adminTemplates: boolean;
    preferenceState: NotificationPreferencesMockState;
    headers?: Record<string, string>;
    templateRegistry?: unknown;
  }>,
): Promise<boolean> {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  const responseBase = options.headers ? { headers: options.headers } : {};

  if (
    options.customerPreferences &&
    request.method() === "GET" &&
    path === "/api/v1/customer/notification-preferences" &&
    url.search === "" &&
    request.postData() === null
  ) {
    await route.fulfill({
      ...responseBase,
      json: notificationPreferencesSnapshot(options.preferenceState),
    });
    return true;
  }

  const preferenceMatch = path.match(
    /^\/api\/v1\/customer\/notification-preferences\/(billing|service|support)\/email$/,
  );
  if (
    options.customerPreferences &&
    request.method() === "PUT" &&
    preferenceMatch &&
    url.search === ""
  ) {
    const category = preferenceMatch[1] as OptionalPreferenceCategory;
    const body = request.postDataJSON() as unknown;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).sort().join(",") !== "enabled,expectedVersion"
    ) return false;
    const preferenceBody = body as { enabled?: unknown; expectedVersion?: unknown };
    if (
      typeof preferenceBody.enabled !== "boolean" ||
      typeof preferenceBody.expectedVersion !== "string"
    ) return false;
    if (preferenceBody.expectedVersion !== options.preferenceState.versions[category].toString()) {
      await route.fulfill({
        ...responseBase,
        status: 409,
        json: { error: "Notification preference version changed" },
      });
      return true;
    }
    options.preferenceState.enabled[category] = preferenceBody.enabled;
    options.preferenceState.versions[category] += 1n;
    await route.fulfill({
      ...responseBase,
      json: preference(category, options.preferenceState),
    });
    return true;
  }

  if (
    options.adminTemplates &&
    request.method() === "GET" &&
    path === "/api/v1/admin/notification-templates" &&
    url.search === "" &&
    request.postData() === null
  ) {
    await route.fulfill({
      ...responseBase,
      json: options.templateRegistry ?? { events: [] },
    });
    return true;
  }

  return false;
}
