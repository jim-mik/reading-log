// 우리집 독서기록 - family sync server, a Google Apps Script web app that keeps the records in a Google Sheet.
//
// Install (once, on a PC), either way:
//   - in a Google Sheet: 확장 프로그램 → Apps Script, or
//   - at script.google.com → 새 프로젝트 (the script then makes a "독서기록" sheet in My Drive on first use);
// then replace Code.gs with this file → 배포 → 새 배포 → 웹 앱 (실행: 나, 액세스 권한: 모든 사용자) →
// paste the web app URL into the app's 설정 → 가족 동기화. After editing this code, use 배포 관리 →
// 수정 → 새 버전, not 새 배포, so the URL stays the same.
//
// How it works: each record a phone changes is appended to the hidden "_log" tab as a new row, and
// each phone pulls the rows added since the last row it saw (its cursor). Old rows are never edited:
// the phones settle conflicts themselves (newer updatedAt wins). The readable 독서기록 and 책장 tabs
// are rebuilt from the log after each change and when the spreadsheet is opened.

const PROTOCOL = 1;
const LOG = '_log';
const LOG_HEAD = ['받은 시각', '폰', '종류', 'id', 'updatedAt', '삭제', '요약', '기록'];
const BODY_COL = 8; // the record's JSON starts here, split over as many cells as it needs
const CELL = 45000; // a cell holds at most 50,000 characters
const PULL_ROWS = 2000; // log rows read per request
const PULL_CHARS = 3000000; // characters sent back per response
const TABLES = ['books', 'reads', 'readers', 'meta'];
// Fields copied to the 요약 column, enough to rebuild the readable tabs without the full JSON.
const SUMMARY = {
  books: ['title', 'authors', 'publisher', 'isbn', 'lang', 'subject', 'level', 'pages', 'words'],
  reads: ['bookId', 'readerId', 'date', 'aloud'],
  readers: ['name', 'kind', 'slot'],
  meta: ['value'],
};
const LANG = { ko: '한국어', en: '영어', etc: '기타' };
const LEVEL = { 1: '1 그림책', 2: '2 쉬운 읽기책', 3: '3 초기 챕터북', 4: '4 챕터북·동화', 5: '5 소설·지식책' };
const DEFAULT_SUBJECTS = [
  { key: 'lit', label: '문학·동화' }, { key: 'lang', label: '언어(한글·영어)' }, { key: 'math', label: '수학' },
  { key: 'sci', label: '과학' }, { key: 'soc', label: '사회·역사' }, { key: 'comic', label: '학습만화' },
  { key: 'bio', label: '인물' }, { key: 'art', label: '예술' }, { key: 'life', label: '생활·인성' }, { key: 'etc', label: '기타' },
];

