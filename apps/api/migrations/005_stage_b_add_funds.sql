-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE payment_methods
  ADD COLUMN IF NOT EXISTS add_funds_enabled boolean NOT NULL DEFAULT false;

UPDATE provider_inbox
SET payload = jsonb_set(payload, '{callbackCapability}', '"[REDACTED]"'::jsonb)
WHERE payload ? 'callbackCapability'
  AND payload->>'callbackCapability' <> '[REDACTED]';

CREATE TABLE IF NOT EXISTS add_funds_policies (
  currency text PRIMARY KEY CHECK (currency ~ '^[A-Z]{3}$'),
  enabled boolean NOT NULL DEFAULT false,
  min_principal_minor bigint NOT NULL CHECK (min_principal_minor > 0),
  max_principal_minor bigint NOT NULL CHECK (max_principal_minor >= min_principal_minor),
  balance_cap_minor bigint NOT NULL CHECK (balance_cap_minor >= max_principal_minor),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS add_funds_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  payment_method_code text NOT NULL REFERENCES payment_methods(code),
  provider_installation_id text NOT NULL,
  currency text NOT NULL REFERENCES add_funds_policies(currency),
  principal_minor bigint NOT NULL CHECK (principal_minor > 0),
  balance_before_minor bigint NOT NULL CHECK (balance_before_minor >= 0),
  balance_cap_minor bigint NOT NULL CHECK (balance_cap_minor > 0),
  fee_basis_points integer NOT NULL CHECK (fee_basis_points BETWEEN 0 AND 10000),
  fee_minor bigint NOT NULL CHECK (fee_minor >= 0),
  external_due_minor bigint NOT NULL CHECK (external_due_minor > 0),
  request_fingerprint text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (external_due_minor = principal_minor + fee_minor),
  CHECK (balance_before_minor + principal_minor <= balance_cap_minor)
);

CREATE TABLE IF NOT EXISTS add_funds_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  submitted_by_user_id uuid NOT NULL REFERENCES users(id),
  quote_id uuid NOT NULL UNIQUE REFERENCES add_funds_quotes(id),
  provider_installation_id text NOT NULL,
  external_payment_id text,
  status text NOT NULL CHECK (
    status IN ('created', 'processing', 'unknown', 'succeeded', 'failed', 'cancelled', 'expired')
  ),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  principal_minor bigint NOT NULL CHECK (principal_minor > 0),
  fee_basis_points integer NOT NULL CHECK (fee_basis_points BETWEEN 0 AND 10000),
  fee_minor bigint NOT NULL CHECK (fee_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  scenario text NOT NULL,
  payment_method_code text NOT NULL REFERENCES payment_methods(code),
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  provider_occurred_at timestamptz,
  expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_account_id, idempotency_key),
  UNIQUE (provider_installation_id, external_payment_id),
  CHECK (amount_minor = principal_minor + fee_minor)
);

