/**
 * Application shell.
 *
 * Owns navigation, the top bar and the drawer; all state lives in `store.js`
 * and all server calls go through it. Views are mounted once per navigation and
 * re-render themselves when the store notifies.
 */

import { h, qs, clear, icon, apiGet } from './util.js';
import { openModal, closeModal, initDialog } from './dialog.js';
import { registerRouter } from './nav.js';
import {
  store,
  subscribe,
  loadMeta,
  refreshState,
  setMethod,
  setCensorMode,
  advance,
  runTo,
  undo,
  saveCheckpoint,
} from './store.js';
import { renderConsole, mountConsole } from './views/console.js';
import { renderLab, mountLab } from './views/lab.js';
import { renderResults, mountResults } from './views/results.js';
import { renderOrders, mountOrders } from './views/orders.js';
import { renderMethod } from './views/method.js';
import { renderJourney } from './views/journey.js';

const VIEWS = {
  console: { render: renderConsole, mount: mountConsole, title: '回放台' },
  lab: { render: renderLab, mount: mountLab, title: '方案实验室' },
  results: { render: renderResults, mount: mountResults, title: '结果与识别' },
  orders: { render: renderOrders, mount: mountOrders, title: '逐单日志' },
  method: { render: renderMethod, mount: null, title: '方法说明' },
};

let mounted = null;

export function setView(view, { replaceHash = false } = {}) {
  if (!VIEWS[view]) view = 'console';
  store.view = view;
  const hash = `#${view}`;
  if (location.hash !== hash) {
    if (replaceHash) history.replaceState(null, '', hash);
    else history.pushState(null, '', hash);
  }
  renderChrome();
  renderView();
  qs('#content')?.focus({ preventScroll: true });
}

function renderView() {
  const content = qs('#content');
  if (!content) return;
  if (typeof mounted?.unmount === 'function') mounted.unmount();
  mounted = null;
  const view = VIEWS[store.view];
  clear(content);
  content.className = 'content view-enter';
  const node = view.render({ store });
  content.append(node);
  if (view.mount) mounted = view.mount(node, { store });
  setTimeout(() => content.classList.remove('view-enter'), 260);
}

function remount() {
  if (!mounted) {
    renderView();
    return;
  }
  if (typeof mounted.update === 'function') mounted.update();
  renderChrome();
}

/* ----------------------------------------------------------------- chrome */

function navIcons() {
  for (const node of document.querySelectorAll('.nav-ico')) {
    node.innerHTML = icon(node.dataset.icon, 17).outerHTML;
  }
}

function renderChrome() {
  const state = store.state;
  if (!state) return;
  const day = state.day + 1;

  qs('#clock .clock-day').textContent = state.complete ? `回放结束 · 第 ${day} 天` : `第 ${day} 天 / ${state.maxDays}`;
  qs('#clock .clock-hour').textContent = `${String(state.hour).padStart(2, '0')}:00`;
  const sideDay = qs('#side-day .mini-value');
  if (sideDay) sideDay.textContent = `${day} / ${state.maxDays} 天 · ${Math.round((state.tick / state.maxTicks) * 100)}%`;

  qs('#scenario-chip').textContent = `情景：${state.scenario.name}`;
  const applied = state.plans.find((p) => p.id === state.appliedPlanId);
  const appliedChip = qs('#applied-chip');
  appliedChip.className = `applied-chip ${applied?.rulesStale ? 'stale' : ''}`.trim();
  clear(appliedChip);
  if (applied) {
    appliedChip.append(
      '生效：',
      h('b', {}, applied.id),
      ` ${applied.name}`,
      applied.rulesStale ? ' · 规则已变' : '',
    );
  } else {
    appliedChip.textContent = '生效：—';
  }

  for (const item of document.querySelectorAll('.nav-item')) {
    item.classList.toggle('active', item.dataset.view === store.view);
  }

  const actions = qs('#topbar-actions');
  clear(actions);
  actions.append(
    h(
      'button',
      {
        class: 'btn small ghost',
        title: '撤销上一步会改动状态的操作',
        disabled: !state.undo.length || store.busy,
        onclick: () => undo(),
      },
      h('span', { html: icon('undo', 14).outerHTML }),
      '撤销',
    ),
    h(
      'button',
      {
        class: 'btn small ghost',
        title: '保存当前完整快照',
        onclick: () => saveCheckpoint(`第 ${state.day + 1} 天检查点`),
      },
      h('span', { html: icon('flag', 14).outerHTML }),
      '打点',
    ),
    h(
      'button',
      {
        class: 'btn small',
        disabled: store.busy || state.complete,
        onclick: () => advance(1),
        title: '推进一个时段（2 小时）',
      },
      h('span', { html: icon('step', 13).outerHTML }),
      '一步',
    ),
    h(
      'button',
      {
        class: 'btn primary small',
        disabled: store.busy || state.complete,
        onclick: () => advance(6),
        title: '推进六个时段（一天）',
      },
      h('span', { html: icon('play', 13).outerHTML }),
      store.busy ? '推进中…' : '推进一天',
    ),
  );
}

/* ----------------------------------------------------------------- drawer */

function renderDrawer() {
  const drawer = qs('#drawer');
  const backdrop = qs('#drawer-backdrop');
  if (!drawer || !backdrop) return;
  if (!store.drawer || !store.journey) {
    drawer.hidden = true;
    backdrop.hidden = true;
    clear(drawer);
    return;
  }
  const { order, hold, events } = store.journey;
  clear(drawer);
  drawer.append(
    h(
      'div',
      { class: 'drawer-head' },
      h(
        'div',
        {},
        h('h3', {}, `订单 ${order.id}`),
        h('div', { class: 'sub' }, `${order.channelName} · ${order.state === 'paid' ? '已支付' : order.state}`),
      ),
      h(
        'button',
        { class: 'icon-btn', onclick: () => closeDrawer(), 'aria-label': '关闭' },
        h('span', { html: icon('close', 15).outerHTML }),
      ),
    ),
  );
  const body = h('div', { class: 'drawer-body' });
  body.append(renderJourney(store.journey, { channels: store.state.channels }));
  drawer.append(body);
  drawer.hidden = false;
  backdrop.hidden = false;
}

export function closeDrawer() {
  store.drawer = null;
  store.journey = null;
  renderDrawer();
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  navIcons();
  initDialog();
  try {
    await loadMeta();
    await refreshState();
  } catch (error) {
    qs('#content').append(
      h(
        'div',
        { class: 'callout bad', style: { margin: '30px' } },
        h('b', {}, '无法连接本地服务。'),
        ` 请确认已运行 node src/server.js。错误：${error.message}`,
      ),
    );
    return;
  }
  store.view = VIEWS[location.hash.replace('#', '')] ? location.hash.replace('#', '') : 'console';
  renderChrome();
  renderView();
  renderDrawer();

  for (const item of document.querySelectorAll('.nav-item')) {
    item.addEventListener('click', (event) => {
      event.preventDefault();
      setView(item.dataset.view);
    });
  }
  qs('#drawer-backdrop')?.addEventListener('click', closeDrawer);

  window.addEventListener('popstate', () => {
    const next = location.hash.replace('#', '');
    if (VIEWS[next] && next !== store.view) {
      store.view = next;
      renderChrome();
      renderView();
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && store.drawer) closeDrawer();
  });

  subscribe(() => {
    renderChrome();
    renderDrawer();
    if (mounted && typeof mounted.update === 'function') mounted.update();
    else if (!VIEWS[store.view].mount) renderView();
  });
}

/* Views import navigate() from nav.js; expose the shell handler once. */
registerRouter((view) => setView(view));

boot();
