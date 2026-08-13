// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_TRANSPORT_VERSION,
  capabilityOperations,
  parseProviderEvent,
  parseProviderManifest,
  parseProviderOperationRequest,
  parseProviderOperationResult,
  providerCapabilities,
  type ProviderCapability,
  type ProviderOperationRequest,
} from "./index.js";

const operationId = "00000000-0000-4000-8000-000000000001";
const now = "2026-08-13T00:00:00.000Z";

function requestFor(capability: ProviderCapability): ProviderOperationRequest {
  const base = {
    transportVersion: PROVIDER_TRANSPORT_VERSION,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    operationId,
    requestedAt: now,
    intentRef: `intent-${capability}`,
  } as const;
  switch (capability) {
    case "payment":
      return { ...base, capability, action: "payment.capture", input: { amountMinor: "100", currency: "USD" } };
    case "provisioning":
      return { ...base, capability, action: "resource.create", input: { serviceRef: "service-1", planRef: "plan-1" } };
    case "mail":
      return { ...base, capability, action: "mail.send", input: { recipient: "synthetic@example.test", templateRef: "welcome-v1", locale: "en", subject: "Welcome", textBody: "Synthetic message" } };
    case "verification":
      return { ...base, capability, action: "verification.evaluate", input: { subjectRef: "subject-1", purpose: "account_eligibility", checks: ["email_ownership"] } };
    case "tax":
      return { ...base, capability, action: "tax.quote", input: { currency: "USD", jurisdictionCountry: "US", lines: [{ lineRef: "line-1", amountMinor: "100", taxCode: "general" }] } };
    case "anti_abuse_challenge":
      return { ...base, capability, action: "challenge.evaluate", input: { subjectRef: "subject-1", actionRef: "checkout-1", signals: { syntheticRiskBand: "medium" } } };
  }
}

test("all six capability requests validate and reject cross-capability actions", () => {
  for (const capability of providerCapabilities) {
    assert.deepEqual(parseProviderOperationRequest(requestFor(capability)), requestFor(capability));
  }
  assert.throws(
    () => parseProviderOperationRequest({ ...requestFor("payment"), action: "mail.send" }),
    /Invalid Provider operation-request/,
  );
});

test("manifest declares version, permissions, data, secrets, limits, retention, and lifecycle", () => {
  const manifest = {
    manifestVersion: "v1",
    providerId: "opensales.synthetic-provider",
    displayName: "Synthetic Provider",
    description: "Synthetic six-capability Provider for functional tests only.",
    endpointBaseUrl: "https://provider.example.test/provider",
    publisher: { name: "OpenSales contributors", website: "https://example.test", supportUrl: "https://example.test/support" },
    license: { identifier: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
    capabilities: providerCapabilities.map((capability) => ({
      capability,
      contractVersion: PROVIDER_CONTRACT_VERSION,
      operations: [...capabilityOperations[capability]],
      eventSubscriptions: [`core.${capability}.requested`],
    })),
    permissions: {
      scopes: providerCapabilities.map((capability) => `${capability}.operate`),
      dataFields: ["opaque_subject_ref", "minor_units", "synthetic_delivery_address"],
      secrets: [{ name: "PROVIDER_API_TOKEN", purpose: "Bearer credential", required: true, rotation: "required" }],
    },
    limits: { maxConcurrentOperations: 16, maxAmountMinor: "100000000", maxOwnedResources: 1000 },
    retention: { operationDays: 30, eventDays: 30, piiDays: 7 },
    lifecycle: {
      supportsPause: true,
      supportsCredentialRotation: true,
      supportsManualTakeover: true,
      uninstallRequiresNoUnknownOperations: true,
      uninstallRequiresNoOwnedResources: true,
      uninstallRequiresNoPendingFunds: true,
    },
  };
  assert.equal(parseProviderManifest(manifest).capabilities.length, 6);
  assert.throws(() => parseProviderManifest({ ...manifest, limits: {} }), /Invalid Provider manifest/);
});

test("result and event envelopes bind capability, operation, sequence, and version", () => {
  const result = {
    transportVersion: PROVIDER_TRANSPORT_VERSION,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    capability: "payment",
    operationId,
    status: "succeeded",
    revision: 2,
    observedAt: now,
    output: { externalPaymentRef: "external-1", paymentState: "captured", amountMinor: "100", currency: "USD" },
  };
  assert.equal(parseProviderOperationResult(result).revision, 2);
  assert.equal(parseProviderEvent({
    transportVersion: PROVIDER_TRANSPORT_VERSION,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    eventId: "00000000-0000-4000-8000-000000000002",
    providerId: "opensales.synthetic-provider",
    capability: "payment",
    operationId,
    sequence: 2,
    eventType: "operation.succeeded",
    observedAt: now,
    result,
  }).sequence, 2);
  assert.throws(() => parseProviderEvent({
    transportVersion: PROVIDER_TRANSPORT_VERSION,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    eventId: "00000000-0000-4000-8000-000000000003",
    providerId: "opensales.synthetic-provider",
    capability: "mail",
    operationId,
    sequence: 2,
    eventType: "operation.succeeded",
    observedAt: now,
    result,
  }), /must match the outer capability/);
  assert.throws(() => parseProviderOperationResult({ ...result, status: "failed" }), /Invalid Provider operation-result/);
});
