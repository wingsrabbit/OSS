// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { providerOperationCapability } from "@opensales/core/provider-capability";
import pg from "pg";
import { providerSignature } from "./provider-signature.js";

const coreUrl = process.env.CORE_TEST_URL ?? "http://127.0.0.1:3000";
const databaseUrl = process.env.DATABASE_URL;
const providerDatabaseUrl = process.env.PROVIDER_DATABASE_URL;
const providerUrl = process.env.MOCK_PAYMENT_PROVIDER_URL;
const paymentProviderToken = process.env.MOCK_PAYMENT_PROVIDER_TOKEN;
const paymentWebhookSecret = process.env.MOCK_PAYMENT_WEBHOOK_SECRET;
const provisioningWebhookSecret = process.env.MOCK_PROVISIONING_WEBHOOK_SECRET;
const providerCapabilitySecret = process.env.PROVIDER_OPERATION_CAPABILITY_SECRET;
if (
  !databaseUrl ||
  !providerDatabaseUrl ||
  !providerUrl ||
  !paymentProviderToken ||
  !paymentWebhookSecret ||
  !provisioningWebhookSecret ||
  !providerCapabilitySecret
) {
  throw new Error("Database and Mock Payment Provider test configuration are required");
}

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
type PaymentRecords = {
  command_status: string;
  attempt_status: string;
  operation_id: string;
  operation_status: string;
  job_status: string;
  amount_minor: string;
  currency: string;
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

const email = `stage-a-${randomUUID()}@example.invalid`;
const password = `Synthetic-${randomBytes(12).toString("hex")}!`;
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
    AND operation.subject_id = $1
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
cookie = staffCookie;

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

await corePool.end();
await providerPool.end();
console.log("Stage A PostgreSQL journey passed.");
