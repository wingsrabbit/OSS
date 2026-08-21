// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  CONTENT_KINDS,
  CONTENT_STATUS_LEVELS,
  contentLocale,
  type ContentLocale,
} from "@opensales/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assertIdentityReadEligible,
  requireSessionIdentity,
} from "./auth.js";
import type { Config } from "./config.js";
import {
  transaction,
  type DatabaseClient,
  type DatabasePool,
} from "./database.js";
import { requireStaffPermission } from "./routes-admin.js";
import { requestFingerprint } from "./idempotency.js";
import { executeStaffActionIntent } from "./staff-action-intents.js";

const canonicalUuid = z.uuid().transform((value) => value.toLowerCase());
const localeSchema = z.enum(["en", "zh-CN"]);
const kindSchema = z.enum(CONTENT_KINDS);
const statusLevelSchema = z.enum(CONTENT_STATUS_LEVELS);
const legalKindSchema = z.enum(["terms", "aup", "privacy"]);
const slugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{1,79}$/);
const reasonSchema = z.string().trim().min(1).max(1_000);
const contentBodySchema = z
  .object({
    intentId: canonicalUuid,
    locale: localeSchema,
    title: z.string().trim().min(1).max(200),
    summary: z.string().max(1_000).default(""),
    body: z.string().trim().min(1).max(50_000),
    statusLevel: statusLevelSchema.default("information"),
    reason: reasonSchema,
  })
  .strict();
const entrySchema = contentBodySchema
  .extend({
    slug: slugSchema,
    kind: kindSchema,
    audience: z.enum(["public", "customer"]),
  })
  .strict();
const legalRevisionSchema = z
  .object({
    intentId: canonicalUuid,
    kind: legalKindSchema,
    locale: localeSchema,
    version: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(50_000),
    reason: reasonSchema,
  })
  .strict();
const publicationSchema = z.object({ intentId: canonicalUuid, reason: reasonSchema }).strict();
const contentQuerySchema = z
  .object({
    locale: z.string().optional(),
    kind: kindSchema.optional(),
    slug: slugSchema.optional(),
  })
  .strict();

type PublicContentRow = Readonly<{
  entry_id: string;
  slug: string;
  kind: "announcement" | "knowledge_base" | "network_status";
  audience: "public" | "customer";
  locale: ContentLocale;
  revision_id: string;
  revision: string;
  title: string;
  summary: string;
  body: string;
  status_level: string;
  published_at: Date;
  fallback: boolean;
}>;

type CurrentLegalRow = Readonly<{
  kind: "terms" | "aup" | "privacy";
  locale: ContentLocale;
  document_id: string;
  revision: string;
  version: string;
  title: string;
  body: string;
  published_at: Date;
  fallback: boolean;
}>;

function legalJson(row: CurrentLegalRow, requestedLocale: ContentLocale) {
  return {
    id: row.document_id,
    documentId: row.document_id,
    kind: row.kind,
    requestedLocale,
    locale: row.locale,
    fallback: row.fallback,
    revision: row.revision,
    version: row.version,
    title: row.title,
    body: row.body,
    publishedAt: row.published_at,
  };
}

function contentJson(row: PublicContentRow, requestedLocale: ContentLocale) {
  return {
    entryId: row.entry_id,
    revisionId: row.revision_id,
    slug: row.slug,
    kind: row.kind,
    audience: row.audience,
    requestedLocale,
    locale: row.locale,
    fallback: row.fallback,
    revision: row.revision,
    title: row.title,
    summary: row.summary,
    body: row.body,
    statusLevel: row.status_level,
    publishedAt: row.published_at,
  };
}

