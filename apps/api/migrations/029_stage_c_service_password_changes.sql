-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Password changes are deliberately separate from daily power operations.
-- The immutable request and result history never contains the password. The
-- only durable secret-bearing row is an AES-GCM envelope, and its sole allowed
-- mutation is irreversible envelope destruction after dispatch or rejection.

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
      'resource.reboot',
      'resource.change_password'
    )
  );

CREATE TABLE service_configuration_operation_requests (
  id uuid PRIMARY KEY,
  service_id uuid NOT NULL REFERENCES services(id),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'staff')),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  actor_session_id uuid NOT NULL REFERENCES sessions(id),
  action text NOT NULL CHECK (action = 'change_password'),
  expected_service_version integer NOT NULL CHECK (expected_service_version > 0),
  expected_resource_revision integer NOT NULL CHECK (expected_resource_revision >= 0),
  provider_installation_id text NOT NULL
    REFERENCES provider_installation_capabilities(provider_installation_id),
  provider_capability_snapshot jsonb NOT NULL
    CHECK (jsonb_typeof(provider_capability_snapshot) = 'object'),
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 3 AND 1000),
  secret_digest text NOT NULL CHECK (secret_digest ~ '^[0-9a-f]{64}$'),
  secret_digest_key_version integer NOT NULL CHECK (secret_digest_key_version > 0),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  creation_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_type, actor_user_id, idempotency_key),
  CHECK ((actor_type = 'staff') = (reason IS NOT NULL))
);

CREATE INDEX service_configuration_operation_requests_service_created_idx
  ON service_configuration_operation_requests(service_id, created_at DESC, id DESC);
CREATE INDEX service_configuration_operation_requests_account_created_idx
  ON service_configuration_operation_requests(client_account_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX provider_operations_service_configuration_request_uidx
  ON provider_operations(subject_id)
  WHERE subject_type = 'service_configuration_operation';

CREATE TABLE service_configuration_secret_envelopes (
  request_id uuid PRIMARY KEY
    REFERENCES service_configuration_operation_requests(id),
  ciphertext text,
  key_version integer NOT NULL CHECK (key_version > 0),
  destroyed_at timestamptz,
  creation_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (ciphertext IS NOT NULL AND destroyed_at IS NULL)
    OR (ciphertext IS NULL AND destroyed_at IS NOT NULL)
  ),
  CHECK (
    ciphertext IS NULL
    OR (
      ciphertext ~ '^v1\.[0-9]+\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'
      AND split_part(ciphertext, '.', 2)::integer = key_version
    )
  )
);

CREATE TABLE service_configuration_operation_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES service_configuration_operation_requests(id),
  provider_operation_id uuid NOT NULL REFERENCES provider_operations(id),
  durable_job_id uuid NOT NULL REFERENCES durable_jobs(id),
  durable_job_attempts integer NOT NULL CHECK (durable_job_attempts > 0),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  attempt_kind text NOT NULL CHECK (attempt_kind IN ('mutation', 'reconcile_query')),
  actor_id text NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 200),
  started_at timestamptz NOT NULL,
  creation_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, attempt_number),
  UNIQUE (durable_job_id, durable_job_attempts, attempt_kind)
);

CREATE UNIQUE INDEX service_configuration_operation_single_mutation_uidx
  ON service_configuration_operation_attempts(request_id)
  WHERE attempt_kind = 'mutation';

CREATE TABLE service_configuration_operation_result_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES service_configuration_operation_requests(id),
  reconcile_attempt_id uuid UNIQUE
    REFERENCES service_configuration_operation_attempts(id),
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (
    status IN ('running', 'unknown', 'manual', 'succeeded', 'failed')
  ),
  provider_occurred_at timestamptz,
  error_code text CHECK (error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 100),
  detail text CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 1000),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  creation_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, revision),
  CHECK ((status IN ('failed', 'manual', 'unknown')) = (detail IS NOT NULL)),
  CHECK (status <> 'succeeded' OR provider_occurred_at IS NOT NULL),
  CHECK (
    reconcile_attempt_id IS NULL
    OR status IN ('unknown', 'manual', 'succeeded', 'failed')
  )
);

CREATE INDEX service_configuration_operation_results_latest_idx
  ON service_configuration_operation_result_facts(request_id, revision DESC);

CREATE TABLE service_configuration_operation_job_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES durable_jobs(id),
  request_id uuid NOT NULL REFERENCES service_configuration_operation_requests(id),
  from_status text NOT NULL CHECK (from_status = 'running'),
  to_status text NOT NULL CHECK (to_status IN ('completed', 'manual')),
  job_attempts integer NOT NULL CHECK (job_attempts > 0),
  worker_id text NOT NULL CHECK (char_length(worker_id) BETWEEN 1 AND 200),
  creation_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, to_status, job_attempts)
);

CREATE OR REPLACE FUNCTION opensales_reject_service_configuration_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'service configuration operation facts are append-only';
END;
$$;

CREATE OR REPLACE FUNCTION opensales_guard_service_configuration_secret_destruction()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.ciphertext IS NULL
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.key_version IS DISTINCT FROM OLD.key_version
     OR NEW.creation_transaction_id IS DISTINCT FROM OLD.creation_transaction_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.ciphertext IS NOT NULL
     OR NEW.destroyed_at IS NULL THEN
    RAISE EXCEPTION 'service configuration secret envelopes may only be destroyed once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_service_configuration_request_fingerprint(
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

CREATE OR REPLACE FUNCTION opensales_validate_service_configuration_request()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  service_row record;
  binding_row record;
  provider_row record;
  actor_allowed boolean := false;
  active_account_id uuid;
  order_item_id_value uuid;
  current_resource_revision integer;
  open_request_id uuid;
