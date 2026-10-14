// Family sync through a Google Sheet. The sheet runs sync/apps-script.js as an Apps Script web app.
// Each round sends what waits in the store's outbox and pulls the records other phones sent since
// this phone's cursor; merge.js settles conflicts the same way on every phone.
// Runs when the app opens or comes back to the screen, shortly after each change, when the
// phone gets back online, and every few minutes while the app is open.

import * as store from './store.js';
import { settings, updateSettings } from './settings.js';
import { uid, nowIso, debounce } from './util.js';

const PROTOCOL = 1;
const PUSH_LIMIT = 150; // records per request
const PUSH_CHARS = 2000000; // about 2 MB of JSON per request
const EVERY = 3 * 60 * 1000;

export const linked = () => !!(settings().syncUrl && settings().syncKey);

// ---- status, for the settings card ----

let status = { state: 'idle', message: '' };
const statusListeners = new Set();
export const syncStatus = () => status;
export function onStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}
function setStatus(state, message = '') {
  status = { state, message };
  statusListeners.forEach((fn) => fn(status));
}

// Something to show on the home screen when sync has been failing for a day.
export function problem() {
  const s = settings();
  if (!linked() || !s.syncError) return '';
  const lastOk = s.syncAt ? Date.parse(s.syncAt) : 0;
  return Date.now() - lastOk > 24 * 3600 * 1000 ? s.syncError : '';
}

// ---- server calls ----

class SyncError extends Error {
  constructor(message, offline = false) {
    super(message);
    this.offline = offline;
  }
}

const ERRORS = {
  key: '연결 코드가 맞지 않아요. 설정 → 가족 동기화에서 다시 연결해 주세요.',
  taken: '이미 다른 폰이 연결된 주소예요. 그 폰의 "다른 폰 연결하기"로 받은 연결 코드를 붙여 넣어 주세요.',
  'bad-request': '서버가 요청을 이해하지 못했어요. 구글 시트의 Apps Script 코드를 새 버전으로 바꿔 주세요.',
};

async function call(url, body) {
  let res;
  try {
    // A plain-text body keeps this a "simple" request (no CORS preflight, which Apps Script can't
    // answer). Apps Script replies through a redirect to googleusercontent.com, which allows CORS.
    res = await fetch(url, { method: 'POST', body: JSON.stringify({ app: 'reading-log', protocol: PROTOCOL, ...body }) });
  } catch {
    throw new SyncError('인터넷에 연결되면 보낼게요.', true);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new SyncError(`동기화 서버가 이상한 응답을 보냈어요 (${res.status}). 주소가 맞는지 확인해 주세요.`);
  }
  if (!data.ok) throw new SyncError(ERRORS[data.error] || `동기화 서버 오류: ${data.message || data.error}`);
  if (data.protocol < PROTOCOL) throw new SyncError(ERRORS['bad-request']);
  return data;
}

// "https://script.google.com/macros/s/…/exec" (first phone), or that plus "#key=…" (a connection code).
export function parseLink(text) {
  let url;
  try {
    url = new URL(String(text).trim());
  } catch {
    throw new Error('주소를 읽을 수 없어요. "https://script.google.com/"으로 시작하는 주소를 붙여 넣어 주세요.');
  }
  if (url.hostname !== 'script.google.com' || !/^\/(a\/macros\/[^/]+|macros)\/s\/[\w-]+\/exec$/.test(url.pathname)) {
    throw new Error(url.pathname.endsWith('/dev')
      ? '테스트용 주소(/dev)예요. 배포 → 배포 관리에서 "/exec"로 끝나는 웹 앱 주소를 복사해 주세요.'
      : 'Apps Script 웹 앱 주소가 아니에요. "/exec"로 끝나는 주소를 붙여 넣어 주세요.');
  }
  const key = new URLSearchParams(url.hash.slice(1)).get('key') || '';
  return { url: `${url.origin}${url.pathname}`, key };
}

// The code another phone pastes to join.
export const connectionCode = () => `${settings().syncUrl}#key=${settings().syncKey}`;

function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function connect(text) {
  const { url, key: given } = parseLink(text);
  let key = given;
  if (!key) {
    // The first phone keeps its new key before asking: if Google's reply gets lost after the key was
    // saved on the sheet, pressing 연결 again sends the same key instead of being told "taken".
    const pending = settings().syncPending;
    key = pending?.url === url ? pending.key : newKey();
    updateSettings({ syncPending: { url, key } });
  }
  const res = await call(url, { op: 'claim', key });
  updateSettings({
    syncUrl: url, syncKey: key, syncDevice: settings().syncDevice || uid('d'), syncCursor: 0, syncLogId: '',
    syncAt: '', syncError: '', syncSheetUrl: res.sheetUrl || '', syncPending: null,
  });
  await store.queueAll(); // everything this phone has goes to the sheet
  return syncNow();
}

export function disconnect() {
  updateSettings({ syncUrl: '', syncKey: '', syncCursor: 0, syncLogId: '', syncAt: '', syncError: '', syncSheetUrl: '' });
  setStatus('idle');
}

// ---- one sync round ----

let running = null;
let again = false;

export function syncNow() {
  if (!linked()) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    setStatus('busy');
    try {
      do {
        again = false;
        await round();
      } while (again);
      updateSettings({ syncAt: nowIso(), syncError: '' });
      setStatus('ok');
    } catch (e) {
      if (!(e instanceof SyncError) || !e.offline) updateSettings({ syncError: e.message });
      setStatus(e.offline ? 'offline' : 'error', e.message);
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

async function round() {
  for (let i = 0; i < 500; i++) {
    const s = settings();
    const batch = await store.outbox(PUSH_LIMIT, PUSH_CHARS);
    const res = await call(s.syncUrl, { op: 'sync', key: s.syncKey, device: s.syncDevice, since: s.syncCursor, push: batch });
    await store.sent(batch);

    // A new log on the server (the old one was deleted): send everything again and read it from the top.
    if (s.syncLogId && res.logId !== s.syncLogId) {
      updateSettings({ syncLogId: res.logId, syncCursor: 0 });
      await store.queueAll();
      continue;
    }
    if (res.rows.length) {
      const data = { books: [], reads: [], readers: [], meta: [] };
      for (const { table, rec } of res.rows) data[table]?.push(rec);
      await store.mergeIn(data, { fromSync: true });
    }
    updateSettings({ syncCursor: res.cursor, syncLogId: res.logId, syncSheetUrl: res.sheetUrl || s.syncSheetUrl });
    if (!res.more && !(await store.outboxSize())) return;
  }
}

// ---- when to sync ----

export function start() {
  // Local data gone (site data cleared) but the link kept: read everything again.
  if (linked() && !store.books().length && !store.reads().length && settings().syncCursor) {
    updateSettings({ syncCursor: 0 });
  }
  store.onOutbox(debounce(() => syncNow(), 1500));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && syncNow());
  window.addEventListener('online', () => syncNow());
  setInterval(() => document.visibilityState === 'visible' && syncNow(), EVERY);
  syncNow();
}
