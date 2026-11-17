/**
 * Client store.
 *
 * One state object, one source of truth: the last `state` payload the server
 * returned. Every action either reads from the API or posts a mutation and
 * stores the state it gets back, then notifies subscribers. Views never mutate
 * `store` fields that belong to the server.
 */

import { apiGet, apiPost, apiPatch, qs, debounce } from './util.js';
import { toast } from './dialog.js';

export const store = {
  state: null,
  meta: null,
  view: 'console',
  selectedPlanId: null,
  compareIds: [],
  method: 'shared',
  censorMode: 'censored',
  analysis: null,
  analysisLoading: false,
  analysisError: null,
  sim: null,
  simLoading: false,
  compare: null,
  compareLoading: false,
  orderFilter: { day: null, channelId: null, planId: null, state: null },
  orderResult: null,
  journey: null,
  drawer: null,
  busy: false,
  listeners: new Set(),
};

export function subscribe(fn) {
  store.listeners.add(fn);
  return () => store.listeners.delete(fn);
}

export function notify() {
  for (const fn of store.listeners) fn();
}

function setState(next, { resetSelection = false } = {}) {
  if (next) store.state = next;
  if (resetSelection) store.selectedPlanId = store.state?.appliedPlanId ?? null;
  if (store.state && store.selectedPlanId && !store.state.plans.some((p) => p.id === store.selectedPlanId)) {
    store.selectedPlanId = store.state.appliedPlanId;
  }
}

export function selectedPlan() {
  return store.state?.plans.find((p) => p.id === store.selectedPlanId) || null;
}

/* ------------------------------------------------------------------- load */

export async function loadMeta() {
  store.meta = await apiGet('/api/meta');
  return store.meta;
}

export async function refreshState() {
  const next = await apiGet('/api/state');
  setState(next);
  if (!store.selectedPlanId) {
    const draft = next.plans.find((p) => p.status === 'draft');
    store.selectedPlanId = draft?.id || next.appliedPlanId || next.plans[0]?.id || null;
  }
  notify();
  return next;
}

export function selectPlan(planId) {
  store.selectedPlanId = planId;
  store.sim = null;
  notify();
}

export function toggleCompare(planId) {
  const set = new Set(store.compareIds);
  if (set.has(planId)) set.delete(planId);
  else if (set.size < 4) set.add(planId);
  store.compareIds = [...set];
  notify();
}

/* ------------------------------------------------------------------ plans */

export async function createPlan(payload = {}) {
  const result = await apiPost('/api/plans', payload);
  setState(result.state);
  store.selectedPlanId = result.plan.id;
  store.sim = null;
  toast('ok', `已创建草稿 ${result.plan.id}`);
  notify();
  return result.plan;
}

export async function editPlan(planId, patch, { quiet = false } = {}) {
  const result = await apiPatch(`/api/plans/${planId}`, patch);
  if (!result.ok) {
    toast('bad', result.error || '修改失败');
    return null;
  }
  setState(result.state);
  store.sim = null;
  store.analysis = null;
  notify();
  if (!quiet) toast('ok', `${planId} 已更新到版本 ${result.plan.revision}`);
  return result.plan;
}

export const editPlanDebounced = debounce((planId, patch) => editPlan(planId, patch, { quiet: true }), 220);

export async function duplicatePlan(planId) {
  const result = await apiPost(`/api/plans/${planId}/duplicate`);
  setState(result.state);
  store.selectedPlanId = result.plan.id;
  toast('ok', `已复制为 ${result.plan.id}`);
  notify();
}

export async function validatePlan(planId, claimUnits = null) {
  const params = new URLSearchParams();
  if (claimUnits != null) params.set('claim', String(claimUnits));
  return apiGet(`/api/plans/${planId}/validate?${params}`);
}

export async function confirmPlan(planId, payload) {
  const result = await apiPost(`/api/plans/${planId}/confirm`, payload);
  setState(result.state);
  notify();
  if (result.ok) toast('ok', `${planId} 已确认，价格与规则版本已冻结。`);
  else if (!result.needsAcknowledgement) toast('bad', result.error || '确认被拒绝');
  return result;
}

export async function applyPlan(planId) {
  const result = await apiPost(`/api/plans/${planId}/apply`);
  setState(result.state);
  store.analysis = null;
  store.sim = null;
  notify();
  if (result.ok) toast('ok', `${planId} 已上线，旧方案已自动取代。`);
  else toast('bad', result.error || '上线失败');
  return result;
}

export async function simulatePlan(planId, horizonTicks = 18) {
  store.simLoading = true;
  store.sim = null;
  notify();
  try {
    const result = await apiPost(`/api/plans/${planId}/simulate`, { horizonTicks });
    store.sim = result;
    return result;
  } catch (error) {
    toast('bad', `试算失败：${error.message}`);
    return null;
  } finally {
    store.simLoading = false;
    notify();
  }
}

