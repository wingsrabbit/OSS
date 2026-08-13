// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import {
  SCHEMA_021_CATALOG_DIGEST,
  schema021CatalogDigest,
  schema021CatalogFingerprintInput,
} from "@opensales/core/schema-020-021-native-compatibility";
import {
  SCHEMA_018_CATALOG_DIGEST,
  schema018CatalogDigest,
  schema018CatalogFingerprintInput,
} from "@opensales/core/schema-017-018-native-compatibility";
import { buildApp } from "./app.js";
import { digestToken } from "./auth.js";
import type { Config } from "./config.js";
import { runMigrations, transaction } from "./database.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for Support integration");

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 12,
  options: "-c search_path=pg_catalog,public",
  statement_timeout: 20_000,
  application_name: "opensales-support-operations-integration",
});

const config: Config = {
  DATABASE_URL: databaseUrl,
  OSS_ENV: "test",
  OSS_LOG_LEVEL: "silent",
  OSS_PUBLIC_URL: "http://127.0.0.1:3000",
  API_HOST: "127.0.0.1",
  API_PORT: 3000,
  GLOBAL_RATE_LIMIT_MAX: 2_000,
  SESSION_COOKIE_NAME: "oss_support_session",
  SESSION_TTL_HOURS: 24,
  VERIFICATION_TTL_MINUTES: 30,
  WEB_ORIGIN: "http://127.0.0.1:5173",
  MOCK_MAILBOX_URL: "http://127.0.0.1:4000",
  LAB_MAILBOX_TOKEN: "synthetic-support-mail-token-0000000000",
  PROVIDER_OPERATION_CAPABILITY_SECRET:
    "synthetic-support-capability-secret-0000000000",
  PAYMENT_METHOD_TOKEN_KEY: Buffer.alloc(32, 91).toString("base64url"),
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY: Buffer.alloc(32, 92).toString("base64url"),
  IDENTITY_SECRET_KEY: Buffer.alloc(32, 93).toString("base64url"),
  MOCK_PAYMENT_WEBHOOK_SECRET: "synthetic-support-payment-hook-00000000",
  MOCK_PROVISIONING_WEBHOOK_SECRET:
    "synthetic-support-provision-hook-00000",
  LAB_MAILBOX_ENABLED: false,
};

type Principal = Readonly<{
  userId: string;
  accountId: string;
  sessionId: string;
  sessionToken: string;
}>;

function json<T>(response: Readonly<{ body: string }>): T {
  return JSON.parse(response.body) as T;
}

