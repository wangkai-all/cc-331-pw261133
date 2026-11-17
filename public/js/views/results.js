/**
 * Results and identification.
 *
 * Two questions, kept visually separate:
 *   1. What did the replay show? (observed conversion, stockout windows)
 *   2. What can be learned from it? (fitted price effects, intervals, and
 *      explicit identification checks that say "no" when the design cannot
 *      separate price from scarcity)
 *
 * The estimator switch (per-channel vs joint shared-stock) and the censoring
 * treatment switch are here because they change the answer, and the point is to
 * see by how much.
 */

import {
  h,
  icon,
  clear,
  fmtInt,
  fmtPct,
  fmtPrice,
  fmtSignedPct,
  fmtMoneyShort,
  clamp,
} from '../util.js';
import { pageHead, panel, emptyState, seg, channelDot } from './common.js';
import { dailyConversionChart, lollipopRow, legend, barRow, priceStepChart, tooltipNode, lineChart } from '../charts.js';
import { store, loadAnalysis, setMethod, setCensorMode, selectPlan } from '../store.js';
import { openModal, closeModal, toast } from '../dialog.js';
import { navigate } from '../nav.js';

const ELASTICITY_MIN = -6;
const ELASTICITY_MAX = 1;

export function renderResults() {
  return h('div', {});
}

