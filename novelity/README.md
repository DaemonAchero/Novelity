# Omnipresent God of War — 十方武圣 · English translation project

Reader + translation pipeline for the Chinese novel **十方武圣** (`D:\Novel\十方武圣_pages.txt`),
a ~2.9 M character / 8.8 MB web-scraped dump.

```
D:\Novel\
├─ 十方武圣_pages.txt          raw scrape (2,830 page markers, untouched)
└─ novelity\
   ├─ index.html               the reader  (Library list + Reader view)
   ├─ css\style.css            dark UI modelled on the reference screenshots
   ├─ js\db.js                 IndexedDB storage layer
   ├─ js\app.js                library / reader logic
   ├─ assets\cover.png         cover art (1200×1600; cover.svg is the generated placeholder)
   ├─ data\
   │   ├─ outline.json         generated page + chapter index (from the scrape)
   │   └─ novel-data.js        generated seed file for the reader (~6.9 MB)
   ├─ sources\                 ONE FOLDER PER PAGE
   │   ├─ page_0001\
   │   │   ├─ page_0001.txt        ← ENGLISH TRANSLATION (one paragraph per line)
   │   │   └─ original.zh.txt      ← Chinese source page (translation input)
   │   └─ page_0002\ …
   ├─ tools\                   split.mjs, build-data.mjs, serve.mjs,
   │                           chapter-titles.json, glossary.json
   └─ tests\                   check-dom.mjs, check-translations.mjs, smoke.mjs
```

## 1. What the scrape actually contained

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
  **Glossary** tab (296 terms).

`original.zh.txt` in the same folder is the untouched Chinese page — it is the input for
the translation and is also used as the reader's fallback text for untranslated pages.

**Progress: 144 of 1,836 pages — chapters 1–21, 23, 25, 26, 28, 30, 32, 34, 36, 37, 40, 41,
43, 45, 47, 49, 52, 54, 56, 58, 60, 62, 64, 68, 70, 71, 72 and 73 complete; next page is
`page_0221`** (the 下 parts 52–73 — Night, Halfway, The Way of the World, Preparation, Up Again,
Investigation, Crushing Defeat, Departure, Hope, Aftermath —
whose 上 parts, chapters 51, 53, 55, 57, 59, 61, 63, 65, 67 and 69, are among the lost markers;
chapter 66 never surfaces in the scrape at all, and chapter 71 · Hope is the first 上 part to
survive since chapter 37). Chapter titles live in `tools/chapter-titles.json`. Pages that carry
no chapter marker of their own (the scrape lost 38, 39, 42 …) are continuations of the chapter
before them and are listed under it.

## 3. Pipeline

```powershell
cd D:\Novel\novelity
node tools\split.mjs          # raw scrape  -> sources\page_XXXX\original.zh.txt + data\outline.json
#   ... write the English text into sources\page_XXXX\page_XXXX.txt ...
node tools\build-data.mjs     # sources + outline -> data\novel-data.js   (~6.9 MB seed)
node tools\serve.mjs 8080     # then open http://localhost:8080/
```

`build-data.mjs --no-source` produces a seed without the Chinese fallback (much smaller).
`tools\analyze.mjs` and `tools\inspect.mjs` are the diagnostic scripts that found the
duplicate pages, the numbering gaps and the chapter-part conventions (they only read the
raw scrape).

## 4. The reader

* **Library view** — novel card (cover, rating, “Reading” pill), project title, tabs
  (`Translation / Batch / Glossary / Rules / Info`), search box, `Filters` popover,
  `Ascending / Descending` sort, `CONTINUE READING` card and the chapter list. A row
  carries **no status chip**: its 3px left edge is the read mark and turns green only
  once the reader has opened that chapter, so nothing is marked up front.
  The list is paged in **ranges of 50 chapters** — the pill pager
  (`‹ 1 2 3 ›`) keeps **three range numbers on screen** and fills in the open one. It
  slides by one per SVG-arrow click (`1 2 3` → `2 3 4`), and a number keeps the slot it was
  clicked in — the third stays third, the first stays first, nothing jumps to the front.
  The pager is the last block of the list itself (`position: relative`, in the list flow,
  without a bar container), so it scrolls away with the chapters instead of hanging over
  them; its caption names the open range (`Chapters 1–50 · tab 1 of 19`) and a search jumps
  to the range that holds the first hit.
* **Reader view** — the chapter heading as the page sub-heading, the page text, an inline
  heading wherever a new chapter starts mid-page, a green progress bar, `Page 411 of 1,836`,
  and **two round SVG arrow buttons** that step one page at a time (also `←` / `→`,
  swipe, and `Esc` to go back).
* **Reading mode** — the first real scroll folds the app bar and the arrow bar away and the
  text takes the room they free (both collapse to zero height, so the chapter really fills
  the screen — no empty strip is left behind; the 3-px progress line stays as the only
  cue). A **double click**, the same gesture as two quick taps, or keyboard focus brings
  them back, and every chapter opens with the bars visible. The CSS folds to the heights
  measured off the live layout, so it is exact on any font size or safe-area inset.
* Untranslated pages show a notice plus the **Chinese source**; translated pages keep the
  Chinese behind an “Original text (Chinese)” toggle.

### Storage: IndexedDB, not localStorage

The book is ~6.9 MB of page text. `localStorage` caps out around 5 MB total and is
synchronous, so `js/db.js` keeps everything in IndexedDB — database `novelity`, stores
`pages` (1,836 rows), `chapters` (570 rows) and `meta` (`seed` + `progress`). Seeding
happens in chunks of 120 pages and is skipped when the seed's version stamp is unchanged;
page text is always read back out of IndexedDB, and the reading position is written to
`meta/progress` on every page turn.

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
and asserts: the seed is written to IndexedDB (1,836 page rows / 570 chapter rows), the
chapter list renders with headings and no status chip (only chapters the reader has
opened carry the green read edge, and the mark is remembered in `localStorage`),
search / sort / filter / tabs work,
the 50-chapter pill pager shows three range numbers, keeps each one in its slot and slides
the window as the arrows move while sitting in the list flow under the last row (relative —
it scrolls away with the chapters instead of being pinned over them),
a chapter opens in the reader, the two SVG arrows walk forwards and backwards, `←` / `→`
work, the reading position is persisted in `meta/progress`, and English text renders for
translated pages while the Chinese toggle stays available.

Latest results: `check-dom` **all wiring checks passed**, `check-translations`
**144/144 files ok (2,196 paragraphs, 115,493 words, no stray Chinese)**, `smoke`
**51/51 checks passed**.

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

## 7. Continuing the translation

Pages are translated in reading order; the site picks up whatever exists. To add a batch:

1. open `sources/page_0013/original.zh.txt` (or the raw scrape) and read the page;
2. write the English into `sources/page_0013/page_0013.txt` — one paragraph per line,
   `== Chapter 5 · Variable (Part 1) ==` where a chapter starts mid-page;
3. add the chapter's English title to `tools/chapter-titles.json` (and any new recurring
   term to `tools/glossary.json`);
4. `node tools/build-data.mjs`, reload the page — the new version stamp makes the app
   reseed IndexedDB, and the chapter shows up with its `n/m translated` progress in the
   list (the row itself is only marked once you have opened the chapter).

Remaining: page 221 → 1,836 (chapters 73 → 904 — the 334 chapter numbers absent from the
scrape simply never come up). Pages 213–279 are consecutive (220 → 221 → 223), so from here the
next page is usually `id + 1`, and from 281 on only the odd numbers carry text again (283, 285, …).
