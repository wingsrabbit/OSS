// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "./api.js";

type Locale = "en" | "zh-CN";
type BillingCycle = "monthly" | "quarterly" | "semiannual" | "annual" | "one_time";
type FulfillmentMode = "automatic" | "review" | "manual" | "quote";
type SupplyMode = "unlimited" | "tracked" | "manual_review";
type OptionKind = "select" | "radio" | "quantity" | "text" | "secret" | "password" | "textarea";

type CatalogGroup = Readonly<{
  id: string;
  sortOrder: number;
  names: unknown;
}>;

type CatalogProduct = Readonly<{
  id: string;
  groupId: string;
  names: unknown;
  descriptions: unknown;
  fulfillmentMode: FulfillmentMode;
  active: boolean;
  hidden: boolean;
  repeatable: boolean;
  optionSchema: unknown;
  currentRevisionId: string;
  currentRevision: number;
  updatedAt: string;
}>;

type CatalogRevision = Readonly<{
  id: string;
  productId: string;
  revision: number;
  groupId: string;
  names: unknown;
  descriptions: unknown;
  fulfillmentMode: FulfillmentMode;
  active: boolean;
  hidden: boolean;
  repeatable: boolean;
  optionSchema: unknown;
  createdByStaffUserId: string | null;
  createdAt: string;
}>;

type CatalogPrice = Readonly<{
  id: string;
  productId: string;
  productRevisionId: string;
  revision: number;
  currency: string;
  billingCycle: BillingCycle;
  oneTimeMinor: string;
  setupMinor: string;
  recurringMinor: string;
  active: boolean;
  validFrom: string;
  validUntil: string | null;
}>;

type CatalogSupply = Readonly<{
  productId: string;
  mode: SupplyMode;
  availableUnits: string | null;
  committedUnits: string;
  version: string;
  updatedByStaffUserId: string;
  updatedAt: string;
}>;

type CatalogSnapshot = Readonly<{
  warning: string;
  groups: CatalogGroup[];
  products: CatalogProduct[];
  revisions: CatalogRevision[];
  prices: CatalogPrice[];
  supply: CatalogSupply[];
}>;

type AutomationMode = "provider" | "manual";

type CatalogAutomationPolicy = Readonly<{
  warning: string;
  productId: string;
  fulfillmentMode: "automatic" | "review";
  productActive: boolean;
  productHidden: boolean;
  configured: boolean;
  automationMode: AutomationMode;
  providerInstallationId: "mock-provisioning-v1" | null;
  policyVersion: number | null;
  overdueAction: "automatic" | "manual" | "none" | null;
  updatedAt: string | null;
  capabilitySnapshot: string[];
  requiredCapabilities: string[];
  missingCapabilities: string[];
  providerVersion: number | null;
  providerEnabled: boolean | null;
  providerReady: boolean;
  changed?: boolean;
}>;

type Promotion = Readonly<{
  id: string;
  code: string;
  revision: number;
  name: string;
  productId: string | null;
  billingCycle: BillingCycle | null;
  discountKind: "fixed" | "percentage";
  applicationScope: "one_time" | "recurring" | "all";
  fixedAmountMinor: string | null;
  percentageBasisPoints: number | null;
  currency: string | null;
  active: boolean;
  validFrom: string;
  validUntil: string | null;
  maximumRedemptions: string | null;
  redemptions: string;
  createdByStaffUserId: string;
  createdAt: string;
}>;

export type CommerceQuote = Readonly<{
  quoteId: string;
  clientAccountId: string;
  createdByStaffUserId: string;
  status: "draft" | "expired" | "void" | "accepted";
  productId: string;
  productRevisionId: string;
  priceId: string | null;
  productName: string;
  fulfillmentMode: FulfillmentMode;
  billingCycle: BillingCycle;
  configuration: unknown;
  price: unknown;
  promotionId: string | null;
  promotion: unknown | null;
  supply: unknown;
  currency: string;
  oneTimeMinor: string;
  setupMinor: string;
  recurringMinor: string;
  totalMinor: string;
  expiresAt: string;
  createdAt: string;
  void: null | Readonly<{ voidId: string; reason: string; voidedAt: string | null }>;
  acceptance: null | Readonly<{
    acceptanceId: string;
    acceptedByUserId: string;
    orderId: string;
    invoiceId: string;
    acceptedAt: string | null;
  }>;
}>;

type OptionDraft = Readonly<{
  code: string;
  type: OptionKind;
  labelEn: string;
  labelZh: string;
  required: boolean;
  values: string;
  min: string;
  max: string;
  step: string;
  minLength: string;
  maxLength: string;
  oneTimeMinor: string;
  recurringMinor: string;
  capacityUnits: string;
}>;

const EMPTY_CATALOG: CatalogSnapshot = {
  warning: "",
  groups: [],
  products: [],
  revisions: [],
  prices: [],
  supply: [],
};

const EMPTY_OPTION: OptionDraft = {
  code: "",
  type: "text",
  labelEn: "",
  labelZh: "",
  required: false,
  values: "",
  min: "0",
  max: "100",
  step: "1",
  minLength: "0",
  maxLength: "4096",
  oneTimeMinor: "0",
  recurringMinor: "0",
  capacityUnits: "0",
};

