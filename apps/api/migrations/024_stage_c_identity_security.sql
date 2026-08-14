-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Schema 024 adds ordinary product identity controls used by Customer and
-- Staff. It extends, but never replaces, the reviewed Schema 019 surface.

ALTER TABLE public.users
  ADD COLUMN authorization_epoch bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT users_authorization_epoch_check CHECK (authorization_epoch >= 0);

ALTER TABLE public.sessions
  ADD COLUMN revoked_transaction_id bigint;
UPDATE public.sessions
SET revoked_transaction_id = 0
WHERE revoked_at IS NOT NULL;
ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_revoked_transaction_check CHECK (
    (revoked_at IS NULL) = (revoked_transaction_id IS NULL)
  );

ALTER TABLE public.reauth_grants
  ADD COLUMN factor_method text NOT NULL DEFAULT 'password'
    CHECK (factor_method IN ('password', 'totp', 'recovery_code'));

CREATE OR REPLACE FUNCTION public.opensales_identity_envelope_key_version(
  encrypted_payload text
)
RETURNS integer LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog, public AS $$
DECLARE
  parts text[];
  parsed_version integer;
BEGIN
  IF pg_catalog.char_length(encrypted_payload) NOT BETWEEN 48 AND 30000
     OR encrypted_payload !~
       '^v1\.[1-9][0-9]*\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$' THEN
    RETURN NULL;
  END IF;
  parts := pg_catalog.string_to_array(encrypted_payload, '.');
  IF pg_catalog.cardinality(parts) <> 5 THEN RETURN NULL; END IF;
  parsed_version := parts[2]::integer;
  IF parsed_version < 1 THEN RETURN NULL; END IF;
  RETURN parsed_version;
EXCEPTION
  WHEN numeric_value_out_of_range OR invalid_text_representation THEN
    RETURN NULL;
END;
$$;

CREATE TABLE public.password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  authorization_epoch bigint NOT NULL CHECK (authorization_epoch >= 0),
  token_digest bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  invalidated_at timestamptz,
  created_transaction_id bigint NOT NULL DEFAULT pg_catalog.txid_current(),
  terminal_transaction_id bigint,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (pg_catalog.octet_length(token_digest) = 32),
  CHECK (expires_at > created_at),
  CHECK (used_at IS NULL OR used_at >= created_at),
  CHECK (invalidated_at IS NULL OR invalidated_at >= created_at),
  CHECK (used_at IS NULL OR invalidated_at IS NULL),
  CHECK (
    (used_at IS NULL AND invalidated_at IS NULL) =
      (terminal_transaction_id IS NULL)
  )
);
CREATE UNIQUE INDEX password_reset_tokens_one_active
  ON public.password_reset_tokens(user_id)
  WHERE used_at IS NULL AND invalidated_at IS NULL;

-- Mock-only mailbox possession. This long-lived opaque capability is issued
-- only after a successful password-authenticated login and any configured
-- second factor. It is
-- deliberately independent from the Session cookie so an anonymous recovery
-- request cannot mint permission to read somebody else's reset message.
CREATE TABLE public.lab_identity_mailbox_capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  origin_session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE RESTRICT,
  recipient citext NOT NULL,
  authorization_epoch bigint NOT NULL CHECK (authorization_epoch >= 0),
  token_digest bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_transaction_id bigint NOT NULL DEFAULT pg_catalog.txid_current(),
  revoked_transaction_id bigint,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (pg_catalog.octet_length(token_digest) = 32),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK ((revoked_at IS NULL) = (revoked_transaction_id IS NULL))
);
CREATE UNIQUE INDEX lab_identity_mailbox_capabilities_one_active
  ON public.lab_identity_mailbox_capabilities(user_id)
  WHERE revoked_at IS NULL;
CREATE INDEX lab_identity_mailbox_capabilities_active_origin
  ON public.lab_identity_mailbox_capabilities(origin_session_id)
  WHERE revoked_at IS NULL;

CREATE TABLE public.email_change_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  authorization_epoch bigint NOT NULL CHECK (authorization_epoch >= 0),
  requested_email citext NOT NULL,
  token_digest bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  invalidated_at timestamptz,
  created_transaction_id bigint NOT NULL DEFAULT pg_catalog.txid_current(),
  terminal_transaction_id bigint,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (pg_catalog.octet_length(token_digest) = 32),
  CHECK (expires_at > created_at),
  CHECK (used_at IS NULL OR used_at >= created_at),
  CHECK (invalidated_at IS NULL OR invalidated_at >= created_at),
  CHECK (used_at IS NULL OR invalidated_at IS NULL),
  CHECK (
    (used_at IS NULL AND invalidated_at IS NULL) =
      (terminal_transaction_id IS NULL)
  )
);
CREATE UNIQUE INDEX email_change_tokens_one_active
  ON public.email_change_tokens(user_id)
  WHERE used_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE public.totp_enrollment_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  seed_ciphertext text NOT NULL,
  seed_key_version integer NOT NULL CHECK (seed_key_version > 0),
  idempotency_key uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (user_id, idempotency_key),
  CHECK (expires_at > created_at),
  CHECK (confirmed_at IS NULL OR confirmed_at >= created_at),
  CHECK (invalidated_at IS NULL OR invalidated_at >= created_at),
  CHECK (confirmed_at IS NULL OR invalidated_at IS NULL),
  CHECK (public.opensales_identity_envelope_key_version(seed_ciphertext) = seed_key_version)
);
CREATE UNIQUE INDEX totp_enrollment_challenges_one_active
  ON public.totp_enrollment_challenges(user_id)
  WHERE confirmed_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE public.user_totp_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  seed_ciphertext text NOT NULL,
  seed_key_version integer NOT NULL CHECK (seed_key_version > 0),
  enabled_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  disabled_at timestamptz,
  created_transaction_id bigint NOT NULL DEFAULT pg_catalog.txid_current(),
  disabled_transaction_id bigint,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (disabled_at IS NULL OR disabled_at >= enabled_at),
  CHECK ((disabled_at IS NULL) = (disabled_transaction_id IS NULL)),
  CHECK (public.opensales_identity_envelope_key_version(seed_ciphertext) = seed_key_version)
);
CREATE UNIQUE INDEX user_totp_credentials_one_active
  ON public.user_totp_credentials(user_id)
  WHERE disabled_at IS NULL;

CREATE TABLE public.totp_recovery_code_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid NOT NULL REFERENCES public.user_totp_credentials(id),
  kind text NOT NULL CHECK (kind IN ('initial', 'regenerated')),
  code_count integer NOT NULL CHECK (code_count BETWEEN 1 AND 20),
  transaction_id bigint NOT NULL DEFAULT pg_catalog.txid_current(),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE TABLE public.totp_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid NOT NULL REFERENCES public.user_totp_credentials(id),
  batch_id uuid NOT NULL REFERENCES public.totp_recovery_code_batches(id),
  code_digest bytea NOT NULL UNIQUE,
  used_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (pg_catalog.octet_length(code_digest) = 32),
  CHECK (used_at IS NULL OR used_at >= created_at),
  CHECK (invalidated_at IS NULL OR invalidated_at >= created_at),
  CHECK (used_at IS NULL OR invalidated_at IS NULL)
);
CREATE INDEX totp_recovery_codes_credential_active
  ON public.totp_recovery_codes(credential_id, created_at, id)
  WHERE used_at IS NULL AND invalidated_at IS NULL;

CREATE OR REPLACE FUNCTION public.opensales_guard_totp_recovery_code_batch_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  batch_credential_id uuid;
  batch_transaction_id bigint;
BEGIN
  SELECT batch.credential_id, batch.transaction_id
  INTO batch_credential_id, batch_transaction_id
  FROM public.totp_recovery_code_batches batch
  WHERE batch.id = NEW.batch_id
  FOR SHARE NOWAIT;
  IF batch_credential_id IS NULL
     OR batch_credential_id IS DISTINCT FROM NEW.credential_id
     OR batch_transaction_id IS DISTINCT FROM pg_catalog.txid_current() THEN
    RAISE EXCEPTION 'TOTP recovery code must bind the exact current-transaction batch and credential';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER totp_recovery_codes_batch_insert_guard
BEFORE INSERT ON public.totp_recovery_codes FOR EACH ROW
EXECUTE FUNCTION public.opensales_guard_totp_recovery_code_batch_insert();

CREATE OR REPLACE FUNCTION public.opensales_validate_totp_recovery_code_batch()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  target_batch_id uuid;
  expected_credential_id uuid;
  expected_count integer;
  actual_count bigint;
  mismatched_count bigint;
BEGIN
  target_batch_id := CASE WHEN TG_TABLE_NAME = 'totp_recovery_code_batches'
    THEN NEW.id ELSE (pg_catalog.to_jsonb(NEW) ->> 'batch_id')::uuid END;
  SELECT batch.credential_id, batch.code_count
  INTO expected_credential_id, expected_count
  FROM public.totp_recovery_code_batches batch
  WHERE batch.id = target_batch_id;
  SELECT pg_catalog.count(*),
         pg_catalog.count(*) FILTER (
           WHERE code.credential_id IS DISTINCT FROM expected_credential_id
         )
  INTO actual_count, mismatched_count
  FROM public.totp_recovery_codes code
  WHERE code.batch_id = target_batch_id;
  IF expected_credential_id IS NULL
     OR actual_count <> expected_count
     OR mismatched_count <> 0 THEN
    RAISE EXCEPTION 'TOTP recovery-code batch requires its exact immutable code projection';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER totp_recovery_code_batch_projection_guard
AFTER INSERT ON public.totp_recovery_code_batches
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.opensales_validate_totp_recovery_code_batch();
CREATE CONSTRAINT TRIGGER totp_recovery_code_projection_guard
AFTER INSERT ON public.totp_recovery_codes
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.opensales_validate_totp_recovery_code_batch();

CREATE TABLE public.totp_step_use_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid NOT NULL REFERENCES public.user_totp_credentials(id),
  timestep bigint NOT NULL CHECK (timestep >= 0),
  purpose text NOT NULL CHECK (purpose IN ('login', 'reauth', 'enrollment')),
  used_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (credential_id, timestep)
);

