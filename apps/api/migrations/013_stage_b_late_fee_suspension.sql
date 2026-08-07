-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE billing_automation_policies
  ADD COLUMN IF NOT EXISTS late_fee_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS late_fee_days integer NOT NULL DEFAULT 5
    CHECK (late_fee_days BETWEEN 1 AND 90),
  ADD COLUMN IF NOT EXISTS late_fee_basis_points integer NOT NULL DEFAULT 1000
    CHECK (late_fee_basis_points BETWEEN 1 AND 10000),
  ADD COLUMN IF NOT EXISTS overdue_suspension_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS overdue_suspension_days integer NOT NULL DEFAULT 5
    CHECK (overdue_suspension_days BETWEEN 1 AND 90);

ALTER TABLE billing_automation_runs
  ALTER COLUMN requested_by_user_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS trigger_kind text NOT NULL DEFAULT 'staff'
    CHECK (trigger_kind IN ('staff', 'scheduled')),
  ADD COLUMN IF NOT EXISTS late_fees_assessed integer NOT NULL DEFAULT 0
    CHECK (late_fees_assessed >= 0),
  ADD COLUMN IF NOT EXISTS late_fee_minor bigint NOT NULL DEFAULT 0
    CHECK (late_fee_minor >= 0),
  ADD COLUMN IF NOT EXISTS suspension_cases_created integer NOT NULL DEFAULT 0
    CHECK (suspension_cases_created >= 0),
  ADD COLUMN IF NOT EXISTS delinquency_deferrals_created integer NOT NULL DEFAULT 0
    CHECK (delinquency_deferrals_created >= 0);

ALTER TABLE billing_automation_runs
  DROP CONSTRAINT IF EXISTS billing_automation_runs_trigger_actor_check;
ALTER TABLE billing_automation_runs
  ADD CONSTRAINT billing_automation_runs_trigger_actor_check CHECK (
    (trigger_kind = 'staff' AND requested_by_user_id IS NOT NULL)
    OR (trigger_kind = 'scheduled' AND requested_by_user_id IS NULL)
  );

-- A product policy is an explicit operator decision. It is deliberately
-- separate from fulfillment_mode: automatic provisioning does not imply that
-- a service may be suspended automatically for an overdue invoice.
CREATE TABLE IF NOT EXISTS product_service_automation_policies (
  product_id text PRIMARY KEY REFERENCES products(id),
  overdue_action text NOT NULL CHECK (overdue_action IN ('automatic', 'manual', 'none')),
  provider_installation_id text,
  overdue_delay_mode text NOT NULL DEFAULT 'policy_calendar_days'
    CHECK (overdue_delay_mode IN ('policy_calendar_days', 'exact_hours')),
  overdue_delay_value integer NOT NULL DEFAULT 5,
  required_suspend_capability text NOT NULL DEFAULT 'resource_suspend'
    CHECK (required_suspend_capability = 'resource_suspend'),
  required_resume_capability text NOT NULL DEFAULT 'resource_resume'
    CHECK (required_resume_capability = 'resource_resume'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (overdue_delay_mode = 'policy_calendar_days' AND overdue_delay_value BETWEEN 1 AND 90)
    OR (overdue_delay_mode = 'exact_hours' AND overdue_delay_value BETWEEN 1 AND 2160)
  )
);

