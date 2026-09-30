// tests/check-dom.mjs
// ---------------------------------------------------------------------------
// Static wiring checks: every element id, icon symbol and selector used by
// js/app.js must exist in index.html, and the CSS classes the app creates
// should be styled. Catches the "null.addEventListener" class of bug before
// the browser ever runs the page.
//
//   node tests/check-dom.mjs
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = read('index.html');
const css = read('css/style.css');
const app = read('js/app.js');

let failures = 0;
const ok = (cond, msg, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${!cond && extra ? ` — ${extra}` : ''}`);
};

const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const classesInHtml = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
const attrsInHtml = new Set([...html.matchAll(/(data-[a-z-]+)="([^"]*)"/g)].map((m) => `${m[1]}="${m[2]}"`));

// 1. every $('id') call resolves
const usedIds = [...new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
const missingIds = usedIds.filter((id) => !ids.has(id));
ok(missingIds.length === 0, `all ${usedIds.length} ids used by app.js exist in index.html`, missingIds.join(', '));

// 2. every icon reference resolves to a sprite symbol
const symbols = new Set([...html.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
const iconRefs = [
  ...[...app.matchAll(/icon\('([^']+)'/g)].map((m) => m[1]),
  ...[...html.matchAll(/href="#(i-[a-z0-9-]+)"/g)].map((m) => m[1]),
  ...[...app.matchAll(/href="#\$?\{?#?(i-[a-z0-9-]+)/g)].map((m) => m[1]),
];
const missingIcons = [...new Set(iconRefs)].filter((s) => !symbols.has(s));
ok(missingIcons.length === 0, `all ${symbols.size} sprite symbols referenced correctly`, missingIcons.join(', '));

// 3. every selector used by app.js is satisfiable by index.html (approximate)
const selectors = [...new Set([...app.matchAll(/document\.querySelector(?:All)?\('([^']+)'\)/g)].map((m) => m[1]))];
const broken = [];
for (const sel of selectors) {
  for (const part of sel.split(/\s+/)) {
    const idMatch = /^#([\w-]+)/.exec(part);
    if (idMatch && !ids.has(idMatch[1])) broken.push(`${sel} (no #${idMatch[1]})`);
    const classMatch = /\.([\w-]+)/.exec(part);
    if (classMatch && !classesInHtml.has(classMatch[1]) && !app.includes(`'${classMatch[1]}`)) broken.push(`${sel} (no .${classMatch[1]})`);
    const attrMatch = /\[(data-[\w-]+)="([^"]*)"\]/.exec(part);
    if (attrMatch && !attrsInHtml.has(`${attrMatch[1]}="${attrMatch[2]}"`)) broken.push(`${sel} (no ${attrMatch[1]}="${attrMatch[2]}")`);
  }
}
ok(broken.length === 0, `${selectors.length} selectors resolve against index.html`, broken.join(' | '));

// 4. informational: which classes created by app.js are unstyled
const created = new Set([...app.matchAll(/el\('[a-z]+', '([^']+)'/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean));
const unstyled = [...created].filter((c) => !css.includes(`.${c}`) && !c.startsWith('is-'));
console.log(`\n  info  ${created.size} classes created by app.js, ${unstyled.length} without a CSS rule: ${unstyled.join(', ') || 'none'}`);
console.log(`  info  index.html ids: ${ids.size}, sprite symbols: ${symbols.size}, css rules: ${(css.match(/\{/g) || []).length}`);

console.log(failures ? `\n${failures} check(s) failed` : '\nall DOM wiring checks passed');
process.exit(failures ? 1 : 0);
