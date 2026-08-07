// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureScheduledBillingJob,
  SCHEDULE_BILLING_JOB_SQL,
} from "./billing-scheduler.js";

test("scheduled billing preserves terminal jobs for manual inspection", async () => {
  let executed = "";
  const scheduled = await ensureScheduledBillingJob({
    async query(text) {
      executed = text;
      return { rowCount: 0 };
    },
  });

  assert.equal(scheduled, 0);
  assert.equal(executed, SCHEDULE_BILLING_JOB_SQL);
  assert.match(executed, /ON CONFLICT \(job_type, unique_key\) DO NOTHING/);
  assert.doesNotMatch(executed, /ON CONFLICT[\s\S]*DO UPDATE/);
  assert.doesNotMatch(executed, /status\s+IN\s*\('failed',\s*'manual'\)/);
});
