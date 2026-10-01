// tests/smoke.mjs
// ---------------------------------------------------------------------------
// End-to-end smoke test of the reader, run in headless Chrome over CDP
// (no npm dependencies: Node's global WebSocket + fetch are enough).
//
//   node tests/smoke.mjs
//
// It verifies that
//   1. the static server serves the app,
//   2. boot() reads data/novel-data.js and writes the chapter list to IndexedDB,
//   3. the library list renders chapter rows with headings and no status chip,
//   4. the numeric chapter pager walks the list through its 50-chapter ranges,
//   5. opening a chapter reads its two files — the English chapter in
//      Doer/Result/ and the Chinese in sources/ — and the arrows step chapter
//      by chapter,
//   6. a reading position is persisted in IndexedDB (meta store),
//   7. the reader bars fold away on scroll and hand their room to the text,
//   8. at 360px nothing overflows the screen sideways,
//   9. the pager is list content — relative, under the last row, no bar container,
//  10. a chapter is marked as read only after the reader has opened it,
//  11. the reader chrome is the two-icon bar (back left, ⋮ pinned top-right) plus
//      the chapter's own head — title, the white site line, the white credit chip,
//      save / copy / refresh, the Raw / Translated switch flanked by the same
//      previous / next chapter steps as the bar's arrows at the bottom of the
//      screen, and the centered card that stands in where a chapter's translation
//      is still missing. No file path and no status badge is printed on the page:
//      both live in the ⋮ menu.
//  12. the whole app is set in the project's one face (SF Pro Rounded, from
//      assets/fonts) at weight 400 — <b> and <strong> included — while the
//      Chinese source keeps its own serif stack,
//  13. the strip under the app bar is the reading position of the chapter on
//      screen — empty at its first line, half full at its middle, full at its
//      last — and every chapter opens it at the top again.
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.PORT || 8277);
const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const PROFILE = path.join(os.tmpdir(), `novelity-smoke-${Date.now()}`);

function findBrowser() {
  const candidates = [
    process.env.CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('No Chrome/Edge binary found — set CHROME=/path/to/chrome');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitForDevtools() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (err) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('DevTools endpoint never came up');
}

function connect(url) {
  const ws = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  return {
    ready,
    send(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      });
    },
    close: () => ws.close(),
  };
}

/** evaluate an expression in the page and return its (awaited) value */
async function evaluate(client, expression) {
  const res = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + ' ' + JSON.stringify(res.exceptionDetails.exception));
  return res.result.value;
}

/** what the browser actually stored, read straight out of IndexedDB */
const IDB_COUNT = `(async () => {
  const open = () => new Promise((res, rej) => { const q = indexedDB.open('novelity'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  try {
    const db = await open();
    if (!db.objectStoreNames.contains('chapters') || !db.objectStoreNames.contains('meta')) {
      return { pages: null, chapters: null, progress: null, note: 'stores missing — app never seeded' };
    }
    const count = (store) => new Promise((res, rej) => { const r = db.transaction(store).objectStore(store).count(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const progress = await new Promise((res, rej) => { const r = db.transaction('meta').objectStore('meta').get('progress'); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); });
    return { chapters: await count('chapters'), pageStore: db.objectStoreNames.contains('pages'), progress };
  } catch (err) {
    return { chapters: null, progress: null, note: String(err && err.message || err) };
  }
})()`;

/**
 * The reader: one chapter per screen, its text read from the two files it owns
 * (the English chapter in Doer/Result/, the Chinese in sources/), the arrows
 * stepping chapter by chapter, and the position landing in IndexedDB.
 */
