// tools/inspect.mjs — dive into page gaps / duplicated chapter markers.
import fs from 'node:fs';

const SRC = process.argv[2] ?? 'D:/Novel/十方武圣_pages.txt';
const raw = fs.readFileSync(SRC, 'utf8').replace(/^\uFEFF/, '');
const PAGE_RE = /^=+\s*page\s+(\d+)\s*=+\s*$/;
const pages = [];
let cur = null;
for (const line of raw.split(/\r?\n/)) {
  const m = PAGE_RE.exec(line.trim());
  if (m) { cur = { num: Number(m[1]), lines: [] }; pages.push(cur); }
  else if (cur) cur.lines.push(line);
}
const text = (p) => p.lines.join('\n').replace(/\n+$/, '');
const byNum = new Map(pages.map((p) => [p.num, p]));

console.log('### gap: 25 -> 27');
console.log('tail(25):', JSON.stringify(text(byNum.get(25)).slice(-90)));
console.log('head(27):', JSON.stringify(text(byNum.get(27)).slice(0, 90)));
console.log('\n### gap: 74 -> 76');
console.log('tail(74):', JSON.stringify(text(byNum.get(74)).slice(-90)));
console.log('head(76):', JSON.stringify(text(byNum.get(76)).slice(0, 90)));

console.log('\n### pages 66-69 heads / equality');
for (let n = 66; n <= 69; n++) {
  const p = byNum.get(n);
  if (!p) { console.log(n, 'MISSING'); continue; }
  console.log(n, 'len', text(p).length, 'head:', JSON.stringify(text(p).slice(0, 70)));
}
for (let n = 67; n <= 68; n++) {
  const a = text(byNum.get(n)), b = text(byNum.get(n + 1));
  console.log(`identical(${n},${n + 1})?`, a === b, ' shared-prefix:', (() => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; })());
}

// how much do consecutive pages overlap (suffix of A == prefix of B)?
let overlaps = 0, identical = 0, maxOv = 0;
for (let i = 1; i < pages.length; i++) {
  const a = text(pages[i - 1]), b = text(pages[i]);
  if (a === b) { identical++; continue; }
  const w = Math.min(120, a.length, b.length);
  for (let k = w; k >= 12; k--) {
    if (a.slice(-k) === b.slice(0, k)) { overlaps++; maxOv = Math.max(maxOv, k); break; }
  }
}
console.log('\nconsecutive exact-duplicate pages:', identical, ' overlapping pairs(>=12 chars):', overlaps, ' maxOv:', maxOv);

// 3rd char distribution for markers followed directly by CJK text
const CH_RE = /第(\d+)章(.)(.)(.)?/g;
const third = new Map();
const fourth = new Map();
for (const p of pages) {
  const t = text(p);
  let m;
  while ((m = CH_RE.exec(t)) !== null) {
    if (m[3] === '\n') third.set('NEWLINE', (third.get('NEWLINE') ?? 0) + 1);
    else third.set(m[3], (third.get(m[3]) ?? 0) + 1);
  }
}
const top = [...third.entries()].sort((a, b) => b[1] - a[1]);
console.log('\n3rd char after 第N章 (top 25):', top.slice(0, 25).map(([c, n]) => `${c}:${n}`).join(' '));
