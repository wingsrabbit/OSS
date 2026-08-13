// SPDX-License-Identifier: Apache-2.0
// NOT FOR PRODUCTION — MOCK PROVIDERS ONLY

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const LAB_WARNING = "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const SPA_PATHS = Object.freeze(["/", "/customer", "/admin"]);

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

export class DemoSession {
  constructor(baseUrl, fetchImpl = fetch) {
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.cookie = "";
    this.sessionEpoch = 0;
    this.accountContextVersion = null;
    this.clientAccountId = null;
  }

  async request(path, init = {}, expectedStatus = 200) {
    const requestSessionEpoch = this.sessionEpoch;
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (this.cookie && !headers.has("Cookie")) headers.set("Cookie", this.cookie);
    if (
      method !== "GET" &&
      method !== "HEAD" &&
      this.accountContextVersion !== null &&
      !headers.has("X-OSS-Account-Context-Version")
    ) {
      headers.set("X-OSS-Account-Context-Version", this.accountContextVersion);
    }

    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const setCookie = response.headers.get("set-cookie");
    let responseEstablishedCurrentSession = false;
    if (setCookie && requestSessionEpoch === this.sessionEpoch) {
      const nextCookie = setCookie.split(";", 1)[0] ?? "";
      const cookieValue = nextCookie.includes("=")
        ? nextCookie.slice(nextCookie.indexOf("=") + 1).trim()
        : "";
      const maxAge = /(?:^|;)\s*max-age\s*=\s*(-?\d+)/i.exec(setCookie)?.[1];
      const expires = /(?:^|;)\s*expires\s*=\s*([^;]+)/i.exec(setCookie)?.[1];
      const expiresAt = expires === undefined ? Number.NaN : Date.parse(expires);
      const clearsSession =
        cookieValue.length === 0 ||
        (maxAge !== undefined && Number(maxAge) <= 0) ||
        (Number.isFinite(expiresAt) && expiresAt <= Date.now());
      if (clearsSession) {
        this.cookie = "";
        this.sessionEpoch += 1;
        this.accountContextVersion = null;
        this.clientAccountId = null;
      } else if (nextCookie !== this.cookie) {
        this.cookie = nextCookie;
        this.sessionEpoch += 1;
        this.accountContextVersion = null;
        this.clientAccountId = null;
        responseEstablishedCurrentSession = true;
      }
    }
    const accountContextVersion = response.headers.get("x-oss-account-context-version");
    const responseBelongsToCurrentSession =
      requestSessionEpoch === this.sessionEpoch || responseEstablishedCurrentSession;
    if (accountContextVersion !== null && responseBelongsToCurrentSession) {
      assert.match(
        accountContextVersion,
        /^(?:0|[1-9]\d*)$/,
        "API returned an invalid account-context version",
      );
      const responseVersion = BigInt(accountContextVersion);
      const currentVersion =
        this.accountContextVersion === null ? null : BigInt(this.accountContextVersion);
      if (
        currentVersion === null ||
        responseVersion >= currentVersion
      ) {
        this.accountContextVersion = accountContextVersion;
        const clientAccountId = response.headers.get("x-oss-client-account-id");
        this.clientAccountId = clientAccountId?.trim() || null;
      }
    }
    const bodyText = await response.text();
    if (response.status !== expectedStatus) {
      throw new Error(
        `${method} ${path} expected ${expectedStatus}, received ${response.status}: ${bodyText}`,
      );
    }
    if (response.status === 204 || bodyText.length === 0) return undefined;
    return JSON.parse(bodyText);
  }
}

function syntheticIdentity(role = "customer") {
  const marker = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  return {
    email: `demo-${role}-${marker}@example.invalid`,
    password: `Synthetic-Demo-${randomUUID()}!`,
    clientName: `Synthetic Demo ${role === "administrator" ? "Staff" : "Client"} ${marker}`,
  };
}

