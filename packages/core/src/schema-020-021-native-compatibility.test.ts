// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSchema021CatalogDigest,
  assertSchema021NativeSafe,
  SCHEMA_021,
  SCHEMA_021_CATALOG_DIGEST,
  schema021CatalogDigest,
} from "./schema-020-021-native-compatibility.js";

test("schema 021 catalog gate accepts only the committed PG18 digest", () => {
  assert.notEqual(SCHEMA_021_CATALOG_DIGEST, "0".repeat(64));
  assert.doesNotThrow(() => assertSchema021CatalogDigest(SCHEMA_021_CATALOG_DIGEST));
  assert.throws(
    () => assertSchema021CatalogDigest("f".repeat(64)),
    /incomplete or counterfeit/,
  );
  assert.equal(schema021CatalogDigest("synthetic-schema-021"),
    "cb6dbaab27253146aef331a570f66314f52357040584f8496358d7d07c8260ba");
});

test("schema 021 passes the exact schema 019 history to the inherited owner projection", async () => {
  let calls = 0;
  let inheritedValues: readonly unknown[] | undefined;
  await assert.rejects(
    assertSchema021NativeSafe({
      query: async (_text, values) => {
        calls += 1;
        if (calls === 1) return { rows: [{ version: SCHEMA_021 }] };
        if (calls === 2) return { rows: [{ history_exact: true }] };
        inheritedValues = values;
        return { rows: [{ history_exact: true, fingerprint_input: null }] };
      },
    }),
    /Schema 017 foundation is incomplete or counterfeit/,
  );
  assert.equal(calls, 3);
  assert.equal(inheritedValues?.[1], true);
  assert.equal(
    (inheritedValues?.[0] as readonly string[] | undefined)?.at(-1),
    "019_stage_c_account_context_memberships_contacts",
  );
});
