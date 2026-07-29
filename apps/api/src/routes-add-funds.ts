// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { percentageFeeMinor } from "@opensales/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertEligible, requireUser } from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabaseClient, type DatabasePool } from "./database.js";
import { requestFingerprint } from "./idempotency.js";

const quoteSchema = z.object({
  principalMinor: z.string().regex(/^[1-9]\d*$/),
  paymentMethod: z.string().min(2).max(32),
});

const commandSchema = z.object({
  quoteId: z.uuid(),
  scenario: z
    .enum([
      "success",
      "failed",
      "cancelled",
      "timeout_success",
      "duplicate_out_of_order",
      "definitive_reject",
      "partial_then_reject",
      "partial_then_timeout",
      "partial",
      "wrong_currency",
      "expired_late",
      "late_success",
    ])
    .default("success"),
  idempotencyKey: z.string().min(8).max(128),
});

async function assertEligibilityLocked(
  client: DatabaseClient,
  userId: string,
  clientAccountId: string,
): Promise<void> {
  const result = await client.query<{
    email_verified_at: Date | null;
    user_restricted_at: Date | null;
    account_restricted_at: Date | null;
    removed_at: Date | null;
    membership_role: string;
  }>(
    `SELECT
       customer.email_verified_at,
       customer.restricted_at AS user_restricted_at,
       account.restricted_at AS account_restricted_at,
       membership.removed_at,
       membership.role AS membership_role
     FROM users customer
     JOIN client_memberships membership
       ON membership.user_id = customer.id
      AND membership.client_account_id = $2
     JOIN client_accounts account ON account.id = membership.client_account_id
     WHERE customer.id = $1
     FOR UPDATE OF customer, membership, account`,
    [userId, clientAccountId],
  );
  const state = result.rows[0];
  if (
    !state?.email_verified_at ||
    state.user_restricted_at ||
    state.account_restricted_at ||
    state.removed_at ||
    (state.membership_role !== "owner" && state.membership_role !== "billing")
  ) {
    throw Object.assign(new Error("Account is not eligible to Add Funds"), {
      statusCode: 403,
      code: "ACCOUNT_NOT_ELIGIBLE",
    });
  }
}

async function lockCreditAccount(
  client: DatabaseClient,
  clientAccountId: string,
  currency: string,
): Promise<{ id: string; balanceMinor: bigint }> {
  await client.query(
    `INSERT INTO credit_accounts(client_account_id, currency)
     VALUES ($1, $2)
     ON CONFLICT (client_account_id, currency) DO NOTHING`,
    [clientAccountId, currency],
  );
  const account = await client.query<{ id: string }>(
    `SELECT id
     FROM credit_accounts
     WHERE client_account_id = $1 AND currency = $2
     FOR UPDATE`,
    [clientAccountId, currency],
  );
  const creditAccountId = account.rows[0]?.id;
  if (!creditAccountId) throw new Error("Unable to establish Credit account");
  const balance = await client.query<{ balance_minor: string }>(
    `SELECT COALESCE(sum(credit_minor - debit_minor), 0)::text AS balance_minor
     FROM credit_transactions
     WHERE credit_account_id = $1`,
    [creditAccountId],
  );
  return {
    id: creditAccountId,
    balanceMinor: BigInt(balance.rows[0]?.balance_minor ?? "0"),
  };
}

async function pendingPrincipal(
  client: DatabaseClient,
  clientAccountId: string,
  currency: string,
): Promise<bigint> {
  const result = await client.query<{ pending_minor: string }>(
    `SELECT COALESCE(sum(principal_minor), 0)::text AS pending_minor
     FROM add_funds_attempts
     WHERE client_account_id = $1
       AND currency = $2
       AND status IN ('created', 'processing', 'unknown')`,
    [clientAccountId, currency],
  );
  return BigInt(result.rows[0]?.pending_minor ?? "0");
}

