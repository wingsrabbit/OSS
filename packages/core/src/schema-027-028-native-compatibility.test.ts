// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  SCHEMA_028,
  SCHEMA_028_CATALOG_DIGEST,
  assertSchema028CatalogDigest,
  assertSchema028NativeSafe,
  schema028CatalogDigest,
  schema028CatalogFingerprintInput,
} from "./schema-027-028-native-compatibility.js";

test("schema 028 freezes a PostgreSQL 18 cancellation evidence digest", () => {
  assert.match(SCHEMA_028_CATALOG_DIGEST, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => assertSchema028CatalogDigest(SCHEMA_028_CATALOG_DIGEST));
  assert.equal(
    schema028CatalogDigest("synthetic-schema-028"),
    "1838cc505ef3a14416c2b696d7ca98d5a787d8cd1ce6cc67bedd3041bec357be",
  );
});

test("schema 028 selector covers the operation, job, inbox and evidence bindings", async () => {
  let selector = "";
  await schema028CatalogFingerprintInput({
    query: async (text) => {
      selector = text;
      return { rows: [{ value: "synthetic" }] };
    },
  });
  assert.match(selector, /service_cancellation_provider_attempts/);
  assert.match(selector, /service_cancellation_reconciliation_queries/);
  assert.match(selector, /service_cancellation_reconciliation_observations/);
  assert.match(selector, /service_cancellation_provider_results/);
  assert.match(selector, /opensales_validate_cancellation_reconciliation_observation/);
  assert.match(selector, /opensales_validate_service_cancellation_manual_action/);
  assert.match(selector, /provider_operations/);
});

test("schema 028 rejects Schema 027 before catalog reads", async () => {
  let queryCount = 0;
  await assert.rejects(
    assertSchema028NativeSafe({
      query: async () => {
        queryCount += 1;
        return { rows: [{ version: "027_stage_c_notification_templates_preferences" }] };
      },
    }),
    new RegExp(SCHEMA_028),
  );
  assert.equal(queryCount, 1);
});
