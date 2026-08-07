// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { isPaymentBusinessStatePayable } from "./payment-business-state.js";

test("an unpaid order remains payable only while it is waiting for payment", () => {
  assert.equal(
    isPaymentBusinessStatePayable({
      paymentContext: "order",
      orderStatus: "waiting_payment",
      renewalStatus: null,
      serviceStatus: "pending",
    }),
    true,
  );
  assert.equal(
    isPaymentBusinessStatePayable({
      paymentContext: "order",
      orderStatus: "cancelled",
      renewalStatus: null,
      serviceStatus: "pending",
    }),
    false,
  );
});

test("an invoiced renewal remains payable after delinquency suspension", () => {
  for (const serviceStatus of ["active", "suspended"]) {
    assert.equal(
      isPaymentBusinessStatePayable({
        paymentContext: "renewal",
        orderStatus: "completed",
        renewalStatus: "invoiced",
        serviceStatus,
      }),
      true,
    );
  }
});

test("a renewal cannot pay through a terminal or non-invoiced business state", () => {
  assert.equal(
    isPaymentBusinessStatePayable({
      paymentContext: "renewal",
      orderStatus: "completed",
      renewalStatus: "invoiced",
      serviceStatus: "terminated",
    }),
    false,
  );
  assert.equal(
    isPaymentBusinessStatePayable({
      paymentContext: "renewal",
      orderStatus: "completed",
      renewalStatus: "paid",
      serviceStatus: "suspended",
    }),
    false,
  );
  assert.equal(
    isPaymentBusinessStatePayable({
      paymentContext: "renewal",
      orderStatus: "completed",
      renewalStatus: "manual_hold",
      serviceStatus: "suspended",
    }),
    false,
  );
});
