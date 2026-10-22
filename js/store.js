// All data lives in IndexedDB on the phone and is mirrored in memory (`state`).
// Records are never hard-deleted: `deletedAt` marks them, so a backup merged on
// another phone carries the deletion with it. The newer `updatedAt` wins a merge.
// Every change made on this phone is also noted in the `outbox` store until family
// sync (sync.js) has sent it.

import { uid, nowIso, normTitle } from './util.js';
import { DEFAULT_SUBJECTS } from './catalog.js';
import { planMerge, keyOf } from './merge.js';

const DB_NAME = 'reading-log';
const TABLES = ['books', 'reads', 'readers', 'notes', 'photos'];
const EPOCH = '1970-01-01T00:00:00.000Z';

// Fixed ids, so two phones that both start from the defaults merge cleanly.
const DEFAULT_READERS = [
  { id: 'r_kid1', name: '첫째', kind: 'child', slot: 0 },
  { id: 'r_kid2', name: '둘째', kind: 'child', slot: 1 },
  { id: 'r_mom', name: '엄마', kind: 'parent', slot: 2 },
  { id: 'r_dad', name: '아빠', kind: 'parent', slot: 3 },
];

export const state = {
  books: new Map(), reads: new Map(), readers: new Map(), notes: new Map(), photos: new Map(), meta: new Map(),
};

const listeners = new Set();
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const changed = () => listeners.forEach((fn) => fn());

// Called when something new waits in the outbox.
const outboxListeners = new Set();
export function onOutbox(fn) {
  outboxListeners.add(fn);
}

// ---- IndexedDB plumbing ----

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const t of TABLES) if (!d.objectStoreNames.contains(t)) d.createObjectStore(t, { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      // v2: changes waiting for family sync, one entry per record ('books:<id>'). v3: notes, photos.
      if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'k' });
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

