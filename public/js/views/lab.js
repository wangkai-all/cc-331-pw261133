/**
 * Plan laboratory.
 *
 * The plan workflow lives here: draft → validate (rules + stock claim) →
 * confirm (freeze prices and rule versions) → apply. Drafts can be simulated
 * at any time because simulation runs on a cloned engine. Parallel plans claim
 * from one shared pool, so the screen always shows what is left to claim and
 * what the other plans already reserved.
 */

import {
  h,
  icon,
  clear,
  fmtInt,
  fmtMoney,
  fmtMoneyShort,
  fmtPrice,
  fmtPct,
  fmtSignedPct,
  clamp,
} from '../util.js';
import { pageHead, panel, findingRow, seg, emptyState, kv, channelDot } from './common.js';
import {
  store,
  selectPlan,
  createPlan,
  editPlan,
  editPlanDebounced,
  duplicatePlan,
  validatePlan,
  simulatePlan,
  confirmPlan,
  applyPlan,
  comparePlans,
  toggleCompare,
} from '../store.js';
import { openModal, closeModal, toast } from '../dialog.js';
import { navigate } from '../nav.js';

const HORIZON_OPTIONS = [
  { value: 6, label: '1 天' },
  { value: 18, label: '3 天' },
  { value: 36, label: '6 天' },
];

const PRICE_MIN = 9000;
const PRICE_MAX = 15600;
const PRICE_STEP = 100;

// Mirrors MIN_BUFFER_UNITS in src/plans.js: the shared pool must keep this many
// units unreserved so the running plan can still sell.
const MIN_BUFFER_UNITS = 40;
const DEFAULT_CLAIM_UNITS = 80;

export function renderLab() {
  const root = h('div', {});
  root.append(h('div', {}));
  return root;
}

