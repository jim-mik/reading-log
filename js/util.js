// Small shared helpers: ids, dates, DOM building.

export function uid(prefix) {
  const raw = globalThis.crypto?.randomUUID?.() ??
    Date.now().toString(36) + Math.random().toString(36).slice(2);
  return `${prefix}_${raw.replace(/-/g, '').slice(0, 16)}`;
}

export const nowIso = () => new Date().toISOString();

// ---- dates (all reading dates are local 'YYYY-MM-DD' strings) ----

const pad = (n) => String(n).padStart(2, '0');

export function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const todayStr = () => ymd(new Date());

// Date math runs in UTC so DST/timezone never shifts a day.
function utc(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
const iso = (t) => t.toISOString().slice(0, 10);

export function addDays(s, n) {
  const t = utc(s);
  t.setUTCDate(t.getUTCDate() + n);
  return iso(t);
}

// Weeks start on Monday.
export function weekStart(s) {
  const t = utc(s);
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return iso(t);
}

export function periodKey(s, unit) {
  if (unit === 'day') return s;
  if (unit === 'week') return weekStart(s);
  if (unit === 'month') return s.slice(0, 7);
  return s.slice(0, 4);
}

// The `count` period keys ending at the period that contains `endDay`.
export function periodRange(endDay, unit, count) {
  const keys = [];
  let key = periodKey(endDay, unit);
  for (let i = 0; i < count; i++) {
    keys.unshift(key);
    if (unit === 'day') key = addDays(key, -1);
    else if (unit === 'week') key = addDays(key, -7);
    else if (unit === 'month') {
      let [y, m] = key.split('-').map(Number);
      m -= 1;
      if (m === 0) { m = 12; y -= 1; }
      key = `${y}-${pad(m)}`;
    } else key = String(Number(key) - 1);
  }
  return keys;
}

export function periodLabel(key, unit) {
  if (unit === 'day') {
    // Short enough for 14 bars: the month only on the 1st.
    const [, m, d] = key.split('-').map(Number);
    return d === 1 ? `${m}/1` : String(d);
  }
  if (unit === 'week') {
    const [, m, d] = key.split('-').map(Number);
    return `${m}/${d}`;
  }
  if (unit === 'month') {
    const [y, m] = key.split('-').map(Number);
    return m === 1 ? `${String(y).slice(2)}년 1월` : `${m}월`;
  }
  return `${key}년`;
}

export function prettyDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  const dow = '일월화수목금토'[utc(s).getUTCDay()];
  const thisYear = new Date().getFullYear();
  return y === thisYear ? `${m}월 ${d}일 (${dow})` : `${y}년 ${m}월 ${d}일`;
}

export function daysBetween(a, b) {
  return Math.round((utc(b) - utc(a)) / 86400000);
}

// ---- numbers & text ----

export function fmtNum(n) {
  return Math.round(n).toLocaleString('ko-KR');
}

export function compactNum(n) {
  if (n >= 100000000) return `${(n / 100000000).toFixed(1).replace(/\.0$/, '')}억`;
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}만`;
  return fmtNum(n);
}

// Lowercase, no spaces/punctuation: used to match titles.
export function normTitle(s) {
  return (s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---- DOM ----

const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'open']);

function apply(el, props) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
}

function append(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

// h('div', {class: 'x', onClick: fn}, 'text', child) - text is always inserted as text, never HTML.
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  apply(el, props);
  append(el, kids);
  return el;
}

export function svg(tag, props, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  apply(el, props);
  append(el, kids);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}
