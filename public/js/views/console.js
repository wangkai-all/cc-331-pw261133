/**
 * Replay console.
 *
 * The "what is happening right now" screen: clock controls, today's price and
 * fulfilment per channel, the shared inventory bar, a unit-by-unit event stream
 * and the checkpoint shelf. Everything here reads live session state; nothing is
 * simulated.
 */

import {
  h,
  icon,
  fmtInt,
  fmtMoney,
  fmtPrice,
  fmtPct,
  fmtHour,
  EVENT_LABELS,
  eventDetail,
  clear,
} from '../util.js';
import { pageHead, panel, stat, channelDot, emptyState } from './common.js';
import { inventoryChart } from '../charts.js';
import {
  advance,
  runTo,
  restock,
  saveCheckpoint,
  restoreCheckpoint,
  selectPlan,
  openJourney,
  resetSession,
  bumpRules,
  loadMeta,
  undo,
} from '../store.js';
import { openModal, closeModal } from '../dialog.js';
import { navigate } from '../nav.js';

export function renderConsole() {
  const root = h('div', {});
  const live = h('div', {});
  root.append(live);
  return root;
}

export function mountConsole(root, { store }) {
  const live = root.firstChild;

  function draw() {
    const state = store.state;
    if (!state) return;
    clear(live);
    live.append(header(state, store));
    live.append(stats(state));
    live.append(channelStrip(state));
    live.append(
      h(
        'div',
        { class: 'grid sidebar-right', style: { marginTop: '14px' } },
        leftColumn(state, store),
        rightColumn(state, store),
      ),
    );
  }

  draw();
  return { update: draw, unmount: () => {} };
}

function header(state, store) {
  const progress = Math.round((state.tick / state.maxTicks) * 100);
  return h(
    'div',
    {},
    pageHead({
      title: '回放台',
      subtitle:
        '同一件商品、四个渠道、一个共享库存池。每个两小时时段按固定顺序发放库存，卖光的时段会被截断而不是变成“零需求”。',
      actions: [
        h(
          'span',
          { class: 'pill', title: '事件日志的全局序号，回测用它做截止点' },
          `事件 ${fmtInt(state.counters.events)} · tick ${state.tick}`,
        ),
        state.complete ? h('span', { class: 'pill warn' }, '回放结束') : null,
      ].filter(Boolean),
    }),
    h(
      'div',
      { class: 'panel', style: { marginBottom: '14px' } },
      h(
        'div',
        { class: 'panel-body' },
        h(
          'div',
          { class: 'clock-bar' },
          h(
            'div',
            { class: 'seg' },
            h('button', { onclick: () => advance(1), disabled: store.busy || state.complete, title: '推进一个时段（2 小时）' }, '推进一步'),
            h('button', { onclick: () => advance(6), disabled: store.busy || state.complete, title: '推进六个时段（一天）' }, '推进一天'),
            h(
              'button',
              {
                onclick: () => runTo(state.maxTicks),
                disabled: store.busy || state.complete,
                title: '把剩余时段一次跑完，可随时用检查点回看',
              },
              '跑完全程',
            ),
          ),
          h('div', { class: 'progress', title: `${state.day + 1} / ${state.maxDays} 天` }, h('i', { style: { width: `${progress}%` } })),
          h('span', { class: 'small muted nowrap' }, `${progress}% · 第 ${state.day + 1} 天 ${fmtHour(state.hour)}`),
          h(
            'button',
            {
              class: 'btn small ghost',
              onclick: () => resetDialog(),
              title: '重置回放并重新选择需求情景',
            },
            h('span', { html: icon('refresh', 14).outerHTML }),
            '重置回放',
          ),
        ),
      ),
    ),
  );
}

