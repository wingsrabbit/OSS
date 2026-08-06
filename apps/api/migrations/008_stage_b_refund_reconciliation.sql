ALTER TABLE refund_discrepancy_settlements
  DROP CONSTRAINT IF EXISTS refund_discrepancy_settlements_refund_id_key;

ALTER TABLE refund_security_hold_adjudications
  DROP CONSTRAINT IF EXISTS refund_security_hold_adjudications_decision_check;
ALTER TABLE refund_security_hold_adjudications
  DROP CONSTRAINT IF EXISTS refund_security_hold_adjudications_discrepancy_settlement_id_key;
ALTER TABLE refund_security_hold_adjudications
  DROP CONSTRAINT IF EXISTS refund_security_hold_adjudication_discrepancy_settlement_id_key;
ALTER TABLE refund_security_hold_adjudications
  DROP CONSTRAINT IF EXISTS refund_security_hold_adjudications_discrepancy_unique;
ALTER TABLE refund_security_hold_adjudications
  ADD CONSTRAINT refund_security_hold_adjudications_decision_check
  CHECK (
    decision IN (
      'accept_authorized_outflow',
      'record_unexpected_outflow',
      'dismiss_provider_claim'
    )
  );
CREATE TABLE IF NOT EXISTS refund_manual_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id uuid NOT NULL REFERENCES refunds(id),
  action text NOT NULL CHECK (action IN ('retry_query', 'confirm_no_outflow')),
  staff_user_id uuid NOT NULL REFERENCES users(id),
  staff_session_id uuid NOT NULL REFERENCES sessions(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint text NOT NULL,
  expected_refund_version integer NOT NULL CHECK (expected_refund_version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refund_adjudication_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adjudication_id uuid NOT NULL UNIQUE REFERENCES refund_security_hold_adjudications(id),
  refund_id uuid NOT NULL REFERENCES refunds(id),
  discrepancy_settlement_id uuid NOT NULL UNIQUE REFERENCES refund_discrepancy_settlements(id),
  staff_user_id uuid NOT NULL REFERENCES users(id),
  staff_session_id uuid NOT NULL REFERENCES sessions(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint text NOT NULL UNIQUE,
  expected_refund_version integer NOT NULL CHECK (expected_refund_version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refund_adjudication_correction_aliases (
  idempotency_key text PRIMARY KEY CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  correction_id uuid NOT NULL REFERENCES refund_adjudication_corrections(id),
  request_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS refund_manual_actions_refund_created_idx
  ON refund_manual_actions (refund_id, created_at, id);
CREATE INDEX IF NOT EXISTS refund_adjudication_corrections_refund_created_idx
  ON refund_adjudication_corrections (refund_id, created_at, id);

CREATE OR REPLACE FUNCTION opensales_validate_refund_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_row record;
  allocation_row record;
  reserved_minor bigint;
BEGIN
  SELECT
    receipt.client_account_id,
    receipt.provider_installation_id,
    receipt.external_payment_id,
    receipt.amount_minor,
    receipt.allocated_minor,
    receipt.currency,
    receipt.reported_payment_attempt_id
  INTO receipt_row
  FROM fund_receipts receipt
  WHERE receipt.id = NEW.source_fund_receipt_id
  FOR UPDATE;

  SELECT
    allocation.invoice_id,
    allocation.amount_minor,
    payment.client_account_id,
    payment.provider_installation_id,
    payment.external_payment_id,
    payment.currency,
    invoice.client_account_id AS invoice_client_account_id,
    invoice.currency AS invoice_currency
  INTO allocation_row
  FROM payment_allocations allocation
  JOIN payment_attempts payment ON payment.id = allocation.payment_attempt_id
  JOIN invoices invoice ON invoice.id = allocation.invoice_id
  WHERE allocation.payment_attempt_id = receipt_row.reported_payment_attempt_id
    AND allocation.invoice_id = NEW.invoice_id
    AND payment.invoice_id = allocation.invoice_id;

  IF receipt_row IS NULL
     OR allocation_row IS NULL
     OR receipt_row.allocated_minor <> receipt_row.amount_minor
     OR allocation_row.amount_minor <> receipt_row.amount_minor
     OR NEW.client_account_id <> receipt_row.client_account_id
     OR NEW.client_account_id <> allocation_row.client_account_id
     OR NEW.client_account_id <> allocation_row.invoice_client_account_id
     OR NEW.currency <> receipt_row.currency
     OR NEW.currency <> allocation_row.currency
     OR NEW.currency <> allocation_row.invoice_currency
     OR receipt_row.provider_installation_id <> allocation_row.provider_installation_id
     OR receipt_row.external_payment_id <> allocation_row.external_payment_id THEN
    RAISE EXCEPTION 'refund source must be one fully allocated invoice receipt';
  END IF;

  IF NEW.destination = 'original_payment'
     AND (
       NEW.provider_installation_id <> receipt_row.provider_installation_id
       OR NEW.original_external_payment_id <> receipt_row.external_payment_id
     ) THEN
    RAISE EXCEPTION 'original-payment refund destination does not match its immutable receipt';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM refund_receipt_security_holds security_hold
    WHERE security_hold.source_fund_receipt_id = NEW.source_fund_receipt_id
      AND NOT EXISTS (
        SELECT 1
        FROM refund_security_hold_adjudications adjudication
        WHERE adjudication.receipt_security_hold_id = security_hold.id
      )
  )
  OR EXISTS (
    SELECT 1
    FROM refunds
    WHERE source_fund_receipt_id = NEW.source_fund_receipt_id
      AND status = 'manual'
  ) THEN
    reserved_minor := receipt_row.amount_minor;
  ELSE
    SELECT COALESCE(sum(reserved_outflow.amount_minor), 0)
    INTO reserved_minor
    FROM (
      SELECT reserved_refund.amount_minor
      FROM refunds reserved_refund
      WHERE reserved_refund.source_fund_receipt_id = NEW.source_fund_receipt_id
        AND reserved_refund.status IN ('queued', 'processing', 'unknown', 'succeeded')
      UNION ALL
      SELECT discrepancy.amount_minor
      FROM refunds unexpected_refund
      JOIN refund_discrepancy_settlements discrepancy
        ON discrepancy.refund_id = unexpected_refund.id
      JOIN refund_security_hold_adjudications adjudication
        ON adjudication.discrepancy_settlement_id = discrepancy.id
       AND adjudication.decision = 'record_unexpected_outflow'
      WHERE unexpected_refund.source_fund_receipt_id = NEW.source_fund_receipt_id
        AND discrepancy.currency = receipt_row.currency
      UNION ALL
      SELECT corrected_discrepancy.amount_minor
      FROM refunds corrected_refund
      JOIN refund_discrepancy_settlements corrected_discrepancy
        ON corrected_discrepancy.refund_id = corrected_refund.id
      JOIN refund_adjudication_corrections correction
        ON correction.discrepancy_settlement_id = corrected_discrepancy.id
      WHERE corrected_refund.source_fund_receipt_id = NEW.source_fund_receipt_id
        AND corrected_discrepancy.currency = receipt_row.currency
    ) reserved_outflow;
  END IF;

  IF NEW.amount_minor > receipt_row.amount_minor - reserved_minor THEN
    RAISE EXCEPTION 'refund exceeds the remaining refundable amount';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_validate_refund_discrepancy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('refund-external:' || NEW.external_refund_id, 0)
  );
  IF EXISTS (
    SELECT 1
    FROM refund_settlements settlement
    WHERE settlement.provider_installation_id = NEW.provider_installation_id
      AND settlement.external_refund_id = NEW.external_refund_id
  ) THEN
    RAISE EXCEPTION 'Provider external refund identity already belongs to a refund settlement';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM refund_provider_facts fact
    JOIN refunds refund ON refund.id = fact.refund_id
    WHERE fact.id = NEW.refund_provider_fact_id
      AND fact.refund_id = NEW.refund_id
      AND fact.provider_installation_id = NEW.provider_installation_id
      AND fact.external_refund_id = NEW.external_refund_id
      AND fact.status = 'succeeded'
      AND fact.amount_minor = NEW.amount_minor
      AND fact.currency = NEW.currency
      AND fact.occurred_at = NEW.occurred_at
  ) THEN
    RAISE EXCEPTION 'refund discrepancy does not match an immutable success fact';
  END IF;

  IF current_setting('opensales.refund_human_adjudication', true) IS DISTINCT FROM 'on'
     AND NOT EXISTS (
       SELECT 1
       FROM refunds refund
       WHERE refund.id = NEW.refund_id
         AND refund.amount_minor = NEW.amount_minor
         AND refund.currency = NEW.currency
         AND NOT EXISTS (
           SELECT 1 FROM refund_settlements settlement
           WHERE settlement.refund_id = refund.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM refund_discrepancy_settlements discrepancy
           WHERE discrepancy.refund_id = refund.id
         )
     ) THEN
    RAISE EXCEPTION 'automatic refund discrepancy must be the first exact authorized outflow';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_validate_refund_receipt_security_hold()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM refunds refund
    JOIN refund_provider_facts fact
      ON fact.id = NEW.refund_provider_fact_id
     AND fact.refund_id = refund.id
    WHERE refund.id = NEW.refund_id
      AND refund.source_fund_receipt_id = NEW.source_fund_receipt_id
  ) THEN
    RAISE EXCEPTION 'refund receipt security hold does not match its fact and receipt';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_validate_refund_security_adjudication()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM refund_receipt_security_holds security_hold
    JOIN refunds refund ON refund.id = security_hold.refund_id
    JOIN sessions session_record
      ON session_record.id = NEW.staff_session_id
     AND session_record.user_id = NEW.staff_user_id
    WHERE security_hold.id = NEW.receipt_security_hold_id
      AND security_hold.refund_id = NEW.refund_id
  ) THEN
    RAISE EXCEPTION 'refund hold adjudication does not match its hold, refund, and staff session';
  END IF;

  IF NEW.discrepancy_settlement_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM refund_receipt_security_holds security_hold
       JOIN refund_discrepancy_settlements discrepancy
         ON discrepancy.id = NEW.discrepancy_settlement_id
        AND discrepancy.refund_id = security_hold.refund_id
        AND discrepancy.refund_provider_fact_id = security_hold.refund_provider_fact_id
       WHERE security_hold.id = NEW.receipt_security_hold_id
     ) THEN
    RAISE EXCEPTION 'refund hold adjudication discrepancy does not match its immutable fact';
  END IF;

  IF NEW.decision = 'accept_authorized_outflow'
     AND NOT EXISTS (
       SELECT 1
       FROM refund_discrepancy_settlements discrepancy
       JOIN refunds refund ON refund.id = discrepancy.refund_id
       WHERE discrepancy.id = NEW.discrepancy_settlement_id
         AND discrepancy.refund_id = NEW.refund_id
         AND discrepancy.amount_minor = refund.amount_minor
         AND discrepancy.currency = refund.currency
         AND refund.status = 'manual'
         AND refund.security_hold
         AND NOT EXISTS (
           SELECT 1 FROM refund_settlements settlement
           WHERE settlement.refund_id = refund.id
         )
     ) THEN
    RAISE EXCEPTION 'accepted refund outflow must be exact, authorized, held, and unsettled';
  END IF;

  IF NEW.decision = 'record_unexpected_outflow'
     AND NOT EXISTS (
       SELECT 1
       FROM refund_receipt_security_holds security_hold
       JOIN refund_provider_facts fact
         ON fact.id = security_hold.refund_provider_fact_id
        AND fact.refund_id = security_hold.refund_id
       WHERE security_hold.id = NEW.receipt_security_hold_id
         AND security_hold.refund_id = NEW.refund_id
         AND fact.status = 'succeeded'
     ) THEN
    RAISE EXCEPTION 'unexpected refund outflow requires a held Provider success fact';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_validate_refund_manual_action()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM refunds refund
    JOIN sessions session_record
      ON session_record.id = NEW.staff_session_id
     AND session_record.user_id = NEW.staff_user_id
    WHERE refund.id = NEW.refund_id
      AND refund.destination = 'original_payment'
      AND refund.status = 'manual'
      AND NOT refund.security_hold
      AND refund.version = NEW.expected_refund_version
  ) THEN
    RAISE EXCEPTION 'manual refund action requires an unsettled manual refund and current staff session';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refund_manual_action_insert_guard ON refund_manual_actions;
