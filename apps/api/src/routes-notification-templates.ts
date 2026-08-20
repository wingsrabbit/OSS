// SPDX-License-Identifier: AGPL-3.0-or-later

import { NOTIFICATION_PREFERENCE_CATEGORIES } from "@opensales/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assertIdentityReadEligible,
  lockSessionIdentityForMutation,
  requireSessionIdentity,
} from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabaseClient, type DatabasePool } from "./database.js";
import { requireStaffActionLocked, requireStaffPermission } from "./routes-admin.js";

const canonicalUuid = z.uuid().transform((value) => value.toLowerCase());
const localeSchema = z.enum(["en", "zh-CN"]);
const categorySchema = z.enum(NOTIFICATION_PREFERENCE_CATEGORIES);
const decimalVersion = z.string().regex(/^(0|[1-9]\d*)$/);
const reasonSchema = z.string().trim().min(3).max(1_000);
const eventTypeSchema = z
  .string()
  .regex(/^(notification|identity[.]notification)[.][a-z0-9_]+$/);
const preferenceParams = z.object({
  category: categorySchema,
  channel: z.literal("email"),
}).strict();
const preferenceBody = z.object({
  enabled: z.boolean(),
  expectedVersion: decimalVersion,
}).strict();
const eventParams = z.object({ eventType: eventTypeSchema }).strict();
const revisionParams = z.object({
  eventType: eventTypeSchema,
  revisionId: canonicalUuid,
}).strict();
const revisionBody = z.object({
  locale: localeSchema,
  subjectTemplate: z.string().trim().min(1).max(240),
  bodyTemplate: z.string().min(1).max(20_000).refine(
    (value) => value.startsWith("NOT FOR PRODUCTION — MOCK PROVIDERS ONLY"),
    "The Mock-only banner is required",
  ),
  reason: reasonSchema,
}).strict();
const publicationBody = z.object({
  reason: reasonSchema,
  expectedChannelVersion: decimalVersion,
}).strict();

type PreferenceRow = Readonly<{
  category: (typeof NOTIFICATION_PREFERENCE_CATEGORIES)[number];
  label: { en: string; "zh-CN": string };
  mandatory: boolean;
  enabled: boolean;
  version: string;
}>;

async function preferenceRows(
  database: Pick<DatabasePool, "query"> | DatabaseClient,
  userId: string,
): Promise<PreferenceRow[]> {
  const result = await database.query<PreferenceRow>(
    `SELECT category.category,
            category.label,
            category.required_delivery AS mandatory,
            COALESCE(preference.enabled, true) AS enabled,
            COALESCE(preference.version, 0)::text AS version
     FROM public.notification_preference_categories category
     LEFT JOIN public.user_notification_preferences preference
       ON preference.user_id = $1
      AND preference.category = category.category
      AND preference.channel = 'email'
     ORDER BY CASE category.category
       WHEN 'identity' THEN 1
       WHEN 'transactional' THEN 2
       WHEN 'high_risk' THEN 3
       WHEN 'billing' THEN 4
       WHEN 'service' THEN 5
       WHEN 'support' THEN 6
     END`,
    [userId],
  );
  return result.rows;
}

function preferenceJson(row: PreferenceRow) {
  return {
    category: row.category,
    label: row.label,
    mandatory: row.mandatory,
    enabled: row.mandatory ? true : row.enabled,
    version: row.version,
  };
}

function stalePreference(): Error {
  return Object.assign(
    new Error("Notification preference changed; refresh before saving"),
    { statusCode: 409, code: "NOTIFICATION_PREFERENCE_STALE" },
  );
}

function placeholders(value: string): readonly string[] {
  return [...value.matchAll(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g)].map(
    (match) => match[1]!,
  );
}

