-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Scheduling permission and due-time delivery are separate product decisions.
-- Existing services receive conservative manual-review/manual snapshots; a
-- deployment must explicitly seed self-service authority for new services.
ALTER TABLE product_service_automation_policies
  ADD COLUMN IF NOT EXISTS cycle_end_cancellation_mode text NOT NULL DEFAULT 'manual_review'
    CHECK (cycle_end_cancellation_mode IN (
      'self_service', 'authenticated_ticket', 'manual_review', 'disabled'
    )),
  ADD COLUMN IF NOT EXISTS cycle_end_cancellation_execution_mode text NOT NULL DEFAULT 'manual'
    CHECK (cycle_end_cancellation_execution_mode IN ('automatic', 'manual')),
  ADD COLUMN IF NOT EXISTS cycle_end_cancellation_min_notice_hours integer NOT NULL DEFAULT 0
    CHECK (cycle_end_cancellation_min_notice_hours BETWEEN 0 AND 2160),
  ADD COLUMN IF NOT EXISTS cycle_end_cancellation_requirement_key text,
  ADD COLUMN IF NOT EXISTS required_terminate_capability text NOT NULL DEFAULT 'resource_terminate'
    CHECK (required_terminate_capability = 'resource_terminate');

ALTER TABLE product_service_automation_policies
  DROP CONSTRAINT IF EXISTS product_service_automation_policies_cancellation_requirement_check,
  DROP CONSTRAINT IF EXISTS product_service_automation_policies_cancellation_provider_check;
ALTER TABLE product_service_automation_policies
  ADD CONSTRAINT product_service_automation_policies_cancellation_requirement_check CHECK (
    (
      cycle_end_cancellation_mode = 'authenticated_ticket'
      AND cycle_end_cancellation_requirement_key IS NOT NULL
    )
    OR (
      cycle_end_cancellation_mode <> 'authenticated_ticket'
      AND cycle_end_cancellation_requirement_key IS NULL
    )
  ),
  ADD CONSTRAINT product_service_automation_policies_cancellation_provider_check CHECK (
    cycle_end_cancellation_execution_mode <> 'automatic'
    OR provider_installation_id IS NOT NULL
  );

ALTER TABLE service_provider_bindings
  ADD COLUMN IF NOT EXISTS cycle_end_cancellation_mode_snapshot text NOT NULL
    DEFAULT 'manual_review'
    CHECK (cycle_end_cancellation_mode_snapshot IN (
      'self_service', 'authenticated_ticket', 'manual_review', 'disabled'
    )),
  ADD COLUMN IF NOT EXISTS cycle_end_cancellation_execution_mode_snapshot text NOT NULL
    DEFAULT 'manual'
    CHECK (cycle_end_cancellation_execution_mode_snapshot IN ('automatic', 'manual')),
  ADD COLUMN IF NOT EXISTS cycle_end_cancellation_min_notice_hours_snapshot integer NOT NULL
    DEFAULT 0
    CHECK (cycle_end_cancellation_min_notice_hours_snapshot BETWEEN 0 AND 2160),
  ADD COLUMN IF NOT EXISTS cycle_end_cancellation_requirement_key_snapshot text;

ALTER TABLE service_provider_bindings
  DROP CONSTRAINT IF EXISTS service_provider_bindings_cancellation_requirement_check,
  DROP CONSTRAINT IF EXISTS service_provider_bindings_cancellation_provider_check;
ALTER TABLE service_provider_bindings
  ADD CONSTRAINT service_provider_bindings_cancellation_requirement_check CHECK (
    (
      cycle_end_cancellation_mode_snapshot = 'authenticated_ticket'
      AND cycle_end_cancellation_requirement_key_snapshot IS NOT NULL
    )
    OR (
      cycle_end_cancellation_mode_snapshot <> 'authenticated_ticket'
      AND cycle_end_cancellation_requirement_key_snapshot IS NULL
    )
  ),
  ADD CONSTRAINT service_provider_bindings_cancellation_provider_check CHECK (
    cycle_end_cancellation_execution_mode_snapshot <> 'automatic'
    OR provider_installation_id IS NOT NULL
  );

CREATE OR REPLACE FUNCTION opensales_validate_service_provider_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  policy_row record;
  provider_row record;
