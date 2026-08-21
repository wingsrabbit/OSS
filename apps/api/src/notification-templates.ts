// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  NotificationPreferenceCategory,
  NotificationTemplateLocale,
  NotificationTemplateRevision,
} from "@opensales/core";
import type { DatabaseClient, DatabasePool } from "./database.js";

type TemplateRow = Readonly<{
  revision_id: string;
  event_type: string;
  revision_key: string;
  provider_template_ref: string;
  template_locale: NotificationTemplateLocale;
  preference_category: NotificationPreferenceCategory;
  required_delivery: boolean;
  sensitive: boolean;
  subject_template: string;
  body_template: string;
}>;

export async function resolveCurrentNotificationTemplate(
  database: Pick<DatabasePool, "query"> | DatabaseClient,
  eventType: string,
  requestedLocale: NotificationTemplateLocale,
): Promise<NotificationTemplateRevision> {
  const result = await database.query<TemplateRow>(
    `SELECT template.revision_id::text,
            template.event_type,
            template.revision_key,
            template.provider_template_ref,
            template.locale AS template_locale,
            template.preference_category,
            template.required_delivery,
            template.sensitive,
            template.subject_template,
            template.body_template
     FROM public.current_notification_templates template
     WHERE template.event_type = $1
       AND template.locale IN ($2::text, 'en')
     ORDER BY (template.locale = $2::text) DESC,
              template.locale COLLATE "C"
     LIMIT 1`,
    [eventType, requestedLocale],
  );
  const row = result.rows[0];
  if (!row) {
    throw Object.assign(
      new Error(`No published notification template is available for ${eventType}`),
      { statusCode: 503, code: "NOTIFICATION_TEMPLATE_UNAVAILABLE" },
    );
  }
  return {
    revisionId: row.revision_id,
    eventType: row.event_type,
    revisionKey: row.revision_key,
    providerTemplateRef: row.provider_template_ref,
    templateLocale: row.template_locale,
    requestedLocale,
    fallback: row.template_locale !== requestedLocale,
    preferenceCategory: row.preference_category,
    requiredDelivery: row.required_delivery,
    sensitive: row.sensitive,
    subjectTemplate: row.subject_template,
    bodyTemplate: row.body_template,
  };
}

export async function userNotificationPreferenceAllows(
  database: Pick<DatabasePool, "query"> | DatabaseClient,
  userId: string,
  category: NotificationPreferenceCategory,
  requiredDelivery: boolean,
): Promise<boolean> {
  if (requiredDelivery) return true;
  const result = await database.query<{ enabled: boolean }>(
    `SELECT preference.enabled
     FROM public.user_notification_preferences preference
     WHERE preference.user_id = $1
       AND preference.category = $2
       AND preference.channel = 'email'`,
    [userId, category],
  );
  return result.rows[0]?.enabled ?? true;
}
