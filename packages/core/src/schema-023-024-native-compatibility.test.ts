// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  SCHEMA_024,
  SCHEMA_024_CATALOG_DIGEST,
  assertSchema024CatalogDigest,
  assertSchema024NativeSafe,
  schema024CatalogDigest,
  schema024CatalogFingerprintInput,
} from "./schema-023-024-native-compatibility.js";

test("schema 024 catalog gate accepts only the committed PostgreSQL 18 digest", () => {
  assert.notEqual(SCHEMA_024_CATALOG_DIGEST, "0".repeat(64));
  assert.doesNotThrow(() => assertSchema024CatalogDigest(SCHEMA_024_CATALOG_DIGEST));
  assert.throws(() => assertSchema024CatalogDigest("f".repeat(64)), /incomplete or counterfeit/);
  assert.equal(
    schema024CatalogDigest("synthetic-schema-024"),
    "4f79d1c8d72785fabe7df1c967f29782852cdde8a8702c03bc6979201a928e58",
  );
});

test("schema 024 selector freezes every identity-security catalog extension", async () => {
  let queryText = "";
  await schema024CatalogFingerprintInput({
    query: async (text) => {
      queryText = text;
      return { rows: [{ value: "reviewed" }] };
    },
  });
  for (const name of [
    "password_reset_tokens",
    "lab_identity_mailbox_capabilities",
    "email_change_tokens",
    "totp_enrollment_challenges",
    "user_totp_credentials",
    "totp_recovery_code_batches",
    "totp_recovery_codes",
    "totp_step_use_facts",
    "login_challenges",
    "customer_api_keys",
    "customer_api_key_revocations",
    "customer_api_key_usage_facts",
    "identity_notification_outbox",
    "identity_notification_delivery_facts",
    "identity_notification_delivery_operations",
    "identity_password_change_events",
    "identity_email_change_events",
    "identity_action_facts",
    "authorization_epoch",
    "revoked_transaction_id",
    "factor_method",
    "users_authorization_epoch_check",
    "sessions_revoked_transaction_check",
    "reauth_grants_factor_method_check",
    "totp_recovery_codes_batch_insert_guard",
    "totp_recovery_code_batch_projection_guard",
    "totp_recovery_code_projection_guard",
    "customer_api_keys_canonical_scopes",
    "customer_api_key_revocations_insert_guard",
    "customer_api_key_usage_facts_insert_guard",
    "identity_notification_outbox_subject_guard",
    "identity_notification_delivery_operations_guard",
    "identity_notification_delivery_facts_insert_guard",
    "identity_delivery_operation_projection_guard",
    "identity_delivery_fact_projection_guard",
    "identity_notification_durable_job_guard",
    "identity_notification_outbox_bundle_guard",
    "identity_notification_operation_bundle_guard",
    "identity_notification_job_bundle_guard",
    "users_record_password_change_event",
    "identity_password_change_events_insert_guard",
    "users_record_email_change_event",
    "identity_email_change_events_insert_guard",
    "identity_action_facts_insert_guard",
    "customer_api_keys_immutable",
    "customer_api_key_revocations_immutable",
    "customer_api_key_usage_facts_immutable",
    "totp_step_use_facts_immutable",
    "totp_recovery_code_batches_immutable",
    "identity_password_change_events_immutable",
    "identity_email_change_events_immutable",
    "user_totp_credentials_guard",
    "identity_notification_outbox_immutable",
    "identity_notification_delivery_facts_immutable",
    "identity_action_facts_immutable",
    "audit_events_immutable",
    "password_reset_tokens_transition_guard",
    "email_change_tokens_transition_guard",
    "login_challenges_transition_guard",
    "lab_identity_mailbox_capabilities_guard",
    "sessions_revoke_lab_identity_mailbox_capability",
    "totp_enrollment_challenges_transition_guard",
    "totp_recovery_codes_transition_guard",
    "sessions_revocation_transaction_insert_guard",
    "sessions_revocation_transaction_guard",
    "sessions_invalidate_reauth_on_revoke",
    "users_bump_credential_authorization_epoch",
    "users_authorization_epoch_monotonic",
    "users_authorization_epoch_invalidate_reauth",
    "client_memberships_bump_authorization_epoch",
    "staff_members_bump_authorization_epoch",
    "opensales_identity_envelope_key_version",
    "opensales_guard_totp_recovery_code_batch_insert",
    "opensales_validate_totp_recovery_code_batch",
    "opensales_validate_customer_api_key_scopes",
    "opensales_guard_customer_api_key_fact_insert",
    "opensales_identity_notification_request_fingerprint",
    "opensales_validate_identity_notification_outbox",
    "opensales_guard_identity_delivery_operation",
    "opensales_guard_identity_delivery_fact_insert",
    "opensales_validate_identity_delivery_projection",
    "opensales_guard_identity_notification_job",
    "opensales_validate_identity_notification_bundle",
    "opensales_record_password_change_event",
    "opensales_guard_password_change_event_insert",
    "opensales_record_email_change_event",
    "opensales_guard_email_change_event_insert",
    "opensales_guard_identity_action_fact_insert",
    "opensales_reject_identity_fact_mutation",
    "opensales_guard_totp_credential",
    "opensales_guard_identity_token_transition",
    "opensales_guard_lab_identity_mailbox_capability",
    "opensales_revoke_lab_identity_mailbox_capability_for_session",
    "opensales_guard_totp_enrollment_transition",
    "opensales_guard_totp_recovery_code_transition",
    "opensales_guard_session_revocation_transaction",
    "opensales_invalidate_session_reauth_on_revoke",
    "opensales_bump_credential_authorization_epoch",
    "opensales_guard_authorization_epoch",
    "opensales_invalidate_reauth_on_authorization_epoch",
    "opensales_bump_membership_authorization_epoch",
    "opensales_bump_staff_authorization_epoch",
  ]) assert.match(queryText, new RegExp(name));
});

test("schema 024 rejects a schema 023 database before catalog reads", async () => {
  let calls = 0;
  await assert.rejects(
    assertSchema024NativeSafe({
      query: async () => {
        calls += 1;
        return { rows: [{ version: "023_stage_c_service_operations" }] };
      },
    }),
    new RegExp(SCHEMA_024),
  );
  assert.equal(calls, 1);
});
