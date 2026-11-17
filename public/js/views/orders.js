/**
 * Order log.
 *
 * Every order is traceable: the hold it created, the inventory event that
 * reserved it, why it was paid, cancelled, expired or returned, and which plan
 * price was in force. Scarcity becomes visible here — a channel with few orders
 * may simply have run out of units before its turn.
 */

import {
  h,
  icon,
  clear,
  fmtInt,
  fmtPrice,
  fmtPct,
  fmtMoney,
  orderStateLabel,
  orderStateTone,
} from '../util.js';
import { pageHead, panel, emptyState, channelDot, seg } from './common.js';
import { store, loadOrders, openJourney } from '../store.js';
import { navigate } from '../nav.js';

const STATES = [
  { value: '', label: '全部状态' },
  { value: 'pending', label: '待支付' },
  { value: 'paid', label: '已支付' },
  { value: 'cancelled', label: '已取消' },
  { value: 'expired', label: '预留过期' },
  { value: 'returned', label: '已退货' },
];

export function renderOrders() {
  return h('div', {});
}

export function mountOrders(root) {
  clear(root);
  const live = root;
  let lastKey = '';

  function ensureLoaded() {
    const f = store.orderFilter;
    const key = JSON.stringify(f) + store.state?.counters.events;
    if (key !== lastKey) {
      lastKey = key;
      loadOrders();
    }
  }

  function draw() {
    const state = store.state;
    if (!state) return;
    ensureLoaded();
    const result = store.orderResult;
    clear(live);
    live.append(
      pageHead({
        title: '逐单日志',
        sub:
          '每笔订单都能追到：哪次曝光下的单、哪个预留锁住了库存、以什么价格成交、为什么取消或过期。库存顺序决定谁能买到——靠后的渠道可能不是没人买，而是没货卖。',
      }),
    );
    live.append(filters(state));
    live.append(
      summaryStrip(state, result),
    );
    live.append(
      result
        ? panel({
            title: `订单（${fmtInt(result.filtered)} / ${fmtInt(result.total)}）`,
            sub: '点击任意行查看完整去向',
            flush: true,
            body: orderTable(result, state),
          })
        : panel({ title: '订单', body: emptyState('正在加载……') }),
    );
  }

  function filters(state) {
    const days = [...new Set([...(state.recentEvents || []).map((e) => e.day)])].sort((a, b) => a - b);
    const daySelect = h(
      'select',
      {
        class: 'select',
        onchange: (event) => loadOrders({ day: event.target.value === '' ? null : Number(event.target.value) }),
      },
      h('option', { value: '' }, '全部日期'),
      days.map((d) => h('option', { value: String(d), selected: store.orderFilter.day === d }, `第 ${d + 1} 天`)),
    );
    const channelSelect = h(
      'select',
      {
        class: 'select',
        onchange: (event) => loadOrders({ channelId: event.target.value || null }),
      },
      h('option', { value: '' }, '全部渠道'),
      state.channels.map((c) =>
        h('option', { value: c.id, selected: store.orderFilter.channelId === c.id }, c.name),
      ),
    );
    const planSelect = h(
      'select',
      {
        class: 'select',
        onchange: (event) => loadOrders({ planId: event.target.value || null }),
      },
      h('option', { value: '' }, '全部方案'),
      state.plans.map((p) => h('option', { value: p.id, selected: store.orderFilter.planId === p.id }, `${p.id} ${p.name}`)),
    );
    const stateSelect = h(
      'select',
      {
        class: 'select',
        onchange: (event) => loadOrders({ state: event.target.value || null }),
      },
      STATES.map((s) => h('option', { value: s.value, selected: (store.orderFilter.state || '') === s.value }, s.label)),
    );
    return h(
      'div',
      { class: 'panel', style: { marginBottom: '14px' } },
      h(
        'div',
        { class: 'panel-body' },
        h('div', { class: 'filters' }, daySelect, channelSelect, planSelect, stateSelect,
          h(
            'button',
            {
              class: 'btn tiny ghost',
              onclick: () => loadOrders({ day: null, channelId: null, planId: null, state: null }),
            },
            '清除筛选',
          ),
          h('span', { class: 'tiny muted', style: { marginLeft: 'auto' } }, '仅显示最近 150 笔'),
        ),
      ),
    );
  }

  function summaryStrip(state, result) {
    const orders = result?.orders || [];
    const paid = orders.filter((o) => o.state === 'paid' || o.state === 'returned');
    const cancelled = orders.filter((o) => o.state === 'cancelled' || o.state === 'expired');
    const stockoutLinked = orders.filter((o) => o.stockAtStart != null && o.stockAtStart < 8).length;
    return h(
      'div',
      { class: 'stat-grid' },
      h('div', { class: 'stat' }, h('div', { class: 'label' }, '筛选结果'), h('div', { class: 'value' }, fmtInt(orders.length)), h('div', { class: 'foot' }, `共 ${fmtInt(result?.total ?? 0)} 笔`)),
      h('div', { class: 'stat' }, h('div', { class: 'label' }, '实付 / 退货'), h('div', { class: 'value' }, fmtInt(paid.length)), h('div', { class: 'foot' }, `含退货 ${fmtInt(orders.filter((o) => o.state === 'returned').length)} 笔`)),
      h(
        'div',
        { class: `stat ${cancelled.length ? 'warn' : ''}`.trim() },
        h('div', { class: 'label' }, '取消 / 过期'),
        h('div', { class: 'value' }, fmtInt(cancelled.length)),
        h('div', { class: 'foot' }, '去向了哪里，点开可查'),
      ),
      h(
        'div',
        { class: `stat ${stockoutLinked ? 'warn' : ''}`.trim() },
        h('div', { class: 'label' }, '发生在低库存时段'),
        h('div', { class: 'value' }, fmtInt(stockoutLinked)),
        h('div', { class: 'foot' }, '下单时共享池少于 8 件'),
      ),
    );
  }

  function orderTable(result, state) {
    const orders = result.orders;
    if (!orders.length) return emptyState('没有符合条件的订单。先推进几天，或放宽筛选。');
    return h(
      'div',
      { class: 'table-scroll tall' },
      h(
      'table',
      { class: 'table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', {}, '订单'),
          h('th', {}, '渠道'),
          h('th', { class: 'right' }, '价格'),
          h('th', {}, '方案'),
          h('th', {}, '下单时点'),
          h('th', { class: 'right' }, '下单时库存'),
          h('th', {}, '状态'),
        ),
      ),
      h(
        'tbody',
        {},
        orders.map((order) => {
          const channel = state.channels.find((c) => c.id === order.channelId);
          return h(
            'tr',
            {
              class: 'clickable',
              onclick: () => openJourney(order.id),
              title: '查看该订单的预留、支付与库存去向',
            },
            h('td', { class: 'mono tiny' }, order.id),
            h(
              'td',
              {},
              h('div', { class: 'name-cell' }, channelDot(channel?.color || '#888'), h('span', { class: 'small' }, channel?.short || order.channelId)),
            ),
            h('td', { class: 'num right' }, fmtPrice(order.priceCents)),
            h('td', { class: 'tiny mono' }, order.planId || '—'),
            h('td', { class: 'tiny mono' }, `D${order.createdDay + 1} ${String(order.createdHour).padStart(2, '0')}:00`),
            h(
              'td',
              { class: `num right ${order.stockAtStart < 8 ? 'neg' : 'muted'}` },
              fmtInt(order.stockAtStart),
            ),
            h(
              'td',
              {},
              h('span', { class: `pill ${orderStateTone(order.state)}`.trim() }, orderStateLabel(order.state)),
            ),
          );
        }),
      ),
      ),
    );
  }

  draw();
  return {
    update: draw,
    unmount: () => {},
  };
}
