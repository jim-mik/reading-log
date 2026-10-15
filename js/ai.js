// Claude reads a book photo (or a short description) and returns structured fields, and suggests
// tags and a recall question for a note. Optional: only used when a Claude API key is set on this
// phone. The key stays in this phone's storage and goes only to api.anthropic.com.

import { settings } from './settings.js';
import { subjects } from './store.js';
import { LEVELS } from './catalog.js';
import { AREAS } from './notes.js';

// Official Anthropic SDK, loaded only when AI is first used (pinned version).
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.129.0/+esm';
let sdkPromise;

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (가장 정확, 기본)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (가장 저렴)' },
];

export const hasClaude = () => !!settings().claudeKey;

function system(subs, known) {
  return `You help a Korean family keep a log of the books their children read.
You get a photo of a book (front cover, back cover, spine or title page), or a short text description of a book.
Fill in every field:
- found: false if the input does not show or describe a book.
- title: exactly as printed, in the book's own language (never translate). Include series name and volume number if printed.
- authors: author and illustrator names as printed, comma-separated; "" if not visible.
- publisher: as printed; "" if not visible.
- isbn: the 13-digit ISBN only if every digit is readable (usually printed near the back-cover barcode); digits only; otherwise "". Never guess digits.
- language: the language the book's text is written in (ko, en, or etc).
- subject: the best-fitting category key from the list below.
- level: reading difficulty 1-5 on the scale below, judged from book type, text density and target age.
- pages, words: your best estimate for this book; use what you know about well-known titles; 0 if you have no basis.
- series: for a book from a series or a Korean 전집 (multi-volume set), the series name and volume number as printed (e.g. "안녕, 마음아 12"); "" otherwise.
- topics: 1 to 4 short Korean topic tags for what the book is about (nouns such as 공룡, 감정, 숫자, 탈것; no "#", no spaces). When one of the family's existing tags means the same thing, use that exact tag.${known.length ? `\nExisting tags: ${known.join(', ')}` : ''}

Difficulty scale:
${LEVELS.map((l) => `${l.n} = ${l.name} (${l.hint})`).join('\n')}

Subject keys:
${subs.map((s) => `${s.key} = ${s.label}`).join('\n')}`;
}

function schema(subjectKeys) {
  return {
    type: 'object',
    properties: {
      found: { type: 'boolean' },
      title: { type: 'string' },
      authors: { type: 'string' },
      publisher: { type: 'string' },
      isbn: { type: 'string' },
      language: { type: 'string', enum: ['ko', 'en', 'etc'] },
      subject: { type: 'string', enum: subjectKeys },
      level: { type: 'integer', enum: [1, 2, 3, 4, 5] },
      pages: { type: 'integer' },
      words: { type: 'integer' },
      series: { type: 'string' },
      topics: { type: 'array', items: { type: 'string' } },
    },
    required: ['found', 'title', 'authors', 'publisher', 'isbn', 'language', 'subject', 'level', 'pages', 'words', 'series', 'topics'],
    additionalProperties: false,
  };
}

function friendlyError(e, Anthropic) {
  if (e instanceof Anthropic.AuthenticationError) return new Error('Claude API 키가 맞지 않아요. 설정을 확인해 주세요.');
  if (e instanceof Anthropic.PermissionDeniedError) return new Error('이 API 키로는 사용할 수 없어요. 키 권한을 확인해 주세요.');
  if (e instanceof Anthropic.RateLimitError) return new Error('요청이 많아요. 잠시 후 다시 해 주세요.');
  if (e instanceof Anthropic.BadRequestError) return new Error(`Claude 요청 오류: ${e.message}`);
  if (e instanceof Anthropic.APIConnectionError) return new Error('인터넷 연결을 확인해 주세요.');
  if (e instanceof Anthropic.APIError) return new Error(`Claude 오류 (${e.status ?? '연결'}). 잠시 후 다시 해 주세요.`);
  return e;
}

