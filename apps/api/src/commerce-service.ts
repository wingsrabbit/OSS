// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  buildCommercialPriceSnapshot,
  type CatalogConfiguration,
  type CommercialPriceSnapshot,
  type PromotionDefinition,
  type PromotionSnapshot,
  resolveCatalogConfiguration,
} from "@opensales/core/commerce";
import type { BillingCycle, FulfillmentMode, PriceComponent } from "@opensales/core";
import type { DatabaseClient } from "./database.js";
import { advancePaidInvoice } from "./invoice-settlement.js";

export type LockedCatalogOffer = Readonly<{
  priceId: string;
  priceRevision: number;
  productId: string;
  productRevisionId: string;
  productRevision: number;
  productName: string;
  currency: string;
  billingCycle: BillingCycle;
  fulfillmentMode: FulfillmentMode;
  optionSchema: unknown;
  oneTimeMinor: bigint;
  setupMinor: bigint;
  recurringMinor: bigint;
}>;

export type LockedCatalogRevision = Readonly<{
  productId: string;
  productRevisionId: string;
  productRevision: number;
  productName: string;
  fulfillmentMode: FulfillmentMode;
  optionSchema: unknown;
}>;

export type LockedPromotion = PromotionDefinition &
  Readonly<{
    productId: string | null;
    billingCycle: BillingCycle | null;
    currency: string | null;
    maximumRedemptions: bigint | null;
  }>;

export type CapacityDecision = Readonly<{
  mode: "unlimited" | "tracked" | "manual_review";
  units: bigint;
  availableUnits: bigint | null;
  committedUnits: bigint;
  version: bigint | null;
  available: true;
}>;

export type LegalDocumentPair = Readonly<{
  terms: Readonly<{ id: string; version: string }>;
  aup: Readonly<{ id: string; version: string }>;
}>;

export type IssuedCommercialOrder = Readonly<{
  orderId: string;
  invoiceId: string;
  serviceId: string;
  orderStatus: string;
}>;

function commerceError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

export async function lockCatalogOffer(
  client: DatabaseClient,
  input: Readonly<{ priceId: string; locale: "en" | "zh-CN"; allowQuote: boolean }>,
): Promise<LockedCatalogOffer> {
  const pointer = await client.query<{
    product_id: string;
    catalog_product_revision_id: string;
  }>(
    `SELECT product_id, catalog_product_revision_id
     FROM product_prices
     WHERE id = $1`,
    [input.priceId],
  );
  const ids = pointer.rows[0];
  if (!ids) throw commerceError("Product price not found", 404, "PRICE_NOT_FOUND");

  const productResult = await client.query<{
    active: boolean;
    hidden: boolean;
    current_revision_id: string;
  }>(
    `SELECT product.active, product.hidden,
            current_revision.id AS current_revision_id
     FROM products product
     JOIN LATERAL (
       SELECT revision.id
       FROM catalog_product_revisions revision
       WHERE revision.product_id = product.id
       ORDER BY revision.revision DESC
       LIMIT 1
     ) current_revision ON true
     WHERE product.id = $1
     FOR SHARE`,
    [ids.product_id],
  );
  const product = productResult.rows[0];
  if (
    !product ||
    !product.active ||
    product.hidden ||
    product.current_revision_id !== ids.catalog_product_revision_id
  ) {
    throw commerceError("Product is not available", 409, "PRODUCT_UNAVAILABLE");
  }

  const revisionResult = await client.query<{
    id: string;
    revision: number;
    names: Record<string, string>;
    fulfillment_mode: FulfillmentMode;
    active: boolean;
    hidden: boolean;
    option_schema: unknown;
  }>(
    `SELECT id, revision, names, fulfillment_mode, active, hidden, option_schema
     FROM catalog_product_revisions
     WHERE id = $1 AND product_id = $2
     FOR SHARE`,
    [ids.catalog_product_revision_id, ids.product_id],
  );
  const revision = revisionResult.rows[0];
  if (!revision || !revision.active || revision.hidden) {
    throw commerceError("Catalog revision is unavailable", 409, "PRODUCT_UNAVAILABLE");
  }
  if (revision.fulfillment_mode === "quote" && !input.allowQuote) {
    throw commerceError(
      "This product requires a Staff-issued Quote before ordering",
      409,
      "QUOTE_REQUIRED",
    );
  }

  const priceResult = await client.query<{
    id: string;
    product_id: string;
    catalog_product_revision_id: string;
    revision: number;
    currency: string;
    billing_cycle: BillingCycle;
    one_time_minor: string;
    setup_minor: string;
    recurring_minor: string;
  }>(
    `SELECT id, product_id, catalog_product_revision_id, revision, currency,
            billing_cycle, one_time_minor::text, setup_minor::text,
            recurring_minor::text
     FROM product_prices
     WHERE id = $1
       AND active
       AND valid_from <= pg_catalog.transaction_timestamp()
       AND (valid_until IS NULL OR valid_until > pg_catalog.transaction_timestamp())
     FOR SHARE`,
    [input.priceId],
  );
  const price = priceResult.rows[0];
  if (
    !price ||
    price.product_id !== ids.product_id ||
    price.catalog_product_revision_id !== revision.id
  ) {
    throw commerceError("Product price is no longer available", 409, "PRICE_UNAVAILABLE");
  }
  return {
    priceId: price.id,
    priceRevision: price.revision,
    productId: price.product_id,
    productRevisionId: revision.id,
    productRevision: revision.revision,
    productName:
      revision.names[input.locale] ?? revision.names.en ?? revision.names["zh-CN"] ?? price.product_id,
    currency: price.currency,
    billingCycle: price.billing_cycle,
    fulfillmentMode: revision.fulfillment_mode,
    optionSchema: revision.option_schema,
    oneTimeMinor: BigInt(price.one_time_minor),
    setupMinor: BigInt(price.setup_minor),
    recurringMinor: BigInt(price.recurring_minor),
  };
}

