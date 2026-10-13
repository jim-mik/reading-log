// Fixed vocabularies: languages, subjects, difficulty levels, ISBN rules.

export const LANGS = [
  { key: 'ko', label: '한국어' },
  { key: 'en', label: '영어' },
  { key: 'etc', label: '기타' },
];

// Default subjects. Families can add their own in 설정 (stored in meta.subjects).
// The first 8 get their own chart color; the rest share a gray "그 외".
export const DEFAULT_SUBJECTS = [
  { key: 'lit', label: '문학·동화' },
  { key: 'lang', label: '언어(한글·영어)' },
  { key: 'math', label: '수학' },
  { key: 'sci', label: '과학' },
  { key: 'soc', label: '사회·역사' },
  { key: 'comic', label: '학습만화' },
  { key: 'bio', label: '인물' },
  { key: 'art', label: '예술' },
  { key: 'life', label: '생활·인성' },
  { key: 'etc', label: '기타' },
];

// Difficulty: 5 steps a parent can pick at a glance. Pages/words only suggest a step.
export const LEVELS = [
  { n: 1, name: '그림책', hint: '한 쪽에 한두 문장 · 1천 단어 미만' },
  { n: 2, name: '쉬운 읽기책', hint: '리더스북, 글 많은 그림책 · 5천 단어 미만' },
  { n: 3, name: '초기 챕터북', hint: '짧은 장으로 나뉜 얇은 책 · 1만5천 단어 미만' },
  { n: 4, name: '챕터북·동화', hint: '글 위주, 100~200쪽 · 4만 단어 미만' },
  { n: 5, name: '소설·지식책', hint: '긴 글, 200쪽 이상 · 4만 단어 이상' },
];

export function levelFromSize({ words, pages }) {
  if (words > 0) {
    if (words < 1000) return 1;
    if (words < 5000) return 2;
    if (words < 15000) return 3;
    if (words < 40000) return 4;
    return 5;
  }
  if (pages > 0) {
    if (pages <= 40) return 1;
    if (pages <= 80) return 2;
    if (pages <= 140) return 3;
    if (pages <= 240) return 4;
    return 5;
  }
  return null;
}

export function guessLang(text) {
  const s = text || '';
  const hangul = (s.match(/[가-힣]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  if (hangul > 0 && hangul * 2 >= latin) return 'ko';
  if (latin > 0) return 'en';
  return null;
}

// ---- ISBN ----

export function cleanIsbn(s) {
  return String(s || '').replace(/[^0-9Xx]/g, '').toUpperCase();
}

export function isValidIsbn13(s) {
  if (!/^97[89]\d{10}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(s[12]);
}

export function toIsbn13(raw) {
  const s = cleanIsbn(raw);
  if (s.length === 13) return isValidIsbn13(s) ? s : null;
  if (s.length === 10) {
    const core = '978' + s.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
    return core + ((10 - (sum % 10)) % 10);
  }
  return null;
}

// Korean ISBN add-on code (부가기호, 5 digits): reader group + form + content class (KDC).
// Only the content class is used, to pre-select a subject.
export function subjectFromAddCode(code) {
  if (!/^\d{5}$/.test(code || '')) return null;
  const cls = Number(code.slice(2));
  const top = Math.floor(cls / 100);
  if (cls >= 410 && cls < 420) return 'math';
  if (cls >= 990) return 'bio';
  if (cls >= 590 && cls < 600) return 'life';
  return { 0: 'etc', 1: 'life', 2: 'life', 3: 'soc', 4: 'sci', 5: 'sci', 6: 'art', 7: 'lang', 8: 'lit', 9: 'soc' }[top];
}
