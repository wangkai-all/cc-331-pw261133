/**
 * Test suite for the replay core.
 *
 * Run with `npm test` (node:test, no dependencies).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ReplayEngine } from '../src/engine.js';
import {
  DEMAND_SCENARIOS,
  CHANNELS,
  MAX_DAYS,
  SKU,
} from '../src/world.js';
import { Inventory } from '../src/inventory.js';
import { buildRulebook, RULE_EPOCHS } from '../src/rules.js';
import { rulesSnapshotFor, validatePlan, PLAN_STATUS } from '../src/plans.js';
import { analyzeEvents, backtest, buildRows } from '../src/analysis.js';
import { LabSession } from '../src/session.js';
import { invertMatrix, logBinomialTail, numericalHessian, sigmoid } from '../src/stats.js';

function runEngine(config = {}) {
  const engine = new ReplayEngine({ config: { openingUnits: 420, ...config } });
  while (!engine.isComplete) engine.step();
  return engine;
}

function confirmedPlan(engine, prices, units = 60) {
  const plan = engine.addPlan({ name: 'test plan', prices });
  const snapshot = rulesSnapshotFor(plan, engine.rulebook);
  engine.confirm(plan.id, {
    rulesSnapshot: snapshot,
    confirmation: { ruleEpoch: engine.ruleEpoch },
    claim: { units },
  });
  return engine.findPlan(plan.id);
}

test('inventory never borrows a unit twice, through holds/cancels/returns', () => {
  const engine = runEngine();
  const invariant = engine.inventory.checkInvariant();
  assert.equal(invariant.ok, true, 'onHand must equal opening units');
  const snapshot = engine.inventory.snapshot();
  assert.ok(snapshot.available >= 0);
  assert.ok(snapshot.held >= 0);
  assert.ok(snapshot.committed >= 0);
  assert.equal(snapshot.available + snapshot.held + snapshot.committed, snapshot.openingUnits);
  assert.ok(snapshot.cancelledReleased > 0, 'some holds should be cancelled and released');
  assert.ok(snapshot.returned > 0, 'some paid orders should be returned');
});

test('every release is matched by a hold and every commit by a payment', () => {
  const engine = runEngine();
  const releases = engine.events.filter((e) => e.type === 'inventory_release');
  const cancels = engine.events.filter((e) => e.type === 'order_cancelled' || e.type === 'order_expired');
  assert.equal(releases.length, cancels.length);
  const commits = engine.events.filter((e) => e.type === 'inventory_commit');
  const pays = engine.events.filter((e) => e.type === 'order_paid');
  assert.equal(commits.length, pays.length);
});

test('stockouts truncate observations but not the inventory invariant', () => {
  const engine = runEngine({ openingUnits: 120, demandScenario: 'surge' });
  assert.ok(engine.stockouts.length > 0, 'the surge scenario must run out of stock');
  const rows = buildRows(engine.events);
  const censored = rows.filter((r) => r.censored);
  assert.ok(censored.length > 0);
  // A censored tick must be recorded as a stockout, not as zero demand.
  assert.ok(
    censored.every((r) => r.atStockLimit || r.startedEmpty),
    'censoring must be traceable to a stock limit',
  );
  const invariant = engine.inventory.checkInvariant();
  assert.equal(invariant.ok, true);
});

test('event log never contains latent demand', () => {
  const engine = runEngine({ openingUnits: 200 });
  const forbidden = ['demand', 'latent', 'intended', 'truth'];
  for (const event of engine.events) {
    const text = JSON.stringify(event).toLowerCase();
    for (const word of forbidden) {
      assert.ok(!text.includes(word), `event ${event.type} leaked "${word}"`);
    }
  }
});

test('replay is deterministic for a seed and save/restore resumes identically', () => {
  const a = runEngine();
  const b = runEngine();
  assert.deepEqual(
    a.events.map((e) => ({ t: e.type, s: e.seq, d: e.day, h: e.hour })),
    b.events.map((e) => ({ t: e.type, s: e.seq, d: e.day, h: e.hour })),
  );
  assert.equal(a.summary().ordersPaid, b.summary().ordersPaid);

  const partial = new ReplayEngine({ config: { openingUnits: 420 } });
  for (let i = 0; i < 90; i += 1) partial.step();
  const restored = ReplayEngine.fromJSON(JSON.parse(JSON.stringify(partial.toJSON())));
  for (let i = 0; i < 40; i += 1) restored.step();
  const continuous = new ReplayEngine({ config: { openingUnits: 420 } });
  for (let i = 0; i < 130; i += 1) continuous.step();
  assert.deepEqual(
    restored.events.slice(90).map((e) => e.seq),
    continuous.events.slice(90).map((e) => e.seq),
  );
  assert.deepEqual(
    restored.events.slice(90, 130),
    continuous.events.slice(90, 130),
    'restored replay must match the continuously-run replay event for event',
  );
});

test('different demand scenarios change the replay', () => {
  const steady = runEngine({ demandScenario: 'steady' });
  const surge = runEngine({ demandScenario: 'surge' });
  assert.notEqual(steady.summary().ordersPaid, surge.summary().ordersPaid);
  assert.ok(surge.stockouts.length >= steady.stockouts.length);
});

test('channel processing order changes who gets scarce stock', () => {
  const forward = runEngine({ openingUnits: 90, channelOrder: CHANNELS.map((c) => c.id) });
  const reversed = runEngine({
    openingUnits: 90,
    channelOrder: [...CHANNELS.map((c) => c.id)].reverse(),
  });
  const forwardPaid = forward.summary().ordersPaid;
  const reversedPaid = reversed.summary().ordersPaid;
  assert.ok(forwardPaid > 0 && reversedPaid > 0);
  const forwardByChannel = paidByChannel(forward);
  const reversedByChannel = paidByChannel(reversed);
  const forwardFirst = CHANNELS[0].id;
  const forwardLast = CHANNELS[CHANNELS.length - 1].id;
  assert.ok(
    forwardByChannel[forwardFirst] >= reversedByChannel[forwardFirst],
    'the first channel in processing order should get at least as many units',
  );
  assert.ok(
    forwardByChannel[forwardLast] <= reversedByChannel[forwardLast],
    'the last channel should get fewer units when it is served first',
  );
});

function paidByChannel(engine) {
  const counts = {};
  for (const order of engine.orders.values()) {
    if (order.state !== 'paid' && order.state !== 'returned') continue;
    counts[order.channelId] = (counts[order.channelId] || 0) + 1;
  }
  return counts;
}

test('rules guardrails block below-floor, above-ceiling and thin-margin prices', () => {
  const engine = new ReplayEngine();
  const rulebook = buildRulebook(0);
  const tooCheap = engine.addPlan({
    name: 'too cheap',
    prices: { 'CH-MKT': 5000, 'CH-WEB': 13300, 'CH-APP': 12500, 'CH-OUT': 11900 },
  });
  const result = validatePlan(tooCheap, { rulebook, inventory: engine.inventory, claims: [] });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.code === 'below_floor'));
  assert.ok(result.blockers.some((b) => b.code === 'margin_floor'));

  const tooExpensive = engine.addPlan({
    name: 'too expensive',
    prices: { 'CH-MKT': 20000, 'CH-WEB': 13300, 'CH-APP': 12500, 'CH-OUT': 11900 },
  });
  const second = validatePlan(tooExpensive, { rulebook, inventory: engine.inventory, claims: [] });
  assert.ok(second.blockers.some((b) => b.code === 'above_ceiling'));
});

test('rule epoch change invalidates confirmed plans', () => {
  const engine = new ReplayEngine();
  const plan = confirmedPlan(engine, {
    'CH-MKT': 12100,
    'CH-WEB': 13300,
    'CH-APP': 12500,
    'CH-OUT': 11900,
  });
  assert.equal(engine.applyPlan(plan.id).ok, true);
  const stale = confirmedPlan(engine, {
    'CH-MKT': 11500,
    'CH-WEB': 13300,
    'CH-APP': 12500,
    'CH-OUT': 11900,
  });
  engine.ruleEpoch = 1;
  engine.rulebook = buildRulebook(1);
  const invalidated = engine.markRulesStale();
  assert.ok(invalidated.includes(stale.id));
  const attempt = engine.applyPlan(stale.id);
  assert.equal(attempt.ok, false);
  assert.match(attempt.error, /规则/);
});

test('a superseded plan cannot be applied again', () => {
  const engine = new ReplayEngine();
  const first = confirmedPlan(engine, {
    'CH-MKT': 12100,
    'CH-WEB': 13300,
    'CH-APP': 12500,
    'CH-OUT': 11900,
  });
  const second = confirmedPlan(engine, {
    'CH-MKT': 11900,
    'CH-WEB': 13100,
    'CH-APP': 12300,
    'CH-OUT': 11700,
  });
  assert.equal(engine.applyPlan(first.id).ok, true);
  assert.equal(engine.applyPlan(second.id).ok, true);
  assert.equal(engine.findPlan(first.id).status, PLAN_STATUS.SUPERSEDED);
  assert.equal(engine.findPlan(first.id).supersededBy, second.id);
  const retry = engine.applyPlan(first.id);
  assert.equal(retry.ok, false);
  assert.match(retry.error, /取代/);
});

test('claims cannot exceed free stock when confirming parallel plans', () => {
  const engine = new ReplayEngine({ config: { openingUnits: 100 } });
  const rulebook = buildRulebook(0);
  const a = engine.addPlan({ name: 'a', prices: { 'CH-MKT': 12100, 'CH-WEB': 13300, 'CH-APP': 12500, 'CH-OUT': 11900 } });
  const b = engine.addPlan({ name: 'b', prices: { 'CH-MKT': 11900, 'CH-WEB': 13100, 'CH-APP': 12300, 'CH-OUT': 11700 } });
  const first = validatePlan(a, { rulebook, inventory: engine.inventory, claims: [], claimUnits: 70 });
  assert.equal(first.ok, true);
  engine.confirm(a.id, {
    rulesSnapshot: rulesSnapshotFor(a, rulebook),
    confirmation: { ruleEpoch: 0 },
    claim: { units: 70 },
  });
  const second = validatePlan(b, {
    rulebook,
    inventory: engine.inventory,
    claims: engine.claims,
    claimUnits: 60,
  });
  assert.equal(second.ok, false);
  assert.ok(second.blockers.some((x) => x.code === 'claim_exceeds_free_stock'));
});

test('censored likelihood differs from naive treatment when stock runs out', () => {
  // Stock runs out partway through a discount, so the discount period is
  // *mostly* observed through censored ticks. Treating those ticks as complete
  // observations flips the price slope positive (the classic trap).
  const engine = new ReplayEngine({ config: { openingUnits: 420 } });
  for (let i = 0; i < 30; i += 1) engine.step();
  const plan = confirmedPlan(engine, {
    'CH-MKT': 11500,
    'CH-WEB': 12300,
    'CH-APP': 11300,
    'CH-OUT': 10900,
  });
  engine.applyPlan(plan.id);
  while (!engine.isComplete) engine.step();
  const naive = analyzeEvents(engine.events, { method: 'channel', censorMode: 'naive' });
  const censored = analyzeEvents(engine.events, { method: 'channel', censorMode: 'censored' });
  const naiveSlopes = naive.fits.map((f) => f.slope);
  const censoredSlopes = censored.fits.map((f) => f.slope);
  assert.ok(
    naiveSlopes.every((s) => s > 0),
    'ignoring censoring should produce the classic "discount reduces sales" sign flip',
  );
  assert.ok(
    censoredSlopes.filter((s) => s < 0).length >= 3,
    'the censored likelihood should recover negative price slopes for most channels',
  );
  assert.ok(
    censoredSlopes.reduce((a, b) => a + b, 0) < naiveSlopes.reduce((a, b) => a + b, 0),
    'censored slopes must be materially lower than naive slopes',
  );
});

test('analysis at a cutoff does not use future events', () => {
  const engine = runEngine({ openingUnits: 420 });
  const cutoff = engine.events[Math.floor(engine.events.length / 2)].seq;
  const asOf = analyzeEvents(engine.events, { cutoffSeq: cutoff });
  assert.ok(asOf.dataWindow.maxSeq <= cutoff);
  assert.ok(asOf.daysCovered.every((d) => d < MAX_DAYS));
  // Feeding only the prefix must give exactly the same numbers.
  const prefix = engine.events.filter((e) => e.seq <= cutoff);
  const prefixAnalysis = analyzeEvents(prefix);
  assert.deepEqual(
    prefixAnalysis.fits.map((f) => f.slope),
    asOf.fits.map((f) => f.slope),
  );
});

test('backtest windows only look backwards', () => {
  const engine = runEngine({ openingUnits: 600 });
  const result = backtest(engine.events, { method: 'channel' });
  assert.ok(result.windows.length > 0);
  for (const window of result.windows) {
    assert.ok(window.cutoffSeq > 0);
    for (const cell of window.channels) {
      if (cell.censored) {
        assert.equal(cell.scored, false);
      }
    }
  }
  assert.ok(result.summary.scoredCells > 0);
  assert.ok(result.summary.mae != null);
});

test('matrix inversion and binomial tail are numerically sound', () => {
  const inv = invertMatrix([[4, 1], [1, 3]], 0);
  assert.ok(Math.abs(inv[0][0] - 3 / 11) < 1e-9);
  assert.ok(Math.abs(inv[0][1] + 1 / 11) < 1e-9);
  const tail = logBinomialTail(20, 12, 0.4);
  const pmf = (k, n, p) =>
    Math.exp(
      (() => {
        const lf = (x) => {
          let s = 0;
          for (let i = 2; i <= x; i += 1) s += Math.log(i);
          return s;
        };
        return lf(n) - lf(k) - lf(n - k) + k * Math.log(p) + (n - k) * Math.log(1 - p);
      })(),
    );
  let manual = 0;
  for (let k = 12; k <= 20; k += 1) manual += pmf(k, 20, 0.4);
  assert.ok(Math.abs(Math.exp(tail) - manual) < 1e-9);
  const H = numericalHessian(([x, y]) => x * x + 3 * y * y + x * y, [0.5, -0.5]);
  assert.ok(Math.abs(H[0][0] - 2) < 1e-4);
  assert.ok(Math.abs(H[1][1] - 6) < 1e-4);
  assert.ok(Math.abs(H[0][1] - 1) < 1e-4);
});

test('session guardrails: confirmation needs fresh prices and sufficient claim', () => {
  const session = new LabSession({ config: { openingUnits: 300 } });
  const created = session.createPlan({ name: '会话草稿' });
  const planId = created.plan.id;
  session.editPlan(planId, { prices: { 'CH-MKT': 12000 } });
  const stale = session.confirmPlan(planId, {
    claimUnits: 40,
    expectedPrices: { ...created.plan.prices },
    acknowledge: true,
  });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /不一致|拒绝/);

  const fresh = session.state().plans.find((p) => p.id === planId);
  const ok = session.confirmPlan(planId, {
    claimUnits: 40,
    expectedPrices: fresh.prices,
    expectedRevision: fresh.revision,
    acknowledge: true,
  });
  assert.equal(ok.ok, true);
  const applied = session.applyPlan(planId);
  assert.equal(applied.ok, true);
  assert.equal(session.state().appliedPlanId, planId);
});

test('session simulation is a projection and does not mutate the live log', () => {
  const session = new LabSession({ config: { openingUnits: 420 } });
  const before = session.engine.events.length;
  const created = session.createPlan({ name: '试算' });
  const result = session.simulate(created.plan.id, { horizonTicks: 18 });
  assert.equal(result.kind, 'scenario_projection');
  assert.equal(session.engine.events.length, before, 'a dry run must not write events');
  assert.ok(result.candidate.ordersPaid >= 0);
  assert.ok(result.disclaimer.includes('不是实验结果'));
});

test('scenario runs are reproducible from the same seed', () => {
  const a = runEngine({ demandScenario: 'choppy' });
  const b = runEngine({ demandScenario: 'choppy' });
  assert.equal(a.summary().ordersPaid, b.summary().ordersPaid);
  assert.equal(a.summary().revenueCents, b.summary().revenueCents);
});

test('all configured scenarios stay within the inventory invariant', () => {
  for (const scenario of DEMAND_SCENARIOS) {
    const engine = runEngine({ demandScenario: scenario.id, openingUnits: 250 });
    assert.equal(engine.inventory.checkInvariant().ok, true, scenario.id);
  }
});

test('price change mid-run creates identifyable price variation', () => {
  const engine = new ReplayEngine({ config: { openingUnits: 800 } });
  for (let i = 0; i < 84; i += 1) engine.step();
  const plan = confirmedPlan(engine, {
    'CH-MKT': 11500,
    'CH-WEB': 12300,
    'CH-APP': 11300,
    'CH-OUT': 10900,
  });
  assert.equal(engine.applyPlan(plan.id).ok, true);
  while (!engine.isComplete) engine.step();
  const analysis = analyzeEvents(engine.events, { method: 'shared' });
  const identified = analysis.fits.filter((f) => f.identification.status !== 'unidentified');
  assert.ok(identified.length >= 3, 'channels with two price levels should be estimated');
  const negative = identified.filter((f) => f.slope < 0);
  assert.ok(negative.length >= 3, 'estimated slopes should be negative');
});

test('no-price-variation runs report the effect as unidentified', () => {
  const engine = runEngine({ openingUnits: 600 });
  const analysis = analyzeEvents(engine.events, { method: 'shared' });
  assert.equal(analysis.estimatedChannelCount, 0);
  for (const fit of analysis.fits) {
    assert.equal(fit.identification.status, 'unidentified');
    assert.match(fit.identification.reasons.join(' '), /价格/);
  }
});

test('undo and checkpoints restore the past, not the present', () => {
  const session = new LabSession({ config: { openingUnits: 600 } });
  for (let i = 0; i < 12; i += 1) session.engine.step();
  const checkpoint = session.saveCheckpoint('第 3 天');
  assert.equal(checkpoint.checkpoint.tick, 12);

  const created = session.createPlan({ name: '上线测试' });
  const planId = created.plan.id;
  session.editPlan(planId, { prices: { 'CH-MKT': 11600 } });
  const fresh = session.state().plans.find((p) => p.id === planId);
  assert.equal(
    session.confirmPlan(planId, {
      claimUnits: 60,
      expectedPrices: fresh.prices,
      expectedRevision: fresh.revision,
      acknowledge: true,
    }).ok,
    true,
  );
  assert.equal(session.applyPlan(planId).ok, true);
  assert.equal(session.state().appliedPlanId, planId);

  // Export must be a snapshot: mutating the engine afterwards cannot change it.
  const snapshot = session.exportState();
  session.editPlan(planId, { prices: { 'CH-OUT': 10100 } });
  assert.equal(
    snapshot.engine.plans.find((p) => p.id === planId).prices['CH-OUT'],
    fresh.prices['CH-OUT'],
    'exportState must deep-copy, not alias live plans',
  );

  assert.equal(session.undo().ok, true);
  const afterUndo = session.state();
  assert.notEqual(afterUndo.appliedPlanId, planId, 'undo must return to the previous applied plan');
  assert.equal(afterUndo.plans.find((p) => p.id === planId).status, 'confirmed');

  while (session.engine.tick < 24) session.engine.step();
  const restored = session.restoreCheckpoint(checkpoint.checkpoint.id);
  assert.equal(restored.ok, true);
  assert.equal(session.engine.tick, 12, 'checkpoint restore must rewind the clock');
  assert.equal(session.engine.orders.size < 60, true, 'checkpoint restore must drop later orders');
});

test('pending orders do not leak their future cancellation verdict', () => {
  const session = new LabSession({ config: { openingUnits: 600 } });
  for (let i = 0; i < 40; i += 1) session.engine.step();
  const listed = session.orders({ limit: 400 }).orders;
  assert.ok(listed.length > 20);
  assert.equal(listed.some((o) => 'willCancel' in o), false, 'willCancel is an internal future fact');
  assert.equal(
    listed.some((o) => o.state !== 'cancelled' && o.cancelReason),
    false,
    'only cancelled orders may carry a cancellation reason',
  );
  const pending = listed.filter((o) => o.state === 'pending')[0];
  if (pending) assert.equal(session.orderJourney(pending.id).order.cancelReason, null);
});

test('analysis treats a null cutoff as "everything visible now"', () => {
  const session = new LabSession({ config: { openingUnits: 600 } });
  for (let i = 0; i < 30; i += 1) session.engine.step();
  const none = session.analysis();
  const explicit = session.analysis({ cutoffSeq: session.engine.seq });
  assert.ok(none.rows > 0, 'no cutoff must not collapse the window to zero rows');
  assert.equal(none.rows, explicit.rows);
  assert.equal(none.fits.every((f) => f.rows > 0), true);

  const early = session.analysis({ cutoffSeq: 60 });
  assert.ok(early.rows < none.rows, 'an explicit early cutoff must narrow the window');
});

test('elasticity whose interval crosses zero is reported as weak, not identified', () => {
  const engine = new ReplayEngine({ config: { openingUnits: 800 } });
  for (let i = 0; i < 84; i += 1) engine.step();
  const plan = confirmedPlan(engine, {
    'CH-MKT': 11500,
    'CH-WEB': 12300,
    'CH-APP': 11300,
    'CH-OUT': 10900,
  });
  engine.applyPlan(plan.id);
  while (!engine.isComplete) engine.step();
  const analysis = analyzeEvents(engine.events, { method: 'shared' });
  for (const fit of analysis.fits) {
    if (!fit.elasticityCi || fit.identification.status === 'unidentified') continue;
    const crossesZero = fit.elasticityCi[0] < 0 && fit.elasticityCi[1] > 0;
    assert.equal(
      fit.identification.status === 'ok',
      !crossesZero,
      `${fit.channelId}: CI ${fit.elasticityCi.map((v) => v.toFixed(2)).join(',')} must not be called ok`,
    );
  }
});

test('level 1 events are all JSON-serialisable', () => {
  const engine = new ReplayEngine();
  for (let i = 0; i < 12; i += 1) engine.step();
  assert.doesNotThrow(() => JSON.stringify(engine.events));
  assert.doesNotThrow(() => JSON.stringify(engine.summary()));
  assert.ok(SKU.unitCostCents < SKU.referencePriceCents);
  assert.equal(MAX_DAYS * 6, engine.summary().maxTicks);
});
