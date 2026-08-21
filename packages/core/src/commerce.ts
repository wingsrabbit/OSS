// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  buildPriceSnapshot,
  type BillingCycle,
  type FulfillmentMode,
  type PriceComponent,
  type PriceSnapshot,
} from "./index.js";

export type CatalogConfigurationValue = string | number | boolean;
export type CatalogConfiguration = Readonly<Record<string, CatalogConfigurationValue>>;

export class CommercialValidationError extends Error {
  readonly code = "INVALID_CONFIGURATION";
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "CommercialValidationError";
  }
}

export type ResolvedCatalogConfiguration = Readonly<{
  configurationSnapshot: Readonly<Record<string, unknown>>;
  components: readonly PriceComponent[];
  capacityUnits: bigint;
}>;

type ParsedChoice = Readonly<{
  value: string;
  oneTimeMinor: bigint;
  recurringMinor: bigint;
  capacityUnits: bigint;
}>;

type ParsedCondition = Readonly<{
  code: string;
  allowedValues: readonly CatalogConfigurationValue[];
}>;

function recordValue(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CommercialValidationError(message);
  }
  return value as Record<string, unknown>;
}

function optionCode(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) {
    throw new CommercialValidationError("Every product option needs a canonical code");
  }
  return value;
}

function safeInteger(value: unknown, fallback: number, field: string): number {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate)) {
    throw new CommercialValidationError(`${field} must be a safe integer`);
  }
  return candidate as number;
}

type ParsedDecimal = Readonly<{
  value: number;
  coefficient: bigint;
  scale: number;
}>;

function parsedDecimal(value: unknown, fallback: number, field: string): ParsedDecimal {
  const candidate = value === undefined ? fallback : value;
  const text =
    typeof candidate === "number"
      ? Number.isFinite(candidate)
        ? String(candidate)
        : ""
      : typeof candidate === "string"
        ? candidate
        : "";
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) {
    throw new CommercialValidationError(
      `${field} must be a finite decimal with at most 6 decimal places`,
    );
  }
  const fraction = match[3] ?? "";
  const coefficient = BigInt(`${match[1] ?? ""}${match[2]}${fraction}`);
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || Math.abs(numeric) > Number.MAX_SAFE_INTEGER) {
    throw new CommercialValidationError(`${field} is outside the supported decimal range`);
  }
  return { value: numeric, coefficient, scale: fraction.length };
}

function scaledDecimal(value: ParsedDecimal, scale: number): bigint {
  return value.coefficient * 10n ** BigInt(scale - value.scale);
}

function decimalStepAligned(
  value: ParsedDecimal,
  minimum: ParsedDecimal,
  step: ParsedDecimal,
): boolean {
  const scale = Math.max(value.scale, minimum.scale, step.scale);
  const stepCoefficient = scaledDecimal(step, scale);
  return (
    stepCoefficient > 0n &&
    (scaledDecimal(value, scale) - scaledDecimal(minimum, scale)) % stepCoefficient === 0n
  );
}

function nonnegativeMinor(value: unknown, field: string): bigint {
  if (value === undefined) return 0n;
  const candidate = safeInteger(value, 0, field);
  if (candidate < 0) {
    throw new CommercialValidationError(`${field} cannot be negative`);
  }
  return BigInt(candidate);
}

function positiveCapacity(value: unknown, fallback: bigint, field: string): bigint {
  if (value === undefined) return fallback;
  const candidate = safeInteger(value, 0, field);
  if (candidate < 0) {
    throw new CommercialValidationError(`${field} cannot be negative`);
  }
  return BigInt(candidate);
}

function parseCondition(raw: unknown, field: string): ParsedCondition | null {
  if (raw === undefined) return null;
  const condition = recordValue(raw, `${field} must be an object`);
  const code = optionCode(condition.code ?? condition.optionCode ?? condition.option);
  if (Object.hasOwn(condition, "equals")) {
    const equals = condition.equals;
    if (!["string", "number", "boolean"].includes(typeof equals)) {
      throw new CommercialValidationError(`${field}.equals must be a scalar value`);
    }
    return { code, allowedValues: [equals as CatalogConfigurationValue] };
  }
  if (!Array.isArray(condition.in) || condition.in.length === 0) {
    throw new CommercialValidationError(`${field} needs equals or a non-empty in list`);
  }
  if (
    !condition.in.every((value) =>
      ["string", "number", "boolean"].includes(typeof value),
    )
  ) {
    throw new CommercialValidationError(`${field}.in must contain only scalar values`);
  }
  return {
    code,
    allowedValues: condition.in as CatalogConfigurationValue[],
  };
}