function run(d, stores, fill) {
  return new Promise((resolve, reject) => {
    const tx = d.transaction(stores, 'readwrite');
    fill(tx);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// changes: {books: [...], reads: [...], ...} written in one transaction, then mirrored.
// send: which records go in the outbox: 'all' (a change made here) or a Set of 'table:key'.
async function write(changes, send = 'all') {
  const tables = Object.keys(changes).filter((t) => changes[t].length);
  if (!tables.length) return;
  let queued = 0;
  await run(await db(), [...tables, 'outbox'], (tx) => {
    for (const t of tables) {
      for (const item of changes[t]) {
        tx.objectStore(t).put(item);
        const k = `${t}:${keyOf(t, item)}`;
        if (send === 'all' || send.has(k)) {
          tx.objectStore('outbox').put({ k, t, id: keyOf(t, item) });
          queued++;
        }
      }
    }
  });
  for (const t of tables) for (const item of changes[t]) state[t].set(keyOf(t, item), item);
  changed();
  if (queued) outboxListeners.forEach((fn) => fn());
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
// Books are keyed isbn_<ISBN> when first saved with one; an ISBN added later lives only in the field.
export const bookByIsbn = (isbn) => getBook(`isbn_${isbn}`) ?? books().find((b) => b.isbn === isbn) ?? null;
const isLive = (x) => x && !x.deletedAt;

export const subjects = () => state.meta.get('subjects')?.value ?? DEFAULT_SUBJECTS;
export const subjectLabel = (key) => subjects().find((s) => s.key === key)?.label ?? '기타';

export function readsOfBook(bookId) {
  return reads().filter((r) => r.bookId === bookId).sort((a, b) => b.date.localeCompare(a.date));
}

// The family's tags, most used first, from books and notes (so new tags reuse the same words).
export function knownTags() {
  const counts = new Map();
  for (const x of [...books(), ...notes()]) for (const t of x.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

// The shelf book whose ISBN is nearest to `isbn` from the same publisher block: volumes of a 전집
// usually get ISBNs in sequence, so a new volume can borrow the set's name, subject and level.
export function nearestByIsbn(isbn, within = 100) {
  const n = Number(isbn.slice(0, 12));
  let best = null;
  for (const b of books()) {
    if (!b.isbn || b.isbn === isbn || b.isbn.slice(0, 7) !== isbn.slice(0, 7)) continue;
    const d = Math.abs(Number(b.isbn.slice(0, 12)) - n);
    if (d <= within && (!best || d < best.d)) best = { book: b, d };
  }
  return best?.book ?? null;
}

export function findBookByTitle(title) {
  const n = normTitle(title);
  return n ? books().find((b) => normTitle(b.title) === n) ?? null : null;
}

// ---- writes ----

const BOOK_FIELDS = ['isbn', 'title', 'authors', 'publisher', 'pubDate', 'lang', 'subject', 'level',
  'levelTag', 'pages', 'words', 'cover', 'note', 'series', 'tags'];

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

// Change an existing reading record (date, who, read-aloud).
export async function updateRead(id, fields) {
  const prev = state.reads.get(id);
  if (!prev || prev.deletedAt) return;
  await write({ reads: [{ ...prev, ...fields, updatedAt: nowIso() }] });
}

export async function removeRead(id) {
  await write({ reads: [tomb(state.reads.get(id))] });
}

export async function removeBook(id) {
  const rs = alive(state.reads).filter((r) => r.bookId === id).map(tomb);
  await write({ books: [tomb(state.books.get(id))], reads: rs });
}

export async function saveReader({ id, name, kind, birth }) {
  const now = nowIso();
  const prev = id && state.readers.get(id);
  const used = new Set(readers().map((r) => r.slot));
  let slot = prev?.slot;
  if (slot == null) for (slot = 0; used.has(slot); slot++);
  const reader = { ...(prev || {}), id: id || uid('p'), name, kind, slot, createdAt: prev?.createdAt ?? now, updatedAt: now };
  if (birth !== undefined) reader.birth = birth; // 'YYYY-MM'
  await write({ readers: [reader] });
  return reader;
}

export async function removeReader(id) {
  await write({ readers: [tomb(state.readers.get(id))] });
}

// ---- notes: what a child learned, with #tags; photos are their own records so that
// editing a note's text doesn't send its photos again ----

export const notes = () => alive(state.notes).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
export const notesOfBook = (bookId) => notes().filter((n) => n.bookId === bookId);
export const photosOf = (noteId) => alive(state.photos).filter((p) => p.noteId === noteId)
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

const NOTE_FIELDS = ['bookId', 'readerIds', 'date', 'page', 'text', 'tags', 'area', 'question'];

// add: [{data, thumb}] new photos; remove: ids of photos to drop.
export async function saveNote(fields, { id, add = [], remove = [] } = {}) {
  const now = nowIso();
  const prev = id && state.notes.get(id);
  const note = { ...(prev || {}), id: id || uid('n'), createdAt: prev?.createdAt ?? now, updatedAt: now };
  for (const k of NOTE_FIELDS) if (k in fields) note[k] = fields[k];
  const photos = add.map(({ data, thumb }) => ({ id: uid('ph'), noteId: note.id, data, thumb, createdAt: now, updatedAt: now }));
  for (const pid of remove) if (state.photos.get(pid)) photos.push(photoTomb(state.photos.get(pid)));
  await write({ notes: [note], photos });
  return note;
}

// A deleted photo keeps no picture, so the deletion doesn't upload it again.
const photoTomb = (p) => ({ id: p.id, noteId: p.noteId, createdAt: p.createdAt, deletedAt: nowIso(), updatedAt: nowIso() });

export async function removeNote(id) {
  await write({ notes: [tomb(state.notes.get(id))], photos: photosOf(id).map(photoTomb) });
}

// Many books at once (the "자동 분류" button): one transaction, one re-render.
export async function updateBooks(patches) {
  const now = nowIso();
  const list = patches.map(({ id, ...fields }) => ({ ...state.books.get(id), ...fields, updatedAt: now }));
  await write({ books: list });
  return list.length;
}

export async function setSubjects(list) {
  await write({ meta: [{ key: 'subjects', value: list, updatedAt: nowIso() }] });
}

// ---- family sync: the outbox ----

// Puts every record in the outbox (when this phone joins family sync).
export async function queueAll() {
  await run(await db(), ['outbox'], (tx) => {
    for (const t of [...TABLES, 'meta']) {
      for (const k of state[t].keys()) tx.objectStore('outbox').put({ k: `${t}:${k}`, t, id: k });
    }
  });
  outboxListeners.forEach((fn) => fn());
}

// The next records to send: [{table, rec}], at most `limit` records or about `maxChars` of JSON.
// tables: only these tables (an older sync server doesn't know notes), or null for all.
export async function outbox(limit, maxChars, tables = null) {
  const batch = [];
  const stale = [];
  let chars = 0;
  for (const e of await readAll('outbox')) {
    if (tables && !tables.includes(e.t)) continue;
    const rec = state[e.t]?.get(e.id);
    if (!rec) {
      stale.push(e.k);
      continue;
    }
    const size = JSON.stringify(rec).length;
    if (batch.length && (batch.length >= limit || chars + size > maxChars)) break;
    batch.push({ table: e.t, rec });
    chars += size;
  }
  if (stale.length) await run(await db(), ['outbox'], (tx) => stale.forEach((k) => tx.objectStore('outbox').delete(k)));
  return batch;
}

// Takes sent records out of the outbox, unless they changed again while being sent.
export async function sent(batch) {
  await run(await db(), ['outbox'], (tx) => {
    for (const { table, rec } of batch) {
      if (state[table].get(keyOf(table, rec)) === rec) tx.objectStore('outbox').delete(`${table}:${keyOf(table, rec)}`);
    }
  });
}

export async function outboxSize(tables = null) {
  return (await readAll('outbox')).filter((e) => !tables || tables.includes(e.t)).length;
}

// Records from another phone (sync or backup), merged by the rules in merge.js.
export async function mergeIn(data, { fromSync = false } = {}) {
  const { out, dirty, counts } = planMerge(state, data, { now: nowIso(), fromSync });
  await write(out, dirty);
  return counts;
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
    notes: [...state.notes.values()],
    photos: [...state.photos.values()],
    meta: [...state.meta.values()],
  };
}

// Merges a backup into this phone (rules in merge.js).
export async function importData(data) {
  if (data?.app !== 'reading-log' || !Array.isArray(data.books) || !Array.isArray(data.reads)) {
    throw new Error('독서기록 백업 파일이 아니에요.');
  }
  return mergeIn(data);
}

export async function requestPersist() {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
