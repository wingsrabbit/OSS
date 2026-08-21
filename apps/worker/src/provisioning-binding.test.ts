// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  executeProviderBoundProvisioning,
  providerBindingAllowsProvisioning,
} from "./provisioning-binding.js";

const v1ProviderBinding = {
  operationProviderInstallationId: "mock-provisioning-v1",
  bindingProviderInstallationId: "mock-provisioning-v1",
  bindingProductPolicyVersion: 1,
  bindingCapabilitySnapshot: ["resource_create", "resource_reconcile"],
  currentProviderType: "provisioning",
  currentProviderEnabled: true,
  currentProviderCapabilities: ["resource_create", "resource_reconcile"],
} as const;

test("saved v1 Provider binding remains executable after unrelated Product policy updates", () => {
  assert.equal(providerBindingAllowsProvisioning(v1ProviderBinding), true);
});

test("saved binding still requires the current Mock Provider and required capabilities", () => {
  assert.equal(
    providerBindingAllowsProvisioning({ ...v1ProviderBinding, currentProviderEnabled: false }),
    false,
  );
  assert.equal(
    providerBindingAllowsProvisioning({
      ...v1ProviderBinding,
      currentProviderCapabilities: ["resource_create"],
    }),
    false,
  );
  assert.equal(
    providerBindingAllowsProvisioning({
      ...v1ProviderBinding,
      bindingProviderInstallationId: null,
    }),
    false,
  );
});

test("queued v1 binding executes exactly one Provider call after Product policy moves to v2 manual", async () => {
  const currentProductPolicy = {
    version: 2,
    providerInstallationId: null,
  } as const;
  assert.deepEqual(currentProductPolicy, { version: 2, providerInstallationId: null });
  let calls = 0;
  const result = await executeProviderBoundProvisioning(v1ProviderBinding, async () => {
    calls += 1;
    return { status: 202 } as const;
  });
  assert.deepEqual(result, { status: 202 });
  assert.equal(calls, 1);
});
