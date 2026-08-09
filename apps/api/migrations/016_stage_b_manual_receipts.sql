-- SPDX-License-Identifier: AGPL-3.0-or-later

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
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('opensales:schema-015-016-rollback-bridge', 0)
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
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('opensales:schema-015-016-rollback-bridge', 0)
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
