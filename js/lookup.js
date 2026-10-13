// Book metadata from public catalogs, called straight from the phone's browser.
//   Kakao book search  - best Korean coverage, title search for autocomplete (needs a free key)
//   National Library   - page count and subject code for Korean ISBNs (optional key)
//   Open Library       - no key; good for English books
//   Google Books       - no key needed but often over quota; optional key

import { toIsbn13, guessLang, subjectFromAddCode } from './catalog.js';
import { settings } from './settings.js';
import { normTitle } from './util.js';

const TIMEOUT_MS = 8000;

async function getJson(url, { headers, signal } = {}) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(url, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}

const firstNumber = (s) => {
  const m = String(s || '').match(/(\d+)\s*(?:p|쪽|페이지)/i) || String(s || '').match(/\d+/);
  return m ? Number(m[1] ?? m[0]) || null : null;
};

// ---- sources ----

async function kakao(params, signal) {
  const key = settings().kakaoKey;
  if (!key) return [];
  const data = await getJson(`https://dapi.kakao.com/v3/search/book?${new URLSearchParams(params)}`, {
    headers: { Authorization: `KakaoAK ${key}` },
    signal,
  });
  return data.documents.map((d) => ({
    source: 'kakao',
    isbn: (d.isbn || '').split(' ').map(toIsbn13).find(Boolean) || '',
    title: d.title,
    authors: [...(d.authors || []), ...(d.translators || []).map((t) => `${t}(옮김)`)].join(', '),
    publisher: d.publisher || '',
    pubDate: (d.datetime || '').slice(0, 10),
    cover: d.thumbnail || '',
    description: d.contents || '',
  }));
}

async function nationalLibrary(isbn, signal) {
  const key = settings().nlKey;
  if (!key) return null;
  const q = new URLSearchParams({ cert_key: key, result_style: 'json', page_no: '1', page_size: '1', isbn });
  const data = await getJson(`https://www.nl.go.kr/seoji/SearchApi.do?${q}`, { signal });
  const d = data.docs?.[0];
  if (!d) return null;
  const pd = String(d.PUBLISH_PREDATE || '');
  return {
    source: 'nl',
    isbn,
    title: d.TITLE || '',
    authors: d.AUTHOR || '',
    publisher: d.PUBLISHER || '',
    pubDate: /^\d{8}$/.test(pd) ? `${pd.slice(0, 4)}-${pd.slice(4, 6)}-${pd.slice(6)}` : pd,
    pages: firstNumber(d.PAGE),
    cover: d.TITLE_URL || '',
    subject: subjectFromAddCode(d.EA_ADD_CODE),
  };
}

async function openLibraryIsbn(isbn, signal) {
  const data = await getJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`, { signal });
  const d = data[`ISBN:${isbn}`];
  if (!d) return null;
  return {
    source: 'openlibrary',
    isbn,
    title: d.subtitle ? `${d.title}: ${d.subtitle}` : d.title,
    authors: (d.authors || []).map((a) => a.name).join(', '),
    publisher: d.publishers?.[0]?.name || '',
    pubDate: d.publish_date || '',
    pages: d.number_of_pages || null,
    cover: d.cover?.medium || '',
  };
}

async function openLibrarySearch(q, signal) {
  const params = new URLSearchParams({
    q,
    limit: '6',
    fields: 'title,author_name,isbn,cover_i,first_publish_year,number_of_pages_median,publisher',
  });
  const data = await getJson(`https://openlibrary.org/search.json?${params}`, { signal });
  return data.docs.map((d) => ({
    source: 'openlibrary',
    title: d.title,
    authors: (d.author_name || []).slice(0, 3).join(', '),
    publisher: d.publisher?.[0] || '',
    isbn: (d.isbn || []).map(toIsbn13).find(Boolean) || '',
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '',
    pages: d.number_of_pages_median || null,
    pubDate: d.first_publish_year ? String(d.first_publish_year) : '',
  }));
}

