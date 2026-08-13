// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { buildApp } from "./app.js";
import { digestToken } from "./auth.js";
import type { Config } from "./config.js";
import {
  assertSchemaCompatible,
  REQUIRED_SCHEMA_VERSION,
  runMigrations,
} from "./database.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for manual receipt integration");

const namespace = randomUUID();
const userId = randomUUID();
const staffAccountId = randomUUID();
const targetAccountId = randomUUID();
const sessionId = randomUUID();
const sessionToken = randomBytes(32).toString("base64url");
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 8,
  options: "-c search_path=pg_catalog,public",
  statement_timeout: 15_000,
  application_name: "opensales-manual-receipts-integration",
});
const config: Config = {
  DATABASE_URL: databaseUrl,
  OSS_ENV: "test",
  OSS_LOG_LEVEL: "silent",
  OSS_PUBLIC_URL: "http://127.0.0.1:3000",
  API_HOST: "127.0.0.1",
  API_PORT: 3000,
  GLOBAL_RATE_LIMIT_MAX: 1_000,
  SESSION_COOKIE_NAME: "oss_session",
  SESSION_TTL_HOURS: 24,
  VERIFICATION_TTL_MINUTES: 30,
  WEB_ORIGIN: "http://127.0.0.1:5173",
  MOCK_MAILBOX_URL: "http://127.0.0.1:4000",
  LAB_MAILBOX_TOKEN: "synthetic-manual-receipt-mail-token",
  PROVIDER_OPERATION_CAPABILITY_SECRET:
    "synthetic-manual-receipt-capability-secret",
  PAYMENT_METHOD_TOKEN_KEY: Buffer.alloc(32, 41).toString("base64url"),
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY: Buffer.alloc(32, 42).toString("base64url"),
  IDENTITY_SECRET_KEY: Buffer.alloc(32, 43).toString("base64url"),
  MOCK_PAYMENT_WEBHOOK_SECRET: "synthetic-manual-receipt-payment-hook",
  MOCK_PROVISIONING_WEBHOOK_SECRET:
    "synthetic-manual-receipt-provision-hook",
  LAB_MAILBOX_ENABLED: false,
};

function responseJson<T>(response: Readonly<{ body: string }>): T {
  return JSON.parse(response.body) as T;
}

