// Family sync: the merge rules (js/merge.js) and the Apps Script server (sync/apps-script.js)
// on a fake Google Sheet, plus a simulation of two phones syncing through it.
// Run: node --test tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { planMerge } from '../js/merge.js';
import { loadServer } from './fake-apps-script.js';
import { tagsIn, allTags, splitTags, matches, tagCounts, ageMonths } from '../js/notes.js';

const KEY = 'k'.repeat(32);
const emptyState = () => ({ books: new Map(), reads: new Map(), readers: new Map(), meta: new Map(), notes: new Map(), photos: new Map() });
const book = (id, title, u = 'T1', extra = {}) => ({ id, title, isbn: '', updatedAt: u, createdAt: u, ...extra });
const read = (id, bookId, readerId, date, u = 'T1') => ({ id, bookId, readerId, date, aloud: false, updatedAt: u, createdAt: u });

function apply(state, out) {
  for (const t of Object.keys(out)) for (const x of out[t]) state[t].set(t === 'meta' ? x.key : x.id, x);
}

// ---------- merge rules ----------

test('same id: the newer version wins, an older one is ignored', () => {
  const st = emptyState();
  st.books.set('b1', book('b1', 'A', 'T5'));
  let r = planMerge(st, { books: [book('b1', 'old', 'T3')] }, { now: 'T9', fromSync: true });
  assert.equal(r.out.books.length, 0);
  r = planMerge(st, { books: [book('b1', 'new', 'T6'), book('b1', 'newest', 'T7')] }, { now: 'T9', fromSync: true });
  assert.equal(r.out.books.length, 1);
  assert.equal(r.out.books[0].title, 'newest');
  assert.equal(r.dirty.size, 0, 'records pulled from the server are not sent back');
});

test('a backup import sends everything it adds', () => {
  const r = planMerge(emptyState(), { books: [book('b1', 'A')], reads: [read('r1', 'b1', 'r_kid1', '2026-10-01')] }, { now: 'T9' });
  assert.deepEqual([...r.dirty].sort(), ['books:b1', 'reads:r1']);
  assert.deepEqual(r.counts, { books: 1, reads: 1, readers: 0, notes: 0 });
});

test('the same title typed on two phones becomes one book on both, with the reads moved and deduplicated', () => {
  // Phone A has b_aaa, phone B has b_zzz: same title (spacing and case differ), no ISBN, same read logged.
  const a = emptyState();
  a.books.set('b_aaa', book('b_aaa', '구름빵', 'T1'));
  a.reads.set('r_a', read('r_a', 'b_aaa', 'r_kid1', '2026-10-01', 'T1'));
  const b = emptyState();
  b.books.set('b_zzz', book('b_zzz', ' 구름 빵 ', 'T2'));
  b.reads.set('r_b', read('r_b', 'b_zzz', 'r_kid1', '2026-10-01', 'T2'));
  b.reads.set('r_b2', read('r_b2', 'b_zzz', 'r_kid2', '2026-10-02', 'T2'));

  const toA = planMerge(a, { books: [...b.books.values()], reads: [...b.reads.values()] }, { now: 'T3', fromSync: true });
  const toB = planMerge(b, { books: [...a.books.values()], reads: [...a.reads.values()] }, { now: 'T3', fromSync: true });
  apply(a, toA.out);
  apply(b, toB.out);

  for (const st of [a, b]) {
    const liveBooks = [...st.books.values()].filter((x) => !x.deletedAt);
    assert.deepEqual(liveBooks.map((x) => x.id), ['b_aaa'], 'the book added first stays');
    assert.equal(st.books.get('b_zzz').mergedInto, 'b_aaa');
    const liveReads = [...st.reads.values()].filter((x) => !x.deletedAt).map((x) => `${x.id}:${x.bookId}`).sort();
    assert.deepEqual(liveReads, ['r_a:b_aaa', 'r_b2:b_aaa'], 'reads moved; the read logged first stays');
  }
  assert.ok(toA.dirty.has('books:b_zzz') && toA.dirty.has('reads:r_b2') && toA.dirty.has('reads:r_b'), 'phone A sends what it changed');
  assert.deepEqual(toA.counts, { books: 0, reads: 1, readers: 0, notes: 0 }, 'message counts what is still there');
});

