/**
 * Static world definition: one SKU, four channels, one reference price.
 *
 * All money is integer cents. All prices are integer cents. Channels differ in
 * traffic, baseline conversion, price sensitivity and fulfilment cost, which is
 * what makes a single pooled price effect misleading.
 */

export const SKU = {
  id: 'SKU-AURORA-01',
  name: 'Aurora 降噪耳机',
  unitCostCents: 6800,
  referencePriceCents: 12900,
};

export const CHANNELS = [
  {
    id: 'CH-MKT',
    name: 'Marketplace',
    short: 'MKT',
    color: '#2563eb',
    kind: 'marketplace',
    baselineTraffic: 210,
    baseConversion: 0.041,
    priceSensitivity: 1.35,
    priceAnchorCents: 12800,
    fulfilmentCostCents: 620,
    ruleVersion: 'fee-2026.11',
  },
  {
    id: 'CH-WEB',
    name: '品牌官网',
    short: 'WEB',
    color: '#0d9488',
    kind: 'owned',
    baselineTraffic: 130,
    baseConversion: 0.036,
    priceSensitivity: 0.95,
    priceAnchorCents: 13300,
    fulfilmentCostCents: 380,
    ruleVersion: 'web-2026.09',
  },
  {
    id: 'CH-APP',
    name: '移动 App',
    short: 'APP',
    color: '#7c3aed',
    kind: 'owned',
    baselineTraffic: 175,
    baseConversion: 0.047,
    priceSensitivity: 1.1,
    priceAnchorCents: 12500,
    fulfilmentCostCents: 300,
    ruleVersion: 'app-2026.11',
  },
  {
    id: 'CH-OUT',
    name: '奥莱门店',
    short: 'OUT',
    color: '#ea580c',
    kind: 'offline',
    baselineTraffic: 70,
    baseConversion: 0.07,
    priceSensitivity: 1.7,
    priceAnchorCents: 11900,
    fulfilmentCostCents: 540,
    ruleVersion: 'pos-2026.10',
  },
];

export const SEGMENTS = [
  { id: 'SEG-SENS', name: '价格敏感型', share: 0.34, sensitivityMultiplier: 1.9 },
  { id: 'SEG-REG', name: '常规购买者', share: 0.46, sensitivityMultiplier: 1.0 },
  { id: 'SEG-LOYAL', name: '品牌偏好型', share: 0.2, sensitivityMultiplier: 0.35 },
];

export const MAX_DAYS = 28;
export const DAY_HOURS = 6;
export const HOUR_LABELS = ['09:00', '11:00', '13:00', '15:00', '17:00', '19:00'];

export const DEMAND_SCENARIOS = [
  {
    id: 'steady',
    name: '平稳需求',
    note: '基准日需求，用于观察价格弹性与渠道差异。默认库存下后段逐步缺货。',
    trendPerDay: 0.004,
    noise: 1,
    seasonality: [0.92, 1.0, 1.04, 1.08, 1.02, 0.96, 0.9],
  },
  {
    id: 'spike',
    name: '促销脉冲',
    note: '第 9 天出现一次性流量冲击，适合检验缺货截断与不可识别区间。',
    trendPerDay: 0.002,
    noise: 1.1,
    spikes: [{ day: 9, multiplier: 2.4 }],
    seasonality: [0.95, 1.02, 1.0, 1.06, 1.0, 0.93, 0.9],
  },
  {
    id: 'surge',
    name: '连续升温',
    note: '流量逐日抬升，库存会较早耗尽，后段成为不可识别区间。',
    trendPerDay: 0.03,
    noise: 1.15,
    seasonality: [0.9, 1.0, 1.05, 1.1, 1.04, 0.95, 0.88],
  },
  {
    id: 'choppy',
    name: '波动周',
    note: '高频扰动，用于说明小样本下区间估计的脆弱。',
    trendPerDay: 0,
    noise: 1.45,
    seasonality: [0.82, 1.12, 1.22, 0.86, 1.15, 0.95, 0.88],
  },
];

export const DEFAULT_WORLD_CONFIG = {
  seed: 'aurora-11',
  openingUnits: 420,
  returnRate: 0.07,
  holdTtlDays: 2,
  demandScenario: 'steady',
  baseTrafficMultiplier: 1,
  channelOrder: CHANNELS.map((c) => c.id),
  ruleEpoch: 0,
};

export function findChannel(id) {
  return CHANNELS.find((channel) => channel.id === id) || null;
}

export function findScenario(id) {
  return DEMAND_SCENARIOS.find((scenario) => scenario.id === id) || DEMAND_SCENARIOS[0];
}

export function fmt(cents) {
  if (!Number.isFinite(cents)) return '—';
  return `¥${(cents / 100).toFixed(2)}`;
}

export function fmtPct(value, digits = 1) {
  if (!Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
}
