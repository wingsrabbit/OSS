// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_TRANSPORT_VERSION,
  ProviderClient,
  ProviderUnknownOutcomeError,
  canonicalProviderJson,
  providerRequestFingerprint,
  providerInstallationReview,
  providerUninstallDecision,
  reconcileProviderOperation,
  reduceProviderEvents,
  reviewProviderPermissionExpansion,
  stableProviderOperationId,
  type PaymentOperationRequest,
  type ProviderEvent,
  type ProviderOperationResult,
  type ProviderManifest,
} from "./index.js";

const request: PaymentOperationRequest = {
  transportVersion: PROVIDER_TRANSPORT_VERSION,
  contractVersion: PROVIDER_CONTRACT_VERSION,
  capability: "payment",
  action: "payment.capture",
  operationId: "00000000-0000-4000-8000-000000000001",
  requestedAt: "2026-08-13T00:00:00.000Z",
  intentRef: "invoice-1",
  input: { amountMinor: "100", currency: "USD" },
};

const result: ProviderOperationResult = {
  transportVersion: PROVIDER_TRANSPORT_VERSION,
  contractVersion: PROVIDER_CONTRACT_VERSION,
  capability: "payment",
  operationId: request.operationId,
  status: "succeeded",
  revision: 1,
  observedAt: request.requestedAt,
  output: { externalPaymentRef: "payment-1", paymentState: "captured", amountMinor: "100", currency: "USD" },
};