-- This is the Core-side view of a currently approved Provider installation.
-- Worker network policy remains a separate enforcement layer.
CREATE TABLE IF NOT EXISTS provider_installation_capabilities (
  provider_installation_id text PRIMARY KEY,
  provider_type text NOT NULL CHECK (provider_type = 'provisioning'),
  enabled boolean NOT NULL DEFAULT true,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(capabilities) = 'array'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE product_service_automation_policies
  DROP CONSTRAINT IF EXISTS product_service_automation_policies_provider_fk;
ALTER TABLE product_service_automation_policies
  ADD CONSTRAINT product_service_automation_policies_provider_fk
    FOREIGN KEY (provider_installation_id)
    REFERENCES provider_installation_capabilities(provider_installation_id),
  ADD CONSTRAINT product_service_automation_policies_automatic_provider_check
    CHECK (overdue_action <> 'automatic' OR provider_installation_id IS NOT NULL);

-- The binding is the immutable policy/capability snapshot accepted when the
-- service was bound to a Provider. Runtime automation also checks the current
-- product policy and current Provider capabilities before every new action.
CREATE TABLE IF NOT EXISTS service_provider_bindings (
  service_id uuid PRIMARY KEY REFERENCES services(id),
  provider_installation_id text REFERENCES provider_installation_capabilities(provider_installation_id),
  overdue_action_snapshot text NOT NULL
    CHECK (overdue_action_snapshot IN ('automatic', 'manual', 'none')),
  capability_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(capability_snapshot) = 'array'),
  product_policy_version integer NOT NULL CHECK (product_policy_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (overdue_action_snapshot <> 'automatic' OR provider_installation_id IS NOT NULL)
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
    policy.required_resume_capability
  INTO policy_row
  FROM services service
  JOIN order_items item ON item.id = service.order_item_id
  JOIN product_service_automation_policies policy ON policy.product_id = item.product_id
  WHERE service.id = NEW.service_id
  FOR UPDATE OF policy;

  IF policy_row IS NULL
     OR NEW.overdue_action_snapshot <> policy_row.overdue_action
     OR NEW.product_policy_version <> policy_row.version
     OR NEW.provider_installation_id IS DISTINCT FROM policy_row.provider_installation_id THEN
    RAISE EXCEPTION 'service Provider binding does not match its explicit product policy';
  END IF;
  IF NEW.overdue_action_snapshot = 'automatic' THEN
    SELECT enabled, capabilities
    INTO provider_row
    FROM provider_installation_capabilities
    WHERE provider_installation_id = NEW.provider_installation_id
    FOR UPDATE;
    IF provider_row IS NULL
       OR NOT provider_row.enabled
       OR NEW.capability_snapshot IS DISTINCT FROM provider_row.capabilities
       OR NOT (provider_row.capabilities ? policy_row.required_suspend_capability)
       OR NOT (provider_row.capabilities ? policy_row.required_resume_capability) THEN
      RAISE EXCEPTION 'automatic service binding lacks approved suspend and resume capabilities';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_provider_bindings_insert_guard ON service_provider_bindings;
CREATE TRIGGER service_provider_bindings_insert_guard
BEFORE INSERT ON service_provider_bindings
FOR EACH ROW EXECUTE FUNCTION opensales_validate_service_provider_binding();

DROP TRIGGER IF EXISTS service_provider_bindings_immutable ON service_provider_bindings;
CREATE TRIGGER service_provider_bindings_immutable
BEFORE UPDATE OR DELETE ON service_provider_bindings
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_period_mutation();

CREATE TABLE IF NOT EXISTS invoice_late_fee_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL UNIQUE REFERENCES invoices(id),
  service_renewal_id uuid NOT NULL UNIQUE REFERENCES service_renewals(id),
  automation_run_id uuid NOT NULL REFERENCES billing_automation_runs(id),
  policy_id text NOT NULL REFERENCES billing_automation_policies(id),
  business_date date NOT NULL,
  effective_at timestamptz NOT NULL,
  timezone text NOT NULL,
  due_business_date date NOT NULL,
  late_fee_days integer NOT NULL CHECK (late_fee_days BETWEEN 1 AND 90),
  eligible_gross_minor bigint NOT NULL CHECK (eligible_gross_minor >= 0),
  payment_allocated_minor bigint NOT NULL CHECK (payment_allocated_minor >= 0),
  credit_allocated_minor bigint NOT NULL CHECK (credit_allocated_minor >= 0),
  allocated_minor bigint NOT NULL CHECK (allocated_minor >= 0),
  basis_minor bigint NOT NULL CHECK (basis_minor >= 0),
  basis_points integer NOT NULL CHECK (basis_points BETWEEN 1 AND 10000),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  disposition text NOT NULL CHECK (disposition IN ('charged', 'skipped_zero')),
  invoice_line_id uuid UNIQUE REFERENCES invoice_lines(id),
  ledger_journal_id uuid UNIQUE REFERENCES ledger_journals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (allocated_minor = payment_allocated_minor + credit_allocated_minor),
  CHECK (
    (disposition = 'charged' AND amount_minor > 0
      AND invoice_line_id IS NOT NULL AND ledger_journal_id IS NOT NULL)
    OR
    (disposition = 'skipped_zero' AND amount_minor = 0
      AND invoice_line_id IS NULL AND ledger_journal_id IS NULL)
  )
);

CREATE OR REPLACE FUNCTION opensales_validate_late_fee_assessment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_row record;
  eligible_minor bigint;
  invoice_line_total_minor bigint;
  payment_minor bigint;
  credit_minor bigint;
  expected_basis bigint;
  expected_amount bigint;
  journal_row record;
BEGIN
  SELECT
    invoice.due_at,
    invoice.currency AS invoice_currency,
    invoice.total_minor AS invoice_total_minor,
    run.policy_id AS run_policy_id,
    run.business_date AS run_business_date,
    run.effective_at AS run_effective_at,
    policy.timezone AS policy_timezone,
    policy.late_fee_enabled,
    policy.late_fee_days AS policy_late_fee_days,
    policy.late_fee_basis_points AS policy_basis_points
  INTO source_row
  FROM service_renewals renewal
  JOIN invoices invoice ON invoice.id = renewal.invoice_id
  JOIN billing_automation_runs run ON run.id = NEW.automation_run_id
  JOIN billing_automation_policies policy ON policy.id = NEW.policy_id
  WHERE renewal.id = NEW.service_renewal_id
    AND renewal.invoice_id = NEW.invoice_id;

  IF source_row IS NULL
     OR source_row.run_policy_id <> NEW.policy_id
     OR source_row.run_business_date <> NEW.business_date
     OR source_row.run_effective_at <> NEW.effective_at
     OR NOT source_row.late_fee_enabled
     OR source_row.policy_timezone <> NEW.timezone
     OR source_row.policy_late_fee_days <> NEW.late_fee_days
     OR source_row.policy_basis_points <> NEW.basis_points
     OR (NEW.effective_at AT TIME ZONE NEW.timezone)::date <> NEW.business_date
     OR (source_row.due_at AT TIME ZONE NEW.timezone)::date <> NEW.due_business_date
     OR NEW.business_date < NEW.due_business_date + NEW.late_fee_days THEN
    RAISE EXCEPTION 'late fee assessment does not match its renewal, policy, or business date';
  END IF;

  SELECT COALESCE(sum(line.amount_minor) FILTER (
           WHERE line.kind IN ('one_time', 'setup', 'recurring', 'tax')
             AND line.amount_minor > 0
         ), 0)::bigint
  INTO eligible_minor
  FROM invoice_lines line
  WHERE line.invoice_id = NEW.invoice_id;

  SELECT COALESCE(sum(line.amount_minor), 0)::bigint
  INTO invoice_line_total_minor
  FROM invoice_lines line
  WHERE line.invoice_id = NEW.invoice_id;

  SELECT allocation.payment_minor, allocation.credit_minor
  INTO payment_minor, credit_minor
  FROM invoice_allocation_totals allocation
  WHERE allocation.invoice_id = NEW.invoice_id;

  expected_basis := GREATEST(eligible_minor - (payment_minor + credit_minor), 0);
  expected_amount := (expected_basis * NEW.basis_points + 5000) / 10000;
  IF NEW.eligible_gross_minor <> eligible_minor
     OR NEW.payment_allocated_minor <> payment_minor
     OR NEW.credit_allocated_minor <> credit_minor
     OR NEW.allocated_minor <> payment_minor + credit_minor
     OR NEW.basis_minor <> expected_basis
     OR NEW.amount_minor <> expected_amount THEN
    RAISE EXCEPTION 'late fee assessment amount does not match invoice facts';
  END IF;
  IF source_row.invoice_total_minor <> invoice_line_total_minor THEN
    RAISE EXCEPTION 'late fee invoice total does not match its immutable lines';
  END IF;

  IF NEW.disposition = 'charged' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM invoice_lines line
      WHERE line.id = NEW.invoice_line_id
        AND line.invoice_id = NEW.invoice_id
        AND line.kind = 'late_fee'
        AND line.amount_minor = NEW.amount_minor
    ) THEN
      RAISE EXCEPTION 'late fee assessment line is inconsistent';
    END IF;

    SELECT
      journal.source_type,
      journal.source_id,
      journal.currency,
      count(line.id)::integer AS line_count,
      COALESCE(sum(line.debit_minor), 0)::bigint AS debit_minor,
      COALESCE(sum(line.credit_minor), 0)::bigint AS credit_minor,
      COALESCE(sum(line.debit_minor) FILTER (
        WHERE line.account_code = 'accounts_receivable'
      ), 0)::bigint AS ar_debit_minor,
      COALESCE(sum(line.credit_minor) FILTER (
        WHERE line.account_code = 'late_fee_revenue'
      ), 0)::bigint AS revenue_credit_minor
    INTO journal_row
    FROM ledger_journals journal
    LEFT JOIN ledger_lines line ON line.journal_id = journal.id
    WHERE journal.id = NEW.ledger_journal_id
    GROUP BY journal.id;

    IF journal_row IS NULL
       OR journal_row.source_type <> 'invoice_late_fee_assessment'
       OR journal_row.source_id <> NEW.id
       OR journal_row.currency <> source_row.invoice_currency
       OR journal_row.line_count <> 2
       OR journal_row.debit_minor <> NEW.amount_minor
       OR journal_row.credit_minor <> NEW.amount_minor
       OR journal_row.ar_debit_minor <> NEW.amount_minor
       OR journal_row.revenue_credit_minor <> NEW.amount_minor THEN
      RAISE EXCEPTION 'late fee assessment journal is inconsistent';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoice_late_fee_assessments_insert_guard
  ON invoice_late_fee_assessments;
