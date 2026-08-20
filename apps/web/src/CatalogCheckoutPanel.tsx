// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "./api.js";

export type CatalogLocale = "en" | "zh-CN";
export type CatalogConfigurationValue = string | number | boolean;
export type CatalogConfiguration = Record<string, CatalogConfigurationValue>;

export type CatalogPrice = {
  id: string;
  revision?: number;
  productRevisionId?: string;
  productRevision?: number;
  currency: string;
  billingCycle: string;
  oneTimeMinor: string;
  setupMinor: string;
  recurringMinor: string;
};

export type CatalogProduct = {
  id: string;
  groupId: string;
  groupName: string;
  name: string;
  description: string;
  fulfillmentMode: "automatic" | "review" | "manual" | "quote";
  repeatable?: boolean;
  optionSchema: unknown[];
  prices: CatalogPrice[];
  purchasable: boolean;
};

export type CheckoutLegalDocuments = {
  requestedLocale: CatalogLocale;
  documents: Record<"terms" | "aup", {
    documentId: string;
    locale: CatalogLocale;
    revision: string;
    version: string;
    title: string;
    body: string;
  }>;
};

export type CatalogCheckoutOrderPayload = {
  priceId: string;
  configuration: CatalogConfiguration;
  promotionCode: string | null;
  termsVersion: string;
  aupVersion: string;
  termsDocumentId: string;
  aupDocumentId: string;
  legalLocale: CatalogLocale;
  termsLocale: CatalogLocale;
  aupLocale: CatalogLocale;
  marketingConsent: boolean;
  marketingConsentPolicyVersion?: string;
};

type CatalogPreview = {
  configuration: Record<string, unknown>;
  price: {
    currency: string;
    billingCycle: string;
    productRevision: number;
    priceRevision: number | null;
    oneTimeSubtotalMinor: string;
    setupMinor: string;
    recurringSubtotalMinor: string;
    invoiceTotalMinor: string;
    grossInvoiceTotalMinor: string;
    components: Array<{
      code: string;
      label: string;
      quantity: number;
      oneTimeMinor: string;
      recurringMinor: string;
    }>;
    promotion: null | {
      code: string;
      revision: number;
      oneTimeDiscountMinor: string;
      recurringDiscountMinor: string;
    };
    supply: {
      mode: "unlimited" | "tracked" | "manual_review";
      units: string;
      availableUnits: string | null;
      committedUnits: string;
      version: string | null;
    };
  };
};

type SupportedOptionType =
  | "select"
  | "radio"
  | "quantity"
  | "text"
  | "secret"
  | "password"
  | "textarea";

type CatalogOption = Record<string, unknown> & {
  code: string;
  type: SupportedOptionType;
};

type Choice = {
  value: string;
  label: string;
  oneTimeMinor: number;
  recurringMinor: number;
};

