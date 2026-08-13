// SPDX-License-Identifier: AGPL-3.0-or-later

import { LAB_BANNER, type BillingCycle, type FulfillmentMode } from "@opensales/core";
import {
  buildCommercialPriceSnapshot,
  resolveCatalogConfiguration,
  validateCatalogOptionSchema,
} from "@opensales/core/commerce";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assertCustomerCapability,
  assertEligible,
  assertFinancialReadEligible,
  assertIdentityReadEligible,
  expectedAccountContextVersion,
  lockAccountContextForMutation,
  lockSessionIdentityForMutation,
  requireSessionIdentity,
  requireUser,
  setAccountContextHeaders,
  type SessionIdentity,
} from "./auth.js";
import {
  assertPromotionCapacity,
  buildOfferSnapshot,
  issueCommercialOrder,
  jsonCommercialSnapshot,
  loadLegalDocuments,
  lockCatalogOffer,
  lockCatalogRevision,
  lockPromotion,
  lockQuotedPromotion,
  parseCommercialSnapshot,
  recordMarketingConsent,
  supplyPreflight,
  type CapacityDecision,
  type LockedPromotion,
} from "./commerce-service.js";
import type { Config } from "./config.js";
import { transaction, type DatabaseClient, type DatabasePool } from "./database.js";
import { requestFingerprint } from "./idempotency.js";
import { requireStaffPermission } from "./routes-admin.js";

export const MARKETING_CONSENT_POLICY_VERSION = "mock-lab-marketing-v1" as const;

const canonicalUuid = z.uuid().transform((value) => value.toLowerCase());
const canonicalCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{2,63}$/);
const catalogId = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{1,79}$/);
const minorUnits = z.string().regex(/^(0|[1-9]\d*)$/);
const positiveMinorUnits = z.string().regex(/^[1-9]\d*$/);
const billingCycleSchema = z.enum([
  "monthly",
  "quarterly",
  "semiannual",
  "annual",
  "one_time",
]);
const fulfillmentModeSchema = z.enum(["automatic", "review", "manual", "quote"]);
const localizedContentSchema = z
  .record(
    z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/),
    z.string().trim().min(1).max(4_000),
  )
  .refine((value) => typeof value.en === "string", "English content is required");

const productGroupSchema = z
  .object({
    id: catalogId,
    sortOrder: z.number().int().min(-1_000_000).max(1_000_000),
    names: localizedContentSchema,
  })
  .strict();

const productDefinitionSchema = z
  .object({
    id: catalogId,
    groupId: catalogId,
    names: localizedContentSchema,
    descriptions: localizedContentSchema,
    fulfillmentMode: fulfillmentModeSchema,
    active: z.boolean().default(true),
    hidden: z.boolean().default(false),
    repeatable: z.boolean().default(false),
    optionSchema: z.array(z.unknown()).default([]),
  })
  .strict();

const productRevisionSchema = productDefinitionSchema.omit({ id: true });

const priceRevisionSchema = z
  .object({
    billingCycle: billingCycleSchema,
    currency: z.literal("USD"),
    oneTimeMinor: minorUnits,
    setupMinor: minorUnits,
    recurringMinor: minorUnits,
    effectiveAt: z.iso.datetime({ offset: true }).optional(),
    validUntil: z.iso.datetime({ offset: true }).nullable().default(null),
  })
  .strict()
  .superRefine((body, context) => {
    if (body.billingCycle === "one_time" && body.recurringMinor !== "0") {
      context.addIssue({
        code: "custom",
        path: ["recurringMinor"],
        message: "one-time prices cannot contain a recurring amount",
      });
    }
    if (
      body.validUntil &&
      body.effectiveAt &&
      new Date(body.validUntil).getTime() <= new Date(body.effectiveAt).getTime()
    ) {
      context.addIssue({
        code: "custom",
        path: ["validUntil"],
        message: "validUntil must be after effectiveAt",
      });
    }
  });

const retireSchema = z
  .object({ effectiveAt: z.iso.datetime({ offset: true }).optional() })
  .strict();

const supplyDefinitionSchema = z
  .object({
    mode: z.enum(["unlimited", "tracked", "manual_review"]),
    availableUnits: z.string().regex(/^(0|[1-9]\d*)$/).nullable().default(null),
  })
  .strict()
  .superRefine((body, context) => {
    if ((body.mode === "tracked") !== (body.availableUnits !== null)) {
      context.addIssue({
        code: "custom",
        path: ["availableUnits"],
        message: "tracked supply requires availableUnits; other modes must omit it",
      });
    }
  });

const promotionDefinitionSchema = z
  .object({
    code: canonicalCode,
    name: z.string().trim().min(1).max(200),
    productId: catalogId.nullable().default(null),
    billingCycle: billingCycleSchema.nullable().default(null),
    discountKind: z.enum(["fixed", "percentage"]),
    applicationScope: z.enum(["one_time", "recurring", "all"]),
    fixedAmountMinor: positiveMinorUnits.nullable().default(null),
    percentageBasisPoints: z.number().int().min(1).max(10_000).nullable().default(null),
    currency: z.literal("USD").nullable().default(null),
    effectiveAt: z.iso.datetime({ offset: true }).optional(),
    validUntil: z.iso.datetime({ offset: true }).nullable().default(null),
    maximumRedemptions: positiveMinorUnits.nullable().default(null),
  })
  .strict()
  .superRefine((body, context) => {
    const fixed = body.discountKind === "fixed";
    if (
      fixed !== (body.fixedAmountMinor !== null) ||
      fixed !== (body.currency !== null) ||
      fixed === (body.percentageBasisPoints !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["discountKind"],
        message:
          "fixed Promotions require fixedAmountMinor and USD; percentage Promotions require percentageBasisPoints",
      });
    }
    if (
      body.validUntil &&
      body.effectiveAt &&
      new Date(body.validUntil).getTime() <= new Date(body.effectiveAt).getTime()
    ) {
      context.addIssue({
        code: "custom",
        path: ["validUntil"],
        message: "validUntil must be after effectiveAt",
      });
    }
  });

const catalogConfigurationSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .default({});

const quotePricingSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("catalog"),
      priceId: canonicalUuid,
      configuration: catalogConfigurationSchema,
      promotionCode: canonicalCode.nullable().default(null),
    })
    .strict(),
  z
    .object({
      mode: z.literal("manual"),
      productRevisionId: canonicalUuid,
      billingCycle: billingCycleSchema,
      currency: z.literal("USD"),
      oneTimeMinor: minorUnits,
      setupMinor: minorUnits,
      recurringMinor: minorUnits,
      configuration: catalogConfigurationSchema,
      promotionCode: canonicalCode.nullable().default(null),
    })
    .strict()
    .superRefine((body, context) => {
      if (body.billingCycle === "one_time" && body.recurringMinor !== "0") {
        context.addIssue({
          code: "custom",
          path: ["recurringMinor"],
          message: "one-time Quotes cannot contain a recurring amount",
        });
      }
    }),
]);

const staffQuoteSchema = z
  .object({
    clientAccountId: canonicalUuid,
    expiresAt: z.iso.datetime({ offset: true }),
    idempotencyKey: z.string().trim().min(8).max(128),
    pricing: quotePricingSchema,
  })
  .strict();

const quoteVoidSchema = z
  .object({ reason: z.string().trim().min(10).max(1_000) })
  .strict();

const quoteAcceptancePreviewSchema = z
  .object({
    termsVersion: z.string().trim().min(1).max(64),
    aupVersion: z.string().trim().min(1).max(64),
  })
  .strict();

const quoteAcceptanceSchema = quoteAcceptancePreviewSchema
  .extend({
    marketingConsent: z.boolean().default(false),
    marketingConsentPolicyVersion: z.string().trim().min(1).max(80).optional(),
    idempotencyKey: z.string().trim().min(8).max(128),
  })
  .strict()
  .superRefine((body, context) => {
    if (body.marketingConsent !== (body.marketingConsentPolicyVersion !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["marketingConsentPolicyVersion"],
        message: "Marketing Consent defaults off and requires an explicit policy version",
      });
    }
    if (
      body.marketingConsentPolicyVersion &&
      body.marketingConsentPolicyVersion !== MARKETING_CONSENT_POLICY_VERSION
    ) {
      context.addIssue({
        code: "custom",
        path: ["marketingConsentPolicyVersion"],
        message: "Marketing Consent policy version is not current",
      });
    }
  });

const marketingConsentWithdrawalSchema = z
  .object({ idempotencyKey: z.string().trim().min(8).max(128) })
  .strict();

function commerceRouteError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

function asDate(value: string | undefined): Date {
  return value ? new Date(value) : new Date();
}

function assertPostgresBigint(value: string, field: string): void {
  if (BigInt(value) > 9_223_372_036_854_775_807n) {
    throw commerceRouteError(`${field} exceeds the supported range`, 400, "AMOUNT_OUT_OF_RANGE");
  }
}