function resetDialog() {
  const scenario = h('select', { class: 'select' });
  const units = h('input', { type: 'number', min: '60', max: '2000', step: '20', value: '420' });
  const seed = h('input', { type: 'text', value: 'aurora-11' });
  loadMeta().then((meta) => {
    for (const s of meta.scenarios) {
      scenario.append(h('option', { value: s.id, selected: s.id === 'steady' }, s.name));
    }
  });
  openModal({
    title: '重置回放',
    body: h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      h('div', { class: 'small muted' }, '需求情景决定潜在需求曲线；库存决定多快会被截断。两者都在回放开始前设定，中途不能改。'),
      h('div', { class: 'form-row' }, h('label', {}, '需求情景'), scenario),
      h(
        'div',
        { class: 'form-inline' },
        h('div', { class: 'form-row', style: { flex: '1' } }, h('label', {}, '初始库存（件）'), units),
        h('div', { class: 'form-row', style: { flex: '1' } }, h('label', {}, '随机种子'), seed),
      ),
      h('div', { class: 'tiny muted' }, '相同种子与相同配置会逐字节复现同一段回放，便于对比检查点。'),
    ),
    footer: [
      h('button', { class: 'btn ghost', onclick: closeModal }, '取消'),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: () => {
            closeModal();
            resetSession({
              demandScenario: scenario.value || 'steady',
              openingUnits: Number(units.value) || 420,
              seed: seed.value || 'aurora-11',
            });
          },
        },
        '确认重置',
      ),
    ],
  });
}

function stats(state) {
  const inv = state.inventory;
  const claimText = state.claimedUnits > 0 ? `已承诺 ${fmtInt(state.claimedUnits)}` : '无预留';
  const paid = state.counters.ordersPaid;
  const total = state.counters.ordersTotal;
  const cancelRate = total ? (state.counters.ordersCancelled + state.counters.ordersExpired) / total : 0;
  return h(
    'div',
    { class: 'stat-grid' },
    stat({
      label: '可售库存',
      value: fmtInt(inv.available),
      foot: `在库 ${fmtInt(inv.onHand)} · 持有 ${fmtInt(inv.held)} · 承诺 ${fmtInt(inv.committed)}`,
      tone: inv.available <= 0 ? 'bad' : inv.available < 60 ? 'warn' : '',
    }),
    stat({
      label: '实付订单',
      value: fmtInt(paid),
      foot: `下单 ${fmtInt(total)} · 取消 ${fmtInt(state.counters.ordersCancelled)} · 退货 ${fmtInt(state.counters.ordersReturned)}`,
    }),
    stat({
      label: '净收入',
      value: fmtMoney(state.money.netRevenueCents),
      foot: `退款 ${fmtMoney(state.money.refundsCents)} · ${claimText}`,
    }),
    stat({
      label: '被截断时段',
      value: fmtInt(state.counters.stockoutTicks),
      foot: `取消/过期率 ${fmtPct(cancelRate)}`,
      tone: state.counters.stockoutTicks > 0 ? 'warn' : '',
    }),
  );
}

function channelStrip(state) {
  return h(
    'div',
    { class: 'channel-strip' },
    state.channels.map((channel) => {
      const today = state.today?.find((t) => t.channelId === channel.id);
      const applied = state.appliedPlan;
      const price = applied?.prices?.[channel.id] ?? channel.priceAnchorCents;
      const starved = (today?.stockoutTicks ?? 0) > 0;
      return h(
        'div',
        { class: `ch-card ${starved ? 'starved' : ''}`.trim(), style: { '--ch-color': channel.color } },
        h(
          'div',
          { class: 'ch-top' },
          h('div', { class: 'ch-title' }, channel.name),
          h('div', { class: 'ch-price' }, fmtPrice(price)),
        ),
        h('div', { class: 'ch-order' }, `${channel.kind === 'marketplace' ? '平台' : channel.kind === 'owned' ? '自营' : '线下'} · 处理顺序 #${state.config.channelOrder.indexOf(channel.id) + 1}`),
        h(
          'div',
          { class: 'ch-metrics' },
          metric('今日曝光', fmtInt(today?.impressions ?? 0)),
          metric('今日成交', fmtInt(today?.orders ?? 0)),
          metric('截断', starved ? `${today.stockoutTicks} 段` : '—'),
        ),
      );
    }),
  );
}

function metric(label, value) {
  return h('div', { class: 'ch-metric' }, h('span', {}, label), h('b', {}, value));
}

