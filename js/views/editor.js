// "책 기록하기": find a book (barcode, photo, or title autocomplete), check its
// details, pick who read it and when, save.
//   mode 'record' - book + reading records (default)
//   mode 'edit'   - book details only
//   start         - 'scan' | 'photo' to jump straight into the camera

import { h, clear, todayStr, debounce, normTitle, addDays } from '../util.js';
import { LANGS, LEVELS, levelFromSize, toIsbn13, guessLang } from '../catalog.js';
import * as store from '../store.js';
import { settings, updateSettings } from '../settings.js';
import { lookupIsbn, searchTitle, bestTitleMatch } from '../lookup.js';
import { readBook, hasClaude } from '../ai.js';
import { canScanLive, findIsbn, preparePhoto, pickPhoto } from '../media.js';
import { openScanner } from './scanner.js';
import { openOverlay, closeOverlay, toast, chipGroup, cover, icon, readerColor, bookBadges } from '../ui.js';

const EMPTY = {
  isbn: '', title: '', authors: '', publisher: '', pubDate: '', lang: null, subject: null,
  level: null, levelTag: '', pages: null, words: null, cover: '', note: '',
};
const IDENTITY = ['isbn', 'title', 'authors', 'publisher', 'pubDate', 'cover'];
const DETAILS = ['lang', 'subject', 'pages', 'words'];

