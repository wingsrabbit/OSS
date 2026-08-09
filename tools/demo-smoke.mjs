// SPDX-License-Identifier: Apache-2.0
// NOT FOR PRODUCTION — MOCK PROVIDERS ONLY

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const LAB_WARNING = "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function assertLoopbackBaseUrl(value) {
  const url = new URL(value);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`Demo smoke is restricted to loopback URLs; received ${url.hostname}`);
  }
  if (url.protocol !== "http:") {
    throw new Error(`Demo smoke requires local HTTP; received ${url.protocol}`);
  }
  return url;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(description, read, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  let latestError;
  while (Date.now() < deadline) {
    try {
      latest = await read();
      if (predicate(latest)) return latest;
      latestError = undefined;
    } catch (error) {
      latestError = error;
    }
    await delay(500);
  }
  const detail = latestError instanceof Error ? latestError.message : JSON.stringify(latest);
  throw new Error(`Timed out waiting for ${description}: ${detail}`);
}

class DemoSession {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookie = "";
  }

  async request(path, init = {}, expectedStatus = 200) {
    const response = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...init.headers,
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";", 1)[0] ?? "";
    const bodyText = await response.text();
    if (response.status !== expectedStatus) {
      throw new Error(
        `${init.method ?? "GET"} ${path} expected ${expectedStatus}, received ${response.status}: ${bodyText}`,
      );
    }
    if (response.status === 204 || bodyText.length === 0) return undefined;
    return JSON.parse(bodyText);
  }
}

function syntheticIdentity() {
  const marker = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  return {
    email: `demo-${marker}@example.invalid`,
    password: `Synthetic-Demo-${randomUUID()}!`,
    clientName: `Synthetic Demo Client ${marker}`,
  };
}

async function administratorSession({
  baseUrl,
  customerSession,
  customerIdentity,
  customerIsAdministrator,
  administratorAccount,
}) {
  if (customerIsAdministrator) {
    return { session: customerSession, password: customerIdentity.password };
  }
  if (!administratorAccount?.email || !administratorAccount?.password) return null;

  const session = new DemoSession(baseUrl);
  await session.request("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: administratorAccount.email,
      password: administratorAccount.password,
    }),
  });
  const principal = await session.request("/api/v1/auth/me");
  assert.ok(principal.staff, "Stored synthetic administrator is no longer a staff principal");
  return { session, password: administratorAccount.password };
}