export async function lockCatalogRevision(
  client: DatabaseClient,
  input: Readonly<{
    productRevisionId: string;
    locale: "en" | "zh-CN";
    requireCurrent: boolean;
  }>,
): Promise<LockedCatalogRevision> {
  const result = await client.query<{
    product_id: string;
    product_revision_id: string;
    product_revision: number;
    names: Record<string, string>;
    fulfillment_mode: FulfillmentMode;
    option_schema: unknown;
    active: boolean;
    hidden: boolean;
    projection_active: boolean;
    projection_hidden: boolean;
    current_revision_id: string;
  }>(
    `SELECT revision.product_id,
            revision.id AS product_revision_id,
            revision.revision AS product_revision,
            revision.names,
            revision.fulfillment_mode,
            revision.option_schema,
            revision.active,
            revision.hidden,
            product.active AS projection_active,
            product.hidden AS projection_hidden,
            current_revision.id AS current_revision_id
     FROM catalog_product_revisions revision
     JOIN products product ON product.id = revision.product_id
     JOIN LATERAL (
       SELECT candidate.id
       FROM catalog_product_revisions candidate
       WHERE candidate.product_id = product.id
       ORDER BY candidate.revision DESC
       LIMIT 1
     ) current_revision ON true
     WHERE revision.id = $1
     FOR SHARE OF product, revision`,
    [input.productRevisionId],
  );
  const revision = result.rows[0];
  if (
    !revision ||
    !revision.active ||
    revision.hidden ||
    !revision.projection_active ||
    revision.projection_hidden ||
    (input.requireCurrent && revision.current_revision_id !== revision.product_revision_id)
  ) {
    throw commerceError("Catalog revision is unavailable", 409, "PRODUCT_UNAVAILABLE");
  }
  return {
    productId: revision.product_id,
    productRevisionId: revision.product_revision_id,
    productRevision: revision.product_revision,
    productName:
      revision.names[input.locale] ??
      revision.names.en ??
      revision.names["zh-CN"] ??
      revision.product_id,
    fulfillmentMode: revision.fulfillment_mode,
    optionSchema: revision.option_schema,
  };
}