BEGIN
  NEW.creation_transaction_id := txid_current();

  IF NEW.request_fingerprint IS DISTINCT FROM
       public.opensales_service_configuration_request_fingerprint(
         CASE NEW.actor_type
           WHEN 'user' THEN 'services.change-password:v1'
           ELSE 'admin.services.change-password:v1'
         END,
         CASE NEW.actor_type
           WHEN 'user' THEN pg_catalog.jsonb_build_object(
             'serviceId', NEW.service_id::text,
             'action', NEW.action,
             'expectedServiceVersion', NEW.expected_service_version,
             'expectedResourceRevision', NEW.expected_resource_revision,
             'secretDigest', NEW.secret_digest,
             'secretDigestKeyVersion', NEW.secret_digest_key_version
           )
           ELSE pg_catalog.jsonb_build_object(
             'clientAccountId', NEW.client_account_id::text,
             'serviceId', NEW.service_id::text,
             'action', NEW.action,
             'expectedServiceVersion', NEW.expected_service_version,
             'expectedResourceRevision', NEW.expected_resource_revision,
             'secretDigest', NEW.secret_digest,
             'secretDigestKeyVersion', NEW.secret_digest_key_version,
             'reason', NEW.reason
           )
         END
       ) THEN
    RAISE EXCEPTION 'service configuration request fingerprint does not match its immutable intent';
  END IF;

  SELECT user_record.email_verified_at IS NOT NULL
         AND user_record.restricted_at IS NULL
  INTO actor_allowed
  FROM users user_record
  WHERE user_record.id = NEW.actor_user_id
  FOR UPDATE;
  IF actor_allowed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'service configuration actor is not eligible';
  END IF;
  SELECT session_record.active_client_account_id
  INTO active_account_id
  FROM sessions session_record
  WHERE session_record.id = NEW.actor_session_id
    AND session_record.user_id = NEW.actor_user_id
    AND session_record.revoked_at IS NULL
    AND session_record.expires_at > pg_catalog.clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'service configuration actor session is not eligible';
  END IF;

  IF NEW.actor_type = 'user' THEN
    PERFORM 1
    FROM client_accounts account
    WHERE account.id = NEW.client_account_id
      AND account.restricted_at IS NULL
      AND active_account_id = account.id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'service configuration Client Account is not currently eligible';
    END IF;
    PERFORM 1
    FROM client_memberships membership
    WHERE membership.client_account_id = NEW.client_account_id
      AND membership.user_id = NEW.actor_user_id
      AND membership.removed_at IS NULL
      AND membership.restricted_at IS NULL
      AND (
        membership.role IN ('owner', 'technical')
        OR membership.permissions ? '*'
        OR membership.permissions ? 'services.manage'
      )
    FOR UPDATE;
  ELSE
    PERFORM 1
    FROM staff_members staff
    WHERE staff.user_id = NEW.actor_user_id
      AND staff.active
      AND (staff.permissions ? '*' OR staff.permissions ? 'services.operations_manage')
    FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'service configuration actor is not currently authorized';
  END IF;
  PERFORM 1
  FROM reauth_grants
  WHERE user_id = NEW.actor_user_id
    AND session_id = NEW.actor_session_id
    AND invalidated_at IS NULL
    AND expires_at > pg_catalog.clock_timestamp()
  ORDER BY created_at DESC, id DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'service configuration request requires fresh password confirmation';
  END IF;

  SELECT service.order_item_id
  INTO order_item_id_value
  FROM services service
  WHERE service.id = NEW.service_id
    AND service.client_account_id = NEW.client_account_id;
  IF order_item_id_value IS NULL THEN
    RAISE EXCEPTION 'service configuration target is not an owned Service';
  END IF;
  PERFORM 1 FROM order_items WHERE id = order_item_id_value FOR UPDATE;
  SELECT service.status, service.version, service.external_resource_id,
         service.cancellation_effective_at
  INTO service_row
  FROM services service
  WHERE service.id = NEW.service_id
    AND service.client_account_id = NEW.client_account_id
  FOR UPDATE;
  IF service_row.status IS DISTINCT FROM 'active'
     OR service_row.version IS DISTINCT FROM NEW.expected_service_version
     OR service_row.external_resource_id IS NULL
     OR (
       service_row.cancellation_effective_at IS NOT NULL
       AND service_row.cancellation_effective_at <= pg_catalog.clock_timestamp()
     ) THEN
    RAISE EXCEPTION 'service configuration request does not match an active owned Service version';
  END IF;

  SELECT COALESCE((
    SELECT fact.resource_revision
    FROM service_resource_state_facts fact
    WHERE fact.service_id = NEW.service_id
    ORDER BY fact.resource_revision DESC
    LIMIT 1
  ), 0)
  INTO current_resource_revision;
  IF current_resource_revision <> NEW.expected_resource_revision THEN
    RAISE EXCEPTION 'service resource revision changed before configuration request';
  END IF;

  SELECT request.id
  INTO open_request_id
  FROM service_configuration_operation_requests request
  LEFT JOIN LATERAL (
    SELECT result.status
    FROM service_configuration_operation_result_facts result
    WHERE result.request_id = request.id
    ORDER BY result.revision DESC
    LIMIT 1
  ) latest ON true
  WHERE request.service_id = NEW.service_id
    AND COALESCE(latest.status, 'queued') NOT IN ('succeeded', 'failed', 'manual')
  ORDER BY request.created_at DESC
  LIMIT 1;
  IF open_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'service already has an unresolved configuration operation';
  END IF;

  SELECT binding.provider_installation_id, binding.capability_snapshot
  INTO binding_row
  FROM service_provider_bindings binding
  WHERE binding.service_id = NEW.service_id
  FOR UPDATE;
  SELECT provider.enabled, provider.capabilities, provider.version
  INTO provider_row
  FROM provider_installation_capabilities provider
  WHERE provider.provider_installation_id = binding_row.provider_installation_id
  FOR UPDATE;
  IF binding_row.provider_installation_id IS DISTINCT FROM 'mock-provisioning-v1'
     OR provider_row.enabled IS DISTINCT FROM true
     OR NOT (binding_row.capability_snapshot ? 'resource.change_password')
     OR NOT (provider_row.capabilities ? 'resource.change_password')
     OR NEW.provider_installation_id IS DISTINCT FROM binding_row.provider_installation_id
     OR NEW.provider_capability_snapshot IS DISTINCT FROM jsonb_build_object(
       'atBinding', binding_row.capability_snapshot,
       'current', provider_row.capabilities,
       'currentVersion', provider_row.version
     ) THEN
    RAISE EXCEPTION 'service password change lacks matching approved Mock Provider capability';
  END IF;

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
        AND EXISTS (
          SELECT 1
          FROM reauth_grants reauth
          WHERE reauth.user_id = user_record.id
            AND reauth.session_id = session_record.id
            AND reauth.invalidated_at IS NULL
            AND reauth.expires_at > pg_catalog.clock_timestamp()
        )
    ) INTO actor_allowed;
  ELSE
    SELECT EXISTS (
      SELECT 1
      FROM users user_record
      JOIN sessions session_record
        ON session_record.id = NEW.actor_session_id
       AND session_record.user_id = user_record.id
      JOIN staff_members staff ON staff.user_id = user_record.id
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
    RAISE EXCEPTION 'service configuration authorization expired while acquiring business locks';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_validate_service_configuration_envelope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_key_version integer;
BEGIN
  NEW.creation_transaction_id := txid_current();
  SELECT secret_digest_key_version
  INTO request_key_version
  FROM service_configuration_operation_requests
  WHERE id = NEW.request_id
  FOR UPDATE;
  IF request_key_version IS NULL OR request_key_version <> NEW.key_version THEN
    RAISE EXCEPTION 'service configuration secret envelope key version is not bound to its request';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_require_service_configuration_bundle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation_row record;
  job_row record;
BEGIN
  PERFORM 1
  FROM service_configuration_secret_envelopes envelope
  WHERE envelope.request_id = NEW.id
    AND envelope.ciphertext IS NOT NULL
    AND envelope.destroyed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'service configuration request lacks an active encrypted secret envelope';
  END IF;

  SELECT operation.id, operation.provider_installation_id, operation.kind,
         operation.status, operation.attempt_count
  INTO operation_row
  FROM provider_operations operation
  WHERE operation.subject_type = 'service_configuration_operation'
    AND operation.subject_id = NEW.id;
  IF operation_row.id IS NULL
     OR operation_row.provider_installation_id IS DISTINCT FROM NEW.provider_installation_id
     OR operation_row.kind IS DISTINCT FROM 'resource.change_password'
     OR operation_row.status IS DISTINCT FROM 'queued'
     OR operation_row.attempt_count <> 0 THEN
    RAISE EXCEPTION 'service configuration request lacks its queued Provider operation';
  END IF;

  SELECT job.job_type, job.payload, job.status, job.attempts
  INTO job_row
  FROM durable_jobs job
  WHERE job.job_type = 'service.password_change.start'
    AND job.unique_key = 'service-password-change:' || NEW.id::text || ':start';
  IF job_row.job_type IS NULL
     OR job_row.status IS DISTINCT FROM 'pending'
     OR job_row.attempts <> 0
     OR job_row.payload IS DISTINCT FROM jsonb_build_object(
       'requestId', NEW.id,
       'serviceId', NEW.service_id,
       'providerOperationId', operation_row.id
     ) THEN
    RAISE EXCEPTION 'service configuration request lacks its secret-free durable job';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_guard_service_configuration_provider_operation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_external_reference text;
  latest_result record;
  attempt_projection record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.subject_type = 'service_configuration_operation' THEN
      RAISE EXCEPTION 'service configuration Provider operations cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (OLD.subject_type = 'service_configuration_operation'
          OR NEW.subject_type = 'service_configuration_operation')
     AND (
       NEW.provider_installation_id IS DISTINCT FROM OLD.provider_installation_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
       OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
       OR NEW.stable_key IS DISTINCT FROM OLD.stable_key
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
     ) THEN
    RAISE EXCEPTION 'service configuration Provider operation identity is immutable';
  END IF;
  IF NEW.subject_type <> 'service_configuration_operation' THEN
    RETURN NEW;
  END IF;

  SELECT service.external_resource_id
  INTO expected_external_reference
  FROM public.service_configuration_operation_requests request
  JOIN public.services service ON service.id = request.service_id
  WHERE request.id = NEW.subject_id
    AND request.provider_installation_id = NEW.provider_installation_id
    AND request.action = 'change_password'
    AND NEW.kind = 'resource.change_password'
    AND NEW.stable_key = 'service-password-change:' || request.id::text;
  IF expected_external_reference IS NULL THEN
    RAISE EXCEPTION 'service configuration Provider operation does not match its request';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'queued'
       OR NEW.attempt_count <> 0
       OR NEW.last_error IS NOT NULL
       OR NEW.external_reference IS NOT NULL
       OR NEW.provider_occurred_at IS NOT NULL THEN
      RAISE EXCEPTION 'service configuration Provider operation must start queued and pristine';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'terminal service configuration Provider operation is immutable';
  END IF;
  IF NEW.status = OLD.status
     OR (OLD.status = 'queued' AND NEW.status NOT IN ('running', 'failed'))
     OR (OLD.status = 'running' AND NEW.status NOT IN ('unknown', 'succeeded', 'failed'))
     OR (OLD.status = 'unknown' AND NEW.status NOT IN ('succeeded', 'failed')) THEN
    RAISE EXCEPTION 'service configuration Provider operation transition is invalid';
  END IF;
  IF (OLD.status = 'queued' AND NEW.status = 'running'
      AND (OLD.attempt_count <> 0 OR NEW.attempt_count <> 1))
     OR (NOT (OLD.status = 'queued' AND NEW.status = 'running')
         AND NEW.attempt_count IS DISTINCT FROM OLD.attempt_count)
     OR NEW.attempt_count NOT IN (0, 1) THEN
    RAISE EXCEPTION 'service password mutation count may advance from zero to one exactly once';
  END IF;

  SELECT result.status, result.error_code, result.evidence,
         result.creation_transaction_id
  INTO latest_result
  FROM public.service_configuration_operation_result_facts result
  WHERE result.request_id = NEW.subject_id
  ORDER BY result.revision DESC
  LIMIT 1;
  SELECT count(*)::integer AS total_count,
         count(*) FILTER (WHERE attempt.attempt_kind = 'mutation')::integer AS mutation_count,
         max(attempt.attempt_number)::integer AS latest_attempt_number
  INTO attempt_projection
  FROM public.service_configuration_operation_attempts attempt
  WHERE attempt.request_id = NEW.subject_id
    AND attempt.provider_operation_id = NEW.id;
  IF latest_result IS NULL
     OR latest_result.creation_transaction_id <> txid_current()
     OR (NEW.status = 'running' AND latest_result.status <> 'running')
     OR (NEW.status = 'unknown' AND latest_result.status NOT IN ('unknown', 'manual'))
     OR (NEW.status = 'succeeded' AND latest_result.status <> 'succeeded')
     OR (NEW.status = 'failed' AND latest_result.status <> 'failed') THEN
    RAISE EXCEPTION 'service configuration Provider status must project the latest same-transaction result';
  END IF;
  IF NEW.attempt_count = 1 AND (
       attempt_projection.mutation_count <> 1
       OR attempt_projection.total_count < 1
       OR attempt_projection.latest_attempt_number <> attempt_projection.total_count
     ) THEN
    RAISE EXCEPTION 'service configuration Provider operation lacks contiguous attempt facts';
  END IF;
  IF NEW.attempt_count = 0 AND (
       attempt_projection.total_count <> 0
       OR NEW.status <> 'failed'
       OR latest_result.error_code <> 'dispatch_preflight_rejected'
       OR latest_result.evidence -> 'providerCalled' <> 'false'::jsonb
     ) THEN
    RAISE EXCEPTION 'zero-attempt password-change failure must be a dispatch preflight rejection';
  END IF;
  IF NEW.status IN ('running', 'unknown', 'failed')
     AND NEW.external_reference IS NOT NULL THEN
    RAISE EXCEPTION 'non-successful service configuration Provider operation cannot claim a resource';
  END IF;
  IF NEW.status = 'succeeded' AND (
       NEW.external_reference IS DISTINCT FROM expected_external_reference
       OR NEW.last_error IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'successful service configuration Provider projection is incomplete';
  END IF;
  IF NEW.status IN ('unknown', 'failed') AND NEW.last_error IS NULL THEN
    RAISE EXCEPTION 'unknown or failed service configuration Provider operation requires a bounded error';
  END IF;
  IF NEW.status = 'running' AND (
       NEW.last_error IS NOT NULL OR NEW.external_reference IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'running service configuration Provider operation must remain non-terminal';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_validate_service_configuration_attempt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_row record;
  operation_row record;
  previous_attempt_number integer;
  reconcile_attempt_count integer;
  latest_result_status text;
  lease_row record;
BEGIN
  NEW.creation_transaction_id := txid_current();
  SELECT request.provider_installation_id, request.service_id,
         request.actor_type, request.actor_user_id, request.actor_session_id,
         request.client_account_id
  INTO request_row
  FROM public.service_configuration_operation_requests request
  WHERE request.id = NEW.request_id;
  IF request_row IS NULL THEN
    RAISE EXCEPTION 'service configuration attempt references a missing request';
  END IF;
  SELECT provider.provider_installation_id, provider.kind,
         provider.subject_type, provider.subject_id, provider.stable_key,
         provider.status, provider.attempt_count
  INTO operation_row
  FROM public.provider_operations provider
  WHERE provider.id = NEW.provider_operation_id;
  IF operation_row IS NULL
     OR operation_row.provider_installation_id <> request_row.provider_installation_id
     OR operation_row.kind <> 'resource.change_password'
     OR operation_row.subject_type <> 'service_configuration_operation'
     OR operation_row.subject_id <> NEW.request_id
     OR operation_row.stable_key <> 'service-password-change:' || NEW.request_id::text THEN
    RAISE EXCEPTION 'service configuration attempt does not match its Provider operation';
  END IF;
  SELECT max(attempt.attempt_number),
         count(*) FILTER (WHERE attempt.attempt_kind = 'reconcile_query')::integer
  INTO previous_attempt_number, reconcile_attempt_count
  FROM public.service_configuration_operation_attempts attempt
  WHERE attempt.request_id = NEW.request_id;
  SELECT result.status
  INTO latest_result_status
  FROM public.service_configuration_operation_result_facts result
  WHERE result.request_id = NEW.request_id
  ORDER BY result.revision DESC
  LIMIT 1;
  IF NEW.attempt_number <> COALESCE(previous_attempt_number, 0) + 1 THEN
    RAISE EXCEPTION 'service configuration attempt number is not contiguous';
  END IF;

  SELECT job.job_type, job.unique_key, job.payload, job.status,
         job.attempts, job.locked_at, job.locked_by
  INTO lease_row
  FROM public.durable_jobs job
  WHERE job.id = NEW.durable_job_id
  FOR UPDATE;
  IF lease_row IS NULL
     OR lease_row.status <> 'running'
     OR lease_row.attempts <> NEW.durable_job_attempts
     OR lease_row.locked_at IS NULL
     OR lease_row.locked_by IS DISTINCT FROM NEW.actor_id
     OR NEW.started_at < lease_row.locked_at
     OR lease_row.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
       'requestId', NEW.request_id::text,
       'serviceId', request_row.service_id::text,
       'providerOperationId', NEW.provider_operation_id::text
     ) THEN
    RAISE EXCEPTION 'service configuration attempt requires its exact active Worker lease';
  END IF;

  IF NEW.attempt_kind = 'mutation' THEN
    IF previous_attempt_number IS NOT NULL
       OR lease_row.job_type <> 'service.password_change.start'
       OR lease_row.unique_key <> 'service-password-change:' || NEW.request_id::text || ':start'
       OR operation_row.status <> 'queued'
       OR operation_row.attempt_count <> 0
       OR latest_result_status IS NOT NULL
       OR NOT EXISTS (
         SELECT 1
         FROM public.service_configuration_secret_envelopes envelope
         WHERE envelope.request_id = NEW.request_id
           AND envelope.ciphertext IS NOT NULL
           AND envelope.destroyed_at IS NULL
       ) THEN
      RAISE EXCEPTION 'service password mutation attempt is not eligible';
    END IF;

    PERFORM 1
    FROM public.users actor
    WHERE actor.id = request_row.actor_user_id
      AND actor.email_verified_at IS NOT NULL
      AND actor.restricted_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'service password mutation actor is not eligible';
    END IF;
    IF request_row.actor_type = 'user' THEN
      PERFORM 1
      FROM public.sessions session_record
      WHERE session_record.id = request_row.actor_session_id
        AND session_record.user_id = request_row.actor_user_id
        AND session_record.revoked_at IS NULL
        AND session_record.expires_at > pg_catalog.clock_timestamp()
        AND session_record.active_client_account_id = request_row.client_account_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'service password mutation customer session is not eligible';
      END IF;
      PERFORM 1
      FROM public.client_accounts account
      WHERE account.id = request_row.client_account_id
        AND account.restricted_at IS NULL
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'service password mutation Client Account is not eligible';
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
        RAISE EXCEPTION 'service password mutation customer authority is not eligible';
      END IF;
    ELSE
      PERFORM 1
      FROM public.sessions session_record
      WHERE session_record.id = request_row.actor_session_id
        AND session_record.user_id = request_row.actor_user_id
        AND session_record.revoked_at IS NULL
        AND session_record.expires_at > pg_catalog.clock_timestamp()
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'service password mutation Staff session is not eligible';
      END IF;
      PERFORM 1
      FROM public.staff_members staff
      WHERE staff.user_id = request_row.actor_user_id
        AND staff.active
        AND (staff.permissions ? '*' OR staff.permissions ? 'services.operations_manage')
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'service password mutation Staff authority is not eligible';
      END IF;
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
      RAISE EXCEPTION 'service password mutation reauthentication is not fresh';
    END IF;
  ELSE
    PERFORM 1
    FROM public.service_configuration_operation_attempts prior_attempt
    LEFT JOIN public.service_configuration_operation_result_facts observation
      ON observation.reconcile_attempt_id = prior_attempt.id
    WHERE prior_attempt.request_id = NEW.request_id
      AND prior_attempt.attempt_kind = 'reconcile_query'
      AND observation.id IS NULL
    ORDER BY prior_attempt.attempt_number
    LIMIT 1
    FOR UPDATE OF prior_attempt;
    IF FOUND THEN
      RAISE EXCEPTION 'service password reconciliation must reuse its outstanding query dispatch';
    END IF;
    IF lease_row.job_type <> 'service.password_change.reconcile'
       OR lease_row.unique_key <> 'service-password-change:' || NEW.request_id::text || ':reconcile'
       OR reconcile_attempt_count >= 3
       OR operation_row.status <> 'unknown'
       OR operation_row.attempt_count <> 1
       OR latest_result_status <> 'unknown'
       OR NOT EXISTS (
         SELECT 1
         FROM public.service_configuration_operation_attempts mutation
         WHERE mutation.request_id = NEW.request_id
           AND mutation.attempt_kind = 'mutation'
       )
       OR NOT EXISTS (
         SELECT 1
         FROM public.service_configuration_secret_envelopes envelope
         WHERE envelope.request_id = NEW.request_id
           AND envelope.ciphertext IS NULL
           AND envelope.destroyed_at IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'service password reconciliation query is not eligible';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_validate_service_configuration_result()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_row record;
  operation_row record;
  reconcile_attempt record;
  evidence_key_count integer;
BEGIN
  NEW.creation_transaction_id := txid_current();
  PERFORM 1
  FROM public.service_configuration_operation_requests request
  WHERE request.id = NEW.request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'service configuration result references a missing request';
  END IF;
  SELECT result.revision, result.status
  INTO previous_row
  FROM public.service_configuration_operation_result_facts result
  WHERE result.request_id = NEW.request_id
  ORDER BY result.revision DESC
  LIMIT 1;
  IF NEW.revision <> COALESCE(previous_row.revision, 0) + 1
     OR previous_row.status IN ('succeeded', 'failed', 'manual')
     OR (previous_row IS NULL AND NEW.status NOT IN ('running', 'failed'))
     OR (previous_row.status = 'running'
         AND NEW.status NOT IN ('unknown', 'manual', 'succeeded', 'failed'))
     OR (previous_row.status = 'unknown'
         AND NEW.status NOT IN ('unknown', 'manual', 'succeeded', 'failed')) THEN
    RAISE EXCEPTION 'service configuration result transition is invalid';
  END IF;
  SELECT operation.id, operation.status, operation.attempt_count
  INTO operation_row
  FROM public.provider_operations operation
  WHERE operation.subject_type = 'service_configuration_operation'
    AND operation.subject_id = NEW.request_id;
  IF operation_row IS NULL THEN
    RAISE EXCEPTION 'service configuration result lacks its Provider operation';
  END IF;
  SELECT count(*)::integer
  INTO evidence_key_count
  FROM pg_catalog.jsonb_object_keys(NEW.evidence);
  IF NEW.evidence ?| ARRAY[
       'password', 'newPassword', 'secret', 'ciphertext', 'secretDigest', 'secret_digest'
     ] OR NEW.evidence -> 'providerCalled' NOT IN ('true'::jsonb, 'false'::jsonb) THEN
    RAISE EXCEPTION 'service configuration result evidence is not secret-free and bounded';
  END IF;

  IF NEW.reconcile_attempt_id IS NOT NULL THEN
    SELECT attempt.id, attempt.request_id, attempt.provider_operation_id,
           attempt.durable_job_id, attempt.durable_job_attempts,
           attempt.attempt_kind
    INTO reconcile_attempt
    FROM public.service_configuration_operation_attempts attempt
    WHERE attempt.id = NEW.reconcile_attempt_id;
    IF reconcile_attempt IS NULL
       OR reconcile_attempt.request_id <> NEW.request_id
       OR reconcile_attempt.provider_operation_id <> operation_row.id
       OR reconcile_attempt.attempt_kind <> 'reconcile_query'
       OR NEW.evidence ->> 'attemptId' <> NEW.reconcile_attempt_id::text
       OR NEW.evidence ->> 'queryIdentity' <>
         'service-password-change-query:' || NEW.reconcile_attempt_id::text THEN
      RAISE EXCEPTION 'service configuration result does not bind its exact reconciliation query';
    END IF;
  ELSIF NEW.evidence ? 'attemptId' OR NEW.evidence ? 'queryIdentity' THEN
    RAISE EXCEPTION 'service configuration result claims a reconciliation identity without its fact';
  END IF;

  IF NEW.status = 'running' THEN
    IF previous_row IS NOT NULL
       OR NEW.reconcile_attempt_id IS NOT NULL
       OR NEW.error_code IS NOT NULL
       OR NEW.detail IS NOT NULL
       OR NEW.provider_occurred_at IS NOT NULL
       OR NEW.evidence <> pg_catalog.jsonb_build_object(
         'providerCalled', false,
         'dispatchPreflight', true
       ) THEN
      RAISE EXCEPTION 'running service configuration result is not the exact dispatch projection';
    END IF;
  ELSIF previous_row IS NULL THEN
    IF NEW.status <> 'failed'
       OR NEW.error_code <> 'dispatch_preflight_rejected'
       OR NEW.reconcile_attempt_id IS NOT NULL
       OR NEW.provider_occurred_at IS NOT NULL
       OR NEW.evidence <> pg_catalog.jsonb_build_object('providerCalled', false) THEN
      RAISE EXCEPTION 'initial service configuration failure is not a bounded preflight rejection';
    END IF;
  ELSIF NEW.status = 'succeeded' THEN
    IF NEW.evidence -> 'providerCalled' <> 'true'::jsonb
       OR NOT (NEW.evidence ? 'providerRevision')
       OR NEW.error_code IS NOT NULL
       OR NEW.detail IS NOT NULL
       OR NEW.provider_occurred_at IS NULL THEN
      RAISE EXCEPTION 'successful service configuration result lacks Provider evidence';
    END IF;
  ELSIF NEW.status = 'unknown' THEN
    IF NEW.evidence -> 'providerCalled' <> 'true'::jsonb
       OR NEW.error_code IS NULL
       OR NEW.detail IS NULL
       OR (NEW.reconcile_attempt_id IS NULL AND evidence_key_count <> 1)
       OR (NEW.reconcile_attempt_id IS NOT NULL AND NOT (NEW.evidence ? 'observation')) THEN
      RAISE EXCEPTION 'unknown service configuration result lacks bounded reconciliation evidence';
    END IF;
  ELSIF NEW.status = 'manual' THEN
    IF NEW.evidence -> 'providerCalled' <> 'true'::jsonb
       OR NEW.error_code IS NULL
       OR NEW.detail IS NULL THEN
      RAISE EXCEPTION 'manual service configuration result lacks bounded evidence';
    END IF;
  ELSIF NEW.status = 'failed' THEN
    IF NEW.error_code IS NULL OR NEW.detail IS NULL THEN
      RAISE EXCEPTION 'failed service configuration result lacks a bounded reason';
    END IF;
    IF NEW.evidence -> 'providerCalled' = 'true'::jsonb
       AND NOT (NEW.evidence ? 'providerRevision') THEN
      RAISE EXCEPTION 'Provider-reported password failure lacks a Provider revision';
    END IF;
    IF NEW.evidence -> 'providerCalled' = 'false'::jsonb
       AND NEW.error_code NOT IN ('dispatch_preflight_rejected', 'secret_envelope_unavailable') THEN
      RAISE EXCEPTION 'non-Provider password failure is not an approved bounded state';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_guard_service_configuration_job()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_id_value uuid;
  service_id_value uuid;
  provider_operation_id_value uuid;
  expected_unique_key text;
  operation_row record;
  latest_result record;
  mutation_count_value integer;
  reconcile_count_value integer;
  outstanding_reconcile_count_value integer;
  transition_count_value integer;
  reconcile_job_count_value integer;
  envelope_active boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.job_type IN (
      'service.password_change.start',
      'service.password_change.reconcile'
    ) THEN
      RAISE EXCEPTION 'service password-change durable jobs cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (OLD.job_type IN (
            'service.password_change.start',
            'service.password_change.reconcile'
          )
          OR NEW.job_type IN (
            'service.password_change.start',
            'service.password_change.reconcile'
          ))
     AND (
       NEW.job_type IS DISTINCT FROM OLD.job_type
       OR NEW.unique_key IS DISTINCT FROM OLD.unique_key
       OR NEW.payload IS DISTINCT FROM OLD.payload
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
     ) THEN
    RAISE EXCEPTION 'service password-change job identity and payload are immutable';
  END IF;
  IF NEW.job_type NOT IN (
       'service.password_change.start',
       'service.password_change.reconcile'
     ) THEN
    RETURN NEW;
  END IF;

  BEGIN
    request_id_value := (NEW.payload ->> 'requestId')::uuid;
    service_id_value := (NEW.payload ->> 'serviceId')::uuid;
    provider_operation_id_value := (NEW.payload ->> 'providerOperationId')::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'service password-change job payload identifiers are invalid';
  END;
  IF NEW.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
       'requestId', request_id_value::text,
       'serviceId', service_id_value::text,
       'providerOperationId', provider_operation_id_value::text
     ) THEN
    RAISE EXCEPTION 'service password-change job payload must contain exactly three identifiers';
  END IF;
  expected_unique_key := 'service-password-change:' || request_id_value::text ||
    CASE NEW.job_type
      WHEN 'service.password_change.start' THEN ':start'
      ELSE ':reconcile'
    END;
  IF NEW.unique_key <> expected_unique_key OR NOT EXISTS (
    SELECT 1
    FROM public.service_configuration_operation_requests request
    JOIN public.provider_operations operation
      ON operation.id = provider_operation_id_value
     AND operation.subject_type = 'service_configuration_operation'
     AND operation.subject_id = request.id
     AND operation.provider_installation_id = request.provider_installation_id
     AND operation.kind = 'resource.change_password'
     AND operation.stable_key = 'service-password-change:' || request.id::text
    WHERE request.id = request_id_value
      AND request.service_id = service_id_value
  ) THEN
    RAISE EXCEPTION 'service password-change job does not match its request and Provider operation';
  END IF;

  SELECT operation.status, operation.attempt_count
  INTO operation_row
  FROM public.provider_operations operation
  WHERE operation.id = provider_operation_id_value;
  SELECT result.status, result.error_code, result.reconcile_attempt_id,
         result.creation_transaction_id
  INTO latest_result
  FROM public.service_configuration_operation_result_facts result
  WHERE result.request_id = request_id_value
  ORDER BY result.revision DESC
  LIMIT 1;
  SELECT count(*) FILTER (WHERE attempt.attempt_kind = 'mutation')::integer,
         count(*) FILTER (WHERE attempt.attempt_kind = 'reconcile_query')::integer,
         count(*) FILTER (
           WHERE attempt.attempt_kind = 'reconcile_query'
             AND observation.reconcile_attempt_id IS NULL
         )::integer
  INTO mutation_count_value, reconcile_count_value,
       outstanding_reconcile_count_value
  FROM public.service_configuration_operation_attempts attempt
  LEFT JOIN public.service_configuration_operation_result_facts observation
    ON observation.reconcile_attempt_id = attempt.id
  WHERE attempt.request_id = request_id_value;
  SELECT envelope.ciphertext IS NOT NULL AND envelope.destroyed_at IS NULL
  INTO envelope_active
  FROM public.service_configuration_secret_envelopes envelope
  WHERE envelope.request_id = request_id_value;
  IF envelope_active IS NULL THEN
    RAISE EXCEPTION 'service password-change job lacks its encrypted envelope projection';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending'
       OR NEW.attempts <> 0
       OR NEW.locked_at IS NOT NULL
       OR NEW.locked_by IS NOT NULL
       OR NEW.last_error IS NOT NULL
       OR (NEW.job_type = 'service.password_change.start' AND NOT (
         operation_row.status = 'queued'
         AND operation_row.attempt_count = 0
         AND latest_result IS NULL
         AND mutation_count_value = 0
         AND reconcile_count_value = 0
         AND envelope_active
       ))
       OR (NEW.job_type = 'service.password_change.reconcile' AND NOT (
         operation_row.status = 'unknown'
         AND operation_row.attempt_count = 1
         AND latest_result.status = 'unknown'
         AND mutation_count_value = 1
         AND envelope_active = false
         AND reconcile_count_value = 0
         AND outstanding_reconcile_count_value = 0
       )) THEN
      RAISE EXCEPTION 'service password-change job must start pending with an exact eligible projection';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    IF OLD.status = 'pending'
       AND NEW.attempts = OLD.attempts
       AND NEW.locked_at IS NULL
       AND NEW.locked_by IS NULL
       AND (
         (NEW.job_type = 'service.password_change.start'
          AND operation_row.status = 'queued'
          AND latest_result IS NULL
          AND mutation_count_value = 0
          AND envelope_active)
         OR
         (NEW.job_type = 'service.password_change.reconcile'
          AND operation_row.status = 'unknown'
          AND latest_result.status = 'unknown'
          AND mutation_count_value = 1
          AND envelope_active = false)
       ) THEN
      RETURN NEW;
    END IF;
    IF OLD.status = 'manual'
       AND NEW.attempts = OLD.attempts
       AND NEW.locked_at IS NULL
       AND NEW.locked_by IS NULL
       AND latest_result.status = 'manual'
       AND envelope_active = false THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'leased or terminal service password-change job is immutable';
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'running' THEN
    IF NEW.attempts <> OLD.attempts + 1
       OR NEW.locked_at IS NULL
       OR NEW.locked_by IS NULL
       OR NEW.available_at > pg_catalog.clock_timestamp()
       OR (NEW.job_type = 'service.password_change.start' AND NOT (
         operation_row.status = 'queued'
         AND operation_row.attempt_count = 0
         AND latest_result IS NULL
         AND mutation_count_value = 0
         AND envelope_active
       ))
       OR (NEW.job_type = 'service.password_change.reconcile' AND NOT (
         operation_row.status = 'unknown'
         AND operation_row.attempt_count = 1
         AND latest_result.status = 'unknown'
         AND mutation_count_value = 1
         AND envelope_active = false
         -- At exactly three closed GET facts, allow one final no-dispatch claim
         -- so Worker preflight can atomically record exhausted/manual.
         AND (reconcile_count_value <= 3 OR outstanding_reconcile_count_value = 1)
       )) THEN
      RAISE EXCEPTION 'service password-change job claim is not eligible';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'running' AND NEW.status = 'pending' THEN
    IF NEW.attempts <> OLD.attempts
       OR NEW.locked_at IS NOT NULL
       OR NEW.locked_by IS NOT NULL
       OR NEW.last_error IS NULL
       OR (NEW.job_type = 'service.password_change.start' AND NOT (
         operation_row.status = 'queued'
         AND latest_result IS NULL
         AND mutation_count_value = 0
         AND envelope_active
       ))
       OR (NEW.job_type = 'service.password_change.reconcile' AND NOT (
         operation_row.status = 'unknown'
         AND latest_result.status = 'unknown'
         AND mutation_count_value = 1
         AND envelope_active = false
         AND outstanding_reconcile_count_value IN (0, 1)
       )) THEN
      RAISE EXCEPTION 'service password-change job cannot be rescheduled from its projection';
    END IF;
    RETURN NEW;
  END IF;

  SELECT count(*)::integer
  INTO transition_count_value
  FROM public.service_configuration_operation_job_transitions transition
  WHERE transition.job_id = NEW.id
    AND transition.request_id = request_id_value
    AND transition.from_status = OLD.status
    AND transition.to_status = NEW.status
    AND transition.job_attempts = NEW.attempts
    AND transition.worker_id = OLD.locked_by
    AND transition.creation_transaction_id = txid_current();
  IF OLD.status = 'running' AND NEW.status = 'completed' THEN
    SELECT count(*)::integer
    INTO reconcile_job_count_value
    FROM public.durable_jobs reconcile_job
    WHERE reconcile_job.job_type = 'service.password_change.reconcile'
      AND reconcile_job.unique_key =
        'service-password-change:' || request_id_value::text || ':reconcile'
      AND reconcile_job.payload = NEW.payload
      AND reconcile_job.status IN ('pending', 'running');
    IF NEW.attempts <> OLD.attempts
       OR NEW.locked_at IS NOT NULL
       OR NEW.locked_by IS NOT NULL
       OR NEW.last_error IS NOT NULL
       OR envelope_active
       OR transition_count_value <> 1
       OR latest_result IS NULL
       OR NOT (
         (latest_result.status IN ('succeeded', 'failed')
          AND operation_row.status = latest_result.status)
         OR
         (NEW.job_type = 'service.password_change.start'
          AND latest_result.status = 'unknown'
          AND operation_row.status = 'unknown'
          AND reconcile_job_count_value = 1)
       ) THEN
      RAISE EXCEPTION 'completed service password-change job lacks its atomic terminal projection';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'running' AND NEW.status = 'manual' THEN
    IF NEW.attempts <> OLD.attempts
       OR NEW.locked_at IS NOT NULL
       OR NEW.locked_by IS NOT NULL
       OR NEW.last_error IS NULL
       OR envelope_active
       OR latest_result.status <> 'manual'
       OR operation_row.status <> 'unknown'
       OR transition_count_value <> 1 THEN
      RAISE EXCEPTION 'manual service password-change job lacks its atomic manual projection';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'service password-change job transition is invalid';