function conditionMatches(
  condition: ParsedCondition | null,
  configuration: CatalogConfiguration,
): boolean {
  if (!condition) return true;
  const actual = configuration[condition.code];
  return condition.allowedValues.some((candidate) => candidate === actual);
}

function parseChoice(raw: unknown, field: string): ParsedChoice {
  if (typeof raw === "string") {
    if (raw.length === 0 || raw.length > 128) {
      throw new CommercialValidationError(`${field} contains an invalid value`);
    }
    return { value: raw, oneTimeMinor: 0n, recurringMinor: 0n, capacityUnits: 0n };
  }
  const choice = recordValue(raw, `${field} choices must be strings or objects`);
  if (typeof choice.value !== "string" || choice.value.length === 0 || choice.value.length > 128) {
    throw new CommercialValidationError(`${field} choice value is invalid`);
  }
  return {
    value: choice.value,
    oneTimeMinor: nonnegativeMinor(choice.oneTimeMinor, `${field}.oneTimeMinor`),
    recurringMinor: nonnegativeMinor(choice.recurringMinor, `${field}.recurringMinor`),
    capacityUnits: positiveCapacity(choice.capacityUnits, 0n, `${field}.capacityUnits`),
  };
}

function dependencyOverrides(
  option: Record<string, unknown>,
  precedingSelectionCodes: readonly string[],
  configuration: CatalogConfiguration,
): Readonly<{ min?: unknown; max?: unknown; required?: unknown }> {
  if (option.dependencies === undefined) return {};
  const dependencies = recordValue(
    option.dependencies,
    `${String(option.code)}.dependencies must be an object`,
  );
  const controllingCode = precedingSelectionCodes.at(-1);
  if (!controllingCode) {
    throw new CommercialValidationError(
      `${String(option.code)}.dependencies needs a preceding Select or Radio option`,
    );
  }
  const configured = configuration[controllingCode];
  if (typeof configured !== "string") return {};
  const override = dependencies[configured];
  if (override === undefined) return {};
  return recordValue(
    override,
    `${String(option.code)}.dependencies.${configured} must be an object`,
  );
}

export function validateCatalogOptionSchema(optionSchema: unknown): asserts optionSchema is unknown[] {
  if (!Array.isArray(optionSchema)) {
    throw new CommercialValidationError("Product option schema must be an array");
  }
  const precedingCodes = new Set<string>();
  let hasPrecedingSelection = false;
  for (const [index, rawOption] of optionSchema.entries()) {
    const option = recordValue(rawOption, `Product option ${index} must be an object`);
    const code = optionCode(option.code);
    if (precedingCodes.has(code)) {
      throw new CommercialValidationError(`Product option ${code} is repeated`);
    }
    const type = option.type;
    if (
      type !== "select" &&
      type !== "radio" &&
      type !== "quantity" &&
      type !== "text" &&
      type !== "secret" &&
      type !== "password" &&
      type !== "textarea"
    ) {
      throw new CommercialValidationError(`Product option ${code} has an unsupported type`);
    }
    for (const [field, rawCondition] of [
      ["visibleWhen", option.visibleWhen],
      ["dependsOn", option.dependsOn],
    ] as const) {
      const condition = parseCondition(rawCondition, `${code}.${field}`);
      if (condition && !precedingCodes.has(condition.code)) {
        throw new CommercialValidationError(
          `${code} depends on ${condition.code}, which must be declared earlier`,
        );
      }
    }
    if (option.dependencies !== undefined) {
      const dependencies = recordValue(
        option.dependencies,
        `${code}.dependencies must be an object`,
      );
      if (!hasPrecedingSelection) {
        throw new CommercialValidationError(
          `${code}.dependencies needs a preceding Select or Radio option`,
        );
      }
      for (const [value, rawOverride] of Object.entries(dependencies)) {
        const override = recordValue(
          rawOverride,
          `${code}.dependencies.${value} must be an object`,
        );
        if (override.min !== undefined) parsedDecimal(override.min, 0, `${code}.dependencies.${value}.min`);
        if (override.max !== undefined) parsedDecimal(override.max, 0, `${code}.dependencies.${value}.max`);
        if (override.required !== undefined && typeof override.required !== "boolean") {
          throw new CommercialValidationError(
            `${code}.dependencies.${value}.required must be boolean`,
          );
        }
      }
    }
    if (type === "select" || type === "radio") {
      if (!Array.isArray(option.values) || option.values.length === 0) {
        throw new CommercialValidationError(`${code} needs at least one allowed value`);
      }
      const choices = option.values.map((choice, choiceIndex) =>
        parseChoice(choice, `${code}.values[${choiceIndex}]`),
      );
      if (new Set(choices.map((choice) => choice.value)).size !== choices.length) {
        throw new CommercialValidationError(`${code} contains duplicate allowed values`);
      }
      hasPrecedingSelection = true;
    } else if (type === "quantity") {
      const minimum = parsedDecimal(option.min, 0, `${code}.min`);
      const maximum = parsedDecimal(option.max, Number.MAX_SAFE_INTEGER, `${code}.max`);
      const step = parsedDecimal(option.step, 1, `${code}.step`);
      if (minimum.value > maximum.value || step.value <= 0) {
        throw new CommercialValidationError(`${code} has an invalid quantity range`);
      }
      nonnegativeMinor(option.oneTimeUnitMinor, `${code}.oneTimeUnitMinor`);
      nonnegativeMinor(option.recurringUnitMinor, `${code}.recurringUnitMinor`);
      positiveCapacity(option.capacityUnitsPerUnit, 0n, `${code}.capacityUnitsPerUnit`);
    } else {
      const minimum = safeInteger(option.minLength, option.required === true ? 1 : 0, `${code}.minLength`);
      const maximum = safeInteger(option.maxLength, 4096, `${code}.maxLength`);
      if (minimum < 0 || maximum < minimum) {
        throw new CommercialValidationError(`${code} has an invalid text length range`);
      }
      nonnegativeMinor(option.oneTimeMinor, `${code}.oneTimeMinor`);
      nonnegativeMinor(option.recurringMinor, `${code}.recurringMinor`);
    }
    precedingCodes.add(code);
  }
}