async function registerAndVerify({ session, identity, timeoutMs }) {
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
    `Mock Mail verification delivery for ${identity.email}`,
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
  return {
    registration,
    account: {
      ...identity,
      userId: registration.userId,
      clientAccountId: registration.clientAccountId,
      administrator: false,
    },
  };
}

async function administratorSession({
  baseUrl,
  administratorAccount,
}) {
  if (!administratorAccount?.email || !administratorAccount?.password) {
    throw new Error(
      "This preserved Demo database has no recoverable synthetic administrator credential. Run `node tools/demo-local.mjs reset --yes`, then `node tools/demo-local.mjs up` to create separate Staff and customer identities.",
    );
  }

  const session = new DemoSession(baseUrl);
  try {
    await session.request("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: administratorAccount.email,
        password: administratorAccount.password,
      }),
    });
  } catch (error) {
    throw new Error(
      `The stored synthetic administrator credential is no longer usable. Run \`node tools/demo-local.mjs reset --yes\`, then \`node tools/demo-local.mjs up\`. ${error instanceof Error ? error.message : error}`,
    );
  }
  const principal = await session.request("/api/v1/auth/me");
  assert.ok(principal.staff, "Stored synthetic administrator is no longer a staff principal");
  if (administratorAccount.userId) {
    assert.equal(
      principal.id,
      administratorAccount.userId,
      "Stored synthetic administrator resolved to a different user",
    );
  }
  if (administratorAccount.clientAccountId) {
    assert.equal(
      principal.clientAccountId,
      administratorAccount.clientAccountId,
      "Stored synthetic administrator resolved to a different Client Account",
    );
  }
  return {
    session,
    password: administratorAccount.password,
    account: {
      ...administratorAccount,
      userId: principal.id,
      clientAccountId: principal.clientAccountId,
      administrator: true,
    },
  };
}

async function createAdministrator({ baseUrl, bootstrapToken, timeoutMs, onAdministratorAccount }) {
  const session = new DemoSession(baseUrl);
  const identity = syntheticIdentity("administrator");
  const registered = await registerAndVerify({ session, identity, timeoutMs });
  await session.request(
    "/api/v1/admin/bootstrap",
    { method: "POST", body: JSON.stringify({ bootstrapToken }) },
    201,
  );
  const principal = await session.request("/api/v1/auth/me");
  assert.ok(principal.staff, "Administrator bootstrap did not create a staff principal");
  assert.equal(principal.id, registered.account.userId);
  assert.equal(principal.clientAccountId, registered.account.clientAccountId);
  const account = { ...registered.account, administrator: true };
  await onAdministratorAccount?.(account);
  return { session, password: identity.password, account };
}

export function assertSeparatedDemoRoles({
  customerSession,
  customerUserId,
  clientAccountId,
  administrator,
}) {
  assert.ok(administrator.account?.userId, "Demo Staff account has no user ID");
  assert.ok(
    administrator.account?.clientAccountId,
    "Demo Staff account has no Client Account ID",
  );
  assert.notStrictEqual(
    administrator.session,
    customerSession,
    "Demo Staff and customer journeys must use different authenticated sessions",
  );
  assert.notEqual(
    administrator.account?.userId,
    customerUserId,
    "Demo Staff and customer journeys must use different users",
  );
  assert.notEqual(
    administrator.account?.clientAccountId,
    clientAccountId,
    "Demo Staff and customer journeys must use different Client Accounts",
  );
}

