-- SPDX-License-Identifier: AGPL-3.0-or-later

CREATE TABLE IF NOT EXISTS billing_automation_policies (
  id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  run_local_time time NOT NULL DEFAULT '09:00',
  renewal_lead_days integer NOT NULL DEFAULT 14 CHECK (renewal_lead_days BETWEEN 1 AND 90),
  pre_due_reminder_days integer NOT NULL DEFAULT 7 CHECK (pre_due_reminder_days BETWEEN 0 AND 90),
  overdue_reminder_days integer NOT NULL DEFAULT 1 CHECK (overdue_reminder_days BETWEEN 0 AND 90),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO billing_automation_policies(
  id, enabled, timezone, run_local_time,
  renewal_lead_days, pre_due_reminder_days, overdue_reminder_days
) VALUES ('default', true, 'Asia/Shanghai', '09:00', 14, 7, 1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE invoice_payment_commands
  ADD COLUMN IF NOT EXISTS initiator_type text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS initiated_by_user_id uuid REFERENCES users(id);
UPDATE invoice_payment_commands command
SET initiated_by_user_id = original_order.submitted_by_user_id
FROM invoices invoice
JOIN orders original_order ON original_order.id = invoice.order_id
WHERE command.invoice_id = invoice.id
  AND command.initiated_by_user_id IS NULL;
UPDATE invoice_payment_commands
SET initiator_type = 'system'
WHERE initiated_by_user_id IS NULL;
ALTER TABLE invoice_payment_commands
  DROP CONSTRAINT IF EXISTS invoice_payment_commands_initiator_check;
ALTER TABLE invoice_payment_commands
  ADD CONSTRAINT invoice_payment_commands_initiator_check CHECK (
    (initiator_type = 'user' AND initiated_by_user_id IS NOT NULL)
    OR (initiator_type = 'system' AND initiated_by_user_id IS NULL)
  );

CREATE OR REPLACE FUNCTION opensales_guard_payment_command_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.client_account_id IS DISTINCT FROM OLD.client_account_id
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.quote_id IS DISTINCT FROM OLD.quote_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
     OR NEW.initiator_type IS DISTINCT FROM OLD.initiator_type
     OR NEW.initiated_by_user_id IS DISTINCT FROM OLD.initiated_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'payment command identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoice_payment_commands_identity_immutable ON invoice_payment_commands;
CREATE TRIGGER invoice_payment_commands_identity_immutable
BEFORE UPDATE ON invoice_payment_commands
FOR EACH ROW EXECUTE FUNCTION opensales_guard_payment_command_identity();

CREATE TABLE IF NOT EXISTS billing_automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id text NOT NULL REFERENCES billing_automation_policies(id),
  business_date date NOT NULL,
  effective_at timestamptz NOT NULL,
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  invoices_created integer NOT NULL DEFAULT 0 CHECK (invoices_created >= 0),
  reminders_created integer NOT NULL DEFAULT 0 CHECK (reminders_created >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_id, business_date)
);

CREATE TABLE IF NOT EXISTS billing_automation_run_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint text NOT NULL,
  run_id uuid NOT NULL REFERENCES billing_automation_runs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requested_by_user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS service_renewals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES services(id),
  invoice_id uuid NOT NULL UNIQUE REFERENCES invoices(id),
  automation_run_id uuid NOT NULL REFERENCES billing_automation_runs(id),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  recurring_minor bigint NOT NULL CHECK (recurring_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'invoiced' CHECK (status IN ('invoiced', 'paid', 'manual_hold')),
  funded_at timestamptz,
  settled_at timestamptz,
  creation_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CHECK (period_end > period_start),
  CHECK ((status = 'invoiced') = (funded_at IS NULL)),
  CHECK ((status = 'paid') = (settled_at IS NOT NULL)),
  UNIQUE (service_id, period_start)
);

CREATE TABLE IF NOT EXISTS service_renewal_hold_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  renewal_id uuid NOT NULL REFERENCES service_renewals(id),
  staff_user_id uuid NOT NULL REFERENCES staff_members(user_id),
  action text NOT NULL CHECK (action = 'grant_period'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  expected_version integer NOT NULL CHECK (expected_version > 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_user_id, idempotency_key)
);

DROP TRIGGER IF EXISTS service_renewal_hold_resolutions_append_only
  ON service_renewal_hold_resolutions;
CREATE TRIGGER service_renewal_hold_resolutions_append_only
BEFORE UPDATE OR DELETE ON service_renewal_hold_resolutions
FOR EACH ROW EXECUTE FUNCTION opensales_reject_credit_mutation();

CREATE OR REPLACE FUNCTION opensales_validate_service_renewal_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  service_row record;
  invoice_row record;
  expected_period_end timestamptz;
BEGIN
  -- The transaction marker is assigned by the database, not trusted from the
  -- caller. Renewal Credit may only be auto-applied in this same transaction.
  NEW.creation_transaction_id := txid_current();

  SELECT client_account_id, term_end, billing_cycle
  INTO service_row
  FROM services
  WHERE id = NEW.service_id
  FOR UPDATE;
  IF service_row IS NULL THEN
    RAISE EXCEPTION 'renewal references an unavailable service';
  END IF;

  SELECT client_account_id, currency, total_minor, order_id
  INTO invoice_row
  FROM invoices
  WHERE id = NEW.invoice_id;
  IF invoice_row IS NULL
     OR invoice_row.order_id IS NOT NULL
     OR invoice_row.client_account_id <> service_row.client_account_id
     OR invoice_row.currency <> NEW.currency
     OR invoice_row.total_minor <> NEW.recurring_minor
     OR service_row.term_end IS NULL
     OR NEW.period_start <> service_row.term_end THEN
    RAISE EXCEPTION 'renewal invoice, ownership, amount, currency, or period is inconsistent';
  END IF;

  expected_period_end := (
    (service_row.term_end AT TIME ZONE 'UTC')
    + CASE service_row.billing_cycle
        WHEN 'monthly' THEN interval '1 month'
        WHEN 'quarterly' THEN interval '3 months'
        WHEN 'semiannual' THEN interval '6 months'
        WHEN 'annual' THEN interval '12 months'
        ELSE interval '0 months'
      END
  ) AT TIME ZONE 'UTC';
  IF service_row.billing_cycle = 'one_time'
     OR NEW.period_end IS DISTINCT FROM expected_period_end THEN
    RAISE EXCEPTION 'renewal period does not match the service billing cycle';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM service_renewals existing
    WHERE existing.service_id = NEW.service_id
      AND existing.period_start < NEW.period_end
      AND existing.period_end > NEW.period_start
  ) THEN
    RAISE EXCEPTION 'service renewals may not overlap';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_renewals_insert_guard ON service_renewals;
