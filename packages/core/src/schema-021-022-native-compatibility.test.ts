// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSchema022CatalogDigest,
  assertSchema022NativeSafe,
  SCHEMA_022,
  SCHEMA_022_CATALOG_DIGEST,
  schema022CatalogDigest,
  schema022CatalogFingerprintInput,
} from "./schema-021-022-native-compatibility.js";

test("schema 022 catalog gate accepts only the committed PostgreSQL 18 digest", () => {
  assert.notEqual(SCHEMA_022_CATALOG_DIGEST, "0".repeat(64));
  assert.doesNotThrow(() => assertSchema022CatalogDigest(SCHEMA_022_CATALOG_DIGEST));
  assert.throws(
    () => assertSchema022CatalogDigest("f".repeat(64)),
    /incomplete or counterfeit/,
  );
  assert.equal(
    schema022CatalogDigest("synthetic-schema-022"),
    "ec802b8880c19efd95c75c8e948b0865e1b479a956d3c54f689c5dd2a41507de",
  );
});

test("schema 022 fingerprint covers every Commerce hardening object", async () => {
  let queryText = "";
  await schema022CatalogFingerprintInput({
    query: async (text) => {
      queryText = text;
      return { rows: [{ value: "reviewed" }] };
    },
  });
  for (const name of [
    "btree_gist",
    "supply_capacity_releases",
    "product_prices_valid_interval_check",
    "product_prices_validity_excl",
    "promotions_validity_excl",
    "supply_capacity_reservations_product_idx",
    "opensales_validate_quote_terminal_fact",
    "opensales_validate_supply_capacity_release",
    "opensales_apply_supply_capacity_release",
    "opensales_release_supply_for_terminal_service",
    "opensales_release_supply_for_terminal_order",
    "opensales_guard_released_supply_terminal_state",
    "opensales_validate_supply_capacity_projection",
    "supply_capacity_releases_projection_guard",
    "supply_capacity_releases_apply_projection",
    "supply_capacity_releases_immutable",
    "services_release_supply_on_terminal",
    "orders_release_supply_on_terminal",
    "orders_released_supply_terminal_guard",
    "services_released_supply_terminal_guard",
    "product_supply_capacities_projection_invariant",
    "supply_capacity_reservations_projection_invariant",
    "supply_capacity_releases_projection_invariant",
  ]) {
    assert.match(queryText, new RegExp(name));
  }
});

test("schema 022 rejects a schema 021 database before catalog reads", async () => {
  let calls = 0;
  await assert.rejects(
    assertSchema022NativeSafe({
      query: async () => {
        calls += 1;
        return { rows: [{ version: "021_stage_c_support_operations" }] };
      },
    }),
    new RegExp(SCHEMA_022),
  );
  assert.equal(calls, 1);
});
