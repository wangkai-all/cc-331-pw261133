/**
 * Price plan lifecycle.
 *
 * draft ──confirm──▶ confirmed ──apply──▶ active ──(next plan applied)──▶ superseded
 *
 * Editing is only possible in draft. Confirmation freezes a rule snapshot and
 * records a stock claim against the shared pool. A confirmed plan can be
 * applied; once a newer plan is applied every older active plan is superseded
 * and can never be applied again. A rulebook change makes existing
 * confirmations stale: applying them is refused until they are re-confirmed
 * against the new rule versions.
 */

import { CHANNELS, SKU, findChannel, fmt } from './world.js';
import { ruleDiff, ruleVersionsOf } from './rules.js';

export const PLAN_STATUS = {
  DRAFT: 'draft',
  CONFIRMED: 'confirmed',
  ACTIVE: 'active',
  SUPERSEDED: 'superseded',
};

export const PLAN_STATUS_LABEL = {
  draft: '草稿',
  confirmed: '已确认',
  active: '生效中',
  superseded: '已被取代',
};

export const MIN_BUFFER_UNITS = 40;

let planSeq = 0;

export function resetPlanSeq(value = 0) {
  planSeq = value;
}

export function nextPlanId() {
  planSeq += 1;
  return `PLAN-${String(planSeq).padStart(3, '0')}`;
}

export function planIdFor(n) {
  return `PLAN-${String(n).padStart(3, '0')}`;
}

export function createPlan({ name, prices, note = '', author = 'operator', createdAtTick = 0, id = null }) {
  const normalized = {};
  for (const channel of CHANNELS) {
    const price = Number(prices?.[channel.id]);
    normalized[channel.id] = Number.isFinite(price) ? Math.round(price) : channel.priceAnchorCents;
  }
  const resolvedId = id || nextPlanId();
  return {
    id: resolvedId,
    name: name || `方案 ${resolvedId}`,
    note,
    author,
    status: PLAN_STATUS.DRAFT,
    prices: normalized,
    rulesSnapshot: null,
    confirmation: null,
    createdAtTick,
    confirmedAtTick: null,
    appliedAtTick: null,
    supersededAtTick: null,
    supersededBy: null,
    revision: 1,
    edits: [],
  };
}

export function editPlan(plan, patch, { tick = 0, author = 'operator' } = {}) {
  if (plan.status !== PLAN_STATUS.DRAFT) {
    return { ok: false, error: '只有草稿方案可以修改价格；已确认、生效中或已被取代的方案已冻结。' };
  }
  const nextPrices = { ...plan.prices };
  let changed = false;
  for (const channel of CHANNELS) {
    if (patch?.prices && Object.prototype.hasOwnProperty.call(patch.prices, channel.id)) {
      const raw = Number(patch.prices[channel.id]);
      if (!Number.isFinite(raw)) continue;
      const value = Math.round(raw);
      if (value !== nextPrices[channel.id]) {
        nextPrices[channel.id] = value;
        changed = true;
      }
    }
  }
  if (typeof patch?.name === 'string' && patch.name.trim() && patch.name.trim() !== plan.name) {
    plan.name = patch.name.trim();
    changed = true;
  }
  if (typeof patch?.note === 'string' && patch.note !== plan.note) {
    plan.note = patch.note;
    changed = true;
  }
  if (changed) {
    plan.prices = nextPrices;
    plan.revision += 1;
    plan.edits.push({ tick, author, prices: { ...nextPrices } });
  }
  return { ok: true, changed, plan };
}

export function rulesSnapshotFor(plan, rulebook) {
  const rules = {};
  for (const channel of CHANNELS) {
    const rule = rulebook[channel.id];
    rules[channel.id] = {
      channelId: channel.id,
      ruleVersion: rule.ruleVersion,
      ruleLabel: rule.ruleLabel,
      epoch: rule.epoch,
      floorCents: rule.floorCents,
      ceilingCents: rule.ceilingCents,
      anchorCents: rule.anchorCents,
      feeCents: rule.feeCents,
      maxDiscountPct: rule.maxDiscountPct,
      unitCostCents: rule.unitCostCents,
      minMarginCents: rule.minMarginCents,
      priceCents: plan.prices[channel.id],
    };
  }
  return rules;
}

/**
 * Confirmation preflight.
 *
 * @param plan           the draft to check
 * @param rulebook       rules currently in force (not the ones the draft saw)
 * @param inventory      Inventory instance (for shared stock)
 * @param claims         active claims from other plans
 * @param bufferUnits    units that must remain unclaimed for live trading
 * @param expectedRevision / expectedPrices  what the operator was looking at
 */
