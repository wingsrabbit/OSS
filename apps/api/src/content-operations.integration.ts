// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import pg from "pg";
import { digestToken } from "./auth.js";
import { loadLegalDocuments } from "./commerce-service.js";
import type { Config } from "./config.js";
import { runMigrations, transaction, type DatabasePool } from "./database.js";
import { registerContentRoutes } from "./routes-content.js";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) {
  throw new Error("ADMIN_DATABASE_URL is required for Content Operations integration");
}

const databaseName = `oss_content_operations_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = new URL(adminDatabaseUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = new pg.Client({ connectionString: adminDatabaseUrl });
let pool: DatabasePool | null = null;

const config: Config = {
  DATABASE_URL: databaseUrl.toString(),
  OSS_ENV: "test",
  OSS_LOG_LEVEL: "silent",
  OSS_PUBLIC_URL: "http://127.0.0.1:3000",
  API_HOST: "127.0.0.1",
  API_PORT: 3000,
  GLOBAL_RATE_LIMIT_MAX: 10_000,
  SESSION_COOKIE_NAME: "oss_content_session",
  SESSION_TTL_HOURS: 24,
  VERIFICATION_TTL_MINUTES: 30,
  WEB_ORIGIN: "http://127.0.0.1:5173",
  MOCK_MAILBOX_URL: "http://127.0.0.1:4000",
  LAB_MAILBOX_TOKEN: "synthetic-content-mailbox-token-00000000",
  PROVIDER_OPERATION_CAPABILITY_SECRET:
    "synthetic-content-provider-capability-secret",
  PAYMENT_METHOD_TOKEN_KEY: Buffer.alloc(32, 71).toString("base64url"),
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY: Buffer.alloc(32, 72).toString("base64url"),
  IDENTITY_SECRET_KEY: Buffer.alloc(32, 73).toString("base64url"),
  MOCK_PAYMENT_WEBHOOK_SECRET: "synthetic-content-payment-hook-000000000",
  MOCK_PROVISIONING_WEBHOOK_SECRET:
    "synthetic-content-provision-hook-0000000",
  LAB_MAILBOX_ENABLED: false,
};

type Staff = Readonly<{
  userId: string;
  sessionId: string;
  grantId: string;
  token: string;
}>;

function json<T>(response: Readonly<{ body: string }>): T {
  return JSON.parse(response.body) as T;
}

function pgCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
}

async function staff(label: string, permissions: readonly string[]): Promise<Staff> {
  if (!pool) throw new Error("Content database is unavailable");
  const userId = randomUUID();
  const sessionId = randomUUID();
  const grantId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO public.users(id, email, password_hash, locale, email_verified_at)
       VALUES ($1, $2, 'synthetic-not-a-password', 'en', pg_catalog.now())`,
      [userId, `content-${label}-${userId}@example.invalid`],
    );
    await client.query(
      `INSERT INTO public.sessions(id, user_id, token_digest, expires_at)
       VALUES ($1, $2, $3, pg_catalog.now() + interval '2 hours')`,
      [sessionId, userId, digestToken(token)],
    );
    await client.query(
      `INSERT INTO public.staff_members(user_id, roles, permissions)
       VALUES ($1, ARRAY['content']::text[], $2::jsonb)`,
      [userId, JSON.stringify(permissions)],
    );
    await client.query(
      `INSERT INTO public.reauth_grants(id, user_id, session_id, expires_at)
       VALUES ($1, $2, $3, pg_catalog.now() + interval '10 minutes')`,
      [grantId, userId, sessionId],
    );
  });
  return { userId, sessionId, grantId, token };
}

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  pool = new pg.Pool({
    connectionString: databaseUrl.toString(),
    max: 12,
    options: "-c search_path=pg_catalog,public",
    statement_timeout: 15_000,
    application_name: "opensales-content-operations-integration",
  });
  await runMigrations(pool);

  const managingStaff = await staff("manager", ["content.read", "content.manage"]);
  const readingStaff = await staff("reader", ["content.read"]);
  const app = Fastify({ logger: false });
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number(error.statusCode)
        : 500;
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    return reply.code(statusCode).send({
      error: error instanceof Error ? error.message : "Request failed",
      ...(code ? { code } : {}),
    });
  });
  await registerContentRoutes(app, pool, config);
  await app.ready();
  try {
    const managerHeaders = {
      cookie: `${config.SESSION_COOKIE_NAME}=${managingStaff.token}`,
    };
    const readerHeaders = {
      cookie: `${config.SESSION_COOKIE_NAME}=${readingStaff.token}`,
    };

    const publicContent = await app.inject({
      method: "GET",
      url: "/api/v1/content?locale=zh-CN",
    });
    assert.equal(publicContent.statusCode, 200, publicContent.body);
    const baselineItems = json<{ items: Array<{ slug: string; locale: string }> }>(
      publicContent,
    ).items;
    assert.deepEqual(
      baselineItems.map((item) => [item.slug, item.locale]),
      [
        ["mock-laboratory-welcome", "zh-CN"],
        ["mock-laboratory-network", "zh-CN"],
      ],
    );

    const legal = await app.inject({
      method: "GET",
      url: "/api/v1/legal/current?locale=zh-CN",
    });
    assert.equal(legal.statusCode, 200, legal.body);
    const legalBody = json<{
      documents: Record<string, { documentId: string; locale: string; version: string }>;
    }>(legal);
    assert.equal(legalBody.documents.terms?.locale, "zh-CN");
    assert.equal(legalBody.documents.terms?.version, "mock-lab-v1");
    assert.match(legalBody.documents.terms?.documentId ?? "", /^[0-9a-f-]{36}$/);

    const englishLegal = await app.inject({
      method: "GET",
      url: "/api/v1/legal/current?locale=en",
    });
    assert.equal(englishLegal.statusCode, 200, englishLegal.body);
    const englishTermsDocumentId = json<{
      documents: Record<string, { documentId: string; locale: string }>;
    }>(englishLegal).documents.terms?.documentId;
    assert.match(englishTermsDocumentId ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(
      json<{ documents: Record<string, { locale: string }> }>(englishLegal).documents.terms?.locale,
      "en",
    );

    const retireEnglishFallback = await app.inject({
      method: "POST",
      url: `/api/v1/admin/legal/documents/${englishTermsDocumentId}/retirement`,
      headers: managerHeaders,
      payload: { reason: "A required English fallback cannot be retired alone" },
    });
    assert.equal(retireEnglishFallback.statusCode, 409, retireEnglishFallback.body);
    assert.equal(
      json<{ code: string }>(retireEnglishFallback).code,
      "LEGAL_ENGLISH_FALLBACK_REQUIRED",
    );
    const legalAfterRejectedRetirement = await app.inject({
      method: "GET",
      url: "/api/v1/legal/current?locale=zh-CN",
    });
    assert.equal(legalAfterRejectedRetirement.statusCode, 200);
    assert.equal(
      json<{ documents: Record<string, { documentId: string }> }>(
        legalAfterRejectedRetirement,
      ).documents.terms?.documentId,
      legalBody.documents.terms?.documentId,
    );
    await assert.rejects(
      transaction(pool, async (client) => {
        await client.query(
          `INSERT INTO public.legal_document_retirements(
             document_id, actor_source, actor_staff_user_id,
             reauth_grant_id, reason
           ) VALUES ($1, 'staff', $2, $3, 'Raw retirement must preserve English fallback')`,
          [
            englishTermsDocumentId,
            managingStaff.userId,
            managingStaff.grantId,
          ],
        );
        await client.query(
          `UPDATE public.legal_document_channels
           SET current_document_id = NULL
           WHERE kind = 'terms' AND locale = 'en'`,
        );
      }),
      /requires one current English fallback publication/,
    );

    const englishTermsReplacement = await app.inject({
      method: "POST",
      url: "/api/v1/admin/legal/documents",
      headers: managerHeaders,
      payload: {
        kind: "terms",
        locale: "en",
        version: "mock-lab-v2",
        title: "Mock Laboratory Terms revision two",
        body: "Synthetic replacement terms for this disposable Mock-only laboratory.",
        reason: "Exercise atomic English fallback replacement",
      },
    });
    assert.equal(englishTermsReplacement.statusCode, 201, englishTermsReplacement.body);
    const englishTermsReplacementId = json<{ id: string }>(englishTermsReplacement).id;
    const publishEnglishTermsReplacement = await app.inject({
      method: "POST",
      url: `/api/v1/admin/legal/documents/${englishTermsReplacementId}/publication`,
      headers: managerHeaders,
      payload: { reason: "Replace the required English fallback atomically" },
    });
    assert.equal(
      publishEnglishTermsReplacement.statusCode,
      201,
      publishEnglishTermsReplacement.body,
    );
    const englishAfterReplacement = await app.inject({
      method: "GET",
      url: "/api/v1/legal/current?locale=en",
    });
    assert.equal(englishAfterReplacement.statusCode, 200, englishAfterReplacement.body);
    const currentEnglishTerms = json<{
      documents: Record<
        string,
        {
          documentId: string;
          kind: string;
          requestedLocale: string;
          locale: string;
          fallback: boolean;
          revision: string;
          version: string;
        }
      >;
    }>(englishAfterReplacement).documents.terms;
    assert.equal(currentEnglishTerms?.documentId, englishTermsReplacementId);
    assert.equal(currentEnglishTerms?.kind, "terms");
    assert.equal(currentEnglishTerms?.requestedLocale, "en");
    assert.equal(currentEnglishTerms?.locale, "en");
    assert.equal(currentEnglishTerms?.fallback, false);
    assert.equal(currentEnglishTerms?.revision, "2");
    assert.equal(currentEnglishTerms?.version, "mock-lab-v2");
    const retiredEnglishTerms = await pool.query<{ retired: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM public.legal_document_retirements WHERE document_id = $1
       ) AS retired`,
      [englishTermsDocumentId],
    );
    assert.equal(retiredEnglishTerms.rows[0]?.retired, true);

    const readerSnapshot = await app.inject({
      method: "GET",
      url: "/api/v1/admin/content",
      headers: readerHeaders,
    });
    assert.equal(readerSnapshot.statusCode, 200, readerSnapshot.body);
    const readerDenied = await app.inject({
      method: "POST",
      url: "/api/v1/admin/content/entries",
      headers: readerHeaders,
      payload: {
        slug: "reader-must-not-write",
        kind: "announcement",
        audience: "public",
        locale: "en",
        title: "Denied",
        summary: "",
        body: "This must not be saved.",
        statusLevel: "information",
        reason: "Permission separation negative",
      },
    });
    assert.equal(readerDenied.statusCode, 403, readerDenied.body);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/content/entries",
      headers: managerHeaders,
      payload: {
        slug: "fallback-proof",
        kind: "announcement",
        audience: "public",
        locale: "en",
        title: "English fallback proof",
        summary: "Synthetic fallback",
        body: "The zh-CN request resolves this immutable English revision.",
        statusLevel: "information",
        reason: "Exercise deterministic locale fallback",
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const createdBody = json<{ entryId: string; revision: { id: string } }>(created);
    const published = await app.inject({
      method: "POST",
      url: `/api/v1/admin/content/revisions/${createdBody.revision.id}/publication`,
      headers: managerHeaders,
      payload: { reason: "Publish the reviewed fallback proof" },
    });
    assert.equal(published.statusCode, 201, published.body);

    const fallback = await app.inject({
      method: "GET",
      url: "/api/v1/content?locale=zh-CN&slug=fallback-proof",
    });
    assert.equal(fallback.statusCode, 200, fallback.body);
    const fallbackItem = json<{
      items: Array<{ locale: string; fallback: boolean }>;
    }>(fallback).items[0];
    assert.equal(fallbackItem?.locale, "en");
    assert.equal(fallbackItem?.fallback, true);

    const zhRevision = await app.inject({
      method: "POST",
      url: `/api/v1/admin/content/entries/${createdBody.entryId}/revisions`,
      headers: managerHeaders,
      payload: {
        locale: "zh-CN",
        title: "中文版本证明",
        summary: "合成本地化版本",
        body: "中文请求优先解析到此不可变版本。",
        statusLevel: "information",
        reason: "Exercise requested-locale precedence",
      },
    });
    assert.equal(zhRevision.statusCode, 201, zhRevision.body);
    const zhRevisionId = json<{ id: string }>(zhRevision).id;
    const zhPublished = await app.inject({
      method: "POST",
      url: `/api/v1/admin/content/revisions/${zhRevisionId}/publication`,
      headers: managerHeaders,
      payload: { reason: "Publish reviewed zh-CN revision" },
    });
    assert.equal(zhPublished.statusCode, 201, zhPublished.body);
    const localized = await app.inject({
      method: "GET",
      url: "/api/v1/content?locale=zh-CN&slug=fallback-proof",
    });
    const localizedItem = json<{
      items: Array<{ locale: string; fallback: boolean }>;
    }>(localized).items[0];
    assert.equal(localizedItem?.locale, "zh-CN");
    assert.equal(localizedItem?.fallback, false);

    const secondEn = await app.inject({
      method: "POST",
      url: `/api/v1/admin/content/entries/${createdBody.entryId}/revisions`,
      headers: managerHeaders,
      payload: {
        locale: "en",
        title: "English fallback proof revision two",
        summary: "Second immutable revision",
        body: "Publishing this revision retires the prior exact current fact.",
        statusLevel: "information",
        reason: "Exercise exact pointer advancement",
      },
    });
    assert.equal(secondEn.statusCode, 201, secondEn.body);
    const secondEnId = json<{ id: string }>(secondEn).id;
    const beforePublish = await app.inject({
      method: "GET",
      url: "/api/v1/content?locale=en&slug=fallback-proof",
    });
    assert.equal(
      json<{ items: Array<{ revision: string }> }>(beforePublish).items[0]?.revision,
      "1",
    );
    const secondPublished = await app.inject({
      method: "POST",
      url: `/api/v1/admin/content/revisions/${secondEnId}/publication`,
      headers: managerHeaders,
      payload: { reason: "Publish reviewed second immutable revision" },
    });
    assert.equal(secondPublished.statusCode, 201, secondPublished.body);
    const afterPublish = await app.inject({
      method: "GET",
      url: "/api/v1/content?locale=en&slug=fallback-proof",
    });
    assert.equal(
      json<{ items: Array<{ revision: string }> }>(afterPublish).items[0]?.revision,
      "2",
    );

    const retirementProof = await app.inject({
      method: "POST",
      url: "/api/v1/admin/content/entries",
      headers: managerHeaders,
      payload: {
        slug: "retirement-proof",
        kind: "announcement",
        audience: "public",
        locale: "en",
        title: "Retirement visibility proof",
        summary: "Synthetic draft and retirement proof",
        body: "This revision must be visible only while its publication is current.",
        statusLevel: "information",
        reason: "Exercise draft and retired visibility",
      },
    });
    assert.equal(retirementProof.statusCode, 201, retirementProof.body);
    const retirementProofRevisionId = json<{
      revision: { id: string };
    }>(retirementProof).revision.id;
    const hiddenDraft = await app.inject({
      method: "GET",
      url: "/api/v1/content?locale=en&slug=retirement-proof",
    });
    assert.deepEqual(json<{ items: unknown[] }>(hiddenDraft).items, []);
    const retirementProofPublication = await app.inject({
      method: "POST",
      url: `/api/v1/admin/content/revisions/${retirementProofRevisionId}/publication`,
      headers: managerHeaders,
      payload: { reason: "Publish the retirement visibility proof" },
    });
    assert.equal(retirementProofPublication.statusCode, 201, retirementProofPublication.body);
    const visiblePublication = await app.inject({
      method: "GET",
      url: "/api/v1/content?locale=en&slug=retirement-proof",
    });
    assert.equal(json<{ items: unknown[] }>(visiblePublication).items.length, 1);
    const retirementProofRetirement = await app.inject({
      method: "POST",
      url: `/api/v1/admin/content/revisions/${retirementProofRevisionId}/retirement`,
      headers: managerHeaders,
      payload: { reason: "Retire the current synthetic visibility proof" },
    });
    assert.equal(retirementProofRetirement.statusCode, 201, retirementProofRetirement.body);
    const hiddenRetiredPublic = await app.inject({
      method: "GET",
      url: "/api/v1/content?locale=en&slug=retirement-proof",
    });
    assert.deepEqual(json<{ items: unknown[] }>(hiddenRetiredPublic).items, []);
    const hiddenRetiredCustomer = await app.inject({
      method: "GET",
      url: "/api/v1/customer/content?locale=en&slug=retirement-proof",
      headers: managerHeaders,
    });
    assert.deepEqual(json<{ items: unknown[] }>(hiddenRetiredCustomer).items, []);

    const timestampProof = await app.inject({
      method: "POST",
      url: "/api/v1/admin/content/entries",
      headers: managerHeaders,
      payload: {
        slug: "timestamp-proof",
        kind: "announcement",
        audience: "public",
        locale: "en",
        title: "Database timestamp proof",
        summary: "Synthetic wall-clock proof",
        body: "Staff-supplied publication and retirement times must be ignored.",
        statusLevel: "information",
        reason: "Exercise trusted publication and retirement clocks",
      },
    });
    assert.equal(timestampProof.statusCode, 201, timestampProof.body);
    const timestampProofBody = json<{
      entryId: string;
      revision: { id: string };
    }>(timestampProof);
    const timestampFloor = Date.now();
    await transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO public.content_revision_publications(
           revision_id, entry_id, locale, actor_source,
           actor_staff_user_id, reauth_grant_id, reason, published_at
         ) VALUES ($1, $2, 'en', 'staff', $3, $4,
                   'Database must replace a caller supplied publication time',
                   '2000-01-01T00:00:00Z')`,
        [
          timestampProofBody.revision.id,
          timestampProofBody.entryId,
          managingStaff.userId,
          managingStaff.grantId,
        ],
      );
      await client.query(
        `UPDATE public.content_channels
         SET current_revision_id = $2
         WHERE entry_id = $1 AND locale = 'en'`,
        [timestampProofBody.entryId, timestampProofBody.revision.id],
      );
    });
    const trustedPublicationTime = await pool.query<{ published_at: Date }>(
      `SELECT published_at
       FROM public.content_revision_publications
       WHERE revision_id = $1`,
      [timestampProofBody.revision.id],
    );
    assert.ok((trustedPublicationTime.rows[0]?.published_at.getTime() ?? 0) >= timestampFloor);
    await transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO public.content_revision_retirements(
           revision_id, actor_source, actor_staff_user_id,
           reauth_grant_id, reason, retired_at
         ) VALUES ($1, 'staff', $2, $3,
                   'Database must replace a caller supplied retirement time',
                   '1999-01-01T00:00:00Z')`,
        [timestampProofBody.revision.id, managingStaff.userId, managingStaff.grantId],
      );
      await client.query(
        `UPDATE public.content_channels
         SET current_revision_id = NULL
         WHERE entry_id = $1 AND locale = 'en'`,
        [timestampProofBody.entryId],
      );
    });
    const trustedRetirementTime = await pool.query<{ retired_at: Date }>(
      `SELECT retired_at
       FROM public.content_revision_retirements
       WHERE revision_id = $1`,
      [timestampProofBody.revision.id],
    );
    assert.ok(
      (trustedRetirementTime.rows[0]?.retired_at.getTime() ?? 0) >=
        (trustedPublicationTime.rows[0]?.published_at.getTime() ?? Number.MAX_SAFE_INTEGER),
    );

    await assert.rejects(
      pool.query(`UPDATE public.content_revisions SET title = 'tampered' WHERE id = $1`, [
        secondEnId,
      ]),
      /append-only/,
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO public.content_entries(slug, kind, audience, created_source)
         VALUES ('raw-seed-bypass', 'announcement', 'public', 'seed')`,
      ),
      /Runtime Content facts require a Staff actor/,
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO public.content_entries(slug, kind, audience, created_source)
         VALUES ('raw-extra-source', 'announcement', 'public', 'external')`,
      ),
      /Runtime Content facts require a Staff actor/,
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO public.content_revision_publications(
           revision_id, entry_id, locale, actor_source, reason, published_at
         ) VALUES ($1, $2, 'en', 'seed', 'Raw seed publication must fail',
                   '2000-01-01T00:00:00Z')`,
        [secondEnId, createdBody.entryId],
      ),
      /Runtime Content facts require a Staff actor/,
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO public.content_revision_retirements(
           revision_id, actor_source, reason, retired_at
         ) VALUES ($1, 'seed', 'Raw seed retirement must fail',
                   '2000-01-01T00:00:00Z')`,
        [secondEnId],
      ),
      /Runtime Content facts require a Staff actor/,
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO public.legal_documents(
           kind, locale, version, title, body, created_source, creation_reason
         ) VALUES (
           'privacy', 'en', 'raw-seed-v1', 'Raw seed', 'Must not persist',
           'seed', 'Raw runtime seed must fail'
         )`,
      ),
      /Runtime Content facts require a Staff actor/,
    );
    await assert.rejects(
      pool.query(
        `UPDATE public.legal_documents
         SET title = 'tampered'
         WHERE id = $1`,
        [legalBody.documents.terms?.documentId],
      ),
      /append-only/,
    );
    await assert.rejects(
      transaction(pool, async (client) => {
        await client.query(
          `UPDATE public.content_channels
           SET current_revision_id = NULL
           WHERE entry_id = $1 AND locale = 'en'`,
          [createdBody.entryId],
        );
      }),
      /current pointer must match exactly one active publication/,
    );

    const authorityTransitions: ReadonlyArray<{
      label: string;
      sql: string;
      values: unknown[];
    }> = [
      {
        label: "user-restriction",
        sql: `UPDATE public.users SET restricted_at = pg_catalog.clock_timestamp()
              WHERE id = $1`,
        values: [managingStaff.userId],
      },
      {
        label: "session-revocation",
        sql: `UPDATE public.sessions SET revoked_at = pg_catalog.clock_timestamp()
              WHERE id = $1`,
        values: [managingStaff.sessionId],
      },
      {
        label: "staff-permission-revocation",
        sql: `UPDATE public.staff_members SET permissions = '["content.read"]'::jsonb
              WHERE user_id = $1`,
        values: [managingStaff.userId],
      },
      {
        label: "reauth-invalidation",
        sql: `UPDATE public.reauth_grants SET invalidated_at = pg_catalog.clock_timestamp()
              WHERE id = $1`,
        values: [managingStaff.grantId],
      },
    ];

    for (const transition of authorityTransitions) {
      // Authority-transition-wins: a mutation must fail closed while any one
      // row in the canonical User -> Session -> Staff -> reauth chain changes.
      const authorityFirst = await pool.connect();
      const mutationAfter = await pool.connect();
      try {
        await authorityFirst.query("BEGIN");
        await authorityFirst.query(transition.sql, transition.values);
        await mutationAfter.query("BEGIN");
        await assert.rejects(
          mutationAfter.query(
            `INSERT INTO public.content_entries(
               slug, kind, audience, created_source,
               created_by_staff_user_id, created_reauth_grant_id
             ) VALUES ($1, 'announcement', 'public', 'staff', $2, $3)`,
            [
              `${transition.label}-race-loser`,
              managingStaff.userId,
              managingStaff.grantId,
            ],
          ),
          (error: unknown) => pgCode(error) === "55P03",
        );
        await mutationAfter.query("ROLLBACK");
        await authorityFirst.query("ROLLBACK");
      } finally {
        await mutationAfter.query("ROLLBACK").catch(() => undefined);
        await authorityFirst.query("ROLLBACK").catch(() => undefined);
        mutationAfter.release();
        authorityFirst.release();
      }

      // Mutation-wins: the fact holds a shared lock on the exact authority
      // snapshot until its own immutable entry and channels commit.
      const mutationFirst = await pool.connect();
      const authorityAfter = await pool.connect();
      try {
        await mutationFirst.query("BEGIN");
        const pendingEntryId = randomUUID();
        await mutationFirst.query(
          `INSERT INTO public.content_entries(
             id, slug, kind, audience, created_source,
             created_by_staff_user_id, created_reauth_grant_id
           ) VALUES ($1, $2, 'announcement', 'public', 'staff', $3, $4)`,
          [
            pendingEntryId,
            `${transition.label}-race-winner`,
            managingStaff.userId,
            managingStaff.grantId,
          ],
        );
        await mutationFirst.query(
          `INSERT INTO public.content_channels(entry_id, locale)
           VALUES ($1, 'en'), ($1, 'zh-CN')`,
          [pendingEntryId],
        );
        await authorityAfter.query("BEGIN");
        await authorityAfter.query("SET LOCAL lock_timeout = '150ms'");
        await assert.rejects(
          authorityAfter.query(transition.sql, transition.values),
          (error: unknown) => pgCode(error) === "55P03",
        );
        await authorityAfter.query("ROLLBACK");
        await mutationFirst.query("COMMIT");
      } finally {
        await authorityAfter.query("ROLLBACK").catch(() => undefined);
        await mutationFirst.query("ROLLBACK").catch(() => undefined);
        authorityAfter.release();
        mutationFirst.release();
      }
    }

    const zhTerms = legalBody.documents.terms;
    const zhAup = legalBody.documents.aup;
    assert.ok(zhTerms && zhAup);
    await transaction(pool, async (client) => {
      const locked = await loadLegalDocuments(client, {
        locale: "zh-CN",
        termsVersion: zhTerms.version,
        aupVersion: zhAup.version,
        termsDocumentId: zhTerms.documentId,
        aupDocumentId: zhAup.documentId,
        termsLocale: "zh-CN",
        aupLocale: "zh-CN",
      });
      assert.equal(locked.terms.id, zhTerms.documentId);
      assert.equal(locked.aup.id, zhAup.documentId);
    });
    await assert.rejects(
      transaction(pool, (client) =>
        loadLegalDocuments(client, {
          locale: "zh-CN",
          termsVersion: zhTerms.version,
          aupVersion: zhAup.version,
          termsDocumentId: randomUUID(),
          aupDocumentId: zhAup.documentId,
          termsLocale: "zh-CN",
          aupLocale: "zh-CN",
        }),
      ),
      /selected legal document version is not available/,
    );
    await assert.rejects(
      transaction(pool, (client) =>
        loadLegalDocuments(client, {
          locale: "zh-CN",
          termsVersion: zhTerms.version,
          aupVersion: zhAup.version,
          termsDocumentId: zhTerms.documentId,
          aupDocumentId: zhAup.documentId,
          termsLocale: "en",
          aupLocale: "zh-CN",
        }),
      ),
      /selected legal document version is not available/,
    );

    const newerGrant = await pool.query<{ id: string }>(
      `INSERT INTO public.reauth_grants(user_id, session_id, expires_at)
       VALUES ($1, $2, pg_catalog.clock_timestamp() + interval '10 minutes')
       RETURNING id`,
      [managingStaff.userId, managingStaff.sessionId],
    );
    assert.match(newerGrant.rows[0]?.id ?? "", /^[0-9a-f-]{36}$/);
    await assert.rejects(
      pool.query(
        `INSERT INTO public.content_entries(
           slug, kind, audience, created_source,
           created_by_staff_user_id, created_reauth_grant_id
         ) VALUES (
           'stale-reauth-grant', 'announcement', 'public', 'staff', $1, $2
         )`,
        [managingStaff.userId, managingStaff.grantId],
      ),
      /requires current Staff permission and reauthentication/,
    );
    const latestGrantRoute = await app.inject({
      method: "POST",
      url: "/api/v1/admin/content/entries",
      headers: managerHeaders,
      payload: {
        slug: "latest-reauth-grant",
        kind: "announcement",
        audience: "public",
        locale: "en",
        title: "Latest grant proof",
        summary: "Synthetic exact reauthentication proof",
        body: "The route and database trigger bind the same current grant ID.",
        statusLevel: "information",
        reason: "Exercise exact current reauthentication binding",
      },
    });
    assert.equal(latestGrantRoute.statusCode, 201, latestGrantRoute.body);

    process.stdout.write("Content Operations PG18 integration: PASS\n");
  } finally {
    await app.close();
  }
} finally {
  if (pool) await pool.end();
  if ((admin as unknown as { _ending?: boolean })._ending !== true) {
    await admin.query(
      `SELECT pg_catalog.pg_terminate_backend(pid)
       FROM pg_catalog.pg_stat_activity
       WHERE datname = $1 AND pid <> pg_catalog.pg_backend_pid()`,
      [databaseName],
    ).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}
