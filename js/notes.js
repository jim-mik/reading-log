// Notes: what a child learned (from a book or not), with #tags. Pure helpers for tags and search;
// storage is in store.js, the screens in views/notes.js.

import { normTitle } from './util.js';

// 누리과정 (ages 3-5): the five areas a note can belong to. Later steps measure strengths per area.
export const AREAS = [
  { key: 'body', label: '신체운동·건강' },
  { key: 'comm', label: '의사소통' },
  { key: 'social', label: '사회관계' },
  { key: 'art', label: '예술경험' },
  { key: 'nature', label: '자연탐구' },
];
export const areaLabel = (key) => AREAS.find((a) => a.key === key)?.label ?? '';

const TAG = /#([\p{L}\p{N}_]+)/gu;

export const cleanTag = (t) => String(t || '').replace(/[^\p{L}\p{N}_]/gu, '');

export function tagsIn(text) {
  return [...new Set([...String(text || '').matchAll(TAG)].map((m) => m[1]))];
}

// A note's tags: the #words in its text plus the tags added as chips.
export const allTags = (text, extra = []) => [...new Set([...tagsIn(text), ...extra.map(cleanTag).filter(Boolean)])];

// Text split into plain parts and #tag parts, for display.
export function splitTags(text) {
  const s = String(text || '');
  const parts = [];
  let last = 0;
  for (const m of s.matchAll(TAG)) {
    if (m.index > last) parts.push({ text: s.slice(last, m.index) });
    parts.push({ tag: m[1] });
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push({ text: s.slice(last) });
  return parts;
}

// Every word must appear in the note (text, tags, page, question) or its book title.
// A word starting with # matches the start of a tag: "#공" finds #공룡.
export function matches(note, query, bookTitle = '') {
  const words = String(query || '').trim().split(/\s+/).filter(Boolean);
  const tags = (note.tags || []).map(normTitle);
  const hay = normTitle([note.text, ...(note.tags || []), note.page, note.question, bookTitle].join(' '));
  return words.every((w) => {
    const n = normTitle(w);
    if (!n) return true;
    return w.startsWith('#') ? tags.some((t) => t.startsWith(n)) : hay.includes(n);
  });
}

// [[tag, count], ...], most used first.
export function tagCounts(notes) {
  const counts = new Map();
  for (const n of notes) for (const t of n.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'));
}

// Age in months from 'YYYY-MM' (the birth month in 설정 → 가족), or null.
export function ageMonths(birth, today = new Date()) {
  const m = /^(\d{4})-(\d{2})$/.exec(birth || '');
  if (!m) return null;
  const months = (today.getFullYear() - Number(m[1])) * 12 + (today.getMonth() + 1 - Number(m[2]));
  return months >= 0 ? months : null;
}
