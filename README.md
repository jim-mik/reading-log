# 우리집 독서기록 (family reading log)

A Korean-language web app for logging the books the kids read (or that parents read to them).
It installs to the home screen on Galaxy S25/S26 through Chrome's "홈 화면에 추가" and works offline.

## Why a web app (PWA) instead of a native Android app

- One codebase that runs on both phones, with no Play Store or APK sideloading. An update takes effect on the next app launch.
- Chrome on Android has the camera, a built-in barcode reader (`BarcodeDetector`), offline caching and "install to home screen".
- The family's records live in the browser's IndexedDB on each phone. Family sync (optional) copies them to a Google Sheet
  in the family's own Google account; they go to no other server.
- If a Play Store listing is ever needed, the same site can be wrapped as a Trusted Web Activity later.

## What it does

- **Add a book**: live barcode scan, a photo of the cover or barcode, or typing a title (autocomplete shows books
  already on the shelf first, then online results). Pick who read it (several people at once), whether a parent
  read it aloud, and the dates. The date defaults to today, with 오늘 / 어제 / 그저께 quick chips (one tap when you
  log a book a day or two late) and a date picker for older days; more dates can be added.
- **Book info** comes from Kakao book search (Korean books), the National Library of Korea (the Korean ISBN
  registry, so it also knows 전집 volumes that bookstores don't list; series, page count, subject code; also used
  for title suggestions), 도서관 정보나루 (public-library catalog: 전집 volumes libraries hold, cover and subject
  from KDC — no approval wait, so it stands in while the National Library key is pending), Open Library and Google
  Books (English books).
- **전집 (multi-volume sets)**: a barcode no catalog knows is saved with the title typed once, and recognized on
  the next scan. A new ISBN numerically close to one on the shelf from the same publisher block is treated as
  the same set: its series name, publisher, subject, level and tags are filled in. Books have a series field.
- **언어 and 과목** are chosen automatically from the title as you type (Korean/English by script; subject by the
  keyword rules below). A value you pick yourself, or one a catalog/AI provides, is never overwritten.
- When you type a title that isn't in the suggestions, the list offers a **"이 제목 그대로 쓰기"** row; tapping it
  keeps your text and closes the phone keyboard.
