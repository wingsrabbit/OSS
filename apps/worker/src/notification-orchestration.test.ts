// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  currentUserNotificationPreferenceAllowsAtDispatch,
  isTransientNotificationFailure,
} from "./notification-orchestration.js";

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

test("notification dequeue honors the current optional User preference", async () => {
  const queries: Array<readonly unknown[] | undefined> = [];
  const disabledDatabase = {
    query: async (_text: string, values?: readonly unknown[]) => {
      queries.push(values);
      return { rows: [{ enabled: false }] };
    },
  } as unknown as Parameters<typeof currentUserNotificationPreferenceAllowsAtDispatch>[0];
  assert.equal(
    await currentUserNotificationPreferenceAllowsAtDispatch(disabledDatabase, {
      userId: "00000000-0000-4000-8000-000000000401",
      preferenceCategory: "support",
      requiredDelivery: false,
    }),
    false,
  );
  assert.deepEqual(queries, [[
    "00000000-0000-4000-8000-000000000401",
    "support",
  ]]);

  const missingDatabase = {
    query: async () => ({ rows: [] }),
  } as unknown as Parameters<typeof currentUserNotificationPreferenceAllowsAtDispatch>[0];
  assert.equal(
    await currentUserNotificationPreferenceAllowsAtDispatch(missingDatabase, {
      userId: "00000000-0000-4000-8000-000000000402",
      preferenceCategory: "billing",
      requiredDelivery: false,
    }),
    true,
  );
});

test("notification dequeue never suppresses required delivery or non-User recipients", async () => {
  let queryCount = 0;
  const database = {
    query: async () => {
      queryCount += 1;
      return { rows: [{ enabled: false }] };
    },
  } as unknown as Parameters<typeof currentUserNotificationPreferenceAllowsAtDispatch>[0];
  assert.equal(
    await currentUserNotificationPreferenceAllowsAtDispatch(database, {
      userId: "00000000-0000-4000-8000-000000000403",
      preferenceCategory: "identity",
      requiredDelivery: true,
    }),
    true,
  );
  assert.equal(
    await currentUserNotificationPreferenceAllowsAtDispatch(database, {
      userId: null,
      preferenceCategory: "support",
      requiredDelivery: false,
    }),
    true,
  );
  assert.equal(queryCount, 0);
});
