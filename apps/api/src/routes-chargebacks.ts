// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FastifyInstance } from "fastify";
import {
  assertFinancialReadEligible,
  requireSessionIdentity,
  requireUser,
} from "./auth.js";
import type { Config } from "./config.js";
import type { DatabasePool } from "./database.js";
import { requireStaffPermission } from "./routes-admin.js";

type ChargebackRow = {
  id: string;
  client_account_id: string;
  client_account_name: string;
  provider_installation_id: string;
  original_external_payment_id: string;
  external_chargeback_id: string;
  principal_minor: string;
  fee_minor: string;
  external_amount_minor: string;
  credit_recovered_minor: string;
  debt_minor: string;
  currency: string;
  occurred_at: Date;
  restricted_at: Date | null;
  restriction_active: boolean;
  semantic_replay_count: string;
};

type UnclaimedChargebackRow = {
  id: string;
  fund_receipt_id: string;
  client_account_id: string;
  client_account_name: string;
  provider_installation_id: string;
  original_external_payment_id: string;
  external_chargeback_id: string;
  external_amount_minor: string;
  currency: string;
  occurred_at: Date;
  semantic_replay_count: string;
};

function presentChargeback(row: ChargebackRow) {
  return {
    chargebackEffectId: row.id,
    clientAccountId: row.client_account_id,
    clientAccountName: row.client_account_name,
    providerInstallationId: row.provider_installation_id,
    originalExternalPaymentId: row.original_external_payment_id,
    externalChargebackId: row.external_chargeback_id,
    principalMinor: row.principal_minor,
    feeMinor: row.fee_minor,
    externalAmountMinor: row.external_amount_minor,
    creditRecoveredMinor: row.credit_recovered_minor,
    debtMinor: row.debt_minor,
    currency: row.currency,
    occurredAt: row.occurred_at.toISOString(),
    restrictedAt: row.restricted_at?.toISOString() ?? null,
    restrictionActive: row.restriction_active,
    semanticReplayCount: row.semantic_replay_count,
  };
}

function presentUnclaimedChargeback(row: UnclaimedChargebackRow) {
  return {
    unclaimedChargebackEffectId: row.id,
    fundReceiptId: row.fund_receipt_id,
    clientAccountId: row.client_account_id,
    clientAccountName: row.client_account_name,
    providerInstallationId: row.provider_installation_id,
    originalExternalPaymentId: row.original_external_payment_id,
    externalChargebackId: row.external_chargeback_id,
    externalAmountMinor: row.external_amount_minor,
    currency: row.currency,
    occurredAt: row.occurred_at.toISOString(),
    semanticReplayCount: row.semantic_replay_count,
  };
}

const chargebackSelect = `
  SELECT
    effect.id,
    effect.client_account_id,
    account.name AS client_account_name,
    effect.provider_installation_id,
    effect.original_external_payment_id,
    effect.external_chargeback_id,
    effect.principal_minor::text,
    effect.fee_minor::text,
    effect.external_amount_minor::text,
    effect.credit_recovered_minor::text,
    effect.debt_minor::text,
    effect.currency,
    effect.occurred_at,
    account.restricted_at,
    EXISTS (
      SELECT 1
      FROM client_account_restrictions restriction
      LEFT JOIN client_account_restriction_releases release
        ON release.restriction_id = restriction.id
      WHERE restriction.source_type = 'add_funds_chargeback_effect'
        AND restriction.source_id = effect.id
        AND release.id IS NULL
    ) AS restriction_active,
    (
      SELECT count(*)::text
      FROM add_funds_chargeback_replay_dispositions replay
      WHERE replay.canonical_effect_id = effect.id
    ) AS semantic_replay_count
  FROM add_funds_chargeback_effects effect
  JOIN client_accounts account ON account.id = effect.client_account_id
`;