END;
$$;

CREATE OR REPLACE FUNCTION opensales_validate_service_configuration_job_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_row record;
  latest_result record;
  operation_status_value text;
  reconcile_job_count_value integer;
  envelope_destroyed boolean;
BEGIN
  NEW.creation_transaction_id := txid_current();
  SELECT job.job_type, job.payload, job.status, job.attempts, job.locked_by
  INTO job_row
  FROM public.durable_jobs job
  WHERE job.id = NEW.job_id
  FOR UPDATE;
  IF job_row IS NULL
     OR job_row.job_type NOT IN (
       'service.password_change.start',
       'service.password_change.reconcile'
     )
     OR job_row.status <> 'running'
     OR job_row.status <> NEW.from_status
     OR job_row.attempts <> NEW.job_attempts
     OR job_row.locked_by IS DISTINCT FROM NEW.worker_id
     OR job_row.payload ->> 'requestId' <> NEW.request_id::text THEN
    RAISE EXCEPTION 'service password-change transition does not match its active lease';
  END IF;
  SELECT result.status, result.reconcile_attempt_id
  INTO latest_result
  FROM public.service_configuration_operation_result_facts result
  WHERE result.request_id = NEW.request_id
  ORDER BY result.revision DESC
  LIMIT 1;
  SELECT operation.status
  INTO operation_status_value
  FROM public.provider_operations operation
  WHERE operation.id = (job_row.payload ->> 'providerOperationId')::uuid
    AND operation.subject_type = 'service_configuration_operation'
    AND operation.subject_id = NEW.request_id;
  SELECT envelope.ciphertext IS NULL AND envelope.destroyed_at IS NOT NULL
  INTO envelope_destroyed
  FROM public.service_configuration_secret_envelopes envelope
  WHERE envelope.request_id = NEW.request_id;
  IF envelope_destroyed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'terminal service password-change transition requires destroyed envelope';
  END IF;
  IF NEW.to_status = 'manual' THEN
    IF latest_result.status = 'manual' AND operation_status_value = 'unknown' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'manual service password-change transition lacks its manual result';
  END IF;
  IF latest_result.status IN ('succeeded', 'failed')
     AND operation_status_value = latest_result.status THEN
    RETURN NEW;
  END IF;
  IF latest_result.status = 'unknown'
     AND job_row.job_type = 'service.password_change.start'
     AND operation_status_value = 'unknown' THEN
    SELECT count(*)::integer
    INTO reconcile_job_count_value
    FROM public.durable_jobs reconcile_job
    WHERE reconcile_job.job_type = 'service.password_change.reconcile'
      AND reconcile_job.unique_key =
        'service-password-change:' || NEW.request_id::text || ':reconcile'
      AND reconcile_job.payload = job_row.payload
      AND reconcile_job.status IN ('pending', 'running');
    IF reconcile_job_count_value = 1 THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'completed service password-change transition lacks terminal or GET-only projection';
