/**
 * Hand-rolled SVG charts.
 *
 * No chart library: the data is small, the shapes are specific (censored points,
 * confidence intervals, stepped price lines) and a library would fight the
 * design system. Each function returns a DOM node built from primitives.
 *
 * Encoding rules used across the app:
 *   - colour identifies the channel, everywhere, including tables;
 *   - a hollow ring means "censored / lower bound", a filled dot means an
 *     observed value;
 *   - shaded vertical bands mark stockout windows, never a separate colour.
 */

import { h, iconHtml, fmtPct, fmtPrice, fmtInt, fmtSignedPct, clamp } from './util.js';

const NS = 'http://www.w3.org/2000/svg';

function s(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function text(x, y, content, attrs = {}) {
  return s('text', { x, y, ...attrs }, content);
}

function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    const base = Number.isFinite(min) ? min : 0;
    return [base];
  }
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

/**
 * Multi-series line chart with optional censored (dashed) segments and stockout
 * bands. `series` = [{ id, label, color, points: [{x, y, censored}], dashed }]
 */
export function lineChart({
  series,
  xLabels = [],
  yFormat = (v) => String(v),
  yMin = null,
  yMax = null,
  height = 210,
  bands = [],
  zeroLine = false,
  area = false,
  tooltip = null,
}) {
  const width = 760;
  const pad = { top: 16, right: 16, bottom: 26, left: 48 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const all = series.flatMap((ser) => ser.points.filter((p) => Number.isFinite(p.y)));
  // Never force zero into a rate/price axis: conversion sits around 3–6% and a
  // 0-based axis flattens every line into the baseline. Callers that genuinely
  // need zero (counts, deltas) pass `yMin`/`zeroLine` explicitly.
  const values = all.map((p) => p.y);
  const rawMin = yMin ?? (values.length ? Math.min(...values) : 0);
  const rawMax = yMax ?? (values.length ? Math.max(...values) : 1);
  const padY = rawMax === rawMin ? Math.max(Math.abs(rawMax) * 0.1, 0.001) : (rawMax - rawMin) * 0.08;
  const lo = yMin ?? rawMin - padY;
  const hi = yMax ?? rawMax + padY;
  const ticks = niceTicks(lo, hi, 4);
  const yLo = yMin ?? Math.min(lo, ticks[0]);
  const yHi = yMax ?? Math.max(hi, ticks[ticks.length - 1]);
  const xs = all.length ? all.map((p) => p.x) : [0];
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs, xMin + 1);
  const xScale = (x) => pad.left + ((x - xMin) / (xMax - xMin || 1)) * plotW;
  const yScale = (y) => pad.top + plotH - ((y - yLo) / (yHi - yLo || 1)) * plotH;

  const svg = s('svg', {
    class: 'chart',
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
  });

  for (const tick of ticks) {
    const y = yScale(tick);
    svg.append(s('line', { class: 'grid-line', x1: pad.left, x2: width - pad.right, y1: y, y2: y }));
    svg.append(text(pad.left - 8, y + 3, yFormat(tick), { 'text-anchor': 'end', class: 'axis-label' }));
  }

  if (zeroLine) {
    const y = yScale(0);
    svg.append(
      s('line', {
        x1: pad.left,
        x2: width - pad.right,
        y1: y,
        y2: y,
        stroke: '#3a4b58',
        'stroke-width': 1,
        'stroke-dasharray': '3 3',
      }),
    );
  }

  for (const band of bands) {
    const x0 = xScale(band.from);
    const x1 = xScale(band.to);
    svg.append(
      s('rect', {
        x: Math.min(x0, x1),
        y: pad.top,
        width: Math.max(1, Math.abs(x1 - x0)),
        height: plotH,
        fill: 'rgba(228,121,109,0.09)',
      }),
    );
  }

  const labelEvery = Math.max(1, Math.ceil(xLabels.length / 9));
  xLabels.forEach((label, i) => {
    if (i % labelEvery !== 0 && i !== xLabels.length - 1) return;
    const x = xScale(i);
    svg.append(text(x, height - 8, label, { 'text-anchor': 'middle', class: 'axis-label' }));
  });

  for (const ser of series) {
    const pts = ser.points.filter((p) => Number.isFinite(p.y));
    if (!pts.length) continue;
    const path = [];
    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i];
      path.push(`${i === 0 ? 'M' : 'L'}${xScale(p.x).toFixed(1)},${yScale(p.y).toFixed(1)}`);
    }
    if (area) {
      const first = pts[0];
      const last = pts[pts.length - 1];
      const areaPath = `${path.join(' ')} L${xScale(last.x).toFixed(1)},${yScale(yLo).toFixed(1)} L${xScale(
        first.x,
      ).toFixed(1)},${yScale(yLo).toFixed(1)} Z`;
      svg.append(s('path', { d: areaPath, fill: ser.color, opacity: 0.08 }));
    }
    svg.append(
      s('path', {
        d: path.join(' '),
        fill: 'none',
        stroke: ser.color,
        'stroke-width': ser.width ?? 1.8,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
        'stroke-dasharray': ser.dashed ? '4 4' : null,
        opacity: ser.dim ? 0.55 : 1,
      }),
    );
    if (ser.dots !== false) {
      for (const p of pts) {
        if (p.censored) {
          svg.append(
            s('circle', {
              cx: xScale(p.x),
              cy: yScale(p.y),
              r: 3,
              fill: '#0b1014',
              stroke: ser.color,
              'stroke-width': 1.4,
            }),
          );
        }
      }
    }
  }

  // Invisible hover bands: one per x index, showing a shared tooltip.
  if (tooltip) {
    const n = xLabels.length;
    for (let i = 0; i < n; i += 1) {
      const x = xScale(i);
      const bandW = plotW / Math.max(1, n - 1);
      const rect = s('rect', {
        class: 'hover-band',
        x: x - bandW / 2,
        y: pad.top,
        width: bandW,
        height: plotH,
      });
      rect.addEventListener('mouseenter', () => tooltip.show(i, x));
      rect.addEventListener('mousemove', () => tooltip.move(x));
      rect.addEventListener('mouseleave', () => tooltip.hide());
      svg.append(rect);
    }
  }

  const wrap = h('div', { class: 'chart-wrap' }, svg);
  if (tooltip) wrap.append(tooltip.node);
  return wrap;
}