CREATE TRIGGER refund_manual_action_insert_guard
BEFORE INSERT ON refund_manual_actions
FOR EACH ROW EXECUTE FUNCTION opensales_validate_refund_manual_action();

DROP TRIGGER IF EXISTS refund_manual_actions_append_only ON refund_manual_actions;
CREATE TRIGGER refund_manual_actions_append_only
BEFORE UPDATE OR DELETE ON refund_manual_actions
FOR EACH ROW EXECUTE FUNCTION opensales_reject_refund_delete();

CREATE OR REPLACE FUNCTION opensales_validate_refund_adjudication_correction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM refund_security_hold_adjudications adjudication
    JOIN refund_receipt_security_holds security_hold
      ON security_hold.id = adjudication.receipt_security_hold_id
     AND security_hold.refund_id = adjudication.refund_id
    JOIN refund_provider_facts fact
      ON fact.id = security_hold.refund_provider_fact_id
     AND fact.refund_id = security_hold.refund_id
    JOIN refund_discrepancy_settlements discrepancy
      ON discrepancy.id = NEW.discrepancy_settlement_id
     AND discrepancy.refund_id = adjudication.refund_id
     AND discrepancy.refund_provider_fact_id = fact.id
    JOIN refunds refund ON refund.id = adjudication.refund_id
    JOIN sessions session_record
      ON session_record.id = NEW.staff_session_id
     AND session_record.user_id = NEW.staff_user_id
    WHERE adjudication.id = NEW.adjudication_id
      AND adjudication.refund_id = NEW.refund_id
      AND adjudication.decision = 'dismiss_provider_claim'
      AND fact.status = 'succeeded'
      AND refund.version = NEW.expected_refund_version
  ) THEN
    RAISE EXCEPTION 'correction must bind a dismissed success fact, its discrepancy, current refund, and staff session';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refund_adjudication_correction_insert_guard
  ON refund_adjudication_corrections;
