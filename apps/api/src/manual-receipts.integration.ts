// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { buildApp } from "./app.js";
import { digestToken } from "./auth.js";
import type { Config } from "./config.js";
import { assertSchemaCompatible, runMigrations } from "./database.js";

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
  PAYMENT_METHOD_TOKEN_KEY: "A".repeat(43),
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY: "B".repeat(43),
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
  assert.equal(schema.installedSchemaVersion, "016_stage_b_manual_receipts");
  assert.equal(schema.mode, "native");

  await pool.query(
    `INSERT INTO users(id, email, password_hash, email_verified_at)
     VALUES ($1, $2, 'synthetic-not-a-password', now())`,
    [userId, `manual-receipt-${namespace}@example.invalid`],
  );
  await pool.query(
    `INSERT INTO client_accounts(id, name, owner_user_id)
     VALUES
       ($1, 'Synthetic staff account', $3),
       ($2, 'Synthetic manual receipt target', $3)`,
    [staffAccountId, targetAccountId, userId],
  );
  await pool.query(
    `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
     VALUES ($1, $2, 'owner', '[]'::jsonb)`,
    [staffAccountId, userId],
  );
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
  assert.equal(responseJson<{ netAmountMinor: string }>(fullFee).netAmountMinor, "0");

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

  const listed = await app.inject({ method: "GET", url, headers: { cookie } });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(
    responseJson<{ items: Array<{ manualReceiptId: string }> }>(listed).items.some(
      (item) => item.manualReceiptId === first.manualReceiptId,
    ),
    true,
  );
  const unclaimed = await app.inject({
    method: "GET",
    url: "/api/v1/admin/funds/unclaimed",
    headers: { cookie },
  });
  assert.equal(unclaimed.statusCode, 403);
  await pool.query(
    `UPDATE staff_members
     SET permissions = '["billing.manual_receipt_manage", "billing.unclaimed_manage"]'::jsonb,
         updated_at = now()
     WHERE user_id = $1`,
    [userId],
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
    baseline.rows[0]?.credit_transactions,
  );
  assert.equal(
    effects.rows[0]?.provider_operations,
    baseline.rows[0]?.provider_operations,
  );
  assert.equal(effects.rows[0]?.manual_provider_operations, "0");
  assert.equal(effects.rows[0]?.manual_jobs, "0");

  process.stdout.write(
    `${JSON.stringify({
      schema016Native: true,
      manualReceiptRecorded: true,
      fixedWindowReauthRequired: true,
      permissionRevocationEnforced: true,
      idempotencyReplaySafe: true,
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
    })}\n`,
  );
} finally {
  if (app) await app.close().catch(() => undefined);
  await pool.end();
}
