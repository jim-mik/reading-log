// Aggregation for the 통계 tab. Pure functions over "rows": one row per read,
// joined with its book: { date, readerId, aloud, book }.

import { periodKey, periodRange, weekStart, todayStr } from './util.js';

export const METRICS = {
  books: { label: '권수', unit: '권' },
  pages: { label: '쪽수', unit: '쪽' },
  words: { label: '단어 수', unit: '단어' },
};

export function valueOf(row, metric) {
  if (metric === 'pages') return row.book.pages || 0;
  if (metric === 'words') return row.book.words || 0;
  return 1;
}

export function groupOf(row, by) {
  if (by === 'reader') return row.readerId;
  if (by === 'lang') return row.book.lang || 'etc';
  if (by === 'subject') return row.book.subject || 'etc';
  if (by === 'level') return row.book.level ? String(row.book.level) : '0';
  if (by === 'aloud') return row.aloud ? 'aloud' : 'self';
  return 'all';
}

// Period x group totals for the `count` periods (day|week|month|year) ending at `today`.
export function timeSeries(rows, { unit, count, metric, by, today = todayStr() }) {
  const keys = periodRange(today, unit, count);
  const table = new Map(keys.map((k) => [k, new Map()]));
  for (const row of rows) {
    const cell = table.get(periodKey(row.date, unit));
    if (!cell) continue;
    const g = groupOf(row, by);
    cell.set(g, (cell.get(g) || 0) + valueOf(row, metric));
  }
  return { keys, table };
}

// Totals for today / this week / month / year / all time.
export function headline(rows, metric, today = todayStr()) {
  const from = { week: weekStart(today), month: `${today.slice(0, 7)}-01`, year: `${today.slice(0, 4)}-01-01` };
  const out = { today: 0, week: 0, month: 0, year: 0, all: 0 };
  for (const row of rows) {
    if (row.date > today) continue;
    const v = valueOf(row, metric);
    out.all += v;
    if (row.date >= from.year) out.year += v;
    if (row.date >= from.month) out.month += v;
    if (row.date >= from.week) out.week += v;
    if (row.date === today) out.today += v;
  }
  return out;
}

// Distinct books read (re-reads counted once) in each period window.
export function distinctBooks(rows, today = todayStr()) {
  const from = { week: weekStart(today), month: `${today.slice(0, 7)}-01`, year: `${today.slice(0, 4)}-01-01` };
  const sets = { today: new Set(), week: new Set(), month: new Set(), year: new Set(), all: new Set() };
  for (const row of rows) {
    if (row.date > today) continue;
    const id = row.book.id;
    sets.all.add(id);
    if (row.date >= from.year) sets.year.add(id);
    if (row.date >= from.month) sets.month.add(id);
    if (row.date >= from.week) sets.week.add(id);
    if (row.date === today) sets.today.add(id);
  }
  return { today: sets.today.size, week: sets.week.size, month: sets.month.size, year: sets.year.size, all: sets.all.size };
}

// How many year bars to show: from the first record's year to now, at least 3.
export function yearCount(rows, today = todayStr()) {
  const first = rows.reduce((m, r) => (r.date < m ? r.date : m), today);
  return Math.max(3, Number(today.slice(0, 4)) - Number(first.slice(0, 4)) + 1);
}

export function topBooks(rows, n = 5) {
  const counts = new Map();
  for (const row of rows) counts.set(row.book.id, { book: row.book, count: (counts.get(row.book.id)?.count || 0) + 1 });
  return [...counts.values()].sort((a, b) => b.count - a.count || a.book.title.localeCompare(b.book.title)).slice(0, n);
}

// Books in `rows` that have no page/word count (they add 0 to those metrics).
export function missingSize(rows, metric) {
  if (metric === 'books') return 0;
  const ids = new Set(rows.filter((r) => !valueOf(r, metric)).map((r) => r.book.id));
  return ids.size;
}