export async function comparePlans(planIds, horizonTicks = 18) {
  store.compareLoading = true;
  notify();
  try {
    const result = await apiPost('/api/plans/compare', { planIds, horizonTicks });
    store.compare = result;
    return result;
  } catch (error) {
    toast('bad', `对比失败：${error.message}`);
    return null;
  } finally {
    store.compareLoading = false;
    notify();
  }
}

/* ------------------------------------------------------------------ clock */

export async function advance(ticks = 1) {
  if (store.busy) return;
  store.busy = true;
  notify();
  try {
    const result = await apiPost('/api/clock/advance', { ticks });
    setState(result.state);
    store.analysis = null;
    store.sim = null;
    return result;
  } catch (error) {
    toast('bad', error.message);
    return null;
  } finally {
    store.busy = false;
    notify();
  }
}

export async function runTo(tick) {
  store.busy = true;
  notify();
  try {
    const result = await apiPost('/api/clock/run-to', { tick });
    setState(result.state);
    store.analysis = null;
    store.sim = null;
    return result;
  } catch (error) {
    toast('bad', error.message);
    return null;
  } finally {
    store.busy = false;
    notify();
  }
}

export async function resetSession(config = {}) {
  const result = await apiPost('/api/session/reset', { config });
  setState(result.state, { resetSelection: true });
  store.analysis = null;
  store.sim = null;
  store.compare = null;
  store.orderResult = null;
  store.journey = null;
  toast('ok', '回放已重置。');
  notify();
}

export async function restock(units) {
  const result = await apiPost('/api/inventory/restock', { units });
  setState(result.state);
  toast('ok', `已补货 ${units} 件到共享库存池。`);
  notify();
}

export async function bumpRules() {
  const result = await apiPost('/api/rules/bump');
  setState(result.state);
  if (result.ok) toast('warn', '规则升级：已确认方案的预留被释放，需重新确认。');
  else toast('warn', result.error);
  notify();
}

export async function undo() {
  const result = await apiPost('/api/undo');
  setState(result.state);
  if (result.ok) toast('ok', `已撤销：${result.label}`);
  else toast('bad', result.error);
  notify();
  return result;
}

export async function saveCheckpoint(label) {
  const result = await apiPost('/api/checkpoints', { label });
  setState(result.state);
  toast('ok', `已记录检查点 ${result.checkpoint.id}`);
  notify();
  return result.checkpoint;
}

export async function restoreCheckpoint(id) {
  const result = await apiPost(`/api/checkpoints/${id}/restore`);
  setState(result.state);
  store.analysis = null;
  store.sim = null;
  if (result.ok) toast('ok', `已恢复到检查点 ${id}`);
  else toast('bad', result.error);
  notify();
}

/* --------------------------------------------------------------- analysis */

export async function loadAnalysis({ force = false } = {}) {
  if (!store.state) return;
  const key = `${store.method}|${store.censorMode}`;
  if (!force && store.analysis?.key === key) return;
  if (store.analysisLoading && store.analysisPendingKey === key) return;
  store.analysisPendingKey = key;
  store.analysisLoading = true;
  store.analysisError = null;
  notify();
  try {
    const params = new URLSearchParams({ method: store.method, censor: store.censorMode });
    const result = await apiGet(`/api/analysis?${params}`);
    store.analysis = { ...result, key };
  } catch (error) {
    store.analysisError = error.message;
    toast('bad', `分析失败：${error.message}`);
  } finally {
    store.analysisLoading = false;
    notify();
  }
}

export function setMethod(method) {
  store.method = method;
  store.analysis = null;
  loadAnalysis({ force: true });
}

export function setCensorMode(mode) {
  store.censorMode = mode;
  store.analysis = null;
  loadAnalysis({ force: true });
}

/* ----------------------------------------------------------------- orders */

export async function loadOrders(patch = {}) {
  store.orderFilter = { ...store.orderFilter, ...patch };
  const params = new URLSearchParams();
  const f = store.orderFilter;
  if (f.day != null) params.set('day', String(f.day));
  if (f.channelId) params.set('channel', f.channelId);
  if (f.planId) params.set('plan', f.planId);
  if (f.state) params.set('state', f.state);
  params.set('limit', '150');
  try {
    store.orderResult = await apiGet(`/api/orders?${params}`);
  } catch (error) {
    toast('bad', error.message);
  }
  notify();
}

export async function openJourney(orderId) {
  try {
    store.journey = await apiGet(`/api/orders/${orderId}`);
    store.drawer = 'journey';
    notify();
  } catch (error) {
    toast('bad', error.message);
  }
}

export function closeDrawer() {
  store.drawer = null;
  store.journey = null;
  notify();
}

/* ------------------------------------------------------------------- misc */

export function focusScroll(selector) {
  qs(selector)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
