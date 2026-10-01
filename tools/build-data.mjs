// tools/build-data.mjs
// ---------------------------------------------------------------------------
// Builds the chapter index the reader's database is seeded from:
//
//   sources/index.json                        the edition's chapter list (order, Chinese titles)
//   Doer/Result/chapter_NNNN/chapter_NNNN.txt the English chapter Doer wrote — every number on a row
//   tools/chapter-titles.json                 chapter number -> English title
//   tools/glossary.json                       locked-in renderings
//
// Emits data/novel-data.js  ->  window.NOVEL_DATA = {...}
// which js/db.js writes into IndexedDB (the chapter list lives in IndexedDB, so
// localStorage and its ~5 MB cap are out of the way).
//
// A row is { id, num, seq, heading, headingZh, titleZh, partZh, titleEn, partEn,
// curated, translated, paragraphs, words }: the identity of a chapter from the
// edition's list, and everything else from the English chapter in Doer/Result.
// No chapter text is stored, and no number on a row is ever taken from the raw
// scan — the Chinese is read from sources/chapter_NNNN/original.zh.txt by the
// reader, on demand, and never enters the database.
//
// Usage: node tools/build-data.mjs [--translations <dir>]
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');
const SOURCES = path.join(ROOT, 'sources');
const INDEX = path.join(SOURCES, 'index.json');
const TITLES = path.join(HERE, 'chapter-titles.json');
const GLOSSARY = path.join(HERE, 'glossary.json');

// where Doer drops the finished English chapters (--translations overrides it)
const argAt = process.argv.indexOf('--translations');
const RESULTS = argAt > -1 && process.argv[argAt + 1]
  ? path.resolve(process.argv[argAt + 1])
  : path.join(ROOT, 'Doer', 'Result');

const BOOK = {
  title: 'Omnipresent God of War',
  titleZh: '十方武圣',
  project: 'profound-masterpiece-journey',
  // reference stats shown in the design mock-up (app.readomni.com)
  stats: { reading: 7890, rating: 7.0, votes: 24 },
};

const pad4 = (n) => String(n).padStart(4, '0');
const warnings = [];

// one chapter's two halves: 上 / 下, and the 一 / 二 of chapters 29–30
const PARTS = { '上': 'Part 1', '下': 'Part 2', '一': 'Part 1', '二': 'Part 2' };

/**
 * The English chapter Doer wrote — everything the chapter list knows about a
 * chapter's translation, read from Doer/Result/chapter_NNNN/chapter_NNNN.txt.
 * Returns null while the run has not reached the chapter yet. This file is the
 * only place a chapter's numbers come from: the Chinese behind a chapter is
 * never read here, so nothing derived from the raw scan lands in the database.
 */
function readResult(num) {
  const file = path.join(RESULTS, `chapter_${pad4(num)}`, `chapter_${pad4(num)}.txt`);
  if (!fs.existsSync(file)) return null;
  // a file that holds nothing but whitespace or comments is an unfinished run,
  // not a translation — counting it would mark a chapter translated with no text
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (!lines.length) return null;
  return { paragraphs: lines.length, words: lines.join(' ').split(/\s+/).filter(Boolean).length };
}

/** tools/chapter-titles.json, parsed once: chapter number -> English title */
let titleMap = null;
function chapterTitles() {
  if (!titleMap) titleMap = fs.existsSync(TITLES) ? JSON.parse(fs.readFileSync(TITLES, 'utf8')) : {};
  return titleMap;
}

/**
 * A chapter's English title, and the half of the chapter it names, from
 * tools/chapter-titles.json — a chapter number mapped to its title:
 *
 *   "151": "Counter-Plot"                                  the usual entry
 *   "151": { "en": "Counter-Plot", "partEn": "Part 1" }    when one needs it
 *
 * The Chinese title and its half come from the edition index, which is their
 * only source of truth; the split occasionally glues a half to its title
 * (chapter 509 is “希望上”), so it is peeled off here.
 */
function chapterTitle(num, c) {
  const entry = chapterTitles()[String(num)];
  const curated = typeof entry === 'string' ? { en: entry } : (entry || null);
  let titleZh = c.titleZh;
  let partZh = c.partZh || '';
  if (!partZh && titleZh.length > 1 && PARTS[titleZh.slice(-1)]) {
    partZh = titleZh.slice(-1);
    titleZh = titleZh.slice(0, -1);
  }
  return {
    curated,
    titleZh,
    partZh,
    titleEn: curated ? curated.en : '',
    partEn: curated ? (curated.partEn || PARTS[partZh] || '') : '',
  };
}

