// SPDX-License-Identifier: AGPL-3.0-or-later

import { percentageFeeMinor } from "@opensales/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertEligible, requireUser } from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabasePool } from "./database.js";
import { requestFingerprint } from "./idempotency.js";

export async function registerBillingRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get("/api/v1/billing/summary", async (request) => {
    const user = await requireUser(request, pool, config);
    const credit = await pool.query<{ balance_minor: string }>(
      `SELECT COALESCE(sum(ct.credit_minor - ct.debit_minor), 0)::text AS balance_minor
       FROM credit_accounts ca
       LEFT JOIN credit_transactions ct ON ct.credit_account_id = ca.id
       WHERE ca.client_account_id = $1 AND ca.currency = 'USD'`,
      [user.clientAccountId],
    );
    const methods = await pool.query<{
      code: string;
      display_name: Record<string, string>;
      fee_basis_points: number;
    }>(
      `SELECT code, display_name, fee_basis_points
       FROM payment_methods
       WHERE enabled
       ORDER BY code`,
    );
    return {
      warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      currency: "USD",
      creditBalanceMinor: credit.rows[0]?.balance_minor ?? "0",
      paymentMethods: methods.rows.map((method) => ({
        code: method.code,
        name: method.display_name[user.locale] ?? method.display_name.en ?? method.code,
        feeBasisPoints: method.fee_basis_points,
      })),
    };
  });

  app.post("/api/v1/invoices/:invoiceId/payment-quotes", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    assertEligible(user);
    const params = z.object({ invoiceId: z.uuid() }).parse(request.params);
    const body = z
      .object({
        paymentMethod: z.string().min(2).max(32),
        applyCredit: z.boolean().default(true),
      })
      .parse(request.body);
    const fingerprint = requestFingerprint("invoice.payment-quote:v1", {
      invoiceId: params.invoiceId,
      paymentMethod: body.paymentMethod,
      applyCredit: body.applyCredit,
    });
    const quote = await transaction(pool, async (client) => {
      const methodResult = await client.query<{
        code: string;
        fee_basis_points: number;
      }>(
        `SELECT code, fee_basis_points
         FROM payment_methods
         WHERE code = $1 AND enabled
         FOR SHARE`,
        [body.paymentMethod],
      );
      const method = methodResult.rows[0];
      if (!method) {
        throw Object.assign(new Error("Payment method is not available"), { statusCode: 404 });
      }
      const invoiceResult = await client.query<{
        total_minor: string;
        currency: string;
      }>(
        `SELECT total_minor::text, currency
         FROM invoices
         WHERE id = $1 AND client_account_id = $2
         FOR SHARE`,
        [params.invoiceId, user.clientAccountId],
      );
      const invoice = invoiceResult.rows[0];
      if (!invoice) {
        throw Object.assign(new Error("Invoice not found"), { statusCode: 404 });
      }
      const allocationResult = await client.query<{
        payment_minor: string;
        credit_minor: string;
        allocated_minor: string;
      }>(
        `SELECT payment_minor::text, credit_minor::text, allocated_minor::text
         FROM invoice_allocation_totals
         WHERE invoice_id = $1`,
        [params.invoiceId],
      );
      const allocations = allocationResult.rows[0];
      if (!allocations) throw new Error("Invoice allocation summary is unavailable");
      const outstanding = BigInt(invoice.total_minor) - BigInt(allocations.allocated_minor);
      if (outstanding <= 0n) {
        throw Object.assign(new Error("Invoice is already paid"), { statusCode: 409 });
      }
      const creditResult = await client.query<{ balance_minor: string }>(
        `SELECT COALESCE(sum(ct.credit_minor - ct.debit_minor), 0)::text AS balance_minor
         FROM credit_accounts ca
         LEFT JOIN credit_transactions ct ON ct.credit_account_id = ca.id
         WHERE ca.client_account_id = $1 AND ca.currency = $2`,
        [user.clientAccountId, invoice.currency],
      );
      const availableCredit = BigInt(creditResult.rows[0]?.balance_minor ?? "0");
      const proposedCredit = body.applyCredit
        ? availableCredit < outstanding
          ? availableCredit
          : outstanding
        : 0n;
      const externalNonFeeMinor = outstanding - proposedCredit;
      const feeMinor = percentageFeeMinor(externalNonFeeMinor, method.fee_basis_points);
      const inserted = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO invoice_payment_quotes(
           client_account_id, invoice_id, payment_method_code, currency,
           invoice_total_minor, payment_allocated_minor, credit_allocated_minor,
           available_credit_minor, credit_to_apply_minor, external_non_fee_minor,
           fee_basis_points, fee_minor, external_due_minor, request_fingerprint,
           expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
           now() + interval '10 minutes'
         )
         RETURNING id, expires_at`,
        [
          user.clientAccountId,
          params.invoiceId,
          method.code,
          invoice.currency,
          invoice.total_minor,
          allocations.payment_minor,
          allocations.credit_minor,
          availableCredit.toString(),
          proposedCredit.toString(),
          externalNonFeeMinor.toString(),
          method.fee_basis_points,
          feeMinor.toString(),
          (externalNonFeeMinor + feeMinor).toString(),
          fingerprint,
        ],
      );
      const created = inserted.rows[0];
      if (!created) throw new Error("Unable to create payment quote");
      return {
        quoteId: created.id,
        invoiceId: params.invoiceId,
        method: method.code,
        currency: invoice.currency,
        availableCreditMinor: availableCredit.toString(),
        existingCreditAppliedMinor: allocations.credit_minor,
        creditToApplyMinor: proposedCredit.toString(),
        externalNonFeeMinor: externalNonFeeMinor.toString(),
        feeMinor: feeMinor.toString(),
        externalDueMinor: (externalNonFeeMinor + feeMinor).toString(),
        resultingInvoiceTotalMinor: (BigInt(invoice.total_minor) + feeMinor).toString(),
        expiresAt: created.expires_at.toISOString(),
      };
    });
    return reply.code(201).send(quote);
  });
}