CREATE TABLE public.login_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  authorization_epoch bigint NOT NULL CHECK (authorization_epoch >= 0),
  token_digest bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  invalidated_at timestamptz,
  satisfied_by text CHECK (satisfied_by IN ('totp', 'recovery_code')),
  created_transaction_id bigint NOT NULL DEFAULT pg_catalog.txid_current(),
  terminal_transaction_id bigint,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (pg_catalog.octet_length(token_digest) = 32),
  CHECK (expires_at > created_at),
  CHECK (used_at IS NULL OR used_at >= created_at),
  CHECK (invalidated_at IS NULL OR invalidated_at >= created_at),
  CHECK ((used_at IS NULL) = (satisfied_by IS NULL)),
  CHECK (used_at IS NULL OR invalidated_at IS NULL),
  CHECK (
    (used_at IS NULL AND invalidated_at IS NULL) =
      (terminal_transaction_id IS NULL)
  )
);
CREATE INDEX login_challenges_user_active
  ON public.login_challenges(user_id, expires_at, id)
  WHERE used_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE public.customer_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  client_account_id uuid NOT NULL REFERENCES public.client_accounts(id),
  name text NOT NULL CHECK (
    pg_catalog.length(pg_catalog.btrim(name)) BETWEEN 1 AND 80
    AND name = pg_catalog.btrim(name)
  ),
  scopes text[] NOT NULL CHECK (
    pg_catalog.cardinality(scopes) BETWEEN 1 AND 6
    AND scopes <@ ARRAY[
      'account.read', 'orders.read', 'billing.read', 'services.read',
      'support.read', 'support.write'
    ]::text[]
  ),
  token_digest bytea NOT NULL UNIQUE,
  idempotency_key uuid NOT NULL,
  request_fingerprint bytea NOT NULL,
  created_transaction_id bigint NOT NULL DEFAULT pg_catalog.txid_current(),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (pg_catalog.octet_length(token_digest) = 32),
  CHECK (pg_catalog.octet_length(request_fingerprint) = 32),
  UNIQUE (user_id, client_account_id, idempotency_key),
  UNIQUE (id, user_id, client_account_id)
);
CREATE INDEX customer_api_keys_account_created
  ON public.customer_api_keys(client_account_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.opensales_validate_customer_api_key_scopes()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  canonical_scopes text[];
BEGIN
  SELECT pg_catalog.array_agg(scope ORDER BY scope COLLATE "C")
  INTO canonical_scopes
  FROM (
    SELECT DISTINCT scope
    FROM pg_catalog.unnest(NEW.scopes) AS values_(scope)
  ) canonical;
  IF canonical_scopes IS DISTINCT FROM NEW.scopes THEN
    RAISE EXCEPTION 'customer API key scopes must be unique and canonical ASCII sorted';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_api_keys_canonical_scopes
BEFORE INSERT ON public.customer_api_keys FOR EACH ROW
EXECUTE FUNCTION public.opensales_validate_customer_api_key_scopes();

CREATE TABLE public.customer_api_key_revocations (
  api_key_id uuid PRIMARY KEY REFERENCES public.customer_api_keys(id),
  revoked_by_user_id uuid NOT NULL REFERENCES public.users(id),
  reason text NOT NULL CHECK (
    pg_catalog.length(pg_catalog.btrim(reason)) BETWEEN 3 AND 240
    AND reason = pg_catalog.btrim(reason)
  ),
  transaction_id bigint NOT NULL DEFAULT pg_catalog.txid_current(),
  revoked_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE TABLE public.customer_api_key_usage_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id uuid NOT NULL REFERENCES public.customer_api_keys(id),
  method text NOT NULL CHECK (method IN ('GET', 'POST')),
  capability text NOT NULL CHECK (capability = ANY(ARRAY[
    'account.read', 'orders.read', 'billing.read', 'services.read',
    'support.read', 'support.write'
  ]::text[])),
  result text NOT NULL CHECK (result IN ('authorized', 'rejected')),
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
CREATE INDEX customer_api_key_usage_facts_key_recorded
  ON public.customer_api_key_usage_facts(api_key_id, recorded_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.opensales_guard_customer_api_key_fact_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  key_user_id uuid;
  key_scopes text[];
BEGIN
  SELECT api_key.user_id, api_key.scopes
  INTO key_user_id, key_scopes
  FROM public.customer_api_keys api_key
  WHERE api_key.id = NEW.api_key_id
  FOR SHARE NOWAIT;
  IF key_user_id IS NULL THEN
    RAISE EXCEPTION 'customer API key fact requires an existing key';
  END IF;
  IF TG_TABLE_NAME = 'customer_api_key_revocations' THEN
    IF NEW.revoked_by_user_id IS DISTINCT FROM key_user_id THEN
      RAISE EXCEPTION 'customer API key self-revocation must bind its owning User';
    END IF;
  ELSIF NOT (NEW.capability = ANY(key_scopes)) THEN
    RAISE EXCEPTION 'customer API key usage capability must be included in the immutable key scopes';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_api_key_revocations_insert_guard
BEFORE INSERT ON public.customer_api_key_revocations FOR EACH ROW
EXECUTE FUNCTION public.opensales_guard_customer_api_key_fact_insert();
CREATE TRIGGER customer_api_key_usage_facts_insert_guard
BEFORE INSERT ON public.customer_api_key_usage_facts FOR EACH ROW
EXECUTE FUNCTION public.opensales_guard_customer_api_key_fact_insert();

-- Plaintext one-time links never enter this Outbox. Worker decrypts the
-- authenticated envelope only in memory immediately before Mock Mail dispatch.
CREATE TABLE public.identity_notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  kind text NOT NULL CHECK (kind IN ('password_recovery', 'email_change')),
  recipient citext NOT NULL,
  locale text NOT NULL CHECK (locale IN ('en', 'zh-CN')),
  subject_id uuid NOT NULL,
  encrypted_payload text NOT NULL,
  encryption_key_version integer NOT NULL CHECK (encryption_key_version > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (kind, subject_id),
  CHECK (expires_at > created_at),
  CHECK (
    public.opensales_identity_envelope_key_version(encrypted_payload) =
      encryption_key_version
  )
);

CREATE TABLE public.identity_notification_delivery_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL REFERENCES public.identity_notification_outbox(id),
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  provider_operation_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('delivered', 'bounced', 'failed', 'manual')),
  failure_reason text,
  provider_occurred_at timestamptz,
  transaction_id bigint NOT NULL DEFAULT pg_catalog.txid_current()
    CHECK (transaction_id > 0),
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (outbox_id, attempt_number),
  UNIQUE (provider_operation_id),
  CHECK (
    (status IN ('failed', 'manual')
      AND failure_reason IS NOT NULL
      AND failure_reason = pg_catalog.btrim(failure_reason)
      AND pg_catalog.char_length(failure_reason) BETWEEN 3 AND 1000)
    OR
    (status IN ('delivered', 'bounced') AND failure_reason IS NULL)
  ),
  CHECK (
    (status = 'manual' AND provider_occurred_at IS NULL)
    OR
    (status IN ('delivered', 'bounced', 'failed')
      AND provider_occurred_at IS NOT NULL)
  )
);
CREATE INDEX identity_notification_delivery_outbox_recorded
  ON public.identity_notification_delivery_facts(outbox_id, recorded_at DESC, id DESC);

CREATE TABLE public.identity_notification_delivery_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL REFERENCES public.identity_notification_outbox(id),
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  provider_operation_id uuid NOT NULL,
  request_fingerprint bytea NOT NULL,
  status text NOT NULL CHECK (
    status IN ('queued', 'dispatching', 'unknown', 'succeeded', 'failed', 'manual')
  ),
  post_attempted_at timestamptz,
  last_reconciled_at timestamptz,
  reconcile_query_count integer NOT NULL DEFAULT 0
    CHECK (reconcile_query_count BETWEEN 0 AND 32),
  last_error text,
  terminal_transaction_id bigint CHECK (terminal_transaction_id > 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (outbox_id, attempt_number),
  UNIQUE (provider_operation_id),
  UNIQUE (outbox_id, attempt_number, provider_operation_id),
  UNIQUE (id, outbox_id, attempt_number, provider_operation_id),
  CHECK (
    (status IN ('dispatching', 'unknown', 'succeeded', 'failed')
      AND post_attempted_at IS NOT NULL)
    OR
    (status IN ('queued', 'manual'))
  ),
  CHECK (
    last_reconciled_at IS NULL
    OR (post_attempted_at IS NOT NULL AND last_reconciled_at >= post_attempted_at)
  ),
  CHECK (
    (status IN ('succeeded', 'failed', 'manual')) =
      (terminal_transaction_id IS NOT NULL)
  )
);
CREATE INDEX identity_notification_delivery_operations_status
  ON public.identity_notification_delivery_operations(status, updated_at, id);
COMMENT ON TABLE public.identity_notification_delivery_operations IS
  'Each attempt permits one Mock Mail POST. An unknown POST result is reconciled by GET only. Only an explicit failed fact may append the next deterministic attempt, up to three attempts.';

ALTER TABLE public.identity_notification_delivery_facts
  ADD CONSTRAINT identity_notification_delivery_facts_operation_fkey
  FOREIGN KEY (outbox_id, attempt_number, provider_operation_id)
  REFERENCES public.identity_notification_delivery_operations(
    outbox_id, attempt_number, provider_operation_id
  );

CREATE OR REPLACE FUNCTION public.opensales_identity_notification_request_fingerprint(
  outbox_id uuid,
  user_id uuid,
  kind text,
  recipient public.citext,
  locale text,
  subject_id uuid,
  encrypted_payload text,
  encryption_key_version integer,
  expires_at timestamptz
)
RETURNS bytea LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, public AS $$
  SELECT public.digest(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'opensales:identity-notification:v1', outbox_id, user_id, kind,
        recipient::text, locale, subject_id, encrypted_payload,
        encryption_key_version, expires_at
      )::text,
      'UTF8'
    ),
    'sha256'
  )
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_identity_notification_outbox()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  principal_email public.citext;
  principal_locale text;
  principal_authorization_epoch bigint;
  subject_is_valid boolean;
