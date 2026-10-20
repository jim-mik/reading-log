// Book metadata from public catalogs, called straight from the phone's browser.
//   Kakao book search  - best Korean coverage, title search for autocomplete (needs a free key)
//   National Library   - the Korean ISBN registry: every Korean ISBN, including 전집 volumes that
//                        bookstores don't list; series, page count, subject code (optional key)
//   도서관 정보나루       - public-library catalog: 전집 volumes libraries hold, cover and subject;
//                        no approval wait, so it stands in for the National Library key (optional)
//   Open Library       - no key; good for English books
//   Google Books       - no key needed but often over quota; optional key

import { toIsbn13, guessLang, subjectFromAddCode, subjectFromKdc } from './catalog.js';
import { settings } from './settings.js';
import { normTitle } from './util.js';

const TIMEOUT_MS = 8000;

async function getJson(url, { headers, signal } = {}) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(url, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!res.ok) {
    // Google and Kakao explain refusals (bad key, API not enabled, quota) in the body.
    const why = await res.json().then((d) => d.error?.message || d.message || '').catch(() => '');
    throw new Error(`${new URL(url).host} ${res.status}${why ? `: ${why}` : ''}`);
  }
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

function fromNl(d) {
  const pd = String(d.PUBLISH_PREDATE || '');
  const series = String(d.SERIES_TITLE || '').trim();
  const no = String(d.SERIES_NO || '').trim();
  return {
    source: 'nl',
    isbn: toIsbn13(d.EA_ISBN) || '',
    title: String(d.TITLE || '').trim(),
    authors: String(d.AUTHOR || '').trim(),
    publisher: String(d.PUBLISHER || '').trim(),
    pubDate: /^\d{8}$/.test(pd) ? `${pd.slice(0, 4)}-${pd.slice(4, 6)}-${pd.slice(6)}` : pd,
    pages: firstNumber(d.PAGE),
    cover: d.TITLE_URL || '',
    subject: subjectFromAddCode(d.EA_ADD_CODE),
    series: series && no ? `${series} ${no}` : series,
  };
}

async function nlQuery(params, signal) {
  const key = settings().nlKey;
  if (!key) return [];
  const q = new URLSearchParams({ cert_key: key, result_style: 'json', page_no: '1', ...params });
  return ((await getJson(`https://www.nl.go.kr/seoji/SearchApi.do?${q}`, { signal })).docs || []).map(fromNl);
}

async function nationalLibrary(isbn, signal) {
  const d = (await nlQuery({ page_size: '1', isbn }, signal))[0];
  return d?.title ? { ...d, isbn } : null;
}

// Title search finds 전집 volumes by their own title or by the set's name.
async function nlSearch(q, signal) {
  const lists = await Promise.allSettled([nlQuery({ page_size: '6', title: q }, signal), nlQuery({ page_size: '6', series_title: q }, signal)]);
  return lists.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).filter((x) => x.title);
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

const googleUrl = (q) => {
  const key = settings().googleKey;
  return `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}${key ? `&key=${encodeURIComponent(key)}` : ''}`;
};