async function principal(label: string): Promise<Principal> {
  const userId = randomUUID();
  const accountId = randomUUID();
  const sessionId = randomUUID();
  const sessionToken = randomBytes(32).toString("base64url");
  await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO users(id, email, password_hash, email_verified_at)
       VALUES ($1, $2, 'synthetic-not-a-password', now())`,
      [userId, `support-${label}-${userId}@example.invalid`],
    );
    await client.query(
      `INSERT INTO client_accounts(id, name, owner_user_id)
       VALUES ($1, $2, $3)`,
      [accountId, `Synthetic Support ${label}`, userId],
    );
    await client.query(
      `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
       VALUES ($1, $2, 'owner', '[]'::jsonb)`,
      [accountId, userId],
    );
    await client.query(
      `INSERT INTO sessions(
         id, user_id, token_digest, expires_at,
         active_client_account_id, account_context_version
       ) VALUES ($1, $2, $3, now() + interval '2 hours', $4, 1)`,
      [sessionId, userId, digestToken(sessionToken), accountId],
    );
  });
  return { userId, accountId, sessionId, sessionToken };
}

await runMigrations(pool);
const schema018DefaultProjection = schema018CatalogDigest(
  await schema018CatalogFingerprintInput(pool),
);
const schema018SupportProjection = schema018CatalogDigest(
  await schema018CatalogFingerprintInput(pool, {
    allowSchema021SupportExtensions: true,
  }),
);
assert.notEqual(schema018DefaultProjection, SCHEMA_018_CATALOG_DIGEST);
assert.equal(schema018SupportProjection, SCHEMA_018_CATALOG_DIGEST);
const customer = await principal("customer");
const other = await principal("other");
const staff = await principal("staff");
await pool.query(
  `INSERT INTO staff_members(user_id, roles, permissions)
   VALUES ($1, ARRAY['Support'], '["support.tickets.manage"]'::jsonb)`,
  [staff.userId],
);
await pool.query(
  `INSERT INTO reauth_grants(user_id, session_id, expires_at)
   VALUES ($1, $2, now() + interval '10 minutes')`,
  [staff.userId, staff.sessionId],
);

const { app } = await buildApp(config, pool);
try {
  await app.ready();
  const customerHeaders = {
    cookie: `oss_support_session=${customer.sessionToken}`,
    "x-oss-account-context-version": "1",
  };
  const otherHeaders = {
    cookie: `oss_support_session=${other.sessionToken}`,
    "x-oss-account-context-version": "1",
  };
  const staffHeaders = { cookie: `oss_support_session=${staff.sessionToken}` };

  const departments = await app.inject({
    method: "GET",
    url: "/api/v1/support/departments?audience=authenticated",
    headers: customerHeaders,
  });
  assert.equal(departments.statusCode, 200, departments.body);
  assert.equal(json<{ items: Array<{ code: string }> }>(departments).items[0]?.code,
    "general-support");
  const anonymousAuthenticatedDepartments = await app.inject({
    method: "GET",
    url: "/api/v1/support/departments?audience=authenticated",
  });
  assert.equal(anonymousAuthenticatedDepartments.statusCode, 401);
  const publicPresalesDepartments = await app.inject({
    method: "GET",
    url: "/api/v1/support/departments?audience=presales",
  });
  assert.equal(publicPresalesDepartments.statusCode, 200, publicPresalesDepartments.body);

  const created = await app.inject({
    method: "POST",
    url: "/api/v1/tickets",
    headers: customerHeaders,
    payload: {
      subject: "Synthetic full Support operation",
      message: "Opening message with an attachment and exact state history.",
      departmentCode: "general-support",
      priority: "high",
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const createdBody = json<{
    ticket: Record<string, unknown> & { id: string; status: string; priority: string };
    messages: Array<{ id: string }>;
  }>(created);
  const ticketId = createdBody.ticket.id;
  const openingMessageId = createdBody.messages[0]?.id;
  assert.ok(openingMessageId);
  assert.equal(createdBody.ticket.status, "awaiting_staff");
  assert.equal(createdBody.ticket.priority, "high");
  assert.equal("assignedStaffUserId" in createdBody.ticket, false);

  const crossAccount = await app.inject({
    method: "GET",
    url: `/api/v1/tickets/${ticketId}`,
    headers: otherHeaders,
  });
  assert.equal(crossAccount.statusCode, 404);

  const assigned = await app.inject({
    method: "POST",
    url: `/api/v1/admin/tickets/${ticketId}/assignments`,
    headers: staffHeaders,
    payload: { assignedStaffUserId: staff.userId, reason: "Take ownership" },
  });
  assert.equal(assigned.statusCode, 201, assigned.body);
  const staffDetail = await app.inject({
    method: "GET",
    url: `/api/v1/admin/tickets/${ticketId}`,
    headers: staffHeaders,
  });
  assert.equal(staffDetail.statusCode, 200, staffDetail.body);
  assert.equal(
    json<{ ticket: { assignedStaffUserId: string } }>(staffDetail).ticket
      .assignedStaffUserId,
    staff.userId,
  );
  const customerDetail = await app.inject({
    method: "GET",
    url: `/api/v1/tickets/${ticketId}`,
    headers: customerHeaders,
  });
  assert.equal(customerDetail.statusCode, 200, customerDetail.body);
  assert.equal(
    "assignedStaffUserId" in json<{ ticket: Record<string, unknown> }>(customerDetail).ticket,
    false,
  );

  const attachmentContent = Buffer.from("synthetic support attachment\n", "utf8");
  const uploaded = await app.inject({
    method: "POST",
    url: `/api/v1/tickets/${ticketId}/messages/${openingMessageId}/attachments`,
    headers: customerHeaders,
    payload: {
      filename: "evidence.txt",
      contentType: "text/plain",
      contentBase64: attachmentContent.toString("base64"),
    },
  });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const attachmentId = json<{ id: string }>(uploaded).id;
  const quarantinedDownload = await app.inject({
    method: "GET",
    url: `/api/v1/tickets/${ticketId}/attachments/${attachmentId}`,
    headers: customerHeaders,
  });
  assert.equal(quarantinedDownload.statusCode, 404, quarantinedDownload.body);
  const pendingDetail = await app.inject({
    method: "GET",
    url: `/api/v1/tickets/${ticketId}`,
    headers: customerHeaders,
  });
  assert.equal(
    json<{ attachments: Array<{ scanStatus: string }> }>(pendingDetail).attachments[0]
      ?.scanStatus,
    "pending",
  );
  const cleanScan = await app.inject({
    method: "POST",
    url: `/api/v1/admin/tickets/${ticketId}/attachments/${attachmentId}/scan-result`,
    headers: staffHeaders,
    payload: { verdict: "clean" },
  });
  assert.equal(cleanScan.statusCode, 201, cleanScan.body);
  const downloaded = await app.inject({
    method: "GET",
    url: `/api/v1/tickets/${ticketId}/attachments/${attachmentId}`,
    headers: customerHeaders,
  });
  assert.equal(downloaded.statusCode, 200, downloaded.body);
  assert.deepEqual(downloaded.rawPayload, attachmentContent);
  const detailAfterUpload = await app.inject({
    method: "GET",
    url: `/api/v1/tickets/${ticketId}`,
    headers: customerHeaders,
  });
  assert.equal(detailAfterUpload.statusCode, 200, detailAfterUpload.body);
  const attachmentSummary = json<{
    attachments: Array<{
      id: string;
      messageId: string;
      filename: string;
      scanStatus: string;
    }>;
  }>(detailAfterUpload).attachments[0];
  assert.equal(attachmentSummary?.id, attachmentId);
  assert.equal(attachmentSummary?.messageId, openingMessageId);
  assert.equal(attachmentSummary?.filename, "evidence.txt");
  assert.equal(attachmentSummary?.scanStatus, "clean");

  const closed = await app.inject({
    method: "POST",
    url: `/api/v1/admin/tickets/${ticketId}/status`,
    headers: staffHeaders,
    payload: { status: "closed", reason: "Resolved in the laboratory" },
  });
  assert.equal(closed.statusCode, 201, closed.body);
  const closedUpload = await app.inject({
    method: "POST",
    url: `/api/v1/tickets/${ticketId}/messages/${openingMessageId}/attachments`,
    headers: customerHeaders,
    payload: {
      filename: "closed.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("closed ticket", "utf8").toString("base64"),
    },
  });
  assert.equal(closedUpload.statusCode, 404, closedUpload.body);
  const reopened = await app.inject({
    method: "POST",
    url: `/api/v1/tickets/${ticketId}/status`,
    headers: customerHeaders,
    payload: { status: "awaiting_staff", reason: "The issue returned" },
  });
  assert.equal(reopened.statusCode, 201, reopened.body);

  const deleted = await app.inject({
    method: "DELETE",
    url: `/api/v1/tickets/${ticketId}/attachments/${attachmentId}`,
    headers: customerHeaders,
  });
  assert.equal(deleted.statusCode, 204, deleted.body);
  const gone = await app.inject({
    method: "GET",
    url: `/api/v1/tickets/${ticketId}/attachments/${attachmentId}`,
    headers: customerHeaders,
  });
  assert.equal(gone.statusCode, 404);

  const salesDepartment = await app.inject({
    method: "POST",
    url: "/api/v1/admin/support/departments",
    headers: staffHeaders,
    payload: {
      code: "sales-engineering",
      name: "Sales Engineering",
      description: "Synthetic Presales department",
      acceptsAuthenticated: true,
      acceptsPresales: true,
    },
  });
  assert.equal(salesDepartment.statusCode, 201, salesDepartment.body);
  const salesDepartmentId = json<{ id: string }>(salesDepartment).id;
  const revisedDepartment = await app.inject({
    method: "POST",
    url: `/api/v1/admin/support/departments/${salesDepartmentId}/revisions`,
    headers: staffHeaders,
    payload: {
      name: "Sales Engineering and Solutions",
      description: "Second immutable revision",
      acceptsAuthenticated: true,
      acceptsPresales: true,
      reason: "Expand the department scope",
    },
  });
  assert.equal(revisedDepartment.statusCode, 201, revisedDepartment.body);
  assert.equal(json<{ revision: number }>(revisedDepartment).revision, 2);

  const presales = await app.inject({
    method: "POST",
    url: "/api/v1/presales/inquiries",
    payload: {
      visitorName: "Synthetic Visitor",
      visitorEmail: "visitor@example.invalid",
      topic: "product_question",
      subject: "Synthetic product question",
      message: "Please explain the Mock-only catalog option.",
      departmentCode: "sales-engineering",
    },
  });
  assert.equal(presales.statusCode, 201, presales.body);
  const presalesBody = json<{ inquiryId: string; accessToken: string }>(presales);
  assert.match(presalesBody.accessToken, /^[A-Za-z0-9_-]{43}$/);
  const presalesHeaders = { "x-oss-presales-token": presalesBody.accessToken };
  const presalesRead = await app.inject({
    method: "GET",
    url: `/api/v1/presales/inquiries/${presalesBody.inquiryId}`,
    headers: presalesHeaders,
  });
  assert.equal(presalesRead.statusCode, 200, presalesRead.body);
  const wrongToken = await app.inject({
    method: "GET",
    url: `/api/v1/presales/inquiries/${presalesBody.inquiryId}`,
    headers: { "x-oss-presales-token": randomBytes(32).toString("base64url") },
  });
  assert.equal(wrongToken.statusCode, 404);
  const visitorReply = await app.inject({
    method: "POST",
    url: `/api/v1/presales/inquiries/${presalesBody.inquiryId}/replies`,
    headers: presalesHeaders,
    payload: { message: "A follow-up from the synthetic visitor." },
  });
  assert.equal(visitorReply.statusCode, 201, visitorReply.body);
  const staffReply = await app.inject({
    method: "POST",
    url: `/api/v1/admin/presales/inquiries/${presalesBody.inquiryId}/messages`,
    headers: staffHeaders,
    payload: { kind: "public_reply", message: "Synthetic Presales response." },
  });
  assert.equal(staffReply.statusCode, 201, staffReply.body);
  const revokedAccess = await app.inject({
    method: "POST",
    url: `/api/v1/admin/presales/inquiries/${presalesBody.inquiryId}/access-revocation`,
    headers: staffHeaders,
    payload: { reason: "Visitor requested immediate bearer-token revocation" },
  });
  assert.equal(revokedAccess.statusCode, 201, revokedAccess.body);
  const revokedRead = await app.inject({
    method: "GET",
    url: `/api/v1/presales/inquiries/${presalesBody.inquiryId}`,
    headers: presalesHeaders,
  });
  assert.equal(revokedRead.statusCode, 404, revokedRead.body);
  const revokedReply = await app.inject({
    method: "POST",
    url: `/api/v1/presales/inquiries/${presalesBody.inquiryId}/replies`,
    headers: presalesHeaders,
    payload: { message: "This must not be accepted after token revocation." },
  });
  assert.equal(revokedReply.statusCode, 404, revokedReply.body);

  const chain = await pool.query<{ count: string }>(
    `SELECT count(*)::text
     FROM support_ticket_status_events
     WHERE ticket_id = $1`,
    [ticketId],
  );
  assert.equal(chain.rows[0]?.count, "3");
  await assert.rejects(
    transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO support_ticket_status_events(
           ticket_id, previous_status, status, actor_type, actor_user_id, reason
         ) VALUES ($1, 'awaiting_staff', 'closed', 'customer', $2, 'dangling')`,
        [ticketId, customer.userId],
      );
    }),
    /exact next transition|consumed exactly once/,
  );
  await assert.rejects(
    pool.query(`UPDATE support_ticket_messages SET body = 'tampered' WHERE id = $1`, [
      openingMessageId,
    ]),
    /append-only/,
  );

  await pool.query(
    `UPDATE client_accounts SET restricted_at = now() WHERE id = $1`,
    [customer.accountId],
  );
  const restrictedAccountRead = await app.inject({
    method: "GET",
    url: `/api/v1/tickets/${ticketId}`,
    headers: customerHeaders,
  });
  assert.equal(restrictedAccountRead.statusCode, 200, restrictedAccountRead.body);
  const restrictedAccountReply = await app.inject({
    method: "POST",
    url: `/api/v1/tickets/${ticketId}/replies`,
    headers: customerHeaders,
    payload: { message: "Support remains available while Commerce is restricted." },
  });
  assert.equal(restrictedAccountReply.statusCode, 201, restrictedAccountReply.body);
  await pool.query(`UPDATE users SET restricted_at = now() WHERE id = $1`, [customer.userId]);
  const restrictedUserRead = await app.inject({
    method: "GET",
    url: `/api/v1/tickets/${ticketId}`,
    headers: customerHeaders,
  });
  assert.equal(restrictedUserRead.statusCode, 403, restrictedUserRead.body);
  await assert.rejects(
    pool.query(`UPDATE presales_inquiries SET access_expires_at = now() + interval '1 year'
                WHERE id = $1`, [presalesBody.inquiryId]),
    /identity is immutable/,
  );
  await assert.rejects(
    pool.query(
      `UPDATE support_ticket_attachment_scan_facts
       SET verdict = 'rejected', reason_code = 'tampered'
       WHERE attachment_id = $1`,
      [attachmentId],
    ),
    /append-only/,
  );

  const baseline021 = schema021CatalogDigest(
    await schema021CatalogFingerprintInput(pool),
  );
  assert.equal(baseline021, SCHEMA_021_CATALOG_DIGEST);
  const tamperStatements = [
    `ALTER TABLE support_tickets
       DROP CONSTRAINT support_tickets_priority_check`,
    `DROP INDEX support_ticket_assignment_events_latest_idx`,
    `DROP TRIGGER support_ticket_attachment_scan_facts_guard
       ON support_ticket_attachment_scan_facts`,
    `ALTER FUNCTION opensales_validate_presales_access_revocation()
       RENAME TO opensales_validate_presales_access_revocation_tampered`,
    `CREATE OR REPLACE VIEW public.current_presales_inquiry_status AS
       SELECT inquiry.id AS inquiry_id, event.status,
              event.actor_type, event.actor_user_id, event.reason,
              event.occurred_at + interval '1 microsecond' AS occurred_at
       FROM presales_inquiries inquiry
       JOIN presales_inquiry_status_events event
         ON event.id = inquiry.current_status_event_id`,
  ] as const;
  const catalogClient = await pool.connect();
  try {
    for (const statement of tamperStatements) {
      await catalogClient.query("BEGIN");
      try {
        await catalogClient.query(statement);
        const tampered = schema021CatalogDigest(
          await schema021CatalogFingerprintInput(catalogClient),
        );
        assert.notEqual(tampered, SCHEMA_021_CATALOG_DIGEST, statement);
      } finally {
        await catalogClient.query("ROLLBACK");
      }
    }
  } finally {
    catalogClient.release();
  }

  process.stdout.write("Support operations PG18 integration: PASS\n");
} finally {
  await app.close();
  await pool.end();
}
