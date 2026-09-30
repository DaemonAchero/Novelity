// tools/split.mjs
// ---------------------------------------------------------------------------
// Splits the raw scraped book (D:/Novel/十方武圣_pages.txt) into one folder per
// page:  sources/page_0007/original.zh.txt
//
// The raw file has two scraping artefacts that this script repairs:
//   1. ~936 pages are verbatim copies of the page right before them
//      (from page ~66 on, every even page repeats the odd page before it).
//   2. 58 page numbers are missing entirely (their marker + text were removed
//      by whoever cleaned the scrape). No content is lost by the removals.
// Identical consecutive pages are therefore dropped; the surviving pages keep
// their ORIGINAL source page number as their id (so ids have gaps, order is
// preserved).
//
// It also writes data/outline.json: the page list plus the chapter index
// (chapter number, Chinese title, 上/下 part) used by tools/build-data.mjs.
//
// Usage: node tools/split.mjs [sourceFile] [--no-clean]
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'D:/Novel/十方武圣_pages.txt';
const SOURCES_DIR = path.join(ROOT, 'sources');
const DATA_DIR = path.join(ROOT, 'data');

const PAGE_LINE = /^=+\s*page\s+(\d+)\s*=+$/;
const CH_RE = /第(\d+)章/g;
// 上/下/中 and 一/二/三 are part markers in this novel (安定上 / 安定下 / 心态二 ...)
const PART_CHARS = new Set(['上', '下', '中', '一', '二', '三', '四']);
const PART_EN = { 上: 'Part 1', 下: 'Part 2', 中: 'Part 3', 一: 'Part 1', 二: 'Part 2', 三: 'Part 3', 四: 'Part 4' };

/** curated chapter titles (Chinese + English). Extended by the translator. */
const TITLES_FILE = path.join(HERE, 'chapter-titles.json');

function readSource(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const pages = [];
  let cur = null;
  let pending = [];
  const flushToCurrent = () => {
    if (cur) cur.paragraphs = pending;
    else if (pending.length) console.warn(`! ${pending.length} paragraph(s) before the first page marker were ignored`);
    pending = [];
  };
  for (const line of raw.split(/\r?\n/)) {
    const marker = PAGE_LINE.exec(line.trim());
    if (marker) {
      flushToCurrent();
      cur = { num: Number(marker[1]), paragraphs: [] };
      pages.push(cur);
      continue;
    }
    const t = line.trim();
    if (t) pending.push(t);
  }
  flushToCurrent();
  return pages;
}

