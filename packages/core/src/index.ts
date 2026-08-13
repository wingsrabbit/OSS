// SPDX-License-Identifier: AGPL-3.0-or-later

export const LAB_BANNER = "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY" as const;

export {
  CONTENT_KINDS,
  CONTENT_LOCALES,
  CONTENT_STATUS_LEVELS,
  contentLocale,
  resolveLocalizedCurrent,
  type ContentKind,
  type ContentLocale,
  type ContentStatusLevel,
  type LocalizedCurrentRevision,
} from "./content-operations.js";

export const CUSTOMER_CAPABILITIES = [
  "account.contacts.manage",
  "account.contacts.read",
  "account.history.read",
  "account.members.manage",
  "account.members.read",
  "billing.read",
  "billing.write",
  "orders.create",
  "services.manage",
  "support.tickets.write",
] as const;

export type CustomerCapability = (typeof CUSTOMER_CAPABILITIES)[number];
export type CustomerMembershipRole = "owner" | "billing" | "technical" | "viewer";

const customerCapabilitySet = new Set<string>(CUSTOMER_CAPABILITIES);

export function customerMembershipCapabilities(input: Readonly<{
  role: CustomerMembershipRole;
  permissions: readonly string[];
}>): readonly CustomerCapability[] {
  if (input.role === "owner" || input.permissions.includes("*")) {
    return [...CUSTOMER_CAPABILITIES];
  }
  const capabilities = new Set<CustomerCapability>([
    "account.history.read",
    "billing.read",
  ]);
  if (input.role === "billing") {
    capabilities.add("orders.create");
    capabilities.add("billing.write");
    capabilities.add("support.tickets.write");
  } else if (input.role === "technical") {
    capabilities.add("services.manage");
    capabilities.add("support.tickets.write");
  }
  for (const permission of input.permissions) {
    if (customerCapabilitySet.has(permission)) {
      capabilities.add(permission as CustomerCapability);
    }
  }
  return [...capabilities].sort();
}

export function hasCustomerMembershipCapability(
  input: Readonly<{
    role: CustomerMembershipRole;
    permissions: readonly string[];
  }>,
  capability: CustomerCapability,
): boolean {
  return customerMembershipCapabilities(input).includes(capability);
}

export {
  assertMigrationDatabaseRoleSafe,
  assertRuntimeDatabaseRoleSafe,
  type DatabaseRoleBoundaryQueryable,
} from "./database-role-boundary.js";

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
  | "expired"
  | "requires_action";
export type ProviderOperationStatus = "queued" | "running" | "unknown" | "succeeded" | "failed";
export type ServiceStatus =
  | "pending"
  | "provisioning"
  | "confirming"
  | "provisioned_hold"
  | "provision_failed"
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
  "requires_action",
]);

const paymentTransitions: Readonly<Record<PaymentStatus, ReadonlySet<PaymentStatus>>> = {
  created: new Set(["processing", "failed", "cancelled", "expired", "requires_action", "succeeded"]),
  processing: new Set(["unknown", "failed", "cancelled", "expired", "requires_action", "succeeded"]),
  unknown: new Set(["failed", "cancelled", "expired", "requires_action", "succeeded"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  expired: new Set(),
  requires_action: new Set(),
};

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  if (from === to) return true;
  if (terminalPayments.has(from)) return false;
  return paymentTransitions[from].has(to);
}

export type PaymentBusinessState =
  | { readonly paymentContext: "order"; readonly orderStatus: string }
  | {
      readonly paymentContext: "renewal";
      readonly renewalStatus: string | null;
      readonly serviceStatus: string;
    };

export function isPaymentBusinessStatePayable(state: PaymentBusinessState): boolean {
  if (state.paymentContext === "order") return state.orderStatus === "waiting_payment";

  return (
    state.renewalStatus === "invoiced" &&
    (state.serviceStatus === "active" || state.serviceStatus === "suspended")
  );
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

export function percentageFeeMinor(nonFeeBaseMinor: bigint, basisPoints: number): bigint {
  assertMinorUnits(nonFeeBaseMinor);
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new Error("Fee basis points must be an integer from 0 through 10000");
  }
  if (nonFeeBaseMinor === 0n || basisPoints === 0) return 0n;
  return (nonFeeBaseMinor * BigInt(basisPoints) + 5_000n) / 10_000n;
}
