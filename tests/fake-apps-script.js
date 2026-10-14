// Runs sync/apps-script.js in Node against an in-memory stand-in for Google Sheets, for the tests.
// The fake converts written text the way Sheets does (numbers, dates, formulas, a leading '),
// enforces the 50,000-character cell limit and the sheet's size, so the script's text
// protection and resizing are actually exercised.

import fs from 'node:fs';
import vm from 'node:vm';

const CODE = fs.readFileSync(new URL('../sync/apps-script.js', import.meta.url), 'utf8');

// What Sheets keeps for a value written with setValues.
function stored(v) {
  if (typeof v !== 'string') return v;
  if (v.length > 50000) throw new Error('Your input contains more than the maximum of 50000 characters in a single cell.');
  if (v.startsWith("'")) return v.slice(1);
  if (/^[=+\-@]/.test(v) && v.length > 1) return { formula: v };
  if (/^-?\d+(\.\d+)?(e\d+)?$/i.test(v)) return Number(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return { date: v };
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  return v;
}

class Sheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
    this.maxRows = 1000;
    this.maxCols = 26;
    this.hidden = false;
  }
  getName() { return this.name; }
  getLastRow() {
    for (let r = this.rows.length; r > 0; r--) if ((this.rows[r - 1] || []).some((v) => v !== '')) return r;
    return 0;
  }
  getLastColumn() {
    return this.rows.reduce((w, row) => Math.max(w, row ? row.reduce((c, v, i) => (v !== '' ? i + 1 : c), 0) : 0), 0);
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(after, n) { this.maxRows += n; }
  insertColumnsAfter(after, n) { this.maxCols += n; }
  setFrozenRows() {}
  hideSheet() { this.hidden = true; }
  clearContents() { this.rows = []; }
  getRange(row, col, nr, nc) {
    if (row < 1 || col < 1 || nr < 1 || nc < 1 || row + nr - 1 > this.maxRows || col + nc - 1 > this.maxCols) {
      throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    }
    const sheet = this;
    return {
      getValues() {
        const out = [];
        for (let r = 0; r < nr; r++) {
          const src = sheet.rows[row - 1 + r] || [];
          const line = [];
          for (let c = 0; c < nc; c++) line.push(src[col - 1 + c] ?? '');
          out.push(line);
        }
        return out;
      },
      setValues(values) {
        if (values.length !== nr || values.some((v) => v.length !== nc)) throw new Error('The number of rows or columns does not match.');
        const conv = values.map((line) => line.map(stored));
        conv.forEach((line, r) => {
          const target = (sheet.rows[row - 1 + r] ||= []);
          line.forEach((v, c) => {
            while (target.length < col - 1 + c) target.push('');
            target[col - 1 + c] = v;
          });
        });
        for (let r = 0; r < sheet.rows.length; r++) sheet.rows[r] ||= [];
      },
    };
  }
}

class Spreadsheet {
  constructor() { this.sheets = new Map([['시트1', new Sheet('시트1')]]); }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  insertSheet(name) {
    const s = new Sheet(name);
    this.sheets.set(name, s);
    return s;
  }
  deleteSheet(sheet) { this.sheets.delete(sheet.name); }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/FAKE/edit'; }
}

export function loadServer() {
  const ss = new Spreadsheet();
  const props = new Map();
  let uuid = 0;
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => ({ createMenu: () => ({ addItem() { return this; }, addToUi() {} }) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { getUuid: () => `log-${++uuid}` },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
  });
  vm.runInContext(CODE, context);
  return {
    ss,
    props,
    post: (body) => JSON.parse(context.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text),
    get: () => context.doGet().text,
    open: () => context.onOpen(),
  };
}
