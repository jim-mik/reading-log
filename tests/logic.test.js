// Unit tests for the pure logic (dates, ISBN, levels, stats, catalog merge).
// Run: node --test tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { weekStart, periodKey, periodRange, addDays, periodLabel, normTitle } from '../js/util.js';
import { toIsbn13, isValidIsbn13, levelFromSize, subjectFromAddCode, guessLang } from '../js/catalog.js';
import { timeSeries, headline, yearCount, topBooks, missingSize } from '../js/stats.js';
import { mergeHits } from '../js/lookup.js';

test('weeks start on Monday', () => {
  assert.equal(weekStart('2026-10-13'), '2026-10-12'); // Tuesday
  assert.equal(weekStart('2026-10-12'), '2026-10-12'); // Monday
  assert.equal(weekStart('2026-10-18'), '2026-10-12'); // Sunday
  assert.equal(weekStart('2026-01-01'), '2025-12-29'); // across a year
});

test('period keys and ranges', () => {
  assert.equal(periodKey('2026-10-13', 'month'), '2026-10');
  assert.equal(periodKey('2026-10-13', 'year'), '2026');
  assert.deepEqual(periodRange('2026-02-10', 'month', 3), ['2025-12', '2026-01', '2026-02']);
  assert.deepEqual(periodRange('2026-10-13', 'week', 2), ['2026-10-05', '2026-10-12']);
  assert.deepEqual(periodRange('2026-10-13', 'year', 3), ['2024', '2025', '2026']);
  assert.deepEqual(periodRange('2026-03-02', 'day', 3), ['2026-02-28', '2026-03-01', '2026-03-02']);
  assert.equal(periodKey('2026-10-13', 'day'), '2026-10-13');
  assert.equal(periodLabel('2026-10-13', 'day'), '13');
  assert.equal(periodLabel('2026-11-01', 'day'), '11/1');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(periodLabel('2026-01', 'month'), '26년 1월');
  assert.equal(periodLabel('2026-10', 'month'), '10월');
});

test('ISBN checks', () => {
  assert.equal(toIsbn13('978-0-439-70818-0'), '9780439708180');
  assert.equal(toIsbn13('0439708184'), '9780439708180'); // ISBN-10 -> 13
  assert.equal(toIsbn13('9780439708181'), null); // bad check digit
  assert.equal(toIsbn13('8801234567890'), null); // not a book (EAN, no 978/979)
  assert.ok(isValidIsbn13('9788949161075'));
  assert.ok(!isValidIsbn13('9788949161076'));
});

test('difficulty from size', () => {
  assert.equal(levelFromSize({ words: 600 }), 1);
  assert.equal(levelFromSize({ words: 12000, pages: 30 }), 3); // words win over pages
  assert.equal(levelFromSize({ pages: 32 }), 1);
  assert.equal(levelFromSize({ pages: 180 }), 4);
  assert.equal(levelFromSize({}), null);
});

test('subject from Korean ISBN add-on code', () => {
  assert.equal(subjectFromAddCode('77810'), 'lit'); // 아동 문학
  assert.equal(subjectFromAddCode('73410'), 'math'); // 아동 수학
  assert.equal(subjectFromAddCode('74400'), 'sci');
  assert.equal(subjectFromAddCode('73990'), 'bio'); // 전기
  assert.equal(subjectFromAddCode('73910'), 'soc'); // 역사
  assert.equal(subjectFromAddCode(''), null);
});

test('language guess and title matching', () => {
  assert.equal(guessLang('구름빵'), 'ko');
  assert.equal(guessLang('Magic Tree House #1'), 'en');
  assert.equal(guessLang('Why? 공룡'), 'ko');
  assert.equal(normTitle('Magic Tree House #1: Dinosaurs!'), normTitle('magic tree house 1 dinosaurs'));
});

const A = { id: 'a', title: 'A', lang: 'ko', subject: 'lit', level: 1, pages: 32, words: 0 };
const B = { id: 'b', title: 'B', lang: 'en', subject: 'sci', level: 3, pages: 0, words: 8000 };
const rows = [
  { date: '2026-10-13', readerId: 'k1', aloud: false, book: A },
  { date: '2026-10-12', readerId: 'k2', aloud: true, book: A },
  { date: '2026-10-05', readerId: 'k1', aloud: false, book: B },
  { date: '2026-09-30', readerId: 'k1', aloud: false, book: B },
  { date: '2025-12-31', readerId: 'k1', aloud: false, book: A },
];

test('time series by month and reader', () => {
  const { keys, table } = timeSeries(rows, { unit: 'month', count: 3, metric: 'books', by: 'reader', today: '2026-10-13' });
  assert.deepEqual(keys, ['2026-08', '2026-09', '2026-10']);
  assert.equal(table.get('2026-10').get('k1'), 2);
  assert.equal(table.get('2026-10').get('k2'), 1);
  assert.equal(table.get('2026-09').get('k1'), 1);
  assert.equal(table.get('2026-08').size, 0);
});

test('time series sums pages and words, groups by language', () => {
  const pages = timeSeries(rows, { unit: 'year', count: 2, metric: 'pages', by: 'lang', today: '2026-10-13' });
  assert.equal(pages.table.get('2026').get('ko'), 64);
  assert.equal(pages.table.get('2025').get('ko'), 32);
  const words = timeSeries(rows, { unit: 'week', count: 2, metric: 'words', by: 'aloud', today: '2026-10-13' });
  assert.equal(words.table.get('2026-10-05').get('self'), 8000);
  assert.equal(words.table.get('2026-10-12').get('aloud'), 0);
});

test('headline totals and helpers', () => {
  assert.deepEqual(headline(rows, 'books', '2026-10-13'), { today: 1, week: 2, month: 3, year: 4, all: 5 });
  assert.equal(yearCount(rows, '2026-10-13'), 3);
  assert.equal(topBooks(rows)[0].book.id, 'a');
  assert.equal(missingSize(rows, 'pages'), 1);
  assert.equal(missingSize(rows, 'books'), 0);
});

test('catalog merge prefers the right source per field', () => {
  const m = mergeHits([
    { source: 'openlibrary', title: 'OL title', pages: 40, cover: 'ol.jpg' },
    { source: 'kakao', title: '카카오 제목', authors: '홍길동', cover: 'kakao.jpg' },
    { source: 'nl', title: 'NL', pages: 36, subject: 'lit' },
  ]);
  assert.equal(m.title, '카카오 제목');
  assert.equal(m.cover, 'kakao.jpg');
  assert.equal(m.pages, 36);
  assert.equal(m.subject, 'lit');
  assert.equal(m.lang, 'ko');
});
