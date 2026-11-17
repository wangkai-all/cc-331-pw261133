/**
 * Small deterministic pseudo-random helpers.
 *
 * Everything in the replay is derived from a run seed, a stream name and a few
 * coordinates. That makes a day reproducible after a reset and keeps tests
 * independent from wall-clock time.
 */

export function hashString(input) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed, ...parts) {
  return mulberry32(hashString([seed, ...parts].join('|')));
}

export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

export function gaussian(rng) {
  // Box-Muller, clamped away from zero to avoid log(0) surprises.
  const u = Math.max(rng(), 1e-9);
  const v = Math.max(rng(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function binomial(rng, n, p) {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  // Normal approximation keeps a 500-exposure day cheap.
  if (n > 120) {
    const mean = n * p;
    const sd = Math.sqrt(n * p * (1 - p));
    return Math.max(0, Math.min(n, Math.round(mean + gaussian(rng) * sd)));
  }
  let count = 0;
  for (let i = 0; i < n; i += 1) {
    if (rng() < p) count += 1;
  }
  return count;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function roundTo(value, digits = 2) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