BEGIN
  SELECT
    policy.overdue_action,
    policy.version,
    policy.provider_installation_id,
    policy.required_suspend_capability,
    policy.required_resume_capability,
    policy.required_terminate_capability,
    policy.cycle_end_cancellation_mode,
    policy.cycle_end_cancellation_execution_mode,
    policy.cycle_end_cancellation_min_notice_hours,
    policy.cycle_end_cancellation_requirement_key
  INTO policy_row
  FROM services service
  JOIN order_items item ON item.id = service.order_item_id
  JOIN product_service_automation_policies policy ON policy.product_id = item.product_id
  WHERE service.id = NEW.service_id
  FOR UPDATE OF policy;

  IF policy_row IS NULL
     OR NEW.overdue_action_snapshot <> policy_row.overdue_action
     OR NEW.product_policy_version <> policy_row.version
     OR NEW.provider_installation_id IS DISTINCT FROM policy_row.provider_installation_id
     OR NEW.cycle_end_cancellation_mode_snapshot
          IS DISTINCT FROM policy_row.cycle_end_cancellation_mode
     OR NEW.cycle_end_cancellation_execution_mode_snapshot
          IS DISTINCT FROM policy_row.cycle_end_cancellation_execution_mode
     OR NEW.cycle_end_cancellation_min_notice_hours_snapshot
          IS DISTINCT FROM policy_row.cycle_end_cancellation_min_notice_hours
     OR NEW.cycle_end_cancellation_requirement_key_snapshot
          IS DISTINCT FROM policy_row.cycle_end_cancellation_requirement_key THEN
    RAISE EXCEPTION 'service Provider binding does not match its explicit product policy';
  END IF;

  IF NEW.overdue_action_snapshot = 'automatic'
     OR NEW.cycle_end_cancellation_execution_mode_snapshot = 'automatic' THEN
    SELECT enabled, capabilities
    INTO provider_row
    FROM provider_installation_capabilities
    WHERE provider_installation_id = NEW.provider_installation_id
    FOR UPDATE;
    IF provider_row IS NULL
       OR NOT provider_row.enabled
       OR NEW.capability_snapshot IS DISTINCT FROM provider_row.capabilities
       OR (
         NEW.overdue_action_snapshot = 'automatic'
         AND (
           NOT (provider_row.capabilities ? policy_row.required_suspend_capability)
           OR NOT (provider_row.capabilities ? policy_row.required_resume_capability)
         )
       )
       OR (
         NEW.cycle_end_cancellation_execution_mode_snapshot = 'automatic'
         AND NOT (provider_row.capabilities ? policy_row.required_terminate_capability)
       ) THEN
      RAISE EXCEPTION 'automatic service binding lacks approved Provider capabilities';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- A cycle-end cancellation is an immutable customer request fact. The service
-- carries only the accepted schedule pointer; it does not overload service
-- status or rewrite the already-paid service period.
CREATE TABLE IF NOT EXISTS service_cancellation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES services(id),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  requested_session_id uuid NOT NULL REFERENCES sessions(id),
  effective_at timestamptz NOT NULL,
  expected_service_version integer NOT NULL CHECK (expected_service_version > 0),
  product_policy_version integer NOT NULL CHECK (product_policy_version > 0),
  policy_snapshot jsonb NOT NULL CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  notice_qualified_at timestamptz NOT NULL,
  authorization_ticket_id uuid,
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 1000),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint text NOT NULL CHECK (char_length(request_fingerprint) > 0),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  creation_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_id),
  UNIQUE (requested_by_user_id, idempotency_key)
);

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS cancellation_request_id uuid
    REFERENCES service_cancellation_requests(id),
  ADD COLUMN IF NOT EXISTS cancellation_scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_effective_at timestamptz;

ALTER TABLE services
  DROP CONSTRAINT IF EXISTS services_cycle_end_cancellation_complete;
ALTER TABLE services
  ADD CONSTRAINT services_cycle_end_cancellation_complete CHECK (
    (
      cancellation_request_id IS NULL
      AND cancellation_scheduled_at IS NULL
      AND cancellation_effective_at IS NULL
    )
    OR
    (
      cancellation_request_id IS NOT NULL
      AND cancellation_scheduled_at IS NOT NULL
      AND cancellation_effective_at IS NOT NULL
      AND term_end IS NOT NULL
      AND cancellation_effective_at = term_end
    )
  );

-- A renewal invoice can be withdrawn automatically only while it is still a
-- pristine receivable: no funds, payment history, fees, delinquency action, or
-- granted service period may exist. The invoice and its lines remain as the
-- historical issuance fact; a balanced compensating journal makes the amount
-- non-collectible.
ALTER TABLE service_renewals
  DROP CONSTRAINT IF EXISTS service_renewals_status_check,
  DROP CONSTRAINT IF EXISTS service_renewals_check1,
  DROP CONSTRAINT IF EXISTS service_renewals_check2,
  DROP CONSTRAINT IF EXISTS service_renewals_funding_state_check,
  DROP CONSTRAINT IF EXISTS service_renewals_settlement_state_check;
ALTER TABLE service_renewals
  ADD CONSTRAINT service_renewals_status_check CHECK (
    status IN ('invoiced', 'paid', 'manual_hold', 'cancelled')
  ),
  ADD CONSTRAINT service_renewals_funding_state_check CHECK (
    (status IN ('invoiced', 'cancelled')) = (funded_at IS NULL)
  ),
  ADD CONSTRAINT service_renewals_settlement_state_check CHECK (
    (status = 'paid') = (settled_at IS NOT NULL)
  );