CREATE TRIGGER invoice_late_fee_assessments_insert_guard
BEFORE INSERT ON invoice_late_fee_assessments
FOR EACH ROW EXECUTE FUNCTION opensales_validate_late_fee_assessment();

DROP TRIGGER IF EXISTS invoice_late_fee_assessments_immutable
  ON invoice_late_fee_assessments;
CREATE TRIGGER invoice_late_fee_assessments_immutable
BEFORE UPDATE OR DELETE ON invoice_late_fee_assessments
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_period_mutation();

CREATE OR REPLACE FUNCTION opensales_guard_assessed_late_fee_line()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM invoice_late_fee_assessments assessment
    WHERE assessment.invoice_line_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'an assessed late fee line is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoice_lines_assessed_late_fee_immutable ON invoice_lines;
CREATE TRIGGER invoice_lines_assessed_late_fee_immutable
BEFORE UPDATE OR DELETE ON invoice_lines
FOR EACH ROW EXECUTE FUNCTION opensales_guard_assessed_late_fee_line();

-- An unresolved external payment result blocks new delinquency side effects.
-- The immutable snapshot makes the operational hold visible without claiming
-- that the invoice was paid or that the Provider definitely failed.
CREATE TABLE IF NOT EXISTS invoice_delinquency_deferrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  service_renewal_id uuid NOT NULL REFERENCES service_renewals(id),
  automation_run_id uuid NOT NULL REFERENCES billing_automation_runs(id),
  reason text NOT NULL CHECK (reason = 'unsettled_payment_result'),
  pending_payment_snapshot jsonb NOT NULL
    CHECK (jsonb_typeof(pending_payment_snapshot) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (automation_run_id, invoice_id)
);

