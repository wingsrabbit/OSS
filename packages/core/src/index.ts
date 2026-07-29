// SPDX-License-Identifier: AGPL-3.0-or-later

export const LAB_BANNER = "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY" as const;

export type BillingCycle = "monthly" | "quarterly" | "semiannual" | "annual" | "one_time";
export type FulfillmentMode = "automatic" | "review" | "manual" | "quote";
export type OrderStatus =
  | "waiting_payment"
  | "on_hold"
  | "accepted"
  | "awaiting_manual"
  | "fulfilling"
  | "completed"
  | "rejected"
  | "cancelled";
export type PaymentStatus =
  | "created"
  | "processing"
  | "unknown"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";
export type ProviderOperationStatus = "queued" | "running" | "unknown" | "succeeded" | "failed";
export type ServiceStatus =
  | "pending"
  | "provisioning"
  | "confirming"
  | "provisioned_hold"
  | "active"
  | "suspended"
  | "terminated";

export interface PriceComponent {
  readonly code: string;
  readonly label: string;
  readonly quantity: number;
  readonly oneTimeMinor: bigint;
  readonly recurringMinor: bigint;
}

export interface PriceSnapshot {
  readonly currency: string;
  readonly billingCycle: BillingCycle;
  readonly productId: string;
  readonly productName: string;
  readonly fulfillmentMode: FulfillmentMode;
  readonly components: readonly PriceComponent[];
  readonly oneTimeSubtotalMinor: bigint;
  readonly setupMinor: bigint;
  readonly recurringSubtotalMinor: bigint;
  readonly invoiceTotalMinor: bigint;
}

export function assertMinorUnits(value: bigint): bigint {
  if (value < 0n) {
    throw new Error("Money cannot be negative");
  }
  return value;
}

export function buildPriceSnapshot(input: {
  productId: string;
  productName: string;
  currency: string;
  billingCycle: BillingCycle;
  fulfillmentMode: FulfillmentMode;
  baseOneTimeMinor: bigint;
  setupMinor: bigint;
  baseRecurringMinor: bigint;
  optionComponents: readonly PriceComponent[];
}): PriceSnapshot {
  const components: PriceComponent[] = [
    {
      code: "base",
      label: input.productName,
      quantity: 1,
      oneTimeMinor: assertMinorUnits(input.baseOneTimeMinor),
      recurringMinor: assertMinorUnits(input.baseRecurringMinor),
    },
    ...input.optionComponents.map((component) => ({
      ...component,
      oneTimeMinor: assertMinorUnits(component.oneTimeMinor),
      recurringMinor: assertMinorUnits(component.recurringMinor),
    })),
  ];
  const oneTimeSubtotalMinor = components.reduce(
    (total, component) => total + component.oneTimeMinor * BigInt(component.quantity),
    0n,
  );
  const recurringSubtotalMinor = components.reduce(
    (total, component) => total + component.recurringMinor * BigInt(component.quantity),
    0n,
  );
  const setupMinor = assertMinorUnits(input.setupMinor);

  return {
    currency: input.currency,
    billingCycle: input.billingCycle,
    productId: input.productId,
    productName: input.productName,
    fulfillmentMode: input.fulfillmentMode,
    components,
    oneTimeSubtotalMinor,
    setupMinor,
    recurringSubtotalMinor,
    invoiceTotalMinor: oneTimeSubtotalMinor + setupMinor + recurringSubtotalMinor,
  };
}

const terminalPayments = new Set<PaymentStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

const paymentTransitions: Readonly<Record<PaymentStatus, ReadonlySet<PaymentStatus>>> = {
  created: new Set(["processing", "failed", "cancelled", "expired", "succeeded"]),
  processing: new Set(["unknown", "failed", "cancelled", "expired", "succeeded"]),
  unknown: new Set(["failed", "cancelled", "expired", "succeeded"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  expired: new Set(),
};

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  if (from === to) return true;
  if (terminalPayments.has(from)) return false;
  return paymentTransitions[from].has(to);
}

export function addBillingCycle(start: Date, cycle: BillingCycle): Date | null {
  if (cycle === "one_time") return null;
  const months = cycle === "monthly" ? 1 : cycle === "quarterly" ? 3 : cycle === "semiannual" ? 6 : 12;
  const result = new Date(start);
  const originalDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const finalDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(originalDay, finalDay));
  return result;
}

export function jsonMoney(value: bigint): string {
  return value.toString();
}