/**
 * Share-of-stock chart: stacked bars for available / held / committed at a
 * sequence of ticks, with stockout ticks marked underneath.
 */
export function inventoryChart({ timeline, stockoutTicks = [], height = 150, totalUnits }) {
  const width = 760;
  const pad = { top: 12, right: 12, bottom: 20, left: 32 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const rows = timeline.map((row) => ({
    ...row,
    available: Number(row.available) || 0,
    held: Number(row.held) || 0,
    committed: Number(row.committed) || 0,
  }));
  const max = Math.max(totalUnits || 1, ...rows.map((r) => r.available + r.held + r.committed));
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}` });
  const n = Math.max(1, rows.length);
  const barW = Math.max(1, plotW / n - 0.6);
  rows.forEach((row, i) => {
    const x = pad.left + (i / n) * plotW;
    const avail = (row.available / max) * plotH;
    const held = (row.held / max) * plotH;
    const committed = (row.committed / max) * plotH;
    let y = pad.top + plotH;
    if (avail > 0) {
      svg.append(s('rect', { x, y: y - avail, width: barW, height: avail, fill: '#3fae96', opacity: 0.85 }));
      y -= avail;
    }
    if (held > 0) {
      svg.append(s('rect', { x, y: y - held, width: barW, height: held, fill: '#b08a4e', opacity: 0.9 }));
      y -= held;
    }
    if (committed > 0) {
      svg.append(s('rect', { x, y: y - committed, width: barW, height: committed, fill: '#3d5468' }));
      y -= committed;
    }
  });
  for (const tick of stockoutTicks) {
    const idx = rows.findIndex((r) => r.tick === tick);
    if (idx < 0) continue;
    const x = pad.left + (idx / n) * plotW + barW / 2;
    svg.append(
      s('circle', { cx: x, cy: pad.top + plotH + 7, r: 2, fill: '#e4796d' }),
    );
  }
  svg.append(
    s('line', {
      x1: pad.left,
      x2: width - pad.right,
      y1: pad.top + plotH,
      y2: pad.top + plotH,
      stroke: '#24313c',
    }),
  );
  svg.append(
    text(pad.left - 6, pad.top + 8, fmtInt(max), { 'text-anchor': 'end', class: 'axis-label' }),
  );
  return h('div', { class: 'chart-wrap' }, svg);
}

/**
 * Conversion rate by day, one line per channel. Censored days are drawn as
 * hollow dots on a dashed continuation: the observed rate is a floor, not a
 * measurement.
 */
export function dailyConversionChart({ daily, channels, days, height = 230, tooltipFactory }) {
  const byChannel = new Map();
  for (const channel of channels) {
    const points = [];
    for (const day of days) {
      const row = daily.find((d) => d.channelId === channel.id && d.day === day);
      points.push({
        x: day,
        y: row ? row.conversion : null,
        censored: row?.censored ?? false,
        raw: row,
      });
    }
    byChannel.set(channel.id, points);
  }
  const series = channels.map((channel) => ({
    id: channel.id,
    label: channel.name,
    color: channel.color,
    points: byChannel.get(channel.id),
  }));
  const labels = days.map((d) => `D${d + 1}`);
  const tooltip = tooltipFactory ? tooltipFactory({ days, series }) : null;
  return lineChart({
    series,
    xLabels: labels,
    yFormat: (v) => fmtPct(v, 2),
    height,
    tooltip,
  });
}

export function tooltipNode() {
  return h('div', { class: 'chart-tooltip', id: `tt-${Math.random().toString(36).slice(2, 8)}` });
}

/**
 * Price-vs-time chart: a step line for each channel, so the moment a plan was
 * applied is visually obvious.
 */
export function priceStepChart({ spells, channels, days, height = 160 }) {
  const series = channels.map((channel) => {
    const own = spells.filter((s) => s.channelId === channel.id).sort((a, b) => a.fromDay - b.fromDay);
    const points = [];
    for (const spell of own) {
      points.push({ x: spell.fromDay, y: spell.priceCents / 100 });
      points.push({ x: spell.toDay, y: spell.priceCents / 100 });
    }
    return { id: channel.id, color: channel.color, points, dots: false };
  });
  return lineChart({
    series,
    xLabels: days.map((d) => `D${d + 1}`),
    yFormat: (v) => `¥${v.toFixed(0)}`,
    height,
  });
}

/** Horizontal lollipop with an interval: elasticity point estimate. */
export function lollipopRow({ label, color, value, ci, min, max, status, valueLabel }) {
  const span = max - min || 1;
  const pos = (v) => clamp(((v - min) / span) * 100, 0, 100);
  const zero = pos(0);
  const track = h('div', { class: 'lollipop-track' });
  track.append(h('i', { class: 'zero', style: { left: `${zero}%` } }));
  if (ci) {
    const lo = pos(Math.max(min, ci[0]));
    const hi = pos(Math.min(max, ci[1]));
    track.append(
      h('i', {
        class: 'range',
        style: { left: `${Math.min(lo, hi)}%`, width: `${Math.max(1, Math.abs(hi - lo))}%` },
      }),
    );
  }
  const point = h('i', {
    class: `point ${status && status !== 'ok' ? status : ''}`,
    style: { left: `${pos(value)}%`, background: status && status !== 'ok' ? undefined : color },
    title: valueLabel || String(value),
  });
  track.append(point);
  return h(
    'div',
    { class: 'lollipop-row' },
    h('div', { class: 'small' }, label),
    track,
    h('div', { class: 'num small right', style: { color } }, valueLabel || (value == null ? '—' : value.toFixed(2))),
  );
}

export function legend(items) {
  return h(
    'div',
    { class: 'chart-legend' },
    items.map((item) =>
      h('span', {}, h('i', { style: { background: item.color } }), item.label),
    ),
  );
}

export function barRow({ label, value, max, color, valueLabel }) {
  const pct = max > 0 ? clamp((value / max) * 100, 0, 100) : 0;
  return h(
    'div',
    { class: 'bar-row' },
    h('span', { class: 'muted' }, label),
    h('div', { class: 'track' }, h('i', { style: { width: `${pct}%`, background: color } })),
    h('span', { class: 'val' }, valueLabel),
  );
}

export { iconHtml, s as svgEl };