END;
$$;

CREATE OR REPLACE FUNCTION opensales_check_service_configuration_job_transition_commit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_row record;
BEGIN
  SELECT status, attempts, locked_at, locked_by, last_error
  INTO job_row
  FROM public.durable_jobs
  WHERE id = NEW.job_id;
  IF job_row IS NULL
     OR job_row.status <> NEW.to_status
     OR job_row.attempts <> NEW.job_attempts
     OR job_row.locked_at IS NOT NULL
     OR job_row.locked_by IS NOT NULL
     OR (NEW.to_status = 'completed' AND job_row.last_error IS NOT NULL)
     OR (NEW.to_status = 'manual' AND job_row.last_error IS NULL)
     OR NEW.creation_transaction_id <> txid_current() THEN
    RAISE EXCEPTION 'service password-change transition must atomically pair its terminal job';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_check_service_configuration_result_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_row record;
  latest_revision_value integer;
  authority_count integer;
  envelope_destroyed boolean;
BEGIN
  SELECT request.service_id
  INTO request_row
  FROM public.service_configuration_operation_requests request
  WHERE request.id = NEW.request_id;
  SELECT max(result.revision)
  INTO latest_revision_value
  FROM public.service_configuration_operation_result_facts result
  WHERE result.request_id = NEW.request_id;
  IF latest_revision_value > NEW.revision THEN
    RETURN NULL;
  END IF;

  IF NEW.status = 'running' THEN
    SELECT count(*)::integer
    INTO authority_count
    FROM public.provider_operations operation
    JOIN public.service_configuration_operation_attempts attempt
      ON attempt.request_id = NEW.request_id
     AND attempt.provider_operation_id = operation.id
     AND attempt.attempt_kind = 'mutation'
     AND attempt.creation_transaction_id = NEW.creation_transaction_id
    JOIN public.durable_jobs job
      ON job.id = attempt.durable_job_id
     AND job.job_type = 'service.password_change.start'
     AND job.unique_key =
       'service-password-change:' || NEW.request_id::text || ':start'
     AND job.payload = pg_catalog.jsonb_build_object(
       'requestId', NEW.request_id::text,
       'serviceId', request_row.service_id::text,
       'providerOperationId', operation.id::text
     )
     AND job.status = 'running'
     AND job.attempts = attempt.durable_job_attempts
     AND job.locked_at IS NOT NULL
     AND job.locked_by = attempt.actor_id
    JOIN public.service_configuration_secret_envelopes envelope
      ON envelope.request_id = NEW.request_id
     AND envelope.ciphertext IS NOT NULL
     AND envelope.destroyed_at IS NULL
    WHERE operation.subject_type = 'service_configuration_operation'
      AND operation.subject_id = NEW.request_id
      AND operation.status = 'running'
      AND operation.attempt_count = 1;
    IF authority_count <> 1 THEN
      RAISE EXCEPTION 'running service configuration result lacks its exact mutation lease';
    END IF;
    RETURN NULL;
  END IF;

  SELECT envelope.ciphertext IS NULL AND envelope.destroyed_at IS NOT NULL
  INTO envelope_destroyed
  FROM public.service_configuration_secret_envelopes envelope
  WHERE envelope.request_id = NEW.request_id;
  IF envelope_destroyed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'non-running service configuration result requires a destroyed envelope';
  END IF;

  IF NEW.status = 'unknown' AND NEW.reconcile_attempt_id IS NOT NULL THEN
    SELECT count(*)::integer
    INTO authority_count
    FROM public.service_configuration_operation_attempts attempt
    JOIN public.durable_jobs job
      ON job.id = attempt.durable_job_id
     AND job.job_type = 'service.password_change.reconcile'
     AND job.unique_key =
       'service-password-change:' || NEW.request_id::text || ':reconcile'
     AND job.payload ->> 'requestId' = NEW.request_id::text
     AND job.payload ->> 'serviceId' = request_row.service_id::text
     AND job.payload ->> 'providerOperationId' = attempt.provider_operation_id::text
     AND job.status = 'pending'
     AND job.attempts >= attempt.durable_job_attempts
     AND job.locked_at IS NULL
     AND job.locked_by IS NULL
     AND job.last_error IS NOT NULL
    JOIN public.provider_operations operation
      ON operation.id = attempt.provider_operation_id
     AND operation.subject_type = 'service_configuration_operation'
     AND operation.subject_id = NEW.request_id
     AND operation.status = 'unknown'
    WHERE attempt.id = NEW.reconcile_attempt_id
      AND attempt.request_id = NEW.request_id
      AND attempt.attempt_kind = 'reconcile_query';
    IF authority_count <> 1 THEN
      RAISE EXCEPTION 'unknown reconciliation observation lacks its exact rescheduled GET job';
    END IF;
    RETURN NULL;
  END IF;

  SELECT count(*)::integer
  INTO authority_count
  FROM public.service_configuration_operation_job_transitions transition
  JOIN public.durable_jobs job
    ON job.id = transition.job_id
   AND job.payload ->> 'requestId' = NEW.request_id::text
   AND job.payload ->> 'serviceId' = request_row.service_id::text
   AND job.status = transition.to_status
  JOIN public.provider_operations operation
    ON operation.id = (job.payload ->> 'providerOperationId')::uuid
   AND operation.subject_type = 'service_configuration_operation'
   AND operation.subject_id = NEW.request_id
  WHERE transition.request_id = NEW.request_id
    AND transition.creation_transaction_id = NEW.creation_transaction_id
    AND (
      job.job_type = 'service.password_change.start'
      OR (
        job.job_type = 'service.password_change.reconcile'
        AND (
          (
            NEW.reconcile_attempt_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM public.service_configuration_operation_attempts attempt
              WHERE attempt.id = NEW.reconcile_attempt_id
                AND attempt.request_id = NEW.request_id
                AND attempt.provider_operation_id = operation.id
                AND attempt.durable_job_id = job.id
                AND attempt.attempt_kind = 'reconcile_query'
                AND attempt.durable_job_attempts <= transition.job_attempts
            )
          )
          OR (
            NEW.reconcile_attempt_id IS NULL
            AND NEW.status = 'manual'
            AND NEW.error_code IN ('reconcile_exhausted', 'reconcile_worker_failure')
          )
        )
      )
    )
    AND (
      (NEW.status = 'unknown'
       AND transition.to_status = 'completed'
       AND job.job_type = 'service.password_change.start'
       AND operation.status = 'unknown')
      OR
      (NEW.status = 'manual'
       AND transition.to_status = 'manual'
       AND operation.status = 'unknown')
      OR
      (NEW.status IN ('succeeded', 'failed')
       AND transition.to_status = 'completed'
       AND operation.status = NEW.status)
    );
  IF authority_count <> 1 THEN
    RAISE EXCEPTION 'service configuration result lacks exact same-transaction Worker authority';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_check_service_configuration_reconcile_dispatch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_row record;
  operation_status_value text;
  latest_result_status_value text;
  envelope_destroyed boolean;