export function openEditor({ bookId = null, mode = 'record', start = null, shelfOnly = false } = {}) {
  const existing = bookId ? store.getBook(bookId) : null;
  const liveReaderIds = new Set(store.readers().map((r) => r.id));
  const st = {
    bookId: existing?.id ?? null,
    book: { ...EMPTY, ...(existing || {}) },
    touched: new Set(existing ? Object.keys(EMPTY).filter((k) => existing[k]) : []),
    levelFrom: existing?.level ? 'saved' : null, // user | ai | size | saved
    description: '',
    readerIds: shelfOnly ? [] : (settings().lastReaderIds || []).filter((id) => liveReaderIds.has(id)),
    dates: [todayStr()],
    aloud: !!settings().lastAloud,
    busy: false,
  };
  const ui = {};

  // ---------- status line ----------

  const setStatus = (text, kind = 'info') => {
    ui.status.hidden = !text;
    ui.status.className = `status ${kind}`;
    ui.status.textContent = text || '';
  };

  // ---------- filling fields ----------

  // force: the user picked this book (scan, photo, suggestion) - replace identity fields.
  // Otherwise only empty, untouched fields are filled.
  function fill(data, { force = false } = {}) {
    // A different book than before (e.g. a second scan): drop details that came from the first one.
    if (force && data.isbn && st.book.isbn && data.isbn !== st.book.isbn) {
      for (const k of DETAILS) if (!st.touched.has(k)) st.book[k] = EMPTY[k];
      if (['size', 'ai'].includes(st.levelFrom)) {
        st.book.level = null;
        st.levelFrom = null;
      }
      st.description = '';
    }
    for (const k of [...IDENTITY, ...DETAILS]) {
      const v = data[k];
      if (v == null || v === '' || v === 0) continue;
      const replace = force && IDENTITY.includes(k);
      if (!replace && (st.touched.has(k) || st.book[k])) continue;
      st.book[k] = v;
      if (replace) st.touched.delete(k);
    }
    autoLevel();
    paint();
  }

  function autoLevel() {
    if (['user', 'saved', 'ai'].includes(st.levelFrom)) return;
    const lv = levelFromSize(st.book);
    if (lv) {
      st.book.level = lv;
      st.levelFrom = 'size';
    }
  }

  function applyAi(ai) {
    fill({ lang: ai.language, subject: ai.subject, pages: ai.pages || null, words: ai.words || null });
    if (ai.level && !['user', 'saved'].includes(st.levelFrom)) {
      st.book.level = ai.level;
      st.levelFrom = 'ai';
    }
    paint();
  }

  function useExisting(book) {
    ui.title.blur();
    st.bookId = book.id;
    st.book = { ...EMPTY, ...book };
    st.touched = new Set(Object.keys(EMPTY).filter((k) => book[k]));
    st.levelFrom = book.level ? 'saved' : null;
    hideSuggest();
    setCompact(mode === 'record');
    paint();
    setStatus('이미 책장에 있는 책이에요. 누가 언제 읽었는지만 고르면 돼요.', 'ok');
  }

  // ---------- finding a book ----------

  async function handleIsbn(isbn, thumb) {
    const mine = store.getBook(`isbn_${isbn}`);
    if (mine && !st.bookId) {
      useExisting(mine);
      return true;
    }
    setStatus('책 정보를 찾는 중…', 'busy');
    const hit = await lookupIsbn(isbn).catch(() => null);
    if (!hit) {
      fill({ isbn, cover: thumb }, { force: true });
      setStatus(`ISBN ${isbn}로 책 정보를 찾지 못했어요. 제목을 직접 입력해 주세요.${settings().kakaoKey ? '' : ' (설정에서 카카오 키를 넣으면 한국 책을 훨씬 잘 찾아요)'}`, 'error');
      return false;
    }
    fill(hit, { force: true });
    if (thumb && !st.book.cover) fill({ cover: thumb });
    st.description = hit.description || '';
    setStatus(`찾았어요: ${hit.title}`, 'ok');
    return true;
  }

  // New book found: let AI suggest subject/level if those are still empty.
  async function autoClassify() {
    if (!hasClaude() || settings().aiAuto === false || st.bookId) return;
    if (st.book.subject && st.book.level && st.levelFrom !== 'size') return;
    await aiFill({ quiet: true });
  }

  async function scan() {
    if (!canScanLive()) {
      toast('이 브라우저는 실시간 바코드 스캔이 안 돼서 사진으로 찍어요');
      return photo(true);
    }
    const result = await openScanner();
    if (result === 'photo') return photo(true);
    if (result && (await handleIsbn(result))) await autoClassify();
  }

  async function photo(camera) {
    const wasNew = !st.bookId;
    const file = await pickPhoto({ camera });
    if (!file) return;
    setStatus('사진을 살펴보는 중…', 'busy');
    let p;
    try {
      p = await preparePhoto(file);
    } catch {
      setStatus('사진을 열 수 없어요. 다시 찍어 주세요.', 'error');
      return;
    }
    const isbn = await findIsbn(p.bitmap);
    if (isbn) {
      if (await handleIsbn(isbn, p.thumb)) await autoClassify();
      return;
    }
    if (!hasClaude()) {
      fill({ cover: p.thumb }, { force: true });
      setStatus('사진에서 바코드를 찾지 못했어요. 뒷면 바코드를 찍거나 제목을 입력해 주세요. (설정에서 Claude API 키를 넣으면 표지만 찍어도 찾아 드려요)', 'error');
      return;
    }
    setStatus('AI가 사진을 읽는 중… (10초쯤 걸려요)', 'busy');
    try {
      const ai = await readBook({ image: p.base64 });
      if (!ai.found || !ai.title) {
        setStatus('사진에서 책을 찾지 못했어요. 다시 찍거나 직접 입력해 주세요.', 'error');
        return;
      }
      let found = false;
      const aiIsbn = toIsbn13(ai.isbn);
      if (aiIsbn) found = await handleIsbn(aiIsbn, p.thumb);
      if (wasNew && st.bookId) return; // it was already on the shelf
      if (!found) {
        setStatus('책 정보를 찾는 중…', 'busy');
        const match = await bestTitleMatch(ai.title, ai.authors);
        if (match?.isbn && store.getBook(`isbn_${match.isbn}`)) return useExisting(store.getBook(`isbn_${match.isbn}`));
        if (match) {
          fill(match, { force: true });
          st.description = match.description || '';
          found = true;
          if (match.isbn) lookupIsbn(match.isbn).then((r) => r && fill(r)).catch(() => {});
        } else {
          fill({ title: ai.title, authors: ai.authors, publisher: ai.publisher }, { force: true });
        }
      }
      applyAi(ai);
      if (!st.book.cover) fill({ cover: p.thumb });
      setStatus(found ? `찾았어요: ${st.book.title}` : 'AI가 사진에서 읽은 정보예요. 맞는지 확인해 주세요.', 'ok');
    } catch (e) {
      fill({ cover: p.thumb });
      setStatus(e.message, 'error');
    }
  }

  async function aiFill({ quiet = false } = {}) {
    if (!st.book.title.trim()) return toast('제목을 먼저 입력해 주세요');
    const b = st.book;
    const text = [
      'Book facts (from a library catalog or typed by a parent):',
      `Title: ${b.title}`,
      b.authors && `Authors: ${b.authors}`,
      b.publisher && `Publisher: ${b.publisher}`,
      b.isbn && `ISBN: ${b.isbn}`,
      b.pages && `Pages: ${b.pages}`,
      st.description && `Description: ${st.description.slice(0, 1500)}`,
    ].filter(Boolean).join('\n');
    setStatus('AI가 과목과 난이도를 추정하는 중…', 'busy');
    try {
      applyAi(await readBook({ text }));
      setStatus(quiet ? `찾았어요: ${b.title} · 과목·난이도는 AI 추정이에요` : 'AI 추정을 채웠어요. 맞는지 확인해 주세요.', 'ok');
    } catch (e) {
      setStatus(e.message, 'error');
    }
  }

  // ---------- title autocomplete ----------

  let searchCtl;
  let online = null;

  const searchOnline = debounce(async (q) => {
    searchCtl?.abort();
    const ctl = (searchCtl = new AbortController());
    try {
      const hits = await searchTitle(q, ctl.signal);
      if (ctl === searchCtl && ui.title.value.trim() === q) {
        online = hits;
        showSuggest();
      }
    } catch {
      if (ctl === searchCtl) {
        online = [];
        showSuggest();
      }
    }
  }, 350);

  function onTitleInput() {
    st.book.title = ui.title.value;
    st.touched.add('title');
    online = null;
    const q = ui.title.value.trim();
    showSuggest();
    if (q.length >= 2) searchOnline(q);
    paintSave();
  }

  function showSuggest() {
    const q = ui.title.value.trim();
    const n = normTitle(q);
    clear(ui.suggest);
    if (!n || document.activeElement !== ui.title) return hideSuggest();
    const mine = store.books()
      .filter((b) => b.id !== st.bookId && (normTitle(b.title).includes(n) || normTitle(b.authors).includes(n)))
      .slice(0, 4);
    const mineIsbn = new Set(mine.map((b) => b.isbn).filter(Boolean));
    const others = (online || []).filter((x) => !x.isbn || !mineIsbn.has(x.isbn)).slice(0, 6);
    const row = (b, tag, onPick) => h('button', {
      type: 'button',
      class: 'suggest-item',
      // pointerdown fires before the input loses focus.
      onPointerdown: (e) => {
        e.preventDefault();
        onPick();
      },
    }, cover(b, 's'), h('span', { class: 'suggest-text' },
      h('span', { class: 'suggest-title' }, b.title),
      h('span', { class: 'suggest-sub' }, [b.authors, b.publisher].filter(Boolean).join(' · '))),
    h('span', { class: `tag ${tag === '내 책장' ? 'mine' : ''}` }, tag));

    for (const b of mine) ui.suggest.append(row(b, '내 책장', () => useExisting(b)));
    for (const x of others) ui.suggest.append(row(x, '검색', () => pickOnline(x)));
    if (online === null && q.length >= 2) ui.suggest.append(h('div', { class: 'suggest-note' }, '검색 중…'));
    else if (!mine.length && !others.length && q.length >= 2) ui.suggest.append(h('div', { class: 'suggest-note' }, '검색 결과가 없어요. 그대로 입력해도 돼요.'));
    ui.suggest.hidden = !ui.suggest.childElementCount;
  }

  function hideSuggest() {
    ui.suggest.hidden = true;
  }

  async function pickOnline(x) {
    hideSuggest();
    ui.title.blur();
    if (x.isbn && store.getBook(`isbn_${x.isbn}`)) return useExisting(store.getBook(`isbn_${x.isbn}`));
    fill(x, { force: true });
    st.description = x.description || '';
    setStatus(`골랐어요: ${x.title}`, 'ok');
    if (x.isbn) {
      setStatus('쪽수와 분야를 찾는 중…', 'busy');
      const more = await lookupIsbn(x.isbn).catch(() => null);
      if (more) {
        fill(more);
        st.description ||= more.description || '';
      }
      setStatus(`골랐어요: ${st.book.title}`, 'ok');
    }
    await autoClassify();
  }

  // ---------- reading dates ----------

  function paintDates() {
    clear(ui.dates);
    st.dates.forEach((d, i) => {
      ui.dates.append(h('div', { class: 'date-row' },
        h('input', {
          type: 'date', class: 'input', value: d, max: todayStr(), 'aria-label': `읽은 날짜 ${i + 1}`,
          onChange: (e) => {
            if (e.target.value) st.dates[i] = e.target.value;
            paintSave();
          },
        }),
        st.dates.length > 1 && h('button', {
          type: 'button', class: 'icon-btn', 'aria-label': '이 날짜 빼기',
          onClick: () => {
            st.dates.splice(i, 1);
            paintDates();
            paintSave();
          },
        }, icon('close', 18))));
    });
  }

  function addDate() {
    const earliest = [...st.dates].sort()[0] || todayStr();
    st.dates.push(addDays(earliest, -1));
    paintDates();
    paintSave();
  }

  // ---------- save ----------

  function saveLabel() {
    if (mode === 'edit') return '저장';
    const n = st.readerIds.length * st.dates.length;
    return n ? `읽은 기록 저장 (${n}건)` : '책장에만 저장';
  }

  async function save() {
    if (st.busy) return;
    const title = st.book.title.trim();
    if (!title) {
      toast('책 제목을 입력해 주세요');
      setCompact(false);
      ui.title.focus();
      return;
    }
    st.busy = true;
    try {
      const fields = { ...st.book, title, isbn: toIsbn13(st.book.isbn) || '' };
      fields.lang ||= guessLang(title) || 'ko';
      let id = st.bookId;
      if (!id) id = (fields.isbn && store.getBook(`isbn_${fields.isbn}`)?.id) || store.findBookByTitle(title)?.id;
      const book = await store.saveBook(fields, id || undefined);
      let n = 0;
      if (mode === 'record' && st.readerIds.length) {
        n = await store.addReads(book.id, st.readerIds, [...new Set(st.dates)], st.aloud);
        updateSettings({ lastReaderIds: st.readerIds, lastAloud: st.aloud });
      }
      store.requestPersist();
      await closeOverlay();
      toast(mode === 'edit' ? '저장했어요' : n ? `${book.title} · ${n}건 기록했어요` : `${book.title} · 책장에 담았어요`);
    } catch (e) {
      toast(`저장하지 못했어요: ${e.message}`);
    } finally {
      st.busy = false;
    }
  }

  // ---------- painting ----------

  function paintLevelHint() {
    const lv = LEVELS[(st.book.level || 0) - 1];
    const why = { size: ' · 쪽수/단어 수로 추정', ai: ' · AI 추정' }[st.levelFrom] || '';
    ui.levelHint.textContent = lv ? `${lv.hint}${why}` : '쪽수나 단어 수를 넣으면 자동으로 골라요';
  }

  function paintSave() {
    ui.save.textContent = saveLabel();
  }

  function paint() {
    const b = st.book;
    // Never rewrite the box the user is typing in.
    const put = (input, v) => document.activeElement !== input && (input.value = v || '');
    put(ui.title, b.title);
    put(ui.authors, b.authors);
    put(ui.publisher, b.publisher);
    put(ui.pages, b.pages);
    put(ui.words, b.words);
    put(ui.isbn, b.isbn);
    put(ui.levelTag, b.levelTag);
    put(ui.note, b.note);
    ui.lang.set(b.lang);
    ui.subject.set(b.subject);
    ui.level.set(b.level ? String(b.level) : null);
    clear(ui.coverSlot).append(cover(b, 'l'));
    clear(ui.summary).append(
      cover(b, 'm'),
      h('div', { class: 'summary-text' },
        h('strong', null, b.title || '제목 없음'),
        h('span', { class: 'muted' }, [b.authors, b.publisher].filter(Boolean).join(' · ')),
        bookBadges(b)),
      h('button', { type: 'button', class: 'link', onClick: () => setCompact(false) }, '정보 수정'));
    paintLevelHint();
    paintSave();
  }

  function setCompact(on) {
    ui.summary.hidden = !on;
    ui.fields.hidden = on;
    ui.find.hidden = on;
  }

  // ---------- build ----------

  const field = (key, props) => {
    const el = h('input', {
      class: 'input',
      ...props,
      onInput: (e) => {
        const v = e.target.value;
        st.book[key] = props.type === 'number' ? (Number(v) > 0 ? Math.round(Number(v)) : null) : v;
        st.touched.add(key);
        if (key === 'pages' || key === 'words') {
          autoLevel();
          ui.level.set(st.book.level ? String(st.book.level) : null);
          paintLevelHint();
        }
      },
    });
    return el;
  };

  ui.status = h('div', { class: 'status', hidden: true, role: 'status', 'aria-live': 'polite' });
  ui.title = h('input', {
    class: 'input big', type: 'text', placeholder: '책 제목 (입력하면 찾아 드려요)', autocomplete: 'off',
    enterkeyhint: 'done', 'aria-label': '책 제목',
    onInput: onTitleInput, onFocus: showSuggest, onBlur: () => setTimeout(hideSuggest, 150),
    onKeydown: (e) => e.key === 'Escape' && hideSuggest(),
  });
  ui.suggest = h('div', { class: 'suggest', hidden: true });
  ui.authors = field('authors', { type: 'text', placeholder: '지은이', 'aria-label': '지은이' });
  ui.publisher = field('publisher', { type: 'text', placeholder: '출판사', 'aria-label': '출판사' });
  ui.pages = field('pages', { type: 'number', inputmode: 'numeric', min: 0, placeholder: '쪽수', 'aria-label': '쪽수' });
  ui.words = field('words', { type: 'number', inputmode: 'numeric', min: 0, placeholder: '단어 수', 'aria-label': '단어 수' });
  ui.isbn = field('isbn', { type: 'text', inputmode: 'numeric', placeholder: 'ISBN (13자리)', 'aria-label': 'ISBN' });
  ui.isbn.addEventListener('change', () => {
    const isbn = toIsbn13(ui.isbn.value);
    if (isbn && !st.book.title.trim()) handleIsbn(isbn);
  });
  ui.levelTag = field('levelTag', { type: 'text', placeholder: '예: AR 2.3, Lexile 450L', 'aria-label': '레벨 표기' });
  ui.note = field('note', { type: 'text', placeholder: '메모', 'aria-label': '메모' });
  ui.lang = chipGroup(LANGS, {
    onChange: (v) => {
      st.book.lang = v;
      st.touched.add('lang');
    },
  });
  ui.subject = chipGroup(store.subjects(), {
    onChange: (v) => {
      st.book.subject = v;
      st.touched.add('subject');
    },
  });
  ui.level = chipGroup(LEVELS.map((l) => ({ key: String(l.n), label: `${l.n} ${l.name}` })), {
    cls: 'levels',
    onChange: (v) => {
      st.book.level = v ? Number(v) : null;
      st.levelFrom = v ? 'user' : null;
      if (!v) autoLevel();
      ui.level.set(st.book.level ? String(st.book.level) : null);
      paintLevelHint();
    },
  });
  ui.levelHint = h('p', { class: 'hint' });
  ui.coverSlot = h('div', { class: 'cover-slot' });
  ui.summary = h('div', { class: 'book-summary card', hidden: true });
  ui.save = h('button', { class: 'btn primary wide', onClick: save });
  ui.dates = h('div', { class: 'dates' });

  ui.find = h('div', { class: 'find' },
    h('div', { class: 'find-row' },
      h('button', { type: 'button', class: 'big-btn', onClick: scan }, icon('barcode', 28), '바코드 스캔'),
      h('button', { type: 'button', class: 'big-btn', onClick: () => photo(true) }, icon('camera', 28), '표지·바코드 사진')),
    h('button', { type: 'button', class: 'link small', onClick: () => photo(false) }, icon('image', 16), '앨범에서 사진 고르기'));

  ui.fields = h('section', { class: 'card fields' },
    h('div', { class: 'title-row' },
      ui.coverSlot,
      h('div', { class: 'title-col' },
        h('div', { class: 'ac' }, ui.title, ui.suggest),
        ui.authors,
        ui.publisher)),
    h('h3', null, '언어'), ui.lang,
    h('h3', null, '과목'), ui.subject,
    h('div', { class: 'h3-row' },
      h('h3', null, '난이도'),
      hasClaude() && h('button', { type: 'button', class: 'chip ai', onClick: () => aiFill() }, icon('sparkle', 16), 'AI로 채우기')),
    ui.level, ui.levelHint,
    h('div', { class: 'two' },
      h('label', null, h('span', null, '쪽수'), ui.pages),
      h('label', null, h('span', null, '단어 수'), ui.words)),
    h('details', { class: 'more' },
      h('summary', null, '더 보기 (ISBN, 레벨 표기, 메모)'),
      h('label', null, h('span', null, 'ISBN'), ui.isbn),
      h('label', null, h('span', null, '레벨 표기 (영어책)'), ui.levelTag),
      h('label', null, h('span', null, '메모'), ui.note)));

  const reading = mode === 'record' && h('section', { class: 'card' },
    h('h3', null, '누가 읽었나요?'),
    chipGroup(store.readers().map((r) => ({ key: r.id, label: r.name, color: readerColor(r) })), {
      multi: true,
      value: st.readerIds,
      onChange: (v) => {
        st.readerIds = v;
        paintSave();
      },
    }),
    h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: st.aloud, onChange: (e) => (st.aloud = e.target.checked) }),
      h('span', null, '부모님이 읽어 줬어요')),
    h('h3', null, '언제 읽었나요?'),
    ui.dates,
    h('button', { type: 'button', class: 'link', onClick: addDate }, icon('plus', 16), '다른 날짜 추가'));

  const title = mode === 'edit' ? '책 정보 수정' : existing ? '읽은 기록 추가' : '책 기록하기';
  const el = h('div', { class: 'page editor' },
    h('header', { class: 'bar' },
      h('button', { class: 'icon-btn', 'aria-label': '뒤로', onClick: () => closeOverlay() }, icon('back')),
      h('h2', null, title)),
    h('div', { class: 'scroll' }, ui.find, ui.status, ui.summary, ui.fields, reading),
    h('footer', { class: 'actions' }, ui.save));

  openOverlay(el, { onClose: () => searchCtl?.abort() });
  paintDates();
  paint();
  if (existing && mode === 'record') setCompact(true);
  if (existing && mode === 'edit') ui.find.hidden = true;

  if (start === 'scan') scan();
  else if (start === 'photo') photo(true);
  else if (!existing) setTimeout(() => ui.title.focus(), 250);
}
