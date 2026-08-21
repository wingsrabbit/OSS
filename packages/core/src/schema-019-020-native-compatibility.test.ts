// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSchema020CatalogDigest,
  assertSchema020NativeSafe,
  SCHEMA_020,
  SCHEMA_020_CATALOG_DIGEST,
  SCHEMA_020_WITH_022_EXTENSIONS_CATALOG_DIGEST,
  schema020CatalogFingerprintInput,
} from "./schema-019-020-native-compatibility.js";

test("schema 020 catalog gate accepts only the reviewed PG18 digest", () => {
  assert.doesNotThrow(() => assertSchema020CatalogDigest(SCHEMA_020_CATALOG_DIGEST));
  assert.throws(
    () => assertSchema020CatalogDigest("counterfeit-schema-020-catalog"),
    /Schema 020 is incomplete or counterfeit/,
  );
});

test("schema 020 fingerprint covers immutable commercial and consent facts", async () => {
  let queryText = "";
  let queryValues: readonly unknown[] | undefined;
  await schema020CatalogFingerprintInput({
    query: async (text, values) => {
      queryText = text;
      queryValues = values;
      return { rows: [{ value: "reviewed" }] };
    },
  });
  assert.deepEqual(queryValues, [false]);
  for (const name of [
    "catalog_product_revisions_immutable",
    "product_prices_revision_guard",
    "promotions_revision_guard",
    "sales_quotes_immutable",
    "sales_quote_acceptances_terminal_guard",
    "promotion_redemptions_immutable",
    "supply_capacity_reservations_immutable",
    "marketing_consent_events_membership_guard",
    "orders_source_quote_immutable",
    "current_marketing_consents",
  ]) {
    assert.match(queryText, new RegExp(name));
  }
});

test("schema 020 transfers only the reviewed commerce hardening objects to schema 022", async () => {
  assert.match(SCHEMA_020_WITH_022_EXTENSIONS_CATALOG_DIGEST, /^[a-f0-9]{64}$/);
  assert.notEqual(
    SCHEMA_020_WITH_022_EXTENSIONS_CATALOG_DIGEST,
    SCHEMA_020_CATALOG_DIGEST,
  );
  let queryText = "";
  let queryValues: readonly unknown[] | undefined;
  await schema020CatalogFingerprintInput(
    {
      query: async (text, values) => {
        queryText = text;
        queryValues = values;
        return { rows: [{ value: "reviewed" }] };
      },
    },
    { allowSchema022CommerceExtensions: true },
  );
  assert.deepEqual(queryValues, [true]);
  for (const name of [
    "promotions_validity_excl",
    "product_supply_capacities_projection_invariant",
    "supply_capacity_reservations_projection_invariant",
    "supply_capacity_reservations_product_idx",
    "opensales_validate_quote_terminal_fact",
  ]) {
    assert.match(queryText, new RegExp(name));
  }
});

test("schema 020 native gate rejects a schema 019 database before catalog reads", async () => {
  let calls = 0;
  await assert.rejects(
    assertSchema020NativeSafe({
      query: async () => {
        calls += 1;
        return {
          rows: [{ version: "019_stage_c_account_context_memberships_contacts" }],
        };
      },
    }),
    (error: unknown) => {
      assert.equal(
        (error as { installedSchemaVersion?: string }).installedSchemaVersion,
        "019_stage_c_account_context_memberships_contacts",
      );
      assert.match(String(error), new RegExp(SCHEMA_020));
      return true;
    },
  );
  assert.equal(calls, 1);
});