BEGIN
  SELECT principal.email, principal.locale, principal.authorization_epoch
  INTO principal_email, principal_locale, principal_authorization_epoch
  FROM public.users principal
  WHERE principal.id = NEW.user_id
  FOR SHARE NOWAIT;
  IF principal_email IS NULL OR principal_locale IS DISTINCT FROM NEW.locale THEN
    RAISE EXCEPTION 'identity notification must bind the current user and locale';
  END IF;

  IF NEW.kind = 'password_recovery' THEN
    SELECT token.user_id = NEW.user_id
       AND token.authorization_epoch = principal_authorization_epoch
       AND token.expires_at = NEW.expires_at
       AND token.expires_at > pg_catalog.clock_timestamp()
       AND token.used_at IS NULL
       AND token.invalidated_at IS NULL
    INTO subject_is_valid
    FROM public.password_reset_tokens token
    WHERE token.id = NEW.subject_id
    FOR SHARE NOWAIT;
    IF NEW.recipient IS DISTINCT FROM principal_email THEN
      subject_is_valid := false;
    END IF;
  ELSIF NEW.kind = 'email_change' THEN
    SELECT token.user_id = NEW.user_id
       AND token.authorization_epoch = principal_authorization_epoch
       AND token.requested_email = NEW.recipient
       AND token.expires_at = NEW.expires_at
       AND token.expires_at > pg_catalog.clock_timestamp()
       AND token.used_at IS NULL
       AND token.invalidated_at IS NULL
    INTO subject_is_valid
    FROM public.email_change_tokens token
    WHERE token.id = NEW.subject_id
    FOR SHARE NOWAIT;
  ELSE
    subject_is_valid := false;
  END IF;

  IF NOT COALESCE(subject_is_valid, false) THEN
    RAISE EXCEPTION 'identity notification recipient, expiry, and subject must match an active token';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_notification_outbox_subject_guard
BEFORE INSERT ON public.identity_notification_outbox FOR EACH ROW
EXECUTE FUNCTION public.opensales_validate_identity_notification_outbox();

CREATE OR REPLACE FUNCTION public.opensales_guard_identity_delivery_operation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  expected_fingerprint bytea;
  previous_status text;
  previous_fact_status text;
  previous_job_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'identity delivery operations are retained for reconciliation history';
  END IF;

  SELECT public.opensales_identity_notification_request_fingerprint(
           event.id, event.user_id, event.kind, event.recipient, event.locale,
           event.subject_id, event.encrypted_payload,
           event.encryption_key_version, event.expires_at
         )
  INTO expected_fingerprint
  FROM public.identity_notification_outbox event
  WHERE event.id = NEW.outbox_id
  FOR SHARE NOWAIT;
  IF expected_fingerprint IS NULL
     OR NEW.request_fingerprint IS DISTINCT FROM expected_fingerprint
     OR NEW.provider_operation_id IS DISTINCT FROM
       public.opensales_notification_provider_operation_id(
         NEW.outbox_id, NEW.attempt_number
       ) THEN
    RAISE EXCEPTION 'identity delivery operation must preserve the exact outbox request and deterministic Provider operation id';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'queued'
       OR NEW.post_attempted_at IS NOT NULL
       OR NEW.last_reconciled_at IS NOT NULL
       OR NEW.reconcile_query_count <> 0
       OR NEW.last_error IS NOT NULL
       OR NEW.terminal_transaction_id IS NOT NULL
       OR NEW.updated_at IS DISTINCT FROM NEW.created_at THEN
      RAISE EXCEPTION 'identity delivery operation must begin in canonical queued state';
    END IF;
    IF NEW.attempt_number = 1 THEN
      IF EXISTS (
        SELECT 1 FROM public.identity_notification_delivery_operations prior
        WHERE prior.outbox_id = NEW.outbox_id
      ) THEN
        RAISE EXCEPTION 'identity delivery attempt one must be the first operation';
      END IF;
    ELSE
      SELECT prior.status, fact.status, job.status
      INTO previous_status, previous_fact_status, previous_job_status
      FROM public.identity_notification_delivery_operations prior
      LEFT JOIN public.identity_notification_delivery_facts fact
        ON fact.outbox_id = prior.outbox_id
       AND fact.attempt_number = prior.attempt_number
       AND fact.provider_operation_id = prior.provider_operation_id
      LEFT JOIN public.durable_jobs job
        ON job.job_type = 'identity.notification.send'
       AND job.unique_key =
         'identity-notification:' || prior.outbox_id::text ||
         ':attempt:' || prior.attempt_number::text
       AND job.payload = pg_catalog.jsonb_build_object(
         'outboxId', prior.outbox_id::text,
         'operationId', prior.id::text,
         'attemptNumber', prior.attempt_number
       )
      WHERE prior.outbox_id = NEW.outbox_id
        AND prior.attempt_number = NEW.attempt_number - 1
      FOR SHARE OF prior NOWAIT;
      IF previous_status IS DISTINCT FROM 'failed'
         OR previous_fact_status IS DISTINCT FROM 'failed'
         OR previous_job_status IS DISTINCT FROM 'completed' THEN
        RAISE EXCEPTION 'identity delivery retry requires the immediately preceding explicit failed attempt and completed job';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.identity_notification_delivery_operations later
        WHERE later.outbox_id = NEW.outbox_id
          AND later.attempt_number >= NEW.attempt_number
      ) THEN
        RAISE EXCEPTION 'identity delivery attempts must be appended exactly once in order';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.outbox_id IS DISTINCT FROM OLD.outbox_id
     OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
     OR NEW.provider_operation_id IS DISTINCT FROM OLD.provider_operation_id
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'identity delivery operation identity and request are immutable';
  END IF;
  IF OLD.status IN ('succeeded', 'failed', 'manual') THEN
    RAISE EXCEPTION 'identity delivery terminal state is immutable';
  END IF;
  IF NEW.updated_at <= OLD.updated_at
     OR pg_catalog.char_length(COALESCE(NEW.last_error, '')) > 1000 THEN
    RAISE EXCEPTION 'identity delivery operation update timestamp or error is invalid';
  END IF;

  IF OLD.status = 'queued' THEN
    IF NEW.status = 'dispatching' THEN
      IF NEW.post_attempted_at IS NULL
         OR NEW.last_reconciled_at IS NOT NULL
         OR NEW.reconcile_query_count <> OLD.reconcile_query_count
         OR NEW.last_error IS NOT NULL THEN
        RAISE EXCEPTION 'identity notification POST must first enter dispatching exactly once';
      END IF;
    ELSIF NEW.status = 'manual' THEN
      IF NEW.post_attempted_at IS NOT NULL OR NEW.last_reconciled_at IS NOT NULL
         OR NEW.reconcile_query_count <> OLD.reconcile_query_count
         OR NEW.last_error IS NULL THEN
        RAISE EXCEPTION 'pre-dispatch manual state must be known-unsent with a reason';
      END IF;
    ELSE
      RAISE EXCEPTION 'queued identity notification can only enter dispatching or known-unsent manual';
    END IF;
  ELSIF OLD.status = 'dispatching' THEN
    IF NEW.status NOT IN ('unknown', 'succeeded', 'failed', 'manual')
       OR NEW.post_attempted_at IS DISTINCT FROM OLD.post_attempted_at
       OR NEW.last_reconciled_at IS NOT NULL
       OR NEW.reconcile_query_count <> OLD.reconcile_query_count
       OR (NEW.status IN ('unknown', 'failed', 'manual') AND NEW.last_error IS NULL)
       OR (NEW.status = 'succeeded' AND NEW.last_error IS NOT NULL) THEN
      RAISE EXCEPTION 'dispatch result must become unknown or a supported terminal state without another POST';
    END IF;
  ELSIF OLD.status = 'unknown' THEN
    IF NEW.status NOT IN ('unknown', 'succeeded', 'failed', 'manual')
       OR NEW.post_attempted_at IS DISTINCT FROM OLD.post_attempted_at
       OR NEW.last_reconciled_at IS NULL
       OR (OLD.last_reconciled_at IS NOT NULL
         AND NEW.last_reconciled_at <= OLD.last_reconciled_at)
       OR NEW.last_reconciled_at < NEW.post_attempted_at
       OR NEW.reconcile_query_count <> OLD.reconcile_query_count + 1
       OR (NEW.status IN ('unknown', 'failed', 'manual') AND NEW.last_error IS NULL)
       OR (NEW.status = 'succeeded' AND NEW.last_error IS NOT NULL) THEN
      RAISE EXCEPTION 'unknown identity notification may only be resolved by monotonic GET reconciliation';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported identity delivery state transition';
  END IF;
  IF NEW.status IN ('succeeded', 'failed', 'manual') THEN
    NEW.terminal_transaction_id := pg_catalog.txid_current();
  ELSIF NEW.terminal_transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'nonterminal identity delivery operation cannot carry a terminal transaction';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_notification_delivery_operations_guard
BEFORE INSERT OR UPDATE OR DELETE
ON public.identity_notification_delivery_operations FOR EACH ROW
EXECUTE FUNCTION public.opensales_guard_identity_delivery_operation();

CREATE OR REPLACE FUNCTION public.opensales_guard_identity_delivery_fact_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  operation_status text;
  operation_terminal_transaction_id bigint;
BEGIN
  IF NEW.transaction_id IS DISTINCT FROM pg_catalog.txid_current() THEN
    RAISE EXCEPTION 'identity delivery fact must be recorded in its terminal operation transaction';
  END IF;
  SELECT operation.status, operation.terminal_transaction_id
  INTO operation_status, operation_terminal_transaction_id
  FROM public.identity_notification_delivery_operations operation
  WHERE operation.outbox_id = NEW.outbox_id
    AND operation.attempt_number = NEW.attempt_number
    AND operation.provider_operation_id = NEW.provider_operation_id
  FOR SHARE NOWAIT;
  IF operation_terminal_transaction_id IS DISTINCT FROM pg_catalog.txid_current()
     OR (operation_status = 'succeeded' AND NEW.status NOT IN ('delivered', 'bounced'))
     OR (operation_status = 'failed' AND NEW.status <> 'failed')
     OR (operation_status = 'manual' AND NEW.status <> 'manual')
     OR operation_status NOT IN ('succeeded', 'failed', 'manual') THEN
    RAISE EXCEPTION 'identity delivery fact must exactly project its same-transaction terminal operation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_notification_delivery_facts_insert_guard
