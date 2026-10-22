// 통계: totals, a stacked column chart by day/week/month/year, most-read books, shelf progress.

import { h, periodLabel, todayStr, fmtNum, compactNum } from '../util.js';
import { LANGS, LEVELS } from '../catalog.js';
import * as store from '../store.js';
import { METRICS, timeSeries, headline, distinctBooks, yearCount, topBooks, missingSize } from '../stats.js';
import { stackedBars } from '../chart.js';
import { chipGroup, select, cover, readerColor, slotColor, subjectColor, levelColor, OTHER_COLOR, whoChip, emptyState } from '../ui.js';
import { openBook } from './book.js';

const f = { unit: 'month', reader: 'all', by: 'reader', metric: 'books' };

const UNITS = [{ key: 'day', label: '일별' }, { key: 'week', label: '주별' }, { key: 'month', label: '월별' }, { key: 'year', label: '연도별' }];
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
const GROUPS = [
  { key: 'reader', label: '사람별' },
  { key: 'lang', label: '언어별' },
  { key: 'subject', label: '과목별' },
  { key: 'level', label: '난이도별' },
  { key: 'aloud', label: '읽은 방법별' },
];

function longLabel(key, unit) {
  const [y, m, d] = key.split('-').map(Number);
  if (unit === 'day') return `${y}년 ${m}월 ${d}일 (${DAY_NAMES[new Date(y, m - 1, d).getDay()]})`;
  if (unit === 'week') return `${y}년 ${m}월 ${d}일 주`;
  if (unit === 'month') return `${y}년 ${m}월`;
  return `${y}년`;
}

// Series for the chosen grouping. Colors are fixed per entity, so filters never repaint.
function seriesFor(by) {
  if (by === 'reader') return store.readers().map((r) => ({ key: r.id, label: r.name, color: readerColor(r) }));
  if (by === 'lang') return LANGS.map((l, i) => ({ key: l.key, label: l.label, color: slotColor(i) }));
  if (by === 'level') {
    return [...LEVELS.map((l) => ({ key: String(l.n), label: `${l.n}단계`, color: levelColor(l.n) })),
      { key: '0', label: '미정', color: OTHER_COLOR }];
  }
  if (by === 'aloud') return [{ key: 'self', label: '혼자 읽음', color: slotColor(0) }, { key: 'aloud', label: '읽어 줌', color: slotColor(1) }];
  // Subjects past the 7th share one gray "그 외" series instead of inventing more hues.
  const own = store.subjects().filter((s) => subjectColor(s.key) !== OTHER_COLOR);
  return [...own.map((s) => ({ key: s.key, label: s.label, color: subjectColor(s.key) })), { key: 'other', label: '그 외', color: OTHER_COLOR }];
}

function foldSubjects(table) {
  const own = new Set(store.subjects().filter((s) => subjectColor(s.key) !== OTHER_COLOR).map((s) => s.key));
  for (const cell of table.values()) {
    for (const [k, v] of [...cell]) {
      if (own.has(k) || k === 'other') continue;
      cell.set('other', (cell.get('other') || 0) + v);
      cell.delete(k);
    }
  }
}

