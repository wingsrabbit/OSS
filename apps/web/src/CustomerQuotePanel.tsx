// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import type { CommerceQuote } from "./AdminCommercePanel.js";

type Locale = "en" | "zh-CN";

export type CustomerQuoteLegalDocuments = Readonly<{
  requestedLocale: Locale;
  documents: Readonly<Record<"terms" | "aup", Readonly<{
    documentId: string;
    locale: Locale;
    version: string;
    title: string;
    body: string;
  }>>>;
}>;

type AcceptancePreview = Readonly<{
  warning: string;
  quote: CommerceQuote;
  acceptance: Readonly<{
    eligible: true;
    invoiceTotalMinor: string;
    zeroAmount: boolean;
    terms: Readonly<{ id: string; version: string; locale: Locale }>;
    aup: Readonly<{ id: string; version: string; locale: Locale }>;
    supply: Readonly<{
      mode: "unlimited" | "tracked" | "manual_review";
      units: string;
      availableUnits: string | null;
      committedUnits: string;
      version: string | null;
    }>;
    promotionAvailable: boolean;
    marketingConsentDefault: false;
    marketingConsentPolicyVersion: string;
  }>;
}>;

export type QuoteAcceptanceResult = Readonly<{
  acceptanceId: string;
  quoteId: string;
  orderId: string;
  invoiceId: string;
  serviceId: string;
  orderStatus: string;
  replayed: boolean;
}>;

