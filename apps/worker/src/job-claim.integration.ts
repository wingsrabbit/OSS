// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { claimSchema016Job } from "./job-claim.js";

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

try {
  const inserted = await pool.query<{ id: string; job_type: string }>(
    `INSERT INTO public.durable_jobs(
       job_type, unique_key, payload, status, available_at, attempts
     ) VALUES
       ('schema017.reconciliation', $1, $3::jsonb, 'pending', now() - interval '2 minutes', 0),
       ('notification.send', $2, $4::jsonb, 'pending', now() - interval '1 minute', 0)
     RETURNING id, job_type`,
    [
      unknownKey,
      knownKey,
      JSON.stringify({ marker: "future-017", nested: { amountMinor: "1250" } }),
      JSON.stringify({ notificationId: randomUUID() }),
    ],
  );
  const unknownId = inserted.rows.find(
    (row) => row.job_type === "schema017.reconciliation",
  )?.id;
  assert.ok(unknownId);

  const before = await pool.query(
    `SELECT status, attempts, payload, available_at, locked_at, locked_by,
            last_error, created_at, updated_at
     FROM public.durable_jobs
     WHERE id = $1`,
    [unknownId],
  );
  assert.equal(before.rowCount, 1);

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

  const after = await pool.query(
    `SELECT status, attempts, payload, available_at, locked_at, locked_by,
            last_error, created_at, updated_at
     FROM public.durable_jobs
     WHERE id = $1`,
    [unknownId],
  );
  assert.equal(after.rowCount, 1);
  assert.deepEqual(after.rows[0], before.rows[0]);

  console.log(
    JSON.stringify({
      journey: "schema-016-worker-job-boundary",
      knownJobClaimed: true,
      unknownFutureJobUntouched: true,
    }),
  );
} finally {
  await pool.query(
    "DELETE FROM public.durable_jobs WHERE unique_key = ANY($1::text[])",
    [[unknownKey, knownKey]],
  ).catch(() => undefined);
  await pool.end();
}
