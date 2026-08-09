// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertSchema016RollbackBridgeSafe,
  assertSchema017NativeSafe,
  SCHEMA_016_017_GUARD,
  SCHEMA_017,
  SCHEMA_017_CATALOG_DIGEST,
  schema017CatalogFingerprintInput,
} from "@opensales/core/schema-016-017-rollback-compatibility";
import pg from "pg";
import {
  holdSchema016RollbackBridgeGuard,
  holdSchema017ApplicationGuard,
  runMigrations,
} from "./database.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for schema 016/017 integration");

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 8,
  options: "-c search_path=pg_catalog,public",
  statement_timeout: 20_000,
  application_name: "opensales-schema-016-017-rollback-integration",
});
const queryable = {
  query: async (text: string, values?: unknown[]) => pool.query(text, values),
};

async function currentVersion(): Promise<string | null> {
  const result = await pool.query<{ version: string | null }>(
    "SELECT pg_catalog.max(version) AS version FROM public.schema_migrations",
  );
  return result.rows[0]?.version ?? null;
}

test("explicit schema-016 bridge accepts exact native 016 before migration", async () => {
  assert.equal(await currentVersion(), "016_stage_b_manual_receipts");
  const report = await assertSchema016RollbackBridgeSafe(queryable, {
    enable017RollbackBridge: true,
  });
  assert.equal(report.mode, "native");

  const releaseGuard = await holdSchema016RollbackBridgeGuard(pool);
  try {
    await assert.rejects(
      runMigrations(pool),
      /running schema-016\/017 bridge API or Worker/,
    );
  } finally {
    await releaseGuard();
  }
});

test("migration 017 rejects a pre-existing orphan outflow marker before DDL", async () => {
  const client = await pool.connect();
  const markerId = randomUUID();
  try {
    const migration = await readFile(
      new URL("../migrations/017_stage_b_manual_receipt_outflow_reports.sql", import.meta.url),
      "utf8",
    );
    const preDdlGuard = migration.match(/DO \$\$[\s\S]*?\$\$;/)?.[0];
    assert.ok(preDdlGuard, "migration 017 must start with its reviewed pre-DDL guard");
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.ledger_journals(
         id, source_type, source_id, currency, description
       ) VALUES ($1, 'manual_receipt_outflow', $2, 'USD', 'synthetic pre-017 orphan')`,
      [markerId, randomUUID()],
    );
    await assert.rejects(client.query(preDdlGuard), /unsupported manual receipt outflow markers/);
    await client.query("ROLLBACK");
    assert.equal(await currentVersion(), "016_stage_b_manual_receipts");
    assert.equal(
      (await pool.query("SELECT pg_catalog.to_regclass('public.manual_receipt_outflow_reports') AS relation")).rows[0]?.relation,
      null,
    );
    const cleaned = await pool.query<{ count: string }>(
      "SELECT pg_catalog.count(*)::text AS count FROM public.ledger_journals WHERE id = $1",
      [markerId],
    );
    assert.equal(cleaned.rows[0]?.count, "0");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});

test("actual migration 017 file applies and emits its PG18 catalog digest", async () => {
  await runMigrations(pool);
  assert.equal(await currentVersion(), SCHEMA_017);
  const catalog = await schema017CatalogFingerprintInput(queryable);
  assert.equal(catalog.historyExact, true);
  assert.ok(catalog.fingerprintInput);
  const digest = createHash("sha256")
    .update(catalog.fingerprintInput, "utf8")
    .digest("hex");
  process.stdout.write(`schema017CatalogDigest=${digest}\n`);
  assert.equal(
    digest,
    SCHEMA_017_CATALOG_DIGEST,
    "commit the digest emitted by the actual PostgreSQL 18 migration catalog",
  );
});

test("native 017 and an empty explicit 016 bridge use the exact catalog", async () => {
  assert.equal((await assertSchema017NativeSafe(queryable)).mode, "native");
  const bridge = await assertSchema016RollbackBridgeSafe(queryable, {
    enable017RollbackBridge: true,
  });
  assert.equal(bridge.mode, "rollback_bridge");

  const releaseGuard = await holdSchema017ApplicationGuard(pool);
  try {
    await assert.rejects(
      runMigrations(pool),
      /running schema-017 API or Worker/,
    );
  } finally {
    await releaseGuard();
  }
  await runMigrations(pool);
});

test("orphan outflow journals fail at commit even when balanced and sealed", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const journal = await client.query<{ id: string }>(
      `INSERT INTO public.ledger_journals(
         source_type, source_id, currency, description
       ) VALUES ('manual_receipt_outflow', $1, 'USD', 'synthetic orphan journal')
       RETURNING id`,
      [randomUUID()],
    );
    await client.query(
      `INSERT INTO public.ledger_lines(journal_id, account_code, debit_minor, credit_minor)
       VALUES
         ($1, 'sales_refunds_and_allowances', 125, 0),
         ($1, 'cash_clearing', 0, 125)`,
      [journal.rows[0]?.id],
    );
    await client.query(
      "UPDATE public.ledger_journals SET sealed_at = pg_catalog.now() WHERE id = $1",
      [journal.rows[0]?.id],
    );
    await assert.rejects(client.query("COMMIT"), /has no immutable outflow fact/);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});

test("manual outflow authorization requires both manual-receipt and refund permissions", async () => {
  const client = await pool.connect();
  const staffUserId = randomUUID();
  const sessionId = randomUUID();
  const reauthId = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.users(id, email, password_hash, email_verified_at)
       VALUES ($1, $2, 'synthetic-not-a-password', pg_catalog.now())`,
      [staffUserId, `schema-017-auth-${staffUserId}@example.invalid`],
    );
    await client.query(
      `INSERT INTO public.sessions(id, user_id, token_digest, expires_at)
       VALUES ($1, $2, $3, pg_catalog.now() + interval '1 hour')`,
      [sessionId, staffUserId, `schema-017-auth-${sessionId}`],
    );
    await client.query(
      `INSERT INTO public.reauth_grants(
         id, user_id, session_id, created_at, expires_at
       ) VALUES ($1, $2, $3, pg_catalog.now(), pg_catalog.now() + interval '15 minutes')`,
      [reauthId, staffUserId, sessionId],
    );
    await client.query(
      `INSERT INTO public.staff_members(user_id, roles, permissions)
       VALUES ($1, ARRAY['Billing'], $2::jsonb)`,
      [staffUserId, JSON.stringify(["billing.manual_receipt_manage"])],
    );
    const authorized = async (): Promise<boolean> => {
      const result = await client.query<{ authorized: boolean }>(
        `SELECT public.opensales_validate_manual_receipt_outflow_authorization(
           $1, $2, $3
         ) AS authorized`,
        [staffUserId, sessionId, reauthId],
      );
      return result.rows[0]?.authorized === true;
    };
    assert.equal(await authorized(), false);
    await client.query(
      "UPDATE public.staff_members SET permissions = $2::jsonb WHERE user_id = $1",
      [staffUserId, JSON.stringify(["billing.refund_manage"])],
    );
    assert.equal(await authorized(), false);
    await client.query(
      "UPDATE public.staff_members SET permissions = $2::jsonb WHERE user_id = $1",
      [
        staffUserId,
        JSON.stringify(["billing.manual_receipt_manage", "billing.refund_manage"]),
      ],
    );
    assert.equal(await authorized(), true);
    await client.query(
      "UPDATE public.staff_members SET permissions = '[]'::jsonb WHERE user_id = $1",
      [staffUserId],
    );
    assert.equal(await authorized(), false);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});

