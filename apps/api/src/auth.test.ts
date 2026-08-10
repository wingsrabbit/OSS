// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { assertBillingWriteEligible, type AuthenticatedUser } from "./auth.js";

function eligibleUser(
  membershipRole: AuthenticatedUser["membershipRole"],
  membershipPermissions: readonly string[] = [],
): AuthenticatedUser {
  return {
    sessionId: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000002",
    email: "synthetic-billing-role@example.invalid",
    locale: "en",
    emailVerifiedAt: new Date("2001-01-01T00:00:00.000Z"),
    userRestrictedAt: null,
    clientAccountId: "00000000-0000-4000-8000-000000000003",
    clientAccountRestrictedAt: null,
    membershipRole,
    membershipPermissions,
    membershipRestrictedAt: null,
    accountContextVersion: "1",
  };
}

test("billing.write capability governs invoice money movement", () => {
  assert.doesNotThrow(() => assertBillingWriteEligible(eligibleUser("owner")));
  assert.doesNotThrow(() => assertBillingWriteEligible(eligibleUser("billing")));
  for (const role of ["technical", "viewer"] as const) {
    assert.throws(
      () => assertBillingWriteEligible(eligibleUser(role)),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { statusCode?: number; code?: string }).statusCode === 403 &&
        (error as Error & { statusCode?: number; code?: string }).code ===
          "CUSTOMER_CAPABILITY_REQUIRED",
    );
    assert.doesNotThrow(() =>
      assertBillingWriteEligible(eligibleUser(role, ["billing.write"])),
    );
  }
});

test("billing.write never bypasses User or Client Account restrictions", () => {
  for (const user of [
    { ...eligibleUser("billing"), userRestrictedAt: new Date() },
    { ...eligibleUser("billing"), clientAccountRestrictedAt: new Date() },
  ]) {
    assert.throws(
      () => assertBillingWriteEligible(user),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { statusCode?: number; code?: string }).statusCode === 403 &&
        (error as Error & { statusCode?: number; code?: string }).code ===
          "ACCOUNT_RESTRICTED",
    );
  }
});
