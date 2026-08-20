// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assertCustomerCapability,
  assertIdentityReadEligible,
  expectedAccountContextVersion,
  lockSupportAccountContextForMutation,
  requireSessionIdentity,
  requireUser,
} from "./auth.js";
import type { Config } from "./config.js";
import {
  transaction,
  type DatabaseClient,
  type DatabasePool,
} from "./database.js";
import { requestFingerprint } from "./idempotency.js";
import {
  requireStaffActionLocked,
  requireStaffPermission,
} from "./routes-admin.js";

const canonicalUuid = z.uuid().transform((value) => value.toLowerCase());
const departmentCode = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
const ticketStatus = z.enum(["awaiting_staff", "awaiting_customer", "closed"]);
const presalesStatus = z.enum(["awaiting_staff", "awaiting_visitor", "closed"]);
const priority = z.enum(["low", "normal", "high", "urgent"]);

const departmentRevisionBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(2_000).default(""),
    acceptsAuthenticated: z.boolean().default(true),
    acceptsPresales: z.boolean().default(false),
    reason: z.string().trim().min(1).max(1_000).optional(),
    idempotencyKey: canonicalUuid.optional(),
  })
  .strict();

const createDepartmentBody = departmentRevisionBody
  .omit({ reason: true })
  .extend({ code: departmentCode })
  .strict();

const assignTicketBody = z
  .object({
    assignedStaffUserId: canonicalUuid.nullable(),
    reason: z.string().trim().min(1).max(1_000),
    idempotencyKey: canonicalUuid.optional(),
  })
  .strict();

const routeTicketBody = z
  .object({
    departmentCode,
    priority,
    reason: z.string().trim().min(1).max(1_000),
    idempotencyKey: canonicalUuid.optional(),
  })
  .strict();

const statusBody = z
  .object({
    status: z.enum(["awaiting_staff", "closed"]),
    reason: z.string().trim().min(1).max(1_000),
    idempotencyKey: canonicalUuid.optional(),
  })
  .strict();

const attachmentBody = z
  .object({
    filename: z
      .string()
      .trim()
      .min(1)
      .max(180)
      .refine(
        (value) => !/[\\/"\u0000-\u001f\u007f]/.test(value),
        "Filename contains an unsupported character",
      ),
    contentType: z.enum([
      "text/plain",
      "text/csv",
      "application/pdf",
      "image/png",
      "image/jpeg",
    ]),
    contentBase64: z.string().min(1).max(1_400_000),
    idempotencyKey: canonicalUuid.optional(),
  })
  .strict();

const attachmentScanBody = z
  .object({
    verdict: z.enum(["clean", "rejected", "error"]),
    reasonCode: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9_]+$/)
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((body, context) => {
    if ((body.verdict === "clean") !== (body.reasonCode == null)) {
      context.addIssue({
        code: "custom",
        message: "Clean verdicts omit a reason; non-clean verdicts require one",
      });
    }
  });

const presalesCreateBody = z
  .object({
    visitorName: z.string().trim().min(2).max(120),
    visitorEmail: z.email().max(320).transform((value) => value.toLowerCase()),
    topic: z.enum(["general_sales", "product_question"]),
    subject: z.string().trim().min(3).max(160),
    message: z.string().trim().min(1).max(10_000),
    departmentCode: departmentCode.default("general-support"),
    idempotencyKey: canonicalUuid.optional(),
  })
  .strict();

const presalesReplyBody = z
  .object({
    message: z.string().trim().min(1).max(10_000),
    idempotencyKey: canonicalUuid.optional(),
  })
  .strict();

const staffPresalesMessageBody = z
  .object({
    kind: z.enum(["public_reply", "internal_note"]),
    message: z.string().trim().min(1).max(10_000),
    idempotencyKey: canonicalUuid.optional(),
  })
  .strict();

function requestError(message: string, statusCode: number, code?: string): Error {
  return Object.assign(new Error(message), {
    statusCode,
    ...(code ? { code } : {}),
  });
}

function idempotencyConflict(resource: string): never {
  throw requestError(
    `This idempotency key was already used for a different ${resource}`,
    409,
    "IDEMPOTENCY_CONFLICT",
  );
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function exactBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw requestError("Attachment content must be canonical base64", 400);
  }
  const content = Buffer.from(value, "base64");
  if (content.length < 1 || content.length > 1_048_576) {
    throw requestError("Attachment must be between 1 byte and 1 MiB", 400);
  }
  if (content.toString("base64") !== value) {
    throw requestError("Attachment content must be canonical base64", 400);
  }
  return content;
}

function attachmentShape(body: z.infer<typeof attachmentBody>) {
  const extension = body.filename.toLowerCase().split(".").at(-1) ?? "";
  const expectedType: Readonly<Record<string, string>> = {
    txt: "text/plain",
    log: "text/plain",
    csv: "text/csv",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
  };
  if (expectedType[extension] !== body.contentType) {
    throw requestError("Attachment extension and content type do not match", 400);
  }
  const content = exactBase64(body.contentBase64);
  return {
    extension,
    content,
    sha256: createHash("sha256").update(content).digest(),
  };
}

async function assertAssignmentReplay(
  client: DatabaseClient,
  input: Readonly<{
    eventId: string;
    ticketId: string;
    assignedStaffUserId: string | null;
    actorStaffUserId: string;
    reason: string;
  }>,
): Promise<boolean> {
  const result = await client.query<{
    ticket_id: string;
    assigned_staff_user_id: string | null;
    actor_staff_user_id: string;
    reason: string;
  }>(
    `SELECT ticket_id, assigned_staff_user_id, actor_staff_user_id, reason
     FROM support_ticket_assignment_events WHERE id = $1`,
    [input.eventId],
  );
  const existing = result.rows[0];
  if (!existing) return false;
  if (
    existing.ticket_id !== input.ticketId ||
    existing.assigned_staff_user_id !== input.assignedStaffUserId ||
    existing.actor_staff_user_id !== input.actorStaffUserId ||
    existing.reason !== input.reason
  ) idempotencyConflict("Support assignment");
  return true;
}

async function assertRoutingReplay(
  client: DatabaseClient,
  input: Readonly<{
    eventId: string;
    ticketId: string;
    departmentCode: string;
    priority: z.infer<typeof priority>;
    actorStaffUserId: string;
    reason: string;
  }>,
): Promise<boolean> {
  const result = await client.query<{
    ticket_id: string;
    department_code: string;
    priority: z.infer<typeof priority>;
    actor_staff_user_id: string;
    reason: string;
  }>(
    `SELECT event.ticket_id, department.code::text AS department_code,
            event.priority, event.actor_staff_user_id, event.reason
     FROM support_ticket_routing_events event
     JOIN support_department_revisions revision
       ON revision.id = event.department_revision_id
     JOIN support_departments department ON department.id = revision.department_id
     WHERE event.id = $1`,
    [input.eventId],
  );
  const existing = result.rows[0];
  if (!existing) return false;
  if (
    existing.ticket_id !== input.ticketId ||
    existing.department_code !== input.departmentCode ||
    existing.priority !== input.priority ||
    existing.actor_staff_user_id !== input.actorStaffUserId ||
    existing.reason !== input.reason
  ) idempotencyConflict("Support routing event");
  return true;
}

