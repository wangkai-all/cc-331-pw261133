/**
 * Order journey: the drawer content.
 *
 * A vertical timeline from placement to its terminal state, with the inventory
 * ledger entry attached to each step. The purpose is to make "where did this
 * unit go, and why" answerable without reading code.
 */

import { h, fmtPrice, fmtHour, fmtInt, eventDetail, EVENT_LABELS, orderStateLabel, orderStateTone } from '../util.js';

export function renderJourney(journey, { channels = [] } = {}) {
  const { order, hold, events } = journey;
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const stockNote =
    order.stockAtStart == null
      ? '—'
      : order.stockAtStart <= 0
        ? '下单时共享池已空'
        : order.stockAtStart < 8
          ? `下单时共享池仅剩 ${order.stockAtStart} 件`
          : `下单时共享池有 ${order.stockAtStart} 件`;
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
    h(
      'div',
      { class: 'kv' },
      h('dt', {}, '渠道'),
      h('dd', {}, order.channelName),
      h('dt', {}, '成交价'),
      h('dd', {}, fmtPrice(order.priceCents)),
      h('dt', {}, '方案'),
      h('dd', { class: 'mono' }, order.planId || '—'),
      h('dt', {}, '下单时点'),
      h('dd', {}, `第 ${order.createdDay + 1} 天 ${fmtHour(order.createdHour)}`),
      h('dt', {}, '库存快照'),
      h('dd', { class: order.stockAtStart != null && order.stockAtStart < 8 ? 'neg' : '' }, stockNote),
      h('dt', {}, '当前状态'),
      h('dd', {}, h('span', { class: `pill ${orderStateTone(order.state)}`.trim() }, orderStateLabel(order.state))),
      h('dt', {}, '预留'),
      h('dd', { class: 'mono tiny' }, hold ? `${hold.id} · ${hold.state}${hold.releasedReason ? `（${hold.releasedReason}）` : ''}` : '—'),
    ),
    h(
      'div',
      {},
      h('div', { class: 'small muted', style: { marginBottom: '8px' } }, '事件时间线'),
      h(
        'div',
        { class: 'journey' },
        ordered.map((event, index) => journeyItem(event, index === ordered.length - 1, channels)),
      ),
    ),
    h(
      'div',
      { class: 'callout' },
      order.state === 'cancelled'
        ? order.cancelReason === 'hold_expired'
          ? '这笔订单因超时未支付而释放预留：库存回到可售池，其他渠道可以立刻买到。这类“取消”不是需求为零，而是支付流程的摩擦。'
          : '买家主动取消：预留被释放，销量低在这里不代表价格问题。'
        : order.state === 'expired'
          ? '预留已过期且没有完成支付：这类订单不计入收入，但它占用的库存在此之前对别的渠道是不可见的。'
          : order.state === 'returned'
            ? '商品已退货，库存在延迟后回到可售池；净收入中已扣除这笔金额。'
            : order.state === 'pending'
              ? '这笔订单仍在待支付：它占着一个软预留，其他渠道此刻买不到这一件，但结果尚未发生——不要把它算成成交，也不要把它的取消当成需求。'
              : '这笔订单已完成支付，库存在支付时从“预留”转为“已承诺”，不会回到可售池。',
    ),
  );
}

function journeyItem(event, isLast, channels) {
  const tone =
    event.type === 'order_cancelled' || event.type === 'order_expired'
      ? 'bad'
      : event.type === 'inventory_hold' || event.type === 'order_placed'
        ? 'warn'
        : '';
  const title =
    event.type === 'inventory_hold'
      ? '预留 1 件（软锁定）'
      : event.type === 'inventory_commit'
        ? '预留转为已承诺'
        : event.type === 'inventory_release'
          ? event.reason === 'hold_expired'
            ? '预留过期，库存回到可售'
            : '预留释放，库存回到可售'
          : event.type === 'inventory_return'
            ? '退货，库存回到可售'
            : EVENT_LABELS[event.type] || event.type;
  const sub = eventDetail(event, channels);
  return h(
    'div',
    { class: 'j-item' },
    h('span', { class: `j-dot ${tone}`.trim() }),
    h('span', { class: 'j-line' }),
    h(
      'div',
      {},
      h('div', { class: 'j-title' }, title),
      h('div', { class: 'j-sub' }, sub || `第 ${event.day + 1} 天`),
    ),
    h('span', { class: 'j-time' }, `D${event.day + 1} ${fmtHour(event.hour ?? 9)}`),
  );
}