const MARKETING_CONSENT_POLICY_VERSION = "mock-lab-marketing-v1";
const SUPPORTED_OPTION_TYPES = new Set<SupportedOptionType>([
  "select",
  "radio",
  "quantity",
  "text",
  "secret",
  "password",
  "textarea",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value: unknown): value is CatalogConfigurationValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function localizedText(
  value: unknown,
  locale: CatalogLocale,
  fallback: string,
): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (!isRecord(value)) return fallback;
  const requested = value[locale];
  if (typeof requested === "string" && requested.trim().length > 0) return requested;
  const english = value.en;
  return typeof english === "string" && english.trim().length > 0 ? english : fallback;
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function optionLabel(option: CatalogOption, locale: CatalogLocale): string {
  return localizedText(option.label, locale, humanize(option.code));
}

function parseOptions(schema: unknown[]): { options: CatalogOption[]; error: string | null } {
  const options: CatalogOption[] = [];
  const codes = new Set<string>();
  for (const [index, raw] of schema.entries()) {
    if (
      !isRecord(raw) ||
      typeof raw.code !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(raw.code) ||
      typeof raw.type !== "string" ||
      !SUPPORTED_OPTION_TYPES.has(raw.type as SupportedOptionType) ||
      codes.has(raw.code)
    ) {
      return {
        options: [],
        error: `Product option ${index + 1} cannot be displayed.`,
      };
    }
    codes.add(raw.code);
    options.push(raw as CatalogOption);
  }
  return { options, error: null };
}

function conditionMatches(raw: unknown, values: CatalogConfiguration): boolean {
  if (raw === undefined) return true;
  if (!isRecord(raw)) return false;
  const code = raw.code ?? raw.optionCode ?? raw.option;
  if (typeof code !== "string") return false;
  const actual = values[code];
  if (Object.hasOwn(raw, "equals")) {
    return isScalar(raw.equals) && actual === raw.equals;
  }
  return Array.isArray(raw.in) && raw.in.some((candidate) => isScalar(candidate) && candidate === actual);
}

function optionIsActive(option: CatalogOption, values: CatalogConfiguration): boolean {
  return conditionMatches(option.visibleWhen, values) && conditionMatches(option.dependsOn, values);
}

function dependencyOverrides(
  option: CatalogOption,
  optionIndex: number,
  options: readonly CatalogOption[],
  values: CatalogConfiguration,
): Record<string, unknown> {
  if (!isRecord(option.dependencies)) return {};
  let controllingCode: string | null = null;
  for (let index = 0; index < optionIndex; index += 1) {
    const candidate = options[index];
    if (candidate?.type === "select" || candidate?.type === "radio") {
      controllingCode = candidate.code;
    }
  }
  if (!controllingCode) return {};
  const selected = values[controllingCode];
  if (typeof selected !== "string") return {};
  const override = option.dependencies[selected];
  return isRecord(override) ? override : {};
}

function numberValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !/^-?\d+(?:\.\d{1,6})?$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= Number.MAX_SAFE_INTEGER
    ? parsed
    : fallback;
}