BEGIN
  IF NEW.attempt_kind <> 'reconcile_query' THEN
    RETURN NULL;
  END IF;
  SELECT job.job_type, job.unique_key, job.payload, job.status,
         job.attempts, job.locked_at, job.locked_by
  INTO job_row
  FROM public.durable_jobs job
  WHERE job.id = NEW.durable_job_id;
  SELECT operation.status
  INTO operation_status_value
  FROM public.provider_operations operation
  WHERE operation.id = NEW.provider_operation_id
    AND operation.subject_type = 'service_configuration_operation'
    AND operation.subject_id = NEW.request_id;
  SELECT result.status
  INTO latest_result_status_value
  FROM public.service_configuration_operation_result_facts result
  WHERE result.request_id = NEW.request_id
  ORDER BY result.revision DESC
  LIMIT 1;
  SELECT envelope.ciphertext IS NULL AND envelope.destroyed_at IS NOT NULL
  INTO envelope_destroyed
  FROM public.service_configuration_secret_envelopes envelope
  WHERE envelope.request_id = NEW.request_id;
  IF EXISTS (
    SELECT 1
    FROM public.service_configuration_operation_result_facts observation
    WHERE observation.reconcile_attempt_id = NEW.id
  ) THEN
    -- The immutable result validator and deferred result-authority trigger
    -- bind and authorize the exact observation that closed this dispatch.
    RETURN NULL;
  END IF;
  IF job_row IS NULL
     OR job_row.job_type <> 'service.password_change.reconcile'
     OR job_row.status <> 'running'
     OR job_row.attempts <> NEW.durable_job_attempts
     OR job_row.locked_at IS NULL
     OR job_row.locked_by <> NEW.actor_id
     OR operation_status_value <> 'unknown'
     OR latest_result_status_value <> 'unknown'
     OR envelope_destroyed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'reconciliation dispatch fact lacks its exact active GET-only projection';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_check_service_configuration_provider_projection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_id_value uuid;
  operation_row record;
  result_row record;
  mutation_count_value integer;
