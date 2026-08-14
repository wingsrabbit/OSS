// SPDX-License-Identifier: AGPL-3.0-or-later

import { LAB_BANNER } from "@opensales/core";
import {
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ManualReceiptOutflowPanel,
  type ManualReceiptOriginalSourceOutflow,
} from "./ManualReceiptOutflows.js";
import {
  AdminAccount360,
  type AdminAccountAction,
} from "./AdminAccount360.js";
import { AccountAccessPanel } from "./AccountAccessPanel.js";
import { AdminServiceOperationsQueue } from "./AdminServiceOperationsQueue.js";
import { AccountContextSwitcher, type MembershipRole } from "./AccountContextSwitcher.js";
import {
  ApiError,
  ObsoleteSessionResponseError,
  api,
  getAccountContextSnapshot,
  hardResetSession,
  subscribeAccountContextInvalidation,
} from "./api.js";
import { CustomerBusinessHistory } from "./CustomerBusinessHistory.js";
import { NotificationDeliveryHistory } from "./NotificationDeliveryHistory.js";
import { EmailChangePage, PasswordRecoveryPage, SecurityPanel } from "./SecurityPanel.js";
import { TicketsPanel } from "./TicketsPanel.js";

type Locale = "en" | "zh-CN";
type AppRoute = "/" | "/customer" | "/admin" | "/security" | "/password-recovery" | "/email-change";

function routeFromPath(pathname: string): AppRoute {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (
    normalized === "/customer" || normalized === "/admin" ||
    normalized === "/security" || normalized === "/password-recovery" ||
    normalized === "/email-change"
  ) return normalized;
  if (normalized === "/membership-invitations/accept") return "/customer";
  return "/";
}

function newIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
    throw new Error("Secure random number generation is unavailable");
  }
  if (typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();

  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type Me = {
  id: string;
  email: string;
  locale: Locale;
  clientAccountId: string | null;
  membershipRole: MembershipRole | null;
  accountContextVersion: string;
  context: {
    clientAccountId: string;
    name: string;
    role: MembershipRole;
    permissions: string[];
    capabilities: string[];
    version: string;
  } | null;
  verification: { email: "pending" | "passed" };
  restrictions: { user: boolean; clientAccount: boolean };
  eligible: boolean;
  staff: { roles: string[]; permissions: unknown } | null;
};

function parseStaffPermissions(value: unknown): ReadonlySet<string> {
  if (
    !Array.isArray(value) ||
    !value.every(
      (permission) =>
        typeof permission === "string" &&
        permission.length > 0 &&
        permission.trim() === permission,
    )
  ) {
    return new Set();
  }
  return new Set(value);
}

type Price = {
  id: string;
  currency: string;
  billingCycle: string;
  oneTimeMinor: string;
  setupMinor: string;
  recurringMinor: string;
};
type Product = {
  id: string;
  groupId: string;
  groupName: string;
  name: string;
  description: string;
  fulfillmentMode: "automatic" | "review" | "manual" | "quote";
  optionSchema: Array<Record<string, unknown>>;
  prices: Price[];
  purchasable: boolean;
};
type Legal = {
  documents: Record<"terms" | "aup" | "privacy", { version: string; title: string; body: string }>;
};
type OrderDetail = {
  order: { id: string; status: string; price: { productName: string; billingCycle: string } };
  invoice: {
    id: string;
    currency: string;
    totalMinor: string;
    allocatedMinor: string;
    paymentAllocatedMinor: string;
    creditAppliedMinor: string;
    paymentFeeMinor: string;
    dueMinor: string;
    status: string;
  };
  payment: { status: string | null };
  provisioning: { status: string | null };
  service: {
    id: string;
    status: string;
    activatedAt: string | null;
    termStart: string | null;
    termEnd: string | null;
    version: number;
    cancellation: {
      requestId: string;
      status: "scheduled" | "processing" | "unknown" | "manual" | "terminated";
      executionMode: "automatic" | "manual";
      scheduledAt: string;
      effectiveAt: string;
      result: Record<string, unknown>;
      lastError: string | null;
      providerOperation: { status: string; attempts: number } | null;
    } | null;
  };
};
type OrderSummary = {
  orderId: string;
  orderStatus: string;
  productName: string;
  serviceId: string;
  serviceStatus: string;
  createdAt: string;
};
type LabMessage = {
  id: string;
  subject: string;
  body: string;
  status: string;
  deliveredAt: string;
};
type ManualItem = {
  serviceId: string;
  orderId: string;
  clientAccountId: string;
  productName: string;
  billingCycle: string;
  clientAccountName: string;
  paidMinor: string;
  totalMinor: string;
  submittedAt: string;
};
type AdminOperationContext = {
  action: AdminAccountAction;
  account: { id: string; name: string };
};
type AdminOperationScope = {
  operationGeneration: number;
  accessGeneration: number;
  accountId: string | null;
  accessFingerprint: string;
};
type AdminCancellationItem = {
  requestId: string;
  executionId: string;
  serviceId: string;
  serviceStatus: string;
  clientAccountName: string;
  productName: string;
  effectiveAt: string;
  executionMode: "automatic" | "manual";
  executionStatus: "scheduled" | "processing" | "unknown" | "manual" | "terminated";
  executionVersion: number;
  serviceVersion: number;
  lastError: string | null;
  providerOperation: { status: string; attempts: number } | null;
  job: { status: string; lastError: string | null };
  interventionRequired: boolean;
};

function cancellationStatusLabel(
  status: AdminCancellationItem["executionStatus"],
  locale: Locale,
): string {
  if (locale === "en") return status.replaceAll("_", " ");
  return {
    scheduled: "已安排",
    processing: "正在终止",
    unknown: "结果未知，正在对账",
    manual: "等待管理员处理",
    terminated: "已终止",
  }[status];
}

function cancellationExecutionLabel(
  mode: AdminCancellationItem["executionMode"],
  locale: Locale,
): string {
  if (locale === "en") return mode;
  return mode === "automatic" ? "Mock Provider 自动执行" : "管理员人工执行";
}
type UnclaimedFundItem = {
  receiptId: string;
  clientAccountId: string;
  clientAccountName: string;
  providerInstallationId: string | null;
  externalPaymentId: string | null;
  source: "manual" | "provider";
  manualReceiptId: string | null;
  manualReference: string | null;
  amountMinor: string;
  allocatedMinor: string;
  remainingMinor: string;
  reservedRefundMinor: string;
  confirmedOutflowMinor: string;
  availableMinor: string;
  capacityFrozen: boolean;
  currency: string;
  occurredAt: string;
  disposition: string;
  reason: string | null;
  suggestedInvoiceId: string | null;
};
type ManualReceiptItem = {
  manualReceiptId: string;
  fundReceiptId: string;
  reference: string;
  receivedAt: string;
  grossAmountMinor: string;
  feeMinor: string;
  netAmountMinor: string;
  allocatedMinor: string;
  availableMinor: string;
  capacityFrozen: boolean;
  currency: "USD";
  disposition: string;
  originalSourceOutflow: ManualReceiptOriginalSourceOutflow;
  reversal: {
    reversalId: string;
    actorId: string;
    reason: string;
    createdAt: string;
  } | null;
  actorId: string;
  reason: string;
  createdAt: string;
};
type ManualReceiptOutcome = {
  manualReceiptId: string;
  fundReceiptId: string;
  clientAccountId: string;
  reference: string;
  receivedAt: string;
  grossAmountMinor: string;
  feeMinor: string;
  netAmountMinor: string;
  currency: "USD";
  disposition: "unclaimed";
  allocatedMinor: "0";
  providerUsed: false;
  replayed: boolean;
};
type ManualReceiptReversalOutcome = {
  reversalId: string;
  manualReceiptId: string;
  fundReceiptId: string;
  clientAccountId: string;
  grossAmountMinor: string;
  feeMinor: string;
  netAmountMinor: string;
  currency: "USD";
  disposition: "reversed";
  providerUsed: false;
  cashOutflow: false;
  replayed: boolean;
};
type RefundCandidate = {
  receiptId: string;
  invoiceId: string;
  clientAccountId: string;
  clientAccountName: string;
  providerInstallationId: string;
  externalPaymentId: string;
  receiptAmountMinor: string;
  refundableMinor: string;
  referenceRefundMinor: string | null;
  referenceOnly: true;
  currency: string;
  serviceId: string | null;
  termStart: string | null;
  termEnd: string | null;
  occurredAt: string;
};
type RefundRecord = {
  refundId: string;
  invoiceId: string | null;
  clientAccountId: string;
  sourceContext: "allocated_invoice" | "unclaimed_funds";
  receiptId: string;
  destination: "original_payment" | "credit" | "none";
  amountMode: "full" | "partial" | "none";
  amountMinor: string;
  currency: string;
  status: string;
  version: number;
  securityHold: boolean;
  securityHoldReason: string | null;
  securityHoldCreatedAt: string | null;
  providerOperationStatus: string | null;
  externalRefundId: string | null;
  lastError: string | null;
  replayed: boolean;
};
type RefundSecurityHold = {
  holdId: string;
  receiptId: string;
  receiptAmountMinor: string;
  receiptAllocatedMinor: string;
  confirmedSettlementMinor: string;
  refundId: string;
  invoiceId: string | null;
  sourceContext: "allocated_invoice" | "unclaimed_funds";
  clientAccountId: string;
  clientAccountName: string;
  refundStatus: string;
  refundVersion: number;
  refundAmountMinor: string;
  refundCurrency: string;
  reason: string;
  createdAt: string;
  providerFact: {
    factId: string;
    eventId: string;
    externalRefundId: string;
    status: "succeeded" | "failed";
    amountMinor: string;
    currency: string;
    occurredAt: string;
  };
  providerFacts: Array<{
    factId: string;
    eventId: string;
    externalRefundId: string;
    status: "succeeded" | "failed";
    amountMinor: string;
    currency: string;
    occurredAt: string;
  }>;
  discrepancy: {
    discrepancyId: string;
    providerFactId: string;
    externalRefundId: string;
    amountMinor: string;
    currency: string;
    occurredAt: string;
    cashAlreadyPosted: true;
  } | null;
  allowedDecisions: Array<
    | "accept_authorized_outflow"
    | "record_unexpected_outflow"
    | "dismiss_provider_claim"
  >;
  impact: {
    acceptAuthorizedOutflow?: string;
    recordUnexpectedOutflow?: string;
    dismissProviderClaim: string;
  };
};
type RefundDismissalCorrection = {
  adjudicationId: string;
  holdId: string;
  refundId: string;
  refundVersion: number;
  invoiceId: string | null;
  clientAccountId: string;
  clientAccountName: string;
  receiptId: string;
  providerInstallationId: string;
  providerFact: {
    factId: string;
    eventId: string;
    externalRefundId: string;
    amountMinor: string;
    currency: string;
    occurredAt: string;
  };
  discrepancyId: string | null;
  dismissalReason: string;
  dismissedAt: string;
  impact: string;
};
type RefundReceiptCapacityIncident = {
  incidentId: string;
  receiptId: string;
  receiptSequence: string;
  source:
    | { type: "dismissal_correction"; correctionId: string }
    | { type: "unexpected_outflow_adjudication"; adjudicationId: string };
  refundId: string;
  invoiceId: string | null;
  sourceContext: "allocated_invoice" | "unclaimed_funds";
  clientAccountId: string;
  clientAccountName: string;
  receiptAllocatedMinor: string;
  allocatedContributionMinor: string;
  confirmedProviderOutflowMinor: string;
  confirmedDispositionMinor: string;
  confirmedCompensationMinor: string;
  receiptAmountMinor: string;
  overageMinor: string;
  currency: string;
  reason: string;
  createdAt: string;
  isCurrentSnapshot: boolean;
  status:
    | "awaiting_acknowledgement"
    | "acknowledged_recovery_outstanding"
    | "superseded_history";
  acknowledgement: {
    acknowledgementId: string;
    reason: string;
    createdAt: string;
    recoveryOutstanding: boolean;
  } | null;
  requiresReauthentication: boolean;
  allowedAction: "acknowledge_manual_recovery" | null;
  impact: string;
};
type BillingSummary = {
  currency: string;
  creditBalanceMinor: string;
  paymentMethods: Array<{
    code: string;
    name: string;
    feeBasisPoints: number;
    addFundsEnabled: boolean;
    savedMethodEnabled: boolean;
    automaticRenewalEnabled: boolean;
  }>;
  addFunds: {
    enabled: boolean;
    allowed: boolean;
    minimumMinor: string;
    maximumMinor: string;
    balanceCapMinor: string;
  };
};
type PaymentSettings = {
  defaults: { savePaymentMethod: false; automaticRenewal: false };
  consentVersions: { savePaymentMethod: string; automaticRenewal: string };
  methods: Array<{
    id: string;
    paymentMethod: string;
    instrumentType: string;
    brand: string;
    lastFour: string;
    expiryMonth: number | null;
    expiryYear: number | null;
    status: "active" | "invalid";
    default: boolean;
    consentVersion: string;
    savedAt: string;
    version: number;
  }>;
  automaticRenewals: Array<{
    id: string;
    serviceId: string;
    productName: string;
    savedPaymentMethodId: string;
    status: "active" | "revoked";
    consentVersion: string;
    grantedAt: string;
    revokedAt: string | null;
    latestAutomaticPaymentStatus: string | null;
    version: number;
  }>;
  pendingAutomaticRenewals: Array<{
    paymentAttemptId: string;
    serviceId: string;
    productName: string;
    paymentStatus: "created" | "processing" | "unknown";
    consentVersion: string;
    decisionGeneration: string;
    requestedAt: string;
  }>;
  serviceDecisions: Array<{
    serviceId: string;
    decisionGeneration: string;
  }>;
};
type RenewalReminder = {
  kind: "renewal_created" | "pre_due" | "overdue_first";
  offsetDays: number;
  status:
    | "queued"
    | "delivered"
    | "bounced"
    | "failed"
    | "skipped"
    | "suppressed"
    | "retrying"
    | "manual";
  createdAt: string;
  deliveredAt: string | null;
  outcomeAt: string | null;
};
type RenewalItem = {
  renewalId: string;
  serviceId: string;
  productName: string;
  serviceStatus: string;
  billingCycle: string;
  termStart: string;
  termEnd: string;
  invoiceId: string;
  currency: string;
  totalMinor: string;
  allocatedMinor: string;
  dueMinor: string;
  status: "open" | "partially_paid" | "paid" | "cancelled";
  fundingStatus: "open" | "partially_paid" | "paid" | "cancelled";
  renewalStatus: "invoiced" | "paid" | "manual_hold" | "cancelled";
  fundedAt: string | null;
  dueAt: string;
  periodStart: string;
  periodEnd: string;
  settledAt: string | null;
  version: number;
  reminders: RenewalReminder[];
  lateFee: {
    disposition: "charged" | "skipped_zero";
    basisMinor: string;
    basisPoints: number;
    amountMinor: string;
    businessDate: string;
  } | null;
  delinquency: {
    caseId: string;
    action: "automatic" | "manual" | "none";
    decisionReason: string;
    status: string;
    resumeRequired: boolean;
    providerInstallationId: string | null;
    lastError: string | null;
    version: number;
    suspendOperation: { status: string; attempts: number } | null;
    resumeOperation: { status: string; attempts: number } | null;
    manualControl: {
      allowedActions: Array<"confirm_suspended" | "confirm_restored">;
      requiresReauthentication: true;
      actionCount: string;
      latestActionAt: string | null;
      blockedReason: string | null;
      impact: {
        confirmSuspended: string;
        confirmRestored: string;
      };
    } | null;
  } | null;
  paymentReconciliationHold: {
    active: boolean;
    deferralCount: string;
    latestDeferredAt: string | null;
  };
  automaticPayment: {
    status: "processing" | "unknown" | "succeeded" | "failed" | "requires_action" | "blocked";
    attemptCount: number;
    maxAttempts: number;
    lastError: string | null;
    customerActionRequired: boolean;
  } | null;
};
type AdminRenewalItem = RenewalItem & {
  clientAccountId: string;
  clientAccountName: string;
};
type PaymentQuote = {
  quoteId: string;
  method: string;
  creditToApplyMinor: string;
  externalNonFeeMinor: string;
  feeMinor: string;
  externalDueMinor: string;
  expiresAt: string;
};
type AddFundsQuote = {
  quoteId: string;
  currency: string;
  paymentMethod: string;
  principalMinor: string;
  feeBasisPoints: number;
  feeMinor: string;
  externalDueMinor: string;
  creditBalanceMinor: string;
  pendingPrincipalMinor: string;
  balanceCapMinor: string;
  expiresAt: string;
};
type AddFundsCommand = {
  commandId: string;
  status: string;
  attemptStatus: string;
  providerOperationStatus: string | null;
  principalMinor: string;
  feeMinor: string;
  externalDueMinor: string;
  result: Record<string, unknown> | null;
};
type AddFundsChargeback = {
  chargebackEffectId: string;
  clientAccountId: string;
  clientAccountName: string;
  providerInstallationId: string;
  originalExternalPaymentId: string;
  externalChargebackId: string;
  principalMinor: string;
  feeMinor: string;
  externalAmountMinor: string;
  creditRecoveredMinor: string;
  debtMinor: string;
  currency: string;
  occurredAt: string;
  restrictedAt: string | null;
  restrictionActive: boolean;
  semanticReplayCount: string;
};
type AddFundsUnclaimedChargeback = {
  unclaimedChargebackEffectId: string;
  fundReceiptId: string;
  clientAccountId: string;
  clientAccountName: string;
  providerInstallationId: string;
  originalExternalPaymentId: string;
  externalChargebackId: string;
  externalAmountMinor: string;
  currency: string;
  occurredAt: string;
  semanticReplayCount: string;
};
type AddFundsChargebackHold = {
  holdId: string;
  clientAccountId?: string | null;
  clientAccountName?: string | null;
  externalChargebackId?: string;
  originalExternalPaymentId?: string;
  amountMinor?: string;
  currency?: string;
  reason: string;
  occurredAt?: string;
  createdAt: string;
};
type ChargebackStatus = {
  clientAccountId: string;
  restricted: boolean;
  creditBalanceMinor: string;
  debtBalanceMinor: string;
  chargebacks: AddFundsChargeback[];
  unclaimedChargebacks: AddFundsUnclaimedChargeback[];
  manualHolds: AddFundsChargebackHold[];
};

const words = {
  en: {
    catalog: "Product catalog",
    account: "Customer account",
    register: "Register",
    login: "Sign in",
    verify: "Verify email",
    buy: "Configure & order",
    pay: "Start mock payment",
    pending: "Verification is required before ordering or paying.",
    ready: "Email verified — account is eligible to purchase.",
  },
  "zh-CN": {
    catalog: "产品目录",
    account: "客户账号",
    register: "注册",
    login: "登录",
    verify: "验证邮箱",
    buy: "配置并下单",
    pay: "发起 Mock 付款",
    pending: "完成邮箱验证后才能下单或付款。",
    ready: "邮箱已验证，可以购买。",
  },
} as const;

function usd(minor: string): string {
  const value = BigInt(minor);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const dollars = absolute / 100n;
  const cents = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${dollars.toLocaleString("en-US")}.${cents}`;
}

function reminderLabel(reminder: RenewalReminder): string {
  if (reminder.kind === "pre_due") return `pre-due ${reminder.offsetDays}d`;
  if (reminder.kind === "overdue_first") return `overdue ${reminder.offsetDays}d`;
  return "invoice created";
}

async function fundResolutionIdempotencyKey(requestIdentity: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(requestIdentity),
  );
  const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `fund-resolution:${fingerprint}`;
}

async function refundIntentStorageKey(requestIdentity: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(requestIdentity),
  );
  const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `opensales:refund-intent:${fingerprint}`;
}

async function manualReceiptIntentStorageKey(requestIdentity: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(requestIdentity),
  );
  const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `opensales:manual-receipt-intent:${fingerprint}`;
}

async function manualReceiptReversalIntentStorageKey(
  requestIdentity: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(requestIdentity),
  );
  const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `opensales:manual-receipt-reversal-intent:${fingerprint}`;
}

function defaultManualReceiptTime(): string {
  const instant = new Date(Date.now() - 60_000);
  const localWallClock = new Date(
    instant.getTime() - instant.getTimezoneOffset() * 60_000,
  );
  return localWallClock.toISOString().slice(0, 16);
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value.trim(),
  );
}

function manualReceiptIsUntouched(receipt: ManualReceiptItem): boolean {
  return (
    receipt.reversal === null &&
    receipt.disposition === "unclaimed" &&
    receipt.allocatedMinor === "0" &&
    !receipt.capacityFrozen &&
    receipt.availableMinor === receipt.grossAmountMinor
  );
}

export function App() {
  const [route, setRoute] = useState<AppRoute>(() => routeFromPath(window.location.pathname));
  const [locale, setLocale] = useState<Locale>("en");
  const [products, setProducts] = useState<Product[]>([]);
  const [legal, setLegal] = useState<Legal | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const meRef = useRef<Me | null>(null);
  meRef.current = me;
  const meRequestGeneration = useRef(0);
  const [sessionResolved, setSessionResolved] = useState(false);
  const [loginChallenge, setLoginChallenge] = useState<{
    id: string;
    token: string;
    methods: string[];
  } | null>(null);
  const [membershipInvitationToken, setMembershipInvitationToken] = useState<string | null>(() => {
    const path = window.location.pathname.replace(/\/+$/, "") || "/";
    if (path !== "/membership-invitations/accept") return null;
    return new URLSearchParams(window.location.search).get("token");
  });
  const invitationAcceptGeneration = useRef(0);
  const invitationAccepting = useRef(false);
  const [invitationAcceptPending, setInvitationAcceptPending] = useState(false);
  const [invitationAcceptError, setInvitationAcceptError] = useState("");
  const [invitationRetryNonce, setInvitationRetryNonce] = useState(0);
  const [acceptedInvitationAccountId, setAcceptedInvitationAccountId] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ product: Product; price: Price } | null>(null);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [notice, setNoticeRaw] = useState<string>("");
  const [error, setErrorRaw] = useState<string>("");
  const activeRouteRef = useRef<AppRoute>(route);
  const routeGenerationRef = useRef(0);
  const [paymentScenario, setPaymentScenario] = useState("success");
  const [paymentMethod, setPaymentMethod] = useState("card");
  const [applyCredit, setApplyCredit] = useState(true);
  const [savePaymentMethod, setSavePaymentMethod] = useState(false);
  const [enableAutomaticRenewal, setEnableAutomaticRenewal] = useState(false);
  const [paymentSettings, setPaymentSettings] = useState<PaymentSettings | null>(null);
  const [paymentSettingsPassword, setPaymentSettingsPassword] = useState("");
  const [paymentSettingsReauthExpiresAt, setPaymentSettingsReauthExpiresAt] = useState<number | null>(
    null,
  );
  const [paymentSettingsPending, setPaymentSettingsPending] = useState(false);
  const paymentSettingsIntentKeys = useRef(new Map<string, string>());
  const [cancellationReason, setCancellationReason] = useState("");
  const [cancellationPending, setCancellationPending] = useState(false);
  const cancellationIntentKeys = useRef(new Map<string, string>());
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [renewals, setRenewals] = useState<RenewalItem[]>([]);
  const [adminRenewals, setAdminRenewals] = useState<AdminRenewalItem[]>([]);
  const [renewalPaymentPendingId, setRenewalPaymentPendingId] = useState<string | null>(null);
  const [automationEffectiveAt, setAutomationEffectiveAt] = useState("");
  const [automationReason, setAutomationReason] = useState("");
  const [renewalHoldReason, setRenewalHoldReason] = useState("");
  const [renewalHoldPendingId, setRenewalHoldPendingId] = useState<string | null>(null);
  const [manualSuspensionReason, setManualSuspensionReason] = useState("");
  const [manualSuspensionPendingId, setManualSuspensionPendingId] = useState<string | null>(null);
  const manualSuspensionIntentKeys = useRef(new Map<string, string>());
  const [paymentQuote, setPaymentQuote] = useState<PaymentQuote | null>(null);
  const [addFundsPrincipalMinor, setAddFundsPrincipalMinor] = useState("5000");
  const [addFundsMethod, setAddFundsMethod] = useState("card");
  const [addFundsScenario, setAddFundsScenario] = useState("success");
  const [addFundsQuote, setAddFundsQuote] = useState<AddFundsQuote | null>(null);
  const [addFundsCommand, setAddFundsCommand] = useState<AddFundsCommand | null>(null);
  const [chargebackStatus, setChargebackStatus] = useState<ChargebackStatus | null>(null);
  const [adminChargebacks, setAdminChargebacks] = useState<AddFundsChargeback[]>([]);
  const [adminUnclaimedChargebacks, setAdminUnclaimedChargebacks] = useState<
    AddFundsUnclaimedChargeback[]
  >([]);
  const [adminChargebackHolds, setAdminChargebackHolds] = useState<
    AddFundsChargebackHold[]
  >([]);
  const [quantity, setQuantity] = useState(1);
  const [mail, setMail] = useState<LabMessage[]>([]);
  const [manualItems, setManualItems] = useState<ManualItem[]>([]);
  const [adminOperationContext, setAdminOperationContext] =
    useState<AdminOperationContext | null>(null);
  const adminOperationContextRef = useRef<AdminOperationContext | null>(null);
  const adminOperationGeneration = useRef(0);
  const adminAccessGeneration = useRef(0);
  const manualReceiptRequestGeneration = useRef(0);
  const [adminCancellations, setAdminCancellations] = useState<AdminCancellationItem[]>([]);
  const [cancellationCompletionReason, setCancellationCompletionReason] = useState("");
  const [cancellationCompletionPendingId, setCancellationCompletionPendingId] = useState<
    string | null
  >(null);
  const cancellationCompletionIntentKeys = useRef(new Map<string, string>());
  const [manualReceiptClientAccountId, setManualReceiptClientAccountId] = useState("");
  const manualReceiptClientAccountIdRef = useRef("");
  manualReceiptClientAccountIdRef.current = manualReceiptClientAccountId;
  const [manualReceiptReference, setManualReceiptReference] = useState("");
  const [manualReceiptReceivedAt, setManualReceiptReceivedAt] = useState(
    defaultManualReceiptTime,
  );
  const [manualReceiptGrossMinor, setManualReceiptGrossMinor] = useState("10000");
  const [manualReceiptFeeMinor, setManualReceiptFeeMinor] = useState("0");
  const [manualReceiptReason, setManualReceiptReason] = useState("");
  const [manualReceiptPending, setManualReceiptPending] = useState(false);
  const [manualReceiptHistory, setManualReceiptHistory] = useState<ManualReceiptItem[]>([]);
  const [manualReceiptTarget, setManualReceiptTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [manualReceiptOutcome, setManualReceiptOutcome] =
    useState<ManualReceiptOutcome | null>(null);
  const manualReceiptIntentKeys = useRef(new Map<string, string>());
  const [manualReceiptReversalTargetId, setManualReceiptReversalTargetId] = useState<
    string | null
  >(null);
  const [manualReceiptReversalReason, setManualReceiptReversalReason] = useState("");
  const [manualReceiptReversalPendingId, setManualReceiptReversalPendingId] = useState<
    string | null
  >(null);
  const [manualReceiptReversalOutcome, setManualReceiptReversalOutcome] =
    useState<ManualReceiptReversalOutcome | null>(null);
  const manualReceiptReversalIntentKeys = useRef(new Map<string, string>());
  const [unclaimedFunds, setUnclaimedFunds] = useState<UnclaimedFundItem[]>([]);
  const [refundCandidates, setRefundCandidates] = useState<RefundCandidate[]>([]);
  const [refundRecords, setRefundRecords] = useState<Record<string, RefundRecord>>({});
  const [refundSecurityHolds, setRefundSecurityHolds] = useState<RefundSecurityHold[]>([]);
  const [refundDismissalCorrections, setRefundDismissalCorrections] = useState<
    RefundDismissalCorrection[]
  >([]);
  const [refundReceiptCapacityIncidents, setRefundReceiptCapacityIncidents] = useState<
    RefundReceiptCapacityIncident[]
  >([]);
  const [refundAmountMode, setRefundAmountMode] = useState<"full" | "partial">("full");
  const [refundAmountMinor, setRefundAmountMinor] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundScenario, setRefundScenario] = useState<
    "success" | "failed" | "timeout_success" | "duplicate_out_of_order"
  >("success");
  const refundIntentKeys = useRef(new Map<string, string>());
  const refundInFlight = useRef(new Set<string>());
  const refundAdjudicationInFlight = useRef(new Set<string>());
  const refundManualActionInFlight = useRef(new Set<string>());
  const refundCorrectionInFlight = useRef(new Set<string>());
  const refundCapacityAcknowledgementInFlight = useRef(new Set<string>());
  const refundPollInFlight = useRef(new Map<string, number>());
  const refundPollRequestSequence = useRef(0);
  const [refundAdjudicationPendingIds, setRefundAdjudicationPendingIds] = useState<
    ReadonlySet<string>
  >(new Set());
  const [refundManualActionPendingIds, setRefundManualActionPendingIds] = useState<
    ReadonlySet<string>
  >(new Set());
  const [refundCorrectionPendingIds, setRefundCorrectionPendingIds] = useState<
    ReadonlySet<string>
  >(new Set());
  const [refundCapacityAcknowledgementPendingIds, setRefundCapacityAcknowledgementPendingIds] =
    useState<ReadonlySet<string>>(new Set());
  const [refundPendingReceiptIds, setRefundPendingReceiptIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [adminPassword, setAdminPassword] = useState("");
  const [manualReason, setManualReason] = useState("");
  const [creditAdjustmentMinor, setCreditAdjustmentMinor] = useState("5000");
  const [creditAdjustmentReason, setCreditAdjustmentReason] = useState("");
  const [fundResolutionMinor, setFundResolutionMinor] = useState("");
  const [fundResolutionInvoiceId, setFundResolutionInvoiceId] = useState("");
  const [fundResolutionReason, setFundResolutionReason] = useState("");
  const [fundReturnAmountMode, setFundReturnAmountMode] = useState<"full" | "partial">("full");
  const [fundReturnAmountMinor, setFundReturnAmountMinor] = useState("");
  const [fundReturnReason, setFundReturnReason] = useState("");
  const [fundReturnScenario, setFundReturnScenario] = useState<
    "success" | "failed" | "timeout_success" | "duplicate_out_of_order"
  >("success");
  const fundResolutionInFlight = useRef(new Set<string>());
  const [fundResolutionPendingReceiptIds, setFundResolutionPendingReceiptIds] = useState<
    ReadonlySet<string>
  >(new Set());
  const renderRoute = route;
  const renderRouteGeneration = routeGenerationRef.current;
  const setNotice = useCallback((message: string) => {
    if (
      activeRouteRef.current === renderRoute &&
      routeGenerationRef.current === renderRouteGeneration
    ) {
      setNoticeRaw(message);
    }
  }, [renderRoute, renderRouteGeneration]);
  const setError = useCallback((message: string) => {
    if (
      activeRouteRef.current === renderRoute &&
      routeGenerationRef.current === renderRouteGeneration
    ) {
      setErrorRaw(message);
    }
  }, [renderRoute, renderRouteGeneration]);
  const staffPermissions = useMemo(
    () => parseStaffPermissions(me?.staff?.permissions),
    [me?.staff?.permissions],
  );
  const staffPermissionFingerprint = [...staffPermissions].sort().join("\u0000");
  const staffMembershipActive = me?.staff !== null && me?.staff !== undefined;
  const staffIdentityEligible =
    me?.verification.email === "passed" && me.restrictions.user === false;
  const staffPrincipalFingerprint = [
    me?.id ?? "",
    staffIdentityEligible ? "eligible" : "ineligible",
    staffMembershipActive ? "active" : "inactive",
  ].join("\u0001");
  const staffAccessFingerprint = [
    staffPrincipalFingerprint,
    staffPermissionFingerprint,
  ].join("\u0002");
  const staffAccessFingerprintRef = useRef(staffAccessFingerprint);
  staffAccessFingerprintRef.current = staffAccessFingerprint;
  const previousStaffAccessFingerprint = useRef(staffAccessFingerprint);
  const previousStaffPrincipalFingerprint = useRef(staffPrincipalFingerprint);
  const canReadCustomerAccount =
    me?.verification.email === "passed" &&
    me.restrictions.user === false &&
    me.clientAccountId !== null &&
    me.clientAccountId !== undefined;
  // A Client Account restriction blocks commerce and money mutations, but it
  // must never cut off the verified User's support lifeline.
  const accountCapabilities = new Set(me?.context?.capabilities ?? []);
  const accountPermissionGranted = (permission: string) => accountCapabilities.has(permission);
  const canReadCustomerHistory = canReadCustomerAccount;
  const canReadCustomerNotificationHistory =
    canReadCustomerAccount && accountPermissionGranted("account.history.read");
  const canUseCustomerSupport = canReadCustomerAccount;
  const canWriteCustomerSupport =
    canUseCustomerSupport && accountPermissionGranted("support.tickets.write");
  const canCreateOrders =
    me?.eligible === true && accountPermissionGranted("orders.create");
  const canWriteBilling =
    me?.eligible === true && accountPermissionGranted("billing.write");
  const canManageServices =
    me?.eligible === true && accountPermissionGranted("services.manage");
  const eligibleStaff = staffIdentityEligible && staffMembershipActive;
  const canManageStaffTickets =
    eligibleStaff &&
    (staffPermissions.has("*") || staffPermissions.has("support.tickets.manage"));
  const canManageManualReceipts =
    eligibleStaff &&
    (staffPermissions.has("*") || staffPermissions.has("billing.manual_receipt_manage"));
  const canManageUnclaimedFunds =
    eligibleStaff &&
    (staffPermissions.has("*") || staffPermissions.has("billing.unclaimed_manage"));
  const canManageRefunds =
    eligibleStaff &&
    (staffPermissions.has("*") || staffPermissions.has("billing.refund_manage"));
  const canManageManualFulfillment =
    eligibleStaff &&
    (staffPermissions.has("*") || staffPermissions.has("services.manual_fulfillment"));
  const canUseFullAdminWorkspace = eligibleStaff && staffPermissions.has("*");
  const canViewAccount360 =
    eligibleStaff &&
    (staffPermissions.has("*") || staffPermissions.has("accounts.view"));
  const canManageServiceOperations =
    eligibleStaff &&
    (staffPermissions.has("*") || staffPermissions.has("services.operations_manage"));
  const canOpenAdminWorkspace =
    canManageStaffTickets ||
    canManageManualReceipts ||
    canManageRefunds ||
    canManageManualFulfillment ||
    canManageServiceOperations ||
    canViewAccount360 ||
    canUseFullAdminWorkspace;
  const canUseFullAdminRoute = route === "/admin" && canUseFullAdminWorkspace;
  const canManageManualReceiptsRoute = route === "/admin" && canManageManualReceipts;
  const canManageRefundsRoute = route === "/admin" && canManageRefunds;
  const canManageManualFulfillmentRoute = route === "/admin" && canManageManualFulfillment;
  const canMountAdminOperationWorkspace =
    canUseFullAdminWorkspace ||
    canManageManualReceipts ||
    canManageRefunds ||
    canManageManualFulfillment;
  const account360Actions = useMemo<ReadonlySet<AdminAccountAction>>(() => {
    const actions = new Set<AdminAccountAction>();
    if (canManageManualReceipts) actions.add("manual_receipt");
    if (canManageRefunds) actions.add("refund");
    if (canManageManualFulfillment) actions.add("manual_fulfillment");
    if (canManageStaffTickets) actions.add("ticket");
    return actions;
  }, [
    canManageManualFulfillment,
    canManageManualReceipts,
    canManageRefunds,
    canManageStaffTickets,
  ]);
  const manualReceiptContextFingerprint = [
    route,
    staffAccessFingerprint,
    canManageManualReceipts ? "manual-receipt" : "no-manual-receipt",
    canManageUnclaimedFunds ? "reversal" : "no-reversal",
    adminOperationContext?.action ?? "unscoped",
    adminOperationContext?.account.id ?? "unscoped",
  ].join("\u0003");
  const previousManualReceiptContextFingerprint = useRef(
    manualReceiptContextFingerprint,
  );

  const clearWorkspaceTransientState = useCallback(() => {
    const location = new URL(window.location.href);
    const hadCustomerDetail = location.searchParams.has("invoice") || location.searchParams.has("service");
    location.searchParams.delete("invoice");
    location.searchParams.delete("service");
    if (hadCustomerDetail) {
      window.history.replaceState({}, "", `${location.pathname}${location.search}${location.hash}`);
    }
    setNoticeRaw("");
    setErrorRaw("");
    setLoginChallenge(null);
    setSelected(null);
    setOrder(null);
    setBilling(null);
    setPaymentSettings(null);
    setPaymentSettingsPassword("");
    setPaymentSettingsReauthExpiresAt(null);
    setPaymentSettingsPending(false);
    setCancellationReason("");
    setCancellationPending(false);
    setRenewals([]);
    setAdminRenewals([]);
    setRenewalPaymentPendingId(null);
    setAutomationEffectiveAt("");
    setAutomationReason("");
    setRenewalHoldReason("");
    setRenewalHoldPendingId(null);
    setManualSuspensionReason("");
    setManualSuspensionPendingId(null);
    setPaymentQuote(null);
    setAddFundsPrincipalMinor("5000");
    setAddFundsMethod("card");
    setAddFundsScenario("success");
    setAddFundsQuote(null);
    setAddFundsCommand(null);
    setChargebackStatus(null);
    setAdminChargebacks([]);
    setAdminUnclaimedChargebacks([]);
    setAdminChargebackHolds([]);
    setQuantity(1);
    setMail([]);
    setManualItems([]);
    adminOperationContextRef.current = null;
    setAdminOperationContext(null);
    adminOperationGeneration.current += 1;
    manualReceiptRequestGeneration.current += 1;
    setAdminCancellations([]);
    setCancellationCompletionReason("");
    setCancellationCompletionPendingId(null);
    manualReceiptClientAccountIdRef.current = "";
    setManualReceiptClientAccountId("");
    setManualReceiptReference("");
    setManualReceiptReceivedAt(defaultManualReceiptTime());
    setManualReceiptGrossMinor("10000");
    setManualReceiptFeeMinor("0");
    setManualReceiptReason("");
    setManualReceiptPending(false);
    setManualReceiptHistory([]);
    setManualReceiptTarget(null);
    setManualReceiptOutcome(null);
    setManualReceiptReversalTargetId(null);
    setManualReceiptReversalReason("");
    setManualReceiptReversalPendingId(null);
    setManualReceiptReversalOutcome(null);
    setUnclaimedFunds([]);
    setRefundCandidates([]);
    setRefundRecords({});
    setRefundSecurityHolds([]);
    setRefundDismissalCorrections([]);
    setRefundReceiptCapacityIncidents([]);
    setRefundAmountMode("full");
    setRefundAmountMinor("");
    setRefundReason("");
    setRefundScenario("success");
    setRefundAdjudicationPendingIds(new Set());
    setRefundManualActionPendingIds(new Set());
    setRefundCorrectionPendingIds(new Set());
    setRefundCapacityAcknowledgementPendingIds(new Set());
    setRefundPendingReceiptIds(new Set());
    setAdminPassword("");
    setManualReason("");
    setCreditAdjustmentMinor("5000");
    setCreditAdjustmentReason("");
    setFundResolutionMinor("");
    setFundResolutionInvoiceId("");
    setFundResolutionReason("");
    setFundReturnAmountMode("full");
    setFundReturnAmountMinor("");
    setFundReturnReason("");
    setFundReturnScenario("success");
    setFundResolutionPendingReceiptIds(new Set());
    paymentSettingsIntentKeys.current.clear();
    cancellationIntentKeys.current.clear();
    manualSuspensionIntentKeys.current.clear();
    cancellationCompletionIntentKeys.current.clear();
    manualReceiptIntentKeys.current.clear();
    manualReceiptReversalIntentKeys.current.clear();
    refundIntentKeys.current.clear();
    refundInFlight.current.clear();
    refundAdjudicationInFlight.current.clear();
    refundManualActionInFlight.current.clear();
    refundCorrectionInFlight.current.clear();
    refundCapacityAcknowledgementInFlight.current.clear();
    fundResolutionInFlight.current.clear();
    refundPollInFlight.current.clear();
  }, []);

  const openRoute = useCallback((target: AppRoute, replace = false) => {
    const routeChanged = activeRouteRef.current !== target;
    routeGenerationRef.current += 1;
    activeRouteRef.current = target;
    clearWorkspaceTransientState();
    if (target !== "/" && routeChanged) setSessionResolved(false);
    if (replace) {
      window.history.replaceState({}, "", target);
    } else if (window.location.pathname !== target || window.location.search.length > 0) {
      window.history.pushState({}, "", target);
    }
    setRoute(target);
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [clearWorkspaceTransientState]);
  const followRouteLink = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>, target: AppRoute) => {
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      openRoute(target);
    },
    [openRoute],
  );
  const showTicketNotice = useCallback((message: string) => {
    setError("");
    setNotice(message);
  }, [setError, setNotice]);
  const showTicketError = useCallback((message: string) => {
    setNotice("");
    setError(message);
  }, [setError, setNotice]);
  const text = words[locale];
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const manualReceiptAmountsValid =
    /^[1-9]\d*$/.test(manualReceiptGrossMinor) &&
    /^(0|[1-9]\d*)$/.test(manualReceiptFeeMinor) &&
    BigInt(manualReceiptFeeMinor) <= BigInt(manualReceiptGrossMinor);
  const manualReceiptNetMinor = manualReceiptAmountsValid
    ? (BigInt(manualReceiptGrossMinor) - BigInt(manualReceiptFeeMinor)).toString()
    : null;
  const manualReceiptFormReady =
    looksLikeUuid(manualReceiptClientAccountId) &&
    manualReceiptTarget?.id === manualReceiptClientAccountId.trim().toLowerCase() &&
    manualReceiptReference.trim().length > 0 &&
    manualReceiptReference.trim().length <= 200 &&
    manualReceiptReceivedAt.length > 0 &&
    manualReceiptAmountsValid &&
    manualReceiptReason.trim().length >= 10 &&
    manualReceiptReason.trim().length <= 1_000 &&
    adminPassword.length > 0;
  const paymentSettingsReauthActive =
    paymentSettingsReauthExpiresAt !== null && paymentSettingsReauthExpiresAt > Date.now();
  const paymentSettingsReauthReady =
    paymentSettingsReauthActive || paymentSettingsPassword.length > 0;
  const operationAccount = adminOperationContext?.account ?? null;
  const showUnscopedAdminOperations =
    operationAccount === null && (canUseFullAdminWorkspace || !canViewAccount360);
  const visibleManualItems = operationAccount
    ? manualItems.filter((item) => item.clientAccountId === operationAccount.id)
    : showUnscopedAdminOperations
      ? manualItems
      : [];
  const visibleRefundCandidates = operationAccount
    ? refundCandidates.filter((item) => item.clientAccountId === operationAccount.id)
    : showUnscopedAdminOperations
      ? refundCandidates
      : [];
  const visibleRefundSecurityHolds = operationAccount
    ? refundSecurityHolds.filter((item) => item.clientAccountId === operationAccount.id)
    : showUnscopedAdminOperations
      ? refundSecurityHolds
      : [];
  const visibleRefundDismissalCorrections = operationAccount
    ? refundDismissalCorrections.filter((item) => item.clientAccountId === operationAccount.id)
    : showUnscopedAdminOperations
      ? refundDismissalCorrections
      : [];
  const visibleRefundReceiptCapacityIncidents = operationAccount
    ? refundReceiptCapacityIncidents.filter(
        (item) => item.clientAccountId === operationAccount.id,
      )
    : showUnscopedAdminOperations
      ? refundReceiptCapacityIncidents
      : [];
  const visibleRefundRecords = Object.values(refundRecords).filter(
    (refund) =>
      showUnscopedAdminOperations ||
      (operationAccount !== null &&
        refund.clientAccountId === operationAccount.id),
  );
  const captureAdminOperationScope = useCallback((): AdminOperationScope => ({
    operationGeneration: adminOperationGeneration.current,
    accessGeneration: adminAccessGeneration.current,
    accountId: adminOperationContextRef.current?.account.id ?? null,
    accessFingerprint: staffAccessFingerprintRef.current,
  }), []);
  const adminOperationRequestIsCurrent = useCallback(
    (scope: AdminOperationScope, clientAccountId?: string) => {
      if (
        scope.operationGeneration !== adminOperationGeneration.current ||
        scope.accessGeneration !== adminAccessGeneration.current ||
        scope.accessFingerprint !== staffAccessFingerprintRef.current ||
        activeRouteRef.current !== "/admin" ||
        (adminOperationContextRef.current?.account.id ?? null) !== scope.accountId
      ) {
        return false;
      }
      return clientAccountId === undefined ||
        scope.accountId === null ||
        scope.accountId === clientAccountId;
    },
    [],
  );
  const currentManualReceiptScopeToken = useCallback((clientAccountId: string) => {
    const context = adminOperationContextRef.current;
    return [
      activeRouteRef.current,
      routeGenerationRef.current.toString(),
      staffAccessFingerprintRef.current,
      adminOperationGeneration.current.toString(),
      context?.action ?? "unscoped",
      context?.account.id ?? "unscoped",
      manualReceiptRequestGeneration.current.toString(),
      clientAccountId,
    ].join("\u0004");
  }, []);
  const manualReceiptScopeIsCurrent = useCallback(
    (scopeToken: string, clientAccountId: string) => {
      if (
        activeRouteRef.current !== "/admin" ||
        manualReceiptClientAccountIdRef.current.trim().toLowerCase() !== clientAccountId
      ) return false;
      const context = adminOperationContextRef.current;
      if (context && context.account.id !== clientAccountId) return false;
      return scopeToken === currentManualReceiptScopeToken(clientAccountId);
    },
    [currentManualReceiptScopeToken],
  );

  useEffect(() => {
    const onPopState = () => {
      const target = routeFromPath(window.location.pathname);
      const routeChanged = activeRouteRef.current !== target;
      routeGenerationRef.current += 1;
      activeRouteRef.current = target;
      clearWorkspaceTransientState();
      if (target !== "/" && routeChanged) setSessionResolved(false);
      setRoute(target);
      window.scrollTo({ top: 0, behavior: "auto" });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [clearWorkspaceTransientState]);

  const refreshMe = useCallback(async (): Promise<Me | null> => {
    const generation = ++meRequestGeneration.current;
    try {
      const viewer = await api<Me>("/api/v1/auth/me");
      const capturedContext = getAccountContextSnapshot();
      if (
        generation !== meRequestGeneration.current ||
        (capturedContext.version !== null &&
          (viewer.accountContextVersion !== capturedContext.version ||
            viewer.clientAccountId !== capturedContext.clientAccountId))
      ) {
        return meRef.current;
      }
      setMe(viewer);
      setSessionResolved(true);
      return viewer;
    } catch (caught) {
      if (generation !== meRequestGeneration.current) return meRef.current;
      if (caught instanceof ObsoleteSessionResponseError) return meRef.current;
      setMe(null);
      setPaymentSettingsReauthExpiresAt(null);
      setPaymentSettingsPassword("");
      setSessionResolved(true);
      return null;
    }
  }, []);

  useEffect(() => subscribeAccountContextInvalidation(() => {
    meRequestGeneration.current += 1;
    invitationAcceptGeneration.current += 1;
    invitationAccepting.current = false;
    setInvitationAcceptPending(false);
    routeGenerationRef.current += 1;
    clearWorkspaceTransientState();
    setMe(null);
    // Public Home is deliberately session-neutral. It must discard stale
    // workspace state, but a background identity read there is redundant.
    if (activeRouteRef.current === "/") {
      setSessionResolved(true);
    } else {
      setSessionResolved(false);
      void refreshMe();
    }
  }), [clearWorkspaceTransientState, refreshMe]);

  const accountContextSwitched = useCallback(async () => {
    meRequestGeneration.current += 1;
    invitationAcceptGeneration.current += 1;
    routeGenerationRef.current += 1;
    clearWorkspaceTransientState();
    setMe(null);
    setSessionResolved(false);
    const viewer = await refreshMe();
    if (viewer) {
      setNoticeRaw(
        locale === "zh-CN"
          ? `当前客户账户：${viewer.context?.name ?? "未选择"}。`
          : `Active Client Account: ${viewer.context?.name ?? "not selected"}.`,
      );
    }
  }, [clearWorkspaceTransientState, locale, refreshMe]);

  const refreshLatestOrder = useCallback(async () => {
    if (route !== "/customer" || activeRouteRef.current !== "/customer" || !canReadCustomerHistory) {
      setOrder(null);
      return;
    }
    const result = await api<{ items: OrderSummary[] }>("/api/v1/orders");
    const latest = result.items[0];
    if (!latest) {
      setOrder(null);
      return;
    }
    setOrder(await api<OrderDetail>(`/api/v1/orders/${latest.orderId}`));
  }, [canReadCustomerHistory, me?.clientAccountId, route]);

  const refreshBilling = useCallback(async () => {
    if (route !== "/customer" || activeRouteRef.current !== "/customer" || !canReadCustomerHistory) {
      setBilling(null);
      return;
    }
    setBilling(await api<BillingSummary>("/api/v1/billing/summary"));
  }, [canReadCustomerHistory, me?.clientAccountId, route]);

  const refreshPaymentSettings = useCallback(async () => {
    if (
      route !== "/customer" ||
      activeRouteRef.current !== "/customer" ||
      !canReadCustomerHistory
    ) {
      setPaymentSettings(null);
      return;
    }
    setPaymentSettings(
      await api<PaymentSettings>("/api/v1/billing/payment-settings"),
    );
  }, [canReadCustomerHistory, me?.clientAccountId, route]);

  const refreshRenewals = useCallback(async (): Promise<RenewalItem[]> => {
    if (route !== "/customer" || activeRouteRef.current !== "/customer" || !canReadCustomerHistory) {
      setRenewals([]);
      return [];
    }
    const result = await api<{ items: RenewalItem[] }>("/api/v1/billing/renewals");
    setRenewals(result.items);
    return result.items;
  }, [canReadCustomerHistory, me?.clientAccountId, route]);

  const refreshAdminRenewals = useCallback(async (
    expectedScope?: AdminOperationScope,
  ): Promise<AdminRenewalItem[]> => {
    const scope = expectedScope ?? captureAdminOperationScope();
    if (
      route !== "/admin" ||
      activeRouteRef.current !== "/admin" ||
      !canUseFullAdminWorkspace
    ) {
      if (adminOperationRequestIsCurrent(scope)) setAdminRenewals([]);
      return [];
    }
    if (!adminOperationRequestIsCurrent(scope)) return [];
    const result = await api<{ items: AdminRenewalItem[] }>(
      "/api/v1/admin/billing/renewals",
    );
    if (!adminOperationRequestIsCurrent(scope)) return [];
    setAdminRenewals(result.items);
    return result.items;
  }, [
    adminOperationRequestIsCurrent,
    canUseFullAdminWorkspace,
    captureAdminOperationScope,
    route,
    staffAccessFingerprint,
  ]);

  const refreshChargebackStatus = useCallback(async () => {
    if (route !== "/customer" || activeRouteRef.current !== "/customer" || !canReadCustomerHistory) {
      setChargebackStatus(null);
      return;
    }
    setChargebackStatus(
      await api<ChargebackStatus>("/api/v1/billing/chargeback-status"),
    );
  }, [canReadCustomerHistory, me?.clientAccountId, route]);

  useEffect(() => {
    void Promise.all([
      api<{ products: Product[] }>(`/api/v1/catalog?locale=${locale}`).then((data) =>
        setProducts(data.products),
      ),
      api<Legal>(`/api/v1/legal/current?locale=${locale}`).then(setLegal),
    ]).catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : "Unable to load the laboratory"),
    );
  }, [locale, setError]);

  useEffect(() => {
    if (route === "/") return;
    setSessionResolved(false);
    void refreshMe();
  }, [refreshMe, route]);

  useLayoutEffect(() => {
    if (
      previousManualReceiptContextFingerprint.current ===
      manualReceiptContextFingerprint
    ) return;
    previousManualReceiptContextFingerprint.current = manualReceiptContextFingerprint;
    manualReceiptRequestGeneration.current += 1;
    const context = adminOperationContextRef.current;
    const scopedAccountId =
      route === "/admin" &&
      canManageManualReceipts &&
      context?.action === "manual_receipt"
        ? context.account.id
        : "";
    manualReceiptClientAccountIdRef.current = scopedAccountId;
    setManualReceiptClientAccountId(scopedAccountId);
    setManualReceiptReference("");
    setManualReceiptReceivedAt(defaultManualReceiptTime());
    setManualReceiptGrossMinor("10000");
    setManualReceiptFeeMinor("0");
    setManualReceiptReason("");
    setManualReceiptPending(false);
    setManualReceiptHistory([]);
    setManualReceiptTarget(null);
    setManualReceiptOutcome(null);
    setManualReceiptReversalTargetId(null);
    setManualReceiptReversalReason("");
    setManualReceiptReversalPendingId(null);
    setManualReceiptReversalOutcome(null);
    setAdminPassword("");
  }, [manualReceiptContextFingerprint]);

  useLayoutEffect(() => {
    adminAccessGeneration.current += 1;
    const accessChanged =
      previousStaffAccessFingerprint.current !== staffAccessFingerprint;
    const principalChanged =
      previousStaffPrincipalFingerprint.current !== staffPrincipalFingerprint;
    previousStaffAccessFingerprint.current = staffAccessFingerprint;
    previousStaffPrincipalFingerprint.current = staffPrincipalFingerprint;
    if (!accessChanged && !principalChanged) return;

    adminOperationGeneration.current += 1;
    manualReceiptRequestGeneration.current += 1;
    adminOperationContextRef.current = null;
    setAdminOperationContext(null);
    setNoticeRaw("");
    setErrorRaw("");
    setManualItems([]);
    setAdminRenewals([]);
    setAdminCancellations([]);
    setAdminChargebacks([]);
    setAdminUnclaimedChargebacks([]);
    setAdminChargebackHolds([]);
    setUnclaimedFunds([]);
    setRefundCandidates([]);
    setRefundRecords({});
    setRefundSecurityHolds([]);
    setRefundDismissalCorrections([]);
    setRefundReceiptCapacityIncidents([]);
    setRenewalHoldPendingId(null);
    setManualSuspensionPendingId(null);
    setCancellationCompletionPendingId(null);
    setAdminPassword("");
    setManualReason("");
    setAutomationEffectiveAt("");
    setAutomationReason("");
    setRenewalHoldReason("");
    setManualSuspensionReason("");
    setCancellationCompletionReason("");
    setCreditAdjustmentMinor("5000");
    setCreditAdjustmentReason("");
    manualReceiptClientAccountIdRef.current = "";
    setManualReceiptClientAccountId("");
    setManualReceiptReference("");
    setManualReceiptReceivedAt(defaultManualReceiptTime());
    setManualReceiptGrossMinor("10000");
    setManualReceiptFeeMinor("0");
    setManualReceiptReason("");
    setManualReceiptPending(false);
    setManualReceiptHistory([]);
    setManualReceiptTarget(null);
    setManualReceiptOutcome(null);
    setManualReceiptReversalTargetId(null);
    setManualReceiptReversalReason("");
    setManualReceiptReversalPendingId(null);
    setManualReceiptReversalOutcome(null);
    setRefundAmountMode("full");
    setRefundAmountMinor("");
    setRefundReason("");
    setRefundScenario("success");
    setRefundPendingReceiptIds(new Set());
    setRefundAdjudicationPendingIds(new Set());
    setRefundManualActionPendingIds(new Set());
    setRefundCorrectionPendingIds(new Set());
    setRefundCapacityAcknowledgementPendingIds(new Set());
    setFundResolutionMinor("");
    setFundResolutionInvoiceId("");
    setFundResolutionReason("");
    setFundReturnAmountMode("full");
    setFundReturnAmountMinor("");
    setFundReturnReason("");
    setFundReturnScenario("success");
    setFundResolutionPendingReceiptIds(new Set());
    refundInFlight.current.clear();
    refundAdjudicationInFlight.current.clear();
    refundManualActionInFlight.current.clear();
    refundCorrectionInFlight.current.clear();
    refundCapacityAcknowledgementInFlight.current.clear();
    fundResolutionInFlight.current.clear();
    refundPollInFlight.current.clear();
  }, [route, staffAccessFingerprint, staffPrincipalFingerprint]);

  useLayoutEffect(() => {
    const context = adminOperationContext;
    if (!context) return;
    const stillAuthorized =
      route === "/admin" &&
      activeRouteRef.current === "/admin" &&
      ((context.action === "manual_receipt" && canManageManualReceipts) ||
        (context.action === "refund" && canManageRefunds) ||
        (context.action === "ticket" && canManageStaffTickets) ||
        (context.action === "manual_fulfillment" && canManageManualFulfillment));
    if (stillAuthorized) return;
    adminOperationGeneration.current += 1;
    manualReceiptRequestGeneration.current += 1;
    adminOperationContextRef.current = null;
    setAdminOperationContext(null);
    setAdminPassword("");
    setManualReason("");
    setManualReceiptClientAccountId("");
    setManualReceiptReference("");
    setManualReceiptReceivedAt(defaultManualReceiptTime());
    setManualReceiptGrossMinor("10000");
    setManualReceiptFeeMinor("0");
    setManualReceiptReason("");
    setManualReceiptPending(false);
    setManualReceiptHistory([]);
    setManualReceiptTarget(null);
    setManualReceiptOutcome(null);
    setManualReceiptReversalTargetId(null);
    setManualReceiptReversalReason("");
    setManualReceiptReversalPendingId(null);
    setManualReceiptReversalOutcome(null);
    setRefundAmountMode("full");
    setRefundAmountMinor("");
    setRefundReason("");
    setRefundPendingReceiptIds(new Set());
    setRefundAdjudicationPendingIds(new Set());
    setRefundManualActionPendingIds(new Set());
    setRefundCorrectionPendingIds(new Set());
    setRefundCapacityAcknowledgementPendingIds(new Set());
  }, [
    adminOperationContext,
    canManageManualFulfillment,
    canManageManualReceipts,
    canManageRefunds,
    canManageStaffTickets,
    route,
  ]);

  useLayoutEffect(() => {
    if (!canManageManualReceipts) {
      manualReceiptRequestGeneration.current += 1;
      setManualReceiptClientAccountId("");
      setManualReceiptReference("");
      setManualReceiptReason("");
      setManualReceiptPending(false);
      setManualReceiptHistory([]);
      setManualReceiptTarget(null);
      setManualReceiptOutcome(null);
      setManualReceiptReversalTargetId(null);
      setManualReceiptReversalReason("");
      setManualReceiptReversalPendingId(null);
      setManualReceiptReversalOutcome(null);
    }
    if (!canManageRefunds) {
      setRefundAmountMode("full");
      setRefundAmountMinor("");
      setRefundReason("");
      setRefundPendingReceiptIds(new Set());
      setRefundAdjudicationPendingIds(new Set());
      setRefundManualActionPendingIds(new Set());
      setRefundCorrectionPendingIds(new Set());
      setRefundCapacityAcknowledgementPendingIds(new Set());
    }
    if (!canManageManualFulfillment) setManualReason("");
    if (!canMountAdminOperationWorkspace) setAdminPassword("");
  }, [
    canManageManualFulfillment,
    canManageManualReceipts,
    canManageRefunds,
    canMountAdminOperationWorkspace,
  ]);

  useEffect(() => {
    void refreshLatestOrder().catch(() => undefined);
  }, [refreshLatestOrder]);

  useEffect(() => {
    void refreshBilling().catch(() => undefined);
  }, [refreshBilling]);

  useEffect(() => {
    void refreshPaymentSettings().catch(() => undefined);
  }, [refreshPaymentSettings]);

  useEffect(() => {
    const selectedMethod = billing?.paymentMethods.find(
      (method) => method.code === paymentMethod,
    );
    if (!selectedMethod?.savedMethodEnabled) {
      setSavePaymentMethod(false);
      setEnableAutomaticRenewal(false);
    } else if (!selectedMethod.automaticRenewalEnabled || !savePaymentMethod) {
      setEnableAutomaticRenewal(false);
    }
  }, [billing?.paymentMethods, paymentMethod, savePaymentMethod]);

  useEffect(() => {
    void refreshRenewals().catch(() => undefined);
  }, [refreshRenewals]);

  useEffect(() => {
    void refreshAdminRenewals().catch(() => undefined);
  }, [refreshAdminRenewals]);

  useEffect(() => {
    void refreshChargebackStatus().catch(() => undefined);
  }, [refreshChargebackStatus]);

  useEffect(() => {
    const allowedMethods =
      billing?.paymentMethods.filter((method) => method.addFundsEnabled) ?? [];
    if (
      allowedMethods.length > 0 &&
      !allowedMethods.some((method) => method.code === addFundsMethod)
    ) {
      setAddFundsMethod(allowedMethods[0]!.code);
    }
  }, [addFundsMethod, billing?.paymentMethods]);

  useEffect(() => {
    if (
      route !== "/customer" ||
      !canWriteBilling ||
      !billing?.addFunds.enabled ||
      !billing.addFunds.allowed ||
      !/^[1-9]\d*$/.test(addFundsPrincipalMinor)
    ) {
      setAddFundsQuote(null);
      return;
    }
    const principal = BigInt(addFundsPrincipalMinor);
    if (
      principal < BigInt(billing.addFunds.minimumMinor) ||
      principal > BigInt(billing.addFunds.maximumMinor)
    ) {
      setAddFundsQuote(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void api<AddFundsQuote>("/api/v1/billing/add-funds/quotes", {
        method: "POST",
        body: JSON.stringify({
          principalMinor: addFundsPrincipalMinor,
          paymentMethod: addFundsMethod,
        }),
      })
        .then(setAddFundsQuote)
        .catch((caught: unknown) => {
          setAddFundsQuote(null);
          setError(caught instanceof Error ? caught.message : "Add Funds quote is unavailable");
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [
    addFundsMethod,
    addFundsPrincipalMinor,
    billing?.addFunds.allowed,
    billing?.addFunds.enabled,
    billing?.addFunds.maximumMinor,
    billing?.addFunds.minimumMinor,
    billing?.creditBalanceMinor,
    canWriteBilling,
    route,
  ]);

  useEffect(() => {
    if (
      route !== "/customer" ||
      !addFundsCommand ||
      ["succeeded", "failed", "cancelled", "expired", "manual"].includes(
        addFundsCommand.status,
      )
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void api<AddFundsCommand>(
        `/api/v1/billing/add-funds/${addFundsCommand.commandId}`,
      )
        .then(async (command) => {
          setAddFundsCommand(command);
          if (
            ["succeeded", "failed", "cancelled", "expired", "manual"].includes(
              command.status,
            )
          ) {
            await refreshBilling();
          }
        })
        .catch(() => undefined);
    }, 750);
    return () => window.clearInterval(timer);
  }, [addFundsCommand, refreshBilling, route]);

  useEffect(() => {
    if (route !== "/customer" || !order || order.invoice.status === "paid" || !canWriteBilling) {
      setPaymentQuote(null);
      return;
    }
    void api<PaymentQuote>(`/api/v1/invoices/${order.invoice.id}/payment-quotes`, {
      method: "POST",
      body: JSON.stringify({ paymentMethod, applyCredit }),
    })
      .then(setPaymentQuote)
      .catch((caught: unknown) => {
        setPaymentQuote(null);
        setError(caught instanceof Error ? caught.message : "Payment quote is unavailable");
      });
  }, [applyCredit, billing?.creditBalanceMinor, canWriteBilling, order?.invoice.id, order?.invoice.status, paymentMethod, route]);

  useEffect(() => {
    const path = window.location.pathname.replace(/\/+$/, "") || "/";
    if (path !== "/verify") return;
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) return;
    void api<{ status: string }>("/api/v1/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ token }),
    })
      .then(async (result) => {
        const visibleStatus = result.status === "already_verified" ? "verified" : result.status;
        await refreshMe();
        openRoute("/customer", true);
        setNoticeRaw(`Email verification: ${visibleStatus}`);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : "Verification failed"),
      );
  }, [openRoute, refreshMe, setError]);

  useEffect(() => {
    if (
      !membershipInvitationToken ||
      !sessionResolved ||
      !me ||
      me.verification.email !== "passed" ||
      me.restrictions.user ||
      invitationAccepting.current ||
      (window.location.pathname.replace(/\/+$/, "") || "/") !==
        "/membership-invitations/accept"
    ) return;
    const token = membershipInvitationToken;
    const generation = ++invitationAcceptGeneration.current;
    invitationAccepting.current = true;
    setInvitationAcceptPending(true);
    setInvitationAcceptError("");
    const acceptOrResume = acceptedInvitationAccountId === null
      ? api<{ membership: { clientAccountId: string } }>(
          "/api/v1/membership-invitations/accept",
          { method: "POST", body: JSON.stringify({ token }) },
        ).then((result) => {
          if (generation !== invitationAcceptGeneration.current) return null;
          setAcceptedInvitationAccountId(result.membership.clientAccountId);
          return result.membership.clientAccountId;
        })
      : Promise.resolve(acceptedInvitationAccountId);
    void acceptOrResume
      .then(async (clientAccountId) => {
        if (!clientAccountId || generation !== invitationAcceptGeneration.current) return;
        await api("/api/v1/auth/account-context", {
          method: "PUT",
          body: JSON.stringify({ clientAccountId }),
        });
        if (generation !== invitationAcceptGeneration.current) return;
        setMembershipInvitationToken(null);
        setAcceptedInvitationAccountId(null);
        setInvitationAcceptPending(false);
        setInvitationAcceptError("");
        window.history.replaceState({}, "", "/customer");
        activeRouteRef.current = "/customer";
        routeGenerationRef.current += 1;
        meRequestGeneration.current += 1;
        clearWorkspaceTransientState();
        setMe(null);
        setSessionResolved(false);
        await refreshMe();
        if (generation !== invitationAcceptGeneration.current) return;
        setNoticeRaw(
          locale === "zh-CN"
            ? "成员邀请已接受，并已切换到受邀客户账户。"
            : "Membership invitation accepted and the invited Client Account is now active.",
        );
      })
      .catch((caught: unknown) => {
        if (generation !== invitationAcceptGeneration.current) return;
        setInvitationAcceptPending(false);
        setInvitationAcceptError(
          caught instanceof Error ? caught.message : "Membership invitation could not be accepted",
        );
      })
      .finally(() => {
        if (generation === invitationAcceptGeneration.current) {
          invitationAccepting.current = false;
          setInvitationAcceptPending(false);
        }
      });
  }, [
    clearWorkspaceTransientState,
    acceptedInvitationAccountId,
    me,
    membershipInvitationToken,
    refreshMe,
    invitationRetryNonce,
    locale,
    sessionResolved,
  ]);

  useEffect(() => {
    if (
      route !== "/customer" ||
      !order ||
      (order.service.cancellation
        ? ["manual", "terminated"].includes(order.service.cancellation.status)
        : ["active", "provisioned_hold", "provision_failed", "terminated"].includes(
            order.service.status,
          ))
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void api<OrderDetail>(`/api/v1/orders/${order.order.id}`)
        .then(async (detail) => {
          setOrder(detail);
          if (detail.invoice.status === "paid") {
            await Promise.all([refreshBilling(), refreshPaymentSettings()]);
          }
        })
        .catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [order, refreshBilling, refreshPaymentSettings, route]);

  const refreshManualItems = useCallback(async (expectedScope?: AdminOperationScope) => {
    const scope = expectedScope ?? captureAdminOperationScope();
    if (
      route !== "/admin" ||
      activeRouteRef.current !== "/admin" ||
      !canManageManualFulfillment
    ) {
      if (adminOperationRequestIsCurrent(scope)) setManualItems([]);
      return false;
    }
    if (!adminOperationRequestIsCurrent(scope)) return false;
    const result = await api<{ items: ManualItem[] }>("/api/v1/admin/manual-fulfillment");
    if (!adminOperationRequestIsCurrent(scope)) return false;
    setManualItems(result.items);
    return true;
  }, [
    adminOperationRequestIsCurrent,
    canManageManualFulfillment,
    captureAdminOperationScope,
    route,
    staffAccessFingerprint,
  ]);

  const refreshAdminCancellations = useCallback(async (
    expectedScope?: AdminOperationScope,
  ) => {
    const scope = expectedScope ?? captureAdminOperationScope();
    if (
      route !== "/admin" ||
      activeRouteRef.current !== "/admin" ||
      !canUseFullAdminWorkspace
    ) {
      if (adminOperationRequestIsCurrent(scope)) setAdminCancellations([]);
      return false;
    }
    if (!adminOperationRequestIsCurrent(scope)) return false;
    const result = await api<{ items: AdminCancellationItem[] }>(
      "/api/v1/admin/services/cancellations",
    );
    if (!adminOperationRequestIsCurrent(scope)) return false;
    setAdminCancellations(result.items);
    return true;
  }, [
    adminOperationRequestIsCurrent,
    canUseFullAdminWorkspace,
    captureAdminOperationScope,
    route,
    staffAccessFingerprint,
  ]);

  const refreshUnclaimedFunds = useCallback(async (
    expectedScope?: AdminOperationScope,
    additionalIsCurrent?: () => boolean,
  ) => {
    const scope = expectedScope ?? captureAdminOperationScope();
    const requestIsCurrent = () =>
      adminOperationRequestIsCurrent(scope) &&
      (additionalIsCurrent?.() ?? true);
    if (
      route !== "/admin" ||
      activeRouteRef.current !== "/admin" ||
      !canUseFullAdminWorkspace
    ) {
      if (requestIsCurrent()) setUnclaimedFunds([]);
      return false;
    }
    if (!requestIsCurrent()) return false;
    const result = await api<{ items: UnclaimedFundItem[] }>("/api/v1/admin/funds/unclaimed");
    if (!requestIsCurrent()) return false;
    setUnclaimedFunds(result.items);
    return true;
  }, [
    adminOperationRequestIsCurrent,
    canUseFullAdminWorkspace,
    captureAdminOperationScope,
    route,
    staffAccessFingerprint,
  ]);

  const refreshRefundCandidates = useCallback(async (expectedScope?: AdminOperationScope) => {
    const scope = expectedScope ?? captureAdminOperationScope();
    if (
      route !== "/admin" ||
      activeRouteRef.current !== "/admin" ||
      !canManageRefunds
    ) {
      if (adminOperationRequestIsCurrent(scope)) setRefundCandidates([]);
      return false;
    }
    if (!adminOperationRequestIsCurrent(scope)) return false;
    const result = await api<{ items: RefundCandidate[] }>("/api/v1/admin/refund-candidates");
    if (!adminOperationRequestIsCurrent(scope)) return false;
    setRefundCandidates(result.items);
    return true;
  }, [
    adminOperationRequestIsCurrent,
    canManageRefunds,
    captureAdminOperationScope,
    route,
    staffAccessFingerprint,
  ]);

  const refreshRefundRecords = useCallback(async (expectedScope?: AdminOperationScope) => {
    const scope = expectedScope ?? captureAdminOperationScope();
    if (
      route !== "/admin" ||
      activeRouteRef.current !== "/admin" ||
      !canManageRefunds
    ) {
      if (adminOperationRequestIsCurrent(scope)) setRefundRecords({});
      return false;
    }
    if (!adminOperationRequestIsCurrent(scope)) return false;
    const result = await api<{ items: RefundRecord[] }>("/api/v1/admin/refunds");
    if (!adminOperationRequestIsCurrent(scope)) return false;
    setRefundRecords(
      Object.fromEntries(result.items.map((refund) => [refund.refundId, refund])),
    );
    return true;
  }, [
    adminOperationRequestIsCurrent,
    canManageRefunds,
    captureAdminOperationScope,
    route,
    staffAccessFingerprint,
  ]);

  const refreshRefundSecurityHolds = useCallback(async (expectedScope?: AdminOperationScope) => {
    const scope = expectedScope ?? captureAdminOperationScope();
    if (
      route !== "/admin" ||
      activeRouteRef.current !== "/admin" ||
      !canManageRefunds
    ) {
      if (adminOperationRequestIsCurrent(scope)) setRefundSecurityHolds([]);
      return false;
    }
    if (!adminOperationRequestIsCurrent(scope)) return false;
    const result = await api<{ items: RefundSecurityHold[] }>(
      "/api/v1/admin/refund-security-holds",
    );
    if (!adminOperationRequestIsCurrent(scope)) return false;
    setRefundSecurityHolds(result.items);
    return true;
  }, [
    adminOperationRequestIsCurrent,
    canManageRefunds,
    captureAdminOperationScope,
    route,
    staffAccessFingerprint,
  ]);

  const refreshRefundDismissalCorrections = useCallback(async (expectedScope?: AdminOperationScope) => {
    const scope = expectedScope ?? captureAdminOperationScope();
    if (
      route !== "/admin" ||
      activeRouteRef.current !== "/admin" ||
      !canManageRefunds
    ) {
      if (adminOperationRequestIsCurrent(scope)) setRefundDismissalCorrections([]);
      return false;
    }
    if (!adminOperationRequestIsCurrent(scope)) return false;
    const result = await api<{ items: RefundDismissalCorrection[] }>(
      "/api/v1/admin/refund-dismissal-corrections",
    );
    if (!adminOperationRequestIsCurrent(scope)) return false;
    setRefundDismissalCorrections(result.items);
    return true;
  }, [
    adminOperationRequestIsCurrent,
    canManageRefunds,
    captureAdminOperationScope,
    route,
    staffAccessFingerprint,
  ]);

  const refreshRefundReceiptCapacityIncidents = useCallback(async (
    expectedScope?: AdminOperationScope,
  ) => {
    const scope = expectedScope ?? captureAdminOperationScope();
    if (
      route !== "/admin" ||
      activeRouteRef.current !== "/admin" ||
      !canManageRefunds
    ) {
      if (adminOperationRequestIsCurrent(scope)) setRefundReceiptCapacityIncidents([]);
      return false;
    }
    if (!adminOperationRequestIsCurrent(scope)) return false;
    const result = await api<{ items: RefundReceiptCapacityIncident[] }>(
      "/api/v1/admin/refund-receipt-capacity-incidents",
    );
    if (!adminOperationRequestIsCurrent(scope)) return false;
    setRefundReceiptCapacityIncidents(result.items);
    return true;
  }, [
    adminOperationRequestIsCurrent,
    canManageRefunds,
    captureAdminOperationScope,
    route,
    staffAccessFingerprint,
  ]);

  const refreshAdminChargebacks = useCallback(async (
    expectedScope?: AdminOperationScope,
  ) => {
    const scope = expectedScope ?? captureAdminOperationScope();
    if (
      route !== "/admin" ||
      activeRouteRef.current !== "/admin" ||
      !canUseFullAdminWorkspace
    ) {
      if (adminOperationRequestIsCurrent(scope)) {
        setAdminChargebacks([]);
        setAdminUnclaimedChargebacks([]);
        setAdminChargebackHolds([]);
      }
      return false;
    }
    if (!adminOperationRequestIsCurrent(scope)) return false;
    const result = await api<{
      items: AddFundsChargeback[];
      unclaimedChargebacks: AddFundsUnclaimedChargeback[];
      manualHolds: AddFundsChargebackHold[];
    }>("/api/v1/admin/add-funds-chargebacks");
    if (!adminOperationRequestIsCurrent(scope)) return false;
    setAdminChargebacks(result.items);
    setAdminUnclaimedChargebacks(result.unclaimedChargebacks);
    setAdminChargebackHolds(result.manualHolds);
    return true;
  }, [
    adminOperationRequestIsCurrent,
    canUseFullAdminWorkspace,
    captureAdminOperationScope,
    route,
    staffAccessFingerprint,
  ]);

  useEffect(() => {
    void Promise.all([
      refreshManualItems(),
      refreshAdminCancellations(),
      refreshUnclaimedFunds(),
      refreshRefundCandidates(),
      refreshRefundRecords(),
      refreshRefundSecurityHolds(),
      refreshRefundDismissalCorrections(),
      refreshRefundReceiptCapacityIncidents(),
      refreshAdminChargebacks(),
    ]).catch(() => undefined);
  }, [
    refreshManualItems,
    refreshAdminCancellations,
    refreshRefundCandidates,
    refreshRefundRecords,
    refreshRefundSecurityHolds,
    refreshRefundDismissalCorrections,
    refreshRefundReceiptCapacityIncidents,
    refreshAdminChargebacks,
    refreshUnclaimedFunds,
  ]);

  useEffect(() => {
    if (
      route !== "/admin" ||
      activeRouteRef.current !== "/admin" ||
      !canManageRefunds
    ) return;
    const active = Object.values(refundRecords).filter(
      (refund) =>
        (showUnscopedAdminOperations ||
          (operationAccount !== null && refund.clientAccountId === operationAccount.id)) &&
        ["queued", "processing", "unknown"].includes(refund.status),
    );
    if (active.length === 0) return;
    const timer = window.setInterval(() => {
      const operationScope = captureAdminOperationScope();
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      void Promise.all(
        active.map(async (refund) => {
          if (refundPollInFlight.current.has(refund.refundId)) return false;
          const requestSequence = ++refundPollRequestSequence.current;
          refundPollInFlight.current.set(refund.refundId, requestSequence);
          try {
            const updated = await api<RefundRecord>(
              `/api/v1/admin/refunds/${refund.refundId}`,
            );
            if (
              refundPollInFlight.current.get(refund.refundId) !== requestSequence ||
              !adminOperationRequestIsCurrent(operationScope, refund.clientAccountId) ||
              updated.clientAccountId !== refund.clientAccountId
            ) return false;
            setRefundRecords((current) => {
              const currentRefund = current[updated.refundId];
              if (currentRefund && currentRefund.version > updated.version) return current;
              return { ...current, [updated.refundId]: updated };
            });
            return true;
          } finally {
            if (refundPollInFlight.current.get(refund.refundId) === requestSequence) {
              refundPollInFlight.current.delete(refund.refundId);
            }
          }
        }),
      )
        .then((accepted) => {
          if (
            !accepted.some(Boolean) ||
            !adminOperationRequestIsCurrent(operationScope)
          ) return undefined;
          return Promise.all([
            refreshRefundCandidates(operationScope),
            refreshRefundSecurityHolds(operationScope),
            refreshUnclaimedFunds(operationScope),
          ]);
        })
        .catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [
    refundRecords,
    captureAdminOperationScope,
    refreshRefundCandidates,
    refreshRefundSecurityHolds,
    refreshUnclaimedFunds,
    adminOperationRequestIsCurrent,
    canManageRefunds,
    operationAccount,
    route,
    showUnscopedAdminOperations,
  ]);

  const groups = useMemo(() => {
    const result = new Map<string, Product[]>();
    for (const product of products) {
      const current = result.get(product.groupName) ?? [];
      current.push(product);
      result.set(product.groupName, current);
    }
    return result;
  }, [products]);

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      await api("/api/v1/auth/register", {
        method: "POST",
        body: JSON.stringify({
          email: data.get("email"),
          password: data.get("password"),
          clientName: data.get("clientName"),
          locale,
        }),
      });
      setNotice("Account created. The verification message is being delivered to Provider Lab.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Registration failed");
    }
  }

  async function registerInvitationIdentity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!membershipInvitationToken) return;
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      await api("/api/v1/auth/invitation-registrations", {
        method: "POST",
        body: JSON.stringify({
          token: membershipInvitationToken,
          email: data.get("email"),
          password: data.get("password"),
          locale,
        }),
      });
      setNotice(
        locale === "zh-CN"
          ? "受邀用户身份已创建，未创建客户账户。请登录并在 Mock Provider 邮箱完成验证。"
          : "Invited User identity created without a Client Account. Sign in and verify it in the Mock Provider mailbox.",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : locale === "zh-CN" ? "无法创建受邀用户身份" : "Invited User registration failed");
    }
  }

  async function verifyInvitationIdentity(
    event: ReactMouseEvent<HTMLAnchorElement>,
    verificationUrl: string,
  ) {
    if (!membershipInvitationToken) return;
    event.preventDefault();
    setError("");
    let verificationToken: string | null = null;
    try {
      const target = new URL(verificationUrl, window.location.origin);
      if (target.pathname.replace(/\/+$/, "") !== "/verify") {
        throw new Error(locale === "zh-CN" ? "验证链接无效" : "The verification link is invalid");
      }
      verificationToken = target.searchParams.get("token");
      if (!verificationToken) {
        throw new Error(locale === "zh-CN" ? "验证链接缺少令牌" : "The verification link has no token");
      }
      const result = await api<{ status: string }>("/api/v1/auth/verify-email", {
        method: "POST",
        body: JSON.stringify({ token: verificationToken }),
      });
      await refreshMe();
      setNoticeRaw(
        locale === "zh-CN"
          ? `邮箱验证：${result.status === "already_verified" ? "已验证" : result.status}。正在继续接受成员邀请…`
          : `Email verification: ${result.status === "already_verified" ? "verified" : result.status}. Continuing the membership invitation…`,
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : locale === "zh-CN"
            ? "邮箱验证失败"
            : "Email verification failed",
      );
    } finally {
      verificationToken = null;
    }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      let requiresAccountContext = false;
      try {
        const result = await api<{
          challenge?: { id: string; token: string; methods: string[] };
        }>("/api/v1/auth/login", {
          method: "POST",
          body: JSON.stringify({ email: data.get("email"), password: data.get("password") }),
        });
        if (result.challenge) {
          setLoginChallenge(result.challenge);
          setSessionResolved(true);
          setNoticeRaw(
            locale === "zh-CN"
              ? "密码已确认；请输入 TOTP 或一次性恢复码。"
              : "Password confirmed; enter a TOTP or one-time recovery code.",
          );
          event.currentTarget.reset();
          return;
        }
      } catch (caught) {
        if (caught instanceof ApiError && caught.code === "ACCOUNT_CONTEXT_REQUIRED") {
          // Login deliberately returns 409 after setting the session cookie
          // when zero, multiple or restricted memberships need an explicit
          // context choice. Resolve that authenticated identity normally.
          requiresAccountContext = true;
        } else {
          throw caught;
        }
      }
      setPaymentSettingsReauthExpiresAt(null);
      setPaymentSettingsPassword("");
      const viewer = await refreshMe();
      const viewerPermissions = parseStaffPermissions(viewer?.staff?.permissions);
      const viewerCanOpenAdmin =
        viewer?.verification.email === "passed" &&
        viewer.restrictions.user === false &&
        viewer.staff !== null &&
        viewer.staff !== undefined &&
        (viewerPermissions.has("*") ||
          viewerPermissions.has("accounts.view") ||
          viewerPermissions.has("billing.manual_receipt_manage") ||
          viewerPermissions.has("billing.refund_manage") ||
          viewerPermissions.has("services.manual_fulfillment") ||
          viewerPermissions.has("services.operations_manage") ||
          viewerPermissions.has("support.tickets.manage"));
      const target = route === "/"
        ? viewerCanOpenAdmin ? "/admin" : "/customer"
        : route;
      if (membershipInvitationToken) {
        setSessionResolved(true);
        setNoticeRaw(locale === "zh-CN" ? "已登录，正在检查成员邀请…" : "Signed in. Checking the membership invitation…");
        return;
      }
      const staysOnResolvedRoute = route === target;
      openRoute(target);
      if (staysOnResolvedRoute) setSessionResolved(true);
      setNoticeRaw(
        requiresAccountContext
          ? locale === "zh-CN" ? "已登录。请选择当前客户账户后继续。" : "Signed in. Select an active Client Account to continue."
          : locale === "zh-CN" ? "已登录。" : "Signed in.",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign in failed");
    }
  }

  async function completeLoginChallenge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!loginChallenge) return;
    const data = new FormData(event.currentTarget);
    setError("");
    try {
      let requiresAccountContext = false;
      try {
        await api("/api/v1/auth/login-challenges/complete", {
          method: "POST",
          body: JSON.stringify({
            challengeId: loginChallenge.id,
            challengeToken: loginChallenge.token,
            factorCode: data.get("factorCode"),
          }),
        });
      } catch (caught) {
        if (caught instanceof ApiError && caught.code === "ACCOUNT_CONTEXT_REQUIRED") {
          requiresAccountContext = true;
        } else {
          throw caught;
        }
      }
      setLoginChallenge(null);
      const viewer = await refreshMe();
      const permissions = parseStaffPermissions(viewer?.staff?.permissions);
      const target = route === "/"
        ? viewer?.staff && (permissions.has("*") || permissions.size > 0)
          ? "/admin"
          : "/customer"
        : route;
      const staysOnResolvedRoute = route === target;
      openRoute(target);
      if (staysOnResolvedRoute) setSessionResolved(true);
      setNoticeRaw(requiresAccountContext
        ? locale === "zh-CN" ? "已登录。请选择当前客户账户。" : "Signed in. Select an active Client Account."
        : locale === "zh-CN" ? "双因素登录成功。" : "Two-factor sign-in completed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Login challenge failed");
    }
  }

  async function logout() {
    setError("");
    // Invalidate every route- and account-bound continuation as soon as the
    // exclusive session transition is requested. An in-flight shared request
    // may finish first, but it must not resume a stale mutation while logout
    // is waiting for the Web Lock.
    clearWorkspaceTransientState();
    try {
      await api("/api/v1/auth/logout", { method: "POST", body: "{}" });
      hardResetSession();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign out failed");
    }
  }

  async function createOrder() {
    if (!selected || !legal || !canCreateOrders) return;
    setError("");
    try {
      const configuration =
        selected.product.id === "gsl-inbound" ? { bandwidth_units: quantity } : {};
      const created = await api<{ orderId: string }>("/api/v1/orders", {
        method: "POST",
        body: JSON.stringify({
          priceId: selected.price.id,
          configuration,
          termsVersion: legal.documents.terms.version,
          aupVersion: legal.documents.aup.version,
          idempotencyKey: newIdempotencyKey(),
        }),
      });
      setOrder(await api<OrderDetail>(`/api/v1/orders/${created.orderId}`));
      setSelected(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Checkout failed");
    }
  }

  async function startPayment() {
    if (!order || !canWriteBilling) return;
    setError("");
    try {
      if (savePaymentMethod || enableAutomaticRenewal) {
        await ensurePaymentSettingsReauth();
      }
      const quote =
        paymentQuote ??
        (await api<PaymentQuote>(`/api/v1/invoices/${order.invoice.id}/payment-quotes`, {
          method: "POST",
          body: JSON.stringify({ paymentMethod, applyCredit }),
        }));
      await api(`/api/v1/invoices/${order.invoice.id}/payments`, {
        method: "POST",
        body: JSON.stringify({
          quoteId: quote.quoteId,
          scenario: paymentScenario,
          savePaymentMethod,
          ...(savePaymentMethod && paymentSettings
            ? { saveConsentVersion: paymentSettings.consentVersions.savePaymentMethod }
            : {}),
          enableAutomaticRenewal,
          ...(enableAutomaticRenewal && paymentSettings
            ? {
                automaticRenewalConsentVersion:
                  paymentSettings.consentVersions.automaticRenewal,
              }
            : {}),
          idempotencyKey: newIdempotencyKey(),
        }),
      });
      setOrder(await api<OrderDetail>(`/api/v1/orders/${order.order.id}`));
      await refreshBilling();
      await refreshPaymentSettings();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Payment could not start");
    }
  }

  async function ensurePaymentSettingsReauth(): Promise<void> {
    if (paymentSettingsReauthExpiresAt && paymentSettingsReauthExpiresAt > Date.now()) return;
    if (paymentSettingsReauthExpiresAt) setPaymentSettingsReauthExpiresAt(null);
    if (paymentSettingsPassword.length === 0) {
      throw new Error("Re-enter your password before changing payment settings");
    }
    const grant = await api<{ expiresAt: string; fixedWindowMinutes: number }>(
      "/api/v1/auth/reauth",
      {
        method: "POST",
        body: JSON.stringify({ password: paymentSettingsPassword }),
      },
    );
    setPaymentSettingsReauthExpiresAt(Date.parse(grant.expiresAt));
    setPaymentSettingsPassword("");
  }

  async function mutatePaymentSettings<Result extends Record<string, unknown>>(
    identity: string,
    path: string,
    payload: Record<string, unknown>,
    successMessage: string | ((result: Result) => string),
  ) {
    if (paymentSettingsPending || !paymentSettingsReauthReady) return;
    let idempotencyKey = paymentSettingsIntentKeys.current.get(identity);
    if (!idempotencyKey) {
      idempotencyKey = newIdempotencyKey();
      paymentSettingsIntentKeys.current.set(identity, idempotencyKey);
    }
    setPaymentSettingsPending(true);
    setError("");
    try {
      await ensurePaymentSettingsReauth();
      const result = await api<Result>(path, {
        method: "POST",
        body: JSON.stringify({ ...payload, idempotencyKey }),
      });
      paymentSettingsIntentKeys.current.delete(identity);
      setNotice(
        typeof successMessage === "function" ? successMessage(result) : successMessage,
      );
      await Promise.all([refreshPaymentSettings(), refreshRenewals()]);
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        caught.status === 409 &&
        (caught.code === "VERSION_CONFLICT" ||
          caught.code === "PENDING_AUTOMATIC_RENEWAL_DECISION")
      ) {
        paymentSettingsIntentKeys.current.delete(identity);
        await Promise.allSettled([refreshPaymentSettings(), refreshRenewals()]);
      }
      setError(caught instanceof Error ? caught.message : "Payment setting could not be changed");
    } finally {
      setPaymentSettingsPending(false);
    }
  }

  function makePaymentMethodDefault(method: PaymentSettings["methods"][number]) {
    const identity = `default:${method.id}:${method.version}`;
    return mutatePaymentSettings<Record<string, unknown>>(
      identity,
      `/api/v1/billing/payment-methods/${method.id}/default`,
      { expectedVersion: method.version },
      `${method.brand} ending ${method.lastFour} is now the default. Automatic-renewal permissions were not changed.`,
    );
  }

  function removeSavedPaymentMethod(method: PaymentSettings["methods"][number]) {
    const identity = `remove:${method.id}:${method.version}`;
    return mutatePaymentSettings<{
      inflightAutomaticPaymentsRequiringReconciliation: number;
    }>(
      identity,
      `/api/v1/billing/payment-methods/${method.id}/remove`,
      { expectedVersion: method.version },
      (result) =>
        result.inflightAutomaticPaymentsRequiringReconciliation > 0
          ? `${method.brand} ending ${method.lastFour} was removed and new automatic charges were stopped. ${result.inflightAutomaticPaymentsRequiringReconciliation} already-dispatched payment is still being reconciled and may still settle; it will not be sent a second time.`
          : `${method.brand} ending ${method.lastFour} was removed. Its service-level automatic-renewal authorizations were revoked.`,
    );
  }

  function enableServiceAutomaticRenewal(method: PaymentSettings["methods"][number]) {
    if (!order || !paymentSettings) return Promise.resolve();
    const decision = paymentSettings.serviceDecisions.find(
      (service) => service.serviceId === order.service.id,
    );
    if (!decision) {
      setError("Automatic-renewal state changed; refresh and confirm again");
      return Promise.resolve();
    }
    const current = paymentSettings.automaticRenewals.find(
      (authorization) =>
        authorization.serviceId === order.service.id && authorization.status === "active",
    );
    const identity =
      `auto-enable:${order.service.id}:${method.id}:${current?.version ?? "none"}:` +
      decision.decisionGeneration;
    return mutatePaymentSettings<Record<string, unknown>>(
      identity,
      `/api/v1/services/${order.service.id}/automatic-renewal`,
      {
        savedPaymentMethodId: method.id,
        consentVersion: paymentSettings.consentVersions.automaticRenewal,
        expectedAuthorizationId: current?.id ?? null,
        expectedAuthorizationVersion: current?.version ?? null,
        expectedDecisionGeneration: decision.decisionGeneration,
      },
      `Automatic renewal is enabled for ${order.order.price.productName} using ${method.brand} ending ${method.lastFour}.`,
    );
  }

  function revokeServiceAutomaticRenewal(
    authorization: PaymentSettings["automaticRenewals"][number],
  ) {
    const decision = paymentSettings?.serviceDecisions.find(
      (service) => service.serviceId === authorization.serviceId,
    );
    if (!decision) {
      setError("Automatic-renewal state changed; refresh and confirm again");
      return Promise.resolve();
    }
    const identity =
      `auto-revoke:${authorization.id}:${authorization.version}:` +
      decision.decisionGeneration;
    return mutatePaymentSettings<{
      inflightAutomaticPaymentsRequiringReconciliation: number;
    }>(
      identity,
      `/api/v1/services/${authorization.serviceId}/automatic-renewal/revoke`,
      {
        expectedAuthorizationId: authorization.id,
        expectedVersion: authorization.version,
        expectedDecisionGeneration: decision.decisionGeneration,
        reason: "Customer revoked automatic renewal",
      },
      (result) =>
        result.inflightAutomaticPaymentsRequiringReconciliation > 0
          ? `Automatic renewal was revoked for ${authorization.productName} and no new charge will be sent. ${result.inflightAutomaticPaymentsRequiringReconciliation} already-dispatched payment is still being reconciled and may still settle; it will not be sent a second time.`
          : `Automatic renewal was revoked for ${authorization.productName}. No automatic payment was already in flight.`,
    );
  }

  function revokePendingAutomaticRenewal(
    pending: PaymentSettings["pendingAutomaticRenewals"][number],
  ) {
    const identity =
      `auto-withdraw-pending:${pending.serviceId}:${pending.paymentAttemptId}:` +
      pending.decisionGeneration;
    return mutatePaymentSettings<{
      pendingConsentRevoked: boolean;
    }>(
      identity,
      `/api/v1/services/${pending.serviceId}/automatic-renewal/pending-consent/withdraw`,
      {
        expectedPaymentAttemptId: pending.paymentAttemptId,
        expectedDecisionGeneration: pending.decisionGeneration,
        reason: "Customer withdrew pending automatic-renewal consent",
      },
      `Pending automatic-renewal consent was withdrawn for ${pending.productName}. The invoice payment may still settle, but it cannot enable future off-session charges.`,
    );
  }

  async function scheduleServiceCancellation() {
    if (!order || !canManageServices || cancellationPending) return;
    const reason = cancellationReason.trim();
    const requestIdentity = JSON.stringify({
      serviceId: order.service.id,
      expectedVersion: order.service.version,
      reason: reason || null,
    });
    let idempotencyKey = cancellationIntentKeys.current.get(requestIdentity);
    if (!idempotencyKey) {
      idempotencyKey = newIdempotencyKey();
      cancellationIntentKeys.current.set(requestIdentity, idempotencyKey);
    }
    setError("");
    setCancellationPending(true);
    try {
      await api(`/api/v1/services/${order.service.id}/cancellation`, {
        method: "POST",
        body: JSON.stringify({
          expectedVersion: order.service.version,
          ...(reason ? { reason } : {}),
          idempotencyKey,
        }),
      });
      cancellationIntentKeys.current.delete(requestIdentity);
      const [refreshed] = await Promise.all([
        api<OrderDetail>(`/api/v1/orders/${order.order.id}`),
        refreshRenewals(),
      ]);
      setOrder(refreshed);
      setCancellationReason("");
      setNotice(
        locale === "zh-CN"
          ? `服务已安排在 ${new Date(refreshed.service.cancellation!.effectiveAt).toLocaleString()} 取消。在此之前，已付费服务保持可用，并且不会生成下一张续费发票。`
          : `Cancellation scheduled for ${new Date(refreshed.service.cancellation!.effectiveAt).toLocaleString()}. The paid service remains available until then and no new renewal invoice will be generated.`,
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : locale === "zh-CN"
            ? "无法安排账期末取消"
            : "Cancellation could not be scheduled",
      );
    } finally {
      setCancellationPending(false);
    }
  }

  async function startRenewalPayment(renewal: RenewalItem) {
    if (renewal.status === "paid" || renewalPaymentPendingId || !canWriteBilling || !me) return;
    const operationScope = {
      routeGeneration: routeGenerationRef.current,
      viewerId: me.id,
      accountId: me.clientAccountId,
      contextVersion: me.accountContextVersion,
    };
    const paymentRequestIsCurrent = () => {
      const current = meRef.current;
      return (
        activeRouteRef.current === "/customer" &&
        routeGenerationRef.current === operationScope.routeGeneration &&
        current?.id === operationScope.viewerId &&
        current.clientAccountId === operationScope.accountId &&
        current.accountContextVersion === operationScope.contextVersion &&
        current.eligible === true &&
        (current.context?.capabilities ?? []).includes("billing.write")
      );
    };
    if (!paymentRequestIsCurrent()) return;
    setError("");
    setRenewalPaymentPendingId(renewal.renewalId);
    let paymentStarted = false;
    try {
      const quote = await api<PaymentQuote>(
        `/api/v1/invoices/${renewal.invoiceId}/payment-quotes`,
        {
          method: "POST",
          body: JSON.stringify({ paymentMethod, applyCredit }),
        },
      );
      if (!paymentRequestIsCurrent()) return;
      await api(`/api/v1/invoices/${renewal.invoiceId}/payments`, {
        method: "POST",
        body: JSON.stringify({
          quoteId: quote.quoteId,
          scenario: paymentScenario,
          idempotencyKey: newIdempotencyKey(),
        }),
      });
      if (!paymentRequestIsCurrent()) return;
      paymentStarted = true;
      setNotice(
        "Mock renewal payment started. The service term changes only after real allocations fully settle the invoice.",
      );
      for (let poll = 0; poll < 12; poll += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        if (!paymentRequestIsCurrent()) return;
        const current = await api<{ items: RenewalItem[] }>("/api/v1/billing/renewals");
        if (!paymentRequestIsCurrent()) return;
        setRenewals(current.items);
        if (current.items.find((item) => item.renewalId === renewal.renewalId)?.status === "paid") {
          break;
        }
      }
      const refreshedBilling = await api<BillingSummary>("/api/v1/billing/summary");
      if (!paymentRequestIsCurrent()) return;
      setBilling(refreshedBilling);
    } catch (caught) {
      if (!paymentRequestIsCurrent()) return;
      setError(
        paymentStarted
          ? "The payment was accepted, but its current status could not be refreshed. Check the renewal again before retrying."
          : caught instanceof Error
            ? caught.message
            : "Renewal payment could not start",
      );
    } finally {
      if (paymentRequestIsCurrent()) setRenewalPaymentPendingId(null);
    }
  }

  async function runBillingAutomation() {
    if (!canUseFullAdminRoute || automationReason.trim().length < 10) return;
    const operationScope = captureAdminOperationScope();
    if (!adminOperationRequestIsCurrent(operationScope)) return;
    const reason = automationReason.trim();
    const effectiveAt = automationEffectiveAt
      ? new Date(automationEffectiveAt).toISOString()
      : null;
    setError("");
    try {
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      setAdminPassword("");
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      const result = await api<{
        businessDate: string;
        invoicesCreated: number;
        remindersCreated: number;
        delinquencyDeferralsCreated: number;
        replayed: boolean;
      }>("/api/v1/admin/billing/automation/run", {
        method: "POST",
        body: JSON.stringify({
          reason,
          idempotencyKey: newIdempotencyKey(),
          ...(effectiveAt ? { effectiveAt } : {}),
        }),
      });
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      setAutomationReason("");
      await refreshAdminRenewals(operationScope);
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      setNotice(
        `${result.replayed ? "Replayed" : "Completed"} Asia/Shanghai billing day ${result.businessDate}: ${result.invoicesCreated} invoice(s), ${result.remindersCreated} reminder(s), ${result.delinquencyDeferralsCreated} payment reconciliation hold(s).`,
      );
    } catch (caught) {
      if (adminOperationRequestIsCurrent(operationScope)) {
        setError(caught instanceof Error ? caught.message : "Billing automation failed");
      }
    }
  }

  async function resolveRenewalHold(renewal: AdminRenewalItem) {
    if (
      !canUseFullAdminRoute ||
      renewal.renewalStatus !== "manual_hold" ||
      renewalHoldReason.trim().length < 10 ||
      renewalHoldPendingId
    ) {
      return;
    }
    const operationScope = captureAdminOperationScope();
    if (!adminOperationRequestIsCurrent(operationScope)) return;
    const reason = renewalHoldReason.trim();
    setError("");
    setRenewalHoldPendingId(renewal.renewalId);
    try {
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      setAdminPassword("");
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      await api(`/api/v1/admin/billing/renewals/${renewal.renewalId}/resolve-hold`, {
        method: "POST",
        body: JSON.stringify({
          action: "grant_period",
          reason,
          expectedVersion: renewal.version,
          idempotencyKey: newIdempotencyKey(),
        }),
      });
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      setRenewalHoldReason("");
      await refreshAdminRenewals(operationScope);
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      setNotice("The funded renewal Hold was reviewed and the exact service period was granted.");
    } catch (caught) {
      if (adminOperationRequestIsCurrent(operationScope)) {
        setError(caught instanceof Error ? caught.message : "Renewal Hold could not be resolved");
      }
    } finally {
      if (adminOperationRequestIsCurrent(operationScope)) setRenewalHoldPendingId(null);
    }
  }

  async function performManualSuspensionAction(
    renewal: AdminRenewalItem,
    action: "confirm_suspended" | "confirm_restored",
  ) {
    const delinquency = renewal.delinquency;
    if (
      !canUseFullAdminRoute ||
      !delinquency?.manualControl?.allowedActions.includes(action) ||
      manualSuspensionReason.trim().length < 10 ||
      manualSuspensionPendingId
    ) {
      return;
    }
    const operationScope = captureAdminOperationScope();
    if (!adminOperationRequestIsCurrent(operationScope)) return;
    const reason = manualSuspensionReason.trim();
    const requestIdentity = JSON.stringify({
      caseId: delinquency.caseId,
      action,
      expectedVersion: delinquency.version,
      reason,
    });
    let idempotencyKey = manualSuspensionIntentKeys.current.get(requestIdentity);
    if (!idempotencyKey) {
      idempotencyKey = newIdempotencyKey();
      manualSuspensionIntentKeys.current.set(requestIdentity, idempotencyKey);
    }
    setError("");
    setManualSuspensionPendingId(delinquency.caseId);
    try {
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      setAdminPassword("");
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      const outcome = await api<{
        caseStatus: string;
        serviceStatus: string;
        providerCalled: false;
        replayed: boolean;
      }>(
        `/api/v1/admin/billing/delinquency-cases/${delinquency.caseId}/manual-actions`,
        {
          method: "POST",
          body: JSON.stringify({
            action,
            reason,
            expectedVersion: delinquency.version,
            idempotencyKey,
          }),
        },
      );
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      manualSuspensionIntentKeys.current.delete(requestIdentity);
      setManualSuspensionReason("");
      await refreshAdminRenewals(operationScope);
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      setNotice(
        action === "confirm_suspended"
          ? `Manual suspension recorded: Core service ${outcome.serviceStatus}, case ${outcome.caseStatus}. No Provider request was sent.`
          : `Manual restoration recorded: Core service ${outcome.serviceStatus}, case ${outcome.caseStatus}. No Provider request was sent.`,
      );
    } catch (caught) {
      if (adminOperationRequestIsCurrent(operationScope)) {
        setError(caught instanceof Error ? caught.message : "Manual service action failed");
      }
    } finally {
      if (adminOperationRequestIsCurrent(operationScope)) setManualSuspensionPendingId(null);
    }
  }

  async function completeCycleEndCancellation(item: AdminCancellationItem) {
    if (
      !canUseFullAdminRoute ||
      !item.interventionRequired ||
      cancellationCompletionReason.trim().length < 10 ||
      cancellationCompletionPendingId
    ) {
      return;
    }
    const operationScope = captureAdminOperationScope();
    if (!adminOperationRequestIsCurrent(operationScope)) return;
    const reason = cancellationCompletionReason.trim();
    const requestIdentity = JSON.stringify({
      executionId: item.executionId,
      expectedExecutionVersion: item.executionVersion,
      expectedServiceVersion: item.serviceVersion,
      reason,
    });
    let idempotencyKey = cancellationCompletionIntentKeys.current.get(requestIdentity);
    if (!idempotencyKey) {
      idempotencyKey = newIdempotencyKey();
      cancellationCompletionIntentKeys.current.set(requestIdentity, idempotencyKey);
    }
    setError("");
    setCancellationCompletionPendingId(item.executionId);
    try {
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      setAdminPassword("");
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      const outcome = await api<{
        executionStatus: "terminated";
        serviceStatus: "terminated";
        providerCalled: false;
        replayed: boolean;
      }>(`/api/v1/admin/services/cancellations/${item.executionId}/complete-manual`, {
        method: "POST",
        body: JSON.stringify({
          expectedExecutionVersion: item.executionVersion,
          expectedServiceVersion: item.serviceVersion,
          reason,
          idempotencyKey,
        }),
      });
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      cancellationCompletionIntentKeys.current.delete(requestIdentity);
      setCancellationCompletionReason("");
      await refreshAdminCancellations(operationScope);
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      setNotice(
        `${outcome.replayed ? "Replayed" : "Recorded"} manual cycle-end termination: Core service ${outcome.serviceStatus}, execution ${outcome.executionStatus}. No Provider request was sent.`,
      );
    } catch (caught) {
      if (adminOperationRequestIsCurrent(operationScope)) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Manual cycle-end termination could not be recorded",
        );
      }
    } finally {
      if (adminOperationRequestIsCurrent(operationScope)) {
        setCancellationCompletionPendingId(null);
      }
    }
  }

  async function startAddFunds() {
    if (!addFundsQuote || !canWriteBilling) return;
    setError("");
    try {
      const created = await api<{
        commandId: string;
      }>("/api/v1/billing/add-funds", {
        method: "POST",
        body: JSON.stringify({
          quoteId: addFundsQuote.quoteId,
          scenario: addFundsScenario,
          idempotencyKey: newIdempotencyKey(),
        }),
      });
      const command = await api<AddFundsCommand>(
        `/api/v1/billing/add-funds/${created.commandId}`,
      );
      setAddFundsCommand(command);
      if (
        ["succeeded", "failed", "cancelled", "expired", "manual"].includes(
          command.status,
        )
      ) {
        await refreshBilling();
      }
      setNotice(
        "Mock Add Funds started. Provider settlement is separate from usable Credit.",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Add Funds could not start");
    }
  }

  async function openLabMailbox() {
    setError("");
    try {
      const result = await api<{ messages: LabMessage[] }>("/api/v1/lab/mailbox");
      setMail(result.messages);
      if (result.messages.length === 0) {
        setNotice("The Mock Mail Provider has not delivered a message yet. Try again shortly.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Mock mailbox is unavailable");
    }
  }

  async function fetchManualReceiptHistory(
    clientAccountId: string,
    scopeToken: string,
  ): Promise<{
    clientAccount: { id: string; name: string };
    items: ManualReceiptItem[];
  } | null> {
    if (
      !canManageManualReceiptsRoute ||
      activeRouteRef.current !== "/admin" ||
      routeGenerationRef.current !== renderRouteGeneration ||
      !manualReceiptScopeIsCurrent(scopeToken, clientAccountId)
    ) {
      return null;
    }
    const result = await api<{
      clientAccount: { id: string; name: string };
      items: ManualReceiptItem[];
    }>(
      `/api/v1/admin/client-accounts/${clientAccountId}/manual-receipts`,
    );
    return manualReceiptScopeIsCurrent(scopeToken, clientAccountId) ? result : null;
  }

  async function loadManualReceiptHistory() {
    const clientAccountId = manualReceiptClientAccountId.trim().toLowerCase();
    if (
      !canManageManualReceiptsRoute ||
      manualReceiptPending ||
      !looksLikeUuid(clientAccountId) ||
      (operationAccount !== null && operationAccount.id !== clientAccountId)
    ) {
      return;
    }
    manualReceiptRequestGeneration.current += 1;
    const scopeToken = currentManualReceiptScopeToken(clientAccountId);
    setError("");
    setManualReceiptPending(true);
    try {
      const result = await fetchManualReceiptHistory(clientAccountId, scopeToken);
      if (!result || !manualReceiptScopeIsCurrent(scopeToken, clientAccountId)) return;
      setManualReceiptTarget(result.clientAccount);
      setManualReceiptHistory(result.items);
      setNotice(
        `Verified ${result.clientAccount.name} (${result.clientAccount.id}) and refreshed its manual receipt history.`,
      );
    } catch (caught) {
      if (manualReceiptScopeIsCurrent(scopeToken, clientAccountId)) {
        setError(caught instanceof Error ? caught.message : "Manual receipt history is unavailable");
      }
    } finally {
      if (manualReceiptScopeIsCurrent(scopeToken, clientAccountId)) {
        setManualReceiptPending(false);
      }
    }
  }

  async function recordManualReceipt() {
    if (!canManageManualReceiptsRoute || manualReceiptPending || !manualReceiptFormReady) return;
    const clientAccountId = manualReceiptClientAccountId.trim().toLowerCase();
    if (operationAccount !== null && operationAccount.id !== clientAccountId) return;
    manualReceiptRequestGeneration.current += 1;
    const scopeToken = currentManualReceiptScopeToken(clientAccountId);
    const operationScope = captureAdminOperationScope();
    const payload = {
      reference: manualReceiptReference.trim(),
      receivedAt: new Date(manualReceiptReceivedAt).toISOString(),
      grossAmountMinor: manualReceiptGrossMinor,
      feeMinor: manualReceiptFeeMinor,
      currency: "USD" as const,
      reason: manualReceiptReason.trim(),
    };
    const requestIdentity = JSON.stringify({ clientAccountId, ...payload });
    setError("");
    setManualReceiptPending(true);
    try {
      const storageKey = await manualReceiptIntentStorageKey(requestIdentity);
      let storedKey: string | null = null;
      try {
        storedKey = window.localStorage.getItem(storageKey);
      } catch {
        storedKey = null;
      }
      const idempotencyKey =
        manualReceiptIntentKeys.current.get(requestIdentity) ??
        storedKey ??
        newIdempotencyKey();
      manualReceiptIntentKeys.current.set(requestIdentity, idempotencyKey);
      try {
        window.localStorage.setItem(storageKey, idempotencyKey);
      } catch {
        // The in-memory key still makes a retry in this page replay-safe.
      }

      if (!manualReceiptScopeIsCurrent(scopeToken, clientAccountId)) return;
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      if (!manualReceiptScopeIsCurrent(scopeToken, clientAccountId)) return;
      setAdminPassword("");
      if (!manualReceiptScopeIsCurrent(scopeToken, clientAccountId)) return;
      const outcome = await api<ManualReceiptOutcome>(
        `/api/v1/admin/client-accounts/${clientAccountId}/manual-receipts`,
        {
          method: "POST",
          body: JSON.stringify({ ...payload, idempotencyKey }),
        },
      );
      manualReceiptIntentKeys.current.delete(requestIdentity);
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // A successful Core response is authoritative even if browser storage is unavailable.
      }
      if (!manualReceiptScopeIsCurrent(scopeToken, clientAccountId)) return;
      setManualReceiptOutcome(outcome);
      setManualReceiptReference("");
      setManualReceiptGrossMinor("10000");
      setManualReceiptFeeMinor("0");
      setManualReceiptReason("");
      setManualReceiptReceivedAt(defaultManualReceiptTime());
      const [historyRefresh, unclaimedRefresh] = await Promise.allSettled([
        fetchManualReceiptHistory(clientAccountId, scopeToken),
        refreshUnclaimedFunds(
          operationScope,
          () => manualReceiptScopeIsCurrent(scopeToken, clientAccountId),
        ),
      ]);
      if (!manualReceiptScopeIsCurrent(scopeToken, clientAccountId)) return;
      if (historyRefresh.status === "fulfilled" && historyRefresh.value) {
        setManualReceiptTarget(historyRefresh.value.clientAccount);
        setManualReceiptHistory(historyRefresh.value.items);
      }
      setNotice(
        outcome.replayed
          ? "This exact manual receipt was already recorded; no second cash or liability entry was created."
          : "Manual receipt recorded as unclaimed funds. No Provider, invoice payment, Credit, or service action was triggered.",
      );
      if (historyRefresh.status === "rejected" || unclaimedRefresh.status === "rejected") {
        setError("The receipt was saved, but one of the administrator lists could not be refreshed.");
      }
    } catch (caught) {
      if (manualReceiptScopeIsCurrent(scopeToken, clientAccountId)) {
        setError(caught instanceof Error ? caught.message : "Manual receipt could not be recorded");
      }
    } finally {
      if (manualReceiptScopeIsCurrent(scopeToken, clientAccountId)) {
        setManualReceiptPending(false);
      }
    }
  }

  async function reverseManualReceipt(receipt: ManualReceiptItem) {
    const clientAccountId = manualReceiptTarget?.id;
    if (
      !canManageManualReceiptsRoute ||
      !canManageUnclaimedFunds ||
      !clientAccountId ||
      manualReceiptReversalPendingId !== null ||
      manualReceiptReversalTargetId !== receipt.manualReceiptId ||
      !manualReceiptIsUntouched(receipt) ||
      manualReceiptReversalReason.trim().length < 10 ||
      manualReceiptReversalReason.trim().length > 1_000 ||
      adminPassword.length === 0
    ) {
      return;
    }
    if (operationAccount !== null && operationAccount.id !== clientAccountId) return;
    manualReceiptRequestGeneration.current += 1;
    const scopeToken = currentManualReceiptScopeToken(clientAccountId);
    const operationScope = captureAdminOperationScope();
    const payload = {
      expectedFundReceiptId: receipt.fundReceiptId,
      expectedGrossAmountMinor: receipt.grossAmountMinor,
      reason: manualReceiptReversalReason.trim(),
    };
    const requestIdentity = JSON.stringify({
      clientAccountId,
      manualReceiptId: receipt.manualReceiptId,
      ...payload,
    });
    setError("");
    setManualReceiptReversalPendingId(receipt.manualReceiptId);
    try {
      const storageKey = await manualReceiptReversalIntentStorageKey(requestIdentity);
      let storedKey: string | null = null;
      try {
        storedKey = window.localStorage.getItem(storageKey);
      } catch {
        storedKey = null;
      }
      const idempotencyKey =
        manualReceiptReversalIntentKeys.current.get(requestIdentity) ??
        storedKey ??
        newIdempotencyKey();
      manualReceiptReversalIntentKeys.current.set(requestIdentity, idempotencyKey);
      try {
        window.localStorage.setItem(storageKey, idempotencyKey);
      } catch {
        // The in-memory key still protects a retry in this page.
      }

      if (!manualReceiptScopeIsCurrent(scopeToken, clientAccountId)) return;
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      if (!manualReceiptScopeIsCurrent(scopeToken, clientAccountId)) return;
      setAdminPassword("");
      if (!manualReceiptScopeIsCurrent(scopeToken, clientAccountId)) return;
      const outcome = await api<ManualReceiptReversalOutcome>(
        `/api/v1/admin/client-accounts/${clientAccountId}/manual-receipts/${receipt.manualReceiptId}/reversal`,
        {
          method: "POST",
          body: JSON.stringify({ ...payload, idempotencyKey }),
        },
      );
      manualReceiptReversalIntentKeys.current.delete(requestIdentity);
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // Core's successful response is authoritative.
      }
      if (!manualReceiptScopeIsCurrent(scopeToken, clientAccountId)) return;
      setManualReceiptReversalOutcome(outcome);
      setManualReceiptReversalTargetId(null);
      setManualReceiptReversalReason("");
      const [historyRefresh, unclaimedRefresh] = await Promise.allSettled([
        fetchManualReceiptHistory(clientAccountId, scopeToken),
        refreshUnclaimedFunds(
          operationScope,
          () => manualReceiptScopeIsCurrent(scopeToken, clientAccountId),
        ),
      ]);
      if (!manualReceiptScopeIsCurrent(scopeToken, clientAccountId)) return;
      if (historyRefresh.status === "fulfilled" && historyRefresh.value) {
        setManualReceiptTarget(historyRefresh.value.clientAccount);
        setManualReceiptHistory(historyRefresh.value.items);
      }
      setNotice(
        outcome.replayed
          ? "This exact reversal was replayed safely; no second journal or money change was created."
          : "Mistaken manual receipt reversed with a separate balanced journal. The original fact remains immutable and no money was sent.",
      );
      if (historyRefresh.status === "rejected" || unclaimedRefresh.status === "rejected") {
        setError("The reversal was saved, but one of the administrator lists could not be refreshed.");
      }
    } catch (caught) {
      if (manualReceiptScopeIsCurrent(scopeToken, clientAccountId)) {
        setError(caught instanceof Error ? caught.message : "Manual receipt could not be reversed");
      }
    } finally {
      if (manualReceiptScopeIsCurrent(scopeToken, clientAccountId)) {
        setManualReceiptReversalPendingId(null);
      }
    }
  }

  async function completeManual(item: ManualItem) {
    if (
      !canManageManualFulfillmentRoute ||
      (operationAccount !== null && item.clientAccountId !== operationAccount.id)
    ) return;
    const operationScope = captureAdminOperationScope();
    if (!adminOperationRequestIsCurrent(operationScope, item.clientAccountId)) return;
    setError("");
    try {
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      if (
        !adminOperationRequestIsCurrent(operationScope, item.clientAccountId)
      ) return;
      setAdminPassword("");
      await api(`/api/v1/admin/services/${item.serviceId}/complete-manual`, {
        method: "POST",
        body: JSON.stringify({ reason: manualReason }),
      });
      if (
        !adminOperationRequestIsCurrent(operationScope, item.clientAccountId)
      ) return;
      setAdminPassword("");
      setManualReason("");
      await refreshManualItems(operationScope);
      if (
        !adminOperationRequestIsCurrent(operationScope, item.clientAccountId)
      ) return;
      setNotice("Manual service marked Ready for Service with an audited activation time.");
    } catch (caught) {
      if (
        adminOperationRequestIsCurrent(operationScope, item.clientAccountId)
      ) {
        setError(caught instanceof Error ? caught.message : "Manual fulfillment failed");
      }
    }
  }

  async function adjustCredit(direction: "increase" | "decrease") {
    if (!canUseFullAdminRoute || !me) return;
    const operationScope = captureAdminOperationScope();
    if (!adminOperationRequestIsCurrent(operationScope)) return;
    const clientAccountId = me.clientAccountId;
    const amountMinor = creditAdjustmentMinor;
    const reason = creditAdjustmentReason;
    setError("");
    try {
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      setAdminPassword("");
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      await api(`/api/v1/admin/client-accounts/${clientAccountId}/credit-adjustments`, {
        method: "POST",
        body: JSON.stringify({
          direction,
          amountMinor,
          currency: "USD",
          reason,
          idempotencyKey: newIdempotencyKey(),
        }),
      });
      if (!adminOperationRequestIsCurrent(operationScope)) return;
      setNotice(`Credit ${direction} recorded with a balanced journal and audit event.`);
      setCreditAdjustmentReason("");
    } catch (caught) {
      if (adminOperationRequestIsCurrent(operationScope)) {
        setError(caught instanceof Error ? caught.message : "Credit adjustment failed");
      }
    }
  }

  async function resolveUnclaimedFunds(
    item: UnclaimedFundItem,
    action: "convert_to_credit" | "allocate_invoice",
  ) {
    if (!canUseFullAdminRoute || !me) return;
    if (
      fundResolutionInFlight.current.has(item.receiptId) ||
      refundInFlight.current.has(item.receiptId)
    ) {
      return;
    }
    const operationScope = captureAdminOperationScope();
    if (!adminOperationRequestIsCurrent(operationScope, item.clientAccountId)) return;
    const invoiceId =
      action === "allocate_invoice"
        ? fundResolutionInvoiceId || item.suggestedInvoiceId
        : null;
    const reason = fundResolutionReason.trim();
    const requestIdentity = JSON.stringify({
      receiptId: item.receiptId,
      action,
      amountMinor: fundResolutionMinor,
      invoiceId,
      reason,
    });
    fundResolutionInFlight.current.add(item.receiptId);
    setFundResolutionPendingReceiptIds((current) => {
      const next = new Set(current);
      next.add(item.receiptId);
      return next;
    });
    setError("");
    try {
      const idempotencyKey = await fundResolutionIdempotencyKey(requestIdentity);
      if (!adminOperationRequestIsCurrent(operationScope, item.clientAccountId)) return;
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      if (!adminOperationRequestIsCurrent(operationScope, item.clientAccountId)) return;
      setAdminPassword("");
      if (!adminOperationRequestIsCurrent(operationScope, item.clientAccountId)) return;
      const resolution = await api<{ replayed: boolean }>(
        `/api/v1/admin/funds/${item.receiptId}/resolutions`,
        {
          method: "POST",
          body: JSON.stringify({
            action,
            amountMinor: fundResolutionMinor,
            invoiceId,
            reason,
            idempotencyKey,
          }),
        },
      );
      if (!adminOperationRequestIsCurrent(operationScope, item.clientAccountId)) return;
      setNotice(
        resolution.replayed
          ? "This exact fund resolution was already recorded; no second money movement occurred."
          : action === "convert_to_credit"
            ? "Unclaimed funds converted to Credit with a balanced journal."
            : "Unclaimed funds allocated to the matching invoice with a balanced journal.",
      );
      setFundResolutionMinor("");
      setFundResolutionReason("");
      const refreshResults = await Promise.allSettled([
        refreshUnclaimedFunds(operationScope),
        ...(item.clientAccountId === me.clientAccountId ? [refreshBilling()] : []),
      ]);
      if (!adminOperationRequestIsCurrent(operationScope, item.clientAccountId)) return;
      if (refreshResults.some((result) => result.status === "rejected")) {
        setError("The resolution was saved, but current balances could not be refreshed.");
      }
    } catch (caught) {
      if (adminOperationRequestIsCurrent(operationScope, item.clientAccountId)) {
        setError(caught instanceof Error ? caught.message : "Fund resolution failed");
      }
    } finally {
      fundResolutionInFlight.current.delete(item.receiptId);
      if (adminOperationRequestIsCurrent(operationScope, item.clientAccountId)) {
        setFundResolutionPendingReceiptIds((current) => {
          const next = new Set(current);
          next.delete(item.receiptId);
          return next;
        });
      }
    }
  }

  async function returnUnclaimedFunds(item: UnclaimedFundItem) {
    if (
      !canUseFullAdminRoute ||
      refundInFlight.current.has(item.receiptId) ||
      fundResolutionInFlight.current.has(item.receiptId)
    ) {
      return;
    }
    const operationScope = captureAdminOperationScope();
    if (!adminOperationRequestIsCurrent(operationScope, item.clientAccountId)) return;
    const amountMinor = fundReturnAmountMode === "partial" ? fundReturnAmountMinor : null;
    const reason = fundReturnReason.trim();
    const identity = JSON.stringify({
      sourceContext: "unclaimed_funds",
      receiptId: item.receiptId,
      amountMode: fundReturnAmountMode,
      amountMinor,
      expectedAvailableMinor: item.availableMinor,
      scenario: fundReturnScenario,
      reason,
    });
    refundInFlight.current.add(item.receiptId);
    setRefundPendingReceiptIds((current) => new Set(current).add(item.receiptId));
    setError("");
    try {
      const storageKey = await refundIntentStorageKey(identity);
      let storedKey: string | null = null;
      try {
        storedKey = window.localStorage.getItem(storageKey);
      } catch {
        storedKey = null;
      }
      const idempotencyKey =
        refundIntentKeys.current.get(identity) ?? storedKey ?? newIdempotencyKey();
      refundIntentKeys.current.set(identity, idempotencyKey);
      try {
        window.localStorage.setItem(storageKey, idempotencyKey);
      } catch {
        // The in-memory key still makes repeated clicks replay the same request.
      }
      if (!adminOperationRequestIsCurrent(operationScope, item.clientAccountId)) return;
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      if (!adminOperationRequestIsCurrent(operationScope, item.clientAccountId)) return;
      setAdminPassword("");
      if (!adminOperationRequestIsCurrent(operationScope, item.clientAccountId)) return;
      const refund = await api<RefundRecord>(
        `/api/v1/admin/funds/${item.receiptId}/refunds`,
        {
          method: "POST",
          body: JSON.stringify({
            amountMode: fundReturnAmountMode,
            amountMinor,
            expectedAvailableMinor: item.availableMinor,
            scenario: fundReturnScenario,
            reason,
            idempotencyKey,
          }),
        },
      );
      refundIntentKeys.current.delete(identity);
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // A retained key is safe: a later retry replays instead of returning funds twice.
      }
      if (!adminOperationRequestIsCurrent(operationScope, item.clientAccountId)) return;
      setRefundRecords((current) => ({ ...current, [refund.refundId]: refund }));
      setNotice(
        refund.replayed
          ? "The same unclaimed-funds return was replayed; no second Provider request was created."
          : "Return to the original payment requested. Funds remain reserved until the Provider result is known.",
      );
      setFundReturnAmountMinor("");
      setFundReturnReason("");
      await Promise.all([
        refreshUnclaimedFunds(operationScope),
        refreshRefundRecords(operationScope),
      ]);
      if (!adminOperationRequestIsCurrent(operationScope, item.clientAccountId)) return;
    } catch (caught) {
      if (adminOperationRequestIsCurrent(operationScope, item.clientAccountId)) {
        setError(caught instanceof Error ? caught.message : "Unclaimed-funds return failed");
      }
    } finally {
      refundInFlight.current.delete(item.receiptId);
      if (adminOperationRequestIsCurrent(operationScope, item.clientAccountId)) {
        setRefundPendingReceiptIds((current) => {
          const next = new Set(current);
          next.delete(item.receiptId);
          return next;
        });
      }
    }
  }

  async function decideRefund(
    item: RefundCandidate,
    destination: "original_payment" | "credit" | "none",
  ) {
    if (
      !canManageRefundsRoute ||
      refundInFlight.current.has(item.receiptId) ||
      (operationAccount !== null && item.clientAccountId !== operationAccount.id)
    ) return;
    const operationScope = captureAdminOperationScope();
    if (!adminOperationRequestIsCurrent(operationScope, item.clientAccountId)) return;
    const amountMode = destination === "none" ? "none" : refundAmountMode;
    const amountMinor =
      destination !== "none" && refundAmountMode === "partial" ? refundAmountMinor : null;
    const scenario = destination === "original_payment" ? refundScenario : null;
    const reason = refundReason.trim();
    const identity = JSON.stringify({
      invoiceId: item.invoiceId,
      receiptId: item.receiptId,
      destination,
      amountMode,
      amountMinor,
      scenario,
      reason,
    });
    refundInFlight.current.add(item.receiptId);
    setRefundPendingReceiptIds((current) => new Set(current).add(item.receiptId));
    setError("");
    try {
      const storageKey = await refundIntentStorageKey(identity);
      let storedKey: string | null = null;
      try {
        storedKey = window.localStorage.getItem(storageKey);
      } catch {
        storedKey = null;
      }
      const idempotencyKey =
        refundIntentKeys.current.get(identity) ?? storedKey ?? newIdempotencyKey();
      refundIntentKeys.current.set(identity, idempotencyKey);
      try {
        window.localStorage.setItem(storageKey, idempotencyKey);
      } catch {
        // The in-memory key still protects repeated clicks when storage is unavailable.
      }
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      if (
        !adminOperationRequestIsCurrent(operationScope, item.clientAccountId)
      ) return;
      setAdminPassword("");
      const refund = await api<RefundRecord>(
        `/api/v1/admin/invoices/${item.invoiceId}/refunds`,
        {
          method: "POST",
          body: JSON.stringify({
            receiptId: item.receiptId,
            destination,
            amountMode,
            amountMinor,
            expectedRefundableMinor: destination === "none" ? null : item.refundableMinor,
            scenario,
            reason,
            idempotencyKey,
          }),
        },
      );
      refundIntentKeys.current.delete(identity);
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // A retained key is safe: a later retry will replay instead of moving money twice.
      }
      if (
        !adminOperationRequestIsCurrent(operationScope, item.clientAccountId)
      ) return;
      setRefundRecords((current) => ({ ...current, [refund.refundId]: refund }));
      setNotice(
        refund.replayed
          ? "The same refund intent was replayed; no second Credit or Provider request was created."
          : destination === "credit"
            ? "Refund confirmed as Credit with one balanced journal."
            : destination === "none"
              ? "The audited no-refund decision was recorded without moving money."
              : "Original-payment refund requested. Provider confirmation remains separate.",
      );
      setRefundReason("");
      setRefundAmountMinor("");
      await Promise.all([
        refreshRefundCandidates(operationScope),
        ...(item.clientAccountId === me.clientAccountId ? [refreshBilling()] : []),
      ]);
      if (
        !adminOperationRequestIsCurrent(operationScope, item.clientAccountId)
      ) return;
    } catch (caught) {
      if (
        adminOperationRequestIsCurrent(operationScope, item.clientAccountId)
      ) {
        setError(caught instanceof Error ? caught.message : "Refund decision failed");
      }
    } finally {
      refundInFlight.current.delete(item.receiptId);
      if (
        adminOperationRequestIsCurrent(operationScope, item.clientAccountId)
      ) {
        setRefundPendingReceiptIds((current) => {
          const next = new Set(current);
          next.delete(item.receiptId);
          return next;
        });
      }
    }
  }

  async function adjudicateRefundHold(
    hold: RefundSecurityHold,
    decision:
      | "accept_authorized_outflow"
      | "record_unexpected_outflow"
      | "dismiss_provider_claim",
  ) {
    if (
      !canManageRefundsRoute ||
      refundAdjudicationInFlight.current.has(hold.holdId) ||
      (operationAccount !== null && hold.clientAccountId !== operationAccount.id)
    ) return;
    const operationScope = captureAdminOperationScope();
    if (!adminOperationRequestIsCurrent(operationScope, hold.clientAccountId)) return;
    const reason = refundReason.trim();
    const identity = JSON.stringify({ holdId: hold.holdId, decision, reason });
    refundAdjudicationInFlight.current.add(hold.holdId);
    setRefundAdjudicationPendingIds((current) => new Set(current).add(hold.holdId));
    setError("");
    try {
      const storageKey = await refundIntentStorageKey(`adjudication:${identity}`);
      let idempotencyKey: string | null = null;
      try {
        idempotencyKey = window.localStorage.getItem(storageKey);
      } catch {
        idempotencyKey = null;
      }
      idempotencyKey ??= newIdempotencyKey();
      try {
        window.localStorage.setItem(storageKey, idempotencyKey);
      } catch {
        // The server-side decision fingerprint still prevents duplicate adjudication.
      }
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      if (
        !adminOperationRequestIsCurrent(operationScope, hold.clientAccountId)
      ) return;
      setAdminPassword("");
      const result = await api<{ replayed: boolean }>(
        `/api/v1/admin/refund-security-holds/${hold.holdId}/adjudications`,
        {
          method: "POST",
          body: JSON.stringify({
            decision,
            reason,
            idempotencyKey,
            expectedRefundVersion: hold.refundVersion,
          }),
        },
      );
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // A retained key can only replay the same immutable adjudication.
      }
      if (
        !adminOperationRequestIsCurrent(operationScope, hold.clientAccountId)
      ) return;
      setNotice(
        result.replayed
          ? "The same hold adjudication was replayed; no second settlement or journal was created."
          : decision === "accept_authorized_outflow"
            ? "Authorized Provider outflow accepted; suspense was reclassified without reducing cash again."
            : decision === "record_unexpected_outflow"
              ? "Verified unexpected Provider outflow recorded in suspense without creating a refund settlement."
              : "Provider claim dismissed; immutable evidence remains and any suspense was compensated.",
      );
      setRefundReason("");
      await Promise.all([
        refreshRefundSecurityHolds(operationScope),
        refreshRefundDismissalCorrections(operationScope),
        refreshRefundReceiptCapacityIncidents(operationScope),
        refreshRefundCandidates(operationScope),
        refreshRefundRecords(operationScope),
      ]);
      if (
        !adminOperationRequestIsCurrent(operationScope, hold.clientAccountId)
      ) return;
    } catch (caught) {
      if (
        adminOperationRequestIsCurrent(operationScope, hold.clientAccountId)
      ) {
        setError(caught instanceof Error ? caught.message : "Refund hold adjudication failed");
      }
    } finally {
      refundAdjudicationInFlight.current.delete(hold.holdId);
      if (
        adminOperationRequestIsCurrent(operationScope, hold.clientAccountId)
      ) {
        setRefundAdjudicationPendingIds((current) => {
          const next = new Set(current);
          next.delete(hold.holdId);
          return next;
        });
      }
    }
  }

  async function recoverManualRefund(
    refund: RefundRecord,
    action: "retry_query" | "confirm_no_outflow",
  ) {
    if (
      !canManageRefundsRoute ||
      refundManualActionInFlight.current.has(refund.refundId) ||
      (operationAccount !== null &&
        refund.clientAccountId !== operationAccount.id)
    ) return;
    const operationScope = captureAdminOperationScope();
    if (!adminOperationRequestIsCurrent(operationScope, refund.clientAccountId)) return;
    const reason = refundReason.trim();
    const identity = JSON.stringify({
      refundId: refund.refundId,
      action,
      reason,
      expectedRefundVersion: refund.version,
    });
    refundManualActionInFlight.current.add(refund.refundId);
    setRefundManualActionPendingIds((current) => new Set(current).add(refund.refundId));
    setError("");
    try {
      const storageKey = await refundIntentStorageKey(`manual-action:${identity}`);
      let idempotencyKey: string | null = null;
      try {
        idempotencyKey = window.localStorage.getItem(storageKey);
      } catch {
        idempotencyKey = null;
      }
      idempotencyKey ??= newIdempotencyKey();
      try {
        window.localStorage.setItem(storageKey, idempotencyKey);
      } catch {
        // The stable in-flight identity and server key still protect the current action.
      }
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      if (
        !adminOperationRequestIsCurrent(operationScope, refund.clientAccountId)
      ) return;
      setAdminPassword("");
      const result = await api<{ replayed: boolean }>(
        `/api/v1/admin/refunds/${refund.refundId}/manual-actions`,
        {
          method: "POST",
          body: JSON.stringify({
            action,
            reason,
            idempotencyKey,
            expectedRefundVersion: refund.version,
          }),
        },
      );
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // A retained key can only replay this same manual action.
      }
      if (
        !adminOperationRequestIsCurrent(operationScope, refund.clientAccountId)
      ) return;
      setNotice(
        result.replayed
          ? "The same manual refund action was replayed; no duplicate query or decision occurred."
          : action === "retry_query"
            ? "Query-only Provider reconciliation scheduled; the refund create request will not be sent again."
            : "No Provider outflow was confirmed with an audited reason; a late success will still enter security hold.",
      );
      setRefundReason("");
      await Promise.all([
        refreshRefundRecords(operationScope),
        refreshRefundCandidates(operationScope),
        refreshRefundSecurityHolds(operationScope),
      ]);
      if (
        !adminOperationRequestIsCurrent(operationScope, refund.clientAccountId)
      ) return;
    } catch (caught) {
      if (
        adminOperationRequestIsCurrent(operationScope, refund.clientAccountId)
      ) {
        setError(caught instanceof Error ? caught.message : "Manual refund action failed");
      }
    } finally {
      refundManualActionInFlight.current.delete(refund.refundId);
      if (
        adminOperationRequestIsCurrent(operationScope, refund.clientAccountId)
      ) {
        setRefundManualActionPendingIds((current) => {
          const next = new Set(current);
          next.delete(refund.refundId);
          return next;
        });
      }
    }
  }

  async function correctDismissedRefundOutflow(item: RefundDismissalCorrection) {
    if (
      !canManageRefundsRoute ||
      refundCorrectionInFlight.current.has(item.adjudicationId) ||
      (operationAccount !== null && item.clientAccountId !== operationAccount.id)
    ) return;
    const operationScope = captureAdminOperationScope();
    if (!adminOperationRequestIsCurrent(operationScope, item.clientAccountId)) return;
    const reason = refundReason.trim();
    const identity = JSON.stringify({
      adjudicationId: item.adjudicationId,
      reason,
      expectedRefundVersion: item.refundVersion,
    });
    refundCorrectionInFlight.current.add(item.adjudicationId);
    setRefundCorrectionPendingIds((current) => new Set(current).add(item.adjudicationId));
    setError("");
    try {
      const storageKey = await refundIntentStorageKey(`dismissal-correction:${identity}`);
      let idempotencyKey: string | null = null;
      try {
        idempotencyKey = window.localStorage.getItem(storageKey);
      } catch {
        idempotencyKey = null;
      }
      idempotencyKey ??= newIdempotencyKey();
      try {
        window.localStorage.setItem(storageKey, idempotencyKey);
      } catch {
        // The stable server fingerprint still protects this correction.
      }
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      if (
        !adminOperationRequestIsCurrent(operationScope, item.clientAccountId)
      ) return;
      setAdminPassword("");
      const result = await api<{ replayed: boolean }>(
        `/api/v1/admin/refund-adjudications/${item.adjudicationId}/corrections`,
        {
          method: "POST",
          body: JSON.stringify({
            reason,
            idempotencyKey,
            expectedRefundVersion: item.refundVersion,
          }),
        },
      );
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // A retained key can only replay the same immutable correction.
      }
      if (
        !adminOperationRequestIsCurrent(operationScope, item.clientAccountId)
      ) return;
      setNotice(
        result.replayed
          ? "The same dismissal correction was replayed; cash and capacity were not reduced twice."
          : "The later-confirmed Provider outflow was restored to discrepancy suspense and same-currency refund capacity.",
      );
      setRefundReason("");
      await Promise.all([
        refreshRefundDismissalCorrections(operationScope),
        refreshRefundReceiptCapacityIncidents(operationScope),
        refreshRefundSecurityHolds(operationScope),
        refreshRefundCandidates(operationScope),
        refreshRefundRecords(operationScope),
      ]);
      if (
        !adminOperationRequestIsCurrent(operationScope, item.clientAccountId)
      ) return;
    } catch (caught) {
      if (
        adminOperationRequestIsCurrent(operationScope, item.clientAccountId)
      ) {
        setError(caught instanceof Error ? caught.message : "Refund dismissal correction failed");
      }
    } finally {
      refundCorrectionInFlight.current.delete(item.adjudicationId);
      if (
        adminOperationRequestIsCurrent(operationScope, item.clientAccountId)
      ) {
        setRefundCorrectionPendingIds((current) => {
          const next = new Set(current);
          next.delete(item.adjudicationId);
          return next;
        });
      }
    }
  }

  async function acknowledgeRefundReceiptCapacityIncident(
    incident: RefundReceiptCapacityIncident,
  ) {
    if (
      !canManageRefundsRoute ||
      refundCapacityAcknowledgementInFlight.current.has(incident.incidentId) ||
      (operationAccount !== null && incident.clientAccountId !== operationAccount.id)
    ) {
      return;
    }
    const operationScope = captureAdminOperationScope();
    if (!adminOperationRequestIsCurrent(operationScope, incident.clientAccountId)) return;
    const reason = refundReason.trim();
    const identity = JSON.stringify({
      incidentId: incident.incidentId,
      reason,
      expectedConfirmedCompensationMinor: incident.confirmedCompensationMinor,
      expectedOverageMinor: incident.overageMinor,
    });
    refundCapacityAcknowledgementInFlight.current.add(incident.incidentId);
    setRefundCapacityAcknowledgementPendingIds((current) =>
      new Set(current).add(incident.incidentId),
    );
    setError("");
    try {
      const storageKey = await refundIntentStorageKey(`capacity-acknowledgement:${identity}`);
      let idempotencyKey: string | null = null;
      try {
        idempotencyKey = window.localStorage.getItem(storageKey);
      } catch {
        idempotencyKey = null;
      }
      idempotencyKey ??= newIdempotencyKey();
      try {
        window.localStorage.setItem(storageKey, idempotencyKey);
      } catch {
        // The stable server fingerprint still protects this acknowledgement.
      }
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      if (
        !adminOperationRequestIsCurrent(operationScope, incident.clientAccountId)
      ) return;
      setAdminPassword("");
      const result = await api<{ replayed: boolean }>(
        `/api/v1/admin/refund-receipt-capacity-incidents/${incident.incidentId}/acknowledgements`,
        {
          method: "POST",
          body: JSON.stringify({
            reason,
            idempotencyKey,
            expectedConfirmedCompensationMinor: incident.confirmedCompensationMinor,
            expectedOverageMinor: incident.overageMinor,
          }),
        },
      );
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // A retained key can only replay the same acknowledgement.
      }
      if (
        !adminOperationRequestIsCurrent(operationScope, incident.clientAccountId)
      ) return;
      setNotice(
        result.replayed
          ? "The same receipt overage acknowledgement was replayed; no financial fact changed."
          : "Receipt overage acknowledged; manual financial recovery remains outstanding and visible.",
      );
      setRefundReason("");
      await Promise.all([
        refreshRefundReceiptCapacityIncidents(operationScope),
        refreshRefundCandidates(operationScope),
        refreshRefundRecords(operationScope),
      ]);
      if (
        !adminOperationRequestIsCurrent(operationScope, incident.clientAccountId)
      ) return;
    } catch (caught) {
      if (
        adminOperationRequestIsCurrent(operationScope, incident.clientAccountId)
      ) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Refund receipt capacity acknowledgement failed",
        );
      }
    } finally {
      refundCapacityAcknowledgementInFlight.current.delete(incident.incidentId);
      if (
        adminOperationRequestIsCurrent(operationScope, incident.clientAccountId)
      ) {
        setRefundCapacityAcknowledgementPendingIds((current) => {
          const next = new Set(current);
          next.delete(incident.incidentId);
          return next;
        });
      }
    }
  }

  function clearAdminOperationSelection() {
    adminOperationGeneration.current += 1;
    manualReceiptRequestGeneration.current += 1;
    adminOperationContextRef.current = null;
    setAdminOperationContext(null);
    setAdminPassword("");
    setManualReason("");
    manualReceiptClientAccountIdRef.current = "";
    setManualReceiptClientAccountId("");
    setManualReceiptReference("");
    setManualReceiptReceivedAt(defaultManualReceiptTime());
    setManualReceiptGrossMinor("10000");
    setManualReceiptFeeMinor("0");
    setManualReceiptReason("");
    setManualReceiptPending(false);
    setManualReceiptHistory([]);
    setManualReceiptTarget(null);
    setManualReceiptOutcome(null);
    setManualReceiptReversalTargetId(null);
    setManualReceiptReversalReason("");
    setManualReceiptReversalPendingId(null);
    setManualReceiptReversalOutcome(null);
    setRefundAmountMode("full");
    setRefundAmountMinor("");
    setRefundReason("");
    setRefundPendingReceiptIds(new Set());
    setRefundAdjudicationPendingIds(new Set());
    setRefundManualActionPendingIds(new Set());
    setRefundCorrectionPendingIds(new Set());
    setRefundCapacityAcknowledgementPendingIds(new Set());
    setFundResolutionPendingReceiptIds(new Set());
    refundInFlight.current.clear();
    refundAdjudicationInFlight.current.clear();
    refundManualActionInFlight.current.clear();
    refundCorrectionInFlight.current.clear();
    refundCapacityAcknowledgementInFlight.current.clear();
    fundResolutionInFlight.current.clear();
    refundPollInFlight.current.clear();
  }

  function selectedAdminAccountChanged(account: { id: string; name: string } | null) {
    const context = adminOperationContextRef.current;
    if (!context || context.account.id === account?.id) return;
    clearAdminOperationSelection();
    setNotice("");
  }

  function openAdminAccountAction(
    action: AdminAccountAction,
    account: { id: string; name: string },
  ) {
    if (route !== "/admin" || activeRouteRef.current !== "/admin") return;
    const authorized =
      (action === "manual_receipt" && canManageManualReceipts) ||
      (action === "refund" && canManageRefunds) ||
      (action === "ticket" && canManageStaffTickets) ||
      (action === "manual_fulfillment" && canManageManualFulfillment);
    if (!authorized) return;
    clearAdminOperationSelection();
    const context = { action, account };
    adminOperationContextRef.current = context;
    setAdminOperationContext(context);
    manualReceiptClientAccountIdRef.current = account.id;
    setManualReceiptClientAccountId(account.id);
    let selector = "";
    if (action === "manual_receipt") {
      selector = '[aria-label="Record manual receipt"]';
      setNotice(`Manual receipt target fixed to ${account.name}. Verify the account and load its history before recording money.`);
    } else if (action === "refund") {
      selector = '[aria-label="Manual refunds"]';
      setNotice(`Refund operations are fixed to ${account.name}; unrelated receipts and refund facts are hidden.`);
    } else if (action === "ticket") {
      selector = '[aria-label="Staff support tickets"]';
      setNotice(`Ticket operations are fixed to ${account.name}; unrelated conversations are hidden.`);
    } else {
      selector = '[aria-label="Manual fulfillment queue"]';
      setNotice(`Manual fulfillment is fixed to ${account.name}; unrelated services are hidden.`);
    }
    requestAnimationFrame(() => {
      document.querySelector(selector)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  return (
    <>
      <div className="lab-banner">{LAB_BANNER}</div>
      <header>
        <a className="brand" href="/" onClick={(event) => followRouteLink(event, "/")}>
          <span>OSS</span>
          OpenSales System
        </a>
        <nav className="app-nav" aria-label="Primary navigation">
          <a
            aria-current={route === "/" ? "page" : undefined}
            href="/"
            onClick={(event) => followRouteLink(event, "/")}
          >
            Home
          </a>
          <a
            aria-current={route === "/customer" ? "page" : undefined}
            href="/customer"
            onClick={(event) => followRouteLink(event, "/customer")}
          >
            Customer
          </a>
          <a
            aria-current={route === "/admin" ? "page" : undefined}
            href="/admin"
            onClick={(event) => followRouteLink(event, "/admin")}
          >
            Admin
          </a>
          <a
            aria-current={route === "/security" ? "page" : undefined}
            href="/security"
            onClick={(event) => followRouteLink(event, "/security")}
          >
            Security
          </a>
        </nav>
        <div className="header-actions">
          <button onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")}>
            {locale === "en" ? "简体中文" : "English"}
          </button>
          <span className={route === "/" ? "pill" : me?.eligible ? "pill good" : "pill"}>
            {route === "/"
              ? "Public access"
              : !sessionResolved
                ? "Checking session"
                : me
                  ? me.email
                  : "Guest"}
          </span>
          {route !== "/" && me && <button onClick={() => void logout()}>Sign out</button>}
        </div>
      </header>
      <main>
        <section className="hero" aria-label="Current workspace">
          <p className="eyebrow">
            {route === "/"
              ? "Public · Mock-only laboratory"
              : route === "/customer"
                ? "Customer workspace · Mock-only"
                : route === "/admin"
                  ? "Staff workspace · Mock-only"
                  : route === "/security"
                    ? "Shared User Security · Mock-only"
                    : "Identity recovery · Mock-only"}
          </p>
          <h1>
            {route === "/"
              ? "Customer, billing and service operations — without vendor lock-in."
              : route === "/customer"
                ? "Orders, billing, services and support in one customer workspace."
                : route === "/admin"
                  ? "Audited support, money and service operations for Staff."
                  : route === "/security"
                    ? "One identity security surface for Customer and Staff."
                    : "Complete a one-time identity link without exposing its secret."}
          </h1>
          <p>
            {route === "/"
              ? "Explore the synthetic catalog, create an account or sign in. Customer and Staff data stay inside their dedicated workspaces."
              : route === "/customer"
                ? "Continue the real Mock Provider journey: open tickets, manage billing and follow each order through service delivery."
                : route === "/admin"
                  ? "Public replies, internal notes, manual receipts, refunds and operational decisions remain explicit and reviewable."
                  : route === "/security"
                    ? "Manage password, verified email, optional TOTP, sessions and low-risk customer API keys with fresh authorization checks."
                    : "Tokens stay in memory only and are removed from the address bar before use."}
          </p>
        </section>

        {(notice || error) && (
          <div className={error ? "notice error" : "notice"}>
            {error || notice}
            <button onClick={() => (error ? setError("") : setNotice(""))}>×</button>
          </div>
        )}

        {loginChallenge && (
          <section className="route-access" aria-label="Login factor challenge" data-testid="login-factor-challenge">
            <p className="eyebrow">{locale === "zh-CN" ? "登录第二步" : "Sign-in second step"}</p>
            <h2>{locale === "zh-CN" ? "确认身份因子" : "Confirm an identity factor"}</h2>
            <p>{locale === "zh-CN" ? "输入当前 TOTP，或使用一条尚未使用的一次性恢复码。" : "Enter the current TOTP, or one unused single-use recovery code."}</p>
            <form onSubmit={completeLoginChallenge}>
              <label>{locale === "zh-CN" ? "TOTP / 恢复码" : "TOTP / recovery code"}<input name="factorCode" autoComplete="one-time-code" required /></label>
              <button className="primary" type="submit">{locale === "zh-CN" ? "完成登录" : "Complete sign in"}</button>
              <button type="button" onClick={() => setLoginChallenge(null)}>{locale === "zh-CN" ? "取消" : "Cancel"}</button>
            </form>
          </section>
        )}

        {route === "/security" && sessionResolved && (
          <SecurityPanel
            active
            authenticated={Boolean(
              me && me.verification.email === "passed" && !me.restrictions.user,
            )}
            customerApiEligible={Boolean(me?.clientAccountId && me?.context)}
            locale={locale}
            onNotice={showTicketNotice}
            onError={showTicketError}
          />
        )}

        {route === "/password-recovery" && (
          <PasswordRecoveryPage
            locale={locale}
            onNotice={showTicketNotice}
            onError={showTicketError}
          />
        )}

        {route === "/email-change" && sessionResolved && (
          <EmailChangePage
            authenticated={Boolean(
              me && me.verification.email === "passed" && !me.restrictions.user,
            )}
            locale={locale}
            onLogin={login}
            onCompleted={async () => { await refreshMe(); }}
            onNotice={showTicketNotice}
            onError={showTicketError}
          />
        )}

        {route === "/customer" && membershipInvitationToken && (
          <section className="route-access" aria-label="Membership invitation acceptance" data-testid="membership-invitation-acceptance">
            <p className="eyebrow">{locale === "zh-CN" ? "客户账户成员邀请" : "Client Account membership invitation"}</p>
            <h2>
              {!me
                ? locale === "zh-CN" ? "使用受邀邮箱登录" : "Sign in with the invited email"
                : invitationAcceptPending
                  ? locale === "zh-CN" ? "正在接受邀请…" : "Accepting the invitation…"
                  : invitationAcceptError
                    ? locale === "zh-CN" ? "邀请尚未接受" : "The invitation was not accepted"
                    : locale === "zh-CN" ? "正在检查邀请…" : "Checking this invitation…"}
            </h2>
            <p>
              {!me
                ? locale === "zh-CN"
                  ? "邀请令牌只保留在当前页面；请在下方登录，它不会复制到本地存储或日志。"
                  : "The invitation stays in this page only. Sign in below; it is never copied to local storage or logs."
                : invitationAcceptError || (locale === "zh-CN"
                  ? "未经明确选择，新成员关系不会替换当前客户账户。"
                  : "The new membership will not replace your active Client Account without an explicit selection.")}
            </p>
            {me && invitationAcceptError && (
              <button
                className="primary"
                disabled={invitationAcceptPending}
                onClick={() => setInvitationRetryNonce((value) => value + 1)}
              >
                {locale === "zh-CN" ? "重试接受邀请" : "Retry invitation acceptance"}
              </button>
            )}
          </section>
        )}

        {route === "/" && (
          <section className="account-grid" data-testid="public-access">
            <div className="panel">
              <p className="eyebrow">Access</p>
              <h2>Open a dedicated workspace</h2>
              <p>
                Customer and Staff sessions are handled only inside their dedicated pages. This
                public page never displays account or permission details.
              </p>
              <div className="workspace-actions">
                <a
                  className="route-action"
                  href="/customer"
                  onClick={(event) => followRouteLink(event, "/customer")}
                >
                  Open customer workspace
                </a>
                <a
                  className="route-action"
                  href="/admin"
                  onClick={(event) => followRouteLink(event, "/admin")}
                >
                  Open Admin workspace
                </a>
              </div>
              <div className="form-columns">
                <form onSubmit={register}>
                  <h3>{text.register}</h3>
                  <input name="clientName" placeholder="Client account name" required />
                  <input name="email" type="email" placeholder="Email" required />
                  <input
                    name="password"
                    type="password"
                    minLength={12}
                    placeholder="Password (12+ characters)"
                    required
                  />
                  <button className="primary" type="submit">
                    {text.register}
                  </button>
                </form>
                <form onSubmit={login}>
                  <h3>{text.login}</h3>
                  <input name="email" type="email" placeholder="Email" required />
                  <input name="password" type="password" placeholder="Password" required />
                  <button className="primary" type="submit">
                    {text.login}
                  </button>
                  <a
                    className="route-action"
                    href="/password-recovery"
                    onClick={(event) => followRouteLink(event, "/password-recovery")}
                  >
                    {locale === "zh-CN" ? "忘记密码？" : "Forgot password?"}
                  </a>
                </form>
              </div>
            </div>
          </section>
        )}

        {route === "/customer" && (
        <section className="account-grid">
          <div className="panel">
            <p className="eyebrow">{text.account}</p>
            {!sessionResolved ? (
              <p className="muted">Checking the current session…</p>
            ) : me ? (
              <>
                <h2>{me.email}</h2>
                <p>
                  {me.eligible
                    ? text.ready
                    : me.verification.email !== "passed"
                      ? text.pending
                      : me.restrictions.user
                        ? locale === "zh-CN"
                          ? "当前用户已受限。"
                          : "This user is restricted."
                        : !me.clientAccountId
                          ? locale === "zh-CN"
                            ? "请选择当前客户账户后继续。"
                            : "Select the active Client Account to continue."
                          : locale === "zh-CN"
                            ? "客户账户已受限；已保存的业务历史仍可读取。"
                            : "The Client Account is restricted; saved business history remains readable."}
                </p>
                <div className="status-row">
                  <span>Email verification</span>
                  <strong>{me.verification.email}</strong>
                </div>
                {me.verification.email !== "passed" && (
                  <>
                    <button className="primary" onClick={openLabMailbox}>
                      Open my Mock Provider mailbox
                    </button>
                    {mail.map((message) => {
                      const messageUrl = message.body.match(/https?:\/\/\S+/)?.[0];
                      let verificationUrl: string | null = null;
                      let isMembershipInvitation = false;
                      if (messageUrl) {
                        try {
                          const parsed = new URL(messageUrl, window.location.origin);
                          const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
                          if (pathname === "/verify") verificationUrl = messageUrl;
                          isMembershipInvitation = pathname === "/membership-invitations/accept";
                        } catch {
                          // Malformed Mock Provider links remain inert message facts.
                        }
                      }
                      return (
                        <div className="mock-message" key={message.id}>
                          <strong>{message.subject}</strong>
                          <span>
                            {message.status} · {new Date(message.deliveredAt).toLocaleString()}
                          </span>
                          {verificationUrl && (
                            <a
                              href={verificationUrl}
                              onClick={(event) => void verifyInvitationIdentity(event, verificationUrl)}
                            >
                              {locale === "zh-CN" ? "使用一次性验证链接" : "Use one-time verification link"}
                            </a>
                          )}
                          {isMembershipInvitation && (
                            <span className="muted">
                              {locale === "zh-CN" ? "当前成员邀请链接（无需重复打开）" : "Current membership invitation link (already open)"}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}
              </>
            ) : (
              <div className="form-columns">
                {membershipInvitationToken ? (
                  <form onSubmit={registerInvitationIdentity} data-testid="invitation-registration-form">
                    <h3>{locale === "zh-CN" ? "创建受邀用户身份" : "Create invited User identity"}</h3>
                    <p className="muted">
                      {locale === "zh-CN"
                        ? "此流程只创建用户身份，不会创建无关的客户账户。"
                        : "This creates only your User identity and no unrelated Client Account."}
                    </p>
                    <input
                      name="email"
                      type="email"
                      placeholder={locale === "zh-CN" ? "受邀邮箱" : "Invited email"}
                      required
                    />
                    <input
                      name="password"
                      type="password"
                      minLength={12}
                      placeholder={locale === "zh-CN" ? "密码（至少12个字符）" : "Password (12+ characters)"}
                      required
                    />
                    <button className="primary" type="submit">
                      {locale === "zh-CN" ? "创建受邀用户身份" : "Create invited identity"}
                    </button>
                  </form>
                ) : (
                  <form onSubmit={register}>
                    <h3>{text.register}</h3>
                    <input name="clientName" placeholder="Client account name" required />
                    <input name="email" type="email" placeholder="Email" required />
                    <input
                      name="password"
                      type="password"
                      minLength={12}
                      placeholder="Password (12+ characters)"
                      required
                    />
                    <button className="primary" type="submit">
                      {text.register}
                    </button>
                  </form>
                )}
                <form onSubmit={login}>
                  <h3>{text.login}</h3>
                  <input name="email" type="email" placeholder="Email" required />
                  <input name="password" type="password" placeholder="Password" required />
                  <button className="primary" type="submit">
                    {text.login}
                  </button>
                  <a
                    className="route-action"
                    href="/password-recovery"
                    onClick={(event) => followRouteLink(event, "/password-recovery")}
                  >
                    {locale === "zh-CN" ? "忘记密码？" : "Forgot password?"}
                  </a>
                </form>
              </div>
            )}
          </div>
        </section>
        )}

        {route === "/customer" &&
          sessionResolved &&
          me &&
          me.verification.email === "passed" &&
          !me.restrictions.user &&
          typeof me.accountContextVersion === "string" && (
          <AccountContextSwitcher
            active={route === "/customer"}
            viewerId={me.id}
            activeClientAccountId={me.clientAccountId}
            activeContext={me.context ? {
              clientAccountId: me.context.clientAccountId,
              name: me.context.name,
              role: me.context.role,
              permissions: me.context.permissions,
              capabilities: me.context.capabilities ?? [],
              restrictions: {
                membership: false,
                clientAccount: me.restrictions.clientAccount,
              },
            } : null}
            accountContextVersion={me.accountContextVersion}
            locale={locale}
            onSwitched={accountContextSwitched}
            onError={showTicketError}
          />
        )}

        {route === "/customer" && !me?.eligible && (
          <section className="route-access" aria-label="Customer access status">
            <p className="eyebrow">Customer access</p>
            <h2>
              {!me
                ? "Sign in to open the customer workspace"
                : me.verification.email !== "passed"
                  ? "Verify your email to continue"
                : me.restrictions.user
                    ? "This user is restricted"
                    : !me.clientAccountId
                      ? "Select an active Client Account"
                      : locale === "zh-CN" ? "购买与账户变更不可用" : "Purchases and account changes are unavailable"}
            </h2>
            <p>
              {!me
                ? "Use the account forms above. Successful sign-in returns directly to this customer page."
                : me.verification.email !== "passed"
                  ? "Customer billing, orders, services and support become available after the Mock Provider verification step above."
                  : me.restrictions.user
                    ? "This user cannot open account history or perform customer actions while the user restriction remains active."
                    : !me.clientAccountId
                      ? "Choose an unrestricted membership above. No customer account data is loaded until that choice is explicit."
                      : locale === "zh-CN"
                        ? "客户账户限制会阻止商业、账单与账户变更；已保存历史和支持工单通道仍可继续使用。"
                        : "The Client Account restriction prevents commerce, billing and account changes. Saved history and the support-ticket lifeline remain available below."}
            </p>
          </section>
        )}

        {route === "/admin" && !sessionResolved && (
          <section className="route-access" aria-label="Administrator session status">
            <p className="eyebrow">Restricted Staff workspace</p>
            <h2>Checking Staff access…</h2>
            <p>The administrative workspace remains unmounted until the current session is resolved.</p>
          </section>
        )}

        {route === "/admin" && sessionResolved && !canOpenAdminWorkspace && (
          <section
            className="route-access restricted-access"
            aria-label="Administrator access status"
            data-testid="admin-access-restricted"
          >
            <p className="eyebrow">Restricted Staff workspace</p>
            <h2>
              {!me
                ? "Sign in required"
                : !staffIdentityEligible
                  ? "Access denied — verified, unrestricted Staff User required"
                  : "Access denied — Staff permission required"}
            </h2>
            <p>
              {!me
                ? "Sign in with an authorized Staff account. No administrative capability is shown to guests."
                : !staffIdentityEligible
                  ? `${me.email} is not currently eligible. No administrative capability has been loaded on this page.`
                  : `${me.email} has no recognized Staff permission for this workspace. No administrative capability has been loaded.`}
            </p>
            {!me && (
              <form className="admin-login-form" onSubmit={login}>
                <label>
                  Staff email
                  <input name="email" type="email" placeholder="Staff email" required />
                </label>
                <label>
                  Password
                  <input name="password" type="password" placeholder="Staff password" required />
                </label>
                <button className="primary" type="submit">Sign in to Staff workspace</button>
                <a
                  className="route-action"
                  href="/password-recovery"
                  onClick={(event) => followRouteLink(event, "/password-recovery")}
                >
                  Forgot password?
                </a>
              </form>
            )}
            <a className="route-action" href="/" onClick={(event) => followRouteLink(event, "/")}>
              Go to public sign in
            </a>
          </section>
        )}

        {route === "/customer" && sessionResolved && canReadCustomerHistory && me && (
          <CustomerBusinessHistory
            key={`${me.id}:${me.clientAccountId}:${me.accountContextVersion}`}
            active={route === "/customer"}
            canReadHistory={canReadCustomerHistory}
            canManageServices={canManageServices}
            clientAccountId={me.clientAccountId}
            locale={locale}
            onNotice={showTicketNotice}
            onError={showTicketError}
          />
        )}

        {route === "/customer" && sessionResolved && canReadCustomerNotificationHistory && me?.context && (
          <NotificationDeliveryHistory
            active={route === "/customer"}
            endpoint="/api/v1/customer/notification-deliveries"
            accountId={me.context.clientAccountId}
            scopeKey={`${me.id}:${me.context.clientAccountId}:${me.context.version}`}
            refreshKey={me.context.version}
            locale={locale}
            variant="customer"
            onError={showTicketError}
          />
        )}

        {route === "/customer" && sessionResolved && canReadCustomerHistory && me?.context && (
          <AccountAccessPanel
            active={route === "/customer"}
            viewerId={me.id}
            accountId={me.context.clientAccountId}
            accountName={me.context.name}
            role={me.context.role}
            capabilities={me.context.capabilities ?? []}
            contextVersion={me.context.version}
            writeEligible={me.eligible}
            locale={locale}
            onNotice={showTicketNotice}
            onError={showTicketError}
            onSelfMembershipChanged={accountContextSwitched}
          />
        )}

        {route === "/admin" && sessionResolved && canViewAccount360 && me && (
          <AdminAccount360
            active={route === "/admin"}
            accessFingerprint={staffAccessFingerprint}
            permissions={staffPermissions}
            locale={locale}
            availableActions={account360Actions}
            onAction={openAdminAccountAction}
            onSelectedAccountChange={selectedAdminAccountChanged}
            onRefreshAccess={async () => { await refreshMe(); }}
            onNotice={showTicketNotice}
            onError={showTicketError}
          />
        )}

        {route === "/admin" && sessionResolved && canManageServiceOperations && (
          <AdminServiceOperationsQueue
            active={route === "/admin"}
            locale={locale}
            onNotice={setNotice}
            onError={setError}
          />
        )}

        {route === "/customer" && (
          <TicketsPanel
            mode="customer"
            canUseCustomerSupport={canUseCustomerSupport}
            canWriteCustomerSupport={canWriteCustomerSupport}
            me={me}
            locale={locale}
            onNotice={showTicketNotice}
            onError={showTicketError}
          />
        )}

        {route === "/admin" && sessionResolved && canManageStaffTickets && (
          <TicketsPanel
            mode="staff"
            canManageTickets={canManageStaffTickets}
            staffAccessFingerprint={staffAccessFingerprint}
            staffAccountContext={operationAccount}
            requireStaffAccountContext={!canUseFullAdminWorkspace && canViewAccount360}
            me={me}
            locale={locale}
            onNotice={showTicketNotice}
            onError={showTicketError}
          />
        )}

        {route === "/admin" && canOpenAdminWorkspace && !canUseFullAdminWorkspace && (
          <section className="route-access" data-testid="limited-admin-scope">
            <p className="eyebrow">Permission-scoped Staff workspace</p>
            <h2>Permission-scoped operations</h2>
            <p>
              This Staff session loads only its explicitly permitted Account 360, support and
              operation panels. Other billing, money and service administration stays unmounted
              and is not requested.
            </p>
          </section>
        )}

        {route === "/customer" &&
          me &&
          chargebackStatus &&
          (chargebackStatus.chargebacks.length > 0 ||
            chargebackStatus.unclaimedChargebacks.length > 0 ||
            chargebackStatus.manualHolds.length > 0) && (
            <section className="order-panel" aria-label="Chargeback account status">
              <div>
                <p className="eyebrow">Customer billing · Mock Chargeback</p>
                <h2>
                  {chargebackStatus.restricted
                    ? "Client Account restricted after Chargeback"
                    : "Chargeback history"}
                </h2>
                <p>
                  Available Credit <strong>{usd(chargebackStatus.creditBalanceMinor)}</strong> ·
                  outstanding Chargeback debt {" "}
                  <strong>{usd(chargebackStatus.debtBalanceMinor)}</strong>. Original payments,
                  paid invoices, allocations and delivered services remain historical facts.
                </p>
              </div>
              <div data-testid="customer-chargeback-list">
                {chargebackStatus.chargebacks.map((chargeback) => (
                  <article
                    className="manual-item security-hold-item"
                    data-testid="customer-chargeback"
                    key={chargeback.chargebackEffectId}
                  >
                    <div>
                      <strong>
                        External loss {usd(chargeback.externalAmountMinor)} · debt {" "}
                        {usd(chargeback.debtMinor)}
                      </strong>
                      <span>
                        Credit recovered {usd(chargeback.creditRecoveredMinor)} · original fee
                        reversed {usd(chargeback.feeMinor)}
                      </span>
                      <span>
                        Account restriction: {chargeback.restrictionActive ? "active" : "not active"}
                      </span>
                      <span className="mono">
                        {chargeback.originalExternalPaymentId} · {chargeback.externalChargebackId}
                      </span>
                    </div>
                  </article>
                ))}
                {chargebackStatus.unclaimedChargebacks.map((chargeback) => (
                  <article
                    className="manual-item security-hold-item"
                    data-testid="customer-unclaimed-chargeback"
                    key={chargeback.unclaimedChargebackEffectId}
                  >
                    <div>
                      <strong>
                        Unclaimed payment reversed {usd(chargeback.externalAmountMinor)}
                      </strong>
                      <span>No Credit or debt was created from these returned funds.</span>
                      <span className="mono">
                        {chargeback.originalExternalPaymentId} · {chargeback.externalChargebackId}
                      </span>
                    </div>
                  </article>
                ))}
                {chargebackStatus.manualHolds.map((hold) => (
                  <article
                    className="manual-item security-hold-item"
                    data-testid="customer-chargeback-hold"
                    key={hold.holdId}
                  >
                    <div>
                      <strong>Chargeback fact requires staff review</strong>
                      <span>{hold.reason}</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

        {route === "/customer" && canReadCustomerHistory && paymentSettings && (
          <section className="order-panel" aria-label="Payment methods and automatic renewal">
            <div>
              <p className="eyebrow">Customer billing · payment permissions</p>
              <h2>Payment methods & automatic renewal</h2>
              <p className="muted">
                Saving a Provider token, choosing a default, and authorizing a service for automatic
                renewal are separate choices. All are off until you explicitly enable them. An
                authorized service is charged when its renewal invoice is created (normally 14 days
                before term end), including the displayed payment-method fee, with at most one
                background attempt; customer action or failure stops background charging.
              </p>
            </div>
            {!canWriteBilling ? (
              <p className="notice" data-testid="payment-settings-read-only">
                {locale === "zh-CN"
                  ? me?.restrictions.clientAccount
                    ? "客户账户当前受限；已保存的付款方式与自动续费状态仅供查看，不能更改。"
                    : "当前成员权限仅允许查看付款方式与自动续费状态，不能更改。"
                  : me?.restrictions.clientAccount
                    ? "The Client Account is restricted. Saved payment methods and automatic-renewal status are read-only."
                    : "This membership can view payment methods and automatic-renewal status but cannot change them."}
              </p>
            ) : paymentSettingsReauthActive ? (
              <p className="muted" data-testid="payment-settings-reauth-active">
                Password confirmed until {new Date(paymentSettingsReauthExpiresAt!).toLocaleTimeString()}.
                This fixed window does not extend when you make another change.
              </p>
            ) : (
              <label>
                Confirm your password for payment-setting changes (fixed 15-minute window)
                <input
                  data-testid="payment-settings-password"
                  type="password"
                  autoComplete="current-password"
                  value={paymentSettingsPassword}
                  onChange={(event) => setPaymentSettingsPassword(event.target.value)}
                />
              </label>
            )}
            {paymentSettings.methods.length === 0 ? (
              <p className="muted" data-testid="no-saved-payment-methods">
                No saved payment method. Paying an invoice does not save one unless the separate
                checkbox is selected.
              </p>
            ) : (
              <div className="manual-list" data-testid="saved-payment-method-list">
                {paymentSettings.methods.map((method) => {
                  const activeAuthorization = paymentSettings.automaticRenewals.find(
                    (authorization) =>
                      authorization.serviceId === order?.service.id &&
                      authorization.status === "active",
                  );
                  const canAuthorizeCurrentService = Boolean(
                    order &&
                      ["active", "suspended"].includes(order.service.status) &&
                      order.order.price.billingCycle !== "one_time" &&
                      !order.service.cancellation &&
                      method.status === "active",
                  );
                  return (
                    <article className="manual-item" key={method.id} data-testid="saved-payment-method">
                      <strong>
                        {method.brand} · {method.instrumentType} ending {method.lastFour}
                        {method.default ? " · default" : ""}
                      </strong>
                      <span>
                        Expires {method.expiryMonth ?? "—"}/{method.expiryYear ?? "—"} · status {method.status}
                      </span>
                      <span>
                        Saved with consent {method.consentVersion} at {new Date(method.savedAt).toLocaleString()}
                      </span>
                      {canWriteBilling && <div className="fund-actions">
                        {!method.default && (
                          <button
                            disabled={paymentSettingsPending || !paymentSettingsReauthReady}
                            onClick={() => void makePaymentMethodDefault(method)}
                          >
                            Set as default only
                          </button>
                        )}
                        <button
                          disabled={paymentSettingsPending || !paymentSettingsReauthReady}
                          onClick={() => void removeSavedPaymentMethod(method)}
                        >
                          Remove and revoke linked automatic renewals
                        </button>
                        {canAuthorizeCurrentService &&
                          activeAuthorization?.savedPaymentMethodId !== method.id && (
                            <button
                              className="primary"
                              disabled={paymentSettingsPending || !paymentSettingsReauthReady}
                              onClick={() => void enableServiceAutomaticRenewal(method)}
                            >
                              {activeAuthorization
                                ? "Replace this service’s automatic-renewal method"
                                : "Enable automatic renewal for current service"}
                            </button>
                          )}
                      </div>}
                    </article>
                  );
                })}
              </div>
            )}
            {paymentSettings.pendingAutomaticRenewals.length > 0 && (
              <div className="manual-list" data-testid="pending-automatic-renewal-consents">
                {paymentSettings.pendingAutomaticRenewals.map((pending) => (
                  <article className="manual-item" key={pending.paymentAttemptId}>
                    <strong>{pending.productName} · automatic-renewal consent pending</strong>
                    <span>
                      Payment {pending.paymentStatus} · consent {pending.consentVersion} · requested {" "}
                      {new Date(pending.requestedAt).toLocaleString()}
                    </span>
                    <span>
                      Withdrawing this consent does not cancel the invoice payment; it only prevents a
                      late payment result from enabling future off-session charges.
                    </span>
                    {canWriteBilling && (
                      <button
                        disabled={paymentSettingsPending || !paymentSettingsReauthReady}
                        onClick={() => void revokePendingAutomaticRenewal(pending)}
                      >
                        Withdraw pending automatic-renewal consent
                      </button>
                    )}
                  </article>
                ))}
              </div>
            )}
            <div data-testid="automatic-renewal-authorizations">
              {paymentSettings.automaticRenewals
                .filter(
                  (authorization) =>
                    authorization.status === "active" ||
                    authorization.latestAutomaticPaymentStatus !== null,
                )
                .map((authorization) => (
                  <article className="manual-item" key={authorization.id}>
                    <strong>
                      {authorization.productName} · automatic renewal {authorization.status}
                    </strong>
                    <span>
                      Consent {authorization.consentVersion} · granted {new Date(authorization.grantedAt).toLocaleString()}
                    </span>
                    {authorization.latestAutomaticPaymentStatus && (
                      <span>
                        Latest automatic payment: {authorization.latestAutomaticPaymentStatus}
                        {authorization.status === "revoked" &&
                        ["processing", "unknown"].includes(
                          authorization.latestAutomaticPaymentStatus,
                        )
                          ? " — already dispatched and still reconciling; it may still settle"
                          : ""}
                      </span>
                    )}
                    {canWriteBilling && authorization.status === "active" && (
                      <button
                        disabled={paymentSettingsPending || !paymentSettingsReauthReady}
                        onClick={() => void revokeServiceAutomaticRenewal(authorization)}
                      >
                        Revoke automatic renewal
                      </button>
                    )}
                  </article>
                ))}
            </div>
          </section>
        )}

        {route === "/customer" && canReadCustomerHistory && renewals.length > 0 && (
          <section className="order-panel" aria-label="Service renewals">
            <div>
              <p className="eyebrow">Customer billing · renewals</p>
              <h2>Renewal invoices and paid-through dates</h2>
              <p>
                Renewal periods start at the current paid-through time. Paying early, late or after
                a reminder does not shorten or silently extend that fixed period.
              </p>
              <button onClick={() => void openLabMailbox()}>Open my Mock Provider mailbox</button>
            </div>
            <div data-testid="renewal-list">
              {renewals.map((renewal) => (
                <article className="manual-item" data-testid="renewal-item" key={renewal.renewalId}>
                  <div>
                    <strong>
                      {renewal.productName} · funding {renewal.fundingStatus} · term grant {" "}
                      {renewal.renewalStatus}
                    </strong>
                    <span>
                      Invoice {renewal.invoiceId} · due {new Date(renewal.dueAt).toLocaleString()}
                    </span>
                    <span>
                      Period {new Date(renewal.periodStart).toLocaleString()} → {" "}
                      {new Date(renewal.periodEnd).toLocaleString()}
                    </span>
                    <span>
                      Total {usd(renewal.totalMinor)} · allocated {usd(renewal.allocatedMinor)} · {" "}
                      due <strong>{usd(renewal.dueMinor)}</strong>
                    </span>
                    <span>
                      Service {renewal.serviceStatus} · current paid-through {" "}
                      {new Date(renewal.termEnd).toLocaleString()}
                    </span>
                    {renewal.renewalStatus === "manual_hold" && (
                      <span className="notice error">
                        Funds are recorded, but this renewal needs staff review and the service term
                        was not extended.
                      </span>
                    )}
                    {renewal.renewalStatus === "cancelled" && (
                      <span className="notice" data-testid="renewal-cancelled">
                        {locale === "zh-CN"
                          ? "账期末取消被接受后，这张续费发票已撤回。原始开票记录仍保留，应收金额为零，反向分录作为独立账务事实保存。"
                          : "This renewal invoice was withdrawn when cycle-end cancellation was accepted. Its issuance remains in history, collectible due is zero, and the reversal is a separate ledger fact."}
                      </span>
                    )}
                    {renewal.lateFee && (
                      <span data-testid="renewal-late-fee">
                        Late Fee {renewal.lateFee.disposition}: {usd(renewal.lateFee.amountMinor)}
                        {" "}on eligible unpaid basis {usd(renewal.lateFee.basisMinor)} at {" "}
                        {(renewal.lateFee.basisPoints / 100).toFixed(2)}% · assessed {" "}
                        {renewal.lateFee.businessDate}
                      </span>
                    )}
                    {renewal.paymentReconciliationHold.active && (
                      <span className="notice" data-testid="renewal-payment-reconciliation-hold">
                        Payment result is still being reconciled. No new Late Fee or suspension is
                        applied while the result remains unknown.
                      </span>
                    )}
                    {renewal.automaticPayment && (
                      <span
                        className={renewal.automaticPayment.customerActionRequired ? "notice" : undefined}
                        data-testid="renewal-automatic-payment-status"
                      >
                        Automatic payment {renewal.automaticPayment.status} · attempt {renewal.automaticPayment.attemptCount}/{renewal.automaticPayment.maxAttempts}
                        {renewal.automaticPayment.customerActionRequired
                          ? " · customer confirmation is required; background retries stopped. Pay this renewal manually below."
                          : renewal.automaticPayment.lastError
                            ? ` · ${renewal.automaticPayment.lastError}`
                            : ""}
                      </span>
                    )}
                    {renewal.delinquency && (
                      <span data-testid="renewal-delinquency-status">
                        Overdue action {renewal.delinquency.action} · {renewal.delinquency.status}
                        {renewal.delinquency.resumeRequired ? " · restore required after reconciliation" : ""}
                        {renewal.delinquency.lastError
                          ? ` · staff attention: ${renewal.delinquency.lastError}`
                          : ""}
                      </span>
                    )}
                    <span>
                      Reminders: {" "}
                      {renewal.reminders.length === 0
                        ? "none yet"
                        : renewal.reminders
                            .map((reminder) => `${reminderLabel(reminder)} (${reminder.status})`)
                            .join(", ")}
                    </span>
                  </div>
                  {canWriteBilling && renewal.status !== "paid" && renewal.status !== "cancelled" && (
                    <div className="fund-actions">
                      <select
                        aria-label={`Renewal payment method ${renewal.invoiceId}`}
                        value={paymentMethod}
                        onChange={(event) => setPaymentMethod(event.target.value)}
                      >
                        {(billing?.paymentMethods ?? []).map((method) => (
                          <option key={method.code} value={method.code}>
                            {method.name} · {(method.feeBasisPoints / 100).toFixed(2)}%
                          </option>
                        ))}
                      </select>
                      <label>
                        <input
                          type="checkbox"
                          checked={applyCredit}
                          onChange={(event) => setApplyCredit(event.target.checked)}
                        />
                        Apply Credit
                      </label>
                      <select
                        aria-label={`Renewal Provider scenario ${renewal.invoiceId}`}
                        value={paymentScenario}
                        onChange={(event) => setPaymentScenario(event.target.value)}
                      >
                        <option value="success">Success</option>
                        <option value="failed">Failure</option>
                        <option value="cancelled">Cancelled</option>
                        <option value="timeout_success">Timeout but actually settled</option>
                        <option value="duplicate_out_of_order">Duplicate + out of order</option>
                      </select>
                      <button
                        className="primary"
                        disabled={renewalPaymentPendingId !== null}
                        onClick={() => void startRenewalPayment(renewal)}
                      >
                        {renewalPaymentPendingId === renewal.renewalId
                          ? "Confirming payment…"
                          : "Pay renewal with Mock Provider"}
                      </button>
                    </div>
                  )}
                </article>
              ))}
              {mail
                .filter((message) => message.subject.toLowerCase().includes("renewal") || message.subject.includes("续费"))
                .map((message) => (
                  <article className="mock-message" key={message.id}>
                    <strong>{message.subject}</strong>
                    <span>
                      {message.status} · {new Date(message.deliveredAt).toLocaleString()}
                    </span>
                    <span>{message.body}</span>
                  </article>
                ))}
            </div>
          </section>
        )}

        {route === "/customer" && canWriteBilling && billing?.addFunds.enabled && (
          <section className="order-panel" aria-label="Add Funds">
            <div>
              <p className="eyebrow">Customer billing · Mock Add Funds</p>
              <h2>Add usable Credit after verified settlement</h2>
              <p>
                Current Credit <strong>{usd(billing.creditBalanceMinor)}</strong> · configured cap{" "}
                <strong>{usd(billing.addFunds.balanceCapMinor)}</strong>. Funds that arrive late,
                partially or with different facts require staff review and are not spendable.
              </p>
            </div>
            {billing.addFunds.allowed ? (
              <div className="payment-controls">
                <label>
                  Principal amount
                  <input
                    aria-label="Add Funds principal in cents"
                    inputMode="numeric"
                    value={addFundsPrincipalMinor}
                    onChange={(event) => setAddFundsPrincipalMinor(event.target.value)}
                  />
                </label>
                <select
                  aria-label="Add Funds payment method"
                  value={addFundsMethod}
                  onChange={(event) => setAddFundsMethod(event.target.value)}
                >
                  {billing.paymentMethods
                    .filter((method) => method.addFundsEnabled)
                    .map((method) => (
                      <option key={method.code} value={method.code}>
                        {method.name} · {(method.feeBasisPoints / 100).toFixed(2)}%
                      </option>
                    ))}
                </select>
                <select
                  aria-label="Add Funds Provider scenario"
                  value={addFundsScenario}
                  onChange={(event) => setAddFundsScenario(event.target.value)}
                >
                  <option value="success">Success</option>
                  <option value="failed">Failure</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="timeout_success">Timeout but actually settled</option>
                  <option value="duplicate_out_of_order">Duplicate + out of order</option>
                  <option value="partial">Partial arrival — manual review</option>
                  <option value="partial_then_reject">
                    Partial callback then rejected response — manual review
                  </option>
                  <option value="partial_then_timeout">
                    Partial callback then timeout — manual review
                  </option>
                  <option value="wrong_currency">Wrong currency — manual review</option>
                  <option value="expired_late">Late after expiry — manual review</option>
                  <option value="late_success">Success occurred after expiry — manual review</option>
                </select>
                {addFundsQuote ? (
                  <div className="quote-summary" data-testid="add-funds-quote">
                    <span>Principal added to Credit: {usd(addFundsQuote.principalMinor)}</span>
                    <span>Payment fee: {usd(addFundsQuote.feeMinor)}</span>
                    <strong>External amount due: {usd(addFundsQuote.externalDueMinor)}</strong>
                    <span>Quote expires {new Date(addFundsQuote.expiresAt).toLocaleTimeString()}</span>
                  </div>
                ) : (
                  <p className="muted">
                    Enter {usd(billing.addFunds.minimumMinor)} to{" "}
                    {usd(billing.addFunds.maximumMinor)} without exceeding the balance cap.
                  </p>
                )}
                <button
                  className="primary"
                  disabled={!addFundsQuote}
                  onClick={startAddFunds}
                >
                  Start Mock Add Funds
                </button>
                {addFundsCommand && (
                  <div data-testid="add-funds-status">
                    <div className="journey">
                      <Status label="Add Funds" value={addFundsCommand.status} />
                      <Status label="Payment" value={addFundsCommand.attemptStatus} />
                      <Status
                        label="Provider"
                        value={addFundsCommand.providerOperationStatus ?? "queued"}
                      />
                      <Status
                        label="Credit result"
                        value={
                          addFundsCommand.status === "succeeded"
                            ? `credited ${usd(addFundsCommand.principalMinor)}`
                            : addFundsCommand.status === "manual"
                              ? "needs review"
                              : "not credited"
                        }
                      />
                    </div>
                    {addFundsCommand.status === "manual" && (
                      <p className="notice error">
                        Funds received but not credited. Staff review is required.
                        {typeof addFundsCommand.result?.reason === "string"
                          ? ` ${addFundsCommand.result.reason}`
                          : ""}
                        {typeof addFundsCommand.result?.receiptId === "string"
                          ? ` Receipt ${addFundsCommand.result.receiptId}`
                          : ""}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <p>Billing or Owner permission is required to add funds.</p>
            )}
          </section>
        )}

        {route === "/admin" && sessionResolved && canMountAdminOperationWorkspace && me && (
          <section
            className="admin-panel"
            data-testid={
              canUseFullAdminWorkspace
                ? "full-admin-workspace"
                : "permission-admin-operations"
            }
          >
            {!canUseFullAdminWorkspace && (
              <div data-testid="permission-operation-reauth">
                <p className="eyebrow">Permission-scoped audited operation</p>
                <h2>Authorized account operation</h2>
                {operationAccount ? (
                  <p className="notice" data-testid="admin-operation-account-context">
                    Fixed Client Account: {operationAccount.name} · {operationAccount.id}
                  </p>
                ) : canViewAccount360 ? (
                  <p className="muted" data-testid="admin-operation-account-required">
                    Select a Client Account in Account 360 and choose the required operation.
                  </p>
                ) : (
                  <p className="muted">
                    This permission can operate its complete queue. Account 360 filtering is not
                    available without accounts.view.
                  </p>
                )}
                <input
                  aria-label="Operation password confirmation"
                  type="password"
                  value={adminPassword}
                  onChange={(event) => setAdminPassword(event.target.value)}
                  placeholder="Re-enter password (15-minute fixed window)"
                />
              </div>
            )}
            {canUseFullAdminWorkspace && (
              <>
            <div>
              <p className="eyebrow">Administrator · audited billing and fulfillment</p>
              <h2>Credit adjustment and human Ready decisions</h2>
            </div>
            <div className="inline-form admin-confirm">
              <input
                type="password"
                value={adminPassword}
                onChange={(event) => setAdminPassword(event.target.value)}
                placeholder="Re-enter password (15-minute fixed window)"
              />
              <input
                inputMode="numeric"
                value={creditAdjustmentMinor}
                onChange={(event) => setCreditAdjustmentMinor(event.target.value)}
                placeholder="Credit amount in cents"
              />
              <input
                value={creditAdjustmentReason}
                onChange={(event) => setCreditAdjustmentReason(event.target.value)}
                placeholder="Credit adjustment reason (10+ characters)"
              />
              <button
                className="primary"
                disabled={
                  adminPassword.length === 0 ||
                  !/^[1-9]\d*$/.test(creditAdjustmentMinor) ||
                  creditAdjustmentReason.trim().length < 10
                }
                onClick={() => adjustCredit("increase")}
              >
                Increase Credit
              </button>
              <button
                disabled={
                  adminPassword.length === 0 ||
                  !/^[1-9]\d*$/.test(creditAdjustmentMinor) ||
                  creditAdjustmentReason.trim().length < 10
                }
                onClick={() => adjustCredit("decrease")}
              >
                Decrease Credit
              </button>
            </div>
            <p>
              Current customer Credit: <strong>{usd(billing?.creditBalanceMinor ?? "0")}</strong>
            </p>
            <div className="admin-subsection" aria-label="Renewal billing automation">
              <div>
                <p className="eyebrow">Manual laboratory billing run · Asia/Shanghai</p>
                <h3>Renewal, Late Fee and service state automation</h3>
                <p>
                  This run creates the next non-overlapping invoice 14 days before paid-through and
                  queues the configured reminders. On Shanghai calendar day 5 it assesses one 10%
                  Late Fee only on eligible unpaid charges, then queues suspension only when both
                  the product policy and Provider explicitly allow suspend and resume. The laboratory
                  time override is synthetic acceptance control, not a production clock setting. The
                  durable Worker runs the policy once at or after 09:00 Asia/Shanghai and catches up
                  safely after a restart; repeated scheduling returns the existing business-day run.
                </p>
              </div>
              <div className="inline-form admin-confirm">
                <input
                  type="datetime-local"
                  aria-label="Laboratory billing effective time"
                  value={automationEffectiveAt}
                  onChange={(event) => setAutomationEffectiveAt(event.target.value)}
                />
                <input
                  value={automationReason}
                  onChange={(event) => setAutomationReason(event.target.value)}
                  placeholder="Automation run reason (10+ characters)"
                />
                <button
                  className="primary"
                  disabled={adminPassword.length === 0 || automationReason.trim().length < 10}
                  onClick={() => void runBillingAutomation()}
                >
                  Run billing day
                </button>
                <button onClick={() => void refreshAdminRenewals()}>Refresh renewals</button>
              </div>
              <div className="inline-form admin-confirm">
                <input
                  aria-label="Renewal Hold resolution reason"
                  value={renewalHoldReason}
                  onChange={(event) => setRenewalHoldReason(event.target.value)}
                  placeholder="Funded Hold review reason (10+ characters)"
                />
                <input
                  aria-label="Manual suspension or restoration reason"
                  value={manualSuspensionReason}
                  onChange={(event) => setManualSuspensionReason(event.target.value)}
                  placeholder="Manual service state reason (10+ characters)"
                />
              </div>
              {adminRenewals.length === 0 ? (
                <p className="muted">No generated renewal invoice is currently visible.</p>
              ) : (
                <div data-testid="admin-renewal-list">
                  {adminRenewals.map((renewal) => (
                    <article
                      className="manual-item"
                      data-testid="admin-renewal-item"
                      key={renewal.renewalId}
                    >
                      <div>
                        <strong>
                          {renewal.clientAccountName} · {renewal.productName} · {renewal.status}
                        </strong>
                        <span>
                          Invoice {renewal.invoiceId} · {usd(renewal.dueMinor)} due {" "}
                          {new Date(renewal.dueAt).toLocaleString()}
                        </span>
                        <span>
                          Service {renewal.serviceStatus} · next period {" "}
                          {new Date(renewal.periodStart).toLocaleString()} → {" "}
                          {new Date(renewal.periodEnd).toLocaleString()}
                        </span>
                        <span>
                          Funding {renewal.fundingStatus} · term grant {renewal.renewalStatus}
                          {renewal.renewalStatus === "manual_hold"
                            ? " — funds recorded; staff disposition required"
                            : renewal.renewalStatus === "cancelled"
                              ? " — withdrawn by cycle-end cancellation; collectible due is zero"
                            : ""}
                        </span>
                        {renewal.lateFee && (
                          <span data-testid="admin-renewal-late-fee">
                            Late Fee {renewal.lateFee.disposition} · basis {usd(renewal.lateFee.basisMinor)}
                            {" "}· {(renewal.lateFee.basisPoints / 100).toFixed(2)}% = {" "}
                            {usd(renewal.lateFee.amountMinor)}
                          </span>
                        )}
                        {renewal.paymentReconciliationHold.active && (
                          <span data-testid="admin-renewal-payment-reconciliation-hold">
                            Delinquency deferred for unresolved payment result · recorded holds {" "}
                            {renewal.paymentReconciliationHold.deferralCount}
                          </span>
                        )}
                        {renewal.automaticPayment && (
                          <span data-testid="admin-renewal-automatic-payment-status">
                            Automatic payment {renewal.automaticPayment.status} · attempt {renewal.automaticPayment.attemptCount}/{renewal.automaticPayment.maxAttempts}
                            {renewal.automaticPayment.lastError
                              ? ` · ${renewal.automaticPayment.lastError}`
                              : ""}
                          </span>
                        )}
                        {renewal.delinquency && (
                          <>
                            <span data-testid="admin-renewal-delinquency-status">
                              Action {renewal.delinquency.action} · case {renewal.delinquency.status}
                              {renewal.delinquency.providerInstallationId
                                ? ` · Provider ${renewal.delinquency.providerInstallationId}`
                                : " · no Provider mutation"}
                              {renewal.delinquency.suspendOperation
                                ? ` · suspend ${renewal.delinquency.suspendOperation.status}/${renewal.delinquency.suspendOperation.attempts}`
                                : ""}
                              {renewal.delinquency.resumeOperation
                                ? ` · resume ${renewal.delinquency.resumeOperation.status}/${renewal.delinquency.resumeOperation.attempts}`
                                : ""}
                              {renewal.delinquency.lastError
                                ? ` · ${renewal.delinquency.lastError}`
                                : ""}
                            </span>
                            {renewal.delinquency.manualControl && (
                              <span data-testid="admin-renewal-manual-control">
                                Manual records {renewal.delinquency.manualControl.actionCount}
                                {renewal.delinquency.manualControl.latestActionAt
                                  ? ` · latest ${new Date(
                                      renewal.delinquency.manualControl.latestActionAt,
                                    ).toLocaleString()}`
                                  : ""}
                                {renewal.delinquency.manualControl.blockedReason
                                  ? ` · blocked: ${renewal.delinquency.manualControl.blockedReason}`
                                  : " · password confirmation and a 10+ character reason are required"}
                              </span>
                            )}
                          </>
                        )}
                        <span>
                          Notification delivery: {" "}
                          {renewal.reminders.length === 0
                            ? "none"
                            : renewal.reminders
                                .map((reminder) => `${reminderLabel(reminder)}=${reminder.status}`)
                                .join(", ")}
                        </span>
                      </div>
                      {renewal.delinquency?.manualControl?.allowedActions.includes(
                        "confirm_suspended",
                      ) && (
                        <div className="fund-actions" data-testid="manual-suspension-control">
                          <span>{renewal.delinquency.manualControl.impact.confirmSuspended}</span>
                          <button
                            className="primary"
                            disabled={
                              manualSuspensionPendingId !== null ||
                              adminPassword.length === 0 ||
                              manualSuspensionReason.trim().length < 10
                            }
                            onClick={() =>
                              void performManualSuspensionAction(renewal, "confirm_suspended")
                            }
                          >
                            {manualSuspensionPendingId === renewal.delinquency.caseId
                              ? "Recording suspension…"
                              : "Confirm service suspended"}
                          </button>
                        </div>
                      )}
                      {renewal.delinquency?.manualControl?.allowedActions.includes(
                        "confirm_restored",
                      ) && (
                        <div className="fund-actions" data-testid="manual-restoration-control">
                          <span>{renewal.delinquency.manualControl.impact.confirmRestored}</span>
                          <button
                            className="primary"
                            disabled={
                              manualSuspensionPendingId !== null ||
                              adminPassword.length === 0 ||
                              manualSuspensionReason.trim().length < 10
                            }
                            onClick={() =>
                              void performManualSuspensionAction(renewal, "confirm_restored")
                            }
                          >
                            {manualSuspensionPendingId === renewal.delinquency.caseId
                              ? "Recording restoration…"
                              : "Confirm service restored"}
                          </button>
                        </div>
                      )}
                      {renewal.renewalStatus === "manual_hold" && (
                        <button
                          className="primary"
                          disabled={
                            renewalHoldPendingId !== null ||
                            adminPassword.length === 0 ||
                            renewalHoldReason.trim().length < 10
                          }
                          onClick={() => void resolveRenewalHold(renewal)}
                        >
                          {renewalHoldPendingId === renewal.renewalId
                            ? "Resolving funded Hold…"
                            : "Review and grant exact period"}
                        </button>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </div>
            <div className="admin-subsection" aria-label="Cycle-end service cancellations">
              <div>
                <p className="eyebrow">
                  {locale === "zh-CN" ? "已付账期终止控制" : "Paid-period termination control"}
                </p>
                <h3>{locale === "zh-CN" ? "账期末取消" : "Cycle-end cancellations"}</h3>
                <p>
                  {locale === "zh-CN"
                    ? "自动服务只会在 Provider 事实确认后显示为已终止。未知结果仅通过查询对账，不会发送第二次终止请求。人工服务保留真实服务状态，并明确进入管理员处理队列。"
                    : "Automatic services become terminated only after a confirmed Provider fact. Unknown results are reconciled by query without sending a second terminate. Manual services remain in their real service state and are explicitly queued for administrator intervention."}
                </p>
              </div>
              <button onClick={() => void refreshAdminCancellations()}>
                {locale === "zh-CN" ? "刷新取消队列" : "Refresh cancellations"}
              </button>
              <input
                aria-label={locale === "zh-CN" ? "人工账期末终止原因" : "Manual cycle-end termination reason"}
                value={cancellationCompletionReason}
                onChange={(event) => setCancellationCompletionReason(event.target.value)}
                placeholder={
                  locale === "zh-CN"
                    ? "人工终止证据和原因（至少 10 个字符）"
                    : "Manual termination evidence and reason (10+ characters)"
                }
              />
              {adminCancellations.length === 0 ? (
                <p className="muted">
                  {locale === "zh-CN"
                    ? "当前没有已安排的账期末取消。"
                    : "No cycle-end cancellation has been scheduled."}
                </p>
              ) : (
                <div data-testid="admin-cancellation-list">
                  {adminCancellations.map((item) => (
                    <article
                      className="manual-item"
                      data-testid="admin-cancellation-item"
                      key={item.executionId}
                    >
                      <div>
                        <strong>
                          {item.clientAccountName} · {item.productName} ·{" "}
                          {cancellationStatusLabel(item.executionStatus, locale)}
                        </strong>
                        <span>
                          {locale === "zh-CN" ? "生效时间" : "Effective"}{" "}
                          {new Date(item.effectiveAt).toLocaleString()} ·{" "}
                          {locale === "zh-CN" ? "执行方式" : "execution"}{" "}
                          {cancellationExecutionLabel(item.executionMode, locale)} ·{" "}
                          {locale === "zh-CN" ? "当前服务状态" : "service remains"}{" "}
                          {item.serviceStatus}
                        </span>
                        <span>
                          {locale === "zh-CN" ? "到期任务" : "Due job"} {item.job.status}
                          {item.providerOperation
                            ? ` · Provider ${item.providerOperation.status}/${item.providerOperation.attempts}`
                            : locale === "zh-CN"
                              ? " · 无 Provider 操作"
                              : " · no Provider operation"}
                        </span>
                        {item.interventionRequired && (
                          <>
                            <span data-testid="admin-cancellation-manual">
                              {locale === "zh-CN"
                                ? "需要管理员介入；系统尚未把此服务表示为已终止。"
                                : "Administrator intervention required; this service has not been represented as terminated."}
                            </span>
                            <button
                              className="primary"
                              disabled={
                                cancellationCompletionPendingId !== null ||
                                adminPassword.length === 0 ||
                                cancellationCompletionReason.trim().length < 10
                              }
                              onClick={() => void completeCycleEndCancellation(item)}
                            >
                              {cancellationCompletionPendingId === item.executionId
                                ? locale === "zh-CN"
                                  ? "正在记录终止…"
                                  : "Recording termination…"
                                : locale === "zh-CN"
                                  ? "确认人工终止"
                                  : "Confirm manual termination"}
                            </button>
                          </>
                        )}
                        {(item.lastError || item.job.lastError) && (
                          <span>{item.lastError ?? item.job.lastError}</span>
                        )}
                        <span className="mono">service {item.serviceId}</span>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
            <div className="admin-subsection" aria-label="Add Funds Chargebacks">
              <div>
                <p className="eyebrow">Immutable external loss and customer debt</p>
                <h3>Add Funds Chargebacks</h3>
                <p>
                  Original payment identity and amount facts remain immutable. An unclaimed
                  receipt moves to charged_back; an allocated receipt and paid invoice remain
                  historical. Remaining Credit is recovered first, and consumed principal becomes
                  an explicit receivable for only the affected Client Account.
                </p>
              </div>
              <button onClick={() => void refreshAdminChargebacks()}>
                Refresh Chargebacks
              </button>
              {adminChargebacks.length === 0 &&
              adminUnclaimedChargebacks.length === 0 &&
              adminChargebackHolds.length === 0 ? (
                <p className="muted">No Add Funds Chargeback is currently recorded.</p>
              ) : (
                <div data-testid="admin-chargeback-list">
                  {adminChargebacks.map((chargeback) => (
                    <article
                      className="manual-item security-hold-item"
                      data-testid="admin-chargeback"
                      key={chargeback.chargebackEffectId}
                    >
                      <div>
                        <strong>
                          {chargeback.clientAccountName} · external loss {" "}
                          {usd(chargeback.externalAmountMinor)}
                        </strong>
                        <span>
                          Credit recovered {usd(chargeback.creditRecoveredMinor)} · debt {" "}
                          {usd(chargeback.debtMinor)} · fee reversal {usd(chargeback.feeMinor)}
                        </span>
                        <span>
                          Client Account restriction: {" "}
                          {chargeback.restrictionActive ? "active" : "not active"}
                        </span>
                        <span className="mono">
                          {chargeback.originalExternalPaymentId} · {chargeback.externalChargebackId}
                        </span>
                      </div>
                    </article>
                  ))}
                  {adminUnclaimedChargebacks.map((chargeback) => (
                    <article
                      className="manual-item security-hold-item"
                      data-testid="admin-unclaimed-chargeback"
                      key={chargeback.unclaimedChargebackEffectId}
                    >
                      <div>
                        <strong>
                          {chargeback.clientAccountName} · unclaimed receipt reversed {" "}
                          {usd(chargeback.externalAmountMinor)}
                        </strong>
                        <span>
                          No customer Credit or debt was created; unclaimed liability and Mock cash
                          were reversed together.
                        </span>
                        <span className="mono">
                          receipt {chargeback.fundReceiptId} · {" "}
                          {chargeback.originalExternalPaymentId} · {" "}
                          {chargeback.externalChargebackId}
                        </span>
                      </div>
                    </article>
                  ))}
                  {adminChargebackHolds.map((hold) => (
                    <article
                      className="manual-item security-hold-item"
                      data-testid="admin-chargeback-hold"
                      key={hold.holdId}
                    >
                      <div>
                        <strong>
                          {hold.clientAccountName ?? "Unresolved Client Account"} · manual hold
                        </strong>
                        <span>{hold.reason}</span>
                        {hold.amountMinor && hold.currency && (
                          <span>
                            Provider reported {usd(hold.amountMinor)} {hold.currency}
                          </span>
                        )}
                        {(hold.originalExternalPaymentId || hold.externalChargebackId) && (
                          <span className="mono">
                            {hold.originalExternalPaymentId ?? "unknown payment"} · {" "}
                            {hold.externalChargebackId ?? "unknown Chargeback"}
                          </span>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
              </>
            )}
            {canManageManualFulfillment && (
            <div className="admin-subsection" aria-label="Manual fulfillment queue">
              <h3>Manual fulfillment queue</h3>
              {operationAccount && (
                <p className="notice" data-testid="manual-fulfillment-account-context">
                  Showing only {operationAccount.name} · {operationAccount.id}
                </p>
              )}
              {visibleManualItems.length === 0 ? (
                <p className="muted">
                  {operationAccount === null && canViewAccount360 && !canUseFullAdminWorkspace
                    ? "Select a Client Account in Account 360 to open its fulfillment queue."
                    : "No paid manual services are waiting."}
                </p>
              ) : (
                <>
                <div className="inline-form admin-confirm">
                  <input
                    value={manualReason}
                    onChange={(event) => setManualReason(event.target.value)}
                    placeholder="Reason and delivery evidence (10+ characters)"
                  />
                </div>
                {visibleManualItems.map((item) => (
                  <article className="manual-item" data-testid="manual-fulfillment-item" key={item.serviceId}>
                    <div>
                      <strong>{item.productName}</strong>
                      <span>
                        {item.clientAccountName} · {item.billingCycle} ·{" "}
                        {usd(item.paidMinor)} paid
                      </span>
                    </div>
                    <button
                      className="primary"
                      disabled={adminPassword.length === 0 || manualReason.trim().length < 10}
                      onClick={() => completeManual(item)}
                    >
                      Confirm Ready for Service
                    </button>
                  </article>
                ))}
                </>
              )}
            </div>
            )}
            {canManageManualReceipts && (
            <div className="admin-subsection" aria-label="Record manual receipt">
              <div>
                <p className="eyebrow">Audited offline or manual money fact</p>
                <h3>Record received funds manually</h3>
                <p>
                  Use this only after staff independently confirms that money arrived. Core records
                  immutable gross, fee, net cash, and unclaimed liability facts. It does not call a
                  Provider, pay an invoice, add Credit, or activate a service.
                </p>
                {operationAccount && (
                  <p className="notice" data-testid="manual-receipt-account-context">
                    Target fixed to {operationAccount.name} · {operationAccount.id}
                  </p>
                )}
              </div>
              <div className="manual-receipt-form">
                <label>
                  <span>Client Account ID</span>
                  <input
                    aria-label="Manual receipt Client Account ID"
                    disabled={
                      manualReceiptPending || manualReceiptReversalPendingId !== null
                    }
                    readOnly={
                      operationAccount !== null ||
                      (!canUseFullAdminWorkspace && canViewAccount360)
                    }
                    value={manualReceiptClientAccountId}
                    onChange={(event) => {
                      manualReceiptRequestGeneration.current += 1;
                      manualReceiptClientAccountIdRef.current = event.target.value;
                      setManualReceiptClientAccountId(event.target.value);
                      setManualReceiptReference("");
                      setManualReceiptReceivedAt(defaultManualReceiptTime());
                      setManualReceiptGrossMinor("10000");
                      setManualReceiptFeeMinor("0");
                      setManualReceiptReason("");
                      setManualReceiptPending(false);
                      setManualReceiptHistory([]);
                      setManualReceiptTarget(null);
                      setManualReceiptOutcome(null);
                      setManualReceiptReversalTargetId(null);
                      setManualReceiptReversalReason("");
                      setManualReceiptReversalPendingId(null);
                      setManualReceiptReversalOutcome(null);
                      setAdminPassword("");
                    }}
                    placeholder="Client Account UUID"
                  />
                </label>
                <label>
                  <span>Receipt reference</span>
                  <input
                    aria-label="Manual receipt reference"
                    disabled={
                      manualReceiptPending || manualReceiptReversalPendingId !== null
                    }
                    value={manualReceiptReference}
                    onChange={(event) => setManualReceiptReference(event.target.value)}
                    maxLength={200}
                    placeholder="Bank or offline receipt reference"
                  />
                </label>
                <label>
                  <span>Received at ({browserTimeZone})</span>
                  <input
                    aria-label="Manual receipt received at"
                    type="datetime-local"
                    disabled={
                      manualReceiptPending || manualReceiptReversalPendingId !== null
                    }
                    value={manualReceiptReceivedAt}
                    onChange={(event) => setManualReceiptReceivedAt(event.target.value)}
                  />
                </label>
                <label>
                  <span>Gross received (USD cents)</span>
                  <input
                    aria-label="Manual receipt gross amount in cents"
                    inputMode="numeric"
                    disabled={
                      manualReceiptPending || manualReceiptReversalPendingId !== null
                    }
                    maxLength={19}
                    value={manualReceiptGrossMinor}
                    onChange={(event) => setManualReceiptGrossMinor(event.target.value)}
                  />
                </label>
                <label>
                  <span>Actual processing fee (USD cents)</span>
                  <input
                    aria-label="Manual receipt fee in cents"
                    inputMode="numeric"
                    disabled={
                      manualReceiptPending || manualReceiptReversalPendingId !== null
                    }
                    maxLength={19}
                    value={manualReceiptFeeMinor}
                    onChange={(event) => setManualReceiptFeeMinor(event.target.value)}
                  />
                </label>
                <label className="manual-receipt-reason">
                  <span>Reason and independent evidence</span>
                  <textarea
                    aria-label="Manual receipt reason"
                    disabled={
                      manualReceiptPending || manualReceiptReversalPendingId !== null
                    }
                    value={manualReceiptReason}
                    onChange={(event) => setManualReceiptReason(event.target.value)}
                    maxLength={1_000}
                    placeholder="What was checked, where the money arrived, and why it belongs to this Client Account (10+ characters)"
                  />
                </label>
              </div>
              {manualReceiptTarget ? (
                <p className="notice" data-testid="manual-receipt-target">
                  Verified target: {manualReceiptTarget.name} · {manualReceiptTarget.id}
                </p>
              ) : (
                <p className="muted">
                  Verify the Client Account ID and review its name before recording money.
                </p>
              )}
              {manualReceiptNetMinor === null ? (
                <p className="notice error">
                  Gross must be positive; fee must be zero or positive and cannot exceed gross.
                </p>
              ) : (
                <p className="notice" data-testid="manual-receipt-impact">
                  Preview: gross {usd(manualReceiptGrossMinor)} · fee {usd(manualReceiptFeeMinor)} ·
                  net cash {usd(manualReceiptNetMinor)} · unclaimed liability {usd(manualReceiptGrossMinor)}
                </p>
              )}
              <div className="fund-actions">
                <button
                  className="primary"
                  disabled={
                    manualReceiptPending ||
                    manualReceiptReversalPendingId !== null ||
                    !manualReceiptFormReady
                  }
                  onClick={() => void recordManualReceipt()}
                >
                  {manualReceiptPending ? "Recording…" : "Record manual receipt"}
                </button>
                <button
                  disabled={
                    manualReceiptPending ||
                    manualReceiptReversalPendingId !== null ||
                    !looksLikeUuid(manualReceiptClientAccountId)
                  }
                  onClick={() => void loadManualReceiptHistory()}
                >
                  Verify account &amp; load history
                </button>
              </div>
              {manualReceiptOutcome && (
                <article
                  className="manual-item"
                  data-testid="manual-receipt-outcome"
                  data-manual-receipt-id={manualReceiptOutcome.manualReceiptId}
                >
                  <div>
                    <strong>
                      {manualReceiptOutcome.reference} · {usd(manualReceiptOutcome.grossAmountMinor)}
                      {manualReceiptOutcome.replayed ? " · replayed safely" : " · recorded"}
                    </strong>
                    <span>
                      Fee {usd(manualReceiptOutcome.feeMinor)} · net cash {usd(manualReceiptOutcome.netAmountMinor)} ·
                      disposition {manualReceiptOutcome.disposition}
                    </span>
                    <span>
                      {manualReceiptTarget?.name ?? "Verified Client Account"} · {manualReceiptOutcome.clientAccountId}
                    </span>
                    <span>No Provider or automatic customer balance/service action was used.</span>
                    <span className="mono">
                      receipt {manualReceiptOutcome.manualReceiptId} · fund {manualReceiptOutcome.fundReceiptId}
                    </span>
                  </div>
                </article>
              )}
              {manualReceiptReversalOutcome && (
                <article
                  className="manual-item"
                  data-testid="manual-receipt-reversal-outcome"
                  data-reversal-id={manualReceiptReversalOutcome.reversalId}
                >
                  <div>
                    <strong>
                      Reversal · {usd(manualReceiptReversalOutcome.grossAmountMinor)}
                      {manualReceiptReversalOutcome.replayed
                        ? " · replayed safely"
                        : " · recorded"}
                    </strong>
                    <span>
                      Liability removed {usd(manualReceiptReversalOutcome.grossAmountMinor)} ·
                      cash correction {usd(manualReceiptReversalOutcome.netAmountMinor)} · fee
                      correction {usd(manualReceiptReversalOutcome.feeMinor)}
                    </span>
                    <span>
                      Original receipt remains immutable. This correction sent no money, called no
                      Provider, and changed no Invoice, Credit, or Service.
                    </span>
                    <span className="mono">
                      reversal {manualReceiptReversalOutcome.reversalId} · receipt {" "}
                      {manualReceiptReversalOutcome.manualReceiptId}
                    </span>
                  </div>
                </article>
              )}
              {manualReceiptHistory.length > 0 && (
                <div data-testid="manual-receipt-history">
                  {manualReceiptHistory.map((receipt) => {
                    const reviewingReversal =
                      manualReceiptReversalTargetId === receipt.manualReceiptId;
                    return (
                      <article
                        className="manual-item manual-receipt-history-item"
                        data-testid="manual-receipt-history-item"
                        data-manual-receipt-id={receipt.manualReceiptId}
                        data-received-at={receipt.receivedAt}
                        data-disposition={receipt.disposition}
                        key={receipt.manualReceiptId}
                      >
                        <div>
                          <strong>
                            {receipt.reference} · {usd(receipt.grossAmountMinor)} gross
                          </strong>
                          <span>
                            Fee {usd(receipt.feeMinor)} · net {usd(receipt.netAmountMinor)} ·
                            available {usd(receipt.availableMinor)}
                          </span>
                          <span>
                            Received {new Date(receipt.receivedAt).toLocaleString()} · {" "}
                            {receipt.disposition}
                          </span>
                          <span>{receipt.reason}</span>
                          {manualReceiptTarget && canManageRefunds && (
                            <ManualReceiptOutflowPanel
                              clientAccountId={manualReceiptTarget.id}
                              receipt={receipt}
                              password={adminPassword}
                              scopeToken={currentManualReceiptScopeToken(
                                manualReceiptTarget.id,
                              )}
                              disabled={
                                manualReceiptPending ||
                                manualReceiptReversalPendingId !== null
                              }
                              isScopeCurrent={(scopeToken) =>
                                manualReceiptScopeIsCurrent(
                                  scopeToken,
                                  manualReceiptTarget.id,
                                )}
                              onPasswordConsumed={(scopeToken) => {
                                if (
                                  manualReceiptScopeIsCurrent(
                                    scopeToken,
                                    manualReceiptTarget.id,
                                  )
                                ) setAdminPassword("");
                              }}
                              onRefresh={async (scopeToken) => {
                                const clientAccountId = manualReceiptTarget.id;
                                if (
                                  !manualReceiptScopeIsCurrent(
                                    scopeToken,
                                    clientAccountId,
                                  )
                                ) return false;
                                const operationScope = captureAdminOperationScope();
                                if (
                                  !adminOperationRequestIsCurrent(
                                    operationScope,
                                    clientAccountId,
                                  )
                                ) return false;
                                const [historyResult, unclaimedResult] =
                                  await Promise.allSettled([
                                    fetchManualReceiptHistory(clientAccountId, scopeToken),
                                    canUseFullAdminWorkspace
                                      ? refreshUnclaimedFunds(
                                          operationScope,
                                          () => manualReceiptScopeIsCurrent(
                                            scopeToken,
                                            clientAccountId,
                                          ),
                                        )
                                      : Promise.resolve(true),
                                  ]);
                                if (
                                  !manualReceiptScopeIsCurrent(
                                    scopeToken,
                                    clientAccountId,
                                  ) ||
                                  !adminOperationRequestIsCurrent(
                                    operationScope,
                                    clientAccountId,
                                  )
                                ) return false;
                                if (
                                  historyResult.status === "fulfilled" &&
                                  historyResult.value
                                ) {
                                  setManualReceiptTarget(historyResult.value.clientAccount);
                                  setManualReceiptHistory(historyResult.value.items);
                                }
                                if (
                                  historyResult.status === "rejected" ||
                                  !historyResult.value ||
                                  unclaimedResult.status === "rejected" ||
                                  !unclaimedResult.value
                                ) {
                                  setError(
                                    "The outflow fact was saved, but one of the administrator balances could not be refreshed.",
                                  );
                                }
                                return true;
                              }}
                              onNotice={setNotice}
                              onError={setError}
                            />
                          )}
                          {receipt.reversal && (
                            <span data-testid="manual-receipt-reversal">
                              Reversed {new Date(receipt.reversal.createdAt).toLocaleString()} · {" "}
                              {receipt.reversal.reason} · reversal {receipt.reversal.reversalId}
                            </span>
                          )}
                          {!receipt.reversal && !manualReceiptIsUntouched(receipt) && (
                            <span>
                              Reversal unavailable: this money was allocated, returned, frozen, or
                              otherwise changed. Use an explicit compensating workflow.
                            </span>
                          )}
                        </div>
                        {canManageUnclaimedFunds &&
                          manualReceiptIsUntouched(receipt) &&
                          !reviewingReversal && (
                          <button
                            disabled={manualReceiptReversalPendingId !== null}
                            onClick={() => {
                              setManualReceiptReversalTargetId(receipt.manualReceiptId);
                              setManualReceiptReversalReason("");
                              setManualReceiptReversalOutcome(null);
                            }}
                          >
                            Review reversal
                          </button>
                        )}
                        {canManageUnclaimedFunds &&
                          manualReceiptIsUntouched(receipt) &&
                          reviewingReversal && (
                          <div
                            className="manual-receipt-reversal-review"
                            aria-label="Manual receipt reversal review"
                          >
                            <p className="notice" data-testid="manual-receipt-reversal-impact">
                              Append-only correction: Dr unclaimed liability {" "}
                              {usd(receipt.grossAmountMinor)}; Cr cash {usd(receipt.netAmountMinor)};
                              Cr fee expense {usd(receipt.feeMinor)}. The original fact stays. This is
                              not a refund and sends no money.
                            </p>
                            <label>
                              <span>Why the entire receipt was entered incorrectly</span>
                              <textarea
                                aria-label="Manual receipt reversal reason"
                                disabled={manualReceiptReversalPendingId !== null}
                                value={manualReceiptReversalReason}
                                onChange={(event) =>
                                  setManualReceiptReversalReason(event.target.value)
                                }
                                maxLength={1_000}
                                placeholder="Independent evidence proving the original receipt fact was mistaken (10+ characters)"
                              />
                            </label>
                            <div className="fund-actions">
                              <button
                                className="danger"
                                disabled={
                                  manualReceiptReversalPendingId !== null ||
                                  manualReceiptReversalReason.trim().length < 10 ||
                                  adminPassword.length === 0
                                }
                                onClick={() => void reverseManualReceipt(receipt)}
                              >
                                {manualReceiptReversalPendingId === receipt.manualReceiptId
                                  ? "Reversing…"
                                  : "Reverse incorrect receipt"}
                              </button>
                              <button
                                disabled={manualReceiptReversalPendingId !== null}
                                onClick={() => {
                                  setManualReceiptReversalTargetId(null);
                                  setManualReceiptReversalReason("");
                                }}
                              >
                                Cancel reversal review
                              </button>
                            </div>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
            )}
            {canUseFullAdminWorkspace && operationAccount === null && (
            <div className="admin-subsection">
              <div>
                <p className="eyebrow">Money received but not yet assigned</p>
                <h3>Unclaimed funds</h3>
                <p>
                  Original Provider facts remain immutable. Each resolution requires password
                  confirmation, a reason, and creates a separate balanced journal.
                </p>
              </div>
              <button onClick={() => void refreshUnclaimedFunds()}>
                Refresh unclaimed funds
              </button>
              <div className="inline-form admin-confirm">
                <input
                  aria-label="Fund resolution amount in cents"
                  inputMode="numeric"
                  value={fundResolutionMinor}
                  onChange={(event) => setFundResolutionMinor(event.target.value)}
                  placeholder="Resolution amount in cents"
                />
                <input
                  aria-label="Fund resolution invoice ID"
                  value={fundResolutionInvoiceId}
                  onChange={(event) => setFundResolutionInvoiceId(event.target.value)}
                  placeholder="Matching invoice ID (allocation only)"
                />
                <input
                  aria-label="Fund resolution reason"
                  value={fundResolutionReason}
                  onChange={(event) => setFundResolutionReason(event.target.value)}
                  placeholder="Resolution reason (10+ characters)"
                />
              </div>
              <div className="inline-form admin-confirm refund-controls">
                <select
                  aria-label="Unclaimed funds return amount mode"
                  value={fundReturnAmountMode}
                  onChange={(event) =>
                    setFundReturnAmountMode(event.target.value as "full" | "partial")
                  }
                >
                  <option value="full">Return all currently available funds</option>
                  <option value="partial">Return a partial amount</option>
                </select>
                <input
                  aria-label="Unclaimed funds return amount in cents"
                  inputMode="numeric"
                  value={fundReturnAmountMinor}
                  onChange={(event) => setFundReturnAmountMinor(event.target.value)}
                  disabled={fundReturnAmountMode === "full"}
                  placeholder={
                    fundReturnAmountMode === "full"
                      ? "Uses the displayed actionable amount"
                      : "Return amount in cents"
                  }
                />
                <select
                  aria-label="Unclaimed funds refund Provider scenario"
                  value={fundReturnScenario}
                  onChange={(event) =>
                    setFundReturnScenario(
                      event.target.value as
                        | "success"
                        | "failed"
                        | "timeout_success"
                        | "duplicate_out_of_order",
                    )
                  }
                >
                  <option value="success">Provider success</option>
                  <option value="failed">Provider failure</option>
                  <option value="timeout_success">Timeout, then reconcile success</option>
                  <option value="duplicate_out_of_order">Duplicate/out-of-order callbacks</option>
                </select>
                <input
                  aria-label="Unclaimed funds return reason"
                  value={fundReturnReason}
                  onChange={(event) => setFundReturnReason(event.target.value)}
                  placeholder="Original-payment return reason (10+ characters)"
                />
              </div>
              {unclaimedFunds.length === 0 ? (
                <p className="muted">No unclaimed funds are waiting.</p>
              ) : (
                <div data-testid="unclaimed-funds-list">
                  {unclaimedFunds.map((item) => (
                    <article
                      className="manual-item"
                      data-testid="unclaimed-fund-item"
                      data-receipt-id={item.receiptId}
                      data-source={item.source}
                      key={item.receiptId}
                    >
                      <div>
                        <strong>
                          {item.clientAccountName} · actionable {usd(item.availableMinor)}
                        </strong>
                        <span>
                          Received {usd(item.amountMinor)} via {item.source === "manual"
                            ? `manual receipt ${item.manualReference ?? "without reference"}`
                            : `Provider ${item.providerInstallationId ?? "unknown"}`}
                        </span>
                        <span>
                          Allocated {usd(item.allocatedMinor)} · pending return{" "}
                          {usd(item.reservedRefundMinor)} · confirmed returned{" "}
                          {usd(item.confirmedOutflowMinor)}
                        </span>
                        <span className="mono">
                          {item.source === "manual"
                            ? `manual ${item.manualReceiptId ?? "unknown"}`
                            : item.externalPaymentId}
                        </span>
                        <span>{item.reason ?? "Awaiting operator classification"}</span>
                        {item.capacityFrozen && (
                          <span>
                            Reconciliation required — allocation and new returns are blocked.
                          </span>
                        )}
                      </div>
                      <div className="fund-actions">
                        <button
                          className="primary"
                          disabled={
                            fundResolutionPendingReceiptIds.has(item.receiptId) ||
                            refundPendingReceiptIds.has(item.receiptId) ||
                            item.capacityFrozen ||
                            BigInt(item.availableMinor) <= 0n ||
                            adminPassword.length === 0 ||
                            !/^[1-9]\d*$/.test(fundResolutionMinor) ||
                            fundResolutionReason.trim().length < 10
                          }
                          onClick={() => resolveUnclaimedFunds(item, "convert_to_credit")}
                        >
                          Convert amount to Credit
                        </button>
                        <button
                          disabled={
                            fundResolutionPendingReceiptIds.has(item.receiptId) ||
                            refundPendingReceiptIds.has(item.receiptId) ||
                            item.capacityFrozen ||
                            BigInt(item.availableMinor) <= 0n ||
                            adminPassword.length === 0 ||
                            !/^[1-9]\d*$/.test(fundResolutionMinor) ||
                            fundResolutionReason.trim().length < 10 ||
                            (!fundResolutionInvoiceId && !item.suggestedInvoiceId)
                          }
                          onClick={() => resolveUnclaimedFunds(item, "allocate_invoice")}
                        >
                          Allocate amount to invoice
                        </button>
                        {item.source === "provider" ? (
                          <button
                            data-testid="return-unclaimed-funds"
                            disabled={
                              fundResolutionPendingReceiptIds.has(item.receiptId) ||
                              refundPendingReceiptIds.has(item.receiptId) ||
                              item.capacityFrozen ||
                              BigInt(item.availableMinor) <= 0n ||
                              adminPassword.length === 0 ||
                              fundReturnReason.trim().length < 10 ||
                              (fundReturnAmountMode === "partial" &&
                                !/^[1-9]\d*$/.test(fundReturnAmountMinor))
                            }
                            onClick={() => returnUnclaimedFunds(item)}
                          >
                            Return to original payment
                          </button>
                        ) : (
                          <span data-testid="manual-receipt-no-provider-return">
                            No Provider refund target. Use an audited manual outflow decision.
                          </span>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
            )}
            {canManageRefunds && (
            <div className="admin-subsection" aria-label="Manual refunds">
              <div>
                <p className="eyebrow">Independent money decision</p>
                <h3>Manual refunds</h3>
                <p>
                  The reference amount is advisory. A refund does not silently cancel service,
                  reopen the paid invoice, or rewrite the original payment. This section covers
                  allocated invoice receipts; unclaimed original-payment returns are handled in
                  the funds queue above.
                </p>
                {operationAccount && (
                  <p className="notice" data-testid="refund-account-context">
                    Showing only {operationAccount.name} · {operationAccount.id}
                  </p>
                )}
              </div>
              <button
                onClick={() =>
                  void Promise.all([
                    refreshRefundCandidates(),
                    refreshRefundRecords(),
                    refreshRefundSecurityHolds(),
                    refreshRefundDismissalCorrections(),
                    refreshRefundReceiptCapacityIncidents(),
                  ])
                }
              >
                Refresh refunds
              </button>
              <div className="inline-form admin-confirm refund-controls">
                <select
                  aria-label="Refund amount mode"
                  value={refundAmountMode}
                  onChange={(event) =>
                    setRefundAmountMode(event.target.value as "full" | "partial")
                  }
                >
                  <option value="full">Full current refundable amount</option>
                  <option value="partial">Partial amount</option>
                </select>
                <input
                  aria-label="Refund amount in cents"
                  inputMode="numeric"
                  disabled={refundAmountMode === "full"}
                  value={refundAmountMinor}
                  onChange={(event) => setRefundAmountMinor(event.target.value)}
                  placeholder={
                    refundAmountMode === "full"
                      ? "Displayed maximum; changes require reconfirmation"
                      : "Amount in cents"
                  }
                />
                <select
                  aria-label="Refund Provider scenario"
                  value={refundScenario}
                  onChange={(event) =>
                    setRefundScenario(
                      event.target.value as
                        | "success"
                        | "failed"
                        | "timeout_success"
                        | "duplicate_out_of_order",
                    )
                  }
                >
                  <option value="success">Success</option>
                  <option value="failed">Failure — no settlement</option>
                  <option value="timeout_success">Timeout but actually refunded</option>
                  <option value="duplicate_out_of_order">Duplicate + out of order</option>
                </select>
                <input
                  aria-label="Refund reason"
                  value={refundReason}
                  onChange={(event) => setRefundReason(event.target.value)}
                  placeholder="Decision reason (10+ characters)"
                />
              </div>
              <p className="muted">
                Third-party destinations are disabled until a logged-in customer ticket and
                two-person approval are both implemented.
              </p>
              {visibleRefundCandidates.length === 0 ? (
                <p className="muted">
                  {operationAccount === null && canViewAccount360 && !canUseFullAdminWorkspace
                    ? "Select a Client Account in Account 360 to open its refund facts."
                    : "No fully allocated invoice receipt is currently refundable."}
                </p>
              ) : (
                <div data-testid="refund-candidate-list">
                  {visibleRefundCandidates.map((item) => {
                    const disabled =
                      refundPendingReceiptIds.has(item.receiptId) ||
                      adminPassword.length === 0 ||
                      refundReason.trim().length < 10 ||
                      (refundAmountMode === "partial" &&
                        (!/^[1-9]\d*$/.test(refundAmountMinor) ||
                          BigInt(refundAmountMinor) > BigInt(item.refundableMinor)));
                    return (
                      <article
                        className="manual-item"
                        data-testid="refund-candidate"
                        key={item.receiptId}
                      >
                        <div>
                          <strong>
                            {item.clientAccountName} · refundable {usd(item.refundableMinor)}
                          </strong>
                          <span>
                            Invoice {item.invoiceId} · receipt {usd(item.receiptAmountMinor)}
                          </span>
                          <span>
                            Reference only:{" "}
                            {item.referenceRefundMinor === null
                              ? "not available for this service shape"
                              : usd(item.referenceRefundMinor)}
                          </span>
                          <span className="mono">
                            {item.providerInstallationId} · {item.externalPaymentId}
                          </span>
                        </div>
                        <div className="fund-actions">
                          <button
                            className="primary"
                            disabled={disabled}
                            onClick={() => decideRefund(item, "original_payment")}
                          >
                            Refund original payment
                          </button>
                          <button
                            disabled={disabled}
                            onClick={() => decideRefund(item, "credit")}
                          >
                            Refund to Credit
                          </button>
                          <button
                            disabled={
                              refundPendingReceiptIds.has(item.receiptId) ||
                              adminPassword.length === 0 ||
                              refundReason.trim().length < 10
                            }
                            onClick={() => decideRefund(item, "none")}
                          >
                            Record no refund
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
              {visibleRefundReceiptCapacityIncidents.length > 0 && (
                <div data-testid="refund-receipt-capacity-incident-list">
                  <h4>Receipt compensation overages requiring manual recovery</h4>
                  <p className="muted">
                    Every refund or Credit compensation remains an established fact. For each
                    receipt, only the latest cumulative snapshot is the current recovery amount;
                    older snapshots remain visible as history and must not be added together.
                  </p>
                  {visibleRefundReceiptCapacityIncidents.map((incident) => {
                    const pending = refundCapacityAcknowledgementPendingIds.has(
                      incident.incidentId,
                    );
                    const disabled =
                      pending || adminPassword.length === 0 || refundReason.trim().length < 10;
                    return (
                      <article
                        className="manual-item security-hold-item"
                        data-testid="refund-receipt-capacity-incident"
                        key={incident.incidentId}
                      >
                        <div>
                          <strong>
                            {incident.clientAccountName} · receipt overage {usd(incident.overageMinor)}
                          </strong>
                          <span>{incident.reason}</span>
                          <span>
                            Immutable receipt {usd(incident.receiptAmountMinor)} · confirmed total
                            disposition {usd(incident.confirmedDispositionMinor)} · Provider outflow {" "}
                            {usd(incident.confirmedProviderOutflowMinor)}
                            {incident.sourceContext === "unclaimed_funds"
                              ? ` · allocated/Credit contribution ${usd(incident.allocatedContributionMinor)}`
                              : ""}
                            {" · "}overage {usd(incident.overageMinor)} {incident.currency}
                          </span>
                          <span>{incident.impact}</span>
                          <span>
                            Status: {incident.status.replaceAll("_", " ")}
                          </span>
                          {incident.acknowledgement && (
                            <span>
                              Ownership acknowledged: {incident.acknowledgement.reason}.{" "}
                              {incident.acknowledgement.recoveryOutstanding
                                ? "Manual recovery remains outstanding."
                                : "This historical acknowledgement was superseded by a later cumulative snapshot."}
                            </span>
                          )}
                          <span className="mono">
                            receipt {incident.receiptId} · cumulative snapshot {incident.receiptSequence} · {incident.source.type ===
                            "dismissal_correction"
                              ? `correction ${incident.source.correctionId}`
                              : `adjudication ${incident.source.adjudicationId}`}
                          </span>
                        </div>
                        {incident.allowedAction === "acknowledge_manual_recovery" && (
                          <div className="fund-actions">
                            <button
                              className="primary"
                              disabled={disabled}
                              onClick={() =>
                                acknowledgeRefundReceiptCapacityIncident(incident)
                              }
                            >
                              Acknowledge and take manual recovery
                            </button>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
              {visibleRefundSecurityHolds.length > 0 && (
                <div data-testid="refund-security-hold-list">
                  <h4>Provider facts requiring human adjudication</h4>
                  <p className="muted">
                    Review the immutable fact and impact. Provider callbacks cannot close these
                    holds. Your password confirmation and the reason above are required.
                  </p>
                  {visibleRefundSecurityHolds.map((hold) => {
                    const pending = refundAdjudicationPendingIds.has(hold.holdId);
                    const allocatedContributionMinor =
                      hold.sourceContext === "unclaimed_funds"
                        ? BigInt(hold.receiptAllocatedMinor)
                        : 0n;
                    const consumedBeforeHeldFactMinor =
                      BigInt(hold.confirmedSettlementMinor) + allocatedContributionMinor;
                    const disabled =
                      pending || adminPassword.length === 0 || refundReason.trim().length < 10;
                    return (
                      <article
                        className="manual-item security-hold-item"
                        data-testid="refund-security-hold"
                        key={hold.holdId}
                      >
                        <div>
                          <strong>
                            {hold.clientAccountName} · refund {usd(hold.refundAmountMinor)} ·{" "}
                            {hold.refundStatus}
                          </strong>
                          <span>{hold.reason}</span>
                          <span>
                            Provider reported {hold.providerFact.status}{" "}
                            {usd(hold.providerFact.amountMinor)} {hold.providerFact.currency}
                          </span>
                          <span className="mono">
                            {hold.providerFact.externalRefundId} · event{" "}
                            {hold.providerFact.eventId}
                          </span>
                          <span>
                            Receipt {usd(hold.receiptAmountMinor)} · consumed before this fact{" "}
                            {usd(consumedBeforeHeldFactMinor.toString())}
                            {hold.sourceContext === "unclaimed_funds"
                              ? ` (allocated/Credit ${usd(allocatedContributionMinor.toString())}, Provider outflow ${usd(hold.confirmedSettlementMinor)})`
                              : ` (confirmed refund outflow ${usd(hold.confirmedSettlementMinor)})`}
                            {" · "}{hold.providerFacts.length}{" "}
                            immutable Provider fact{hold.providerFacts.length === 1 ? "" : "s"}
                          </span>
                          {hold.sourceContext === "unclaimed_funds" &&
                            hold.allowedDecisions.includes("record_unexpected_outflow") && (
                              <span>
                                Recording this outflow preserves the cash fact; if allocation plus
                                confirmed Provider outflow exceeds the receipt, Core opens a manual
                                recovery incident instead of hiding the double disposition.
                              </span>
                            )}
                          {hold.providerFacts.map((fact) => (
                            <span className="mono" key={fact.factId}>
                              {fact.status} · {fact.amountMinor} {fact.currency} ·{" "}
                              {fact.externalRefundId}
                            </span>
                          ))}
                          {hold.discrepancy ? (
                            <span>
                              Cash outflow is already isolated in discrepancy suspense; accepting
                              it will only reclassify suspense. External identity: {" "}
                              <span className="mono">{hold.discrepancy.externalRefundId}</span>
                            </span>
                          ) : (
                            <span>No automatic financial posting was made for this claim.</span>
                          )}
                          <span>{hold.impact.dismissProviderClaim}</span>
                          {hold.impact.acceptAuthorizedOutflow && (
                            <span>{hold.impact.acceptAuthorizedOutflow}</span>
                          )}
                          {hold.impact.recordUnexpectedOutflow && (
                            <span>{hold.impact.recordUnexpectedOutflow}</span>
                          )}
                        </div>
                        <div className="fund-actions">
                          {hold.allowedDecisions.includes("accept_authorized_outflow") && (
                            <button
                              className="primary"
                              disabled={disabled}
                              onClick={() =>
                                adjudicateRefundHold(hold, "accept_authorized_outflow")
                              }
                            >
                              Accept authorized outflow
                            </button>
                          )}
                          {hold.allowedDecisions.includes("record_unexpected_outflow") && (
                            <button
                              disabled={disabled}
                              onClick={() =>
                                adjudicateRefundHold(hold, "record_unexpected_outflow")
                              }
                            >
                              Record verified unexpected outflow
                            </button>
                          )}
                          <button
                            disabled={disabled}
                            onClick={() => adjudicateRefundHold(hold, "dismiss_provider_claim")}
                          >
                            Dismiss Provider claim
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
              {visibleRefundDismissalCorrections.length > 0 && (
                <div data-testid="refund-dismissal-correction-list">
                  <h4>Dismissed Provider facts that can be corrected</h4>
                  <p className="muted">
                    Use this only after later authoritative evidence confirms the dismissed cash
                    outflow. The prior decision stays immutable; this adds a compensating journal
                    and reserves same-currency receipt capacity.
                  </p>
                  {visibleRefundDismissalCorrections.map((item) => {
                    const pending = refundCorrectionPendingIds.has(item.adjudicationId);
                    return (
                      <article
                        className="manual-item security-hold-item"
                        data-testid="refund-dismissal-correction"
                        key={item.adjudicationId}
                      >
                        <div>
                          <strong>
                            {item.clientAccountName} · dismissed {usd(item.providerFact.amountMinor)}{" "}
                            {item.providerFact.currency}
                          </strong>
                          <span>Prior reason: {item.dismissalReason}</span>
                          <span>{item.impact}</span>
                          <span className="mono">
                            {item.providerFact.externalRefundId} · event {item.providerFact.eventId}
                          </span>
                        </div>
                        <div className="fund-actions">
                          <button
                            className="primary"
                            disabled={
                              pending ||
                              adminPassword.length === 0 ||
                              refundReason.trim().length < 10
                            }
                            onClick={() => correctDismissedRefundOutflow(item)}
                          >
                            Confirm later evidence of outflow
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
              {visibleRefundRecords.length > 0 && (
                <div data-testid="refund-status-list">
                  {visibleRefundRecords.map((refund) => (
                    <article
                      className="manual-item"
                      data-testid="refund-status"
                      key={refund.refundId}
                    >
                      <div>
                        <strong>
                          {refund.destination.replaceAll("_", " ")} · {usd(refund.amountMinor)}
                        </strong>
                        <span>
                          Refund {refund.status} · Provider{" "}
                          {refund.providerOperationStatus ?? "not used"}
                        </span>
                        <span>
                          {refund.sourceContext === "unclaimed_funds"
                            ? `Unclaimed receipt ${refund.receiptId}`
                            : `Invoice ${refund.invoiceId ?? "unavailable"}`}
                        </span>
                        {refund.securityHold && (
                          <span>
                            Security hold —{" "}
                            {refund.securityHoldReason ??
                              "Provider facts cannot release this decision"}
                          </span>
                        )}
                        <span className="mono">{refund.refundId}</span>
                        {refund.externalRefundId && (
                          <span className="mono">{refund.externalRefundId}</span>
                        )}
                        {refund.lastError && <span>{refund.lastError}</span>}
                      </div>
                      {refund.status === "manual" &&
                        !refund.securityHold &&
                        refund.destination === "original_payment" && (
                          <div className="fund-actions">
                            <button
                              className="primary"
                              disabled={
                                refundManualActionPendingIds.has(refund.refundId) ||
                                adminPassword.length === 0 ||
                                refundReason.trim().length < 10
                              }
                              onClick={() => recoverManualRefund(refund, "retry_query")}
                            >
                              Retry Provider query only
                            </button>
                            <button
                              disabled={
                                refundManualActionPendingIds.has(refund.refundId) ||
                                adminPassword.length === 0 ||
                                refundReason.trim().length < 10
                              }
                              onClick={() => recoverManualRefund(refund, "confirm_no_outflow")}
                            >
                              Confirm no Provider outflow
                            </button>
                          </div>
                        )}
                    </article>
                  ))}
                </div>
              )}
            </div>
            )}
          </section>
        )}

        {route === "/customer" && order && (
          <section className="order-panel">
            <div>
              <p className="eyebrow">Live customer journey</p>
              <h2>{order.order.price.productName}</h2>
              <p className="mono">{order.order.id}</p>
            </div>
            <div className="journey">
              <Status label="Order" value={order.order.status} />
              <Status label="Invoice" value={order.invoice.status} />
              <Status label="Payment" value={order.payment.status ?? "not_started"} />
              <Status label="Provisioning" value={order.provisioning.status ?? "not_started"} />
              <Status label="Service" value={order.service.status} />
            </div>
            <div className="invoice-summary">
              <span>Total {usd(order.invoice.totalMinor)}</span>
              <span>External paid {usd(order.invoice.paymentAllocatedMinor)}</span>
              <span>Credit applied {usd(order.invoice.creditAppliedMinor)}</span>
              <span>Payment fee charged {usd(order.invoice.paymentFeeMinor)}</span>
              <strong>Due {usd(order.invoice.dueMinor)}</strong>
            </div>
            {order.invoice.status !== "paid" && canWriteBilling && (
              <div className="payment-controls">
                <select
                  aria-label="Payment method"
                  value={paymentMethod}
                  onChange={(event) => setPaymentMethod(event.target.value)}
                >
                  {(billing?.paymentMethods ?? []).map((method) => (
                    <option key={method.code} value={method.code}>
                      {method.name} · {(method.feeBasisPoints / 100).toFixed(2)}%
                    </option>
                  ))}
                </select>
                <label>
                  <input
                    type="checkbox"
                    checked={applyCredit}
                    onChange={(event) => setApplyCredit(event.target.checked)}
                  />
                  Apply available Credit ({usd(billing?.creditBalanceMinor ?? "0")})
                </label>
                <label>
                  <input
                    data-testid="save-payment-method-consent"
                    type="checkbox"
                    checked={savePaymentMethod}
                    disabled={
                      !paymentSettings ||
                      !billing?.paymentMethods.find((method) => method.code === paymentMethod)
                        ?.savedMethodEnabled
                    }
                    onChange={(event) => setSavePaymentMethod(event.target.checked)}
                  />
                  Save only the Provider token and safe card summary. Default is off; no card number or CVV is stored.
                </label>
                <label>
                  <input
                    data-testid="enable-auto-renew-consent"
                    type="checkbox"
                    checked={enableAutomaticRenewal}
                    disabled={
                      !savePaymentMethod ||
                      order.order.price.billingCycle === "one_time" ||
                      !billing?.paymentMethods.find((method) => method.code === paymentMethod)
                        ?.automaticRenewalEnabled
                    }
                    onChange={(event) => setEnableAutomaticRenewal(event.target.checked)}
                  />
                  Separately allow one background payment attempt when each renewal invoice is
                  created (normally 14 days before term end). The selected method fee is added to
                  that invoice; customer action or failure stops retries. Default is off and this
                  permission can be revoked.
                </label>
                {(savePaymentMethod || enableAutomaticRenewal) && !paymentSettingsReauthActive && (
                  <label>
                    Re-enter password to approve these payment-setting changes
                    <input
                      data-testid="checkout-payment-settings-password"
                      type="password"
                      autoComplete="current-password"
                      value={paymentSettingsPassword}
                      onChange={(event) => setPaymentSettingsPassword(event.target.value)}
                    />
                  </label>
                )}
                <select
                  value={paymentScenario}
                  onChange={(event) => setPaymentScenario(event.target.value)}
                >
                  <option value="success">Success</option>
                  <option value="failed">Failure</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="timeout_success">Timeout but actually settled</option>
                  <option value="duplicate_out_of_order">Duplicate + out of order</option>
                </select>
                {paymentQuote && (
                  <div className="quote-summary">
                    <span>Credit this payment: {usd(paymentQuote.creditToApplyMinor)}</span>
                    <span>External non-fee amount: {usd(paymentQuote.externalNonFeeMinor)}</span>
                    <span>Payment fee: {usd(paymentQuote.feeMinor)}</span>
                    <strong>External amount due: {usd(paymentQuote.externalDueMinor)}</strong>
                  </div>
                )}
                <button
                  className="primary"
                  disabled={
                    !canWriteBilling ||
                    !paymentQuote ||
                    ((savePaymentMethod || enableAutomaticRenewal) &&
                      !paymentSettingsReauthReady)
                  }
                  onClick={startPayment}
                >
                  {text.pay}
                </button>
              </div>
            )}
            {order.service.activatedAt && (
              <p>
                Ready for service: <strong>{new Date(order.service.activatedAt).toLocaleString()}</strong>
                <br />
                Service term: {new Date(order.service.termStart!).toLocaleString()} →{" "}
                {order.service.termEnd
                  ? new Date(order.service.termEnd).toLocaleString()
                  : "one-time"}
              </p>
            )}
            {order.service.cancellation ? (
              <div
                className="quote-summary"
                aria-label={locale === "zh-CN" ? "服务取消状态" : "Service cancellation status"}
              >
                <strong>
                  {locale === "zh-CN" ? "取消状态" : "Cancellation"} {" "}
                  {cancellationStatusLabel(order.service.cancellation.status, locale)} ·{" "}
                  {new Date(order.service.cancellation.effectiveAt).toLocaleString()}
                </strong>
                {order.service.cancellation.status === "scheduled" && (
                  <span>
                    {locale === "zh-CN"
                      ? "服务在当前已付账期结束前保持可用。"
                      : "The service remains available through its current paid period."}
                  </span>
                )}
                {order.service.cancellation.status === "processing" && (
                  <span>
                    {locale === "zh-CN"
                      ? `Provider 正在执行终止；Core 收到确认结果前，服务仍显示为 ${order.service.status}。`
                      : `Provider termination is in progress. The service remains ${order.service.status} until Core receives a confirmed external result.`}
                  </span>
                )}
                {order.service.cancellation.status === "unknown" && (
                  <span>
                    {locale === "zh-CN"
                      ? "Provider 结果未知。Core 只通过查询对账，不会发送第二次终止请求。"
                      : "The Provider result is unknown. Core is reconciling by query only and will not send a second terminate request."}
                  </span>
                )}
                {order.service.cancellation.status === "manual" && (
                  <span>
                    {locale === "zh-CN"
                      ? `需要管理员介入。服务仍显示为 ${order.service.status}，系统尚未把它标记为已终止。`
                      : `Administrator intervention is required. The service is still shown as ${order.service.status}; it has not been reported as terminated.`}
                  </span>
                )}
                {order.service.cancellation.status === "terminated" && (
                  <span>
                    {locale === "zh-CN"
                      ? "终止已经确认，服务现已终止。"
                      : "Termination was confirmed; the service is now terminated."}
                  </span>
                )}
                <span>
                  {locale === "zh-CN"
                    ? "不会生成下一张续费发票；此操作不会自动退款。"
                    : "No new renewal invoice will be generated. This action does not issue a refund."}
                </span>
                <span>
                  {locale === "zh-CN" ? "执行方式" : "Delivery"}: {cancellationExecutionLabel(order.service.cancellation.executionMode, locale)}
                  {order.service.cancellation.providerOperation
                    ? ` · Provider ${order.service.cancellation.providerOperation.status}/${order.service.cancellation.providerOperation.attempts}`
                    : locale === "zh-CN"
                      ? " · 不会自动调用 Provider"
                      : " · no automatic Provider mutation"}
                </span>
                {order.service.cancellation.lastError && (
                  <span>{order.service.cancellation.lastError}</span>
                )}
              </div>
            ) : canManageServices && order.service.termEnd &&
              (order.service.status === "active" || order.service.status === "suspended") &&
              !order.service.cancellation ? (
              <div
                className="payment-controls"
                aria-label={locale === "zh-CN" ? "安排服务取消" : "Schedule service cancellation"}
              >
                <p>
                  {locale === "zh-CN" ? "仅在当前已付账期结束时取消。服务保持可用至 " : "Cancel only at the end of the current paid period. Service stays available until "}
                  <strong>{new Date(order.service.termEnd).toLocaleString()}</strong>
                  {locale === "zh-CN"
                    ? "；此请求不会自动创建退款。"
                    : "; no refund is created by this request."}
                </p>
                <input
                  aria-label={locale === "zh-CN" ? "取消原因（可选）" : "Cancellation reason (optional)"}
                  value={cancellationReason}
                  onChange={(event) => setCancellationReason(event.target.value)}
                  placeholder={locale === "zh-CN" ? "取消原因（可选）" : "Cancellation reason (optional)"}
                />
                <button
                  disabled={
                    cancellationPending ||
                    (cancellationReason.trim().length > 0 &&
                      cancellationReason.trim().length < 3)
                  }
                  onClick={scheduleServiceCancellation}
                >
                  {cancellationPending
                    ? locale === "zh-CN"
                      ? "正在安排取消…"
                      : "Scheduling cancellation…"
                    : locale === "zh-CN"
                      ? "在已付账期结束时取消"
                      : "Cancel at paid period end"}
                </button>
              </div>
            ) : null}
          </section>
        )}

        {(route === "/" || route === "/customer") && (
        <section className="catalog">
          <p className="eyebrow">{text.catalog}</p>
          <h2>TermRat synthetic acceptance configuration</h2>
          {[...groups.entries()].map(([group, groupProducts]) => (
            <div className="product-group" key={group}>
              <h3>{group}</h3>
              <div className="product-grid">
                {groupProducts.map((product) => (
                  <article className="product-card" key={product.id}>
                    <div>
                      <span className={`mode mode-${product.fulfillmentMode}`}>
                        {product.fulfillmentMode}
                      </span>
                      <h4>{product.name}</h4>
                      <p>{product.description}</p>
                    </div>
                    <div className="prices">
                      {product.prices.map((price) => (
                        <button
                          key={price.id}
                          disabled={!product.purchasable}
                          onClick={() => setSelected({ product, price })}
                        >
                          <span>{price.billingCycle.replace("_", " ")}</span>
                          <strong>
                            {usd(
                              (
                                BigInt(price.oneTimeMinor) +
                                BigInt(price.setupMinor) +
                                BigInt(price.recurringMinor)
                              ).toString(),
                            )}
                          </strong>
                        </button>
                      ))}
                      {!product.purchasable && <p>Price confirmation required before payment.</p>}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          ))}
        </section>
        )}
      </main>

      {(route === "/" || route === "/customer") && selected && (
        <div className="modal-backdrop" role="presentation" onClick={() => setSelected(null)}>
          <section className="modal" role="dialog" onClick={(event) => event.stopPropagation()}>
            <button className="close" onClick={() => setSelected(null)}>
              ×
            </button>
            <p className="eyebrow">Checkout configuration</p>
            <h2>{selected.product.name}</h2>
            <p>
              {selected.price.billingCycle} ·{" "}
              {usd(
                (
                  BigInt(selected.price.oneTimeMinor) +
                  BigInt(selected.price.setupMinor) +
                  BigInt(selected.price.recurringMinor)
                ).toString(),
              )}
            </p>
            {selected.product.id === "gsl-inbound" && (
              <label>
                100 Mbps units
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={quantity}
                  onChange={(event) => setQuantity(Number(event.target.value))}
                />
              </label>
            )}
            <div className="legal-box">
              <strong>{legal?.documents.terms.title}</strong>
              <p>{legal?.documents.terms.body}</p>
              <strong>{legal?.documents.aup.title}</strong>
              <p>{legal?.documents.aup.body}</p>
            </div>
            {route === "/" ? (
              <button
                className="primary wide"
                onClick={() => {
                  setSelected(null);
                  openRoute("/customer");
                }}
              >
                Continue in customer workspace
              </button>
            ) : (
              <button className="primary wide" disabled={!canCreateOrders} onClick={createOrder}>
                {canCreateOrders ? text.buy : text.pending}
              </button>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function Status({ label, value }: { label: string; value: string }) {
  return (
    <div data-testid={`status-${label.toLowerCase().replaceAll(" ", "-")}`}>
      <span>{label}</span>
      <strong>{value.replaceAll("_", " ")}</strong>
    </div>
  );
}
