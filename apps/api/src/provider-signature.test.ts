// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { canonicalProviderJson, providerSignature } from "./provider-signature.js";

test("Provider signatures are independent of JSON object insertion order", () => {
  const secret = "synthetic-provider-signature-secret";
  const timestamp = "1785312000000";
  const first = {
    eventId: "event-1",
    operation: { id: "operation-1", status: "succeeded" },
    evidence: ["receipt-1", "receipt-2"],
  };
  const reordered = {
    evidence: ["receipt-1", "receipt-2"],
    operation: { status: "succeeded", id: "operation-1" },
    eventId: "event-1",
  };

  assert.equal(canonicalProviderJson(first), canonicalProviderJson(reordered));
  assert.equal(
    providerSignature(secret, timestamp, first),
    providerSignature(secret, timestamp, reordered),
  );
});

test("Provider signatures still bind array order and values", () => {
  const secret = "synthetic-provider-signature-secret";
  const timestamp = "1785312000000";
  const original = { evidence: ["receipt-1", "receipt-2"] };
  const reordered = { evidence: ["receipt-2", "receipt-1"] };

  assert.notEqual(
    providerSignature(secret, timestamp, original),
    providerSignature(secret, timestamp, reordered),
  );
});