BEGIN
  IF TG_TABLE_NAME = 'provider_operations' THEN
    IF NEW.subject_type <> 'service_configuration_operation' THEN
      RETURN NULL;
    END IF;
    request_id_value := NEW.subject_id;
  ELSE
    request_id_value := NEW.request_id;
  END IF;
  SELECT operation.id, operation.status, operation.attempt_count
  INTO operation_row
  FROM public.provider_operations operation
  WHERE operation.subject_type = 'service_configuration_operation'
    AND operation.subject_id = request_id_value;
  IF operation_row IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT result.status
  INTO result_row
  FROM public.service_configuration_operation_result_facts result
  WHERE result.request_id = request_id_value
  ORDER BY result.revision DESC
  LIMIT 1;
  SELECT count(*)::integer
  INTO mutation_count_value
  FROM public.service_configuration_operation_attempts attempt
  WHERE attempt.request_id = request_id_value
    AND attempt.attempt_kind = 'mutation';
  IF operation_row.attempt_count <> mutation_count_value
     OR mutation_count_value NOT IN (0, 1)
     OR (result_row IS NULL AND operation_row.status <> 'queued')
     OR (result_row.status = 'running' AND operation_row.status <> 'running')
     OR (result_row.status = 'unknown' AND operation_row.status <> 'unknown')
     OR (result_row.status = 'manual' AND operation_row.status <> 'unknown')
     OR (result_row.status = 'succeeded' AND operation_row.status <> 'succeeded')
     OR (result_row.status = 'failed' AND operation_row.status <> 'failed') THEN
    RAISE EXCEPTION 'service configuration Provider row is not the exact attempt/result projection';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION opensales_check_service_configuration_envelope_projection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  result_row record;
  envelope_row record;
  operation_row record;
  mutation_count_value integer;
  start_job_row record;
  reconcile_job_count_value integer;