async function currentLegal(
  database: Pick<DatabasePool, "query"> | DatabaseClient,
  requestedLocale: ContentLocale,
): Promise<CurrentLegalRow[]> {
  const result = await database.query<CurrentLegalRow>(
    `SELECT DISTINCT ON (requested.kind)
            requested.kind,
            candidate.locale,
            candidate.document_id,
            candidate.revision::text,
            candidate.version,
            candidate.title,
            candidate.body,
            candidate.published_at,
            candidate.locale <> $1::text AS fallback
     FROM (VALUES ('terms'::text), ('aup'::text), ('privacy'::text)) requested(kind)
     JOIN public.current_legal_documents candidate
       ON candidate.kind = requested.kind
      AND candidate.locale IN ($1::text, 'en')
     ORDER BY requested.kind,
              (candidate.locale = $1::text) DESC,
              candidate.locale COLLATE "C",
              candidate.document_id`,
    [requestedLocale],
  );
  return result.rows;
}

async function visibleContent(
  database: Pick<DatabasePool, "query"> | DatabaseClient,
  input: Readonly<{
    requestedLocale: ContentLocale;
    audiences: readonly ("public" | "customer")[];
    kind?: string | undefined;
    slug?: string | undefined;
  }>,
): Promise<PublicContentRow[]> {
  const result = await database.query<PublicContentRow>(
    `SELECT DISTINCT ON (candidate.entry_id)
            candidate.entry_id,
            candidate.slug,
            candidate.kind,
            candidate.audience,
            candidate.locale,
            candidate.revision_id,
            candidate.revision::text,
            candidate.title,
            candidate.summary,
            candidate.body,
            candidate.status_level,
            candidate.published_at,
            candidate.locale <> $1::text AS fallback
     FROM public.current_content_revisions candidate
     WHERE candidate.audience = ANY($2::text[])
       AND candidate.locale IN ($1::text, 'en')
       AND ($3::text IS NULL OR candidate.kind = $3)
       AND ($4::text IS NULL OR candidate.slug = $4)
     ORDER BY candidate.entry_id,
              (candidate.locale = $1::text) DESC,
              candidate.locale COLLATE "C",
              candidate.revision_id`,
    [input.requestedLocale, [...input.audiences], input.kind ?? null, input.slug ?? null],
  );
  return result.rows.sort((left, right) => {
    const kind = left.kind.localeCompare(right.kind, "en");
    if (kind !== 0) return kind;
    return left.slug.localeCompare(right.slug, "en");
  });
}

async function publishContentRevision(
  client: DatabaseClient,
  input: Readonly<{
    revisionId: string;
    actorUserId: string;
    reauthGrantId: string;
    reason: string;
  }>,
): Promise<{ entryId: string; locale: ContentLocale; replayed: boolean }> {
  const revisionResult = await client.query<{
    entry_id: string;
    locale: ContentLocale;
  }>(
    `SELECT entry_id, locale
     FROM public.content_revisions
     WHERE id = $1`,
    [input.revisionId],
  );
  const revision = revisionResult.rows[0];
  if (!revision) {
    throw Object.assign(new Error("Content revision not found"), { statusCode: 404 });
  }
  const channelResult = await client.query<{ current_revision_id: string | null }>(
    `SELECT current_revision_id
     FROM public.content_channels
     WHERE entry_id = $1 AND locale = $2
     FOR UPDATE`,
    [revision.entry_id, revision.locale],
  );
  const channel = channelResult.rows[0];
  if (!channel) throw new Error("Content channel is missing");
  await client.query(
    `SELECT id
     FROM public.content_revisions
     WHERE id = $1 AND entry_id = $2 AND locale = $3
     FOR SHARE`,
    [input.revisionId, revision.entry_id, revision.locale],
  );
  if (channel.current_revision_id === input.revisionId) {
    return { entryId: revision.entry_id, locale: revision.locale, replayed: true };
  }
  const priorPublication = await client.query(
    `SELECT 1 FROM public.content_revision_publications WHERE revision_id = $1`,
    [input.revisionId],
  );
  if (priorPublication.rowCount !== 0) {
    throw Object.assign(new Error("A retired Content revision cannot be republished"), {
      statusCode: 409,
      code: "CONTENT_REVISION_RETIRED",
    });
  }
  if (channel.current_revision_id) {
    await client.query(
      `INSERT INTO public.content_revision_retirements(
         revision_id, actor_source, actor_staff_user_id,
         reauth_grant_id, reason
       ) VALUES ($1, 'staff', $2, $3, $4)`,
      [channel.current_revision_id, input.actorUserId, input.reauthGrantId, input.reason],
    );
  }
  await client.query(
    `INSERT INTO public.content_revision_publications(
       revision_id, entry_id, locale, actor_source,
       actor_staff_user_id, reauth_grant_id, reason
     ) VALUES ($1, $2, $3, 'staff', $4, $5, $6)`,
    [
      input.revisionId,
      revision.entry_id,
      revision.locale,
      input.actorUserId,
      input.reauthGrantId,
      input.reason,
    ],
  );
  await client.query(
    `UPDATE public.content_channels
     SET current_revision_id = $3
     WHERE entry_id = $1 AND locale = $2`,
    [revision.entry_id, revision.locale, input.revisionId],
  );
  return { entryId: revision.entry_id, locale: revision.locale, replayed: false };
}

