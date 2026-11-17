/**
 * Formatting, DOM and transport helpers.
 *
 * The UI is deliberately dependency-free: a tiny `h()` builder, a handful of
 * formatters and a JSON fetch wrapper. Everything renders from the session
 * state returned by the API, so refreshing the page never loses the replay.
 */

export const fmtMoney = (cents, { sign = false } = {}) => {
  if (cents == null || Number.isNaN(cents)) return '—';
  const value = cents / 100;
  const text = `¥${Math.abs(value).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
  if (!sign) return value < 0 ? `-${text}` : text;
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}${text}`;
};

export const fmtMoneyShort = (cents) => {
  if (cents == null || Number.isNaN(cents)) return '—';
  const yuan = cents / 100;
  if (Math.abs(yuan) >= 10000) return `¥${(yuan / 10000).toFixed(1)}万`;
  return `¥${yuan.toFixed(0)}`;
};

export const fmtInt = (n) => (n == null || Number.isNaN(n) ? '—' : Math.round(n).toLocaleString('zh-CN'));

export const fmtPct = (value, digits = 1) => {
  if (value == null || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
};

export const fmtSignedPct = (value, digits = 1) => {
  if (value == null || Number.isNaN(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
};

export const fmtElast = (value) => {
  if (value == null || Number.isNaN(value)) return '—';
  return value.toFixed(2);
};

export const fmtPrice = (cents) => (cents == null ? '—' : `¥${(cents / 100).toFixed(0)}`);

export const fmtHour = (hour) => `${String(hour).padStart(2, '0')}:00`;

export const fmtTick = (tick) => {
  const day = Math.floor(tick / 6) + 1;
  const hourIdx = tick % 6;
  const hours = [9, 11, 13, 15, 17, 19];
  return `D${day} ${fmtHour(hours[hourIdx] ?? 9)}`;
};

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/* ------------------------------------------------------------------- icons */
const ICONS = {
  pulse: '<path d="M3 12h3l2.5-6 3.5 12 3-8 2 2h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  sliders:
    '<path d="M4 7h9M17 7h3M4 17h3M11 17h9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="15" cy="7" r="2" stroke="currentColor" stroke-width="1.7"/><circle cx="9" cy="17" r="2" stroke="currentColor" stroke-width="1.7"/>',
  chart:
    '<path d="M4 19V5M4 19h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M7 15l3.5-4 3 2.6L18 8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/>',
  book: '<path d="M5 5.5A1.5 1.5 0 016.5 4H19v14.5H6.5A1.5 1.5 0 005 20V5.5z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 20a1.5 1.5 0 011.5-1.5H19V20" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  play: '<path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor"/>',
  step: '<path d="M7 5l7 7-7 7M17 5v14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  clock: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  undo: '<path d="M9 7L4 12l5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 12h9a6 6 0 010 12h-1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  flag: '<path d="M6 21V4h11l-2 4 2 4H6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  refresh:
    '<path d="M20 11a8 8 0 10-2.6 6.2M20 5v6h-6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  alert:
    '<path d="M12 8v5M12 16.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 3.5L21 19.5H3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  close: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  box: '<path d="M4 8.5L12 4l8 4.5v7L12 20l-8-4.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M4 8.5L12 13l8-4.5M12 13v7" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  warn: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 7.5v5.5M12 16v.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
};

export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

export function iconHtml(name, size = 16) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}">${ICONS[name] || ''}</svg>`;
}

/* --------------------------------------------------------------------- DOM */

/**
 * Terse element builder. Attribute keys starting with `on` become listeners,
 * `class` / `className` both work, and children may be nodes, strings, arrays,
 * or null (skipped).
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'class' || key === 'className') el.className = value;
      else if (key === 'html') el.innerHTML = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') {
        el[key] = value;
      } else el.setAttribute(key, value);
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function el(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function qs(sel, root = document) {
  return root.querySelector(sel);
}

export function qsa(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

/* --------------------------------------------------------------------- api */
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function api(path, { method = 'GET', body = null } = {}) {
  const options = {
    method,
    headers: { accept: 'application/json' },
  };
  if (body != null) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new ApiError(payload?.error || `请求失败 (${response.status})`, response.status, payload);
  }
  return payload;
}