function when(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function usd(minor: string): string {
  const value = BigInt(minor);
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}$${(absolute / 100n).toLocaleString("en-US")}.${(absolute % 100n)
    .toString()
    .padStart(2, "0")}`;
}

function stableAcceptanceKey(quoteId: string): string {
  const storageKey = `opensales:quote-acceptance:v1:${quoteId}`;
  const existing = window.localStorage.getItem(storageKey);
  if (existing) return existing;
  const created = `accept-quote-${crypto.randomUUID()}`;
  window.localStorage.setItem(storageKey, created);
  return created;
}

function clearAcceptanceKey(quoteId: string): void {
  window.localStorage.removeItem(`opensales:quote-acceptance:v1:${quoteId}`);
}

type MarketingConsentState = Readonly<{
  granted: boolean;
  policyVersion: string;
  recordedAt: string | null;
  defaulted: boolean;
}>;

const DEFAULT_MARKETING_CONSENT: MarketingConsentState = {
  granted: false,
  policyVersion: "",
  recordedAt: null,
  defaulted: true,
};

function marketingWithdrawalStorageKey(viewerId: string, clientAccountId: string): string {
  return `opensales:marketing-consent-withdrawal:v1:${viewerId}:${clientAccountId}`;
}

function stableMarketingWithdrawalKey(viewerId: string, clientAccountId: string): string {
  const storageKey = marketingWithdrawalStorageKey(viewerId, clientAccountId);
  const existing = window.localStorage.getItem(storageKey);
  if (existing) return existing;
  const created = `withdraw-marketing-${crypto.randomUUID()}`;
  window.localStorage.setItem(storageKey, created);
  return created;
}

export function MarketingConsentPanel({
  active,
  locale,
  viewerId,
  clientAccountId,
  accessFingerprint,
  canRead,
  canWithdraw,
  onNotice,
  onError,
}: Readonly<{
  active: boolean;
  locale: Locale;
  viewerId: string;
  clientAccountId: string | null;
  accessFingerprint: string;
  canRead: boolean;
  canWithdraw: boolean;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}>) {
  const [consent, setConsent] = useState<MarketingConsentState>(DEFAULT_MARKETING_CONSENT);
  const [loading, setLoading] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const generation = useRef(0);
  const activeAccount = useRef(clientAccountId);
  const zh = locale === "zh-CN";

  const loadConsent = useCallback(async (reportFailure = true): Promise<boolean> => {
    if (!active || !canRead || !clientAccountId) return false;
    const accountId = clientAccountId;
    const requestGeneration = ++generation.current;
    setLoading(true);
    try {
      const result = await api<MarketingConsentState>("/api/v1/marketing-consent");
      if (generation.current === requestGeneration && activeAccount.current === accountId) {
        setConsent(result);
      }
      return true;
    } catch (caught) {
      if (generation.current === requestGeneration && activeAccount.current === accountId) {
        setConsent(DEFAULT_MARKETING_CONSENT);
        if (reportFailure) {
          onError(caught instanceof Error ? caught.message : "Marketing Consent could not be loaded");
        }
      }
      return false;
    } finally {
      if (generation.current === requestGeneration && activeAccount.current === accountId) {
        setLoading(false);
      }
    }
  }, [active, canRead, clientAccountId, onError]);

  useEffect(() => {
    generation.current += 1;
    activeAccount.current = clientAccountId;
    setConsent(DEFAULT_MARKETING_CONSENT);
    setLoading(false);
    setWithdrawing(false);
    if (active && canRead && clientAccountId) void loadConsent();
    return () => { generation.current += 1; };
  }, [accessFingerprint, active, canRead, clientAccountId, loadConsent]);

  async function withdrawConsent() {
    if (!active || !canWithdraw || !clientAccountId || !consent.granted || withdrawing) return;
    const accountId = clientAccountId;
    const storageKey = marketingWithdrawalStorageKey(viewerId, accountId);
    setWithdrawing(true);
    try {
      await api<{ consentEventId: string; granted: false }>("/api/v1/marketing-consent/withdraw", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: stableMarketingWithdrawalKey(viewerId, accountId),
        }),
      });
      if (activeAccount.current !== accountId) return;
      window.localStorage.removeItem(storageKey);
      setConsent((current) => ({
        ...current,
        granted: false,
        recordedAt: new Date().toISOString(),
        defaulted: false,
      }));
      onNotice(zh ? "营销同意已撤回。" : "Marketing Consent withdrawn.");
      const refreshed = await loadConsent(false);
      if (!refreshed && activeAccount.current === accountId) {
        onError(
          zh
            ? "营销同意已撤回，但最新状态刷新失败；请手动刷新。"
            : "Marketing Consent was withdrawn, but the latest state could not be refreshed. Refresh manually.",
        );
      }
    } catch (caught) {
      if (activeAccount.current === accountId) {
        onError(caught instanceof Error ? caught.message : "Marketing Consent withdrawal failed");
      }
    } finally {
      if (activeAccount.current === accountId) setWithdrawing(false);
    }
  }

  if (!active || !canRead || !clientAccountId) return null;

  return (
    <section
      className="order-panel marketing-consent-panel"
      data-testid="marketing-consent-panel"
      aria-label={zh ? "营销同意" : "Marketing Consent"}
    >
      <div>
        <p className="eyebrow">Customer · Preferences · Mock-only</p>
        <h2>{zh ? "营销同意" : "Marketing Consent"}</h2>
        <p className="muted">
          {zh
            ? "默认关闭。Quote 接受流程中的可选选择会记录当前政策版本，并可随时在此撤回。"
            : "Off by default. The optional choice during Quote acceptance records the current policy version and can be withdrawn here at any time."}
        </p>
      </div>
      <div className="consent-status" role="status" aria-live="polite">
        <span>{zh ? "当前状态" : "Current state"}</span>
        <strong>{consent.granted ? (zh ? "已同意" : "Granted") : (zh ? "关闭" : "Off")}</strong>
        <span>
          {consent.defaulted
            ? (zh ? "尚无记录；使用默认关闭。" : "No recorded choice; the default is off.")
            : `${consent.policyVersion || "—"} · ${when(consent.recordedAt)}`}
        </span>
      </div>
      <div className="button-row">
        <button type="button" disabled={loading || withdrawing} onClick={() => void loadConsent()}>
          {loading ? (zh ? "加载中…" : "Loading…") : (zh ? "刷新状态" : "Refresh state")}
        </button>
        {consent.granted && (
          <button
            type="button"
            className="danger"
            disabled={!canWithdraw || withdrawing}
            onClick={() => void withdrawConsent()}
          >
            {withdrawing ? (zh ? "正在撤回…" : "Withdrawing…") : (zh ? "撤回营销同意" : "Withdraw Marketing Consent")}
          </button>
        )}
      </div>
    </section>
  );
}

function statusCopy(status: CommerceQuote["status"], locale: Locale): string {
  if (locale === "en") return status;
  return {
    draft: "待接受",
    expired: "已过期",
    void: "已作废",
    accepted: "已接受",
  }[status];
}

function QuoteFacts({ quote, locale }: Readonly<{ quote: CommerceQuote; locale: Locale }>) {
  const zh = locale === "zh-CN";
  return (
    <>
      <strong>{quote.productName} · {statusCopy(quote.status, locale)}</strong>
      <span>{quote.currency} {usd(quote.totalMinor)} · {quote.billingCycle}</span>
      <span>{zh ? "一次性" : "One-time"}: {usd(quote.oneTimeMinor)} · Setup: {usd(quote.setupMinor)} · {zh ? "循环" : "Recurring"}: {usd(quote.recurringMinor)}</span>
      <span>{zh ? "到期" : "Expires"}: {when(quote.expiresAt)}</span>
    </>
  );
}

export function CustomerQuotePanel({
  active,
  locale,
  clientAccountId,
  accessFingerprint,
  canReadQuotes,
  canAcceptQuotes,
  legal,
  onNotice,
  onError,
  onAccepted,
}: Readonly<{
  active: boolean;
  locale: Locale;
  clientAccountId: string | null;
  accessFingerprint: string;
  canReadQuotes: boolean;
  canAcceptQuotes: boolean;
  legal: CustomerQuoteLegalDocuments | null;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  onAccepted?: (result: QuoteAcceptanceResult) => void;
}>) {
  const [quotes, setQuotes] = useState<CommerceQuote[]>([]);
  const [selected, setSelected] = useState<CommerceQuote | null>(null);
  const [preview, setPreview] = useState<AcceptancePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<"preview" | "accept" | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [aupAccepted, setAupAccepted] = useState(false);
  const [marketingConsent, setMarketingConsent] = useState(false);
  const generation = useRef(0);
  const activeAccount = useRef(clientAccountId);
  const zh = locale === "zh-CN";

  const resetDecision = useCallback(() => {
    setPreview(null);
    setTermsAccepted(false);
    setAupAccepted(false);
    setMarketingConsent(false);
    setPending(null);
  }, []);

  const loadQuotes = useCallback(async () => {
    if (!active || !canReadQuotes || !clientAccountId) return;
    const accountId = clientAccountId;
    const requestGeneration = ++generation.current;
    setLoading(true);
    try {
      const result = await api<{ warning: string; items: CommerceQuote[] }>("/api/v1/quotes");
      if (generation.current === requestGeneration && activeAccount.current === accountId) {
        setQuotes(result.items);
      }
    } catch (caught) {
      if (generation.current === requestGeneration && activeAccount.current === accountId) {
        setQuotes([]);
        onError(caught instanceof Error ? caught.message : "Quotes could not be loaded");
      }
    } finally {
      if (generation.current === requestGeneration && activeAccount.current === accountId) {
        setLoading(false);
      }
    }
  }, [active, canReadQuotes, clientAccountId, onError]);

  useEffect(() => {
    generation.current += 1;
    activeAccount.current = clientAccountId;
    setQuotes([]);
    setSelected(null);
    resetDecision();
    if (active && canReadQuotes && clientAccountId) void loadQuotes();
    return () => { generation.current += 1; };
  }, [accessFingerprint, active, canReadQuotes, clientAccountId, loadQuotes, resetDecision]);

  useEffect(() => {
    resetDecision();
  }, [legal, resetDecision]);

  async function loadDetail(quoteId: string) {
    if (!active || !canReadQuotes || !clientAccountId) return;
    const accountId = clientAccountId;
    const requestGeneration = ++generation.current;
    setLoading(true);
    resetDecision();
    try {
      const result = await api<{ warning: string; quote: CommerceQuote }>(`/api/v1/quotes/${quoteId}`);
      if (generation.current === requestGeneration && activeAccount.current === accountId) {
        setSelected(result.quote);
      }
    } catch (caught) {
      if (generation.current === requestGeneration && activeAccount.current === accountId) {
        onError(caught instanceof Error ? caught.message : "Quote detail could not be loaded");
      }
    } finally {
      if (generation.current === requestGeneration && activeAccount.current === accountId) {
        setLoading(false);
      }
    }
  }

  async function requestPreview() {
    if (!selected || selected.status !== "draft" || !canAcceptQuotes || !legal || pending) return;
    const quoteId = selected.quoteId;
    const accountId = clientAccountId;
    const requestGeneration = ++generation.current;
    setPending("preview");
    setTermsAccepted(false);
    setAupAccepted(false);
    setMarketingConsent(false);
    try {
      const result = await api<AcceptancePreview>(`/api/v1/quotes/${quoteId}/acceptance-preview`, {
        method: "POST",
        body: JSON.stringify({
          termsVersion: legal.documents.terms.version,
          aupVersion: legal.documents.aup.version,
          termsDocumentId: legal.documents.terms.documentId,
          aupDocumentId: legal.documents.aup.documentId,
          legalLocale: legal.requestedLocale,
          termsLocale: legal.documents.terms.locale,
          aupLocale: legal.documents.aup.locale,
        }),
      });
      if (
        generation.current === requestGeneration &&
        activeAccount.current === accountId &&
        result.quote.quoteId === quoteId
      ) {
        setPreview(result);
      }
    } catch (caught) {
      if (generation.current === requestGeneration && activeAccount.current === accountId) {
        setPreview(null);
        onError(caught instanceof Error ? caught.message : "Quote acceptance preview failed");
      }
    } finally {
      if (generation.current === requestGeneration && activeAccount.current === accountId) {
        setPending(null);
      }
    }
  }

  async function acceptQuote() {
    if (
      !selected || !preview || selected.status !== "draft" || !canAcceptQuotes ||
      !termsAccepted || !aupAccepted || pending
    ) return;
    const quoteId = selected.quoteId;
    const accountId = clientAccountId;
    const requestGeneration = ++generation.current;
    setPending("accept");
    try {
      const result = await api<QuoteAcceptanceResult>(`/api/v1/quotes/${quoteId}/accept`, {
        method: "POST",
        body: JSON.stringify({
          termsVersion: preview.acceptance.terms.version,
          aupVersion: preview.acceptance.aup.version,
          termsDocumentId: preview.acceptance.terms.id,
          aupDocumentId: preview.acceptance.aup.id,
          legalLocale: legal?.requestedLocale ?? locale,
          termsLocale: preview.acceptance.terms.locale,
          aupLocale: preview.acceptance.aup.locale,
          marketingConsent,
          ...(marketingConsent
            ? { marketingConsentPolicyVersion: preview.acceptance.marketingConsentPolicyVersion }
            : {}),
          idempotencyKey: stableAcceptanceKey(quoteId),
        }),
      });
      if (generation.current !== requestGeneration || activeAccount.current !== accountId) return;
      clearAcceptanceKey(quoteId);
      onNotice(
        zh
          ? `Quote 已接受；Order ${result.orderId} 与 Invoice ${result.invoiceId} 已创建。`
          : `Quote accepted; Order ${result.orderId} and Invoice ${result.invoiceId} were created.`,
      );
      onAccepted?.(result);
      resetDecision();
      await loadQuotes();
      await loadDetail(quoteId);
    } catch (caught) {
      if (generation.current === requestGeneration && activeAccount.current === accountId) {
        onError(caught instanceof Error ? caught.message : "Quote acceptance failed");
      }
    } finally {
      if (generation.current === requestGeneration && activeAccount.current === accountId) {
        setPending(null);
      }
    }
  }

  if (!active || !canReadQuotes || !clientAccountId) return null;

  return (
    <section className="order-panel customer-quote-panel" data-testid="customer-quote-panel" aria-label={zh ? "客户 Quote" : "Customer Quotes"}>
      <div>
        <p className="eyebrow">Customer · Quote · Mock-only</p>
        <h2>{zh ? "报价" : "Quotes"}</h2>
        <p className="muted">
          {zh
            ? "Quote 是不可变的商业快照；只有明确接受后才创建正式 Order 与 Invoice。"
            : "A Quote is an immutable commercial snapshot. A formal Order and Invoice are created only after explicit acceptance."}
        </p>
      </div>
      <button type="button" disabled={loading} onClick={() => void loadQuotes()}>
        {loading ? (zh ? "加载中…" : "Loading…") : (zh ? "刷新 Quote" : "Refresh Quotes")}
      </button>
      <div className="manual-list">
        {quotes.length === 0 && !loading && <p className="muted">{zh ? "当前客户账户没有 Quote。" : "The active Client Account has no Quotes."}</p>}
        {quotes.map((quote) => (
          <article className="manual-item" data-testid="customer-quote-item" key={quote.quoteId}>
            <QuoteFacts quote={quote} locale={locale} />
            <button type="button" onClick={() => void loadDetail(quote.quoteId)}>{zh ? "打开详情" : "Open detail"}</button>
          </article>
        ))}
      </div>

      {selected && (
        <article className="checkout-review" data-testid="customer-quote-detail">
          <QuoteFacts quote={selected} locale={locale} />
          <p className="mono">{selected.quoteId}</p>
          <div className="quote-summary">
            <span>{zh ? "一次性" : "One-time"}<strong>{usd(selected.oneTimeMinor)}</strong></span>
            <span>Setup Fee<strong>{usd(selected.setupMinor)}</strong></span>
            <span>{zh ? "循环" : "Recurring"}<strong>{usd(selected.recurringMinor)}</strong></span>
            <span>{zh ? "接受时发票总额" : "Invoice total on acceptance"}<strong>{usd(selected.totalMinor)}</strong></span>
          </div>
          <details>
            <summary>{zh ? "产品配置快照" : "Product configuration snapshot"}</summary>
            <pre>{JSON.stringify(selected.configuration, null, 2)}</pre>
          </details>

          {selected.status === "expired" && (
            <p className="notice" role="status">
              {zh ? "此 Quote 已过期，不能再接受；历史快照仍可查看。" : "This Quote has expired and can no longer be accepted; its historical snapshot remains visible."}
            </p>
          )}
          {selected.status === "void" && (
            <p className="notice" role="status">
              {zh ? `此 Quote 已由 Staff 作废：${selected.void?.reason ?? "—"}` : `This Quote was voided by Staff: ${selected.void?.reason ?? "—"}`}
            </p>
          )}
          {selected.status === "accepted" && (
            <p className="notice" role="status">
              {zh
                ? `已接受 · Order ${selected.acceptance?.orderId ?? "—"} · Invoice ${selected.acceptance?.invoiceId ?? "—"}`
                : `Accepted · Order ${selected.acceptance?.orderId ?? "—"} · Invoice ${selected.acceptance?.invoiceId ?? "—"}`}
            </p>
          )}

          {selected.status === "draft" && (
            <>
              {!canAcceptQuotes && <p className="muted">{zh ? "当前成员没有创建 Order 的权限。" : "The current membership cannot create Orders."}</p>}
              {!legal && <p className="notice error" role="alert">{zh ? "完整的当前 Terms/AUP 尚未加载，不能接受 Quote。" : "The complete current Terms/AUP set is not loaded, so this Quote cannot be accepted."}</p>}
              {!preview && (
                <button type="button" disabled={!canAcceptQuotes || !legal || pending !== null} onClick={() => void requestPreview()}>
                  {pending === "preview" ? (zh ? "正在验证…" : "Checking…") : (zh ? "预览并验证 Quote" : "Preview and validate Quote")}
                </button>
              )}
            </>
          )}

          {selected.status === "draft" && preview && legal && (
            <section data-testid="customer-quote-acceptance">
              <p className="muted">
                {zh
                  ? `供应预检：${preview.acceptance.supply.mode} · ${preview.acceptance.supply.units} unit(s)`
                  : `Supply preflight: ${preview.acceptance.supply.mode} · ${preview.acceptance.supply.units} unit(s)`}
              </p>
              {preview.acceptance.zeroAmount && (
                <p>{zh ? "这是合法零金额 Quote，仍会经过资格与履约流程。" : "This is a valid zero-amount Quote and still follows eligibility and fulfillment."}</p>
              )}
              <fieldset className="checkout-fieldset legal-box">
                <legend>{zh ? "明确接受法律版本" : "Explicit legal acceptance"}</legend>
                <details>
                  <summary>{legal.documents.terms.title} · {preview.acceptance.terms.version}</summary>
                  <p>{legal.documents.terms.body}</p>
                </details>
                <label>
                  <input
                    type="checkbox"
                    aria-label={zh ? `接受 Terms 版本 ${preview.acceptance.terms.version}` : `Accept Terms version ${preview.acceptance.terms.version}`}
                    checked={termsAccepted}
                    onChange={(event) => setTermsAccepted(event.target.checked)}
                  />
                  {zh ? "我明确接受" : "I explicitly accept"} {legal.documents.terms.title} ({preview.acceptance.terms.version})
                </label>
                <details>
                  <summary>{legal.documents.aup.title} · {preview.acceptance.aup.version}</summary>
                  <p>{legal.documents.aup.body}</p>
                </details>
                <label>
                  <input
                    type="checkbox"
                    aria-label={zh ? `接受 AUP 版本 ${preview.acceptance.aup.version}` : `Accept AUP version ${preview.acceptance.aup.version}`}
                    checked={aupAccepted}
                    onChange={(event) => setAupAccepted(event.target.checked)}
                  />
                  {zh ? "我明确接受" : "I explicitly accept"} {legal.documents.aup.title} ({preview.acceptance.aup.version})
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={marketingConsent}
                    onChange={(event) => setMarketingConsent(event.target.checked)}
                  />
                  {zh ? "我愿意接收营销信息（可选，默认关闭）" : "I agree to receive marketing communications (optional, off by default)"}
                </label>
              </fieldset>
              <button
                type="button"
                disabled={!termsAccepted || !aupAccepted || pending !== null}
                onClick={() => void acceptQuote()}
              >
                {pending === "accept" ? (zh ? "正在接受…" : "Accepting…") : (zh ? "接受 Quote 并创建 Order/Invoice" : "Accept Quote and create Order/Invoice")}
              </button>
            </section>
          )}
        </article>
      )}
    </section>
  );
}
