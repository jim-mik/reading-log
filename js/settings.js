// Per-phone settings (API keys, choices, the family sync link). Kept in localStorage, never in backups.

const KEY = 'reading-log-settings';

const DEFAULTS = {
  kakaoKey: '',
  nlKey: '',
  googleKey: '',
  claudeKey: '',
  claudeModel: 'claude-opus-5-5',
  lastReaderIds: [],
  lastAloud: false,
  lastBackupAt: '',
  // family sync (sync.js)
  syncUrl: '',
  syncKey: '',
  syncDevice: '',
  syncCursor: 0,
  syncLogId: '',
  syncAt: '',
  syncError: '',
  syncSheetUrl: '',
  syncPending: null, // {url, key} while the first phone is connecting
  syncProtocol: 0, // the sheet script's protocol; 1 doesn't take notes
  syncNotesWaiting: false,
  lastNoteReaderIds: [],
};

let cache;

export function settings() {
  if (!cache) {
    try {
      cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
    } catch {
      cache = { ...DEFAULTS };
    }
  }
  return cache;
}

export function updateSettings(patch) {
  Object.assign(settings(), patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Private mode or storage blocked: settings live for this session only.
  }
}
