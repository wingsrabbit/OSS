// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { assertSchema024NativeSafe } from "./schema-023-024-native-compatibility.js";
import {
  SCHEMA_025,
  SCHEMA_025_CATALOG_DIGEST,
  assertSchema025CatalogDigest,
  assertSchema025NativeSafe,
  schema025CatalogDigest,
  schema025CatalogFingerprintInput,
} from "./schema-024-025-native-compatibility.js";

test("schema 025 catalog gate accepts only the committed PostgreSQL 18 digest", () => {
  assert.notEqual(SCHEMA_025_CATALOG_DIGEST, "0".repeat(64));
  assert.doesNotThrow(() => assertSchema025CatalogDigest(SCHEMA_025_CATALOG_DIGEST));
  assert.throws(() => assertSchema025CatalogDigest("f".repeat(64)), /incomplete or counterfeit/);
  assert.equal(
    schema025CatalogDigest("synthetic-schema-025"),
    "70f972e4da977e11be27b246966d69b3faa88cf8b248b1c8e957cfc4b2d835cb",
  );
});

test("schema 025 selector freezes every Content Operations catalog extension", async () => {
  let queryText = "";
  await schema025CatalogFingerprintInput({
    query: async (text) => {
      queryText = text;
      return { rows: [{ value: "reviewed" }] };
    },
  });
  for (const name of [
    "legal_documents",
    "legal_document_channels",
    "legal_document_publications",
    "legal_document_retirements",
    "content_entries",
    "content_channels",
    "content_revisions",
    "content_revision_publications",
    "content_revision_retirements",
    "current_legal_documents",
    "current_content_revisions",
    "opensales_validate_content_staff_actor",
    "opensales_guard_immutable_content_fact",
    "opensales_guard_legal_channel",
    "opensales_prepare_legal_document_revision",
    "opensales_prepare_legal_publication",
    "opensales_prepare_legal_retirement",
    "opensales_validate_legal_channel_current",
    "opensales_guard_content_entry",
    "opensales_validate_content_entry_actor",
    "opensales_guard_content_channel",
    "opensales_prepare_content_channel",
    "opensales_validate_content_entry_channels",
    "opensales_prepare_content_revision",
    "opensales_prepare_content_publication",
    "opensales_prepare_content_retirement",
    "opensales_validate_content_channel_current",
  ]) assert.match(queryText, new RegExp(name));
});

test("schema 025 rejects a schema 024 database before catalog reads", async () => {
  let calls = 0;
  await assert.rejects(
    assertSchema025NativeSafe({
      query: async () => {
        calls += 1;
        return { rows: [{ version: "024_stage_c_identity_security" }] };
      },
    }),
    new RegExp(SCHEMA_025),
  );
  assert.equal(calls, 1);
});

test("schema 024 remains default-deny after schema 025 is installed", async () => {
  let calls = 0;
  await assert.rejects(
    assertSchema024NativeSafe({
      query: async () => {
        calls += 1;
        return { rows: [{ version: SCHEMA_025 }] };
      },
    }),
    /025_stage_c_content_operations.*024_stage_c_identity_security/,
  );
  assert.equal(calls, 1);
});

test("schema 025 rejects non-exact migration history before catalog reads", async () => {
  let calls = 0;
  await assert.rejects(
    assertSchema025NativeSafe({
      query: async () => {
        calls += 1;
        return calls === 1
          ? { rows: [{ version: SCHEMA_025 }] }
          : { rows: [{ history_exact: false }] };
      },
    }),
    /migration history is incomplete/,
  );
  assert.equal(calls, 2);
});
