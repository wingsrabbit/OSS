-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS request_fingerprint text;
UPDATE orders
SET request_fingerprint = 'legacy:' || id::text
WHERE request_fingerprint IS NULL;
ALTER TABLE orders
  ALTER COLUMN request_fingerprint SET NOT NULL;

ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS request_fingerprint text,
  ADD COLUMN IF NOT EXISTS provider_occurred_at timestamptz;
UPDATE payment_attempts
SET request_fingerprint = 'legacy:' || id::text
WHERE request_fingerprint IS NULL;
ALTER TABLE payment_attempts
  ALTER COLUMN request_fingerprint SET NOT NULL;

ALTER TABLE provider_operations
  ADD COLUMN IF NOT EXISTS provider_occurred_at timestamptz;

ALTER TABLE email_verification_tokens
  ADD COLUMN IF NOT EXISTS invalidated_at timestamptz;

ALTER TABLE services
  DROP CONSTRAINT IF EXISTS services_status_check;
ALTER TABLE services
  ADD CONSTRAINT services_status_check CHECK (
    status IN (
      'pending',
      'provisioning',
      'confirming',
      'provisioned_hold',
      'provision_failed',
      'active',
      'suspended',
      'terminated'
    )
  );

CREATE TABLE IF NOT EXISTS fund_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_installation_id text NOT NULL,
  external_payment_id text NOT NULL,
  reported_payment_attempt_id uuid NOT NULL REFERENCES payment_attempts(id),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  allocated_minor bigint NOT NULL DEFAULT 0 CHECK (allocated_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz NOT NULL,
  disposition text NOT NULL CHECK (
    disposition IN ('received', 'allocated', 'partially_allocated', 'unclaimed')
  ),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_installation_id, external_payment_id),
  CHECK (allocated_minor <= amount_minor)
);

INSERT INTO fund_receipts(
  provider_installation_id,
  external_payment_id,
  reported_payment_attempt_id,
  client_account_id,
  amount_minor,
  allocated_minor,
  currency,
  occurred_at,
  disposition,
  reason
)
SELECT
  pa.provider_installation_id,
  pa.external_payment_id,
  pa.id,
  pa.client_account_id,
  pa.amount_minor,
  LEAST(pa.amount_minor, COALESCE(alloc.allocated_minor, 0)),
  pa.currency,
  COALESCE(pa.provider_occurred_at, pa.updated_at),
  CASE
    WHEN COALESCE(alloc.allocated_minor, 0) >= pa.amount_minor THEN 'allocated'
    WHEN COALESCE(alloc.allocated_minor, 0) > 0 THEN 'partially_allocated'
    ELSE 'unclaimed'
  END,
  CASE
    WHEN COALESCE(alloc.allocated_minor, 0) = 0 THEN 'legacy succeeded payment without allocation'
    ELSE NULL
  END
FROM payment_attempts pa
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(amount_minor), 0) AS allocated_minor
  FROM payment_allocations
  WHERE payment_attempt_id = pa.id
) alloc ON true
WHERE pa.status = 'succeeded'
  AND pa.external_payment_id IS NOT NULL
ON CONFLICT (provider_installation_id, external_payment_id) DO NOTHING;

INSERT INTO ledger_journals(source_type, source_id, currency, description)
SELECT 'invoice_issuance', i.id, i.currency, 'Invoice issued'
FROM invoices i
ON CONFLICT (source_type, source_id) DO NOTHING;

INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
SELECT lj.id, 'accounts_receivable', i.total_minor, 0
FROM invoices i
JOIN ledger_journals lj
  ON lj.source_type = 'invoice_issuance'
 AND lj.source_id = i.id
WHERE i.total_minor > 0
  AND NOT EXISTS (
    SELECT 1 FROM ledger_lines existing WHERE existing.journal_id = lj.id
  );

INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
SELECT lj.id, 'deferred_service_revenue', 0, i.total_minor
FROM invoices i
JOIN ledger_journals lj
  ON lj.source_type = 'invoice_issuance'
 AND lj.source_id = i.id
WHERE i.total_minor > 0
  AND (
    SELECT count(*) FROM ledger_lines existing WHERE existing.journal_id = lj.id
  ) = 1;

CREATE OR REPLACE FUNCTION opensales_reject_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ledger records are append-only; post a compensating journal';
END;
$$;

DROP TRIGGER IF EXISTS ledger_journals_append_only ON ledger_journals;
CREATE TRIGGER ledger_journals_append_only
BEFORE UPDATE OR DELETE ON ledger_journals
FOR EACH ROW EXECUTE FUNCTION opensales_reject_ledger_mutation();

DROP TRIGGER IF EXISTS ledger_lines_append_only ON ledger_lines;
CREATE TRIGGER ledger_lines_append_only
BEFORE UPDATE OR DELETE ON ledger_lines
FOR EACH ROW EXECUTE FUNCTION opensales_reject_ledger_mutation();

CREATE OR REPLACE FUNCTION opensales_assert_journal_balanced()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  imbalance bigint;
BEGIN
  SELECT COALESCE(sum(debit_minor - credit_minor), 0)
  INTO imbalance
  FROM ledger_lines
  WHERE journal_id = NEW.journal_id;

  IF imbalance <> 0 THEN
    RAISE EXCEPTION 'ledger journal % is not balanced', NEW.journal_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ledger_journal_balance_guard ON ledger_lines;
CREATE CONSTRAINT TRIGGER ledger_journal_balance_guard
AFTER INSERT ON ledger_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opensales_assert_journal_balanced();

CREATE INDEX IF NOT EXISTS fund_receipts_unclaimed_idx
  ON fund_receipts (created_at)
  WHERE disposition IN ('received', 'partially_allocated', 'unclaimed');

CREATE OR REPLACE FUNCTION opensales_invalidate_user_reauth()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.restricted_at IS DISTINCT FROM OLD.restricted_at
     OR NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
    UPDATE reauth_grants
    SET invalidated_at = now()
    WHERE user_id = NEW.id AND invalidated_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_invalidate_reauth ON users;
CREATE TRIGGER users_invalidate_reauth
AFTER UPDATE OF restricted_at, password_hash ON users
FOR EACH ROW EXECUTE FUNCTION opensales_invalidate_user_reauth();

CREATE OR REPLACE FUNCTION opensales_invalidate_staff_reauth()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.active IS DISTINCT FROM OLD.active
     OR NEW.roles IS DISTINCT FROM OLD.roles
     OR NEW.permissions IS DISTINCT FROM OLD.permissions THEN
    UPDATE reauth_grants
    SET invalidated_at = now()
    WHERE user_id = NEW.user_id AND invalidated_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS staff_invalidate_reauth ON staff_members;
CREATE TRIGGER staff_invalidate_reauth
AFTER UPDATE OF active, roles, permissions ON staff_members
FOR EACH ROW EXECUTE FUNCTION opensales_invalidate_staff_reauth();
