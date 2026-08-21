// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_TRANSPORT_VERSION,
  providerCapabilities,
  type ProviderOperationRequest,
} from "@opensales/provider-contracts";
import { createExampleOperation, exampleManifest } from "./provider.js";

test("official example declares all six capabilities without importing Core", () => {
  assert.deepEqual(
    exampleManifest("http://127.0.0.1:4401").capabilities.map(({ capability }) => capability),
    [...providerCapabilities],
  );
});

test("official example builds a public tax result and event", async () => {
  const request: ProviderOperationRequest = {
    transportVersion: PROVIDER_TRANSPORT_VERSION,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    operationId: "00000000-0000-4000-8000-000000000001",
    requestedAt: "2026-08-13T00:00:00.000Z",
    intentRef: "synthetic-tax",
    capability: "tax",
    action: "tax.quote",
    input: {
      currency: "USD",
      jurisdictionCountry: "US",
      lines: [{ lineRef: "line-1", amountMinor: "1999", taxCode: "general" }],
    },
  };
  const operation = await createExampleOperation("opensales.example.official-sdk", request);
  assert.equal(operation.result.status, "succeeded");
  assert.equal(operation.event.result.operationId, request.operationId);
});
