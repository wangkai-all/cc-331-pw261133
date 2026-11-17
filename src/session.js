/**
 * Experiment session.
 *
 * The session owns the engine, the plan workflow and the HTTP-facing API. It is
 * the only place where "operator intent" is translated into engine mutations,
 * and it enforces the rules that keep parallel plans from over-committing the
 * shared pool:
 *
 *   - every plan simulation is a *dry run*: a cloned engine is stepped forward
 *     without touching the live log,
 *   - confirmation requires a fresh guardrail pass against the current rulebook
 *     and a stock claim that fits next to all other live claims,
 *   - applying a plan is refused if the plan was superseded, its rule snapshot
 *     is stale, or its claim is no longer valid,
 *   - a rulebook bump invalidates confirmed claims; the old plan can still be
 *     read and simulated but not promoted.
 */

import { ReplayEngine, MAX_TICKS } from './engine.js';
import { buildRulebook, ruleDiff, ruleVersionsOf, RULE_EPOCHS } from './rules.js';
import {
  PLAN_STATUS,
  PLAN_STATUS_LABEL,
  MIN_BUFFER_UNITS,
  activatePlan,
  createPlan,
  editPlan,
  otherClaimUnits,
  priceDiff,
  rulesSnapshotFor,
  validatePlan,
} from './plans.js';
import { analyzeEvents, backtest, identificationSummary, rowsForChannel } from './analysis.js';
import { CHANNELS, DAY_HOURS, MAX_DAYS, SKU, findChannel, fmt } from './world.js';
import { runSimulation } from './simulate.js';

const DEFAULT_STRATEGY = {
  'CH-MKT': -12,
  'CH-WEB': -8,
  'CH-APP': -14,
  'CH-OUT': -6,
};

let sessionSeq = 0;

export function defaultPrices(adjustPct = {}) {
  const prices = {};
  for (const channel of CHANNELS) {
    const pct = adjustPct[channel.id] ?? DEFAULT_STRATEGY[channel.id] ?? 0;
    prices[channel.id] = Math.round((channel.priceAnchorCents * (100 + pct)) / 100 / 100) * 100;
  }
  return prices;
}

export class LabSession {
  constructor({ config = {} } = {}) {
    sessionSeq += 1;
    this.id = `lab-${sessionSeq}`;
    this.createdAt = new Date().toISOString();
    this.config = { ...config };
    this.undoStack = [];
    this.checkpointSeq = 0;
    this.checkpoints = [];
    this.reset(config);
  }

  reset(config = {}) {
    this.config = { ...this.config, ...config };
    this.engine = new ReplayEngine({ config: this.config });
    this.ruleEpoch = this.engine.ruleEpoch;
    this.rulebook = buildRulebook(this.ruleEpoch);
    this.lastAction = null;
    this.timeline = [];
    this.toast = null;
    this._analysisCache = null;
    return this;
  }

  /** Capture a compact restore point before a mutating action. */
  checkpointBefore(label) {
    try {
      const payload = this.exportState();
      this.undoStack.push({ label, at: new Date().toISOString(), payload });
      if (this.undoStack.length > 8) this.undoStack.shift();
      return true;
    } catch {
      return false;
    }
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return { ok: false, error: '没有可撤销的操作。', state: this.state() };
    const result = this.importState(entry.payload);
    if (!result.ok) return result;
    this.toast = { tone: 'ok', text: `已撤销：${entry.label}。` };
    return { ok: true, state: this.state(), label: entry.label };
  }

  saveCheckpoint(label) {
    this.checkpointSeq += 1;
    const id = `CP-${this.checkpointSeq}`;
    this.checkpoints.unshift({
      id,
      label: label || `检查点 ${this.checkpointSeq}`,
      at: new Date().toISOString(),
      tick: this.engine.tick,
      day: this.engine.day,
      payload: this.exportState(),
    });
    if (this.checkpoints.length > 6) this.checkpoints.pop();
    return { ok: true, checkpoint: { id, label, at: this.checkpoints[0].at, tick: this.engine.tick }, state: this.state() };
  }

  restoreCheckpoint(id) {
    const checkpoint = this.checkpoints.find((c) => c.id === id);
    if (!checkpoint) return { ok: false, error: '未找到该检查点。' };
    this.checkpointBefore(`恢复检查点 ${checkpoint.label}`);
    const result = this.importState(checkpoint.payload);
    if (result.ok) {
      this.toast = { tone: 'ok', text: `已恢复到 ${checkpoint.label}（第 ${checkpoint.day + 1} 天）。` };
    }
    return { ...result, state: this.state() };
  }