BEGIN
  SELECT result.status
  INTO result_row
  FROM public.service_configuration_operation_result_facts result
  WHERE result.request_id = NEW.request_id
  ORDER BY result.revision DESC
  LIMIT 1;
  SELECT envelope.ciphertext, envelope.destroyed_at
  INTO envelope_row
  FROM public.service_configuration_secret_envelopes envelope
  WHERE envelope.request_id = NEW.request_id;
  SELECT operation.status, operation.attempt_count, operation.id
  INTO operation_row
  FROM public.provider_operations operation
  WHERE operation.subject_type = 'service_configuration_operation'
    AND operation.subject_id = NEW.request_id;
  SELECT count(*)::integer
  INTO mutation_count_value
  FROM public.service_configuration_operation_attempts attempt
  WHERE attempt.request_id = NEW.request_id
    AND attempt.attempt_kind = 'mutation';
  SELECT job.status, job.payload
  INTO start_job_row
  FROM public.durable_jobs job
  WHERE job.job_type = 'service.password_change.start'
    AND job.unique_key = 'service-password-change:' || NEW.request_id::text || ':start';
  SELECT count(*)::integer
  INTO reconcile_job_count_value
  FROM public.durable_jobs job
  WHERE job.job_type = 'service.password_change.reconcile'
    AND job.unique_key = 'service-password-change:' || NEW.request_id::text || ':reconcile';

  IF envelope_row IS NULL OR operation_row IS NULL OR start_job_row IS NULL THEN
    RAISE EXCEPTION 'service configuration request lacks its envelope/operation/job projection';
  END IF;
  IF result_row IS NULL THEN
    IF envelope_row.ciphertext IS NULL
       OR envelope_row.destroyed_at IS NOT NULL
       OR operation_row.status <> 'queued'
       OR operation_row.attempt_count <> 0
       OR mutation_count_value <> 0
       OR start_job_row.status NOT IN ('pending', 'running') THEN
      RAISE EXCEPTION 'queued service password change has an invalid active-envelope projection';
    END IF;
  ELSIF result_row.status = 'running' THEN
    IF envelope_row.ciphertext IS NULL
       OR envelope_row.destroyed_at IS NOT NULL
       OR operation_row.status <> 'running'
       OR operation_row.attempt_count <> 1
       OR mutation_count_value <> 1
       OR start_job_row.status <> 'running' THEN
      RAISE EXCEPTION 'running service password change has an invalid in-flight envelope projection';
    END IF;
  ELSE
    IF envelope_row.ciphertext IS NOT NULL
       OR envelope_row.destroyed_at IS NULL
       OR mutation_count_value <> operation_row.attempt_count
       OR (result_row.status = 'unknown' AND (
         operation_row.status <> 'unknown'
         OR start_job_row.status <> 'completed'
         OR reconcile_job_count_value <> 1
       ))
       OR (result_row.status = 'manual' AND operation_row.status <> 'unknown')
       OR (result_row.status = 'succeeded' AND operation_row.status <> 'succeeded')
       OR (result_row.status = 'failed' AND operation_row.status <> 'failed') THEN
      RAISE EXCEPTION 'non-running service password change retained or mismatched its secret projection';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER validate_service_configuration_request
