// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  SCHEMA_023,
  SCHEMA_023_CATALOG_DIGEST,
  assertSchema023CatalogDigest,
  assertSchema023NativeSafe,
  schema023CatalogDigest,
  schema023CatalogFingerprintInput,
} from "./schema-022-023-native-compatibility.js";

test("schema 023 catalog gate accepts only the committed PostgreSQL 18 digest", () => {
  assert.notEqual(SCHEMA_023_CATALOG_DIGEST, "0".repeat(64));
  assert.doesNotThrow(() => assertSchema023CatalogDigest(SCHEMA_023_CATALOG_DIGEST));
  assert.throws(() => assertSchema023CatalogDigest("f".repeat(64)), /incomplete or counterfeit/);
  assert.equal(
    schema023CatalogDigest("synthetic-schema-023"),
    "179c270a7400a89c7d33e6d419637ad3f2b070818fc065347808caf3a1eafd15",
  );
});

test("schema 023 selector covers every daily-operation object", async () => {
  let queryText = "";
  await schema023CatalogFingerprintInput({
    query: async (text) => {
      queryText = text;
      return { rows: [{ value: "reviewed" }] };
    },
  });
  for (const name of [
    "service_resource_state_facts",
    "service_resource_desired_state_facts",
    "service_resource_operation_requests",
    "service_resource_operation_attempt_facts",
    "service_resource_operation_result_facts",
    "service_resource_operation_manual_completions",
    "service_operation_job_transition_facts",
    "provider_operations_kind_check",
    "provider_operations_service_resource_request_uidx",
    "provider_operations_service_resource_guard",
    "durable_jobs_service_operation_guard",
    "services_commercial_resource_observation",
    "opensales_validate_service_operation_request",
    "opensales_guard_service_operation_job",
    "opensales_validate_service_operation_job_transition",
    "opensales_validate_service_operation_manual_completion",
    "opensales_service_operation_request_fingerprint",
    "opensales_check_service_operation_commit_pair",
    "opensales_check_service_operation_manual_completion_pair",
    "opensales_check_service_operation_provider_projection",
    "opensales_check_service_operation_request_commit",
  ]) assert.match(queryText, new RegExp(name));
});

test("schema 023 rejects a schema 022 database before catalog reads", async () => {
  let calls = 0;
  await assert.rejects(
    assertSchema023NativeSafe({
      query: async () => {
        calls += 1;
        return { rows: [{ version: "022_stage_c_catalog_commerce_hardening" }] };
      },
    }),
    new RegExp(SCHEMA_023),
  );
  assert.equal(calls, 1);
});
