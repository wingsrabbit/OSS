// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  assert015RollbackBridgeSafe,
  SCHEMA_016,
  SCHEMA_016_CATALOG_DIGEST,
} from "./schema-015-016-rollback-compatibility.js";
import {
  SCHEMA_015,
  SchemaRollbackPreflightError,
  type RollbackPreflightQueryable,
} from "./schema-rollback-compatibility.js";

function fakeDatabase(input: {
  version?: string | null;
  shape?: boolean;
  blockers?: ReadonlyArray<Readonly<{ code: string; count: string }>>;
  missingTable?: boolean;
}): RollbackPreflightQueryable {
  return {
    query: async (text) => {
      if (text.includes("max(version)")) {
        assert.match(text, /FROM public[.]schema_migrations/);
        if (input.missingTable) throw Object.assign(new Error("missing"), { code: "42P01" });
        return { rows: [{ version: input.version ?? null }] };
      }
      if (text.includes("required_columns")) {
        const valid = input.shape ?? true;
        return {
          rows: [
            {
              has_contiguous_history: valid,
              has_columns: valid,
              has_constraints: valid,
              has_triggers: valid,
              has_functions: valid,
              has_capacity_view: valid,
              catalog_digest: valid ? SCHEMA_016_CATALOG_DIGEST : "counterfeit",
            },
          ],
        };
      }
      return { rows: [...(input.blockers ?? [])] };
    },
  };
}

test("schema 015 is native and unrelated schema versions fail closed", async () => {
  const native = await assert015RollbackBridgeSafe(fakeDatabase({ version: SCHEMA_015 }), {
    enable016RollbackBridge: false,
  });
  assert.equal(native.mode, "native");

  await assert.rejects(
    assert015RollbackBridgeSafe(fakeDatabase({ missingTable: true }), {
      enable016RollbackBridge: false,
    }),
    /schema is missing/,
  );
  await assert.rejects(
    assert015RollbackBridgeSafe(
      fakeDatabase({ version: "014_stage_b_cycle_end_cancellation" }),
      { enable016RollbackBridge: true },
    ),
    /dedicated forward migration/,
  );
  await assert.rejects(
    assert015RollbackBridgeSafe(fakeDatabase({ version: "017_future" }), {
      enable016RollbackBridge: true,
    }),
    /do not run a down migration/,
  );
});

test("schema 016 requires exact opt-in and its complete semantic catalog", async () => {
  await assert.rejects(
    assert015RollbackBridgeSafe(fakeDatabase({ version: SCHEMA_016 }), {
      enable016RollbackBridge: false,
    }),
    /OSS_SCHEMA_ROLLBACK_BRIDGE=015-to-016/,
  );
  await assert.rejects(
    assert015RollbackBridgeSafe(fakeDatabase({ version: SCHEMA_016, shape: false }), {
      enable016RollbackBridge: true,
    }),
    /incomplete or counterfeit/,
  );
});

test("empty schema 016 is accepted while every historical fact blocks rollback", async () => {
  const safe = await assert015RollbackBridgeSafe(fakeDatabase({ version: SCHEMA_016 }), {
    enable016RollbackBridge: true,
  });
  assert.equal(safe.mode, "rollback_bridge");

  let error: unknown;
  try {
    await assert015RollbackBridgeSafe(
      fakeDatabase({
        version: SCHEMA_016,
        blockers: [
          { code: "manual_receipt_facts", count: "2" },
          { code: "manual_ledger_journals", count: "1" },
        ],
      }),
      { enable016RollbackBridge: true },
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof SchemaRollbackPreflightError);
  assert.deepEqual(error.blockers, [
    { code: "manual_receipt_facts", count: 2 },
    { code: "manual_ledger_journals", count: 1 },
  ]);
});
