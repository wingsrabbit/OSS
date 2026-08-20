// SPDX-License-Identifier: AGPL-3.0-or-later

export const NOTIFICATION_PREFERENCE_CATEGORIES = [
  "identity",
  "transactional",
  "high_risk",
  "billing",
  "service",
  "support",
] as const;

export type NotificationPreferenceCategory =
  (typeof NOTIFICATION_PREFERENCE_CATEGORIES)[number];
export type NotificationTemplateLocale = "en" | "zh-CN";

export type NotificationTemplateRevision = Readonly<{
  revisionId: string;
  eventType: string;
  revisionKey: string;
  providerTemplateRef: string;
  templateLocale: NotificationTemplateLocale;
  requestedLocale: NotificationTemplateLocale;
  fallback: boolean;
  preferenceCategory: NotificationPreferenceCategory;
  requiredDelivery: boolean;
  sensitive: boolean;
  subjectTemplate: string;
  bodyTemplate: string;
}>;

export type NotificationTemplateValue = string | number | bigint;

function textValue(value: NotificationTemplateValue, key: string): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error(`Notification template variable ${key} must be a safe integer`);
  }
  return String(value);
}

function renderPart(
  template: string,
  values: Readonly<Record<string, NotificationTemplateValue | undefined>>,
): string {
  const rendered = template.replace(
    /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g,
    (_placeholder, key: string) => {
      const value = values[key];
      if (value === undefined) {
        throw new Error(`Notification template variable ${key} is unavailable`);
      }
      return textValue(value, key);
    },
  );
  if (rendered.includes("{{") || rendered.includes("}}")) {
    throw new Error("Notification template contains an invalid placeholder");
  }
  return rendered;
}

export function renderNotificationTemplate(
  revision: NotificationTemplateRevision,
  values: Readonly<Record<string, NotificationTemplateValue | undefined>>,
): Readonly<{
  template: string;
  subject: string;
  body: string;
  sensitive: boolean;
}> {
  const subject = renderPart(revision.subjectTemplate, values);
  const body = renderPart(revision.bodyTemplate, values);
  if (subject.length < 1 || subject.length > 240) {
    throw new Error("Rendered notification subject is outside the supported size");
  }
  if (
    body.length < 1 ||
    body.length > 20_000 ||
    !body.startsWith("NOT FOR PRODUCTION — MOCK PROVIDERS ONLY")
  ) {
    throw new Error("Rendered notification body is outside the Mock-only contract");
  }
  return {
    template: revision.providerTemplateRef,
    subject,
    body,
    sensitive: revision.sensitive,
  };
}
