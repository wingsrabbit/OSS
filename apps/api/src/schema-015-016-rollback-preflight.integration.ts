// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import {
  assert015RollbackBridgeSafe,
  SCHEMA_015_016_GUARD,
  SCHEMA_016,
} from "@opensales/core/schema-015-016-rollback-compatibility";
import {
  SCHEMA_015,
  SchemaRollbackPreflightError,
} from "@opensales/core/schema-rollback-compatibility";
import pg from "pg";
import {
  assertSchemaCompatible,
  holdSchema015RollbackBridgeGuard,
  runMigrations,
} from "./database.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for 015 rollback integration");

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 4,
  statement_timeout: 15_000,
  application_name: "opensales-schema-015-016-rollback-integration",
});
const client = await pool.connect();
const database = {
  query: async (text: string, values?: unknown[]) => client.query(text, values),
};

try {
  const installed = await client.query<{ version: string | null }>(
    "SELECT max(version) AS version FROM schema_migrations",
  );
  assert.equal(installed.rows[0]?.version, SCHEMA_015);
  const native = await assertSchemaCompatible(pool);
  assert.equal(native.mode, "native");

  const releaseGuard = await holdSchema015RollbackBridgeGuard(pool);
  const contender = new pg.Client({ connectionString: databaseUrl });
  await contender.connect();
  try {
    await assert.rejects(
      runMigrations(pool),
      /blocked by a running compatibility-bridge API or Worker/,
    );
    await contender.query("SET lock_timeout = '200ms'");
    await contender.query(
      "SELECT pg_advisory_lock(hashtextextended('opensales:schema-migrations', 0))",
    );
    await contender.query(
      "SELECT pg_advisory_unlock(hashtextextended('opensales:schema-migrations', 0))",
    );
    await assert.rejects(
      contender.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
        SCHEMA_015_016_GUARD,
      ]),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "55P03",
    );
    await releaseGuard();
    await contender.query("SET lock_timeout = '2s'");
    await contender.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
      SCHEMA_015_016_GUARD,
    ]);
    await contender.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
      SCHEMA_015_016_GUARD,
    ]);
  } finally {
    await contender.end();
  }

  await client.query("BEGIN");
  await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [SCHEMA_016]);
  await client.query("CREATE SCHEMA AUTHORIZATION CURRENT_USER");
  await client.query('SET LOCAL search_path TO "$user", public');
  await client.query(`
    CREATE TABLE schema_migrations(
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [SCHEMA_015]);
  await assert.rejects(
    assert015RollbackBridgeSafe(database, { enable016RollbackBridge: true }),
    /incomplete or counterfeit/,
  );
  await client.query("SET LOCAL search_path TO public, pg_catalog");
  await assert.rejects(
    assert015RollbackBridgeSafe(database, { enable016RollbackBridge: false }),
    /OSS_SCHEMA_ROLLBACK_BRIDGE=015-to-016/,
  );
  await assert.rejects(
    assert015RollbackBridgeSafe(database, { enable016RollbackBridge: true }),
    /incomplete or counterfeit/,
  );

  await client.query(`
    ALTER TABLE fund_receipts
      ALTER COLUMN provider_installation_id DROP NOT NULL,
      ALTER COLUMN external_payment_id DROP NOT NULL,
      ADD COLUMN reported_manual_receipt_id uuid;
    ALTER TABLE fund_receipts
      DROP CONSTRAINT fund_receipts_exactly_one_attempt,
      DROP CONSTRAINT fund_receipts_disposition_check;

    CREATE TABLE manual_receipt_facts(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_account_id uuid NOT NULL REFERENCES client_accounts(id),
      reference text NOT NULL,
      received_at timestamptz NOT NULL,
      gross_amount_minor bigint NOT NULL CHECK (gross_amount_minor > 0),
      fee_minor bigint NOT NULL CHECK (fee_minor >= 0 AND fee_minor <= gross_amount_minor),
      currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      actor_id uuid NOT NULL REFERENCES users(id),
      reason text NOT NULL,
      idempotency_key text NOT NULL UNIQUE,
      request_fingerprint text NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(client_account_id, reference)
    );
    ALTER TABLE fund_receipts
      ADD CONSTRAINT fund_receipts_reported_manual_receipt_id_fkey
        FOREIGN KEY (reported_manual_receipt_id) REFERENCES manual_receipt_facts(id),
      ADD CONSTRAINT fund_receipts_exactly_one_source CHECK (
        num_nonnulls(
          reported_payment_attempt_id,
          reported_add_funds_attempt_id,
          reported_manual_receipt_id
        ) = 1
      ),
      ADD CONSTRAINT fund_receipts_source_provider_fields CHECK (
        (reported_manual_receipt_id IS NOT NULL
          AND provider_installation_id IS NULL
          AND external_payment_id IS NULL)
        OR
        (reported_manual_receipt_id IS NULL
          AND provider_installation_id IS NOT NULL
          AND external_payment_id IS NOT NULL)
      ),
      ADD CONSTRAINT fund_receipts_disposition_check CHECK (
        disposition IN (
          'received', 'allocated', 'partially_allocated', 'unclaimed',
          'charged_back', 'reversed'
        )
      );

    CREATE TABLE manual_receipt_reversals(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      manual_receipt_id uuid NOT NULL UNIQUE REFERENCES manual_receipt_facts(id),
      fund_receipt_id uuid NOT NULL UNIQUE REFERENCES fund_receipts(id),
      actor_id uuid NOT NULL REFERENCES users(id),
      reason text NOT NULL,
      idempotency_key text NOT NULL UNIQUE,
      request_fingerprint text NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE manual_receipt_outflows(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      manual_receipt_id uuid NOT NULL REFERENCES manual_receipt_facts(id),
      fund_receipt_id uuid NOT NULL REFERENCES fund_receipts(id),
      amount_minor bigint NOT NULL CHECK (amount_minor > 0),
      currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      destination_reference text NOT NULL,
      actor_id uuid NOT NULL REFERENCES users(id),
      reason text NOT NULL,
      idempotency_key text NOT NULL UNIQUE,
      request_fingerprint text NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE FUNCTION opensales_manual_receipt_write_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('opensales:schema-015-016-rollback-bridge', 0)
      );
      RETURN NEW;
    END $$;
    CREATE TRIGGER manual_receipt_fact_write_guard
      BEFORE INSERT ON manual_receipt_facts
      FOR EACH ROW EXECUTE FUNCTION opensales_manual_receipt_write_guard();
    CREATE TRIGGER manual_receipt_reversal_write_guard
      BEFORE INSERT ON manual_receipt_reversals
      FOR EACH ROW EXECUTE FUNCTION opensales_manual_receipt_write_guard();
    CREATE TRIGGER manual_receipt_outflow_write_guard
      BEFORE INSERT ON manual_receipt_outflows
      FOR EACH ROW EXECUTE FUNCTION opensales_manual_receipt_write_guard();

    CREATE FUNCTION opensales_manual_receipt_marker_write_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE row_data jsonb := to_jsonb(NEW);
    DECLARE is_manual boolean := false;
    BEGIN
      is_manual :=
        (TG_TABLE_NAME = 'ledger_journals'
          AND row_data->>'source_type' IN (
            'manual_receipt', 'manual_receipt_reversal', 'manual_receipt_outflow'
          ))
        OR (TG_TABLE_NAME = 'provider_operations'
          AND row_data->>'subject_type' IN ('manual_receipt', 'manual_receipt_outflow'))
        OR (TG_TABLE_NAME = 'durable_jobs'
          AND ((row_data->>'job_type') LIKE 'manual_receipt.%'
            OR row_data->'payload' ? 'manualReceiptId'
            OR row_data->'payload' ? 'manualReceiptOutflowId'))
        OR (TG_TABLE_NAME = 'provider_inbox'
          AND (row_data->'payload' ? 'manualReceiptId'
            OR row_data->'payload' ? 'manualReceiptOutflowId'))
        OR (TG_TABLE_NAME = 'outbox'
          AND ((row_data->>'event_type') LIKE 'manual_receipt.%'
            OR row_data->'payload' ? 'manualReceiptId'
            OR row_data->'payload' ? 'manualReceiptOutflowId'))
        OR (TG_TABLE_NAME = 'fund_receipts'
          AND (row_data->>'reported_manual_receipt_id' IS NOT NULL
            OR row_data->>'disposition' = 'reversed'));
      IF is_manual THEN
        PERFORM pg_advisory_xact_lock(
          hashtextextended('opensales:schema-015-016-rollback-bridge', 0)
        );
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER manual_receipt_ledger_write_guard
      BEFORE INSERT OR UPDATE ON ledger_journals
      FOR EACH ROW EXECUTE FUNCTION opensales_manual_receipt_marker_write_guard();
    CREATE TRIGGER manual_receipt_provider_operation_write_guard
      BEFORE INSERT OR UPDATE ON provider_operations
      FOR EACH ROW EXECUTE FUNCTION opensales_manual_receipt_marker_write_guard();
    CREATE TRIGGER manual_receipt_job_write_guard
      BEFORE INSERT OR UPDATE ON durable_jobs
      FOR EACH ROW EXECUTE FUNCTION opensales_manual_receipt_marker_write_guard();
    CREATE TRIGGER manual_receipt_inbox_write_guard
      BEFORE INSERT OR UPDATE ON provider_inbox
      FOR EACH ROW EXECUTE FUNCTION opensales_manual_receipt_marker_write_guard();
    CREATE TRIGGER manual_receipt_outbox_write_guard
      BEFORE INSERT OR UPDATE ON outbox
      FOR EACH ROW EXECUTE FUNCTION opensales_manual_receipt_marker_write_guard();
    CREATE TRIGGER manual_receipt_fund_receipt_write_guard
      BEFORE INSERT OR UPDATE ON fund_receipts
      FOR EACH ROW EXECUTE FUNCTION opensales_manual_receipt_marker_write_guard();

    CREATE FUNCTION opensales_reject_manual_receipt_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'manual receipt financial facts are append-only';
    END $$;
    CREATE TRIGGER manual_receipt_facts_append_only
      BEFORE UPDATE OR DELETE ON manual_receipt_facts
      FOR EACH ROW EXECUTE FUNCTION opensales_reject_manual_receipt_mutation();
    CREATE FUNCTION opensales_assert_manual_receipt_complete()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE valid boolean;
    BEGIN
      SELECT
        journal.sealed_at IS NOT NULL
        AND COALESCE(sum(line.debit_minor), 0) = NEW.gross_amount_minor
        AND COALESCE(sum(line.credit_minor), 0) = NEW.gross_amount_minor
        AND COALESCE(sum(line.debit_minor) FILTER (
              WHERE line.account_code = 'cash_clearing'), 0)
              = NEW.gross_amount_minor - NEW.fee_minor
        AND COALESCE(sum(line.debit_minor) FILTER (
              WHERE line.account_code = 'payment_processing_expense'), 0) = NEW.fee_minor
        AND COALESCE(sum(line.credit_minor) FILTER (
              WHERE line.account_code = 'unclaimed_funds_liability'), 0)
              = NEW.gross_amount_minor
      INTO valid
      FROM ledger_journals journal
      JOIN ledger_lines line ON line.journal_id = journal.id
      WHERE journal.source_type = 'manual_receipt'
        AND journal.source_id = NEW.id
        AND journal.currency = NEW.currency
      GROUP BY journal.id, journal.sealed_at;
      IF NOT COALESCE(valid, false)
         OR NOT EXISTS (
           SELECT 1 FROM fund_receipts receipt
           WHERE receipt.reported_manual_receipt_id = NEW.id
             AND receipt.amount_minor = NEW.gross_amount_minor
             AND receipt.currency = NEW.currency
         ) THEN
        RAISE EXCEPTION 'manual receipt ledger/fund fact is incomplete';
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER manual_receipt_fact_completeness_guard
      AFTER INSERT ON manual_receipt_facts DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION opensales_assert_manual_receipt_complete();
    CREATE TRIGGER manual_receipt_reversals_append_only
      BEFORE UPDATE OR DELETE ON manual_receipt_reversals
      FOR EACH ROW EXECUTE FUNCTION opensales_reject_manual_receipt_mutation();
    CREATE FUNCTION opensales_assert_manual_receipt_reversal_complete()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE valid boolean;
    BEGIN
      SELECT
        journal.sealed_at IS NOT NULL
        AND COALESCE(sum(line.debit_minor), 0) = fact.gross_amount_minor
        AND COALESCE(sum(line.credit_minor), 0) = fact.gross_amount_minor
        AND COALESCE(sum(line.debit_minor) FILTER (
              WHERE line.account_code = 'unclaimed_funds_liability'), 0)
              = fact.gross_amount_minor
        AND COALESCE(sum(line.credit_minor) FILTER (
              WHERE line.account_code = 'cash_clearing'), 0)
              = fact.gross_amount_minor - fact.fee_minor
        AND COALESCE(sum(line.credit_minor) FILTER (
              WHERE line.account_code = 'payment_processing_expense'), 0) = fact.fee_minor
      INTO valid
      FROM manual_receipt_facts fact
      JOIN ledger_journals journal
        ON journal.source_type = 'manual_receipt_reversal'
       AND journal.source_id = NEW.id
       AND journal.currency = fact.currency
      JOIN ledger_lines line ON line.journal_id = journal.id
      WHERE fact.id = NEW.manual_receipt_id
      GROUP BY fact.id, fact.gross_amount_minor, fact.fee_minor, journal.id, journal.sealed_at;
      IF NOT COALESCE(valid, false)
         OR NOT EXISTS (
           SELECT 1 FROM fund_receipts receipt
           WHERE receipt.id = NEW.fund_receipt_id
             AND receipt.reported_manual_receipt_id = NEW.manual_receipt_id
             AND receipt.disposition = 'reversed'
         ) THEN
        RAISE EXCEPTION 'manual receipt reversal ledger is incomplete';
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER manual_receipt_reversal_completeness_guard
      AFTER INSERT ON manual_receipt_reversals DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION opensales_assert_manual_receipt_reversal_complete();
    CREATE TRIGGER manual_receipt_outflows_append_only
      BEFORE UPDATE OR DELETE ON manual_receipt_outflows
      FOR EACH ROW EXECUTE FUNCTION opensales_reject_manual_receipt_mutation();
    CREATE FUNCTION opensales_assert_manual_receipt_outflow_complete()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE valid boolean;
    BEGIN
      SELECT
        journal.sealed_at IS NOT NULL
        AND COALESCE(sum(line.debit_minor), 0) = NEW.amount_minor
        AND COALESCE(sum(line.credit_minor), 0) = NEW.amount_minor
        AND COALESCE(sum(line.debit_minor) FILTER (
              WHERE line.account_code = 'unclaimed_funds_liability'), 0) = NEW.amount_minor
        AND COALESCE(sum(line.credit_minor) FILTER (
              WHERE line.account_code = 'cash_clearing'), 0) = NEW.amount_minor
      INTO valid
      FROM ledger_journals journal
      JOIN ledger_lines line ON line.journal_id = journal.id
      WHERE journal.source_type = 'manual_receipt_outflow'
        AND journal.source_id = NEW.id
        AND journal.currency = NEW.currency
      GROUP BY journal.id, journal.sealed_at;
      IF NOT COALESCE(valid, false) THEN
        RAISE EXCEPTION 'manual receipt outflow ledger is incomplete';
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER manual_receipt_outflow_completeness_guard
      AFTER INSERT ON manual_receipt_outflows DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION opensales_assert_manual_receipt_outflow_complete();

    CREATE FUNCTION opensales_guard_manual_provider_refund()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM fund_receipts receipt
        WHERE receipt.id = NEW.source_fund_receipt_id
          AND receipt.reported_manual_receipt_id IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'manual receipts cannot use a Payment Provider refund';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER manual_receipt_provider_refund_guard
      BEFORE INSERT OR UPDATE ON refunds
      FOR EACH ROW EXECUTE FUNCTION opensales_guard_manual_provider_refund();
    CREATE FUNCTION opensales_guard_manual_receipt_resolution()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM fund_receipts receipt
        JOIN manual_receipt_reversals reversal
          ON reversal.fund_receipt_id = receipt.id
        WHERE receipt.id = NEW.fund_receipt_id
          AND receipt.reported_manual_receipt_id IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'a reversed manual receipt cannot be allocated';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER manual_receipt_resolution_guard
      BEFORE INSERT OR UPDATE ON fund_receipt_resolutions
      FOR EACH ROW EXECUTE FUNCTION opensales_guard_manual_receipt_resolution();

    DROP VIEW unclaimed_fund_refund_capacity;
    CREATE VIEW unclaimed_fund_refund_capacity AS
    SELECT
      receipt.id AS fund_receipt_id,
      receipt.amount_minor,
      receipt.allocated_minor,
      COALESCE(reserved.amount_minor, 0)::bigint AS reserved_refund_minor,
      COALESCE(confirmed.amount_minor, 0)::bigint AS confirmed_outflow_minor,
      blocked.present AS capacity_frozen,
      CASE WHEN blocked.present THEN 0
           ELSE GREATEST(0, receipt.amount_minor - receipt.allocated_minor
                            - COALESCE(reserved.amount_minor, 0)
                            - COALESCE(confirmed.amount_minor, 0))
      END::bigint AS available_minor
    FROM fund_receipts receipt
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(refund.amount_minor), 0)::bigint AS amount_minor
      FROM refunds refund
      WHERE refund.source_fund_receipt_id = receipt.id
        AND refund.source_context = 'unclaimed_funds'
        AND refund.status IN ('queued', 'processing')
    ) reserved ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(outflow.amount_minor), 0)::bigint AS amount_minor
      FROM (
        SELECT settlement.amount_minor
        FROM refunds refund
        JOIN refund_settlements settlement ON settlement.refund_id = refund.id
        WHERE refund.source_fund_receipt_id = receipt.id
          AND refund.source_context = 'unclaimed_funds'
        UNION ALL
        SELECT discrepancy.amount_minor
        FROM refunds refund
        JOIN refund_discrepancy_settlements discrepancy ON discrepancy.refund_id = refund.id
        JOIN refund_security_hold_adjudications adjudication
          ON adjudication.discrepancy_settlement_id = discrepancy.id
         AND adjudication.decision = 'record_unexpected_outflow'
        WHERE refund.source_fund_receipt_id = receipt.id
          AND refund.source_context = 'unclaimed_funds'
          AND discrepancy.currency = receipt.currency
        UNION ALL
        SELECT discrepancy.amount_minor
        FROM refunds refund
        JOIN refund_discrepancy_settlements discrepancy ON discrepancy.refund_id = refund.id
        JOIN refund_adjudication_corrections correction
          ON correction.discrepancy_settlement_id = discrepancy.id
        WHERE refund.source_fund_receipt_id = receipt.id
          AND refund.source_context = 'unclaimed_funds'
          AND discrepancy.currency = receipt.currency
        UNION ALL
        SELECT manual.amount_minor
        FROM manual_receipt_outflows manual
        WHERE manual.fund_receipt_id = receipt.id
      ) outflow
    ) confirmed ON true
    LEFT JOIN LATERAL (
      SELECT
        receipt.disposition = 'charged_back'
        OR EXISTS (
          SELECT 1 FROM manual_receipt_reversals reversal
          WHERE reversal.fund_receipt_id = receipt.id
        )
        OR EXISTS (
          SELECT 1 FROM refunds refund
          WHERE refund.source_fund_receipt_id = receipt.id
            AND refund.source_context = 'unclaimed_funds'
            AND refund.status IN ('unknown', 'manual')
        )
        OR EXISTS (
          SELECT 1 FROM refund_receipt_security_holds security_hold
          WHERE security_hold.source_fund_receipt_id = receipt.id
            AND NOT EXISTS (
              SELECT 1 FROM refund_security_hold_adjudications adjudication
              WHERE adjudication.receipt_security_hold_id = security_hold.id
            )
        )
        OR EXISTS (
          SELECT 1
          FROM add_funds_chargeback_holds chargeback_hold
          JOIN add_funds_chargeback_facts chargeback_fact
            ON chargeback_fact.id = chargeback_hold.fact_id
          WHERE chargeback_fact.add_funds_attempt_id = receipt.reported_add_funds_attempt_id
            AND chargeback_fact.original_external_payment_id = receipt.external_payment_id
        ) AS present
    ) blocked ON true;
  `);
  await client.query("SET LOCAL search_path TO pg_catalog, public");

  await client.query(`
    INSERT INTO users(id, email, password_hash, email_verified_at)
    VALUES (
      '00000000-0000-4000-8000-000000000280',
      'schema-016-update-guard@example.invalid',
      'synthetic-not-a-password', now()
    );
    INSERT INTO client_accounts(id, name, owner_user_id)
    VALUES (
      '00000000-0000-4000-8000-000000000281',
      'Synthetic update guard account',
      '00000000-0000-4000-8000-000000000280'
    );
    INSERT INTO invoices(id, client_account_id, currency, total_minor, due_at)
    VALUES (
      '00000000-0000-4000-8000-000000000282',
      '00000000-0000-4000-8000-000000000281', 'USD', 0, now()
    );
    INSERT INTO payment_attempts(
      id, client_account_id, invoice_id, provider_installation_id,
      external_payment_id, status, amount_minor, currency, scenario,
      idempotency_key, request_fingerprint
    ) VALUES (
      '00000000-0000-4000-8000-000000000283',
      '00000000-0000-4000-8000-000000000281',
      '00000000-0000-4000-8000-000000000282',
      'guard-test-provider', 'ordinary-payment', 'succeeded', 100, 'USD',
      'success', 'guard-test-payment-attempt', 'guard-test-payment-fingerprint'
    );
    INSERT INTO fund_receipts(
      id, provider_installation_id, external_payment_id,
      reported_payment_attempt_id, reported_add_funds_attempt_id,
      reported_manual_receipt_id, client_account_id, amount_minor,
      allocated_minor, currency, occurred_at, disposition, reason
    ) VALUES (
      '00000000-0000-4000-8000-000000000284',
      'guard-test-provider', 'ordinary-payment',
      '00000000-0000-4000-8000-000000000283', NULL, NULL,
      '00000000-0000-4000-8000-000000000281', 100, 0, 'USD', now(),
      'unclaimed', 'Ordinary receipt for update guard'
    );
    INSERT INTO provider_operations(
      id, provider_installation_id, kind, subject_type, subject_id,
      stable_key, status
    ) VALUES (
      '00000000-0000-4000-8000-000000000285', 'guard-test-provider',
      'payment_create', 'payment_attempt',
      '00000000-0000-4000-8000-000000000283', 'ordinary-operation', 'queued'
    );
    INSERT INTO durable_jobs(id, job_type, unique_key, payload)
    VALUES (
      '00000000-0000-4000-8000-000000000286', 'payment.reconcile',
      'ordinary-job', '{"paymentAttemptId":"00000000-0000-4000-8000-000000000283"}'::jsonb
    );
    INSERT INTO provider_inbox(
      id, provider_installation_id, external_event_id, event_type, payload
    ) VALUES (
      '00000000-0000-4000-8000-000000000287', 'guard-test-provider',
      'ordinary-inbox', 'payment.succeeded',
      '{"paymentAttemptId":"00000000-0000-4000-8000-000000000283"}'::jsonb
    );
    INSERT INTO outbox(id, event_type, unique_key, payload)
    VALUES (
      '00000000-0000-4000-8000-000000000288', 'invoice.paid',
      'ordinary-outbox', '{"invoiceId":"00000000-0000-4000-8000-000000000282"}'::jsonb
    );
  `);
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  await client.query("SET CONSTRAINTS ALL DEFERRED");

  const releaseInsertGuard = await holdSchema015RollbackBridgeGuard(pool);
  const blockedInsertStatements = [
    `INSERT INTO manual_receipt_facts(
       client_account_id, reference, received_at, gross_amount_minor, fee_minor,
       currency, actor_id, reason, idempotency_key, request_fingerprint, result
     ) VALUES (
       '00000000-0000-4000-8000-000000000271', 'LOCKED-FACT', now(), 1, 0,
       'USD', '00000000-0000-4000-8000-000000000272', 'Guard test reason',
       'guard-test-fact', 'guard-test-fact-fingerprint', '{}'::jsonb
     )`,
    `INSERT INTO manual_receipt_reversals(
       manual_receipt_id, fund_receipt_id, actor_id, reason,
       idempotency_key, request_fingerprint, result
     ) VALUES (
       '00000000-0000-4000-8000-000000000273',
       '00000000-0000-4000-8000-000000000274',
       '00000000-0000-4000-8000-000000000272', 'Guard test reversal',
       'guard-test-reversal', 'guard-test-reversal-fingerprint', '{}'::jsonb
     )`,
    `INSERT INTO manual_receipt_outflows(
       manual_receipt_id, fund_receipt_id, amount_minor, currency,
       destination_reference, actor_id, reason, idempotency_key,
       request_fingerprint, result
     ) VALUES (
       '00000000-0000-4000-8000-000000000273',
       '00000000-0000-4000-8000-000000000274', 1, 'USD', 'LOCKED-DESTINATION',
       '00000000-0000-4000-8000-000000000272', 'Guard test outflow',
       'guard-test-outflow', 'guard-test-outflow-fingerprint', '{}'::jsonb
     )`,
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES (
       'manual_receipt', '00000000-0000-4000-8000-000000000275',
       'USD', 'Guarded manual marker'
     )`,
    `INSERT INTO provider_operations(
       provider_installation_id, kind, subject_type, subject_id, stable_key, status
     ) VALUES (
       'guard-test-provider', 'payment_create', 'manual_receipt',
       '00000000-0000-4000-8000-000000000275', 'guard-test-operation', 'queued'
     )`,
    `INSERT INTO durable_jobs(job_type, unique_key, payload)
     VALUES (
       'manual_receipt.reconcile', 'guard-test-job',
       '{"manualReceiptId":"00000000-0000-4000-8000-000000000275"}'::jsonb
     )`,
    `INSERT INTO provider_inbox(
       provider_installation_id, external_event_id, event_type, payload
     ) VALUES (
       'guard-test-provider', 'guard-test-inbox', 'manual_receipt.test',
       '{"manualReceiptId":"00000000-0000-4000-8000-000000000275"}'::jsonb
     )`,
    `INSERT INTO outbox(event_type, unique_key, payload)
     VALUES (
       'manual_receipt.test', 'guard-test-outbox',
       '{"manualReceiptId":"00000000-0000-4000-8000-000000000275"}'::jsonb
     )`,
  ];
  const blockedUpdateStatements = [
    `UPDATE provider_operations
     SET subject_type = 'manual_receipt', updated_at = now()
     WHERE id = '00000000-0000-4000-8000-000000000285'`,
    `UPDATE durable_jobs
     SET payload = payload ||
       '{"manualReceiptId":"00000000-0000-4000-8000-000000000275"}'::jsonb,
       updated_at = now()
     WHERE id = '00000000-0000-4000-8000-000000000286'`,
    `UPDATE provider_inbox
     SET payload = payload ||
       '{"manualReceiptId":"00000000-0000-4000-8000-000000000275"}'::jsonb
     WHERE id = '00000000-0000-4000-8000-000000000287'`,
    `UPDATE outbox
     SET event_type = 'manual_receipt.recorded'
     WHERE id = '00000000-0000-4000-8000-000000000288'`,
    `UPDATE fund_receipts
     SET disposition = 'reversed', updated_at = now()
     WHERE id = '00000000-0000-4000-8000-000000000284'`,
  ];
  try {
    const ordinaryJobUpdate = await client.query(`
      UPDATE durable_jobs
      SET status = 'completed', updated_at = now()
      WHERE id = '00000000-0000-4000-8000-000000000286'
    `);
    assert.equal(ordinaryJobUpdate.rowCount, 1);
    const ordinaryReceiptUpdate = await client.query(`
      UPDATE fund_receipts
      SET reason = 'Ordinary non-marker update', updated_at = now()
      WHERE id = '00000000-0000-4000-8000-000000000284'
    `);
    assert.equal(ordinaryReceiptUpdate.rowCount, 1);

    for (const [index, statement] of blockedInsertStatements.entries()) {
      await client.query(`SAVEPOINT writer_guard_${index}`);
      await client.query("SET LOCAL lock_timeout = '200ms'");
      await assert.rejects(
        client.query(statement),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "55P03",
      );
      await client.query(`ROLLBACK TO SAVEPOINT writer_guard_${index}`);
    }
    for (const [index, statement] of blockedUpdateStatements.entries()) {
      await client.query(`SAVEPOINT update_guard_${index}`);
      await client.query("SET LOCAL lock_timeout = '200ms'");
      await assert.rejects(
        client.query(statement),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "55P03",
      );
      await client.query(`ROLLBACK TO SAVEPOINT update_guard_${index}`);
    }
  } finally {
    await releaseInsertGuard();
  }
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  await client.query("SET CONSTRAINTS ALL DEFERRED");

  const empty016 = await assert015RollbackBridgeSafe(database, {
    enable016RollbackBridge: true,
  });
  assert.equal(empty016.mode, "rollback_bridge");

  await client.query("ALTER TABLE manual_receipt_facts DISABLE TRIGGER manual_receipt_facts_append_only");
  await assert.rejects(
    assert015RollbackBridgeSafe(database, { enable016RollbackBridge: true }),
    /incomplete or counterfeit/,
  );
  await client.query("ALTER TABLE manual_receipt_facts ENABLE TRIGGER manual_receipt_facts_append_only");

  await client.query("SAVEPOINT replica_trigger");
  await client.query(
    "ALTER TABLE manual_receipt_facts ENABLE REPLICA TRIGGER manual_receipt_fact_write_guard",
  );
  await assert.rejects(
    assert015RollbackBridgeSafe(database, { enable016RollbackBridge: true }),
    /incomplete or counterfeit/,
  );
  await client.query("ROLLBACK TO SAVEPOINT replica_trigger");

  await client.query("SAVEPOINT counterfeit_constraint");
  await client.query(`
    ALTER TABLE fund_receipts DROP CONSTRAINT fund_receipts_exactly_one_source;
    ALTER TABLE fund_receipts
      ADD CONSTRAINT fund_receipts_exactly_one_source CHECK (true);
  `);
  await assert.rejects(
    assert015RollbackBridgeSafe(database, { enable016RollbackBridge: true }),
    /incomplete or counterfeit/,
  );
  await client.query("ROLLBACK TO SAVEPOINT counterfeit_constraint");

  await client.query("SAVEPOINT counterfeit_column");
  await client.query("ALTER TABLE manual_receipt_facts ADD COLUMN hidden_bypass text");
  await assert.rejects(
    assert015RollbackBridgeSafe(database, { enable016RollbackBridge: true }),
    /incomplete or counterfeit/,
  );
  await client.query("ROLLBACK TO SAVEPOINT counterfeit_column");

  await client.query("SAVEPOINT counterfeit_function");
  await client.query(`
    CREATE OR REPLACE FUNCTION public.opensales_manual_receipt_write_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RETURN NEW;
    END $$;
  `);
  await assert.rejects(
    assert015RollbackBridgeSafe(database, { enable016RollbackBridge: true }),
    /incomplete or counterfeit/,
  );
  await client.query("ROLLBACK TO SAVEPOINT counterfeit_function");

  await client.query("SAVEPOINT privileged_function");
  await client.query(
    "ALTER FUNCTION public.opensales_manual_receipt_write_guard() SECURITY DEFINER",
  );
  await assert.rejects(
    assert015RollbackBridgeSafe(database, { enable016RollbackBridge: true }),
    /incomplete or counterfeit/,
  );
  await client.query("ROLLBACK TO SAVEPOINT privileged_function");

  await client.query("SAVEPOINT counterfeit_view");
  await client.query(`
    CREATE OR REPLACE VIEW public.unclaimed_fund_refund_capacity AS
    SELECT
      receipt.id AS fund_receipt_id,
      receipt.amount_minor,
      receipt.allocated_minor,
      0::bigint AS reserved_refund_minor,
      0::bigint AS confirmed_outflow_minor,
      false AS capacity_frozen,
      receipt.amount_minor::bigint AS available_minor
    FROM fund_receipts receipt;
  `);
  await assert.rejects(
    assert015RollbackBridgeSafe(database, { enable016RollbackBridge: true }),
    /incomplete or counterfeit/,
  );
  await client.query("ROLLBACK TO SAVEPOINT counterfeit_view");

  await client.query("SAVEPOINT manual_facts");
  const userId = "00000000-0000-4000-8000-000000000261";
  const accountId = "00000000-0000-4000-8000-000000000262";
  const manualId = "00000000-0000-4000-8000-000000000263";
  const receiptId = "00000000-0000-4000-8000-000000000264";
  await client.query(
    `INSERT INTO users(id, email, password_hash, email_verified_at)
     VALUES ($1, 'schema-016-rollback@example.invalid', 'synthetic-not-a-password', now())`,
    [userId],
  );
  await client.query(
    "INSERT INTO client_accounts(id, name, owner_user_id) VALUES ($1, 'Synthetic manual receipt account', $2)",
    [accountId, userId],
  );
  await client.query(
    `INSERT INTO manual_receipt_facts(
       id, client_account_id, reference, received_at, gross_amount_minor, fee_minor,
       currency, actor_id, reason, idempotency_key, request_fingerprint, result
     ) VALUES ($1, $2, 'SYNTHETIC-RECEIPT-1', now(), 1000, 25, 'USD', $3,
               'Synthetic rollback blocker reason', 'synthetic-manual-receipt-key',
               'synthetic-manual-receipt-fingerprint', '{}'::jsonb)`,
    [manualId, accountId, userId],
  );
  await client.query(
    `INSERT INTO fund_receipts(
       id, provider_installation_id, external_payment_id,
       reported_payment_attempt_id, reported_add_funds_attempt_id,
       reported_manual_receipt_id, client_account_id, amount_minor,
       allocated_minor, currency, occurred_at, disposition, reason
     ) VALUES ($1, NULL, NULL, NULL, NULL, $2, $3, 1000, 0, 'USD', now(),
               'unclaimed', 'Synthetic manual receipt')`,
    [receiptId, manualId, accountId],
  );
  await client.query(
    `INSERT INTO manual_receipt_reversals(
       manual_receipt_id, fund_receipt_id, actor_id, reason,
       idempotency_key, request_fingerprint, result
     ) VALUES ($1, $2, $3, 'Synthetic reversal blocker',
               'synthetic-manual-reversal-key', 'synthetic-manual-reversal-fingerprint',
               '{}'::jsonb)`,
    [manualId, receiptId, userId],
  );
  await client.query(
    `INSERT INTO manual_receipt_outflows(
       manual_receipt_id, fund_receipt_id, amount_minor, currency,
       destination_reference, actor_id, reason, idempotency_key,
       request_fingerprint, result
     ) VALUES ($1, $2, 100, 'USD', 'SYNTHETIC-DESTINATION', $3,
               'Synthetic outflow blocker', 'synthetic-manual-outflow-key',
               'synthetic-manual-outflow-fingerprint', '{}'::jsonb)`,
    [manualId, receiptId, userId],
  );
  await client.query(
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES ('manual_receipt', $1, 'USD', 'Synthetic manual receipt journal')`,
    [manualId],
  );

  let blocked: unknown;
  try {
    await assert015RollbackBridgeSafe(database, { enable016RollbackBridge: true });
  } catch (error) {
    blocked = error;
  }
  assert.ok(blocked instanceof SchemaRollbackPreflightError);
  const blockerCodes = new Set(blocked.blockers.map(({ code }) => code));
  for (const code of [
    "manual_receipt_facts",
    "manual_receipt_reversals",
    "manual_receipt_outflows",
    "manual_fund_receipts",
    "manual_ledger_journals",
  ]) {
    assert.ok(blockerCodes.has(code), `missing PostgreSQL blocker ${code}`);
  }
  await client.query("ROLLBACK TO SAVEPOINT manual_facts");

  await client.query("ROLLBACK");
  process.stdout.write(
    `${JSON.stringify({
      schema015Native: true,
      schema016RequiresOptIn: true,
      shadowSchemaRejected: true,
      incompleteSchema016Rejected: true,
      emptySchema016Accepted: true,
      disabledTriggerRejected: true,
      replicaTriggerRejected: true,
      counterfeitConstraintRejected: true,
      counterfeitColumnRejected: true,
      counterfeitFunctionRejected: true,
      securityDefinerFunctionRejected: true,
      counterfeitViewRejected: true,
      lifetimeGuardBlocksWriter: true,
      lifetimeGuardBlocksMigration: true,
      actualManualInsertsBlocked: blockedInsertStatements.length,
      actualManualUpdatesBlocked: blockedUpdateStatements.length,
      ordinaryUpdatesAllowed: 2,
      blockerCodes: [...blockerCodes].sort(),
      databaseMutationPersisted: false,
    })}\n`,
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