  // ------------------------------------------------------------------ state ---

  state({ includeEvents = false, eventLimit = 220 } = {}) {
    const summary = this.engine.summary();
    const claimable = this.engine.inventory.units.available - this.engine.claimedUnits();
    const todayObservations = this.engine.observations.filter((o) => o.day === this.engine.day);
    const today = CHANNELS.map((channel) => {
      const rows = todayObservations.filter((o) => o.channelId === channel.id);
      return {
        channelId: channel.id,
        day: this.engine.day,
        priceCents: this.engine.currentPrices[channel.id],
        impressions: rows.reduce((sum, r) => sum + r.impressions, 0),
        clicks: rows.reduce((sum, r) => sum + r.clicks, 0),
        orders: rows.reduce((sum, r) => sum + r.orders, 0),
        stockoutTicks: rows.filter((r) => r.truncated).length,
        ticks: rows.length,
      };
    });
    return {
      sessionId: this.id,
      sku: SKU,
      tick: summary.tick,
      day: summary.day,
      hour: summary.hour,
      maxTicks: MAX_TICKS,
      maxDays: MAX_DAYS,
      hoursPerDay: DAY_HOURS,
      complete: summary.complete,
      channels: CHANNELS,
      scenario: summary.scenario,
      appliedPlanId: summary.appliedPlanId,
      appliedPlan: summary.appliedPlan,
      plans: summary.plans.map((plan) => this.decoratePlan(plan)),
      inventory: summary.inventory,
      invariant: summary.invariant,
      claims: summary.claims,
      claimedUnits: summary.claimedUnits,
      claimableUnits: Math.max(0, claimable),
      bufferUnits: MIN_BUFFER_UNITS,
      money: {
        revenueCents: summary.revenueCents,
        refundsCents: summary.refundsCents,
        netRevenueCents: summary.revenueCents - summary.refundsCents,
      },
      counters: {
        ordersTotal: summary.ordersTotal,
        ordersPaid: summary.ordersPaid,
        ordersCancelled: summary.ordersCancelled,
        ordersExpired: summary.ordersExpired,
        ordersReturned: summary.ordersReturned,
        ordersPending: summary.ordersPending,
        stockoutTicks: summary.stockoutTicks,
        events: summary.events,
      },
      stockouts: summary.stockouts.map((s) => ({
        ...s,
        channelName: findChannel(s.channelId)?.name || s.channelId,
      })),
      today,
      rule: {
        epoch: this.ruleEpoch,
        info: RULE_EPOCHS.find((r) => r.epoch === this.ruleEpoch) || RULE_EPOCHS[0],
        rulebook: this.rulebook,
        history: RULE_EPOCHS,
      },
      config: this.engine.config,
      lastAction: this.lastAction,
      toast: this.toast,
      undo: this.undoStack.map((entry) => ({ label: entry.label, at: entry.at })),
      checkpoints: this.checkpoints.map((c) => ({
        id: c.id,
        label: c.label,
        at: c.at,
        tick: c.tick,
        day: c.day,
      })),
      events: includeEvents ? this.engine.events.slice(-eventLimit) : undefined,
      recentEvents: this.engine.events.slice(-40).reverse(),
      inventoryTimeline: this.engine.availableTimeline.slice(-72),
    };
  }

  decoratePlan(plan) {
    const ruleDiffs = plan.rulesSnapshot ? ruleDiff(ruleVersionsOf(plan.rulesSnapshot), this.rulebook) : [];
    const stale = Boolean(plan.confirmation && plan.confirmation.ruleEpoch !== this.ruleEpoch);
    const claim = this.engine.claims.find((c) => c.planId === plan.id && c.releasedAtTick == null) || null;
    return {
      ...plan,
      statusLabel: PLAN_STATUS_LABEL[plan.status] || plan.status,
      rulesDrift: ruleDiffs,
      rulesStale: stale,
      liveClaim: claim,
    };
  }

  // ------------------------------------------------------------------- plans ---

  createPlan({ name, prices, note }) {
    const plan = this.engine.addPlan({
      name,
      prices: prices || defaultPrices(),
      note: note || '',
    });
    this.toast = { tone: 'ok', text: `已创建草稿 ${plan.id}。` };
    return { ok: true, plan: this.decoratePlan(plan), state: this.state() };
  }

