// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { providerOperationCapability } from "@opensales/core/provider-capability";
import pg from "pg";
import { assertSchemaCompatible, runMigrations } from "./database.js";
import { providerSignature } from "./provider-signature.js";

const coreUrl = process.env.CORE_TEST_URL ?? "http://127.0.0.1:3000";
const databaseUrl = process.env.DATABASE_URL;
const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
const providerDatabaseUrl = process.env.PROVIDER_DATABASE_URL;
const providerUrl = process.env.MOCK_PAYMENT_PROVIDER_URL;
const paymentProviderToken = process.env.MOCK_PAYMENT_PROVIDER_TOKEN;
const paymentWebhookSecret = process.env.MOCK_PAYMENT_WEBHOOK_SECRET;
const provisioningWebhookSecret = process.env.MOCK_PROVISIONING_WEBHOOK_SECRET;
const providerCapabilitySecret = process.env.PROVIDER_OPERATION_CAPABILITY_SECRET;
if (
  !databaseUrl ||
  !adminDatabaseUrl ||
  !providerDatabaseUrl ||
  !providerUrl ||
  !paymentProviderToken ||
  !paymentWebhookSecret ||
  !provisioningWebhookSecret ||
  !providerCapabilitySecret
) {
  throw new Error("Database and Mock Payment Provider test configuration are required");
}
const requiredAdminDatabaseUrl = adminDatabaseUrl;

async function verifyPublished007Upgrade(): Promise<void> {
  const databaseName = `oss_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: requiredAdminDatabaseUrl });
  const upgradeUrl = new URL(requiredAdminDatabaseUrl);
  upgradeUrl.pathname = `/${databaseName}`;
  let upgradePool: pg.Pool | null = null;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    upgradePool = new pg.Pool({ connectionString: upgradeUrl.toString(), max: 4 });
    await upgradePool.query(
      "CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
    const publishedMigrations = (await readdir(migrationsDirectory))
      .filter((file) => /^00[1-7]_[a-z0-9_]+\.sql$/.test(file))
      .sort();
    assert.equal(publishedMigrations.at(-1), "007_stage_b_manual_refunds.sql");
    for (const migrationFile of publishedMigrations) {
      const migration = await readFile(
        new URL(`../migrations/${migrationFile}`, import.meta.url),
        "utf8",
      );
      await upgradePool.query("BEGIN");
      try {
        await upgradePool.query(migration);
        await upgradePool.query("INSERT INTO schema_migrations(version) VALUES ($1)", [
          migrationFile.replace(/\.sql$/, ""),
        ]);
        await upgradePool.query("COMMIT");
      } catch (error) {
        await upgradePool.query("ROLLBACK");
        throw error;
      }
    }
    const oldSchema = await upgradePool.query<{
      version: string;
      manual_actions: string | null;
    }>(
      `SELECT
         max(version) AS version,
         to_regclass('public.refund_manual_actions')::text AS manual_actions
       FROM schema_migrations`,
    );
    assert.equal(oldSchema.rows[0]?.version, "007_stage_b_manual_refunds");
    assert.equal(oldSchema.rows[0]?.manual_actions, null);

    await Promise.all([runMigrations(upgradePool), runMigrations(upgradePool)]);
    await assertSchemaCompatible(upgradePool);
    const upgraded = await upgradePool.query<{
      version: string;
      manual_actions: string | null;
      corrections: string | null;
      old_discrepancy_unique: string | null;
    }>(
      `SELECT
         max(version) AS version,
         to_regclass('public.refund_manual_actions')::text AS manual_actions,
         to_regclass('public.refund_adjudication_corrections')::text AS corrections,
         (
           SELECT constraint_name
           FROM information_schema.table_constraints
           WHERE table_schema = 'public'
             AND table_name = 'refund_discrepancy_settlements'
             AND constraint_name = 'refund_discrepancy_settlements_refund_id_key'
         ) AS old_discrepancy_unique
       FROM schema_migrations`,
    );
    assert.equal(upgraded.rows[0]?.version, "008_stage_b_refund_reconciliation");
    assert.equal(upgraded.rows[0]?.manual_actions, "refund_manual_actions");
    assert.equal(upgraded.rows[0]?.corrections, "refund_adjudication_corrections");
    assert.equal(upgraded.rows[0]?.old_discrepancy_unique, null);
  } finally {
    await upgradePool?.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }
}

await verifyPublished007Upgrade();

const corePool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const providerPool = new pg.Pool({ connectionString: providerDatabaseUrl, max: 2 });
let cookie = "";

type Catalog = {
  products: Array<{
    id: string;
    fulfillmentMode: string;
    prices: Array<{ id: string; billingCycle: string }>;
  }>;
};
type Legal = {
  documents: {
    terms: { version: string };
    aup: { version: string };
  };
};
type OrderDetail = {
  order: { id: string; status: string };
  invoice: {
    id: string;
    status: string;
    totalMinor: string;
    dueMinor: string;
    paymentAllocatedMinor: string;
    creditAppliedMinor: string;
    paymentFeeMinor: string;
  };
  payment: { status: string | null };
  provisioning: { status: string | null };
  service: {
    id: string;
    status: string;
    activatedAt: string | null;
    termStart: string | null;
    termEnd: string | null;
  };
};
type ManualItem = {
  serviceId: string;
  orderId: string;
  productName: string;
};
type PaymentCommand = {
  commandId: string;
  paymentAttemptId: string | null;
  status: string;
  replayed: boolean;
};
type AddFundsQuote = {
  quoteId: string;
  principalMinor: string;
  feeMinor: string;
  externalDueMinor: string;
  balanceCapMinor: string;
};
type AddFundsCommand = {
  commandId: string;
  addFundsAttemptId: string;
  status: string;
  replayed?: boolean;
};
type AddFundsStatus = {
  commandId: string;
  addFundsAttemptId: string;
  providerOperationId: string;
  status: string;
  attemptStatus: string;
  providerOperationStatus: string;
  principalMinor: string;
  feeMinor: string;
  externalDueMinor: string;
  result: Record<string, unknown> | null;
};
type PaymentRecords = {
  command_status: string;
  attempt_status: string;
  operation_id: string;
  operation_status: string;
  job_status: string;
  amount_minor: string;
  currency: string;
};
type RefundCandidate = {
  receiptId: string;
  invoiceId: string;
  refundableMinor: string;
  referenceRefundMinor: string | null;
};
type RefundRecord = {
  refundId: string;
  invoiceId: string;
  receiptId: string;
  destination: "original_payment" | "credit" | "none";
  amountMinor: string;
  status: string;
  version: number;
  securityHold: boolean;
  securityHoldReason: string | null;
  providerOperationId: string | null;
  providerOperationStatus: string | null;
  externalRefundId: string | null;
  replayed: boolean;
};
type RefundSecurityHold = {
  holdId: string;
  receiptId: string;
  receiptAmountMinor: string;
  confirmedSettlementMinor: string;
  refundId: string;
  refundStatus: string;
  refundVersion: number;
  refundAmountMinor: string;
  refundCurrency: string;
  reason: string;
  providerFact: {
    factId: string;
    eventId: string;
    externalRefundId: string;
    status: "succeeded" | "failed";
    amountMinor: string;
    currency: string;
  };
  providerFacts: Array<{
    factId: string;
    eventId: string;
    externalRefundId: string;
    status: "succeeded" | "failed";
    amountMinor: string;
    currency: string;
  }>;
  discrepancy: { discrepancyId: string; amountMinor: string; currency: string } | null;
  allowedDecisions: Array<
    | "accept_authorized_outflow"
    | "record_unexpected_outflow"
    | "dismiss_provider_claim"
  >;
};
type RefundDismissalCorrection = {
  adjudicationId: string;
  holdId: string;
  refundId: string;
  refundVersion: number;
  providerFact: {
    factId: string;
    externalRefundId: string;
    amountMinor: string;
    currency: string;
  };
  discrepancyId: string | null;
};

async function request<T>(
  path: string,
  init: RequestInit = {},
  expectedStatus = 200,
): Promise<T> {
  const response = await fetch(new URL(path, coreUrl), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...init.headers,
    },
    redirect: "error",
  });
  if (response.status !== expectedStatus) {
    const responseBody = await response.text();
    assert.equal(
      response.status,
      expectedStatus,
      `${init.method ?? "GET"} ${path} expected ${expectedStatus}, received ${response.status}: ${responseBody}`,
    );
  }
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0] ?? "";
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function rawCoreRequest(
  path: string,
  init: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(new URL(path, coreUrl), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...init.headers,
    },
    redirect: "error",
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function submitPaymentFact(
  body: Record<string, unknown>,
  secret = paymentWebhookSecret!,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const paymentAttemptId = String(body.paymentAttemptId);
  const operationResult = await corePool.query<{ id: string }>(
    `SELECT id
     FROM provider_operations
     WHERE subject_type = 'payment' AND subject_id = $1
     ORDER BY created_at
     LIMIT 1`,
    [paymentAttemptId],
  );
  const providerOperationId =
    typeof body.providerOperationId === "string"
      ? body.providerOperationId
      : operationResult.rows[0]?.id;
  assert.ok(providerOperationId, "payment fact requires a Provider operation");
  const callbackCapability =
    typeof body.callbackCapability === "string"
      ? body.callbackCapability
      : providerOperationCapability(
          providerCapabilitySecret!,
          "mock-payment-v1",
          providerOperationId,
        );
  const signedBody = {
    eventId: body.eventId,
    providerOperationId,
    paymentAttemptId: body.paymentAttemptId,
    callbackCapability,
    externalPaymentId: body.externalPaymentId,
    status: body.status,
    amountMinor: body.amountMinor,
    currency: body.currency,
    occurredAt: body.occurredAt,
  };
  const timestamp = Date.now().toString();
  const signature = providerSignature(secret, timestamp, signedBody);
  return rawCoreRequest("/api/v1/provider-events/payment", {
    method: "POST",
    headers: {
      "X-OSS-Timestamp": timestamp,
      "X-OSS-Signature": signature,
    },
    body: JSON.stringify(signedBody),
  });
}

async function submitProvisionFact(
  body: Record<string, unknown>,
  secret = provisioningWebhookSecret!,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const providerOperationId = String(body.providerOperationId);
  const callbackCapability =
    typeof body.callbackCapability === "string"
      ? body.callbackCapability
      : providerOperationCapability(
          providerCapabilitySecret!,
          "mock-provisioning-v1",
          providerOperationId,
        );
  const signedBody = {
    eventId: body.eventId,
    providerOperationId,
    callbackCapability,
    status: body.status,
    ...(typeof body.externalResourceId === "string"
      ? { externalResourceId: body.externalResourceId }
      : {}),
    ...(typeof body.readyAt === "string" ? { readyAt: body.readyAt } : {}),
    occurredAt: body.occurredAt,
  };
  const timestamp = Date.now().toString();
  return rawCoreRequest("/api/v1/provider-events/provisioning", {
    method: "POST",
    headers: {
      "X-OSS-Timestamp": timestamp,
      "X-OSS-Signature": providerSignature(secret, timestamp, signedBody),
    },
    body: JSON.stringify(signedBody),
  });
}

async function submitRefundFact(
  body: Record<string, unknown>,
  secret = paymentWebhookSecret!,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const providerOperationId = String(body.providerOperationId);
  const callbackCapability =
    typeof body.callbackCapability === "string"
      ? body.callbackCapability
      : providerOperationCapability(
          providerCapabilitySecret!,
          "mock-payment-v1",
          providerOperationId,
        );
  const signedBody = {
    eventId: body.eventId,
    providerOperationId,
    refundId: body.refundId,
    callbackCapability,
    externalRefundId: body.externalRefundId,
    status: body.status,
    amountMinor: body.amountMinor,
    currency: body.currency,
    occurredAt: body.occurredAt,
  };
  const timestamp = Date.now().toString();
  return rawCoreRequest("/api/v1/provider-events/refund", {
    method: "POST",
    headers: {
      "X-OSS-Timestamp": timestamp,
      "X-OSS-Signature": providerSignature(secret, timestamp, signedBody),
    },
    body: JSON.stringify(signedBody),
  });
}

async function adjudicateRefundHold(
  hold: RefundSecurityHold,
  decision:
    | "accept_authorized_outflow"
    | "record_unexpected_outflow"
    | "dismiss_provider_claim",
  reason: string,
  idempotencyKey = randomUUID(),
  expectedStatus = 201,
): Promise<{
  adjudicationId: string;
  holdId: string;
  refundId: string;
  decision: string;
  replayed: boolean;
}> {
  return request(
    `/api/v1/admin/refund-security-holds/${hold.holdId}/adjudications`,
    {
      method: "POST",
      body: JSON.stringify({
        decision,
        reason,
        idempotencyKey,
        expectedRefundVersion: hold.refundVersion,
      }),
    },
    expectedStatus,
  );
}

async function waitFor<T>(
  description: string,
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 25_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest: T;
  do {
    latest = await read();
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 750));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(latest!)}`);
}

async function createOrder(priceId: string, legal: Legal): Promise<OrderDetail> {
  const created = await request<{ orderId: string }>(
    "/api/v1/orders",
    {
      method: "POST",
      body: JSON.stringify({
        priceId,
        configuration: {},
        termsVersion: legal.documents.terms.version,
        aupVersion: legal.documents.aup.version,
        idempotencyKey: randomUUID(),
      }),
    },
    201,
  );
  return request<OrderDetail>(`/api/v1/orders/${created.orderId}`);
}

async function createPaymentQuote(
  invoiceId: string,
  paymentMethod = "card",
  applyCredit = false,
): Promise<{
  quoteId: string;
  creditToApplyMinor: string;
  externalNonFeeMinor: string;
  feeMinor: string;
  externalDueMinor: string;
}> {
  return request(
    `/api/v1/invoices/${invoiceId}/payment-quotes`,
    {
      method: "POST",
      body: JSON.stringify({ paymentMethod, applyCredit }),
    },
    201,
  );
}

async function readPaymentRecords(commandId: string): Promise<PaymentRecords> {
  const result = await corePool.query<PaymentRecords>(
    `SELECT
       command.status AS command_status,
       attempt.status AS attempt_status,
       operation.id AS operation_id,
       operation.status AS operation_status,
       job.status AS job_status,
       attempt.amount_minor::text,
       attempt.currency
     FROM invoice_payment_commands command
     JOIN payment_attempts attempt ON attempt.id = command.payment_attempt_id
     JOIN provider_operations operation
       ON operation.subject_type = 'payment'
      AND operation.subject_id = attempt.id
     JOIN durable_jobs job
       ON job.job_type = 'payment.start'
      AND job.payload->>'paymentAttemptId' = attempt.id::text
     WHERE command.id = $1`,
    [commandId],
  );
  const row = result.rows[0];
  assert.ok(row, `payment command ${commandId} must have complete operation records`);
  return row;
}

async function installPaymentStartDelay(): Promise<void> {
  await corePool.query(`
    DROP TRIGGER IF EXISTS integration_delay_security_payment_start ON durable_jobs;
    CREATE OR REPLACE FUNCTION integration_delay_security_payment_start()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.job_type = 'payment.start' THEN
        NEW.available_at = now() + interval '1 hour';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER integration_delay_security_payment_start
    BEFORE INSERT ON durable_jobs
    FOR EACH ROW EXECUTE FUNCTION integration_delay_security_payment_start();
  `);
}

async function dropPaymentStartDelay(): Promise<void> {
  await corePool.query(`
    DROP TRIGGER IF EXISTS integration_delay_security_payment_start ON durable_jobs;
    DROP FUNCTION IF EXISTS integration_delay_security_payment_start();
  `);
}

async function installRefundStartDelay(): Promise<void> {
  await corePool.query(`
    DROP TRIGGER IF EXISTS integration_delay_refund_start ON durable_jobs;
    CREATE OR REPLACE FUNCTION integration_delay_refund_start()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.job_type = 'refund.start' THEN
        NEW.available_at = now() + interval '1 hour';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER integration_delay_refund_start
    BEFORE INSERT ON durable_jobs
    FOR EACH ROW EXECUTE FUNCTION integration_delay_refund_start();
  `);
}

async function dropRefundStartDelay(): Promise<void> {
  await corePool.query(`
    DROP TRIGGER IF EXISTS integration_delay_refund_start ON durable_jobs;
    DROP FUNCTION IF EXISTS integration_delay_refund_start();
  `);
}

const providerInboxReceiptLockGate = "integration:provider-inbox-receipt-lock-order";

async function installProviderInboxReceiptLockGate(): Promise<void> {
  await corePool.query(`
    DROP TRIGGER IF EXISTS integration_gate_provider_inbox_receipt_lock ON provider_inbox;
    CREATE OR REPLACE FUNCTION integration_gate_provider_inbox_receipt_lock()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.external_event_id LIKE 'lock-order:%' THEN
        PERFORM pg_advisory_xact_lock(
          hashtextextended('integration:provider-inbox-receipt-lock-order', 0)
        );
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER integration_gate_provider_inbox_receipt_lock
    BEFORE INSERT ON provider_inbox
    FOR EACH ROW EXECUTE FUNCTION integration_gate_provider_inbox_receipt_lock();
  `);
}

async function dropProviderInboxReceiptLockGate(): Promise<void> {
  await corePool.query(`
    DROP TRIGGER IF EXISTS integration_gate_provider_inbox_receipt_lock ON provider_inbox;
    DROP FUNCTION IF EXISTS integration_gate_provider_inbox_receipt_lock();
  `);
}

const providerInboxAccountLockGate = "integration:provider-inbox-account-lock-order";

async function installProviderInboxAccountLockGate(): Promise<void> {
  await corePool.query(`
    DROP TRIGGER IF EXISTS integration_gate_provider_inbox_account_lock ON provider_inbox;
    CREATE OR REPLACE FUNCTION integration_gate_provider_inbox_account_lock()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.external_event_id LIKE 'account-lock-order:%' THEN
        PERFORM pg_advisory_xact_lock(
          hashtextextended('integration:provider-inbox-account-lock-order', 0)
        );
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER integration_gate_provider_inbox_account_lock
    BEFORE INSERT ON provider_inbox
    FOR EACH ROW EXECUTE FUNCTION integration_gate_provider_inbox_account_lock();
  `);
}

async function dropProviderInboxAccountLockGate(): Promise<void> {
  await corePool.query(`
    DROP TRIGGER IF EXISTS integration_gate_provider_inbox_account_lock ON provider_inbox;
    DROP FUNCTION IF EXISTS integration_gate_provider_inbox_account_lock();
  `);
}

async function releasePaymentStart(paymentAttemptId: string): Promise<void> {
  await corePool.query(
    `UPDATE durable_jobs
     SET available_at = now(), status = 'pending', locked_at = NULL, locked_by = NULL
     WHERE job_type = 'payment.start'
       AND payload->>'paymentAttemptId' = $1`,
    [paymentAttemptId],
  );
}

async function pay(
  order: OrderDetail,
  scenario: "success" | "failed" | "timeout_success" | "duplicate_out_of_order",
): Promise<OrderDetail> {
  const quote = await createPaymentQuote(order.invoice.id);
  await request(
    `/api/v1/invoices/${order.invoice.id}/payments`,
    {
      method: "POST",
      body: JSON.stringify({ quoteId: quote.quoteId, scenario, idempotencyKey: randomUUID() }),
    },
    202,
  );
  return waitFor(
    `payment scenario ${scenario}`,
    () => request<OrderDetail>(`/api/v1/orders/${order.order.id}`),
    (current) =>
      scenario === "failed"
        ? current.payment.status === "failed"
        : current.invoice.status === "paid",
  );
}

async function createAddFundsQuote(
  principalMinor: string,
  paymentMethod = "card",
): Promise<AddFundsQuote> {
  return request<AddFundsQuote>(
    "/api/v1/billing/add-funds/quotes",
    {
      method: "POST",
      body: JSON.stringify({ principalMinor, paymentMethod }),
    },
    201,
  );
}

async function startAddFunds(
  quoteId: string,
  scenario:
    | "success"
    | "failed"
    | "cancelled"
    | "timeout_success"
    | "duplicate_out_of_order"
    | "partial_then_reject"
    | "partial_then_timeout"
    | "partial"
    | "wrong_currency"
    | "expired_late"
    | "late_success",
  idempotencyKey = randomUUID(),
): Promise<{ command: AddFundsCommand; idempotencyKey: string }> {
  const command = await request<AddFundsCommand>(
    "/api/v1/billing/add-funds",
    {
      method: "POST",
      body: JSON.stringify({ quoteId, scenario, idempotencyKey }),
    },
    202,
  );
  return { command, idempotencyKey };
}

async function waitForAddFunds(
  commandId: string,
  expectedStatus: "succeeded" | "failed" | "cancelled" | "expired" | "manual",
): Promise<AddFundsStatus> {
  return waitFor(
    `Add Funds command ${commandId} to become ${expectedStatus}`,
    () => request<AddFundsStatus>(`/api/v1/billing/add-funds/${commandId}`),
    (value) => value.status === expectedStatus,
    30_000,
  );
}

await waitFor(
  "Core readiness",
  async () => {
    const response = await fetch(new URL("/health/ready", coreUrl));
    return response.status;
  },
  (status) => status === 200,
);

const catalog = await request<Catalog>("/api/v1/catalog");
const legal = await request<Legal>("/api/v1/legal/current");
const automaticPrice = catalog.products
  .find((product) => product.id === "hkbgp-vps")
  ?.prices.find((price) => price.billingCycle === "monthly");
const manualPrice = catalog.products
  .find((product) => product.id === "hk-r640-hkbgp")
  ?.prices.find((price) => price.billingCycle === "monthly");
assert.ok(automaticPrice, "automatic laboratory product is missing");
assert.ok(manualPrice, "manual laboratory product is missing");
assert.equal(
  catalog.products.some((product) => product.id === "remote-hands"),
  false,
  "Remote Hands must remain hidden until Colocation and authenticated ticket prerequisites exist",
);

const email = "stage-a-browser-admin@example.invalid";
const password = "Synthetic-Stage-A-Browser-Admin-Only!";
await request(
  "/api/v1/auth/register",
  {
    method: "POST",
    body: JSON.stringify({
      email,
      password,
      clientName: "Synthetic Stage A Client",
      locale: "en",
    }),
  },
  201,
);
await request(
  "/api/v1/auth/login",
  { method: "POST", body: JSON.stringify({ email, password }) },
  200,
);
const meBefore = await request<{ eligible: boolean; verification: { email: string } }>(
  "/api/v1/auth/me",
);
assert.equal(meBefore.eligible, false);
assert.equal(meBefore.verification.email, "pending");
const unverifiedBillingSummary = await rawCoreRequest("/api/v1/billing/summary", {
  method: "GET",
});
assert.equal(unverifiedBillingSummary.status, 403);
assert.equal(unverifiedBillingSummary.body.code, "EMAIL_VERIFICATION_REQUIRED");
const unverifiedAddFunds = await rawCoreRequest("/api/v1/billing/add-funds/quotes", {
  method: "POST",
  body: JSON.stringify({ principalMinor: "5000", paymentMethod: "card" }),
});
assert.equal(unverifiedAddFunds.status, 403);
const unverifiedAddFundsFacts = await corePool.query<{ count: string }>(
  `SELECT (
     (SELECT count(*) FROM add_funds_quotes) +
     (SELECT count(*) FROM add_funds_attempts) +
     (SELECT count(*) FROM add_funds_commands)
   )::text AS count`,
);
assert.equal(unverifiedAddFundsFacts.rows[0]?.count, "0");

await request(
  "/api/v1/orders",
  {
    method: "POST",
    body: JSON.stringify({
      priceId: automaticPrice.id,
      configuration: {},
      termsVersion: legal.documents.terms.version,
      aupVersion: legal.documents.aup.version,
      idempotencyKey: randomUUID(),
    }),
  },
  403,
);

const mailbox = await waitFor(
  "Mock Mail verification delivery",
  () => request<{ messages: Array<{ body: string; status: string }> }>("/api/v1/lab/mailbox"),
  (value) => value.messages.length > 0,
);
const verificationUrl = mailbox.messages[0]?.body.match(/https?:\/\/\S+/)?.[0];
assert.ok(verificationUrl, "verification URL was not delivered");
const verificationToken = new URL(verificationUrl).searchParams.get("token");
assert.ok(verificationToken);
await request(
  "/api/v1/auth/verify-email",
  { method: "POST", body: JSON.stringify({ token: verificationToken }) },
  200,
);
const repeatedVerification = await request<{ status: string }>(
  "/api/v1/auth/verify-email",
  { method: "POST", body: JSON.stringify({ token: verificationToken }) },
  200,
);
assert.equal(repeatedVerification.status, "already_verified");
assert.equal((await request<{ eligible: boolean }>("/api/v1/auth/me")).eligible, true);

const concurrentOrderKey = randomUUID();
const concurrentOrderBody = {
  priceId: automaticPrice.id,
  configuration: {},
  termsVersion: legal.documents.terms.version,
  aupVersion: legal.documents.aup.version,
  idempotencyKey: concurrentOrderKey,
};
const concurrentOrders = await Promise.all([
  rawCoreRequest("/api/v1/orders", {
    method: "POST",
    body: JSON.stringify(concurrentOrderBody),
  }),
  rawCoreRequest("/api/v1/orders", {
    method: "POST",
    body: JSON.stringify(concurrentOrderBody),
  }),
]);
assert.deepEqual(
  concurrentOrders.map((response) => response.status).sort(),
  [200, 201],
);
assert.equal(concurrentOrders[0]?.body.orderId, concurrentOrders[1]?.body.orderId);
const conflictingOrder = await rawCoreRequest("/api/v1/orders", {
  method: "POST",
  body: JSON.stringify({ ...concurrentOrderBody, configuration: { unexpected: true } }),
});
assert.equal(conflictingOrder.status, 409);
assert.equal(conflictingOrder.body.code, "IDEMPOTENCY_CONFLICT");
const concurrentOrderCount = await corePool.query<{ count: string }>(
  "SELECT count(*)::text AS count FROM orders WHERE idempotency_key = $1",
  [concurrentOrderKey],
);
assert.equal(concurrentOrderCount.rows[0]?.count, "1");

const automaticOrder = await createOrder(automaticPrice.id, legal);
assert.equal(automaticOrder.order.status, "waiting_payment");
assert.equal(automaticOrder.service.status, "pending");
const paidAutomatic = await pay(automaticOrder, "success");
const activeAutomatic = await waitFor(
  "automatic service activation after timeout reconciliation",
  () => request<OrderDetail>(`/api/v1/orders/${paidAutomatic.order.id}`),
  (value) => value.service.status === "active",
);
assert.equal(activeAutomatic.order.status, "completed");
assert.equal(activeAutomatic.invoice.status, "paid");
assert.equal(activeAutomatic.invoice.dueMinor, "0");
assert.equal(activeAutomatic.service.activatedAt, activeAutomatic.service.termStart);
assert.ok(activeAutomatic.service.termEnd);

const automaticInvariant = await corePool.query<{
  allocations: string;
  provision_operations: string;
  debit_minor: string;
  credit_minor: string;
  provider_operation_id: string;
}>(
  `SELECT
     (SELECT count(*)::text FROM payment_allocations pa WHERE pa.invoice_id = i.id) AS allocations,
     (SELECT count(*)::text FROM provider_operations po WHERE po.subject_type = 'service' AND po.subject_id = s.id) AS provision_operations,
     (SELECT COALESCE(sum(ll.debit_minor), 0)::text
        FROM ledger_lines ll
        JOIN ledger_journals lj ON lj.id = ll.journal_id
        JOIN fund_receipts fr ON fr.id = lj.source_id
        JOIN payment_attempts pay ON pay.id = fr.reported_payment_attempt_id
       WHERE lj.source_type = 'fund_receipt' AND pay.invoice_id = i.id) AS debit_minor,
     (SELECT COALESCE(sum(ll.credit_minor), 0)::text
        FROM ledger_lines ll
        JOIN ledger_journals lj ON lj.id = ll.journal_id
        JOIN fund_receipts fr ON fr.id = lj.source_id
        JOIN payment_attempts pay ON pay.id = fr.reported_payment_attempt_id
       WHERE lj.source_type = 'fund_receipt' AND pay.invoice_id = i.id) AS credit_minor,
     (SELECT po.id::text FROM provider_operations po
       WHERE po.subject_type = 'service' AND po.subject_id = s.id LIMIT 1) AS provider_operation_id
   FROM invoices i
   JOIN orders o ON o.id = i.order_id
   JOIN order_items oi ON oi.order_id = o.id
   JOIN services s ON s.order_item_id = oi.id
   WHERE o.id = $1`,
  [activeAutomatic.order.id],
);
assert.equal(automaticInvariant.rows[0]?.allocations, "1");
assert.equal(automaticInvariant.rows[0]?.provision_operations, "1");
assert.equal(automaticInvariant.rows[0]?.debit_minor, automaticInvariant.rows[0]?.credit_minor);
const providerCreateCount = await providerPool.query<{ create_calls: number }>(
  "SELECT create_calls FROM mock_resource_operations WHERE operation_id = $1",
  [automaticInvariant.rows[0]?.provider_operation_id],
);
assert.equal(providerCreateCount.rows[0]?.create_calls, 1);

