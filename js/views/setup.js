// 설정: family members, subjects, search/AI keys, family sync, backup and restore.

import { h, todayStr, nowIso } from '../util.js';
import { DEFAULT_SUBJECTS } from '../catalog.js';
import { classify } from '../classify.js';
import * as store from '../store.js';
import { settings, updateSettings } from '../settings.js';
import { testKey } from '../lookup.js';
import { MODELS, testClaude } from '../ai.js';
import { toast, icon, readerColor, saveFile, select, langLabel } from '../ui.js';
import { APP_VERSION, installPrompt } from '../pwa.js';
import * as sync from '../sync.js';

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

function ago(iso) {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  if (min < 24 * 60) return `${Math.round(min / 60)}시간 전`;
  return iso.slice(0, 10);
}

function setupSteps() {
  const code = new URL('sync/apps-script.js', location.href).href;
  return h('details', { class: 'more' },
    h('summary', null, '처음 설정하는 방법 (PC에서 5분)'),
    h('ol', { class: 'steps' },
      h('li', null, 'PC 크롬에서 구글 드라이브 → 새로 만들기 → Google 스프레드시트로 빈 시트를 만들어요. 이름은 "독서기록"처럼 자유롭게 지어요. (휴대폰 시트 앱에는 다음 단계의 메뉴가 없어요.)'),
      h('li', null, '시트 위쪽 메뉴에서 확장 프로그램 → Apps Script를 열어요. 메뉴가 안 보이면 아래 "메뉴가 없을 때"를 보세요.'),
      h('li', null, '편집기에 있는 코드를 모두 지우고, 아래 주소의 코드를 전부 복사해 붙여 넣은 뒤 저장해요.',
        h('br'), h('a', { href: code, target: '_blank', rel: 'noopener', class: 'break' }, code)),
      h('li', null, '오른쪽 위 배포 → 새 배포 → 유형 선택(톱니바퀴) → 웹 앱을 골라요. 실행은 "나", 액세스 권한이 있는 사용자는 "모든 사용자"로 두고 배포를 눌러요.'),
      h('li', null, '액세스 승인 → 계정 선택. "Google에서 확인하지 않은 앱" 화면이 나오면 고급 → "…(으)로 이동(안전하지 않음)" → 허용을 눌러요. 직접 붙여 넣은 코드가 내 시트에 기록을 쓰는 권한이에요.'),
      h('li', null, '"/exec"로 끝나는 웹 앱 URL을 복사해 이 폰으로 보내고(카톡 나에게 보내기 등), 위 칸에 붙여 넣고 연결을 눌러요.'),
      h('li', null, '다른 가족 폰은 이 폰의 "다른 폰 연결하기"로 받은 연결 코드를 붙여 넣으면 돼요.')),
    h('p', { class: 'small' }, h('b', null, '메뉴가 없을 때: '),
      '오른쪽 위의 ⌃ 버튼(메뉴 숨기기)을 눌러 메뉴를 펼쳐 보세요. 제목 옆에 .XLSX가 붙은 엑셀 파일이면 파일 → Google 스프레드시트로 저장한 시트에서 하세요. ',
      '그래도 없으면 1~2번 대신 PC에서 script.google.com → 새 프로젝트로 시작해도 돼요. 시트는 처음 연결할 때 내 드라이브에 "독서기록"으로 저절로 생겨요. ',
      '회사 구글 계정은 Apps Script가 막혀 있을 수 있으니 개인 Gmail 계정을 쓰세요.'));
}