BEFORE INSERT ON public.identity_notification_delivery_facts FOR EACH ROW
EXECUTE FUNCTION public.opensales_guard_identity_delivery_fact_insert();

CREATE OR REPLACE FUNCTION public.opensales_validate_identity_delivery_projection()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  operation_status text;
  fact_status text;
  fact_count bigint;
BEGIN
  IF TG_TABLE_NAME = 'identity_notification_delivery_operations' THEN
    SELECT operation.status
    INTO operation_status
    FROM public.identity_notification_delivery_operations operation
    WHERE operation.id = NEW.id;
    SELECT pg_catalog.count(*), pg_catalog.min(fact.status)
    INTO fact_count, fact_status
    FROM public.identity_notification_delivery_facts fact
    WHERE fact.outbox_id = NEW.outbox_id
      AND fact.attempt_number = NEW.attempt_number
      AND fact.provider_operation_id = NEW.provider_operation_id;
  ELSE
    SELECT operation.status
    INTO operation_status
    FROM public.identity_notification_delivery_operations operation
    WHERE operation.outbox_id = NEW.outbox_id
      AND operation.attempt_number = NEW.attempt_number
      AND operation.provider_operation_id = NEW.provider_operation_id;
    SELECT pg_catalog.count(*), pg_catalog.min(fact.status)
    INTO fact_count, fact_status
    FROM public.identity_notification_delivery_facts fact
    WHERE fact.outbox_id = NEW.outbox_id
      AND fact.attempt_number = NEW.attempt_number
      AND fact.provider_operation_id = NEW.provider_operation_id;
  END IF;

  IF operation_status IN ('succeeded', 'failed', 'manual') THEN
    IF fact_count <> 1
       OR (operation_status = 'succeeded' AND fact_status NOT IN ('delivered', 'bounced'))
       OR (operation_status = 'failed' AND fact_status <> 'failed')
       OR (operation_status = 'manual' AND fact_status <> 'manual') THEN
      RAISE EXCEPTION 'identity notification terminal operation requires one matching immutable delivery fact';
    END IF;
  ELSIF fact_count <> 0 THEN
    RAISE EXCEPTION 'identity notification delivery fact requires a matching terminal operation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER identity_delivery_operation_projection_guard
AFTER INSERT OR UPDATE ON public.identity_notification_delivery_operations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.opensales_validate_identity_delivery_projection();
CREATE CONSTRAINT TRIGGER identity_delivery_fact_projection_guard
AFTER INSERT ON public.identity_notification_delivery_facts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.opensales_validate_identity_delivery_projection();

CREATE OR REPLACE FUNCTION public.opensales_guard_identity_notification_job()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  operation_record public.identity_notification_delivery_operations%ROWTYPE;
  expected_payload jsonb;
  fact_count bigint;
  fact_status text;
  fact_transaction_id bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.job_type = 'identity.notification.send' THEN
      RAISE EXCEPTION 'identity notification durable jobs are retained as immutable bundle history';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.job_type <> 'identity.notification.send' THEN
      RETURN NEW;
    END IF;
    IF NEW.status <> 'pending'
       OR NEW.attempts <> 0
       OR NEW.locked_at IS NOT NULL
       OR NEW.locked_by IS NOT NULL
       OR NEW.last_error IS NOT NULL
       OR NEW.updated_at IS DISTINCT FROM NEW.created_at THEN
      RAISE EXCEPTION 'identity notification durable job must begin pending, unattempted, and unlocked';
    END IF;
  ELSIF OLD.job_type <> 'identity.notification.send'
        AND NEW.job_type <> 'identity.notification.send' THEN
    RETURN NEW;
  END IF;
  IF NEW.job_type <> 'identity.notification.send' THEN
    RAISE EXCEPTION 'identity notification durable-job identity is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND (
       NEW.id IS DISTINCT FROM OLD.id
       OR NEW.job_type IS DISTINCT FROM OLD.job_type
       OR NEW.unique_key IS DISTINCT FROM OLD.unique_key
       OR NEW.payload IS DISTINCT FROM OLD.payload
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
     ) THEN
    RAISE EXCEPTION 'identity notification durable-job request is immutable';
  END IF;
  IF NEW.status = 'failed'
     OR (NEW.status = 'running'
       AND (NEW.attempts < 1 OR NEW.locked_at IS NULL OR NEW.locked_by IS NULL))
     OR (NEW.status <> 'running'
       AND (NEW.locked_at IS NOT NULL OR NEW.locked_by IS NOT NULL))
     OR (NEW.status = 'completed' AND NEW.last_error IS NOT NULL)
     OR (NEW.status = 'manual' AND (
       NEW.last_error IS NULL
       OR NEW.last_error <> pg_catalog.btrim(NEW.last_error)
       OR pg_catalog.char_length(NEW.last_error) NOT BETWEEN 3 AND 1000
     )) THEN
    RAISE EXCEPTION 'identity notification durable-job lifecycle state is invalid';
  END IF;
  SELECT operation.*
  INTO operation_record
  FROM public.identity_notification_delivery_operations operation
  WHERE operation.id = (NEW.payload ->> 'operationId')::uuid
  FOR SHARE NOWAIT;
  expected_payload := pg_catalog.jsonb_build_object(
    'outboxId', operation_record.outbox_id::text,
    'operationId', operation_record.id::text,
    'attemptNumber', operation_record.attempt_number
  );
  IF operation_record.id IS NULL
     OR NEW.unique_key IS DISTINCT FROM
       'identity-notification:' || operation_record.outbox_id::text ||
       ':attempt:' || operation_record.attempt_number::text
     OR NEW.payload IS DISTINCT FROM expected_payload THEN
    RAISE EXCEPTION 'identity notification durable job must contain the exact operation pointer';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF operation_record.status <> 'queued' THEN
      RAISE EXCEPTION 'new identity notification durable job requires its canonical queued operation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('completed', 'manual') THEN
    RAISE EXCEPTION 'identity notification terminal durable-job state is immutable';
  END IF;
  IF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'identity notification durable-job transition time must advance';
  END IF;

  IF OLD.status = 'pending' THEN
    IF NEW.status <> 'running'
       OR NEW.attempts <> OLD.attempts + 1
       OR NEW.available_at IS DISTINCT FROM OLD.available_at
       OR NEW.last_error IS DISTINCT FROM OLD.last_error
       OR NEW.locked_at IS NULL
       OR NEW.locked_at < OLD.updated_at
       OR NEW.locked_at > pg_catalog.clock_timestamp()
       OR NEW.updated_at IS DISTINCT FROM NEW.locked_at
       OR NEW.locked_by IS NULL
       OR NEW.locked_by <> pg_catalog.btrim(NEW.locked_by)
       OR pg_catalog.char_length(NEW.locked_by) NOT BETWEEN 1 AND 200
       OR operation_record.status NOT IN ('queued', 'unknown') THEN
      RAISE EXCEPTION 'identity notification job claim must acquire one exact lease and increment attempts once';
    END IF;
  ELSIF OLD.status = 'running' THEN
    IF NEW.status = 'running' THEN
      IF NEW.attempts IS DISTINCT FROM OLD.attempts
         OR NEW.available_at IS DISTINCT FROM OLD.available_at
         OR NEW.locked_at IS DISTINCT FROM OLD.locked_at
         OR NEW.locked_by IS DISTINCT FROM OLD.locked_by
         OR NEW.last_error IS DISTINCT FROM OLD.last_error THEN
        RAISE EXCEPTION 'running identity notification job may only advance its update timestamp under the same lease';
      END IF;
    ELSIF NEW.status = 'pending' THEN
      IF NEW.attempts IS DISTINCT FROM OLD.attempts
         OR NEW.available_at < OLD.available_at
         OR NEW.locked_at IS NOT NULL
         OR NEW.locked_by IS NOT NULL
         OR NEW.last_error IS NULL
         OR NEW.last_error <> pg_catalog.btrim(NEW.last_error)
         OR pg_catalog.char_length(NEW.last_error) NOT BETWEEN 3 AND 1000
         OR operation_record.status NOT IN ('queued', 'unknown') THEN
        RAISE EXCEPTION 'identity notification job may requeue only a known-unsent or GET-only operation without changing attempts';
      END IF;
    ELSIF NEW.status IN ('completed', 'manual') THEN
      IF NEW.attempts IS DISTINCT FROM OLD.attempts
         OR NEW.available_at IS DISTINCT FROM OLD.available_at
         OR NEW.locked_at IS NOT NULL
         OR NEW.locked_by IS NOT NULL THEN
        RAISE EXCEPTION 'identity notification terminal job transition must release its exact lease without changing attempts';
      END IF;
      SELECT pg_catalog.count(*), pg_catalog.min(fact.status),
             pg_catalog.min(fact.transaction_id)
      INTO fact_count, fact_status, fact_transaction_id
      FROM public.identity_notification_delivery_facts fact
      WHERE fact.outbox_id = operation_record.outbox_id
        AND fact.attempt_number = operation_record.attempt_number
        AND fact.provider_operation_id = operation_record.provider_operation_id;
      IF operation_record.terminal_transaction_id IS DISTINCT FROM pg_catalog.txid_current()
         OR fact_count <> 1
         OR fact_transaction_id IS DISTINCT FROM pg_catalog.txid_current()
         OR (NEW.status = 'completed' AND (
           NEW.last_error IS NOT NULL
           OR operation_record.status NOT IN ('succeeded', 'failed')
           OR (operation_record.status = 'succeeded' AND fact_status NOT IN ('delivered', 'bounced'))
           OR (operation_record.status = 'failed' AND fact_status <> 'failed')
         ))
         OR (NEW.status = 'manual' AND (
           NEW.last_error IS NULL
           OR NEW.last_error <> pg_catalog.btrim(NEW.last_error)
           OR pg_catalog.char_length(NEW.last_error) NOT BETWEEN 3 AND 1000
           OR operation_record.status <> 'manual'
           OR fact_status <> 'manual'
         )) THEN
        RAISE EXCEPTION 'identity notification terminal job must exactly project its same-transaction operation and fact';
      END IF;
    ELSE
      RAISE EXCEPTION 'running identity notification job has an unsupported lifecycle transition';
    END IF;
  ELSE
    RAISE EXCEPTION 'identity notification durable job has an unsupported source state';
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'identity notification durable job operation pointer must be a UUID';
END;
$$;
CREATE TRIGGER identity_notification_durable_job_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.durable_jobs FOR EACH ROW
EXECUTE FUNCTION public.opensales_guard_identity_notification_job();