function assertTemplateContract(
  body: z.infer<typeof revisionBody>,
  allowedVariables: unknown,
  requiredVariables: unknown,
): void {
  if (
    !Array.isArray(allowedVariables) ||
    !allowedVariables.every((value) => typeof value === "string") ||
    !Array.isArray(requiredVariables) ||
    !requiredVariables.every((value) => typeof value === "string")
  ) throw new Error("Notification event variable contract is invalid");
  const allowed = new Set(allowedVariables);
  const used = new Set(placeholders(`${body.subjectTemplate}\n${body.bodyTemplate}`));
  for (const variable of used) {
    if (!allowed.has(variable)) {
      throw Object.assign(
        new Error(`Template variable ${variable} is not available for this event`),
        { statusCode: 400, code: "NOTIFICATION_TEMPLATE_VARIABLE_INVALID" },
      );
    }
  }
  for (const variable of requiredVariables) {
    if (!used.has(variable)) {
      throw Object.assign(
        new Error(`Template requires variable ${variable}`),
        { statusCode: 400, code: "NOTIFICATION_TEMPLATE_VARIABLE_REQUIRED" },
      );
    }
  }
  const remaining = `${body.subjectTemplate}\n${body.bodyTemplate}`.replace(
    /\{\{[A-Za-z][A-Za-z0-9]*\}\}/g,
    "",
  );
  if (remaining.includes("{{") || remaining.includes("}}")) {
    throw Object.assign(new Error("Template contains an invalid placeholder"), {
      statusCode: 400,
      code: "NOTIFICATION_TEMPLATE_PLACEHOLDER_INVALID",
    });
  }
}

function revisionKey(eventType: string, revisionNumber: string): string {
  const base = eventType
    .replace(/^identity[.]notification[.]|^notification[.]/, "")
    .replaceAll("_", "-")
    .slice(0, 64);
  return `${base}-v${revisionNumber}`;
}

async function templateSnapshot(pool: DatabasePool) {
  const [events, channels, revisions] = await Promise.all([
    pool.query<{
      event_type: string;
      preference_category: string;
      required_delivery: boolean;
      sensitive: boolean;
      allowed_variables: string[];
      required_variables: string[];
    }>(
      `SELECT event_type, preference_category, required_delivery, sensitive,
              allowed_variables, required_variables
       FROM public.notification_template_events
       ORDER BY event_type COLLATE "C"`,
    ),
    pool.query<{
      event_type: string;
      locale: "en" | "zh-CN";
      current_revision_id: string | null;
      current_revision_key: string | null;
      channel_version: string;
    }>(
      `SELECT channel.event_type, channel.locale,
              channel.current_revision_id::text,
              revision.revision_key AS current_revision_key,
              channel.version::text AS channel_version
       FROM public.notification_template_channels channel
       LEFT JOIN public.notification_template_revisions revision
         ON revision.id = channel.current_revision_id
       ORDER BY channel.event_type COLLATE "C", channel.locale COLLATE "C"`,
    ),
    pool.query<{
      id: string;
      event_type: string;
      locale: "en" | "zh-CN";
      revision_key: string;
      revision_number: string;
      subject_template: string;
      body_template: string;
      created_at: Date;
      published_at: Date | null;
      retired_at: Date | null;
    }>(
      `SELECT revision.id::text, revision.event_type, revision.locale,
              revision.revision_key, revision.revision_number::text,
              revision.subject_template, revision.body_template,
              revision.created_at, publication.published_at,
              retirement.retired_at
       FROM public.notification_template_revisions revision
       LEFT JOIN public.notification_template_publications publication
         ON publication.revision_id = revision.id
       LEFT JOIN public.notification_template_retirements retirement
         ON retirement.revision_id = revision.id
       ORDER BY revision.event_type COLLATE "C", revision.locale COLLATE "C",
                revision.revision_number DESC`,
    ),
  ]);
  return {
    events: events.rows.map((event) => {
      const eventChannels = channels.rows.filter(
        (channel) => channel.event_type === event.event_type,
      );
      const eventRevisions = revisions.rows.filter(
        (revision) => revision.event_type === event.event_type,
      );
      const englishCurrent = eventChannels.find(
        (channel) => channel.locale === "en",
      )?.current_revision_id ?? null;
      return {
        eventType: event.event_type,
        preferenceCategory: event.preference_category,
        requiredDelivery: event.required_delivery,
        sensitive: event.sensitive,
        allowedVariables: event.allowed_variables,
        requiredVariables: event.required_variables,
        locales: eventChannels.map((channel) => ({
          locale: channel.locale,
          channelVersion: channel.channel_version,
          currentRevisionId:
            channel.current_revision_id ?? (channel.locale === "zh-CN" ? englishCurrent : null),
          currentRevisionKey:
            channel.current_revision_key ?? (channel.locale === "zh-CN"
              ? eventChannels.find((candidate) => candidate.locale === "en")?.current_revision_key ?? null
              : null),
          fallback: channel.locale === "zh-CN" && channel.current_revision_id === null,
        })),
        revisions: eventRevisions.map((revision) => {
          const current = eventChannels.some(
            (channel) => channel.current_revision_id === revision.id,
          );
          const status = current
            ? "current"
            : revision.retired_at
              ? "retired"
              : revision.published_at
                ? "published"
                : "draft";
          return {
            id: revision.id,
            locale: revision.locale,
            revisionKey: revision.revision_key,
            revisionNumber: revision.revision_number,
            status,
            subjectTemplate: revision.subject_template,
            bodyTemplate: revision.body_template,
            createdAt: revision.created_at,
            publishedAt: revision.published_at,
            retiredAt: revision.retired_at,
          };
        }),
      };
    }),
  };
}

