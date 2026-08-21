// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSchema018CatalogDigest,
  assertSchema018NativeSafe,
  SCHEMA_018,
  SCHEMA_018_CATALOG_DIGEST,
  schema018CatalogFingerprintInput,
} from "./schema-017-018-native-compatibility.js";

test("schema 018 catalog gate accepts only the committed PG18 digest", () => {
  assert.doesNotThrow(() => assertSchema018CatalogDigest(SCHEMA_018_CATALOG_DIGEST));
  assert.throws(
    () => assertSchema018CatalogDigest("counterfeit-schema-018-catalog"),
    /Schema 018 is incomplete or counterfeit/,
  );
});

test("schema 018 support extension projection is explicit and default-deny", async () => {
  const parameters: unknown[] = [];
  const database = {
    query: async (_sql: string, params?: readonly unknown[]) => {
      parameters.push(params?.[0]);
      return { rows: [{ fingerprint_input: "synthetic" }] };
    },
  };
  await schema018CatalogFingerprintInput(database);
  await schema018CatalogFingerprintInput(database, {
    allowSchema021SupportExtensions: true,
  });
  assert.deepEqual(parameters, [false, true]);
});

test("schema 018 native preflight retains the reviewed schema 017 catalog gate", async () => {
  let calls = 0;
  await assert.rejects(
    assertSchema018NativeSafe({
      query: async () => {
        calls += 1;
        if (calls === 1) return { rows: [{ version: SCHEMA_018 }] };
        return { rows: [{ history_exact: true, fingerprint_input: null }] };
      },
    }),
    /Schema 017 is incomplete or counterfeit/,
  );
  assert.equal(calls, 2);
});

test("schema 018 native preflight rejects the older schema", async () => {
  await assert.rejects(
    assertSchema018NativeSafe({
      query: async () => ({
        rows: [{ version: "017_stage_b_manual_receipt_outflow_reports" }],
      }),
    }),
    /incompatible with application schema 018_stage_c_support_tickets/,
  );
});
