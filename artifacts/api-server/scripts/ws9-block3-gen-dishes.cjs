// Plan-Gen Arc · Block 3 (D-WS9-044) — generate the checked-in target-dish
// constant from the editable CSV source of truth.
//
//   node scripts/ws9-block3-gen-dishes.cjs
//
// The CSV (scripts/ws9-block3-target-dishes.csv) is the editable source; this
// regenerates src/lib/storeFillDishes.ts (typechecked + imported by the harness).
// Re-run after editing the CSV.

const fs = require("fs");
const path = require("path");

const CSV = path.join(__dirname, "ws9-block3-target-dishes.csv");
const OUT = path.join(__dirname, "..", "src", "lib", "storeFillDishes.ts");

function parseLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (c === "," && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// Slug of the dish name — the stable dishFamilyKey the harness dedups on.
const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const lines = fs.readFileSync(CSV, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
const rows = lines.slice(1); // drop header
const dishes = rows.map((line) => {
  const [rank, dish, category] = parseLine(line);
  return { rank: parseInt(rank, 10), dish: dish.trim(), key: slug(dish.trim()), category: category.trim() };
});
dishes.sort((a, b) => a.rank - b.rank);

// sanity: unique ranks + unique keys + non-empty dish names
const seenRank = new Set();
const seenKey = new Set();
for (const d of dishes) {
  if (!Number.isInteger(d.rank)) throw new Error(`bad rank: ${JSON.stringify(d)}`);
  if (seenRank.has(d.rank)) throw new Error(`duplicate rank ${d.rank}`);
  seenRank.add(d.rank);
  if (!d.dish) throw new Error(`empty dish at rank ${d.rank}`);
  if (seenKey.has(d.key)) throw new Error(`duplicate dishFamilyKey "${d.key}" (rank ${d.rank})`);
  seenKey.add(d.key);
}

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const body = dishes
  .map((d) => `  { rank: ${d.rank}, dish: "${esc(d.dish)}", key: "${esc(d.key)}", category: "${esc(d.category)}" },`)
  .join("\n");

const out = `// GENERATED — do not edit by hand.
// Source of truth: scripts/ws9-block3-target-dishes.csv
// Regenerate: node scripts/ws9-block3-gen-dishes.cjs
//
// Plan-Gen Arc · Block 3 (D-WS9-044) — the catalog spine. Each entry names a
// TARGET DISH (the main / centerpiece). The store-fill harness generates one
// complete dinner per entry, composing accompaniments around it. Ordered by
// rank; --limit N takes the first N by rank (the head, which users hit most).

export interface TargetDish {
  rank: number;
  dish: string;
  /** dishFamilyKey — stable slug of the dish; the harness dedups on this. */
  key: string;
  category: string;
}

export const TARGET_DISHES: TargetDish[] = [
${body}
];
`;

fs.writeFileSync(OUT, out);
console.log(`wrote ${dishes.length} dishes → ${path.relative(process.cwd(), OUT)}`);
