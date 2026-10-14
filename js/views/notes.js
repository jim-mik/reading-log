// 노트: what a child learned, from a book or not: text with #tags, photos, who, the 누리과정 area
// and a question to ask later. The 노트 tab finds notes by word or tag; the editor also opens from
// a book's page.

import { h, clear, todayStr, prettyDate, debounce, normTitle } from '../util.js';
import * as store from '../store.js';
import { settings, updateSettings } from '../settings.js';
import { AREAS, allTags, tagsIn, cleanTag, splitTags, matches, tagCounts, ageMonths } from '../notes.js';
import { suggestNote, hasClaude } from '../ai.js';
import { notePhoto, pickPhoto } from '../media.js';
import { openOverlay, closeOverlay, toast, chipGroup, icon, readerColor, whoChip, emptyState, cover } from '../ui.js';
import * as sync from '../sync.js';

const MAX_PHOTOS = 4;

// Filters survive tab switches.
const f = { q: '', tag: null, reader: 'all' };

const bookOf = (n) => (n.bookId ? store.state.books.get(n.bookId) : null);
const bookTitle = (n) => bookOf(n)?.title ?? '';

const noteText = (text) => splitTags(text).map((p) => (p.tag ? h('span', { class: 'tag-inline' }, `#${p.tag}`) : p.text));

export function noteRow(n, { showBook = true } = {}) {
  const photo = store.photosOf(n.id)[0];
  const book = showBook && bookOf(n);
  const extra = (n.tags || []).filter((t) => !tagsIn(n.text).includes(t));
  return h('button', { class: 'row note-row', onClick: () => openNoteEditor({ noteId: n.id }) },
    photo && h('img', { class: 'note-thumb', src: photo.thumb || photo.data, alt: '' }),
    h('span', { class: 'row-main' },
      h('span', { class: 'note-text' }, n.text ? noteText(n.text) : h('span', { class: 'muted' }, '(사진만)')),
      extra.length > 0 && h('span', { class: 'badges' }, extra.map((t) => h('span', { class: 'badge tag' }, `#${t}`))),
      h('span', { class: 'row-sub muted' },
        (n.readerIds || []).map((id) => store.getReader(id)).filter(Boolean).map((r) => whoChip(r)),
        h('span', null, [book && `${book.title}${book.deletedAt ? ' (지운 책)' : ''}`, n.page && `${n.page}쪽`, prettyDate(n.date)]
          .filter(Boolean).join(' · ')))));
}

export function renderNotes(root) {
  const list = h('div', { class: 'list' });
  const count = h('p', { class: 'muted count' });
  const tagBox = h('div', { class: 'chips tag-cloud' });

  function paint() {
    const all = store.notes();
    const mine = all.filter((n) => f.reader === 'all' || (n.readerIds || []).includes(f.reader));
    const top = tagCounts(mine).slice(0, 15);
    if (f.tag && !top.some(([t]) => t === f.tag)) top.unshift([f.tag, mine.filter((n) => (n.tags || []).includes(f.tag)).length]);
    clear(tagBox).append(...top.map(([t, c]) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(f.tag === t),
      onClick: () => {
        f.tag = f.tag === t ? null : t;
        paint();
      },
    }, `#${t}`, h('span', { class: 'chip-n' }, String(c)))));

    const shown = mine.filter((n) => (!f.tag || (n.tags || []).includes(f.tag)) && matches(n, f.q, bookTitle(n)));
    count.textContent = `노트 ${shown.length}개`;
    clear(list).append(...shown.map((n) => noteRow(n)));
    if (!shown.length) {
      list.append(all.length
        ? emptyState('찾는 노트가 없어요.')
        : emptyState('아직 노트가 없어요. 아이가 책에서 배운 것, 새로 알게 된 것을 적어 보세요.',
          h('button', { class: 'btn primary', onClick: () => openNoteEditor() }, '첫 노트 쓰기')));
    }
  }

  const search = h('div', { class: 'search' }, icon('search', 20),
    h('input', {
      type: 'search', class: 'input', placeholder: '낱말이나 #태그로 찾기', value: f.q, 'aria-label': '노트 찾기',
      onInput: debounce((e) => {
        f.q = e.target.value;
        paint();
      }, 150),
    }));
  const readerChips = chipGroup([{ key: 'all', label: '모두' }, ...store.readers().map((r) => ({ key: r.id, label: r.name, color: readerColor(r) }))], {
    value: f.reader, required: true,
    onChange: (v) => {
      f.reader = v;
      paint();
    },
  });

  root.append(
    h('header', { class: 'page-head' }, h('h1', null, '노트')),
    h('p', { class: 'banner', hidden: !sync.needsNewScript() }, sync.OLD_SCRIPT),
    search,
    h('div', { class: 'filters' }, readerChips, tagBox),
    count, list,
    h('button', { class: 'fab', 'aria-label': '노트 쓰기', onClick: () => openNoteEditor() }, icon('plus', 28)));
  paint();
}