CREATE TABLE IF NOT EXISTS service_renewal_cancellations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cancellation_request_id uuid NOT NULL UNIQUE
    REFERENCES service_cancellation_requests(id),
  renewal_id uuid NOT NULL UNIQUE REFERENCES service_renewals(id),
  invoice_id uuid NOT NULL UNIQUE REFERENCES invoices(id),
  reversal_journal_id uuid NOT NULL UNIQUE REFERENCES ledger_journals(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  creation_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION opensales_validate_service_renewal_cancellation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_row record;
  journal_row record;
BEGIN
  NEW.creation_transaction_id := txid_current();

  SELECT
    request.service_id AS request_service_id,
    request.effective_at,
    request.creation_transaction_id AS request_transaction_id,
    renewal.service_id AS renewal_service_id,
    renewal.invoice_id AS renewal_invoice_id,
    renewal.period_start,
    renewal.recurring_minor,
    renewal.currency AS renewal_currency,
    renewal.status AS renewal_status,
    renewal.funded_at,
    renewal.settled_at,
    invoice.total_minor AS invoice_total_minor,
    COALESCE((
      SELECT sum(line.amount_minor) FROM invoice_lines line
      WHERE line.invoice_id = invoice.id
    ), 0)::bigint AS invoice_line_total_minor,
    COALESCE((
      SELECT bool_and(line.kind = 'recurring') FROM invoice_lines line
      WHERE line.invoice_id = invoice.id
    ), false) AS recurring_lines_only
  INTO source_row
  FROM service_cancellation_requests request
  JOIN service_renewals renewal ON renewal.id = NEW.renewal_id
  JOIN invoices invoice ON invoice.id = renewal.invoice_id
  WHERE request.id = NEW.cancellation_request_id
  FOR UPDATE OF renewal, invoice;

  IF source_row IS NULL
     OR source_row.request_service_id <> source_row.renewal_service_id
     OR source_row.request_transaction_id <> txid_current()
     OR source_row.effective_at IS DISTINCT FROM source_row.period_start
     OR source_row.renewal_invoice_id <> NEW.invoice_id
     OR source_row.renewal_status <> 'invoiced'
     OR source_row.funded_at IS NOT NULL
     OR source_row.settled_at IS NOT NULL
     OR source_row.recurring_minor <> NEW.amount_minor
     OR source_row.invoice_total_minor <> NEW.amount_minor
     OR source_row.invoice_line_total_minor <> NEW.amount_minor
     OR NOT source_row.recurring_lines_only
     OR source_row.renewal_currency <> NEW.currency THEN
    RAISE EXCEPTION 'renewal cancellation does not match a pristine renewal invoice';
  END IF;

  IF EXISTS (
    SELECT 1 FROM payment_allocations allocation
    WHERE allocation.invoice_id = NEW.invoice_id
  ) OR EXISTS (
    SELECT 1 FROM credit_allocations allocation
    WHERE allocation.invoice_id = NEW.invoice_id
  ) OR EXISTS (
    SELECT 1 FROM fund_receipt_allocations allocation
    WHERE allocation.invoice_id = NEW.invoice_id
  ) OR EXISTS (
    SELECT 1 FROM payment_attempts attempt
    WHERE attempt.invoice_id = NEW.invoice_id
  ) OR EXISTS (
    SELECT 1 FROM invoice_payment_commands command
    WHERE command.invoice_id = NEW.invoice_id
  ) OR EXISTS (
    SELECT 1 FROM invoice_fee_charges charge
    WHERE charge.invoice_id = NEW.invoice_id
  ) OR EXISTS (
    SELECT 1 FROM invoice_late_fee_assessments assessment
    WHERE assessment.invoice_id = NEW.invoice_id
  ) OR EXISTS (
    SELECT 1 FROM invoice_delinquency_deferrals deferral
    WHERE deferral.invoice_id = NEW.invoice_id
  ) OR EXISTS (
    SELECT 1 FROM service_suspension_cases suspension_case
    WHERE suspension_case.invoice_id = NEW.invoice_id
  ) OR EXISTS (
    SELECT 1 FROM service_periods period
    WHERE period.invoice_id = NEW.invoice_id
  ) OR EXISTS (
    SELECT 1 FROM service_renewal_hold_resolutions resolution
    WHERE resolution.renewal_id = NEW.renewal_id
  ) THEN
    RAISE EXCEPTION 'renewal financial or delinquency facts require staff review';
  END IF;

  SELECT
    journal.source_type,
    journal.source_id,
    journal.currency,
    journal.sealed_at,
    count(line.id)::integer AS line_count,
    COALESCE(sum(line.debit_minor), 0)::bigint AS debit_minor,
    COALESCE(sum(line.credit_minor), 0)::bigint AS credit_minor,
    COALESCE(sum(line.debit_minor) FILTER (
      WHERE line.account_code = 'deferred_service_revenue'
    ), 0)::bigint AS deferred_revenue_debit_minor,
    COALESCE(sum(line.credit_minor) FILTER (
      WHERE line.account_code = 'accounts_receivable'
    ), 0)::bigint AS receivable_credit_minor
  INTO journal_row
  FROM ledger_journals journal
  LEFT JOIN ledger_lines line ON line.journal_id = journal.id
  WHERE journal.id = NEW.reversal_journal_id
  GROUP BY journal.id;

  IF journal_row IS NULL
     OR journal_row.source_type <> 'service_renewal_cancellation'
     OR journal_row.source_id <> NEW.id
     OR journal_row.currency <> NEW.currency
     OR journal_row.sealed_at IS NULL
     OR journal_row.line_count <> 2
     OR journal_row.debit_minor <> NEW.amount_minor
     OR journal_row.credit_minor <> NEW.amount_minor
     OR journal_row.deferred_revenue_debit_minor <> NEW.amount_minor
     OR journal_row.receivable_credit_minor <> NEW.amount_minor THEN
    RAISE EXCEPTION 'renewal cancellation reversal journal is inconsistent';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_renewal_cancellations_insert_guard
  ON service_renewal_cancellations;
CREATE TRIGGER service_renewal_cancellations_insert_guard
BEFORE INSERT ON service_renewal_cancellations
FOR EACH ROW EXECUTE FUNCTION opensales_validate_service_renewal_cancellation();

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
  IF OLD.status = 'paid' AND (
       NEW.status <> 'paid' OR NEW.settled_at IS DISTINCT FROM OLD.settled_at
     ) THEN
    RAISE EXCEPTION 'a paid renewal cannot be reopened';
  END IF;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'a cancelled renewal is immutable';
  END IF;
  IF NEW.status = 'cancelled' AND (
       OLD.status <> 'invoiced'
       OR OLD.funded_at IS NOT NULL
       OR OLD.settled_at IS NOT NULL
       OR NEW.funded_at IS NOT NULL
       OR NEW.settled_at IS NOT NULL
       OR NOT EXISTS (
         SELECT 1
         FROM service_renewal_cancellations cancellation
         WHERE cancellation.renewal_id = NEW.id
           AND cancellation.invoice_id = NEW.invoice_id
           AND cancellation.creation_transaction_id = txid_current()
       )
     ) THEN
    RAISE EXCEPTION 'renewal can only be cancelled by an atomic pristine cancellation fact';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_require_renewal_cancellation_attachment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM service_renewals renewal
    JOIN service_cancellation_requests request
      ON request.id = NEW.cancellation_request_id
    JOIN services service
      ON service.id = renewal.service_id
     AND service.cancellation_request_id = request.id
    WHERE renewal.id = NEW.renewal_id
      AND renewal.invoice_id = NEW.invoice_id
      AND renewal.status = 'cancelled'
      AND renewal.funded_at IS NULL
      AND renewal.settled_at IS NULL
      AND renewal.period_start = request.effective_at
      AND request.creation_transaction_id = txid_current()
      AND NEW.creation_transaction_id = txid_current()
  ) THEN
    RAISE EXCEPTION 'renewal cancellation was not atomically attached and closed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_renewal_cancellations_attachment_guard
  ON service_renewal_cancellations;
