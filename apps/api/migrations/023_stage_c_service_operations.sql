-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Service daily operations are deliberately independent from the commercial
-- Service lifecycle.  In particular, stopping a resource does not manufacture
-- a billing suspension and starting one cannot clear an overdue suspension.

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
      'resource_terminate',
      'resource.start',
      'resource.stop',
      'resource.reboot'
    )
  );

CREATE TABLE service_resource_state_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES services(id),
  operation_request_id uuid,
  provider_operation_id uuid REFERENCES provider_operations(id),
  resource_revision integer NOT NULL CHECK (resource_revision > 0),
  state text NOT NULL CHECK (state IN ('running', 'stopped', 'terminated')),
  source text NOT NULL CHECK (
    source IN ('migration_snapshot', 'commercial_lifecycle', 'daily_operation')
  ),
  cause text NOT NULL CHECK (char_length(cause) BETWEEN 3 AND 100),
  observed_at timestamptz NOT NULL,
  creation_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_id, resource_revision),
  UNIQUE (operation_request_id)
);

CREATE INDEX service_resource_state_facts_latest_idx
  ON service_resource_state_facts(service_id, resource_revision DESC);

INSERT INTO service_resource_state_facts(
  service_id, resource_revision, state, source, cause, observed_at
)
SELECT service.id,
       1,
       CASE service.status
         WHEN 'suspended' THEN 'stopped'
         WHEN 'terminated' THEN 'terminated'
         ELSE 'running'
       END,
       'migration_snapshot',
       'schema.023.backfill',
       COALESCE(service.updated_at, service.activated_at, service.created_at)
FROM services service
WHERE service.status IN ('active', 'suspended', 'terminated')
ON CONFLICT (service_id, resource_revision) DO NOTHING;

CREATE TABLE service_resource_desired_state_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES services(id),
  operation_request_id uuid,
  desired_revision integer NOT NULL CHECK (desired_revision > 0),
  state text NOT NULL CHECK (state IN ('running', 'stopped', 'terminated')),
  source text NOT NULL CHECK (
    source IN ('migration_snapshot', 'commercial_lifecycle', 'daily_operation')
  ),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  creation_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_id, desired_revision),
  UNIQUE (operation_request_id)
);

CREATE INDEX service_resource_desired_state_facts_latest_idx
  ON service_resource_desired_state_facts(service_id, desired_revision DESC);

-- Existing overdue suspensions were initiated by billing automation, not by a
-- customer power command.  Their desired state therefore remains running.
INSERT INTO service_resource_desired_state_facts(
  service_id, desired_revision, state, source, recorded_at
)
SELECT service.id,
       1,
       CASE WHEN service.status = 'terminated' THEN 'terminated' ELSE 'running' END,
       'migration_snapshot',
       COALESCE(service.updated_at, service.activated_at, service.created_at)
FROM services service
WHERE service.status IN ('active', 'suspended', 'terminated')
ON CONFLICT (service_id, desired_revision) DO NOTHING;

CREATE TABLE service_resource_operation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES services(id),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'staff')),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  actor_session_id uuid NOT NULL REFERENCES sessions(id),
  action text NOT NULL CHECK (action IN ('start', 'stop', 'reboot')),
  expected_service_version integer NOT NULL CHECK (expected_service_version > 0),
  expected_resource_revision integer NOT NULL CHECK (expected_resource_revision >= 0),
  execution_mode text NOT NULL CHECK (execution_mode IN ('automatic', 'manual')),
  provider_installation_id text
    REFERENCES provider_installation_capabilities(provider_installation_id),
  provider_capability_snapshot jsonb NOT NULL
    CHECK (jsonb_typeof(provider_capability_snapshot) = 'object'),
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 3 AND 1000),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  creation_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_type, actor_user_id, idempotency_key),
  CHECK (
    (execution_mode = 'automatic' AND provider_installation_id IS NOT NULL)
    OR (execution_mode = 'manual' AND provider_installation_id IS NULL)
  ),
  CHECK ((actor_type = 'staff') = (reason IS NOT NULL))
);

ALTER TABLE service_resource_state_facts
  ADD CONSTRAINT service_resource_state_facts_operation_request_fkey
  FOREIGN KEY (operation_request_id)
  REFERENCES service_resource_operation_requests(id);

ALTER TABLE service_resource_desired_state_facts
  ADD CONSTRAINT service_resource_desired_state_facts_operation_request_fkey
  FOREIGN KEY (operation_request_id)
  REFERENCES service_resource_operation_requests(id);

CREATE INDEX service_resource_operation_requests_service_created_idx
  ON service_resource_operation_requests(service_id, created_at DESC, id DESC);
CREATE INDEX service_resource_operation_requests_account_created_idx
  ON service_resource_operation_requests(client_account_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX provider_operations_service_resource_request_uidx
  ON provider_operations(subject_id)
  WHERE subject_type = 'service_resource_operation';

CREATE TABLE service_resource_operation_attempt_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES service_resource_operation_requests(id),
  provider_operation_id uuid REFERENCES provider_operations(id),
  durable_job_id uuid REFERENCES durable_jobs(id),
  durable_job_attempts integer CHECK (durable_job_attempts > 0),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  attempt_kind text NOT NULL CHECK (attempt_kind IN ('mutation', 'reconcile_query', 'manual')),
  actor_id text NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 200),
  started_at timestamptz NOT NULL,
  creation_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, attempt_number),
  UNIQUE (durable_job_id, durable_job_attempts, attempt_kind),
  CHECK (
    (attempt_kind = 'manual' AND durable_job_id IS NULL AND durable_job_attempts IS NULL)
    OR
    (attempt_kind IN ('mutation', 'reconcile_query')
     AND durable_job_id IS NOT NULL AND durable_job_attempts IS NOT NULL)
  )
);

CREATE TABLE service_resource_operation_result_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES service_resource_operation_requests(id),
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('running', 'unknown', 'manual', 'succeeded', 'failed')),
  resource_state text CHECK (resource_state IN ('running', 'stopped')),
  provider_occurred_at timestamptz,
  error_code text CHECK (error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 100),
  detail text CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 1000),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  creation_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, revision),
  CHECK (
    (status = 'succeeded' AND resource_state IS NOT NULL AND error_code IS NULL)
    OR (status <> 'succeeded' AND resource_state IS NULL)
  ),
  CHECK ((status IN ('failed', 'manual', 'unknown')) = (detail IS NOT NULL))
);

CREATE INDEX service_resource_operation_results_latest_idx
  ON service_resource_operation_result_facts(request_id, revision DESC);

CREATE TABLE service_resource_operation_manual_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES service_resource_operation_requests(id),
  service_id uuid NOT NULL REFERENCES services(id),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  staff_user_id uuid NOT NULL REFERENCES staff_members(user_id),
  staff_session_id uuid NOT NULL REFERENCES sessions(id),
  expected_service_version integer NOT NULL CHECK (expected_service_version > 0),
  expected_resource_revision integer NOT NULL CHECK (expected_resource_revision >= 0),
  expected_desired_revision integer NOT NULL CHECK (expected_desired_revision >= 0),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 1000),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  creation_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_user_id, idempotency_key)
);

CREATE TABLE service_operation_job_transition_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES durable_jobs(id),
  request_id uuid NOT NULL REFERENCES service_resource_operation_requests(id),
  from_status text NOT NULL CHECK (from_status = 'running'),
  to_status text NOT NULL CHECK (to_status IN ('completed', 'manual')),
  job_attempts integer NOT NULL CHECK (job_attempts > 0),
  worker_id text NOT NULL CHECK (char_length(worker_id) BETWEEN 1 AND 200),
  creation_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, to_status, job_attempts)
);

CREATE OR REPLACE FUNCTION opensales_reject_service_operation_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'service operation facts are append-only';
END;
$$;