async function checkReader(client) {
  const opened = await evaluate(client, `(() => {
    const rows = [...document.querySelectorAll('.chapter-row')];
    const row = rows.find((r) => r.querySelector('.chapter-row__title').textContent.includes('Chaotic World')) || rows[0];
    row.click();
    return Boolean(row);
  })()`);
  await sleep(500);

  const chapter = await evaluate(client, `(() => {
    const body = document.getElementById('readerBody');
    const site = body.querySelector('.credit__site');
    const chip = body.querySelector('.credit__name');
    const appbar = document.querySelector('.appbar--reader');
    const app = document.getElementById('app').getBoundingClientRect();
    const box = (node) => node.getBoundingClientRect();
    return {
      libraryHidden: document.getElementById('viewLibrary').hidden,
      readerShown: !document.getElementById('viewReader').hidden,
      heading: body.querySelector('.chapter-head__title').textContent,
      credit: body.querySelector('.chapter-head__meta').textContent,
      site: site ? {
        text: site.textContent, href: site.href,
        underline: getComputedStyle(site).textDecorationLine,
        color: getComputedStyle(site).color,
      } : null,
      chip: chip ? {
        text: chip.textContent,
        w: getComputedStyle(chip).width, h: getComputedStyle(chip).height,
        bg: getComputedStyle(chip).backgroundColor,
        radius: getComputedStyle(chip).borderTopLeftRadius,
        // the chip sits under the site line, between it and the tools
        above: box(chip).top >= box(site).bottom - 1,
      } : null,
      // the head is one centred column held together by space: the same gap opens
      // between the title and the site line, between the site line and the chip,
      // and between the three tools and the switch below them
      gaps: (() => {
        const gap = (a, b) => Math.round(box(b).top - box(a).bottom);
        return {
          titleSite: gap(body.querySelector('.chapter-head__title'), site),
          siteChip: gap(site, chip),
          toolsSwitch: gap(body.querySelector('.chapter-head__tools'), body.querySelector('.src-switch')),
        };
      })(),
      paragraphs: body.querySelectorAll('p').length,
      firstParagraph: (body.querySelector('p') || {}).textContent || '',
      sections: body.querySelectorAll('.chapter-page').length,
      blanks: body.querySelectorAll('.chapter-blank').length,
      pageText: document.getElementById('readerScroll').textContent,
      prevDisabled: document.getElementById('prevBtn').disabled,
      nextDisabled: document.getElementById('nextBtn').disabled,
      arrows: document.querySelectorAll('.reader-nav .page-arrow svg').length,
      bar: document.getElementById('readerProgressBar').style.width,
      // the bar above the text is two icons and no words: the chapter's own head
      // is the first thing in #readerBody, so nothing is said twice on screen
      headFirst: body.firstElementChild.classList.contains('chapter-head'),
      headBarText: appbar.textContent.trim(),
      barIcons: appbar.querySelectorAll('.icon-btn').length,
      iconRow: document.querySelectorAll('.chapter-head__tools .chapter-tool').length,
      backLeft: Math.round(box(document.getElementById('readerBack')).left - app.left),
      menuLeft: Math.round(box(document.getElementById('readerMenu')).left - app.left),
      menuRight: Math.round(app.right - box(document.getElementById('readerMenu')).right),
      menuTop: Math.round(box(document.getElementById('readerMenu')).top - appbar.getBoundingClientRect().top),
    };
  })()`);
  check('row click opens the reader', opened && chapter.readerShown && chapter.libraryHidden === true);
  check('a chapter is one document: its Result file is the whole chapter',
    chapter.sections === 1 && chapter.paragraphs > 50,
    `${chapter.sections} section(s) · ${chapter.paragraphs} paragraph(s)`);
  check('chapter text rendered from Doer/Result/chapter_0001/chapter_0001.txt',
    chapter.paragraphs > 0 && /[A-Za-z]{3}/.test(chapter.firstParagraph), `${chapter.paragraphs} paragraph(s)`);
  check('the reader bar is two icons and no words: back at the left, ⋮ pinned top-right',
    chapter.headBarText === '' && chapter.barIcons === 2
      && chapter.backLeft < 24 && chapter.menuRight < 24 && chapter.menuTop < 24
      && chapter.menuLeft - chapter.backLeft > 200,
    `bar text “${chapter.headBarText}” · ${chapter.barIcons} icon(s) · back ${chapter.backLeft}px in,`
      + ` ⋮ ${chapter.menuRight}px in / ${chapter.menuTop}px down · ${chapter.menuLeft - chapter.backLeft}px apart`);
  check('the chapter names itself in its own head — title, white site line, white credit chip',
    chapter.headFirst && chapter.heading === 'Chapter 1 · Chaotic World'
      && chapter.credit === 'novelity.vercel.comCredit: Im Boravath'
      && chapter.iconRow === 3,
    `${chapter.heading} · ${chapter.credit} · ${chapter.iconRow} tool(s)`);
  check('the site is a white, un-underlined link',
    chapter.site && chapter.site.text === 'novelity.vercel.com'
      && chapter.site.href === 'https://novelity.vercel.com/'
      && chapter.site.underline === 'none' && chapter.site.color === 'rgb(255, 255, 255)',
    chapter.site ? `${chapter.site.text} → ${chapter.site.href} · ${chapter.site.underline} · ${chapter.site.color}` : 'no site link');
  check('the credit is the white 120×30 chip under the site line',
    chapter.chip && chapter.chip.text === 'Credit: Im Boravath' && chapter.chip.above
      && chapter.chip.w === '120px' && chapter.chip.h === '30px'
      && chapter.chip.bg === 'rgb(255, 255, 255)' && parseFloat(chapter.chip.radius) === 6,
    chapter.chip ? `${chapter.chip.text} ${chapter.chip.w}×${chapter.chip.h} ${chapter.chip.bg} r${chapter.chip.radius}` : 'no chip');
  check('the head breathes: title → site line → chip open the same gap as the tools → switch',
    Math.abs(chapter.gaps.titleSite - chapter.gaps.toolsSwitch) <= 1
      && Math.abs(chapter.gaps.siteChip - chapter.gaps.toolsSwitch) <= 1
      && chapter.gaps.titleSite >= 20 && chapter.gaps.siteChip >= 20,
    `${chapter.gaps.titleSite}px / ${chapter.gaps.siteChip}px / ${chapter.gaps.toolsSwitch}px`
      + ' (title → site / site → chip / tools → switch)');
  check('no file path and no status badge is printed on the page',
    chapter.blanks === 0 && !/sources\/|Doer\/Result/.test(chapter.pageText)
      && !/translated in|paragraphs ·/.test(chapter.pageText),
    chapter.pageText.replace(/\s+/g, ' ').slice(0, 90));
  check('two SVG arrows; left disabled on chapter 1',
    chapter.arrows === 2 && chapter.prevDisabled === true && chapter.nextDisabled === false);
  /* ---- the strip under the bar: the reading position, chapter by chapter ----
     Empty at the chapter's first line, half full with the middle of its scroll on
     screen, full at its last line — it measures the chapter, not the novel (where
     a chapter sits in the reading order is the ⋮ menu's business). Probed with the
     bars already folded, so no transition is resizing the scroller while the strip
     is read; and left part-way down, so the next chapter has something to reset. */
  check('the strip under the bar starts this chapter empty',
    chapter.bar === '0%', chapter.bar);

  await evaluate(client, `(() => {
    const s = document.getElementById('readerScroll');
    s.scrollTop = 240;   // fold the bars: nothing below is read mid-transition
  })()`);
  await sleep(600);

  await evaluate(client, `(() => {
    const s = document.getElementById('readerScroll');
    s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) / 2);
  })()`);
  await sleep(200);
  const stripHalf = await evaluate(client, `(() => {
    const s = document.getElementById('readerScroll');
    return {
      pct: parseFloat(document.getElementById('readerProgressBar').style.width),
      at: Math.round(s.scrollTop),
      range: Math.round(s.scrollHeight - s.clientHeight),
    };
  })()`);
  check('…half of the chapter down, the strip is about half full',
    Math.abs(stripHalf.pct - 50) <= 2,
    `${stripHalf.pct}% of the strip at ${stripHalf.at}px of ${stripHalf.range}px`);

  await evaluate(client, `(() => {
    const s = document.getElementById('readerScroll');
    s.scrollTop = s.scrollHeight;
  })()`);
  await sleep(200);
  const stripFull = await evaluate(client, `parseFloat(document.getElementById('readerProgressBar').style.width)`);
  check('…the chapter’s last line puts the strip at full',
    stripFull === 100, `${stripFull}%`);

  await evaluate(client, `(() => {
    const s = document.getElementById('readerScroll');
    s.scrollTop = 0;
  })()`);
  await sleep(200);
  const stripTop = await evaluate(client, `parseFloat(document.getElementById('readerProgressBar').style.width)`);
  check('…and back at its first line the strip is empty again',
    stripTop === 0, `${stripTop}%`);

  // left half-way down with both bars back on screen, the way a chapter is left
  await evaluate(client, `(() => {
    const s = document.getElementById('readerScroll');
    s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) / 2);
  })()`);
  await sleep(200);
  await evaluate(client, `document.getElementById('viewReader')
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(500);

  /* the ⋮ in the reader bar: the one place a chapter's provenance is spelled out */
  const menu = await evaluate(client, `(async () => {
    document.getElementById('readerMenu').click();
    await new Promise((r) => setTimeout(r, 200));
    return document.getElementById('toast').textContent;
  })()`);
  check('the ⋮ menu is where the two file paths and the counts live',
    /^Chapter 1 · Chaotic World · 第1章/.test(menu)
      && /chapter 1 of [\d,]+/.test(menu)
      && /Doer\/Result\/chapter_0001\/chapter_0001\.txt/.test(menu)
      && /sources\/chapter_0001\/original\.zh\.txt/.test(menu),
    menu.slice(0, 140));

  /* ---- the arrows step chapter by chapter ---- */
  await evaluate(client, `document.getElementById('nextBtn').click()`);
  await sleep(450);
  const nextChapter = await evaluate(client, `document.querySelector('#readerBody .chapter-head__title').textContent`);
  check('right arrow steps to the next chapter',
    /^Chapter 2 · /.test(nextChapter) && /Hope/.test(nextChapter), nextChapter);

  const stripReset = await evaluate(client, `document.getElementById('readerProgressBar').style.width`);
  check('a new chapter starts the strip over at its first line',
    stripReset === '0%', `chapter 1 was left at ${stripHalf.pct}% · chapter 2 opens at ${stripReset}`);

  const idb = await evaluate(client, IDB_COUNT);
  check('reading position stored in IndexedDB',
    !!idb.progress && idb.progress.chapterId === 'ch2',
    idb.progress ? `${idb.progress.chapterId} · seq ${idb.progress.seq}` : 'no progress row');

  await evaluate(client, `document.getElementById('prevBtn').click()`);
  await sleep(350);
  const backChapter = await evaluate(client, `document.querySelector('#readerBody .chapter-head__title').textContent`);
  check('left arrow steps back to chapter 1', /^Chapter 1 · /.test(backChapter), backChapter);

  await evaluate(client, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  await sleep(350);
  const keyed = await evaluate(client, `document.querySelector('#readerBody .chapter-head__title').textContent`);
  check('ArrowRight key turns the chapter', /^Chapter 2 · /.test(keyed), keyed);

  /* ---- reading mode: the bars fold away on scroll, the text takes their room ---- */
  const barBox = `(() => {
    const view = document.getElementById('viewReader');
    const surface = document.getElementById('readerScroll');
    const app = document.getElementById('app').getBoundingClientRect();
    const h = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().height);
    const prev = document.getElementById('prevBtn').getBoundingClientRect();
    const next = document.getElementById('nextBtn').getBoundingClientRect();
    // what is drawn behind a page arrow: the bar's own background and nothing else
    const plate = (id) => {
      const s = getComputedStyle(document.getElementById(id));
      return s.backgroundImage + ' / ' + s.backgroundColor + ' / r' + s.borderTopLeftRadius;
    };
    return {
      hidden: view.classList.contains('is-bars-hidden'),
      text: surface.clientHeight,
      appbar: h('.appbar--reader'),
      nav: h('.reader-nav'),
      scrollMax: Math.round(surface.scrollHeight - surface.clientHeight),
      // the two page arrows sit at the two ends of the bottom bar, on one row
      arrowLeft: Math.round(prev.left - app.left),
      arrowRight: Math.round(app.right - next.right),
      arrowOffset: Math.round(Math.abs(prev.top - next.top)),
      arrowPlate: plate('prevBtn'),
      arrowBorder: getComputedStyle(document.getElementById('prevBtn')).borderTopWidth,
      navPad: getComputedStyle(document.querySelector('.reader-nav')).paddingLeft,
    };
  })()`;
  const chromeOpen = await evaluate(client, barBox);
  check('a chapter opens with both bars on screen, the arrows at the bar’s two ends',
    !chromeOpen.hidden && chromeOpen.appbar > 0 && chromeOpen.nav > 0
      && chromeOpen.arrowLeft >= 11 && chromeOpen.arrowLeft <= 14
      && chromeOpen.arrowRight >= 11 && chromeOpen.arrowRight <= 14
      && chromeOpen.arrowOffset < 2 && chromeOpen.navPad === '12px',
    `app bar ${chromeOpen.appbar}px · nav ${chromeOpen.nav}px`
      + ` · arrows ${chromeOpen.arrowLeft}px in / ${chromeOpen.arrowRight}px in (padding ${chromeOpen.navPad})`);
  check('the bottom bar is a slim ~28px strip: two bare chevrons, no plate behind them',
    chromeOpen.nav >= 25 && chromeOpen.nav <= 30
      && chromeOpen.arrowPlate === 'none / rgba(0, 0, 0, 0) / r0px'
      && parseFloat(chromeOpen.arrowBorder) === 0,
    `nav ${chromeOpen.nav}px · ${chromeOpen.arrowPlate} · border ${chromeOpen.arrowBorder}`);

  await evaluate(client, `(() => { const s = document.getElementById('readerScroll'); s.scrollTop += 240; })()`);
  await sleep(500);   // the fold is a transition
  const chromeFolded = await evaluate(client, barBox);
  check('scrolling a chapter folds both bars away',
    chromeFolded.hidden && chromeFolded.appbar === 0 && chromeFolded.nav === 0,
    `app bar ${chromeFolded.appbar}px · nav ${chromeFolded.nav}px · scrollable ${chromeOpen.scrollMax}px`);
  check('the room the bars free goes to the text, not to an empty strip',
    chromeFolded.text - chromeOpen.text === chromeOpen.appbar + chromeOpen.nav,
    `text ${chromeOpen.text}px → ${chromeFolded.text}px (+${chromeFolded.text - chromeOpen.text}px, bars were ${chromeOpen.appbar + chromeOpen.nav}px)`);

  await evaluate(client, `document.getElementById('viewReader')
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(500);
  const chromeBack = await evaluate(client, barBox);
  check('a double click brings the bars straight back',
    !chromeBack.hidden && chromeBack.text === chromeOpen.text,
    `text back to ${chromeBack.text}px`);

  /* ---- back to the library: only the chapters that were opened are marked ---- */
  await evaluate(client, `document.getElementById('readerBack').click()`);
  await sleep(450);
  const marks = await evaluate(client, `(() => {
    const marked = [...document.querySelectorAll('.chapter-row.is-read')];
    const plain = [...document.querySelectorAll('.chapter-row:not(.is-read)')];
    const edge = (node) => (node ? getComputedStyle(node).borderLeftColor : null);
    return {
      readerHidden: document.getElementById('viewReader').hidden,
      libraryShown: !document.getElementById('viewLibrary').hidden,
      marked: marked.length,
      titles: marked.map((r) => r.querySelector('.chapter-row__title').textContent),
      edge: edge(marked[0]),
      plainEdge: edge(plain[0]),
      chips: document.querySelectorAll('.chapter-row .status, .chapter-row .badge').length,
    };
  })()`);
  check('back button returns to the library', marks.readerHidden && marks.libraryShown);
  check('only the chapters the reader opened carry the read edge',
    marks.marked === 2 && marks.edge !== marks.plainEdge && marks.chips === 0,
    `${marks.marked} marked (${marks.titles.join(' · ')}) · edge ${marks.edge} vs ${marks.plainEdge}`);
}

