// SPDX-License-Identifier: AGPL-3.0-or-later

import { loadConfig } from "./config.js";
import { createPool, runMigrations, transaction } from "./database.js";

type SeedProduct = {
  id: string;
  group: string;
  en: string;
  zh: string;
  fulfillment: "automatic" | "review" | "manual" | "quote";
  repeatable?: boolean;
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
    monthlyMinor: 300,
    setupMinor: 200,
  },
  {
    id: "hkbgp-cn-vps",
    group: "cloud",
    en: "HKBGP-CN VPS",
    zh: "HKBGP-CN VPS",
    fulfillment: "automatic",
    monthlyMinor: 2_000,
    setupMinor: 200,
  },
  {
    id: "hk-r640-hkbgp",
    group: "dedicated",
    en: "HK-R640 HKBGP Dedicated",
    zh: "HK-R640 HKBGP 独立服务器",
    fulfillment: "manual",
    monthlyMinor: 28_000,
    setupMinor: 1_000,
  },
  {
    id: "hk-r640-hkbgp-cn",
    group: "dedicated",
    en: "HK-R640 HKBGP-CN Dedicated",
    zh: "HK-R640 HKBGP-CN 独立服务器",
    fulfillment: "manual",
    monthlyMinor: 125_000,
    setupMinor: 1_000,
  },
  {
    id: "hkbgp-ip-transit",
    group: "transit",
    en: "HKBGP IP Transit",
    zh: "HKBGP IP Transit",
    fulfillment: "manual",
    monthlyMinor: 3_000,
  },
  {
    id: "hkbgp-cn-ip-transit",
    group: "transit",
    en: "HKBGP-CN IP Transit",
    zh: "HKBGP-CN IP Transit",
    fulfillment: "manual",
    monthlyMinor: 100_000,
  },
  {
    id: "equinix-hk2-colocation",
    group: "colocation",
    en: "Equinix HK2 Colocation",
    zh: "Equinix HK2 机房托管",
    fulfillment: "quote",
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
    repeatable: true,
    oneTimeMinor: 10_000,
  },
  {
    id: "gsl-inbound",
    group: "additional",
    en: "GSL Inbound",
    zh: "GSL Inbound",
    fulfillment: "manual",
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
await runMigrations(pool);

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

  for (const product of products) {
    await client.query(
      `INSERT INTO products(
         id, group_id, names, descriptions, fulfillment_mode, repeatable, option_schema
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         group_id = EXCLUDED.group_id,
         names = EXCLUDED.names,
         descriptions = EXCLUDED.descriptions,
         fulfillment_mode = EXCLUDED.fulfillment_mode,
         repeatable = EXCLUDED.repeatable,
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
        JSON.stringify(product.optionSchema ?? []),
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
