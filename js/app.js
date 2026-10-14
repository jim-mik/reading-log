// Entry point: load data, draw the bottom tabs, render the current tab.

import { h, clear } from './util.js';
import * as store from './store.js';
import { icon } from './ui.js';
import { registerServiceWorker } from './pwa.js';
import * as sync from './sync.js';
import { renderHome } from './views/home.js';
import { renderShelf } from './views/shelf.js';
import { renderNotes } from './views/notes.js';
import { renderStats } from './views/report.js';
import { renderSettings } from './views/setup.js';

const TABS = [
  { key: 'home', label: '홈', icon: 'home', render: renderHome },
  { key: 'shelf', label: '책장', icon: 'books', render: renderShelf },
  { key: 'notes', label: '노트', icon: 'bulb', render: renderNotes },
  { key: 'stats', label: '통계', icon: 'chart', render: renderStats },
  { key: 'settings', label: '설정', icon: 'settings', render: renderSettings },
];

const main = document.getElementById('main');
const nav = document.getElementById('tabs');
let current = sessionStorage.getItem('tab') || 'home';

function render() {
  const tab = TABS.find((t) => t.key === current) || TABS[0];
  const y = window.scrollY;
  clear(main);
  tab.render(main, { goTo, rerender: render });
  window.scrollTo(0, y);
  for (const b of nav.children) b.setAttribute('aria-current', b.dataset.key === tab.key ? 'page' : 'false');
}

function goTo(key) {
  current = key;
  try {
    sessionStorage.setItem('tab', key);
  } catch {
    // ignore
  }
  window.scrollTo(0, 0);
  render();
}

// Re-render once per frame at most, after any data change.
let queued = false;
store.onChange(() => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    render();
  });
});

async function boot() {
  nav.append(...TABS.map((t) => h('button', { class: 'tab', dataset: { key: t.key }, onClick: () => goTo(t.key) },
    icon(t.icon, 24), h('span', null, t.label))));
  try {
    await store.load();
  } catch (e) {
    main.append(h('div', { class: 'empty' }, h('p', null, `저장소를 열 수 없어요: ${e.message}`),
      h('p', null, '시크릿 모드에서는 기록을 저장할 수 없어요.')));
    return;
  }
  history.replaceState(null, '');
  render();
  registerServiceWorker();
  sync.start();
}

boot();
