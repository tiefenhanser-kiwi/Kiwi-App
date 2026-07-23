// Plan-Gen Arc · Block 3.6 (D-WS9-063) — generate the checked-in target-dish
// constant from the FROZEN EXPANDED version-list (two CSVs).
//
//   node scripts/ws9-block3-gen-storefill-dishes.cjs
//
// Source of truth (both editable, merged in order — top25 band first):
//   scripts/ws9-block3-top25-A-v2.csv   (138 version-rows, ranks 1–25)
//   scripts/ws9-block3-midtail-A.csv    (987 version-rows, ranks 26–562)
//
// Each ROW is one *version* of a parent dish (e.g. parent "Pot Roast" →
// versions "Classic Sunday Pot Roast with Carrots and Potatoes",
// "Red Wine and Herb Braised Pot Roast", …). The store-fill harness makes one
// blind generate call per version name — the version name IS the binding input.
//
// This regenerates src/lib/storeFillDishes.ts (typechecked + imported by the
// harness). Re-run after editing either CSV.
//
// ⚠️ Does NOT touch scripts/ws9-block3-gen-dishes.cjs (the old 562-row spine
// generator) — that reads a different CSV and a different schema.

const fs = require("fs");
const path = require("path");

const TOP25 = path.join(__dirname, "ws9-block3-top25-A-v2.csv");
const MIDTAIL = path.join(__dirname, "ws9-block3-midtail-A.csv");
const OUT = path.join(__dirname, "..", "src", "lib", "storeFillDishes.ts");

// ── real CSV parser (dish names contain commas inside quoted fields, e.g.
//    "Pork Carnitas Bowl with Cilantro-Lime Rice, ...") — a naive split is wrong.
function parseCSV(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\r") { /* ignore CR */ }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  // drop fully-blank trailing rows
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ""));
}

// Header contract both files share.
const EXPECTED_HEADER = [
  "rank", "category", "parent_dish", "dish",
  "primary_axis", "cross_axis_used", "axis_note",
  "short_of_target", "short_reason",
];

function loadBand(file, band) {
  const rows = parseCSV(fs.readFileSync(file, "utf8"));
  const header = rows[0].map((h) => h.trim());
  for (let i = 0; i < EXPECTED_HEADER.length; i++) {
    if (header[i] !== EXPECTED_HEADER[i]) {
      throw new Error(
        `${path.basename(file)} header mismatch at col ${i}: expected "${EXPECTED_HEADER[i]}", got "${header[i]}"`,
      );
    }
  }
  const iRank = 0, iCat = 1, iParent = 2, iDish = 3;
  return rows.slice(1).map((r) => ({
    rank: parseInt(r[iRank], 10),
    category: r[iCat].trim(),
    parentDish: r[iParent].trim(),
    dish: r[iDish].trim(),
    band,
  }));
}

// Slug of the VERSION name — the stable dishFamilyKey the harness dedups on.
const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// ── merge: top25 band first, then midtail (preserves the CSV order within each).
const top25 = loadBand(TOP25, "top25");
const midtail = loadBand(MIDTAIL, "midtail");
const merged = [...top25, ...midtail];

// ── siblingCount per parentDish across the MERGED list (1 = N=1 tail row).
const siblingCount = {};
for (const d of merged) siblingCount[d.parentDish] = (siblingCount[d.parentDish] || 0) + 1;

// ── build entries + assert.
const entries = [];
const seenKey = new Map(); // key -> dish name that claimed it
for (const d of merged) {
  if (!d.dish) throw new Error(`empty dish name (parent "${d.parentDish}", rank ${d.rank})`);
  if (!Number.isInteger(d.rank)) throw new Error(`bad rank for "${d.dish}"`);
  const key = slug(d.dish);
  if (!key) throw new Error(`empty slug for dish "${d.dish}"`);
  if (seenKey.has(key)) {
    throw new Error(
      `KEY COLLISION on "${key}"\n  A: "${seenKey.get(key)}"\n  B: "${d.dish}"\n` +
      `  → two version names slug to the same key; disambiguate one of them in the CSV.`,
    );
  }
  seenKey.set(key, d.dish);
  entries.push({
    rank: d.rank,
    dish: d.dish,
    key,
    category: d.category,
    parentDish: d.parentDish,
    band: d.band,
    siblingCount: siblingCount[d.parentDish],
  });
}

// ── hard count gate (Phase 1a: expected 1,125; the CSVs are frozen).
const EXPECTED = 1125;
if (entries.length < 1000 || entries.length > 1300) {
  throw new Error(`entry count ${entries.length} outside acceptable 1,000–1,300 band — STOP`);
}

const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const body = entries
  .map(
    (e) =>
      `  { rank: ${e.rank}, dish: "${esc(e.dish)}", key: "${esc(e.key)}", category: "${esc(e.category)}", parentDish: "${esc(e.parentDish)}", band: "${e.band}", siblingCount: ${e.siblingCount} },`,
  )
  .join("\n");

const out = `// GENERATED — do not edit by hand.
// Source of truth: scripts/ws9-block3-top25-A-v2.csv + scripts/ws9-block3-midtail-A.csv
// Regenerate: node scripts/ws9-block3-gen-storefill-dishes.cjs
//
// Plan-Gen Arc · Block 3.6 (D-WS9-063) — the EXPANDED catalog spine. Each entry
// names one VERSION of a parent dish (the binding centerpiece name). The
// store-fill harness makes one blind generate call per version name and composes
// a complete dinner faithful to that name.
//
// Ordering: top25 band (ranks 1–25) first, then midtail (ranks 26–562), CSV order
// preserved within each band. \`rank\` REPEATS across a parent's versions — it is a
// band indicator, NOT a unique id. \`key\` (slug of the version name) is unique
// across all ${entries.length} rows and is what the harness dedups on.
//
// Sampling fields: \`band\` ("top25" | "midtail") and \`siblingCount\` (versions
// sharing this parentDish; 1 = an N=1 tail dish) let a caller stratify across
// rank bands instead of only taking the head.

export type TargetBand = "top25" | "midtail";

export interface TargetDish {
  /** Rank of the PARENT dish. Repeats across that parent's versions — not unique. */
  rank: number;
  /** The full VERSION name — the binding centerpiece input to the generate call. */
  dish: string;
  /** dishFamilyKey — unique slug of the version name; the harness dedups on this. */
  key: string;
  category: string;
  /** The parent dish this version belongs to (e.g. "Pot Roast"). */
  parentDish: string;
  /** Source band: "top25" (ranks 1–25) or "midtail" (ranks 26–562). */
  band: TargetBand;
  /** Number of versions sharing this parentDish across the list. 1 = N=1 tail. */
  siblingCount: number;
}

export const TARGET_DISHES: TargetDish[] = [
${body}
];
`;

fs.writeFileSync(OUT, out);
console.log(`wrote ${entries.length} version-rows → ${path.relative(process.cwd(), OUT)}`);
console.log(
  `  bands: top25=${entries.filter((e) => e.band === "top25").length}, midtail=${entries.filter((e) => e.band === "midtail").length}`,
);
console.log(
  `  N=1 tail rows (siblingCount===1): ${entries.filter((e) => e.siblingCount === 1).length}`,
);
