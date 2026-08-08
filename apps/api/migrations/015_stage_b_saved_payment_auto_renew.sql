-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE payment_methods
  ADD COLUMN IF NOT EXISTS saved_method_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS automatic_renewal_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE provider_installation_capabilities
  DROP CONSTRAINT IF EXISTS provider_installation_capabilities_provider_type_check;
ALTER TABLE provider_installation_capabilities
  ADD CONSTRAINT provider_installation_capabilities_provider_type_check
  CHECK (provider_type IN ('payment', 'provisioning', 'mail', 'verification', 'tax', 'challenge'));

CREATE TABLE IF NOT EXISTS payment_method_token_key_materials (
  material_fingerprint bytea PRIMARY KEY CHECK (octet_length(material_fingerprint) = 32),
  key_kind text NOT NULL CHECK (key_kind IN ('encryption', 'lookup')),
  key_version integer NOT NULL CHECK (key_version > 0),
  registered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key_kind, key_version)
);

CREATE TABLE IF NOT EXISTS payment_method_token_encryption_keys (
  version integer PRIMARY KEY CHECK (version > 0),
  key_fingerprint bytea NOT NULL CHECK (octet_length(key_fingerprint) = 32),
  registered_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_method_token_lookup_keys (
  version integer PRIMARY KEY CHECK (version > 0),
  key_fingerprint bytea NOT NULL CHECK (octet_length(key_fingerprint) = 32),
  registered_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS automatic_renewal_consent_generation bigint NOT NULL DEFAULT 0
    CHECK (automatic_renewal_consent_generation >= 0),
  ADD COLUMN IF NOT EXISTS automatic_renewal_decision_generation bigint NOT NULL DEFAULT 0
    CHECK (automatic_renewal_decision_generation >= automatic_renewal_consent_generation);

CREATE OR REPLACE FUNCTION opensales_guard_service_automatic_renewal_generations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.automatic_renewal_consent_generation < OLD.automatic_renewal_consent_generation
     OR NEW.automatic_renewal_decision_generation < OLD.automatic_renewal_decision_generation
     OR NEW.automatic_renewal_decision_generation < NEW.automatic_renewal_consent_generation THEN
    RAISE EXCEPTION 'automatic-renewal generations cannot move backward';
  END IF;
  IF (
       NEW.automatic_renewal_consent_generation
         IS DISTINCT FROM OLD.automatic_renewal_consent_generation
       OR NEW.automatic_renewal_decision_generation
         IS DISTINCT FROM OLD.automatic_renewal_decision_generation
     )
     AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'automatic-renewal generation change requires one service version advance';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS services_automatic_renewal_generation_monotonic ON services;
CREATE TRIGGER services_automatic_renewal_generation_monotonic
BEFORE UPDATE OF
  automatic_renewal_consent_generation,
  automatic_renewal_decision_generation
ON services
FOR EACH ROW EXECUTE FUNCTION opensales_guard_service_automatic_renewal_generations();

CREATE TABLE IF NOT EXISTS saved_payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  provider_installation_id text NOT NULL,
  payment_method_code text NOT NULL REFERENCES payment_methods(code),
  provider_token_ciphertext text NOT NULL CHECK (length(provider_token_ciphertext) BETWEEN 40 AND 1200),
  provider_token_digest bytea NOT NULL CHECK (octet_length(provider_token_digest) = 32),
  encryption_key_version integer NOT NULL DEFAULT 1
    REFERENCES payment_method_token_encryption_keys(version),
  lookup_key_version integer NOT NULL DEFAULT 1
    REFERENCES payment_method_token_lookup_keys(version),
  instrument_type text NOT NULL CHECK (instrument_type ~ '^[a-z][a-z0-9_-]{1,31}$'),
  brand text NOT NULL CHECK (length(brand) BETWEEN 1 AND 40),
  last_four text NOT NULL CHECK (last_four ~ '^[0-9A-Za-z]{4}$'),
  expiry_month integer CHECK (expiry_month BETWEEN 1 AND 12),
  expiry_year integer CHECK (expiry_year BETWEEN 2020 AND 2200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalid', 'removed')),
  is_default boolean NOT NULL DEFAULT false,
  save_consent_version text NOT NULL CHECK (length(save_consent_version) BETWEEN 1 AND 80),
  saved_by_user_id uuid NOT NULL REFERENCES users(id),
  saved_at timestamptz NOT NULL DEFAULT now(),
  invalidated_at timestamptz,
  removed_at timestamptz,
  removed_by_user_id uuid REFERENCES users(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_installation_id, provider_token_digest),
  CHECK ((status = 'invalid') = (invalidated_at IS NOT NULL)),
  CHECK ((status = 'removed') = (removed_at IS NOT NULL)),
  CHECK ((status = 'removed') = (removed_by_user_id IS NOT NULL)),
  CHECK (status = 'active' OR NOT is_default)
);

CREATE UNIQUE INDEX IF NOT EXISTS saved_payment_methods_one_default_idx
  ON saved_payment_methods(client_account_id)
  WHERE is_default AND status = 'active';
CREATE INDEX IF NOT EXISTS saved_payment_methods_account_idx
  ON saved_payment_methods(client_account_id, saved_at DESC, id);

CREATE TABLE IF NOT EXISTS automatic_renewal_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES services(id),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  saved_payment_method_id uuid NOT NULL REFERENCES saved_payment_methods(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  consent_version text NOT NULL CHECK (length(consent_version) BETWEEN 1 AND 80),
  consent_generation bigint NOT NULL CHECK (consent_generation > 0),
  granted_by_user_id uuid NOT NULL REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by_user_id uuid REFERENCES users(id),
  revoked_at timestamptz,
  revocation_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_by_user_id IS NOT NULL)),
  CHECK (status = 'active' OR length(revocation_reason) BETWEEN 3 AND 500)
);

