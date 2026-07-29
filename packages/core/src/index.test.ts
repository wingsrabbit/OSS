// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  addBillingCycle,
  buildPriceSnapshot,
  canTransitionPayment,
  percentageFeeMinor,
} from "./index.js";

test("price snapshots use exact minor units and include option quantity", () => {
  const price = buildPriceSnapshot({
    productId: "gsl-inbound",
    productName: "GSL Inbound",
    currency: "USD",
    billingCycle: "monthly",
    fulfillmentMode: "manual",
    baseOneTimeMinor: 0n,
    setupMinor: 0n,
    baseRecurringMinor: 0n,
    optionComponents: [
      {
        code: "bandwidth",
        label: "100 Mbps unit",
        quantity: 3,
        oneTimeMinor: 0n,
        recurringMinor: 4_700n,
      },
    ],
  });
  assert.equal(price.invoiceTotalMinor, 14_100n);
});

test("settled payment cannot be moved backwards by a late event", () => {
  assert.equal(canTransitionPayment("processing", "succeeded"), true);
  assert.equal(canTransitionPayment("succeeded", "failed"), false);
  assert.equal(canTransitionPayment("unknown", "succeeded"), true);
});

test("calendar billing clamps month end", () => {
  assert.equal(
    addBillingCycle(new Date("2026-01-31T12:00:00.000Z"), "monthly")?.toISOString(),
    "2026-02-28T12:00:00.000Z",
  );
});

test("percentage fees use the non-fee minor-unit base and round half up", () => {
  assert.equal(percentageFeeMinor(10_000n, 350), 350n);
  assert.equal(percentageFeeMinor(299n, 350), 10n);
  assert.equal(percentageFeeMinor(300n, 350), 11n);
  assert.equal(percentageFeeMinor(0n, 350), 0n);
  assert.equal(percentageFeeMinor(10_000n, 0), 0n);
});
