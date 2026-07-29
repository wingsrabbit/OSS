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
  currency: string;
  occurredAt: string;
  disposition: string;
  reason: string | null;
  suggestedInvoiceId: string | null;
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
  const [paymentQuote, setPaymentQuote] = useState<PaymentQuote | null>(null);
  const [addFundsPrincipalMinor, setAddFundsPrincipalMinor] = useState("5000");
  const [addFundsMethod, setAddFundsMethod] = useState("card");
  const [addFundsScenario, setAddFundsScenario] = useState("success");
  const [addFundsQuote, setAddFundsQuote] = useState<AddFundsQuote | null>(null);
  const [addFundsCommand, setAddFundsCommand] = useState<AddFundsCommand | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [mail, setMail] = useState<LabMessage[]>([]);
  const [manualItems, setManualItems] = useState<ManualItem[]>([]);
  const [unclaimedFunds, setUnclaimedFunds] = useState<UnclaimedFundItem[]>([]);
  const [adminPassword, setAdminPassword] = useState("");
  const [manualReason, setManualReason] = useState("");
  const [creditAdjustmentMinor, setCreditAdjustmentMinor] = useState("5000");
  const [creditAdjustmentReason, setCreditAdjustmentReason] = useState("");
  const [fundResolutionMinor, setFundResolutionMinor] = useState("");
  const [fundResolutionInvoiceId, setFundResolutionInvoiceId] = useState("");
  const [fundResolutionReason, setFundResolutionReason] = useState("");
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

  useEffect(() => {
    void Promise.all([refreshManualItems(), refreshUnclaimedFunds()]).catch(() => undefined);
  }, [refreshManualItems, refreshUnclaimedFunds]);

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
    if (fundResolutionInFlight.current.has(item.receiptId)) return;
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
      await api(`/api/v1/admin/funds/${item.receiptId}/resolutions`, {
        method: "POST",
        body: JSON.stringify({
          action,
          amountMinor: fundResolutionMinor,
          invoiceId,
          reason,
          idempotencyKey,
        }),
      });
      setNotice(
        action === "convert_to_credit"
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
              {unclaimedFunds.length === 0 ? (
                <p className="muted">No unclaimed funds are waiting.</p>
              ) : (
                <div data-testid="unclaimed-funds-list">
                  {unclaimedFunds.map((item) => (
                    <article
                      className="manual-item"
                      data-testid="unclaimed-fund-item"
                      key={item.receiptId}
                    >
                      <div>
                        <strong>
                          {item.clientAccountName} · remaining {usd(item.remainingMinor)}
                        </strong>
                        <span>
                          Received {usd(item.amountMinor)} via {item.providerInstallationId}
                        </span>
                        <span className="mono">{item.externalPaymentId}</span>
                        <span>{item.reason ?? "Awaiting operator classification"}</span>
                      </div>
                      <div className="fund-actions">
                        <button
                          className="primary"
                          disabled={
                            fundResolutionPendingReceiptIds.has(item.receiptId) ||
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
                            adminPassword.length === 0 ||
                            !/^[1-9]\d*$/.test(fundResolutionMinor) ||
                            fundResolutionReason.trim().length < 10 ||
                            (!fundResolutionInvoiceId && !item.suggestedInvoiceId)
                          }
                          onClick={() => resolveUnclaimedFunds(item, "allocate_invoice")}
                        >
                          Allocate amount to invoice
                        </button>
                      </div>
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