  editPlan(planId, patch) {
    const plan = this.engine.findPlan(planId);
    if (!plan) return { ok: false, error: '未找到方案。' };
    const result = editPlan(plan, patch, { tick: this.engine.tick });
    if (!result.ok) return result;
    this.engine.replacePlan(plan);
    this.toast = {
      tone: result.changed ? 'ok' : 'muted',
      text: result.changed ? `${plan.id} 已更新到版本 ${plan.revision}。` : '没有变化。',
    };
    return { ok: true, plan: this.decoratePlan(plan), state: this.state() };
  }

  duplicatePlan(planId) {
    const plan = this.engine.findPlan(planId);
    if (!plan) return { ok: false, error: '未找到方案。' };
    const copy = this.engine.addPlan({
      name: `${plan.name} 副本`,
      prices: { ...plan.prices },
      note: plan.note,
    });
    this.toast = { tone: 'ok', text: `已复制为 ${copy.id}。` };
    return { ok: true, plan: this.decoratePlan(copy), state: this.state() };
  }

  validate(planId, { claimUnits = null, expectedPrices = null, expectedRevision = null } = {}) {
    const plan = this.engine.findPlan(planId);
    if (!plan) return { ok: false, error: '未找到方案。', findings: [], blockers: [] };
    const result = validatePlan(plan, {
      rulebook: this.rulebook,
      inventory: this.engine.inventory,
      claims: this.engine.claims,
      bufferUnits: MIN_BUFFER_UNITS,
      expectedPrices,
      expectedRevision,
      claimUnits,
    });
    // Cross-plan duplicate detection needs every plan, so it lives here.
    const twins = this.engine.plans.filter(
      (other) =>
        other.id !== plan.id &&
        CHANNELS.every((c) => other.prices[c.id] === plan.prices[c.id]),
    );
    if (twins.length) {
      result.findings.push({
        level: 'warning',
        code: 'duplicate_prices',
        message: `与 ${twins.map((p) => p.id).join('、')} 价格完全相同，试算结果会重复。`,
      });
    }
    for (const channel of CHANNELS) {
      const rule = this.rulebook[channel.id];
      const price = plan.prices[channel.id];
      const gross = price - SKU.unitCostCents - rule.feeCents;
      if (gross < rule.minMarginCents + 1500) {
        result.findings.push({
          level: 'warning',
          code: 'thin_margin',
          channelId: channel.id,
          message: `${channel.name} 净贡献 ${fmt(gross)}，距离底线不远，需求上行时会很脆弱。`,
        });
      }
    }
    result.claimPreview = this.claimPreview(plan, claimUnits);
    result.availableForClaim = Math.max(
      0,
      this.engine.inventory.units.available - otherClaimUnits(this.engine.claims, plan.id),
    );
    return result;
  }

  claimPreview(plan, units = null) {
    const target = units ?? Math.max(0, plan.claimUnits || 0);
    return {
      units: target,
      buffer: MIN_BUFFER_UNITS,
      availableForClaim: Math.max(
        0,
        this.engine.inventory.units.available - otherClaimUnits(this.engine.claims, plan.id),
      ),
    };
  }

  confirmPlan(planId, { claimUnits = 0, expectedPrices = null, expectedRevision = null, acknowledge = false } = {}) {
    const plan = this.engine.findPlan(planId);
    if (!plan) return { ok: false, error: '未找到方案。' };
    const check = this.validate(planId, { claimUnits, expectedPrices, expectedRevision });
    if (!check.ok) {
      this.toast = {
        tone: 'bad',
        text: `确认被拒绝：${check.blockers[0]?.message || '未通过核对。'}`,
      };
      return { ok: false, error: check.blockers[0]?.message || '未通过核对。', findings: check.findings, state: this.state() };
    }
    const warnings = check.findings.filter((f) => f.level === 'warning');
    if (warnings.length && !acknowledge) {
      return {
        ok: false,
        needsAcknowledgement: true,
        error: '存在警告，请确认后再继续。',
        findings: check.findings,
        state: this.state(),
      };
    }
    this.checkpointBefore(`确认 ${planId}`);
    const lockedPrices = expectedPrices || { ...plan.prices };
    const snapshot = rulesSnapshotFor(plan, this.rulebook);
    const result = this.engine.confirm(planId, {
      rulesSnapshot: snapshot,
      confirmation: {
        ruleEpoch: this.ruleEpoch,
        ruleVersions: ruleVersionsOf(snapshot),
        prices: lockedPrices,
        revision: expectedRevision ?? plan.revision,
        inventorySnapshot: this.engine.inventory.snapshot(),
      },
      claim: { units: Math.max(0, Math.floor(claimUnits)), reason: 'confirmation' },
    });
    if (!result.ok) return result;
    this.toast = {
      tone: 'ok',
      text: `${planId} 已确认，规则 ${snapshot[CHANNELS[0].id].ruleLabel}，预留 ${Math.max(0, Math.floor(claimUnits))} 件。`,
    };
    return {
      ok: true,
      plan: this.decoratePlan(result.plan),
      planView: this.planView(planId),
      state: this.state(),
    };
  }

