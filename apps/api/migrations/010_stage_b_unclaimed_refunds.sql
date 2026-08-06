-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS source_context text NOT NULL DEFAULT 'allocated_invoice';

ALTER TABLE refunds
  ALTER COLUMN invoice_id DROP NOT NULL;

ALTER TABLE refunds
  DROP CONSTRAINT IF EXISTS refunds_source_context_check;
ALTER TABLE refunds
  ADD CONSTRAINT refunds_source_context_check CHECK (
    (source_context = 'allocated_invoice' AND invoice_id IS NOT NULL)
    OR (
      source_context = 'unclaimed_funds'
      AND invoice_id IS NULL
      AND destination = 'original_payment'
      AND amount_mode IN ('full', 'partial')
      AND amount_minor > 0
    )
  );

CREATE INDEX IF NOT EXISTS refunds_unclaimed_receipt_status_idx
  ON refunds (source_fund_receipt_id, status, created_at, id)
  WHERE source_context = 'unclaimed_funds';

CREATE OR REPLACE VIEW unclaimed_fund_refund_capacity AS
SELECT
  receipt.id AS fund_receipt_id,
  receipt.amount_minor,
  receipt.allocated_minor,
  COALESCE(reserved.amount_minor, 0)::bigint AS reserved_refund_minor,
  COALESCE(confirmed.amount_minor, 0)::bigint AS confirmed_outflow_minor,
  blocked.present AS capacity_frozen,
  CASE
    WHEN blocked.present THEN 0
    ELSE GREATEST(
      0,
      receipt.amount_minor
        - receipt.allocated_minor
        - COALESCE(reserved.amount_minor, 0)
        - COALESCE(confirmed.amount_minor, 0)
    )
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
  ) outflow
) confirmed ON true
LEFT JOIN LATERAL (
  SELECT
    EXISTS (
      SELECT 1
      FROM refunds refund
      WHERE refund.source_fund_receipt_id = receipt.id
        AND refund.source_context = 'unclaimed_funds'
        AND refund.status IN ('unknown', 'manual')
    )
    OR EXISTS (
      SELECT 1
      FROM refund_receipt_security_holds security_hold
      WHERE security_hold.source_fund_receipt_id = receipt.id
        AND NOT EXISTS (
          SELECT 1
          FROM refund_security_hold_adjudications adjudication
          WHERE adjudication.receipt_security_hold_id = security_hold.id
        )
    ) AS present
) blocked ON true;

CREATE OR REPLACE FUNCTION opensales_validate_fund_receipt_resolution()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_row record;
  invoice_row record;
  invoice_allocated bigint;
  available_minor bigint;
BEGIN
  IF NEW.action = 'allocate_invoice' THEN
    SELECT client_account_id, currency, total_minor
    INTO invoice_row
    FROM invoices
    WHERE id = NEW.invoice_id
    FOR UPDATE;
  END IF;

  SELECT client_account_id, currency, amount_minor, allocated_minor
  INTO receipt_row
  FROM fund_receipts
  WHERE id = NEW.fund_receipt_id
  FOR UPDATE;

  SELECT capacity.available_minor
  INTO available_minor
  FROM unclaimed_fund_refund_capacity capacity
  WHERE capacity.fund_receipt_id = NEW.fund_receipt_id;

  IF receipt_row IS NULL
     OR NEW.client_account_id <> receipt_row.client_account_id
     OR NEW.currency <> receipt_row.currency
     OR NEW.amount_minor > COALESCE(available_minor, 0) THEN
    RAISE EXCEPTION 'fund receipt resolution exceeds or mismatches available funds';
  END IF;

  IF NEW.action = 'allocate_invoice' THEN
    SELECT allocated_minor
    INTO invoice_allocated
    FROM invoice_allocation_totals
    WHERE invoice_id = NEW.invoice_id;
    IF invoice_row IS NULL
       OR invoice_row.client_account_id <> receipt_row.client_account_id
       OR invoice_row.currency <> receipt_row.currency
       OR NEW.amount_minor > invoice_row.total_minor - COALESCE(invoice_allocated, 0) THEN
      RAISE EXCEPTION 'fund receipt resolution exceeds or mismatches invoice due';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_validate_refund_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_row record;
  allocation_row record;
  reserved_minor bigint;
  unclaimed_available_minor bigint;
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

  IF NEW.source_context = 'unclaimed_funds' THEN
    SELECT capacity.available_minor
    INTO unclaimed_available_minor
    FROM unclaimed_fund_refund_capacity capacity
    WHERE capacity.fund_receipt_id = NEW.source_fund_receipt_id;

    IF receipt_row IS NULL
       OR NEW.invoice_id IS NOT NULL
       OR NEW.destination <> 'original_payment'
       OR NEW.client_account_id <> receipt_row.client_account_id
       OR NEW.currency <> receipt_row.currency
       OR NEW.provider_installation_id IS DISTINCT FROM receipt_row.provider_installation_id
       OR NEW.original_external_payment_id IS DISTINCT FROM receipt_row.external_payment_id
       OR NEW.amount_minor > COALESCE(unclaimed_available_minor, 0) THEN
      RAISE EXCEPTION 'unclaimed refund exceeds or mismatches the immutable available receipt';
    END IF;
    RETURN NEW;
  END IF;

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
     OR NEW.source_context <> 'allocated_invoice'
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