function doGet() {
  return ContentService.createTextOutput('독서기록 동기화 서버가 켜져 있어요. 이 주소를 앱의 설정 → 가족 동기화에 붙여 넣으세요.');
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  let out;
  try {
    lock.waitLock(30000);
    const props = PropertiesService.getScriptProperties();
    out = handle(JSON.parse(e.postData.contents), spreadsheet(props), props);
  } catch (err) {
    out = { ok: false, error: 'server', message: String((err && err.message) || err) };
  } finally {
    lock.releaseLock();
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// The sheet this script is attached to, or for a script made at script.google.com, a sheet of its own.
function spreadsheet(props) {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  const id = props.getProperty('sheetId');
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.create('독서기록');
  props.setProperty('sheetId', ss.getId());
  return ss;
}

// req: {app, op: 'claim' | 'sync', key, device, since, push: [{table, rec}]}
function handle(req, ss, props) {
  if (!req || req.app !== 'reading-log') return { ok: false, error: 'bad-request' };
  if (typeof req.key !== 'string' || req.key.length < 20) return { ok: false, error: 'key' };
  const saved = props.getProperty('familyKey');
  const base = { ok: true, protocol: PROTOCOL, sheetUrl: ss.getUrl() };

  // The first phone to connect sets the family key; other phones join with the same key.
  if (req.op === 'claim') {
    if (!saved) props.setProperty('familyKey', req.key);
    else if (saved !== req.key) return { ok: false, error: 'taken' };
    return base;
  }
  if (req.key !== saved) return { ok: false, error: 'key' };
  if (req.op !== 'sync' || !/^[\w-]{1,64}$/.test(req.device || '')) return { ok: false, error: 'bad-request' };

  const sheet = logSheet(ss, props);
  if (append(sheet, req.device, Array.isArray(req.push) ? req.push : [])) {
    try {
      buildTables(ss);
    } catch (err) {
      // the readable tabs are a convenience; sync goes on without them
    }
  }
  return Object.assign(base, { logId: props.getProperty('logId') }, pull(sheet, req.device, Number(req.since) || 0));
}

// A new log gets a new id, so phones notice a deleted log and send all their records again.
function logSheet(ss, props) {
  let sheet = ss.getSheetByName(LOG);
  if (!sheet) {
    sheet = ss.insertSheet(LOG);
    sheet.getRange(1, 1, 1, LOG_HEAD.length).setValues([LOG_HEAD]);
    sheet.setFrozenRows(1);
    try {
      sheet.hideSheet();
    } catch (err) {
      // the only visible tab can't be hidden; it still works
    }
    props.setProperty('logId', Utilities.getUuid());
  }
  if (!props.getProperty('logId')) props.setProperty('logId', Utilities.getUuid());
  return sheet;
}

function append(sheet, device, push) {
  const now = new Date();
  const rows = [];
  for (const item of push) {
    const rec = item && item.rec;
    const id = rec && (item.table === 'meta' ? rec.key : rec.id);
    if (TABLES.indexOf(item && item.table) < 0 || typeof id !== 'string' || !id) continue;
    const summary = {};
    for (const f of SUMMARY[item.table]) if (rec[f] !== undefined) summary[f] = rec[f];
    rows.push([now, text(device), item.table, text(id), text(String(rec.updatedAt || '')), rec.deletedAt ? 'Y' : '',
      text(JSON.stringify(summary).slice(0, CELL))].concat(cells(JSON.stringify(rec))));
  }
  if (!rows.length) return 0;
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  for (const r of rows) while (r.length < width) r.push('');
  const first = sheet.getLastRow() + 1;
  fit(sheet, first + rows.length - 1, width);
  sheet.getRange(first, 1, rows.length, width).setValues(rows);
  return rows.length;
}

// Rows after `since` that other phones wrote. cursor = the last row looked at.
function pull(sheet, device, since) {
  const last = sheet.getLastRow();
  const from = (since > last ? 1 : Math.max(1, since)) + 1; // a cursor past the end means the log shrank: start over
  if (from > last) return { cursor: last, more: false, rows: [] };
  const values = sheet.getRange(from, 1, Math.min(last - from + 1, PULL_ROWS), sheet.getLastColumn()).getValues();
  const rows = [];
  let chars = 0;
  let cursor = from - 1;
  for (const v of values) {
    if (chars >= PULL_CHARS) break;
    cursor++;
    if (untext(v[1]) === device) continue;
    let json = '';
    for (let c = BODY_COL - 1; c < v.length && v[c] !== ''; c++) json += untext(v[c]);
    try {
      rows.push({ table: v[2], rec: JSON.parse(json) });
      chars += json.length;
    } catch (err) {
      // a damaged row is skipped
    }
  }
  return { cursor, more: cursor < last, rows };
}

// ---- readable tabs ----

function onOpen() {
  SpreadsheetApp.getUi().createMenu('독서기록').addItem('표 새로 고침', 'refreshTables').addToUi();
  refreshTables();
}

function refreshTables() {
  buildTables(spreadsheet(PropertiesService.getScriptProperties()));
}

function buildTables(ss) {
  const latest = { books: {}, reads: {}, readers: {}, meta: {} };
  const sheet = ss.getSheetByName(LOG);
  if (sheet && sheet.getLastRow() > 1) {
    for (const v of sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues()) {
      const t = v[2];
      const id = untext(v[3]);
      const u = untext(v[4]);
      if (!latest[t] || (latest[t][id] && latest[t][id].u > u)) continue;
      let s = {};
      try {
        s = JSON.parse(untext(v[6]));
      } catch (err) {
        // keep the empty summary
      }
      latest[t][id] = { u, deleted: v[5] === 'Y', s };
    }
  }
  const live = (t) => Object.keys(latest[t]).filter((id) => !latest[t][id].deleted)
    .map((id) => Object.assign({ id }, latest[t][id].s));
  const books = {};
  for (const b of live('books')) books[b.id] = b;
  const readers = {};
  for (const r of live('readers')) readers[r.id] = r;
  const subjects = {};
  const custom = latest.meta.subjects;
  for (const s of (custom && !custom.deleted && custom.s.value) || DEFAULT_SUBJECTS) subjects[s.key] = s.label;

  const reads = live('reads').filter((r) => books[r.bookId] && readers[r.readerId])
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const bookCols = (b) => [b.title, b.authors, b.publisher, b.isbn ? `'${b.isbn}` : '', LANG[b.lang] || '',
    b.subject ? subjects[b.subject] || '기타' : '', LEVEL[b.level] || '', b.pages || '', b.words || ''];

  writeTable(ss, '독서기록', ['날짜', '읽은 사람', '읽어 줌', '제목', '지은이', '출판사', 'ISBN', '언어', '과목', '난이도', '쪽수', '단어 수'],
    reads.map((r) => [r.date, readers[r.readerId].name, r.aloud ? 'O' : ''].concat(bookCols(books[r.bookId]))));

  const per = {};
  for (const r of reads) {
    const s = per[r.bookId] || (per[r.bookId] = { n: 0, first: r.date, last: r.date, who: {} });
    s.n++;
    if (r.date < s.first) s.first = r.date;
    if (r.date > s.last) s.last = r.date;
    s.who[r.readerId] = true;
  }
  const shelf = Object.keys(books).map((id) => books[id]).sort((a, b) => String(a.title).localeCompare(String(b.title), 'ko'));
  writeTable(ss, '책장', ['제목', '지은이', '출판사', 'ISBN', '언어', '과목', '난이도', '쪽수', '단어 수', '읽은 횟수', '처음 읽은 날', '마지막 읽은 날', '읽은 사람'],
    shelf.map((b) => {
      const s = per[b.id];
      const who = s ? Object.keys(s.who).sort((x, y) => (readers[x].slot || 0) - (readers[y].slot || 0)).map((id) => readers[id].name) : [];
      return bookCols(b).concat(s ? [s.n, s.first, s.last, who.join(', ')] : [0, '', '', '']);
    }));
}

function writeTable(ss, name, head, rows) {
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clearContents();
  const values = [head].concat(rows).map((r) => r.map(cellText));
  fit(sheet, values.length, head.length);
  sheet.getRange(1, 1, values.length, head.length).setValues(values);
  sheet.setFrozenRows(1);
}

// ---- cell helpers ----

// Log cells start with "|" so Sheets never reads them as a number, date or formula.
function text(s) {
  return `|${s}`;
}

function untext(v) {
  return typeof v === 'string' && v[0] === '|' ? v.slice(1) : String(v);
}

// Text for the readable tabs: a leading = + - @ would be taken as a formula.
function cellText(v) {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v == null ? '' : v;
}

// Splits a long string over cells, never between the two halves of an emoji.
function cells(s) {
  const out = [];
  let i = 0;
  do {
    let j = Math.min(i + CELL, s.length);
    if (j < s.length && /[\uD800-\uDBFF]/.test(s[j - 1])) j--;
    out.push(text(s.slice(i, j)));
    i = j;
  } while (i < s.length);
  return out;
}

function fit(sheet, rows, cols) {
  if (rows > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  if (cols > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), cols - sheet.getMaxColumns());
}
