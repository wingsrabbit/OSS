// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import {
  assert015RollbackBridgeSafe,
  SCHEMA_015_016_GUARD,
  SCHEMA_016,
} from "@opensales/core/schema-015-016-rollback-compatibility";
import {
  SCHEMA_015,
  SchemaRollbackPreflightError,
} from "@opensales/core/schema-rollback-compatibility";
import pg from "pg";
import {
  assertSchemaCompatible,
  holdSchema015RollbackBridgeGuard,
} from "./database.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for 015 rollback integration");

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 4,
  statement_timeout: 15_000,
  application_name: "opensales-schema-015-016-rollback-integration",
});
const client = await pool.connect();
const database = {
  query: async (text: string, values?: unknown[]) => client.query(text, values),
};

try {
  const installed = await client.query<{ version: string | null }>(
    "SELECT max(version) AS version FROM schema_migrations",
  );
  assert.equal(installed.rows[0]?.version, SCHEMA_015);
  const native = await assertSchemaCompatible(pool);
  assert.equal(native.mode, "native");

  const releaseGuard = await holdSchema015RollbackBridgeGuard(pool);
  const contender = new pg.Client({ connectionString: databaseUrl });
  await contender.connect();
  try {
    await contender.query("SET lock_timeout = '200ms'");
    await assert.rejects(
      contender.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
        SCHEMA_015_016_GUARD,
      ]),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "55P03",
    );
    await releaseGuard();
    await contender.query("SET lock_timeout = '2s'");
    await contender.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
      SCHEMA_015_016_GUARD,
    ]);
    await contender.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
      SCHEMA_015_016_GUARD,
    ]);
  } finally {
    await contender.end();
  }

  await client.query("BEGIN");
  await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [SCHEMA_016]);
  await assert.rejects(
    assert015RollbackBridgeSafe(database, { enable016RollbackBridge: false }),
    /OSS_SCHEMA_ROLLBACK_BRIDGE=015-to-016/,
  );
  await assert.rejects(
    assert015RollbackBridgeSafe(database, { enable016RollbackBridge: true }),
    /incomplete or counterfeit/,
  );

  await client.query(`
    ALTER TABLE fund_receipts
      ALTER COLUMN provider_installation_id DROP NOT NULL,
      ALTER COLUMN external_payment_id DROP NOT NULL,
      ADD COLUMN reported_manual_receipt_id uuid;
    ALTER TABLE fund_receipts
      DROP CONSTRAINT fund_receipts_exactly_one_attempt,
      DROP CONSTRAINT fund_receipts_disposition_check;

    CREATE TABLE manual_receipt_facts(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_account_id uuid NOT NULL REFERENCES client_accounts(id),
      reference text NOT NULL,
      received_at timestamptz NOT NULL,
      gross_amount_minor bigint NOT NULL CHECK (gross_amount_minor > 0),
      fee_minor bigint NOT NULL CHECK (fee_minor >= 0 AND fee_minor <= gross_amount_minor),
      currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      actor_id uuid NOT NULL REFERENCES users(id),
      reason text NOT NULL,
      idempotency_key text NOT NULL UNIQUE,
      request_fingerprint text NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(client_account_id, reference)
    );
    ALTER TABLE fund_receipts
      ADD CONSTRAINT fund_receipts_reported_manual_receipt_id_fkey
        FOREIGN KEY (reported_manual_receipt_id) REFERENCES manual_receipt_facts(id),
      ADD CONSTRAINT fund_receipts_exactly_one_source CHECK (
        num_nonnulls(
          reported_payment_attempt_id,
          reported_add_funds_attempt_id,
          reported_manual_receipt_id
        ) = 1
      ),
      ADD CONSTRAINT fund_receipts_source_provider_fields CHECK (
        (reported_manual_receipt_id IS NOT NULL
          AND provider_installation_id IS NULL
          AND external_payment_id IS NULL)
        OR
        (reported_manual_receipt_id IS NULL
          AND provider_installation_id IS NOT NULL
          AND external_payment_id IS NOT NULL)
      ),
      ADD CONSTRAINT fund_receipts_disposition_check CHECK (
        disposition IN (
          'received', 'allocated', 'partially_allocated', 'unclaimed',
          'charged_back', 'reversed'
        )
      );

    CREATE TABLE manual_receipt_reversals(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      manual_receipt_id uuid NOT NULL UNIQUE REFERENCES manual_receipt_facts(id),
      fund_receipt_id uuid NOT NULL UNIQUE REFERENCES fund_receipts(id),
      actor_id uuid NOT NULL REFERENCES users(id),
      reason text NOT NULL,
      idempotency_key text NOT NULL UNIQUE,
      request_fingerprint text NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE manual_receipt_outflows(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      manual_receipt_id uuid NOT NULL REFERENCES manual_receipt_facts(id),
      fund_receipt_id uuid NOT NULL REFERENCES fund_receipts(id),
      amount_minor bigint NOT NULL CHECK (amount_minor > 0),
      currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      destination_reference text NOT NULL,
      actor_id uuid NOT NULL REFERENCES users(id),
      reason text NOT NULL,
      idempotency_key text NOT NULL UNIQUE,
      request_fingerprint text NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE FUNCTION opensales_synthetic_manual_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
    CREATE TRIGGER manual_receipt_facts_append_only
      BEFORE UPDATE OR DELETE ON manual_receipt_facts
      FOR EACH ROW EXECUTE FUNCTION opensales_synthetic_manual_guard();
    CREATE CONSTRAINT TRIGGER manual_receipt_fact_completeness_guard
      AFTER INSERT ON manual_receipt_facts DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION opensales_synthetic_manual_guard();
    CREATE TRIGGER manual_receipt_reversals_append_only
      BEFORE UPDATE OR DELETE ON manual_receipt_reversals
      FOR EACH ROW EXECUTE FUNCTION opensales_synthetic_manual_guard();
    CREATE CONSTRAINT TRIGGER manual_receipt_reversal_completeness_guard
      AFTER INSERT ON manual_receipt_reversals DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION opensales_synthetic_manual_guard();
    CREATE TRIGGER manual_receipt_outflows_append_only
      BEFORE UPDATE OR DELETE ON manual_receipt_outflows
      FOR EACH ROW EXECUTE FUNCTION opensales_synthetic_manual_guard();
    CREATE CONSTRAINT TRIGGER manual_receipt_outflow_completeness_guard
      AFTER INSERT ON manual_receipt_outflows DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION opensales_synthetic_manual_guard();
    CREATE TRIGGER manual_receipt_provider_refund_guard
      BEFORE INSERT OR UPDATE ON refunds
      FOR EACH ROW EXECUTE FUNCTION opensales_synthetic_manual_guard();
    CREATE TRIGGER manual_receipt_resolution_guard
      BEFORE INSERT OR UPDATE ON fund_receipt_resolutions
      FOR EACH ROW EXECUTE FUNCTION opensales_synthetic_manual_guard();

    DROP VIEW unclaimed_fund_refund_capacity;
    CREATE VIEW unclaimed_fund_refund_capacity AS
    SELECT
      receipt.id AS fund_receipt_id,
      receipt.amount_minor,
      receipt.allocated_minor,
      0::bigint AS reserved_refund_minor,
      COALESCE(outflow.amount_minor, 0)::bigint AS confirmed_outflow_minor,
      (reversal.id IS NOT NULL) AS capacity_frozen,
      CASE WHEN reversal.id IS NOT NULL THEN 0
           ELSE GREATEST(0, receipt.amount_minor - receipt.allocated_minor
                            - COALESCE(outflow.amount_minor, 0))
      END::bigint AS available_minor
    FROM fund_receipts receipt
    LEFT JOIN manual_receipt_reversals reversal
      ON reversal.fund_receipt_id = receipt.id
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(item.amount_minor), 0)::bigint AS amount_minor
      FROM manual_receipt_outflows item
      WHERE item.fund_receipt_id = receipt.id
    ) outflow ON true;
  `);

  const empty016 = await assert015RollbackBridgeSafe(database, {
    enable016RollbackBridge: true,
  });
  assert.equal(empty016.mode, "rollback_bridge");

  await client.query("ALTER TABLE manual_receipt_facts DISABLE TRIGGER manual_receipt_facts_append_only");
  await assert.rejects(
    assert015RollbackBridgeSafe(database, { enable016RollbackBridge: true }),
    /incomplete or counterfeit/,
  );
  await client.query("ALTER TABLE manual_receipt_facts ENABLE TRIGGER manual_receipt_facts_append_only");

  await client.query("SAVEPOINT manual_facts");
  const userId = "00000000-0000-4000-8000-000000000261";
  const accountId = "00000000-0000-4000-8000-000000000262";
  const manualId = "00000000-0000-4000-8000-000000000263";
  const receiptId = "00000000-0000-4000-8000-000000000264";
  await client.query(
    `INSERT INTO users(id, email, password_hash, email_verified_at)
     VALUES ($1, 'schema-016-rollback@example.invalid', 'synthetic-not-a-password', now())`,
    [userId],
  );
  await client.query(
    "INSERT INTO client_accounts(id, name, owner_user_id) VALUES ($1, 'Synthetic manual receipt account', $2)",
    [accountId, userId],
  );
  await client.query(
    `INSERT INTO manual_receipt_facts(
       id, client_account_id, reference, received_at, gross_amount_minor, fee_minor,
       currency, actor_id, reason, idempotency_key, request_fingerprint, result
     ) VALUES ($1, $2, 'SYNTHETIC-RECEIPT-1', now(), 1000, 25, 'USD', $3,
               'Synthetic rollback blocker reason', 'synthetic-manual-receipt-key',
               'synthetic-manual-receipt-fingerprint', '{}'::jsonb)`,
    [manualId, accountId, userId],
  );
  await client.query(
    `INSERT INTO fund_receipts(
       id, provider_installation_id, external_payment_id,
       reported_payment_attempt_id, reported_add_funds_attempt_id,
       reported_manual_receipt_id, client_account_id, amount_minor,
       allocated_minor, currency, occurred_at, disposition, reason
     ) VALUES ($1, NULL, NULL, NULL, NULL, $2, $3, 1000, 0, 'USD', now(),
               'unclaimed', 'Synthetic manual receipt')`,
    [receiptId, manualId, accountId],
  );
  await client.query(
    `INSERT INTO manual_receipt_reversals(
       manual_receipt_id, fund_receipt_id, actor_id, reason,
       idempotency_key, request_fingerprint, result
     ) VALUES ($1, $2, $3, 'Synthetic reversal blocker',
               'synthetic-manual-reversal-key', 'synthetic-manual-reversal-fingerprint',
               '{}'::jsonb)`,
    [manualId, receiptId, userId],
  );
  await client.query(
    `INSERT INTO manual_receipt_outflows(
       manual_receipt_id, fund_receipt_id, amount_minor, currency,
       destination_reference, actor_id, reason, idempotency_key,
       request_fingerprint, result
     ) VALUES ($1, $2, 100, 'USD', 'SYNTHETIC-DESTINATION', $3,
               'Synthetic outflow blocker', 'synthetic-manual-outflow-key',
               'synthetic-manual-outflow-fingerprint', '{}'::jsonb)`,
    [manualId, receiptId, userId],
  );
  await client.query(
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES ('manual_receipt', $1, 'USD', 'Synthetic manual receipt journal')`,
    [manualId],
  );

  let blocked: unknown;
  try {
    await assert015RollbackBridgeSafe(database, { enable016RollbackBridge: true });
  } catch (error) {
    blocked = error;
  }
  assert.ok(blocked instanceof SchemaRollbackPreflightError);
  const blockerCodes = new Set(blocked.blockers.map(({ code }) => code));
  for (const code of [
    "manual_receipt_facts",
    "manual_receipt_reversals",
    "manual_receipt_outflows",
    "manual_fund_receipts",
    "manual_ledger_journals",
  ]) {
    assert.ok(blockerCodes.has(code), `missing PostgreSQL blocker ${code}`);
  }
  await client.query("ROLLBACK TO SAVEPOINT manual_facts");

  await client.query("ROLLBACK");
  process.stdout.write(
    `${JSON.stringify({
      schema015Native: true,
      schema016RequiresOptIn: true,
      incompleteSchema016Rejected: true,
      emptySchema016Accepted: true,
      disabledTriggerRejected: true,
      lifetimeGuardBlocksWriter: true,
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
