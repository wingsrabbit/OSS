// SPDX-License-Identifier: AGPL-3.0-or-later

import { addBillingCycle, type BillingCycle } from "@opensales/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser, type AuthenticatedUser } from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabaseClient, type DatabasePool } from "./database.js";

const manualCompletionSchema = z.object({
  reason: z.string().trim().min(10).max(1_000),
});

async function requireStaffPermission(
  pool: DatabasePool,
  user: AuthenticatedUser,
  permission: string,
): Promise<void> {
  if (user.userRestrictedAt || user.clientAccountRestrictedAt || !user.emailVerifiedAt) {
    throw Object.assign(new Error("Staff account is not eligible"), { statusCode: 403 });
  }
  const result = await pool.query<{ permissions: unknown }>(
    `SELECT permissions
     FROM staff_members
     WHERE user_id = $1 AND active`,
    [user.userId],
  );
  const permissions = result.rows[0]?.permissions;
  if (
    !Array.isArray(permissions) ||
    (!permissions.includes("*") && !permissions.includes(permission))
  ) {
    throw Object.assign(new Error("Staff permission is required"), { statusCode: 403 });
  }
}

async function requireStaffActionLocked(
  client: DatabaseClient,
  user: AuthenticatedUser,
  permission: string,
): Promise<void> {
  const result = await client.query<{ permissions: unknown }>(
    `SELECT sm.permissions
     FROM staff_members sm
     JOIN users u ON u.id = sm.user_id
     JOIN sessions s ON s.user_id = u.id AND s.id = $2
     JOIN client_memberships cm
       ON cm.user_id = u.id
      AND cm.client_account_id = $3
      AND cm.removed_at IS NULL
     JOIN client_accounts ca ON ca.id = cm.client_account_id
     JOIN reauth_grants rg
       ON rg.user_id = u.id
      AND rg.session_id = s.id
      AND rg.invalidated_at IS NULL
      AND rg.expires_at > now()
     WHERE sm.user_id = $1
       AND sm.active
       AND u.email_verified_at IS NOT NULL
       AND u.restricted_at IS NULL
       AND ca.restricted_at IS NULL
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
     ORDER BY rg.created_at DESC
     LIMIT 1
     FOR UPDATE OF sm, u, s, cm, ca, rg`,
    [user.userId, user.sessionId, user.clientAccountId],
  );
  const permissions = result.rows[0]?.permissions;
  if (
    !Array.isArray(permissions) ||
    (!permissions.includes("*") && !permissions.includes(permission))
  ) {
    throw Object.assign(new Error("Current permission and password confirmation are required"), {
      statusCode: 403,
      code: "STAFF_AUTHORIZATION_REQUIRED",
    });
  }
}