test("unknown converted Credit is held, then consumed Credit becomes audited debt", async () => {
  const client = await pool.connect();
  const userId = randomUUID();
  const clientAccountId = randomUUID();
  const sessionId = randomUUID();
  const reauthId = randomUUID();
  const manualReceiptId = randomUUID();
  const fundReceiptId = randomUUID();
  const resolutionId = randomUUID();
  const creditAccountId = randomUUID();
  const receiptAmountMinor = 700;
  const amountMinor = 600;
  const baseOccurredAt = new Date(Date.now() - 60_000).toISOString();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.users(id, email, password_hash, email_verified_at)
       VALUES ($1, $2, 'synthetic-not-a-password', pg_catalog.now())`,
      [userId, `schema-017-financial-${userId}@example.invalid`],
    );
    await client.query(
      `INSERT INTO public.client_accounts(id, name, owner_user_id)
       VALUES ($1, 'Synthetic schema 017 financial account', $2)`,
      [clientAccountId, userId],
    );
    await client.query(
      `INSERT INTO public.sessions(id, user_id, token_digest, expires_at)
       VALUES ($1, $2, $3, pg_catalog.now() + interval '1 hour')`,
      [sessionId, userId, `schema-017-financial-${sessionId}`],
    );
    await client.query(
      `INSERT INTO public.reauth_grants(
         id, user_id, session_id, created_at, expires_at
       ) VALUES ($1, $2, $3, pg_catalog.now(), pg_catalog.now() + interval '15 minutes')`,
      [reauthId, userId, sessionId],
    );
    await client.query(
      `INSERT INTO public.staff_members(user_id, roles, permissions)
       VALUES (
         $1, ARRAY['Billing'],
         '["billing.manual_receipt_manage", "billing.refund_manage"]'::jsonb
       )`,
      [userId],
    );
    await client.query(
      `INSERT INTO public.add_funds_policies(
         currency, enabled, min_principal_minor, max_principal_minor,
         balance_cap_minor
       ) VALUES ('USD', true, 1, 1000000, 1000000)
       ON CONFLICT (currency) DO UPDATE SET balance_cap_minor = EXCLUDED.balance_cap_minor`,
    );
    await client.query(
      `INSERT INTO public.manual_receipt_facts(
         id, client_account_id, reference, received_at, gross_amount_minor,
         fee_minor, currency, actor_id, reason, idempotency_key,
         request_fingerprint, result
       ) VALUES (
         $1, $2, $3, $4, $5, 0, 'USD', $6,
         'Synthetic manual receipt for schema 017 Credit debt regression',
         $7, $8, '{}'::jsonb
       )`,
      [
        manualReceiptId,
        clientAccountId,
        `SCHEMA-017-${manualReceiptId}`,
        baseOccurredAt,
        receiptAmountMinor,
        userId,
        `schema-017-receipt-${manualReceiptId}`,
        `schema-017-receipt-fingerprint-${manualReceiptId}`,
      ],
    );
    await client.query(
      `INSERT INTO public.fund_receipts(
         id, provider_installation_id, external_payment_id,
         reported_payment_attempt_id, reported_add_funds_attempt_id,
         reported_manual_receipt_id, client_account_id, amount_minor,
         allocated_minor, currency, occurred_at, disposition, reason
       ) VALUES (
         $1, NULL, NULL, NULL, NULL, $2, $3, $4, 0, 'USD', $5,
         'unclaimed', 'Synthetic schema 017 manual receipt source'
       )`,
      [fundReceiptId, manualReceiptId, clientAccountId, receiptAmountMinor, baseOccurredAt],
    );
    const receiptJournal = await client.query<{ id: string }>(
      `INSERT INTO public.ledger_journals(source_type, source_id, currency, description)
       VALUES ('manual_receipt', $1, 'USD', 'Synthetic schema 017 manual receipt')
       RETURNING id`,
      [manualReceiptId],
    );
    await client.query(
      `INSERT INTO public.ledger_lines(journal_id, account_code, debit_minor, credit_minor)
       VALUES
         ($1, 'cash_clearing', $2, 0),
         ($1, 'unclaimed_funds_liability', 0, $2)`,
      [receiptJournal.rows[0]?.id, receiptAmountMinor],
    );
    await client.query(
      "UPDATE public.ledger_journals SET sealed_at = pg_catalog.now() WHERE id = $1",
      [receiptJournal.rows[0]?.id],
    );
    await client.query("COMMIT");

    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.credit_accounts(id, client_account_id, currency)
       VALUES ($1, $2, 'USD')`,
      [creditAccountId, clientAccountId],
    );
    const resolutionResult = {
      resolutionId,
      amountMinor: amountMinor.toString(),
      currency: "USD",
    };
    await client.query(
      `INSERT INTO public.fund_receipt_resolutions(
         id, fund_receipt_id, client_account_id, action, amount_minor,
         currency, invoice_id, actor_id, reason, idempotency_key,
         request_fingerprint, result
       ) VALUES (
         $1, $2, $3, 'convert_to_credit', $4, 'USD', NULL, $5,
         'Synthetic conversion for schema 017 Credit debt regression',
         $6, $7, $8::jsonb
       )`,
      [
        resolutionId,
        fundReceiptId,
        clientAccountId,
        amountMinor,
        userId,
        `schema-017-resolution-${resolutionId}`,
        `schema-017-resolution-fingerprint-${resolutionId}`,
        JSON.stringify(resolutionResult),
      ],
    );
    await client.query(
      `INSERT INTO public.credit_transactions(
         credit_account_id, kind, credit_minor, debit_minor,
         source_type, source_id, actor_type, actor_id, reason,
         idempotency_key, request_fingerprint, result
       ) VALUES (
         $1, 'unclaimed_funds', $2, 0,
         'fund_receipt_resolution', $3, 'staff', $4,
         'Synthetic conversion for schema 017 Credit debt regression',
         $5, $6, $7::jsonb
       )`,
      [
        creditAccountId,
        amountMinor,
        resolutionId,
        userId,
        `schema-017-credit-${resolutionId}`,
        `schema-017-resolution-fingerprint-${resolutionId}`,
        JSON.stringify(resolutionResult),
      ],
    );
    await client.query(
      `UPDATE public.fund_receipts
       SET allocated_minor = $2, disposition = 'partially_allocated',
           updated_at = pg_catalog.now()
       WHERE id = $1`,
      [fundReceiptId, amountMinor],
    );
    await client.query("COMMIT");

    const unknownReportId = randomUUID();
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.manual_receipt_outflow_reports(
         id, manual_receipt_id, fund_receipt_id, client_account_id,
         source_context, fund_receipt_resolution_id, amount_minor, currency,
         destination, destination_reference, observed_outcome, occurred_at,
         actor_id, actor_session_id, reauth_grant_id, reason,
         idempotency_key, request_fingerprint, result
       ) VALUES (
         $1, $2, $3, $4, 'converted_credit', $5, $6, 'USD',
         'original_source', $7, 'unknown', NULL, $8, $9, $10,
         'Synthetic unknown outflow reserves converted Credit safely',
         $11, $12, '{}'::jsonb
       )`,
      [
        unknownReportId,
        manualReceiptId,
        fundReceiptId,
        clientAccountId,
        resolutionId,
        amountMinor,
        `UNKNOWN-${unknownReportId}`,
        userId,
        sessionId,
        reauthId,
        `schema-017-unknown-${unknownReportId}`,
        `schema-017-unknown-fingerprint-${unknownReportId}`,
      ],
    );
    await client.query(
      `INSERT INTO public.manual_receipt_credit_holds(
         report_id, credit_account_id, amount_minor, currency
       ) VALUES ($1, $2, $3, 'USD')`,
      [unknownReportId, creditAccountId, amountMinor],
    );
    const competingCreditWriter = await pool.connect();
    try {
      await competingCreditWriter.query("BEGIN");
      await competingCreditWriter.query("SET LOCAL lock_timeout = '250ms'");
      await assert.rejects(
        competingCreditWriter.query(
          `INSERT INTO public.fund_receipt_resolutions(
             fund_receipt_id, client_account_id, action, amount_minor,
             currency, invoice_id, actor_id, reason, idempotency_key,
             request_fingerprint, result
           ) VALUES (
             $1, $2, 'convert_to_credit', 100, 'USD', NULL, $3,
             'Concurrent resolution races unresolved manual receipt outflow',
             $4, $5, '{}'::jsonb
           )`,
          [
            fundReceiptId,
            clientAccountId,
            userId,
            `schema-017-concurrent-resolution-${unknownReportId}`,
            `schema-017-concurrent-resolution-fingerprint-${unknownReportId}`,
          ],
        ),
        (error: unknown) =>
          typeof error === "object" && error !== null && "code" in error
            && error.code === "55P03",
      );
      await competingCreditWriter.query("ROLLBACK");
      await competingCreditWriter.query("BEGIN");
      await competingCreditWriter.query("SET LOCAL lock_timeout = '250ms'");
      await assert.rejects(
        competingCreditWriter.query(
          `INSERT INTO public.credit_transactions(
             credit_account_id, kind, credit_minor, debit_minor,
             source_type, source_id, actor_type, actor_id, reason,
             idempotency_key, request_fingerprint, result
           ) VALUES (
             $1, 'manual_adjustment', 0, 1,
             'schema_017_concurrent_spend', $2, 'staff', $3,
             'Concurrent Credit spend races unresolved manual outflow report',
             $4, $5, '{}'::jsonb
           )`,
          [
            creditAccountId,
            randomUUID(),
            userId,
            `schema-017-concurrent-spend-${unknownReportId}`,
            `schema-017-concurrent-spend-fingerprint-${unknownReportId}`,
          ],
        ),
        (error: unknown) =>
          typeof error === "object" && error !== null && "code" in error
            && error.code === "55P03",
      );
    } finally {
      await competingCreditWriter.query("ROLLBACK").catch(() => undefined);
      competingCreditWriter.release();
    }
    await client.query("COMMIT");

    await assert.rejects(
      client.query(
        `INSERT INTO public.fund_receipt_resolutions(
           fund_receipt_id, client_account_id, action, amount_minor,
           currency, invoice_id, actor_id, reason, idempotency_key,
           request_fingerprint, result
         ) VALUES (
           $1, $2, 'convert_to_credit', 100, 'USD', NULL, $3,
           'Resolution after unresolved manual receipt outflow must fail',
           $4, $5, '{}'::jsonb
         )`,
        [
          fundReceiptId,
          clientAccountId,
          userId,
          `schema-017-frozen-resolution-${unknownReportId}`,
          `schema-017-frozen-resolution-fingerprint-${unknownReportId}`,
        ],
      ),
      /available funds|frozen|outflow-adjusted capacity/,
    );

    await assert.rejects(
      client.query(
        `INSERT INTO public.credit_transactions(
           credit_account_id, kind, credit_minor, debit_minor,
           source_type, source_id, actor_type, actor_id, reason,
           idempotency_key, request_fingerprint, result
         ) VALUES (
           $1, 'manual_adjustment', 0, 1,
           'schema_017_test_spend', $2, 'staff', $3,
           'Synthetic spend must be blocked by unresolved outflow hold',
           $4, $5, '{}'::jsonb
         )`,
        [
          creditAccountId,
          randomUUID(),
          userId,
          `schema-017-held-spend-${unknownReportId}`,
          `schema-017-held-spend-fingerprint-${unknownReportId}`,
        ],
      ),
      /net of unresolved manual outflow holds cannot become negative/,
    );

    const reconciliationId = randomUUID();
    await client.query(
      `INSERT INTO public.manual_receipt_outflow_reconciliations(
         id, report_id, outcome, occurred_at, actor_id, actor_session_id,
         reauth_grant_id, reason, idempotency_key, request_fingerprint, result
       ) VALUES (
         $1, $2, 'confirm_no_outflow', NULL, $3, $4, $5,
         'Synthetic reconciliation confirms no external outflow occurred',
         $6, $7, '{}'::jsonb
       )`,
      [
        reconciliationId,
        unknownReportId,
        userId,
        sessionId,
        reauthId,
        `schema-017-no-outflow-${reconciliationId}`,
        `schema-017-no-outflow-fingerprint-${reconciliationId}`,
      ],
    );

    const remainingResolutionId = randomUUID();
    const remainingResolutionResult = {
      resolutionId: remainingResolutionId,
      amountMinor: "100",
      currency: "USD",
    };
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.fund_receipt_resolutions(
         id, fund_receipt_id, client_account_id, action, amount_minor,
         currency, invoice_id, actor_id, reason, idempotency_key,
         request_fingerprint, result
       ) VALUES (
         $1, $2, $3, 'convert_to_credit', 100, 'USD', NULL, $4,
         'Synthetic resolution wins the reverse outflow concurrency ordering',
         $5, $6, $7::jsonb
       )`,
      [
        remainingResolutionId,
        fundReceiptId,
        clientAccountId,
        userId,
        `schema-017-resolution-first-${remainingResolutionId}`,
        `schema-017-resolution-first-fingerprint-${remainingResolutionId}`,
        JSON.stringify(remainingResolutionResult),
      ],
    );
    await client.query(
      `INSERT INTO public.credit_transactions(
         credit_account_id, kind, credit_minor, debit_minor,
         source_type, source_id, actor_type, actor_id, reason,
         idempotency_key, request_fingerprint, result
       ) VALUES (
         $1, 'unclaimed_funds', 100, 0,
         'fund_receipt_resolution', $2, 'staff', $3,
         'Synthetic resolution wins the reverse outflow concurrency ordering',
         $4, $5, $6::jsonb
       )`,
      [
        creditAccountId,
        remainingResolutionId,
        userId,
        `schema-017-resolution-first-credit-${remainingResolutionId}`,
        `schema-017-resolution-first-fingerprint-${remainingResolutionId}`,
        JSON.stringify(remainingResolutionResult),
      ],
    );
    const remainingJournal = await client.query<{ id: string }>(
      `INSERT INTO public.ledger_journals(source_type, source_id, currency, description)
       VALUES (
         'fund_receipt_resolution', $1, 'USD',
         'Synthetic remaining funds converted to Credit'
       ) RETURNING id`,
      [remainingResolutionId],
    );
    await client.query(
      `INSERT INTO public.ledger_lines(journal_id, account_code, debit_minor, credit_minor)
       VALUES
         ($1, 'unclaimed_funds_liability', 100, 0),
         ($1, 'client_credit_liability', 0, 100)`,
      [remainingJournal.rows[0]?.id],
    );
    await client.query(
      "UPDATE public.ledger_journals SET sealed_at = pg_catalog.now() WHERE id = $1",
      [remainingJournal.rows[0]?.id],
    );
    await client.query(
      `UPDATE public.fund_receipts
       SET allocated_minor = $2, disposition = 'allocated', updated_at = pg_catalog.now()
       WHERE id = $1`,
      [fundReceiptId, receiptAmountMinor],
    );

    const resolutionFirstReportId = randomUUID();
    const competingOutflowWriter = await pool.connect();
    try {
      await competingOutflowWriter.query("BEGIN");
      await competingOutflowWriter.query("SET LOCAL lock_timeout = '250ms'");
      await assert.rejects(
        competingOutflowWriter.query(
          `INSERT INTO public.manual_receipt_outflow_reports(
             id, manual_receipt_id, fund_receipt_id, client_account_id,
             source_context, fund_receipt_resolution_id, amount_minor, currency,
             destination, destination_reference, observed_outcome, occurred_at,
             actor_id, actor_session_id, reauth_grant_id, reason,
             idempotency_key, request_fingerprint, result
           ) VALUES (
             $1, $2, $3, $4, 'unclaimed_funds', NULL, 100, 'USD',
             'original_source', $5, 'unknown', NULL, $6, $7, $8,
             'Concurrent unclaimed outflow loses to the committed resolution',
             $9, $10, '{}'::jsonb
           )`,
          [
            resolutionFirstReportId,
            manualReceiptId,
            fundReceiptId,
            clientAccountId,
            `RESOLUTION-FIRST-${resolutionFirstReportId}`,
            userId,
            sessionId,
            reauthId,
            `schema-017-resolution-first-report-${resolutionFirstReportId}`,
            `schema-017-resolution-first-report-fingerprint-${resolutionFirstReportId}`,
          ],
        ),
        (error: unknown) =>
          typeof error === "object" && error !== null && "code" in error
            && error.code === "55P03",
      );
    } finally {
      await competingOutflowWriter.query("ROLLBACK").catch(() => undefined);
      competingOutflowWriter.release();
    }
    await client.query("COMMIT");

    await assert.rejects(
      client.query(
        `INSERT INTO public.manual_receipt_outflow_reports(
           id, manual_receipt_id, fund_receipt_id, client_account_id,
           source_context, fund_receipt_resolution_id, amount_minor, currency,
           destination, destination_reference, observed_outcome, occurred_at,
           actor_id, actor_session_id, reauth_grant_id, reason,
           idempotency_key, request_fingerprint, result
         ) VALUES (
           $1, $2, $3, $4, 'unclaimed_funds', NULL, 100, 'USD',
           'original_source', $5, 'unknown', NULL, $6, $7, $8,
           'Unclaimed outflow cannot consume capacity won by resolution',
           $9, $10, '{}'::jsonb
         )`,
        [
          resolutionFirstReportId,
          manualReceiptId,
          fundReceiptId,
          clientAccountId,
          `RESOLUTION-FIRST-${resolutionFirstReportId}`,
          userId,
          sessionId,
          reauthId,
          `schema-017-resolution-first-report-${resolutionFirstReportId}`,
          `schema-017-resolution-first-report-fingerprint-${resolutionFirstReportId}`,
        ],
      ),
      /exceeds or mismatches/,
    );

    await client.query(
      `INSERT INTO public.credit_transactions(
         credit_account_id, kind, credit_minor, debit_minor,
         source_type, source_id, actor_type, actor_id, reason,
         idempotency_key, request_fingerprint, result
       ) VALUES (
         $1, 'manual_adjustment', 0, $2,
         'schema_017_test_spend', $3, 'staff', $4,
         'Synthetic customer consumed converted Credit before confirmed outflow',
         $5, $6, '{}'::jsonb
       )`,
      [
        creditAccountId,
        receiptAmountMinor,
        randomUUID(),
        userId,
        `schema-017-consumed-credit-${resolutionId}`,
        `schema-017-consumed-credit-fingerprint-${resolutionId}`,
      ],
    );

    const reportId = randomUUID();
    const outflowId = randomUUID();
    const effectId = randomUUID();
    const outflowOccurredAt = new Date().toISOString();
    const outflowResult = { outflowId, amountMinor: amountMinor.toString() };
    const outflowIdempotencyKey = `schema-017-confirmed-${reportId}`;
    const outflowFingerprint = `schema-017-confirmed-fingerprint-${reportId}`;
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.manual_receipt_outflow_reports(
         id, manual_receipt_id, fund_receipt_id, client_account_id,
         source_context, fund_receipt_resolution_id, amount_minor, currency,
         destination, destination_reference, observed_outcome, occurred_at,
         actor_id, actor_session_id, reauth_grant_id, reason,
         idempotency_key, request_fingerprint, result
       ) VALUES (
         $1, $2, $3, $4, 'converted_credit', $5, $6, 'USD',
         'original_source', $7, 'confirmed', $8, $9, $10, $11,
         'Synthetic confirmed outflow after converted Credit was consumed',
         $12, $13, $14::jsonb
       )`,
      [
        reportId,
        manualReceiptId,
        fundReceiptId,
        clientAccountId,
        resolutionId,
        amountMinor,
        `CONFIRMED-${reportId}`,
        outflowOccurredAt,
        userId,
        sessionId,
        reauthId,
        outflowIdempotencyKey,
        outflowFingerprint,
        JSON.stringify(outflowResult),
      ],
    );
    await client.query(
      `INSERT INTO public.manual_receipt_outflows(
         id, report_id, manual_receipt_id, fund_receipt_id,
         client_account_id, source_context, fund_receipt_resolution_id,
         amount_minor, currency, destination_reference, occurred_at,
         actor_id, actor_session_id, reauth_grant_id, reason,
         idempotency_key, request_fingerprint, result
       ) VALUES (
         $1, $2, $3, $4, $5, 'converted_credit', $6, $7, 'USD', $8, $9,
         $10, $11, $12,
         'Synthetic confirmed outflow after converted Credit was consumed',
         $13, $14, $15::jsonb
       )`,
      [
        outflowId,
        reportId,
        manualReceiptId,
        fundReceiptId,
        clientAccountId,
        resolutionId,
        amountMinor,
        `CONFIRMED-${reportId}`,
        outflowOccurredAt,
        userId,
        sessionId,
        reauthId,
        outflowIdempotencyKey,
        outflowFingerprint,
        JSON.stringify(outflowResult),
      ],
    );
    await client.query(
      `INSERT INTO public.manual_receipt_credit_outflow_effects(
         id, outflow_id, credit_account_id, client_account_id,
         credit_recovered_minor, debt_minor, currency
       ) VALUES ($1, $2, $3, $4, 0, $5, 'USD')`,
      [effectId, outflowId, creditAccountId, clientAccountId, amountMinor],
    );
    await client.query(
      `INSERT INTO public.client_account_debt_accounts(client_account_id, currency)
       VALUES ($1, 'USD') ON CONFLICT (client_account_id, currency) DO NOTHING`,
      [clientAccountId],
    );
    const debtAccount = await client.query<{ id: string }>(
      `SELECT id FROM public.client_account_debt_accounts
       WHERE client_account_id = $1 AND currency = 'USD' FOR UPDATE`,
      [clientAccountId],
    );
    await client.query(
      `INSERT INTO public.client_account_debt_transactions(
         debt_account_id, kind, debit_minor, credit_minor, source_type,
         source_id, actor_type, actor_id, reason, idempotency_key
       ) VALUES (
         $1, 'manual_receipt_outflow', $2, 0,
         'manual_receipt_credit_outflow_effect', $3, 'staff', $4,
         'Converted Credit was consumed before confirmed external outflow', $5
       )`,
      [
        debtAccount.rows[0]?.id,
        amountMinor,
        effectId,
        userId,
        `schema-017-outflow-debt-${effectId}`,
      ],
    );
    await client.query(
      `INSERT INTO public.manual_receipt_credit_outflow_restrictions(
         effect_id, client_account_id, reason
       ) VALUES (
         $1, $2, 'Outstanding debt after confirmed manual receipt outflow'
       )`,
      [effectId, clientAccountId],
    );
    const outflowJournal = await client.query<{ id: string }>(
      `INSERT INTO public.ledger_journals(source_type, source_id, currency, description)
       VALUES (
         'manual_receipt_outflow', $1, 'USD',
         'Confirmed manual receipt outflow with consumed Credit debt'
       ) RETURNING id`,
      [outflowId],
    );
    await client.query(
      `INSERT INTO public.ledger_lines(journal_id, account_code, debit_minor, credit_minor)
       VALUES
         ($1, 'chargeback_receivable', $2, 0),
         ($1, 'cash_clearing', 0, $2)`,
      [outflowJournal.rows[0]?.id, amountMinor],
    );
    await client.query(
      "UPDATE public.ledger_journals SET sealed_at = pg_catalog.now() WHERE id = $1",
      [outflowJournal.rows[0]?.id],
    );
    await client.query("COMMIT");

    const result = await client.query<{
      credit_balance_minor: string;
      debt_minor: string;
      restricted: boolean;
      journal_debit_minor: string;
      journal_credit_minor: string;
    }>(
      `SELECT
         (SELECT COALESCE(pg_catalog.sum(credit_minor - debit_minor), 0)::text
          FROM public.credit_transactions
          WHERE credit_account_id = $1) AS credit_balance_minor,
         (SELECT COALESCE(pg_catalog.sum(transaction.debit_minor - transaction.credit_minor), 0)::text
          FROM public.client_account_debt_transactions transaction
          JOIN public.client_account_debt_accounts account
            ON account.id = transaction.debt_account_id
          WHERE account.client_account_id = $2 AND account.currency = 'USD') AS debt_minor,
         (SELECT restricted_at IS NOT NULL FROM public.client_accounts WHERE id = $2)
           AS restricted,
         (SELECT pg_catalog.sum(line.debit_minor)::text
          FROM public.ledger_journals journal
          JOIN public.ledger_lines line ON line.journal_id = journal.id
          WHERE journal.source_type = 'manual_receipt_outflow'
            AND journal.source_id = $3) AS journal_debit_minor,
         (SELECT pg_catalog.sum(line.credit_minor)::text
          FROM public.ledger_journals journal
          JOIN public.ledger_lines line ON line.journal_id = journal.id
          WHERE journal.source_type = 'manual_receipt_outflow'
            AND journal.source_id = $3) AS journal_credit_minor`,
      [creditAccountId, clientAccountId, outflowId],
    );
    assert.deepEqual(result.rows[0], {
      credit_balance_minor: "0",
      debt_minor: amountMinor.toString(),
      restricted: true,
      journal_debit_minor: amountMinor.toString(),
      journal_credit_minor: amountMinor.toString(),
    });
    await assert.rejects(
      client.query(
        "UPDATE public.client_accounts SET restricted_at = NULL WHERE id = $1",
        [clientAccountId],
      ),
      /active financial restriction cannot be changed directly/,
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});

test("an allocated-invoice outflow is a refund and never reopens the paid invoice", async () => {
  const client = await pool.connect();
  const userId = randomUUID();
  const clientAccountId = randomUUID();
  const sessionId = randomUUID();
  const reauthId = randomUUID();
  const manualReceiptId = randomUUID();
  const fundReceiptId = randomUUID();
  const invoiceId = randomUUID();
  const resolutionId = randomUUID();
  const reportId = randomUUID();
  const outflowId = randomUUID();
  const amountMinor = 500;
  const receivedAt = new Date(Date.now() - 120_000).toISOString();
  const occurredAt = new Date().toISOString();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.users(id, email, password_hash, email_verified_at)
       VALUES ($1, $2, 'synthetic-not-a-password', pg_catalog.now())`,
      [userId, `schema-017-invoice-refund-${userId}@example.invalid`],
    );
    await client.query(
      `INSERT INTO public.client_accounts(id, name, owner_user_id)
       VALUES ($1, 'Synthetic allocated invoice refund account', $2)`,
      [clientAccountId, userId],
    );
    await client.query(
      `INSERT INTO public.sessions(id, user_id, token_digest, expires_at)
       VALUES ($1, $2, $3, pg_catalog.now() + interval '1 hour')`,
      [sessionId, userId, `schema-017-invoice-refund-${sessionId}`],
    );
    await client.query(
      `INSERT INTO public.reauth_grants(
         id, user_id, session_id, created_at, expires_at
       ) VALUES ($1, $2, $3, pg_catalog.now(), pg_catalog.now() + interval '15 minutes')`,
      [reauthId, userId, sessionId],
    );
    await client.query(
      `INSERT INTO public.staff_members(user_id, roles, permissions)
       VALUES (
         $1, ARRAY['Billing'],
         '["billing.manual_receipt_manage", "billing.refund_manage"]'::jsonb
       )`,
      [userId],
    );
    await client.query(
      `INSERT INTO public.invoices(
         id, client_account_id, currency, total_minor, due_at
       ) VALUES ($1, $2, 'USD', $3, pg_catalog.now() + interval '7 days')`,
      [invoiceId, clientAccountId, amountMinor],
    );
    await client.query(
      `INSERT INTO public.invoice_lines(
         invoice_id, kind, description, amount_minor
       ) VALUES ($1, 'one_time', 'Synthetic invoice paid from manual funds', $2)`,
      [invoiceId, amountMinor],
    );
    await client.query(
      `INSERT INTO public.manual_receipt_facts(
         id, client_account_id, reference, received_at, gross_amount_minor,
         fee_minor, currency, actor_id, reason, idempotency_key,
         request_fingerprint, result
       ) VALUES (
         $1, $2, $3, $4, $5, 0, 'USD', $6,
         'Synthetic manual receipt allocated to a paid invoice',
         $7, $8, '{}'::jsonb
       )`,
      [
        manualReceiptId,
        clientAccountId,
        `SCHEMA-017-INVOICE-${manualReceiptId}`,
        receivedAt,
        amountMinor,
        userId,
        `schema-017-invoice-receipt-${manualReceiptId}`,
        `schema-017-invoice-receipt-fingerprint-${manualReceiptId}`,
      ],
    );
    await client.query(
      `INSERT INTO public.fund_receipts(
         id, provider_installation_id, external_payment_id,
         reported_payment_attempt_id, reported_add_funds_attempt_id,
         reported_manual_receipt_id, client_account_id, amount_minor,
         allocated_minor, currency, occurred_at, disposition, reason
       ) VALUES (
         $1, NULL, NULL, NULL, NULL, $2, $3, $4, 0, 'USD', $5,
         'unclaimed', 'Synthetic manual receipt for allocated invoice refund'
       )`,
      [fundReceiptId, manualReceiptId, clientAccountId, amountMinor, receivedAt],
    );
    const receiptJournal = await client.query<{ id: string }>(
      `INSERT INTO public.ledger_journals(source_type, source_id, currency, description)
       VALUES ('manual_receipt', $1, 'USD', 'Synthetic allocated invoice receipt')
       RETURNING id`,
      [manualReceiptId],
    );
    await client.query(
      `INSERT INTO public.ledger_lines(journal_id, account_code, debit_minor, credit_minor)
       VALUES
         ($1, 'cash_clearing', $2, 0),
         ($1, 'unclaimed_funds_liability', 0, $2)`,
      [receiptJournal.rows[0]?.id, amountMinor],
    );
    await client.query(
      "UPDATE public.ledger_journals SET sealed_at = pg_catalog.now() WHERE id = $1",
      [receiptJournal.rows[0]?.id],
    );
    await client.query("COMMIT");

    await client.query("BEGIN");
    const resolutionResult = {
      resolutionId,
      invoiceId,
      amountMinor: amountMinor.toString(),
      currency: "USD",
    };
    const resolutionFingerprint = `schema-017-invoice-resolution-fingerprint-${resolutionId}`;
    const resolutionKey = `schema-017-invoice-resolution-${resolutionId}`;
    await client.query(
      `INSERT INTO public.fund_receipt_resolutions(
         id, fund_receipt_id, client_account_id, action, amount_minor,
         currency, invoice_id, actor_id, reason, idempotency_key,
         request_fingerprint, result
       ) VALUES (
         $1, $2, $3, 'allocate_invoice', $4, 'USD', $5, $6,
         'Synthetic manual funds settle the invoice before a later refund',
         $7, $8, $9::jsonb
       )`,
      [
        resolutionId,
        fundReceiptId,
        clientAccountId,
        amountMinor,
        invoiceId,
        userId,
        resolutionKey,
        resolutionFingerprint,
        JSON.stringify(resolutionResult),
      ],
    );
    await client.query(
      `INSERT INTO public.fund_receipt_allocations(
         resolution_id, fund_receipt_id, invoice_id, amount_minor
       ) VALUES ($1, $2, $3, $4)`,
      [resolutionId, fundReceiptId, invoiceId, amountMinor],
    );
    await client.query(
      `INSERT INTO public.fund_receipt_resolution_requests(
         idempotency_key, fund_receipt_id, request_fingerprint, resolution_id
       ) VALUES ($1, $2, $3, $4)`,
      [resolutionKey, fundReceiptId, resolutionFingerprint, resolutionId],
    );
    const resolutionJournal = await client.query<{ id: string }>(
      `INSERT INTO public.ledger_journals(source_type, source_id, currency, description)
       VALUES (
         'fund_receipt_resolution', $1, 'USD',
         'Synthetic manual funds allocated to invoice'
       ) RETURNING id`,
      [resolutionId],
    );
    await client.query(
      `INSERT INTO public.ledger_lines(journal_id, account_code, debit_minor, credit_minor)
       VALUES
         ($1, 'unclaimed_funds_liability', $2, 0),
         ($1, 'accounts_receivable', 0, $2)`,
      [resolutionJournal.rows[0]?.id, amountMinor],
    );
    await client.query(
      "UPDATE public.ledger_journals SET sealed_at = pg_catalog.now() WHERE id = $1",
      [resolutionJournal.rows[0]?.id],
    );
    await client.query(
      `UPDATE public.fund_receipts
       SET allocated_minor = $2, disposition = 'allocated', updated_at = pg_catalog.now()
       WHERE id = $1`,
      [fundReceiptId, amountMinor],
    );
    await client.query("COMMIT");

    const invoiceSnapshot = async () => {
      const result = await client.query<{
        total_minor: string;
        allocated_minor: string;
        delinquency_allocated_minor: string;
        fund_allocation_minor: string;
      }>(
        `SELECT
           invoice.total_minor::text,
           allocation.allocated_minor::text,
           delinquency.allocated_minor::text AS delinquency_allocated_minor,
           (SELECT pg_catalog.sum(source.amount_minor)::text
            FROM public.fund_receipt_allocations source
            WHERE source.invoice_id = invoice.id) AS fund_allocation_minor
         FROM public.invoices invoice
         JOIN public.invoice_allocation_totals allocation
           ON allocation.invoice_id = invoice.id
         JOIN public.invoice_delinquency_allocation_totals delinquency
           ON delinquency.invoice_id = invoice.id
         WHERE invoice.id = $1`,
        [invoiceId],
      );
      assert.ok(result.rows[0]);
      return result.rows[0];
    };
    const paidSnapshot = await invoiceSnapshot();
    assert.deepEqual(paidSnapshot, {
      total_minor: amountMinor.toString(),
      allocated_minor: amountMinor.toString(),
      delinquency_allocated_minor: amountMinor.toString(),
      fund_allocation_minor: amountMinor.toString(),
    });

    const outflowResult = { outflowId, amountMinor: amountMinor.toString(), currency: "USD" };
    const outflowKey = `schema-017-invoice-refund-${reportId}`;
    const outflowFingerprint = `schema-017-invoice-refund-fingerprint-${reportId}`;
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.manual_receipt_outflow_reports(
         id, manual_receipt_id, fund_receipt_id, client_account_id,
         source_context, fund_receipt_resolution_id, amount_minor, currency,
         destination, destination_reference, observed_outcome, occurred_at,
         actor_id, actor_session_id, reauth_grant_id, reason,
         idempotency_key, request_fingerprint, result
       ) VALUES (
         $1, $2, $3, $4, 'allocated_invoice', $5, $6, 'USD',
         'original_source', $7, 'confirmed', $8, $9, $10, $11,
         'Synthetic refund preserves the paid invoice and service facts',
         $12, $13, $14::jsonb
       )`,
      [
        reportId,
        manualReceiptId,
        fundReceiptId,
        clientAccountId,
        resolutionId,
        amountMinor,
        `INVOICE-REFUND-${reportId}`,
        occurredAt,
        userId,
        sessionId,
        reauthId,
        outflowKey,
        outflowFingerprint,
        JSON.stringify(outflowResult),
      ],
    );
    await client.query(
      `INSERT INTO public.manual_receipt_outflows(
         id, report_id, manual_receipt_id, fund_receipt_id,
         client_account_id, source_context, fund_receipt_resolution_id,
         amount_minor, currency, destination_reference, occurred_at,
         actor_id, actor_session_id, reauth_grant_id, reason,
         idempotency_key, request_fingerprint, result
       ) VALUES (
         $1, $2, $3, $4, $5, 'allocated_invoice', $6, $7, 'USD', $8, $9,
         $10, $11, $12,
         'Synthetic refund preserves the paid invoice and service facts',
         $13, $14, $15::jsonb
       )`,
      [
        outflowId,
        reportId,
        manualReceiptId,
        fundReceiptId,
        clientAccountId,
        resolutionId,
        amountMinor,
        `INVOICE-REFUND-${reportId}`,
        occurredAt,
        userId,
        sessionId,
        reauthId,
        outflowKey,
        outflowFingerprint,
        JSON.stringify(outflowResult),
      ],
    );
    const outflowJournal = await client.query<{ id: string }>(
      `INSERT INTO public.ledger_journals(source_type, source_id, currency, description)
       VALUES (
         'manual_receipt_outflow', $1, 'USD',
         'Synthetic refund after manual funds paid an invoice'
       ) RETURNING id`,
      [outflowId],
    );
    await client.query(
      `INSERT INTO public.ledger_lines(journal_id, account_code, debit_minor, credit_minor)
       VALUES
         ($1, 'sales_refunds_and_allowances', $2, 0),
         ($1, 'cash_clearing', 0, $2)`,
      [outflowJournal.rows[0]?.id, amountMinor],
    );
    await client.query(
      "UPDATE public.ledger_journals SET sealed_at = pg_catalog.now() WHERE id = $1",
      [outflowJournal.rows[0]?.id],
    );
    await client.query("COMMIT");

    assert.deepEqual(await invoiceSnapshot(), paidSnapshot);
    assert.equal(
      (await client.query(
        "SELECT pg_catalog.to_regclass('public.manual_receipt_invoice_allocation_reversals') AS relation",
      )).rows[0]?.relation,
      null,
    );
    const ledger = await client.query<{
      refund_debit_minor: string;
      cash_credit_minor: string;
      accounts_receivable_debit_minor: string;
    }>(
      `SELECT
         COALESCE(pg_catalog.sum(line.debit_minor) FILTER (
           WHERE line.account_code = 'sales_refunds_and_allowances'), 0)::text
           AS refund_debit_minor,
         COALESCE(pg_catalog.sum(line.credit_minor) FILTER (
           WHERE line.account_code = 'cash_clearing'), 0)::text
           AS cash_credit_minor,
         COALESCE(pg_catalog.sum(line.debit_minor) FILTER (
           WHERE line.account_code = 'accounts_receivable'), 0)::text
           AS accounts_receivable_debit_minor
       FROM public.ledger_journals journal
       JOIN public.ledger_lines line ON line.journal_id = journal.id
       WHERE journal.source_type = 'manual_receipt_outflow'
         AND journal.source_id = $1`,
      [outflowId],
    );
    assert.deepEqual(ledger.rows[0], {
      refund_debit_minor: amountMinor.toString(),
      cash_credit_minor: amountMinor.toString(),
      accounts_receivable_debit_minor: "0",
    });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});

test("role-schema and public built-in shadows cannot spoof schema 017", async () => {
  const client = await pool.connect();
  try {
    const role = await client.query<{ current_user: string }>(
      "SELECT current_user",
    );
    const roleName = role.rows[0]?.current_user;
    assert.ok(roleName);
    const quotedRoleSchema = `"${roleName.replaceAll('"', '""')}"`;
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${quotedRoleSchema}`);
    await client.query(
      `CREATE TABLE ${quotedRoleSchema}.schema_migrations(
         version text PRIMARY KEY, applied_at timestamptz NOT NULL
       )`,
    );
    await client.query(
      `INSERT INTO ${quotedRoleSchema}.schema_migrations(version, applied_at)
       VALUES ('999_counterfeit', pg_catalog.now())`,
    );
    await client.query(
      `CREATE FUNCTION public.max(text) RETURNS text
       LANGUAGE sql IMMUTABLE AS 'SELECT $1'`,
    );
    await client.query(`SET LOCAL search_path TO "$user", public`);
    assert.equal(
      (await assertSchema017NativeSafe({
        query: async (text, values) => client.query(text, values),
      })).installedSchemaVersion,
      SCHEMA_017,
    );
    await client.query("ROLLBACK");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});

test("known pending job claims have the pinned selective index path", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.durable_jobs(
         id, job_type, unique_key, payload, status, available_at, created_at
       )
       SELECT pg_catalog.gen_random_uuid(), 'future.unknown',
              'schema-017-index-unknown-' || series::text,
              '{}'::jsonb, 'pending',
              pg_catalog.now() - interval '1 minute',
              pg_catalog.now() - interval '1 minute'
       FROM pg_catalog.generate_series(1, 4000) series`,
    );
    await client.query(
      `INSERT INTO public.durable_jobs(
         job_type, unique_key, payload, status, available_at, created_at
       ) VALUES (
         'notification.send', 'schema-017-index-known', '{}', 'pending',
         pg_catalog.now(), pg_catalog.now()
       )`,
    );
    await client.query("ANALYZE public.durable_jobs");
    await client.query("SET LOCAL enable_seqscan = off");
    const explained = await client.query<{ "QUERY PLAN": unknown }>(
      `EXPLAIN (FORMAT JSON)
       SELECT id
       FROM public.durable_jobs
       WHERE status = 'pending'
         AND job_type IN ('notification.send', 'payment.start')
         AND available_at <= pg_catalog.now()
       ORDER BY available_at, created_at
       LIMIT 1`,
    );
    assert.match(
      JSON.stringify(explained.rows[0]?.["QUERY PLAN"]),
      /durable_jobs_pending_type_available_created_idx/,
    );
    await client.query("ROLLBACK");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});

