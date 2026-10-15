// 홈: quick add buttons, this week/month/year per person, recent records.

import { h, todayStr, prettyDate, daysBetween } from '../util.js';
import * as store from '../store.js';
import { settings } from '../settings.js';
import * as sync from '../sync.js';
import { headline } from '../stats.js';
import { icon, cover, whoChip, emptyState } from '../ui.js';
import { openEditor } from './editor.js';
import { openBook } from './book.js';

export function renderHome(root, { goTo }) {
  const rows = store.reads().map((r) => ({ ...r, book: store.getBook(r.bookId) }));
  const today = todayStr();

  const add = h('section', { class: 'quick-add' },
    h('button', { class: 'big-btn accent', onClick: () => openEditor({ start: 'scan' }) }, icon('barcode', 30), '바코드 스캔'),
    h('button', { class: 'big-btn', onClick: () => openEditor({ start: 'photo' }) }, icon('camera', 30), '사진으로'),
    h('button', { class: 'big-btn', onClick: () => openEditor() }, icon('pencil', 30), '직접 입력'));

  // Backup reminder when data lives only on this phone; with family sync, a warning when it keeps failing.
  const last = settings().lastBackupAt;
  const age = last ? daysBetween(last.slice(0, 10), today) : null;
  const backup = sync.linked()
    ? sync.problem() && h('button', { class: 'banner', onClick: () => goTo('settings') }, `가족 동기화가 하루 넘게 안 되고 있어요. ${sync.problem()} ›`)
    : rows.length >= 5 && (age === null || age >= 30) && h('button', { class: 'banner', onClick: () => goTo('settings') },
      age === null ? '아직 백업한 적이 없어요. 휴대폰을 바꾸면 기록이 사라질 수 있어요. 백업하기 ›' : `마지막 백업이 ${age}일 전이에요. 백업하기 ›`);

  const readers = store.readers();
  const summary = readers.length && h('section', { class: 'card' },
    h('h3', null, '읽은 책'),
    h('table', { class: 'mini' },
      h('thead', null, h('tr', null, h('th', null, ''), h('th', null, '오늘'), h('th', null, '이번 주'), h('th', null, '이번 달'), h('th', null, '올해'))),
      h('tbody', null, readers.map((r) => {
        const t = headline(rows.filter((x) => x.readerId === r.id), 'books', today);
        return h('tr', null, h('th', null, whoChip(r)), h('td', null, `${t.today}권`), h('td', null, `${t.week}권`), h('td', null, `${t.month}권`), h('td', null, `${t.year}권`));
      }))));

  // Recent: one line per book per day, newest first.
  const groups = new Map();
  for (const r of [...rows].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))) {
    const k = `${r.date}|${r.bookId}`;
    if (!groups.has(k)) groups.set(k, { date: r.date, book: r.book, reads: [] });
    groups.get(k).reads.push(r);
    if (groups.size > 30) break;
  }
  const byDate = new Map();
  for (const g of [...groups.values()].slice(0, 30)) {
    if (!byDate.has(g.date)) byDate.set(g.date, []);
    byDate.get(g.date).push(g);
  }
  const recent = h('section', null,
    h('h2', { class: 'section-title' }, '최근 기록'),
    byDate.size
      ? [...byDate].map(([date, items]) => h('div', { class: 'day' },
        h('h4', null, date === today ? `오늘 · ${prettyDate(date)}` : prettyDate(date)),
        items.map((g) => h('button', { class: 'row', onClick: () => openBook(g.book.id) },
          cover(g.book, 's'),
          h('span', { class: 'row-main' },
            h('span', { class: 'row-title' }, g.book.title),
            h('span', { class: 'row-sub' },
              g.reads.map((r) => whoChip(store.getReader(r.readerId))),
              g.reads.some((r) => r.aloud) && h('span', { class: 'badge' }, '읽어 줌')))))))
      : emptyState('아직 기록이 없어요. 위 버튼으로 첫 책을 기록해 보세요.'));

  root.append(...[
    h('header', { class: 'page-head' },
      h('h1', null, '우리집 독서기록'),
      h('p', { class: 'muted' }, prettyDate(today))),
    add, backup, summary, recent].filter(Boolean));
}
