// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_TRANSPORT_VERSION,
  type AntiAbuseChallengeOperationRequest,
  type ProvisioningOperationRequest,
  type TaxOperationRequest,
  type VerificationOperationRequest,
} from "@opensales/provider-contracts";
import {
  createProviderRequestFingerprintKeyring,
  createMockProviderManifest,
  createMockProviderOperationResult,
  passwordRequestFingerprintKeyVersion,
  providerPersistenceFingerprint,
  redactedStoredRequest,
  upgradeLegacyPasswordChangeRequest,
} from "./provider-platform.js";

const base = {
  transportVersion: PROVIDER_TRANSPORT_VERSION,
  contractVersion: PROVIDER_CONTRACT_VERSION,
  operationId: "00000000-0000-4000-8000-000000000001",
  requestedAt: "2026-08-13T00:00:00.000Z",
  intentRef: "synthetic-intent-1",
} as const;

test("Mock Provider manifest exposes all six versioned functional capabilities", () => {
  const manifest = createMockProviderManifest("http://127.0.0.1:4300");
  assert.deepEqual(
    manifest.capabilities.map(({ capability }) => capability),
    ["payment", "provisioning", "mail", "verification", "tax", "anti_abuse_challenge"],
  );
  assert.equal(manifest.license.identifier, "Apache-2.0");
  assert.equal(manifest.lifecycle.uninstallRequiresNoUnknownOperations, true);
});

test("Mock password changes redact the transient password before durable history", () => {
  const transientPassword = "p".repeat(20);
  const request: ProvisioningOperationRequest = {
    ...base,
    capability: "provisioning",
    action: "resource.change_password",
    input: {
      serviceRef: "service-1",
      planRef: "plan-1",
      externalResourceRef: "mock-resource-1",
      configuration: { password: transientPassword },
    },
  };
  const stored = redactedStoredRequest(request);
  assert.equal((stored as ProvisioningOperationRequest).input.configuration?.password, "[REDACTED]");
  assert.equal(JSON.stringify(stored).includes(transientPassword), false);
  assert.equal(request.input.configuration?.password, transientPassword);
  assert.throws(() =>
    redactedStoredRequest({
      ...request,
      input: { ...request.input, configuration: { password: "short" } },
    }),
  );
  assert.throws(() =>
    redactedStoredRequest({
      ...request,
      input: {
        ...request.input,
        configuration: {
          password: transientPassword,
          passwordConfirmation: transientPassword,
        },
      },
    }),
  );
});

test("Mock password-change replay fingerprints bind the exact transient password across key rotation", async () => {
  const firstPassword = `${"a".repeat(16)}-first`;
  const secondPassword = `${"b".repeat(16)}-second`;
  const request: ProvisioningOperationRequest = {
    ...base,
    capability: "provisioning",
    action: "resource.change_password",
    input: {
      serviceRef: "service-1",
      planRef: "plan-1",
      externalResourceRef: "mock-resource-1",
      configuration: { password: firstPassword },
    },
  };
  const firstKey = Buffer.alloc(32, 1).toString("base64url");
  const secondKey = Buffer.alloc(32, 2).toString("base64url");
  const firstKeyring = createProviderRequestFingerprintKeyring(1, firstKey);
  const rotatedKeyring = createProviderRequestFingerprintKeyring(2, secondKey, `1:${firstKey}`);
  const first = await providerPersistenceFingerprint(request, "normal", firstKeyring);
  const storedVersion = passwordRequestFingerprintKeyVersion(first);
  assert.equal(storedVersion, 1);
  const replay = await providerPersistenceFingerprint(
    request,
    "normal",
    rotatedKeyring,
    storedVersion,
  );
  const changed = await providerPersistenceFingerprint(
    {
      ...request,
      input: {
        ...request.input,
        configuration: { password: secondPassword },
      },
    },
    "normal",
    rotatedKeyring,
    storedVersion,
  );
  const nextOperation = await providerPersistenceFingerprint(request, "normal", rotatedKeyring);

  assert.match(first, /^password-hmac-sha256-v1:1:[0-9a-f]{64}$/);
  assert.match(nextOperation, /^password-hmac-sha256-v1:2:[0-9a-f]{64}$/);
  assert.equal(replay, first);
  assert.notEqual(changed, first);
  assert.notEqual(nextOperation, first);
  assert.equal(first.includes(firstPassword), false);
  assert.equal(changed.includes(secondPassword), false);
  assert.throws(() => createProviderRequestFingerprintKeyring(2, secondKey, `1:${secondKey}`));

  const upgraded = await upgradeLegacyPasswordChangeRequest(request, "normal", firstKeyring);
  assert.ok(upgraded);
  assert.equal(
    (upgraded.requestJson as ProvisioningOperationRequest).input.configuration?.password,
    "[REDACTED]",
  );
  assert.equal(JSON.stringify(upgraded.requestJson).includes(firstPassword), false);
  assert.match(upgraded.requestFingerprint, /^password-hmac-sha256-v1:1:[0-9a-f]{64}$/);
  assert.equal(
    await upgradeLegacyPasswordChangeRequest(upgraded.requestJson, "normal", firstKeyring),
    undefined,
  );
  await assert.rejects(
    upgradeLegacyPasswordChangeRequest(
      {
        ...upgraded.requestJson,
        input: {
          ...upgraded.requestJson.input,
          configuration: {
            password: "[REDACTED]",
            passwordConfirmation: firstPassword,
          },
        },
      },
      "normal",
      firstKeyring,
    ),
    /cannot be upgraded safely/u,
  );
});

test("Verification Mock returns functional evidence rather than Core state", () => {
  const request: VerificationOperationRequest = {
    ...base,
    capability: "verification",
    action: "verification.evaluate",
    input: {
      subjectRef: "synthetic-subject-1",
      purpose: "account_eligibility",
      checks: ["email_ownership", "identity"],
    },
  };
  const result = createMockProviderOperationResult(request, "succeeded", 1, base.requestedAt);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.output, {
    externalEvidenceRef: `mock-evidence-${base.operationId}`,
    verdict: "verified",
    assurance: "high",
    checked: ["email_ownership", "identity"],
  });
});

test("Tax Mock uses integer minor units and exposes an independent tax line fact", () => {
  const request: TaxOperationRequest = {
    ...base,
    capability: "tax",
    action: "tax.quote",
    input: {
      currency: "USD",
      jurisdictionCountry: "US",
      lines: [{ lineRef: "line-1", amountMinor: "1999", taxCode: "general" }],
    },
  };
  const result = createMockProviderOperationResult(request, "succeeded", 1, base.requestedAt);
  assert.deepEqual(result.output, {
    externalQuoteRef: `mock-tax-${base.operationId}`,
    currency: "USD",
    totalTaxMinor: "100",
    lines: [{ lineRef: "line-1", taxMinor: "100", rateBasisPoints: 500 }],
  });
});

test("Anti-abuse Challenge Mock reports an external decision and challenge fact only", () => {
  const request: AntiAbuseChallengeOperationRequest = {
    ...base,
    capability: "anti_abuse_challenge",
    action: "challenge.evaluate",
    input: {
      subjectRef: "synthetic-subject-1",
      actionRef: "synthetic-checkout-1",
      signals: { syntheticDecision: "challenge" },
    },
  };
  const result = createMockProviderOperationResult(request, "succeeded", 1, base.requestedAt);
  assert.deepEqual(result.output, {
    externalDecisionRef: `mock-decision-${base.operationId}`,
    decision: "challenge",
    challengeRef: `mock-challenge-${base.operationId}`,
    challengeState: "pending",
  });
});
