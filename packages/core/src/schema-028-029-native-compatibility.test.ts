// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  SCHEMA_029,
  SCHEMA_029_CATALOG_DIGEST,
  assertSchema029CatalogDigest,
  assertSchema029NativeSafe,
  schema029CatalogDigest,
  schema029CatalogFingerprintInput,
} from "./schema-028-029-native-compatibility.js";

test("schema 029 freezes a PostgreSQL 18 Service password-change digest", () => {
  assert.match(SCHEMA_029_CATALOG_DIGEST, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => assertSchema029CatalogDigest(SCHEMA_029_CATALOG_DIGEST));
  assert.equal(
    schema029CatalogDigest("synthetic-schema-029"),
    "23c0ac3d8646e47e17fb9e6cac307409f74943a4d98a77e973bb05dcb68214b0",
  );
});

test("schema 029 selector covers the request, encrypted envelope, Worker, and Mock operation bindings", async () => {
  let selector = "";
  await schema029CatalogFingerprintInput({
    query: async (text) => {
      selector = text;
      return { rows: [{ value: "synthetic" }] };
    },
  });
  assert.match(selector, /service_configuration_operation_requests/);
  assert.match(selector, /service_configuration_secret_envelopes/);
  assert.match(selector, /service_configuration_operation_attempts/);
  assert.match(selector, /service_configuration_operation_result_facts/);
  assert.match(selector, /service_configuration_operation_job_transitions/);
  assert.match(selector, /opensales_validate_service_configuration_request/);
  assert.match(selector, /opensales_require_service_configuration_bundle/);
  assert.match(selector, /opensales_validate_service_configuration_attempt/);
  assert.match(selector, /opensales_check_service_configuration_result_authority/);
  assert.match(selector, /opensales_check_service_configuration_envelope_projection/);
  assert.match(selector, /provider_operations/);
});

test("schema 029 rejects Schema 028 before catalog reads", async () => {
  let queryCount = 0;
  await assert.rejects(
    assertSchema029NativeSafe({
      query: async () => {
        queryCount += 1;
        return { rows: [{ version: "028_stage_c_cancellation_provider_evidence" }] };
      },
    }),
    new RegExp(SCHEMA_029),
  );
  assert.equal(queryCount, 1);
});