CREATE OR REPLACE FUNCTION public.opensales_validate_identity_notification_bundle()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  target_outbox_id uuid;
  operation_count bigint;
  job_count bigint;
  invalid_pair_count bigint;
  first_attempt integer;
  last_attempt integer;
BEGIN
  IF TG_TABLE_NAME = 'identity_notification_outbox' THEN
    target_outbox_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'identity_notification_delivery_operations' THEN
    target_outbox_id := NEW.outbox_id;
  ELSE
    IF NEW.job_type <> 'identity.notification.send' THEN
      RETURN NULL;
    END IF;
    target_outbox_id := (NEW.payload ->> 'outboxId')::uuid;
  END IF;

  SELECT pg_catalog.count(*), pg_catalog.min(operation.attempt_number),
         pg_catalog.max(operation.attempt_number)
  INTO operation_count, first_attempt, last_attempt
  FROM public.identity_notification_delivery_operations operation
  WHERE operation.outbox_id = target_outbox_id;
  SELECT pg_catalog.count(*)
  INTO job_count
  FROM public.durable_jobs job
  WHERE job.job_type = 'identity.notification.send'
    AND job.payload ->> 'outboxId' = target_outbox_id::text;

  IF operation_count NOT BETWEEN 1 AND 3
     OR first_attempt <> 1
     OR last_attempt <> operation_count
     OR job_count <> operation_count THEN
    RAISE EXCEPTION 'identity notification commit requires one to three contiguous operations and one exact durable job per attempt';
  END IF;

  SELECT pg_catalog.count(*)
  INTO invalid_pair_count
  FROM public.identity_notification_delivery_operations operation
  LEFT JOIN public.durable_jobs job
    ON job.job_type = 'identity.notification.send'
   AND job.unique_key =
     'identity-notification:' || operation.outbox_id::text ||
     ':attempt:' || operation.attempt_number::text
  WHERE operation.outbox_id = target_outbox_id
    AND (
      job.id IS NULL
      OR job.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
        'outboxId', operation.outbox_id::text,
        'operationId', operation.id::text,
        'attemptNumber', operation.attempt_number
      )
      OR (operation.status = 'queued' AND job.status NOT IN ('pending', 'running'))
      OR (operation.status = 'dispatching' AND job.status <> 'running')
      OR (operation.status = 'unknown' AND job.status NOT IN ('pending', 'running'))
      OR (operation.status IN ('succeeded', 'failed') AND job.status <> 'completed')
      OR (operation.status = 'manual' AND job.status <> 'manual')
    );
  IF invalid_pair_count <> 0 THEN
    RAISE EXCEPTION 'identity notification operation and durable-job lifecycle states disagree';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER identity_notification_outbox_bundle_guard
AFTER INSERT ON public.identity_notification_outbox
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.opensales_validate_identity_notification_bundle();
CREATE CONSTRAINT TRIGGER identity_notification_operation_bundle_guard
AFTER INSERT OR UPDATE ON public.identity_notification_delivery_operations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.opensales_validate_identity_notification_bundle();
CREATE CONSTRAINT TRIGGER identity_notification_job_bundle_guard
AFTER INSERT OR UPDATE ON public.durable_jobs
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.opensales_validate_identity_notification_bundle();

CREATE TABLE public.identity_password_change_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  transaction_id bigint NOT NULL DEFAULT pg_catalog.txid_current(),
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE OR REPLACE FUNCTION public.opensales_record_password_change_event()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
    INSERT INTO public.identity_password_change_events(user_id) VALUES (NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_record_password_change_event
AFTER UPDATE OF password_hash ON public.users FOR EACH ROW
WHEN (NEW.password_hash IS DISTINCT FROM OLD.password_hash)
EXECUTE FUNCTION public.opensales_record_password_change_event();

CREATE OR REPLACE FUNCTION public.opensales_guard_password_change_event_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF pg_catalog.pg_trigger_depth() < 2
     OR NEW.transaction_id IS DISTINCT FROM pg_catalog.txid_current() THEN
    RAISE EXCEPTION 'password change events may only be emitted by the User credential transition trigger';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_password_change_events_insert_guard
BEFORE INSERT ON public.identity_password_change_events FOR EACH ROW
EXECUTE FUNCTION public.opensales_guard_password_change_event_insert();

CREATE TABLE public.identity_email_change_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  old_email citext NOT NULL,
  new_email citext NOT NULL,
  transaction_id bigint NOT NULL DEFAULT pg_catalog.txid_current(),
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (user_id, transaction_id),
  CHECK (old_email IS DISTINCT FROM new_email)
);

CREATE OR REPLACE FUNCTION public.opensales_record_email_change_event()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    INSERT INTO public.identity_email_change_events(user_id, old_email, new_email)
    VALUES (NEW.id, OLD.email, NEW.email);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_record_email_change_event
AFTER UPDATE OF email ON public.users FOR EACH ROW
WHEN (NEW.email IS DISTINCT FROM OLD.email)
EXECUTE FUNCTION public.opensales_record_email_change_event();

CREATE OR REPLACE FUNCTION public.opensales_guard_email_change_event_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF pg_catalog.pg_trigger_depth() < 2
     OR NEW.transaction_id IS DISTINCT FROM pg_catalog.txid_current() THEN
    RAISE EXCEPTION 'email change events may only be emitted by the User email transition trigger';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_email_change_events_insert_guard
BEFORE INSERT ON public.identity_email_change_events FOR EACH ROW
EXECUTE FUNCTION public.opensales_guard_email_change_event_insert();

CREATE TABLE public.identity_action_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  actor_session_id uuid REFERENCES public.sessions(id),
  action text NOT NULL CHECK (action IN (
    'password.changed', 'password.recovered', 'email.change_requested',
    'email.changed', 'totp.enabled', 'totp.disabled',
    'totp.recovery_codes_regenerated', 'session.revoked',
    'sessions.others_revoked', 'sessions.all_revoked',
    'api_key.created', 'api_key.revoked'
  )),
  target_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  transaction_id bigint NOT NULL DEFAULT pg_catalog.txid_current(),
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
CREATE INDEX identity_action_facts_user_recorded
  ON public.identity_action_facts(user_id, recorded_at DESC, id DESC);
CREATE UNIQUE INDEX identity_action_facts_target_once
  ON public.identity_action_facts(action, target_id)
  WHERE target_id IS NOT NULL;
CREATE UNIQUE INDEX identity_action_facts_password_event_once
  ON public.identity_action_facts((metadata ->> 'passwordChangeEventId'))
  WHERE action = 'password.recovered';
CREATE UNIQUE INDEX identity_action_facts_transaction_once
  ON public.identity_action_facts(action, user_id, transaction_id);

CREATE OR REPLACE FUNCTION public.opensales_guard_identity_action_fact_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  actor_is_owned boolean;
  target_is_owned boolean;
  token_email text;
  key_name text;
  key_scopes text[];
  exact_metadata jsonb;
  count_value integer;
  actual_count bigint;
  password_event_id uuid;