CREATE TRIGGER service_renewals_insert_guard
BEFORE INSERT ON service_renewals
FOR EACH ROW EXECUTE FUNCTION opensales_validate_service_renewal_insert();

CREATE UNIQUE INDEX IF NOT EXISTS service_renewals_one_unsettled_idx
  ON service_renewals(service_id)
  WHERE status IN ('invoiced', 'manual_hold');

-- Renewal automation applies account Credit before a customer payment command
-- exists. Keep the original allocation guard, but also accept the narrowly
-- scoped system transaction whose source is the renewal owning this invoice.
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
    ct.source_type,
    ct.source_id,
    ct.actor_type,
    ct.actor_id,
    ct.credit_account_id,
    ca.client_account_id,
    ca.currency
  INTO transaction_row
  FROM credit_transactions ct
  JOIN credit_accounts ca ON ca.id = ct.credit_account_id
  WHERE ct.id = NEW.credit_transaction_id;

  SELECT
    invoice.client_account_id,
    invoice.currency,
    invoice.total_minor,
    COALESCE((
      SELECT sum(allocation.amount_minor)
      FROM payment_allocations allocation
      WHERE allocation.invoice_id = invoice.id
    ), 0) + COALESCE((
      SELECT sum(allocation.amount_minor)
      FROM credit_allocations allocation
      WHERE allocation.invoice_id = invoice.id
    ), 0) AS allocated_minor
  INTO invoice_row
  FROM invoices invoice
  WHERE invoice.id = NEW.invoice_id
  FOR UPDATE;

  IF transaction_row.client_account_id <> invoice_row.client_account_id
     OR transaction_row.currency <> invoice_row.currency
     OR (
       transaction_row.kind = 'invoice_application'
       AND (
         NEW.amount_minor <= 0
         OR transaction_row.credit_minor <> 0
         OR transaction_row.debit_minor <> NEW.amount_minor
         OR NOT (
           (
             transaction_row.source_type = 'invoice_payment_command'
             AND EXISTS (
               SELECT 1
               FROM invoice_payment_commands command
               WHERE command.id = transaction_row.source_id
                 AND command.invoice_id = NEW.invoice_id
                 AND command.client_account_id = transaction_row.client_account_id
             )
           )
           OR (
             transaction_row.source_type = 'service_renewal'
             AND transaction_row.actor_type = 'system'
             AND transaction_row.actor_id IS NULL
             AND NEW.amount_minor <= invoice_row.total_minor - invoice_row.allocated_minor
             AND EXISTS (
               SELECT 1
               FROM service_renewals renewal
               JOIN services service ON service.id = renewal.service_id
               WHERE renewal.id = transaction_row.source_id
                 AND renewal.invoice_id = NEW.invoice_id
                 AND renewal.status = 'invoiced'
                 AND renewal.creation_transaction_id = txid_current()
                 AND service.client_account_id = transaction_row.client_account_id
             )
           )
         )
       )
     )
     OR (
       transaction_row.kind = 'invoice_application_reversal'
       AND (
         NEW.amount_minor >= 0
         OR transaction_row.source_type <> 'invoice_payment_command_reversal'
         OR transaction_row.debit_minor <> 0
         OR transaction_row.credit_minor <> -NEW.amount_minor
         OR NOT EXISTS (
           SELECT 1
           FROM credit_transactions original
           JOIN credit_allocations original_allocation
             ON original_allocation.credit_transaction_id = original.id
           WHERE original.kind = 'invoice_application'
             AND original.source_type = 'invoice_payment_command'
             AND original.source_id = transaction_row.source_id
             AND original.credit_account_id = transaction_row.credit_account_id
             AND original.debit_minor = transaction_row.credit_minor
             AND original_allocation.invoice_id = NEW.invoice_id
             AND original_allocation.amount_minor = transaction_row.credit_minor
         )
       )
     )
     OR transaction_row.kind NOT IN (
       'invoice_application',
       'invoice_application_reversal'
     ) THEN
    RAISE EXCEPTION 'credit allocation does not match its transaction or invoice';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS service_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES services(id),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  period_kind text NOT NULL CHECK (period_kind IN ('initial', 'renewal')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  granted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  UNIQUE (service_id, invoice_id),
  UNIQUE (service_id, period_start)
);