test('the book added first stays, even with the larger id', () => {
  const st = emptyState();
  st.books.set('b_zzz', book('b_zzz', '강아지똥', 'T1'));
  const r = planMerge(st, { books: [book('b_aaa', '강아지똥', 'T2')] }, { now: 'T3', fromSync: true });
  const final = new Map(r.out.books.map((b) => [b.id, b]));
  assert.equal(final.get('b_aaa').mergedInto, 'b_zzz');
  assert.ok(!final.has('b_zzz'), 'the older book is untouched');
});

test('a read that arrives for a merged book follows it', () => {
  const st = emptyState();
  st.books.set('b_a', book('b_a', 'X'));
  st.books.set('b_z', book('b_z', 'X', 'T2', { deletedAt: 'T2', mergedInto: 'b_a' }));
  const r = planMerge(st, { reads: [read('r1', 'b_z', 'r_kid1', '2026-10-01', 'T3')] }, { now: 'T4', fromSync: true });
  assert.equal(r.out.reads.at(-1).bookId, 'b_a');
  assert.ok(r.dirty.has('reads:r1'));
});

test('books with an ISBN are never merged by title', () => {
  const st = emptyState();
  st.books.set('isbn_9788993242188', book('isbn_9788993242188', '구름빵', 'T1', { isbn: '9788993242188' }));
  const r = planMerge(st, { books: [book('b_x', '구름빵', 'T2')] }, { now: 'T3', fromSync: true });
  assert.equal(r.out.books.length, 1);
  assert.ok(!r.out.books[0].deletedAt);
});

test('invalid records are skipped', () => {
  const r = planMerge(emptyState(), {
    books: [null, { id: 'b1' }, { title: 'no id' }],
    reads: [{ id: 'r1', bookId: 'b1', date: '10/01/2026' }],
    meta: [{ value: 1 }],
  }, { now: 'T1' });
  assert.equal(r.dirty.size, 0);
});

test('notes and photos merge like other records, and follow a merged book', () => {
  const st = emptyState();
  st.books.set('b_a', book('b_a', 'X'));
  st.books.set('b_z', book('b_z', 'X', 'T2', { deletedAt: 'T2', mergedInto: 'b_a' }));
  const note = { id: 'n1', bookId: 'b_z', readerIds: ['r_kid1'], date: '2026-10-14', text: '#공룡 뿔 3개', tags: ['공룡'], updatedAt: 'T3', createdAt: 'T3' };
  const r = planMerge(st, {
    notes: [note, { id: 'n_bad', text: 'no date' }],
    photos: [{ id: 'p1', noteId: 'n1', data: 'data:image/jpeg;base64,AAA', updatedAt: 'T3', createdAt: 'T3' },
      { id: 'p2', noteId: 'n1', deletedAt: 'T4', updatedAt: 'T4', createdAt: 'T3' }, { id: 'p3', noteId: 'n1', updatedAt: 'T3' }],
  }, { now: 'T5', fromSync: true });
  assert.equal(r.out.notes.length, 1);
  assert.equal(r.out.notes[0].bookId, 'b_a', 'the note moved to the book it was merged into');
  assert.ok(r.dirty.has('notes:n1'));
  assert.deepEqual(r.out.photos.map((p) => p.id).sort(), ['p1', 'p2'], 'a deleted photo needs no picture; a live one does');
  assert.equal(r.counts.notes, 1);
});

test('note tags and search', () => {
  assert.deepEqual(tagsIn('트리케라톱스는 뿔이 3개 #공룡 #초식_동물 #공룡'), ['공룡', '초식_동물']);
  assert.deepEqual(allTags('비가 와요 #날씨', ['#물', '구름!', '날씨']), ['날씨', '물', '구름']);
  assert.deepEqual(splitTags('a #b c'), [{ text: 'a ' }, { tag: 'b' }, { text: ' c' }]);
  const n = { text: '식물은 햇빛으로 양분을 만든다', tags: ['광합성', '식물'], page: '12', question: '' };
  assert.ok(matches(n, '햇빛 양분'));
  assert.ok(matches(n, '#광합'), 'a # word matches the start of a tag');
  assert.ok(!matches(n, '#햇빛'), 'a # word only looks at tags');
  assert.ok(matches(n, '똑똑한', '똑똑한 식물 이야기'), 'the book title is searched');
  assert.ok(matches(n, ''));
  assert.ok(!matches(n, '공룡'));
  assert.deepEqual(tagCounts([{ tags: ['b', 'a'] }, { tags: ['a'] }]), [['a', 2], ['b', 1]]);
  assert.equal(ageMonths('2023-05', new Date(2026, 9, 14)), 41);
  assert.equal(ageMonths('', new Date()), null);
});