  applyPlan(planId) {
    const plan = this.engine.findPlan(planId);
    if (!plan) return { ok: false, error: '未找到方案。' };
    if (plan.status === PLAN_STATUS.SUPERSEDED) {
      return {
        ok: false,
        error: `方案 ${plan.id} 已于第 ${plan.supersededAtTick} 个时钟被 ${plan.supersededBy} 取代，不能重新上线。`,
        state: this.state(),
      };
    }
    if (plan.status === PLAN_STATUS.DRAFT) {
      return { ok: false, error: '方案尚未确认，请先完成库存与规则核对。', state: this.state() };
    }
    if (plan.confirmation && plan.confirmation.ruleEpoch !== this.ruleEpoch) {
      return {
        ok: false,
        error: `规则已从第 ${plan.confirmation.ruleEpoch} 版更新到第 ${this.ruleEpoch} 版，方案需重新确认。`,
        state: this.state(),
      };
    }
    const drift = plan.rulesSnapshot ? ruleDiff(ruleVersionsOf(plan.rulesSnapshot), this.rulebook) : [];
    if (drift.length) {
      return {
        ok: false,
        error: `规则的渠道版本已变化（${drift.map((d) => `${d.channelId}: ${d.before} → ${d.after}`).join('；')}），请重新确认。`,
        state: this.state(),
      };
    }
    const claim = this.engine.claims.find((c) => c.planId === plan.id && c.releasedAtTick == null);
    if (!claim) {
      return {
        ok: false,
        error: '该方案的库存预留已释放（可能因规则变更或已被取代），请重新确认后再上线。',
        state: this.state(),
      };
    }
    this.checkpointBefore(`上线 ${planId}`);
    const result = this.engine.applyPlan(planId);
    if (!result.ok) return { ...result, state: this.state() };
    this.toast = { tone: 'ok', text: `${planId} 已上线：${priceDiff(this.engine.currentPrices, plan.prices).length} 个渠道调价。` };
    return { ok: true, plan: this.decoratePlan(result.plan), state: this.state() };
  }

  // ------------------------------------------------------------------ clock ---

  advance({ ticks = 1 } = {}) {
    const steps = [];
    let guard = 0;
    while (guard < ticks && !this.engine.isComplete) {
      const step = this.engine.step();
      steps.push(step);
      guard += 1;
    }
    this.toast = null;
    return {
      ok: true,
      advanced: steps.length,
      state: this.state(),
      tickResult: steps[steps.length - 1] || null,
    };
  }

  runTo({ targetTick }) {
    let guard = 0;
    while (this.engine.tick < targetTick && !this.engine.isComplete && guard < MAX_TICKS + 4) {
      this.engine.step();
      guard += 1;
    }
    return { ok: true, state: this.state() };
  }

  setDemandScenario(scenarioId) {
    if (this.engine.tick > 0 && this.engine.tick < MAX_TICKS && this.engine.orders.size > 0) {
      return {
        ok: false,
        error: '需求情景只能在回放开始前切换，否则会混合两个世界。请先重置。',
        state: this.state(),
      };
    }
    this.engine.config.demandScenario = scenarioId;
    this.engine.scenario = this.engine.scenario.id === scenarioId ? this.engine.scenario : this.engine.scenario;
    this.reset({ demandScenario: scenarioId });
    return { ok: true, state: this.state() };
  }

  restock(units) {
    const day = this.engine.day;
    this.engine.inventory.restock(units, day, this.engine.hour, 'operator_restock');
    this.toast = { tone: 'ok', text: `已补货 ${units} 件到共享库存池。` };
    return { ok: true, state: this.state() };
  }

  bumpRuleEpoch() {
    if (this.ruleEpoch === 0) {
      this.engine.ruleEpoch = 1;
      this.ruleEpoch = 1;
      this.rulebook = buildRulebook(1);
      const invalidated = this.engine.markRulesStale();
      this.toast = {
        tone: 'warn',
        text: `规则升级到 ${this.rulebook[CHANNELS[0].id].ruleLabel}；${invalidated.length} 个已确认方案的预留已释放，需重新确认。`,
      };
      return { ok: true, invalidated, state: this.state() };
    }
    return { ok: false, error: '当前已是最新规则，没有可用的下一个版本。', state: this.state() };
  }

