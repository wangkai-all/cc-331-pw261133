/**
 * Replay engine.
 *
 * The clock moves in six two-hour ticks per simulated day. At each tick the
 * engine settles yesterday's holds, collects returns, generates demand for each
 * channel and then lets channels consume one shared inventory pool in a fixed
 * processing order.
 *
 * Two rules keep the replay honest:
 *   - latent demand is never written to the event log; only impressions,
 *     orders, holds and stockouts are,
 *   - a stockout truncates observed orders but does not change latent demand,
 *     so downstream analysis always sees censored data rather than the truth.
 */

import {
  CHANNELS,
  DAY_HOURS,
  DEFAULT_WORLD_CONFIG,
  MAX_DAYS,
  HOUR_LABELS,
  findChannel,
  findScenario,
  SKU,
} from './world.js';
import {
  EVENT_TYPES,
  dayClosedEvent,
  exposureEvent,
  orderEvent,
  planEvent,
  priceChangedEvent,
  stockoutEvent,
  tickEvent,
} from './events.js';
import { Inventory } from './inventory.js';
import { buildRulebook } from './rules.js';
import { latentDemandRate, priceIndex, trafficForDay } from './demand.js';
import { binomial, clamp, makeRng, randInt } from './rng.js';
import {
  PLAN_STATUS,
  confirmPlan,
  createPlan,
  planIdFor,
  rulesSnapshotFor,
  supersePlan,
} from './plans.js';

export const MAX_TICKS = MAX_DAYS * DAY_HOURS;
export const HOUR_WEIGHTS = [0.09, 0.16, 0.22, 0.24, 0.18, 0.11];
export const PENDING_PAY_TICKS = 2;
export const SLOW_PAY_TICKS = 9;

export class ReplayEngine {
  constructor({ config = {} } = {}) {
    this.reset({ config });
  }

  reset({ config } = {}) {
    this.config = { ...DEFAULT_WORLD_CONFIG, ...(config || {}) };
    this.seed = this.config.seed;
    this.scenario = findScenario(this.config.demandScenario);
    this.channelOrder = (this.config.channelOrder || CHANNELS.map((c) => c.id)).filter((id) => findChannel(id));
    if (!this.channelOrder.length) this.channelOrder = CHANNELS.map((c) => c.id);

    this.tick = 0;
    this.day = 0;
    this.hour = 0;
    this.hourIndexInDay = 0;
    this.seq = 0;
    this.events = [];
    this.observations = [];
    this.orders = new Map();
    this.orderSeq = 0;
    this.pending = [];
    this.returnQueue = [];
    this.availableTimeline = [];
    this.plans = [];
    this.appliedPlanId = null;
    this.claims = [];
    this.claimSeq = 0;
    this.stockouts = [];
    this.revenueCents = 0;
    this.refundsCents = 0;
    this.ruleEpoch = this.config.ruleEpoch ?? 0;
    this.rulebook = buildRulebook(this.ruleEpoch);
    this.inventory = new Inventory({
      sku: SKU.id,
      openingUnits: this.config.openingUnits,
      returnRate: this.config.returnRate,
      holdTtlDays: this.config.holdTtlDays,
      seed: this.seed,
      onEvent: (event) => this.push({ ...event, tick: this.tick }),
    });

    const baseline = createPlan({
      name: '参考价基线',
      prices: Object.fromEntries(CHANNELS.map((c) => [c.id, c.priceAnchorCents])),
      note: '所有渠道按参考价运行，作为对照。',
      author: 'system',
      createdAtTick: 0,
      id: planIdFor(1),
    });
    const rules = rulesSnapshotFor(baseline, this.rulebook);
    baseline.status = PLAN_STATUS.ACTIVE;
    baseline.confirmedAtTick = 0;
    baseline.rulesSnapshot = rules;
    baseline.confirmation = {
      tick: 0,
      revision: baseline.revision,
      ruleEpoch: this.ruleEpoch,
      ruleVersions: Object.fromEntries(Object.entries(rules).map(([id, r]) => [id, r.ruleVersion])),
      inventorySnapshot: this.inventory.snapshot(),
      claimUnits: 0,
    };
    this.plans.push(baseline);
    this.appliedPlanId = baseline.id;
    this.push(
      planEvent({
        type: EVENT_TYPES.PLAN_CONFIRMED,
        tick: 0,
        day: 0,
        planId: baseline.id,
        name: baseline.name,
        rulesSnapshot: rules,
      }),
    );
    this.availableTimeline.push({
      tick: 0,
      day: 0,
      hour: HOUR_LABELS[0],
      available: this.inventory.units.available,
      held: this.inventory.units.held,
      committed: this.inventory.units.committed,
    });
    return this;
  }