CREATE CONSTRAINT TRIGGER service_renewal_cancellations_attachment_guard
AFTER INSERT ON service_renewal_cancellations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opensales_require_renewal_cancellation_attachment();

DROP TRIGGER IF EXISTS service_renewal_cancellations_immutable
  ON service_renewal_cancellations;
CREATE TRIGGER service_renewal_cancellations_immutable
BEFORE UPDATE OR DELETE ON service_renewal_cancellations
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_period_mutation();

-- Application paths check the current Order/Service/Renewal state before
-- moving money. Keep the cancelled-renewal boundary in PostgreSQL as well so
-- a future staff, callback, or maintenance path cannot make a withdrawn
-- receivable collectible again through any allocation table.
CREATE OR REPLACE FUNCTION opensales_reject_cancelled_renewal_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM service_renewals renewal
    WHERE renewal.invoice_id = NEW.invoice_id
      AND renewal.status = 'cancelled'
  ) THEN
    RAISE EXCEPTION 'cancelled renewal invoices cannot receive allocations';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_allocations_cancelled_renewal_guard
  ON payment_allocations;
CREATE TRIGGER payment_allocations_cancelled_renewal_guard
BEFORE INSERT ON payment_allocations
FOR EACH ROW EXECUTE FUNCTION opensales_reject_cancelled_renewal_allocation();

DROP TRIGGER IF EXISTS credit_allocations_cancelled_renewal_guard
  ON credit_allocations;
CREATE TRIGGER credit_allocations_cancelled_renewal_guard
BEFORE INSERT ON credit_allocations
FOR EACH ROW EXECUTE FUNCTION opensales_reject_cancelled_renewal_allocation();

DROP TRIGGER IF EXISTS fund_receipt_allocations_cancelled_renewal_guard
  ON fund_receipt_allocations;
CREATE TRIGGER fund_receipt_allocations_cancelled_renewal_guard
BEFORE INSERT ON fund_receipt_allocations
FOR EACH ROW EXECUTE FUNCTION opensales_reject_cancelled_renewal_allocation();

CREATE OR REPLACE FUNCTION opensales_validate_service_cancellation_request()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_row record;
BEGIN
  -- The caller cannot manufacture the same-transaction marker used when the
  -- service accepts this request.
  NEW.creation_transaction_id := txid_current();

  SELECT
    service.client_account_id,
    service.status AS service_status,
    service.billing_cycle,
    service.term_end,
    service.version AS service_version,
    service.cancellation_request_id,
    account.restricted_at AS account_restricted_at,
    request_user.email_verified_at,
    request_user.restricted_at AS user_restricted_at,
    membership.role AS membership_role,
    membership.removed_at AS membership_removed_at,
    session_record.expires_at AS session_expires_at,
    session_record.revoked_at AS session_revoked_at,
    binding.product_policy_version,
    binding.cycle_end_cancellation_mode_snapshot,
    binding.cycle_end_cancellation_execution_mode_snapshot,
    binding.cycle_end_cancellation_min_notice_hours_snapshot,
    binding.cycle_end_cancellation_requirement_key_snapshot
  INTO source_row
  FROM services service
  JOIN client_accounts account
    ON account.id = service.client_account_id
   AND account.id = NEW.client_account_id
  JOIN users request_user
    ON request_user.id = NEW.requested_by_user_id
  JOIN client_memberships membership
    ON membership.client_account_id = account.id
   AND membership.user_id = request_user.id
  JOIN sessions session_record
    ON session_record.id = NEW.requested_session_id
   AND session_record.user_id = request_user.id
  JOIN service_provider_bindings binding
    ON binding.service_id = service.id
  WHERE service.id = NEW.service_id
  FOR UPDATE OF service, account, request_user, membership, session_record;

  IF source_row IS NULL
     OR source_row.client_account_id <> NEW.client_account_id
     OR source_row.service_status NOT IN ('active', 'suspended')
     OR source_row.billing_cycle = 'one_time'
     OR source_row.term_end IS NULL
     OR source_row.term_end <= now()
     OR NEW.effective_at IS DISTINCT FROM source_row.term_end
     OR source_row.service_version <> NEW.expected_service_version
     OR source_row.cancellation_request_id IS NOT NULL
     OR source_row.email_verified_at IS NULL
     OR source_row.user_restricted_at IS NOT NULL
     OR source_row.account_restricted_at IS NOT NULL
     OR source_row.membership_removed_at IS NOT NULL
     OR source_row.membership_role NOT IN ('owner', 'billing')
     OR source_row.session_revoked_at IS NOT NULL
     OR source_row.session_expires_at <= now()
     OR source_row.cycle_end_cancellation_mode_snapshot <> 'self_service'
     OR source_row.cycle_end_cancellation_requirement_key_snapshot IS NOT NULL
     OR NEW.authorization_ticket_id IS NOT NULL
     OR NEW.product_policy_version <> source_row.product_policy_version
     OR NEW.notice_qualified_at IS DISTINCT FROM NEW.created_at
     OR NEW.notice_qualified_at > source_row.term_end
          - make_interval(hours => source_row.cycle_end_cancellation_min_notice_hours_snapshot)
     OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object(
          'schedulingMode', source_row.cycle_end_cancellation_mode_snapshot,
          'executionMode', source_row.cycle_end_cancellation_execution_mode_snapshot,
          'minimumNoticeHours', source_row.cycle_end_cancellation_min_notice_hours_snapshot,
          'requirementKey', source_row.cycle_end_cancellation_requirement_key_snapshot
        ) THEN
    RAISE EXCEPTION 'cycle-end cancellation request is not eligible for this service and session';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_cancellation_requests_insert_guard
  ON service_cancellation_requests;
