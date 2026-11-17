/**
 * Analysis layer.
 *
 * Everything here works from the event log only. Latent demand is invisible to
 * it: observations are impressions, served orders and stockout flags. Two
 * estimators are offered:
 *
 *   - channel: each channel is fitted alone (own intercept and price slope),
 *     with a censored binomial likelihood. It is simple but ignores that the
 *     channels share a stock pool and ignores cross-channel price effects.
 *   - shared:  all channels are fitted jointly with channel-specific intercepts
 *     and slopes plus one shared cross-price term. Censoring thresholds follow
 *     the observed remaining stock in the channel processing order, so a tick
 *     where the pool was already empty contributes no information instead of
 *     pretending zero orders mean zero demand.
 *
 * Censored likelihood: an uncensored tick contributes P(Y = y | n, p); a tick
 * that ran out of stock contributes P(Y >= y | n, p). The latter is a bound, not
 * a measurement of lost demand.
 */

import { CHANNELS, findChannel } from './world.js';
import {
  invertMatrix,
  logBinomialPmf,
  logBinomialTail,
  logit,
  nelderMead,
  numericalHessian,
  pearson,
  sigmoid,
} from './stats.js';

export const PRIOR_SLOPE = -1.35;
export const PRIOR_CONVERSION = 0.038;

export function anchorLogPrice(channel, priceCents) {
  return Math.log(priceCents / channel.priceAnchorCents);
}

/** Prices in force at a cutoff, derived from price_changed events only. */
export function pricesAt(events, cutoffSeq = Infinity) {
  const prices = Object.fromEntries(
    CHANNELS.map((c) => [c.id, c.priceAnchorCents]),
  );
  for (const event of events) {
    if (event.seq > cutoffSeq) break;
    if (event.type !== 'price_changed') continue;
    if (!event.to) continue;
    for (const channel of CHANNELS) {
      if (Number.isFinite(event.to[channel.id])) prices[channel.id] = event.to[channel.id];
    }
  }
  return prices;
}

export function lastDayOf(events, cutoffSeq = Infinity) {
  let day = 0;
  for (const event of events) {
    if (event.seq > cutoffSeq) break;
    if (Number.isFinite(event.day)) day = Math.max(day, event.day);
  }
  return day;
}

export function cutoffSeqForDay(events, day) {
  let seq = 0;
  for (const event of events) {
    if (Number.isFinite(event.day) && event.day <= day) seq = event.seq;
  }
  return seq;
}

/**
 * Tick-level exposure rows. A row is censored when the channel hit the stock
 * limit during the tick, or started the tick with no free stock. The latter is
 * important: a stock-out tick with zero attempted purchases must not be read as
 * a zero-demand observation.
 */
export function buildRows(events, { cutoffSeq = Infinity, dayFrom = 0, dayTo = Infinity } = {}) {
  const rows = [];
  for (const event of events) {
    if (event.seq > cutoffSeq) break;
    if (event.type !== 'exposure') continue;
    if (event.day < dayFrom || event.day > dayTo) continue;
    const channel = findChannel(event.channelId);
    if (!channel) continue;
    const startedEmpty = event.availableAtStart <= 0;
    rows.push({
      seq: event.seq,
      tick: event.tick,
      day: event.day,
      hour: event.hour,
      channelId: event.channelId,
      channelShort: channel.short,
      priceCents: event.priceCents,
      planId: event.planId,
      n: event.impressions,
      y: event.orders,
      clicks: event.clicks,
      availableAtStart: event.availableAtStart,
      censored: Boolean(event.stockout) || startedEmpty,
      startedEmpty,
      atStockLimit: Boolean(event.stockout) && !startedEmpty,
    });
  }
  // Shared cross-price index: average log price of *other* channels in the same
  // tick. It is only used by the joint estimator and is fully observable.
  const byTick = new Map();
  for (const row of rows) {
    if (!byTick.has(row.tick)) byTick.set(row.tick, []);
    byTick.get(row.tick).push(row);
  }
  for (const tickRows of byTick.values()) {
    for (const row of tickRows) {
      const channel = findChannel(row.channelId);
      const others = tickRows.filter((r) => r.channelId !== row.channelId);
      const otherLog = others.length
        ? others.reduce((sum, r) => sum + anchorLogPrice(findChannel(r.channelId), r.priceCents), 0) / others.length
        : 0;
      row.ownLogPrice = anchorLogPrice(channel, row.priceCents);
      row.otherLogPrice = otherLog;
    }
  }
  return rows;
}

