// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import {
  buildPriceSnapshot,
  jsonMoney,
  type BillingCycle,
  type FulfillmentMode,
  type PriceComponent,
} from "@opensales/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertBillingWriteEligible, assertEligible, requireUser } from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabaseClient, type DatabasePool } from "./database.js";
import { requestFingerprint } from "./idempotency.js";
import { advancePaidInvoice } from "./invoice-settlement.js";
import { assertInvoicePaymentBusinessStateLocked } from "./invoice-payment-eligibility.js";

const checkoutSchema = z.object({
  priceId: z.uuid(),
  configuration: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  termsVersion: z.string().min(1).max(64),
  aupVersion: z.string().min(1).max(64),
  idempotencyKey: z.string().min(8).max(128),
});

const paymentSchema = z.object({
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
  idempotencyKey: z.string().min(8).max(128),
});

function buildOptionComponents(
  optionSchema: unknown,
  configuration: Record<string, string | number | boolean>,
): PriceComponent[] {
  if (!Array.isArray(optionSchema)) {
    if (Object.keys(configuration).length > 0) {
      throw Object.assign(new Error("This product does not accept configuration options"), {
        statusCode: 400,
        code: "INVALID_CONFIGURATION",
      });
    }
    return [];
  }
  const components: PriceComponent[] = [];
  const acceptedKeys = new Set<string>();
  for (const rawOption of optionSchema) {
    if (typeof rawOption !== "object" || rawOption === null) {
      throw new Error("Product option schema is invalid");
    }
    const option = rawOption as Record<string, unknown>;
    if (typeof option.code !== "string" || option.code.length === 0) {
      throw new Error("Product option schema has no code");
    }
    if (acceptedKeys.has(option.code)) throw new Error(`Product option schema repeats ${option.code}`);
    acceptedKeys.add(option.code);
    const configured = Object.prototype.hasOwnProperty.call(configuration, option.code);
    if (option.required === true && !configured) {
      throw Object.assign(new Error(`${option.code} is required`), {
        statusCode: 400,
        code: "INVALID_CONFIGURATION",
      });
    }
    if (!configured) continue;

    if (option.type === "quantity" && typeof option.recurringUnitMinor === "number") {
      const rawQuantity = configuration[option.code];
      const quantity =
        typeof rawQuantity === "number"
          ? rawQuantity
          : typeof rawQuantity === "string" && /^-?\d+$/.test(rawQuantity)
            ? Number(rawQuantity)
            : Number.NaN;
      const minimum = typeof option.min === "number" ? option.min : 1;
      const maximum = typeof option.max === "number" ? option.max : Number.MAX_SAFE_INTEGER;
      const step = typeof option.step === "number" ? option.step : 1;
      if (
        !Number.isSafeInteger(quantity) ||
        !Number.isSafeInteger(minimum) ||
        !Number.isSafeInteger(maximum) ||
        !Number.isSafeInteger(step) ||
        step <= 0 ||
        quantity < minimum ||
        quantity > maximum ||
        (quantity - minimum) % step !== 0
      ) {
        throw Object.assign(new Error(`${option.code} is outside its allowed quantity range`), {
          statusCode: 400,
          code: "INVALID_CONFIGURATION",
        });
      }
      components.push({
        code: option.code,
        label: option.code,
        quantity,
        oneTimeMinor: 0n,
        recurringMinor: BigInt(option.recurringUnitMinor),
      });
      continue;
    }

    if (option.type === "text" || option.type === "password" || option.type === "textarea") {
      const value = configuration[option.code];
      const minimum = typeof option.minLength === "number" ? option.minLength : 0;
      const maximum = typeof option.maxLength === "number" ? option.maxLength : 4096;
      if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
        throw Object.assign(new Error(`${option.code} is not valid text`), {
          statusCode: 400,
          code: "INVALID_CONFIGURATION",
        });
      }
      continue;
    }

    throw new Error(`Product option type ${String(option.type)} is not supported safely`);
  }
  for (const key of Object.keys(configuration)) {
    if (!acceptedKeys.has(key)) {
      throw Object.assign(new Error(`Unknown product option ${key}`), {
        statusCode: 400,
        code: "INVALID_CONFIGURATION",
      });
    }
  }
  return components;
}

