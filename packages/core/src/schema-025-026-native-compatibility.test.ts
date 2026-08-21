// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { assertSchema025NativeSafe } from "./schema-024-025-native-compatibility.js";
import {
  SCHEMA_026,
  SCHEMA_026_CATALOG_DIGEST,
  assertSchema026CatalogDigest,
  assertSchema026NativeSafe,
  schema026CatalogDigest,
  schema026CatalogFingerprintInput,
} from "./schema-025-026-native-compatibility.js";

test("schema 026 catalog gate accepts only the committed PostgreSQL 18 digest", () => {
  assert.notEqual(SCHEMA_026_CATALOG_DIGEST, "0".repeat(64));
  assert.doesNotThrow(() => assertSchema026CatalogDigest(SCHEMA_026_CATALOG_DIGEST));
  assert.throws(() => assertSchema026CatalogDigest("f".repeat(64)), /incomplete or counterfeit/);
  assert.equal(
    schema026CatalogDigest("synthetic-schema-026"),
    "53df5556dcc50f986292987dea3809a1ad5ca76eaa29ebc1a83c45a6a30d45b0",
  );
});

test("schema 026 selector freezes the two authority functions and trigger bindings", async () => {
  let queryText = "";
  await schema026CatalogFingerprintInput({
    query: async (text) => {
      queryText = text;
      return { rows: [{ value: "reviewed" }] };
    },
  });
  for (const name of [
    "opensales_validate_service_cancellation_request",
    "opensales_validate_service_cancellation_manual_action",
    "service_cancellation_requests",
    "service_cancellation_requests_insert_guard",
    "service_cancellation_manual_actions",
    "service_cancellation_manual_actions_insert_guard",
  ]) assert.match(queryText, new RegExp(name));
});

test("schema 026 rejects a schema 025 database before catalog reads", async () => {
  let calls = 0;
  await assert.rejects(
    assertSchema026NativeSafe({
      query: async () => {
        calls += 1;
        return { rows: [{ version: "025_stage_c_content_operations" }] };
      },
    }),
    new RegExp(SCHEMA_026),
  );
  assert.equal(calls, 1);
});

test("schema 025 remains default-deny after schema 026 is installed", async () => {
  let calls = 0;
  await assert.rejects(
    assertSchema025NativeSafe({
      query: async () => {
        calls += 1;
        return { rows: [{ version: SCHEMA_026 }] };
      },
    }),
    /026_stage_c_service_cancellation_authority.*025_stage_c_content_operations/,
  );
  assert.equal(calls, 1);
});

test("schema 026 rejects non-exact migration history before catalog reads", async () => {
  let calls = 0;
  await assert.rejects(
    assertSchema026NativeSafe({
      query: async () => {
        calls += 1;
        return calls === 1
          ? { rows: [{ version: SCHEMA_026 }] }
          : { rows: [{ history_exact: false }] };
      },
    }),
    /migration history is incomplete/,
  );
  assert.equal(calls, 2);
});
