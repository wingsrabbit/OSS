-- SPDX-License-Identifier: AGPL-3.0-or-later

CREATE TABLE IF NOT EXISTS add_funds_chargeback_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_installation_id text NOT NULL,
  provider_operation_id uuid NOT NULL REFERENCES provider_operations(id),
  add_funds_attempt_id uuid NOT NULL REFERENCES add_funds_attempts(id),
  external_event_id text NOT NULL,
  original_external_payment_id text NOT NULL,
  external_chargeback_id text NOT NULL,
  status text NOT NULL CHECK (status = 'succeeded'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz NOT NULL,
  fact_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_installation_id, external_event_id)
);

CREATE INDEX IF NOT EXISTS add_funds_chargeback_facts_external_idx
  ON add_funds_chargeback_facts (
    provider_installation_id, external_chargeback_id, created_at
  );

CREATE TABLE IF NOT EXISTS add_funds_chargeback_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id uuid NOT NULL UNIQUE REFERENCES add_funds_chargeback_facts(id),
  add_funds_settlement_id uuid NOT NULL UNIQUE REFERENCES add_funds_settlements(id),
  fund_receipt_id uuid NOT NULL UNIQUE REFERENCES fund_receipts(id),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  credit_account_id uuid NOT NULL REFERENCES credit_accounts(id),
  provider_installation_id text NOT NULL,
  original_external_payment_id text NOT NULL,
  external_chargeback_id text NOT NULL,
  principal_minor bigint NOT NULL CHECK (principal_minor > 0),
  fee_minor bigint NOT NULL CHECK (fee_minor >= 0),
  external_amount_minor bigint NOT NULL CHECK (external_amount_minor > 0),
  credit_recovered_minor bigint NOT NULL CHECK (credit_recovered_minor >= 0),
  debt_minor bigint NOT NULL CHECK (debt_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_installation_id, external_chargeback_id),
  CHECK (external_amount_minor = principal_minor + fee_minor),
  CHECK (credit_recovered_minor + debt_minor = principal_minor)
);

CREATE TABLE IF NOT EXISTS add_funds_chargeback_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id uuid NOT NULL UNIQUE REFERENCES add_funds_chargeback_facts(id),
  client_account_id uuid REFERENCES client_accounts(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS add_funds_unclaimed_chargeback_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id uuid NOT NULL UNIQUE REFERENCES add_funds_chargeback_facts(id),
  fund_receipt_id uuid NOT NULL UNIQUE REFERENCES fund_receipts(id),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  provider_installation_id text NOT NULL,
  original_external_payment_id text NOT NULL,
  external_chargeback_id text NOT NULL,
  external_amount_minor bigint NOT NULL CHECK (external_amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_installation_id, external_chargeback_id)
);

CREATE TABLE IF NOT EXISTS add_funds_chargeback_replay_dispositions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id uuid NOT NULL UNIQUE REFERENCES add_funds_chargeback_facts(id),
  canonical_effect_id uuid REFERENCES add_funds_chargeback_effects(id),
  canonical_unclaimed_effect_id uuid REFERENCES add_funds_unclaimed_chargeback_effects(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((canonical_effect_id IS NULL) <> (canonical_unclaimed_effect_id IS NULL))
);

ALTER TABLE fund_receipts
  DROP CONSTRAINT IF EXISTS fund_receipts_disposition_check;
ALTER TABLE fund_receipts
  ADD CONSTRAINT fund_receipts_disposition_check CHECK (
    disposition IN (
      'received', 'allocated', 'partially_allocated', 'unclaimed', 'charged_back'
    )
  );

ALTER TABLE ledger_journals
  ADD COLUMN IF NOT EXISTS sealed_at timestamptz;

CREATE OR REPLACE FUNCTION opensales_reject_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'ledger_journals'
     AND TG_OP = 'UPDATE'
     AND OLD.sealed_at IS NULL
     AND NEW.sealed_at IS NOT NULL
     AND NEW.id = OLD.id
     AND NEW.source_type = OLD.source_type
     AND NEW.source_id = OLD.source_id
     AND NEW.currency = OLD.currency
     AND NEW.description = OLD.description
     AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ledger records are append-only; post a compensating journal';
END;
$$;

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
    receipt.disposition = 'charged_back'
    OR EXISTS (
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
    )
    OR EXISTS (
      SELECT 1
      FROM add_funds_chargeback_holds chargeback_hold
      JOIN add_funds_chargeback_facts chargeback_fact
        ON chargeback_fact.id = chargeback_hold.fact_id
      WHERE chargeback_fact.add_funds_attempt_id =
              receipt.reported_add_funds_attempt_id
        AND chargeback_fact.original_external_payment_id = receipt.external_payment_id
    ) AS present
) blocked ON true;

CREATE TABLE IF NOT EXISTS client_account_debt_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_account_id, currency)
);

CREATE TABLE IF NOT EXISTS client_account_debt_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  debt_account_id uuid NOT NULL REFERENCES client_account_debt_accounts(id),
  kind text NOT NULL CHECK (kind = 'chargeback'),
  debit_minor bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('staff', 'system', 'provider')),
  actor_id uuid,
  reason text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((debit_minor = 0) <> (credit_minor = 0)),
  UNIQUE (debt_account_id, idempotency_key),
  UNIQUE (kind, source_type, source_id)
);

CREATE TABLE IF NOT EXISTS client_account_restrictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  kind text NOT NULL CHECK (kind IN ('financial_chargeback')),
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, source_type, source_id)
);

CREATE TABLE IF NOT EXISTS client_account_restriction_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restriction_id uuid NOT NULL UNIQUE REFERENCES client_account_restrictions(id),
  released_by_staff_user_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_account_debt_transactions_account_idx
  ON client_account_debt_transactions (debt_account_id, created_at, id);
CREATE INDEX IF NOT EXISTS client_account_restrictions_account_idx
  ON client_account_restrictions (client_account_id, created_at, id);

CREATE OR REPLACE FUNCTION opensales_reject_chargeback_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Chargeback, debt, and restriction records are append-only';
END;
$$;

DROP TRIGGER IF EXISTS add_funds_chargeback_facts_append_only
  ON add_funds_chargeback_facts;