export function resolveCatalogConfiguration(
  optionSchema: unknown,
  configuration: CatalogConfiguration,
): ResolvedCatalogConfiguration {
  validateCatalogOptionSchema(optionSchema);
  const components: PriceComponent[] = [];
  const snapshot: Record<string, unknown> = {};
  const acceptedCodes = new Set<string>();
  const precedingCodes = new Set<string>();
  const precedingSelectionCodes: string[] = [];
  let capacityUnits = 1n;

  for (const [index, rawOption] of optionSchema.entries()) {
    const option = recordValue(rawOption, `Product option ${index} must be an object`);
    const code = optionCode(option.code);
    if (acceptedCodes.has(code)) {
      throw new CommercialValidationError(`Product option ${code} is repeated`);
    }
    acceptedCodes.add(code);
    const type = option.type;
    if (
      type !== "select" &&
      type !== "radio" &&
      type !== "quantity" &&
      type !== "text" &&
      type !== "secret" &&
      type !== "password" &&
      type !== "textarea"
    ) {
      throw new CommercialValidationError(`Product option ${code} has an unsupported type`);
    }

    const visibleWhen = parseCondition(option.visibleWhen, `${code}.visibleWhen`);
    const dependsOn = parseCondition(option.dependsOn, `${code}.dependsOn`);
    for (const condition of [visibleWhen, dependsOn]) {
      if (condition && !precedingCodes.has(condition.code)) {
        throw new CommercialValidationError(
          `${code} depends on ${condition.code}, which must be declared earlier`,
        );
      }
    }
    const active =
      conditionMatches(visibleWhen, configuration) &&
      conditionMatches(dependsOn, configuration);
    const configured = Object.hasOwn(configuration, code);
    if (!active) {
      if (configured) {
        throw new CommercialValidationError(`${code} is not available for this configuration`);
      }
      precedingCodes.add(code);
      if (type === "select" || type === "radio") precedingSelectionCodes.push(code);
      continue;
    }

    const overrides = dependencyOverrides(option, precedingSelectionCodes, configuration);
    const required = overrides.required === true || (overrides.required === undefined && option.required === true);
    if (required && !configured) {
      throw new CommercialValidationError(`${code} is required`);
    }
    if (!configured) {
      precedingCodes.add(code);
      if (type === "select" || type === "radio") precedingSelectionCodes.push(code);
      continue;
    }
    const value = configuration[code];
    if (value === undefined) {
      throw new CommercialValidationError(`${code} cannot be undefined`);
    }

    if (type === "select" || type === "radio") {
      if (typeof value !== "string") {
        throw new CommercialValidationError(`${code} must select one string value`);
      }
      if (!Array.isArray(option.values) || option.values.length === 0) {
        throw new CommercialValidationError(`${code} needs at least one allowed value`);
      }
      const choices = option.values.map((choice, choiceIndex) =>
        parseChoice(choice, `${code}.values[${choiceIndex}]`),
      );
      if (new Set(choices.map((choice) => choice.value)).size !== choices.length) {
        throw new CommercialValidationError(`${code} contains duplicate allowed values`);
      }
      const choice = choices.find((candidate) => candidate.value === value);
      if (!choice) throw new CommercialValidationError(`${code} is not an allowed value`);
      snapshot[code] = value;
      if (choice.oneTimeMinor > 0n || choice.recurringMinor > 0n) {
        components.push({
          code: `${code}:${choice.value}`,
          label: `${code}: ${choice.value}`,
          quantity: 1,
          oneTimeMinor: choice.oneTimeMinor,
          recurringMinor: choice.recurringMinor,
        });
      }
      capacityUnits += choice.capacityUnits;
    } else if (type === "quantity") {
      const quantity = parsedDecimal(value, 0, code);
      const minimum = parsedDecimal(overrides.min ?? option.min, 0, `${code}.min`);
      const maximum = parsedDecimal(
        overrides.max ?? option.max,
        Number.MAX_SAFE_INTEGER,
        `${code}.max`,
      );
      const step = parsedDecimal(option.step, 1, `${code}.step`);
      if (
        step.value <= 0 ||
        minimum.value > maximum.value ||
        quantity.value < minimum.value ||
        quantity.value > maximum.value ||
        !decimalStepAligned(quantity, minimum, step)
      ) {
        throw new CommercialValidationError(`${code} is outside its allowed quantity range`);
      }
      snapshot[code] = quantity.value;
      const oneTimeUnitMinor = nonnegativeMinor(
        option.oneTimeUnitMinor,
        `${code}.oneTimeUnitMinor`,
      );
      const recurringUnitMinor = nonnegativeMinor(
        option.recurringUnitMinor,
        `${code}.recurringUnitMinor`,
      );
      if (oneTimeUnitMinor > 0n || recurringUnitMinor > 0n) {
        if (!Number.isSafeInteger(quantity.value)) {
          throw new CommercialValidationError(
            `${code} must be a whole number when it changes a price`,
          );
        }
        components.push({
          code,
          label: code,
          quantity: quantity.value,
          oneTimeMinor: oneTimeUnitMinor,
          recurringMinor: recurringUnitMinor,
        });
      }
      const capacityUnitsPerUnit = positiveCapacity(
        option.capacityUnitsPerUnit,
        0n,
        `${code}.capacityUnitsPerUnit`,
      );
      if (capacityUnitsPerUnit > 0n) {
        if (!Number.isSafeInteger(quantity.value)) {
          throw new CommercialValidationError(
            `${code} must be a whole number when it changes supply capacity`,
          );
        }
        capacityUnits += capacityUnitsPerUnit * BigInt(quantity.value);
      }
    } else {
      if (typeof value !== "string") {
        throw new CommercialValidationError(`${code} must be text`);
      }
      const minimum = safeInteger(option.minLength, required ? 1 : 0, `${code}.minLength`);
      const maximum = safeInteger(option.maxLength, 4096, `${code}.maxLength`);
      if (minimum < 0 || maximum < minimum || value.length < minimum || value.length > maximum) {
        throw new CommercialValidationError(`${code} is outside its allowed text length`);
      }
      snapshot[code] = type === "secret" || type === "password" ? { provided: true } : value;
      const fixedOneTimeMinor = nonnegativeMinor(option.oneTimeMinor, `${code}.oneTimeMinor`);
      const fixedRecurringMinor = nonnegativeMinor(
        option.recurringMinor,
        `${code}.recurringMinor`,
      );
      if (fixedOneTimeMinor > 0n || fixedRecurringMinor > 0n) {
        components.push({
          code,
          label: code,
          quantity: 1,
          oneTimeMinor: fixedOneTimeMinor,
          recurringMinor: fixedRecurringMinor,
        });
      }
    }

    precedingCodes.add(code);
    if (type === "select" || type === "radio") precedingSelectionCodes.push(code);
  }

  for (const code of Object.keys(configuration)) {
    if (!acceptedCodes.has(code)) {
      throw new CommercialValidationError(`Unknown product option ${code}`);
    }
  }
  return {
    configurationSnapshot: Object.fromEntries(
      Object.entries(snapshot).sort(([left], [right]) => left.localeCompare(right, "en")),
    ),
    components,
    capacityUnits,
  };
}

