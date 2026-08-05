-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE provider_operations
  DROP CONSTRAINT IF EXISTS provider_operations_kind_check;
ALTER TABLE provider_operations
  ADD CONSTRAINT provider_operations_kind_check CHECK (
    kind IN (
      'payment_create',
      'payment_reconcile',
      'resource_create',
      'resource_reconcile',
      'refund_create',
      'refund_reconcile'
    )
  );

CREATE TABLE IF NOT EXISTS refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  source_fund_receipt_id uuid NOT NULL REFERENCES fund_receipts(id),
  provider_installation_id text,
  original_external_payment_id text,
  destination text NOT NULL CHECK (destination IN ('original_payment', 'credit', 'none')),
  amount_mode text NOT NULL CHECK (amount_mode IN ('full', 'partial', 'none')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (
    status IN ('queued', 'processing', 'unknown', 'manual', 'succeeded', 'failed', 'declined')
  ),
  scenario text CHECK (
    scenario IS NULL
    OR scenario IN ('success', 'failed', 'timeout_success', 'duplicate_out_of_order')
  ),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  requested_session_id uuid NOT NULL REFERENCES sessions(id),
  requested_client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_occurred_at timestamptz,
  last_error text,
  security_hold boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key),
  UNIQUE (request_fingerprint),
  CHECK (
    (
      destination = 'original_payment'
      AND amount_minor > 0
      AND amount_mode IN ('full', 'partial')
      AND provider_installation_id IS NOT NULL
      AND original_external_payment_id IS NOT NULL
      AND scenario IS NOT NULL
      AND status IN ('queued', 'processing', 'unknown', 'manual', 'succeeded', 'failed')
    )
    OR (
      destination = 'credit'
      AND amount_minor > 0
      AND amount_mode IN ('full', 'partial')
      AND provider_installation_id IS NULL
      AND original_external_payment_id IS NULL
      AND scenario IS NULL
      AND status = 'succeeded'
    )
    OR (
      destination = 'none'
      AND amount_minor = 0
      AND amount_mode = 'none'
      AND provider_installation_id IS NULL
      AND original_external_payment_id IS NULL
      AND scenario IS NULL
      AND status = 'declined'
    )
  )
);

CREATE TABLE IF NOT EXISTS refund_request_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  refund_id uuid NOT NULL REFERENCES refunds(id),
  request_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (refund_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS refund_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id uuid NOT NULL REFERENCES refunds(id),
  event_type text NOT NULL CHECK (
    event_type IN (
      'requested',
      'processing',
      'unknown',
      'manual',
      'succeeded',
      'failed',
      'declined',
      'adjudicated',
      'provider_fact_ignored'
    )
  ),
  actor_type text NOT NULL CHECK (actor_type IN ('staff', 'provider', 'system')),
  actor_id text NOT NULL,
  reason text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refund_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id uuid NOT NULL UNIQUE REFERENCES refunds(id),
  provider_installation_id text,
  external_refund_id text,
  destination text NOT NULL CHECK (destination IN ('original_payment', 'credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (
      destination = 'original_payment'
      AND provider_installation_id IS NOT NULL
      AND external_refund_id IS NOT NULL
    )
    OR (
      destination = 'credit'
      AND provider_installation_id IS NULL
      AND external_refund_id IS NULL
    )
  ),
  UNIQUE (provider_installation_id, external_refund_id)
);

CREATE TABLE IF NOT EXISTS refund_provider_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id uuid NOT NULL REFERENCES refunds(id),
  provider_installation_id text NOT NULL,
  external_event_id text NOT NULL,
  external_refund_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz NOT NULL,
  fact_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_installation_id, fact_fingerprint)
);

CREATE TABLE IF NOT EXISTS refund_discrepancy_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_provider_fact_id uuid NOT NULL UNIQUE REFERENCES refund_provider_facts(id),
  refund_id uuid NOT NULL REFERENCES refunds(id),
  provider_installation_id text NOT NULL,
  external_refund_id text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_installation_id, external_refund_id)
);