async function googleIsbn(isbn, signal) {
  const key = settings().googleKey;
  const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}${key ? `&key=${encodeURIComponent(key)}` : ''}`;
  const v = (await getJson(url, { signal })).items?.[0]?.volumeInfo;
  if (!v) return null;
  return {
    source: 'google',
    isbn,
    title: v.subtitle ? `${v.title}: ${v.subtitle}` : v.title,
    authors: (v.authors || []).join(', '),
    publisher: v.publisher || '',
    pubDate: v.publishedDate || '',
    pages: v.pageCount || null,
    lang: { ko: 'ko', en: 'en' }[v.language] ?? (v.language ? 'etc' : null),
    cover: (v.imageLinks?.thumbnail || '').replace(/^http:/, 'https:'),
    description: v.description || '',
  };
}

// ---- merging ----

// Which source to trust first, per field.
const PRIORITY = {
  title: ['kakao', 'nl', 'google', 'openlibrary'],
  authors: ['kakao', 'nl', 'google', 'openlibrary'],
  publisher: ['kakao', 'nl', 'google', 'openlibrary'],
  pubDate: ['kakao', 'nl', 'google', 'openlibrary'],
  cover: ['kakao', 'nl', 'google', 'openlibrary'],
  pages: ['nl', 'google', 'openlibrary'],
  subject: ['nl'],
  lang: ['google'],
  description: ['kakao', 'google'],
};

export function mergeHits(hits) {
  const bySource = Object.fromEntries(hits.filter(Boolean).map((x) => [x.source, x]));
  const out = { sources: Object.keys(bySource) };
  for (const [field, order] of Object.entries(PRIORITY)) {
    for (const s of order) {
      const v = bySource[s]?.[field];
      if (v) {
        out[field] = v;
        break;
      }
    }
  }
  if (!out.lang && out.title) out.lang = guessLang(out.title);
  return out;
}

export async function lookupIsbn(raw) {
  const isbn = toIsbn13(raw);
  if (!isbn) return null;
  const jobs = [
    kakao({ target: 'isbn', query: isbn }).then((r) => r[0]),
    nationalLibrary(isbn),
    openLibraryIsbn(isbn),
    googleIsbn(isbn),
  ];
  const hits = (await Promise.allSettled(jobs)).filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
  const found = hits.filter((x) => x.title);
  return found.length ? { isbn, ...mergeHits(found) } : null;
}

// Title search for autocomplete: Kakao first, Open Library for English titles.
export async function searchTitle(q, signal) {
  const jobs = [];
  if (settings().kakaoKey) jobs.push(kakao({ query: q, target: 'title', size: '8' }, signal));
  if (!settings().kakaoKey || guessLang(q) !== 'ko') jobs.push(openLibrarySearch(q, signal));
  const lists = (await Promise.allSettled(jobs)).map((r) => (r.status === 'fulfilled' ? r.value : []));
  const seen = new Set();
  const out = [];
  for (let i = 0; out.length < 8 && lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const x = l[i];
      const sig = x && (x.isbn || `${normTitle(x.title)}|${x.authors}`);
      if (x?.title && !seen.has(sig)) {
        seen.add(sig);
        out.push(x);
      }
    }
  }
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  return out;
}

// Best online match for a title read off a cover (used after AI reads a photo).
export async function bestTitleMatch(title, authors) {
  const n = normTitle(title);
  if (n.length < 2) return null;
  const hits = await searchTitle(title).catch(() => []);
  const firstAuthor = normTitle((authors || '').split(/[,;]/)[0]);
  const close = (x) => {
    const t = normTitle(x.title);
    return t === n || (Math.min(t.length, n.length) >= 4 && (t.includes(n) || n.includes(t)));
  };
  return hits.find((x) => close(x) && firstAuthor && normTitle(x.authors).includes(firstAuthor))
    ?? hits.find(close) ?? null;
}

// Quick key checks for the settings page.
export async function testKey(which) {
  if (which === 'kakao') return (await kakao({ query: '구름빵', size: '1' })).length > 0;
  if (which === 'nl') {
    const q = new URLSearchParams({ cert_key: settings().nlKey, result_style: 'json', page_no: '1', page_size: '1', isbn: '9788949161075' });
    return Array.isArray((await getJson(`https://www.nl.go.kr/seoji/SearchApi.do?${q}`)).docs);
  }
  if (which === 'google') return !!(await googleIsbn('9780439708180'));
  return false;
}
