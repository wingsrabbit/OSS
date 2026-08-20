// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTIFICATION_PREFERENCE_CATEGORIES,
  renderNotificationTemplate,
  type NotificationTemplateRevision,
} from "./notification-templates.js";

const revision: NotificationTemplateRevision = {
  revisionId: "00000000-0000-4000-8000-000000000001",
  eventType: "notification.example",
  revisionKey: "example-v1",
  providerTemplateRef: "example-v1",
  templateLocale: "en",
  requestedLocale: "zh-CN",
  fallback: true,
  preferenceCategory: "support",
  requiredDelivery: false,
  sensitive: false,
  subjectTemplate: "Hello {{name}}",
  bodyTemplate: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\nTicket {{ticketId}}",
};

test("notification template rendering is deterministic and retains explicit fallback metadata", () => {
  assert.deepEqual(NOTIFICATION_PREFERENCE_CATEGORIES, [
    "identity",
    "transactional",
    "high_risk",
    "billing",
    "service",
    "support",
  ]);
  assert.deepEqual(renderNotificationTemplate(revision, {
    name: "Synthetic User",
    ticketId: "T-100",
  }), {
    template: "example-v1",
    subject: "Hello Synthetic User",
    body: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\nTicket T-100",
    sensitive: false,
  });
});

test("notification template rendering rejects missing values and non-safe numbers", () => {
  assert.throws(
    () => renderNotificationTemplate(revision, { name: "Synthetic User" }),
    /ticketId is unavailable/,
  );
  assert.throws(
    () => renderNotificationTemplate(revision, {
      name: "Synthetic User",
      ticketId: Number.MAX_SAFE_INTEGER + 1,
    }),
    /safe integer/,
  );
});
