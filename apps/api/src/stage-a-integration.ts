// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { providerOperationCapability } from "@opensales/core/provider-capability";
import pg from "pg";
import {
  assertSchemaCompatible,
  REQUIRED_SCHEMA_VERSION,
  runMigrations,
} from "./database.js";
import { digestToken } from "./auth.js";
import { advancePaidInvoice } from "./invoice-settlement.js";
import { providerSignature } from "./provider-signature.js";
import { runRenewalAutomation } from "./renewal-lifecycle.js";

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
      capacity_incidents: string | null;
      capacity_acknowledgements: string | null;
      capacity_acknowledgement_aliases: string | null;
      unclaimed_refund_capacity: string | null;
      refund_source_context: string | null;
      old_discrepancy_unique: string | null;
      chargeback_effects: string | null;
      debt_transactions: string | null;
      account_restrictions: string | null;
      saved_payment_methods: string | null;
      automatic_renewal_authorizations: string | null;
      token_encryption_keys: string | null;
      token_lookup_keys: string | null;
      service_decision_generation: string | null;
      payment_attempt_decision_generation: string | null;
    }>(
      `SELECT
         max(version) AS version,
         to_regclass('public.refund_manual_actions')::text AS manual_actions,
         to_regclass('public.refund_adjudication_corrections')::text AS corrections,
         to_regclass('public.refund_receipt_capacity_incidents')::text
           AS capacity_incidents,
         to_regclass('public.refund_receipt_capacity_acknowledgements')::text
           AS capacity_acknowledgements,
         to_regclass('public.refund_receipt_capacity_acknowledgement_aliases')::text
           AS capacity_acknowledgement_aliases,
         to_regclass('public.unclaimed_fund_refund_capacity')::text
           AS unclaimed_refund_capacity,
         (
           SELECT column_name
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'refunds'
             AND column_name = 'source_context'
         ) AS refund_source_context,
         (
           SELECT constraint_name
           FROM information_schema.table_constraints
           WHERE table_schema = 'public'
             AND table_name = 'refund_discrepancy_settlements'
             AND constraint_name = 'refund_discrepancy_settlements_refund_id_key'
         ) AS old_discrepancy_unique
         ,to_regclass('public.add_funds_chargeback_effects')::text
           AS chargeback_effects
         ,to_regclass('public.client_account_debt_transactions')::text
           AS debt_transactions
         ,to_regclass('public.client_account_restrictions')::text
           AS account_restrictions
         ,to_regclass('public.saved_payment_methods')::text
           AS saved_payment_methods
         ,to_regclass('public.automatic_renewal_authorizations')::text
           AS automatic_renewal_authorizations
         ,to_regclass('public.payment_method_token_encryption_keys')::text
           AS token_encryption_keys
         ,to_regclass('public.payment_method_token_lookup_keys')::text
           AS token_lookup_keys
         ,(
           SELECT column_name
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'services'
             AND column_name = 'automatic_renewal_decision_generation'
         ) AS service_decision_generation
         ,(
           SELECT column_name
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'payment_attempts'
             AND column_name = 'automatic_renewal_decision_generation'
         ) AS payment_attempt_decision_generation
       FROM schema_migrations`,
    );
    assert.equal(upgraded.rows[0]?.version, REQUIRED_SCHEMA_VERSION);
    assert.equal(upgraded.rows[0]?.manual_actions, "refund_manual_actions");
    assert.equal(upgraded.rows[0]?.corrections, "refund_adjudication_corrections");
    assert.equal(
      upgraded.rows[0]?.capacity_incidents,
      "refund_receipt_capacity_incidents",
    );
    assert.equal(
      upgraded.rows[0]?.capacity_acknowledgements,
      "refund_receipt_capacity_acknowledgements",
    );
    assert.equal(
      upgraded.rows[0]?.capacity_acknowledgement_aliases,
      "refund_receipt_capacity_acknowledgement_aliases",
    );
    assert.equal(upgraded.rows[0]?.unclaimed_refund_capacity, "unclaimed_fund_refund_capacity");
    assert.equal(upgraded.rows[0]?.refund_source_context, "source_context");
    assert.equal(upgraded.rows[0]?.old_discrepancy_unique, null);
    assert.equal(upgraded.rows[0]?.chargeback_effects, "add_funds_chargeback_effects");
    assert.equal(
      upgraded.rows[0]?.debt_transactions,
      "client_account_debt_transactions",
    );
    assert.equal(upgraded.rows[0]?.account_restrictions, "client_account_restrictions");
    assert.equal(upgraded.rows[0]?.saved_payment_methods, "saved_payment_methods");
    assert.equal(
      upgraded.rows[0]?.automatic_renewal_authorizations,
      "automatic_renewal_authorizations",
    );
    assert.equal(
      upgraded.rows[0]?.token_encryption_keys,
      "payment_method_token_encryption_keys",
    );
    assert.equal(upgraded.rows[0]?.token_lookup_keys, "payment_method_token_lookup_keys");
    assert.equal(
      upgraded.rows[0]?.service_decision_generation,
      "automatic_renewal_decision_generation",
    );
    assert.equal(
      upgraded.rows[0]?.payment_attempt_decision_generation,
      "automatic_renewal_decision_generation",
    );
  } finally {
    await upgradePool?.end().catch(() => undefined);
    upgradePool = null;
    let remainingConnections = -1;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activity = await admin.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = $1",
        [databaseName],
      );
      remainingConnections = Number(activity.rows[0]?.count ?? "-1");
      if (remainingConnections === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(remainingConnections, 0, "upgrade migration pool must close before database drop");
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  }
}

await verifyPublished007Upgrade();

const corePool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const providerPool = new pg.Pool({ connectionString: providerDatabaseUrl, max: 2 });
const deadlockBaseline = await corePool.query<{ deadlocks: string }>(
  `SELECT deadlocks::text
   FROM pg_stat_database
   WHERE datname = current_database()`,
);
const initialDeadlocks = deadlockBaseline.rows[0]?.deadlocks ?? "0";
let cookie = "";
const configuredSessionCookieName = process.env.SESSION_COOKIE_NAME ?? "oss_session";
const accountContextVersionByCookie = new Map<string, string>();

function sessionContextHeaders(): Record<string, string> {
  const accountContextVersion = cookie
    ? accountContextVersionByCookie.get(cookie)
    : undefined;
  return {
    ...(cookie ? { Cookie: cookie } : {}),
    ...(accountContextVersion
      ? { "X-OSS-Account-Context-Version": accountContextVersion }
      : {}),
  };
}

function rememberSessionContext(response: Response): void {
  const setCookie = response.headers
    .getSetCookie()
    .find((candidate) => candidate.startsWith(`${configuredSessionCookieName}=`));
  if (setCookie) {
    const pair = setCookie.split(";", 1)[0] ?? "";
    cookie = pair === `${configuredSessionCookieName}=` ? "" : pair;
  }
  const accountContextVersion = response.headers.get(
    "x-oss-account-context-version",
  );
  if (cookie && accountContextVersion) {
    accountContextVersionByCookie.set(cookie, accountContextVersion);
  }
}

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
    version: number;
    cancellation: {
      requestId: string;
      status: "scheduled" | "processing" | "unknown" | "manual" | "terminated";
      executionMode: "automatic" | "manual";
      scheduledAt: string;
      effectiveAt: string;
      result: Record<string, unknown>;
      lastError: string | null;
      providerOperation: { status: string; attempts: number } | null;
    } | null;
  };
};
type ManualItem = {
  serviceId: string;
  orderId: string;
  clientAccountId: string;
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
type ChargebackStatus = {
  clientAccountId: string;
  restricted: boolean;
  creditBalanceMinor: string;
  debtBalanceMinor: string;
  chargebacks: Array<{
    chargebackEffectId: string;
    externalAmountMinor: string;
    creditRecoveredMinor: string;
    debtMinor: string;
    restrictionActive: boolean;
  }>;
  unclaimedChargebacks: Array<{
    unclaimedChargebackEffectId: string;
    fundReceiptId: string;
    externalAmountMinor: string;
  }>;
  manualHolds: Array<{ holdId: string; reason: string }>;
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
  invoiceId: string | null;
  sourceContext: "allocated_invoice" | "unclaimed_funds";
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
type RefundReceiptCapacityIncident = {
  incidentId: string;
  receiptId: string;
  receiptSequence: string;
  source:
    | { type: "dismissal_correction"; correctionId: string }
    | { type: "unexpected_outflow_adjudication"; adjudicationId: string };
  refundId: string;
  sourceContext: "allocated_invoice" | "unclaimed_funds";
  receiptAllocatedMinor: string;
  allocatedContributionMinor: string;
  confirmedProviderOutflowMinor: string;
  confirmedDispositionMinor: string;
  confirmedCompensationMinor: string;
  receiptAmountMinor: string;
  overageMinor: string;
  currency: string;
  isCurrentSnapshot: boolean;
  status:
    | "awaiting_acknowledgement"
    | "acknowledged_recovery_outstanding"
    | "superseded_history";
  acknowledgement: {
    acknowledgementId: string;
    recoveryOutstanding: boolean;
  } | null;
  allowedAction: "acknowledge_manual_recovery" | null;
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
      ...sessionContextHeaders(),
      ...init.headers,
    },
    redirect: "error",
  });
  rememberSessionContext(response);
  if (response.status !== expectedStatus) {
    const responseBody = await response.text();
    assert.equal(
      response.status,
      expectedStatus,
      `${init.method ?? "GET"} ${path} expected ${expectedStatus}, received ${response.status}: ${responseBody}`,
    );
  }
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
      ...sessionContextHeaders(),
      ...init.headers,
    },
    redirect: "error",
  });
  rememberSessionContext(response);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function refreshAccountContext(expectedClientAccountId: string): Promise<void> {
  const current = await request<{
    eligible: boolean;
    clientAccountId: string | null;
  }>("/api/v1/auth/me");
  if (current.clientAccountId === expectedClientAccountId) {
    assert.equal(current.eligible, true);
    return;
  }
  assert.equal(current.clientAccountId, null);
  const selected = await request<{ clientAccountId: string }>(
    "/api/v1/auth/account-context",
    {
      method: "PUT",
      body: JSON.stringify({ clientAccountId: expectedClientAccountId }),
    },
  );
  assert.equal(selected.clientAccountId, expectedClientAccountId);
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

async function submitPaymentFactAndDiscardResponse(
  body: Record<string, unknown>,
): Promise<void> {
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
  assert.ok(providerOperationId, "response-loss payment fact requires a Provider operation");
  const signedBody = {
    eventId: body.eventId,
    providerOperationId,
    paymentAttemptId: body.paymentAttemptId,
    callbackCapability: providerOperationCapability(
      providerCapabilitySecret!,
      "mock-payment-v1",
      providerOperationId,
    ),
    externalPaymentId: body.externalPaymentId,
    status: body.status,
    amountMinor: body.amountMinor,
    currency: body.currency,
    occurredAt: body.occurredAt,
  };
  const serialized = JSON.stringify(signedBody);
  const timestamp = Date.now().toString();
  await new Promise<void>((resolve, reject) => {
    let responseStarted = false;
    const request = httpRequest(
      new URL("/api/v1/provider-events/payment", coreUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(serialized),
          "X-OSS-Timestamp": timestamp,
          "X-OSS-Signature": providerSignature(
            paymentWebhookSecret!,
            timestamp,
            signedBody,
          ),
        },
      },
      (response) => {
        responseStarted = true;
        response.destroy();
        resolve();
      },
    );
    request.on("error", (error) => {
      if (responseStarted) resolve();
      else reject(error);
    });
    request.end(serialized);
  });
}