const failedOrder = await createOrder(automaticPrice.id, legal);
const failed = await pay(failedOrder, "failed");
assert.equal(failed.invoice.status, "open");
assert.equal(failed.service.status, "pending");
const failedAttempt = await corePool.query<{
  id: string;
  external_payment_id: string;
  amount_minor: string;
  currency: string;
}>(
  `SELECT id, external_payment_id, amount_minor, currency
   FROM payment_attempts
   WHERE invoice_id = $1`,
  [failed.invoice.id],
);
const failedAttemptRow = failedAttempt.rows[0];
assert.ok(failedAttemptRow?.external_payment_id);
const lateSettlement = await submitPaymentFact({
  eventId: `late-success:${randomUUID()}`,
  paymentAttemptId: failedAttemptRow.id,
  externalPaymentId: failedAttemptRow.external_payment_id,
  status: "succeeded",
  amountMinor: failedAttemptRow.amount_minor,
  currency: failedAttemptRow.currency,
  occurredAt: new Date().toISOString(),
});
assert.equal(lateSettlement.status, 202);
assert.equal(lateSettlement.body.status, "unclaimed");
const lateSettlementInvariant = await corePool.query<{
  disposition: string;
  allocations: string;
  debit_minor: string;
  credit_minor: string;
}>(
  `SELECT
     fr.disposition,
     (SELECT count(*)::text
        FROM payment_allocations pa
       WHERE pa.payment_attempt_id = fr.reported_payment_attempt_id) AS allocations,
     (SELECT COALESCE(sum(ll.debit_minor), 0)::text
        FROM ledger_lines ll
        JOIN ledger_journals lj ON lj.id = ll.journal_id
       WHERE lj.source_type = 'fund_receipt' AND lj.source_id = fr.id) AS debit_minor,
     (SELECT COALESCE(sum(ll.credit_minor), 0)::text
        FROM ledger_lines ll
        JOIN ledger_journals lj ON lj.id = ll.journal_id
       WHERE lj.source_type = 'fund_receipt' AND lj.source_id = fr.id) AS credit_minor
   FROM fund_receipts fr
   WHERE fr.external_payment_id = $1`,
  [failedAttemptRow.external_payment_id],
);
assert.equal(lateSettlementInvariant.rows[0]?.disposition, "unclaimed");
assert.equal(lateSettlementInvariant.rows[0]?.allocations, "0");
assert.equal(
  lateSettlementInvariant.rows[0]?.debit_minor,
  lateSettlementInvariant.rows[0]?.credit_minor,
);
assert.equal(
  (await request<OrderDetail>(`/api/v1/orders/${failed.order.id}`)).invoice.status,
  "open",
);

const paymentConflictOrderA = await createOrder(automaticPrice.id, legal);
const paymentConflictOrderB = await createOrder(automaticPrice.id, legal);
const paymentConflictKey = randomUUID();
const paymentConflictQuoteA = await createPaymentQuote(paymentConflictOrderA.invoice.id);
await request(
  `/api/v1/invoices/${paymentConflictOrderA.invoice.id}/payments`,
  {
    method: "POST",
    body: JSON.stringify({
      quoteId: paymentConflictQuoteA.quoteId,
      scenario: "failed",
      idempotencyKey: paymentConflictKey,
    }),
  },
  202,
);
await waitFor(
  "first payment idempotency subject to become terminal",
  () => request<OrderDetail>(`/api/v1/orders/${paymentConflictOrderA.order.id}`),
  (current) => current.payment.status === "failed",
);
const crossInvoiceReplay = await rawCoreRequest(
  `/api/v1/invoices/${paymentConflictOrderB.invoice.id}/payments`,
  {
    method: "POST",
    body: JSON.stringify({
      quoteId: (await createPaymentQuote(paymentConflictOrderB.invoice.id)).quoteId,
      scenario: "failed",
      idempotencyKey: paymentConflictKey,
    }),
  },
);
assert.equal(crossInvoiceReplay.status, 409);
assert.equal(crossInvoiceReplay.body.code, "IDEMPOTENCY_CONFLICT");

const duplicateOrder = await createOrder(automaticPrice.id, legal);
await pay(duplicateOrder, "duplicate_out_of_order");
const activeDuplicate = await waitFor(
  "duplicate/out-of-order service activation",
  () => request<OrderDetail>(`/api/v1/orders/${duplicateOrder.order.id}`),
  (value) => value.service.status === "active",
);
const duplicateCounts = await corePool.query<{ allocations: string; journals: string }>(
  `SELECT
     count(DISTINCT pa.id)::text AS allocations,
     count(DISTINCT lj.id)::text AS journals
   FROM invoices i
   JOIN payment_attempts pay ON pay.invoice_id = i.id
   LEFT JOIN payment_allocations pa ON pa.payment_attempt_id = pay.id
   LEFT JOIN fund_receipts fr ON fr.reported_payment_attempt_id = pay.id
   LEFT JOIN ledger_journals lj ON lj.source_type = 'fund_receipt' AND lj.source_id = fr.id
   WHERE i.order_id = $1`,
  [activeDuplicate.order.id],
);
assert.equal(duplicateCounts.rows[0]?.allocations, "1");
assert.equal(duplicateCounts.rows[0]?.journals, "1");
const settledAttempt = await corePool.query<{
  id: string;
  external_payment_id: string;
  amount_minor: string;
  currency: string;
}>(
  `SELECT id, external_payment_id, amount_minor, currency
   FROM payment_attempts
   WHERE invoice_id = $1`,
  [activeDuplicate.invoice.id],
);
const settledAttemptRow = settledAttempt.rows[0];
assert.ok(settledAttemptRow?.external_payment_id);
const semanticDuplicate = await submitPaymentFact({
  eventId: `semantic-duplicate:${randomUUID()}`,
  paymentAttemptId: settledAttemptRow.id,
  externalPaymentId: settledAttemptRow.external_payment_id,
  status: "succeeded",
  amountMinor: settledAttemptRow.amount_minor,
  currency: settledAttemptRow.currency,
  occurredAt: new Date().toISOString(),
});
assert.equal(semanticDuplicate.status, 200);
assert.equal(
  (await request<OrderDetail>(`/api/v1/orders/${activeDuplicate.order.id}`)).order.status,
  "completed",
);

const timeoutOrder = await createOrder(automaticPrice.id, legal);
await pay(timeoutOrder, "timeout_success");
const activeTimeout = await waitFor(
  "timeout-but-settled payment and service",
  () => request<OrderDetail>(`/api/v1/orders/${timeoutOrder.order.id}`),
  (value) => value.service.status === "active",
);
assert.equal(activeTimeout.invoice.status, "paid");

const crossCapability = await fetch(new URL("/v1/resources", providerUrl), {
  method: "POST",
  headers: {
    Authorization: `Bearer ${paymentProviderToken}`,
    "Content-Type": "application/json",
    "Idempotency-Key": randomUUID(),
  },
  body: JSON.stringify({
    operationId: randomUUID(),
    serviceId: randomUUID(),
    scenario: "success",
  }),
  redirect: "error",
});
assert.equal(crossCapability.status, 401, "payment credential must not authorize provisioning");
const wrongCapabilityFact = {
  eventId: `wrong-capability:${randomUUID()}`,
  providerOperationId: randomUUID(),
  callbackCapability: "A".repeat(43),
  status: "failed",
  occurredAt: new Date().toISOString(),
};
const wrongTimestamp = Date.now().toString();
const wrongSignature = createHmac("sha256", paymentWebhookSecret)
  .update(`${wrongTimestamp}.${JSON.stringify(wrongCapabilityFact)}`, "utf8")
  .digest("hex");
const wrongCapabilityCallback = await rawCoreRequest(
  "/api/v1/provider-events/provisioning",
  {
    method: "POST",
    headers: {
      "X-OSS-Timestamp": wrongTimestamp,
      "X-OSS-Signature": wrongSignature,
    },
    body: JSON.stringify(wrongCapabilityFact),
  },
);
assert.equal(
  wrongCapabilityCallback.status,
  401,
  "payment signing secret must not authorize provisioning facts",
);

await corePool.query(`
  CREATE OR REPLACE FUNCTION integration_delay_provision_start()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.job_type = 'provision.start' THEN
      NEW.available_at = now() + interval '1 hour';
    END IF;
    RETURN NEW;
  END;
  $$;
  CREATE TRIGGER integration_delay_provision_start
  BEFORE INSERT ON durable_jobs
  FOR EACH ROW EXECUTE FUNCTION integration_delay_provision_start();
`);

const forgedProvisionOrder = await createOrder(automaticPrice.id, legal);
const paidForgedProvision = await pay(forgedProvisionOrder, "success");
const forgedProvisionRecord = await corePool.query<{
  job_id: string;
  operation_id: string;
}>(
  `SELECT job.id AS job_id, operation.id AS operation_id
   FROM durable_jobs job
   JOIN provider_operations operation
     ON operation.subject_type = 'service'
    AND operation.subject_id::text = $1
   WHERE job.job_type = 'provision.start'
     AND job.payload->>'serviceId' = $1`,
  [paidForgedProvision.service.id],
);
const forgedProvisionPointer = forgedProvisionRecord.rows[0];
assert.ok(forgedProvisionPointer);
const forgedProvisionEvent = {
  eventId: `pre-outbound-resource:${randomUUID()}`,
  providerOperationId: forgedProvisionPointer.operation_id,
  status: "succeeded",
  externalResourceId: `mock-forged-resource-${randomUUID()}`,
  readyAt: new Date().toISOString(),
  occurredAt: new Date().toISOString(),
};
const invalidDirectProvision = await submitProvisionFact({
  ...forgedProvisionEvent,
  callbackCapability: "A".repeat(43),
});
assert.equal(invalidDirectProvision.status, 202);
assert.equal(invalidDirectProvision.body.rejected, true);
assert.equal(invalidDirectProvision.body.reason, "invalid_operation_capability");
const unstartedDirectProvision = await submitProvisionFact(forgedProvisionEvent);
assert.equal(unstartedDirectProvision.status, 202);
assert.equal(unstartedDirectProvision.body.rejected, true);
assert.equal(unstartedDirectProvision.body.reason, "provider_operation_not_started");
const unstartedProvisionState = await corePool.query<{
  service_status: string;
  operation_status: string;
  attempt_count: number;
}>(
  `SELECT
     service.status AS service_status,
     operation.status AS operation_status,
     operation.attempt_count
   FROM services service
   JOIN provider_operations operation ON operation.id = $2
   WHERE service.id = $1`,
  [paidForgedProvision.service.id, forgedProvisionPointer.operation_id],
);
assert.equal(unstartedProvisionState.rows[0]?.service_status, "pending");
assert.equal(unstartedProvisionState.rows[0]?.operation_status, "queued");
assert.equal(unstartedProvisionState.rows[0]?.attempt_count, 0);
const unstartedProviderOperations = await providerPool.query<{ count: string }>(
  "SELECT count(*)::text AS count FROM mock_resource_operations WHERE operation_id = $1",
  [forgedProvisionPointer.operation_id],
);
assert.equal(unstartedProviderOperations.rows[0]?.count, "0");

await corePool.query(
  `UPDATE durable_jobs
   SET status = 'completed', locked_at = NULL, locked_by = NULL
   WHERE id = $1`,
  [forgedProvisionPointer.job_id],
);
await corePool.query(
  `UPDATE services
   SET status = 'provisioning'
   WHERE id = $1`,
  [paidForgedProvision.service.id],
);
await corePool.query(
  `UPDATE orders
   SET status = 'fulfilling'
   WHERE id = $1`,
  [paidForgedProvision.order.id],
);
await corePool.query(
  `UPDATE provider_operations
   SET status = 'running', attempt_count = 1
   WHERE id = $1`,
  [forgedProvisionPointer.operation_id],
);
await providerPool.query(
  `INSERT INTO mock_resource_operations(
     operation_id, service_id, external_resource_id, callback_capability,
     scenario, status, ready_at, create_calls, request_fingerprint
   ) VALUES ($1, $2, $3, $4, 'success', 'succeeded', now(), 0, $5)`,
  [
    forgedProvisionPointer.operation_id,
    paidForgedProvision.service.id,
    forgedProvisionEvent.externalResourceId,
    "A".repeat(43),
    createHash("sha256").update(randomUUID()).digest("hex"),
  ],
);
const forgedProvisionReconcileKey = `forged-provision:${paidForgedProvision.service.id}`;
await corePool.query(
  `INSERT INTO durable_jobs(job_type, unique_key, payload)
   VALUES ('provision.reconcile', $1, $2)`,
  [
    forgedProvisionReconcileKey,
    {
      serviceId: paidForgedProvision.service.id,
      operationId: forgedProvisionPointer.operation_id,
    },
  ],
);
const forgedProvisionClosed = await waitFor(
  "resource reconciliation without the outbound capability to enter manual Hold",
  async () => {
    const result = await corePool.query<{
      order_status: string;
      service_status: string;
      operation_status: string;
      job_status: string;
      external_resource_id: string | null;
      activated_at: Date | null;
      term_start: Date | null;
      term_end: Date | null;
      activation_events: string;
    }>(
      `SELECT
         customer_order.status AS order_status,
         service.status AS service_status,
         operation.status AS operation_status,
         job.status AS job_status,
         service.external_resource_id,
         service.activated_at,
         service.term_start,
         service.term_end,
         (SELECT count(*)::text
            FROM outbox
           WHERE event_type = 'service.activated'
             AND payload->>'serviceId' = service.id::text) AS activation_events
       FROM services service
       JOIN order_items item ON item.id = service.order_item_id
       JOIN orders customer_order ON customer_order.id = item.order_id
       JOIN provider_operations operation ON operation.id = $2
       JOIN durable_jobs job ON job.unique_key = $3
       WHERE service.id = $1`,
      [
        paidForgedProvision.service.id,
        forgedProvisionPointer.operation_id,
        forgedProvisionReconcileKey,
      ],
    );
    return result.rows[0];
  },
  (value) =>
    value?.order_status === "on_hold" &&
    value.service_status === "confirming" &&
    value.operation_status === "unknown" &&
    value.job_status === "manual",
  8_000,
);
assert.equal(forgedProvisionClosed?.external_resource_id, null);
assert.equal(forgedProvisionClosed?.activated_at, null);
assert.equal(forgedProvisionClosed?.term_start, null);
assert.equal(forgedProvisionClosed?.term_end, null);
assert.equal(forgedProvisionClosed?.activation_events, "0");
const forgedProvisionProviderState = await providerPool.query<{ create_calls: number }>(
  "SELECT create_calls FROM mock_resource_operations WHERE operation_id = $1",
  [forgedProvisionPointer.operation_id],
);
assert.equal(forgedProvisionProviderState.rows[0]?.create_calls, 0);

const restrictedBeforeProvision = await createOrder(automaticPrice.id, legal);
const paidBeforeRestriction = await pay(restrictedBeforeProvision, "success");
const heldProvisionOperation = await corePool.query<{ id: string }>(
  `SELECT po.id
   FROM provider_operations po
   WHERE po.subject_type = 'service'
     AND po.subject_id = $1`,
  [paidBeforeRestriction.service.id],
);
assert.ok(heldProvisionOperation.rows[0]?.id);
await corePool.query("UPDATE users SET restricted_at = now() WHERE email = $1", [email]);
await corePool.query(`
  DROP TRIGGER integration_delay_provision_start ON durable_jobs;
  DROP FUNCTION integration_delay_provision_start();
`);
await corePool.query(
  `UPDATE durable_jobs
  SET available_at = now()
  WHERE job_type = 'provision.start'
    AND payload->>'serviceId' = $1`,
  [paidBeforeRestriction.service.id],
);
const heldForRestriction = await waitFor(
  "restriction before provisioning to prevent the provider create",
  () => request<OrderDetail>(`/api/v1/orders/${paidBeforeRestriction.order.id}`),
  (value) => value.order.status === "on_hold",
);
assert.equal(heldForRestriction.service.status, "pending");
const restrictedCreateCount = await providerPool.query<{ count: string }>(
  "SELECT count(*)::text AS count FROM mock_resource_operations WHERE operation_id = $1",
  [heldProvisionOperation.rows[0].id],
);
assert.equal(restrictedCreateCount.rows[0]?.count, "0");
await corePool.query("UPDATE users SET restricted_at = NULL WHERE email = $1", [email]);

await corePool.query(`
  CREATE OR REPLACE FUNCTION integration_delay_payment_start()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.job_type = 'payment.start' THEN
      NEW.available_at = now() + interval '1 hour';
    END IF;
    RETURN NEW;
  END;
  $$;
  CREATE TRIGGER integration_delay_payment_start
  BEFORE INSERT ON durable_jobs
  FOR EACH ROW EXECUTE FUNCTION integration_delay_payment_start();
`);
const staleLeaseOrder = await createOrder(automaticPrice.id, legal);
const staleLeaseQuote = await createPaymentQuote(staleLeaseOrder.invoice.id);
const staleLeasePayment = await request<{ paymentAttemptId: string }>(
  `/api/v1/invoices/${staleLeaseOrder.invoice.id}/payments`,
  {
    method: "POST",
    body: JSON.stringify({
      quoteId: staleLeaseQuote.quoteId,
      scenario: "success",
      idempotencyKey: randomUUID(),
    }),
  },
  202,
);
const staleLeaseRecord = await corePool.query<{ job_id: string; operation_id: string }>(
  `SELECT j.id AS job_id, po.id AS operation_id
   FROM durable_jobs j
   JOIN provider_operations po
     ON po.subject_type = 'payment'
    AND po.subject_id::text = $1
   WHERE j.job_type = 'payment.start'
     AND j.payload->>'paymentAttemptId' = $1`,
  [staleLeasePayment.paymentAttemptId],
);
assert.ok(staleLeaseRecord.rows[0]);
await corePool.query(
  `UPDATE durable_jobs
   SET status = 'running',
       attempts = 1,
       locked_at = now() - interval '10 minutes',
       locked_by = 'synthetic-dead-worker',
       available_at = now()
   WHERE id = $1`,
  [staleLeaseRecord.rows[0]?.job_id],
);
await corePool.query(`
  DROP TRIGGER integration_delay_payment_start ON durable_jobs;
  DROP FUNCTION integration_delay_payment_start();
`);
const recoveredLease = await waitFor(
  "stale queued/zero-attempt provider operation to recover without duplicate create",
  () => request<OrderDetail>(`/api/v1/orders/${staleLeaseOrder.order.id}`),
  (value) => value.service.status === "active",
  35_000,
);
assert.equal(recoveredLease.invoice.status, "paid");
const recoveredCreateCount = await providerPool.query<{ create_calls: number }>(
  "SELECT create_calls FROM mock_payment_operations WHERE operation_id = $1",
  [staleLeaseRecord.rows[0]?.operation_id],
);
assert.equal(recoveredCreateCount.rows[0]?.create_calls, 1);

const manualOrder = await createOrder(manualPrice.id, legal);
const paidManual = await pay(manualOrder, "success");
assert.equal(paidManual.order.status, "awaiting_manual");
assert.equal(paidManual.service.status, "pending");
assert.equal(paidManual.provisioning.status, null);

const bootstrapToken = randomBytes(32).toString("base64url");
const bootstrapDigest = createHash("sha256").update(bootstrapToken, "utf8").digest();
const secondBootstrapToken = randomBytes(32).toString("base64url");
const secondBootstrapDigest = createHash("sha256")
  .update(secondBootstrapToken, "utf8")
  .digest();
await corePool.query(
  `INSERT INTO staff_bootstrap_tokens(token_digest, expires_at)
   VALUES
     ($1, now() + interval '15 minutes'),
     ($2, now() + interval '15 minutes')`,
  [bootstrapDigest, secondBootstrapDigest],
);
await request(
  "/api/v1/admin/bootstrap",
  { method: "POST", body: JSON.stringify({ bootstrapToken }) },
  201,
);
await request(
  "/api/v1/admin/bootstrap",
  { method: "POST", body: JSON.stringify({ bootstrapToken: secondBootstrapToken }) },
  410,
);
await request(
  "/api/v1/auth/reauth",
  { method: "POST", body: JSON.stringify({ password }) },
  200,
);
const queue = await request<{ items: ManualItem[] }>("/api/v1/admin/manual-fulfillment");
assert.ok(queue.items.some((item) => item.serviceId === paidManual.service.id));
await request(
  `/api/v1/admin/services/${paidManual.service.id}/complete-manual`,
  {
    method: "POST",
    body: JSON.stringify({ reason: "Synthetic delivery confirmed by Stage A integration test" }),
  },
  200,
);
const activeManual = await request<OrderDetail>(`/api/v1/orders/${paidManual.order.id}`);
assert.equal(activeManual.service.status, "active");
assert.equal(activeManual.service.activatedAt, activeManual.service.termStart);

const staffMe = await request<{ id: string; clientAccountId: string }>("/api/v1/auth/me");
const creditAdjustmentKey = randomUUID();
const creditAdjustmentBody = {
  direction: "increase",
  amountMinor: "200",
  currency: "USD",
  reason: "Synthetic Stage B mixed-payment Credit grant",
  idempotencyKey: creditAdjustmentKey,
};
const creditGranted = await request<{ balanceMinor: string }>(
  `/api/v1/admin/client-accounts/${staffMe.clientAccountId}/credit-adjustments`,
  { method: "POST", body: JSON.stringify(creditAdjustmentBody) },
  201,
);
assert.equal(creditGranted.balanceMinor, "200");
const creditReplay = await request<{ balanceMinor: string }>(
  `/api/v1/admin/client-accounts/${staffMe.clientAccountId}/credit-adjustments`,
  { method: "POST", body: JSON.stringify(creditAdjustmentBody) },
  200,
);
assert.equal(creditReplay.balanceMinor, "200");

const mixedPaymentOrder = await createOrder(automaticPrice.id, legal);
const mixedCardPreview = await createPaymentQuote(mixedPaymentOrder.invoice.id, "card", true);
assert.equal(mixedCardPreview.creditToApplyMinor, "200");
assert.equal(mixedCardPreview.externalNonFeeMinor, "300");
assert.equal(mixedCardPreview.feeMinor, "11");
assert.equal(mixedCardPreview.externalDueMinor, "311");
const mixedUsdtPreview = await createPaymentQuote(mixedPaymentOrder.invoice.id, "usdt", true);
assert.equal(mixedUsdtPreview.creditToApplyMinor, "200");
assert.equal(mixedUsdtPreview.feeMinor, "0");
assert.equal(mixedUsdtPreview.externalDueMinor, "300");
const mixedFinalQuote = await createPaymentQuote(mixedPaymentOrder.invoice.id, "card", true);
const mixedPaymentCommand = await request<PaymentCommand>(
  `/api/v1/invoices/${mixedPaymentOrder.invoice.id}/payments`,
  {
    method: "POST",
    body: JSON.stringify({
      quoteId: mixedFinalQuote.quoteId,
      scenario: "success",
      idempotencyKey: randomUUID(),
    }),
  },
  202,
);
const mixedActive = await waitFor(
  "Credit plus external payment to activate one service",
  () => request<OrderDetail>(`/api/v1/orders/${mixedPaymentOrder.order.id}`),
  (value) => value.service.status === "active",
);
assert.equal(mixedActive.invoice.totalMinor, "511");
assert.equal(mixedActive.invoice.creditAppliedMinor, "200");
assert.equal(mixedActive.invoice.paymentAllocatedMinor, "311");
assert.equal(mixedActive.invoice.paymentFeeMinor, "11");
assert.equal(mixedActive.invoice.status, "paid");
const mixedCreditFacts = await corePool.query<{
  balance_minor: string;
  applications: string;
  fee_charges: string;
}>(
  `SELECT
     (SELECT COALESCE(sum(ct.credit_minor - ct.debit_minor), 0)::text
        FROM credit_accounts ca
        LEFT JOIN credit_transactions ct ON ct.credit_account_id = ca.id
       WHERE ca.client_account_id = $1 AND ca.currency = 'USD') AS balance_minor,
     (SELECT count(*)::text
        FROM credit_allocations ca
       WHERE ca.invoice_id = $2) AS applications,
     (SELECT count(*)::text
        FROM invoice_fee_charges ifc
       WHERE ifc.invoice_id = $2) AS fee_charges`,
  [staffMe.clientAccountId, mixedPaymentOrder.invoice.id],
);
assert.equal(mixedCreditFacts.rows[0]?.balance_minor, "0");
assert.equal(mixedCreditFacts.rows[0]?.applications, "1");
assert.equal(mixedCreditFacts.rows[0]?.fee_charges, "1");
const creditReplayAfterSpend = await request<{ balanceMinor: string }>(
  `/api/v1/admin/client-accounts/${staffMe.clientAccountId}/credit-adjustments`,
  { method: "POST", body: JSON.stringify(creditAdjustmentBody) },
  200,
);
assert.equal(
  creditReplayAfterSpend.balanceMinor,
  "200",
  "an idempotent Credit replay must return its stored result, not the current balance",
);
const mixedCreditSource = await corePool.query<{
  transaction_id: string;
  credit_account_id: string;
  source_type: string;
  source_id: string;
}>(
  `SELECT
     ct.id AS transaction_id,
     ct.credit_account_id,
     ct.source_type,
     ct.source_id
   FROM credit_transactions ct
   JOIN credit_allocations allocation ON allocation.credit_transaction_id = ct.id
   WHERE allocation.invoice_id = $1`,
  [mixedPaymentOrder.invoice.id],
);
assert.equal(mixedCreditSource.rows.length, 1);
assert.equal(mixedCreditSource.rows[0]?.source_type, "invoice_payment_command");
assert.equal(
  mixedCreditSource.rows[0]?.source_id,
  mixedPaymentCommand.commandId,
  "Credit application must be owned by the payment command, not by itself",
);

await request(
  `/api/v1/admin/client-accounts/${staffMe.clientAccountId}/credit-adjustments`,
  {
    method: "POST",
    body: JSON.stringify({
      direction: "increase",
      amountMinor: "500",
      currency: "USD",
      reason: "Synthetic Stage B full-Credit payment grant",
      idempotencyKey: randomUUID(),
    }),
  },
  201,
);
const fullCreditOrder = await createOrder(automaticPrice.id, legal);
const fullCreditQuote = await createPaymentQuote(fullCreditOrder.invoice.id, "card", true);
assert.equal(fullCreditQuote.creditToApplyMinor, "500");
assert.equal(fullCreditQuote.feeMinor, "0");
assert.equal(fullCreditQuote.externalDueMinor, "0");
await request(
  `/api/v1/invoices/${fullCreditOrder.invoice.id}/payments`,
  {
    method: "POST",
    body: JSON.stringify({
      quoteId: fullCreditQuote.quoteId,
      scenario: "success",
      idempotencyKey: randomUUID(),
    }),
  },
  200,
);
const fullCreditActive = await waitFor(
  "full-Credit invoice to activate without a Payment Provider operation",
  () => request<OrderDetail>(`/api/v1/orders/${fullCreditOrder.order.id}`),
  (value) => value.service.status === "active",
);
assert.equal(fullCreditActive.invoice.status, "paid");
assert.equal(fullCreditActive.invoice.paymentFeeMinor, "0");
assert.equal(fullCreditActive.payment.status, null);
const fullCreditPaymentFacts = await corePool.query<{ attempts: string; operations: string }>(
  `SELECT
     (SELECT count(*)::text FROM payment_attempts WHERE invoice_id = $1) AS attempts,
     (SELECT count(*)::text
        FROM provider_operations po
        JOIN payment_attempts pa ON pa.id = po.subject_id
       WHERE po.subject_type = 'payment' AND pa.invoice_id = $1) AS operations`,
  [fullCreditOrder.invoice.id],
);
assert.equal(fullCreditPaymentFacts.rows[0]?.attempts, "0");
assert.equal(fullCreditPaymentFacts.rows[0]?.operations, "0");