CREATE OR REPLACE FUNCTION opensales_guard_service_period_overlap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  service_row record;
  invoice_row record;
BEGIN
  SELECT service.client_account_id, service.term_start, service.term_end,
         original_order.id AS order_id
  INTO service_row
  FROM services service
  JOIN order_items item ON item.id = service.order_item_id
  JOIN orders original_order ON original_order.id = item.order_id
  WHERE service.id = NEW.service_id
  FOR UPDATE OF service;
  IF service_row IS NULL THEN
    RAISE EXCEPTION 'service period references an unavailable service';
  END IF;

  SELECT client_account_id, order_id
  INTO invoice_row
  FROM invoices
  WHERE id = NEW.invoice_id;
  IF invoice_row IS NULL
     OR invoice_row.client_account_id <> service_row.client_account_id THEN
    RAISE EXCEPTION 'service period invoice ownership is inconsistent';
  END IF;

  IF NEW.period_kind = 'initial' AND (
       invoice_row.order_id IS DISTINCT FROM service_row.order_id
       OR NEW.period_start IS DISTINCT FROM service_row.term_start
       OR NEW.period_end IS DISTINCT FROM service_row.term_end
     ) THEN
    RAISE EXCEPTION 'initial service period does not match its order or service term';
  END IF;
  IF NEW.period_kind = 'renewal' AND NOT EXISTS (
    SELECT 1
    FROM service_renewals renewal
    WHERE renewal.service_id = NEW.service_id
      AND renewal.invoice_id = NEW.invoice_id
      AND renewal.period_start = NEW.period_start
      AND renewal.period_end = NEW.period_end
  ) THEN
    RAISE EXCEPTION 'renewal service period does not match its renewal obligation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM service_periods existing
    WHERE existing.service_id = NEW.service_id
      AND existing.period_start < NEW.period_end
      AND existing.period_end > NEW.period_start
  ) THEN
    RAISE EXCEPTION 'service periods may not overlap';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_periods_overlap_guard ON service_periods;
CREATE TRIGGER service_periods_overlap_guard
BEFORE INSERT ON service_periods
FOR EACH ROW EXECUTE FUNCTION opensales_guard_service_period_overlap();

CREATE OR REPLACE FUNCTION opensales_reject_service_period_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'service periods are immutable';
END;
$$;

DROP TRIGGER IF EXISTS service_periods_immutable ON service_periods;
CREATE TRIGGER service_periods_immutable
BEFORE UPDATE OR DELETE ON service_periods
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_period_mutation();

