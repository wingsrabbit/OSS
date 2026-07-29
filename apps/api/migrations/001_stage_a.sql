-- SPDX-License-Identifier: AGPL-3.0-or-later

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'zh-CN')),
  email_verified_at timestamptz,
  restricted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verification_policy_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  policy jsonb NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_digest bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_digest bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS client_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  restricted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS client_memberships (
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner', 'billing', 'technical', 'viewer')),
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_account_id, user_id)
);

CREATE TABLE IF NOT EXISTS legal_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('terms', 'aup', 'privacy')),
  locale text NOT NULL CHECK (locale IN ('en', 'zh-CN')),
  version text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, locale, version)
);

CREATE TABLE IF NOT EXISTS product_groups (
  id text PRIMARY KEY,
  sort_order integer NOT NULL DEFAULT 0,
  names jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES product_groups(id),
  names jsonb NOT NULL,
  descriptions jsonb NOT NULL,
  fulfillment_mode text NOT NULL CHECK (fulfillment_mode IN ('automatic', 'review', 'manual', 'quote')),
  active boolean NOT NULL DEFAULT true,
  hidden boolean NOT NULL DEFAULT false,
  repeatable boolean NOT NULL DEFAULT false,
  option_schema jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id text NOT NULL REFERENCES products(id),
  revision integer NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  billing_cycle text NOT NULL CHECK (billing_cycle IN ('monthly', 'quarterly', 'semiannual', 'annual', 'one_time')),
  one_time_minor bigint NOT NULL DEFAULT 0 CHECK (one_time_minor >= 0),
  setup_minor bigint NOT NULL DEFAULT 0 CHECK (setup_minor >= 0),
  recurring_minor bigint NOT NULL DEFAULT 0 CHECK (recurring_minor >= 0),
  active boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  UNIQUE (product_id, revision, billing_cycle)
);

CREATE TABLE IF NOT EXISTS legal_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  document_id uuid NOT NULL REFERENCES legal_documents(id),
  accepted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  submitted_by_user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('waiting_payment', 'on_hold', 'accepted', 'awaiting_manual', 'fulfilling', 'completed', 'rejected', 'cancelled')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_snapshot jsonb NOT NULL,
  one_time_minor bigint NOT NULL CHECK (one_time_minor >= 0),
  setup_minor bigint NOT NULL CHECK (setup_minor >= 0),
  recurring_minor bigint NOT NULL CHECK (recurring_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  idempotency_key text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_account_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  product_id text NOT NULL,
  product_name text NOT NULL,
  fulfillment_mode text NOT NULL,
  billing_cycle text NOT NULL,
  configuration jsonb NOT NULL,
  price_snapshot jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  order_id uuid REFERENCES orders(id),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  due_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  kind text NOT NULL CHECK (kind IN ('one_time', 'setup', 'recurring', 'credit', 'payment_fee', 'late_fee', 'tax')),
  description text NOT NULL,
  amount_minor bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  provider_installation_id text NOT NULL,
  external_payment_id text,
  status text NOT NULL CHECK (status IN ('created', 'processing', 'unknown', 'succeeded', 'failed', 'cancelled', 'expired')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  scenario text NOT NULL,
  idempotency_key text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_account_id, idempotency_key),
  UNIQUE (provider_installation_id, external_payment_id)
);

CREATE TABLE IF NOT EXISTS provider_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_installation_id text NOT NULL,
  external_event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_installation_id, external_event_id)
);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_attempt_id uuid NOT NULL REFERENCES payment_attempts(id),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_attempt_id, invoice_id)
);

CREATE TABLE IF NOT EXISTS ledger_journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  currency text NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id)
);

CREATE TABLE IF NOT EXISTS ledger_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id uuid NOT NULL REFERENCES ledger_journals(id),
  account_code text NOT NULL,
  debit_minor bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  CHECK ((debit_minor = 0) <> (credit_minor = 0))
);

CREATE TABLE IF NOT EXISTS services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES client_accounts(id),
  order_item_id uuid NOT NULL UNIQUE REFERENCES order_items(id),
  status text NOT NULL CHECK (status IN ('pending', 'provisioning', 'confirming', 'provisioned_hold', 'active', 'suspended', 'terminated')),
  billing_cycle text NOT NULL,
  external_resource_id text UNIQUE,
  activated_at timestamptz,
  term_start timestamptz,
  term_end timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_installation_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('payment_create', 'payment_reconcile', 'resource_create', 'resource_reconcile')),
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  stable_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'unknown', 'succeeded', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  external_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_installation_id, kind, stable_key)
);

CREATE TABLE IF NOT EXISTS durable_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  unique_key text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'manual')),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_type, unique_key)
);

CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  unique_key text NOT NULL,
  payload jsonb NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_type, unique_key)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS durable_jobs_claim_idx
  ON durable_jobs (available_at, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS memberships_active_idx
  ON client_memberships (user_id, client_account_id)
  WHERE removed_at IS NULL;