async function connect() {
  const { claudeKey } = settings();
  if (!claudeKey) throw new Error('설정에서 Claude API 키를 넣어 주세요.');
  let Anthropic;
  try {
    sdkPromise ??= import(SDK_URL);
    ({ default: Anthropic } = await sdkPromise);
  } catch {
    sdkPromise = null;
    throw new Error('AI 기능을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.');
  }
  return { Anthropic, client: new Anthropic({ apiKey: claudeKey, dangerouslyAllowBrowser: true, maxRetries: 1 }) };
}

// Checks the key and model without spending tokens.
export async function testClaude() {
  const { Anthropic, client } = await connect();
  try {
    await client.models.retrieve(settings().claudeModel);
    return true;
  } catch (e) {
    throw friendlyError(e, Anthropic);
  }
}

// image: base64 JPEG (no data: prefix). text: book facts we already know.
// knownTags: the family's tags, so topics reuse the same words.
export async function readBook({ image, text, knownTags = [] }) {
  const subs = subjects();
  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } });
  content.push({ type: 'text', text: text || 'Read the book in this photo.' });
  return structured({ system: system(subs, knownTags.slice(0, 80)), content, schema: schema(subs.map((s) => s.key)) });
}

const NOTE_SYSTEM = `You help Korean parents keep notes on what their young child learned, from a book or from daily life.
You get one note, written by a parent. Return:
- tags: 1 to 4 short Korean tags naming what was learned (nouns such as 공룡, 초식동물, 색깔, 숫자세기; no "#", no spaces). When a tag from the family's existing tags means the same thing, use that exact tag.
- area: the 누리과정 area the learning belongs to:
${AREAS.map((a) => `  ${a.key} = ${a.label}`).join('\n')}
- question: one short question in Korean that a parent can ask the child a few days later to check they still remember it. Fit it to the child's age; for a 3-year-old keep it very simple, answerable with one word, a number, or by pointing.`;

const NOTE_SCHEMA = {
  type: 'object',
  properties: {
    tags: { type: 'array', items: { type: 'string' } },
    area: { type: 'string', enum: AREAS.map((a) => a.key) },
    question: { type: 'string' },
  },
  required: ['tags', 'area', 'question'],
  additionalProperties: false,
};

// Tags, a 누리과정 area and a recall question for a note. ageMonths may be null.
export async function suggestNote({ text, bookTitle, ageMonths, knownTags }) {
  const lines = [`Note: ${text}`];
  if (bookTitle) lines.push(`Book: ${bookTitle}`);
  if (ageMonths != null) lines.push(`Child's age: ${Math.floor(ageMonths / 12)} years ${ageMonths % 12} months`);
  if (knownTags?.length) lines.push(`Existing tags: ${knownTags.join(', ')}`);
  return structured({ system: NOTE_SYSTEM, content: [{ type: 'text', text: lines.join('\n') }], schema: NOTE_SCHEMA, maxTokens: 2000 });
}

async function structured({ system: sys, content, schema: outSchema, maxTokens = 8000 }) {
  const { claudeModel } = settings();
  const { Anthropic, client } = await connect();
  const params = {
    model: claudeModel,
    max_tokens: maxTokens,
    system: sys,
    messages: [{ role: 'user', content }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: outSchema } },
  };
  // If a safety check declines the request, let the API retry on a suitable model.
  // (Not offered for Haiku.)
  if (!claudeModel.startsWith('claude-haiku')) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }

  let res;
  try {
    res = await client.beta.messages.create(params);
  } catch (e) {
    throw friendlyError(e, Anthropic);
  }
  if (res.stop_reason === 'refusal') throw new Error('AI가 이 요청을 처리하지 않았어요. 직접 입력해 주세요.');
  if (res.stop_reason === 'max_tokens') throw new Error('AI 응답이 잘렸어요. 다시 해 주세요.');
  const block = res.content.find((b) => b.type === 'text');
  if (!block) throw new Error('AI 응답이 비어 있어요. 다시 해 주세요.');
  return JSON.parse(block.text);
}