export async function registerAddFundsRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.post("/api/v1/billing/add-funds/quotes", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    assertEligible(user);
    if (user.membershipRole !== "owner" && user.membershipRole !== "billing") {
      return reply.code(403).send({ error: "Billing permission is required" });
    }
    const body = quoteSchema.parse(request.body);
    const fingerprint = requestFingerprint("add-funds.quote:v1", body);

    const quote = await transaction(pool, async (client) => {
      await assertEligibilityLocked(client, user.userId, user.clientAccountId);
      const policyResult = await client.query<{
        currency: string;
        min_principal_minor: string;
        max_principal_minor: string;
        balance_cap_minor: string;
      }>(
        `SELECT
           currency, min_principal_minor::text, max_principal_minor::text,
           balance_cap_minor::text
         FROM add_funds_policies
         WHERE currency = 'USD' AND enabled
         FOR SHARE`,
      );
      const policy = policyResult.rows[0];
      if (!policy) {
        throw Object.assign(new Error("Add Funds is not available"), {
          statusCode: 409,
          code: "ADD_FUNDS_DISABLED",
        });
      }
      const methodResult = await client.query<{
        code: string;
        fee_basis_points: number;
        provider_installation_id: string;
      }>(
        `SELECT code, fee_basis_points, provider_installation_id
         FROM payment_methods
         WHERE code = $1 AND enabled AND add_funds_enabled
         FOR SHARE`,
        [body.paymentMethod],
      );
      const method = methodResult.rows[0];
      if (!method) {
        throw Object.assign(new Error("Payment method is not available for Add Funds"), {
          statusCode: 404,
        });
      }

      const principal = BigInt(body.principalMinor);
      if (
        principal < BigInt(policy.min_principal_minor) ||
        principal > BigInt(policy.max_principal_minor)
      ) {
        throw Object.assign(new Error("Add Funds amount is outside the configured range"), {
          statusCode: 409,
          code: "ADD_FUNDS_AMOUNT_OUT_OF_RANGE",
        });
      }
      const credit = await lockCreditAccount(client, user.clientAccountId, policy.currency);
      const pending = await pendingPrincipal(client, user.clientAccountId, policy.currency);
      const balanceCap = BigInt(policy.balance_cap_minor);
      if (credit.balanceMinor + pending + principal > balanceCap) {
        throw Object.assign(new Error("Add Funds would exceed the Credit balance cap"), {
          statusCode: 409,
          code: "CREDIT_BALANCE_CAP",
        });
      }
      const fee = percentageFeeMinor(principal, method.fee_basis_points);
      const inserted = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO add_funds_quotes(
           client_account_id, requested_by_user_id, payment_method_code,
           provider_installation_id, currency, principal_minor,
           balance_before_minor, balance_cap_minor, fee_basis_points,
           fee_minor, external_due_minor, request_fingerprint, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           now() + interval '10 minutes'
         )
         RETURNING id, expires_at`,
        [
          user.clientAccountId,
          user.userId,
          method.code,
          method.provider_installation_id,
          policy.currency,
          principal.toString(),
          credit.balanceMinor.toString(),
          balanceCap.toString(),
          method.fee_basis_points,
          fee.toString(),
          (principal + fee).toString(),
          fingerprint,
        ],
      );
      const created = inserted.rows[0];
      if (!created) throw new Error("Unable to create Add Funds quote");
      return {
        quoteId: created.id,
        currency: policy.currency,
        paymentMethod: method.code,
        principalMinor: principal.toString(),
        feeBasisPoints: method.fee_basis_points,
        feeMinor: fee.toString(),
        externalDueMinor: (principal + fee).toString(),
        creditBalanceMinor: credit.balanceMinor.toString(),
        pendingPrincipalMinor: pending.toString(),
        balanceCapMinor: balanceCap.toString(),
        expiresAt: created.expires_at.toISOString(),
      };
    });
    return reply.code(201).send(quote);
  });

  app.post("/api/v1/billing/add-funds", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    assertEligible(user);
    if (user.membershipRole !== "owner" && user.membershipRole !== "billing") {
      return reply.code(403).send({ error: "Billing permission is required" });
    }
    const body = commandSchema.parse(request.body);
    const fingerprint = requestFingerprint("add-funds.create:v1", {
      quoteId: body.quoteId,
      scenario: body.scenario,
    });

    const outcome = await transaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `add-funds:${user.clientAccountId}:${body.idempotencyKey}`,
      ]);
      const previous = await client.query<{
        id: string;
        quote_id: string;
        add_funds_attempt_id: string;
        status: string;
        request_fingerprint: string;
        result: Record<string, unknown> | null;
      }>(
        `SELECT
           id, quote_id, add_funds_attempt_id, status, request_fingerprint, result
         FROM add_funds_commands
         WHERE client_account_id = $1 AND idempotency_key = $2
         FOR UPDATE`,
        [user.clientAccountId, body.idempotencyKey],
      );
      const replay = previous.rows[0];
      if (replay) {
        if (replay.quote_id !== body.quoteId || replay.request_fingerprint !== fingerprint) {
          throw Object.assign(
            new Error("The idempotency key was used for a different Add Funds request"),
            { statusCode: 409, code: "IDEMPOTENCY_CONFLICT" },
          );
        }
        return {
          commandId: replay.id,
          addFundsAttemptId: replay.add_funds_attempt_id,
          status: replay.status,
          result: replay.result,
          replayed: true,
        };
      }

      const quoteResult = await client.query<{
        id: string;
        requested_by_user_id: string;
        payment_method_code: string;
        provider_installation_id: string;
        current_provider_installation_id: string;
        method_enabled: boolean;
        add_funds_enabled: boolean;
        current_fee_basis_points: number;
        fee_basis_points: number;
        currency: string;
        principal_minor: string;
        balance_before_minor: string;
        balance_cap_minor: string;
        fee_minor: string;
        external_due_minor: string;
        expires_at: Date;
        policy_enabled: boolean;
        min_principal_minor: string;
        max_principal_minor: string;
        current_balance_cap_minor: string;
      }>(
        `SELECT
           quote.id, quote.requested_by_user_id, quote.payment_method_code,
           quote.provider_installation_id,
           method.provider_installation_id AS current_provider_installation_id,
           method.enabled AS method_enabled,
           method.add_funds_enabled,
           method.fee_basis_points AS current_fee_basis_points,
           quote.fee_basis_points,
           quote.currency,
           quote.principal_minor::text,
           quote.balance_before_minor::text,
           quote.balance_cap_minor::text,
           quote.fee_minor::text,
           quote.external_due_minor::text,
           quote.expires_at,
           policy.enabled AS policy_enabled,
           policy.min_principal_minor::text,
           policy.max_principal_minor::text,
           policy.balance_cap_minor::text AS current_balance_cap_minor
         FROM add_funds_quotes quote
         JOIN payment_methods method ON method.code = quote.payment_method_code
         JOIN add_funds_policies policy ON policy.currency = quote.currency
         WHERE quote.id = $1 AND quote.client_account_id = $2
         FOR UPDATE OF quote
         FOR SHARE OF method, policy`,
        [body.quoteId, user.clientAccountId],
      );
      const quote = quoteResult.rows[0];
      if (!quote) {
        throw Object.assign(new Error("Add Funds quote not found"), { statusCode: 404 });
      }
      if (quote.requested_by_user_id !== user.userId) {
        throw Object.assign(new Error("Add Funds quote belongs to another user"), {
          statusCode: 403,
        });
      }
      const consumedQuote = await client.query<{ id: string }>(
        `SELECT id
         FROM add_funds_commands
         WHERE quote_id = $1
         LIMIT 1`,
        [quote.id],
      );
      if (consumedQuote.rows[0]) {
        throw Object.assign(new Error("Add Funds quote has already been used"), {
          statusCode: 409,
          code: "QUOTE_ALREADY_USED",
        });
      }
      if (quote.expires_at.getTime() <= Date.now()) {
        throw Object.assign(new Error("Add Funds quote expired; request a new quote"), {
          statusCode: 409,
          code: "QUOTE_EXPIRED",
        });
      }
      const principal = BigInt(quote.principal_minor);
      if (
        !quote.policy_enabled ||
        !quote.method_enabled ||
        !quote.add_funds_enabled ||
        quote.current_provider_installation_id !== quote.provider_installation_id ||
        quote.current_fee_basis_points !== quote.fee_basis_points ||
        BigInt(quote.current_balance_cap_minor) !== BigInt(quote.balance_cap_minor) ||
        principal < BigInt(quote.min_principal_minor) ||
        principal > BigInt(quote.max_principal_minor)
      ) {
        throw Object.assign(
          new Error("Add Funds configuration changed; request a new quote"),
          { statusCode: 409, code: "QUOTE_STALE" },
        );
      }
      await assertEligibilityLocked(client, user.userId, user.clientAccountId);
      const credit = await lockCreditAccount(client, user.clientAccountId, quote.currency);
      if (credit.balanceMinor !== BigInt(quote.balance_before_minor)) {
        throw Object.assign(new Error("Credit balance changed; request a new Add Funds quote"), {
          statusCode: 409,
          code: "CREDIT_CHANGED",
        });
      }
      const pending = await pendingPrincipal(client, user.clientAccountId, quote.currency);
      if (credit.balanceMinor + pending + principal > BigInt(quote.balance_cap_minor)) {
        throw Object.assign(new Error("Add Funds would exceed the Credit balance cap"), {
          statusCode: 409,
          code: "CREDIT_BALANCE_CAP",
        });
      }

      const commandId = randomUUID();
      const attemptId = randomUUID();
      await client.query(
        `INSERT INTO add_funds_attempts(
           id, client_account_id, submitted_by_user_id, quote_id,
           provider_installation_id, status, amount_minor, principal_minor,
           fee_basis_points, fee_minor, currency, scenario, payment_method_code,
           idempotency_key, request_fingerprint, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, 'created', $6, $7, $8, $9, $10, $11, $12,
           $13, $14, now() + interval '30 minutes'
         )`,
        [
          attemptId,
          user.clientAccountId,
          user.userId,
          quote.id,
          quote.provider_installation_id,
          quote.external_due_minor,
          quote.principal_minor,
          quote.fee_basis_points,
          quote.fee_minor,
          quote.currency,
          body.scenario,
          quote.payment_method_code,
          body.idempotencyKey,
          fingerprint,
        ],
      );
      const commandResult = {
        principalMinor: quote.principal_minor,
        feeMinor: quote.fee_minor,
        externalDueMinor: quote.external_due_minor,
      };
      await client.query(
        `INSERT INTO add_funds_commands(
           id, client_account_id, submitted_by_user_id, quote_id,
           add_funds_attempt_id, status, idempotency_key, request_fingerprint, result
         ) VALUES ($1, $2, $3, $4, $5, 'processing', $6, $7, $8)`,
        [
          commandId,
          user.clientAccountId,
          user.userId,
          quote.id,
          attemptId,
          body.idempotencyKey,
          fingerprint,
          commandResult,
        ],
      );
      const operationResult = await client.query<{ id: string }>(
        `INSERT INTO provider_operations(
           provider_installation_id, kind, subject_type, subject_id, stable_key, status
         ) VALUES ($1, 'payment_create', 'add_funds', $2, $3, 'queued')
         RETURNING id`,
        [quote.provider_installation_id, attemptId, `add-funds:${attemptId}`],
      );
      const providerOperationId = operationResult.rows[0]?.id;
      if (!providerOperationId) throw new Error("Unable to create Add Funds Provider operation");
      await client.query(
        `INSERT INTO durable_jobs(job_type, unique_key, payload)
         VALUES ('add_funds.start', $1, $2)`,
        [
          `add-funds:${attemptId}`,
          { addFundsAttemptId: attemptId, providerOperationId },
        ],
      );
      return {
        commandId,
        addFundsAttemptId: attemptId,
        providerOperationId,
        status: "processing",
        result: commandResult,
        replayed: false,
      };
    });
    return reply.code(outcome.replayed ? 200 : 202).send(outcome);
  });

  app.get("/api/v1/billing/add-funds/:commandId", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    assertEligible(user);
    if (user.membershipRole !== "owner" && user.membershipRole !== "billing") {
      return reply.code(403).send({ error: "Billing permission is required" });
    }
    const params = z.object({ commandId: z.uuid() }).parse(request.params);
    const result = await pool.query<{
      id: string;
      status: string;
      result: Record<string, unknown> | null;
      created_at: Date;
      updated_at: Date;
      add_funds_attempt_id: string;
      attempt_status: string;
      external_payment_id: string | null;
      principal_minor: string;
      fee_minor: string;
      external_due_minor: string;
      currency: string;
      payment_method_code: string;
      expires_at: Date;
      provider_operation_id: string | null;
      provider_operation_status: string | null;
    }>(
      `SELECT
         command.id,
         command.status,
         command.result,
         command.created_at,
         command.updated_at,
         attempt.id AS add_funds_attempt_id,
         attempt.status AS attempt_status,
         attempt.external_payment_id,
         attempt.principal_minor::text,
         attempt.fee_minor::text,
         attempt.amount_minor::text AS external_due_minor,
         attempt.currency,
         attempt.payment_method_code,
         attempt.expires_at,
         operation.id AS provider_operation_id,
         operation.status AS provider_operation_status
       FROM add_funds_commands command
       JOIN add_funds_attempts attempt ON attempt.id = command.add_funds_attempt_id
       LEFT JOIN provider_operations operation
         ON operation.subject_type = 'add_funds'
        AND operation.subject_id = attempt.id
        AND operation.kind = 'payment_create'
       WHERE command.id = $1 AND command.client_account_id = $2`,
      [params.commandId, user.clientAccountId],
    );
    const command = result.rows[0];
    if (!command) return reply.code(404).send({ error: "Add Funds command not found" });
    return {
      warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      commandId: command.id,
      addFundsAttemptId: command.add_funds_attempt_id,
      providerOperationId: command.provider_operation_id,
      status: command.status,
      attemptStatus: command.attempt_status,
      providerOperationStatus: command.provider_operation_status,
      externalPaymentId: command.external_payment_id,
      currency: command.currency,
      paymentMethod: command.payment_method_code,
      principalMinor: command.principal_minor,
      feeMinor: command.fee_minor,
      externalDueMinor: command.external_due_minor,
      expiresAt: command.expires_at.toISOString(),
      result: command.result,
      createdAt: command.created_at.toISOString(),
      updatedAt: command.updated_at.toISOString(),
    };
  });
}