- **Subject and topic tags** are filled automatically from the title and series name by keyword rules
  (`js/classify.js`; no AI needed), refined by Claude when a key is set (it reuses the family's existing tags).
  설정 → 책 자동 분류 fills empty subjects and tags of books already on the shelf. The shelf search takes #tags.
- **Barcode scanner**: main back camera, continuous autofocus, 2x zoom by default (1x/2x/3x buttons), torch,
  tap to focus; barcodes are looked for inside the on-screen frame at full resolution.
- **AI (optional)**: with a Claude API key, a cover photo with no barcode is read by Claude. Claude also
  suggests the subject, difficulty and word count for new books.
- **Difficulty**: 5 steps (그림책 → 소설·지식책). The step is suggested from the word count or page count, or by AI,
  and can always be changed by hand. English books also have a free-text field for AR/Lexile levels.
- **Shelf**: search, filters for read / not read by a given person, language, subject.
- **Stats**: today / this week / month / year / all-time totals, plus a 서로 다른 책 row counting distinct books
  (re-reads counted once); stacked columns by day (14 days), week, month or year, split by person,
  language, subject, difficulty or read-aloud; counted in books, pages or words; most-read books;
  progress through the shelf for each person.
- **Notes** (노트 tab, and on each book's page): what a child learned, from a book or not. Text with #tags, up to
  4 photos (shrunk to about 1024px), who learned it, page, date, the 누리과정 area (ages 3-5), and a question to ask
  the child later. Search by word, book title or #tag; tag chips filter. With a Claude key, Claude suggests tags
  (reusing the family's existing ones), the area and the question, using the child's age from 설정 → 가족.
  This is step 1 of tracking what each child learned and forgot; recall checks come next.
- **Family sync** (optional): both parents' phones share one set of records through a Google Sheet, and the sheet
  shows them as readable tables. See below.
- **Edit a reading record**: tap an entry in a book's 읽은 기록 list (or a single-read row in the home 최근 기록
  list) to change its date (오늘/어제/그저께 chips + picker), who read it, or read-aloud, or delete it.
- **Backup**: JSON backup and merge-import (newest edit wins, deletions carry over, the same book or read logged
  on two phones is kept once). A CSV export opens in Excel.

## Keys (all optional, entered in 설정 on each phone)

| Key | Where | What it adds |
|---|---|---|
| Kakao REST API key | developers.kakao.com → 내 애플리케이션 → 앱 → 플랫폼 키 → REST API 키 (leave 허용 IP empty) | Korean book lookup and title autocomplete (recommended) |
| National Library cert_key | nl.go.kr → 도서관 서비스 → Open API → 인증키 신청 (needs approval) | 전집 volumes and other Korean ISBNs bookstores don't list, series, page counts, subjects |
| 도서관 정보나루 authKey | data4library.kr → 데이터활용 → 인증키 신청 | 전집 volumes public libraries hold, covers, subjects — a quicker-to-get stand-in for the National Library key |
| Google Books key | Google Cloud console | Fewer "quota exceeded" misses for English books |
| Claude API key | console.anthropic.com | Cover-photo reading, subject/level/word-count suggestions |

Keys stay in that phone's `localStorage` and are never included in backups. The Claude key goes only to
api.anthropic.com, through the official SDK loaded from jsDelivr (`@anthropic-ai/sdk@0.129.0`, browser mode).
The model defaults to Claude Opus 5.5 and can be switched to Sonnet 5.5 or Haiku 5.5 in 설정. Requests use
low effort, structured JSON output, and the server-side refusal fallback (not sent for Haiku).

## Family sync (Google Sheet)

One parent sets it up once on a PC; the steps are in the app under 설정 → 가족 동기화 → 처음 설정하는 방법:

1. Create an empty Google Sheet, open 확장 프로그램 → Apps Script, and replace `Code.gs` with
   [`sync/apps-script.js`](sync/apps-script.js). If that menu isn't there (phone app, hidden menu bar, an .xlsx file,
   or a work account), start a new project at script.google.com instead: the script then creates a "독서기록" sheet
   in My Drive the first time a phone connects.
2. 배포 → 새 배포 → 웹 앱, run as "나" with access "모든 사용자", then approve the permissions (Google warns that the
   app is unverified, because it is your own script).
3. Paste the web app URL (`…/exec`) into the app on the first phone and press 연결. That phone then sends its
   connection code (URL + family key) to the other phone through 다른 폰 연결하기.

How it works:

- Each record changed on a phone goes into an outbox (IndexedDB) and is sent about 1.5 s later, or when the phone is
  back online. Phones also pull when the app opens, when it comes back to the screen, and every 3 minutes while open.
- The script appends every version to a hidden `_log` tab and never edits old rows; a phone pulls the rows after its
  cursor. Conflicts are settled on the phones by the same rules as backup import (`js/merge.js`): newer `updatedAt`
  wins; the same title typed on both phones (no ISBN) becomes one book, keeping the one added first; the same
  reader + book + date is kept once.
- The 독서기록 and 책장 tabs are rebuilt from the log after each change and when the sheet is opened (menu
  독서기록 → 표 새로 고침 does it on demand). Editing those tabs does not change the app.
- Access is the web app URL plus a random family key that the first phone registers. Anyone with the connection code
  can read and change the records, so it should only go to family. To start over with a new key, delete the
  `familyKey` script property (Apps Script → 프로젝트 설정 → 스크립트 속성) and connect again.
- After changing the script, update it with 배포 관리 → 수정 → 새 버전. 새 배포 would create a new URL.
- The script reports a protocol number. Protocol 1 (before notes) silently drops tables it doesn't know, so phones
  send notes and photos only to protocol 2 or later; until then they wait in the outbox and 설정 asks for the new
  script. Notes and photos also appear on the sheet's 노트 tab (photos only as a count).
- Why not Notion or Firebase: Notion's API can't be called from a browser app (no CORS), so it would need a
  separate server. Firebase would give live updates, but needs a Google login on each phone and its own console
  setup, and the records can't be read as a spreadsheet.

## Hosting

The phones need an HTTPS address for the camera, barcode reader and install to work. Any static host will do,
for example GitHub Pages, Netlify or Cloudflare Pages. Upload the folder as it is: there is no build step.
`tests/` and `package.json` are only for development.

## Layout

```
index.html, manifest.webmanifest, sw.js   app shell, install metadata, offline cache
css/app.css                               all styles (light + dark)
js/app.js                                 entry: tabs and rendering
js/store.js                               IndexedDB data, sync outbox, backup export
js/merge.js                               merge rules for sync and backup import
js/sync.js                                family sync with the Google Sheet
js/notes.js                               note tags, search, 누리과정 areas
js/lookup.js                              book catalogs (Kakao, NL, Open Library, Google)
js/classify.js                            subject and topic tags from a title, without AI
js/ai.js                                  Claude: read a cover photo / classify a book
js/media.js                               photos, barcode detection
js/stats.js, js/chart.js                  aggregation, SVG stacked-column chart
js/views/*.js                             home, shelf, notes, stats, settings, editor, book detail, scanner, read-edit
sync/apps-script.js                       the Google Apps Script sync server (pasted into the family's sheet)
```

## Development

```
python3 -m http.server 8765        # then open http://localhost:8765
node --test tests/*.test.js        # unit tests: dates, ISBN, levels, stats, catalog merge, sync, notes
```

`tests/sync.test.js` runs the merge rules, and `sync/apps-script.js` on an in-memory fake of Google Sheets
(`tests/fake-apps-script.js`). It also simulates two phones editing offline and syncing in random order, and checks
that they end up with the same records.

`sw.js` caches the app for offline use. When you add a file, add it to the `SHELL` list too.