async function assertTicketStatusReplay(
  client: DatabaseClient,
  input: Readonly<{
    eventId: string;
    ticketId: string;
    status: z.infer<typeof ticketStatus>;
    actorType: "customer" | "staff";
    actorUserId: string;
    reason: string;
  }>,
): Promise<boolean> {
  const result = await client.query<{
    ticket_id: string;
    status: z.infer<typeof ticketStatus>;
    actor_type: string;
    actor_user_id: string | null;
    reason: string;
  }>(
    `SELECT ticket_id, status, actor_type, actor_user_id, reason
     FROM support_ticket_status_events WHERE id = $1`,
    [input.eventId],
  );
  const existing = result.rows[0];
  if (!existing) return false;
  if (
    existing.ticket_id !== input.ticketId ||
    existing.status !== input.status ||
    existing.actor_type !== input.actorType ||
    existing.actor_user_id !== input.actorUserId ||
    existing.reason !== input.reason
  ) idempotencyConflict("Support status event");
  return true;
}

async function assertAttachmentReplay(
  client: DatabaseClient,
  input: Readonly<{
    attachmentId: string;
    ticketId: string;
    messageId: string;
    uploadedByUserId: string;
    uploadedByType: "customer" | "staff";
    visibility: "public" | "internal";
    filename: string;
    extension: string;
    contentType: string;
    content: Buffer;
    sha256: Buffer;
  }>,
): Promise<boolean> {
  const result = await client.query<{
    ticket_id: string;
    message_id: string;
    uploaded_by_user_id: string;
    uploaded_by_type: "customer" | "staff";
    visibility: "public" | "internal";
    original_filename: string;
    extension: string;
    declared_content_type: string;
    size_bytes: number;
    sha256: Buffer;
    content: Buffer;
  }>(
    `SELECT ticket_id, message_id, uploaded_by_user_id, uploaded_by_type,
            visibility, original_filename, extension, declared_content_type,
            size_bytes, sha256, content
     FROM support_ticket_attachments WHERE id = $1`,
    [input.attachmentId],
  );
  const existing = result.rows[0];
  if (!existing) return false;
  if (
    existing.ticket_id !== input.ticketId ||
    existing.message_id !== input.messageId ||
    existing.uploaded_by_user_id !== input.uploadedByUserId ||
    existing.uploaded_by_type !== input.uploadedByType ||
    existing.visibility !== input.visibility ||
    existing.original_filename !== input.filename ||
    existing.extension !== input.extension ||
    existing.declared_content_type !== input.contentType ||
    existing.size_bytes !== input.content.length ||
    !existing.sha256.equals(input.sha256) ||
    !existing.content.equals(input.content)
  ) idempotencyConflict("Support attachment");
  return true;
}

async function assertPresalesMessageReplay(
  client: DatabaseClient,
  input: Readonly<{
    messageId: string;
    inquiryId: string;
    authorType: "visitor" | "staff";
    authorUserId: string | null;
    visibility: "public" | "internal";
    body: string;
  }>,
): Promise<boolean> {
  const result = await client.query<{
    inquiry_id: string;
    author_type: "visitor" | "staff";
    author_user_id: string | null;
    visibility: "public" | "internal";
    body: string;
  }>(
    `SELECT inquiry_id, author_type, author_user_id, visibility, body
     FROM presales_inquiry_messages WHERE id = $1`,
    [input.messageId],
  );
  const existing = result.rows[0];
  if (!existing) return false;
  if (
    existing.inquiry_id !== input.inquiryId ||
    existing.author_type !== input.authorType ||
    existing.author_user_id !== input.authorUserId ||
    existing.visibility !== input.visibility ||
    existing.body !== input.body
  ) idempotencyConflict("Presales message");
  return true;
}

async function assertPresalesStatusReplay(
  client: DatabaseClient,
  input: Readonly<{
    eventId: string;
    inquiryId: string;
    status: z.infer<typeof presalesStatus>;
    actorUserId: string;
    reason: string;
  }>,
): Promise<boolean> {
  const result = await client.query<{
    inquiry_id: string;
    status: z.infer<typeof presalesStatus>;
    actor_type: string;
    actor_user_id: string | null;
    reason: string;
  }>(
    `SELECT inquiry_id, status, actor_type, actor_user_id, reason
     FROM presales_inquiry_status_events WHERE id = $1`,
    [input.eventId],
  );
  const existing = result.rows[0];
  if (!existing) return false;
  if (
    existing.inquiry_id !== input.inquiryId ||
    existing.status !== input.status ||
    existing.actor_type !== "staff" ||
    existing.actor_user_id !== input.actorUserId ||
    existing.reason !== input.reason
  ) idempotencyConflict("Presales status event");
  return true;
}

function stablePresalesAccessToken(config: Config, idempotencyKey?: string): string {
  if (!idempotencyKey) return randomBytes(32).toString("base64url");
  return createHmac("sha256", config.IDENTITY_SECRET_KEY)
    .update("opensales:presales-access:v1\0")
    .update(idempotencyKey)
    .digest("base64url");
}

async function transitionTicket(
  client: DatabaseClient,
  input: Readonly<{
    ticketId: string;
    previousStatus: z.infer<typeof ticketStatus>;
    status: z.infer<typeof ticketStatus>;
    actorType: "customer" | "staff";
    actorUserId: string;
    reason: string;
    eventId?: string;
  }>,
): Promise<void> {
  if (input.status === input.previousStatus) return;
  const eventId = input.eventId ?? randomUUID();
  await client.query(
    `INSERT INTO support_ticket_status_events(
       id, ticket_id, previous_status, status,
       actor_type, actor_user_id, reason
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      eventId,
      input.ticketId,
      input.previousStatus,
      input.status,
      input.actorType,
      input.actorUserId,
      input.reason,
    ],
  );
  await client.query(
    `UPDATE support_tickets
     SET status = $2, current_status_event_id = $3,
         updated_at = GREATEST(updated_at + interval '1 microsecond',
                               clock_timestamp())
     WHERE id = $1`,
    [input.ticketId, input.status, eventId],
  );
}

async function transitionPresales(
  client: DatabaseClient,
  input: Readonly<{
    inquiryId: string;
    previousStatus: z.infer<typeof presalesStatus>;
    status: z.infer<typeof presalesStatus>;
    actorType: "visitor" | "staff";
    actorUserId: string | null;
    reason: string;
    eventId?: string;
  }>,
): Promise<void> {
  if (input.status === input.previousStatus) {
    await client.query(
      `UPDATE presales_inquiries
       SET updated_at = GREATEST(updated_at + interval '1 microsecond',
                                 clock_timestamp())
       WHERE id = $1`,
      [input.inquiryId],
    );
    return;
  }
  const eventId = input.eventId ?? randomUUID();
  await client.query(
    `INSERT INTO presales_inquiry_status_events(
       id, inquiry_id, previous_status, status,
       actor_type, actor_user_id, reason
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      eventId,
      input.inquiryId,
      input.previousStatus,
      input.status,
      input.actorType,
      input.actorUserId,
      input.reason,
    ],
  );
  await client.query(
    `UPDATE presales_inquiries
     SET status = $2, current_status_event_id = $3,
         updated_at = GREATEST(updated_at + interval '1 microsecond',
                               clock_timestamp())
     WHERE id = $1`,
    [input.inquiryId, input.status, eventId],
  );
}

function presalesToken(request: { headers: Record<string, unknown> }): string {
  const parsed = z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .safeParse(request.headers["x-oss-presales-token"]);
  if (!parsed.success) {
    throw requestError("A valid Presales access token is required", 401);
  }
  return parsed.data;
}

