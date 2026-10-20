// Book recognition helpers: subject/tags from titles, cover-title matching, 전집 ISBN neighbors.
// Run: node --test tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../js/classify.js';
import { subjectFromKdc, subjectFromAddCode } from '../js/catalog.js';
import { titleFits } from '../js/lookup.js';
import { DEFAULT_SUBJECTS } from '../js/catalog.js';
import * as store from '../js/store.js';

test('subject and topic tags from a title or 전집 name', () => {
  const c = (title, series = '') => classify({ title, series }, DEFAULT_SUBJECTS);
  assert.deepEqual(c('수학특공대 12'), { subject: 'math', tags: [] });
  assert.deepEqual(c('과학공룡 3: 티라노사우루스'), { subject: 'sci', tags: ['공룡'] });
  assert.deepEqual(c('화가 나요', '안녕, 마음아 7'), { subject: 'life', tags: ['감정'] });
  assert.deepEqual(c('명작 동화 백설공주'), { subject: 'lit', tags: ['명작'] });
  assert.deepEqual(c('마법천자문 1'), { subject: 'lang', tags: ['한자'] });
  assert.deepEqual(c('우리 몸의 비밀'), { subject: 'sci', tags: ['몸'] });
  assert.deepEqual(c('Magic Tree House: Dinosaurs Before Dark'), { subject: 'sci', tags: ['공룡'] });
  assert.deepEqual(c('Scary Stories'), { subject: null, tags: [] }, 'English words match at a word start only (no "car" in "Scary")');
  assert.deepEqual(c('구름빵'), { subject: null, tags: [] });
  assert.equal(classify({ title: '수학특공대' }, [{ key: 'lit' }]).subject, null, 'only subjects the family has');
});

test('a cover title fits a catalog title', () => {
  assert.ok(titleFits('구름빵', '구름빵'));
  assert.ok(titleFits('마법의 시간여행 1', '마법의 시간여행 1: 공룡시대로 가다', false), 'the catalog title may be longer');
  assert.ok(!titleFits('안녕, 마음아 12 화가 나요', '안녕, 마음아', false), 'a 전집 volume is not the single book with the set name');
  assert.ok(titleFits('안녕, 마음아 12 화가 나요', '안녕, 마음아', true), 'unless the author matches too');
  assert.ok(!titleFits('곰', '곰돌이 푸', false), 'too short to match by containment');
});

test('book by ISBN and the nearest 전집 volume by ISBN', () => {
  const put = (b) => store.state.books.set(b.id, { createdAt: 'T', updatedAt: 'T', ...b });
  put({ id: 'isbn_9791190898874', isbn: '9791190898874', title: '안녕, 마음아 1', series: '안녕, 마음아 1' });
  put({ id: 'b_typed', isbn: '9791190898881', title: '안녕, 마음아 2' });
  put({ id: 'isbn_9788993242188', isbn: '9788993242188', title: '다른 출판사' });
  assert.equal(store.bookByIsbn('9791190898874').id, 'isbn_9791190898874');
  assert.equal(store.bookByIsbn('9791190898881').id, 'b_typed', 'an ISBN typed in later is found by the field');
  assert.equal(store.bookByIsbn('9791190898898'), null);
  assert.equal(store.nearestByIsbn('9791190898898').id, 'b_typed', 'the closest number from the same block');
  assert.equal(store.nearestByIsbn('9791190899999'), null, 'too far away');
  assert.equal(store.nearestByIsbn('9788993242195').id, 'isbn_9788993242188');
  assert.equal(store.nearestByIsbn('9788800000000'), null);
  store.state.books.clear();
});

test('KDC and add-on code map to a subject', () => {
  assert.equal(subjectFromKdc('863'), 'lit'); // 문학 > 프랑스문학 > 소설
  assert.equal(subjectFromKdc('813.8'), 'lit'); // decimal KDC
  assert.equal(subjectFromKdc('411'), 'math'); // 수학
  assert.equal(subjectFromKdc('404'), 'sci');
  assert.equal(subjectFromKdc('991'), 'bio'); // 전기
  assert.equal(subjectFromKdc('598'), 'life'); // 가정학 > 육아
  assert.equal(subjectFromKdc('707'), 'lang');
  assert.equal(subjectFromKdc(''), null);
  // add-on code: reader group(2) + 3-digit KDC.
  assert.equal(subjectFromAddCode('73860'), 'lit'); // 863
  assert.equal(subjectFromAddCode('74410'), 'math'); // 410
  assert.equal(subjectFromAddCode('1234'), null);
});