  push(event) {
    this.seq += 1;
    event.seq = this.seq;
    this.events.push(event);
    return event;
  }

  get appliedPlan() {
    return this.plans.find((p) => p.id === this.appliedPlanId) || null;
  }

  get currentPrices() {
    const plan = this.appliedPlan;
    const prices = {};
    for (const channel of CHANNELS) {
      prices[channel.id] = plan ? plan.prices[channel.id] : channel.priceAnchorCents;
    }
    return prices;
  }

  get isComplete() {
    return this.tick >= MAX_TICKS;
  }

  dayHourFromTick(tick) {
    const day = Math.floor(tick / DAY_HOURS);
    const hourIndex = Math.max(0, Math.min(DAY_HOURS - 1, tick % DAY_HOURS));
    return { day, hourIndex, hour: Number(HOUR_LABELS[hourIndex].slice(0, 2)) };
  }

  // ---------------------------------------------------------------- plans ---

  addPlan({ name, prices, note, author = 'operator' }) {
    const plan = createPlan({
      name,
      prices,
      note,
      author,
      createdAtTick: this.tick,
      id: planIdFor(this.nextPlanNumber()),
    });
    this.plans.push(plan);
    return plan;
  }

  nextPlanNumber() {
    const max = this.plans.reduce((best, p) => {
      const match = /^PLAN-(\d+)$/.exec(p.id || '');
      return match ? Math.max(best, Number(match[1])) : best;
    }, 0);
    return max + 1;
  }

  findPlan(planId) {
    return this.plans.find((p) => p.id === planId) || null;
  }

  replacePlan(plan) {
    const idx = this.plans.findIndex((p) => p.id === plan.id);
    if (idx >= 0) this.plans[idx] = plan;
  }

  /**
   * Attach a confirmation package plus its stock claim. The session layer has
   * already validated the plan against the current rulebook; the engine stores
   * the frozen snapshot it is given and never re-derives it.
   */
  confirm(planId, { rulesSnapshot, confirmation, claim }) {
    const plan = this.findPlan(planId);
    if (!plan) return { ok: false, error: '未找到方案。' };
    if (plan.status !== PLAN_STATUS.DRAFT) return { ok: false, error: '只有草稿可以确认。' };
    let claimId = null;
    if (claim && claim.units > 0) {
      this.claimSeq += 1;
      claimId = `CLM-${String(this.claimSeq).padStart(3, '0')}`;
      this.claims.push({ id: claimId, ...claim, tick: this.tick, planId, releasedAtTick: null });
    }
    const updated = confirmPlan(plan, {
      nowTick: this.tick,
      rulesSnapshot,
      claimUnits: claim?.units ?? 0,
      claimId,
    });
    updated.confirmation = {
      ...updated.confirmation,
      ...confirmation,
      ruleEpoch: confirmation?.ruleEpoch ?? updated.confirmation.ruleEpoch,
      claimUnits: claim?.units ?? 0,
      claimId,
    };
    this.replacePlan(updated);
    this.push(
      planEvent({
        type: EVENT_TYPES.PLAN_CONFIRMED,
        tick: this.tick,
        day: this.day,
        planId: plan.id,
        name: plan.name,
        rulesSnapshot: updated.rulesSnapshot,
      }),
    );
    return { ok: true, plan: updated };
  }

