// tools/build-data.mjs
// ---------------------------------------------------------------------------
// Builds the reader's database seed file from the outline + per page
// translations:
//
//   sources/page_0001/page_0001.txt   <- ENGLISH translation (the deliverable)
//   sources/page_0001/original.zh.txt <- raw Chinese page (translation input)
//
// Translation file format (one block per line, blank lines ignored):
//   * a normal line            -> one paragraph
//   * a line `== Heading ==`   -> inline chapter divider, used when a page
//                                contains the start of a new chapter
//
// Emits data/novel-data.js  ->  window.NOVEL_DATA = {...}
// which js/db.js seeds into IndexedDB (the book is ~6 MB, so IndexedDB - not
// localStorage - is the storage layer).
//
// Usage: node tools/build-data.mjs [--no-source]   (--no-source omits the
//        Chinese fallback text and produces a much smaller seed file)
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');
const SOURCES = path.join(ROOT, 'sources');
const WITH_SOURCE = !process.argv.includes('--no-source');

const BOOK = {
  title: 'Omnipresent God of War',
  titleZh: '十方武圣',
  project: 'profound-masterpiece-journey',
  source: '十方武圣_pages.txt',
  // reference stats shown in the design mock-up (app.readomni.com)
  stats: { reading: 7890, rating: 7.0, votes: 24 },
};

const GLOSSARY = path.join(HERE, 'glossary.json');

function pageDir(id) {
  return path.join(SOURCES, `page_${String(id).padStart(4, '0')}`);
}

function readOriginal(id) {
  const file = path.join(pageDir(id), 'original.zh.txt');
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !l.startsWith('#')).join('\n').trim();
}

function readTranslation(id) {
  const file = path.join(pageDir(id), `page_${String(id).padStart(4, '0')}.txt`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/** split a translated page into paragraph / divider blocks */
function translationBlocks(text) {
  const blocks = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const div = /^==\s*(.+?)\s*==$/.exec(t);
    if (div) blocks.push({ t: 'd', x: div[1] });
    else blocks.push({ t: 'p', x: t });
  }
  return blocks;
}

/** split the Chinese page into paragraph / divider blocks using the segment map */
function sourceBlocks(source, segments, chapters, id) {
  const blocks = [];
  let offset = 0;
  for (const seg of segments) {
    const slice = source.slice(offset, offset + seg.chars);
    offset += seg.chars;
    const chapter = seg.chapterKey ? chapters.get(seg.chapterKey) : null;
    let body = slice;
    if (chapter) {
      const marker = `第${chapter.num}章`;
      if (!slice.startsWith(marker)) {
        warnings.push(`page ${id}: expected chapter marker ${marker}, found "${slice.slice(0, 8)}"`);
      }
      const markerLen = marker.length + chapter.rawTitleZh.length + chapter.rawPartZh.length;
      body = slice.slice(markerLen);
      blocks.push({ t: 'd', x: chapter.headingZh });
    }
    for (const p of body.split('\n')) {
      const t = p.trim();
      if (t) blocks.push({ t: 'p', x: t });
    }
  }
  return blocks;
}

const warnings = [];

function main() {
  const outline = JSON.parse(fs.readFileSync(path.join(DATA, 'outline.json'), 'utf8'));
  const chaptersById = new Map(outline.chapters.map((c) => [c.id, c]));
  const glossary = fs.existsSync(GLOSSARY) ? JSON.parse(fs.readFileSync(GLOSSARY, 'utf8')).terms : [];
  const ordered = [...outline.pages].sort((a, b) => a.id - b.id);

  const pages = [];
  let translatedPages = 0;
  let currentChapter = null;

  ordered.forEach((p, seq) => {
    if (p.primary) currentChapter = chaptersById.get(p.primary);
    const chapter = p.primary ? chaptersById.get(p.primary) : currentChapter;
    const translation = readTranslation(p.id);
    const blocks = translation ? translationBlocks(translation) : [];
    const original = WITH_SOURCE ? readOriginal(p.id) : null;

    if (translation) {
      translatedPages++;
      const dividers = blocks.filter((b) => b.t === 'd').length;
      const expected = p.segments.length - 1;
      if (dividers !== expected) {
        warnings.push(`page ${p.id}: ${dividers} '== heading ==' divider(s) in the translation, ${expected} chapter break(s) in the source`);
      }
    }

    const page = {
      id: p.id,
      seq,
      chapterId: chapter ? chapter.id : null,
      heading: chapter ? chapter.headingEn || chapter.headingZh : `Page ${p.id}`,
      headingZh: chapter ? chapter.headingZh : '',
      translated: Boolean(translation),
      chars: p.charCount,
      blocks,
    };
    if (WITH_SOURCE && original) page.src = sourceBlocks(original, p.segments, chaptersById, p.id);
    pages.push(page);
  });

  // ---- chapter rows for the library list ----------------------------------
  const agg = new Map();
  for (const pg of pages) {
    if (!pg.chapterId) continue;
    const a = agg.get(pg.chapterId) ?? { count: 0, translated: 0, first: pg.id, last: pg.id, seq: pg.seq };
    a.count++;
    if (pg.translated) a.translated++;
    a.last = pg.id;
    a.seq = Math.min(a.seq, pg.seq);
    agg.set(pg.chapterId, a);
  }
  const chapters = outline.chapters
    .filter((c) => agg.has(c.id))
    .map((c) => {
      const a = agg.get(c.id);
      return {
        id: c.id,
        num: c.num,
        titleZh: c.titleZh,
        partZh: c.partZh,
        titleEn: c.titleEn,
        partEn: c.partEn,
        curated: c.curated,
        heading: c.headingEn || c.headingZh,
        headingZh: c.headingZh,
        firstPageId: a.first,
        lastPageId: a.last,
        pageCount: a.count,
        translatedPages: a.translated,
        done: a.translated === a.count && a.count > 0,
        seq: a.seq,
      };
    })
    .sort((a, b) => a.seq - b.seq);

  const doneChapters = chapters.filter((c) => c.done).length;
  const data = {
    version: new Date().toISOString(),
    book: BOOK,
    stats: {
      pages: pages.length,
      chapters: chapters.length,
      translatedPages,
      translatedChapters: chapters.filter((c) => c.translatedPages > 0).length,
      doneChapters,
      sourceChars: outline.stats.chars,
      duplicatePagesDropped: outline.stats.duplicatePagesDropped,
      withSource: WITH_SOURCE,
    },
    glossary,
    chapters,
    pages,
  };

  const out = path.join(DATA, 'novel-data.js');
  fs.writeFileSync(out, `window.NOVEL_DATA = ${JSON.stringify(data)};\n`, 'utf8');

  const kb = (n) => `${(n / 1048576).toFixed(2)} MB`;
  console.log(`pages            : ${pages.length}`);
  console.log(`chapters         : ${chapters.length}`);
  console.log(`translated pages : ${translatedPages} / ${pages.length}`);
  console.log(`translated chaps : ${chapters.filter((c) => c.translatedPages > 0).length} (${doneChapters} complete)`);
  console.log(`chinese fallback : ${WITH_SOURCE ? 'included' : 'omitted'}`);
  console.log(`seed file        : data/novel-data.js (${kb(fs.statSync(out).size)})`);
  if (warnings.length) {
    console.log(`\nwarnings (${warnings.length}):`);
    for (const w of warnings.slice(0, 15)) console.log('  -', w);
  }
}

main();
