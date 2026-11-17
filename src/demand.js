/**
 * Demand model — the ground truth of the fictional world.
 *
 * Conversion depends on price relative to the channel anchor, on the day's
 * segment mix and on a mild cross-channel price index. The day-level shock is
 * shared by every price of that channel, so it is a confounder that an honest
 * as-of estimator must not be able to look through.
 *
 * There is deliberately no stock term in latent demand: stockouts truncate
 * observations, they do not change what customers wanted.
 */

import { SEGMENTS } from './world.js';
import { clamp, gaussian, makeRng } from './rng.js';

export function segmentMixForDay(seed, day) {
  const rng = makeRng(seed, 'segment-mix', day);
  const drift = (rng() - 0.5) * 0.06;
  const sensitive = clamp(SEGMENTS[0].share - drift, 0.18, 0.48);
  const loyal = clamp(SEGMENTS[2].share + drift * 0.5, 0.12, 0.3);
  return [
    { id: SEGMENTS[0].id, share: sensitive, multiplier: SEGMENTS[0].sensitivityMultiplier },
    { id: SEGMENTS[1].id, share: 1 - sensitive - loyal, multiplier: SEGMENTS[1].sensitivityMultiplier },
    { id: SEGMENTS[2].id, share: loyal, multiplier: SEGMENTS[2].sensitivityMultiplier },
  ];
}

/**
 * Expected orders per impression for a channel at a price, before stock is
 * considered.
 */
export function latentDemandRate({
  channel,
  priceCents,
  day,
  seed,
  scenario,
  crossPriceIndex = 1,
  availableAtStart = Infinity,
}) {
  const relative = (priceCents - channel.priceAnchorCents) / channel.priceAnchorCents;
  const mix = segmentMixForDay(seed, day);
  const noise = gaussian(makeRng(seed, 'demand-noise', channel.id, day));
  const scenarioNoise = scenario.noise || 1;

  let expected = 0;
  for (const segment of mix) {
    const sens = channel.priceSensitivity * segment.multiplier;
    // Logistic in log-price distance. The coefficient is chosen so that the
    // resulting elasticity is in the -1.5…-4 range typical for consumer
    // electronics, not so steep that a 5% discount triples demand.
    const logit =
      Math.log(channel.baseConversion / (1 - channel.baseConversion)) - sens * relative * 1.9;
    const p = 1 / (1 + Math.exp(-logit));
    const substitution = 1 + clamp((crossPriceIndex - 1) * 0.09, -0.12, 0.16);
    expected += segment.share * p * substitution;
  }
  // Very visible scarcity suppresses the purchase attempt (rationing / queue
  // behaviour). This is deliberately *not* modelled as a price effect: the
  // analyser sees it only as censoring at the stock limit.
  const scarcity = availableAtStart <= 0 ? 1 : availableAtStart < 8 ? 0.45 + availableAtStart * 0.06 : 1;
  const dayFactor = clamp(1 + noise * 0.12 * scenarioNoise, 0.55, 1.6);
  return clamp(expected * dayFactor * scarcity, 0.0004, 0.35);
}

export function trafficForDay({ channel, day, seed, scenario, worldTraffic = 1 }) {
  const trend = 1 + (scenario.trendPerDay || 0) * day;
  const weekday = scenario.seasonality?.[day % 7] ?? 1;
  const spike = (scenario.spikes || []).find((s) => s.day === day)?.multiplier ?? 1;
  const noise = 1 + gaussian(makeRng(seed, 'traffic', channel.id, day)) * 0.1 * (scenario.noise || 1);
  const base = channel.baselineTraffic * worldTraffic * trend * weekday * spike * Math.max(0.35, noise);
  return Math.max(6, Math.round(base));
}

/** Average observed price relative to anchors across channels, used for substitution. */
export function priceIndex(prices, channels) {
  const known = channels.filter((c) => Number.isFinite(prices[c.id]));
  if (!known.length) return 1;
  let sum = 0;
  for (const c of known) sum += prices[c.id] / c.priceAnchorCents;
  return sum / known.length;
}
