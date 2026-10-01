# Omnipresent God of War — 十方武圣 · English translation project

Reader + translation pipeline for the Chinese novel **十方武圣** (`D:\Novel\十方武圣_pages.txt`),
a ~2.9 M character / 8.8 MB web-scraped dump.

```
D:\Novel\
├─ 十方武圣_pages.txt          raw scrape (2,830 page markers, untouched)
└─ novelity\
   ├─ index.html               the reader  (Library list + Reader view)
   ├─ css\style.css            dark UI modelled on the reference screenshots
   ├─ js\db.js                 IndexedDB storage layer (the chapter list)
   ├─ js\app.js                library / reader logic
   ├─ assets\
   │   ├─ cover.png            cover art, 112×149 (the 1200×1600 master is in _backup\)
   │   └─ cover.svg            the same cover as a 1.8 KB vector — and the tab icon
   ├─ data\
   │   └─ novel-data.js        generated chapter index for the reader (~264 KB)
   ├─ sources\                 ONE FOLDER PER CHAPTER
   │   ├─ index.json           the edition's chapter list (tools\split-chapters.py)
   │   ├─ chapter_0001\original.zh.txt   ← Chinese chapter (translation input)
   │   └─ chapter_0904\original.zh.txt
   ├─ Doer\
   │   ├─ doer.py              the batch translator
   │   └─ Result\chapter_0001\chapter_0001.txt   ← ENGLISH CHAPTER (the deliverable)
   ├─ tools\                   build-data.mjs, serve.mjs, split-chapters.py,
   │                           chapter-titles.json, glossary.json
   └─ tests\                   check-dom.mjs, smoke.mjs
```

## 0. Current state: the reader runs on the per-chapter edition

> **This is the layout the reader uses today.** Sections 1–2 below describe the page
> scrape the project started from: the page folders (`sources/page_XXXX/`),
> `data/outline.json` and `tools/split.mjs` belong to that retired layout and are no
> longer read by the app, by `tools/build-data.mjs` or by the tests.

```
sources\ 
├─ index.json                        chapter index of the proof-read edition (884 chapters)
├─ _front_matter\original.zh.txt     title / author / 简介, the text before 第1章
└─ chapter_0001\original.zh.txt      five `#` header lines + the body, one paragraph per line
   …
   chapter_0904\original.zh.txt
