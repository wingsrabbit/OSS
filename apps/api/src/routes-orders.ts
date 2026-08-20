// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assertBillingWriteEligible,
  assertCustomerCapability,
  assertEligible,
  assertFinancialReadEligible,
  expectedAccountContextVersion,
  lockAccountContextForMutation,
  requireUser,
  setAccountContextHeaders,
} from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabaseClient, type DatabasePool } from "./database.js";
import { requestFingerprint } from "./idempotency.js";
import {
  buildOfferSnapshot,
  issueCommercialOrder,
  loadLegalDocuments,
  lockCatalogOffer,
  lockPromotion,
  recordMarketingConsent,
  replayCommercialOrder,
  supplyPreflight,
} from "./commerce-service.js";
import { advancePaidInvoice } from "./invoice-settlement.js";
import { assertInvoicePaymentBusinessStateLocked } from "./invoice-payment-eligibility.js";
import {
  AUTOMATIC_RENEWAL_CONSENT_VERSION,
  PAYMENT_METHOD_SAVE_CONSENT_VERSION,
} from "./routes-payment-methods.js";
import { requireRecentReauth, requireRecentReauthLocked } from "./routes-admin.js";
import { MARKETING_CONSENT_POLICY_VERSION } from "./routes-commerce.js";

const checkoutSchema = z
  .object({
    priceId: z.uuid(),
    configuration: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .default({}),
    promotionCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9_-]{2,63}$/)
      .nullable()
      .default(null),
    termsVersion: z.string().min(1).max(64),
    aupVersion: z.string().min(1).max(64),
    termsDocumentId: z.uuid().optional(),
    aupDocumentId: z.uuid().optional(),
    legalLocale: z.enum(["en", "zh-CN"]).optional(),
    termsLocale: z.enum(["en", "zh-CN"]).optional(),
    aupLocale: z.enum(["en", "zh-CN"]).optional(),
    marketingConsent: z.boolean().default(false),
    marketingConsentPolicyVersion: z.string().min(1).max(80).optional(),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict()
  .superRefine((body, context) => {
    const exactLegalSelection = [
      body.termsDocumentId,
      body.aupDocumentId,
      body.legalLocale,
      body.termsLocale,
      body.aupLocale,
    ];
    if (
      exactLegalSelection.some((value) => value !== undefined) &&
      exactLegalSelection.some((value) => value === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["termsDocumentId"],
        message: "Exact legal document IDs, requested locale, and resolved locales must be supplied together",
      });
    }
    if (body.marketingConsent !== (body.marketingConsentPolicyVersion !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["marketingConsentPolicyVersion"],
        message: "Marketing Consent is optional, defaults off, and requires an explicit policy version",
      });
    }
    if (
      body.marketingConsentPolicyVersion &&
      body.marketingConsentPolicyVersion !== MARKETING_CONSENT_POLICY_VERSION
    ) {
      context.addIssue({
        code: "custom",
        path: ["marketingConsentPolicyVersion"],
        message: "Marketing Consent policy version is not current",
      });
    }
  });