CREATE OR REPLACE FUNCTION opensales_guard_service_renewal_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.service_id IS DISTINCT FROM OLD.service_id
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.automation_run_id IS DISTINCT FROM OLD.automation_run_id
     OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.recurring_minor IS DISTINCT FROM OLD.recurring_minor
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.price_snapshot IS DISTINCT FROM OLD.price_snapshot
     OR NEW.creation_transaction_id IS DISTINCT FROM OLD.creation_transaction_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'renewal financial facts are immutable';
  END IF;
  IF OLD.funded_at IS NOT NULL AND NEW.funded_at IS DISTINCT FROM OLD.funded_at THEN
    RAISE EXCEPTION 'renewal funded time is immutable once recorded';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'renewal version must advance exactly once per update';
  END IF;
  IF OLD.status = 'paid' AND (NEW.status <> 'paid' OR NEW.settled_at IS DISTINCT FROM OLD.settled_at) THEN
    RAISE EXCEPTION 'a paid renewal cannot be reopened';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_renewals_financial_facts_immutable ON service_renewals;
CREATE TRIGGER service_renewals_financial_facts_immutable
BEFORE UPDATE ON service_renewals
FOR EACH ROW EXECUTE FUNCTION opensales_guard_service_renewal_mutation();

DROP TRIGGER IF EXISTS service_renewals_delete_rejected ON service_renewals;
CREATE TRIGGER service_renewals_delete_rejected
BEFORE DELETE ON service_renewals
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_period_mutation();

CREATE TABLE IF NOT EXISTS renewal_reminder_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  service_id uuid NOT NULL REFERENCES services(id),
  kind text NOT NULL CHECK (kind IN ('renewal_created', 'pre_due', 'overdue_first')),
  offset_days integer NOT NULL CHECK (offset_days BETWEEN 0 AND 90),
  policy_snapshot jsonb NOT NULL,
  email citext NOT NULL,
  locale text NOT NULL CHECK (locale IN ('en', 'zh-CN')),
  due_at timestamptz NOT NULL,
  amount_due_minor bigint NOT NULL CHECK (amount_due_minor >= 0),
  outbox_id uuid NOT NULL UNIQUE REFERENCES outbox(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, kind)
);

CREATE TABLE IF NOT EXISTS renewal_reminder_delivery_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL UNIQUE REFERENCES renewal_reminder_intents(id),
  provider_installation_id text NOT NULL,
  provider_message_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('delivered', 'bounced', 'failed')),
  provider_occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS renewal_reminder_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL UNIQUE REFERENCES renewal_reminder_intents(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS renewal_reminder_intents_immutable ON renewal_reminder_intents;
CREATE TRIGGER renewal_reminder_intents_immutable
BEFORE UPDATE OR DELETE ON renewal_reminder_intents
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_period_mutation();

DROP TRIGGER IF EXISTS renewal_reminder_delivery_facts_immutable
  ON renewal_reminder_delivery_facts;
CREATE TRIGGER renewal_reminder_delivery_facts_immutable
BEFORE UPDATE OR DELETE ON renewal_reminder_delivery_facts
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_period_mutation();

DROP TRIGGER IF EXISTS renewal_reminder_suppressions_immutable
  ON renewal_reminder_suppressions;
CREATE TRIGGER renewal_reminder_suppressions_immutable
BEFORE UPDATE OR DELETE ON renewal_reminder_suppressions
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_period_mutation();

DROP TRIGGER IF EXISTS billing_automation_run_requests_immutable ON billing_automation_run_requests;
CREATE TRIGGER billing_automation_run_requests_immutable
BEFORE UPDATE OR DELETE ON billing_automation_run_requests
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_period_mutation();

CREATE INDEX IF NOT EXISTS service_renewals_service_created_idx
  ON service_renewals(service_id, created_at DESC);
CREATE INDEX IF NOT EXISTS service_renewals_invoice_idx
  ON service_renewals(invoice_id);
CREATE INDEX IF NOT EXISTS renewal_reminder_intents_service_idx
  ON renewal_reminder_intents(service_id, created_at);

-- Existing active recurring services pre-date immutable period records. Their
-- original paid invoice and Ready for Service timestamps are stable source
-- facts, so migration can safely create the missing initial period once.
INSERT INTO service_periods(
  service_id, invoice_id, period_kind, period_start, period_end, granted_at
)
SELECT
  service.id,
  initial_invoice.id,
  'initial',
  service.term_start,
  service.term_end,
  COALESCE(service.activated_at, service.term_start)
FROM services service
JOIN order_items item ON item.id = service.order_item_id
JOIN LATERAL (
  SELECT invoice.id
  FROM invoices invoice
  WHERE invoice.order_id = item.order_id
  ORDER BY invoice.created_at, invoice.id
  LIMIT 1
) initial_invoice ON true
WHERE service.status IN ('active', 'suspended')
  AND service.billing_cycle <> 'one_time'
  AND service.term_start IS NOT NULL
  AND service.term_end IS NOT NULL
ON CONFLICT (service_id, invoice_id) DO NOTHING;