CREATE OR REPLACE FUNCTION opensales_validate_invoice_delinquency_deferral()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_snapshot jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM service_renewals renewal
    JOIN billing_automation_runs run ON run.id = NEW.automation_run_id
    WHERE renewal.id = NEW.service_renewal_id
      AND renewal.invoice_id = NEW.invoice_id
  ) THEN
    RAISE EXCEPTION 'delinquency deferral does not match its renewal and automation run';
  END IF;
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'paymentAttemptId', attempt.id,
        'status', attempt.status,
        'amountMinor', attempt.amount_minor::text,
        'currency', attempt.currency
      ) ORDER BY attempt.id
    ),
    '[]'::jsonb
  )
  INTO expected_snapshot
  FROM payment_attempts attempt
  WHERE attempt.invoice_id = NEW.invoice_id
    AND attempt.status IN ('created', 'processing', 'unknown');
  IF expected_snapshot = '[]'::jsonb
     OR NEW.pending_payment_snapshot IS DISTINCT FROM expected_snapshot THEN
    RAISE EXCEPTION 'delinquency deferral must snapshot current unresolved payment results';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoice_delinquency_deferrals_insert_guard
  ON invoice_delinquency_deferrals;
CREATE TRIGGER invoice_delinquency_deferrals_insert_guard
BEFORE INSERT ON invoice_delinquency_deferrals
FOR EACH ROW EXECUTE FUNCTION opensales_validate_invoice_delinquency_deferral();

