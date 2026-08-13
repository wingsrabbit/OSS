// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  lockCustomerApiKey,
  recordCustomerApiKeyUsage,
} from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabasePool } from "./database.js";

const canonicalUuid = z.uuid().transform((value) => value.toLowerCase());
const replyParamsSchema = z.object({ ticketId: canonicalUuid }).strict();
const replySchema = z.object({ message: z.string().trim().min(1).max(10_000) }).strict();

export async function registerCustomerApiRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get("/api/v1/customer-api/account", async (request) =>
    transaction(pool, async (client) => {
      const principal = await lockCustomerApiKey(request, client, config, "account.read");
      const account = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM public.client_accounts WHERE id = $1`,
        [principal.clientAccountId],
      );
      await recordCustomerApiKeyUsage(client, principal, "GET", "account.read");
      return {
        account: account.rows[0] ?? null,
        access: { role: principal.membershipRole, scopes: principal.scopes },
      };
    }));

  app.get("/api/v1/customer-api/orders", async (request) =>
    transaction(pool, async (client) => {
      const principal = await lockCustomerApiKey(request, client, config, "orders.read");
      const orders = await client.query<{
        id: string;
        status: string;
        currency: string;
        one_time_minor: string;
        setup_minor: string;
        recurring_minor: string;
        total_minor: string;
        submitted_at: Date;
        updated_at: Date;
      }>(
        `SELECT id, status, currency, one_time_minor::text, setup_minor::text,
                recurring_minor::text, total_minor::text, submitted_at, updated_at
         FROM public.orders
         WHERE client_account_id = $1
         ORDER BY submitted_at DESC, id DESC
         LIMIT 100`,
        [principal.clientAccountId],
      );
      await recordCustomerApiKeyUsage(client, principal, "GET", "orders.read");
      return {
        items: orders.rows.map((row) => ({
          id: row.id,
          status: row.status,
          currency: row.currency,
          oneTimeMinor: row.one_time_minor,
          setupMinor: row.setup_minor,
          recurringMinor: row.recurring_minor,
          totalMinor: row.total_minor,
          submittedAt: row.submitted_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        })),
      };
    }));

  app.get("/api/v1/customer-api/billing/invoices", async (request) =>
    transaction(pool, async (client) => {
      const principal = await lockCustomerApiKey(request, client, config, "billing.read");
      const invoices = await client.query<{
        id: string;
        order_id: string | null;
        currency: string;
        total_minor: string;
        due_at: Date;
        created_at: Date;
      }>(
        `SELECT id, order_id, currency, total_minor::text, due_at, created_at
         FROM public.invoices
         WHERE client_account_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 100`,
        [principal.clientAccountId],
      );
      await recordCustomerApiKeyUsage(client, principal, "GET", "billing.read");
      return {
        items: invoices.rows.map((row) => ({
          id: row.id,
          orderId: row.order_id,
          currency: row.currency,
          totalMinor: row.total_minor,
          dueAt: row.due_at.toISOString(),
          createdAt: row.created_at.toISOString(),
        })),
      };
    }));

  app.get("/api/v1/customer-api/services", async (request) =>
    transaction(pool, async (client) => {
      const principal = await lockCustomerApiKey(request, client, config, "services.read");
      const services = await client.query<{
        id: string;
        status: string;
        billing_cycle: string;
        activated_at: Date | null;
        term_start: Date | null;
        term_end: Date | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id, status, billing_cycle, activated_at, term_start, term_end,
                created_at, updated_at
         FROM public.services
         WHERE client_account_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 100`,
        [principal.clientAccountId],
      );
      await recordCustomerApiKeyUsage(client, principal, "GET", "services.read");
      return {
        items: services.rows.map((row) => ({
          id: row.id,
          status: row.status,
          billingCycle: row.billing_cycle,
          activatedAt: row.activated_at?.toISOString() ?? null,
          termStart: row.term_start?.toISOString() ?? null,
          termEnd: row.term_end?.toISOString() ?? null,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        })),
      };
    }));

  app.get("/api/v1/customer-api/support/tickets", async (request) =>
    transaction(pool, async (client) => {
      const principal = await lockCustomerApiKey(request, client, config, "support.read");
      const tickets = await client.query<{
        id: string;
        subject: string;
        status: string;
        service_id: string | null;
        order_id: string | null;
        priority: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id, subject, status, service_id, order_id, priority,
                created_at, updated_at
         FROM public.support_tickets
         WHERE client_account_id = $1
         ORDER BY updated_at DESC, id DESC
         LIMIT 100`,
        [principal.clientAccountId],
      );
      await recordCustomerApiKeyUsage(client, principal, "GET", "support.read");
      return {
        items: tickets.rows.map((row) => ({
          id: row.id,
          subject: row.subject,
          status: row.status,
          serviceId: row.service_id,
          orderId: row.order_id,
          priority: row.priority,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        })),
      };
    }));

  app.post("/api/v1/customer-api/support/tickets/:ticketId/replies", async (request, reply) => {
    const params = replyParamsSchema.parse(request.params);
    const body = replySchema.parse(request.body);
    const messageId = randomUUID();
    await transaction(pool, async (client) => {
      const principal = await lockCustomerApiKey(request, client, config, "support.write");
      const ticket = await client.query<{
        status: "awaiting_staff" | "awaiting_customer" | "closed";
      }>(
        `SELECT status FROM public.support_tickets
         WHERE id = $1 AND client_account_id = $2
         FOR UPDATE`,
        [params.ticketId, principal.clientAccountId],
      );
      const current = ticket.rows[0];
      if (!current) {
        throw Object.assign(new Error("Ticket not found"), { statusCode: 404 });
      }
      if (current.status === "closed") {
        throw Object.assign(new Error("Closed tickets cannot be replied to"), {
          statusCode: 409,
          code: "TICKET_CLOSED",
        });
      }
      await client.query(
        `INSERT INTO public.support_ticket_messages(
           id, ticket_id, author_user_id, author_type, visibility, body
         ) VALUES ($1, $2, $3, 'customer', 'public', $4)`,
        [messageId, params.ticketId, principal.userId, body.message],
      );
      if (current.status === "awaiting_customer") {
        const statusEventId = randomUUID();
        await client.query(
          `INSERT INTO public.support_ticket_status_events(
             id, ticket_id, previous_status, status,
             actor_type, actor_user_id, reason
           ) VALUES ($1, $2, 'awaiting_customer', 'awaiting_staff',
                     'customer', $3, 'Customer API reply')`,
          [statusEventId, params.ticketId, principal.userId],
        );
        await client.query(
          `UPDATE public.support_tickets
           SET status = 'awaiting_staff', current_status_event_id = $2,
               updated_at = GREATEST(updated_at + interval '1 microsecond',
                                     pg_catalog.clock_timestamp())
           WHERE id = $1`,
          [params.ticketId, statusEventId],
        );
      } else {
        await client.query(
          `UPDATE public.support_tickets
           SET updated_at = GREATEST(updated_at + interval '1 microsecond',
                                     pg_catalog.clock_timestamp())
           WHERE id = $1`,
          [params.ticketId],
        );
      }
      await client.query(
        `INSERT INTO public.audit_events(
           actor_type, actor_id, action, target_type, target_id, metadata
         ) VALUES ('api_key', $1, 'support.customer_api_reply_added',
                   'support_ticket', $2,
                   pg_catalog.jsonb_build_object('messageId', $3::uuid))`,
        [principal.apiKeyId, params.ticketId, messageId],
      );
      await recordCustomerApiKeyUsage(client, principal, "POST", "support.write");
    });
    return reply.code(201).send({ id: messageId, ticketId: params.ticketId });
  });
}