CREATE UNIQUE INDEX IF NOT EXISTS automatic_renewal_authorizations_one_active_idx
  ON automatic_renewal_authorizations(service_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS automatic_renewal_authorizations_account_idx
  ON automatic_renewal_authorizations(client_account_id, granted_at DESC, id);

CREATE TABLE IF NOT EXISTS payment_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  service_id uuid REFERENCES services(id),
  saved_payment_method_id uuid REFERENCES saved_payment_methods(id),
  automatic_renewal_authorization_id uuid REFERENCES automatic_renewal_authorizations(id),
  event_type text NOT NULL CHECK (
    event_type IN (
      'method_saved',
      'method_made_default',
      'method_default_cleared',
      'method_invalidated',
      'method_removed',
      'token_rewrapped',
      'automatic_renewal_enabled',
      'automatic_renewal_pending_withdrawn',
      'automatic_renewal_revoked'
    )
  ),
  consent_version text,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'system', 'provider')),
  actor_id text NOT NULL,
  reason text,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 180),
  request_fingerprint text NOT NULL CHECK (length(request_fingerprint) = 64),
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_account_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS automatic_renewal_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_renewal_id uuid NOT NULL UNIQUE REFERENCES service_renewals(id),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  automatic_renewal_authorization_id uuid NOT NULL
    REFERENCES automatic_renewal_authorizations(id),
  saved_payment_method_id uuid NOT NULL REFERENCES saved_payment_methods(id),
  invoice_payment_command_id uuid NOT NULL UNIQUE REFERENCES invoice_payment_commands(id),
  payment_attempt_id uuid NOT NULL UNIQUE REFERENCES payment_attempts(id),
  status text NOT NULL CHECK (
    status IN (
      'processing', 'unknown', 'succeeded', 'failed',
      'requires_action', 'blocked'
    )
  ),
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 3),
  max_attempts integer NOT NULL DEFAULT 1 CHECK (max_attempts BETWEEN 1 AND 3),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (attempt_count <= max_attempts)
);