async function runManualReceiptOutflowSmoke({
  baseUrl,
  customerSession,
  customerIdentity,
  customerIsAdministrator,
  administratorAccount,
  clientAccountId,
}) {
  const administrator = await administratorSession({
    baseUrl,
    customerSession,
    customerIdentity,
    customerIsAdministrator,
    administratorAccount,
  });
  if (!administrator) return null;

  await administrator.session.request("/api/v1/auth/reauth", {
    method: "POST",
    body: JSON.stringify({ password: administrator.password }),
  });

  const marker = randomUUID();
  const grossAmountMinor = "10000";
  const outflowAmountMinor = "1200";
  const receipt = await administrator.session.request(
    `/api/v1/admin/client-accounts/${clientAccountId}/manual-receipts`,
    {
      method: "POST",
      body: JSON.stringify({
        reference: `SYNTHETIC-RECEIPT-${marker}`,
        receivedAt: new Date(Date.now() - 60_000).toISOString(),
        grossAmountMinor,
        feeMinor: "0",
        currency: "USD",
        reason: "Synthetic Demo evidence confirms isolated manual funds arrived",
        idempotencyKey: randomUUID(),
      }),
    },
    201,
  );
  assert.equal(receipt.providerUsed, false, "Manual receipt unexpectedly used a Provider");

  const outflow = await administrator.session.request(
    `/api/v1/admin/client-accounts/${clientAccountId}/manual-receipts/${receipt.manualReceiptId}/outflow-reports`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedAvailableMinor: grossAmountMinor,
        amountMinor: outflowAmountMinor,
        currency: "USD",
        destination: "original_source",
        destinationReference: `SYNTHETIC-RETURN-${marker}`,
        observedOutcome: "confirmed",
        occurredAt: new Date().toISOString(),
        reason: "Synthetic Demo evidence confirms the original-source outflow completed",
        idempotencyKey: randomUUID(),
      }),
    },
    201,
  );
  assert.equal(outflow.status, "confirmed");
  assert.equal(outflow.destination, "original_source");
  assert.ok(outflow.outflowId, "Confirmed original-source report has no outflow fact ID");
  assert.equal(outflow.providerUsed, false, "Manual receipt outflow unexpectedly used a Provider");

  const history = await administrator.session.request(
    `/api/v1/admin/client-accounts/${clientAccountId}/manual-receipts`,
  );
  const listed = history.items.find((item) => item.manualReceiptId === receipt.manualReceiptId);
  assert.ok(listed, "Synthetic manual receipt is missing from administrator history");
  assert.equal(listed.originalSourceOutflow.confirmedOutflowMinor, outflowAmountMinor);
  assert.equal(listed.originalSourceOutflow.availableMinor, "8800");
  assert.equal(
    listed.originalSourceOutflow.reports.some(
      (report) => report.outflowReportId === outflow.outflowReportId && report.status === "confirmed",
    ),
    true,
    "Confirmed original-source outflow is missing from administrator history",
  );

  return {
    clientAccountId,
    manualReceiptId: receipt.manualReceiptId,
    fundReceiptId: receipt.fundReceiptId,
    outflowReportId: outflow.outflowReportId,
    outflowId: outflow.outflowId,
    grossAmountMinor,
    confirmedOutflowMinor: outflowAmountMinor,
    availableMinor: listed.originalSourceOutflow.availableMinor,
    destination: outflow.destination,
    status: outflow.status,
    providerUsed: outflow.providerUsed,
  };
}