CREATE OR REPLACE FUNCTION opensales_service_operation_request_fingerprint(
  scope text,
  input jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT pg_catalog.encode(
    public.digest(
      pg_catalog.convert_to(scope, 'UTF8') ||
      pg_catalog.decode('00', 'hex') ||
      pg_catalog.convert_to(
        public.opensales_canonical_notification_jsonb(input),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

CREATE OR REPLACE FUNCTION opensales_validate_service_operation_request()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  service_row record;
  state_row record;
  binding_row record;
  provider_row record;
  required_capability text;
  automatic_eligible boolean := false;
  open_request_id uuid;
  active_client_account_id_value uuid;
  order_item_id_value uuid;
  actor_allowed boolean := false;
BEGIN
  NEW.creation_transaction_id := txid_current();

  IF NEW.request_fingerprint IS DISTINCT FROM
       public.opensales_service_operation_request_fingerprint(
         CASE NEW.actor_type
           WHEN 'user' THEN 'services.daily-operation:v1'
           ELSE 'admin.services.daily-operation:v1'
         END,
         CASE NEW.actor_type
           WHEN 'user' THEN pg_catalog.jsonb_build_object(
             'serviceId', NEW.service_id::text,
             'action', NEW.action,
             'expectedServiceVersion', NEW.expected_service_version,
             'expectedResourceRevision', NEW.expected_resource_revision
           )
           ELSE pg_catalog.jsonb_build_object(
             'clientAccountId', NEW.client_account_id::text,
             'serviceId', NEW.service_id::text,
             'action', NEW.action,
             'expectedServiceVersion', NEW.expected_service_version,
             'expectedResourceRevision', NEW.expected_resource_revision,
             'reason', NEW.reason
           )
         END
       ) THEN
    RAISE EXCEPTION 'service operation request fingerprint does not match its immutable intent';
  END IF;

  SELECT email_verified_at IS NOT NULL AND restricted_at IS NULL
  INTO actor_allowed
  FROM users
  WHERE id = NEW.actor_user_id
  FOR UPDATE;
  IF actor_allowed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'service operation actor identity is not eligible';
  END IF;
  SELECT active_client_account_id
  INTO active_client_account_id_value
  FROM sessions
  WHERE id = NEW.actor_session_id
    AND user_id = NEW.actor_user_id
    AND revoked_at IS NULL
    AND expires_at > pg_catalog.clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'service operation actor session is not active';
  END IF;

  IF NEW.actor_type = 'user' THEN
    SELECT restricted_at IS NULL
    INTO actor_allowed
    FROM client_accounts
    WHERE id = NEW.client_account_id
    FOR UPDATE;
    IF actor_allowed AND active_client_account_id_value = NEW.client_account_id THEN
      SELECT removed_at IS NULL
             AND restricted_at IS NULL
             AND (
               role IN ('owner', 'technical')
               OR permissions ? '*'
               OR permissions ? 'services.manage'
             )
      INTO actor_allowed
      FROM client_memberships
      WHERE client_account_id = NEW.client_account_id
        AND user_id = NEW.actor_user_id
      FOR UPDATE;
    ELSE
      actor_allowed := false;
    END IF;
  ELSE
    SELECT active
           AND (permissions ? '*' OR permissions ? 'services.operations_manage')
    INTO actor_allowed
    FROM staff_members
    WHERE user_id = NEW.actor_user_id
    FOR UPDATE;
    IF actor_allowed THEN
      PERFORM 1
      FROM reauth_grants
      WHERE user_id = NEW.actor_user_id
        AND session_id = NEW.actor_session_id
        AND invalidated_at IS NULL
        AND expires_at > pg_catalog.clock_timestamp()
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      FOR UPDATE;
      actor_allowed := FOUND;
    END IF;
  END IF;
  IF actor_allowed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'service operation actor is not currently authorized';
  END IF;

  PERFORM 1 FROM client_accounts WHERE id = NEW.client_account_id FOR UPDATE;
  SELECT order_item_id
  INTO order_item_id_value
  FROM services
  WHERE id = NEW.service_id;
  PERFORM 1 FROM order_items WHERE id = order_item_id_value FOR UPDATE;
  SELECT service.client_account_id, service.status, service.version,
         service.external_resource_id, service.cancellation_effective_at
  INTO service_row
  FROM services service
  WHERE service.id = NEW.service_id
  FOR UPDATE;
  IF service_row IS NULL
     OR service_row.client_account_id <> NEW.client_account_id
     OR service_row.status <> 'active'
     OR service_row.version <> NEW.expected_service_version
     OR (
       service_row.cancellation_effective_at IS NOT NULL
       AND service_row.cancellation_effective_at <= pg_catalog.clock_timestamp()
     ) THEN
    RAISE EXCEPTION 'service operation request does not match an active owned service version';
  END IF;

  SELECT resource_revision, state
  INTO state_row
  FROM service_resource_state_facts
  WHERE service_id = NEW.service_id
  ORDER BY resource_revision DESC
  LIMIT 1;
  IF COALESCE(state_row.resource_revision, 0) <> NEW.expected_resource_revision
     OR (NEW.action = 'start' AND state_row.state IS DISTINCT FROM 'stopped')
     OR (NEW.action IN ('stop', 'reboot') AND state_row.state IS DISTINCT FROM 'running') THEN
    RAISE EXCEPTION 'service resource state changed or does not allow the requested action';
  END IF;

  SELECT request.id
  INTO open_request_id
  FROM service_resource_operation_requests request
  LEFT JOIN LATERAL (
    SELECT result.status
    FROM service_resource_operation_result_facts result
    WHERE result.request_id = request.id
    ORDER BY result.revision DESC
    LIMIT 1
  ) latest ON true
  WHERE request.service_id = NEW.service_id
    AND COALESCE(latest.status, 'queued') NOT IN ('succeeded', 'failed')
  ORDER BY request.created_at DESC
  LIMIT 1;
  IF open_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'service already has an unresolved daily operation';
  END IF;

  required_capability := 'resource.' || NEW.action;
  SELECT binding.provider_installation_id, binding.capability_snapshot
  INTO binding_row
  FROM service_provider_bindings binding
  WHERE binding.service_id = NEW.service_id
  FOR UPDATE;
  IF binding_row.provider_installation_id IS NOT NULL THEN
    SELECT provider.enabled, provider.capabilities, provider.version
    INTO provider_row
    FROM provider_installation_capabilities provider
    WHERE provider.provider_installation_id = binding_row.provider_installation_id
    FOR UPDATE;
    automatic_eligible := FOUND
      AND binding_row.provider_installation_id = 'mock-provisioning-v1'
      AND provider_row.enabled
      AND service_row.external_resource_id IS NOT NULL
      AND binding_row.capability_snapshot ? required_capability
      AND provider_row.capabilities ? required_capability;
  END IF;

  IF NEW.execution_mode = 'automatic' THEN
    IF NOT automatic_eligible
       OR NEW.provider_installation_id IS DISTINCT FROM binding_row.provider_installation_id
       OR NEW.provider_capability_snapshot IS DISTINCT FROM jsonb_build_object(
         'atBinding', binding_row.capability_snapshot,
         'current', provider_row.capabilities,
         'currentVersion', provider_row.version
       ) THEN
      RAISE EXCEPTION 'automatic service operation lacks matching approved Mock Provider capability';
    END IF;
  ELSIF NEW.provider_capability_snapshot <> '{}'::jsonb THEN
    RAISE EXCEPTION 'manual service operation cannot claim Provider capability';
  ELSIF automatic_eligible THEN
    RAISE EXCEPTION 'manual service operation cannot downgrade available Mock Provider capability';
  END IF;

  -- Row locks serialize revocation and permission changes, but they do not
  -- freeze wall-clock expiry. Re-evaluate the exact actor authority after all
  -- account, Service, binding, and Provider locks have been acquired.
  IF NEW.actor_type = 'user' THEN
    SELECT EXISTS (
      SELECT 1
      FROM users user_record
      JOIN sessions session_record
        ON session_record.id = NEW.actor_session_id
       AND session_record.user_id = user_record.id
      JOIN client_accounts account
        ON account.id = NEW.client_account_id
      JOIN client_memberships membership
        ON membership.client_account_id = account.id
       AND membership.user_id = user_record.id
      WHERE user_record.id = NEW.actor_user_id
        AND user_record.email_verified_at IS NOT NULL
        AND user_record.restricted_at IS NULL
        AND session_record.revoked_at IS NULL
        AND session_record.expires_at > pg_catalog.clock_timestamp()
        AND session_record.active_client_account_id = account.id
        AND account.restricted_at IS NULL
        AND membership.removed_at IS NULL
        AND membership.restricted_at IS NULL
        AND (
          membership.role IN ('owner', 'technical')
          OR membership.permissions ? '*'
          OR membership.permissions ? 'services.manage'
        )
    ) INTO actor_allowed;
  ELSE
    SELECT EXISTS (
      SELECT 1
      FROM users user_record
      JOIN sessions session_record
        ON session_record.id = NEW.actor_session_id
       AND session_record.user_id = user_record.id
      JOIN staff_members staff
        ON staff.user_id = user_record.id
      WHERE user_record.id = NEW.actor_user_id
        AND user_record.email_verified_at IS NOT NULL
        AND user_record.restricted_at IS NULL
        AND session_record.revoked_at IS NULL
        AND session_record.expires_at > pg_catalog.clock_timestamp()
        AND staff.active
        AND (staff.permissions ? '*' OR staff.permissions ? 'services.operations_manage')
        AND EXISTS (
          SELECT 1
          FROM reauth_grants reauth
          WHERE reauth.user_id = user_record.id
            AND reauth.session_id = session_record.id
            AND reauth.invalidated_at IS NULL
            AND reauth.expires_at > pg_catalog.clock_timestamp()
        )
    ) INTO actor_allowed;
  END IF;
  IF actor_allowed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'service operation actor authorization expired while acquiring business locks';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_guard_service_resource_provider_operation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  latest_result record;
  attempt_projection record;
  expected_external_reference text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.subject_type = 'service_resource_operation' THEN
      RAISE EXCEPTION 'service resource Provider operations cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (OLD.subject_type = 'service_resource_operation'
          OR NEW.subject_type = 'service_resource_operation')
     AND (
       NEW.provider_installation_id IS DISTINCT FROM OLD.provider_installation_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
       OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
       OR NEW.stable_key IS DISTINCT FROM OLD.stable_key
     ) THEN
    RAISE EXCEPTION 'service resource Provider operation identity is immutable';
  END IF;
  IF NEW.subject_type = 'service_resource_operation' THEN
    SELECT service.external_resource_id
    INTO expected_external_reference
    FROM public.service_resource_operation_requests request
    JOIN public.services service ON service.id = request.service_id
    WHERE request.id = NEW.subject_id;
    IF NOT EXISTS (
      SELECT 1
      FROM service_resource_operation_requests request
      WHERE request.id = NEW.subject_id
        AND request.execution_mode = 'automatic'
        AND request.provider_installation_id = NEW.provider_installation_id
        AND NEW.kind = 'resource.' || request.action
        AND NEW.stable_key = 'service-operation:' || request.id::text || ':' || request.action
    ) THEN
      RAISE EXCEPTION 'service resource Provider operation does not match its request';
    END IF;

    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> 'queued'
         OR NEW.attempt_count <> 0
         OR NEW.last_error IS NOT NULL
         OR NEW.external_reference IS NOT NULL THEN
        RAISE EXCEPTION 'service resource Provider operation must start queued and pristine';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD.status IN ('succeeded', 'failed') THEN
      RAISE EXCEPTION 'terminal service resource Provider operation is immutable';
    END IF;
    IF NEW.status = OLD.status
       OR (OLD.status = 'queued' AND NEW.status NOT IN ('running', 'failed'))
       OR (OLD.status = 'running' AND NEW.status NOT IN ('unknown', 'succeeded', 'failed'))
       OR (OLD.status = 'unknown' AND NEW.status NOT IN ('succeeded', 'failed')) THEN
      RAISE EXCEPTION 'service resource Provider operation transition is invalid';
    END IF;
    IF (OLD.status = 'queued' AND NEW.status = 'running'
        AND (OLD.attempt_count <> 0 OR NEW.attempt_count <> 1))
       OR (NOT (OLD.status = 'queued' AND NEW.status = 'running')
           AND NEW.attempt_count IS DISTINCT FROM OLD.attempt_count)
       OR NEW.attempt_count NOT IN (0, 1) THEN
      RAISE EXCEPTION 'service resource Provider mutation count may advance from zero to one exactly once';
    END IF;

    SELECT result.status, result.creation_transaction_id,
           result.evidence, result.error_code
    INTO latest_result
    FROM service_resource_operation_result_facts result
    WHERE result.request_id = NEW.subject_id
    ORDER BY result.revision DESC
    LIMIT 1;
    SELECT count(*)::integer AS total_count,
           count(*) FILTER (WHERE attempt.attempt_kind = 'mutation')::integer AS mutation_count,
           max(attempt.attempt_number)::integer AS latest_attempt_number
    INTO attempt_projection
    FROM service_resource_operation_attempt_facts attempt
    WHERE attempt.request_id = NEW.subject_id
      AND attempt.provider_operation_id = NEW.id;

    IF latest_result IS NULL
       OR latest_result.creation_transaction_id <> txid_current()
       OR (NEW.status = 'running' AND latest_result.status <> 'running')
       OR (NEW.status = 'unknown' AND latest_result.status NOT IN ('unknown', 'manual'))
       OR (NEW.status = 'failed' AND latest_result.status <> 'failed')
       OR (NEW.status = 'succeeded' AND latest_result.status NOT IN ('succeeded', 'manual')) THEN
      RAISE EXCEPTION 'service resource Provider status must project the latest same-transaction result fact';
    END IF;
    IF NEW.attempt_count = 1 AND (
         attempt_projection.mutation_count <> 1
         OR attempt_projection.total_count < 1
         OR attempt_projection.latest_attempt_number <> attempt_projection.total_count
       ) THEN
      RAISE EXCEPTION 'service resource Provider operation does not match its contiguous attempt facts';
    END IF;
    IF NEW.attempt_count = 0 AND (
         attempt_projection.total_count <> 0
         OR NEW.status <> 'failed'
         OR latest_result.error_code <> 'dispatch_preflight_rejected'
         OR latest_result.evidence ->> 'providerCalled' <> 'false'
       ) THEN
      RAISE EXCEPTION 'zero-attempt Provider failure must be a dispatch preflight rejection';
    END IF;
    IF NEW.status IN ('queued', 'running', 'unknown', 'failed')
       AND NEW.external_reference IS NOT NULL THEN
      RAISE EXCEPTION 'non-successful service resource Provider operation cannot claim an external reference';
    END IF;
    IF NEW.status = 'succeeded' AND (
         NEW.external_reference IS NULL
         OR NEW.external_reference IS DISTINCT FROM expected_external_reference
         OR (latest_result.status = 'succeeded' AND NEW.last_error IS NOT NULL)
         OR (latest_result.status = 'manual' AND NEW.last_error IS NULL)
       ) THEN
      RAISE EXCEPTION 'successful Provider operation projection is incomplete';
    END IF;
    IF NEW.status IN ('unknown', 'failed') AND NEW.last_error IS NULL THEN
      RAISE EXCEPTION 'unknown or failed Provider operation requires a bounded error';
    END IF;
    IF NEW.status = 'running' AND (
         NEW.last_error IS NOT NULL OR NEW.external_reference IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'running Provider operation must remain free of terminal projection fields';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_check_service_operation_job_transition_commit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_row record;
BEGIN
  SELECT status, attempts, locked_at, locked_by, last_error, updated_at
  INTO job_row
  FROM public.durable_jobs
  WHERE id = NEW.job_id;
  IF job_row IS NULL
     OR job_row.status IS DISTINCT FROM NEW.to_status
     OR job_row.attempts IS DISTINCT FROM NEW.job_attempts
     OR job_row.locked_at IS NOT NULL
     OR job_row.locked_by IS NOT NULL
     OR (NEW.to_status = 'completed' AND job_row.last_error IS NOT NULL)
     OR (NEW.to_status = 'manual' AND job_row.last_error IS NULL)
     OR NEW.creation_transaction_id <> txid_current() THEN
    RAISE EXCEPTION 'service operation job transition fact must atomically pair its exact terminal job projection';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_check_service_operation_result_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_row record;
  latest_revision_value integer;
  authority_count integer;
BEGIN
  SELECT request.execution_mode, request.service_id
  INTO request_row
  FROM public.service_resource_operation_requests request
  WHERE request.id = NEW.request_id;
  IF request_row IS NULL OR request_row.execution_mode = 'manual' THEN
    RETURN NULL;
  END IF;

  SELECT max(result.revision)
  INTO latest_revision_value
  FROM public.service_resource_operation_result_facts result
  WHERE result.request_id = NEW.request_id;
  -- A later result inserted in this transaction owns the terminal authority
  -- check; the later row has its own deferred trigger invocation.
  IF latest_revision_value > NEW.revision THEN
    RETURN NULL;
  END IF;

  IF NEW.status = 'running' THEN
    SELECT count(*)::integer
    INTO authority_count
    FROM public.provider_operations operation
    JOIN public.service_resource_operation_attempt_facts attempt
      ON attempt.request_id = NEW.request_id
     AND attempt.provider_operation_id = operation.id
     AND attempt.attempt_kind = 'mutation'
     AND attempt.creation_transaction_id = NEW.creation_transaction_id
    JOIN public.durable_jobs job
      ON job.id = attempt.durable_job_id
     AND job.attempts = attempt.durable_job_attempts
     AND job.job_type = 'service.operation.start'
     AND job.unique_key = 'service-operation:' || NEW.request_id::text || ':start'
     AND job.payload = pg_catalog.jsonb_build_object(
       'requestId', NEW.request_id::text,
       'serviceId', request_row.service_id::text,
       'providerOperationId', operation.id::text
     )
     AND job.status = 'running'
     AND job.locked_at IS NOT NULL
     AND job.locked_by = attempt.actor_id
    WHERE operation.subject_type = 'service_resource_operation'
      AND operation.subject_id = NEW.request_id
      AND operation.status = 'running'
      AND operation.attempt_count = 1;
    IF authority_count <> 1 THEN
      RAISE EXCEPTION 'running automatic service operation result lacks its exact active mutation lease';
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.status = 'succeeded'
     AND NEW.evidence ->> 'providerCalled' = 'false' THEN
    SELECT count(*)::integer
    INTO authority_count
    FROM public.service_resource_operation_manual_completions completion
    WHERE completion.request_id = NEW.request_id
      AND completion.creation_transaction_id = NEW.creation_transaction_id;
    IF authority_count = 1 THEN
      RETURN NULL;
    END IF;
  END IF;

  SELECT count(*)::integer
  INTO authority_count
  FROM public.service_operation_job_transition_facts transition
  JOIN public.durable_jobs job
    ON job.id = transition.job_id
   AND job.payload ->> 'requestId' = NEW.request_id::text
   AND job.payload ->> 'serviceId' = request_row.service_id::text
   AND job.status = transition.to_status
  JOIN public.provider_operations operation
    ON operation.id = (job.payload ->> 'providerOperationId')::uuid
   AND operation.subject_type = 'service_resource_operation'
   AND operation.subject_id = NEW.request_id
  WHERE transition.request_id = NEW.request_id
    AND transition.creation_transaction_id = NEW.creation_transaction_id
    AND (
      job.job_type = 'service.operation.start'
      OR (
        job.job_type = 'service.operation.reconcile'
        AND EXISTS (
          SELECT 1
          FROM public.service_resource_operation_attempt_facts attempt
          WHERE attempt.request_id = NEW.request_id
            AND attempt.provider_operation_id = operation.id
            AND attempt.attempt_kind = 'reconcile_query'
            AND attempt.durable_job_id = job.id
            AND attempt.durable_job_attempts = transition.job_attempts
            AND attempt.actor_id = transition.worker_id
            AND attempt.creation_transaction_id = NEW.creation_transaction_id
        )
      )
    )
    AND (
      (NEW.status = 'manual'
       AND transition.to_status = 'manual'
       AND operation.status IN ('unknown', 'succeeded'))
      OR
      (NEW.status = 'unknown'
       AND transition.to_status = 'completed'
       AND job.job_type = 'service.operation.start'
       AND operation.status = 'unknown')
      OR
      (NEW.status IN ('succeeded', 'failed')
       AND transition.to_status = 'completed'
       AND operation.status = NEW.status)
    );
  IF authority_count <> 1 THEN
    RAISE EXCEPTION 'automatic service operation result lacks its exact same-transaction terminal Worker job authority';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_check_service_operation_reconcile_attempt_commit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_row record;
  latest_result record;
  operation_status_value text;
  transition_count integer;
BEGIN
  IF NEW.attempt_kind <> 'reconcile_query' THEN
    RETURN NULL;
  END IF;
  SELECT job.status, job.attempts, job.locked_at, job.locked_by,
         job.last_error, job.payload
  INTO job_row
  FROM public.durable_jobs job
  WHERE job.id = NEW.durable_job_id
    AND job.job_type = 'service.operation.reconcile';
  SELECT result.status, result.creation_transaction_id
  INTO latest_result
  FROM public.service_resource_operation_result_facts result
  WHERE result.request_id = NEW.request_id
  ORDER BY result.revision DESC
  LIMIT 1;
  SELECT operation.status
  INTO operation_status_value
  FROM public.provider_operations operation
  WHERE operation.id = NEW.provider_operation_id
    AND operation.subject_type = 'service_resource_operation'
    AND operation.subject_id = NEW.request_id;
  IF job_row IS NULL
     OR job_row.attempts <> NEW.durable_job_attempts
     OR job_row.payload ->> 'requestId' <> NEW.request_id::text
     OR job_row.payload ->> 'providerOperationId' <> NEW.provider_operation_id::text THEN
    RAISE EXCEPTION 'reconcile query fact lost its exact durable job projection';
  END IF;
  IF job_row.status = 'pending' THEN
    IF job_row.locked_at IS NOT NULL
       OR job_row.locked_by IS NOT NULL
       OR job_row.last_error IS NULL
       OR latest_result.status <> 'unknown'
       OR operation_status_value <> 'unknown' THEN
      RAISE EXCEPTION 'reconcile query fact did not atomically reschedule its unknown operation';
    END IF;
    RETURN NULL;
  END IF;
  IF job_row.status IN ('completed', 'manual') THEN
    SELECT count(*)::integer
    INTO transition_count
    FROM public.service_operation_job_transition_facts transition
    WHERE transition.job_id = NEW.durable_job_id
      AND transition.request_id = NEW.request_id
      AND transition.to_status = job_row.status
      AND transition.job_attempts = NEW.durable_job_attempts
      AND transition.worker_id = NEW.actor_id
      AND transition.creation_transaction_id = NEW.creation_transaction_id;
    IF transition_count <> 1
       OR latest_result.creation_transaction_id <> NEW.creation_transaction_id
       OR (job_row.status = 'completed' AND latest_result.status NOT IN ('succeeded', 'failed'))
       OR (job_row.status = 'manual' AND latest_result.status <> 'manual') THEN
      RAISE EXCEPTION 'reconcile query fact did not atomically pair its terminal Worker projection';
    END IF;
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'reconcile query fact cannot commit while its durable job lease remains active';
END;
$$;

CREATE OR REPLACE FUNCTION opensales_guard_service_operation_job()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_id_value uuid;
  service_id_value uuid;
  provider_operation_id_value uuid;
  expected_unique_key text;
  operation_status_value text;
  operation_attempt_count_value integer;
  latest_result_status_value text;
  mutation_count_value integer;
  reconcile_count_value integer;
  reconcile_job_count_value integer;
  transition_fact_count_value integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.job_type IN ('service.operation.start', 'service.operation.reconcile') THEN
      RAISE EXCEPTION 'service operation durable jobs cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (OLD.job_type IN ('service.operation.start', 'service.operation.reconcile')
          OR NEW.job_type IN ('service.operation.start', 'service.operation.reconcile'))
     AND (
       NEW.job_type IS DISTINCT FROM OLD.job_type
       OR NEW.unique_key IS DISTINCT FROM OLD.unique_key
       OR NEW.payload IS DISTINCT FROM OLD.payload
     ) THEN
    RAISE EXCEPTION 'service operation durable job identity and payload are immutable';
  END IF;

  IF NEW.job_type NOT IN ('service.operation.start', 'service.operation.reconcile') THEN
    RETURN NEW;
  END IF;

  BEGIN
    request_id_value := (NEW.payload ->> 'requestId')::uuid;
    service_id_value := (NEW.payload ->> 'serviceId')::uuid;
    provider_operation_id_value := (NEW.payload ->> 'providerOperationId')::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'service operation durable job payload identifiers are invalid';
  END;

  IF NEW.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
       'requestId', request_id_value::text,
       'serviceId', service_id_value::text,
       'providerOperationId', provider_operation_id_value::text
     ) THEN
    RAISE EXCEPTION 'service operation durable job payload must contain its exact three identifiers';
  END IF;

  expected_unique_key := 'service-operation:' || request_id_value::text ||
    CASE NEW.job_type
      WHEN 'service.operation.start' THEN ':start'
      ELSE ':reconcile'
    END;
  IF NEW.unique_key IS DISTINCT FROM expected_unique_key OR NOT EXISTS (
    SELECT 1
    FROM public.service_resource_operation_requests request
    JOIN public.provider_operations operation
      ON operation.id = provider_operation_id_value
     AND operation.subject_type = 'service_resource_operation'
     AND operation.subject_id = request.id
     AND operation.provider_installation_id = request.provider_installation_id
     AND operation.kind = 'resource.' || request.action
     AND operation.stable_key =
       'service-operation:' || request.id::text || ':' || request.action
    WHERE request.id = request_id_value
      AND request.service_id = service_id_value
      AND request.execution_mode = 'automatic'
  ) THEN
    RAISE EXCEPTION 'service operation durable job does not match its immutable request and Provider operation';
  END IF;

  SELECT operation.status, operation.attempt_count
  INTO operation_status_value, operation_attempt_count_value
  FROM public.provider_operations operation
  WHERE operation.id = provider_operation_id_value;
  SELECT result.status
  INTO latest_result_status_value
  FROM public.service_resource_operation_result_facts result
  WHERE result.request_id = request_id_value
  ORDER BY result.revision DESC
  LIMIT 1;
  SELECT count(*) FILTER (WHERE attempt.attempt_kind = 'mutation')::integer,
         count(*) FILTER (WHERE attempt.attempt_kind = 'reconcile_query')::integer
  INTO mutation_count_value, reconcile_count_value
  FROM public.service_resource_operation_attempt_facts attempt
  WHERE attempt.request_id = request_id_value;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending'
       OR NEW.attempts <> 0
       OR NEW.locked_at IS NOT NULL
       OR NEW.locked_by IS NOT NULL
       OR NEW.last_error IS NOT NULL
       OR (NEW.job_type = 'service.operation.start' AND (
         operation_status_value <> 'queued'
         OR operation_attempt_count_value <> 0
         OR mutation_count_value <> 0
         OR latest_result_status_value IS NOT NULL
       ))
       OR (NEW.job_type = 'service.operation.reconcile' AND (
         operation_status_value <> 'unknown'
         OR latest_result_status_value <> 'unknown'
         OR mutation_count_value <> 1
         OR reconcile_count_value >= 3
       )) THEN
      RAISE EXCEPTION 'service operation durable job must start pending with an exact eligible projection';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    IF OLD.status = 'pending' THEN
      IF NEW.attempts IS DISTINCT FROM OLD.attempts
         OR NEW.locked_at IS NOT NULL
         OR NEW.locked_by IS NOT NULL
         OR (NEW.job_type = 'service.operation.reconcile' AND (
           operation_status_value <> 'unknown'
           OR latest_result_status_value <> 'unknown'
           OR reconcile_count_value >= 3
         )) THEN
        RAISE EXCEPTION 'pending service operation durable job projection is invalid';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.status = 'manual'
       AND NEW.attempts IS NOT DISTINCT FROM OLD.attempts
       AND NEW.locked_at IS NULL
       AND NEW.locked_by IS NULL
       AND latest_result_status_value = 'manual' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'terminal or leased service operation durable job is immutable';
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'running' THEN
    IF NEW.attempts <> OLD.attempts + 1
       OR NEW.locked_at IS NULL
       OR NEW.locked_by IS NULL
       OR NEW.available_at > pg_catalog.clock_timestamp()
       OR (NEW.job_type = 'service.operation.start' AND (
         operation_status_value <> 'queued'
         OR operation_attempt_count_value <> 0
         OR mutation_count_value <> 0
         OR latest_result_status_value IS NOT NULL
       ))
       OR (NEW.job_type = 'service.operation.reconcile' AND (
         operation_status_value <> 'unknown'
         OR latest_result_status_value <> 'unknown'
         OR mutation_count_value <> 1
         OR reconcile_count_value >= 3
       )) THEN
      RAISE EXCEPTION 'service operation durable job claim does not match an eligible projection';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'running' AND NEW.status = 'pending' THEN
    IF NEW.attempts IS DISTINCT FROM OLD.attempts
       OR NEW.locked_at IS NOT NULL
       OR NEW.locked_by IS NOT NULL
       OR NEW.last_error IS NULL
       OR (NEW.job_type = 'service.operation.start' AND NOT (
         operation_status_value = 'queued'
         AND operation_attempt_count_value = 0
         AND mutation_count_value = 0
         AND latest_result_status_value IS NULL
       ))
       OR (NEW.job_type = 'service.operation.reconcile' AND NOT (
         operation_status_value = 'unknown'
         AND latest_result_status_value = 'unknown'
         AND mutation_count_value = 1
         AND reconcile_count_value < 3
       )) THEN
      RAISE EXCEPTION 'service operation durable job cannot be rescheduled from its current projection';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'running' AND NEW.status = 'completed' THEN
    SELECT count(*)::integer
    INTO reconcile_job_count_value
    FROM public.durable_jobs reconcile_job
    WHERE reconcile_job.job_type = 'service.operation.reconcile'
      AND reconcile_job.unique_key =
        'service-operation:' || request_id_value::text || ':reconcile'
      AND reconcile_job.payload = pg_catalog.jsonb_build_object(
        'requestId', request_id_value::text,
        'serviceId', service_id_value::text,
        'providerOperationId', provider_operation_id_value::text
      )
      AND reconcile_job.status IN ('pending', 'running');
    SELECT count(*)::integer
    INTO transition_fact_count_value
    FROM public.service_operation_job_transition_facts transition
    WHERE transition.job_id = NEW.id
      AND transition.request_id = request_id_value
      AND transition.from_status = OLD.status
      AND transition.to_status = NEW.status
      AND transition.job_attempts = NEW.attempts
      AND transition.worker_id = OLD.locked_by
      AND transition.creation_transaction_id = txid_current();
    IF NEW.attempts IS DISTINCT FROM OLD.attempts
       OR NEW.locked_at IS NOT NULL
       OR NEW.locked_by IS NOT NULL
       OR NEW.last_error IS NOT NULL
       OR (
         latest_result_status_value IN ('succeeded', 'failed')
         AND NOT (
           operation_status_value = latest_result_status_value
         )
       )
       OR (
         latest_result_status_value = 'unknown'
         AND NOT (
           NEW.job_type = 'service.operation.start'
           AND operation_status_value = 'unknown'
           AND reconcile_job_count_value = 1
         )
       )
       OR latest_result_status_value IS NULL
       OR latest_result_status_value NOT IN ('succeeded', 'failed', 'unknown')
       OR transition_fact_count_value <> 1 THEN
      RAISE EXCEPTION 'completed service operation durable job lacks its same-transaction terminal or reconcile projection';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'running' AND NEW.status = 'manual' THEN
    SELECT count(*)::integer
    INTO transition_fact_count_value
    FROM public.service_operation_job_transition_facts transition
    WHERE transition.job_id = NEW.id
      AND transition.request_id = request_id_value
      AND transition.from_status = OLD.status
      AND transition.to_status = NEW.status
      AND transition.job_attempts = NEW.attempts
      AND transition.worker_id = OLD.locked_by
      AND transition.creation_transaction_id = txid_current();
    IF NEW.attempts IS DISTINCT FROM OLD.attempts
       OR NEW.locked_at IS NOT NULL
       OR NEW.locked_by IS NOT NULL
       OR NEW.last_error IS NULL
       OR latest_result_status_value IS DISTINCT FROM 'manual'
       OR transition_fact_count_value <> 1 THEN
      RAISE EXCEPTION 'manual service operation durable job lacks its same-transaction manual fact';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'service operation durable job status transition is invalid';
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_validate_service_operation_job_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_row record;
  latest_status_value text;
  operation_status_value text;
  reconcile_job_count_value integer;
BEGIN
  NEW.creation_transaction_id := txid_current();
  SELECT job.job_type, job.payload, job.status, job.attempts, job.locked_by
  INTO job_row
  FROM public.durable_jobs job
  WHERE job.id = NEW.job_id
  FOR UPDATE;
  IF job_row IS NULL
     OR job_row.job_type NOT IN ('service.operation.start', 'service.operation.reconcile')
     OR job_row.status <> NEW.from_status
     OR job_row.status <> 'running'
     OR job_row.attempts <> NEW.job_attempts
     OR job_row.locked_by IS DISTINCT FROM NEW.worker_id
     OR job_row.payload ->> 'requestId' IS DISTINCT FROM NEW.request_id::text THEN
    RAISE EXCEPTION 'service operation job transition fact does not match its active lease';
  END IF;
  SELECT result.status
  INTO latest_status_value
  FROM public.service_resource_operation_result_facts result
  WHERE result.request_id = NEW.request_id
  ORDER BY result.revision DESC
  LIMIT 1;
  SELECT operation.status
  INTO operation_status_value
  FROM public.provider_operations operation
  WHERE operation.id = (job_row.payload ->> 'providerOperationId')::uuid
    AND operation.subject_type = 'service_resource_operation'
    AND operation.subject_id = NEW.request_id;
  IF NEW.to_status = 'manual' THEN
    IF latest_status_value IS DISTINCT FROM 'manual' THEN
      RAISE EXCEPTION 'manual service job transition requires an immutable manual result';
    END IF;
    RETURN NEW;
  END IF;
  IF latest_status_value IN ('succeeded', 'failed')
     AND operation_status_value = latest_status_value THEN
    RETURN NEW;
  END IF;
  IF latest_status_value = 'unknown'
     AND job_row.job_type = 'service.operation.start'
     AND operation_status_value = 'unknown' THEN
    SELECT count(*)::integer
    INTO reconcile_job_count_value
    FROM public.durable_jobs reconcile_job
    WHERE reconcile_job.job_type = 'service.operation.reconcile'
      AND reconcile_job.unique_key =
        'service-operation:' || NEW.request_id::text || ':reconcile'
      AND reconcile_job.payload = job_row.payload
      AND reconcile_job.status IN ('pending', 'running');
    IF reconcile_job_count_value = 1 THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'completed service job transition lacks an exact terminal or GET-only projection';
END;
$$;

CREATE OR REPLACE FUNCTION opensales_record_commercial_resource_observation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  next_revision integer;
  next_desired_revision integer;
  desired_state text;
  observed_state text;
BEGIN
  IF NEW.status NOT IN ('active', 'suspended', 'terminated')
     OR (TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status) THEN
    RETURN NEW;
  END IF;
  SELECT fact.state
  INTO desired_state
  FROM public.service_resource_desired_state_facts fact
  WHERE fact.service_id = NEW.id
  ORDER BY fact.desired_revision DESC
  LIMIT 1;
  IF desired_state IS NULL OR NEW.status = 'terminated' THEN
    SELECT COALESCE(max(fact.desired_revision), 0) + 1
    INTO next_desired_revision
    FROM public.service_resource_desired_state_facts fact
    WHERE fact.service_id = NEW.id;
    desired_state := CASE WHEN NEW.status = 'terminated' THEN 'terminated' ELSE 'running' END;
    INSERT INTO public.service_resource_desired_state_facts(
      service_id, desired_revision, state, source, recorded_at
    ) VALUES (
      NEW.id, next_desired_revision, desired_state, 'commercial_lifecycle',
      COALESCE(NEW.updated_at, now())
    );
  END IF;
  observed_state := CASE NEW.status
    WHEN 'suspended' THEN 'stopped'
    WHEN 'terminated' THEN 'terminated'
    ELSE desired_state
  END;
  SELECT COALESCE(max(fact.resource_revision), 0) + 1
  INTO next_revision
  FROM service_resource_state_facts fact
  WHERE fact.service_id = NEW.id;
  INSERT INTO service_resource_state_facts(
    service_id, resource_revision, state, source, cause, observed_at
  ) VALUES (
    NEW.id, next_revision, observed_state, 'commercial_lifecycle',
    'commercial.' || NEW.status, COALESCE(NEW.updated_at, now())
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_validate_service_operation_manual_completion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target record;
  pointer record;
  actor_allowed boolean := false;
BEGIN
  NEW.creation_transaction_id := txid_current();
  IF NEW.request_fingerprint IS DISTINCT FROM
       public.opensales_service_operation_request_fingerprint(
         'admin.services.complete-manual-operation:v1',
         pg_catalog.jsonb_build_object(
           'requestId', NEW.request_id::text,
           'expectedServiceVersion', NEW.expected_service_version,
           'expectedResourceRevision', NEW.expected_resource_revision,
           'reason', NEW.reason
         )
       ) THEN
    RAISE EXCEPTION 'manual service operation completion fingerprint does not match its immutable intent';
  END IF;
  SELECT email_verified_at IS NOT NULL AND restricted_at IS NULL
  INTO actor_allowed
  FROM users
  WHERE id = NEW.staff_user_id
  FOR UPDATE;
  IF actor_allowed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'manual service operation staff identity is not eligible';
  END IF;
  PERFORM 1
  FROM sessions
  WHERE id = NEW.staff_session_id
    AND user_id = NEW.staff_user_id
    AND revoked_at IS NULL
    AND expires_at > pg_catalog.clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual service operation completion session is not active';
  END IF;
  SELECT active AND (permissions ? '*' OR permissions ? 'services.operations_manage')
  INTO actor_allowed
  FROM staff_members
  WHERE user_id = NEW.staff_user_id
  FOR UPDATE;
  IF actor_allowed THEN
    PERFORM 1
    FROM reauth_grants
    WHERE user_id = NEW.staff_user_id
      AND session_id = NEW.staff_session_id
      AND invalidated_at IS NULL
      AND expires_at > pg_catalog.clock_timestamp()
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    FOR UPDATE;
    actor_allowed := FOUND;
  END IF;
  IF actor_allowed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'manual service operation completion is not currently authorized';
  END IF;

  SELECT request.service_id, request.client_account_id, service.order_item_id
  INTO pointer
  FROM service_resource_operation_requests request
  JOIN services service ON service.id = request.service_id
  WHERE request.id = NEW.request_id;
  IF pointer IS NULL THEN
    RAISE EXCEPTION 'manual service operation request is missing';
  END IF;
  PERFORM 1 FROM client_accounts WHERE id = pointer.client_account_id FOR UPDATE;
  PERFORM 1 FROM order_items WHERE id = pointer.order_item_id FOR UPDATE;
  PERFORM 1 FROM services WHERE id = pointer.service_id FOR UPDATE;
  PERFORM 1 FROM service_resource_operation_requests WHERE id = NEW.request_id FOR UPDATE;

  -- The initial identity locks cannot prevent natural session or reauth
  -- expiry while this transaction waits for the canonical business locks.
  SELECT EXISTS (
    SELECT 1
    FROM users user_record
    JOIN sessions session_record
      ON session_record.id = NEW.staff_session_id
     AND session_record.user_id = user_record.id
    JOIN staff_members staff
      ON staff.user_id = user_record.id
    WHERE user_record.id = NEW.staff_user_id
      AND user_record.email_verified_at IS NOT NULL
      AND user_record.restricted_at IS NULL
      AND session_record.revoked_at IS NULL
      AND session_record.expires_at > pg_catalog.clock_timestamp()
      AND staff.active
      AND (staff.permissions ? '*' OR staff.permissions ? 'services.operations_manage')
      AND EXISTS (
        SELECT 1
        FROM reauth_grants reauth
        WHERE reauth.user_id = user_record.id
          AND reauth.session_id = session_record.id
          AND reauth.invalidated_at IS NULL
          AND reauth.expires_at > pg_catalog.clock_timestamp()
      )
  ) INTO actor_allowed;
  IF actor_allowed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'manual service operation completion authorization expired while acquiring business locks';
  END IF;
  SELECT request.service_id, request.client_account_id, request.action,
         service.status AS service_status, service.version AS service_version,
         service.cancellation_effective_at,
         COALESCE(resource.resource_revision, 0) AS resource_revision,
         latest.status AS result_status
  INTO target
  FROM service_resource_operation_requests request
  JOIN services service ON service.id = request.service_id
  LEFT JOIN LATERAL (
    SELECT fact.resource_revision
    FROM service_resource_state_facts fact
    WHERE fact.service_id = service.id
    ORDER BY fact.resource_revision DESC
    LIMIT 1
  ) resource ON true
  LEFT JOIN LATERAL (
    SELECT result.status
    FROM service_resource_operation_result_facts result
    WHERE result.request_id = request.id
    ORDER BY result.revision DESC
    LIMIT 1
  ) latest ON true
  WHERE request.id = NEW.request_id;
  IF target IS NULL
     OR target.service_id <> NEW.service_id
     OR target.client_account_id <> NEW.client_account_id
     OR target.service_status <> 'active'
     OR (target.cancellation_effective_at IS NOT NULL
         AND target.cancellation_effective_at <= pg_catalog.clock_timestamp())
     OR target.service_version <> NEW.expected_service_version
     OR target.resource_revision <> NEW.expected_resource_revision
     OR target.result_status <> 'manual' THEN
    RAISE EXCEPTION 'manual service operation completion does not match current state';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(NEW.result)) <> 9
     OR NOT (NEW.result ?& ARRAY[
       'actionId', 'requestId', 'serviceId', 'action', 'status',
       'resourceState', 'resourceRevision', 'completedAt', 'providerCalled'
     ])
     OR NEW.result ->> 'actionId' <> NEW.id::text
     OR NEW.result ->> 'requestId' <> NEW.request_id::text
     OR NEW.result ->> 'serviceId' <> NEW.service_id::text
     OR NEW.result ->> 'action' <> target.action
     OR NEW.result ->> 'status' <> 'succeeded'
     OR (target.action = 'stop' AND NEW.result ->> 'resourceState' <> 'stopped')
     OR (target.action IN ('start', 'reboot')
         AND NEW.result ->> 'resourceState' <> 'running')
     OR (NEW.result ->> 'resourceRevision')::integer <> NEW.expected_resource_revision + 1
     OR (NEW.result ->> 'completedAt')::timestamptz <> NEW.created_at
     OR NEW.result -> 'providerCalled' <> 'false'::jsonb THEN
    RAISE EXCEPTION 'manual service operation completion result does not match its immutable fact';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_validate_service_operation_result()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_row record;
  previous_row record;
BEGIN
  NEW.creation_transaction_id := txid_current();
  SELECT request.service_id, request.action, request.execution_mode
  INTO request_row
  FROM service_resource_operation_requests request
  WHERE request.id = NEW.request_id;
  IF request_row IS NULL THEN
    RAISE EXCEPTION 'service operation result references a missing request';
  END IF;

  SELECT result.revision, result.status
  INTO previous_row
  FROM service_resource_operation_result_facts result
  WHERE result.request_id = NEW.request_id
  ORDER BY result.revision DESC
  LIMIT 1;
  IF NEW.revision <> COALESCE(previous_row.revision, 0) + 1
     OR previous_row.status IN ('succeeded', 'failed')
     OR (previous_row IS NULL AND (
       (request_row.execution_mode = 'automatic' AND NEW.status <> 'running')
       OR (request_row.execution_mode = 'manual' AND NEW.status <> 'manual')
     ))
     OR (previous_row.status = 'running' AND NEW.status NOT IN ('unknown', 'manual', 'succeeded', 'failed'))
     OR (previous_row.status = 'unknown' AND NEW.status NOT IN ('manual', 'succeeded', 'failed'))
     OR (previous_row.status = 'manual' AND NEW.status <> 'succeeded') THEN
    RAISE EXCEPTION 'service operation result transition is invalid';
  END IF;

  IF NEW.status = 'succeeded' THEN
    IF (request_row.action = 'start' AND NEW.resource_state <> 'running')
       OR (request_row.action = 'stop' AND NEW.resource_state <> 'stopped')
       OR (request_row.action = 'reboot' AND NEW.resource_state <> 'running') THEN
      RAISE EXCEPTION 'successful service operation result has an invalid resource state';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_validate_service_resource_state_fact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_revision integer;
  request_row record;
  service_row record;
  expected_state text;
  expected_at timestamptz;
BEGIN
  NEW.creation_transaction_id := txid_current();
  SELECT status, updated_at
  INTO service_row
  FROM public.services
  WHERE id = NEW.service_id
  FOR UPDATE;
  IF service_row IS NULL THEN
    RAISE EXCEPTION 'service resource state fact references a missing Service';
  END IF;
  SELECT max(resource_revision)
  INTO previous_revision
  FROM service_resource_state_facts
  WHERE service_id = NEW.service_id;
  IF NEW.resource_revision <> COALESCE(previous_revision, 0) + 1 THEN
    RAISE EXCEPTION 'service resource state fact revision is not contiguous';
  END IF;
  IF NEW.source = 'migration_snapshot' THEN
    RAISE EXCEPTION 'schema migration resource snapshots cannot be appended at runtime';
  ELSIF NEW.source = 'commercial_lifecycle' THEN
    expected_state := CASE service_row.status
      WHEN 'suspended' THEN 'stopped'
      WHEN 'terminated' THEN 'terminated'
      WHEN 'active' THEN (
        SELECT desired.state
        FROM public.service_resource_desired_state_facts desired
        WHERE desired.service_id = NEW.service_id
        ORDER BY desired.desired_revision DESC
        LIMIT 1
      )
      ELSE NULL
    END;
    expected_at := COALESCE(service_row.updated_at, now());
    IF pg_catalog.pg_trigger_depth() <= 1
       OR NEW.operation_request_id IS NOT NULL
       OR NEW.provider_operation_id IS NOT NULL
       OR expected_state IS NULL
       OR NEW.state IS DISTINCT FROM expected_state
       OR NEW.cause IS DISTINCT FROM 'commercial.' || service_row.status
       OR NEW.observed_at IS DISTINCT FROM expected_at THEN
      RAISE EXCEPTION 'commercial resource observation must come from the exact Service lifecycle trigger';
    END IF;
  ELSIF NEW.source = 'daily_operation' THEN
    SELECT request.service_id, request.action, request.execution_mode
    INTO request_row
    FROM service_resource_operation_requests request
    WHERE request.id = NEW.operation_request_id;
    IF request_row IS NULL
       OR request_row.service_id <> NEW.service_id
       OR (request_row.action = 'start' AND NEW.state <> 'running')
       OR (request_row.action = 'stop' AND NEW.state <> 'stopped')
       OR (request_row.action = 'reboot' AND NEW.state <> 'running')
       OR NEW.cause <> 'resource.' || request_row.action THEN
      RAISE EXCEPTION 'daily operation resource state fact does not match its request';
    END IF;
    IF request_row.execution_mode = 'automatic' THEN
      IF NEW.provider_operation_id IS NULL AND EXISTS (
        SELECT 1
        FROM public.service_resource_operation_manual_completions completion
        WHERE completion.request_id = NEW.operation_request_id
          AND completion.creation_transaction_id = NEW.creation_transaction_id
      ) THEN
        NULL;
      ELSIF NOT EXISTS (
        SELECT 1
        FROM provider_operations operation
        WHERE operation.id = NEW.provider_operation_id
          AND operation.subject_type = 'service_resource_operation'
          AND operation.subject_id = NEW.operation_request_id
          AND operation.kind = 'resource.' || request_row.action
      ) THEN
        RAISE EXCEPTION 'automatic daily resource fact lacks its Provider operation';
      END IF;
    ELSIF NEW.provider_operation_id IS NOT NULL THEN
      RAISE EXCEPTION 'manual daily resource fact cannot claim a Provider operation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_validate_service_desired_state_fact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_revision integer;
  request_row record;
  service_row record;
  expected_state text;
  expected_at timestamptz;
BEGIN
  NEW.creation_transaction_id := txid_current();
  SELECT status, updated_at
  INTO service_row
  FROM public.services
  WHERE id = NEW.service_id
  FOR UPDATE;
  IF service_row IS NULL THEN
    RAISE EXCEPTION 'service desired resource state fact references a missing Service';
  END IF;
  SELECT max(desired_revision)
  INTO previous_revision
  FROM service_resource_desired_state_facts
  WHERE service_id = NEW.service_id;
  IF NEW.desired_revision <> COALESCE(previous_revision, 0) + 1 THEN
    RAISE EXCEPTION 'service desired resource state revision is not contiguous';
  END IF;
  IF NEW.source = 'migration_snapshot' THEN
    RAISE EXCEPTION 'schema migration desired resource snapshots cannot be appended at runtime';
  ELSIF NEW.source = 'commercial_lifecycle' THEN
    expected_state := CASE WHEN service_row.status = 'terminated'
      THEN 'terminated' ELSE 'running' END;
    expected_at := COALESCE(service_row.updated_at, now());
    IF pg_catalog.pg_trigger_depth() <= 1
       OR NEW.operation_request_id IS NOT NULL
       OR NEW.state IS DISTINCT FROM expected_state
       OR NEW.recorded_at IS DISTINCT FROM expected_at
       OR (service_row.status <> 'terminated' AND previous_revision IS NOT NULL)
       OR service_row.status NOT IN ('active', 'suspended', 'terminated') THEN
      RAISE EXCEPTION 'commercial desired state must come from the exact Service lifecycle trigger';
    END IF;
  ELSIF NEW.source = 'daily_operation' THEN
    SELECT request.service_id, request.action
    INTO request_row
    FROM service_resource_operation_requests request
    WHERE request.id = NEW.operation_request_id;
    IF request_row IS NULL
       OR request_row.service_id <> NEW.service_id
       OR (request_row.action = 'start' AND NEW.state <> 'running')
       OR (request_row.action = 'stop' AND NEW.state <> 'stopped')
       OR (request_row.action = 'reboot' AND NEW.state <> 'running') THEN
      RAISE EXCEPTION 'daily operation desired state fact does not match its request';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_validate_service_operation_attempt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_row record;
  operation_row record;
  previous_attempt record;
  latest_result record;
  lease_count integer;
BEGIN
  NEW.creation_transaction_id := txid_current();
  SELECT request.execution_mode, request.provider_installation_id,
         request.action, request.service_id, request.actor_type,
         request.actor_user_id, request.actor_session_id,
         request.client_account_id
  INTO request_row
  FROM service_resource_operation_requests request
  WHERE request.id = NEW.request_id;
  IF request_row IS NULL THEN
    RAISE EXCEPTION 'service operation attempt references a missing request';
  END IF;
  SELECT attempt_number, attempt_kind
  INTO previous_attempt
  FROM service_resource_operation_attempt_facts
  WHERE request_id = NEW.request_id
  ORDER BY attempt_number DESC
  LIMIT 1;
  SELECT status INTO latest_result
  FROM service_resource_operation_result_facts
  WHERE request_id = NEW.request_id
  ORDER BY revision DESC
  LIMIT 1;
  IF NEW.attempt_number <> COALESCE(previous_attempt.attempt_number, 0) + 1 THEN
    RAISE EXCEPTION 'service operation attempt number is not contiguous';
  END IF;
  IF NEW.attempt_kind = 'manual' THEN
    IF NEW.provider_operation_id IS NOT NULL
       OR NEW.durable_job_id IS NOT NULL
       OR NEW.durable_job_attempts IS NOT NULL
       OR latest_result.status <> 'manual' THEN
      RAISE EXCEPTION 'manual service operation attempt is not eligible';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.attempt_kind = 'mutation' THEN
    PERFORM 1
    FROM public.users user_record
    WHERE user_record.id = request_row.actor_user_id
      AND user_record.email_verified_at IS NOT NULL
      AND user_record.restricted_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'service operation mutation actor identity is not fresh';
    END IF;
    IF request_row.actor_type = 'user' THEN
      PERFORM 1
      FROM public.sessions session
      WHERE session.id = request_row.actor_session_id
        AND session.user_id = request_row.actor_user_id
        AND session.revoked_at IS NULL
        AND session.expires_at > pg_catalog.clock_timestamp()
        AND session.active_client_account_id = request_row.client_account_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'service operation mutation customer session is not fresh';
      END IF;
      PERFORM 1
      FROM public.client_accounts account
      WHERE account.id = request_row.client_account_id
        AND account.restricted_at IS NULL
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'service operation mutation Client Account is not fresh';
      END IF;
      PERFORM 1
      FROM public.client_memberships membership
      WHERE membership.client_account_id = request_row.client_account_id
        AND membership.user_id = request_row.actor_user_id
        AND membership.removed_at IS NULL
        AND membership.restricted_at IS NULL
        AND (
          membership.role IN ('owner', 'technical')
          OR membership.permissions ? '*'
          OR membership.permissions ? 'services.manage'
        )
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'service operation mutation customer authority is not fresh';
      END IF;
    ELSIF request_row.actor_type = 'staff' THEN
      PERFORM 1
      FROM public.sessions session
      WHERE session.id = request_row.actor_session_id
        AND session.user_id = request_row.actor_user_id
        AND session.revoked_at IS NULL
        AND session.expires_at > pg_catalog.clock_timestamp()
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'service operation mutation Staff session is not fresh';
      END IF;
      PERFORM 1
      FROM public.staff_members staff
      WHERE staff.user_id = request_row.actor_user_id
        AND staff.active
        AND (staff.permissions ? '*' OR staff.permissions ? 'services.operations_manage')
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'service operation mutation Staff authority is not fresh';
      END IF;
      PERFORM 1
      FROM public.reauth_grants reauth
      WHERE reauth.user_id = request_row.actor_user_id
        AND reauth.session_id = request_row.actor_session_id
        AND reauth.invalidated_at IS NULL
        AND reauth.expires_at > pg_catalog.clock_timestamp()
      ORDER BY reauth.created_at DESC, reauth.id DESC
      LIMIT 1
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'service operation mutation Staff reauthentication is not fresh';
      END IF;
      PERFORM 1
      FROM public.client_accounts account
      WHERE account.id = request_row.client_account_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'service operation mutation Client Account is missing';
      END IF;
    ELSE
      RAISE EXCEPTION 'service operation mutation actor type is invalid';
    END IF;
  END IF;
  SELECT provider.provider_installation_id, provider.kind,
         provider.subject_type, provider.subject_id, provider.stable_key
  INTO operation_row
  FROM provider_operations provider
  WHERE provider.id = NEW.provider_operation_id;
  IF request_row.execution_mode <> 'automatic'
     OR operation_row IS NULL
     OR operation_row.provider_installation_id <> request_row.provider_installation_id
     OR operation_row.kind <> 'resource.' || request_row.action
     OR operation_row.subject_type <> 'service_resource_operation'
     OR operation_row.subject_id <> NEW.request_id
     OR operation_row.stable_key <> 'service-operation:' || NEW.request_id::text || ':' || request_row.action THEN
    RAISE EXCEPTION 'service operation attempt does not match its Provider operation';
  END IF;
  IF NEW.attempt_kind = 'mutation' THEN
    IF previous_attempt IS NOT NULL THEN
      RAISE EXCEPTION 'service operation mutation may be attempted only once';
    END IF;
    SELECT count(*)::integer
    INTO lease_count
    FROM public.durable_jobs job
    WHERE job.job_type = 'service.operation.start'
      AND job.id = NEW.durable_job_id
      AND job.attempts = NEW.durable_job_attempts
      AND job.unique_key = 'service-operation:' || NEW.request_id::text || ':start'
      AND job.payload = pg_catalog.jsonb_build_object(
        'requestId', NEW.request_id::text,
        'serviceId', request_row.service_id::text,
        'providerOperationId', NEW.provider_operation_id::text
      )
      AND job.status = 'running'
      AND job.locked_at IS NOT NULL
      AND job.locked_by = NEW.actor_id;
  ELSIF NEW.attempt_kind = 'reconcile_query' THEN
    IF previous_attempt IS NULL OR latest_result.status <> 'unknown' THEN
      RAISE EXCEPTION 'service operation reconcile requires an unknown prior result';
    END IF;
    SELECT count(*)::integer
    INTO lease_count
    FROM public.durable_jobs job
    WHERE job.job_type = 'service.operation.reconcile'
      AND job.id = NEW.durable_job_id
      AND job.attempts = NEW.durable_job_attempts
      AND job.unique_key = 'service-operation:' || NEW.request_id::text || ':reconcile'
      AND job.payload = pg_catalog.jsonb_build_object(
        'requestId', NEW.request_id::text,
        'serviceId', request_row.service_id::text,
        'providerOperationId', NEW.provider_operation_id::text
      )
      AND job.status = 'running'
      AND job.locked_at IS NOT NULL
      AND job.locked_by = NEW.actor_id;
  END IF;
  IF lease_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'service operation Provider attempt requires its exact active Worker job lease';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_check_service_operation_commit_pair()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_id_value uuid;
  result_row record;
  state_row record;
  desired_row record;
BEGIN
  IF TG_TABLE_NAME = 'service_resource_operation_result_facts' THEN
    request_id_value := NEW.request_id;
  ELSE
    request_id_value := NEW.operation_request_id;
  END IF;
  SELECT status, resource_state, creation_transaction_id
  INTO result_row
  FROM service_resource_operation_result_facts
  WHERE request_id = request_id_value
  ORDER BY revision DESC
  LIMIT 1;
  SELECT state, creation_transaction_id
  INTO state_row
  FROM service_resource_state_facts
  WHERE operation_request_id = request_id_value;
  SELECT state, creation_transaction_id
  INTO desired_row
  FROM service_resource_desired_state_facts
  WHERE operation_request_id = request_id_value;
  IF result_row.status = 'succeeded' THEN
    IF state_row IS NULL OR desired_row IS NULL
       OR state_row.state IS DISTINCT FROM result_row.resource_state
       OR desired_row.state IS DISTINCT FROM result_row.resource_state
       OR state_row.creation_transaction_id <> result_row.creation_transaction_id
       OR desired_row.creation_transaction_id <> result_row.creation_transaction_id THEN
      RAISE EXCEPTION 'successful service operation must atomically pair result, desired, and observed state facts';
    END IF;
  ELSIF state_row IS NOT NULL OR desired_row IS NOT NULL THEN
    RAISE EXCEPTION 'non-successful service operation cannot change desired or observed resource state';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_check_service_operation_manual_completion_pair()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_id_value uuid;
  request_row record;
  completion_row record;
  attempt_row record;
  result_row record;
  desired_row record;
  observed_row record;
  manual_attempt_count integer;
  requires_completion boolean := false;
BEGIN
  IF TG_TABLE_NAME IN (
    'service_resource_state_facts',
    'service_resource_desired_state_facts'
  ) THEN
    request_id_value := NEW.operation_request_id;
  ELSE
    request_id_value := NEW.request_id;
  END IF;
  IF request_id_value IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT request.service_id, request.action, request.execution_mode
  INTO request_row
  FROM public.service_resource_operation_requests request
  WHERE request.id = request_id_value;
  SELECT completion.id, completion.service_id, completion.staff_user_id,
         completion.expected_resource_revision, completion.expected_desired_revision,
         completion.created_at,
         completion.creation_transaction_id
  INTO completion_row
  FROM public.service_resource_operation_manual_completions completion
  WHERE completion.request_id = request_id_value;
  SELECT result.status, result.resource_state, result.provider_occurred_at,
         result.evidence, result.creation_transaction_id
  INTO result_row
  FROM public.service_resource_operation_result_facts result
  WHERE result.request_id = request_id_value
  ORDER BY result.revision DESC
  LIMIT 1;
  requires_completion := completion_row IS NOT NULL
    OR (
      TG_TABLE_NAME = 'service_resource_operation_attempt_facts'
      AND pg_catalog.to_jsonb(NEW) ->> 'attempt_kind' = 'manual'
    )
    OR (
      result_row.status = 'succeeded'
      AND (
        request_row.execution_mode = 'manual'
        OR result_row.evidence ->> 'providerCalled' = 'false'
      )
    );
  IF NOT requires_completion THEN
    RETURN NULL;
  END IF;
  SELECT attempt.attempt_kind, attempt.provider_operation_id,
         attempt.actor_id, attempt.started_at,
         attempt.creation_transaction_id
  INTO attempt_row
  FROM public.service_resource_operation_attempt_facts attempt
  WHERE attempt.request_id = request_id_value
  ORDER BY attempt.attempt_number DESC
  LIMIT 1;
  SELECT count(*)::integer
  INTO manual_attempt_count
  FROM public.service_resource_operation_attempt_facts attempt
  WHERE attempt.request_id = request_id_value
    AND attempt.attempt_kind = 'manual';
  SELECT fact.state, fact.desired_revision, fact.recorded_at,
         fact.creation_transaction_id
  INTO desired_row
  FROM public.service_resource_desired_state_facts fact
  WHERE fact.operation_request_id = request_id_value;
  SELECT fact.state, fact.resource_revision, fact.observed_at,
         fact.provider_operation_id, fact.creation_transaction_id
  INTO observed_row
  FROM public.service_resource_state_facts fact
  WHERE fact.operation_request_id = request_id_value;

  IF completion_row IS NULL
     OR request_row IS NULL
     OR completion_row.service_id <> request_row.service_id
     OR manual_attempt_count <> 1
     OR attempt_row.attempt_kind <> 'manual'
     OR attempt_row.provider_operation_id IS NOT NULL
     OR attempt_row.actor_id <> completion_row.staff_user_id::text
     OR attempt_row.started_at <> completion_row.created_at
     OR result_row.status <> 'succeeded'
     OR (request_row.action = 'stop' AND result_row.resource_state <> 'stopped')
     OR (request_row.action IN ('start', 'reboot')
         AND result_row.resource_state <> 'running')
     OR result_row.provider_occurred_at <> completion_row.created_at
     OR result_row.evidence <> pg_catalog.jsonb_build_object(
       'providerCalled', false, 'completedByStaff', true
     )
     OR desired_row.state <> result_row.resource_state
     OR desired_row.desired_revision <> completion_row.expected_desired_revision + 1
     OR desired_row.recorded_at <> completion_row.created_at
     OR observed_row.state <> result_row.resource_state
     OR observed_row.resource_revision <> completion_row.expected_resource_revision + 1
     OR observed_row.observed_at <> completion_row.created_at
     OR observed_row.provider_operation_id IS NOT NULL
     OR completion_row.creation_transaction_id <> attempt_row.creation_transaction_id
     OR completion_row.creation_transaction_id <> result_row.creation_transaction_id
     OR completion_row.creation_transaction_id <> desired_row.creation_transaction_id
     OR completion_row.creation_transaction_id <> observed_row.creation_transaction_id THEN
    RAISE EXCEPTION 'manual completion must atomically pair its exact completion, attempt, result, desired, and observed facts';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_check_service_operation_provider_projection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_id_value uuid;
  request_row record;
  operation_row record;
  result_row record;
  mutation_count integer;
  has_completion boolean;
BEGIN
  IF TG_TABLE_NAME = 'provider_operations' THEN
    request_id_value := NEW.subject_id;
  ELSE
    request_id_value := NEW.request_id;
  END IF;
  SELECT request.execution_mode
  INTO request_row
  FROM public.service_resource_operation_requests request
  WHERE request.id = request_id_value;
  IF request_row IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT operation.id, operation.status, operation.attempt_count
  INTO operation_row
  FROM public.provider_operations operation
  WHERE operation.subject_type = 'service_resource_operation'
    AND operation.subject_id = request_id_value;
  SELECT result.status
  INTO result_row
  FROM public.service_resource_operation_result_facts result
  WHERE result.request_id = request_id_value
  ORDER BY result.revision DESC
  LIMIT 1;
  SELECT count(*)::integer
  INTO mutation_count
  FROM public.service_resource_operation_attempt_facts attempt
  WHERE attempt.request_id = request_id_value
    AND attempt.attempt_kind = 'mutation';
  SELECT EXISTS (
    SELECT 1
    FROM public.service_resource_operation_manual_completions completion
    WHERE completion.request_id = request_id_value
  ) INTO has_completion;

  IF request_row.execution_mode = 'manual' THEN
    IF operation_row IS NOT NULL OR mutation_count <> 0 THEN
      RAISE EXCEPTION 'manual service operation cannot own a Provider projection';
    END IF;
    RETURN NULL;
  END IF;
  IF operation_row IS NULL
     OR operation_row.attempt_count <> mutation_count
     OR mutation_count NOT IN (0, 1)
     OR (result_row IS NULL AND operation_row.status <> 'queued')
     OR (result_row.status = 'running' AND operation_row.status <> 'running')
     OR (result_row.status = 'unknown' AND operation_row.status <> 'unknown')
     OR (result_row.status = 'failed' AND operation_row.status <> 'failed')
     OR (result_row.status = 'manual' AND operation_row.status NOT IN ('unknown', 'succeeded'))
     OR (result_row.status = 'succeeded' AND NOT (
       operation_row.status = 'succeeded'
       OR (has_completion AND operation_row.status = 'unknown')
     )) THEN
    RAISE EXCEPTION 'service operation Provider row is not the exact projection of immutable attempts and results';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_check_service_operation_request_commit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation_count integer;
  job_count integer;
  initial_status text;
  operation_id_value uuid;
BEGIN
  SELECT operation.id
  INTO operation_id_value
  FROM provider_operations operation
  WHERE operation.subject_type = 'service_resource_operation'
    AND operation.subject_id = NEW.id
    AND operation.provider_installation_id = NEW.provider_installation_id
    AND operation.kind = 'resource.' || NEW.action
    AND operation.stable_key = 'service-operation:' || NEW.id::text || ':' || NEW.action
    AND operation.status = 'queued'
    AND operation.attempt_count = 0
    AND operation.last_error IS NULL
    AND operation.external_reference IS NULL;
  operation_count := CASE WHEN operation_id_value IS NULL THEN 0 ELSE 1 END;
  SELECT count(*)::integer
  INTO job_count
  FROM durable_jobs job
  WHERE job.job_type = 'service.operation.start'
    AND job.unique_key = 'service-operation:' || NEW.id::text || ':start'
    AND job.status = 'pending'
    AND job.attempts = 0
    AND job.locked_at IS NULL
    AND job.locked_by IS NULL
    AND job.last_error IS NULL
    AND job.payload = jsonb_build_object(
      'requestId', NEW.id::text,
      'serviceId', NEW.service_id::text,
      'providerOperationId', operation_id_value::text
    );
  SELECT result.status
  INTO initial_status
  FROM service_resource_operation_result_facts result
  WHERE result.request_id = NEW.id
  ORDER BY result.revision
  LIMIT 1;
  IF NEW.execution_mode = 'automatic' THEN
    IF operation_count <> 1 OR job_count <> 1 OR initial_status IS NOT NULL THEN
      RAISE EXCEPTION 'automatic service operation lacks its unique Provider operation and start job';
    END IF;
  ELSIF operation_count <> 0 OR job_count <> 0 OR initial_status <> 'manual' THEN
    RAISE EXCEPTION 'manual service operation must start with one manual result and no Provider side effect';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER service_resource_operation_requests_validate
BEFORE INSERT ON service_resource_operation_requests
FOR EACH ROW EXECUTE FUNCTION opensales_validate_service_operation_request();
CREATE TRIGGER service_resource_operation_requests_immutable
BEFORE UPDATE OR DELETE ON service_resource_operation_requests
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_operation_fact_mutation();

CREATE TRIGGER provider_operations_service_resource_guard
BEFORE INSERT OR UPDATE OR DELETE ON provider_operations
FOR EACH ROW EXECUTE FUNCTION opensales_guard_service_resource_provider_operation();

CREATE TRIGGER durable_jobs_service_operation_guard
BEFORE INSERT OR UPDATE OR DELETE ON durable_jobs
FOR EACH ROW EXECUTE FUNCTION opensales_guard_service_operation_job();

CREATE TRIGGER service_operation_job_transition_facts_validate
BEFORE INSERT ON service_operation_job_transition_facts
FOR EACH ROW EXECUTE FUNCTION opensales_validate_service_operation_job_transition();
CREATE CONSTRAINT TRIGGER service_operation_job_transition_facts_commit_pair
AFTER INSERT ON service_operation_job_transition_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opensales_check_service_operation_job_transition_commit();
CREATE TRIGGER service_operation_job_transition_facts_immutable
BEFORE UPDATE OR DELETE ON service_operation_job_transition_facts
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_operation_fact_mutation();

CREATE TRIGGER service_resource_operation_attempt_facts_immutable
BEFORE UPDATE OR DELETE ON service_resource_operation_attempt_facts
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_operation_fact_mutation();
CREATE TRIGGER service_resource_operation_attempts_validate
BEFORE INSERT ON service_resource_operation_attempt_facts
FOR EACH ROW EXECUTE FUNCTION opensales_validate_service_operation_attempt();
CREATE CONSTRAINT TRIGGER service_resource_operation_reconcile_attempts_commit
AFTER INSERT ON service_resource_operation_attempt_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.attempt_kind = 'reconcile_query')
EXECUTE FUNCTION opensales_check_service_operation_reconcile_attempt_commit();

CREATE TRIGGER service_resource_operation_results_validate
BEFORE INSERT ON service_resource_operation_result_facts
FOR EACH ROW EXECUTE FUNCTION opensales_validate_service_operation_result();
CREATE CONSTRAINT TRIGGER service_resource_operation_results_authority
AFTER INSERT ON service_resource_operation_result_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opensales_check_service_operation_result_authority();
CREATE TRIGGER service_resource_operation_result_facts_immutable
BEFORE UPDATE OR DELETE ON service_resource_operation_result_facts
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_operation_fact_mutation();

CREATE TRIGGER service_resource_operation_manual_completions_immutable
BEFORE UPDATE OR DELETE ON service_resource_operation_manual_completions
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_operation_fact_mutation();
CREATE TRIGGER service_resource_operation_manual_completions_validate
BEFORE INSERT ON service_resource_operation_manual_completions
FOR EACH ROW EXECUTE FUNCTION opensales_validate_service_operation_manual_completion();

CREATE TRIGGER service_resource_state_facts_validate
BEFORE INSERT ON service_resource_state_facts
FOR EACH ROW EXECUTE FUNCTION opensales_validate_service_resource_state_fact();
CREATE TRIGGER service_resource_state_facts_immutable
BEFORE UPDATE OR DELETE ON service_resource_state_facts
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_operation_fact_mutation();

CREATE TRIGGER service_resource_desired_state_facts_validate
BEFORE INSERT ON service_resource_desired_state_facts
FOR EACH ROW EXECUTE FUNCTION opensales_validate_service_desired_state_fact();
CREATE TRIGGER service_resource_desired_state_facts_immutable
BEFORE UPDATE OR DELETE ON service_resource_desired_state_facts
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_operation_fact_mutation();

CREATE CONSTRAINT TRIGGER service_resource_operation_results_commit_pair
AFTER INSERT ON service_resource_operation_result_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opensales_check_service_operation_commit_pair();
CREATE CONSTRAINT TRIGGER service_resource_state_facts_commit_pair
AFTER INSERT ON service_resource_state_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.operation_request_id IS NOT NULL)
EXECUTE FUNCTION opensales_check_service_operation_commit_pair();
CREATE CONSTRAINT TRIGGER service_resource_desired_state_facts_commit_pair
AFTER INSERT ON service_resource_desired_state_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.operation_request_id IS NOT NULL)
EXECUTE FUNCTION opensales_check_service_operation_commit_pair();
CREATE CONSTRAINT TRIGGER service_resource_operation_requests_commit_guard
AFTER INSERT ON service_resource_operation_requests
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opensales_check_service_operation_request_commit();