async function main() {
  console.log('novelity reader — smoke test\n');
  const server = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.mjs'), String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  await sleep(900);
  const url = `http://localhost:${PORT}/`;

  try {
    const ping = await fetch(url);
    check('static server serves index.html', ping.ok, url);
  } catch (err) {
    check('static server serves index.html', false, err.message);
    server.kill();
    process.exit(1);
  }

  const browser = spawn(findBrowser(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, url,
  ], { stdio: 'ignore' });

  let client = null;
  try {
    const target = await waitForDevtools();
    client = connect(target.webSocketDebuggerUrl);
    await client.ready;
    await client.send('Runtime.enable');

    const ready = await evaluate(client, `new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (window.__novelityReady) { clearInterval(iv); resolve(window.__novelityReady); }
        else if (Date.now() - t0 > 25000) {
          clearInterval(iv);
          const s = document.getElementById('listSummary');
          resolve({ timeout: true, summary: s ? s.textContent : '(no summary)', error: window.__novelityError || null });
        }
      }, 250);
    })`);
    check('boot completes and loads the chapter list', !ready.timeout && ready.chapters > 0, JSON.stringify(ready));
    check('IndexedDB used (not the in-memory fallback)', ready.fallback === false);

    const idb = await evaluate(client, IDB_COUNT);
    check('chapters store holds one row per chapter', idb.chapters === ready.chapters, `${idb.chapters} rows`);
    check('the page store of the old build is gone', idb.pageStore === false, `pages store present: ${idb.pageStore}`);

    await checkLibrary(client);
    await checkReader(client);
    await checkTypography(client);
    await checkChapterBar(client);
    await checkReload(client);
    await checkNarrowLayout(client);
  } catch (err) {
    check('test run completed without throwing', false, err.message);
  } finally {
    if (client) client.close();
    browser.kill();
    server.kill();
    await sleep(300);
    fs.rmSync(PROFILE, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


/**
 * Library list: rendering, search, sort, filter, the 50-chapter range pager, tabs.
 * The list is the chapter index from data/novel-data.js — 884 chapters of the new
 * per-chapter edition, 240-odd of them translated — so the numbers here are read
 * from the seed rather than written into the test.
 */
async function checkLibrary(client) {
  const seed = await evaluate(client, `(() => {
    const s = window.NOVEL_DATA.stats;
    return { chapters: s.chapters, translated: s.translatedChapters, last: s.lastChapter };
  })()`);
  const translatedText = Number(seed.translated).toLocaleString('en-US');

  const list = await evaluate(client, `(() => {
    const rows = [...document.querySelectorAll('.chapter-row')];
    return {
      rows: rows.length,
      first: rows.length ? rows[0].querySelector('.chapter-row__title').textContent : '',
      meta: rows.length ? rows[0].querySelector('.chapter-row__meta').textContent : '',
      badges: document.querySelectorAll('.chapter-row .status').length,
      marked: document.querySelectorAll('.chapter-row.is-read').length,
      kebab: rows.length ? Boolean(rows[0].querySelector('.row-actions .row-kebab')) : false,
      summary: document.getElementById('listSummary').textContent,
      continueLabel: document.querySelector('#continueBtn .continue__label').textContent,
      cover: document.querySelector('.book-cover') ? document.querySelector('.book-cover').getAttribute('src') : null,
    };
  })()`);
  check('library list fills the first 50-chapter range with chapter rows',
    list.rows === 50, `${list.rows} rows · ${list.summary}`);
  check('rows carry the chapter heading, its size and no status chip',
    /^(Chapter \d+|第\d+章)/.test(list.first || '')
      && /paragraphs/.test(list.meta) && list.badges === 0 && list.kebab && list.marked === 0,
    `${list.first} · “${list.meta}” · ${list.badges} chip(s) · ⋮ ${list.kebab}`);
  check('the summary counts the whole edition, not the rows on screen',
    new RegExp(`^50 of ${Number(seed.chapters).toLocaleString('en-US')} chapters · ${translatedText} translated$`).test(list.summary),
    `“${list.summary}”`);
  check('cover + continue card wired',
    ['assets/cover.png', 'assets/cover.svg'].includes(list.cover) && list.continueLabel === 'START READING',
    `${list.cover} · ${list.continueLabel}`);

  const search = await evaluate(client, `(() => {
    const input = document.getElementById('searchInput');
    input.value = 'Chaotic World';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const rows = [...document.querySelectorAll('.chapter-row')];
    return { rows: rows.length, title: rows.length ? rows[0].querySelector('.chapter-row__title').textContent : null };
  })()`);
  check('search filters the chapter list', search.rows === 1, `${search.rows} row → ${search.title}`);

  const sort = await evaluate(client, `(() => {
    const input = document.getElementById('searchInput');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('sortBtn').click();
    return document.getElementById('sortLabel').textContent;
  })()`);
  check('sort toggle works', sort === 'Descending', sort);

  const filter = await evaluate(client, `(() => {
    const pick = (name) => {
      document.getElementById('filterBtn').click();
      document.querySelector('#filterPopover .popover__item[data-filter="' + name + '"]').click();
      return {
        label: document.getElementById('filterLabel').textContent,
        rows: document.querySelectorAll('.chapter-row').length,
        empty: !!document.querySelector('#chapterList .empty'),
      };
    };
    const translated = pick('translated');
    const pending = pick('pending');
    const all = pick('all');
    return { translated, pending, all, closed: document.getElementById('filterPopover').hidden };
  })()`);
  check('“Translated only” keeps every row of a fully translated range',
    filter.translated.label === 'Translated only' && filter.translated.rows === 50 && !filter.translated.empty,
    `${filter.translated.rows} rows across chapters 1–50 (all translated)`);
  check('“Pending translation” empties a range that is fully translated',
    filter.pending.label === 'Pending translation' && filter.pending.rows === 0 && filter.pending.empty,
    `${filter.pending.rows} rows · empty state ${filter.pending.empty}`);
  check('going back to “All chapters” restores the list',
    filter.all.label === 'All chapters' && filter.all.rows === 50 && filter.closed === true,
    `${filter.all.rows} rows`);

  /* the numeric pager under the list: 50 chapters per tab, three numbered tabs */
  const pager = await evaluate(client, `(() => {
    const tabs = () => [...document.querySelectorAll('#chapterTabs .chapter-tabs__range')];
    const labels = () => tabs().map((t) => t.textContent);
    const active = () => {
      const node = document.querySelector('#chapterTabs .chapter-tabs__range.is-active');
      return node ? node.textContent : null;
    };
    const bg = (node) => (node ? getComputedStyle(node).backgroundColor : null);
    const rows = () => document.querySelectorAll('.chapter-row').length;
    const out = {
      shown: tabs().length,
      labels: labels(),
      names: tabs().map((t) => t.getAttribute('aria-label')),
      arrows: document.querySelectorAll('#chapterTabs .chapter-tabs__arrow svg use').length,
      active: active(),
      focusBg: bg(document.querySelector('#chapterTabs .chapter-tabs__range.is-active')),
      idleBg: bg(document.querySelector('#chapterTabs .chapter-tabs__range:not(.is-active)')),
      // the caption line that used to name the open range ("Chapters 1–50 · tab 1
      // of 19") is gone: the row of numbers is the last thing on the page
      caption: Boolean(document.querySelector('#chapterTabs .chapter-tabs__caption'))
        || Boolean(document.getElementById('rangeCaption')),
      tabsText: document.getElementById('chapterTabs').textContent,
      summary: document.getElementById('listSummary').textContent,
      prevOff: document.getElementById('rangePrev').disabled,
      rows: rows(),
    };
    document.getElementById('rangeNext').click();
    out.next = { labels: labels(), active: active(), rows: rows(), prevOff: document.getElementById('rangePrev').disabled };
    document.getElementById('rangePrev').click();
    out.back = { labels: labels(), active: active(), rows: rows(), nextOff: document.getElementById('rangeNext').disabled };
    const pos = () => labels().indexOf(active());
    // clicking a number keeps it in its slot: third stays third, first stays first
    tabs()[2].click();
    out.pick3 = { labels: labels(), active: active(), pos: pos() };
    document.getElementById('rangeNext').click();
    out.pick3Next = { labels: labels(), active: active(), pos: pos() };
    tabs()[0].click();
    out.pick1 = { labels: labels(), active: active(), pos: pos() };
    document.getElementById('rangeNext').click();
    out.pick1Next = { labels: labels(), active: active(), pos: pos() };
    // walk back to the first range so the reader checks start on chapters 1–50
    document.getElementById('rangePrev').click();
    document.getElementById('rangePrev').click();
    out.restored = labels().join(' ') + ' @' + pos();
    return out;
  })()`);
  check('chapter pager shows three range numbers with the open one filled in',
    pager.shown === 3 && pager.labels.join(' ') === '1 2 3' && pager.active === '1' && pager.arrows === 2
      && pager.names[0] === 'Chapters 1–50'
      && pager.focusBg !== pager.idleBg && pager.focusBg !== 'rgba(0, 0, 0, 0)',
    `${pager.labels.join(' ')} · ${pager.arrows} SVG arrow(s) · focus ${pager.active} (${pager.focusBg} vs ${pager.idleBg})`);
  check('pager arrows step one range and slide the window (1 2 3 → 2 3 4)',
    pager.prevOff === true && pager.next.labels.join(' ') === '2 3 4' && pager.next.active === '2'
      && pager.next.prevOff === false && pager.next.rows > 0
      && pager.back.labels.join(' ') === '1 2 3' && pager.back.active === '1' && pager.back.nextOff === false,
    `${pager.labels.join(' ')} → ${pager.next.labels.join(' ')} → ${pager.back.labels.join(' ')} · ${pager.rows} → ${pager.next.rows} → ${pager.back.rows} rows`);
  check('a clicked number keeps its slot — the third stays third, the first stays first',
    pager.pick3.labels.join(' ') === '1 2 3' && pager.pick3.active === '3' && pager.pick3.pos === 2
      && pager.pick3Next.labels.join(' ') === '2 3 4' && pager.pick3Next.active === '4' && pager.pick3Next.pos === 2
      && pager.pick1.labels.join(' ') === '2 3 4' && pager.pick1.active === '2' && pager.pick1.pos === 0
      && pager.pick1Next.labels.join(' ') === '3 4 5' && pager.pick1Next.active === '3' && pager.pick1Next.pos === 0
      && pager.restored === '1 2 3 @0',
    `third: ${pager.pick3.labels.join(' ')}@${pager.pick3.pos} → ${pager.pick3Next.labels.join(' ')}@${pager.pick3Next.pos}`
      + ` · first: ${pager.pick1.labels.join(' ')}@${pager.pick1.pos} → ${pager.pick1Next.labels.join(' ')}@${pager.pick1Next.pos}`
      + ` · back at ${pager.restored}`);

  check('the pager ends the page: no range caption, no “tab n of m” — only the numbers',
    pager.caption === false && !/Chapters|tab \d+ of/i.test(pager.tabsText)
      && /^\d+ of [\d,]+ chapters · [\d,]+ translated$/.test(pager.summary),
    `pager text “${pager.tabsText}” — list head “${pager.summary}”`);

  /* the pager is the last block of the list, in the list flow — not a bar pinned
     over it: position:relative, inside the scroller, right after #chapterList and
     without a bar container box, so it scrolls away with the chapters */
  const pagerPlace = await evaluate(client, `(async () => {
    const scroller = document.getElementById('libraryScroll');
    const nav = document.getElementById('chapterTabs');
    const list = document.getElementById('chapterList');
    const before = nav.getBoundingClientRect().top;
    scroller.scrollTop = scroller.scrollHeight;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const after = nav.getBoundingClientRect().top;
    const style = getComputedStyle(nav);
    const out = {
      position: style.position,
      inScroll: Boolean(nav.closest('#libraryScroll')),
      afterList: nav.previousElementSibling === list && nav.parentElement === list.parentElement,
      boxed: style.borderTopWidth !== '0px' || style.backgroundColor !== 'rgba(0, 0, 0, 0)',
      moved: Math.round(before - after),
    };
    scroller.scrollTop = 0;
    return out;
  })()`);
  check('the pager sits at the bottom of the list, in flow (relative, not pinned)',
    pagerPlace.position === 'relative' && pagerPlace.inScroll && pagerPlace.afterList
      && !pagerPlace.boxed && pagerPlace.moved > 100,
    `${pagerPlace.position} · in the scroller ${pagerPlace.inScroll} · right after the list ${pagerPlace.afterList}`
      + ` · bar container ${pagerPlace.boxed} · moved ${pagerPlace.moved}px when the list scrolled`);

  const tabs = await evaluate(client, `(() => {
    document.querySelector('.tab[data-tab="glossary"]').click();
    const gloss = document.querySelectorAll('.panel[data-panel="glossary"] .glossary-row').length;
    document.querySelector('.tab[data-tab="batch"]').click();
    const batch = document.querySelector('.panel[data-panel="batch"]').textContent.replace(/\\s+/g, ' ');
    document.querySelector('.tab[data-tab="info"]').click();
    const info = document.querySelector('.panel[data-panel="info"]').textContent.replace(/\\s+/g, ' ');
    document.querySelector('.tab[data-tab="rules"]').click();
    const rules = document.querySelector('.panel[data-panel="rules"]').textContent.replace(/\\s+/g, ' ');
    document.querySelector('.tab[data-tab="translation"]').click();
    return { gloss, batch, info, rules };
  })()`);
  check('glossary + batch tabs render the new edition’s numbers',
    tabs.gloss > 10 && /% of the novel/.test(tabs.batch) && /chapters are translated/.test(tabs.batch),
    `${tabs.gloss} glossary rows · ${tabs.batch.slice(0, 60)}…`);
  check('the info tab describes the chapter store, not the old page store',
    /chapters/.test(tabs.info) && !/ pages/.test(tabs.info),
    tabs.info.slice(0, 120));
  // a panel reading a number the seed no longer carries prints `undefined`, which is
  // exactly what a stale field name looks like on screen — so every panel is scanned
  check('no panel prints undefined or NaN',
    !/\bundefined\b/.test(`${tabs.batch} ${tabs.info} ${tabs.rules}`) && !/NaN/.test(`${tabs.batch} ${tabs.info}`),
    `${tabs.batch.slice(0, 40)}… · ${tabs.info.slice(0, 40)}…`);
}

/**
 * The chapter bar: it hangs off the chapter document (so it scrolls away with
 * the text instead of following the screen), its three text actions, the wide
 * Raw / Translated switch — flanked by the same two chapter steps as the bar's
 * arrows, so the chapter can be left from its own head — and the centered card a
 * chapter whose translation is not there yet stands in for it.
 */
async function checkChapterBar(client) {
  const opened = await evaluate(client, `(async () => {
    const input = document.getElementById('searchInput');
    input.value = 'Chaotic World';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const row = document.querySelector('.chapter-row');
    row.click();
    return Boolean(row);
  })()`);
  await sleep(500);

  /* ---- the bar itself: chapter content, one tool per action ---- */
  const bar = await evaluate(client, `(() => {
    const body = document.getElementById('readerBody');
    const head = body.querySelector('.chapter-head');
    if (!head) return { head: false };
    const box = (node) => node.getBoundingClientRect();
    return {
      head: true,
      first: body.firstElementChild === head,
      title: head.querySelector('.chapter-head__title').textContent,
      site: head.querySelector('.credit__site').textContent,
      chip: head.querySelector('.credit__name').textContent,
      creditOrder: [...head.querySelector('.credit').children].map((n) => n.className),
      tools: [...head.querySelectorAll('.chapter-tool use')].map((u) => u.getAttribute('href')),
      options: [...head.querySelectorAll('.src-switch__opt')].map((o) => o.textContent),
      active: (head.querySelector('.src-switch__opt.is-active') || {}).textContent || null,
      sections: body.querySelectorAll('.chapter-page').length,
      blanks: body.querySelectorAll('.chapter-blank').length,
      // the head runs title → site → credit chip → tools → switch, in that order
      order: ['chapter-head__title', 'credit__name', 'chapter-head__tools', 'src-switch']
        .map((sel) => Math.round(box(head.querySelector('.' + sel)).top)),
      text: body.textContent,
    };
  })()`);
  check('a chapter opens under its own bar',
    opened && bar.head && bar.first && /^Chapter 1 · /.test(bar.title || ''),
    `${bar.title} · first child of the chapter: ${bar.first}`);
  check('the bar carries save / copy / refresh and the Raw | Translated switch',
    bar.tools.join(' ') === '#round-save-alt #i-copy #i-refresh'
      && bar.options.join(' | ') === 'Raw | Translated' && bar.active === 'Translated',
    `${bar.tools.join(' ')} · ${bar.options.join(' | ')} (${bar.active})`);
  check('the head runs title → site line → credit chip → tools → switch, with no badge or path',
    bar.site === 'novelity.vercel.com' && bar.chip === 'Credit: Im Boravath'
      && bar.creditOrder.join(' ') === 'credit__site credit__name'
      && bar.order.every((top, i) => i === 0 || top > bar.order[i - 1])
      && bar.sections === 1 && bar.blanks === 0 && !/Doer\/Result|sources\//.test(bar.text),
    `${bar.site} · ${bar.chip} · tops ${bar.order.join(' < ')} · ${bar.sections} section(s)`);

  /* ---- the ‹ › either side of the switch are the bar's arrows, up in the head ---- */
  const headArrows = await evaluate(client, `(() => {
    const arrows = [...document.querySelectorAll('#readerBody .src-switch__arrow')];
    return {
      count: arrows.length,
      titles: arrows.map((a) => a.title),
      ends: arrows.map((a) => a.disabled),
      barEnds: [document.getElementById('prevBtn').disabled, document.getElementById('nextBtn').disabled],
    };
  })()`);
  check('the ‹ › by the switch are previous / next chapter, off at the ends like the bar’s pair',
    headArrows.count === 2 && headArrows.titles.join(' | ') === 'Previous chapter | Next chapter'
      && headArrows.ends[0] === true && headArrows.ends[1] === false
      && headArrows.ends.join() === headArrows.barEnds.join(),
    `${headArrows.titles.join(' | ')} · chapter 1: head ${headArrows.ends.join('/')} vs bar ${headArrows.barEnds.join('/')}`);

  const stepped = await evaluate(client, `(async () => {
    const arrows = () => [...document.querySelectorAll('#readerBody .src-switch__arrow')];
    const title = () => document.querySelector('#readerBody .chapter-head__title').textContent;
    arrows()[1].click();
    await new Promise((r) => setTimeout(r, 450));
    const on = title();
    const endsOn2 = arrows().map((a) => a.disabled);
    arrows()[0].click();
    await new Promise((r) => setTimeout(r, 450));
    return {
      on, endsOn2, back: title(),
      barEnds: [document.getElementById('prevBtn').disabled, document.getElementById('nextBtn').disabled],
    };
  })()`);
  check('…and clicking them turns the chapter, both ways, the way the bottom arrows do',
    /^Chapter 2 · /.test(stepped.on) && stepped.back === bar.title
      && stepped.endsOn2[0] === false && stepped.endsOn2[1] === false
      && stepped.barEnds[0] === true,
    `${bar.title} → ${stepped.on} → ${stepped.back} · on chapter 2: head ${stepped.endsOn2.join('/')}`);

  /* ---- Raw: the Chinese original behind the same chapter ---- */
  const raw = await evaluate(client, `(async () => {
    document.querySelector('#readerBody .src-switch__opt[data-source="raw"]').click();
    await new Promise((r) => setTimeout(r, 200));
    const doc = document.querySelector('.chapter-doc');
    const out = {
      active: document.querySelector('#readerBody .src-switch__opt.is-active').textContent,
      pressed: document.querySelector('#readerBody .src-switch__opt[data-source="raw"]').getAttribute('aria-pressed'),
      stored: localStorage.getItem('novelity:chapter-source'),
      attr: doc.dataset.source,
      chinese: [...doc.textContent].some((ch) => ch.charCodeAt(0) >= 0x4e00 && ch.charCodeAt(0) <= 0x9fa5),
      headers: [...doc.querySelectorAll('p')].filter((p) => p.textContent.startsWith('#')).length,
      sections: doc.querySelectorAll('.chapter-page').length,
      pageText: document.getElementById('readerScroll').textContent,
    };
    document.getElementById('readerMenu').click();
    await new Promise((r) => setTimeout(r, 200));
    out.menu = document.getElementById('toast').textContent;
    return out;
  })()`);
  check('Raw re-renders the chapter from its Chinese source file',
    raw.active === 'Raw' && raw.pressed === 'true' && raw.attr === 'raw'
      && raw.chinese && raw.sections === 1,
    `${raw.sections} section(s) of Chinese`);
  check('the source file the Raw view read is named in the ⋮ menu, not on the page',
    raw.menu.includes('sources/chapter_0001/original.zh.txt')
      && /Chinese characters/.test(raw.menu)
      && !/sources\/|Doer\/Result/.test(raw.pageText),
    raw.menu.slice(0, 140));
  check('the `#` header lines of the source file are metadata, not text',
    raw.headers === 0, `${raw.headers} header line(s) rendered`);

  const backTo = await evaluate(client, `(async () => {
    document.querySelector('#readerBody .src-switch__opt[data-source="translated"]').click();
    await new Promise((r) => setTimeout(r, 200));
    const doc = document.querySelector('.chapter-doc');
    return {
      active: document.querySelector('#readerBody .src-switch__opt.is-active').textContent,
      attr: doc.dataset.source,
      english: /[A-Za-z]{3}/.test(doc.textContent),
      stored: localStorage.getItem('novelity:chapter-source'),
    };
  })()`);
  check('the switch comes back to Translated and the choice is remembered per device',
    backTo.active === 'Translated' && backTo.attr === 'translated' && backTo.english
      && backTo.stored === 'translated',
    `${backTo.active} · remembered as ${backTo.stored}`);

  /* ---- save / copy / refresh: three icons, three actions ---- */
  const actions = await evaluate(client, `(async () => {
    const tool = (label) => [...document.querySelectorAll('.chapter-tool')]
      .find((t) => (t.getAttribute('aria-label') || '').startsWith(label));
    const out = {
      labels: [...document.querySelectorAll('.chapter-tool')].map((t) => t.title),
      download: null, href: '', copied: '', toasts: [],
    };
    const toast = () => document.getElementById('toast').textContent;

    // save: the bar hands the browser a file, so watch the anchor it clicks
    const proto = HTMLAnchorElement.prototype;
    const click = proto.click;
    proto.click = function () { if (this.download) { out.download = this.download; out.href = this.href; } };
    tool('Save').click();
    await new Promise((r) => setTimeout(r, 250));
    proto.click = click;
    out.toasts.push(toast());

    // copy: take over the clipboard, then read back what the bar put on it
    const clipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => { out.copied = text; } },
    });
    tool('Copy').click();
    await new Promise((r) => setTimeout(r, 300));
    out.toasts.push(toast());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });

    // refresh: read the chapter's two files again, then repaint it
    tool('Re-read').click();
    await new Promise((r) => setTimeout(r, 500));
    out.toasts.push(toast());
    out.sections = document.querySelectorAll('#readerBody .chapter-page').length;
    out.bar = Boolean(document.querySelector('#readerBody .chapter-head'));
    return out;
  })()`);
  check('save hands the browser chapter_0001.en.txt, built from the chapter on screen',
    actions.labels.join(' | ')
      === 'Save this chapter as a text file | Copy this chapter | Re-read this chapter from its files'
      && actions.download === 'chapter_0001.en.txt' && actions.href.startsWith('blob:')
      && /^Saved chapter_0001\.en\.txt$/.test(actions.toasts[0] || ''),
    `${actions.toasts[0]} · ${actions.download}`);
  check('copy puts the chapter file on the clipboard and says how much went',
    /^The sky was dim white, completely clear of clouds\./.test(actions.copied || '')
      && actions.copied.split('\n\n').length > 50
      && /^Copied the translated chapter text \(\d[\d,]* characters\)$/.test(actions.toasts[1] || ''),
    `${actions.toasts[1]} · ${(actions.copied || '').length} characters`);
  check('refresh re-reads the chapter’s files and leaves the bar where it was',
    /^Chapter re-read from the files\.$/.test(actions.toasts[2] || '')
      && actions.sections === 1 && actions.bar === true,
    `${actions.toasts[2]} · ${actions.sections} section(s), bar ${actions.bar}`);

  /* ---- it is chapter content: the text scrolls it away, nothing pins it ---- */
  const anchored = await evaluate(client, `(async () => {
    const surface = document.getElementById('readerScroll');
    const head = document.querySelector('.chapter-head');
    surface.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 400));
    const before = Math.round(head.getBoundingClientRect().top);
    surface.scrollTop = 600;
    await new Promise((r) => setTimeout(r, 400));
    const after = Math.round(head.getBoundingClientRect().top);
    const out = {
      position: getComputedStyle(head).position,
      inBody: head.parentElement.id === 'readerBody',
      moved: before - after,
    };
    surface.scrollTop = 0;
    return out;
  })()`);
  check('the bar rides on the chapter: it scrolls away with the text, nothing pins it',
    ['static', 'relative'].includes(anchored.position) && anchored.inBody && anchored.moved > 100,
    `${anchored.position} · first child of #readerBody ${anchored.inBody} · moved ${anchored.moved}px when the chapter scrolled`);

  /* ---- a chapter the run has not reached: one centered card, Raw still reads ---- */
  const placeholder = await evaluate(client, `(async () => {
    const input = document.getElementById('searchInput');
    input.value = '904';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const row = document.querySelector('.chapter-row');
    const opened = Boolean(row);
    if (row) row.click();
    await new Promise((r) => setTimeout(r, 500));
    const body = document.getElementById('readerBody');
    const card = body.querySelector('.chapter-blank');
    const box = card ? card.getBoundingClientRect() : null;
    const area = body.getBoundingClientRect();
    const out = {
      opened,
      title: body.querySelector('.chapter-head__title').textContent,
      site: body.querySelector('.credit__site').textContent,
      chip: body.querySelector('.credit__name').textContent,
      cards: body.querySelectorAll('.chapter-blank').length,
      sections: body.querySelectorAll('.chapter-page').length,
      text: card ? card.textContent.trim() : '',
      icon: card ? card.firstElementChild.tagName.toLowerCase() : '',
      centered: box ? Math.abs((box.left + box.right) / 2 - (area.left + area.right) / 2) < 2 : false,
      align: card ? getComputedStyle(card).textAlign : null,
      pageText: document.getElementById('readerScroll').textContent,
    };
    // the file a chapter is waiting for is the ⋮ menu's business, not the page's
    document.getElementById('readerMenu').click();
    await new Promise((r) => setTimeout(r, 200));
    out.menu = document.getElementById('toast').textContent;
    // the Chinese of the same chapter is there, so the Raw view still reads
    document.querySelector('#readerBody .src-switch__opt[data-source="raw"]').click();
    await new Promise((r) => setTimeout(r, 300));
    const doc = document.querySelector('.chapter-doc');
    out.raw = {
      sections: doc.querySelectorAll('.chapter-page').length,
      chinese: [...doc.textContent].some((ch) => ch.charCodeAt(0) >= 0x4e00 && ch.charCodeAt(0) <= 0x9fa5),
      blanks: doc.querySelectorAll('.chapter-blank').length,
    };
    document.querySelector('#readerBody .src-switch__opt[data-source="translated"]').click();
    // leave the library as the next check expects to find it
    document.getElementById('readerBack').click();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return out;
  })()`);
  check('a chapter with nothing translated stands one centered card in its place',
    placeholder.opened && /^Chapter 904 · /.test(placeholder.title || '')
      && placeholder.cards === 1 && placeholder.sections === 0
      && placeholder.text === 'This chapter is not translated yet. Coming Soon...'
      && placeholder.icon === 'svg' && placeholder.centered && placeholder.align === 'center',
    `${placeholder.title} · ${placeholder.cards} centered card(s), text-align ${placeholder.align}`);
  check('the head still says where the project lives, exactly as on a translated chapter',
    placeholder.site === 'novelity.vercel.com' && placeholder.chip === 'Credit: Im Boravath',
    `${placeholder.site} · ${placeholder.chip}`);
  check('the card names no file — the ⋮ menu names the file it is waiting for',
    /not translated yet — nothing in Doer\/Result\/chapter_0904\/chapter_0904\.txt/.test(placeholder.menu || '')
      && /第904章/.test(placeholder.menu || '')
      && !/Doer\/Result|sources\//.test(placeholder.pageText),
    placeholder.menu.replace(/\s+/g, ' ').slice(0, 140));
  check('the same chapter still reads in Chinese under Raw',
    placeholder.raw.sections === 1 && placeholder.raw.chinese && placeholder.raw.blanks === 0,
    `Raw: ${placeholder.raw.sections} section(s) of Chinese`);
}

/**
 * The screen is a phone first. A long chapter title used to make the `1fr auto`
 * card grid wider than the viewport, which pushed the ⋮ button off screen and let
 * the whole list scroll sideways. Shrink the emulated device to 360×740 and
 * assert that nothing does that any more.
 */
async function checkNarrowLayout(client) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 360, height: 740, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(450);
  const narrow = await evaluate(client, `(() => {
    const vw = window.innerWidth;
    const scroller = document.getElementById('libraryScroll');
    const out = [];
    for (const node of document.querySelectorAll('body *')) {
      if (node.closest('svg') || node.closest('#viewReader')) continue;
      const r = node.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      if (r.right > vw + 0.5 || r.left < -0.5) {
        out.push((node.id ? '#' + node.id : node.tagName.toLowerCase())
          + (typeof node.className === 'string' && node.className
            ? '.' + node.className.trim().split(/\\s+/).join('.') : ''));
      }
    }
    return {
      vw,
      pageOverflow: document.documentElement.scrollWidth - vw,
      listOverflow: scroller.scrollWidth - scroller.clientWidth,
      titleClipped: getComputedStyle(document.querySelector('.book-card__title')).textOverflow === 'ellipsis',
      offenders: out.slice(0, 6),
    };
  })()`);
  check('at 360px the library does not scroll sideways',
    narrow.pageOverflow === 0 && narrow.listOverflow === 0,
    `page ${narrow.pageOverflow}px over · list ${narrow.listOverflow}px over`);
  check('nothing pokes past the edge on a phone-sized screen',
    narrow.offenders.length === 0 && narrow.titleClipped,
    narrow.offenders.length ? narrow.offenders.join(', ') : 'long titles ellipsise');
  await client.send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);
}

/**
 * A reload must not throw the reader back to the top of the library — which is
 * what an editor's live reload does to a chapter being read (VS Code Live Server /
 * Live Preview reloads the page whenever a file under it changes, and the run
 * writes files while it works). The chapter this tab had open, and the line it was
 * on, are kept for the tab, so a page load comes back to them.
 */
async function checkReload(client) {
  await client.send('Page.enable');
  const before = await evaluate(client, `(async () => {
    const input = document.getElementById('searchInput');
    input.value = 'Chaotic World';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    document.querySelector('.chapter-row').click();
    await new Promise((r) => setTimeout(r, 450));
    document.getElementById('readerScroll').scrollTop = 900;
    await new Promise((r) => setTimeout(r, 120));
    return {
      heading: document.querySelector('#readerBody .chapter-head__title').textContent,
      scrollTop: Math.round(document.getElementById('readerScroll').scrollTop),
    };
  })()`);

  await client.send('Page.reload', { ignoreCache: false });
  const restored = await evaluate(client, `new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const view = document.getElementById('viewReader');
      const open = Boolean(view) && !view.hidden;
      const text = document.querySelectorAll('.chapter-doc p').length;
      if (window.__novelityReady && open && text) {
        clearInterval(iv);
        resolve({
          heading: document.querySelector('#readerBody .chapter-head__title').textContent,
          scrollTop: Math.round(document.getElementById('readerScroll').scrollTop),
        });
      } else if (Date.now() - t0 > 15000) {
        clearInterval(iv);
        resolve({ timeout: true, open, text });
      }
    }, 100);
  })`);

  check('a reload comes back to the chapter the tab was reading',
    !restored.timeout && restored.heading === before.heading,
    restored.timeout ? JSON.stringify(restored) : `${before.heading} → ${restored.heading}`);
  check('…at the line it was on, not the top of the document',
    !restored.timeout && Math.abs(restored.scrollTop - before.scrollTop) < 40,
    `was at ${before.scrollTop}px, came back at ${restored.scrollTop}px`);

  // leave the library as the narrow-layout check expects to find it
  await evaluate(client, `(() => {
    document.getElementById('readerBack').click();
    const input = document.getElementById('searchInput');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(250);
}



/**
 * One face for the whole app, and nothing bold. SF Pro Rounded ships with the
 * project (`assets/fonts/SF-PRO-ROUNDED.TTF`) and is the only face the Latin text
 * may be set in; the Chinese source keeps its own serif stack (`--font-serif`),
 * which is a font choice and not a weight one. Every element sits at weight 400 —
 * `<b>` and `<strong>`, which is how a bold cut usually sneaks back in, included.
 */
async function checkTypography(client) {
  const type = await evaluate(client, `(async () => {
    await document.fonts.ready;
    const weight = (node) => getComputedStyle(node).fontWeight;
    const seen = new Set();
    let scanned = 0;
    for (const node of document.querySelectorAll('body *')) {
      if (node.closest('.sprite')) continue;
      scanned++;
      if (Number(weight(node)) > 400) {
        const name = typeof node.className === 'string' && node.className.trim()
          ? '.' + node.className.trim().split(/\\s+/).join('.') : node.tagName.toLowerCase();
        seen.add(name + ':' + weight(node));
      }
    }

    // <b> and <strong> are the two ways a bold cut comes back without a class
    const probe = document.createElement('div');
    probe.innerHTML = '<b>bold</b><strong>strong</strong>';
    document.getElementById('readerBody').append(probe);
    const probes = [...probe.children].map((n) => weight(n));
    probe.remove();

    // the Chinese source wears its own serif stack, never the rounded face
    const doc = document.createElement('div');
    doc.className = 'chapter-doc';
    doc.dataset.source = 'raw';
    const para = document.createElement('p');
    para.textContent = '\\u7b2c\\u4e00\\u7ae0';
    doc.append(para);
    document.getElementById('readerBody').append(doc);
    const rawFace = getComputedStyle(para).fontFamily;
    doc.remove();

    return {
      family: getComputedStyle(document.body).fontFamily,
      loaded: document.fonts.check('16px "SF Pro Rounded"'),
      bold: [...seen].slice(0, 6),
      scanned,
      probes,
      rawFace,
    };
  })()`);
  check('the app is set in SF Pro Rounded, loaded from assets/fonts',
    /^"?SF Pro Rounded"?/.test(type.family.trim()) && type.loaded,
    `${type.family.split(',').slice(0, 2).join(',')} — face loaded: ${type.loaded}`);
  check('nothing is bold: every element sits at 400, <b> and <strong> included',
    type.bold.length === 0 && type.probes.every((w) => w === '400'),
    `${type.scanned} element(s) scanned${type.bold.length ? ' — ' + type.bold.join(', ') : ''}`
      + ` — <b>/<strong> at ${type.probes.join('/')}`);
  check('the Chinese source keeps its own face instead of the rounded one',
    /serif/i.test(type.rawFace) && !/SF Pro Rounded/.test(type.rawFace),
    type.rawFace);
}