export function rowsForChannel(rows, channelId) {
  return rows.filter((row) => row.channelId === channelId);
}

export function observedConversion(rows) {
  const n = rows.reduce((sum, r) => sum + r.n, 0);
  const y = rows.reduce((sum, r) => sum + r.y, 0);
  return n > 0 ? y / n : null;
}

function rowLogLik(row, p, censorMode = 'censored') {
  const pc = Math.min(1 - 1e-9, Math.max(1e-9, p));
  if (!row.censored) return logBinomialPmf(row.n, row.y, pc);
  if (censorMode === 'naive') {
    // The tempting shortcut: treat every exposure tick as a complete
    // observation. Stockout ticks then look like zero-demand ticks, which is
    // exactly the trap this lab is built to expose.
    return logBinomialPmf(row.n, row.y, pc);
  }
  if (censorMode === 'drop') return 0;
  if (row.startedEmpty) return 0; // nothing was sellable: no information
  return logBinomialTail(row.n, row.y, pc);
}

function dataVariance(values) {
  if (values.length < 2) return { mean: values[0] ?? 0, variance: 0, sd: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return { mean, variance, sd: Math.sqrt(variance) };
}

function startingIntercept(rows, channel) {
  const uncensored = rows.filter((r) => !r.censored);
  const base = uncensored.length ? observedConversion(uncensored) : PRIOR_CONVERSION;
  const p = Math.min(0.35, Math.max(0.002, base || PRIOR_CONVERSION));
  return logit(p) - PRIOR_SLOPE * 0;
}

function identification(rows, channel, { priceTimeCorr, slopeSe } = {}) {
  const prices = [...new Set(rows.map((r) => r.priceCents))].sort((a, b) => a - b);
  const uncensored = rows.filter((r) => !r.censored);
  const censored = rows.filter((r) => r.censored);
  const uncensoredImpressions = uncensored.reduce((s, r) => s + r.n, 0);
  const reasons = [];
  let status = 'ok';
  const setWeak = (reason) => {
    if (status === 'ok') status = 'weak';
    reasons.push(reason);
  };
  const setDead = (reason) => {
    status = 'unidentified';
    reasons.push(reason);
  };

  if (prices.length < 2) {
    setDead('该渠道没有出现过两种以上价格，价格效应不可识别。');
  } else {
    const range = (prices[prices.length - 1] - prices[0]) / prices[0];
    if (range < 0.02) setDead('价格变动幅度不足 2%，无法与噪声区分。');
  }
  if (uncensored.length < 8 || uncensoredImpressions < 120) {
    setDead('未截断的曝光过少，缺货与价格无法分离。');
  } else if (uncensored.length < 24) {
    setWeak('未截断的样本较少，估计区间会很宽。');
  }
  const censoredShare = rows.length ? censored.length / rows.length : 0;
  if (censoredShare > 0.45) {
    setWeak(`约 ${(censoredShare * 100).toFixed(0)}% 的时段被缺货截断，估计依赖截断似然而非完整结果。`);
  }
  if (Number.isFinite(priceTimeCorr) && Math.abs(priceTimeCorr) > 0.9) {
    setWeak('价格与时间高度共线，价格效应可能混入需求趋势。');
  }
  if (slopeSe != null && !Number.isFinite(slopeSe)) {
    setWeak('斜率标准误无法计算，估计不稳定。');
  }
  return {
    status,
    reasons,
    priceLevels: prices.length,
    priceMin: prices[0] ?? null,
    priceMax: prices[prices.length - 1] ?? null,
    uncensoredRows: uncensored.length,
    censoredRows: censored.length,
    uncensoredImpressions,
    censoredShare,
    priceTimeCorr,
  };
}

function channelDiagnostics(rows) {
  const prices = [...new Set(rows.map((r) => r.priceCents))].sort((a, b) => a - b);
  const x = rows.map((r) => r.ownLogPrice);
  const days = rows.map((r) => r.day);
  const priceTimeCorr = pearson(x, days);
  return { priceLevels: prices, priceTimeCorr };
}

function applyCiCaveat(ident, elasticityCi) {
  if (!ident || !elasticityCi) return;
  // A price effect whose interval crosses zero is not evidence of an effect,
  // even when the point estimate looks large. Say so instead of printing a
  // bold number.
  if (ident.status === 'ok' && elasticityCi[0] < 0 && elasticityCi[1] > 0) {
    ident.status = 'weak';
    if (!ident.reasons.some((r) => r.includes('跨越 0'))) {
      ident.reasons.push(
        `弹性 95% 区间 [${elasticityCi[0].toFixed(2)}, ${elasticityCi[1].toFixed(2)}] 跨越 0，方向尚不确定。`,
      );
    }
  }
}

function finalizeFit({ channel, rows, params, nll, slopeFree, extraNames = [], extraValues = [] }) {
  const [a, b] = params;
  const diagnostics = channelDiagnostics(rows);
  let cov = null;
  let seA = null;
  let seB = null;
  try {
    const H = numericalHessian(nll, params);
    cov = invertMatrix(H);
    if (cov) {
      seA = Math.sqrt(Math.max(0, cov[0][0]));
      seB = slopeFree ? Math.sqrt(Math.max(0, cov[1][1])) : null;
    }
  } catch {
    cov = null;
  }
  const ident = identification(rows, channel, {
    priceTimeCorr: diagnostics.priceTimeCorr,
    slopeSe: seB,
  });
  if (!slopeFree) {
    ident.status = 'unidentified';
    if (!ident.reasons.length) ident.reasons.push('价格没有变异，斜率固定为先验。');
  }
  const currentRowPrice = rows.length ? rows[rows.length - 1].priceCents : channel.priceAnchorCents;
  const meanP = (() => {
    const predictions = rows.map((r) => sigmoid(a + b * r.ownLogPrice));
    return predictions.length ? predictions.reduce((s, p) => s + p, 0) / predictions.length : null;
  })();
  const elasticity = meanP != null ? b * (1 - meanP) : null;
  let elasticityCi = null;
  if (seB != null && meanP != null) {
    const lo = (b - 1.96 * seB) * (1 - meanP);
    const hi = (b + 1.96 * seB) * (1 - meanP);
    elasticityCi = [Math.min(lo, hi), Math.max(lo, hi)];
    applyCiCaveat(ident, elasticityCi);
  }
  return {
    channelId: channel.id,
    channelName: channel.name,
    short: channel.short,
    color: channel.color,
    anchorCents: channel.priceAnchorCents,
    currentPriceCents: currentRowPrice,
    intercept: a,
    slope: b,
    slopeFree,
    seIntercept: seA,
    seSlope: seB,
    slopeCi: seB != null ? [b - 1.96 * seB, b + 1.96 * seB] : null,
    elasticity,
    elasticityCi,
    meanConversion: meanP,
    conversionAtAnchor: sigmoid(a),
    conversionAtCurrent: sigmoid(a + b * anchorLogPrice(channel, currentRowPrice)),
    covariates: Object.fromEntries(extraNames.map((name, i) => [name, extraValues[i]])),
    identification: ident,
    rows: rows.length,
    impressions: rows.reduce((s, r) => s + r.n, 0),
    orders: rows.reduce((s, r) => s + r.y, 0),
    observedConversion: observedConversion(rows),
  };
}

export function fitChannel(rows, channel, { censorMode = 'censored' } = {}) {
  const data = rowsForChannel(rows, channel.id);
  if (!data.length) return emptyFit(channel);
  const distinctPrices = new Set(data.map((r) => r.priceCents));
  const slopeFree = distinctPrices.size >= 2;
  const b0 = PRIOR_SLOPE;
  const a0 = startingIntercept(data, channel);
  const nll = ([a, b]) => {
    let total = 0;
    for (const row of data) {
      const p = sigmoid(a + b * row.ownLogPrice);
      const ll = rowLogLik(row, p, censorMode);
      if (!Number.isFinite(ll)) return 1e12;
      total -= ll;
    }
    return total;
  };
  let params;
  if (slopeFree) {
    const fit = nelderMead(nll, [a0, b0], { maxIter: 1600, step: 0.4 });
    params = fit.x;
  } else {
    // Only the intercept is estimated; the slope stays at the prior and is
    // reported as such instead of pretending to be measured.
    const fixedNll = ([a]) => {
      let total = 0;
      for (const row of data) {
        const p = sigmoid(a + PRIOR_SLOPE * row.ownLogPrice);
        const ll = rowLogLik(row, p, censorMode);
        if (!Number.isFinite(ll)) return 1e12;
        total -= ll;
      }
      return total;
    };
    const fit = nelderMead(fixedNll, [a0], { maxIter: 900, step: 0.4 });
    params = [fit.x[0], PRIOR_SLOPE];
  }
  if (params.some((v) => !Number.isFinite(v))) {
    params = [a0, PRIOR_SLOPE];
  }
  const fit = finalizeFit({ channel, rows: data, params, nll, slopeFree });
  fit.censorMode = censorMode;
  return fit;
}

function emptyFit(channel) {
  return {
    channelId: channel.id,
    channelName: channel.name,
    short: channel.short,
    color: channel.color,
    anchorCents: channel.priceAnchorCents,
    currentPriceCents: channel.priceAnchorCents,
    intercept: logit(PRIOR_CONVERSION),
    slope: PRIOR_SLOPE,
    slopeFree: false,
    seIntercept: null,
    seSlope: null,
    slopeCi: null,
    elasticity: PRIOR_SLOPE * (1 - PRIOR_CONVERSION),
    elasticityCi: null,
    meanConversion: PRIOR_CONVERSION,
    conversionAtAnchor: PRIOR_CONVERSION,
    conversionAtCurrent: PRIOR_CONVERSION,
    covariates: {},
    identification: {
      status: 'unidentified',
      reasons: ['尚无任何该渠道的可见曝光。'],
      priceLevels: 0,
      priceMin: null,
      priceMax: null,
      uncensoredRows: 0,
      censoredRows: 0,
      uncensoredImpressions: 0,
      censoredShare: 0,
      priceTimeCorr: null,
    },
    rows: 0,
    impressions: 0,
    orders: 0,
    observedConversion: null,
  };
}

/**
 * Joint fit across channels with a shared cross-price term.
 *
 * The cross-price term is only kept when the data can identify it. In this
 * design all channels usually move together, so the term is often flat and
 * absorbing its variance would make every channel CI useless. When that
 * happens we refit the additive model (gamma = 0) and report the dropped term
 * explicitly instead of silently widening every interval.
 */
export function fitJoint(rows, { censorMode = 'censored' } = {}) {
  const channels = CHANNELS.filter((c) => rows.some((r) => r.channelId === c.id));
  if (!channels.length) {
    return {
      channels: [],
      fits: [],
      gamma: null,
      gammaCi: null,
      gammaSe: null,
      gammaIdentified: false,
      gammaDropped: true,
    };
  }
  const byChannel = new Map(channels.map((c) => [c.id, rowsForChannel(rows, c.id)]));
  const slopeHasVariation = (channel) => new Set(byChannel.get(channel.id).map((r) => r.priceCents)).size >= 2;
  const buildStart = () => {
    const start = [];
    for (const channel of channels) {
      const single = fitChannel(rows, channel, { censorMode });
      start.push(single.intercept, slopeHasVariation(channel) ? single.slope : PRIOR_SLOPE);
    }
    return start;
  };

  const nllWith = (useGamma) => (params) => {
    let total = 0;
    const gamma = useGamma ? params[params.length - 1] : 0;
    for (let i = 0; i < channels.length; i += 1) {
      const a = params[2 * i];
      const b = params[2 * i + 1];
      for (const row of byChannel.get(channels[i].id)) {
        const p = sigmoid(a + b * row.ownLogPrice + gamma * row.otherLogPrice);
        const ll = rowLogLik(row, p, censorMode);
        if (!Number.isFinite(ll)) return 1e12;
        total -= ll;
      }
    }
    return total;
  };

  const start = buildStart();
  const fullStart = [...start, 0.4];
  const fullFit = nelderMead(nllWith(true), fullStart, { maxIter: 4200, step: 0.25 });
  let fullParams = fullFit.x;
  if (fullParams.some((v) => !Number.isFinite(v))) fullParams = fullStart;
  let fullCov = null;
  try {
    fullCov = invertMatrix(numericalHessian(nllWith(true), fullParams, 1e-2), 1e-4);
  } catch {
    fullCov = null;
  }
  const gamma = fullParams[fullParams.length - 1];
  const gammaSe = fullCov ? Math.sqrt(Math.max(0, fullCov[fullCov.length - 1][fullCov.length - 1])) : null;
  const gammaIdentified =
    gammaSe != null && Number.isFinite(gammaSe) && gammaSe > 0 && Math.abs(gamma) > 1.96 * gammaSe;

  const reducedFit = gammaIdentified
    ? null
    : nelderMead(nllWith(false), start, { maxIter: 4200, step: 0.25 });
  let params = reducedFit ? reducedFit.x : fullParams;
  if (params.some((v) => !Number.isFinite(v))) params = start;
  const gammaUsed = gammaIdentified ? gamma : 0;
  let cov = null;
  try {
    cov = gammaIdentified
      ? fullCov
      : invertMatrix(numericalHessian(nllWith(false), params, 1e-2), 1e-4);
  } catch {
    cov = null;
  }

  const fits = [];
  for (let i = 0; i < channels.length; i += 1) {
    const channel = channels[i];
    const data = byChannel.get(channel.id);
    const channelParams = [params[2 * i], params[2 * i + 1]];
    const slopeFree = slopeHasVariation(channel);
    const single = finalizeFit({
      channel,
      rows: data,
      params: channelParams,
      nll: (local) => {
        let total = 0;
        for (const row of data) {
          const p = sigmoid(local[0] + local[1] * row.ownLogPrice + gammaUsed * row.otherLogPrice);
          const ll = rowLogLik(row, p, censorMode);
          if (!Number.isFinite(ll)) return 1e12;
          total -= ll;
        }
        return total;
      },
      slopeFree,
      extraNames: ['gamma'],
      extraValues: [gammaUsed],
    });
    if (cov) {
      const idxA = 2 * i;
      const idxB = 2 * i + 1;
      const seA = Math.sqrt(Math.max(0, cov[idxA][idxA]));
      const seB = slopeFree ? Math.sqrt(Math.max(0, cov[idxB][idxB])) : null;
      single.covJoint = {
        seIntercept: seA,
        seSlope: seB,
        covariance: cov[idxA][idxB],
        gammaSe,
        gammaIdentified,
        gammaDropped: !gammaIdentified,
      };
      if (seB != null && Number.isFinite(seB)) {
        single.seSlope = seB;
        single.slopeCi = [single.slope - 1.96 * seB, single.slope + 1.96 * seB];
        if (single.meanConversion != null) {
          single.elasticity = single.slope * (1 - single.meanConversion);
          single.elasticityCi = [
            (single.slope - 1.96 * seB) * (1 - single.meanConversion),
            (single.slope + 1.96 * seB) * (1 - single.meanConversion),
          ];
          applyCiCaveat(single.identification, single.elasticityCi);
        }
      }
    }
    if (!gammaIdentified) {
      single.identification.reasons.push('渠道间交叉价格项无法识别，已按 0 处理（联合模型退化为渠道固定效应）。');
    }
    fits.push(single);
  }
  return {
    channels: channels.map((c) => c.id),
    fits,
    gamma: gammaIdentified ? gamma : null,
    gammaRaw: gamma,
    gammaSe,
    gammaCi: gammaSe != null && Number.isFinite(gammaSe) ? [gamma - 1.96 * gammaSe, gamma + 1.96 * gammaSe] : null,
    gammaIdentified,
    gammaDropped: !gammaIdentified,
    gammaNote: gammaIdentified
      ? null
      : '各渠道价格同向变动，交叉价格项与渠道自身价格共线，无法从该设计中识别；已退回不含该项的联合模型。',
    nll: gammaIdentified ? fullFit.value : reducedFit.value,
    nllFull: fullFit.value,
    iterations: (gammaIdentified ? fullFit : reducedFit).iterations,
  };
}

export function priceSpells(rows) {
  const spells = [];
  for (const channel of CHANNELS) {
    const data = rowsForChannel(rows, channel.id).sort((a, b) => a.tick - b.tick);
    let current = null;
    for (const row of data) {
      if (!current || current.priceCents !== row.priceCents) {
        current = {
          channelId: channel.id,
          channelName: channel.name,
          priceCents: row.priceCents,
          fromDay: row.day,
          toDay: row.day,
          impressions: 0,
          orders: 0,
          censoredRows: 0,
          rows: 0,
          planIds: new Set(),
        };
        spells.push(current);
      }
      current.toDay = row.day;
      current.impressions += row.n;
      current.orders += row.y;
      current.rows += 1;
      if (row.censored) current.censoredRows += 1;
      if (row.planId) current.planIds.add(row.planId);
    }
  }
  return spells.map((s) => ({
    ...s,
    planIds: [...s.planIds],
    conversion: s.impressions ? s.orders / s.impressions : null,
  }));
}

/**
 * Model-based interval for latent demand given that at least `lower` orders
 * were served. Quantiles are conditional on the censoring event, so this is an
 * assumption-backed range, never a measurement.
 */
export function demandInterval(n, p, lower, level = 0.8) {
  if (!(n > 0)) return { lower: 0, upper: 0, model: 0 };
  const pc = Math.min(1 - 1e-9, Math.max(1e-9, p));
  const probs = [];
  let total = 0;
  for (let k = lower; k <= n; k += 1) {
    const logp = logBinomialPmf(n, k, pc);
    const value = Number.isFinite(logp) ? Math.exp(logp) : 0;
    probs.push([k, value]);
    total += value;
  }
  if (total <= 0) {
    return { lower, upper: n, model: n * pc };
  }
  const target = { low: (1 - level) / 2, high: 1 - (1 - level) / 2 };
  let cumulative = 0;
  let low = lower;
  let high = n;
  let foundLow = false;
  for (const [k, value] of probs) {
    const prev = cumulative;
    cumulative += value / total;
    if (!foundLow && cumulative >= target.low) {
      low = prev >= target.low ? k : k;
      foundLow = true;
    }
    if (cumulative >= target.high) {
      high = k;
      break;
    }
  }
  return { lower: Math.max(lower, low), upper: high, model: n * pc };
}

/**
 * @param events      full unified event log
 * @param method      'shared' (joint fixed effects) or 'channel' (per channel)
 * @param censorMode  'censored' uses the censored likelihood, 'drop' deletes
 *                    truncated ticks (the naive alternative shown for contrast)
 */
export function analyzeEvents(
  events,
  { method = 'shared', censorMode = 'censored', cutoffSeq = Infinity } = {},
) {
  // `null` / `undefined` / NaN all mean "no cutoff" — never coerce to 0, which
  // would hide every event (Math.min(null, seq) === 0).
  const requested = Number.isFinite(cutoffSeq) ? cutoffSeq : Infinity;
  const cut = Math.min(requested, events.length ? events[events.length - 1].seq : 0);
  const rows = buildRows(events, { cutoffSeq: cut });
  const asOfDay = lastDayOf(events, cut);
  const prices = pricesAt(events, cut);
  const joint = method === 'channel' ? null : fitJoint(rows, { censorMode });
  const channelFits =
    method === 'channel'
      ? CHANNELS.map((channel) => fitChannel(rows, channel, { censorMode }))
      : joint.fits;
  const usableFits = channelFits.filter((f) => f.rows > 0);
  const estimatedChannels = usableFits.filter((f) => f.identification.status !== 'unidentified');

  const stockoutByChannel = CHANNELS.map((channel) => {
    const data = rowsForChannel(rows, channel.id);
    const fit = channelFits.find((f) => f.channelId === channel.id);
    const observed = data.reduce((s, r) => s + r.y, 0);
    let demandEstimate = 0;
    let demandLow = 0;
    let demandHigh = 0;
    let censoredRows = 0;
    for (const row of data) {
      const p = fit ? sigmoid(fit.intercept + fit.slope * row.ownLogPrice + (fit.covariates.gamma ?? 0) * row.otherLogPrice) : PRIOR_CONVERSION;
      if (row.censored) {
        censoredRows += 1;
        const interval = demandInterval(row.n, p, row.y, 0.8);
        demandEstimate += row.startedEmpty ? row.n * p : interval.model;
        demandLow += row.startedEmpty ? 0 : interval.lower;
        demandHigh += row.startedEmpty ? row.n : interval.upper;
      } else {
        demandEstimate += row.y;
        demandLow += row.y;
        demandHigh += row.y;
      }
    }
    return {
      channelId: channel.id,
      channelName: channel.name,
      short: channel.short,
      color: channel.color,
      censoredRows,
      observedOrders: observed,
      modelDemand: demandEstimate,
      intervalLow: demandLow,
      intervalHigh: demandHigh,
      missingEstimate: Math.max(0, demandEstimate - observed),
      missingShare: demandEstimate > 0 ? Math.max(0, (demandEstimate - observed) / demandEstimate) : 0,
    };
  });

  // Channel-day aggregates for charts. Censored days remain visible, hollowed.
  const byDay = new Map();
  for (const row of rows) {
    const key = `${row.channelId}|${row.day}`;
    if (!byDay.has(key)) {
      byDay.set(key, {
        channelId: row.channelId,
        day: row.day,
        impressions: 0,
        orders: 0,
        priceSum: 0,
        priceWeight: 0,
        censored: false,
      });
    }
    const bucket = byDay.get(key);
    bucket.impressions += row.n;
    bucket.orders += row.y;
    bucket.priceSum += row.priceCents * row.n;
    bucket.priceWeight += row.n;
    if (row.censored) bucket.censored = true;
  }
  const daily = [...byDay.values()]
    .map((b) => ({
      channelId: b.channelId,
      day: b.day,
      impressions: b.impressions,
      orders: b.orders,
      conversion: b.impressions ? b.orders / b.impressions : 0,
      avgPriceCents: b.priceWeight ? Math.round(b.priceSum / b.priceWeight) : null,
      censored: b.censored,
    }))
    .sort((a, b) => a.day - b.day || a.channelId.localeCompare(b.channelId));

  const totalObserved = rows.reduce((s, r) => s + r.y, 0);
  const totalModelDemand = stockoutByChannel.reduce((s, x) => s + x.modelDemand, 0);
  return {
    method,
    censorMode,
    cutoffSeq: cut,
    asOfDay,
    rows: rows.length,
    daysCovered: [...new Set(rows.map((r) => r.day))].sort((a, b) => a - b),
    prices,
    fits: channelFits,
    joint,
    priceSpells: priceSpells(rows),
    daily,
    stockouts: stockoutByChannel,
    totals: {
      observedOrders: totalObserved,
      modelDemand: totalModelDemand,
      missingEstimate: Math.max(0, totalModelDemand - totalObserved),
      censoredRows: rows.filter((r) => r.censored).length,
      tickRows: rows.length,
    },
    estimatedChannelCount: estimatedChannels.length,
    assumptions: {
      priorSlope: PRIOR_SLOPE,
      priorConversion: PRIOR_CONVERSION,
      note: '拟合结果是需求假设下的估计，不是对未观测需求的测量；缺货时段的订单只是下界。',
    },
    dataWindow: {
      maxDay: asOfDay,
      maxSeq: cut,
      source: 'events only',
    },
  };
}

/**
 * As-of backtest: at the end of each day, fit and predict the *conversion rate*
 * for the next day using only events up to that day's close. Next-day realized
 * outcomes are used only for scoring, and censored days are reported rather
 * than scored so truncation is not counted as forecast skill.
 */
export function backtest(events, { method = 'shared', fromDay = 3, horizonDays = 2 } = {}) {
  const maxDay = lastDayOf(events);
  const windows = [];
  for (let day = fromDay; day < maxDay; day += 1) {
    const cutoffSeq = cutoffSeqForDay(events, day);
    if (!cutoffSeq) continue;
    const analysis = analyzeEvents(events, { method, cutoffSeq });
    if (analysis.rows === 0) continue;
    const prices = pricesAt(events, cutoffSeq);
    const nextRows = buildRows(events, { dayFrom: day + 1, dayTo: day + 1 });
    if (!nextRows.length) continue;
    const channelRows = [];
    for (const channel of CHANNELS) {
      const fit = analysis.fits.find((f) => f.channelId === channel.id);
      if (!fit || !fit.rows) continue;
      const realized = nextRows.filter((r) => r.channelId === channel.id);
      if (!realized.length) continue;
      const n = realized.reduce((s, r) => s + r.n, 0);
      const y = realized.reduce((s, r) => s + r.y, 0);
      const censored = realized.some((r) => r.censored);
      const priceUsed = prices[channel.id];
      const logPrice = Math.log(priceUsed / channel.priceAnchorCents);
      const gamma = fit.covariates.gamma ?? 0;
      const meanOther = realized.reduce((s, r) => s + r.otherLogPrice, 0) / realized.length;
      const logitHat = fit.intercept + fit.slope * logPrice + gamma * meanOther;
      const pHat = sigmoid(logitHat);
      let ci = null;
      const seSlope = fit.seSlope;
      const seIntercept = fit.seIntercept;
      if (seIntercept != null) {
        // When the slope is not identified it is fixed at the prior; the
        // interval then reflects intercept uncertainty only and must say so.
        const slopeVariance = seSlope != null ? seSlope ** 2 : 0;
        const covariance = fit.covJoint?.covariance ?? 0;
        const se = Math.sqrt(seIntercept ** 2 + logPrice ** 2 * slopeVariance + 2 * logPrice * covariance);
        ci = [sigmoid(logitHat - 1.96 * se), sigmoid(logitHat + 1.96 * se)];
      }
      const realizedRate = n ? y / n : null;
      const fullyCensored = censored && y === 0;
      channelRows.push({
        channelId: channel.id,
        channelName: channel.name,
        short: channel.short,
        color: channel.color,
        forecastConversion: pHat,
        forecastCi: ci,
        intervalKind: seSlope == null ? 'intercept_only' : 'full',
        realizedConversion: realizedRate,
        impressions: n,
        orders: y,
        censored,
        scored: !censored,
        priceUsedCents: priceUsed,
        fitStatus: fit.identification.status,
        absoluteError: censored || realizedRate == null ? null : Math.abs(pHat - realizedRate),
        covered: ci && realizedRate != null && !censored ? realizedRate >= ci[0] && realizedRate <= ci[1] : null,
        note: censored ? (fullyCensored ? '当日几乎全程缺货，不计误差' : '当日部分时段缺货，不计误差') : null,
      });
    }
    windows.push({
      day,
      cutoffSeq,
      asOfDay: analysis.asOfDay,
      rowsUsed: analysis.rows,
      estimatedChannelCount: analysis.estimatedChannelCount,
      channels: channelRows,
      anyCensored: channelRows.some((c) => c.censored),
    });
  }
  const scored = windows.flatMap((w) => w.channels.filter((c) => c.scored && c.absoluteError != null));
  const covered = scored.filter((c) => c.covered === true).length;
  return {
    method,
    windows,
    summary: {
      windows: windows.length,
      scoredCells: scored.length,
      mae: scored.length ? scored.reduce((s, c) => s + c.absoluteError, 0) / scored.length : null,
      coverage: scored.length ? covered / scored.length : null,
      skippedCensored: windows.flatMap((w) => w.channels).filter((c) => c.censored).length,
    },
    note: '每个窗口只使用截至当天收市的曝光、价格与缺货事件；次日实现值仅用于打分。被截断的次日不计入误差。',
  };
}

/**
 * Treatment variation summary used by the UI to explain whether a price effect
 * is identified at all. This is descriptive, not a test.
 */
export function identificationSummary(analysis) {
  const items = [];
  for (const fit of analysis.fits) {
    const { identification: id } = fit;
    let label = '可估计';
    let tone = 'ok';
    if (id.status === 'unidentified') {
      label = '不可识别';
      tone = 'bad';
    } else if (id.status === 'weak') {
      label = '弱识别';
      tone = 'warn';
    }
    items.push({
      channelId: fit.channelId,
      channelName: fit.channelName,
      label,
      tone,
      reasons: id.reasons,
      priceLevels: id.priceLevels,
      priceMin: id.priceMin,
      priceMax: id.priceMax,
      uncensoredRows: id.uncensoredRows,
      censoredRows: id.censoredRows,
      censoredShare: id.censoredShare,
      priceTimeCorr: id.priceTimeCorr,
      elasticity: fit.elasticity,
      elasticityCi: fit.elasticityCi,
    });
  }
  return items;
}
