// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  projectRenewalReminderStatus,
  type RenewalReminderProjectionInput,
} from "./renewal-reminder-status.js";

const providerAt = new Date("2026-08-10T01:02:03.000Z");
const suppressedAt = new Date("2026-08-10T02:03:04.000Z");
const genericAt = new Date("2026-08-10T03:04:05.000Z");

function projection(
  input: Partial<RenewalReminderProjectionInput>,
): ReturnType<typeof projectRenewalReminderStatus> {
  return projectRenewalReminderStatus({
    deliveryStatus: null,
    providerOccurredAt: null,
    genericOperationStatus: "queued",
    genericAttemptNumber: 1,
    genericFactStatus: null,
    genericRecordedAt: null,
    genericUpdatedAt: genericAt,
    suppressedAt: null,
    jobStatus: "pending",
    jobAttempts: 0,
    ...input,
  });
}

test("delivered and bounced facts remain authoritative across suppression races", () => {
  for (const deliveryStatus of ["delivered", "bounced"] as const) {
    assert.deepEqual(
      projection({ deliveryStatus, providerOccurredAt: providerAt, suppressedAt }),
      { status: deliveryStatus, outcomeAt: providerAt },
    );
  }
});

test("business suppression supersedes an earlier failed attempt", () => {
  assert.deepEqual(
    projection({
      deliveryStatus: "failed",
      providerOccurredAt: providerAt,
      genericOperationStatus: "skipped",
      genericAttemptNumber: 2,
      genericFactStatus: "skipped",
      genericRecordedAt: genericAt,
      suppressedAt,
      jobStatus: "completed",
    }),
    { status: "suppressed", outcomeAt: suppressedAt },
  );
});

test("recipient withdrawal is visible as skipped without business suppression", () => {
  assert.deepEqual(
    projection({
      genericOperationStatus: "skipped",
      genericFactStatus: "skipped",
      genericRecordedAt: genericAt,
      jobStatus: "completed",
    }),
    { status: "skipped", outcomeAt: genericAt },
  );
});

test("a later queued or unknown attempt projects retrying", () => {
  for (const genericOperationStatus of ["queued", "unknown"] as const) {
    assert.deepEqual(
      projection({
        deliveryStatus: "failed",
        providerOccurredAt: providerAt,
        genericOperationStatus,
        genericAttemptNumber: 2,
        jobStatus: "pending",
      }),
      { status: "retrying", outcomeAt: providerAt },
    );
  }
});

test("manual attention outranks an earlier failed outcome", () => {
  assert.deepEqual(
    projection({
      deliveryStatus: "failed",
      providerOccurredAt: providerAt,
      genericOperationStatus: "failed",
      genericAttemptNumber: 3,
      genericFactStatus: "failed",
      jobStatus: "manual",
    }),
    { status: "manual", outcomeAt: genericAt },
  );
});

test("failure is exposed only after retry and manual states are exhausted", () => {
  assert.deepEqual(
    projection({
      deliveryStatus: "failed",
      providerOccurredAt: providerAt,
      genericOperationStatus: "failed",
      genericFactStatus: "failed",
      jobStatus: "completed",
    }),
    { status: "failed", outcomeAt: providerAt },
  );
});
