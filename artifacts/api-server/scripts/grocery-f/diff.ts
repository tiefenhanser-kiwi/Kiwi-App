// [grocery] F — the corpus before/after, line by line.
//
// "Every fix is a rule or a data row, and the census corpus runs before and
// after each Part. Give a numbered before/after of every row that moves; every
// other row stays byte-identical." This is that report.
//
// Joins two tagged corpus runs of the SAME plans on (planId, canonicalName,
// unit) and prints only the rendered lines that differ, plus a count of rows
// that are byte-identical, added, or dropped.
//
//   node --import tsx scripts/grocery-f/diff.ts --before f0 --after fb

import { loadCorpus, type CorpusRow } from "./measure";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

/**
 * ⚠️ THE JOIN KEY CANNOT INCLUDE THE UNIT WHERE A FIX CHANGES IT, AND F1
 * CHANGES NOTHING ABOUT THE NEED — the need's unit and quantity are untouched
 * by every rule in this block, so (plan, canonical, unit) is stable across the
 * pair. A row whose SECTION moved (F4) keeps its key, which is what lets the
 * aisle change show up as a moved row rather than as one dropped and one added.
 */
function key(r: CorpusRow): string {
  return `${r.planId}|${r.canonicalName.toLowerCase()}|${r.unit.toLowerCase()}`;
}

const beforeTag = arg("before", "f0");
const afterTag = arg("after", "fb");
const before = loadCorpus(beforeTag);
const after = loadCorpus(afterTag);

const A = new Map(before.map((r) => [key(r), r]));
const B = new Map(after.map((r) => [key(r), r]));

const moved: { a: CorpusRow; b: CorpusRow; what: string[] }[] = [];
let identical = 0;
const dropped: CorpusRow[] = [];
const added: CorpusRow[] = [];

for (const [k, a] of A) {
  const b = B.get(k);
  if (!b) { dropped.push(a); continue; }
  const what: string[] = [];
  if (a.rendered.line !== b.rendered.line) what.push("line");
  if (a.sectionKey !== b.sectionKey) what.push(`section ${a.sectionKey}→${b.sectionKey}`);
  if ((a.rendered.packCount ?? null) !== (b.rendered.packCount ?? null)) {
    what.push(`packCount ${a.rendered.packCount}→${b.rendered.packCount}`);
  }
  if (what.length === 0) identical++;
  else moved.push({ a, b, what });
}
for (const [k, b] of B) if (!A.has(k)) added.push(b);

console.log(`corpus ${beforeTag} → ${afterTag}`);
console.log(`  rows ${before.length} → ${after.length}`);
console.log(`  byte-identical .... ${identical}`);
console.log(`  MOVED ............. ${moved.length}`);
console.log(`  dropped ........... ${dropped.length}`);
console.log(`  added ............. ${added.length}`);

// Group the moved rows by the SHAPE of the change, so a rule's blast radius
// reads as one entry rather than as N.
const byShape = new Map<string, { a: CorpusRow; b: CorpusRow }[]>();
for (const m of moved) {
  const k = `${m.a.rendered.line}\n→ ${m.b.rendered.line}${m.what.some((w) => w.startsWith("section")) ? `   [${m.what.find((w) => w.startsWith("section"))}]` : ""}`;
  const l = byShape.get(k);
  if (l) l.push(m); else byShape.set(k, [m]);
}
console.log(`\n── every row that moved (${byShape.size} distinct shapes) ──`);
let i = 0;
for (const [shape, list] of [...byShape.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const [bline, aline] = shape.split("\n");
  console.log(`${String(++i).padStart(4)}. ×${list.length}  ${bline}\n         ${aline}`);
}
if (dropped.length) {
  console.log(`\n── dropped ──`);
  for (const d of dropped) console.log(`   [${d.planId.slice(0, 8)}] ${d.rendered.line}`);
}
if (added.length) {
  console.log(`\n── added ──`);
  for (const d of added) console.log(`   [${d.planId.slice(0, 8)}] ${d.rendered.line}`);
}