  /**
   * Apply a plan. The caller (session) has already verified that the plan is
   * confirmed, current with the rulebook and covered by a live claim.
   */
  applyPlan(planId) {
    const plan = this.findPlan(planId);
    if (!plan) return { ok: false, error: '未找到方案。' };
    if (plan.status === PLAN_STATUS.SUPERSEDED) {
      return { ok: false, error: `方案 ${plan.id} 已被取代，不能再次上线。` };
    }
    if (plan.status !== PLAN_STATUS.CONFIRMED && plan.status !== PLAN_STATUS.ACTIVE) {
      return { ok: false, error: '方案尚未确认，不能上线。' };
    }
    if (plan.id === this.appliedPlanId) {
      return { ok: false, error: '该方案已经是当前生效方案。' };
    }
    if (plan.confirmation && plan.confirmation.ruleEpoch !== this.ruleEpoch) {
      return {
        ok: false,
        error: `方案确认时规则为第 ${plan.confirmation.ruleEpoch} 版，当前为第 ${this.ruleEpoch} 版，需重新确认。`,
      };
    }
    const previous = this.appliedPlan;
    const pricesBefore = this.currentPrices;
    const next = { ...plan, status: PLAN_STATUS.ACTIVE };
    this.replacePlan(next);
    this.appliedPlanId = plan.id;
    this.releaseClaim(plan.id, 'applied');

    if (previous && previous.id !== plan.id) {
      const superseded = supersePlan(previous, { nowTick: this.tick, byPlanId: plan.id });
      this.replacePlan(superseded);
      this.releaseClaim(previous.id, 'superseded');
      this.push(
        planEvent({
          type: EVENT_TYPES.PLAN_SUPERSEDED,
          tick: this.tick,
          day: this.day,
          planId: previous.id,
          name: previous.name,
          rulesSnapshot: previous.rulesSnapshot,
          byPlanId: plan.id,
        }),
      );
    }
    this.push(
      planEvent({
        type: EVENT_TYPES.PLAN_CONFIRMED,
        tick: this.tick,
        day: this.day,
        planId: next.id,
        name: next.name,
        rulesSnapshot: next.rulesSnapshot,
      }),
    );
    this.push(
      priceChangedEvent({
        tick: this.tick,
        day: this.day,
        hour: this.hour,
        planId: next.id,
        from: pricesBefore,
        to: next.prices,
        kind: 'apply',
      }),
    );
    return { ok: true, plan: next };
  }

  releaseClaim(planId, reason) {
    for (const claim of this.claims) {
      if (claim.planId === planId && claim.releasedAtTick == null) {
        claim.releasedAtTick = this.tick;
        claim.releaseReason = reason;
      }
    }
  }

  activeClaims({ excludePlanId = null } = {}) {
    return this.claims.filter(
      (c) => c.releasedAtTick == null && c.planId !== excludePlanId,
    );
  }

  claimedUnits({ excludePlanId = null } = {}) {
    return this.activeClaims({ excludePlanId }).reduce((sum, c) => sum + c.units, 0);
  }

  /**
   * Invalidate claims after a rulebook change. Confirmed-but-not-live plans
   * keep their status but must be re-confirmed before they can be applied.
   */
  markRulesStale() {
    const stale = [];
    for (const plan of this.plans) {
      if (plan.status !== PLAN_STATUS.CONFIRMED) continue;
      if (!plan.confirmation) continue;
      if (plan.confirmation.ruleEpoch !== this.ruleEpoch) {
        stale.push(plan.id);
        this.releaseClaim(plan.id, 'rules_stale');
      }
    }
    return stale;
  }

  // ------------------------------------------------------------------ tick ---

