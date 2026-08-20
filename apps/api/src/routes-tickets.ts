// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
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
  enqueueNotification,
  enqueueSubscribedContactNotifications,
} from "./notification-outbox.js";
import {
  requireStaffActionLocked,
  requireStaffPermission,
} from "./routes-admin.js";

const canonicalUuid = z.uuid().transform((value) => value.toLowerCase());
const supportDepartmentCode = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
const ticketStatus = z.enum(["awaiting_staff", "awaiting_customer", "closed"]);
const ticketPriority = z.enum(["low", "normal", "high", "urgent"]);

const createTicketSchema = z
  .object({
    subject: z.string().trim().min(3).max(160),
    message: z.string().trim().min(1).max(10_000),
    serviceId: canonicalUuid.nullable().optional(),
    orderId: canonicalUuid.nullable().optional(),
    departmentCode: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
      .default("general-support"),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    authorizationPurpose: z
      .enum([
        "bgp",
        "remote_hands",
        "colocation_inbound",
        "colocation_outbound",
        "third_party_refund",
      ])
      .nullable()
      .optional(),
    idempotencyKey: canonicalUuid.optional(),
  })
  .strict();

const customerReplySchema = z
  .object({
    message: z.string().trim().min(1).max(10_000),
    idempotencyKey: canonicalUuid.optional(),
  })
  .strict();

const staffMessageSchema = z
  .object({
    kind: z.enum(["public_reply", "internal_note"]),
    message: z.string().trim().min(1).max(10_000),
    idempotencyKey: canonicalUuid.optional(),
  })
  .strict();

type TicketStatus = "awaiting_staff" | "awaiting_customer" | "closed";

type CustomerTicketRow = {
  id: string;
  subject: string;
  status: TicketStatus;
  service_id: string | null;
  product_name: string | null;
  order_id: string | null;
  authorization_purpose: string | null;
  department_code: string;
  department_name: string;
  priority: "low" | "normal" | "high" | "urgent";
  assigned_staff_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  public_message_count: string;
};

type TicketMessageRow = {
  id: string;
  author_type: "customer" | "staff";
  visibility: "public" | "internal";
  body: string;
  author_email: string;
  created_at: Date;
};

type TicketAttachmentRow = {
  id: string;
  message_id: string;
  original_filename: string;
  declared_content_type: string;
  size_bytes: number;
  uploaded_by_type: "customer" | "staff";
  scan_status: "pending" | "clean" | "rejected" | "error";
  created_at: Date;
};

type TicketStatusEventRow = {
  id: string;
  previous_status: TicketStatus | null;
  status: TicketStatus;
  actor_type: "migration" | "customer" | "staff" | "system";
  actor_user_id: string | null;
  actor_email: string | null;
  reason: string;
  occurred_at: Date;
};

type TicketAssignmentEventRow = {
  id: string;
  assigned_staff_user_id: string | null;
  assigned_staff_email: string | null;
  actor_type: "customer" | "staff";
  actor_user_id: string;
  actor_email: string;
  sequence: number;
  reason: string;
  occurred_at: Date;
};

type TicketRoutingEventRow = {
  id: string;
  department_revision_id: string;
  department_code: string;
  department_name: string;
  department_revision: number;
  priority: "low" | "normal" | "high" | "urgent";
  actor_type: "customer" | "staff";
  actor_user_id: string;
  actor_email: string;
  sequence: number;
  reason: string;
  occurred_at: Date;
};