test("schema-017 marker INSERT and UPDATE conflict with a live rollback bridge", async () => {
  const guard = await pool.connect();
  const writer = await pool.connect();
  const updateTarget = randomUUID();
  try {
    await pool.query(
      `INSERT INTO public.durable_jobs(
         id, job_type, unique_key, payload, status
       ) VALUES ($1, 'notification.send', $2, $3::jsonb, 'pending')`,
      [
        updateTarget,
        `schema-017-marker-update-${updateTarget}`,
        JSON.stringify({ messageId: updateTarget }),
      ],
    );
    await guard.query(
      "SELECT pg_catalog.pg_advisory_lock_shared(pg_catalog.hashtextextended($1, 0))",
      [SCHEMA_016_017_GUARD],
    );

    await writer.query("BEGIN");
    await writer.query("SET LOCAL lock_timeout = '250ms'");
    await assert.rejects(
      writer.query(
        `INSERT INTO public.ledger_journals(
           source_type, source_id, currency, description
         ) VALUES ('manual_receipt_outflow', $1, 'USD', 'synthetic blocked insert')`,
        [randomUUID()],
      ),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error
          && (error as { code: string }).code === "55P03",
    );
    await writer.query("ROLLBACK");

    await writer.query("BEGIN");
    await writer.query("SET LOCAL lock_timeout = '250ms'");
    await assert.rejects(
      writer.query(
        `UPDATE public.durable_jobs
         SET payload = $2::jsonb
         WHERE id = $1`,
        [
          updateTarget,
          JSON.stringify({ manualReceiptOutflowReportId: randomUUID() }),
        ],
      ),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error
          && (error as { code: string }).code === "55P03",
    );
    await writer.query("ROLLBACK");
  } finally {
    await writer.query("ROLLBACK").catch(() => undefined);
    writer.release();
    await guard.query(
      "SELECT pg_catalog.pg_advisory_unlock_shared(pg_catalog.hashtextextended($1, 0))",
      [SCHEMA_016_017_GUARD],
    ).catch(() => undefined);
    guard.release();
    await pool.query("DELETE FROM public.durable_jobs WHERE id = $1", [updateTarget]);
  }
});