CREATE TRIGGER refund_adjudication_correction_insert_guard
BEFORE INSERT ON refund_adjudication_corrections
FOR EACH ROW EXECUTE FUNCTION opensales_validate_refund_adjudication_correction();

DROP TRIGGER IF EXISTS refund_adjudication_corrections_append_only
  ON refund_adjudication_corrections;
CREATE TRIGGER refund_adjudication_corrections_append_only
BEFORE UPDATE OR DELETE ON refund_adjudication_corrections
FOR EACH ROW EXECUTE FUNCTION opensales_reject_refund_delete();

CREATE OR REPLACE FUNCTION opensales_validate_refund_correction_alias()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM refund_adjudication_corrections correction
    WHERE correction.id = NEW.correction_id
      AND correction.request_fingerprint = NEW.request_fingerprint
  ) THEN
    RAISE EXCEPTION 'refund correction alias does not match its immutable decision';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refund_adjudication_correction_alias_insert_guard
  ON refund_adjudication_correction_aliases;
CREATE TRIGGER refund_adjudication_correction_alias_insert_guard
BEFORE INSERT ON refund_adjudication_correction_aliases
FOR EACH ROW EXECUTE FUNCTION opensales_validate_refund_correction_alias();

DROP TRIGGER IF EXISTS refund_adjudication_correction_aliases_append_only
  ON refund_adjudication_correction_aliases;