function requestError(message: string, statusCode: number, code?: string): Error {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

async function assertMessageReplay(
  queryable: DatabasePool | DatabaseClient,
  input: Readonly<{
    messageId: string;
    ticketId: string;
    authorUserId: string;
    authorType: "customer" | "staff";
    visibility: "public" | "internal";
    body: string;
  }>,
): Promise<boolean> {
  const result = await queryable.query<{
    ticket_id: string;
    author_user_id: string;
    author_type: "customer" | "staff";
    visibility: "public" | "internal";
    body: string;
  }>(
    `SELECT ticket_id, author_user_id, author_type, visibility, body
     FROM support_ticket_messages
     WHERE id = $1`,
    [input.messageId],
  );
  const existing = result.rows[0];
  if (!existing) return false;
  if (
    existing.ticket_id !== input.ticketId ||
    existing.author_user_id !== input.authorUserId ||
    existing.author_type !== input.authorType ||
    existing.visibility !== input.visibility ||
    existing.body !== input.body
  ) {
    throw requestError(
      "This idempotency key was already used for a different Support message",
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  }
  return true;
}

async function assertTicketCreateReplay(
  queryable: DatabasePool | DatabaseClient,
  input: Readonly<{
    ticketId: string;
    clientAccountId: string;
    createdByUserId: string;
    fingerprint: string;
  }>,
): Promise<boolean> {
  const result = await queryable.query<{
    client_account_id: string;
    created_by_user_id: string;
    request_fingerprint: string | null;
  }>(
    `SELECT ticket.client_account_id,
            ticket.created_by_user_id,
            audit.metadata->>'requestFingerprint' AS request_fingerprint
     FROM support_tickets ticket
     LEFT JOIN audit_events audit
       ON audit.action = 'support.ticket_created'
      AND audit.target_type = 'support_ticket'
      AND audit.target_id = ticket.id
     WHERE ticket.id = $1`,
    [input.ticketId],
  );
  const existing = result.rows[0];
  if (!existing) return false;
  if (
    existing.client_account_id !== input.clientAccountId ||
    existing.created_by_user_id !== input.createdByUserId ||
    existing.request_fingerprint !== input.fingerprint
  ) {
    throw requestError(
      "This idempotency key was already used for a different Support ticket",
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  }
  return true;
}

function rethrowNotificationRecipientLock(error: unknown): never {
  if (error && typeof error === "object" && "code" in error && error.code === "55P03") {
    throw requestError(
      "Ticket notification recipient changed; retry",
      409,
      "NOTIFICATION_RECIPIENT_CHANGED",
    );
  }
  throw error;
}

function customerTicket(row: CustomerTicketRow) {
  return {
    id: row.id,
    subject: row.subject,
    status: row.status,
    service: row.service_id
      ? { id: row.service_id, productName: row.product_name ?? "Service" }
      : null,
    orderId: row.order_id,
    authorizationPurpose: row.authorization_purpose,
    department: { code: row.department_code, name: row.department_name },
    priority: row.priority,
    publicMessageCount: Number(row.public_message_count),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function publicMessage(row: TicketMessageRow) {
  return {
    id: row.id,
    authorType: row.author_type,
    body: row.body,
    createdAt: row.created_at.toISOString(),
  };
}

function staffMessage(row: TicketMessageRow) {
  return {
    ...publicMessage(row),
    visibility: row.visibility,
    authorEmail: row.author_email,
  };
}

async function loadStatusHistory(pool: DatabasePool, ticketId: string) {
  const result = await pool.query<TicketStatusEventRow>(
    `SELECT event.id, event.previous_status, event.status,
            event.actor_type, event.actor_user_id,
            actor.email::text AS actor_email,
            event.reason, event.occurred_at
     FROM support_ticket_status_events event
     LEFT JOIN users actor ON actor.id = event.actor_user_id
     WHERE event.ticket_id = $1
     ORDER BY event.occurred_at, event.id`,
    [ticketId],
  );
  return result.rows.map((event) => ({
    id: event.id,
    previousStatus: event.previous_status,
    status: event.status,
    actorType: event.actor_type,
    actorUserId: event.actor_user_id,
    actorEmail: event.actor_email,
    reason: event.reason,
    occurredAt: event.occurred_at.toISOString(),
  }));
}

async function loadAssignmentHistory(pool: DatabasePool, ticketId: string) {
  const result = await pool.query<TicketAssignmentEventRow>(
    `SELECT history.id, history.assigned_staff_user_id,
            assignee.email::text AS assigned_staff_email,
            history.actor_type, history.actor_user_id,
            actor.email::text AS actor_email,
            history.sequence, history.reason, history.occurred_at
     FROM (
       SELECT ticket.id, NULL::uuid AS assigned_staff_user_id,
              'customer'::text AS actor_type,
              ticket.created_by_user_id AS actor_user_id,
              0 AS sequence, 'Ticket created unassigned'::text AS reason,
              ticket.created_at AS occurred_at
       FROM support_tickets ticket
       WHERE ticket.id = $1
       UNION ALL
       SELECT event.id, event.assigned_staff_user_id,
              'staff'::text, event.actor_staff_user_id,
              event.sequence, event.reason, event.occurred_at
       FROM support_ticket_assignment_events event
       WHERE event.ticket_id = $1
     ) history
     LEFT JOIN users assignee ON assignee.id = history.assigned_staff_user_id
     JOIN users actor ON actor.id = history.actor_user_id
     ORDER BY history.sequence, history.id`,
    [ticketId],
  );
  return result.rows.map((event) => ({
    id: event.id,
    assignedStaffUserId: event.assigned_staff_user_id,
    assignedStaffEmail: event.assigned_staff_email,
    actorType: event.actor_type,
    actorUserId: event.actor_user_id,
    actorEmail: event.actor_email,
    sequence: event.sequence,
    reason: event.reason,
    occurredAt: event.occurred_at.toISOString(),
  }));
}

async function loadRoutingHistory(pool: DatabasePool, ticketId: string) {
  const result = await pool.query<TicketRoutingEventRow>(
    `SELECT history.id, history.department_revision_id,
            department.code::text AS department_code,
            revision.name AS department_name,
            revision.revision AS department_revision,
            history.priority, history.actor_type, history.actor_user_id,
            actor.email::text AS actor_email,
            history.sequence, history.reason, history.occurred_at
     FROM (
       SELECT ticket.id, ticket.department_revision_id,
              ticket.priority, 'customer'::text AS actor_type,
              ticket.created_by_user_id AS actor_user_id,
              0 AS sequence, 'Customer selected the initial route'::text AS reason,
              ticket.created_at AS occurred_at
       FROM support_tickets ticket
       WHERE ticket.id = $1
       UNION ALL
       SELECT event.id, event.department_revision_id,
              event.priority, 'staff'::text, event.actor_staff_user_id,
              event.sequence, event.reason, event.occurred_at
       FROM support_ticket_routing_events event
       WHERE event.ticket_id = $1
     ) history
     JOIN support_department_revisions revision
       ON revision.id = history.department_revision_id
     JOIN support_departments department ON department.id = revision.department_id
     JOIN users actor ON actor.id = history.actor_user_id
     ORDER BY history.sequence, history.id`,
    [ticketId],
  );
  return result.rows.map((event) => ({
    id: event.id,
    departmentRevisionId: event.department_revision_id,
    department: {
      code: event.department_code,
      name: event.department_name,
      revision: event.department_revision,
    },
    priority: event.priority,
    actorType: event.actor_type,
    actorUserId: event.actor_user_id,
    actorEmail: event.actor_email,
    sequence: event.sequence,
    reason: event.reason,
    occurredAt: event.occurred_at.toISOString(),
  }));
}

function customerStatusHistory(
  history: Awaited<ReturnType<typeof loadStatusHistory>>,
) {
  return history.map((event) => ({
    previousStatus: event.previousStatus,
    status: event.status,
    summary: event.previousStatus === null
      ? "Ticket created"
      : event.status === "closed"
        ? "Ticket closed"
        : event.previousStatus === "closed"
          ? "Ticket reopened"
          : event.status === "awaiting_customer"
            ? "Support replied"
            : event.status === "awaiting_staff"
              ? "Customer replied"
              : "Ticket status updated",
    occurredAt: event.occurredAt,
  }));
}

function customerRoutingHistory(
  history: Awaited<ReturnType<typeof loadRoutingHistory>>,
) {
  return history.map((event) => ({
    department: event.department,
    priority: event.priority,
    summary: event.sequence === 0
      ? "Initial Support routing"
      : "Support routing updated",
    occurredAt: event.occurredAt,
  }));
}

async function loadCustomerTicket(
  pool: DatabasePool,
  ticketId: string,
  clientAccountId: string,
) {
  const ticketResult = await pool.query<CustomerTicketRow>(
    `SELECT ticket.id,
            ticket.subject,
            ticket.status,
            ticket.service_id,
            ticket.order_id,
            ticket.authorization_purpose,
            department.code::text AS department_code,
            department_revision.name AS department_name,
            routing.priority,
            assignment.assigned_staff_user_id,
            item.product_name,
            ticket.created_at,
            ticket.updated_at,
            count(message.id)::text AS public_message_count
     FROM support_tickets ticket
     LEFT JOIN services service ON service.id = ticket.service_id
     LEFT JOIN order_items item ON item.id = service.order_item_id
     JOIN current_support_ticket_routing routing ON routing.ticket_id = ticket.id
     JOIN support_department_revisions department_revision
       ON department_revision.id = routing.department_revision_id
     JOIN support_departments department
       ON department.id = department_revision.department_id
     LEFT JOIN current_support_ticket_assignments assignment
       ON assignment.ticket_id = ticket.id
     LEFT JOIN support_ticket_messages message
       ON message.ticket_id = ticket.id
      AND message.visibility = 'public'
     WHERE ticket.id = $1
       AND ticket.client_account_id = $2
     GROUP BY ticket.id, item.product_name, department.code,
              department_revision.name, routing.priority,
              assignment.assigned_staff_user_id`,
    [ticketId, clientAccountId],
  );
  const ticket = ticketResult.rows[0];
  if (!ticket) throw requestError("Ticket not found", 404);
  const messages = await pool.query<TicketMessageRow>(
    `SELECT message.id,
            message.author_type,
            message.visibility,
            message.body,
            author.email::text AS author_email,
            message.created_at
     FROM support_ticket_messages message
     JOIN users author ON author.id = message.author_user_id
     JOIN support_tickets ticket ON ticket.id = message.ticket_id
     WHERE message.ticket_id = $1
       AND ticket.client_account_id = $2
       AND message.visibility = 'public'
     ORDER BY message.created_at, message.id`,
    [ticketId, clientAccountId],
  );
  const attachments = await pool.query<TicketAttachmentRow>(
    `SELECT attachment.id, attachment.message_id,
            attachment.original_filename,
            attachment.declared_content_type,
            attachment.size_bytes,
            attachment.uploaded_by_type,
            COALESCE(scan.verdict, 'pending') AS scan_status,
            attachment.created_at
     FROM support_ticket_attachments attachment
     JOIN support_tickets ticket ON ticket.id = attachment.ticket_id
     LEFT JOIN support_ticket_attachment_deletions deletion
       ON deletion.attachment_id = attachment.id
     LEFT JOIN support_ticket_attachment_scan_facts scan
       ON scan.attachment_id = attachment.id
     WHERE attachment.ticket_id = $1
       AND ticket.client_account_id = $2
       AND attachment.visibility = 'public'
       AND deletion.id IS NULL
     ORDER BY attachment.created_at, attachment.id`,
    [ticketId, clientAccountId],
  );
  const [statusHistory, routingHistory] = await Promise.all([
    loadStatusHistory(pool, ticketId),
    loadRoutingHistory(pool, ticketId),
  ]);
  return {
    ticket: customerTicket(ticket),
    messages: messages.rows.map(publicMessage),
    attachments: attachments.rows.map((attachment) => ({
      id: attachment.id,
      messageId: attachment.message_id,
      filename: attachment.original_filename,
      contentType: attachment.declared_content_type,
      sizeBytes: attachment.size_bytes,
      uploadedByType: attachment.uploaded_by_type,
      scanStatus: attachment.scan_status,
      createdAt: attachment.created_at.toISOString(),
    })),
    statusHistory: customerStatusHistory(statusHistory),
    routingHistory: customerRoutingHistory(routingHistory),
  };
}

async function loadStaffTicket(pool: DatabasePool, ticketId: string) {
  const ticketResult = await pool.query<
    CustomerTicketRow & { client_account_id: string; client_account_name: string }
  >(
    `SELECT ticket.id,
            ticket.client_account_id,
            account.name AS client_account_name,
            ticket.subject,
            ticket.status,
            ticket.service_id,
            ticket.order_id,
            ticket.authorization_purpose,
            department.code::text AS department_code,
            department_revision.name AS department_name,
            routing.priority,
            assignment.assigned_staff_user_id,
            item.product_name,
            ticket.created_at,
            ticket.updated_at,
            count(message.id) FILTER (WHERE message.visibility = 'public')::text
              AS public_message_count
     FROM support_tickets ticket
     JOIN client_accounts account ON account.id = ticket.client_account_id
     LEFT JOIN services service ON service.id = ticket.service_id
     LEFT JOIN order_items item ON item.id = service.order_item_id
     JOIN current_support_ticket_routing routing ON routing.ticket_id = ticket.id
     JOIN support_department_revisions department_revision
       ON department_revision.id = routing.department_revision_id
     JOIN support_departments department
       ON department.id = department_revision.department_id
     LEFT JOIN current_support_ticket_assignments assignment
       ON assignment.ticket_id = ticket.id
     LEFT JOIN support_ticket_messages message ON message.ticket_id = ticket.id
     WHERE ticket.id = $1
     GROUP BY ticket.id, account.name, item.product_name, department.code,
              department_revision.name, routing.priority,
              assignment.assigned_staff_user_id`,
    [ticketId],
  );
  const ticket = ticketResult.rows[0];
  if (!ticket) throw requestError("Ticket not found", 404);
  const messages = await pool.query<TicketMessageRow>(
    `SELECT message.id,
            message.author_type,
            message.visibility,
            message.body,
            author.email::text AS author_email,
            message.created_at
     FROM support_ticket_messages message
     JOIN users author ON author.id = message.author_user_id
     WHERE message.ticket_id = $1
     ORDER BY message.created_at, message.id`,
    [ticketId],
  );
  const attachments = await pool.query<TicketAttachmentRow>(
    `SELECT attachment.id, attachment.message_id,
            attachment.original_filename,
            attachment.declared_content_type,
            attachment.size_bytes,
            attachment.uploaded_by_type,
            COALESCE(scan.verdict, 'pending') AS scan_status,
            attachment.created_at
     FROM support_ticket_attachments attachment
     LEFT JOIN support_ticket_attachment_deletions deletion
       ON deletion.attachment_id = attachment.id
     LEFT JOIN support_ticket_attachment_scan_facts scan
       ON scan.attachment_id = attachment.id
     WHERE attachment.ticket_id = $1
       AND deletion.id IS NULL
     ORDER BY attachment.created_at, attachment.id`,
    [ticketId],
  );
  const [statusHistory, assignmentHistory, routingHistory] = await Promise.all([
    loadStatusHistory(pool, ticketId),
    loadAssignmentHistory(pool, ticketId),
    loadRoutingHistory(pool, ticketId),
  ]);
  return {
    ticket: {
      ...customerTicket(ticket),
      assignedStaffUserId: ticket.assigned_staff_user_id,
      clientAccount: {
        id: ticket.client_account_id,
        name: ticket.client_account_name,
      },
    },
    messages: messages.rows.map(staffMessage),
    attachments: attachments.rows.map((attachment) => ({
      id: attachment.id,
      messageId: attachment.message_id,
      filename: attachment.original_filename,
      contentType: attachment.declared_content_type,
      sizeBytes: attachment.size_bytes,
      uploadedByType: attachment.uploaded_by_type,
      scanStatus: attachment.scan_status,
      createdAt: attachment.created_at.toISOString(),
    })),
    statusHistory,
    assignmentHistory,
    routingHistory,
  };
}

export async function registerTicketRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get("/api/v1/tickets/service-options", async (request) => {
    const user = await requireUser(request, pool, config);
    assertIdentityReadEligible(user);
    const result = await pool.query<{
      id: string;
      product_name: string;
      status: string;
    }>(
      `SELECT service.id, item.product_name, service.status
       FROM services service
       JOIN order_items item ON item.id = service.order_item_id
       WHERE service.client_account_id = $1
       ORDER BY service.created_at DESC, service.id DESC`,
      [user.clientAccountId],
    );
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        productName: row.product_name,
        status: row.status,
      })),
    };
  });

  app.get("/api/v1/tickets", async (request) => {
    const user = await requireUser(request, pool, config);
    assertIdentityReadEligible(user);
    const result = await pool.query<CustomerTicketRow>(
      `SELECT ticket.id,
              ticket.subject,
              ticket.status,
              ticket.service_id,
              ticket.order_id,
              ticket.authorization_purpose,
              department.code::text AS department_code,
              department_revision.name AS department_name,
              routing.priority,
              assignment.assigned_staff_user_id,
              item.product_name,
              ticket.created_at,
              ticket.updated_at,
              count(message.id)::text AS public_message_count
       FROM support_tickets ticket
       LEFT JOIN services service ON service.id = ticket.service_id
       LEFT JOIN order_items item ON item.id = service.order_item_id
       JOIN current_support_ticket_routing routing ON routing.ticket_id = ticket.id
       JOIN support_department_revisions department_revision
         ON department_revision.id = routing.department_revision_id
       JOIN support_departments department
         ON department.id = department_revision.department_id
       LEFT JOIN current_support_ticket_assignments assignment
         ON assignment.ticket_id = ticket.id
       LEFT JOIN support_ticket_messages message
         ON message.ticket_id = ticket.id
        AND message.visibility = 'public'
       WHERE ticket.client_account_id = $1
       GROUP BY ticket.id, item.product_name, department.code,
                department_revision.name, routing.priority,
                assignment.assigned_staff_user_id
       ORDER BY ticket.updated_at DESC, ticket.id DESC`,
      [user.clientAccountId],
    );
    return { items: result.rows.map(customerTicket) };
  });

  app.post("/api/v1/tickets", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    const expectedContextVersion = expectedAccountContextVersion(request);
    assertIdentityReadEligible(user);
    assertCustomerCapability(user, "support.tickets.write");
    const body = createTicketSchema.parse(request.body);
    if (body.authorizationPurpose && !body.serviceId && !body.orderId) {
      throw requestError(
        "Authorization tickets must reference a Service or Order",
        400,
        "TICKET_AUTHORIZATION_REFERENCE_REQUIRED",
      );
    }
    const ticketId = body.idempotencyKey ?? randomUUID();
    const statusEventId = body.idempotencyKey ?? randomUUID();
    const messageId = body.idempotencyKey ?? randomUUID();
    const fingerprint = requestFingerprint("support.ticket.create:v1", {
      clientAccountId: user.clientAccountId,
      createdByUserId: user.userId,
      subject: body.subject,
      message: body.message,
      serviceId: body.serviceId ?? null,
      orderId: body.orderId ?? null,
      departmentCode: body.departmentCode,
      priority: body.priority,
      authorizationPurpose: body.authorizationPurpose ?? null,
    });
    const replayInput = {
      ticketId,
      clientAccountId: user.clientAccountId,
      createdByUserId: user.userId,
      fingerprint,
    };
    let replayed = false;
    try {
      await transaction(pool, async (client) => {
        const context = await lockSupportAccountContextForMutation(
          client,
          user,
          expectedContextVersion,
        );
        assertCustomerCapability(context, "support.tickets.write");
        if (body.idempotencyKey && await assertTicketCreateReplay(client, replayInput)) {
          replayed = true;
          return;
        }
      let serviceOrderId: string | null = null;
      if (body.serviceId) {
        const service = await client.query<{ order_id: string }>(
          `SELECT item.order_id
           FROM services service
           JOIN order_items item ON item.id = service.order_item_id
           WHERE service.id = $1 AND service.client_account_id = $2`,
          [body.serviceId, user.clientAccountId],
        );
        if (service.rowCount !== 1) throw requestError("Service not found", 404);
        serviceOrderId = service.rows[0]?.order_id ?? null;
      }
      if (body.orderId) {
        const order = await client.query(
          `SELECT id FROM orders
           WHERE id = $1 AND client_account_id = $2`,
          [body.orderId, user.clientAccountId],
        );
        if (order.rowCount !== 1) throw requestError("Order not found", 404);
      }
      if (body.orderId && serviceOrderId && body.orderId !== serviceOrderId) {
        throw requestError(
          "Service and Order must describe the same order",
          400,
          "TICKET_REFERENCE_MISMATCH",
        );
      }
      const department = await client.query<{ current_revision_id: string }>(
        `SELECT current_revision_id
         FROM support_departments
         WHERE code = $1
         FOR SHARE`,
        [body.departmentCode],
      );
      const departmentRevisionId = department.rows[0]?.current_revision_id;
      if (!departmentRevisionId) {
        throw requestError("Support department not found", 404);
      }
      const revision = await client.query(
        `SELECT id FROM support_department_revisions
         WHERE id = $1 AND accepts_authenticated`,
        [departmentRevisionId],
      );
      if (revision.rowCount !== 1) throw requestError("Support department not found", 404);
      await client.query(
        `INSERT INTO support_ticket_status_events(
           id, ticket_id, previous_status, status,
           actor_type, actor_user_id, reason
         ) VALUES ($1, $2, NULL, 'awaiting_staff', 'customer', $3, $4)`,
        [statusEventId, ticketId, user.userId, "Customer created the ticket"],
      );
      await client.query(
        `INSERT INTO support_tickets(
           id, client_account_id, service_id, order_id,
           created_by_user_id, subject, department_revision_id,
           priority, authorization_purpose, current_status_event_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          ticketId,
          user.clientAccountId,
          body.serviceId ?? null,
          body.orderId ?? null,
          user.userId,
          body.subject,
          departmentRevisionId,
          body.priority,
          body.authorizationPurpose ?? null,
          statusEventId,
        ],
      );
      await client.query(
        `INSERT INTO support_ticket_messages(
           id, ticket_id, author_user_id, author_type, visibility, body
         ) VALUES ($1, $2, $3, 'customer', 'public', $4)`,
        [messageId, ticketId, user.userId, body.message],
      );
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, metadata
         ) VALUES ('user', $1, 'support.ticket_created', 'support_ticket', $2, $3)`,
        [
          user.userId,
          ticketId,
          {
            clientAccountId: user.clientAccountId,
            serviceId: body.serviceId ?? null,
            orderId: body.orderId ?? null,
            departmentCode: body.departmentCode,
            priority: body.priority,
            authorizationPurpose: body.authorizationPurpose ?? null,
            requestFingerprint: fingerprint,
            messageId,
          },
        ],
      );
      });
    } catch (error) {
      if (!body.idempotencyKey || !isUniqueViolation(error)) throw error;
      const matched = await transaction(pool, async (client) => {
        const context = await lockSupportAccountContextForMutation(
          client,
          user,
          expectedContextVersion,
        );
        assertCustomerCapability(context, "support.tickets.write");
        return assertTicketCreateReplay(client, replayInput);
      });
      if (!matched) throw error;
      replayed = true;
    }
    return reply.code(replayed ? 200 : 201).send(
      await loadCustomerTicket(pool, ticketId, user.clientAccountId),
    );
  });

  app.get("/api/v1/tickets/:ticketId", async (request) => {
    const user = await requireUser(request, pool, config);
    assertIdentityReadEligible(user);
    const params = z.object({ ticketId: canonicalUuid }).parse(request.params);
    return loadCustomerTicket(pool, params.ticketId, user.clientAccountId);
  });

  app.post("/api/v1/tickets/:ticketId/replies", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    const expectedContextVersion = expectedAccountContextVersion(request);
    assertIdentityReadEligible(user);
    assertCustomerCapability(user, "support.tickets.write");
    const params = z.object({ ticketId: canonicalUuid }).parse(request.params);
    const body = customerReplySchema.parse(request.body);
    const messageId = body.idempotencyKey ?? randomUUID();
    const replayInput = {
      messageId,
      ticketId: params.ticketId,
      authorUserId: user.userId,
      authorType: "customer" as const,
      visibility: "public" as const,
      body: body.message,
    };
    let replayed = false;
    try {
      await transaction(pool, async (client) => {
        const context = await lockSupportAccountContextForMutation(
          client,
          user,
          expectedContextVersion,
        );
        assertCustomerCapability(context, "support.tickets.write");
      const ticket = await client.query<{
        status: TicketStatus;
        current_status_event_id: string;
      }>(
        `SELECT status, current_status_event_id FROM support_tickets
         WHERE id = $1 AND client_account_id = $2
         FOR UPDATE`,
        [params.ticketId, user.clientAccountId],
      );
      if (!ticket.rows[0]) throw requestError("Ticket not found", 404);
      if (body.idempotencyKey && await assertMessageReplay(client, replayInput)) {
        replayed = true;
        return;
      }
      if (ticket.rows[0].status === "closed") {
        throw requestError("Closed tickets cannot be replied to", 409, "TICKET_CLOSED");
      }
      await client.query(
        `INSERT INTO support_ticket_messages(
           id, ticket_id, author_user_id, author_type, visibility, body
         ) VALUES ($1, $2, $3, 'customer', 'public', $4)`,
        [messageId, params.ticketId, user.userId, body.message],
      );
      if (ticket.rows[0].status === "awaiting_staff") {
        await client.query(
          `UPDATE support_tickets
           SET updated_at = GREATEST(updated_at + interval '1 microsecond',
                                     clock_timestamp())
           WHERE id = $1`,
          [params.ticketId],
        );
      } else {
        const statusEventId = randomUUID();
        await client.query(
          `INSERT INTO support_ticket_status_events(
             id, ticket_id, previous_status, status,
             actor_type, actor_user_id, reason
           ) VALUES ($1, $2, $3, 'awaiting_staff', 'customer', $4, $5)`,
          [
            statusEventId,
            params.ticketId,
            ticket.rows[0].status,
            user.userId,
            "Customer replied to the ticket",
          ],
        );
        await client.query(
          `UPDATE support_tickets
           SET status = 'awaiting_staff',
               current_status_event_id = $2,
               updated_at = GREATEST(updated_at + interval '1 microsecond',
                                     clock_timestamp())
           WHERE id = $1`,
          [params.ticketId, statusEventId],
        );
      }
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, metadata
         ) VALUES ('user', $1, 'support.customer_reply_added',
                   'support_ticket', $2, $3)`,
        [user.userId, params.ticketId, { messageId }],
      );
      });
    } catch (error) {
      if (!body.idempotencyKey || !isUniqueViolation(error)) throw error;
      const matched = await transaction(pool, async (client) => {
        const context = await lockSupportAccountContextForMutation(
          client,
          user,
          expectedContextVersion,
        );
        assertCustomerCapability(context, "support.tickets.write");
        const ticket = await client.query(
          `SELECT id FROM support_tickets
           WHERE id = $1 AND client_account_id = $2`,
          [params.ticketId, user.clientAccountId],
        );
        if (ticket.rowCount !== 1) throw requestError("Ticket not found", 404);
        return assertMessageReplay(client, replayInput);
      });
      if (!matched) throw error;
      replayed = true;
    }
    return reply.code(replayed ? 200 : 201).send(
      await loadCustomerTicket(pool, params.ticketId, user.clientAccountId),
    );
  });

  app.get("/api/v1/admin/tickets", async (request) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "support.tickets.manage");
    const query = z
      .object({
        clientAccountId: canonicalUuid.optional(),
        status: ticketStatus.optional(),
        department: supportDepartmentCode.optional(),
        priority: ticketPriority.optional(),
        assignee: z.union([canonicalUuid, z.literal("unassigned")]).optional(),
      })
      .strict()
      .parse(request.query);
    const result = await pool.query<
      CustomerTicketRow & {
        client_account_id: string;
        client_account_name: string;
        internal_message_count: string;
      }
    >(
      `SELECT ticket.id,
              ticket.client_account_id,
              account.name AS client_account_name,
              ticket.subject,
              ticket.status,
              ticket.service_id,
              ticket.order_id,
              ticket.authorization_purpose,
              department.code::text AS department_code,
              department_revision.name AS department_name,
              routing.priority,
              assignment.assigned_staff_user_id,
              item.product_name,
              ticket.created_at,
              ticket.updated_at,
              count(message.id) FILTER (WHERE message.visibility = 'public')::text
                AS public_message_count,
              count(message.id) FILTER (WHERE message.visibility = 'internal')::text
                AS internal_message_count
       FROM support_tickets ticket
       JOIN client_accounts account ON account.id = ticket.client_account_id
       LEFT JOIN services service ON service.id = ticket.service_id
       LEFT JOIN order_items item ON item.id = service.order_item_id
       JOIN current_support_ticket_routing routing ON routing.ticket_id = ticket.id
       JOIN support_department_revisions department_revision
         ON department_revision.id = routing.department_revision_id
       JOIN support_departments department
         ON department.id = department_revision.department_id
       LEFT JOIN current_support_ticket_assignments assignment
         ON assignment.ticket_id = ticket.id
       LEFT JOIN support_ticket_messages message ON message.ticket_id = ticket.id
       WHERE ($1::text IS NULL OR ticket.status = $1)
         AND ($2::text IS NULL OR department.code::text = $2)
         AND ($3::text IS NULL OR routing.priority = $3)
         AND (
           $4::text IS NULL OR
           ($4 = 'unassigned' AND assignment.assigned_staff_user_id IS NULL) OR
           assignment.assigned_staff_user_id::text = $4
         )
         AND ($5::uuid IS NULL OR ticket.client_account_id = $5)
       GROUP BY ticket.id, account.name, item.product_name, department.code,
                department_revision.name, routing.priority,
                assignment.assigned_staff_user_id
       ORDER BY ticket.updated_at DESC, ticket.id DESC`,
      [
        query.status ?? null,
        query.department ?? null,
        query.priority ?? null,
        query.assignee ?? null,
        query.clientAccountId ?? null,
      ],
    );
    return {
      items: result.rows.map((row) => ({
        ...customerTicket(row),
        assignedStaffUserId: row.assigned_staff_user_id,
        clientAccount: { id: row.client_account_id, name: row.client_account_name },
        internalMessageCount: Number(row.internal_message_count),
      })),
    };
  });

  app.get("/api/v1/admin/tickets/staff-options", async (request) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "support.tickets.manage");
    const result = await pool.query<{
      id: string;
      email: string;
      roles: string[];
    }>(
      `SELECT principal.id, principal.email::text, staff.roles
       FROM staff_members staff
       JOIN users principal ON principal.id = staff.user_id
       WHERE staff.active
         AND principal.email_verified_at IS NOT NULL
         AND principal.restricted_at IS NULL
         AND (staff.permissions ? '*' OR staff.permissions ? 'support.tickets.manage')
       ORDER BY principal.email, principal.id`,
    );
    return { items: result.rows };
  });

  app.get("/api/v1/admin/tickets/:ticketId", async (request) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "support.tickets.manage");
    const params = z.object({ ticketId: canonicalUuid }).parse(request.params);
    return loadStaffTicket(pool, params.ticketId);
  });

  app.post("/api/v1/admin/tickets/:ticketId/messages", async (request, reply) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "support.tickets.manage");
    const params = z.object({ ticketId: canonicalUuid }).parse(request.params);
    const body = staffMessageSchema.parse(request.body);
    const messageId = body.idempotencyKey ?? randomUUID();
    const visibility: "internal" | "public" =
      body.kind === "internal_note" ? "internal" : "public";
    const replayInput = {
      messageId,
      ticketId: params.ticketId,
      authorUserId: user.userId,
      authorType: "staff" as const,
      visibility,
      body: body.message,
    };
    let replayed = false;
    try {
      await transaction(pool, async (client) => {
        await requireStaffActionLocked(client, user, "support.tickets.manage");
        if (body.idempotencyKey && await assertMessageReplay(client, replayInput)) {
          replayed = true;
          return;
        }
      let notificationPrimary: "creator" | "recorded_owner" | null = null;
      let notificationTicketSnapshot:
        | Readonly<{
            clientAccountId: string;
            createdByUserId: string;
            subject: string;
          }>
        | null = null;
      if (visibility === "public") {
        const pointerResult = await client.query<{
          client_account_id: string;
          created_by_user_id: string;
          subject: string;
          owner_user_id: string;
        }>(
          `SELECT ticket.client_account_id,
                  ticket.created_by_user_id,
                  ticket.subject,
                  account.owner_user_id
           FROM support_tickets ticket
           JOIN client_accounts account ON account.id = ticket.client_account_id
           WHERE ticket.id = $1`,
          [params.ticketId],
        );
        const pointer = pointerResult.rows[0];
        if (!pointer) throw requestError("Ticket not found", 404);
        let principals: Array<{
          id: string;
          email: string;
          locale: string;
          email_verified_at: Date | null;
          restricted_at: Date | null;
        }>;
        let memberships: Array<{
          user_id: string;
          role: string;
          removed_at: Date | null;
          restricted_at: Date | null;
        }>;
        try {
          const principalResult = await client.query<{
            id: string;
            email: string;
            locale: string;
            email_verified_at: Date | null;
            restricted_at: Date | null;
          }>(
            `SELECT id, email::text, locale, email_verified_at, restricted_at
             FROM users
             WHERE id = ANY($1::uuid[])
             ORDER BY id
             FOR SHARE NOWAIT`,
            [[...new Set([pointer.created_by_user_id, pointer.owner_user_id])].sort()],
          );
          principals = principalResult.rows;
          const account = await client.query<{ owner_user_id: string }>(
            `SELECT owner_user_id
             FROM client_accounts
             WHERE id = $1
             FOR SHARE NOWAIT`,
            [pointer.client_account_id],
          );
          if (account.rows[0]?.owner_user_id !== pointer.owner_user_id) {
            throw requestError(
              "Ticket notification recipient changed; retry",
              409,
              "NOTIFICATION_RECIPIENT_CHANGED",
            );
          }
          const membershipResult = await client.query<{
            user_id: string;
            role: string;
            removed_at: Date | null;
            restricted_at: Date | null;
          }>(
            `SELECT user_id, role, removed_at, restricted_at
             FROM client_memberships
             WHERE client_account_id = $1
               AND user_id = ANY($2::uuid[])
             ORDER BY user_id
             FOR SHARE NOWAIT`,
            [
              pointer.client_account_id,
              [...new Set([pointer.created_by_user_id, pointer.owner_user_id])].sort(),
            ],
          );
          memberships = membershipResult.rows;
        } catch (error) {
          rethrowNotificationRecipientLock(error);
        }
        const creator = principals.find(
          (principal) => principal.id === pointer.created_by_user_id,
        );
        const creatorMembership = memberships.find(
          (membership) => membership.user_id === pointer.created_by_user_id,
        );
        const owner = principals.find((principal) => principal.id === pointer.owner_user_id);
        const ownerMembership = memberships.find(
          (membership) => membership.user_id === pointer.owner_user_id,
        );
        const creatorEligible = Boolean(
          creator?.email_verified_at &&
            !creator.restricted_at &&
            creatorMembership &&
            !creatorMembership.removed_at &&
            !creatorMembership.restricted_at,
        );
        notificationTicketSnapshot = {
          clientAccountId: pointer.client_account_id,
          createdByUserId: pointer.created_by_user_id,
          subject: pointer.subject,
        };
        const notificationPayload = {
          ticketId: params.ticketId,
          ticketMessageId: messageId,
          ticketSubject: pointer.subject,
          ticketMessage: body.message,
        } as const;
        let primaryEmail: string | null = null;
        if (creatorEligible && creator) {
          await enqueueNotification(client, {
            eventType: "notification.support_ticket_reply_requested",
            templateRevision: "support-ticket-reply-v1",
            uniqueKey: `support-ticket-reply:${messageId}`,
            payload: notificationPayload,
            recipient: {
              kind: "account_user",
              category: "support",
              userId: pointer.created_by_user_id,
              clientAccountId: pointer.client_account_id,
              email: creator.email,
              locale: creator.locale === "zh-CN" ? "zh-CN" : "en",
            },
          });
          primaryEmail = creator.email;
          notificationPrimary = "creator";
        } else if (owner && ownerMembership?.role === "owner") {
          const ownerNotification = await enqueueNotification(client, {
            eventType: "notification.support_ticket_reply_requested",
            templateRevision: "support-ticket-reply-v1",
            uniqueKey: `support-ticket-reply:${messageId}`,
            payload: notificationPayload,
            recipient: {
              kind: "account_user",
              category: "support",
              userId: pointer.owner_user_id,
              clientAccountId: pointer.client_account_id,
              email: owner.email,
              locale: owner.locale === "zh-CN" ? "zh-CN" : "en",
            },
          });
          if (ownerNotification.status === "queued") primaryEmail = owner.email;
          notificationPrimary = "recorded_owner";
        }
        await enqueueSubscribedContactNotifications(client, {
          eventType: "notification.support_ticket_reply_requested",
          templateRevision: "support-ticket-reply-v1",
          uniqueKeyPrefix: `support-ticket-reply:${messageId}`,
          payload: notificationPayload,
          clientAccountId: pointer.client_account_id,
          category: "support",
          ...(primaryEmail ? { excludeEmails: [primaryEmail] } : {}),
        });
      }

      const ticket = await client.query<{
        status: TicketStatus;
        client_account_id: string;
        created_by_user_id: string;
        subject: string;
      }>(
        `SELECT status, client_account_id, created_by_user_id, subject
         FROM support_tickets
         WHERE id = $1
         FOR UPDATE`,
        [params.ticketId],
      );
      if (!ticket.rows[0]) throw requestError("Ticket not found", 404);
      if (
        notificationTicketSnapshot &&
        (ticket.rows[0].client_account_id !== notificationTicketSnapshot.clientAccountId ||
          ticket.rows[0].created_by_user_id !== notificationTicketSnapshot.createdByUserId ||
          ticket.rows[0].subject !== notificationTicketSnapshot.subject)
      ) {
        throw requestError(
          "Ticket notification scope changed; retry",
          409,
          "NOTIFICATION_RECIPIENT_CHANGED",
        );
      }
      if (ticket.rows[0].status === "closed") {
        throw requestError("Closed tickets cannot be replied to", 409, "TICKET_CLOSED");
      }
      await client.query(
        `INSERT INTO support_ticket_messages(
           id, ticket_id, author_user_id, author_type, visibility, body
         ) VALUES ($1, $2, $3, 'staff', $4, $5)`,
        [messageId, params.ticketId, user.userId, visibility, body.message],
      );
      if (visibility === "public" && ticket.rows[0].status !== "awaiting_customer") {
        const statusEventId = randomUUID();
        await client.query(
          `INSERT INTO support_ticket_status_events(
             id, ticket_id, previous_status, status,
             actor_type, actor_user_id, reason
           ) VALUES ($1, $2, $3, 'awaiting_customer', 'staff', $4, $5)`,
          [
            statusEventId,
            params.ticketId,
            ticket.rows[0].status,
            user.userId,
            "Staff posted a public reply",
          ],
        );
        await client.query(
          `UPDATE support_tickets
           SET status = 'awaiting_customer',
               current_status_event_id = $2,
               updated_at = GREATEST(updated_at + interval '1 microsecond',
                                     clock_timestamp())
           WHERE id = $1`,
          [params.ticketId, statusEventId],
        );
      } else {
        await client.query(
          `UPDATE support_tickets
           SET updated_at = GREATEST(updated_at + interval '1 microsecond',
                                     clock_timestamp())
           WHERE id = $1`,
          [params.ticketId],
        );
      }
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, metadata
         ) VALUES ('staff', $1, $2, 'support_ticket', $3, $4)`,
        [
          user.userId,
          body.kind === "internal_note"
            ? "support.internal_note_added"
            : "support.public_reply_added",
          params.ticketId,
          { visibility, messageId, notificationPrimary },
        ],
      );
      });
    } catch (error) {
      if (!body.idempotencyKey || !isUniqueViolation(error)) throw error;
      const matched = await transaction(pool, async (client) => {
        await requireStaffActionLocked(client, user, "support.tickets.manage");
        return assertMessageReplay(client, replayInput);
      });
      if (!matched) throw error;
      replayed = true;
    }
    return reply.code(replayed ? 200 : 201).send(await loadStaffTicket(pool, params.ticketId));
  });
}
