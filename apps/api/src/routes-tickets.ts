// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertEligible, requireUser } from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabasePool } from "./database.js";
import { requireStaffPermission } from "./routes-admin.js";

const canonicalUuid = z.uuid().transform((value) => value.toLowerCase());

const createTicketSchema = z
  .object({
    subject: z.string().trim().min(3).max(160),
    message: z.string().trim().min(1).max(10_000),
    serviceId: canonicalUuid.nullable().optional(),
  })
  .strict();

const customerReplySchema = z
  .object({ message: z.string().trim().min(1).max(10_000) })
  .strict();

const staffMessageSchema = z
  .object({
    kind: z.enum(["public_reply", "internal_note"]),
    message: z.string().trim().min(1).max(10_000),
  })
  .strict();

type TicketStatus = "awaiting_staff" | "awaiting_customer" | "closed";

type CustomerTicketRow = {
  id: string;
  subject: string;
  status: TicketStatus;
  service_id: string | null;
  product_name: string | null;
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

function requestError(message: string, statusCode: number, code?: string): Error {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
}

function customerTicket(row: CustomerTicketRow) {
  return {
    id: row.id,
    subject: row.subject,
    status: row.status,
    service: row.service_id
      ? { id: row.service_id, productName: row.product_name ?? "Service" }
      : null,
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
            item.product_name,
            ticket.created_at,
            ticket.updated_at,
            count(message.id)::text AS public_message_count
     FROM support_tickets ticket
     LEFT JOIN services service ON service.id = ticket.service_id
     LEFT JOIN order_items item ON item.id = service.order_item_id
     LEFT JOIN support_ticket_messages message
       ON message.ticket_id = ticket.id
      AND message.visibility = 'public'
     WHERE ticket.id = $1
       AND ticket.client_account_id = $2
     GROUP BY ticket.id, item.product_name`,
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
  return {
    ticket: customerTicket(ticket),
    messages: messages.rows.map(publicMessage),
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
            item.product_name,
            ticket.created_at,
            ticket.updated_at,
            count(message.id) FILTER (WHERE message.visibility = 'public')::text
              AS public_message_count
     FROM support_tickets ticket
     JOIN client_accounts account ON account.id = ticket.client_account_id
     LEFT JOIN services service ON service.id = ticket.service_id
     LEFT JOIN order_items item ON item.id = service.order_item_id
     LEFT JOIN support_ticket_messages message ON message.ticket_id = ticket.id
     WHERE ticket.id = $1
     GROUP BY ticket.id, account.name, item.product_name`,
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
  return {
    ticket: {
      ...customerTicket(ticket),
      clientAccount: {
        id: ticket.client_account_id,
        name: ticket.client_account_name,
      },
    },
    messages: messages.rows.map(staffMessage),
  };
}

export async function registerTicketRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get("/api/v1/tickets/service-options", async (request) => {
    const user = await requireUser(request, pool, config);
    assertEligible(user);
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
    assertEligible(user);
    const result = await pool.query<CustomerTicketRow>(
      `SELECT ticket.id,
              ticket.subject,
              ticket.status,
              ticket.service_id,
              item.product_name,
              ticket.created_at,
              ticket.updated_at,
              count(message.id)::text AS public_message_count
       FROM support_tickets ticket
       LEFT JOIN services service ON service.id = ticket.service_id
       LEFT JOIN order_items item ON item.id = service.order_item_id
       LEFT JOIN support_ticket_messages message
         ON message.ticket_id = ticket.id
        AND message.visibility = 'public'
       WHERE ticket.client_account_id = $1
       GROUP BY ticket.id, item.product_name
       ORDER BY ticket.updated_at DESC, ticket.id DESC`,
      [user.clientAccountId],
    );
    return { items: result.rows.map(customerTicket) };
  });

  app.post("/api/v1/tickets", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    assertEligible(user);
    const body = createTicketSchema.parse(request.body);
    const ticketId = await transaction(pool, async (client) => {
      if (body.serviceId) {
        const service = await client.query(
          `SELECT id FROM services
           WHERE id = $1 AND client_account_id = $2`,
          [body.serviceId, user.clientAccountId],
        );
        if (service.rowCount !== 1) throw requestError("Service not found", 404);
      }
      const created = await client.query<{ id: string }>(
        `INSERT INTO support_tickets(
           client_account_id, service_id, created_by_user_id, subject
         ) VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [user.clientAccountId, body.serviceId ?? null, user.userId, body.subject],
      );
      const id = created.rows[0]?.id;
      if (!id) throw new Error("Unable to create ticket");
      await client.query(
        `INSERT INTO support_ticket_messages(
           ticket_id, author_user_id, author_type, visibility, body
         ) VALUES ($1, $2, 'customer', 'public', $3)`,
        [id, user.userId, body.message],
      );
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, metadata
         ) VALUES ('user', $1, 'support.ticket_created', 'support_ticket', $2, $3)`,
        [user.userId, id, { clientAccountId: user.clientAccountId, serviceId: body.serviceId ?? null }],
      );
      return id;
    });
    return reply.code(201).send(
      await loadCustomerTicket(pool, ticketId, user.clientAccountId),
    );
  });

  app.get("/api/v1/tickets/:ticketId", async (request) => {
    const user = await requireUser(request, pool, config);
    assertEligible(user);
    const params = z.object({ ticketId: canonicalUuid }).parse(request.params);
    return loadCustomerTicket(pool, params.ticketId, user.clientAccountId);
  });

  app.post("/api/v1/tickets/:ticketId/replies", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    assertEligible(user);
    const params = z.object({ ticketId: canonicalUuid }).parse(request.params);
    const body = customerReplySchema.parse(request.body);
    await transaction(pool, async (client) => {
      const ticket = await client.query<{ status: TicketStatus }>(
        `SELECT status FROM support_tickets
         WHERE id = $1 AND client_account_id = $2
         FOR UPDATE`,
        [params.ticketId, user.clientAccountId],
      );
      if (!ticket.rows[0]) throw requestError("Ticket not found", 404);
      if (ticket.rows[0].status === "closed") {
        throw requestError("Closed tickets cannot be replied to", 409, "TICKET_CLOSED");
      }
      await client.query(
        `INSERT INTO support_ticket_messages(
           ticket_id, author_user_id, author_type, visibility, body
         ) VALUES ($1, $2, 'customer', 'public', $3)`,
        [params.ticketId, user.userId, body.message],
      );
      await client.query(
        `UPDATE support_tickets
         SET status = 'awaiting_staff', updated_at = now()
         WHERE id = $1`,
        [params.ticketId],
      );
    });
    return reply.code(201).send(
      await loadCustomerTicket(pool, params.ticketId, user.clientAccountId),
    );
  });

  app.get("/api/v1/admin/tickets", async (request) => {
    const user = await requireUser(request, pool, config);
    await requireStaffPermission(pool, user, "support.tickets.manage");
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
       LEFT JOIN support_ticket_messages message ON message.ticket_id = ticket.id
       GROUP BY ticket.id, account.name, item.product_name
       ORDER BY ticket.updated_at DESC, ticket.id DESC`,
    );
    return {
      items: result.rows.map((row) => ({
        ...customerTicket(row),
        clientAccount: { id: row.client_account_id, name: row.client_account_name },
        internalMessageCount: Number(row.internal_message_count),
      })),
    };
  });

  app.get("/api/v1/admin/tickets/:ticketId", async (request) => {
    const user = await requireUser(request, pool, config);
    await requireStaffPermission(pool, user, "support.tickets.manage");
    const params = z.object({ ticketId: canonicalUuid }).parse(request.params);
    return loadStaffTicket(pool, params.ticketId);
  });

  app.post("/api/v1/admin/tickets/:ticketId/messages", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    await requireStaffPermission(pool, user, "support.tickets.manage");
    const params = z.object({ ticketId: canonicalUuid }).parse(request.params);
    const body = staffMessageSchema.parse(request.body);
    await transaction(pool, async (client) => {
      const ticket = await client.query<{ status: TicketStatus }>(
        "SELECT status FROM support_tickets WHERE id = $1 FOR UPDATE",
        [params.ticketId],
      );
      if (!ticket.rows[0]) throw requestError("Ticket not found", 404);
      if (ticket.rows[0].status === "closed") {
        throw requestError("Closed tickets cannot be replied to", 409, "TICKET_CLOSED");
      }
      const visibility = body.kind === "internal_note" ? "internal" : "public";
      await client.query(
        `INSERT INTO support_ticket_messages(
           ticket_id, author_user_id, author_type, visibility, body
         ) VALUES ($1, $2, 'staff', $3, $4)`,
        [params.ticketId, user.userId, visibility, body.message],
      );
      await client.query(
        `UPDATE support_tickets
         SET status = CASE
               WHEN $2 = 'public' THEN 'awaiting_customer'
               ELSE status
             END,
             updated_at = now()
         WHERE id = $1`,
        [params.ticketId, visibility],
      );
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
          { visibility },
        ],
      );
    });
    return reply.code(201).send(await loadStaffTicket(pool, params.ticketId));
  });
}
