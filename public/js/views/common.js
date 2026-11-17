/**
 * Shared view building blocks.
 *
 * These wrap the atoms defined in styles.css so every page keeps the same
 * rhythm: a page head, panels with a title/subtitle, stat tiles.
 */

import { h } from '../util.js';

export function pageHead({ title, subtitle, actions = [], badge = null }) {
  return h(
    'div',
    { class: 'page-head' },
    h(
      'div',
      { class: 'page-title' },
      h('h1', {}, title, badge ? h('span', { class: 'pill blue', style: { marginLeft: '10px', verticalAlign: 'middle' } }, badge) : null),
      subtitle ? h('p', {}, subtitle) : null,
    ),
    actions.length ? h('div', { class: 'filters' }, actions) : null,
  );
}

export function panel({ title, sub = null, actions = [], body, flush = false, class: className = '' }) {
  return h(
    'section',
    { class: `panel ${className}`.trim() },
    h(
      'div',
      { class: 'panel-head' },
      h('h2', {}, title, sub ? h('span', { class: 'sub' }, sub) : null),
      actions.length ? h('div', { class: 'filters' }, actions) : null,
    ),
    h('div', { class: `panel-body ${flush ? 'flush' : ''}`.trim() }, body),
  );
}

export function stat({ label, value, foot = null, tone = '' }) {
  return h(
    'div',
    { class: `stat ${tone}`.trim() },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value),
    foot ? h('div', { class: 'foot' }, foot) : null,
  );
}

export function channelDot(color) {
  return h('i', { class: 'ch-dot', style: { background: color } });
}

export function channelNameCell(channel, extra = null) {
  return h(
    'div',
    { class: 'name-cell' },
    channelDot(channel.color),
    h('div', { class: 'ch-name' }, h('b', {}, channel.name), extra ? h('span', {}, extra) : null),
  );
}

export function emptyState(text) {
  return h('div', { class: 'empty' }, text);
}

export function findingRow(finding, iconHtml) {
  const iconName = finding.level === 'blocker' ? 'alert' : finding.level === 'warning' ? 'warn' : 'check';
  return h(
    'div',
    { class: `finding ${finding.level}` },
    iconHtml ? h('span', { class: 'fico', html: iconHtml(iconName, 15) }) : null,
    h('span', {}, finding.message),
  );
}

export function seg({ options, value, onSelect }) {
  return h(
    'div',
    { class: 'seg' },
    options.map((opt) =>
      h(
        'button',
        {
          class: opt.value === value ? 'active' : '',
          onclick: () => onSelect(opt.value),
          title: opt.title || '',
        },
        opt.label,
      ),
    ),
  );
}

export function kv(rows) {
  return h(
    'dl',
    { class: 'kv' },
    rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]).flat(),
  );
}

export function splitRow(left, right) {
  return h('div', { class: 'split-row' }, h('span', { class: 'small' }, left), right);
}
