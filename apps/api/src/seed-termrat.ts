// SPDX-License-Identifier: AGPL-3.0-or-later

import { assertRuntimeDatabaseRoleSafe } from "@opensales/core";
import { validateCatalogOptionSchema } from "@opensales/core/commerce";
import { loadConfig } from "./config.js";
import {
  createPool,
  transaction,
} from "./database.js";

type SeedProduct = {
  id: string;
  group: string;
  en: string;
  zh: string;
  descriptionEn?: string;
  descriptionZh?: string;
  fulfillment: "automatic" | "review" | "manual" | "quote";
  overdueAction: "automatic" | "manual" | "none";
  cancellationMode: "self_service" | "authenticated_ticket" | "manual_review" | "disabled";
  cancellationExecutionMode: "automatic" | "manual";
  cancellationMinNoticeHours?: number;
  cancellationRequirementKey?: string;
  overdueDelayMode?: "policy_calendar_days" | "exact_hours";
  overdueDelayValue?: number;
  providerInstallationId?: string;
  repeatable?: boolean;
  hidden?: boolean;
  monthlyMinor?: number;
  setupMinor?: number;
  oneTimeMinor?: number;
  billingCycles?: ReadonlyArray<"monthly" | "quarterly" | "semiannual" | "annual">;
  optionSchema?: unknown[];
};

const groups = [
  ["cloud", 10, { en: "Cloud", "zh-CN": "云服务" }],
  ["dedicated", 20, { en: "Dedicated Servers", "zh-CN": "独立服务器" }],
  ["colocation", 30, { en: "Colocation", "zh-CN": "机房托管" }],
  ["transit", 40, { en: "IP Transit", "zh-CN": "IP Transit" }],
  ["additional", 50, { en: "Additional Purchases", "zh-CN": "附加购买" }],
] as const;