CREATE TRIGGER add_funds_chargeback_facts_append_only
BEFORE UPDATE OR DELETE ON add_funds_chargeback_facts
FOR EACH ROW EXECUTE FUNCTION opensales_reject_chargeback_mutation();

DROP TRIGGER IF EXISTS add_funds_chargeback_effects_append_only
  ON add_funds_chargeback_effects;
CREATE TRIGGER add_funds_chargeback_effects_append_only
BEFORE UPDATE OR DELETE ON add_funds_chargeback_effects
FOR EACH ROW EXECUTE FUNCTION opensales_reject_chargeback_mutation();

DROP TRIGGER IF EXISTS add_funds_chargeback_holds_append_only
  ON add_funds_chargeback_holds;
CREATE TRIGGER add_funds_chargeback_holds_append_only
BEFORE UPDATE OR DELETE ON add_funds_chargeback_holds
FOR EACH ROW EXECUTE FUNCTION opensales_reject_chargeback_mutation();

DROP TRIGGER IF EXISTS add_funds_chargeback_replays_append_only
  ON add_funds_chargeback_replay_dispositions;
CREATE TRIGGER add_funds_chargeback_replays_append_only
BEFORE UPDATE OR DELETE ON add_funds_chargeback_replay_dispositions
FOR EACH ROW EXECUTE FUNCTION opensales_reject_chargeback_mutation();

DROP TRIGGER IF EXISTS add_funds_unclaimed_chargeback_effects_append_only
  ON add_funds_unclaimed_chargeback_effects;
CREATE TRIGGER add_funds_unclaimed_chargeback_effects_append_only
BEFORE UPDATE OR DELETE ON add_funds_unclaimed_chargeback_effects
FOR EACH ROW EXECUTE FUNCTION opensales_reject_chargeback_mutation();

CREATE OR REPLACE FUNCTION opensales_guard_chargeback_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  has_allocated_effect boolean;
  has_unclaimed_effect boolean;
BEGIN
  SELECT
    EXISTS (
      SELECT 1 FROM add_funds_chargeback_effects effect
      WHERE effect.fund_receipt_id = OLD.id
    ),
    EXISTS (
      SELECT 1 FROM add_funds_unclaimed_chargeback_effects effect
      WHERE effect.fund_receipt_id = OLD.id
    )
  INTO has_allocated_effect, has_unclaimed_effect;

  IF has_unclaimed_effect
     AND OLD.disposition = 'unclaimed'
     AND NEW.disposition = 'charged_back'
     AND NEW.reason = 'Provider confirmed Chargeback of unclaimed Add Funds receipt'
     AND (to_jsonb(NEW) - ARRAY['disposition', 'reason', 'updated_at']) =
         (to_jsonb(OLD) - ARRAY['disposition', 'reason', 'updated_at']) THEN
    RETURN NEW;
  END IF;

  IF has_allocated_effect OR has_unclaimed_effect THEN
    RAISE EXCEPTION 'Chargeback source receipt cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chargeback_receipt_mutation_guard ON fund_receipts;
CREATE TRIGGER chargeback_receipt_mutation_guard
BEFORE UPDATE ON fund_receipts
FOR EACH ROW EXECUTE FUNCTION opensales_guard_chargeback_receipt_mutation();

CREATE OR REPLACE FUNCTION opensales_guard_chargeback_journal_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.source_type IN (
       'add_funds_chargeback_effect',
       'add_funds_unclaimed_chargeback_effect'
     )
     AND OLD.sealed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Sealed Chargeback journal is append-only';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chargeback_journal_mutation_guard ON ledger_journals;
CREATE TRIGGER chargeback_journal_mutation_guard
BEFORE UPDATE OR DELETE ON ledger_journals
FOR EACH ROW EXECUTE FUNCTION opensales_guard_chargeback_journal_mutation();

CREATE OR REPLACE FUNCTION opensales_guard_chargeback_ledger_line_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  protected_count integer;
BEGIN
  SELECT count(*)
  INTO protected_count
  FROM ledger_journals journal
  WHERE journal.id IN (
      CASE WHEN TG_OP = 'INSERT' THEN NEW.journal_id ELSE OLD.journal_id END,
      CASE WHEN TG_OP = 'DELETE' THEN OLD.journal_id ELSE NEW.journal_id END
    )
    AND journal.source_type IN (
      'add_funds_chargeback_effect',
      'add_funds_unclaimed_chargeback_effect'
    )
    AND journal.sealed_at IS NOT NULL;
  IF protected_count > 0 THEN
    RAISE EXCEPTION 'Sealed Chargeback journal lines cannot be changed';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS chargeback_ledger_line_mutation_guard ON ledger_lines;
CREATE TRIGGER chargeback_ledger_line_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON ledger_lines
FOR EACH ROW EXECUTE FUNCTION opensales_guard_chargeback_ledger_line_mutation();

DROP TRIGGER IF EXISTS client_account_debt_accounts_append_only
  ON client_account_debt_accounts;
CREATE TRIGGER client_account_debt_accounts_append_only
BEFORE UPDATE OR DELETE ON client_account_debt_accounts
FOR EACH ROW EXECUTE FUNCTION opensales_reject_chargeback_mutation();

DROP TRIGGER IF EXISTS client_account_debt_transactions_append_only
  ON client_account_debt_transactions;
CREATE TRIGGER client_account_debt_transactions_append_only
BEFORE UPDATE OR DELETE ON client_account_debt_transactions
FOR EACH ROW EXECUTE FUNCTION opensales_reject_chargeback_mutation();

DROP TRIGGER IF EXISTS client_account_restrictions_append_only
  ON client_account_restrictions;
CREATE TRIGGER client_account_restrictions_append_only
BEFORE UPDATE OR DELETE ON client_account_restrictions
FOR EACH ROW EXECUTE FUNCTION opensales_reject_chargeback_mutation();

DROP TRIGGER IF EXISTS client_account_restriction_releases_append_only
  ON client_account_restriction_releases;