const paymentSchema = z
  .object({
    quoteId: z.uuid(),
    scenario: z
      .enum([
        "success",
        "failed",
        "cancelled",
        "timeout_success",
        "duplicate_out_of_order",
        "definitive_reject",
        "success_then_reject",
        "partial_then_reject",
        "partial_then_timeout",
      ])
      .default("success"),
    savePaymentMethod: z.boolean().default(false),
    saveConsentVersion: z.string().min(1).max(80).optional(),
    enableAutomaticRenewal: z.boolean().default(false),
    automaticRenewalConsentVersion: z.string().min(1).max(80).optional(),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict()
  .superRefine((body, context) => {
    if (body.savePaymentMethod !== (body.saveConsentVersion !== undefined)) {
      context.addIssue({ code: "custom", path: ["saveConsentVersion"], message: "saving a payment method requires explicit versioned consent" });
    }
    if (body.saveConsentVersion && body.saveConsentVersion !== PAYMENT_METHOD_SAVE_CONSENT_VERSION) {
      context.addIssue({ code: "custom", path: ["saveConsentVersion"], message: "payment-method consent version is not current" });
    }
    if (body.enableAutomaticRenewal !== (body.automaticRenewalConsentVersion !== undefined)) {
      context.addIssue({ code: "custom", path: ["automaticRenewalConsentVersion"], message: "automatic renewal requires separate explicit versioned consent" });
    }
    if (body.enableAutomaticRenewal && !body.savePaymentMethod) {
      context.addIssue({ code: "custom", path: ["enableAutomaticRenewal"], message: "automatic renewal requires saving this payment method first" });
    }
    if (
      body.automaticRenewalConsentVersion &&
      body.automaticRenewalConsentVersion !== AUTOMATIC_RENEWAL_CONSENT_VERSION
    ) {
      context.addIssue({ code: "custom", path: ["automaticRenewalConsentVersion"], message: "automatic-renewal consent version is not current" });
    }
  });

async function assertEligibilityLocked(
  client: DatabaseClient,
  userId: string,
  clientAccountId: string,
): Promise<void> {
  // Keep the shared identity lock order explicit. PostgreSQL does not promise
  // the row-lock order of a multi-relation FOR UPDATE join, and payment
  // settlement takes these same shared rows for other invoices.
  await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
  await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
    clientAccountId,
  ]);
  await client.query(
    `SELECT client_account_id
     FROM client_memberships
     WHERE user_id = $1 AND client_account_id = $2
     FOR UPDATE`,
    [userId, clientAccountId],
  );
  const result = await client.query<{
    email_verified_at: Date | null;
    user_restricted_at: Date | null;
    account_restricted_at: Date | null;
    removed_at: Date | null;
  }>(
    `SELECT
       u.email_verified_at,
       u.restricted_at AS user_restricted_at,
       ca.restricted_at AS account_restricted_at,
       cm.removed_at
     FROM users u
     JOIN client_memberships cm ON cm.user_id = u.id AND cm.client_account_id = $2
     JOIN client_accounts ca ON ca.id = cm.client_account_id
     WHERE u.id = $1`,
    [userId, clientAccountId],
  );
  const state = result.rows[0];
  if (
    !state?.email_verified_at ||
    state.user_restricted_at ||
    state.account_restricted_at ||
    state.removed_at
  ) {
    throw Object.assign(new Error("Account is not eligible for this operation"), {
      statusCode: 403,
      code: "ACCOUNT_NOT_ELIGIBLE",
    });
  }
}

