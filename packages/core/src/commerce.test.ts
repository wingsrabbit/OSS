// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCommercialPriceSnapshot,
  CommercialValidationError,
  resolveCatalogConfiguration,
} from "./commerce.js";

const schema = [
  {
    code: "shape",
    type: "radio",
    required: true,
    values: [
      "small",
      { value: "large", oneTimeMinor: 200, recurringMinor: 300, capacityUnits: 2 },
    ],
  },
  {
    code: "ports",
    type: "quantity",
    required: true,
    min: 1,
    max: 5,
    recurringUnitMinor: 75,
    capacityUnitsPerUnit: 1,
  },
  {
    code: "routing_note",
    type: "textarea",
    visibleWhen: { code: "shape", equals: "large" },
    required: true,
    minLength: 3,
  },
  {
    code: "bootstrap_secret",
    type: "secret",
    required: true,
  },
] as const;

test("configuration resolves Radio, Quantity, conditions, price impact, and redacted Secret", () => {
  const resolved = resolveCatalogConfiguration(schema, {
    shape: "large",
    ports: 3,
    routing_note: "mock only",
    bootstrap_secret: "never-persist-this",
  });
  assert.deepEqual(resolved.configurationSnapshot, {
    bootstrap_secret: { provided: true },
    ports: 3,
    routing_note: "mock only",
    shape: "large",
  });
  assert.equal(JSON.stringify(resolved.configurationSnapshot).includes("never-persist"), false);
  assert.equal(resolved.capacityUnits, 6n);
  assert.deepEqual(
    resolved.components.map((component) => [
      component.code,
      component.quantity,
      component.oneTimeMinor,
      component.recurringMinor,
    ]),
    [
      ["shape:large", 1, 200n, 300n],
      ["ports", 3, 0n, 75n],
    ],
  );
});

test("hidden conditional values and unknown configuration keys fail closed", () => {
  assert.throws(
    () =>
      resolveCatalogConfiguration(schema, {
        shape: "small",
        ports: 1,
        routing_note: "must be rejected",
        bootstrap_secret: "secret",
      }),
    (error: unknown) =>
      error instanceof CommercialValidationError && /not available/.test(error.message),
  );
  assert.throws(
    () =>
      resolveCatalogConfiguration(schema, {
        shape: "small",
        ports: 1,
        bootstrap_secret: "secret",
        invented: true,
      }),
    /Unknown product option/,
  );
});

test("legacy dependency maps override Quantity minimum from the preceding Select", () => {
  const colocation = [
    { code: "space", type: "select", required: true, values: ["1U", "full_rack"] },
    {
      code: "power_kva",
      type: "quantity",
      required: true,
      min: 1,
      max: 20,
      dependencies: { full_rack: { min: 4 } },
    },
  ];
  assert.throws(
    () => resolveCatalogConfiguration(colocation, { space: "full_rack", power_kva: 2 }),
    /allowed quantity range/,
  );
  assert.equal(
    resolveCatalogConfiguration(colocation, { space: "full_rack", power_kva: 4 })
      .configurationSnapshot.power_kva,
    4,
  );
});

test("fractional Quantity supports exact infrastructure units without fractional money", () => {
  const colocation = [
    { code: "space", type: "select", required: true, values: ["1U", "full_rack"] },
    {
      code: "power_kva",
      type: "quantity",
      required: true,
      min: 0.5,
      max: 20,
      step: 0.5,
      dependencies: { full_rack: { min: 4 } },
    },
  ];
  assert.equal(
    resolveCatalogConfiguration(colocation, { space: "1U", power_kva: 0.5 })
      .configurationSnapshot.power_kva,
    0.5,
  );
  assert.throws(
    () => resolveCatalogConfiguration(colocation, { space: "1U", power_kva: 0.75 }),
    /allowed quantity range/,
  );
  assert.throws(
    () =>
      resolveCatalogConfiguration(
        [{ code: "fractional", type: "quantity", step: 0.5, recurringUnitMinor: 25 }],
        { fractional: 1.5 },
      ),
    /whole number when it changes a price/,
  );
});

test("fixed recurring Promotion is frozen into net renewal and initial totals", () => {
  const snapshot = buildCommercialPriceSnapshot({
    productId: "mock-vps",
    productName: "Mock VPS",
    currency: "USD",
    billingCycle: "monthly",
    fulfillmentMode: "automatic",
    baseOneTimeMinor: 100n,
    setupMinor: 50n,
    baseRecurringMinor: 1_000n,
    optionComponents: [],
    promotion: {
      id: "promotion-1",
      code: "RECUR100",
      revision: 3,
      discountKind: "fixed",
      applicationScope: "recurring",
      fixedAmountMinor: 100n,
      percentageBasisPoints: null,
    },
  });
  assert.equal(snapshot.grossInvoiceTotalMinor, 1_150n);
  assert.equal(snapshot.invoiceTotalMinor, 1_050n);
  assert.equal(snapshot.recurringSubtotalMinor, 900n);
  assert.equal(snapshot.promotion?.recurringDiscountMinor, 100n);
});

test("a 100 percent Promotion produces a legitimate zero-amount snapshot", () => {
  const snapshot = buildCommercialPriceSnapshot({
    productId: "mock-review",
    productName: "Mock Review",
    currency: "USD",
    billingCycle: "one_time",
    fulfillmentMode: "review",
    baseOneTimeMinor: 500n,
    setupMinor: 0n,
    baseRecurringMinor: 0n,
    optionComponents: [],
    promotion: {
      id: "promotion-2",
      code: "ZERO100",
      revision: 1,
      discountKind: "percentage",
      applicationScope: "one_time",
      fixedAmountMinor: null,
      percentageBasisPoints: 10_000,
    },
  });
  assert.equal(snapshot.grossInvoiceTotalMinor, 500n);
  assert.equal(snapshot.invoiceTotalMinor, 0n);
  assert.equal(snapshot.promotion?.oneTimeDiscountMinor, 500n);
});
