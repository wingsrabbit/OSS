-- SPDX-License-Identifier: AGPL-3.0-or-later

CREATE TABLE IF NOT EXISTS payment_methods (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_-]{1,31}$'),
  display_name jsonb NOT NULL,
  provider_installation_id text NOT NULL,
  fee_basis_points integer NOT NULL CHECK (fee_basis_points BETWEEN 0 AND 10000),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS payment_method_code text REFERENCES payment_methods(code),
  ADD COLUMN IF NOT EXISTS principal_minor bigint CHECK (principal_minor > 0),
  ADD COLUMN IF NOT EXISTS fee_basis_points integer NOT NULL DEFAULT 0
    CHECK (fee_basis_points BETWEEN 0 AND 10000),
  ADD COLUMN IF NOT EXISTS fee_minor bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0);

CREATE TABLE IF NOT EXISTS credit_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_account_id, currency)
);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_account_id uuid NOT NULL REFERENCES credit_accounts(id),
  kind text NOT NULL CHECK (
    kind IN (
      'manual_adjustment',
      'invoice_application',
      'add_funds',
      'refund',
      'chargeback'
    )
  ),
  credit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  debit_minor bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'staff', 'system', 'provider')),
  actor_id uuid,
  reason text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((credit_minor = 0) <> (debit_minor = 0)),
  UNIQUE (credit_account_id, idempotency_key),
  UNIQUE (kind, source_type, source_id)
);

CREATE TABLE IF NOT EXISTS credit_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_transaction_id uuid NOT NULL UNIQUE REFERENCES credit_transactions(id),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice_payment_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  payment_method_code text NOT NULL REFERENCES payment_methods(code),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  invoice_total_minor bigint NOT NULL CHECK (invoice_total_minor >= 0),
  payment_allocated_minor bigint NOT NULL CHECK (payment_allocated_minor >= 0),
  credit_allocated_minor bigint NOT NULL CHECK (credit_allocated_minor >= 0),
  available_credit_minor bigint NOT NULL CHECK (available_credit_minor >= 0),
  credit_to_apply_minor bigint NOT NULL CHECK (credit_to_apply_minor >= 0),
  external_non_fee_minor bigint NOT NULL CHECK (external_non_fee_minor >= 0),
  fee_basis_points integer NOT NULL CHECK (fee_basis_points BETWEEN 0 AND 10000),
  fee_minor bigint NOT NULL CHECK (fee_minor >= 0),
  external_due_minor bigint NOT NULL CHECK (external_due_minor >= 0),
  request_fingerprint text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (external_due_minor = external_non_fee_minor + fee_minor)
);

ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS payment_quote_id uuid REFERENCES invoice_payment_quotes(id);

CREATE TABLE IF NOT EXISTS invoice_payment_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  quote_id uuid NOT NULL REFERENCES invoice_payment_quotes(id),
  payment_attempt_id uuid REFERENCES payment_attempts(id),
  status text NOT NULL CHECK (status IN ('created', 'processing', 'succeeded', 'failed')),
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_account_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS invoice_fee_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  payment_attempt_id uuid NOT NULL UNIQUE REFERENCES payment_attempts(id),
  invoice_line_id uuid NOT NULL UNIQUE REFERENCES invoice_lines(id),
  payment_method_code text NOT NULL REFERENCES payment_methods(code),
  basis_minor bigint NOT NULL CHECK (basis_minor > 0),
  basis_points integer NOT NULL CHECK (basis_points BETWEEN 1 AND 10000),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credit_transactions_account_created_idx
  ON credit_transactions (credit_account_id, created_at, id);
CREATE INDEX IF NOT EXISTS credit_allocations_invoice_idx
  ON credit_allocations (invoice_id);
CREATE INDEX IF NOT EXISTS invoice_payment_quotes_invoice_created_idx
  ON invoice_payment_quotes (invoice_id, created_at DESC);

CREATE OR REPLACE FUNCTION opensales_reject_credit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'credit records are append-only; post a compensating transaction';
END;
$$;