async function publishLegalDocument(
  client: DatabaseClient,
  input: Readonly<{
    documentId: string;
    actorUserId: string;
    reauthGrantId: string;
    reason: string;
  }>,
): Promise<{ kind: string; locale: ContentLocale; replayed: boolean }> {
  const documentResult = await client.query<{
    kind: string;
    locale: ContentLocale;
  }>(
    `SELECT kind, locale
     FROM public.legal_documents
     WHERE id = $1`,
    [input.documentId],
  );
  const document = documentResult.rows[0];
  if (!document) {
    throw Object.assign(new Error("Legal document revision not found"), { statusCode: 404 });
  }
  const channelResult = await client.query<{ current_document_id: string | null }>(
    `SELECT current_document_id
     FROM public.legal_document_channels
     WHERE kind = $1 AND locale = $2
     FOR UPDATE`,
    [document.kind, document.locale],
  );
  const channel = channelResult.rows[0];
  if (!channel) throw new Error("Legal document channel is missing");
  await client.query(
    `SELECT id
     FROM public.legal_documents
     WHERE id = $1 AND kind = $2 AND locale = $3
     FOR SHARE`,
    [input.documentId, document.kind, document.locale],
  );
  if (channel.current_document_id === input.documentId) {
    return { kind: document.kind, locale: document.locale, replayed: true };
  }
  const priorPublication = await client.query(
    `SELECT 1 FROM public.legal_document_publications WHERE document_id = $1`,
    [input.documentId],
  );
  if (priorPublication.rowCount !== 0) {
    throw Object.assign(new Error("A retired legal revision cannot be republished"), {
      statusCode: 409,
      code: "LEGAL_REVISION_RETIRED",
    });
  }
  if (channel.current_document_id) {
    await client.query(
      `INSERT INTO public.legal_document_retirements(
         document_id, actor_source, actor_staff_user_id,
         reauth_grant_id, reason
       ) VALUES ($1, 'staff', $2, $3, $4)`,
      [channel.current_document_id, input.actorUserId, input.reauthGrantId, input.reason],
    );
  }
  await client.query(
    `INSERT INTO public.legal_document_publications(
       document_id, kind, locale, actor_source,
       actor_staff_user_id, reauth_grant_id, reason
     ) VALUES ($1, $2, $3, 'staff', $4, $5, $6)`,
    [
      input.documentId,
      document.kind,
      document.locale,
      input.actorUserId,
      input.reauthGrantId,
      input.reason,
    ],
  );
  await client.query(
    `UPDATE public.legal_document_channels
     SET current_document_id = $3
     WHERE kind = $1 AND locale = $2`,
    [document.kind, document.locale, input.documentId],
  );
  return { kind: document.kind, locale: document.locale, replayed: false };
}

