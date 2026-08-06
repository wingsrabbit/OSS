// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { canTransitionPayment, type PaymentStatus } from "@opensales/core";
import { providerOperationCapabilityMatches } from "@opensales/core/provider-capability";
import type { Config } from "./config.js";
import type { DatabaseClient } from "./database.js";
import { settlePendingAddFundsChargebacks } from "./add-funds-chargeback.js";

export type AddFundsPaymentEvent = {
  eventId: string;
  providerOperationId: string;
  paymentAttemptId: string;
  callbackCapability: string;
  externalPaymentId: string;
  status: "processing" | "succeeded" | "failed" | "cancelled" | "expired";
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

async function recordUnclaimedJournal(
  client: DatabaseClient,
  receiptId: string,
  currency: string,
  receivedMinor: string,
): Promise<void> {
  const journal = await client.query<{ id: string }>(
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES ('fund_receipt', $1, $2, 'Unclaimed Add Funds receipt')
     RETURNING id`,
    [receiptId, currency],
  );
  const journalId = journal.rows[0]?.id;
  if (!journalId) throw new Error("Unable to create unclaimed Add Funds journal");
  await client.query(
    `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
     VALUES
       ($1, 'mock_cash', $2, 0),
       ($1, 'unclaimed_funds_liability', 0, $2)`,
    [journalId, receivedMinor],
  );
}

export async function handleAddFundsPaymentEvent(
  client: DatabaseClient,
  config: Config,
  body: AddFundsPaymentEvent,
): Promise<Record<string, unknown>> {
  // Worker preflight and Chargeback callbacks use this same operation-scoped
  // lock before taking Add Funds rows. Keeping payment settlement in that
  // order prevents an operation/attempt lock inversion during callback races.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `provider-operation:${body.providerOperationId}`,
  ]);
  const lockPointer = await client.query<{
    submitted_by_user_id: string;
    client_account_id: string;
  }>(
    `SELECT submitted_by_user_id, client_account_id
     FROM add_funds_attempts
     WHERE id = $1 AND provider_installation_id = $2
     FOR UPDATE`,
    [body.paymentAttemptId, PROVIDER_INSTALLATION_ID],
  );
  const pointer = lockPointer.rows[0];
  if (pointer) {
    await client.query(
      `SELECT id
       FROM add_funds_commands
       WHERE add_funds_attempt_id = $1
       FOR UPDATE`,
      [body.paymentAttemptId],
    );
    await client.query(
      `SELECT id
       FROM provider_operations
       WHERE id = $1
         AND subject_type = 'add_funds'
         AND subject_id = $2
         AND kind = 'payment_create'
         AND provider_installation_id = $3
       FOR UPDATE`,
      [body.providerOperationId, body.paymentAttemptId, PROVIDER_INSTALLATION_ID],
    );
    // Match invoice payment settlement: shared identity is always locked in
    // User -> Client Account -> Membership order before receipt FK writes.
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
      pointer.submitted_by_user_id,
    ]);
    await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
      pointer.client_account_id,
    ]);
  }
  const lockedMembership = pointer
    ? await client.query<{
        role: string;
        removed_at: Date | null;
      }>(
        `SELECT role, removed_at
         FROM client_memberships
         WHERE user_id = $1 AND client_account_id = $2
         FOR UPDATE`,
        [pointer.submitted_by_user_id, pointer.client_account_id],
      )
    : null;
  const attemptResult = await client.query<{
    id: string;
    operation_id: string;
    operation_attempt_count: number;
    client_account_id: string;
    submitted_by_user_id: string;
    command_id: string;
    command_status: string;
    status: PaymentStatus;
    amount_minor: string;
    principal_minor: string;
    fee_minor: string;
    currency: string;
    external_payment_id: string | null;
    provider_occurred_at: Date | null;
    expires_at: Date;
    email_verified_at: Date | null;
    user_restricted_at: Date | null;
    account_restricted_at: Date | null;
    membership_role: string | null;
    removed_at: Date | null;
    balance_cap_minor: string;
    policy_enabled: boolean;
    has_prior_receipt: boolean;
  }>(
    `SELECT
       afa.id, po.id AS operation_id, po.attempt_count AS operation_attempt_count,
       afa.client_account_id, afa.submitted_by_user_id,
       afc.id AS command_id, afc.status AS command_status,
       afa.status, afa.amount_minor::text,
       afa.principal_minor::text, afa.fee_minor::text, afa.currency,
       afa.external_payment_id, afa.provider_occurred_at, afa.expires_at,
       u.email_verified_at, u.restricted_at AS user_restricted_at,
       ca.restricted_at AS account_restricted_at,
       cm.role AS membership_role, cm.removed_at,
       afp.balance_cap_minor::text, afp.enabled AS policy_enabled,
       EXISTS (
         SELECT 1
         FROM fund_receipts prior_receipt
         WHERE prior_receipt.reported_add_funds_attempt_id = afa.id
       ) AS has_prior_receipt
     FROM add_funds_attempts afa
     JOIN add_funds_commands afc ON afc.add_funds_attempt_id = afa.id
     JOIN users u ON u.id = afa.submitted_by_user_id
     JOIN client_accounts ca ON ca.id = afa.client_account_id
     LEFT JOIN client_memberships cm
       ON cm.user_id = afa.submitted_by_user_id
      AND cm.client_account_id = afa.client_account_id
     JOIN add_funds_policies afp ON afp.currency = afa.currency
     JOIN provider_operations po
       ON po.id = $3
      AND po.subject_type = 'add_funds'
      AND po.subject_id = afa.id
      AND po.kind = 'payment_create'
      AND po.provider_installation_id = $2
     WHERE afa.id = $1
       AND afa.provider_installation_id = $2
     FOR SHARE OF afp`,
    [body.paymentAttemptId, PROVIDER_INSTALLATION_ID, body.providerOperationId],
  );
  const attempt = attemptResult.rows[0];
  if (!attempt) {
    await audit(
      client,
      "add_funds.event_rejected",
      "add_funds_attempt",
      body.paymentAttemptId,
      "attempt and operation are not owned by the authenticated Provider installation",
      { eventId: body.eventId, providerOperationId: body.providerOperationId },
    );
    return { rejected: true, reason: "provider_ownership_mismatch" };
  }
  if (
    !providerOperationCapabilityMatches(
      body.callbackCapability,
      config.PROVIDER_OPERATION_CAPABILITY_SECRET,
      PROVIDER_INSTALLATION_ID,
      attempt.operation_id,
    )
  ) {
    await audit(
      client,
      "add_funds.event_rejected",
      "add_funds_attempt",
      attempt.id,
      "callback capability is invalid for the Add Funds Provider operation",
      { eventId: body.eventId, providerOperationId: attempt.operation_id },
    );
    return { rejected: true, reason: "invalid_operation_capability" };
  }
  if (attempt.operation_attempt_count === 0) {
    await audit(
      client,
      "add_funds.event_rejected",
      "add_funds_attempt",
      attempt.id,
      "Provider reported Add Funds before Core sent the operation",
      { eventId: body.eventId, providerOperationId: attempt.operation_id },
    );
    return { rejected: true, reason: "provider_operation_not_started" };
  }
  const membership = lockedMembership?.rows[0];

  const storedPayload = { ...body, callbackCapability: "[REDACTED]" };
  const inbox = await client.query(
    `INSERT INTO provider_inbox(
       provider_installation_id, external_event_id, event_type, payload
     ) VALUES ($1, $2, 'add_funds.payment_status', $3)
     ON CONFLICT (provider_installation_id, external_event_id) DO NOTHING
     RETURNING id`,
    [
      PROVIDER_INSTALLATION_ID,
      body.eventId,
      storedPayload,
    ],
  );
  if (inbox.rowCount !== 1) {
    const existing = await client.query<{ exact_match: boolean }>(
      `SELECT (event_type = 'add_funds.payment_status' AND payload = $3::jsonb) AS exact_match
       FROM provider_inbox
       WHERE provider_installation_id = $1 AND external_event_id = $2
       FOR UPDATE`,
      [PROVIDER_INSTALLATION_ID, body.eventId, JSON.stringify(storedPayload)],
    );
    if (existing.rows[0]?.exact_match) return { duplicate: true };
    await audit(
      client,
      "add_funds.event_id_conflict",
      "add_funds_attempt",
      attempt.id,
      "Provider reused an Add Funds event id with a different event type or payload",
      {
        eventId: body.eventId,
        providerOperationId: attempt.operation_id,
        externalPaymentId: body.externalPaymentId,
      },
    );
    return { rejected: true, reason: "event_id_conflict" };
  }

  const externalOwner = await client.query<{ subject_type: string; subject_id: string }>(
    `SELECT subject_type, subject_id
     FROM (
       SELECT 'invoice_payment'::text AS subject_type, id AS subject_id
       FROM payment_attempts
       WHERE provider_installation_id = $1 AND external_payment_id = $2
       UNION ALL
       SELECT 'add_funds'::text, id
       FROM add_funds_attempts
       WHERE provider_installation_id = $1
         AND external_payment_id = $2
         AND id <> $3
     ) owners
     LIMIT 1`,
    [PROVIDER_INSTALLATION_ID, body.externalPaymentId, attempt.id],
  );
  if (externalOwner.rows[0]) {
    await audit(
      client,
      "add_funds.external_id_conflict",
      "add_funds_attempt",
      attempt.id,
      "external payment id is already bound to another Core attempt",
      { externalPaymentId: body.externalPaymentId, owner: externalOwner.rows[0] },
    );
    return { rejected: true, reason: "external_payment_conflict" };
  }

  const occurredAt = new Date(body.occurredAt);
  if (body.status !== "succeeded") {
    if (attempt.command_status === "manual" || attempt.has_prior_receipt) {
      return { ignored: true, reason: "funds_receipt_requires_manual_review" };
    }
    if (
      attempt.provider_occurred_at &&
      occurredAt.getTime() <= attempt.provider_occurred_at.getTime()
    ) {
      return { ignored: true, reason: "stale_provider_fact" };
    }
    if (!canTransitionPayment(attempt.status, body.status)) {
      return { ignored: true, reason: "stale_or_backward_transition" };
    }
    await client.query(
      `UPDATE add_funds_attempts
       SET status = $2, external_payment_id = COALESCE(external_payment_id, $3),
           provider_occurred_at = $4, updated_at = now(), version = version + 1
       WHERE id = $1`,
      [attempt.id, body.status, body.externalPaymentId, occurredAt],
    );
    await client.query(
      `UPDATE provider_operations
       SET status = $2, external_reference = COALESCE(external_reference, $3),
           provider_occurred_at = $4, updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
      [
        attempt.operation_id,
        body.status === "processing" ? "running" : "failed",
        body.externalPaymentId,
        occurredAt,
      ],
    );
    await client.query(
      `UPDATE add_funds_commands
       SET status = $2, result = $3, updated_at = now()
       WHERE id = $1 AND status <> 'succeeded'`,
      [
        attempt.command_id,
        body.status === "processing" ? "processing" : body.status,
        { paymentStatus: body.status },
      ],
    );
    if (body.status !== "processing") {
      await settlePendingAddFundsChargebacks(client, attempt.id);
    }
    return { accepted: true, status: body.status };
  }

  const receiptInsert = await client.query<{ id: string }>(
    `INSERT INTO fund_receipts(
       provider_installation_id, external_payment_id,
       reported_payment_attempt_id, reported_add_funds_attempt_id,
       client_account_id, amount_minor, currency, occurred_at, disposition
     ) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, 'received')
     ON CONFLICT (provider_installation_id, external_payment_id) DO NOTHING
     RETURNING id`,
    [
      PROVIDER_INSTALLATION_ID,
      body.externalPaymentId,
      attempt.id,
      attempt.client_account_id,
      body.amountMinor,
      body.currency,
      occurredAt,
    ],
  );
  let receiptId = receiptInsert.rows[0]?.id;
  if (!receiptId) {
    const existing = await client.query<{
      id: string;
      reported_add_funds_attempt_id: string | null;
      client_account_id: string;
      amount_minor: string;
      currency: string;
    }>(
      `SELECT id, reported_add_funds_attempt_id, client_account_id,
              amount_minor::text, currency
       FROM fund_receipts
       WHERE provider_installation_id = $1 AND external_payment_id = $2
       FOR UPDATE`,
      [PROVIDER_INSTALLATION_ID, body.externalPaymentId],
    );
    const row = existing.rows[0];
    if (
      !row ||
      row.reported_add_funds_attempt_id !== attempt.id ||
      row.client_account_id !== attempt.client_account_id ||
      row.amount_minor !== body.amountMinor ||
      row.currency !== body.currency
    ) {
      await audit(
        client,
        "add_funds.receipt_conflict",
        "add_funds_attempt",
        attempt.id,
        "Provider reused an external payment id with conflicting funds facts",
        { eventId: body.eventId, externalPaymentId: body.externalPaymentId },
      );
      return { rejected: true, reason: "receipt_fact_conflict" };
    }
    return { duplicate: true, reason: "settlement_already_recorded", receiptId: row.id };
  }

  const terminalBeforeSuccess = ["failed", "cancelled", "expired", "succeeded"].includes(
    attempt.status,
  );
  const expiredAtProviderOccurrence = occurredAt.getTime() >= attempt.expires_at.getTime();
  const snapshotMatches =
    attempt.amount_minor === body.amountMinor && attempt.currency === body.currency;
  const eligible =
    Boolean(attempt.email_verified_at) &&
    !attempt.user_restricted_at &&
    !attempt.account_restricted_at &&
    membership?.removed_at === null &&
    (membership?.role === "owner" || membership?.role === "billing");

  await client.query(
    `INSERT INTO credit_accounts(client_account_id, currency)
     VALUES ($1, $2)
     ON CONFLICT (client_account_id, currency) DO NOTHING`,
    [attempt.client_account_id, attempt.currency],
  );
  const creditAccount = await client.query<{ id: string }>(
    `SELECT id
     FROM credit_accounts
     WHERE client_account_id = $1 AND currency = $2
     FOR UPDATE`,
    [attempt.client_account_id, attempt.currency],
  );
  const credit = creditAccount.rows[0];
  if (!credit) throw new Error("Unable to lock Add Funds Credit account");
  const balanceResult = await client.query<{ balance_minor: string }>(
    `SELECT COALESCE(sum(credit_minor - debit_minor), 0)::text AS balance_minor
     FROM credit_transactions
     WHERE credit_account_id = $1`,
    [credit.id],
  );
  const balanceMinor = balanceResult.rows[0]?.balance_minor ?? "0";
  const capacityAllows =
    BigInt(balanceMinor) + BigInt(attempt.principal_minor) <=
    BigInt(attempt.balance_cap_minor);

  if (
    terminalBeforeSuccess ||
    attempt.command_status === "manual" ||
    attempt.has_prior_receipt ||
    expiredAtProviderOccurrence ||
    !snapshotMatches ||
    !eligible ||
    !attempt.policy_enabled ||
    !capacityAllows
  ) {
    const reason =
      attempt.status === "succeeded"
        ? "additional settlement arrived after Add Funds was already credited"
      : attempt.command_status === "manual" || attempt.has_prior_receipt
        ? "additional settlement arrived while previous funds require manual review"
        : terminalBeforeSuccess
      ? `settlement arrived after Add Funds became ${attempt.status}`
      : expiredAtProviderOccurrence
        ? "settlement occurred after the Add Funds attempt expired"
      : !snapshotMatches
        ? "Provider amount or currency does not match the Add Funds snapshot"
        : !eligible
          ? "customer eligibility was revoked before Add Funds settlement"
          : !attempt.policy_enabled
            ? "Add Funds policy was paused before settlement"
          : "Credit balance cap would be exceeded";
    await client.query(
      `UPDATE fund_receipts
       SET disposition = 'unclaimed', reason = $2, updated_at = now()
       WHERE id = $1`,
      [receiptId, reason],
    );
    await recordUnclaimedJournal(client, receiptId, body.currency, body.amountMinor);
    if (!terminalBeforeSuccess) {
      await client.query(
        `UPDATE add_funds_attempts
         SET status = 'unknown', external_payment_id = $2, provider_occurred_at = $3,
             updated_at = now(), version = version + 1
         WHERE id = $1 AND status NOT IN ('succeeded', 'failed', 'cancelled', 'expired')`,
        [attempt.id, body.externalPaymentId, occurredAt],
      );
    }
    await client.query(
      `UPDATE provider_operations
       SET status = 'unknown', external_reference = COALESCE(external_reference, $2),
           provider_occurred_at = $3, last_error = $4, updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
      [attempt.operation_id, body.externalPaymentId, occurredAt, reason],
    );
    await client.query(
      `UPDATE add_funds_commands
       SET status = 'manual', result = $2, updated_at = now()
       WHERE id = $1 AND status <> 'succeeded'`,
      [
        attempt.command_id,
        { paymentStatus: "unknown", receiptId, reason },
      ],
    );
    await audit(
      client,
      "add_funds.settlement_unclaimed",
      "fund_receipt",
      receiptId,
      reason,
      {
        addFundsAttemptId: attempt.id,
        expectedAmountMinor: attempt.amount_minor,
        receivedAmountMinor: body.amountMinor,
        expectedCurrency: attempt.currency,
        receivedCurrency: body.currency,
      },
    );
    await settlePendingAddFundsChargebacks(client, attempt.id);
    return { accepted: true, status: "unclaimed", receiptId };
  }

  const creditTransactionId = randomUUID();
  const settlement = await client.query<{ id: string }>(
    `INSERT INTO add_funds_settlements(
       command_id, add_funds_attempt_id, fund_receipt_id,
       principal_minor, fee_minor, currency
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      attempt.command_id,
      attempt.id,
      receiptId,
      attempt.principal_minor,
      attempt.fee_minor,
      attempt.currency,
    ],
  );
  const settlementId = settlement.rows[0]?.id;
  if (!settlementId) throw new Error("Unable to create Add Funds settlement");
  await client.query(
    `INSERT INTO credit_transactions(
       id, credit_account_id, kind, credit_minor, debit_minor,
       source_type, source_id, actor_type, actor_id, reason,
       idempotency_key, request_fingerprint, result
     ) VALUES (
       $1, $2, 'add_funds', $3, 0,
       'add_funds_settlement', $4, 'provider', NULL,
       'Settled Mock Add Funds principal', $5, $6, $7
     )`,
    [
      creditTransactionId,
      credit.id,
      attempt.principal_minor,
      settlementId,
      `add-funds-settlement:${settlementId}`,
      `add-funds-settlement:v1:${attempt.id}:${receiptId}`,
      { receiptId, feeMinor: attempt.fee_minor },
    ],
  );
  await client.query(
    `UPDATE add_funds_settlements
     SET credit_transaction_id = $2
     WHERE id = $1`,
    [settlementId, creditTransactionId],
  );
  await client.query(
    `UPDATE fund_receipts
     SET allocated_minor = amount_minor, disposition = 'allocated',
         reason = NULL, updated_at = now()
     WHERE id = $1`,
    [receiptId],
  );
  const journal = await client.query<{ id: string }>(
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES ('add_funds_settlement', $1, $2, 'Mock Add Funds settled')
     RETURNING id`,
    [settlementId, attempt.currency],
  );
  const journalId = journal.rows[0]?.id;
  if (!journalId) throw new Error("Unable to create Add Funds settlement journal");
  await client.query(
    `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
     VALUES
       ($1, 'mock_cash', $2, 0),
       ($1, 'client_credit_liability', 0, $3)`,
    [journalId, body.amountMinor, attempt.principal_minor],
  );
  if (BigInt(attempt.fee_minor) > 0n) {
    await client.query(
      `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
       VALUES ($1, 'payment_fee_revenue', 0, $2)`,
      [journalId, attempt.fee_minor],
    );
  }
  await client.query(
    `UPDATE add_funds_attempts
     SET status = 'succeeded', external_payment_id = $2, provider_occurred_at = $3,
         updated_at = now(), version = version + 1
     WHERE id = $1`,
    [attempt.id, body.externalPaymentId, occurredAt],
  );
  await client.query(
    `UPDATE provider_operations
     SET status = 'succeeded', external_reference = $2, provider_occurred_at = $3,
         last_error = NULL, updated_at = now()
     WHERE id = $1`,
    [attempt.operation_id, body.externalPaymentId, occurredAt],
  );
  const result = {
    paymentStatus: "succeeded",
    receiptId,
    principalCreditedMinor: attempt.principal_minor,
    feeMinor: attempt.fee_minor,
    externalPaidMinor: body.amountMinor,
  };
  await client.query(
    `UPDATE add_funds_commands
     SET status = 'succeeded', result = $2, updated_at = now()
     WHERE id = $1`,
    [attempt.command_id, result],
  );
  await audit(
    client,
    "add_funds.settled",
    "add_funds_settlement",
    settlementId,
    "Mock Add Funds principal credited after verified settlement",
    result,
  );
  await settlePendingAddFundsChargebacks(client, attempt.id);
  return { accepted: true, status: "succeeded", ...result };
}
