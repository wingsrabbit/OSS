-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE credit_transactions
  DROP CONSTRAINT IF EXISTS credit_transactions_kind_check;
ALTER TABLE credit_transactions
  ADD CONSTRAINT credit_transactions_kind_check CHECK (
    kind IN (
      'manual_adjustment',
      'invoice_application',
      'invoice_application_reversal',
      'add_funds',
      'unclaimed_funds',
      'refund',
      'chargeback'
    )
  );

CREATE TABLE IF NOT EXISTS fund_receipt_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_receipt_id uuid NOT NULL REFERENCES fund_receipts(id),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  action text NOT NULL CHECK (action IN ('convert_to_credit', 'allocate_invoice')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  invoice_id uuid REFERENCES invoices(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key),
  CHECK (
    (action = 'allocate_invoice' AND invoice_id IS NOT NULL)
    OR (action = 'convert_to_credit' AND invoice_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS fund_receipt_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resolution_id uuid NOT NULL UNIQUE REFERENCES fund_receipt_resolutions(id),
  fund_receipt_id uuid NOT NULL REFERENCES fund_receipts(id),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fund_receipt_resolutions_receipt_created_idx
  ON fund_receipt_resolutions (fund_receipt_id, created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS fund_receipt_resolutions_semantic_unique
  ON fund_receipt_resolutions (fund_receipt_id, request_fingerprint);
CREATE INDEX IF NOT EXISTS fund_receipt_allocations_invoice_idx
  ON fund_receipt_allocations (invoice_id);

CREATE OR REPLACE FUNCTION opensales_validate_fund_receipt_resolution()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_row record;
  invoice_row record;
  invoice_allocated bigint;
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

  IF receipt_row IS NULL
     OR NEW.client_account_id <> receipt_row.client_account_id
     OR NEW.currency <> receipt_row.currency
     OR NEW.amount_minor > receipt_row.amount_minor - receipt_row.allocated_minor THEN
    RAISE EXCEPTION 'fund receipt resolution exceeds or mismatches remaining funds';
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

DROP TRIGGER IF EXISTS fund_receipt_resolution_guard ON fund_receipt_resolutions;
CREATE TRIGGER fund_receipt_resolution_guard
BEFORE INSERT ON fund_receipt_resolutions
FOR EACH ROW EXECUTE FUNCTION opensales_validate_fund_receipt_resolution();

CREATE OR REPLACE FUNCTION opensales_reject_fund_resolution_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'fund receipt resolutions are append-only';
END;
$$;

DROP TRIGGER IF EXISTS fund_receipt_resolutions_append_only ON fund_receipt_resolutions;
CREATE TRIGGER fund_receipt_resolutions_append_only
BEFORE UPDATE OR DELETE ON fund_receipt_resolutions
FOR EACH ROW EXECUTE FUNCTION opensales_reject_fund_resolution_mutation();

DROP TRIGGER IF EXISTS fund_receipt_allocations_append_only ON fund_receipt_allocations;
CREATE TRIGGER fund_receipt_allocations_append_only
BEFORE UPDATE OR DELETE ON fund_receipt_allocations
FOR EACH ROW EXECUTE FUNCTION opensales_reject_fund_resolution_mutation();

CREATE OR REPLACE FUNCTION opensales_validate_fund_receipt_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  resolution_row record;
BEGIN
  SELECT
    resolution.id,
    resolution.action,
    resolution.fund_receipt_id,
    resolution.invoice_id,
    resolution.amount_minor,
    resolution.client_account_id,
    resolution.currency,
    receipt.client_account_id AS receipt_client_account_id,
    receipt.currency AS receipt_currency,
    invoice.client_account_id AS invoice_client_account_id,
    invoice.currency AS invoice_currency
  INTO resolution_row
  FROM fund_receipt_resolutions resolution
  JOIN fund_receipts receipt ON receipt.id = resolution.fund_receipt_id
  JOIN invoices invoice ON invoice.id = resolution.invoice_id
  WHERE resolution.id = NEW.resolution_id;

  IF resolution_row IS NULL
     OR resolution_row.action <> 'allocate_invoice'
     OR NEW.fund_receipt_id <> resolution_row.fund_receipt_id
     OR NEW.invoice_id <> resolution_row.invoice_id
     OR NEW.amount_minor <> resolution_row.amount_minor
     OR resolution_row.client_account_id <> resolution_row.receipt_client_account_id
     OR resolution_row.client_account_id <> resolution_row.invoice_client_account_id
     OR resolution_row.currency <> resolution_row.receipt_currency
     OR resolution_row.currency <> resolution_row.invoice_currency THEN
    RAISE EXCEPTION 'fund receipt allocation does not match its immutable resolution';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fund_receipt_allocation_guard ON fund_receipt_allocations;
CREATE TRIGGER fund_receipt_allocation_guard
BEFORE INSERT ON fund_receipt_allocations
FOR EACH ROW EXECUTE FUNCTION opensales_validate_fund_receipt_allocation();

CREATE OR REPLACE FUNCTION opensales_validate_unclaimed_funds_credit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  resolution_row record;
BEGIN
  IF NEW.kind <> 'unclaimed_funds' THEN
    RETURN NEW;
  END IF;
  IF NEW.source_type <> 'fund_receipt_resolution'
     OR NEW.debit_minor <> 0
     OR NEW.credit_minor <= 0 THEN
    RAISE EXCEPTION 'unclaimed funds Credit has an invalid immutable source';
  END IF;

  SELECT
    resolution.action,
    resolution.amount_minor,
    resolution.client_account_id,
    resolution.currency,
    receipt.client_account_id AS receipt_client_account_id,
    receipt.currency AS receipt_currency,
    account.client_account_id AS credit_client_account_id,
    account.currency AS credit_currency
  INTO resolution_row
  FROM fund_receipt_resolutions resolution
  JOIN fund_receipts receipt ON receipt.id = resolution.fund_receipt_id
  JOIN credit_accounts account ON account.id = NEW.credit_account_id
  WHERE resolution.id = NEW.source_id;

  IF resolution_row IS NULL
     OR resolution_row.action <> 'convert_to_credit'
     OR NEW.credit_minor <> resolution_row.amount_minor
     OR resolution_row.client_account_id <> resolution_row.receipt_client_account_id
     OR resolution_row.client_account_id <> resolution_row.credit_client_account_id
     OR resolution_row.currency <> resolution_row.receipt_currency
     OR resolution_row.currency <> resolution_row.credit_currency THEN
    RAISE EXCEPTION 'unclaimed funds Credit does not match its resolution';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS unclaimed_funds_credit_source_guard ON credit_transactions;
CREATE TRIGGER unclaimed_funds_credit_source_guard
BEFORE INSERT ON credit_transactions
FOR EACH ROW EXECUTE FUNCTION opensales_validate_unclaimed_funds_credit();

CREATE OR REPLACE VIEW invoice_allocation_totals AS
SELECT
  invoice.id AS invoice_id,
  (
    COALESCE(payment.amount_minor, 0)
    + COALESCE(unclaimed.amount_minor, 0)
  )::bigint AS payment_minor,
  COALESCE(credit.amount_minor, 0)::bigint AS credit_minor,
  (
    COALESCE(payment.amount_minor, 0)
    + COALESCE(unclaimed.amount_minor, 0)
    + COALESCE(credit.amount_minor, 0)
  )::bigint AS allocated_minor,
  COALESCE(unclaimed.amount_minor, 0)::bigint AS fund_receipt_minor
FROM invoices invoice
LEFT JOIN LATERAL (
  SELECT sum(allocation.amount_minor) AS amount_minor
  FROM payment_allocations allocation
  WHERE allocation.invoice_id = invoice.id
) payment ON true
LEFT JOIN LATERAL (
  SELECT sum(allocation.amount_minor) AS amount_minor
  FROM fund_receipt_allocations allocation
  WHERE allocation.invoice_id = invoice.id
) unclaimed ON true
LEFT JOIN LATERAL (
  SELECT sum(allocation.amount_minor) AS amount_minor
  FROM credit_allocations allocation
  WHERE allocation.invoice_id = invoice.id
) credit ON true;

CREATE OR REPLACE FUNCTION opensales_guard_credit_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  available_minor bigint;
  account_currency text;
  cap_minor bigint;
BEGIN
  SELECT currency
  INTO account_currency
  FROM credit_accounts
  WHERE id = NEW.credit_account_id
  FOR UPDATE;

  SELECT COALESCE(sum(credit_minor - debit_minor), 0)
  INTO available_minor
  FROM credit_transactions
  WHERE credit_account_id = NEW.credit_account_id;

  IF available_minor + NEW.credit_minor - NEW.debit_minor < 0 THEN
    RAISE EXCEPTION 'credit balance cannot become negative';
  END IF;

  IF NEW.kind IN ('add_funds', 'unclaimed_funds') THEN
    SELECT balance_cap_minor
    INTO cap_minor
    FROM add_funds_policies
    WHERE currency = account_currency;
    IF cap_minor IS NULL
       OR available_minor + NEW.credit_minor - NEW.debit_minor > cap_minor THEN
      RAISE EXCEPTION 'Credit would exceed the configured balance cap';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
