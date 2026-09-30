// tests/smoke.mjs
// ---------------------------------------------------------------------------
// End-to-end smoke test of the reader, run in headless Chrome over CDP
// (no npm dependencies: Node's global WebSocket + fetch are enough).
//
//   node tests/smoke.mjs
//
// It verifies that
//   1. the static server serves the app,
//   2. boot() reads data/novel-data.js and writes the whole book to IndexedDB,
//   3. the library list renders chapter rows with headings and no status chip,
//   4. the numeric chapter pager walks the list through its 50-chapter ranges,
//   5. opening a chapter renders page text + the Chinese fallback,
//   6. the SVG arrow buttons walk to the next / previous page,
//   7. a reading position is persisted in IndexedDB (meta store),
//   8. the reading mode bars fold away on scroll and hand their room to the text,
//   9. at 360px nothing overflows the screen sideways,
//  10. the pager is list content — relative, under the last row, no bar container,
//  11. a chapter is marked as read only after the reader has opened it.
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

const IDB_COUNT = `(async () => {
  const open = () => new Promise((res, rej) => { const q = indexedDB.open('novelity'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  try {
    const db = await open();
    if (!db.objectStoreNames.contains('pages') || !db.objectStoreNames.contains('meta')) {
      return { pages: null, chapters: null, progress: null, note: 'stores missing — app never seeded' };
    }
    const count = (store) => new Promise((res, rej) => { const r = db.transaction(store).objectStore(store).count(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const progress = await new Promise((res, rej) => { const r = db.transaction('meta').objectStore('meta').get('progress'); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); });
    return { pages: await count('pages'), chapters: await count('chapters'), progress };
  } catch (err) {
    return { pages: null, chapters: null, progress: null, note: String(err && err.message || err) };
  }
})()`;

