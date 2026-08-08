// SPDX-License-Identifier: AGPL-3.0-or-later

export type JobClaimAttempt<T> =
  | { readonly kind: "claimed"; readonly job: T | null }
  | { readonly kind: "failed"; readonly error: unknown };

export async function attemptJobClaim<T>(
  claim: () => Promise<T | null>,
): Promise<JobClaimAttempt<T>> {
  try {
    return { kind: "claimed", job: await claim() };
  } catch (error) {
    return { kind: "failed", error };
  }
}
