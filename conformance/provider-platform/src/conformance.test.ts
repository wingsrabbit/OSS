// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_TRANSPORT_VERSION,
  providerCapabilities,
} from "@opensales/provider-contracts";
import { mockReliabilityScenarios, requestFor } from "./conformance.js";

test("conformance request vectors cover all six public capability contracts", () => {
  for (const [index, capability] of providerCapabilities.entries()) {
    const operationId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const request = requestFor(capability, operationId, `intent-${capability}`);
    assert.equal(request.transportVersion, PROVIDER_TRANSPORT_VERSION);
    assert.equal(request.contractVersion, PROVIDER_CONTRACT_VERSION);
    assert.equal(request.capability, capability);
    assert.equal(request.operationId, operationId);
  }
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