function leftColumn(state, store) {
  const stockoutTicks = state.stockouts.map((s) => s.tick);
  const timeline = state.inventoryTimeline || [];
  const totalUnits = state.inventory.openingUnits + state.inventory.restocked;
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
    panel({
      title: '共享库存',
      sub: `可用 / 持有 / 承诺 · 共 ${fmtInt(totalUnits)} 件`,
      actions: [
        h(
          'button',
          {
            class: 'btn small',
            onclick: () => {
              restock(100);
            },
            title: '向共享池补入 100 件，四个渠道同时可见',
          },
          h('span', { html: icon('box', 14).outerHTML }),
          '补货 100',
        ),
      ],
      body: h(
        'div',
        {},
        inventoryBar(state.inventory),
        timeline.length
          ? h(
              'div',
              { style: { marginTop: '10px' } },
              inventoryChart({ timeline, stockoutTicks, totalUnits }),
              h(
                'div',
                { class: 'chart-legend', style: { marginTop: '4px' } },
                legendItem('#4ec3a9', '可售'),
                legendItem('#b08a4e', '预留中（待支付）'),
                legendItem('#3d5468', '已承诺'),
                legendItem('#e4796d', '红点为被截断时段'),
              ),
            )
          : emptyState('推进时钟后，这里会画出一段一段的库存变化。'),
      ),
    }),
    panel({
      title: '逐单事件流',
      sub: '最近 40 条 · 点击订单行可查看去向',
      flush: true,
      body: h('div', { class: 'stream' }, eventStream(state)),
    }),
  );
}

function legendItem(color, label) {
  return h('span', {}, h('i', { style: { background: color } }), label);
}

function inventoryBar(inv) {
  const total = Math.max(1, inv.onHand);
  const pct = (v) => `${(v / total) * 100}%`;
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'inv-bar' },
      h('i', { class: 'seg-available', style: { width: pct(inv.available) }, title: `可售 ${inv.available}` }),
      h('i', { class: 'seg-held', style: { width: pct(inv.held) }, title: `预留 ${inv.held}` }),
      h('i', { class: 'seg-committed', style: { width: pct(inv.committed) }, title: `承诺 ${inv.committed}` }),
    ),
    h(
      'div',
      { class: 'inv-legend' },
      h('span', {}, h('i', { style: { background: '#4ec3a9' } }), `可售 ${fmtInt(inv.available)}`),
      h('span', {}, h('i', { style: { background: '#b08a4e' } }), `预留 ${fmtInt(inv.held)}`),
      h('span', {}, h('i', { style: { background: '#3d5468' } }), `承诺 ${fmtInt(inv.committed)}`),
      h('span', { class: inv.returned ? '' : 'muted' }, `已退回 ${fmtInt(inv.returned)}`),
      h('span', { class: inv.restocked ? '' : 'muted' }, `已补货 ${fmtInt(inv.restocked)}`),
    ),
  );
}

function eventStream(state) {
  const events = (state.recentEvents || []).filter((e) => e.type !== 'tick');
  if (!events.length) return emptyState('还没有事件。点“推进一天”开始回放。');
  return events.map((event) => {
    const tag = EVENT_LABELS[event.type] || event.type;
    const amount =
      event.type === 'order_paid' || event.type === 'order_placed' || event.type === 'order_returned'
        ? fmtPrice(event.priceCents)
        : event.type === 'inventory_restock'
          ? `+${event.qty}`
          : '';
    return h(
      'div',
      {
        class: 'stream-row',
        onclick: event.orderId ? () => openJourney(event.orderId) : null,
        title: event.orderId ? `查看订单 ${event.orderId} 的完整去向` : '',
        style: event.orderId ? { cursor: 'pointer' } : {},
      },
      h('span', { class: 't' }, `D${event.day + 1} ${fmtHour(event.hour ?? 9)}`),
      h('span', { class: `tag ${event.type}` }, tag),
      h('span', { class: 'detail' }, eventDetail(event, state.channels)),
      h('span', { class: 'amt' }, amount),
    );
  });
}