await request(
  `/api/v1/admin/client-accounts/${staffMe.clientAccountId}/credit-adjustments`,
  {
    method: "POST",
    body: JSON.stringify({
      direction: "increase",
      amountMinor: "500",
      currency: "USD",
      reason: "Synthetic Stage B concurrent Credit contention grant",
      idempotencyKey: randomUUID(),
    }),
  },
  201,
);
const competingCreditOrderA = await createOrder(automaticPrice.id, legal);
const competingCreditOrderB = await createOrder(automaticPrice.id, legal);
const competingCreditQuoteA = await createPaymentQuote(
  competingCreditOrderA.invoice.id,
  "card",
  true,
);
const competingCreditQuoteB = await createPaymentQuote(
  competingCreditOrderB.invoice.id,
  "card",
  true,
);
const competingCreditResults = await Promise.all([
  rawCoreRequest(`/api/v1/invoices/${competingCreditOrderA.invoice.id}/payments`, {
    method: "POST",
    body: JSON.stringify({
      quoteId: competingCreditQuoteA.quoteId,
      scenario: "success",
      idempotencyKey: randomUUID(),
    }),
  }),
  rawCoreRequest(`/api/v1/invoices/${competingCreditOrderB.invoice.id}/payments`, {
    method: "POST",
    body: JSON.stringify({
      quoteId: competingCreditQuoteB.quoteId,
      scenario: "success",
      idempotencyKey: randomUUID(),
    }),
  }),
]);
assert.deepEqual(
  competingCreditResults.map((result) => result.status).sort(),
  [200, 409],
);
assert.equal(
  competingCreditResults.find((result) => result.status === 409)?.body.code,
  "CREDIT_CHANGED",
);
const competingCreditOrders = await waitFor(
  "exactly one competing full-Credit invoice to settle",
  async () =>
    Promise.all([
      request<OrderDetail>(`/api/v1/orders/${competingCreditOrderA.order.id}`),
      request<OrderDetail>(`/api/v1/orders/${competingCreditOrderB.order.id}`),
    ]),
  (orders) => orders.filter((order) => order.invoice.status === "paid").length === 1,
);
assert.equal(
  competingCreditOrders.filter((order) => order.invoice.status === "paid").length,
  1,
);
const competingCreditFacts = await corePool.query<{
  balance_minor: string;
  allocations: string;
}>(
  `SELECT
     (SELECT COALESCE(sum(ct.credit_minor - ct.debit_minor), 0)::text
        FROM credit_accounts ca
        LEFT JOIN credit_transactions ct ON ct.credit_account_id = ca.id
       WHERE ca.client_account_id = $1 AND ca.currency = 'USD') AS balance_minor,
     (SELECT count(*)::text
        FROM credit_allocations ca
       WHERE ca.invoice_id IN ($2, $3)) AS allocations`,
  [
    staffMe.clientAccountId,
    competingCreditOrderA.invoice.id,
    competingCreditOrderB.invoice.id,
  ],
);
assert.equal(competingCreditFacts.rows[0]?.balance_minor, "0");
assert.equal(competingCreditFacts.rows[0]?.allocations, "1");

await request(
  `/api/v1/admin/client-accounts/${staffMe.clientAccountId}/credit-adjustments`,
  {
    method: "POST",
    body: JSON.stringify({
      direction: "increase",
      amountMinor: "1",
      currency: "USD",
      reason: "Synthetic source-identity uniqueness guard funding",
      idempotencyKey: randomUUID(),
    }),
  },
  201,
);
let duplicateCreditSourceError: unknown;
try {
  await corePool.query(
    `INSERT INTO credit_transactions(
       credit_account_id, kind, credit_minor, debit_minor,
       source_type, source_id, actor_type, reason,
       idempotency_key, request_fingerprint
     ) VALUES (
       $1, 'invoice_application', 0, 1,
       'invoice_payment_command', $2, 'system',
       'Synthetic duplicate source must be rejected', $3, $4
     )`,
    [
      mixedCreditSource.rows[0]?.credit_account_id,
      mixedPaymentCommand.commandId,
      `duplicate-source:${randomUUID()}`,
      createHash("sha256").update(randomUUID()).digest("hex"),
    ],
  );
} catch (error) {
  duplicateCreditSourceError = error;
}
assert.equal(
  (duplicateCreditSourceError as { code?: string } | undefined)?.code,
  "23505",
  "database must reject a second Credit transaction for the same payment-command source",
);

await installPaymentStartDelay();