DROP TRIGGER IF EXISTS invoice_delinquency_deferrals_immutable
  ON invoice_delinquency_deferrals;
CREATE TRIGGER invoice_delinquency_deferrals_immutable
BEFORE UPDATE OR DELETE ON invoice_delinquency_deferrals
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_period_mutation();

CREATE TABLE IF NOT EXISTS service_suspension_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES services(id),
  service_renewal_id uuid NOT NULL UNIQUE REFERENCES service_renewals(id),
  invoice_id uuid NOT NULL UNIQUE REFERENCES invoices(id),
  late_fee_assessment_id uuid UNIQUE REFERENCES invoice_late_fee_assessments(id),
  automation_run_id uuid NOT NULL REFERENCES billing_automation_runs(id),
  policy_id text NOT NULL REFERENCES billing_automation_policies(id),
  business_date date NOT NULL,
  effective_at timestamptz NOT NULL,
  timezone text NOT NULL,
  due_business_date date NOT NULL,
  suspension_delay_mode text NOT NULL
    CHECK (suspension_delay_mode IN ('policy_calendar_days', 'exact_hours')),
  suspension_delay_value integer NOT NULL CHECK (suspension_delay_value BETWEEN 1 AND 2160),
  action text NOT NULL CHECK (action IN ('automatic', 'manual', 'none')),
  decision_reason text NOT NULL,
  provider_installation_id text REFERENCES provider_installation_capabilities(provider_installation_id),
  product_policy_snapshot jsonb NOT NULL,
  provider_capability_snapshot jsonb NOT NULL,
  status text NOT NULL CHECK (status IN (
    'suspend_queued',
    'suspend_processing',
    'suspend_unknown',
    'suspended',
    'resume_queued',
    'resume_processing',
    'resume_unknown',
    'resolved',
    'manual'
  )),
  resume_required boolean NOT NULL DEFAULT false,
  provider_occurred_at timestamptz,
  last_error text,
  resolved_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (action <> 'automatic' OR provider_installation_id IS NOT NULL),
  CHECK (action <> 'none' OR status = 'resolved'),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION opensales_validate_service_suspension_case_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_row record;
  expected_action text;
