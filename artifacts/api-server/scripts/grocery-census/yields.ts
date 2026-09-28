// A7 — YIELD COVERAGE. READ-ONLY.
//
// R2 says: for bunch- or head-sold produce, convert every need to pack terms
// through a YIELD, sum, then round up. This measures the population that rule
// applies to across the corpus, and how much of it the reviewed-but-unloaded
// pack_yields_REVIEWED.csv can actually answer.
//
//   node --env-file=.env --import tsx scripts/grocery-census/yields.ts --tag live
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const CSV = join(HERE, "..", "output", "ws9-csv", "pack_yields_REVIEWED.csv");

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return (i >= 0 ? process.argv[i + 1] : fallback) as string;
}

// The pack nouns R2 is about: you buy the WHOLE thing, the recipe measures part.
const PACK_SOLD_WHOLE = new Set([
  "bunch", "bunches", "head", "heads", "each", "bulb", "ear", "ears",
  "stalk", "stalks", "sprig", "sprigs",
]);
// A need stated in a MEASURE (not a count) is what makes the yield necessary.
const MEASURE_NEED = new Set([
  "cup", "cups", "tbsp", "tablespoon", "tablespoons", "tsp", "teaspoon",
  "teaspoons", "oz", "ounce", "ounces", "lb", "pound", "pounds", "g", "gram",
  "grams", "ml", "l", "pint", "quart",
]);

// ── the reviewed CSV ─────────────────────────────────────────────────────────
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQ = false;
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { cur.push(field); field = ""; }
    else if (ch === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  const header = rows[0];
  return rows.slice(1).filter((r) => r.length > 1).map((r) =>
    Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])),
  );
}

function main() {
  const tag = arg("tag", "live");
  const files = readdirSync(OUT).filter((f) => f.startsWith(`${tag}__`) && f.endsWith(".json")).sort();

  const csv = parseCsv(readFileSync(CSV, "utf8"));
  // A row "covers" a food when it states a usable yield: either the reviewed
  // new_yieldQuantity/new_yieldUnit, or the pre-existing current_* pair.
  const covered = new Map<string, string>();
  for (const r of csv) {
    const name = (r["from"] ?? "").toLowerCase().trim();
    if (!name) continue;
    const nq = r["new_yieldQuantity"], nu = r["new_yieldUnit"];
    const cq = r["current_yieldQuantity"], cu = r["current_yieldUnit"];
    const pass = r["claude_pass"] ?? "";
    if (nq && nu) covered.set(name, `${nq} ${nu}/${r["basis_unit"] || "pack"} [${pass}]`);
    else if (cq && cu) covered.set(name, `${cq} ${cu}/${r["basis_unit"] || "pack"} [existing]`);
    // A ruled REFUSAL is knowledge too, but it is not coverage.
  }
  // Also index the `to` side — a component edge names the derived product.
  const csvNames = new Set<string>();
  for (const r of csv) {
    if (r["from"]) csvNames.add(r["from"].toLowerCase().trim());
    if (r["to"] && !r["to"].startsWith("(")) csvNames.add(r["to"].toLowerCase().trim());
  }

  // ── the R2 population across the corpus ────────────────────────────────────
  interface Row { list: string; name: string; canonical: string; need: string; pack: string; }
  const pop: Row[] = [];
  const byFood = new Map<string, { rows: number; lists: Set<string>; samples: string[] }>();

  for (const file of files) {
    const r = JSON.parse(readFileSync(join(OUT, file), "utf8"));
    for (let i = 0; i < r.final.length; i++) {
      const it = r.final[i];
      const pu = (it.purchaseUnit ?? "").trim().toLowerCase();
      const nu = (it.unit ?? "").trim().toLowerCase();
      if (!PACK_SOLD_WHOLE.has(pu)) continue;
      if (!MEASURE_NEED.has(nu)) continue;
      const canonical = String(it.canonicalName).toLowerCase().trim();
      pop.push({
        list: file, name: it.displayName, canonical,
        need: `${it.quantity} ${it.unit}`,
        pack: it.purchaseDisplay ?? "-",
      });
      const e = byFood.get(canonical) ?? { rows: 0, lists: new Set<string>(), samples: [] };
      e.rows++;
      e.lists.add(file);
      if (e.samples.length < 3) e.samples.push(`${r.rendered[i].line}`);
      byFood.set(canonical, e);
    }
  }

  const foods = [...byFood.entries()].sort((a, b) => b[1].rows - a[1].rows);
  const withYield = foods.filter(([f]) => covered.has(f));
  const named = foods.filter(([f]) => !covered.has(f) && csvNames.has(f));
  const absent = foods.filter(([f]) => !covered.has(f) && !csvNames.has(f));

  const L: string[] = [];
  L.push(`A7 — YIELD COVERAGE (tag=${tag}, ${files.length} lists)`);
  L.push("");
  L.push(`pack_yields_REVIEWED.csv: ${csv.length} data rows; ${covered.size} distinct foods carry a usable yield figure; ${csvNames.size} distinct food names appear at all.`);
  L.push("");
  L.push(`R2 POPULATION — rows whose PACK is sold whole (bunch/head/each/bulb/ear/stalk/sprig) and whose NEED is a MEASURE:`);
  L.push(`  ${pop.length} rows across ${files.length} lists, ${foods.length} distinct foods.`);
  L.push("");
  L.push(`COVERED by the reviewed CSV: ${withYield.reduce((a, [, e]) => a + e.rows, 0)} rows / ${withYield.length} foods`);
  for (const [f, e] of withYield) L.push(`   ${String(e.rows).padStart(3)}×  ${f}  →  ${covered.get(f)}`);
  L.push("");
  L.push(`NAMED in the CSV but with NO usable yield (reviewed to a refusal or left blank): ${named.reduce((a, [, e]) => a + e.rows, 0)} rows / ${named.length} foods`);
  for (const [f, e] of named) L.push(`   ${String(e.rows).padStart(3)}×  ${f}`);
  L.push("");
  L.push(`NOT COVERED — absent from the CSV entirely: ${absent.reduce((a, [, e]) => a + e.rows, 0)} rows / ${absent.length} foods`);
  for (const [f, e] of absent) {
    L.push(`   ${String(e.rows).padStart(3)}×  ${f}   (${e.lists.size} lists)`);
    for (const s of e.samples) L.push(`          | ${s}`);
  }

  writeFileSync(join(OUT, `_yields__${tag}.txt`), L.join("\n"));
  console.log(L.join("\n"));
}

main();
