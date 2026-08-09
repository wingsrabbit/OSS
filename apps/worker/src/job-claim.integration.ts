// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  claimSchema016Job,
  findSchema016GenericRecoveryCandidates,
  lockSchema016ActiveJob,
  lockSchema016StaleJob,
} from "./job-claim.js";

type ClaimedJob = pg.QueryResultRow & {
  id: string;
  job_type: string;
  unique_key: string;
  payload: Record<string, unknown>;
  payload_snapshot: string;
  attempts: number;
  locked_at_epoch: string;
  locked_by: string | null;
};

type StaleJob = ClaimedJob;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 2,
  connectionTimeoutMillis: 5_000,
  options: "-c search_path=pg_catalog,public",
  statement_timeout: 15_000,
  application_name: "opensales-worker-job-claim-integration",
});

const suffix = randomUUID();
const unknownKey = `schema017-unknown-${suffix}`;
const knownKey = `schema016-known-${suffix}`;
const unknownStaleKey = `schema017-stale-${suffix}`;
const knownStaleKey = `schema016-stale-${suffix}`;

try {
  const inserted = await pool.query<{
    id: string;
    job_type: string;
    unique_key: string;
    payload: Record<string, unknown>;
    payload_snapshot: string;
    attempts: number;
    locked_at_epoch: string | null;
    locked_by: string | null;
  }>(
    `INSERT INTO public.durable_jobs(
       job_type, unique_key, payload, status, available_at, attempts,
       locked_at, locked_by
     ) VALUES
       ('schema017.reconciliation', $1, $5::jsonb, 'pending',
        now() - interval '4 minutes', 0, NULL, NULL),
       ('notification.send', $2, $6::jsonb, 'pending',
        now() - interval '3 minutes', 0, NULL, NULL),
       ('schema017.reconciliation', $3, $7::jsonb, 'running',
        now() - interval '2 minutes', 7, now() - interval '2 minutes', 'future-worker'),
       ('notification.send', $4, $8::jsonb, 'running',
        now() - interval '1 minute', 3, now() - interval '1 minute', 'stale-schema016-worker')
     RETURNING id, job_type, unique_key, payload,
               payload::text AS payload_snapshot,
               attempts,
               EXTRACT(epoch FROM locked_at)::numeric::text AS locked_at_epoch,
               locked_by`,
    [
      unknownKey,
      knownKey,
      unknownStaleKey,
      knownStaleKey,
      JSON.stringify({ marker: "future-017", nested: { amountMinor: "1250" } }),
      JSON.stringify({ notificationId: randomUUID() }),
      JSON.stringify({ marker: "future-017-running", externalFactId: randomUUID() }),
      `{"notificationId":"${randomUUID()}","large":900719925474099312345}`,
    ],
  );
  const unknownId = inserted.rows.find(
    (row) => row.unique_key === unknownKey,
  )?.id;
  const unknownStaleRow = inserted.rows.find(
    (row) => row.unique_key === unknownStaleKey,
  );
  const knownStaleRow = inserted.rows.find((row) => row.unique_key === knownStaleKey);
  assert.ok(unknownId);
  assert.ok(unknownStaleRow?.locked_at_epoch);
  assert.ok(knownStaleRow?.locked_at_epoch);
  const unknownStale: StaleJob = {
    ...unknownStaleRow,
    locked_at_epoch: unknownStaleRow.locked_at_epoch,
  };
  const knownStale: StaleJob = {
    ...knownStaleRow,
    locked_at_epoch: knownStaleRow.locked_at_epoch,
  };

  const before = await pool.query(
    `SELECT status, attempts, payload, available_at, locked_at, locked_by,
            last_error, created_at, updated_at
     FROM public.durable_jobs
     WHERE id = ANY($1::uuid[])
     ORDER BY id`,
    [[unknownId, unknownStale.id]],
  );
  assert.equal(before.rowCount, 2);

  const claimed = await claimSchema016Job<ClaimedJob>(
    pool,
    "schema-016-boundary-integration",
  );
  assert.ok(claimed);
  assert.equal(claimed.job_type, "notification.send");
  assert.equal(claimed.unique_key, knownKey);
  assert.equal(claimed.attempts, 1);
  assert.equal(claimed.locked_by, "schema-016-boundary-integration");
  assert.ok(claimed.locked_at_epoch);

  const activeClient = await pool.connect();
  try {
    await activeClient.query("BEGIN");
    const unchangedActive = await lockSchema016ActiveJob<ClaimedJob>(
      activeClient,
      claimed,
    );
    assert.equal(unchangedActive?.id, claimed.id);
    await activeClient.query("ROLLBACK");
  } catch (error) {
    await activeClient.query("ROLLBACK");
    throw error;
  } finally {
    activeClient.release();
  }

  await pool.query(
    `UPDATE public.durable_jobs
     SET job_type = 'schema017.reconciliation',
         payload = $2::jsonb
     WHERE id = $1`,
    [
      claimed.id,
      JSON.stringify({ marker: "future-017-active-swap", externalFactId: randomUUID() }),
    ],
  );
  const activeSwapBefore = await pool.query(
    `SELECT status, job_type, unique_key, attempts, payload, available_at,
            locked_at, locked_by, last_error, created_at, updated_at
     FROM public.durable_jobs
     WHERE id = $1`,
    [claimed.id],
  );
  const rejectedActiveClient = await pool.connect();
  try {
    await rejectedActiveClient.query("BEGIN");
    const swappedActive = await lockSchema016ActiveJob<ClaimedJob>(
      rejectedActiveClient,
      claimed,
    );
    assert.equal(swappedActive, null);
    await rejectedActiveClient.query("ROLLBACK");
  } catch (error) {
    await rejectedActiveClient.query("ROLLBACK");
    throw error;
  } finally {
    rejectedActiveClient.release();
  }
  const activeSwapAfter = await pool.query(
    `SELECT status, job_type, unique_key, attempts, payload, available_at,
            locked_at, locked_by, last_error, created_at, updated_at
     FROM public.durable_jobs
     WHERE id = $1`,
    [claimed.id],
  );
  assert.deepEqual(activeSwapAfter.rows, activeSwapBefore.rows);

  const next = await claimSchema016Job<ClaimedJob>(
    pool,
    "schema-016-boundary-integration",
  );
  assert.equal(next, null);

  const recoveryCandidates = await findSchema016GenericRecoveryCandidates<StaleJob>(
    pool,
    1,
  );
  assert.equal(
    recoveryCandidates.some((candidate) => candidate.id === unknownStale.id),
    false,
  );
  assert.equal(
    recoveryCandidates.some((candidate) => candidate.id === knownStale.id),
    true,
  );

  const unchangedClient = await pool.connect();
  try {
    await unchangedClient.query("BEGIN");
    const lockedKnown = await lockSchema016StaleJob<StaleJob>(
      unchangedClient,
      knownStale,
      1,
    );
    assert.equal(lockedKnown?.id, knownStale.id);
    assert.equal(lockedKnown?.payload_snapshot, knownStale.payload_snapshot);
    assert.equal(lockedKnown?.locked_at_epoch, knownStale.locked_at_epoch);
    await unchangedClient.query("ROLLBACK");
  } catch (error) {
    await unchangedClient.query("ROLLBACK");
    throw error;
  } finally {
    unchangedClient.release();
  }

  await pool.query(
    `UPDATE public.durable_jobs
     SET job_type = 'schema017.reconciliation',
         payload = $2::jsonb
     WHERE id = $1`,
    [
      knownStale.id,
      JSON.stringify({ marker: "future-017-type-swap", externalFactId: randomUUID() }),
    ],
  );
  const swappedBefore = await pool.query(
    `SELECT status, job_type, unique_key, attempts, payload, available_at,
            locked_at, locked_by, last_error, created_at, updated_at
     FROM public.durable_jobs
     WHERE id = $1`,
    [knownStale.id],
  );
  assert.equal(swappedBefore.rowCount, 1);

  const guardClient = await pool.connect();
  try {
    await guardClient.query("BEGIN");
    const guardedUnknown = await lockSchema016StaleJob<ClaimedJob>(
      guardClient,
      unknownStale,
      1,
    );
    assert.equal(guardedUnknown, null);
    const guardedTypeSwap = await lockSchema016StaleJob<ClaimedJob>(
      guardClient,
      knownStale,
      1,
    );
    assert.equal(guardedTypeSwap, null);
    await guardClient.query("ROLLBACK");
  } catch (error) {
    await guardClient.query("ROLLBACK");
    throw error;
  } finally {
    guardClient.release();
  }

  const after = await pool.query(
    `SELECT status, attempts, payload, available_at, locked_at, locked_by,
            last_error, created_at, updated_at
     FROM public.durable_jobs
     WHERE id = ANY($1::uuid[])
     ORDER BY id`,
    [[unknownId, unknownStale.id]],
  );
  assert.equal(after.rowCount, 2);
  assert.deepEqual(after.rows, before.rows);
  const swappedAfter = await pool.query(
    `SELECT status, job_type, unique_key, attempts, payload, available_at,
            locked_at, locked_by, last_error, created_at, updated_at
     FROM public.durable_jobs
     WHERE id = $1`,
    [knownStale.id],
  );
  assert.deepEqual(swappedAfter.rows, swappedBefore.rows);

  console.log(
    JSON.stringify({
      journey: "schema-016-worker-job-boundary",
      knownJobClaimed: true,
      unchangedActiveLeaseLocks: true,
      activeCandidateSwapRejected: true,
      unknownPendingJobUntouched: true,
      unknownStaleRunningJobUntouched: true,
      unchangedKnownStaleJobLocks: true,
      staleRowLockRechecksKnownType: true,
      candidateTypeSwapRejected: true,
      candidateSnapshotRechecked: true,
    }),
  );
} finally {
  await pool.query(
    "DELETE FROM public.durable_jobs WHERE unique_key = ANY($1::text[])",
    [[unknownKey, knownKey, unknownStaleKey, knownStaleKey]],
  );
  await pool.end();
}