CREATE INDEX IF NOT EXISTS automatic_renewal_runs_account_idx
  ON automatic_renewal_runs(client_account_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS payment_consent_events_account_idx
  ON payment_consent_events(client_account_id, created_at DESC, id);

ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS save_payment_method_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS save_consent_version text,
  ADD COLUMN IF NOT EXISTS automatic_renewal_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS automatic_renewal_consent_version text,
  ADD COLUMN IF NOT EXISTS automatic_renewal_service_id uuid REFERENCES services(id),
  ADD COLUMN IF NOT EXISTS automatic_renewal_decision_generation bigint,
  ADD COLUMN IF NOT EXISTS saved_payment_method_id uuid REFERENCES saved_payment_methods(id),
  ADD COLUMN IF NOT EXISTS automatic_renewal_authorization_id uuid
    REFERENCES automatic_renewal_authorizations(id),
  ADD COLUMN IF NOT EXISTS created_automatic_renewal_authorization_id uuid
    REFERENCES automatic_renewal_authorizations(id),
  ADD COLUMN IF NOT EXISTS automatic_attempt_number integer NOT NULL DEFAULT 0
    CHECK (automatic_attempt_number BETWEEN 0 AND 3);

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_status_check;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_status_check CHECK (
    status IN (
      'created', 'processing', 'unknown', 'succeeded', 'failed',
      'cancelled', 'expired', 'requires_action'
    )
  );

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_save_consent_check,
  DROP CONSTRAINT IF EXISTS payment_attempts_automatic_consent_check;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_save_consent_check CHECK (
    save_payment_method_requested = (save_consent_version IS NOT NULL)
  ),
  ADD CONSTRAINT payment_attempts_automatic_consent_check CHECK (
    automatic_renewal_requested = (automatic_renewal_consent_version IS NOT NULL)
    AND automatic_renewal_requested = (automatic_renewal_service_id IS NOT NULL)
    AND automatic_renewal_requested =
          (automatic_renewal_decision_generation IS NOT NULL)
    AND (
      automatic_renewal_decision_generation IS NULL
      OR automatic_renewal_decision_generation > 0
    )
    AND (NOT automatic_renewal_requested OR save_payment_method_requested)
  );

CREATE OR REPLACE FUNCTION opensales_validate_payment_automatic_consent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  service_row record;
BEGIN
  IF NOT NEW.automatic_renewal_requested THEN
    RETURN NEW;
  END IF;
  SELECT client_account_id, automatic_renewal_decision_generation
  INTO service_row
  FROM services
  WHERE id = NEW.automatic_renewal_service_id;
  IF service_row.client_account_id IS DISTINCT FROM NEW.client_account_id
     OR service_row.automatic_renewal_decision_generation
          IS DISTINCT FROM NEW.automatic_renewal_decision_generation THEN
    RAISE EXCEPTION 'payment automatic-renewal consent ownership or generation is invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_attempts_automatic_consent_validate ON payment_attempts;
CREATE TRIGGER payment_attempts_automatic_consent_validate
BEFORE INSERT OR UPDATE OF
  client_account_id,
  automatic_renewal_requested,
  automatic_renewal_consent_version,
  automatic_renewal_service_id,
  automatic_renewal_decision_generation
ON payment_attempts
FOR EACH ROW EXECUTE FUNCTION opensales_validate_payment_automatic_consent();

CREATE OR REPLACE FUNCTION opensales_reject_payment_consent_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'payment consent events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS payment_consent_events_append_only ON payment_consent_events;
CREATE TRIGGER payment_consent_events_append_only
BEFORE UPDATE OR DELETE ON payment_consent_events
FOR EACH ROW EXECUTE FUNCTION opensales_reject_payment_consent_event_mutation();

CREATE OR REPLACE FUNCTION opensales_reject_payment_method_token_key_registry_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'payment method token key registry is append-only';
END;
$$;

DROP TRIGGER IF EXISTS payment_method_token_key_materials_append_only
  ON payment_method_token_key_materials;
CREATE TRIGGER payment_method_token_key_materials_append_only
BEFORE UPDATE OR DELETE ON payment_method_token_key_materials
FOR EACH ROW EXECUTE FUNCTION opensales_reject_payment_method_token_key_registry_mutation();

DROP TRIGGER IF EXISTS payment_method_token_encryption_keys_append_only
  ON payment_method_token_encryption_keys;
CREATE TRIGGER payment_method_token_encryption_keys_append_only
BEFORE UPDATE OR DELETE ON payment_method_token_encryption_keys
FOR EACH ROW EXECUTE FUNCTION opensales_reject_payment_method_token_key_registry_mutation();

DROP TRIGGER IF EXISTS payment_method_token_lookup_keys_append_only
  ON payment_method_token_lookup_keys;
CREATE TRIGGER payment_method_token_lookup_keys_append_only
BEFORE UPDATE OR DELETE ON payment_method_token_lookup_keys
FOR EACH ROW EXECUTE FUNCTION opensales_reject_payment_method_token_key_registry_mutation();

CREATE OR REPLACE FUNCTION opensales_validate_saved_payment_method()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM payment_methods method
    WHERE method.code = NEW.payment_method_code
      AND method.provider_installation_id = NEW.provider_installation_id
      AND method.saved_method_enabled
  ) THEN
    RAISE EXCEPTION 'payment method does not support saved Provider tokens';
  END IF;
  IF NEW.encryption_key_version IS DISTINCT FROM (
       SELECT max(version) FROM payment_method_token_encryption_keys
     )
     OR NEW.lookup_key_version IS DISTINCT FROM (
       SELECT max(version) FROM payment_method_token_lookup_keys
     ) THEN
    RAISE EXCEPTION 'saved payment method must use the active token key versions';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS saved_payment_methods_validate ON saved_payment_methods;