  step() {
    if (this.isComplete) return { done: true };
    this.tick += 1;
    const { day, hourIndex, hour } = this.dayHourFromTick(this.tick - 1);
    this.day = day;
    this.hour = hour;
    this.hourIndexInDay = hourIndex;

    this.push(tickEvent({ tick: this.tick, day, hour, label: HOUR_LABELS[hourIndex] }));
    this.settlePending(day, hour);
    this.processReturnQueue(day, hour);
    this.inventory.expireHolds(day, hour);

    const prices = this.currentPrices;
    const observations = [];
    for (const channelId of this.channelOrder) {
      const channel = findChannel(channelId);
      observations.push(this.simulateChannelTick({ channel, day, hour, hourIndex, prices }));
    }

    this.availableTimeline.push({
      tick: this.tick,
      day,
      hour,
      available: this.inventory.units.available,
      held: this.inventory.units.held,
      committed: this.inventory.units.committed,
    });

    if (this.tick % DAY_HOURS === 0) {
      this.push(
        dayClosedEvent({
          tick: this.tick,
          day,
          inventory: this.inventory.snapshot(),
          revenueCents: this.revenueCents,
          refundsCents: this.refundsCents,
          orders: this.orders.size,
          stockouts: this.stockouts.length,
        }),
      );
    }

    return {
      done: this.isComplete,
      tick: this.tick,
      day,
      hour,
      observations,
      inventory: this.inventory.snapshot(),
    };
  }

  simulateChannelTick({ channel, day, hour, hourIndex, prices }) {
    const price = prices[channel.id];
    const plan = this.appliedPlan;
    const traffic = trafficForDay({
      channel,
      day,
      seed: this.seed,
      scenario: this.scenario,
      worldTraffic: this.config.baseTrafficMultiplier,
    });
    const tickTraffic = Math.max(1, Math.round(traffic * HOUR_WEIGHTS[hourIndex]));
    const cross = priceIndex(prices, CHANNELS);
    const availableAtStart = this.inventory.units.available;
    const rate = latentDemandRate({
      channel,
      priceCents: price,
      day,
      seed: this.seed,
      scenario: this.scenario,
      crossPriceIndex: cross,
      availableAtStart,
    });
    const intended = Math.max(
      0,
      binomial(makeRng(this.seed, 'demand', channel.id, day, hourIndex), tickTraffic, rate),
    );
    const clickRate = clamp(rate * 0.55 + 0.01, 0.008, 0.4);
    const clicks = Math.min(
      tickTraffic,
      binomial(makeRng(this.seed, 'clicks', channel.id, day, hourIndex), tickTraffic, clickRate),
    );

    let served = 0;
    let truncated = false;
    for (let i = 0; i < intended; i += 1) {
      const orderId = this.makeOrderId(day, hourIndex, channel, i);
      const hold = this.inventory.placeHold({
        day,
        hour,
        channelId: channel.id,
        orderId,
        priceCents: price,
      });
      if (!hold) {
        truncated = true;
        break;
      }
      served += 1;
      this.openOrder({ hold, channel, price, plan, day, hour, hourIndex, stockAtStart: availableAtStart });
    }

    this.push(
      exposureEvent({
        tick: this.tick,
        day,
        hour,
        channelId: channel.id,
        priceCents: price,
        planId: plan?.id ?? null,
        planRevision: plan?.revision ?? 0,
        impressions: tickTraffic,
        clicks,
        availableAtStart,
        orders: served,
        stockout: truncated,
      }),
    );

    if (truncated) {
      this.push(
        stockoutEvent({
          tick: this.tick,
          day,
          hour,
          channelId: channel.id,
          served,
          atStart: availableAtStart <= 0,
        }),
      );
      this.stockouts.push({ tick: this.tick, day, hour, channelId: channel.id, availableAtStart, served });
    }

    const observation = {
      tick: this.tick,
      day,
      hour,
      hourIndex,
      channelOrderIndex: this.channelOrder.indexOf(channel.id),
      channelId: channel.id,
      priceCents: price,
      planId: plan?.id ?? null,
      impressions: tickTraffic,
      clicks,
      orders: served,
      availableAtStart,
      truncated,
      stockout: truncated,
    };
    this.observations.push(observation);
    return observation;
  }

  makeOrderId(day, hourIndex, channel, index) {
    this.orderSeq += 1;
    return `O-${String(day + 1).padStart(2, '0')}${String(hourIndex + 1)}-${channel.short}-${String(
      this.orderSeq,
    ).padStart(5, '0')}`;
  }

