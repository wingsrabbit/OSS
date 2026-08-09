// SPDX-License-Identifier: AGPL-3.0-or-later

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
    monthlyMinor: 0,
    optionSchema: [
      {
        code: "space",
        type: "select",
        required: true,
        values: ["1U", "2U", "4U", "8U", "half_rack", "full_rack", "over_2U_custom"],
      },
      {
        code: "power_kva",
        type: "quantity",
        required: true,
        dependencies: {
          "1U": { min: 0.5 },
          "2U": { min: 0.5 },
          "4U": { min: 1 },
          "8U": { min: 1 },
          half_rack: { min: 2 },
          full_rack: { min: 4 },
        },
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
    hidden: true,
    oneTimeMinor: 10_000,
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
    optionSchema: [
      {
        code: "bandwidth_units",
        type: "quantity",
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

const config = loadConfig();
const pool = createPool(config);

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
    `INSERT INTO legal_documents(kind, locale, version, title, body)
     VALUES
       ('terms', 'en', 'lab-2026-07-29', 'Laboratory Terms', 'Synthetic laboratory terms. No real service is sold.'),
       ('aup', 'en', 'lab-2026-07-29', 'Laboratory Acceptable Use Policy', 'Synthetic laboratory AUP. Mock providers only.'),
       ('privacy', 'en', 'lab-2026-07-29', 'Laboratory Privacy Policy', 'Only synthetic laboratory data is permitted.'),
       ('terms', 'zh-CN', 'lab-2026-07-29', '实验室服务条款', '仅用于合成数据实验，不销售真实服务。'),
       ('aup', 'zh-CN', 'lab-2026-07-29', '实验室可接受使用政策', '仅限 Mock Provider 实验室。'),
       ('privacy', 'zh-CN', 'lab-2026-07-29', '实验室隐私政策', '仅允许使用合成实验数据。')
     ON CONFLICT (kind, locale, version) DO NOTHING`,
  );

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
       '["resource_create","resource_reconcile","resource_suspend","resource_resume","resource_terminate"]'::jsonb
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
          en: `${product.en} — synthetic TermRat laboratory configuration.`,
          "zh-CN": `${product.zh} — TermRat 合成实验室配置。`,
        },
        product.fulfillment,
        product.repeatable ?? false,
        product.hidden ?? false,
        JSON.stringify(product.optionSchema ?? []),
      ],
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

    const prices =
      product.oneTimeMinor !== undefined
        ? [["one_time", product.oneTimeMinor, 0, 0]]
        : [
            ["monthly", 0, product.setupMinor ?? 0, product.monthlyMinor ?? 0],
            ["quarterly", 0, product.setupMinor ?? 0, cyclePrice(product.monthlyMinor ?? 0, 3)],
            ["semiannual", 0, product.setupMinor ?? 0, cyclePrice(product.monthlyMinor ?? 0, 6)],
            ["annual", 0, product.setupMinor ?? 0, cyclePrice(product.monthlyMinor ?? 0, 12)],
          ];

    for (const [cycle, oneTime, setup, recurring] of prices) {
      await client.query(
        `INSERT INTO product_prices(
           product_id, revision, currency, billing_cycle, one_time_minor, setup_minor, recurring_minor
         ) VALUES ($1, 1, 'USD', $2, $3, $4, $5)
         ON CONFLICT (product_id, revision, billing_cycle) DO UPDATE SET
           one_time_minor = EXCLUDED.one_time_minor,
           setup_minor = EXCLUDED.setup_minor,
           recurring_minor = EXCLUDED.recurring_minor`,
        [product.id, cycle, oneTime, setup, recurring],
      );
    }
  }
});

await pool.end();
console.log("Synthetic TermRat laboratory configuration seeded.");
