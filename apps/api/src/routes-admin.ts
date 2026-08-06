// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { addBillingCycle, type BillingCycle } from "@opensales/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser, type AuthenticatedUser } from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabaseClient, type DatabasePool } from "./database.js";
import { requestFingerprint } from "./idempotency.js";
import { advancePaidInvoice } from "./invoice-settlement.js";

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

const canonicalUuid = z.uuid().transform((value) => value.toLowerCase());

const fundResolutionSchema = z
  .object({
    action: z.enum(["convert_to_credit", "allocate_invoice"]),
    amountMinor: z.string().regex(/^[1-9]\d*$/),
    invoiceId: canonicalUuid.nullable().default(null),
    reason: z.string().trim().min(10).max(1_000),
    idempotencyKey: z.string().min(8).max(128),
  })
  .superRefine((value, context) => {
    if (value.action === "allocate_invoice" && !value.invoiceId) {
      context.addIssue({
        code: "custom",
        path: ["invoiceId"],
        message: "Invoice is required when allocating funds",
      });
    }
    if (value.action === "convert_to_credit" && value.invoiceId) {
      context.addIssue({
        code: "custom",
        path: ["invoiceId"],
        message: "Invoice must be omitted when converting funds to Credit",
      });
    }
  });

export async function requireStaffPermission(
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

export async function requireStaffActionLocked(
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

export async function requireRecentReauth(
  pool: DatabasePool,
  user: AuthenticatedUser,
): Promise<void> {
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
  app.get("/api/v1/admin/funds/unclaimed", async (request) => {
    const user = await requireUser(request, pool, config);
    await requireStaffPermission(pool, user, "billing.unclaimed_manage");
    const result = await pool.query<{
      id: string;
      client_account_id: string;
      client_account_name: string;
      provider_installation_id: string;
      external_payment_id: string;
      amount_minor: string;
      allocated_minor: string;
      remaining_minor: string;
      currency: string;
      occurred_at: Date;
      disposition: string;
      reason: string | null;
      suggested_invoice_id: string | null;
      created_at: Date;
    }>(
      `SELECT
         receipt.id,
         receipt.client_account_id,
         account.name AS client_account_name,
         receipt.provider_installation_id,
         receipt.external_payment_id,
         receipt.amount_minor::text,
         receipt.allocated_minor::text,
         (receipt.amount_minor - receipt.allocated_minor)::text AS remaining_minor,
         receipt.currency,
         receipt.occurred_at,
         receipt.disposition,
         receipt.reason,
         payment.invoice_id AS suggested_invoice_id,
         receipt.created_at
       FROM fund_receipts receipt
       JOIN client_accounts account ON account.id = receipt.client_account_id
       LEFT JOIN payment_attempts payment
         ON payment.id = receipt.reported_payment_attempt_id
       WHERE receipt.amount_minor > receipt.allocated_minor
       ORDER BY receipt.created_at DESC, receipt.id`,
    );
    return {
      warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      items: result.rows.map((row) => ({
        receiptId: row.id,
        clientAccountId: row.client_account_id,
        clientAccountName: row.client_account_name,
        providerInstallationId: row.provider_installation_id,
        externalPaymentId: row.external_payment_id,
        amountMinor: row.amount_minor,
        allocatedMinor: row.allocated_minor,
        remainingMinor: row.remaining_minor,
        currency: row.currency,
        occurredAt: row.occurred_at.toISOString(),
        disposition: row.disposition,
        reason: row.reason,
        suggestedInvoiceId: row.suggested_invoice_id,
        createdAt: row.created_at.toISOString(),
      })),
    };
  });

  app.post("/api/v1/admin/funds/:receiptId/resolutions", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    await requireStaffPermission(pool, user, "billing.unclaimed_manage");
    await requireRecentReauth(pool, user);
    const params = z.object({ receiptId: canonicalUuid }).parse(request.params);
    const body = fundResolutionSchema.parse(request.body);
    const fingerprint = requestFingerprint("admin.fund-receipt-resolution:v1", {
      receiptId: params.receiptId,
      action: body.action,
      amountMinor: body.amountMinor,
      invoiceId: body.invoiceId,
      reason: body.reason,
    });

    const outcome = await transaction(pool, async (client) => {
      const resolutionLocks = [
        `fund-receipt-resolution:idempotency:${body.idempotencyKey}`,
        `fund-receipt-resolution:semantic:${params.receiptId}:${fingerprint}`,
      ].sort();
      for (const lock of resolutionLocks) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lock]);
      }
      const requestReplayResult = await client.query<{
        fund_receipt_id: string;
        request_fingerprint: string;
        result: Record<string, unknown>;
      }>(
        `SELECT
           request.fund_receipt_id,
           request.request_fingerprint,
           resolution.result
         FROM fund_receipt_resolution_requests request
         JOIN fund_receipt_resolutions resolution ON resolution.id = request.resolution_id
         WHERE request.idempotency_key = $1
         FOR UPDATE OF request, resolution`,
        [body.idempotencyKey],
      );
      const requestReplay = requestReplayResult.rows[0];
      if (requestReplay) {
        if (
          requestReplay.fund_receipt_id !== params.receiptId ||
          requestReplay.request_fingerprint !== fingerprint
        ) {
          throw Object.assign(
            new Error("The idempotency key was used for a different fund resolution"),
            { statusCode: 409, code: "IDEMPOTENCY_CONFLICT" },
          );
        }
        await requireStaffActionLocked(client, user, "billing.unclaimed_manage");
        return { ...requestReplay.result, replayed: true };
      }

      const semanticReplayResult = await client.query<{
        id: string;
        result: Record<string, unknown>;
      }>(
        `SELECT id, result
         FROM fund_receipt_resolutions
         WHERE fund_receipt_id = $1
           AND request_fingerprint = $2
         FOR UPDATE`,
        [params.receiptId, fingerprint],
      );
      const semanticReplay = semanticReplayResult.rows[0];
      if (semanticReplay) {
        await requireStaffActionLocked(client, user, "billing.unclaimed_manage");
        await client.query(
          `INSERT INTO fund_receipt_resolution_requests(
             idempotency_key, fund_receipt_id, request_fingerprint, resolution_id
           ) VALUES ($1, $2, $3, $4)`,
          [body.idempotencyKey, params.receiptId, fingerprint, semanticReplay.id],
        );
        return { ...semanticReplay.result, replayed: true };
      }

      let invoice:
        | {
            id: string;
            client_account_id: string;
            currency: string;
            total_minor: string;
          }
        | undefined;
      if (body.action === "allocate_invoice") {
        const invoiceResult = await client.query<{
          id: string;
          client_account_id: string;
          currency: string;
          total_minor: string;
        }>(
          `SELECT id, client_account_id, currency, total_minor::text
           FROM invoices
           WHERE id = $1
           FOR UPDATE`,
          [body.invoiceId],
        );
        invoice = invoiceResult.rows[0];
        if (!invoice) {
          throw Object.assign(new Error("Invoice not found"), { statusCode: 404 });
        }
      }

      await requireStaffActionLocked(client, user, "billing.unclaimed_manage");

      const receiptResult = await client.query<{
        id: string;
        client_account_id: string;
        amount_minor: string;
        allocated_minor: string;
        currency: string;
      }>(
        `SELECT id, client_account_id, amount_minor::text, allocated_minor::text, currency
         FROM fund_receipts
         WHERE id = $1
         FOR UPDATE`,
        [params.receiptId],
      );
      const receipt = receiptResult.rows[0];
      if (!receipt) {
        throw Object.assign(new Error("Fund receipt not found"), { statusCode: 404 });
      }
      const amount = BigInt(body.amountMinor);
      const remaining = BigInt(receipt.amount_minor) - BigInt(receipt.allocated_minor);
      if (amount > remaining) {
        throw Object.assign(new Error("Resolution exceeds the remaining unclaimed funds"), {
          statusCode: 409,
          code: "FUNDS_ALREADY_RESOLVED",
        });
      }
      const resolutionId = randomUUID();
      const remainingAfter = remaining - amount;
      const commonResult = {
        resolutionId,
        receiptId: receipt.id,
        action: body.action,
        amountMinor: body.amountMinor,
        currency: receipt.currency,
        remainingMinor: remainingAfter.toString(),
      };

      let result: Record<string, unknown>;
      if (body.action === "convert_to_credit") {
        await client.query(
          `INSERT INTO credit_accounts(client_account_id, currency)
           VALUES ($1, $2)
           ON CONFLICT (client_account_id, currency) DO NOTHING`,
          [receipt.client_account_id, receipt.currency],
        );
        const creditAccount = await client.query<{ id: string }>(
          `SELECT id
           FROM credit_accounts
           WHERE client_account_id = $1 AND currency = $2
           FOR UPDATE`,
          [receipt.client_account_id, receipt.currency],
        );
        const creditAccountId = creditAccount.rows[0]?.id;
        if (!creditAccountId) throw new Error("Unable to establish Credit account");
        const balanceResult = await client.query<{ balance_minor: string }>(
          `SELECT COALESCE(sum(credit_minor - debit_minor), 0)::text AS balance_minor
           FROM credit_transactions
           WHERE credit_account_id = $1`,
          [creditAccountId],
        );
        const balance = BigInt(balanceResult.rows[0]?.balance_minor ?? "0");
        const policyResult = await client.query<{ balance_cap_minor: string }>(
          `SELECT balance_cap_minor::text
           FROM add_funds_policies
           WHERE currency = $1
           FOR SHARE`,
          [receipt.currency],
        );
        const cap = policyResult.rows[0]?.balance_cap_minor;
        if (!cap || balance + amount > BigInt(cap)) {
          throw Object.assign(new Error("Credit conversion would exceed the balance cap"), {
            statusCode: 409,
            code: "CREDIT_BALANCE_CAP",
          });
        }
        const creditTransactionId = randomUUID();
        result = {
          ...commonResult,
          creditTransactionId,
          creditBalanceMinor: (balance + amount).toString(),
        };
        await client.query(
          `INSERT INTO fund_receipt_resolutions(
             id, fund_receipt_id, client_account_id, action, amount_minor,
             currency, invoice_id, actor_id, reason, idempotency_key,
             request_fingerprint, result
           ) VALUES ($1, $2, $3, 'convert_to_credit', $4, $5, NULL, $6, $7, $8, $9, $10)`,
          [
            resolutionId,
            receipt.id,
            receipt.client_account_id,
            body.amountMinor,
            receipt.currency,
            user.userId,
            body.reason,
            body.idempotencyKey,
            fingerprint,
            result,
          ],
        );
        await client.query(
          `INSERT INTO credit_transactions(
             id, credit_account_id, kind, credit_minor, debit_minor,
             source_type, source_id, actor_type, actor_id, reason,
             idempotency_key, request_fingerprint, result
           ) VALUES (
             $1, $2, 'unclaimed_funds', $3, 0,
             'fund_receipt_resolution', $4, 'staff', $5, $6, $7, $8, $9
           )`,
          [
            creditTransactionId,
            creditAccountId,
            body.amountMinor,
            resolutionId,
            user.userId,
            body.reason,
            `unclaimed-funds-credit:${resolutionId}`,
            fingerprint,
            result,
          ],
        );
        const journal = await client.query<{ id: string }>(
          `INSERT INTO ledger_journals(source_type, source_id, currency, description)
           VALUES ('fund_receipt_resolution', $1, $2, 'Unclaimed funds converted to Credit')
           RETURNING id`,
          [resolutionId, receipt.currency],
        );
        const journalId = journal.rows[0]?.id;
        if (!journalId) throw new Error("Unable to create fund resolution journal");
        await client.query(
          `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
           VALUES
             ($1, 'unclaimed_funds_liability', $2, 0),
             ($1, 'client_credit_liability', 0, $2)`,
          [journalId, body.amountMinor],
        );
      } else {
        if (!invoice) {
          throw new Error("Locked invoice is required for a fund allocation");
        }
        if (
          invoice.client_account_id !== receipt.client_account_id ||
          invoice.currency !== receipt.currency
        ) {
          throw Object.assign(
            new Error("Fund receipt and invoice must belong to the same account and currency"),
            { statusCode: 409, code: "FUNDS_INVOICE_MISMATCH" },
          );
        }
        const allocatedResult = await client.query<{ allocated_minor: string }>(
          `SELECT allocated_minor::text
           FROM invoice_allocation_totals
           WHERE invoice_id = $1`,
          [invoice.id],
        );
        const allocated = BigInt(allocatedResult.rows[0]?.allocated_minor ?? "0");
        const due = BigInt(invoice.total_minor) - allocated;
        if (due <= 0n || amount > due) {
          throw Object.assign(new Error("Resolution exceeds the invoice amount due"), {
            statusCode: 409,
            code: "INVOICE_ALLOCATION_EXCEEDS_DUE",
          });
        }
        result = {
          ...commonResult,
          invoiceId: invoice.id,
          invoiceStatus: amount === due ? "paid" : "partially_paid",
          invoiceDueMinor: (due - amount).toString(),
        };
        await client.query(
          `INSERT INTO fund_receipt_resolutions(
             id, fund_receipt_id, client_account_id, action, amount_minor,
             currency, invoice_id, actor_id, reason, idempotency_key,
             request_fingerprint, result
           ) VALUES ($1, $2, $3, 'allocate_invoice', $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            resolutionId,
            receipt.id,
            receipt.client_account_id,
            body.amountMinor,
            receipt.currency,
            invoice.id,
            user.userId,
            body.reason,
            body.idempotencyKey,
            fingerprint,
            result,
          ],
        );
        await client.query(
          `INSERT INTO fund_receipt_allocations(
             resolution_id, fund_receipt_id, invoice_id, amount_minor
           ) VALUES ($1, $2, $3, $4)`,
          [resolutionId, receipt.id, invoice.id, body.amountMinor],
        );
        const journal = await client.query<{ id: string }>(
          `INSERT INTO ledger_journals(source_type, source_id, currency, description)
           VALUES ('fund_receipt_resolution', $1, $2, 'Unclaimed funds allocated to invoice')
           RETURNING id`,
          [resolutionId, receipt.currency],
        );
        const journalId = journal.rows[0]?.id;
        if (!journalId) throw new Error("Unable to create fund resolution journal");
        await client.query(
          `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
           VALUES
             ($1, 'unclaimed_funds_liability', $2, 0),
             ($1, 'accounts_receivable', 0, $2)`,
          [journalId, body.amountMinor],
        );
      }

      await client.query(
        `INSERT INTO fund_receipt_resolution_requests(
           idempotency_key, fund_receipt_id, request_fingerprint, resolution_id
         ) VALUES ($1, $2, $3, $4)`,
        [body.idempotencyKey, receipt.id, fingerprint, resolutionId],
      );
      await client.query(
        `UPDATE fund_receipts
         SET allocated_minor = allocated_minor + $2,
             disposition = CASE
               WHEN allocated_minor + $2 = amount_minor THEN 'allocated'
               ELSE 'partially_allocated'
             END,
             updated_at = now()
         WHERE id = $1`,
        [receipt.id, body.amountMinor],
      );
      if (body.action === "allocate_invoice" && body.invoiceId) {
        await advancePaidInvoice(client, body.invoiceId);
      }
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, reason, metadata
         ) VALUES ('staff', $1, 'billing.unclaimed_funds_resolved',
                   'fund_receipt', $2, $3, $4)`,
        [
          user.userId,
          receipt.id,
          body.reason,
          {
            resolutionId,
            action: body.action,
            amountMinor: body.amountMinor,
            currency: receipt.currency,
            invoiceId: body.invoiceId,
            remainingMinor: remainingAfter.toString(),
          },
        ],
      );
      return { ...result, replayed: false };
    });
    return reply.code(outcome.replayed ? 200 : 201).send(outcome);
  });

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
          result: { transactionId: string; balanceMinor: string } | null;
        }>(
          `SELECT id, request_fingerprint, result
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
          const storedResult = previous.rows[0].result;
          if (!storedResult) throw new Error("Credit adjustment replay is missing its result");
          return {
            ...storedResult,
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
        const resultingBalance =
          body.direction === "increase" ? currentBalance + amount : currentBalance - amount;
        const commandResult = {
          transactionId,
          balanceMinor: resultingBalance.toString(),
        };
        await client.query(
          `INSERT INTO credit_transactions(
             id, credit_account_id, kind, credit_minor, debit_minor,
             source_type, source_id, actor_type, actor_id, reason,
             idempotency_key, request_fingerprint, result
           ) VALUES (
             $1, $2, 'manual_adjustment', $3, $4,
             'admin_credit_adjustment', $1, 'staff', $5, $6, $7, $8, $9
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
            commandResult,
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
          ...commandResult,
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
      const lockPointers = await client.query<{
        invoice_id: string;
        order_id: string;
        order_item_id: string;
        submitted_by_user_id: string;
        client_account_id: string;
      }>(
        `SELECT i.id AS invoice_id,
                o.id AS order_id,
                oi.id AS order_item_id,
                o.submitted_by_user_id,
                o.client_account_id
         FROM services s
         JOIN order_items oi ON oi.id = s.order_item_id
         JOIN orders o ON o.id = oi.order_id
         JOIN invoices i ON i.order_id = o.id
         WHERE s.id = $1`,
        [params.serviceId],
      );
      const lockPointer = lockPointers.rows[0];
      if (lockPointer) {
        // Payment callbacks for this order also begin with Invoice. Taking the
        // same root lock before staff/target rows prevents Invoice/Order ABBA
        // when a duplicate Provider fact races manual completion.
        await client.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [
          lockPointer.invoice_id,
        ]);
      }
      await requireStaffActionLocked(client, user, "services.manual_fulfillment");
      if (!lockPointer) {
        throw Object.assign(new Error("Service not found"), { statusCode: 404 });
      }
      await client.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [
        lockPointer.order_id,
      ]);
      await client.query("SELECT id FROM order_items WHERE id = $1 FOR UPDATE", [
        lockPointer.order_item_id,
      ]);
      await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [
        params.serviceId,
      ]);
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
        lockPointer.submitted_by_user_id,
      ]);
      await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
        lockPointer.client_account_id,
      ]);
      await client.query(
        `SELECT client_account_id
         FROM client_memberships
         WHERE client_account_id = $1 AND user_id = $2
         FOR UPDATE`,
        [lockPointer.client_account_id, lockPointer.submitted_by_user_id],
      );
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
         WHERE s.id = $1`,
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