export function validatePlan(
  plan,
  {
    rulebook,
    inventory = null,
    claims = [],
    bufferUnits = MIN_BUFFER_UNITS,
    expectedPrices = null,
    expectedRevision = null,
    claimUnits = null,
  } = {},
) {
  const findings = [];
  const blockers = [];
  const add = (level, code, message, channelId = null) => {
    const finding = { level, code, channelId, message };
    findings.push(finding);
    if (level === 'blocker') blockers.push(finding);
  };

  if (plan.status === PLAN_STATUS.SUPERSEDED) {
    add('blocker', 'superseded', `方案 ${plan.id} 已被 ${plan.supersededBy || '新方案'} 取代，不能重新上线。`);
  } else if (plan.status !== PLAN_STATUS.DRAFT && plan.status !== PLAN_STATUS.CONFIRMED) {
    add('blocker', 'bad_status', '只有草稿或已确认方案可以执行确认。');
  }
  if (expectedRevision != null && expectedRevision !== plan.revision) {
    add(
      'blocker',
      'stale_revision',
      `方案在你查看后已被修改（版本 ${expectedRevision} → ${plan.revision}），请刷新后重新试算。`,
    );
  }
  if (expectedPrices) {
    const changed = CHANNELS.filter((c) => Number(expectedPrices[c.id]) !== plan.prices[c.id]).map(
      (c) => c.name,
    );
    if (changed.length) {
      add('blocker', 'stale_prices', `待确认价格与当前草稿不一致：${changed.join('、')}。`);
    }
  }

  for (const channel of CHANNELS) {
    const price = plan.prices[channel.id];
    const rule = rulebook[channel.id];
    if (!Number.isFinite(price)) {
      add('blocker', 'missing_price', `${channel.name} 缺少价格。`, channel.id);
      continue;
    }
    if (price < rule.floorCents) {
      add(
        'blocker',
        'below_floor',
        `${channel.name} ${fmt(price)} 低于规则下限 ${fmt(rule.floorCents)}（折扣上限 ${rule.maxDiscountPct}%）。`,
        channel.id,
      );
    }
    if (price > rule.ceilingCents) {
      add(
        'blocker',
        'above_ceiling',
        `${channel.name} ${fmt(price)} 高于规则上限 ${fmt(rule.ceilingCents)}。`,
        channel.id,
      );
    }
    const margin = price - rule.unitCostCents - rule.feeCents;
    if (margin < rule.minMarginCents) {
      add(
        'blocker',
        'margin_floor',
        `${channel.name} 单件净贡献 ${fmt(margin)} 低于最低要求 ${fmt(rule.minMarginCents)}（履约费 ${fmt(rule.feeCents)}）。`,
        channel.id,
      );
    }
  }

  const units = claimUnits ?? plan.claimUnits ?? 0;
  if (inventory) {
    const snapshot = inventory.snapshot();
    const free = snapshot.available - otherClaimUnits(claims, plan.id);
    if (snapshot.onHand <= 0) {
      add('blocker', 'no_stock', '共享库存为 0，确认后不会有任何曝光进入成交。');
    }
    if (units > free) {
      add(
        'blocker',
        'claim_exceeds_free_stock',
        `方案需要预留 ${units} 件，但扣除其他已确认方案后只剩 ${Math.max(0, free)} 件。`,
      );
    } else if (free - units < bufferUnits) {
      add(
        'warning',
        'thin_buffer',
        `确认后未承诺库存约 ${Math.max(0, free - units)} 件，低于建议保留的 ${bufferUnits} 件；低价渠道可能很快截断观察。`,
      );
    }
  }
  if (plan.confirmation && ruleDiff(ruleVersionsOf(plan.rulesSnapshot || {}), rulebook).length) {
    add('warning', 'rules_stale', '规则版本已变化，本次确认会重新冻结规则快照。');
  }
  if (plan.edits.length === 0) {
    add('warning', 'untouched_draft', '该草稿从未改过价，与参考价基线完全相同。');
  }
  const duplicate = null; // duplicate detection needs all plans; the session adds it.
  return { ok: blockers.length === 0, findings, blockers, duplicate };
}

export function otherClaimUnits(claims, planId) {
  return claims
    .filter((c) => c.planId !== planId && c.releasedAtTick == null)
    .reduce((sum, c) => sum + c.units, 0);
}

export function confirmPlan(plan, { nowTick, rulesSnapshot, claimUnits = 0, claimId = null }) {
  const versions = ruleVersionsOf(rulesSnapshot);
  return {
    ...plan,
    status: PLAN_STATUS.CONFIRMED,
    confirmedAtTick: nowTick,
    rulesSnapshot,
    claimUnits,
    confirmation: {
      tick: nowTick,
      revision: plan.revision,
      prices: { ...plan.prices },
      ruleEpoch: rulesSnapshot[CHANNELS[0].id].epoch,
      ruleVersions: versions,
      claimId,
      claimUnits,
    },
  };
}

export function supersePlan(plan, { nowTick, byPlanId }) {
  if (plan.status !== PLAN_STATUS.ACTIVE) return plan;
  return {
    ...plan,
    status: PLAN_STATUS.SUPERSEDED,
    supersededAtTick: nowTick,
    supersededBy: byPlanId,
  };
}

export function activatePlan(plan, { nowTick }) {
  return { ...plan, status: PLAN_STATUS.ACTIVE, appliedAtTick: nowTick };
}

export function priceDiff(from, to) {
  if (!from) return [];
  return CHANNELS.filter((c) => from[c.id] !== to[c.id]).map((c) => ({
    channelId: c.id,
    channelName: c.name,
    from: from[c.id],
    to: to[c.id],
    deltaPct: ((to[c.id] - from[c.id]) / from[c.id]) * 100,
  }));
}

export function channelName(id) {
  return findChannel(id)?.name || id;
}

export function netContributionCents(plan, rulebook, unitsByChannel) {
  let cents = 0;
  for (const channel of CHANNELS) {
    const rule = rulebook[channel.id];
    const units = unitsByChannel?.[channel.id] ?? 0;
    cents += (plan.prices[channel.id] - SKU.unitCostCents - rule.feeCents) * units;
  }
  return cents;
}