BEGIN
  IF pg_catalog.jsonb_typeof(NEW.metadata) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'identity action fact metadata must be an exact JSON object';
  END IF;
  IF NEW.transaction_id IS DISTINCT FROM pg_catalog.txid_current() THEN
    RAISE EXCEPTION 'identity action fact must be recorded in its source transaction';
  END IF;

  IF NEW.actor_session_id IS NOT NULL THEN
    SELECT COALESCE(pg_catalog.bool_or(
      session.user_id = NEW.user_id
      AND (
        (NEW.action = 'session.revoked'
          AND (
            (NEW.target_id = NEW.actor_session_id
              AND session.revoked_transaction_id = pg_catalog.txid_current())
            OR
            (NEW.target_id IS DISTINCT FROM NEW.actor_session_id
              AND session.revoked_at IS NULL
              AND session.expires_at > pg_catalog.clock_timestamp())
          ))
        OR
        (NEW.action = 'sessions.all_revoked'
          AND session.revoked_transaction_id = pg_catalog.txid_current())
        OR
        (NEW.action NOT IN ('session.revoked', 'sessions.all_revoked')
          AND session.revoked_at IS NULL
          AND session.expires_at > pg_catalog.clock_timestamp())
      )
    ), false)
    INTO actor_is_owned
    FROM public.sessions session
    WHERE session.id = NEW.actor_session_id;
    IF NOT actor_is_owned THEN
      RAISE EXCEPTION 'identity action fact actor session must belong to its user';
    END IF;
  END IF;

  IF NEW.action = 'password.changed' THEN
    IF NEW.actor_session_id IS NULL OR NEW.target_id IS NULL
       OR NEW.metadata IS DISTINCT FROM '{}'::jsonb THEN
      RAISE EXCEPTION 'password.changed identity fact has an invalid shape';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.identity_password_change_events event
      WHERE event.id = NEW.target_id AND event.user_id = NEW.user_id
        AND event.transaction_id = pg_catalog.txid_current()
    ) INTO target_is_owned;
    IF NOT target_is_owned THEN
      RAISE EXCEPTION 'password.changed identity fact requires its current-transaction credential event';
    END IF;
  ELSIF NEW.action = 'password.recovered' THEN
    IF NEW.actor_session_id IS NOT NULL OR NEW.target_id IS NULL
       OR pg_catalog.jsonb_typeof(NEW.metadata -> 'revokedApiKeyCount') IS DISTINCT FROM 'number'
       OR NEW.metadata -> 'revokedAllSessions' IS DISTINCT FROM 'true'::jsonb
       OR pg_catalog.jsonb_typeof(NEW.metadata -> 'passwordChangeEventId') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'password.recovered identity fact has an invalid shape';
    END IF;
    BEGIN
      count_value := (NEW.metadata ->> 'revokedApiKeyCount')::integer;
    EXCEPTION
      WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'password.recovered revokedApiKeyCount must be a nonnegative integer';
    END;
    BEGIN
      password_event_id := (NEW.metadata ->> 'passwordChangeEventId')::uuid;
    EXCEPTION
      WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'password.recovered passwordChangeEventId must be a UUID';
    END;
    IF count_value < 0 THEN
      RAISE EXCEPTION 'password.recovered revokedApiKeyCount must be a nonnegative integer';
    END IF;
    exact_metadata := pg_catalog.jsonb_build_object(
      'revokedApiKeyCount', count_value,
      'revokedAllSessions', true,
      'passwordChangeEventId', password_event_id::text
    );
    IF NEW.metadata IS DISTINCT FROM exact_metadata THEN
      RAISE EXCEPTION 'password.recovered identity fact metadata is not exact';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.password_reset_tokens token
      WHERE token.id = NEW.target_id AND token.user_id = NEW.user_id
        AND token.used_at IS NOT NULL
        AND token.terminal_transaction_id = pg_catalog.txid_current()
    ) AND EXISTS (
      SELECT 1 FROM public.identity_password_change_events event
      WHERE event.id = password_event_id AND event.user_id = NEW.user_id
        AND event.transaction_id = pg_catalog.txid_current()
    ) AND NOT EXISTS (
      SELECT 1 FROM public.sessions session
      WHERE session.user_id = NEW.user_id AND session.revoked_at IS NULL
    ) INTO target_is_owned;
    IF NOT target_is_owned THEN
      RAISE EXCEPTION 'password.recovered identity fact requires its used token, credential event, and all Sessions revoked in the current transaction';
    END IF;
    SELECT pg_catalog.count(*)
    INTO actual_count
    FROM public.customer_api_key_revocations revocation
    JOIN public.customer_api_keys api_key ON api_key.id = revocation.api_key_id
    WHERE api_key.user_id = NEW.user_id
      AND revocation.transaction_id = pg_catalog.txid_current()
      AND revocation.reason = 'password recovery revoked the customer API key';
    IF actual_count <> count_value THEN
      RAISE EXCEPTION 'password.recovered revokedApiKeyCount must match the exact current transaction projection';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.customer_api_keys api_key
      LEFT JOIN public.customer_api_key_revocations revocation
        ON revocation.api_key_id = api_key.id
      WHERE api_key.user_id = NEW.user_id
        AND revocation.api_key_id IS NULL
    ) THEN
      RAISE EXCEPTION 'password.recovered must revoke every active customer API key';
    END IF;
  ELSIF NEW.action = 'email.change_requested' THEN
    IF NEW.actor_session_id IS NULL OR NEW.target_id IS NULL THEN
      RAISE EXCEPTION 'email.change_requested identity fact has an invalid shape';
    END IF;
    SELECT token.requested_email::text
    INTO token_email
    FROM public.email_change_tokens token
    WHERE token.id = NEW.target_id AND token.user_id = NEW.user_id
      AND token.created_transaction_id = pg_catalog.txid_current()
      AND token.used_at IS NULL AND token.invalidated_at IS NULL;
    exact_metadata := pg_catalog.jsonb_build_object('requestedEmail', token_email);
    IF token_email IS NULL OR NEW.metadata IS DISTINCT FROM exact_metadata THEN
      RAISE EXCEPTION 'email.change_requested identity fact must exactly bind its user token and email';
    END IF;
  ELSIF NEW.action = 'email.changed' THEN
    IF NEW.actor_session_id IS NULL OR NEW.target_id IS NULL
       OR NEW.metadata IS DISTINCT FROM '{}'::jsonb THEN
      RAISE EXCEPTION 'email.changed identity fact has an invalid shape';
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM public.email_change_tokens token
      JOIN public.users principal ON principal.id = token.user_id
      WHERE token.id = NEW.target_id AND token.user_id = NEW.user_id
        AND token.used_at IS NOT NULL
        AND token.terminal_transaction_id = pg_catalog.txid_current()
        AND principal.email = token.requested_email
        AND EXISTS (
          SELECT 1
          FROM public.identity_email_change_events event
          WHERE event.user_id = token.user_id
            AND event.new_email = token.requested_email
            AND event.transaction_id = pg_catalog.txid_current()
        )
    ) INTO target_is_owned;
    IF NOT target_is_owned THEN
      RAISE EXCEPTION 'email.changed identity fact target must be the user email token';
    END IF;
  ELSIF NEW.action IN ('totp.enabled', 'totp.disabled') THEN
    IF NEW.actor_session_id IS NULL OR NEW.target_id IS NULL
       OR NEW.metadata IS DISTINCT FROM '{}'::jsonb THEN
      RAISE EXCEPTION '% identity fact has an invalid shape', NEW.action;
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.user_totp_credentials credential
      WHERE credential.id = NEW.target_id AND credential.user_id = NEW.user_id
        AND (
          (NEW.action = 'totp.enabled'
            AND credential.created_transaction_id = pg_catalog.txid_current()
            AND credential.disabled_at IS NULL)
          OR
          (NEW.action = 'totp.disabled'
            AND credential.disabled_at IS NOT NULL
            AND credential.disabled_transaction_id = pg_catalog.txid_current())
        )
    ) INTO target_is_owned;
    IF NOT target_is_owned THEN
      RAISE EXCEPTION '% identity fact target must be the user TOTP credential', NEW.action;
    END IF;
  ELSIF NEW.action = 'totp.recovery_codes_regenerated' THEN
    IF NEW.actor_session_id IS NULL OR NEW.target_id IS NULL
       OR pg_catalog.jsonb_typeof(NEW.metadata -> 'count') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'totp.recovery_codes_regenerated identity fact has an invalid shape';
    END IF;
    BEGIN
      count_value := (NEW.metadata ->> 'count')::integer;
    EXCEPTION
      WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'TOTP recovery-code regeneration count must be an integer';
    END;
    exact_metadata := pg_catalog.jsonb_build_object('count', count_value);
    SELECT EXISTS (
      SELECT 1
      FROM public.totp_recovery_code_batches batch
      JOIN public.user_totp_credentials credential
        ON credential.id = batch.credential_id
      WHERE batch.id = NEW.target_id AND credential.user_id = NEW.user_id
        AND batch.kind = 'regenerated'
        AND batch.transaction_id = pg_catalog.txid_current()
        AND batch.code_count = count_value
        AND (
          SELECT pg_catalog.count(*) FROM public.totp_recovery_codes code
          WHERE code.batch_id = batch.id
        ) = count_value
    ) INTO target_is_owned;
    IF count_value < 1 OR NEW.metadata IS DISTINCT FROM exact_metadata OR NOT target_is_owned THEN
      RAISE EXCEPTION 'TOTP recovery-code regeneration fact must bind its exact current-transaction batch';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.totp_recovery_code_batches batch
      JOIN public.totp_recovery_codes code
        ON code.credential_id = batch.credential_id
      WHERE batch.id = NEW.target_id
        AND code.batch_id <> batch.id
        AND code.used_at IS NULL
        AND code.invalidated_at IS NULL
    ) THEN
      RAISE EXCEPTION 'TOTP recovery-code regeneration must retire every prior active code';
    END IF;
  ELSIF NEW.action = 'session.revoked' THEN
    IF NEW.actor_session_id IS NULL OR NEW.target_id IS NULL
       OR NEW.metadata IS DISTINCT FROM '{}'::jsonb THEN
      RAISE EXCEPTION 'session.revoked identity fact has an invalid shape';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.sessions session
      WHERE session.id = NEW.target_id AND session.user_id = NEW.user_id
        AND session.revoked_at IS NOT NULL
        AND session.revoked_transaction_id = pg_catalog.txid_current()
    ) INTO target_is_owned;
    IF NOT target_is_owned THEN
      RAISE EXCEPTION 'session.revoked identity fact target must be a session owned by the user';
    END IF;
  ELSIF NEW.action IN ('sessions.others_revoked', 'sessions.all_revoked') THEN
    IF NEW.actor_session_id IS NULL OR NEW.target_id IS NOT NULL
       OR pg_catalog.jsonb_typeof(NEW.metadata -> 'count') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION '% identity fact has an invalid shape', NEW.action;
    END IF;
    BEGIN
      count_value := (NEW.metadata ->> 'count')::integer;
    EXCEPTION
      WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION '% count must be a nonnegative integer', NEW.action;
    END;
    exact_metadata := pg_catalog.jsonb_build_object('count', count_value);
    IF count_value < 0 OR NEW.metadata IS DISTINCT FROM exact_metadata THEN
      RAISE EXCEPTION '% identity fact metadata is not exact', NEW.action;
    END IF;
    IF NEW.action = 'sessions.all_revoked' AND count_value < 1 THEN
      RAISE EXCEPTION 'sessions.all_revoked must terminate at least its current Session';
    END IF;
    SELECT pg_catalog.count(*)
    INTO actual_count
    FROM public.sessions session
    WHERE session.user_id = NEW.user_id
      AND session.revoked_transaction_id = pg_catalog.txid_current()
      AND (
        NEW.action = 'sessions.all_revoked'
        OR session.id IS DISTINCT FROM NEW.actor_session_id
      );
    IF actual_count <> count_value
       OR (NEW.action = 'sessions.others_revoked' AND EXISTS (
         SELECT 1 FROM public.sessions session
         WHERE session.id = NEW.actor_session_id
           AND session.revoked_transaction_id = pg_catalog.txid_current()
       )) THEN
      RAISE EXCEPTION '% count must match the exact current-transaction Session projection', NEW.action;
    END IF;
  ELSIF NEW.action = 'api_key.created' THEN
    IF NEW.actor_session_id IS NULL OR NEW.target_id IS NULL THEN
      RAISE EXCEPTION 'api_key.created identity fact has an invalid shape';
    END IF;
    SELECT api_key.name, api_key.scopes
    INTO key_name, key_scopes
    FROM public.customer_api_keys api_key
    WHERE api_key.id = NEW.target_id AND api_key.user_id = NEW.user_id
      AND api_key.created_transaction_id = pg_catalog.txid_current();
    exact_metadata := pg_catalog.jsonb_build_object('name', key_name, 'scopes', key_scopes);
    IF key_name IS NULL OR NEW.metadata IS DISTINCT FROM exact_metadata THEN
      RAISE EXCEPTION 'api_key.created identity fact must exactly bind its user key';
    END IF;
  ELSIF NEW.action = 'api_key.revoked' THEN
    IF NEW.actor_session_id IS NULL OR NEW.target_id IS NULL
       OR NEW.metadata IS DISTINCT FROM '{}'::jsonb THEN
      RAISE EXCEPTION 'api_key.revoked identity fact has an invalid shape';
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM public.customer_api_keys api_key
      JOIN public.customer_api_key_revocations revocation
        ON revocation.api_key_id = api_key.id
      WHERE api_key.id = NEW.target_id AND api_key.user_id = NEW.user_id
        AND revocation.transaction_id = pg_catalog.txid_current()
    ) INTO target_is_owned;
    IF NOT target_is_owned THEN
      RAISE EXCEPTION 'api_key.revoked identity fact target must be a key owned by the user';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported identity action fact';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_action_facts_insert_guard