async function googleIsbn(isbn, signal) {
  // "isbn:" sometimes finds nothing (it did for every ISBN in Oct 2026); then try the bare number,
  // keeping only a volume that really carries this ISBN.
  let v = (await getJson(googleUrl(`isbn:${isbn}`), { signal })).items?.[0]?.volumeInfo;
  if (!v) {
    v = ((await getJson(googleUrl(isbn), { signal })).items || []).map((x) => x.volumeInfo)
      .find((x) => (x.industryIdentifiers || []).some((id) => toIsbn13(id.identifier) === isbn));
  }
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

// 도서관 정보나루 (data4library.kr): the public-library catalog. 200 even on an auth error, so the
// error is inside the body. Covers come from Aladin over http; serve them over https.
function fromNara(d) {
  return {
    source: 'nara',
    isbn: toIsbn13(d.isbn13) || '',
    title: String(d.bookname || '').trim(),
    authors: String(d.authors || '').trim().replace(/\s*;\s*/g, ', '),
    publisher: String(d.publisher || '').trim(),
    pubDate: String(d.publication_year || '').trim(),
    cover: (d.bookImageURL || '').replace(/^http:/, 'https:'),
    subject: subjectFromAddCode(d.addition_symbol) || subjectFromKdc(d.class_no),
  };
}

async function naraQuery(params, signal) {
  const key = settings().naraKey;
  if (!key) return [];
  const q = new URLSearchParams({ authKey: key, format: 'json', pageNo: '1', pageSize: '10', ...params });
  const data = await getJson(`https://data4library.kr/api/srchBooks?${q}`, { signal });
  if (data.response?.error) throw new Error(`정보나루: ${data.response.error}`);
  return (data.response?.docs || []).map((x) => x.doc).filter(Boolean).map(fromNara).filter((x) => x.title);
}

async function naraIsbn(isbn, signal) {
  const d = (await naraQuery({ isbn13: isbn }, signal))[0];
  return d ? { ...d, isbn } : null;
}

// `title` is the broad matcher here (keyword is near-exact and misses 전집).
const naraSearch = (q, signal) => naraQuery({ title: q, pageSize: '8' }, signal);

// ---- merging ----

// Which source to trust first, per field.
const PRIORITY = {
  title: ['kakao', 'nl', 'nara', 'google', 'openlibrary'],
  authors: ['kakao', 'nl', 'nara', 'google', 'openlibrary'],
  publisher: ['kakao', 'nl', 'nara', 'google', 'openlibrary'],
  pubDate: ['kakao', 'nl', 'nara', 'google', 'openlibrary'],
  cover: ['kakao', 'nl', 'nara', 'google', 'openlibrary'],
  pages: ['nl', 'google', 'openlibrary'],
  subject: ['nl', 'nara'],
  series: ['nl'],
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
    naraIsbn(isbn),
    openLibraryIsbn(isbn),
    googleIsbn(isbn),
  ];
  const hits = (await Promise.allSettled(jobs)).filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
  const found = hits.filter((x) => x.title);
  return found.length ? { isbn, ...mergeHits(found) } : null;
}

// Title search for autocomplete: Kakao, the National Library and 정보나루 (전집 volumes), Open Library for English.
export async function searchTitle(q, signal) {
  const jobs = [];
  if (settings().kakaoKey) jobs.push(kakao({ query: q, target: 'title', size: '8' }, signal));
  if (settings().nlKey && guessLang(q) !== 'en') jobs.push(nlSearch(q, signal));
  if (settings().naraKey && guessLang(q) !== 'en') jobs.push(naraSearch(q, signal));
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

// Does a catalog title fit a title read off a cover? With the author matching too, either may be
// the longer one; without, only the catalog's may be: "안녕, 마음아 12 화가 나요" (a 전집 volume)
// must not match the single book "안녕, 마음아".
export function titleFits(read, catalog, authorMatches) {
  const n = normTitle(read);
  const t = normTitle(catalog);
  if (!n || !t) return false;
  if (t === n) return true;
  if (Math.min(t.length, n.length) < 4) return false;
  return t.includes(n) || (authorMatches && n.includes(t));
}

// Best online match for a title read off a cover (used after AI reads a photo).
export async function bestTitleMatch(title, authors) {
  if (normTitle(title).length < 2) return null;
  const hits = await searchTitle(title).catch(() => []);
  const firstAuthor = normTitle((authors || '').split(/[,;]/)[0]);
  const byAuthor = (x) => !!firstAuthor && normTitle(x.authors).includes(firstAuthor);
  return hits.find((x) => byAuthor(x) && titleFits(title, x.title, true))
    ?? hits.find((x) => titleFits(title, x.title, false)) ?? null;
}

// Quick key checks for the settings page.
export async function testKey(which) {
  if (which === 'kakao') return (await kakao({ query: '구름빵', size: '1' })).length > 0;
  if (which === 'nl') {
    const q = new URLSearchParams({ cert_key: settings().nlKey, result_style: 'json', page_no: '1', page_size: '1', isbn: '9788949161075' });
    const data = await getJson(`https://www.nl.go.kr/seoji/SearchApi.do?${q}`);
    if (data.RESULT === 'ERROR') throw new Error(data.ERR_MESSAGE || '키를 확인해 주세요');
    return Array.isArray(data.docs);
  }
  // A title search: it checks the key and quota even when Google's ISBN search is having a bad day.
  if (which === 'google') return ((await getJson(googleUrl('intitle:harry potter'))).totalItems || 0) > 0;
  if (which === 'nara') {
    const q = new URLSearchParams({ authKey: settings().naraKey, format: 'json', pageNo: '1', pageSize: '1', isbn13: '9788949161075' });
    const data = await getJson(`https://data4library.kr/api/srchBooks?${q}`);
    if (data.response?.error) throw new Error(data.response.error);
    return Array.isArray(data.response?.docs);
  }
  return false;
}