export async function lockPromotion(
  client: DatabaseClient,
  input: Readonly<{
    code: string | null;
    productId: string;
    billingCycle: BillingCycle;
    currency: string;
    forUpdate?: boolean;
  }>,
): Promise<LockedPromotion | null> {
  if (!input.code) return null;
  const pointer = await client.query<{ id: string }>(
    `SELECT id
     FROM promotions
     WHERE code = $1
       AND active
       AND valid_from <= pg_catalog.transaction_timestamp()
       AND (valid_until IS NULL OR valid_until > pg_catalog.transaction_timestamp())
     ORDER BY revision DESC, id DESC
     LIMIT 1`,
    [input.code.toUpperCase()],
  );
  const id = pointer.rows[0]?.id;
  if (!id) throw commerceError("Promotion is invalid or expired", 409, "PROMOTION_INVALID");
  const result = await client.query<{
    id: string;
    code: string;
    revision: number;
    product_id: string | null;
    billing_cycle: BillingCycle | null;
    discount_kind: "fixed" | "percentage";
    application_scope: "one_time" | "recurring" | "all";
    fixed_amount_minor: string | null;
    percentage_basis_points: number | null;
    currency: string | null;
    maximum_redemptions: string | null;
    active: boolean;
    valid_from: Date;
    valid_until: Date | null;
  }>(
    `SELECT id, code::text, revision, product_id, billing_cycle, discount_kind,
            application_scope, fixed_amount_minor::text, percentage_basis_points,
            currency, maximum_redemptions::text, active, valid_from, valid_until
     FROM promotions
     WHERE id = $1
       AND active
       AND valid_from <= pg_catalog.transaction_timestamp()
       AND (valid_until IS NULL OR valid_until > pg_catalog.transaction_timestamp())
     ${input.forUpdate ? "FOR UPDATE" : "FOR SHARE"}`,
    [id],
  );
  const promotion = result.rows[0];
  if (
    !promotion ||
    (promotion.product_id && promotion.product_id !== input.productId) ||
    (promotion.billing_cycle && promotion.billing_cycle !== input.billingCycle) ||
    (promotion.currency && promotion.currency !== input.currency)
  ) {
    throw commerceError("Promotion is not eligible for this offer", 409, "PROMOTION_INELIGIBLE");
  }
  return {
    id: promotion.id,
    code: promotion.code,
    revision: promotion.revision,
    discountKind: promotion.discount_kind,
    applicationScope: promotion.application_scope,
    fixedAmountMinor:
      promotion.fixed_amount_minor === null ? null : BigInt(promotion.fixed_amount_minor),
    percentageBasisPoints: promotion.percentage_basis_points,
    productId: promotion.product_id,
    billingCycle: promotion.billing_cycle,
    currency: promotion.currency,
    maximumRedemptions:
      promotion.maximum_redemptions === null
        ? null
        : BigInt(promotion.maximum_redemptions),
  };
}

export async function lockQuotedPromotion(
  client: DatabaseClient,
  input: Readonly<{
    promotionId: string;
    snapshot: PromotionSnapshot;
    productId: string;
    billingCycle: BillingCycle;
    currency: string;
  }>,
): Promise<LockedPromotion> {
  const result = await client.query<{
    id: string;
    code: string;
    revision: number;
    product_id: string | null;
    billing_cycle: BillingCycle | null;
    discount_kind: "fixed" | "percentage";
    application_scope: "one_time" | "recurring" | "all";
    fixed_amount_minor: string | null;
    percentage_basis_points: number | null;
    currency: string | null;
    maximum_redemptions: string | null;
  }>(
    `SELECT id, code::text, revision, product_id, billing_cycle,
            discount_kind, application_scope, fixed_amount_minor::text,
            percentage_basis_points, currency, maximum_redemptions::text
     FROM promotions
     WHERE id = $1
     FOR UPDATE`,
    [input.promotionId],
  );
  const promotion = result.rows[0];
  if (
    !promotion ||
    promotion.id !== input.snapshot.id ||
    promotion.code !== input.snapshot.code ||
    promotion.revision !== input.snapshot.revision ||
    promotion.discount_kind !== input.snapshot.discountKind ||
    promotion.application_scope !== input.snapshot.applicationScope ||
    (promotion.product_id !== null && promotion.product_id !== input.productId) ||
    (promotion.billing_cycle !== null && promotion.billing_cycle !== input.billingCycle) ||
    (promotion.currency !== null && promotion.currency !== input.currency)
  ) {
    throw commerceError(
      "Quote Promotion snapshot no longer matches its immutable definition",
      409,
      "QUOTE_SNAPSHOT_INVALID",
    );
  }
  return {
    id: promotion.id,
    code: promotion.code,
    revision: promotion.revision,
    discountKind: promotion.discount_kind,
    applicationScope: promotion.application_scope,
    fixedAmountMinor:
      promotion.fixed_amount_minor === null ? null : BigInt(promotion.fixed_amount_minor),
    percentageBasisPoints: promotion.percentage_basis_points,
    productId: promotion.product_id,
    billingCycle: promotion.billing_cycle,
    currency: promotion.currency,
    maximumRedemptions:
      promotion.maximum_redemptions === null
        ? null
        : BigInt(promotion.maximum_redemptions),
  };
}

function snapshotRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw commerceError(`Quote ${field} snapshot is invalid`, 409, "QUOTE_SNAPSHOT_INVALID");
  }
  return value as Record<string, unknown>;
}

function snapshotString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw commerceError(`Quote ${field} snapshot is invalid`, 409, "QUOTE_SNAPSHOT_INVALID");
  }
  return value;
}

function snapshotMoney(value: unknown, field: string): bigint {
  const text = snapshotString(value, field);
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw commerceError(`Quote ${field} snapshot is invalid`, 409, "QUOTE_SNAPSHOT_INVALID");
  }
  return BigInt(text);
}

