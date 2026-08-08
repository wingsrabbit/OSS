// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  assert014RollbackBridgeSafe,
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
      if (text.includes("has_saved_methods")) {
        const valid = input.shape ?? true;
        return {
          rows: [
            {
              has_token_key_materials: valid,
              has_token_encryption_keys: valid,
              has_token_lookup_keys: valid,
              has_saved_methods: valid,
              has_authorizations: valid,
              has_consent_events: valid,
              has_automatic_runs: valid,
              has_payment_method_columns: valid,
              has_service_generation_columns: valid,
              has_payment_attempt_columns: valid,
            },
          ],
        };
      }
      return { rows: [...(input.blockers ?? [])] };
    },
  };
}

test("014 runs natively while missing, older, and newer schemas fail closed", async () => {
  const native = await assert014RollbackBridgeSafe(
    fakeDatabase({ version: "014_stage_b_cycle_end_cancellation" }),
    { enable015RollbackBridge: false },
  );
  assert.equal(native.mode, "native");
  await assert.rejects(
    assert014RollbackBridgeSafe(fakeDatabase({ missingTable: true }), {
      enable015RollbackBridge: false,
    }),
    /schema is missing/,
  );
  await assert.rejects(
    assert014RollbackBridgeSafe(fakeDatabase({ version: "013_stage_b_late_fee_suspension" }), {
      enable015RollbackBridge: false,
    }),
    /dedicated forward migration/,
  );
  await assert.rejects(
    assert014RollbackBridgeSafe(fakeDatabase({ version: "016_future" }), {
      enable015RollbackBridge: false,
    }),
    /do not run a down migration/,
  );
});

test("015 requires explicit bridge mode and the complete expected expansion", async () => {
  const database = fakeDatabase({ version: "015_stage_b_saved_payment_auto_renew" });
  await assert.rejects(
    assert014RollbackBridgeSafe(database, { enable015RollbackBridge: false }),
    /OSS_SCHEMA_ROLLBACK_BRIDGE=014-to-015/,
  );
  await assert.rejects(
    assert014RollbackBridgeSafe(
      fakeDatabase({ version: "015_stage_b_saved_payment_auto_renew", shape: false }),
      { enable015RollbackBridge: true },
    ),
    /incomplete or counterfeit/,
  );
});

test("015 bridge accepts no feature facts and reports every blocker by count", async () => {
  const safe = await assert014RollbackBridgeSafe(
    fakeDatabase({ version: "015_stage_b_saved_payment_auto_renew" }),
    { enable015RollbackBridge: true },
  );
  assert.equal(safe.mode, "rollback_bridge");

  let error: unknown;
  try {
    await assert014RollbackBridgeSafe(
      fakeDatabase({
        version: "015_stage_b_saved_payment_auto_renew",
        blockers: [
          { code: "saved_payment_methods", count: "2" },
          { code: "automatic_provider_operations", count: "1" },
        ],
      }),
      { enable015RollbackBridge: true },
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof SchemaRollbackPreflightError);
  assert.deepEqual(error.blockers, [
    { code: "saved_payment_methods", count: 2 },
    { code: "automatic_provider_operations", count: 1 },
  ]);
});
