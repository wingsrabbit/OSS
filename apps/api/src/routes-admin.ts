// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { addBillingCycle, type BillingCycle } from "@opensales/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser, type AuthenticatedUser } from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabaseClient, type DatabasePool } from "./database.js";
import { requestFingerprint } from "./idempotency.js";

const manualCompletionSchema = z.object({
  reason: z.string().trim().min(10).max(1_000),
});

const creditAdjustmentSchema = z.object({
  direction: z.enum(["increase", "decrease"]),
  amountMinor: z.string().regex(/^[1-9]\d*$/),
  currency: z.literal("USD"),
  reason: z.string().trim().min(10).max(1_000),
  idempotencyKey: z.string().min(8).max(128),
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
  app.post(
    "/api/v1/admin/client-accounts/:clientAccountId/credit-adjustments",
    async (request, reply) => {
      const user = await requireUser(request, pool, config);
      await requireStaffPermission(pool, user, "billing.credit_adjust");
      await requireRecentReauth(pool, user);
      const params = z.object({ clientAccountId: z.uuid() }).parse(request.params);
      const body = creditAdjustmentSchema.parse(request.body);
      const fingerprint = requestFingerprint("admin.credit-adjustment:v1", {
        clientAccountId: params.clientAccountId,
        direction: body.direction,
        amountMinor: body.amountMinor,
        currency: body.currency,
        reason: body.reason,
      });

      const outcome = await transaction(pool, async (client) => {
        await requireStaffActionLocked(client, user, "billing.credit_adjust");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `credit-adjustment:${params.clientAccountId}:${body.currency}:${body.idempotencyKey}`,
        ]);
        const target = await client.query<{ id: string }>(
          "SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE",
          [params.clientAccountId],
        );
        if (!target.rows[0]) {
          throw Object.assign(new Error("Client account not found"), { statusCode: 404 });
        }
        const accountResult = await client.query<{ id: string }>(
          `INSERT INTO credit_accounts(client_account_id, currency)
           VALUES ($1, $2)
           ON CONFLICT (client_account_id, currency) DO NOTHING
           RETURNING id`,
          [params.clientAccountId, body.currency],
        );
        const existingAccount = accountResult.rows[0]
          ? accountResult
          : await client.query<{ id: string }>(
              `SELECT id
               FROM credit_accounts
               WHERE client_account_id = $1 AND currency = $2
               FOR UPDATE`,
              [params.clientAccountId, body.currency],
            );
        const creditAccountId = existingAccount.rows[0]?.id;
        if (!creditAccountId) throw new Error("Unable to establish Credit account");
        await client.query("SELECT id FROM credit_accounts WHERE id = $1 FOR UPDATE", [
          creditAccountId,
        ]);

        const previous = await client.query<{
          id: string;
          request_fingerprint: string;
        }>(
          `SELECT id, request_fingerprint
           FROM credit_transactions
           WHERE credit_account_id = $1 AND idempotency_key = $2
           FOR UPDATE`,
          [creditAccountId, body.idempotencyKey],
        );
        if (previous.rows[0]) {
          if (previous.rows[0].request_fingerprint !== fingerprint) {
            throw Object.assign(
              new Error("The idempotency key was used for a different Credit adjustment"),
              { statusCode: 409, code: "IDEMPOTENCY_CONFLICT" },
            );
          }
          const balance = await client.query<{ balance_minor: string }>(
            `SELECT COALESCE(sum(credit_minor - debit_minor), 0)::text AS balance_minor
             FROM credit_transactions
             WHERE credit_account_id = $1`,
            [creditAccountId],
          );
          return {
            transactionId: previous.rows[0].id,
            balanceMinor: balance.rows[0]?.balance_minor ?? "0",
            replayed: true,
          };
        }

        const amount = BigInt(body.amountMinor);
        const current = await client.query<{ balance_minor: string }>(
          `SELECT COALESCE(sum(credit_minor - debit_minor), 0)::text AS balance_minor
           FROM credit_transactions
           WHERE credit_account_id = $1`,
          [creditAccountId],
        );
        const currentBalance = BigInt(current.rows[0]?.balance_minor ?? "0");
        if (body.direction === "decrease" && amount > currentBalance) {
          throw Object.assign(new Error("Credit adjustment would make the balance negative"), {
            statusCode: 409,
            code: "INSUFFICIENT_CREDIT",
          });
        }
        const transactionId = randomUUID();
        await client.query(
          `INSERT INTO credit_transactions(
             id, credit_account_id, kind, credit_minor, debit_minor,
             source_type, source_id, actor_type, actor_id, reason,
             idempotency_key, request_fingerprint
           ) VALUES (
             $1, $2, 'manual_adjustment', $3, $4,
             'admin_credit_adjustment', $1, 'staff', $5, $6, $7, $8
           )`,
          [
            transactionId,
            creditAccountId,
            body.direction === "increase" ? body.amountMinor : "0",
            body.direction === "decrease" ? body.amountMinor : "0",
            user.userId,
            body.reason,
            body.idempotencyKey,
            fingerprint,
          ],
        );
        const journal = await client.query<{ id: string }>(
          `INSERT INTO ledger_journals(source_type, source_id, currency, description)
           VALUES ('credit_manual_adjustment', $1, $2, 'Audited manual Credit adjustment')
           RETURNING id`,
          [transactionId, body.currency],
        );
        const journalId = journal.rows[0]?.id;
        if (!journalId) throw new Error("Unable to create Credit journal");
        if (body.direction === "increase") {
          await client.query(
            `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
             VALUES
               ($1, 'credit_adjustment_expense', $2, 0),
               ($1, 'client_credit_liability', 0, $2)`,
            [journalId, body.amountMinor],
          );
        } else {
          await client.query(
            `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
             VALUES
               ($1, 'client_credit_liability', $2, 0),
               ($1, 'credit_adjustment_recovery', 0, $2)`,
            [journalId, body.amountMinor],
          );
        }
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, reason, metadata
           ) VALUES ('staff', $1, 'billing.credit_adjusted', 'client_account', $2, $3, $4)`,
          [
            user.userId,
            params.clientAccountId,
            body.reason,
            {
              transactionId,
              direction: body.direction,
              amountMinor: body.amountMinor,
              currency: body.currency,
            },
          ],
        );
        return {
          transactionId,
          balanceMinor:
            body.direction === "increase"
              ? (currentBalance + amount).toString()
              : (currentBalance - amount).toString(),
          replayed: false,
        };
      });
      return reply.code(outcome.replayed ? 200 : 201).send(outcome);
    },
  );

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
         COALESCE(alloc.allocated_minor, 0)::text AS paid_minor,
         i.total_minor,
         o.submitted_at
       FROM orders o
       JOIN client_accounts ca ON ca.id = o.client_account_id
       JOIN order_items oi ON oi.order_id = o.id
       JOIN services s ON s.order_item_id = oi.id
       JOIN invoices i ON i.order_id = o.id
       LEFT JOIN invoice_allocation_totals alloc ON alloc.invoice_id = i.id
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
        `SELECT allocated_minor::text
         FROM invoice_allocation_totals
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
