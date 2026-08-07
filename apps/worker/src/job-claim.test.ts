// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { attemptJobClaim } from "./job-claim.js";

test("a transient database claim failure is returned without terminating the worker loop", async () => {
  const failure = new Error("canceling statement due to statement timeout");

  const result = await attemptJobClaim(async () => {
    throw failure;
  });

  assert.deepEqual(result, { kind: "failed", error: failure });
});

test("a later claim can succeed after an earlier transient database failure", async () => {
  let calls = 0;
  const claim = async (): Promise<{ id: string } | null> => {
    calls += 1;
    if (calls === 1) throw new Error("canceling statement due to statement timeout");
    return { id: "job-after-retry" };
  };

  const first = await attemptJobClaim(claim);
  const second = await attemptJobClaim(claim);

  assert.equal(first.kind, "failed");
  assert.deepEqual(second, { kind: "claimed", job: { id: "job-after-retry" } });
  assert.equal(calls, 2);
});

test("an empty queue remains distinct from a database claim failure", async () => {
  const result = await attemptJobClaim(async () => null);

  assert.deepEqual(result, { kind: "claimed", job: null });
});