export async function registerOrderRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.post("/api/v1/orders", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    const expectedContextVersion = expectedAccountContextVersion(request);
    assertEligible(user);
    assertCustomerCapability(user, "orders.create");
    const body = checkoutSchema.parse(request.body);
    const baseFingerprintInput = {
      priceId: body.priceId,
      configuration: body.configuration,
      termsVersion: body.termsVersion,
      aupVersion: body.aupVersion,
    };
    const fingerprint =
      body.termsDocumentId !== undefined && body.aupDocumentId !== undefined
        ? requestFingerprint("orders.create:v3", {
            ...baseFingerprintInput,
            termsDocumentId: body.termsDocumentId,
            aupDocumentId: body.aupDocumentId,
            legalLocale: body.legalLocale,
            termsLocale: body.termsLocale,
            aupLocale: body.aupLocale,
            promotionCode: body.promotionCode,
            marketingConsent: body.marketingConsent,
            marketingConsentPolicyVersion:
              body.marketingConsentPolicyVersion ?? null,
          })
        : body.promotionCode === null && !body.marketingConsent
          ? requestFingerprint("orders.create:v1", baseFingerprintInput)
          : requestFingerprint("orders.create:v2", {
              ...baseFingerprintInput,
              promotionCode: body.promotionCode,
              marketingConsent: body.marketingConsent,
              marketingConsentPolicyVersion:
                body.marketingConsentPolicyVersion ?? null,
            });

    const created = await transaction(pool, async (client) => {
      const context = await lockAccountContextForMutation(
        client,
        user,
        expectedContextVersion,
      );
      assertCustomerCapability(context, "orders.create");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `order:${user.clientAccountId}:${body.idempotencyKey}`,
      ]);
      const previous = await replayCommercialOrder(client, {
        clientAccountId: user.clientAccountId,
        idempotencyKey: body.idempotencyKey,
        requestFingerprint: fingerprint,
        sourceQuoteId: null,
      });
      if (previous) return previous;

      await assertEligibilityLocked(client, user.userId, user.clientAccountId);
      const offer = await lockCatalogOffer(client, {
        priceId: body.priceId,
        locale: body.legalLocale ?? user.locale,
        allowQuote: false,
      });
      const promotion = await lockPromotion(client, {
        code: body.promotionCode,
        productId: offer.productId,
        billingCycle: offer.billingCycle,
        currency: offer.currency,
        forUpdate: body.promotionCode !== null,
      });
      const priced = buildOfferSnapshot(offer, body.configuration, promotion);
      const capacity = await supplyPreflight(client, {
        productId: offer.productId,
        units: priced.capacityUnits,
        commit: true,
      });
      const legal = await loadLegalDocuments(client, {
        locale: body.legalLocale ?? user.locale,
        termsVersion: body.termsVersion,
        aupVersion: body.aupVersion,
        termsDocumentId: body.termsDocumentId,
        aupDocumentId: body.aupDocumentId,
        termsLocale: body.termsLocale,
        aupLocale: body.aupLocale,
      });
      const issued = await issueCommercialOrder(client, {
        clientAccountId: user.clientAccountId,
        userId: user.userId,
        idempotencyKey: body.idempotencyKey,
        requestFingerprint: fingerprint,
        sourceQuoteId: null,
        productId: offer.productId,
        productName: offer.productName,
        productRevisionId: offer.productRevisionId,
        productRevision: offer.productRevision,
        priceId: offer.priceId,
        priceRevision: offer.priceRevision,
        fulfillmentMode: offer.fulfillmentMode,
        billingCycle: offer.billingCycle,
        configurationSnapshot: priced.configurationSnapshot,
        snapshot: priced.snapshot,
        capacity,
        legal,
        promotion,
      });
      if (body.marketingConsent) {
        await recordMarketingConsent(client, {
          clientAccountId: user.clientAccountId,
          userId: user.userId,
          granted: true,
          policyVersion: MARKETING_CONSENT_POLICY_VERSION,
          source: "checkout",
          idempotencyKey: `checkout:${fingerprint}`,
          requestFingerprint: fingerprint,
        });
      }
      return { ...issued, replayed: false };
    });

    setAccountContextHeaders(reply, user);
    return reply.code(created.replayed ? 200 : 201).send(created);
  });

  app.get("/api/v1/orders", async (request) => {
    const user = await requireUser(request, pool, config);
    assertFinancialReadEligible(user);
    const result = await pool.query<{
      order_id: string;
      order_status: string;
      product_name: string;
      service_id: string;
      service_status: string;
      created_at: Date;
    }>(
      `SELECT order_record.id AS order_id,
              order_record.status AS order_status,
              item.product_name,
              service.id AS service_id,
              service.status AS service_status,
              order_record.submitted_at AS created_at
       FROM orders order_record
       JOIN order_items item ON item.order_id = order_record.id
       JOIN services service ON service.order_item_id = item.id
       WHERE order_record.client_account_id = $1
       ORDER BY order_record.submitted_at DESC, order_record.id DESC
       LIMIT 50`,
      [user.clientAccountId],
    );
    return {
      items: result.rows.map((row) => ({
        orderId: row.order_id,
        orderStatus: row.order_status,
        productName: row.product_name,
        serviceId: row.service_id,
        serviceStatus: row.service_status,
        createdAt: row.created_at.toISOString(),
      })),
    };
  });

  app.get("/api/v1/orders/:orderId", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    assertFinancialReadEligible(user);
    const params = z.object({ orderId: z.uuid() }).parse(request.params);
    const result = await pool.query<{
      order_id: string;
      order_status: string;
      currency: string;
      price_snapshot: unknown;
      total_minor: string;
      invoice_id: string;
      invoice_total_minor: string;
      allocated_minor: string;
      payment_allocated_minor: string;
      credit_allocated_minor: string;
      payment_fee_minor: string;
      service_id: string;
      service_status: string;
      activated_at: Date | null;
      term_start: Date | null;
      term_end: Date | null;
      service_version: number;
      cancellation_request_id: string | null;
      cancellation_scheduled_at: Date | null;
      cancellation_effective_at: Date | null;
      cancellation_execution_mode: "automatic" | "manual" | null;
      cancellation_execution_status:
        | "scheduled"
        | "processing"
        | "unknown"
        | "manual"
        | "terminated"
        | null;
      cancellation_execution_result: Record<string, unknown> | null;
      cancellation_last_error: string | null;
      cancellation_operation_status: string | null;
      cancellation_operation_attempt_count: number | null;
      payment_status: string | null;
      provider_operation_status: string | null;
    }>(
      `SELECT
         o.id AS order_id,
         o.status AS order_status,
         o.currency,
         o.price_snapshot,
         o.total_minor,
         i.id AS invoice_id,
         i.total_minor AS invoice_total_minor,
         alloc.allocated_minor::text,
         alloc.payment_minor::text AS payment_allocated_minor,
         alloc.credit_minor::text AS credit_allocated_minor,
         COALESCE(fee.amount_minor, 0)::text AS payment_fee_minor,
         s.id AS service_id,
         s.status AS service_status,
         s.activated_at,
         s.term_start,
         s.term_end,
         s.version AS service_version,
         s.cancellation_request_id,
         s.cancellation_scheduled_at,
         s.cancellation_effective_at,
         cancellation_execution.execution_mode AS cancellation_execution_mode,
         cancellation_execution.status AS cancellation_execution_status,
         cancellation_execution.result AS cancellation_execution_result,
         cancellation_execution.last_error AS cancellation_last_error,
         cancellation_operation.status AS cancellation_operation_status,
         cancellation_operation.attempt_count AS cancellation_operation_attempt_count,
         pay.status AS payment_status,
         provision.status AS provider_operation_status
       FROM orders o
       JOIN invoices i ON i.order_id = o.id
       JOIN order_items oi ON oi.order_id = o.id
       JOIN services s ON s.order_item_id = oi.id
       LEFT JOIN service_cancellation_executions cancellation_execution
         ON cancellation_execution.cancellation_request_id = s.cancellation_request_id
       LEFT JOIN provider_operations cancellation_operation
         ON cancellation_operation.subject_type = 'service_cancellation_execution'
        AND cancellation_operation.subject_id = cancellation_execution.id
        AND cancellation_operation.kind = 'resource_terminate'
       JOIN invoice_allocation_totals alloc ON alloc.invoice_id = i.id
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(amount_minor), 0) AS amount_minor
         FROM invoice_lines
         WHERE invoice_id = i.id AND kind = 'payment_fee'
       ) fee ON true
       LEFT JOIN LATERAL (
         SELECT status
         FROM payment_attempts pa
         WHERE pa.invoice_id = i.id
         ORDER BY pa.created_at DESC
         LIMIT 1
       ) pay ON true
       LEFT JOIN LATERAL (
         SELECT status
         FROM provider_operations po
         WHERE po.subject_type = 'service' AND po.subject_id = s.id
         ORDER BY po.created_at DESC
         LIMIT 1
       ) provision ON true
       WHERE o.id = $1 AND o.client_account_id = $2`,
      [params.orderId, user.clientAccountId],
    );
    const row = result.rows[0];
    if (!row) return reply.code(404).send({ error: "Order not found" });
    const total = BigInt(row.invoice_total_minor);
    const allocated = BigInt(row.allocated_minor);
    return {
      order: { id: row.order_id, status: row.order_status, price: row.price_snapshot },
      invoice: {
        id: row.invoice_id,
        currency: row.currency,
        totalMinor: total.toString(),
        allocatedMinor: allocated.toString(),
        paymentAllocatedMinor: row.payment_allocated_minor,
        creditAppliedMinor: row.credit_allocated_minor,
        paymentFeeMinor: row.payment_fee_minor,
        dueMinor: (total - allocated).toString(),
        status: allocated === 0n ? "open" : allocated < total ? "partially_paid" : "paid",
      },
      payment: { status: row.payment_status },
      provisioning: { status: row.provider_operation_status },
      service: {
        id: row.service_id,
        status: row.service_status,
        activatedAt: row.activated_at?.toISOString() ?? null,
        termStart: row.term_start?.toISOString() ?? null,
        termEnd: row.term_end?.toISOString() ?? null,
        version: row.service_version,
        cancellation:
          row.cancellation_request_id &&
          row.cancellation_scheduled_at &&
          row.cancellation_effective_at
            ? {
                requestId: row.cancellation_request_id,
                status: row.cancellation_execution_status ?? "scheduled",
                executionMode: row.cancellation_execution_mode ?? "manual",
                scheduledAt: row.cancellation_scheduled_at.toISOString(),
                effectiveAt: row.cancellation_effective_at.toISOString(),
                result: row.cancellation_execution_result ?? {},
                lastError: row.cancellation_last_error,
                providerOperation: row.cancellation_operation_status
                  ? {
                      status: row.cancellation_operation_status,
                      attempts: row.cancellation_operation_attempt_count ?? 0,
                    }
                  : null,
              }
            : null,
      },
    };
  });

  app.post("/api/v1/invoices/:invoiceId/payments", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    const expectedContextVersion = expectedAccountContextVersion(request);
    assertBillingWriteEligible(user);
    const params = z.object({ invoiceId: z.uuid() }).parse(request.params);
    const body = paymentSchema.parse(request.body);
    if (body.savePaymentMethod || body.enableAutomaticRenewal) {
      await requireRecentReauth(pool, user);
    }
    const fingerprint = requestFingerprint("payments.create:v2", {
      invoiceId: params.invoiceId,
      quoteId: body.quoteId,
      scenario: body.scenario,
      savePaymentMethod: body.savePaymentMethod,
      saveConsentVersion: body.saveConsentVersion ?? null,
      enableAutomaticRenewal: body.enableAutomaticRenewal,
      automaticRenewalConsentVersion: body.automaticRenewalConsentVersion ?? null,
    });

    const result = await transaction(pool, async (client) => {
      const settlementIdentity = await client.query<{ target_user_id: string | null }>(
        `SELECT coalesce(
                  order_record.submitted_by_user_id,
                  original_order.submitted_by_user_id
                ) AS target_user_id
         FROM invoices invoice
         LEFT JOIN orders order_record ON order_record.id = invoice.order_id
         LEFT JOIN service_renewals renewal ON renewal.invoice_id = invoice.id
         LEFT JOIN services service ON service.id = renewal.service_id
         LEFT JOIN order_items item ON item.id = service.order_item_id
         LEFT JOIN orders original_order ON original_order.id = item.order_id
         WHERE invoice.id = $1`,
        [params.invoiceId],
      );
      const targetUserId = settlementIdentity.rows[0]?.target_user_id;
      const accountContext = await lockAccountContextForMutation(
        client,
        user,
        expectedContextVersion,
        targetUserId ? [targetUserId] : [],
      );
      assertCustomerCapability(accountContext, "billing.write");
      if (targetUserId && targetUserId !== user.userId) {
        await client.query(
          `SELECT user_id
           FROM client_memberships
           WHERE client_account_id = $1 AND user_id = $2
           FOR UPDATE`,
          [user.clientAccountId, targetUserId],
        );
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `payment:${user.clientAccountId}:${body.idempotencyKey}`,
      ]);
      if (body.savePaymentMethod || body.enableAutomaticRenewal) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `payment-settings:${user.clientAccountId}`,
        ]);
      }
      const idempotentCommand = await client.query<{
        id: string;
        invoice_id: string;
        payment_attempt_id: string | null;
        status: string;
        request_fingerprint: string;
        result: Record<string, unknown> | null;
      }>(
        `SELECT id, invoice_id, payment_attempt_id, status, request_fingerprint, result
         FROM invoice_payment_commands
         WHERE client_account_id = $1 AND idempotency_key = $2
         FOR UPDATE`,
        [user.clientAccountId, body.idempotencyKey],
      );
      const previous = idempotentCommand.rows[0];
      if (previous) {
        if (
          previous.invoice_id !== params.invoiceId ||
          previous.request_fingerprint !== fingerprint
        ) {
          throw Object.assign(new Error("The idempotency key was used for a different payment"), {
            statusCode: 409,
            code: "IDEMPOTENCY_CONFLICT",
          });
        }
        return {
          commandId: previous.id,
          paymentAttemptId: previous.payment_attempt_id,
          status: previous.status,
          result: previous.result,
          replayed: true,
        };
      }

      const quoteResult = await client.query<{
        id: string;
        payment_method_code: string;
        provider_installation_id: string;
        current_provider_installation_id: string;
        enabled: boolean;
        saved_method_enabled: boolean;
        automatic_renewal_enabled: boolean;
        current_fee_basis_points: number;
        fee_basis_points: number;
        currency: string;
        invoice_total_minor: string;
        payment_allocated_minor: string;
        credit_allocated_minor: string;
        available_credit_minor: string;
        credit_to_apply_minor: string;
        external_non_fee_minor: string;
        fee_minor: string;
        external_due_minor: string;
        expires_at: Date;
      }>(
        `SELECT
           q.id, q.payment_method_code, q.provider_installation_id,
           pm.provider_installation_id AS current_provider_installation_id, pm.enabled,
           pm.saved_method_enabled, pm.automatic_renewal_enabled,
           pm.fee_basis_points AS current_fee_basis_points, q.fee_basis_points,
           q.currency, q.invoice_total_minor::text,
           q.payment_allocated_minor::text, q.credit_allocated_minor::text,
           q.available_credit_minor::text, q.credit_to_apply_minor::text,
           q.external_non_fee_minor::text, q.fee_minor::text,
           q.external_due_minor::text, q.expires_at
         FROM invoice_payment_quotes q
         JOIN payment_methods pm ON pm.code = q.payment_method_code
         WHERE q.id = $1
           AND q.invoice_id = $2
           AND q.client_account_id = $3
         FOR SHARE OF q, pm`,
        [body.quoteId, params.invoiceId, user.clientAccountId],
      );
      const quote = quoteResult.rows[0];
      if (!quote) throw Object.assign(new Error("Payment quote not found"), { statusCode: 404 });
      if (quote.expires_at.getTime() <= Date.now()) {
        throw Object.assign(new Error("Payment quote expired; request a new quote"), {
          statusCode: 409,
          code: "QUOTE_EXPIRED",
        });
      }
      if (
        !quote.enabled ||
        quote.current_provider_installation_id !== quote.provider_installation_id ||
        quote.current_fee_basis_points !== quote.fee_basis_points
      ) {
        throw Object.assign(new Error("Payment method configuration changed; request a new quote"), {
          statusCode: 409,
          code: "QUOTE_STALE",
        });
      }
      if (body.savePaymentMethod && !quote.saved_method_enabled) {
        throw Object.assign(new Error("This payment method cannot be saved"), {
          statusCode: 409,
          code: "SAVED_PAYMENT_METHOD_UNSUPPORTED",
        });
      }
      if (body.enableAutomaticRenewal && !quote.automatic_renewal_enabled) {
        throw Object.assign(new Error("This payment method cannot be used for automatic renewal"), {
          statusCode: 409,
          code: "AUTOMATIC_RENEWAL_UNSUPPORTED",
        });
      }
      const invoiceResult = await client.query<{
        total_minor: string;
        currency: string;
        order_id: string | null;
      }>(
        `SELECT total_minor::text, currency, order_id
         FROM invoices
         WHERE id = $1 AND client_account_id = $2
         FOR UPDATE`,
        [params.invoiceId, user.clientAccountId],
      );
      const invoice = invoiceResult.rows[0];
      if (!invoice) throw Object.assign(new Error("Invoice not found"), { statusCode: 404 });
      await assertInvoicePaymentBusinessStateLocked(client, params.invoiceId, invoice.order_id);
      let automaticRenewalDecisionGeneration: string | null = null;
      let automaticRenewalServiceId: string | null = null;
      if (body.enableAutomaticRenewal) {
        const renewableService = await client.query<{
          id: string;
          automatic_renewal_decision_generation: string;
        }>(
          `SELECT service.id, service.automatic_renewal_decision_generation::text
           FROM services service
           WHERE service.client_account_id = $2
             AND service.billing_cycle <> 'one_time'
             AND service.status <> 'terminated'
             AND service.cancellation_request_id IS NULL
             AND (
               EXISTS (
                 SELECT 1
                 FROM order_items item
                 WHERE item.id = service.order_item_id AND item.order_id = $3
               )
               OR EXISTS (
                 SELECT 1 FROM service_renewals renewal
                 WHERE renewal.invoice_id = $1 AND renewal.service_id = service.id
               )
             )
           FOR UPDATE OF service`,
          [params.invoiceId, user.clientAccountId, invoice.order_id],
        );
        const renewable = renewableService.rows[0];
        if (!renewable) {
          throw Object.assign(new Error("This invoice is not linked to a renewable service"), {
            statusCode: 409,
            code: "SERVICE_NOT_RENEWABLE",
          });
        }
        const reservedDecision = await client.query<{
          automatic_renewal_decision_generation: string;
        }>(
          `UPDATE services
           SET automatic_renewal_decision_generation =
                 automatic_renewal_decision_generation + 1,
               updated_at = now(), version = version + 1
           WHERE id = $1
             AND automatic_renewal_decision_generation = $2
           RETURNING automatic_renewal_decision_generation::text`,
          [renewable.id, renewable.automatic_renewal_decision_generation],
        );
        automaticRenewalDecisionGeneration =
          reservedDecision.rows[0]?.automatic_renewal_decision_generation ?? null;
        if (!automaticRenewalDecisionGeneration) {
          throw Object.assign(
            new Error("Automatic-renewal consent changed; refresh and confirm again"),
            { statusCode: 409, code: "VERSION_CONFLICT" },
          );
        }
        automaticRenewalServiceId = renewable.id;
      }
      await assertEligibilityLocked(client, user.userId, user.clientAccountId);
      if (body.savePaymentMethod || body.enableAutomaticRenewal) {
        await requireRecentReauthLocked(client, user);
      }
      const allocationResult = await client.query<{
        payment_minor: string;
        credit_minor: string;
      }>(
        `SELECT payment_minor::text, credit_minor::text
         FROM invoice_allocation_totals
         WHERE invoice_id = $1`,
        [params.invoiceId],
      );
      const allocations = allocationResult.rows[0];
      if (!allocations) throw new Error("Invoice allocation summary is unavailable");
      if (
        invoice.currency !== quote.currency ||
        invoice.total_minor !== quote.invoice_total_minor ||
        allocations.payment_minor !== quote.payment_allocated_minor ||
        allocations.credit_minor !== quote.credit_allocated_minor
      ) {
        throw Object.assign(new Error("Invoice changed; request a new payment quote"), {
          statusCode: 409,
          code: "QUOTE_STALE",
        });
      }
      if (
        BigInt(allocations.payment_minor) + BigInt(allocations.credit_minor) >=
        BigInt(invoice.total_minor)
      ) {
        throw Object.assign(new Error("Invoice is already paid"), { statusCode: 409 });
      }
      const activeAttempt = await client.query<{ id: string; status: string; idempotency_key: string }>(
        `SELECT id, status, idempotency_key
         FROM payment_attempts
         WHERE invoice_id = $1 AND status IN ('created', 'processing', 'unknown')
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [params.invoiceId],
      );
      const existingActive = activeAttempt.rows[0];
      if (existingActive) {
        throw Object.assign(new Error("A payment result is still being confirmed"), {
          statusCode: 409,
          code: "PAYMENT_RESULT_UNKNOWN",
        });
      }

      const creditAccount = await client.query<{ id: string }>(
        `SELECT id
         FROM credit_accounts
         WHERE client_account_id = $1 AND currency = $2
         FOR UPDATE`,
        [user.clientAccountId, quote.currency],
      );
      const creditAccountId = creditAccount.rows[0]?.id;
      const creditBalanceResult = creditAccountId
        ? await client.query<{ balance_minor: string }>(
            `SELECT COALESCE(sum(credit_minor - debit_minor), 0)::text AS balance_minor
             FROM credit_transactions
             WHERE credit_account_id = $1`,
            [creditAccountId],
          )
        : { rows: [{ balance_minor: "0" }] };
      const creditBalance = creditBalanceResult.rows[0]?.balance_minor ?? "0";
      if (creditBalance !== quote.available_credit_minor) {
        throw Object.assign(new Error("Credit balance changed; request a new payment quote"), {
          statusCode: 409,
          code: "CREDIT_CHANGED",
        });
      }

      const commandId = randomUUID();
      await client.query(
        `INSERT INTO invoice_payment_commands(
           id, client_account_id, invoice_id, quote_id, status,
           idempotency_key, request_fingerprint, initiator_type, initiated_by_user_id
         ) VALUES ($1, $2, $3, $4, 'created', $5, $6, 'user', $7)`,
        [
          commandId,
          user.clientAccountId,
          params.invoiceId,
          quote.id,
          body.idempotencyKey,
          fingerprint,
          user.userId,
        ],
      );

      const creditToApply = BigInt(quote.credit_to_apply_minor);
      if (creditToApply > 0n) {
        if (!creditAccountId) throw new Error("Payment quote references unavailable Credit");
        const creditTransactionId = randomUUID();
        await client.query(
          `INSERT INTO credit_transactions(
             id, credit_account_id, kind, credit_minor, debit_minor,
             source_type, source_id, actor_type, actor_id, reason,
             idempotency_key, request_fingerprint
           ) VALUES (
             $1, $2, 'invoice_application', 0, $3,
             'invoice_payment_command', $4, 'user', $5,
             'Credit applied to invoice payment', $6, $7
           )`,
          [
            creditTransactionId,
            creditAccountId,
            quote.credit_to_apply_minor,
            commandId,
            user.userId,
            `invoice-credit:${commandId}`,
            fingerprint,
          ],
        );
        await client.query(
          `INSERT INTO credit_allocations(credit_transaction_id, invoice_id, amount_minor)
           VALUES ($1, $2, $3)`,
          [creditTransactionId, params.invoiceId, quote.credit_to_apply_minor],
        );
        const creditJournal = await client.query<{ id: string }>(
          `INSERT INTO ledger_journals(source_type, source_id, currency, description)
           VALUES ('invoice_credit_application', $1, $2, 'Credit applied to invoice')
           RETURNING id`,
          [creditTransactionId, quote.currency],
        );
        const journalId = creditJournal.rows[0]?.id;
        if (!journalId) throw new Error("Unable to create Credit application journal");
        await client.query(
          `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
           VALUES
             ($1, 'client_credit_liability', $2, 0),
             ($1, 'accounts_receivable', 0, $2)`,
          [journalId, quote.credit_to_apply_minor],
        );
      }

      if (BigInt(quote.external_due_minor) === 0n) {
        if (body.savePaymentMethod || body.enableAutomaticRenewal) {
          throw Object.assign(new Error("A fully Credit-funded invoice cannot create a saved Provider payment method"), {
            statusCode: 409,
            code: "NO_EXTERNAL_PAYMENT_METHOD_SETUP",
          });
        }
        const settlement = await advancePaidInvoice(client, params.invoiceId, {
          kind: "user_command",
          userId: user.userId,
        });
        const commandResult = {
          invoiceStatus: settlement.invoiceStatus,
          orderStatus: settlement.orderStatus ?? null,
          renewalStatus: settlement.renewalStatus ?? null,
          serviceStatus: settlement.serviceStatus ?? null,
          creditAppliedMinor: quote.credit_to_apply_minor,
          externalDueMinor: "0",
        };
        await client.query(
          `UPDATE invoice_payment_commands
           SET status = 'succeeded', result = $2, updated_at = now()
           WHERE id = $1`,
          [commandId, commandResult],
        );
        return {
          commandId,
          paymentAttemptId: null,
          status: "succeeded",
          result: commandResult,
          replayed: false,
        };
      }

      const paymentResult = await client.query<{ id: string }>(
         `INSERT INTO payment_attempts(
           client_account_id, invoice_id, provider_installation_id, status,
           amount_minor, principal_minor, fee_basis_points, fee_minor,
           currency, scenario, idempotency_key, request_fingerprint,
           payment_method_code, payment_quote_id,
           save_payment_method_requested, save_consent_version,
           automatic_renewal_requested, automatic_renewal_consent_version,
           automatic_renewal_service_id, automatic_renewal_decision_generation
         ) VALUES ($1, $2, $3, 'created', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         RETURNING id`,
        [
          user.clientAccountId,
          params.invoiceId,
          quote.provider_installation_id,
          quote.external_due_minor,
          quote.external_non_fee_minor,
          quote.fee_basis_points,
          quote.fee_minor,
          quote.currency,
          body.scenario,
          body.idempotencyKey,
          fingerprint,
          quote.payment_method_code,
          quote.id,
          body.savePaymentMethod,
          body.saveConsentVersion ?? null,
          body.enableAutomaticRenewal,
          body.automaticRenewalConsentVersion ?? null,
          automaticRenewalServiceId,
          automaticRenewalDecisionGeneration,
        ],
      );
      const paymentAttemptId = paymentResult.rows[0]?.id;
      if (!paymentAttemptId) throw new Error("Unable to create payment attempt");
      const operationResult = await client.query<{ id: string }>(
        `INSERT INTO provider_operations(
           provider_installation_id, kind, subject_type, subject_id, stable_key, status
         ) VALUES ($1, 'payment_create', 'payment', $2, $3, 'queued')
         ON CONFLICT (provider_installation_id, kind, stable_key) DO UPDATE
           SET updated_at = provider_operations.updated_at
         RETURNING id`,
        [quote.provider_installation_id, paymentAttemptId, `payment:${paymentAttemptId}`],
      );
      const operationId = operationResult.rows[0]?.id;
      if (!operationId) throw new Error("Unable to create provider operation");
      await client.query(
        `INSERT INTO durable_jobs(job_type, unique_key, payload)
         VALUES ('payment.start', $1, $2)
         ON CONFLICT (job_type, unique_key) DO NOTHING`,
        [
          `payment:${paymentAttemptId}`,
          { paymentAttemptId, providerOperationId: operationId },
        ],
      );
      await client.query(
        `UPDATE invoice_payment_commands
         SET payment_attempt_id = $2, status = 'processing', result = $3, updated_at = now()
         WHERE id = $1`,
        [
          commandId,
          paymentAttemptId,
          {
            creditAppliedMinor: quote.credit_to_apply_minor,
            externalDueMinor: quote.external_due_minor,
            feeMinor: quote.fee_minor,
          },
        ],
      );
      return {
        commandId,
        paymentAttemptId,
        status: "processing",
        result: {
          creditAppliedMinor: quote.credit_to_apply_minor,
          externalDueMinor: quote.external_due_minor,
          feeMinor: quote.fee_minor,
        },
        replayed: false,
      };
    });
    setAccountContextHeaders(reply, user);
    return reply
      .code(result.replayed || result.paymentAttemptId === null ? 200 : 202)
      .send(result);
  });
}