const BILLING_CYCLES: readonly BillingCycle[] = [
  "monthly",
  "quarterly",
  "semiannual",
  "annual",
  "one_time",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function localized(value: unknown, locale: Locale, fallback: string): string {
  if (!isRecord(value)) return fallback;
  const requested = value[locale];
  if (typeof requested === "string" && requested.trim()) return requested;
  const english = value.en;
  return typeof english === "string" && english.trim() ? english : fallback;
}

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

function requiredString(form: FormData, name: string): string {
  return String(form.get(name) ?? "").trim();
}

function optionalString(form: FormData, name: string): string | null {
  const value = requiredString(form, name);
  return value === "" ? null : value;
}

function optionalIso(form: FormData, name: string): string | undefined {
  const value = requiredString(form, name);
  return value === "" ? undefined : new Date(value).toISOString();
}

function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function parseJsonObject(text: string, field: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error(`${field} must be a JSON object`);
  return value;
}

function parseOptionArray(text: string): unknown[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error("Option schema must be a JSON array");
  return value;
}

function numericValue(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return parsed;
}

function decimalValue(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be a finite number`);
  return parsed;
}

function draftFromOption(value: unknown): OptionDraft {
  if (!isRecord(value)) return EMPTY_OPTION;
  const type = ["select", "radio", "quantity", "text", "secret", "password", "textarea"].includes(
    String(value.type),
  )
    ? (value.type as OptionKind)
    : "text";
  const labels = isRecord(value.label) ? value.label : {};
  const choices = Array.isArray(value.values)
    ? value.values
        .map((choice) => (typeof choice === "string" ? choice : isRecord(choice) ? choice.value : ""))
        .filter((choice): choice is string => typeof choice === "string" && choice.length > 0)
        .join(", ")
    : "";
  return {
    code: typeof value.code === "string" ? value.code : "",
    type,
    labelEn: typeof labels.en === "string" ? labels.en : "",
    labelZh: typeof labels["zh-CN"] === "string" ? labels["zh-CN"] : "",
    required: value.required === true,
    values: choices,
    min: String(value.min ?? "0"),
    max: String(value.max ?? "100"),
    step: String(value.step ?? "1"),
    minLength: String(value.minLength ?? "0"),
    maxLength: String(value.maxLength ?? "4096"),
    oneTimeMinor: String(value.oneTimeUnitMinor ?? value.oneTimeMinor ?? "0"),
    recurringMinor: String(value.recurringUnitMinor ?? value.recurringMinor ?? "0"),
    capacityUnits: String(value.capacityUnitsPerUnit ?? "0"),
  };
}

function optionFromDraft(draft: OptionDraft, previous?: unknown): Record<string, unknown> {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(draft.code)) {
    throw new Error("Option code must start with a lowercase letter and use lowercase letters, numbers or underscores");
  }
  if (!draft.labelEn.trim()) throw new Error("Every guided option needs an English label");
  const previousRecord = isRecord(previous) ? previous : {};
  const retainedConditions = {
    ...(Object.hasOwn(previousRecord, "visibleWhen") ? { visibleWhen: previousRecord.visibleWhen } : {}),
    ...(Object.hasOwn(previousRecord, "dependsOn") ? { dependsOn: previousRecord.dependsOn } : {}),
    ...(Object.hasOwn(previousRecord, "dependencies") ? { dependencies: previousRecord.dependencies } : {}),
  };
  const base: Record<string, unknown> = {
    ...retainedConditions,
    code: draft.code,
    type: draft.type,
    label: {
      en: draft.labelEn.trim(),
      ...(draft.labelZh.trim() ? { "zh-CN": draft.labelZh.trim() } : {}),
    },
    required: draft.required,
  };
  if (draft.type === "select" || draft.type === "radio") {
    const values = [...new Set(draft.values.split(",").map((value) => value.trim()).filter(Boolean))];
    if (values.length === 0) throw new Error("Select and Radio options need comma-separated values");
    const previousChoices = new Map(
      (Array.isArray(previousRecord.values) ? previousRecord.values : []).flatMap((choice) => {
        const choiceValue = typeof choice === "string"
          ? choice
          : isRecord(choice) && typeof choice.value === "string"
            ? choice.value
            : null;
        return choiceValue === null ? [] : [[choiceValue, choice] as const];
      }),
    );
    return { ...base, values: values.map((value) => previousChoices.get(value) ?? value) };
  }
  if (draft.type === "quantity") {
    return {
      ...base,
      min: decimalValue(draft.min, "Minimum"),
      max: decimalValue(draft.max, "Maximum"),
      step: decimalValue(draft.step, "Step"),
      oneTimeUnitMinor: numericValue(draft.oneTimeMinor, "One-time unit amount"),
      recurringUnitMinor: numericValue(draft.recurringMinor, "Recurring unit amount"),
      capacityUnitsPerUnit: numericValue(draft.capacityUnits, "Capacity units per quantity"),
    };
  }
  return {
    ...base,
    minLength: numericValue(draft.minLength, "Minimum length"),
    maxLength: numericValue(draft.maxLength, "Maximum length"),
    oneTimeMinor: numericValue(draft.oneTimeMinor, "One-time amount"),
    recurringMinor: numericValue(draft.recurringMinor, "Recurring amount"),
  };
}

function OptionSchemaEditor({
  locale,
  value,
  onChange,
  onError,
}: Readonly<{
  locale: Locale;
  value: string;
  onChange: (value: string) => void;
  onError: (message: string) => void;
}>) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState<OptionDraft>(EMPTY_OPTION);
  const zh = locale === "zh-CN";
  let parsed: unknown[] = [];
  let parseError = "";
  try {
    parsed = parseOptionArray(value);
  } catch (caught) {
    parseError = caught instanceof Error ? caught.message : "Invalid option schema";
  }

  const updateDraft = <K extends keyof OptionDraft>(field: K, next: OptionDraft[K]) => {
    setDraft((current) => ({ ...current, [field]: next }));
  };

  function load(index: number) {
    const option = parsed[index];
    if (option === undefined) return;
    setEditingIndex(index);
    setDraft(draftFromOption(option));
  }

  function save() {
    try {
      const options = parseOptionArray(value);
      const previous = editingIndex === null ? undefined : options[editingIndex];
      const option = optionFromDraft(draft, previous);
      const duplicate = options.findIndex(
        (candidate, index) =>
          index !== editingIndex && isRecord(candidate) && candidate.code === option.code,
      );
      if (duplicate >= 0) throw new Error("Option codes must be unique");
      if (editingIndex === null) options.push(option);
      else options[editingIndex] = option;
      onChange(JSON.stringify(options, null, 2));
      setEditingIndex(null);
      setDraft(EMPTY_OPTION);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Unable to save the option schema");
    }
  }

  function remove(index: number) {
    try {
      const options = parseOptionArray(value);
      options.splice(index, 1);
      onChange(JSON.stringify(options, null, 2));
      setEditingIndex(null);
      setDraft(EMPTY_OPTION);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Unable to remove the option");
    }
  }

  return (
    <fieldset className="checkout-fieldset" data-testid="catalog-option-schema-editor">
      <legend>{zh ? "配置选项构建器" : "Configuration option builder"}</legend>
      <p className="muted">
        {zh
          ? "Secret 仅定义客户稍后填写的字段规则；这里不会收集或保存客户 Secret。"
          : "Secret defines a field the customer completes later. No customer secret is collected or stored here."}
      </p>
      {parseError && <p className="notice error" role="alert">{parseError}</p>}
      {!parseError && parsed.length > 0 && (
        <div className="manual-list">
          {parsed.map((option, index) => (
            <article className="manual-item" key={`${index}:${isRecord(option) ? String(option.code) : "invalid"}`}>
              <strong>{isRecord(option) ? String(option.code ?? `Option ${index + 1}`) : `Option ${index + 1}`}</strong>
              <span>{isRecord(option) ? String(option.type ?? "invalid") : "invalid"}</span>
              <div className="button-row">
                <button type="button" onClick={() => load(index)}>{zh ? "载入编辑" : "Load to edit"}</button>
                <button type="button" onClick={() => remove(index)}>{zh ? "删除" : "Remove"}</button>
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="form-columns">
        <label>
          {zh ? "选项代码" : "Option code"}
          <input value={draft.code} placeholder="bandwidth" onChange={(event) => updateDraft("code", event.target.value)} />
        </label>
        <label>
          {zh ? "类型" : "Type"}
          <select value={draft.type} onChange={(event) => updateDraft("type", event.target.value as OptionKind)}>
            <option value="select">Select</option>
            <option value="radio">Radio</option>
            <option value="quantity">Quantity</option>
            <option value="text">Text</option>
            <option value="secret">Secret</option>
            <option value="password">Password</option>
            <option value="textarea">Textarea</option>
          </select>
        </label>
        <label>
          {zh ? "英语标签" : "English label"}
          <input value={draft.labelEn} onChange={(event) => updateDraft("labelEn", event.target.value)} />
        </label>
        <label>
          {zh ? "简体中文标签（可选）" : "Simplified Chinese label (optional)"}
          <input value={draft.labelZh} onChange={(event) => updateDraft("labelZh", event.target.value)} />
        </label>
      </div>
      <label>
        <input type="checkbox" checked={draft.required} onChange={(event) => updateDraft("required", event.target.checked)} />
        {zh ? "客户必须填写" : "Customer entry is required"}
      </label>
      {(draft.type === "select" || draft.type === "radio") && (
        <>
          <label>
            {zh ? "允许值（逗号分隔）" : "Allowed values (comma-separated)"}
            <input value={draft.values} placeholder="small, medium, large" onChange={(event) => updateDraft("values", event.target.value)} />
          </label>
          <p className="muted">
            {zh
              ? "已存在值的价格/供应影响会在载入编辑时保留；新增值的高级定价、条件显示与依赖关系可在下方 JSON 中定义。"
              : "Existing choice pricing and supply effects are retained when editing. Define advanced pricing, conditional visibility and dependencies in the JSON editor below."}
          </p>
        </>
      )}
      {draft.type === "quantity" ? (
        <div className="form-columns">
          <label>{zh ? "最小值" : "Minimum"}<input type="number" value={draft.min} onChange={(event) => updateDraft("min", event.target.value)} /></label>
          <label>{zh ? "最大值" : "Maximum"}<input type="number" value={draft.max} onChange={(event) => updateDraft("max", event.target.value)} /></label>
          <label>{zh ? "步长" : "Step"}<input type="number" value={draft.step} onChange={(event) => updateDraft("step", event.target.value)} /></label>
          <label>{zh ? "每 unit 一次性价格（minor units）" : "One-time per unit (minor units)"}<input inputMode="numeric" value={draft.oneTimeMinor} onChange={(event) => updateDraft("oneTimeMinor", event.target.value)} /></label>
          <label>{zh ? "每 unit 循环价格（minor units）" : "Recurring per unit (minor units)"}<input inputMode="numeric" value={draft.recurringMinor} onChange={(event) => updateDraft("recurringMinor", event.target.value)} /></label>
          <label>{zh ? "每 quantity 的供应 unit" : "Supply units per quantity"}<input inputMode="numeric" value={draft.capacityUnits} onChange={(event) => updateDraft("capacityUnits", event.target.value)} /></label>
        </div>
      ) : draft.type !== "select" && draft.type !== "radio" ? (
        <div className="form-columns">
          <label>{zh ? "最短长度" : "Minimum length"}<input inputMode="numeric" value={draft.minLength} onChange={(event) => updateDraft("minLength", event.target.value)} /></label>
          <label>{zh ? "最长长度" : "Maximum length"}<input inputMode="numeric" value={draft.maxLength} onChange={(event) => updateDraft("maxLength", event.target.value)} /></label>
          <label>{zh ? "一次性价格（minor units）" : "One-time amount (minor units)"}<input inputMode="numeric" value={draft.oneTimeMinor} onChange={(event) => updateDraft("oneTimeMinor", event.target.value)} /></label>
          <label>{zh ? "循环价格（minor units）" : "Recurring amount (minor units)"}<input inputMode="numeric" value={draft.recurringMinor} onChange={(event) => updateDraft("recurringMinor", event.target.value)} /></label>
        </div>
      ) : null}
      <div className="button-row">
        <button type="button" onClick={save} disabled={Boolean(parseError)}>
          {editingIndex === null ? (zh ? "新增选项" : "Add option") : (zh ? "保存选项编辑" : "Save option edit")}
        </button>
        {editingIndex !== null && (
          <button type="button" onClick={() => { setEditingIndex(null); setDraft(EMPTY_OPTION); }}>
            {zh ? "取消编辑" : "Cancel edit"}
          </button>
        )}
      </div>
      <label>
        {zh ? "高级 optionSchema JSON" : "Advanced optionSchema JSON"}
        <textarea rows={10} value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false} />
      </label>
    </fieldset>
  );
}

function QuoteSummary({ quote, locale }: Readonly<{ quote: CommerceQuote; locale: Locale }>) {
  const zh = locale === "zh-CN";
  return (
    <>
      <strong>{quote.productName} · {quote.status}</strong>
      <span>{quote.currency} {usd(quote.totalMinor)} · {quote.billingCycle}</span>
      <span>{zh ? "客户账户" : "Client Account"}: <span className="mono">{quote.clientAccountId}</span></span>
      <span>{zh ? "失效时间" : "Expires"}: {when(quote.expiresAt)}</span>
    </>
  );
}

export function AdminCommercePanel({
  active,
  locale,
  accessFingerprint,
  canCatalogRead,
  canCatalogManage,
  canPricingManage,
  canSupplyManage,
  canPromotionsRead,
  canPromotionsManage,
  canQuotesRead,
  canQuotesManage,
  onNotice,
  onError,
}: Readonly<{
  active: boolean;
  locale: Locale;
  accessFingerprint: string;
  canCatalogRead: boolean;
  canCatalogManage: boolean;
  canPricingManage: boolean;
  canSupplyManage: boolean;
  canPromotionsRead: boolean;
  canPromotionsManage: boolean;
  canQuotesRead: boolean;
  canQuotesManage: boolean;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}>) {
  const [catalog, setCatalog] = useState<CatalogSnapshot>(EMPTY_CATALOG);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [quotes, setQuotes] = useState<CommerceQuote[]>([]);
  const [selectedQuote, setSelectedQuote] = useState<CommerceQuote | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [promotionLoading, setPromotionLoading] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [productOptionSchema, setProductOptionSchema] = useState("[]");
  const [revisionOptionSchema, setRevisionOptionSchema] = useState("[]");
  const [quoteConfiguration, setQuoteConfiguration] = useState("{}");
  const [quotePricingMode, setQuotePricingMode] = useState<"catalog" | "manual">("catalog");
  const [promotionKind, setPromotionKind] = useState<"fixed" | "percentage">("fixed");
  const [supplyMode, setSupplyMode] = useState<SupplyMode>("unlimited");
  const [quoteFilter, setQuoteFilter] = useState("");
  const [voidReason, setVoidReason] = useState("Quote withdrawn by Staff before customer acceptance");
  const [automationProductId, setAutomationProductId] = useState("");
  const [automationPolicy, setAutomationPolicy] = useState<CatalogAutomationPolicy | null>(null);
  const [automationMode, setAutomationMode] = useState<AutomationMode>("manual");
  const [automationLoading, setAutomationLoading] = useState(false);
  const catalogGeneration = useRef(0);
  const promotionGeneration = useRef(0);
  const quoteGeneration = useRef(0);
  const automationGeneration = useRef(0);
  const zh = locale === "zh-CN";

  const loadCatalog = useCallback(async (reportFailure = true): Promise<boolean> => {
    if (!active || !canCatalogRead) return false;
    const generation = ++catalogGeneration.current;
    setCatalogLoading(true);
    try {
      const result = await api<CatalogSnapshot>("/api/v1/admin/catalog");
      if (catalogGeneration.current === generation) setCatalog(result);
      return true;
    } catch (caught) {
      if (catalogGeneration.current === generation) {
        setCatalog(EMPTY_CATALOG);
        if (reportFailure) {
          onError(caught instanceof Error ? caught.message : "Catalog could not be loaded");
        }
      }
      return false;
    } finally {
      if (catalogGeneration.current === generation) setCatalogLoading(false);
    }
  }, [active, canCatalogRead, onError]);

  const loadPromotions = useCallback(async (reportFailure = true): Promise<boolean> => {
    if (!active || !canPromotionsRead) return false;
    const generation = ++promotionGeneration.current;
    setPromotionLoading(true);
    try {
      const result = await api<{ warning: string; items: Promotion[] }>("/api/v1/admin/promotions");
      if (promotionGeneration.current === generation) setPromotions(result.items);
      return true;
    } catch (caught) {
      if (promotionGeneration.current === generation) {
        setPromotions([]);
        if (reportFailure) {
          onError(caught instanceof Error ? caught.message : "Promotions could not be loaded");
        }
      }
      return false;
    } finally {
      if (promotionGeneration.current === generation) setPromotionLoading(false);
    }
  }, [active, canPromotionsRead, onError]);

  const loadQuotes = useCallback(async (
    clientAccountFilter = "",
    reportFailure = true,
  ): Promise<boolean> => {
    if (!active || !canQuotesRead) return false;
    const generation = ++quoteGeneration.current;
    setQuoteLoading(true);
    try {
      const normalizedFilter = clientAccountFilter.trim();
      const suffix = normalizedFilter ? `?clientAccountId=${encodeURIComponent(normalizedFilter)}` : "";
      const result = await api<{ warning: string; items: CommerceQuote[] }>(`/api/v1/admin/quotes${suffix}`);
      if (quoteGeneration.current === generation) setQuotes(result.items);
      return true;
    } catch (caught) {
      if (quoteGeneration.current === generation) {
        setQuotes([]);
        if (reportFailure) {
          onError(caught instanceof Error ? caught.message : "Quotes could not be loaded");
        }
      }
      return false;
    } finally {
      if (quoteGeneration.current === generation) setQuoteLoading(false);
    }
  }, [active, canQuotesRead, onError]);

  const loadAutomationPolicy = useCallback(async (
    productId: string,
    reportFailure = true,
    preserveCommittedState = false,
  ): Promise<boolean> => {
    if (!active || !canCatalogManage) return false;
    const normalizedProductId = productId.trim();
    if (!/^[a-z][a-z0-9-]{1,79}$/.test(normalizedProductId)) {
      if (reportFailure) {
        onError(
          locale === "zh-CN"
            ? "请输入有效的 Product ID。"
            : "Enter a valid Product ID.",
        );
      }
      return false;
    }
    const generation = ++automationGeneration.current;
    setAutomationLoading(true);
    try {
      const result = await api<CatalogAutomationPolicy>(
        `/api/v1/admin/catalog/products/${encodeURIComponent(normalizedProductId)}/automation-policy`,
      );
      if (automationGeneration.current === generation) {
        setAutomationProductId(result.productId);
        setAutomationPolicy(result);
        setAutomationMode(result.automationMode);
      }
      return true;
    } catch (caught) {
      if (automationGeneration.current === generation) {
        if (!preserveCommittedState) setAutomationPolicy(null);
        if (reportFailure) {
          onError(
            caught instanceof Error
              ? caught.message
              : locale === "zh-CN"
                ? "无法加载 Provider automation policy。"
                : "Provider automation policy could not be loaded.",
          );
        }
      }
      return false;
    } finally {
      if (automationGeneration.current === generation) setAutomationLoading(false);
    }
  }, [active, canCatalogManage, locale, onError]);

  useEffect(() => {
    catalogGeneration.current += 1;
    setCatalog(EMPTY_CATALOG);
    if (active && canCatalogRead) void loadCatalog();
    return () => { catalogGeneration.current += 1; };
  }, [accessFingerprint, active, canCatalogRead, loadCatalog]);

  useEffect(() => {
    promotionGeneration.current += 1;
    setPromotions([]);
    if (active && canPromotionsRead) void loadPromotions();
    return () => { promotionGeneration.current += 1; };
  }, [accessFingerprint, active, canPromotionsRead, loadPromotions]);

  useEffect(() => {
    quoteGeneration.current += 1;
    setQuotes([]);
    setSelectedQuote(null);
    if (active && canQuotesRead) void loadQuotes("");
    return () => { quoteGeneration.current += 1; };
  }, [accessFingerprint, active, canQuotesRead, loadQuotes]);

  useEffect(() => {
    setPending(null);
    setSelectedQuote(null);
    automationGeneration.current += 1;
    setAutomationProductId("");
    setAutomationPolicy(null);
    setAutomationMode("manual");
    setAutomationLoading(false);
  }, [accessFingerprint]);

  async function mutate(
    key: string,
    path: string,
    method: "POST" | "PUT",
    body: Record<string, unknown>,
    notice: string,
    refresh: () => Promise<boolean | void>,
  ): Promise<boolean> {
    if (!active || pending !== null) return false;
    setPending(key);
    try {
      try {
        await api(path, { method, body: JSON.stringify(body) });
      } catch (caught) {
        onError(caught instanceof Error ? caught.message : "Commerce operation failed");
        return false;
      }
      onNotice(notice);
      try {
        const refreshed = await refresh();
        if (refreshed !== false) return true;
      } catch {
        // The mutation is already committed. Refresh failure must never make
        // an immutable revision or Quote look safe to submit again.
      }
      onError(
        zh
          ? `${notice} 已提交，但刷新失败；请手动刷新后再继续。`
          : `${notice} The change was committed, but refresh failed. Refresh manually before continuing.`,
      );
      return true;
    } finally {
      setPending(null);
    }
  }

  async function defineGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCatalogManage) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const groupId = requiredString(form, "groupId");
    const committed = await mutate(
      "group",
      `/api/v1/admin/catalog/groups/${encodeURIComponent(groupId)}`,
      "PUT",
      {
        sortOrder: Number(requiredString(form, "sortOrder")),
        names: {
          en: requiredString(form, "nameEn"),
          ...(optionalString(form, "nameZh") ? { "zh-CN": optionalString(form, "nameZh") } : {}),
        },
      },
      zh ? "产品组已保存。" : "Product group saved.",
      canCatalogRead ? () => loadCatalog(false) : async () => {},
    );
    if (committed) formElement.reset();
  }

  function productBody(form: FormData, optionSchema: string): Record<string, unknown> {
    return {
      groupId: requiredString(form, "groupId"),
      names: {
        en: requiredString(form, "nameEn"),
        ...(optionalString(form, "nameZh") ? { "zh-CN": optionalString(form, "nameZh") } : {}),
      },
      descriptions: {
        en: requiredString(form, "descriptionEn"),
        ...(optionalString(form, "descriptionZh") ? { "zh-CN": optionalString(form, "descriptionZh") } : {}),
      },
      fulfillmentMode: requiredString(form, "fulfillmentMode"),
      active: form.get("active") === "on",
      hidden: form.get("hidden") === "on",
      repeatable: form.get("repeatable") === "on",
      optionSchema: parseOptionArray(optionSchema),
    };
  }

  async function createProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCatalogManage) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const committed = await mutate(
        "product",
        "/api/v1/admin/catalog/products",
        "POST",
        { id: requiredString(form, "productId"), ...productBody(form, productOptionSchema) },
        zh ? "产品和首个不可变版本已创建。" : "Product and its first immutable revision created.",
        canCatalogRead ? () => loadCatalog(false) : async () => {},
      );
      if (committed) {
        formElement.reset();
        setProductOptionSchema("[]");
      }
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Product definition is invalid");
    }
  }

  async function createProductRevision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCatalogManage) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const productId = requiredString(form, "productId");
    try {
      const committed = await mutate(
        "product-revision",
        `/api/v1/admin/catalog/products/${encodeURIComponent(productId)}/revisions`,
        "POST",
        productBody(form, revisionOptionSchema),
        zh ? "新的产品版本已追加，历史版本保持不变。" : "A new Product revision was appended; history remains unchanged.",
        canCatalogRead ? () => loadCatalog(false) : async () => {},
      );
      if (committed) {
        formElement.reset();
        setRevisionOptionSchema("[]");
      }
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Product revision is invalid");
    }
  }

  async function openAutomationPolicy(productId: string) {
    if (!canCatalogManage) return;
    setAutomationProductId(productId);
    await loadAutomationPolicy(productId);
  }

  async function lookupAutomationPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCatalogManage) return;
    await loadAutomationPolicy(automationProductId);
  }

  async function saveAutomationPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCatalogManage || !automationPolicy || pending !== null) return;
    const productId = automationPolicy.productId;
    const committedNotice = zh
      ? `Product ${productId} 的 Provider automation policy 已提交。`
      : `Provider automation policy for Product ${productId} was committed.`;
    setPending("automation-policy");
    try {
      let committed: CatalogAutomationPolicy;
      try {
        committed = await api<CatalogAutomationPolicy>(
          `/api/v1/admin/catalog/products/${encodeURIComponent(productId)}/automation-policy`,
          {
            method: "PUT",
            body: JSON.stringify({
              automationMode,
              providerInstallationId:
                automationMode === "provider" ? "mock-provisioning-v1" : null,
              expectedVersion: automationPolicy.policyVersion,
            }),
          },
        );
      } catch (caught) {
        onError(
          caught instanceof Error
            ? caught.message
            : zh
              ? "无法保存 Provider automation policy。"
              : "Provider automation policy could not be saved.",
        );
        return;
      }

      // The PUT representation is authoritative once committed. Keep it even
      // if the optional follow-up GET is temporarily unavailable, so the UI
      // never presents an already-committed version as safe to submit again.
      setAutomationPolicy(committed);
      setAutomationMode(committed.automationMode);
      onNotice(committedNotice);
      const refreshed = await loadAutomationPolicy(productId, false, true);
      if (!refreshed) {
        onError(
          zh
            ? `${committedNotice} 后续刷新失败；当前显示提交后的 v${committed.policyVersion ?? "new"}，请手动刷新后再继续。`
            : `${committedNotice} The follow-up refresh failed; committed v${committed.policyVersion ?? "new"} remains shown. Refresh manually before continuing.`,
        );
      }
    } finally {
      setPending(null);
    }
  }

  async function createPrice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canPricingManage) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const productId = requiredString(form, "productId");
    const effectiveAt = optionalIso(form, "effectiveAt");
    const validUntil = optionalIso(form, "validUntil") ?? null;
    const committed = await mutate(
      "price",
      `/api/v1/admin/catalog/products/${encodeURIComponent(productId)}/prices`,
      "POST",
      {
        billingCycle: requiredString(form, "billingCycle"),
        currency: "USD",
        oneTimeMinor: requiredString(form, "oneTimeMinor"),
        setupMinor: requiredString(form, "setupMinor"),
        recurringMinor: requiredString(form, "recurringMinor"),
        ...(effectiveAt ? { effectiveAt } : {}),
        validUntil,
      },
      zh ? "新的 USD 价格版本已追加。" : "A new USD price revision was appended.",
      canCatalogRead ? () => loadCatalog(false) : async () => {},
    );
    if (committed) formElement.reset();
  }

  async function retirePrice(priceId: string) {
    if (!canPricingManage) return;
    await mutate(
      `retire-price:${priceId}`,
      `/api/v1/admin/catalog/prices/${priceId}/retire`,
      "POST",
      {},
      zh ? "价格版本已退役。" : "Price revision retired.",
      canCatalogRead ? () => loadCatalog(false) : async () => {},
    );
  }

  async function defineSupply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSupplyManage) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const productId = requiredString(form, "productId");
    const committed = await mutate(
      "supply",
      `/api/v1/admin/catalog/products/${encodeURIComponent(productId)}/supply`,
      "PUT",
      {
        mode: supplyMode,
        availableUnits: supplyMode === "tracked" ? requiredString(form, "availableUnits") : null,
      },
      zh ? "供应定义已保存。" : "Supply definition saved.",
      canCatalogRead ? () => loadCatalog(false) : async () => {},
    );
    if (committed) {
      formElement.reset();
      setSupplyMode("unlimited");
    }
  }

  async function createPromotion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canPromotionsManage) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const effectiveAt = optionalIso(form, "effectiveAt");
    const body: Record<string, unknown> = {
      code: requiredString(form, "code").toUpperCase(),
      name: requiredString(form, "name"),
      productId: optionalString(form, "productId"),
      billingCycle: optionalString(form, "billingCycle"),
      discountKind: promotionKind,
      applicationScope: requiredString(form, "applicationScope"),
      fixedAmountMinor: promotionKind === "fixed" ? requiredString(form, "fixedAmountMinor") : null,
      percentageBasisPoints: promotionKind === "percentage" ? Number(requiredString(form, "percentageBasisPoints")) : null,
      currency: promotionKind === "fixed" ? "USD" : null,
      ...(effectiveAt ? { effectiveAt } : {}),
      validUntil: optionalIso(form, "validUntil") ?? null,
      maximumRedemptions: optionalString(form, "maximumRedemptions"),
    };
    const committed = await mutate(
      "promotion",
      "/api/v1/admin/promotions",
      "POST",
      body,
      zh ? "新的 Promotion 版本已追加。" : "A new Promotion revision was appended.",
      canPromotionsRead ? () => loadPromotions(false) : async () => {},
    );
    if (committed) {
      formElement.reset();
      setPromotionKind("fixed");
    }
  }

  async function retirePromotion(promotionId: string) {
    if (!canPromotionsManage) return;
    await mutate(
      `retire-promotion:${promotionId}`,
      `/api/v1/admin/promotions/${promotionId}/retire`,
      "POST",
      {},
      zh ? "Promotion 版本已退役。" : "Promotion revision retired.",
      canPromotionsRead ? () => loadPromotions(false) : async () => {},
    );
  }

  async function createQuote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canQuotesManage) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const configuration = parseJsonObject(quoteConfiguration, "Quote configuration");
      const pricing = quotePricingMode === "catalog"
        ? {
            mode: "catalog",
            priceId: requiredString(form, "priceId"),
            configuration,
            promotionCode: optionalString(form, "promotionCode")?.toUpperCase() ?? null,
          }
        : {
            mode: "manual",
            productRevisionId: requiredString(form, "productRevisionId"),
            billingCycle: requiredString(form, "billingCycle"),
            currency: "USD",
            oneTimeMinor: requiredString(form, "oneTimeMinor"),
            setupMinor: requiredString(form, "setupMinor"),
            recurringMinor: requiredString(form, "recurringMinor"),
            configuration,
            promotionCode: optionalString(form, "promotionCode")?.toUpperCase() ?? null,
          };
      const committed = await mutate(
        "quote",
        "/api/v1/admin/quotes",
        "POST",
        {
          clientAccountId: requiredString(form, "clientAccountId"),
          expiresAt: new Date(requiredString(form, "expiresAt")).toISOString(),
          idempotencyKey: requiredString(form, "idempotencyKey"),
          pricing,
        },
        zh ? "Staff Quote 已创建；客户接受前不会生成 Order/Invoice。" : "Staff Quote created; no Order or Invoice exists until customer acceptance.",
        canQuotesRead ? () => loadQuotes(quoteFilter, false) : async () => {},
      );
      if (committed) {
        formElement.reset();
        setQuotePricingMode("catalog");
        setQuoteConfiguration("{}");
        const idempotency = formElement.elements.namedItem("idempotencyKey");
        if (idempotency instanceof HTMLInputElement) idempotency.value = newIdempotencyKey("staff-quote");
      }
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Quote definition is invalid");
    }
  }

  async function loadQuoteDetail(quoteId: string) {
    if (!canQuotesRead) return;
    const generation = ++quoteGeneration.current;
    setQuoteLoading(true);
    try {
      const result = await api<{ warning: string; quote: CommerceQuote }>(`/api/v1/admin/quotes/${quoteId}`);
      if (quoteGeneration.current === generation) setSelectedQuote(result.quote);
    } catch (caught) {
      if (quoteGeneration.current === generation) {
        onError(caught instanceof Error ? caught.message : "Quote detail could not be loaded");
      }
    } finally {
      if (quoteGeneration.current === generation) setQuoteLoading(false);
    }
  }

  async function voidQuote(quoteId: string) {
    if (!canQuotesManage) return;
    const committed = await mutate(
      `void-quote:${quoteId}`,
      `/api/v1/admin/quotes/${quoteId}/void`,
      "POST",
      { reason: voidReason.trim() },
      zh ? "Quote 已作废，历史报价保持可查。" : "Quote voided; its historical snapshot remains available.",
      canQuotesRead ? () => loadQuotes(quoteFilter, false) : async () => {},
    );
    if (committed && canQuotesRead) await loadQuoteDetail(quoteId);
  }

  if (!active) return null;
  if (
    !canCatalogRead && !canCatalogManage && !canPricingManage && !canSupplyManage &&
    !canPromotionsRead && !canPromotionsManage && !canQuotesRead && !canQuotesManage
  ) return null;

  return (
    <section className="order-panel commerce-admin-panel" data-testid="admin-commerce-panel" aria-label={zh ? "Commerce 管理" : "Commerce administration"}>
      <div>
        <p className="eyebrow">Staff · Commerce · Mock-only</p>
        <h2>{zh ? "Catalog、价格、供应、Promotion 与 Quote" : "Catalog, pricing, supply, Promotions and Quotes"}</h2>
        <p className="muted">
          {zh
            ? "每项运营能力按独立 Staff permission 加载；价格和报价均保留不可变快照。"
            : "Each operating surface loads under its own Staff permission; prices and Quotes retain immutable snapshots."}
        </p>
      </div>

      {(canCatalogRead || canCatalogManage) && (
        <section className="checkout-review" data-testid="admin-catalog-section">
          <p className="eyebrow">catalog.read · catalog.manage</p>
          <h3>{zh ? "Catalog 与产品版本" : "Catalog and Product revisions"}</h3>
          {canCatalogRead && (
            <>
              <button type="button" disabled={catalogLoading} onClick={() => void loadCatalog()}>{catalogLoading ? (zh ? "加载中…" : "Loading…") : (zh ? "刷新 Catalog" : "Refresh Catalog")}</button>
              <div className="manual-list">
                {catalog.products.length === 0 && !catalogLoading && <p className="muted">{zh ? "没有 Catalog 产品。" : "No Catalog products."}</p>}
                {catalog.products.map((product) => (
                  <article className="manual-item" key={product.id} data-testid="admin-catalog-product">
                    <strong>{localized(product.names, locale, product.id)} · r{product.currentRevision}</strong>
                    <span>{product.groupId} · {product.fulfillmentMode} · {product.active ? "active" : "inactive"}{product.hidden ? " · hidden" : ""}</span>
                    <span className="mono">{product.id} · {product.currentRevisionId}</span>
                    {canCatalogManage &&
                      (product.fulfillmentMode === "automatic" || product.fulfillmentMode === "review") && (
                        <button
                          type="button"
                          disabled={automationLoading || pending !== null}
                          onClick={() => void openAutomationPolicy(product.id)}
                        >
                          {zh ? "管理 Provider automation" : "Manage Provider automation"}
                        </button>
                      )}
                  </article>
                ))}
              </div>
            </>
          )}
          {canCatalogManage && (
            <div className="form-columns">
              <form onSubmit={defineGroup} data-testid="catalog-group-form">
                <h4>{zh ? "定义产品组" : "Define Product group"}</h4>
                <input name="groupId" required pattern="[a-z][a-z0-9-]{1,79}" placeholder="group-id" />
                <input name="sortOrder" required type="number" defaultValue="100" placeholder={zh ? "排序" : "Sort order"} />
                <input name="nameEn" required placeholder="English name" />
                <input name="nameZh" placeholder="简体中文名称（可选）" />
                <button disabled={pending !== null}>{zh ? "保存产品组" : "Save Product group"}</button>
              </form>
              <form onSubmit={createProduct} data-testid="catalog-product-form">
                <h4>{zh ? "创建产品" : "Create Product"}</h4>
                <input name="productId" required pattern="[a-z][a-z0-9-]{1,79}" placeholder="product-id" />
                <input name="groupId" required list="catalog-group-ids" placeholder="group-id" />
                <input name="nameEn" required placeholder="English name" />
                <input name="nameZh" placeholder="简体中文名称（可选）" />
                <textarea name="descriptionEn" required placeholder="English description" />
                <textarea name="descriptionZh" placeholder="简体中文描述（可选）" />
                <select name="fulfillmentMode" defaultValue="automatic">
                  <option value="automatic">Automatic</option><option value="review">Approval then provision</option><option value="manual">Fully manual</option><option value="quote">Quote required</option>
                </select>
                <label><input name="active" type="checkbox" defaultChecked />{zh ? "启用" : "Active"}</label>
                <label><input name="hidden" type="checkbox" />{zh ? "隐藏新购" : "Hidden from new purchase"}</label>
                <label><input name="repeatable" type="checkbox" />{zh ? "可重复购买" : "Repeatable"}</label>
                <OptionSchemaEditor locale={locale} value={productOptionSchema} onChange={setProductOptionSchema} onError={onError} />
                <button disabled={pending !== null}>{zh ? "创建产品" : "Create Product"}</button>
              </form>
              <form onSubmit={createProductRevision} data-testid="catalog-product-revision-form">
                <h4>{zh ? "追加产品版本" : "Append Product revision"}</h4>
                <input name="productId" required list="catalog-product-ids" placeholder="product-id" />
                <input name="groupId" required list="catalog-group-ids" placeholder="group-id" />
                <input name="nameEn" required placeholder="English name" />
                <input name="nameZh" placeholder="简体中文名称（可选）" />
                <textarea name="descriptionEn" required placeholder="English description" />
                <textarea name="descriptionZh" placeholder="简体中文描述（可选）" />
                <select name="fulfillmentMode" defaultValue="automatic">
                  <option value="automatic">Automatic</option><option value="review">Approval then provision</option><option value="manual">Fully manual</option><option value="quote">Quote required</option>
                </select>
                <label><input name="active" type="checkbox" defaultChecked />{zh ? "启用" : "Active"}</label>
                <label><input name="hidden" type="checkbox" />{zh ? "隐藏新购" : "Hidden from new purchase"}</label>
                <label><input name="repeatable" type="checkbox" />{zh ? "可重复购买" : "Repeatable"}</label>
                <OptionSchemaEditor locale={locale} value={revisionOptionSchema} onChange={setRevisionOptionSchema} onError={onError} />
                <button disabled={pending !== null}>{zh ? "追加版本" : "Append revision"}</button>
              </form>
            </div>
          )}
        </section>
      )}

      {canCatalogManage && (
        <section
          className="checkout-review"
          data-testid="admin-automation-policy-section"
          aria-label={zh ? "Provider automation policy" : "Provider automation policy"}
        >
          <p className="eyebrow">catalog.manage</p>
          <h3>{zh ? "Provider automation policy" : "Provider automation policy"}</h3>
          <p className="muted">
            {zh
              ? "仅 Automatic 与 Approval then provision 产品可配置。Manual / null 表示真实的 Staff 手工履约：Checkout 后不会创建 Provider operation 或 job。新策略只影响之后 Checkout 创建的 Service binding；既有 Service 永远按其 binding 快照执行。"
              : "Only Automatic and Approval then provision products are configurable. Manual / null is real Staff fulfillment: Checkouts create no Provider operation or job. A new policy affects only later Service bindings; each existing Service continues from its saved binding snapshot."}
          </p>
          <form
            className="automation-policy-lookup"
            data-testid="automation-policy-lookup-form"
            onSubmit={lookupAutomationPolicy}
          >
            <label>
              Product ID
              <input
                value={automationProductId}
                required
                pattern="[a-z][a-z0-9-]{1,79}"
                list={canCatalogRead ? "catalog-automation-product-ids" : undefined}
                placeholder="product-id"
                onChange={(event) => {
                  automationGeneration.current += 1;
                  setAutomationProductId(event.target.value);
                  setAutomationPolicy(null);
                  setAutomationLoading(false);
                }}
              />
            </label>
            <button disabled={automationLoading || pending !== null}>
              {automationLoading
                ? (zh ? "加载中…" : "Loading…")
                : (zh ? "读取 policy" : "Load policy")}
            </button>
          </form>

          {automationPolicy && (
            <article className="manual-item automation-policy-detail" data-testid="automation-policy-detail">
              <strong>
                {automationPolicy.productId} · {automationPolicy.fulfillmentMode}
              </strong>
              <span data-testid="automation-policy-version">
                {automationPolicy.configured
                  ? `${zh ? "Policy 版本" : "Policy version"}: v${automationPolicy.policyVersion}`
                  : (zh ? "尚未配置（首次保存将创建 v1）" : "Not configured (the first save creates v1)")}
                {automationPolicy.providerVersion === null
                  ? ""
                  : ` · Provider v${automationPolicy.providerVersion}`}
              </span>
              <span>
                {automationPolicy.productActive ? "active" : "inactive"}
                {automationPolicy.productHidden ? " · hidden" : ""}
                {automationPolicy.updatedAt ? ` · ${when(automationPolicy.updatedAt)}` : ""}
              </span>
              <span data-testid="automation-provider-readiness">
                {automationPolicy.automationMode === "manual"
                  ? (zh ? "Manual binding / Staff 完成 / 无 Provider operation 或 job" : "Manual binding / Staff completion / no Provider operation or job")
                  : automationPolicy.providerReady
                    ? (zh ? "Provider Ready" : "Provider Ready")
                    : (zh ? "Provider Not Ready" : "Provider Not Ready")}
              </span>
              {automationPolicy.automationMode === "provider" && (
                <>
                  <span>
                    {zh ? "Provider" : "Provider"}: {automationPolicy.providerInstallationId}
                    {` · ${zh ? "启用" : "enabled"}: ${String(automationPolicy.providerEnabled)}`}
                  </span>
                  <span data-testid="automation-missing-capabilities">
                    {zh ? "缺失 capabilities" : "Missing capabilities"}: {automationPolicy.missingCapabilities.length > 0
                      ? automationPolicy.missingCapabilities.join(", ")
                      : (zh ? "无" : "none")}
                  </span>
                </>
              )}
              <span data-testid="automation-capability-snapshot">
                {zh ? "新 binding capability snapshot" : "New-binding capability snapshot"}: {automationPolicy.capabilitySnapshot.length > 0
                  ? automationPolicy.capabilitySnapshot.join(", ")
                  : (zh ? "空" : "empty")}
              </span>
              <form data-testid="automation-policy-form" onSubmit={saveAutomationPolicy}>
                <label>
                  {zh ? "履约 automation" : "Fulfillment automation"}
                  <select
                    aria-label={zh ? "Automation mode" : "Automation mode"}
                    value={automationMode}
                    onChange={(event) => setAutomationMode(event.target.value as AutomationMode)}
                  >
                    <option value="provider">Provider · mock-provisioning-v1</option>
                    <option value="manual">Manual · null</option>
                  </select>
                </label>
                <p className="muted">
                  {zh
                    ? `保存时将精确匹配 ${automationPolicy.policyVersion === null ? "尚未创建" : `v${automationPolicy.policyVersion}`}；若其他 Staff 已更新，系统会要求重新读取。`
                    : `Save requires the exact ${automationPolicy.policyVersion === null ? "not-yet-created version" : `v${automationPolicy.policyVersion}`}; if another Staff User changed it, reload first.`}
                </p>
                <div className="button-row">
                  <button disabled={pending !== null || automationLoading}>
                    {zh ? "保存 automation policy" : "Save automation policy"}
                  </button>
                  <button
                    type="button"
                    disabled={pending !== null || automationLoading}
                    onClick={() => void loadAutomationPolicy(automationPolicy.productId)}
                  >
                    {zh ? "刷新当前 policy" : "Refresh current policy"}
                  </button>
                </div>
              </form>
            </article>
          )}
        </section>
      )}

      {canPricingManage && (
        <section className="checkout-review" data-testid="admin-pricing-section">
          <p className="eyebrow">catalog.pricing.manage</p>
          <h3>{zh ? "USD 价格 revision" : "USD price revisions"}</h3>
          <p className="muted">{zh ? "所有金额输入均为整数 minor units；USD 100.00 = 10000。" : "Every amount is an integer minor-unit value; USD 100.00 = 10000."}</p>
          <form onSubmit={createPrice}>
            <input name="productId" required list="catalog-product-ids" placeholder="product-id" />
            <select name="billingCycle" defaultValue="monthly">{BILLING_CYCLES.map((cycle) => <option key={cycle} value={cycle}>{cycle}</option>)}</select>
            <input name="oneTimeMinor" required inputMode="numeric" pattern="(0|[1-9][0-9]*)" defaultValue="0" placeholder="USD one-time minor units" />
            <input name="setupMinor" required inputMode="numeric" pattern="(0|[1-9][0-9]*)" defaultValue="0" placeholder="USD setup minor units" />
            <input name="recurringMinor" required inputMode="numeric" pattern="(0|[1-9][0-9]*)" defaultValue="0" placeholder="USD recurring minor units" />
            <label>{zh ? "生效时间（空白表示现在）" : "Effective at (blank means now)"}<input name="effectiveAt" type="datetime-local" /></label>
            <label>{zh ? "失效时间（可选）" : "Valid until (optional)"}<input name="validUntil" type="datetime-local" /></label>
            <button disabled={pending !== null}>{zh ? "追加价格版本" : "Append price revision"}</button>
          </form>
          {canCatalogRead && (
            <div className="manual-list">
              {catalog.prices.map((price) => (
                <article className="manual-item" key={price.id}>
                  <strong>{price.productId} · {price.billingCycle} · r{price.revision}</strong>
                  <span>{usd(price.oneTimeMinor)} one-time · {usd(price.setupMinor)} setup · {usd(price.recurringMinor)} recurring</span>
                  <span>{when(price.validFrom)} → {when(price.validUntil)} · {price.active ? "active" : "retired"}</span>
                  <span className="mono">{price.id}</span>
                  {price.active && <button type="button" disabled={pending !== null} onClick={() => void retirePrice(price.id)}>{zh ? "现在退役" : "Retire now"}</button>}
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {canSupplyManage && (
        <section className="checkout-review" data-testid="admin-supply-section">
          <p className="eyebrow">catalog.supply.manage</p>
          <h3>{zh ? "供应能力" : "Supply capacity"}</h3>
          <form onSubmit={defineSupply}>
            <input name="productId" required list="catalog-product-ids" placeholder="product-id" />
            <select value={supplyMode} onChange={(event) => setSupplyMode(event.target.value as SupplyMode)}>
              <option value="unlimited">unlimited</option><option value="tracked">tracked</option><option value="manual_review">manual_review</option>
            </select>
            {supplyMode === "tracked" && <input name="availableUnits" required inputMode="numeric" pattern="(0|[1-9][0-9]*)" placeholder={zh ? "可用 units" : "Available units"} />}
            <button disabled={pending !== null}>{zh ? "保存供应定义" : "Save supply definition"}</button>
          </form>
          {canCatalogRead && (
            <div className="manual-list">
              {catalog.supply.map((item) => (
                <article className="manual-item" key={item.productId}>
                  <strong>{item.productId} · {item.mode}</strong>
                  <span>{zh ? "可用" : "Available"}: {item.availableUnits ?? "—"} · {zh ? "已承诺" : "Committed"}: {item.committedUnits} · v{item.version}</span>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {(canPromotionsRead || canPromotionsManage) && (
        <section className="checkout-review" data-testid="admin-promotions-section">
          <p className="eyebrow">catalog.promotions.read · catalog.promotions.manage</p>
          <h3>Promotion</h3>
          {canPromotionsManage && (
            <form onSubmit={createPromotion}>
              <input name="code" required pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,63}" placeholder="PROMO_CODE" />
              <input name="name" required placeholder={zh ? "Promotion 名称" : "Promotion name"} />
              <input name="productId" list="catalog-product-ids" placeholder={zh ? "product-id（空白表示全部）" : "product-id (blank means all)"} />
              <select name="billingCycle" defaultValue=""><option value="">{zh ? "全部周期" : "All billing cycles"}</option>{BILLING_CYCLES.map((cycle) => <option key={cycle} value={cycle}>{cycle}</option>)}</select>
              <select value={promotionKind} onChange={(event) => setPromotionKind(event.target.value as "fixed" | "percentage")}><option value="fixed">fixed</option><option value="percentage">percentage</option></select>
              <select name="applicationScope" defaultValue="all"><option value="one_time">one_time</option><option value="recurring">recurring</option><option value="all">all</option></select>
              {promotionKind === "fixed"
                ? <input name="fixedAmountMinor" required inputMode="numeric" pattern="[1-9][0-9]*" placeholder="USD fixed amount (minor units)" />
                : <input name="percentageBasisPoints" required type="number" min="1" max="10000" placeholder="basis points (100 = 1%)" />}
              <label>{zh ? "生效时间（空白表示现在）" : "Effective at (blank means now)"}<input name="effectiveAt" type="datetime-local" /></label>
              <label>{zh ? "失效时间（可选）" : "Valid until (optional)"}<input name="validUntil" type="datetime-local" /></label>
              <input name="maximumRedemptions" inputMode="numeric" pattern="[1-9][0-9]*" placeholder={zh ? "最大兑换数（可选）" : "Maximum redemptions (optional)"} />
              <button disabled={pending !== null}>{zh ? "追加 Promotion 版本" : "Append Promotion revision"}</button>
            </form>
          )}
          {canPromotionsRead && (
            <>
              <button type="button" disabled={promotionLoading} onClick={() => void loadPromotions()}>{promotionLoading ? (zh ? "加载中…" : "Loading…") : (zh ? "刷新 Promotion" : "Refresh Promotions")}</button>
              <div className="manual-list">
                {promotions.length === 0 && !promotionLoading && <p className="muted">{zh ? "没有 Promotion。" : "No Promotions."}</p>}
                {promotions.map((promotion) => (
                  <article className="manual-item" key={promotion.id}>
                    <strong>{promotion.code} · r{promotion.revision} · {promotion.active ? "active" : "retired"}</strong>
                    <span>{promotion.name} · {promotion.discountKind === "fixed" ? usd(promotion.fixedAmountMinor ?? "0") : `${promotion.percentageBasisPoints ?? 0} bp`} · {promotion.applicationScope}</span>
                    <span>{promotion.productId ?? "all products"} · {promotion.billingCycle ?? "all cycles"} · {promotion.redemptions}/{promotion.maximumRedemptions ?? "∞"}</span>
                    <span>{when(promotion.validFrom)} → {when(promotion.validUntil)}</span>
                    {canPromotionsManage && promotion.active && <button type="button" disabled={pending !== null} onClick={() => void retirePromotion(promotion.id)}>{zh ? "现在退役" : "Retire now"}</button>}
                  </article>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {(canQuotesRead || canQuotesManage) && (
        <section className="checkout-review" data-testid="admin-quotes-section">
          <p className="eyebrow">quotes.read · quotes.manage</p>
          <h3>{zh ? "Staff Quote" : "Staff Quotes"}</h3>
          {canQuotesManage && (
            <form onSubmit={createQuote} data-testid="admin-quote-create-form">
              <input name="clientAccountId" required placeholder="Client Account UUID" />
              <label>{zh ? "到期时间（5 分钟至 90 天）" : "Expires at (5 minutes to 90 days)"}<input name="expiresAt" required type="datetime-local" /></label>
              <input name="idempotencyKey" required minLength={8} maxLength={128} defaultValue={newIdempotencyKey("staff-quote")} />
              <select value={quotePricingMode} onChange={(event) => setQuotePricingMode(event.target.value as "catalog" | "manual")}>
                <option value="catalog">Catalog price</option><option value="manual">Manual USD price</option>
              </select>
              {quotePricingMode === "catalog" ? (
                <input name="priceId" required list="catalog-price-ids" placeholder="Catalog price UUID" />
              ) : (
                <>
                  <input name="productRevisionId" required list="catalog-revision-ids" placeholder="Product revision UUID" />
                  <select name="billingCycle" defaultValue="monthly">{BILLING_CYCLES.map((cycle) => <option key={cycle} value={cycle}>{cycle}</option>)}</select>
                  <p className="muted">{zh ? "下列金额全部是 USD 整数 minor units。" : "All following amounts are integer USD minor units."}</p>
                  <input name="oneTimeMinor" required inputMode="numeric" pattern="(0|[1-9][0-9]*)" defaultValue="0" placeholder="USD one-time minor units" />
                  <input name="setupMinor" required inputMode="numeric" pattern="(0|[1-9][0-9]*)" defaultValue="0" placeholder="USD setup minor units" />
                  <input name="recurringMinor" required inputMode="numeric" pattern="(0|[1-9][0-9]*)" defaultValue="0" placeholder="USD recurring minor units" />
                </>
              )}
              <input name="promotionCode" placeholder={zh ? "Promotion code（可选）" : "Promotion code (optional)"} />
              <label>{zh ? "产品配置 JSON（仅 scalar values）" : "Product configuration JSON (scalar values only)"}<textarea rows={6} value={quoteConfiguration} onChange={(event) => setQuoteConfiguration(event.target.value)} spellCheck={false} /></label>
              <button disabled={pending !== null}>{zh ? "创建 Quote" : "Create Quote"}</button>
            </form>
          )}
          {canQuotesRead && (
            <>
              <div className="button-row">
                <input value={quoteFilter} onChange={(event) => setQuoteFilter(event.target.value)} placeholder={zh ? "按 Client Account UUID 筛选" : "Filter by Client Account UUID"} />
                <button type="button" disabled={quoteLoading} onClick={() => void loadQuotes(quoteFilter)}>{quoteLoading ? (zh ? "加载中…" : "Loading…") : (zh ? "刷新 Quote" : "Refresh Quotes")}</button>
              </div>
              <div className="manual-list">
                {quotes.length === 0 && !quoteLoading && <p className="muted">{zh ? "没有 Quote。" : "No Quotes."}</p>}
                {quotes.map((quote) => (
                  <article className="manual-item" key={quote.quoteId} data-testid="admin-quote-item">
                    <QuoteSummary quote={quote} locale={locale} />
                    <button type="button" onClick={() => void loadQuoteDetail(quote.quoteId)}>{zh ? "打开详情" : "Open detail"}</button>
                  </article>
                ))}
              </div>
            </>
          )}
          {selectedQuote && canQuotesRead && (
            <article className="manual-item" data-testid="admin-quote-detail">
              <QuoteSummary quote={selectedQuote} locale={locale} />
              <span className="mono">{selectedQuote.quoteId}</span>
              <pre>{JSON.stringify(selectedQuote.configuration, null, 2)}</pre>
              {selectedQuote.acceptance && <span>Order {selectedQuote.acceptance.orderId} · Invoice {selectedQuote.acceptance.invoiceId}</span>}
              {selectedQuote.void && <span>{selectedQuote.void.reason}</span>}
              {canQuotesManage && selectedQuote.status === "draft" && (
                <>
                  <label>{zh ? "作废原因（至少 10 字符）" : "Void reason (at least 10 characters)"}<textarea value={voidReason} minLength={10} maxLength={1000} onChange={(event) => setVoidReason(event.target.value)} /></label>
                  <button type="button" disabled={pending !== null || voidReason.trim().length < 10} onClick={() => void voidQuote(selectedQuote.quoteId)}>{zh ? "作废 Quote" : "Void Quote"}</button>
                </>
              )}
            </article>
          )}
          {canQuotesManage && !canQuotesRead && (
            <form onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void voidQuote(requiredString(form, "quoteId")); }}>
              <h4>{zh ? "按已知 UUID 作废 Quote" : "Void Quote by known UUID"}</h4>
              <input name="quoteId" required placeholder="Quote UUID" />
              <textarea value={voidReason} minLength={10} maxLength={1000} onChange={(event) => setVoidReason(event.target.value)} />
              <button disabled={pending !== null || voidReason.trim().length < 10}>{zh ? "作废 Quote" : "Void Quote"}</button>
            </form>
          )}
        </section>
      )}

      <datalist id="catalog-group-ids">{catalog.groups.map((group) => <option key={group.id} value={group.id} />)}</datalist>
      <datalist id="catalog-product-ids">{catalog.products.map((product) => <option key={product.id} value={product.id} />)}</datalist>
      <datalist id="catalog-automation-product-ids">{catalog.products.filter((product) => product.fulfillmentMode === "automatic" || product.fulfillmentMode === "review").map((product) => <option key={product.id} value={product.id}>{localized(product.names, locale, product.id)} · {product.fulfillmentMode}</option>)}</datalist>
      <datalist id="catalog-price-ids">{catalog.prices.filter((price) => price.active).map((price) => <option key={price.id} value={price.id}>{price.productId} · {price.billingCycle}</option>)}</datalist>
      <datalist id="catalog-revision-ids">{catalog.revisions.map((revision) => <option key={revision.id} value={revision.id}>{revision.productId} · r{revision.revision}</option>)}</datalist>
    </section>
  );
}