export type PromotionDefinition = Readonly<{
  id: string;
  code: string;
  revision: number;
  discountKind: "fixed" | "percentage";
  applicationScope: "one_time" | "recurring" | "all";
  fixedAmountMinor: bigint | null;
  percentageBasisPoints: number | null;
}>;

export type PromotionSnapshot = Readonly<{
  id: string;
  code: string;
  revision: number;
  discountKind: "fixed" | "percentage";
  applicationScope: "one_time" | "recurring" | "all";
  value: string;
  oneTimeDiscountMinor: bigint;
  recurringDiscountMinor: bigint;
}>;

export type CommercialPriceSnapshot = PriceSnapshot &
  Readonly<{
    grossOneTimeSubtotalMinor: bigint;
    grossSetupMinor: bigint;
    grossRecurringSubtotalMinor: bigint;
    grossInvoiceTotalMinor: bigint;
    promotion: PromotionSnapshot | null;
  }>;

function percentageDiscount(amount: bigint, basisPoints: number): bigint {
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 1 || basisPoints > 10_000) {
    throw new CommercialValidationError("Promotion percentage is invalid");
  }
  return (amount * BigInt(basisPoints)) / 10_000n;
}

function scopeDiscount(
  amount: bigint,
  promotion: PromotionDefinition,
): bigint {
  if (promotion.discountKind === "fixed") {
    if (promotion.fixedAmountMinor === null || promotion.fixedAmountMinor <= 0n) {
      throw new CommercialValidationError("Fixed Promotion amount is invalid");
    }
    return promotion.fixedAmountMinor > amount ? amount : promotion.fixedAmountMinor;
  }
  if (promotion.percentageBasisPoints === null) {
    throw new CommercialValidationError("Percentage Promotion value is missing");
  }
  return percentageDiscount(amount, promotion.percentageBasisPoints);
}