export async function registerSupportOperationRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get("/api/v1/support/departments", async (request) => {
    const query = z
      .object({ audience: z.enum(["authenticated", "presales"]).default("authenticated") })
      .parse(request.query);
    if (query.audience === "authenticated") {
      const user = await requireUser(request, pool, config);
      assertIdentityReadEligible(user);
    }
    const result = await pool.query<{
      code: string;
      revision: number;
      name: string;
      description: string;
      accepts_authenticated: boolean;
      accepts_presales: boolean;
    }>(
      `SELECT department.code::text,
              revision.revision,
              revision.name,
              revision.description,
              revision.accepts_authenticated,
              revision.accepts_presales
       FROM support_departments department
       JOIN support_department_revisions revision
         ON revision.id = department.current_revision_id
       WHERE CASE WHEN $1 = 'presales'
                  THEN revision.accepts_presales
                  ELSE revision.accepts_authenticated
             END
       ORDER BY department.code`,
      [query.audience],
    );
    return {
      items: result.rows.map((row) => ({
        code: row.code,
        revision: row.revision,
        name: row.name,
        description: row.description,
        acceptsAuthenticated: row.accepts_authenticated,
        acceptsPresales: row.accepts_presales,
      })),
    };
  });

  app.get("/api/v1/admin/support/departments", async (request) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "support.tickets.manage");
    const result = await pool.query<{
      id: string;
      code: string;
      revision_id: string;
      revision: number;
      name: string;
      description: string;
      accepts_authenticated: boolean;
      accepts_presales: boolean;
      created_at: Date;
    }>(
      `SELECT department.id, department.code::text,
              revision.id AS revision_id, revision.revision,
              revision.name, revision.description,
              revision.accepts_authenticated, revision.accepts_presales,
              revision.created_at
       FROM support_departments department
       JOIN support_department_revisions revision
         ON revision.id = department.current_revision_id
       ORDER BY department.code`,
    );
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        code: row.code,
        currentRevision: {
          id: row.revision_id,
          revision: row.revision,
          name: row.name,
          description: row.description,
          acceptsAuthenticated: row.accepts_authenticated,
          acceptsPresales: row.accepts_presales,
          createdAt: row.created_at.toISOString(),
        },
      })),
    };
  });

  app.post("/api/v1/admin/support/departments", async (request, reply) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "support.tickets.manage");
    const body = createDepartmentBody.parse(request.body);
    const id = body.idempotencyKey ?? randomUUID();
    const revisionId = body.idempotencyKey ?? randomUUID();
    let replayed = false;
    await transaction(pool, async (client) => {
      await requireStaffActionLocked(client, user, "support.tickets.manage");
      if (body.idempotencyKey) {
        const existing = await client.query<{
          code: string;
          name: string | null;
          description: string | null;
          accepts_authenticated: boolean | null;
          accepts_presales: boolean | null;
          created_by_staff_user_id: string | null;
        }>(
          `SELECT department.code::text, revision.name, revision.description,
                  revision.accepts_authenticated, revision.accepts_presales,
                  revision.created_by_staff_user_id
           FROM support_departments department
           LEFT JOIN support_department_revisions revision
             ON revision.id = $1 AND revision.department_id = department.id
           WHERE department.id = $1`,
          [id],
        );
        const previous = existing.rows[0];
        if (previous) {
          if (
            previous.code !== body.code ||
            previous.name !== body.name ||
            previous.description !== body.description ||
            previous.accepts_authenticated !== body.acceptsAuthenticated ||
            previous.accepts_presales !== body.acceptsPresales ||
            previous.created_by_staff_user_id !== user.userId
          ) idempotencyConflict("Support department");
          replayed = true;
          return;
        }
      }
      await client.query(
        `INSERT INTO support_departments(id, code, current_revision_id)
         VALUES ($1, $2, $3)`,
        [id, body.code, revisionId],
      );
      await client.query(
        `INSERT INTO support_department_revisions(
           id, department_id, revision, name, description,
           accepts_authenticated, accepts_presales, created_by_staff_user_id
         ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7)`,
        [
          revisionId,
          id,
          body.name,
          body.description,
          body.acceptsAuthenticated,
          body.acceptsPresales,
          user.userId,
        ],
      );
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, metadata
         ) VALUES ('staff', $1, 'support.department_created',
                   'support_department', $2, $3)`,
        [user.userId, id, { code: body.code, revisionId, idempotencyKey: body.idempotencyKey ?? null }],
      );
    });
    return reply.code(replayed ? 200 : 201).send({ id, code: body.code, revisionId, revision: 1 });
  });

  app.post(
    "/api/v1/admin/support/departments/:departmentId/revisions",
    async (request, reply) => {
      const user = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, user, "support.tickets.manage");
      const params = z.object({ departmentId: canonicalUuid }).parse(request.params);
      const body = departmentRevisionBody.parse(request.body);
      const revisionId = body.idempotencyKey ?? randomUUID();
      const fingerprint = requestFingerprint("support.department.revision:v1", {
        departmentId: params.departmentId,
        actorStaffUserId: user.userId,
        name: body.name,
        description: body.description,
        acceptsAuthenticated: body.acceptsAuthenticated,
        acceptsPresales: body.acceptsPresales,
        reason: body.reason ?? "Superseded by a new department revision",
      });
      let replayed = false;
      const revision = await transaction(pool, async (client) => {
        await requireStaffActionLocked(client, user, "support.tickets.manage");
        if (body.idempotencyKey) {
          const existing = await client.query<{
            department_id: string;
            revision: number;
            name: string;
            description: string;
            accepts_authenticated: boolean;
            accepts_presales: boolean;
            created_by_staff_user_id: string;
            request_fingerprint: string | null;
          }>(
            `SELECT revision.department_id, revision.revision, revision.name,
                    revision.description, revision.accepts_authenticated,
                    revision.accepts_presales, revision.created_by_staff_user_id,
                    audit.metadata->>'requestFingerprint' AS request_fingerprint
             FROM support_department_revisions revision
             LEFT JOIN audit_events audit
               ON audit.action = 'support.department_revised'
              AND audit.target_type = 'support_department'
              AND audit.target_id = revision.department_id
              AND audit.metadata->>'revisionId' = revision.id::text
             WHERE revision.id = $1`,
            [revisionId],
          );
          const previousReplay = existing.rows[0];
          if (previousReplay) {
            if (
              previousReplay.department_id !== params.departmentId ||
              previousReplay.name !== body.name ||
              previousReplay.description !== body.description ||
              previousReplay.accepts_authenticated !== body.acceptsAuthenticated ||
              previousReplay.accepts_presales !== body.acceptsPresales ||
              previousReplay.created_by_staff_user_id !== user.userId ||
              previousReplay.request_fingerprint !== fingerprint
            ) idempotencyConflict("Support department revision");
            replayed = true;
            return previousReplay.revision;
          }
        }
        const pointer = await client.query<{ current_revision_id: string }>(
          `SELECT current_revision_id
           FROM support_departments
           WHERE id = $1
           FOR UPDATE`,
          [params.departmentId],
        );
        const currentRevisionId = pointer.rows[0]?.current_revision_id;
        if (!currentRevisionId) throw requestError("Support department not found", 404);
        const current = await client.query<{ id: string; revision: number }>(
          `SELECT id, revision
           FROM support_department_revisions
           WHERE id = $1 AND department_id = $2
           FOR UPDATE`,
          [currentRevisionId, params.departmentId],
        );
        const previous = current.rows[0];
        if (!previous) throw requestError("Support department not found", 404);
        await client.query(
          `INSERT INTO support_department_revision_retirements(
             revision_id, retired_by_staff_user_id, reason
           ) VALUES ($1, $2, $3)`,
          [
            previous.id,
            user.userId,
            body.reason ?? "Superseded by a new department revision",
          ],
        );
        const nextRevision = previous.revision + 1;
        await client.query(
          `INSERT INTO support_department_revisions(
             id, department_id, revision, name, description,
             accepts_authenticated, accepts_presales, created_by_staff_user_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            revisionId,
            params.departmentId,
            nextRevision,
            body.name,
            body.description,
            body.acceptsAuthenticated,
            body.acceptsPresales,
            user.userId,
          ],
        );
        await client.query(
          `UPDATE support_departments
           SET current_revision_id = $2
           WHERE id = $1`,
          [params.departmentId, revisionId],
        );
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, metadata
           ) VALUES ('staff', $1, 'support.department_revised',
                     'support_department', $2, $3)`,
          [
            user.userId,
            params.departmentId,
            {
              previousRevisionId: previous.id,
              revisionId,
              revision: nextRevision,
              requestFingerprint: fingerprint,
            },
          ],
        );
        return nextRevision;
      });
      return reply.code(replayed ? 200 : 201).send({
        departmentId: params.departmentId,
        revisionId,
        revision,
      });
    },
  );

  app.post("/api/v1/admin/tickets/:ticketId/assignments", async (request, reply) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "support.tickets.manage");
    const params = z.object({ ticketId: canonicalUuid }).parse(request.params);
    const body = assignTicketBody.parse(request.body);
    const eventId = body.idempotencyKey ?? randomUUID();
    let replayed = false;
    await transaction(pool, async (client) => {
      await requireStaffActionLocked(
        client,
        user,
        "support.tickets.manage",
        body.assignedStaffUserId ? [body.assignedStaffUserId] : [],
      );
      if (body.idempotencyKey && await assertAssignmentReplay(client, {
        eventId,
        ticketId: params.ticketId,
        assignedStaffUserId: body.assignedStaffUserId,
        actorStaffUserId: user.userId,
        reason: body.reason,
      })) {
        replayed = true;
        return;
      }
      const ticket = await client.query(
        `SELECT id FROM support_tickets WHERE id = $1 FOR UPDATE`,
        [params.ticketId],
      );
      if (ticket.rowCount !== 1) throw requestError("Ticket not found", 404);
      await client.query(
        `INSERT INTO support_ticket_assignment_events(
           id, ticket_id, assigned_staff_user_id, actor_staff_user_id, reason
         ) VALUES ($1, $2, $3, $4, $5)`,
        [eventId, params.ticketId, body.assignedStaffUserId, user.userId, body.reason],
      );
      await client.query(
        `UPDATE support_tickets
         SET updated_at = GREATEST(updated_at + interval '1 microsecond',
                                   clock_timestamp())
         WHERE id = $1`,
        [params.ticketId],
      );
    });
    return reply.code(replayed ? 200 : 201).send({
      id: eventId,
      ticketId: params.ticketId,
      assignedStaffUserId: body.assignedStaffUserId,
    });
  });

  app.post("/api/v1/admin/tickets/:ticketId/routing", async (request, reply) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "support.tickets.manage");
    const params = z.object({ ticketId: canonicalUuid }).parse(request.params);
    const body = routeTicketBody.parse(request.body);
    const eventId = body.idempotencyKey ?? randomUUID();
    let replayed = false;
    await transaction(pool, async (client) => {
      await requireStaffActionLocked(client, user, "support.tickets.manage");
      if (body.idempotencyKey && await assertRoutingReplay(client, {
        eventId,
        ticketId: params.ticketId,
        departmentCode: body.departmentCode,
        priority: body.priority,
        actorStaffUserId: user.userId,
        reason: body.reason,
      })) {
        replayed = true;
        return;
      }
      const department = await client.query<{ current_revision_id: string }>(
        `SELECT current_revision_id
         FROM support_departments
         WHERE code = $1
         FOR SHARE`,
        [body.departmentCode],
      );
      const departmentRevisionId = department.rows[0]?.current_revision_id;
      if (!departmentRevisionId) throw requestError("Support department not found", 404);
      const revision = await client.query(
        `SELECT id FROM support_department_revisions
         WHERE id = $1 AND accepts_authenticated`,
        [departmentRevisionId],
      );
      if (revision.rowCount !== 1) throw requestError("Support department not found", 404);
      const ticket = await client.query(
        `SELECT id FROM support_tickets WHERE id = $1 FOR UPDATE`,
        [params.ticketId],
      );
      if (ticket.rowCount !== 1) throw requestError("Ticket not found", 404);
      await client.query(
        `INSERT INTO support_ticket_routing_events(
           id, ticket_id, department_revision_id, priority,
           actor_staff_user_id, reason
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          eventId,
          params.ticketId,
          departmentRevisionId,
          body.priority,
          user.userId,
          body.reason,
        ],
      );
      await client.query(
        `UPDATE support_tickets
         SET updated_at = GREATEST(updated_at + interval '1 microsecond',
                                   clock_timestamp())
         WHERE id = $1`,
        [params.ticketId],
      );
    });
    return reply.code(replayed ? 200 : 201).send({
      id: eventId,
      ticketId: params.ticketId,
      departmentCode: body.departmentCode,
      priority: body.priority,
    });
  });

  app.post("/api/v1/admin/tickets/:ticketId/status", async (request, reply) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "support.tickets.manage");
    const params = z.object({ ticketId: canonicalUuid }).parse(request.params);
    const body = statusBody.parse(request.body);
    const eventId = body.idempotencyKey ?? randomUUID();
    let replayed = false;
    await transaction(pool, async (client) => {
      await requireStaffActionLocked(client, user, "support.tickets.manage");
      if (body.idempotencyKey && await assertTicketStatusReplay(client, {
        eventId,
        ticketId: params.ticketId,
        status: body.status,
        actorType: "staff",
        actorUserId: user.userId,
        reason: body.reason,
      })) {
        replayed = true;
        return;
      }
      const result = await client.query<{ status: z.infer<typeof ticketStatus> }>(
        `SELECT status FROM support_tickets WHERE id = $1 FOR UPDATE`,
        [params.ticketId],
      );
      const current = result.rows[0];
      if (!current) throw requestError("Ticket not found", 404);
      if (current.status === body.status) {
        replayed = true;
        return;
      }
      await transitionTicket(client, {
        ticketId: params.ticketId,
        previousStatus: current.status,
        status: body.status,
        actorType: "staff",
        actorUserId: user.userId,
        reason: body.reason,
        eventId,
      });
    });
    return reply.code(replayed ? 200 : 201).send({ ticketId: params.ticketId, status: body.status });
  });

  app.post("/api/v1/tickets/:ticketId/status", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    const expectedVersion = expectedAccountContextVersion(request);
    assertIdentityReadEligible(user);
    assertCustomerCapability(user, "support.tickets.write");
    const params = z.object({ ticketId: canonicalUuid }).parse(request.params);
    const body = statusBody.parse(request.body);
    const eventId = body.idempotencyKey ?? randomUUID();
    let replayed = false;
    await transaction(pool, async (client) => {
      const context = await lockSupportAccountContextForMutation(
        client,
        user,
        expectedVersion,
      );
      assertCustomerCapability(context, "support.tickets.write");
      const result = await client.query<{ status: z.infer<typeof ticketStatus> }>(
        `SELECT status FROM support_tickets
         WHERE id = $1 AND client_account_id = $2
         FOR UPDATE`,
        [params.ticketId, user.clientAccountId],
      );
      const current = result.rows[0];
      if (!current) throw requestError("Ticket not found", 404);
      if (body.idempotencyKey && await assertTicketStatusReplay(client, {
        eventId,
        ticketId: params.ticketId,
        status: body.status,
        actorType: "customer",
        actorUserId: user.userId,
        reason: body.reason,
      })) {
        replayed = true;
        return;
      }
      if (current.status === body.status) {
        replayed = true;
        return;
      }
      if (body.status === "awaiting_staff" && current.status !== "closed") {
        throw requestError("Only a closed ticket can be reopened", 409);
      }
      await transitionTicket(client, {
        ticketId: params.ticketId,
        previousStatus: current.status,
        status: body.status,
        actorType: "customer",
        actorUserId: user.userId,
        reason: body.reason,
        eventId,
      });
    });
    return reply.code(replayed ? 200 : 201).send({ ticketId: params.ticketId, status: body.status });
  });

  app.post(
    "/api/v1/tickets/:ticketId/messages/:messageId/attachments",
    { bodyLimit: 1_500_000 },
    async (request, reply) => {
      const user = await requireUser(request, pool, config);
      const expectedVersion = expectedAccountContextVersion(request);
      assertIdentityReadEligible(user);
      assertCustomerCapability(user, "support.tickets.write");
      const params = z
        .object({ ticketId: canonicalUuid, messageId: canonicalUuid })
        .parse(request.params);
      const body = attachmentBody.parse(request.body);
      const attachment = attachmentShape(body);
      const id = body.idempotencyKey ?? randomUUID();
      let replayed = false;
      await transaction(pool, async (client) => {
        const context = await lockSupportAccountContextForMutation(
          client,
          user,
          expectedVersion,
        );
        assertCustomerCapability(context, "support.tickets.write");
        const message = await client.query<{ status: z.infer<typeof ticketStatus> }>(
          `SELECT ticket.status
           FROM support_tickets ticket
           JOIN support_ticket_messages message ON message.ticket_id = ticket.id
           WHERE ticket.id = $1
             AND ticket.client_account_id = $2
             AND message.id = $3
             AND message.author_type = 'customer'
             AND message.author_user_id = $4
             AND message.visibility = 'public'
           FOR UPDATE OF ticket`,
          [params.ticketId, user.clientAccountId, params.messageId, user.userId],
        );
        const source = message.rows[0];
        if (!source) throw requestError("Ticket message not found", 404);
        if (body.idempotencyKey && await assertAttachmentReplay(client, {
          attachmentId: id,
          ticketId: params.ticketId,
          messageId: params.messageId,
          uploadedByUserId: user.userId,
          uploadedByType: "customer",
          visibility: "public",
          filename: body.filename,
          extension: attachment.extension,
          contentType: body.contentType,
          content: attachment.content,
          sha256: attachment.sha256,
        })) {
          replayed = true;
          return;
        }
        if (source.status === "closed") {
          throw requestError("Closed tickets cannot receive attachments", 409, "TICKET_CLOSED");
        }
        await client.query(
          `INSERT INTO support_ticket_attachments(
             id, ticket_id, message_id, uploaded_by_user_id,
             uploaded_by_type, visibility, original_filename,
             extension, declared_content_type, size_bytes, sha256, content
           ) VALUES ($1, $2, $3, $4, 'customer', 'public',
                     $5, $6, $7, $8, $9, $10)`,
          [
            id,
            params.ticketId,
            params.messageId,
            user.userId,
            body.filename,
            attachment.extension,
            body.contentType,
            attachment.content.length,
            attachment.sha256,
            attachment.content,
          ],
        );
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, metadata
           ) VALUES ('user', $1, 'support.attachment_uploaded',
                     'support_ticket_attachment', $2, $3)`,
          [
            user.userId,
            id,
            {
              ticketId: params.ticketId,
              messageId: params.messageId,
              filename: body.filename,
              sizeBytes: attachment.content.length,
            },
          ],
        );
        await client.query(
          `UPDATE support_tickets
           SET updated_at = GREATEST(updated_at + interval '1 microsecond',
                                     clock_timestamp())
           WHERE id = $1`,
          [params.ticketId],
        );
      });
      return reply.code(replayed ? 200 : 201).send({
        id,
        ticketId: params.ticketId,
        messageId: params.messageId,
        filename: body.filename,
        contentType: body.contentType,
        sizeBytes: attachment.content.length,
      });
    },
  );

  app.post(
    "/api/v1/admin/tickets/:ticketId/messages/:messageId/attachments",
    { bodyLimit: 1_500_000 },
    async (request, reply) => {
      const user = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, user, "support.tickets.manage");
      const params = z
        .object({ ticketId: canonicalUuid, messageId: canonicalUuid })
        .parse(request.params);
      const body = attachmentBody.parse(request.body);
      const attachment = attachmentShape(body);
      const id = body.idempotencyKey ?? randomUUID();
      let replayed = false;
      await transaction(pool, async (client) => {
        await requireStaffActionLocked(client, user, "support.tickets.manage");
        const message = await client.query<{
          visibility: "public" | "internal";
          status: z.infer<typeof ticketStatus>;
        }>(
          `SELECT message.visibility, ticket.status
           FROM support_tickets ticket
           JOIN support_ticket_messages message ON message.ticket_id = ticket.id
           WHERE ticket.id = $1 AND message.id = $2
             AND message.author_type = 'staff'
             AND message.author_user_id = $3
           FOR UPDATE OF ticket`,
          [params.ticketId, params.messageId, user.userId],
        );
        const source = message.rows[0];
        if (!source) throw requestError("Ticket message not found", 404);
        if (body.idempotencyKey && await assertAttachmentReplay(client, {
          attachmentId: id,
          ticketId: params.ticketId,
          messageId: params.messageId,
          uploadedByUserId: user.userId,
          uploadedByType: "staff",
          visibility: source.visibility,
          filename: body.filename,
          extension: attachment.extension,
          contentType: body.contentType,
          content: attachment.content,
          sha256: attachment.sha256,
        })) {
          replayed = true;
          return;
        }
        if (source.status === "closed") {
          throw requestError("Closed tickets cannot receive attachments", 409, "TICKET_CLOSED");
        }
        await client.query(
          `INSERT INTO support_ticket_attachments(
             id, ticket_id, message_id, uploaded_by_user_id,
             uploaded_by_type, visibility, original_filename,
             extension, declared_content_type, size_bytes, sha256, content
           ) VALUES ($1, $2, $3, $4, 'staff', $5,
                     $6, $7, $8, $9, $10, $11)`,
          [
            id,
            params.ticketId,
            params.messageId,
            user.userId,
            source.visibility,
            body.filename,
            attachment.extension,
            body.contentType,
            attachment.content.length,
            attachment.sha256,
            attachment.content,
          ],
        );
        await client.query(
          `UPDATE support_tickets
           SET updated_at = GREATEST(updated_at + interval '1 microsecond',
                                     clock_timestamp())
           WHERE id = $1`,
          [params.ticketId],
        );
      });
      return reply.code(replayed ? 200 : 201).send({
        id,
        ticketId: params.ticketId,
        messageId: params.messageId,
        filename: body.filename,
        contentType: body.contentType,
        sizeBytes: attachment.content.length,
      });
    },
  );

  app.get("/api/v1/tickets/:ticketId/attachments/:attachmentId", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    assertIdentityReadEligible(user);
    const params = z
      .object({ ticketId: canonicalUuid, attachmentId: canonicalUuid })
      .parse(request.params);
    const result = await pool.query<{
      original_filename: string;
      declared_content_type: string;
      content: Buffer;
    }>(
      `SELECT attachment.original_filename,
              attachment.declared_content_type,
              attachment.content
       FROM support_ticket_attachments attachment
       JOIN support_tickets ticket ON ticket.id = attachment.ticket_id
       LEFT JOIN support_ticket_attachment_deletions deletion
         ON deletion.attachment_id = attachment.id
       JOIN support_ticket_attachment_scan_facts scan
         ON scan.attachment_id = attachment.id
        AND scan.verdict = 'clean'
       WHERE attachment.id = $1
         AND attachment.ticket_id = $2
         AND ticket.client_account_id = $3
         AND attachment.visibility = 'public'
         AND deletion.id IS NULL`,
      [params.attachmentId, params.ticketId, user.clientAccountId],
    );
    const attachment = result.rows[0];
    if (!attachment) throw requestError("Attachment not found", 404);
    return reply
      .type(attachment.declared_content_type)
      .header(
        "Content-Disposition",
        `attachment; filename="${attachment.original_filename}"`,
      )
      .send(attachment.content);
  });

  app.get(
    "/api/v1/admin/tickets/:ticketId/attachments/:attachmentId",
    async (request, reply) => {
      const user = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, user, "support.tickets.manage");
      const params = z
        .object({ ticketId: canonicalUuid, attachmentId: canonicalUuid })
        .parse(request.params);
      const result = await pool.query<{
        original_filename: string;
        declared_content_type: string;
        content: Buffer;
      }>(
        `SELECT attachment.original_filename,
                attachment.declared_content_type,
                attachment.content
         FROM support_ticket_attachments attachment
         LEFT JOIN support_ticket_attachment_deletions deletion
           ON deletion.attachment_id = attachment.id
         JOIN support_ticket_attachment_scan_facts scan
           ON scan.attachment_id = attachment.id
          AND scan.verdict = 'clean'
         WHERE attachment.id = $1
           AND attachment.ticket_id = $2
           AND deletion.id IS NULL`,
        [params.attachmentId, params.ticketId],
      );
      const attachment = result.rows[0];
      if (!attachment) throw requestError("Attachment not found", 404);
      return reply
        .type(attachment.declared_content_type)
        .header(
          "Content-Disposition",
          `attachment; filename="${attachment.original_filename}"`,
        )
        .send(attachment.content);
    },
  );

  app.delete(
    "/api/v1/tickets/:ticketId/attachments/:attachmentId",
    async (request, reply) => {
      const user = await requireUser(request, pool, config);
      const expectedVersion = expectedAccountContextVersion(request);
      assertIdentityReadEligible(user);
      assertCustomerCapability(user, "support.tickets.write");
      const params = z
        .object({ ticketId: canonicalUuid, attachmentId: canonicalUuid })
        .parse(request.params);
      const body = z
        .object({ idempotencyKey: canonicalUuid.optional() })
        .strict()
        .parse(request.body ?? {});
      const deletionId = body.idempotencyKey ?? randomUUID();
      await transaction(pool, async (client) => {
        const context = await lockSupportAccountContextForMutation(
          client,
          user,
          expectedVersion,
        );
        assertCustomerCapability(context, "support.tickets.write");
        const attachment = await client.query<{ id: string; deletion_id: string | null }>(
          `SELECT attachment.id, deletion.id AS deletion_id
           FROM support_ticket_attachments attachment
           JOIN support_tickets ticket ON ticket.id = attachment.ticket_id
           LEFT JOIN support_ticket_attachment_deletions deletion
             ON deletion.attachment_id = attachment.id
           WHERE attachment.id = $1
             AND attachment.ticket_id = $2
             AND ticket.client_account_id = $3
             AND attachment.uploaded_by_user_id = $4
             AND attachment.uploaded_by_type = 'customer'
           FOR UPDATE OF ticket`,
          [params.attachmentId, params.ticketId, user.clientAccountId, user.userId],
        );
        const existing = attachment.rows[0];
        if (!existing) throw requestError("Attachment not found", 404);
        if (existing.deletion_id) return;
        await client.query(
          `INSERT INTO support_ticket_attachment_deletions(
             id, attachment_id, deleted_by_user_id, deleted_by_type, reason
           ) VALUES ($1, $2, $3, 'customer', $4)`,
          [deletionId, params.attachmentId, user.userId, "Customer removed the attachment"],
        );
      });
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/admin/tickets/:ticketId/attachments/:attachmentId/scan-result",
    async (request, reply) => {
      const user = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, user, "support.tickets.manage");
      const params = z
        .object({ ticketId: canonicalUuid, attachmentId: canonicalUuid })
        .parse(request.params);
      const body = attachmentScanBody.parse(request.body);
      await transaction(pool, async (client) => {
        await requireStaffActionLocked(client, user, "support.tickets.manage");
        const attachment = await client.query<{ sha256: Buffer }>(
          `SELECT attachment.sha256
           FROM support_ticket_attachments attachment
           WHERE attachment.id = $1 AND attachment.ticket_id = $2
           FOR SHARE`,
          [params.attachmentId, params.ticketId],
        );
        const row = attachment.rows[0];
        if (!row) throw requestError("Attachment not found", 404);
        await client.query(
          `INSERT INTO support_ticket_attachment_scan_facts(
             attachment_id, scanner, recorded_by_staff_user_id,
             verdict, content_sha256, reason_code
           ) VALUES ($1, 'mock-attachment-scanner-v1', $2, $3, $4, $5)`,
          [
            params.attachmentId,
            user.userId,
            body.verdict,
            row.sha256,
            body.reasonCode ?? null,
          ],
        );
      });
      return reply.code(201).send({
        attachmentId: params.attachmentId,
        verdict: body.verdict,
      });
    },
  );

  app.post("/api/v1/presales/inquiries", async (request, reply) => {
    const body = presalesCreateBody.parse(request.body);
    const inquiryId = body.idempotencyKey ?? randomUUID();
    const statusEventId = body.idempotencyKey ?? randomUUID();
    const messageId = body.idempotencyKey ?? randomUUID();
    const accessToken = stablePresalesAccessToken(config, body.idempotencyKey);
    const fingerprint = requestFingerprint("support.presales.create:v1", {
      visitorName: body.visitorName,
      visitorEmail: body.visitorEmail,
      topic: body.topic,
      subject: body.subject,
      message: body.message,
      departmentCode: body.departmentCode,
    });
    let replayed = false;
    await transaction(pool, async (client) => {
      if (body.idempotencyKey) {
        const existing = await client.query<{
          visitor_name: string;
          visitor_email: string;
          topic: string;
          subject: string;
          department_code: string;
          message: string | null;
          access_token_digest: Buffer;
          request_fingerprint: string | null;
        }>(
          `SELECT inquiry.visitor_name, inquiry.visitor_email::text,
                  inquiry.topic, inquiry.subject,
                  department.code::text AS department_code,
                  opening.body AS message, inquiry.access_token_digest,
                  audit.metadata->>'requestFingerprint' AS request_fingerprint
           FROM presales_inquiries inquiry
           JOIN support_department_revisions revision
             ON revision.id = inquiry.department_revision_id
           JOIN support_departments department ON department.id = revision.department_id
           LEFT JOIN presales_inquiry_messages opening
             ON opening.id = $1 AND opening.inquiry_id = inquiry.id
           LEFT JOIN audit_events audit
             ON audit.action = 'support.presales_created'
            AND audit.target_type = 'presales_inquiry'
            AND audit.target_id = inquiry.id
           WHERE inquiry.id = $1`,
          [inquiryId],
        );
        const previous = existing.rows[0];
        if (previous) {
          if (
            previous.visitor_name !== body.visitorName ||
            previous.visitor_email !== body.visitorEmail ||
            previous.topic !== body.topic ||
            previous.subject !== body.subject ||
            previous.department_code !== body.departmentCode ||
            previous.message !== body.message ||
            !previous.access_token_digest.equals(digestToken(accessToken)) ||
            previous.request_fingerprint !== fingerprint
          ) idempotencyConflict("Presales inquiry");
          replayed = true;
          return;
        }
      }
      const department = await client.query<{ current_revision_id: string }>(
        `SELECT current_revision_id
         FROM support_departments
         WHERE code = $1
         FOR SHARE`,
        [body.departmentCode],
      );
      const departmentRevisionId = department.rows[0]?.current_revision_id;
      if (!departmentRevisionId) throw requestError("Support department not found", 404);
      const revision = await client.query(
        `SELECT id FROM support_department_revisions
         WHERE id = $1 AND accepts_presales`,
        [departmentRevisionId],
      );
      if (revision.rowCount !== 1) throw requestError("Support department not found", 404);
      await client.query(
        `INSERT INTO presales_inquiry_status_events(
           id, inquiry_id, previous_status, status,
           actor_type, actor_user_id, reason
         ) VALUES ($1, $2, NULL, 'awaiting_staff', 'visitor', NULL, $3)`,
        [statusEventId, inquiryId, "Visitor created the Presales inquiry"],
      );
      await client.query(
        `INSERT INTO presales_inquiries(
           id, access_token_digest, access_expires_at,
           department_revision_id, visitor_name, visitor_email,
           topic, subject, status, current_status_event_id
         ) VALUES ($1, $2, pg_catalog.clock_timestamp() + interval '30 days', $3, $4, $5,
                   $6, $7, 'awaiting_staff', $8)`,
        [
          inquiryId,
          digestToken(accessToken),
          departmentRevisionId,
          body.visitorName,
          body.visitorEmail,
          body.topic,
          body.subject,
          statusEventId,
        ],
      );
      await client.query(
        `INSERT INTO presales_inquiry_messages(
           id, inquiry_id, author_type, author_user_id, visibility, body
         ) VALUES ($1, $2, 'visitor', NULL, 'public', $3)`,
        [messageId, inquiryId, body.message],
      );
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, metadata
         ) VALUES ('system', 'core', 'support.presales_created',
                   'presales_inquiry', $1, $2)`,
        [
          inquiryId,
          {
            topic: body.topic,
            departmentCode: body.departmentCode,
            requestFingerprint: fingerprint,
            messageId,
          },
        ],
      );
    });
    return reply.code(replayed ? 200 : 201).send({
      inquiryId,
      accessToken,
      status: "awaiting_staff",
      expiresInDays: 30,
    });
  });

  app.get("/api/v1/presales/inquiries/:inquiryId", async (request) => {
    const token = presalesToken(request);
    const params = z.object({ inquiryId: canonicalUuid }).parse(request.params);
    const inquiry = await pool.query<{
      id: string;
      visitor_name: string;
      visitor_email: string;
      topic: "general_sales" | "product_question";
      subject: string;
      status: z.infer<typeof presalesStatus>;
      department_name: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT inquiry.id, inquiry.visitor_name,
              inquiry.visitor_email::text, inquiry.topic,
              inquiry.subject, inquiry.status,
              revision.name AS department_name,
              inquiry.created_at, inquiry.updated_at
       FROM presales_inquiries inquiry
       JOIN support_department_revisions revision
         ON revision.id = inquiry.department_revision_id
       WHERE inquiry.id = $1
         AND inquiry.access_token_digest = $2
         AND inquiry.access_expires_at > pg_catalog.clock_timestamp()
         AND NOT EXISTS (
           SELECT 1 FROM presales_inquiry_access_revocations revocation
           WHERE revocation.inquiry_id = inquiry.id
         )`,
      [params.inquiryId, digestToken(token)],
    );
    const row = inquiry.rows[0];
    if (!row) throw requestError("Presales inquiry not found", 404);
    const messages = await pool.query<{
      id: string;
      author_type: "visitor" | "staff";
      body: string;
      created_at: Date;
    }>(
      `SELECT id, author_type, body, created_at
       FROM presales_inquiry_messages
       WHERE inquiry_id = $1 AND visibility = 'public'
       ORDER BY created_at, id`,
      [params.inquiryId],
    );
    return {
      inquiry: {
        id: row.id,
        visitorName: row.visitor_name,
        visitorEmail: row.visitor_email,
        topic: row.topic,
        subject: row.subject,
        status: row.status,
        departmentName: row.department_name,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      },
      messages: messages.rows.map((message) => ({
        id: message.id,
        authorType: message.author_type,
        body: message.body,
        createdAt: message.created_at.toISOString(),
      })),
    };
  });

  app.post("/api/v1/presales/inquiries/:inquiryId/replies", async (request, reply) => {
    const token = presalesToken(request);
    const params = z.object({ inquiryId: canonicalUuid }).parse(request.params);
    const body = presalesReplyBody.parse(request.body);
    const messageId = body.idempotencyKey ?? randomUUID();
    let replayed = false;
    await transaction(pool, async (client) => {
      const inquiry = await client.query<{
        status: z.infer<typeof presalesStatus>;
      }>(
        `SELECT status
         FROM presales_inquiries
         WHERE id = $1
           AND access_token_digest = $2
           AND access_expires_at > pg_catalog.clock_timestamp()
           AND NOT EXISTS (
             SELECT 1 FROM presales_inquiry_access_revocations revocation
             WHERE revocation.inquiry_id = presales_inquiries.id
           )
         FOR UPDATE`,
        [params.inquiryId, digestToken(token)],
      );
      const current = inquiry.rows[0];
      if (!current) throw requestError("Presales inquiry not found", 404);
      if (body.idempotencyKey && await assertPresalesMessageReplay(client, {
        messageId,
        inquiryId: params.inquiryId,
        authorType: "visitor",
        authorUserId: null,
        visibility: "public",
        body: body.message,
      })) {
        replayed = true;
        return;
      }
      if (current.status === "closed") {
        throw requestError("Closed Presales inquiries cannot be replied to", 409);
      }
      await client.query(
        `INSERT INTO presales_inquiry_messages(
           id, inquiry_id, author_type, author_user_id, visibility, body
         ) VALUES ($1, $2, 'visitor', NULL, 'public', $3)`,
        [messageId, params.inquiryId, body.message],
      );
      await transitionPresales(client, {
        inquiryId: params.inquiryId,
        previousStatus: current.status,
        status: "awaiting_staff",
        actorType: "visitor",
        actorUserId: null,
        reason: "Visitor replied to the Presales inquiry",
        ...(body.idempotencyKey ? { eventId: body.idempotencyKey } : {}),
      });
    });
    return reply.code(replayed ? 200 : 201).send({ id: messageId, status: "awaiting_staff" });
  });

  app.get("/api/v1/admin/presales/inquiries", async (request) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "support.tickets.manage");
    const query = z
      .object({ status: presalesStatus.optional(), topic: z.enum(["general_sales", "product_question"]).optional() })
      .parse(request.query);
    const result = await pool.query<{
      id: string;
      visitor_name: string;
      visitor_email: string;
      topic: "general_sales" | "product_question";
      subject: string;
      status: z.infer<typeof presalesStatus>;
      department_name: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT inquiry.id, inquiry.visitor_name,
              inquiry.visitor_email::text, inquiry.topic,
              inquiry.subject, inquiry.status,
              revision.name AS department_name,
              inquiry.created_at, inquiry.updated_at
       FROM presales_inquiries inquiry
       JOIN support_department_revisions revision
         ON revision.id = inquiry.department_revision_id
       WHERE ($1::text IS NULL OR inquiry.status = $1)
         AND ($2::text IS NULL OR inquiry.topic = $2)
       ORDER BY inquiry.updated_at DESC, inquiry.id DESC`,
      [query.status ?? null, query.topic ?? null],
    );
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        visitorName: row.visitor_name,
        visitorEmail: row.visitor_email,
        topic: row.topic,
        subject: row.subject,
        status: row.status,
        departmentName: row.department_name,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
    };
  });

  app.get("/api/v1/admin/presales/inquiries/:inquiryId", async (request) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "support.tickets.manage");
    const params = z.object({ inquiryId: canonicalUuid }).parse(request.params);
    const inquiry = await pool.query<{
      id: string;
      visitor_name: string;
      visitor_email: string;
      topic: "general_sales" | "product_question";
      subject: string;
      status: z.infer<typeof presalesStatus>;
      department_name: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT inquiry.id, inquiry.visitor_name,
              inquiry.visitor_email::text, inquiry.topic,
              inquiry.subject, inquiry.status,
              revision.name AS department_name,
              inquiry.created_at, inquiry.updated_at
       FROM presales_inquiries inquiry
       JOIN support_department_revisions revision
         ON revision.id = inquiry.department_revision_id
       WHERE inquiry.id = $1`,
      [params.inquiryId],
    );
    const row = inquiry.rows[0];
    if (!row) throw requestError("Presales inquiry not found", 404);
    const messages = await pool.query<{
      id: string;
      author_type: "visitor" | "staff";
      author_user_id: string | null;
      visibility: "public" | "internal";
      body: string;
      created_at: Date;
    }>(
      `SELECT id, author_type, author_user_id, visibility, body, created_at
       FROM presales_inquiry_messages
       WHERE inquiry_id = $1
       ORDER BY created_at, id`,
      [params.inquiryId],
    );
    return {
      inquiry: {
        id: row.id,
        visitorName: row.visitor_name,
        visitorEmail: row.visitor_email,
        topic: row.topic,
        subject: row.subject,
        status: row.status,
        departmentName: row.department_name,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      },
      messages: messages.rows.map((message) => ({
        id: message.id,
        authorType: message.author_type,
        authorUserId: message.author_user_id,
        visibility: message.visibility,
        body: message.body,
        createdAt: message.created_at.toISOString(),
      })),
    };
  });

  app.post(
    "/api/v1/admin/presales/inquiries/:inquiryId/messages",
    async (request, reply) => {
      const user = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, user, "support.tickets.manage");
      const params = z.object({ inquiryId: canonicalUuid }).parse(request.params);
      const body = staffPresalesMessageBody.parse(request.body);
      const messageId = body.idempotencyKey ?? randomUUID();
      const visibility = body.kind === "internal_note" ? "internal" : "public";
      let replayed = false;
      await transaction(pool, async (client) => {
        await requireStaffActionLocked(client, user, "support.tickets.manage");
        const inquiry = await client.query<{
          status: z.infer<typeof presalesStatus>;
        }>(
          `SELECT status FROM presales_inquiries WHERE id = $1 FOR UPDATE`,
          [params.inquiryId],
        );
        const current = inquiry.rows[0];
        if (!current) throw requestError("Presales inquiry not found", 404);
        if (body.idempotencyKey && await assertPresalesMessageReplay(client, {
          messageId,
          inquiryId: params.inquiryId,
          authorType: "staff",
          authorUserId: user.userId,
          visibility,
          body: body.message,
        })) {
          replayed = true;
          return;
        }
        if (current.status === "closed") {
          throw requestError("Closed Presales inquiries cannot be replied to", 409);
        }
        await client.query(
          `INSERT INTO presales_inquiry_messages(
             id, inquiry_id, author_type, author_user_id, visibility, body
           ) VALUES ($1, $2, 'staff', $3, $4, $5)`,
          [messageId, params.inquiryId, user.userId, visibility, body.message],
        );
        if (visibility === "public") {
          await transitionPresales(client, {
            inquiryId: params.inquiryId,
            previousStatus: current.status,
            status: "awaiting_visitor",
            actorType: "staff",
            actorUserId: user.userId,
            reason: "Staff posted a public Presales reply",
            ...(body.idempotencyKey ? { eventId: body.idempotencyKey } : {}),
          });
        } else {
          await client.query(
            `UPDATE presales_inquiries
             SET updated_at = GREATEST(updated_at + interval '1 microsecond',
                                       clock_timestamp())
             WHERE id = $1`,
            [params.inquiryId],
          );
        }
      });
      return reply.code(replayed ? 200 : 201).send({ id: messageId, kind: body.kind });
    },
  );

  app.post("/api/v1/admin/presales/inquiries/:inquiryId/status", async (request, reply) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "support.tickets.manage");
    const params = z.object({ inquiryId: canonicalUuid }).parse(request.params);
    const body = z
      .object({
        status: presalesStatus,
        reason: z.string().trim().min(1).max(1_000),
        idempotencyKey: canonicalUuid.optional(),
      })
      .strict()
      .parse(request.body);
    const eventId = body.idempotencyKey ?? randomUUID();
    let replayed = false;
    await transaction(pool, async (client) => {
      await requireStaffActionLocked(client, user, "support.tickets.manage");
      if (body.idempotencyKey && await assertPresalesStatusReplay(client, {
        eventId,
        inquiryId: params.inquiryId,
        status: body.status,
        actorUserId: user.userId,
        reason: body.reason,
      })) {
        replayed = true;
        return;
      }
      const inquiry = await client.query<{
        status: z.infer<typeof presalesStatus>;
      }>(
        `SELECT status FROM presales_inquiries WHERE id = $1 FOR UPDATE`,
        [params.inquiryId],
      );
      const current = inquiry.rows[0];
      if (!current) throw requestError("Presales inquiry not found", 404);
      if (current.status === body.status) {
        replayed = true;
        return;
      }
      await transitionPresales(client, {
        inquiryId: params.inquiryId,
        previousStatus: current.status,
        status: body.status,
        actorType: "staff",
        actorUserId: user.userId,
        reason: body.reason,
        eventId,
      });
    });
    return reply.code(replayed ? 200 : 201).send({ inquiryId: params.inquiryId, status: body.status });
  });

  app.post(
    "/api/v1/admin/presales/inquiries/:inquiryId/access-revocation",
    async (request, reply) => {
      const user = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, user, "support.tickets.manage");
      const params = z.object({ inquiryId: canonicalUuid }).parse(request.params);
      const body = z
        .object({ reason: z.string().trim().min(1).max(1_000) })
        .strict()
        .parse(request.body);
      await transaction(pool, async (client) => {
        await requireStaffActionLocked(client, user, "support.tickets.manage");
        const result = await client.query(
          `INSERT INTO presales_inquiry_access_revocations(
             inquiry_id, revoked_by_staff_user_id, reason
           ) VALUES ($1, $2, $3)
           ON CONFLICT (inquiry_id) DO NOTHING`,
          [params.inquiryId, user.userId, body.reason],
        );
        if (result.rowCount !== 1) {
          throw requestError("Presales access is already revoked", 409);
        }
      });
      return reply.code(201).send({ inquiryId: params.inquiryId, revoked: true });
    },
  );

  app.delete(
    "/api/v1/admin/tickets/:ticketId/attachments/:attachmentId",
    async (request, reply) => {
      const user = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, user, "support.tickets.manage");
      const params = z
        .object({ ticketId: canonicalUuid, attachmentId: canonicalUuid })
        .parse(request.params);
      const body = z
        .object({
          reason: z.string().trim().min(1).max(1_000),
          idempotencyKey: canonicalUuid.optional(),
        })
        .strict()
        .parse(request.body);
      const deletionId = body.idempotencyKey ?? randomUUID();
      await transaction(pool, async (client) => {
        await requireStaffActionLocked(client, user, "support.tickets.manage");
        const attachment = await client.query<{ id: string; deletion_id: string | null }>(
          `SELECT attachment.id, deletion.id AS deletion_id
           FROM support_ticket_attachments attachment
           LEFT JOIN support_ticket_attachment_deletions deletion
             ON deletion.attachment_id = attachment.id
           WHERE attachment.id = $1
             AND attachment.ticket_id = $2
           FOR UPDATE OF attachment`,
          [params.attachmentId, params.ticketId],
        );
        const existing = attachment.rows[0];
        if (!existing) throw requestError("Attachment not found", 404);
        if (existing.deletion_id) return;
        await client.query(
          `INSERT INTO support_ticket_attachment_deletions(
             id, attachment_id, deleted_by_user_id, deleted_by_type, reason
           ) VALUES ($1, $2, $3, 'staff', $4)`,
          [deletionId, params.attachmentId, user.userId, body.reason],
        );
      });
      return reply.code(204).send();
    },
  );
}
