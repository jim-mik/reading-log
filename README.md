# 우리집 독서기록 (family reading log)

A Korean-language web app for logging the books the kids read (or that parents read to them).
It installs to the home screen on Galaxy S25/S26 through Chrome's "홈 화면에 추가" and works offline.

## Why a web app (PWA) instead of a native Android app

- One codebase that runs on both phones, with no Play Store or APK sideloading. An update takes effect on the next app launch.
- Chrome on Android has the camera, a built-in barcode reader (`BarcodeDetector`), offline caching and "install to home screen".
- The family's records never leave the phones: they live in the browser's IndexedDB, and backup files move them between phones.
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
- **Backup**: JSON backup and merge-import (newest edit wins, deletions carry over, the same book or read logged
  on two phones is kept once). A CSV export opens in Excel.

## Keys (all optional, entered in 설정 on each phone)

| Key | Where | What it adds |
|---|---|---|
| Kakao REST API key | developers.kakao.com → 내 애플리케이션 → 앱 키 | Korean book lookup and title autocomplete (recommended) |
| National Library cert_key | nl.go.kr → 오픈API → 인증키 신청 | Page counts and subjects for Korean books |
| Google Books key | Google Cloud console | Fewer "quota exceeded" misses for English books |
| Claude API key | console.anthropic.com | Cover-photo reading, subject/level/word-count suggestions |

Keys stay in that phone's `localStorage` and are never included in backups. The Claude key goes only to
api.anthropic.com, through the official SDK loaded from jsDelivr (`@anthropic-ai/sdk@0.129.0`, browser mode).
The model defaults to Claude Opus 5.5 and can be switched to Sonnet 5.5 or Haiku 5.5 in 설정. Requests use
low effort, structured JSON output, and the server-side refusal fallback (not sent for Haiku).

## Hosting

The phones need an HTTPS address for the camera, barcode reader and install to work. Any static host will do,
for example GitHub Pages, Netlify or Cloudflare Pages. Upload the folder as it is: there is no build step.
`tests/` and `package.json` are only for development.

## Layout

```
index.html, manifest.webmanifest, sw.js   app shell, install metadata, offline cache
css/app.css                               all styles (light + dark)
js/app.js                                 entry: tabs and rendering
js/store.js                               IndexedDB data, backup export/merge
js/lookup.js                              book catalogs (Kakao, NL, Open Library, Google)
js/ai.js                                  Claude: read a cover photo / classify a book
js/media.js                               photos, barcode detection
js/stats.js, js/chart.js                  aggregation, SVG stacked-column chart
js/views/*.js                             home, shelf, stats, settings, editor, book detail, scanner
```

## Development

```
python3 -m http.server 8765        # then open http://localhost:8765
node --test tests/*.test.js        # unit tests for dates, ISBN, levels, stats, catalog merge
```

`sw.js` caches the app for offline use. When you add a file, add it to the `SHELL` list too.