BEGIN
  SELECT
    renewal.service_id,
    renewal.invoice_id,
    service.status AS service_status,
    invoice.due_at,
    run.policy_id AS run_policy_id,
    run.business_date AS run_business_date,
    run.effective_at AS run_effective_at,
    policy.timezone AS policy_timezone,
    policy.overdue_suspension_enabled,
    policy.overdue_suspension_days,
    COALESCE(product_policy.overdue_delay_mode, 'policy_calendar_days')
      AS suspension_delay_mode,
    COALESCE(product_policy.overdue_delay_value, policy.overdue_suspension_days)
      AS suspension_delay_value,
    product_policy.overdue_action AS product_action,
    product_policy.provider_installation_id AS product_provider_installation_id,
    product_policy.required_suspend_capability,
    product_policy.required_resume_capability,
    product_policy.version AS product_policy_version,
    binding.overdue_action_snapshot AS binding_action,
    binding.provider_installation_id AS binding_provider_installation_id,
    binding.capability_snapshot AS binding_capabilities,
    binding.product_policy_version AS binding_product_policy_version,
    provider.enabled AS provider_enabled,
    provider.capabilities AS provider_capabilities,
    provider.version AS provider_version
  INTO source_row
  FROM service_renewals renewal
  JOIN invoices invoice ON invoice.id = renewal.invoice_id
  JOIN services service ON service.id = renewal.service_id
  JOIN order_items item ON item.id = service.order_item_id
  JOIN billing_automation_runs run ON run.id = NEW.automation_run_id
  JOIN billing_automation_policies policy ON policy.id = NEW.policy_id
  LEFT JOIN product_service_automation_policies product_policy
    ON product_policy.product_id = item.product_id
  LEFT JOIN service_provider_bindings binding ON binding.service_id = service.id
  LEFT JOIN provider_installation_capabilities provider
    ON provider.provider_installation_id = binding.provider_installation_id
  WHERE renewal.id = NEW.service_renewal_id;

  IF source_row IS NULL
     OR source_row.service_id <> NEW.service_id
     OR source_row.invoice_id <> NEW.invoice_id
     OR source_row.run_policy_id <> NEW.policy_id
     OR source_row.run_business_date <> NEW.business_date
     OR source_row.run_effective_at <> NEW.effective_at
     OR source_row.policy_timezone <> NEW.timezone
     OR source_row.suspension_delay_mode <> NEW.suspension_delay_mode
     OR source_row.suspension_delay_value <> NEW.suspension_delay_value
     OR (NEW.effective_at AT TIME ZONE NEW.timezone)::date <> NEW.business_date
     OR (source_row.due_at AT TIME ZONE NEW.timezone)::date <> NEW.due_business_date
     OR NOT (
       (
         NEW.suspension_delay_mode = 'policy_calendar_days'
         AND NEW.business_date >= NEW.due_business_date + NEW.suspension_delay_value
       )
       OR (
         NEW.suspension_delay_mode = 'exact_hours'
         AND NEW.effective_at >= source_row.due_at
             + make_interval(hours => NEW.suspension_delay_value)
       )
     ) THEN
    RAISE EXCEPTION 'service suspension case does not match its renewal, policy, or business date';
  END IF;

  expected_action := CASE
    WHEN NOT source_row.overdue_suspension_enabled THEN 'none'
    WHEN source_row.product_action IS NULL THEN 'none'
    WHEN source_row.product_action = 'none' OR source_row.binding_action = 'none' THEN 'none'
    WHEN source_row.service_status <> 'active' THEN 'manual'
    WHEN source_row.product_action = 'manual' OR source_row.binding_action = 'manual' THEN 'manual'
    WHEN source_row.product_provider_installation_id IS NULL
      OR source_row.binding_provider_installation_id IS NULL
      OR source_row.binding_action <> 'automatic' THEN 'manual'
    WHEN source_row.product_provider_installation_id <>
         source_row.binding_provider_installation_id THEN 'manual'
    WHEN NOT (source_row.binding_capabilities ? source_row.required_suspend_capability)
      OR NOT (source_row.binding_capabilities ? source_row.required_resume_capability) THEN 'manual'
    WHEN NOT COALESCE(source_row.provider_enabled, false) THEN 'manual'
    WHEN NOT (source_row.provider_capabilities ? source_row.required_suspend_capability)
      OR NOT (source_row.provider_capabilities ? source_row.required_resume_capability) THEN 'manual'
    ELSE 'automatic'
  END;
  IF NEW.action <> expected_action
     OR NEW.product_policy_snapshot->>'overdueAction'
          IS DISTINCT FROM source_row.product_action
     OR NEW.product_policy_snapshot->>'providerInstallationId'
          IS DISTINCT FROM source_row.product_provider_installation_id
     OR NEW.product_policy_snapshot->>'overdueDelayMode'
          IS DISTINCT FROM source_row.suspension_delay_mode
     OR NEW.product_policy_snapshot->>'overdueDelayValue'
          IS DISTINCT FROM source_row.suspension_delay_value::text
     OR NEW.product_policy_snapshot->>'requiredSuspendCapability'
          IS DISTINCT FROM source_row.required_suspend_capability
     OR NEW.product_policy_snapshot->>'requiredResumeCapability'
          IS DISTINCT FROM source_row.required_resume_capability
     OR NEW.product_policy_snapshot->>'version'
          IS DISTINCT FROM source_row.product_policy_version::text
     OR NEW.product_policy_snapshot->>'bindingOverdueAction'
          IS DISTINCT FROM source_row.binding_action
     OR NEW.product_policy_snapshot->>'bindingProductPolicyVersion'
          IS DISTINCT FROM source_row.binding_product_policy_version::text
     OR NEW.provider_capability_snapshot->>'providerInstallationId'
          IS DISTINCT FROM source_row.binding_provider_installation_id
     OR NEW.provider_capability_snapshot->>'enabled'
          IS DISTINCT FROM source_row.provider_enabled::text
     OR COALESCE(NEW.provider_capability_snapshot->'capabilitiesAtBinding', '[]'::jsonb)
          IS DISTINCT FROM COALESCE(source_row.binding_capabilities, '[]'::jsonb)
     OR COALESCE(NEW.provider_capability_snapshot->'currentCapabilities', '[]'::jsonb)
          IS DISTINCT FROM COALESCE(source_row.provider_capabilities, '[]'::jsonb)
     OR NEW.provider_capability_snapshot->>'currentVersion'
          IS DISTINCT FROM source_row.provider_version::text
     OR (
       NEW.action = 'automatic'
       AND (
         NEW.provider_installation_id IS DISTINCT FROM
           source_row.binding_provider_installation_id
         OR source_row.binding_provider_installation_id IS DISTINCT FROM
           source_row.product_provider_installation_id
         OR NOT COALESCE(source_row.provider_enabled, false)
       )
     ) THEN
    RAISE EXCEPTION 'service suspension decision or capability snapshots are inconsistent';
  END IF;
  IF NEW.late_fee_assessment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM invoice_late_fee_assessments assessment
    WHERE assessment.id = NEW.late_fee_assessment_id
      AND assessment.invoice_id = NEW.invoice_id
      AND assessment.service_renewal_id = NEW.service_renewal_id
  ) THEN
    RAISE EXCEPTION 'service suspension case late fee assessment is inconsistent';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_suspension_cases_insert_guard ON service_suspension_cases;