// ---------- server ----------

test('server: the first phone claims the key, others need the same key', () => {
  const srv = loadServer();
  assert.match(srv.get(), /동기화 서버/);
  assert.equal(srv.post({ app: 'reading-log', op: 'claim', key: KEY }).ok, true);
  assert.equal(srv.post({ app: 'reading-log', op: 'claim', key: KEY }).ok, true, 'the same key may claim again');
  assert.equal(srv.post({ app: 'reading-log', op: 'claim', key: 'x'.repeat(32) }).error, 'taken');
  assert.equal(srv.post({ app: 'reading-log', op: 'sync', key: 'x'.repeat(32), device: 'd_a' }).error, 'key');
  assert.equal(srv.post({ app: 'reading-log', op: 'sync', key: 'short', device: 'd_a' }).error, 'key');
  assert.equal(srv.post({ app: 'other', op: 'sync', key: KEY, device: 'd_a' }).error, 'bad-request');
  assert.equal(srv.post('not json').error, 'server');
});

test('server: rows go to the other phones, with text kept exactly and long records split over cells', () => {
  const srv = loadServer();
  srv.post({ app: 'reading-log', op: 'claim', key: KEY });
  // Values Sheets would otherwise turn into numbers, dates or formulas, and a cover longer than a cell
  // with an emoji right at the split.
  const cover = `data:image/jpeg;base64,${'A'.repeat(44976)}😀${'B'.repeat(70000)}==`;
  const recs = [
    { table: 'books', rec: book('b_1', '=SUM(A1)', '2026-10-14T01:02:03.000Z', { isbn: '9788993242188', pages: 40, cover, note: '-주의' }) },
    { table: 'readers', rec: { id: 'r_kid1', name: '1234', slot: 0, updatedAt: '2026-10-14T01:02:03.000Z' } },
    { table: 'meta', rec: { key: 'subjects', value: [{ key: 'lit', label: '문학' }], updatedAt: 'T1' } },
    { table: 'nope', rec: { id: 'x' } },
  ];
  const a = srv.post({ app: 'reading-log', op: 'sync', key: KEY, device: 'd_a', since: 0, push: recs });
  assert.equal(a.ok, true);
  assert.equal(a.rows.length, 0, "a phone doesn't get its own rows back");
  assert.equal(a.cursor, 4);
  assert.equal(a.logId, 'log-1');
  assert.equal(a.sheetUrl, 'https://docs.google.com/spreadsheets/d/FAKE/edit');
  assert.ok(srv.ss.getSheetByName('_log').hidden);

  const b = srv.post({ app: 'reading-log', op: 'sync', key: KEY, device: 'd_b', since: 0, push: [] });
  assert.equal(b.rows.length, 3);
  assert.deepEqual(b.rows.map((r) => r.rec), recs.slice(0, 3).map((r) => r.rec), 'records come back exactly');
  assert.equal(b.cursor, 4);
  assert.equal(b.more, false);

  const again = srv.post({ app: 'reading-log', op: 'sync', key: KEY, device: 'd_b', since: 4, push: [] });
  assert.equal(again.rows.length, 0);
  assert.equal(again.cursor, 4);
});

test('server: big pulls come in pages', () => {
  const srv = loadServer();
  srv.post({ app: 'reading-log', op: 'claim', key: KEY });
  const cover = 'C'.repeat(100000);
  const push = Array.from({ length: 40 }, (_, i) => ({ table: 'books', rec: book(`b_${i}`, `T${i}`, 'T1', { cover }) }));
  srv.post({ app: 'reading-log', op: 'sync', key: KEY, device: 'd_a', since: 0, push });
  let since = 0;
  let got = 0;
  let pages = 0;
  for (;;) {
    const r = srv.post({ app: 'reading-log', op: 'sync', key: KEY, device: 'd_b', since, push: [] });
    got += r.rows.length;
    pages++;
    since = r.cursor;
    if (!r.more) break;
  }
  assert.equal(got, 40);
  assert.ok(pages >= 2, `pages: ${pages}`);
});