export function parseCommercialSnapshot(value: unknown): CommercialPriceSnapshot {
  const record = snapshotRecord(value, "price");
  const billingCycle = snapshotString(record.billingCycle, "billing cycle") as BillingCycle;
  if (!["monthly", "quarterly", "semiannual", "annual", "one_time"].includes(billingCycle)) {
    throw commerceError("Quote billing cycle snapshot is invalid", 409, "QUOTE_SNAPSHOT_INVALID");
  }
  const fulfillmentMode = snapshotString(
    record.fulfillmentMode,
    "fulfillment mode",
  ) as FulfillmentMode;
  if (!["automatic", "review", "manual", "quote"].includes(fulfillmentMode)) {
    throw commerceError(
      "Quote fulfillment mode snapshot is invalid",
      409,
      "QUOTE_SNAPSHOT_INVALID",
    );
  }
  if (!Array.isArray(record.components)) {
    throw commerceError("Quote price components snapshot is invalid", 409, "QUOTE_SNAPSHOT_INVALID");
  }
  const components: PriceComponent[] = record.components.map((raw, index) => {
    const component = snapshotRecord(raw, `component ${index}`);
    if (!Number.isSafeInteger(component.quantity) || Number(component.quantity) <= 0) {
      throw commerceError(
        `Quote component ${index} quantity snapshot is invalid`,
        409,
        "QUOTE_SNAPSHOT_INVALID",
      );
    }
    return {
      code: snapshotString(component.code, `component ${index} code`),
      label: snapshotString(component.label, `component ${index} label`),
      quantity: Number(component.quantity),
      oneTimeMinor: snapshotMoney(component.oneTimeMinor, `component ${index} one-time`),
      recurringMinor: snapshotMoney(
        component.recurringMinor,
        `component ${index} recurring`,
      ),
    };
  });
  let promotion: PromotionSnapshot | null = null;
  if (record.promotion !== null && record.promotion !== undefined) {
    const stored = snapshotRecord(record.promotion, "Promotion");
    const revision = stored.revision;
    const discountKind = snapshotString(stored.discountKind, "Promotion kind");
    const applicationScope = snapshotString(stored.applicationScope, "Promotion scope");
    if (
      !Number.isSafeInteger(revision) ||
      Number(revision) < 1 ||
      !["fixed", "percentage"].includes(discountKind) ||
      !["one_time", "recurring", "all"].includes(applicationScope)
    ) {
      throw commerceError("Quote Promotion snapshot is invalid", 409, "QUOTE_SNAPSHOT_INVALID");
    }
    promotion = {
      id: snapshotString(stored.id, "Promotion id"),
      code: snapshotString(stored.code, "Promotion code"),
      revision: Number(revision),
      discountKind: discountKind as "fixed" | "percentage",
      applicationScope: applicationScope as "one_time" | "recurring" | "all",
      value: snapshotString(stored.value, "Promotion value"),
      oneTimeDiscountMinor: snapshotMoney(
        stored.oneTimeDiscountMinor,
        "Promotion one-time discount",
      ),
      recurringDiscountMinor: snapshotMoney(
        stored.recurringDiscountMinor,
        "Promotion recurring discount",
      ),
    };
  }
  const snapshot: CommercialPriceSnapshot = {
    productId: snapshotString(record.productId, "product id"),
    productName: snapshotString(record.productName, "product name"),
    currency: snapshotString(record.currency, "currency"),
    billingCycle,
    fulfillmentMode,
    components,
    oneTimeSubtotalMinor: snapshotMoney(record.oneTimeSubtotalMinor, "one-time total"),
    setupMinor: snapshotMoney(record.setupMinor, "setup total"),
    recurringSubtotalMinor: snapshotMoney(record.recurringSubtotalMinor, "recurring total"),
    invoiceTotalMinor: snapshotMoney(record.invoiceTotalMinor, "invoice total"),
    grossOneTimeSubtotalMinor: snapshotMoney(
      record.grossOneTimeSubtotalMinor,
      "gross one-time total",
    ),
    grossSetupMinor: snapshotMoney(record.grossSetupMinor, "gross setup total"),
    grossRecurringSubtotalMinor: snapshotMoney(
      record.grossRecurringSubtotalMinor,
      "gross recurring total",
    ),
    grossInvoiceTotalMinor: snapshotMoney(
      record.grossInvoiceTotalMinor,
      "gross invoice total",
    ),
    promotion,
  };
  if (
    snapshot.invoiceTotalMinor !==
      snapshot.oneTimeSubtotalMinor + snapshot.setupMinor + snapshot.recurringSubtotalMinor ||
    snapshot.grossInvoiceTotalMinor !==
      snapshot.grossOneTimeSubtotalMinor +
        snapshot.grossSetupMinor +
        snapshot.grossRecurringSubtotalMinor
  ) {
    throw commerceError("Quote price totals snapshot is invalid", 409, "QUOTE_SNAPSHOT_INVALID");
  }
  return snapshot;
}