BEFORE INSERT ON public.identity_action_facts FOR EACH ROW
EXECUTE FUNCTION public.opensales_guard_identity_action_fact_insert();

CREATE OR REPLACE FUNCTION public.opensales_reject_identity_fact_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; record a new fact', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER customer_api_keys_immutable BEFORE UPDATE OR DELETE
ON public.customer_api_keys FOR EACH ROW
EXECUTE FUNCTION public.opensales_reject_identity_fact_mutation();
CREATE TRIGGER customer_api_key_revocations_immutable BEFORE UPDATE OR DELETE
ON public.customer_api_key_revocations FOR EACH ROW
EXECUTE FUNCTION public.opensales_reject_identity_fact_mutation();
CREATE TRIGGER customer_api_key_usage_facts_immutable BEFORE UPDATE OR DELETE
ON public.customer_api_key_usage_facts FOR EACH ROW
EXECUTE FUNCTION public.opensales_reject_identity_fact_mutation();
CREATE TRIGGER totp_step_use_facts_immutable BEFORE UPDATE OR DELETE
ON public.totp_step_use_facts FOR EACH ROW
EXECUTE FUNCTION public.opensales_reject_identity_fact_mutation();
CREATE TRIGGER totp_recovery_code_batches_immutable BEFORE UPDATE OR DELETE
ON public.totp_recovery_code_batches FOR EACH ROW
EXECUTE FUNCTION public.opensales_reject_identity_fact_mutation();
CREATE TRIGGER identity_password_change_events_immutable BEFORE UPDATE OR DELETE
ON public.identity_password_change_events FOR EACH ROW
EXECUTE FUNCTION public.opensales_reject_identity_fact_mutation();
CREATE TRIGGER identity_email_change_events_immutable BEFORE UPDATE OR DELETE
ON public.identity_email_change_events FOR EACH ROW
EXECUTE FUNCTION public.opensales_reject_identity_fact_mutation();

CREATE OR REPLACE FUNCTION public.opensales_guard_totp_credential()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TOTP credentials are retained as immutable history';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.seed_ciphertext IS DISTINCT FROM OLD.seed_ciphertext
     OR NEW.seed_key_version IS DISTINCT FROM OLD.seed_key_version
     OR NEW.enabled_at IS DISTINCT FROM OLD.enabled_at
     OR NEW.created_transaction_id IS DISTINCT FROM OLD.created_transaction_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'TOTP credential identity, seed envelope, and enablement are immutable';
  END IF;
  IF OLD.disabled_at IS NOT NULL
     OR (NEW.disabled_at IS NOT NULL AND NEW.disabled_at < OLD.enabled_at) THEN
    RAISE EXCEPTION 'TOTP credential disablement is a one-way valid transition';
  END IF;
  IF NEW.disabled_at IS NOT NULL THEN
    NEW.disabled_transaction_id := pg_catalog.txid_current();
  ELSIF NEW.disabled_transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'TOTP credential disable transaction requires disablement';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER user_totp_credentials_guard BEFORE UPDATE OR DELETE
ON public.user_totp_credentials FOR EACH ROW
EXECUTE FUNCTION public.opensales_guard_totp_credential();
CREATE TRIGGER identity_notification_outbox_immutable BEFORE UPDATE OR DELETE
ON public.identity_notification_outbox FOR EACH ROW
EXECUTE FUNCTION public.opensales_reject_identity_fact_mutation();
CREATE TRIGGER identity_notification_delivery_facts_immutable BEFORE UPDATE OR DELETE
ON public.identity_notification_delivery_facts FOR EACH ROW
EXECUTE FUNCTION public.opensales_reject_identity_fact_mutation();
CREATE TRIGGER identity_action_facts_immutable BEFORE UPDATE OR DELETE
ON public.identity_action_facts FOR EACH ROW
EXECUTE FUNCTION public.opensales_reject_identity_fact_mutation();
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE
ON public.audit_events FOR EACH ROW
EXECUTE FUNCTION public.opensales_reject_identity_fact_mutation();

CREATE OR REPLACE FUNCTION public.opensales_guard_identity_token_transition()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are retained as immutable history', TG_TABLE_NAME;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR (TG_TABLE_NAME IN (
           'login_challenges', 'password_reset_tokens', 'email_change_tokens'
         )
         AND (pg_catalog.to_jsonb(NEW) ->> 'authorization_epoch') IS DISTINCT FROM
             (pg_catalog.to_jsonb(OLD) ->> 'authorization_epoch'))
     OR NEW.token_digest IS DISTINCT FROM OLD.token_digest
     OR NEW.created_transaction_id IS DISTINCT FROM OLD.created_transaction_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION '% token identity and expiry are immutable', TG_TABLE_NAME;
  END IF;
  IF TG_TABLE_NAME = 'email_change_tokens'
     AND (pg_catalog.to_jsonb(NEW) ->> 'requested_email') IS DISTINCT FROM
         (pg_catalog.to_jsonb(OLD) ->> 'requested_email') THEN
    RAISE EXCEPTION 'email change destination is immutable';
  END IF;
  IF OLD.used_at IS NOT NULL OR OLD.invalidated_at IS NOT NULL THEN
    RAISE EXCEPTION '% terminal state is immutable', TG_TABLE_NAME;
  END IF;
  IF NEW.used_at IS NULL AND NEW.invalidated_at IS NULL THEN
    RAISE EXCEPTION '% update must record one terminal state', TG_TABLE_NAME;
  END IF;
  IF NEW.used_at IS NOT NULL AND NEW.invalidated_at IS NOT NULL THEN
    RAISE EXCEPTION '% cannot be both used and invalidated', TG_TABLE_NAME;
  END IF;
  NEW.terminal_transaction_id := pg_catalog.txid_current();
  IF TG_TABLE_NAME = 'login_challenges' THEN
    IF (NEW.used_at IS NULL) IS DISTINCT FROM
       ((pg_catalog.to_jsonb(NEW) ->> 'satisfied_by') IS NULL) THEN
      RAISE EXCEPTION 'login challenge factor must be recorded exactly when used';
    END IF;
    IF NEW.invalidated_at IS NOT NULL
       AND (pg_catalog.to_jsonb(NEW) ->> 'satisfied_by') IS NOT NULL THEN
      RAISE EXCEPTION 'invalidated login challenge cannot record a factor';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER password_reset_tokens_transition_guard BEFORE UPDATE OR DELETE
ON public.password_reset_tokens FOR EACH ROW
EXECUTE FUNCTION public.opensales_guard_identity_token_transition();
CREATE TRIGGER email_change_tokens_transition_guard BEFORE UPDATE OR DELETE
ON public.email_change_tokens FOR EACH ROW
EXECUTE FUNCTION public.opensales_guard_identity_token_transition();
CREATE TRIGGER login_challenges_transition_guard BEFORE UPDATE OR DELETE
ON public.login_challenges FOR EACH ROW
EXECUTE FUNCTION public.opensales_guard_identity_token_transition();

CREATE OR REPLACE FUNCTION public.opensales_guard_lab_identity_mailbox_capability()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'laboratory mailbox capabilities are retained as immutable history';
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM 1
    FROM public.users principal
    WHERE principal.id = NEW.user_id
      AND principal.email = NEW.recipient
      AND principal.authorization_epoch = NEW.authorization_epoch
    FOR SHARE NOWAIT;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'laboratory mailbox capability must bind the current User email';
    END IF;
    PERFORM 1
    FROM public.sessions origin
    WHERE origin.id = NEW.origin_session_id
      AND origin.user_id = NEW.user_id
      AND origin.revoked_at IS NULL
      AND origin.expires_at > pg_catalog.clock_timestamp()
    FOR SHARE NOWAIT;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'laboratory mailbox capability must bind an active originating Session';
    END IF;
    IF NEW.revoked_at IS NOT NULL OR NEW.revoked_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'new laboratory mailbox capability must be active';
    END IF;
    NEW.created_transaction_id := pg_catalog.txid_current();
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.origin_session_id IS DISTINCT FROM OLD.origin_session_id
     OR NEW.recipient IS DISTINCT FROM OLD.recipient
     OR NEW.authorization_epoch IS DISTINCT FROM OLD.authorization_epoch
     OR NEW.token_digest IS DISTINCT FROM OLD.token_digest
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_transaction_id IS DISTINCT FROM OLD.created_transaction_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'laboratory mailbox capability identity and expiry are immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'laboratory mailbox capability revocation is immutable';
  END IF;
  IF NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'laboratory mailbox capability update must revoke it';
  END IF;
  NEW.revoked_transaction_id := pg_catalog.txid_current();
  RETURN NEW;
END;
$$;
CREATE TRIGGER lab_identity_mailbox_capabilities_guard BEFORE INSERT OR UPDATE OR DELETE
ON public.lab_identity_mailbox_capabilities FOR EACH ROW
EXECUTE FUNCTION public.opensales_guard_lab_identity_mailbox_capability();

