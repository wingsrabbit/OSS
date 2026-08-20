// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_TRANSPORT_VERSION,
  capabilityMutationOperations,
  capabilityOperations,
  providerCapabilities,
  type ProviderManifest,
} from "@opensales/provider-contracts";
import { mockReliabilityScenarios, requestFor } from "./conformance.js";
import { runProviderManagementLifecycleConformance } from "./management-lifecycle.js";

test("conformance request vectors cover every public mutation across all six capabilities", () => {
  let vector = 0;
  for (const capability of providerCapabilities) {
    for (const action of capabilityMutationOperations[capability]) {
      vector += 1;
      const operationId = `00000000-0000-4000-8000-${String(vector).padStart(12, "0")}`;
      const request = requestFor(capability, operationId, `intent-${action}`, action);
      assert.equal(request.transportVersion, PROVIDER_TRANSPORT_VERSION);
      assert.equal(request.contractVersion, PROVIDER_CONTRACT_VERSION);
      assert.equal(request.capability, capability);
      assert.equal(request.action, action);
      assert.equal(request.operationId, operationId);
    }
  }
  assert.equal(vector, 14);
});

test("Mock reliability profile names only functional product scenarios", () => {
  assert.deepEqual(mockReliabilityScenarios, [
    "normal",
    "failure",
    "duplicate",
    "out_of_order",
    "timeout",
    "restart",
  ]);
});

test("public management lifecycle conformance covers normal pause, rotation, limits, ownership, and revoke", () => {
  const manifest: ProviderManifest = {
    manifestVersion: "v1",
    providerId: "opensales.lifecycle-conformance",
    displayName: "Lifecycle conformance fixture",
    description: "Synthetic six-capability management lifecycle fixture.",
    endpointBaseUrl: "https://provider.example.test",
    publisher: {
      name: "OpenSales conformance",
      website: "https://example.test",
      supportUrl: "https://example.test/support",
    },
    license: { identifier: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
    capabilities: providerCapabilities.map((capability) => ({
      capability,
      contractVersion: PROVIDER_CONTRACT_VERSION,
      operations: [...capabilityOperations[capability]],
      eventSubscriptions: [`core.${capability}.requested`],
    })),
    permissions: {
      scopes: providerCapabilities.map((capability) => `${capability}.operate`),
      dataFields: ["synthetic_refs"],
      secrets: [{
        name: "PROVIDER_TOKEN",
        purpose: "Synthetic bearer credential",
        required: true,
        rotation: "required",
      }],
    },
    limits: { maxConcurrentOperations: 2, maxAmountMinor: "1000", maxOwnedResources: 2 },
    retention: { operationDays: 1, eventDays: 1, piiDays: 0 },
    lifecycle: {
      supportsPause: true,
      supportsCredentialRotation: true,
      supportsManualTakeover: true,
      uninstallRequiresNoUnknownOperations: true,
      uninstallRequiresNoOwnedResources: true,
      uninstallRequiresNoPendingFunds: true,
    },
  };
  const report = runProviderManagementLifecycleConformance(manifest);
  assert.equal(report.pauseBlockedNewMutationWithoutSideEffect, true);
  assert.deepEqual(report.rotationOverlapAcceptedVersions, [1, 2]);
  assert.deepEqual(report.uninstallBlockers, [
    "unknown_operations",
    "pending_funds",
    "owned_active_resources",
  ]);
  assert.equal(report.uninstallAllowedAfterDrain, true);
  assert.equal(report.revokeBlockedNewMutation, true);
  assert.equal(report.admittedMutationSideEffects, 8);
});
