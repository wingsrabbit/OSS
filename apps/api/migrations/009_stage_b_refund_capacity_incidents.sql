CREATE TABLE IF NOT EXISTS refund_receipt_capacity_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_fund_receipt_id uuid NOT NULL REFERENCES fund_receipts(id),
  receipt_sequence bigint NOT NULL CHECK (receipt_sequence > 0),
  triggering_correction_id uuid UNIQUE REFERENCES refund_adjudication_corrections(id),
  triggering_adjudication_id uuid UNIQUE REFERENCES refund_security_hold_adjudications(id),
  confirmed_compensation_minor bigint NOT NULL CHECK (confirmed_compensation_minor > 0),
  receipt_amount_minor bigint NOT NULL CHECK (receipt_amount_minor > 0),
  overage_minor bigint NOT NULL CHECK (overage_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_fund_receipt_id, receipt_sequence),
  CHECK (num_nonnulls(triggering_correction_id, triggering_adjudication_id) = 1),
  CHECK (confirmed_compensation_minor = receipt_amount_minor + overage_minor)
);

CREATE TABLE IF NOT EXISTS refund_receipt_capacity_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL UNIQUE REFERENCES refund_receipt_capacity_incidents(id),
  staff_user_id uuid NOT NULL REFERENCES users(id),
  staff_session_id uuid NOT NULL REFERENCES sessions(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint text NOT NULL UNIQUE,
  expected_confirmed_compensation_minor bigint NOT NULL
    CHECK (expected_confirmed_compensation_minor > 0),
  expected_overage_minor bigint NOT NULL CHECK (expected_overage_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refund_receipt_capacity_acknowledgement_aliases (
  idempotency_key text PRIMARY KEY CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  acknowledgement_id uuid NOT NULL REFERENCES refund_receipt_capacity_acknowledgements(id),
  request_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION opensales_validate_refund_receipt_capacity_incident()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_row record;
  confirmed_minor bigint;
  expected_sequence bigint;
BEGIN
  SELECT receipt.amount_minor, receipt.currency
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

DROP TRIGGER IF EXISTS refund_receipt_capacity_incident_insert_guard
  ON refund_receipt_capacity_incidents;
CREATE TRIGGER refund_receipt_capacity_incident_insert_guard
BEFORE INSERT ON refund_receipt_capacity_incidents
FOR EACH ROW EXECUTE FUNCTION opensales_validate_refund_receipt_capacity_incident();

CREATE OR REPLACE FUNCTION opensales_validate_refund_receipt_capacity_acknowledgement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM refund_receipt_capacity_incidents incident
    JOIN sessions session_record
      ON session_record.id = NEW.staff_session_id
     AND session_record.user_id = NEW.staff_user_id
    WHERE incident.id = NEW.incident_id
      AND incident.confirmed_compensation_minor = NEW.expected_confirmed_compensation_minor
      AND incident.overage_minor = NEW.expected_overage_minor
      AND NOT EXISTS (
        SELECT 1
        FROM refund_receipt_capacity_incidents later_incident
        WHERE later_incident.source_fund_receipt_id = incident.source_fund_receipt_id
          AND later_incident.receipt_sequence > incident.receipt_sequence
      )
  ) THEN
    RAISE EXCEPTION 'capacity acknowledgement must match the current incident snapshot and staff session';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refund_receipt_capacity_acknowledgement_insert_guard
  ON refund_receipt_capacity_acknowledgements;
CREATE TRIGGER refund_receipt_capacity_acknowledgement_insert_guard
BEFORE INSERT ON refund_receipt_capacity_acknowledgements
FOR EACH ROW EXECUTE FUNCTION opensales_validate_refund_receipt_capacity_acknowledgement();

CREATE OR REPLACE FUNCTION opensales_validate_refund_receipt_capacity_acknowledgement_alias()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM refund_receipt_capacity_acknowledgements acknowledgement
    WHERE acknowledgement.id = NEW.acknowledgement_id
      AND acknowledgement.request_fingerprint = NEW.request_fingerprint
  ) THEN
    RAISE EXCEPTION 'capacity acknowledgement alias does not match its immutable decision';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refund_receipt_capacity_acknowledgement_alias_insert_guard
  ON refund_receipt_capacity_acknowledgement_aliases;
CREATE TRIGGER refund_receipt_capacity_acknowledgement_alias_insert_guard
BEFORE INSERT ON refund_receipt_capacity_acknowledgement_aliases
FOR EACH ROW EXECUTE FUNCTION opensales_validate_refund_receipt_capacity_acknowledgement_alias();

DROP TRIGGER IF EXISTS refund_receipt_capacity_incidents_append_only
  ON refund_receipt_capacity_incidents;
CREATE TRIGGER refund_receipt_capacity_incidents_append_only
BEFORE UPDATE OR DELETE ON refund_receipt_capacity_incidents
FOR EACH ROW EXECUTE FUNCTION opensales_reject_refund_delete();

DROP TRIGGER IF EXISTS refund_receipt_capacity_acknowledgements_append_only
  ON refund_receipt_capacity_acknowledgements;
CREATE TRIGGER refund_receipt_capacity_acknowledgements_append_only
BEFORE UPDATE OR DELETE ON refund_receipt_capacity_acknowledgements
FOR EACH ROW EXECUTE FUNCTION opensales_reject_refund_delete();

DROP TRIGGER IF EXISTS refund_receipt_capacity_acknowledgement_aliases_append_only
  ON refund_receipt_capacity_acknowledgement_aliases;
CREATE TRIGGER refund_receipt_capacity_acknowledgement_aliases_append_only
BEFORE UPDATE OR DELETE ON refund_receipt_capacity_acknowledgement_aliases
FOR EACH ROW EXECUTE FUNCTION opensales_reject_refund_delete();