CREATE OR REPLACE FUNCTION opensales_guard_refund_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.source_context <> OLD.source_context
     OR NEW.client_account_id <> OLD.client_account_id
     OR NEW.source_fund_receipt_id <> OLD.source_fund_receipt_id
     OR NEW.provider_installation_id IS DISTINCT FROM OLD.provider_installation_id
     OR NEW.original_external_payment_id IS DISTINCT FROM OLD.original_external_payment_id
     OR NEW.destination <> OLD.destination
     OR NEW.amount_mode <> OLD.amount_mode
     OR NEW.amount_minor <> OLD.amount_minor
     OR NEW.currency <> OLD.currency
     OR NEW.scenario IS DISTINCT FROM OLD.scenario
     OR NEW.requested_by_user_id <> OLD.requested_by_user_id
     OR NEW.requested_session_id <> OLD.requested_session_id
     OR NEW.requested_client_account_id <> OLD.requested_client_account_id
     OR NEW.reason <> OLD.reason
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.request_fingerprint <> OLD.request_fingerprint
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'immutable refund fields cannot be changed';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'refund version must advance exactly once';
  END IF;

  IF OLD.security_hold
     AND (NOT NEW.security_hold OR NEW.status <> 'manual')
     AND current_setting('opensales.refund_human_adjudication', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'security-held refunds require explicit human adjudication';
  END IF;

  IF NEW.security_hold AND NEW.status <> 'manual' THEN
    RAISE EXCEPTION 'security-held refunds require explicit human adjudication';
  END IF;

  IF NOT (
    NEW.status = OLD.status
    OR (OLD.status = 'queued' AND NEW.status IN ('processing', 'failed', 'manual'))
    OR (OLD.status = 'processing' AND NEW.status IN ('unknown', 'succeeded', 'failed', 'manual'))
    OR (OLD.status = 'unknown' AND NEW.status IN ('succeeded', 'failed', 'manual'))
    OR (OLD.status = 'manual' AND NEW.status IN ('succeeded', 'failed'))
    OR (OLD.status = 'failed' AND NEW.status = 'manual')
  ) THEN
    RAISE EXCEPTION 'refund status cannot move backward or follow an invalid transition';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_validate_refund_settlement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  refund_row record;
  receipt_row record;
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
    source_fund_receipt_id,
    source_context
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

  SELECT amount_minor, allocated_minor
  INTO receipt_row
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

  IF receipt_row IS NULL
     OR prior_settled_minor + NEW.amount_minor
       + (CASE
           WHEN refund_row.source_context = 'unclaimed_funds'
             THEN receipt_row.allocated_minor
           ELSE 0
         END) > receipt_row.amount_minor THEN
    RAISE EXCEPTION 'refund settlements exceed the immutable source receipt capacity';
  END IF;
  RETURN NEW;
END;
$$;

-- Migration 009 introduced receipt-capacity incidents for invoice refunds. An
-- unclaimed-funds return shares the same immutable receipt, but its confirmed
-- disposition also includes any amount that was allocated while an earlier
-- Provider claim was dismissed. Derive the source context from the triggering
-- adjudication/correction inside PostgreSQL so callers cannot understate it.
CREATE OR REPLACE FUNCTION opensales_validate_refund_receipt_capacity_incident()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_row record;
  confirmed_minor bigint;
  expected_sequence bigint;
BEGIN
  SELECT
    receipt.amount_minor,
    receipt.allocated_minor,
    receipt.currency,
    refund.source_context AS triggering_source_context
  INTO receipt_row
  FROM fund_receipts receipt
  JOIN refunds refund ON refund.source_fund_receipt_id = receipt.id
  WHERE receipt.id = NEW.source_fund_receipt_id
    AND (
      (
        NEW.triggering_correction_id IS NOT NULL
        AND NEW.triggering_adjudication_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM refund_adjudication_corrections correction
          JOIN refund_discrepancy_settlements discrepancy
            ON discrepancy.id = correction.discrepancy_settlement_id
           AND discrepancy.refund_id = correction.refund_id
          WHERE correction.id = NEW.triggering_correction_id
            AND correction.refund_id = refund.id
            AND discrepancy.currency = receipt.currency
        )
      )
      OR
      (
        NEW.triggering_correction_id IS NULL
        AND NEW.triggering_adjudication_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM refund_security_hold_adjudications adjudication
          JOIN refund_discrepancy_settlements discrepancy
            ON discrepancy.id = adjudication.discrepancy_settlement_id
           AND discrepancy.refund_id = adjudication.refund_id
          WHERE adjudication.id = NEW.triggering_adjudication_id
            AND adjudication.refund_id = refund.id
            AND adjudication.decision = 'record_unexpected_outflow'
            AND discrepancy.currency = receipt.currency
        )
      )
    )
  FOR UPDATE OF receipt;

  IF receipt_row IS NULL THEN
    RAISE EXCEPTION 'refund receipt capacity incident must match its correction and receipt';
  END IF;

  SELECT COALESCE(max(incident.receipt_sequence), 0) + 1
  INTO expected_sequence
  FROM refund_receipt_capacity_incidents incident
  WHERE incident.source_fund_receipt_id = NEW.source_fund_receipt_id;

  SELECT COALESCE(sum(confirmed.amount_minor), 0)
  INTO confirmed_minor
  FROM (
    SELECT settlement.amount_minor
    FROM refunds related_refund
    JOIN refund_settlements settlement ON settlement.refund_id = related_refund.id
    WHERE related_refund.source_fund_receipt_id = NEW.source_fund_receipt_id
      AND settlement.currency = receipt_row.currency
    UNION ALL
    SELECT discrepancy.amount_minor
    FROM refunds related_refund
    JOIN refund_discrepancy_settlements discrepancy ON discrepancy.refund_id = related_refund.id
    JOIN refund_security_hold_adjudications adjudication
      ON adjudication.discrepancy_settlement_id = discrepancy.id
     AND adjudication.decision = 'record_unexpected_outflow'
    WHERE related_refund.source_fund_receipt_id = NEW.source_fund_receipt_id
      AND discrepancy.currency = receipt_row.currency
    UNION ALL
    SELECT discrepancy.amount_minor
    FROM refunds related_refund
    JOIN refund_discrepancy_settlements discrepancy ON discrepancy.refund_id = related_refund.id
    JOIN refund_adjudication_corrections correction
      ON correction.discrepancy_settlement_id = discrepancy.id
    WHERE related_refund.source_fund_receipt_id = NEW.source_fund_receipt_id
      AND discrepancy.currency = receipt_row.currency
  ) confirmed;

  IF receipt_row.triggering_source_context = 'unclaimed_funds' THEN
    confirmed_minor := confirmed_minor + receipt_row.allocated_minor;
  END IF;

  IF NEW.currency <> receipt_row.currency
     OR NEW.receipt_sequence <> expected_sequence
     OR NEW.receipt_amount_minor <> receipt_row.amount_minor
     OR NEW.confirmed_compensation_minor <> confirmed_minor
     OR NEW.overage_minor <> confirmed_minor - receipt_row.amount_minor
     OR confirmed_minor <= receipt_row.amount_minor THEN
    RAISE EXCEPTION 'refund receipt capacity incident must preserve the current confirmed overage';
  END IF;

  RETURN NEW;
END;
$$;