CREATE TRIGGER client_account_restriction_releases_append_only
BEFORE UPDATE OR DELETE ON client_account_restriction_releases
FOR EACH ROW EXECUTE FUNCTION opensales_reject_chargeback_mutation();

CREATE OR REPLACE FUNCTION opensales_reject_unimplemented_restriction_release()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Chargeback restriction release is not implemented';
END;
$$;

DROP TRIGGER IF EXISTS client_account_restriction_release_insert_guard
  ON client_account_restriction_releases;
CREATE TRIGGER client_account_restriction_release_insert_guard
BEFORE INSERT ON client_account_restriction_releases
FOR EACH ROW EXECUTE FUNCTION opensales_reject_unimplemented_restriction_release();

CREATE OR REPLACE FUNCTION opensales_guard_active_account_restriction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.restricted_at IS DISTINCT FROM OLD.restricted_at
     AND EXISTS (
       SELECT 1
       FROM client_account_restrictions restriction
       LEFT JOIN client_account_restriction_releases release
         ON release.restriction_id = restriction.id
       WHERE restriction.client_account_id = OLD.id
         AND release.id IS NULL
     ) THEN
    RAISE EXCEPTION 'Active Chargeback restriction cannot be changed directly';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS client_accounts_active_restriction_guard ON client_accounts;
CREATE TRIGGER client_accounts_active_restriction_guard
BEFORE UPDATE OF restricted_at ON client_accounts
FOR EACH ROW EXECUTE FUNCTION opensales_guard_active_account_restriction();

CREATE OR REPLACE FUNCTION opensales_validate_chargeback_fact_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  operation_row record;
BEGIN
  SELECT provider_installation_id, subject_type, subject_id, kind, attempt_count
  INTO operation_row
  FROM provider_operations
  WHERE id = NEW.provider_operation_id
  FOR UPDATE;
  IF operation_row.provider_installation_id IS NULL
     OR NEW.provider_installation_id <> operation_row.provider_installation_id
     OR operation_row.subject_type <> 'add_funds'
     OR operation_row.subject_id <> NEW.add_funds_attempt_id
     OR operation_row.kind <> 'payment_create'
     OR operation_row.attempt_count <= 0 THEN
    RAISE EXCEPTION 'Chargeback fact is not bound to a started Add Funds operation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS add_funds_chargeback_fact_source_guard
  ON add_funds_chargeback_facts;
CREATE TRIGGER add_funds_chargeback_fact_source_guard
BEFORE INSERT ON add_funds_chargeback_facts
FOR EACH ROW EXECUTE FUNCTION opensales_validate_chargeback_fact_source();

CREATE OR REPLACE FUNCTION opensales_validate_chargeback_hold_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_account_id uuid;
BEGIN
  SELECT attempt.client_account_id
  INTO source_account_id
  FROM add_funds_chargeback_facts fact
  JOIN add_funds_attempts attempt ON attempt.id = fact.add_funds_attempt_id
  WHERE fact.id = NEW.fact_id;
  IF source_account_id IS NULL
     OR (NEW.client_account_id IS NOT NULL
         AND NEW.client_account_id <> source_account_id) THEN
    RAISE EXCEPTION 'Chargeback Hold Client Account does not match its fact';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS add_funds_chargeback_hold_source_guard
  ON add_funds_chargeback_holds;
CREATE TRIGGER add_funds_chargeback_hold_source_guard
BEFORE INSERT ON add_funds_chargeback_holds
FOR EACH ROW EXECUTE FUNCTION opensales_validate_chargeback_hold_source();

CREATE OR REPLACE FUNCTION opensales_hold_terminal_add_funds_chargebacks()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('failed', 'cancelled', 'expired') THEN
    WITH candidates AS (
      SELECT fact.id
      FROM add_funds_chargeback_facts fact
      LEFT JOIN add_funds_chargeback_effects effect ON effect.fact_id = fact.id
      LEFT JOIN add_funds_unclaimed_chargeback_effects unclaimed_effect
        ON unclaimed_effect.fact_id = fact.id
      LEFT JOIN add_funds_chargeback_holds hold_record ON hold_record.fact_id = fact.id
      LEFT JOIN add_funds_chargeback_replay_dispositions replay
        ON replay.fact_id = fact.id
      WHERE fact.add_funds_attempt_id = NEW.id
        AND effect.id IS NULL
        AND unclaimed_effect.id IS NULL
        AND hold_record.id IS NULL
        AND replay.id IS NULL
      ORDER BY fact.created_at, fact.id
      FOR UPDATE OF fact
    ), inserted AS (
      INSERT INTO add_funds_chargeback_holds(
        fact_id, client_account_id, reason
      )
      SELECT
        candidate.id,
        NEW.client_account_id,
        'Chargeback has no funds receipt after Add Funds became ' || NEW.status
      FROM candidates candidate
      RETURNING fact_id
    )
    INSERT INTO audit_events(
      actor_type, actor_id, action, target_type, target_id, reason, metadata
    )
    SELECT
      'system',
      'database-trigger',
      'add_funds.chargeback_held',
      'add_funds_chargeback_fact',
      inserted.fact_id::text,
      'Terminal Add Funds outcome left no receipt for the Chargeback fact',
      jsonb_build_object('addFundsAttemptId', NEW.id, 'attemptStatus', NEW.status)
    FROM inserted;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS add_funds_attempt_terminal_chargeback_hold
  ON add_funds_attempts;
CREATE TRIGGER add_funds_attempt_terminal_chargeback_hold
AFTER UPDATE OF status ON add_funds_attempts
FOR EACH ROW EXECUTE FUNCTION opensales_hold_terminal_add_funds_chargebacks();