/** parse the title of a 第N章 marker that sits at `offset` in `text` */
function parseMarker(text, offset) {
  const after = text.slice(offset);
  const numMatch = /^第(\d+)章/.exec(after);
  const num = Number(numMatch[1]);
  const rest = after.slice(numMatch[0].length);
  // a title never contains punctuation / whitespace, and never exceeds 4 chars
  let cand = rest.split(/[\s，。！？…；：、“”「」"'（）()《》〈〉·—～~\d]/)[0] || '';
  cand = cand.slice(0, 4);
  let title, part;
  if (cand.length >= 3 && PART_CHARS.has(cand[2])) {
    title = cand.slice(0, 2);
    part = cand[2];
  } else if (cand.length === 2 && PART_CHARS.has(cand[1])) {
    title = cand[0];
    part = cand[1];
  } else {
    title = cand.slice(0, 2);
    part = '';
  }
  return { num, titleZh: title, partZh: part };
}

function chapterHeadingZh(ch) {
  return `第${ch.num}章 ${ch.titleZh}${ch.partZh}`.trim();
}

function main() {
  const clean = !process.argv.includes('--no-clean');
  const rawPages = readSource(SRC);

  // ---- 1. drop verbatim duplicate pages -----------------------------------
  const pages = [];
  let dropped = 0;
  for (const p of rawPages) {
    if (clean && pages.length) {
      const prev = pages[pages.length - 1];
      if (prev.text === p.paragraphs.join('\n')) { dropped++; continue; }
    }
    pages.push({ num: p.num, text: p.paragraphs.join('\n'), paragraphs: p.paragraphs });
  }

  // ---- 2. chapter index + per page segments -------------------------------
  const titles = fs.existsSync(TITLES_FILE) ? JSON.parse(fs.readFileSync(TITLES_FILE, 'utf8')) : {};
  const chapters = new Map(); // key -> chapter record
  const outlinePages = [];

  for (const page of pages) {
    const segments = [];
    const events = [];
    CH_RE.lastIndex = 0;
    let m;
    while ((m = CH_RE.exec(page.text)) !== null) events.push(m.index);

    if (events.length === 0) {
      segments.push({ chapterKey: null, text: page.text });
    } else {
      if (events[0] > 0) segments.push({ chapterKey: null, text: page.text.slice(0, events[0]) });
      for (let i = 0; i < events.length; i++) {
        const start = events[i];
        const end = i + 1 < events.length ? events[i + 1] : page.text.length;
        const marker = parseMarker(page.text, start);
        const key = `ch${marker.num}`;
        if (!chapters.has(key)) {
          const curated = titles[String(marker.num)] || {};
          chapters.set(key, {
            id: key,
            num: marker.num,
            titleZh: curated.zh ?? marker.titleZh,
            partZh: curated.partZh ?? marker.partZh,
            rawTitleZh: marker.titleZh,
            rawPartZh: marker.partZh,
            titleEn: curated.en ?? null,
            partEn: curated.partEn ?? (PART_EN[marker.partZh] ?? ''),
            curated: Boolean(titles[String(marker.num)]),
            pageIds: [],
          });
        }
        segments.push({ chapterKey: key, text: page.text.slice(start, end) });
      }
    }

    // attach the page to the chapter it spends most characters in: a page that
    // ends one chapter and starts the next is owned by the longer half
    let primary = null;
    let best = -1;
    for (const seg of segments) {
      if (!seg.chapterKey) continue;
      if (seg.text.length > best) { best = seg.text.length; primary = seg.chapterKey; }
    }
    for (const seg of segments) {
      if (!seg.chapterKey) continue;
      const chapter = chapters.get(seg.chapterKey);
      if (!chapter.pageIds.includes(page.num)) chapter.pageIds.push(page.num);
    }

    outlinePages.push({
      id: page.num,
      primary,
      charCount: page.text.length,
      segments: segments.map((s) => ({ chapterKey: s.chapterKey, chars: s.text.length })),
    });

    // ---- 3. write the per page source folder ------------------------------
    const dir = path.join(SOURCES_DIR, `page_${String(page.num).padStart(4, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    const header = [
      `# source page ${page.num}`,
      `# raw file: ${path.basename(SRC)}`,
      `# chapters on this page: ${segments.filter((s) => s.chapterKey).map((s) => s.chapterKey).join(', ') || '(continuation only)'}`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'original.zh.txt'), `${header}${page.text}\n`, 'utf8');
  }

  const chapterList = [...chapters.values()].map((c) => ({
    ...c,
    headingZh: chapterHeadingZh(c),
    headingEn: c.titleEn ? `Chapter ${c.num} · ${c.titleEn}${c.partEn ? ` (${c.partEn})` : ''}` : null,
  }));

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const outline = {
    generatedAt: new Date().toISOString(),
    source: SRC,
    stats: {
      rawPageMarkers: rawPages.length,
      duplicatePagesDropped: dropped,
      pages: outlinePages.length,
      chapters: chapterList.length,
      chars: outlinePages.reduce((a, p) => a + p.charCount, 0),
    },
    chapters: chapterList,
    pages: outlinePages,
  };
  fs.writeFileSync(path.join(DATA_DIR, 'outline.json'), JSON.stringify(outline, null, 1), 'utf8');

  // ---- report -------------------------------------------------------------
  const s = outline.stats;
  console.log(`source markers       : ${s.rawPageMarkers}`);
  console.log(`duplicate pages cut  : ${s.duplicatePagesDropped}`);
  console.log(`unique pages         : ${s.pages}`);
  console.log(`chapters             : ${s.chapters}`);
  console.log(`characters           : ${s.chars}`);
  console.log(`page folders written : ${s.pages} -> sources/page_XXXX/original.zh.txt`);
  console.log('\nfirst 30 chapters:');
  for (const c of chapterList.slice(0, 30)) {
    console.log(
      `  ${String(c.num).padStart(4)}  ${c.titleZh}${c.partZh}  pages ${c.pageIds[0]}..${c.pageIds[c.pageIds.length - 1]}  ${c.curated ? '[curated] ' + c.headingEn : ''}`
    );
  }
}

main();