test('server: a deleted log gets a new id, and a cursor past the end starts over', () => {
  const srv = loadServer();
  srv.post({ app: 'reading-log', op: 'claim', key: KEY });
  srv.post({ app: 'reading-log', op: 'sync', key: KEY, device: 'd_a', since: 0, push: [{ table: 'books', rec: book('b1', 'A') }] });
  srv.ss.deleteSheet(srv.ss.getSheetByName('_log'));
  const r = srv.post({ app: 'reading-log', op: 'sync', key: KEY, device: 'd_b', since: 9, push: [] });
  assert.equal(r.logId, 'log-2');
  srv.post({ app: 'reading-log', op: 'sync', key: KEY, device: 'd_a', since: 0, push: [{ table: 'books', rec: book('b2', 'B') }] });
  const r2 = srv.post({ app: 'reading-log', op: 'sync', key: KEY, device: 'd_b', since: 9, push: [] });
  assert.deepEqual(r2.rows.map((x) => x.rec.id), ['b2']);
});

test('server: the readable tabs show the latest live records', () => {
  const srv = loadServer();
  srv.post({ app: 'reading-log', op: 'claim', key: KEY });
  const push = [
    { table: 'readers', rec: { id: 'r_kid1', name: '첫째', slot: 0, updatedAt: 'T1' } },
    { table: 'readers', rec: { id: 'r_kid1', name: '민준', slot: 0, updatedAt: 'T2' } },
    { table: 'readers', rec: { id: 'r_mom', name: '엄마', slot: 2, updatedAt: 'T1' } },
    { table: 'meta', rec: { key: 'subjects', value: [{ key: 'lit', label: '문학·동화' }, { key: 's_x', label: '한자' }], updatedAt: 'T1' } },
    { table: 'books', rec: book('isbn_9788993242188', '구름빵', 'T1', { isbn: '9788993242188', lang: 'ko', subject: 's_x', level: 1, pages: 40 }) },
    { table: 'books', rec: book('b_gone', '지운 책', 'T1') },
    { table: 'books', rec: book('b_gone', '지운 책', 'T2', { deletedAt: 'T2' }) },
    { table: 'books', rec: book('b_unread', '-안 읽은 책', 'T1') },
    { table: 'reads', rec: read('r1', 'isbn_9788993242188', 'r_kid1', '2026-10-01') },
    { table: 'reads', rec: { ...read('r2', 'isbn_9788993242188', 'r_mom', '2026-10-05'), aloud: true } },
    { table: 'reads', rec: read('r3', 'b_gone', 'r_kid1', '2026-10-06') },
  ];
  srv.post({ app: 'reading-log', op: 'sync', key: KEY, device: 'd_a', since: 0, push });
  srv.open();
  const log = srv.ss.getSheetByName('독서기록').rows;
  assert.deepEqual(log[0].slice(0, 4), ['날짜', '읽은 사람', '읽어 줌', '제목']);
  assert.equal(log.length, 3, 'reads of a deleted book are left out');
  assert.deepEqual(log[1].slice(0, 4), [{ date: '2026-10-05' }, '엄마', 'O', '구름빵'], 'newest first');
  assert.equal(log[2][1], '민준', 'the newest name');
  assert.equal(log[2][6], '9788993242188', 'ISBN kept as text');
  assert.equal(log[2][8], '한자', 'custom subject label');
  assert.equal(log[2][9], '1 그림책');
  const shelf = srv.ss.getSheetByName('책장').rows;
  assert.deepEqual(shelf.map((r) => r[0]), ['제목', '-안 읽은 책', '구름빵'], 'a leading minus stays text');
  assert.deepEqual(shelf[2].slice(9), [2, { date: '2026-10-01' }, { date: '2026-10-05' }, '민준, 엄마']);
});

