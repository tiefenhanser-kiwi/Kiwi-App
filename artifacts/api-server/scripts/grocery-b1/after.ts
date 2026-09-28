// [grocery] B1 · Part E — THE CORPUS DIFF. READ-ONLY.
//
// The census ran again at HEAD as tag `b1`. This diffs its rendered lines
// against the `live` corpus captured at f3f274a, numbers every changed row,
// groups them by class, and — the part that matters most — counts the rows
// OUTSIDE those classes that are not byte-identical. Any such row is a finding,
// not a pass.
//
//   node --import tsx scripts/grocery-b1/after.ts
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const CORPUS = join(HERE, "..", "grocery-census", "out");
const PLANS = [
  "f5556c19", "56b03a57", "c404a3cf", "247cd7bb", "14879176", "b8e7f134",
  "31c7a885", "96a94410", "425da049", "ed238692", "2b6e51a1", "6e952e32",
  "a8b0bbd5", "316d0846", "11653a33", "353ce059", "14397131", "163875ec",
  "d47d18aa", "8a462408",
];

type Cls =
  | "R2 rounding"
  | "pooled parts"
  | "garlic"
  | "salt"
  | "AI pack string"
  | "OUTSIDE THE CLASSES";

// Classified on the ROW's canonical name, never on the text of the change.
function classify(name: string, recurring: boolean): Cls {
  // ── NOT A B1 CHANGE, AND PROVEN SO BY THE CORPUS ITSELF ──────────────────
  //
  // A synthetic recurring entry ("paper towels", "pet treats") has NO catalog
  // row, so it is a permanent cache MISS for fillPurchaseSizesWithWriteBack and
  // Haiku invents its pack on EVERY run. Part A's reproducibility pass — three
  // runs of the same five plans with no code change at all — caught the same
  // rows flipping between "1 package (6 rolls)" and "1 package (6-pack)".
  //
  // Held in its own class rather than waved away: if a row that is NOT a
  // recurring synthetic turns up out here, it lands in OUTSIDE THE CLASSES and
  // is a finding.
  if (recurring) return "AI pack string";
  const n = name.toLowerCase();
  if (n.includes("garlic")) return "garlic";
  if (/salt/.test(n)) return "salt";
  if (/jalape|wedge|zest|juice|stems|leaves|brine|sprigs|rind|fronds|florets|hearts|kernels/.test(n)) {
    return "pooled parts";
  }
  if (/cilantro|parsley|basil|mint|oregano|sage|thyme|rosemary|chive|dill|cabbage|lettuce|iceberg|romaine|radicchio|onion|ginger|pineapple|watermelon|broccoli|kale|scallion|celery|chicken|crusty bread|lime|lemon|orange/.test(n)) {
    return "R2 rounding";
  }
  return "OUTSIDE THE CLASSES";
}

interface Row { canonicalName: string; isRecurringItem: boolean; }
interface Rendered { line: string; }

function load(tag: string, id: string) {
  const j = JSON.parse(readFileSync(join(CORPUS, `${tag}__${id}__r1.json`), "utf8"));
  const rows = j.final as Row[];
  const rendered = j.rendered as Rendered[];
  return {
    title: j.planTitle as string,
    // keyed on the row's identity, not its position
    byName: new Map(rendered.map((r, i) => [rows[i].canonicalName.toLowerCase(), r.line])),
    recurring: new Set(rows.filter((r) => r.isRecurringItem).map((r) => r.canonicalName.toLowerCase())),
    lines: rendered.map((r) => r.line),
    names: rows.map((r) => r.canonicalName),
  };
}

function main() {
  const L: string[] = [];
  const say = (s = "") => L.push(s);
  let n = 0;
  const byClass = new Map<Cls, string[]>();
  let identical = 0;
  let changed = 0;

  say("B1 PART E — the golden corpus, re-run at HEAD (tag `b1`) against `live` (f3f274a).");
  say("Both runs are the FULL pipeline including the Sonnet pass. Reproducibility was");
  say("measured in Part A: 5 plans x 3 runs gave identical SUBSTANCE on all five and");
  say("identical RENDERED on three — the two exceptions are one AI-invented pack string");
  say("for paper towels ('6 rolls' vs '6-pack'), which is noise this diff must expect.");
  say("");

  for (const id of PLANS) {
    const a = load("live", id);
    const b = load("b1", id);
    const keys = new Set([...a.byName.keys(), ...b.byName.keys()]);
    const diffs: { cls: Cls; text: string }[] = [];
    for (const k of keys) {
      const before = a.byName.get(k);
      const after = b.byName.get(k);
      if (before === after) { identical++; continue; }
      changed++;
      const cls = classify(k, a.recurring.has(k) || b.recurring.has(k));
      const text =
        before === undefined ? `+ ${after}`
        : after === undefined ? `- ${before}   (merged away / absorbed)`
        : `  ${before}\n       -> ${after}`;
      diffs.push({ cls, text });
    }
    if (diffs.length === 0) continue;
    say(`## ${id} — ${a.title}   (${a.lines.length} rows -> ${b.lines.length})`);
    for (const d of diffs.sort((x, y) => x.cls.localeCompare(y.cls))) {
      n++;
      say(`${String(n).padStart(3)}. [${d.cls}] ${d.text}`);
      const arr = byClass.get(d.cls) ?? [];
      arr.push(`${id}: ${d.text.split("\n")[0].trim()}`);
      byClass.set(d.cls, arr);
    }
    say("");
  }

  say("=== COUNTS ===");
  say(`rows byte-identical: ${identical}`);
  say(`rows changed:        ${changed}`);
  say("");
  say("=== BY CLASS ===");
  for (const cls of ["R2 rounding", "pooled parts", "garlic", "salt", "AI pack string", "OUTSIDE THE CLASSES"] as Cls[]) {
    const arr = byClass.get(cls) ?? [];
    say(`  ${cls.padEnd(22)} ${arr.length}`);
  }
  const outside = byClass.get("OUTSIDE THE CLASSES") ?? [];
  say("");
  if (outside.length === 0) {
    say("NOTHING CHANGED OUTSIDE THE AFFECTED CLASSES.");
  } else {
    say(`!! ${outside.length} CHANGES OUTSIDE THE AFFECTED CLASSES — each one is a finding:`);
    for (const o of outside) say(`   ${o}`);
  }

  // ── the detectors ─────────────────────────────────────────────────────────
  say("");
  say("=== THE CENSUS DETECTORS, BEFORE -> AFTER ===");
  const fa = JSON.parse(readFileSync(join(CORPUS, "_findings__live.json"), "utf8"));
  const fb = JSON.parse(readFileSync(join(CORPUS, "_findings__b1.json"), "utf8"));
  const keys = [...new Set([...Object.keys(fa.totals), ...Object.keys(fb.totals)])].sort();
  for (const k of keys) {
    const x = (fa.totals[k] as number) ?? 0;
    const y = (fb.totals[k] as number) ?? 0;
    say(`  ${k}: ${x} -> ${y}   ${y === x ? "" : y < x ? `(-${x - y})` : `(+${y - x})`}`);
  }
  say("");
  say("  sub-detectors that moved:");
  const subs = [...new Set([...Object.keys(fa.subTotals), ...Object.keys(fb.subTotals)])].sort();
  for (const k of subs) {
    const x = (fa.subTotals[k] as number) ?? 0;
    const y = (fb.subTotals[k] as number) ?? 0;
    if (x !== y) say(`    ${k}: ${x} -> ${y}`);
  }

  writeFileSync(join(OUT, "after.txt"), L.join("\n") + "\n", "utf8");
  console.log(L.join("\n"));
}
main();