function jsonPriceSnapshot(snapshot: ReturnType<typeof buildPriceSnapshot>) {
  return {
    ...snapshot,
    oneTimeSubtotalMinor: jsonMoney(snapshot.oneTimeSubtotalMinor),
    setupMinor: jsonMoney(snapshot.setupMinor),
    recurringSubtotalMinor: jsonMoney(snapshot.recurringSubtotalMinor),
    invoiceTotalMinor: jsonMoney(snapshot.invoiceTotalMinor),
    components: snapshot.components.map((component) => ({
      ...component,
      oneTimeMinor: jsonMoney(component.oneTimeMinor),
      recurringMinor: jsonMoney(component.recurringMinor),
    })),
  };
}

async function assertEligibilityLocked(
  client: DatabaseClient,
  userId: string,
  clientAccountId: string,
  requireBillingRole = false,
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
    membership_role: "owner" | "billing" | "technical" | "viewer";
  }>(
    `SELECT
       u.email_verified_at,
       u.restricted_at AS user_restricted_at,
       ca.restricted_at AS account_restricted_at,
       cm.removed_at,
       cm.role AS membership_role
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
    state.removed_at ||
    (requireBillingRole &&
      state.membership_role !== "owner" &&
      state.membership_role !== "billing")
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
    assertEligible(user);
    const body = checkoutSchema.parse(request.body);
    const fingerprint = requestFingerprint("orders.create:v1", {
      priceId: body.priceId,
      configuration: body.configuration,
      termsVersion: body.termsVersion,
      aupVersion: body.aupVersion,
    });

    const created = await transaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `order:${user.clientAccountId}:${body.idempotencyKey}`,
      ]);
      const existing = await client.query<{
        id: string;
        request_fingerprint: string;
      }>(
        `SELECT id, request_fingerprint
         FROM orders
         WHERE client_account_id = $1 AND idempotency_key = $2
         FOR UPDATE`,
        [user.clientAccountId, body.idempotencyKey],
      );
      const previous = existing.rows[0];
      if (previous) {
        if (previous.request_fingerprint !== fingerprint) {
          throw Object.assign(new Error("The idempotency key was used for a different order"), {
            statusCode: 409,
            code: "IDEMPOTENCY_CONFLICT",
          });
        }
        return { orderId: previous.id, replayed: true };
      }

      await assertEligibilityLocked(client, user.userId, user.clientAccountId);
      const priceResult = await client.query<{
        id: string;
        product_id: string;
        revision: number;
        currency: string;
        billing_cycle: BillingCycle;
        one_time_minor: string;
        setup_minor: string;
        recurring_minor: string;
        fulfillment_mode: FulfillmentMode;
        names: Record<string, string>;
        option_schema: unknown;
        active: boolean;
        hidden: boolean;
      }>(
        `SELECT
           pp.id, pp.product_id, pp.revision, pp.currency, pp.billing_cycle,
           pp.one_time_minor, pp.setup_minor, pp.recurring_minor,
           p.fulfillment_mode, p.names, p.option_schema, p.active, p.hidden
         FROM product_prices pp
         JOIN products p ON p.id = pp.product_id
         WHERE pp.id = $1
           AND pp.active
           AND pp.valid_from <= now()
           AND (pp.valid_until IS NULL OR pp.valid_until > now())
         FOR SHARE OF pp, p`,
        [body.priceId],
      );
      const price = priceResult.rows[0];
      if (!price || !price.active || price.hidden) {
        throw Object.assign(new Error("Product is not available"), { statusCode: 409 });
      }
      if (price.fulfillment_mode === "quote") {
        throw Object.assign(new Error("This product requires a confirmed quote before ordering"), {
          statusCode: 409,
          code: "QUOTE_REQUIRED",
        });
      }

      const productName = price.names[user.locale] ?? price.names.en ?? price.product_id;
      const snapshot = buildPriceSnapshot({
        productId: price.product_id,
        productName,
        currency: price.currency,
        billingCycle: price.billing_cycle,
        fulfillmentMode: price.fulfillment_mode,
        baseOneTimeMinor: BigInt(price.one_time_minor),
        setupMinor: BigInt(price.setup_minor),
        baseRecurringMinor: BigInt(price.recurring_minor),
        optionComponents: buildOptionComponents(price.option_schema, body.configuration),
      });
      const serializedSnapshot = jsonPriceSnapshot(snapshot);

      const legalResult = await client.query<{ id: string; kind: "terms" | "aup" }>(
        `SELECT id, kind
         FROM legal_documents
         WHERE locale = $1
           AND ((kind = 'terms' AND version = $2) OR (kind = 'aup' AND version = $3))
         ORDER BY kind`,
        [user.locale, body.termsVersion, body.aupVersion],
      );
      if (
        legalResult.rows.length !== 2 ||
        !legalResult.rows.some((document) => document.kind === "terms") ||
        !legalResult.rows.some((document) => document.kind === "aup")
      ) {
        throw Object.assign(new Error("The selected legal document version is not available"), {
          statusCode: 409,
        });
      }

      const orderResult = await client.query<{ id: string }>(
        `INSERT INTO orders(
           client_account_id, submitted_by_user_id, status, currency, price_snapshot,
           one_time_minor, setup_minor, recurring_minor, total_minor, idempotency_key,
           request_fingerprint
         ) VALUES ($1, $2, 'waiting_payment', $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          user.clientAccountId,
          user.userId,
          snapshot.currency,
          serializedSnapshot,
          snapshot.oneTimeSubtotalMinor.toString(),
          snapshot.setupMinor.toString(),
          snapshot.recurringSubtotalMinor.toString(),
          snapshot.invoiceTotalMinor.toString(),
          body.idempotencyKey,
          fingerprint,
        ],
      );
      const orderId = orderResult.rows[0]?.id;
      if (!orderId) throw new Error("Unable to create order");

      for (const legalDocument of legalResult.rows) {
        await client.query(
          `INSERT INTO legal_acceptances(client_account_id, user_id, document_id)
           VALUES ($1, $2, $3)`,
          [user.clientAccountId, user.userId, legalDocument.id],
        );
      }

      const orderItemResult = await client.query<{ id: string }>(
        `INSERT INTO order_items(
           order_id, product_id, product_name, fulfillment_mode, billing_cycle,
           configuration, price_snapshot
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          orderId,
          snapshot.productId,
          snapshot.productName,
          snapshot.fulfillmentMode,
          snapshot.billingCycle,
          body.configuration,
          serializedSnapshot,
        ],
      );
      const orderItemId = orderItemResult.rows[0]?.id;
      if (!orderItemId) throw new Error("Unable to create order item");

      const invoiceResult = await client.query<{ id: string }>(
        `INSERT INTO invoices(client_account_id, order_id, currency, total_minor, due_at)
         VALUES ($1, $2, $3, $4, now() + interval '7 days')
         RETURNING id`,
        [
          user.clientAccountId,
          orderId,
          snapshot.currency,
          snapshot.invoiceTotalMinor.toString(),
        ],
      );
      const invoiceId = invoiceResult.rows[0]?.id;
      if (!invoiceId) throw new Error("Unable to create invoice");

      const journalResult = await client.query<{ id: string }>(
        `INSERT INTO ledger_journals(source_type, source_id, currency, description)
         VALUES ('invoice_issuance', $1, $2, 'Invoice issued')
         RETURNING id`,
        [invoiceId, snapshot.currency],
      );
      const invoiceJournalId = journalResult.rows[0]?.id;
      if (!invoiceJournalId) throw new Error("Unable to create invoice journal");
      if (snapshot.invoiceTotalMinor > 0n) {
        await client.query(
          `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
           VALUES
             ($1, 'accounts_receivable', $2, 0),
             ($1, 'deferred_service_revenue', 0, $2)`,
          [invoiceJournalId, snapshot.invoiceTotalMinor.toString()],
        );
      }

      const invoiceLines = [
        ["one_time", `${snapshot.productName} one-time`, snapshot.oneTimeSubtotalMinor],
        ["setup", `${snapshot.productName} setup`, snapshot.setupMinor],
        ["recurring", `${snapshot.productName} ${snapshot.billingCycle}`, snapshot.recurringSubtotalMinor],
      ] as const;
      for (const [kind, description, amount] of invoiceLines) {
        if (amount > 0n) {
          await client.query(
            `INSERT INTO invoice_lines(invoice_id, kind, description, amount_minor)
             VALUES ($1, $2, $3, $4)`,
            [invoiceId, kind, description, amount.toString()],
          );
        }
      }

      const serviceResult = await client.query<{ id: string }>(
        `INSERT INTO services(client_account_id, order_item_id, status, billing_cycle)
         VALUES ($1, $2, 'pending', $3)
         RETURNING id`,
        [user.clientAccountId, orderItemId, snapshot.billingCycle],
      );
      const serviceId = serviceResult.rows[0]?.id;
      if (!serviceId) throw new Error("Unable to create service");

      await client.query(
        `INSERT INTO service_provider_bindings(
           service_id, provider_installation_id, overdue_action_snapshot,
           capability_snapshot, product_policy_version,
           cycle_end_cancellation_mode_snapshot,
           cycle_end_cancellation_execution_mode_snapshot,
           cycle_end_cancellation_min_notice_hours_snapshot,
           cycle_end_cancellation_requirement_key_snapshot
         )
         SELECT
           $1,
           policy.provider_installation_id,
           policy.overdue_action,
           COALESCE(provider.capabilities, '[]'::jsonb),
           policy.version,
           policy.cycle_end_cancellation_mode,
           policy.cycle_end_cancellation_execution_mode,
           policy.cycle_end_cancellation_min_notice_hours,
           policy.cycle_end_cancellation_requirement_key
         FROM product_service_automation_policies policy
         LEFT JOIN provider_installation_capabilities provider
           ON provider.provider_installation_id = policy.provider_installation_id
         WHERE policy.product_id = $2`,
        [serviceId, snapshot.productId],
      );

      await client.query(
        `INSERT INTO outbox(event_type, unique_key, payload)
         VALUES ('order.submitted', $1, $2)`,
        [`order:${orderId}`, { orderId, invoiceId, clientAccountId: user.clientAccountId }],
      );
      return { orderId, invoiceId, serviceId, replayed: false };
    });

    return reply.code(created.replayed ? 200 : 201).send(created);
  });

  app.get("/api/v1/orders", async (request) => {
    const user = await requireUser(request, pool, config);
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
    assertBillingWriteEligible(user);
    const params = z.object({ invoiceId: z.uuid() }).parse(request.params);
    const body = paymentSchema.parse(request.body);
    const fingerprint = requestFingerprint("payments.create:v2", {
      invoiceId: params.invoiceId,
      quoteId: body.quoteId,
      scenario: body.scenario,
    });

    const result = await transaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `payment:${user.clientAccountId}:${body.idempotencyKey}`,
      ]);
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
      await assertEligibilityLocked(client, user.userId, user.clientAccountId, true);
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
           payment_method_code, payment_quote_id
         ) VALUES ($1, $2, $3, 'created', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
    return reply
      .code(result.replayed || result.paymentAttemptId === null ? 200 : 202)
      .send(result);
  });
}