async function assertMockSignatureCannotCrossProviderBoundary(
  mode: "non_mock" | "operation_mismatch",
): Promise<void> {
  const order = await createOrder(automaticPrice!.id, legal);
  const quote = await createPaymentQuote(order.invoice.id, "card", false);
  const command = await request<PaymentCommand>(
    `/api/v1/invoices/${order.invoice.id}/payments`,
    {
      method: "POST",
      body: JSON.stringify({
        quoteId: quote.quoteId,
        scenario: "success",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  assert.ok(command.paymentAttemptId);
  const before = await readPaymentRecords(command.commandId);
  const otherProvider = `synthetic-${mode}-provider`;
  if (mode === "non_mock") {
    await corePool.query(
      `UPDATE payment_attempts
       SET provider_installation_id = $2, status = 'processing'
       WHERE id = $1`,
      [command.paymentAttemptId, otherProvider],
    );
  } else {
    await corePool.query(
      `UPDATE payment_attempts
       SET status = 'processing'
       WHERE id = $1`,
      [command.paymentAttemptId],
    );
  }
  await corePool.query(
    `UPDATE provider_operations
     SET provider_installation_id = $2, status = 'running', attempt_count = 1
     WHERE id = $1`,
    [before.operation_id, otherProvider],
  );

  const externalPaymentId = `mock-cross-provider-${randomUUID()}`;
  const callback = await submitPaymentFact({
    eventId: `cross-provider:${mode}:${randomUUID()}`,
    paymentAttemptId: command.paymentAttemptId,
    externalPaymentId,
    status: "succeeded",
    amountMinor: before.amount_minor,
    currency: before.currency,
    occurredAt: new Date().toISOString(),
  });
  assert.equal(callback.status, 202);
  assert.equal(
    callback.body.rejected,
    true,
    "a valid Mock Payment signature must not authorize a differently owned payment",
  );

  const facts = await corePool.query<{
    receipts: string;
    allocations: string;
    fee_charges: string;
    command_status: string;
    service_status: string;
  }>(
    `SELECT
       (SELECT count(*)::text
          FROM fund_receipts
         WHERE reported_payment_attempt_id = $1) AS receipts,
       (SELECT count(*)::text
          FROM payment_allocations
         WHERE payment_attempt_id = $1) AS allocations,
       (SELECT count(*)::text
          FROM invoice_fee_charges
         WHERE payment_attempt_id = $1) AS fee_charges,
       (SELECT status
          FROM invoice_payment_commands
         WHERE id = $2) AS command_status,
       (SELECT s.status
          FROM services s
          JOIN order_items item ON item.id = s.order_item_id
          JOIN orders customer_order ON customer_order.id = item.order_id
         WHERE customer_order.id = $3) AS service_status`,
    [command.paymentAttemptId, command.commandId, order.order.id],
  );
  assert.equal(facts.rows[0]?.receipts, "0");
  assert.equal(facts.rows[0]?.allocations, "0");
  assert.equal(facts.rows[0]?.fee_charges, "0");
  assert.equal(facts.rows[0]?.command_status, "processing");
  assert.equal(facts.rows[0]?.service_status, "pending");

  await corePool.query(
    `UPDATE durable_jobs
     SET status = 'completed', locked_at = NULL, locked_by = NULL
     WHERE job_type = 'payment.start' AND payload->>'paymentAttemptId' = $1`,
    [command.paymentAttemptId],
  );
  await corePool.query("UPDATE provider_operations SET status = 'failed' WHERE id = $1", [
    before.operation_id,
  ]);
  await corePool.query("UPDATE payment_attempts SET status = 'failed' WHERE id = $1", [
    command.paymentAttemptId,
  ]);
  await corePool.query(
    `UPDATE invoice_payment_commands
     SET status = 'failed', result = '{"paymentStatus":"failed","testCleanup":true}'::jsonb
     WHERE id = $1`,
    [command.commandId],
  );
}

await assertMockSignatureCannotCrossProviderBoundary("non_mock");
await assertMockSignatureCannotCrossProviderBoundary("operation_mismatch");

const reconcileOwnershipOrder = await createOrder(automaticPrice.id, legal);
const reconcileOwnershipQuote = await createPaymentQuote(
  reconcileOwnershipOrder.invoice.id,
  "card",
  false,
);
const reconcileOwnershipCommand = await request<PaymentCommand>(
  `/api/v1/invoices/${reconcileOwnershipOrder.invoice.id}/payments`,
  {
    method: "POST",
    body: JSON.stringify({
      quoteId: reconcileOwnershipQuote.quoteId,
      scenario: "success",
      idempotencyKey: randomUUID(),
    }),
  },
  202,
);
assert.ok(reconcileOwnershipCommand.paymentAttemptId);
const reconcileOwnershipRecords = await readPaymentRecords(reconcileOwnershipCommand.commandId);
await corePool.query(
  `UPDATE durable_jobs
   SET status = 'completed', locked_at = NULL, locked_by = NULL
   WHERE job_type = 'payment.start'
     AND payload->>'paymentAttemptId' = $1`,
  [reconcileOwnershipCommand.paymentAttemptId],
);
await corePool.query("UPDATE payment_attempts SET status = 'unknown' WHERE id = $1", [
  reconcileOwnershipCommand.paymentAttemptId,
]);
await corePool.query(
  `UPDATE provider_operations
   SET provider_installation_id = 'synthetic-reconcile-provider',
       status = 'unknown',
       attempt_count = 1
   WHERE id = $1`,
  [reconcileOwnershipRecords.operation_id],
);
await corePool.query(
  `INSERT INTO durable_jobs(job_type, unique_key, payload)
   VALUES ('payment.reconcile', $1, $2)`,
  [
    `provider-ownership:${reconcileOwnershipCommand.paymentAttemptId}`,
    {
      paymentAttemptId: reconcileOwnershipCommand.paymentAttemptId,
      operationId: reconcileOwnershipRecords.operation_id,
    },
  ],
);
const reconcileOwnershipClosed = await waitFor(
  "Provider-mismatched reconciliation to enter manual review without an outbound query",
  async () => {
    const result = await corePool.query<{
      command_status: string;
      attempt_status: string;
      operation_status: string;
      job_status: string;
      order_status: string;
    }>(
      `SELECT
         command.status AS command_status,
         attempt.status AS attempt_status,
         operation.status AS operation_status,
         job.status AS job_status,
         customer_order.status AS order_status
       FROM invoice_payment_commands command
       JOIN payment_attempts attempt ON attempt.id = command.payment_attempt_id
       JOIN invoices invoice ON invoice.id = attempt.invoice_id
       JOIN orders customer_order ON customer_order.id = invoice.order_id
       JOIN provider_operations operation ON operation.id = $2
       JOIN durable_jobs job
         ON job.job_type = 'payment.reconcile'
        AND job.payload->>'paymentAttemptId' = attempt.id::text
       WHERE command.id = $1`,
      [reconcileOwnershipCommand.commandId, reconcileOwnershipRecords.operation_id],
    );
    return result.rows[0];
  },
  (value) =>
    value?.command_status === "manual" &&
    value.attempt_status === "unknown" &&
    value.operation_status === "unknown" &&
    value.job_status === "manual" &&
    value.order_status === "on_hold",
  8_000,
);
assert.equal(reconcileOwnershipClosed?.job_status, "manual");

const forgedReconcileOrder = await createOrder(automaticPrice.id, legal);
const forgedReconcileQuote = await createPaymentQuote(
  forgedReconcileOrder.invoice.id,
  "card",
  false,
);
const forgedReconcileCommand = await request<PaymentCommand>(
  `/api/v1/invoices/${forgedReconcileOrder.invoice.id}/payments`,
  {
    method: "POST",
    body: JSON.stringify({
      quoteId: forgedReconcileQuote.quoteId,
      scenario: "success",
      idempotencyKey: randomUUID(),
    }),
  },
  202,
);
assert.ok(forgedReconcileCommand.paymentAttemptId);
const forgedReconcileRecords = await readPaymentRecords(forgedReconcileCommand.commandId);
await corePool.query(
  `UPDATE durable_jobs
   SET status = 'completed', locked_at = NULL, locked_by = NULL
   WHERE job_type = 'payment.start'
     AND payload->>'paymentAttemptId' = $1`,
  [forgedReconcileCommand.paymentAttemptId],
);
await corePool.query("UPDATE payment_attempts SET status = 'unknown' WHERE id = $1", [
  forgedReconcileCommand.paymentAttemptId,
]);
await corePool.query(
  `UPDATE provider_operations
   SET status = 'unknown', attempt_count = 1
   WHERE id = $1`,
  [forgedReconcileRecords.operation_id],
);
await providerPool.query(
  `INSERT INTO mock_payment_operations(
     operation_id, payment_attempt_id, external_payment_id,
     amount_minor, currency, scenario, status, callback_capability,
     request_fingerprint
   ) VALUES ($1, $2, $3, $4, $5, 'success', 'succeeded', $6, $7)`,
  [
    forgedReconcileRecords.operation_id,
    forgedReconcileCommand.paymentAttemptId,
    `mock-forged-reconcile-${randomUUID()}`,
    forgedReconcileRecords.amount_minor,
    forgedReconcileRecords.currency,
    "A".repeat(43),
    createHash("sha256").update(randomUUID()).digest("hex"),
  ],
);
await corePool.query(
  `INSERT INTO durable_jobs(job_type, unique_key, payload)
   VALUES ('payment.reconcile', $1, $2)`,
  [
    `forged-reconcile:${forgedReconcileCommand.paymentAttemptId}`,
    {
      paymentAttemptId: forgedReconcileCommand.paymentAttemptId,
      operationId: forgedReconcileRecords.operation_id,
    },
  ],
);
const forgedReconcileClosed = await waitFor(
  "Provider reconciliation without the outbound capability to enter manual review",
  async () => {
    const result = await corePool.query<{
      command_status: string;
      attempt_status: string;
      operation_status: string;
      job_status: string;
      receipts: string;
      fee_charges: string;
      allocated_minor: string;
      service_status: string;
    }>(
      `SELECT
         command.status AS command_status,
         attempt.status AS attempt_status,
         operation.status AS operation_status,
         job.status AS job_status,
         (SELECT count(*)::text
            FROM fund_receipts
           WHERE reported_payment_attempt_id = attempt.id) AS receipts,
         (SELECT count(*)::text
            FROM invoice_fee_charges
           WHERE payment_attempt_id = attempt.id) AS fee_charges,
         allocation.allocated_minor::text,
         service.status AS service_status
       FROM invoice_payment_commands command
       JOIN payment_attempts attempt ON attempt.id = command.payment_attempt_id
       JOIN invoices invoice ON invoice.id = attempt.invoice_id
       JOIN invoice_allocation_totals allocation ON allocation.invoice_id = invoice.id
       JOIN orders customer_order ON customer_order.id = invoice.order_id
       JOIN order_items item ON item.order_id = customer_order.id
       JOIN services service ON service.order_item_id = item.id
       JOIN provider_operations operation ON operation.id = $2
       JOIN durable_jobs job
         ON job.job_type = 'payment.reconcile'
        AND job.payload->>'paymentAttemptId' = attempt.id::text
       WHERE command.id = $1`,
      [forgedReconcileCommand.commandId, forgedReconcileRecords.operation_id],
    );
    return result.rows[0];
  },
  (value) =>
    value?.command_status === "manual" &&
    value.attempt_status === "unknown" &&
    value.operation_status === "unknown" &&
    value.job_status === "manual",
  8_000,
);
assert.equal(forgedReconcileClosed?.receipts, "0");
assert.equal(forgedReconcileClosed?.fee_charges, "0");
assert.equal(forgedReconcileClosed?.allocated_minor, "0");
assert.equal(forgedReconcileClosed?.service_status, "pending");

const mismatchOrder = await createOrder(automaticPrice.id, legal);
const mismatchQuote = await createPaymentQuote(mismatchOrder.invoice.id, "card", false);
const mismatchCommand = await request<PaymentCommand>(
  `/api/v1/invoices/${mismatchOrder.invoice.id}/payments`,
  {
    method: "POST",
    body: JSON.stringify({
      quoteId: mismatchQuote.quoteId,
      scenario: "success",
      idempotencyKey: randomUUID(),
    }),
  },
  202,
);
assert.ok(mismatchCommand.paymentAttemptId);
const mismatchRecords = await readPaymentRecords(mismatchCommand.commandId);
await corePool.query("UPDATE payment_attempts SET status = 'processing' WHERE id = $1", [
  mismatchCommand.paymentAttemptId,
]);
await corePool.query(
  `UPDATE provider_operations
   SET status = 'running', attempt_count = 1
   WHERE id = $1`,
  [mismatchRecords.operation_id],
);
const mismatchExternalId = `mock-wrong-amount-${randomUUID()}`;
const mismatchAmountMinor = (BigInt(mismatchRecords.amount_minor) + 1n).toString();
const mismatchCallback = await submitPaymentFact({
  eventId: `wrong-amount:${randomUUID()}`,
  paymentAttemptId: mismatchCommand.paymentAttemptId,
  externalPaymentId: mismatchExternalId,
  status: "succeeded",
  amountMinor: mismatchAmountMinor,
  currency: mismatchRecords.currency,
  occurredAt: new Date().toISOString(),
});
assert.equal(mismatchCallback.status, 202);
assert.equal(mismatchCallback.body.status, "unclaimed");
const mismatchCoreState = await corePool.query<{
  command_status: string;
  attempt_status: string;
  operation_status: string;
  receipt_disposition: string;
}>(
  `SELECT
     command.status AS command_status,
     attempt.status AS attempt_status,
     operation.status AS operation_status,
     receipt.disposition AS receipt_disposition
   FROM invoice_payment_commands command
   JOIN payment_attempts attempt ON attempt.id = command.payment_attempt_id
   JOIN provider_operations operation
     ON operation.subject_type = 'payment'
    AND operation.subject_id = attempt.id
   JOIN fund_receipts receipt ON receipt.reported_payment_attempt_id = attempt.id
   WHERE command.id = $1`,
  [mismatchCommand.commandId],
);
assert.equal(mismatchCoreState.rows[0]?.command_status, "manual");
assert.equal(mismatchCoreState.rows[0]?.attempt_status, "unknown");
assert.equal(mismatchCoreState.rows[0]?.operation_status, "unknown");
assert.equal(mismatchCoreState.rows[0]?.receipt_disposition, "unclaimed");
const mismatchCapability = providerOperationCapability(
  providerCapabilitySecret,
  "mock-payment-v1",
  mismatchRecords.operation_id,
);
await providerPool.query(
  `INSERT INTO mock_payment_operations(
     operation_id, payment_attempt_id, external_payment_id,
     amount_minor, currency, scenario, status, callback_capability,
     request_fingerprint
   ) VALUES ($1, $2, $3, $4, $5, 'success', 'succeeded', $6, $7)`,
  [
    mismatchRecords.operation_id,
    mismatchCommand.paymentAttemptId,
    mismatchExternalId,
    mismatchAmountMinor,
    mismatchRecords.currency,
    mismatchCapability,
    createHash("sha256").update(randomUUID()).digest("hex"),
  ],
);
await corePool.query(
  `UPDATE durable_jobs
   SET status = 'completed', locked_at = NULL, locked_by = NULL
   WHERE job_type = 'payment.start'
     AND payload->>'paymentAttemptId' = $1`,
  [mismatchCommand.paymentAttemptId],
);
await corePool.query(
  `INSERT INTO durable_jobs(job_type, unique_key, payload)
   VALUES ('payment.reconcile', $1, $2)`,
  [
    `wrong-amount:${mismatchCommand.paymentAttemptId}`,
    {
      paymentAttemptId: mismatchCommand.paymentAttemptId,
      operationId: mismatchRecords.operation_id,
    },
  ],
);
const mismatchReconciled = await waitFor(
  "duplicate mismatched receipt reconciliation to preserve manual command state",
  async () => {
    const result = await corePool.query<{
      command_status: string;
      attempt_status: string;
      operation_status: string;
      job_status: string;
      receipts: string;
    }>(
      `SELECT
         command.status AS command_status,
         attempt.status AS attempt_status,
         operation.status AS operation_status,
         job.status AS job_status,
         (SELECT count(*)::text
            FROM fund_receipts
           WHERE reported_payment_attempt_id = attempt.id) AS receipts
       FROM invoice_payment_commands command
       JOIN payment_attempts attempt ON attempt.id = command.payment_attempt_id
       JOIN provider_operations operation ON operation.id = $2
       JOIN durable_jobs job
         ON job.job_type = 'payment.reconcile'
        AND job.payload->>'paymentAttemptId' = attempt.id::text
       WHERE command.id = $1`,
      [mismatchCommand.commandId, mismatchRecords.operation_id],
    );
    return result.rows[0];
  },
  (value) =>
    value?.command_status === "manual" &&
    value.attempt_status === "unknown" &&
    value.operation_status === "unknown" &&
    value.job_status === "completed" &&
    value.receipts === "1",
  8_000,
);
assert.equal(mismatchReconciled?.command_status, "manual");

const callbackRaceOrder = await createOrder(automaticPrice.id, legal);
const callbackRaceQuote = await createPaymentQuote(callbackRaceOrder.invoice.id, "card", false);
const callbackRaceCommand = await request<PaymentCommand>(
  `/api/v1/invoices/${callbackRaceOrder.invoice.id}/payments`,
  {
    method: "POST",
    body: JSON.stringify({
      quoteId: callbackRaceQuote.quoteId,
      scenario: "success",
      idempotencyKey: randomUUID(),
    }),
  },
  202,
);
assert.ok(callbackRaceCommand.paymentAttemptId);
const callbackRaceRecords = await readPaymentRecords(callbackRaceCommand.commandId);
const competingQuote = await createPaymentQuote(callbackRaceOrder.invoice.id, "usdt", false);
await corePool.query(
  "UPDATE payment_attempts SET status = 'processing' WHERE id = $1",
  [callbackRaceCommand.paymentAttemptId],
);
await corePool.query(
  `UPDATE provider_operations
   SET status = 'running', attempt_count = 1
   WHERE id = $1`,
  [callbackRaceRecords.operation_id],
);
const callbackRaceFact = {
  eventId: `callback-lock-order:${randomUUID()}`,
  paymentAttemptId: callbackRaceCommand.paymentAttemptId,
  externalPaymentId: `mock-lock-order-${randomUUID()}`,
  status: "succeeded",
  amountMinor: callbackRaceRecords.amount_minor,
  currency: callbackRaceRecords.currency,
  occurredAt: new Date().toISOString(),
};
const preOutboundForgery = await submitPaymentFact({
  ...callbackRaceFact,
  externalPaymentId: `mock-forged-before-outbound-${randomUUID()}`,
  callbackCapability: "A".repeat(43),
});
assert.equal(preOutboundForgery.status, 202);
assert.equal(preOutboundForgery.body.rejected, true);
assert.equal(preOutboundForgery.body.reason, "invalid_operation_capability");
const preOutboundProviderFacts = await providerPool.query<{ operations: string }>(
  `SELECT count(*)::text AS operations
   FROM mock_payment_operations
   WHERE operation_id = $1`,
  [callbackRaceRecords.operation_id],
);
const preOutboundFacts = await corePool.query<{
  receipts: string;
  fee_charges: string;
}>(
  `SELECT
     (SELECT count(*)::text
        FROM fund_receipts
       WHERE reported_payment_attempt_id = $1) AS receipts,
     (SELECT count(*)::text
        FROM invoice_fee_charges
       WHERE payment_attempt_id = $1) AS fee_charges`,
  [callbackRaceCommand.paymentAttemptId],
);
assert.equal(preOutboundProviderFacts.rows[0]?.operations, "0");
assert.equal(preOutboundFacts.rows[0]?.receipts, "0");
assert.equal(preOutboundFacts.rows[0]?.fee_charges, "0");
const [callbackRaceResult, competingConfirmation] = await Promise.all([
  submitPaymentFact(callbackRaceFact),
  rawCoreRequest(`/api/v1/invoices/${callbackRaceOrder.invoice.id}/payments`, {
    method: "POST",
    body: JSON.stringify({
      quoteId: competingQuote.quoteId,
      scenario: "success",
      idempotencyKey: randomUUID(),
    }),
  }),
]);
assert.equal(callbackRaceResult.status, 202);
assert.equal(callbackRaceResult.body.accepted, true);
assert.equal(
  competingConfirmation.status,
  409,
  "a concurrent second confirmation must conflict rather than deadlock or create another payment",
);
const callbackRaceActive = await waitFor(
  "callback/confirmation lock-order race to activate exactly one service",
  () => request<OrderDetail>(`/api/v1/orders/${callbackRaceOrder.order.id}`),
  (value) => value.service.status === "active",
);
assert.equal(callbackRaceActive.invoice.status, "paid");
const callbackRaceFacts = await corePool.query<{
  receipts: string;
  fee_charges: string;
  attempts: string;
}>(
  `SELECT
     (SELECT count(*)::text
        FROM fund_receipts
       WHERE reported_payment_attempt_id = $1) AS receipts,
     (SELECT count(*)::text
        FROM invoice_fee_charges
       WHERE payment_attempt_id = $1) AS fee_charges,
     (SELECT count(*)::text
        FROM payment_attempts
       WHERE invoice_id = $2) AS attempts`,
  [callbackRaceCommand.paymentAttemptId, callbackRaceOrder.invoice.id],
);
assert.equal(callbackRaceFacts.rows[0]?.receipts, "1");
assert.equal(callbackRaceFacts.rows[0]?.fee_charges, "1");
assert.equal(callbackRaceFacts.rows[0]?.attempts, "1");
await corePool.query(
  `UPDATE durable_jobs
   SET status = 'completed', locked_at = NULL, locked_by = NULL
   WHERE job_type = 'payment.start'
     AND payload->>'paymentAttemptId' = $1`,
  [callbackRaceCommand.paymentAttemptId],
);

await request(
  `/api/v1/admin/client-accounts/${staffMe.clientAccountId}/credit-adjustments`,
  {
    method: "POST",
    body: JSON.stringify({
      direction: "increase",
      amountMinor: "200",
      currency: "USD",
      reason: "Synthetic known-unsent Credit restoration funding",
      idempotencyKey: randomUUID(),
    }),
  },
  201,
);
const restorableCredit = await corePool.query<{ balance_minor: string }>(
  `SELECT COALESCE(sum(ct.credit_minor - ct.debit_minor), 0)::text AS balance_minor
   FROM credit_accounts ca
   LEFT JOIN credit_transactions ct ON ct.credit_account_id = ca.id
   WHERE ca.client_account_id = $1 AND ca.currency = 'USD'`,
  [staffMe.clientAccountId],
);
const restorableCreditMinor = restorableCredit.rows[0]?.balance_minor;
assert.ok(restorableCreditMinor && BigInt(restorableCreditMinor) > 0n);

const eligibilityRevocations: Array<{
  label: string;
  revoke: () => Promise<unknown>;
  restore: () => Promise<unknown>;
}> = [
  {
    label: "user restriction",
    revoke: () => corePool.query("UPDATE users SET restricted_at = now() WHERE id = $1", [staffMe.id]),
    restore: () => corePool.query("UPDATE users SET restricted_at = NULL WHERE id = $1", [staffMe.id]),
  },
  {
    label: "client-account restriction",
    revoke: () =>
      corePool.query("UPDATE client_accounts SET restricted_at = now() WHERE id = $1", [
        staffMe.clientAccountId,
      ]),
    restore: () =>
      corePool.query("UPDATE client_accounts SET restricted_at = NULL WHERE id = $1", [
        staffMe.clientAccountId,
      ]),
  },
  {
    label: "membership removal",
    revoke: () =>
      corePool.query(
        `UPDATE client_memberships
         SET removed_at = now()
         WHERE client_account_id = $1 AND user_id = $2`,
        [staffMe.clientAccountId, staffMe.id],
      ),
    restore: () =>
      corePool.query(
        `UPDATE client_memberships
         SET removed_at = NULL
         WHERE client_account_id = $1 AND user_id = $2`,
        [staffMe.clientAccountId, staffMe.id],
      ),
  },
];

for (const revocation of eligibilityRevocations) {
  const order = await createOrder(automaticPrice.id, legal);
  const exercisesCreditRestoration = revocation.label === "user restriction";
  const quote = await createPaymentQuote(
    order.invoice.id,
    "card",
    exercisesCreditRestoration,
  );
  if (exercisesCreditRestoration) {
    assert.equal(quote.creditToApplyMinor, restorableCreditMinor);
  }
  const command = await request<PaymentCommand>(
    `/api/v1/invoices/${order.invoice.id}/payments`,
    {
      method: "POST",
      body: JSON.stringify({
        quoteId: quote.quoteId,
        scenario: "success",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  assert.ok(command.paymentAttemptId);
  const initialRecords = await readPaymentRecords(command.commandId);
  assert.equal(initialRecords.attempt_status, "created");
  assert.equal(initialRecords.operation_status, "queued");

  await revocation.revoke();
  await releasePaymentStart(command.paymentAttemptId);
  const closed = await waitFor(
    `known-unsent payment to close after ${revocation.label}`,
    () => readPaymentRecords(command.commandId),
    (records) =>
      records.command_status === "failed" &&
      records.attempt_status === "cancelled" &&
      records.operation_status === "failed" &&
      records.job_status === "completed",
    8_000,
  );
  const providerCalls = await providerPool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM mock_payment_operations WHERE operation_id = $1",
    [closed.operation_id],
  );
  assert.equal(providerCalls.rows[0]?.count, "0");
  if (exercisesCreditRestoration) {
    const restored = await corePool.query<{
      balance_minor: string;
      allocated_minor: string;
      allocation_rows: string;
      reversal_rows: string;
    }>(
      `SELECT
         (SELECT COALESCE(sum(ct.credit_minor - ct.debit_minor), 0)::text
            FROM credit_accounts ca
            LEFT JOIN credit_transactions ct ON ct.credit_account_id = ca.id
           WHERE ca.client_account_id = $1 AND ca.currency = 'USD') AS balance_minor,
         (SELECT COALESCE(sum(amount_minor), 0)::text
            FROM credit_allocations
           WHERE invoice_id = $2) AS allocated_minor,
         (SELECT count(*)::text
            FROM credit_allocations
           WHERE invoice_id = $2) AS allocation_rows,
         (SELECT count(*)::text
            FROM credit_transactions
           WHERE kind = 'invoice_application_reversal'
             AND source_type = 'invoice_payment_command_reversal'
             AND source_id = $3) AS reversal_rows`,
      [staffMe.clientAccountId, order.invoice.id, command.commandId],
    );
    assert.equal(restored.rows[0]?.balance_minor, restorableCreditMinor);
    assert.equal(restored.rows[0]?.allocated_minor, "0");
    assert.equal(restored.rows[0]?.allocation_rows, "2");
    assert.equal(restored.rows[0]?.reversal_rows, "1");
  }

  await revocation.restore();
  const retryQuote = await createPaymentQuote(order.invoice.id, "card", false);
  const retry = await request<PaymentCommand>(
    `/api/v1/invoices/${order.invoice.id}/payments`,
    {
      method: "POST",
      body: JSON.stringify({
        quoteId: retryQuote.quoteId,
        scenario: "success",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  assert.ok(retry.paymentAttemptId);
  await releasePaymentStart(retry.paymentAttemptId);
  const retriedOrder = await waitFor(
    `payment retry after restoring ${revocation.label}`,
    () => request<OrderDetail>(`/api/v1/orders/${order.order.id}`),
    (value) => value.service.status === "active",
  );
  assert.equal(retriedOrder.invoice.status, "paid");
}

const definitiveOrder = await createOrder(automaticPrice.id, legal);
const definitiveQuote = await createPaymentQuote(definitiveOrder.invoice.id, "card", false);
const definitiveKey = randomUUID();
const definitiveRequestBody = {
  quoteId: definitiveQuote.quoteId,
  scenario: "definitive_reject",
  idempotencyKey: definitiveKey,
};
const definitiveCommand = await request<PaymentCommand>(
  `/api/v1/invoices/${definitiveOrder.invoice.id}/payments`,
  { method: "POST", body: JSON.stringify(definitiveRequestBody) },
  202,
);
assert.ok(definitiveCommand.paymentAttemptId);
await releasePaymentStart(definitiveCommand.paymentAttemptId);
const definitivelyRejected = await waitFor(
  "definitive Provider 400 to close the command",
  () => readPaymentRecords(definitiveCommand.commandId),
  (records) =>
    records.command_status === "failed" &&
    records.attempt_status === "failed" &&
    records.operation_status === "failed",
  8_000,
);
const definitiveProviderCalls = await providerPool.query<{ count: string }>(
  "SELECT count(*)::text AS count FROM mock_payment_operations WHERE operation_id = $1",
  [definitivelyRejected.operation_id],
);
assert.equal(definitiveProviderCalls.rows[0]?.count, "0");
const definitiveReplay = await request<PaymentCommand>(
  `/api/v1/invoices/${definitiveOrder.invoice.id}/payments`,
  { method: "POST", body: JSON.stringify(definitiveRequestBody) },
  200,
);
assert.equal(definitiveReplay.commandId, definitiveCommand.commandId);
assert.equal(definitiveReplay.paymentAttemptId, definitiveCommand.paymentAttemptId);
assert.equal(definitiveReplay.status, "failed");
assert.equal(definitiveReplay.replayed, true);

await dropPaymentStartDelay();

await corePool.query("UPDATE users SET restricted_at = now() WHERE email = $1", [email]);
await request(
  "/api/v1/auth/reauth",
  { method: "POST", body: JSON.stringify({ password }) },
  403,
);
const invalidatedGrant = await corePool.query<{ count: string }>(
  `SELECT count(*)::text AS count
   FROM reauth_grants rg
   JOIN users u ON u.id = rg.user_id
   WHERE u.email = $1 AND rg.invalidated_at IS NULL`,
  [email],
);
assert.equal(invalidatedGrant.rows[0]?.count, "0");
await corePool.query("UPDATE users SET restricted_at = NULL WHERE email = $1", [email]);

const staffCookie = cookie;
const recoveryEmail = `expired-${randomUUID()}@example.invalid`;
const recoveryPassword = `Synthetic-${randomBytes(12).toString("hex")}!`;
await request(
  "/api/v1/auth/register",
  {
    method: "POST",
    body: JSON.stringify({
      email: recoveryEmail,
      password: recoveryPassword,
      clientName: "Synthetic Verification Recovery",
      locale: "en",
    }),
  },
  201,
);
await request(
  "/api/v1/auth/login",
  { method: "POST", body: JSON.stringify({ email: recoveryEmail, password: recoveryPassword }) },
  200,
);
const recoveryMailbox = await waitFor(
  "initial verification message for expiration recovery",
  () => request<{ messages: Array<{ body: string }> }>("/api/v1/lab/mailbox"),
  (value) => value.messages.length > 0,
);
const expiredUrl = recoveryMailbox.messages[0]?.body.match(/https?:\/\/\S+/)?.[0];
assert.ok(expiredUrl);
const expiredToken = new URL(expiredUrl).searchParams.get("token");
assert.ok(expiredToken);
await corePool.query(
  `UPDATE email_verification_tokens evt
   SET expires_at = now() - interval '1 minute',
       created_at = now() - interval '2 minutes'
   FROM users u
   WHERE evt.user_id = u.id AND u.email = $1`,
  [recoveryEmail],
);
await request(
  "/api/v1/auth/verify-email",
  { method: "POST", body: JSON.stringify({ token: expiredToken }) },
  410,
);
await request(
  "/api/v1/auth/resend-verification",
  { method: "POST", body: JSON.stringify({}) },
  200,
);
const resentMailbox = await waitFor(
  "replacement verification message",
  () => request<{ messages: Array<{ body: string }> }>("/api/v1/lab/mailbox"),
  (value) => value.messages.length >= 2,
);
const replacementUrl = resentMailbox.messages[0]?.body.match(/https?:\/\/\S+/)?.[0];
assert.ok(replacementUrl);
const replacementToken = new URL(replacementUrl).searchParams.get("token");
assert.ok(replacementToken);
await request(
  "/api/v1/auth/verify-email",
  { method: "POST", body: JSON.stringify({ token: replacementToken }) },
  200,
);

for (const invalidPrincipal of ["4999", "500001"]) {
  const invalidQuote = await rawCoreRequest("/api/v1/billing/add-funds/quotes", {
    method: "POST",
    body: JSON.stringify({ principalMinor: invalidPrincipal, paymentMethod: "card" }),
  });
  assert.equal(invalidQuote.status, 409);
  assert.equal(invalidQuote.body.code, "ADD_FUNDS_AMOUNT_OUT_OF_RANGE");
}

const cardAddFundsQuote = await createAddFundsQuote("5000", "card");
assert.equal(cardAddFundsQuote.principalMinor, "5000");
assert.equal(cardAddFundsQuote.feeMinor, "175");
assert.equal(cardAddFundsQuote.externalDueMinor, "5175");
assert.equal(cardAddFundsQuote.balanceCapMinor, "1000000");
const duplicateAddFunds = await startAddFunds(
  cardAddFundsQuote.quoteId,
  "duplicate_out_of_order",
);
const duplicateAddFundsReplay = await request<AddFundsCommand>(
  "/api/v1/billing/add-funds",
  {
    method: "POST",
    body: JSON.stringify({
      quoteId: cardAddFundsQuote.quoteId,
      scenario: "duplicate_out_of_order",
      idempotencyKey: duplicateAddFunds.idempotencyKey,
    }),
  },
  200,
);
assert.equal(duplicateAddFundsReplay.commandId, duplicateAddFunds.command.commandId);
assert.equal(duplicateAddFundsReplay.replayed, true);
const settledAddFunds = await waitForAddFunds(
  duplicateAddFunds.command.commandId,
  "succeeded",
);
assert.equal(settledAddFunds.result?.principalCreditedMinor, "5000");
assert.equal(settledAddFunds.result?.feeMinor, "175");
assert.equal(settledAddFunds.result?.externalPaidMinor, "5175");

const initialAddFundsFacts = await corePool.query<{
  balance_minor: string;
  credits: string;
  settlements: string;
  receipts: string;
  journals: string;
  invoice_allocations: string;
}>(
  `SELECT
     (SELECT COALESCE(sum(transaction.credit_minor - transaction.debit_minor), 0)::text
        FROM credit_accounts account
        LEFT JOIN credit_transactions transaction
          ON transaction.credit_account_id = account.id
       WHERE account.client_account_id = $1 AND account.currency = 'USD') AS balance_minor,
     (SELECT count(*)::text
        FROM credit_transactions
       WHERE kind = 'add_funds'
         AND source_type = 'add_funds_settlement') AS credits,
     (SELECT count(*)::text FROM add_funds_settlements) AS settlements,
     (SELECT count(*)::text
        FROM fund_receipts
       WHERE reported_add_funds_attempt_id IS NOT NULL
         AND disposition = 'allocated') AS receipts,
     (SELECT count(*)::text
        FROM ledger_journals
       WHERE source_type = 'add_funds_settlement') AS journals,
     (SELECT count(*)::text
        FROM payment_allocations allocation
        JOIN payment_attempts attempt ON attempt.id = allocation.payment_attempt_id
       WHERE attempt.client_account_id = $1) AS invoice_allocations`,
  [
    (
      await request<{ clientAccountId: string }>("/api/v1/auth/me")
    ).clientAccountId,
  ],
);
assert.equal(initialAddFundsFacts.rows[0]?.balance_minor, "5000");
assert.equal(initialAddFundsFacts.rows[0]?.credits, "1");
assert.equal(initialAddFundsFacts.rows[0]?.settlements, "1");
assert.equal(initialAddFundsFacts.rows[0]?.receipts, "1");
assert.equal(initialAddFundsFacts.rows[0]?.journals, "1");
assert.equal(initialAddFundsFacts.rows[0]?.invoice_allocations, "0");

const usdtAddFundsQuote = await createAddFundsQuote("5000", "usdt");
assert.equal(usdtAddFundsQuote.feeMinor, "0");
assert.equal(usdtAddFundsQuote.externalDueMinor, "5000");

const timeoutAddFundsQuote = await createAddFundsQuote("5000", "card");
const timeoutAddFunds = await startAddFunds(timeoutAddFundsQuote.quoteId, "timeout_success");
const settledTimeoutAddFunds = await waitForAddFunds(
  timeoutAddFunds.command.commandId,
  "succeeded",
);
assert.equal(settledTimeoutAddFunds.result?.principalCreditedMinor, "5000");

let partialManual: AddFundsStatus | null = null;
for (const scenario of [
  "partial",
  "wrong_currency",
  "expired_late",
  "late_success",
] as const) {
  const quote = await createAddFundsQuote("5000", "card");
  const started = await startAddFunds(quote.quoteId, scenario);
  const manual = await waitForAddFunds(started.command.commandId, "manual");
  assert.match(
    String(manual.result?.reason),
    scenario === "expired_late"
      ? /settlement arrived after Add Funds became expired/
      : scenario === "late_success"
        ? /settlement occurred after the Add Funds attempt expired/
      : /does not match the Add Funds snapshot/,
  );
  if (scenario === "late_success") {
    const reconciledFactResponse: Response = await fetch(
      new URL(`/v1/payments/${manual.providerOperationId}`, providerUrl),
      {
        headers: { Authorization: `Bearer ${paymentProviderToken}` },
      },
    );
    assert.equal(reconciledFactResponse.status, 200);
    const reconciledFact = (await reconciledFactResponse.json()) as {
      occurredAt: string;
    };
    const callbackFact = await corePool.query<{ provider_occurred_at: Date }>(
      `SELECT provider_occurred_at
       FROM add_funds_attempts
       WHERE id = $1`,
      [manual.addFundsAttemptId],
    );
    assert.equal(
      reconciledFact.occurredAt,
      callbackFact.rows[0]?.provider_occurred_at.toISOString(),
      "Mock Provider webhook and reconciliation must report the same occurrence time",
    );
  }
  if (scenario === "partial") partialManual = manual;
}
assert.ok(partialManual);
const secondReceiptAfterManual = await submitPaymentFact({
  eventId: `add-funds-second-receipt:${randomUUID()}`,
  providerOperationId: partialManual.providerOperationId,
  paymentAttemptId: partialManual.addFundsAttemptId,
  externalPaymentId: `mock-add-funds-second-${randomUUID()}`,
  status: "succeeded",
  amountMinor: "5175",
  currency: "USD",
  occurredAt: new Date(Date.now() + 60_000).toISOString(),
});
assert.equal(secondReceiptAfterManual.status, 202);
assert.equal(secondReceiptAfterManual.body.status, "unclaimed");
const stillManualAfterSecondReceipt = await request<AddFundsStatus>(
  `/api/v1/billing/add-funds/${partialManual.commandId}`,
);
assert.equal(stillManualAfterSecondReceipt.status, "manual");
assert.match(
  String(stillManualAfterSecondReceipt.result?.reason),
  /previous funds require manual review/,
);

const callbackBeforeRejectQuote = await createAddFundsQuote("5000", "card");
const callbackBeforeReject = await startAddFunds(
  callbackBeforeRejectQuote.quoteId,
  "partial_then_reject",
);
await waitForAddFunds(callbackBeforeReject.command.commandId, "manual");
await waitFor(
  "Worker to preserve partial funds after the create response rejects",
  async () => {
    const state = await corePool.query<{
      command_status: string;
      attempt_status: string;
      operation_status: string;
      job_status: string;
      receipts: string;
    }>(
      `SELECT
         command.status AS command_status,
         attempt.status AS attempt_status,
         operation.status AS operation_status,
         job.status AS job_status,
         (
           SELECT count(*)::text
           FROM fund_receipts receipt
           WHERE receipt.reported_add_funds_attempt_id = attempt.id
             AND receipt.disposition = 'unclaimed'
         ) AS receipts
       FROM add_funds_commands command
       JOIN add_funds_attempts attempt ON attempt.id = command.add_funds_attempt_id
       JOIN provider_operations operation
         ON operation.subject_type = 'add_funds'
        AND operation.subject_id = attempt.id
       JOIN durable_jobs job
         ON job.job_type = 'add_funds.start'
        AND job.payload->>'addFundsAttemptId' = attempt.id::text
       WHERE command.id = $1`,
      [callbackBeforeReject.command.commandId],
    );
    return state.rows[0];
  },
  (state) =>
    state?.command_status === "manual" &&
    state.attempt_status === "unknown" &&
    state.operation_status === "unknown" &&
    state.job_status === "completed" &&
    state.receipts === "1",
);
const preservedCallbackBeforeReject = await request<AddFundsStatus>(
  `/api/v1/billing/add-funds/${callbackBeforeReject.command.commandId}`,
);
assert.equal(preservedCallbackBeforeReject.status, "manual");
assert.match(
  String(preservedCallbackBeforeReject.result?.reason),
  /does not match the Add Funds snapshot/,
);

const callbackBeforeTimeoutQuote = await createAddFundsQuote("5000", "card");
const callbackBeforeTimeout = await startAddFunds(
  callbackBeforeTimeoutQuote.quoteId,
  "partial_then_timeout",
);
await waitForAddFunds(callbackBeforeTimeout.command.commandId, "manual");
await waitFor(
  "Worker to preserve partial funds after the create request times out",
  async () => {
    const state = await corePool.query<{
      command_status: string;
      attempt_status: string;
      operation_status: string;
      job_status: string;
      receipts: string;
    }>(
      `SELECT
         command.status AS command_status,
         attempt.status AS attempt_status,
         operation.status AS operation_status,
         job.status AS job_status,
         (
           SELECT count(*)::text
           FROM fund_receipts receipt
           WHERE receipt.reported_add_funds_attempt_id = attempt.id
             AND receipt.disposition = 'unclaimed'
         ) AS receipts
       FROM add_funds_commands command
       JOIN add_funds_attempts attempt ON attempt.id = command.add_funds_attempt_id
       JOIN provider_operations operation
         ON operation.subject_type = 'add_funds'
        AND operation.subject_id = attempt.id
       JOIN durable_jobs job
         ON job.job_type = 'add_funds.start'
        AND job.payload->>'addFundsAttemptId' = attempt.id::text
       WHERE command.id = $1`,
      [callbackBeforeTimeout.command.commandId],
    );
    return state.rows[0];
  },
  (state) =>
    state?.command_status === "manual" &&
    state.attempt_status === "unknown" &&
    state.operation_status === "unknown" &&
    state.job_status === "completed" &&
    state.receipts === "1",
);
const preservedCallbackBeforeTimeout = await request<AddFundsStatus>(
  `/api/v1/billing/add-funds/${callbackBeforeTimeout.command.commandId}`,
);
assert.equal(preservedCallbackBeforeTimeout.status, "manual");
assert.match(
  String(preservedCallbackBeforeTimeout.result?.reason),
  /does not match the Add Funds snapshot/,
);

const recoveryMe = await request<{ id: string; clientAccountId: string }>("/api/v1/auth/me");
await corePool.query(`
  CREATE OR REPLACE FUNCTION integration_delay_add_funds_security()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.job_type = 'add_funds.start' THEN
      NEW.available_at = now() + interval '1 hour';
    END IF;
    RETURN NEW;
  END;
  $$;
  DROP TRIGGER IF EXISTS integration_delay_add_funds_security ON durable_jobs;
  CREATE TRIGGER integration_delay_add_funds_security
  BEFORE INSERT ON durable_jobs
  FOR EACH ROW EXECUTE FUNCTION integration_delay_add_funds_security();
`);
const disabledPolicyQuote = await createAddFundsQuote("5000", "card");
const disabledPolicy = await startAddFunds(disabledPolicyQuote.quoteId, "success");
const disabledPolicyOperation = await corePool.query<{ id: string }>(
  `UPDATE provider_operations
   SET status = 'running', attempt_count = 1
   WHERE subject_type = 'add_funds' AND subject_id = $1
   RETURNING id`,
  [disabledPolicy.command.addFundsAttemptId],
);
const disabledPolicyOperationId = disabledPolicyOperation.rows[0]?.id;
assert.ok(disabledPolicyOperationId);
await corePool.query(
  `UPDATE add_funds_attempts
   SET status = 'processing'
   WHERE id = $1`,
  [disabledPolicy.command.addFundsAttemptId],
);
await corePool.query("UPDATE add_funds_policies SET enabled = false WHERE currency = 'USD'");
const disabledPolicyReceipt = await submitPaymentFact({
  eventId: `add-funds-policy-disabled:${randomUUID()}`,
  providerOperationId: disabledPolicyOperationId,
  paymentAttemptId: disabledPolicy.command.addFundsAttemptId,
  externalPaymentId: `mock-add-funds-disabled-policy-${randomUUID()}`,
  status: "succeeded",
  amountMinor: "5175",
  currency: "USD",
  occurredAt: new Date().toISOString(),
});
assert.equal(disabledPolicyReceipt.status, 202);
assert.equal(disabledPolicyReceipt.body.status, "unclaimed");
const disabledPolicyManual = await waitForAddFunds(
  disabledPolicy.command.commandId,
  "manual",
);
assert.match(String(disabledPolicyManual.result?.reason), /policy was paused/);
await corePool.query("UPDATE add_funds_policies SET enabled = true WHERE currency = 'USD'");
await corePool.query(
  `UPDATE durable_jobs
   SET status = 'completed'
   WHERE job_type = 'add_funds.start'
     AND payload->>'addFundsAttemptId' = $1`,
  [disabledPolicy.command.addFundsAttemptId],
);

const revokedMembershipQuote = await createAddFundsQuote("5000", "card");
const revokedMembership = await startAddFunds(revokedMembershipQuote.quoteId, "success");
const revokedMembershipOperation = await corePool.query<{ id: string }>(
  `UPDATE provider_operations
   SET status = 'running', attempt_count = 1
   WHERE subject_type = 'add_funds' AND subject_id = $1
   RETURNING id`,
  [revokedMembership.command.addFundsAttemptId],
);
const revokedMembershipOperationId = revokedMembershipOperation.rows[0]?.id;
assert.ok(revokedMembershipOperationId);
await corePool.query(
  `UPDATE add_funds_attempts SET status = 'processing' WHERE id = $1`,
  [revokedMembership.command.addFundsAttemptId],
);
const revocationClient = await corePool.connect();
try {
  await revocationClient.query("BEGIN");
  await revocationClient.query(
    `SELECT role
     FROM client_memberships
     WHERE user_id = $1 AND client_account_id = $2
     FOR UPDATE`,
    [recoveryMe.id, recoveryMe.clientAccountId],
  );
  const callbackPromise = submitPaymentFact({
    eventId: `add-funds-membership-revoked:${randomUUID()}`,
    providerOperationId: revokedMembershipOperationId,
    paymentAttemptId: revokedMembership.command.addFundsAttemptId,
    externalPaymentId: `mock-add-funds-revoked-membership-${randomUUID()}`,
    status: "succeeded",
    amountMinor: "5175",
    currency: "USD",
    occurredAt: new Date().toISOString(),
  });
  await waitFor(
    "Add Funds callback to wait on the Membership authorization lock",
    async () => {
      const blocked = await corePool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
           AND query LIKE '%FROM client_memberships%'`,
      );
      return Number(blocked.rows[0]?.count ?? "0");
    },
    (count) => count > 0,
  );
  await revocationClient.query(
    `UPDATE client_memberships
     SET removed_at = now()
     WHERE user_id = $1 AND client_account_id = $2`,
    [recoveryMe.id, recoveryMe.clientAccountId],
  );
  await revocationClient.query("COMMIT");
  const revokedReceipt = await callbackPromise;
  assert.equal(revokedReceipt.status, 202);
  assert.equal(revokedReceipt.body.status, "unclaimed");
} catch (error) {
  await revocationClient.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  revocationClient.release();
}
await corePool.query(
  `UPDATE client_memberships
   SET removed_at = NULL
   WHERE user_id = $1 AND client_account_id = $2`,
  [recoveryMe.id, recoveryMe.clientAccountId],
);
const revokedMembershipManual = await waitForAddFunds(
  revokedMembership.command.commandId,
  "manual",
);
assert.match(String(revokedMembershipManual.result?.reason), /eligibility was revoked/);
await corePool.query(
  `UPDATE durable_jobs
   SET status = 'completed'
   WHERE job_type = 'add_funds.start'
     AND payload->>'addFundsAttemptId' = $1`,
  [revokedMembership.command.addFundsAttemptId],
);

const expiryBoundaryQuote = await createAddFundsQuote("5000", "card");
const expiryBoundary = await startAddFunds(expiryBoundaryQuote.quoteId, "success");
const expiryBoundaryOperation = await corePool.query<{ id: string }>(
  `UPDATE provider_operations
   SET status = 'running', attempt_count = 1
   WHERE subject_type = 'add_funds' AND subject_id = $1
   RETURNING id`,
  [expiryBoundary.command.addFundsAttemptId],
);
const expiryBoundaryOperationId = expiryBoundaryOperation.rows[0]?.id;
assert.ok(expiryBoundaryOperationId);
const exactExpiry = new Date(Date.now() + 60_000);
await corePool.query(
  `UPDATE add_funds_attempts
   SET status = 'processing', expires_at = $2
   WHERE id = $1`,
  [expiryBoundary.command.addFundsAttemptId, exactExpiry],
);
const expiryBoundaryReceipt = await submitPaymentFact({
  eventId: `add-funds-expiry-boundary:${randomUUID()}`,
  providerOperationId: expiryBoundaryOperationId,
  paymentAttemptId: expiryBoundary.command.addFundsAttemptId,
  externalPaymentId: `mock-add-funds-expiry-boundary-${randomUUID()}`,
  status: "succeeded",
  amountMinor: "5175",
  currency: "USD",
  occurredAt: exactExpiry.toISOString(),
});
assert.equal(expiryBoundaryReceipt.status, 202);
assert.equal(expiryBoundaryReceipt.body.status, "unclaimed");
const expiryBoundaryManual = await waitForAddFunds(
  expiryBoundary.command.commandId,
  "manual",
);
assert.match(
  String(expiryBoundaryManual.result?.reason),
  /settlement occurred after the Add Funds attempt expired/,
);
await corePool.query(
  `UPDATE durable_jobs
   SET status = 'completed'
   WHERE job_type = 'add_funds.start'
     AND payload->>'addFundsAttemptId' = $1`,
  [expiryBoundary.command.addFundsAttemptId],
);

const expiredKnownUnsentQuote = await createAddFundsQuote("5000", "card");
const expiredKnownUnsent = await startAddFunds(expiredKnownUnsentQuote.quoteId, "success");
await corePool.query(
  `UPDATE add_funds_attempts
   SET expires_at = now() - interval '1 second'
   WHERE id = $1`,
  [expiredKnownUnsent.command.addFundsAttemptId],
);
await corePool.query(
  `UPDATE durable_jobs
   SET available_at = now()
   WHERE job_type = 'add_funds.start'
     AND payload->>'addFundsAttemptId' = $1`,
  [expiredKnownUnsent.command.addFundsAttemptId],
);
await waitForAddFunds(expiredKnownUnsent.command.commandId, "failed");
const expiredKnownUnsentProviderCalls = await providerPool.query<{ count: string }>(
  `SELECT count(*)::text AS count
   FROM mock_payment_operations
   WHERE payment_attempt_id = $1`,
  [expiredKnownUnsent.command.addFundsAttemptId],
);
assert.equal(expiredKnownUnsentProviderCalls.rows[0]?.count, "0");
await corePool.query(`
  DROP TRIGGER IF EXISTS integration_delay_add_funds_security ON durable_jobs;
  DROP FUNCTION IF EXISTS integration_delay_add_funds_security();
`);
const beforeCapRace = await corePool.query<{ balance_minor: string; unclaimed: string }>(
  `SELECT
     (SELECT COALESCE(sum(transaction.credit_minor - transaction.debit_minor), 0)::text
        FROM credit_accounts account
        LEFT JOIN credit_transactions transaction
          ON transaction.credit_account_id = account.id
       WHERE account.client_account_id = $1 AND account.currency = 'USD') AS balance_minor,
     (SELECT count(*)::text
        FROM fund_receipts
       WHERE client_account_id = $1
         AND reported_add_funds_attempt_id IS NOT NULL
         AND disposition = 'unclaimed') AS unclaimed`,
  [recoveryMe.clientAccountId],
);
assert.equal(beforeCapRace.rows[0]?.balance_minor, "10000");
assert.equal(beforeCapRace.rows[0]?.unclaimed, "10");

await corePool.query(`
  CREATE OR REPLACE FUNCTION integration_delay_add_funds_start()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.job_type = 'add_funds.start' THEN
      NEW.available_at = now() + interval '1 hour';
    END IF;
    RETURN NEW;
  END;
  $$;
  DROP TRIGGER IF EXISTS integration_delay_add_funds_start ON durable_jobs;
  CREATE TRIGGER integration_delay_add_funds_start
  BEFORE INSERT ON durable_jobs
  FOR EACH ROW EXECUTE FUNCTION integration_delay_add_funds_start();
`);
const capRaceQuote = await createAddFundsQuote("5000", "card");
const capRace = await startAddFunds(capRaceQuote.quoteId, "success");
const adjustmentClient = await corePool.connect();
try {
  await adjustmentClient.query("BEGIN");
  const account = await adjustmentClient.query<{ id: string }>(
    `SELECT id
     FROM credit_accounts
     WHERE client_account_id = $1 AND currency = 'USD'
     FOR UPDATE`,
    [recoveryMe.clientAccountId],
  );
  const accountId = account.rows[0]?.id;
  assert.ok(accountId);
  const adjustmentId = randomUUID();
  await adjustmentClient.query(
    `INSERT INTO credit_transactions(
       id, credit_account_id, kind, credit_minor, debit_minor,
       source_type, source_id, actor_type, reason,
       idempotency_key, request_fingerprint
     ) VALUES (
       $1, $2, 'manual_adjustment', 986000, 0,
       'integration_cap_race', $3, 'system',
       'Synthetic balance movement while Add Funds is in flight', $4, $5
     )`,
    [
      adjustmentId,
      accountId,
      randomUUID(),
      `integration-cap-race:${adjustmentId}`,
      createHash("sha256").update(adjustmentId).digest("hex"),
    ],
  );
  const journal = await adjustmentClient.query<{ id: string }>(
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES ('integration_cap_race', $1, 'USD', 'Synthetic in-flight balance movement')
     RETURNING id`,
    [adjustmentId],
  );
  await adjustmentClient.query(
    `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
     VALUES
       ($1, 'accounts_receivable', 986000, 0),
       ($1, 'client_credit_liability', 0, 986000)`,
    [journal.rows[0]?.id],
  );
  await adjustmentClient.query("COMMIT");
} catch (error) {
  await adjustmentClient.query("ROLLBACK");
  throw error;
} finally {
  adjustmentClient.release();
}
await corePool.query(
  `UPDATE durable_jobs
   SET available_at = now()
   WHERE job_type = 'add_funds.start'
     AND payload->>'addFundsAttemptId' = $1`,
  [capRace.command.addFundsAttemptId],
);
const capRaceRejected = await waitForAddFunds(capRace.command.commandId, "failed");
assert.match(String(capRaceRejected.result?.reason), /balance cap/);
const capRaceProviderCalls = await providerPool.query<{ count: string }>(
  `SELECT count(*)::text AS count
   FROM mock_payment_operations
   WHERE payment_attempt_id = $1`,
  [capRace.command.addFundsAttemptId],
);
assert.equal(capRaceProviderCalls.rows[0]?.count, "0");
await corePool.query(`
  DROP TRIGGER IF EXISTS integration_delay_add_funds_start ON durable_jobs;
  DROP FUNCTION IF EXISTS integration_delay_add_funds_start();
`);
const afterCapRace = await corePool.query<{
  balance_minor: string;
  unclaimed: string;
  add_funds_credits: string;
}>(
  `SELECT
     (SELECT COALESCE(sum(transaction.credit_minor - transaction.debit_minor), 0)::text
        FROM credit_accounts account
        LEFT JOIN credit_transactions transaction
          ON transaction.credit_account_id = account.id
       WHERE account.client_account_id = $1 AND account.currency = 'USD') AS balance_minor,
     (SELECT count(*)::text
        FROM fund_receipts
       WHERE client_account_id = $1
         AND reported_add_funds_attempt_id IS NOT NULL
         AND disposition = 'unclaimed') AS unclaimed,
     (SELECT count(*)::text
        FROM credit_transactions transaction
        JOIN credit_accounts account ON account.id = transaction.credit_account_id
       WHERE account.client_account_id = $1 AND transaction.kind = 'add_funds')
       AS add_funds_credits`,
  [recoveryMe.clientAccountId],
);
assert.equal(afterCapRace.rows[0]?.balance_minor, "996000");
assert.equal(afterCapRace.rows[0]?.unclaimed, "10");
assert.equal(afterCapRace.rows[0]?.add_funds_credits, "2");

const resolutionReceiptId = String(preservedCallbackBeforeReject.result?.receiptId ?? "");
assert.match(resolutionReceiptId, /^[0-9a-f-]{36}$/);
const resolutionOrder = await createOrder(automaticPrice.id, legal);
const recoveryCookie = cookie;
cookie = staffCookie;

const unclaimedList = await request<{
  items: Array<{
    receiptId: string;
    clientAccountId: string;
    remainingMinor: string;
    currency: string;
  }>;
}>("/api/v1/admin/funds/unclaimed");
const listedReceipt = unclaimedList.items.find((item) => item.receiptId === resolutionReceiptId);
assert.ok(listedReceipt);
assert.equal(listedReceipt.clientAccountId, recoveryMe.clientAccountId);
assert.equal(listedReceipt.currency, "USD");
const allocationAmount = resolutionOrder.invoice.dueMinor;
assert.ok(BigInt(allocationAmount) > 0n);
assert.ok(BigInt(listedReceipt.remainingMinor) > BigInt(allocationAmount));
const allocationKey = randomUUID();
const allocationBody = {
  action: "allocate_invoice",
  amountMinor: allocationAmount,
  invoiceId: resolutionOrder.invoice.id,
  reason: "Synthetic operator allocation to the matching unpaid invoice",
  idempotencyKey: allocationKey,
};
await corePool.query(
  "UPDATE reauth_grants SET invalidated_at = now() WHERE user_id = $1 AND invalidated_at IS NULL",
  [staffMe.id],
);
await request(
  `/api/v1/admin/funds/${resolutionReceiptId}/resolutions`,
  { method: "POST", body: JSON.stringify(allocationBody) },
  403,
);
await request(
  "/api/v1/auth/reauth",
  { method: "POST", body: JSON.stringify({ password }) },
  200,
);
await request(
  `/api/v1/admin/funds/${resolutionReceiptId}/resolutions`,
  {
    method: "POST",
    body: JSON.stringify({
      ...allocationBody,
      invoiceId: automaticOrder.invoice.id,
      idempotencyKey: randomUUID(),
    }),
  },
  409,
);
const allocatedUnclaimed = await request<{
  resolutionId: string;
  remainingMinor: string;
  invoiceStatus: string;
  replayed: boolean;
}>(
  `/api/v1/admin/funds/${resolutionReceiptId}/resolutions`,
  { method: "POST", body: JSON.stringify(allocationBody) },
  201,
);
assert.equal(allocatedUnclaimed.invoiceStatus, "paid");
assert.equal(allocatedUnclaimed.replayed, false);
const allocationReplay = await request<{
  resolutionId: string;
  replayed: boolean;
}>(
  `/api/v1/admin/funds/${resolutionReceiptId}/resolutions`,
  { method: "POST", body: JSON.stringify(allocationBody) },
  200,
);
assert.equal(allocationReplay.resolutionId, allocatedUnclaimed.resolutionId);
assert.equal(allocationReplay.replayed, true);
const allocationAfterReloadKey = randomUUID();
const allocationAfterReload = await request<{
  resolutionId: string;
  replayed: boolean;
}>(
  `/api/v1/admin/funds/${resolutionReceiptId.toUpperCase()}/resolutions`,
  {
    method: "POST",
    body: JSON.stringify({
      ...allocationBody,
      invoiceId: resolutionOrder.invoice.id.toUpperCase(),
      idempotencyKey: allocationAfterReloadKey,
    }),
  },
  200,
);
assert.equal(allocationAfterReload.resolutionId, allocatedUnclaimed.resolutionId);
assert.equal(allocationAfterReload.replayed, true);
const allocationAliasConflict = await request<{ code: string }>(
  `/api/v1/admin/funds/${resolutionReceiptId}/resolutions`,
  {
    method: "POST",
    body: JSON.stringify({
      ...allocationBody,
      amountMinor: "1",
      idempotencyKey: allocationAfterReloadKey,
    }),
  },
  409,
);
assert.equal(allocationAliasConflict.code, "IDEMPOTENCY_CONFLICT");
await request(
  `/api/v1/admin/funds/${resolutionReceiptId}/resolutions`,
  {
    method: "POST",
    body: JSON.stringify({ ...allocationBody, amountMinor: "1" }),
  },
  409,
);
const creditResolutionKey = randomUUID();
const competingCreditResolutionKey = randomUUID();
const creditResolutionBody = {
  action: "convert_to_credit",
  amountMinor: allocatedUnclaimed.remainingMinor,
  invoiceId: null,
  reason: "Synthetic operator conversion of the remaining verified funds",
};
const competingCreditResolutions = await Promise.all([
  rawCoreRequest(`/api/v1/admin/funds/${resolutionReceiptId}/resolutions`, {
    method: "POST",
    body: JSON.stringify({
      ...creditResolutionBody,
      idempotencyKey: creditResolutionKey,
    }),
  }),
  rawCoreRequest(`/api/v1/admin/funds/${resolutionReceiptId}/resolutions`, {
    method: "POST",
    body: JSON.stringify({
      ...creditResolutionBody,
      idempotencyKey: competingCreditResolutionKey,
    }),
  }),
]);
assert.deepEqual(
  competingCreditResolutions.map((response) => response.status).sort(),
  [200, 201],
);
const successfulCreditResolution = competingCreditResolutions.find(
  (response) => response.status === 201,
);
assert.ok(successfulCreditResolution);
const replayedCompetingCreditResolution = competingCreditResolutions.find(
  (response) => response.status === 200,
);
assert.ok(replayedCompetingCreditResolution);
assert.equal(
  replayedCompetingCreditResolution.body.resolutionId,
  successfulCreditResolution.body.resolutionId,
);
assert.equal(replayedCompetingCreditResolution.body.replayed, true);
const successfulCreditResolutionKey =
  successfulCreditResolution === competingCreditResolutions[0]
    ? creditResolutionKey
    : competingCreditResolutionKey;
const creditResolution = successfulCreditResolution.body as {
  resolutionId: string;
  remainingMinor: string;
  creditBalanceMinor: string;
  replayed: boolean;
};
assert.equal(creditResolution.remainingMinor, "0");
assert.equal(creditResolution.replayed, false);
assert.equal(
  creditResolution.creditBalanceMinor,
  (996000n + BigInt(allocatedUnclaimed.remainingMinor)).toString(),
);
const creditResolutionReplay = await request<{
  resolutionId: string;
  replayed: boolean;
}>(
  `/api/v1/admin/funds/${resolutionReceiptId}/resolutions`,
  {
    method: "POST",
    body: JSON.stringify({
      ...creditResolutionBody,
      idempotencyKey: successfulCreditResolutionKey,
    }),
  },
  200,
);
assert.equal(creditResolutionReplay.resolutionId, creditResolution.resolutionId);
assert.equal(creditResolutionReplay.replayed, true);
const resolvedReceiptFacts = await corePool.query<{
  allocated_minor: string;
  amount_minor: string;
  disposition: string;
  resolutions: string;
  requests: string;
  allocations: string;
  journals: string;
}>(
  `SELECT
     receipt.allocated_minor::text,
     receipt.amount_minor::text,
     receipt.disposition,
     (
       SELECT count(*)::text
       FROM fund_receipt_resolutions resolution
       WHERE resolution.fund_receipt_id = receipt.id
     ) AS resolutions,
     (
       SELECT count(*)::text
       FROM fund_receipt_resolution_requests request
       WHERE request.fund_receipt_id = receipt.id
     ) AS requests,
     (
       SELECT count(*)::text
       FROM fund_receipt_allocations allocation
       WHERE allocation.fund_receipt_id = receipt.id
     ) AS allocations,
     (
       SELECT count(*)::text
       FROM ledger_journals journal
       JOIN fund_receipt_resolutions resolution ON resolution.id = journal.source_id
       WHERE journal.source_type = 'fund_receipt_resolution'
         AND resolution.fund_receipt_id = receipt.id
     ) AS journals
   FROM fund_receipts receipt
   WHERE receipt.id = $1`,
  [resolutionReceiptId],
);
assert.equal(
  resolvedReceiptFacts.rows[0]?.allocated_minor,
  resolvedReceiptFacts.rows[0]?.amount_minor,
);
assert.equal(resolvedReceiptFacts.rows[0]?.disposition, "allocated");
assert.equal(resolvedReceiptFacts.rows[0]?.resolutions, "2");
assert.equal(resolvedReceiptFacts.rows[0]?.requests, "4");
assert.equal(resolvedReceiptFacts.rows[0]?.allocations, "1");
assert.equal(resolvedReceiptFacts.rows[0]?.journals, "2");
const noLongerUnclaimed = await request<{
  items: Array<{ receiptId: string }>;
}>("/api/v1/admin/funds/unclaimed");
assert.equal(
  noLongerUnclaimed.items.some((item) => item.receiptId === resolutionReceiptId),
  false,
);

cookie = recoveryCookie;
const activeResolutionOrder = await waitFor(
  "invoice allocation from unclaimed funds to continue service fulfillment",
  () => request<OrderDetail>(`/api/v1/orders/${resolutionOrder.order.id}`),
  (value) => value.service.status === "active",
);
assert.equal(activeResolutionOrder.invoice.status, "paid");
assert.equal(activeResolutionOrder.invoice.dueMinor, "0");
cookie = staffCookie;

const lockOrderReceipt = await corePool.query<{ id: string }>(
  `SELECT id
   FROM fund_receipts
   WHERE provider_installation_id = 'mock-payment-v1'
     AND external_payment_id = $1`,
  [mismatchExternalId],
);
const lockOrderReceiptId = lockOrderReceipt.rows[0]?.id;
assert.ok(lockOrderReceiptId);
const lockOrderEventId = `lock-order:${randomUUID()}`;
let lockOrderRace:
  | [
      { status: number; body: Record<string, unknown> },
      { status: number; body: Record<string, unknown> },
    ]
  | undefined;
await installProviderInboxReceiptLockGate();
const receiptGateClient = await corePool.connect();
let receiptGateOpen = false;
try {
  await receiptGateClient.query("BEGIN");
  receiptGateOpen = true;
  await receiptGateClient.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [providerInboxReceiptLockGate],
  );
  const repeatedProviderFact = submitPaymentFact({
    eventId: lockOrderEventId,
    providerOperationId: mismatchRecords.operation_id,
    paymentAttemptId: mismatchCommand.paymentAttemptId,
    externalPaymentId: mismatchExternalId,
    status: "succeeded",
    amountMinor: mismatchAmountMinor,
    currency: mismatchRecords.currency,
    occurredAt: new Date().toISOString(),
  });
  await waitFor(
    "Provider callback to hold the invoice lock before receipt reconciliation",
    async () => {
      const result = await corePool.query<{ waiting: string }>(
        `SELECT count(*)::text AS waiting
         FROM pg_stat_activity
         WHERE state = 'active'
           AND wait_event_type = 'Lock'
           AND query ILIKE '%INSERT INTO provider_inbox%'`,
      );
      return result.rows[0]?.waiting ?? "0";
    },
    (waiting) => BigInt(waiting) > 0n,
  );
  const concurrentFundAllocation = rawCoreRequest(
    `/api/v1/admin/funds/${lockOrderReceiptId}/resolutions`,
    {
      method: "POST",
      body: JSON.stringify({
        action: "allocate_invoice",
        amountMinor: mismatchOrder.invoice.dueMinor,
        invoiceId: mismatchOrder.invoice.id,
        reason: "Synthetic concurrent allocation while a duplicate Provider fact reconciles",
        idempotencyKey: randomUUID(),
      }),
    },
  );
  await waitFor(
    "staff allocation to wait for the Provider-held invoice before locking the receipt",
    async () => {
      const result = await corePool.query<{ waiting: string }>(
        `SELECT count(*)::text AS waiting
         FROM pg_stat_activity
         WHERE state = 'active'
           AND wait_event_type = 'Lock'
           AND query ILIKE '%SELECT id, client_account_id, currency, total_minor::text%'
           AND query ILIKE '%FROM invoices%'
           AND query ILIKE '%FOR UPDATE%'`,
      );
      return result.rows[0]?.waiting ?? "0";
    },
    (waiting) => BigInt(waiting) > 0n,
  );
  const unlockedReceipt = await corePool.query<{ id: string }>(
    `SELECT id
     FROM fund_receipts
     WHERE id = $1
     FOR UPDATE NOWAIT`,
    [lockOrderReceiptId],
  );
  assert.equal(unlockedReceipt.rows[0]?.id, lockOrderReceiptId);

  await receiptGateClient.query("COMMIT");
  receiptGateOpen = false;
  lockOrderRace = await Promise.all([repeatedProviderFact, concurrentFundAllocation]);
} finally {
  if (receiptGateOpen) {
    await receiptGateClient.query("ROLLBACK");
  }
  receiptGateClient.release();
  await dropProviderInboxReceiptLockGate();
}
assert.ok(lockOrderRace);
const [repeatedProviderFact, concurrentFundAllocation] = lockOrderRace;
assert.equal(repeatedProviderFact.status, 200);
assert.equal(repeatedProviderFact.body.duplicate, true);
assert.equal(concurrentFundAllocation.status, 201);
const lockOrderFacts = await corePool.query<{
  receipt_allocated_minor: string;
  invoice_allocated_minor: string;
  resolutions: string;
  allocations: string;
}>(
  `SELECT
     receipt.allocated_minor::text AS receipt_allocated_minor,
     totals.allocated_minor::text AS invoice_allocated_minor,
     (
       SELECT count(*)::text
       FROM fund_receipt_resolutions resolution
       WHERE resolution.fund_receipt_id = receipt.id
     ) AS resolutions,
     (
       SELECT count(*)::text
       FROM fund_receipt_allocations allocation
       WHERE allocation.fund_receipt_id = receipt.id
     ) AS allocations
   FROM fund_receipts receipt
   JOIN payment_attempts payment ON payment.id = receipt.reported_payment_attempt_id
   JOIN invoice_allocation_totals totals ON totals.invoice_id = payment.invoice_id
   WHERE receipt.id = $1`,
  [lockOrderReceiptId],
);
assert.equal(lockOrderFacts.rows[0]?.receipt_allocated_minor, mismatchOrder.invoice.dueMinor);
assert.equal(lockOrderFacts.rows[0]?.invoice_allocated_minor, mismatchOrder.invoice.dueMinor);
assert.equal(lockOrderFacts.rows[0]?.resolutions, "1");
assert.equal(lockOrderFacts.rows[0]?.allocations, "1");

await installPaymentStartDelay();
try {
  const accountLockOrder = await createOrder(automaticPrice.id, legal);
  const accountLockQuote = await createPaymentQuote(accountLockOrder.invoice.id, "usdt", false);
  const accountLockCommand = await request<PaymentCommand>(
    `/api/v1/invoices/${accountLockOrder.invoice.id}/payments`,
    {
      method: "POST",
      body: JSON.stringify({
        quoteId: accountLockQuote.quoteId,
        scenario: "success",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  assert.ok(accountLockCommand.paymentAttemptId);
  const accountLockRecords = await readPaymentRecords(accountLockCommand.commandId);
  await corePool.query("UPDATE payment_attempts SET status = 'processing' WHERE id = $1", [
    accountLockCommand.paymentAttemptId,
  ]);
  await corePool.query(
    `UPDATE provider_operations
     SET status = 'running', attempt_count = 1
     WHERE id = $1`,
    [accountLockRecords.operation_id],
  );
  await corePool.query(
    `UPDATE durable_jobs
     SET status = 'completed', locked_at = NULL, locked_by = NULL
     WHERE job_type = 'payment.start'
       AND payload->>'paymentAttemptId' = $1`,
    [accountLockCommand.paymentAttemptId],
  );

  const accountLockUnclaimedExternalId = `account-lock-source-${randomUUID()}`;
  const accountLockUnclaimedAmount = (
    BigInt(accountLockRecords.amount_minor) + 1n
  ).toString();
  const accountLockUnclaimed = await submitPaymentFact({
    eventId: `account-lock-source:${randomUUID()}`,
    providerOperationId: accountLockRecords.operation_id,
    paymentAttemptId: accountLockCommand.paymentAttemptId,
    externalPaymentId: accountLockUnclaimedExternalId,
    status: "succeeded",
    amountMinor: accountLockUnclaimedAmount,
    currency: accountLockRecords.currency,
    occurredAt: new Date().toISOString(),
  });
  assert.equal(accountLockUnclaimed.status, 202);
  assert.equal(accountLockUnclaimed.body.status, "unclaimed");
  const accountLockReceiptId = String(accountLockUnclaimed.body.receiptId ?? "");
  assert.match(accountLockReceiptId, /^[0-9a-f-]{36}$/);

  await request(
    "/api/v1/auth/reauth",
    { method: "POST", body: JSON.stringify({ password }) },
    200,
  );
  await installProviderInboxAccountLockGate();
  const accountGateClient = await corePool.connect();
  let accountGateOpen = false;
  let accountLockRace:
    | [
        { status: number; body: Record<string, unknown> },
        { status: number; body: Record<string, unknown> },
      ]
    | undefined;
  try {
    await accountGateClient.query("BEGIN");
    accountGateOpen = true;
    await accountGateClient.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [providerInboxAccountLockGate],
    );
    const providerSettlement = submitPaymentFact({
      eventId: `account-lock-order:${randomUUID()}`,
      providerOperationId: accountLockRecords.operation_id,
      paymentAttemptId: accountLockCommand.paymentAttemptId,
      externalPaymentId: `account-lock-settlement-${randomUUID()}`,
      status: "succeeded",
      amountMinor: accountLockRecords.amount_minor,
      currency: accountLockRecords.currency,
      occurredAt: new Date().toISOString(),
    });
    await waitFor(
      "successful Provider callback to hold the invoice before account settlement",
      async () => {
        const result = await corePool.query<{ waiting: string }>(
          `SELECT count(*)::text AS waiting
           FROM pg_stat_activity
           WHERE state = 'active'
             AND wait_event_type = 'Lock'
             AND query ILIKE '%INSERT INTO provider_inbox%'`,
        );
        return result.rows[0]?.waiting ?? "0";
      },
      (waiting) => BigInt(waiting) > 0n,
    );
    const staffAllocation = rawCoreRequest(
      `/api/v1/admin/funds/${accountLockReceiptId}/resolutions`,
      {
        method: "POST",
        body: JSON.stringify({
          action: "allocate_invoice",
          amountMinor: accountLockOrder.invoice.dueMinor,
          invoiceId: accountLockOrder.invoice.id,
          reason: "Synthetic allocation competing with a successful Provider settlement",
          idempotencyKey: randomUUID(),
        }),
      },
    );
    await waitFor(
      "staff allocation to wait for the Provider-held invoice before locking the account",
      async () => {
        const result = await corePool.query<{ waiting: string }>(
          `SELECT count(*)::text AS waiting
           FROM pg_stat_activity
           WHERE state = 'active'
             AND wait_event_type = 'Lock'
             AND query ILIKE '%SELECT id, client_account_id, currency, total_minor::text%'
             AND query ILIKE '%FROM invoices%'
             AND query ILIKE '%FOR UPDATE%'`,
        );
        return result.rows[0]?.waiting ?? "0";
      },
      (waiting) => BigInt(waiting) > 0n,
    );
    const unlockedStaffAccount = await corePool.query<{ id: string }>(
      `SELECT id
       FROM client_accounts
       WHERE id = $1
       FOR UPDATE NOWAIT`,
      [staffMe.clientAccountId],
    );
    assert.equal(unlockedStaffAccount.rows[0]?.id, staffMe.clientAccountId);

    await accountGateClient.query("COMMIT");
    accountGateOpen = false;
    accountLockRace = await Promise.all([providerSettlement, staffAllocation]);
  } finally {
    if (accountGateOpen) {
      await accountGateClient.query("ROLLBACK");
    }
    accountGateClient.release();
    await dropProviderInboxAccountLockGate();
  }
  assert.ok(accountLockRace);
  const [successfulProviderSettlement, staleStaffAllocation] = accountLockRace;
  assert.equal(successfulProviderSettlement.status, 202);
  assert.equal(successfulProviderSettlement.body.status, "succeeded");
  assert.equal(staleStaffAllocation.status, 409);
  assert.equal(staleStaffAllocation.body.code, "INVOICE_ALLOCATION_EXCEEDS_DUE");
  const accountLockFinal = await corePool.query<{
    source_allocated_minor: string;
    source_resolutions: string;
    invoice_allocated_minor: string;
  }>(
    `SELECT
       receipt.allocated_minor::text AS source_allocated_minor,
       (
         SELECT count(*)::text
         FROM fund_receipt_resolutions resolution
         WHERE resolution.fund_receipt_id = receipt.id
       ) AS source_resolutions,
       totals.allocated_minor::text AS invoice_allocated_minor
     FROM fund_receipts receipt
     JOIN payment_attempts payment ON payment.id = receipt.reported_payment_attempt_id
     JOIN invoice_allocation_totals totals ON totals.invoice_id = payment.invoice_id
     WHERE receipt.id = $1`,
    [accountLockReceiptId],
  );
  assert.equal(accountLockFinal.rows[0]?.source_allocated_minor, "0");
  assert.equal(accountLockFinal.rows[0]?.source_resolutions, "0");
  assert.equal(accountLockFinal.rows[0]?.invoice_allocated_minor, accountLockRecords.amount_minor);
} finally {
  await dropPaymentStartDelay();
}

await request(
  "/api/v1/auth/reauth",
  { method: "POST", body: JSON.stringify({ password }) },
  200,
);
const refundOrder = await createOrder(automaticPrice.id, legal);
const paidRefundOrder = await pay(refundOrder, "success");
assert.equal(paidRefundOrder.invoice.status, "paid");
const activeRefundOrder = await waitFor(
  "refund source service activation",
  () => request<OrderDetail>(`/api/v1/orders/${refundOrder.order.id}`),
  (current) => current.service.status === "active",
);
assert.equal(activeRefundOrder.service.status, "active");
const refundCandidates = await request<{ items: RefundCandidate[] }>(
  "/api/v1/admin/refund-candidates",
);
const refundCandidate = refundCandidates.items.find(
  (candidate) => candidate.invoiceId === refundOrder.invoice.id,
);
assert.ok(refundCandidate, "the paid invoice receipt must be available for a manual refund");
assert.ok(refundCandidate.referenceRefundMinor, "an active single service should have a reference");
const refundableReceiptId = refundCandidate.receiptId;
const refundSourceBefore = await corePool.query<{
  payment_status: string;
  receipt_amount_minor: string;
  receipt_allocated_minor: string;
  allocation_amount_minor: string;
  invoice_total_minor: string;
  service_status: string;
  service_term_start: Date;
  service_term_end: Date;
  credit_balance_minor: string;
}>(
  `SELECT
     payment.status AS payment_status,
     receipt.amount_minor::text AS receipt_amount_minor,
     receipt.allocated_minor::text AS receipt_allocated_minor,
     allocation.amount_minor::text AS allocation_amount_minor,
     invoice.total_minor::text AS invoice_total_minor,
     service.status AS service_status,
     service.term_start AS service_term_start,
     service.term_end AS service_term_end,
     COALESCE((
       SELECT sum(transaction.credit_minor - transaction.debit_minor)
       FROM credit_accounts account
       LEFT JOIN credit_transactions transaction ON transaction.credit_account_id = account.id
       WHERE account.client_account_id = invoice.client_account_id
         AND account.currency = invoice.currency
     ), 0)::text AS credit_balance_minor
   FROM fund_receipts receipt
   JOIN payment_attempts payment ON payment.id = receipt.reported_payment_attempt_id
   JOIN payment_allocations allocation ON allocation.payment_attempt_id = payment.id
   JOIN invoices invoice ON invoice.id = allocation.invoice_id
   JOIN orders order_record ON order_record.id = invoice.order_id
   JOIN order_items item ON item.order_id = order_record.id
   JOIN services service ON service.order_item_id = item.id
   WHERE receipt.id = $1`,
  [refundableReceiptId],
);
const refundSourceSnapshot = refundSourceBefore.rows[0];
assert.ok(refundSourceSnapshot);

const thirdPartyRefund = await rawCoreRequest(
  `/api/v1/admin/invoices/${refundOrder.invoice.id}/refunds`,
  {
    method: "POST",
    body: JSON.stringify({
      receiptId: refundableReceiptId,
      destination: "third_party",
      amountMode: "partial",
      amountMinor: "25",
      expectedRefundableMinor: refundCandidate.refundableMinor,
      scenario: null,
      reason: "Synthetic third-party destination must require ticket and dual review",
      idempotencyKey: randomUUID(),
    }),
  },
);
assert.equal(thirdPartyRefund.status, 422);
assert.equal(
  thirdPartyRefund.body.code,
  "THIRD_PARTY_REFUND_DESTINATION_NOT_AVAILABLE",
);

const creditRefundKey = randomUUID();
const creditRefundBody = {
  receiptId: refundableReceiptId,
  destination: "credit",
  amountMode: "partial",
  amountMinor: "75",
  expectedRefundableMinor: refundCandidate.refundableMinor,
  scenario: null,
  reason: "Synthetic administrator selected a partial refund to customer Credit",
  idempotencyKey: creditRefundKey,
};
const creditRefund = await request<RefundRecord>(
  `/api/v1/admin/invoices/${refundOrder.invoice.id}/refunds`,
  { method: "POST", body: JSON.stringify(creditRefundBody) },
  201,
);
assert.equal(creditRefund.status, "succeeded");
assert.equal(creditRefund.destination, "credit");
assert.equal(creditRefund.providerOperationId, null);
const creditRefundReplay = await request<RefundRecord>(
  `/api/v1/admin/invoices/${refundOrder.invoice.id}/refunds`,
  { method: "POST", body: JSON.stringify(creditRefundBody) },
  200,
);
assert.equal(creditRefundReplay.refundId, creditRefund.refundId);
assert.equal(creditRefundReplay.replayed, true);
const semanticCreditRefundAliasKey = randomUUID();
const candidatesAfterLostCreditResponse = await request<{ items: RefundCandidate[] }>(
  "/api/v1/admin/refund-candidates",
);
const refreshedCreditCandidate = candidatesAfterLostCreditResponse.items.find(
  (candidate) => candidate.receiptId === refundableReceiptId,
);
assert.ok(refreshedCreditCandidate);
assert.notEqual(
  refreshedCreditCandidate.refundableMinor,
  creditRefundBody.expectedRefundableMinor,
  "the refreshed optimistic snapshot should change after the first partial refund",
);
const semanticCreditRefundReplay = await request<RefundRecord>(
  `/api/v1/admin/invoices/${refundOrder.invoice.id}/refunds`,
  {
    method: "POST",
    body: JSON.stringify({
      ...creditRefundBody,
      expectedRefundableMinor: refreshedCreditCandidate.refundableMinor,
      idempotencyKey: semanticCreditRefundAliasKey,
    }),
  },
  200,
);
assert.equal(semanticCreditRefundReplay.refundId, creditRefund.refundId);
assert.equal(semanticCreditRefundReplay.replayed, true);
const semanticAliasConflict = await rawCoreRequest(
  `/api/v1/admin/invoices/${refundOrder.invoice.id}/refunds`,
  {
    method: "POST",
    body: JSON.stringify({
      ...creditRefundBody,
      amountMinor: "74",
      idempotencyKey: semanticCreditRefundAliasKey,
    }),
  },
);
assert.equal(semanticAliasConflict.status, 409);
assert.equal(semanticAliasConflict.body.code, "IDEMPOTENCY_CONFLICT");
const creditRefundConflict = await rawCoreRequest(
  `/api/v1/admin/invoices/${refundOrder.invoice.id}/refunds`,
  {
    method: "POST",
    body: JSON.stringify({ ...creditRefundBody, amountMinor: "76" }),
  },
);
assert.equal(creditRefundConflict.status, 409);
assert.equal(creditRefundConflict.body.code, "IDEMPOTENCY_CONFLICT");
const staleFullRefund = await rawCoreRequest(
  `/api/v1/admin/invoices/${refundOrder.invoice.id}/refunds`,
  {
    method: "POST",
    body: JSON.stringify({
      receiptId: refundableReceiptId,
      destination: "original_payment",
      amountMode: "full",
      amountMinor: null,
      expectedRefundableMinor: refundCandidate.refundableMinor,
      scenario: "success",
      reason: "Synthetic stale full-refund confirmation must never increase silently",
      idempotencyKey: randomUUID(),
    }),
  },
);
assert.equal(staleFullRefund.status, 409);
assert.equal(staleFullRefund.body.code, "REFUNDABLE_AMOUNT_CHANGED");

const noRefundDecision = await request<RefundRecord>(
  `/api/v1/admin/invoices/${refundOrder.invoice.id}/refunds`,
  {
    method: "POST",
    body: JSON.stringify({
      receiptId: refundableReceiptId,
      destination: "none",
      amountMode: "none",
      amountMinor: null,
      expectedRefundableMinor: null,
      scenario: null,
      reason: "Synthetic administrator recorded an explicit decision not to refund",
      idempotencyKey: randomUUID(),
    }),
  },
  201,
);
assert.equal(noRefundDecision.status, "declined");
assert.equal(noRefundDecision.amountMinor, "0");

async function createOriginalRefund(
  amountMinor: string,
  scenario: "success" | "failed" | "timeout_success" | "duplicate_out_of_order",
): Promise<RefundRecord> {
  const currentCandidates = await request<{ items: RefundCandidate[] }>(
    "/api/v1/admin/refund-candidates",
  );
  const currentCandidate = currentCandidates.items.find(
    (candidate) => candidate.receiptId === refundableReceiptId,
  );
  assert.ok(currentCandidate, "refund source should retain available capacity");
  const created = await request<RefundRecord>(
    `/api/v1/admin/invoices/${refundOrder.invoice.id}/refunds`,
    {
      method: "POST",
      body: JSON.stringify({
        receiptId: refundableReceiptId,
        destination: "original_payment",
        amountMode: "partial",
        amountMinor,
        expectedRefundableMinor: currentCandidate.refundableMinor,
        scenario,
        reason: `Synthetic original-payment refund scenario ${scenario}`,
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  return waitFor(
    `manual refund scenario ${scenario}`,
    () => request<RefundRecord>(`/api/v1/admin/refunds/${created.refundId}`),
    (refund) => ["succeeded", "failed", "manual"].includes(refund.status),
    35_000,
  );
}

const originalSuccessRefund = await createOriginalRefund("80", "success");
assert.equal(originalSuccessRefund.status, "succeeded");
assert.ok(originalSuccessRefund.externalRefundId);
const duplicateOutOfOrderRefund = await createOriginalRefund("70", "duplicate_out_of_order");
assert.equal(duplicateOutOfOrderRefund.status, "succeeded");
await new Promise((resolve) => setTimeout(resolve, 1_000));
const duplicateOutOfOrderAfterLateFact = await request<RefundRecord>(
  `/api/v1/admin/refunds/${duplicateOutOfOrderRefund.refundId}`,
);
assert.equal(duplicateOutOfOrderAfterLateFact.status, "succeeded");
const timeoutSuccessRefund = await createOriginalRefund("60", "timeout_success");
assert.equal(timeoutSuccessRefund.status, "succeeded");
const failedRefund = await createOriginalRefund("40", "failed");
assert.equal(failedRefund.status, "failed");

const providerRefundCalls = await providerPool.query<{
  refund_id: string;
  create_calls: number;
}>(
  `SELECT refund_id, create_calls
   FROM mock_refund_operations
   WHERE refund_id = ANY($1::uuid[])`,
  [
    [
      originalSuccessRefund.refundId,
      duplicateOutOfOrderRefund.refundId,
      timeoutSuccessRefund.refundId,
      failedRefund.refundId,
    ],
  ],
);
assert.equal(providerRefundCalls.rowCount, 4);
for (const refund of providerRefundCalls.rows) {
  assert.equal(refund.create_calls, 1, `refund ${refund.refund_id} must call create exactly once`);
}

const afterScenarios = await request<{ items: RefundCandidate[] }>(
  "/api/v1/admin/refund-candidates",
);
const remainingCandidate = afterScenarios.items.find(
  (candidate) => candidate.receiptId === refundableReceiptId,
);
assert.ok(remainingCandidate);
const concurrentAmount = BigInt(remainingCandidate.refundableMinor) / 2n + 1n;
const concurrentRefundResults = await Promise.all([
  rawCoreRequest(`/api/v1/admin/invoices/${refundOrder.invoice.id}/refunds`, {
    method: "POST",
    body: JSON.stringify({
      receiptId: refundableReceiptId,
      destination: "credit",
      amountMode: "partial",
      amountMinor: concurrentAmount.toString(),
      expectedRefundableMinor: remainingCandidate.refundableMinor,
      scenario: null,
      reason: "Synthetic first concurrent refund competing for the remaining receipt",
      idempotencyKey: randomUUID(),
    }),
  }),
  rawCoreRequest(`/api/v1/admin/invoices/${refundOrder.invoice.id}/refunds`, {
    method: "POST",
    body: JSON.stringify({
      receiptId: refundableReceiptId,
      destination: "credit",
      amountMode: "partial",
      amountMinor: concurrentAmount.toString(),
      expectedRefundableMinor: remainingCandidate.refundableMinor,
      scenario: null,
      reason: "Synthetic second concurrent refund competing for the remaining receipt",
      idempotencyKey: randomUUID(),
    }),
  }),
]);
assert.deepEqual(
  concurrentRefundResults.map((result) => result.status).sort((left, right) => left - right),
  [201, 409],
);

const refundFacts = await corePool.query<{
  credit_refund_transactions: string;
  original_settlements: string;
  refund_journals: string;
  provider_operations: string;
  failed_refund_journals: string;
}>(
  `SELECT
     (SELECT count(*)::text
      FROM credit_transactions
      WHERE kind = 'refund' AND source_id = $1) AS credit_refund_transactions,
     (SELECT count(*)::text
      FROM refund_settlements
      WHERE refund_id = ANY($2::uuid[])
        AND destination = 'original_payment') AS original_settlements,
     (SELECT count(*)::text
      FROM ledger_journals
      WHERE source_type = 'refund'
        AND source_id = ANY($3::uuid[])) AS refund_journals,
     (SELECT count(*)::text
      FROM provider_operations
      WHERE subject_type = 'refund'
        AND subject_id = ANY($2::uuid[])) AS provider_operations,
     (SELECT count(*)::text
      FROM ledger_journals
      WHERE source_type = 'refund' AND source_id = $4) AS failed_refund_journals`,
  [
    creditRefund.refundId,
    [
      originalSuccessRefund.refundId,
      duplicateOutOfOrderRefund.refundId,
      timeoutSuccessRefund.refundId,
      failedRefund.refundId,
    ],
    [
      creditRefund.refundId,
      originalSuccessRefund.refundId,
      duplicateOutOfOrderRefund.refundId,
      timeoutSuccessRefund.refundId,
    ],
    failedRefund.refundId,
  ],
);
assert.equal(refundFacts.rows[0]?.credit_refund_transactions, "1");
assert.equal(refundFacts.rows[0]?.original_settlements, "3");
assert.equal(refundFacts.rows[0]?.refund_journals, "4");
assert.equal(refundFacts.rows[0]?.provider_operations, "4");
assert.equal(refundFacts.rows[0]?.failed_refund_journals, "0");

const refundSourceAfter = await corePool.query<{
  payment_status: string;
  receipt_amount_minor: string;
  receipt_allocated_minor: string;
  allocation_amount_minor: string;
  invoice_total_minor: string;
  service_status: string;
  service_term_start: Date;
  service_term_end: Date;
  credit_balance_minor: string;
}>(
  `SELECT
     payment.status AS payment_status,
     receipt.amount_minor::text AS receipt_amount_minor,
     receipt.allocated_minor::text AS receipt_allocated_minor,
     allocation.amount_minor::text AS allocation_amount_minor,
     invoice.total_minor::text AS invoice_total_minor,
     service.status AS service_status,
     service.term_start AS service_term_start,
     service.term_end AS service_term_end,
     COALESCE((
       SELECT sum(transaction.credit_minor - transaction.debit_minor)
       FROM credit_accounts account
       LEFT JOIN credit_transactions transaction ON transaction.credit_account_id = account.id
       WHERE account.client_account_id = invoice.client_account_id
         AND account.currency = invoice.currency
     ), 0)::text AS credit_balance_minor
   FROM fund_receipts receipt
   JOIN payment_attempts payment ON payment.id = receipt.reported_payment_attempt_id
   JOIN payment_allocations allocation ON allocation.payment_attempt_id = payment.id
   JOIN invoices invoice ON invoice.id = allocation.invoice_id
   JOIN orders order_record ON order_record.id = invoice.order_id
   JOIN order_items item ON item.order_id = order_record.id
   JOIN services service ON service.order_item_id = item.id
   WHERE receipt.id = $1`,
  [refundableReceiptId],
);
const refundSourceFinal = refundSourceAfter.rows[0];
assert.ok(refundSourceFinal);
assert.equal(refundSourceFinal.payment_status, refundSourceSnapshot.payment_status);
assert.equal(refundSourceFinal.receipt_amount_minor, refundSourceSnapshot.receipt_amount_minor);
assert.equal(refundSourceFinal.receipt_allocated_minor, refundSourceSnapshot.receipt_allocated_minor);
assert.equal(refundSourceFinal.allocation_amount_minor, refundSourceSnapshot.allocation_amount_minor);
assert.equal(refundSourceFinal.invoice_total_minor, refundSourceSnapshot.invoice_total_minor);
assert.equal(refundSourceFinal.service_status, refundSourceSnapshot.service_status);
assert.equal(
  refundSourceFinal.service_term_start.toISOString(),
  refundSourceSnapshot.service_term_start.toISOString(),
);
assert.equal(
  refundSourceFinal.service_term_end.toISOString(),
  refundSourceSnapshot.service_term_end.toISOString(),
);
assert.ok(
  BigInt(refundSourceFinal.credit_balance_minor) >
    BigInt(refundSourceSnapshot.credit_balance_minor),
);

const refundGuardClient = await corePool.connect();
let rejectedRefundDelete = false;
try {
  await refundGuardClient.query("BEGIN");
  await refundGuardClient.query("DELETE FROM refund_settlements WHERE refund_id = $1", [
    originalSuccessRefund.refundId,
  ]);
  await refundGuardClient.query("COMMIT");
} catch {
  rejectedRefundDelete = true;
  await refundGuardClient.query("ROLLBACK");
} finally {
  refundGuardClient.release();
}
assert.equal(rejectedRefundDelete, true, "confirmed refund settlements must be append-only");
const allocationGuardClient = await corePool.connect();
let rejectedRefundSourceMutation = false;
try {
  await allocationGuardClient.query("BEGIN");
  await allocationGuardClient.query(
    `UPDATE payment_allocations
     SET amount_minor = amount_minor + 1
     WHERE payment_attempt_id = (
       SELECT reported_payment_attempt_id
       FROM fund_receipts
       WHERE id = $1
     )`,
    [refundableReceiptId],
  );
  await allocationGuardClient.query("COMMIT");
} catch {
  rejectedRefundSourceMutation = true;
  await allocationGuardClient.query("ROLLBACK");
} finally {
  allocationGuardClient.release();
}
assert.equal(
  rejectedRefundSourceMutation,
  true,
  "refund source allocations must be append-only",
);

await installRefundStartDelay();
try {
  await request(
    "/api/v1/auth/reauth",
    { method: "POST", body: JSON.stringify({ password }) },
    200,
  );
  const securityRefundOrder = await createOrder(automaticPrice.id, legal);
  const paidSecurityRefundOrder = await pay(securityRefundOrder, "success");
  assert.equal(paidSecurityRefundOrder.invoice.status, "paid");
  const securityCandidates = await request<{ items: RefundCandidate[] }>(
    "/api/v1/admin/refund-candidates",
  );
  const securityCandidate = securityCandidates.items.find(
    (candidate) => candidate.invoiceId === securityRefundOrder.invoice.id,
  );
  assert.ok(securityCandidate);

  const failedThenSucceeded = await request<RefundRecord>(
    `/api/v1/admin/invoices/${securityRefundOrder.invoice.id}/refunds`,
    {
      method: "POST",
      body: JSON.stringify({
        receiptId: securityCandidate.receiptId,
        destination: "original_payment",
        amountMode: "partial",
        amountMinor: "90",
        expectedRefundableMinor: securityCandidate.refundableMinor,
        scenario: "failed",
        reason: "Synthetic refund first fails before a contradictory late success",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  assert.ok(failedThenSucceeded.providerOperationId);
  await corePool.query(
    `UPDATE durable_jobs
     SET available_at = now(), updated_at = now()
     WHERE job_type = 'refund.start'
       AND payload->>'refundId' = $1
       AND status = 'pending'`,
    [failedThenSucceeded.refundId],
  );
  const initiallyFailed = await waitFor(
    "refund Provider to report a definitive failure",
    () => request<RefundRecord>(`/api/v1/admin/refunds/${failedThenSucceeded.refundId}`),
    (refund) => refund.status === "failed",
    35_000,
  );
  assert.equal(initiallyFailed.securityHold, false);
  const failedHighWater = await corePool.query<{
    refund_status: string;
    refund_version: number;
    refund_provider_occurred_at: Date;
    operation_status: string;
    operation_created_at: Date;
    operation_provider_occurred_at: Date;
  }>(
    `SELECT
       refund.status AS refund_status,
       refund.version AS refund_version,
       refund.provider_occurred_at AS refund_provider_occurred_at,
       operation.status AS operation_status,
       operation.created_at AS operation_created_at,
       operation.provider_occurred_at AS operation_provider_occurred_at
     FROM refunds refund
     JOIN provider_operations operation
       ON operation.subject_type = 'refund'
      AND operation.subject_id = refund.id
      AND operation.kind = 'refund_create'
     WHERE refund.id = $1`,
    [failedThenSucceeded.refundId],
  );
  const failedHighWaterState = failedHighWater.rows[0];
  assert.ok(failedHighWaterState);
  assert.equal(failedHighWaterState.refund_status, "failed");
  assert.equal(failedHighWaterState.operation_status, "failed");

  const staleSuccess = await submitRefundFact({
    eventId: `refund-older-success-after-newer-failure:${randomUUID()}`,
    providerOperationId: failedThenSucceeded.providerOperationId,
    refundId: failedThenSucceeded.refundId,
    externalRefundId: `mock-refund-stale-success:${failedThenSucceeded.refundId}`,
    status: "succeeded",
    amountMinor: "90",
    currency: "USD",
    occurredAt: failedHighWaterState.refund_provider_occurred_at.toISOString(),
  });
  assert.equal(staleSuccess.status, 202);
  assert.equal(staleSuccess.body.reason, "stale_provider_fact");
  const implausibleFutureSuccess = await submitRefundFact({
    eventId: `refund-implausible-future-success:${randomUUID()}`,
    providerOperationId: failedThenSucceeded.providerOperationId,
    refundId: failedThenSucceeded.refundId,
    externalRefundId: `mock-refund-implausible-success:${failedThenSucceeded.refundId}`,
    status: "succeeded",
    amountMinor: "90",
    currency: "USD",
    occurredAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  assert.equal(implausibleFutureSuccess.status, 202);
  assert.equal(
    implausibleFutureSuccess.body.reason,
    "implausible_provider_occurrence_time",
  );
  const temporallyRejectedState = await corePool.query<{
    refund_status: string;
    refund_version: number;
    refund_provider_occurred_at: Date;
    operation_status: string;
    operation_provider_occurred_at: Date;
    provider_facts: string;
    discrepancies: string;
    receipt_holds: string;
    temporal_audits: string;
  }>(
    `SELECT
       refund.status AS refund_status,
       refund.version AS refund_version,
       refund.provider_occurred_at AS refund_provider_occurred_at,
       operation.status AS operation_status,
       operation.provider_occurred_at AS operation_provider_occurred_at,
       (SELECT count(*)::text FROM refund_provider_facts fact
        WHERE fact.refund_id = refund.id) AS provider_facts,
       (SELECT count(*)::text FROM refund_discrepancy_settlements discrepancy
        WHERE discrepancy.refund_id = refund.id) AS discrepancies,
       (SELECT count(*)::text FROM refund_receipt_security_holds security_hold
        WHERE security_hold.refund_id = refund.id) AS receipt_holds,
       (SELECT count(*)::text FROM audit_events audit
        WHERE audit.target_type = 'refund'
          AND audit.target_id = refund.id::text
          AND audit.action = 'refund.temporal_fact_ignored') AS temporal_audits
     FROM refunds refund
     JOIN provider_operations operation
       ON operation.subject_type = 'refund'
      AND operation.subject_id = refund.id
      AND operation.kind = 'refund_create'
     WHERE refund.id = $1`,
    [failedThenSucceeded.refundId],
  );
  const rejectedTemporalState = temporallyRejectedState.rows[0];
  assert.ok(rejectedTemporalState);
  assert.equal(rejectedTemporalState.refund_status, "failed");
  assert.equal(rejectedTemporalState.refund_version, failedHighWaterState.refund_version);
  assert.equal(rejectedTemporalState.operation_status, "failed");
  assert.equal(
    rejectedTemporalState.refund_provider_occurred_at.toISOString(),
    failedHighWaterState.refund_provider_occurred_at.toISOString(),
  );
  assert.equal(
    rejectedTemporalState.operation_provider_occurred_at.toISOString(),
    failedHighWaterState.operation_provider_occurred_at.toISOString(),
  );
  assert.equal(rejectedTemporalState.provider_facts, "3");
  assert.equal(rejectedTemporalState.discrepancies, "0");
  assert.equal(rejectedTemporalState.receipt_holds, "0");
  assert.equal(rejectedTemporalState.temporal_audits, "2");

  const afterFailureCandidates = await request<{ items: RefundCandidate[] }>(
    "/api/v1/admin/refund-candidates",
  );
  const afterFailureCandidate = afterFailureCandidates.items.find(
    (candidate) => candidate.receiptId === securityCandidate.receiptId,
  );
  assert.ok(afterFailureCandidate, "a definitive failure should release capacity");
  const possiblySentAmount = (BigInt(afterFailureCandidate.refundableMinor) - 40n).toString();
  assert.ok(BigInt(possiblySentAmount) > 0n);
  const competingPossiblySent = await request<RefundRecord>(
    `/api/v1/admin/invoices/${securityRefundOrder.invoice.id}/refunds`,
    {
      method: "POST",
      body: JSON.stringify({
        receiptId: securityCandidate.receiptId,
        destination: "original_payment",
        amountMode: "partial",
        amountMinor: possiblySentAmount,
        expectedRefundableMinor: afterFailureCandidate.refundableMinor,
        scenario: "success",
        reason: "Synthetic possibly-sent refund is quarantined behind a receipt hold",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  const afterPossiblySentCandidate = (
    await request<{ items: RefundCandidate[] }>("/api/v1/admin/refund-candidates")
  ).items.find((candidate) => candidate.receiptId === securityCandidate.receiptId);
  assert.ok(afterPossiblySentCandidate);
  const competingResumable = await request<RefundRecord>(
    `/api/v1/admin/invoices/${securityRefundOrder.invoice.id}/refunds`,
    {
      method: "POST",
      body: JSON.stringify({
        receiptId: securityCandidate.receiptId,
        destination: "original_payment",
        amountMode: "partial",
        amountMinor: "20",
        expectedRefundableMinor: afterPossiblySentCandidate.refundableMinor,
        scenario: "timeout_success",
        reason: "Synthetic sent refund must resume with query only after all holds close",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  for (const possiblySent of [competingPossiblySent, competingResumable]) {
    assert.ok(possiblySent.providerOperationId);
    await corePool.query(
      `UPDATE refunds
       SET status = 'processing', updated_at = now(), version = version + 1
       WHERE id = $1 AND status = 'queued'`,
      [possiblySent.refundId],
    );
    await corePool.query(
      `UPDATE provider_operations
       SET status = 'running', attempt_count = 1, updated_at = now()
       WHERE id = $1 AND status = 'queued'`,
      [possiblySent.providerOperationId],
    );
    await corePool.query(
      `UPDATE durable_jobs
       SET status = 'manual', last_error = 'synthetic request may have been sent', updated_at = now()
       WHERE job_type = 'refund.start' AND payload->>'refundId' = $1`,
      [possiblySent.refundId],
    );
  }
  const afterSentReservations = (
    await request<{ items: RefundCandidate[] }>("/api/v1/admin/refund-candidates")
  ).items.find((candidate) => candidate.receiptId === securityCandidate.receiptId);
  assert.ok(afterSentReservations);
  assert.equal(afterSentReservations.refundableMinor, "20");
  const competingQueued = await request<RefundRecord>(
    `/api/v1/admin/invoices/${securityRefundOrder.invoice.id}/refunds`,
    {
      method: "POST",
      body: JSON.stringify({
        receiptId: securityCandidate.receiptId,
        destination: "original_payment",
        amountMode: "partial",
        amountMinor: "20",
        expectedRefundableMinor: afterSentReservations.refundableMinor,
        scenario: "success",
        reason: "Synthetic competing refund remains known-unsent during late success",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  assert.equal(competingQueued.status, "queued");
  assert.ok(competingQueued.providerOperationId);
  const invalidRefundCapability = await submitRefundFact({
    eventId: `refund-invalid-capability:${randomUUID()}`,
    providerOperationId: competingQueued.providerOperationId,
    refundId: competingQueued.refundId,
    callbackCapability: "A".repeat(43),
    externalRefundId: `mock-refund-forged:${competingQueued.refundId}`,
    status: "succeeded",
    amountMinor: "20",
    currency: "USD",
    occurredAt: new Date().toISOString(),
  });
  assert.equal(invalidRefundCapability.status, 202);
  assert.equal(invalidRefundCapability.body.reason, "invalid_operation_capability");
  const preOutboundRefundFact = await submitRefundFact({
    eventId: `refund-pre-outbound:${randomUUID()}`,
    providerOperationId: competingQueued.providerOperationId,
    refundId: competingQueued.refundId,
    externalRefundId: `mock-refund-pre-outbound:${competingQueued.refundId}`,
    status: "succeeded",
    amountMinor: "20",
    currency: "USD",
    occurredAt: new Date().toISOString(),
  });
  assert.equal(preOutboundRefundFact.status, 202);
  assert.equal(preOutboundRefundFact.body.reason, "provider_operation_not_started");

  const lateExternalRefundId = `mock-refund-late:${failedThenSucceeded.refundId}`;
  const lateSuccess = await submitRefundFact({
    eventId: `refund-late-success:${randomUUID()}`,
    providerOperationId: failedThenSucceeded.providerOperationId,
    refundId: failedThenSucceeded.refundId,
    externalRefundId: lateExternalRefundId,
    status: "succeeded",
    amountMinor: "90",
    currency: "USD",
    occurredAt: new Date().toISOString(),
  });
  assert.equal(lateSuccess.status, 202);
  assert.equal(lateSuccess.body.status, "manual");

  const securityHeld = await request<RefundRecord>(
    `/api/v1/admin/refunds/${failedThenSucceeded.refundId}`,
  );
  assert.equal(securityHeld.status, "manual");
  assert.equal(securityHeld.securityHold, true);
  const competingFrozen = await request<RefundRecord>(
    `/api/v1/admin/refunds/${competingQueued.refundId}`,
  );
  assert.equal(competingFrozen.status, "failed");
  assert.equal(competingFrozen.securityHold, true);
  const possiblySentFrozen = await request<RefundRecord>(
    `/api/v1/admin/refunds/${competingPossiblySent.refundId}`,
  );
  assert.equal(possiblySentFrozen.status, "manual");
  assert.equal(possiblySentFrozen.securityHold, true);
  const resumableFrozen = await request<RefundRecord>(
    `/api/v1/admin/refunds/${competingResumable.refundId}`,
  );
  assert.equal(resumableFrozen.status, "manual");
  assert.equal(resumableFrozen.securityHold, true);

  const possiblySentSuccess = await submitRefundFact({
    eventId: `refund-possibly-sent-success:${randomUUID()}`,
    providerOperationId: competingPossiblySent.providerOperationId,
    refundId: competingPossiblySent.refundId,
    externalRefundId: `mock-refund-possibly-sent:${competingPossiblySent.refundId}`,
    status: "succeeded",
    amountMinor: possiblySentAmount,
    currency: "USD",
    occurredAt: new Date().toISOString(),
  });
  assert.equal(possiblySentSuccess.status, 202);
  assert.equal(possiblySentSuccess.body.status, "manual");
  assert.equal(possiblySentSuccess.body.reason, "refund.receipt_capacity_conflict");
  const possiblySentHeld = await request<RefundRecord>(
    `/api/v1/admin/refunds/${competingPossiblySent.refundId}`,
  );
  assert.equal(possiblySentHeld.status, "manual");
  assert.equal(possiblySentHeld.securityHold, true);

  const collisionEventId = `refund-event-collision:${randomUUID()}`;
  const laterFailure = await submitRefundFact({
    eventId: collisionEventId,
    providerOperationId: failedThenSucceeded.providerOperationId,
    refundId: failedThenSucceeded.refundId,
    externalRefundId: lateExternalRefundId,
    status: "failed",
    amountMinor: "90",
    currency: "USD",
    occurredAt: new Date(Date.now() + 1_000).toISOString(),
  });
  assert.equal(laterFailure.status, 202);
  assert.equal(laterFailure.body.status, "manual");
  const conflictingSameEventId = await submitRefundFact({
    eventId: collisionEventId,
    providerOperationId: failedThenSucceeded.providerOperationId,
    refundId: failedThenSucceeded.refundId,
    externalRefundId: lateExternalRefundId,
    status: "succeeded",
    amountMinor: "90",
    currency: "USD",
    occurredAt: new Date(Date.now() + 2_000).toISOString(),
  });
  assert.equal(conflictingSameEventId.status, 202);
  assert.equal(conflictingSameEventId.body.status, "manual");
  const stillSecurityHeld = await request<RefundRecord>(
    `/api/v1/admin/refunds/${failedThenSucceeded.refundId}`,
  );
  assert.equal(stillSecurityHeld.status, "manual");
  assert.equal(stillSecurityHeld.securityHold, true);

  const repeatedClaimOccurredAt = new Date(Date.now() + 3_000).toISOString();
  const repeatedClaimExternalId = `mock-refund-repeat-a:${failedThenSucceeded.refundId}`;
  for (const [externalRefundId, occurredAt] of [
    [repeatedClaimExternalId, repeatedClaimOccurredAt],
    [`mock-refund-repeat-b:${failedThenSucceeded.refundId}`, new Date(Date.now() + 4_000).toISOString()],
    [repeatedClaimExternalId, repeatedClaimOccurredAt],
  ] as const) {
    const repeatedClaim = await submitRefundFact({
      eventId: `refund-repeat-claim:${randomUUID()}`,
      providerOperationId: failedThenSucceeded.providerOperationId,
      refundId: failedThenSucceeded.refundId,
      externalRefundId,
      status: "succeeded",
      amountMinor: "90",
      currency: "USD",
      occurredAt,
    });
    assert.equal(repeatedClaim.status, 202);
    assert.equal(repeatedClaim.body.status, "manual");
  }

  const securityAccounting = await corePool.query<{
    provider_facts: string;
    conflicting_event_facts: string;
    discrepancy_settlements: string;
    receipt_security_holds: string;
    suspense_debit_minor: string;
    cash_credit_minor: string;
  }>(
    `SELECT
       (SELECT count(*)::text
        FROM refund_provider_facts
        WHERE refund_id = $1) AS provider_facts,
       (SELECT count(*)::text
        FROM refund_provider_facts
        WHERE refund_id = $1
          AND external_event_id = $3) AS conflicting_event_facts,
       (SELECT count(*)::text
        FROM refund_discrepancy_settlements
        WHERE refund_id = $1
          AND external_refund_id = $2
          AND amount_minor = 90
          AND currency = 'USD') AS discrepancy_settlements,
       (SELECT count(*)::text
        FROM refund_receipt_security_holds
        WHERE source_fund_receipt_id = $4) AS receipt_security_holds,
       COALESCE((
         SELECT sum(line.debit_minor)::text
         FROM refund_discrepancy_settlements discrepancy
         JOIN ledger_journals journal
           ON journal.source_type = 'refund_provider_discrepancy'
          AND journal.source_id = discrepancy.id
          AND journal.currency = discrepancy.currency
         JOIN ledger_lines line
           ON line.journal_id = journal.id
          AND line.account_code = 'refund_discrepancy_suspense'
         WHERE discrepancy.refund_id = $1
       ), '0') AS suspense_debit_minor,
       COALESCE((
         SELECT sum(line.credit_minor)::text
         FROM refund_discrepancy_settlements discrepancy
         JOIN ledger_journals journal
           ON journal.source_type = 'refund_provider_discrepancy'
          AND journal.source_id = discrepancy.id
          AND journal.currency = discrepancy.currency
         JOIN ledger_lines line
           ON line.journal_id = journal.id
          AND line.account_code = 'mock_cash'
         WHERE discrepancy.refund_id = $1
       ), '0') AS cash_credit_minor`,
    [
      failedThenSucceeded.refundId,
      lateExternalRefundId,
      collisionEventId,
      securityCandidate.receiptId,
    ],
  );
  assert.equal(securityAccounting.rows[0]?.provider_facts, "8");
  assert.equal(securityAccounting.rows[0]?.conflicting_event_facts, "2");
  assert.equal(securityAccounting.rows[0]?.discrepancy_settlements, "1");
  assert.equal(securityAccounting.rows[0]?.receipt_security_holds, "5");
  assert.equal(securityAccounting.rows[0]?.suspense_debit_minor, "90");
  assert.equal(securityAccounting.rows[0]?.cash_credit_minor, "90");
  const competingProviderCalls = await providerPool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM mock_refund_operations
     WHERE refund_id = $1`,
    [competingQueued.refundId],
  );
  assert.equal(competingProviderCalls.rows[0]?.count, "0");

  const heldCandidates = await request<{ items: RefundCandidate[] }>(
    "/api/v1/admin/refund-candidates",
  );
  assert.equal(
    heldCandidates.items.some(
      (candidate) => candidate.receiptId === securityCandidate.receiptId,
    ),
    false,
  );

  await request(
    "/api/v1/auth/reauth",
    { method: "POST", body: JSON.stringify({ password }) },
    200,
  );
  const activeSecurityHolds = await request<{ items: RefundSecurityHold[] }>(
    "/api/v1/admin/refund-security-holds",
  );
  const refundSecurityHolds = activeSecurityHolds.items.filter(
    (hold) => hold.refundId === failedThenSucceeded.refundId,
  );
  assert.equal(refundSecurityHolds.length, 4);
  const acceptableHold = refundSecurityHolds.find((hold) =>
    hold.allowedDecisions.includes("accept_authorized_outflow"),
  );
  assert.ok(acceptableHold);
  assert.equal(acceptableHold.providerFacts.length, 8);
  const staleAdjudication = await rawCoreRequest(
    `/api/v1/admin/refund-security-holds/${acceptableHold.holdId}/adjudications`,
    {
      method: "POST",
      body: JSON.stringify({
        decision: "accept_authorized_outflow",
        reason: "Synthetic human accepted the exact authorized Provider outflow",
        idempotencyKey: randomUUID(),
        expectedRefundVersion: acceptableHold.refundVersion - 1,
      }),
    },
  );
  assert.equal(staleAdjudication.status, 409);
  assert.equal(staleAdjudication.body.code, "REFUND_VERSION_CONFLICT");

  const acceptReason = "Synthetic human accepted the exact authorized Provider outflow";
  const acceptKey = randomUUID();
  const acceptedAdjudication = await adjudicateRefundHold(
    acceptableHold,
    "accept_authorized_outflow",
    acceptReason,
    acceptKey,
  );
  assert.equal(acceptedAdjudication.decision, "accept_authorized_outflow");
  const acceptedReplay = await adjudicateRefundHold(
    acceptableHold,
    "accept_authorized_outflow",
    acceptReason,
    acceptKey,
    200,
  );
  assert.equal(acceptedReplay.adjudicationId, acceptedAdjudication.adjudicationId);
  assert.equal(acceptedReplay.replayed, true);
  const acceptedSemanticReplay = await adjudicateRefundHold(
    acceptableHold,
    "accept_authorized_outflow",
    acceptReason,
    randomUUID(),
    200,
  );
  assert.equal(acceptedSemanticReplay.adjudicationId, acceptedAdjudication.adjudicationId);
  assert.equal(acceptedSemanticReplay.replayed, true);

  const holdsAfterAccept = await request<{ items: RefundSecurityHold[] }>(
    "/api/v1/admin/refund-security-holds",
  );
  const remainingProviderClaims = holdsAfterAccept.items.filter(
    (hold) => hold.refundId === failedThenSucceeded.refundId,
  );
  assert.equal(remainingProviderClaims.length, 3);
  for (const remainingProviderClaim of remainingProviderClaims) {
    assert.equal(remainingProviderClaim.discrepancy, null);
    assert.deepEqual(remainingProviderClaim.allowedDecisions, [
      "record_unexpected_outflow",
      "dismiss_provider_claim",
    ]);
    await adjudicateRefundHold(
      remainingProviderClaim,
      "dismiss_provider_claim",
      "Synthetic human dismissed one additional unverified Provider success claim",
    );
  }
  const holdsAfterProviderClaimDismissals = await request<{
    items: RefundSecurityHold[];
  }>("/api/v1/admin/refund-security-holds");
  assert.equal(
    holdsAfterProviderClaimDismissals.items.some(
      (hold) => hold.refundId === failedThenSucceeded.refundId,
    ),
    false,
  );
  const overCapacityHold = holdsAfterProviderClaimDismissals.items.find(
    (hold) => hold.refundId === competingPossiblySent.refundId,
  );
  assert.ok(overCapacityHold);
  assert.deepEqual(overCapacityHold.allowedDecisions, [
    "record_unexpected_outflow",
    "dismiss_provider_claim",
  ]);
  assert.equal(overCapacityHold.confirmedSettlementMinor, "90");
  await adjudicateRefundHold(
    overCapacityHold,
    "dismiss_provider_claim",
    "Synthetic human rejected the outflow that would exceed the source receipt",
  );
  const overCapacityResolved = await request<RefundRecord>(
    `/api/v1/admin/refunds/${competingPossiblySent.refundId}`,
  );
  assert.equal(overCapacityResolved.status, "failed");
  assert.equal(overCapacityResolved.securityHold, false);
  const overCapacityAccounting = await corePool.query<{
    settlements: string;
    discrepancy_cash_credit: string;
    compensating_cash_debit: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM refund_settlements WHERE refund_id = $1) AS settlements,
       COALESCE((
         SELECT sum(line.credit_minor)::text
         FROM refund_discrepancy_settlements discrepancy
         JOIN ledger_journals journal
           ON journal.source_type = 'refund_provider_discrepancy'
          AND journal.source_id = discrepancy.id
         JOIN ledger_lines line
           ON line.journal_id = journal.id AND line.account_code = 'mock_cash'
         WHERE discrepancy.refund_id = $1
       ), '0') AS discrepancy_cash_credit,
       COALESCE((
         SELECT sum(line.debit_minor)::text
         FROM refund_security_hold_adjudications adjudication
         JOIN ledger_journals journal
           ON journal.source_type = 'refund_security_adjudication'
          AND journal.source_id = adjudication.id
         JOIN ledger_lines line
           ON line.journal_id = journal.id AND line.account_code = 'mock_cash'
         WHERE adjudication.refund_id = $1
       ), '0') AS compensating_cash_debit`,
    [competingPossiblySent.refundId],
  );
  assert.equal(overCapacityAccounting.rows[0]?.settlements, "0");
  assert.equal(overCapacityAccounting.rows[0]?.discrepancy_cash_credit, possiblySentAmount);
  assert.equal(overCapacityAccounting.rows[0]?.compensating_cash_debit, possiblySentAmount);

  const resumedQueryOnly = await waitFor(
    "last receipt hold to resume every frozen possibly-sent refund with query only",
    async () => {
      const result = await corePool.query<{
        start_status: string;
        reconcile_status: string;
        reconcile_attempts: number;
        still_frozen: boolean;
      }>(
        `SELECT
           start_job.status AS start_status,
           reconcile_job.status AS reconcile_status,
           reconcile_job.attempts AS reconcile_attempts,
           refund.result ? 'frozenByRefundId' AS still_frozen
         FROM durable_jobs start_job
         JOIN durable_jobs reconcile_job
           ON reconcile_job.job_type = 'refund.reconcile'
          AND reconcile_job.unique_key = start_job.unique_key
         JOIN refunds refund ON refund.id = $1::uuid
         WHERE start_job.job_type = 'refund.start'
           AND start_job.payload->>'refundId' = $1::text`,
        [competingResumable.refundId],
      );
      return result.rows[0];
    },
    (state) =>
      state?.start_status === "completed" &&
      ["pending", "running"].includes(state.reconcile_status),
    15_000,
  );
  assert.ok(resumedQueryOnly);
  assert.equal(resumedQueryOnly.still_frozen, false);
  const resumedProviderCreates = await providerPool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM mock_refund_operations WHERE refund_id = $1`,
    [competingResumable.refundId],
  );
  assert.equal(resumedProviderCreates.rows[0]?.count, "0");
  const resumableManual = await request<RefundRecord>(
    `/api/v1/admin/refunds/${competingResumable.refundId}`,
  );
  assert.equal(resumableManual.status, "manual");
  assert.equal(resumableManual.securityHold, false);
  const confirmedNoOutflow = await request<{
    action: string;
    status: string;
    replayed: boolean;
  }>(
    `/api/v1/admin/refunds/${competingResumable.refundId}/manual-actions`,
    {
      method: "POST",
      body: JSON.stringify({
        action: "confirm_no_outflow",
        reason: "Synthetic administrator confirmed the query-only operation never left cash",
        idempotencyKey: randomUUID(),
        expectedRefundVersion: resumableManual.version,
      }),
    },
    201,
  );
  assert.equal(confirmedNoOutflow.action, "confirm_no_outflow");
  assert.equal(confirmedNoOutflow.status, "confirmed_no_outflow");
  const confirmedNoOutflowRefund = await request<RefundRecord>(
    `/api/v1/admin/refunds/${competingResumable.refundId}`,
  );
  assert.equal(confirmedNoOutflowRefund.status, "failed");
  const afterAdjudication = await request<RefundRecord>(
    `/api/v1/admin/refunds/${failedThenSucceeded.refundId}`,
  );
  assert.equal(afterAdjudication.status, "succeeded");
  assert.equal(afterAdjudication.securityHold, false);
  assert.equal(afterAdjudication.externalRefundId, lateExternalRefundId);
  const adjudicationAccounting = await corePool.query<{
    settlements: string;
    adjudications: string;
    discrepancy_cash_credit: string;
    suspense_debit: string;
    suspense_credit: string;
    refund_expense_debit: string;
    adjudication_cash_credit: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM refund_settlements WHERE refund_id = $1) AS settlements,
       (SELECT count(*)::text FROM refund_security_hold_adjudications WHERE refund_id = $1)
         AS adjudications,
       COALESCE((
         SELECT sum(line.credit_minor)::text
         FROM refund_discrepancy_settlements discrepancy
         JOIN ledger_journals journal
           ON journal.source_type = 'refund_provider_discrepancy'
          AND journal.source_id = discrepancy.id
         JOIN ledger_lines line
           ON line.journal_id = journal.id AND line.account_code = 'mock_cash'
         WHERE discrepancy.refund_id = $1
       ), '0') AS discrepancy_cash_credit,
       COALESCE((
         SELECT sum(line.debit_minor)::text
         FROM refund_discrepancy_settlements discrepancy
         JOIN ledger_journals journal
           ON journal.source_type = 'refund_provider_discrepancy'
          AND journal.source_id = discrepancy.id
         JOIN ledger_lines line
           ON line.journal_id = journal.id
          AND line.account_code = 'refund_discrepancy_suspense'
         WHERE discrepancy.refund_id = $1
       ), '0') AS suspense_debit,
       COALESCE((
         SELECT sum(line.credit_minor)::text
         FROM refund_security_hold_adjudications adjudication
         JOIN ledger_journals journal
           ON journal.source_type = 'refund_security_adjudication'
          AND journal.source_id = adjudication.id
         JOIN ledger_lines line
           ON line.journal_id = journal.id
          AND line.account_code = 'refund_discrepancy_suspense'
         WHERE adjudication.refund_id = $1
       ), '0') AS suspense_credit,
       COALESCE((
         SELECT sum(line.debit_minor)::text
         FROM refund_security_hold_adjudications adjudication
         JOIN ledger_journals journal
           ON journal.source_type = 'refund_security_adjudication'
          AND journal.source_id = adjudication.id
         JOIN ledger_lines line
           ON line.journal_id = journal.id
          AND line.account_code = 'sales_refunds_and_allowances'
         WHERE adjudication.refund_id = $1
       ), '0') AS refund_expense_debit,
       COALESCE((
         SELECT sum(line.credit_minor)::text
         FROM refund_security_hold_adjudications adjudication
         JOIN ledger_journals journal
           ON journal.source_type = 'refund_security_adjudication'
          AND journal.source_id = adjudication.id
         JOIN ledger_lines line
           ON line.journal_id = journal.id AND line.account_code = 'mock_cash'
         WHERE adjudication.refund_id = $1
       ), '0') AS adjudication_cash_credit`,
    [failedThenSucceeded.refundId],
  );
  assert.equal(adjudicationAccounting.rows[0]?.settlements, "1");
  assert.equal(adjudicationAccounting.rows[0]?.adjudications, "4");
  assert.equal(adjudicationAccounting.rows[0]?.discrepancy_cash_credit, "90");
  assert.equal(adjudicationAccounting.rows[0]?.suspense_debit, "90");
  assert.equal(adjudicationAccounting.rows[0]?.suspense_credit, "90");
  assert.equal(adjudicationAccounting.rows[0]?.refund_expense_debit, "90");
  assert.equal(adjudicationAccounting.rows[0]?.adjudication_cash_credit, "0");
  const releasedCandidates = await request<{ items: RefundCandidate[] }>(
    "/api/v1/admin/refund-candidates",
  );
  assert.equal(
    releasedCandidates.items.some(
      (candidate) => candidate.receiptId === securityCandidate.receiptId,
    ),
    true,
  );

  const adjudicationGuardClient = await corePool.connect();
  let rejectedAdjudicationMutation = false;
  try {
    await adjudicationGuardClient.query("BEGIN");
    await adjudicationGuardClient.query(
      `UPDATE refund_security_hold_adjudications
       SET reason = reason || ' forbidden'
       WHERE id = $1`,
      [acceptedAdjudication.adjudicationId],
    );
    await adjudicationGuardClient.query("COMMIT");
  } catch {
    rejectedAdjudicationMutation = true;
    await adjudicationGuardClient.query("ROLLBACK");
  } finally {
    adjudicationGuardClient.release();
  }
  assert.equal(rejectedAdjudicationMutation, true);

  const externalReuseOrder = await createOrder(automaticPrice.id, legal);
  const paidExternalReuseOrder = await pay(externalReuseOrder, "success");
  assert.equal(paidExternalReuseOrder.invoice.status, "paid");
  const externalReuseCandidates = await request<{ items: RefundCandidate[] }>(
    "/api/v1/admin/refund-candidates",
  );
  const externalReuseCandidate = externalReuseCandidates.items.find(
    (candidate) => candidate.invoiceId === externalReuseOrder.invoice.id,
  );
  assert.ok(externalReuseCandidate);
  const externalReuseRefund = await request<RefundRecord>(
    `/api/v1/admin/invoices/${externalReuseOrder.invoice.id}/refunds`,
    {
      method: "POST",
      body: JSON.stringify({
        receiptId: externalReuseCandidate.receiptId,
        destination: "original_payment",
        amountMode: "partial",
        amountMinor: "25",
        expectedRefundableMinor: externalReuseCandidate.refundableMinor,
        scenario: "success",
        reason: "Synthetic refund tests failed-fact external id ownership enforcement",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  assert.ok(externalReuseRefund.providerOperationId);
  await corePool.query(
    `UPDATE refunds
     SET status = 'processing', updated_at = now(), version = version + 1
     WHERE id = $1 AND status = 'queued'`,
    [externalReuseRefund.refundId],
  );
  await corePool.query(
    `UPDATE provider_operations
     SET status = 'running', attempt_count = 1, updated_at = now()
     WHERE id = $1 AND status = 'queued'`,
    [externalReuseRefund.providerOperationId],
  );
  await corePool.query(
    `UPDATE durable_jobs
     SET status = 'manual', last_error = 'synthetic callback ownership gate', updated_at = now()
     WHERE job_type = 'refund.start' AND payload->>'refundId' = $1`,
    [externalReuseRefund.refundId],
  );
  const reusedExternalIdFailure = await submitRefundFact({
    eventId: `refund-failed-external-reuse:${randomUUID()}`,
    providerOperationId: externalReuseRefund.providerOperationId,
    refundId: externalReuseRefund.refundId,
    externalRefundId: originalSuccessRefund.externalRefundId,
    status: "failed",
    amountMinor: "25",
    currency: "USD",
    occurredAt: new Date().toISOString(),
  });
  assert.equal(reusedExternalIdFailure.status, 202);
  assert.equal(reusedExternalIdFailure.body.status, "manual");
  assert.equal(reusedExternalIdFailure.body.reason, "refund.external_id_conflict");
  const externalReuseHeld = await request<RefundRecord>(
    `/api/v1/admin/refunds/${externalReuseRefund.refundId}`,
  );
  assert.equal(externalReuseHeld.status, "manual");
  assert.equal(externalReuseHeld.securityHold, true);
  const externalReuseHolds = await request<{ items: RefundSecurityHold[] }>(
    "/api/v1/admin/refund-security-holds",
  );
  const externalReuseHold = externalReuseHolds.items.find(
    (hold) => hold.refundId === externalReuseRefund.refundId,
  );
  assert.ok(externalReuseHold);
  assert.equal(externalReuseHold.discrepancy, null);
  await adjudicateRefundHold(
    externalReuseHold,
    "dismiss_provider_claim",
    "Synthetic human dismissed a failed fact that reused another refund identity",
  );
  const externalReuseResolved = await request<RefundRecord>(
    `/api/v1/admin/refunds/${externalReuseRefund.refundId}`,
  );
  assert.equal(externalReuseResolved.status, "failed");
  assert.equal(externalReuseResolved.securityHold, false);

  const settledExternalIdReuse = await submitRefundFact({
    eventId: `refund-success-settled-external-reuse:${randomUUID()}`,
    providerOperationId: externalReuseRefund.providerOperationId,
    refundId: externalReuseRefund.refundId,
    externalRefundId: originalSuccessRefund.externalRefundId,
    status: "succeeded",
    amountMinor: "25",
    currency: "USD",
    occurredAt: new Date(Date.now() + 500).toISOString(),
  });
  assert.equal(settledExternalIdReuse.status, 202);
  assert.equal(settledExternalIdReuse.body.status, "manual");
  assert.equal(settledExternalIdReuse.body.reason, "refund.external_id_conflict");
  const settledExternalIdReuseHolds = await request<{ items: RefundSecurityHold[] }>(
    "/api/v1/admin/refund-security-holds",
  );
  const settledExternalIdReuseHold = settledExternalIdReuseHolds.items.find(
    (hold) => hold.refundId === externalReuseRefund.refundId,
  );
  assert.ok(settledExternalIdReuseHold);
  const rejectedSettledExternalIdRecord = await rawCoreRequest(
    `/api/v1/admin/refund-security-holds/${settledExternalIdReuseHold.holdId}/adjudications`,
    {
      method: "POST",
      body: JSON.stringify({
        decision: "record_unexpected_outflow",
        reason: "Synthetic reused Provider identity must never reduce mock cash twice",
        idempotencyKey: randomUUID(),
        expectedRefundVersion: settledExternalIdReuseHold.refundVersion,
      }),
    },
  );
  assert.equal(rejectedSettledExternalIdRecord.status, 422);
  assert.equal(rejectedSettledExternalIdRecord.body.code, "REFUND_EXTERNAL_ID_ALREADY_OWNED");
  const settledExternalOwner = await corePool.query<{
    settlements: string;
    discrepancies: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM refund_settlements
        WHERE provider_installation_id = 'mock-payment-v1'
          AND external_refund_id = $1) AS settlements,
       (SELECT count(*)::text FROM refund_discrepancy_settlements
        WHERE provider_installation_id = 'mock-payment-v1'
          AND external_refund_id = $1) AS discrepancies`,
    [originalSuccessRefund.externalRefundId],
  );
  assert.equal(settledExternalOwner.rows[0]?.settlements, "1");
  assert.equal(settledExternalOwner.rows[0]?.discrepancies, "0");
  await adjudicateRefundHold(
    settledExternalIdReuseHold,
    "dismiss_provider_claim",
    "Synthetic human dismissed a success claim that reused a settled Provider identity",
  );

  const dismissedSuccessOccurredAt = new Date().toISOString();
  const dismissedSuccessExternalId = `mock-refund-dismissed-success:${externalReuseRefund.refundId}`;
  const successAfterDismissal = await submitRefundFact({
    eventId: `refund-success-after-dismissal:${randomUUID()}`,
    providerOperationId: externalReuseRefund.providerOperationId,
    refundId: externalReuseRefund.refundId,
    externalRefundId: dismissedSuccessExternalId,
    status: "succeeded",
    amountMinor: "25",
    currency: "USD",
    occurredAt: dismissedSuccessOccurredAt,
  });
  assert.equal(successAfterDismissal.status, 202);
  assert.equal(successAfterDismissal.body.status, "manual");
  const successAfterDismissalHolds = await request<{ items: RefundSecurityHold[] }>(
    "/api/v1/admin/refund-security-holds",
  );
  const successAfterDismissalHold = successAfterDismissalHolds.items.find(
    (hold) => hold.refundId === externalReuseRefund.refundId,
  );
  assert.ok(successAfterDismissalHold);
  const dismissedSuccessAdjudication = await adjudicateRefundHold(
    successAfterDismissalHold,
    "dismiss_provider_claim",
    "Synthetic human dismissed a late Provider success after reconciliation",
  );
  const correctionRaceCandidates = await request<{ items: RefundCandidate[] }>(
    "/api/v1/admin/refund-candidates",
  );
  const correctionRaceCandidate = correctionRaceCandidates.items.find(
    (candidate) => candidate.receiptId === externalReuseCandidate.receiptId,
  );
  assert.ok(correctionRaceCandidate);
  const correctionCompetingRefund = await request<RefundRecord>(
    `/api/v1/admin/invoices/${externalReuseOrder.invoice.id}/refunds`,
    {
      method: "POST",
      body: JSON.stringify({
        receiptId: correctionRaceCandidate.receiptId,
        destination: "original_payment",
        amountMode: "full",
        amountMinor: null,
        expectedRefundableMinor: correctionRaceCandidate.refundableMinor,
        scenario: "success",
        reason:
          "Synthetic full refund queues before a dismissed Provider outflow is corrected",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  assert.equal(correctionCompetingRefund.status, "queued");
  assert.ok(correctionCompetingRefund.providerOperationId);
  const correctableDismissals = await request<{ items: RefundDismissalCorrection[] }>(
    "/api/v1/admin/refund-dismissal-corrections",
  );
  const correctableDismissal = correctableDismissals.items.find(
    (item) => item.adjudicationId === dismissedSuccessAdjudication.adjudicationId,
  );
  assert.ok(correctableDismissal);
  assert.equal(correctableDismissal.discrepancyId !== null, true);
  const correctionIdempotencyKey = randomUUID();
  const correctedDismissal = await request<{
    correctionId: string;
    status: string;
    replayed: boolean;
  }>(
    `/api/v1/admin/refund-adjudications/${correctableDismissal.adjudicationId}/corrections`,
    {
      method: "POST",
      body: JSON.stringify({
        reason: "Synthetic later evidence confirmed the dismissed Provider cash outflow",
        idempotencyKey: correctionIdempotencyKey,
        expectedRefundVersion: correctableDismissal.refundVersion,
      }),
    },
    201,
  );
  assert.equal(correctedDismissal.status, "dismissed_outflow_confirmed");
  assert.equal(correctedDismissal.replayed, false);
  const correctedDismissalReplay = await request<{
    correctionId: string;
    replayed: boolean;
  }>(
    `/api/v1/admin/refund-adjudications/${correctableDismissal.adjudicationId}/corrections`,
    {
      method: "POST",
      body: JSON.stringify({
        reason: "Synthetic later evidence confirmed the dismissed Provider cash outflow",
        idempotencyKey: correctionIdempotencyKey,
        expectedRefundVersion: correctableDismissal.refundVersion,
      }),
    },
    200,
  );
  assert.equal(correctedDismissalReplay.correctionId, correctedDismissal.correctionId);
  assert.equal(correctedDismissalReplay.replayed, true);
  const correctionAccounting = await corePool.query<{
    corrections: string;
    suspense_debit: string;
    cash_credit: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM refund_adjudication_corrections
        WHERE adjudication_id = $1) AS corrections,
       COALESCE(sum(line.debit_minor) FILTER (
         WHERE line.account_code = 'refund_discrepancy_suspense'
       ), 0)::text AS suspense_debit,
       COALESCE(sum(line.credit_minor) FILTER (
         WHERE line.account_code = 'mock_cash'
       ), 0)::text AS cash_credit
     FROM refund_adjudication_corrections correction
     JOIN ledger_journals journal
       ON journal.source_type = 'refund_adjudication_correction'
      AND journal.source_id = correction.id
     JOIN ledger_lines line ON line.journal_id = journal.id
     WHERE correction.adjudication_id = $1`,
    [correctableDismissal.adjudicationId],
  );
  assert.equal(correctionAccounting.rows[0]?.corrections, "1");
  assert.equal(correctionAccounting.rows[0]?.suspense_debit, "25");
  assert.equal(correctionAccounting.rows[0]?.cash_credit, "25");
  const correctedOperation = await request<RefundRecord>(
    `/api/v1/admin/refunds/${externalReuseRefund.refundId}`,
  );
  assert.equal(correctedOperation.status, "failed");
  assert.equal(correctedOperation.providerOperationStatus, "succeeded");
  assert.equal(correctedOperation.externalRefundId, dismissedSuccessExternalId);
  const frozenCorrectionCompetitor = await corePool.query<{
    refund_status: string;
    refund_security_hold: boolean;
    frozen_by_correction_id: string | null;
    operation_status: string;
    operation_attempt_count: number;
    job_status: string;
  }>(
    `SELECT
       refund.status AS refund_status,
       refund.security_hold AS refund_security_hold,
       refund.result->>'frozenByCorrectionId' AS frozen_by_correction_id,
       operation.status AS operation_status,
       operation.attempt_count AS operation_attempt_count,
       job.status AS job_status
     FROM refunds refund
     JOIN provider_operations operation
       ON operation.subject_type = 'refund'
      AND operation.subject_id = refund.id
      AND operation.kind = 'refund_create'
     JOIN durable_jobs job
       ON job.job_type = 'refund.start'
      AND job.payload->>'refundId' = refund.id::text
     WHERE refund.id = $1`,
    [correctionCompetingRefund.refundId],
  );
  const frozenCorrectionState = frozenCorrectionCompetitor.rows[0];
  assert.ok(frozenCorrectionState);
  assert.equal(frozenCorrectionState.refund_status, "failed");
  assert.equal(frozenCorrectionState.refund_security_hold, false);
  assert.equal(
    frozenCorrectionState.frozen_by_correction_id,
    correctedDismissal.correctionId,
  );
  assert.equal(frozenCorrectionState.operation_status, "failed");
  assert.equal(frozenCorrectionState.operation_attempt_count, 0);
  assert.equal(frozenCorrectionState.job_status, "completed");
  const correctionRaceProviderCalls = await providerPool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM mock_refund_operations WHERE refund_id = $1`,
    [correctionCompetingRefund.refundId],
  );
  assert.equal(correctionRaceProviderCalls.rows[0]?.count, "0");
  const dismissedFactReplay = await submitRefundFact({
    eventId: `refund-dismissed-fact-replay:${randomUUID()}`,
    providerOperationId: externalReuseRefund.providerOperationId,
    refundId: externalReuseRefund.refundId,
    externalRefundId: dismissedSuccessExternalId,
    status: "succeeded",
    amountMinor: "25",
    currency: "USD",
    occurredAt: dismissedSuccessOccurredAt,
  });
  assert.equal(dismissedFactReplay.status, 202);
  assert.equal(dismissedFactReplay.body.reason, "provider_fact_already_adjudicated");
  const dismissedFactReplayState = await request<RefundRecord>(
    `/api/v1/admin/refunds/${externalReuseRefund.refundId}`,
  );
  assert.equal(dismissedFactReplayState.status, "failed");
  assert.equal(dismissedFactReplayState.securityHold, false);
  const dismissedFactReplayHolds = await request<{ items: RefundSecurityHold[] }>(
    "/api/v1/admin/refund-security-holds",
  );
  assert.equal(
    dismissedFactReplayHolds.items.some(
      (hold) => hold.refundId === externalReuseRefund.refundId,
    ),
    false,
  );

  const secondDistinctSuccess = await submitRefundFact({
    eventId: `refund-distinct-success-after-dismissal:${randomUUID()}`,
    providerOperationId: externalReuseRefund.providerOperationId,
    refundId: externalReuseRefund.refundId,
    externalRefundId: `mock-refund-distinct-after-dismissal:${externalReuseRefund.refundId}`,
    status: "succeeded",
    amountMinor: "25",
    currency: "USD",
    occurredAt: new Date(Date.now() + 1_000).toISOString(),
  });
  assert.equal(secondDistinctSuccess.status, 202);
  assert.equal(secondDistinctSuccess.body.status, "manual");
  const distinctSuccessHolds = await request<{ items: RefundSecurityHold[] }>(
    "/api/v1/admin/refund-security-holds",
  );
  const distinctSuccessHold = distinctSuccessHolds.items.find(
    (hold) => hold.refundId === externalReuseRefund.refundId,
  );
  assert.ok(distinctSuccessHold);
  assert.equal(distinctSuccessHold.discrepancy, null);
  assert.deepEqual(distinctSuccessHold.allowedDecisions, [
    "record_unexpected_outflow",
    "dismiss_provider_claim",
  ]);
  const rejectedOldDiscrepancyReuse = await rawCoreRequest(
    `/api/v1/admin/refund-security-holds/${distinctSuccessHold.holdId}/adjudications`,
    {
      method: "POST",
      body: JSON.stringify({
        decision: "accept_authorized_outflow",
        reason: "Synthetic old discrepancy must not be accepted for a distinct Provider fact",
        idempotencyKey: randomUUID(),
        expectedRefundVersion: distinctSuccessHold.refundVersion,
      }),
    },
  );
  assert.equal(rejectedOldDiscrepancyReuse.status, 422);
  assert.equal(rejectedOldDiscrepancyReuse.body.code, "REFUND_OUTFLOW_NOT_ACCEPTABLE");
  await adjudicateRefundHold(
    distinctSuccessHold,
    "record_unexpected_outflow",
    "Synthetic human verified the separate unexpected Provider cash outflow",
  );
  const recordedUnexpectedOutflow = await corePool.query<{
    settlements: string;
    suspense_debit: string;
    cash_credit: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM refund_settlements WHERE refund_id = $1) AS settlements,
       COALESCE((
         SELECT sum(line.debit_minor)::text
         FROM refund_security_hold_adjudications adjudication
         JOIN refund_discrepancy_settlements discrepancy
           ON discrepancy.id = adjudication.discrepancy_settlement_id
         JOIN ledger_journals journal
           ON journal.source_type = 'refund_provider_discrepancy'
          AND journal.source_id = discrepancy.id
         JOIN ledger_lines line
           ON line.journal_id = journal.id
          AND line.account_code = 'refund_discrepancy_suspense'
         WHERE adjudication.refund_id = $1
           AND adjudication.decision = 'record_unexpected_outflow'
       ), '0') AS suspense_debit,
       COALESCE((
         SELECT sum(line.credit_minor)::text
         FROM refund_security_hold_adjudications adjudication
         JOIN refund_discrepancy_settlements discrepancy
           ON discrepancy.id = adjudication.discrepancy_settlement_id
         JOIN ledger_journals journal
           ON journal.source_type = 'refund_provider_discrepancy'
          AND journal.source_id = discrepancy.id
         JOIN ledger_lines line
           ON line.journal_id = journal.id
          AND line.account_code = 'mock_cash'
         WHERE adjudication.refund_id = $1
           AND adjudication.decision = 'record_unexpected_outflow'
       ), '0') AS cash_credit`,
    [externalReuseRefund.refundId],
  );
  assert.equal(recordedUnexpectedOutflow.rows[0]?.settlements, "0");
  assert.equal(recordedUnexpectedOutflow.rows[0]?.suspense_debit, "25");
  assert.equal(recordedUnexpectedOutflow.rows[0]?.cash_credit, "25");

  const wrongCurrencySuccess = await submitRefundFact({
    eventId: `refund-wrong-currency-unexpected-outflow:${randomUUID()}`,
    providerOperationId: externalReuseRefund.providerOperationId,
    refundId: externalReuseRefund.refundId,
    externalRefundId: `mock-refund-wrong-currency:${externalReuseRefund.refundId}`,
    status: "succeeded",
    amountMinor: "25",
    currency: "EUR",
    occurredAt: new Date(Date.now() + 2_000).toISOString(),
  });
  assert.equal(wrongCurrencySuccess.status, 202);
  assert.equal(wrongCurrencySuccess.body.status, "manual");
  const wrongCurrencyHolds = await request<{ items: RefundSecurityHold[] }>(
    "/api/v1/admin/refund-security-holds",
  );
  const wrongCurrencyHold = wrongCurrencyHolds.items.find(
    (hold) => hold.refundId === externalReuseRefund.refundId,
  );
  assert.ok(wrongCurrencyHold);
  assert.equal(wrongCurrencyHold.providerFact.currency, "EUR");
  assert.equal(wrongCurrencyHold.discrepancy, null);
  await adjudicateRefundHold(
    wrongCurrencyHold,
    "record_unexpected_outflow",
    "Synthetic human verified a wrong-currency Provider outflow without an FX allocation",
  );
  const wrongCurrencyLedger = await corePool.query<{
    suspense_debit: string;
    cash_credit: string;
  }>(
    `SELECT
       COALESCE(sum(line.debit_minor) FILTER (
         WHERE line.account_code = 'refund_discrepancy_suspense'
       ), 0)::text AS suspense_debit,
       COALESCE(sum(line.credit_minor) FILTER (
         WHERE line.account_code = 'mock_cash'
       ), 0)::text AS cash_credit
     FROM refund_security_hold_adjudications adjudication
     JOIN refund_discrepancy_settlements discrepancy
       ON discrepancy.id = adjudication.discrepancy_settlement_id
      AND discrepancy.currency = 'EUR'
     JOIN ledger_journals journal
       ON journal.source_type = 'refund_provider_discrepancy'
      AND journal.source_id = discrepancy.id
      AND journal.currency = discrepancy.currency
     JOIN ledger_lines line ON line.journal_id = journal.id
     WHERE adjudication.refund_id = $1
       AND adjudication.decision = 'record_unexpected_outflow'`,
    [externalReuseRefund.refundId],
  );
  assert.equal(wrongCurrencyLedger.rows[0]?.suspense_debit, "25");
  assert.equal(wrongCurrencyLedger.rows[0]?.cash_credit, "25");

  const staleStartCandidates = await request<{ items: RefundCandidate[] }>(
    "/api/v1/admin/refund-candidates",
  );
  const staleStartCandidate = staleStartCandidates.items.find(
    (candidate) => candidate.receiptId === externalReuseCandidate.receiptId,
  );
  assert.ok(staleStartCandidate);
  assert.equal(
    BigInt(staleStartCandidate.refundableMinor),
    BigInt(externalReuseCandidate.refundableMinor) - 50n,
  );
  const staleKnownUnsent = await request<RefundRecord>(
    `/api/v1/admin/invoices/${externalReuseOrder.invoice.id}/refunds`,
    {
      method: "POST",
      body: JSON.stringify({
        receiptId: staleStartCandidate.receiptId,
        destination: "original_payment",
        amountMode: "partial",
        amountMinor: "20",
        expectedRefundableMinor: staleStartCandidate.refundableMinor,
        scenario: "success",
        reason: "Synthetic known-unsent stale refund start exhausts safely",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  await corePool.query(
    `UPDATE durable_jobs
     SET status = 'running', attempts = 8,
         locked_at = now() - interval '10 seconds', locked_by = 'dead-refund-worker',
         updated_at = now()
     WHERE job_type = 'refund.start' AND payload->>'refundId' = $1`,
    [staleKnownUnsent.refundId],
  );
  const recoveredKnownUnsent = await waitFor(
    "stale known-unsent refund start to fail without a Provider call",
    async () => {
      const result = await corePool.query<{
        refund_status: string;
        operation_status: string;
        attempt_count: number;
        job_status: string;
        events: string;
        audits: string;
      }>(
        `SELECT
           refund.status AS refund_status,
           operation.status AS operation_status,
           operation.attempt_count,
           job.status AS job_status,
           (SELECT count(*)::text FROM refund_events event
            WHERE event.refund_id = refund.id AND event.event_type = 'failed') AS events,
           (SELECT count(*)::text FROM audit_events audit
            WHERE audit.target_type = 'refund' AND audit.target_id = refund.id::text
              AND audit.action = 'refund.known_unsent_rejected') AS audits
         FROM refunds refund
         JOIN provider_operations operation
           ON operation.subject_type = 'refund'
          AND operation.subject_id = refund.id
          AND operation.kind = 'refund_create'
         JOIN durable_jobs job
           ON job.job_type = 'refund.start' AND job.payload->>'refundId' = refund.id::text
         WHERE refund.id = $1`,
        [staleKnownUnsent.refundId],
      );
      return result.rows[0];
    },
    (state) => state?.refund_status === "failed" && state.job_status === "completed",
    15_000,
  );
  assert.ok(recoveredKnownUnsent);
  assert.equal(recoveredKnownUnsent.operation_status, "failed");
  assert.equal(recoveredKnownUnsent.attempt_count, 0);
  assert.equal(recoveredKnownUnsent.events, "1");
  assert.equal(recoveredKnownUnsent.audits, "1");
  const knownUnsentProviderCalls = await providerPool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM mock_refund_operations WHERE refund_id = $1`,
    [staleKnownUnsent.refundId],
  );
  assert.equal(knownUnsentProviderCalls.rows[0]?.count, "0");

  const staleReconcileCandidates = await request<{ items: RefundCandidate[] }>(
    "/api/v1/admin/refund-candidates",
  );
  const staleReconcileCandidate = staleReconcileCandidates.items.find(
    (candidate) => candidate.receiptId === externalReuseCandidate.receiptId,
  );
  assert.ok(staleReconcileCandidate);
  const staleReconcileRefund = await request<RefundRecord>(
    `/api/v1/admin/invoices/${externalReuseOrder.invoice.id}/refunds`,
    {
      method: "POST",
      body: JSON.stringify({
        receiptId: staleReconcileCandidate.receiptId,
        destination: "original_payment",
        amountMode: "partial",
        amountMinor: "20",
        expectedRefundableMinor: staleReconcileCandidate.refundableMinor,
        scenario: "timeout_success",
        reason: "Synthetic stale refund reconciliation exhausts into manual review",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  assert.ok(staleReconcileRefund.providerOperationId);
  await corePool.query(
    `UPDATE refunds
     SET status = 'processing', updated_at = now(), version = version + 1
     WHERE id = $1 AND status = 'queued'`,
    [staleReconcileRefund.refundId],
  );
  await corePool.query(
    `UPDATE refunds
     SET status = 'unknown', updated_at = now(), version = version + 1
     WHERE id = $1 AND status = 'processing'`,
    [staleReconcileRefund.refundId],
  );
  await corePool.query(
    `UPDATE provider_operations
     SET status = 'unknown', attempt_count = 1, updated_at = now()
     WHERE id = $1 AND status = 'queued'`,
    [staleReconcileRefund.providerOperationId],
  );
  await corePool.query(
    `UPDATE durable_jobs
     SET status = 'completed', updated_at = now()
     WHERE job_type = 'refund.start' AND payload->>'refundId' = $1`,
    [staleReconcileRefund.refundId],
  );
  await corePool.query(
    `INSERT INTO durable_jobs(
       job_type, unique_key, payload, status, attempts, locked_at, locked_by
     ) VALUES (
       'refund.reconcile', $1, $2, 'running', 8,
       now() - interval '10 seconds', 'dead-refund-reconcile-worker'
     )`,
    [
      `refund:${staleReconcileRefund.refundId}`,
      {
        refundId: staleReconcileRefund.refundId,
        operationId: staleReconcileRefund.providerOperationId,
      },
    ],
  );
  const recoveredReconcile = await waitFor(
    "stale refund reconciliation exhaustion to synchronize the manual queue",
    async () => {
      const result = await corePool.query<{
        refund_status: string;
        operation_status: string;
        job_status: string;
        events: string;
        audits: string;
      }>(
        `SELECT
           refund.status AS refund_status,
           operation.status AS operation_status,
           job.status AS job_status,
           (SELECT count(*)::text FROM refund_events event
            WHERE event.refund_id = refund.id AND event.event_type = 'manual') AS events,
           (SELECT count(*)::text FROM audit_events audit
            WHERE audit.target_type = 'refund' AND audit.target_id = refund.id::text
              AND audit.action = 'refund.reconciliation_exhausted') AS audits
         FROM refunds refund
         JOIN provider_operations operation ON operation.id = $2
         JOIN durable_jobs job
           ON job.job_type = 'refund.reconcile' AND job.unique_key = $3
         WHERE refund.id = $1`,
        [
          staleReconcileRefund.refundId,
          staleReconcileRefund.providerOperationId,
          `refund:${staleReconcileRefund.refundId}`,
        ],
      );
      return result.rows[0];
    },
    (state) => state?.refund_status === "manual" && state.job_status === "manual",
    15_000,
  );
  assert.ok(recoveredReconcile);
  assert.equal(recoveredReconcile.operation_status, "unknown");
  assert.equal(recoveredReconcile.events, "1");
  assert.equal(recoveredReconcile.audits, "1");
  const staleManualRefund = await request<RefundRecord>(
    `/api/v1/admin/refunds/${staleReconcileRefund.refundId}`,
  );
  const retryQueryKey = randomUUID();
  const retryQueryBody = {
    action: "retry_query",
    reason: "Synthetic administrator retried the exhausted refund using Provider query only",
    idempotencyKey: retryQueryKey,
    expectedRefundVersion: staleManualRefund.version,
  };
  const retryQuery = await request<{ actionId: string; status: string; replayed: boolean }>(
    `/api/v1/admin/refunds/${staleReconcileRefund.refundId}/manual-actions`,
    { method: "POST", body: JSON.stringify(retryQueryBody) },
    201,
  );
  assert.equal(retryQuery.status, "query_scheduled");
  const retryQueryReplay = await request<{
    actionId: string;
    status: string;
    replayed: boolean;
  }>(
    `/api/v1/admin/refunds/${staleReconcileRefund.refundId}/manual-actions`,
    { method: "POST", body: JSON.stringify(retryQueryBody) },
    200,
  );
  assert.equal(retryQueryReplay.actionId, retryQuery.actionId);
  assert.equal(retryQueryReplay.replayed, true);
  const staleRetryProviderCreates = await providerPool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM mock_refund_operations WHERE refund_id = $1`,
    [staleReconcileRefund.refundId],
  );
  assert.equal(staleRetryProviderCreates.rows[0]?.count, "0");
} finally {
  await dropRefundStartDelay();
}

assert.ok(originalSuccessRefund.providerOperationId);
assert.ok(originalSuccessRefund.externalRefundId);
const settledConflict = await submitRefundFact({
  eventId: `refund-settled-conflict:${randomUUID()}`,
  providerOperationId: originalSuccessRefund.providerOperationId,
  refundId: originalSuccessRefund.refundId,
  externalRefundId: `mock-refund-conflict:${originalSuccessRefund.refundId}`,
  status: "failed",
  amountMinor: "81",
  currency: "EUR",
  occurredAt: new Date(0).toISOString(),
});
assert.equal(settledConflict.status, 202);
assert.equal(settledConflict.body.status, "succeeded");
assert.equal(settledConflict.body.securityHold, true);
const settledConflictRecord = await request<RefundRecord>(
  `/api/v1/admin/refunds/${originalSuccessRefund.refundId}`,
);
assert.equal(settledConflictRecord.status, "succeeded");
assert.equal(settledConflictRecord.securityHold, true);
assert.match(settledConflictRecord.securityHoldReason ?? "", /canonical settled refund/i);
const settledConflictHolds = await request<{ items: RefundSecurityHold[] }>(
  "/api/v1/admin/refund-security-holds",
);
const settledConflictHold = settledConflictHolds.items.find(
  (hold) => hold.refundId === originalSuccessRefund.refundId,
);
assert.ok(settledConflictHold);
assert.equal(settledConflictHold.discrepancy, null);
assert.deepEqual(settledConflictHold.allowedDecisions, ["dismiss_provider_claim"]);
await adjudicateRefundHold(
  settledConflictHold,
  "dismiss_provider_claim",
  "Synthetic human dismissed a stale conflicting claim on a settled refund",
);
const settledAfterDismissal = await request<RefundRecord>(
  `/api/v1/admin/refunds/${originalSuccessRefund.refundId}`,
);
assert.equal(settledAfterDismissal.status, "succeeded");
assert.equal(settledAfterDismissal.securityHold, false);
assert.equal(settledAfterDismissal.externalRefundId, originalSuccessRefund.externalRefundId);
const settledConflictAccounting = await corePool.query<{
  settlements: string;
  discrepancy_settlements: string;
  adjudication_journals: string;
}>(
  `SELECT
     (SELECT count(*)::text FROM refund_settlements WHERE refund_id = $1) AS settlements,
     (SELECT count(*)::text FROM refund_discrepancy_settlements WHERE refund_id = $1)
       AS discrepancy_settlements,
     (SELECT count(*)::text
      FROM refund_security_hold_adjudications adjudication
      JOIN ledger_journals journal
        ON journal.source_type = 'refund_security_adjudication'
       AND journal.source_id = adjudication.id
      WHERE adjudication.refund_id = $1) AS adjudication_journals`,
  [originalSuccessRefund.refundId],
);
assert.equal(settledConflictAccounting.rows[0]?.settlements, "1");
assert.equal(settledConflictAccounting.rows[0]?.discrepancy_settlements, "0");
assert.equal(settledConflictAccounting.rows[0]?.adjudication_journals, "0");

await request(
  "/api/v1/auth/reauth",
  { method: "POST", body: JSON.stringify({ password }) },
  200,
);
const browserAdjudicationOrder = await createOrder(automaticPrice.id, legal);
const paidBrowserAdjudicationOrder = await pay(browserAdjudicationOrder, "success");
assert.equal(paidBrowserAdjudicationOrder.invoice.status, "paid");
const browserAdjudicationCandidates = await request<{ items: RefundCandidate[] }>(
  "/api/v1/admin/refund-candidates",
);
const browserAdjudicationCandidate = browserAdjudicationCandidates.items.find(
  (candidate) => candidate.invoiceId === browserAdjudicationOrder.invoice.id,
);
assert.ok(browserAdjudicationCandidate);
const browserFailedRefund = await request<RefundRecord>(
  `/api/v1/admin/invoices/${browserAdjudicationOrder.invoice.id}/refunds`,
  {
    method: "POST",
    body: JSON.stringify({
      receiptId: browserAdjudicationCandidate.receiptId,
      destination: "original_payment",
      amountMode: "partial",
      amountMinor: "35",
      expectedRefundableMinor: browserAdjudicationCandidate.refundableMinor,
      scenario: "failed",
      reason: "Synthetic browser refund first fails before an exact late cash outflow",
      idempotencyKey: randomUUID(),
    }),
  },
  202,
);
const browserInitiallyFailed = await waitFor(
  "browser refund Provider to report a definitive failure",
  () => request<RefundRecord>(`/api/v1/admin/refunds/${browserFailedRefund.refundId}`),
  (refund) => refund.status === "failed",
  35_000,
);
assert.ok(browserInitiallyFailed.providerOperationId);
const browserAdjudicationConflict = await submitRefundFact({
  eventId: `refund-browser-adjudication:${randomUUID()}`,
  providerOperationId: browserInitiallyFailed.providerOperationId,
  refundId: browserInitiallyFailed.refundId,
  externalRefundId: `mock-refund-browser-outflow:${browserInitiallyFailed.refundId}`,
  status: "succeeded",
  amountMinor: "35",
  currency: "USD",
  occurredAt: new Date().toISOString(),
});
assert.equal(browserAdjudicationConflict.status, 202);
assert.equal(browserAdjudicationConflict.body.securityHold, true);
const browserAdjudicationHolds = await request<{ items: RefundSecurityHold[] }>(
  "/api/v1/admin/refund-security-holds",
);
const browserAdjudicationHold = browserAdjudicationHolds.items.find(
  (hold) => hold.refundId === browserInitiallyFailed.refundId,
);
assert.ok(browserAdjudicationHold, "the browser journey must receive a persisted cash hold");
assert.ok(browserAdjudicationHold.discrepancy);
assert.deepEqual(browserAdjudicationHold.allowedDecisions, [
  "accept_authorized_outflow",
  "record_unexpected_outflow",
  "dismiss_provider_claim",
]);

async function createBrowserLateSuccessHold(input: {
  authorizedAmountMinor: string;
  reportedAmountMinor: string;
  reportedCurrency: string;
  label: string;
}): Promise<RefundSecurityHold> {
  const order = await createOrder(automaticPrice!.id, legal);
  const paidOrder = await pay(order, "success");
  assert.equal(paidOrder.invoice.status, "paid");
  const candidates = await request<{ items: RefundCandidate[] }>(
    "/api/v1/admin/refund-candidates",
  );
  const candidate = candidates.items.find((item) => item.invoiceId === order.invoice.id);
  assert.ok(candidate);
  const failedRefund = await request<RefundRecord>(
    `/api/v1/admin/invoices/${order.invoice.id}/refunds`,
    {
      method: "POST",
      body: JSON.stringify({
        receiptId: candidate.receiptId,
        destination: "original_payment",
        amountMode: "partial",
        amountMinor: input.authorizedAmountMinor,
        expectedRefundableMinor: candidate.refundableMinor,
        scenario: "failed",
        reason: `Synthetic browser ${input.label} first records a definitive Provider failure`,
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  const terminal = await waitFor(
    `browser ${input.label} refund failure`,
    () => request<RefundRecord>(`/api/v1/admin/refunds/${failedRefund.refundId}`),
    (refund) => refund.status === "failed",
    35_000,
  );
  assert.ok(terminal.providerOperationId);
  const providerFact = await submitRefundFact({
    eventId: `refund-browser-${input.label}:${randomUUID()}`,
    providerOperationId: terminal.providerOperationId,
    refundId: terminal.refundId,
    externalRefundId: `mock-refund-browser-${input.label}:${terminal.refundId}`,
    status: "succeeded",
    amountMinor: input.reportedAmountMinor,
    currency: input.reportedCurrency,
    occurredAt: new Date().toISOString(),
  });
  assert.equal(providerFact.status, 202);
  const holds = await request<{ items: RefundSecurityHold[] }>(
    "/api/v1/admin/refund-security-holds",
  );
  const hold = holds.items.find((item) => item.refundId === terminal.refundId);
  assert.ok(hold);
  return hold;
}

const browserDismissalHold = await createBrowserLateSuccessHold({
  authorizedAmountMinor: "31",
  reportedAmountMinor: "31",
  reportedCurrency: "USD",
  label: "dismissal-correction",
});
assert.ok(browserDismissalHold.discrepancy);

const browserUnexpectedHold = await createBrowserLateSuccessHold({
  authorizedAmountMinor: "29",
  reportedAmountMinor: "17",
  reportedCurrency: "EUR",
  label: "unexpected-outflow",
});
assert.equal(browserUnexpectedHold.discrepancy, null);

await installRefundStartDelay();
try {
  const browserManualOrder = await createOrder(automaticPrice.id, legal);
  const paidBrowserManualOrder = await pay(browserManualOrder, "success");
  assert.equal(paidBrowserManualOrder.invoice.status, "paid");
  const browserManualCandidates = await request<{ items: RefundCandidate[] }>(
    "/api/v1/admin/refund-candidates",
  );
  const browserManualCandidate = browserManualCandidates.items.find(
    (candidate) => candidate.invoiceId === browserManualOrder.invoice.id,
  );
  assert.ok(browserManualCandidate);
  const browserManualRefund = await request<RefundRecord>(
    `/api/v1/admin/invoices/${browserManualOrder.invoice.id}/refunds`,
    {
      method: "POST",
      body: JSON.stringify({
        receiptId: browserManualCandidate.receiptId,
        destination: "original_payment",
        amountMode: "partial",
        amountMinor: "19",
        expectedRefundableMinor: browserManualCandidate.refundableMinor,
        scenario: "timeout_success",
        reason: "Synthetic browser manual refund awaits a confirm-no-outflow decision",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  assert.ok(browserManualRefund.providerOperationId);
  await corePool.query(
    `UPDATE refunds SET status = 'processing', version = version + 1, updated_at = now()
     WHERE id = $1 AND status = 'queued'`,
    [browserManualRefund.refundId],
  );
  await corePool.query(
    `UPDATE refunds SET status = 'unknown', version = version + 1, updated_at = now()
     WHERE id = $1 AND status = 'processing'`,
    [browserManualRefund.refundId],
  );
  await corePool.query(
    `UPDATE refunds
     SET status = 'manual', last_error = 'Synthetic exhausted query for browser confirmation',
         version = version + 1, updated_at = now()
     WHERE id = $1 AND status = 'unknown'`,
    [browserManualRefund.refundId],
  );
  await corePool.query(
    `UPDATE provider_operations
     SET status = 'unknown', attempt_count = 1,
         last_error = 'Synthetic exhausted query for browser confirmation', updated_at = now()
     WHERE id = $1`,
    [browserManualRefund.providerOperationId],
  );
  await corePool.query(
    `UPDATE durable_jobs
     SET status = 'manual', attempts = 8,
         last_error = 'Synthetic exhausted query for browser confirmation', updated_at = now()
     WHERE job_type = 'refund.start' AND payload->>'refundId' = $1`,
    [browserManualRefund.refundId],
  );
} finally {
  await dropRefundStartDelay();
}

const unbalancedJournals = await corePool.query<{ count: string }>(
  `SELECT count(*)::text AS count
   FROM (
     SELECT journal_id
     FROM ledger_lines
     GROUP BY journal_id
     HAVING sum(debit_minor) <> sum(credit_minor)
   ) unbalanced`,
);
assert.equal(unbalancedJournals.rows[0]?.count, "0");
const ledgerClient = await corePool.connect();
let rejectedUnbalanced = false;
try {
  await ledgerClient.query("BEGIN");
  const testJournal = await ledgerClient.query<{ id: string }>(
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES ('integration_guard_test', $1, 'USD', 'must roll back')
     RETURNING id`,
    [randomUUID()],
  );
  await ledgerClient.query(
    `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
     VALUES ($1, 'guard_test', 1, 0)`,
    [testJournal.rows[0]?.id],
  );
  await ledgerClient.query("COMMIT");
} catch {
  rejectedUnbalanced = true;
  await ledgerClient.query("ROLLBACK");
} finally {
  ledgerClient.release();
}
assert.equal(rejectedUnbalanced, true, "database must reject an unbalanced ledger journal");

const receiptFactClient = await corePool.connect();
let rejectedReceiptFactMutation = false;
try {
  await receiptFactClient.query("BEGIN");
  await receiptFactClient.query(
    `UPDATE fund_receipts
     SET amount_minor = amount_minor + 1
     WHERE reported_add_funds_attempt_id IS NOT NULL`,
  );
  await receiptFactClient.query("COMMIT");
} catch {
  rejectedReceiptFactMutation = true;
  await receiptFactClient.query("ROLLBACK");
} finally {
  receiptFactClient.release();
}
assert.equal(
  rejectedReceiptFactMutation,
  true,
  "database must reject mutation of original fund receipt facts",
);

await corePool.end();
await providerPool.end();
console.log("Stage A PostgreSQL journey passed.");