BEFORE INSERT ON service_configuration_operation_requests
FOR EACH ROW EXECUTE FUNCTION opensales_validate_service_configuration_request();

CREATE TRIGGER validate_service_configuration_envelope
BEFORE INSERT ON service_configuration_secret_envelopes
FOR EACH ROW EXECUTE FUNCTION opensales_validate_service_configuration_envelope();

CREATE TRIGGER guard_service_configuration_provider_operation
BEFORE INSERT OR UPDATE OR DELETE ON provider_operations
FOR EACH ROW EXECUTE FUNCTION opensales_guard_service_configuration_provider_operation();

CREATE TRIGGER guard_service_configuration_job
BEFORE INSERT OR UPDATE OR DELETE ON durable_jobs
FOR EACH ROW EXECUTE FUNCTION opensales_guard_service_configuration_job();

CREATE CONSTRAINT TRIGGER require_service_configuration_bundle
AFTER INSERT ON service_configuration_operation_requests
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opensales_require_service_configuration_bundle();

CREATE TRIGGER reject_service_configuration_request_mutation
BEFORE UPDATE OR DELETE ON service_configuration_operation_requests
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_configuration_fact_mutation();

CREATE TRIGGER guard_service_configuration_secret_update
BEFORE UPDATE ON service_configuration_secret_envelopes
FOR EACH ROW EXECUTE FUNCTION opensales_guard_service_configuration_secret_destruction();
CREATE TRIGGER reject_service_configuration_secret_delete
BEFORE DELETE ON service_configuration_secret_envelopes
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_configuration_fact_mutation();

CREATE TRIGGER reject_service_configuration_attempt_mutation
BEFORE UPDATE OR DELETE ON service_configuration_operation_attempts
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_configuration_fact_mutation();
CREATE TRIGGER validate_service_configuration_attempt
BEFORE INSERT ON service_configuration_operation_attempts
FOR EACH ROW EXECUTE FUNCTION opensales_validate_service_configuration_attempt();
CREATE TRIGGER reject_service_configuration_result_mutation
BEFORE UPDATE OR DELETE ON service_configuration_operation_result_facts
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_configuration_fact_mutation();
CREATE TRIGGER validate_service_configuration_result
BEFORE INSERT ON service_configuration_operation_result_facts
FOR EACH ROW EXECUTE FUNCTION opensales_validate_service_configuration_result();
CREATE TRIGGER reject_service_configuration_job_transition_mutation
BEFORE UPDATE OR DELETE ON service_configuration_operation_job_transitions
FOR EACH ROW EXECUTE FUNCTION opensales_reject_service_configuration_fact_mutation();
CREATE TRIGGER validate_service_configuration_job_transition
BEFORE INSERT ON service_configuration_operation_job_transitions
FOR EACH ROW EXECUTE FUNCTION opensales_validate_service_configuration_job_transition();

CREATE CONSTRAINT TRIGGER service_configuration_job_transition_commit
AFTER INSERT ON service_configuration_operation_job_transitions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION opensales_check_service_configuration_job_transition_commit();

CREATE CONSTRAINT TRIGGER service_configuration_result_authority
AFTER INSERT ON service_configuration_operation_result_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION opensales_check_service_configuration_result_authority();

CREATE CONSTRAINT TRIGGER service_configuration_reconcile_dispatch
AFTER INSERT ON service_configuration_operation_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.attempt_kind = 'reconcile_query')
EXECUTE FUNCTION opensales_check_service_configuration_reconcile_dispatch();

CREATE CONSTRAINT TRIGGER service_configuration_provider_projection
AFTER INSERT OR UPDATE ON provider_operations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.subject_type = 'service_configuration_operation')
EXECUTE FUNCTION opensales_check_service_configuration_provider_projection();
CREATE CONSTRAINT TRIGGER service_configuration_result_provider_projection
AFTER INSERT ON service_configuration_operation_result_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION opensales_check_service_configuration_provider_projection();
CREATE CONSTRAINT TRIGGER service_configuration_attempt_provider_projection
AFTER INSERT ON service_configuration_operation_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION opensales_check_service_configuration_provider_projection();

CREATE CONSTRAINT TRIGGER service_configuration_result_envelope_projection
AFTER INSERT ON service_configuration_operation_result_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION opensales_check_service_configuration_envelope_projection();
CREATE CONSTRAINT TRIGGER service_configuration_attempt_envelope_projection
AFTER INSERT ON service_configuration_operation_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION opensales_check_service_configuration_envelope_projection();
CREATE CONSTRAINT TRIGGER service_configuration_secret_envelope_projection
AFTER UPDATE ON service_configuration_secret_envelopes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION opensales_check_service_configuration_envelope_projection();