/** translations that exist for a chapter the source tree does not have */
function orphanResults(nums) {
  if (!fs.existsSync(RESULTS)) return [];
  const known = new Set(nums);
  return fs.readdirSync(RESULTS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^chapter_\d{4}$/.test(e.name))
    .map((e) => Number(e.name.slice('chapter_'.length)))
    .filter((n) => !known.has(n))
    .sort((a, b) => a - b);
}

function main() {
  if (!fs.existsSync(INDEX)) {
    console.error(`! ${path.relative(ROOT, INDEX)} is missing — run: py tools/split-chapters.py`);
    process.exit(1);
  }
  const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const glossary = fs.existsSync(GLOSSARY) ? JSON.parse(fs.readFileSync(GLOSSARY, 'utf8')).terms : [];
  if (!fs.existsSync(TITLES) || !Object.keys(chapterTitles()).length) {
    warnings.push(`${path.relative(ROOT, TITLES)} is missing or empty — chapters keep their Chinese headings`);
  }

  const chapters = [];
  let translatedChapters = 0;
  let translatedWords = 0;
  let missingSource = 0;

  index.chapters.forEach((c, seq) => {
    const source = path.join(SOURCES, `chapter_${pad4(c.num)}`, 'original.zh.txt');
    if (!fs.existsSync(source)) { missingSource++; warnings.push(`chapter ${c.num}: ${path.relative(ROOT, source)} is not there`); }

    // what a chapter has to say about itself comes from Doer/Result — the
    // English chapter Doer wrote — never from the raw scan
    const result = readResult(c.num);
    if (result) { translatedChapters++; translatedWords += result.words; }

    const t = chapterTitle(c.num, c);
    // English heading exactly as the reader shows it: the curated title when the
    // number is in chapter-titles.json, otherwise the Chinese one it is the only
    // name for — never a half-translated “Chapter 151 · 第151章 出城 上”
    const heading = t.curated
      ? `Chapter ${c.num} · ${t.titleEn}${t.partEn ? ` (${t.partEn})` : ''}`
      : c.headingZh;

    chapters.push({
      id: c.id,
      num: c.num,
      seq,
      heading,                // "Chapter 151 · Counter-Plot (Part 1)"
      headingZh: c.headingZh, // "第151章 对谋 上" — the reader always keeps it too
      titleZh: t.titleZh,
      partZh: t.partZh,
      titleEn: t.titleEn,
      partEn: t.partEn,
      curated: Boolean(t.curated),
      // from Doer/Result, and from nothing else: a chapter counts as translated
      // when the run has written its file, and its size is that file's size
      translated: Boolean(result),
      paragraphs: result ? result.paragraphs : null,
      words: result ? result.words : null,
    });
  });

  const orphans = orphanResults(chapters.map((c) => c.num));
  if (orphans.length) warnings.push(`${orphans.length} translation folder(s) have no chapter: ${orphans.slice(0, 10).join(', ')}${orphans.length > 10 ? ' …' : ''}`);

  const data = {
    version: new Date().toISOString(),
    book: { ...BOOK, source: index.source },
    stats: {
      // the chapter list, counted from Doer/Result — this is what IndexedDB gets
      chapters: chapters.length,
      translatedChapters,
      pendingChapters: chapters.length - translatedChapters,
      translatedWords,
      // the edition itself, from sources/index.json: the novel's own size, kept
      // apart from the translation's numbers and never attached to a chapter
      editionParagraphs: index.stats.paragraphs,
      editionChars: index.stats.bodyChars,
      firstChapter: index.stats.first,
      lastChapter: index.stats.last,
      missingNumbers: index.stats.missingNumbers,
      translations: path.relative(ROOT, RESULTS).split(path.sep).join('/'),
    },
    glossary,
    chapters,
  };

  const out = path.join(DATA, 'novel-data.js');
  fs.writeFileSync(out, `window.NOVEL_DATA = ${JSON.stringify(data)};\n`, 'utf8');

  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`chapter rows      : ${chapters.length} (${index.stats.first}–${index.stats.last}, ${index.stats.missingNumbers.length} number(s) missing in the edition)`);
  console.log(`from Doer/Result  : ${translatedChapters} translated chapters · ${translatedWords} words (${chapters.length - translatedChapters} pending)`);
  console.log(`English titles    : ${chapters.filter((c) => c.curated).length} of ${chapters.length} chapters, from tools/chapter-titles.json`);
  console.log(`edition (source)  : ${index.stats.paragraphs} paragraphs · ${index.stats.bodyChars} Chinese characters`);
  console.log(`translations read : ${path.relative(ROOT, RESULTS)}`);
  console.log(`seed file         : data/novel-data.js (${kb(fs.statSync(out).size)})`);
  if (missingSource) console.log(`! ${missingSource} chapter(s) have no source file`);
  if (warnings.length) {
    console.log(`\nwarnings (${warnings.length}):`);
    for (const w of warnings.slice(0, 15)) console.log('  -', w);
  }
}

main();
