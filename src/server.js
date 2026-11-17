#!/usr/bin/env node
/**
 * Zero-dependency HTTP server: static files + JSON API.
 *
 * The design is deliberately boring. One in-process session per server (the lab
 * is a single-user teaching tool), a tiny router, and static file serving from
 * `public/`. No external calls, no database, no hidden state outside the
 * session object.
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { LabSession, createSession, defaultPrices } from './session.js';
import { runComparison } from './simulate.js';
import { CHANNELS, DEMAND_SCENARIOS, MAX_DAYS, SKU } from './world.js';
import { RULE_EPOCHS } from './rules.js';

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = resolve(process.cwd(), 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

let session = createSession({ openingUnits: 420 });

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('JSON 解析失败');
  }
}

const routes = {
  'GET /api/meta': () => ({
    sku: SKU,
    channels: CHANNELS,
    scenarios: DEMAND_SCENARIOS,
    maxDays: MAX_DAYS,
    ruleEpochs: RULE_EPOCHS,
    defaultPrices: defaultPrices(),
    disclaimer:
      '全部数据为虚构回放。应用不连接任何真实销售、库存或支付系统；所有“实验”只在本进程中推演。',
  }),
  'GET /api/state': (req, url) => {
    const includeEvents = url.searchParams.get('events') === '1';
    return session.state({ includeEvents });
  },
  'POST /api/session/reset': (req, url, body) => {
    session.reset(body?.config || {});
    return { ok: true, state: session.state() };
  },
  'POST /api/session/config': (req, url, body) => {
    const allowed = ['openingUnits', 'demandScenario', 'baseTrafficMultiplier', 'seed', 'returnRate', 'holdTtlDays'];
    const config = {};
    for (const key of allowed) {
      if (body?.config && Object.prototype.hasOwnProperty.call(body.config, key)) {
        config[key] = body.config[key];
      }
    }
    if (session.engine.tick > 0 && session.engine.orders.size > 0) {
      return {
        status: 409,
        body: { ok: false, error: '回放已开始，不能再改动世界配置。请先重置。' },
      };
    }
    session.reset(config);
    return { ok: true, state: session.state() };
  },
  'POST /api/clock/advance': (req, url, body) => {
    const ticks = Math.max(1, Math.min(Number(body?.ticks) || 1, MAX_DAYS * 6));
    const result = session.advance({ ticks });
    return { ok: true, ...result };
  },
  'POST /api/clock/run-to': (req, url, body) => {
    const target = Math.max(0, Math.min(Number(body?.tick) || 0, MAX_DAYS * 6));
    return session.runTo({ targetTick: target });
  },
  'POST /api/plans': (req, url, body) => session.createPlan(body || {}),
  'PATCH /api/plans/:id': (req, url, body, params) => session.editPlan(params.id, body || {}),
  'POST /api/plans/:id/duplicate': (req, url, body, params) => session.duplicatePlan(params.id),
  'GET /api/plans/:id/validate': (req, url, body, params) => {
    const claimUnits = url.searchParams.has('claim') ? Number(url.searchParams.get('claim')) : null;
    return session.validate(params.id, { claimUnits });
  },
  'POST /api/plans/:id/confirm': (req, url, body, params) =>
    session.confirmPlan(params.id, {
      claimUnits: Math.max(0, Math.floor(Number(body?.claimUnits) || 0)),
      expectedPrices: body?.expectedPrices || null,
      expectedRevision: body?.expectedRevision ?? null,
      acknowledge: Boolean(body?.acknowledge),
    }),
  'POST /api/plans/:id/apply': (req, url, body, params) => session.applyPlan(params.id),
  'POST /api/plans/:id/simulate': (req, url, body, params) =>
    session.simulate(params.id, { horizonTicks: Math.max(6, Math.min(Number(body?.horizonTicks) || 18, 120)) }),
  'POST /api/plans/compare': (req, url, body) =>
    runComparison(session, Array.isArray(body?.planIds) ? body.planIds.slice(0, 6) : [], {
      horizonTicks: Math.max(6, Math.min(Number(body?.horizonTicks) || 18, 120)),
    }),
  'GET /api/analysis': (req, url) => {
    const method = url.searchParams.get('method') === 'channel' ? 'channel' : 'shared';
    const censorMode = ['censored', 'drop', 'naive'].includes(url.searchParams.get('censor'))
      ? url.searchParams.get('censor')
      : 'censored';
    const cutoff = url.searchParams.get('cutoff');
    return session.analysis({
      method,
      censorMode,
      cutoffSeq: cutoff === null ? null : Number(cutoff),
    });
  },
  'GET /api/orders': (req, url) =>
    session.orders({
      day: url.searchParams.has('day') ? Number(url.searchParams.get('day')) : null,
      channelId: url.searchParams.get('channel') || null,
      planId: url.searchParams.get('plan') || null,
      state: url.searchParams.get('state') || null,
      orderId: url.searchParams.get('order') || null,
      limit: Math.max(10, Math.min(Number(url.searchParams.get('limit')) || 120, 400)),
    }),
  'GET /api/orders/:id': (req, url, body, params) => session.orderJourney(params.id),
  'POST /api/inventory/restock': (req, url, body) => {
    const units = Math.max(1, Math.min(Number(body?.units) || 100, 5000));
    return session.restock(units);
  },
  'POST /api/rules/bump': () => session.bumpRuleEpoch(),
  'POST /api/undo': () => session.undo(),
  'POST /api/checkpoints': (req, url, body) => session.saveCheckpoint(body?.label),
  'POST /api/checkpoints/:id/restore': (req, url, body, params) => session.restoreCheckpoint(params.id),
  'GET /api/export': () => session.exportState(),
  'POST /api/import': (req, url, body) => session.importState(body),
  'POST /api/session/reseed': (req, url, body) => {
    session.reset({ ...session.config, seed: String(body?.seed || 'aurora-11') });
    return { ok: true, state: session.state() };
  },
};

function matchRoute(method, pathname) {
  const exact = routes[`${method} ${pathname}`];
  if (exact) return { handler: exact, params: {} };
  for (const [key, handler] of Object.entries(routes)) {
    const [routeMethod, routePattern] = key.split(' ');
    if (routeMethod !== method) continue;
    const patternParts = routePattern.split('/');
    const pathParts = pathname.split('/');
    if (patternParts.length !== pathParts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < patternParts.length; i += 1) {
      if (patternParts[i].startsWith(':')) params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      else if (patternParts[i] !== pathParts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler, params };
  }
  return null;
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(PUBLIC_DIR, relative));
  if (!filePath.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] || 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-cache',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    // Single-page fallback for the app shell.
    try {
      const html = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length });
      res.end(html);
    } catch {
      res.writeHead(404).end('not found');
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const match = matchRoute(req.method, url.pathname);
      if (!match) {
        json(res, 404, { ok: false, error: `未知接口 ${req.method} ${url.pathname}` });
        return;
      }
      const body = req.method === 'GET' ? null : await readBody(req);
      const result = await match.handler(req, url, body, match.params);
      if (result && typeof result === 'object' && result.status && result.body) {
        json(res, result.status, result.body);
      } else {
        json(res, 200, result);
      }
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error('[api]', error);
    json(res, 400, { ok: false, error: error.message || '请求失败' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Censure price lab listening on http://${HOST}:${PORT}`);
});

export { server, session };