DROP TRIGGER IF EXISTS credit_accounts_append_only ON credit_accounts;
CREATE TRIGGER credit_accounts_append_only
BEFORE UPDATE OR DELETE ON credit_accounts
FOR EACH ROW EXECUTE FUNCTION opensales_reject_credit_mutation();

DROP TRIGGER IF EXISTS credit_transactions_append_only ON credit_transactions;
CREATE TRIGGER credit_transactions_append_only
BEFORE UPDATE OR DELETE ON credit_transactions
FOR EACH ROW EXECUTE FUNCTION opensales_reject_credit_mutation();

DROP TRIGGER IF EXISTS credit_allocations_append_only ON credit_allocations;
CREATE TRIGGER credit_allocations_append_only
BEFORE UPDATE OR DELETE ON credit_allocations
FOR EACH ROW EXECUTE FUNCTION opensales_reject_credit_mutation();

DROP TRIGGER IF EXISTS invoice_payment_quotes_append_only ON invoice_payment_quotes;
CREATE TRIGGER invoice_payment_quotes_append_only
BEFORE UPDATE OR DELETE ON invoice_payment_quotes
FOR EACH ROW EXECUTE FUNCTION opensales_reject_credit_mutation();

DROP TRIGGER IF EXISTS invoice_fee_charges_append_only ON invoice_fee_charges;
CREATE TRIGGER invoice_fee_charges_append_only
BEFORE UPDATE OR DELETE ON invoice_fee_charges
FOR EACH ROW EXECUTE FUNCTION opensales_reject_credit_mutation();

CREATE OR REPLACE FUNCTION opensales_guard_credit_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  available_minor bigint;
BEGIN
  PERFORM 1
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
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS credit_balance_guard ON credit_transactions;
CREATE TRIGGER credit_balance_guard
BEFORE INSERT ON credit_transactions
FOR EACH ROW EXECUTE FUNCTION opensales_guard_credit_balance();

CREATE OR REPLACE FUNCTION opensales_validate_credit_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  transaction_row record;
  invoice_row record;
BEGIN
  SELECT
    ct.kind,
    ct.credit_minor,
    ct.debit_minor,
    ca.client_account_id,
    ca.currency
  INTO transaction_row
  FROM credit_transactions ct
  JOIN credit_accounts ca ON ca.id = ct.credit_account_id
  WHERE ct.id = NEW.credit_transaction_id;

  SELECT client_account_id, currency
  INTO invoice_row
  FROM invoices
  WHERE id = NEW.invoice_id;

  IF transaction_row.kind <> 'invoice_application'
     OR transaction_row.credit_minor <> 0
     OR transaction_row.debit_minor <> NEW.amount_minor
     OR transaction_row.client_account_id <> invoice_row.client_account_id
     OR transaction_row.currency <> invoice_row.currency THEN
    RAISE EXCEPTION 'credit allocation does not match its transaction or invoice';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS credit_allocation_guard ON credit_allocations;
CREATE TRIGGER credit_allocation_guard
BEFORE INSERT ON credit_allocations
FOR EACH ROW EXECUTE FUNCTION opensales_validate_credit_allocation();

CREATE OR REPLACE VIEW invoice_allocation_totals AS
SELECT
  i.id AS invoice_id,
  COALESCE(pay.amount_minor, 0)::bigint AS payment_minor,
  COALESCE(credit.amount_minor, 0)::bigint AS credit_minor,
  (COALESCE(pay.amount_minor, 0) + COALESCE(credit.amount_minor, 0))::bigint
    AS allocated_minor
FROM invoices i
LEFT JOIN LATERAL (
  SELECT sum(pa.amount_minor) AS amount_minor
  FROM payment_allocations pa
  WHERE pa.invoice_id = i.id
) pay ON true
LEFT JOIN LATERAL (
  SELECT sum(ca.amount_minor) AS amount_minor
  FROM credit_allocations ca
  WHERE ca.invoice_id = i.id
) credit ON true;