export function mountLab(root) {
  const live = root.firstChild;
  let validation = null;
  let validationKey = null;
  let validationToken = 0;
  let claimUnits = 0;
  let claimPlanId = null;
  let horizon = 18;
  let compareOpen = false;

  function planFor(state) {
    return state.plans.find((p) => p.id === store.selectedPlanId) || state.plans[0] || null;
  }

  function syncClaim(state, plan) {
    if (!plan) return 0;
    if (claimPlanId !== plan.id) {
      claimPlanId = plan.id;
      // A fresh draft has no claim yet. Default to a sensible reservation so
      // the operator sees a real "reserve X, leave Y" preview instead of a
      // silent 0 that would be rejected at confirmation.
      claimUnits =
        plan.liveClaim?.units ??
        plan.claimUnits ??
        Math.max(MIN_BUFFER_UNITS, Math.min(DEFAULT_CLAIM_UNITS, state.claimableUnits - state.bufferUnits));
    }
    claimUnits = clamp(claimUnits, 0, state.claimableUnits);
    return claimUnits;
  }

  async function loadValidation(key, planId, units) {
    const token = ++validationToken;
    try {
      const result = await validatePlan(planId, units);
      if (token !== validationToken) return;
      validation = result;
      validationKey = key;
      draw();
    } catch (error) {
      if (token !== validationToken) return;
      validation = { ok: false, findings: [{ level: 'blocker', message: error.message }], blockers: [] };
      validationKey = key;
      draw();
    }
  }

  function draw() {
    const state = store.state;
    if (!state) return;
    let plan = planFor(state);
    if (!plan) return;
    if (!store.selectedPlanId) store.selectedPlanId = plan.id;
    const units = syncClaim(state, plan);
    const key = `${plan.id}|${plan.revision}|${state.claimedUnits}|${units}|${state.rule.epoch}`;
    if (validationKey !== key) {
      validation = null;
      loadValidation(key, plan.id, units);
    }
    clear(live);
    live.append(
      pageHead({
        title: '方案实验室',
        subtitle:
          '为多个渠道同时设定价格。草稿可以反复试算；确认会冻结价格、规则版本与库存预留；上线后旧方案立即被取代，不能再被重新启用或超占库存。',
        actions: [
          h(
            'button',
            { class: 'btn small', onclick: () => createDraftDialog(state) },
            h('span', { html: icon('plus', 14).outerHTML }),
            '新建草稿',
          ),
          h(
            'button',
            {
              class: 'btn small ghost',
              onclick: () => {
                compareOpen = !compareOpen;
                draw();
              },
            },
            h('span', { html: icon('chart', 14).outerHTML }),
            compareOpen ? '收起对比' : `方案对比${store.compareIds.length ? ` (${store.compareIds.length})` : ''}`,
          ),
        ],
      }),
      h('div', { class: 'plan-grid' }, leftColumn(state, plan, units), rightColumn(state, plan, units)),
    );
  }

  /* ------------------------------------------------------------- left side */

  function leftColumn(state, plan, units) {
    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
      panel({
        title: '方案列表',
        sub: `预留合计 ${fmtInt(state.claimedUnits)} 件 · 仍可承诺 ${fmtInt(state.claimableUnits)} 件`,
        actions: [
          h(
            'button',
            {
              class: 'btn tiny ghost',
              onclick: () => compareDialog(state),
              title: '选择 2–4 个方案做同窗口试算',
            },
            '并列试算',
          ),
        ],
        body: h(
          'div',
          { class: 'plan-list' },
          [...state.plans]
            .sort((a, b) => b.createdAtTick - a.createdAtTick || b.id.localeCompare(a.id))
            .map((p) => planCard(p, state)),
          h(
            'button',
            { class: 'btn ghost small', style: { marginTop: '4px' }, onclick: () => createDraftDialog(state) },
            h('span', { html: icon('plus', 14).outerHTML }),
            '新建价格方案',
          ),
        ),
      }),
      compareOpen ? comparePanel(state) : null,
      panel({
        title: `编辑 ${plan.id}`,
        sub:
          plan.status === 'draft'
            ? `草稿 · 版本 v${plan.revision} · 可修改`
            : `${plan.statusLabel} · 价格已冻结`,
        actions: planActions(plan, state),
        body: planEditor(plan, state, units),
      }),
    );
  }

  function planCard(plan, state) {
    const selected = plan.id === store.selectedPlanId;
    const active = plan.id === state.appliedPlanId;
    const classes = ['plan-card', selected ? 'selected' : '', active ? 'active' : '', plan.rulesStale ? 'stale' : '']
      .filter(Boolean)
      .join(' ');
    return h(
      'div',
      {
        class: classes,
        onclick: () => {
          selectPlan(plan.id);
          draw();
        },
      },
      h(
        'div',
        { class: 'pc-head' },
        h(
          'div',
          { class: 'pc-name' },
          h('span', {}, plan.name),
          h('span', { class: `pill ${plan.status === 'draft' ? 'blue' : plan.status === 'active' ? 'ok' : plan.status === 'confirmed' ? 'warn' : ''}`.trim() }, plan.statusLabel),
          plan.rulesStale ? h('span', { class: 'pill warn' }, '规则已变') : null,
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
          plan.liveClaim
            ? h('span', { class: 'pill', title: '已为并行方案预留的件数' }, `留 ${plan.liveClaim.units}`)
            : null,
          h(
            'button',
            {
              class: 'btn tiny ghost',
              title: '加入/移出并列试算',
              onclick: (event) => {
                event.stopPropagation();
                toggleCompare(plan.id);
                draw();
              },
            },
            store.compareIds.includes(plan.id) ? '✓ 对比' : '+ 对比',
          ),
        ),
      ),
      h(
        'div',
        { class: 'pc-prices' },
        state.channels.map((channel) =>
          h(
            'span',
            { class: 'pc-price' },
            h('i', { style: { background: channel.color } }),
            `${channel.short} ${fmtPrice(plan.prices[channel.id])}`,
          ),
        ),
      ),
      h(
        'div',
        { class: 'pc-meta' },
        h('span', {}, 'v', h('b', {}, String(plan.revision))),
        h('span', {}, `创建于 tick ${plan.createdAtTick}`),
        plan.confirmation ? h('span', {}, `确认 r${plan.confirmation.revision}`) : null,
        plan.supersededBy ? h('span', { class: 'pill' }, `被 ${plan.supersededBy} 取代`) : null,
      ),
    );
  }

  function planActions(plan, state) {
    const editable = plan.status === 'draft';
    return [
      h(
        'button',
        {
          class: 'btn tiny ghost',
          title: '复制一份草稿，保留当前价格',
          onclick: () => duplicatePlan(plan.id),
        },
        '复制',
      ),
      editable
        ? h(
            'button',
            {
              class: 'btn tiny',
              title: '把四个渠道恢复为参考价',
              onclick: async () => {
                await editPlan(plan.id, {
                  prices: Object.fromEntries(state.channels.map((c) => [c.id, c.priceAnchorCents])),
                });
                draw();
              },
            },
            '恢复参考价',
          )
        : null,
    ].filter(Boolean);
  }

  function planEditor(plan, state, units) {
    if (plan.status !== 'draft') {
      return h(
        'div',
        {},
        h(
          'div',
          { class: 'callout', style: { marginBottom: '12px' } },
          h('b', {}, '该方案已冻结。'),
          ' 确认时锁定了价格、规则版本与库存预留；如需调整价格，请复制为新草稿。',
        ),
        priceTable(plan, state, null),
        plan.confirmation
          ? h(
              'div',
              { style: { marginTop: '12px' } },
              kv([
                ['确认时点', `tick ${plan.confirmation.tick}`],
                ['确认版本', `v${plan.confirmation.revision}`],
                ['规则批次', `${state.rule.info.label}（epoch ${plan.confirmation.ruleEpoch}）`],
                ['预留件数', `${fmtInt(plan.confirmation.claimUnits || 0)} 件`],
                [
                  '规则版本',
                  h(
                    'div',
                    { class: 'mono tiny' },
                    Object.entries(plan.confirmation.ruleVersions || {}).map(([id, v]) => h('div', {}, `${id}: ${v}`)),
                  ),
                ],
              ]),
            )
          : null,
      );
    }
    return h(
      'div',
      {},
      h(
        'div',
        { class: 'price-scale' },
        h('span', {}, `下限 ${fmtPrice(PRICE_MIN)}`),
        h('span', { class: 'muted' }, '拖动滑块或直接输入价格（元）'),
        h('span', {}, `上限 ${fmtPrice(PRICE_MAX)}`),
      ),
      state.channels.map((channel) => channelSlider(channel, plan, state)),
      h(
        'div',
        { style: { marginTop: '10px' } },
        priceTable(plan, state, units),
      ),
      h(
        'div',
        { class: 'form-inline', style: { marginTop: '12px' } },
        h(
          'button',
          {
            class: 'btn small',
            onclick: () => {
              const handle = {};
              openModal({
                title: `重命名 ${plan.id}`,
                body: nameForm(plan, handle),
                footer: [
                  h('button', { class: 'btn ghost', onclick: closeModal }, '取消'),
                  h('button', { class: 'btn primary', onclick: () => handle.save() }, '保存'),
                ],
              });
            },
          },
          '重命名 / 备注',
        ),
        h(
          'button',
          {
            class: 'btn small ghost',
            onclick: () => simulateFor(plan),
            disabled: store.simLoading,
          },
          h('span', { html: icon('chart', 14).outerHTML }),
          store.simLoading ? '试算中…' : '试算该草稿',
        ),
      ),
    );
  }

  function channelSlider(channel, plan, state) {
    const rule = state.rule.rulebook[channel.id];
    const price = plan.prices[channel.id];
    const margin = price - rule.unitCostCents - rule.feeCents;
    const anchorDelta = ((price - channel.priceAnchorCents) / channel.priceAnchorCents) * 100;
    const range = h('input', {
      type: 'range',
      min: String(PRICE_MIN),
      max: String(PRICE_MAX),
      step: String(PRICE_STEP),
      value: String(price),
      style: { '--ch-color': channel.color },
      oninput: (event) => {
        const value = Number(event.target.value);
        const input = event.target.parentElement.parentElement.querySelector('.price-input');
        if (input) input.value = (value / 100).toFixed(0);
        editPlanDebounced(plan.id, { prices: { [channel.id]: value } });
      },
    });
    return h(
      'div',
      { class: 'slider-row', style: { '--ch-color': channel.color } },
      h('div', { class: 'sl-label' }, channelDot(channel.color), channel.short, h('span', { class: 'tiny muted' }, channel.name)),
      range,
      h(
        'div',
        {},
        h('input', {
          class: 'price-input',
          type: 'number',
          min: String(PRICE_MIN / 100),
          max: String(PRICE_MAX / 100),
          step: '1',
          value: (price / 100).toFixed(0),
          onchange: (event) => {
            const yuan = Number(event.target.value);
            if (!Number.isFinite(yuan)) return;
            editPlan(plan.id, { prices: { [channel.id]: Math.round(yuan * 100) } }).then(draw);
          },
        }),
        h(
          'div',
          { class: 'tiny', style: { marginTop: '3px', color: margin < rule.minMarginCents ? 'var(--red)' : 'var(--text-3)' } },
          `${fmtSignedPct(anchorDelta, 0)} · 净 ${fmtPrice(margin)}`,
        ),
      ),
    );
  }

  function priceTable(plan, state, units) {
    return h(
      'table',
      { class: 'table mini-table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', {}, '渠道'),
          h('th', { class: 'right' }, '方案价'),
          h('th', { class: 'right' }, '参考价'),
          h('th', { class: 'right' }, '幅度'),
          h('th', { class: 'right' }, '净贡献'),
          h('th', {}, '规则'),
        ),
      ),
      h(
        'tbody',
        {},
        state.channels.map((channel) => {
          const rule = state.rule.rulebook[channel.id];
          const price = plan.prices[channel.id];
          const margin = price - rule.unitCostCents - rule.feeCents;
          const delta = ((price - channel.priceAnchorCents) / channel.priceAnchorCents) * 100;
          const bad = price < rule.floorCents || price > rule.ceilingCents || margin < rule.minMarginCents;
          return h(
            'tr',
            {},
            h('td', {}, h('div', { class: 'name-cell' }, channelDot(channel.color), channel.short)),
            h('td', { class: `num right ${bad ? 'neg' : ''}`.trim() }, fmtPrice(price)),
            h('td', { class: 'num right muted' }, fmtPrice(channel.priceAnchorCents)),
            h('td', { class: `num right ${delta > 0 ? 'pos' : delta < 0 ? 'neg' : 'muted'}` }, fmtSignedPct(delta, 1)),
            h('td', { class: `num right ${margin < rule.minMarginCents ? 'neg' : ''}`.trim() }, fmtPrice(margin)),
            h('td', { class: 'tiny muted' }, `${rule.maxDiscountPct}% 折扣 · 费 ${fmtPrice(rule.feeCents)}`),
          );
        }),
      ),
    );
  }

  function nameForm(plan, onSubmit) {
    const name = h('input', { type: 'text', value: plan.name, maxlength: '40' });
    const note = h('textarea', {
      rows: '3',
      style: {
        background: 'var(--bg-elev)',
        border: '1px solid var(--line)',
        borderRadius: '8px',
        padding: '8px 10px',
        resize: 'vertical',
        color: 'inherit',
      },
    });
    note.value = plan.note || '';
    const save = async () => {
      await editPlan(plan.id, { name: name.value, note: note.value });
      closeModal();
      draw();
    };
    onSubmit.save = save;
    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      h('div', { class: 'form-row' }, h('label', {}, '方案名称'), name),
      h('div', { class: 'form-row' }, h('label', {}, '备注（会出现在确认记录中）'), note),
    );
  }

  /* ------------------------------------------------------------ right side */

  function rightColumn(state, plan, units) {
    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
      claimPanel(state, plan, units),
      validationPanel(state, plan, units),
      simulationPanel(state, plan),
    );
  }

  function claimPanel(state, plan, units) {
    const free = state.claimableUnits;
    const others = state.claims.filter((c) => c.releasedAtTick == null && c.planId !== plan.id);
    const input = h('input', {
      type: 'number',
      min: '0',
      max: String(free),
      step: '10',
      value: String(units),
      style: { width: '92px' },
      oninput: (event) => {
        claimUnits = clamp(Number(event.target.value) || 0, 0, free);
        draw();
      },
    });
    const locked = plan.status !== 'draft';
    return panel({
      title: '库存预留与确认',
      sub: `共享池可承诺 ${fmtInt(free)} 件`,
      body: h(
        'div',
        {},
        h(
          'div',
          { class: 'small muted', style: { marginBottom: '8px' } },
          '并行方案的预留会互相占用同一库存池。确认前请核对：价格在规则区间内、规则版本未变、预留后仍留足缓冲。',
        ),
        h(
          'div',
          { class: 'form-inline', style: { alignItems: 'flex-end' } },
          h(
            'div',
            { class: 'form-row' },
            h('label', {}, `为 ${plan.id} 预留（件）`),
            locked ? h('div', { class: 'mono' }, fmtInt(plan.liveClaim?.units ?? plan.claimUnits ?? 0)) : input,
          ),
          h(
            'div',
            { class: 'form-row' },
            h('label', {}, '预留后剩余'),
            h(
              'div',
              { class: 'mono', style: { color: free - units < state.bufferUnits ? 'var(--amber)' : 'var(--text)' } },
              `${fmtInt(Math.max(0, free - units))} 件`,
            ),
          ),
        ),
        others.length
          ? h(
              'div',
              { class: 'small', style: { marginTop: '8px' } },
              h('span', { class: 'muted' }, '其他方案的预留：'),
              others.map((c) => h('span', { class: 'pill', style: { marginLeft: '4px' } }, `${c.planId} · ${c.units}`)),
            )
          : h('div', { class: 'tiny muted', style: { marginTop: '8px' } }, '当前没有其他方案的预留。'),
        h(
          'div',
          { class: 'form-inline', style: { marginTop: '12px' } },
          plan.status === 'draft'
            ? h(
                'button',
                {
                  class: 'btn primary small',
                  disabled: !validation?.ok && !validation?.findings?.some((f) => f.level === 'warning'),
                  onclick: () => confirmDialog(plan, state, units),
                },
                h('span', { html: icon('check', 14).outerHTML }),
                '核对并确认',
              )
            : null,
          plan.status === 'confirmed'
            ? h(
                'button',
                {
                  class: 'btn primary small',
                  disabled: plan.rulesStale,
                  onclick: async () => {
                    const result = await applyPlan(plan.id);
                    if (result.ok) navigate('console');
                  },
                },
                h('span', { html: icon('play', 13).outerHTML }),
                plan.rulesStale ? '规则已变，需重新确认' : '上线该方案',
              )
            : null,
          plan.status === 'active'
            ? h('span', { class: 'pill ok' }, '当前生效中')
            : null,
          plan.status === 'superseded'
            ? h('span', { class: 'pill bad' }, `已于 tick ${plan.supersededAtTick} 被 ${plan.supersededBy} 取代`)
            : null,
          plan.status === 'confirmed' && plan.rulesStale
            ? h(
                'button',
                {
                  class: 'btn small',
                  onclick: () => reconfirm(plan, state, units),
                },
                '按新规则重新确认',
              )
            : null,
        ),
      ),
    });
  }

  function validationPanel(state, plan, units) {
    const findings = validation?.findings || [];
    const blockers = findings.filter((f) => f.level === 'blocker');
    const warnings = findings.filter((f) => f.level === 'warning');
    return panel({
      title: '确认前核对',
      sub: validation ? `${findings.length} 条检查 · ${blockers.length} 个阻断` : '检查中…',
      body: h(
        'div',
        {},
        h(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' } },
          h('span', { class: `pill ${blockers.length ? 'bad' : 'ok'}` }, blockers.length ? `${blockers.length} 个阻断` : '无阻断'),
          h('span', { class: `pill ${warnings.length ? 'warn' : ''}`.trim() }, warnings.length ? `${warnings.length} 个警告` : '无警告'),
          h('span', { class: 'pill blue' }, `规则 ${state.rule.info.label}`),
        ),
        findings.length
          ? h('div', { class: 'findings' }, findings.map((f) => findingRow(f, (name, size) => icon(name, size).outerHTML)))
          : h(
              'div',
              { class: 'finding ok' },
              h('span', { class: 'fico', html: icon('check', 15).outerHTML }),
              h('span', {}, validation ? '价格、净贡献、库存预留与规则版本全部通过。' : '正在核对当前草稿……'),
            ),
        validation?.claimPreview
          ? h(
              'div',
              { class: 'tiny muted', style: { marginTop: '8px' } },
              `预留 ${fmtInt(validation.claimPreview.units)} 件 · 其他方案已占用 ${fmtInt(
                state.claimedUnits - (plan.liveClaim?.units ?? 0),
              )} 件 · 可承诺 ${fmtInt(validation.claimPreview.availableForClaim)} 件`,
            )
          : null,
      ),
    });
  }

  function simulationPanel(state, plan) {
    const sim = store.sim;
    return panel({
      title: '情景试算（沙盒）',
      sub: '不影响实时回放',
      actions: [
        seg({
          options: HORIZON_OPTIONS,
          value: horizon,
          onSelect: (v) => {
            horizon = v;
            draw();
          },
        }),
        h(
          'button',
          { class: 'btn small', disabled: store.simLoading, onclick: () => simulateFor(plan) },
          store.simLoading ? '试算中…' : '运行试算',
        ),
      ],
      body: h(
        'div',
        {},
        h(
          'div',
          { class: 'callout', style: { marginBottom: '10px' } },
          '试算在克隆的引擎上推演：同一套需求模型、同一共享库存池，因此它给出的是“若现在改价”的情景投影，不是实验结果。',
        ),
        sim
          ? simResult(sim, state)
          : emptyState('选一个时间窗口，然后运行试算，比较当前价格与该方案。'),
      ),
    });
  }

  function simResult(sim, state) {
    const d = sim.delta;
    const cells = [
      ['实付订单', `${fmtInt(sim.candidate.ordersPaid)}`, `${d.ordersPaid >= 0 ? '+' : ''}${fmtInt(d.ordersPaid)}`, d.ordersPaid >= 0 ? 'pos' : 'neg'],
      [
        '净贡献',
        fmtMoneyShort(sim.candidate.contributionCents),
        `${d.contributionCents >= 0 ? '+' : ''}${fmtMoneyShort(d.contributionCents)}`,
        d.contributionCents >= 0 ? 'pos' : 'neg',
      ],
      [
        '截断时段',
        fmtInt(sim.candidate.stockoutTicks),
        `${d.stockoutTicks >= 0 ? '+' : ''}${fmtInt(d.stockoutTicks)}`,
        d.stockoutTicks > 0 ? 'neg' : 'pos',
      ],
    ];
    return h(
      'div',
      {},
      h(
        'div',
        { class: 'tiny muted' },
        `窗口：tick ${sim.startTick} → ${sim.startTick + sim.horizonTicks}（${sim.horizonTicks} 个时段）· ${sim.planId}`,
      ),
      h(
        'div',
        { class: 'sim-result' },
        cells.map(([k, v, delta, tone]) =>
          h(
            'div',
            { class: 'sim-cell' },
            h('div', { class: 'k' }, k),
            h('div', { class: 'v' }, v),
            h('div', { class: `d ${tone}` }, `相对现状 ${delta}`),
          ),
        ),
      ),
      h(
        'div',
        { style: { marginTop: '10px' } },
        h(
          'table',
          { class: 'table mini-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', {}, '渠道'),
              h('th', { class: 'right' }, '候选价'),
              h('th', { class: 'right' }, '实付'),
              h('th', { class: 'right' }, '转化'),
              h('th', { class: 'right' }, '截断占比'),
            ),
          ),
          h(
            'tbody',
            {},
            state.channels.map((channel) => {
              // The simulator returns per-channel aggregates keyed by id; use the
              // catalogue entry for id/colour and read the two runs by key.
              const c = sim.candidate.byChannel[channel.id];
              const b = sim.baseline.byChannel[channel.id];
              if (!c || !b) return null;
              return h(
                'tr',
                {},
                h('td', {}, h('div', { class: 'name-cell' }, channelDot(channel.color), channel.short)),
                h('td', { class: 'num right' }, fmtPrice(sim.prices.candidate[channel.id])),
                h(
                  'td',
                  { class: 'num right' },
                  `${fmtInt(c.orders)} `,
                  h(
                    'span',
                    { class: c.orders >= b.orders ? 'pos tiny' : 'neg tiny' },
                    `${c.orders >= b.orders ? '+' : ''}${fmtInt(c.orders - b.orders)}`,
                  ),
                ),
                h('td', { class: 'num right' }, fmtPct(c.conversion)),
                h('td', { class: `num right ${c.censoredShare > 0.35 ? 'neg' : ''}`.trim() }, fmtPct(c.censoredShare, 0)),
              );
            }),
          ),
        ),
      ),
      sim.warnings.length
        ? h(
            'div',
            { class: 'findings', style: { marginTop: '10px' } },
            sim.warnings.map((w) =>
              h(
                'div',
                { class: `finding ${w.level === 'bad' ? 'blocker' : 'warning'}` },
                h('span', { class: 'fico', html: icon(w.level === 'bad' ? 'alert' : 'warn', 15).outerHTML }),
                h('span', {}, w.message),
              ),
            ),
          )
        : null,
      h(
        'div',
        { class: 'tiny muted', style: { marginTop: '8px' } },
        `该方案预留 ${fmtInt(sim.claims.units)} 件；其他方案占用 ${fmtInt(sim.claims.claimedByOthers)} 件；剩余可承诺 ${fmtInt(
          sim.claims.free,
        )} 件。`,
      ),
    );
  }

  /* -------------------------------------------------------------- compare */

  function compareDialog(state) {
    const selected = new Set(store.compareIds);
    if (!selected.size) {
      for (const plan of [...state.plans].sort((a, b) => b.createdAtTick - a.createdAtTick).slice(0, 3)) {
        selected.add(plan.id);
      }
    }
    const rows = state.plans.map((plan) =>
      h(
        'label',
        { class: 'split-row', style: { cursor: 'pointer' } },
        h(
          'span',
          { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('input', {
            type: 'checkbox',
            checked: selected.has(plan.id),
            onchange: (event) => {
              if (event.target.checked) {
                if (selected.size >= 4) {
                  event.target.checked = false;
                  toast('warn', '最多同时比较 4 个方案。');
                  return;
                }
                selected.add(plan.id);
              } else selected.delete(plan.id);
            },
          }),
          h('span', { class: 'small' }, plan.name),
          h('span', { class: 'pill' }, plan.statusLabel),
        ),
        h('span', { class: 'mono tiny' }, plan.id),
      ),
    );
    openModal({
      title: '并列试算',
      body: h(
        'div',
        {},
        h(
          'div',
          { class: 'callout warn', style: { marginBottom: '10px' } },
          '多个方案共享同一库存池：并列试算只是菜单式比较，不能同时上线，也不能把各自试算结果相加。',
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column' } }, rows),
      ),
      footer: [
        h('button', { class: 'btn ghost', onclick: closeModal }, '取消'),
        h(
          'button',
          {
            class: 'btn primary',
            onclick: async () => {
              store.compareIds = [...selected];
              closeModal();
              compareOpen = true;
              draw();
              await comparePlans(store.compareIds, horizon);
              draw();
            },
          },
          '运行对比',
        ),
      ],
    });
  }

  function comparePanel(state) {
    const result = store.compare;
    return panel({
      title: '并列试算结果',
      sub: store.compareIds.length ? store.compareIds.join(' · ') : '尚未选择方案',
      actions: [
        h(
          'button',
          {
            class: 'btn tiny',
            disabled: store.compareLoading || !store.compareIds.length,
            onclick: async () => {
              await comparePlans(store.compareIds, horizon);
              draw();
            },
          },
          store.compareLoading ? '计算中…' : '重新计算',
        ),
      ],
      body: result?.ok
        ? h(
            'div',
            {},
            h(
              'div',
              { class: `callout ${result.resource.overCommitted ? 'bad' : 'warn'}`, style: { marginBottom: '10px' } },
              h('b', {}, result.resource.overCommitted ? '预留已超占。' : '资源干扰提示。'),
              ` ${result.resource.note}`,
            ),
            h(
              'table',
              { class: 'table mini-table' },
              h(
                'thead',
                {},
                h(
                  'tr',
                  {},
                  h('th', {}, '方案'),
                  h('th', { class: 'right' }, '实付'),
                  h('th', { class: 'right' }, '净贡献'),
                  h('th', { class: 'right' }, '截断'),
                  h('th', { class: 'right' }, '预留'),
                ),
              ),
              h(
                'tbody',
                {},
                result.runs.map((run) =>
                  h(
                    'tr',
                    {},
                    h(
                      'td',
                      {},
                      h('div', { class: 'small' }, run.planName),
                      h('div', { class: 'tiny muted mono' }, run.planId),
                    ),
                    h('td', { class: 'num right' }, fmtInt(run.candidate.ordersPaid)),
                    h('td', { class: 'num right' }, fmtMoneyShort(run.candidate.contributionCents)),
                    h('td', { class: 'num right' }, fmtInt(run.candidate.stockoutTicks)),
                    h('td', { class: 'num right' }, fmtInt(run.claims.units)),
                  ),
                ),
              ),
            ),
            result.duplicates.length
              ? h(
                  'div',
                  { class: 'finding warning', style: { marginTop: '10px' } },
                  h('span', { class: 'fico', html: icon('warn', 15).outerHTML }),
                  h('span', {}, `价格完全相同的方案：${result.duplicates.map((d) => d.join(' = ')).join('；')}，它们的试算会重复。`),
                )
              : null,
            h(
              'div',
              { class: 'tiny muted', style: { marginTop: '8px' } },
              `窗口 ${result.horizonTicks} 个时段 · ${result.note}`,
            ),
          )
        : emptyState('勾选 2–4 个方案后运行对比。'),
    });
  }

  /* -------------------------------------------------------------- actions */

  function simulateFor(plan) {
    simulatePlan(plan.id, horizon).then(draw);
  }

  function createDraftDialog(state) {
    const name = h('input', { type: 'text', value: `价格实验 ${state.plans.length + 1}`, maxlength: '40' });
    const prices = {};
    const inputs = state.channels.map((channel) => {
      const input = h('input', {
        class: 'price-input',
        type: 'number',
        step: '1',
        value: (channel.priceAnchorCents / 100).toFixed(0),
        min: '1',
      });
      prices[channel.id] = input;
      return h(
        'div',
        { class: 'split-row' },
        h('span', { style: { display: 'flex', gap: '7px', alignItems: 'center' } }, channelDot(channel.color), channel.name),
        h(
          'span',
          { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          h('span', { class: 'tiny muted' }, '¥'),
          input,
        ),
      );
    });
    openModal({
      title: '新建价格方案',
      width: 'min(520px, 94vw)',
      body: h(
        'div',
        {},
        h('div', { class: 'form-row' }, h('label', {}, '方案名称'), name),
        h('div', { class: 'small muted', style: { margin: '10px 0 4px' } }, '初始价格：默认等于各渠道参考价，创建后可拖动调整。'),
        h('div', {}, inputs),
      ),
      footer: [
        h('button', { class: 'btn ghost', onclick: closeModal }, '取消'),
        h(
          'button',
          {
            class: 'btn primary',
            onclick: async () => {
              const plan = await createPlan({
                name: name.value || `方案 ${state.plans.length + 1}`,
                prices: Object.fromEntries(
                  state.channels.map((c) => [c.id, Math.round((Number(prices[c.id].value) || c.priceAnchorCents / 100) * 100)]),
                ),
              });
              closeModal();
              draw();
              if (plan) toast('ok', `${plan.id} 已创建，可在编辑器中调价。`);
            },
          },
          '创建草稿',
        ),
      ],
    });
  }

  async function confirmDialog(plan, state, units) {
    const check = await validatePlan(plan.id, units);
    validation = check;
    validationKey = `${plan.id}|${plan.revision}|${state.claimedUnits}|${units}|${state.rule.epoch}`;
    const warnings = check.findings.filter((f) => f.level === 'warning');
    let acknowledge = false;
    const footer = [
      h('button', { class: 'btn ghost', onclick: closeModal }, '取消'),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: async () => {
            const result = await confirmPlan(plan.id, { claimUnits: units, acknowledge: acknowledge || warnings.length === 0 });
            if (result.ok) {
              closeModal();
              draw();
            } else if (result.needsAcknowledgement) {
              toast('warn', '请先勾选确认警告。');
            } else {
              toast('bad', result.error);
            }
          },
        },
        '确认并锁定',
      ),
    ];
    const body = h(
      'div',
      {},
      h(
        'div',
        { class: 'kv' },
        h('dt', {}, '方案'),
        h('dd', {}, `${plan.id} · ${plan.name} · v${plan.revision}`),
        h('dt', {}, '规则批次'),
        h('dd', {}, `${state.rule.info.label}（epoch ${state.rule.epoch}）`),
        h('dt', {}, '库存预留'),
        h('dd', {}, `${fmtInt(units)} 件（其他方案已占 ${fmtInt(state.claimedUnits - (plan.liveClaim?.units ?? 0))} 件）`),
      ),
      h(
        'div',
        { style: { marginTop: '10px' } },
        priceTable(plan, state, units),
      ),
      h(
        'div',
        { class: 'findings', style: { marginTop: '12px' } },
        check.findings.length
          ? check.findings.map((f) => findingRow(f, (name, size) => icon(name, size).outerHTML))
          : h(
              'div',
              { class: 'finding ok' },
              h('span', { class: 'fico', html: icon('check', 15).outerHTML }),
              h('span', {}, '所有检查通过。'),
            ),
      ),
      warnings.length
        ? h(
            'label',
            { class: 'finding warning', style: { marginTop: '10px', cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              onchange: (event) => {
                acknowledge = event.target.checked;
              },
            }),
            h('span', {}, `我已阅读并接受以上 ${warnings.length} 条警告（试算只是情景投影，不是实验结果）。`),
          )
        : null,
    );
    openModal({ title: '确认方案', body, footer, width: 'min(620px, 94vw)' });
  }

  async function reconfirm(plan, state, units) {
    const result = await confirmPlan(plan.id, {
      claimUnits: Math.min(units, state.claimableUnits),
      acknowledge: true,
      expectedPrices: plan.prices,
      expectedRevision: plan.revision,
    });
    if (result.ok) draw();
    else toast('bad', result.error || '重新确认失败');
  }

  draw();
  return {
    update: draw,
    unmount: () => {
      validationToken += 1;
    },
  };
}
