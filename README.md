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
  read it aloud, and the dates. The date defaults to today, and more dates can be added.
- **Book info** comes from Kakao book search (Korean books), the National Library of Korea (page count and subject
  code from the ISBN add-on code), Open Library and Google Books (English books).
- **AI (optional)**: with a Claude API key, a cover photo with no barcode is read by Claude. Claude also
  suggests the subject, difficulty and word count for new books.
- **Difficulty**: 5 steps (그림책 → 소설·지식책). The step is suggested from the word count or page count, or by AI,
  and can always be changed by hand. English books also have a free-text field for AR/Lexile levels.
- **Shelf**: search, filters for read / not read by a given person, language, subject.
- **Stats**: this week / month / year / all-time totals; stacked columns by week, month or year, split by person,
  language, subject, difficulty or read-aloud; counted in books, pages or words; most-read books;
  progress through the shelf for each person.
- **Family sync** (optional): both parents' phones share one set of records through a Google Sheet, and the sheet
  shows them as readable tables. See below.
- **Backup**: JSON backup and merge-import (newest edit wins, deletions carry over, the same book or read logged
  on two phones is kept once). A CSV export opens in Excel.

## Keys (all optional, entered in 설정 on each phone)

| Key | Where | What it adds |
|---|---|---|
| Kakao REST API key | developers.kakao.com → 내 애플리케이션 → 앱 → 플랫폼 키 → REST API 키 (leave 허용 IP empty) | Korean book lookup and title autocomplete (recommended) |
| National Library cert_key | nl.go.kr → 오픈API → 인증키 신청 | Page counts and subjects for Korean books |
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
js/lookup.js                              book catalogs (Kakao, NL, Open Library, Google)
js/ai.js                                  Claude: read a cover photo / classify a book
js/media.js                               photos, barcode detection
js/stats.js, js/chart.js                  aggregation, SVG stacked-column chart
js/views/*.js                             home, shelf, stats, settings, editor, book detail, scanner
sync/apps-script.js                       the Google Apps Script sync server (pasted into the family's sheet)
```

## Development

```
python3 -m http.server 8765        # then open http://localhost:8765
node --test tests/*.test.js        # unit tests: dates, ISBN, levels, stats, catalog merge, sync
```

`tests/sync.test.js` runs the merge rules, and `sync/apps-script.js` on an in-memory fake of Google Sheets
(`tests/fake-apps-script.js`). It also simulates two phones editing offline and syncing in random order, and checks
that they end up with the same records.

`sw.js` caches the app for offline use. When you add a file, add it to the `SHELL` list too.