export async function registerContentRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get("/api/v1/legal/current", async (request) => {
    const query = z.object({ locale: z.string().optional() }).strict().parse(request.query);
    const requestedLocale = contentLocale(query.locale);
    const rows = await currentLegal(pool, requestedLocale);
    if (rows.length !== 3) {
      throw Object.assign(new Error("The complete current legal publication set is unavailable"), {
        statusCode: 503,
        code: "LEGAL_PUBLICATION_UNAVAILABLE",
      });
    }
    return {
      requestedLocale,
      locale: requestedLocale,
      documents: Object.fromEntries(
        rows.map((row) => [row.kind, legalJson(row, requestedLocale)]),
      ),
    };
  });

  app.get("/api/v1/content", async (request) => {
    const query = contentQuerySchema.parse(request.query);
    const requestedLocale = contentLocale(query.locale);
    const rows = await visibleContent(pool, {
      requestedLocale,
      audiences: ["public"],
      kind: query.kind,
      slug: query.slug,
    });
    return { requestedLocale, items: rows.map((row) => contentJson(row, requestedLocale)) };
  });

  app.get("/api/v1/customer/content", async (request) => {
    const user = await requireSessionIdentity(request, pool, config);
    assertIdentityReadEligible(user);
    const query = contentQuerySchema.parse(request.query);
    const requestedLocale = contentLocale(query.locale ?? user.locale);
    const rows = await visibleContent(pool, {
      requestedLocale,
      audiences: ["public", "customer"],
      kind: query.kind,
      slug: query.slug,
    });
    return { requestedLocale, items: rows.map((row) => contentJson(row, requestedLocale)) };
  });

  app.get("/api/v1/admin/content", async (request) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "content.read");
    const [entries, revisions, legal] = await Promise.all([
      pool.query(
        `SELECT entry.id, entry.slug, entry.kind, entry.audience, entry.created_at,
                channel.locale, channel.current_revision_id,
                channel.revision_sequence::text
         FROM public.content_entries entry
         JOIN public.content_channels channel ON channel.entry_id = entry.id
         ORDER BY entry.kind, entry.slug, channel.locale COLLATE "C"`,
      ),
      pool.query(
        `SELECT revision.id, revision.entry_id, revision.locale,
                revision.revision::text, revision.title, revision.summary,
                revision.body, revision.status_level, revision.creation_reason,
                revision.created_at,
                publication.published_at,
                retirement.retired_at
         FROM public.content_revisions revision
         LEFT JOIN public.content_revision_publications publication
           ON publication.revision_id = revision.id
         LEFT JOIN public.content_revision_retirements retirement
           ON retirement.revision_id = revision.id
         ORDER BY revision.entry_id, revision.locale COLLATE "C", revision.revision DESC`,
      ),
      pool.query(
        `SELECT document.id, document.kind, document.locale,
                document.revision::text, document.version, document.title,
                document.body, document.created_source, document.published_at AS legacy_created_at,
                publication.published_at,
                retirement.retired_at,
                channel.current_document_id = document.id AS current
         FROM public.legal_documents document
         JOIN public.legal_document_channels channel
           ON channel.kind = document.kind AND channel.locale = document.locale
         LEFT JOIN public.legal_document_publications publication
           ON publication.document_id = document.id
         LEFT JOIN public.legal_document_retirements retirement
           ON retirement.document_id = document.id
         ORDER BY document.kind, document.locale COLLATE "C", document.revision DESC`,
      ),
    ]);
    return { entries: entries.rows, revisions: revisions.rows, legalDocuments: legal.rows };
  });

  app.post("/api/v1/admin/content/entries", async (request, reply) => {
    const user = await requireSessionIdentity(request, pool, config);
    const body = entrySchema.parse(request.body);
    const fingerprint = requestFingerprint("admin.content-entry.create:v1", {
      slug: body.slug,
      kind: body.kind,
      audience: body.audience,
      locale: body.locale,
      title: body.title,
      summary: body.summary,
      body: body.body,
      statusLevel: body.statusLevel,
      reason: body.reason,
    });
    const outcome = await transaction(pool, (client) => executeStaffActionIntent(client, {
      user,
      permission: "content.manage",
      intentId: body.intentId,
      action: "content.entry.create",
      requestFingerprint: fingerprint,
      execute: async (grantId) => {
        const entry = await client.query<{ id: string }>(
          `INSERT INTO public.content_entries(
             slug, kind, audience, created_source,
             created_by_staff_user_id, created_reauth_grant_id
           ) VALUES ($1, $2, $3, 'staff', $4, $5)
           RETURNING id`,
          [body.slug, body.kind, body.audience, user.userId, grantId],
        );
        const entryId = entry.rows[0]?.id;
        if (!entryId) throw new Error("Unable to create Content entry");
        await client.query(
          `INSERT INTO public.content_channels(entry_id, locale)
           VALUES ($1, 'en'), ($1, 'zh-CN')`,
          [entryId],
        );
        const revision = await client.query<{ id: string; revision: string }>(
          `INSERT INTO public.content_revisions(
             entry_id, locale, revision, title, summary, body, status_level,
             created_source, created_by_staff_user_id, created_reauth_grant_id,
             creation_reason
           ) VALUES ($1, $2, 1, $3, $4, $5, $6, 'staff', $7, $8, $9)
           RETURNING id, revision::text`,
          [
            entryId,
            body.locale,
            body.title,
            body.summary,
            body.body,
            body.statusLevel,
            user.userId,
            grantId,
            body.reason,
          ],
        );
        const revisionFact = revision.rows[0];
        if (!revisionFact) throw new Error("Unable to create Content revision");
        return { statusCode: 201, body: { entryId, revision: revisionFact } };
      },
    }));
    return reply.code(outcome.statusCode).send(outcome.body);
  });

  app.post("/api/v1/admin/content/entries/:entryId/revisions", async (request, reply) => {
    const user = await requireSessionIdentity(request, pool, config);
    const params = z.object({ entryId: canonicalUuid }).parse(request.params);
    const body = contentBodySchema.parse(request.body);
    const fingerprint = requestFingerprint("admin.content-revision.create:v1", {
      entryId: params.entryId,
      locale: body.locale,
      title: body.title,
      summary: body.summary,
      body: body.body,
      statusLevel: body.statusLevel,
      reason: body.reason,
    });
    const outcome = await transaction(pool, (client) => executeStaffActionIntent(client, {
      user,
      permission: "content.manage",
      intentId: body.intentId,
      action: "content.revision.create",
      requestFingerprint: fingerprint,
      execute: async (grantId) => {
        const channel = await client.query<{ revision_sequence: string }>(
          `SELECT revision_sequence::text
           FROM public.content_channels
           WHERE entry_id = $1 AND locale = $2
           FOR UPDATE`,
          [params.entryId, body.locale],
        );
        const sequence = channel.rows[0]?.revision_sequence;
        if (sequence === undefined) {
          throw Object.assign(new Error("Content entry not found"), { statusCode: 404 });
        }
        const revision = await client.query<{ id: string; revision: string }>(
          `INSERT INTO public.content_revisions(
             entry_id, locale, revision, title, summary, body, status_level,
             created_source, created_by_staff_user_id, created_reauth_grant_id,
             creation_reason
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'staff', $8, $9, $10)
           RETURNING id, revision::text`,
          [
            params.entryId,
            body.locale,
            (BigInt(sequence) + 1n).toString(),
            body.title,
            body.summary,
            body.body,
            body.statusLevel,
            user.userId,
            grantId,
            body.reason,
          ],
        );
        const revisionFact = revision.rows[0];
        if (!revisionFact) throw new Error("Unable to create Content revision");
        return {
          statusCode: 201,
          body: { entryId: params.entryId, ...revisionFact },
        };
      },
    }));
    return reply.code(outcome.statusCode).send(outcome.body);
  });

  app.post("/api/v1/admin/content/revisions/:revisionId/publication", async (request, reply) => {
    const user = await requireSessionIdentity(request, pool, config);
    const params = z.object({ revisionId: canonicalUuid }).parse(request.params);
    const body = publicationSchema.parse(request.body);
    const fingerprint = requestFingerprint("admin.content-revision.publish:v1", {
      revisionId: params.revisionId,
      reason: body.reason,
    });
    const outcome = await transaction(pool, (client) => executeStaffActionIntent(client, {
      user,
      permission: "content.manage",
      intentId: body.intentId,
      action: "content.revision.publish",
      requestFingerprint: fingerprint,
      execute: async (grantId) => {
        const result = await publishContentRevision(client, {
          revisionId: params.revisionId,
          actorUserId: user.userId,
          reauthGrantId: grantId,
          reason: body.reason,
        });
        return { statusCode: result.replayed ? 200 : 201, body: result };
      },
    }));
    return reply.code(outcome.statusCode).send(outcome.body);
  });

  app.post("/api/v1/admin/content/revisions/:revisionId/retirement", async (request, reply) => {
    const user = await requireSessionIdentity(request, pool, config);
    const params = z.object({ revisionId: canonicalUuid }).parse(request.params);
    const body = publicationSchema.parse(request.body);
    const fingerprint = requestFingerprint("admin.content-revision.retire:v1", {
      revisionId: params.revisionId,
      reason: body.reason,
    });
    const outcome = await transaction(pool, (client) => executeStaffActionIntent(client, {
      user,
      permission: "content.manage",
      intentId: body.intentId,
      action: "content.revision.retire",
      requestFingerprint: fingerprint,
      execute: async (grantId) => {
        const target = await client.query<{ entry_id: string; locale: ContentLocale }>(
          `SELECT revision.entry_id, revision.locale
           FROM public.content_revisions revision
           WHERE revision.id = $1`,
          [params.revisionId],
        );
        const revision = target.rows[0];
        if (!revision) {
          throw Object.assign(new Error("Content revision not found"), { statusCode: 404 });
        }
        const channel = await client.query<{ current_revision_id: string | null }>(
          `SELECT current_revision_id
           FROM public.content_channels
           WHERE entry_id = $1 AND locale = $2
           FOR UPDATE`,
          [revision.entry_id, revision.locale],
        );
        if (channel.rows[0]?.current_revision_id !== params.revisionId) {
          throw Object.assign(new Error("Only current Content can be retired"), {
            statusCode: 409,
          });
        }
        await client.query(
          `SELECT id
           FROM public.content_revisions
           WHERE id = $1 AND entry_id = $2 AND locale = $3
           FOR SHARE`,
          [params.revisionId, revision.entry_id, revision.locale],
        );
        await client.query(
          `INSERT INTO public.content_revision_retirements(
             revision_id, actor_source, actor_staff_user_id,
             reauth_grant_id, reason
           ) VALUES ($1, 'staff', $2, $3, $4)`,
          [params.revisionId, user.userId, grantId, body.reason],
        );
        await client.query(
          `UPDATE public.content_channels
           SET current_revision_id = NULL
           WHERE entry_id = $1 AND locale = $2`,
          [revision.entry_id, revision.locale],
        );
        return {
          statusCode: 201,
          body: { revisionId: params.revisionId, retired: true },
        };
      },
    }));
    return reply.code(outcome.statusCode).send(outcome.body);
  });

  app.post("/api/v1/admin/legal/documents", async (request, reply) => {
    const user = await requireSessionIdentity(request, pool, config);
    const body = legalRevisionSchema.parse(request.body);
    const fingerprint = requestFingerprint("admin.legal-revision.create:v1", {
      kind: body.kind,
      locale: body.locale,
      version: body.version,
      title: body.title,
      body: body.body,
      reason: body.reason,
    });
    const outcome = await transaction(pool, (client) => executeStaffActionIntent(client, {
      user,
      permission: "content.manage",
      intentId: body.intentId,
      action: "content.legal-revision.create",
      requestFingerprint: fingerprint,
      execute: async (grantId) => {
        const channel = await client.query<{ revision_sequence: string }>(
          `SELECT revision_sequence::text
           FROM public.legal_document_channels
           WHERE kind = $1 AND locale = $2
           FOR UPDATE`,
          [body.kind, body.locale],
        );
        const sequence = channel.rows[0]?.revision_sequence;
        if (sequence === undefined) throw new Error("Legal document channel is missing");
        const result = await client.query<{ id: string; revision: string }>(
          `INSERT INTO public.legal_documents(
             kind, locale, version, title, body, revision, created_source,
             created_by_staff_user_id, created_reauth_grant_id, creation_reason
           ) VALUES ($1, $2, $3, $4, $5, $6, 'staff', $7, $8, $9)
           RETURNING id, revision::text`,
          [
            body.kind,
            body.locale,
            body.version,
            body.title,
            body.body,
            (BigInt(sequence) + 1n).toString(),
            user.userId,
            grantId,
            body.reason,
          ],
        );
        const legalFact = result.rows[0];
        if (!legalFact) throw new Error("Unable to create legal document revision");
        return { statusCode: 201, body: legalFact };
      },
    }));
    return reply.code(outcome.statusCode).send(outcome.body);
  });

  app.post("/api/v1/admin/legal/documents/:documentId/publication", async (request, reply) => {
    const user = await requireSessionIdentity(request, pool, config);
    const params = z.object({ documentId: canonicalUuid }).parse(request.params);
    const body = publicationSchema.parse(request.body);
    const fingerprint = requestFingerprint("admin.legal-revision.publish:v1", {
      documentId: params.documentId,
      reason: body.reason,
    });
    const outcome = await transaction(pool, (client) => executeStaffActionIntent(client, {
      user,
      permission: "content.manage",
      intentId: body.intentId,
      action: "content.legal-revision.publish",
      requestFingerprint: fingerprint,
      execute: async (grantId) => {
        const result = await publishLegalDocument(client, {
          documentId: params.documentId,
          actorUserId: user.userId,
          reauthGrantId: grantId,
          reason: body.reason,
        });
        return { statusCode: result.replayed ? 200 : 201, body: result };
      },
    }));
    return reply.code(outcome.statusCode).send(outcome.body);
  });

  app.post("/api/v1/admin/legal/documents/:documentId/retirement", async (request, reply) => {
    const user = await requireSessionIdentity(request, pool, config);
    const params = z.object({ documentId: canonicalUuid }).parse(request.params);
    const body = publicationSchema.parse(request.body);
    const fingerprint = requestFingerprint("admin.legal-revision.retire:v1", {
      documentId: params.documentId,
      reason: body.reason,
    });
    const outcome = await transaction(pool, (client) => executeStaffActionIntent(client, {
      user,
      permission: "content.manage",
      intentId: body.intentId,
      action: "content.legal-revision.retire",
      requestFingerprint: fingerprint,
      execute: async (grantId) => {
        const target = await client.query<{ kind: string; locale: ContentLocale }>(
          `SELECT kind, locale FROM public.legal_documents WHERE id = $1`,
          [params.documentId],
        );
        const document = target.rows[0];
        if (!document) {
          throw Object.assign(new Error("Legal document revision not found"), { statusCode: 404 });
        }
        const channel = await client.query<{ current_document_id: string | null }>(
          `SELECT current_document_id
           FROM public.legal_document_channels
           WHERE kind = $1 AND locale = $2
           FOR UPDATE`,
          [document.kind, document.locale],
        );
        if (channel.rows[0]?.current_document_id !== params.documentId) {
          throw Object.assign(new Error("Only the current legal document can be retired"), {
            statusCode: 409,
          });
        }
        await client.query(
          `SELECT id
           FROM public.legal_documents
           WHERE id = $1 AND kind = $2 AND locale = $3
           FOR SHARE`,
          [params.documentId, document.kind, document.locale],
        );
        if (document.locale === "en") {
          throw Object.assign(
            new Error("The required English legal fallback can only be replaced by publishing a newer revision"),
            { statusCode: 409, code: "LEGAL_ENGLISH_FALLBACK_REQUIRED" },
          );
        }
        await client.query(
          `INSERT INTO public.legal_document_retirements(
             document_id, actor_source, actor_staff_user_id,
             reauth_grant_id, reason
           ) VALUES ($1, 'staff', $2, $3, $4)`,
          [params.documentId, user.userId, grantId, body.reason],
        );
        await client.query(
          `UPDATE public.legal_document_channels
           SET current_document_id = NULL
           WHERE kind = $1 AND locale = $2`,
          [document.kind, document.locale],
        );
        return {
          statusCode: 201,
          body: { documentId: params.documentId, retired: true },
        };
      },
    }));
    return reply.code(outcome.statusCode).send(outcome.body);
  });
}