export function renderStats(root, { rerender }) {
  const today = todayStr();
  const all = store.reads().map((r) => ({ ...r, book: store.getBook(r.bookId) }));
  const rows = f.reader === 'all' ? all : all.filter((r) => r.readerId === f.reader);
  const unit = METRICS[f.metric].unit;
  const set = (k) => (v) => {
    f[k] = v;
    rerender();
  };

  root.append(h('header', { class: 'page-head' }, h('h1', null, '통계')));
  if (!all.length) {
    root.append(emptyState('기록이 쌓이면 여기에서 일·주·월·연도별로 볼 수 있어요.'));
    return;
  }

  root.append(h('div', { class: 'filters' },
    chipGroup([{ key: 'all', label: '모두' }, ...store.readers().map((r) => ({ key: r.id, label: r.name, color: readerColor(r) }))],
      { value: f.reader, required: true, onChange: set('reader') }),
    chipGroup(Object.entries(METRICS).map(([key, m]) => ({ key, label: m.label })), { value: f.metric, required: true, cls: 'seg', onChange: set('metric') })));

  const t = headline(rows, f.metric, today);
  const fmt = f.metric === 'words' ? compactNum : fmtNum;
  root.append(h('div', { class: 'tiles' },
    [['오늘', t.today], ['이번 주', t.week], ['이번 달', t.month], ['올해', t.year], ['전체', t.all]].map(([label, v]) =>
      h('div', { class: 'tile' }, h('span', { class: 'tile-label' }, label), h('span', { class: 'tile-value' }, fmt(v), h('small', null, unit))))));

  // Distinct books (re-reads counted once), so "read 12 times" vs "8 different books" is clear.
  const u = distinctBooks(rows, today);
  root.append(h('div', { class: 'distinct' },
    h('span', { class: 'distinct-label muted' }, '서로 다른 책 (여러 번 읽은 책은 1권)'),
    h('div', { class: 'tiles sub' },
      [['오늘', u.today], ['이번 주', u.week], ['이번 달', u.month], ['올해', u.year], ['전체', u.all]].map(([label, v]) =>
        h('div', { class: 'tile' }, h('span', { class: 'tile-label' }, label), h('span', { class: 'tile-value' }, fmtNum(v), h('small', null, '권')))))));

  // Chart
  const count = f.unit === 'year' ? yearCount(rows, today) : f.unit === 'day' ? 14 : 12;
  const { keys, table } = timeSeries(rows, { unit: f.unit, count, metric: f.metric, by: f.by, today });
  if (f.by === 'subject') foldSubjects(table);
  const box = h('div', { class: 'chart-box' });
  const missing = missingSize(rows.filter((r) => r.date >= keys[0]), f.metric);
  root.append(h('section', { class: 'card' },
    h('div', { class: 'chart-controls' },
      chipGroup(UNITS, { value: f.unit, required: true, cls: 'seg', onChange: set('unit') }),
      select(GROUPS, f.by, set('by'), '나눠 보기')),
    box,
    missing > 0 && h('p', { class: 'hint' }, `${f.metric === 'pages' ? '쪽수' : '단어 수'}가 없는 책 ${missing}권은 0으로 셌어요. 책 정보에서 채울 수 있어요.`)));
  stackedBars(box, {
    periods: keys.map((k) => ({ key: k, label: periodLabel(k, f.unit), long: longLabel(k, f.unit) })),
    series: seriesFor(f.by),
    table,
    unit,
    title: `${UNITS.find((u) => u.key === f.unit).label} ${METRICS[f.metric].label}`,
  });

  // Most-read books in the chart's range.
  const top = topBooks(rows.filter((r) => r.date >= keys[0]), 5);
  root.append(h('section', { class: 'card' },
    h('h3', null, '가장 많이 읽은 책'),
    !top.length && h('p', { class: 'muted' }, '이 기간에는 기록이 없어요'),
    h('ol', { class: 'plain top' }, top.map(({ book, count: c }) =>
      h('li', null, h('button', { class: 'row compact', onClick: () => openBook(book.id) },
        cover(book, 's'),
        h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, book.title)),
        h('span', { class: 'row-side' }, `${c}번`)))))));

  // Shelf progress: how much of the shelf each person has read.
  const total = store.books().length;
  root.append(h('section', { class: 'card' },
    h('h3', null, `책장 ${total}권 중 읽은 책`),
    h('ul', { class: 'plain' }, store.readers().map((r) => {
      const n = new Set(all.filter((x) => x.readerId === r.id).map((x) => x.bookId)).size;
      return h('li', { class: 'progress-row' },
        whoChip(r),
        h('span', { class: 'meter', style: `--fill:${readerColor(r)}` }, h('span', { style: `width:${total ? (100 * n) / total : 0}%` })),
        h('span', { class: 'small' }, `${n}권 · 안 읽은 책 ${total - n}권`));
    }))));
}
