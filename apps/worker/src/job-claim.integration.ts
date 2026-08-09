// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  claimSchema016Job,
  findSchema016GenericRecoveryCandidates,
  lockSchema016StaleJob,
} from "./job-claim.js";

type ClaimedJob = pg.QueryResultRow & {
  id: string;
  job_type: string;
  unique_key: string;
  payload: Record<string, unknown>;
  attempts: number;
};

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
    attempts: number;
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
     RETURNING id, job_type, unique_key, attempts`,
    [
      unknownKey,
      knownKey,
      unknownStaleKey,
      knownStaleKey,
      JSON.stringify({ marker: "future-017", nested: { amountMinor: "1250" } }),
      JSON.stringify({ notificationId: randomUUID() }),
      JSON.stringify({ marker: "future-017-running", externalFactId: randomUUID() }),
      JSON.stringify({ notificationId: randomUUID() }),
    ],
  );
  const unknownId = inserted.rows.find(
    (row) => row.unique_key === unknownKey,
  )?.id;
  const unknownStale = inserted.rows.find(
    (row) => row.unique_key === unknownStaleKey,
  );
  const knownStale = inserted.rows.find((row) => row.unique_key === knownStaleKey);
  assert.ok(unknownId);
  assert.ok(unknownStale);
  assert.ok(knownStale);

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
  assert.equal(claimed?.job_type, "notification.send");
  assert.equal(claimed?.unique_key, knownKey);
  assert.equal(claimed?.attempts, 1);

  const next = await claimSchema016Job<ClaimedJob>(
    pool,
    "schema-016-boundary-integration",
  );
  assert.equal(next, null);

  const recoveryCandidates = await findSchema016GenericRecoveryCandidates<ClaimedJob>(
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

  const guardClient = await pool.connect();
  try {
    await guardClient.query("BEGIN");
    const guardedUnknown = await lockSchema016StaleJob<ClaimedJob>(
      guardClient,
      unknownStale,
      1,
    );
    assert.equal(guardedUnknown, null);
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

  console.log(
    JSON.stringify({
      journey: "schema-016-worker-job-boundary",
      knownJobClaimed: true,
      unknownPendingJobUntouched: true,
      unknownStaleRunningJobUntouched: true,
      staleRowLockRechecksKnownType: true,
    }),
  );
} finally {
  await pool.query(
    "DELETE FROM public.durable_jobs WHERE unique_key = ANY($1::text[])",
    [[unknownKey, knownKey, unknownStaleKey, knownStaleKey]],
  );
  await pool.end();
}
