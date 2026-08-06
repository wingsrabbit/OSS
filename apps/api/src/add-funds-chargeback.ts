// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { providerOperationCapabilityMatches } from "@opensales/core/provider-capability";
import type { Config } from "./config.js";
import type { DatabaseClient } from "./database.js";
import { requestFingerprint } from "./idempotency.js";
import { freezeRefundsForChargebackHold } from "./refund-safety.js";

export type AddFundsChargebackEvent = {
  eventId: string;
  providerOperationId: string;
  addFundsAttemptId: string;
  callbackCapability: string;
  originalExternalPaymentId: string;
  externalChargebackId: string;
  status: "succeeded";
  amountMinor: string;
  currency: string;
  occurredAt: string;
};

const PROVIDER_INSTALLATION_ID = "mock-payment-v1";

async function audit(
  client: DatabaseClient,
  action: string,
  targetType: string,
  targetId: string,
  reason: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events(
       actor_type, actor_id, action, target_type, target_id, reason, metadata
     ) VALUES ('provider', $1, $2, $3, $4, $5, $6)`,
    [PROVIDER_INSTALLATION_ID, action, targetType, targetId, reason, metadata],
  );
}

async function holdFact(
  client: DatabaseClient,
  factId: string,
  clientAccountId: string | null,
  reason: string,
  metadata: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await client.query(
    `INSERT INTO add_funds_chargeback_holds(fact_id, client_account_id, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (fact_id) DO NOTHING`,
    [factId, clientAccountId, reason],
  );
  const frozenRefundIds = await freezeRefundsForChargebackHold(client, {
    factId,
    reason: `Refund stopped because a matching Chargeback fact requires review: ${reason}`,
  });
  await audit(
    client,
    "add_funds.chargeback_held",
    "add_funds_chargeback_fact",
    factId,
    reason,
    { ...metadata, frozenRefundIds },
  );
  return { accepted: true, status: "manual", factId, reason, frozenRefundIds };
}

async function recordReplayDisposition(
  client: DatabaseClient,
  factId: string,
  canonicalEffectId: string | null,
  canonicalUnclaimedEffectId: string | null,
): Promise<Record<string, unknown>> {
  const replay = await client.query<{ id: string }>(
    `INSERT INTO add_funds_chargeback_replay_dispositions(
       fact_id, canonical_effect_id, canonical_unclaimed_effect_id, reason
     ) VALUES ($1, $2, $3, 'Exact semantic replay of an established Chargeback fact')
     RETURNING id`,
    [factId, canonicalEffectId, canonicalUnclaimedEffectId],
  );
  const replayDispositionId = replay.rows[0]?.id;
  if (!replayDispositionId) throw new Error("Unable to record Chargeback replay");
  await audit(
    client,
    "add_funds.chargeback_replayed",
    "add_funds_chargeback_fact",
    factId,
    "Provider sent an exact semantic replay with a distinct event id",
    { canonicalEffectId, canonicalUnclaimedEffectId, replayDispositionId },
  );
  return {
    duplicate: true,
    status: "succeeded",
    factId,
    replayDispositionId,
    chargebackEffectId: canonicalEffectId,
    unclaimedChargebackEffectId: canonicalUnclaimedEffectId,
  };
}

async function settleChargebackFact(
  client: DatabaseClient,
  factId: string,
): Promise<Record<string, unknown>> {
  const sourceResult = await client.query<{
    fact_id: string;
    provider_installation_id: string;
    provider_operation_id: string;
    add_funds_attempt_id: string;
    original_external_payment_id: string;
    external_chargeback_id: string;
    amount_minor: string;
    currency: string;
    occurred_at: Date;
    operation_created_at: Date;
    attempt_status: string;
    command_status: string;
    client_account_id: string;
    settlement_id: string | null;
    fund_receipt_id: string | null;
    principal_minor: string | null;
    fee_minor: string | null;
    settlement_currency: string | null;
    receipt_external_payment_id: string | null;
    receipt_amount_minor: string | null;
    receipt_currency: string | null;
    receipt_disposition: string | null;
    receipt_occurred_at: Date | null;
    credit_account_id: string | null;
  }>(
    `SELECT
       fact.id AS fact_id,
       fact.provider_installation_id,
       fact.provider_operation_id,
       fact.add_funds_attempt_id,
       fact.original_external_payment_id,
       fact.external_chargeback_id,
       fact.amount_minor::text,
       fact.currency,
       fact.occurred_at,
       operation.created_at AS operation_created_at,
       attempt.status AS attempt_status,
       command.status AS command_status,
       attempt.client_account_id,
       settlement.id AS settlement_id,
       receipt.id AS fund_receipt_id,
       settlement.principal_minor::text,
       settlement.fee_minor::text,
       settlement.currency AS settlement_currency,
       receipt.external_payment_id AS receipt_external_payment_id,
       receipt.amount_minor::text AS receipt_amount_minor,
       receipt.currency AS receipt_currency,
       receipt.disposition AS receipt_disposition,
       receipt.occurred_at AS receipt_occurred_at,
       credit_account.id AS credit_account_id
     FROM add_funds_chargeback_facts fact
     JOIN provider_operations operation ON operation.id = fact.provider_operation_id
     JOIN add_funds_attempts attempt ON attempt.id = fact.add_funds_attempt_id
     JOIN add_funds_commands command ON command.add_funds_attempt_id = attempt.id
     LEFT JOIN LATERAL (
       SELECT candidate.*
       FROM fund_receipts candidate
       WHERE candidate.reported_add_funds_attempt_id = attempt.id
       ORDER BY
         (candidate.external_payment_id = fact.original_external_payment_id) DESC,
         candidate.created_at,
         candidate.id
       LIMIT 1
     ) receipt ON true
     LEFT JOIN add_funds_settlements settlement
       ON settlement.add_funds_attempt_id = attempt.id
      AND settlement.fund_receipt_id = receipt.id
     LEFT JOIN credit_accounts credit_account
       ON credit_account.client_account_id = attempt.client_account_id
      AND credit_account.currency = settlement.currency
     WHERE fact.id = $1`,
    [factId],
  );
  const source = sourceResult.rows[0];
  if (!source) throw new Error("Chargeback fact source disappeared");

  const disposition = await client.query<{
    effect_id: string | null;
    unclaimed_effect_id: string | null;
    hold_id: string | null;
    hold_reason: string | null;
    replay_id: string | null;
    replay_effect_id: string | null;
    replay_unclaimed_effect_id: string | null;
  }>(
    `SELECT
       effect.id AS effect_id,
       unclaimed_effect.id AS unclaimed_effect_id,
       hold_record.id AS hold_id,
       hold_record.reason AS hold_reason,
       replay.id AS replay_id,
       replay.canonical_effect_id AS replay_effect_id,
       replay.canonical_unclaimed_effect_id AS replay_unclaimed_effect_id
     FROM add_funds_chargeback_facts fact
     LEFT JOIN add_funds_chargeback_effects effect ON effect.fact_id = fact.id
     LEFT JOIN add_funds_unclaimed_chargeback_effects unclaimed_effect
       ON unclaimed_effect.fact_id = fact.id
     LEFT JOIN add_funds_chargeback_holds hold_record ON hold_record.fact_id = fact.id
     LEFT JOIN add_funds_chargeback_replay_dispositions replay
       ON replay.fact_id = fact.id
     WHERE fact.id = $1
     FOR UPDATE OF fact`,
    [source.fact_id],
  );
  const existingDisposition = disposition.rows[0];
  if (existingDisposition?.hold_id) {
    return {
      accepted: true,
      status: "manual",
      factId: source.fact_id,
      reason: existingDisposition.hold_reason,
    };
  }
  if (existingDisposition?.replay_id) {
    return {
      duplicate: true,
      status: "succeeded",
      factId: source.fact_id,
      replayDispositionId: existingDisposition.replay_id,
      chargebackEffectId: existingDisposition.replay_effect_id,
      unclaimedChargebackEffectId: existingDisposition.replay_unclaimed_effect_id,
    };
  }
  if (existingDisposition?.effect_id || existingDisposition?.unclaimed_effect_id) {
    return {
      duplicate: true,
      status: "succeeded",
      factId: source.fact_id,
      chargebackEffectId: existingDisposition.effect_id,
      unclaimedChargebackEffectId: existingDisposition.unclaimed_effect_id,
    };
  }

  const priorIdentity = await client.query<{
    id: string;
    external_chargeback_id: string;
    provider_operation_id: string;
    add_funds_attempt_id: string;
    original_external_payment_id: string;
    amount_minor: string;
    currency: string;
    occurred_at: Date;
    effect_id: string | null;
    unclaimed_effect_id: string | null;
    hold_id: string | null;
    replay_effect_id: string | null;
    replay_unclaimed_effect_id: string | null;
  }>(
    `SELECT
       prior.id,
       prior.external_chargeback_id,
       prior.provider_operation_id,
       prior.add_funds_attempt_id,
       prior.original_external_payment_id,
       prior.amount_minor::text,
       prior.currency,
       prior.occurred_at,
       effect.id AS effect_id,
       unclaimed_effect.id AS unclaimed_effect_id,
       hold_record.id AS hold_id,
       replay.canonical_effect_id AS replay_effect_id,
       replay.canonical_unclaimed_effect_id AS replay_unclaimed_effect_id
     FROM add_funds_chargeback_facts prior
     LEFT JOIN add_funds_chargeback_effects effect ON effect.fact_id = prior.id
     LEFT JOIN add_funds_unclaimed_chargeback_effects unclaimed_effect
       ON unclaimed_effect.fact_id = prior.id
     LEFT JOIN add_funds_chargeback_holds hold_record ON hold_record.fact_id = prior.id
     LEFT JOIN add_funds_chargeback_replay_dispositions replay
       ON replay.fact_id = prior.id
     WHERE prior.provider_installation_id = $1
       AND prior.id <> $3
       AND (
         prior.external_chargeback_id = $2
         OR (
           prior.provider_operation_id = $4
           AND prior.add_funds_attempt_id = $5
           AND prior.original_external_payment_id = $6
           AND hold_record.id IS NOT NULL
         )
       )
     ORDER BY prior.created_at, prior.id
     FOR UPDATE OF prior`,
    [
      source.provider_installation_id,
      source.external_chargeback_id,
      source.fact_id,
      source.provider_operation_id,
      source.add_funds_attempt_id,
      source.original_external_payment_id,
    ],
  );
  for (const prior of priorIdentity.rows) {
    const exactSemanticIdentity =
      prior.provider_operation_id === source.provider_operation_id &&
      prior.add_funds_attempt_id === source.add_funds_attempt_id &&
      prior.external_chargeback_id === source.external_chargeback_id &&
      prior.original_external_payment_id === source.original_external_payment_id &&
      prior.amount_minor === source.amount_minor &&
      prior.currency === source.currency &&
      prior.occurred_at.getTime() === source.occurred_at.getTime();
    if (!exactSemanticIdentity || prior.hold_id) {
      return holdFact(
        client,
        source.fact_id,
        source.client_account_id,
        "Provider chargeback identity conflicts with an earlier authenticated fact",
        {
          conflictingFactId: prior.id,
          externalChargebackId: source.external_chargeback_id,
        },
      );
    }
    const canonicalEffectId = prior.effect_id ?? prior.replay_effect_id;
    const canonicalUnclaimedEffectId =
      prior.unclaimed_effect_id ?? prior.replay_unclaimed_effect_id;
    if (canonicalEffectId || canonicalUnclaimedEffectId) {
      return recordReplayDisposition(
        client,
        source.fact_id,
        canonicalEffectId,
        canonicalUnclaimedEffectId,
      );
    }
  }
  if (!source.settlement_id) {
    if (!source.fund_receipt_id) {
      if (
        ["failed", "cancelled", "expired"].includes(source.attempt_status) ||
        source.command_status === "manual"
      ) {
        const terminalState =
          source.command_status === "manual" ? "manual review" : source.attempt_status;
        return holdFact(
          client,
          source.fact_id,
          source.client_account_id,
          `Chargeback has no funds receipt after Add Funds entered ${terminalState}`,
          { externalChargebackId: source.external_chargeback_id },
        );
      }
      return { accepted: true, status: "pending_source", factId };
    }

    await client.query("SELECT id FROM fund_receipts WHERE id = $1 FOR UPDATE", [
      source.fund_receipt_id,
    ]);
    const lockedReceipt = await client.query<{
      external_payment_id: string;
      amount_minor: string;
      currency: string;
      occurred_at: Date;
      disposition: string;
      allocated_minor: string;
      reserved_refund_minor: string;
      confirmed_outflow_minor: string;
      capacity_frozen: boolean;
      available_minor: string;
    }>(
      `SELECT
         receipt.external_payment_id,
         receipt.amount_minor::text,
         receipt.currency,
         receipt.occurred_at,
         receipt.disposition,
         capacity.allocated_minor::text,
         capacity.reserved_refund_minor::text,
         capacity.confirmed_outflow_minor::text,
         capacity.capacity_frozen,
         capacity.available_minor::text
       FROM fund_receipts receipt
       JOIN unclaimed_fund_refund_capacity capacity
         ON capacity.fund_receipt_id = receipt.id
       WHERE receipt.id = $1`,
      [source.fund_receipt_id],
    );
    const receipt = lockedReceipt.rows[0];
    if (!receipt) throw new Error("Chargeback Fund Receipt disappeared");

    const unclaimedMismatch =
      source.original_external_payment_id !== receipt.external_payment_id
        ? "Chargeback original payment does not match the unclaimed Fund Receipt"
        : source.amount_minor !== receipt.amount_minor
          ? "Chargeback amount does not match the unclaimed Fund Receipt"
          : source.currency !== receipt.currency
            ? "Chargeback currency does not match the unclaimed Fund Receipt"
            : receipt.disposition !== "unclaimed"
              ? "Chargeback receipt is not available for unclaimed-funds reversal"
              : receipt.allocated_minor !== "0" ||
                  receipt.reserved_refund_minor !== "0" ||
                  receipt.confirmed_outflow_minor !== "0" ||
                  receipt.capacity_frozen ||
                  receipt.available_minor !== receipt.amount_minor
                ? "Chargeback conflicts with an allocation, refund, or unresolved receipt action"
              : source.occurred_at < receipt.occurred_at
                ? "Chargeback occurred before the unclaimed Fund Receipt"
                : source.occurred_at <
                      new Date(source.operation_created_at.getTime() - 60_000) ||
                    source.occurred_at > new Date(Date.now() + 5 * 60_000)
                  ? "Chargeback occurrence time is implausible"
                : null;
    if (unclaimedMismatch) {
      return holdFact(client, source.fact_id, source.client_account_id, unclaimedMismatch, {
        externalChargebackId: source.external_chargeback_id,
      });
    }

    const unclaimedEffectId = randomUUID();
    await client.query(
      `INSERT INTO add_funds_unclaimed_chargeback_effects(
         id, fact_id, fund_receipt_id, client_account_id,
         provider_installation_id, original_external_payment_id,
         external_chargeback_id, external_amount_minor, currency, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        unclaimedEffectId,
        source.fact_id,
        source.fund_receipt_id,
        source.client_account_id,
        source.provider_installation_id,
        source.original_external_payment_id,
        source.external_chargeback_id,
        source.amount_minor,
        source.currency,
        source.occurred_at,
      ],
    );
    const unclaimedJournal = await client.query<{ id: string }>(
      `INSERT INTO ledger_journals(source_type, source_id, currency, description)
       VALUES (
         'add_funds_unclaimed_chargeback_effect', $1, $2,
         'Chargeback reversed unclaimed Add Funds receipt'
       ) RETURNING id`,
      [unclaimedEffectId, source.currency],
    );
    const unclaimedJournalId = unclaimedJournal.rows[0]?.id;
    if (!unclaimedJournalId) throw new Error("Unable to journal unclaimed Chargeback");
    await client.query(
      `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
       VALUES
         ($1, 'unclaimed_funds_liability', $2, 0),
         ($1, 'mock_cash', 0, $2)`,
      [unclaimedJournalId, source.amount_minor],
    );
    await client.query(
      `UPDATE ledger_journals SET sealed_at = now() WHERE id = $1`,
      [unclaimedJournalId],
    );
    await client.query(
      `UPDATE fund_receipts
       SET disposition = 'charged_back',
           reason = 'Provider confirmed Chargeback of unclaimed Add Funds receipt',
           updated_at = now()
       WHERE id = $1`,
      [source.fund_receipt_id],
    );
    await audit(
      client,
      "add_funds.unclaimed_chargeback_settled",
      "add_funds_unclaimed_chargeback_effect",
      unclaimedEffectId,
      "Provider confirmed Chargeback of an unclaimed Add Funds receipt",
      {
        factId: source.fact_id,
        fundReceiptId: source.fund_receipt_id,
        clientAccountId: source.client_account_id,
        externalChargebackId: source.external_chargeback_id,
        externalAmountMinor: source.amount_minor,
      },
    );
    return {
      accepted: true,
      status: "succeeded",
      factId: source.fact_id,
      unclaimedChargebackEffectId: unclaimedEffectId,
    };
  }

  const existingEffect = await client.query<{
    id: string;
    fact_id: string;
    add_funds_settlement_id: string;
    external_chargeback_id: string;
    original_external_payment_id: string;
    external_amount_minor: string;
    currency: string;
    occurred_at: Date;
    credit_recovered_minor: string;
    debt_minor: string;
  }>(
    `SELECT id, fact_id, add_funds_settlement_id, external_chargeback_id,
            original_external_payment_id, external_amount_minor::text, currency,
            occurred_at, credit_recovered_minor::text, debt_minor::text
     FROM add_funds_chargeback_effects
     WHERE add_funds_settlement_id = $1
        OR (provider_installation_id = $2 AND external_chargeback_id = $3)
     FOR UPDATE`,
    [source.settlement_id, source.provider_installation_id, source.external_chargeback_id],
  );
  const existing = existingEffect.rows[0];
  if (existing) {
    const exactReplay =
      existing.add_funds_settlement_id === source.settlement_id &&
      existing.external_chargeback_id === source.external_chargeback_id &&
      existing.original_external_payment_id === source.original_external_payment_id &&
      existing.external_amount_minor === source.amount_minor &&
      existing.currency === source.currency &&
      existing.occurred_at.getTime() === source.occurred_at.getTime();
    if (exactReplay) {
      return recordReplayDisposition(client, source.fact_id, existing.id, null);
    }
    return holdFact(
      client,
      source.fact_id,
      source.client_account_id,
      "Provider chargeback identity conflicts with an established Chargeback effect",
      {
        existingChargebackEffectId: existing.id,
        externalChargebackId: source.external_chargeback_id,
      },
    );
  }

  const principalMinor = BigInt(source.principal_minor ?? "0");
  const feeMinor = BigInt(source.fee_minor ?? "0");
  const externalAmountMinor = principalMinor + feeMinor;
  const occurredAt = source.occurred_at;
  const mismatchReason =
    source.original_external_payment_id !== source.receipt_external_payment_id
      ? "Chargeback original payment does not match the immutable Fund Receipt"
      : source.amount_minor !== externalAmountMinor.toString()
        ? "Chargeback amount does not match the immutable Add Funds external amount"
        : source.currency !== source.settlement_currency
          ? "Chargeback currency does not match the immutable Add Funds currency"
          : source.receipt_disposition !== "allocated"
            ? "Chargeback source is not an allocated Add Funds receipt"
            : !source.receipt_occurred_at || occurredAt < source.receipt_occurred_at
              ? "Chargeback occurred before the original Add Funds receipt"
              : occurredAt < new Date(source.operation_created_at.getTime() - 60_000) ||
                  occurredAt > new Date(Date.now() + 5 * 60_000)
                ? "Chargeback occurrence time is implausible"
                : !source.credit_account_id
                  ? "Chargeback Credit account is unavailable"
                  : null;
  if (mismatchReason) {
    return holdFact(client, source.fact_id, source.client_account_id, mismatchReason, {
      externalChargebackId: source.external_chargeback_id,
      reportedAmountMinor: source.amount_minor,
      expectedAmountMinor: externalAmountMinor.toString(),
      reportedCurrency: source.currency,
      expectedCurrency: source.settlement_currency,
    });
  }

  await client.query("SELECT id FROM fund_receipts WHERE id = $1 FOR UPDATE", [
    source.fund_receipt_id,
  ]);
  await client.query("SELECT id FROM credit_accounts WHERE id = $1 FOR UPDATE", [
    source.credit_account_id,
  ]);
  const balanceResult = await client.query<{ balance_minor: string }>(
    `SELECT COALESCE(sum(credit_minor - debit_minor), 0)::text AS balance_minor
     FROM credit_transactions
     WHERE credit_account_id = $1`,
    [source.credit_account_id],
  );
  const availableCredit = BigInt(balanceResult.rows[0]?.balance_minor ?? "0");
  const creditRecoveredMinor =
    availableCredit < principalMinor ? availableCredit : principalMinor;
  const debtMinor = principalMinor - creditRecoveredMinor;
  const effectId = randomUUID();
  await client.query(
    `INSERT INTO add_funds_chargeback_effects(
       id, fact_id, add_funds_settlement_id, fund_receipt_id,
       client_account_id, credit_account_id, provider_installation_id,
       original_external_payment_id, external_chargeback_id,
       principal_minor, fee_minor, external_amount_minor,
       credit_recovered_minor, debt_minor, currency, occurred_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       $10, $11, $12, $13, $14, $15, $16
     )`,
    [
      effectId,
      source.fact_id,
      source.settlement_id,
      source.fund_receipt_id,
      source.client_account_id,
      source.credit_account_id,
      source.provider_installation_id,
      source.original_external_payment_id,
      source.external_chargeback_id,
      principalMinor.toString(),
      feeMinor.toString(),
      externalAmountMinor.toString(),
      creditRecoveredMinor.toString(),
      debtMinor.toString(),
      source.currency,
      occurredAt,
    ],
  );

  if (creditRecoveredMinor > 0n) {
    await client.query(
      `INSERT INTO credit_transactions(
         credit_account_id, kind, credit_minor, debit_minor,
         source_type, source_id, actor_type, actor_id, reason,
         idempotency_key, request_fingerprint, result
       ) VALUES (
         $1, 'chargeback', 0, $2,
         'add_funds_chargeback_effect', $3, 'provider', NULL,
         'Credit recovered after settled Add Funds Chargeback', $4, $5, $6
       )`,
      [
        source.credit_account_id,
        creditRecoveredMinor.toString(),
        effectId,
        `add-funds-chargeback:${effectId}`,
        requestFingerprint("add-funds-chargeback-credit:v1", {
          effectId,
          amountMinor: creditRecoveredMinor.toString(),
        }),
        { externalChargebackId: source.external_chargeback_id },
      ],
    );
  }

  if (debtMinor > 0n) {
    await client.query(
      `INSERT INTO client_account_debt_accounts(client_account_id, currency)
       VALUES ($1, $2)
       ON CONFLICT (client_account_id, currency) DO NOTHING`,
      [source.client_account_id, source.currency],
    );
    const debtAccount = await client.query<{ id: string }>(
      `SELECT id
       FROM client_account_debt_accounts
       WHERE client_account_id = $1 AND currency = $2
       FOR UPDATE`,
      [source.client_account_id, source.currency],
    );
    const debtAccountId = debtAccount.rows[0]?.id;
    if (!debtAccountId) throw new Error("Unable to lock Client Account debt");
    await client.query(
      `INSERT INTO client_account_debt_transactions(
         debt_account_id, kind, debit_minor, credit_minor,
         source_type, source_id, actor_type, actor_id, reason, idempotency_key
       ) VALUES (
         $1, 'chargeback', $2, 0,
         'add_funds_chargeback_effect', $3, 'provider', NULL,
         'Principal already consumed before Add Funds Chargeback', $4
       )`,
      [debtAccountId, debtMinor.toString(), effectId, `add-funds-chargeback:${effectId}`],
    );
    await client.query(
      `INSERT INTO client_account_restrictions(
         client_account_id, kind, source_type, source_id, reason
       ) VALUES (
         $1, 'financial_chargeback', 'add_funds_chargeback_effect', $2,
         'Outstanding debt after settled Add Funds Chargeback'
       )`,
      [source.client_account_id, effectId],
    );
  }

  const journal = await client.query<{ id: string }>(
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES (
       'add_funds_chargeback_effect', $1, $2,
       'Settled Mock Add Funds Chargeback'
     )
     RETURNING id`,
    [effectId, source.currency],
  );
  const journalId = journal.rows[0]?.id;
  if (!journalId) throw new Error("Unable to create Chargeback journal");
  if (creditRecoveredMinor > 0n) {
    await client.query(
      `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
       VALUES ($1, 'client_credit_liability', $2, 0)`,
      [journalId, creditRecoveredMinor.toString()],
    );
  }
  if (debtMinor > 0n) {
    await client.query(
      `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
       VALUES ($1, 'chargeback_receivable', $2, 0)`,
      [journalId, debtMinor.toString()],
    );
  }
  if (feeMinor > 0n) {
    await client.query(
      `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
       VALUES ($1, 'payment_fee_revenue', $2, 0)`,
      [journalId, feeMinor.toString()],
    );
  }
  await client.query(
    `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
     VALUES ($1, 'mock_cash', 0, $2)`,
    [journalId, externalAmountMinor.toString()],
  );
  await client.query(
    `UPDATE ledger_journals SET sealed_at = now() WHERE id = $1`,
    [journalId],
  );
  await audit(
    client,
    "add_funds.chargeback_settled",
    "add_funds_chargeback_effect",
    effectId,
    "Mock Provider confirmed a settled Add Funds Chargeback",
    {
      factId: source.fact_id,
      clientAccountId: source.client_account_id,
      externalPaymentId: source.original_external_payment_id,
      externalChargebackId: source.external_chargeback_id,
      externalAmountMinor: externalAmountMinor.toString(),
      creditRecoveredMinor: creditRecoveredMinor.toString(),
      debtMinor: debtMinor.toString(),
      restricted: debtMinor > 0n,
    },
  );
  return {
    accepted: true,
    status: "succeeded",
    factId: source.fact_id,
    chargebackEffectId: effectId,
    creditRecoveredMinor: creditRecoveredMinor.toString(),
    debtMinor: debtMinor.toString(),
    restricted: debtMinor > 0n,
  };
}

export async function handleAddFundsChargebackEvent(
  client: DatabaseClient,
  config: Config,
  body: AddFundsChargebackEvent,
): Promise<Record<string, unknown>> {
  for (const lock of [
    `provider-operation:${body.providerOperationId}`,
    `chargeback-external:${PROVIDER_INSTALLATION_ID}:${body.externalChargebackId}`,
  ].sort()) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lock]);
  }
  const operationResult = await client.query<{
    id: string;
    subject_id: string;
    attempt_count: number;
  }>(
    `SELECT id, subject_id, attempt_count
     FROM provider_operations
     WHERE id = $1
       AND provider_installation_id = $2
       AND subject_type = 'add_funds'
       AND kind = 'payment_create'
     FOR UPDATE`,
    [body.providerOperationId, PROVIDER_INSTALLATION_ID],
  );
  const operation = operationResult.rows[0];
  if (!operation) {
    await audit(
      client,
      "add_funds.chargeback_rejected",
      "provider_operation",
      body.providerOperationId,
      "Chargeback does not reference an owned Add Funds payment operation",
      { eventId: body.eventId, externalChargebackId: body.externalChargebackId },
    );
    return { rejected: true, reason: "provider_ownership_mismatch" };
  }
  if (
    !providerOperationCapabilityMatches(
      body.callbackCapability,
      config.PROVIDER_OPERATION_CAPABILITY_SECRET,
      PROVIDER_INSTALLATION_ID,
      operation.id,
    )
  ) {
    await audit(
      client,
      "add_funds.chargeback_rejected",
      "provider_operation",
      operation.id,
      "Chargeback callback capability is invalid for the original payment operation",
      { eventId: body.eventId, externalChargebackId: body.externalChargebackId },
    );
    return { rejected: true, reason: "invalid_operation_capability" };
  }
  if (operation.attempt_count === 0) {
    await audit(
      client,
      "add_funds.chargeback_rejected",
      "provider_operation",
      operation.id,
      "Chargeback arrived before Core sent the original payment operation",
      { eventId: body.eventId, externalChargebackId: body.externalChargebackId },
    );
    return { rejected: true, reason: "provider_operation_not_started" };
  }

  const attemptPointer = await client.query<{
    submitted_by_user_id: string;
    client_account_id: string;
  }>(
    `SELECT submitted_by_user_id, client_account_id
     FROM add_funds_attempts
     WHERE id = $1
     FOR UPDATE`,
    [operation.subject_id],
  );
  const pointer = attemptPointer.rows[0];
  if (!pointer) throw new Error("Chargeback operation lost its Add Funds attempt");
  await client.query(
    `SELECT id FROM add_funds_commands WHERE add_funds_attempt_id = $1 FOR UPDATE`,
    [operation.subject_id],
  );
  await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
    pointer.submitted_by_user_id,
  ]);
  await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
    pointer.client_account_id,
  ]);
  await client.query(
    `SELECT client_account_id
     FROM client_memberships
     WHERE user_id = $1 AND client_account_id = $2
     FOR UPDATE`,
    [pointer.submitted_by_user_id, pointer.client_account_id],
  );

  const storedPayload = { ...body, callbackCapability: "[REDACTED]" };
  const inbox = await client.query(
    `INSERT INTO provider_inbox(
       provider_installation_id, external_event_id, event_type, payload
     ) VALUES ($1, $2, 'add_funds.chargeback', $3)
     ON CONFLICT (provider_installation_id, external_event_id) DO NOTHING
     RETURNING id`,
    [PROVIDER_INSTALLATION_ID, body.eventId, storedPayload],
  );
  if (inbox.rowCount !== 1) {
    const existing = await client.query<{ exact_match: boolean }>(
      `SELECT (event_type = 'add_funds.chargeback' AND payload = $3::jsonb) AS exact_match
       FROM provider_inbox
       WHERE provider_installation_id = $1 AND external_event_id = $2
       FOR UPDATE`,
      [PROVIDER_INSTALLATION_ID, body.eventId, JSON.stringify(storedPayload)],
    );
    if (existing.rows[0]?.exact_match) return { duplicate: true };
    await audit(
      client,
      "add_funds.chargeback_event_id_conflict",
      "add_funds_attempt",
      operation.subject_id,
      "Provider reused a Chargeback event id with different facts",
      { eventId: body.eventId, externalChargebackId: body.externalChargebackId },
    );
    return { rejected: true, reason: "event_id_conflict" };
  }

  const factId = randomUUID();
  await client.query(
    `INSERT INTO add_funds_chargeback_facts(
       id, provider_installation_id, provider_operation_id,
       add_funds_attempt_id, external_event_id, original_external_payment_id,
       external_chargeback_id, status, amount_minor, currency,
       occurred_at, fact_fingerprint
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      factId,
      PROVIDER_INSTALLATION_ID,
      operation.id,
      operation.subject_id,
      body.eventId,
      body.originalExternalPaymentId,
      body.externalChargebackId,
      body.status,
      body.amountMinor,
      body.currency,
      new Date(body.occurredAt),
      requestFingerprint("add-funds-chargeback-fact:v1", {
        ...body,
        callbackCapability: "[REDACTED]",
      }),
    ],
  );
  if (body.addFundsAttemptId !== operation.subject_id) {
    return holdFact(
      client,
      factId,
      pointer.client_account_id,
      "Chargeback attempt identity does not match the scoped payment operation",
      {
        reportedAddFundsAttemptId: body.addFundsAttemptId,
        expectedAddFundsAttemptId: operation.subject_id,
      },
    );
  }
  return settleChargebackFact(client, factId);
}

export async function settlePendingAddFundsChargebacks(
  client: DatabaseClient,
  addFundsAttemptId: string,
): Promise<void> {
  const pending = await client.query<{ id: string }>(
    `SELECT fact.id
     FROM add_funds_chargeback_facts fact
     LEFT JOIN add_funds_chargeback_effects effect ON effect.fact_id = fact.id
     LEFT JOIN add_funds_unclaimed_chargeback_effects unclaimed_effect
       ON unclaimed_effect.fact_id = fact.id
     LEFT JOIN add_funds_chargeback_holds hold_record ON hold_record.fact_id = fact.id
     LEFT JOIN add_funds_chargeback_replay_dispositions replay
       ON replay.fact_id = fact.id
     WHERE fact.add_funds_attempt_id = $1
       AND effect.id IS NULL
       AND unclaimed_effect.id IS NULL
       AND hold_record.id IS NULL
       AND replay.id IS NULL
     ORDER BY fact.occurred_at, fact.created_at, fact.id
     FOR UPDATE OF fact`,
    [addFundsAttemptId],
  );
  for (const fact of pending.rows) {
    await settleChargebackFact(client, fact.id);
  }
}
