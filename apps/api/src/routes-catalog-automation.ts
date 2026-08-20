// SPDX-License-Identifier: AGPL-3.0-or-later

import { LAB_BANNER, type FulfillmentMode } from "@opensales/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assertIdentityReadEligible,
  lockSessionIdentityForMutation,
  requireSessionIdentity,
  type SessionIdentity,
} from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabaseClient, type DatabasePool } from "./database.js";
import { requireStaffPermission } from "./routes-admin.js";

const MOCK_PROVISIONING_INSTALLATION_ID = "mock-provisioning-v1" as const;
const REQUIRED_PROVISIONING_CAPABILITIES = [
  "resource_create",
  "resource_reconcile",
] as const;

const productIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{1,79}$/);

const policyUpdateSchema = z
  .object({
    automationMode: z.enum(["provider", "manual"]),
    providerInstallationId: z.literal(MOCK_PROVISIONING_INSTALLATION_ID).nullable(),
    expectedVersion: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((body, context) => {
    if (
      (body.automationMode === "provider") !==
      (body.providerInstallationId === MOCK_PROVISIONING_INSTALLATION_ID)
    ) {
      context.addIssue({
        code: "custom",
        path: ["providerInstallationId"],
        message:
          "provider mode requires mock-provisioning-v1; manual mode requires an explicit null",
      });
    }
  });

type ProductPolicyRow = Readonly<{
  product_id: string;
  fulfillment_mode: FulfillmentMode;
  active: boolean;
  hidden: boolean;
  overdue_action: "automatic" | "manual" | "none" | null;
  provider_installation_id: string | null;
  policy_version: number | null;
  policy_updated_at: Date | null;
  provider_type: string | null;
  provider_enabled: boolean | null;
  provider_capabilities: unknown;
  provider_version: number | null;
}>;

function catalogPolicyError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

function exactStringList(value: unknown): readonly string[] | null {
  return Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "string" && entry.length > 0 && entry.trim() === entry,
    )
    ? value
    : null;
}

function capabilityView(row: ProductPolicyRow): Readonly<{
  capabilitySnapshot: readonly string[];
  requiredCapabilities: typeof REQUIRED_PROVISIONING_CAPABILITIES;
  missingCapabilities: readonly string[];
  providerVersion: number | null;
  providerEnabled: boolean | null;
  providerReady: boolean;
}> {
  const capabilities = exactStringList(row.provider_capabilities) ?? [];
  const missingCapabilities = REQUIRED_PROVISIONING_CAPABILITIES.filter(
    (capability) => !capabilities.includes(capability),
  );
  const providerReady =
    row.provider_installation_id === MOCK_PROVISIONING_INSTALLATION_ID &&
    row.provider_type === "provisioning" &&
    row.provider_enabled === true &&
    exactStringList(row.provider_capabilities) !== null &&
    missingCapabilities.length === 0;
  return {
    capabilitySnapshot: capabilities,
    requiredCapabilities: REQUIRED_PROVISIONING_CAPABILITIES,
    missingCapabilities,
    providerVersion: row.provider_version,
    providerEnabled: row.provider_enabled,
    providerReady,
  };
}

function policyView(row: ProductPolicyRow, changed?: boolean): Record<string, unknown> {
  return {
    warning: LAB_BANNER,
    productId: row.product_id,
    fulfillmentMode: row.fulfillment_mode,
    productActive: row.active,
    productHidden: row.hidden,
    configured: row.policy_version !== null,
    automationMode: row.provider_installation_id === null ? "manual" : "provider",
    providerInstallationId: row.provider_installation_id,
    policyVersion: row.policy_version,
    overdueAction: row.overdue_action,
    updatedAt: row.policy_updated_at?.toISOString() ?? null,
    ...capabilityView(row),
    ...(changed === undefined ? {} : { changed }),
  };
}

async function loadProductPolicy(
  client: Pick<DatabaseClient, "query">,
  productId: string,
): Promise<ProductPolicyRow | null> {
  const result = await client.query<ProductPolicyRow>(
    `SELECT
       product.id AS product_id,
       product.fulfillment_mode,
       product.active,
       product.hidden,
       policy.overdue_action,
       policy.provider_installation_id,
       policy.version AS policy_version,
       policy.updated_at AS policy_updated_at,
       provider.provider_type,
       provider.enabled AS provider_enabled,
       provider.capabilities AS provider_capabilities,
       provider.version AS provider_version
     FROM products product
     LEFT JOIN product_service_automation_policies policy
       ON policy.product_id = product.id
     LEFT JOIN provider_installation_capabilities provider
       ON provider.provider_installation_id = policy.provider_installation_id
     WHERE product.id = $1`,
    [productId],
  );
  return result.rows[0] ?? null;
}

async function requireCatalogManageLocked(
  client: DatabaseClient,
  identity: SessionIdentity,
): Promise<void> {
  const lockedIdentity = await lockSessionIdentityForMutation(client, identity);
  assertIdentityReadEligible(lockedIdentity);
  const result = await client.query<{ permissions: unknown }>(
    `SELECT permissions
     FROM staff_members
     WHERE user_id = $1 AND active
     FOR UPDATE`,
    [identity.userId],
  );
  const permissions = exactStringList(result.rows[0]?.permissions);
  if (
    permissions === null ||
    (!permissions.includes("*") && !permissions.includes("catalog.manage"))
  ) {
    throw catalogPolicyError(
      "Staff permission catalog.manage is required",
      403,
      "STAFF_PERMISSION_REQUIRED",
    );
  }
}

function assertPolicyAppliesToProduct(row: ProductPolicyRow): void {
  if (row.fulfillment_mode !== "automatic" && row.fulfillment_mode !== "review") {
    throw catalogPolicyError(
      "Provider automation policy is available only for Automatic or Review products",
      409,
      "PRODUCT_AUTOMATION_POLICY_NOT_APPLICABLE",
    );
  }
}

export async function registerCatalogAutomationRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get(
    "/api/v1/admin/catalog/products/:productId/automation-policy",
    async (request, reply) => {
      const identity = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, identity, "catalog.manage");
      const params = z.object({ productId: productIdSchema }).parse(request.params);
      const policy = await loadProductPolicy(pool, params.productId);
      if (!policy) {
        return reply.code(404).send({
          error: "Product not found",
          code: "PRODUCT_NOT_FOUND",
        });
      }
      assertPolicyAppliesToProduct(policy);
      return policyView(policy);
    },
  );

  app.put(
    "/api/v1/admin/catalog/products/:productId/automation-policy",
    async (request) => {
      const identity = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, identity, "catalog.manage");
      const params = z.object({ productId: productIdSchema }).parse(request.params);
      const body = policyUpdateSchema.parse(request.body);

      return transaction(pool, async (client) => {
        await requireCatalogManageLocked(client, identity);
        await client.query(
          "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
          [`catalog:automation-policy:${params.productId}`],
        );
        const productResult = await client.query<{
          id: string;
          fulfillment_mode: FulfillmentMode;
        }>(
          `SELECT id, fulfillment_mode
           FROM products
           WHERE id = $1
           FOR UPDATE`,
          [params.productId],
        );
        const product = productResult.rows[0];
        if (!product) {
          throw catalogPolicyError("Product not found", 404, "PRODUCT_NOT_FOUND");
        }
        if (product.fulfillment_mode !== "automatic" && product.fulfillment_mode !== "review") {
          throw catalogPolicyError(
            "Provider automation policy is available only for Automatic or Review products",
            409,
            "PRODUCT_AUTOMATION_POLICY_NOT_APPLICABLE",
          );
        }

        const existingResult = await client.query<{
          overdue_action: "automatic" | "manual" | "none";
          provider_installation_id: string | null;
          version: number;
        }>(
          `SELECT overdue_action, provider_installation_id, version
           FROM product_service_automation_policies
           WHERE product_id = $1
           FOR UPDATE`,
          [params.productId],
        );
        const existing = existingResult.rows[0] ?? null;
        if (body.expectedVersion !== (existing?.version ?? null)) {
          throw catalogPolicyError(
            "Product automation policy changed; reload it before saving",
            409,
            "AUTOMATION_POLICY_VERSION_CONFLICT",
          );
        }

        let capabilitySnapshot: readonly string[] = [];
        let providerVersion: number | null = null;
        if (body.providerInstallationId !== null) {
          const providerResult = await client.query<{
            provider_type: string;
            enabled: boolean;
            capabilities: unknown;
            version: number;
          }>(
            `SELECT provider_type, enabled, capabilities, version
             FROM provider_installation_capabilities
             WHERE provider_installation_id = $1
             FOR SHARE`,
            [body.providerInstallationId],
          );
          const provider = providerResult.rows[0];
          const capabilities = exactStringList(provider?.capabilities);
          if (
            !provider ||
            provider.provider_type !== "provisioning" ||
            !provider.enabled ||
            capabilities === null ||
            !REQUIRED_PROVISIONING_CAPABILITIES.every((capability) =>
              capabilities.includes(capability),
            )
          ) {
            throw catalogPolicyError(
              "Mock Provisioning Provider is disabled or lacks required provisioning capabilities",
              409,
              "PROVISIONING_PROVIDER_UNAVAILABLE",
            );
          }
          capabilitySnapshot = capabilities;
          providerVersion = provider.version;
        }

        const nextOverdueAction =
          body.providerInstallationId === null && existing?.overdue_action === "automatic"
            ? "manual"
            : (existing?.overdue_action ?? "manual");
        const changed =
          existing === null ||
          existing.provider_installation_id !== body.providerInstallationId ||
          existing.overdue_action !== nextOverdueAction;

        const saved = await client.query<{ version: number; updated_at: Date }>(
          `INSERT INTO product_service_automation_policies(
             product_id, overdue_action, provider_installation_id
           ) VALUES ($1, $2, $3)
           ON CONFLICT (product_id) DO UPDATE SET
             overdue_action = EXCLUDED.overdue_action,
             provider_installation_id = EXCLUDED.provider_installation_id,
             version = product_service_automation_policies.version + 1,
             updated_at = pg_catalog.clock_timestamp()
           WHERE product_service_automation_policies.overdue_action
                   IS DISTINCT FROM EXCLUDED.overdue_action
              OR product_service_automation_policies.provider_installation_id
                   IS DISTINCT FROM EXCLUDED.provider_installation_id
           RETURNING version, updated_at`,
          [params.productId, nextOverdueAction, body.providerInstallationId],
        );
        const savedVersion = saved.rows[0]?.version ?? existing?.version;
        if (!savedVersion) throw new Error("Unable to save Product automation policy");

        if (changed) {
          await client.query(
            `INSERT INTO audit_events(
               actor_type, actor_id, action, target_type, target_id, metadata
             ) VALUES (
               'staff', $1, 'catalog.product_automation_policy_updated',
               'product', $2, $3
             )`,
            [
              identity.userId,
              params.productId,
              {
                previousProviderInstallationId:
                  existing?.provider_installation_id ?? null,
                providerInstallationId: body.providerInstallationId,
                automationMode: body.automationMode,
                policyVersion: savedVersion,
                providerVersion,
                capabilitySnapshot,
              },
            ],
          );
        }

        const policy = await loadProductPolicy(client, params.productId);
        if (!policy) throw new Error("Saved Product automation policy disappeared");
        return policyView(policy, changed);
      });
    },
  );
}