CREATE TRIGGER refund_adjudication_correction_aliases_append_only
BEFORE UPDATE OR DELETE ON refund_adjudication_correction_aliases
FOR EACH ROW EXECUTE FUNCTION opensales_reject_refund_delete();

CREATE OR REPLACE FUNCTION opensales_validate_refund_settlement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  refund_row record;
  receipt_amount_minor bigint;
  prior_settled_minor bigint;
BEGIN
  IF NEW.destination = 'original_payment' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('refund-external:' || NEW.external_refund_id, 0)
    );
    IF EXISTS (
      SELECT 1
      FROM refund_discrepancy_settlements discrepancy
      WHERE discrepancy.provider_installation_id = NEW.provider_installation_id
        AND discrepancy.external_refund_id = NEW.external_refund_id
        AND NOT (
          discrepancy.refund_id = NEW.refund_id
          AND EXISTS (
            SELECT 1
            FROM refund_security_hold_adjudications adjudication
            WHERE adjudication.discrepancy_settlement_id = discrepancy.id
              AND adjudication.refund_id = NEW.refund_id
              AND adjudication.decision = 'accept_authorized_outflow'
          )
        )
    ) THEN
      RAISE EXCEPTION 'Provider external refund identity already belongs to a discrepancy';
    END IF;
  END IF;

  SELECT
    status,
    destination,
    amount_minor,
    currency,
    provider_installation_id,
    source_fund_receipt_id
  INTO refund_row
  FROM refunds
  WHERE id = NEW.refund_id
  FOR UPDATE;

  IF refund_row IS NULL
     OR refund_row.status <> 'succeeded'
     OR NEW.destination <> refund_row.destination
     OR NEW.amount_minor <> refund_row.amount_minor
     OR NEW.currency <> refund_row.currency
     OR NEW.provider_installation_id IS DISTINCT FROM refund_row.provider_installation_id THEN
    RAISE EXCEPTION 'refund settlement does not match a succeeded refund';
  END IF;

  SELECT amount_minor
  INTO receipt_amount_minor
  FROM fund_receipts
  WHERE id = refund_row.source_fund_receipt_id
  FOR UPDATE;

  SELECT COALESCE(sum(recorded_outflow.amount_minor), 0)
  INTO prior_settled_minor
  FROM (
    SELECT settlement.amount_minor
    FROM refund_settlements settlement
    JOIN refunds settled_refund ON settled_refund.id = settlement.refund_id
    WHERE settled_refund.source_fund_receipt_id = refund_row.source_fund_receipt_id
    UNION ALL
    SELECT discrepancy.amount_minor
    FROM refunds unexpected_refund
    JOIN refund_discrepancy_settlements discrepancy
      ON discrepancy.refund_id = unexpected_refund.id
    JOIN refund_security_hold_adjudications adjudication
      ON adjudication.discrepancy_settlement_id = discrepancy.id
     AND adjudication.decision = 'record_unexpected_outflow'
    WHERE unexpected_refund.source_fund_receipt_id = refund_row.source_fund_receipt_id
      AND discrepancy.currency = refund_row.currency
    UNION ALL
    SELECT corrected_discrepancy.amount_minor
    FROM refunds corrected_refund
    JOIN refund_discrepancy_settlements corrected_discrepancy
      ON corrected_discrepancy.refund_id = corrected_refund.id
    JOIN refund_adjudication_corrections correction
      ON correction.discrepancy_settlement_id = corrected_discrepancy.id
    WHERE corrected_refund.source_fund_receipt_id = refund_row.source_fund_receipt_id
      AND corrected_discrepancy.currency = refund_row.currency
  ) recorded_outflow;

  IF receipt_amount_minor IS NULL
     OR prior_settled_minor + NEW.amount_minor > receipt_amount_minor THEN
    RAISE EXCEPTION 'refund settlements exceed the immutable source receipt amount';
  END IF;
  RETURN NEW;
END;
$$;
