// All data lives in IndexedDB on the phone and is mirrored in memory (`state`).
// Records are never hard-deleted: `deletedAt` marks them, so a backup merged on
// another phone carries the deletion with it. The newer `updatedAt` wins a merge.

import { uid, nowIso, normTitle } from './util.js';
import { DEFAULT_SUBJECTS } from './catalog.js';

const DB_NAME = 'reading-log';
const TABLES = ['books', 'reads', 'readers'];
const EPOCH = '1970-01-01T00:00:00.000Z';

// Fixed ids, so two phones that both start from the defaults merge cleanly.
const DEFAULT_READERS = [
  { id: 'r_kid1', name: '첫째', kind: 'child', slot: 0 },
  { id: 'r_kid2', name: '둘째', kind: 'child', slot: 1 },
  { id: 'r_mom', name: '엄마', kind: 'parent', slot: 2 },
  { id: 'r_dad', name: '아빠', kind: 'parent', slot: 3 },
];

export const state = { books: new Map(), reads: new Map(), readers: new Map(), meta: new Map() };

const listeners = new Set();
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const changed = () => listeners.forEach((fn) => fn());

// ---- IndexedDB plumbing ----

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const t of TABLES) if (!d.objectStoreNames.contains(t)) d.createObjectStore(t, { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function readAll(table) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction(table).objectStore(table).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// changes: {books: [...], reads: [...], ...} written in one transaction, then mirrored.
async function write(changes) {
  const tables = Object.keys(changes).filter((t) => changes[t].length);
  if (!tables.length) return;
  const d = await db();
  await new Promise((resolve, reject) => {
    const tx = d.transaction(tables, 'readwrite');
    for (const t of tables) for (const item of changes[t]) tx.objectStore(t).put(item);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  for (const t of tables) for (const item of changes[t]) state[t].set(t === 'meta' ? item.key : item.id, item);
  changed();
}

export async function load() {
  for (const t of TABLES) {
    for (const item of await readAll(t)) state[t].set(item.id, item);
  }
  for (const item of await readAll('meta')) state.meta.set(item.key, item);
  if (!state.readers.size) {
    await write({ readers: DEFAULT_READERS.map((r) => ({ ...r, createdAt: EPOCH, updatedAt: EPOCH })) });
  }
}

// ---- reads of the in-memory state ----

const alive = (map) => [...map.values()].filter((x) => !x.deletedAt);

export const books = () => alive(state.books);
export const reads = () => alive(state.reads).filter((r) => isLive(state.books.get(r.bookId)) && isLive(state.readers.get(r.readerId)));
export const readers = () => alive(state.readers).sort((a, b) => a.slot - b.slot);
export const getBook = (id) => (isLive(state.books.get(id)) ? state.books.get(id) : null);
export const getReader = (id) => state.readers.get(id);
const isLive = (x) => x && !x.deletedAt;

export const subjects = () => state.meta.get('subjects')?.value ?? DEFAULT_SUBJECTS;
export const subjectLabel = (key) => subjects().find((s) => s.key === key)?.label ?? '기타';

export function readsOfBook(bookId) {
  return reads().filter((r) => r.bookId === bookId).sort((a, b) => b.date.localeCompare(a.date));
}

export function findBookByTitle(title) {
  const n = normTitle(title);
  return n ? books().find((b) => normTitle(b.title) === n) ?? null : null;
}

// ---- writes ----

const BOOK_FIELDS = ['isbn', 'title', 'authors', 'publisher', 'pubDate', 'lang', 'subject', 'level',
  'levelTag', 'pages', 'words', 'cover', 'note'];

export async function saveBook(fields, id) {
  const now = nowIso();
  id ??= fields.isbn ? `isbn_${fields.isbn}` : uid('b');
  const prev = state.books.get(id);
  const book = { ...(prev && !prev.deletedAt ? prev : {}), id, createdAt: prev?.createdAt ?? now, updatedAt: now };
  delete book.deletedAt;
  for (const k of BOOK_FIELDS) if (k in fields) book[k] = fields[k];
  await write({ books: [book] });
  return book;
}

export async function addReads(bookId, readerIds, dates, aloud) {
  const now = nowIso();
  const items = [];
  for (const readerId of readerIds) {
    for (const date of dates) {
      items.push({ id: uid('r'), bookId, readerId, date, aloud: !!aloud, createdAt: now, updatedAt: now });
    }
  }
  await write({ reads: items });
  return items.length;
}

const tomb = (x) => ({ ...x, deletedAt: nowIso(), updatedAt: nowIso() });

export async function removeRead(id) {
  await write({ reads: [tomb(state.reads.get(id))] });
}

export async function removeBook(id) {
  const rs = alive(state.reads).filter((r) => r.bookId === id).map(tomb);
  await write({ books: [tomb(state.books.get(id))], reads: rs });
}

export async function saveReader({ id, name, kind }) {
  const now = nowIso();
  const prev = id && state.readers.get(id);
  const used = new Set(readers().map((r) => r.slot));
  let slot = prev?.slot;
  if (slot == null) for (slot = 0; used.has(slot); slot++);
  const reader = { ...(prev || {}), id: id || uid('p'), name, kind, slot, createdAt: prev?.createdAt ?? now, updatedAt: now };
  await write({ readers: [reader] });
  return reader;
}

export async function removeReader(id) {
  await write({ readers: [tomb(state.readers.get(id))] });
}

export async function setSubjects(list) {
  await write({ meta: [{ key: 'subjects', value: list, updatedAt: nowIso() }] });
}

// ---- backup ----

export function exportData() {
  return {
    app: 'reading-log',
    format: 1,
    exportedAt: nowIso(),
    books: [...state.books.values()],
    reads: [...state.reads.values()],
    readers: [...state.readers.values()],
    meta: [...state.meta.values()],
  };
}

// Merges a backup into this phone. Same id: newer updatedAt wins.
// A book typed in on both phones (no ISBN, same title) becomes one book, and the
// same reader+book+date read logged on both phones is kept once.
export async function importData(data) {
  if (data?.app !== 'reading-log' || !Array.isArray(data.books) || !Array.isArray(data.reads)) {
    throw new Error('독서기록 백업 파일이 아니에요.');
  }
  const newer = (map, key, item) => !map.get(key) || String(item.updatedAt) > String(map.get(key).updatedAt);
  const out = { books: [], reads: [], readers: [], meta: [] };

  const byTitle = new Map(books().filter((b) => !b.isbn).map((b) => [normTitle(b.title), b.id]));
  const remap = new Map();
  for (const b of data.books) {
    if (!b?.id || typeof b.title !== 'string') continue;
    const twin = !b.isbn && !state.books.has(b.id) && byTitle.get(normTitle(b.title));
    if (twin && !b.deletedAt) { remap.set(b.id, twin); continue; }
    if (newer(state.books, b.id, b)) out.books.push(b);
  }
  for (const p of data.readers || []) if (p?.id && newer(state.readers, p.id, p)) out.readers.push(p);
  for (const m of data.meta || []) if (m?.key && newer(state.meta, m.key, m)) out.meta.push(m);

  const seen = new Set(alive(state.reads).map((r) => `${r.bookId}|${r.readerId}|${r.date}`));
  for (const r of data.reads) {
    if (!r?.id || !r.bookId || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) continue;
    const read = remap.has(r.bookId) ? { ...r, bookId: remap.get(r.bookId) } : r;
    const sig = `${read.bookId}|${read.readerId}|${read.date}`;
    if (!state.reads.has(read.id) && !read.deletedAt && seen.has(sig)) continue;
    if (newer(state.reads, read.id, read)) {
      out.reads.push(read);
      seen.add(sig);
    }
  }
  await write(out);
  return { books: out.books.length, reads: out.reads.length, readers: out.readers.length };
}

export async function requestPersist() {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