function rightColumn(state, store) {
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
    panel({
      title: '生效方案',
      sub: state.appliedPlan?.id || '—',
      body: h(
        'div',
        {},
        state.appliedPlan
          ? h(
              'div',
              {},
              h('div', { class: 'pc-name', style: { marginBottom: '6px' } }, h('span', {}, state.appliedPlan.name)),
              h(
                'div',
                { class: 'pc-prices' },
                state.channels.map((channel) =>
                  h(
                    'span',
                    { class: 'pc-price' },
                    h('i', { style: { background: channel.color } }),
                    `${channel.short} ${fmtPrice(state.appliedPlan.prices[channel.id])}`,
                  ),
                ),
              ),
              h(
                'div',
                { class: 'pc-meta' },
                h('span', {}, `版本 v${state.appliedPlan.revision}`),
                h('span', {}, `规则 ${state.rule.info.label}`),
                state.appliedPlan.rulesStale ? h('span', { class: 'pill warn' }, '规则已变') : null,
              ),
              h(
                'div',
                { style: { marginTop: '10px' } },
                h(
                  'button',
                  {
                    class: 'btn small',
                    onclick: () => {
                      selectPlan(state.appliedPlan.id);
                      navigate('lab');
                    },
                  },
                  '在方案实验室查看',
                ),
              ),
            )
          : emptyState('没有生效方案。'),
      ),
    }),
    panel({
      title: '规则版本',
      sub: `${state.rule.info.label} · ${state.rule.info.name}`,
      body: h(
        'div',
        {},
        h('p', { class: 'small muted', style: { margin: '0 0 8px' } }, state.rule.info.note),
        h(
          'table',
          { class: 'table mini-table' },
          h('thead', {}, h('tr', {}, h('th', {}, '渠道'), h('th', {}, '下限'), h('th', {}, '费率'), h('th', {}, '规则版本'))),
          h(
            'tbody',
            {},
            state.channels.map((channel) => {
              const rule = state.rule.rulebook[channel.id];
              return h(
                'tr',
                {},
                h('td', {}, h('div', { class: 'name-cell' }, channelDot(channel.color), channel.short)),
                h('td', { class: 'num' }, fmtPrice(rule.floorCents)),
                h('td', { class: 'num' }, fmtPrice(rule.feeCents)),
                h('td', { class: 'mono tiny' }, rule.ruleVersion),
              );
            }),
          ),
        ),
        h(
          'button',
          {
            class: 'btn small ghost',
            style: { marginTop: '10px' },
            onclick: () => {
              bumpRules();
            },
            title: '模拟一次平台费率变更：已确认方案将失效，需要重新核对',
          },
          h('span', { html: icon('alert', 14).outerHTML }),
          '模拟规则变更',
        ),
      ),
    }),
    panel({
      title: '检查点与撤销',
      sub: `${state.checkpoints.length} 个检查点 · ${state.undo.length} 步可撤销`,
      body: h(
        'div',
        {},
        state.checkpoints.length
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '10px' } },
              state.checkpoints.map((cp) =>
                h(
                  'div',
                  { class: 'split-row' },
                  h(
                    'div',
                    {},
                    h('div', { class: 'small' }, cp.label),
                    h('div', { class: 'tiny muted' }, `${cp.id} · 第 ${cp.day + 1} 天 · tick ${cp.tick}`),
                  ),
                  h('button', { class: 'btn tiny', onclick: () => restoreCheckpoint(cp.id) }, '恢复'),
                ),
              ),
            )
          : h('p', { class: 'small muted', style: { margin: '0 0 10px' } }, '还没有检查点。打点后可以随时回到该时刻，包括库存和方案状态。'),
        h(
          'div',
          { class: 'form-inline' },
          h(
            'button',
            {
              class: 'btn small',
              onclick: () => saveCheckpoint(`第 ${state.day + 1} 天手动打点`),
            },
            h('span', { html: icon('flag', 14).outerHTML }),
            '打一个检查点',
          ),
          h(
            'button',
            {
              class: 'btn small ghost',
              onclick: () => undo(),
            },
            h('span', { html: icon('undo', 14).outerHTML }),
            '撤销上一步',
          ),
        ),
        h(
          'div',
          { class: 'callout', style: { marginTop: '12px' } },
          '检查点保存的是完整回放快照（事件、库存账本、方案与时钟），恢复后的事件序列与原来逐字节一致。',
        ),
      ),
    }),
  );
}