export function mountResults(root) {
  const live = root;
  let unmounted = false;

  function draw() {
    if (unmounted) return;
    const state = store.state;
    if (!state) return;
    clear(live);
    live.append(
      pageHead({
        title: '结果与识别',
        subtitle:
          '用事件日志做估计：曝光、成交、被截断的时段。模型只能给出需求假设下的价格弹性；当设计无法区分“没人买”和“没货卖”时，这里会直接说不可识别。',
        actions: [
          h(
            'button',
            { class: 'btn small ghost', onclick: () => loadAnalysis({ force: true }) },
            h('span', { html: icon('refresh', 14).outerHTML }),
            '重算',
          ),
        ],
      }),
    );
    live.append(
      h(
        'div',
        { class: 'panel', style: { marginBottom: '14px' } },
        h(
          'div',
          { class: 'panel-body' },
          h(
            'div',
            { class: 'method-toggle' },
            h('span', { class: 'small muted' }, '估计方法'),
            seg({
              options: [
                { value: 'shared', label: '联合（共享库存）', title: '渠道固定效应 + 共享交叉价格项，按处理顺序处理截断阈值' },
                { value: 'channel', label: '按渠道独立', title: '每个渠道单独拟合，忽略共享库存与跨渠道价格' },
              ],
              value: store.method,
              onSelect: setMethod,
            }),
            h('span', { class: 'small muted', style: { marginLeft: '10px' } }, '被截断时段'),
            seg({
              options: [
                { value: 'censored', label: '截断似然', title: '把缺货时段当作“至少卖了这么多”的下界' },
                { value: 'drop', label: '剔除', title: '删掉被截断的时段，只用完整观测' },
                { value: 'naive', label: '当作完整（错误）', title: '把缺货时段的零成交当成零需求——本页要暴露的错误做法' },
              ],
              value: store.censorMode,
              onSelect: setCensorMode,
            }),
            h(
              'span',
              { class: 'tiny muted', style: { marginLeft: 'auto' } },
              store.analysis
                ? `截至第 ${store.analysis.asOfDay + 1} 天 · ${fmtInt(store.analysis.rows)} 个时段观测`
                : '',
            ),
          ),
        ),
      ),
    );

    if (store.analysisLoading && !store.analysis) {
      live.append(h('div', { class: 'panel' }, h('div', { class: 'empty' }, '正在拟合……')));
      return;
    }
    const analysis = store.analysis;
    if (!analysis) {
      if (!store.analysisLoading && !store.analysisError) loadAnalysis({ force: true });
      live.append(
        panel({
          title: store.analysisError ? '估计失败' : '正在估计',
          body: emptyState(
            store.analysisError
              ? `${store.analysisError}。请先在“回放台”推进若干天。`
              : '先推进几天回放，再回到这里查看估计与识别诊断。',
          ),
        }),
      );
      return;
    }
    live.append(analysisBody(analysis, state));
  }

  function analysisBody(analysis, state) {
    const fits = analysis.fits;
    const censoredShare = analysis.totals.censoredRows / Math.max(1, analysis.totals.tickRows);
    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
      analysis.method === 'shared' && analysis.joint?.gammaNote
        ? h(
            'div',
            { class: 'callout warn' },
            h('b', {}, '联合模型退化了。'),
            ` ${analysis.joint.gammaNote}`,
          )
        : null,
      censorModeNote(analysis),
      h(
        'div',
        { class: 'grid sidebar-right' },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
          panel({
            title: '各渠道日转化率',
            sub: '空心点 = 当日有时段被截断，只能看作下界',
            body: h(
              'div',
              {},
              legend(state.channels.map((c) => ({ color: c.color, label: c.short }))),
              dailyConversionChart({
                daily: analysis.daily,
                channels: state.channels,
                days: analysis.daysCovered,
                tooltipFactory: ({ series }) => chartTooltip(analysis, series),
              }),
            ),
          }),
          panel({
            title: '价格轨迹',
            sub: '阶梯线标出每次上线方案的时刻',
            body: priceStepChart({
              spells: analysis.priceSpells,
              channels: state.channels,
              days: analysis.daysCovered.length ? rangeDays(analysis.daysCovered) : [0, 1],
            }),
          }),
          panel({
            title: '估计结果',
            sub: `弹性点估计与 95% 区间 · ${analysis.method === 'shared' ? '联合模型' : '渠道独立'}`,
            body: h(
              'div',
              {},
              h(
                'div',
                { style: { marginBottom: '6px' } },
                legend(state.channels.map((c) => ({ color: c.color, label: c.short }))),
              ),
              fits.map((fit) => {
                const channel = state.channels.find((c) => c.id === fit.channelId);
                return lollipopRow({
                  label: channel?.short || fit.channelId,
                  color: fit.color,
                  value: fit.elasticity,
                  ci: fit.elasticityCi,
                  min: ELASTICITY_MIN,
                  max: ELASTICITY_MAX,
                  status: fit.identification.status,
                  valueLabel:
                    fit.elasticity == null
                      ? '—'
                      : `${fit.elasticity.toFixed(2)}${
                          fit.elasticityCi ? ` [${fit.elasticityCi[0].toFixed(1)}, ${fit.elasticityCi[1].toFixed(1)}]` : ''
                        }`,
                });
              }),
              h(
                'div',
                { class: 'tiny muted', style: { marginTop: '8px' } },
                '弹性是“价格翻倍时需求变化的近似百分比”。空心点表示斜率仅按先验固定（不可识别）或 95% 区间跨越 0（方向不确定），不能当作已测出的效应。',
              ),
            ),
          }),
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
          panel({
            title: '识别诊断',
            sub: identSummaryText(analysis),
            body: h(
              'div',
              { class: 'ident-list' },
              analysis.identification.map((item) => identItem(item)),
            ),
          }),
          panel({
            title: '被截断的需求',
            sub: '下界 + 模型区间，不是测量值',
            body: h(
              'div',
              {},
              analysis.stockouts.map((s) => {
                const channel = state.channels.find((c) => c.id === s.channelId);
                return h(
                  'div',
                  { style: { marginBottom: '10px' } },
                  h(
                    'div',
                    { class: 'split-row', style: { borderBottom: '0', paddingBottom: '2px' } },
                    h('span', { style: { display: 'flex', gap: '7px', alignItems: 'center' } }, channelDot(s.color), h('span', { class: 'small' }, s.short)),
                    h(
                      'span',
                      { class: 'mono tiny' },
                      `${fmtInt(s.observedOrders)} 实付 / 约 ${fmtInt(s.modelDemand)} 需求`,
                    ),
                  ),
                  modelBand(s, channel),
                  h(
                    'div',
                    { class: 'tiny muted', style: { marginTop: '3px' } },
                    `${s.censoredRows} 个时段被截断 · 缺失约占 ${fmtPct(s.missingShare, 0)}`,
                  ),
                );
              }),
              h(
                'div',
                { class: 'tiny muted' },
                `合计：观测成交 ${fmtInt(analysis.totals.observedOrders)}，模型需求约 ${fmtInt(
                  analysis.totals.modelDemand,
                )}，缺口约 ${fmtInt(analysis.totals.missingEstimate)} 件。缺口是假设推出来的，不能当成事实。`,
              ),
            ),
          }),
          panel({
            title: '联立检验',
            sub: analysis.method === 'shared' ? '共享交叉价格项' : '渠道独立模型未估计该项',
            body: h(
              'div',
              {},
              analysis.method === 'shared'
                ? h(
                    'div',
                    {},
                    h(
                      'div',
                      { class: 'kv' },
                      h('dt', {}, '交叉价格项 γ'),
                      h(
                        'dd',
                        {},
                        analysis.joint.gammaIdentified
                          ? `${analysis.joint.gamma?.toFixed(2)}（CI ${analysis.joint.gammaCi
                              .map((v) => v.toFixed(2))
                              .join(' – ')}）`
                          : '无法识别，按 0 处理',
                      ),
                      h('dt', {}, '对数似然'),
                      h('dd', { class: 'mono' }, analysis.joint.nll?.toFixed(1) ?? '—'),
                      h('dt', {}, '迭代次数'),
                      h('dd', {}, fmtInt(analysis.joint.iterations)),
                    ),
                    analysis.joint.gammaIdentified
                      ? h(
                          'div',
                          { class: 'tiny muted', style: { marginTop: '6px' } },
                          'γ 显著偏离 0：其他渠道的价格也会影响本渠道转化，按渠道独立估计会遗漏这部分。',
                        )
                      : h(
                          'div',
                          { class: 'tiny muted', style: { marginTop: '6px' } },
                          '各渠道价格同向变化时，交叉价格项无法与自身价格分离；模型退回渠道固定效应，标准误不再被这个项撑大。',
                        ),
                  )
                : h(
                    'div',
                    { class: 'tiny muted' },
                    '按渠道独立估计把每个渠道当作孤岛：既忽略共享库存造成的顺序竞争，也忽略其他渠道的价格。',
                  ),
              h(
                'div',
                { style: { marginTop: '10px' } },
                h(
                  'div',
                  { class: 'small', style: { marginBottom: '6px' } },
                  '库存截断占比',
                ),
                analysis.stockouts.map((s) =>
                  barRow({
                    label: s.short,
                    value: s.censoredRows,
                    max: Math.max(1, ...analysis.stockouts.map((x) => x.censoredRows)),
                    color: s.color,
                    valueLabel: `${s.censoredRows} 段`,
                  }),
                ),
                h(
                  'div',
                  { class: 'tiny muted', style: { marginTop: '4px' } },
                  `整体有 ${fmtPct(censoredShare, 0)} 的时段被截断；这些时段给出的只是成交下界。`,
                ),
              ),
            ),
          }),
        ),
      ),
      backtestPanel(analysis, state),
      h(
        'div',
        { class: 'callout', style: { marginTop: '4px' } },
        h('b', {}, '结论边界：'),
        ' 这里所有“需求”都来自需求模型假设。被截断的时段只告诉你“至少卖了这么多”；如果某个渠道的价格在整个观察期内没有变化，它的弹性不可识别，界面不会给出一个看似精确实则编造的数字。',
      ),
    );
  }

  function censorModeNote(analysis) {
    if (analysis.censorMode === 'naive') {
      return h(
        'div',
        { class: 'callout bad' },
        h('b', {}, '当前使用错误做法：'),
        ' 把缺货时段的零成交当作完整观测。截断时段会被读成“需求为零”，从而把缺货错误地归因于价格。这个开关的作用是让这种偏差可见。',
      );
    }
    if (analysis.censorMode === 'drop') {
      return h(
        'div',
        { class: 'callout warn' },
        h('b', {}, '当前剔除被截断时段：'),
        ' 不会引入错误观测，但会丢失信息，并且剔除本身与需求相关（卖得好的时段更容易缺货），估计会有选择偏差。',
      );
    }
    return h(
      'div',
      { class: 'callout' },
      h('b', {}, '当前使用截断似然：'),
      ' 缺货时段贡献的是 P(成交 ≥ 观测值) 而不是一次完整观测；开始时就无货的时段被直接丢弃，因为它们不含任何需求信息。',
    );
  }

  function identSummaryText(analysis) {
    // `estimatedChannelCount` only excludes "unidentified", so a run whose
    // intervals all cross zero would read as "4 / 4 可估计". Break it down.
    const items = analysis.identification || [];
    const ok = items.filter((i) => i.tone === 'ok').length;
    const weak = items.filter((i) => i.tone === 'warn').length;
    const dead = items.filter((i) => i.tone === 'bad').length;
    if (!items.length) return '尚无可估计的渠道';
    const parts = [];
    if (ok) parts.push(`${ok} 个方向明确`);
    if (weak) parts.push(`${weak} 个弱识别`);
    if (dead) parts.push(`${dead} 个不可识别`);
    return `${items.length} 个渠道 · ${parts.join(' · ')}`;
  }

  function identItem(item) {
    const tone = item.tone === 'bad' ? 'bad' : item.tone === 'warn' ? 'warn' : '';
    return h(
      'div',
      { class: `ident-item ${tone}`.trim() },
      h(
        'div',
        { class: 'it-head' },
        h('span', {}, item.channelName),
        h('span', { class: `pill ${item.tone === 'ok' ? 'ok' : item.tone}` }, item.label),
      ),
      h(
        'div',
        { class: 'tiny muted', style: { marginTop: '3px' } },
        `${item.priceLevels} 个价格 · ${fmtPrice(item.priceMin)} – ${fmtPrice(item.priceMax)} · 未截断 ${item.uncensoredRows} 段 / 截断 ${item.censoredRows} 段`,
      ),
      item.reasons.length
        ? h('ul', {}, item.reasons.map((reason) => h('li', {}, reason)))
        : h('ul', {}, h('li', {}, '价格有变化，未截断样本足够，可以估计自身价格效应。')),
    );
  }

  function modelBand(s, channel) {
    const max = Math.max(s.modelDemand, s.observedOrders, 1);
    return h(
      'div',
      { class: 'demand-band', style: { marginTop: '2px' } },
      h(
        'div',
        { class: 'bar' },
        h('i', { class: 'obs', style: { width: `${clamp((s.observedOrders / max) * 100, 0, 100)}%` } }),
        h('i', {
          class: 'gap',
          style: {
            left: `${clamp((s.observedOrders / max) * 100, 0, 100)}%`,
            width: `${clamp(((s.modelDemand - s.observedOrders) / max) * 100, 0, 100)}%`,
          },
        }),
      ),
      h('span', { class: 'mono tiny', style: { color: channel?.color } }, `[${fmtInt(s.intervalLow)}–${fmtInt(s.intervalHigh)}]`),
    );
  }

  function backtestPanel(analysis, state) {
    const bt = analysis.backtest;
    if (!bt || !bt.windows.length) {
      return panel({
        title: 'As-of 回测',
        body: emptyState('至少完成两天的回放后，才能做“只用当时可见信息”的回测。'),
      });
    }
    return panel({
      title: 'As-of 回测',
      sub: `${bt.summary.windows} 个窗口 · MAE ${bt.summary.mae == null ? '—' : fmtPct(bt.summary.mae, 2)}`,
      actions: [
        h('span', { class: 'pill blue' }, `覆盖率 ${bt.summary.coverage == null ? '—' : fmtPct(bt.summary.coverage, 0)}`),
        h('span', { class: 'pill warn' }, `跳过被截断 ${bt.summary.skippedCensored} 项`),
      ],
      body: h(
        'div',
        {},
        h(
          'div',
          { class: 'callout', style: { marginBottom: '10px' } },
          bt.note,
        ),
        h(
          'div',
          { class: 'table-scroll' },
          h(
            'table',
            { class: 'table mini-table' },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                h('th', {}, '收盘日'),
                h('th', {}, '渠道'),
                h('th', { class: 'right' }, '预测转化'),
                h('th', { class: 'right' }, '实现转化'),
                h('th', { class: 'right' }, '误差'),
                h('th', {}, '状态'),
              ),
            ),
            h(
              'tbody',
              {},
              bt.windows.flatMap((w) =>
                w.channels.map((c) =>
                  h(
                    'tr',
                    {},
                    h('td', { class: 'tiny mono' }, `D${w.day + 1}`),
                    h('td', {}, h('div', { class: 'name-cell' }, channelDot(c.color), c.short)),
                    h('td', { class: 'num right' }, fmtPct(c.forecastConversion, 2)),
                    h('td', { class: 'num right' }, c.realizedConversion == null ? '—' : fmtPct(c.realizedConversion, 2)),
                    h('td', { class: 'num right' }, c.absoluteError == null ? '—' : fmtPct(c.absoluteError, 2)),
                    h(
                      'td',
                      {},
                      c.censored
                        ? h('span', { class: 'pill warn', title: c.note }, '跳过（截断）')
                        : c.scored
                          ? h('span', { class: `pill ${c.covered ? 'ok' : 'bad'}` }, c.covered ? '落在区间内' : '区间外')
                          : h('span', { class: 'pill' }, '—'),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        h(
          'div',
          { class: 'tiny muted', style: { marginTop: '8px' } },
          '每个窗口的拟合只用到当天收市为止的事件；次日实现值仅用于打分。部分时段缺货的次日不计误差，否则“缺货”会被误计为预测失败。',
        ),
      ),
    });
  }

  function rangeDays(days) {
    const out = [];
    for (let d = days[0]; d <= days[days.length - 1]; d += 1) out.push(d);
    return out;
  }

  function chartTooltip(analysis, series) {
    const node = tooltipNode();
    const tooltip = {
      node,
      show(index) {
        const day = analysis.daysCovered[index];
        if (day == null) return;
        const rows = analysis.daily.filter((d) => d.day === day);
        clear(node);
        node.append(h('div', {}, h('b', {}, `第 ${day + 1} 天`)));
        for (const s of series) {
          const row = rows.find((r) => r.channelId === s.id);
          const point = s.points[index];
          if (!row || point?.y == null) continue;
          node.append(
            h(
              'div',
              { class: 'row' },
              h('span', {}, `${s.label}${row.censored ? ' †' : ''}`),
              h('b', {}, fmtPct(row.conversion, 2)),
            ),
          );
        }
        node.classList.add('on');
      },
      move(x) {
        node.style.left = `${(x / 760) * 100}%`;
        node.style.top = '12px';
      },
      hide() {
        node.classList.remove('on');
      },
    };
    return tooltip;
  }

  draw();
  if (!store.analysis || store.analysis.key !== `${store.method}|${store.censorMode}`) loadAnalysis();
  return {
    update: draw,
    unmount: () => {
      unmounted = true;
    },
  };
}
