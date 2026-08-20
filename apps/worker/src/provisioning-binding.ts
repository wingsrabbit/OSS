// SPDX-License-Identifier: AGPL-3.0-or-later

export const REQUIRED_PROVISIONING_CAPABILITIES = [
  "resource_create",
  "resource_reconcile",
] as const;

function exactStringList(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : null;
}

export type ProvisioningBindingInput = Readonly<{
  operationProviderInstallationId: string;
  bindingProviderInstallationId: string | null;
  bindingProductPolicyVersion: number | null;
  bindingCapabilitySnapshot: unknown;
  currentProviderType: string | null;
  currentProviderEnabled: boolean | null;
  currentProviderCapabilities: unknown;
}>;

export function providerBindingAllowsProvisioning(
  input: ProvisioningBindingInput,
): boolean {
  const bindingCapabilities = exactStringList(input.bindingCapabilitySnapshot);
  const currentCapabilities = exactStringList(input.currentProviderCapabilities);
  return (
    input.operationProviderInstallationId === "mock-provisioning-v1" &&
    input.bindingProviderInstallationId === input.operationProviderInstallationId &&
    input.bindingProductPolicyVersion !== null &&
    input.currentProviderType === "provisioning" &&
    input.currentProviderEnabled === true &&
    bindingCapabilities !== null &&
    currentCapabilities !== null &&
    REQUIRED_PROVISIONING_CAPABILITIES.every(
      (capability) =>
        bindingCapabilities.includes(capability) && currentCapabilities.includes(capability),
    )
  );
}

export async function executeProviderBoundProvisioning<T>(
  input: ProvisioningBindingInput,
  execute: () => Promise<T>,
): Promise<T> {
  if (!providerBindingAllowsProvisioning(input)) {
    throw new Error("Saved Provider binding is not currently executable");
  }
  return execute();
}
