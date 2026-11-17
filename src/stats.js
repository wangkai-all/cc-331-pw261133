/**
 * Numerical helpers for the analysis layer.
 *
 * Kept dependency-free and deterministic: the browser never fits models, but
 * tests need the same numbers every run.
 */

const LOG_FACTORIAL_CACHE = [0];

export function logFactorial(n) {
  for (let i = LOG_FACTORIAL_CACHE.length; i <= n; i += 1) {
    LOG_FACTORIAL_CACHE[i] = LOG_FACTORIAL_CACHE[i - 1] + Math.log(i);
  }
  return LOG_FACTORIAL_CACHE[n];
}

export function logBinomialPmf(n, k, p) {
  if (k < 0 || k > n) return -Infinity;
  const q = 1 - p;
  if (p <= 0) return k === 0 ? 0 : -Infinity;
  if (q <= 0) return k === n ? 0 : -Infinity;
  return (
    logFactorial(n) -
    logFactorial(k) -
    logFactorial(n - k) +
    k * Math.log(p) +
    (n - k) * Math.log(q)
  );
}

/**
 * log P(Y >= k) for Y ~ Binomial(n, p). Used for stockout intervals: the
 * observed served count is a lower bound on demand, not the demand itself.
 */
export function logBinomialTail(n, k, p) {
  if (k <= 0) return 0;
  if (k > n) return -Infinity;
  const pc = Math.min(1 - 1e-9, Math.max(1e-9, p));
  let max = -Infinity;
  const terms = [];
  for (let i = k; i <= n; i += 1) {
    const t = logBinomialPmf(n, i, pc);
    if (!Number.isFinite(t)) continue;
    terms.push(t);
    if (t > max) max = t;
  }
  if (!terms.length) return -Infinity;
  let sum = 0;
  for (const t of terms) sum += Math.exp(t - max);
  return max + Math.log(sum);
}

export function binomialMean(n, p) {
  return n * p;
}

export function sigmoid(z) {
  if (z > 35) return 1 - 1e-12;
  if (z < -35) return 1e-12;
  return 1 / (1 + Math.exp(-z));
}

export function logit(p) {
  const c = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(c / (1 - c));
}

/**
 * Nelder-Mead minimisation. Derivative-free so the censored binomial
 * likelihood (which needs a CDF tail) can be optimised without custom
 * gradients.
 */
export function nelderMead(fn, start, { maxIter = 900, tol = 1e-9, step = 0.6 } = {}) {
  const dim = start.length;
  if (dim === 0) return { x: [], value: fn([]), iterations: 0 };
  let simplex = [start.slice()];
  for (let i = 0; i < dim; i += 1) {
    const point = start.slice();
    point[i] += point[i] === 0 ? step : Math.max(step, Math.abs(point[i]) * 0.25);
    simplex.push(point);
  }
  const values = simplex.map((p) => fn(p));
  let iterations = 0;

  for (; iterations < maxIter; iterations += 1) {
    const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    simplex = order.map(([, i]) => simplex[i]);
    const sortedValues = order.map(([v]) => v);
    values.length = 0;
    values.push(...sortedValues);
    if (Math.abs(values[dim] - values[0]) < tol * (1 + Math.abs(values[0]))) break;

    const centroid = new Array(dim).fill(0);
    for (let i = 0; i < dim; i += 1) {
      for (let j = 0; j < dim; j += 1) centroid[j] += simplex[i][j] / dim;
    }
    const worst = simplex[dim];
    const reflect = centroid.map((c, j) => c + (c - worst[j]));
    const fr = fn(reflect);
    if (fr < values[0]) {
      const expand = centroid.map((c, j) => c + 2 * (c - worst[j]));
      const fe = fn(expand);
      if (fe < fr) {
        simplex[dim] = expand;
        values[dim] = fe;
      } else {
        simplex[dim] = reflect;
        values[dim] = fr;
      }
    } else if (fr < values[dim - 1]) {
      simplex[dim] = reflect;
      values[dim] = fr;
    } else {
      const contract = centroid.map((c, j) => c + 0.5 * (worst[j] - c));
      const fc = fn(contract);
      if (fc < values[dim]) {
        simplex[dim] = contract;
        values[dim] = fc;
      } else {
        for (let i = 1; i <= dim; i += 1) {
          simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j]));
          values[i] = fn(simplex[i]);
        }
      }
    }
  }
  const bestIdx = values.indexOf(Math.min(...values));
  return { x: simplex[bestIdx], value: values[bestIdx], iterations };
}

/** Numerical Hessian of a scalar function at x (central differences). */
export function numericalHessian(fn, x, h = 1e-3) {
  const k = x.length;
  const H = Array.from({ length: k }, () => new Array(k).fill(0));
  const f0 = fn(x);
  for (let i = 0; i < k; i += 1) {
    for (let j = i; j < k; j += 1) {
      let value;
      if (i === j) {
        const hi = h * (1 + Math.abs(x[i]));
        const xp = x.slice();
        const xm = x.slice();
        xp[i] += hi;
        xm[i] -= hi;
        value = (fn(xp) - 2 * f0 + fn(xm)) / (hi * hi);
      } else {
        const hi = h * (1 + Math.abs(x[i]));
        const hj = h * (1 + Math.abs(x[j]));
        const xpp = x.slice();
        const xpm = x.slice();
        const xmp = x.slice();
        const xmm = x.slice();
        xpp[i] += hi;
        xpp[j] += hj;
        xpm[i] += hi;
        xpm[j] -= hj;
        xmp[i] -= hi;
        xmp[j] += hj;
        xmm[i] -= hi;
        xmm[j] -= hj;
        value = (fn(xpp) - fn(xpm) - fn(xmp) + fn(xmm)) / (4 * hi * hj);
      }
      H[i][j] = value;
      H[j][i] = value;
    }
  }
  return H;
}

/** Invert a symmetric matrix with a small ridge fallback. */
export function invertMatrix(matrix, ridge = 1e-6) {
  const n = matrix.length;
  const A = matrix.map((row, i) => {
    const widened = new Array(2 * n).fill(0);
    for (let j = 0; j < n; j += 1) {
      widened[j] = Number.isFinite(row[j]) ? row[j] : 0;
    }
    widened[n + i] = 1;
    return widened;
  });
  for (let i = 0; i < n; i += 1) A[i][i] += ridge;
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
    }
    if (Math.abs(A[pivot][col]) < 1e-12) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    const pv = A[col][col];
    for (let j = 0; j < 2 * n; j += 1) A[col][j] /= pv;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = A[row][col];
      if (!factor) continue;
      for (let j = 0; j < 2 * n; j += 1) A[row][j] -= factor * A[col][j];
    }
  }
  return A.map((row) => row.slice(n));
}

export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return null;
  return cov / Math.sqrt(vx * vy);
}

export function variance(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
}

export function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