test("017-only facts block the 016 bridge", async () => {
  const client = await pool.connect();
  const sourceId = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.ledger_journals(source_type, source_id, currency, description)
       VALUES ('manual_receipt_outflow', $1, 'USD', 'synthetic rollback blocker')`,
      [sourceId],
    );
    await assert.rejects(
      assertSchema016RollbackBridgeSafe(
        { query: async (text, values) => client.query(text, values) },
        { enable017RollbackBridge: true },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /cannot understand/);
        return true;
      },
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});

test("a claimed running job cannot be changed into a schema-017 job", async () => {
  const client = await pool.connect();
  const jobId = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.durable_jobs(
         id, job_type, unique_key, payload, status
       ) VALUES ($1, 'notification.send', $2, $3::jsonb, 'pending')`,
      [jobId, `schema-017-running-job-${jobId}`, JSON.stringify({ messageId: jobId })],
    );
    await client.query(
      "UPDATE public.durable_jobs SET payload = $2::jsonb WHERE id = $1",
      [jobId, JSON.stringify({ messageId: jobId, retry: "allowed-while-pending" })],
    );
    await client.query(
      `UPDATE public.durable_jobs
       SET status = 'running', locked_at = pg_catalog.now(), locked_by = 'schema-017-test'
       WHERE id = $1`,
      [jobId],
    );
    await client.query(
      `UPDATE public.durable_jobs
       SET last_error = 'legitimate running lease metadata update',
           updated_at = pg_catalog.now()
       WHERE id = $1`,
      [jobId],
    );
    await client.query("SAVEPOINT before_running_delete");
    await assert.rejects(
      client.query("DELETE FROM public.durable_jobs WHERE id = $1", [jobId]),
      /running durable job cannot be deleted/,
    );
    await client.query("ROLLBACK TO SAVEPOINT before_running_delete");
    await client.query("SAVEPOINT before_identity_attack");
    await assert.rejects(
      client.query(
        `UPDATE public.durable_jobs
         SET status = 'completed',
             job_type = 'manual_receipt_outflow.reconcile',
             payload = $2::jsonb
         WHERE id = $1`,
        [jobId, JSON.stringify({ manualReceiptOutflowReportId: randomUUID() })],
      ),
      /running durable job cannot change type, identity, or payload/,
    );
    await client.query("ROLLBACK TO SAVEPOINT before_identity_attack");
    const unchanged = await client.query<{
      status: string;
      job_type: string;
      payload: Record<string, unknown>;
    }>(
      "SELECT status, job_type, payload FROM public.durable_jobs WHERE id = $1",
      [jobId],
    );
    assert.equal(unchanged.rows[0]?.status, "running");
    assert.equal(unchanged.rows[0]?.job_type, "notification.send");
    assert.deepEqual(unchanged.rows[0]?.payload, {
      messageId: jobId,
      retry: "allowed-while-pending",
    });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});

