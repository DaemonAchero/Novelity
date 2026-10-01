/* ===========================================================================
   app.js — library + reader UI
   ---------------------------------------------------------------------------
   Data flow: data/novel-data.js (build output) -> IndexedDB (js/db.js) -> UI.
   The seed is a chapter INDEX — number, heading, translated / pending, Chinese
   character count. Chapter text is never stored: the reader fetches the two
   files a chapter owns (sources/chapter_XXXX/original.zh.txt and the English
   chapter Doer wrote in Doer/Result/) every time it opens one, so a fresh
   translation is on screen as soon as its file is there.
   =========================================================================== */
(() => {
  'use strict';

  const SEED = window.NOVEL_DATA || null;
  const $ = (id) => document.getElementById(id);
  const READ_KEY = 'novelity:read-chapters';  // chapter ids the reader has opened
  const RANGE_SIZE = 50;   // chapters covered by one range tab
  const RANGE_SPAN = 3;    // range tabs the pager keeps on screen at once

  const state = {
    chapters: [],
    currentId: null,    // id of the chapter on screen ("ch150")
    filter: 'all',
    // 'asc' keeps the list in chapter order, so the first range tab reads 1, 2, 3 … 50
    sort: 'asc',
    search: '',
    tab: 'translation',
    range: 0,           // which 50-chapter range tab the chapter list shows
    rangeSlot: 0,       // which slot (0 left, 1 middle, 2 right) the open tab sits in;
                        // the pager keeps it, so a number never jumps to the first slot
    // 'translated' (default) or 'raw' — which of the chapter's two texts the
    // chapter bar has on screen. Remembered per device.
    source: 'translated',
    chapterView: null,  // { chapter, doc, text } of the chapter on screen
    fallback: false,
    // chapter ids the reader has opened. This — and nothing else — is what marks
    // a row as read: there is no status chip and no green edge until a chapter
    // has actually been opened (see markRead / chapterRow).
    read: new Set(),
  };

  /* ------------------------------ utilities ------------------------------ */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function icon(name, cls) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', cls || 'ic');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', `#${name}`);
    svg.appendChild(use);
    return svg;
  }
  let toastTimer = null;
  function toast(msg, ms) {
    const node = $('toast');
    node.textContent = msg;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, ms || 2600);
  }
  const num = (n) => Number(n).toLocaleString('en-US');
  const SOURCE_KEY = 'novelity:chapter-source';  // which chapter text the reader shows
  const pad4 = (n) => String(n).padStart(4, '0');
  /**
   * The two texts one chapter owns. Doer reads the Chinese original and writes
   * the finished English one chapter at a time, so the reader's Raw view is the
   * source file and its Translated view is what the run left in the result
   * folder — the chapter bar names both and switches between them.
   */
  const chapterSourcePath = (c) => `sources/chapter_${pad4(c.num)}/original.zh.txt`;
  const chapterResultPath = (c) => `Doer/Result/chapter_${pad4(c.num)}/chapter_${pad4(c.num)}.txt`;
  const SOURCE_LABEL = { raw: 'Raw', translated: 'Translated' };
  // the two things the chapter bar says about the project itself: where it is
  // published, and who wrote it. Nothing else about a chapter's provenance is
  // printed in the reader — the file paths live in the ⋮ menu (showChapterInfo).
  const SITE_HOST = 'novelityfree.vercel.app/';
  const SITE_URL = 'https://novelityfree.vercel.app/';
  const CREDIT = 'Credit: Im Boravath';

  /**
   * One of the chapter's two files, as the reader's blocks. The files are one
   * paragraph per line, so the line is the block. The source file opens with `#`
   * comment lines (source page, heading, paragraph count) — that is metadata
   * about the chapter, not the chapter, so those lines are dropped.
   */
  function textBlocks(text, stripComments) {
    const blocks = [];
    for (const line of String(text).split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      if (stripComments && t.startsWith('#')) continue;
      const div = /^==\s*(.+?)\s*==$/.exec(t);
      if (div) blocks.push({ t: 'd', x: div[1] });
      else blocks.push({ t: 'p', x: t });
    }
    return blocks;
  }

  /** read one of a chapter's two files; null when the file is not there (yet) */
  async function readChapterFile(file, stripComments) {
    try {
      const res = await fetch(file, { cache: 'no-store' });
      if (!res.ok) return null;
      const blocks = textBlocks(await res.text(), stripComments);
      return blocks.length ? blocks : null;
    } catch (err) {
      // file:// origin, offline, or a chapter the run has not reached yet
      return null;
    }
  }

  /**
   * Both texts of a chapter, read straight from their files: the English the run
   * wrote in Doer/Result/ and the Chinese it read in sources/.
   */
  async function readChapterFiles(chapter) {
    const [translated, raw] = await Promise.all([
      readChapterFile(chapterResultPath(chapter), false),
      readChapterFile(chapterSourcePath(chapter), true),
    ]);
    return { translated, raw };
  }

  /* --------------------------------- boot -------------------------------- */
  async function boot() {
    wireEvents();
    try {
      const savedSource = localStorage.getItem(SOURCE_KEY);
      if (savedSource === 'raw' || savedSource === 'translated') state.source = savedSource;
    } catch (err) { /* private mode — keep the default */ }
    try {
      // chapters read on this device come back marked (ids are "ch1", "ch2", …)
      const read = JSON.parse(localStorage.getItem(READ_KEY) || '[]');
      if (Array.isArray(read)) state.read = new Set(read);
    } catch (err) { /* private mode or an unreadable value — start with none */ }
    if (!SEED) {
      $('listSummary').textContent = 'data/novel-data.js is missing.';
      toast('Build the seed first: node tools/build-data.mjs', 6000);
      return;
    }

    // Nothing above or below this line waits on anything: the chapter list is in
    // the seed already, so the library is painted in this same tick. IndexedDB is
    // touched afterwards, and the four tab panels are built only when a tab is
    // opened (selectTab), so the glossary's 356 rows are never built for a reader
    // who only came for the chapter list.
    paintBook();
    state.chapters = SEED.chapters.slice().sort((a, b) => a.seq - b.seq);
    state.currentId = state.chapters.length ? state.chapters[0].id : null;
    renderChapters();

    // where this tab was, if it is coming back from a reload — an editor's live
    // reload, a stray F5 — so the chapter the reader was on comes back with it
    const session = readSession();

    await paintContinue();

    // The one part of a cold start that touches the disk is the list being written
    // to IndexedDB, and nothing the reader needs waits for it: the chapters are in
    // memory and the read marks are in localStorage. So it waits for the browser's
    // next quiet moment instead of the first frame — which keeps the first click a
    // click rather than a place in the queue behind 884 rows.
    writeSeedWhenIdle();

    if (session && session.open && session.chapterId) {
      openReader(session.chapterId, { scrollTop: session.scrollTop || 0 });
    }
  }

  /**
   * Mirror the built list into IndexedDB when the browser has a moment. The list
   * carries a version stamp, so this is a no-op unless tools/build-data.mjs has run
   * since it was last written.
   */
  function writeSeedWhenIdle() {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 150));
    idle(async () => {
      try {
        const res = await NovelDB.seed(SEED, (p) => {
          $('listSummary').textContent = `Writing the chapter list into IndexedDB… ${Math.round(p * 100)}%`;
        });
        if (res.seeded) {
          console.info(`[novelity] seeded ${num(res.chapters)} chapters into IndexedDB`);
          state.chapters = await NovelDB.getChapters();
          state.chapters.sort((a, b) => a.seq - b.seq);
          renderChapters();
        }
      } catch (err) {
        console.warn('[novelity] IndexedDB unavailable, falling back to the in-memory seed', err);
        state.fallback = true;
        toast('IndexedDB unavailable — reading from the in-memory seed', 4000);
      }
      // small hook so tests/smoke.mjs can wait for the app to finish booting
      window.__novelityReady = {
        chapters: state.chapters.length,
        translated: SEED.stats.translatedChapters,
        fallback: state.fallback,
        summary: $('listSummary').textContent,
      };
    }, { timeout: 1500 });
  }

  /* ------------------------------ book card ------------------------------ */
  function paintBook() {
    const b = SEED.book;
    document.title = `${b.title} — Translation Reader`;
    $('bookTitle').textContent = b.title;
    // English only — the Chinese original used to sit in front of it and ran the
    // sub-line past the card on a phone (the card now ellipsises instead)
    $('bookSub').textContent = 'English translation project';

    const stats = $('bookStats');
    stats.textContent = '';
    const fire = el('span', 'stat stat--fire');
    fire.append(icon('i-fire'), el('span', null, num(b.stats.reading)));
    const star = el('span', 'stat stat--star');
    const bTag = el('b', null, b.stats.rating.toFixed(1));
    star.append(icon('i-star'), bTag, el('span', null, `(${b.stats.votes})`));
    const done = el('span', 'stat');
    done.append(icon('i-check'), el('span', null, `${num(SEED.stats.translatedChapters)} chapters translated`));
    stats.append(fire, star, done);
    $('bookPill').addEventListener('click', () => {
      toast(`${num(SEED.stats.translatedChapters)} of ${num(SEED.stats.chapters)} chapters translated · ${num(SEED.stats.translatedWords)} words in ${SEED.stats.translations}`, 3600);
    });
  }

  /* --------------------------- library: list ----------------------------- */
  async function paintContinue() {
    let progress = state.localProgress || null;
    if (!progress && !state.fallback) {
      try { progress = await NovelDB.getProgress(); } catch (err) { progress = null; }
    }
    const btn = $('continueBtn');
    const saved = progress ? state.chapters.find((c) => c.id === progress.chapterId) : null;
    const chapter = saved || state.chapters[0];
    if (!chapter) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.querySelector('.continue__label').textContent = saved ? 'CONTINUE READING' : 'START READING';
    $('continueTitle').textContent = chapter.heading;
    btn.dataset.chapterId = chapter.id;
  }

  const topChapter = () => state.chapters.reduce((max, c) => Math.max(max, c.num || 0), 0);

  /* --------------------- ranges: the numeric chapter tabs ----------------- */
  /** the novel cut into fixed 50-chapter tabs — 1–50, 51–100, … 901–904 */
  function chapterRanges() {
    const top = topChapter() || RANGE_SIZE;
    const ranges = [];
    for (let from = 1; from <= top; from += RANGE_SIZE) {
      ranges.push({ from, to: Math.min(from + RANGE_SIZE - 1, top) });
    }
    return ranges;
  }

  const rangeIndexOf = (chapterNum) => Math.max(0, Math.floor((chapterNum - 1) / RANGE_SIZE));

  function visibleChapters() {
    const q = state.search.trim().toLowerCase();
    const rows = state.chapters.filter((c) => {
      if (state.filter === 'translated' && !c.translated) return false;
      if (state.filter === 'pending' && c.translated) return false;
      if (!q) return true;
      return (
        c.heading.toLowerCase().includes(q) ||
        (c.headingZh || '').includes(q) ||
        String(c.num) === q ||
        `chapter ${c.num}`.includes(q)
      );
    });
    return rows.sort((a, b) => (state.sort === 'desc' ? b.seq - a.seq : a.seq - b.seq));
  }

  function renderChapters() {
    const list = $('chapterList');
    const ranges = chapterRanges();
    const hits = visibleChapters();
    // a search that lands in another range jumps there, so the first result is on screen
    if (state.search.trim() && hits.length) state.range = rangeIndexOf(hits[0].num);
    state.range = Math.max(0, Math.min(state.range, ranges.length - 1));
    const range = ranges[state.range];
    const rows = hits.filter((c) => c.num >= range.from && c.num <= range.to);

    list.textContent = '';
    $('listSummary').textContent =
      `${num(rows.length)} of ${num(state.chapters.length)} chapters · ${num(SEED.stats.translatedChapters)} translated`;
    if (!rows.length) {
      list.append(el('div', 'empty', state.search.trim() || state.filter !== 'all'
        ? `Nothing in chapters ${range.from}–${range.to} matches the current search or filter.`
        : `This scan has no chapters between ${range.from} and ${range.to} yet.`));
    } else {
      for (const c of rows) list.append(chapterRow(c));
    }
    paintChapterTabs(ranges);
  }

  /** the pager under the list: ‹ 1 2 3 › — three numbered ranges at a time. It is
   *  the last block of the list and it captions nothing: the numbers are the only
   *  thing the pager puts on the page */
  function paintChapterTabs(ranges) {
    const list = $('rangeList');
    const total = ranges.length;
    const span = Math.min(RANGE_SPAN, total);
    // the open number holds the slot it already had — left stays left, right stays
    // right — so the window slides under it instead of pulling it to the front
    state.rangeSlot = Math.max(0, Math.min(state.rangeSlot, span - 1));
    const first = Math.max(0, Math.min(state.range - state.rangeSlot, total - span));
    state.rangeSlot = state.range - first;
    list.textContent = '';
    for (let i = first; i < first + span; i++) {
      const active = i === state.range;
      const tab = el('button', 'chapter-tabs__range' + (active ? ' is-active' : ''), String(i + 1));
      tab.type = 'button';
      tab.dataset.range = String(i);
      tab.dataset.slot = String(i - first);
      tab.title = `Chapters ${ranges[i].from}–${ranges[i].to}`;
      tab.setAttribute('aria-label', `Chapters ${ranges[i].from}–${ranges[i].to}`);
      tab.setAttribute('aria-pressed', String(active));
      list.append(tab);
    }
    $('rangePrev').disabled = state.range <= 0;
    $('rangeNext').disabled = state.range >= total - 1;
  }

  function chapterRow(c) {
    // no status chip on the row: it is marked as read (the green 3px edge) only
    // once the reader has opened the chapter — see markRead()
    const row = el('div', 'chapter-row' + (state.read.has(c.id) ? ' is-read' : ''));
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Open ${c.heading}`);

    const left = el('div');
    // English heading only: the Chinese title used to trail it (“Chapter 1 ·
    // Chaotic World第1章 乱世”), which made the row wider than the phone and
    // pushed the ⋮ button off screen
    const title = el('h3', 'chapter-row__title', c.heading);
    const meta = el('div', 'chapter-row__meta');
    if (c.translated) {
      // the row's numbers are the English chapter's, straight out of Doer/Result
      const size = el('span', 'meta-item');
      size.append(icon('i-file'), el('span', null, `${num(c.paragraphs)} paragraphs · ${num(c.words)} words`));
      const prog = el('span', 'meta-item');
      prog.append(icon('i-clock'), el('span', null, 'translated'));
      meta.append(size, prog);
    } else {
      const pending = el('span', 'meta-item');
      pending.append(icon('i-clock'), el('span', null, 'not translated yet'));
      meta.append(pending);
    }
    left.append(title, meta);

    const right = el('div', 'row-actions');
    const kebab = el('button', 'row-kebab');
    kebab.type = 'button';
    kebab.setAttribute('aria-label', `Chapter ${c.num} details`);
    kebab.append(icon('i-dots'));
    kebab.addEventListener('click', (e) => {
      e.stopPropagation();
      toast(c.translated
        ? `Chapter ${c.num} · ${c.headingZh} · ${num(c.paragraphs)} paragraphs · ${num(c.words)} words in ${chapterResultPath(c)}`
        : `Chapter ${c.num} · ${c.headingZh} · not translated yet — nothing in ${chapterResultPath(c)}`, 4600);
    });
    right.append(kebab);

    const open = () => openReader(c.id);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    row.append(left, right);
    return row;
  }

  /* ------------------------------- events -------------------------------- */
  function wireEvents() {
    $('searchInput').addEventListener('input', (e) => { state.search = e.target.value; renderChapters(); });
    $('filterBtn').addEventListener('click', (e) => { e.stopPropagation(); togglePopover(); });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#filterPopover') && !e.target.closest('#filterBtn')) hidePopover();
    });
    document.querySelectorAll('#filterPopover .popover__item').forEach((item) => {
      item.addEventListener('click', () => {
        state.filter = item.dataset.filter;
        $('filterLabel').textContent = item.textContent;
        document.querySelectorAll('#filterPopover .popover__item').forEach((i) => i.classList.toggle('is-active', i === item));
        hidePopover();
        renderChapters();
      });
    });
    document.querySelector('#filterPopover .popover__item[data-filter="all"]').classList.add('is-active');

    $('sortBtn').addEventListener('click', () => {
      state.sort = state.sort === 'desc' ? 'asc' : 'desc';
      $('sortLabel').textContent = state.sort === 'desc' ? 'Descending' : 'Ascending';
      toast(state.sort === 'desc' ? 'Latest chapters first' : 'Chapters in reading order', 1800);
      renderChapters();
    });
    $('continueBtn').addEventListener('click', (e) => openReader(e.currentTarget.dataset.chapterId));
    $('addBtn').addEventListener('click', () =>
      toast('Translate the next chapter into Doer/Result/, then re-run node tools/build-data.mjs to refresh this list.', 6000));
    $('tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (tab) selectTab(tab.dataset.tab);
    });
    $('rangeList').addEventListener('click', (e) => {
      const tab = e.target.closest('.chapter-tabs__range');
      // clicking a number keeps it in the slot it was shown in
      if (tab) selectRange(Number(tab.dataset.range), Number(tab.dataset.slot));
    });
    $('rangePrev').addEventListener('click', () => selectRange(state.range - 1));
    $('rangeNext').addEventListener('click', () => selectRange(state.range + 1));
    $('readerBack').addEventListener('click', closeReader);
    $('prevBtn').addEventListener('click', () => stepChapter(-1));
    $('nextBtn').addEventListener('click', () => stepChapter(1));
    $('readerMenu').addEventListener('click', showChapterInfo);
    $('libBack').addEventListener('click', () => toast('You are at the project root — the chapter list is right below.', 2600));
    document.addEventListener('keydown', onKey);
    wireSwipe();
    wireReaderChrome();
  }

  function togglePopover() {
    const pop = $('filterPopover');
    pop.hidden = !pop.hidden;
    $('filterBtn').setAttribute('aria-expanded', String(!pop.hidden));
  }
  function hidePopover() {
    $('filterPopover').hidden = true;
    $('filterBtn').setAttribute('aria-expanded', 'false');
  }

  function selectTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
    paintPanel(tab);
    $('libraryScroll').scrollTop = 0;
  }

  /**
   * Build the panel a tab is showing, and only that one. The panels belong to the
   * library view but their rows are not the reader's business: the glossary alone
   * is 356 rows, and not one of them stands between the reader and the chapter
   * list. So boot() builds none of them, and a panel is made the first time its
   * tab is opened.
   */
  function paintPanel(tab) {
    if (tab === 'rules') paintRulesPanel();
    else if (tab === 'batch') paintBatchPanel();
    else if (tab === 'glossary') paintGlossaryPanel();
    else if (tab === 'info') paintInfoPanel();
  }

  /**
   * Switch the chapter list to another 50-chapter range tab.
   * `slot` is the position the open number should keep in the pager (the arrows
   * pass the current one); it is clamped to what the window can actually show.
   */
  function selectRange(i, slot = state.rangeSlot) {
    const total = chapterRanges().length;
    const next = Math.max(0, Math.min(i, total - 1));
    state.rangeSlot = Math.max(0, Math.min(slot, RANGE_SPAN - 1));
    if (next !== state.range) {
      state.range = next;
      if (state.tab !== 'translation') selectTab('translation');
      renderChapters();
    }
    const head = document.querySelector('.list-head');
    if (head) head.scrollIntoView({ block: 'start' });
  }

  function showLibrary() {
    $('viewReader').hidden = true;
    $('viewLibrary').hidden = false;
  }

  /* -------------------------------- reader ------------------------------- */
  function renderBlocks(container, blocks) {
    container.textContent = '';
    for (const block of blocks || []) {
      if (block.t === 'd') {
        const divider = el('div', 'reader-divider');
        divider.append(el('span', null, block.x));
        container.append(divider);
      } else {
        container.append(el('p', null, block.x));
      }
    }
  }

  /** the chapter the reader has open, or null while the library is on screen */
  const currentChapter = () => state.chapters.find((c) => c.id === state.currentId) || null;

  /** where a chapter sits in the reading order — drives the reader's counters */
  function chapterAt(id) {
    const index = state.chapters.findIndex((c) => c.id === id);
    return index < 0 ? null : { index: index + 1, total: state.chapters.length };
  }

  /* ------------------------- read state: per chapter --------------------- */
  /**
   * A chapter counts as read once the reader has opened it, and that is the only
   * thing a row is ever marked with: rows carry no status chip, so the green edge
   * next to a chapter always means “you have been here”. Remembered per device,
   * so the mark survives a reload.
   */
  function markRead(chapter) {
    if (!chapter || state.read.has(chapter.id)) return;
    state.read.add(chapter.id);
    try { localStorage.setItem(READ_KEY, JSON.stringify([...state.read])); } catch (err) { /* private mode */ }
  }

  /* ---------------------- where this tab is reading ---------------------- */
  /**
   * The chapter this tab has open, kept for as long as the tab lives. A reload
   * — the live reload an editor pushes when a file under it changes, a stray F5
   * — is a brand-new page load, and without this the reader would be dropped
   * back at the top of the library every time one happened. sessionStorage dies
   * with the tab, so a fresh visit still lands on the library.
   */
  const SESSION_KEY = 'novelity:session';

  function saveSession() {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        open: !$('viewReader').hidden,
        chapterId: state.currentId,
        scrollTop: $('readerScroll').scrollTop,
        at: Date.now(),
      }));
    } catch (err) { /* private mode — the reload just lands on the library */ }
  }

  function readSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (err) { return null; }
  }

  function showReaderView() {
    $('viewLibrary').hidden = true;
    $('viewReader').hidden = false;
    // a fresh chapter always opens with the bars visible, and the scroll it does
    // on the way in must not be mistaken for the reader scrolling
    resetReaderChrome();
  }

  /**
   * Open one chapter. The view is painted from the row in the same frame and the
   * chapter's two files fill it a moment later, so a click is never a wait. The
   * row is marked as read — that mark is the only thing a row ever carries.
   */
  async function openReader(id, opts) {
    const chapter = state.chapters.find((c) => c.id === id) || state.chapters[0];
    if (!chapter) return;
    state.currentId = chapter.id;
    await openChapterView(chapter, opts);
    markRead(chapter);
  }

  /* -------------------- reading mode: auto-hiding bars -------------------- */
  /* The app bar and the page arrows fold out of the way while a chapter is
     being read and come back on a double click / double tap. Everything below
     only adds a class to #viewReader; the CSS does the folding and hands the
     room they free to the text. */
  const BARS_HIDDEN = 'is-bars-hidden';
  let resetReaderChrome = () => {};   // assigned by wireReaderChrome()

  /** slide the top + bottom bars back into view */
  function showReaderBars() { $('viewReader').classList.remove(BARS_HIDDEN); }
  /** get them out of the way (only ever while the reader is on screen) */
  function hideReaderBars() {
    if (!$('viewReader').hidden) $('viewReader').classList.add(BARS_HIDDEN);
  }

  /**
   * Bars hide on the first real scroll (down *or* up, so a page that scrolls
   * still reads full-screen); a double click anywhere in the text, the same
   * gesture as two quick taps, or keyboard focus brings them back. Every
   * chapter open starts with the bars visible.
   */
  function wireReaderChrome() {
    const view = $('viewReader');
    const surface = $('readerScroll');
    const HIDE_AFTER = 6;        // px of scrolling that counts as reading on
    const QUIET_MS = 300;        // a freshly opened chapter scrolls itself — ignore that
    const DOUBLE_TAP_MS = 350;
    let lastTop = surface.scrollTop;
    let quietUntil = 0;
    let lastTap = 0;
    let tapX = 0;
    let tapY = 0;

    // when the bars fold away the text takes their place, so the CSS needs to
    // know exactly how tall they are on *this* device (font size, safe-area
    // insets). Measured off the layout, never off the animation, so a bar that
    // is half-way through folding still reports its real height.
    const topBar = document.querySelector('.appbar--reader');
    const bottomBar = document.querySelector('.reader-nav');

    function barHeight(node) {
      const kept = node.getAttribute('style') || '';
      node.style.transition = 'none';
      node.style.maxHeight = 'none';
      const height = Math.ceil(node.getBoundingClientRect().height);
      if (kept) node.setAttribute('style', kept); else node.removeAttribute('style');
      return height;
    }

    function measureBars() {
      if (view.hidden || !topBar || !bottomBar) return;
      const top = barHeight(topBar);
      const bottom = barHeight(bottomBar);
      if (top > 0) view.style.setProperty('--bar-top', `${top}px`);
      if (bottom > 0) view.style.setProperty('--bar-bottom', `${bottom}px`);
    }

    resetReaderChrome = () => {
      showReaderBars();
      measureBars();
      // a chapter that opens, or a reload that puts the line back, starts the strip
      // where that line is rather than where the last chapter left it
      paintReadingProgress();
      lastTop = surface.scrollTop;
      quietUntil = Date.now() + QUIET_MS;
      lastTap = 0;
    };

    // rotating the phone (or a desktop resize) can change both heights
    window.addEventListener('resize', measureBars);
    // …and the line this tab is reading goes with the tab, so a reload — an
    // editor's live reload, an F5 — comes back to the chapter and the line
    window.addEventListener('pagehide', saveSession);

    let sessionTimer = null;

    surface.addEventListener('scroll', () => {
      // the strip under the bar follows every scroll — the reader's own, and the
      // one a chapter does on the way in — so it is painted before the two early
      // returns below
      paintReadingProgress();
      // the remembered line is written a few times a second, never per event
      if (!sessionTimer) sessionTimer = setTimeout(() => { sessionTimer = null; saveSession(); }, 400);
      const top = surface.scrollTop;
      if (Date.now() < quietUntil) { lastTop = top; return; }
      if (Math.abs(top - lastTop) < HIDE_AFTER) return;
      lastTop = top;
      hideReaderBars();
    }, { passive: true });

    // double click (mouse, and Chrome on a phone too — the viewport disables
    // double-tap zoom, so the gesture arrives as a real dblclick)
    view.addEventListener('dblclick', showReaderBars);

    // …plus the same gesture as two quick taps, for touch screens that never
    // fire dblclick at all
    surface.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      const now = Date.now();
      const moved = Math.abs(t.clientX - tapX) > 16 || Math.abs(t.clientY - tapY) > 16;
      if (now - lastTap < DOUBLE_TAP_MS && !moved) { showReaderBars(); lastTap = 0; return; }
      lastTap = now;
      tapX = t.clientX;
      tapY = t.clientY;
    }, { passive: true });

    // a keyboard user must never tab into a bar that is off screen
    view.addEventListener('focusin', showReaderBars);
  }

  /* ---------------------- the chapter bar and its texts ------------------- */

  /**
   * The chapter's own header, centred and held together by space rather than by
   * boxes: the chapter title, the project's site with its credit, the three text
   * actions, and the Raw / Translated switch on a row of its own. No file path is
   * printed anywhere in the reader: where a chapter's text comes from is the ⋮
   * menu's business (showChapterInfo), not the page's.
   * openChapterView() puts it inside #readerBody, so it sits at the top of the
   * chapter and scrolls away with the text — anchored to the chapter, never
   * pinned to the screen.
   */
  function buildChapterBar(chapter) {
    const bar = el('header', 'chapter-head');

    const meta = el('div', 'chapter-head__meta');
    meta.append(buildCredit());

    const tools = el('div', 'chapter-head__tools');
    for (const [name, label, run] of [
      ['round-save-alt', 'Save this chapter as a text file', saveChapter],
      ['i-copy', 'Copy this chapter', copyChapter],
      ['i-refresh', 'Re-read this chapter from its files', refreshChapter],
    ]) {
      const tool = el('button', 'chapter-tool');
      tool.type = 'button';
      tool.title = label;
      tool.setAttribute('aria-label', label);
      tool.append(icon(name));
      tool.addEventListener('click', run);
      tools.append(tool);
    }

    // the switch is a row of its own under the tools, so the three text actions
    // stay a clean strip of icons and Raw / Translated gets the wide control it
    // has in the reference: ‹ Raw | Translated › with an arrow either side
    bar.append(el('h3', 'chapter-head__title', chapter.heading), meta, tools, buildSourceSwitch());
    return bar;
  }

  /**
   * The project, in the one form a reader wants it: the site it is published on,
   * as the link, with the credit as the white chip under it.
   */
  function buildCredit() {
    const box = el('div', 'credit');
    const site = el('a', 'credit__site', SITE_HOST);
    site.href = SITE_URL;
    site.target = '_blank';
    site.rel = 'noopener noreferrer';
    box.append(site, el('span', 'credit__name', CREDIT));
    return box;
  }

  /**
   * ‹ Raw | Translated › — which of the chapter's two texts is on screen, with the
   * two ways out of the chapter either side of it. The ‹ and › are not the switch's
   * own: they turn the chapter, the same walk as the bar's arrows at the very bottom
   * of the screen (stepChapter), so a chapter can be left from its own head as well
   * as from its foot. paintChapterMeta() turns the same one of them off at the two
   * ends of the novel as it turns off down there.
   */
  function buildSourceSwitch() {
    const wrap = el('div', 'src-switch');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Chapter text');

    const back = el('button', 'src-switch__arrow');
    back.type = 'button';
    back.title = 'Previous chapter';
    back.setAttribute('aria-label', back.title);
    back.append(icon('i-chev-l', 'ic ic--sm'));
    back.addEventListener('click', () => stepChapter(-1));

    const options = el('div', 'src-switch__options');
    for (const kind of ['raw', 'translated']) {
      const active = state.source === kind;
      const opt = el('button', active ? 'src-switch__opt is-active' : 'src-switch__opt', SOURCE_LABEL[kind]);
      opt.type = 'button';
      opt.dataset.source = kind;
      opt.setAttribute('aria-pressed', String(active));
      opt.addEventListener('click', () => setChapterSource(kind));
      options.append(opt);
    }

    const next = el('button', 'src-switch__arrow');
    next.type = 'button';
    next.title = 'Next chapter';
    next.setAttribute('aria-label', next.title);
    next.append(icon('i-chev-r', 'ic ic--sm'));
    next.addEventListener('click', () => stepChapter(1));

    wrap.append(back, options, next);
    return wrap;
  }

  /** switch the chapter document between its Chinese source and its translation */
  function setChapterSource(kind) {
    const next = kind === 'raw' ? 'raw' : 'translated';
    if (next !== state.source) {
      state.source = next;
      try { localStorage.setItem(SOURCE_KEY, next); } catch (err) { /* private mode */ }
    }
    const wrap = document.querySelector('.src-switch');
    if (wrap) {
      wrap.querySelectorAll('.src-switch__opt').forEach((opt) => {
        const active = opt.dataset.source === state.source;
        opt.classList.toggle('is-active', active);
        opt.setAttribute('aria-pressed', String(active));
      });
    }
    paintChapterBody();
    // Raw's Chinese and Translated's English are not the same length, so the strip
    // is measured again against the document now on screen
    paintReadingProgress();
    if (next === 'translated' && state.chapterView
      && !(state.chapterView.text && state.chapterView.text.translated)) {
      toast('This chapter is not translated yet — switch to Raw to read the Chinese.', 3200);
    }
  }

  /** the centered card shown where a chapter, or one page of it, has nothing */
  function chapterBlank(message) {
    const box = el('div', 'chapter-blank');
    box.append(icon('i-clock', 'ic'), el('p', null, message));
    return box;
  }

  /**
   * Paint the chapter in the text the bar is set to. Both texts are the chapter's
   * own files: Raw is sources/chapter_XXXX/original.zh.txt, the Chinese Doer
   * reads, and Translated is the answer the run left for the same chapter in
   * Doer/Result/. One chapter is one file, so it is one section. A chapter whose
   * file is missing (or empty) is one centered card — the Chinese the Translated
   * view would otherwise fall back to is exactly what the Raw view is for.
   */
  function paintChapterBody() {
    const view = state.chapterView;
    if (!view || !view.doc) return;
    const { doc, text } = view;
    doc.dataset.source = state.source;
    doc.textContent = '';

    // still being read off disk: the card says so instead of claiming the chapter
    // is not there
    if (!text) {
      doc.append(chapterBlank('Reading the chapter from its files…'));
      return;
    }

    const blocks = text[state.source];
    if (!blocks || !blocks.length) {
      // the file a chapter is waiting for is named in the ⋮ menu, not on the page
      doc.append(chapterBlank(state.source === 'raw'
        ? 'This build has no Chinese source for this chapter.'
        : 'This chapter is not translated yet. Coming Soon...'));
      return;
    }

    const section = el('section', 'chapter-page');
    renderBlocks(section, blocks);
    doc.append(section);
  }

  /** the chapter shown right now as plain text, one paragraph per line */
  function chapterLines() {
    const view = state.chapterView;
    const blocks = (view && view.text) ? view.text[state.source] : null;
    const lines = [];
    for (const b of (blocks || [])) lines.push(b.t === 'd' ? `== ${b.x} ==` : b.x);
    return lines;
  }

  /** download what is on screen: chapter_XXXX.zh.txt or chapter_XXXX.en.txt */
  function saveChapter() {
    const view = state.chapterView;
    if (!view) return;
    const lines = chapterLines();
    if (!lines.length) { toast('There is nothing to save in this view yet.', 2800); return; }
    const name = `chapter_${pad4(view.chapter.num)}.${state.source === 'raw' ? 'zh' : 'en'}.txt`;
    const blob = new Blob([`${lines.join('\r\n')}\r\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = el('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Saved ${name}`, 3200);
  }

  /** copy what is on screen, paragraphs separated by a blank line */
  async function copyChapter() {
    if (!state.chapterView) return;
    const lines = chapterLines();
    if (!lines.length) { toast('There is nothing to copy in this view yet.', 2800); return; }
    const text = lines.join('\n\n');
    const what = `${SOURCE_LABEL[state.source].toLowerCase()} chapter text`;
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied the ${what} (${num(text.length)} characters)`, 3000);
    } catch (err) {
      // the clipboard API needs a secure origin, but a selection still copies
      // from http://localhost and from a file:// build
      const box = el('textarea');
      box.value = text;
      box.setAttribute('readonly', '');
      box.style.position = 'fixed';
      box.style.top = '-1000px';
      document.body.append(box);
      box.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (err2) { ok = false; }
      box.remove();
      toast(ok ? `Copied the ${what}` : 'This browser blocked the clipboard — select the text instead.', 3400);
    }
  }

  /** re-read the chapter's two files, so a fresh answer shows up at once */
  async function refreshChapter() {
    const view = state.chapterView;
    if (!view) return;
    view.text = await readChapterFiles(view.chapter);
    paintChapterBody();
    paintChapterMeta(view.chapter);
    toast('Chapter re-read from the files.', 2200);
  }

  /**
   * The chapter view: the chapter's own two files in one document, under the
   * chapter's own bar. Raw is sources/chapter_XXXX/original.zh.txt, the Chinese
   * Doer reads, and Translated is the English the run wrote for the same chapter
   * in Doer/Result/ — the bar switches the document between them.
   *
   * The shell is on screen before a byte is read: everything above the text is
   * known from the chapter's row already, so a click is answered in the same
   * frame, and the two files fill the body when they land. `opts.scrollTop` is
   * the line a reloaded tab was reading, put back once there is text to scroll.
   */
  async function openChapterView(chapter, opts) {
    showReaderView();
    // the bar is the first thing in the chapter document, so it reads as part of
    // the chapter and scrolls away with it instead of following the screen
    const body = $('readerBody');
    body.textContent = '';
    body.append(buildChapterBar(chapter));
    const doc = el('div', 'chapter-doc');
    body.append(doc);
    state.chapterView = { chapter, doc, text: null };
    paintChapterBody();
    paintChapterMeta(chapter);

    $('readerScroll').scrollTop = 0;
    writeProgress(chapter);
    saveSession();

    const text = await readChapterFiles(chapter);
    // a chapter opened on top of this one must not be painted over by this read
    const view = state.chapterView;
    if (!view || view.chapter.id !== chapter.id) return;
    view.text = text;
    paintChapterBody();
    paintChapterMeta(chapter);

    if (opts && opts.scrollTop) {
      // comes back where it was, and that jump is not the reader scrolling — the
      // bars stay out
      $('readerScroll').scrollTop = opts.scrollTop;
      resetReaderChrome();
    }
    saveSession();
  }

  /** the Chinese on screen, counted from the source file — it is never stored */
  const rawChars = (blocks) => (blocks || []).reduce((n, b) => n + (b.t === 'p' ? b.x.length : 0), 0);

  /**
   * The two pieces of reader chrome that track the view instead of scrolling away
   * with the text: the arrows' enabled state — the bar's pair and the pair in the
   * chapter's own head — and the progress strip under the app bar. The chapter names
   * itself in its own bar (the first thing in #readerBody), so nothing is printed
   * up here twice.
   */
  function paintChapterMeta(chapter) {
    const at = chapterAt(chapter.id);
    // the first and the last chapter of the novel have no step to take on one side
    const first = at.index <= 1;
    const last = at.index >= at.total;
    $('prevBtn').disabled = first;
    $('nextBtn').disabled = last;
    // the ‹ › in the chapter's own head are the same two steps, so the ends of the
    // novel turn them off together with the bar's arrows they answer to
    const head = document.querySelectorAll('#readerBody .src-switch__arrow');
    if (head.length === 2) {
      head[0].disabled = first;
      head[1].disabled = last;
    }
    paintReadingProgress();
  }

  /**
   * How far into the chapter on screen this reader has got — the reading position,
   * chapter by chapter. The strip under the app bar is empty at the chapter's
   * first line, about half full with the middle of its scroll on screen, and full
   * at its last line: it measures the chapter, not the novel (where a chapter sits
   * in the reading order is the ⋮ menu's business). openChapterView() puts the
   * scroll back at the top every time a chapter opens, so a new chapter always
   * starts the strip over.
   *
   * A chapter with nothing to scroll is a chapter wholly on screen, so its strip
   * is full — but only once its text has landed: while the file is still being
   * read off disk the body is the chapter's head alone, and an empty strip says
   * “nothing read yet” better than a full one would.
   */
  function paintReadingProgress() {
    const surface = $('readerScroll');
    const range = surface.scrollHeight - surface.clientHeight;
    const view = state.chapterView;
    const read = range > 0 ? surface.scrollTop / range : ((view && view.text) ? 1 : 0);
    const pct = Math.max(0, Math.min(1, read)) * 100;
    $('readerProgressBar').style.width = `${pct}%`;
  }

  /** the reading position the library's CONTINUE READING card reads back */
  function writeProgress(chapter) {
    state.localProgress = { chapterId: chapter.id, seq: chapter.seq, heading: chapter.heading };
    if (state.fallback) return;
    NovelDB.setProgress(chapter.id, chapter.seq, chapter.heading).catch((err) => {
      console.warn('[novelity] could not write the reading position', err);
    });
  }

  function stepChapter(delta) {
    const at = state.chapters.findIndex((c) => c.id === state.currentId);
    if (at < 0) return;
    const next = state.chapters[at + delta];
    if (next) openReader(next.id);
  }

  function onKey(e) {
    if ($('viewReader').hidden) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepChapter(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepChapter(1); }
    else if (e.key === 'Escape') closeReader();
  }

  function wireSwipe() {
    const surface = $('readerScroll');
    let x0 = null;
    let y0 = null;
    surface.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      x0 = t.clientX;
      y0 = t.clientY;
    }, { passive: true });
    surface.addEventListener('touchend', (e) => {
      if (x0 == null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0;
      const dy = t.clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) stepChapter(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  function closeReader() {
    showReaderBars();
    showLibrary();
    saveSession();     // the tab is on the library now, so a reload lands there
    paintContinue();
    renderChapters();
  }

  /** the ⋮ in the reader head: what this chapter is and where its text lives */
  function showChapterInfo() {
    const chapter = currentChapter();
    if (!chapter) return;
    const at = chapterAt(chapter.id);
    const { text } = state.chapterView || {};
    const parts = [
      chapter.heading,
      chapter.headingZh,
      `chapter ${num(at.index)} of ${num(at.total)}`,
      chapter.translated
        ? `${num(chapter.paragraphs)} paragraphs · ${num(chapter.words)} words in ${chapterResultPath(chapter)}`
        : `not translated yet — nothing in ${chapterResultPath(chapter)}`,
      text && text.raw
        ? `${num(rawChars(text.raw))} Chinese characters in ${chapterSourcePath(chapter)}`
        : '',
    ].filter(Boolean);
    toast(parts.join(' · '), 4600);
  }

  /* ----------------------------- tab panels ------------------------------ */
  function card(parent, title) {
    const box = el('div', 'card');
    if (title) box.append(el('h3', null, title));
    parent.append(box);
    return box;
  }
  const para = (parent, text) => { parent.append(el('p', null, text)); return parent; };
  const panelOf = (name) => document.querySelector(`.panel[data-panel="${name}"]`);

  function paintRulesPanel() {
    const panel = panelOf('rules');
    panel.textContent = '';
    const c1 = card(panel, 'Translation rules');
    para(c1, 'Context over dictionary: the entity type is deduced from the surrounding text and from sibling terms in a cluster, and structural alignment with the existing translation wins over a generic dictionary lookup.');
    const ul = el('ul');
    [
      'Objects, artifacts, techniques and fictional organizations are translated into English.',
      'Character names and real-world proper nouns stay romanised (Wei He, Wei Ying, Wei Chun, Feiye City).',
      'A fantasy geography is never mapped onto a real city: 京都 becomes “the Imperial Capital”, not Kyoto.',
      'Chinese honorifics are translated (Senior Brother, Elder, Young Master); Japanese and Korean honorifics stay romanised (-san, -senpai, -ssi, sunbae).',
      'Every chapter carries its number and title, so a reader always knows which chapter part they are in.',
      'Chapters are translated by hand, sentence by sentence; no text is generated by a script, and short Chinese sentences are allowed to stay short.',
      'A sentence cut in half by a chapter break is finished in the chapter where it began, so every chapter reads cleanly on its own.',
      'Forms of address keep their register: Xiao He, Second Sister, Big Sister, Little Brother, Grandpa Wang, Third Senior Brother — plain “Old Man Zheng” in narration, “Master Zheng” when he is addressed.',
      'Wording stays plain and sentences short, so a scene can be pictured on the first read — the detail of the scene is kept, the tangled phrasing is not.',
    ].forEach((t) => ul.append(el('li', null, t)));
    c1.append(ul);

    const c2 = card(panel, 'Chapter headings');
    para(c2, 'The novel is split into 上 / 下 chapter parts, which are rendered as “Part 1” / “Part 2”, so a heading reads “Chapter 5 · Variable (Part 1)”. The Chinese heading it came from is always kept under it in the reader.');
    para(c2, 'A chapter only gets an English title once its number is in tools/chapter-titles.json; until then it keeps its Chinese heading, so nothing is ever half-translated.');
  }

  function paintGlossaryPanel() {
    const panel = panelOf('glossary');
    panel.textContent = '';
    const c = card(panel, `Glossary · ${num(SEED.glossary.length)} terms`);
    para(c, 'Locked-in renderings used by the translation so that recurring terms stay identical across pages.');
    for (const t of SEED.glossary) {
      const row = el('div', 'glossary-row');
      row.append(el('b', null, t.zh), el('span', null, `  →  ${t.en}`), el('em', null, t.note || ''));
      c.append(row);
    }
  }

  function paintBatchPanel() {
    const panel = panelOf('batch');
    const s = SEED.stats;
    panel.textContent = '';
    const pct = s.chapters ? (s.translatedChapters / s.chapters) * 100 : 0;
    const total = state.chapters.length;

    const c = card(panel, 'How far the translation has come');
    para(c, `${num(s.translatedChapters)} of ${num(total)} chapters are translated — ${pct.toFixed(1)}% of the novel, ${num(s.pendingChapters)} chapters still to come.`);
    const track = el('div', 'progress-track');
    const fill = el('span');
    fill.style.width = `${pct.toFixed(2)}%`;
    track.append(fill);
    c.append(track);
    const dl = el('dl', 'kv');
    dl.append(el('dt', null, 'Translated'), el('dd', null, `${num(s.translatedChapters)} chapters · ${num(s.translatedWords)} words`));
    dl.append(el('dt', null, 'Not translated yet'), el('dd', null, `${num(s.pendingChapters)} chapters`));
    // the novel's own size belongs to the edition, not to the translation, so it
    // is named as the edition's and is never mixed into a chapter's numbers
    dl.append(el('dt', null, 'The edition'), el('dd', null, `${num(s.editionParagraphs)} paragraphs · ${num(s.editionChars)} Chinese characters`));
    c.append(dl);

    const c2 = card(panel, 'What you will find here');
    const ul = el('ul');
    [
      'A chapter you have opened carries a green edge on its row — nothing else marks a chapter, so the mark always means you have read it.',
      'A chapter that is not translated yet opens on its Chinese text, the Raw view, so nothing ever comes up empty.',
      'New chapters arrive in batches and are translated by hand, sentence by sentence — nothing here is machine-generated.',
      'The chapter list is grouped into ranges of 50 chapters; the number tabs under the list switch between them.',
    ].forEach((t) => ul.append(el('li', null, t)));
    c2.append(ul);

    const c3 = card(panel, 'About this edition');
    para(c3, `The novel runs to ${num(s.lastChapter)} chapters, and ${num(total)} of them are in this edition — ${num(s.missingNumbers.length)} numbers (${num(s.missingNumbers[0])}–${num(s.missingNumbers[s.missingNumbers.length - 1])}) do not exist in it at all, so the numbering skips there.`);
    para(c3, `${num(s.editionParagraphs)} paragraphs, about ${num(s.editionChars)} Chinese characters in the edition's own text. The translation is written one chapter per file into ${s.translations}/chapter_NNNN/chapter_NNNN.txt.`);
  }

  async function paintInfoPanel() {
    const panel = panelOf('info');
    const s = SEED.stats;
    panel.textContent = '';
    const c = card(panel, 'Book');
    const dl = el('dl', 'kv');
    const rows = [
      ['Title', SEED.book.title],
      ['Original', SEED.book.titleZh],
      ['Source file', SEED.book.source],
      ['Project', SEED.book.project],
      ['Seed built', SEED.version],
    ];
    for (const [k, v] of rows) { dl.append(el('dt', null, k), el('dd', null, v)); }
    c.append(dl);

    const c2 = card(panel, 'Storage');
    para(c2, 'The chapter list lives in IndexedDB (database “novelity”, stores “chapters” and “meta”), so the list, the read marks and the reading position survive a reload. A row is built from the English chapter in Doer/Result — that is where its paragraph and word counts come from, and why a pending chapter has none — and from the edition\'s chapter list for its identity. No chapter text is stored, and nothing read off the raw scan is: the reader fetches the two files a chapter owns, so what is on screen is always what is in the files. The list is written in a single transaction, scheduled after the first paint.');
    const dl2 = el('dl', 'kv');
    dl2.append(el('dt', null, 'Chapters'), el('dd', null, num(s.chapters)));
    dl2.append(el('dt', null, 'From Doer/Result'), el('dd', null, `${num(s.translatedChapters)} translated · ${num(s.pendingChapters)} pending`));
    dl2.append(el('dt', null, 'Translations in'), el('dd', null, `${s.translations}/`));
    dl2.append(el('dt', null, 'IndexedDB'), el('dd', null, state.fallback ? 'unavailable — running from memory' : 'active'));
    c2.append(dl2);

    if (!state.fallback) {
      try {
        const info = await NovelDB.stats();
        const dl3 = el('dl', 'kv');
        dl3.append(el('dt', null, 'Rows in “chapters”'), el('dd', null, num(info.chapters)));
        dl3.append(el('dt', null, 'Seed row'), el('dd', null, info.seed ? `${info.seed.version} · ${num(info.seed.count)} chapters` : '—'));
        c2.append(dl3);
      } catch (err) { /* the storage card above already reports the state */ }
    }

    const c3 = card(panel, 'Reading position');
    para(c3, state.localProgress
      ? `Saved in IndexedDB: ${state.localProgress.heading} (${state.localProgress.chapterId}).`
      : 'Open any chapter — the reading position is written to IndexedDB and restored here.');
  }

  /* --------------------------------- init -------------------------------- */
  function onBootError(err) {
    const message = (err && err.message) ? err.message : String(err);
    window.__novelityError = String((err && err.stack) || err);
    console.error('[novelity] boot failed', err);
    const summary = document.getElementById('listSummary');
    if (summary) summary.textContent = `Boot failed: ${message}`;
  }

  function start() {
    try { boot().catch(onBootError); } catch (err) { onBootError(err); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

