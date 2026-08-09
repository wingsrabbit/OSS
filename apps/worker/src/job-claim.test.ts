// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import {
  attemptJobClaim,
  claimSchema016Job,
  SCHEMA_016_SUPPORTED_JOB_TYPES,
} from "./job-claim.js";

test("schema 016 claims only the closed set of job types it understands", async () => {
  const expectedJob = {
    id: "known-job",
    job_type: "notification.send",
    unique_key: "known-job",
    payload: {},
    attempts: 1,
  };
  const pool = {
    async query(text: string, values: unknown[]) {
      assert.match(text, /job_type = ANY\(\$2::text\[\]\)/);
      assert.equal(values[0], "worker-boundary-test");
      assert.deepEqual(values[1], [...SCHEMA_016_SUPPORTED_JOB_TYPES]);
      assert.equal(
        (values[1] as string[]).includes("schema017.reconciliation"),
        false,
      );
      return { rows: [expectedJob] };
    },
  } as unknown as Pick<pg.Pool, "query">;

  const claimed = await claimSchema016Job<typeof expectedJob>(
    pool,
    "worker-boundary-test",
  );

  assert.deepEqual(claimed, expectedJob);
});

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
