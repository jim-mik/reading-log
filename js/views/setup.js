// 설정: family members, subjects, search/AI keys, backup and restore.

import { h, todayStr, nowIso } from '../util.js';
import { DEFAULT_SUBJECTS } from '../catalog.js';
import * as store from '../store.js';
import { settings, updateSettings } from '../settings.js';
import { testKey } from '../lookup.js';
import { MODELS, testClaude } from '../ai.js';
import { toast, icon, readerColor, saveFile, select, langLabel } from '../ui.js';
import { APP_VERSION, installPrompt } from '../pwa.js';

function keyField({ label, key, placeholder, help, test }) {
  const result = h('span', { class: 'key-result small' });
  const input = h('input', {
    class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder,
    value: settings()[key], 'aria-label': label,
    onChange: (e) => {
      updateSettings({ [key]: e.target.value.trim() });
      result.textContent = '';
    },
  });
  return h('div', { class: 'key-field' },
    h('label', null, h('span', null, label), input),
    h('div', { class: 'key-actions' },
      h('button', {
        type: 'button', class: 'chip',
        onClick: async () => {
          updateSettings({ [key]: input.value.trim() });
          if (!input.value.trim()) return (result.textContent = '키를 먼저 넣어 주세요');
          result.textContent = '확인 중…';
          try {
            result.textContent = (await test()) ? '✓ 잘 돼요' : '✗ 응답이 이상해요. 키를 확인해 주세요';
          } catch (e) {
            result.textContent = `✗ ${e.message}`;
          }
        },
      }, '키 확인'),
      result),
    h('p', { class: 'hint' }, help));
}

function csvOf() {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['날짜', '읽은 사람', '읽어 줌', '제목', '지은이', '출판사', 'ISBN', '언어', '과목', '난이도', '쪽수', '단어 수'];
  const lines = store.reads().sort((a, b) => a.date.localeCompare(b.date)).map((r) => {
    const b = store.getBook(r.bookId);
    return [r.date, store.getReader(r.readerId)?.name, r.aloud ? 'O' : '', b.title, b.authors, b.publisher, b.isbn,
      langLabel(b.lang), b.subject ? store.subjectLabel(b.subject) : '', b.level || '', b.pages || '', b.words || ''].map(esc).join(',');
  });
  return `﻿${[head.join(','), ...lines].join('\r\n')}`;
}

