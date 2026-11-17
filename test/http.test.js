/**
 * HTTP-level smoke tests.
 *
 * The unit tests call LabSession directly, which is exactly why the original
 * dispatcher bug — handlers declared as `(req, body, params)` while the router
 * passed `(req, url, params, body)` — went unnoticed: every POST silently used
 * its defaults. These tests go through the real server so request bodies are
 * actually exercised.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

function startServer() {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolveStart, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 8000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('listening')) {
        clearTimeout(timer);
        resolveStart(child);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      out += chunk;
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code}): ${out}`));
    });
  });
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json() };
}

async function post(path, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

test('HTTP routes honour request bodies and serve analysis of the live log', async (t) => {
  const child = await startServer();
  t.after(() => child.kill());

  // A body larger than the default must actually reach the handler.
  const advanced = await post('/api/clock/advance', { ticks: 6 });
  assert.equal(advanced.status, 200);
  assert.equal(advanced.body.advanced, 6);
  assert.equal(advanced.body.state.tick, 6);
  assert.equal(advanced.body.state.day, 0);

  const more = await post('/api/clock/advance', { ticks: 60 });
  assert.equal(more.body.advanced, 60);
  assert.equal(more.body.state.tick, 66);
  assert.equal(more.body.state.day, 10);

  const created = await post('/api/plans', {
    name: 'HTTP 草稿',
    prices: { 'CH-MKT': 11800, 'CH-WEB': 12300, 'CH-APP': 11200, 'CH-OUT': 10800 },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.plan.prices['CH-MKT'], 11800);
  assert.equal(created.body.plan.prices['CH-OUT'], 10800);

  const patched = await fetch(`${BASE}/api/plans/${created.body.plan.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prices: { 'CH-APP': 11000 } }),
  }).then((r) => r.json());
  assert.equal(patched.plan.prices['CH-APP'], 11000);
  assert.equal(patched.plan.prices['CH-MKT'], 11800, 'a patch must not reset other channels');

  // No cutoff: every event visible so far must be analysed (the null-cutoff bug
  // used to collapse this to zero rows).
  const analysis = await get('/api/analysis?method=shared&censor=censored');
  assert.equal(analysis.status, 200);
  assert.ok(analysis.body.rows > 0, 'analysis should see the replay');
  assert.ok(analysis.body.fits.length === 4);
  assert.ok(analysis.body.fits.every((f) => f.rows > 0));
  assert.ok(analysis.body.cutoffSeq > 0);

  const cutoff = await get('/api/analysis?method=shared&censor=censored&cutoff=3');
  assert.ok(cutoff.body.rows < analysis.body.rows, 'an explicit cutoff must narrow the window');
  assert.ok(cutoff.body.cutoffSeq <= analysis.body.cutoffSeq);

  // Backtest always ran, so it is the control that proves the log is non-empty.
  assert.ok(analysis.body.backtest.summary.windows > 0);
});