CREATE TABLE IF NOT EXISTS add_funds_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  submitted_by_user_id uuid NOT NULL REFERENCES users(id),
  quote_id uuid NOT NULL REFERENCES add_funds_quotes(id),
  add_funds_attempt_id uuid NOT NULL UNIQUE REFERENCES add_funds_attempts(id),
  status text NOT NULL CHECK (
    status IN (
      'created', 'processing', 'unknown', 'manual',
      'succeeded', 'failed', 'cancelled', 'expired'
    )
  ),
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_account_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS add_funds_quotes_account_created_idx
  ON add_funds_quotes (client_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS add_funds_attempts_account_status_idx
  ON add_funds_attempts (client_account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS add_funds_commands_account_created_idx
  ON add_funds_commands (client_account_id, created_at DESC);

DROP TRIGGER IF EXISTS add_funds_quotes_append_only ON add_funds_quotes;
CREATE TRIGGER add_funds_quotes_append_only
BEFORE UPDATE OR DELETE ON add_funds_quotes
FOR EACH ROW EXECUTE FUNCTION opensales_reject_credit_mutation();

ALTER TABLE fund_receipts
  ALTER COLUMN reported_payment_attempt_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS reported_add_funds_attempt_id uuid
    REFERENCES add_funds_attempts(id);

ALTER TABLE fund_receipts
  DROP CONSTRAINT IF EXISTS fund_receipts_exactly_one_attempt;
ALTER TABLE fund_receipts
  ADD CONSTRAINT fund_receipts_exactly_one_attempt CHECK (
    (reported_payment_attempt_id IS NOT NULL) <>
    (reported_add_funds_attempt_id IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION opensales_guard_fund_receipt_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Fund receipt external facts are append-only';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.provider_installation_id IS DISTINCT FROM OLD.provider_installation_id
     OR NEW.external_payment_id IS DISTINCT FROM OLD.external_payment_id
     OR NEW.reported_payment_attempt_id IS DISTINCT FROM OLD.reported_payment_attempt_id
     OR NEW.reported_add_funds_attempt_id IS DISTINCT FROM OLD.reported_add_funds_attempt_id
     OR NEW.client_account_id IS DISTINCT FROM OLD.client_account_id
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Fund receipt external facts are append-only';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fund_receipts_external_facts_append_only ON fund_receipts;
CREATE TRIGGER fund_receipts_external_facts_append_only
BEFORE UPDATE OR DELETE ON fund_receipts
FOR EACH ROW EXECUTE FUNCTION opensales_guard_fund_receipt_fact_mutation();

CREATE TABLE IF NOT EXISTS add_funds_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id uuid NOT NULL UNIQUE REFERENCES add_funds_commands(id),
  add_funds_attempt_id uuid NOT NULL UNIQUE REFERENCES add_funds_attempts(id),
  fund_receipt_id uuid NOT NULL UNIQUE REFERENCES fund_receipts(id),
  credit_transaction_id uuid UNIQUE REFERENCES credit_transactions(id),
  principal_minor bigint NOT NULL CHECK (principal_minor > 0),
  fee_minor bigint NOT NULL CHECK (fee_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    credit_transaction_id IS NULL
    OR principal_minor > 0
  )
);

CREATE OR REPLACE FUNCTION opensales_guard_add_funds_settlement_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR OLD.credit_transaction_id IS NOT NULL
     OR NEW.credit_transaction_id IS NULL
     OR NEW.id <> OLD.id
     OR NEW.command_id <> OLD.command_id
     OR NEW.add_funds_attempt_id <> OLD.add_funds_attempt_id
     OR NEW.fund_receipt_id <> OLD.fund_receipt_id
     OR NEW.principal_minor <> OLD.principal_minor
     OR NEW.fee_minor <> OLD.fee_minor
     OR NEW.currency <> OLD.currency
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION
      'Add Funds settlements are append-only except for their one-time Credit link';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS add_funds_settlements_append_only ON add_funds_settlements;
CREATE TRIGGER add_funds_settlements_append_only
BEFORE UPDATE OR DELETE ON add_funds_settlements
FOR EACH ROW EXECUTE FUNCTION opensales_guard_add_funds_settlement_mutation();

CREATE OR REPLACE FUNCTION opensales_validate_add_funds_credit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  settlement_row record;
BEGIN
  IF NEW.kind <> 'add_funds' THEN
    RETURN NEW;
  END IF;
  IF NEW.source_type <> 'add_funds_settlement'
     OR NEW.debit_minor <> 0
     OR NEW.credit_minor <= 0 THEN
    RAISE EXCEPTION 'Add Funds Credit has an invalid immutable source';
  END IF;

  SELECT
    settlement.principal_minor,
    settlement.fee_minor,
    settlement.currency,
    settlement.add_funds_attempt_id,
    command.add_funds_attempt_id AS command_attempt_id,
    attempt.client_account_id,
    attempt.principal_minor AS attempt_principal_minor,
    attempt.fee_minor AS attempt_fee_minor,
    attempt.amount_minor AS attempt_amount_minor,
    attempt.currency AS attempt_currency,
    receipt.client_account_id AS receipt_client_account_id,
    receipt.reported_add_funds_attempt_id,
    receipt.currency AS receipt_currency,
    receipt.amount_minor,
    receipt.disposition,
    account.client_account_id AS credit_client_account_id,
    account.currency AS credit_currency
  INTO settlement_row
  FROM add_funds_settlements settlement
  JOIN add_funds_commands command
    ON command.id = settlement.command_id
  JOIN add_funds_attempts attempt
    ON attempt.id = settlement.add_funds_attempt_id
  JOIN fund_receipts receipt
    ON receipt.id = settlement.fund_receipt_id
  JOIN credit_accounts account
    ON account.id = NEW.credit_account_id
  WHERE settlement.id = NEW.source_id;

  IF settlement_row IS NULL
     OR NEW.credit_minor <> settlement_row.principal_minor
     OR settlement_row.add_funds_attempt_id <> settlement_row.command_attempt_id
     OR settlement_row.add_funds_attempt_id <>
          settlement_row.reported_add_funds_attempt_id
     OR settlement_row.principal_minor <> settlement_row.attempt_principal_minor
     OR settlement_row.fee_minor <> settlement_row.attempt_fee_minor
     OR settlement_row.amount_minor <> settlement_row.attempt_amount_minor
     OR settlement_row.currency <> settlement_row.attempt_currency
     OR settlement_row.client_account_id <> settlement_row.receipt_client_account_id
     OR settlement_row.client_account_id <> settlement_row.credit_client_account_id
     OR settlement_row.currency <> settlement_row.receipt_currency
     OR settlement_row.currency <> settlement_row.credit_currency
     OR settlement_row.amount_minor <>
          settlement_row.principal_minor + settlement_row.fee_minor THEN
    RAISE EXCEPTION 'Add Funds Credit does not match its settlement facts';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS add_funds_credit_source_guard ON credit_transactions;
CREATE TRIGGER add_funds_credit_source_guard
BEFORE INSERT ON credit_transactions
FOR EACH ROW EXECUTE FUNCTION opensales_validate_add_funds_credit();

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

  IF NEW.kind = 'add_funds' THEN
    SELECT balance_cap_minor
    INTO cap_minor
    FROM add_funds_policies
    WHERE currency = account_currency;
    IF cap_minor IS NULL
       OR available_minor + NEW.credit_minor - NEW.debit_minor > cap_minor THEN
      RAISE EXCEPTION 'Add Funds would exceed the configured Credit balance cap';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
