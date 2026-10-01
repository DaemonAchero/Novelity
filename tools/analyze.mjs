// tools/analyze.mjs — structural analysis of the raw source book.
// Usage: node tools/analyze.mjs ["D:/Novel/十方武圣_pages.txt"]
import fs from 'node:fs';

const SRC = process.argv[2] ?? 'D:/Novel/十方武圣_pages.txt';
const raw = fs.readFileSync(SRC, 'utf8').replace(/^\uFEFF/, '');
const lines = raw.split(/\r?\n/);

const PAGE_RE = /^=+\s*page\s+(\d+)\s*=+\s*$/;

const pages = [];
let cur = null;
for (const line of lines) {
  const m = PAGE_RE.exec(line.trim());
  if (m) {
    cur = { num: Number(m[1]), lines: [] };
    pages.push(cur);
  } else if (cur) {
    cur.lines.push(line);
  }
}

console.log('bytes           :', Buffer.byteLength(raw, 'utf8'));
console.log('total lines     :', lines.length);
console.log('pages found     :', pages.length);
console.log('first/last page :', pages[0]?.num, '/', pages[pages.length - 1]?.num);

// page numbering anomalies
const gaps = [];
for (let i = 1; i < pages.length; i++) {
  if (pages[i].num !== pages[i - 1].num + 1) gaps.push(`${pages[i - 1].num} -> ${pages[i].num}`);
}
console.log('numbering gaps  :', gaps.length, gaps.slice(0, 20).join(', '));

// page sizes
const sizes = pages.map((p) => p.lines.join('').replace(/\s/g, '').length);
const sum = sizes.reduce((a, b) => a + b, 0);
console.log('chars total     :', sum, ' avg/page:', Math.round(sum / sizes.length), ' min:', Math.min(...sizes), ' max:', Math.max(...sizes));

// chapter markers
const CH_RE = /第(\d+)章/g;
const events = [];
pages.forEach((p, pi) => {
  const text = p.lines.join('\n');
  let m;
  while ((m = CH_RE.exec(text)) !== null) {
    events.push({
      page: p.num,
      pageIndex: pi,
      offset: m.index,
      num: Number(m[1]),
      atLineStart: m.index === 0 || text[m.index - 1] === '\n',
      tail: text.slice(m.index + m[0].length, m.index + m[0].length + 10),
    });
  }
});
console.log('\nchapter markers :', events.length, ' unique nums:', new Set(events.map((e) => e.num)).size);
console.log('max chapter num :', Math.max(...events.map((e) => e.num)));

// consecutive duplicates (same num repeated back-to-back in file order)
let dups = 0;
for (let i = 1; i < events.length; i++) if (events[i].num === events[i - 1].num) dups++;
console.log('consecutive dup markers:', dups);

console.log('\n--- first 30 events (page | ch | tail-10) ---');
for (const e of events.slice(0, 30)) console.log(String(e.page).padStart(5), '|', String(e.num).padStart(4), '|', JSON.stringify(e.tail));

console.log('\n--- events 30..80 ---');
for (const e of events.slice(30, 80)) console.log(String(e.page).padStart(5), '|', String(e.num).padStart(4), '|', JSON.stringify(e.tail));

console.log('\n--- last 12 events ---');
for (const e of events.slice(-12)) console.log(String(e.page).padStart(5), '|', String(e.num).padStart(4), '|', JSON.stringify(e.tail));

// title length histogram: chars up to \n or sentence punctuation after 第N章
const hist = new Map();
for (const e of events) {
  const t = e.tail.split(/[\n，。！？…、“”「」"'\s]/)[0] ?? '';
  hist.set(t.length, (hist.get(t.length) ?? 0) + 1);
}
console.log('\ntitle-length histogram (chars):', [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join('  '));

// sample of long titles
const longOnes = [...new Set(events.filter((e) => (e.tail.split(/[\n，。！？…、“”"'\s]/)[0] ?? '').length > 3).map((e) => `${e.num}:${e.tail.split(/[\n，。！？…、\s]/)[0]}`))];
console.log('titles >3 chars :', longOnes.slice(0, 60).join(', '));
