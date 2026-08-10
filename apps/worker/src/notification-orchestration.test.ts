// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { isTransientNotificationFailure } from "./notification-orchestration.js";

test("notification database timeouts never consume the Provider-attempt budget", () => {
  for (const message of [
    "timeout exceeded when trying to connect",
    "timeout expired",
    "Connection terminated due to connection timeout",
    "Connection terminated unexpectedly",
    "Connection terminated",
  ]) {
    assert.equal(isTransientNotificationFailure(new Error(message)), true);
  }
  assert.equal(
    isTransientNotificationFailure(Object.assign(new Error("serialization"), { code: "40001" })),
    true,
  );
  for (const code of ["40003", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH"]) {
    assert.equal(
      isTransientNotificationFailure(Object.assign(new Error("database transport"), { code })),
      true,
    );
  }
  assert.equal(
    isTransientNotificationFailure(
      new Error("Connection terminated due to connection timeout", {
        cause: new Error("timeout expired"),
      }),
    ),
    true,
  );
  assert.equal(isTransientNotificationFailure(new Error("contract invariant failed")), false);
});