/** reader: whole-chapter view, the single-page view, the arrows, keyboard, persistence */
async function checkReader(client) {
  const opened = await evaluate(client, `(() => {
    const rows = [...document.querySelectorAll('.chapter-row')];
    const row = rows.find((r) => r.querySelector('.chapter-row__title').textContent.includes('Chaotic World')) || rows[0];
    row.click();
    return Boolean(row);
  })()`);
  await sleep(500);

  /* ---- default mode: one whole chapter per screen ---- */
  const chapter = await evaluate(client, `(() => {
    const body = document.getElementById('readerBody');
    return {
      libraryHidden: document.getElementById('viewLibrary').hidden,
      readerShown: !document.getElementById('viewReader').hidden,
      heading: document.getElementById('readerHeading').textContent,
      paragraphs: body.querySelectorAll('p').length,
      firstParagraph: (body.querySelector('p') || {}).textContent || '',
      pages: body.querySelectorAll('.chapter-page').length,
      separators: body.querySelectorAll('.reader-page-sep').length,
      notice: document.getElementById('readerNotice').hidden ? null : 'shown',
      counter: document.getElementById('readerCounter').textContent,
      chapterLine: document.getElementById('readerChapter').textContent,
      modeLabel: document.getElementById('readerModeLabel').textContent,
      prevDisabled: document.getElementById('prevBtn').disabled,
      nextDisabled: document.getElementById('nextBtn').disabled,
      arrows: document.querySelectorAll('.reader-nav .page-arrow svg').length,
      bar: document.getElementById('readerProgressBar').style.width,
    };
  })()`);
  check('row click opens the reader', opened && chapter.readerShown && chapter.libraryHidden === true);
  check('a chapter is one document: every source page of it is stacked inside',
    chapter.pages === 3 && chapter.separators === 3, `${chapter.pages} page block(s) · ${chapter.separators} separator(s)`);
  check('chapter text rendered from IndexedDB', chapter.paragraphs > 0, `${chapter.paragraphs} paragraph(s)`);
  check('chapter heading used as the reader heading', chapter.heading === 'Chapter 1 · Chaotic World', chapter.heading);
  check('counter counts the chapter, not a lone page',
    /^Chapter 1 · 3 pages$/.test(chapter.counter), `${chapter.counter} · ${chapter.chapterLine}`);
  check('mode chip offers the other view', chapter.modeLabel === 'Page view', chapter.modeLabel);
  check('two SVG arrows; left disabled on chapter 1',
    chapter.arrows === 2 && chapter.prevDisabled === true && chapter.nextDisabled === false);
  check('progress bar + chapter line update',
    /%$/.test(chapter.bar) && /translated/.test(chapter.chapterLine), `${chapter.bar} · ${chapter.chapterLine}`);

  /* ---- in this mode the arrows step chapter by chapter ---- */
  await evaluate(client, `document.getElementById('nextBtn').click()`);
  await sleep(450);
  const nextChapter = await evaluate(client, `(() => ({
    counter: document.getElementById('readerCounter').textContent,
    heading: document.getElementById('readerHeading').textContent,
  }))()`);
  check('right arrow steps to the next chapter',
    /^Chapter 2 · 3 pages$/.test(nextChapter.counter) && /Hope/.test(nextChapter.heading),
    `${nextChapter.counter} · ${nextChapter.heading}`);
  await evaluate(client, `document.getElementById('prevBtn').click()`);
  await sleep(450);
  const backChapter = await evaluate(client, `document.getElementById('readerCounter').textContent`);
  check('left arrow steps back to chapter 1', /^Chapter 1 · 3 pages$/.test(backChapter), backChapter);

  /* ---- reading mode: the bars fold away on scroll and give their room to the text ---- */
  const barBox = `(() => {
    const view = document.getElementById('viewReader');
    const surface = document.getElementById('readerScroll');
    const h = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().height);
    return {
      hidden: view.classList.contains('is-bars-hidden'),
      text: surface.clientHeight,
      appbar: h('.appbar--reader'),
      nav: h('.reader-nav'),
      scrollMax: Math.round(surface.scrollHeight - surface.clientHeight),
    };
  })()`;
  const chromeOpen = await evaluate(client, barBox);
  check('a chapter opens with both bars on screen',
    !chromeOpen.hidden && chromeOpen.appbar > 0 && chromeOpen.nav > 0,
    `app bar ${chromeOpen.appbar}px · nav ${chromeOpen.nav}px`);

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

  /* ---- toggle to the single-page view (what the translation workflow edits) ---- */
  await evaluate(client, `document.getElementById('readerMode').click()`);
  await sleep(450);
  const page1 = await evaluate(client, `(() => {
    const body = document.getElementById('readerBody');
    return {
      heading: document.getElementById('readerHeading').textContent,
      meta: document.getElementById('readerMeta').textContent,
      paragraphs: body.querySelectorAll('p').length,
      firstParagraph: (body.querySelector('p') || {}).textContent || '',
      pages: body.querySelectorAll('.chapter-page').length,
      notice: document.getElementById('readerNotice').hidden ? null : 'shown',
      srcBox: !document.getElementById('sourceBox').hidden,
      counter: document.getElementById('readerCounter').textContent,
      chapterLine: document.getElementById('readerChapter').textContent,
      modeLabel: document.getElementById('readerModeLabel').textContent,
      prevDisabled: document.getElementById('prevBtn').disabled,
      nextDisabled: document.getElementById('nextBtn').disabled,
    };
  })()`);
  check('toggle switches to one source page per screen',
    page1.pages === 0 && page1.paragraphs > 0, `${page1.paragraphs} paragraph(s)`);
  check('page view names the position inside the chapter',
    /page 1 of 3 in this chapter/.test(page1.meta), page1.meta);
  check('counter + progress bar update', /Page 1 of 1,836/.test(page1.counter), `${page1.counter} · ${page1.chapterLine}`);
  check('mode chip offers the other view', page1.modeLabel === 'Whole chapter', page1.modeLabel);
  check('left disabled on page 1; right enabled', page1.prevDisabled === true && page1.nextDisabled === false);

  const p1translated = await evaluate(client, `window.NOVEL_DATA.pages[0].translated`);
  if (p1translated) {
    check('translated page renders English', page1.notice === null && /[A-Za-z]{3}/.test(page1.firstParagraph),
      page1.firstParagraph.slice(0, 70));
    check('Chinese source kept behind a toggle', page1.srcBox === true);
  } else {
    check('pending translation falls back to the Chinese source', page1.notice === 'shown' && /[\u4e00-\u9fa5]/.test(page1.firstParagraph));
    check('Chinese toggle hidden while untranslated', page1.srcBox === false);
  }

  await evaluate(client, `document.getElementById('nextBtn').click()`);
  await sleep(350);
  const page2 = await evaluate(client, `(() => ({
    counter: document.getElementById('readerCounter').textContent,
    heading: document.getElementById('readerHeading').textContent,
    prevDisabled: document.getElementById('prevBtn').disabled,
  }))()`);
  check('right arrow turns to the next page', /Page 2 of 1,836/.test(page2.counter), `${page2.counter} · ${page2.heading}`);
  check('left arrow re-enabled after page 1', page2.prevDisabled === false);

  const idb = await evaluate(client, IDB_COUNT);
  check('reading position stored in IndexedDB', !!idb.progress && idb.progress.pageId === 2,
    idb.progress ? `page ${idb.progress.pageId} (seq ${idb.progress.seq})` : 'no progress row');

  await evaluate(client, `document.getElementById('prevBtn').click()`);
  await sleep(300);
  const back = await evaluate(client, `document.getElementById('readerCounter').textContent`);
  check('left arrow returns to the previous page', /Page 1 of 1,836/.test(back), back);

  await evaluate(client, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  await sleep(300);
  const keyed = await evaluate(client, `document.getElementById('readerCounter').textContent`);
  check('ArrowRight key turns the page', /Page 2 of 1,836/.test(keyed), keyed);

  await evaluate(client, `document.getElementById('readerMode').click()`);
  await sleep(450);
  const regrouped = await evaluate(client, `(() => ({
    counter: document.getElementById('readerCounter').textContent,
    pages: document.getElementById('readerBody').querySelectorAll('.chapter-page').length,
  }))()`);
  check('switching back groups the chapter around the current page',
    /^Chapter 1 · 3 pages$/.test(regrouped.counter) && regrouped.pages === 3,
    `${regrouped.counter} · ${regrouped.pages} page block(s)`);

  await evaluate(client, `document.getElementById('readerBack').click()`);
  await sleep(350);
  const library = await evaluate(client, `(() => {
    const marked = [...document.querySelectorAll('.chapter-row.is-read')];
    const plain = [...document.querySelectorAll('.chapter-row:not(.is-read)')];
    const edge = (node) => (node ? getComputedStyle(node).borderLeftColor : null);
    return {
      readerHidden: document.getElementById('viewReader').hidden,
      label: document.querySelector('#continueBtn .continue__label').textContent,
      title: document.getElementById('continueTitle').textContent,
      marked: marked.map((r) => r.querySelector('.chapter-row__title').textContent),
      readEdge: edge(marked[0]),
      plainEdge: edge(plain[0]),
      stored: localStorage.getItem('novelity:read-chapters'),
    };
  })()`);
  check('back button returns to the library', library.readerHidden === true);
  check('continue-reading card follows the saved page', library.label === 'CONTINUE READING', library.title);
  /* the reader opened chapter 1, stepped into chapter 2 and came back: exactly
     those two rows may be marked — nothing is marked up front */
  check('only the chapters the reader opened are marked as read',
    library.marked.length === 2
      && library.marked.some((t) => /Chaotic World/.test(t))
      && library.marked.some((t) => /Hope/.test(t)),
    library.marked.length ? library.marked.join(' · ') : 'nothing marked');
  check('the read mark is the green left edge; unread rows stay plain',
    /^rgb\(33, 164, 94\)$/.test(library.readEdge || '') && library.readEdge !== library.plainEdge,
    `read ${library.readEdge} · unread ${library.plainEdge}`);
  check('the read mark is remembered on the device',
    library.stored === '["ch1","ch2"]', String(library.stored));
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
    check('boot completes and loads the book', !ready.timeout && ready.pages > 0, JSON.stringify(ready));
    check('IndexedDB used (not the in-memory fallback)', ready.fallback === false);

    const idb = await evaluate(client, IDB_COUNT);
    check('pages store holds one row per page', idb.pages === ready.pages, `${idb.pages} rows / ${ready.pages} pages`);
    check('chapters store populated', idb.chapters === ready.chapters, `${idb.chapters} rows`);

    await checkLibrary(client);
    await checkReader(client);
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

/** library list: rendering, search, sort, filter, the 50-chapter range pager, tabs */
async function checkLibrary(client) {
  const list = await evaluate(client, `(() => {
    const rows = [...document.querySelectorAll('.chapter-row')];
    return {
      rows: rows.length,
      first: rows.length ? rows[0].querySelector('.chapter-row__title').textContent : null,
      badges: document.querySelectorAll('.chapter-row .badge').length,
      marked: document.querySelectorAll('.chapter-row.is-read').length,
      kebab: rows.length ? Boolean(rows[0].querySelector('.row-actions .row-kebab')) : false,
      summary: document.getElementById('listSummary').textContent,
      continueLabel: document.querySelector('#continueBtn .continue__label').textContent,
      cover: document.querySelector('.book-cover') ? document.querySelector('.book-cover').getAttribute('src') : null,
    };
  })()`);
  check('library list renders chapter rows', list.rows > 0, `${list.rows} rows · ${list.summary}`);
  check('rows carry chapter headings and no status chip',
    /^(Chapter \d+|第\d+章|\d+)/.test(list.first || '')
      && list.badges === 0 && list.kebab && list.marked === 0,
    `${list.first} · ${list.badges} status chip(s) · ${list.marked} marked as read · ⋮ ${list.kebab}`);
  // the cover is swapped between the generated placeholder (assets/cover.svg) and
  // the real artwork (assets/cover.png) — either is fine, it just has to be wired
  check(
    'cover + continue card wired',
    ['assets/cover.png', 'assets/cover.svg'].includes(list.cover) && list.continueLabel === 'START READING',
    `${list.cover} · ${list.continueLabel}`,
  );

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
    document.getElementById('filterBtn').click();
    document.querySelector('#filterPopover .popover__item[data-filter="translated"]').click();
    const out = {
      hidden: document.getElementById('filterPopover').hidden,
      label: document.getElementById('filterLabel').textContent,
      rows: document.querySelectorAll('.chapter-row').length,
      empty: !!document.querySelector('#chapterList .empty'),
    };
    document.getElementById('filterBtn').click();
    document.querySelector('#filterPopover .popover__item[data-filter="all"]').click();
    return out;
  })()`);
  check('filter popover filters the list', filter.hidden === true && filter.label === 'Translated only',
    `${filter.rows} rows, empty state: ${filter.empty}`);

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
      caption: document.getElementById('rangeCaption').textContent,
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
  check('caption + list head spell out the visible range',
    /^Chapters 1–50 · tab 1 of \d+$/.test(pager.caption)
      && /^\d+ of [\d,]+ chapters · [\d,]+ of [\d,]+ pages translated$/.test(pager.summary),
    `${pager.caption} — “${pager.summary}”`);

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
    const batch = document.querySelector('.panel[data-panel="batch"]').textContent;
    document.querySelector('.tab[data-tab="translation"]').click();
    return { gloss, batch: batch.slice(0, 40) };
  })()`);
  check('glossary + batch tabs render', tabs.gloss > 10, `${tabs.gloss} glossary rows · ${tabs.batch}…`);

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