CREATE TRIGGER saved_payment_methods_validate
BEFORE INSERT OR UPDATE OF
  provider_installation_id,
  payment_method_code,
  encryption_key_version,
  lookup_key_version
ON saved_payment_methods
FOR EACH ROW EXECUTE FUNCTION opensales_validate_saved_payment_method();

CREATE OR REPLACE FUNCTION opensales_validate_automatic_renewal_authorization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  method_row record;
  service_row record;
BEGIN
  -- Revocation must remain possible after a Provider or payment method is
  -- disabled. Customer withdrawal can never depend on current capability.
  IF NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;

  SELECT client_account_id, automatic_renewal_consent_generation
  INTO service_row
  FROM services WHERE id = NEW.service_id;

  SELECT saved.client_account_id, saved.status, method.automatic_renewal_enabled
  INTO method_row
  FROM saved_payment_methods saved
  JOIN payment_methods method
    ON method.code = saved.payment_method_code
   AND method.provider_installation_id = saved.provider_installation_id
  WHERE saved.id = NEW.saved_payment_method_id;

  IF service_row.client_account_id IS DISTINCT FROM NEW.client_account_id
     OR service_row.automatic_renewal_consent_generation
          IS DISTINCT FROM NEW.consent_generation
     OR method_row.client_account_id IS DISTINCT FROM NEW.client_account_id
     OR method_row.status IS DISTINCT FROM 'active'
     OR NOT COALESCE(method_row.automatic_renewal_enabled, false) THEN
    RAISE EXCEPTION 'automatic renewal ownership or payment method capability is invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS automatic_renewal_authorizations_validate
  ON automatic_renewal_authorizations;
CREATE TRIGGER automatic_renewal_authorizations_validate
BEFORE INSERT OR UPDATE OF service_id, client_account_id, saved_payment_method_id, status
ON automatic_renewal_authorizations
FOR EACH ROW EXECUTE FUNCTION opensales_validate_automatic_renewal_authorization();