  openOrder({ hold, channel, price, plan, day, hour, hourIndex, stockAtStart }) {
    const rng = makeRng(this.seed, 'payment', hold.orderId);
    const slow = rng() < 0.08;
    const dueTick = this.tick + (slow ? SLOW_PAY_TICKS : PENDING_PAY_TICKS);
    const cancelBase = channel.kind === 'marketplace' ? 0.14 : channel.kind === 'offline' ? 0.03 : 0.08;
    const cancelProbability = clamp(
      cancelBase + (slow ? 0.22 : 0) + (price > channel.priceAnchorCents ? 0.02 : 0),
      0.01,
      0.45,
    );
    const willCancel = slow ? true : makeRng(this.seed, 'cancel', hold.orderId)() < cancelProbability;
    const order = {
      id: hold.orderId,
      channelId: channel.id,
      priceCents: price,
      planId: plan?.id ?? null,
      createdTick: this.tick,
      createdDay: day,
      createdHour: hour,
      dueTick,
      slow,
      willCancel,
      cancelReason: willCancel ? (slow ? 'hold_expired' : 'buyer_cancelled') : null,
      state: 'pending',
      holdId: hold.id,
      stockAtStart,
    };
    this.orders.set(order.id, order);
    this.pending.push(order);
    this.push(
      orderEvent({
        type: EVENT_TYPES.ORDER_PLACED,
        tick: this.tick,
        day,
        hour,
        channelId: channel.id,
        orderId: order.id,
        priceCents: price,
        planId: plan?.id ?? null,
      }),
    );
    if (!slow && this.inventory.willReturn(hold.orderId)) {
      const delay = this.inventory.randomReturnDelay(hold.orderId, 4);
      this.returnQueue.push({ orderId: order.id, dueDay: day + delay });
    }
    return order;
  }

  settlePending(day, hour = null) {
    const still = [];
    for (const order of this.pending) {
      if (order.state !== 'pending') continue;
      if (this.tick < order.dueTick) {
        still.push(order);
        continue;
      }
      const hold = this.inventory.findHold(order.id);
      if (!hold) {
        order.state = 'expired';
        this.push(
          orderEvent({
            type: EVENT_TYPES.ORDER_EXPIRED,
            tick: this.tick,
            day,
            hour: this.hour,
            channelId: order.channelId,
            orderId: order.id,
            priceCents: order.priceCents,
            planId: order.planId,
            reason: 'hold_expired',
          }),
        );
        continue;
      }
      if (order.willCancel) {
        this.inventory.releaseHold(hold, day, order.cancelReason, this.hour);
        order.state = 'cancelled';
        this.push(
          orderEvent({
            type: EVENT_TYPES.ORDER_CANCELLED,
            tick: this.tick,
            day,
            hour: this.hour,
            channelId: order.channelId,
            orderId: order.id,
            priceCents: order.priceCents,
            planId: order.planId,
            reason: order.cancelReason,
          }),
        );
        this.returnQueue = this.returnQueue.filter((r) => r.orderId !== order.id);
        continue;
      }
      this.inventory.commitHold(hold, day, this.hour);
      order.state = 'paid';
      order.paidTick = this.tick;
      this.revenueCents += order.priceCents;
      this.push(
        orderEvent({
          type: EVENT_TYPES.ORDER_PAID,
          tick: this.tick,
          day,
          hour: this.hour,
          channelId: order.channelId,
          orderId: order.id,
          priceCents: order.priceCents,
          planId: order.planId,
        }),
      );
    }
    this.pending = still;
  }

  processReturnQueue(day, hour = null) {
    if (!this.returnQueue.length) return;
    const remaining = [];
    for (const item of this.returnQueue) {
      const order = this.orders.get(item.orderId);
      if (!order) continue;
      if (order.state === 'pending') {
        remaining.push(item);
        continue;
      }
      if (order.state !== 'paid') continue;
      if (day < item.dueDay) {
        remaining.push(item);
        continue;
      }
      const hold = this.inventory.holds.find((h) => h.orderId === order.id && h.state === 'committed');
      if (hold && this.inventory.returnCommitted(hold, day, this.hour)) {
        order.state = 'returned';
        this.refundsCents += order.priceCents;
        this.revenueCents -= order.priceCents;
        this.push(
          orderEvent({
            type: EVENT_TYPES.ORDER_RETURNED,
            tick: this.tick,
            day,
            hour: this.hour,
            channelId: order.channelId,
            orderId: order.id,
            priceCents: order.priceCents,
            planId: order.planId,
            reason: 'customer_return',
          }),
        );
      }
    }
    this.returnQueue = remaining;
  }