CREATE OR REPLACE FUNCTION opensales_hold_manual_add_funds_chargebacks()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account_id uuid;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'manual' THEN
    SELECT client_account_id
    INTO account_id
    FROM add_funds_attempts
    WHERE id = NEW.add_funds_attempt_id
    FOR UPDATE;

    WITH candidates AS (
      SELECT fact.id
      FROM add_funds_chargeback_facts fact
      LEFT JOIN add_funds_chargeback_effects effect ON effect.fact_id = fact.id
      LEFT JOIN add_funds_unclaimed_chargeback_effects unclaimed_effect
        ON unclaimed_effect.fact_id = fact.id
      LEFT JOIN add_funds_chargeback_holds hold_record ON hold_record.fact_id = fact.id
      LEFT JOIN add_funds_chargeback_replay_dispositions replay
        ON replay.fact_id = fact.id
      WHERE fact.add_funds_attempt_id = NEW.add_funds_attempt_id
        AND NOT EXISTS (
          SELECT 1
          FROM fund_receipts receipt
          WHERE receipt.reported_add_funds_attempt_id = NEW.add_funds_attempt_id
        )
        AND effect.id IS NULL
        AND unclaimed_effect.id IS NULL
        AND hold_record.id IS NULL
        AND replay.id IS NULL
      ORDER BY fact.created_at, fact.id
      FOR UPDATE OF fact
    ), inserted AS (
      INSERT INTO add_funds_chargeback_holds(
        fact_id, client_account_id, reason
      )
      SELECT
        candidate.id,
        account_id,
        'Chargeback requires review after Add Funds reconciliation became manual'
      FROM candidates candidate
      RETURNING fact_id
    )
    INSERT INTO audit_events(
      actor_type, actor_id, action, target_type, target_id, reason, metadata
    )
    SELECT
      'system',
      'database-trigger',
      'add_funds.chargeback_held',
      'add_funds_chargeback_fact',
      inserted.fact_id::text,
      'Add Funds reconciliation exhausted automated attempts',
      jsonb_build_object('addFundsAttemptId', NEW.add_funds_attempt_id)
    FROM inserted;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS add_funds_command_manual_chargeback_hold
  ON add_funds_commands;
CREATE TRIGGER add_funds_command_manual_chargeback_hold
AFTER UPDATE OF status ON add_funds_commands
FOR EACH ROW EXECUTE FUNCTION opensales_hold_manual_add_funds_chargebacks();

CREATE OR REPLACE FUNCTION opensales_guard_chargeback_fact_disposition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  disposition_count integer;
BEGIN
  PERFORM 1 FROM add_funds_chargeback_facts WHERE id = NEW.fact_id FOR UPDATE;
  SELECT
    (SELECT count(*) FROM add_funds_chargeback_effects WHERE fact_id = NEW.fact_id)
    + (SELECT count(*) FROM add_funds_unclaimed_chargeback_effects
       WHERE fact_id = NEW.fact_id)
    + (SELECT count(*) FROM add_funds_chargeback_holds WHERE fact_id = NEW.fact_id)
    + (SELECT count(*) FROM add_funds_chargeback_replay_dispositions
       WHERE fact_id = NEW.fact_id)
  INTO disposition_count;
  IF disposition_count <> 0 THEN
    RAISE EXCEPTION 'Chargeback fact already has a disposition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS add_funds_chargeback_effect_disposition_guard
  ON add_funds_chargeback_effects;
CREATE TRIGGER add_funds_chargeback_effect_disposition_guard
BEFORE INSERT ON add_funds_chargeback_effects
FOR EACH ROW EXECUTE FUNCTION opensales_guard_chargeback_fact_disposition();

DROP TRIGGER IF EXISTS add_funds_unclaimed_chargeback_effect_disposition_guard
  ON add_funds_unclaimed_chargeback_effects;
CREATE TRIGGER add_funds_unclaimed_chargeback_effect_disposition_guard
BEFORE INSERT ON add_funds_unclaimed_chargeback_effects
FOR EACH ROW EXECUTE FUNCTION opensales_guard_chargeback_fact_disposition();

DROP TRIGGER IF EXISTS add_funds_chargeback_hold_disposition_guard
  ON add_funds_chargeback_holds;
CREATE TRIGGER add_funds_chargeback_hold_disposition_guard
BEFORE INSERT ON add_funds_chargeback_holds
FOR EACH ROW EXECUTE FUNCTION opensales_guard_chargeback_fact_disposition();

DROP TRIGGER IF EXISTS add_funds_chargeback_replay_disposition_guard
  ON add_funds_chargeback_replay_dispositions;
CREATE TRIGGER add_funds_chargeback_replay_disposition_guard
BEFORE INSERT ON add_funds_chargeback_replay_dispositions
FOR EACH ROW EXECUTE FUNCTION opensales_guard_chargeback_fact_disposition();

CREATE OR REPLACE FUNCTION opensales_validate_chargeback_replay()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  replay_row record;
BEGIN
  SELECT
    fact.provider_installation_id AS fact_provider,
    fact.provider_operation_id AS fact_operation,
    fact.add_funds_attempt_id AS fact_attempt,
    fact.external_event_id AS fact_event,
    fact.original_external_payment_id AS fact_payment,
    fact.external_chargeback_id AS fact_chargeback,
    fact.status AS fact_status,
    fact.amount_minor AS fact_amount,
    fact.currency AS fact_currency,
    fact.occurred_at AS fact_occurred,
    canonical.provider_installation_id AS canonical_provider,
    canonical.provider_operation_id AS canonical_operation,
    canonical.add_funds_attempt_id AS canonical_attempt,
    canonical.external_event_id AS canonical_event,
    COALESCE(effect.original_external_payment_id,
             unclaimed_effect.original_external_payment_id) AS canonical_payment,
    COALESCE(effect.external_chargeback_id,
             unclaimed_effect.external_chargeback_id) AS canonical_chargeback,
    COALESCE(effect.external_amount_minor,
             unclaimed_effect.external_amount_minor) AS canonical_amount,
    COALESCE(effect.currency, unclaimed_effect.currency) AS canonical_currency,
    COALESCE(effect.occurred_at,
             unclaimed_effect.occurred_at) AS canonical_occurred
  INTO replay_row
  FROM add_funds_chargeback_facts fact
  LEFT JOIN add_funds_chargeback_effects effect
    ON effect.id = NEW.canonical_effect_id
  LEFT JOIN add_funds_unclaimed_chargeback_effects unclaimed_effect
    ON unclaimed_effect.id = NEW.canonical_unclaimed_effect_id
  JOIN add_funds_chargeback_facts canonical
    ON canonical.id = COALESCE(effect.fact_id, unclaimed_effect.fact_id)
  WHERE fact.id = NEW.fact_id;

  IF replay_row.fact_provider IS NULL
     OR replay_row.fact_provider <> replay_row.canonical_provider
     OR replay_row.fact_operation <> replay_row.canonical_operation
     OR replay_row.fact_attempt <> replay_row.canonical_attempt
     OR replay_row.fact_event = replay_row.canonical_event
     OR replay_row.fact_payment <> replay_row.canonical_payment
     OR replay_row.fact_chargeback <> replay_row.canonical_chargeback
     OR replay_row.fact_status <> 'succeeded'
     OR replay_row.fact_amount <> replay_row.canonical_amount
     OR replay_row.fact_currency <> replay_row.canonical_currency
     OR replay_row.fact_occurred <> replay_row.canonical_occurred THEN
    RAISE EXCEPTION 'Chargeback replay does not exactly match its canonical effect';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS add_funds_chargeback_replay_source_guard
  ON add_funds_chargeback_replay_dispositions;