async function requireStaffPermissionLocked(
  client: DatabaseClient,
  identity: SessionIdentity,
  permission: string,
): Promise<void> {
  const locked = await lockSessionIdentityForMutation(client, identity);
  assertIdentityReadEligible(locked);
  const result = await client.query<{ permissions: unknown }>(
    `SELECT permissions
     FROM staff_members
     WHERE user_id = $1 AND active
     FOR UPDATE`,
    [identity.userId],
  );
  const permissions = result.rows[0]?.permissions;
  if (
    !Array.isArray(permissions) ||
    !permissions.every(
      (permissionName) =>
        typeof permissionName === "string" &&
        permissionName.length > 0 &&
        permissionName.trim() === permissionName,
    ) ||
    (!permissions.includes("*") && !permissions.includes(permission))
  ) {
    throw commerceRouteError(
      `Staff permission ${permission} is required`,
      403,
      "STAFF_PERMISSION_REQUIRED",
    );
  }
}

async function auditCatalogMutation(
  client: DatabaseClient,
  input: Readonly<{
    actorId: string;
    action: string;
    targetType: string;
    targetId: string;
    metadata: Record<string, unknown>;
  }>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events(
       actor_type, actor_id, action, target_type, target_id, metadata
     ) VALUES ('staff', $1, $2, $3, $4, $5)`,
    [input.actorId, input.action, input.targetType, input.targetId, input.metadata],
  );
}

function quoteStatus(row: Readonly<{
  acceptance_id: string | null;
  void_id: string | null;
  unexpired: boolean;
}>): "draft" | "expired" | "void" | "accepted" {
  if (row.acceptance_id) return "accepted";
  if (row.void_id) return "void";
  return row.unexpired ? "draft" : "expired";
}

type QuoteRow = Readonly<{
  id: string;
  client_account_id: string;
  created_by_staff_user_id: string;
  product_id: string;
  catalog_product_revision_id: string;
  product_price_id: string | null;
  product_name: string;
  fulfillment_mode: FulfillmentMode;
  billing_cycle: BillingCycle;
  configuration: unknown;
  price_snapshot: unknown;
  promotion_id: string | null;
  promotion_snapshot: unknown | null;
  capacity_snapshot: unknown;
  currency: string;
  one_time_minor: string;
  setup_minor: string;
  recurring_minor: string;
  total_minor: string;
  expires_at: Date;
  unexpired: boolean;
  created_at: Date;
  void_id: string | null;
  void_reason: string | null;
  voided_at: Date | null;
  acceptance_id: string | null;
  accepted_by_user_id: string | null;
  order_id: string | null;
  invoice_id: string | null;
  accepted_at: Date | null;
}>;

const quoteSelect = `
  SELECT quote.id, quote.client_account_id, quote.created_by_staff_user_id,
         quote.product_id, quote.catalog_product_revision_id,
         quote.product_price_id, quote.product_name, quote.fulfillment_mode,
         quote.billing_cycle, quote.configuration, quote.price_snapshot,
         quote.promotion_id, quote.promotion_snapshot, quote.capacity_snapshot,
         quote.currency, quote.one_time_minor::text, quote.setup_minor::text,
         quote.recurring_minor::text, quote.total_minor::text,
         quote.expires_at,
         quote.expires_at > pg_catalog.transaction_timestamp() AS unexpired,
         quote.created_at,
         void_fact.id AS void_id, void_fact.reason AS void_reason,
         void_fact.voided_at,
         acceptance.id AS acceptance_id,
         acceptance.accepted_by_user_id, acceptance.order_id,
         acceptance.invoice_id, acceptance.accepted_at
  FROM sales_quotes quote
  LEFT JOIN sales_quote_voids void_fact ON void_fact.quote_id = quote.id
  LEFT JOIN sales_quote_acceptances acceptance ON acceptance.quote_id = quote.id`;

function jsonQuote(row: QuoteRow): Record<string, unknown> {
  return {
    quoteId: row.id,
    clientAccountId: row.client_account_id,
    createdByStaffUserId: row.created_by_staff_user_id,
    status: quoteStatus(row),
    productId: row.product_id,
    productRevisionId: row.catalog_product_revision_id,
    priceId: row.product_price_id,
    productName: row.product_name,
    fulfillmentMode: row.fulfillment_mode,
    billingCycle: row.billing_cycle,
    configuration: row.configuration,
    price: row.price_snapshot,
    promotionId: row.promotion_id,
    promotion: row.promotion_snapshot,
    supply: row.capacity_snapshot,
    currency: row.currency,
    oneTimeMinor: row.one_time_minor,
    setupMinor: row.setup_minor,
    recurringMinor: row.recurring_minor,
    totalMinor: row.total_minor,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    void: row.void_id
      ? {
          voidId: row.void_id,
          reason: row.void_reason,
          voidedAt: row.voided_at?.toISOString() ?? null,
        }
      : null,
    acceptance: row.acceptance_id
      ? {
          acceptanceId: row.acceptance_id,
          acceptedByUserId: row.accepted_by_user_id,
          orderId: row.order_id,
          invoiceId: row.invoice_id,
          acceptedAt: row.accepted_at?.toISOString() ?? null,
        }
      : null,
  };
}

export async function registerCommerceRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get("/api/v1/admin/catalog", async (request) => {
    const identity = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, identity, "catalog.read");
    const [groups, products, revisions, prices, supply] = await Promise.all([
      pool.query<{ id: string; sort_order: number; names: unknown }>(
        `SELECT id, sort_order, names
         FROM product_groups
         ORDER BY sort_order, id`,
      ),
      pool.query<{
        id: string;
        group_id: string;
        names: unknown;
        descriptions: unknown;
        fulfillment_mode: FulfillmentMode;
        active: boolean;
        hidden: boolean;
        repeatable: boolean;
        option_schema: unknown;
        revision_id: string;
        revision: number;
        updated_at: Date;
      }>(
        `SELECT product.id, product.group_id, product.names, product.descriptions,
                product.fulfillment_mode, product.active, product.hidden,
                product.repeatable, product.option_schema,
                revision.id AS revision_id, revision.revision,
                product.updated_at
         FROM products product
         JOIN LATERAL (
           SELECT candidate.id, candidate.revision
           FROM catalog_product_revisions candidate
           WHERE candidate.product_id = product.id
           ORDER BY candidate.revision DESC
           LIMIT 1
         ) revision ON true
         ORDER BY product.group_id, product.id`,
      ),
      pool.query<{
        id: string;
        product_id: string;
        revision: number;
        group_id: string;
        names: unknown;
        descriptions: unknown;
        fulfillment_mode: FulfillmentMode;
        active: boolean;
        hidden: boolean;
        repeatable: boolean;
        option_schema: unknown;
        created_by_staff_user_id: string | null;
        created_at: Date;
      }>(
        `SELECT id, product_id, revision, group_id, names, descriptions,
                fulfillment_mode, active, hidden, repeatable, option_schema,
                created_by_staff_user_id, created_at
         FROM catalog_product_revisions
         ORDER BY product_id, revision DESC`,
      ),
      pool.query<{
        id: string;
        product_id: string;
        catalog_product_revision_id: string;
        revision: number;
        currency: string;
        billing_cycle: BillingCycle;
        one_time_minor: string;
        setup_minor: string;
        recurring_minor: string;
        active: boolean;
        valid_from: Date;
        valid_until: Date | null;
      }>(
        `SELECT id, product_id, catalog_product_revision_id, revision,
                currency, billing_cycle, one_time_minor::text,
                setup_minor::text, recurring_minor::text, active,
                valid_from, valid_until
         FROM product_prices
         ORDER BY product_id, billing_cycle, revision DESC`,
      ),
      pool.query<{
        product_id: string;
        mode: "unlimited" | "tracked" | "manual_review";
        available_units: string | null;
        committed_units: string;
        version: string;
        updated_by_staff_user_id: string;
        updated_at: Date;
      }>(
        `SELECT product_id, mode, available_units::text,
                committed_units::text, version::text,
                updated_by_staff_user_id, updated_at
         FROM product_supply_capacities
         ORDER BY product_id`,
      ),
    ]);
    return {
      warning: LAB_BANNER,
      groups: groups.rows.map((row) => ({
        id: row.id,
        sortOrder: row.sort_order,
        names: row.names,
      })),
      products: products.rows.map((row) => ({
        id: row.id,
        groupId: row.group_id,
        names: row.names,
        descriptions: row.descriptions,
        fulfillmentMode: row.fulfillment_mode,
        active: row.active,
        hidden: row.hidden,
        repeatable: row.repeatable,
        optionSchema: row.option_schema,
        currentRevisionId: row.revision_id,
        currentRevision: row.revision,
        updatedAt: row.updated_at.toISOString(),
      })),
      revisions: revisions.rows.map((row) => ({
        id: row.id,
        productId: row.product_id,
        revision: row.revision,
        groupId: row.group_id,
        names: row.names,
        descriptions: row.descriptions,
        fulfillmentMode: row.fulfillment_mode,
        active: row.active,
        hidden: row.hidden,
        repeatable: row.repeatable,
        optionSchema: row.option_schema,
        createdByStaffUserId: row.created_by_staff_user_id,
        createdAt: row.created_at.toISOString(),
      })),
      prices: prices.rows.map((row) => ({
        id: row.id,
        productId: row.product_id,
        productRevisionId: row.catalog_product_revision_id,
        revision: row.revision,
        currency: row.currency,
        billingCycle: row.billing_cycle,
        oneTimeMinor: row.one_time_minor,
        setupMinor: row.setup_minor,
        recurringMinor: row.recurring_minor,
        active: row.active,
        validFrom: row.valid_from.toISOString(),
        validUntil: row.valid_until?.toISOString() ?? null,
      })),
      supply: supply.rows.map((row) => ({
        productId: row.product_id,
        mode: row.mode,
        availableUnits: row.available_units,
        committedUnits: row.committed_units,
        version: row.version,
        updatedByStaffUserId: row.updated_by_staff_user_id,
        updatedAt: row.updated_at.toISOString(),
      })),
    };
  });

  app.put("/api/v1/admin/catalog/groups/:groupId", async (request) => {
    const identity = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, identity, "catalog.manage");
    const params = z.object({ groupId: catalogId }).parse(request.params);
    const body = productGroupSchema.omit({ id: true }).parse(request.body);
    return transaction(pool, async (client) => {
      await requireStaffPermissionLocked(client, identity, "catalog.manage");
      await client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
        [`catalog:group:${params.groupId}`],
      );
      await client.query(
        `INSERT INTO product_groups(id, sort_order, names)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET
           sort_order = EXCLUDED.sort_order,
           names = EXCLUDED.names`,
        [params.groupId, body.sortOrder, body.names],
      );
      await auditCatalogMutation(client, {
        actorId: identity.userId,
        action: "catalog.group_defined",
        targetType: "product_group",
        targetId: params.groupId,
        metadata: { sortOrder: body.sortOrder, names: body.names },
      });
      return { groupId: params.groupId };
    });
  });

  app.post("/api/v1/admin/catalog/products", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, identity, "catalog.manage");
    const body = productDefinitionSchema.parse(request.body);
    validateCatalogOptionSchema(body.optionSchema);
    const created = await transaction(pool, async (client) => {
      await requireStaffPermissionLocked(client, identity, "catalog.manage");
      await client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
        [`catalog:product:${body.id}`],
      );
      const group = await client.query(
        "SELECT id FROM product_groups WHERE id = $1 FOR SHARE",
        [body.groupId],
      );
      if (group.rowCount !== 1) {
        throw commerceRouteError("Product group not found", 404, "PRODUCT_GROUP_NOT_FOUND");
      }
      const existing = await client.query(
        "SELECT id FROM products WHERE id = $1 FOR UPDATE",
        [body.id],
      );
      if (existing.rowCount !== 0) {
        throw commerceRouteError("Product already exists", 409, "PRODUCT_EXISTS");
      }
      await client.query(
        `INSERT INTO products(
           id, group_id, names, descriptions, fulfillment_mode,
           active, hidden, repeatable, option_schema
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          body.id,
          body.groupId,
          body.names,
          body.descriptions,
          body.fulfillmentMode,
          body.active,
          body.hidden,
          body.repeatable,
          JSON.stringify(body.optionSchema),
        ],
      );
      const revision = await client.query<{ id: string }>(
        `INSERT INTO catalog_product_revisions(
           product_id, revision, group_id, names, descriptions,
           fulfillment_mode, active, hidden, repeatable, option_schema,
           created_by_staff_user_id
         ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          body.id,
          body.groupId,
          body.names,
          body.descriptions,
          body.fulfillmentMode,
          body.active,
          body.hidden,
          body.repeatable,
          JSON.stringify(body.optionSchema),
          identity.userId,
        ],
      );
      await client.query(
        `INSERT INTO product_supply_capacities(
           product_id, mode, available_units, committed_units,
           updated_by_staff_user_id
         ) VALUES ($1, 'unlimited', NULL, 0, $2)`,
        [body.id, identity.userId],
      );
      await auditCatalogMutation(client, {
        actorId: identity.userId,
        action: "catalog.product_created",
        targetType: "product",
        targetId: body.id,
        metadata: { revisionId: revision.rows[0]?.id, revision: 1 },
      });
      return { productId: body.id, productRevisionId: revision.rows[0]?.id, revision: 1 };
    });
    return reply.code(201).send(created);
  });

  app.post(
    "/api/v1/admin/catalog/products/:productId/revisions",
    async (request, reply) => {
      const identity = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, identity, "catalog.manage");
      const params = z.object({ productId: catalogId }).parse(request.params);
      const body = productRevisionSchema.parse(request.body);
      validateCatalogOptionSchema(body.optionSchema);
      const created = await transaction(pool, async (client) => {
        await requireStaffPermissionLocked(client, identity, "catalog.manage");
        await client.query(
          "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
          [`catalog:product:${params.productId}`],
        );
        const group = await client.query(
          "SELECT id FROM product_groups WHERE id = $1 FOR SHARE",
          [body.groupId],
        );
        if (group.rowCount !== 1) {
          throw commerceRouteError("Product group not found", 404, "PRODUCT_GROUP_NOT_FOUND");
        }
        const product = await client.query(
          "SELECT id FROM products WHERE id = $1 FOR UPDATE",
          [params.productId],
        );
        if (product.rowCount !== 1) {
          throw commerceRouteError("Product not found", 404, "PRODUCT_NOT_FOUND");
        }
        const latest = await client.query<{ revision: number }>(
          `SELECT revision
           FROM catalog_product_revisions
           WHERE product_id = $1
           ORDER BY revision DESC
           LIMIT 1
           FOR SHARE`,
          [params.productId],
        );
        const revisionNumber = (latest.rows[0]?.revision ?? 0) + 1;
        const revision = await client.query<{ id: string }>(
          `INSERT INTO catalog_product_revisions(
             product_id, revision, group_id, names, descriptions,
             fulfillment_mode, active, hidden, repeatable, option_schema,
             created_by_staff_user_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            params.productId,
            revisionNumber,
            body.groupId,
            body.names,
            body.descriptions,
            body.fulfillmentMode,
            body.active,
            body.hidden,
            body.repeatable,
            JSON.stringify(body.optionSchema),
            identity.userId,
          ],
        );
        await client.query(
          `UPDATE products
           SET group_id = $2, names = $3, descriptions = $4,
               fulfillment_mode = $5, active = $6, hidden = $7,
               repeatable = $8, option_schema = $9,
               updated_at = pg_catalog.now()
           WHERE id = $1`,
          [
            params.productId,
            body.groupId,
            body.names,
            body.descriptions,
            body.fulfillmentMode,
            body.active,
            body.hidden,
            body.repeatable,
            JSON.stringify(body.optionSchema),
          ],
        );
        await auditCatalogMutation(client, {
          actorId: identity.userId,
          action: "catalog.product_revision_created",
          targetType: "product",
          targetId: params.productId,
          metadata: { revisionId: revision.rows[0]?.id, revision: revisionNumber },
        });
        return {
          productId: params.productId,
          productRevisionId: revision.rows[0]?.id,
          revision: revisionNumber,
        };
      });
      return reply.code(201).send(created);
    },
  );

  app.post(
    "/api/v1/admin/catalog/products/:productId/prices",
    async (request, reply) => {
      const identity = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, identity, "catalog.pricing.manage");
      const params = z.object({ productId: catalogId }).parse(request.params);
      const body = priceRevisionSchema.parse(request.body);
      for (const [field, amount] of [
        ["oneTimeMinor", body.oneTimeMinor],
        ["setupMinor", body.setupMinor],
        ["recurringMinor", body.recurringMinor],
      ] as const) {
        assertPostgresBigint(amount, field);
      }
      const effectiveAt = asDate(body.effectiveAt);
      if (effectiveAt.getTime() < Date.now() - 60_000) {
        throw commerceRouteError(
          "Price effectiveAt cannot be in the past",
          400,
          "PRICE_EFFECTIVE_AT_INVALID",
        );
      }
      const created = await transaction(pool, async (client) => {
        await requireStaffPermissionLocked(client, identity, "catalog.pricing.manage");
        await client.query(
          "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
          [`catalog:price:${params.productId}:${body.billingCycle}`],
        );
        const product = await client.query(
          "SELECT id FROM products WHERE id = $1 FOR SHARE",
          [params.productId],
        );
        if (product.rowCount !== 1) {
          throw commerceRouteError("Product not found", 404, "PRODUCT_NOT_FOUND");
        }
        const revision = await client.query<{ id: string }>(
          `SELECT id
           FROM catalog_product_revisions
           WHERE product_id = $1
           ORDER BY revision DESC
           LIMIT 1
           FOR SHARE`,
          [params.productId],
        );
        const productRevisionId = revision.rows[0]?.id;
        if (!productRevisionId) throw new Error("Catalog Product revision is missing");
        const prices = await client.query<{
          id: string;
          revision: number;
          active: boolean;
          valid_from: Date;
          valid_until: Date | null;
        }>(
          `SELECT id, revision, active, valid_from, valid_until
           FROM product_prices
           WHERE product_id = $1 AND billing_cycle = $2
           ORDER BY revision
           FOR UPDATE`,
          [params.productId, body.billingCycle],
        );
        const overlapping = prices.rows.filter(
          (price) =>
            price.active &&
            price.valid_from.getTime() >= effectiveAt.getTime(),
        );
        if (overlapping.length > 0) {
          throw commerceRouteError(
            "A current or scheduled price already begins at or after effectiveAt; retire it before replacing the schedule",
            409,
            "PRICE_SCHEDULE_CONFLICT",
          );
        }
        for (const price of prices.rows) {
          if (
            price.active &&
            price.valid_from.getTime() < effectiveAt.getTime() &&
            (price.valid_until === null || price.valid_until.getTime() > effectiveAt.getTime())
          ) {
            if (price.valid_until !== null) {
              throw commerceRouteError(
                "The requested price overlaps a closed validity interval",
                409,
                "PRICE_SCHEDULE_CONFLICT",
              );
            }
            await client.query(
              `UPDATE product_prices
               SET valid_until = $2
               WHERE id = $1`,
              [price.id, effectiveAt],
            );
          }
        }
        const revisionNumber =
          Math.max(0, ...prices.rows.map((price) => price.revision)) + 1;
        const result = await client.query<{ id: string }>(
          `INSERT INTO product_prices(
             product_id, catalog_product_revision_id, revision, currency,
             billing_cycle, one_time_minor, setup_minor, recurring_minor,
             active, valid_from, valid_until
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10)
           RETURNING id`,
          [
            params.productId,
            productRevisionId,
            revisionNumber,
            body.currency,
            body.billingCycle,
            body.oneTimeMinor,
            body.setupMinor,
            body.recurringMinor,
            effectiveAt,
            body.validUntil ? new Date(body.validUntil) : null,
          ],
        );
        const priceId = result.rows[0]?.id;
        if (!priceId) throw new Error("Unable to create price revision");
        await auditCatalogMutation(client, {
          actorId: identity.userId,
          action: "catalog.price_revision_created",
          targetType: "product_price",
          targetId: priceId,
          metadata: {
            productId: params.productId,
            productRevisionId,
            revision: revisionNumber,
            billingCycle: body.billingCycle,
            currency: body.currency,
            effectiveAt: effectiveAt.toISOString(),
          },
        });
        return { priceId, productRevisionId, revision: revisionNumber };
      });
      return reply.code(201).send(created);
    },
  );

  app.post(
    "/api/v1/admin/catalog/prices/:priceId/retire",
    async (request) => {
      const identity = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, identity, "catalog.pricing.manage");
      const params = z.object({ priceId: canonicalUuid }).parse(request.params);
      const body = retireSchema.parse(request.body);
      const effectiveAt = asDate(body.effectiveAt);
      if (effectiveAt.getTime() < Date.now() - 60_000) {
        throw commerceRouteError(
          "Price retirement cannot be in the past",
          400,
          "PRICE_RETIREMENT_INVALID",
        );
      }
      return transaction(pool, async (client) => {
        await requireStaffPermissionLocked(client, identity, "catalog.pricing.manage");
        const pointer = await client.query<{ product_id: string }>(
          "SELECT product_id FROM product_prices WHERE id = $1",
          [params.priceId],
        );
        const productId = pointer.rows[0]?.product_id;
        if (!productId) throw commerceRouteError("Price not found", 404, "PRICE_NOT_FOUND");
        await client.query(
          "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
          [`catalog:product:${productId}`],
        );
        await client.query("SELECT id FROM products WHERE id = $1 FOR SHARE", [productId]);
        const result = await client.query<{
          active: boolean;
          valid_from: Date;
          valid_until: Date | null;
        }>(
          `SELECT active, valid_from, valid_until
           FROM product_prices
           WHERE id = $1
           FOR UPDATE`,
          [params.priceId],
        );
        const price = result.rows[0];
        if (!price) throw commerceRouteError("Price not found", 404, "PRICE_NOT_FOUND");
        if (effectiveAt.getTime() <= price.valid_from.getTime()) {
          throw commerceRouteError(
            "Price retirement must be after validFrom",
            409,
            "PRICE_RETIREMENT_INVALID",
          );
        }
        if (price.valid_until && price.valid_until.getTime() !== effectiveAt.getTime()) {
          throw commerceRouteError(
            "A closed price validity interval cannot be changed",
            409,
            "PRICE_ALREADY_RETIRED",
          );
        }
        await client.query(
          `UPDATE product_prices
           SET active = CASE WHEN $2 <= pg_catalog.transaction_timestamp() THEN false ELSE active END,
               valid_until = COALESCE(valid_until, $2)
           WHERE id = $1`,
          [params.priceId, effectiveAt],
        );
        await auditCatalogMutation(client, {
          actorId: identity.userId,
          action: "catalog.price_retired",
          targetType: "product_price",
          targetId: params.priceId,
          metadata: { effectiveAt: effectiveAt.toISOString() },
        });
        return { priceId: params.priceId, effectiveAt: effectiveAt.toISOString() };
      });
    },
  );

  app.put(
    "/api/v1/admin/catalog/products/:productId/supply",
    async (request) => {
      const identity = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, identity, "catalog.supply.manage");
      const params = z.object({ productId: catalogId }).parse(request.params);
      const body = supplyDefinitionSchema.parse(request.body);
      return transaction(pool, async (client) => {
        await requireStaffPermissionLocked(client, identity, "catalog.supply.manage");
        await client.query(
          "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
          [`catalog:supply:${params.productId}`],
        );
        const product = await client.query(
          "SELECT id FROM products WHERE id = $1 FOR SHARE",
          [params.productId],
        );
        if (product.rowCount !== 1) {
          throw commerceRouteError("Product not found", 404, "PRODUCT_NOT_FOUND");
        }
        const current = await client.query<{
          mode: "unlimited" | "tracked" | "manual_review";
          committed_units: string;
        }>(
          `SELECT mode, committed_units::text
           FROM product_supply_capacities
           WHERE product_id = $1
           FOR UPDATE`,
          [params.productId],
        );
        const committed = BigInt(current.rows[0]?.committed_units ?? "0");
        if (body.mode !== "tracked" && committed > 0n) {
          throw commerceRouteError(
            "Tracked supply with committed Orders cannot be changed to an untracked mode",
            409,
            "SUPPLY_COMMITMENTS_EXIST",
          );
        }
        if (body.availableUnits !== null && BigInt(body.availableUnits) < committed) {
          throw commerceRouteError(
            "availableUnits cannot be lower than committed units",
            409,
            "SUPPLY_BELOW_COMMITTED",
          );
        }
        await client.query(
          `INSERT INTO product_supply_capacities(
             product_id, mode, available_units, committed_units,
             updated_by_staff_user_id
           ) VALUES ($1, $2, $3, 0, $4)
           ON CONFLICT (product_id) DO UPDATE SET
             mode = EXCLUDED.mode,
             available_units = EXCLUDED.available_units,
             committed_units = CASE
               WHEN EXCLUDED.mode = 'tracked'
                 THEN product_supply_capacities.committed_units
               ELSE 0
             END,
             version = product_supply_capacities.version + 1,
             updated_by_staff_user_id = EXCLUDED.updated_by_staff_user_id,
             updated_at = pg_catalog.now()`,
          [params.productId, body.mode, body.availableUnits, identity.userId],
        );
        const result = await client.query<{
          mode: "unlimited" | "tracked" | "manual_review";
          available_units: string | null;
          committed_units: string;
          version: string;
        }>(
          `SELECT mode, available_units::text, committed_units::text, version::text
           FROM product_supply_capacities
           WHERE product_id = $1`,
          [params.productId],
        );
        const supply = result.rows[0];
        if (!supply) throw new Error("Unable to save supply definition");
        await auditCatalogMutation(client, {
          actorId: identity.userId,
          action: "catalog.supply_defined",
          targetType: "product_supply",
          targetId: params.productId,
          metadata: {
            mode: supply.mode,
            availableUnits: supply.available_units,
            committedUnits: supply.committed_units,
            version: supply.version,
          },
        });
        return {
          productId: params.productId,
          mode: supply.mode,
          availableUnits: supply.available_units,
          committedUnits: supply.committed_units,
          version: supply.version,
        };
      });
    },
  );

  app.get("/api/v1/admin/promotions", async (request) => {
    const identity = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, identity, "catalog.promotions.read");
    const result = await pool.query<{
      id: string;
      code: string;
      revision: number;
      name: string;
      product_id: string | null;
      billing_cycle: BillingCycle | null;
      discount_kind: "fixed" | "percentage";
      application_scope: "one_time" | "recurring" | "all";
      fixed_amount_minor: string | null;
      percentage_basis_points: number | null;
      currency: string | null;
      active: boolean;
      valid_from: Date;
      valid_until: Date | null;
      maximum_redemptions: string | null;
      redemptions: string;
      created_by_staff_user_id: string;
      created_at: Date;
    }>(
      `SELECT promotion.id, promotion.code::text, promotion.revision,
              promotion.name, promotion.product_id, promotion.billing_cycle,
              promotion.discount_kind, promotion.application_scope,
              promotion.fixed_amount_minor::text,
              promotion.percentage_basis_points, promotion.currency,
              promotion.active, promotion.valid_from, promotion.valid_until,
              promotion.maximum_redemptions::text,
              pg_catalog.count(redemption.id)::text AS redemptions,
              promotion.created_by_staff_user_id, promotion.created_at
       FROM promotions promotion
       LEFT JOIN promotion_redemptions redemption
         ON redemption.promotion_id = promotion.id
       GROUP BY promotion.id
       ORDER BY promotion.code, promotion.revision DESC`,
    );
    return {
      warning: LAB_BANNER,
      items: result.rows.map((row) => ({
        id: row.id,
        code: row.code,
        revision: row.revision,
        name: row.name,
        productId: row.product_id,
        billingCycle: row.billing_cycle,
        discountKind: row.discount_kind,
        applicationScope: row.application_scope,
        fixedAmountMinor: row.fixed_amount_minor,
        percentageBasisPoints: row.percentage_basis_points,
        currency: row.currency,
        active: row.active,
        validFrom: row.valid_from.toISOString(),
        validUntil: row.valid_until?.toISOString() ?? null,
        maximumRedemptions: row.maximum_redemptions,
        redemptions: row.redemptions,
        createdByStaffUserId: row.created_by_staff_user_id,
        createdAt: row.created_at.toISOString(),
      })),
    };
  });

  app.post("/api/v1/admin/promotions", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, identity, "catalog.promotions.manage");
    const body = promotionDefinitionSchema.parse(request.body);
    if (body.fixedAmountMinor) assertPostgresBigint(body.fixedAmountMinor, "fixedAmountMinor");
    if (body.maximumRedemptions) {
      assertPostgresBigint(body.maximumRedemptions, "maximumRedemptions");
    }
    const effectiveAt = asDate(body.effectiveAt);
    if (effectiveAt.getTime() < Date.now() - 60_000) {
      throw commerceRouteError(
        "Promotion effectiveAt cannot be in the past",
        400,
        "PROMOTION_EFFECTIVE_AT_INVALID",
      );
    }
    const created = await transaction(pool, async (client) => {
      await requireStaffPermissionLocked(client, identity, "catalog.promotions.manage");
      await client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
        [`catalog:promotion:${body.code}`],
      );
      if (body.productId) {
        const product = await client.query(
          "SELECT id FROM products WHERE id = $1 FOR SHARE",
          [body.productId],
        );
        if (product.rowCount !== 1) {
          throw commerceRouteError("Product not found", 404, "PRODUCT_NOT_FOUND");
        }
      }
      const existing = await client.query<{
        id: string;
        revision: number;
        active: boolean;
        valid_from: Date;
        valid_until: Date | null;
      }>(
        `SELECT id, revision, active, valid_from, valid_until
         FROM promotions
         WHERE code = $1
         ORDER BY revision
         FOR UPDATE`,
        [body.code],
      );
      if (
        existing.rows.some(
          (promotion) =>
            promotion.active && promotion.valid_from.getTime() >= effectiveAt.getTime(),
        )
      ) {
        throw commerceRouteError(
          "A current or scheduled Promotion already begins at or after effectiveAt",
          409,
          "PROMOTION_SCHEDULE_CONFLICT",
        );
      }
      for (const promotion of existing.rows) {
        if (
          promotion.active &&
          promotion.valid_from.getTime() < effectiveAt.getTime() &&
          (promotion.valid_until === null ||
            promotion.valid_until.getTime() > effectiveAt.getTime())
        ) {
          if (promotion.valid_until !== null) {
            throw commerceRouteError(
              "The requested Promotion overlaps a closed validity interval",
              409,
              "PROMOTION_SCHEDULE_CONFLICT",
            );
          }
          await client.query(
            "UPDATE promotions SET valid_until = $2 WHERE id = $1",
            [promotion.id, effectiveAt],
          );
        }
      }
      const revision = Math.max(0, ...existing.rows.map((row) => row.revision)) + 1;
      const result = await client.query<{ id: string }>(
        `INSERT INTO promotions(
           code, revision, name, product_id, billing_cycle,
           discount_kind, application_scope, fixed_amount_minor,
           percentage_basis_points, currency, active, valid_from,
           valid_until, maximum_redemptions, created_by_staff_user_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           true, $11, $12, $13, $14
         )
         RETURNING id`,
        [
          body.code,
          revision,
          body.name,
          body.productId,
          body.billingCycle,
          body.discountKind,
          body.applicationScope,
          body.fixedAmountMinor,
          body.percentageBasisPoints,
          body.currency,
          effectiveAt,
          body.validUntil ? new Date(body.validUntil) : null,
          body.maximumRedemptions,
          identity.userId,
        ],
      );
      const promotionId = result.rows[0]?.id;
      if (!promotionId) throw new Error("Unable to create Promotion revision");
      await auditCatalogMutation(client, {
        actorId: identity.userId,
        action: "catalog.promotion_revision_created",
        targetType: "promotion",
        targetId: promotionId,
        metadata: {
          code: body.code,
          revision,
          productId: body.productId,
          billingCycle: body.billingCycle,
          effectiveAt: effectiveAt.toISOString(),
        },
      });
      return { promotionId, code: body.code, revision };
    });
    return reply.code(201).send(created);
  });

  app.post("/api/v1/admin/promotions/:promotionId/retire", async (request) => {
    const identity = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, identity, "catalog.promotions.manage");
    const params = z.object({ promotionId: canonicalUuid }).parse(request.params);
    const body = retireSchema.parse(request.body);
    const effectiveAt = asDate(body.effectiveAt);
    if (effectiveAt.getTime() < Date.now() - 60_000) {
      throw commerceRouteError(
        "Promotion retirement cannot be in the past",
        400,
        "PROMOTION_RETIREMENT_INVALID",
      );
    }
    return transaction(pool, async (client) => {
      await requireStaffPermissionLocked(client, identity, "catalog.promotions.manage");
      const result = await client.query<{
        code: string;
        active: boolean;
        valid_from: Date;
        valid_until: Date | null;
      }>(
        `SELECT code::text, active, valid_from, valid_until
         FROM promotions
         WHERE id = $1
         FOR UPDATE`,
        [params.promotionId],
      );
      const promotion = result.rows[0];
      if (!promotion) {
        throw commerceRouteError("Promotion not found", 404, "PROMOTION_NOT_FOUND");
      }
      if (effectiveAt.getTime() <= promotion.valid_from.getTime()) {
        throw commerceRouteError(
          "Promotion retirement must be after validFrom",
          409,
          "PROMOTION_RETIREMENT_INVALID",
        );
      }
      if (
        promotion.valid_until &&
        promotion.valid_until.getTime() !== effectiveAt.getTime()
      ) {
        throw commerceRouteError(
          "A closed Promotion validity interval cannot be changed",
          409,
          "PROMOTION_ALREADY_RETIRED",
        );
      }
      await client.query(
        `UPDATE promotions
         SET active = CASE WHEN $2 <= pg_catalog.transaction_timestamp() THEN false ELSE active END,
             valid_until = COALESCE(valid_until, $2)
         WHERE id = $1`,
        [params.promotionId, effectiveAt],
      );
      await auditCatalogMutation(client, {
        actorId: identity.userId,
        action: "catalog.promotion_retired",
        targetType: "promotion",
        targetId: params.promotionId,
        metadata: { code: promotion.code, effectiveAt: effectiveAt.toISOString() },
      });
      return { promotionId: params.promotionId, effectiveAt: effectiveAt.toISOString() };
    });
  });

  app.post("/api/v1/admin/quotes", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, identity, "quotes.manage");
    const body = staffQuoteSchema.parse(request.body);
    const expiresAt = new Date(body.expiresAt);
    const lifetime = expiresAt.getTime() - Date.now();
    if (lifetime < 5 * 60_000 || lifetime > 90 * 24 * 60 * 60_000) {
      throw commerceRouteError(
        "Quote expiry must be between 5 minutes and 90 days from now",
        400,
        "QUOTE_EXPIRY_INVALID",
      );
    }
    if (body.pricing.mode === "manual") {
      for (const [field, amount] of [
        ["oneTimeMinor", body.pricing.oneTimeMinor],
        ["setupMinor", body.pricing.setupMinor],
        ["recurringMinor", body.pricing.recurringMinor],
      ] as const) {
        assertPostgresBigint(amount, field);
      }
    }
    const fingerprint = requestFingerprint("admin.quotes.create:v1", body);
    const result = await transaction(pool, async (client) => {
      await requireStaffPermissionLocked(client, identity, "quotes.manage");
      await client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
        [`quote:create:${identity.userId}:${body.idempotencyKey}`],
      );
      const replay = await client.query<{
        id: string;
        request_fingerprint: string;
        expires_at: Date;
        unexpired: boolean;
        void_id: string | null;
        acceptance_id: string | null;
      }>(
        `SELECT quote.id, quote.request_fingerprint, quote.expires_at,
                quote.expires_at > pg_catalog.transaction_timestamp() AS unexpired,
                void_fact.id AS void_id, acceptance.id AS acceptance_id
         FROM sales_quotes quote
         LEFT JOIN sales_quote_voids void_fact ON void_fact.quote_id = quote.id
         LEFT JOIN sales_quote_acceptances acceptance ON acceptance.quote_id = quote.id
         WHERE quote.created_by_staff_user_id = $1 AND quote.idempotency_key = $2
         FOR UPDATE OF quote`,
        [identity.userId, body.idempotencyKey],
      );
      const existing = replay.rows[0];
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) {
          throw commerceRouteError(
            "Quote idempotency key was used for a different draft",
            409,
            "IDEMPOTENCY_CONFLICT",
          );
        }
        return {
          quoteId: existing.id,
          status: quoteStatus(existing),
          replayed: true,
        };
      }
      const account = await client.query(
        "SELECT id FROM client_accounts WHERE id = $1 FOR SHARE",
        [body.clientAccountId],
      );
      if (account.rowCount !== 1) {
        throw commerceRouteError("Client Account not found", 404, "CLIENT_ACCOUNT_NOT_FOUND");
      }

      let productId: string;
      let productName: string;
      let productRevisionId: string;
      let productRevision: number;
      let priceId: string | null;
      let priceRevision: number | null;
      let billingCycle: BillingCycle;
      let fulfillmentMode: FulfillmentMode;
      let configurationSnapshot: Readonly<Record<string, unknown>>;
      let capacityUnits: bigint;
      let snapshot: ReturnType<typeof buildCommercialPriceSnapshot>;
      let promotion: LockedPromotion | null;

      if (body.pricing.mode === "catalog") {
        const offer = await lockCatalogOffer(client, {
          priceId: body.pricing.priceId,
          locale: "en",
          allowQuote: true,
        });
        if (offer.fulfillmentMode === "quote") {
          throw commerceRouteError(
            "Quote-required products must use explicit Staff manual pricing; Catalog placeholder prices are never billable",
            409,
            "MANUAL_QUOTE_PRICING_REQUIRED",
          );
        }
        promotion = await lockPromotion(client, {
          code: body.pricing.promotionCode,
          productId: offer.productId,
          billingCycle: offer.billingCycle,
          currency: offer.currency,
        });
        const priced = buildOfferSnapshot(
          offer,
          body.pricing.configuration,
          promotion,
        );
        productId = offer.productId;
        productName = offer.productName;
        productRevisionId = offer.productRevisionId;
        productRevision = offer.productRevision;
        priceId = offer.priceId;
        priceRevision = offer.priceRevision;
        billingCycle = offer.billingCycle;
        fulfillmentMode = offer.fulfillmentMode;
        configurationSnapshot = priced.configurationSnapshot;
        capacityUnits = priced.capacityUnits;
        snapshot = priced.snapshot;
      } else {
        const revision = await lockCatalogRevision(client, {
          productRevisionId: body.pricing.productRevisionId,
          locale: "en",
          requireCurrent: true,
        });
        promotion = await lockPromotion(client, {
          code: body.pricing.promotionCode,
          productId: revision.productId,
          billingCycle: body.pricing.billingCycle,
          currency: body.pricing.currency,
        });
        const resolved = resolveCatalogConfiguration(
          revision.optionSchema,
          body.pricing.configuration,
        );
        productId = revision.productId;
        productName = revision.productName;
        productRevisionId = revision.productRevisionId;
        productRevision = revision.productRevision;
        priceId = null;
        priceRevision = null;
        billingCycle = body.pricing.billingCycle;
        fulfillmentMode = revision.fulfillmentMode;
        configurationSnapshot = resolved.configurationSnapshot;
        capacityUnits = resolved.capacityUnits;
        snapshot = buildCommercialPriceSnapshot({
          productId,
          productName,
          currency: body.pricing.currency,
          billingCycle,
          fulfillmentMode,
          baseOneTimeMinor: BigInt(body.pricing.oneTimeMinor),
          setupMinor: BigInt(body.pricing.setupMinor),
          baseRecurringMinor: BigInt(body.pricing.recurringMinor),
          optionComponents: resolved.components,
          promotion,
        });
      }
      const capacity = await supplyPreflight(client, {
        productId,
        units: capacityUnits,
        commit: false,
      });
      const serialized = jsonCommercialSnapshot(snapshot, {
        productRevisionId,
        productRevision,
        priceId,
        priceRevision,
        capacity,
      });
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO sales_quotes(
           client_account_id, created_by_staff_user_id,
           product_id, catalog_product_revision_id, product_price_id,
           product_name, fulfillment_mode, billing_cycle, configuration,
           price_snapshot, promotion_id, promotion_snapshot, capacity_snapshot,
           currency, one_time_minor, setup_minor, recurring_minor, total_minor,
           expires_at, idempotency_key, request_fingerprint
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9,
           $10, $11, $12, $13, $14, $15, $16, $17, $18,
           $19, $20, $21
         )
         RETURNING id`,
        [
          body.clientAccountId,
          identity.userId,
          productId,
          productRevisionId,
          priceId,
          productName,
          fulfillmentMode,
          billingCycle,
          configurationSnapshot,
          serialized,
          promotion?.id ?? null,
          serialized.promotion,
          serialized.supply,
          snapshot.currency,
          snapshot.oneTimeSubtotalMinor.toString(),
          snapshot.setupMinor.toString(),
          snapshot.recurringSubtotalMinor.toString(),
          snapshot.invoiceTotalMinor.toString(),
          expiresAt,
          body.idempotencyKey,
          fingerprint,
        ],
      );
      const quoteId = inserted.rows[0]?.id;
      if (!quoteId) throw new Error("Unable to create Quote");
      await auditCatalogMutation(client, {
        actorId: identity.userId,
        action: "quote.draft_created",
        targetType: "sales_quote",
        targetId: quoteId,
        metadata: {
          clientAccountId: body.clientAccountId,
          productId,
          productRevisionId,
          priceId,
          totalMinor: snapshot.invoiceTotalMinor.toString(),
          currency: snapshot.currency,
          expiresAt: expiresAt.toISOString(),
        },
      });
      return { quoteId, status: "draft" as const, replayed: false };
    });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.get("/api/v1/admin/quotes", async (request) => {
    const identity = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, identity, "quotes.read");
    const query = z
      .object({ clientAccountId: canonicalUuid.optional() })
      .parse(request.query);
    const result = await pool.query<QuoteRow>(
      `${quoteSelect}
       WHERE ($1::uuid IS NULL OR quote.client_account_id = $1)
       ORDER BY quote.created_at DESC, quote.id DESC
       LIMIT 200`,
      [query.clientAccountId ?? null],
    );
    return { warning: LAB_BANNER, items: result.rows.map(jsonQuote) };
  });

  app.get("/api/v1/admin/quotes/:quoteId", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, identity, "quotes.read");
    const params = z.object({ quoteId: canonicalUuid }).parse(request.params);
    const result = await pool.query<QuoteRow>(
      `${quoteSelect}
       WHERE quote.id = $1`,
      [params.quoteId],
    );
    const quote = result.rows[0];
    if (!quote) return reply.code(404).send({ error: "Quote not found" });
    return { warning: LAB_BANNER, quote: jsonQuote(quote) };
  });

  app.post("/api/v1/admin/quotes/:quoteId/void", async (request) => {
    const identity = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, identity, "quotes.manage");
    const params = z.object({ quoteId: canonicalUuid }).parse(request.params);
    const body = quoteVoidSchema.parse(request.body);
    return transaction(pool, async (client) => {
      await requireStaffPermissionLocked(client, identity, "quotes.manage");
      await client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
        [`quote:terminal:${params.quoteId}`],
      );
      const quote = await client.query(
        "SELECT id FROM sales_quotes WHERE id = $1 FOR UPDATE",
        [params.quoteId],
      );
      if (quote.rowCount !== 1) {
        throw commerceRouteError("Quote not found", 404, "QUOTE_NOT_FOUND");
      }
      const acceptance = await client.query(
        "SELECT id FROM sales_quote_acceptances WHERE quote_id = $1 FOR SHARE",
        [params.quoteId],
      );
      if (acceptance.rowCount !== 0) {
        throw commerceRouteError(
          "Accepted Quotes cannot be voided",
          409,
          "QUOTE_ALREADY_ACCEPTED",
        );
      }
      const previous = await client.query<{ id: string; reason: string; voided_at: Date }>(
        `SELECT id, reason, voided_at
         FROM sales_quote_voids
         WHERE quote_id = $1
         FOR SHARE`,
        [params.quoteId],
      );
      const existing = previous.rows[0];
      if (existing) {
        if (existing.reason !== body.reason) {
          throw commerceRouteError(
            "Quote was already voided for a different reason",
            409,
            "QUOTE_ALREADY_VOID",
          );
        }
        return {
          quoteId: params.quoteId,
          status: "void" as const,
          voidId: existing.id,
          voidedAt: existing.voided_at.toISOString(),
          replayed: true,
        };
      }
      const inserted = await client.query<{ id: string; voided_at: Date }>(
        `INSERT INTO sales_quote_voids(quote_id, voided_by_staff_user_id, reason)
         VALUES ($1, $2, $3)
         RETURNING id, voided_at`,
        [params.quoteId, identity.userId, body.reason],
      );
      const voidFact = inserted.rows[0];
      if (!voidFact) throw new Error("Unable to void Quote");
      await auditCatalogMutation(client, {
        actorId: identity.userId,
        action: "quote.voided",
        targetType: "sales_quote",
        targetId: params.quoteId,
        metadata: { voidId: voidFact.id, reason: body.reason },
      });
      return {
        quoteId: params.quoteId,
        status: "void" as const,
        voidId: voidFact.id,
        voidedAt: voidFact.voided_at.toISOString(),
        replayed: false,
      };
    });
  });

  app.get("/api/v1/quotes", async (request) => {
    const user = await requireUser(request, pool, config);
    assertFinancialReadEligible(user);
    assertCustomerCapability(user, "account.history.read");
    const result = await pool.query<QuoteRow>(
      `${quoteSelect}
       WHERE quote.client_account_id = $1
       ORDER BY quote.created_at DESC, quote.id DESC
       LIMIT 100`,
      [user.clientAccountId],
    );
    return { warning: LAB_BANNER, items: result.rows.map(jsonQuote) };
  });

  app.get("/api/v1/quotes/:quoteId", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    assertFinancialReadEligible(user);
    assertCustomerCapability(user, "account.history.read");
    const params = z.object({ quoteId: canonicalUuid }).parse(request.params);
    const result = await pool.query<QuoteRow>(
      `${quoteSelect}
       WHERE quote.id = $1 AND quote.client_account_id = $2`,
      [params.quoteId, user.clientAccountId],
    );
    const quote = result.rows[0];
    if (!quote) return reply.code(404).send({ error: "Quote not found" });
    return { warning: LAB_BANNER, quote: jsonQuote(quote) };
  });

  app.post("/api/v1/quotes/:quoteId/acceptance-preview", async (request) => {
    const user = await requireUser(request, pool, config);
    assertEligible(user);
    assertCustomerCapability(user, "orders.create");
    const params = z.object({ quoteId: canonicalUuid }).parse(request.params);
    const body = quoteAcceptancePreviewSchema.parse(request.body);
    return transaction(pool, async (client) => {
      const result = await client.query<QuoteRow>(
        `${quoteSelect}
         WHERE quote.id = $1 AND quote.client_account_id = $2
         FOR SHARE OF quote`,
        [params.quoteId, user.clientAccountId],
      );
      const quote = result.rows[0];
      if (!quote) throw commerceRouteError("Quote not found", 404, "QUOTE_NOT_FOUND");
      const status = quoteStatus(quote);
      if (status !== "draft") {
        throw commerceRouteError(
          `Quote cannot be accepted because it is ${status}`,
          409,
          `QUOTE_${status.toUpperCase()}`,
        );
      }
      const snapshot = parseCommercialSnapshot(quote.price_snapshot);
      if (
        snapshot.productId !== quote.product_id ||
        snapshot.productName !== quote.product_name ||
        snapshot.fulfillmentMode !== quote.fulfillment_mode ||
        snapshot.billingCycle !== quote.billing_cycle ||
        snapshot.currency !== quote.currency ||
        snapshot.oneTimeSubtotalMinor.toString() !== quote.one_time_minor ||
        snapshot.setupMinor.toString() !== quote.setup_minor ||
        snapshot.recurringSubtotalMinor.toString() !== quote.recurring_minor ||
        snapshot.invoiceTotalMinor.toString() !== quote.total_minor
      ) {
        throw commerceRouteError(
          "Quote commercial snapshot does not match its immutable columns",
          409,
          "QUOTE_SNAPSHOT_INVALID",
        );
      }
      let promotion: LockedPromotion | null = null;
      if (quote.promotion_id) {
        if (!snapshot.promotion) {
          throw commerceRouteError(
            "Quote Promotion snapshot is missing",
            409,
            "QUOTE_SNAPSHOT_INVALID",
          );
        }
        promotion = await lockQuotedPromotion(client, {
          promotionId: quote.promotion_id,
          snapshot: snapshot.promotion,
          productId: quote.product_id,
          billingCycle: quote.billing_cycle,
          currency: quote.currency,
        });
        await assertPromotionCapacity(client, promotion);
      } else if (snapshot.promotion) {
        throw commerceRouteError(
          "Quote Promotion definition is missing",
          409,
          "QUOTE_SNAPSHOT_INVALID",
        );
      }
      const storedCapacity =
        quote.capacity_snapshot &&
        typeof quote.capacity_snapshot === "object" &&
        !Array.isArray(quote.capacity_snapshot)
          ? (quote.capacity_snapshot as Record<string, unknown>)
          : null;
      const units =
        storedCapacity &&
        typeof storedCapacity.units === "string" &&
        /^[1-9]\d*$/.test(storedCapacity.units)
          ? BigInt(storedCapacity.units)
          : null;
      if (units === null) {
        throw commerceRouteError(
          "Quote supply snapshot is invalid",
          409,
          "QUOTE_SNAPSHOT_INVALID",
        );
      }
      const capacity = await supplyPreflight(client, {
        productId: quote.product_id,
        units,
        commit: false,
      });
      const legal = await loadLegalDocuments(client, {
        locale: user.locale,
        termsVersion: body.termsVersion,
        aupVersion: body.aupVersion,
      });
      return {
        warning: LAB_BANNER,
        quote: jsonQuote(quote),
        acceptance: {
          eligible: true,
          invoiceTotalMinor: snapshot.invoiceTotalMinor.toString(),
          zeroAmount: snapshot.invoiceTotalMinor === 0n,
          terms: legal.terms,
          aup: legal.aup,
          supply: {
            mode: capacity.mode,
            units: capacity.units.toString(),
            availableUnits: capacity.availableUnits?.toString() ?? null,
            committedUnits: capacity.committedUnits.toString(),
            version: capacity.version?.toString() ?? null,
          },
          promotionAvailable: promotion !== null,
          marketingConsentDefault: false,
          marketingConsentPolicyVersion: MARKETING_CONSENT_POLICY_VERSION,
        },
      };
    });
  });

  app.post("/api/v1/quotes/:quoteId/accept", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    const expectedVersion = expectedAccountContextVersion(request);
    assertEligible(user);
    assertCustomerCapability(user, "orders.create");
    const params = z.object({ quoteId: canonicalUuid }).parse(request.params);
    const body = quoteAcceptanceSchema.parse(request.body);
    const fingerprint = requestFingerprint("quotes.accept:v1", {
      quoteId: params.quoteId,
      termsVersion: body.termsVersion,
      aupVersion: body.aupVersion,
      marketingConsent: body.marketingConsent,
      marketingConsentPolicyVersion: body.marketingConsentPolicyVersion ?? null,
    });
    const accepted = await transaction(pool, async (client) => {
      const context = await lockAccountContextForMutation(
        client,
        user,
        expectedVersion,
      );
      assertCustomerCapability(context, "orders.create");
      await client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
        [`quote:terminal:${params.quoteId}`],
      );
      await client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
        [`order:${user.clientAccountId}:${body.idempotencyKey}`],
      );
      const previous = await client.query<{
        id: string;
        request_fingerprint: string;
        order_id: string;
        invoice_id: string;
        service_id: string;
        order_status: string;
      }>(
        `SELECT acceptance.id, acceptance.request_fingerprint,
                acceptance.order_id, acceptance.invoice_id,
                service.id AS service_id, original_order.status AS order_status
         FROM sales_quote_acceptances acceptance
         JOIN orders original_order ON original_order.id = acceptance.order_id
         JOIN order_items item ON item.order_id = original_order.id
         JOIN services service ON service.order_item_id = item.id
         WHERE acceptance.client_account_id = $1
           AND acceptance.idempotency_key = $2
         FOR UPDATE OF acceptance`,
        [user.clientAccountId, body.idempotencyKey],
      );
      const replay = previous.rows[0];
      if (replay) {
        if (replay.request_fingerprint !== fingerprint) {
          throw commerceRouteError(
            "Quote acceptance idempotency key was used for a different decision",
            409,
            "IDEMPOTENCY_CONFLICT",
          );
        }
        return {
          acceptanceId: replay.id,
          quoteId: params.quoteId,
          orderId: replay.order_id,
          invoiceId: replay.invoice_id,
          serviceId: replay.service_id,
          orderStatus: replay.order_status,
          replayed: true,
        };
      }
      const result = await client.query<QuoteRow>(
        `${quoteSelect}
         WHERE quote.id = $1 AND quote.client_account_id = $2
         FOR UPDATE OF quote`,
        [params.quoteId, user.clientAccountId],
      );
      const quote = result.rows[0];
      if (!quote) throw commerceRouteError("Quote not found", 404, "QUOTE_NOT_FOUND");
      const status = quoteStatus(quote);
      if (status !== "draft") {
        throw commerceRouteError(
          `Quote cannot be accepted because it is ${status}`,
          409,
          `QUOTE_${status.toUpperCase()}`,
        );
      }
      const snapshot = parseCommercialSnapshot(quote.price_snapshot);
      if (
        snapshot.productId !== quote.product_id ||
        snapshot.productName !== quote.product_name ||
        snapshot.fulfillmentMode !== quote.fulfillment_mode ||
        snapshot.billingCycle !== quote.billing_cycle ||
        snapshot.currency !== quote.currency ||
        snapshot.oneTimeSubtotalMinor.toString() !== quote.one_time_minor ||
        snapshot.setupMinor.toString() !== quote.setup_minor ||
        snapshot.recurringSubtotalMinor.toString() !== quote.recurring_minor ||
        snapshot.invoiceTotalMinor.toString() !== quote.total_minor
      ) {
        throw commerceRouteError(
          "Quote commercial snapshot does not match its immutable columns",
          409,
          "QUOTE_SNAPSHOT_INVALID",
        );
      }
      let promotion: LockedPromotion | null = null;
      if (quote.promotion_id) {
        if (!snapshot.promotion) {
          throw commerceRouteError(
            "Quote Promotion snapshot is missing",
            409,
            "QUOTE_SNAPSHOT_INVALID",
          );
        }
        promotion = await lockQuotedPromotion(client, {
          promotionId: quote.promotion_id,
          snapshot: snapshot.promotion,
          productId: quote.product_id,
          billingCycle: quote.billing_cycle,
          currency: quote.currency,
        });
      } else if (snapshot.promotion) {
        throw commerceRouteError(
          "Quote Promotion definition is missing",
          409,
          "QUOTE_SNAPSHOT_INVALID",
        );
      }
      const storedCapacity =
        quote.capacity_snapshot &&
        typeof quote.capacity_snapshot === "object" &&
        !Array.isArray(quote.capacity_snapshot)
          ? (quote.capacity_snapshot as Record<string, unknown>)
          : null;
      const units =
        storedCapacity &&
        typeof storedCapacity.units === "string" &&
        /^[1-9]\d*$/.test(storedCapacity.units)
          ? BigInt(storedCapacity.units)
          : null;
      if (units === null) {
        throw commerceRouteError(
          "Quote supply snapshot is invalid",
          409,
          "QUOTE_SNAPSHOT_INVALID",
        );
      }
      const capacity = await supplyPreflight(client, {
        productId: quote.product_id,
        units,
        commit: true,
      });
      const legal = await loadLegalDocuments(client, {
        locale: user.locale,
        termsVersion: body.termsVersion,
        aupVersion: body.aupVersion,
      });
      const issued = await issueCommercialOrder(client, {
        clientAccountId: user.clientAccountId,
        userId: user.userId,
        idempotencyKey: `quote:${params.quoteId}`,
        requestFingerprint: fingerprint,
        sourceQuoteId: params.quoteId,
        productId: quote.product_id,
        productName: quote.product_name,
        productRevisionId: quote.catalog_product_revision_id,
        productRevision:
          typeof (quote.price_snapshot as Record<string, unknown>).productRevision ===
            "number" &&
          Number.isSafeInteger(
            (quote.price_snapshot as Record<string, unknown>).productRevision,
          )
            ? Number((quote.price_snapshot as Record<string, unknown>).productRevision)
            : (() => {
                throw commerceRouteError(
                  "Quote product revision snapshot is invalid",
                  409,
                  "QUOTE_SNAPSHOT_INVALID",
                );
              })(),
        priceId: quote.product_price_id,
        priceRevision:
          typeof (quote.price_snapshot as Record<string, unknown>).priceRevision ===
            "number" &&
          Number.isSafeInteger(
            (quote.price_snapshot as Record<string, unknown>).priceRevision,
          )
            ? Number((quote.price_snapshot as Record<string, unknown>).priceRevision)
            : null,
        fulfillmentMode: quote.fulfillment_mode,
        billingCycle: quote.billing_cycle,
        configurationSnapshot: quote.configuration as Readonly<Record<string, unknown>>,
        snapshot,
        capacity,
        legal,
        promotion,
      });
      const acceptance = await client.query<{ id: string }>(
        `INSERT INTO sales_quote_acceptances(
           quote_id, client_account_id, accepted_by_user_id,
           order_id, invoice_id, terms_document_id, aup_document_id,
           idempotency_key, request_fingerprint
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          params.quoteId,
          user.clientAccountId,
          user.userId,
          issued.orderId,
          issued.invoiceId,
          legal.terms.id,
          legal.aup.id,
          body.idempotencyKey,
          fingerprint,
        ],
      );
      const acceptanceId = acceptance.rows[0]?.id;
      if (!acceptanceId) throw new Error("Unable to record Quote acceptance");
      if (body.marketingConsent) {
        await recordMarketingConsent(client, {
          clientAccountId: user.clientAccountId,
          userId: user.userId,
          granted: true,
          policyVersion: MARKETING_CONSENT_POLICY_VERSION,
          source: "quote_acceptance",
          idempotencyKey: `quote:${fingerprint}`,
          requestFingerprint: fingerprint,
        });
      }
      return {
        acceptanceId,
        quoteId: params.quoteId,
        ...issued,
        replayed: false,
      };
    });
    setAccountContextHeaders(reply, user);
    return reply.code(accepted.replayed ? 200 : 201).send(accepted);
  });

  app.get("/api/v1/marketing-consent", async (request) => {
    const user = await requireUser(request, pool, config);
    assertFinancialReadEligible(user);
    assertCustomerCapability(user, "account.history.read");
    const result = await pool.query<{
      granted: boolean;
      policy_version: string;
      recorded_at: Date;
    }>(
      `SELECT granted, policy_version, recorded_at
       FROM current_marketing_consents
       WHERE client_account_id = $1 AND user_id = $2`,
      [user.clientAccountId, user.userId],
    );
    const consent = result.rows[0];
    return {
      granted: consent?.granted ?? false,
      policyVersion: consent?.policy_version ?? MARKETING_CONSENT_POLICY_VERSION,
      recordedAt: consent?.recorded_at.toISOString() ?? null,
      defaulted: !consent,
    };
  });

  app.post("/api/v1/marketing-consent/withdraw", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    const expectedVersion = expectedAccountContextVersion(request);
    assertEligible(user);
    assertCustomerCapability(user, "account.history.read");
    const body = marketingConsentWithdrawalSchema.parse(request.body);
    const fingerprint = requestFingerprint("marketing-consent.withdraw:v1", {
      policyVersion: MARKETING_CONSENT_POLICY_VERSION,
    });
    const result = await transaction(pool, async (client) => {
      const context = await lockAccountContextForMutation(
        client,
        user,
        expectedVersion,
      );
      assertCustomerCapability(context, "account.history.read");
      const consentEventId = await recordMarketingConsent(client, {
        clientAccountId: user.clientAccountId,
        userId: user.userId,
        granted: false,
        policyVersion: MARKETING_CONSENT_POLICY_VERSION,
        source: "preferences",
        idempotencyKey: body.idempotencyKey,
        requestFingerprint: fingerprint,
      });
      return { consentEventId, granted: false as const };
    });
    setAccountContextHeaders(reply, user);
    return result;
  });
}
