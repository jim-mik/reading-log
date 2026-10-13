// Per-phone settings (API keys, choices). Kept in localStorage, never in backups.

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