CREATE TRIGGER add_funds_chargeback_replay_source_guard
BEFORE INSERT ON add_funds_chargeback_replay_dispositions
FOR EACH ROW EXECUTE FUNCTION opensales_validate_chargeback_replay();

CREATE OR REPLACE FUNCTION opensales_validate_unclaimed_chargeback_effect()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_row record;
BEGIN
  PERFORM 1
  FROM fund_receipts
  WHERE id = NEW.fund_receipt_id
  FOR UPDATE;
  SELECT
    fact.provider_installation_id,
    fact.provider_operation_id,
    fact.add_funds_attempt_id,
    fact.original_external_payment_id,
    fact.external_chargeback_id,
    fact.amount_minor,
    fact.currency,
    fact.occurred_at,
    fact.created_at AS fact_created_at,
    receipt.id AS receipt_id,
    receipt.external_payment_id,
    receipt.reported_add_funds_attempt_id,
    receipt.client_account_id,
    receipt.amount_minor AS receipt_amount_minor,
    receipt.currency AS receipt_currency,
    receipt.occurred_at AS receipt_occurred_at,
    receipt.disposition,
    settlement.id AS settlement_id,
    capacity.allocated_minor,
    capacity.reserved_refund_minor,
    capacity.confirmed_outflow_minor,
    capacity.capacity_frozen,
    capacity.available_minor,
    operation.provider_installation_id AS operation_provider,
    operation.created_at AS operation_created_at,
    operation.subject_type,
    operation.subject_id,
    operation.kind AS operation_kind
  INTO source_row
  FROM add_funds_chargeback_facts fact
  JOIN provider_operations operation ON operation.id = fact.provider_operation_id
  JOIN fund_receipts receipt
    ON receipt.reported_add_funds_attempt_id = fact.add_funds_attempt_id
   AND receipt.external_payment_id = fact.original_external_payment_id
  LEFT JOIN add_funds_settlements settlement
    ON settlement.fund_receipt_id = receipt.id
  JOIN unclaimed_fund_refund_capacity capacity
    ON capacity.fund_receipt_id = receipt.id
  WHERE fact.id = NEW.fact_id
    AND receipt.id = NEW.fund_receipt_id;

  IF source_row.receipt_id IS NULL
     OR NEW.client_account_id <> source_row.client_account_id
     OR NEW.provider_installation_id <> source_row.provider_installation_id
     OR NEW.provider_installation_id <> source_row.operation_provider
     OR NEW.original_external_payment_id <> source_row.original_external_payment_id
     OR NEW.original_external_payment_id <> source_row.external_payment_id
     OR NEW.external_chargeback_id <> source_row.external_chargeback_id
     OR NEW.external_amount_minor <> source_row.amount_minor
     OR NEW.external_amount_minor <> source_row.receipt_amount_minor
     OR NEW.currency <> source_row.currency
     OR NEW.currency <> source_row.receipt_currency
     OR NEW.occurred_at <> source_row.occurred_at
     OR source_row.occurred_at < source_row.receipt_occurred_at
     OR source_row.occurred_at < source_row.operation_created_at - interval '1 minute'
     OR source_row.occurred_at > now() + interval '5 minutes'
     OR source_row.disposition <> 'unclaimed'
     OR source_row.settlement_id IS NOT NULL
     OR source_row.allocated_minor <> 0
     OR source_row.reserved_refund_minor <> 0
     OR source_row.confirmed_outflow_minor <> 0
     OR source_row.capacity_frozen
     OR source_row.available_minor <> source_row.receipt_amount_minor
     OR EXISTS (
       SELECT 1
       FROM add_funds_chargeback_facts prior
       LEFT JOIN add_funds_chargeback_holds hold_record
         ON hold_record.fact_id = prior.id
       WHERE prior.provider_installation_id = source_row.provider_installation_id
         AND prior.id <> NEW.fact_id
         AND (
           (
             prior.external_chargeback_id = source_row.external_chargeback_id
             AND (prior.created_at, prior.id) <
                 (source_row.fact_created_at, NEW.fact_id)
           )
           OR (
             hold_record.id IS NOT NULL
             AND prior.provider_operation_id = source_row.provider_operation_id
             AND prior.add_funds_attempt_id = source_row.add_funds_attempt_id
             AND prior.original_external_payment_id =
                 source_row.original_external_payment_id
           )
         )
     )
     OR source_row.subject_type <> 'add_funds'
     OR source_row.subject_id <> source_row.add_funds_attempt_id
     OR source_row.operation_kind <> 'payment_create' THEN
    RAISE EXCEPTION 'Unclaimed Chargeback effect does not match its immutable source';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS add_funds_unclaimed_chargeback_effect_source_guard
  ON add_funds_unclaimed_chargeback_effects;
CREATE TRIGGER add_funds_unclaimed_chargeback_effect_source_guard
BEFORE INSERT ON add_funds_unclaimed_chargeback_effects
FOR EACH ROW EXECUTE FUNCTION opensales_validate_unclaimed_chargeback_effect();