async function requireRecentReauth(pool: DatabasePool, user: AuthenticatedUser): Promise<void> {
  const result = await pool.query(
    `SELECT rg.id
     FROM reauth_grants rg
     JOIN sessions s ON s.id = rg.session_id
     WHERE rg.user_id = $1
       AND rg.session_id = $2
       AND rg.invalidated_at IS NULL
       AND rg.expires_at > now()
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
     LIMIT 1`,
    [user.userId, user.sessionId],
  );
  if (result.rowCount !== 1) {
    throw Object.assign(new Error("Password confirmation is required for this action"), {
      statusCode: 403,
      code: "REAUTH_REQUIRED",
    });
  }
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get("/api/v1/admin/manual-fulfillment", async (request) => {
    const user = await requireUser(request, pool, config);
    await requireStaffPermission(pool, user, "services.manual_fulfillment");
    const result = await pool.query<{
      service_id: string;
      order_id: string;
      product_name: string;
      billing_cycle: string;
      client_account_name: string;
      paid_minor: string;
      total_minor: string;
      submitted_at: Date;
    }>(
      `SELECT
         s.id AS service_id,
         o.id AS order_id,
         oi.product_name,
         oi.billing_cycle,
         ca.name AS client_account_name,
         COALESCE(alloc.paid_minor, 0)::text AS paid_minor,
         i.total_minor,
         o.submitted_at
       FROM orders o
       JOIN client_accounts ca ON ca.id = o.client_account_id
       JOIN order_items oi ON oi.order_id = o.id
       JOIN services s ON s.order_item_id = oi.id
       JOIN invoices i ON i.order_id = o.id
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(pa.amount_minor), 0) AS paid_minor
         FROM payment_allocations pa
         WHERE pa.invoice_id = i.id
       ) alloc ON true
       WHERE o.status = 'awaiting_manual'
       ORDER BY o.submitted_at`,
    );
    return {
      warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      items: result.rows.map((row) => ({
        serviceId: row.service_id,
        orderId: row.order_id,
        productName: row.product_name,
        billingCycle: row.billing_cycle,
        clientAccountName: row.client_account_name,
        paidMinor: row.paid_minor,
        totalMinor: row.total_minor,
        submittedAt: row.submitted_at.toISOString(),
      })),
    };
  });

  app.post("/api/v1/admin/services/:serviceId/complete-manual", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    await requireStaffPermission(pool, user, "services.manual_fulfillment");
    await requireRecentReauth(pool, user);
    const params = z.object({ serviceId: z.uuid() }).parse(request.params);
    const body = manualCompletionSchema.parse(request.body);

    const result = await transaction(pool, async (client) => {
      await requireStaffActionLocked(client, user, "services.manual_fulfillment");
      const serviceResult = await client.query<{
        service_id: string;
        service_status: string;
        billing_cycle: BillingCycle;
        order_id: string;
        order_status: string;
        fulfillment_mode: string;
        invoice_id: string;
        invoice_total_minor: string;
        submitted_by_user_id: string;
        email_verified_at: Date | null;
        user_restricted_at: Date | null;
        account_restricted_at: Date | null;
        removed_at: Date | null;
      }>(
        `SELECT
           s.id AS service_id,
           s.status AS service_status,
           s.billing_cycle,
           o.id AS order_id,
           o.status AS order_status,
           oi.fulfillment_mode,
           i.id AS invoice_id,
           i.total_minor AS invoice_total_minor,
           o.submitted_by_user_id,
           customer.email_verified_at,
           customer.restricted_at AS user_restricted_at,
           ca.restricted_at AS account_restricted_at,
           cm.removed_at
         FROM services s
         JOIN order_items oi ON oi.id = s.order_item_id
         JOIN orders o ON o.id = oi.order_id
         JOIN invoices i ON i.order_id = o.id
         JOIN users customer ON customer.id = o.submitted_by_user_id
         JOIN client_accounts ca ON ca.id = o.client_account_id
         JOIN client_memberships cm
           ON cm.client_account_id = o.client_account_id
          AND cm.user_id = o.submitted_by_user_id
         WHERE s.id = $1
         FOR UPDATE OF s, o, i, customer, ca, cm`,
        [params.serviceId],
      );
      const service = serviceResult.rows[0];
      if (!service) throw Object.assign(new Error("Service not found"), { statusCode: 404 });
      if (!["manual", "review"].includes(service.fulfillment_mode)) {
        throw Object.assign(new Error("This service is not eligible for manual fulfillment"), {
          statusCode: 409,
        });
      }
      if (service.order_status !== "awaiting_manual" || service.service_status !== "pending") {
        throw Object.assign(new Error("Service is not waiting for manual fulfillment"), {
          statusCode: 409,
        });
      }
      const allocationResult = await client.query<{ allocated_minor: string }>(
        `SELECT COALESCE(sum(amount_minor), 0)::text AS allocated_minor
         FROM payment_allocations
         WHERE invoice_id = $1`,
        [service.invoice_id],
      );
      if (
        BigInt(allocationResult.rows[0]?.allocated_minor ?? "0") <
        BigInt(service.invoice_total_minor)
      ) {
        throw Object.assign(new Error("Invoice is not fully paid"), { statusCode: 409 });
      }
      const eligible =
        Boolean(service.email_verified_at) &&
        !service.user_restricted_at &&
        !service.account_restricted_at &&
        !service.removed_at;
      if (!eligible) {
        await client.query("UPDATE orders SET status = 'on_hold', updated_at = now() WHERE id = $1", [
          service.order_id,
        ]);
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, reason
           ) VALUES ('staff', $1, 'service.manual_fulfillment_blocked', 'service', $2, $3)`,
          [user.userId, service.service_id, "customer eligibility changed; order moved to Hold"],
        );
        return {
          serviceId: service.service_id,
          status: "on_hold" as const,
          activatedAt: null,
        };
      }
      const readyAt = new Date();
      const termEnd = addBillingCycle(readyAt, service.billing_cycle);
      const activated = await client.query(
        `UPDATE services
         SET status = 'active', activated_at = $2, term_start = $2, term_end = $3,
             updated_at = now(), version = version + 1
         WHERE id = $1
           AND activated_at IS NULL
           AND status = 'pending'
         RETURNING id`,
        [service.service_id, readyAt, termEnd],
      );
      if (activated.rowCount !== 1) {
        throw Object.assign(new Error("Service state changed; review it again"), {
          statusCode: 409,
          code: "STATE_CONFLICT",
        });
      }
      const completed = await client.query(
        `UPDATE orders
         SET status = 'completed', updated_at = now(), version = version + 1
         WHERE id = $1 AND status = 'awaiting_manual'
         RETURNING id`,
        [service.order_id],
      );
      if (completed.rowCount !== 1) {
        throw Object.assign(new Error("Order state changed; review it again"), {
          statusCode: 409,
          code: "STATE_CONFLICT",
        });
      }
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, reason, metadata
         ) VALUES ('staff', $1, 'service.manual_fulfillment_completed', 'service', $2, $3, $4)`,
        [
          user.userId,
          service.service_id,
          body.reason,
          { orderId: service.order_id, readyAt: readyAt.toISOString() },
        ],
      );
      await client.query(
        `INSERT INTO outbox(event_type, unique_key, payload)
         VALUES ('service.activated', $1, $2)
         ON CONFLICT (event_type, unique_key) DO NOTHING`,
        [
          `service:${service.service_id}`,
          {
            serviceId: service.service_id,
            orderId: service.order_id,
            activatedAt: readyAt.toISOString(),
            termEnd: termEnd?.toISOString() ?? null,
            fulfillment: "manual",
          },
        ],
      );
      return { serviceId: service.service_id, status: "active", activatedAt: readyAt.toISOString() };
    });
    if (result.status === "on_hold") {
      return reply
        .code(409)
        .send({ ...result, error: "Customer eligibility changed; order moved to Hold" });
    }
    return reply.code(200).send(result);
  });
}