  toJSON() {
    return {
      version: 1,
      config: this.config,
      seed: this.seed,
      tick: this.tick,
      day: this.day,
      hour: this.hour,
      hourIndexInDay: this.hourIndexInDay,
      seq: this.seq,
      events: this.events,
      observations: this.observations,
      orders: [...this.orders.values()],
      orderSeq: this.orderSeq,
      pending: this.pending,
      returnQueue: this.returnQueue,
      availableTimeline: this.availableTimeline,
      plans: this.plans,
      appliedPlanId: this.appliedPlanId,
      claims: this.claims,
      claimSeq: this.claimSeq,
      stockouts: this.stockouts,
      revenueCents: this.revenueCents,
      refundsCents: this.refundsCents,
      ruleEpoch: this.ruleEpoch,
      inventory: this.inventory.toJSON(),
    };
  }

  static fromJSON(data) {
    const engine = new ReplayEngine({ config: data.config });
    engine.seed = data.seed;
    engine.config = { ...data.config };
    engine.scenario = findScenario(data.config.demandScenario);
    engine.channelOrder = (data.config.channelOrder || CHANNELS.map((c) => c.id)).filter((id) => findChannel(id));
    engine.tick = data.tick;
    engine.day = data.day;
    engine.hour = data.hour;
    engine.hourIndexInDay = data.hourIndexInDay;
    engine.seq = data.seq;
    engine.events = data.events;
    engine.observations = data.observations;
    engine.orders = new Map(data.orders.map((o) => [o.id, o]));
    engine.orderSeq = data.orderSeq;
    engine.pending = data.orders
      .filter((o) => o.state === 'pending')
      .map((o) => engine.orders.get(o.id));
    engine.returnQueue = data.returnQueue;
    engine.availableTimeline = data.availableTimeline;
    engine.plans = data.plans;
    engine.appliedPlanId = data.appliedPlanId;
    engine.claims = data.claims;
    engine.claimSeq = data.claimSeq;
    engine.stockouts = data.stockouts;
    engine.revenueCents = data.revenueCents;
    engine.refundsCents = data.refundsCents;
    engine.ruleEpoch = data.ruleEpoch;
    engine.rulebook = buildRulebook(engine.ruleEpoch);
    engine.inventory = Inventory.fromJSON(data.inventory);
    engine.inventory.onEvent = (event) => engine.push({ ...event, tick: engine.tick });
    return engine;
  }

  summary() {
    const orders = [...this.orders.values()];
    return {
      tick: this.tick,
      day: this.day,
      hour: this.hour,
      maxTicks: MAX_TICKS,
      complete: this.isComplete,
      scenario: { id: this.scenario.id, name: this.scenario.name, note: this.scenario.note },
      inventory: this.inventory.snapshot(),
      invariant: this.inventory.checkInvariant(),
      appliedPlanId: this.appliedPlanId,
      appliedPlan: this.appliedPlan,
      revenueCents: this.revenueCents,
      refundsCents: this.refundsCents,
      ordersTotal: orders.length,
      ordersPaid: orders.filter((o) => o.state === 'paid' || o.state === 'returned').length,
      ordersCancelled: orders.filter((o) => o.state === 'cancelled').length,
      ordersExpired: orders.filter((o) => o.state === 'expired').length,
      ordersReturned: orders.filter((o) => o.state === 'returned').length,
      ordersPending: orders.filter((o) => o.state === 'pending').length,
      stockoutTicks: this.stockouts.length,
      stockouts: this.stockouts.slice(-12),
      events: this.events.length,
      lastSeq: this.seq,
      plans: this.plans,
      claims: this.claims,
      claimedUnits: this.claimedUnits(),
      availableForClaim: this.inventory.units.available - this.claimedUnits(),
      channelOrder: this.channelOrder,
      ruleEpoch: this.ruleEpoch,
      config: this.config,
    };
  }
}