function openPhoto(src) {
  openOverlay(h('div', { class: 'page viewer', onClick: () => closeOverlay() }, h('img', { src, alt: '' })));
}

export function openNoteEditor({ noteId = null, bookId = null } = {}) {
  const prev = noteId ? store.state.notes.get(noteId) : null;
  const live = (id) => store.getReader(id) && !store.getReader(id).deletedAt;
  const lastWho = (settings().lastNoteReaderIds || []).filter(live);
  const st = {
    bookId: prev ? prev.bookId || '' : bookId || '',
    readerIds: prev ? (prev.readerIds || []).filter(live)
      : lastWho.length ? lastWho : store.readers().filter((r) => r.kind === 'child').slice(0, 1).map((r) => r.id),
    date: prev?.date ?? todayStr(),
    page: prev?.page ?? '',
    text: prev?.text ?? '',
    extraTags: prev ? (prev.tags || []).filter((t) => !tagsIn(prev.text).includes(t)) : [],
    area: prev?.area || null,
    question: prev?.question ?? '',
    kept: prev ? store.photosOf(prev.id) : [],
    added: [],
    removed: [],
    suggested: [],
    aiFor: '',
    areaByUser: !!prev?.area,
    questionByUser: !!prev?.question,
    busy: false,
  };
  const ui = {};
  let aiTicket = 0;

  // ---- book ----
  ui.book = h('div', { class: 'note-book' });
  function paintBook() {
    clear(ui.book);
    const b = st.bookId && store.state.books.get(st.bookId);
    if (b) {
      ui.book.append(h('div', { class: 'picked' }, cover(b, 's'), h('span', { class: 'picked-title' }, b.title),
        h('button', {
          type: 'button', class: 'link small',
          onClick: () => {
            st.bookId = '';
            paintBook();
            ui.bookInput.focus();
          },
        }, '바꾸기')));
      return;
    }
    const found = h('div', { class: 'stack' });
    ui.bookInput = h('input', {
      class: 'input', placeholder: '책장에서 찾기 (비워 두면 책 없이)', 'aria-label': '어떤 책',
      onInput: (e) => {
        const n = normTitle(e.target.value);
        clear(found).append(...(n ? store.books().filter((x) => normTitle(x.title).includes(n)).slice(0, 6) : []).map((x) =>
          h('button', {
            type: 'button', class: 'row compact',
            onClick: () => {
              st.bookId = x.id;
              paintBook();
            },
          }, cover(x, 's'), h('span', { class: 'row-title' }, x.title))));
      },
    });
    ui.book.append(ui.bookInput, found);
  }

  // ---- text and tags ----
  ui.text = h('textarea', {
    class: 'input', rows: 4, 'aria-label': '배운 것',
    placeholder: '무엇을 배웠나요? 예: 트리케라톱스는 뿔이 3개 #공룡',
    onInput: (e) => {
      st.text = e.target.value;
      paintTags();
      autoSuggest();
    },
  });
  ui.text.value = st.text;
  ui.tags = h('div', { class: 'chips' });
  ui.aiStatus = h('span', { class: 'small muted' });
  ui.tagInput = h('input', {
    class: 'input tag-input', placeholder: '태그 추가', 'aria-label': '태그 추가',
    onChange: (e) => {
      const t = cleanTag(e.target.value);
      e.target.value = '';
      if (t && !allTags(st.text, st.extraTags).includes(t)) st.extraTags.push(t);
      paintTags();
    },
  });

  function paintTags() {
    const fromText = tagsIn(st.text);
    const have = new Set(allTags(st.text, st.extraTags));
    st.suggested = st.suggested.filter((t) => !have.has(t));
    clear(ui.tags).append(
      ...fromText.map((t) => h('span', { class: 'chip static' }, `#${t}`)),
      ...st.extraTags.filter((t) => !fromText.includes(t)).map((t) => h('span', { class: 'chip static' }, `#${t}`,
        h('button', {
          type: 'button', class: 'chip-x', 'aria-label': `${t} 빼기`,
          onClick: () => {
            st.extraTags = st.extraTags.filter((x) => x !== t);
            paintTags();
          },
        }, icon('close', 14)))),
      ...st.suggested.map((t) => h('button', {
        type: 'button', class: 'chip suggested',
        onClick: () => {
          st.extraTags.push(t);
          paintTags();
        },
      }, `+#${t}`)));
  }

  // ---- AI: tags, area and a question, a moment after typing stops ----
  async function suggest(manual) {
    const text = st.text.trim();
    if (!hasClaude() || text.length < 6 || (!manual && text === st.aiFor)) return;
    st.aiFor = text;
    const ticket = ++aiTicket;
    ui.aiStatus.textContent = 'AI가 태그와 질문을 고르는 중…';
    try {
      const kid = st.readerIds.map((id) => store.getReader(id)).find((r) => r?.kind === 'child');
      const known = tagCounts(store.notes()).slice(0, 60).map(([t]) => t);
      const r = await suggestNote({ text, bookTitle: store.state.books.get(st.bookId)?.title || '', ageMonths: ageMonths(kid?.birth), knownTags: known });
      if (ticket !== aiTicket) return;
      const have = new Set(allTags(st.text, st.extraTags));
      st.suggested = [...new Set((r.tags || []).map(cleanTag))].filter((t) => t && !have.has(t));
      if (r.area && !st.areaByUser) {
        st.area = r.area;
        ui.area.set(r.area);
      }
      if (r.question && !st.questionByUser) {
        st.question = r.question;
        ui.question.value = r.question;
      }
      ui.aiStatus.textContent = st.suggested.length ? 'AI 제안: 눌러서 태그로 추가' : '';
      paintTags();
    } catch (e) {
      if (ticket === aiTicket) ui.aiStatus.textContent = `AI 제안을 못 했어요: ${e.message}`;
    }
  }
  const autoSuggest = debounce(() => settings().aiAuto !== false && suggest(false), 1500);

  // ---- photos ----
  ui.photos = h('div', { class: 'photos' });
  function paintPhotos() {
    const shown = [...st.kept.filter((p) => !st.removed.includes(p.id)), ...st.added];
    clear(ui.photos).append(...shown.map((p) => h('div', { class: 'photo' },
      h('img', { src: p.thumb || p.data, alt: '', onClick: () => openPhoto(p.data) }),
      h('button', {
        type: 'button', class: 'chip-x', 'aria-label': '사진 빼기',
        onClick: () => {
          if (p.id) st.removed.push(p.id);
          else st.added = st.added.filter((x) => x !== p);
          paintPhotos();
        },
      }, icon('close', 14)))));
    ui.photoBtns.hidden = shown.length >= MAX_PHOTOS;
  }
  async function addPhoto(camera) {
    const file = await pickPhoto({ camera });
    if (!file) return;
    try {
      st.added.push(await notePhoto(file));
      paintPhotos();
    } catch (e) {
      toast(`사진을 읽지 못했어요: ${e.message}`);
    }
  }
  ui.photoBtns = h('div', { class: 'inline' },
    h('button', { type: 'button', class: 'btn', onClick: () => addPhoto(true) }, icon('camera', 18), '사진 찍기'),
    h('button', { type: 'button', class: 'btn', onClick: () => addPhoto(false) }, icon('image', 18), '앨범'));

  // ---- the rest ----
  ui.area = chipGroup(AREAS, {
    value: st.area,
    onChange: (v) => {
      st.area = v;
      st.areaByUser = true;
    },
  });
  ui.question = h('input', {
    class: 'input', placeholder: '예: 트리케라톱스 뿔은 몇 개였지?', 'aria-label': '나중에 물어볼 질문',
    onInput: (e) => {
      st.question = e.target.value;
      st.questionByUser = true;
    },
  });
  ui.question.value = st.question;

  async function save() {
    if (st.busy) return;
    const text = st.text.trim();
    if (!text && !st.added.length && !st.kept.some((p) => !st.removed.includes(p.id))) {
      toast('배운 것을 적거나 사진을 넣어 주세요');
      ui.text.focus();
      return;
    }
    st.busy = true;
    try {
      await store.saveNote({
        bookId: st.bookId || '', readerIds: st.readerIds, date: st.date || todayStr(), page: String(st.page || '').trim(),
        text, tags: allTags(text, st.extraTags), area: st.area || '', question: st.question.trim(),
      }, { id: prev?.id, add: st.added, remove: st.removed });
      updateSettings({ lastNoteReaderIds: st.readerIds });
      await closeOverlay();
      toast('노트를 저장했어요');
    } catch (e) {
      toast(`저장하지 못했어요: ${e.message}`);
    } finally {
      st.busy = false;
    }
  }

  const el = h('div', { class: 'page editor note-editor' },
    h('header', { class: 'bar' },
      h('button', { class: 'icon-btn', 'aria-label': '뒤로', onClick: () => closeOverlay() }, icon('back')),
      h('h2', null, prev ? '노트 고치기' : '노트 쓰기'),
      prev && h('button', {
        class: 'icon-btn', 'aria-label': '노트 지우기',
        onClick: async () => {
          if (!confirm('이 노트를 지울까요?')) return;
          await store.removeNote(prev.id);
          await closeOverlay();
          toast('노트를 지웠어요');
        },
      }, icon('trash'))),
    h('div', { class: 'scroll' },
      h('section', { class: 'card' },
        h('h3', null, '무엇을 배웠나요?'),
        ui.text,
        h('div', { class: 'h3-row' },
          h('h3', null, '태그'),
          hasClaude() && h('button', { type: 'button', class: 'chip ai', onClick: () => suggest(true) }, icon('sparkle', 16), 'AI 제안')),
        ui.tags, ui.aiStatus, ui.tagInput,
        h('h3', null, '사진'),
        ui.photos, ui.photoBtns),
      h('section', { class: 'card' },
        h('h3', null, '누가 배웠나요?'),
        chipGroup(store.readers().map((r) => ({ key: r.id, label: r.name, color: readerColor(r) })), {
          multi: true, value: st.readerIds, onChange: (v) => (st.readerIds = v),
        }),
        h('h3', null, '어떤 책에서?'),
        ui.book,
        h('div', { class: 'two' },
          h('label', null, h('span', null, '쪽'), h('input', {
            class: 'input', inputmode: 'numeric', value: st.page, placeholder: '예: 12', 'aria-label': '쪽',
            onInput: (e) => (st.page = e.target.value),
          })),
          h('label', null, h('span', null, '날짜'), h('input', {
            class: 'input', type: 'date', value: st.date, max: todayStr(), 'aria-label': '날짜',
            onChange: (e) => (st.date = e.target.value),
          })))),
      h('section', { class: 'card' },
        h('h3', null, '영역 (누리과정)'),
        ui.area,
        h('h3', null, '나중에 물어볼 질문'),
        ui.question,
        h('p', { class: 'hint' }, '며칠 뒤 아이에게 물어보면 기억하는지 알 수 있어요. 다음 단계에서 이 질문으로 기억을 확인해요.'))),
    h('footer', { class: 'actions' }, h('button', { class: 'btn primary wide', onClick: save }, '노트 저장')));

  openOverlay(el);
  paintBook();
  paintTags();
  paintPhotos();
  if (!prev) setTimeout(() => ui.text.focus(), 250);
}