CREATE CONSTRAINT TRIGGER service_resource_operation_manual_completion_pair
AFTER INSERT ON service_resource_operation_manual_completions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opensales_check_service_operation_manual_completion_pair();
CREATE CONSTRAINT TRIGGER service_resource_operation_manual_attempt_pair
AFTER INSERT ON service_resource_operation_attempt_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.attempt_kind = 'manual')
EXECUTE FUNCTION opensales_check_service_operation_manual_completion_pair();
CREATE CONSTRAINT TRIGGER service_resource_operation_manual_result_pair
AFTER INSERT ON service_resource_operation_result_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.status = 'succeeded')
EXECUTE FUNCTION opensales_check_service_operation_manual_completion_pair();
CREATE CONSTRAINT TRIGGER service_resource_operation_manual_observed_pair
AFTER INSERT ON service_resource_state_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.operation_request_id IS NOT NULL)
EXECUTE FUNCTION opensales_check_service_operation_manual_completion_pair();
CREATE CONSTRAINT TRIGGER service_resource_operation_manual_desired_pair
AFTER INSERT ON service_resource_desired_state_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.operation_request_id IS NOT NULL)
EXECUTE FUNCTION opensales_check_service_operation_manual_completion_pair();

CREATE CONSTRAINT TRIGGER service_resource_provider_operation_projection
AFTER INSERT OR UPDATE ON provider_operations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.subject_type = 'service_resource_operation')
EXECUTE FUNCTION opensales_check_service_operation_provider_projection();
CREATE CONSTRAINT TRIGGER service_resource_operation_result_provider_projection
AFTER INSERT ON service_resource_operation_result_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opensales_check_service_operation_provider_projection();
CREATE CONSTRAINT TRIGGER service_resource_operation_attempt_provider_projection
AFTER INSERT ON service_resource_operation_attempt_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opensales_check_service_operation_provider_projection();

CREATE TRIGGER services_commercial_resource_observation
AFTER INSERT OR UPDATE OF status ON services
FOR EACH ROW EXECUTE FUNCTION opensales_record_commercial_resource_observation();