export async function assertPromotionCapacity(
  client: DatabaseClient,
  promotion: LockedPromotion | null,
): Promise<void> {
  if (!promotion?.maximumRedemptions) return;
  await client.query("SELECT id FROM promotions WHERE id = $1 FOR UPDATE", [promotion.id]);
  const usage = await client.query<{ count: string }>(
    `SELECT pg_catalog.count(*)::text AS count
     FROM promotion_redemptions
     WHERE promotion_id = $1`,
    [promotion.id],
  );
  if (BigInt(usage.rows[0]?.count ?? "0") >= promotion.maximumRedemptions) {
    throw commerceError("Promotion redemption capacity is exhausted", 409, "PROMOTION_EXHAUSTED");
  }
}

export async function supplyPreflight(
  client: DatabaseClient,
  input: Readonly<{ productId: string; units: bigint; commit: boolean }>,
): Promise<CapacityDecision> {
  if (input.units <= 0n) throw new Error("Supply capacity units must be positive");
  const result = await client.query<{
    mode: "unlimited" | "tracked" | "manual_review";
    available_units: string | null;
    committed_units: string;
    version: string;
  }>(
    `SELECT mode, available_units::text, committed_units::text, version::text
     FROM product_supply_capacities
     WHERE product_id = $1
     ${input.commit ? "FOR UPDATE" : "FOR SHARE"}`,
    [input.productId],
  );
  const capacity = result.rows[0];
  if (!capacity) {
    return {
      mode: "unlimited",
      units: input.units,
      availableUnits: null,
      committedUnits: 0n,
      version: null,
      available: true,
    };
  }
  const availableUnits =
    capacity.available_units === null ? null : BigInt(capacity.available_units);
  const committedUnits = BigInt(capacity.committed_units);
  if (
    capacity.mode === "tracked" &&
    (availableUnits === null || committedUnits + input.units > availableUnits)
  ) {
    throw commerceError(
      "Mock supply capacity is currently unavailable",
      409,
      "SUPPLY_UNAVAILABLE",
    );
  }
  if (input.commit && capacity.mode === "tracked") {
    await client.query(
      `UPDATE product_supply_capacities
       SET committed_units = committed_units + $2,
           version = version + 1,
           updated_at = pg_catalog.now()
       WHERE product_id = $1`,
      [input.productId, input.units.toString()],
    );
  }
  return {
    mode: capacity.mode,
    units: input.units,
    availableUnits,
    committedUnits:
      input.commit && capacity.mode === "tracked"
        ? committedUnits + input.units
        : committedUnits,
    version: BigInt(capacity.version),
    available: true,
  };
}

export async function loadLegalDocuments(
  client: DatabaseClient,
  input: Readonly<{
    locale: "en" | "zh-CN";
    termsVersion: string;
    aupVersion: string;
  }>,
): Promise<LegalDocumentPair> {
  const result = await client.query<{ id: string; kind: "terms" | "aup"; version: string }>(
    `SELECT id, kind, version
     FROM legal_documents
     WHERE locale = $1
       AND ((kind = 'terms' AND version = $2) OR (kind = 'aup' AND version = $3))
     ORDER BY kind
     FOR SHARE`,
    [input.locale, input.termsVersion, input.aupVersion],
  );
  const terms = result.rows.find((document) => document.kind === "terms");
  const aup = result.rows.find((document) => document.kind === "aup");
  if (!terms || !aup || result.rows.length !== 2) {
    throw commerceError(
      "The selected legal document version is not available",
      409,
      "LEGAL_VERSION_UNAVAILABLE",
    );
  }
  return { terms, aup };
}

export function buildOfferSnapshot(
  offer: LockedCatalogOffer,
  configuration: CatalogConfiguration,
  promotion: LockedPromotion | null,
): Readonly<{
  snapshot: CommercialPriceSnapshot;
  configurationSnapshot: Readonly<Record<string, unknown>>;
  capacityUnits: bigint;
}> {
  const resolved = resolveCatalogConfiguration(offer.optionSchema, configuration);
  const snapshot = buildCommercialPriceSnapshot({
    productId: offer.productId,
    productName: offer.productName,
    currency: offer.currency,
    billingCycle: offer.billingCycle,
    fulfillmentMode: offer.fulfillmentMode,
    baseOneTimeMinor: offer.oneTimeMinor,
    setupMinor: offer.setupMinor,
    baseRecurringMinor: offer.recurringMinor,
    optionComponents: resolved.components,
    promotion,
  });
  return {
    snapshot,
    configurationSnapshot: resolved.configurationSnapshot,
    capacityUnits: resolved.capacityUnits,
  };
}