CREATE TRIGGER service_cancellation_requests_insert_guard
BEFORE INSERT ON service_cancellation_requests
FOR EACH ROW EXECUTE FUNCTION opensales_validate_service_cancellation_request();

CREATE OR REPLACE FUNCTION opensales_guard_service_cycle_end_cancellation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  request_row record;
BEGIN
  IF OLD.cancellation_request_id IS NOT NULL THEN
    IF NEW.cancellation_request_id IS DISTINCT FROM OLD.cancellation_request_id
       OR NEW.cancellation_scheduled_at IS DISTINCT FROM OLD.cancellation_scheduled_at
       OR NEW.cancellation_effective_at IS DISTINCT FROM OLD.cancellation_effective_at
       OR NEW.term_end IS DISTINCT FROM OLD.term_end THEN
      RAISE EXCEPTION 'an accepted cycle-end cancellation schedule is immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.cancellation_request_id IS NULL
     AND NEW.cancellation_scheduled_at IS NULL
     AND NEW.cancellation_effective_at IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.cancellation_request_id IS NULL
     OR NEW.cancellation_scheduled_at IS NULL
     OR NEW.cancellation_effective_at IS NULL THEN
    RAISE EXCEPTION 'cycle-end cancellation schedule fields must be set together';
  END IF;

  SELECT
    request.id,
    request.service_id,
    request.client_account_id,
    request.effective_at,
    request.expected_service_version,
    request.creation_transaction_id,
    request.created_at
  INTO request_row
  FROM service_cancellation_requests request
  WHERE request.id = NEW.cancellation_request_id;

  IF request_row IS NULL
     OR request_row.service_id <> NEW.id
     OR request_row.client_account_id <> NEW.client_account_id
     OR request_row.effective_at IS DISTINCT FROM NEW.cancellation_effective_at
     OR request_row.effective_at IS DISTINCT FROM OLD.term_end
     OR request_row.expected_service_version <> OLD.version
     OR request_row.creation_transaction_id <> txid_current()
     OR request_row.created_at IS DISTINCT FROM NEW.cancellation_scheduled_at
     OR NEW.term_end IS DISTINCT FROM OLD.term_end
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'cycle-end cancellation schedule does not match a new request fact';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS services_cycle_end_cancellation_guard ON services;
CREATE TRIGGER services_cycle_end_cancellation_guard
BEFORE UPDATE OF cancellation_request_id, cancellation_scheduled_at,
  cancellation_effective_at, term_end ON services
FOR EACH ROW EXECUTE FUNCTION opensales_guard_service_cycle_end_cancellation();

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
      'refund_reconcile',
      'resource_suspend',
      'resource_resume',
      'resource_terminate'
    )
  );