const products: SeedProduct[] = [
  {
    id: "hkbgp-vps",
    group: "cloud",
    en: "HKBGP VPS",
    zh: "HKBGP VPS",
    fulfillment: "automatic",
    overdueAction: "automatic",
    cancellationMode: "self_service",
    cancellationExecutionMode: "automatic",
    providerInstallationId: "mock-provisioning-v1",
    monthlyMinor: 300,
    setupMinor: 200,
  },
  {
    id: "hkbgp-cn-vps",
    group: "cloud",
    en: "HKBGP-CN VPS",
    zh: "HKBGP-CN VPS",
    fulfillment: "automatic",
    overdueAction: "automatic",
    cancellationMode: "self_service",
    cancellationExecutionMode: "automatic",
    providerInstallationId: "mock-provisioning-v1",
    monthlyMinor: 2_000,
    setupMinor: 200,
  },
  {
    id: "hk-r640-hkbgp",
    group: "dedicated",
    en: "HK-R640 HKBGP Dedicated",
    zh: "HK-R640 HKBGP 独立服务器",
    fulfillment: "manual",
    overdueAction: "manual",
    cancellationMode: "self_service",
    cancellationExecutionMode: "manual",
    monthlyMinor: 28_000,
    setupMinor: 1_000,
  },
  {
    id: "hk-r640-hkbgp-cn",
    group: "dedicated",
    en: "HK-R640 HKBGP-CN Dedicated",
    zh: "HK-R640 HKBGP-CN 独立服务器",
    fulfillment: "manual",
    overdueAction: "manual",
    cancellationMode: "self_service",
    cancellationExecutionMode: "manual",
    monthlyMinor: 125_000,
    setupMinor: 1_000,
  },
  {
    id: "hkbgp-ip-transit",
    group: "transit",
    en: "HKBGP IP Transit",
    zh: "HKBGP IP Transit",
    fulfillment: "manual",
    overdueAction: "manual",
    cancellationMode: "self_service",
    cancellationExecutionMode: "manual",
    monthlyMinor: 3_000,
    descriptionEn:
      "Fixed-commit IP Transit. Choose Static Route or post-payment manual BGP. BGP requires a publicly registered ASN; only the purchased Default Route is supplied, never Full Route.",
    descriptionZh:
      "固定 Commit 的 IP Transit。可选择 Static Route，或付款后人工开通 BGP。BGP 仅接受公开注册 ASN；只提供已购买的 Default Route，不提供 Full Route。",
    optionSchema: [
      {
        code: "routing_method",
        type: "select",
        required: true,
        label: { en: "Routing method", "zh-CN": "路由方式" },
        values: [
          { value: "static_route", label: { en: "Static Route", "zh-CN": "静态路由" } },
          {
            value: "manual_bgp",
            label: { en: "Manual BGP after payment", "zh-CN": "付款后人工开通 BGP" },
          },
        ],
      },
      {
        code: "public_asn",
        type: "text",
        required: true,
        minLength: 3,
        maxLength: 15,
        label: { en: "Publicly registered ASN", "zh-CN": "公开注册 ASN" },
        visibleWhen: { code: "routing_method", equals: "manual_bgp" },
      },
      {
        code: "route_scope",
        type: "radio",
        required: true,
        label: { en: "Route scope", "zh-CN": "路由范围" },
        values: [
          {
            value: "default_route_only",
            label: {
              en: "Purchased Default Route only (no Full Route)",
              "zh-CN": "仅提供已购买的 Default Route（不提供 Full Route）",
            },
          },
        ],
      },
    ],
  },
  {
    id: "hkbgp-cn-ip-transit",
    group: "transit",
    en: "HKBGP-CN IP Transit",
    zh: "HKBGP-CN IP Transit",
    fulfillment: "manual",
    overdueAction: "manual",
    cancellationMode: "self_service",
    cancellationExecutionMode: "manual",
    monthlyMinor: 100_000,
    descriptionEn:
      "Fixed-commit IP Transit. Choose Static Route or post-payment manual BGP. BGP requires a publicly registered ASN; only the purchased Default Route is supplied, never Full Route.",
    descriptionZh:
      "固定 Commit 的 IP Transit。可选择 Static Route，或付款后人工开通 BGP。BGP 仅接受公开注册 ASN；只提供已购买的 Default Route，不提供 Full Route。",
    optionSchema: [
      {
        code: "routing_method",
        type: "select",
        required: true,
        label: { en: "Routing method", "zh-CN": "路由方式" },
        values: [
          { value: "static_route", label: { en: "Static Route", "zh-CN": "静态路由" } },
          {
            value: "manual_bgp",
            label: { en: "Manual BGP after payment", "zh-CN": "付款后人工开通 BGP" },
          },
        ],
      },
      {
        code: "public_asn",
        type: "text",
        required: true,
        minLength: 3,
        maxLength: 15,
        label: { en: "Publicly registered ASN", "zh-CN": "公开注册 ASN" },
        visibleWhen: { code: "routing_method", equals: "manual_bgp" },
      },
      {
        code: "route_scope",
        type: "radio",
        required: true,
        label: { en: "Route scope", "zh-CN": "路由范围" },
        values: [
          {
            value: "default_route_only",
            label: {
              en: "Purchased Default Route only (no Full Route)",
              "zh-CN": "仅提供已购买的 Default Route（不提供 Full Route）",
            },
          },
        ],
      },
    ],
  },
  {
    id: "equinix-hk2-colocation",
    group: "colocation",
    en: "Equinix HK2 Colocation",
    zh: "Equinix HK2 机房托管",
    fulfillment: "quote",
    overdueAction: "manual",
    cancellationMode: "authenticated_ticket",
    cancellationExecutionMode: "manual",
    cancellationMinNoticeHours: 72,
    cancellationRequirementKey: "termrat.colocation.termination-ready.v1",
    overdueDelayMode: "exact_hours",
    overdueDelayValue: 72,
    monthlyMinor: 25_000,
    billingCycles: ["monthly"],
    descriptionEn:
      "Quote-required Equinix HK2 colocation, starting at approximately USD 250/month. Customer-initiated cross-connect is free; TermRat-initiated cross-connect is USD 300 one-time plus USD 300/month.",
    descriptionZh:
      "需要报价的 Equinix HK2 托管，起价约 USD 250/月。客户发起的 XC 免费；TermRat 发起的 XC 为 USD 300 一次性加 USD 300/月。",
    optionSchema: [
      {
        code: "space",
        type: "select",
        required: true,
        label: { en: "Rack space", "zh-CN": "机位空间" },
        values: [
          "1U",
          "2U",
          "4U",
          "8U",
          { value: "half_rack", label: { en: "Half Rack", "zh-CN": "半柜" } },
          { value: "full_rack", label: { en: "Full Rack", "zh-CN": "整柜" } },
          {
            value: "over_2U_custom",
            label: { en: "Equipment over 2U — separate quote", "zh-CN": "超过 2U 的设备——单独报价" },
          },
        ],
      },
      {
        code: "power_kva",
        type: "quantity",
        required: true,
        step: 0.5,
        label: { en: "Power (kVA)", "zh-CN": "电力（kVA）" },
        dependencies: {
          "1U": { min: 0.5 },
          "2U": { min: 0.5 },
          "4U": { min: 1 },
          "8U": { min: 1 },
          half_rack: { min: 2 },
          full_rack: { min: 4 },
        },
      },
      {
        code: "custom_equipment_details",
        type: "textarea",
        required: true,
        minLength: 10,
        maxLength: 2000,
        label: { en: "Equipment details for separate quote", "zh-CN": "单独报价所需设备详情" },
        visibleWhen: { code: "space", equals: "over_2U_custom" },
      },
      {
        code: "cross_connect",
        type: "radio",
        required: true,
        label: { en: "Cross-connect", "zh-CN": "交叉连接（XC）" },
        values: [
          { value: "none", label: { en: "No cross-connect", "zh-CN": "不需要 XC" } },
          {
            value: "customer_initiated",
            label: { en: "Customer-initiated XC — no charge", "zh-CN": "客户发起 XC——不收费" },
          },
          {
            value: "termrat_initiated",
            label: {
              en: "TermRat-initiated XC — USD 300 one-time + USD 300/month",
              "zh-CN": "TermRat 发起 XC——USD 300 一次性 + USD 300/月",
            },
            oneTimeMinor: 30_000,
            recurringMinor: 30_000,
          },
        ],
      },
    ],
  },
  {
    id: "remote-hands",
    group: "additional",
    en: "Remote Hands",
    zh: "Remote Hands 现场协助",
    fulfillment: "manual",
    overdueAction: "none",
    cancellationMode: "disabled",
    cancellationExecutionMode: "manual",
    repeatable: true,
    hidden: false,
    oneTimeMinor: 10_000,
    descriptionEn:
      "USD 100 per repeatable request. Each unit covers one clearly described request with a normal scope of up to two hours of on-site work; larger work needs a separate request and approval.",
    descriptionZh:
      "每次可重复购买的请求为 USD 100。每个 unit 对应一个说明清楚的请求，正常范围最多两小时现场工作；更大范围需要单独请求和确认。",
    optionSchema: [
      {
        code: "request_instructions",
        type: "textarea",
        required: true,
        minLength: 10,
        maxLength: 2000,
        label: { en: "Request instructions", "zh-CN": "请求说明" },
      },
      {
        code: "scope",
        type: "radio",
        required: true,
        label: { en: "Normal request scope", "zh-CN": "正常请求范围" },
        values: [
          {
            value: "up_to_two_hours",
            label: { en: "One request, up to two hours on-site", "zh-CN": "一个请求，最多两小时现场工作" },
          },
        ],
      },
    ],
  },
  {
    id: "gsl-inbound",
    group: "additional",
    en: "GSL Inbound",
    zh: "GSL Inbound",
    fulfillment: "manual",
    overdueAction: "manual",
    cancellationMode: "self_service",
    cancellationExecutionMode: "manual",
    monthlyMinor: 0,
    billingCycles: ["monthly"],
    descriptionEn:
      "Fixed-commit GSL Inbound. Minimum 100 Mbps; each unit is 100 Mbps at USD 47/month, fulfilled manually or by a capable Mock Provider.",
    descriptionZh:
      "固定 Commit 的 GSL Inbound。最低 100 Mbps；每个 unit 为 100 Mbps，价格 USD 47/月，由人工或具备能力的 Mock Provider 履约。",
    optionSchema: [
      {
        code: "bandwidth_units",
        type: "quantity",
        required: true,
        label: { en: "100 Mbps units", "zh-CN": "100 Mbps 单位" },
        min: 1,
        step: 1,
        recurringUnitMinor: 4_700,
      },
    ],
  },
];