export async function registerNotificationTemplateRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get("/api/v1/customer/notification-preferences", async (request) => {
    const user = await requireSessionIdentity(request, pool, config);
    assertIdentityReadEligible(user);
    return {
      channel: "email" as const,
      categories: (await preferenceRows(pool, user.userId)).map(preferenceJson),
    };
  });

  app.put(
    "/api/v1/customer/notification-preferences/:category/:channel",
    async (request) => {
      const user = await requireSessionIdentity(request, pool, config);
      const params = preferenceParams.parse(request.params);
      const body = preferenceBody.parse(request.body);
      return transaction(pool, async (client) => {
        const identity = await lockSessionIdentityForMutation(client, user);
        assertIdentityReadEligible(identity);
        await client.query(
          "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
          [`notification-preference:${user.userId}:${params.category}:email`],
        );
        const category = await client.query<{
          label: { en: string; "zh-CN": string };
          mandatory: boolean;
        }>(
          `SELECT label, required_delivery AS mandatory
           FROM public.notification_preference_categories
           WHERE category = $1
           FOR SHARE`,
          [params.category],
        );
        const definition = category.rows[0];
        if (!definition) throw new Error("Notification preference category is unavailable");
        if (definition.mandatory && !body.enabled) {
          throw Object.assign(new Error("Required notification categories cannot be disabled"), {
            statusCode: 409,
            code: "NOTIFICATION_PREFERENCE_REQUIRED",
          });
        }
        const current = await client.query<{ enabled: boolean; version: string }>(
          `SELECT enabled, version::text
           FROM public.user_notification_preferences
           WHERE user_id = $1 AND category = $2 AND channel = 'email'
           FOR UPDATE`,
          [user.userId, params.category],
        );
        const prior = current.rows[0];
        const currentVersion = prior?.version ?? "0";
        const currentEnabled = prior?.enabled ?? true;
        if (currentVersion !== body.expectedVersion) throw stalePreference();
        if (currentEnabled === body.enabled) {
          return preferenceJson({
            category: params.category,
            label: definition.label,
            mandatory: definition.mandatory,
            enabled: currentEnabled,
            version: currentVersion,
          });
        }
        const nextVersion = (BigInt(currentVersion) + 1n).toString();
        if (prior) {
          await client.query(
            `UPDATE public.user_notification_preferences
             SET enabled = $4, version = $3,
                 updated_at = GREATEST(
                   pg_catalog.clock_timestamp(),
                   updated_at + interval '1 microsecond'
                 )
             WHERE user_id = $1 AND category = $2 AND channel = 'email'`,
            [user.userId, params.category, nextVersion, body.enabled],
          );
        } else {
          await client.query(
            `WITH timestamp(value) AS (SELECT pg_catalog.clock_timestamp())
             INSERT INTO public.user_notification_preferences(
               user_id, category, channel, enabled, version, created_at, updated_at
             )
             SELECT $1, $2, 'email', $3, 1, timestamp.value, timestamp.value
             FROM timestamp`,
            [user.userId, params.category, body.enabled],
          );
        }
        await client.query(
          `INSERT INTO public.user_notification_preference_changes(
             user_id, category, channel, previous_enabled, enabled,
             previous_version, version, changed_by_session_id
           ) VALUES ($1, $2, 'email', $3, $4, $5, $6, $7)`,
          [
            user.userId,
            params.category,
            currentEnabled,
            body.enabled,
            currentVersion,
            nextVersion,
            user.sessionId,
          ],
        );
        return preferenceJson({
          category: params.category,
          label: definition.label,
          mandatory: definition.mandatory,
          enabled: body.enabled,
          version: nextVersion,
        });
      });
    },
  );

  app.get("/api/v1/admin/notification-templates", async (request) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "notifications.templates.read");
    return templateSnapshot(pool);
  });

  app.post(
    "/api/v1/admin/notification-templates/:eventType/revisions",
    async (request, reply) => {
      const user = await requireSessionIdentity(request, pool, config);
      const params = eventParams.parse(request.params);
      const body = revisionBody.parse(request.body);
      const created = await transaction(pool, async (client) => {
        const grantId = await requireStaffActionLocked(
          client,
          user,
          "notifications.templates.create",
        );
        const event = await client.query<{
          allowed_variables: unknown;
          required_variables: unknown;
        }>(
          `SELECT event.allowed_variables, event.required_variables
           FROM public.notification_template_events event
           JOIN public.notification_template_channels channel
             ON channel.event_type = event.event_type AND channel.locale = $2
           WHERE event.event_type = $1
           FOR UPDATE OF channel`,
          [params.eventType, body.locale],
        );
        const definition = event.rows[0];
        if (!definition) {
          throw Object.assign(new Error("Notification template event was not found"), {
            statusCode: 404,
          });
        }
        assertTemplateContract(
          body,
          definition.allowed_variables,
          definition.required_variables,
        );
        const sequence = await client.query<{ next_revision: string }>(
          `SELECT (COALESCE(pg_catalog.max(revision_number), 0) + 1)::text AS next_revision
           FROM public.notification_template_revisions
           WHERE event_type = $1 AND locale = $2`,
          [params.eventType, body.locale],
        );
        const nextRevision = sequence.rows[0]?.next_revision;
        if (!nextRevision) throw new Error("Unable to allocate notification revision");
        const key = revisionKey(params.eventType, nextRevision);
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO public.notification_template_revisions(
             event_type, locale, revision_key, revision_number,
             provider_template_ref, subject_template, body_template,
             actor_source, created_by_staff_user_id,
             created_reauth_grant_id, creation_reason
           ) VALUES ($1, $2, $3, $4, $3, $5, $6, 'staff', $7, $8, $9)
           RETURNING id::text`,
          [
            params.eventType,
            body.locale,
            key,
            nextRevision,
            body.subjectTemplate,
            body.bodyTemplate,
            user.userId,
            grantId,
            body.reason,
          ],
        );
        const revisionId = inserted.rows[0]?.id;
        if (!revisionId) throw new Error("Unable to create notification template revision");
        return {
          eventType: params.eventType,
          revisionId,
          revisionKey: key,
          revisionNumber: nextRevision,
          locale: body.locale,
          status: "draft" as const,
        };
      });
      return reply.code(201).send(created);
    },
  );

  app.post(
    "/api/v1/admin/notification-templates/:eventType/revisions/:revisionId/publish",
    async (request, reply) => {
      const user = await requireSessionIdentity(request, pool, config);
      const params = revisionParams.parse(request.params);
      const body = publicationBody.parse(request.body);
      const outcome = await transaction(pool, async (client) => {
        const grantId = await requireStaffActionLocked(
          client,
          user,
          "notifications.templates.publish",
        );
        const target = await client.query<{
          locale: "en" | "zh-CN";
          revision_key: string;
          revision_number: string;
          published: boolean;
          retired: boolean;
        }>(
          `SELECT revision.locale, revision.revision_key,
                  revision.revision_number::text,
                  publication.id IS NOT NULL AS published,
                  retirement.id IS NOT NULL AS retired
           FROM public.notification_template_revisions revision
           LEFT JOIN public.notification_template_publications publication
             ON publication.revision_id = revision.id
           LEFT JOIN public.notification_template_retirements retirement
             ON retirement.revision_id = revision.id
           WHERE revision.id = $1 AND revision.event_type = $2
           FOR SHARE OF revision`,
          [params.revisionId, params.eventType],
        );
        const revision = target.rows[0];
        if (!revision) {
          throw Object.assign(new Error("Notification template revision was not found"), {
            statusCode: 404,
          });
        }
        const channel = await client.query<{
          current_revision_id: string | null;
          version: string;
          latest_published_revision_number: string | null;
        }>(
          `SELECT channel.current_revision_id::text, channel.version::text,
                  (
                    SELECT pg_catalog.max(candidate.revision_number)::text
                    FROM public.notification_template_revisions candidate
                    JOIN public.notification_template_publications publication
                      ON publication.revision_id = candidate.id
                    WHERE candidate.event_type = channel.event_type
                      AND candidate.locale = channel.locale
                  ) AS latest_published_revision_number
           FROM public.notification_template_channels channel
           WHERE channel.event_type = $1 AND channel.locale = $2
           FOR UPDATE OF channel`,
          [params.eventType, revision.locale],
        );
        const current = channel.rows[0];
        if (!current) throw new Error("Notification template channel is missing");
        if (current.current_revision_id === params.revisionId) {
          return {
            eventType: params.eventType,
            revisionId: params.revisionId,
            revisionKey: revision.revision_key,
            locale: revision.locale,
            channelVersion: current.version,
            replayed: true,
          };
        }
        if (current.version !== body.expectedChannelVersion) {
          throw Object.assign(new Error("Notification template channel changed; refresh"), {
            statusCode: 409,
            code: "NOTIFICATION_TEMPLATE_CHANNEL_STALE",
          });
        }
        if (revision.retired || revision.published) {
          throw Object.assign(new Error("Only an unpublished draft can become current"), {
            statusCode: 409,
            code: "NOTIFICATION_TEMPLATE_NOT_DRAFT",
          });
        }
        if (
          current.latest_published_revision_number !== null &&
          BigInt(revision.revision_number) <=
            BigInt(current.latest_published_revision_number)
        ) {
          throw Object.assign(
            new Error("Only a revision newer than every published revision can be published"),
            { statusCode: 409, code: "NOTIFICATION_TEMPLATE_REVISION_NOT_NEWER" },
          );
        }
        await client.query(
          `INSERT INTO public.notification_template_publications(
             revision_id, actor_source, actor_staff_user_id,
             reauth_grant_id, reason
           ) VALUES ($1, 'staff', $2, $3, $4)`,
          [params.revisionId, user.userId, grantId, body.reason],
        );
        const nextVersion = (BigInt(current.version) + 1n).toString();
        await client.query(
          `UPDATE public.notification_template_channels
           SET current_revision_id = $3, version = $4,
               updated_at = GREATEST(
                 pg_catalog.clock_timestamp(), updated_at + interval '1 microsecond'
               )
           WHERE event_type = $1 AND locale = $2`,
          [params.eventType, revision.locale, params.revisionId, nextVersion],
        );
        if (current.current_revision_id) {
          await client.query(
            `INSERT INTO public.notification_template_retirements(
               revision_id, actor_source, actor_staff_user_id,
               reauth_grant_id, reason
             ) VALUES ($1, 'staff', $2, $3, $4)`,
            [
              current.current_revision_id,
              user.userId,
              grantId,
              `Replaced during publication: ${body.reason}`.slice(0, 1_000),
            ],
          );
        }
        return {
          eventType: params.eventType,
          revisionId: params.revisionId,
          revisionKey: revision.revision_key,
          locale: revision.locale,
          channelVersion: nextVersion,
          replayed: false,
        };
      });
      return reply.code(outcome.replayed ? 200 : 201).send(outcome);
    },
  );

  app.post(
    "/api/v1/admin/notification-templates/:eventType/revisions/:revisionId/retire",
    async (request, reply) => {
      const user = await requireSessionIdentity(request, pool, config);
      const params = revisionParams.parse(request.params);
      const body = publicationBody.parse(request.body);
      const outcome = await transaction(pool, async (client) => {
        const grantId = await requireStaffActionLocked(
          client,
          user,
          "notifications.templates.retire",
        );
        const target = await client.query<{
          locale: "en" | "zh-CN";
          revision_key: string;
          retired: boolean;
        }>(
          `SELECT revision.locale, revision.revision_key,
                  retirement.id IS NOT NULL AS retired
           FROM public.notification_template_revisions revision
           JOIN public.notification_template_publications publication
             ON publication.revision_id = revision.id
           LEFT JOIN public.notification_template_retirements retirement
             ON retirement.revision_id = revision.id
           WHERE revision.id = $1 AND revision.event_type = $2
           FOR SHARE OF revision`,
          [params.revisionId, params.eventType],
        );
        const revision = target.rows[0];
        if (!revision) {
          throw Object.assign(new Error("Published notification revision was not found"), {
            statusCode: 404,
          });
        }
        const channel = await client.query<{
          current_revision_id: string | null;
          version: string;
        }>(
          `SELECT current_revision_id::text, version::text
           FROM public.notification_template_channels
           WHERE event_type = $1 AND locale = $2
           FOR UPDATE`,
          [params.eventType, revision.locale],
        );
        const current = channel.rows[0];
        if (!current) throw new Error("Notification template channel is missing");
        if (revision.retired) {
          return {
            eventType: params.eventType,
            revisionId: params.revisionId,
            locale: revision.locale,
            channelVersion: current.version,
            replayed: true,
          };
        }
        if (current.version !== body.expectedChannelVersion) {
          throw Object.assign(new Error("Notification template channel changed; refresh"), {
            statusCode: 409,
            code: "NOTIFICATION_TEMPLATE_CHANNEL_STALE",
          });
        }
        if (current.current_revision_id !== params.revisionId) {
          throw Object.assign(new Error("Only the current revision can be retired"), {
            statusCode: 409,
            code: "NOTIFICATION_TEMPLATE_NOT_CURRENT",
          });
        }
        if (revision.locale === "en") {
          throw Object.assign(
            new Error("The English fallback must be replaced by publishing a newer revision"),
            { statusCode: 409, code: "NOTIFICATION_TEMPLATE_ENGLISH_FALLBACK_REQUIRED" },
          );
        }
        const nextVersion = (BigInt(current.version) + 1n).toString();
        await client.query(
          `UPDATE public.notification_template_channels
           SET current_revision_id = NULL, version = $3,
               updated_at = GREATEST(
                 pg_catalog.clock_timestamp(), updated_at + interval '1 microsecond'
               )
           WHERE event_type = $1 AND locale = $2`,
          [params.eventType, revision.locale, nextVersion],
        );
        await client.query(
          `INSERT INTO public.notification_template_retirements(
             revision_id, actor_source, actor_staff_user_id,
             reauth_grant_id, reason
           ) VALUES ($1, 'staff', $2, $3, $4)`,
          [params.revisionId, user.userId, grantId, body.reason],
        );
        return {
          eventType: params.eventType,
          revisionId: params.revisionId,
          locale: revision.locale,
          channelVersion: nextVersion,
          replayed: false,
        };
      });
      return reply.code(outcome.replayed ? 200 : 201).send(outcome);
    },
  );
}