export function renderSettings(root, { rerender }) {
  const stamp = todayStr().replace(/-/g, '');

  // Family
  const people = h('section', { class: 'card' },
    h('h3', null, '가족'),
    h('p', { class: 'hint' }, '아이 이름으로 바꿔 주세요. 색은 사람마다 고정이에요.'),
    store.readers().map((r) => h('div', { class: 'person' },
      h('span', { class: 'dot big', style: `background:${readerColor(r)}` }),
      h('input', {
        class: 'input', value: r.name, 'aria-label': '이름',
        onChange: (e) => e.target.value.trim() && store.saveReader({ ...r, name: e.target.value.trim() }),
      }),
      select([{ key: 'child', label: '아이' }, { key: 'parent', label: '부모' }], r.kind, (v) => store.saveReader({ ...r, kind: v }), '구분'),
      h('button', {
        class: 'icon-btn', 'aria-label': `${r.name} 빼기`,
        onClick: async () => {
          const n = store.reads().filter((x) => x.readerId === r.id).length;
          if (!confirm(n ? `${r.name}을(를) 빼면 기록 ${n}건이 통계에서 빠져요. 뺄까요?` : `${r.name}을(를) 뺄까요?`)) return;
          await store.removeReader(r.id);
        },
      }, icon('trash', 20)))),
    h('button', {
      class: 'link', onClick: () => store.saveReader({ name: `가족 ${store.readers().length + 1}`, kind: 'child' }),
    }, icon('plus', 16), '가족 추가'));

  // Subjects: the defaults stay; families can add their own.
  const subs = store.subjects();
  const custom = subs.filter((s) => !DEFAULT_SUBJECTS.some((d) => d.key === s.key));
  const newSubject = h('input', { class: 'input', placeholder: '예: 한자, 코딩', 'aria-label': '새 과목' });
  const subjects = h('section', { class: 'card' },
    h('h3', null, '과목'),
    h('div', { class: 'chips' }, subs.map((s) => h('span', { class: 'chip static' }, s.label,
      custom.includes(s) && h('button', {
        class: 'chip-x', 'aria-label': `${s.label} 지우기`,
        onClick: () => store.setSubjects(subs.filter((x) => x.key !== s.key)),
      }, icon('close', 14))))),
    h('div', { class: 'inline' }, newSubject,
      h('button', {
        class: 'btn', onClick: () => {
          const label = newSubject.value.trim();
          if (!label || subs.some((s) => s.label === label)) return;
          // New subjects go before 기타 so 기타 stays last.
          const at = subs.findIndex((s) => s.key === 'etc');
          const next = [...subs];
          next.splice(at < 0 ? next.length : at, 0, { key: `s_${Date.now().toString(36)}`, label });
          store.setSubjects(next);
        },
      }, '추가')));

  // Book search keys
  const search = h('section', { class: 'card' },
    h('h3', null, '책 정보 찾기'),
    h('p', { class: 'hint' }, '바코드를 찍으면 아래 서비스에서 책 정보를 찾아요. 영어책은 키 없이도 찾지만, 한국 책은 카카오 키가 있어야 잘 찾아요.'),
    keyField({
      label: '카카오 REST API 키 (추천)', key: 'kakaoKey', placeholder: 'REST API 키',
      help: 'developers.kakao.com에 로그인 → 내 애플리케이션 → 애플리케이션 추가 → 앱 키의 "REST API 키"를 복사해 붙여 넣으세요. 무료예요.',
      test: () => testKey('kakao'),
    }),
    keyField({
      label: '국립중앙도서관 ISBN 키 (선택)', key: 'nlKey', placeholder: 'cert_key',
      help: 'nl.go.kr → 오픈API → 인증키 신청. 한국 책의 쪽수와 분야를 채워 줘요.',
      test: () => testKey('nl'),
    }),
    keyField({
      label: 'Google Books 키 (선택)', key: 'googleKey', placeholder: 'API key',
      help: '없어도 되지만, 구글 쪽 무료 한도가 자주 차요. 있으면 영어책 쪽수를 더 잘 채워요.',
      test: () => testKey('google'),
    }));

  // AI
  const ai = h('section', { class: 'card' },
    h('h3', null, 'AI 표지 인식 (선택)'),
    h('p', { class: 'hint' }, '바코드가 없는 책도 표지만 찍으면 Claude가 제목을 읽고, 과목·난이도·단어 수를 추정해요. 키는 이 휴대폰에만 저장되고 Anthropic에만 보내져요.'),
    keyField({
      label: 'Claude API 키', key: 'claudeKey', placeholder: 'sk-ant-…',
      help: 'console.anthropic.com → API Keys에서 만들 수 있어요. 사용한 만큼 요금이 나가요 (표지 사진 1장에 대략 몇십 원, Haiku는 그보다 훨씬 적게).',
      test: testClaude,
    }),
    h('label', null, h('span', null, '모델'),
      select(MODELS.map((m) => ({ key: m.id, label: m.label })), settings().claudeModel, (v) => updateSettings({ claudeModel: v }), '모델')),
    h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: settings().aiAuto !== false, onChange: (e) => updateSettings({ aiAuto: e.target.checked }) }),
      h('span', null, '새 책을 찾으면 과목·난이도를 AI가 자동으로 채우기')));

  // Backup
  const last = settings().lastBackupAt;
  const fileInput = h('input', {
    type: 'file', accept: 'application/json,.json', hidden: true,
    onChange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const r = await store.importData(JSON.parse(await file.text()));
        toast(`합쳤어요: 책 ${r.books}권, 기록 ${r.reads}건, 가족 ${r.readers}명`);
      } catch (err) {
        toast(err instanceof SyntaxError ? '백업 파일을 읽을 수 없어요.' : err.message);
      }
      e.target.value = '';
    },
  });
  const backup = h('section', { class: 'card' },
    h('h3', null, '백업'),
    h('p', { class: 'hint' }, '기록은 이 휴대폰 안에만 있어요. 가끔 백업 파일을 만들어 구글 드라이브나 카톡 나에게 보내기로 보관하세요. 다른 가족 폰이나 새 폰에서 "백업 불러오기"를 하면 기록이 합쳐져요.'),
    h('p', { class: 'small' }, last ? `마지막 백업: ${last.slice(0, 10)}` : '아직 백업한 적이 없어요'),
    h('div', { class: 'stack' },
      h('button', {
        class: 'btn primary', onClick: async () => {
          const ok = await saveFile(`독서기록-백업-${stamp}.json`, JSON.stringify(store.exportData()), 'application/json');
          if (ok) {
            updateSettings({ lastBackupAt: nowIso() });
            toast('백업 파일을 만들었어요');
            rerender();
          }
        },
      }, '백업 파일 만들기'),
      h('button', { class: 'btn', onClick: () => fileInput.click() }, '백업 불러오기 (합치기)'),
      h('button', { class: 'btn', onClick: () => saveFile(`독서기록-${stamp}.csv`, csvOf(), 'text/csv') }, '엑셀용 CSV 내보내기')),
    fileInput);

  // About
  const persisted = h('span', null, '확인 중…');
  navigator.storage?.persisted?.().then((p) => (persisted.textContent = p ? '보호됨' : '보호 안 됨 (브라우저가 공간이 부족하면 지울 수 있어요)'))
    .catch(() => (persisted.textContent = '알 수 없음'));
  const standalone = matchMedia('(display-mode: standalone)').matches;
  const about = h('section', { class: 'card' },
    h('h3', null, '앱 정보'),
    !standalone && h('p', { class: 'hint' }, 'Chrome 메뉴(⋮) → "홈 화면에 추가"를 누르면 앱처럼 쓸 수 있어요.'),
    !standalone && installPrompt() && h('button', {
      class: 'btn primary', onClick: async () => {
        await installPrompt()?.prompt();
        rerender();
      },
    }, '홈 화면에 설치'),
    h('p', { class: 'small' }, `책 ${store.books().length}권 · 기록 ${store.reads().length}건 · 저장 공간 `, persisted),
    h('p', { class: 'small muted' }, `버전 ${APP_VERSION}`));

  root.append(h('header', { class: 'page-head' }, h('h1', null, '설정')), people, subjects, search, ai, backup, about);
}

