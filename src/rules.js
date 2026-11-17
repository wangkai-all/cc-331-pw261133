/**
 * Rulebooks.
 *
 * A plan is always checked against the rulebook that is current at
 * confirmation time, not the one that existed when the draft was created.
 * Bumping the epoch is how the replay shows a platform fee change invalidating
 * a stale draft.
 */

import { CHANNELS, SKU } from './world.js';

export const RULE_EPOCHS = [
  {
    epoch: 0,
    label: '2026.11-A',
    name: '常规费率',
    note: '平台履约费基准，参考价折扣上限 28%。',
    feeDeltaCents: 0,
    maxDiscountPct: 28,
  },
  {
    epoch: 1,
    label: '2026.12-B',
    name: '平台费率上调',
    note: 'Marketplace 履约费上调 ¥2.00，折扣上限收紧到 24%。',
    feeDeltaCents: 200,
    maxDiscountPct: 24,
  },
];

export function ruleEpochInfo(epoch = 0) {
  return RULE_EPOCHS.find((r) => r.epoch === epoch) || RULE_EPOCHS[0];
}

export function buildRulebook(epoch = 0) {
  const info = ruleEpochInfo(epoch);
  const rules = {};
  for (const channel of CHANNELS) {
    const feeDelta = channel.kind === 'marketplace' ? info.feeDeltaCents : 0;
    const fee = channel.fulfilmentCostCents + feeDelta;
    const floorCents = Math.round((SKU.referencePriceCents * (100 - info.maxDiscountPct)) / 100 / 100) * 100;
    rules[channel.id] = {
      channelId: channel.id,
      ruleVersion: `${channel.ruleVersion}#r${epoch}`,
      ruleLabel: info.label,
      epoch,
      floorCents,
      ceilingCents: 15900,
      anchorCents: channel.priceAnchorCents,
      feeCents: fee,
      maxDiscountPct: info.maxDiscountPct,
      unitCostCents: SKU.unitCostCents,
      minMarginCents: 1200,
    };
  }
  return rules;
}

export function ruleVersionsOf(rulebook) {
  return Object.fromEntries(Object.entries(rulebook).map(([id, r]) => [id, r.ruleVersion]));
}

export function ruleVersionsMatch(planVersions, rulebook) {
  if (!planVersions) return false;
  return Object.entries(rulebook).every(([id, r]) => planVersions[id] === r.ruleVersion);
}

export function ruleDiff(planVersions, rulebook) {
  const diffs = [];
  for (const [id, r] of Object.entries(rulebook)) {
    const before = planVersions?.[id] ?? '未记录';
    if (before !== r.ruleVersion) {
      diffs.push({ channelId: id, before, after: r.ruleVersion });
    }
  }
  return diffs;
}
