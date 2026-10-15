// One book: details, who read it, every reading record, notes on what was learned.

import { h, clear, prettyDate, fmtNum } from '../util.js';
import * as store from '../store.js';
import { openOverlay, closeOverlay, toast, cover, icon, whoChip, langLabel, levelLabel } from '../ui.js';
import { openEditor } from './editor.js';
import { openNoteEditor, noteRow } from './notes.js';

export function openBook(id) {
  const el = h('div', { class: 'page book' });

  function render() {
    const b = store.getBook(id);
    if (!b) return;
    const rs = store.readsOfBook(id);
    const ns = store.notesOfBook(id);
    const year = (b.pubDate || '').slice(0, 4);

    const whoRows = store.readers().map((r) => {
      const mine = rs.filter((x) => x.readerId === r.id);
      return h('li', { class: 'who-row' },
        whoChip(r),
        h('span', { class: mine.length ? '' : 'muted' },
          mine.length ? `${mine.length}번 · 마지막 ${prettyDate(mine[0].date)}` : '아직 안 읽었어요'));
    });

    const history = rs.map((x) => h('li', { class: 'hist-row' },
      h('span', { class: 'hist-date' }, prettyDate(x.date)),
      whoChip(store.getReader(x.readerId)),
      x.aloud && h('span', { class: 'badge' }, '읽어 줌'),
      h('button', {
        class: 'icon-btn', 'aria-label': '이 기록 지우기',
        onClick: async () => {
          if (!confirm(`${prettyDate(x.date)} ${store.getReader(x.readerId)?.name} 기록을 지울까요?`)) return;
          await store.removeRead(x.id);
          toast('기록을 지웠어요');
        },
      }, icon('close', 18))));

    clear(el).append(
      h('header', { class: 'bar' },
        h('button', { class: 'icon-btn', 'aria-label': '뒤로', onClick: () => closeOverlay() }, icon('back')),
        h('h2', null, '책 정보'),
        h('button', {
          class: 'icon-btn', 'aria-label': '책 지우기',
          onClick: async () => {
            const msg = rs.length ? `"${b.title}"과 읽은 기록 ${rs.length}건을 모두 지울까요?` : `"${b.title}"을 책장에서 지울까요?`;
            if (!confirm(msg)) return;
            await store.removeBook(id);
            await closeOverlay();
            toast('지웠어요');
          },
        }, icon('trash'))),
      h('div', { class: 'scroll' },
        h('section', { class: 'book-head' },
          cover(b, 'xl'),
          h('div', null,
            h('h1', null, b.title),
            h('p', { class: 'muted' }, [b.authors, b.publisher, year].filter(Boolean).join(' · ')),
            h('div', { class: 'badges' },
              h('span', { class: 'badge' }, langLabel(b.lang)),
              b.subject && h('span', { class: 'badge' }, store.subjectLabel(b.subject)),
              b.level && h('span', { class: 'badge' }, levelLabel(b.level)),
              b.pages && h('span', { class: 'badge' }, `${fmtNum(b.pages)}쪽`),
              b.words && h('span', { class: 'badge' }, `${fmtNum(b.words)}단어`),
              b.levelTag && h('span', { class: 'badge' }, b.levelTag),
              b.series && h('span', { class: 'badge' }, b.series),
              (b.tags || []).map((t) => h('span', { class: 'badge tag' }, `#${t}`))),
            b.isbn && h('p', { class: 'muted small' }, `ISBN ${b.isbn}`),
            b.note && h('p', { class: 'note' }, b.note))),
        h('section', { class: 'card' },
          h('h3', null, '누가 읽었나요'),
          h('ul', { class: 'plain' }, whoRows)),
        h('section', { class: 'card' },
          h('div', { class: 'h3-row' },
            h('h3', null, ns.length ? `노트 ${ns.length}개` : '노트'),
            h('button', { type: 'button', class: 'chip ai', onClick: () => openNoteEditor({ bookId: id }) }, icon('plus', 16), '노트 쓰기')),
          ns.length ? h('div', { class: 'list' }, ns.map((n) => noteRow(n, { showBook: false })))
            : h('p', { class: 'muted' }, '이 책에서 배운 것을 적어 두면 나중에 찾을 수 있어요')),
        h('section', { class: 'card' },
          h('h3', null, `읽은 기록 ${rs.length}건`),
          rs.length ? h('ul', { class: 'plain' }, history) : h('p', { class: 'muted' }, '아직 기록이 없어요'))),
      h('footer', { class: 'actions' },
        h('button', { class: 'btn', onClick: () => openEditor({ bookId: id, mode: 'edit' }) }, icon('pencil', 18), '정보 수정'),
        h('button', { class: 'btn primary', onClick: () => openEditor({ bookId: id }) }, icon('plus', 18), '읽은 기록 추가')));
  }

  const off = store.onChange(render);
  openOverlay(el, { onClose: off });
  render();
}