let app: Awaited<ReturnType<typeof buildApp>>["app"] | null = null;
try {
  await runMigrations(pool);
  const schema = await assertSchemaCompatible(pool);
  assert.equal(schema.installedSchemaVersion, REQUIRED_SCHEMA_VERSION);
  assert.equal(schema.mode, "native");

  await pool.query(
    `INSERT INTO users(id, email, password_hash, email_verified_at)
     VALUES ($1, $2, 'synthetic-not-a-password', now())`,
    [userId, `manual-receipt-${namespace}@example.invalid`],
  );
  const accountSetup = await pool.connect();
  try {
    await accountSetup.query("BEGIN");
    await accountSetup.query(
      `INSERT INTO client_accounts(id, name, owner_user_id)
       VALUES
         ($1, 'Synthetic staff account', $3),
         ($2, 'Synthetic manual receipt target', $3)`,
      [staffAccountId, targetAccountId, userId],
    );
    await accountSetup.query(
      `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
       VALUES
         ($1, $3, 'owner', '[]'::jsonb),
         ($2, $3, 'owner', '[]'::jsonb)`,
      [staffAccountId, targetAccountId, userId],
    );
    await accountSetup.query("COMMIT");
  } catch (error) {
    await accountSetup.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    accountSetup.release();
  }
  await pool.query(
    `INSERT INTO sessions(id, user_id, token_digest, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 hour')`,
    [sessionId, userId, digestToken(sessionToken)],
  );
  await pool.query(
    `INSERT INTO staff_members(user_id, roles, permissions)
     VALUES ($1, ARRAY['Billing'], '["billing.manual_receipt_manage"]'::jsonb)`,
    [userId],
  );
  const baseline = await pool.query<{
    invoices: string;
    services: string;
    credit_transactions: string;
    provider_operations: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM invoices) AS invoices,
       (SELECT count(*)::text FROM services) AS services,
       (SELECT count(*)::text FROM credit_transactions) AS credit_transactions,
       (SELECT count(*)::text FROM provider_operations) AS provider_operations`,
  );

  ({ app } = await buildApp(config, pool));
  await app.ready();
  const cookie = `oss_session=${sessionToken}`;
  const url = `/api/v1/admin/client-accounts/${targetAccountId}/manual-receipts`;
  const receivedAt = new Date(Date.now() - 60_000).toISOString();
  const firstBody = {
    reference: `WIRE-${namespace}`,
    receivedAt,
    grossAmountMinor: "10000",
    feeMinor: "350",
    currency: "USD",
    reason: "Synthetic bank receipt independently confirmed by billing staff",
    idempotencyKey: `manual-${namespace}`,
  };

  const withoutReauth = await app.inject({
    method: "POST",
    url,
    headers: { cookie },
    payload: firstBody,
  });
  assert.equal(withoutReauth.statusCode, 403);
  assert.equal(responseJson<{ code: string }>(withoutReauth).code, "REAUTH_REQUIRED");

  await pool.query(
    `INSERT INTO reauth_grants(user_id, session_id, expires_at)
     VALUES ($1, $2, now() + interval '15 minutes')`,
    [userId, sessionId],
  );
  const created = await app.inject({
    method: "POST",
    url,
    headers: { cookie },
    payload: firstBody,
  });
  assert.equal(created.statusCode, 201, created.body);
  const first = responseJson<{
    manualReceiptId: string;
    fundReceiptId: string;
    grossAmountMinor: string;
    feeMinor: string;
    netAmountMinor: string;
    disposition: string;
    allocatedMinor: string;
    providerUsed: boolean;
    replayed: boolean;
  }>(created);
  assert.deepEqual(
    {
      grossAmountMinor: first.grossAmountMinor,
      feeMinor: first.feeMinor,
      netAmountMinor: first.netAmountMinor,
      disposition: first.disposition,
      allocatedMinor: first.allocatedMinor,
      providerUsed: first.providerUsed,
      replayed: first.replayed,
    },
    {
      grossAmountMinor: "10000",
      feeMinor: "350",
      netAmountMinor: "9650",
      disposition: "unclaimed",
      allocatedMinor: "0",
      providerUsed: false,
      replayed: false,
    },
  );

  const financial = await pool.query<{
    fact_count: string;
    fund_count: string;
    provider_installation_id: string | null;
    external_payment_id: string | null;
    reported_payment_attempt_id: string | null;
    reported_add_funds_attempt_id: string | null;
    disposition: string;
    debit_minor: string;
    credit_minor: string;
    cash_debit: string;
    fee_debit: string;
    liability_credit: string;
    sealed: boolean;
    audit_count: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM manual_receipt_facts WHERE id = $1) AS fact_count,
       (SELECT count(*)::text FROM fund_receipts WHERE id = $2) AS fund_count,
       receipt.provider_installation_id,
       receipt.external_payment_id,
       receipt.reported_payment_attempt_id,
       receipt.reported_add_funds_attempt_id,
       receipt.disposition,
       sum(line.debit_minor)::text AS debit_minor,
       sum(line.credit_minor)::text AS credit_minor,
       COALESCE(sum(line.debit_minor) FILTER (
         WHERE line.account_code = 'cash_clearing'), 0)::text AS cash_debit,
       COALESCE(sum(line.debit_minor) FILTER (
         WHERE line.account_code = 'payment_processing_expense'), 0)::text AS fee_debit,
       COALESCE(sum(line.credit_minor) FILTER (
         WHERE line.account_code = 'unclaimed_funds_liability'), 0)::text
           AS liability_credit,
       journal.sealed_at IS NOT NULL AS sealed,
       (SELECT count(*)::text FROM audit_events
        WHERE action = 'billing.manual_receipt_recorded' AND target_id = $1::text)
         AS audit_count
     FROM fund_receipts receipt
     JOIN ledger_journals journal
       ON journal.source_type = 'manual_receipt'
      AND journal.source_id = receipt.reported_manual_receipt_id
     JOIN ledger_lines line ON line.journal_id = journal.id
     WHERE receipt.id = $2
     GROUP BY receipt.id, journal.id`,
    [first.manualReceiptId, first.fundReceiptId],
  );
  assert.deepEqual(financial.rows[0], {
    fact_count: "1",
    fund_count: "1",
    provider_installation_id: null,
    external_payment_id: null,
    reported_payment_attempt_id: null,
    reported_add_funds_attempt_id: null,
    disposition: "unclaimed",
    debit_minor: "10000",
    credit_minor: "10000",
    cash_debit: "9650",
    fee_debit: "350",
    liability_credit: "10000",
    sealed: true,
    audit_count: "1",
  });
  const sealedJournal = await pool.query<{ id: string }>(
    `SELECT id
     FROM ledger_journals
     WHERE source_type = 'manual_receipt' AND source_id = $1`,
    [first.manualReceiptId],
  );
  assert.ok(sealedJournal.rows[0]?.id);
  await assert.rejects(
    pool.query(
      "UPDATE ledger_journals SET sealed_at = NULL WHERE id = $1",
      [sealedJournal.rows[0].id],
    ),
    /ledger records are append-only/,
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
       VALUES
         ($1, 'cash_clearing', 1, 0),
         ($1, 'unclaimed_funds_liability', 0, 1)`,
      [sealedJournal.rows[0].id],
    ),
    /Sealed manual receipt journal lines cannot be changed/,
  );

  const replayed = await app.inject({
    method: "POST",
    url,
    headers: { cookie },
    payload: firstBody,
  });
  assert.equal(replayed.statusCode, 200, replayed.body);
  assert.equal(
    responseJson<{ manualReceiptId: string }>(replayed).manualReceiptId,
    first.manualReceiptId,
  );
  assert.equal(responseJson<{ replayed: boolean }>(replayed).replayed, true);

  const idempotencyConflict = await app.inject({
    method: "POST",
    url,
    headers: { cookie },
    payload: { ...firstBody, grossAmountMinor: "10001" },
  });
  assert.equal(idempotencyConflict.statusCode, 409);
  assert.equal(
    responseJson<{ code: string }>(idempotencyConflict).code,
    "IDEMPOTENCY_CONFLICT",
  );

  const referenceConflict = await app.inject({
    method: "POST",
    url,
    headers: { cookie },
    payload: { ...firstBody, idempotencyKey: `reference-${namespace}` },
  });
  assert.equal(referenceConflict.statusCode, 409);
  assert.equal(
    responseJson<{ code: string }>(referenceConflict).code,
    "MANUAL_RECEIPT_REFERENCE_CONFLICT",
  );

  const concurrentReference = `CONCURRENT-${namespace}`;
  const concurrentBody = {
    ...firstBody,
    reference: concurrentReference,
    feeMinor: "0",
  };
  const concurrent = await Promise.all([
    app.inject({
      method: "POST",
      url,
      headers: { cookie },
      payload: { ...concurrentBody, idempotencyKey: `concurrent-a-${namespace}` },
    }),
    app.inject({
      method: "POST",
      url,
      headers: { cookie },
      payload: { ...concurrentBody, idempotencyKey: `concurrent-b-${namespace}` },
    }),
  ]);
  assert.deepEqual(
    concurrent.map((response) => response.statusCode).sort(),
    [201, 409],
  );
  const concurrentCount = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM manual_receipt_facts
     WHERE client_account_id = $1 AND reference = $2`,
    [targetAccountId, concurrentReference],
  );
  assert.equal(concurrentCount.rows[0]?.count, "1");

  const fullFeeBody = {
    ...firstBody,
    reference: `FULL-FEE-${namespace}`,
    grossAmountMinor: "250",
    feeMinor: "250",
    idempotencyKey: `full-fee-${namespace}`,
  };
  const fullFee = await app.inject({
    method: "POST",
    url,
    headers: { cookie },
    payload: fullFeeBody,
  });
  assert.equal(fullFee.statusCode, 201, fullFee.body);
  const fullFeeResult = responseJson<{
    manualReceiptId: string;
    fundReceiptId: string;
    grossAmountMinor: string;
    feeMinor: string;
    netAmountMinor: string;
  }>(fullFee);
  assert.equal(fullFeeResult.netAmountMinor, "0");

  const reversalUrl = `${url}/${fullFeeResult.manualReceiptId}/reversal`;
  const reversalBody = {
    expectedFundReceiptId: fullFeeResult.fundReceiptId,
    expectedGrossAmountMinor: fullFeeResult.grossAmountMinor,
    reason: "Synthetic billing review confirms this untouched receipt was entered by mistake",
    idempotencyKey: `reversal-${namespace}`,
  };
  const reversalWithoutFundsPermission = await app.inject({
    method: "POST",
    url: reversalUrl,
    headers: { cookie },
    payload: reversalBody,
  });
  assert.equal(reversalWithoutFundsPermission.statusCode, 403);
  await pool.query(
    `UPDATE staff_members
     SET permissions = '["billing.manual_receipt_manage", "billing.unclaimed_manage"]'::jsonb,
         updated_at = now()
     WHERE user_id = $1`,
    [userId],
  );
  await pool.query(
    `UPDATE reauth_grants
     SET invalidated_at = now()
     WHERE user_id = $1 AND session_id = $2 AND invalidated_at IS NULL`,
    [userId, sessionId],
  );
  const reversalWithoutReauth = await app.inject({
    method: "POST",
    url: reversalUrl,
    headers: { cookie },
    payload: reversalBody,
  });
  assert.equal(reversalWithoutReauth.statusCode, 403);
  assert.equal(
    responseJson<{ code: string }>(reversalWithoutReauth).code,
    "REAUTH_REQUIRED",
  );
  await pool.query(
    `INSERT INTO reauth_grants(user_id, session_id, expires_at)
     VALUES ($1, $2, now() + interval '15 minutes')`,
    [userId, sessionId],
  );
  const crossAccountReversal = await app.inject({
    method: "POST",
    url: `/api/v1/admin/client-accounts/${staffAccountId}/manual-receipts/${fullFeeResult.manualReceiptId}/reversal`,
    headers: { cookie },
    payload: {
      ...reversalBody,
      idempotencyKey: `reversal-cross-account-${namespace}`,
    },
  });
  assert.equal(crossAccountReversal.statusCode, 404);
  const staleReversal = await app.inject({
    method: "POST",
    url: reversalUrl,
    headers: { cookie },
    payload: { ...reversalBody, expectedGrossAmountMinor: "251" },
  });
  assert.equal(staleReversal.statusCode, 409, staleReversal.body);
  assert.equal(
    responseJson<{ code: string }>(staleReversal).code,
    "MANUAL_RECEIPT_STALE",
  );
  const reversed = await app.inject({
    method: "POST",
    url: reversalUrl,
    headers: { cookie },
    payload: reversalBody,
  });
  assert.equal(reversed.statusCode, 201, reversed.body);
  const reversal = responseJson<{
    reversalId: string;
    manualReceiptId: string;
    fundReceiptId: string;
    grossAmountMinor: string;
    feeMinor: string;
    netAmountMinor: string;
    disposition: string;
    providerUsed: boolean;
    cashOutflow: boolean;
    replayed: boolean;
  }>(reversed);
  assert.deepEqual(
    {
      manualReceiptId: reversal.manualReceiptId,
      fundReceiptId: reversal.fundReceiptId,
      grossAmountMinor: reversal.grossAmountMinor,
      feeMinor: reversal.feeMinor,
      netAmountMinor: reversal.netAmountMinor,
      disposition: reversal.disposition,
      providerUsed: reversal.providerUsed,
      cashOutflow: reversal.cashOutflow,
      replayed: reversal.replayed,
    },
    {
      manualReceiptId: fullFeeResult.manualReceiptId,
      fundReceiptId: fullFeeResult.fundReceiptId,
      grossAmountMinor: "250",
      feeMinor: "250",
      netAmountMinor: "0",
      disposition: "reversed",
      providerUsed: false,
      cashOutflow: false,
      replayed: false,
    },
  );
  const reversalFinancial = await pool.query<{
    fact_count: string;
    reversal_count: string;
    disposition: string;
    debit_minor: string;
    credit_minor: string;
    liability_debit: string;
    cash_credit: string;
    fee_credit: string;
    sealed: boolean;
    audit_count: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM manual_receipt_facts WHERE id = $1) AS fact_count,
       (SELECT count(*)::text FROM manual_receipt_reversals WHERE id = $2)
         AS reversal_count,
       receipt.disposition,
       sum(line.debit_minor)::text AS debit_minor,
       sum(line.credit_minor)::text AS credit_minor,
       COALESCE(sum(line.debit_minor) FILTER (
         WHERE line.account_code = 'unclaimed_funds_liability'), 0)::text
           AS liability_debit,
       COALESCE(sum(line.credit_minor) FILTER (
         WHERE line.account_code = 'cash_clearing'), 0)::text AS cash_credit,
       COALESCE(sum(line.credit_minor) FILTER (
         WHERE line.account_code = 'payment_processing_expense'), 0)::text AS fee_credit,
       journal.sealed_at IS NOT NULL AS sealed,
       (SELECT count(*)::text FROM audit_events
        WHERE action = 'billing.manual_receipt_reversed' AND target_id = $1::text)
          AS audit_count
     FROM fund_receipts receipt
     JOIN ledger_journals journal
       ON journal.source_type = 'manual_receipt_reversal'
      AND journal.source_id = $2
     JOIN ledger_lines line ON line.journal_id = journal.id
     WHERE receipt.id = $3
     GROUP BY receipt.id, journal.id`,
    [fullFeeResult.manualReceiptId, reversal.reversalId, fullFeeResult.fundReceiptId],
  );
  assert.deepEqual(reversalFinancial.rows[0], {
    fact_count: "1",
    reversal_count: "1",
    disposition: "reversed",
    debit_minor: "250",
    credit_minor: "250",
    liability_debit: "250",
    cash_credit: "0",
    fee_credit: "250",
    sealed: true,
    audit_count: "1",
  });
  const reversalReplay = await app.inject({
    method: "POST",
    url: reversalUrl,
    headers: { cookie },
    payload: reversalBody,
  });
  assert.equal(reversalReplay.statusCode, 200, reversalReplay.body);
  assert.equal(responseJson<{ replayed: boolean }>(reversalReplay).replayed, true);
  assert.equal(
    responseJson<{ reversalId: string }>(reversalReplay).reversalId,
    reversal.reversalId,
  );
  const reversalIdempotencyConflict = await app.inject({
    method: "POST",
    url: reversalUrl,
    headers: { cookie },
    payload: { ...reversalBody, reason: `${reversalBody.reason} with changed intent` },
  });
  assert.equal(reversalIdempotencyConflict.statusCode, 409);
  assert.equal(
    responseJson<{ code: string }>(reversalIdempotencyConflict).code,
    "IDEMPOTENCY_CONFLICT",
  );
  const secondReversal = await app.inject({
    method: "POST",
    url: reversalUrl,
    headers: { cookie },
    payload: { ...reversalBody, idempotencyKey: `reversal-second-${namespace}` },
  });
  assert.equal(secondReversal.statusCode, 409);
  assert.equal(
    responseJson<{ code: string }>(secondReversal).code,
    "MANUAL_RECEIPT_ALREADY_REVERSED",
  );

  const concurrentReversalReceiptResponse = await app.inject({
    method: "POST",
    url,
    headers: { cookie },
    payload: {
      ...firstBody,
      reference: `REVERSAL-CONCURRENT-${namespace}`,
      grossAmountMinor: "425",
      feeMinor: "25",
      reason: "Synthetic untouched receipt used to prove concurrent reversals serialize",
      idempotencyKey: `reversal-concurrent-receipt-${namespace}`,
    },
  });
  assert.equal(
    concurrentReversalReceiptResponse.statusCode,
    201,
    concurrentReversalReceiptResponse.body,
  );
  const concurrentReversalReceipt = responseJson<{
    manualReceiptId: string;
    fundReceiptId: string;
    grossAmountMinor: string;
  }>(concurrentReversalReceiptResponse);
  const concurrentReversalUrl =
    `${url}/${concurrentReversalReceipt.manualReceiptId}/reversal`;
  const concurrentReversalBase = {
    expectedFundReceiptId: concurrentReversalReceipt.fundReceiptId,
    expectedGrossAmountMinor: concurrentReversalReceipt.grossAmountMinor,
  };
  const concurrentReversals = await Promise.all([
    app.inject({
      method: "POST",
      url: concurrentReversalUrl,
      headers: { cookie },
      payload: {
        ...concurrentReversalBase,
        reason: "Synthetic billing operator A reverses the same untouched receipt",
        idempotencyKey: `reversal-concurrent-a-${namespace}`,
      },
    }),
    app.inject({
      method: "POST",
      url: concurrentReversalUrl,
      headers: { cookie },
      payload: {
        ...concurrentReversalBase,
        reason: "Synthetic billing operator B reverses the same untouched receipt",
        idempotencyKey: `reversal-concurrent-b-${namespace}`,
      },
    }),
  ]);
  assert.deepEqual(
    concurrentReversals.map((response) => response.statusCode).sort(),
    [201, 409],
    concurrentReversals.map((response) => response.body).join("\n"),
  );
  const rejectedConcurrentReversal = concurrentReversals.find(
    (response) => response.statusCode === 409,
  );
  assert.equal(
    responseJson<{ code: string }>(rejectedConcurrentReversal!).code,
    "MANUAL_RECEIPT_ALREADY_REVERSED",
  );
  const concurrentReversalFacts = await pool.query<{
    reversal_count: string;
    journal_count: string;
    audit_count: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM manual_receipt_reversals
        WHERE manual_receipt_id = $1) AS reversal_count,
       (SELECT count(*)::text FROM ledger_journals journal
        JOIN manual_receipt_reversals reversal ON reversal.id = journal.source_id
        WHERE reversal.manual_receipt_id = $1
          AND journal.source_type = 'manual_receipt_reversal') AS journal_count,
       (SELECT count(*)::text FROM audit_events
        WHERE action = 'billing.manual_receipt_reversed'
          AND target_id = $1::text) AS audit_count`,
    [concurrentReversalReceipt.manualReceiptId],
  );
  assert.deepEqual(concurrentReversalFacts.rows[0], {
    reversal_count: "1",
    journal_count: "1",
    audit_count: "1",
  });

  await pool.query(
    `INSERT INTO add_funds_policies(
       currency, enabled, min_principal_minor, max_principal_minor, balance_cap_minor
     ) VALUES ('USD', true, 1, 1000000, 1000000)
     ON CONFLICT (currency) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       min_principal_minor = EXCLUDED.min_principal_minor,
       max_principal_minor = EXCLUDED.max_principal_minor,
       balance_cap_minor = EXCLUDED.balance_cap_minor,
       updated_at = now()`,
  );
  const raceBody = {
    ...firstBody,
    reference: `REVERSAL-RACE-${namespace}`,
    grossAmountMinor: "700",
    feeMinor: "0",
    reason: "Synthetic untouched receipt used to prove reversal and Credit allocation serialize",
    idempotencyKey: `reversal-race-receipt-${namespace}`,
  };
  const raceCreated = await app.inject({
    method: "POST",
    url,
    headers: { cookie },
    payload: raceBody,
  });
  assert.equal(raceCreated.statusCode, 201, raceCreated.body);
  const raceReceipt = responseJson<{
    manualReceiptId: string;
    fundReceiptId: string;
    grossAmountMinor: string;
  }>(raceCreated);
  const [raceReversal, raceResolution] = await Promise.all([
    app.inject({
      method: "POST",
      url: `${url}/${raceReceipt.manualReceiptId}/reversal`,
      headers: { cookie },
      payload: {
        expectedFundReceiptId: raceReceipt.fundReceiptId,
        expectedGrossAmountMinor: raceReceipt.grossAmountMinor,
        reason: "Synthetic billing staff reverses the untouched receipt in the concurrency race",
        idempotencyKey: `reversal-race-reversal-${namespace}`,
      },
    }),
    app.inject({
      method: "POST",
      url: `/api/v1/admin/funds/${raceReceipt.fundReceiptId}/resolutions`,
      headers: { cookie },
      payload: {
        action: "convert_to_credit",
        amountMinor: raceReceipt.grossAmountMinor,
        invoiceId: null,
        reason: "Synthetic billing staff converts the same funds in the concurrency race",
        idempotencyKey: `reversal-race-resolution-${namespace}`,
      },
    }),
  ]);
  assert.deepEqual(
    [raceReversal.statusCode, raceResolution.statusCode].sort(),
    [201, 409],
    `${raceReversal.body}\n${raceResolution.body}`,
  );
  const raceFacts = await pool.query<{
    reversal_count: string;
    resolution_count: string;
    disposition: string;
    allocated_minor: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM manual_receipt_reversals
        WHERE manual_receipt_id = $1) AS reversal_count,
       (SELECT count(*)::text FROM fund_receipt_resolutions
        WHERE fund_receipt_id = $2) AS resolution_count,
       receipt.disposition,
       receipt.allocated_minor::text
     FROM fund_receipts receipt
     WHERE receipt.id = $2`,
    [raceReceipt.manualReceiptId, raceReceipt.fundReceiptId],
  );
  assert.equal(
    BigInt(raceFacts.rows[0]?.reversal_count ?? "0") +
      BigInt(raceFacts.rows[0]?.resolution_count ?? "0"),
    1n,
  );
  if (raceReversal.statusCode === 201) {
    assert.deepEqual(
      {
        disposition: raceFacts.rows[0]?.disposition,
        allocatedMinor: raceFacts.rows[0]?.allocated_minor,
      },
      { disposition: "reversed", allocatedMinor: "0" },
    );
  } else {
    assert.deepEqual(
      {
        disposition: raceFacts.rows[0]?.disposition,
        allocatedMinor: raceFacts.rows[0]?.allocated_minor,
      },
      { disposition: "allocated", allocatedMinor: "700" },
    );
  }
  const explicitResolutionCreditDelta = raceResolution.statusCode === 201 ? 1n : 0n;

  await assert.rejects(
    pool.query(
      "UPDATE fund_receipts SET reported_manual_receipt_id = $1 WHERE id = $2",
      [fullFeeResult.manualReceiptId, first.fundReceiptId],
    ),
    /Fund receipt external facts are append-only/,
  );
  const originalAssociation = await pool.query<{ reported_manual_receipt_id: string }>(
    "SELECT reported_manual_receipt_id FROM fund_receipts WHERE id = $1",
    [first.fundReceiptId],
  );
  assert.equal(
    originalAssociation.rows[0]?.reported_manual_receipt_id,
    first.manualReceiptId,
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO fund_receipts(
         id, provider_installation_id, external_payment_id,
         reported_payment_attempt_id, reported_add_funds_attempt_id,
         reported_manual_receipt_id, client_account_id, amount_minor,
         allocated_minor, currency, occurred_at, disposition, reason
       ) VALUES ($1, NULL, NULL, NULL, NULL, $2, $3, 250, 0, 'USD', $4, 'unclaimed', $5)`,
      [
        randomUUID(),
        fullFeeResult.manualReceiptId,
        targetAccountId,
        receivedAt,
        "Synthetic duplicate manual receipt association must be rejected",
      ],
    ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505" &&
      "constraint" in error &&
      error.constraint === "fund_receipts_reported_manual_receipt_id_key",
  );

  const invalidFee = await app.inject({
    method: "POST",
    url,
    headers: { cookie },
    payload: {
      ...firstBody,
      reference: `INVALID-FEE-${namespace}`,
      grossAmountMinor: "249",
      feeMinor: "250",
      idempotencyKey: `invalid-fee-${namespace}`,
    },
  });
  assert.equal(invalidFee.statusCode, 400);
  assert.equal(
    responseJson<{ code: string }>(invalidFee).code,
    "MANUAL_RECEIPT_FEE_EXCEEDS_GROSS",
  );

  const noncanonicalFee = await app.inject({
    method: "POST",
    url,
    headers: { cookie },
    payload: {
      ...firstBody,
      reference: `NONCANONICAL-FEE-${namespace}`,
      feeMinor: "00",
      idempotencyKey: `noncanonical-fee-${namespace}`,
    },
  });
  assert.equal(noncanonicalFee.statusCode, 400);

  const outOfRange = await app.inject({
    method: "POST",
    url,
    headers: { cookie },
    payload: {
      ...firstBody,
      reference: `OUT-OF-RANGE-${namespace}`,
      grossAmountMinor: "9223372036854775808",
      idempotencyKey: `out-of-range-${namespace}`,
    },
  });
  assert.equal(outOfRange.statusCode, 400);
  assert.equal(
    responseJson<{ code: string }>(outOfRange).code,
    "MANUAL_RECEIPT_AMOUNT_OUT_OF_RANGE",
  );

  await pool.query(
    `UPDATE staff_members
     SET permissions = '["billing.manual_receipt_manage", "billing.unclaimed_manage", "billing.refund_manage"]'::jsonb,
         updated_at = now()
     WHERE user_id = $1`,
    [userId],
  );
  await pool.query(
    `INSERT INTO reauth_grants(user_id, session_id, expires_at)
     VALUES ($1, $2, now() + interval '15 minutes')`,
    [userId, sessionId],
  );
  const outflowUrl = `${url}/${first.manualReceiptId}/outflow-reports`;
  const confirmedOutflowBody = {
    expectedAvailableMinor: "10000",
    amountMinor: "1200",
    currency: "USD",
    destination: "original_source",
    destinationReference: `RETURN-CONFIRMED-${namespace}`,
    observedOutcome: "confirmed",
    occurredAt: new Date().toISOString(),
    reason: "Synthetic bank evidence confirms the original-source return completed",
    idempotencyKey: `outflow-confirmed-${namespace}`,
  };
  const confirmedOutflowResponse = await app.inject({
    method: "POST",
    url: outflowUrl,
    headers: { cookie },
    payload: confirmedOutflowBody,
  });
  assert.equal(confirmedOutflowResponse.statusCode, 201, confirmedOutflowResponse.body);
  const confirmedOutflow = responseJson<{
    outflowReportId: string;
    outflowId: string;
    status: string;
    destination: string;
    providerUsed: boolean;
    replayed: boolean;
  }>(confirmedOutflowResponse);
  assert.deepEqual(
    {
      status: confirmedOutflow.status,
      destination: confirmedOutflow.destination,
      providerUsed: confirmedOutflow.providerUsed,
      replayed: confirmedOutflow.replayed,
    },
    {
      status: "confirmed",
      destination: "original_source",
      providerUsed: false,
      replayed: false,
    },
  );
  assert.ok(confirmedOutflow.outflowReportId);
  assert.ok(confirmedOutflow.outflowId);
  const confirmedOutflowReplay = await app.inject({
    method: "POST",
    url: outflowUrl,
    headers: { cookie },
    payload: confirmedOutflowBody,
  });
  assert.equal(confirmedOutflowReplay.statusCode, 200, confirmedOutflowReplay.body);
  assert.equal(
    responseJson<{ outflowId: string }>(confirmedOutflowReplay).outflowId,
    confirmedOutflow.outflowId,
  );
  assert.equal(
    responseJson<{ replayed: boolean }>(confirmedOutflowReplay).replayed,
    true,
  );
  const confirmedOutflowIdempotencyConflict = await app.inject({
    method: "POST",
    url: outflowUrl,
    headers: { cookie },
    payload: { ...confirmedOutflowBody, amountMinor: "1201" },
  });
  assert.equal(confirmedOutflowIdempotencyConflict.statusCode, 409);
  assert.equal(
    responseJson<{ code: string }>(confirmedOutflowIdempotencyConflict).code,
    "IDEMPOTENCY_CONFLICT",
  );

  const unknownNoOutflowBody = {
    expectedAvailableMinor: "8800",
    amountMinor: "800",
    currency: "USD",
    destination: "original_source",
    destinationReference: `RETURN-UNKNOWN-NO-${namespace}`,
    observedOutcome: "unknown",
    occurredAt: null,
    reason: "Synthetic transfer evidence is incomplete and requires reconciliation",
    idempotencyKey: `outflow-unknown-no-${namespace}`,
  };
  const unknownNoOutflowResponse = await app.inject({
    method: "POST",
    url: outflowUrl,
    headers: { cookie },
    payload: unknownNoOutflowBody,
  });
  assert.equal(unknownNoOutflowResponse.statusCode, 201, unknownNoOutflowResponse.body);
  const unknownNoOutflow = responseJson<{
    outflowReportId: string;
    outflowId: null;
    status: string;
  }>(unknownNoOutflowResponse);
  assert.equal(unknownNoOutflow.status, "unknown");
  assert.equal(unknownNoOutflow.outflowId, null);
  const whileUnknown = await app.inject({
    method: "POST",
    url: outflowUrl,
    headers: { cookie },
    payload: {
      ...unknownNoOutflowBody,
      expectedAvailableMinor: "0",
      amountMinor: "1",
      destinationReference: `RETURN-BLOCKED-${namespace}`,
      reason: "Synthetic second return is blocked while prior evidence is unknown",
      idempotencyKey: `outflow-blocked-${namespace}`,
    },
  });
  assert.equal(whileUnknown.statusCode, 409, whileUnknown.body);
  assert.equal(
    responseJson<{ code: string }>(whileUnknown).code,
    "MANUAL_RECEIPT_OUTFLOW_RECONCILIATION_REQUIRED",
  );
  const noOutflowReconciliationBody = {
    outcome: "confirm_no_outflow",
    occurredAt: null,
    reason: "Synthetic bank trace proves no original-source transfer ever left",
    idempotencyKey: `outflow-reconcile-no-${namespace}`,
  };
  const noOutflowReconciliationUrl =
    `${outflowUrl}/${unknownNoOutflow.outflowReportId}/reconciliation`;
  const noOutflowReconciliationResponse = await app.inject({
    method: "POST",
    url: noOutflowReconciliationUrl,
    headers: { cookie },
    payload: noOutflowReconciliationBody,
  });
  assert.equal(
    noOutflowReconciliationResponse.statusCode,
    201,
    noOutflowReconciliationResponse.body,
  );
  assert.equal(
    responseJson<{ status: string }>(noOutflowReconciliationResponse).status,
    "no_outflow",
  );
  const noOutflowReconciliationReplay = await app.inject({
    method: "POST",
    url: noOutflowReconciliationUrl,
    headers: { cookie },
    payload: noOutflowReconciliationBody,
  });
  assert.equal(noOutflowReconciliationReplay.statusCode, 200);
  assert.equal(
    responseJson<{ replayed: boolean }>(noOutflowReconciliationReplay).replayed,
    true,
  );
  const conflictingReconciliation = await app.inject({
    method: "POST",
    url: noOutflowReconciliationUrl,
    headers: { cookie },
    payload: {
      outcome: "confirm_outflow",
      occurredAt: new Date().toISOString(),
      reason: "Synthetic contradictory decision must not replace the final reconciliation",
      idempotencyKey: `outflow-reconcile-conflict-${namespace}`,
    },
  });
  assert.equal(conflictingReconciliation.statusCode, 409);
  assert.equal(
    responseJson<{ code: string }>(conflictingReconciliation).code,
    "MANUAL_RECEIPT_OUTFLOW_ALREADY_RECONCILED",
  );

  const unknownConfirmedBody = {
    expectedAvailableMinor: "8800",
    amountMinor: "600",
    currency: "USD",
    destination: "original_source",
    destinationReference: `RETURN-UNKNOWN-YES-${namespace}`,
    observedOutcome: "unknown",
    occurredAt: null,
    reason: "Synthetic transfer result is unknown until an independent bank trace arrives",
    idempotencyKey: `outflow-unknown-yes-${namespace}`,
  };
  const unknownConfirmedResponse = await app.inject({
    method: "POST",
    url: outflowUrl,
    headers: { cookie },
    payload: unknownConfirmedBody,
  });
  assert.equal(unknownConfirmedResponse.statusCode, 201, unknownConfirmedResponse.body);
  const unknownConfirmed = responseJson<{ outflowReportId: string }>(
    unknownConfirmedResponse,
  );
  const confirmOutflowReconciliation = await app.inject({
    method: "POST",
    url: `${outflowUrl}/${unknownConfirmed.outflowReportId}/reconciliation`,
    headers: { cookie },
    payload: {
      outcome: "confirm_outflow",
      occurredAt: new Date().toISOString(),
      reason: "Synthetic bank trace now proves the original-source transfer completed",
      idempotencyKey: `outflow-reconcile-yes-${namespace}`,
    },
  });
  assert.equal(
    confirmOutflowReconciliation.statusCode,
    201,
    confirmOutflowReconciliation.body,
  );
  assert.equal(
    responseJson<{ status: string }>(confirmOutflowReconciliation).status,
    "confirmed_outflow",
  );
  assert.ok(responseJson<{ outflowId: string }>(confirmOutflowReconciliation).outflowId);
  const outflowFinancial = await pool.query<{
    report_count: string;
    reconciliation_count: string;
    outflow_count: string;
    journal_count: string;
    debit_minor: string;
    credit_minor: string;
    provider_operation_count: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM manual_receipt_outflow_reports
        WHERE manual_receipt_id = $1) AS report_count,
       (SELECT count(*)::text
        FROM manual_receipt_outflow_reconciliations reconciliation
        JOIN manual_receipt_outflow_reports report ON report.id = reconciliation.report_id
        WHERE report.manual_receipt_id = $1) AS reconciliation_count,
       (SELECT count(*)::text FROM manual_receipt_outflows
        WHERE manual_receipt_id = $1) AS outflow_count,
       count(DISTINCT journal.id)::text AS journal_count,
       sum(line.debit_minor)::text AS debit_minor,
       sum(line.credit_minor)::text AS credit_minor,
       (SELECT count(*)::text FROM provider_operations
        WHERE subject_type IN ('manual_receipt_outflow_report', 'manual_receipt_outflow'))
         AS provider_operation_count
     FROM manual_receipt_outflows outflow
     JOIN ledger_journals journal
       ON journal.source_type = 'manual_receipt_outflow' AND journal.source_id = outflow.id
     JOIN ledger_lines line ON line.journal_id = journal.id
     WHERE outflow.manual_receipt_id = $1`,
    [first.manualReceiptId],
  );
  assert.deepEqual(outflowFinancial.rows[0], {
    report_count: "3",
    reconciliation_count: "2",
    outflow_count: "2",
    journal_count: "2",
    debit_minor: "1800",
    credit_minor: "1800",
    provider_operation_count: "0",
  });

  const listed = await app.inject({ method: "GET", url, headers: { cookie } });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(
    responseJson<{
      items: Array<{
        manualReceiptId: string;
        reversal: { reversalId: string } | null;
      }>;
    }>(listed).items.some(
      (item) =>
        item.manualReceiptId === fullFeeResult.manualReceiptId &&
        item.reversal?.reversalId === reversal.reversalId,
    ),
    true,
  );
  const listedOutflowReceipt = responseJson<{
    items: Array<{
      manualReceiptId: string;
      originalSourceOutflow: {
        sourceAmountMinor: string;
        confirmedOutflowMinor: string;
        availableMinor: string;
        capacityFrozen: boolean;
        reports: Array<{ status: string }>;
      };
    }>;
  }>(listed).items.find((item) => item.manualReceiptId === first.manualReceiptId);
  assert.deepEqual(
    {
      sourceAmountMinor: listedOutflowReceipt?.originalSourceOutflow.sourceAmountMinor,
      confirmedOutflowMinor:
        listedOutflowReceipt?.originalSourceOutflow.confirmedOutflowMinor,
      availableMinor: listedOutflowReceipt?.originalSourceOutflow.availableMinor,
      capacityFrozen: listedOutflowReceipt?.originalSourceOutflow.capacityFrozen,
      reportStatuses: listedOutflowReceipt?.originalSourceOutflow.reports
        .map((report) => report.status)
        .sort(),
    },
    {
      sourceAmountMinor: "10000",
      confirmedOutflowMinor: "1800",
      availableMinor: "8200",
      capacityFrozen: false,
      reportStatuses: ["confirmed", "confirmed_outflow", "no_outflow"],
    },
  );
  const visibleUnclaimed = await app.inject({
    method: "GET",
    url: "/api/v1/admin/funds/unclaimed",
    headers: { cookie },
  });
  assert.equal(visibleUnclaimed.statusCode, 200, visibleUnclaimed.body);
  const manualUnclaimed = responseJson<{
    items: Array<{
      receiptId: string;
      source: string;
      manualReceiptId: string | null;
      providerInstallationId: string | null;
    }>;
  }>(visibleUnclaimed).items.find((item) => item.receiptId === first.fundReceiptId);
  assert.deepEqual(manualUnclaimed, {
    ...manualUnclaimed,
    source: "manual",
    manualReceiptId: first.manualReceiptId,
    providerInstallationId: null,
  });
  assert.equal(
    responseJson<{ items: Array<{ receiptId: string }> }>(visibleUnclaimed).items.some(
      (item) => item.receiptId === fullFeeResult.fundReceiptId,
    ),
    false,
  );

  await pool.query(
    `UPDATE staff_members
     SET permissions = '[]'::jsonb, updated_at = now()
     WHERE user_id = $1`,
    [userId],
  );
  const permissionRevoked = await app.inject({
    method: "POST",
    url,
    headers: { cookie },
    payload: {
      ...firstBody,
      reference: `REVOKED-${namespace}`,
      idempotencyKey: `revoked-${namespace}`,
    },
  });
  assert.equal(permissionRevoked.statusCode, 403);
  const reversalReplayAfterPermissionRevocation = await app.inject({
    method: "POST",
    url: reversalUrl,
    headers: { cookie },
    payload: reversalBody,
  });
  assert.equal(reversalReplayAfterPermissionRevocation.statusCode, 403);

  const effects = await pool.query<{
    invoices: string;
    services: string;
    credit_transactions: string;
    provider_operations: string;
    manual_provider_operations: string;
    manual_jobs: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM invoices) AS invoices,
       (SELECT count(*)::text FROM services) AS services,
       (SELECT count(*)::text FROM credit_transactions) AS credit_transactions,
       (SELECT count(*)::text FROM provider_operations) AS provider_operations,
       (SELECT count(*)::text FROM provider_operations
        WHERE subject_type IN ('manual_receipt', 'manual_receipt_outflow'))
          AS manual_provider_operations,
       (SELECT count(*)::text FROM durable_jobs
        WHERE job_type LIKE 'manual_receipt.%'
           OR payload ? 'manualReceiptId'
           OR payload ? 'manualReceiptOutflowId') AS manual_jobs`,
  );
  assert.equal(effects.rows[0]?.invoices, baseline.rows[0]?.invoices);
  assert.equal(effects.rows[0]?.services, baseline.rows[0]?.services);
  assert.equal(
    effects.rows[0]?.credit_transactions,
    (BigInt(baseline.rows[0]?.credit_transactions ?? "0") +
      explicitResolutionCreditDelta).toString(),
  );
  assert.equal(
    effects.rows[0]?.provider_operations,
    baseline.rows[0]?.provider_operations,
  );
  assert.equal(effects.rows[0]?.manual_provider_operations, "0");
  assert.equal(effects.rows[0]?.manual_jobs, "0");

  await assert.rejects(
    runMigrations(pool),
    /running schema-019 API or Worker/,
  );
  await app.close();
  app = null;
  await runMigrations(pool);
  assert.equal((await assertSchemaCompatible(pool)).mode, "native");

  process.stdout.write(
    `${JSON.stringify({
      schema019Native: true,
      manualReceiptRecorded: true,
      mistakenManualReceiptReversed: true,
      reversalRequiresBothPermissions: true,
      reversalRequiresFreshReauth: true,
      crossAccountReversalRejected: true,
      reversalReplayRechecksPermission: true,
      reversalStaleReviewRejected: true,
      reversalReplaySafe: true,
      concurrentReversalsCreateOneDecision: true,
      reversalResolutionRaceCreatesOneDecision: true,
      reversedReceiptRemovedFromUnclaimedQueue: true,
      fixedWindowReauthRequired: true,
      permissionRevocationEnforced: true,
      idempotencyReplaySafe: true,
      confirmedOriginalSourceOutflowRecorded: true,
      unknownOutflowFreezesCapacity: true,
      unknownOutflowConfirmedNoOutflow: true,
      unknownOutflowConfirmedOutflow: true,
      outflowReplaySafe: true,
      outflowProviderUsed: false,
      optimisticReferenceConflict: true,
      concurrentReferenceCreates: 1,
      balancedGrossMinor: "10000",
      netCashMinor: "9650",
      processingFeeMinor: "350",
      unclaimedLiabilityMinor: "10000",
      providerUsed: false,
      automaticInvoicePayment: false,
      automaticCredit: false,
      automaticServiceActivation: false,
      sealedJournalAppendRejected: true,
      fundReceiptReassociationRejected: true,
      duplicateFundReceiptAssociationRejected: true,
      liveApplicationBlocksMigration: true,
      migrationAllowedAfterShutdown: true,
    })}\n`,
  );
} finally {
  if (app) await app.close().catch(() => undefined);
  await pool.end();
}