export async function registerChargebackRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get("/api/v1/billing/chargeback-status", async (request) => {
    const user = await requireUser(request, pool, config);
    assertFinancialReadEligible(user);
    const [credit, debt, effects, holds, unclaimedEffects] = await Promise.all([
      pool.query<{ balance_minor: string }>(
        `SELECT COALESCE(sum(transaction.credit_minor - transaction.debit_minor), 0)::text
           AS balance_minor
         FROM credit_accounts account
         LEFT JOIN credit_transactions transaction
           ON transaction.credit_account_id = account.id
         WHERE account.client_account_id = $1 AND account.currency = 'USD'`,
        [user.clientAccountId],
      ),
      pool.query<{ balance_minor: string }>(
        `SELECT COALESCE(sum(transaction.debit_minor - transaction.credit_minor), 0)::text
           AS balance_minor
         FROM client_account_debt_accounts account
         LEFT JOIN client_account_debt_transactions transaction
           ON transaction.debt_account_id = account.id
         WHERE account.client_account_id = $1 AND account.currency = 'USD'`,
        [user.clientAccountId],
      ),
      pool.query<ChargebackRow>(
        `${chargebackSelect}
         WHERE effect.client_account_id = $1
         ORDER BY effect.occurred_at DESC, effect.id`,
        [user.clientAccountId],
      ),
      pool.query<{ id: string; reason: string; created_at: Date }>(
        `SELECT hold_record.id, hold_record.reason, hold_record.created_at
         FROM add_funds_chargeback_holds hold_record
         WHERE hold_record.client_account_id = $1
         ORDER BY hold_record.created_at DESC, hold_record.id`,
        [user.clientAccountId],
      ),
      pool.query<UnclaimedChargebackRow>(
        `SELECT
           effect.id,
           effect.fund_receipt_id,
           effect.client_account_id,
           account.name AS client_account_name,
           effect.provider_installation_id,
           effect.original_external_payment_id,
           effect.external_chargeback_id,
           effect.external_amount_minor::text,
           effect.currency,
           effect.occurred_at,
           (SELECT count(*)::text
              FROM add_funds_chargeback_replay_dispositions replay
             WHERE replay.canonical_unclaimed_effect_id = effect.id)
             AS semantic_replay_count
         FROM add_funds_unclaimed_chargeback_effects effect
         JOIN client_accounts account ON account.id = effect.client_account_id
         WHERE effect.client_account_id = $1
         ORDER BY effect.occurred_at DESC, effect.id`,
        [user.clientAccountId],
      ),
    ]);
    return {
      warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      clientAccountId: user.clientAccountId,
      restricted: Boolean(user.clientAccountRestrictedAt),
      creditBalanceMinor: credit.rows[0]?.balance_minor ?? "0",
      debtBalanceMinor: debt.rows[0]?.balance_minor ?? "0",
      chargebacks: effects.rows.map(presentChargeback),
      unclaimedChargebacks: unclaimedEffects.rows.map(presentUnclaimedChargeback),
      manualHolds: holds.rows.map((hold) => ({
        holdId: hold.id,
        reason: hold.reason,
        createdAt: hold.created_at.toISOString(),
      })),
    };
  });

  app.get("/api/v1/admin/add-funds-chargebacks", async (request) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "billing.chargeback_manage");
    const [effects, holds, unclaimedEffects] = await Promise.all([
      pool.query<ChargebackRow>(
        `${chargebackSelect}
         ORDER BY effect.occurred_at DESC, effect.id`,
      ),
      pool.query<{
        id: string;
        client_account_id: string | null;
        client_account_name: string | null;
        external_chargeback_id: string;
        original_external_payment_id: string;
        amount_minor: string;
        currency: string;
        reason: string;
        occurred_at: Date;
        created_at: Date;
      }>(
        `SELECT
           hold_record.id,
           hold_record.client_account_id,
           account.name AS client_account_name,
           fact.external_chargeback_id,
           fact.original_external_payment_id,
           fact.amount_minor::text,
           fact.currency,
           hold_record.reason,
           fact.occurred_at,
           hold_record.created_at
         FROM add_funds_chargeback_holds hold_record
         JOIN add_funds_chargeback_facts fact ON fact.id = hold_record.fact_id
         LEFT JOIN client_accounts account ON account.id = hold_record.client_account_id
         ORDER BY hold_record.created_at DESC, hold_record.id`,
      ),
      pool.query<UnclaimedChargebackRow>(
        `SELECT
           effect.id,
           effect.fund_receipt_id,
           effect.client_account_id,
           account.name AS client_account_name,
           effect.provider_installation_id,
           effect.original_external_payment_id,
           effect.external_chargeback_id,
           effect.external_amount_minor::text,
           effect.currency,
           effect.occurred_at,
           (SELECT count(*)::text
              FROM add_funds_chargeback_replay_dispositions replay
             WHERE replay.canonical_unclaimed_effect_id = effect.id)
             AS semantic_replay_count
         FROM add_funds_unclaimed_chargeback_effects effect
         JOIN client_accounts account ON account.id = effect.client_account_id
         ORDER BY effect.occurred_at DESC, effect.id`,
      ),
    ]);
    return {
      warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      items: effects.rows.map(presentChargeback),
      unclaimedChargebacks: unclaimedEffects.rows.map(presentUnclaimedChargeback),
      manualHolds: holds.rows.map((hold) => ({
        holdId: hold.id,
        clientAccountId: hold.client_account_id,
        clientAccountName: hold.client_account_name,
        externalChargebackId: hold.external_chargeback_id,
        originalExternalPaymentId: hold.original_external_payment_id,
        amountMinor: hold.amount_minor,
        currency: hold.currency,
        reason: hold.reason,
        occurredAt: hold.occurred_at.toISOString(),
        createdAt: hold.created_at.toISOString(),
      })),
    };
  });
}