export const apiGet = (path) => api(path);
export const apiPost = (path, body) => api(path, { method: 'POST', body: body ?? {} });
export const apiPatch = (path, body) => api(path, { method: 'PATCH', body: body ?? {} });

/* ------------------------------------------------------------------- misc */

export function debounce(fn, ms = 180) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  wrapped.flush = (...args) => {
    if (timer) clearTimeout(timer);
    timer = null;
    fn(...args);
  };
  return wrapped;
}

export const CHANNEL_COLORS = {
  'CH-MKT': '#6ea8e8',
  'CH-WEB': '#5fc8b4',
  'CH-APP': '#b09ce6',
  'CH-OUT': '#e59a5f',
};

export const EVENT_LABELS = {
  exposure: '曝光',
  stockout: '缺货截断',
  order_placed: '下单',
  order_paid: '支付',
  order_cancelled: '取消',
  order_expired: '预留过期',
  order_returned: '退货',
  price_changed: '调价',
  plan_confirmed: '方案上线',
  plan_superseded: '方案被取代',
  tick: '时钟',
  day_closed: '日结',
  inventory_hold: '预留',
  inventory_commit: '占用',
  inventory_release: '释放',
  inventory_return: '退回',
  inventory_restock: '补货',
};

export function eventDetail(event, channels = []) {
  const ch = channels.find((c) => c.id === event.channelId);
  const chName = ch?.short || event.channelId || '';
  switch (event.type) {
    case 'exposure':
      return `${chName} ${fmtPrice(event.priceCents)} · 曝光 ${event.impressions} · 下单 ${event.orders}${
        event.stockout ? ' · 触顶' : ''
      }`;
    case 'stockout':
      return `${chName} 库存耗尽${event.atStart ? '（时段开始即无货）' : '（本时段被截断）'}`;
    case 'order_placed':
      return `${chName} ${event.orderId} · ${fmtPrice(event.priceCents)}`;
    case 'order_paid':
      return `${chName} ${event.orderId} 支付 ${fmtPrice(event.priceCents)}`;
    case 'order_cancelled':
      return `${chName} ${event.orderId} 取消（${event.reason === 'hold_expired' ? '超时未付' : '买家取消'}）`;
    case 'order_expired':
      return `${chName} ${event.orderId} 预留过期`;
    case 'order_returned':
      return `${chName} ${event.orderId} 退货 ${fmtPrice(event.priceCents)}`;
    case 'inventory_hold':
      return `${chName} 预留 1 件 · ${event.note}`;
    case 'inventory_commit':
      return `${chName} 预留转为占用 · ${event.note}`;
    case 'inventory_release':
      return `${chName} 释放 1 件（${event.reason === 'hold_expired' ? '过期' : event.reason === 'buyer_cancelled' ? '取消' : event.reason}）`;
    case 'inventory_return':
      return `${chName} 退回 1 件到可售`;
    case 'inventory_restock':
      return `补货 ${event.qty} 件`;
    case 'price_changed':
      return `${event.planId} 价格更新`;
    case 'plan_confirmed':
      return `${event.planId} ${event.name || ''}`;
    case 'plan_superseded':
      return `${event.planId} 被 ${event.byPlanId || ''} 取代`;
    case 'tick':
      return `${event.label}`;
    case 'day_closed':
      return `日结：库存 ${event.inventory?.available ?? '—'}`;
    default:
      return '';
  }
}

export function orderStateLabel(state) {
  return (
    {
      pending: '待支付',
      paid: '已支付',
      cancelled: '已取消',
      returned: '已退货',
      expired: '预留过期',
    }[state] || state
  );
}

export function orderStateTone(state) {
  return (
    {
      pending: 'warn',
      paid: 'ok',
      cancelled: 'bad',
      returned: 'blue',
      expired: 'bad',
    }[state] || ''
  );
}

export function statusTone(status) {
  return (
    {
      draft: 'blue',
      confirmed: 'warn',
      active: 'ok',
      superseded: '',
    }[status] || ''
  );
}