CREATE TABLE IF NOT EXISTS service_cancellation_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cancellation_request_id uuid NOT NULL UNIQUE REFERENCES service_cancellation_requests(id),
  service_id uuid NOT NULL UNIQUE REFERENCES services(id),
  execution_mode text NOT NULL CHECK (execution_mode IN ('automatic', 'manual')),
  provider_installation_id text
    REFERENCES provider_installation_capabilities(provider_installation_id),
  provider_capability_snapshot jsonb NOT NULL
    CHECK (jsonb_typeof(provider_capability_snapshot) = 'object'),
  status text NOT NULL CHECK (
    status IN ('scheduled', 'processing', 'unknown', 'manual', 'terminated')
  ),
  result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object'),
  provider_occurred_at timestamptz,
  last_error text,
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (execution_mode = 'automatic' AND provider_installation_id IS NOT NULL)
    OR (execution_mode = 'manual' AND provider_installation_id IS NULL)
  ),
  CHECK ((status = 'terminated') = (completed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS service_cancellation_manual_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL UNIQUE REFERENCES service_cancellation_executions(id),
  service_id uuid NOT NULL UNIQUE REFERENCES services(id),
  staff_user_id uuid NOT NULL REFERENCES staff_members(user_id),
  staff_session_id uuid NOT NULL REFERENCES sessions(id),
  staff_client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  takeover_kind text NOT NULL CHECK (
    takeover_kind IN ('manual_delivery', 'provider_reconciliation_takeover')
  ),
  expected_execution_version integer NOT NULL CHECK (expected_execution_version > 0),
  expected_service_version integer NOT NULL CHECK (expected_service_version > 0),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 1000),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint text NOT NULL CHECK (char_length(request_fingerprint) > 0),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  creation_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_user_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION opensales_validate_service_cancellation_manual_action()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_row record;
BEGIN
  NEW.creation_transaction_id := txid_current();
  SELECT
    execution.service_id AS execution_service_id,
    execution.execution_mode,
    execution.status AS execution_status,
    execution.version AS execution_version,
    request.effective_at,
    service.status AS service_status,
    service.version AS service_version,
    operation.status AS provider_operation_status,
    operation.attempt_count AS provider_attempt_count,
    staff.permissions,
    staff.active AS staff_active,
    staff_user.email_verified_at,
    staff_user.restricted_at AS staff_restricted_at,
    session_record.revoked_at AS session_revoked_at,
    session_record.expires_at AS session_expires_at,
    membership.removed_at AS membership_removed_at,
    staff_account.restricted_at AS staff_account_restricted_at,
    reauth.invalidated_at AS reauth_invalidated_at,
    reauth.expires_at AS reauth_expires_at
  INTO source_row
  FROM service_cancellation_executions execution
  JOIN service_cancellation_requests request
    ON request.id = execution.cancellation_request_id
  JOIN services service ON service.id = execution.service_id
  JOIN staff_members staff ON staff.user_id = NEW.staff_user_id
  JOIN users staff_user ON staff_user.id = staff.user_id
  JOIN sessions session_record
    ON session_record.id = NEW.staff_session_id
   AND session_record.user_id = staff.user_id
  JOIN client_memberships membership
    ON membership.user_id = staff.user_id
   AND membership.client_account_id = NEW.staff_client_account_id
  JOIN client_accounts staff_account
    ON staff_account.id = membership.client_account_id
  JOIN LATERAL (
    SELECT grant_record.invalidated_at, grant_record.expires_at
    FROM reauth_grants grant_record
    WHERE grant_record.user_id = staff.user_id
      AND grant_record.session_id = session_record.id
    ORDER BY grant_record.created_at DESC
    LIMIT 1
  ) reauth ON true
  LEFT JOIN provider_operations operation
    ON operation.subject_type = 'service_cancellation_execution'
   AND operation.subject_id = execution.id
   AND operation.kind = 'resource_terminate'
  WHERE execution.id = NEW.execution_id
  FOR UPDATE OF execution, service, staff, staff_user, session_record,
    membership, staff_account;

  IF source_row IS NULL
     OR source_row.execution_service_id <> NEW.service_id
     OR source_row.execution_status <> 'manual'
     OR source_row.execution_version <> NEW.expected_execution_version
     OR source_row.service_version <> NEW.expected_service_version
     OR source_row.service_status NOT IN ('active', 'suspended', 'provisioned_hold')
     OR source_row.effective_at > now()
     OR NOT source_row.staff_active
     OR source_row.email_verified_at IS NULL
     OR source_row.staff_restricted_at IS NOT NULL
     OR source_row.session_revoked_at IS NOT NULL
     OR source_row.session_expires_at <= now()
     OR source_row.membership_removed_at IS NOT NULL
     OR source_row.staff_account_restricted_at IS NOT NULL
     OR source_row.reauth_invalidated_at IS NOT NULL
     OR source_row.reauth_expires_at <= now()
     OR NOT (
       source_row.permissions ? '*'
       OR source_row.permissions ? 'services.manual_fulfillment'
     ) THEN
    RAISE EXCEPTION 'manual cancellation completion lacks current authority or eligible state';
  END IF;

  IF source_row.execution_mode = 'manual' AND (
       NEW.takeover_kind <> 'manual_delivery'
       OR source_row.provider_operation_status IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'manual cancellation completion does not match manual delivery';
  END IF;
  IF source_row.execution_mode = 'automatic' AND (
       NEW.takeover_kind <> 'provider_reconciliation_takeover'
       OR source_row.provider_operation_status NOT IN ('unknown', 'failed', 'succeeded')
       OR COALESCE(source_row.provider_attempt_count, 0) < 1
     ) THEN
    RAISE EXCEPTION 'automatic cancellation takeover lacks prior Provider evidence';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_cancellation_manual_actions_insert_guard
  ON service_cancellation_manual_actions;
CREATE TRIGGER service_cancellation_manual_actions_insert_guard
BEFORE INSERT ON service_cancellation_manual_actions
FOR EACH ROW EXECUTE FUNCTION opensales_validate_service_cancellation_manual_action();

CREATE OR REPLACE FUNCTION opensales_require_service_cancellation_manual_completion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM service_cancellation_executions execution
    JOIN services service ON service.id = execution.service_id
    WHERE execution.id = NEW.execution_id
      AND execution.service_id = NEW.service_id
      AND execution.status = 'terminated'
      AND execution.version = NEW.expected_execution_version + 1
      AND service.status = 'terminated'
      AND service.version = NEW.expected_service_version + 1
      AND NEW.creation_transaction_id = txid_current()
  ) THEN
    RAISE EXCEPTION 'manual cancellation action was not atomically completed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_cancellation_manual_actions_attachment_guard
  ON service_cancellation_manual_actions;
CREATE CONSTRAINT TRIGGER service_cancellation_manual_actions_attachment_guard
AFTER INSERT ON service_cancellation_manual_actions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opensales_require_service_cancellation_manual_completion();

DROP TRIGGER IF EXISTS service_cancellation_manual_actions_immutable
  ON service_cancellation_manual_actions;
CREATE TRIGGER service_cancellation_manual_actions_immutable
BEFORE UPDATE OR DELETE ON service_cancellation_manual_actions
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_period_mutation();

CREATE OR REPLACE FUNCTION opensales_guard_automatic_cancellation_service_termination()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.cancellation_request_id IS NOT NULL
     AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'a cancellation-bound service version must advance exactly once';
  END IF;
  IF OLD.cancellation_request_id IS NOT NULL
     AND OLD.status = 'terminated'
     AND NEW.status <> 'terminated' THEN
    RAISE EXCEPTION 'a service terminated by cycle-end cancellation cannot move backwards';
  END IF;
  IF OLD.status <> 'terminated'
     AND NEW.status = 'terminated'
     AND EXISTS (
       SELECT 1
       FROM service_cancellation_executions execution
       WHERE execution.service_id = NEW.id
         AND execution.execution_mode = 'automatic'
     )
     AND NOT EXISTS (
       SELECT 1
       FROM service_cancellation_executions execution
       JOIN provider_operations operation
         ON operation.subject_type = 'service_cancellation_execution'
        AND operation.subject_id = execution.id
        AND operation.kind = 'resource_terminate'
        AND operation.status = 'succeeded'
       WHERE execution.service_id = NEW.id
         AND execution.execution_mode = 'automatic'
     )
     AND NOT EXISTS (
       SELECT 1
       FROM service_cancellation_manual_actions manual_action
       WHERE manual_action.service_id = NEW.id
         AND manual_action.creation_transaction_id = txid_current()
     ) THEN
    RAISE EXCEPTION 'automatic cancellation cannot terminate a service without confirmed Provider success';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS services_automatic_cancellation_termination_guard ON services;
CREATE TRIGGER services_automatic_cancellation_termination_guard
BEFORE UPDATE OF status, version ON services
FOR EACH ROW EXECUTE FUNCTION opensales_guard_automatic_cancellation_service_termination();

CREATE OR REPLACE FUNCTION opensales_validate_service_cancellation_execution_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_row record;
  expected_mode text;
BEGIN
  SELECT
    request.service_id AS request_service_id,
    request.creation_transaction_id,
    service.cancellation_request_id,
    binding.cycle_end_cancellation_execution_mode_snapshot AS binding_action,
    binding.provider_installation_id AS binding_provider_installation_id,
    binding.capability_snapshot AS binding_capabilities,
    provider.enabled AS provider_enabled,
    provider.capabilities AS current_capabilities
  INTO source_row
  FROM service_cancellation_requests request
  JOIN services service ON service.id = request.service_id
  LEFT JOIN service_provider_bindings binding ON binding.service_id = service.id
  LEFT JOIN provider_installation_capabilities provider
    ON provider.provider_installation_id = binding.provider_installation_id
  WHERE request.id = NEW.cancellation_request_id;

  expected_mode := CASE
    WHEN source_row.binding_action = 'automatic'
      AND source_row.binding_provider_installation_id IS NOT NULL
      AND source_row.binding_capabilities ? 'resource_terminate'
      AND COALESCE(source_row.provider_enabled, false)
      AND source_row.current_capabilities ? 'resource_terminate'
      THEN 'automatic'
    ELSE 'manual'
  END;

  IF source_row IS NULL
     OR source_row.request_service_id <> NEW.service_id
     OR source_row.creation_transaction_id <> txid_current()
     OR source_row.cancellation_request_id <> NEW.cancellation_request_id
     OR NEW.status <> 'scheduled'
     OR NEW.result IS DISTINCT FROM jsonb_build_object('status', 'scheduled')
     OR NEW.execution_mode <> expected_mode
     OR NEW.provider_installation_id IS DISTINCT FROM (CASE
          WHEN expected_mode = 'automatic'
            THEN source_row.binding_provider_installation_id
          ELSE NULL
        END)
     OR NEW.provider_capability_snapshot IS DISTINCT FROM jsonb_build_object(
          'atBinding', COALESCE(source_row.binding_capabilities, '[]'::jsonb),
          'current', COALESCE(source_row.current_capabilities, '[]'::jsonb)
        ) THEN
    RAISE EXCEPTION 'cancellation execution does not match its request and Provider authority';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_cancellation_executions_insert_guard
  ON service_cancellation_executions;
CREATE TRIGGER service_cancellation_executions_insert_guard
BEFORE INSERT ON service_cancellation_executions
FOR EACH ROW EXECUTE FUNCTION opensales_validate_service_cancellation_execution_insert();

CREATE OR REPLACE FUNCTION opensales_guard_service_cancellation_execution_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  transition_allowed boolean := false;
BEGIN
  IF NEW.cancellation_request_id IS DISTINCT FROM OLD.cancellation_request_id
     OR NEW.service_id IS DISTINCT FROM OLD.service_id
     OR NEW.execution_mode IS DISTINCT FROM OLD.execution_mode
     OR NEW.provider_installation_id IS DISTINCT FROM OLD.provider_installation_id
     OR NEW.provider_capability_snapshot IS DISTINCT FROM OLD.provider_capability_snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'cancellation execution business identity is immutable';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'cancellation execution version must advance exactly once';
  END IF;
  IF OLD.provider_occurred_at IS NOT NULL
     AND NEW.provider_occurred_at IS DISTINCT FROM OLD.provider_occurred_at
     AND (NEW.provider_occurred_at IS NULL OR NEW.provider_occurred_at < OLD.provider_occurred_at) THEN
    RAISE EXCEPTION 'cancellation Provider time cannot move backwards';
  END IF;

  transition_allowed := CASE OLD.status
    WHEN 'scheduled' THEN NEW.status IN ('processing', 'manual', 'terminated')
    WHEN 'processing' THEN NEW.status IN ('unknown', 'manual', 'terminated')
    WHEN 'unknown' THEN NEW.status IN ('manual', 'terminated')
    WHEN 'manual' THEN NEW.status = 'terminated'
    WHEN 'terminated' THEN false
    ELSE false
  END;
  IF NOT transition_allowed THEN
    RAISE EXCEPTION 'cancellation execution status transition is invalid';
  END IF;
  IF OLD.status <> 'terminated'
     AND NEW.status = 'terminated'
     AND NEW.execution_mode = 'automatic'
     AND NOT EXISTS (
       SELECT 1
       FROM provider_operations operation
       WHERE operation.subject_type = 'service_cancellation_execution'
         AND operation.subject_id = NEW.id
         AND operation.kind = 'resource_terminate'
         AND operation.status = 'succeeded'
     )
     AND NOT EXISTS (
       SELECT 1
       FROM service_cancellation_manual_actions manual_action
       WHERE manual_action.execution_id = NEW.id
         AND manual_action.creation_transaction_id = txid_current()
     ) THEN
    RAISE EXCEPTION 'automatic cancellation execution requires confirmed Provider success';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_cancellation_executions_update_guard
  ON service_cancellation_executions;
CREATE TRIGGER service_cancellation_executions_update_guard
BEFORE UPDATE ON service_cancellation_executions
FOR EACH ROW EXECUTE FUNCTION opensales_guard_service_cancellation_execution_update();

DROP TRIGGER IF EXISTS service_cancellation_executions_delete_rejected
  ON service_cancellation_executions;
CREATE TRIGGER service_cancellation_executions_delete_rejected
BEFORE DELETE ON service_cancellation_executions
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_period_mutation();

CREATE OR REPLACE FUNCTION opensales_require_service_cancellation_request_attachment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM services service
    WHERE service.id = NEW.service_id
      AND service.client_account_id = NEW.client_account_id
      AND service.cancellation_request_id = NEW.id
      AND service.cancellation_scheduled_at IS NOT DISTINCT FROM NEW.created_at
      AND service.cancellation_effective_at IS NOT DISTINCT FROM NEW.effective_at
      AND service.term_end IS NOT DISTINCT FROM NEW.effective_at
      AND service.version = NEW.expected_service_version + 1
      AND NEW.creation_transaction_id = txid_current()
  ) THEN
    RAISE EXCEPTION 'service cancellation request was not atomically attached to its service';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM service_cancellation_executions execution
    JOIN durable_jobs job
      ON job.job_type = 'service.cancellation.due'
     AND job.unique_key = 'service-cancellation:' || NEW.id::text || ':terminate'
     AND job.payload->>'cancellationRequestId' = NEW.id::text
     AND job.payload->>'executionId' = execution.id::text
     AND job.payload->>'serviceId' = NEW.service_id::text
     AND job.available_at = NEW.effective_at
    WHERE execution.cancellation_request_id = NEW.id
      AND execution.service_id = NEW.service_id
      AND execution.status = 'scheduled'
      AND (
        (
          execution.execution_mode = 'manual'
          AND NOT EXISTS (
            SELECT 1
            FROM provider_operations operation
            WHERE operation.subject_type = 'service_cancellation_execution'
              AND operation.subject_id = execution.id
          )
        )
        OR
        (
          execution.execution_mode = 'automatic'
          AND EXISTS (
            SELECT 1
            FROM provider_operations operation
            WHERE operation.subject_type = 'service_cancellation_execution'
              AND operation.subject_id = execution.id
              AND operation.provider_installation_id = execution.provider_installation_id
              AND operation.kind = 'resource_terminate'
              AND operation.stable_key = job.unique_key
              AND operation.status = 'queued'
              AND operation.attempt_count = 0
              AND job.payload->>'providerOperationId' = operation.id::text
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'service cancellation request lacks its durable due execution';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM service_renewals renewal
    WHERE renewal.service_id = NEW.service_id
      AND renewal.status IN ('invoiced', 'manual_hold')
  ) THEN
    RAISE EXCEPTION 'service cancellation request left an unsettled renewal collectible';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_cancellation_requests_attachment_guard
  ON service_cancellation_requests;
CREATE CONSTRAINT TRIGGER service_cancellation_requests_attachment_guard
AFTER INSERT ON service_cancellation_requests
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opensales_require_service_cancellation_request_attachment();

CREATE OR REPLACE FUNCTION opensales_reject_service_cancellation_request_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'service cancellation requests are immutable';
END;
$$;

DROP TRIGGER IF EXISTS service_cancellation_requests_immutable
  ON service_cancellation_requests;
CREATE TRIGGER service_cancellation_requests_immutable
BEFORE UPDATE OR DELETE ON service_cancellation_requests
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_cancellation_request_mutation();

CREATE INDEX IF NOT EXISTS service_cancellation_requests_account_created_idx
  ON service_cancellation_requests(client_account_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS service_cancellation_executions_status_created_idx
  ON service_cancellation_executions(status, created_at, id);
CREATE INDEX IF NOT EXISTS provider_operations_cancellation_execution_idx
  ON provider_operations(subject_id, created_at)
  WHERE subject_type = 'service_cancellation_execution'
    AND kind = 'resource_terminate';
