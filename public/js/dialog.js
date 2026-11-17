/**
 * Modal and toast helpers.
 *
 * Kept separate from app.js so view modules can raise dialogs without importing
 * the shell (which imports them). Both write into the static shells declared in
 * index.html.
 */

import { h, clear, qs, icon } from './util.js';

export function toast(tone, text) {
  const stack = qs('#toast-stack');
  if (!stack) return;
  const node = h(
    'div',
    { class: `toast ${tone || ''}` },
    h('span', { html: icon(tone === 'bad' ? 'alert' : tone === 'warn' ? 'warn' : 'check', 15).outerHTML }),
    h('span', {}, text),
  );
  stack.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity 200ms ease';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, 4200);
}

export function openModal({ title, body, footer = null, width = null }) {
  const modal = qs('#modal');
  const backdrop = qs('#modal-backdrop');
  if (!modal || !backdrop) return;
  clear(modal);
  modal.style.width = width || '';
  modal.append(
    h(
      'div',
      { class: 'modal-head' },
      h('h3', {}, title),
      h(
        'button',
        { class: 'icon-btn', onclick: closeModal, 'aria-label': '关闭' },
        h('span', { html: icon('close', 15).outerHTML }),
      ),
    ),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null,
  );
  modal.hidden = false;
  backdrop.hidden = false;
}

export function closeModal() {
  const modal = qs('#modal');
  const backdrop = qs('#modal-backdrop');
  if (!modal || !backdrop) return;
  modal.hidden = true;
  backdrop.hidden = true;
  clear(modal);
}

export function modalBody(content) {
  const body = qs('#modal .modal-body');
  if (!body) return null;
  clear(body);
  body.append(content);
  return body;
}

export function initDialog() {
  qs('#modal-backdrop')?.addEventListener('click', closeModal);
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!qs('#modal')?.hidden) closeModal();
  });
}