CREATE OR REPLACE FUNCTION opensales_guard_payment_method_secret_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  secret_changed boolean;
BEGIN
  secret_changed := NEW.provider_token_ciphertext IS DISTINCT FROM OLD.provider_token_ciphertext
    OR NEW.provider_token_digest IS DISTINCT FROM OLD.provider_token_digest
    OR NEW.encryption_key_version IS DISTINCT FROM OLD.encryption_key_version
    OR NEW.lookup_key_version IS DISTINCT FROM OLD.lookup_key_version;

  IF NEW.client_account_id IS DISTINCT FROM OLD.client_account_id
     OR NEW.provider_installation_id IS DISTINCT FROM OLD.provider_installation_id
     OR NEW.payment_method_code IS DISTINCT FROM OLD.payment_method_code
     OR NEW.instrument_type IS DISTINCT FROM OLD.instrument_type
     OR NEW.brand IS DISTINCT FROM OLD.brand
     OR NEW.last_four IS DISTINCT FROM OLD.last_four
     OR NEW.expiry_month IS DISTINCT FROM OLD.expiry_month
     OR NEW.expiry_year IS DISTINCT FROM OLD.expiry_year
     OR NEW.save_consent_version IS DISTINCT FROM OLD.save_consent_version
     OR NEW.saved_by_user_id IS DISTINCT FROM OLD.saved_by_user_id
     OR NEW.saved_at IS DISTINCT FROM OLD.saved_at THEN
    RAISE EXCEPTION 'saved payment method identity is immutable';
  END IF;

  IF secret_changed THEN
    IF current_setting('opensales.payment_method_rewrap', true) IS DISTINCT FROM 'authorized'
       OR NEW.provider_token_ciphertext IS NOT DISTINCT FROM OLD.provider_token_ciphertext
       OR NEW.encryption_key_version < OLD.encryption_key_version
       OR NEW.lookup_key_version < OLD.lookup_key_version
       OR NEW.provider_token_ciphertext NOT LIKE
            'v2.' || NEW.encryption_key_version::text || '.%'
       OR (
         NEW.encryption_key_version = OLD.encryption_key_version
         AND NEW.lookup_key_version = OLD.lookup_key_version
         AND OLD.provider_token_ciphertext NOT LIKE 'v1.%'
       )
       OR NEW.version <> OLD.version + 1
       OR NEW.updated_at <= OLD.updated_at THEN
      RAISE EXCEPTION 'saved payment method token rewrap is not authorized or monotonic';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS saved_payment_methods_identity_immutable ON saved_payment_methods;
CREATE TRIGGER saved_payment_methods_identity_immutable
BEFORE UPDATE ON saved_payment_methods
FOR EACH ROW EXECUTE FUNCTION opensales_guard_payment_method_secret_identity();

CREATE OR REPLACE FUNCTION opensales_guard_automatic_renewal_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.service_id IS DISTINCT FROM OLD.service_id
     OR NEW.client_account_id IS DISTINCT FROM OLD.client_account_id
     OR NEW.saved_payment_method_id IS DISTINCT FROM OLD.saved_payment_method_id
     OR NEW.consent_version IS DISTINCT FROM OLD.consent_version
     OR NEW.consent_generation IS DISTINCT FROM OLD.consent_generation
     OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
    RAISE EXCEPTION 'automatic renewal authorization identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS automatic_renewal_authorizations_identity_immutable
  ON automatic_renewal_authorizations;
CREATE TRIGGER automatic_renewal_authorizations_identity_immutable
BEFORE UPDATE ON automatic_renewal_authorizations
FOR EACH ROW EXECUTE FUNCTION opensales_guard_automatic_renewal_identity();

CREATE OR REPLACE FUNCTION opensales_invalidate_membership_reauth()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role
     OR NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
    UPDATE reauth_grants
    SET invalidated_at = now()
    WHERE user_id = NEW.user_id AND invalidated_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS client_memberships_invalidate_reauth ON client_memberships;
CREATE TRIGGER client_memberships_invalidate_reauth
AFTER UPDATE OF role, removed_at ON client_memberships
FOR EACH ROW EXECUTE FUNCTION opensales_invalidate_membership_reauth();