function cyclePrice(monthlyMinor: number, months: number): number {
  return monthlyMinor * months;
}

for (const product of products) {
  validateCatalogOptionSchema(product.optionSchema ?? []);
}
if (process.argv.includes("--validate-only")) {
  console.log("Synthetic TermRat Catalog configuration is valid.");
  process.exit(0);
}

const config = loadConfig();
if (!config.DATABASE_RUNTIME_ROLE) {
  throw new Error("TermRat seed requires DATABASE_RUNTIME_ROLE");
}
const pool = createPool(config);
await assertRuntimeDatabaseRoleSafe(
  { query: async (text, values) => pool.query(text, values) },
  config.DATABASE_RUNTIME_ROLE,
);

await transaction(pool, async (client) => {
  for (const [id, sortOrder, names] of groups) {
    await client.query(
      `INSERT INTO product_groups(id, sort_order, names)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET sort_order = EXCLUDED.sort_order, names = EXCLUDED.names`,
      [id, sortOrder, names],
    );
  }

  await client.query(
    `INSERT INTO payment_methods(
       code, display_name, provider_installation_id, fee_basis_points, enabled,
       add_funds_enabled, saved_method_enabled, automatic_renewal_enabled
     ) VALUES
       ('card', '{"en":"Card (Mock)","zh-CN":"银行卡（Mock）"}', 'mock-payment-v1', 350, true, true, true, true),
       ('alipay', '{"en":"Alipay (Mock)","zh-CN":"支付宝（Mock）"}', 'mock-payment-v1', 350, true, true, true, true),
       ('usdt', '{"en":"USDT-style asset (Mock)","zh-CN":"USDT 风格资产（Mock）"}', 'mock-payment-v1', 0, true, true, false, false)
     ON CONFLICT (code) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       provider_installation_id = EXCLUDED.provider_installation_id,
       fee_basis_points = EXCLUDED.fee_basis_points,
       enabled = EXCLUDED.enabled,
       add_funds_enabled = EXCLUDED.add_funds_enabled,
       saved_method_enabled = EXCLUDED.saved_method_enabled,
       automatic_renewal_enabled = EXCLUDED.automatic_renewal_enabled,
       updated_at = now()`,
  );

  await client.query(
    `INSERT INTO add_funds_policies(
       currency, enabled, min_principal_minor, max_principal_minor, balance_cap_minor
     ) VALUES ('USD', true, 5000, 500000, 1000000)
     ON CONFLICT (currency) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       min_principal_minor = EXCLUDED.min_principal_minor,
       max_principal_minor = EXCLUDED.max_principal_minor,
       balance_cap_minor = EXCLUDED.balance_cap_minor,
       updated_at = now()`,
  );

  await client.query(
    `INSERT INTO provider_installation_capabilities(
       provider_installation_id, provider_type, enabled, capabilities
     ) VALUES (
       'mock-payment-v1', 'payment', true,
       '["payment_create","payment_reconcile","payment_method_setup","payment_off_session"]'::jsonb
     )
     ON CONFLICT (provider_installation_id) DO NOTHING`,
  );

  await client.query(
    `INSERT INTO provider_installation_capabilities(
       provider_installation_id, provider_type, enabled, capabilities
     ) VALUES (
       'mock-provisioning-v1', 'provisioning', true,
       '["resource_create","resource_reconcile","resource_suspend","resource_resume","resource_terminate","resource.start","resource.stop","resource.reboot"]'::jsonb
     )
     ON CONFLICT (provider_installation_id) DO UPDATE SET
       provider_type = EXCLUDED.provider_type,
       enabled = EXCLUDED.enabled,
       capabilities = EXCLUDED.capabilities,
       version = provider_installation_capabilities.version + 1,
       updated_at = now()
     WHERE provider_installation_capabilities.provider_type IS DISTINCT FROM EXCLUDED.provider_type
        OR provider_installation_capabilities.enabled IS DISTINCT FROM EXCLUDED.enabled
        OR provider_installation_capabilities.capabilities IS DISTINCT FROM EXCLUDED.capabilities`,
  );

  await client.query(
    `UPDATE billing_automation_policies
     SET late_fee_enabled = true,
         late_fee_days = 5,
         late_fee_basis_points = 1000,
         overdue_suspension_enabled = true,
         overdue_suspension_days = 5,
         updated_at = now()
     WHERE id = 'default'
       AND (
         NOT late_fee_enabled
         OR late_fee_days <> 5
         OR late_fee_basis_points <> 1000
         OR NOT overdue_suspension_enabled
         OR overdue_suspension_days <> 5
       )`,
  );

  for (const product of products) {
    await client.query(
      `INSERT INTO products(
         id, group_id, names, descriptions, fulfillment_mode, repeatable, hidden, option_schema
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         group_id = EXCLUDED.group_id,
         names = EXCLUDED.names,
         descriptions = EXCLUDED.descriptions,
         fulfillment_mode = EXCLUDED.fulfillment_mode,
         repeatable = EXCLUDED.repeatable,
         hidden = EXCLUDED.hidden,
         option_schema = EXCLUDED.option_schema,
         updated_at = now()`,
      [
        product.id,
        product.group,
        { en: product.en, "zh-CN": product.zh },
        {
          en:
            product.descriptionEn ??
            `${product.en} — synthetic TermRat laboratory configuration.`,
          "zh-CN":
            product.descriptionZh ??
            `${product.zh} — TermRat 合成实验室配置。`,
        },
        product.fulfillment,
        product.repeatable ?? false,
        product.hidden ?? false,
        JSON.stringify(product.optionSchema ?? []),
      ],
    );

    await client.query(
      `INSERT INTO catalog_product_revisions(
         product_id, revision, group_id, names, descriptions, fulfillment_mode,
         active, hidden, repeatable, option_schema
       )
       SELECT
         current_product.id,
         COALESCE((
           SELECT pg_catalog.max(existing.revision) + 1
           FROM catalog_product_revisions existing
           WHERE existing.product_id = current_product.id
         ), 1),
         current_product.group_id,
         current_product.names,
         current_product.descriptions,
         current_product.fulfillment_mode,
         current_product.active,
         current_product.hidden,
         current_product.repeatable,
         current_product.option_schema
       FROM products current_product
       WHERE current_product.id = $1
         AND NOT EXISTS (
           SELECT 1
           FROM catalog_product_revisions latest
           WHERE latest.id = (
             SELECT candidate.id
             FROM catalog_product_revisions candidate
             WHERE candidate.product_id = current_product.id
             ORDER BY candidate.revision DESC
             LIMIT 1
           )
             AND latest.group_id = current_product.group_id
             AND latest.names = current_product.names
             AND latest.descriptions = current_product.descriptions
             AND latest.fulfillment_mode = current_product.fulfillment_mode
             AND latest.active = current_product.active
             AND latest.hidden = current_product.hidden
             AND latest.repeatable = current_product.repeatable
             AND latest.option_schema = current_product.option_schema
         )`,
      [product.id],
    );

    await client.query(
      `INSERT INTO product_service_automation_policies(
         product_id, overdue_action, provider_installation_id,
         overdue_delay_mode, overdue_delay_value,
         cycle_end_cancellation_mode,
         cycle_end_cancellation_execution_mode,
         cycle_end_cancellation_min_notice_hours,
         cycle_end_cancellation_requirement_key
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (product_id) DO UPDATE SET
         overdue_action = EXCLUDED.overdue_action,
         provider_installation_id = EXCLUDED.provider_installation_id,
         overdue_delay_mode = EXCLUDED.overdue_delay_mode,
         overdue_delay_value = EXCLUDED.overdue_delay_value,
         cycle_end_cancellation_mode = EXCLUDED.cycle_end_cancellation_mode,
         cycle_end_cancellation_execution_mode = EXCLUDED.cycle_end_cancellation_execution_mode,
         cycle_end_cancellation_min_notice_hours = EXCLUDED.cycle_end_cancellation_min_notice_hours,
         cycle_end_cancellation_requirement_key = EXCLUDED.cycle_end_cancellation_requirement_key,
         version = product_service_automation_policies.version + 1,
         updated_at = now()
       WHERE product_service_automation_policies.overdue_action IS DISTINCT FROM EXCLUDED.overdue_action
          OR product_service_automation_policies.provider_installation_id
               IS DISTINCT FROM EXCLUDED.provider_installation_id
          OR product_service_automation_policies.overdue_delay_mode
               IS DISTINCT FROM EXCLUDED.overdue_delay_mode
          OR product_service_automation_policies.overdue_delay_value
               IS DISTINCT FROM EXCLUDED.overdue_delay_value
          OR product_service_automation_policies.cycle_end_cancellation_mode
               IS DISTINCT FROM EXCLUDED.cycle_end_cancellation_mode
          OR product_service_automation_policies.cycle_end_cancellation_execution_mode
               IS DISTINCT FROM EXCLUDED.cycle_end_cancellation_execution_mode
          OR product_service_automation_policies.cycle_end_cancellation_min_notice_hours
               IS DISTINCT FROM EXCLUDED.cycle_end_cancellation_min_notice_hours
          OR product_service_automation_policies.cycle_end_cancellation_requirement_key
               IS DISTINCT FROM EXCLUDED.cycle_end_cancellation_requirement_key`,
      [
        product.id,
        product.overdueAction,
        product.providerInstallationId ?? null,
        product.overdueDelayMode ?? "policy_calendar_days",
        product.overdueDelayValue ?? 5,
        product.cancellationMode,
        product.cancellationExecutionMode,
        product.cancellationMinNoticeHours ?? 0,
        product.cancellationRequirementKey ?? null,
      ],
    );

    const recurringCycleMonths = {
      monthly: 1,
      quarterly: 3,
      semiannual: 6,
      annual: 12,
    } as const;
    const prices =
      product.oneTimeMinor !== undefined
        ? [["one_time", product.oneTimeMinor, 0, 0]]
        : (product.billingCycles ?? ["monthly", "quarterly", "semiannual", "annual"]).map(
            (cycle) => [
              cycle,
              0,
              product.setupMinor ?? 0,
              cyclePrice(product.monthlyMinor ?? 0, recurringCycleMonths[cycle]),
            ],
          );

    for (const [cycle, oneTime, setup, recurring] of prices) {
      const currentPrice = await client.query<{
        id: string;
        revision: number;
        catalog_product_revision_id: string;
        one_time_minor: string;
        setup_minor: string;
        recurring_minor: string;
      }>(
        `SELECT id, revision, catalog_product_revision_id,
                one_time_minor::text, setup_minor::text, recurring_minor::text
         FROM product_prices
         WHERE product_id = $1 AND currency = 'USD' AND billing_cycle = $2
           AND active
           AND valid_from <= pg_catalog.transaction_timestamp()
           AND (valid_until IS NULL OR valid_until > pg_catalog.transaction_timestamp())
         ORDER BY revision DESC
         LIMIT 1
         FOR UPDATE`,
        [product.id, cycle],
      );
      const catalogRevision = await client.query<{ id: string }>(
        `SELECT id
         FROM catalog_product_revisions
         WHERE product_id = $1
         ORDER BY revision DESC
         LIMIT 1
         FOR SHARE`,
        [product.id],
      );
      const catalogRevisionId = catalogRevision.rows[0]?.id;
      if (!catalogRevisionId) throw new Error(`Product ${product.id} has no Catalog revision`);
      const previous = currentPrice.rows[0];
      const unchanged =
        previous?.catalog_product_revision_id === catalogRevisionId &&
        previous.one_time_minor === String(oneTime) &&
        previous.setup_minor === String(setup) &&
        previous.recurring_minor === String(recurring);
      if (!unchanged) {
        if (previous) {
          await client.query(
            `UPDATE product_prices
             SET active = false,
                 valid_until = COALESCE(valid_until, pg_catalog.transaction_timestamp())
             WHERE id = $1`,
            [previous.id],
          );
        }
        const latestRevision = await client.query<{ revision: number }>(
          `SELECT revision
           FROM product_prices
           WHERE product_id = $1 AND billing_cycle = $2
           ORDER BY revision DESC
           LIMIT 1`,
          [product.id, cycle],
        );
        await client.query(
          `INSERT INTO product_prices(
             product_id, catalog_product_revision_id, revision, currency,
             billing_cycle, one_time_minor, setup_minor, recurring_minor
           ) VALUES ($1, $2, $3, 'USD', $4, $5, $6, $7)`,
          [
            product.id,
            catalogRevisionId,
            (latestRevision.rows[0]?.revision ?? 0) + 1,
            cycle,
            oneTime,
            setup,
            recurring,
          ],
        );
      }
    }

    await client.query(
      `UPDATE product_prices
       SET active = false,
           valid_until = COALESCE(valid_until, pg_catalog.transaction_timestamp())
       WHERE product_id = $1
         AND active
         AND NOT (billing_cycle = ANY($2::text[]))`,
      [product.id, prices.map(([cycle]) => cycle)],
    );
  }
});

await pool.end();
console.log("Synthetic TermRat laboratory configuration seeded.");