CREATE TRIGGER service_suspension_cases_insert_guard
BEFORE INSERT ON service_suspension_cases
FOR EACH ROW EXECUTE FUNCTION opensales_validate_service_suspension_case_insert();

CREATE OR REPLACE FUNCTION opensales_guard_service_suspension_case_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  transition_allowed boolean := false;
BEGIN
  IF NEW.service_id IS DISTINCT FROM OLD.service_id
     OR NEW.service_renewal_id IS DISTINCT FROM OLD.service_renewal_id
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.late_fee_assessment_id IS DISTINCT FROM OLD.late_fee_assessment_id
     OR NEW.automation_run_id IS DISTINCT FROM OLD.automation_run_id
     OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
     OR NEW.business_date IS DISTINCT FROM OLD.business_date
     OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
     OR NEW.timezone IS DISTINCT FROM OLD.timezone
     OR NEW.due_business_date IS DISTINCT FROM OLD.due_business_date
     OR NEW.suspension_delay_mode IS DISTINCT FROM OLD.suspension_delay_mode
     OR NEW.suspension_delay_value IS DISTINCT FROM OLD.suspension_delay_value
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason
     OR NEW.provider_installation_id IS DISTINCT FROM OLD.provider_installation_id
     OR NEW.product_policy_snapshot IS DISTINCT FROM OLD.product_policy_snapshot
     OR NEW.provider_capability_snapshot IS DISTINCT FROM OLD.provider_capability_snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'service suspension case business identity is immutable';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'service suspension case version must advance exactly once';
  END IF;
  IF OLD.provider_occurred_at IS NOT NULL
     AND NEW.provider_occurred_at IS DISTINCT FROM OLD.provider_occurred_at
     AND (NEW.provider_occurred_at IS NULL OR NEW.provider_occurred_at < OLD.provider_occurred_at) THEN
    RAISE EXCEPTION 'service suspension case Provider time cannot move backwards';
  END IF;

  transition_allowed := NEW.status = OLD.status OR CASE OLD.status
    WHEN 'suspend_queued' THEN NEW.status IN (
      'suspend_processing', 'suspend_unknown', 'suspended', 'resolved', 'manual'
    )
    WHEN 'suspend_processing' THEN NEW.status IN ('suspend_unknown', 'suspended', 'manual')
    WHEN 'suspend_unknown' THEN NEW.status IN ('suspended', 'resolved', 'manual')
    WHEN 'suspended' THEN NEW.status IN ('resume_queued', 'manual')
    WHEN 'resume_queued' THEN NEW.status IN (
      'resume_processing', 'resume_unknown', 'resolved', 'manual'
    )
    WHEN 'resume_processing' THEN NEW.status IN ('resume_unknown', 'resolved', 'manual')
    WHEN 'resume_unknown' THEN NEW.status IN ('resolved', 'manual')
    WHEN 'manual' THEN NEW.status IN ('suspend_queued', 'suspended', 'resume_queued', 'resolved')
    WHEN 'resolved' THEN false
    ELSE false
  END;
  IF NOT transition_allowed THEN
    RAISE EXCEPTION 'service suspension case status transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_suspension_cases_update_guard ON service_suspension_cases;