export async function runDemoSmoke({
  baseUrl = "http://127.0.0.1:5173",
  bootstrapToken,
  administratorAccount,
  timeoutMs = 90_000,
} = {}) {
  const parsedBaseUrl = assertLoopbackBaseUrl(baseUrl);
  const session = new DemoSession(parsedBaseUrl);
  const startedAt = new Date().toISOString();

  await waitFor(
    "Web and API readiness",
    async () => {
      const [page, readiness] = await Promise.all([
        fetch(new URL("/", parsedBaseUrl), { signal: AbortSignal.timeout(5_000) }),
        fetch(new URL("/health/ready", parsedBaseUrl), { signal: AbortSignal.timeout(5_000) }),
      ]);
      return {
        page: page.status,
        pageText: await page.text(),
        readiness: readiness.status,
      };
    },
    (value) =>
      value.page === 200 &&
      value.pageText.includes("OpenSales System Laboratory") &&
      value.readiness === 200,
    timeoutMs,
  );

  const catalog = await session.request("/api/v1/catalog?locale=en");
  const legal = await session.request("/api/v1/legal/current?locale=en");
  const automaticProduct = catalog.products.find((product) => product.id === "hkbgp-vps");
  const automaticPrice = automaticProduct?.prices.find(
    (price) => price.billingCycle === "monthly",
  );
  assert.ok(automaticProduct, "Synthetic HKBGP VPS product is missing");
  assert.ok(automaticPrice, "Synthetic HKBGP VPS monthly price is missing");
  assert.ok(legal.documents?.terms?.version, "Synthetic Terms are missing");
  assert.ok(legal.documents?.aup?.version, "Synthetic AUP is missing");

  const identity = syntheticIdentity();
  const registration = await session.request(
    "/api/v1/auth/register",
    {
      method: "POST",
      body: JSON.stringify({
        email: identity.email,
        password: identity.password,
        clientName: identity.clientName,
        locale: "en",
      }),
    },
    201,
  );
  await session.request(
    "/api/v1/auth/login",
    {
      method: "POST",
      body: JSON.stringify({ email: identity.email, password: identity.password }),
    },
    200,
  );
  const beforeVerification = await session.request("/api/v1/auth/me");
  assert.equal(beforeVerification.eligible, false);
  assert.equal(beforeVerification.verification.email, "pending");

  const mailbox = await waitFor(
    "Mock Mail verification delivery",
    () => session.request("/api/v1/lab/mailbox"),
    (value) => value.messages.length > 0,
    timeoutMs,
  );
  assert.equal(mailbox.warning, LAB_WARNING);
  const verificationUrl = mailbox.messages
    .map((message) => message.body.match(/https?:\/\/\S+/)?.[0])
    .find(Boolean);
  assert.ok(verificationUrl, "Mock Mail did not contain a verification URL");
  const verificationToken = new URL(verificationUrl).searchParams.get("token");
  assert.ok(verificationToken, "Mock Mail verification URL had no token");
  await session.request(
    "/api/v1/auth/verify-email",
    { method: "POST", body: JSON.stringify({ token: verificationToken }) },
    200,
  );
  const verified = await session.request("/api/v1/auth/me");
  assert.equal(verified.eligible, true);

  let administrator = false;
  if (bootstrapToken) {
    await session.request(
      "/api/v1/admin/bootstrap",
      { method: "POST", body: JSON.stringify({ bootstrapToken }) },
      201,
    );
    const staff = await session.request("/api/v1/auth/me");
    assert.ok(staff.staff, "Administrator bootstrap did not create a staff principal");
    administrator = true;
  }

  const created = await session.request(
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
    201,
  );
  const order = await session.request(`/api/v1/orders/${created.orderId}`);
  const quote = await session.request(
    `/api/v1/invoices/${order.invoice.id}/payment-quotes`,
    {
      method: "POST",
      body: JSON.stringify({ paymentMethod: "card", applyCredit: false }),
    },
    201,
  );
  await session.request(
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
  const activeOrder = await waitFor(
    "Mock payment, provisioning, and Ready for Service",
    () => session.request(`/api/v1/orders/${created.orderId}`),
    (value) => value.invoice.status === "paid" && value.service.status === "active",
    timeoutMs,
  );
  assert.ok(activeOrder.service.activatedAt, "Active service has no Ready-for-Service time");

  const manualReceiptOutflow = await runManualReceiptOutflowSmoke({
    baseUrl: parsedBaseUrl,
    customerSession: session,
    customerIdentity: identity,
    customerIsAdministrator: administrator,
    administratorAccount,
    clientAccountId: registration.clientAccountId,
  });

  return {
    warning: LAB_WARNING,
    startedAt,
    completedAt: new Date().toISOString(),
    baseUrl: parsedBaseUrl.toString().replace(/\/$/, ""),
    loginPath: "/",
    administratorPanelPath: manualReceiptOutflow
      ? "/ (sign in with the printed administrator; panels appear below)"
      : null,
    syntheticAccount: {
      ...identity,
      userId: registration.userId,
      clientAccountId: registration.clientAccountId,
      administrator,
    },
    journey: {
      product: automaticProduct.name,
      orderId: activeOrder.order.id,
      orderStatus: activeOrder.order.status,
      invoiceId: activeOrder.invoice.id,
      invoiceStatus: activeOrder.invoice.status,
      paymentStatus: activeOrder.payment.status,
      serviceId: activeOrder.service.id,
      serviceStatus: activeOrder.service.status,
      readyForServiceAt: activeOrder.service.activatedAt,
    },
    manualReceiptOutflow,
  };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runDemoSmoke({
    baseUrl: process.env.OSS_DEMO_URL ?? "http://127.0.0.1:5173",
    bootstrapToken: process.env.OSS_DEMO_BOOTSTRAP_TOKEN,
  })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
