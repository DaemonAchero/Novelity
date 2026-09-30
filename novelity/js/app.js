/* ===========================================================================
   app.js — library + reader UI
   ---------------------------------------------------------------------------
   Data flow: data/novel-data.js (build output) -> IndexedDB (js/db.js) -> UI.
   Page text is always read back out of IndexedDB; the seed object in memory is
   only used for the lightweight index (reading order, headings, stats) and as
   a fallback when IndexedDB is unavailable.
   =========================================================================== */
(() => {
  'use strict';

  const SEED = window.NOVEL_DATA || null;
  const $ = (id) => document.getElementById(id);
  const MODE_KEY = 'novelity:reader-mode';
  const READ_KEY = 'novelity:read-chapters';  // chapter ids the reader has opened
  const RANGE_SIZE = 50;   // chapters covered by one range tab
  const RANGE_SPAN = 3;    // range tabs the pager keeps on screen at once

  const state = {
    chapters: [],
    index: new Map(),   // pageId -> { id, seq, chapterId, heading, translated, chars }
    order: [],          // page ids in reading order
    currentId: null,
    filter: 'all',
    // 'asc' keeps the list in chapter order, so the first range tab reads 1, 2, 3 … 50
    sort: 'asc',
    search: '',
    tab: 'translation',
    range: 0,           // which 50-chapter range tab the chapter list shows
    rangeSlot: 0,       // which slot (0 left, 1 middle, 2 right) the open tab sits in;
                        // the pager keeps it, so a number never jumps to the first slot
    // 'chapter' (default): a chapter is shown as one continuous document, with
    // every source page of it stacked and marked. 'page': the old one-source-page
    // -per-screen reader, which is what the translation workflow works in.
    mode: 'chapter',
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
  const pageFolder = (id) => `sources/page_${String(id).padStart(4, '0')}/page_${String(id).padStart(4, '0')}.txt`;

  /* --------------------------------- boot -------------------------------- */
  async function boot() {
    wireEvents();
    try {
      const saved = localStorage.getItem(MODE_KEY);
      if (saved === 'page' || saved === 'chapter') state.mode = saved;
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
    paintBook();
    paintStaticPanels();

    try {
      const res = await NovelDB.seed(SEED, (p) => {
        $('listSummary').textContent = `Writing the book into IndexedDB… ${Math.round(p * 100)}%`;
      });
      state.chapters = await NovelDB.getChapters();
      if (res.seeded) console.info(`[novelity] seeded ${num(res.pages)} pages into IndexedDB`);
    } catch (err) {
      console.warn('[novelity] IndexedDB unavailable, falling back to the in-memory seed', err);
      state.fallback = true;
      state.chapters = SEED.chapters;
      toast('IndexedDB unavailable — reading from the in-memory seed', 4000);
    }
    state.chapters.sort((a, b) => a.seq - b.seq);

    // lightweight reading-order index
    for (const p of SEED.pages) {
      state.order.push(p.id);
      state.index.set(p.id, {
        id: p.id, seq: p.seq, chapterId: p.chapterId, heading: p.heading,
        translated: p.translated, chars: p.chars,
      });
    }
    state.currentId = state.order[0];

    await paintContinue();
    renderChapters();
    // small hook so tests/smoke.mjs can wait for the app to finish booting
    window.__novelityReady = {
      chapters: state.chapters.length,
      pages: state.order.length,
      translated: SEED.stats.translatedPages,
      fallback: state.fallback,
      summary: $('listSummary').textContent,
    };
  }

  /* ------------------------------ book card ------------------------------ */
  function paintBook() {
    const b = SEED.book;
    document.title = `${b.title} — Translation Reader`;
    $('bookTitle').textContent = b.title;
    // English only — the Chinese original used to sit in front of it and ran the
    // sub-line past the card on a phone (the card now ellipsises instead)
    $('bookSub').textContent = 'English translation project';
    $('projectTitle').textContent = b.project;

    const stats = $('bookStats');
    stats.textContent = '';
    const fire = el('span', 'stat stat--fire');
    fire.append(icon('i-fire'), el('span', null, num(b.stats.reading)));
    const star = el('span', 'stat stat--star');
    const bTag = el('b', null, b.stats.rating.toFixed(1));
    star.append(icon('i-star'), bTag, el('span', null, `(${b.stats.votes})`));
    const done = el('span', 'stat');
    done.append(icon('i-check'), el('span', null, `${num(SEED.stats.translatedPages)} pages translated`));
    stats.append(fire, star, done);
    $('bookPill').addEventListener('click', () => {
      toast(`${num(SEED.stats.translatedPages)} of ${num(SEED.stats.pages)} pages translated · ${num(SEED.stats.chapters)} chapters`, 3600);
    });
  }

  /* --------------------------- library: list ----------------------------- */
  async function paintContinue() {
    let progress = state.localProgress || null;
    if (!progress && !state.fallback) {
      try { progress = await NovelDB.getProgress(); } catch (err) { progress = null; }
    }
    const btn = $('continueBtn');
    const id = progress && state.index.has(progress.pageId) ? progress.pageId : state.order[0];
    if (!id) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.querySelector('.continue__label').textContent = progress ? 'CONTINUE READING' : 'START READING';
    $('continueTitle').textContent = state.index.get(id).heading;
    btn.dataset.pageId = String(id);
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
      if (state.filter === 'translated' && c.translatedPages === 0) return false;
      if (state.filter === 'pending' && c.done) return false;
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
      `${num(rows.length)} of ${num(state.chapters.length)} chapters · ${num(SEED.stats.translatedPages)} of ${num(SEED.stats.pages)} pages translated`;
    if (!rows.length) {
      list.append(el('div', 'empty', state.search.trim() || state.filter !== 'all'
        ? `Nothing in chapters ${range.from}–${range.to} matches the current search or filter.`
        : `This scan has no chapters between ${range.from} and ${range.to} yet.`));
    } else {
      for (const c of rows) list.append(chapterRow(c));
    }
    paintChapterTabs(ranges, range);
  }

  /** the pager under the list: ‹ 1 2 3 › — three numbered ranges at a time */
  function paintChapterTabs(ranges, range) {
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
    $('rangeCaption').textContent = `Chapters ${range.from}–${range.to} · tab ${state.range + 1} of ${total}`;
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
    const pages = el('span', 'meta-item');
    pages.append(icon('i-file'), el('span', null, c.pageCount === 1 ? `page ${c.firstPageId}` : `pages ${c.firstPageId}–${c.lastPageId}`));
    const prog = el('span', 'meta-item');
    prog.append(icon('i-clock'), el('span', null, `${num(c.translatedPages)}/${num(c.pageCount)} translated`));
    meta.append(pages, prog);
    left.append(title, meta);

    const right = el('div', 'row-actions');
    const kebab = el('button', 'row-kebab');
    kebab.type = 'button';
    kebab.setAttribute('aria-label', `Chapter ${c.num} details`);
    kebab.append(icon('i-dots'));
    kebab.addEventListener('click', (e) => {
      e.stopPropagation();
      toast(`Chapter ${c.num} · ${c.headingZh} · ${num(c.pageCount)} page(s) · ${num(c.translatedPages)} translated`, 4000);
    });
    right.append(kebab);

    const open = () => openReader(c.firstPageId);
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
    $('continueBtn').addEventListener('click', (e) => openReader(Number(e.currentTarget.dataset.pageId)));
    $('addBtn').addEventListener('click', () =>
      toast('Add sources/page_XXXX/page_XXXX.txt, then re-run node tools/build-data.mjs', 6000));
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
    $('prevBtn').addEventListener('click', () => stepPage(-1));
    $('nextBtn').addEventListener('click', () => stepPage(1));
    $('readerMode').addEventListener('click', toggleReaderMode);
    $('readerMenu').addEventListener('click', showPageInfo);
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
    if (tab === 'info') paintInfoPanel();
    if (tab === 'batch') paintBatchPanel();
    $('libraryScroll').scrollTop = 0;
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
  async function loadPage(id) {
    if (!state.fallback) {
      try {
        const record = await NovelDB.getPage(id);
        if (record) return record;
      } catch (err) { /* fall through to the in-memory seed */ }
    }
    return SEED.pages.find((p) => p.id === id) || null;
  }

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

  /* ---- chapters: a chapter owns the source pages that carry its text ------ */
  function chapterOfPage(id) {
    const p = state.index.get(id);
    return p ? state.chapters.find((c) => c.id === p.chapterId) || null : null;
  }

  /** source page ids of one chapter, in reading order */
  function chapterPages(chapterId) {
    const ids = [];
    for (const pid of state.order) {
      const p = state.index.get(pid);
      if (p && p.chapterId === chapterId) ids.push(pid);
    }
    return ids;
  }

  /** chapters that carry pages, in reading order (drives the chapter stepper) */
  function chapterOrder() {
    return state.chapters.filter((c) => c.pageCount > 0).sort((a, b) => a.seq - b.seq);
  }

  /** where a page sits inside its own chapter */
  function chapterPosition(id) {
    const chapter = chapterOfPage(id);
    if (!chapter) return null;
    const ids = chapterPages(chapter.id);
    const at = ids.indexOf(id);
    return { chapter, ids, index: at < 0 ? 1 : at + 1, total: ids.length };
  }

  const charsOfChapter = (ids) => ids.reduce((sum, pid) => sum + (state.index.get(pid).chars || 0), 0);

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

  function showReaderView() {
    $('viewLibrary').hidden = true;
    $('viewReader').hidden = false;
    // a fresh chapter always opens with the bars visible, and the scroll it does
    // on the way in must not be mistaken for the reader scrolling
    resetReaderChrome();
  }

  /** the reader dispatches on the reading mode */
  async function openReader(id) {
    if (state.mode === 'chapter') await openChapterView(id);
    else await openPageView(id);
    // whatever was just opened, the reader has now read it — the row marks itself
    // when the list is painted again on the way back
    markRead(chapterOfPage(id));
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
      lastTop = surface.scrollTop;
      quietUntil = Date.now() + QUIET_MS;
      lastTap = 0;
    };

    // rotating the phone (or a desktop resize) can change both heights
    window.addEventListener('resize', measureBars);

    surface.addEventListener('scroll', () => {
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

  /** single-source-page view (what the translation workflow edits against) */
  async function openPageView(id) {
    const page = await loadPage(id);
    if (!page) { toast(`Page ${id} is unavailable`); return; }
    state.currentId = id;

    showReaderView();
    $('readerScroll').scrollTop = 0;

    const chapter = state.chapters.find((c) => c.id === page.chapterId);
    const pos = chapterPosition(id);
    $('readerHeading').textContent = page.heading;
    // English only: this line is ellipsised on a phone, and a half-cut Chinese
    // heading in it helped nothing (the Chinese itself is one tap away below)
    $('readerMeta').textContent = [
      page.translated ? 'Translated' : 'Translation pending',
      pos ? `page ${pos.index} of ${pos.total} in this chapter` : '',
      `source page ${page.id}`,
    ].filter(Boolean).join(' · ');

    const notice = $('readerNotice');
    if (page.translated) {
      notice.hidden = true;
    } else {
      notice.hidden = false;
      notice.textContent = (page.src && page.src.length)
        ? `This page is not translated yet, so the Chinese source is shown. Drop the English text into ${pageFolder(page.id)} and re-run tools/build-data.mjs.`
        : `This page is not translated yet, and this build was seeded without the Chinese fallback (tools/build-data.mjs --no-source). Add ${pageFolder(page.id)} and rebuild.`;
    }
    renderBlocks($('readerBody'), page.translated ? page.blocks : (page.src || page.blocks));

    const srcBox = $('sourceBox');
    if (page.translated && page.src && page.src.length) {
      srcBox.hidden = false;
      srcBox.open = false;
      renderBlocks($('sourceBody'), page.src);
    } else {
      srcBox.hidden = true;
    }

    const seq = state.index.get(id).seq;
    $('readerCounter').textContent = `Page ${num(seq + 1)} of ${num(state.order.length)}`;
    $('readerChapter').textContent = pos
      ? `${chapter ? chapter.heading : page.heading} · page ${pos.index} of ${pos.total}`
      : '';
    $('readerHint').textContent = 'Arrow keys ← → or tap the arrows';
    $('readerMode').setAttribute('aria-pressed', 'false');
    $('readerModeLabel').textContent = 'Whole chapter';
    $('readerProgressBar').style.width = `${((seq + 1) / state.order.length) * 100}%`;
    $('prevBtn').disabled = seq === 0;
    $('nextBtn').disabled = seq >= state.order.length - 1;
    $('readerFoot').textContent = `${num(page.chars || 0)} Chinese characters on this page`;

    state.localProgress = { pageId: id, seq, heading: page.heading };
    if (!state.fallback) {
      try { await NovelDB.setProgress(id, seq, page.heading); } catch (err) { /* keep the in-memory value */ }
    }
  }

  /** whole-chapter view: the chapter's source pages stacked in one document */
  async function openChapterView(id) {
    const pos = chapterPosition(id);
    if (!pos) { await openPageView(id); return; }
    const { chapter, ids } = pos;

    const body = $('readerBody');
    body.textContent = '';
    let translated = 0;
    const pending = [];
    for (let i = 0; i < ids.length; i++) {
      const pg = await loadPage(ids[i]);
      if (!pg) continue;
      if (pg.translated) translated++;
      else pending.push(pg.id);
      if (ids.length > 1) {
        const sep = el('div', 'reader-page-sep');
        sep.append(el('span', null, `page ${i + 1} of ${ids.length} · source page ${pg.id}`));
        body.append(sep);
      }
      if (!pg.translated) {
        body.append(el('p', 'page-note',
          `Source page ${pg.id} is not translated yet, so its Chinese text is shown below. Write the English to ${pageFolder(pg.id)} and re-run tools/build-data.mjs.`));
      }
      const section = el('section', 'chapter-page');
      section.dataset.pageId = String(pg.id);
      renderBlocks(section, pg.translated ? pg.blocks : (pg.src || pg.blocks));
      body.append(section);
    }

    showReaderView();
    state.currentId = state.index.has(id) ? id : ids[0];

    const notice = $('readerNotice');
    if (pending.length) {
      notice.hidden = false;
      notice.textContent = `${translated} of ${ids.length} source pages in this chapter are translated — page(s) ${pending.join(', ')} still show the Chinese text.`;
    } else {
      notice.hidden = true;
    }
    $('sourceBox').hidden = true;   // untranslated pages already show their Chinese inline

    const chapters = chapterOrder();
    const at = chapters.findIndex((c) => c.id === chapter.id);
    const first = state.index.get(ids[0]);
    $('readerHeading').textContent = chapter.heading;
    $('readerMeta').textContent = [
      chapter.headingZh,
      `source page(s) ${ids[0]}–${ids[ids.length - 1]}`,
      pending.length ? `${pending.length} page(s) still in Chinese` : 'fully translated',
    ].filter(Boolean).join(' · ');
    $('readerCounter').textContent = `Chapter ${chapter.num} · ${ids.length} page${ids.length === 1 ? '' : 's'}`;
    $('readerChapter').textContent = `${translated}/${ids.length} translated · ${num(charsOfChapter(ids))} Chinese characters`;
    $('readerHint').textContent = 'Arrow keys ← → move chapter by chapter';
    $('readerMode').setAttribute('aria-pressed', 'true');
    $('readerModeLabel').textContent = 'Page view';
    $('readerProgressBar').style.width = `${((first.seq + 1) / state.order.length) * 100}%`;
    $('prevBtn').disabled = at <= 0;
    $('nextBtn').disabled = at < 0 || at >= chapters.length - 1;
    $('readerFoot').textContent =
      `This chapter spans source page(s) ${ids.join(', ')} · ${num(charsOfChapter(ids))} Chinese characters`;

    $('readerScroll').scrollTop = 0;
    const target = body.querySelector(`[data-page-id="${id}"]`);
    if (target) target.scrollIntoView({ block: 'start' });

    const seq = state.index.get(state.currentId).seq;
    state.localProgress = { pageId: state.currentId, seq, heading: chapter.heading };
    if (!state.fallback) {
      try { await NovelDB.setProgress(state.currentId, seq, chapter.heading); } catch (err) { /* keep the in-memory value */ }
    }
  }

  /** flip between whole-chapter reading and single-source-page reading */
  function toggleReaderMode() {
    state.mode = state.mode === 'chapter' ? 'page' : 'chapter';
    try { localStorage.setItem(MODE_KEY, state.mode); } catch (err) { /* private mode */ }
    toast(state.mode === 'chapter'
      ? 'Whole-chapter reading: the chapter is one document and the arrows step chapter by chapter.'
      : 'Page reading: one source page per screen.', 3400);
    openReader(state.currentId);
  }

  function stepChapter(delta) {
    const pos = chapterPosition(state.currentId);
    if (!pos) return;
    const chapters = chapterOrder();
    const at = chapters.findIndex((c) => c.id === pos.chapter.id);
    const next = chapters[at + delta];
    if (!next) return;
    openReader(next.firstPageId);
  }

  function stepPage(delta) {
    if (state.mode === 'chapter') { stepChapter(delta); return; }
    const current = state.index.get(state.currentId);
    if (!current) return;
    const nextSeq = current.seq + delta;
    if (nextSeq < 0 || nextSeq >= state.order.length) return;
    openReader(state.order[nextSeq]);
  }

  function onKey(e) {
    if ($('viewReader').hidden) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepPage(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepPage(1); }
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
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) stepPage(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  function closeReader() {
    showReaderBars();
    showLibrary();
    paintContinue();
    renderChapters();
  }

  function showPageInfo() {
    const page = state.index.get(state.currentId);
    if (!page) return;
    const chapter = state.chapters.find((c) => c.id === page.chapterId);
    const pos = chapterPosition(state.currentId);
    const parts = [
      page.heading,
      `source page ${page.id}`,
      chapter ? chapter.headingZh : null,
      pos ? `page ${pos.index} of ${pos.total} in this chapter` : null,
      `${num(page.chars)} chars`,
      page.translated ? 'translated' : 'translation pending',
      state.mode === 'chapter' ? 'whole-chapter view' : 'page view',
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

  function paintStaticPanels() {
    paintRulesPanel();
    paintBatchPanel();
    paintGlossaryPanel();
    paintInfoPanel();
  }

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
      'Every page keeps its chapter heading as a sub-heading, so a reader always knows which chapter part they are in.',
      'Pages are translated by hand, sentence by sentence; no text is generated by a script, and short Chinese sentences are allowed to stay short.',
      'A sentence cut in half by a page break is finished on the page where it began, so every screen reads cleanly on its own.',
      'Forms of address keep their register: Xiao He, Second Sister, Big Sister, Little Brother, Grandpa Wang, Third Senior Brother — plain “Old Man Zheng” in narration, “Master Zheng” when he is addressed.',
    ].forEach((t) => ul.append(el('li', null, t)));
    c1.append(ul);

    const c2 = card(panel, 'Page heading scheme');
    para(c2, 'The novel is split into 上 / 下 chapter parts, which are rendered as “Part 1” / “Part 2”. A page that opens a new chapter mid-page carries an inline divider instead of a second heading:');
    const code = el('div');
    code.append(el('code', null, '== Chapter 2 · Hope =='));
    c2.append(code);
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
    const pct = s.pages ? (s.translatedPages / s.pages) * 100 : 0;
    const total = state.chapters.length;
    const open = Math.max(0, s.translatedChapters - s.doneChapters);
    const waiting = Math.max(0, total - s.translatedChapters);

    const c = card(panel, 'How far the translation has come');
    para(c, `${num(s.doneChapters)} of ${num(total)} chapters are finished — ${num(s.translatedPages)} of ${num(s.pages)} pages, or ${pct.toFixed(1)}% of the whole novel.`);
    const track = el('div', 'progress-track');
    const fill = el('span');
    fill.style.width = `${pct.toFixed(2)}%`;
    track.append(fill);
    c.append(track);
    const dl = el('dl', 'kv');
    dl.append(el('dt', null, 'Finished'), el('dd', null, `${num(s.doneChapters)} chapters`));
    dl.append(el('dt', null, 'Half translated'), el('dd', null, open ? `${num(open)} chapters` : 'none at the moment'));
    dl.append(el('dt', null, 'Not started yet'), el('dd', null, `${num(waiting)} chapters`));
    c.append(dl);

    const c2 = card(panel, 'What you will find here');
    const ul = el('ul');
    [
      'A chapter you have opened carries a green edge on its row — nothing else marks a chapter, so the mark always means you have read it.',
      'A chapter that is not translated yet shows its original Chinese text, so no page ever comes up empty.',
      'New chapters arrive in batches and are translated by hand, sentence by sentence — nothing here is machine-generated.',
      'The chapter list is grouped into ranges of 50 chapters; the number tabs under the list switch between them.',
    ].forEach((t) => ul.append(el('li', null, t)));
    c2.append(ul);

    const c3 = card(panel, 'About this edition');
    para(c3, `The novel is ${num(topChapter())} chapters long, and ${num(total)} of them survive in the page scan this reader was built from — the rest were lost there, so the chapter numbers skip now and then.`);
    para(c3, `${num(s.pages)} pages, about ${num(s.sourceChars)} Chinese characters in all. ${num(s.duplicatePagesDropped)} pages that the scan had captured twice were folded together, so no page appears twice.`);
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
    para(c2, 'The book is ~6 MB of page text. localStorage caps out around 5 MB and is synchronous, so the whole book is stored in IndexedDB (database “novelity”, stores “pages”, “chapters”, “meta”), written in chunks of 120 pages.');
    const dl2 = el('dl', 'kv');
    dl2.append(el('dt', null, 'Pages'), el('dd', null, num(s.pages)));
    dl2.append(el('dt', null, 'Chapters'), el('dd', null, num(s.chapters)));
    dl2.append(el('dt', null, 'Chinese fallback'), el('dd', null, s.withSource ? 'included in the seed' : 'omitted (seeded with --no-source)'));
    dl2.append(el('dt', null, 'IndexedDB'), el('dd', null, state.fallback ? 'unavailable — running from memory' : 'active'));
    c2.append(dl2);

    if (!state.fallback) {
      try {
        const info = await NovelDB.stats();
        const dl3 = el('dl', 'kv');
        dl3.append(el('dt', null, 'Rows in “pages”'), el('dd', null, num(info.pages)));
        dl3.append(el('dt', null, 'Rows in “chapters”'), el('dd', null, num(info.chapters)));
        dl3.append(el('dt', null, 'Seed row'), el('dd', null, info.seed ? `${info.seed.version} · ${num(info.seed.count)} pages` : '—'));
        c2.append(dl3);
      } catch (err) { /* the storage card above already reports the state */ }
    }

    const c3 = card(panel, 'Reading position');
    para(c3, state.localProgress
      ? `Saved in IndexedDB: page ${state.localProgress.pageId} · ${state.localProgress.heading}.`
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

