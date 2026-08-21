// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { assertSchema026NativeSafe } from "./schema-025-026-native-compatibility.js";
import {
  SCHEMA_027,
  SCHEMA_027_CATALOG_DIGEST,
  assertSchema027CatalogDigest,
  assertSchema027NativeSafe,
  schema027CatalogDigest,
  schema027CatalogFingerprintInput,
} from "./schema-026-027-native-compatibility.js";

test("schema 027 catalog gate accepts the committed PostgreSQL 18 digest", () => {
  assert.match(SCHEMA_027_CATALOG_DIGEST, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => assertSchema027CatalogDigest(SCHEMA_027_CATALOG_DIGEST));
  assert.equal(
    schema027CatalogDigest("synthetic-schema-027"),
    "a441ce4be413ea7f273a6e0efc2f77541eae73bfdafe3859f453b91c1b2f005d",
  );
});

test("schema 027 selector freezes registry, preference and attempt revision facts", async () => {
  let queryText = "";
  await schema027CatalogFingerprintInput({
    query: async (text) => {
      queryText = text;
      return { rows: [{ value: "reviewed" }] };
    },
  });
  for (const name of [
    "notification_template_revisions",
    "notification_template_channels",
    "user_notification_preferences",
    "notification_delivery_operations",
    "identity_notification_delivery_operations",
    "required_variables",
    "opensales_validate_notification_template_publication",
    "opensales_validate_notification_template_retirement",
    "opensales_guard_notification_operation_template_revision",
  ]) assert.match(queryText, new RegExp(name));
});

test("schema 027 rejects a schema 026 database before catalog reads", async () => {
  let calls = 0;
  await assert.rejects(
    assertSchema027NativeSafe({
      query: async () => {
        calls += 1;
        return { rows: [{ version: "026_stage_c_service_cancellation_authority" }] };
      },
    }),
    new RegExp(SCHEMA_027),
  );
  assert.equal(calls, 1);
});

test("schema 026 remains default-deny after schema 027 is installed", async () => {
  let calls = 0;
  await assert.rejects(
    assertSchema026NativeSafe({
      query: async () => {
        calls += 1;
        return { rows: [{ version: SCHEMA_027 }] };
      },
    }),
    /027_stage_c_notification_templates_preferences.*026_stage_c_service_cancellation_authority/,
  );
  assert.equal(calls, 1);
});