CREATE OR REPLACE FUNCTION public.opensales_revoke_lab_identity_mailbox_capability_for_session()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.lab_identity_mailbox_capabilities
  SET revoked_at = pg_catalog.clock_timestamp()
  WHERE origin_session_id = NEW.id AND revoked_at IS NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sessions_revoke_lab_identity_mailbox_capability
AFTER UPDATE OF revoked_at ON public.sessions
FOR EACH ROW
WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
EXECUTE FUNCTION public.opensales_revoke_lab_identity_mailbox_capability_for_session();

CREATE OR REPLACE FUNCTION public.opensales_guard_totp_enrollment_transition()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TOTP enrollment rows are retained as immutable history';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.seed_ciphertext IS DISTINCT FROM OLD.seed_ciphertext
     OR NEW.seed_key_version IS DISTINCT FROM OLD.seed_key_version
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'TOTP enrollment identity, seed envelope, and expiry are immutable';
  END IF;
  IF OLD.confirmed_at IS NOT NULL OR OLD.invalidated_at IS NOT NULL THEN
    RAISE EXCEPTION 'TOTP enrollment terminal state is immutable';
  END IF;
  IF NEW.confirmed_at IS NULL AND NEW.invalidated_at IS NULL THEN
    RAISE EXCEPTION 'TOTP enrollment update must record one terminal state';
  END IF;
  IF NEW.confirmed_at IS NOT NULL AND NEW.invalidated_at IS NOT NULL THEN
    RAISE EXCEPTION 'TOTP enrollment cannot be both confirmed and invalidated';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER totp_enrollment_challenges_transition_guard BEFORE UPDATE OR DELETE
ON public.totp_enrollment_challenges FOR EACH ROW
EXECUTE FUNCTION public.opensales_guard_totp_enrollment_transition();

CREATE OR REPLACE FUNCTION public.opensales_guard_totp_recovery_code_transition()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TOTP recovery-code rows are retained as immutable history';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.credential_id IS DISTINCT FROM OLD.credential_id
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.code_digest IS DISTINCT FROM OLD.code_digest
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'TOTP recovery-code identity and digest are immutable';
  END IF;
  IF OLD.used_at IS NOT NULL OR OLD.invalidated_at IS NOT NULL THEN
    RAISE EXCEPTION 'TOTP recovery-code terminal state is immutable';
  END IF;
  IF NEW.used_at IS NULL AND NEW.invalidated_at IS NULL THEN
    RAISE EXCEPTION 'TOTP recovery-code update must record one terminal state';
  END IF;
  IF NEW.used_at IS NOT NULL AND NEW.invalidated_at IS NOT NULL THEN
    RAISE EXCEPTION 'TOTP recovery code cannot be both used and invalidated';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER totp_recovery_codes_transition_guard BEFORE UPDATE OR DELETE
ON public.totp_recovery_codes FOR EACH ROW
EXECUTE FUNCTION public.opensales_guard_totp_recovery_code_transition();

CREATE OR REPLACE FUNCTION public.opensales_guard_session_revocation_transaction()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NULL AND NEW.revoked_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'Session revocation transaction requires revocation';
    ELSIF NEW.revoked_at IS NOT NULL THEN
      IF NEW.revoked_transaction_id IS NOT NULL THEN
        RAISE EXCEPTION 'Session revocation source transaction cannot be supplied';
      END IF;
      NEW.revoked_transaction_id := pg_catalog.txid_current();
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    NEW.revoked_transaction_id := pg_catalog.txid_current();
  ELSIF OLD.revoked_at IS NOT NULL AND (
    NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
    OR NEW.revoked_transaction_id IS DISTINCT FROM OLD.revoked_transaction_id
  ) THEN
    RAISE EXCEPTION 'Session revocation time and source transaction are immutable';
  ELSIF NEW.revoked_at IS NULL
        AND NEW.revoked_transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'Session revocation transaction requires revocation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sessions_revocation_transaction_insert_guard
BEFORE INSERT ON public.sessions
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_session_revocation_transaction();
CREATE TRIGGER sessions_revocation_transaction_guard
BEFORE UPDATE OF revoked_at, revoked_transaction_id ON public.sessions
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_session_revocation_transaction();

CREATE OR REPLACE FUNCTION public.opensales_invalidate_session_reauth_on_revoke()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
    UPDATE public.reauth_grants grant_record
    SET invalidated_at = pg_catalog.now()
    WHERE grant_record.session_id = NEW.id
      AND grant_record.invalidated_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sessions_invalidate_reauth_on_revoke AFTER UPDATE OF revoked_at
ON public.sessions FOR EACH ROW
EXECUTE FUNCTION public.opensales_invalidate_session_reauth_on_revoke();

CREATE OR REPLACE FUNCTION public.opensales_bump_credential_authorization_epoch()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email
     OR NEW.password_hash IS DISTINCT FROM OLD.password_hash
     OR NEW.email_verified_at IS DISTINCT FROM OLD.email_verified_at
     OR NEW.restricted_at IS DISTINCT FROM OLD.restricted_at THEN
    -- Every identity eligibility or credential transition follows the shared
    -- User -> Sessions -> reauthentication-grants order. Schema 019 may
    -- subsequently re-lock the same Session rows for its context projection.
    PERFORM session_record.id
    FROM public.sessions session_record
    WHERE session_record.user_id = NEW.id
      AND session_record.revoked_at IS NULL
    ORDER BY session_record.id
    FOR UPDATE NOWAIT;
    -- Schema 019 owns the Session context bump for verification/restriction.
    -- Only credential-only changes need the forward 024 Session bump here.
    IF (NEW.email IS DISTINCT FROM OLD.email
        OR NEW.password_hash IS DISTINCT FROM OLD.password_hash)
       AND NEW.email_verified_at IS NOT DISTINCT FROM OLD.email_verified_at
       AND NEW.restricted_at IS NOT DISTINCT FROM OLD.restricted_at THEN
    UPDATE public.sessions session_record
    SET account_context_version = account_context_version + 1
    WHERE session_record.user_id = NEW.id
      AND session_record.revoked_at IS NULL;
    END IF;
    NEW.authorization_epoch := OLD.authorization_epoch + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_bump_credential_authorization_epoch
BEFORE UPDATE OF email, password_hash, email_verified_at, restricted_at
ON public.users FOR EACH ROW
EXECUTE FUNCTION public.opensales_bump_credential_authorization_epoch();

CREATE OR REPLACE FUNCTION public.opensales_guard_authorization_epoch()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.authorization_epoch < OLD.authorization_epoch THEN
    RAISE EXCEPTION 'User authorization epoch cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_authorization_epoch_monotonic
BEFORE UPDATE OF authorization_epoch ON public.users FOR EACH ROW
EXECUTE FUNCTION public.opensales_guard_authorization_epoch();

CREATE OR REPLACE FUNCTION public.opensales_invalidate_reauth_on_authorization_epoch()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- Authorization epoch is the single revocation boundary for credentials,
  -- identity eligibility, TOTP, Membership and Staff authority. Keep every
  -- current reauthentication grant on the same User -> Sessions -> grants
  -- lock order regardless of which source advanced the epoch.
  PERFORM session_record.id
  FROM public.sessions session_record
  WHERE session_record.user_id = NEW.id
    AND session_record.revoked_at IS NULL
  ORDER BY session_record.id
  FOR UPDATE NOWAIT;
  UPDATE public.reauth_grants grant_record
  SET invalidated_at = pg_catalog.now()
  WHERE grant_record.user_id = NEW.id
    AND grant_record.invalidated_at IS NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_authorization_epoch_invalidate_reauth
AFTER UPDATE OF authorization_epoch ON public.users
FOR EACH ROW
WHEN (NEW.authorization_epoch IS DISTINCT FROM OLD.authorization_epoch)
EXECUTE FUNCTION public.opensales_invalidate_reauth_on_authorization_epoch();

CREATE OR REPLACE FUNCTION public.opensales_bump_membership_authorization_epoch()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  affected_user_id uuid;
  authorization_changed boolean;
BEGIN
  affected_user_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  authorization_changed := TG_OP IN ('INSERT', 'DELETE')
    OR NEW.role IS DISTINCT FROM OLD.role
    OR NEW.permissions IS DISTINCT FROM OLD.permissions
    OR NEW.removed_at IS DISTINCT FROM OLD.removed_at
    OR NEW.restricted_at IS DISTINCT FROM OLD.restricted_at;
  IF authorization_changed THEN
    PERFORM principal.id
    FROM public.users principal
    WHERE principal.id = affected_user_id
    FOR UPDATE NOWAIT;
    UPDATE public.users principal
    SET authorization_epoch = authorization_epoch + 1,
        updated_at = pg_catalog.now()
    WHERE principal.id = affected_user_id;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER client_memberships_bump_authorization_epoch
AFTER INSERT OR UPDATE OF role, permissions, removed_at, restricted_at OR DELETE
ON public.client_memberships FOR EACH ROW
EXECUTE FUNCTION public.opensales_bump_membership_authorization_epoch();

CREATE OR REPLACE FUNCTION public.opensales_bump_staff_authorization_epoch()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  affected_user_id uuid;
  authorization_changed boolean;
BEGIN
  affected_user_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  authorization_changed := TG_OP IN ('INSERT', 'DELETE')
    OR NEW.active IS DISTINCT FROM OLD.active
    OR NEW.roles IS DISTINCT FROM OLD.roles
    OR NEW.permissions IS DISTINCT FROM OLD.permissions;
  IF authorization_changed THEN
    PERFORM principal.id
    FROM public.users principal
    WHERE principal.id = affected_user_id
    FOR UPDATE NOWAIT;
    UPDATE public.users principal
    SET authorization_epoch = authorization_epoch + 1,
        updated_at = pg_catalog.now()
    WHERE principal.id = affected_user_id;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER staff_members_bump_authorization_epoch
AFTER INSERT OR UPDATE OF active, roles, permissions OR DELETE
ON public.staff_members FOR EACH ROW
EXECUTE FUNCTION public.opensales_bump_staff_authorization_epoch();