export async function runSupportTicketSmoke({
  customerSession,
  administrator,
  customerUserId,
  clientAccountId,
  serviceId,
}) {
  assertSeparatedDemoRoles({
    customerSession,
    customerUserId,
    clientAccountId,
    administrator,
  });
  const marker = randomUUID();
  const subject = `Synthetic active-service ticket ${marker}`;
  const openingMessage =
    "Synthetic Demo customer asks Staff to confirm the linked active service.";
  const internalNoteBody =
    "Synthetic Demo internal note: active service linkage reviewed; customer must not see this note.";

  const created = await customerSession.request(
    "/api/v1/tickets",
    {
      method: "POST",
      body: JSON.stringify({ subject, message: openingMessage, serviceId }),
    },
    201,
  );
  assert.equal(created.ticket.subject, subject);
  assert.equal(created.ticket.service?.id, serviceId, "Synthetic ticket is not linked to the Active service");

  const staffView = await administrator.session.request(
    `/api/v1/admin/tickets/${created.ticket.id}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ kind: "internal_note", message: internalNoteBody }),
    },
    201,
  );
  assert.equal(staffView.ticket.clientAccount.id, clientAccountId);
  assert.equal(staffView.ticket.service?.id, serviceId);
  const internalNote = staffView.messages.find(
    (message) => message.visibility === "internal" && message.body === internalNoteBody,
  );
  assert.ok(internalNote, "Synthetic Staff internal note is missing from the Staff ticket view");

  const customerView = await customerSession.request(`/api/v1/tickets/${created.ticket.id}`);
  assert.equal(customerView.ticket.id, created.ticket.id);
  assert.equal(customerView.ticket.service?.id, serviceId);
  assert.equal(
    customerView.messages.some((message) => message.id === internalNote.id),
    false,
    "Staff internal note leaked into the customer ticket view",
  );
  assert.equal(
    customerView.messages.some((message) => message.body === internalNoteBody),
    false,
    "Staff internal note body leaked into the customer ticket view",
  );

  return {
    ticketId: created.ticket.id,
    internalNoteId: internalNote.id,
    clientAccountId,
    serviceId,
    subject,
    status: customerView.ticket.status,
    internalNoteCustomerVisible: false,
  };
}

async function runManualReceiptOutflowSmoke({
  administrator,
  clientAccountId,
}) {
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
  onAdministratorAccount,
  timeoutMs = 90_000,
} = {}) {
  const parsedBaseUrl = assertLoopbackBaseUrl(baseUrl);
  const session = new DemoSession(parsedBaseUrl);
  const startedAt = new Date().toISOString();

  await waitFor(
    "Web and API readiness",
    async () => {
      const [pages, readiness] = await Promise.all([
        Promise.all(
          SPA_PATHS.map(async (path) => {
            const response = await fetch(new URL(path, parsedBaseUrl), {
              headers: { Accept: "text/html" },
              signal: AbortSignal.timeout(5_000),
            });
            const pageText = await response.text();
            return {
              path,
              status: response.status,
              contentType: response.headers.get("content-type") ?? "",
              spaHtml: pageText.includes("OpenSales System Laboratory"),
            };
          }),
        ),
        fetch(new URL("/health/ready", parsedBaseUrl), { signal: AbortSignal.timeout(5_000) }),
      ]);
      return {
        pages,
        readiness: readiness.status,
      };
    },
    (value) =>
      value.pages.every(
        (page) =>
          page.status === 200 && page.contentType.includes("text/html") && page.spaHtml,
      ) &&
      value.readiness === 200,
    timeoutMs,
  );

  const catalog = await session.request("/api/v1/catalog?locale=en");
  const legal = await session.request("/api/v1/legal/current?locale=en");
  const publicContent = await session.request("/api/v1/content?locale=en");
  const automaticProduct = catalog.products.find((product) => product.id === "hkbgp-vps");
  const automaticPrice = automaticProduct?.prices.find(
    (price) => price.billingCycle === "monthly",
  );
  assert.ok(automaticProduct, "Synthetic HKBGP VPS product is missing");
  assert.ok(automaticPrice, "Synthetic HKBGP VPS monthly price is missing");
  assert.ok(legal.documents?.terms?.version, "Synthetic Terms are missing");
  assert.ok(legal.documents?.aup?.version, "Synthetic AUP is missing");
  assert.ok(legal.documents?.privacy?.version, "Synthetic Privacy notice is missing");
  for (const kind of ["terms", "aup", "privacy"]) {
    assert.match(legal.documents[kind].documentId, /^[0-9a-f-]{36}$/);
    assert.equal(legal.documents[kind].locale, "en");
    assert.equal(legal.documents[kind].fallback, false);
    assert.match(legal.documents[kind].revision, /^(?:0|[1-9]\d*)$/);
  }
  assert.ok(
    publicContent.items.some((item) => item.kind === "announcement"),
    "Published synthetic Announcement is missing",
  );
  assert.ok(
    publicContent.items.some((item) => item.kind === "network_status"),
    "Published synthetic Network Status is missing",
  );
  assert.equal(
    publicContent.items.some((item) => item.audience !== "public"),
    false,
    "Public Content returned a non-public entry",
  );

  const administratorAccess = bootstrapToken
    ? await createAdministrator({
        baseUrl: parsedBaseUrl,
        bootstrapToken,
        timeoutMs,
        onAdministratorAccount,
      })
    : await administratorSession({
        baseUrl: parsedBaseUrl,
        administratorAccount,
      });

  const identity = syntheticIdentity("customer");
  const registeredCustomer = await registerAndVerify({ session, identity, timeoutMs });
  const registration = registeredCustomer.registration;
  const customerContent = await session.request("/api/v1/customer/content?locale=zh-CN");
  assert.ok(
    customerContent.items.some((item) => item.kind === "knowledge_base"),
    "Published synthetic Customer Knowledge Base is missing",
  );
  assert.ok(
    customerContent.items.every(
      (item) => item.locale === "zh-CN" || (item.locale === "en" && item.fallback === true),
    ),
    "Customer Content did not use deterministic zh-CN then English fallback",
  );

  const created = await session.request(
    "/api/v1/orders",
    {
      method: "POST",
      body: JSON.stringify({
        priceId: automaticPrice.id,
        configuration: {},
        termsVersion: legal.documents.terms.version,
        aupVersion: legal.documents.aup.version,
        termsDocumentId: legal.documents.terms.documentId,
        aupDocumentId: legal.documents.aup.documentId,
        legalLocale: "en",
        termsLocale: legal.documents.terms.locale,
        aupLocale: legal.documents.aup.locale,
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

  const supportTicket = await runSupportTicketSmoke({
    customerSession: session,
    administrator: administratorAccess,
    customerUserId: registration.userId,
    clientAccountId: registration.clientAccountId,
    serviceId: activeOrder.service.id,
  });

  const manualReceiptOutflow = await runManualReceiptOutflowSmoke({
    administrator: administratorAccess,
    clientAccountId: registration.clientAccountId,
  });

  const publicUrl = new URL("/", parsedBaseUrl).toString();
  const customerUrl = new URL("/customer", parsedBaseUrl).toString();
  const adminUrl = new URL("/admin", parsedBaseUrl).toString();

  return {
    warning: LAB_WARNING,
    startedAt,
    completedAt: new Date().toISOString(),
    baseUrl: parsedBaseUrl.toString().replace(/\/$/, ""),
    urls: { public: publicUrl, customer: customerUrl, admin: adminUrl },
    loginPath: "/customer",
    administratorPanelPath: "/admin",
    syntheticAccount: registeredCustomer.account,
    administratorAccount: administratorAccess.account,
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
    supportTicket,
    manualReceiptOutflow,
  };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runDemoSmoke({
    baseUrl: process.env.OSS_DEMO_URL ?? "http://127.0.0.1:5173",
    bootstrapToken: process.env.OSS_DEMO_BOOTSTRAP_TOKEN,
    administratorAccount:
      process.env.OSS_DEMO_ADMIN_EMAIL && process.env.OSS_DEMO_ADMIN_PASSWORD
        ? {
            email: process.env.OSS_DEMO_ADMIN_EMAIL,
            password: process.env.OSS_DEMO_ADMIN_PASSWORD,
            administrator: true,
          }
        : undefined,
  })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