  // -------------------------------------------------------------- simulation ---

  simulate(planId, { horizonTicks = 3 * DAY_HOURS, ticks = null } = {}) {
    const result = runSimulation(this, planId, { horizonTicks, ticks });
    return result;
  }

  // ---------------------------------------------------------------- analysis ---

  analysis({ method = 'shared', censorMode = 'censored', cutoffSeq = null } = {}) {
    // A null cutoff means "analyse everything visible now". Passing null into
    // analyzeEvents would be read as seq 0 and drop every row.
    const cut = Number.isFinite(cutoffSeq) ? cutoffSeq : Infinity;
    const key = `${method}|${censorMode}|${cut === Infinity ? 'now' : cut}|${this.engine.seq}`;
    if (this._analysisCache && this._analysisCache.key === key) {
      return this._analysisCache.value;
    }
    const analysis = analyzeEvents(this.engine.events, { method, censorMode, cutoffSeq: cut });
    const value = {
      ...analysis,
      identification: identificationSummary(analysis),
      backtest: backtest(this.engine.events, { method }),
    };
    this._analysisCache = { key, value };
    return value;
  }

  planView(planId) {
    const plan = this.engine.findPlan(planId);
    if (!plan) return null;
    return {
      ...this.decoratePlan(plan),
      diffFromApplied: priceDiff(this.engine.appliedPlan?.prices, plan.prices),
      netPerUnit: Object.fromEntries(
        CHANNELS.map((c) => [
          c.id,
          plan.prices[c.id] - SKU.unitCostCents - this.rulebook[c.id].feeCents,
        ]),
      ),
    };
  }

  // --------------------------------------------------------- order drill-down ---

  /**
   * Orders carry an internal `willCancel` verdict so settlement stays
   * deterministic. That is a future fact: never let it reach the UI or an
   * export while the order is still pending, or the operator could "know" an
   * outcome that has not happened yet.
   */
  publicOrder(order) {
    const { willCancel, cancelReason, ...rest } = order;
    return {
      ...rest,
      cancelReason: order.state === 'cancelled' ? cancelReason : null,
      channelName: findChannel(order.channelId)?.name || order.channelId,
    };
  }

  orders({ day = null, channelId = null, planId = null, state = null, limit = 120, orderId = null } = {}) {
    const list = [...this.engine.orders.values()];
    let filtered = list;
    if (orderId) filtered = list.filter((o) => o.id === orderId);
    if (day != null) filtered = filtered.filter((o) => o.createdDay === day);
    if (channelId) filtered = filtered.filter((o) => o.channelId === channelId);
    if (planId) filtered = filtered.filter((o) => o.planId === planId);
    if (state) filtered = filtered.filter((o) => o.state === state);
    filtered = filtered.slice(-limit).reverse();
    return {
      orders: filtered.map((order) => ({
        ...this.publicOrder(order),
        events: this.engine.events.filter(
          (e) => e.orderId === order.id || (e.note && e.note === order.holdId),
        ),
      })),
      total: list.length,
      filtered: filtered.length,
    };
  }

  orderJourney(orderId) {
    const order = this.engine.orders.get(orderId);
    if (!order) return null;
    const hold = this.engine.inventory.holds.find((h) => h.orderId === orderId);
    const events = this.engine.events.filter((e) => e.orderId === orderId);
    return {
      order: this.publicOrder(order),
      hold,
      events,
    };
  }

  exportState() {
    // Deep copy: toJSON() hands out the engine's live arrays (plans, claims,
    // events). Without the copy, an undo/checkpoint payload keeps mutating with
    // the engine and "undo" restores the present, not the past.
    return JSON.parse(
      JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        engine: this.engine.toJSON(),
        ruleEpoch: this.ruleEpoch,
        config: this.config,
      }),
    );
  }

  importState(payload) {
    if (!payload || !payload.engine) return { ok: false, error: '存档格式不正确。' };
    try {
      this.engine = ReplayEngine.fromJSON(payload.engine);
      this.config = payload.config || this.engine.config;
      this.ruleEpoch = payload.ruleEpoch ?? this.engine.ruleEpoch;
      this.rulebook = buildRulebook(this.ruleEpoch);
      this.toast = { tone: 'ok', text: '已恢复到存档状态。' };
      return { ok: true, state: this.state() };
    } catch (error) {
      return { ok: false, error: `恢复失败：${error.message}` };
    }
  }
}

export function createSession(config) {
  return new LabSession({ config });
}

export { DEFAULT_STRATEGY };
