// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_TRANSPORT_VERSION,
  type AntiAbuseChallengeOperationRequest,
  type TaxOperationRequest,
  type VerificationOperationRequest,
} from "@opensales/provider-contracts";
import {
  createMockProviderManifest,
  createMockProviderOperationResult,
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
