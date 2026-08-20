// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_TRANSPORT_VERSION,
  capabilityMutationOperations,
  providerCapabilities,
} from "@opensales/provider-contracts";
import { mockReliabilityScenarios, requestFor } from "./conformance.js";

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
