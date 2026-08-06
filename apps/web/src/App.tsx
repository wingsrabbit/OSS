// SPDX-License-Identifier: AGPL-3.0-or-later

import { LAB_BANNER } from "@opensales/core";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Locale = "en" | "zh-CN";
type Me = {
  id: string;
  email: string;
  locale: Locale;
  clientAccountId: string;
  membershipRole: string;
  verification: { email: "pending" | "passed" };
  eligible: boolean;
  staff: { roles: string[]; permissions: unknown } | null;
};
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
  order: { id: string; status: string; price: { productName: string } };
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
  };
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
  productName: string;
  billingCycle: string;
  clientAccountName: string;
  paidMinor: string;
  totalMinor: string;
  submittedAt: string;
};
type UnclaimedFundItem = {
  receiptId: string;
  clientAccountId: string;
  clientAccountName: string;
  providerInstallationId: string;
  externalPaymentId: string;
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
  }>;
  addFunds: {
    enabled: boolean;
    allowed: boolean;
    minimumMinor: string;
    maximumMinor: string;
    balanceCapMinor: string;
  };
};
type RenewalReminder = {
  kind: "renewal_created" | "pre_due" | "overdue_first";
  offsetDays: number;
  status:
    | "queued"
    | "delivered"
    | "bounced"
    | "failed"
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
  status: "open" | "partially_paid" | "paid";
  fundingStatus: "open" | "partially_paid" | "paid";
  renewalStatus: "invoiced" | "paid" | "manual_hold";
  fundedAt: string | null;
  dueAt: string;
  periodStart: string;
  periodEnd: string;
  settledAt: string | null;
  version: number;
  reminders: RenewalReminder[];
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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    throw new Error(errorBody.error ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function usd(minor: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(minor) / 100);
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

export function App() {
  const [locale, setLocale] = useState<Locale>("en");
  const [products, setProducts] = useState<Product[]>([]);
  const [legal, setLegal] = useState<Legal | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [selected, setSelected] = useState<{ product: Product; price: Price } | null>(null);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [notice, setNotice] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [paymentScenario, setPaymentScenario] = useState("success");
  const [paymentMethod, setPaymentMethod] = useState("card");
  const [applyCredit, setApplyCredit] = useState(true);
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [renewals, setRenewals] = useState<RenewalItem[]>([]);
  const [adminRenewals, setAdminRenewals] = useState<AdminRenewalItem[]>([]);
  const [renewalPaymentPendingId, setRenewalPaymentPendingId] = useState<string | null>(null);
  const [automationEffectiveAt, setAutomationEffectiveAt] = useState("");
  const [automationReason, setAutomationReason] = useState("");
  const [renewalHoldReason, setRenewalHoldReason] = useState("");
  const [renewalHoldPendingId, setRenewalHoldPendingId] = useState<string | null>(null);
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
  const [bootstrapToken, setBootstrapToken] = useState("");
  const text = words[locale];

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api<Me>("/api/v1/auth/me"));
    } catch {
      setMe(null);
    }
  }, []);

  const refreshBilling = useCallback(async () => {
    if (!me) {
      setBilling(null);
      return;
    }
    setBilling(await api<BillingSummary>("/api/v1/billing/summary"));
  }, [me]);

  const refreshRenewals = useCallback(async (): Promise<RenewalItem[]> => {
    if (!me?.eligible) {
      setRenewals([]);
      return [];
    }
    const result = await api<{ items: RenewalItem[] }>("/api/v1/billing/renewals");
    setRenewals(result.items);
    return result.items;
  }, [me?.eligible]);

  const refreshAdminRenewals = useCallback(async (): Promise<AdminRenewalItem[]> => {
    if (!me?.staff) {
      setAdminRenewals([]);
      return [];
    }
    const result = await api<{ items: AdminRenewalItem[] }>(
      "/api/v1/admin/billing/renewals",
    );
    setAdminRenewals(result.items);
    return result.items;
  }, [me?.staff]);

  const refreshChargebackStatus = useCallback(async () => {
    if (!me) {
      setChargebackStatus(null);
      return;
    }
    setChargebackStatus(
      await api<ChargebackStatus>("/api/v1/billing/chargeback-status"),
    );
  }, [me]);

  useEffect(() => {
    void Promise.all([
      api<{ products: Product[] }>(`/api/v1/catalog?locale=${locale}`).then((data) =>
        setProducts(data.products),
      ),
      api<Legal>(`/api/v1/legal/current?locale=${locale}`).then(setLegal),
      refreshMe(),
    ]).catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : "Unable to load the laboratory"),
    );
  }, [locale, refreshMe]);

  useEffect(() => {
    void refreshBilling().catch(() => undefined);
  }, [refreshBilling]);

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
      !me?.eligible ||
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
    me?.eligible,
  ]);

  useEffect(() => {
    if (
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
  }, [addFundsCommand, refreshBilling]);

  useEffect(() => {
    if (!order || order.invoice.status === "paid" || !me?.eligible) {
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
  }, [applyCredit, billing?.creditBalanceMinor, me?.eligible, order?.invoice.id, order?.invoice.status, paymentMethod]);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) return;
    void api<{ status: string }>("/api/v1/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ token }),
    })
      .then(async (result) => {
        const visibleStatus = result.status === "already_verified" ? "verified" : result.status;
        setNotice(`Email verification: ${visibleStatus}`);
        window.history.replaceState({}, "", window.location.pathname);
        await refreshMe();
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : "Verification failed"),
      );
  }, [refreshMe]);

  useEffect(() => {
    if (
      !order ||
      ["active", "provisioned_hold", "provision_failed"].includes(order.service.status)
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void api<OrderDetail>(`/api/v1/orders/${order.order.id}`)
        .then(setOrder)
        .catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [order]);

  const refreshManualItems = useCallback(async () => {
    if (!me?.staff) {
      setManualItems([]);
      return;
    }
    const result = await api<{ items: ManualItem[] }>("/api/v1/admin/manual-fulfillment");
    setManualItems(result.items);
  }, [me?.staff]);

  const refreshUnclaimedFunds = useCallback(async () => {
    if (!me?.staff) {
      setUnclaimedFunds([]);
      return;
    }
    const result = await api<{ items: UnclaimedFundItem[] }>("/api/v1/admin/funds/unclaimed");
    setUnclaimedFunds(result.items);
  }, [me?.staff]);

  const refreshRefundCandidates = useCallback(async () => {
    if (!me?.staff) {
      setRefundCandidates([]);
      return;
    }
    const result = await api<{ items: RefundCandidate[] }>("/api/v1/admin/refund-candidates");
    setRefundCandidates(result.items);
  }, [me?.staff]);

  const refreshRefundRecords = useCallback(async () => {
    if (!me?.staff) {
      setRefundRecords({});
      return;
    }
    const result = await api<{ items: RefundRecord[] }>("/api/v1/admin/refunds");
    setRefundRecords(
      Object.fromEntries(result.items.map((refund) => [refund.refundId, refund])),
    );
  }, [me?.staff]);

  const refreshRefundSecurityHolds = useCallback(async () => {
    if (!me?.staff) {
      setRefundSecurityHolds([]);
      return;
    }
    const result = await api<{ items: RefundSecurityHold[] }>(
      "/api/v1/admin/refund-security-holds",
    );
    setRefundSecurityHolds(result.items);
  }, [me?.staff]);

  const refreshRefundDismissalCorrections = useCallback(async () => {
    if (!me?.staff) {
      setRefundDismissalCorrections([]);
      return;
    }
    const result = await api<{ items: RefundDismissalCorrection[] }>(
      "/api/v1/admin/refund-dismissal-corrections",
    );
    setRefundDismissalCorrections(result.items);
  }, [me?.staff]);

  const refreshRefundReceiptCapacityIncidents = useCallback(async () => {
    if (!me?.staff) {
      setRefundReceiptCapacityIncidents([]);
      return;
    }
    const result = await api<{ items: RefundReceiptCapacityIncident[] }>(
      "/api/v1/admin/refund-receipt-capacity-incidents",
    );
    setRefundReceiptCapacityIncidents(result.items);
  }, [me?.staff]);

  const refreshAdminChargebacks = useCallback(async () => {
    if (!me?.staff) {
      setAdminChargebacks([]);
      setAdminUnclaimedChargebacks([]);
      setAdminChargebackHolds([]);
      return;
    }
    const result = await api<{
      items: AddFundsChargeback[];
      unclaimedChargebacks: AddFundsUnclaimedChargeback[];
      manualHolds: AddFundsChargebackHold[];
    }>("/api/v1/admin/add-funds-chargebacks");
    setAdminChargebacks(result.items);
    setAdminUnclaimedChargebacks(result.unclaimedChargebacks);
    setAdminChargebackHolds(result.manualHolds);
  }, [me?.staff]);

  useEffect(() => {
    void Promise.all([
      refreshManualItems(),
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
    refreshRefundCandidates,
    refreshRefundRecords,
    refreshRefundSecurityHolds,
    refreshRefundDismissalCorrections,
    refreshRefundReceiptCapacityIncidents,
    refreshAdminChargebacks,
    refreshUnclaimedFunds,
  ]);

  useEffect(() => {
    const active = Object.values(refundRecords).filter((refund) =>
      ["queued", "processing", "unknown"].includes(refund.status),
    );
    if (active.length === 0) return;
    const timer = window.setInterval(() => {
      void Promise.all(
        active.map((refund) =>
          api<RefundRecord>(`/api/v1/admin/refunds/${refund.refundId}`).then((updated) => {
            setRefundRecords((current) => ({ ...current, [updated.refundId]: updated }));
          }),
        ),
      )
        .then(() =>
          Promise.all([
            refreshRefundCandidates(),
            refreshRefundSecurityHolds(),
            refreshUnclaimedFunds(),
          ]),
        )
        .catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [
    refundRecords,
    refreshRefundCandidates,
    refreshRefundSecurityHolds,
    refreshUnclaimedFunds,
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

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      await api("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: data.get("email"), password: data.get("password") }),
      });
      await refreshMe();
      setNotice("Signed in.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign in failed");
    }
  }

  async function createOrder() {
    if (!selected || !legal) return;
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
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      setOrder(await api<OrderDetail>(`/api/v1/orders/${created.orderId}`));
      setSelected(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Checkout failed");
    }
  }

  async function startPayment() {
    if (!order) return;
    setError("");
    try {
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
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      setOrder(await api<OrderDetail>(`/api/v1/orders/${order.order.id}`));
      await refreshBilling();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Payment could not start");
    }
  }

  async function startRenewalPayment(renewal: RenewalItem) {
    if (renewal.status === "paid" || renewalPaymentPendingId) return;
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
      await api(`/api/v1/invoices/${renewal.invoiceId}/payments`, {
        method: "POST",
        body: JSON.stringify({
          quoteId: quote.quoteId,
          scenario: paymentScenario,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      paymentStarted = true;
      setNotice(
        "Mock renewal payment started. The service term changes only after real allocations fully settle the invoice.",
      );
      for (let poll = 0; poll < 12; poll += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        const current = await refreshRenewals();
        if (current.find((item) => item.renewalId === renewal.renewalId)?.status === "paid") {
          break;
        }
      }
      await Promise.all([refreshBilling(), refreshAdminRenewals()]);
    } catch (caught) {
      setError(
        paymentStarted
          ? "The payment was accepted, but its current status could not be refreshed. Check the renewal again before retrying."
          : caught instanceof Error
            ? caught.message
            : "Renewal payment could not start",
      );
    } finally {
      setRenewalPaymentPendingId(null);
    }
  }

  async function runBillingAutomation() {
    if (!me?.staff || automationReason.trim().length < 10) return;
    setError("");
    try {
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      setAdminPassword("");
      const result = await api<{
        businessDate: string;
        invoicesCreated: number;
        remindersCreated: number;
        replayed: boolean;
      }>("/api/v1/admin/billing/automation/run", {
        method: "POST",
        body: JSON.stringify({
          reason: automationReason.trim(),
          idempotencyKey: crypto.randomUUID(),
          ...(automationEffectiveAt
            ? { effectiveAt: new Date(automationEffectiveAt).toISOString() }
            : {}),
        }),
      });
      setAutomationReason("");
      await Promise.all([refreshRenewals(), refreshAdminRenewals()]);
      setNotice(
        `${result.replayed ? "Replayed" : "Completed"} Asia/Shanghai billing day ${result.businessDate}: ${result.invoicesCreated} invoice(s), ${result.remindersCreated} reminder(s).`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Billing automation failed");
    }
  }

  async function resolveRenewalHold(renewal: AdminRenewalItem) {
    if (
      !me?.staff ||
      renewal.renewalStatus !== "manual_hold" ||
      renewalHoldReason.trim().length < 10 ||
      renewalHoldPendingId
    ) {
      return;
    }
    setError("");
    setRenewalHoldPendingId(renewal.renewalId);
    try {
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      setAdminPassword("");
      await api(`/api/v1/admin/billing/renewals/${renewal.renewalId}/resolve-hold`, {
        method: "POST",
        body: JSON.stringify({
          action: "grant_period",
          reason: renewalHoldReason.trim(),
          expectedVersion: renewal.version,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      setRenewalHoldReason("");
      await Promise.all([refreshRenewals(), refreshAdminRenewals()]);
      setNotice("The funded renewal Hold was reviewed and the exact service period was granted.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Renewal Hold could not be resolved");
    } finally {
      setRenewalHoldPendingId(null);
    }
  }

  async function startAddFunds() {
    if (!addFundsQuote) return;
    setError("");
    try {
      const created = await api<{
        commandId: string;
      }>("/api/v1/billing/add-funds", {
        method: "POST",
        body: JSON.stringify({
          quoteId: addFundsQuote.quoteId,
          scenario: addFundsScenario,
          idempotencyKey: crypto.randomUUID(),
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

  async function bootstrapAdministrator() {
    setError("");
    try {
      await api("/api/v1/admin/bootstrap", {
        method: "POST",
        body: JSON.stringify({ bootstrapToken }),
      });
      setBootstrapToken("");
      await refreshMe();
      setNotice("Administrator role created. The bootstrap token is now unusable.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Administrator bootstrap failed");
    }
  }

  async function completeManual(serviceId: string) {
    setError("");
    try {
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      setAdminPassword("");
      await api(`/api/v1/admin/services/${serviceId}/complete-manual`, {
        method: "POST",
        body: JSON.stringify({ reason: manualReason }),
      });
      setAdminPassword("");
      setManualReason("");
      await refreshManualItems();
      setNotice("Manual service marked Ready for Service with an audited activation time.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Manual fulfillment failed");
    }
  }

  async function adjustCredit(direction: "increase" | "decrease") {
    if (!me?.staff) return;
    setError("");
    try {
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      setAdminPassword("");
      await api(`/api/v1/admin/client-accounts/${me.clientAccountId}/credit-adjustments`, {
        method: "POST",
        body: JSON.stringify({
          direction,
          amountMinor: creditAdjustmentMinor,
          currency: "USD",
          reason: creditAdjustmentReason,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      await refreshBilling();
      setNotice(`Credit ${direction} recorded with a balanced journal and audit event.`);
      setCreditAdjustmentReason("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Credit adjustment failed");
    }
  }

  async function resolveUnclaimedFunds(
    item: UnclaimedFundItem,
    action: "convert_to_credit" | "allocate_invoice",
  ) {
    if (!me?.staff) return;
    if (
      fundResolutionInFlight.current.has(item.receiptId) ||
      refundInFlight.current.has(item.receiptId)
    ) {
      return;
    }
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
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      setAdminPassword("");
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
        refreshUnclaimedFunds(),
        ...(item.clientAccountId === me.clientAccountId ? [refreshBilling()] : []),
      ]);
      if (refreshResults.some((result) => result.status === "rejected")) {
        setError("The resolution was saved, but current balances could not be refreshed.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Fund resolution failed");
    } finally {
      fundResolutionInFlight.current.delete(item.receiptId);
      setFundResolutionPendingReceiptIds((current) => {
        const next = new Set(current);
        next.delete(item.receiptId);
        return next;
      });
    }
  }

  async function returnUnclaimedFunds(item: UnclaimedFundItem) {
    if (
      !me?.staff ||
      refundInFlight.current.has(item.receiptId) ||
      fundResolutionInFlight.current.has(item.receiptId)
    ) {
      return;
    }
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
        refundIntentKeys.current.get(identity) ?? storedKey ?? crypto.randomUUID();
      refundIntentKeys.current.set(identity, idempotencyKey);
      try {
        window.localStorage.setItem(storageKey, idempotencyKey);
      } catch {
        // The in-memory key still makes repeated clicks replay the same request.
      }
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      setAdminPassword("");
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
      setRefundRecords((current) => ({ ...current, [refund.refundId]: refund }));
      setNotice(
        refund.replayed
          ? "The same unclaimed-funds return was replayed; no second Provider request was created."
          : "Return to the original payment requested. Funds remain reserved until the Provider result is known.",
      );
      setFundReturnAmountMinor("");
      setFundReturnReason("");
      await Promise.all([refreshUnclaimedFunds(), refreshRefundRecords()]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unclaimed-funds return failed");
    } finally {
      refundInFlight.current.delete(item.receiptId);
      setRefundPendingReceiptIds((current) => {
        const next = new Set(current);
        next.delete(item.receiptId);
        return next;
      });
    }
  }

  async function decideRefund(
    item: RefundCandidate,
    destination: "original_payment" | "credit" | "none",
  ) {
    if (!me?.staff || refundInFlight.current.has(item.receiptId)) return;
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
        refundIntentKeys.current.get(identity) ?? storedKey ?? crypto.randomUUID();
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
        refreshRefundCandidates(),
        ...(item.clientAccountId === me.clientAccountId ? [refreshBilling()] : []),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Refund decision failed");
    } finally {
      refundInFlight.current.delete(item.receiptId);
      setRefundPendingReceiptIds((current) => {
        const next = new Set(current);
        next.delete(item.receiptId);
        return next;
      });
    }
  }

  async function adjudicateRefundHold(
    hold: RefundSecurityHold,
    decision:
      | "accept_authorized_outflow"
      | "record_unexpected_outflow"
      | "dismiss_provider_claim",
  ) {
    if (!me?.staff || refundAdjudicationInFlight.current.has(hold.holdId)) return;
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
      idempotencyKey ??= crypto.randomUUID();
      try {
        window.localStorage.setItem(storageKey, idempotencyKey);
      } catch {
        // The server-side decision fingerprint still prevents duplicate adjudication.
      }
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
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
        refreshRefundSecurityHolds(),
        refreshRefundDismissalCorrections(),
        refreshRefundReceiptCapacityIncidents(),
        refreshRefundCandidates(),
        refreshRefundRecords(),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Refund hold adjudication failed");
    } finally {
      refundAdjudicationInFlight.current.delete(hold.holdId);
      setRefundAdjudicationPendingIds((current) => {
        const next = new Set(current);
        next.delete(hold.holdId);
        return next;
      });
    }
  }

  async function recoverManualRefund(
    refund: RefundRecord,
    action: "retry_query" | "confirm_no_outflow",
  ) {
    if (!me?.staff || refundManualActionInFlight.current.has(refund.refundId)) return;
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
      idempotencyKey ??= crypto.randomUUID();
      try {
        window.localStorage.setItem(storageKey, idempotencyKey);
      } catch {
        // The stable in-flight identity and server key still protect the current action.
      }
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
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
      setNotice(
        result.replayed
          ? "The same manual refund action was replayed; no duplicate query or decision occurred."
          : action === "retry_query"
            ? "Query-only Provider reconciliation scheduled; the refund create request will not be sent again."
            : "No Provider outflow was confirmed with an audited reason; a late success will still enter security hold.",
      );
      setRefundReason("");
      await Promise.all([
        refreshRefundRecords(),
        refreshRefundCandidates(),
        refreshRefundSecurityHolds(),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Manual refund action failed");
    } finally {
      refundManualActionInFlight.current.delete(refund.refundId);
      setRefundManualActionPendingIds((current) => {
        const next = new Set(current);
        next.delete(refund.refundId);
        return next;
      });
    }
  }

  async function correctDismissedRefundOutflow(item: RefundDismissalCorrection) {
    if (!me?.staff || refundCorrectionInFlight.current.has(item.adjudicationId)) return;
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
      idempotencyKey ??= crypto.randomUUID();
      try {
        window.localStorage.setItem(storageKey, idempotencyKey);
      } catch {
        // The stable server fingerprint still protects this correction.
      }
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
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
      setNotice(
        result.replayed
          ? "The same dismissal correction was replayed; cash and capacity were not reduced twice."
          : "The later-confirmed Provider outflow was restored to discrepancy suspense and same-currency refund capacity.",
      );
      setRefundReason("");
      await Promise.all([
        refreshRefundDismissalCorrections(),
        refreshRefundReceiptCapacityIncidents(),
        refreshRefundSecurityHolds(),
        refreshRefundCandidates(),
        refreshRefundRecords(),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Refund dismissal correction failed");
    } finally {
      refundCorrectionInFlight.current.delete(item.adjudicationId);
      setRefundCorrectionPendingIds((current) => {
        const next = new Set(current);
        next.delete(item.adjudicationId);
        return next;
      });
    }
  }

  async function acknowledgeRefundReceiptCapacityIncident(
    incident: RefundReceiptCapacityIncident,
  ) {
    if (
      !me?.staff ||
      refundCapacityAcknowledgementInFlight.current.has(incident.incidentId)
    ) {
      return;
    }
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
      idempotencyKey ??= crypto.randomUUID();
      try {
        window.localStorage.setItem(storageKey, idempotencyKey);
      } catch {
        // The stable server fingerprint still protects this acknowledgement.
      }
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
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
      setNotice(
        result.replayed
          ? "The same receipt overage acknowledgement was replayed; no financial fact changed."
          : "Receipt overage acknowledged; manual financial recovery remains outstanding and visible.",
      );
      setRefundReason("");
      await Promise.all([
        refreshRefundReceiptCapacityIncidents(),
        refreshRefundCandidates(),
        refreshRefundRecords(),
      ]);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Refund receipt capacity acknowledgement failed",
      );
    } finally {
      refundCapacityAcknowledgementInFlight.current.delete(incident.incidentId);
      setRefundCapacityAcknowledgementPendingIds((current) => {
        const next = new Set(current);
        next.delete(incident.incidentId);
        return next;
      });
    }
  }

  return (
    <>
      <div className="lab-banner">{LAB_BANNER}</div>
      <header>
        <a className="brand" href="/">
          <span>OSS</span>
          OpenSales System
        </a>
        <div className="header-actions">
          <button onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")}>
            {locale === "en" ? "简体中文" : "English"}
          </button>
          <span className={me?.eligible ? "pill good" : "pill"}>
            {me ? me.email : "Guest"}
          </span>
        </div>
      </header>
      <main>
        <section className="hero">
          <p className="eyebrow">Mock-only laboratory release</p>
          <h1>Customer, billing and service operations — without vendor lock-in.</h1>
          <p>
            This synthetic environment separates orders, money, provider operations and services so
            that failures remain visible and recoverable.
          </p>
        </section>

        {(notice || error) && (
          <div className={error ? "notice error" : "notice"}>
            {error || notice}
            <button onClick={() => (error ? setError("") : setNotice(""))}>×</button>
          </div>
        )}

        <section className="account-grid">
          <div className="panel">
            <p className="eyebrow">{text.account}</p>
            {me ? (
              <>
                <h2>{me.email}</h2>
                <p>{me.eligible ? text.ready : text.pending}</p>
                <div className="status-row">
                  <span>Email verification</span>
                  <strong>{me.verification.email}</strong>
                </div>
                {!me.eligible && (
                  <>
                    <button className="primary" onClick={openLabMailbox}>
                      Open my Mock Provider mailbox
                    </button>
                    {mail.map((message) => {
                      const verificationUrl = message.body.match(/https?:\/\/\S+/)?.[0];
                      return (
                        <div className="mock-message" key={message.id}>
                          <strong>{message.subject}</strong>
                          <span>
                            {message.status} · {new Date(message.deliveredAt).toLocaleString()}
                          </span>
                          {verificationUrl && <a href={verificationUrl}>Use one-time verification link</a>}
                        </div>
                      );
                    })}
                  </>
                )}
              </>
            ) : (
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
                </form>
              </div>
            )}
          </div>
        </section>

        {me &&
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

        {me?.eligible && renewals.length > 0 && (
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
                    <span>
                      Reminders: {" "}
                      {renewal.reminders.length === 0
                        ? "none yet"
                        : renewal.reminders
                            .map((reminder) => `${reminderLabel(reminder)} (${reminder.status})`)
                            .join(", ")}
                    </span>
                  </div>
                  {renewal.status !== "paid" && (
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

        {me?.eligible && billing?.addFunds.enabled && (
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

        {me?.eligible && !me.staff && (
          <section className="bootstrap-panel">
            <div>
              <p className="eyebrow">One-time laboratory setup</p>
              <h2>Establish the first administrator</h2>
              <p>
                Generate a 15-minute, single-use token with the server-side CLI. There is no fixed
                default administrator password.
              </p>
            </div>
            <div className="inline-form">
              <input
                type="password"
                value={bootstrapToken}
                onChange={(event) => setBootstrapToken(event.target.value)}
                placeholder="Single-use bootstrap token"
              />
              <button
                className="primary"
                disabled={bootstrapToken.length < 32}
                onClick={bootstrapAdministrator}
              >
                Create administrator
              </button>
            </div>
          </section>
        )}

        {me?.staff && (
          <section className="admin-panel">
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
                <h3>Renewal generation and reminders</h3>
                <p>
                  This run creates the next non-overlapping invoice 14 days before paid-through and
                  queues the configured pre-due and first overdue reminders. The laboratory time
                  override is synthetic acceptance control, not a production clock setting. The
                  unattended 09:00 scheduler is not enabled in this laboratory slice yet.
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
                            : ""}
                        </span>
                        <span>
                          Notification delivery: {" "}
                          {renewal.reminders.length === 0
                            ? "none"
                            : renewal.reminders
                                .map((reminder) => `${reminderLabel(reminder)}=${reminder.status}`)
                                .join(", ")}
                        </span>
                      </div>
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
            {manualItems.length === 0 ? (
              <p className="muted">No paid manual services are waiting.</p>
            ) : (
              <>
                <div className="inline-form admin-confirm">
                  <input
                    value={manualReason}
                    onChange={(event) => setManualReason(event.target.value)}
                    placeholder="Reason and delivery evidence (10+ characters)"
                  />
                </div>
                {manualItems.map((item) => (
                  <article className="manual-item" key={item.serviceId}>
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
                      onClick={() => completeManual(item.serviceId)}
                    >
                      Confirm Ready for Service
                    </button>
                  </article>
                ))}
              </>
            )}
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
                      key={item.receiptId}
                    >
                      <div>
                        <strong>
                          {item.clientAccountName} · actionable {usd(item.availableMinor)}
                        </strong>
                        <span>
                          Received {usd(item.amountMinor)} via {item.providerInstallationId}
                        </span>
                        <span>
                          Allocated {usd(item.allocatedMinor)} · pending return{" "}
                          {usd(item.reservedRefundMinor)} · confirmed returned{" "}
                          {usd(item.confirmedOutflowMinor)}
                        </span>
                        <span className="mono">{item.externalPaymentId}</span>
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
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
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
              </div>
              <button
                onClick={() =>
                  void Promise.all([
                    refreshRefundCandidates(),
                    refreshRefundRecords(),
                    refreshRefundSecurityHolds(),
                    refreshRefundDismissalCorrections(),
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
              {refundCandidates.length === 0 ? (
                <p className="muted">No fully allocated invoice receipt is currently refundable.</p>
              ) : (
                <div data-testid="refund-candidate-list">
                  {refundCandidates.map((item) => {
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
              {refundReceiptCapacityIncidents.length > 0 && (
                <div data-testid="refund-receipt-capacity-incident-list">
                  <h4>Receipt compensation overages requiring manual recovery</h4>
                  <p className="muted">
                    Every refund or Credit compensation remains an established fact. For each
                    receipt, only the latest cumulative snapshot is the current recovery amount;
                    older snapshots remain visible as history and must not be added together.
                  </p>
                  {refundReceiptCapacityIncidents.map((incident) => {
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
              {refundSecurityHolds.length > 0 && (
                <div data-testid="refund-security-hold-list">
                  <h4>Provider facts requiring human adjudication</h4>
                  <p className="muted">
                    Review the immutable fact and impact. Provider callbacks cannot close these
                    holds. Your password confirmation and the reason above are required.
                  </p>
                  {refundSecurityHolds.map((hold) => {
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
              {refundDismissalCorrections.length > 0 && (
                <div data-testid="refund-dismissal-correction-list">
                  <h4>Dismissed Provider facts that can be corrected</h4>
                  <p className="muted">
                    Use this only after later authoritative evidence confirms the dismissed cash
                    outflow. The prior decision stays immutable; this adds a compensating journal
                    and reserves same-currency receipt capacity.
                  </p>
                  {refundDismissalCorrections.map((item) => {
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
              {Object.values(refundRecords).length > 0 && (
                <div data-testid="refund-status-list">
                  {Object.values(refundRecords).map((refund) => (
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
          </section>
        )}

        {order && (
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
            {order.invoice.status !== "paid" && (
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
                  disabled={!me?.eligible || !paymentQuote}
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
          </section>
        )}

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
      </main>

      {selected && (
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
            <button className="primary wide" disabled={!me?.eligible} onClick={createOrder}>
              {me?.eligible ? text.buy : text.pending}
            </button>
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