test("canonical JSON, fingerprint, and stable operation id are deterministic", async () => {
  assert.equal(canonicalProviderJson({ z: 1, a: [true, "x"] }), '{"a":[true,"x"],"z":1}');
  assert.equal(await providerRequestFingerprint(request), await providerRequestFingerprint({ ...request }));
  const parts = { accountRef: "account-1", capability: "payment" as const, action: "payment.capture", intentRef: "invoice-1" };
  const first = await stableProviderOperationId(parts);
  assert.equal(first, await stableProviderOperationId(parts));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("client sends the operation id as idempotency key and treats 504 as unknown", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const client = new ProviderClient({
    baseUrl: "https://provider.example.test/provider",
    token: "synthetic-token",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(result), { status: 202, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal((await client.execute(request)).status, "succeeded");
  assert.equal(new Headers(calls[0]?.init?.headers).get("idempotency-key"), request.operationId);

  const timeoutClient = new ProviderClient({
    baseUrl: "https://provider.example.test/provider",
    fetch: async () => new Response(JSON.stringify({ error: "synthetic timeout" }), { status: 504 }),
  });
  await assert.rejects(() => timeoutClient.execute(request), ProviderUnknownOutcomeError);
  const transportFailureClient = new ProviderClient({
    baseUrl: "https://provider.example.test/provider",
    fetch: async () => {
      throw new TypeError("synthetic connection interruption");
    },
  });
  await assert.rejects(() => transportFailureClient.execute(request), ProviderUnknownOutcomeError);
});

test("reconciliation is query-only and bounded", async () => {
  let calls = 0;
  const reconciled = await reconcileProviderOperation(
    {
      async reconcile() {
        calls += 1;
        return calls < 3 ? { ...result, status: "unknown" } : result;
      },
    },
    "payment",
    request.operationId,
    { maxAttempts: 3, delayMs: 1, sleep: async () => undefined },
  );
  assert.equal(reconciled.status, "succeeded");
  assert.equal(calls, 3);
});

test("duplicate and out-of-order events cannot regress the latest result", () => {
  const { output: _output, ...resultWithoutOutput } = result;
  const event = (eventId: string, sequence: number, status: ProviderOperationResult["status"]): ProviderEvent => ({
    transportVersion: PROVIDER_TRANSPORT_VERSION,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    eventId,
    providerId: "opensales.synthetic-provider",
    capability: "payment",
    operationId: request.operationId,
    sequence,
    eventType: status === "succeeded" ? "operation.succeeded" : "operation.pending",
    observedAt: request.requestedAt,
    result: status === "succeeded"
      ? { ...result, status, revision: sequence }
      : { ...resultWithoutOutput, status, revision: sequence },
  });
  const terminal = event("00000000-0000-4000-8000-000000000010", 2, "succeeded");
  const stale = event("00000000-0000-4000-8000-000000000011", 1, "pending");
  const reduction = reduceProviderEvents([terminal, stale, terminal]);
  assert.equal(reduction.latest?.result.status, "succeeded");
  assert.equal(reduction.accepted.length, 1);
  assert.equal(reduction.ignoredDuplicateOrStale.length, 2);
});

const installationManifest: ProviderManifest = {
  manifestVersion: "v1",
  providerId: "opensales.synthetic-provider",
  displayName: "Synthetic Provider",
  description: "Synthetic installation review fixture.",
  endpointBaseUrl: "https://provider.example.test/provider",
  publisher: { name: "Synthetic publisher", website: "https://example.test", supportUrl: "https://example.test/support" },
  license: { identifier: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
  capabilities: [{ capability: "tax", contractVersion: PROVIDER_CONTRACT_VERSION, operations: ["tax.quote"], eventSubscriptions: ["core.tax.requested"] }],
  permissions: {
    scopes: ["tax.operate"],
    dataFields: ["minor_units"],
    secrets: [{ name: "PROVIDER_TOKEN", purpose: "Bearer credential", required: true, rotation: "required" }],
  },
  limits: { maxConcurrentOperations: 4, maxAmountMinor: "100000", maxOwnedResources: 0 },
  retention: { operationDays: 7, eventDays: 7, piiDays: 0 },
  lifecycle: {
    supportsPause: true,
    supportsCredentialRotation: true,
    supportsManualTakeover: true,
    uninstallRequiresNoUnknownOperations: true,
    uninstallRequiresNoOwnedResources: true,
    uninstallRequiresNoPendingFunds: true,
  },
};

test("installation review exposes versions, permissions, data, Secrets, limits, and retention", () => {
  const review = providerInstallationReview(installationManifest);
  assert.equal(review.versions[0]?.contractVersion, PROVIDER_CONTRACT_VERSION);
  assert.deepEqual(review.scopes, ["tax.operate"]);
  assert.equal(review.secrets[0]?.name, "PROVIDER_TOKEN");
  assert.equal(review.limits.maxAmountMinor, "100000");
  assert.equal(review.retention.operationDays, 7);
});

test("permission expansion requires fresh approval and safe shrinkage does not", () => {
  const expanded: ProviderManifest = {
    ...installationManifest,
    permissions: {
      ...installationManifest.permissions,
      scopes: [...installationManifest.permissions.scopes, "tax.customer_region.read"],
      dataFields: [...installationManifest.permissions.dataFields, "synthetic_tax_jurisdiction"],
    },
    limits: {
      ...installationManifest.limits,
      maxConcurrentOperations: 8,
      maxAmountMinor: "200000",
    },
    retention: { ...installationManifest.retention, piiDays: 3 },
  };
  const expansion = reviewProviderPermissionExpansion(installationManifest, expanded);
  assert.equal(expansion.requiresFreshApproval, true);
  assert.deepEqual(
    expansion.expansions.map(({ category }) => category),
    ["scope", "data_field", "amount_limit", "concurrency_limit", "retention"],
  );
  const shrunk: ProviderManifest = {
    ...installationManifest,
    limits: { ...installationManifest.limits, maxAmountMinor: "50000" },
    retention: { ...installationManifest.retention, operationDays: 3, eventDays: 3 },
  };
  assert.equal(reviewProviderPermissionExpansion(installationManifest, shrunk).requiresFreshApproval, false);
});

test("unknown results, pending funds, and owned Active resources block uninstall", () => {
  assert.deepEqual(providerUninstallDecision(installationManifest, {
    unknownOperations: 1,
    pendingFunds: 2,
    ownedActiveResources: 3,
  }), {
    allowed: false,
    blockers: ["unknown_operations", "pending_funds", "owned_active_resources"],
    requiredNextStep: "drain_reconcile_export_or_manual_takeover",
  });
  assert.equal(providerUninstallDecision(installationManifest, {
    unknownOperations: 0,
    pendingFunds: 0,
    ownedActiveResources: 0,
  }).allowed, true);
});