export function jsonCommercialSnapshot(
  snapshot: CommercialPriceSnapshot,
  metadata: Readonly<{
    productRevisionId: string;
    productRevision: number;
    priceId: string | null;
    priceRevision: number | null;
    capacity: CapacityDecision;
  }>,
): Record<string, unknown> {
  return {
    productId: snapshot.productId,
    productName: snapshot.productName,
    currency: snapshot.currency,
    billingCycle: snapshot.billingCycle,
    fulfillmentMode: snapshot.fulfillmentMode,
    productRevisionId: metadata.productRevisionId,
    productRevision: metadata.productRevision,
    priceId: metadata.priceId,
    priceRevision: metadata.priceRevision,
    oneTimeSubtotalMinor: snapshot.oneTimeSubtotalMinor.toString(),
    setupMinor: snapshot.setupMinor.toString(),
    recurringSubtotalMinor: snapshot.recurringSubtotalMinor.toString(),
    invoiceTotalMinor: snapshot.invoiceTotalMinor.toString(),
    grossOneTimeSubtotalMinor: snapshot.grossOneTimeSubtotalMinor.toString(),
    grossSetupMinor: snapshot.grossSetupMinor.toString(),
    grossRecurringSubtotalMinor: snapshot.grossRecurringSubtotalMinor.toString(),
    grossInvoiceTotalMinor: snapshot.grossInvoiceTotalMinor.toString(),
    components: snapshot.components.map((component) => ({
      ...component,
      oneTimeMinor: component.oneTimeMinor.toString(),
      recurringMinor: component.recurringMinor.toString(),
    })),
    promotion: snapshot.promotion
      ? {
          ...snapshot.promotion,
          oneTimeDiscountMinor: snapshot.promotion.oneTimeDiscountMinor.toString(),
          recurringDiscountMinor: snapshot.promotion.recurringDiscountMinor.toString(),
        }
      : null,
    supply: {
      ...metadata.capacity,
      units: metadata.capacity.units.toString(),
      availableUnits: metadata.capacity.availableUnits?.toString() ?? null,
      committedUnits: metadata.capacity.committedUnits.toString(),
      version: metadata.capacity.version?.toString() ?? null,
    },
  };
}