export function buildCommercialPriceSnapshot(input: Readonly<{
  productId: string;
  productName: string;
  currency: string;
  billingCycle: BillingCycle;
  fulfillmentMode: FulfillmentMode;
  baseOneTimeMinor: bigint;
  setupMinor: bigint;
  baseRecurringMinor: bigint;
  optionComponents: readonly PriceComponent[];
  promotion?: PromotionDefinition | null;
}>): CommercialPriceSnapshot {
  const gross = buildPriceSnapshot(input);
  const promotion = input.promotion ?? null;
  if (!promotion) {
    return {
      ...gross,
      grossOneTimeSubtotalMinor: gross.oneTimeSubtotalMinor,
      grossSetupMinor: gross.setupMinor,
      grossRecurringSubtotalMinor: gross.recurringSubtotalMinor,
      grossInvoiceTotalMinor: gross.invoiceTotalMinor,
      promotion: null,
    };
  }

  const oneTimeBase = gross.oneTimeSubtotalMinor + gross.setupMinor;
  const oneTimeDiscount =
    promotion.applicationScope === "one_time" || promotion.applicationScope === "all"
      ? scopeDiscount(oneTimeBase, promotion)
      : 0n;
  const recurringDiscount =
    promotion.applicationScope === "recurring" || promotion.applicationScope === "all"
      ? scopeDiscount(gross.recurringSubtotalMinor, promotion)
      : 0n;
  const discountedOneTime =
    gross.oneTimeSubtotalMinor >= oneTimeDiscount
      ? gross.oneTimeSubtotalMinor - oneTimeDiscount
      : 0n;
  const setupDiscount =
    oneTimeDiscount > gross.oneTimeSubtotalMinor
      ? oneTimeDiscount - gross.oneTimeSubtotalMinor
      : 0n;
  const discountedSetup = gross.setupMinor - setupDiscount;
  const discountedRecurring = gross.recurringSubtotalMinor - recurringDiscount;
  const value =
    promotion.discountKind === "fixed"
      ? String(promotion.fixedAmountMinor)
      : String(promotion.percentageBasisPoints);

  return {
    ...gross,
    oneTimeSubtotalMinor: discountedOneTime,
    setupMinor: discountedSetup,
    recurringSubtotalMinor: discountedRecurring,
    invoiceTotalMinor: discountedOneTime + discountedSetup + discountedRecurring,
    grossOneTimeSubtotalMinor: gross.oneTimeSubtotalMinor,
    grossSetupMinor: gross.setupMinor,
    grossRecurringSubtotalMinor: gross.recurringSubtotalMinor,
    grossInvoiceTotalMinor: gross.invoiceTotalMinor,
    promotion: {
      id: promotion.id,
      code: promotion.code,
      revision: promotion.revision,
      discountKind: promotion.discountKind,
      applicationScope: promotion.applicationScope,
      value,
      oneTimeDiscountMinor: oneTimeDiscount,
      recurringDiscountMinor: recurringDiscount,
    },
  };
}
