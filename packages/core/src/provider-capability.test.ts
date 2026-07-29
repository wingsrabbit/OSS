// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  providerOperationCapability,
  providerOperationCapabilityMatches,
} from "./provider-capability.js";

test("Provider operation capabilities are installation- and operation-bound", () => {
  const secret = "synthetic-core-only-capability-secret";
  const operationId = "00000000-0000-4000-8000-000000000001";
  const capability = providerOperationCapability(secret, "mock-payment-v1", operationId);

  assert.match(capability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    providerOperationCapabilityMatches(
      capability,
      secret,
      "mock-payment-v1",
      operationId,
    ),
    true,
  );
  assert.equal(
    providerOperationCapabilityMatches(
      capability,
      secret,
      "mock-payment-v1",
      "00000000-0000-4000-8000-000000000002",
    ),
    false,
  );
  assert.equal(
    providerOperationCapabilityMatches(capability, secret, "other-payment-v1", operationId),
    false,
  );
});
