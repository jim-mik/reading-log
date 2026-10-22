// Edit one reading record: its date (오늘/어제/그저께 chips + picker), who read it, read-aloud,
// or delete it. Opened by tapping a row in a book's 읽은 기록 list or a single-read 최근 기록 row.

import { h, todayStr, addDays, prettyDate } from '../util.js';
import * as store from './../store.js';
import { openOverlay, closeOverlay, toast, chipGroup, cover, icon, readerColor } from '../ui.js';

const QUICK = [{ label: '오늘', back: 0 }, { label: '어제', back: 1 }, { label: '그저께', back: 2 }];

export function openReadEditor(readId) {
  const read = store.state.reads.get(readId);
  if (!read || read.deletedAt) return;
  const book = store.getBook(read.bookId);
  const st = { date: read.date, readerId: read.readerId, aloud: !!read.aloud };

  const dates = h('div', { class: 'dates' });
  const paintDates = () => {
    const today = todayStr();
    const setDate = (v) => {
      if (!v) return;
      st.date = v;
      paintDates();
    };
    clearInto(dates,
      h('div', { class: 'chips date-quick' }, QUICK.map(({ label, back }) => {
        const day = addDays(today, -back);
        return h('button', { type: 'button', class: 'chip', 'aria-pressed': String(st.date === day), onClick: () => setDate(day) }, label);
      })),
      h('div', { class: 'date-row' },
        h('input', { type: 'date', class: 'input', value: st.date, max: today, 'aria-label': '읽은 날짜', onChange: (e) => setDate(e.target.value) })));
  };
  paintDates();

  const who = chipGroup(store.readers().map((r) => ({ key: r.id, label: r.name, color: readerColor(r) })), {
    value: st.readerId, required: true, onChange: (v) => (st.readerId = v),
  });

  const el = h('div', { class: 'page editor' },
    h('header', { class: 'bar' },
      h('button', { class: 'icon-btn', 'aria-label': '뒤로', onClick: () => closeOverlay() }, icon('back')),
      h('h2', null, '읽은 기록 고치기'),
      h('button', {
        class: 'icon-btn', 'aria-label': '이 기록 지우기',
        onClick: async () => {
          if (!confirm(`${prettyDate(read.date)} 기록을 지울까요?`)) return;
          await store.removeRead(readId);
          await closeOverlay();
          toast('기록을 지웠어요');
        },
      }, icon('trash'))),
    h('div', { class: 'scroll' },
      book && h('section', { class: 'book-summary card' },
        cover(book, 'm'),
        h('div', { class: 'summary-text' }, h('strong', null, book.title),
          h('span', { class: 'muted' }, [book.authors, book.publisher].filter(Boolean).join(' · ')))),
      h('section', { class: 'card' },
        h('h3', null, '누가 읽었나요?'), who,
        h('label', { class: 'toggle' },
          h('input', { type: 'checkbox', checked: st.aloud, onChange: (e) => (st.aloud = e.target.checked) }),
          h('span', null, '부모님이 읽어 줬어요')),
        h('h3', null, '언제 읽었나요?'), dates)),
    h('footer', { class: 'actions' },
      h('button', {
        class: 'btn primary wide',
        onClick: async () => {
          await store.updateRead(readId, { date: st.date, readerId: st.readerId, aloud: st.aloud });
          await closeOverlay();
          toast('고쳤어요');
        },
      }, '저장')));

  openOverlay(el);
}

function clearInto(el, ...kids) {
  while (el.firstChild) el.firstChild.remove();
  el.append(...kids.flat().filter(Boolean));
}