test("trigger, function, and view drift fail exact native attestation", async () => {
  const client = await pool.connect();
  try {
    const mutations = [
      "ALTER TABLE public.manual_receipt_outflow_reports DISABLE TRIGGER a_schema_017_outflow_report_marker_guard",
      "ALTER TABLE public.credit_transactions DISABLE TRIGGER credit_balance_guard",
      "ALTER TABLE public.fund_receipt_resolutions DISABLE TRIGGER fund_receipt_resolution_guard",
      "ALTER TABLE public.fund_receipt_resolutions DISABLE TRIGGER fund_receipt_resolutions_append_only",
      "ALTER TABLE public.client_account_debt_transactions DISABLE TRIGGER manual_receipt_outflow_debt_source_guard",
      "ALTER TABLE public.manual_receipt_credit_holds DISABLE TRIGGER manual_receipt_credit_hold_guard",
      "ALTER TABLE public.manual_receipt_credit_outflow_restrictions DISABLE TRIGGER manual_receipt_outflow_restriction_source_guard",
      `CREATE OR REPLACE FUNCTION public.opensales_guard_credit_balance()
       RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
      `CREATE OR REPLACE FUNCTION public.opensales_validate_fund_receipt_resolution()
       RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
      `CREATE OR REPLACE FUNCTION public.opensales_reject_manual_receipt_provider_artifact()
       RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
      `CREATE OR REPLACE VIEW public.manual_receipt_outflow_capacity AS
       SELECT NULL::uuid AS manual_receipt_id, NULL::uuid AS fund_receipt_id,
              NULL::uuid AS client_account_id, NULL::text AS source_context,
              NULL::uuid AS fund_receipt_resolution_id, NULL::text AS currency,
              0::bigint AS source_amount_minor, 0::bigint AS confirmed_outflow_minor,
              false AS capacity_frozen, 0::bigint AS available_minor`,
    ];
    for (const mutation of mutations) {
      await client.query("BEGIN");
      await client.query(mutation);
      await assert.rejects(
        assertSchema017NativeSafe({
          query: async (text, values) => client.query(text, values),
        }),
        /incomplete or counterfeit/,
      );
      await client.query("ROLLBACK");
    }
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});

test.after(async () => {
  await pool.end();
});
