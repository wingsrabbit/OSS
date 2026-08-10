// SPDX-License-Identifier: AGPL-3.0-or-later

export type RenewalReminderStatus =
  | "queued"
  | "delivered"
  | "bounced"
  | "failed"
  | "skipped"
  | "suppressed"
  | "retrying"
  | "manual";

export type RenewalReminderProjectionInput = {
  deliveryStatus: "delivered" | "bounced" | "failed" | null;
  providerOccurredAt: Date | null;
  genericOperationStatus: string | null;
  genericAttemptNumber: number | null;
  genericFactStatus: "delivered" | "bounced" | "failed" | "skipped" | null;
  genericRecordedAt: Date | null;
  genericUpdatedAt: Date | null;
  suppressedAt: Date | null;
  jobStatus: string | null;
  jobAttempts: number | null;
};

export function projectRenewalReminderStatus(
  input: RenewalReminderProjectionInput,
): { status: RenewalReminderStatus; outcomeAt: Date | null } {
  const terminalProviderStatus =
    input.deliveryStatus === "delivered" || input.deliveryStatus === "bounced"
      ? input.deliveryStatus
      : null;
  if (terminalProviderStatus) {
    return { status: terminalProviderStatus, outcomeAt: input.providerOccurredAt };
  }
  if (input.suppressedAt) {
    return { status: "suppressed", outcomeAt: input.suppressedAt };
  }
  if (
    input.genericFactStatus === "skipped" ||
    input.genericOperationStatus === "skipped"
  ) {
    return {
      status: "skipped",
      outcomeAt: input.genericRecordedAt ?? input.genericUpdatedAt,
    };
  }
  if (input.genericOperationStatus === "manual" || input.jobStatus === "manual") {
    return { status: "manual", outcomeAt: input.genericUpdatedAt };
  }
  const operationIsRetrying =
    input.genericOperationStatus === "dispatching" ||
    input.genericOperationStatus === "unknown" ||
    (input.genericOperationStatus === "queued" &&
      (input.genericAttemptNumber ?? 1) > 1) ||
    ((input.jobStatus === "pending" || input.jobStatus === "running") &&
      (input.genericOperationStatus === "failed" || (input.jobAttempts ?? 0) > 0));
  if (operationIsRetrying) {
    return { status: "retrying", outcomeAt: input.providerOccurredAt };
  }
  if (
    input.genericOperationStatus === "failed" ||
    input.genericFactStatus === "failed" ||
    input.deliveryStatus === "failed"
  ) {
    return { status: "failed", outcomeAt: input.providerOccurredAt };
  }
  return { status: "queued", outcomeAt: null };
}