CREATE OR REPLACE FUNCTION opensales_guard_debt_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_minor bigint;
BEGIN
  PERFORM 1
  FROM client_account_debt_accounts
  WHERE id = NEW.debt_account_id
  FOR UPDATE;

  SELECT COALESCE(sum(debit_minor - credit_minor), 0)
  INTO current_minor
  FROM client_account_debt_transactions
  WHERE debt_account_id = NEW.debt_account_id;

  IF current_minor + NEW.debit_minor - NEW.credit_minor < 0 THEN
    RAISE EXCEPTION 'Client Account debt cannot become negative';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS client_account_debt_balance_guard
  ON client_account_debt_transactions;
CREATE TRIGGER client_account_debt_balance_guard
BEFORE INSERT ON client_account_debt_transactions
FOR EACH ROW EXECUTE FUNCTION opensales_guard_debt_balance();

CREATE OR REPLACE FUNCTION opensales_validate_chargeback_effect()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source record;
  available_credit bigint;
BEGIN
  PERFORM 1
  FROM fund_receipts
  WHERE id = NEW.fund_receipt_id
  FOR UPDATE;
  SELECT
    fact.id AS fact_id,
    fact.provider_installation_id,
    fact.provider_operation_id,
    fact.add_funds_attempt_id,
    fact.original_external_payment_id,
    fact.external_chargeback_id,
    fact.amount_minor,
    fact.currency,
    fact.occurred_at,
    fact.created_at AS fact_created_at,
    settlement.id AS settlement_id,
    settlement.fund_receipt_id,
    settlement.principal_minor,
    settlement.fee_minor,
    settlement.currency AS settlement_currency,
    attempt.client_account_id,
    attempt.external_payment_id,
    operation.id AS operation_id,
    operation.provider_installation_id AS operation_provider_installation_id,
    operation.subject_type,
    operation.subject_id,
    operation.kind AS operation_kind,
    operation.attempt_count,
    receipt.occurred_at AS receipt_occurred_at,
    receipt.disposition AS receipt_disposition,
    account.id AS credit_account_id
  INTO source
  FROM add_funds_chargeback_facts fact
  JOIN add_funds_settlements settlement
    ON settlement.add_funds_attempt_id = fact.add_funds_attempt_id
  JOIN add_funds_attempts attempt ON attempt.id = settlement.add_funds_attempt_id
  JOIN provider_operations operation ON operation.id = fact.provider_operation_id
  JOIN fund_receipts receipt ON receipt.id = settlement.fund_receipt_id
  JOIN credit_accounts account
    ON account.client_account_id = attempt.client_account_id
   AND account.currency = settlement.currency
  WHERE fact.id = NEW.fact_id;

  PERFORM 1
  FROM credit_accounts
  WHERE id = NEW.credit_account_id
  FOR UPDATE;
  SELECT COALESCE(sum(credit_minor - debit_minor), 0)
  INTO available_credit
  FROM credit_transactions
  WHERE credit_account_id = NEW.credit_account_id;

  IF source.fact_id IS NULL
     OR NEW.add_funds_settlement_id <> source.settlement_id
     OR NEW.fund_receipt_id <> source.fund_receipt_id
     OR NEW.client_account_id <> source.client_account_id
     OR NEW.credit_account_id <> source.credit_account_id
     OR NEW.provider_installation_id <> source.provider_installation_id
     OR NEW.provider_installation_id <> source.operation_provider_installation_id
     OR NEW.original_external_payment_id <> source.original_external_payment_id
     OR NEW.original_external_payment_id <> source.external_payment_id
     OR NEW.external_chargeback_id <> source.external_chargeback_id
     OR NEW.principal_minor <> source.principal_minor
     OR NEW.fee_minor <> source.fee_minor
     OR NEW.external_amount_minor <> source.amount_minor
     OR NEW.external_amount_minor <> source.principal_minor + source.fee_minor
     OR NEW.currency <> source.currency
     OR NEW.currency <> source.settlement_currency
     OR NEW.occurred_at <> source.occurred_at
     OR NEW.credit_recovered_minor <> LEAST(available_credit, NEW.principal_minor)
     OR NEW.debt_minor <> NEW.principal_minor - LEAST(available_credit, NEW.principal_minor)
     OR EXISTS (
       SELECT 1
       FROM add_funds_chargeback_facts prior
       LEFT JOIN add_funds_chargeback_holds hold_record
         ON hold_record.fact_id = prior.id
       WHERE prior.provider_installation_id = source.provider_installation_id
         AND prior.id <> NEW.fact_id
         AND (
           (
             prior.external_chargeback_id = source.external_chargeback_id
             AND (prior.created_at, prior.id) < (source.fact_created_at, NEW.fact_id)
           )
           OR (
             hold_record.id IS NOT NULL
             AND prior.provider_operation_id = source.provider_operation_id
             AND prior.add_funds_attempt_id = source.add_funds_attempt_id
             AND prior.original_external_payment_id = source.original_external_payment_id
           )
         )
     )
     OR source.operation_id <> source.provider_operation_id
     OR source.subject_type <> 'add_funds'
     OR source.subject_id <> source.add_funds_attempt_id
     OR source.operation_kind <> 'payment_create'
     OR source.attempt_count <= 0
     OR source.receipt_disposition <> 'allocated'
     OR source.occurred_at < source.receipt_occurred_at
     OR source.occurred_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Chargeback effect does not match its immutable Add Funds source';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS add_funds_chargeback_effect_source_guard
  ON add_funds_chargeback_effects;
CREATE TRIGGER add_funds_chargeback_effect_source_guard
BEFORE INSERT ON add_funds_chargeback_effects
FOR EACH ROW EXECUTE FUNCTION opensales_validate_chargeback_effect();

CREATE OR REPLACE FUNCTION opensales_validate_chargeback_credit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  effect_row record;
BEGIN
  IF NEW.kind <> 'chargeback' THEN
    RETURN NEW;
  END IF;
  SELECT credit_account_id, credit_recovered_minor
  INTO effect_row
  FROM add_funds_chargeback_effects
  WHERE id = NEW.source_id;

  IF NEW.source_type <> 'add_funds_chargeback_effect'
     OR effect_row.credit_account_id IS NULL
     OR NEW.credit_account_id <> effect_row.credit_account_id
     OR NEW.credit_minor <> 0
     OR NEW.debit_minor <> effect_row.credit_recovered_minor
     OR NEW.debit_minor <= 0 THEN
    RAISE EXCEPTION 'Chargeback Credit debit does not match its immutable effect';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chargeback_credit_source_guard ON credit_transactions;