CREATE TABLE IF NOT EXISTS refund_receipt_security_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_fund_receipt_id uuid NOT NULL REFERENCES fund_receipts(id),
  refund_id uuid NOT NULL REFERENCES refunds(id),
  refund_provider_fact_id uuid NOT NULL UNIQUE REFERENCES refund_provider_facts(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refund_security_hold_adjudications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_security_hold_id uuid NOT NULL UNIQUE REFERENCES refund_receipt_security_holds(id),
  refund_id uuid NOT NULL REFERENCES refunds(id),
  decision text NOT NULL CHECK (
    decision IN (
      'accept_authorized_outflow',
      'record_unexpected_outflow',
      'dismiss_provider_claim'
    )
  ),
  discrepancy_settlement_id uuid UNIQUE REFERENCES refund_discrepancy_settlements(id),
  staff_user_id uuid NOT NULL REFERENCES users(id),
  staff_session_id uuid NOT NULL REFERENCES sessions(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint text NOT NULL UNIQUE,
  expected_refund_version integer NOT NULL CHECK (expected_refund_version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refund_security_adjudication_aliases (
  idempotency_key text PRIMARY KEY CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  adjudication_id uuid NOT NULL REFERENCES refund_security_hold_adjudications(id),
  request_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
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

CREATE INDEX IF NOT EXISTS refunds_receipt_created_idx
  ON refunds (source_fund_receipt_id, created_at, id);
CREATE INDEX IF NOT EXISTS refunds_invoice_created_idx
  ON refunds (invoice_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS refunds_status_idx
  ON refunds (status, created_at, id);
CREATE INDEX IF NOT EXISTS refund_events_refund_created_idx
  ON refund_events (refund_id, created_at, id);
CREATE INDEX IF NOT EXISTS refund_provider_facts_refund_created_idx
  ON refund_provider_facts (refund_id, created_at, id);
CREATE INDEX IF NOT EXISTS refund_provider_facts_provider_event_idx
  ON refund_provider_facts (provider_installation_id, external_event_id);
CREATE INDEX IF NOT EXISTS refund_receipt_security_holds_receipt_created_idx
  ON refund_receipt_security_holds (source_fund_receipt_id, created_at, id);
CREATE INDEX IF NOT EXISTS refund_security_hold_adjudications_refund_created_idx
  ON refund_security_hold_adjudications (refund_id, created_at, id);
CREATE INDEX IF NOT EXISTS refund_manual_actions_refund_created_idx
  ON refund_manual_actions (refund_id, created_at, id);

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
    ) reserved_outflow;
  END IF;

  IF NEW.amount_minor > receipt_row.amount_minor - reserved_minor THEN
    RAISE EXCEPTION 'refund exceeds the remaining refundable amount';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refund_insert_guard ON refunds;
CREATE TRIGGER refund_insert_guard
BEFORE INSERT ON refunds
FOR EACH ROW EXECUTE FUNCTION opensales_validate_refund_insert();

CREATE OR REPLACE FUNCTION opensales_guard_refund_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.invoice_id <> OLD.invoice_id
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

DROP TRIGGER IF EXISTS refund_update_guard ON refunds;
CREATE TRIGGER refund_update_guard
BEFORE UPDATE ON refunds
FOR EACH ROW EXECUTE FUNCTION opensales_guard_refund_update();

CREATE OR REPLACE FUNCTION opensales_reject_refund_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'refund facts are append-only';
END;
$$;

DROP TRIGGER IF EXISTS refunds_no_delete ON refunds;
CREATE TRIGGER refunds_no_delete
BEFORE DELETE ON refunds
FOR EACH ROW EXECUTE FUNCTION opensales_reject_refund_delete();

DROP TRIGGER IF EXISTS refund_payment_allocations_append_only ON payment_allocations;
CREATE TRIGGER refund_payment_allocations_append_only
BEFORE UPDATE OR DELETE ON payment_allocations
FOR EACH ROW EXECUTE FUNCTION opensales_reject_refund_delete();

DROP TRIGGER IF EXISTS refund_events_append_only ON refund_events;
CREATE TRIGGER refund_events_append_only
BEFORE UPDATE OR DELETE ON refund_events
FOR EACH ROW EXECUTE FUNCTION opensales_reject_refund_delete();

DROP TRIGGER IF EXISTS refund_request_aliases_append_only ON refund_request_aliases;
CREATE TRIGGER refund_request_aliases_append_only
BEFORE UPDATE OR DELETE ON refund_request_aliases
FOR EACH ROW EXECUTE FUNCTION opensales_reject_refund_delete();

CREATE OR REPLACE FUNCTION opensales_validate_refund_request_alias()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM refunds refund
    WHERE refund.id = NEW.refund_id
      AND refund.request_fingerprint = NEW.request_fingerprint
  ) THEN
    RAISE EXCEPTION 'refund request alias does not match its immutable decision';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refund_request_alias_insert_guard ON refund_request_aliases;
CREATE TRIGGER refund_request_alias_insert_guard
BEFORE INSERT ON refund_request_aliases
FOR EACH ROW EXECUTE FUNCTION opensales_validate_refund_request_alias();

CREATE OR REPLACE FUNCTION opensales_validate_refund_provider_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM refunds refund
    WHERE refund.id = NEW.refund_id
      AND refund.destination = 'original_payment'
      AND refund.provider_installation_id = NEW.provider_installation_id
  ) THEN
    RAISE EXCEPTION 'refund Provider fact does not belong to its Core refund';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refund_provider_fact_insert_guard ON refund_provider_facts;
CREATE TRIGGER refund_provider_fact_insert_guard
BEFORE INSERT ON refund_provider_facts
FOR EACH ROW EXECUTE FUNCTION opensales_validate_refund_provider_fact();

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

DROP TRIGGER IF EXISTS refund_discrepancy_insert_guard ON refund_discrepancy_settlements;
CREATE TRIGGER refund_discrepancy_insert_guard
BEFORE INSERT ON refund_discrepancy_settlements
FOR EACH ROW EXECUTE FUNCTION opensales_validate_refund_discrepancy();

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

DROP TRIGGER IF EXISTS refund_receipt_security_hold_insert_guard
  ON refund_receipt_security_holds;
CREATE TRIGGER refund_receipt_security_hold_insert_guard
BEFORE INSERT ON refund_receipt_security_holds
FOR EACH ROW EXECUTE FUNCTION opensales_validate_refund_receipt_security_hold();

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

DROP TRIGGER IF EXISTS refund_security_adjudication_insert_guard
  ON refund_security_hold_adjudications;
CREATE TRIGGER refund_security_adjudication_insert_guard
BEFORE INSERT ON refund_security_hold_adjudications
FOR EACH ROW EXECUTE FUNCTION opensales_validate_refund_security_adjudication();

DROP TRIGGER IF EXISTS refund_settlements_append_only ON refund_settlements;
CREATE TRIGGER refund_settlements_append_only
BEFORE UPDATE OR DELETE ON refund_settlements
FOR EACH ROW EXECUTE FUNCTION opensales_reject_refund_delete();

DROP TRIGGER IF EXISTS refund_provider_facts_append_only ON refund_provider_facts;
CREATE TRIGGER refund_provider_facts_append_only
BEFORE UPDATE OR DELETE ON refund_provider_facts
FOR EACH ROW EXECUTE FUNCTION opensales_reject_refund_delete();

DROP TRIGGER IF EXISTS refund_discrepancy_settlements_append_only
  ON refund_discrepancy_settlements;
CREATE TRIGGER refund_discrepancy_settlements_append_only
BEFORE UPDATE OR DELETE ON refund_discrepancy_settlements
FOR EACH ROW EXECUTE FUNCTION opensales_reject_refund_delete();

DROP TRIGGER IF EXISTS refund_receipt_security_holds_append_only
  ON refund_receipt_security_holds;
CREATE TRIGGER refund_receipt_security_holds_append_only
BEFORE UPDATE OR DELETE ON refund_receipt_security_holds
FOR EACH ROW EXECUTE FUNCTION opensales_reject_refund_delete();

DROP TRIGGER IF EXISTS refund_security_hold_adjudications_append_only
  ON refund_security_hold_adjudications;
CREATE TRIGGER refund_security_hold_adjudications_append_only
BEFORE UPDATE OR DELETE ON refund_security_hold_adjudications
FOR EACH ROW EXECUTE FUNCTION opensales_reject_refund_delete();

DROP TRIGGER IF EXISTS refund_security_adjudication_aliases_append_only
  ON refund_security_adjudication_aliases;
CREATE TRIGGER refund_security_adjudication_aliases_append_only
BEFORE UPDATE OR DELETE ON refund_security_adjudication_aliases
FOR EACH ROW EXECUTE FUNCTION opensales_reject_refund_delete();

CREATE OR REPLACE FUNCTION opensales_validate_refund_adjudication_alias()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM refund_security_hold_adjudications adjudication
    WHERE adjudication.id = NEW.adjudication_id
      AND adjudication.request_fingerprint = NEW.request_fingerprint
  ) THEN
    RAISE EXCEPTION 'refund adjudication alias does not match its immutable decision';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refund_security_adjudication_alias_insert_guard
  ON refund_security_adjudication_aliases;
CREATE TRIGGER refund_security_adjudication_alias_insert_guard
BEFORE INSERT ON refund_security_adjudication_aliases
FOR EACH ROW EXECUTE FUNCTION opensales_validate_refund_adjudication_alias();

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
  ) recorded_outflow;

  IF receipt_amount_minor IS NULL
     OR prior_settled_minor + NEW.amount_minor > receipt_amount_minor THEN
    RAISE EXCEPTION 'refund settlements exceed the immutable source receipt amount';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refund_settlement_guard ON refund_settlements;