CREATE TRIGGER service_suspension_cases_update_guard
BEFORE UPDATE ON service_suspension_cases
FOR EACH ROW EXECUTE FUNCTION opensales_guard_service_suspension_case_update();

DROP TRIGGER IF EXISTS service_suspension_cases_delete_rejected ON service_suspension_cases;
CREATE TRIGGER service_suspension_cases_delete_rejected
BEFORE DELETE ON service_suspension_cases
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_period_mutation();

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
      'resource_resume'
    )
  );

CREATE INDEX IF NOT EXISTS invoice_late_fee_assessments_created_idx
  ON invoice_late_fee_assessments(created_at, invoice_id);
CREATE INDEX IF NOT EXISTS invoice_delinquency_deferrals_invoice_created_idx
  ON invoice_delinquency_deferrals(invoice_id, created_at DESC);
CREATE INDEX IF NOT EXISTS service_suspension_cases_status_created_idx
  ON service_suspension_cases(status, created_at, id);
CREATE INDEX IF NOT EXISTS service_suspension_cases_service_created_idx
  ON service_suspension_cases(service_id, created_at DESC);
CREATE INDEX IF NOT EXISTS provider_operations_suspension_case_idx
  ON provider_operations(subject_id, kind, created_at)
  WHERE subject_type = 'service_suspension_case'
    AND kind IN ('resource_suspend', 'resource_resume');