CREATE TRIGGER chargeback_credit_source_guard
BEFORE INSERT ON credit_transactions
FOR EACH ROW EXECUTE FUNCTION opensales_validate_chargeback_credit();

CREATE OR REPLACE FUNCTION opensales_validate_chargeback_debt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  effect_row record;
BEGIN
  IF NEW.kind <> 'chargeback' THEN
    RETURN NEW;
  END IF;
  SELECT chargeback_effect.client_account_id,
         chargeback_effect.currency,
         chargeback_effect.debt_minor,
         account.client_account_id AS debt_client_account_id,
         account.currency AS debt_currency
  INTO effect_row
  FROM add_funds_chargeback_effects chargeback_effect
  JOIN client_account_debt_accounts account ON account.id = NEW.debt_account_id
  WHERE chargeback_effect.id = NEW.source_id;

  IF NEW.source_type <> 'add_funds_chargeback_effect'
     OR effect_row.client_account_id IS NULL
     OR effect_row.client_account_id <> effect_row.debt_client_account_id
     OR effect_row.currency <> effect_row.debt_currency
     OR NEW.credit_minor <> 0
     OR NEW.debit_minor <> effect_row.debt_minor
     OR NEW.debit_minor <= 0 THEN
    RAISE EXCEPTION 'Chargeback debt does not match its immutable effect';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chargeback_debt_source_guard
  ON client_account_debt_transactions;
CREATE TRIGGER chargeback_debt_source_guard
BEFORE INSERT ON client_account_debt_transactions
FOR EACH ROW EXECUTE FUNCTION opensales_validate_chargeback_debt();

CREATE OR REPLACE FUNCTION opensales_apply_chargeback_restriction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  effect_row record;
BEGIN
  SELECT client_account_id, debt_minor
  INTO effect_row
  FROM add_funds_chargeback_effects
  WHERE id = NEW.source_id;

  IF NEW.kind <> 'financial_chargeback'
     OR NEW.source_type <> 'add_funds_chargeback_effect'
     OR effect_row.client_account_id IS NULL
     OR effect_row.debt_minor <= 0
     OR NEW.client_account_id <> effect_row.client_account_id THEN
    RAISE EXCEPTION 'Client Account restriction does not match Chargeback debt';
  END IF;

  UPDATE client_accounts
  SET restricted_at = COALESCE(restricted_at, NEW.created_at)
  WHERE id = NEW.client_account_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chargeback_restriction_source_guard
  ON client_account_restrictions;
CREATE TRIGGER chargeback_restriction_source_guard
BEFORE INSERT ON client_account_restrictions
FOR EACH ROW EXECUTE FUNCTION opensales_apply_chargeback_restriction();

CREATE OR REPLACE FUNCTION opensales_invalidate_client_account_reauth()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.restricted_at IS DISTINCT FROM OLD.restricted_at THEN
    UPDATE reauth_grants grant_record
    SET invalidated_at = now()
    FROM client_memberships membership
    WHERE membership.client_account_id = NEW.id
      AND grant_record.user_id = membership.user_id
      AND grant_record.invalidated_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS client_accounts_invalidate_reauth ON client_accounts;
CREATE TRIGGER client_accounts_invalidate_reauth
AFTER UPDATE OF restricted_at ON client_accounts
FOR EACH ROW EXECUTE FUNCTION opensales_invalidate_client_account_reauth();

CREATE OR REPLACE FUNCTION opensales_assert_chargeback_effect_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  credit_count integer;
  debt_count integer;
  restriction_count integer;
  journal_count integer;
  liability_debit bigint;
  receivable_debit bigint;
  fee_debit bigint;
  cash_credit bigint;
  line_count integer;
  journal_currency text;
  journal_sealed boolean;