test('server: a script made at script.google.com makes its own sheet once and keeps the tabs current', () => {
  const srv = loadServer({ standalone: true });
  const claim = srv.post({ app: 'reading-log', op: 'claim', key: KEY });
  assert.equal(claim.ok, true);
  assert.equal(srv.created, 1);
  assert.equal(srv.ss.name, '독서기록');
  assert.equal(claim.sheetUrl, 'https://docs.google.com/spreadsheets/d/FAKE/edit');
  const push = [
    { table: 'readers', rec: { id: 'r_kid1', name: '민준', slot: 0, updatedAt: 'T1' } },
    { table: 'books', rec: book('b_1', '구름빵') },
    { table: 'reads', rec: read('r1', 'b_1', 'r_kid1', '2026-10-01') },
  ];
  assert.equal(srv.post({ app: 'reading-log', op: 'sync', key: KEY, device: 'd_a', since: 0, push }).ok, true);
  assert.equal(srv.post({ app: 'reading-log', op: 'sync', key: KEY, device: 'd_b', since: 0, push: [] }).rows.length, 3);
  assert.equal(srv.created, 1, 'the same sheet is used again');
  const log = srv.ss.getSheetByName('독서기록').rows;
  assert.deepEqual(log[1].slice(1, 4), ['민준', '', '구름빵'], 'tabs rebuilt after a change, without opening the sheet');
});

test('server: notes and photos sync, and the 노트 tab lists them', () => {
  const srv = loadServer();
  srv.post({ app: 'reading-log', op: 'claim', key: KEY });
  const photo = `data:image/jpeg;base64,${'P'.repeat(150000)}`;
  const push = [
    { table: 'readers', rec: { id: 'r_kid1', name: '민준', slot: 0, updatedAt: 'T1' } },
    { table: 'books', rec: book('b_1', '공룡 백과') },
    { table: 'notes', rec: { id: 'n1', bookId: 'b_1', readerIds: ['r_kid1'], date: '2026-10-14', page: '12', text: '트리케라톱스는 뿔이 3개 #공룡',
      tags: ['공룡', '뿔'], area: 'nature', question: '트리케라톱스 뿔은 몇 개?', updatedAt: 'T1', createdAt: 'T1' } },
    { table: 'notes', rec: { id: 'n2', bookId: '', readerIds: ['r_kid1'], date: '2026-10-13', text: '-빨강 파랑 구분', tags: [], updatedAt: 'T1', createdAt: 'T1' } },
    { table: 'photos', rec: { id: 'p1', noteId: 'n1', data: photo, thumb: 'data:image/jpeg;base64,T', updatedAt: 'T1', createdAt: 'T1' } },
  ];
  const a = srv.post({ app: 'reading-log', op: 'sync', key: KEY, device: 'd_a', since: 0, push });
  assert.equal(a.protocol, 2);
  const b = srv.post({ app: 'reading-log', op: 'sync', key: KEY, device: 'd_b', since: 0, push: [] });
  assert.deepEqual(b.rows.map((r) => r.table), ['readers', 'books', 'notes', 'notes', 'photos']);
  assert.equal(b.rows[4].rec.data, photo, 'the photo comes back whole');
  const tab = srv.ss.getSheetByName('노트').rows;
  assert.deepEqual(tab[0], ['날짜', '누가', '책', '쪽', '내용', '태그', '영역', '확인 질문', '사진']);
  assert.deepEqual(tab[1].slice(1), ['민준', '공룡 백과', 12, '트리케라톱스는 뿔이 3개 #공룡', '#공룡 #뿔', '자연탐구', '트리케라톱스 뿔은 몇 개?', 1]);
  assert.equal(tab[2][4], '-빨강 파랑 구분', 'a leading minus stays text');
});

// ---------- two phones through the server ----------

// A tiny model of the app's store (ids, tombstones, outbox) around the real merge and server.
function phone(name, srv) {
  const st = emptyState();
  const outbox = new Set();
  let cursor = 0;
  const put = (t, x) => {
    st[t].set(x.id, x);
    outbox.add(`${t}:${x.id}`);
  };
  return {
    st,
    put,
    sync(now) {
      for (let i = 0; i < 20; i++) {
        const push = [...outbox].map((k) => {
          const [t, id] = k.split(':');
          return { table: t, rec: st[t].get(id) };
        });
        outbox.clear();
        const res = srv.post({ app: 'reading-log', op: 'sync', key: KEY, device: name, since: cursor, push });
        assert.equal(res.ok, true);
        const data = { books: [], reads: [], readers: [], meta: [], notes: [], photos: [] };
        for (const r of res.rows) data[r.table].push(r.rec);
        const { out, dirty } = planMerge(st, data, { now: now(), fromSync: true });
        apply(st, out);
        dirty.forEach((k) => outbox.add(k));
        cursor = res.cursor;
        if (!res.more && !outbox.size) return;
      }
      throw new Error('sync did not settle');
    },
  };
}

