// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSchema019CatalogDigest,
  assertSchema019NativeSafe,
  SCHEMA_019,
  SCHEMA_019_CATALOG_DIGEST,
  schema019CatalogFingerprintInput,
} from "./schema-018-019-native-compatibility.js";
import { schema017CatalogFingerprintInput } from "./schema-016-017-rollback-compatibility.js";

const schema019History = [
  "001_stage_a",
  "002_staff_stage_a",
  "003_stage_a_financial_hardening",
  "004_stage_b_credit_and_fees",
  "005_stage_b_add_funds",
  "006_stage_b_unclaimed_funds",
  "007_stage_b_manual_refunds",
  "008_stage_b_refund_reconciliation",
  "009_stage_b_refund_capacity_incidents",
  "010_stage_b_unclaimed_refunds",
  "011_stage_b_add_funds_chargebacks",
  "012_stage_b_renewal_lifecycle",
  "013_stage_b_late_fee_suspension",
  "014_stage_b_cycle_end_cancellation",
  "015_stage_b_saved_payment_auto_renew",
  "016_stage_b_manual_receipts",
  "017_stage_b_manual_receipt_outflow_reports",
  "018_stage_c_support_tickets",
  SCHEMA_019,
] as const;

test("schema 019 catalog gate accepts only the committed PG18 digest", () => {
  assert.doesNotThrow(() => assertSchema019CatalogDigest(SCHEMA_019_CATALOG_DIGEST));
  assert.throws(
    () => assertSchema019CatalogDigest("counterfeit-schema-019-catalog"),
    /Schema 019 is incomplete or counterfeit/,
  );
});

test("schema 019 catalog fingerprint includes every new historical identity guard", async () => {
  let queryText = "";
  await schema019CatalogFingerprintInput({
    query: async (text) => {
      queryText = text;
      return { rows: [{ history_exact: true, fingerprint_input: "reviewed" }] };
    },
  });
  for (const name of [
    "sessions_identity_immutable",
    "opensales_guard_session_identity",
    "users_bump_identity_context_version",
    "opensales_bump_user_identity_context_version",
    "client_accounts_invalidate_reauth",
    "opensales_invalidate_client_account_reauth",
    "client_accounts_prelock_reauth",
    "opensales_prelock_client_account_reauth",
    "order_items_snapshot_immutable",
    "orders_snapshot_immutable",
    "services_identity_immutable",
    "payment_attempts_identity_immutable",
    "opensales_guard_order_item_snapshot",
    "opensales_guard_order_snapshot",
    "opensales_guard_service_identity",
    "opensales_guard_payment_attempt_identity",
    "client_membership_invitations_identity_immutable",
    "client_contacts_identity_immutable",
    "opensales_guard_membership_invitation_identity",
    "opensales_guard_client_contact_identity",
    "client_accounts_record_owner_transfer",
    "client_account_owner_transfer_facts_immutable",
    "opensales_record_client_account_owner_transfer",
    "opensales_reject_client_account_owner_transfer_fact_mutation",
    "notification_delivery_operations_guard",
    "notification_delivery_operations_recipient_guard",
    "notification_delivery_operations_terminal_fact_guard",
    "notification_delivery_operations_support_message_guard",
    "renewal_notification_dispatch_suppressions",
    "renewal_notification_dispatch_suppressions_immutable",
    "client_membership_invitations_active_email_idx",
    "client_contacts_active_email_idx",
    "notification_delivery_operations_verification_token_key",
    "notification_outbox_immutable",
    "renewal_reminder_delivery_facts_projection_guard",
    "notification_delivery_facts_renewal_projection_guard",
    "opensales_guard_notification_delivery_operation",
    "opensales_validate_notification_delivery_operation",
    "opensales_notification_utf16_sort_key",
    "opensales_canonical_notification_jsonb",
    "opensales_notification_request_fingerprint",
    "opensales_notification_provider_operation_id",
    "opensales_notification_rendered_request_fingerprint",
    "opensales_validate_terminal_notification_delivery_fact",
    "opensales_reject_renewal_notification_dispatch_suppression_mutation",
    "opensales_validate_support_notification_message",
    "opensales_validate_renewal_notification_delivery_projection",
    "opensales_guard_notification_outbox",
    "renewal_reminder_delivery_facts_immutable",
    "opensales_reject_service_period_mutation",
    "notification_delivery_facts_status_guard",
    "opensales_validate_notification_delivery_fact",
    "notification_delivery_facts_immutable",
    "opensales_reject_notification_delivery_fact_mutation",
  ]) {
    assert.match(queryText, new RegExp(name));
  }
});

test("schema 019 native preflight retains the reviewed schema 017 catalog gate", async () => {
  let calls = 0;
  let inheritedCatalogValues: unknown[] | undefined;
  await assert.rejects(
    assertSchema019NativeSafe({
      query: async (_text, values) => {
        calls += 1;
        if (calls === 1) return { rows: [{ version: SCHEMA_019 }] };
        inheritedCatalogValues = values;
        return { rows: [{ history_exact: true, fingerprint_input: null }] };
      },
    }),
    /Schema 017 is incomplete or counterfeit/,
  );
  assert.equal(calls, 2);
  assert.equal(inheritedCatalogValues?.[1], true);
  assert.equal(
    (inheritedCatalogValues?.[0] as readonly string[] | undefined)?.at(-1),
    SCHEMA_019,
  );
});

test("schema 017 excludes only the reviewed Schema 019 owner trigger extensions", async () => {
  const calls: Array<Readonly<{ text: string; values?: unknown[] }>> = [];
  const database = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, ...(values ? { values } : {}) });
      return { rows: [{ history_exact: true, fingerprint_input: "reviewed" }] };
    },
  };

  await schema017CatalogFingerprintInput(database);
  await schema017CatalogFingerprintInput(database, {
    allowSchema019RecordedOwnerInvariant: true,
  });
  await schema017CatalogFingerprintInput(database, {
    expectedMigrationHistory: [SCHEMA_019],
    allowSchema019RecordedOwnerInvariant: true,
  });
  await schema017CatalogFingerprintInput(database, {
    expectedMigrationHistory: schema019History,
    allowSchema019RecordedOwnerInvariant: true,
  });

  assert.equal(calls[0]?.values?.[1], false);
  assert.equal(calls[1]?.values?.[1], false);
  assert.equal(calls[2]?.values?.[1], false);
  assert.equal(calls[3]?.values?.[1], true);
  assert.match(
    calls[3]?.text ?? "",
    /relation\.relname = 'client_accounts'[\s\S]*actual\.tgname IN \([\s\S]*'client_accounts_owner_invariant',[\s\S]*'client_accounts_record_owner_transfer',[\s\S]*'client_accounts_prelock_reauth'[\s\S]*\)/,
  );
  assert.doesNotMatch(
    calls[3]?.text ?? "",
    /actual\.tgname = 'schema_019_unreviewed_client_account_trigger'/,
  );
});

test("schema 019 native preflight rejects schema 018 without a forward migration", async () => {
  await assert.rejects(
    assertSchema019NativeSafe({
      query: async () => ({ rows: [{ version: "018_stage_c_support_tickets" }] }),
    }),
    /incompatible with application schema 019_stage_c_account_context_memberships_contacts/,
  );
});
