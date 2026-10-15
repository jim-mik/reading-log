// 책장: every book, with search and filters (read / not read by whom, language, subject).

import { h, clear, normTitle, debounce } from '../util.js';
import { LANGS } from '../catalog.js';
import * as store from '../store.js';
import { chipGroup, select, cover, bookBadges, icon, readerColor, emptyState } from '../ui.js';
import { openEditor } from './editor.js';
import { openBook } from './book.js';

// Filters survive tab switches.
const f = { q: '', reader: 'all', status: 'all', lang: 'all', subject: 'all', sort: 'recent' };

export function renderShelf(root) {
  const list = h('div', { class: 'list' });
  const count = h('p', { class: 'muted count' });

  function paintList() {
    const readers = store.readers();
    const reads = store.reads();
    const byBook = new Map();
    for (const r of reads) {
      if (!byBook.has(r.bookId)) byBook.set(r.bookId, []);
      byBook.get(r.bookId).push(r);
    }
    const n = normTitle(f.q);
    // "#공룡" looks at tags only; other words at title, authors, series and tags.
    const tagQ = f.q.trim().startsWith('#') ? n : '';
    const found = (b) => (tagQ ? (b.tags || []).some((t) => normTitle(t).startsWith(tagQ))
      : !n || [b.title, b.authors, b.series, ...(b.tags || [])].some((x) => normTitle(x).includes(n)));
    const readBy = (b) => (byBook.get(b.id) || []).filter((r) => f.reader === 'all' || r.readerId === f.reader);
    const last = (b) => (byBook.get(b.id) || []).reduce((m, r) => (r.date > m ? r.date : m), '');

    let books = store.books().filter((b) =>
      found(b) &&
      (f.lang === 'all' || b.lang === f.lang) &&
      (f.subject === 'all' || (b.subject || 'etc') === f.subject) &&
      (f.status === 'all' || (f.status === 'read') === readBy(b).length > 0));
    books = books.sort(
      f.sort === 'title' ? (a, b) => a.title.localeCompare(b.title, 'ko')
        : f.sort === 'added' ? (a, b) => b.createdAt.localeCompare(a.createdAt)
          : (a, b) => last(b).localeCompare(last(a)) || b.createdAt.localeCompare(a.createdAt));

    count.textContent = `${books.length}권`;
    clear(list).append(...books.map((b) => {
      const rs = byBook.get(b.id) || [];
      return h('button', { class: 'row', onClick: () => openBook(b.id) },
        cover(b, 'm'),
        h('span', { class: 'row-main' },
          h('span', { class: 'row-title' }, b.title),
          h('span', { class: 'row-sub muted' }, b.authors),
          bookBadges(b)),
        h('span', { class: 'row-side' },
          h('span', { class: 'dots', 'aria-label': `읽은 사람 ${readers.filter((r) => rs.some((x) => x.readerId === r.id)).map((r) => r.name).join(', ') || '없음'}` },
            readers.map((r) => h('span', {
              class: `dot ${rs.some((x) => x.readerId === r.id) ? '' : 'off'}`,
              style: `--dot:${readerColor(r)}`,
            }))),
          h('span', { class: 'small muted' }, rs.length ? `${rs.length}번` : '안 읽음')));
    }));
    if (!books.length) {
      list.append(store.books().length
        ? emptyState('조건에 맞는 책이 없어요.')
        : emptyState('책장이 비어 있어요.', h('button', { class: 'btn primary', onClick: () => openEditor() }, '첫 책 담기')));
    }
  }

  const search = h('div', { class: 'search' }, icon('search', 20),
    h('input', {
      type: 'search', class: 'input', placeholder: '제목, 지은이, 전집, #태그로 찾기', value: f.q, 'aria-label': '책 찾기',
      onInput: debounce((e) => {
        f.q = e.target.value;
        paintList();
      }, 150),
    }));

  const readerChips = chipGroup([{ key: 'all', label: '모두' }, ...store.readers().map((r) => ({ key: r.id, label: r.name, color: readerColor(r) }))], {
    value: f.reader, required: true,
    onChange: (v) => {
      f.reader = v;
      paintList();
    },
  });
  const statusChips = chipGroup([{ key: 'all', label: '전체' }, { key: 'read', label: '읽은 책' }, { key: 'unread', label: '안 읽은 책' }], {
    value: f.status, required: true, cls: 'seg',
    onChange: (v) => {
      f.status = v;
      paintList();
    },
  });
  const set = (k) => (v) => {
    f[k] = v;
    paintList();
  };

  root.append(
    h('header', { class: 'page-head' }, h('h1', null, '책장')),
    search,
    h('div', { class: 'filters' }, readerChips, statusChips,
      h('div', { class: 'selects' },
        select([{ key: 'all', label: '모든 언어' }, ...LANGS], f.lang, set('lang'), '언어'),
        select([{ key: 'all', label: '모든 과목' }, ...store.subjects()], f.subject, set('subject'), '과목'),
        select([{ key: 'recent', label: '최근 읽은 순' }, { key: 'added', label: '담은 순' }, { key: 'title', label: '제목 순' }], f.sort, set('sort'), '정렬'))),
    count, list,
    h('button', { class: 'fab', 'aria-label': '책장에 책 담기', onClick: () => openEditor({ shelfOnly: true }) }, icon('plus', 28)));
  paintList();
}
