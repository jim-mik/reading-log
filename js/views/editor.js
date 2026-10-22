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
import { classify } from '../classify.js';
import { cleanTag } from '../notes.js';
import { readBook, hasClaude } from '../ai.js';
import { canScanLive, findIsbn, preparePhoto, pickPhoto } from '../media.js';
import { openScanner } from './scanner.js';
import { openOverlay, closeOverlay, toast, chipGroup, cover, icon, readerColor, bookBadges } from '../ui.js';

const EMPTY = {
  isbn: '', title: '', authors: '', publisher: '', pubDate: '', lang: null, subject: null,
  level: null, levelTag: '', pages: null, words: null, cover: '', note: '', series: '', tags: [],
};
const IDENTITY = ['isbn', 'title', 'authors', 'publisher', 'pubDate', 'cover'];
const DETAILS = ['lang', 'subject', 'pages', 'words', 'series'];

export function openEditor({ bookId = null, mode = 'record', start = null, shelfOnly = false } = {}) {
  const existing = bookId ? store.getBook(bookId) : null;
  const liveReaderIds = new Set(store.readers().map((r) => r.id));
  const st = {
    bookId: existing?.id ?? null,
    book: { ...EMPTY, ...(existing || {}) },
    touched: new Set(existing ? Object.keys(EMPTY).filter((k) => existing[k]) : []),
    levelFrom: existing?.level ? 'saved' : null, // user | ai | size | saved
    subjectFrom: existing?.subject ? 'saved' : null, // user | catalog | ai | rule | saved
    langFrom: existing?.lang ? 'saved' : null,
    autoTags: [], // from the title (classify.js), saved with the book unless removed
    removedTags: new Set(),
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
      if (!st.touched.has('tags')) st.book.tags = [];
      if (st.subjectFrom !== 'user') st.subjectFrom = null;
      if (st.langFrom !== 'user') st.langFrom = null;
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
      const guessed = k === 'subject' && st.subjectFrom === 'rule';
      if (!replace && !guessed && (st.touched.has(k) || st.book[k])) continue;
      st.book[k] = v;
      if (k === 'subject') st.subjectFrom = 'catalog';
      if (k === 'lang') st.langFrom = 'catalog';
      if (replace) st.touched.delete(k);
    }
    autoLevel();
    ruleFill();
    paint();
  }

  // Subject and topic tags from the title and series name, for what the catalog and the user left empty.
  function ruleFill() {
    const r = classify({ title: st.book.title, series: st.book.series }, store.subjects());
    if (!st.touched.has('subject') && (!st.book.subject || st.subjectFrom === 'rule')) {
      st.book.subject = r.subject;
      st.subjectFrom = r.subject ? 'rule' : null;
    }
    st.autoTags = r.tags.filter((t) => !st.removedTags.has(t) && !(st.book.tags || []).includes(t));
    // Language from the title (Korean vs English), unless a catalog/AI/user value already set it.
    if (!st.touched.has('lang') && ['rule', null].includes(st.langFrom)) {
      const g = guessLang(st.book.title);
      if (g) {
        st.book.lang = g;
        st.langFrom = 'rule';
      }
    }
  }
  const allBookTags = () => [...new Set([...(st.book.tags || []), ...st.autoTags])];

  function autoLevel() {
    if (['user', 'saved', 'ai'].includes(st.levelFrom)) return;
    const lv = levelFromSize(st.book);
    if (lv) {
      st.book.level = lv;
      st.levelFrom = 'size';
    }
  }

  function applyAi(ai) {
    if (ai.subject && !st.touched.has('subject') && ['rule', null].includes(st.subjectFrom)) {
      st.book.subject = ai.subject;
      st.subjectFrom = 'ai';
    }
    if (ai.series && !st.book.series) st.book.series = ai.series;
    const topics = (ai.topics || []).map(cleanTag).filter((t) => t && !st.removedTags.has(t));
    st.book.tags = [...new Set([...(st.book.tags || []), ...topics])];
    fill({ lang: ai.language, pages: ai.pages || null, words: ai.words || null });
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
    st.subjectFrom = book.subject ? 'saved' : null;
    st.autoTags = [];
    hideSuggest();
    setCompact(mode === 'record');
    paint();
    setStatus('이미 책장에 있는 책이에요. 누가 언제 읽었는지만 고르면 돼요.', 'ok');
  }

  // ---------- finding a book ----------

  async function handleIsbn(isbn, thumb) {
    const mine = store.bookByIsbn(isbn);
    if (mine && !st.bookId) {
      useExisting(mine);
      return true;
    }
    setStatus('책 정보를 찾는 중…', 'busy');
    const hit = await lookupIsbn(isbn).catch(() => null);
    if (!hit) {
      fill({ isbn, cover: thumb }, { force: true });
      const korean = /^97(89|911)/.test(isbn);
      const tip = korean && !settings().nlKey ? ' 설정에서 국립중앙도서관 키를 넣으면 전집처럼 서점에 없는 책도 찾아요.'
        : !settings().kakaoKey ? ' 설정에서 카카오 키를 넣으면 한국 책을 훨씬 잘 찾아요.' : '';
      // Volumes of a 전집 get ISBNs in sequence: borrow the set's details from a neighbor on the shelf.
      const near = store.nearestByIsbn(isbn);
      if (near) {
        const set = near.series ? near.series.replace(/\s*\d+\s*$/, '') : '';
        fill({ publisher: near.publisher, authors: near.authors, lang: near.lang, subject: near.subject, series: set });
        if (!st.book.level && near.level) {
          st.book.level = near.level;
          st.levelFrom = 'size';
        }
        if (set && !st.book.title) st.book.title = `${set} `;
        st.book.tags = [...new Set([...(st.book.tags || []), ...(near.tags || [])])];
        paint();
        setStatus(`서점 목록에 없는 책이에요. ISBN이 "${near.title}"와 이어져서 같은 전집으로 보고 출판사·과목을 채웠어요. 이 권의 제목만 써 주세요. 한 번 저장하면 다음부터는 바로 찾아요.${tip}`, 'ok');
        if (set) setTimeout(() => ui.title.focus(), 50);
        return false;
      }
      setStatus(`ISBN ${isbn}로 책 정보를 찾지 못했어요. 전집처럼 서점에 없는 책일 수 있어요. 제목을 직접 써 주세요. 한 번 저장하면 다음부터는 바로 찾아요.${tip}`, 'error');
      return false;
    }
    fill(hit, { force: true });
    if (thumb && !st.book.cover) fill({ cover: thumb });
    st.description = hit.description || '';
    setStatus(`찾았어요: ${hit.title}`, 'ok');
    return true;
  }

  // New book found: let AI suggest subject, level and topics unless the catalog gave them.
  async function autoClassify() {
    if (!hasClaude() || settings().aiAuto === false || st.bookId) return;
    if (st.subjectFrom === 'catalog' && st.book.level && st.levelFrom !== 'size' && st.book.tags?.length) return;
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
      const ai = await readBook({ image: p.base64, knownTags: store.knownTags() });
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
        if (match?.isbn && store.bookByIsbn(match.isbn)) return useExisting(store.bookByIsbn(match.isbn));
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
      b.series && `Series: ${b.series}`,
      b.pages && `Pages: ${b.pages}`,
      st.description && `Description: ${st.description.slice(0, 1500)}`,
    ].filter(Boolean).join('\n');
    setStatus('AI가 과목과 난이도를 추정하는 중…', 'busy');
    try {
      applyAi(await readBook({ text, knownTags: store.knownTags() }));
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
    ruleFill();
    ui.lang.set(st.book.lang);
    ui.subject.set(st.book.subject);
    paintTags();
    paintSubjectHint();
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

    // "Use exactly what I typed": lets you keep an unlisted title and close the keyboard with one tap.
    const exact = [...mine, ...others].some((b) => normTitle(b.title) === n);
    if (!exact) {
      ui.suggest.append(h('button', {
        type: 'button', class: 'suggest-item confirm',
        onPointerdown: (e) => {
          e.preventDefault();
          confirmTyped();
        },
      }, icon('pencil', 20), h('span', { class: 'suggest-text' },
        h('span', { class: 'suggest-title' }, `"${q}"`),
        h('span', { class: 'suggest-sub' }, '이 제목 그대로 쓰기')),
      h('span', { class: 'tag' }, '입력')));
    }
    for (const b of mine) ui.suggest.append(row(b, '내 책장', () => useExisting(b)));
    for (const x of others) ui.suggest.append(row(x, '검색', () => pickOnline(x)));
    if (online === null && q.length >= 2) ui.suggest.append(h('div', { class: 'suggest-note' }, '찾는 중…'));
    ui.suggest.hidden = !ui.suggest.childElementCount;
  }

  // Keep the typed title as-is and close the suggestions (and the phone keyboard).
  function confirmTyped() {
    st.book.title = ui.title.value.trim();
    st.touched.add('title');
    hideSuggest();
    ui.title.blur();
  }

  function hideSuggest() {
    ui.suggest.hidden = true;
  }

  async function pickOnline(x) {
    hideSuggest();
    ui.title.blur();
    if (x.isbn && store.bookByIsbn(x.isbn)) return useExisting(store.bookByIsbn(x.isbn));
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

  // Quick picks cover the usual cases (read today, or forgot to log it yesterday) without opening
  // the phone's date picker. The native input stays for any older date.
  const QUICK = [{ label: '오늘', back: 0 }, { label: '어제', back: 1 }, { label: '그저께', back: 2 }];

  function paintDates() {
    clear(ui.dates);
    const today = todayStr();
    st.dates.forEach((d, i) => {
      const setDate = (v) => {
        if (!v) return;
        st.dates[i] = v;
        paintDates();
        paintSave();
      };
      const quick = h('div', { class: 'chips date-quick' }, QUICK.map(({ label, back }) => {
        const day = addDays(today, -back);
        return h('button', {
          type: 'button', class: 'chip', 'aria-pressed': String(d === day),
          onClick: () => setDate(day),
        }, label);
      }));
      ui.dates.append(h('div', { class: 'date-block' },
        quick,
        h('div', { class: 'date-row' },
          h('input', {
            type: 'date', class: 'input', value: d, max: today, 'aria-label': `읽은 날짜 ${i + 1}`,
            onChange: (e) => setDate(e.target.value),
          }),
          st.dates.length > 1 && h('button', {
            type: 'button', class: 'icon-btn', 'aria-label': '이 날짜 빼기',
            onClick: () => {
              st.dates.splice(i, 1);
              paintDates();
              paintSave();
            },
          }, icon('close', 18)))));
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
      const fields = { ...st.book, title, isbn: toIsbn13(st.book.isbn) || '', series: (st.book.series || '').trim(), tags: allBookTags() };
      fields.lang ||= guessLang(title) || 'ko';
      let id = st.bookId;
      // Same book already on the shelf: by ISBN, or by title unless the ISBNs differ (another 전집 volume).
      const sameTitle = store.findBookByTitle(title);
      if (!id) id = (fields.isbn && store.bookByIsbn(fields.isbn)?.id) || (sameTitle && (!sameTitle.isbn || !fields.isbn) ? sameTitle.id : null);
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

  function paintSubjectHint() {
    const why = { rule: '제목으로 고른 과목이에요. 다르면 바꿔 주세요.', ai: 'AI가 고른 과목이에요.', catalog: '도서관 분류로 고른 과목이에요.' }[st.subjectFrom];
    ui.subjectHint.hidden = !why || !st.book.subject;
    ui.subjectHint.textContent = why || '';
  }

  function paintTags() {
    const remove = (t) => () => {
      st.book.tags = (st.book.tags || []).filter((x) => x !== t);
      st.autoTags = st.autoTags.filter((x) => x !== t);
      st.removedTags.add(t);
      st.touched.add('tags');
      paintTags();
    };
    clear(ui.tags).append(...allBookTags().map((t) => h('span', { class: `chip static${st.autoTags.includes(t) ? ' auto' : ''}` }, `#${t}`,
      h('button', { type: 'button', class: 'chip-x', 'aria-label': `${t} 빼기`, onClick: remove(t) }, icon('close', 14)))));
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
    put(ui.series, b.series);
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
    paintSubjectHint();
    paintTags();
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
  ui.series = field('series', { type: 'text', placeholder: '예: 안녕, 마음아 12', 'aria-label': '전집·시리즈' });
  ui.series.addEventListener('input', () => {
    ruleFill();
    ui.lang.set(st.book.lang);
    ui.subject.set(st.book.subject);
    paintTags();
    paintSubjectHint();
  });
  ui.subjectHint = h('p', { class: 'hint', hidden: true });
  ui.tags = h('div', { class: 'chips' });
  ui.tagInput = h('input', {
    class: 'input tag-input', placeholder: '태그 추가 (예: 공룡)', 'aria-label': '태그 추가',
    onChange: (e) => {
      const t = cleanTag(e.target.value);
      e.target.value = '';
      if (!t) return;
      st.removedTags.delete(t);
      st.book.tags = [...new Set([...(st.book.tags || []), t])];
      st.touched.add('tags');
      paintTags();
    },
  });
  ui.lang = chipGroup(LANGS, {
    onChange: (v) => {
      st.book.lang = v;
      st.touched.add('lang');
      st.langFrom = 'user';
    },
  });
  ui.subject = chipGroup(store.subjects(), {
    onChange: (v) => {
      st.book.subject = v;
      st.touched.add('subject');
      st.subjectFrom = 'user';
      paintSubjectHint();
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
    h('h3', null, '과목'), ui.subject, ui.subjectHint,
    h('h3', null, '태그 (주제)'), ui.tags, ui.tagInput,
    h('div', { class: 'h3-row' },
      h('h3', null, '난이도'),
      hasClaude() && h('button', { type: 'button', class: 'chip ai', onClick: () => aiFill() }, icon('sparkle', 16), 'AI로 채우기')),
    ui.level, ui.levelHint,
    h('div', { class: 'two' },
      h('label', null, h('span', null, '쪽수'), ui.pages),
      h('label', null, h('span', null, '단어 수'), ui.words)),
    h('details', { class: 'more' },
      h('summary', null, '더 보기 (전집, ISBN, 레벨 표기, 메모)'),
      h('label', null, h('span', null, '전집·시리즈와 권 번호'), ui.series),
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
