// Shared UI pieces: overlays, toast, chips, icons, covers, colors, file saving.

import { h, svg, clear } from './util.js';
import { LANGS, LEVELS } from './catalog.js';
import { subjectLabel, subjects } from './store.js';

// ---- overlays: full-screen pages above the tabs. Each one adds a history entry,
// so the phone's back button closes the top overlay instead of leaving the app.

const stack = [];
const waiting = [];

export function openOverlay(el, { onClose } = {}) {
  el.classList.add('overlay');
  document.body.append(el);
  stack.push({ el, onClose });
  history.pushState({ overlay: stack.length }, '');
  document.documentElement.classList.add('locked');
  return el;
}

export function closeOverlay() {
  return new Promise((resolve) => {
    if (!stack.length) return resolve();
    waiting.push(resolve);
    history.back();
  });
}

window.addEventListener('popstate', () => {
  const top = stack.pop();
  if (top) {
    top.el.remove();
    top.onClose?.();
  }
  if (!stack.length) document.documentElement.classList.remove('locked');
  waiting.shift()?.();
});

// ---- toast ----

let toastTimer;
export function toast(message, ms = 2800) {
  let el = document.getElementById('toast');
  if (!el) el = document.body.appendChild(h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }));
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ---- chips: single choice (tap again to clear) or multiple choice ----

export function chipGroup(options, { value = null, multi = false, required = false, onChange, cls = '' } = {}) {
  let sel = multi ? new Set(value || []) : value;
  const wrap = h('div', { class: `chips ${cls}`, role: 'group' });
  const paint = () => {
    for (const b of wrap.children) {
      b.setAttribute('aria-pressed', String(multi ? sel.has(b.dataset.key) : sel === b.dataset.key));
    }
  };
  for (const o of options) {
    wrap.append(h('button', {
      type: 'button',
      class: 'chip',
      dataset: { key: o.key },
      onClick: () => {
        if (multi) sel.has(o.key) ? sel.delete(o.key) : sel.add(o.key);
        else sel = sel === o.key && !required ? null : o.key;
        paint();
        onChange?.(multi ? [...sel] : sel);
      },
    }, o.color && h('span', { class: 'dot', style: `background:${o.color}` }), o.label));
  }
  wrap.set = (v) => {
    sel = multi ? new Set(v || []) : v;
    paint();
  };
  paint();
  return wrap;
}

export function select(options, value, onChange, label) {
  return h('select', { class: 'select', 'aria-label': label, onChange: (e) => onChange(e.target.value) },
    options.map((o) => h('option', { value: o.key, selected: o.key === value }, o.label)));
}

// ---- icons (24px line icons) ----

const ICONS = {
  back: 'M15 18l-6-6 6-6',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  barcode: 'M4 6v12M7.5 6v12M10 6v12M13.5 6v12M16 6v12M20 6v12',
  camera: 'M4 8h3.5l2-3h5l2 3H20v11H4zM12 9.8a3.3 3.3 0 1 0 0 6.6a3.3 3.3 0 1 0 0-6.6z',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2.5-2.5L20 17M15.5 8.2a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6z',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  home: 'M3 11l9-7 9 7M5.5 9.5V20h13V9.5',
  books: 'M4 4h4.5v16H4zM10 4h4.5v16H10zM16 6.2l3.3-.9 3.2 14-3.3.9z',
  chart: 'M5 20v-8M12 20V5M19 20v-5M3 20h18',
  settings: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6zM9 10.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6zM17 16.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6z',
  sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
  trash: 'M4 7h16M9.5 7V4h5v3M6 7l1 13h10l1-13',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13zM15.5 15.5L20 20',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  read: 'M4 6.5C6.5 5 9.5 5 12 6.5v12C9.5 17 6.5 17 4 18.5zM20 6.5C17.5 5 14.5 5 12 6.5v12c2.5-1.5 5.5-1.5 8 0z',
  bulb: 'M9.5 18h5M10.5 21h3M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.1v.6h5v-.6c0-.8.4-1.6 1.1-2.1A6 6 0 0 0 12 3z',
};

export function icon(name, size = 22) {
  return svg('svg', { class: 'icon', width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
    svg('path', { d: ICONS[name] }));
}

// ---- colors (CSS variables; see app.css). Color follows the entity, never its rank. ----

const SLOTS = 8;
export const slotColor = (i) => `var(--c${(i % SLOTS) + 1})`;
export const OTHER_COLOR = 'var(--c-other)';
export const readerColor = (reader) => slotColor(reader?.slot ?? 0);
export const levelColor = (n) => (n ? `var(--l${n})` : OTHER_COLOR);

export function subjectColor(key) {
  const i = subjects().findIndex((s) => s.key === key);
  return i >= 0 && i < SLOTS && key !== 'etc' ? slotColor(i) : OTHER_COLOR;
}

// ---- book bits ----

export function cover(book, size = 'm') {
  const ph = () => h('div', { class: `cover ${size} ph`, 'aria-hidden': 'true' }, (book.title || '?').trim().slice(0, 1));
  if (!book.cover) return ph();
  const img = h('img', { class: `cover ${size}`, src: book.cover, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(ph()), { once: true });
  return img;
}

export const langLabel = (key) => LANGS.find((l) => l.key === key)?.label ?? '기타';
export const levelLabel = (n) => (n ? `${n}단계 ${LEVELS[n - 1].name}` : '');

export function bookBadges(book) {
  return h('div', { class: 'badges' },
    book.lang && h('span', { class: 'badge' }, langLabel(book.lang)),
    book.subject && h('span', { class: 'badge' }, subjectLabel(book.subject)),
    book.level && h('span', { class: 'badge' }, `${book.level}단계`));
}

export function whoChip(reader, extra) {
  return h('span', { class: 'who' }, h('span', { class: 'dot', style: `background:${readerColor(reader)}` }), reader?.name ?? '?', extra);
}

export function emptyState(text, action) {
  return h('div', { class: 'empty' }, h('p', null, text), action);
}

// ---- files: share sheet when the phone supports it for this type, else download ----

export async function saveFile(name, text, type) {
  const blob = new Blob([text], { type });
  const file = new File([blob], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
    }
  }
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return true;
}

export { clear };
