// Merging records from another phone (family sync or a backup file) into this phone's records.
// Every phone applies the same rules in the same way, so all phones end up with the same records:
//   - same id: the newer updatedAt wins;
//   - a book typed in on two phones (no ISBN, same title) becomes one book: the one added first
//     stays, the other is marked `mergedInto` it and its reads move over;
//   - the same reader + book + date logged twice is kept once (the one logged first stays).
// Pure: no IndexedDB, so the rules can be unit tested.

import { normTitle } from './util.js';

const TABLES = ['books', 'readers', 'meta', 'reads'];
export const keyOf = (t, x) => (t === 'meta' ? x?.key : x?.id);
const live = (x) => x && !x.deletedAt;
const sigOf = (r) => `${r.bookId}|${r.readerId}|${r.date}`;
// Oldest first; the id breaks ties so every phone picks the same one.
const firstMade = (x, y) => String(x.createdAt ?? '').localeCompare(String(y.createdAt ?? '')) || (x.id < y.id ? -1 : 1);

function valid(t, x) {
  const k = keyOf(t, x);
  if (typeof k !== 'string' || !k) return false;
  if (t === 'books') return typeof x.title === 'string';
  if (t === 'reads') return typeof x.bookId === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.date || '');
  return true;
}

// state: {books: Map, reads: Map, readers: Map, meta: Map}; data: {books: [...], reads: [...], ...}.
// fromSync: records from the sync server are already on the server, so only the records this merge
// changes itself go back; records from a backup file are all sent.
// Returns {out: {table: [records to write]}, dirty: Set of 'table:key' to send, counts}.
export function planMerge(state, data, { now, fromSync = false }) {
  const out = { books: new Map(), reads: new Map(), readers: new Map(), meta: new Map() };
  const dirty = new Set();
  const cur = (t, k) => out[t].get(k) ?? state[t].get(k);
  const put = (t, rec, mine) => {
    out[t].set(keyOf(t, rec), rec);
    if (mine || !fromSync) dirty.add(`${t}:${keyOf(t, rec)}`);
  };
  const all = (t) => {
    const m = new Map(state[t]);
    for (const [k, v] of out[t]) m.set(k, v);
    return m;
  };

  // 1. Same id: newer wins. A pull can hold several versions of one record; the newest stays.
  const accepted = { books: new Map(), reads: new Map(), readers: new Map(), meta: new Map() };
  for (const t of TABLES) {
    for (const x of data[t] || []) {
      if (!x || !valid(t, x)) continue;
      const c = cur(t, keyOf(t, x));
      if (c && !(String(x.updatedAt) > String(c.updatedAt))) continue;
      put(t, x, false);
      accepted[t].set(keyOf(t, x), x);
    }
  }

  // 2. Twin books: the same title typed in on two phones.
  const titled = new Map();
  for (const b of all('books').values()) {
    if (!live(b) || b.isbn || !normTitle(b.title)) continue;
    const n = normTitle(b.title);
    if (!titled.has(n)) titled.set(n, []);
    titled.get(n).push(b);
  }
  for (const b of accepted.books.values()) {
    const group = live(b) && !b.isbn ? titled.get(normTitle(b.title)) : null;
    if (!group || group.length < 2) continue;
    group.sort(firstMade);
    for (const loser of group.slice(1)) {
      if (live(cur('books', loser.id))) put('books', { ...loser, deletedAt: now, updatedAt: now, mergedInto: group[0].id }, true);
    }
  }

  // 3. Reads of a merged book move to the book it was merged into.
  const target = (id) => {
    for (let i = 0; i < 10; i++) {
      const b = cur('books', id);
      if (!b?.deletedAt || !b.mergedInto) break;
      id = b.mergedInto;
    }
    return id;
  };
  const touched = [...accepted.reads.values()];
  for (const r of all('reads').values()) {
    if (!live(r)) continue;
    const to = target(r.bookId);
    if (to === r.bookId) continue;
    const moved = { ...r, bookId: to, updatedAt: now };
    put('reads', moved, true);
    touched.push(moved);
  }

  // 4. The same reader + book + date twice: keep the first one.
  const sigs = new Set(touched.filter(live).map(sigOf));
  if (sigs.size) {
    const groups = new Map();
    for (const r of all('reads').values()) {
      if (!live(r) || !sigs.has(sigOf(r))) continue;
      if (!groups.has(sigOf(r))) groups.set(sigOf(r), []);
      groups.get(sigOf(r)).push(r);
    }
    for (const g of groups.values()) {
      g.sort(firstMade);
      for (const r of g.slice(1)) put('reads', { ...r, deletedAt: now, updatedAt: now }, true);
    }
  }

  // Counts for the "합쳤어요" message: incoming records that are still there after the merge.
  const counts = {};
  for (const t of ['books', 'reads', 'readers']) {
    counts[t] = [...accepted[t]].filter(([k, x]) => x.deletedAt || live(out[t].get(k))).length;
  }
  const result = {};
  for (const t of Object.keys(out)) result[t] = [...out[t].values()];
  return { out: result, dirty, counts };
}
