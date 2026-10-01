// tests/check-translations.mjs
// ---------------------------------------------------------------------------
// Quality gate for the per-page translation files.
//
//   node tests/check-translations.mjs
//
// For every sources/page_XXXX/page_XXXX.txt it verifies that
//   * the page id exists in data/outline.json (no orphan folders),
//   * the file is clean UTF-8 without a BOM or stray characters,
//   * the number of `== heading ==` dividers matches the number of chapter
//     breaks the source page contains,
//   * no stray Chinese is left inside the English text,
//   * paragraphs and words are counted (progress summary).
// It exits non-zero when any file fails so it can be wired into a build step.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = path.join(ROOT, 'sources');
const outline = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'outline.json'), 'utf8'));
const pageById = new Map(outline.pages.map((p) => [p.id, p]));

const DIVIDER = /^==\s*(.+?)\s*==$/;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/g;

let failures = 0;
let pages = 0;
let paragraphs = 0;
let words = 0;
const rows = [];

for (const dir of fs.readdirSync(SOURCES)) {
  const translation = path.join(SOURCES, dir, `${dir}.txt`);
  if (!fs.existsSync(translation)) continue;
  const id = Number(dir.replace('page_', ''));

  const bytes = fs.readFileSync(translation);
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const dividers = lines.filter((l) => DIVIDER.test(l.trim()));
  const paras = lines.filter((l) => !DIVIDER.test(l.trim()));
  const cjk = (text.match(CJK) || []).length;

  const source = pageById.get(id);
  const expectedDividers = source ? source.segments.length - 1 : null;
  const problems = [];
  if (!source) problems.push('page id not in outline.json');
  if (bom) problems.push('file starts with a UTF-8 BOM');
  if (expectedDividers !== null && dividers.length !== expectedDividers) {
    problems.push(`${dividers.length} divider(s), source has ${expectedDividers} chapter break(s)`);
  }
  if (paras.length === 0) problems.push('no paragraphs');
  if (cjk > 0) problems.push(`${cjk} Chinese character(s) left in the English text`);
  if (text.includes('\uFFFD')) problems.push('replacement character (broken encoding)');

  pages += 1;
  paragraphs += paras.length;
  words += paras.join(' ').split(/\s+/).filter(Boolean).length;
  if (problems.length) failures += 1;
  rows.push({ id, paras: paras.length, dividers: dividers.length, expectedDividers, problems });
}

rows.sort((a, b) => a.id - b.id);
for (const r of rows) {
  const status = r.problems.length ? `FAIL — ${r.problems.join('; ')}` : 'ok';
  console.log(
    `  ${String(r.id).padStart(4)}  ${String(r.paras).padStart(2)} paragraphs  ` +
    `dividers ${r.dividers}/${r.expectedDividers}  ${status}`
  );
}

console.log(`\ntranslated pages : ${pages} / ${outline.pages.length} (${((pages / outline.pages.length) * 100).toFixed(1)}%)`);
console.log(`english          : ${paragraphs} paragraphs, ${words} words`);
console.log(failures ? `${failures} page file(s) need attention` : 'every translation file passed');
process.exit(failures ? 1 : 0);