async function submitAddFundsChargebackFact(
  body: {
    eventId: string;
    providerOperationId: string;
    addFundsAttemptId: string;
    originalExternalPaymentId: string;
    externalChargebackId: string;
    amountMinor: string;
    currency: string;
    occurredAt: string;
    callbackCapability?: string;
  },
  secret = paymentWebhookSecret!,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const signedBody = {
    ...body,
    callbackCapability:
      body.callbackCapability ??
      providerOperationCapability(
        providerCapabilitySecret!,
        "mock-payment-v1",
        body.providerOperationId,
      ),
    status: "succeeded" as const,
  };
  const timestamp = Date.now().toString();
  return rawCoreRequest("/api/v1/provider-events/add-funds-chargeback", {
    method: "POST",
    headers: {
      "X-OSS-Timestamp": timestamp,
      "X-OSS-Signature": providerSignature(secret, timestamp, signedBody),
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

async function submitResourceActionFact(
  body: {
    eventId: string;
    providerOperationId: string;
    serviceId: string;
    externalResourceId: string;
    action: "suspend" | "resume";
    status: "succeeded" | "failed";
    occurredAt: string;
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const signedBody = {
    ...body,
    callbackCapability: providerOperationCapability(
      providerCapabilitySecret!,
      "mock-provisioning-v1",
      body.providerOperationId,
    ),
  };
  const timestamp = Date.now().toString();
  return rawCoreRequest("/api/v1/provider-events/resource-action", {
    method: "POST",
    headers: {
      "X-OSS-Timestamp": timestamp,
      "X-OSS-Signature": providerSignature(
        provisioningWebhookSecret!,
        timestamp,
        signedBody,
      ),
    },
    body: JSON.stringify(signedBody),
  });
}

async function runSignedBillingDay(input: {
  businessDate: string;
  effectiveAt: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const signedBody = {
    policyId: "default" as const,
    businessDate: input.businessDate,
    effectiveAt: input.effectiveAt,
  };
  const timestamp = Date.now().toString();
  return rawCoreRequest("/api/v1/internal/billing/automation/run", {
    method: "POST",
    headers: {
      "X-OSS-Timestamp": timestamp,
      "X-OSS-Signature": providerSignature(
        providerCapabilitySecret!,
        timestamp,
        signedBody,
      ),
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
  timeoutMs = 25_000,
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
    timeoutMs,
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
    | "definitive_reject"
    | "delayed_definitive_reject"
    | "reconcile_manual"
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
const remoteHands = catalog.products.find((product) => product.id === "remote-hands");
assert.ok(automaticPrice, "automatic laboratory product is missing");
assert.ok(manualPrice, "manual laboratory product is missing");
assert.ok(remoteHands, "Remote Hands must be visible in the current laboratory catalog");
assert.equal(remoteHands.fulfillmentMode, "manual");
assert.ok(
  remoteHands.prices.some((price) => price.billingCycle === "one_time"),
  "Remote Hands must retain its one-time manual fulfillment price",
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
const unverifiedChargebackStatus = await rawCoreRequest(
  "/api/v1/billing/chargeback-status",
  { method: "GET" },
);
assert.equal(unverifiedChargebackStatus.status, 403);
assert.equal(unverifiedChargebackStatus.body.code, "EMAIL_VERIFICATION_REQUIRED");
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
  attempt_status: string;
  command_status: string;
  operation_status: string;
}>(
  `SELECT
     fr.disposition,
     pay.status AS attempt_status,
     command.status AS command_status,
     po.status AS operation_status,
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
   JOIN payment_attempts pay ON pay.id = fr.reported_payment_attempt_id
   JOIN invoice_payment_commands command ON command.payment_attempt_id = pay.id
   JOIN provider_operations po
     ON po.subject_type = 'payment'
    AND po.subject_id = fr.reported_payment_attempt_id
   WHERE fr.external_payment_id = $1`,
  [failedAttemptRow.external_payment_id],
);
assert.equal(lateSettlementInvariant.rows[0]?.disposition, "unclaimed");
assert.equal(lateSettlementInvariant.rows[0]?.allocations, "0");
assert.equal(lateSettlementInvariant.rows[0]?.attempt_status, "failed");
assert.equal(lateSettlementInvariant.rows[0]?.command_status, "failed");
assert.equal(lateSettlementInvariant.rows[0]?.operation_status, "failed");
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
await submitPaymentFactAndDiscardResponse({
  eventId: `response-lost-after-commit:${randomUUID()}`,
  paymentAttemptId: settledAttemptRow.id,
  externalPaymentId: settledAttemptRow.external_payment_id,
  status: "succeeded",
  amountMinor: settledAttemptRow.amount_minor,
  currency: settledAttemptRow.currency,
  occurredAt: new Date().toISOString(),
});
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
assert.equal(semanticDuplicate.body.duplicate, true);
assert.equal(
  (await request<OrderDetail>(`/api/v1/orders/${activeDuplicate.order.id}`)).order.status,
  "completed",
);
const responseLossRetryFacts = await corePool.query<{
  receipts: string;
  allocations: string;
  fee_charges: string;
  paid_events: string;
  provision_operations: string;
  provision_jobs: string;
}>(
  `SELECT
     (SELECT count(*)::text
        FROM fund_receipts receipt
        JOIN payment_attempts payment ON payment.id = receipt.reported_payment_attempt_id
       WHERE payment.invoice_id = $1) AS receipts,
     (SELECT count(*)::text
        FROM payment_allocations
       WHERE invoice_id = $1) AS allocations,
     (SELECT count(*)::text
        FROM invoice_fee_charges charge
        JOIN payment_attempts payment ON payment.id = charge.payment_attempt_id
       WHERE payment.invoice_id = $1) AS fee_charges,
     (SELECT count(*)::text
        FROM outbox
       WHERE event_type = 'invoice.paid' AND unique_key = $2) AS paid_events,
     (SELECT count(*)::text
        FROM provider_operations operation
        JOIN services service ON service.id = operation.subject_id
        JOIN order_items item ON item.id = service.order_item_id
       WHERE operation.subject_type = 'service'
         AND operation.kind = 'resource_create'
         AND item.order_id = $3) AS provision_operations,
     (SELECT count(*)::text
        FROM durable_jobs job
        JOIN services service ON service.id::text = job.payload->>'serviceId'
        JOIN order_items item ON item.id = service.order_item_id
       WHERE job.job_type = 'provision.start'
         AND item.order_id = $3) AS provision_jobs`,
  [
    activeDuplicate.invoice.id,
    `invoice:${activeDuplicate.invoice.id}`,
    activeDuplicate.order.id,
  ],
);
assert.deepEqual(responseLossRetryFacts.rows[0], {
  receipts: "1",
  allocations: "1",
  fee_charges: "1",
  paid_events: "1",
  provision_operations: "1",
  provision_jobs: "1",
});
const responseLossProvisionOperation = await corePool.query<{ id: string }>(
  `SELECT operation.id
   FROM provider_operations operation
   JOIN services service ON service.id = operation.subject_id
   JOIN order_items item ON item.id = service.order_item_id
   WHERE operation.subject_type = 'service'
     AND operation.kind = 'resource_create'
     AND item.order_id = $1`,
  [activeDuplicate.order.id],
);
const responseLossResource = await providerPool.query<{ create_calls: number }>(
  "SELECT create_calls FROM mock_resource_operations WHERE operation_id = $1",
  [responseLossProvisionOperation.rows[0]?.id],
);
assert.equal(responseLossResource.rows[0]?.create_calls, 1);

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
const forgedProvisionPayment = await corePool.query<{
  payment_attempt_id: string;
  operation_id: string;
  external_payment_id: string;
  amount_minor: string;
  currency: string;
  provider_occurred_at: Date;
}>(
  `SELECT attempt.id AS payment_attempt_id,
          operation.id AS operation_id,
          attempt.external_payment_id,
          attempt.amount_minor::text,
          attempt.currency,
          operation.provider_occurred_at
   FROM payment_attempts attempt
   JOIN provider_operations operation
     ON operation.subject_type = 'payment'
    AND operation.subject_id = attempt.id
   WHERE attempt.invoice_id = $1
     AND attempt.status = 'succeeded'`,
  [paidForgedProvision.invoice.id],
);
const forgedProvisionPaymentRecord = forgedProvisionPayment.rows[0];
assert.ok(forgedProvisionPaymentRecord?.external_payment_id);
assert.ok(forgedProvisionPaymentRecord.provider_occurred_at);
const forgedProvisionInvoiceGate = await corePool.connect();
let forgedProvisionInvoiceGateOpen = false;
try {
  await forgedProvisionInvoiceGate.query("BEGIN");
  forgedProvisionInvoiceGateOpen = true;
  await forgedProvisionInvoiceGate.query(
    "SELECT id FROM invoices WHERE id = $1 FOR UPDATE",
    [paidForgedProvision.invoice.id],
  );
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
  await waitFor(
    "manual provision reconciliation to wait at Invoice before Order or Service",
    async () => {
      const result = await corePool.query<{ waiting: string }>(
        `SELECT count(*)::text AS waiting
         FROM pg_stat_activity
         WHERE application_name = 'opensales-worker'
           AND state = 'active'
           AND wait_event_type = 'Lock'
           AND query ILIKE '%SELECT id FROM invoices WHERE id = $1 FOR UPDATE%'`,
      );
      return result.rows[0]?.waiting ?? "0";
    },
    (waiting) => BigInt(waiting) >= 1n,
  );
  const forgedProvisionTargetProbe = await corePool.connect();
  try {
    await forgedProvisionTargetProbe.query("BEGIN");
    await forgedProvisionTargetProbe.query(
      "SELECT id FROM orders WHERE id = $1 FOR UPDATE NOWAIT",
      [paidForgedProvision.order.id],
    );
    await forgedProvisionTargetProbe.query(
      "SELECT id FROM services WHERE id = $1 FOR UPDATE NOWAIT",
      [paidForgedProvision.service.id],
    );
    await forgedProvisionTargetProbe.query("COMMIT");
  } catch (error) {
    await forgedProvisionTargetProbe.query("ROLLBACK");
    throw error;
  } finally {
    forgedProvisionTargetProbe.release();
  }
  const forgedProvisionPaymentReplayPromise = submitPaymentFact({
    eventId: `manual-provision-reconcile-duplicate:${randomUUID()}`,
    providerOperationId: forgedProvisionPaymentRecord.operation_id,
    paymentAttemptId: forgedProvisionPaymentRecord.payment_attempt_id,
    externalPaymentId: forgedProvisionPaymentRecord.external_payment_id,
    status: "succeeded",
    amountMinor: forgedProvisionPaymentRecord.amount_minor,
    currency: forgedProvisionPaymentRecord.currency,
    occurredAt: forgedProvisionPaymentRecord.provider_occurred_at.toISOString(),
  });
  await waitFor(
    "manual provision reconcile and duplicate payment callback to follow the canonical identity-to-Invoice order",
    async () => {
      const result = await corePool.query<{
        worker_waiting: string;
        callback_waiting: string;
      }>(
        `SELECT
           count(*) FILTER (
             WHERE application_name = 'opensales-worker'
               AND query ILIKE '%SELECT id FROM invoices WHERE id = $1 FOR UPDATE%'
           )::text AS worker_waiting,
           count(*) FILTER (
             WHERE application_name = 'opensales-api'
               AND query ILIKE '%SELECT id FROM users%FOR UPDATE%'
           )::text AS callback_waiting
         FROM pg_stat_activity
         WHERE state = 'active' AND wait_event_type = 'Lock'`,
      );
      return {
        workerWaiting: result.rows[0]?.worker_waiting ?? "0",
        callbackWaiting: result.rows[0]?.callback_waiting ?? "0",
      };
    },
    (waiting) =>
      BigInt(waiting.workerWaiting) >= 1n && BigInt(waiting.callbackWaiting) >= 1n,
  );
  await forgedProvisionInvoiceGate.query("COMMIT");
  forgedProvisionInvoiceGateOpen = false;
  const forgedProvisionPaymentReplay = await forgedProvisionPaymentReplayPromise;
  assert.equal(forgedProvisionPaymentReplay.status, 200);
  assert.equal(forgedProvisionPaymentReplay.body.duplicate, true);
} finally {
  if (forgedProvisionInvoiceGateOpen) {
    await forgedProvisionInvoiceGate.query("ROLLBACK");
  }
  forgedProvisionInvoiceGate.release();
}
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
  async () => {
    const state = await corePool.query<{
      order_status: string;
      service_status: string;
    }>(
      `SELECT customer_order.status AS order_status,
              service.status AS service_status
       FROM orders customer_order
       JOIN services service ON service.id = $2
       WHERE customer_order.id = $1`,
      [paidBeforeRestriction.order.id, paidBeforeRestriction.service.id],
    );
    return state.rows[0] ?? null;
  },
  (value) => value?.order_status === "on_hold",
);
assert.equal(heldForRestriction?.service_status, "pending");
const restrictedCreateCount = await providerPool.query<{ count: string }>(
  "SELECT count(*)::text AS count FROM mock_resource_operations WHERE operation_id = $1",
  [heldProvisionOperation.rows[0].id],
);
assert.equal(restrictedCreateCount.rows[0]?.count, "0");
await corePool.query("UPDATE users SET restricted_at = NULL WHERE email = $1", [email]);
const restoredAfterProvisionRestriction = await request<{
  eligible: boolean;
  clientAccountId: string | null;
}>("/api/v1/auth/me");
assert.equal(restoredAfterProvisionRestriction.eligible, true);
assert.ok(restoredAfterProvisionRestriction.clientAccountId);

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
const staleAttemptFinal = await corePool.query<{
  external_payment_id: string;
  amount_minor: string;
  currency: string;
  attempt_status: string;
  command_status: string;
  operation_status: string;
}>(
  `SELECT
     attempt.external_payment_id,
     attempt.amount_minor::text,
     attempt.currency,
     attempt.status AS attempt_status,
     command.status AS command_status,
     operation.status AS operation_status
   FROM payment_attempts attempt
   JOIN invoice_payment_commands command ON command.payment_attempt_id = attempt.id
   JOIN provider_operations operation
     ON operation.subject_type = 'payment'
    AND operation.subject_id = attempt.id
   WHERE attempt.id = $1`,
  [staleLeasePayment.paymentAttemptId],
);
const staleAttempt = staleAttemptFinal.rows[0];
assert.ok(staleAttempt?.external_payment_id);
assert.equal(staleAttempt.attempt_status, "succeeded");
assert.equal(staleAttempt.command_status, "succeeded");
assert.equal(staleAttempt.operation_status, "succeeded");

// Simulate a response-lost old Worker and its replacement independently
// reconciling the same Provider fact with different nonces. Core must accept
// the observations without creating a second financial or service effect.
const staleReconcileOccurredAt = new Date().toISOString();
const staleReconcileResults = await Promise.all([
  submitPaymentFact({
    eventId: `stale-worker-a:${randomUUID()}`,
    providerOperationId: staleLeaseRecord.rows[0]!.operation_id,
    paymentAttemptId: staleLeasePayment.paymentAttemptId,
    externalPaymentId: staleAttempt.external_payment_id,
    status: "succeeded",
    amountMinor: staleAttempt.amount_minor,
    currency: staleAttempt.currency,
    occurredAt: staleReconcileOccurredAt,
  }),
  submitPaymentFact({
    eventId: `stale-worker-b:${randomUUID()}`,
    providerOperationId: staleLeaseRecord.rows[0]!.operation_id,
    paymentAttemptId: staleLeasePayment.paymentAttemptId,
    externalPaymentId: staleAttempt.external_payment_id,
    status: "succeeded",
    amountMinor: staleAttempt.amount_minor,
    currency: staleAttempt.currency,
    occurredAt: staleReconcileOccurredAt,
  }),
]);
assert.equal(staleReconcileResults[0]?.status, 200);
assert.equal(staleReconcileResults[1]?.status, 200);
assert.equal(staleReconcileResults[0]?.body.duplicate, true);
assert.equal(staleReconcileResults[1]?.body.duplicate, true);

const staleCompletion = await corePool.query(
  `UPDATE durable_jobs
   SET status = 'completed', locked_at = NULL, locked_by = NULL
   WHERE id = $1
     AND status = 'running'
     AND locked_by = 'synthetic-dead-worker'
     AND attempts = 1
   RETURNING id`,
  [staleLeaseRecord.rows[0]!.job_id],
);
const staleDelay = await corePool.query(
  `UPDATE durable_jobs
   SET status = 'pending', available_at = now() + interval '1 minute',
       locked_at = NULL, locked_by = NULL
   WHERE id = $1
     AND status = 'running'
     AND locked_by = 'synthetic-dead-worker'
     AND attempts = 1
   RETURNING id`,
  [staleLeaseRecord.rows[0]!.job_id],
);
const staleManual = await corePool.query(
  `UPDATE durable_jobs
   SET status = 'manual', locked_at = NULL, locked_by = NULL
   WHERE id = $1
     AND status = 'running'
     AND locked_by = 'synthetic-dead-worker'
     AND attempts = 1
   RETURNING id`,
  [staleLeaseRecord.rows[0]!.job_id],
);
assert.equal(staleCompletion.rowCount, 0);
assert.equal(staleDelay.rowCount, 0);
assert.equal(staleManual.rowCount, 0);
const staleLeaseEffects = await corePool.query<{
  receipts: string;
  allocations: string;
  fee_charges: string;
  paid_events: string;
  provision_operations: string;
  provision_jobs: string;
  job_status: string;
}>(
  `SELECT
     (SELECT count(*)::text FROM fund_receipts
       WHERE reported_payment_attempt_id = $1) AS receipts,
     (SELECT count(*)::text FROM payment_allocations
       WHERE payment_attempt_id = $1) AS allocations,
     (SELECT count(*)::text FROM invoice_fee_charges
       WHERE payment_attempt_id = $1) AS fee_charges,
     (SELECT count(*)::text FROM outbox
       WHERE event_type = 'invoice.paid' AND unique_key = $2) AS paid_events,
     (SELECT count(*)::text FROM provider_operations
       WHERE subject_type = 'service' AND subject_id = $3) AS provision_operations,
     (SELECT count(*)::text FROM durable_jobs
       WHERE job_type = 'provision.start' AND payload->>'serviceId' = $3::text) AS provision_jobs,
     (SELECT status FROM durable_jobs WHERE id = $4) AS job_status`,
  [
    staleLeasePayment.paymentAttemptId,
    `invoice:${staleLeaseOrder.invoice.id}`,
    recoveredLease.service.id,
    staleLeaseRecord.rows[0]!.job_id,
  ],
);
assert.deepEqual(staleLeaseEffects.rows[0], {
  receipts: "1",
  allocations: "1",
  fee_charges: "1",
  paid_events: "1",
  provision_operations: "1",
  provision_jobs: "1",
  job_status: "completed",
});
const staleProvisionOperation = await corePool.query<{ id: string }>(
  `SELECT id
   FROM provider_operations
   WHERE subject_type = 'service'
     AND kind = 'resource_create'
     AND subject_id = $1`,
  [recoveredLease.service.id],
);
const staleResourceCreate = await providerPool.query<{ create_calls: number }>(
  "SELECT create_calls FROM mock_resource_operations WHERE operation_id = $1",
  [staleProvisionOperation.rows[0]?.id],
);
assert.equal(staleResourceCreate.rows[0]?.create_calls, 1);

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
const queuedManualItem = queue.items.find((item) => item.serviceId === paidManual.service.id);
assert.ok(queuedManualItem);
const queuedManualOrder = await corePool.query<{ client_account_id: string }>(
  "SELECT client_account_id FROM orders WHERE id = $1",
  [paidManual.order.id],
);
assert.equal(queuedManualItem.clientAccountId, queuedManualOrder.rows[0]?.client_account_id);
const manualPaymentRecords = await corePool.query<{
  payment_attempt_id: string;
  operation_id: string;
  external_payment_id: string;
  amount_minor: string;
  currency: string;
  provider_occurred_at: Date;
}>(
  `SELECT attempt.id AS payment_attempt_id,
          operation.id AS operation_id,
          attempt.external_payment_id,
          attempt.amount_minor::text,
          attempt.currency,
          operation.provider_occurred_at
   FROM payment_attempts attempt
   JOIN provider_operations operation
     ON operation.subject_type = 'payment'
    AND operation.subject_id = attempt.id
   WHERE attempt.invoice_id = $1
     AND attempt.status = 'succeeded'`,
  [paidManual.invoice.id],
);
const manualPaymentRecord = manualPaymentRecords.rows[0];
assert.ok(manualPaymentRecord?.external_payment_id);
assert.ok(manualPaymentRecord.provider_occurred_at);
const manualInvoiceGate = await corePool.connect();
let manualInvoiceGateOpen = false;
try {
  await manualInvoiceGate.query("BEGIN");
  manualInvoiceGateOpen = true;
  await manualInvoiceGate.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [
    paidManual.invoice.id,
  ]);
  const manualCompletionPromise = rawCoreRequest(
    `/api/v1/admin/services/${paidManual.service.id}/complete-manual`,
    {
      method: "POST",
      body: JSON.stringify({
        reason: "Synthetic delivery confirmed while a duplicate Provider fact waited",
      }),
    },
  );
  await waitFor(
    "manual fulfillment to wait at Invoice before Order or Service",
    async () => {
      const result = await corePool.query<{ waiting: string }>(
        `SELECT count(*)::text AS waiting
         FROM pg_stat_activity
         WHERE application_name = 'opensales-api'
           AND state = 'active'
           AND wait_event_type = 'Lock'
           AND query ILIKE '%SELECT id FROM invoices WHERE id = $1 FOR UPDATE%'`,
      );
      return result.rows[0]?.waiting ?? "0";
    },
    (waiting) => BigInt(waiting) >= 1n,
  );
  const manualTargetProbe = await corePool.connect();
  try {
    await manualTargetProbe.query("BEGIN");
    await manualTargetProbe.query(
      "SELECT id FROM orders WHERE id = $1 FOR UPDATE NOWAIT",
      [paidManual.order.id],
    );
    await manualTargetProbe.query(
      "SELECT id FROM services WHERE id = $1 FOR UPDATE NOWAIT",
      [paidManual.service.id],
    );
    await manualTargetProbe.query("COMMIT");
  } catch (error) {
    await manualTargetProbe.query("ROLLBACK");
    throw error;
  } finally {
    manualTargetProbe.release();
  }
  const duplicateManualPaymentPromise = submitPaymentFact({
    eventId: `manual-fulfillment-duplicate:${randomUUID()}`,
    providerOperationId: manualPaymentRecord.operation_id,
    paymentAttemptId: manualPaymentRecord.payment_attempt_id,
    externalPaymentId: manualPaymentRecord.external_payment_id,
    status: "succeeded",
    amountMinor: manualPaymentRecord.amount_minor,
    currency: manualPaymentRecord.currency,
    occurredAt: manualPaymentRecord.provider_occurred_at.toISOString(),
  });
  await waitFor(
    "manual fulfillment and duplicate payment callback to share the Invoice root lock",
    async () => {
      const result = await corePool.query<{ waiting: string }>(
        `SELECT count(*)::text AS waiting
         FROM pg_stat_activity
         WHERE application_name = 'opensales-api'
           AND state = 'active'
           AND wait_event_type = 'Lock'
           AND query ILIKE '%SELECT id FROM invoices WHERE id = $1 FOR UPDATE%'`,
      );
      return result.rows[0]?.waiting ?? "0";
    },
    (waiting) => BigInt(waiting) >= 2n,
  );
  await manualInvoiceGate.query("COMMIT");
  manualInvoiceGateOpen = false;
  const [manualCompletion, duplicateManualPayment] = await Promise.all([
    manualCompletionPromise,
    duplicateManualPaymentPromise,
  ]);
  assert.equal(manualCompletion.status, 200);
  assert.equal(manualCompletion.body.status, "active");
  assert.equal(duplicateManualPayment.status, 200);
  assert.equal(duplicateManualPayment.body.duplicate, true);
} finally {
  if (manualInvoiceGateOpen) await manualInvoiceGate.query("ROLLBACK");
  manualInvoiceGate.release();
}
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
const lateFailureAfterUnclaimed = await submitPaymentFact({
  eventId: `wrong-amount-late-failure:${randomUUID()}`,
  providerOperationId: mismatchRecords.operation_id,
  paymentAttemptId: mismatchCommand.paymentAttemptId,
  externalPaymentId: mismatchExternalId,
  status: "failed",
  amountMinor: mismatchAmountMinor,
  currency: mismatchRecords.currency,
  occurredAt: new Date(Date.now() + 1_000).toISOString(),
});
assert.equal(lateFailureAfterUnclaimed.status, 202);
assert.equal(lateFailureAfterUnclaimed.body.ignored, true);
assert.equal(lateFailureAfterUnclaimed.body.reason, "funds_receipt_requires_manual_review");
const mismatchAfterLateFailure = await corePool.query<{
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
assert.deepEqual(mismatchAfterLateFailure.rows[0], mismatchCoreState.rows[0]);
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
const mismatchReconcileInbox = await corePool.query<{ external_event_id: string }>(
  `SELECT external_event_id
   FROM provider_inbox
   WHERE provider_installation_id = 'mock-payment-v1'
     AND external_event_id LIKE 'reconcile:' || $1::text || ':%'
   ORDER BY received_at DESC
   LIMIT 1`,
  [mismatchRecords.operation_id],
);
assert.match(
  mismatchReconcileInbox.rows[0]?.external_event_id ?? "",
  /^reconcile:[0-9a-f-]{36}:[0-9a-f-]{36}$/,
  "Core reconciliation must use an unpredictable event nonce instead of an enumerable attempt number",
);

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
const preemptedReconcileEventId = `reconcile-preemption:${randomUUID()}`;
const preemptedProcessingFact = {
  eventId: preemptedReconcileEventId,
  providerOperationId: callbackRaceRecords.operation_id,
  paymentAttemptId: callbackRaceCommand.paymentAttemptId,
  externalPaymentId: callbackRaceFact.externalPaymentId,
  status: "processing",
  amountMinor: callbackRaceRecords.amount_minor,
  currency: callbackRaceRecords.currency,
  occurredAt: new Date().toISOString(),
};
const acceptedPreemption = await submitPaymentFact(preemptedProcessingFact);
assert.equal(acceptedPreemption.status, 202);
assert.equal(acceptedPreemption.body.status, "processing");
const exactPreemptionReplay = await submitPaymentFact(preemptedProcessingFact);
assert.equal(exactPreemptionReplay.status, 200);
assert.equal(exactPreemptionReplay.body.duplicate, true);
const conflictingPreemption = await submitPaymentFact({
  ...preemptedProcessingFact,
  status: "succeeded",
  occurredAt: new Date(Date.now() + 1_000).toISOString(),
});
assert.equal(conflictingPreemption.status, 202);
assert.equal(conflictingPreemption.body.rejected, true);
assert.equal(conflictingPreemption.body.reason, "event_id_conflict");
const preemptionEvidence = await corePool.query<{
  receipts: string;
  conflicts: string;
}>(
  `SELECT
     (SELECT count(*)::text
        FROM fund_receipts
       WHERE reported_payment_attempt_id = $1) AS receipts,
     (SELECT count(*)::text
       FROM audit_events
       WHERE action = 'payment.event_id_conflict'
         AND target_type = 'payment'
         AND target_id = $1::text) AS conflicts`,
  [callbackRaceCommand.paymentAttemptId],
);
assert.equal(preemptionEvidence.rows[0]?.receipts, "0");
assert.equal(preemptionEvidence.rows[0]?.conflicts, "1");
const [callbackRaceResult, competingConfirmation] = await Promise.all([
  submitPaymentFact({
    ...callbackRaceFact,
    occurredAt: new Date(Date.now() + 2_000).toISOString(),
  }),
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

// Force the original cross-invoice/shared-account interleaving. The callback
// and Worker have different invoice/attempt/operation roots, so only their
// shared User/Client Account/Membership rows can serialize them. Holding User
// makes both real product paths wait at the first shared row; Client Account
// must remain lockable until User is released.
const sharedIdentityOriginalCookie = cookie;
try {
  await corePool.query(`
    DROP TRIGGER IF EXISTS integration_delay_cross_lock_add_funds ON durable_jobs;
    CREATE OR REPLACE FUNCTION integration_delay_cross_lock_add_funds()
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
    CREATE TRIGGER integration_delay_cross_lock_add_funds
    BEFORE INSERT ON durable_jobs
    FOR EACH ROW EXECUTE FUNCTION integration_delay_cross_lock_add_funds();

    DROP TRIGGER IF EXISTS integration_delay_cross_lock_provision ON durable_jobs;
    CREATE OR REPLACE FUNCTION integration_delay_cross_lock_provision()
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
    CREATE TRIGGER integration_delay_cross_lock_provision
    BEFORE INSERT ON durable_jobs
    FOR EACH ROW EXECUTE FUNCTION integration_delay_cross_lock_provision();
  `);
  const sharedIdentityEmail = `cross-invoice-${randomUUID()}@example.invalid`;
  await request(
    "/api/v1/auth/register",
    {
      method: "POST",
      body: JSON.stringify({
        email: sharedIdentityEmail,
        password,
        clientName: "Synthetic Cross Invoice Lock Account",
        locale: "en",
      }),
    },
    201,
  );
  await request(
    "/api/v1/auth/login",
    {
      method: "POST",
      body: JSON.stringify({ email: sharedIdentityEmail, password }),
    },
    200,
  );
  await corePool.query(
    "UPDATE users SET email_verified_at = now() WHERE email = $1",
    [sharedIdentityEmail],
  );
  const sharedIdentityMe = await request<{ id: string; clientAccountId: string }>(
    "/api/v1/auth/me",
  );
  const sharedCallbackOrder = await createOrder(automaticPrice.id, legal);
  const sharedCallbackQuote = await createPaymentQuote(sharedCallbackOrder.invoice.id);
  const sharedCallbackCommand = await request<PaymentCommand>(
    `/api/v1/invoices/${sharedCallbackOrder.invoice.id}/payments`,
    {
      method: "POST",
      body: JSON.stringify({
        quoteId: sharedCallbackQuote.quoteId,
        scenario: "success",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  assert.ok(sharedCallbackCommand.paymentAttemptId);
  const sharedCallbackRecords = await readPaymentRecords(sharedCallbackCommand.commandId);
  await corePool.query("UPDATE payment_attempts SET status = 'processing' WHERE id = $1", [
    sharedCallbackCommand.paymentAttemptId,
  ]);
  await corePool.query(
    `UPDATE provider_operations
     SET status = 'running', attempt_count = 1
     WHERE id = $1`,
    [sharedCallbackRecords.operation_id],
  );
  await corePool.query(
    `UPDATE durable_jobs
     SET status = 'completed', locked_at = NULL, locked_by = NULL
     WHERE job_type = 'payment.start'
       AND payload->>'paymentAttemptId' = $1`,
    [sharedCallbackCommand.paymentAttemptId],
  );

  const sharedWorkerOrder = await createOrder(automaticPrice.id, legal);
  const sharedWorkerQuote = await createPaymentQuote(sharedWorkerOrder.invoice.id);
  const sharedWorkerCommand = await request<PaymentCommand>(
    `/api/v1/invoices/${sharedWorkerOrder.invoice.id}/payments`,
    {
      method: "POST",
      body: JSON.stringify({
        quoteId: sharedWorkerQuote.quoteId,
        scenario: "success",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  assert.ok(sharedWorkerCommand.paymentAttemptId);

  const sharedAddFundsWorkerQuote = await createAddFundsQuote("5000", "card");
  const sharedAddFundsWorkerStarted = await startAddFunds(
    sharedAddFundsWorkerQuote.quoteId,
    "success",
  );
  const sharedAddFundsWorkerRecords = await corePool.query<{
    attempt_id: string;
    operation_id: string;
  }>(
    `SELECT attempt.id AS attempt_id, operation.id AS operation_id
     FROM add_funds_attempts attempt
     JOIN provider_operations operation
       ON operation.subject_type = 'add_funds'
      AND operation.subject_id = attempt.id
     WHERE attempt.id = $1`,
    [sharedAddFundsWorkerStarted.command.addFundsAttemptId],
  );
  const sharedAddFundsWorkerRecord = sharedAddFundsWorkerRecords.rows[0];
  assert.ok(sharedAddFundsWorkerRecord);

  const sharedAddFundsQuote = await createAddFundsQuote("5000", "card");
  const sharedAddFundsStarted = await startAddFunds(sharedAddFundsQuote.quoteId, "success");
  const sharedAddFundsRecords = await corePool.query<{
    attempt_id: string;
    operation_id: string;
    amount_minor: string;
    currency: string;
  }>(
    `SELECT
       attempt.id AS attempt_id,
       operation.id AS operation_id,
       attempt.amount_minor::text,
       attempt.currency
     FROM add_funds_attempts attempt
     JOIN provider_operations operation
       ON operation.subject_type = 'add_funds'
      AND operation.subject_id = attempt.id
     WHERE attempt.id = $1`,
    [sharedAddFundsStarted.command.addFundsAttemptId],
  );
  const sharedAddFundsRecord = sharedAddFundsRecords.rows[0];
  assert.ok(sharedAddFundsRecord);
  await corePool.query(
    "UPDATE add_funds_attempts SET status = 'processing' WHERE id = $1",
    [sharedAddFundsRecord.attempt_id],
  );

  const sharedProvisionOrder = await createOrder(automaticPrice.id, legal);
  const sharedProvisionQuote = await createPaymentQuote(sharedProvisionOrder.invoice.id);
  const sharedProvisionPayment = await request<PaymentCommand>(
    `/api/v1/invoices/${sharedProvisionOrder.invoice.id}/payments`,
    {
      method: "POST",
      body: JSON.stringify({
        quoteId: sharedProvisionQuote.quoteId,
        scenario: "success",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  assert.ok(sharedProvisionPayment.paymentAttemptId);
  await releasePaymentStart(sharedProvisionPayment.paymentAttemptId);
  await waitFor(
    "provisioning callback lock-order source invoice to become paid",
    () => request<OrderDetail>(`/api/v1/orders/${sharedProvisionOrder.order.id}`),
    (value) => value.invoice.status === "paid",
  );
  const sharedProvisionRecords = await corePool.query<{
    service_id: string;
    operation_id: string;
    job_id: string;
  }>(
    `SELECT
       service.id AS service_id,
       operation.id AS operation_id,
       job.id AS job_id
     FROM services service
     JOIN order_items item ON item.id = service.order_item_id
     JOIN provider_operations operation
       ON operation.subject_type = 'service'
      AND operation.subject_id = service.id
      AND operation.kind = 'resource_create'
     JOIN durable_jobs job
       ON job.job_type = 'provision.start'
      AND job.payload->>'serviceId' = service.id::text
     WHERE item.order_id = $1`,
    [sharedProvisionOrder.order.id],
  );
  const sharedProvisionRecord = sharedProvisionRecords.rows[0];
  assert.ok(sharedProvisionRecord);

  const sharedProvisionWorkerOrder = await createOrder(automaticPrice.id, legal);
  const sharedProvisionWorkerQuote = await createPaymentQuote(
    sharedProvisionWorkerOrder.invoice.id,
  );
  const sharedProvisionWorkerPayment = await request<PaymentCommand>(
    `/api/v1/invoices/${sharedProvisionWorkerOrder.invoice.id}/payments`,
    {
      method: "POST",
      body: JSON.stringify({
        quoteId: sharedProvisionWorkerQuote.quoteId,
        scenario: "success",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  assert.ok(sharedProvisionWorkerPayment.paymentAttemptId);
  await releasePaymentStart(sharedProvisionWorkerPayment.paymentAttemptId);
  await waitFor(
    "provisioning Worker lock-order source invoice to become paid",
    () => request<OrderDetail>(`/api/v1/orders/${sharedProvisionWorkerOrder.order.id}`),
    (value) => value.invoice.status === "paid",
  );
  const sharedProvisionWorkerRecords = await corePool.query<{
    service_id: string;
    operation_id: string;
    job_id: string;
  }>(
    `SELECT service.id AS service_id,
            operation.id AS operation_id,
            job.id AS job_id
     FROM services service
     JOIN order_items item ON item.id = service.order_item_id
     JOIN provider_operations operation
       ON operation.subject_type = 'service'
      AND operation.subject_id = service.id
      AND operation.kind = 'resource_create'
     JOIN durable_jobs job
       ON job.job_type = 'provision.start'
      AND job.payload->>'serviceId' = service.id::text
     WHERE item.order_id = $1`,
    [sharedProvisionWorkerOrder.order.id],
  );
  const sharedProvisionWorkerRecord = sharedProvisionWorkerRecords.rows[0];
  assert.ok(sharedProvisionWorkerRecord);
  await corePool.query(
    "UPDATE services SET status = 'provisioning' WHERE id = $1",
    [sharedProvisionRecord.service_id],
  );
  await corePool.query(
    "UPDATE orders SET status = 'fulfilling' WHERE id = $1",
    [sharedProvisionOrder.order.id],
  );
  await corePool.query(
    `UPDATE provider_operations
     SET status = 'running', attempt_count = 1
     WHERE id = $1`,
    [sharedProvisionRecord.operation_id],
  );
  await corePool.query(
    `UPDATE durable_jobs
     SET status = 'completed', locked_at = NULL, locked_by = NULL
     WHERE id = $1`,
    [sharedProvisionRecord.job_id],
  );
  await corePool.query(
    `UPDATE provider_operations
     SET status = 'running', attempt_count = 1
     WHERE id = $1`,
    [sharedAddFundsRecord.operation_id],
  );
  await corePool.query(
    `UPDATE durable_jobs
     SET status = 'completed', locked_at = NULL, locked_by = NULL
     WHERE job_type = 'add_funds.start'
       AND payload->>'addFundsAttemptId' = $1`,
    [sharedAddFundsRecord.attempt_id],
  );

  const sharedIdentity = await corePool.query<{
    callback_user_id: string;
    payment_worker_user_id: string;
    add_funds_callback_user_id: string;
    add_funds_worker_user_id: string;
    provision_callback_user_id: string;
    provision_worker_user_id: string;
  }>(
    `SELECT
       callback_order.submitted_by_user_id AS callback_user_id,
       worker_order.submitted_by_user_id AS payment_worker_user_id,
       add_funds_callback.submitted_by_user_id AS add_funds_callback_user_id,
       add_funds_worker.submitted_by_user_id AS add_funds_worker_user_id,
       provision_callback_order.submitted_by_user_id AS provision_callback_user_id,
       provision_worker_order.submitted_by_user_id AS provision_worker_user_id
     FROM orders callback_order
     JOIN orders worker_order ON worker_order.id = $2
     JOIN add_funds_attempts add_funds_callback ON add_funds_callback.id = $3
     JOIN add_funds_attempts add_funds_worker ON add_funds_worker.id = $4
     JOIN orders provision_callback_order ON provision_callback_order.id = $5
     JOIN orders provision_worker_order ON provision_worker_order.id = $6
     WHERE callback_order.id = $1`,
    [
      sharedCallbackOrder.order.id,
      sharedWorkerOrder.order.id,
      sharedAddFundsRecord.attempt_id,
      sharedAddFundsWorkerRecord.attempt_id,
      sharedProvisionOrder.order.id,
      sharedProvisionWorkerOrder.order.id,
    ],
  );
  const sharedUserId = sharedIdentity.rows[0]?.callback_user_id;
  assert.ok(sharedUserId);
  assert.equal(sharedIdentity.rows[0]?.payment_worker_user_id, sharedUserId);
  assert.equal(sharedIdentity.rows[0]?.add_funds_callback_user_id, sharedUserId);
  assert.equal(sharedIdentity.rows[0]?.add_funds_worker_user_id, sharedUserId);
  assert.equal(sharedIdentity.rows[0]?.provision_callback_user_id, sharedUserId);
  assert.equal(sharedIdentity.rows[0]?.provision_worker_user_id, sharedUserId);

  const assertWorkerIdentityLockOrder = async (
    label: string,
    release: () => Promise<unknown>,
    verify: () => Promise<void>,
  ): Promise<void> => {
    const userGate = await corePool.connect();
    let userGateOpen = false;
    try {
      await userGate.query("BEGIN");
      userGateOpen = true;
      await userGate.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [sharedUserId]);
      await release();
      await waitFor(
        `${label} Worker to wait at the shared User row`,
        async () => {
          const result = await corePool.query<{ waiting: string }>(
            `SELECT count(*)::text AS waiting
             FROM pg_stat_activity
             WHERE application_name = 'opensales-worker'
               AND state = 'active'
               AND wait_event_type = 'Lock'
               AND query ILIKE '%SELECT id FROM users WHERE id = $1 FOR UPDATE%'`,
          );
          return result.rows[0]?.waiting ?? "0";
        },
        (waiting) => BigInt(waiting) >= 1n,
      );
      const accountProbe = await corePool.connect();
      try {
        await accountProbe.query("BEGIN");
        const unlockedAccount = await accountProbe.query<{ id: string }>(
          `SELECT id
           FROM client_accounts
           WHERE id = $1
           FOR UPDATE NOWAIT`,
          [sharedIdentityMe.clientAccountId],
        );
        assert.equal(unlockedAccount.rows[0]?.id, sharedIdentityMe.clientAccountId);
        await accountProbe.query("COMMIT");
      } catch (error) {
        await accountProbe.query("ROLLBACK");
        throw error;
      } finally {
        accountProbe.release();
      }
      await userGate.query("COMMIT");
      userGateOpen = false;
      await verify();
    } finally {
      if (userGateOpen) await userGate.query("ROLLBACK");
      userGate.release();
    }
  };

  await assertWorkerIdentityLockOrder(
    "Add Funds preflight",
    () =>
      corePool.query(
        `UPDATE durable_jobs
         SET available_at = now(), status = 'pending', locked_at = NULL, locked_by = NULL
         WHERE job_type = 'add_funds.start'
           AND payload->>'addFundsAttemptId' = $1`,
        [sharedAddFundsWorkerRecord.attempt_id],
      ),
    async () => {
      const settled = await waitForAddFunds(
        sharedAddFundsWorkerStarted.command.commandId,
        "succeeded",
      );
      assert.equal(settled.result?.principalCreditedMinor, "5000");
    },
  );
  await providerPool.query(
    `INSERT INTO mock_resource_faults(operation_id, behavior)
     VALUES ($1, 'callback_success_then_reject')`,
    [sharedProvisionWorkerRecord.operation_id],
  );
  await assertWorkerIdentityLockOrder(
    "Provision preflight",
    () =>
      corePool.query(
        `UPDATE durable_jobs
         SET available_at = now(), status = 'pending', locked_at = NULL, locked_by = NULL
         WHERE id = $1`,
        [sharedProvisionWorkerRecord.job_id],
      ),
    async () => {
      const active = await waitFor(
        "Provision Worker lock-order service activation",
        () => request<OrderDetail>(`/api/v1/orders/${sharedProvisionWorkerOrder.order.id}`),
        (value) => value.service.status === "active",
      );
      assert.equal(active.invoice.status, "paid");
      assert.equal(active.order.status, "completed");
      const contradictoryProvision = await waitFor(
        "Provision success callback to win over the later HTTP rejection",
        () => corePool.query<{
          service_status: string;
          order_status: string;
          operation_status: string;
          job_status: string;
          rejection_audits: string;
          conflict_audits: string;
        }>(
          `SELECT
             (SELECT status FROM services WHERE id = $3) AS service_status,
             (SELECT status FROM orders WHERE id = $4) AS order_status,
             (SELECT status FROM provider_operations WHERE id = $1) AS operation_status,
             (SELECT status FROM durable_jobs WHERE id = $2) AS job_status,
             (SELECT count(*)::text
               FROM audit_events
               WHERE action = 'provision.provider_create_rejected'
                 AND target_id = $3::text) AS rejection_audits,
             (SELECT count(*)::text
               FROM audit_events
               WHERE action = 'provision.provider_outcome_conflict'
                 AND target_id = $3::text) AS conflict_audits`,
          [
            sharedProvisionWorkerRecord.operation_id,
            sharedProvisionWorkerRecord.job_id,
            sharedProvisionWorkerRecord.service_id,
            sharedProvisionWorkerOrder.order.id,
          ],
        ).then((result) => result.rows[0]),
        (state) =>
          state?.service_status === "active" &&
          state.order_status === "completed" &&
          state.operation_status === "succeeded" &&
          state.job_status === "completed" &&
          state.rejection_audits === "0" &&
          state.conflict_audits === "1",
      );
      assert.deepEqual(contradictoryProvision, {
        service_status: "active",
        order_status: "completed",
        operation_status: "succeeded",
        job_status: "completed",
        rejection_audits: "0",
        conflict_audits: "1",
      });
    },
  );

  const identityGateClient = await corePool.connect();
  let identityGateOpen = false;
  let sharedCallbackResult:
    | { status: number; body: Record<string, unknown> }
    | undefined;
  try {
    await identityGateClient.query("BEGIN");
    identityGateOpen = true;
    await identityGateClient.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
      sharedUserId,
    ]);
    const callbackPromise = submitPaymentFact({
      eventId: `cross-invoice-callback:${randomUUID()}`,
      providerOperationId: sharedCallbackRecords.operation_id,
      paymentAttemptId: sharedCallbackCommand.paymentAttemptId,
      externalPaymentId: `cross-invoice-payment-${randomUUID()}`,
      status: "succeeded",
      amountMinor: sharedCallbackRecords.amount_minor,
      currency: sharedCallbackRecords.currency,
      occurredAt: new Date().toISOString(),
    });
    const addFundsCallbackPromise = submitPaymentFact({
      eventId: `cross-account-add-funds:${randomUUID()}`,
      providerOperationId: sharedAddFundsRecord.operation_id,
      paymentAttemptId: sharedAddFundsRecord.attempt_id,
      externalPaymentId: `cross-account-add-funds-${randomUUID()}`,
      status: "succeeded",
      amountMinor: sharedAddFundsRecord.amount_minor,
      currency: sharedAddFundsRecord.currency,
      occurredAt: new Date().toISOString(),
    });
    const sharedProvisionExternalId = `cross-account-resource-${randomUUID()}`;
    const provisionCallbackPromise = submitProvisionFact({
      eventId: `cross-account-provision:${randomUUID()}`,
      providerOperationId: sharedProvisionRecord.operation_id,
      status: "succeeded",
      externalResourceId: sharedProvisionExternalId,
      readyAt: new Date().toISOString(),
      occurredAt: new Date().toISOString(),
    });
    await waitFor(
      "Payment, Add Funds, and Provision callbacks to wait at the shared User row",
      async () => {
        const result = await corePool.query<{ waiting: string }>(
          `SELECT count(*)::text AS waiting
           FROM pg_stat_activity
           WHERE application_name = 'opensales-api'
             AND state = 'active'
             AND wait_event_type = 'Lock'
             AND query ILIKE '%SELECT id FROM users WHERE id = $1 FOR UPDATE%'`,
        );
        return result.rows[0]?.waiting ?? "0";
      },
      (waiting) => BigInt(waiting) >= 3n,
    );

    await releasePaymentStart(sharedWorkerCommand.paymentAttemptId);
    await waitFor(
      "three callback types to wait at User while the Worker waits at the account payment-settings fence",
      async () => {
        const result = await corePool.query<{
          callbacks_waiting: string;
          worker_fence_waiting: string;
        }>(
          `SELECT
             (SELECT count(*)::text
                FROM pg_stat_activity
               WHERE application_name = 'opensales-api'
                 AND state = 'active'
                 AND wait_event_type = 'Lock'
                 AND query ILIKE '%SELECT id FROM users WHERE id = $1 FOR UPDATE%')
               AS callbacks_waiting,
             (SELECT count(*)::text
                FROM pg_stat_activity
               WHERE application_name = 'opensales-worker'
                 AND state = 'active'
                 AND wait_event_type = 'Lock'
                 AND query ILIKE '%SELECT pg_advisory_xact_lock(hashtextextended($1, 0))%')
               AS worker_fence_waiting`,
        );
        return result.rows[0];
      },
      (waiting) =>
        BigInt(waiting?.callbacks_waiting ?? "0") >= 3n &&
        BigInt(waiting?.worker_fence_waiting ?? "0") >= 1n,
    );

    const accountProbe = await corePool.connect();
    try {
      await accountProbe.query("BEGIN");
      const unlockedAccount = await accountProbe.query<{ id: string }>(
        `SELECT id
         FROM client_accounts
         WHERE id = $1
         FOR UPDATE NOWAIT`,
        [sharedIdentityMe.clientAccountId],
      );
      assert.equal(unlockedAccount.rows[0]?.id, sharedIdentityMe.clientAccountId);
      await accountProbe.query("COMMIT");
    } catch (error) {
      await accountProbe.query("ROLLBACK");
      throw error;
    } finally {
      accountProbe.release();
    }

    await identityGateClient.query("COMMIT");
    identityGateOpen = false;
    const callbackResults = await Promise.all([
      callbackPromise,
      addFundsCallbackPromise,
      provisionCallbackPromise,
    ]);
    sharedCallbackResult = callbackResults[0];
    assert.equal(callbackResults[1]?.status, 202);
    assert.equal(callbackResults[1]?.body.status, "succeeded");
    assert.equal(callbackResults[2]?.status, 202);
    assert.equal(callbackResults[2]?.body.status, "active");
  } finally {
    if (identityGateOpen) await identityGateClient.query("ROLLBACK");
    identityGateClient.release();
  }
  assert.equal(sharedCallbackResult?.status, 202);
  assert.equal(sharedCallbackResult?.body.status, "succeeded");
  await corePool.query(`
    DROP TRIGGER IF EXISTS integration_delay_cross_lock_provision ON durable_jobs;
    DROP FUNCTION IF EXISTS integration_delay_cross_lock_provision();
  `);
  await corePool.query(
    `UPDATE durable_jobs
     SET available_at = now()
     WHERE job_type = 'provision.start'
       AND payload->>'serviceId' = ANY($1::text[])`,
    [[sharedCallbackOrder.service.id, sharedWorkerOrder.service.id]],
  );
  const sharedCallbackActive = await waitFor(
    "cross-invoice callback service activation",
    () => request<OrderDetail>(`/api/v1/orders/${sharedCallbackOrder.order.id}`),
    (value) => value.service.status === "active",
  );
  const sharedWorkerActive = await waitFor(
    "cross-invoice Worker payment and service activation",
    () => request<OrderDetail>(`/api/v1/orders/${sharedWorkerOrder.order.id}`),
    (value) => value.service.status === "active",
    35_000,
  );
  assert.equal(sharedCallbackActive.invoice.status, "paid");
  assert.equal(sharedWorkerActive.invoice.status, "paid");
  const sharedAddFundsFinal = await waitForAddFunds(
    sharedAddFundsStarted.command.commandId,
    "succeeded",
  );
  assert.equal(sharedAddFundsFinal.attemptStatus, "succeeded");
  assert.equal(sharedAddFundsFinal.providerOperationStatus, "succeeded");
  const sharedAddFundsEffects = await corePool.query<{
    receipts: string;
    credit_transactions: string;
    receipt_journals: string;
    credit_balance_minor: string;
  }>(
    `SELECT
       (SELECT count(*)::text
          FROM fund_receipts
         WHERE reported_add_funds_attempt_id = $1) AS receipts,
       (SELECT count(*)::text
          FROM credit_transactions transaction
          JOIN add_funds_settlements settlement ON settlement.id = transaction.source_id
         WHERE transaction.kind = 'add_funds'
           AND transaction.source_type = 'add_funds_settlement'
           AND settlement.add_funds_attempt_id = $1) AS credit_transactions,
       (SELECT count(*)::text
          FROM ledger_journals journal
          JOIN add_funds_settlements settlement ON settlement.id = journal.source_id
         WHERE journal.source_type = 'add_funds_settlement'
           AND settlement.add_funds_attempt_id = $1) AS receipt_journals,
       (SELECT COALESCE(sum(transaction.credit_minor - transaction.debit_minor), 0)::text
          FROM credit_accounts account
          LEFT JOIN credit_transactions transaction ON transaction.credit_account_id = account.id
         WHERE account.client_account_id = $2 AND account.currency = 'USD') AS credit_balance_minor`,
    [sharedAddFundsRecord.attempt_id, sharedIdentityMe.clientAccountId],
  );
  assert.deepEqual(sharedAddFundsEffects.rows[0], {
    receipts: "1",
    credit_transactions: "1",
    receipt_journals: "1",
    credit_balance_minor: "10000",
  });
  const sharedProvisionFinal = await request<OrderDetail>(
    `/api/v1/orders/${sharedProvisionOrder.order.id}`,
  );
  assert.equal(sharedProvisionFinal.service.status, "active");
  const sharedProvisionEffects = await corePool.query<{
    service_rows: string;
    activation_events: string;
    operation_status: string;
  }>(
    `SELECT
       (SELECT count(*)::text
          FROM services
         WHERE id = $1 AND external_resource_id IS NOT NULL) AS service_rows,
       (SELECT count(*)::text
          FROM outbox
         WHERE event_type = 'service.activated'
           AND unique_key = 'service:' || $1::text) AS activation_events,
       (SELECT status FROM provider_operations WHERE id = $2) AS operation_status`,
    [sharedProvisionRecord.service_id, sharedProvisionRecord.operation_id],
  );
  assert.deepEqual(sharedProvisionEffects.rows[0], {
    service_rows: "1",
    activation_events: "1",
    operation_status: "succeeded",
  });
  const sharedWorkerEffects = await corePool.query<{
    add_funds_receipts: string;
    add_funds_credits: string;
    provision_resources: string;
    provision_events: string;
  }>(
    `SELECT
       (SELECT count(*)::text
          FROM fund_receipts
         WHERE reported_add_funds_attempt_id = $1) AS add_funds_receipts,
       (SELECT count(*)::text
          FROM credit_transactions transaction
          JOIN add_funds_settlements settlement ON settlement.id = transaction.source_id
         WHERE transaction.kind = 'add_funds'
           AND transaction.source_type = 'add_funds_settlement'
           AND settlement.add_funds_attempt_id = $1) AS add_funds_credits,
       (SELECT count(*)::text
          FROM services
         WHERE id = $2 AND external_resource_id IS NOT NULL) AS provision_resources,
       (SELECT count(*)::text
          FROM outbox
         WHERE event_type = 'service.activated'
           AND unique_key = 'service:' || $2::text) AS provision_events`,
    [sharedAddFundsWorkerRecord.attempt_id, sharedProvisionWorkerRecord.service_id],
  );
  assert.deepEqual(sharedWorkerEffects.rows[0], {
    add_funds_receipts: "1",
    add_funds_credits: "1",
    provision_resources: "1",
    provision_events: "1",
  });
  const sharedWorkerProviderEffects = await providerPool.query<{
    add_funds_create_calls: number;
    resource_create_calls: number;
  }>(
    `SELECT
       (SELECT create_calls
          FROM mock_payment_operations
         WHERE operation_id = $1) AS add_funds_create_calls,
       (SELECT create_calls
          FROM mock_resource_operations
         WHERE operation_id = $2) AS resource_create_calls`,
    [sharedAddFundsWorkerRecord.operation_id, sharedProvisionWorkerRecord.operation_id],
  );
  assert.deepEqual(sharedWorkerProviderEffects.rows[0], {
    add_funds_create_calls: 1,
    resource_create_calls: 1,
  });

  const sharedEffects = await corePool.query<{
    order_id: string;
    receipts: string;
    allocations: string;
    fee_charges: string;
    paid_events: string;
    provision_operations: string;
    provision_jobs: string;
  }>(
    `SELECT
       source.order_id,
       (SELECT count(*)::text
          FROM fund_receipts receipt
          JOIN payment_attempts payment ON payment.id = receipt.reported_payment_attempt_id
         WHERE payment.invoice_id = source.invoice_id) AS receipts,
       (SELECT count(*)::text
          FROM payment_allocations allocation
         WHERE allocation.invoice_id = source.invoice_id) AS allocations,
       (SELECT count(*)::text
          FROM invoice_fee_charges charge
          JOIN payment_attempts payment ON payment.id = charge.payment_attempt_id
         WHERE payment.invoice_id = source.invoice_id) AS fee_charges,
       (SELECT count(*)::text
          FROM outbox
         WHERE event_type = 'invoice.paid'
           AND unique_key = 'invoice:' || source.invoice_id::text) AS paid_events,
       (SELECT count(*)::text
          FROM provider_operations operation
         WHERE operation.subject_type = 'service'
           AND operation.kind = 'resource_create'
           AND operation.subject_id = source.service_id) AS provision_operations,
       (SELECT count(*)::text
          FROM durable_jobs job
         WHERE job.job_type = 'provision.start'
           AND job.payload->>'serviceId' = source.service_id::text) AS provision_jobs
     FROM (
       SELECT orders.id AS order_id, invoices.id AS invoice_id, services.id AS service_id
       FROM orders
       JOIN invoices ON invoices.order_id = orders.id
       JOIN order_items ON order_items.order_id = orders.id
       JOIN services ON services.order_item_id = order_items.id
       WHERE orders.id = ANY($1::uuid[])
     ) source
     ORDER BY source.order_id`,
    [[sharedCallbackOrder.order.id, sharedWorkerOrder.order.id]],
  );
  assert.equal(sharedEffects.rowCount, 2);
  for (const effect of sharedEffects.rows) {
    assert.deepEqual(
      {
        receipts: effect.receipts,
        allocations: effect.allocations,
        fee_charges: effect.fee_charges,
        paid_events: effect.paid_events,
        provision_operations: effect.provision_operations,
        provision_jobs: effect.provision_jobs,
      },
      {
        receipts: "1",
        allocations: "1",
        fee_charges: "1",
        paid_events: "1",
        provision_operations: "1",
        provision_jobs: "1",
      },
      `cross-invoice purchase ${effect.order_id} must have exactly one side effect chain`,
    );
  }
} finally {
  cookie = sharedIdentityOriginalCookie;
  await corePool.query(`
    DROP TRIGGER IF EXISTS integration_delay_cross_lock_add_funds ON durable_jobs;
    DROP FUNCTION IF EXISTS integration_delay_cross_lock_add_funds();
    DROP TRIGGER IF EXISTS integration_delay_cross_lock_provision ON durable_jobs;
    DROP FUNCTION IF EXISTS integration_delay_cross_lock_provision();
  `);
}

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
  {
    label: "membership restriction",
    revoke: () =>
      corePool.query(
        `UPDATE client_memberships
         SET restricted_at = now()
         WHERE client_account_id = $1 AND user_id = $2`,
        [staffMe.clientAccountId, staffMe.id],
      ),
    restore: () =>
      corePool.query(
        `UPDATE client_memberships
         SET restricted_at = NULL
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
  await refreshAccountContext(staffMe.clientAccountId);
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

const capabilityOwnerCookie = cookie;
const explicitCapabilityUserId = randomUUID();
const explicitCapabilitySessionId = randomUUID();
const explicitCapabilitySessionToken = randomBytes(32).toString("base64url");
const sessionCookieName = capabilityOwnerCookie.split("=", 1)[0];
assert.ok(sessionCookieName, "integration requires a named Session cookie");
const explicitCapabilityCookie = `${sessionCookieName}=${explicitCapabilitySessionToken}`;
await corePool.query(
  `INSERT INTO users(id, email, password_hash, locale, email_verified_at)
   VALUES ($1, $2, 'synthetic-not-a-password', 'en', now())`,
  [explicitCapabilityUserId, `explicit-payment-${randomUUID()}@example.invalid`],
);
await corePool.query(
  `INSERT INTO client_memberships(
     client_account_id, user_id, role, permissions
   ) VALUES ($1, $2, 'viewer', '["orders.create","billing.write"]'::jsonb)`,
  [staffMe.clientAccountId, explicitCapabilityUserId],
);
await corePool.query(
  `INSERT INTO sessions(
     id, user_id, token_digest, expires_at,
     active_client_account_id, account_context_version
   ) VALUES ($1, $2, $3, now() + interval '1 hour', $4, 1)`,
  [
    explicitCapabilitySessionId,
    explicitCapabilityUserId,
    digestToken(explicitCapabilitySessionToken),
    staffMe.clientAccountId,
  ],
);
cookie = explicitCapabilityCookie;
accountContextVersionByCookie.set(cookie, "1");
try {
  const explicitOrder = await createOrder(automaticPrice.id, legal);
  const explicitQuote = await createPaymentQuote(explicitOrder.invoice.id, "card", false);
  const explicitCommand = await request<PaymentCommand>(
    `/api/v1/invoices/${explicitOrder.invoice.id}/payments`,
    {
      method: "POST",
      body: JSON.stringify({
        quoteId: explicitQuote.quoteId,
        scenario: "success",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  assert.ok(explicitCommand.paymentAttemptId);
  await corePool.query(
    `UPDATE client_memberships
     SET permissions = '["orders.create"]'::jsonb
     WHERE client_account_id = $1 AND user_id = $2`,
    [staffMe.clientAccountId, explicitCapabilityUserId],
  );
  await releasePaymentStart(explicitCommand.paymentAttemptId);
  const explicitRevoked = await waitFor(
    "known-unsent payment to close after explicit billing.write revocation",
    () => readPaymentRecords(explicitCommand.commandId),
    (records) =>
      records.command_status === "failed" &&
      records.attempt_status === "cancelled" &&
      records.operation_status === "failed" &&
      records.job_status === "completed",
    8_000,
  );
  const explicitRevokedProviderCalls = await providerPool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM mock_payment_operations WHERE operation_id = $1",
    [explicitRevoked.operation_id],
  );
  assert.equal(explicitRevokedProviderCalls.rows[0]?.count, "0");

  await corePool.query(
    `UPDATE client_memberships
     SET permissions = '["orders.create","billing.write"]'::jsonb
     WHERE client_account_id = $1 AND user_id = $2`,
    [staffMe.clientAccountId, explicitCapabilityUserId],
  );
  const explicitContext = await corePool.query<{ account_context_version: string }>(
    `SELECT account_context_version::text
     FROM sessions WHERE id = $1`,
    [explicitCapabilitySessionId],
  );
  accountContextVersionByCookie.set(
    cookie,
    explicitContext.rows[0]?.account_context_version ?? "3",
  );
  const explicitRetryQuote = await createPaymentQuote(
    explicitOrder.invoice.id,
    "card",
    false,
  );
  const explicitRetry = await request<PaymentCommand>(
    `/api/v1/invoices/${explicitOrder.invoice.id}/payments`,
    {
      method: "POST",
      body: JSON.stringify({
        quoteId: explicitRetryQuote.quoteId,
        scenario: "success",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  assert.ok(explicitRetry.paymentAttemptId);
  await releasePaymentStart(explicitRetry.paymentAttemptId);
  const explicitRetriedOrder = await waitFor(
    "payment retry after restoring explicit billing.write",
    () => request<OrderDetail>(`/api/v1/orders/${explicitOrder.order.id}`),
    (value) => value.service.status === "active",
  );
  assert.equal(explicitRetriedOrder.invoice.status, "paid");
} finally {
  cookie = capabilityOwnerCookie;
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

const paymentCallbackBeforeRejectOrder = await createOrder(automaticPrice.id, legal);
const paymentCallbackBeforeRejectQuote = await createPaymentQuote(
  paymentCallbackBeforeRejectOrder.invoice.id,
  "card",
  false,
);
const paymentCallbackBeforeReject = await request<PaymentCommand>(
  `/api/v1/invoices/${paymentCallbackBeforeRejectOrder.invoice.id}/payments`,
  {
    method: "POST",
    body: JSON.stringify({
      quoteId: paymentCallbackBeforeRejectQuote.quoteId,
      scenario: "partial_then_reject",
      idempotencyKey: randomUUID(),
    }),
  },
  202,
);
assert.ok(paymentCallbackBeforeReject.paymentAttemptId);
await releasePaymentStart(paymentCallbackBeforeReject.paymentAttemptId);
const preservedPaymentCallbackBeforeReject = await waitFor(
  "Worker to preserve unclaimed invoice funds after the create response rejects",
  async () => {
    const state = await corePool.query<{
      command_status: string;
      attempt_status: string;
      operation_status: string;
      job_status: string;
      invoice_status: string;
      order_status: string;
      service_status: string;
      receipts: string;
      conflicts: string;
      rejections: string;
    }>(
      `SELECT
         command.status AS command_status,
         attempt.status AS attempt_status,
         operation.status AS operation_status,
         job.status AS job_status,
         CASE
           WHEN allocation.allocated_minor = 0 THEN 'open'
           WHEN allocation.allocated_minor < invoice.total_minor THEN 'partially_paid'
           ELSE 'paid'
         END AS invoice_status,
         customer_order.status AS order_status,
         service.status AS service_status,
         (SELECT count(*)::text
            FROM fund_receipts receipt
           WHERE receipt.reported_payment_attempt_id = attempt.id
             AND receipt.disposition = 'unclaimed') AS receipts,
         (SELECT count(*)::text
            FROM audit_events audit
           WHERE audit.action = 'payment.provider_outcome_conflict'
             AND audit.target_id = attempt.id::text) AS conflicts,
         (SELECT count(*)::text
            FROM audit_events audit
           WHERE audit.action = 'payment.provider_create_rejected'
             AND audit.target_id = attempt.id::text) AS rejections
       FROM invoice_payment_commands command
       JOIN payment_attempts attempt ON attempt.id = command.payment_attempt_id
       JOIN provider_operations operation
         ON operation.subject_type = 'payment'
        AND operation.subject_id = attempt.id
       JOIN durable_jobs job
         ON job.job_type = 'payment.start'
        AND job.payload->>'paymentAttemptId' = attempt.id::text
       JOIN invoices invoice ON invoice.id = attempt.invoice_id
       JOIN invoice_allocation_totals allocation ON allocation.invoice_id = invoice.id
       JOIN orders customer_order ON customer_order.id = invoice.order_id
       JOIN order_items item ON item.order_id = customer_order.id
       JOIN services service ON service.order_item_id = item.id
       WHERE command.id = $1`,
      [paymentCallbackBeforeReject.commandId],
    );
    return state.rows[0];
  },
  (state) =>
    state?.command_status === "manual" &&
    state.attempt_status === "unknown" &&
    state.operation_status === "unknown" &&
    state.job_status === "completed" &&
    state.invoice_status === "open" &&
    state.order_status === "waiting_payment" &&
    state.service_status === "pending" &&
    state.receipts === "1" &&
    state.conflicts === "1" &&
    state.rejections === "0",
  8_000,
);
assert.equal(preservedPaymentCallbackBeforeReject?.receipts, "1");
const paymentCallbackBeforeRejectProvider = await providerPool.query<{ create_calls: number }>(
  "SELECT create_calls FROM mock_payment_operations WHERE operation_id = $1",
  [(await readPaymentRecords(paymentCallbackBeforeReject.commandId)).operation_id],
);
assert.equal(paymentCallbackBeforeRejectProvider.rows[0]?.create_calls, 1);

const paymentCallbackBeforeTimeoutOrder = await createOrder(automaticPrice.id, legal);
const paymentCallbackBeforeTimeoutQuote = await createPaymentQuote(
  paymentCallbackBeforeTimeoutOrder.invoice.id,
  "card",
  false,
);
const paymentCallbackBeforeTimeout = await request<PaymentCommand>(
  `/api/v1/invoices/${paymentCallbackBeforeTimeoutOrder.invoice.id}/payments`,
  {
    method: "POST",
    body: JSON.stringify({
      quoteId: paymentCallbackBeforeTimeoutQuote.quoteId,
      scenario: "partial_then_timeout",
      idempotencyKey: randomUUID(),
    }),
  },
  202,
);
assert.ok(paymentCallbackBeforeTimeout.paymentAttemptId);
await releasePaymentStart(paymentCallbackBeforeTimeout.paymentAttemptId);
const preservedPaymentCallbackBeforeTimeout = await waitFor(
  "Worker transport timeout to preserve the earlier unclaimed payment receipt",
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
         (SELECT count(*)::text
            FROM fund_receipts receipt
           WHERE receipt.reported_payment_attempt_id = attempt.id
             AND receipt.disposition = 'unclaimed') AS receipts
       FROM invoice_payment_commands command
       JOIN payment_attempts attempt ON attempt.id = command.payment_attempt_id
       JOIN provider_operations operation
         ON operation.subject_type = 'payment'
        AND operation.subject_id = attempt.id
       JOIN durable_jobs job
         ON job.job_type = 'payment.start'
        AND job.payload->>'paymentAttemptId' = attempt.id::text
       WHERE command.id = $1`,
      [paymentCallbackBeforeTimeout.commandId],
    );
    return state.rows[0];
  },
  (state) =>
    state?.command_status === "manual" &&
    state.attempt_status === "unknown" &&
    state.operation_status === "unknown" &&
    state.job_status === "completed" &&
    state.receipts === "1",
  30_000,
);
assert.equal(preservedPaymentCallbackBeforeTimeout?.command_status, "manual");
const paymentCallbackBeforeTimeoutProvider = await providerPool.query<{ create_calls: number }>(
  "SELECT create_calls FROM mock_payment_operations WHERE operation_id = $1",
  [(await readPaymentRecords(paymentCallbackBeforeTimeout.commandId)).operation_id],
);
assert.equal(paymentCallbackBeforeTimeoutProvider.rows[0]?.create_calls, 1);

const paymentSuccessBeforeRejectOrder = await createOrder(automaticPrice.id, legal);
const paymentSuccessBeforeRejectQuote = await createPaymentQuote(
  paymentSuccessBeforeRejectOrder.invoice.id,
  "card",
  false,
);
const paymentSuccessBeforeReject = await request<PaymentCommand>(
  `/api/v1/invoices/${paymentSuccessBeforeRejectOrder.invoice.id}/payments`,
  {
    method: "POST",
    body: JSON.stringify({
      quoteId: paymentSuccessBeforeRejectQuote.quoteId,
      scenario: "success_then_reject",
      idempotencyKey: randomUUID(),
    }),
  },
  202,
);
assert.ok(paymentSuccessBeforeReject.paymentAttemptId);
await releasePaymentStart(paymentSuccessBeforeReject.paymentAttemptId);
const preservedPaymentSuccessBeforeReject = await waitFor(
  "Worker to preserve and audit full payment success after the create response rejects",
  async () => {
    const state = await corePool.query<{
      command_status: string;
      attempt_status: string;
      operation_status: string;
      job_status: string;
      order_status: string;
      service_status: string;
      conflicts: string;
      rejections: string;
    }>(
      `SELECT
         command.status AS command_status,
         attempt.status AS attempt_status,
         operation.status AS operation_status,
         job.status AS job_status,
         customer_order.status AS order_status,
         service.status AS service_status,
         (SELECT count(*)::text
            FROM audit_events audit
           WHERE audit.action = 'payment.provider_outcome_conflict'
             AND audit.target_id = attempt.id::text) AS conflicts,
         (SELECT count(*)::text
            FROM audit_events audit
           WHERE audit.action = 'payment.provider_create_rejected'
             AND audit.target_id = attempt.id::text) AS rejections
       FROM invoice_payment_commands command
       JOIN payment_attempts attempt ON attempt.id = command.payment_attempt_id
       JOIN provider_operations operation
         ON operation.subject_type = 'payment'
        AND operation.subject_id = attempt.id
       JOIN durable_jobs job
         ON job.job_type = 'payment.start'
        AND job.payload->>'paymentAttemptId' = attempt.id::text
       JOIN invoices invoice ON invoice.id = attempt.invoice_id
       JOIN orders customer_order ON customer_order.id = invoice.order_id
       JOIN order_items item ON item.order_id = customer_order.id
       JOIN services service ON service.order_item_id = item.id
       WHERE command.id = $1`,
      [paymentSuccessBeforeReject.commandId],
    );
    return state.rows[0];
  },
  (state) =>
    state?.command_status === "succeeded" &&
    state.attempt_status === "succeeded" &&
    state.operation_status === "succeeded" &&
    state.job_status === "completed" &&
    state.order_status === "completed" &&
    state.service_status === "active" &&
    state.conflicts === "1" &&
    state.rejections === "0",
  30_000,
);
assert.equal(preservedPaymentSuccessBeforeReject?.service_status, "active");
const paymentSuccessBeforeRejectProvider = await providerPool.query<{ create_calls: number }>(
  "SELECT create_calls FROM mock_payment_operations WHERE operation_id = $1",
  [(await readPaymentRecords(paymentSuccessBeforeReject.commandId)).operation_id],
);
assert.equal(paymentSuccessBeforeRejectProvider.rows[0]?.create_calls, 1);

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
await refreshAccountContext(staffMe.clientAccountId);

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
        FROM credit_transactions transaction
        JOIN credit_accounts account ON account.id = transaction.credit_account_id
       WHERE transaction.kind = 'add_funds'
         AND transaction.source_type = 'add_funds_settlement'
         AND account.client_account_id = $1) AS credits,
     (SELECT count(*)::text
        FROM add_funds_settlements settlement
        JOIN add_funds_attempts attempt ON attempt.id = settlement.add_funds_attempt_id
       WHERE attempt.client_account_id = $1) AS settlements,
     (SELECT count(*)::text
        FROM fund_receipts
       WHERE reported_add_funds_attempt_id IS NOT NULL
         AND disposition = 'allocated'
         AND client_account_id = $1) AS receipts,
     (SELECT count(*)::text
        FROM ledger_journals journal
        JOIN add_funds_settlements settlement ON settlement.id = journal.source_id
        JOIN add_funds_attempts attempt ON attempt.id = settlement.add_funds_attempt_id
       WHERE journal.source_type = 'add_funds_settlement'
         AND attempt.client_account_id = $1) AS journals,
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
const definitiveAddFundsQuote = await createAddFundsQuote("5000", "card");
const definitiveAddFunds = await startAddFunds(
  definitiveAddFundsQuote.quoteId,
  "definitive_reject",
);
await waitForAddFunds(definitiveAddFunds.command.commandId, "failed");
const definitiveAddFundsFacts = await corePool.query<{
  attempt_status: string;
  command_status: string;
  operation_status: string;
  job_status: string;
  receipts: string;
  audits: string;
}>(
  `SELECT attempt.status AS attempt_status,
          command.status AS command_status,
          operation.status AS operation_status,
          job.status AS job_status,
          (SELECT count(*)::text
             FROM fund_receipts receipt
            WHERE receipt.reported_add_funds_attempt_id = attempt.id) AS receipts,
          (SELECT count(*)::text
            FROM audit_events audit
           WHERE audit.action = 'add_funds.known_unsent_rejected'
              AND audit.target_id = attempt.id::text) AS audits
   FROM add_funds_attempts attempt
   JOIN add_funds_commands command ON command.add_funds_attempt_id = attempt.id
   JOIN provider_operations operation
     ON operation.subject_type = 'add_funds'
    AND operation.subject_id = attempt.id
   JOIN durable_jobs job
     ON job.job_type = 'add_funds.start'
    AND job.payload->>'addFundsAttemptId' = attempt.id::text
   WHERE command.id = $1`,
  [definitiveAddFunds.command.commandId],
);
assert.deepEqual(definitiveAddFundsFacts.rows[0], {
  attempt_status: "failed",
  command_status: "failed",
  operation_status: "failed",
  job_status: "completed",
  receipts: "0",
  audits: "1",
});

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
await refreshAccountContext(recoveryMe.clientAccountId);
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
    // The Provider callback now deliberately owns User and Client Account
    // before inserting its receipt (foreign keys would otherwise acquire the
    // Account row first implicitly). The staff allocation is observed waiting
    // on Invoice above, so it cannot have reached its later Account lock.

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
  assert.equal(staleStaffAllocation.body.code, "INVOICE_NOT_PAYABLE");
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

  const dismissedSuccessOccurredAt = new Date(Date.now() + 1_000).toISOString();
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
  const correctionPossiblySentRefund = await request<RefundRecord>(
    `/api/v1/admin/invoices/${externalReuseOrder.invoice.id}/refunds`,
    {
      method: "POST",
      body: JSON.stringify({
        receiptId: correctionRaceCandidate.receiptId,
        destination: "original_payment",
        amountMode: "partial",
        amountMinor: "20",
        expectedRefundableMinor: correctionRaceCandidate.refundableMinor,
        scenario: "success",
        reason:
          "Synthetic competing refund may have reached the Provider before dismissal correction",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  assert.ok(correctionPossiblySentRefund.providerOperationId);
  await corePool.query(
    `UPDATE refunds
     SET status = 'processing', updated_at = now(), version = version + 1
     WHERE id = $1 AND status = 'queued'`,
    [correctionPossiblySentRefund.refundId],
  );
  await corePool.query(
    `UPDATE refunds
     SET status = 'unknown', updated_at = now(), version = version + 1
     WHERE id = $1 AND status = 'processing'`,
    [correctionPossiblySentRefund.refundId],
  );
  await corePool.query(
    `UPDATE provider_operations
     SET status = 'unknown', attempt_count = 1,
         last_error = 'Synthetic ambiguous Provider transport result', updated_at = now()
     WHERE id = $1 AND status = 'queued'`,
    [correctionPossiblySentRefund.providerOperationId],
  );
  await corePool.query(
    `UPDATE durable_jobs
     SET status = 'manual', last_error = 'Synthetic ambiguous Provider transport result',
         updated_at = now()
     WHERE job_type = 'refund.start' AND payload->>'refundId' = $1`,
    [correctionPossiblySentRefund.refundId],
  );
  const correctionKnownUnsentCandidates = await request<{ items: RefundCandidate[] }>(
    "/api/v1/admin/refund-candidates",
  );
  const correctionKnownUnsentCandidate = correctionKnownUnsentCandidates.items.find(
    (candidate) => candidate.receiptId === externalReuseCandidate.receiptId,
  );
  assert.ok(correctionKnownUnsentCandidate);
  const correctionCompetingRefund = await request<RefundRecord>(
    `/api/v1/admin/invoices/${externalReuseOrder.invoice.id}/refunds`,
    {
      method: "POST",
      body: JSON.stringify({
        receiptId: correctionKnownUnsentCandidate.receiptId,
        destination: "original_payment",
        amountMode: "full",
        amountMinor: null,
        expectedRefundableMinor: correctionKnownUnsentCandidate.refundableMinor,
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
  const possiblySentCorrectionState = await corePool.query<{
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
     JOIN provider_operations operation ON operation.id = $2
     JOIN durable_jobs job
       ON job.job_type = 'refund.start' AND job.payload->>'refundId' = refund.id::text
     WHERE refund.id = $1`,
    [correctionPossiblySentRefund.refundId, correctionPossiblySentRefund.providerOperationId],
  );
  assert.equal(possiblySentCorrectionState.rows[0]?.refund_status, "manual");
  assert.equal(possiblySentCorrectionState.rows[0]?.refund_security_hold, false);
  assert.equal(
    possiblySentCorrectionState.rows[0]?.frozen_by_correction_id,
    correctedDismissal.correctionId,
  );
  assert.equal(possiblySentCorrectionState.rows[0]?.operation_status, "unknown");
  assert.equal(possiblySentCorrectionState.rows[0]?.operation_attempt_count, 1);
  assert.equal(possiblySentCorrectionState.rows[0]?.job_status, "manual");
  const possiblySentManualRecord = await request<RefundRecord>(
    `/api/v1/admin/refunds/${correctionPossiblySentRefund.refundId}`,
  );
  const possiblySentNoOutflow = await request<{ status: string; replayed: boolean }>(
    `/api/v1/admin/refunds/${correctionPossiblySentRefund.refundId}/manual-actions`,
    {
      method: "POST",
      body: JSON.stringify({
        action: "confirm_no_outflow",
        reason:
          "Synthetic administrator queried the Provider and confirmed the frozen request had no outflow",
        idempotencyKey: randomUUID(),
        expectedRefundVersion: possiblySentManualRecord.version,
      }),
    },
    201,
  );
  assert.equal(possiblySentNoOutflow.status, "confirmed_no_outflow");
  assert.equal(possiblySentNoOutflow.replayed, false);
  const correctionRaceProviderCalls = await providerPool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM mock_refund_operations
     WHERE refund_id IN ($1, $2)`,
    [correctionCompetingRefund.refundId, correctionPossiblySentRefund.refundId],
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
    occurredAt: new Date(Date.now() + 2_000).toISOString(),
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
    occurredAt: new Date(Date.now() + 3_000).toISOString(),
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

  const callbackFirstOrder = await createOrder(automaticPrice.id, legal);
  const paidCallbackFirstOrder = await pay(callbackFirstOrder, "success");
  assert.equal(paidCallbackFirstOrder.invoice.status, "paid");
  const callbackFirstCandidates = await request<{ items: RefundCandidate[] }>(
    "/api/v1/admin/refund-candidates",
  );
  const callbackFirstCandidate = callbackFirstCandidates.items.find(
    (candidate) => candidate.invoiceId === callbackFirstOrder.invoice.id,
  );
  assert.ok(callbackFirstCandidate);
  const callbackFirstDismissedRefund = await request<RefundRecord>(
    `/api/v1/admin/invoices/${callbackFirstOrder.invoice.id}/refunds`,
    {
      method: "POST",
      body: JSON.stringify({
        receiptId: callbackFirstCandidate.receiptId,
        destination: "original_payment",
        amountMode: "partial",
        amountMinor: "25",
        expectedRefundableMinor: callbackFirstCandidate.refundableMinor,
        scenario: "failed",
        reason:
          "Synthetic first refund fails before a later success is dismissed and corrected",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  assert.ok(callbackFirstDismissedRefund.providerOperationId);
  await corePool.query(
    `UPDATE refunds
     SET status = 'processing', updated_at = now(), version = version + 1
     WHERE id = $1 AND status = 'queued'`,
    [callbackFirstDismissedRefund.refundId],
  );
  await corePool.query(
    `UPDATE provider_operations
     SET status = 'running', attempt_count = 1, updated_at = now()
     WHERE id = $1 AND status = 'queued'`,
    [callbackFirstDismissedRefund.providerOperationId],
  );
  await corePool.query(
    `UPDATE durable_jobs
     SET status = 'manual', last_error = 'Synthetic callback controls this operation',
         updated_at = now()
     WHERE job_type = 'refund.start' AND payload->>'refundId' = $1`,
    [callbackFirstDismissedRefund.refundId],
  );
  const callbackFirstBaseTime = Date.now() + 5_000;
  const callbackFirstFailure = await submitRefundFact({
    eventId: `refund-callback-first-failure:${randomUUID()}`,
    providerOperationId: callbackFirstDismissedRefund.providerOperationId,
    refundId: callbackFirstDismissedRefund.refundId,
    externalRefundId: `mock-refund-callback-first-failed:${callbackFirstDismissedRefund.refundId}`,
    status: "failed",
    amountMinor: "25",
    currency: "USD",
    occurredAt: new Date(callbackFirstBaseTime).toISOString(),
  });
  assert.equal(callbackFirstFailure.status, 202);
  assert.equal(callbackFirstFailure.body.status, "failed");
  const callbackFirstLateSuccess = await submitRefundFact({
    eventId: `refund-callback-first-late-success:${randomUUID()}`,
    providerOperationId: callbackFirstDismissedRefund.providerOperationId,
    refundId: callbackFirstDismissedRefund.refundId,
    externalRefundId: `mock-refund-browser-capacity-overage:${callbackFirstDismissedRefund.refundId}`,
    status: "succeeded",
    amountMinor: "25",
    currency: "USD",
    occurredAt: new Date(callbackFirstBaseTime + 1_000).toISOString(),
  });
  assert.equal(callbackFirstLateSuccess.status, 202);
  assert.equal(callbackFirstLateSuccess.body.status, "manual");
  const callbackFirstHolds = await request<{ items: RefundSecurityHold[] }>(
    "/api/v1/admin/refund-security-holds",
  );
  const callbackFirstHold = callbackFirstHolds.items.find(
    (hold) => hold.refundId === callbackFirstDismissedRefund.refundId,
  );
  assert.ok(callbackFirstHold);
  const callbackFirstDismissal = await adjudicateRefundHold(
    callbackFirstHold,
    "dismiss_provider_claim",
    "Synthetic administrator initially dismissed the callback-first Provider success",
  );
  const callbackFirstFullCandidates = await request<{ items: RefundCandidate[] }>(
    "/api/v1/admin/refund-candidates",
  );
  const callbackFirstFullCandidate = callbackFirstFullCandidates.items.find(
    (candidate) => candidate.receiptId === callbackFirstCandidate.receiptId,
  );
  assert.ok(callbackFirstFullCandidate);
  const callbackFirstWinningRefund = await request<RefundRecord>(
    `/api/v1/admin/invoices/${callbackFirstOrder.invoice.id}/refunds`,
    {
      method: "POST",
      body: JSON.stringify({
        receiptId: callbackFirstFullCandidate.receiptId,
        destination: "original_payment",
        amountMode: "full",
        amountMinor: null,
        expectedRefundableMinor: callbackFirstFullCandidate.refundableMinor,
        scenario: "success",
        reason:
          "Synthetic competing full refund succeeds before the dismissed outflow correction",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  assert.ok(callbackFirstWinningRefund.providerOperationId);
  await corePool.query(
    `UPDATE refunds
     SET status = 'processing', updated_at = now(), version = version + 1
     WHERE id = $1 AND status = 'queued'`,
    [callbackFirstWinningRefund.refundId],
  );
  await corePool.query(
    `UPDATE provider_operations
     SET status = 'running', attempt_count = 1, updated_at = now()
     WHERE id = $1 AND status = 'queued'`,
    [callbackFirstWinningRefund.providerOperationId],
  );
  await corePool.query(
    `UPDATE durable_jobs
     SET status = 'manual', last_error = 'Synthetic callback controls this operation',
         updated_at = now()
     WHERE job_type = 'refund.start' AND payload->>'refundId' = $1`,
    [callbackFirstWinningRefund.refundId],
  );
  const callbackFirstWinningSuccess = await submitRefundFact({
    eventId: `refund-callback-first-winning-success:${randomUUID()}`,
    providerOperationId: callbackFirstWinningRefund.providerOperationId,
    refundId: callbackFirstWinningRefund.refundId,
    externalRefundId: `mock-refund-callback-first-winning:${callbackFirstWinningRefund.refundId}`,
    status: "succeeded",
    amountMinor: callbackFirstFullCandidate.refundableMinor,
    currency: "USD",
    occurredAt: new Date(callbackFirstBaseTime + 2_000).toISOString(),
  });
  assert.equal(callbackFirstWinningSuccess.status, 202);
  assert.equal(callbackFirstWinningSuccess.body.status, "succeeded");
  const callbackFirstCorrectable = await request<{ items: RefundDismissalCorrection[] }>(
    "/api/v1/admin/refund-dismissal-corrections",
  );
  const callbackFirstCorrection = callbackFirstCorrectable.items.find(
    (item) => item.adjudicationId === callbackFirstDismissal.adjudicationId,
  );
  assert.ok(callbackFirstCorrection);
  await request(
    "/api/v1/auth/reauth",
    { method: "POST", body: JSON.stringify({ password }) },
    200,
  );
  const callbackFirstCorrectionResult = await request<{
    correctionId: string;
    status: string;
  }>(
    `/api/v1/admin/refund-adjudications/${callbackFirstCorrection.adjudicationId}/corrections`,
    {
      method: "POST",
      body: JSON.stringify({
        reason:
          "Synthetic later evidence confirms the first real outflow after the competing callback won",
        idempotencyKey: randomUUID(),
        expectedRefundVersion: callbackFirstCorrection.refundVersion,
      }),
    },
    201,
  );
  assert.equal(callbackFirstCorrectionResult.status, "dismissed_outflow_confirmed");
  const callbackFirstIncidents = await request<{
    items: RefundReceiptCapacityIncident[];
  }>("/api/v1/admin/refund-receipt-capacity-incidents");
  const callbackFirstIncident = callbackFirstIncidents.items.find(
    (incident) =>
      incident.source.type === "dismissal_correction" &&
      incident.source.correctionId === callbackFirstCorrectionResult.correctionId,
  );
  assert.ok(callbackFirstIncident);
  assert.equal(callbackFirstIncident.refundId, callbackFirstDismissedRefund.refundId);
  assert.equal(callbackFirstIncident.receiptId, callbackFirstCandidate.receiptId);
  assert.equal(callbackFirstIncident.receiptSequence, "1");
  assert.equal(callbackFirstIncident.receiptAmountMinor, callbackFirstFullCandidate.refundableMinor);
  assert.equal(callbackFirstIncident.overageMinor, "25");
  assert.equal(
    callbackFirstIncident.confirmedCompensationMinor,
    (BigInt(callbackFirstFullCandidate.refundableMinor) + 25n).toString(),
  );
  const callbackFirstLedger = await corePool.query<{
    settlements: string;
    corrections: string;
    incidents: string;
    acknowledgements: string;
  }>(
    `SELECT
       (SELECT count(*)::text
        FROM refunds refund
        JOIN refund_settlements settlement ON settlement.refund_id = refund.id
        WHERE refund.source_fund_receipt_id = $1) AS settlements,
       (SELECT count(*)::text
        FROM refunds refund
        JOIN refund_discrepancy_settlements discrepancy ON discrepancy.refund_id = refund.id
        JOIN refund_adjudication_corrections correction
          ON correction.discrepancy_settlement_id = discrepancy.id
        WHERE refund.source_fund_receipt_id = $1) AS corrections,
       (SELECT count(*)::text FROM refund_receipt_capacity_incidents
        WHERE source_fund_receipt_id = $1) AS incidents,
       (SELECT count(*)::text
        FROM refund_receipt_capacity_acknowledgements acknowledgement
        JOIN refund_receipt_capacity_incidents incident
          ON incident.id = acknowledgement.incident_id
        WHERE incident.source_fund_receipt_id = $1) AS acknowledgements`,
    [callbackFirstCandidate.receiptId],
  );
  assert.equal(callbackFirstLedger.rows[0]?.settlements, "1");
  assert.equal(callbackFirstLedger.rows[0]?.corrections, "1");
  assert.equal(callbackFirstLedger.rows[0]?.incidents, "1");
  assert.equal(callbackFirstLedger.rows[0]?.acknowledgements, "0");
  assert.equal(callbackFirstIncident.isCurrentSnapshot, true);
  assert.equal(callbackFirstIncident.status, "awaiting_acknowledgement");
  assert.equal(callbackFirstIncident.allowedAction, "acknowledge_manual_recovery");
  const capacityFinancialSnapshot = async () => {
    const snapshot = await corePool.query<{
      settlements: string;
      discrepancies: string;
      corrections: string;
      cash_credits: string;
      credit_liability_credits: string;
    }>(
      `SELECT
         (SELECT count(*)::text
          FROM refunds refund
          JOIN refund_settlements settlement ON settlement.refund_id = refund.id
          WHERE refund.source_fund_receipt_id = $1) AS settlements,
         (SELECT count(*)::text
          FROM refunds refund
          JOIN refund_discrepancy_settlements discrepancy ON discrepancy.refund_id = refund.id
          WHERE refund.source_fund_receipt_id = $1) AS discrepancies,
         (SELECT count(*)::text
          FROM refunds refund
          JOIN refund_discrepancy_settlements discrepancy ON discrepancy.refund_id = refund.id
          JOIN refund_adjudication_corrections correction
            ON correction.discrepancy_settlement_id = discrepancy.id
          WHERE refund.source_fund_receipt_id = $1) AS corrections,
         COALESCE((
           SELECT sum(line.credit_minor)::text
           FROM ledger_journals journal
           JOIN ledger_lines line ON line.journal_id = journal.id
           WHERE line.account_code = 'mock_cash'
             AND (
               (journal.source_type = 'refund' AND EXISTS (
                 SELECT 1
                 FROM refunds refund
                 WHERE refund.source_fund_receipt_id = $1
                   AND refund.id = journal.source_id
               ))
               OR
               (journal.source_type = 'refund_provider_discrepancy' AND EXISTS (
                 SELECT 1
                 FROM refunds refund
                 JOIN refund_discrepancy_settlements discrepancy ON discrepancy.refund_id = refund.id
                 WHERE refund.source_fund_receipt_id = $1
                   AND discrepancy.id = journal.source_id
               ))
               OR
               (journal.source_type = 'refund_adjudication_correction' AND EXISTS (
                 SELECT 1
                 FROM refunds refund
                 JOIN refund_discrepancy_settlements discrepancy ON discrepancy.refund_id = refund.id
                 JOIN refund_adjudication_corrections correction
                   ON correction.discrepancy_settlement_id = discrepancy.id
                 WHERE refund.source_fund_receipt_id = $1
                   AND correction.id = journal.source_id
               ))
             )
         ), '0') AS cash_credits,
         COALESCE((
           SELECT sum(line.credit_minor)::text
           FROM ledger_journals journal
           JOIN ledger_lines line ON line.journal_id = journal.id
           WHERE line.account_code = 'client_credit_liability'
             AND journal.source_type = 'refund'
             AND EXISTS (
               SELECT 1
               FROM refunds refund
               WHERE refund.source_fund_receipt_id = $1
                 AND refund.id = journal.source_id
             )
         ), '0') AS credit_liability_credits`,
      [callbackFirstCandidate.receiptId],
    );
    return snapshot.rows[0];
  };
  const beforeCapacityAcknowledgement = await capacityFinancialSnapshot();
  const capacityAcknowledgementKey = randomUUID();
  const capacityAcknowledgementBody = {
    reason:
      "Synthetic administrator owns the current receipt overage while recovery remains outstanding",
    idempotencyKey: capacityAcknowledgementKey,
    expectedConfirmedCompensationMinor:
      callbackFirstIncident.confirmedCompensationMinor,
    expectedOverageMinor: callbackFirstIncident.overageMinor,
  };
  const capacityAcknowledgement = await request<{
    acknowledgementId: string;
    replayed: boolean;
  }>(
    `/api/v1/admin/refund-receipt-capacity-incidents/${callbackFirstIncident.incidentId}/acknowledgements`,
    { method: "POST", body: JSON.stringify(capacityAcknowledgementBody) },
    201,
  );
  assert.equal(capacityAcknowledgement.replayed, false);
  const capacityAcknowledgementReplay = await request<{
    acknowledgementId: string;
    replayed: boolean;
  }>(
    `/api/v1/admin/refund-receipt-capacity-incidents/${callbackFirstIncident.incidentId}/acknowledgements`,
    { method: "POST", body: JSON.stringify(capacityAcknowledgementBody) },
    200,
  );
  assert.equal(
    capacityAcknowledgementReplay.acknowledgementId,
    capacityAcknowledgement.acknowledgementId,
  );
  assert.equal(capacityAcknowledgementReplay.replayed, true);
  const semanticCapacityReplay = await request<{
    acknowledgementId: string;
    replayed: boolean;
  }>(
    `/api/v1/admin/refund-receipt-capacity-incidents/${callbackFirstIncident.incidentId}/acknowledgements`,
    {
      method: "POST",
      body: JSON.stringify({
        ...capacityAcknowledgementBody,
        idempotencyKey: randomUUID(),
      }),
    },
    200,
  );
  assert.equal(
    semanticCapacityReplay.acknowledgementId,
    capacityAcknowledgement.acknowledgementId,
  );
  assert.equal(semanticCapacityReplay.replayed, true);
  await request(
    `/api/v1/admin/refund-receipt-capacity-incidents/${callbackFirstIncident.incidentId}/acknowledgements`,
    {
      method: "POST",
      body: JSON.stringify({
        ...capacityAcknowledgementBody,
        reason: "Synthetic conflicting reuse tries to change the acknowledged ownership decision",
      }),
    },
    409,
  );
  const afterCapacityAcknowledgement = await capacityFinancialSnapshot();
  assert.deepEqual(afterCapacityAcknowledgement, beforeCapacityAcknowledgement);
  const incidentsAfterAcknowledgement = await request<{
    items: RefundReceiptCapacityIncident[];
  }>("/api/v1/admin/refund-receipt-capacity-incidents");
  const acknowledgedFirstIncident = incidentsAfterAcknowledgement.items.find(
    (incident) => incident.incidentId === callbackFirstIncident.incidentId,
  );
  assert.ok(acknowledgedFirstIncident);
  assert.equal(acknowledgedFirstIncident.isCurrentSnapshot, true);
  assert.equal(acknowledgedFirstIncident.status, "acknowledged_recovery_outstanding");
  assert.equal(acknowledgedFirstIncident.acknowledgement?.recoveryOutstanding, true);
  const laterUnexpectedExternalId =
    `mock-refund-callback-first-later-unexpected:${callbackFirstWinningRefund.refundId}`;
  const laterUnexpectedSuccess = await submitRefundFact({
    eventId: `refund-callback-first-later-unexpected:${randomUUID()}`,
    providerOperationId: callbackFirstWinningRefund.providerOperationId,
    refundId: callbackFirstWinningRefund.refundId,
    externalRefundId: laterUnexpectedExternalId,
    status: "succeeded",
    amountMinor: "7",
    currency: "USD",
    occurredAt: new Date(callbackFirstBaseTime + 3_000).toISOString(),
  });
  assert.equal(laterUnexpectedSuccess.status, 202);
  assert.equal(laterUnexpectedSuccess.body.status, "succeeded");
  assert.equal(laterUnexpectedSuccess.body.securityHold, true);
  const laterUnexpectedHolds = await request<{ items: RefundSecurityHold[] }>(
    "/api/v1/admin/refund-security-holds",
  );
  const laterUnexpectedHold = laterUnexpectedHolds.items.find(
    (hold) =>
      hold.refundId === callbackFirstWinningRefund.refundId &&
      hold.providerFact.externalRefundId === laterUnexpectedExternalId,
  );
  assert.ok(laterUnexpectedHold);
  const laterUnexpectedAdjudication = await adjudicateRefundHold(
    laterUnexpectedHold,
    "record_unexpected_outflow",
    "Synthetic administrator records a later real outflow after the first capacity incident",
  );
  const incidentsAfterLaterOutflow = await request<{
    items: RefundReceiptCapacityIncident[];
  }>("/api/v1/admin/refund-receipt-capacity-incidents");
  const laterUnexpectedIncident = incidentsAfterLaterOutflow.items.find(
    (incident) =>
      incident.source.type === "unexpected_outflow_adjudication" &&
      incident.source.adjudicationId === laterUnexpectedAdjudication.adjudicationId,
  );
  assert.ok(laterUnexpectedIncident);
  assert.equal(laterUnexpectedIncident.overageMinor, "32");
  assert.equal(laterUnexpectedIncident.receiptSequence, "2");
  assert.equal(
    laterUnexpectedIncident.confirmedCompensationMinor,
    (BigInt(callbackFirstFullCandidate.refundableMinor) + 32n).toString(),
  );
  assert.equal(
    incidentsAfterLaterOutflow.items.filter(
      (incident) => incident.receiptId === callbackFirstCandidate.receiptId,
    ).length,
    2,
  );
  const supersededFirstIncident = incidentsAfterLaterOutflow.items.find(
    (incident) => incident.incidentId === callbackFirstIncident.incidentId,
  );
  assert.ok(supersededFirstIncident);
  assert.equal(supersededFirstIncident.isCurrentSnapshot, false);
  assert.equal(supersededFirstIncident.status, "superseded_history");
  assert.equal(supersededFirstIncident.allowedAction, null);
  assert.equal(supersededFirstIncident.acknowledgement?.recoveryOutstanding, false);
  assert.equal(laterUnexpectedIncident.isCurrentSnapshot, true);
  assert.equal(laterUnexpectedIncident.status, "awaiting_acknowledgement");
  assert.equal(laterUnexpectedIncident.allowedAction, "acknowledge_manual_recovery");
  await request(
    `/api/v1/admin/refund-receipt-capacity-incidents/${callbackFirstIncident.incidentId}/acknowledgements`,
    {
      method: "POST",
      body: JSON.stringify({
        reason: "Synthetic administrator must not acknowledge a superseded cumulative snapshot",
        idempotencyKey: randomUUID(),
        expectedConfirmedCompensationMinor:
          callbackFirstIncident.confirmedCompensationMinor,
        expectedOverageMinor: callbackFirstIncident.overageMinor,
      }),
    },
    409,
  );
  await assert.rejects(
    corePool.query(
      `INSERT INTO refund_receipt_capacity_acknowledgements(
         incident_id, staff_user_id, staff_session_id, reason, idempotency_key,
         request_fingerprint, expected_confirmed_compensation_minor,
         expected_overage_minor
       )
       SELECT incident_id, staff_user_id, staff_session_id,
              'Synthetic direct acknowledgement must reject a superseded snapshot',
              $2, $3, expected_confirmed_compensation_minor, expected_overage_minor
       FROM refund_receipt_capacity_acknowledgements
       WHERE id = $1`,
      [capacityAcknowledgement.acknowledgementId, randomUUID(), randomUUID()],
    ),
    /current incident snapshot/i,
  );
  await assert.rejects(
    corePool.query(
      `INSERT INTO refund_receipt_capacity_incidents(
         source_fund_receipt_id, receipt_sequence, triggering_correction_id,
         confirmed_compensation_minor, receipt_amount_minor, overage_minor,
         currency, reason
       ) VALUES ($1, 4, $2, $3, $4, $5, 'USD',
         'Synthetic non-monotonic receipt sequence must be rejected')`,
      [
        callbackFirstCandidate.receiptId,
        callbackFirstCorrectionResult.correctionId,
        laterUnexpectedIncident.confirmedCompensationMinor,
        laterUnexpectedIncident.receiptAmountMinor,
        laterUnexpectedIncident.overageMinor,
      ],
    ),
    /current confirmed overage/i,
  );
  const wrongCurrencyExternalId =
    `mock-refund-callback-first-wrong-currency:${callbackFirstWinningRefund.refundId}`;
  const callbackFirstWrongCurrencySuccess = await submitRefundFact({
    eventId: `refund-callback-first-wrong-currency:${randomUUID()}`,
    providerOperationId: callbackFirstWinningRefund.providerOperationId,
    refundId: callbackFirstWinningRefund.refundId,
    externalRefundId: wrongCurrencyExternalId,
    status: "succeeded",
    amountMinor: "9",
    currency: "EUR",
    occurredAt: new Date(callbackFirstBaseTime + 4_000).toISOString(),
  });
  assert.equal(callbackFirstWrongCurrencySuccess.status, 202);
  assert.equal(callbackFirstWrongCurrencySuccess.body.securityHold, true);
  const callbackFirstWrongCurrencyHolds = await request<{ items: RefundSecurityHold[] }>(
    "/api/v1/admin/refund-security-holds",
  );
  const callbackFirstWrongCurrencyHold = callbackFirstWrongCurrencyHolds.items.find(
    (hold) =>
      hold.refundId === callbackFirstWinningRefund.refundId &&
      hold.providerFact.externalRefundId === wrongCurrencyExternalId,
  );
  assert.ok(callbackFirstWrongCurrencyHold);
  const callbackFirstWrongCurrencyDismissal = await adjudicateRefundHold(
    callbackFirstWrongCurrencyHold,
    "dismiss_provider_claim",
    "Synthetic administrator initially dismisses the wrong-currency Provider outflow",
  );
  const callbackFirstWrongCurrencyCorrectable = await request<{
    items: RefundDismissalCorrection[];
  }>("/api/v1/admin/refund-dismissal-corrections");
  const callbackFirstWrongCurrencyCorrection =
    callbackFirstWrongCurrencyCorrectable.items.find(
      (item) => item.adjudicationId === callbackFirstWrongCurrencyDismissal.adjudicationId,
    );
  assert.ok(callbackFirstWrongCurrencyCorrection);
  await request(
    "/api/v1/auth/reauth",
    { method: "POST", body: JSON.stringify({ password }) },
    200,
  );
  const callbackFirstWrongCurrencyCorrectionResult = await request<{
    correctionId: string;
    status: string;
  }>(
    `/api/v1/admin/refund-adjudications/${callbackFirstWrongCurrencyCorrection.adjudicationId}/corrections`,
    {
      method: "POST",
      body: JSON.stringify({
        reason:
          "Synthetic later evidence confirms EUR cash without consuming the USD receipt capacity",
        idempotencyKey: randomUUID(),
        expectedRefundVersion: callbackFirstWrongCurrencyCorrection.refundVersion,
      }),
    },
    201,
  );
  assert.equal(
    callbackFirstWrongCurrencyCorrectionResult.status,
    "dismissed_outflow_confirmed",
  );
  const incidentsAfterWrongCurrencyCorrection = await request<{
    items: RefundReceiptCapacityIncident[];
  }>("/api/v1/admin/refund-receipt-capacity-incidents");
  const callbackReceiptIncidentsAfterWrongCurrency =
    incidentsAfterWrongCurrencyCorrection.items.filter(
      (incident) => incident.receiptId === callbackFirstCandidate.receiptId,
    );
  assert.equal(callbackReceiptIncidentsAfterWrongCurrency.length, 2);
  assert.equal(
    callbackReceiptIncidentsAfterWrongCurrency.find(
      (incident) => incident.isCurrentSnapshot,
    )?.incidentId,
    laterUnexpectedIncident.incidentId,
  );
  const wrongCurrencyCorrectionAccounting = await corePool.query<{
    discrepancy_currency: string;
    cash_credit: string;
  }>(
    `SELECT discrepancy.currency AS discrepancy_currency,
            sum(line.credit_minor) FILTER (
              WHERE line.account_code = 'mock_cash'
            )::text AS cash_credit
     FROM refund_adjudication_corrections correction
     JOIN refund_discrepancy_settlements discrepancy
       ON discrepancy.id = correction.discrepancy_settlement_id
     JOIN ledger_journals journal
       ON journal.source_type = 'refund_adjudication_correction'
      AND journal.source_id = correction.id
     JOIN ledger_lines line ON line.journal_id = journal.id
     WHERE correction.id = $1
     GROUP BY discrepancy.currency`,
    [callbackFirstWrongCurrencyCorrectionResult.correctionId],
  );
  assert.equal(wrongCurrencyCorrectionAccounting.rows[0]?.discrepancy_currency, "EUR");
  assert.equal(wrongCurrencyCorrectionAccounting.rows[0]?.cash_credit, "9");
  await assert.rejects(
    corePool.query(
      `INSERT INTO refund_receipt_capacity_incidents(
         source_fund_receipt_id, receipt_sequence, triggering_correction_id,
         confirmed_compensation_minor, receipt_amount_minor, overage_minor,
         currency, reason
       ) VALUES ($1, 3, $2, $3, $4, $5, 'USD',
         'Synthetic EUR correction must not forge a USD receipt overage')`,
      [
        callbackFirstCandidate.receiptId,
        callbackFirstWrongCurrencyCorrectionResult.correctionId,
        laterUnexpectedIncident.confirmedCompensationMinor,
        laterUnexpectedIncident.receiptAmountMinor,
        laterUnexpectedIncident.overageMinor,
      ],
    ),
    /must match its correction and receipt/i,
  );
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
  occurredAt: new Date(Date.now() + 20_000).toISOString(),
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

type UnclaimedRefundWorkItem = {
  receiptId: string;
  clientAccountId: string;
  externalPaymentId: string;
  amountMinor: string;
  allocatedMinor: string;
  reservedRefundMinor: string;
  confirmedOutflowMinor: string;
  availableMinor: string;
  capacityFrozen: boolean;
};

async function readUnclaimedRefundWork(): Promise<UnclaimedRefundWorkItem[]> {
  return (
    await request<{ items: UnclaimedRefundWorkItem[] }>("/api/v1/admin/funds/unclaimed")
  ).items;
}

async function requestUnclaimedRefund(
  item: UnclaimedRefundWorkItem,
  input: {
    amountMode: "full" | "partial";
    amountMinor: string | null;
    scenario: "success" | "failed" | "timeout_success" | "duplicate_out_of_order";
    reason: string;
    idempotencyKey?: string;
  },
  expectedStatus = 202,
): Promise<RefundRecord> {
  return request<RefundRecord>(
    `/api/v1/admin/funds/${item.receiptId}/refunds`,
    {
      method: "POST",
      body: JSON.stringify({
        ...input,
        expectedAvailableMinor: item.availableMinor,
        idempotencyKey: input.idempotencyKey ?? randomUUID(),
      }),
    },
    expectedStatus,
  );
}

async function waitForRefundStatus(
  refundId: string,
  label: string,
  predicate: (refund: RefundRecord) => boolean,
): Promise<RefundRecord> {
  return waitFor(
    label,
    () => request<RefundRecord>(`/api/v1/admin/refunds/${refundId}`),
    predicate,
    40_000,
  );
}

await corePool.query(
  "UPDATE reauth_grants SET invalidated_at = now() WHERE invalidated_at IS NULL",
);
const preReauthWork = await readUnclaimedRefundWork();
const providerBackedExternalIds = await providerPool.query<{
  external_payment_id: string;
  remaining_minor: string;
}>(
  `SELECT
     payment.external_payment_id,
     (
       payment.amount_minor
       - COALESCE((
           SELECT sum(refund.amount_minor)
           FROM mock_refund_operations refund
           WHERE refund.original_external_payment_id = payment.external_payment_id
             AND refund.status IN ('succeeded', 'unknown')
         ), 0)
     )::text AS remaining_minor
   FROM mock_payment_operations payment
   WHERE payment.external_payment_id = ANY($1::text[])
     AND payment.status = 'succeeded'`,
  [preReauthWork.map((item) => item.externalPaymentId)],
);
const providerRemaining = new Map(
  providerBackedExternalIds.rows.map((row) => [row.external_payment_id, BigInt(row.remaining_minor)]),
);
const primaryUnclaimed = preReauthWork.find(
  (item) =>
    item.clientAccountId === recoveryMe.clientAccountId &&
    !item.capacityFrozen &&
    BigInt(item.availableMinor) >= 40n &&
    (providerRemaining.get(item.externalPaymentId) ?? 0n) >= BigInt(item.availableMinor),
);
assert.ok(primaryUnclaimed, "integration needs one Provider-backed unclaimed receipt");

const missingReauth = await rawCoreRequest(
  `/api/v1/admin/funds/${primaryUnclaimed.receiptId}/refunds`,
  {
    method: "POST",
    body: JSON.stringify({
      amountMode: "partial",
      amountMinor: "1",
      expectedAvailableMinor: primaryUnclaimed.availableMinor,
      scenario: "success",
      reason: "Synthetic funds return without a current password confirmation",
      idempotencyKey: randomUUID(),
    }),
  },
);
assert.equal(missingReauth.status, 403);
await request(
  "/api/v1/auth/reauth",
  { method: "POST", body: JSON.stringify({ password }) },
  200,
);

const permissionProbeBody = {
  amountMode: "partial",
  amountMinor: "1",
  expectedAvailableMinor: primaryUnclaimed.availableMinor,
  scenario: "success",
  reason: "Synthetic split-permission probe must not create a Provider refund",
};
const refundsBeforePermissionProbes = await corePool.query<{ count: string }>(
  `SELECT count(*)::text AS count
   FROM refunds
   WHERE source_context = 'unclaimed_funds'
     AND source_fund_receipt_id = $1`,
  [primaryUnclaimed.receiptId],
);
await corePool.query(
  `UPDATE staff_members
   SET permissions = $2::jsonb, updated_at = now()
   WHERE user_id = $1`,
  [staffMe.id, JSON.stringify(["billing.unclaimed_manage"])],
);
await request(
  "/api/v1/auth/reauth",
  { method: "POST", body: JSON.stringify({ password }) },
  200,
);
const missingRefundManage = await rawCoreRequest(
  `/api/v1/admin/funds/${primaryUnclaimed.receiptId}/refunds`,
  {
    method: "POST",
    body: JSON.stringify({ ...permissionProbeBody, idempotencyKey: randomUUID() }),
  },
);
assert.equal(missingRefundManage.status, 403);
await corePool.query(
  `UPDATE staff_members
   SET permissions = $2::jsonb, updated_at = now()
   WHERE user_id = $1`,
  [staffMe.id, JSON.stringify(["billing.refund_manage"])],
);
await request(
  "/api/v1/auth/reauth",
  { method: "POST", body: JSON.stringify({ password }) },
  200,
);
const missingUnclaimedManage = await rawCoreRequest(
  `/api/v1/admin/funds/${primaryUnclaimed.receiptId}/refunds`,
  {
    method: "POST",
    body: JSON.stringify({ ...permissionProbeBody, idempotencyKey: randomUUID() }),
  },
);
assert.equal(missingUnclaimedManage.status, 403);
const refundsAfterPermissionProbes = await corePool.query<{ count: string }>(
  `SELECT count(*)::text AS count
   FROM refunds
   WHERE source_context = 'unclaimed_funds'
     AND source_fund_receipt_id = $1`,
  [primaryUnclaimed.receiptId],
);
assert.equal(
  refundsAfterPermissionProbes.rows[0]?.count,
  refundsBeforePermissionProbes.rows[0]?.count,
);
await corePool.query(
  `UPDATE staff_members
   SET permissions = '["*"]'::jsonb, updated_at = now()
   WHERE user_id = $1`,
  [staffMe.id],
);
await request(
  "/api/v1/auth/reauth",
  { method: "POST", body: JSON.stringify({ password }) },
  200,
);

const workerPermissionWork = preReauthWork.find(
  (item) =>
    item.receiptId !== primaryUnclaimed.receiptId &&
    item.clientAccountId === recoveryMe.clientAccountId &&
    !item.capacityFrozen &&
    BigInt(item.availableMinor) > 1n &&
    (providerRemaining.get(item.externalPaymentId) ?? 0n) >= BigInt(item.availableMinor),
);
assert.ok(
  workerPermissionWork,
  "integration needs an independent unclaimed receipt for Worker permission revocation",
);
await installRefundStartDelay();
let revokedWorkerRefund: RefundRecord | undefined;
try {
  revokedWorkerRefund = await requestUnclaimedRefund(workerPermissionWork, {
    amountMode: "partial",
    amountMinor: "1",
    scenario: "success",
    reason: "Synthetic queued return loses unclaimed permission before Provider create",
  });
  assert.ok(revokedWorkerRefund.providerOperationId);
  const queuedBeforePermissionRevocation = await corePool.query<{
    refund_status: string;
    operation_status: string;
    attempt_count: number;
    job_status: string;
  }>(
    `SELECT refund.status AS refund_status,
            operation.status AS operation_status,
            operation.attempt_count,
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
    [revokedWorkerRefund.refundId],
  );
  assert.deepEqual(queuedBeforePermissionRevocation.rows[0], {
    refund_status: "queued",
    operation_status: "queued",
    attempt_count: 0,
    job_status: "pending",
  });
  await corePool.query(
    `UPDATE staff_members
     SET permissions = $2::jsonb, updated_at = now()
     WHERE user_id = $1`,
    [staffMe.id, JSON.stringify(["billing.refund_manage"])],
  );
  await request(
    "/api/v1/auth/reauth",
    { method: "POST", body: JSON.stringify({ password }) },
    200,
  );
  await corePool.query(
    `UPDATE durable_jobs
     SET available_at = now(), updated_at = now()
     WHERE job_type = 'refund.start'
       AND payload->>'refundId' = $1
       AND status = 'pending'`,
    [revokedWorkerRefund.refundId],
  );
  const revokedBeforeCreate = await waitFor(
    "queued unclaimed return to fail after unclaimed permission revocation",
    async () => {
      const state = await corePool.query<{
        refund_status: string;
        operation_status: string;
        attempt_count: number;
        job_status: string;
        known_unsent_audits: string;
      }>(
        `SELECT refund.status AS refund_status,
                operation.status AS operation_status,
                operation.attempt_count,
                job.status AS job_status,
                (SELECT count(*)::text
                   FROM audit_events audit
                  WHERE audit.action = 'refund.known_unsent_rejected'
                    AND audit.target_type = 'refund'
                    AND audit.target_id = refund.id::text) AS known_unsent_audits
         FROM refunds refund
         JOIN provider_operations operation
           ON operation.subject_type = 'refund'
          AND operation.subject_id = refund.id
          AND operation.kind = 'refund_create'
         JOIN durable_jobs job
           ON job.job_type = 'refund.start'
          AND job.payload->>'refundId' = refund.id::text
         WHERE refund.id = $1`,
        [revokedWorkerRefund!.refundId],
      );
      return state.rows[0];
    },
    (state) =>
      state?.refund_status === "failed" &&
      state.operation_status === "failed" &&
      state.job_status === "completed",
    15_000,
  );
  assert.ok(revokedBeforeCreate);
  assert.equal(revokedBeforeCreate.attempt_count, 0);
  assert.equal(revokedBeforeCreate.known_unsent_audits, "1");
  const revokedProviderCreates = await providerPool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM mock_refund_operations
     WHERE refund_id = $1`,
    [revokedWorkerRefund.refundId],
  );
  assert.equal(revokedProviderCreates.rows[0]?.count, "0");
} finally {
  await corePool.query(
    `UPDATE staff_members
     SET permissions = '["*"]'::jsonb, updated_at = now()
     WHERE user_id = $1`,
    [staffMe.id],
  );
  await dropRefundStartDelay();
}
await request(
  "/api/v1/auth/reauth",
  { method: "POST", body: JSON.stringify({ password }) },
  200,
);
const afterWorkerPermissionRevocation = (await readUnclaimedRefundWork()).find(
  (item) => item.receiptId === workerPermissionWork.receiptId,
);
assert.ok(afterWorkerPermissionRevocation);
assert.equal(afterWorkerPermissionRevocation.availableMinor, workerPermissionWork.availableMinor);
assert.equal(afterWorkerPermissionRevocation.reservedRefundMinor, "0");
assert.equal(afterWorkerPermissionRevocation.capacityFrozen, false);

const failedUnclaimedRefund = await requestUnclaimedRefund(primaryUnclaimed, {
  amountMode: "partial",
  amountMinor: "2",
  scenario: "failed",
  reason: "Synthetic Provider definitively rejects this unclaimed funds return",
});
assert.equal(failedUnclaimedRefund.sourceContext, "unclaimed_funds");
assert.equal(failedUnclaimedRefund.invoiceId, null);
await waitForRefundStatus(
  failedUnclaimedRefund.refundId,
  "unclaimed funds Provider failure",
  (refund) => refund.status === "failed",
);
const afterFailedReturn = (await readUnclaimedRefundWork()).find(
  (item) => item.receiptId === primaryUnclaimed.receiptId,
);
assert.ok(afterFailedReturn);
assert.equal(afterFailedReturn.availableMinor, primaryUnclaimed.availableMinor);
assert.equal(afterFailedReturn.reservedRefundMinor, "0");
assert.equal(afterFailedReturn.capacityFrozen, false);

const allocatedLateSuccessWork = preReauthWork.find(
  (item) =>
    item.receiptId !== primaryUnclaimed.receiptId &&
    item.clientAccountId === recoveryMe.clientAccountId &&
    item.allocatedMinor === "0" &&
    item.confirmedOutflowMinor === "0" &&
    item.availableMinor === item.amountMinor &&
    !item.capacityFrozen &&
    (providerRemaining.get(item.externalPaymentId) ?? 0n) >= BigInt(item.availableMinor),
);
assert.ok(
  allocatedLateSuccessWork,
  "integration needs an independent Provider-backed unclaimed receipt for late-success capacity",
);
const allocatedLateFailedRefund = await requestUnclaimedRefund(allocatedLateSuccessWork, {
  amountMode: "full",
  amountMinor: null,
  scenario: "failed",
  reason: "Synthetic full return fails before the same liability is allocated elsewhere",
});
const allocatedLateFailedTerminal = await waitForRefundStatus(
  allocatedLateFailedRefund.refundId,
  "full unclaimed return to fail before allocation",
  (refund) => refund.status === "failed",
);
assert.ok(allocatedLateFailedTerminal.providerOperationId);
const allocatedLateExternalRefundId =
  allocatedLateFailedTerminal.externalRefundId ??
  `mock-refund-${allocatedLateFailedTerminal.providerOperationId}`;

cookie = recoveryCookie;
const allocatedLateInvoice = await createOrder(manualPrice.id, legal);
assert.ok(
  BigInt(allocatedLateInvoice.invoice.dueMinor) >= BigInt(allocatedLateSuccessWork.availableMinor),
  "manual-product invoice must be large enough to consume the independent receipt",
);
cookie = staffCookie;
await request(
  "/api/v1/auth/reauth",
  { method: "POST", body: JSON.stringify({ password }) },
  200,
);
const allocatedLateBeforeResolution = (await readUnclaimedRefundWork()).find(
  (item) => item.receiptId === allocatedLateSuccessWork.receiptId,
);
assert.ok(allocatedLateBeforeResolution);
assert.equal(allocatedLateBeforeResolution.availableMinor, allocatedLateSuccessWork.amountMinor);
const allocatedLateResolution = await request<{
  resolutionId: string;
  remainingMinor: string;
  invoiceStatus: string;
}>(
  `/api/v1/admin/funds/${allocatedLateSuccessWork.receiptId}/resolutions`,
  {
    method: "POST",
    body: JSON.stringify({
      action: "allocate_invoice",
      amountMinor: allocatedLateBeforeResolution.availableMinor,
      invoiceId: allocatedLateInvoice.invoice.id,
      reason: "Synthetic operator allocates every remaining cent after the Provider failure",
      idempotencyKey: randomUUID(),
    }),
  },
  201,
);
assert.equal(allocatedLateResolution.remainingMinor, "0");
const fullyAllocatedLateReceipt = await corePool.query<{
  amount_minor: string;
  allocated_minor: string;
  resolutions: string;
}>(
  `SELECT receipt.amount_minor::text, receipt.allocated_minor::text,
          (SELECT count(*)::text
             FROM fund_receipt_resolutions resolution
            WHERE resolution.fund_receipt_id = receipt.id) AS resolutions
   FROM fund_receipts receipt
   WHERE receipt.id = $1`,
  [allocatedLateSuccessWork.receiptId],
);
assert.equal(
  fullyAllocatedLateReceipt.rows[0]?.allocated_minor,
  fullyAllocatedLateReceipt.rows[0]?.amount_minor,
);
assert.equal(fullyAllocatedLateReceipt.rows[0]?.resolutions, "1");

const allocatedLateBaseTime = Date.now() + 2_000;
const allocatedLateSuccess = await submitRefundFact({
  eventId: `unclaimed-allocated-late-success:${randomUUID()}`,
  providerOperationId: allocatedLateFailedTerminal.providerOperationId,
  refundId: allocatedLateFailedTerminal.refundId,
  externalRefundId: allocatedLateExternalRefundId,
  status: "succeeded",
  amountMinor: allocatedLateSuccessWork.amountMinor,
  currency: "USD",
  occurredAt: new Date(allocatedLateBaseTime).toISOString(),
});
assert.equal(allocatedLateSuccess.status, 202);
assert.equal(allocatedLateSuccess.body.status, "manual");
const allocatedLateHolds = await request<{ items: RefundSecurityHold[] }>(
  "/api/v1/admin/refund-security-holds",
);
const allocatedLateHold = allocatedLateHolds.items.find(
  (hold) =>
    hold.refundId === allocatedLateFailedTerminal.refundId &&
    hold.providerFact.externalRefundId === allocatedLateExternalRefundId,
);
assert.ok(allocatedLateHold);
assert.equal(allocatedLateHold.refundAmountMinor, allocatedLateSuccessWork.amountMinor);
assert.deepEqual(allocatedLateHold.allowedDecisions, [
  "record_unexpected_outflow",
  "dismiss_provider_claim",
]);
const allocatedLateAdjudication = await adjudicateRefundHold(
  allocatedLateHold,
  "record_unexpected_outflow",
  "Synthetic administrator confirms the exact late Provider outflow after full allocation",
);
const allocatedLateIncidents = await request<{
  items: RefundReceiptCapacityIncident[];
}>("/api/v1/admin/refund-receipt-capacity-incidents");
const allocatedLateIncident = allocatedLateIncidents.items.find(
  (incident) =>
    incident.source.type === "unexpected_outflow_adjudication" &&
    incident.source.adjudicationId === allocatedLateAdjudication.adjudicationId,
);
assert.ok(allocatedLateIncident);
assert.equal(allocatedLateIncident.receiptId, allocatedLateSuccessWork.receiptId);
assert.equal(allocatedLateIncident.refundId, allocatedLateFailedTerminal.refundId);
assert.equal(allocatedLateIncident.sourceContext, "unclaimed_funds");
assert.equal(allocatedLateIncident.receiptSequence, "1");
assert.equal(allocatedLateIncident.receiptAllocatedMinor, allocatedLateSuccessWork.amountMinor);
assert.equal(
  allocatedLateIncident.allocatedContributionMinor,
  allocatedLateSuccessWork.amountMinor,
);
assert.equal(
  allocatedLateIncident.confirmedProviderOutflowMinor,
  allocatedLateSuccessWork.amountMinor,
);
assert.equal(
  allocatedLateIncident.confirmedDispositionMinor,
  (BigInt(allocatedLateSuccessWork.amountMinor) * 2n).toString(),
);
assert.equal(allocatedLateIncident.receiptAmountMinor, allocatedLateSuccessWork.amountMinor);
assert.equal(allocatedLateIncident.overageMinor, allocatedLateSuccessWork.amountMinor);
assert.equal(allocatedLateIncident.isCurrentSnapshot, true);
assert.equal(allocatedLateIncident.status, "awaiting_acknowledgement");
const allocatedLateIncidentAccounting = await corePool.query<{
  settlements: string;
  allocation_liability_debit: string;
  allocation_ar_credit: string;
  discrepancy_suspense_debit: string;
  discrepancy_cash_credit: string;
  incidents: string;
  unbalanced: string;
}>(
  `SELECT
     (SELECT count(*)::text FROM refund_settlements WHERE refund_id = $1) AS settlements,
     COALESCE((
       SELECT sum(line.debit_minor)::text
       FROM fund_receipt_resolutions resolution
       JOIN ledger_journals journal
         ON journal.source_type = 'fund_receipt_resolution'
        AND journal.source_id = resolution.id
       JOIN ledger_lines line
         ON line.journal_id = journal.id
        AND line.account_code = 'unclaimed_funds_liability'
       WHERE resolution.fund_receipt_id = $2
     ), '0') AS allocation_liability_debit,
     COALESCE((
       SELECT sum(line.credit_minor)::text
       FROM fund_receipt_resolutions resolution
       JOIN ledger_journals journal
         ON journal.source_type = 'fund_receipt_resolution'
        AND journal.source_id = resolution.id
       JOIN ledger_lines line
         ON line.journal_id = journal.id
        AND line.account_code = 'accounts_receivable'
       WHERE resolution.fund_receipt_id = $2
     ), '0') AS allocation_ar_credit,
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
     ), '0') AS discrepancy_suspense_debit,
     COALESCE((
       SELECT sum(line.credit_minor)::text
       FROM refund_discrepancy_settlements discrepancy
       JOIN ledger_journals journal
         ON journal.source_type = 'refund_provider_discrepancy'
        AND journal.source_id = discrepancy.id
       JOIN ledger_lines line
         ON line.journal_id = journal.id
        AND line.account_code = 'mock_cash'
       WHERE discrepancy.refund_id = $1
     ), '0') AS discrepancy_cash_credit,
     (SELECT count(*)::text
        FROM refund_receipt_capacity_incidents
       WHERE source_fund_receipt_id = $2) AS incidents,
     (SELECT count(*)::text
        FROM (
          SELECT line.journal_id
          FROM ledger_lines line
          JOIN ledger_journals journal ON journal.id = line.journal_id
          WHERE (
            journal.source_type = 'fund_receipt_resolution'
            AND EXISTS (
              SELECT 1 FROM fund_receipt_resolutions resolution
              WHERE resolution.id = journal.source_id
                AND resolution.fund_receipt_id = $2
            )
          ) OR (
            journal.source_type = 'refund_provider_discrepancy'
            AND EXISTS (
              SELECT 1 FROM refund_discrepancy_settlements discrepancy
              WHERE discrepancy.id = journal.source_id AND discrepancy.refund_id = $1
            )
          )
          GROUP BY line.journal_id
          HAVING sum(line.debit_minor) <> sum(line.credit_minor)
        ) imbalance) AS unbalanced`,
  [allocatedLateFailedTerminal.refundId, allocatedLateSuccessWork.receiptId],
);
assert.deepEqual(allocatedLateIncidentAccounting.rows[0], {
  settlements: "0",
  allocation_liability_debit: allocatedLateSuccessWork.amountMinor,
  allocation_ar_credit: allocatedLateSuccessWork.amountMinor,
  discrepancy_suspense_debit: allocatedLateSuccessWork.amountMinor,
  discrepancy_cash_credit: allocatedLateSuccessWork.amountMinor,
  incidents: "1",
  unbalanced: "0",
});
const allocatedLateVisibleAgain = await request<{
  items: RefundReceiptCapacityIncident[];
}>("/api/v1/admin/refund-receipt-capacity-incidents");
assert.ok(
  allocatedLateVisibleAgain.items.some(
    (incident) =>
      incident.incidentId === allocatedLateIncident.incidentId && incident.isCurrentSnapshot,
  ),
);

const correctionExternalRefundId =
  `mock-refund-unclaimed-dismiss-correction:${allocatedLateFailedTerminal.refundId}`;
const correctionLateSuccess = await submitRefundFact({
  eventId: `unclaimed-allocated-dismissed-success:${randomUUID()}`,
  providerOperationId: allocatedLateFailedTerminal.providerOperationId,
  refundId: allocatedLateFailedTerminal.refundId,
  externalRefundId: correctionExternalRefundId,
  status: "succeeded",
  amountMinor: allocatedLateSuccessWork.amountMinor,
  currency: "USD",
  occurredAt: new Date(allocatedLateBaseTime + 1_000).toISOString(),
});
assert.equal(correctionLateSuccess.status, 202);
assert.equal(correctionLateSuccess.body.status, "manual");
const correctionLateHolds = await request<{ items: RefundSecurityHold[] }>(
  "/api/v1/admin/refund-security-holds",
);
const correctionLateHold = correctionLateHolds.items.find(
  (hold) =>
    hold.refundId === allocatedLateFailedTerminal.refundId &&
    hold.providerFact.externalRefundId === correctionExternalRefundId,
);
assert.ok(correctionLateHold);
const correctionDismissal = await adjudicateRefundHold(
  correctionLateHold,
  "dismiss_provider_claim",
  "Synthetic administrator initially dismisses the second exact late outflow",
);
const allocatedLateCorrections = await request<{ items: RefundDismissalCorrection[] }>(
  "/api/v1/admin/refund-dismissal-corrections",
);
const allocatedLateCorrection = allocatedLateCorrections.items.find(
  (item) => item.adjudicationId === correctionDismissal.adjudicationId,
);
assert.ok(allocatedLateCorrection);
await request(
  "/api/v1/auth/reauth",
  { method: "POST", body: JSON.stringify({ password }) },
  200,
);
const allocatedLateCorrectionResult = await request<{
  correctionId: string;
  status: string;
}>(
  `/api/v1/admin/refund-adjudications/${allocatedLateCorrection.adjudicationId}/corrections`,
  {
    method: "POST",
    body: JSON.stringify({
      reason: "Synthetic later evidence confirms the dismissed outflow on the allocated receipt",
      idempotencyKey: randomUUID(),
      expectedRefundVersion: allocatedLateCorrection.refundVersion,
    }),
  },
  201,
);
assert.equal(allocatedLateCorrectionResult.status, "dismissed_outflow_confirmed");
const incidentsAfterAllocatedCorrection = await request<{
  items: RefundReceiptCapacityIncident[];
}>("/api/v1/admin/refund-receipt-capacity-incidents");
const allocatedLateCorrectionIncident = incidentsAfterAllocatedCorrection.items.find(
  (incident) =>
    incident.source.type === "dismissal_correction" &&
    incident.source.correctionId === allocatedLateCorrectionResult.correctionId,
);
assert.ok(allocatedLateCorrectionIncident);
assert.equal(allocatedLateCorrectionIncident.receiptId, allocatedLateSuccessWork.receiptId);
assert.equal(allocatedLateCorrectionIncident.sourceContext, "unclaimed_funds");
assert.equal(allocatedLateCorrectionIncident.receiptSequence, "2");
assert.equal(
  allocatedLateCorrectionIncident.confirmedDispositionMinor,
  (BigInt(allocatedLateSuccessWork.amountMinor) * 3n).toString(),
);
assert.equal(
  allocatedLateCorrectionIncident.confirmedProviderOutflowMinor,
  (BigInt(allocatedLateSuccessWork.amountMinor) * 2n).toString(),
);
assert.equal(
  allocatedLateCorrectionIncident.overageMinor,
  (BigInt(allocatedLateSuccessWork.amountMinor) * 2n).toString(),
);
assert.equal(allocatedLateCorrectionIncident.isCurrentSnapshot, true);
const supersededAllocatedIncident = incidentsAfterAllocatedCorrection.items.find(
  (incident) => incident.incidentId === allocatedLateIncident.incidentId,
);
assert.ok(supersededAllocatedIncident);
assert.equal(supersededAllocatedIncident.isCurrentSnapshot, false);
assert.equal(supersededAllocatedIncident.status, "superseded_history");

const receiptBeforeReturn = await corePool.query<{
  provider_installation_id: string;
  external_payment_id: string;
  amount_minor: string;
  allocated_minor: string;
  currency: string;
  occurred_at: Date;
}>(
  `SELECT provider_installation_id, external_payment_id, amount_minor::text,
          allocated_minor::text, currency, occurred_at
   FROM fund_receipts
   WHERE id = $1`,
  [primaryUnclaimed.receiptId],
);
const successfulUnclaimedRefund = await requestUnclaimedRefund(afterFailedReturn, {
  amountMode: "partial",
  amountMinor: "3",
  scenario: "success",
  reason: "Synthetic operator returns part of an unclaimed receipt to its original payment",
});
const succeededUnclaimedRefund = await waitForRefundStatus(
  successfulUnclaimedRefund.refundId,
  "unclaimed funds Provider success",
  (refund) => refund.status === "succeeded",
);
assert.equal(succeededUnclaimedRefund.sourceContext, "unclaimed_funds");
const successfulReturnAccounting = await corePool.query<{
  settlements: string;
  liability_debit: string;
  cash_credit: string;
  sales_refunds_lines: string;
  debit_total: string;
  credit_total: string;
}>(
  `SELECT
     (SELECT count(*)::text FROM refund_settlements WHERE refund_id = $1) AS settlements,
     COALESCE(sum(line.debit_minor) FILTER (
       WHERE line.account_code = 'unclaimed_funds_liability'
     ), 0)::text AS liability_debit,
     COALESCE(sum(line.credit_minor) FILTER (
       WHERE line.account_code = 'mock_cash'
     ), 0)::text AS cash_credit,
     count(*) FILTER (
       WHERE line.account_code = 'sales_refunds_and_allowances'
     )::text AS sales_refunds_lines,
     COALESCE(sum(line.debit_minor), 0)::text AS debit_total,
     COALESCE(sum(line.credit_minor), 0)::text AS credit_total
   FROM ledger_journals journal
   LEFT JOIN ledger_lines line ON line.journal_id = journal.id
   WHERE journal.source_type = 'refund' AND journal.source_id = $1`,
  [successfulUnclaimedRefund.refundId],
);
assert.deepEqual(successfulReturnAccounting.rows[0], {
  settlements: "1",
  liability_debit: "3",
  cash_credit: "3",
  sales_refunds_lines: "0",
  debit_total: "3",
  credit_total: "3",
});
const receiptAfterReturn = await corePool.query(
  `SELECT provider_installation_id, external_payment_id, amount_minor::text,
          allocated_minor::text, currency, occurred_at
   FROM fund_receipts
   WHERE id = $1`,
  [primaryUnclaimed.receiptId],
);
assert.deepEqual(receiptAfterReturn.rows[0], receiptBeforeReturn.rows[0]);

const beforeTimeoutReturn = (await readUnclaimedRefundWork()).find(
  (item) => item.receiptId === primaryUnclaimed.receiptId,
);
assert.ok(beforeTimeoutReturn);
const timeoutUnclaimedRefund = await requestUnclaimedRefund(beforeTimeoutReturn, {
  amountMode: "partial",
  amountMinor: "4",
  scenario: "timeout_success",
  reason: "Synthetic timeout remains unknown until query reconciliation confirms the outflow",
});
await waitForRefundStatus(
  timeoutUnclaimedRefund.refundId,
  "unclaimed funds timeout to become unknown",
  (refund) => refund.status === "unknown",
);
const frozenDuringUnknown = (await readUnclaimedRefundWork()).find(
  (item) => item.receiptId === primaryUnclaimed.receiptId,
);
assert.ok(frozenDuringUnknown);
assert.equal(frozenDuringUnknown.capacityFrozen, true);
assert.equal(frozenDuringUnknown.availableMinor, "0");
await request(
  `/api/v1/admin/funds/${primaryUnclaimed.receiptId}/resolutions`,
  {
    method: "POST",
    body: JSON.stringify({
      action: "convert_to_credit",
      amountMinor: "1",
      invoiceId: null,
      reason: "Synthetic allocation is blocked while the Provider result remains unknown",
      idempotencyKey: randomUUID(),
    }),
  },
  409,
);
await request(
  `/api/v1/admin/funds/${primaryUnclaimed.receiptId}/refunds`,
  {
    method: "POST",
    body: JSON.stringify({
      amountMode: "partial",
      amountMinor: "1",
      expectedAvailableMinor: "1",
      scenario: "success",
      reason: "Synthetic second return is blocked while the Provider result remains unknown",
      idempotencyKey: randomUUID(),
    }),
  },
  409,
);
await waitForRefundStatus(
  timeoutUnclaimedRefund.refundId,
  "unclaimed funds timeout reconciliation",
  (refund) => refund.status === "succeeded",
);

const beforeDuplicateReturn = (await readUnclaimedRefundWork()).find(
  (item) => item.receiptId === primaryUnclaimed.receiptId,
);
assert.ok(beforeDuplicateReturn);
const duplicateUnclaimedRefund = await requestUnclaimedRefund(beforeDuplicateReturn, {
  amountMode: "partial",
  amountMinor: "5",
  scenario: "duplicate_out_of_order",
  reason: "Synthetic duplicate and older Provider callbacks must not settle the return twice",
});
const duplicateTerminal = await waitForRefundStatus(
  duplicateUnclaimedRefund.refundId,
  "duplicate and out-of-order unclaimed funds callbacks",
  (refund) => refund.status === "succeeded",
);
await new Promise((resolve) => setTimeout(resolve, 200));
const duplicateEffects = await corePool.query<{ settlements: string; journals: string }>(
  `SELECT
     (SELECT count(*)::text FROM refund_settlements WHERE refund_id = $1) AS settlements,
     (SELECT count(*)::text FROM ledger_journals
       WHERE source_type = 'refund' AND source_id = $1) AS journals`,
  [duplicateUnclaimedRefund.refundId],
);
assert.deepEqual(duplicateEffects.rows[0], { settlements: "1", journals: "1" });
const duplicateProviderCalls = await providerPool.query<{ create_calls: number }>(
  "SELECT create_calls FROM mock_refund_operations WHERE operation_id = $1",
  [duplicateTerminal.providerOperationId],
);
assert.equal(duplicateProviderCalls.rows[0]?.create_calls, 1);

const beforeDoubleRequest = (await readUnclaimedRefundWork()).find(
  (item) => item.receiptId === primaryUnclaimed.receiptId,
);
assert.ok(beforeDoubleRequest);
await installRefundStartDelay();
let winningConcurrentRefund: RefundRecord | undefined;
try {
  const concurrentBodies = [randomUUID(), randomUUID()].map((idempotencyKey, index) => ({
    method: "POST",
    body: JSON.stringify({
      amountMode: "partial",
      amountMinor: "7",
      expectedAvailableMinor: beforeDoubleRequest.availableMinor,
      scenario: "success",
      reason: `Synthetic concurrent unclaimed funds return contender ${index + 1}`,
      idempotencyKey,
    }),
  }));
  const concurrentReturns = await Promise.all(
    concurrentBodies.map((body) =>
      rawCoreRequest(`/api/v1/admin/funds/${primaryUnclaimed.receiptId}/refunds`, body),
    ),
  );
  assert.deepEqual(
    concurrentReturns.map((response) => response.status).sort(),
    [202, 409],
  );
  winningConcurrentRefund = concurrentReturns.find((response) => response.status === 202)
    ?.body as RefundRecord | undefined;
  assert.ok(winningConcurrentRefund);
  await corePool.query(
    `UPDATE durable_jobs SET available_at = now()
     WHERE job_type = 'refund.start' AND payload->>'refundId' = $1`,
    [winningConcurrentRefund.refundId],
  );
} finally {
  await dropRefundStartDelay();
}
await waitForRefundStatus(
  winningConcurrentRefund!.refundId,
  "winning concurrent unclaimed funds return",
  (refund) => refund.status === "succeeded",
);
const concurrentReservationEffects = await corePool.query<{ refunds: string; settlements: string }>(
  `SELECT
     (SELECT count(*)::text FROM refunds
       WHERE source_context = 'unclaimed_funds'
         AND source_fund_receipt_id = $1
         AND amount_minor = 7) AS refunds,
     (SELECT count(*)::text
        FROM refund_settlements settlement
        JOIN refunds refund ON refund.id = settlement.refund_id
       WHERE refund.source_context = 'unclaimed_funds'
         AND refund.source_fund_receipt_id = $1
         AND refund.amount_minor = 7) AS settlements`,
  [primaryUnclaimed.receiptId],
);
assert.deepEqual(concurrentReservationEffects.rows[0], { refunds: "1", settlements: "1" });

const raceWork = (await readUnclaimedRefundWork()).find(
  (item) =>
    item.receiptId !== primaryUnclaimed.receiptId &&
    item.clientAccountId === recoveryMe.clientAccountId &&
    !item.capacityFrozen &&
    BigInt(item.availableMinor) > 0n &&
    (providerRemaining.get(item.externalPaymentId) ?? 0n) >= BigInt(item.availableMinor),
);
assert.ok(raceWork, "integration needs a second Provider-backed receipt for allocation race");
cookie = recoveryCookie;
const allocationRaceOrder = await createOrder(automaticPrice.id, legal);
cookie = staffCookie;
const allocationRaceAmount = (
  BigInt(raceWork.availableMinor) < BigInt(allocationRaceOrder.invoice.dueMinor)
    ? BigInt(raceWork.availableMinor)
    : BigInt(allocationRaceOrder.invoice.dueMinor)
).toString();
assert.ok(BigInt(allocationRaceAmount) > 0n);
await request(
  "/api/v1/auth/reauth",
  { method: "POST", body: JSON.stringify({ password }) },
  200,
);
await installRefundStartDelay();
let raceRefund: RefundRecord | undefined;
try {
  const returnRequest = rawCoreRequest(`/api/v1/admin/funds/${raceWork.receiptId}/refunds`, {
    method: "POST",
    body: JSON.stringify({
      amountMode: "full",
      amountMinor: null,
      expectedAvailableMinor: raceWork.availableMinor,
      scenario: "success",
      reason: "Synthetic full return races an invoice allocation against one receipt capacity",
      idempotencyKey: randomUUID(),
    }),
  });
  const allocationRequest = rawCoreRequest(
    `/api/v1/admin/funds/${raceWork.receiptId}/resolutions`,
    {
      method: "POST",
      body: JSON.stringify({
        action: "allocate_invoice",
        amountMinor: allocationRaceAmount,
        invoiceId: allocationRaceOrder.invoice.id,
        reason: "Synthetic invoice allocation races a full original-payment return",
        idempotencyKey: randomUUID(),
      }),
    },
  );
  const capacityRace = await Promise.all([returnRequest, allocationRequest]);
  const successfulRace = capacityRace.filter((response) => [201, 202].includes(response.status));
  assert.equal(successfulRace.length, 1);
  assert.equal(capacityRace.filter((response) => response.status === 409).length, 1);
  const returnWinner = capacityRace.find((response) => response.status === 202);
  if (returnWinner) {
    raceRefund = returnWinner.body as RefundRecord;
    await corePool.query(
      `UPDATE durable_jobs SET available_at = now()
       WHERE job_type = 'refund.start' AND payload->>'refundId' = $1`,
      [raceRefund.refundId],
    );
  }
} finally {
  await dropRefundStartDelay();
}
if (raceRefund) {
  await waitForRefundStatus(
    raceRefund.refundId,
    "return winner in allocation race",
    (refund) => refund.status === "succeeded",
  );
}
const raceCapacity = await corePool.query<{
  allocated_minor: string;
  confirmed_outflow_minor: string;
  amount_minor: string;
}>(
  `SELECT receipt.allocated_minor::text,
          capacity.confirmed_outflow_minor::text,
          receipt.amount_minor::text
   FROM fund_receipts receipt
   JOIN unclaimed_fund_refund_capacity capacity ON capacity.fund_receipt_id = receipt.id
   WHERE receipt.id = $1`,
  [raceWork.receiptId],
);
assert.ok(raceCapacity.rows[0]);
assert.ok(
  BigInt(raceCapacity.rows[0]!.allocated_minor) +
      BigInt(raceCapacity.rows[0]!.confirmed_outflow_minor) <=
    BigInt(raceCapacity.rows[0]!.amount_minor),
);
await corePool.query(
  `UPDATE fund_receipts
   SET reason = 'Synthetic browser return-ready unclaimed receipt', updated_at = now()
   WHERE id = $1`,
  [primaryUnclaimed.receiptId],
);

cookie = "";
const pendingChargebackEmail = `pending-chargeback-${randomUUID()}@example.invalid`;
await request(
  "/api/v1/auth/register",
  {
    method: "POST",
    body: JSON.stringify({
      email: pendingChargebackEmail,
      password,
      clientName: "Synthetic Pending Chargeback Client",
      locale: "en",
    }),
  },
  201,
);
await corePool.query("UPDATE users SET email_verified_at = now() WHERE email = $1", [
  pendingChargebackEmail,
]);
await request(
  "/api/v1/auth/login",
  { method: "POST", body: JSON.stringify({ email: pendingChargebackEmail, password }) },
  200,
);
await corePool.query(`
  CREATE OR REPLACE FUNCTION integration_delay_pending_chargeback_add_funds()
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
  DROP TRIGGER IF EXISTS integration_delay_pending_chargeback_add_funds ON durable_jobs;
  CREATE TRIGGER integration_delay_pending_chargeback_add_funds
  BEFORE INSERT ON durable_jobs
  FOR EACH ROW EXECUTE FUNCTION integration_delay_pending_chargeback_add_funds();
`);
let pendingChargebackAddFunds: {
  command: AddFundsCommand;
  idempotencyKey: string;
} | null = null;
let terminalChargebackAddFunds: {
  command: AddFundsCommand;
  idempotencyKey: string;
} | null = null;
let manualChargebackAddFunds: {
  command: AddFundsCommand;
  idempotencyKey: string;
} | null = null;
let unclaimedPendingChargebackAddFunds: {
  command: AddFundsCommand;
  idempotencyKey: string;
} | null = null;
try {
  const pendingQuote = await createAddFundsQuote("5000", "card");
  pendingChargebackAddFunds = await startAddFunds(pendingQuote.quoteId, "success");
  const unclaimedPendingQuote = await createAddFundsQuote("5000", "card");
  unclaimedPendingChargebackAddFunds = await startAddFunds(
    unclaimedPendingQuote.quoteId,
    "success",
  );
} finally {
  await corePool.query(`
    DROP TRIGGER IF EXISTS integration_delay_pending_chargeback_add_funds ON durable_jobs;
    DROP FUNCTION IF EXISTS integration_delay_pending_chargeback_add_funds();
  `);
}
const terminalQuote = await createAddFundsQuote("5000", "card");
terminalChargebackAddFunds = await startAddFunds(
  terminalQuote.quoteId,
  "delayed_definitive_reject",
);
assert.ok(pendingChargebackAddFunds);
assert.ok(terminalChargebackAddFunds);
assert.ok(unclaimedPendingChargebackAddFunds);
const pendingChargebackOperation = await corePool.query<{ id: string }>(
  `UPDATE provider_operations
   SET status = 'running', attempt_count = 1, updated_at = now()
   WHERE subject_type = 'add_funds'
     AND subject_id = $1
     AND kind = 'payment_create'
   RETURNING id`,
  [pendingChargebackAddFunds.command.addFundsAttemptId],
);
const pendingChargebackOperationId = pendingChargebackOperation.rows[0]?.id;
assert.ok(pendingChargebackOperationId);
const pendingOriginalPaymentId = `mock-pay-pending-${randomUUID()}`;
const pendingPaymentOccurredAt = new Date();
const pendingChargebackOccurredAt = new Date(pendingPaymentOccurredAt.getTime() + 1_000);
const pendingChargebackFact = await submitAddFundsChargebackFact({
  eventId: `chargeback-pending-source:${randomUUID()}`,
  providerOperationId: pendingChargebackOperationId,
  addFundsAttemptId: pendingChargebackAddFunds.command.addFundsAttemptId,
  originalExternalPaymentId: pendingOriginalPaymentId,
  externalChargebackId: `mock-chargeback-pending-${randomUUID()}`,
  amountMinor: "5175",
  currency: "USD",
  occurredAt: pendingChargebackOccurredAt.toISOString(),
});
assert.equal(pendingChargebackFact.status, 202);
assert.equal(pendingChargebackFact.body.status, "pending_source");

const terminalChargebackOperation = await corePool.query<{ id: string }>(
  `SELECT id
   FROM provider_operations
   WHERE subject_type = 'add_funds'
     AND subject_id = $1
     AND kind = 'payment_create'`,
  [terminalChargebackAddFunds.command.addFundsAttemptId],
);
const terminalChargebackOperationId = terminalChargebackOperation.rows[0]?.id;
assert.ok(terminalChargebackOperationId);
await waitFor(
  "Mock Provider definitive rejection gate",
  () =>
    providerPool.query<{ operation_id: string }>(
      `SELECT operation_id
       FROM mock_payment_fault_gates
       WHERE operation_id = $1`,
      [terminalChargebackOperationId],
    ),
  (result) => result.rowCount === 1,
  8_000,
);
const terminalStarted = await corePool.query<{ status: string; attempt_count: number }>(
  `SELECT status, attempt_count
   FROM provider_operations
   WHERE id = $1`,
  [terminalChargebackOperationId],
);
assert.deepEqual(terminalStarted.rows[0], { status: "running", attempt_count: 1 });
let terminalPendingFact:
  | { status: number; body: Record<string, unknown> }
  | undefined;
try {
  terminalPendingFact = await submitAddFundsChargebackFact({
    eventId: `chargeback-terminal-pending:${randomUUID()}`,
    providerOperationId: terminalChargebackOperationId,
    addFundsAttemptId: terminalChargebackAddFunds.command.addFundsAttemptId,
    originalExternalPaymentId: `mock-pay-terminal-pending-${randomUUID()}`,
    externalChargebackId: `mock-chargeback-terminal-pending-${randomUUID()}`,
    amountMinor: "5175",
    currency: "USD",
    occurredAt: new Date().toISOString(),
  });
} finally {
  await providerPool.query(
    `UPDATE mock_payment_fault_gates
     SET released_at = now()
     WHERE operation_id = $1 AND released_at IS NULL`,
    [terminalChargebackOperationId],
  );
}
assert.ok(terminalPendingFact);
assert.equal(terminalPendingFact.status, 202);
assert.equal(terminalPendingFact.body.status, "pending_source");
const terminalPendingDisposition = await waitFor(
  "Worker definitive rejection to hold the pending Chargeback",
  () => corePool.query<{
  attempt_status: string;
  operation_status: string;
  job_status: string;
  facts: string;
  holds: string;
}>(
  `SELECT
     attempt.status AS attempt_status,
     operation.status AS operation_status,
     job.status AS job_status,
     (SELECT count(*)::text FROM add_funds_chargeback_facts fact
       WHERE fact.add_funds_attempt_id = attempt.id) AS facts,
     (SELECT count(*)::text
        FROM add_funds_chargeback_holds hold_record
        JOIN add_funds_chargeback_facts fact ON fact.id = hold_record.fact_id
       WHERE fact.add_funds_attempt_id = attempt.id) AS holds
   FROM add_funds_attempts attempt
   JOIN provider_operations operation
     ON operation.subject_type = 'add_funds'
    AND operation.subject_id = attempt.id
    AND operation.kind = 'payment_create'
   JOIN durable_jobs job
     ON job.job_type = 'add_funds.start'
    AND job.payload->>'addFundsAttemptId' = attempt.id::text
  WHERE attempt.id = $1`,
  [terminalChargebackAddFunds.command.addFundsAttemptId],
  ),
  (result) =>
    result.rows[0]?.attempt_status === "failed" &&
    result.rows[0]?.operation_status === "failed" &&
    result.rows[0]?.job_status === "completed" &&
    result.rows[0]?.holds === "1",
  8_000,
);
await providerPool.query("DELETE FROM mock_payment_fault_gates WHERE operation_id = $1", [
  terminalChargebackOperationId,
]);
assert.deepEqual(terminalPendingDisposition.rows[0], {
  attempt_status: "failed",
  operation_status: "failed",
  job_status: "completed",
  facts: "1",
  holds: "1",
});

await corePool.query(`
  CREATE OR REPLACE FUNCTION integration_delay_chargeback_reconcile_job()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.job_type = 'add_funds.reconcile' THEN
      NEW.available_at = now() + interval '1 hour';
    END IF;
    RETURN NEW;
  END;
  $$;
  DROP TRIGGER IF EXISTS integration_delay_chargeback_reconcile_job ON durable_jobs;
  CREATE TRIGGER integration_delay_chargeback_reconcile_job
  BEFORE INSERT ON durable_jobs
  FOR EACH ROW EXECUTE FUNCTION integration_delay_chargeback_reconcile_job();
`);
try {
  const manualQuote = await createAddFundsQuote("5000", "card");
  const manualStarted = await startAddFunds(manualQuote.quoteId, "reconcile_manual");
  manualChargebackAddFunds = manualStarted;
  await waitFor(
    "ambiguous Add Funds create to queue a delayed reconciliation",
    () =>
      corePool.query<{ attempt_status: string; job_status: string }>(
        `SELECT attempt.status AS attempt_status, job.status AS job_status
         FROM add_funds_attempts attempt
         JOIN durable_jobs job
           ON job.job_type = 'add_funds.reconcile'
          AND job.payload->>'addFundsAttemptId' = attempt.id::text
         WHERE attempt.id = $1`,
        [manualStarted.command.addFundsAttemptId],
      ),
    (result) =>
      result.rows[0]?.attempt_status === "unknown" &&
      result.rows[0]?.job_status === "pending",
    8_000,
  );
} finally {
  await corePool.query(`
    DROP TRIGGER IF EXISTS integration_delay_chargeback_reconcile_job ON durable_jobs;
    DROP FUNCTION IF EXISTS integration_delay_chargeback_reconcile_job();
  `);
}
assert.ok(manualChargebackAddFunds);

const manualChargebackOperation = await corePool.query<{ id: string }>(
  `SELECT id
   FROM provider_operations
   WHERE subject_type = 'add_funds'
     AND subject_id = $1
     AND kind = 'payment_create'
     AND status = 'unknown'
     AND attempt_count = 1`,
  [manualChargebackAddFunds.command.addFundsAttemptId],
);
const manualChargebackOperationId = manualChargebackOperation.rows[0]?.id;
assert.ok(manualChargebackOperationId);
const manualPendingPaymentId = `mock-pay-manual-pending-${randomUUID()}`;
const manualPendingPaymentAt = new Date();
const manualPendingFact = await submitAddFundsChargebackFact({
  eventId: `chargeback-manual-pending:${randomUUID()}`,
  providerOperationId: manualChargebackOperationId,
  addFundsAttemptId: manualChargebackAddFunds.command.addFundsAttemptId,
  originalExternalPaymentId: manualPendingPaymentId,
  externalChargebackId: `mock-chargeback-manual-pending-${randomUUID()}`,
  amountMinor: "5175",
  currency: "USD",
  occurredAt: new Date(manualPendingPaymentAt.getTime() + 1_000).toISOString(),
});
assert.equal(manualPendingFact.status, 202);
assert.equal(manualPendingFact.body.status, "pending_source");
await corePool.query(
  `UPDATE durable_jobs
   SET available_at = now(), updated_at = now()
   WHERE job_type = 'add_funds.reconcile'
     AND payload->>'addFundsAttemptId' = $1
     AND status = 'pending'`,
  [manualChargebackAddFunds.command.addFundsAttemptId],
);
const manualPendingDisposition = await waitFor(
  "Worker reconciliation exhaustion to hold the pending Chargeback",
  () => corePool.query<{
  attempt_status: string;
  command_status: string;
  job_status: string;
  facts: string;
  holds: string;
}>(
  `SELECT
     attempt.status AS attempt_status,
     command.status AS command_status,
     job.status AS job_status,
     (SELECT count(*)::text FROM add_funds_chargeback_facts fact
       WHERE fact.add_funds_attempt_id = attempt.id) AS facts,
     (SELECT count(*)::text
        FROM add_funds_chargeback_holds hold_record
        JOIN add_funds_chargeback_facts fact ON fact.id = hold_record.fact_id
       WHERE fact.add_funds_attempt_id = attempt.id) AS holds
   FROM add_funds_attempts attempt
   JOIN add_funds_commands command ON command.add_funds_attempt_id = attempt.id
   JOIN durable_jobs job
     ON job.job_type = 'add_funds.reconcile'
    AND job.payload->>'addFundsAttemptId' = attempt.id::text
   WHERE attempt.id = $1`,
  [manualChargebackAddFunds.command.addFundsAttemptId],
  ),
  (result) =>
    result.rows[0]?.attempt_status === "unknown" &&
    result.rows[0]?.command_status === "manual" &&
    result.rows[0]?.job_status === "manual" &&
    result.rows[0]?.holds === "1",
  8_000,
);
assert.deepEqual(manualPendingDisposition.rows[0], {
  attempt_status: "unknown",
  command_status: "manual",
  job_status: "manual",
  facts: "1",
  holds: "1",
});

const customerHoldsBeforeLateManual = await request<ChargebackStatus>(
  "/api/v1/billing/chargeback-status",
);
const lateManualQuote = await createAddFundsQuote("5000", "card");
const lateManualStarted = await startAddFunds(lateManualQuote.quoteId, "reconcile_manual");
const lateManualState = await waitForAddFunds(lateManualStarted.command.commandId, "manual");
assert.equal(lateManualState.attemptStatus, "unknown");
assert.equal(lateManualState.providerOperationStatus, "unknown");
const lateManualExternalPaymentId = `mock-pay-late-after-manual-${randomUUID()}`;
const lateManualExternalChargebackId = `mock-chargeback-late-after-manual-${randomUUID()}`;
const lateAfterManualFact = await submitAddFundsChargebackFact({
  eventId: `chargeback-late-after-manual:${randomUUID()}`,
  providerOperationId: lateManualState.providerOperationId,
  addFundsAttemptId: lateManualState.addFundsAttemptId,
  originalExternalPaymentId: lateManualExternalPaymentId,
  externalChargebackId: lateManualExternalChargebackId,
  amountMinor: "5175",
  currency: "USD",
  occurredAt: new Date().toISOString(),
});
assert.equal(lateAfterManualFact.status, 202);
assert.equal(lateAfterManualFact.body.status, "manual");
assert.match(String(lateAfterManualFact.body.reason), /manual review/i);
const customerHoldsAfterLateManual = await request<ChargebackStatus>(
  "/api/v1/billing/chargeback-status",
);
assert.equal(
  customerHoldsAfterLateManual.manualHolds.length,
  customerHoldsBeforeLateManual.manualHolds.length + 1,
);
assert.equal(
  customerHoldsAfterLateManual.manualHolds.some((hold) => /manual review/i.test(hold.reason)),
  true,
);
cookie = staffCookie;
const adminLateManualChargeback = await request<{
  manualHolds: Array<{ externalChargebackId: string; clientAccountId: string | null }>;
}>("/api/v1/admin/add-funds-chargebacks");
assert.equal(
  adminLateManualChargeback.manualHolds.some(
    (hold) =>
      hold.externalChargebackId === lateManualExternalChargebackId &&
      hold.clientAccountId === customerHoldsAfterLateManual.clientAccountId,
  ),
  true,
);
cookie = "";
await request(
  "/api/v1/auth/login",
  { method: "POST", body: JSON.stringify({ email: pendingChargebackEmail, password }) },
  200,
);

const manualLatePayment = await submitPaymentFact({
  eventId: `add-funds-manual-late:${randomUUID()}`,
  providerOperationId: manualChargebackOperationId,
  paymentAttemptId: manualChargebackAddFunds.command.addFundsAttemptId,
  externalPaymentId: manualPendingPaymentId,
  status: "succeeded",
  amountMinor: "5175",
  currency: "USD",
  occurredAt: manualPendingPaymentAt.toISOString(),
});
assert.equal(manualLatePayment.status, 202);
assert.equal(manualLatePayment.body.status, "unclaimed");
const manualLateReceiptSafety = await corePool.query<{
  effects: string;
  holds: string;
  disposition: string;
  capacity_frozen: boolean;
  available_minor: string;
}>(
  `SELECT
     (SELECT count(*)::text FROM add_funds_unclaimed_chargeback_effects effect
       WHERE effect.fund_receipt_id = receipt.id) AS effects,
     (SELECT count(*)::text
        FROM add_funds_chargeback_holds hold_record
        JOIN add_funds_chargeback_facts fact ON fact.id = hold_record.fact_id
       WHERE fact.add_funds_attempt_id = $2) AS holds,
     receipt.disposition,
     capacity.capacity_frozen,
     capacity.available_minor::text
   FROM fund_receipts receipt
   JOIN unclaimed_fund_refund_capacity capacity
     ON capacity.fund_receipt_id = receipt.id
   WHERE receipt.external_payment_id = $1`,
  [manualPendingPaymentId, manualChargebackAddFunds.command.addFundsAttemptId],
);
assert.deepEqual(manualLateReceiptSafety.rows[0], {
  effects: "0",
  holds: "1",
  disposition: "unclaimed",
  capacity_frozen: true,
  available_minor: "0",
});
const beforePendingSource = await corePool.query<{ facts: string; effects: string }>(
  `SELECT
     (SELECT count(*)::text FROM add_funds_chargeback_facts
       WHERE add_funds_attempt_id = $1) AS facts,
     (SELECT count(*)::text
        FROM add_funds_chargeback_effects effect
        JOIN add_funds_settlements settlement
          ON settlement.id = effect.add_funds_settlement_id
       WHERE settlement.add_funds_attempt_id = $1) AS effects`,
  [pendingChargebackAddFunds.command.addFundsAttemptId],
);
assert.deepEqual(beforePendingSource.rows[0], { facts: "1", effects: "0" });
const pendingSourceSettlement = await submitPaymentFact({
  eventId: `add-funds-pending-source:${randomUUID()}`,
  providerOperationId: pendingChargebackOperationId,
  paymentAttemptId: pendingChargebackAddFunds.command.addFundsAttemptId,
  externalPaymentId: pendingOriginalPaymentId,
  status: "succeeded",
  amountMinor: "5175",
  currency: "USD",
  occurredAt: pendingPaymentOccurredAt.toISOString(),
});
assert.equal(pendingSourceSettlement.status, 202);
assert.equal(pendingSourceSettlement.body.status, "succeeded");
const pendingSourceStatus = await request<ChargebackStatus>(
  "/api/v1/billing/chargeback-status",
);
assert.equal(pendingSourceStatus.restricted, false);
assert.equal(pendingSourceStatus.creditBalanceMinor, "0");
assert.equal(pendingSourceStatus.debtBalanceMinor, "0");
assert.deepEqual(
  pendingSourceStatus.chargebacks.map((chargeback) => ({
    externalAmountMinor: chargeback.externalAmountMinor,
    creditRecoveredMinor: chargeback.creditRecoveredMinor,
    debtMinor: chargeback.debtMinor,
  })),
  [{ externalAmountMinor: "5175", creditRecoveredMinor: "5000", debtMinor: "0" }],
);
await corePool.query(
  `UPDATE durable_jobs
   SET status = 'completed', locked_at = NULL, locked_by = NULL, updated_at = now()
   WHERE job_type = 'add_funds.start'
     AND payload->>'addFundsAttemptId' = $1`,
  [pendingChargebackAddFunds.command.addFundsAttemptId],
);

const secondUnclaimedPaymentId = `mock-pay-second-unclaimed-${randomUUID()}`;
const secondUnclaimedPaymentAt = new Date();
const secondUnclaimedPayment = await submitPaymentFact({
  eventId: `add-funds-second-unclaimed:${randomUUID()}`,
  providerOperationId: pendingChargebackOperationId,
  paymentAttemptId: pendingChargebackAddFunds.command.addFundsAttemptId,
  externalPaymentId: secondUnclaimedPaymentId,
  status: "succeeded",
  amountMinor: "5175",
  currency: "USD",
  occurredAt: secondUnclaimedPaymentAt.toISOString(),
});
assert.equal(secondUnclaimedPayment.status, 202);
assert.equal(secondUnclaimedPayment.body.status, "unclaimed");
const secondUnclaimedChargeback = await submitAddFundsChargebackFact({
  eventId: `chargeback-second-unclaimed:${randomUUID()}`,
  providerOperationId: pendingChargebackOperationId,
  addFundsAttemptId: pendingChargebackAddFunds.command.addFundsAttemptId,
  originalExternalPaymentId: secondUnclaimedPaymentId,
  externalChargebackId: `mock-chargeback-second-unclaimed-${randomUUID()}`,
  amountMinor: "5175",
  currency: "USD",
  occurredAt: new Date(secondUnclaimedPaymentAt.getTime() + 1_000).toISOString(),
});
assert.equal(secondUnclaimedChargeback.status, 202);
assert.equal(secondUnclaimedChargeback.body.status, "succeeded");
const unclaimedChargebackState = await corePool.query<{
  effects: string;
  receipt_disposition: string;
  liability_debit: string;
  cash_credit: string;
  capacity_frozen: boolean;
  available_minor: string;
}>(
  `SELECT
     (SELECT count(*)::text
        FROM add_funds_unclaimed_chargeback_effects effect
       WHERE effect.fund_receipt_id = receipt.id) AS effects,
     receipt.disposition AS receipt_disposition,
     (SELECT COALESCE(sum(line.debit_minor), 0)::text
        FROM ledger_journals journal
        JOIN ledger_lines line ON line.journal_id = journal.id
       WHERE journal.source_type = 'add_funds_unclaimed_chargeback_effect'
         AND journal.source_id IN (
           SELECT id FROM add_funds_unclaimed_chargeback_effects
            WHERE fund_receipt_id = receipt.id
         )
         AND line.account_code = 'unclaimed_funds_liability') AS liability_debit,
     (SELECT COALESCE(sum(line.credit_minor), 0)::text
        FROM ledger_journals journal
        JOIN ledger_lines line ON line.journal_id = journal.id
       WHERE journal.source_type = 'add_funds_unclaimed_chargeback_effect'
         AND journal.source_id IN (
           SELECT id FROM add_funds_unclaimed_chargeback_effects
            WHERE fund_receipt_id = receipt.id
         )
         AND line.account_code = 'mock_cash') AS cash_credit,
     capacity.capacity_frozen,
     capacity.available_minor::text
   FROM fund_receipts receipt
   JOIN unclaimed_fund_refund_capacity capacity
     ON capacity.fund_receipt_id = receipt.id
   WHERE receipt.external_payment_id = $1`,
  [secondUnclaimedPaymentId],
);
assert.deepEqual(unclaimedChargebackState.rows[0], {
  effects: "1",
  receipt_disposition: "charged_back",
  liability_debit: "5175",
  cash_credit: "5175",
  capacity_frozen: true,
  available_minor: "0",
});
const secondUnclaimedCustomerStatus = await request<ChargebackStatus>(
  "/api/v1/billing/chargeback-status",
);
assert.equal(
  secondUnclaimedCustomerStatus.unclaimedChargebacks.some(
    (effect) => effect.externalAmountMinor === "5175",
  ),
  true,
);

const refundFirstPaymentId = `mock-pay-refund-first-${randomUUID()}`;
const refundFirstPaymentAt = new Date();
const refundFirstPayment = await submitPaymentFact({
  eventId: `add-funds-refund-first:${randomUUID()}`,
  providerOperationId: pendingChargebackOperationId,
  paymentAttemptId: pendingChargebackAddFunds.command.addFundsAttemptId,
  externalPaymentId: refundFirstPaymentId,
  status: "succeeded",
  amountMinor: "5175",
  currency: "USD",
  occurredAt: refundFirstPaymentAt.toISOString(),
});
assert.equal(refundFirstPayment.status, 202);
assert.equal(refundFirstPayment.body.status, "unclaimed");
const pendingCustomerCookie = cookie;
cookie = staffCookie;
await request(
  "/api/v1/auth/reauth",
  { method: "POST", body: JSON.stringify({ password }) },
  200,
);
const refundFirstWork = (await readUnclaimedRefundWork()).find(
  (item) => item.externalPaymentId === refundFirstPaymentId,
);
assert.ok(refundFirstWork);
await installRefundStartDelay();
let refundFirst: RefundRecord | null = null;
try {
  refundFirst = await requestUnclaimedRefund(refundFirstWork, {
    amountMode: "full",
    amountMinor: null,
    scenario: "success",
    reason: "Synthetic queued return must stop when a matching Chargeback arrives",
  });
  assert.equal(refundFirst.status, "queued");
  cookie = pendingCustomerCookie;
  const refundFirstChargeback = await submitAddFundsChargebackFact({
    eventId: `chargeback-refund-first:${randomUUID()}`,
    providerOperationId: pendingChargebackOperationId,
    addFundsAttemptId: pendingChargebackAddFunds.command.addFundsAttemptId,
    originalExternalPaymentId: refundFirstPaymentId,
    externalChargebackId: `mock-chargeback-refund-first-${randomUUID()}`,
    amountMinor: "5175",
    currency: "USD",
    occurredAt: new Date(refundFirstPaymentAt.getTime() + 1_000).toISOString(),
  });
  assert.equal(refundFirstChargeback.status, 202);
  assert.equal(refundFirstChargeback.body.status, "manual");
} finally {
  await dropRefundStartDelay();
}
assert.ok(refundFirst);
const refundFirstFreeze = await corePool.query<{
  refund_status: string;
  operation_status: string;
  job_status: string;
  effects: string;
  holds: string;
  capacity_frozen: boolean;
  available_minor: string;
}>(
  `SELECT
     refund.status AS refund_status,
     operation.status AS operation_status,
     job.status AS job_status,
     (SELECT count(*)::text FROM add_funds_unclaimed_chargeback_effects effect
       WHERE effect.fund_receipt_id = refund.source_fund_receipt_id) AS effects,
     (SELECT count(*)::text
        FROM add_funds_chargeback_holds hold_record
        JOIN add_funds_chargeback_facts fact ON fact.id = hold_record.fact_id
       WHERE fact.add_funds_attempt_id = $2
         AND fact.original_external_payment_id = $3) AS holds,
     capacity.capacity_frozen,
     capacity.available_minor::text
   FROM refunds refund
   JOIN provider_operations operation
     ON operation.subject_type = 'refund'
    AND operation.subject_id = refund.id
    AND operation.kind = 'refund_create'
   JOIN durable_jobs job
     ON job.job_type = 'refund.start'
    AND job.payload->>'refundId' = refund.id::text
   JOIN unclaimed_fund_refund_capacity capacity
     ON capacity.fund_receipt_id = refund.source_fund_receipt_id
   WHERE refund.id = $1`,
  [
    refundFirst.refundId,
    pendingChargebackAddFunds.command.addFundsAttemptId,
    refundFirstPaymentId,
  ],
);
assert.deepEqual(refundFirstFreeze.rows[0], {
  refund_status: "failed",
  operation_status: "failed",
  job_status: "completed",
  effects: "0",
  holds: "1",
  capacity_frozen: true,
  available_minor: "0",
});
cookie = pendingCustomerCookie;

const pendingUnclaimedOperation = await corePool.query<{
  id: string;
  client_account_id: string;
}>(
  `UPDATE provider_operations operation
   SET status = 'running', attempt_count = 1, updated_at = now()
   FROM add_funds_attempts attempt
   WHERE operation.subject_type = 'add_funds'
     AND operation.subject_id = $1
     AND operation.kind = 'payment_create'
     AND attempt.id = operation.subject_id
   RETURNING operation.id, attempt.client_account_id`,
  [unclaimedPendingChargebackAddFunds.command.addFundsAttemptId],
);
const pendingUnclaimedOperationRow = pendingUnclaimedOperation.rows[0];
assert.ok(pendingUnclaimedOperationRow);
const pendingUnclaimedPaymentId = `mock-pay-pending-unclaimed-${randomUUID()}`;
const pendingUnclaimedPaymentAt = new Date();
const pendingUnclaimedChargebackFact = await submitAddFundsChargebackFact({
  eventId: `chargeback-pending-unclaimed:${randomUUID()}`,
  providerOperationId: pendingUnclaimedOperationRow.id,
  addFundsAttemptId: unclaimedPendingChargebackAddFunds.command.addFundsAttemptId,
  originalExternalPaymentId: pendingUnclaimedPaymentId,
  externalChargebackId: `mock-chargeback-pending-unclaimed-${randomUUID()}`,
  amountMinor: "5175",
  currency: "USD",
  occurredAt: new Date(pendingUnclaimedPaymentAt.getTime() + 1_000).toISOString(),
});
assert.equal(pendingUnclaimedChargebackFact.status, 202);
assert.equal(pendingUnclaimedChargebackFact.body.status, "pending_source");
await corePool.query(
  `UPDATE client_accounts SET restricted_at = now() WHERE id = $1`,
  [pendingUnclaimedOperationRow.client_account_id],
);
const pendingThenUnclaimedPayment = await submitPaymentFact({
  eventId: `add-funds-pending-unclaimed:${randomUUID()}`,
  providerOperationId: pendingUnclaimedOperationRow.id,
  paymentAttemptId: unclaimedPendingChargebackAddFunds.command.addFundsAttemptId,
  externalPaymentId: pendingUnclaimedPaymentId,
  status: "succeeded",
  amountMinor: "5175",
  currency: "USD",
  occurredAt: pendingUnclaimedPaymentAt.toISOString(),
});
assert.equal(pendingThenUnclaimedPayment.status, 202);
assert.equal(pendingThenUnclaimedPayment.body.status, "unclaimed");
const pendingThenUnclaimedState = await corePool.query<{
  effects: string;
  holds: string;
  disposition: string;
  capacity_frozen: boolean;
  available_minor: string;
}>(
  `SELECT
     (SELECT count(*)::text FROM add_funds_unclaimed_chargeback_effects effect
       WHERE effect.fund_receipt_id = receipt.id) AS effects,
     (SELECT count(*)::text
        FROM add_funds_chargeback_holds hold_record
        JOIN add_funds_chargeback_facts fact ON fact.id = hold_record.fact_id
       WHERE fact.add_funds_attempt_id = $2) AS holds,
     receipt.disposition,
     capacity.capacity_frozen,
     capacity.available_minor::text
   FROM fund_receipts receipt
   JOIN unclaimed_fund_refund_capacity capacity
     ON capacity.fund_receipt_id = receipt.id
   WHERE receipt.external_payment_id = $1`,
  [
    pendingUnclaimedPaymentId,
    unclaimedPendingChargebackAddFunds.command.addFundsAttemptId,
  ],
);
assert.deepEqual(pendingThenUnclaimedState.rows[0], {
  effects: "1",
  holds: "0",
  disposition: "charged_back",
  capacity_frozen: true,
  available_minor: "0",
});
await corePool.query(
  `UPDATE client_accounts SET restricted_at = NULL WHERE id = $1`,
  [pendingUnclaimedOperationRow.client_account_id],
);

cookie = "";
const chargebackEmail = `chargeback-${randomUUID()}@example.invalid`;
await request(
  "/api/v1/auth/register",
  {
    method: "POST",
    body: JSON.stringify({
      email: chargebackEmail,
      password,
      clientName: "Synthetic Chargeback Client",
      locale: "en",
    }),
  },
  201,
);
await corePool.query(
  "UPDATE users SET email_verified_at = now() WHERE email = $1",
  [chargebackEmail],
);
await request(
  "/api/v1/auth/login",
  { method: "POST", body: JSON.stringify({ email: chargebackEmail, password }) },
  200,
);
const chargebackMe = await request<{ id: string; clientAccountId: string }>(
  "/api/v1/auth/me",
);
await request(
  "/api/v1/auth/reauth",
  { method: "POST", body: JSON.stringify({ password }) },
  200,
);
const activeReauthBeforeChargeback = await corePool.query<{ count: string }>(
  `SELECT count(*)::text AS count
   FROM reauth_grants
   WHERE user_id = $1 AND invalidated_at IS NULL
     AND expires_at > pg_catalog.clock_timestamp()`,
  [chargebackMe.id],
);
assert.equal(activeReauthBeforeChargeback.rows[0]?.count, "1");

const chargebackQuote = await createAddFundsQuote("5000", "card");
const chargebackAddFunds = await startAddFunds(chargebackQuote.quoteId, "success");
const chargebackAddFundsSettled = await waitForAddFunds(
  chargebackAddFunds.command.commandId,
  "succeeded",
);
assert.equal(chargebackAddFundsSettled.principalMinor, "5000");
assert.equal(chargebackAddFundsSettled.feeMinor, "175");
assert.equal(chargebackAddFundsSettled.externalDueMinor, "5175");
const originalChargebackSource = await corePool.query<{
  external_payment_id: string;
  receipt_id: string;
  settlement_id: string;
}>(
  `SELECT attempt.external_payment_id, receipt.id AS receipt_id,
          settlement.id AS settlement_id
   FROM add_funds_attempts attempt
   JOIN add_funds_settlements settlement
     ON settlement.add_funds_attempt_id = attempt.id
   JOIN fund_receipts receipt ON receipt.id = settlement.fund_receipt_id
   WHERE attempt.id = $1`,
  [chargebackAddFundsSettled.addFundsAttemptId],
);
const chargebackSource = originalChargebackSource.rows[0];
assert.ok(chargebackSource?.external_payment_id);

const chargebackCreditOrder = await createOrder(automaticPrice.id, legal);
const chargebackCreditQuote = await createPaymentQuote(
  chargebackCreditOrder.invoice.id,
  "usdt",
  true,
);
assert.equal(chargebackCreditQuote.creditToApplyMinor, "500");
assert.equal(chargebackCreditQuote.externalDueMinor, "0");
await request<PaymentCommand>(
  `/api/v1/invoices/${chargebackCreditOrder.invoice.id}/payments`,
  {
    method: "POST",
    body: JSON.stringify({
      quoteId: chargebackCreditQuote.quoteId,
      scenario: "success",
      idempotencyKey: randomUUID(),
    }),
  },
  200,
);
const paidBeforeChargeback = await request<OrderDetail>(
  `/api/v1/orders/${chargebackCreditOrder.order.id}`,
);
assert.equal(paidBeforeChargeback.invoice.status, "paid");
assert.equal(paidBeforeChargeback.invoice.creditAppliedMinor, "500");
await corePool.query(
  `UPDATE client_memberships
   SET removed_at = now()
   WHERE user_id = $1 AND client_account_id = $2`,
  [chargebackMe.id, chargebackMe.clientAccountId],
);

const mockChargebackRequestId = randomUUID();
const mockChargebackResponse = await fetch(
  new URL(
    `/v1/payments/${chargebackAddFundsSettled.providerOperationId}/chargebacks`,
    providerUrl,
  ),
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${paymentProviderToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": mockChargebackRequestId,
    },
    body: JSON.stringify({
      requestId: mockChargebackRequestId,
      scenario: "duplicate",
    }),
  },
);
assert.equal(mockChargebackResponse.status, 202);
const replayedMockChargebackResponse = await fetch(
  new URL(
    `/v1/payments/${chargebackAddFundsSettled.providerOperationId}/chargebacks`,
    providerUrl,
  ),
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${paymentProviderToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": mockChargebackRequestId,
    },
    body: JSON.stringify({
      requestId: mockChargebackRequestId,
      scenario: "duplicate",
    }),
  },
);
assert.equal(replayedMockChargebackResponse.status, 202);
assert.equal(
  ((await replayedMockChargebackResponse.json()) as { replayed: boolean }).replayed,
  true,
);
const replayedMockChargebackCalls = await providerPool.query<{ create_calls: number }>(
  `SELECT create_calls
   FROM mock_chargeback_operations
   WHERE request_id = $1`,
  [mockChargebackRequestId],
);
assert.equal(replayedMockChargebackCalls.rows[0]?.create_calls, 2);
await waitFor(
  "settled Add Funds Chargeback while the originating member is removed",
  () =>
    corePool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM add_funds_chargeback_effects
       WHERE add_funds_settlement_id = $1`,
      [chargebackSource.settlement_id],
    ),
  (result) => result.rows[0]?.count === "1",
  30_000,
);
await corePool.query(
  `UPDATE client_memberships
   SET removed_at = NULL
   WHERE user_id = $1 AND client_account_id = $2`,
  [chargebackMe.id, chargebackMe.clientAccountId],
);
await refreshAccountContext(chargebackMe.clientAccountId);
const customerChargebackStatus = await waitFor(
  "settled Add Funds Chargeback customer status",
  () => request<ChargebackStatus>("/api/v1/billing/chargeback-status"),
  (status) => status.chargebacks.length === 1,
  30_000,
);
assert.equal(customerChargebackStatus.restricted, true);
assert.equal(customerChargebackStatus.creditBalanceMinor, "0");
assert.equal(customerChargebackStatus.debtBalanceMinor, "500");
assert.deepEqual(
  {
    externalAmountMinor: customerChargebackStatus.chargebacks[0]?.externalAmountMinor,
    creditRecoveredMinor: customerChargebackStatus.chargebacks[0]?.creditRecoveredMinor,
    debtMinor: customerChargebackStatus.chargebacks[0]?.debtMinor,
    restrictionActive: customerChargebackStatus.chargebacks[0]?.restrictionActive,
  },
  {
    externalAmountMinor: "5175",
    creditRecoveredMinor: "4500",
    debtMinor: "500",
    restrictionActive: true,
  },
);
await new Promise((resolve) => setTimeout(resolve, 200));
const restrictedBilling = await rawCoreRequest("/api/v1/billing/summary", { method: "GET" });
assert.equal(restrictedBilling.status, 403);
assert.equal(restrictedBilling.body.code, "ACCOUNT_RESTRICTED");

const chargebackEffects = await corePool.query<{
  effects: string;
  facts: string;
  replays: string;
  holds: string;
  credit_debits: string;
  debt_debits: string;
  restrictions: string;
  journals: string;
  active_reauth: string;
  invoice_status: string;
  invoice_credit_minor: string;
  receipt_disposition: string;
  add_funds_status: string;
}>(
  `SELECT
     (SELECT count(*)::text FROM add_funds_chargeback_effects
       WHERE add_funds_settlement_id = $1) AS effects,
     (SELECT count(*)::text FROM add_funds_chargeback_facts
       WHERE add_funds_attempt_id = $2) AS facts,
     (SELECT count(*)::text FROM add_funds_chargeback_replay_dispositions replay
       JOIN add_funds_chargeback_facts fact ON fact.id = replay.fact_id
       WHERE fact.add_funds_attempt_id = $2) AS replays,
     (SELECT count(*)::text FROM add_funds_chargeback_holds hold_record
       JOIN add_funds_chargeback_facts fact ON fact.id = hold_record.fact_id
       WHERE fact.add_funds_attempt_id = $2) AS holds,
     (SELECT count(*)::text FROM credit_transactions
       WHERE kind = 'chargeback' AND source_type = 'add_funds_chargeback_effect'
         AND source_id IN (SELECT id FROM add_funds_chargeback_effects
           WHERE add_funds_settlement_id = $1)) AS credit_debits,
     (SELECT count(*)::text FROM client_account_debt_transactions
       WHERE kind = 'chargeback' AND source_type = 'add_funds_chargeback_effect'
         AND source_id IN (SELECT id FROM add_funds_chargeback_effects
           WHERE add_funds_settlement_id = $1)) AS debt_debits,
     (SELECT count(*)::text FROM client_account_restrictions
       WHERE kind = 'financial_chargeback'
         AND source_id IN (SELECT id FROM add_funds_chargeback_effects
           WHERE add_funds_settlement_id = $1)) AS restrictions,
     (SELECT count(*)::text FROM ledger_journals
       WHERE source_type = 'add_funds_chargeback_effect'
         AND source_id IN (SELECT id FROM add_funds_chargeback_effects
           WHERE add_funds_settlement_id = $1)) AS journals,
     (SELECT count(*)::text FROM reauth_grants
       WHERE user_id = $3 AND invalidated_at IS NULL
         AND expires_at > pg_catalog.clock_timestamp()) AS active_reauth,
     (SELECT CASE
        WHEN allocation.allocated_minor = 0 THEN 'open'
        WHEN allocation.allocated_minor < invoice.total_minor THEN 'partially_paid'
        ELSE 'paid'
      END
      FROM invoices invoice
      JOIN invoice_allocation_totals allocation ON allocation.invoice_id = invoice.id
      WHERE invoice.id = $4) AS invoice_status,
     (SELECT credit_minor::text FROM invoice_allocation_totals WHERE invoice_id = $4)
       AS invoice_credit_minor,
     (SELECT disposition FROM fund_receipts WHERE id = $5) AS receipt_disposition,
     (SELECT status FROM add_funds_attempts WHERE id = $2) AS add_funds_status`,
  [
    chargebackSource.settlement_id,
    chargebackAddFundsSettled.addFundsAttemptId,
    chargebackMe.id,
    chargebackCreditOrder.invoice.id,
    chargebackSource.receipt_id,
  ],
);
assert.deepEqual(chargebackEffects.rows[0], {
  effects: "1",
  facts: "2",
  replays: "1",
  holds: "0",
  credit_debits: "1",
  debt_debits: "1",
  restrictions: "1",
  journals: "1",
  active_reauth: "0",
  invoice_status: "paid",
  invoice_credit_minor: "500",
  receipt_disposition: "allocated",
  add_funds_status: "succeeded",
});
const chargebackJournal = await corePool.query<{
  account_code: string;
  debit_minor: string;
  credit_minor: string;
}>(
  `SELECT line.account_code, line.debit_minor::text, line.credit_minor::text
   FROM ledger_lines line
   JOIN ledger_journals journal ON journal.id = line.journal_id
   JOIN add_funds_chargeback_effects effect ON effect.id = journal.source_id
   WHERE journal.source_type = 'add_funds_chargeback_effect'
     AND effect.add_funds_settlement_id = $1
   ORDER BY line.account_code`,
  [chargebackSource.settlement_id],
);
assert.deepEqual(chargebackJournal.rows, [
  { account_code: "chargeback_receivable", debit_minor: "500", credit_minor: "0" },
  { account_code: "client_credit_liability", debit_minor: "4500", credit_minor: "0" },
  { account_code: "mock_cash", debit_minor: "0", credit_minor: "5175" },
  { account_code: "payment_fee_revenue", debit_minor: "175", credit_minor: "0" },
]);

const wrongAmountRequestId = randomUUID();
const wrongAmountResponse = await fetch(
  new URL(
    `/v1/payments/${chargebackAddFundsSettled.providerOperationId}/chargebacks`,
    providerUrl,
  ),
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${paymentProviderToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": wrongAmountRequestId,
    },
    body: JSON.stringify({ requestId: wrongAmountRequestId, scenario: "wrong_amount" }),
  },
);
assert.equal(wrongAmountResponse.status, 202);
const heldWrongAmount = await waitFor(
  "wrong-amount Chargeback manual hold",
  () => request<ChargebackStatus>("/api/v1/billing/chargeback-status"),
  (status) => status.manualHolds.length === 1,
);
assert.match(heldWrongAmount.manualHolds[0]?.reason ?? "", /conflicts|amount/i);
const afterWrongAmount = await corePool.query<{ effects: string; journals: string }>(
  `SELECT
     (SELECT count(*)::text FROM add_funds_chargeback_effects
       WHERE add_funds_settlement_id = $1) AS effects,
     (SELECT count(*)::text FROM ledger_journals
       WHERE source_type = 'add_funds_chargeback_effect'
         AND source_id IN (SELECT id FROM add_funds_chargeback_effects
           WHERE add_funds_settlement_id = $1)) AS journals`,
  [chargebackSource.settlement_id],
);
assert.deepEqual(afterWrongAmount.rows[0], { effects: "1", journals: "1" });

const canonicalChargebackFact = await corePool.query<{
  provider_operation_id: string;
  add_funds_attempt_id: string;
  original_external_payment_id: string;
  external_chargeback_id: string;
  amount_minor: string;
  currency: string;
  occurred_at: Date;
}>(
  `SELECT
     fact.provider_operation_id,
     fact.add_funds_attempt_id,
     fact.original_external_payment_id,
     fact.external_chargeback_id,
     fact.amount_minor::text,
     fact.currency,
     fact.occurred_at
   FROM add_funds_chargeback_effects effect
   JOIN add_funds_chargeback_facts fact ON fact.id = effect.fact_id
   WHERE effect.add_funds_settlement_id = $1`,
  [chargebackSource.settlement_id],
);
const canonicalChargeback = canonicalChargebackFact.rows[0];
assert.ok(canonicalChargeback);
const changedOccurrenceReplay = await submitAddFundsChargebackFact({
  eventId: `chargeback-changed-occurrence:${randomUUID()}`,
  providerOperationId: canonicalChargeback.provider_operation_id,
  addFundsAttemptId: canonicalChargeback.add_funds_attempt_id,
  originalExternalPaymentId: canonicalChargeback.original_external_payment_id,
  externalChargebackId: canonicalChargeback.external_chargeback_id,
  amountMinor: canonicalChargeback.amount_minor,
  currency: canonicalChargeback.currency,
  occurredAt: new Date(canonicalChargeback.occurred_at.getTime() + 1_000).toISOString(),
});
assert.equal(changedOccurrenceReplay.status, 202);
assert.equal(changedOccurrenceReplay.body.status, "manual");
const changedOccurrenceDisposition = await corePool.query<{
  facts: string;
  effects: string;
  replays: string;
  holds: string;
}>(
  `SELECT
     (SELECT count(*)::text FROM add_funds_chargeback_facts fact
       WHERE fact.external_chargeback_id = $1) AS facts,
     (SELECT count(*)::text FROM add_funds_chargeback_effects effect
       WHERE effect.external_chargeback_id = $1) AS effects,
     (SELECT count(*)::text FROM add_funds_chargeback_replay_dispositions replay
       JOIN add_funds_chargeback_facts fact ON fact.id = replay.fact_id
       WHERE fact.external_chargeback_id = $1) AS replays,
     (SELECT count(*)::text FROM add_funds_chargeback_holds hold_record
       JOIN add_funds_chargeback_facts fact ON fact.id = hold_record.fact_id
       WHERE fact.external_chargeback_id = $1) AS holds`,
  [canonicalChargeback.external_chargeback_id],
);
assert.deepEqual(changedOccurrenceDisposition.rows[0], {
  facts: "3",
  effects: "1",
  replays: "1",
  holds: "1",
});

const crossAccountAttemptEvent = `chargeback-cross-account:${randomUUID()}`;
const crossAccountAttempt = await submitAddFundsChargebackFact({
  eventId: crossAccountAttemptEvent,
  providerOperationId: chargebackAddFundsSettled.providerOperationId,
  addFundsAttemptId: pendingChargebackAddFunds.command.addFundsAttemptId,
  originalExternalPaymentId: chargebackSource.external_payment_id,
  externalChargebackId: `mock-chargeback-cross-account-${randomUUID()}`,
  amountMinor: "5175",
  currency: "USD",
  occurredAt: new Date().toISOString(),
});
assert.equal(crossAccountAttempt.status, 202);
assert.equal(crossAccountAttempt.body.status, "manual");
assert.match(String(crossAccountAttempt.body.reason), /attempt identity/i);
const crossAccountHold = await corePool.query<{
  client_account_id: string | null;
  pending_account_holds: string;
}>(
  `SELECT hold_record.client_account_id,
          (SELECT count(*)::text
            FROM add_funds_chargeback_holds pending_hold
            JOIN add_funds_chargeback_facts pending_fact
              ON pending_fact.id = pending_hold.fact_id
           WHERE pending_fact.add_funds_attempt_id = $2
             AND pending_fact.external_event_id = $1
             AND pending_hold.client_account_id = (
               SELECT client_account_id
               FROM add_funds_attempts
               WHERE id = $2
             )) AS pending_account_holds
   FROM add_funds_chargeback_holds hold_record
   JOIN add_funds_chargeback_facts fact ON fact.id = hold_record.fact_id
   WHERE fact.external_event_id = $1`,
  [crossAccountAttemptEvent, pendingChargebackAddFunds.command.addFundsAttemptId],
);
assert.equal(crossAccountHold.rows[0]?.client_account_id, chargebackMe.clientAccountId);
assert.equal(crossAccountHold.rows[0]?.pending_account_holds, "0");

const invalidCapabilityEvent = `chargeback-invalid-capability:${randomUUID()}`;
const invalidCapability = await submitAddFundsChargebackFact({
  eventId: invalidCapabilityEvent,
  providerOperationId: chargebackAddFundsSettled.providerOperationId,
  addFundsAttemptId: chargebackAddFundsSettled.addFundsAttemptId,
  originalExternalPaymentId: chargebackSource.external_payment_id,
  externalChargebackId: `mock-chargeback-invalid-capability-${randomUUID()}`,
  amountMinor: "5175",
  currency: "USD",
  occurredAt: new Date().toISOString(),
  callbackCapability: "A".repeat(43),
});
assert.equal(invalidCapability.status, 202);
assert.equal(invalidCapability.body.rejected, true);
assert.equal(invalidCapability.body.reason, "invalid_operation_capability");
const invalidCapabilityPersistence = await corePool.query<{ inbox: string; facts: string }>(
  `SELECT
     (SELECT count(*)::text FROM provider_inbox WHERE external_event_id = $1) AS inbox,
     (SELECT count(*)::text FROM add_funds_chargeback_facts
       WHERE external_event_id = $1) AS facts`,
  [invalidCapabilityEvent],
);
assert.deepEqual(invalidCapabilityPersistence.rows[0], { inbox: "0", facts: "0" });

const rejectedSignatureEvent = `chargeback-bad-signature:${randomUUID()}`;
const rejectedSignature = await submitAddFundsChargebackFact(
  {
    eventId: rejectedSignatureEvent,
    providerOperationId: chargebackAddFundsSettled.providerOperationId,
    addFundsAttemptId: chargebackAddFundsSettled.addFundsAttemptId,
    originalExternalPaymentId: chargebackSource.external_payment_id,
    externalChargebackId: `mock-chargeback-${randomUUID()}`,
    amountMinor: "5175",
    currency: "USD",
    occurredAt: new Date().toISOString(),
  },
  "synthetic-wrong-webhook-secret-000000000000",
);
assert.equal(rejectedSignature.status, 401);
const rejectedSignatureInbox = await corePool.query<{ count: string }>(
  `SELECT count(*)::text AS count
   FROM provider_inbox
   WHERE external_event_id = $1`,
  [rejectedSignatureEvent],
);
assert.equal(rejectedSignatureInbox.rows[0]?.count, "0");
const unredactedChargebackCapabilities = await corePool.query<{ count: string }>(
  `SELECT count(*)::text AS count
   FROM provider_inbox
   WHERE event_type = 'add_funds.chargeback'
     AND payload->>'callbackCapability' <> '[REDACTED]'`,
);
assert.equal(unredactedChargebackCapabilities.rows[0]?.count, "0");

cookie = staffCookie;
const adminChargebacks = await request<{
  items: Array<{ clientAccountId: string; debtMinor: string }>;
  unclaimedChargebacks: Array<{
    clientAccountId: string;
    fundReceiptId: string;
    externalAmountMinor: string;
  }>;
  manualHolds: Array<{ clientAccountId: string | null }>;
}>("/api/v1/admin/add-funds-chargebacks");
assert.equal(
  adminChargebacks.items.some(
    (item) => item.clientAccountId === chargebackMe.clientAccountId && item.debtMinor === "500",
  ),
  true,
);
assert.equal(
  adminChargebacks.manualHolds.some(
    (hold) => hold.clientAccountId === chargebackMe.clientAccountId,
  ),
  true,
);
assert.equal(
  adminChargebacks.unclaimedChargebacks.some(
    (effect) =>
      effect.fundReceiptId ===
        secondUnclaimedCustomerStatus.unclaimedChargebacks[0]?.fundReceiptId &&
      effect.externalAmountMinor === "5175",
  ),
  true,
);

const directAttackClient = await corePool.connect();
let rejectedUnboundChargebackDebit = false;
try {
  await directAttackClient.query("BEGIN");
  const creditAccount = await directAttackClient.query<{ id: string }>(
    `SELECT id FROM credit_accounts
     WHERE client_account_id = $1 AND currency = 'USD'`,
    [chargebackMe.clientAccountId],
  );
  await directAttackClient.query(
    `INSERT INTO credit_transactions(
       credit_account_id, kind, credit_minor, debit_minor,
       source_type, source_id, actor_type, reason,
       idempotency_key, request_fingerprint
     ) VALUES ($1, 'chargeback', 0, 1, 'forged', $2, 'provider',
               'forged Chargeback debit', $3, $4)`,
    [creditAccount.rows[0]?.id, randomUUID(), randomUUID(), randomUUID()],
  );
  await directAttackClient.query("COMMIT");
} catch {
  rejectedUnboundChargebackDebit = true;
  await directAttackClient.query("ROLLBACK");
} finally {
  directAttackClient.release();
}
assert.equal(rejectedUnboundChargebackDebit, true);

const directRestrictionClient = await corePool.connect();
let rejectedRestrictionClear = false;
try {
  await directRestrictionClient.query("BEGIN");
  await directRestrictionClient.query(
    `UPDATE client_accounts SET restricted_at = NULL WHERE id = $1`,
    [chargebackMe.clientAccountId],
  );
  await directRestrictionClient.query("COMMIT");
} catch {
  rejectedRestrictionClear = true;
  await directRestrictionClient.query("ROLLBACK");
} finally {
  directRestrictionClient.release();
}
assert.equal(rejectedRestrictionClear, true);

const directDebtClient = await corePool.connect();
let rejectedForgedDebtRecovery = false;
try {
  await directDebtClient.query("BEGIN");
  const debtAccount = await directDebtClient.query<{ id: string }>(
    `SELECT id FROM client_account_debt_accounts
     WHERE client_account_id = $1 AND currency = 'USD'`,
    [chargebackMe.clientAccountId],
  );
  await directDebtClient.query(
    `INSERT INTO client_account_debt_transactions(
       debt_account_id, kind, debit_minor, credit_minor,
       source_type, source_id, actor_type, reason, idempotency_key
     ) VALUES ($1, 'recovery', 0, 1, 'forged', $2, 'system',
               'forged debt recovery', $3)`,
    [debtAccount.rows[0]?.id, randomUUID(), randomUUID()],
  );
  await directDebtClient.query("COMMIT");
} catch {
  rejectedForgedDebtRecovery = true;
  await directDebtClient.query("ROLLBACK");
} finally {
  directDebtClient.release();
}
assert.equal(rejectedForgedDebtRecovery, true);

const sealedJournalClient = await corePool.connect();
let rejectedSealedJournalLines = false;
try {
  await sealedJournalClient.query("BEGIN");
  const chargebackJournalId = await sealedJournalClient.query<{ id: string }>(
    `SELECT journal.id
     FROM ledger_journals journal
     JOIN add_funds_chargeback_effects effect ON effect.id = journal.source_id
     WHERE journal.source_type = 'add_funds_chargeback_effect'
       AND effect.add_funds_settlement_id = $1`,
    [chargebackSource.settlement_id],
  );
  await sealedJournalClient.query(
    `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
     VALUES
       ($1, 'chargeback_receivable', 999, 0),
       ($1, 'mock_cash', 0, 999)`,
    [chargebackJournalId.rows[0]?.id],
  );
  await sealedJournalClient.query("COMMIT");
} catch {
  rejectedSealedJournalLines = true;
  await sealedJournalClient.query("ROLLBACK");
} finally {
  sealedJournalClient.release();
}
assert.equal(rejectedSealedJournalLines, true);

const chargedBackReceiptClient = await corePool.connect();
let rejectedChargedBackReceiptMutation = false;
try {
  await chargedBackReceiptClient.query("BEGIN");
  await chargedBackReceiptClient.query(
    `UPDATE fund_receipts
     SET disposition = 'unclaimed', reason = 'forged reopening', updated_at = now()
     WHERE external_payment_id = $1`,
    [secondUnclaimedPaymentId],
  );
  await chargedBackReceiptClient.query("COMMIT");
} catch {
  rejectedChargedBackReceiptMutation = true;
  await chargedBackReceiptClient.query("ROLLBACK");
} finally {
  chargedBackReceiptClient.release();
}
assert.equal(rejectedChargedBackReceiptMutation, true);

const mismatchedFactClient = await corePool.connect();
let rejectedMismatchedFactSource = false;
try {
  await mismatchedFactClient.query("BEGIN");
  await mismatchedFactClient.query(
    `INSERT INTO add_funds_chargeback_facts(
       provider_installation_id, provider_operation_id, add_funds_attempt_id,
       external_event_id, original_external_payment_id, external_chargeback_id,
       status, amount_minor, currency, occurred_at, fact_fingerprint
     ) VALUES ('mock-payment-v1', $1, $2, $3, $4, $5,
               'succeeded', 1, 'USD', now(), $6)`,
    [
      chargebackAddFundsSettled.providerOperationId,
      pendingChargebackAddFunds.command.addFundsAttemptId,
      `forged-event-${randomUUID()}`,
      chargebackSource.external_payment_id,
      `forged-chargeback-${randomUUID()}`,
      randomUUID(),
    ],
  );
  await mismatchedFactClient.query("COMMIT");
} catch {
  rejectedMismatchedFactSource = true;
  await mismatchedFactClient.query("ROLLBACK");
} finally {
  mismatchedFactClient.release();
}
assert.equal(rejectedMismatchedFactSource, true);

// Exercise the real Worker -> Mock Provider -> Core resource-action boundary.
// The fixture uses historical synthetic dates so the two signed billing runs
// cannot create renewals for the other Stage A services.
const resourceLifecycleNamespace = randomUUID();
const resourceLifecycleUserId = randomUUID();
const resourceLifecycleAccountId = randomUUID();
const resourceLifecycleOrderId = randomUUID();
const resourceLifecycleOrderItemId = randomUUID();
const resourceLifecycleInitialInvoiceId = randomUUID();
const resourceLifecycleServiceId = randomUUID();
const resourceLifecycleCreateOperationId = randomUUID();
const resourceLifecycleExternalId = `mock-resource-${resourceLifecycleCreateOperationId}`;
const resourceLifecycleTermStart = new Date("2006-01-01T01:00:00.000Z");
const resourceLifecycleTermEnd = new Date("2006-02-01T01:00:00.000Z");
const resourceLifecycleSnapshot = {
  currency: "USD",
  billingCycle: "monthly",
  productId: "hkbgp-vps",
  productName: "Synthetic Worker Resource Lifecycle VPS",
  fulfillmentMode: "automatic",
  components: [
    {
      code: "base",
      label: "Synthetic Worker Resource Lifecycle VPS",
      quantity: 1,
      oneTimeMinor: "0",
      recurringMinor: "300",
    },
  ],
  oneTimeSubtotalMinor: "0",
  setupMinor: "0",
  recurringSubtotalMinor: "300",
  invoiceTotalMinor: "300",
};
const resourceLifecycleSetup = await corePool.connect();
try {
  await resourceLifecycleSetup.query("BEGIN");
  const policy = await resourceLifecycleSetup.query<{
    late_fee_enabled: boolean;
    overdue_suspension_enabled: boolean;
  }>(
    `SELECT late_fee_enabled, overdue_suspension_enabled
     FROM billing_automation_policies WHERE id = 'default' FOR UPDATE`,
  );
  assert.deepEqual(policy.rows[0], {
    late_fee_enabled: true,
    overdue_suspension_enabled: true,
  });
  await resourceLifecycleSetup.query(
    `INSERT INTO users(id, email, password_hash, locale, email_verified_at)
     VALUES ($1, $2, 'synthetic-runtime-only-hash', 'en', $3)`,
    [
      resourceLifecycleUserId,
      `resource-lifecycle-${resourceLifecycleNamespace}@example.invalid`,
      resourceLifecycleTermStart,
    ],
  );
  await resourceLifecycleSetup.query(
    `INSERT INTO client_accounts(id, name, owner_user_id)
     VALUES ($1, 'Synthetic Worker Resource Lifecycle', $2)`,
    [resourceLifecycleAccountId, resourceLifecycleUserId],
  );
  await resourceLifecycleSetup.query(
    `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
     VALUES ($1, $2, 'owner', '["*"]'::jsonb)`,
    [resourceLifecycleAccountId, resourceLifecycleUserId],
  );
  await resourceLifecycleSetup.query(
    `INSERT INTO orders(
       id, client_account_id, submitted_by_user_id, status, currency, price_snapshot,
       one_time_minor, setup_minor, recurring_minor, total_minor,
       idempotency_key, request_fingerprint, submitted_at, updated_at
     ) VALUES (
       $1, $2, $3, 'completed', 'USD', $4,
       0, 0, 300, 300, $5, $6, $7, $7
     )`,
    [
      resourceLifecycleOrderId,
      resourceLifecycleAccountId,
      resourceLifecycleUserId,
      resourceLifecycleSnapshot,
      `resource-lifecycle-order:${resourceLifecycleNamespace}`,
      `resource-lifecycle-order-fingerprint:${resourceLifecycleNamespace}`,
      resourceLifecycleTermStart,
    ],
  );
  await resourceLifecycleSetup.query(
    `INSERT INTO order_items(
       id, order_id, product_id, product_name, fulfillment_mode,
       billing_cycle, configuration, price_snapshot
     ) VALUES (
       $1, $2, 'hkbgp-vps', 'Synthetic Worker Resource Lifecycle VPS',
       'automatic', 'monthly', '{}'::jsonb, $3
     )`,
    [resourceLifecycleOrderItemId, resourceLifecycleOrderId, resourceLifecycleSnapshot],
  );
  await resourceLifecycleSetup.query(
    `INSERT INTO invoices(id, client_account_id, order_id, currency, total_minor, due_at)
     VALUES ($1, $2, $3, 'USD', 0, $4)`,
    [
      resourceLifecycleInitialInvoiceId,
      resourceLifecycleAccountId,
      resourceLifecycleOrderId,
      resourceLifecycleTermStart,
    ],
  );
  await resourceLifecycleSetup.query(
    `INSERT INTO services(
       id, client_account_id, order_item_id, status, billing_cycle,
       activated_at, term_start, term_end, external_resource_id
     ) VALUES ($1, $2, $3, 'active', 'monthly', $4, $4, $5, $6)`,
    [
      resourceLifecycleServiceId,
      resourceLifecycleAccountId,
      resourceLifecycleOrderItemId,
      resourceLifecycleTermStart,
      resourceLifecycleTermEnd,
      resourceLifecycleExternalId,
    ],
  );
  await resourceLifecycleSetup.query(
    `INSERT INTO service_periods(
       service_id, invoice_id, period_kind, period_start, period_end, granted_at
     ) VALUES ($1, $2, 'initial', $3, $4, $3)`,
    [
      resourceLifecycleServiceId,
      resourceLifecycleInitialInvoiceId,
      resourceLifecycleTermStart,
      resourceLifecycleTermEnd,
    ],
  );
  const binding = await resourceLifecycleSetup.query(
    `INSERT INTO service_provider_bindings(
       service_id, provider_installation_id, overdue_action_snapshot,
       capability_snapshot, product_policy_version,
       cycle_end_cancellation_mode_snapshot,
       cycle_end_cancellation_execution_mode_snapshot,
       cycle_end_cancellation_min_notice_hours_snapshot,
       cycle_end_cancellation_requirement_key_snapshot
     )
     SELECT $1, policy.provider_installation_id, policy.overdue_action,
            provider.capabilities, policy.version,
            policy.cycle_end_cancellation_mode,
            policy.cycle_end_cancellation_execution_mode,
            policy.cycle_end_cancellation_min_notice_hours,
            policy.cycle_end_cancellation_requirement_key
     FROM product_service_automation_policies policy
     JOIN provider_installation_capabilities provider
       ON provider.provider_installation_id = policy.provider_installation_id
     WHERE policy.product_id = 'hkbgp-vps'
       AND policy.overdue_action = 'automatic'
       AND provider.enabled
     RETURNING service_id`,
    [resourceLifecycleServiceId],
  );
  assert.equal(binding.rowCount, 1);
  await resourceLifecycleSetup.query("COMMIT");
} catch (error) {
  await resourceLifecycleSetup.query("ROLLBACK");
  throw error;
} finally {
  resourceLifecycleSetup.release();
}
await providerPool.query(
  `INSERT INTO mock_resource_operations(
     operation_id, service_id, external_resource_id, callback_capability,
     scenario, status, ready_at, request_fingerprint, resource_state
   ) VALUES ($1, $2, $3, $4, 'success', 'succeeded', now(), $5, 'active')`,
  [
    resourceLifecycleCreateOperationId,
    resourceLifecycleServiceId,
    resourceLifecycleExternalId,
    "A".repeat(43),
    `resource-lifecycle-fixture:${resourceLifecycleNamespace}`,
  ],
);

const renewalCreationRun = await runSignedBillingDay({
  businessDate: "2006-01-18",
  effectiveAt: "2006-01-18T01:00:00.000Z",
});
assert.equal(renewalCreationRun.status, 201);
const runtimeRenewal = await corePool.query<{
  id: string;
  invoice_id: string;
}>(
  `SELECT id, invoice_id FROM service_renewals WHERE service_id = $1`,
  [resourceLifecycleServiceId],
);
const runtimeRenewalRow = runtimeRenewal.rows[0];
assert.ok(runtimeRenewalRow);
const suspensionRun = await runSignedBillingDay({
  businessDate: "2006-02-06",
  effectiveAt: "2006-02-06T01:00:00.000Z",
});
assert.equal(suspensionRun.status, 201);

type ResourceLifecycleState = {
  service_status: string;
  case_id: string;
  case_status: string;
  operation_id: string;
  operation_status: string;
  operation_attempt_count: number;
  provider_occurred_at: Date | null;
};
const readResourceLifecycle = async (
  operationKind: "resource_suspend" | "resource_resume",
): Promise<ResourceLifecycleState | null> => {
  const state = await corePool.query<ResourceLifecycleState>(
    `SELECT service.status AS service_status,
            suspension_case.id AS case_id,
            suspension_case.status AS case_status,
            operation.id AS operation_id,
            operation.status AS operation_status,
            operation.attempt_count AS operation_attempt_count,
            operation.provider_occurred_at
     FROM services service
     JOIN service_suspension_cases suspension_case
       ON suspension_case.service_id = service.id
     JOIN provider_operations operation
       ON operation.subject_type = 'service_suspension_case'
      AND operation.subject_id = suspension_case.id
      AND operation.kind = $2
     WHERE service.id = $1`,
    [resourceLifecycleServiceId, operationKind],
  );
  return state.rows[0] ?? null;
};
const suspendedRuntime = await waitFor(
  "Worker timeout/reconcile suspension to reach the Core terminal state",
  () => readResourceLifecycle("resource_suspend"),
  (state) =>
    state?.service_status === "suspended" &&
    state.case_status === "suspended" &&
    state.operation_status === "succeeded",
  45_000,
);
assert.ok(suspendedRuntime);
assert.equal(suspendedRuntime.operation_attempt_count, 1);
const runtimeInvoice = await corePool.query<{
  total_minor: string;
  late_fees: string;
}>(
  `SELECT invoice.total_minor::text,
          count(assessment.id)::text AS late_fees
   FROM invoices invoice
   LEFT JOIN invoice_late_fee_assessments assessment
     ON assessment.invoice_id = invoice.id
   WHERE invoice.id = $1
   GROUP BY invoice.id`,
  [runtimeRenewalRow.invoice_id],
);
assert.deepEqual(runtimeInvoice.rows[0], { total_minor: "330", late_fees: "1" });

const runtimePayment = await corePool.connect();
try {
  await runtimePayment.query("BEGIN");
  const paymentAttemptId = randomUUID();
  const receiptId = randomUUID();
  const externalPaymentId = `resource-lifecycle-payment:${paymentAttemptId}`;
  await runtimePayment.query(
    `INSERT INTO payment_attempts(
       id, client_account_id, invoice_id, provider_installation_id,
       external_payment_id, status, amount_minor, currency, scenario,
       idempotency_key, request_fingerprint
     ) VALUES (
       $1, $2, $3, 'runtime-integration-payment', $4,
       'succeeded', 330, 'USD', 'success', $5, $6
     )`,
    [
      paymentAttemptId,
      resourceLifecycleAccountId,
      runtimeRenewalRow.invoice_id,
      externalPaymentId,
      `resource-lifecycle-payment:${resourceLifecycleNamespace}`,
      `resource-lifecycle-payment-fingerprint:${resourceLifecycleNamespace}`,
    ],
  );
  await runtimePayment.query(
    `INSERT INTO fund_receipts(
       id, provider_installation_id, external_payment_id,
       reported_payment_attempt_id, client_account_id,
       amount_minor, allocated_minor, currency, occurred_at, disposition
     ) VALUES (
       $1, 'runtime-integration-payment', $2, $3, $4,
       330, 330, 'USD', now(), 'allocated'
     )`,
    [receiptId, externalPaymentId, paymentAttemptId, resourceLifecycleAccountId],
  );
  await runtimePayment.query(
    `INSERT INTO payment_allocations(payment_attempt_id, invoice_id, amount_minor)
     VALUES ($1, $2, 330)`,
    [paymentAttemptId, runtimeRenewalRow.invoice_id],
  );
  const paymentJournal = await runtimePayment.query<{ id: string }>(
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES ('fund_receipt', $1, 'USD', 'Synthetic resource lifecycle payment')
     RETURNING id`,
    [receiptId],
  );
  await runtimePayment.query(
    `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
     VALUES
       ($1, 'mock_cash', 330, 0),
       ($1, 'accounts_receivable', 0, 330)`,
    [paymentJournal.rows[0]?.id],
  );
  const settlement = await advancePaidInvoice(runtimePayment, runtimeRenewalRow.invoice_id, {
    kind: "user_command",
    userId: resourceLifecycleUserId,
  });
  assert.equal(settlement.renewalStatus, "paid");
  assert.equal(settlement.resumeSchedule, "resume_queued");
  await runtimePayment.query("COMMIT");
} catch (error) {
  await runtimePayment.query("ROLLBACK");
  throw error;
} finally {
  runtimePayment.release();
}

const resumedRuntime = await waitFor(
  "Worker timeout/reconcile resume to reach the Core terminal state",
  () => readResourceLifecycle("resource_resume"),
  (state) =>
    state?.service_status === "active" &&
    state.case_status === "resolved" &&
    state.operation_status === "succeeded",
  45_000,
);
assert.ok(resumedRuntime);
assert.equal(resumedRuntime.operation_attempt_count, 1);
assert.ok(resumedRuntime.provider_occurred_at);
const expectedResourceActionScenario = process.env.EXPECT_RESOURCE_ACTION_SCENARIO;
const expectedResourceActionQueryCalls =
  expectedResourceActionScenario === "timeout_success" ? 1 : 0;
const providerResourceActions = await providerPool.query<{
  action: "suspend" | "resume";
  scenario: string;
  status: string;
  action_calls: number;
  query_calls: number;
}>(
  `SELECT action, scenario, status, action_calls, query_calls
   FROM mock_resource_action_operations
   WHERE service_id = $1
   ORDER BY occurred_at, operation_id`,
  [resourceLifecycleServiceId],
);
assert.deepEqual(
  providerResourceActions.rows.map((row) => ({
    action: row.action,
    status: row.status,
    actionCalls: row.action_calls,
    queryCalls: row.query_calls,
  })),
  [
    {
      action: "suspend",
      status: "succeeded",
      actionCalls: 1,
      queryCalls: expectedResourceActionQueryCalls,
    },
    {
      action: "resume",
      status: "succeeded",
      actionCalls: 1,
      queryCalls: expectedResourceActionQueryCalls,
    },
  ],
);
if (expectedResourceActionScenario) {
  assert.ok(
    providerResourceActions.rows.every(
      (row) => row.scenario === expectedResourceActionScenario,
    ),
    `Worker must request the expected resource action scenario ${expectedResourceActionScenario}`,
  );
}
if (expectedResourceActionScenario === "timeout_success") {
  const reconcileJobs = await corePool.query<{ job_type: string; status: string }>(
    `SELECT job_type, status
     FROM durable_jobs
     WHERE unique_key IN ($1, $2)
       AND job_type IN ('service.suspend.reconcile', 'service.resume.reconcile')
     ORDER BY job_type`,
    [
      `service-suspension-case:${resumedRuntime.case_id}:suspend`,
      `service-suspension-case:${resumedRuntime.case_id}:resume`,
    ],
  );
  assert.deepEqual(reconcileJobs.rows, [
    { job_type: "service.resume.reconcile", status: "completed" },
    { job_type: "service.suspend.reconcile", status: "completed" },
  ]);
}

const duplicateResumeFact = await submitResourceActionFact({
  eventId: `resource-lifecycle-resume-duplicate:${resourceLifecycleNamespace}`,
  providerOperationId: resumedRuntime.operation_id,
  serviceId: resourceLifecycleServiceId,
  externalResourceId: resourceLifecycleExternalId,
  action: "resume",
  status: "succeeded",
  occurredAt: resumedRuntime.provider_occurred_at.toISOString(),
});
assert.equal(duplicateResumeFact.status, 202);
const staleResumeFailure = await submitResourceActionFact({
  eventId: `resource-lifecycle-resume-stale:${resourceLifecycleNamespace}`,
  providerOperationId: resumedRuntime.operation_id,
  serviceId: resourceLifecycleServiceId,
  externalResourceId: resourceLifecycleExternalId,
  action: "resume",
  status: "failed",
  occurredAt: new Date(
    resumedRuntime.provider_occurred_at.getTime() - 1_000,
  ).toISOString(),
});
assert.equal(staleResumeFailure.status, 202);
const finalResourceLifecycle = await corePool.query<{
  service_status: string;
  case_status: string;
  cases: string;
  operations: string;
}>(
  `SELECT service.status AS service_status,
          suspension_case.status AS case_status,
          (SELECT count(*)::text FROM service_suspension_cases counted_case
           WHERE counted_case.service_id = service.id) AS cases,
          (SELECT count(*)::text FROM provider_operations operation
           WHERE operation.subject_type = 'service_suspension_case'
             AND operation.subject_id = suspension_case.id
             AND operation.kind IN ('resource_suspend', 'resource_resume')) AS operations
   FROM services service
   JOIN service_suspension_cases suspension_case
     ON suspension_case.service_id = service.id
   WHERE service.id = $1`,
  [resourceLifecycleServiceId],
);
assert.deepEqual(finalResourceLifecycle.rows[0], {
  service_status: "active",
  case_status: "resolved",
  cases: "1",
  operations: "2",
});

// Reuse the now-active service for the exact payment race: billing commits a
// queued suspension, an external result becomes unknown before the Worker can
// dispatch it, and settlement later wins without any Provider POST.
const secondRenewalCreation = await runSignedBillingDay({
  businessDate: "2006-02-15",
  effectiveAt: "2006-02-15T01:00:00.000Z",
});
assert.equal(secondRenewalCreation.status, 201);
const secondRuntimeRenewal = await corePool.query<{ id: string; invoice_id: string }>(
  `SELECT id, invoice_id
   FROM service_renewals
   WHERE service_id = $1 AND status = 'invoiced'
   ORDER BY created_at DESC
   LIMIT 1`,
  [resourceLifecycleServiceId],
);
const secondRuntimeRenewalRow = secondRuntimeRenewal.rows[0];
assert.ok(secondRuntimeRenewalRow);
const pendingRaceAttemptId = randomUUID();
const pendingRaceExternalPaymentId = `resource-lifecycle-pending:${pendingRaceAttemptId}`;
const pendingRace = await corePool.connect();
try {
  await pendingRace.query("BEGIN");
  const secondDelinquencyRun = await runRenewalAutomation(pendingRace, {
    requestedByUserId: null,
    reason: "Scheduled Asia/Shanghai billing automation",
    scheduledBusinessDate: "2006-03-06",
    effectiveAt: new Date("2006-03-06T01:00:00.000Z"),
  });
  assert.equal(secondDelinquencyRun.suspensionCasesCreated, 1);
  await pendingRace.query(
    `INSERT INTO payment_attempts(
       id, client_account_id, invoice_id, provider_installation_id,
       external_payment_id, status, amount_minor, currency, scenario,
       idempotency_key, request_fingerprint
     ) VALUES (
       $1, $2, $3, 'runtime-integration-payment', $4,
       'unknown', 330, 'USD', 'timeout_success', $5, $6
     )`,
    [
      pendingRaceAttemptId,
      resourceLifecycleAccountId,
      secondRuntimeRenewalRow.invoice_id,
      pendingRaceExternalPaymentId,
      `resource-lifecycle-pending:${resourceLifecycleNamespace}`,
      `resource-lifecycle-pending-fingerprint:${resourceLifecycleNamespace}`,
    ],
  );
  await pendingRace.query("COMMIT");
} catch (error) {
  await pendingRace.query("ROLLBACK");
  throw error;
} finally {
  pendingRace.release();
}
const pendingRaceState = await waitFor(
  "Worker suspension preflight to defer an unresolved payment without Provider POST",
  async () => {
    const state = await corePool.query<{
      case_id: string;
      case_status: string;
      operation_id: string;
      operation_status: string;
      operation_attempt_count: number;
      job_status: string;
      job_last_error: string | null;
      provider_action_count: string;
    }>(
      `SELECT suspension_case.id AS case_id,
              suspension_case.status AS case_status,
              operation.id AS operation_id,
              operation.status AS operation_status,
              operation.attempt_count AS operation_attempt_count,
              job.status AS job_status,
              job.last_error AS job_last_error,
              (SELECT count(*)::text
               FROM provider_operations sent_operation
               WHERE sent_operation.subject_type = 'service_suspension_case'
                 AND sent_operation.subject_id = suspension_case.id
                 AND sent_operation.attempt_count > 0) AS provider_action_count
       FROM service_suspension_cases suspension_case
       JOIN provider_operations operation
         ON operation.subject_type = 'service_suspension_case'
        AND operation.subject_id = suspension_case.id
        AND operation.kind = 'resource_suspend'
       JOIN durable_jobs job
         ON job.job_type = 'service.suspend.start'
        AND job.unique_key = operation.stable_key
       WHERE suspension_case.service_renewal_id = $1`,
      [secondRuntimeRenewalRow.id],
    );
    return state.rows[0] ?? null;
  },
  (state) =>
    state?.case_status === "suspend_queued" &&
    state.operation_status === "queued" &&
    state.operation_attempt_count === 0 &&
    state.job_status === "pending" &&
    state.job_last_error?.includes("external payment result is unresolved") === true,
  15_000,
);
assert.ok(pendingRaceState);
assert.equal(pendingRaceState.provider_action_count, "0");
const actionsBeforePendingSettlement = await providerPool.query<{ count: string }>(
  `SELECT count(*)::text AS count
   FROM mock_resource_action_operations
   WHERE service_id = $1`,
  [resourceLifecycleServiceId],
);
assert.equal(actionsBeforePendingSettlement.rows[0]?.count, "2");

const settlePendingRace = await corePool.connect();
try {
  await settlePendingRace.query("BEGIN");
  await settlePendingRace.query(
    `UPDATE payment_attempts
     SET status = 'succeeded', provider_occurred_at = now(),
         updated_at = now(), version = version + 1
     WHERE id = $1 AND status = 'unknown'`,
    [pendingRaceAttemptId],
  );
  const pendingReceiptId = randomUUID();
  await settlePendingRace.query(
    `INSERT INTO fund_receipts(
       id, provider_installation_id, external_payment_id,
       reported_payment_attempt_id, client_account_id,
       amount_minor, allocated_minor, currency, occurred_at, disposition
     ) VALUES (
       $1, 'runtime-integration-payment', $2, $3, $4,
       330, 330, 'USD', now(), 'allocated'
     )`,
    [
      pendingReceiptId,
      pendingRaceExternalPaymentId,
      pendingRaceAttemptId,
      resourceLifecycleAccountId,
    ],
  );
  await settlePendingRace.query(
    `INSERT INTO payment_allocations(payment_attempt_id, invoice_id, amount_minor)
     VALUES ($1, $2, 330)`,
    [pendingRaceAttemptId, secondRuntimeRenewalRow.invoice_id],
  );
  const pendingJournal = await settlePendingRace.query<{ id: string }>(
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES ('fund_receipt', $1, 'USD', 'Synthetic pending-race payment')
     RETURNING id`,
    [pendingReceiptId],
  );
  await settlePendingRace.query(
    `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
     VALUES
       ($1, 'mock_cash', 330, 0),
       ($1, 'accounts_receivable', 0, 330)`,
    [pendingJournal.rows[0]?.id],
  );
  const pendingSettlement = await advancePaidInvoice(
    settlePendingRace,
    secondRuntimeRenewalRow.invoice_id,
    { kind: "user_command", userId: resourceLifecycleUserId },
  );
  assert.equal(pendingSettlement.renewalStatus, "paid");
  await settlePendingRace.query("COMMIT");
} catch (error) {
  await settlePendingRace.query("ROLLBACK");
  throw error;
} finally {
  settlePendingRace.release();
}
await corePool.query(
  `UPDATE durable_jobs
   SET available_at = now(), updated_at = now()
   WHERE job_type = 'service.suspend.start'
     AND unique_key = $1
     AND status = 'pending'`,
  [`service-suspension-case:${pendingRaceState.case_id}:suspend`],
);
const resolvedPendingRace = await waitFor(
  "settlement to cancel the known-unsent suspension",
  async () => {
    const state = await corePool.query<{
      service_status: string;
      case_status: string;
      operation_status: string;
      operation_attempt_count: number;
      job_status: string;
    }>(
      `SELECT service.status AS service_status,
              suspension_case.status AS case_status,
              operation.status AS operation_status,
              operation.attempt_count AS operation_attempt_count,
              job.status AS job_status
       FROM services service
       JOIN service_suspension_cases suspension_case
         ON suspension_case.service_id = service.id
       JOIN provider_operations operation
         ON operation.subject_type = 'service_suspension_case'
        AND operation.subject_id = suspension_case.id
        AND operation.kind = 'resource_suspend'
       JOIN durable_jobs job
         ON job.job_type = 'service.suspend.start'
        AND job.unique_key = operation.stable_key
       WHERE suspension_case.id = $1`,
      [pendingRaceState.case_id],
    );
    return state.rows[0] ?? null;
  },
  (state) =>
    state?.service_status === "active" &&
    state.case_status === "resolved" &&
    state.operation_status === "failed" &&
    state.operation_attempt_count === 0 &&
    state.job_status === "completed",
  15_000,
);
assert.ok(resolvedPendingRace);
const actionsAfterPendingSettlement = await providerPool.query<{ count: string }>(
  `SELECT count(*)::text AS count
   FROM mock_resource_action_operations
   WHERE service_id = $1`,
  [resourceLifecycleServiceId],
);
assert.equal(
  actionsAfterPendingSettlement.rows[0]?.count,
  "2",
  "pending payment settlement must not dispatch a late suspension",
);

// A customer may obtain a full-Credit quote while a renewal is payable, but an
// immediate termination before submission must invalidate the command before
// any Credit, allocation, journal, payment, or Provider fact is written.
cookie = "";
const terminatedCreditNamespace = randomUUID();
const terminatedCreditEmail = `terminated-credit-${terminatedCreditNamespace}@example.invalid`;
const terminatedCreditPassword = `Synthetic-${terminatedCreditNamespace}-Credit!`;
await request(
  "/api/v1/auth/register",
  {
    method: "POST",
    body: JSON.stringify({
      email: terminatedCreditEmail,
      password: terminatedCreditPassword,
      clientName: `Synthetic Terminated Credit ${terminatedCreditNamespace.slice(0, 8)}`,
      locale: "en",
    }),
  },
  201,
);
await request(
  "/api/v1/auth/login",
  {
    method: "POST",
    body: JSON.stringify({
      email: terminatedCreditEmail,
      password: terminatedCreditPassword,
    }),
  },
  200,
);
const terminatedCreditCookie = cookie;
const terminatedCreditIdentity = await corePool.query<{
  user_id: string;
  client_account_id: string;
}>(
  `SELECT user_record.id AS user_id, membership.client_account_id
   FROM users user_record
   JOIN client_memberships membership
     ON membership.user_id = user_record.id AND membership.removed_at IS NULL
   WHERE user_record.email = $1`,
  [terminatedCreditEmail],
);
const terminatedCreditIdentityRow = terminatedCreditIdentity.rows[0];
assert.ok(terminatedCreditIdentityRow);
await corePool.query(
  "UPDATE users SET email_verified_at = now() WHERE id = $1",
  [terminatedCreditIdentityRow.user_id],
);
await refreshAccountContext(terminatedCreditIdentityRow.client_account_id);
const terminatedCreditOrder = await createOrder(automaticPrice.id, legal);
await pay(terminatedCreditOrder, "success");
const terminatedCreditActive = await waitFor(
  "full-Credit termination fixture service activation",
  () => request<OrderDetail>(`/api/v1/orders/${terminatedCreditOrder.order.id}`),
  (current) => current.service.status === "active",
);
assert.ok(terminatedCreditActive.service.termEnd);
const renewalLookahead = new Date(
  new Date(terminatedCreditActive.service.termEnd).getTime() - 13 * 24 * 60 * 60 * 1_000,
);
const businessDateParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).formatToParts(renewalLookahead);
const businessDatePart = (type: "year" | "month" | "day") =>
  businessDateParts.find((part) => part.type === type)?.value;
const terminatedCreditBusinessDate = `${businessDatePart("year")}-${businessDatePart("month")}-${businessDatePart("day")}`;
assert.match(terminatedCreditBusinessDate, /^\d{4}-\d{2}-\d{2}$/);
const terminatedCreditBilling = await runSignedBillingDay({
  businessDate: terminatedCreditBusinessDate,
  effectiveAt: `${terminatedCreditBusinessDate}T01:00:00.000Z`,
});
assert.equal(terminatedCreditBilling.status, 201);
const terminatedCreditRenewal = await corePool.query<{
  renewal_id: string;
  invoice_id: string;
  total_minor: string;
}>(
  `SELECT renewal.id AS renewal_id, renewal.invoice_id, invoice.total_minor::text
   FROM service_renewals renewal
   JOIN invoices invoice ON invoice.id = renewal.invoice_id
   WHERE renewal.service_id = $1 AND renewal.status = 'invoiced'
   ORDER BY renewal.created_at DESC
   LIMIT 1`,
  [terminatedCreditActive.service.id],
);
const terminatedCreditRenewalRow = terminatedCreditRenewal.rows[0];
assert.ok(terminatedCreditRenewalRow);

cookie = staffCookie;
await request(
  "/api/v1/auth/reauth",
  { method: "POST", body: JSON.stringify({ password }) },
  200,
);
await request(
  `/api/v1/admin/client-accounts/${terminatedCreditIdentityRow.client_account_id}/credit-adjustments`,
  {
    method: "POST",
    body: JSON.stringify({
      direction: "increase",
      amountMinor: terminatedCreditRenewalRow.total_minor,
      currency: "USD",
      reason: "Synthetic full-Credit termination race fixture",
      idempotencyKey: randomUUID(),
    }),
  },
  201,
);
cookie = terminatedCreditCookie;
const terminatedCreditQuote = await createPaymentQuote(
  terminatedCreditRenewalRow.invoice_id,
  "usdt",
  true,
);
assert.equal(terminatedCreditQuote.creditToApplyMinor, terminatedCreditRenewalRow.total_minor);
assert.equal(terminatedCreditQuote.externalDueMinor, "0");
const terminatedCreditBefore = await corePool.query<{
  balance_minor: string;
  credit_allocations: string;
  payment_commands: string;
  payment_journals: string;
}>(
  `SELECT
     COALESCE(sum(transaction.credit_minor - transaction.debit_minor), 0)::text AS balance_minor,
     (SELECT count(*)::text FROM credit_allocations WHERE invoice_id = $2) AS credit_allocations,
     (SELECT count(*)::text FROM invoice_payment_commands WHERE invoice_id = $2) AS payment_commands,
     (SELECT count(*)::text FROM ledger_journals
       WHERE source_type = 'invoice_credit_application'
         AND source_id IN (
           SELECT id FROM credit_transactions WHERE source_id IN (
             SELECT id FROM invoice_payment_commands WHERE invoice_id = $2
           )
         )) AS payment_journals
   FROM credit_accounts account
   LEFT JOIN credit_transactions transaction ON transaction.credit_account_id = account.id
   WHERE account.client_account_id = $1 AND account.currency = 'USD'`,
  [terminatedCreditIdentityRow.client_account_id, terminatedCreditRenewalRow.invoice_id],
);
await corePool.query(
  "UPDATE services SET status = 'terminated', updated_at = now(), version = version + 1 WHERE id = $1",
  [terminatedCreditActive.service.id],
);
const terminatedCreditPayment = await rawCoreRequest(
  `/api/v1/invoices/${terminatedCreditRenewalRow.invoice_id}/payments`,
  {
    method: "POST",
    body: JSON.stringify({
      quoteId: terminatedCreditQuote.quoteId,
      scenario: "success",
      idempotencyKey: randomUUID(),
    }),
  },
);
assert.equal(terminatedCreditPayment.status, 409);
assert.equal(terminatedCreditPayment.body.code, "INVOICE_NOT_PAYABLE");
const terminatedCreditAfter = await corePool.query<{
  balance_minor: string;
  credit_allocations: string;
  payment_commands: string;
  payment_journals: string;
  renewal_status: string;
  service_status: string;
}>(
  `SELECT
     COALESCE(sum(transaction.credit_minor - transaction.debit_minor), 0)::text AS balance_minor,
     (SELECT count(*)::text FROM credit_allocations WHERE invoice_id = $2) AS credit_allocations,
     (SELECT count(*)::text FROM invoice_payment_commands WHERE invoice_id = $2) AS payment_commands,
     (SELECT count(*)::text FROM ledger_journals
       WHERE source_type = 'invoice_credit_application'
         AND source_id IN (
           SELECT id FROM credit_transactions WHERE source_id IN (
             SELECT id FROM invoice_payment_commands WHERE invoice_id = $2
           )
         )) AS payment_journals,
     (SELECT status FROM service_renewals WHERE id = $3) AS renewal_status,
     (SELECT status FROM services WHERE id = $4) AS service_status
   FROM credit_accounts account
   LEFT JOIN credit_transactions transaction ON transaction.credit_account_id = account.id
   WHERE account.client_account_id = $1 AND account.currency = 'USD'`,
  [
    terminatedCreditIdentityRow.client_account_id,
    terminatedCreditRenewalRow.invoice_id,
    terminatedCreditRenewalRow.renewal_id,
    terminatedCreditActive.service.id,
  ],
);
assert.deepEqual(terminatedCreditAfter.rows[0], {
  ...terminatedCreditBefore.rows[0],
  renewal_status: "invoiced",
  service_status: "terminated",
});

// A customer schedules cancellation from the service boundary before the
// renewal window. The service remains active through the paid term, exact
// retries replay one request, cross-account callers learn nothing, and the
// billing run must not create the next invoice after locking the same service.
const cancellationNamespace = randomUUID();
const cancellationEmail = `cycle-end-cancellation-${cancellationNamespace}@example.invalid`;
const cancellationPassword = `Synthetic-${cancellationNamespace}-Cancellation!`;
await request("/api/v1/auth/register", {
  method: "POST",
  body: JSON.stringify({
    email: cancellationEmail,
    password: cancellationPassword,
    clientName: `Synthetic Cycle End Cancellation ${cancellationNamespace.slice(0, 8)}`,
    locale: "en",
  }),
}, 201);
await request("/api/v1/auth/login", {
  method: "POST",
  body: JSON.stringify({ email: cancellationEmail, password: cancellationPassword }),
});
const cancellationCookie = cookie;
const cancellationIdentity = await corePool.query<{
  user_id: string;
  client_account_id: string;
}>(
  `SELECT user_account.id AS user_id, membership.client_account_id
   FROM users user_account
   JOIN client_memberships membership ON membership.user_id = user_account.id
   WHERE user_account.email = $1 AND membership.removed_at IS NULL`,
  [cancellationEmail],
);
const cancellationIdentityRow = cancellationIdentity.rows[0];
assert.ok(cancellationIdentityRow);
await corePool.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [
  cancellationIdentityRow.user_id,
]);
await refreshAccountContext(cancellationIdentityRow.client_account_id);
const cancellationOrder = await createOrder(automaticPrice.id, legal);
await pay(cancellationOrder, "success");
const cancellationInitiallyActive = await waitFor(
  "cycle-end cancellation fixture service activation",
  () => request<OrderDetail>(`/api/v1/orders/${cancellationOrder.order.id}`),
  (value) => value.service.status === "active",
);
// Use a deterministic term boundary that cannot share a billing day with the
// earlier real-time renewal fixture when the CI run crosses midnight in
// Asia/Shanghai. A replayed billing day cannot discover a service that did not
// exist during the original run, so this scenario requires a genuinely fresh
// day rather than accepting a 200 replay.
const cancellationTermEnd = new Date(Date.UTC(2039, 10, 20, 1));
await corePool.query(
  `UPDATE services
   SET term_end = $2, updated_at = now(), version = version + 1
   WHERE id = $1`,
  [cancellationInitiallyActive.service.id, cancellationTermEnd],
);
const cancellationActive = await request<OrderDetail>(
  `/api/v1/orders/${cancellationOrder.order.id}`,
);
assert.ok(cancellationActive.service.termEnd);
assert.equal(cancellationActive.service.cancellation, null);
const cancellationKey = randomUUID();
const cancellationBody = {
  expectedVersion: cancellationActive.service.version,
  reason: "Synthetic customer ends service after the paid period",
  idempotencyKey: cancellationKey,
};
const scheduledCancellation = await request<{
  cancellation: {
    requestId: string;
    status: "scheduled";
    executionMode: "automatic" | "manual";
    executionStatus: "scheduled";
    effectiveAt: string;
    requestedAt: string;
  };
  serviceVersion: number;
  replayed: boolean;
}>(`/api/v1/services/${cancellationActive.service.id}/cancellation`, {
  method: "POST",
  body: JSON.stringify(cancellationBody),
}, 201);
assert.equal(scheduledCancellation.replayed, false);
assert.equal(scheduledCancellation.cancellation.status, "scheduled");
assert.equal(scheduledCancellation.cancellation.effectiveAt, cancellationActive.service.termEnd);
assert.equal(scheduledCancellation.serviceVersion, cancellationActive.service.version + 1);
const replayedCancellation = await request<typeof scheduledCancellation>(
  `/api/v1/services/${cancellationActive.service.id}/cancellation`,
  { method: "POST", body: JSON.stringify(cancellationBody) },
);
assert.equal(replayedCancellation.replayed, true);
assert.deepEqual(replayedCancellation.cancellation, scheduledCancellation.cancellation);
assert.equal(replayedCancellation.serviceVersion, scheduledCancellation.serviceVersion);

const scheduledService = await request<OrderDetail>(
  `/api/v1/orders/${cancellationOrder.order.id}`,
);
assert.equal(scheduledService.service.status, "active");
assert.equal(scheduledService.service.termEnd, cancellationActive.service.termEnd);
assert.equal(scheduledService.service.version, cancellationActive.service.version + 1);
assert.deepEqual(scheduledService.service.cancellation, {
  requestId: scheduledCancellation.cancellation.requestId,
  status: "scheduled",
  executionMode: "automatic",
  scheduledAt: scheduledCancellation.cancellation.requestedAt,
  effectiveAt: cancellationActive.service.termEnd,
  result: { status: "scheduled" },
  lastError: null,
  providerOperation: { status: "queued", attempts: 0 },
});

cookie = terminatedCreditCookie;
const crossAccountCancellation = await rawCoreRequest(
  `/api/v1/services/${cancellationActive.service.id}/cancellation`,
  {
    method: "POST",
    body: JSON.stringify({
      expectedVersion: scheduledService.service.version,
      reason: "Synthetic cross-account cancellation must be rejected",
      idempotencyKey: randomUUID(),
    }),
  },
);
assert.equal(crossAccountCancellation.status, 404);
assert.equal(crossAccountCancellation.body.code, "SERVICE_NOT_FOUND");

cookie = cancellationCookie;
const staleCancellation = await rawCoreRequest(
  `/api/v1/services/${cancellationActive.service.id}/cancellation`,
  {
    method: "POST",
    body: JSON.stringify({
      expectedVersion: cancellationActive.service.version,
      reason: "Synthetic stale customer decision cannot overwrite the schedule",
      idempotencyKey: randomUUID(),
    }),
  },
);
assert.equal(staleCancellation.status, 409);
assert.equal(staleCancellation.body.code, "VERSION_CONFLICT");

const cancellationAutomationReference = new Date(
  new Date(cancellationActive.service.termEnd).getTime() - 12 * 24 * 60 * 60 * 1_000,
);
const cancellationBusinessDateParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).formatToParts(cancellationAutomationReference);
const cancellationBusinessDatePart = (type: "year" | "month" | "day") =>
  cancellationBusinessDateParts.find((part) => part.type === type)?.value;
const cancellationBusinessDate = `${cancellationBusinessDatePart("year")}-${cancellationBusinessDatePart("month")}-${cancellationBusinessDatePart("day")}`;
assert.match(cancellationBusinessDate, /^\d{4}-\d{2}-\d{2}$/);
// Scheduled automation is due at 09:00 Asia/Shanghai. Keep this journey
// deterministic when the Provider happened to activate the service overnight.
const cancellationEffectiveAt = new Date(`${cancellationBusinessDate}T01:00:00.000Z`);
const cancellationBillingRun = await runSignedBillingDay({
  businessDate: cancellationBusinessDate,
  effectiveAt: cancellationEffectiveAt.toISOString(),
});
assert.equal(cancellationBillingRun.status, 201);
const cancellationFacts = await corePool.query<{
  requests: string;
  audits: string;
  renewals: string;
  service_status: string;
  service_version: number;
  cancellation_effective_at: Date | null;
}>(
  `SELECT
     (SELECT count(*)::text
      FROM service_cancellation_requests request
      WHERE request.service_id = service.id) AS requests,
     (SELECT count(*)::text
      FROM audit_events audit
      WHERE audit.target_type = 'service'
        AND audit.target_id = service.id::text
        AND audit.action = 'service.cancellation_scheduled') AS audits,
     (SELECT count(*)::text
      FROM service_renewals renewal
      WHERE renewal.service_id = service.id) AS renewals,
     service.status AS service_status,
     service.version AS service_version,
     service.cancellation_effective_at
   FROM services service
   WHERE service.id = $1`,
  [cancellationActive.service.id],
);
assert.deepEqual(cancellationFacts.rows[0], {
  requests: "1",
  audits: "1",
  renewals: "0",
  service_status: "active",
  service_version: scheduledCancellation.serviceVersion,
  cancellation_effective_at: new Date(cancellationActive.service.termEnd),
});
await assert.rejects(
  corePool.query(
    `UPDATE service_cancellation_requests
     SET reason = 'Synthetic mutation must be rejected'
     WHERE id = $1`,
    [scheduledCancellation.cancellation.requestId],
  ),
  /service cancellation requests are immutable/i,
  "database must reject mutation of an accepted cancellation request fact",
);
await assert.rejects(
  corePool.query(
    `UPDATE services
     SET cancellation_effective_at = cancellation_effective_at + interval '1 day',
         term_end = term_end + interval '1 day'
     WHERE id = $1`,
    [cancellationActive.service.id],
  ),
  /accepted cycle-end cancellation schedule is immutable/i,
  "database must reject rewrites of accepted cancellation fields and term_end",
);

type CancellationRenewalFixture = {
  order: OrderDetail;
  service: OrderDetail;
  renewalId: string;
  invoiceId: string;
  totalMinor: string;
  periodStart: Date;
  periodEnd: Date;
};
let cancellationRenewalFixtureSequence = 0;
async function createCancellationRenewalFixture(
  label: string,
): Promise<CancellationRenewalFixture> {
  cookie = cancellationCookie;
  const order = await createOrder(automaticPrice!.id, legal);
  await pay(order, "success", 60_000);
  const active = await waitFor(
    `${label} service activation`,
    () => request<OrderDetail>(`/api/v1/orders/${order.order.id}`),
    (value) => value.service.status === "active",
  );
  cancellationRenewalFixtureSequence += 1;
  const termEnd = new Date(Date.UTC(2040, cancellationRenewalFixtureSequence * 2, 20, 1));
  await corePool.query(
    `UPDATE services
     SET term_end = $2, updated_at = now(), version = version + 1
     WHERE id = $1`,
    [active.service.id, termEnd],
  );
  const service = await request<OrderDetail>(`/api/v1/orders/${order.order.id}`);
  const effectiveAt = new Date(termEnd.getTime() - 12 * 24 * 60 * 60 * 1_000);
  const billingRun = await runSignedBillingDay({
    businessDate: effectiveAt.toISOString().slice(0, 10),
    effectiveAt: effectiveAt.toISOString(),
  });
  assert.equal(billingRun.status, 201, `${label} must create a fresh billing run`);
  const renewal = await corePool.query<{
    renewal_id: string;
    invoice_id: string;
    total_minor: string;
    period_start: Date;
    period_end: Date;
  }>(
    `SELECT renewal.id AS renewal_id,
            renewal.invoice_id,
            invoice.total_minor::text,
            renewal.period_start,
            renewal.period_end
     FROM service_renewals renewal
     JOIN invoices invoice ON invoice.id = renewal.invoice_id
     WHERE renewal.service_id = $1 AND renewal.status = 'invoiced'`,
    [service.service.id],
  );
  const row = renewal.rows[0];
  assert.ok(row, `${label} must create an unsettled renewal`);
  assert.equal(row.period_start.toISOString(), termEnd.toISOString());
  return {
    order,
    service,
    renewalId: row.renewal_id,
    invoiceId: row.invoice_id,
    totalMinor: row.total_minor,
    periodStart: row.period_start,
    periodEnd: row.period_end,
  };
}

async function scheduleFixtureCancellation(
  fixture: CancellationRenewalFixture,
  reason: string,
  idempotencyKey = randomUUID(),
) {
  cookie = cancellationCookie;
  const current = await request<OrderDetail>(`/api/v1/orders/${fixture.order.order.id}`);
  const body = {
    expectedVersion: current.service.version,
    reason,
    idempotencyKey,
  };
  const result = await request<{
    cancellation: { requestId: string; status: "scheduled" };
    serviceVersion: number;
    replayed: boolean;
  }>(
    `/api/v1/services/${fixture.service.service.id}/cancellation`,
    { method: "POST", body: JSON.stringify(body) },
    201,
  );
  return { body, result };
}

// A generated, completely pristine renewal is withdrawn without deleting its
// issuance. The collectible API due becomes zero and a separate balanced
// reversal journal records the accounting effect exactly once.
const pristineCancellationRenewal = await createCancellationRenewalFixture(
  "pristine generated renewal cancellation",
);
const pristineOldQuote = await createPaymentQuote(
  pristineCancellationRenewal.invoiceId,
  "usdt",
  false,
);
const pristineSchedule = await scheduleFixtureCancellation(
  pristineCancellationRenewal,
  "Synthetic customer withdraws a pristine generated renewal at cycle end",
);
assert.equal(pristineSchedule.result.replayed, false);
const pristineReplay = await request<typeof pristineSchedule.result>(
  `/api/v1/services/${pristineCancellationRenewal.service.service.id}/cancellation`,
  { method: "POST", body: JSON.stringify(pristineSchedule.body) },
  200,
);
assert.equal(pristineReplay.replayed, true);
assert.equal(
  pristineReplay.cancellation.requestId,
  pristineSchedule.result.cancellation.requestId,
);
const customerRenewalsAfterCancellation = await request<{
  items: Array<{
    renewalId: string;
    invoiceId: string;
    totalMinor: string;
    dueMinor: string;
    status: string;
    fundingStatus: string;
    renewalStatus: string;
  }>;
}>("/api/v1/billing/renewals");
const cancelledCustomerRenewal = customerRenewalsAfterCancellation.items.find(
  (item) => item.renewalId === pristineCancellationRenewal.renewalId,
);
assert.ok(cancelledCustomerRenewal);
assert.equal(cancelledCustomerRenewal.invoiceId, pristineCancellationRenewal.invoiceId);
assert.equal(cancelledCustomerRenewal.totalMinor, pristineCancellationRenewal.totalMinor);
assert.equal(cancelledCustomerRenewal.dueMinor, "0");
assert.equal(cancelledCustomerRenewal.status, "cancelled");
assert.equal(cancelledCustomerRenewal.fundingStatus, "cancelled");
assert.equal(cancelledCustomerRenewal.renewalStatus, "cancelled");
const pristineCancellationFacts = await corePool.query<{
  renewal_status: string;
  invoice_total_minor: string;
  cancellation_facts: string;
  reversal_journals: string;
  reversal_lines: string;
  debit_minor: string;
  credit_minor: string;
  deferred_revenue_debit_minor: string;
  receivable_credit_minor: string;
}>(
  `SELECT renewal.status AS renewal_status,
          invoice.total_minor::text AS invoice_total_minor,
          (SELECT count(*)::text
           FROM service_renewal_cancellations cancellation
           WHERE cancellation.renewal_id = renewal.id) AS cancellation_facts,
          (SELECT count(*)::text
           FROM ledger_journals journal
           WHERE journal.source_type = 'service_renewal_cancellation'
             AND journal.source_id IN (
               SELECT cancellation.id
               FROM service_renewal_cancellations cancellation
               WHERE cancellation.renewal_id = renewal.id
             )) AS reversal_journals,
          (SELECT count(*)::text
           FROM ledger_lines line
           JOIN ledger_journals journal ON journal.id = line.journal_id
           WHERE journal.source_type = 'service_renewal_cancellation'
             AND journal.source_id IN (
               SELECT cancellation.id
               FROM service_renewal_cancellations cancellation
               WHERE cancellation.renewal_id = renewal.id
             )) AS reversal_lines,
          COALESCE((SELECT sum(line.debit_minor)::text
           FROM ledger_lines line
           JOIN ledger_journals journal ON journal.id = line.journal_id
           WHERE journal.source_type = 'service_renewal_cancellation'
             AND journal.source_id IN (
               SELECT cancellation.id FROM service_renewal_cancellations cancellation
               WHERE cancellation.renewal_id = renewal.id
             )), '0') AS debit_minor,
          COALESCE((SELECT sum(line.credit_minor)::text
           FROM ledger_lines line
           JOIN ledger_journals journal ON journal.id = line.journal_id
           WHERE journal.source_type = 'service_renewal_cancellation'
             AND journal.source_id IN (
               SELECT cancellation.id FROM service_renewal_cancellations cancellation
               WHERE cancellation.renewal_id = renewal.id
             )), '0') AS credit_minor,
          COALESCE((SELECT sum(line.debit_minor)::text
           FROM ledger_lines line
           JOIN ledger_journals journal ON journal.id = line.journal_id
           WHERE journal.source_type = 'service_renewal_cancellation'
             AND journal.source_id IN (
               SELECT cancellation.id FROM service_renewal_cancellations cancellation
               WHERE cancellation.renewal_id = renewal.id
             ) AND line.account_code = 'deferred_service_revenue'), '0')
            AS deferred_revenue_debit_minor,
          COALESCE((SELECT sum(line.credit_minor)::text
           FROM ledger_lines line
           JOIN ledger_journals journal ON journal.id = line.journal_id
           WHERE journal.source_type = 'service_renewal_cancellation'
             AND journal.source_id IN (
               SELECT cancellation.id FROM service_renewal_cancellations cancellation
               WHERE cancellation.renewal_id = renewal.id
             ) AND line.account_code = 'accounts_receivable'), '0')
            AS receivable_credit_minor
   FROM service_renewals renewal
   JOIN invoices invoice ON invoice.id = renewal.invoice_id
   WHERE renewal.id = $1`,
  [pristineCancellationRenewal.renewalId],
);
assert.deepEqual(pristineCancellationFacts.rows[0], {
  renewal_status: "cancelled",
  invoice_total_minor: pristineCancellationRenewal.totalMinor,
  cancellation_facts: "1",
  reversal_journals: "1",
  reversal_lines: "2",
  debit_minor: pristineCancellationRenewal.totalMinor,
  credit_minor: pristineCancellationRenewal.totalMinor,
  deferred_revenue_debit_minor: pristineCancellationRenewal.totalMinor,
  receivable_credit_minor: pristineCancellationRenewal.totalMinor,
});
const obsoleteRenewalQuote = await rawCoreRequest(
  `/api/v1/invoices/${pristineCancellationRenewal.invoiceId}/payments`,
  {
    method: "POST",
    body: JSON.stringify({
      quoteId: pristineOldQuote.quoteId,
      scenario: "success",
      idempotencyKey: randomUUID(),
    }),
  },
);
assert.equal(obsoleteRenewalQuote.status, 409);
assert.equal(obsoleteRenewalQuote.body.code, "INVOICE_CANCELLED");

// A cancelled renewal keeps its historical invoice total, but it is no longer
// an accounts receivable. Both partial and full staff allocation attempts must
// leave the unclaimed receipt and every accounting fact unchanged.
const cancelledAllocationProvider = await corePool.query<{
  provider_installation_id: string;
}>(
  `SELECT provider_installation_id
   FROM payment_attempts
   WHERE client_account_id = $1
   ORDER BY created_at
   LIMIT 1`,
  [cancellationIdentityRow.client_account_id],
);
const cancelledAllocationProviderId =
  cancelledAllocationProvider.rows[0]?.provider_installation_id;
assert.ok(cancelledAllocationProviderId);
const cancelledAllocationAttemptId = randomUUID();
const cancelledAllocationReceiptId = randomUUID();
const cancelledAllocationExternalId = `mock-cancelled-renewal-allocation-${randomUUID()}`;
await corePool.query(
  `INSERT INTO payment_attempts(
     id, client_account_id, invoice_id, provider_installation_id,
     external_payment_id, status, amount_minor, currency, scenario,
     idempotency_key, request_fingerprint, provider_occurred_at
   ) VALUES ($1, $2, $3, $4, $5, 'succeeded', $6, 'USD', 'success', $7, $8, now())`,
  [
    cancelledAllocationAttemptId,
    cancellationIdentityRow.client_account_id,
    cancellationOrder.invoice.id,
    cancelledAllocationProviderId,
    cancelledAllocationExternalId,
    pristineCancellationRenewal.totalMinor,
    `cancelled-renewal-allocation-attempt:${randomUUID()}`,
    `cancelled-renewal-allocation-fingerprint:${randomUUID()}`,
  ],
);
await corePool.query(
  `INSERT INTO fund_receipts(
     id, provider_installation_id, external_payment_id,
     reported_payment_attempt_id, client_account_id, amount_minor,
     allocated_minor, currency, occurred_at, disposition, reason
   ) VALUES ($1, $2, $3, $4, $5, $6, 0, 'USD', now(), 'unclaimed', $7)`,
  [
    cancelledAllocationReceiptId,
    cancelledAllocationProviderId,
    cancelledAllocationExternalId,
    cancelledAllocationAttemptId,
    cancellationIdentityRow.client_account_id,
    pristineCancellationRenewal.totalMinor,
    "Synthetic unclaimed receipt must not reopen a cancelled renewal receivable",
  ],
);
async function cancelledAllocationSnapshot() {
  const snapshot = await corePool.query<{
    allocated_minor: string;
    disposition: string;
    resolutions: string;
    allocations: string;
    journals: string;
  }>(
    `SELECT receipt.allocated_minor::text,
            receipt.disposition,
            (SELECT count(*)::text FROM fund_receipt_resolutions resolution
             WHERE resolution.fund_receipt_id = receipt.id) AS resolutions,
            (SELECT count(*)::text FROM fund_receipt_allocations allocation
             WHERE allocation.fund_receipt_id = receipt.id) AS allocations,
            (SELECT count(*)::text
             FROM ledger_journals journal
             WHERE journal.source_type = 'fund_receipt_resolution'
               AND journal.source_id IN (
                 SELECT resolution.id FROM fund_receipt_resolutions resolution
                 WHERE resolution.fund_receipt_id = receipt.id
               )) AS journals
     FROM fund_receipts receipt
     WHERE receipt.id = $1`,
    [cancelledAllocationReceiptId],
  );
  assert.ok(snapshot.rows[0]);
  return snapshot.rows[0];
}
const cancelledAllocationBefore = await cancelledAllocationSnapshot();
cookie = staffCookie;
await request(
  "/api/v1/auth/reauth",
  { method: "POST", body: JSON.stringify({ password }) },
  200,
);
for (const amountMinor of ["1", pristineCancellationRenewal.totalMinor]) {
  const rejectedAllocation = await rawCoreRequest(
    `/api/v1/admin/funds/${cancelledAllocationReceiptId}/resolutions`,
    {
      method: "POST",
      body: JSON.stringify({
        action: "allocate_invoice",
        amountMinor,
        invoiceId: pristineCancellationRenewal.invoiceId,
        reason: "Synthetic cancelled renewal must reject this fund allocation",
        idempotencyKey: randomUUID(),
      }),
    },
  );
  assert.equal(rejectedAllocation.status, 409);
  assert.equal(rejectedAllocation.body.code, "INVOICE_CANCELLED");
  assert.deepEqual(await cancelledAllocationSnapshot(), cancelledAllocationBefore);
}

// The PostgreSQL boundary independently rejects a valid-looking immutable
// resolution if a future path tries to attach its funds to the cancelled
// renewal without going through the API eligibility check.
const cancelledGuardClient = await corePool.connect();
try {
  await cancelledGuardClient.query("BEGIN");
  const resolutionId = randomUUID();
  await cancelledGuardClient.query(
    `INSERT INTO fund_receipt_resolutions(
       id, fund_receipt_id, client_account_id, action, amount_minor,
       currency, invoice_id, actor_id, reason, idempotency_key,
       request_fingerprint, result
     ) VALUES ($1, $2, $3, 'allocate_invoice', 1, 'USD', $4, $5, $6, $7, $8, $9)`,
    [
      resolutionId,
      cancelledAllocationReceiptId,
      cancellationIdentityRow.client_account_id,
      pristineCancellationRenewal.invoiceId,
      staffMe.id,
      "Synthetic database guard for a cancelled renewal allocation",
      `cancelled-renewal-resolution:${randomUUID()}`,
      `cancelled-renewal-resolution-fingerprint:${randomUUID()}`,
      { status: "synthetic_guard" },
    ],
  );
  await assert.rejects(
    cancelledGuardClient.query(
      `INSERT INTO fund_receipt_allocations(
         resolution_id, fund_receipt_id, invoice_id, amount_minor
       ) VALUES ($1, $2, $3, 1)`,
      [resolutionId, cancelledAllocationReceiptId, pristineCancellationRenewal.invoiceId],
    ),
    /cancelled renewal invoices cannot receive allocations/i,
  );
} finally {
  await cancelledGuardClient.query("ROLLBACK").catch(() => undefined);
  cancelledGuardClient.release();
}
cookie = cancellationCookie;

async function cancellationFinancialSnapshot(fixture: CancellationRenewalFixture) {
  const result = await corePool.query<{
    requests: string;
    renewal_cancellations: string;
    renewal_status: string;
    invoice_total_minor: string;
    payment_attempts: string;
    payment_allocated_minor: string;
    credit_allocated_minor: string;
    fund_allocated_minor: string;
    invoice_journals: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM service_cancellation_requests
        WHERE service_id = $1) AS requests,
       (SELECT count(*)::text FROM service_renewal_cancellations
        WHERE renewal_id = $2) AS renewal_cancellations,
       (SELECT status FROM service_renewals WHERE id = $2) AS renewal_status,
       (SELECT total_minor::text FROM invoices WHERE id = $3) AS invoice_total_minor,
       (SELECT count(*)::text FROM payment_attempts WHERE invoice_id = $3)
         AS payment_attempts,
       COALESCE((SELECT sum(amount_minor)::text FROM payment_allocations
                 WHERE invoice_id = $3), '0') AS payment_allocated_minor,
       COALESCE((SELECT sum(amount_minor)::text FROM credit_allocations
                 WHERE invoice_id = $3), '0') AS credit_allocated_minor,
       COALESCE((SELECT sum(amount_minor)::text FROM fund_receipt_allocations
                 WHERE invoice_id = $3), '0') AS fund_allocated_minor,
       (SELECT count(*)::text FROM ledger_journals journal
        WHERE (journal.source_type = 'invoice_issuance' AND journal.source_id = $3)
           OR (journal.source_type = 'service_renewal_cancellation'
               AND journal.source_id IN (
                 SELECT cancellation.id FROM service_renewal_cancellations cancellation
                 WHERE cancellation.renewal_id = $2
               ))) AS invoice_journals`,
    [fixture.service.service.id, fixture.renewalId, fixture.invoiceId],
  );
  assert.ok(result.rows[0]);
  return result.rows[0];
}

async function assertCancellationRejectedWithoutFinancialMutation(
  fixture: CancellationRenewalFixture,
  expectedCode: string,
  reason: string,
): Promise<void> {
  cookie = cancellationCookie;
  const current = await request<OrderDetail>(`/api/v1/orders/${fixture.order.order.id}`);
  const before = await cancellationFinancialSnapshot(fixture);
  const rejected = await rawCoreRequest(
    `/api/v1/services/${fixture.service.service.id}/cancellation`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: current.service.version,
        reason,
        idempotencyKey: randomUUID(),
      }),
    },
  );
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, expectedCode);
  assert.deepEqual(await cancellationFinancialSnapshot(fixture), before);
}

const unresolvedCancellationRenewal = await createCancellationRenewalFixture(
  "unresolved renewal payment cancellation rejection",
);
await installPaymentStartDelay();
try {
  const unresolvedQuote = await createPaymentQuote(
    unresolvedCancellationRenewal.invoiceId,
    "usdt",
    false,
  );
  const unresolvedCommand = await request<PaymentCommand>(
    `/api/v1/invoices/${unresolvedCancellationRenewal.invoiceId}/payments`,
    {
      method: "POST",
      body: JSON.stringify({
        quoteId: unresolvedQuote.quoteId,
        scenario: "success",
        idempotencyKey: randomUUID(),
      }),
    },
    202,
  );
  assert.ok(unresolvedCommand.paymentAttemptId);
  const unresolvedAttempt = await corePool.query<{ status: string }>(
    "SELECT status FROM payment_attempts WHERE id = $1",
    [unresolvedCommand.paymentAttemptId],
  );
  assert.equal(unresolvedAttempt.rows[0]?.status, "created");
  await assertCancellationRejectedWithoutFinancialMutation(
    unresolvedCancellationRenewal,
    "PAYMENT_RESULT_UNKNOWN",
    "Synthetic unresolved Provider payment must be reconciled before cancellation",
  );
} finally {
  await dropPaymentStartDelay();
}

const failedCancellationRenewal = await createCancellationRenewalFixture(
  "failed renewal payment cancellation rejection",
);
const failedRenewalQuote = await createPaymentQuote(
  failedCancellationRenewal.invoiceId,
  "usdt",
  false,
);
const failedRenewalCommand = await request<PaymentCommand>(
  `/api/v1/invoices/${failedCancellationRenewal.invoiceId}/payments`,
  {
    method: "POST",
    body: JSON.stringify({
      quoteId: failedRenewalQuote.quoteId,
      scenario: "failed",
      idempotencyKey: randomUUID(),
    }),
  },
  202,
);
await waitFor(
  "failed renewal payment history",
  () => readPaymentRecords(failedRenewalCommand.commandId),
  (records) => records.attempt_status === "failed",
);
await assertCancellationRejectedWithoutFinancialMutation(
  failedCancellationRenewal,
  "RENEWAL_PAYMENT_HISTORY_REQUIRES_REVIEW",
  "Synthetic failed renewal payment history requires explicit staff review",
);

const allocatedCancellationRenewal = await createCancellationRenewalFixture(
  "allocated renewal cancellation rejection",
);
const syntheticReceiptAttemptId = randomUUID();
const syntheticReceiptId = randomUUID();
const syntheticReceiptExternalId = `mock-cancellation-allocation-${randomUUID()}`;
const syntheticPaymentProvider = await corePool.query<{ provider_installation_id: string }>(
  `SELECT provider_installation_id
   FROM payment_attempts
   WHERE client_account_id = $1
   ORDER BY created_at
   LIMIT 1`,
  [cancellationIdentityRow.client_account_id],
);
assert.ok(syntheticPaymentProvider.rows[0]);
await corePool.query(
  `INSERT INTO payment_attempts(
     id, client_account_id, invoice_id, provider_installation_id,
     external_payment_id, status, amount_minor, currency, scenario,
     idempotency_key, request_fingerprint, provider_occurred_at
   ) VALUES ($1, $2, $3, $4, $5, 'succeeded', 2, 'USD', 'success', $6, $7, now())`,
  [
    syntheticReceiptAttemptId,
    cancellationIdentityRow.client_account_id,
    cancellationOrder.invoice.id,
    syntheticPaymentProvider.rows[0].provider_installation_id,
    syntheticReceiptExternalId,
    `synthetic-allocation-attempt:${randomUUID()}`,
    `synthetic-allocation-fingerprint:${randomUUID()}`,
  ],
);
await corePool.query(
  `INSERT INTO fund_receipts(
     id, provider_installation_id, external_payment_id,
     reported_payment_attempt_id, client_account_id, amount_minor,
     allocated_minor, currency, occurred_at, disposition, reason
   ) VALUES ($1, $2, $3, $4, $5, 2, 0, 'USD', now(), 'unclaimed', $6)`,
  [
    syntheticReceiptId,
    syntheticPaymentProvider.rows[0].provider_installation_id,
    syntheticReceiptExternalId,
    syntheticReceiptAttemptId,
    cancellationIdentityRow.client_account_id,
    "Synthetic unmatched receipt for cancellation allocation guard",
  ],
);
cookie = staffCookie;
await request(
  "/api/v1/auth/reauth",
  { method: "POST", body: JSON.stringify({ password }) },
  200,
);
await request(
  `/api/v1/admin/funds/${syntheticReceiptId}/resolutions`,
  {
    method: "POST",
    body: JSON.stringify({
      action: "allocate_invoice",
      amountMinor: "1",
      invoiceId: allocatedCancellationRenewal.invoiceId,
      reason: "Synthetic partial allocation must prevent silent renewal withdrawal",
      idempotencyKey: randomUUID(),
    }),
  },
  201,
);
await assertCancellationRejectedWithoutFinancialMutation(
  allocatedCancellationRenewal,
  "RENEWAL_FINANCIAL_FACTS_REQUIRE_REVIEW",
  "Synthetic allocated renewal funds require explicit staff review",
);

const heldCancellationRenewal = await createCancellationRenewalFixture(
  "manual hold renewal cancellation rejection",
);
const heldRenewalQuote = await createPaymentQuote(
  heldCancellationRenewal.invoiceId,
  "usdt",
  false,
);
await corePool.query(
  `UPDATE services
   SET term_end = term_end + interval '1 day', updated_at = now(), version = version + 1
   WHERE id = $1`,
  [heldCancellationRenewal.service.service.id],
);
const heldRenewalCommand = await request<PaymentCommand>(
  `/api/v1/invoices/${heldCancellationRenewal.invoiceId}/payments`,
  {
    method: "POST",
    body: JSON.stringify({
      quoteId: heldRenewalQuote.quoteId,
      scenario: "success",
      idempotencyKey: randomUUID(),
    }),
  },
  202,
);
assert.ok(heldRenewalCommand.paymentAttemptId);
await waitFor(
  "renewal payment to enter manual hold after a term conflict",
  async () => {
    const result = await corePool.query<{ status: string }>(
      "SELECT status FROM service_renewals WHERE id = $1",
      [heldCancellationRenewal.renewalId],
    );
    return result.rows[0]?.status ?? "missing";
  },
  (status) => status === "manual_hold",
  30_000,
);
await corePool.query(
  `UPDATE services
   SET term_end = $2, updated_at = now(), version = version + 1
   WHERE id = $1`,
  [heldCancellationRenewal.service.service.id, heldCancellationRenewal.periodStart],
);
await assertCancellationRejectedWithoutFinancialMutation(
  heldCancellationRenewal,
  "RENEWAL_HOLD_REQUIRES_STAFF",
  "Synthetic funded renewal hold cannot be withdrawn by customer cancellation",
);

const delinquentCancellationRenewal = await createCancellationRenewalFixture(
  "delinquent renewal cancellation rejection",
);
const delinquencyEffectiveAt = new Date(
  delinquentCancellationRenewal.periodStart.getTime() + 5 * 24 * 60 * 60 * 1_000,
);
const delinquencyRun = await runSignedBillingDay({
  businessDate: delinquencyEffectiveAt.toISOString().slice(0, 10),
  effectiveAt: delinquencyEffectiveAt.toISOString(),
});
assert.equal(delinquencyRun.status, 201);
const delinquencyFact = await corePool.query<{ count: string }>(
  `SELECT count(*)::text AS count
   FROM invoice_late_fee_assessments
   WHERE invoice_id = $1`,
  [delinquentCancellationRenewal.invoiceId],
);
assert.equal(delinquencyFact.rows[0]?.count, "1");
await assertCancellationRejectedWithoutFinancialMutation(
  delinquentCancellationRenewal,
  "RENEWAL_DELINQUENCY_REQUIRES_REVIEW",
  "Synthetic renewal delinquency actions require explicit staff review",
);

async function createCancellationPolicyFixture(input: {
  productId: "equinix-hk2-colocation" | "remote-hands";
  productName: string;
  fulfillmentMode: "quote" | "manual";
  billingCycle: "monthly" | "one_time";
  recurringMinor: bigint;
  withBinding: boolean;
}): Promise<string> {
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const serviceId = randomUUID();
  const snapshot = {
    productId: input.productId,
    productName: input.productName,
    fulfillmentMode: input.fulfillmentMode,
    billingCycle: input.billingCycle,
    components:
      input.recurringMinor > 0n
        ? [
            {
              code: "synthetic-configured-recurring-service",
              label: `${input.productName} configured recurring service`,
              quantity: 1,
              oneTimeMinor: "0",
              recurringMinor: input.recurringMinor.toString(),
            },
          ]
        : [],
    oneTimeSubtotalMinor: "0",
    setupMinor: "0",
    recurringSubtotalMinor: input.recurringMinor.toString(),
    invoiceTotalMinor: input.recurringMinor.toString(),
  };
  const client = await corePool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO orders(
         id, client_account_id, submitted_by_user_id, status, currency,
         price_snapshot, one_time_minor, setup_minor, recurring_minor,
         total_minor, idempotency_key, request_fingerprint
       ) VALUES ($1, $2, $3, 'completed', 'USD', $4, 0, 0, $5, $5, $6, $7)`,
      [
        orderId,
        cancellationIdentityRow!.client_account_id,
        cancellationIdentityRow!.user_id,
        snapshot,
        input.recurringMinor.toString(),
        `synthetic-policy-order:${randomUUID()}`,
        `synthetic-policy-order-fingerprint:${randomUUID()}`,
      ],
    );
    await client.query(
      `INSERT INTO order_items(
         id, order_id, product_id, product_name, fulfillment_mode,
         billing_cycle, configuration, price_snapshot
       ) VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7)`,
      [
        orderItemId,
        orderId,
        input.productId,
        input.productName,
        input.fulfillmentMode,
        input.billingCycle,
        snapshot,
      ],
    );
    await client.query(
      `INSERT INTO services(
         id, client_account_id, order_item_id, status, billing_cycle,
         activated_at, term_start, term_end, external_resource_id
       ) VALUES ($1, $2, $3, 'active', $4, now(), now(),
                 CASE WHEN $4 = 'one_time' THEN NULL ELSE now() + interval '60 days' END,
                 $5)`,
      [
        serviceId,
        cancellationIdentityRow!.client_account_id,
        orderItemId,
        input.billingCycle,
        `synthetic-policy-resource-${randomUUID()}`,
      ],
    );
    if (input.withBinding) {
      const binding = await client.query(
        `INSERT INTO service_provider_bindings(
           service_id, provider_installation_id, overdue_action_snapshot,
           capability_snapshot, product_policy_version,
           cycle_end_cancellation_mode_snapshot,
           cycle_end_cancellation_execution_mode_snapshot,
           cycle_end_cancellation_min_notice_hours_snapshot,
           cycle_end_cancellation_requirement_key_snapshot
         )
         SELECT $1, policy.provider_installation_id, policy.overdue_action,
                COALESCE(provider.capabilities, '[]'::jsonb), policy.version,
                policy.cycle_end_cancellation_mode,
                policy.cycle_end_cancellation_execution_mode,
                policy.cycle_end_cancellation_min_notice_hours,
                policy.cycle_end_cancellation_requirement_key
         FROM product_service_automation_policies policy
         LEFT JOIN provider_installation_capabilities provider
           ON provider.provider_installation_id = policy.provider_installation_id
         WHERE policy.product_id = $2
         RETURNING service_id`,
        [serviceId, input.productId],
      );
      assert.equal(binding.rowCount, 1);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return serviceId;
}

cookie = cancellationCookie;
const colocationCancellationServiceId = await createCancellationPolicyFixture({
  productId: "equinix-hk2-colocation",
  productName: "Synthetic authenticated-ticket Colocation",
  fulfillmentMode: "quote",
  billingCycle: "monthly",
  recurringMinor: 25_000n,
  withBinding: true,
});
const colocationCancellationAttempt = await rawCoreRequest(
  `/api/v1/services/${colocationCancellationServiceId}/cancellation`,
  {
    method: "POST",
    body: JSON.stringify({
      expectedVersion: 1,
      reason: "Synthetic Colocation has no authenticated termination ticket",
      idempotencyKey: randomUUID(),
    }),
  },
);
assert.equal(colocationCancellationAttempt.status, 409);
assert.equal(
  colocationCancellationAttempt.body.code,
  "CANCELLATION_TICKET_GATE_UNAVAILABLE",
);
const colocationScheduleFacts = await corePool.query<{
  requests: string;
  cancellation_request_id: string | null;
}>(
  `SELECT
     (SELECT count(*)::text FROM service_cancellation_requests WHERE service_id = service.id)
       AS requests,
     service.cancellation_request_id
   FROM services service WHERE service.id = $1`,
  [colocationCancellationServiceId],
);
assert.deepEqual(colocationScheduleFacts.rows[0], {
  requests: "0",
  cancellation_request_id: null,
});

const remoteHandsCancellationServiceId = await createCancellationPolicyFixture({
  productId: "remote-hands",
  productName: "Synthetic one-time Remote Hands",
  fulfillmentMode: "manual",
  billingCycle: "one_time",
  recurringMinor: 0n,
  withBinding: false,
});
const remoteHandsPolicy = await corePool.query<{
  cancellation_mode: string;
  billing_cycle: string;
}>(
  `SELECT policy.cycle_end_cancellation_mode AS cancellation_mode,
          service.billing_cycle
   FROM services service
   JOIN order_items item ON item.id = service.order_item_id
   JOIN product_service_automation_policies policy ON policy.product_id = item.product_id
   WHERE service.id = $1`,
  [remoteHandsCancellationServiceId],
);
assert.deepEqual(remoteHandsPolicy.rows[0], {
  cancellation_mode: "disabled",
  billing_cycle: "one_time",
});
const remoteHandsCancellationAttempt = await rawCoreRequest(
  `/api/v1/services/${remoteHandsCancellationServiceId}/cancellation`,
  {
    method: "POST",
    body: JSON.stringify({
      expectedVersion: 1,
      reason: "Synthetic one-time Remote Hands has no recurring cycle to cancel",
      idempotencyKey: randomUUID(),
    }),
  },
);
assert.equal(remoteHandsCancellationAttempt.status, 409);
assert.equal(remoteHandsCancellationAttempt.body.code, "CANCELLATION_NOT_ALLOWED");
const remoteHandsScheduleFacts = await corePool.query<{ requests: string }>(
  "SELECT count(*)::text AS requests FROM service_cancellation_requests WHERE service_id = $1",
  [remoteHandsCancellationServiceId],
);
assert.equal(remoteHandsScheduleFacts.rows[0]?.requests, "0");

// A scheduled automatic cancellation reaches the paid-through instant. The
// Mock Provider commits the termination but times out the one and only POST;
// Worker recovery must use GET-only reconciliation before Core marks the
// service terminated.
cookie = cancellationCookie;
const mixedCancellationPolicy = await corePool.query<{ version: number }>(
  `UPDATE product_service_automation_policies policy
   SET overdue_action = 'manual', version = policy.version + 1, updated_at = now()
   WHERE policy.product_id = (
     SELECT price.product_id
     FROM product_prices price
     WHERE price.id = $1
   )
   RETURNING version`,
  [automaticPrice.id],
);
assert.ok(mixedCancellationPolicy.rows[0]?.version);
const dueCancellationOrder = await createOrder(automaticPrice.id, legal);
await pay(dueCancellationOrder, "success");
const dueCancellationActive = await waitFor(
  "automatic cancellation due fixture activation",
  () => request<OrderDetail>(`/api/v1/orders/${dueCancellationOrder.order.id}`),
  (value) => value.service.status === "active",
);
const mixedCancellationBinding = await corePool.query<{
  overdue_action_snapshot: string;
  cancellation_execution_mode: string;
}>(
  `SELECT overdue_action_snapshot,
          cycle_end_cancellation_execution_mode_snapshot AS cancellation_execution_mode
   FROM service_provider_bindings
   WHERE service_id = $1`,
  [dueCancellationActive.service.id],
);
assert.deepEqual(mixedCancellationBinding.rows[0], {
  overdue_action_snapshot: "manual",
  cancellation_execution_mode: "automatic",
});
const dueCancellationVersion = await corePool.query<{ version: number }>(
  `UPDATE services
   SET term_end = now() + interval '60 seconds', updated_at = now(), version = version + 1
   WHERE id = $1
   RETURNING version`,
  [dueCancellationActive.service.id],
);
const dueCancellationExpectedVersion = dueCancellationVersion.rows[0]?.version;
assert.ok(dueCancellationExpectedVersion);
const dueCancellationScheduled = await request<{
  cancellation: {
    requestId: string;
    status: "scheduled";
    executionMode: "automatic";
    executionStatus: "scheduled";
  };
  serviceVersion: number;
}>(`/api/v1/services/${dueCancellationActive.service.id}/cancellation`, {
  method: "POST",
  body: JSON.stringify({
    expectedVersion: dueCancellationExpectedVersion,
    reason: "Synthetic timeout-success cycle-end termination",
    idempotencyKey: randomUUID(),
  }),
}, 201);
assert.equal(dueCancellationScheduled.cancellation.executionMode, "automatic");
await assert.rejects(
  corePool.query(
    `UPDATE services
     SET status = 'terminated', updated_at = now(), version = version + 1
     WHERE id = $1`,
    [dueCancellationActive.service.id],
  ),
  /confirmed Provider success/i,
  "automatic cancellation cannot mark a service terminated before Provider success",
);
await corePool.query(
  `UPDATE durable_jobs
   SET payload = payload || '{"scenario":"timeout_success"}'::jsonb
   WHERE job_type = 'service.cancellation.due'
     AND unique_key = $1
     AND status = 'pending'`,
  [`service-cancellation:${dueCancellationScheduled.cancellation.requestId}:terminate`],
);
const dueCancellationTerminated = await waitFor(
  "timeout-success cancellation to reconcile and terminate",
  () => request<OrderDetail>(`/api/v1/orders/${dueCancellationOrder.order.id}`),
  (value) =>
    value.service.status === "terminated" &&
    value.service.cancellation?.status === "terminated",
  120_000,
);
assert.equal(dueCancellationTerminated.service.cancellation?.executionMode, "automatic");
assert.equal(dueCancellationTerminated.service.cancellation?.providerOperation?.attempts, 1);
const dueCancellationFacts = await corePool.query<{
  execution_status: string;
  service_status: string;
  operation_status: string;
  attempt_count: number;
  due_job_status: string;
  reconcile_job_status: string | null;
  request_term_exact: boolean;
  job_effective_exact: boolean;
}>(
  `SELECT execution.status AS execution_status,
          service.status AS service_status,
          operation.status AS operation_status,
          operation.attempt_count,
          due_job.status AS due_job_status,
          reconcile_job.status AS reconcile_job_status,
          cancellation_request.effective_at = service.term_end AS request_term_exact,
          due_job.available_at = cancellation_request.effective_at AS job_effective_exact
   FROM service_cancellation_requests cancellation_request
   JOIN service_cancellation_executions execution
     ON execution.cancellation_request_id = cancellation_request.id
   JOIN services service ON service.id = execution.service_id
   JOIN provider_operations operation
     ON operation.subject_type = 'service_cancellation_execution'
    AND operation.subject_id = execution.id
    AND operation.kind = 'resource_terminate'
   JOIN durable_jobs due_job
     ON due_job.job_type = 'service.cancellation.due'
    AND due_job.unique_key = operation.stable_key
   LEFT JOIN durable_jobs reconcile_job
     ON reconcile_job.job_type = 'service.cancellation.reconcile'
    AND reconcile_job.unique_key = operation.stable_key
   WHERE cancellation_request.id = $1`,
  [dueCancellationScheduled.cancellation.requestId],
);
assert.deepEqual(dueCancellationFacts.rows[0], {
  execution_status: "terminated",
  service_status: "terminated",
  operation_status: "succeeded",
  attempt_count: 1,
  due_job_status: "completed",
  reconcile_job_status: "completed",
  request_term_exact: true,
  job_effective_exact: true,
});
const dueProviderFacts = await providerPool.query<{
  action: string;
  status: string;
  action_calls: number;
  query_calls: number;
}>(
  `SELECT provider_action.action, provider_action.status,
          provider_action.action_calls, provider_action.query_calls
   FROM mock_resource_action_operations provider_action
   JOIN mock_resource_operations resource
     ON resource.service_id = provider_action.service_id
    AND resource.external_resource_id = provider_action.external_resource_id
   WHERE provider_action.service_id = $1
     AND provider_action.action = 'terminate'`,
  [dueCancellationActive.service.id],
);
assert.equal(dueProviderFacts.rows.length, 1);
assert.deepEqual(
  {
    action: dueProviderFacts.rows[0]?.action,
    status: dueProviderFacts.rows[0]?.status,
    actionCalls: dueProviderFacts.rows[0]?.action_calls,
  },
  { action: "terminate", status: "succeeded", actionCalls: 1 },
);
assert.ok((dueProviderFacts.rows[0]?.query_calls ?? 0) >= 1);

// A recurring manual product reaches the same due instant without any
// Provider operation. It remains active and becomes a durable, readable human
// intervention item instead of masquerading as terminated.
cookie = staffCookie;
await request(
  "/api/v1/auth/reauth",
  { method: "POST", body: JSON.stringify({ password }) },
  200,
);
const manualCancellationOrder = await createOrder(manualPrice.id, legal);
const manualCancellationPaid = await pay(manualCancellationOrder, "success", 60_000);
assert.equal(manualCancellationPaid.order.status, "awaiting_manual");
await request(
  `/api/v1/admin/services/${manualCancellationPaid.service.id}/complete-manual`,
  {
    method: "POST",
    body: JSON.stringify({
      reason: "Synthetic fresh manual delivery for the cycle-end cancellation queue",
    }),
  },
  200,
);
const currentManualService = await request<OrderDetail>(
  `/api/v1/orders/${manualCancellationOrder.order.id}`,
);
assert.equal(currentManualService.service.status, "active");
const manualCancellationVersion = await corePool.query<{ version: number }>(
  `UPDATE services
   SET term_end = now() + interval '60 seconds', updated_at = now(), version = version + 1
   WHERE id = $1
   RETURNING version`,
  [currentManualService.service.id],
);
const manualCancellationExpectedVersion = manualCancellationVersion.rows[0]?.version;
assert.ok(manualCancellationExpectedVersion);
const manualCancellationScheduled = await request<{
  cancellation: {
    requestId: string;
    executionMode: "manual";
  };
}>(`/api/v1/services/${currentManualService.service.id}/cancellation`, {
  method: "POST",
  body: JSON.stringify({
    expectedVersion: manualCancellationExpectedVersion,
    reason: "Synthetic recurring manual service cycle-end cancellation",
    idempotencyKey: randomUUID(),
  }),
}, 201);
assert.equal(manualCancellationScheduled.cancellation.executionMode, "manual");
const manualCancellationDue = await waitFor(
  "manual cancellation due queue",
  () => request<OrderDetail>(`/api/v1/orders/${manualCancellationOrder.order.id}`),
  (value) => value.service.cancellation?.status === "manual",
  100_000,
);
assert.equal(manualCancellationDue.service.status, "active");
assert.equal(manualCancellationDue.service.cancellation?.providerOperation, null);
const adminCancellationQueue = await request<{
  items: Array<{
    requestId: string;
    executionId: string;
    serviceStatus: string;
    executionStatus: string;
    executionVersion: number;
    serviceVersion: number;
    interventionRequired: boolean;
    providerOperation: unknown;
    job: { status: string };
  }>;
}>("/api/v1/admin/services/cancellations");
const manualCancellationQueueItem = adminCancellationQueue.items.find(
  (item) => item.requestId === manualCancellationScheduled.cancellation.requestId,
);
assert.ok(manualCancellationQueueItem);
assert.equal(manualCancellationQueueItem.serviceStatus, "active");
assert.equal(manualCancellationQueueItem.executionStatus, "manual");
assert.equal(manualCancellationQueueItem.interventionRequired, true);
assert.equal(manualCancellationQueueItem.providerOperation, null);
assert.equal(manualCancellationQueueItem.job.status, "manual");
const manualProviderOperation = await corePool.query<{ count: string }>(
  `SELECT count(*)::text AS count
   FROM provider_operations operation
   JOIN service_cancellation_executions execution
     ON operation.subject_type = 'service_cancellation_execution'
    AND operation.subject_id = execution.id
   WHERE execution.cancellation_request_id = $1`,
  [manualCancellationScheduled.cancellation.requestId],
);
assert.equal(manualProviderOperation.rows[0]?.count, "0");

await corePool.query(
  "UPDATE reauth_grants SET invalidated_at = now() WHERE user_id = $1 AND invalidated_at IS NULL",
  [staffMe.id],
);
const manualCompletionKey = randomUUID();
const manualCompletionReason =
  "Synthetic operator confirms the recurring manual service was fully de-racked";
const manualCompletionBody = {
  expectedExecutionVersion: manualCancellationQueueItem.executionVersion,
  expectedServiceVersion: manualCancellationQueueItem.serviceVersion,
  reason: manualCompletionReason,
  idempotencyKey: manualCompletionKey,
};
const manualCompletionWithoutReauth = await rawCoreRequest(
  `/api/v1/admin/services/cancellations/${manualCancellationQueueItem.executionId}/complete-manual`,
  { method: "POST", body: JSON.stringify(manualCompletionBody) },
);
assert.equal(manualCompletionWithoutReauth.status, 403);
await request(
  "/api/v1/auth/reauth",
  { method: "POST", body: JSON.stringify({ password }) },
  200,
);
const completedManualCancellation = await request<{
  actionId: string;
  executionId: string;
  serviceId: string;
  executionStatus: "terminated";
  serviceStatus: "terminated";
  takeoverKind: "manual_delivery";
  providerCalled: false;
  completedAt: string;
  replayed: boolean;
}>(
  `/api/v1/admin/services/cancellations/${manualCancellationQueueItem.executionId}/complete-manual`,
  { method: "POST", body: JSON.stringify(manualCompletionBody) },
  201,
);
assert.equal(completedManualCancellation.replayed, false);
assert.equal(completedManualCancellation.executionStatus, "terminated");
assert.equal(completedManualCancellation.serviceStatus, "terminated");
assert.equal(completedManualCancellation.takeoverKind, "manual_delivery");
assert.equal(completedManualCancellation.providerCalled, false);
const replayedManualCompletion = await request<typeof completedManualCancellation>(
  `/api/v1/admin/services/cancellations/${manualCancellationQueueItem.executionId}/complete-manual`,
  { method: "POST", body: JSON.stringify(manualCompletionBody) },
  200,
);
assert.equal(replayedManualCompletion.replayed, true);
assert.equal(replayedManualCompletion.actionId, completedManualCancellation.actionId);
const conflictingManualCompletion = await rawCoreRequest(
  `/api/v1/admin/services/cancellations/${manualCancellationQueueItem.executionId}/complete-manual`,
  {
    method: "POST",
    body: JSON.stringify({
      ...manualCompletionBody,
      reason: `${manualCompletionReason} with a conflicting replay payload`,
    }),
  },
);
assert.equal(conflictingManualCompletion.status, 409);
assert.equal(conflictingManualCompletion.body.code, "IDEMPOTENCY_CONFLICT");
const staleManualCompletion = await rawCoreRequest(
  `/api/v1/admin/services/cancellations/${manualCancellationQueueItem.executionId}/complete-manual`,
  {
    method: "POST",
    body: JSON.stringify({ ...manualCompletionBody, idempotencyKey: randomUUID() }),
  },
);
assert.equal(staleManualCompletion.status, 409);
assert.equal(staleManualCompletion.body.code, "VERSION_CONFLICT");
const completedManualFacts = await corePool.query<{
  service_status: string;
  execution_status: string;
  actions: string;
  provider_operations: string;
}>(
  `SELECT service.status AS service_status,
          execution.status AS execution_status,
          (SELECT count(*)::text
           FROM service_cancellation_manual_actions action
           WHERE action.execution_id = execution.id) AS actions,
          (SELECT count(*)::text
           FROM provider_operations operation
           WHERE operation.subject_type = 'service_cancellation_execution'
             AND operation.subject_id = execution.id) AS provider_operations
   FROM service_cancellation_executions execution
   JOIN services service ON service.id = execution.service_id
   WHERE execution.id = $1`,
  [manualCancellationQueueItem.executionId],
);
assert.deepEqual(completedManualFacts.rows[0], {
  service_status: "terminated",
  execution_status: "terminated",
  actions: "1",
  provider_operations: "0",
});
const completedManualProviderCalls = await providerPool.query<{ count: string }>(
  `SELECT count(*)::text AS count
   FROM mock_resource_action_operations
   WHERE service_id = $1 AND action = 'terminate'`,
  [currentManualService.service.id],
);
assert.equal(completedManualProviderCalls.rows[0]?.count, "0");

// Scheduling against an already-ended term is rejected before any request,
// execution, Provider operation, or due job can be recorded.
cookie = cancellationCookie;
const endedCancellationOrder = await createOrder(automaticPrice.id, legal);
await pay(endedCancellationOrder, "success");
const endedCancellationActive = await waitFor(
  "ended cancellation rejection fixture activation",
  () => request<OrderDetail>(`/api/v1/orders/${endedCancellationOrder.order.id}`),
  (value) => value.service.status === "active",
);
await corePool.query(
  `UPDATE services
   SET term_end = now() - interval '1 second', updated_at = now(), version = version + 1
   WHERE id = $1`,
  [endedCancellationActive.service.id],
);
const endedCancellationReady = await request<OrderDetail>(
  `/api/v1/orders/${endedCancellationOrder.order.id}`,
);
const endedCancellationAttempt = await rawCoreRequest(
  `/api/v1/services/${endedCancellationReady.service.id}/cancellation`,
  {
    method: "POST",
    body: JSON.stringify({
      expectedVersion: endedCancellationReady.service.version,
      reason: "Synthetic ended service cannot schedule cancellation",
      idempotencyKey: randomUUID(),
    }),
  },
);
assert.equal(endedCancellationAttempt.status, 409);
assert.equal(endedCancellationAttempt.body.code, "CANCELLATION_NOT_ALLOWED");
const endedCancellationFacts = await corePool.query<{ requests: string; jobs: string }>(
  `SELECT
     (SELECT count(*)::text FROM service_cancellation_requests WHERE service_id = $1) AS requests,
     (SELECT count(*)::text FROM durable_jobs
       WHERE job_type = 'service.cancellation.due'
         AND payload->>'serviceId' = $1::text) AS jobs`,
  [endedCancellationReady.service.id],
);
assert.deepEqual(endedCancellationFacts.rows[0], { requests: "0", jobs: "0" });
cookie = staffCookie;

const invalidActiveRecurringSnapshots = await corePool.query<{ count: string }>(
  `SELECT count(*)::text AS count
   FROM services service
   JOIN order_items item ON item.id = service.order_item_id
   WHERE service.status = 'active'
     AND service.billing_cycle <> 'one_time'
     AND (
       jsonb_typeof(item.price_snapshot->'recurringSubtotalMinor') IS DISTINCT FROM 'string'
       OR COALESCE(item.price_snapshot->>'recurringSubtotalMinor', '') !~ '^[1-9][0-9]*$'
     )`,
);
assert.equal(
  invalidActiveRecurringSnapshots.rows[0]?.count,
  "0",
  "every active recurring service fixture must retain a positive historical recurring price",
);

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
const deadlockFinal = await corePool.query<{ deadlocks: string }>(
  `SELECT deadlocks::text
   FROM pg_stat_database
   WHERE datname = current_database()`,
);
assert.equal(
  deadlockFinal.rows[0]?.deadlocks,
  initialDeadlocks,
  "the full payment, reconciliation, settlement, and recovery journey must not add a PostgreSQL deadlock",
);

await corePool.end();
await providerPool.end();
console.log("Stage A PostgreSQL journey passed.");