function rng(seed) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

test('two phones editing offline end up with the same records', () => {
  let merged = 0;
  let dupes = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const rand = rng(seed);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    let clock = 0;
    const now = () => `T${String(++clock).padStart(6, '0')}`;
    const srv = loadServer();
    srv.post({ app: 'reading-log', op: 'claim', key: KEY });
    const phones = [phone('d_mom', srv), phone('d_dad', srv)];
    const titles = ['구름빵', '마법천자문 1', 'Frog and Toad', '강아지똥'];
    let n = 0;

    for (let step = 0; step < 60; step++) {
      const p = pick(phones);
      const liveBooks = [...p.st.books.values()].filter((b) => !b.deletedAt);
      const op = rand();
      if (op < 0.3 || !liveBooks.length) {
        const u = now();
        const isbn = rand() < 0.3 ? `97889${String(Math.floor(rand() * 3)).padStart(8, '0')}` : '';
        const title = pick(titles);
        // The app reuses a shelf book with the same title, so a phone only makes a new one if it has none.
        const same = liveBooks.find((b) => (isbn ? b.isbn === isbn : !b.isbn && b.title === title));
        if (!same) p.put('books', book(isbn ? `isbn_${isbn}` : `b_${seed}_${++n}`, title, u, { isbn }));
      } else if (op < 0.75) {
        const u = now();
        p.put('reads', read(`r_${seed}_${++n}`, pick(liveBooks).id, pick(['r_kid1', 'r_kid2']), `2026-10-0${1 + Math.floor(rand() * 3)}`, u));
      } else if (op < 0.85) {
        const b = pick(liveBooks);
        const u = now();
        p.put('books', { ...b, deletedAt: u, updatedAt: u });
        for (const r of p.st.reads.values()) if (r.bookId === b.id && !r.deletedAt) p.put('reads', { ...r, deletedAt: u, updatedAt: u });
      } else if (op < 0.95) {
        const b = pick(liveBooks);
        p.put('books', { ...b, pages: Math.floor(rand() * 200), updatedAt: now() });
      } else {
        p.sync(now); // sometimes one phone syncs in the middle
      }
    }
    // Both phones sync until nothing changes.
    for (let i = 0; i < 4; i++) for (const p of phones) p.sync(now);

    const view = (st) => JSON.stringify({
      books: [...st.books.values()].filter((b) => !b.deletedAt).map((b) => [b.id, b.title, b.pages ?? null]).sort(),
      reads: [...st.reads.values()].filter((r) => !r.deletedAt).map((r) => [r.id, r.bookId, r.readerId, r.date]).sort(),
    });
    assert.equal(view(phones[0].st), view(phones[1].st), `seed ${seed}: phones differ`);
    const live = JSON.parse(view(phones[0].st));
    const titlesLive = live.books.filter((b) => !b[0].startsWith('isbn_')).map((b) => b[1]);
    assert.equal(new Set(titlesLive).size, titlesLive.length, `seed ${seed}: a title typed on both phones is still two books`);
    const sigs = live.reads.map((r) => r.slice(1).join('|'));
    assert.equal(new Set(sigs).size, sigs.length, `seed ${seed}: a duplicate read survived`);
    merged += [...phones[0].st.books.values()].filter((b) => b.mergedInto).length;
    const all = [...phones[0].st.reads.values()];
    dupes += all.filter((r) => r.deletedAt && all.some((x) => x !== r && !x.deletedAt && x.bookId === r.bookId
      && x.readerId === r.readerId && x.date === r.date)).length;
  }
  // The runs above must include the hard cases, or the test proves little.
  assert.ok(merged > 5, `twin books merged: ${merged}`);
  assert.ok(dupes > 5, `duplicate reads removed: ${dupes}`);
});