CREATE TRIGGER refund_settlement_guard
BEFORE INSERT ON refund_settlements
FOR EACH ROW EXECUTE FUNCTION opensales_validate_refund_settlement();

CREATE OR REPLACE FUNCTION opensales_validate_refund_credit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  refund_row record;
BEGIN
  IF NEW.kind <> 'refund' THEN
    RETURN NEW;
  END IF;
  IF NEW.source_type <> 'refund'
     OR NEW.debit_minor <> 0
     OR NEW.credit_minor <= 0 THEN
    RAISE EXCEPTION 'refund Credit has an invalid immutable source';
  END IF;

  SELECT
    refund.destination,
    refund.status,
    refund.amount_minor,
    refund.client_account_id,
    refund.currency,
    account.client_account_id AS credit_client_account_id,
    account.currency AS credit_currency
  INTO refund_row
  FROM refunds refund
  JOIN credit_accounts account ON account.id = NEW.credit_account_id
  WHERE refund.id = NEW.source_id;

  IF refund_row IS NULL
     OR refund_row.destination <> 'credit'
     OR refund_row.status <> 'succeeded'
     OR NEW.credit_minor <> refund_row.amount_minor
     OR refund_row.client_account_id <> refund_row.credit_client_account_id
     OR refund_row.currency <> refund_row.credit_currency THEN
    RAISE EXCEPTION 'refund Credit does not match its succeeded refund';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refund_credit_source_guard ON credit_transactions;
CREATE TRIGGER refund_credit_source_guard
BEFORE INSERT ON credit_transactions
FOR EACH ROW EXECUTE FUNCTION opensales_validate_refund_credit();