function syncCard(rerender) {
  const card = h('section', { class: 'card' }, h('h3', null, '가족 동기화'));
  if (!sync.linked()) {
    const input = h('input', {
      class: 'input', placeholder: 'https://script.google.com/macros/s/…/exec', autocomplete: 'off', spellcheck: 'false',
      'aria-label': '동기화 주소',
    });
    const msg = h('p', { class: 'small key-result' });
    const button = h('button', {
      class: 'btn primary', onClick: async () => {
        if (!input.value.trim()) return (msg.textContent = '주소나 연결 코드를 먼저 붙여 넣어 주세요');
        button.disabled = true;
        msg.textContent = '연결하는 중…';
        try {
          await sync.connect(input.value);
          toast(sync.syncStatus().state === 'ok' ? '연결했어요. 기록을 맞췄어요' : '연결했어요');
          rerender();
        } catch (e) {
          msg.textContent = `✗ ${e.message}`;
        } finally {
          button.disabled = false;
        }
      },
    }, '연결');
    card.append(
      h('p', { class: 'hint' }, '엄마·아빠 폰의 기록을 구글 시트 하나로 자동으로 합쳐요. 시트에서 기록을 표로 볼 수도 있어요. 처음 한 번은 아래 방법대로 시트를 만들어야 해요.'),
      h('label', null, h('span', null, '동기화 주소 또는 연결 코드'), input),
      button, msg, setupSteps());
    return card;
  }

  const line = h('p', { class: 'status' });
  const notice = h('p', { class: 'banner', hidden: !sync.needsNewScript() }, sync.OLD_SCRIPT);
  const paint = () => {
    notice.hidden = !sync.needsNewScript();
    const st = sync.syncStatus();
    const s = settings();
    const error = st.state === 'error' || (st.state !== 'busy' && st.state !== 'offline' && s.syncError);
    line.className = `status${st.state === 'busy' ? ' busy' : error ? ' error' : st.state === 'offline' ? '' : ' ok'}`;
    line.textContent = st.state === 'busy' ? '기록을 맞추는 중…'
      : st.state === 'offline' ? st.message
        : error ? `✗ ${st.message || s.syncError}`
          : s.syncAt ? `✓ 연결됨 · 마지막 동기화 ${ago(s.syncAt)}` : '✓ 연결됨';
  };
  paint();
  const off = sync.onStatus(() => (line.isConnected ? paint() : off()));

  const share = async () => {
    const code = sync.connectionCode();
    if (navigator.share) {
      try {
        return await navigator.share({ title: '독서기록 연결 코드', text: code });
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(code);
      toast('연결 코드를 복사했어요');
    } catch {
      prompt('연결 코드를 복사해 주세요', code);
    }
  };
  const sheet = settings().syncSheetUrl;
  card.append(
    h('p', { class: 'hint' }, '이 폰의 기록이 구글 시트로 자동으로 가고, 다른 폰의 기록도 받아 와요. 시트의 "독서기록"·"책장" 탭에서 기록을 표로 볼 수 있어요.'),
    line,
    notice,
    h('div', { class: 'stack' },
      h('button', { class: 'btn primary', onClick: () => sync.syncNow() }, '지금 동기화'),
      h('button', { class: 'btn', onClick: share }, '다른 폰 연결하기 (연결 코드 보내기)'),
      sheet && h('a', { class: 'btn', href: sheet, target: '_blank', rel: 'noopener' }, '구글 시트 열기')),
    h('p', { class: 'hint' }, '연결 코드가 있으면 기록을 보고 고칠 수 있어요. 가족에게만 보내 주세요.'),
    h('button', {
      class: 'link small', onClick: () => {
        if (!confirm('연결을 끊어도 이 폰의 기록은 그대로 남아요. 끊을까요?')) return;
        sync.disconnect();
        rerender();
      },
    }, '연결 끊기'));
  return card;
}

export function renderSettings(root, { rerender }) {
  const stamp = todayStr().replace(/-/g, '');

  // Family
  const people = h('section', { class: 'card' },
    h('h3', null, '가족'),
    h('p', { class: 'hint' }, '아이 이름으로 바꿔 주세요. 색은 사람마다 고정이에요. 아이의 태어난 달을 넣으면 AI가 나이에 맞는 질문을 만들어요.'),
    store.readers().map((r) => h('div', { class: 'person-block' }, h('div', { class: 'person' },
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
      }, icon('trash', 20))),
      r.kind === 'child' && h('label', { class: 'birth' }, h('span', null, '태어난 달'), h('input', {
        class: 'input', type: 'month', value: r.birth || '', max: todayStr().slice(0, 7), 'aria-label': `${r.name} 태어난 달`,
        onChange: (e) => store.saveReader({ ...r, birth: e.target.value }),
      })))),
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
      help: 'developers.kakao.com에 로그인 → 내 애플리케이션 → 애플리케이션 추가 → 앱 → 플랫폼 키의 "REST API 키"를 복사해 붙여 넣으세요. 무료예요. 허용 IP 설정은 비워 두세요 (휴대폰의 IP는 계속 바뀌어요).',
      test: () => testKey('kakao'),
    }),
    keyField({
      label: '국립중앙도서관 ISBN 키 (선택)', key: 'nlKey', placeholder: 'cert_key',
      help: '한국 ISBN을 발급하는 곳이라, 전집처럼 서점 목록에 없는 책도 바코드와 제목으로 찾아요. 쪽수와 분야도 채워 줘요. nl.go.kr 회원가입 → 도서관 서비스 → Open API → 인증키 신청 (승인까지 시간이 걸릴 수 있어요).',
      test: () => testKey('nl'),
    }),
    keyField({
      label: 'Google Books 키 (선택)', key: 'googleKey', placeholder: 'API key',
      help: '없어도 되지만, 구글 쪽 무료 한도가 자주 차요. 있으면 영어책 쪽수를 더 잘 채워요.',
      test: () => testKey('google'),
    }));

  // Subject and tags for books already on the shelf, from their titles. Only empty ones, so a
  // subject or tag someone chose (or removed) stays as it is.
  const sortable = () => store.books().map((b) => {
    const r = classify(b, store.subjects());
    const patch = {};
    if (!b.subject && r.subject) patch.subject = r.subject;
    if (!b.tags?.length && r.tags.length) patch.tags = r.tags;
    return Object.keys(patch).length ? { id: b.id, ...patch } : null;
  }).filter(Boolean);
  const pending = sortable().length;
  const sorting = h('section', { class: 'card' },
    h('h3', null, '책 자동 분류'),
    h('p', { class: 'hint' }, '새 책은 제목과 전집 이름으로 과목과 태그(주제)를 자동으로 골라요. Claude 키가 있으면 AI가 더 정확하게 골라요. 이미 책장에 있는 책도 한 번에 채울 수 있어요 (비어 있는 과목과 태그만 채워요).'),
    h('button', {
      class: 'btn', disabled: !pending,
      onClick: async () => {
        const n = await store.updateBooks(sortable());
        toast(`${n}권에 과목·태그를 채웠어요`);
      },
    }, pending ? `책장 ${pending}권 분류하기` : '분류할 책이 없어요'));

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
      h('span', null, 'AI가 자동으로 제안하기 (새 책의 과목·난이도, 노트의 태그·질문)')));

  // Backup
  const last = settings().lastBackupAt;
  const fileInput = h('input', {
    type: 'file', accept: 'application/json,.json', hidden: true,
    onChange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const r = await store.importData(JSON.parse(await file.text()));
        toast(`합쳤어요: 책 ${r.books}권, 기록 ${r.reads}건, 가족 ${r.readers}명${r.notes ? `, 노트 ${r.notes}개` : ''}`);
      } catch (err) {
        toast(err instanceof SyntaxError ? '백업 파일을 읽을 수 없어요.' : err.message);
      }
      e.target.value = '';
    },
  });
  const backup = h('section', { class: 'card' },
    h('h3', null, '백업'),
    h('p', { class: 'hint' }, sync.linked()
      ? '가족 동기화가 켜져 있어서 기록이 구글 시트에도 있어요. 백업 파일은 따로 보관해 두는 사본이에요.'
      : '기록은 이 휴대폰 안에만 있어요. 가끔 백업 파일을 만들어 구글 드라이브나 카톡 나에게 보내기로 보관하세요. 다른 가족 폰이나 새 폰에서 "백업 불러오기"를 하면 기록이 합쳐져요.'),
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

  root.append(h('header', { class: 'page-head' }, h('h1', null, '설정')), people, syncCard(rerender), subjects, search, sorting, ai, backup, about);
}