export async function issueCommercialOrder(
  client: DatabaseClient,
  input: Readonly<{
    clientAccountId: string;
    userId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    sourceQuoteId: string | null;
    productId: string;
    productName: string;
    productRevisionId: string;
    productRevision: number;
    priceId: string | null;
    priceRevision: number | null;
    fulfillmentMode: FulfillmentMode;
    billingCycle: BillingCycle;
    configurationSnapshot: Readonly<Record<string, unknown>>;
    snapshot: CommercialPriceSnapshot;
    capacity: CapacityDecision;
    legal: LegalDocumentPair;
    promotion: LockedPromotion | null;
  }>,
): Promise<IssuedCommercialOrder> {
  await assertPromotionCapacity(client, input.promotion);
  const serializedSnapshot = jsonCommercialSnapshot(input.snapshot, {
    productRevisionId: input.productRevisionId,
    productRevision: input.productRevision,
    priceId: input.priceId,
    priceRevision: input.priceRevision,
    capacity: input.capacity,
  });
  const orderResult = await client.query<{ id: string }>(
    `INSERT INTO orders(
       client_account_id, submitted_by_user_id, status, currency, price_snapshot,
       one_time_minor, setup_minor, recurring_minor, total_minor, idempotency_key,
       request_fingerprint, source_quote_id
     ) VALUES ($1, $2, 'waiting_payment', $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      input.clientAccountId,
      input.userId,
      input.snapshot.currency,
      serializedSnapshot,
      input.snapshot.oneTimeSubtotalMinor.toString(),
      input.snapshot.setupMinor.toString(),
      input.snapshot.recurringSubtotalMinor.toString(),
      input.snapshot.invoiceTotalMinor.toString(),
      input.idempotencyKey,
      input.requestFingerprint,
      input.sourceQuoteId,
    ],
  );
  const orderId = orderResult.rows[0]?.id;
  if (!orderId) throw new Error("Unable to create order");

  for (const [kind, document] of [
    ["terms", input.legal.terms],
    ["aup", input.legal.aup],
  ] as const) {
    const acceptance = await client.query<{ id: string }>(
      `INSERT INTO legal_acceptances(client_account_id, user_id, document_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [input.clientAccountId, input.userId, document.id],
    );
    const acceptanceId = acceptance.rows[0]?.id;
    if (!acceptanceId) throw new Error("Unable to record legal acceptance");
    await client.query(
      `INSERT INTO order_legal_acceptances(
         order_id, client_account_id, legal_acceptance_id, document_kind
       ) VALUES ($1, $2, $3, $4)`,
      [orderId, input.clientAccountId, acceptanceId, kind],
    );
  }

  const orderItemResult = await client.query<{ id: string }>(
    `INSERT INTO order_items(
       order_id, client_account_id, product_id, product_name, fulfillment_mode,
       billing_cycle, configuration, price_snapshot
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      orderId,
      input.clientAccountId,
      input.productId,
      input.productName,
      input.fulfillmentMode,
      input.billingCycle,
      input.configurationSnapshot,
      serializedSnapshot,
    ],
  );
  const orderItemId = orderItemResult.rows[0]?.id;
  if (!orderItemId) throw new Error("Unable to create order item");

  const invoiceResult = await client.query<{ id: string }>(
    `INSERT INTO invoices(client_account_id, order_id, currency, total_minor, due_at)
     VALUES ($1, $2, $3, $4, pg_catalog.now() + interval '7 days')
     RETURNING id`,
    [
      input.clientAccountId,
      orderId,
      input.snapshot.currency,
      input.snapshot.invoiceTotalMinor.toString(),
    ],
  );
  const invoiceId = invoiceResult.rows[0]?.id;
  if (!invoiceId) throw new Error("Unable to create invoice");

  const journalResult = await client.query<{ id: string }>(
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES ('invoice_issuance', $1, $2, 'Invoice issued')
     RETURNING id`,
    [invoiceId, input.snapshot.currency],
  );
  const journalId = journalResult.rows[0]?.id;
  if (!journalId) throw new Error("Unable to create invoice journal");
  if (input.snapshot.invoiceTotalMinor > 0n) {
    await client.query(
      `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
       VALUES
         ($1, 'accounts_receivable', $2, 0),
         ($1, 'deferred_service_revenue', 0, $2)`,
      [journalId, input.snapshot.invoiceTotalMinor.toString()],
    );
  }
  await client.query(
    "UPDATE ledger_journals SET sealed_at = pg_catalog.now() WHERE id = $1",
    [journalId],
  );

  for (const [kind, description, amount] of [
    ["one_time", `${input.productName} one-time`, input.snapshot.oneTimeSubtotalMinor],
    ["setup", `${input.productName} setup`, input.snapshot.setupMinor],
    ["recurring", `${input.productName} ${input.billingCycle}`, input.snapshot.recurringSubtotalMinor],
  ] as const) {
    if (amount > 0n) {
      await client.query(
        `INSERT INTO invoice_lines(invoice_id, kind, description, amount_minor)
         VALUES ($1, $2, $3, $4)`,
        [invoiceId, kind, description, amount.toString()],
      );
    }
  }

  const serviceResult = await client.query<{ id: string }>(
    `INSERT INTO services(client_account_id, order_item_id, status, billing_cycle)
     VALUES ($1, $2, 'pending', $3)
     RETURNING id`,
    [input.clientAccountId, orderItemId, input.billingCycle],
  );
  const serviceId = serviceResult.rows[0]?.id;
  if (!serviceId) throw new Error("Unable to create service");

  const binding = await client.query(
    `INSERT INTO service_provider_bindings(
       service_id, provider_installation_id, overdue_action_snapshot,
       capability_snapshot, product_policy_version,
       cycle_end_cancellation_mode_snapshot,
       cycle_end_cancellation_execution_mode_snapshot,
       cycle_end_cancellation_min_notice_hours_snapshot,
       cycle_end_cancellation_requirement_key_snapshot
     )
     SELECT
       $1, policy.provider_installation_id, policy.overdue_action,
       COALESCE(provider.capabilities, '[]'::jsonb), policy.version,
       policy.cycle_end_cancellation_mode,
       policy.cycle_end_cancellation_execution_mode,
       policy.cycle_end_cancellation_min_notice_hours,
       policy.cycle_end_cancellation_requirement_key
     FROM product_service_automation_policies policy
     LEFT JOIN provider_installation_capabilities provider
       ON provider.provider_installation_id = policy.provider_installation_id
     WHERE policy.product_id = $2
       AND (policy.provider_installation_id IS NULL OR provider.provider_installation_id IS NOT NULL)`,
    [serviceId, input.productId],
  );
  if (input.fulfillmentMode === "automatic" && binding.rowCount !== 1) {
    throw commerceError(
      "Automatic fulfillment has no valid mock Provider binding",
      409,
      "SUPPLY_PREFLIGHT_FAILED",
    );
  }

  if (input.capacity.mode === "tracked") {
    await client.query(
      `INSERT INTO supply_capacity_reservations(
         client_account_id, product_id, order_id, units, capacity_snapshot
       ) VALUES ($1, $2, $3, $4, $5)`,
      [
        input.clientAccountId,
        input.productId,
        orderId,
        input.capacity.units.toString(),
        serializedSnapshot.supply,
      ],
    );
  }
  if (
    input.promotion &&
    input.snapshot.promotion &&
    (input.snapshot.promotion.oneTimeDiscountMinor > 0n ||
      input.snapshot.promotion.recurringDiscountMinor > 0n)
  ) {
    await client.query(
      `INSERT INTO promotion_redemptions(
         promotion_id, client_account_id, order_id, quote_id,
         one_time_discount_minor, recurring_discount_minor, snapshot
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.promotion.id,
        input.clientAccountId,
        orderId,
        input.sourceQuoteId,
        input.snapshot.promotion.oneTimeDiscountMinor.toString(),
        input.snapshot.promotion.recurringDiscountMinor.toString(),
        serializedSnapshot.promotion,
      ],
    );
  }
  await client.query(
    `INSERT INTO outbox(event_type, unique_key, payload)
     VALUES ('order.submitted', $1, $2)`,
    [`order:${orderId}`, { orderId, invoiceId, clientAccountId: input.clientAccountId }],
  );

  let orderStatus = "waiting_payment";
  if (input.snapshot.invoiceTotalMinor === 0n) {
    const settlement = await advancePaidInvoice(client, invoiceId, {
      kind: "user_command",
      userId: input.userId,
    });
    orderStatus = settlement.orderStatus ?? orderStatus;
  }
  return { orderId, invoiceId, serviceId, orderStatus };
}

export async function replayCommercialOrder(
  client: DatabaseClient,
  input: Readonly<{
    clientAccountId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    sourceQuoteId?: string | null;
  }>,
): Promise<(IssuedCommercialOrder & Readonly<{ replayed: true }>) | null> {
  const result = await client.query<{
    id: string;
    request_fingerprint: string;
    source_quote_id: string | null;
    status: string;
    invoice_id: string;
    service_id: string;
  }>(
    `SELECT original_order.id, original_order.request_fingerprint,
            original_order.source_quote_id, original_order.status,
            invoice.id AS invoice_id, service.id AS service_id
     FROM orders original_order
     JOIN invoices invoice ON invoice.order_id = original_order.id
     JOIN order_items item ON item.order_id = original_order.id
     JOIN services service ON service.order_item_id = item.id
     WHERE original_order.client_account_id = $1
       AND original_order.idempotency_key = $2
     FOR UPDATE OF original_order`,
    [input.clientAccountId, input.idempotencyKey],
  );
  const previous = result.rows[0];
  if (!previous) return null;
  if (
    previous.request_fingerprint !== input.requestFingerprint ||
    (input.sourceQuoteId !== undefined &&
      previous.source_quote_id !== input.sourceQuoteId)
  ) {
    throw commerceError(
      "The idempotency key was used for a different commercial Order",
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  }
  return {
    orderId: previous.id,
    invoiceId: previous.invoice_id,
    serviceId: previous.service_id,
    orderStatus: previous.status,
    replayed: true,
  };
}

export async function recordMarketingConsent(
  client: DatabaseClient,
  input: Readonly<{
    clientAccountId: string;
    userId: string;
    granted: boolean;
    policyVersion: string;
    source: "checkout" | "quote_acceptance" | "preferences";
    idempotencyKey: string;
    requestFingerprint: string;
  }>,
): Promise<string> {
  await client.query(
    "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
    [`marketing-consent:${input.clientAccountId}:${input.userId}:${input.idempotencyKey}`],
  );
  const existing = await client.query<{
    id: string;
    decision: "granted" | "revoked";
    policy_version: string;
    request_fingerprint: string;
  }>(
    `SELECT id, decision, policy_version, request_fingerprint
     FROM marketing_consent_events
     WHERE client_account_id = $1 AND user_id = $2 AND idempotency_key = $3`,
    [input.clientAccountId, input.userId, input.idempotencyKey],
  );
  const previous = existing.rows[0];
  if (previous) {
    if (previous.request_fingerprint !== input.requestFingerprint) {
      throw commerceError(
        "Marketing Consent idempotency key was used for a different decision",
        409,
        "IDEMPOTENCY_CONFLICT",
      );
    }
    return previous.id;
  }
  const result = await client.query<{ id: string }>(
    `INSERT INTO marketing_consent_events(
       client_account_id, user_id, decision, policy_version, source,
       idempotency_key, request_fingerprint
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.clientAccountId,
      input.userId,
      input.granted ? "granted" : "revoked",
      input.policyVersion,
      input.source,
      input.idempotencyKey,
      input.requestFingerprint,
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Unable to record Marketing Consent");
  return id;
}