Doer\Result\chapter_0001\chapter_0001.txt    the English chapter (one paragraph per line)
…     chapter_0904\chapter_0904.txt
data\novel-data.js                   the seed: the chapter index only, ~264 KB, no chapter text
```

* **884 chapters**, numbers 1–904 (766–785 do not exist in the edition), 111,045
  paragraphs, 2,925,420 Chinese characters — and every chapter has its source file.
* One chapter is **one file on each side**: the Chinese in `sources/chapter_NNNN/` and
  the English in `Doer/Result/chapter_NNNN/`. `tools/build-data.mjs` marks a chapter
  translated when that English file exists and holds at least one non-comment line.
* **Every number on a row comes from that English file.** `translated` says the run has
  written it, and `paragraphs` / `words` are what it holds; a chapter the run has not
  reached carries `null` for both and reads *not translated yet*. The row's only other
  source is the edition's chapter list, for its number, order and heading. The build does
  not read the raw Chinese at all, so nothing off the scrape reaches IndexedDB, and the
  size of the Chinese shown under a chapter is counted from that file when it arrives
  rather than remembered from a scan.
* The reader stores **no chapter text**: it fetches the chapter's two files when you
  open it, so a fresh translation is on screen the moment the file is there. The list and
  its counters come from the seed, so run `node tools/build-data.mjs` to refresh them
  (the row mark, the reading position and the list itself live in IndexedDB).
* **The single-page view is gone.** It showed one source page per screen, and those
  page folders no longer exist. One chapter is one document with a
  `‹ Raw | Translated ›` switch for its two texts.
* Titles: `tools/chapter-titles.json` is a chapter number mapped to its English title —
  **all 884 chapters have one**, and the 上 / 下 (一 / 二) halves render as
  `(Part 1)` / `(Part 2)`. A number left out of it keeps its Chinese heading instead, so
  nothing ever reads half-translated.

### Current pipeline

```powershell
py tools\split-chapters.py        # proof-read .txt -> sources\chapter_NNNN\original.zh.txt + index.json
#   ... translate chapter by chapter into Doer\Result\chapter_NNNN\chapter_NNNN.txt ...
node tools\build-data.mjs         # chapter list + Result\ + chapter-titles.json -> data\novel-data.js (~264 KB)
node tools\serve.mjs 8080         # then open http://localhost:8080/
```

## 1. The page scrape this started from (retired)

`tools/split.mjs` repairs two scraping artefacts and reports them:

| finding | detail |
| --- | --- |
| page markers | 2,772 of the 2,830 numbers survive; 58 numbers are missing entirely (their marker + text were already removed upstream — no text is lost with them) |
| duplicated pages | **936** pages are byte-identical copies of the page before them (from page ~66 on, the page after every content page repeats it — the artefact stops at page 212; pages 213–279 survive almost intact, and from 281 on only the odd-numbered pages are left) → dropped |
| unique pages | **1,836**, ids keep the *original* page numbers so content stays traceable |
| chapters | 570 marker numbers found; the novel publishes each chapter as 上 / 下 parts → rendered as `Part 1` / `Part 2` |
| volume | 1,950,506 Chinese characters |
| **torn pages (known gap)** | the 936 duplicated pages are a *lost* capture, not a harmless repeat: **334 of the 904 chapter numbers have no marker anywhere in the file** (38, 39, 42, 44 … 22, 24, 27, 29 …), and some surviving pages open mid-sentence with the opening words nowhere in the scrape (e.g. page 112 begins `弩般弹射而出`, while page 110 ends on a closed quotation — chapters 38–39 fall in that hole). Nothing can be recovered from this file; the translation bridges such tears in prose and never invents events. |

Each unique page is written to `sources/page_XXXX/` **with its original page number**,
so `page_0067` is the same page as `===== page 67 =====` in the raw file.

## 2. Translation files (the deliverable)

`sources/page_XXXX/page_XXXX.txt` holds the **English translation**:

* one paragraph per line (blank lines are ignored, so the line is the paragraph);
* a line `== Chapter 2 · Hope ==` marks a chapter that *starts in the middle of the page*
  (the build counts these and warns if they do not match the source's chapter breaks);
* names stay romanised (Wei He, Wei Ying, Wei Chun, Chen Biao, Feiye City, Huaxia),
  objects / arts / gangs are translated (Realm Breaking Bead, Internal Cultivation Method,
  Black Water Gang, Mountain Fist, Lecture Hall);
* recurring renderings are locked in `tools/glossary.json` and shown in the reader's
  **Glossary** tab (356 terms).

`original.zh.txt` in the same folder is the untouched Chinese page — it is the input for
the translation and is also used as the reader's fallback text for untranslated pages.

**That page-by-page progress is history.** The pipeline works per chapter now, and its state
is read from `Doer/Result/` on every build: `node tools/build-data.mjs` prints how many of the
884 chapters are translated. `Doer/Result/` is the run's progress marker — a fresh
`Doer/doer.py` run starts at chapter 1 and resumes at the first chapter it has no answer for.
Chapter titles live in `tools/chapter-titles.json`.

## 3. Pipeline

```powershell
cd D:\Novel\novelity
# RETIRED: node tools\split.mjs  -> sources\page_XXXX\original.zh.txt + data\outline.json
#   ... write the English text into Doer\Result\chapter_NNNN\chapter_NNNN.txt ...
node tools\build-data.mjs     # sources + Result + titles -> data\novel-data.js   (~240 KB)
node tools\serve.mjs 8080     # then open http://localhost:8080/
```

This is the retired page pipeline — **section 0 has the current one**. `tools\split.mjs`,
`tools\check-translations.mjs` and `data\outline.json` all belong to the page layout and are
no longer used; `tools\build-data.mjs` reports missing sources, empty translations and orphan
result folders itself.
`tools\analyze.mjs` and `tools\inspect.mjs` are the diagnostic scripts that found the
duplicate pages, the numbering gaps and the chapter-part conventions (they only read the
raw scrape).

## 4. The reader

* **Library view** — novel card (cover, rating, “Reading” pill), tabs
  (`Translation / Batch / Glossary / Rules / Info`), search box, `Filters` popover,
  `Ascending / Descending` sort, `CONTINUE READING` card and the chapter list. A row
  carries **no status chip**: its 3px left edge is the read mark and turns green only
  once the reader has opened that chapter, so nothing is marked up front. The whole list —
  rows, read mark and kebab — is on a **4px radius**.
  The list is paged in **ranges of 50 chapters** — the pill pager
  (`‹ 1 2 3 ›`) keeps **three range numbers on screen** and fills in the open one. It
  slides by one per SVG-arrow click (`1 2 3` → `2 3 4`), and a number keeps the slot it was
  clicked in — the third stays third, the first stays first, nothing jumps to the front.
  The pager is the last block of the list itself (`position: relative`, in the list flow,
  without a bar container), so it scrolls away with the chapters instead of hanging over
  them; its caption names the open range (`Chapters 1–50 · tab 1 of 19`) and a search jumps
  to the range that holds the first hit.
* **Reader view** — the reader bar is **two icons and nothing else**: the back arrow at the
  left and the `⋮` pinned to the bar's **top-right corner**, a whole bar away from it. Under
  the bar the chapter names itself in its own head — the chapter title, then the project: the
  site (`novelity.vercel.com`) as plain **white, un-underlined** text with the white
  `Credit: Im Boravath` **chip (120×30, 6px radius)** right under it — then the save / copy /
  re-read tools and the wide, short-radius `‹ Raw | Translated ›` switch. The text is the
  chapter's own file (`Doer/Result/chapter_XXXX/chapter_XXXX.txt`, or the Chinese in
  `sources/` under Raw), a green progress bar shows where the chapter sits in the novel, and
  **two round SVG arrow buttons** sit at the two ends of the bottom bar (also `←` / `→`, swipe,
  and `Esc` to go back). **No file path and no status badge is printed on the page**: the `⋮`
  menu is where a chapter's provenance is spelled out (both files, the paragraph/word/character
  counts — `showChapterInfo`).
* **Reading mode** — the first real scroll folds the app bar and the arrow bar away and the
  text takes the room they free (both collapse to zero height, so the chapter really fills
  the screen — no empty strip is left behind; the 3-px progress line stays as the only
  cue). A **double click**, the same gesture as two quick taps, or keyboard focus brings
  them back, and every chapter opens with the bars visible. The CSS folds to the heights
  measured off the live layout, so it is exact on any font size or safe-area inset.
* A chapter the run has not reached shows one centered card in its place — with no path on the
  page: the `⋮` menu names the file it waits for. Its Chinese is one tap away under **Raw**.
  The head rides on the chapter, so it scrolls away with the text instead of following the screen.
* **A click is answered in the same frame.** Opening a chapter paints the head, the bar and
  the counters straight off the list row — which already knows the chapter — and the two
  files fill the body when they land, so there is no blank page and never a spinner first.
* **A reload puts the reader back where it was.** The chapter and the line this tab is
  reading are kept in `sessionStorage`, so a reload returns to that chapter at that line
  rather than to the top of the library — which is exactly what an editor's live reload
  (VS Code *Live Server* / *Live Preview* reloads the page whenever a file under it changes,
  and `Doer` writes files while it runs) would otherwise do to a chapter in mid-read.
  `sessionStorage` dies with the tab, so a fresh visit still opens on the library.

### Speed: what a page load actually costs

Measured with a CDP probe on headless Chrome against `tools/serve.mjs` (numbers from the last
run; the probe wrote them, not a screenshot):

| | cold — empty cache, first open | warm — reload, nothing changed |
| --- | --- | --- |
| bytes over the wire | **115 KB** — seed 47 KB (that is 264 KB of JSON, gzipped), cover 28 KB, app.js 16 KB, CSS 6 KB, HTML + db.js 6 KB | **~11 KB** — the chapter's own two files; every app file answers `304 Not Modified` (~0.3 KB each) |
| chapter text after a click | 80 ms (measured while the one-time IndexedDB write was running) | **6 ms** |
| long tasks | one ~110 ms task, the first write of the 884 rows into IndexedDB | none |

The same probe on the build before this pass: **~2.15 MB per load, every load** — a 1.85 MB
1200×1600 cover PNG drawn into a 56×72 box, re-downloaded because every response was
`cache-control: no-store`.

What changed:

* the cover is the same art at 112×149 (**29 KB**, the 1200×1600 master is in `_backup/cover-1200x1600.png`);
* `tools/serve.mjs` sends an ETag and answers `304 Not Modified`, and gzips text — the 264 KB seed
  goes out as 47 KB;
* chapter text is the one thing that is never cached: `sources/**` and `Doer/**` are read fresh, so a
  chapter the run has just written is on screen the moment it is opened (the reader's ↻ re-reads it
  without a reload);
* the four tab panels used to be built at boot — the glossary's 356 rows among them — for a reader who
  came for the chapter list. A panel is built when its tab is opened now;
* boot no longer waits on a database read before painting the list, and the 884-row IndexedDB write is
  one transaction (was six) scheduled into the browser's idle time. Nothing the reader needs waits for
  it: the chapters are in memory and the read marks are in `localStorage`;
* opening a chapter paints the head and the tools from the list row in the same frame, and
  the files fill the body when they land — a click is never a blank page;
* the tab icon is the 1.8 KB `assets/cover.svg`, so no `favicon.ico` 404 is requested at all.

### Storage: IndexedDB, not localStorage

`data/novel-data.js` is a **chapter index** (~264 KB), not the text. `localStorage` caps out
around 5 MB total and is synchronous, so `js/db.js` keeps the list in IndexedDB — database
`novelity`, stores `chapters` (884 rows) and `meta` (`seed` + `progress`). Storage version 2
deletes the old `pages` store, which held ~6 MB of page text the reader no longer reads.

A `chapters` row is the index row `tools/build-data.mjs` built: the chapter's number, order and
headings off the edition's chapter list, and `translated` / `paragraphs` / `words` from the English
chapter in `Doer/Result`. No chapter text is in the database, and no number on a row comes from the
raw scan — the size of the Chinese shown under a chapter is counted from that file as the reader
loads it. The whole list goes in as **one transaction**, scheduled after the first paint (see
*Speed*), and is skipped altogether when the seed's version stamp is unchanged. The reading position
goes to `meta/progress` on every chapter open, and the chapter ids the reader has opened — the green
edges — go to `localStorage`.

> **Serve it over HTTP.** Chromium blocks IndexedDB on `file://` origins; opening
> `index.html` directly still works but falls back to the in-memory seed. Use
> `node tools/serve.mjs 8080` (dependency-free) and open <http://localhost:8080/>.

## 5. Tests

```powershell
node tests\check-dom.mjs          # static wiring: ids, icon symbols, selectors, CSS classes
node tests\check-translations.mjs # per-page translation gate (dividers, no stray Chinese, counts)
node tests\smoke.mjs              # end-to-end in headless Chrome over CDP (no npm deps)
```

`tests/smoke.mjs` starts the server, drives headless Chrome through the DevTools protocol
and asserts: the seed is written to IndexedDB (884 chapter rows, and the retired `pages`
store is gone), the chapter list renders with headings and no status chip (only chapters the
reader has opened carry the green read edge, and the mark is remembered in `localStorage`),
search / sort / filter / tabs work (including “Pending translation” emptying a range that is
fully translated), the 50-chapter pill pager shows three range numbers, keeps each one in its
slot and slides the window as the arrows move while sitting in the list flow under the last
row, a chapter opens with its English text read from `Doer/Result/`, the two SVG arrows and
`←` / `→` step chapter by chapter, the reading position is persisted in `meta/progress`, the
`‹ Raw | Translated ›` switch re-reads the Chinese from `sources/`, the reader bar is two icons
with the `⋮` pinned to the top-right corner, the chapter's own head is title → white site line
→ white 120×30 credit chip → three tools → switch (and nothing on the page mentions a file
path or a status badge), the `⋮` menu names both files with their counts, and a chapter the run
has not reached stands one centered card — again with no path on the page.

It also pins the three things this pass changed: a row's heading is the chapter's English title
(`Chapter 1 · Chaotic World`) while the Chinese heading (`第1章`) now lives only in the `⋮` menu,
the size of the Chinese under a chapter is counted from the file on screen rather than
remembered, and no panel prints `undefined` when a number it used to read is gone. A final pair
of checks reloads the page mid-chapter: the reader comes back to that chapter and to the line
it was on.

Latest results: `check-dom` **all wiring checks passed**, `smoke` **62/62 checks passed**.
(`tests/check-translations.mjs` belongs to the retired page layout — `build-data.mjs` reports
the same problems for the chapter layout.)

## 6. Translation conventions

Applied to every page (and spelled out in the reader's *Rules* tab):

* **Context over dictionary** — an entity's type is deduced from the surrounding text and
  from sibling terms in a cluster; alignment with the existing translation beats a generic
  lookup (`回山拳` → Mountain Fist, not “return-mountain boxing” as a school name).
* **Translate vs transliterate** — objects, artifacts, techniques and fictional
  organizations are translated; character names and real-world proper nouns are romanised
  (`华夏` → Huaxia, `散打` → sanda, `秀才` → xiucai).
* **World-building** — no fantasy geography is mapped onto a real city: `京都` would become
  “the Imperial Capital”, never Kyoto. `大元·云州·飞业城` → Great Yuan · Yun Province · Feiye City.
* **Honorifics** — Chinese address terms are translated (Second Sister, Third Senior
  Brother, Elder Zheng, Grandpa Wang, Old Man Zheng, instructor/夫子, xiucai/秀才);
  Japanese and Korean honorifics would stay romanised (-san, -senpai, -ssi, sunbae).
* **Page headings** — every page carries the chapter heading it belongs to as its
  sub-heading (`Chapter 3 · Stability (Part 1)`), and a page that opens a new chapter
  mid-page gets an inline divider instead of a second heading.
* **Hand-written, page by page** — nothing generates English text: each page is read and
  rewritten as prose, with the raw sentence breaks regrouped where the English needs it.
  The pipeline (`split` → `build-data` → `serve`) only ever moves text around.
* **Sentences close on the page they start on** — the Chinese page breaks cut through
  sentences (`…slowly` | `accumulating.`); the English finishes the clause on the page
  where it began, so every screen reads cleanly on its own.
* **Voice and address** — nicknames and forms of address keep the original's register:
  Xiao He (`小河` / `小合`, the family's pet name), Second Sister, Big Sister, Little
  Brother, Grandpa Wang, Third Senior Brother, and *Old Man Zheng* in narration versus
  *Master Zheng* / *Elder Zheng* when spoken to.
* **Torn source, whole English** — where the scrape jumps (a chapter with no marker, a page
  opening mid-sentence), the English page still opens and closes as readable prose: the
  fragment is completed as the sentence it clearly was, and the tear is bridged in a clause
  or a scene break. Whole missing pages (in many stretches only the odd-numbered source
  pages carry new text, so 151 leads to 153, 155 to 157, and the drinking scene that opens on
  159 runs straight into 161) leave a gap, never a patch; missing plot is never filled in with
  invented events — one such tear is closed with a trailing dash.
* **Sentence rhythm** — short source sentences (`静。`) stay short and punchy; descriptive
  runs are allowed to breathe; no line is padded to match a Chinese line's length.
* **Plain wording** — the everyday word is the one chosen and sentences stay short, so a scene
  can be pictured on the first read; the detail of the scene is kept, the tangled phrasing is not.

## 7. Continuing the translation

Chapters are translated in reading order; the site picks up whatever exists. To add a batch:

1. open `sources/chapter_0241/original.zh.txt` — five `#` header lines, then the body, one
   paragraph per line — and read it;
2. write the English into `Doer/Result/chapter_0241/chapter_0241.txt`, one paragraph per
   line. The reader shows the chapter the moment that file exists (the bar's ↻ re-reads it
   without a reload); the Raw view is the Chinese file beside it;
3. add the chapter's English title to `tools/chapter-titles.json` (and any new recurring
   term to `tools/glossary.json`);
4. `node tools/build-data.mjs` and reload — the new version stamp makes the app rewrite the
   chapter list, so the row, the `n translated` counters and the badge follow. Until then
   the chapter already reads correctly; only the list's numbers lag behind.

Every chapter has an English title today — all 884 entries in `tools/chapter-titles.json`, one
line per chapter (`"151": "Counter-Plot"`), with the 上 / 下 (一 / 二) half rendered as
`(Part 1)` / `(Part 2)` automatically. A number with no entry there keeps its Chinese heading
instead, so nothing ever reads half-translated.

The batch tool `Doer/doer.py` (Selenium drives Gemini, cookie jar in `Doer/account.json`) walks the
novel in chapter order and writes `Doer/Result/chapter_NNNN/chapter_NNNN.txt`. That file doubles as
its progress marker: a run starts at chapter 1 and, after a Ctrl+C, resumes at the first chapter
`Result/` has no answer for. Run `node tools/build-data.mjs` afterwards and reload so the chapter
list picks the new chapters up.
