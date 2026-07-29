// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

const coreUrl = process.env.CORE_TEST_URL ?? "http://127.0.0.1:3000";
const databaseUrl = process.env.DATABASE_URL;
const providerDatabaseUrl = process.env.PROVIDER_DATABASE_URL;
const providerUrl = process.env.MOCK_PAYMENT_PROVIDER_URL;
const paymentProviderToken = process.env.MOCK_PAYMENT_PROVIDER_TOKEN;
const paymentWebhookSecret = process.env.MOCK_PAYMENT_WEBHOOK_SECRET;
if (
  !databaseUrl ||
  !providerDatabaseUrl ||
  !providerUrl ||
  !paymentProviderToken ||
  !paymentWebhookSecret
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
  invoice: { id: string; status: string; dueMinor: string };
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
  const timestamp = Date.now().toString();
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${JSON.stringify(body)}`, "utf8")
    .digest("hex");
  return rawCoreRequest("/api/v1/provider-events/payment", {
    method: "POST",
    headers: {
      "X-OSS-Timestamp": timestamp,
      "X-OSS-Signature": signature,
    },
    body: JSON.stringify(body),
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

async function pay(
  order: OrderDetail,
  scenario: "success" | "failed" | "timeout_success" | "duplicate_out_of_order",
): Promise<OrderDetail> {
  await request(
    `/api/v1/invoices/${order.invoice.id}/payments`,
    {
      method: "POST",
      body: JSON.stringify({ scenario, idempotencyKey: randomUUID() }),
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
await request(
  `/api/v1/invoices/${paymentConflictOrderA.invoice.id}/payments`,
  {
    method: "POST",
    body: JSON.stringify({ scenario: "failed", idempotencyKey: paymentConflictKey }),
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
    body: JSON.stringify({ scenario: "failed", idempotencyKey: paymentConflictKey }),
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
await request("/api/v1/auth/resend-verification", { method: "POST" }, 200);
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
