// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
  expireProviderCredentialOverlap,
  installProviderRuntime,
  providerInstallationReview,
  providerOperationAdmissionDecision,
  providerUninstallDecision,
  rotateProviderCredential,
  transitionProviderInstallation,
  type ProviderManifest,
  type ProviderOperationAdmissionDecision,
  type ProviderOperationAdmissionInput,
} from "@opensales/provider-sdk-typescript";

export interface ProviderManagementLifecycleConformanceReport {
  providerId: string;
  installed: true;
  pauseBlockedNewMutationWithoutSideEffect: true;
  pausePreservedReconciliation: true;
  resumeAcceptedNewMutation: true;
  rotationOverlapAcceptedVersions: number[];
  expiredCredentialVersionRejected: number;
  currentCredentialVersionAccepted: number;
  amountLimitEnforced: true;
  resourceLimitEnforced: true;
  concurrencyLimitEnforced: true;
  uninstallBlockers: Array<"unknown_operations" | "pending_funds" | "owned_active_resources">;
  uninstallAllowedAfterDrain: true;
  revokeBlockedNewMutation: true;
  revokePreservedReconciliation: true;
  admittedMutationSideEffects: number;
}

const installedAt = "2026-08-20T00:00:00.000Z";
const overlapEndsAt = "2026-08-21T00:00:00.000Z";
const overlapTime = "2026-08-20T12:00:00.000Z";
const afterOverlap = "2026-08-21T00:00:01.000Z";

export function runProviderManagementLifecycleConformance(
  manifest: ProviderManifest,
): ProviderManagementLifecycleConformanceReport {
  const review = providerInstallationReview(manifest);
  assert.equal(review.identity.providerId, manifest.providerId);
  assert.equal(manifest.lifecycle.supportsPause, true, "Lifecycle conformance requires pause support");
  assert.equal(manifest.lifecycle.supportsCredentialRotation, true, "Lifecycle conformance requires rotation support");
  assert.equal(manifest.lifecycle.supportsManualTakeover, true, "Lifecycle conformance requires manual takeover support");
  assert.equal(manifest.lifecycle.uninstallRequiresNoUnknownOperations, true);
  assert.equal(manifest.lifecycle.uninstallRequiresNoPendingFunds, true);
  assert.equal(manifest.lifecycle.uninstallRequiresNoOwnedResources, true);
  assert.notEqual(manifest.limits.maxAmountMinor, null, "Lifecycle conformance requires a finite amount limit");
  assert.notEqual(manifest.limits.maxOwnedResources, null, "Lifecycle conformance requires a finite resource limit");
  const amountLimit = manifest.limits.maxAmountMinor;
  const resourceLimit = manifest.limits.maxOwnedResources;
  assert.ok(amountLimit !== null && BigInt(amountLimit) > 0n);
  assert.ok(resourceLimit !== null && resourceLimit > 0);

  let state = installProviderRuntime(manifest, 1);
  let sideEffects = 0;
  const decide = (
    overrides: Partial<ProviderOperationAdmissionInput> = {},
  ): ProviderOperationAdmissionDecision => providerOperationAdmissionDecision(manifest, state, {
    kind: "mutation",
    credentialVersion: state.credentials.currentVersion,
    activeOperations: 0,
    ownedActiveResources: 0,
    now: installedAt,
    ...overrides,
  });
  const mutate = (overrides: Partial<ProviderOperationAdmissionInput> = {}) => {
    const decision = decide(overrides);
    if (decision.allowed) sideEffects += 1;
    return decision;
  };

  assert.equal(mutate({ amountMinor: "1" }).allowed, true);
  state = transitionProviderInstallation(manifest, state, "pause");
  const beforePausedMutation = sideEffects;
  const pausedMutation = mutate();
  assert.deepEqual(pausedMutation.blockers, ["installation_paused"]);
  assert.equal(sideEffects, beforePausedMutation);
  const pausedReconcile = decide({ kind: "reconcile" });
  assert.equal(pausedReconcile.allowed, true);

  state = transitionProviderInstallation(manifest, state, "resume");
  assert.equal(mutate().allowed, true);

  state = rotateProviderCredential(manifest, state, 2, overlapEndsAt, overlapTime);
  assert.equal(mutate({ credentialVersion: 1, now: overlapTime }).allowed, true);
  assert.equal(mutate({ credentialVersion: 2, now: overlapTime }).allowed, true);
  state = expireProviderCredentialOverlap(state, afterOverlap);
  const expiredCredential = mutate({ credentialVersion: 1, now: afterOverlap });
  assert.deepEqual(expiredCredential.blockers, ["credential_not_current_or_in_overlap"]);
  assert.equal(mutate({ credentialVersion: 2, now: afterOverlap }).allowed, true);

  assert.equal(mutate({ amountMinor: amountLimit, now: afterOverlap }).allowed, true);
  const overAmount = mutate({ amountMinor: (BigInt(amountLimit) + 1n).toString(), now: afterOverlap });
  assert.deepEqual(overAmount.blockers, ["amount_limit"]);
  assert.equal(mutate({ createsOwnedResource: true, ownedActiveResources: resourceLimit - 1, now: afterOverlap }).allowed, true);
  const resourceAtLimit = mutate({ createsOwnedResource: true, ownedActiveResources: resourceLimit, now: afterOverlap });
  assert.deepEqual(resourceAtLimit.blockers, ["resource_limit"]);
  assert.equal(mutate({ activeOperations: manifest.limits.maxConcurrentOperations - 1, now: afterOverlap }).allowed, true);
  const concurrencyAtLimit = mutate({ activeOperations: manifest.limits.maxConcurrentOperations, now: afterOverlap });
  assert.deepEqual(concurrencyAtLimit.blockers, ["concurrency_limit"]);

  const blockedUninstall = providerUninstallDecision(manifest, {
    unknownOperations: 1,
    pendingFunds: 1,
    ownedActiveResources: 1,
  });
  assert.deepEqual(blockedUninstall.blockers, ["unknown_operations", "pending_funds", "owned_active_resources"]);
  assert.equal(blockedUninstall.allowed, false);
  const drainedUninstall = providerUninstallDecision(manifest, {
    unknownOperations: 0,
    pendingFunds: 0,
    ownedActiveResources: 0,
  });
  assert.equal(drainedUninstall.allowed, true);

  state = transitionProviderInstallation(manifest, state, "revoke");
  const beforeRevokedMutation = sideEffects;
  const revokedMutation = mutate({ now: afterOverlap });
  assert.deepEqual(revokedMutation.blockers, ["installation_revoked"]);
  assert.equal(sideEffects, beforeRevokedMutation);
  const revokedReconcile = decide({ kind: "reconcile", now: afterOverlap });
  assert.equal(revokedReconcile.allowed, true);

  return {
    providerId: manifest.providerId,
    installed: true,
    pauseBlockedNewMutationWithoutSideEffect: true,
    pausePreservedReconciliation: true,
    resumeAcceptedNewMutation: true,
    rotationOverlapAcceptedVersions: [1, 2],
    expiredCredentialVersionRejected: 1,
    currentCredentialVersionAccepted: 2,
    amountLimitEnforced: true,
    resourceLimitEnforced: true,
    concurrencyLimitEnforced: true,
    uninstallBlockers: blockedUninstall.blockers,
    uninstallAllowedAfterDrain: true,
    revokeBlockedNewMutation: true,
    revokePreservedReconciliation: true,
    admittedMutationSideEffects: sideEffects,
  };
}