BEGIN
  SELECT count(*)
  INTO credit_count
  FROM credit_transactions
  WHERE kind = 'chargeback'
    AND source_type = 'add_funds_chargeback_effect'
    AND source_id = NEW.id;

  SELECT count(*)
  INTO debt_count
  FROM client_account_debt_transactions
  WHERE kind = 'chargeback'
    AND source_type = 'add_funds_chargeback_effect'
    AND source_id = NEW.id;

  SELECT count(*)
  INTO restriction_count
  FROM client_account_restrictions
  WHERE kind = 'financial_chargeback'
    AND source_type = 'add_funds_chargeback_effect'
    AND source_id = NEW.id;

  SELECT
    count(DISTINCT journal.id),
    COALESCE(sum(line.debit_minor) FILTER (
      WHERE line.account_code = 'client_credit_liability'
    ), 0),
    COALESCE(sum(line.debit_minor) FILTER (
      WHERE line.account_code = 'chargeback_receivable'
    ), 0),
    COALESCE(sum(line.debit_minor) FILTER (
      WHERE line.account_code = 'payment_fee_revenue'
    ), 0),
    COALESCE(sum(line.credit_minor) FILTER (
      WHERE line.account_code = 'mock_cash'
    ), 0),
    count(line.id),
    min(journal.currency),
    bool_and(journal.sealed_at IS NOT NULL)
  INTO journal_count, liability_debit, receivable_debit, fee_debit,
       cash_credit, line_count, journal_currency, journal_sealed
  FROM ledger_journals journal
  LEFT JOIN ledger_lines line ON line.journal_id = journal.id
  WHERE journal.source_type = 'add_funds_chargeback_effect'
    AND journal.source_id = NEW.id;

  IF credit_count <> (CASE WHEN NEW.credit_recovered_minor > 0 THEN 1 ELSE 0 END)
     OR debt_count <> (CASE WHEN NEW.debt_minor > 0 THEN 1 ELSE 0 END)
     OR restriction_count <> (CASE WHEN NEW.debt_minor > 0 THEN 1 ELSE 0 END)
     OR journal_count <> 1
     OR liability_debit <> NEW.credit_recovered_minor
     OR receivable_debit <> NEW.debt_minor
     OR fee_debit <> NEW.fee_minor
     OR cash_credit <> NEW.external_amount_minor
     OR journal_currency <> NEW.currency
     OR journal_sealed IS NOT TRUE
     OR line_count <>
       1
       + (CASE WHEN NEW.credit_recovered_minor > 0 THEN 1 ELSE 0 END)
       + (CASE WHEN NEW.debt_minor > 0 THEN 1 ELSE 0 END)
       + (CASE WHEN NEW.fee_minor > 0 THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'Chargeback effect is incomplete or its subledgers are inconsistent';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS add_funds_chargeback_effect_completeness_guard
  ON add_funds_chargeback_effects;
CREATE CONSTRAINT TRIGGER add_funds_chargeback_effect_completeness_guard
AFTER INSERT ON add_funds_chargeback_effects
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opensales_assert_chargeback_effect_complete();

CREATE OR REPLACE FUNCTION opensales_assert_unclaimed_chargeback_effect_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  journal_count integer;
  liability_debit bigint;
  cash_credit bigint;
  line_count integer;
  journal_currency text;
  journal_sealed boolean;
  receipt_disposition text;
BEGIN
  SELECT disposition
  INTO receipt_disposition
  FROM fund_receipts
  WHERE id = NEW.fund_receipt_id;

  SELECT
    count(DISTINCT journal.id),
    COALESCE(sum(line.debit_minor) FILTER (
      WHERE line.account_code = 'unclaimed_funds_liability'
    ), 0),
    COALESCE(sum(line.credit_minor) FILTER (
      WHERE line.account_code = 'mock_cash'
    ), 0),
    count(line.id),
    min(journal.currency),
    bool_and(journal.sealed_at IS NOT NULL)
  INTO journal_count, liability_debit, cash_credit, line_count, journal_currency,
       journal_sealed
  FROM ledger_journals journal
  LEFT JOIN ledger_lines line ON line.journal_id = journal.id
  WHERE journal.source_type = 'add_funds_unclaimed_chargeback_effect'
    AND journal.source_id = NEW.id;

  IF receipt_disposition <> 'charged_back'
     OR journal_count <> 1
     OR liability_debit <> NEW.external_amount_minor
     OR cash_credit <> NEW.external_amount_minor
     OR line_count <> 2
     OR journal_currency <> NEW.currency
     OR journal_sealed IS NOT TRUE THEN
    RAISE EXCEPTION 'Unclaimed Chargeback effect is incomplete or inconsistent';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS add_funds_unclaimed_chargeback_effect_completeness_guard
  ON add_funds_unclaimed_chargeback_effects;
CREATE CONSTRAINT TRIGGER add_funds_unclaimed_chargeback_effect_completeness_guard
AFTER INSERT ON add_funds_unclaimed_chargeback_effects
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opensales_assert_unclaimed_chargeback_effect_complete();

CREATE OR REPLACE FUNCTION opensales_assert_chargeback_fact_disposed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  missing_fact uuid;
BEGIN
  SELECT fact.id
  INTO missing_fact
  FROM add_funds_chargeback_facts fact
  JOIN add_funds_attempts attempt ON attempt.id = fact.add_funds_attempt_id
  JOIN add_funds_commands command ON command.add_funds_attempt_id = attempt.id
  WHERE (
      EXISTS (
        SELECT 1 FROM add_funds_settlements settlement
        WHERE settlement.add_funds_attempt_id = fact.add_funds_attempt_id
      )
      OR EXISTS (
        SELECT 1 FROM fund_receipts receipt
        WHERE receipt.reported_add_funds_attempt_id = fact.add_funds_attempt_id
      )
      OR attempt.status IN ('failed', 'cancelled', 'expired')
      OR command.status = 'manual'
    )
    AND (
      (SELECT count(*) FROM add_funds_chargeback_effects effect
       WHERE effect.fact_id = fact.id)
      + (SELECT count(*) FROM add_funds_unclaimed_chargeback_effects effect
         WHERE effect.fact_id = fact.id)
      + (SELECT count(*) FROM add_funds_chargeback_holds hold_record
         WHERE hold_record.fact_id = fact.id)
      + (SELECT count(*) FROM add_funds_chargeback_replay_dispositions replay
         WHERE replay.fact_id = fact.id)
    ) <> 1
  LIMIT 1;

  IF missing_fact IS NOT NULL THEN
    RAISE EXCEPTION 'Source-backed Chargeback fact % lacks exactly one disposition',
      missing_fact;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS add_funds_chargeback_fact_disposition_completeness
  ON add_funds_chargeback_facts;
CREATE CONSTRAINT TRIGGER add_funds_chargeback_fact_disposition_completeness
AFTER INSERT ON add_funds_chargeback_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opensales_assert_chargeback_fact_disposed();

DROP TRIGGER IF EXISTS add_funds_settlement_chargeback_disposition_completeness
  ON add_funds_settlements;
CREATE CONSTRAINT TRIGGER add_funds_settlement_chargeback_disposition_completeness
AFTER INSERT ON add_funds_settlements
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opensales_assert_chargeback_fact_disposed();

DROP TRIGGER IF EXISTS fund_receipt_chargeback_disposition_completeness
  ON fund_receipts;
CREATE CONSTRAINT TRIGGER fund_receipt_chargeback_disposition_completeness
AFTER INSERT OR UPDATE ON fund_receipts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opensales_assert_chargeback_fact_disposed();

DROP TRIGGER IF EXISTS add_funds_attempt_chargeback_disposition_completeness
  ON add_funds_attempts;
CREATE CONSTRAINT TRIGGER add_funds_attempt_chargeback_disposition_completeness
AFTER UPDATE ON add_funds_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opensales_assert_chargeback_fact_disposed();

DROP TRIGGER IF EXISTS add_funds_command_chargeback_disposition_completeness
  ON add_funds_commands;
CREATE CONSTRAINT TRIGGER add_funds_command_chargeback_disposition_completeness
AFTER UPDATE ON add_funds_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opensales_assert_chargeback_fact_disposed();
