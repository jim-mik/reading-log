// Subject and topic tags for a book from its title and series name, without AI. Good for 전집,
// whose names say what they're about (수학특공대, 과학공룡, 안녕 마음아). Keyword lists only:
// the first subject with a matching word wins; every topic with a matching word becomes a tag.
// Claude, when set up, refines both (ai.js).

const SUBJECTS = [
  ['comic', ['학습만화', '만화']],
  ['math', ['수학', '숫자', '셈놀이', '연산', '도형', '분수', '덧셈', '뺄셈', '곱셈', '수세기', '시계', 'math', 'number', 'counting']],
  ['sci', ['과학', '공룡', '우주', '행성', '동물', '식물', '곤충', '자연', '생태', '지구', '날씨', '인체', '우리몸', '실험', '바다', 'science', 'dinosaur', 'animal', 'space', 'planet']],
  ['soc', ['역사', '한국사', '사회', '세계', '나라', '지도', '경제', '직업', '문화', '전통']],
  ['bio', ['위인', '인물', '전기']],
  ['art', ['미술', '음악', '노래', '동요', '명화', '악기', '예술', 'music', 'song', 'art']],
  ['life', ['마음', '감정', '인성', '습관', '생활', '안전', '예절', '친구', '자존감', '배변', '양치', '잠자리', 'feeling', 'emotion', 'friend']],
  ['lang', ['한글', '영어', '낱말', '글자', '말놀이', '단어', '파닉스', '천자문', '한자', 'phonics', 'alphabet', 'abc', 'words']],
  ['lit', ['동화', '명작', '전래', '이야기', '창작', '동시', 'fairy', 'tale', 'story']],
];

const TOPICS = {
  공룡: ['공룡', 'dinosaur'],
  우주: ['우주', '행성', '태양계', 'space', 'planet'],
  동물: ['동물', 'animal'],
  곤충: ['곤충', '벌레', 'insect', 'bug'],
  식물: ['식물', '나무', 'plant'],
  바다: ['바다', '물고기', 'ocean', 'sea', 'fish'],
  날씨: ['날씨', '계절', 'weather', 'season'],
  몸: ['인체', '우리 몸', 'body'],
  감정: ['마음', '감정', '기분', 'feeling', 'emotion'],
  습관: ['습관', '양치', '배변', '잠자리', '편식', 'habit'],
  안전: ['안전', 'safety'],
  친구: ['친구', 'friend'],
  가족: ['가족', 'family'],
  숫자: ['숫자', '수세기', '셈', 'number', 'count'],
  도형: ['도형', '모양', 'shape'],
  시간: ['시계', '시간', 'clock', 'time'],
  색깔: ['색깔', '색칠', 'color', 'colour'],
  탈것: ['자동차', '기차', '비행기', '탈것', '버스', 'truck', 'train', 'car'],
  음식: ['음식', '요리', '과일', '채소', 'food'],
  직업: ['직업', 'job'],
  한글: ['한글', '가나다', '글자'],
  영어: ['영어', 'english', 'phonics', '파닉스', 'abc'],
  한자: ['한자', '천자문'],
  전래동화: ['전래'],
  명작: ['명작', 'classic'],
  위인: ['위인'],
  역사: ['역사', '한국사', 'history'],
  음악: ['음악', '노래', '동요', 'music', 'song'],
  미술: ['미술', '명화', '그리기', 'art'],
};

// Hangul keywords match anywhere (Korean has no spaces inside words); Latin ones at a word start.
const hit = (text, low) => (word) => (/^[a-z]/.test(word) ? new RegExp(`\\b${word}`).test(low) : text.includes(word));

// subjects: the family's subject list ({key}), so only known keys are suggested.
export function classify({ title = '', series = '' }, subjects) {
  const text = `${title} ${series}`.replace(/\s+/g, '');
  const low = `${title} ${series}`.toLowerCase();
  const has = hit(text, low);
  const known = new Set((subjects || []).map((s) => s.key));
  const subject = SUBJECTS.find(([key, words]) => known.has(key) && words.some(has))?.[0] ?? null;
  const tags = Object.entries(TOPICS).filter(([, words]) => words.some((w) => has(w.replace(/\s+/g, '')))).map(([t]) => t);
  return { subject, tags };
}
