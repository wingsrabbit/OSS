// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { serviceOperationTransaction } from "./service-operations.js";

function fakePool(input: Readonly<{ rollbackFails: boolean }>) {
  const queries: string[] = [];
  const releases: Array<boolean | Error | undefined> = [];
  const client = {
    async query(text: string) {
      queries.push(text);
      if (text === "ROLLBACK" && input.rollbackFails) {
        throw new Error("synthetic broken connection during rollback");
      }
      return { rows: [], rowCount: 0 };
    },
    release(discard?: boolean | Error) {
      releases.push(discard);
    },
  };
  return {
    pool: { connect: async () => client } as unknown as pg.Pool,
    queries,
    releases,
  };
}

test("service operation transaction preserves the original error and discards a client that cannot roll back", async () => {
  const original = new Error("synthetic operation persistence failure");
  const fixture = fakePool({ rollbackFails: true });

  await assert.rejects(
    serviceOperationTransaction(fixture.pool, async () => {
      throw original;
    }),
    (error: unknown) => error === original,
  );

  assert.deepEqual(fixture.queries, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(fixture.releases, [true]);
});

test("service operation transaction returns a healthy rolled-back client to the pool", async () => {
  const original = new Error("synthetic transient database timeout without a code");
  const fixture = fakePool({ rollbackFails: false });

  await assert.rejects(
    serviceOperationTransaction(fixture.pool, async () => {
      throw original;
    }),
    (error: unknown) => error === original,
  );

  assert.deepEqual(fixture.queries, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(fixture.releases, [false]);
});
