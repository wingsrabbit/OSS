// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import {
  assert014RollbackBridgeSafe,
  SchemaRollbackPreflightError,
} from "@opensales/core/schema-rollback-compatibility";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for rollback preflight integration");

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 2,
  statement_timeout: 15_000,
  application_name: "opensales-rollback-preflight-integration",
});
const client = await pool.connect();
const database = {
  query: async (text: string, values?: unknown[]) => client.query(text, values),
};

try {
  await client.query("BEGIN");
  const original = await client.query<{ version: string | null }>(
    "SELECT max(version) AS version FROM schema_migrations",
  );
  assert.equal(original.rows[0]?.version, "014_stage_b_cycle_end_cancellation");

  const native = await assert014RollbackBridgeSafe(database, {
    enable015RollbackBridge: false,
  });
  assert.equal(native.mode, "native");

  await client.query("DELETE FROM schema_migrations");
  await assert.rejects(
    assert014RollbackBridgeSafe(database, { enable015RollbackBridge: false }),
    /schema is missing/,
  );
  await client.query(
    "INSERT INTO schema_migrations(version) VALUES ('013_stage_b_late_fee_suspension')",
  );
  await assert.rejects(
    assert014RollbackBridgeSafe(database, { enable015RollbackBridge: false }),
    /dedicated forward migration/,
  );
  await client.query("DELETE FROM schema_migrations");
  await client.query("INSERT INTO schema_migrations(version) VALUES ('016_future_schema')");
  await assert.rejects(
    assert014RollbackBridgeSafe(database, { enable015RollbackBridge: true }),
    /do not run a down migration/,
  );

  await client.query("DELETE FROM schema_migrations");
  await client.query(
    "INSERT INTO schema_migrations(version) VALUES ('015_stage_b_saved_payment_auto_renew')",
  );
  await assert.rejects(
    assert014RollbackBridgeSafe(database, { enable015RollbackBridge: false }),
    /OSS_SCHEMA_ROLLBACK_BRIDGE=014-to-015/,
  );
  await assert.rejects(
    assert014RollbackBridgeSafe(database, { enable015RollbackBridge: true }),
    /incomplete or counterfeit/,
  );

  await client.query(`
    ALTER TABLE payment_methods
      ADD COLUMN saved_method_enabled boolean NOT NULL DEFAULT false,
      ADD COLUMN automatic_renewal_enabled boolean NOT NULL DEFAULT false;
    ALTER TABLE services
      ADD COLUMN automatic_renewal_consent_generation bigint NOT NULL DEFAULT 0,
      ADD COLUMN automatic_renewal_decision_generation bigint NOT NULL DEFAULT 0;
    ALTER TABLE payment_attempts
      ADD COLUMN save_payment_method_requested boolean NOT NULL DEFAULT false,
      ADD COLUMN save_consent_version text,
      ADD COLUMN automatic_renewal_requested boolean NOT NULL DEFAULT false,
      ADD COLUMN automatic_renewal_consent_version text,
      ADD COLUMN automatic_renewal_service_id uuid,
      ADD COLUMN automatic_renewal_decision_generation bigint,
      ADD COLUMN saved_payment_method_id uuid,
      ADD COLUMN automatic_renewal_authorization_id uuid,
      ADD COLUMN created_automatic_renewal_authorization_id uuid,
      ADD COLUMN automatic_attempt_number integer NOT NULL DEFAULT 0;
    CREATE TABLE payment_method_token_key_materials(
      material_fingerprint bytea PRIMARY KEY,
      key_kind text NOT NULL,
      key_version integer NOT NULL,
      registered_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE payment_method_token_encryption_keys(
      version integer PRIMARY KEY,
      key_fingerprint bytea NOT NULL,
      registered_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE payment_method_token_lookup_keys(
      version integer PRIMARY KEY,
      key_fingerprint bytea NOT NULL,
      registered_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE saved_payment_methods(id uuid PRIMARY KEY);
    CREATE TABLE automatic_renewal_authorizations(id uuid PRIMARY KEY);
    CREATE TABLE payment_consent_events(id uuid PRIMARY KEY);
    CREATE TABLE automatic_renewal_runs(
      id uuid PRIMARY KEY,
      status text NOT NULL,
      payment_attempt_id uuid NOT NULL
    );
  `);
  const empty015 = await assert014RollbackBridgeSafe(database, {
    enable015RollbackBridge: true,
  });
  assert.equal(empty015.mode, "rollback_bridge");

  const paymentAttemptId = "00000000-0000-4000-8000-000000000151";
  await client.query(`
    INSERT INTO users(id, email, password_hash, email_verified_at)
    VALUES (
      '00000000-0000-4000-8000-000000000156',
      'rollback-preflight@example.invalid', 'synthetic-not-a-password-hash', now()
    );
    INSERT INTO client_accounts(id, name, owner_user_id)
    VALUES (
      '00000000-0000-4000-8000-000000000157', 'Synthetic rollback account',
      '00000000-0000-4000-8000-000000000156'
    );
    INSERT INTO invoices(id, client_account_id, currency, total_minor, due_at)
    VALUES (
      '00000000-0000-4000-8000-000000000158',
      '00000000-0000-4000-8000-000000000157', 'USD', 100, now()
    );
    INSERT INTO orders(
      id, client_account_id, submitted_by_user_id, status, currency,
      price_snapshot, one_time_minor, setup_minor, recurring_minor, total_minor,
      idempotency_key, request_fingerprint
    ) VALUES (
      '00000000-0000-4000-8000-000000000159',
      '00000000-0000-4000-8000-000000000157',
      '00000000-0000-4000-8000-000000000156', 'accepted', 'USD', '{}'::jsonb,
      0, 0, 0, 0, 'rollback-preflight-order', 'rollback-preflight-order-fingerprint'
    );
    INSERT INTO order_items(
      id, order_id, product_id, product_name, fulfillment_mode,
      billing_cycle, configuration, price_snapshot
    ) VALUES (
      '00000000-0000-4000-8000-000000000160',
      '00000000-0000-4000-8000-000000000159', 'synthetic-product',
      'Synthetic product', 'automatic', 'monthly', '{}'::jsonb, '{}'::jsonb
    );
    INSERT INTO services(
      id, client_account_id, order_item_id, status, billing_cycle,
      automatic_renewal_decision_generation
    ) VALUES (
      '00000000-0000-4000-8000-000000000161',
      '00000000-0000-4000-8000-000000000157',
      '00000000-0000-4000-8000-000000000160', 'pending', 'monthly', 1
    );
    INSERT INTO payment_attempts(
      id, client_account_id, invoice_id, provider_installation_id, status,
      amount_minor, currency, scenario, idempotency_key, request_fingerprint,
      save_payment_method_requested, save_consent_version
    ) VALUES (
      '${paymentAttemptId}', '00000000-0000-4000-8000-000000000157',
      '00000000-0000-4000-8000-000000000158', 'rollback-preflight-mock', 'processing',
      100, 'USD', 'success', 'rollback-preflight-payment',
      'rollback-preflight-payment-fingerprint', true, 'rollback-preflight-consent-v1'
    );
    INSERT INTO saved_payment_methods(id)
    VALUES ('00000000-0000-4000-8000-000000000152');
    INSERT INTO automatic_renewal_authorizations(id)
    VALUES ('00000000-0000-4000-8000-000000000153');
    INSERT INTO payment_consent_events(id)
    VALUES ('00000000-0000-4000-8000-000000000154');
    INSERT INTO automatic_renewal_runs(id, status, payment_attempt_id)
    VALUES ('00000000-0000-4000-8000-000000000155', 'unknown', '${paymentAttemptId}');
    INSERT INTO provider_operations(
      provider_installation_id, kind, subject_type, subject_id, stable_key, status
    ) VALUES (
      'rollback-preflight-mock', 'payment_create', 'payment', '${paymentAttemptId}',
      'rollback-preflight-automatic-operation', 'unknown'
    );
    INSERT INTO durable_jobs(job_type, unique_key, payload, status)
    VALUES (
      'payment.reconcile', 'rollback-preflight-automatic-job',
      '{"automaticRenewalRunId":"00000000-0000-4000-8000-000000000155"}'::jsonb,
      'pending'
    );
    INSERT INTO provider_inbox(
      provider_installation_id, external_event_id, event_type, payload
    ) VALUES (
      'rollback-preflight-mock', 'rollback-preflight-event', 'payment.status',
      '{"savedPaymentMethod":{"providerToken":"[REDACTED]"}}'::jsonb
    );
    INSERT INTO outbox(event_type, unique_key, payload)
    VALUES (
      'automatic_renewal.test', 'rollback-preflight-outbox',
      '{"automaticRenewalRunId":"00000000-0000-4000-8000-000000000155"}'::jsonb
    );
  `);

  let blocked: unknown;
  try {
    await assert014RollbackBridgeSafe(database, { enable015RollbackBridge: true });
  } catch (caught) {
    blocked = caught;
  }
  assert.ok(blocked instanceof SchemaRollbackPreflightError);
  const blockerCodes = new Set(blocked.blockers.map(({ code }) => code));
  for (const code of [
    "saved_payment_methods",
    "saved_payment_attempts",
    "automatic_renewal_authorizations",
    "payment_consent_events",
    "automatic_renewal_runs",
    "automatic_renewal_service_generations",
    "automatic_provider_operations",
    "automatic_durable_jobs",
    "saved_payment_provider_inbox",
    "automatic_outbox",
  ]) {
    assert.ok(blockerCodes.has(code), `missing real PostgreSQL blocker ${code}`);
  }

  await client.query("ROLLBACK");
  process.stdout.write(
    `${JSON.stringify({
      missingRejected: true,
      schema013Rejected: true,
      schema014Accepted: true,
      schema015RequiresOptIn: true,
      incomplete015Rejected: true,
      empty015AcceptedByBridge: true,
      schema016Rejected: true,
      blockerCodes: [...blockerCodes].sort(),
      databaseMutationPersisted: false,
    })}\n`,
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