function safeMinor(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function choices(option: CatalogOption, locale: CatalogLocale): Choice[] {
  if (!Array.isArray(option.values)) return [];
  return option.values.flatMap((raw): Choice[] => {
    if (typeof raw === "string") {
      return [{ value: raw, label: humanize(raw), oneTimeMinor: 0, recurringMinor: 0 }];
    }
    if (!isRecord(raw) || typeof raw.value !== "string") return [];
    return [{
      value: raw.value,
      label: localizedText(raw.label, locale, humanize(raw.value)),
      oneTimeMinor: safeMinor(raw.oneTimeMinor),
      recurringMinor: safeMinor(raw.recurringMinor),
    }];
  });
}

function initialValues(options: readonly CatalogOption[]): CatalogConfiguration {
  const values: CatalogConfiguration = {};
  for (const option of options) {
    if (option.type === "quantity" && option.required === true) {
      values[option.code] = numberValue(option.min, 0);
    }
  }
  return values;
}

function requestConfiguration(
  options: readonly CatalogOption[],
  values: CatalogConfiguration,
): CatalogConfiguration {
  const result: CatalogConfiguration = {};
  for (const option of options) {
    if (optionIsActive(option, values) && Object.hasOwn(values, option.code)) {
      const value = values[option.code];
      if (value !== undefined) result[option.code] = value;
    }
  }
  return result;
}

function usd(minor: string | number): string {
  const value = BigInt(minor);
  const dollars = value / 100n;
  const cents = (value % 100n).toString().padStart(2, "0");
  return `$${dollars.toLocaleString("en-US")}.${cents}`;
}

function choicePrice(choice: Choice, locale: CatalogLocale): string {
  const parts: string[] = [];
  if (choice.oneTimeMinor > 0) {
    parts.push(locale === "zh-CN" ? `一次性 +${usd(choice.oneTimeMinor)}` : `+${usd(choice.oneTimeMinor)} one-time`);
  }
  if (choice.recurringMinor > 0) {
    parts.push(locale === "zh-CN" ? `循环 +${usd(choice.recurringMinor)}` : `+${usd(choice.recurringMinor)} recurring`);
  }
  return parts.length > 0 ? ` (${parts.join(" · ")})` : "";
}

function cycleLabel(cycle: string, locale: CatalogLocale): string {
  const labels: Record<string, readonly [string, string]> = {
    monthly: ["Monthly", "月付"],
    quarterly: ["Quarterly", "季付"],
    semiannual: ["Semiannual", "半年付"],
    annual: ["Annual", "年付"],
    one_time: ["One-time", "一次性"],
  };
  const label = labels[cycle];
  return label ? label[locale === "zh-CN" ? 1 : 0] : humanize(cycle);
}

function OptionField({
  option,
  optionIndex,
  options,
  locale,
  values,
  onChange,
}: {
  option: CatalogOption;
  optionIndex: number;
  options: readonly CatalogOption[];
  locale: CatalogLocale;
  values: CatalogConfiguration;
  onChange: (code: string, value: CatalogConfigurationValue | undefined) => void;
}) {
  if (!optionIsActive(option, values)) return null;
  const overrides = dependencyOverrides(option, optionIndex, options, values);
  const required = overrides.required === true ||
    (overrides.required === undefined && option.required === true);
  const label = optionLabel(option, locale);
  const fieldId = `catalog-option-${option.code}`;
  const value = values[option.code];

  if (option.type === "select") {
    return (
      <label className="checkout-option" htmlFor={fieldId}>
        <span>{label}{required ? " *" : ""}</span>
        <select
          id={fieldId}
          aria-label={label}
          required={required}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(option.code, event.target.value || undefined)}
        >
          <option value="">{locale === "zh-CN" ? "请选择…" : "Select…"}</option>
          {choices(option, locale).map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}{choicePrice(choice, locale)}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (option.type === "radio") {
    return (
      <fieldset className="checkout-option checkout-option-radio">
        <legend>{label}{required ? " *" : ""}</legend>
        {choices(option, locale).map((choice) => (
          <label key={choice.value}>
            <input
              type="radio"
              name={fieldId}
              required={required}
              checked={value === choice.value}
              onChange={() => onChange(option.code, choice.value)}
            />
            <span>{choice.label}{choicePrice(choice, locale)}</span>
          </label>
        ))}
      </fieldset>
    );
  }

  if (option.type === "quantity") {
    const minimum = numberValue(overrides.min ?? option.min, 0);
    const maximum = numberValue(overrides.max ?? option.max, Number.MAX_SAFE_INTEGER);
    const step = numberValue(option.step, 1);
    return (
      <label className="checkout-option" htmlFor={fieldId}>
        <span>{label}{required ? " *" : ""}</span>
        <input
          id={fieldId}
          aria-label={label}
          type="number"
          min={minimum}
          max={maximum}
          step={step}
          required={required}
          value={typeof value === "number" ? value : ""}
          onChange={(event) => {
            const raw = event.target.value;
            onChange(option.code, raw === "" ? undefined : Number(raw));
          }}
        />
        <small>
          {locale === "zh-CN"
            ? `范围 ${minimum}–${maximum === Number.MAX_SAFE_INTEGER ? "不限" : maximum}，步长 ${step}`
            : `Range ${minimum}–${maximum === Number.MAX_SAFE_INTEGER ? "unbounded" : maximum}, step ${step}`}
        </small>
      </label>
    );
  }

  const minimumLength = numberValue(option.minLength, required ? 1 : 0);
  const maximumLength = numberValue(option.maxLength, 4096);
  const stringValue = typeof value === "string" ? value : "";
  if (option.type === "textarea") {
    return (
      <label className="checkout-option" htmlFor={fieldId}>
        <span>{label}{required ? " *" : ""}</span>
        <textarea
          id={fieldId}
          aria-label={label}
          required={required}
          minLength={minimumLength}
          maxLength={maximumLength}
          value={stringValue}
          onChange={(event) => onChange(option.code, event.target.value || undefined)}
        />
      </label>
    );
  }

  const sensitive = option.type === "secret" || option.type === "password";
  return (
    <label className="checkout-option" htmlFor={fieldId}>
      <span>{label}{required ? " *" : ""}</span>
      <input
        id={fieldId}
        aria-label={label}
        type={sensitive ? "password" : "text"}
        autoComplete={sensitive ? "new-password" : undefined}
        required={required}
        minLength={minimumLength}
        maxLength={maximumLength}
        value={stringValue}
        onChange={(event) => onChange(option.code, event.target.value || undefined)}
      />
      {sensitive && (
        <small>
          {locale === "zh-CN"
            ? "此值仅在当前配置步骤的内存中使用，页面不会回显。"
            : "This value is used only in memory for this configuration step and is never echoed."}
        </small>
      )}
    </label>
  );
}

export function CatalogCheckoutPanel({
  product,
  price,
  legal,
  locale,
  mode,
  canCreateOrders,
  onClose,
  onContinueToCustomer,
  onCreateOrder,
}: {
  product: CatalogProduct;
  price: CatalogPrice;
  legal: CheckoutLegalDocuments | null;
  locale: CatalogLocale;
  mode: "public" | "customer";
  canCreateOrders: boolean;
  onClose: () => void;
  onContinueToCustomer: () => void;
  onCreateOrder: (payload: CatalogCheckoutOrderPayload) => Promise<boolean>;
}) {
  const parsed = useMemo(() => parseOptions(product.optionSchema), [product.optionSchema]);
  const [values, setValues] = useState<CatalogConfiguration>(() => initialValues(parsed.options));
  const [promotionCode, setPromotionCode] = useState("");
  const [preview, setPreview] = useState<CatalogPreview | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [submitPending, setSubmitPending] = useState(false);
  const [localError, setLocalError] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [aupAccepted, setAupAccepted] = useState(false);
  const [marketingConsent, setMarketingConsent] = useState(false);
  const previewGeneration = useRef(0);

  const clearSensitiveValues = () => {
    const sensitiveCodes = new Set(
      parsed.options
        .filter((option) => option.type === "secret" || option.type === "password")
        .map((option) => option.code),
    );
    if (sensitiveCodes.size === 0) return;
    setValues((current) => Object.fromEntries(
      Object.entries(current).filter(([code]) => !sensitiveCodes.has(code)),
    ));
  };

  const close = () => {
    previewGeneration.current += 1;
    clearSensitiveValues();
    onClose();
  };

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  });

  function changeValue(code: string, value: CatalogConfigurationValue | undefined) {
    previewGeneration.current += 1;
    setPreviewPending(false);
    setPreview(null);
    setLocalError("");
    setValues((current) => {
      const next = { ...current };
      if (value === undefined) delete next[code];
      else next[code] = value;
      for (const option of parsed.options) {
        if (!optionIsActive(option, next)) delete next[option.code];
      }
      return next;
    });
  }

  async function requestPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode !== "customer" || !canCreateOrders || parsed.error) return;
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const generation = ++previewGeneration.current;
    setPreviewPending(true);
    setLocalError("");
    try {
      const result = await api<CatalogPreview>("/api/v1/catalog/preview", {
        method: "POST",
        body: JSON.stringify({
          priceId: price.id,
          configuration: requestConfiguration(parsed.options, values),
          promotionCode: promotionCode.trim() === "" ? null : promotionCode.trim().toUpperCase(),
        }),
      });
      if (previewGeneration.current === generation) setPreview(result);
    } catch (caught) {
      if (previewGeneration.current === generation) {
        setLocalError(caught instanceof Error ? caught.message :
          locale === "zh-CN" ? "无法预览订单总额。" : "Unable to preview the order total.");
      }
    } finally {
      if (previewGeneration.current === generation) setPreviewPending(false);
    }
  }

  async function createOrder() {
    if (!preview || !legal || !termsAccepted || !aupAccepted || submitPending) return;
    setSubmitPending(true);
    setLocalError("");
    const configuration = requestConfiguration(parsed.options, values);
    try {
      const created = await onCreateOrder({
        priceId: price.id,
        configuration,
        promotionCode: promotionCode.trim() === "" ? null : promotionCode.trim().toUpperCase(),
        termsVersion: legal.documents.terms.version,
        aupVersion: legal.documents.aup.version,
        termsDocumentId: legal.documents.terms.documentId,
        aupDocumentId: legal.documents.aup.documentId,
        legalLocale: legal.requestedLocale,
        termsLocale: legal.documents.terms.locale,
        aupLocale: legal.documents.aup.locale,
        marketingConsent,
        ...(marketingConsent
          ? { marketingConsentPolicyVersion: MARKETING_CONSENT_POLICY_VERSION }
          : {}),
      });
      if (created) {
        clearSensitiveValues();
        onClose();
      }
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message :
        locale === "zh-CN" ? "无法创建订单。" : "Unable to create the order.");
    } finally {
      setSubmitPending(false);
    }
  }

  const baseTotal = (
    BigInt(price.oneTimeMinor) + BigInt(price.setupMinor) + BigInt(price.recurringMinor)
  ).toString();
  const copy = locale === "zh-CN"
    ? {
        eyebrow: "Checkout 配置",
        close: "关闭 Checkout",
        configuration: "产品配置",
        noOptions: "此价格没有额外配置项。",
        promotion: "Promotion 代码（可选）",
        preview: "预览总额",
        previewing: "正在计算…",
        continue: "进入客户工作区继续",
        unavailable: "当前账户没有创建订单的权限。",
        legal: "法律文本确认",
        acceptTerms: "我接受",
        acceptAup: "我接受",
        marketing: "我愿意接收营销信息（可选，默认关闭）",
        create: "配置并下单",
        creating: "正在创建订单…",
        total: "本次发票总额",
        recurring: "循环小计",
        setup: "Setup Fee",
        oneTime: "一次性小计",
        zero: "这是合法的零金额订单，仍会经过资格与履约流程。",
        supply: "供应预检",
      }
    : {
        eyebrow: "Checkout configuration",
        close: "Close Checkout",
        configuration: "Product configuration",
        noOptions: "This price has no additional configuration fields.",
        promotion: "Promotion code (optional)",
        preview: "Review total",
        previewing: "Calculating…",
        continue: "Continue in customer workspace",
        unavailable: "The active account does not have permission to create Orders.",
        legal: "Legal acceptance",
        acceptTerms: "I accept",
        acceptAup: "I accept",
        marketing: "I agree to receive marketing communications (optional, off by default)",
        create: "Configure & order",
        creating: "Creating Order…",
        total: "Invoice total now",
        recurring: "Recurring subtotal",
        setup: "Setup Fee",
        oneTime: "One-time subtotal",
        zero: "This is a valid zero-amount Order and still follows eligibility and fulfillment.",
        supply: "Supply preflight",
      };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <section
        className="modal catalog-checkout-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="catalog-checkout-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="close" aria-label={copy.close} onClick={close}>×</button>
        <p className="eyebrow">{copy.eyebrow}</p>
        <h2 id="catalog-checkout-title">{product.name}</h2>
        <p>{cycleLabel(price.billingCycle, locale)} · {usd(baseTotal)}</p>

        {mode === "public" ? (
          <>
            <p className="muted">
              {locale === "zh-CN"
                ? "登录并明确选择客户账户后，才会进行配置、供应预检与下单。"
                : "Sign in and select an active Client Account before configuration, supply preflight and ordering."}
            </p>
            <button className="primary wide" onClick={onContinueToCustomer}>{copy.continue}</button>
          </>
        ) : (
          <>
            <form className="catalog-checkout-form" onSubmit={requestPreview}>
              <fieldset className="checkout-fieldset">
                <legend>{copy.configuration}</legend>
                {parsed.error && <p className="notice error">{parsed.error}</p>}
                {!parsed.error && parsed.options.length === 0 && <p className="muted">{copy.noOptions}</p>}
                {parsed.options.map((option, optionIndex) => (
                  <OptionField
                    key={option.code}
                    option={option}
                    optionIndex={optionIndex}
                    options={parsed.options}
                    locale={locale}
                    values={values}
                    onChange={changeValue}
                  />
                ))}
                <label className="checkout-option" htmlFor="catalog-promotion-code">
                  <span>{copy.promotion}</span>
                  <input
                    id="catalog-promotion-code"
                    aria-label={copy.promotion}
                    value={promotionCode}
                    maxLength={64}
                    pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,63}"
                    onChange={(event) => {
                      previewGeneration.current += 1;
                      setPreviewPending(false);
                      setPreview(null);
                      setLocalError("");
                      setPromotionCode(event.target.value.toUpperCase());
                    }}
                  />
                </label>
              </fieldset>
              {!canCreateOrders && <p className="muted">{copy.unavailable}</p>}
              <button
                className="primary wide"
                type="submit"
                disabled={!canCreateOrders || previewPending || parsed.error !== null}
              >
                {previewPending ? copy.previewing : copy.preview}
              </button>
            </form>

            {localError && <p className="notice error" role="alert">{localError}</p>}

            {preview && (
              <section className="checkout-review" aria-label={locale === "zh-CN" ? "订单预览" : "Order preview"}>
                <div className="quote-summary">
                  <span>{copy.oneTime}<strong>{usd(preview.price.oneTimeSubtotalMinor)}</strong></span>
                  <span>{copy.setup}<strong>{usd(preview.price.setupMinor)}</strong></span>
                  <span>{copy.recurring}<strong>{usd(preview.price.recurringSubtotalMinor)}</strong></span>
                  <span>{copy.total}<strong>{usd(preview.price.invoiceTotalMinor)}</strong></span>
                </div>
                {preview.price.promotion && (
                  <p className="muted">
                    Promotion {preview.price.promotion.code} · revision {preview.price.promotion.revision}
                  </p>
                )}
                <p className="muted">
                  {copy.supply}: {preview.price.supply.mode} · {preview.price.supply.units} unit(s)
                  {preview.price.supply.availableUnits === null
                    ? ""
                    : ` · ${preview.price.supply.availableUnits} available`}
                </p>
                {preview.price.invoiceTotalMinor === "0" && <p>{copy.zero}</p>}

                <fieldset className="checkout-fieldset legal-box">
                  <legend>{copy.legal}</legend>
                  {legal ? (
                    <>
                      <details>
                        <summary>{legal.documents.terms.title} · {legal.documents.terms.version}</summary>
                        <p>{legal.documents.terms.body}</p>
                      </details>
                      <label>
                        <input
                          type="checkbox"
                          aria-label={locale === "zh-CN"
                            ? `接受 Terms 版本 ${legal.documents.terms.version}`
                            : `Accept Terms version ${legal.documents.terms.version}`}
                          checked={termsAccepted}
                          onChange={(event) => setTermsAccepted(event.target.checked)}
                        />
                        {copy.acceptTerms} {legal.documents.terms.title} ({legal.documents.terms.version})
                      </label>
                      <details>
                        <summary>{legal.documents.aup.title} · {legal.documents.aup.version}</summary>
                        <p>{legal.documents.aup.body}</p>
                      </details>
                      <label>
                        <input
                          type="checkbox"
                          aria-label={locale === "zh-CN"
                            ? `接受 AUP 版本 ${legal.documents.aup.version}`
                            : `Accept AUP version ${legal.documents.aup.version}`}
                          checked={aupAccepted}
                          onChange={(event) => setAupAccepted(event.target.checked)}
                        />
                        {copy.acceptAup} {legal.documents.aup.title} ({legal.documents.aup.version})
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          aria-label={locale === "zh-CN"
                            ? "营销信息同意（可选）"
                            : "Marketing communications consent (optional)"}
                          checked={marketingConsent}
                          onChange={(event) => setMarketingConsent(event.target.checked)}
                        />
                        {copy.marketing}
                      </label>
                    </>
                  ) : (
                    <p className="muted">
                      {locale === "zh-CN" ? "正在加载法律文本…" : "Loading legal documents…"}
                    </p>
                  )}
                </fieldset>
                <button
                  className="primary wide"
                  disabled={!legal || !termsAccepted || !aupAccepted || submitPending}
                  onClick={() => void createOrder()}
                >
                  {submitPending ? copy.creating : copy.create}
                </button>
              </section>
            )}
          </>
        )}
      </section>
    </div>
  );
}
