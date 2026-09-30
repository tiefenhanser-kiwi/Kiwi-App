// [grocery] F Part B — the catalog sweeps behind F2, F3 and F4. READ-ONLY.
//
// Each finding is a CLASS with a detector, not a list of rows Hans happened to
// see. The detector is printed with its hit count so the fix can be checked
// against the whole catalog rather than against the two device lists.
//
//   node --env-file=.env --import tsx scripts/grocery-f/catalog-sweep.ts

import { PrismaClient } from "@prisma/client";

export interface CatRow {
  id: string;
  canonicalName: string;
  displayName: string;
  category: string | null;
  purchaseUnit: string | null;
  purchaseQuantity: number | null;
  purchaseDisplay: string | null;
}

export function assertDevHost(): void {
  const url = process.env.DATABASE_URL ?? "";
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  if (!host.includes("ep-broad-haze")) throw new Error("refusing: DATABASE_URL host is not the dev branch");
  console.log("host check: PASS (dev branch)");
}

// ── F2 — a pack parenthetical that COUNTS THE FOOD ITSELF ──────────────────
//
// "1 lb (~3-4 tomatillos)". The parenthetical is not a pack SIZE (14.5 oz,
// 12 count) — it is a count of the food in one pack, and two things follow:
// it is the only place the line names the food (residueNamesItem elides the
// name because the residue contains it), and it does not scale when the pack
// does, so "2 lb (~3-4 tomatillos)" claims 3-4 tomatillos in two pounds.
export const FOOD_COUNT_PAREN = /\(\s*~?\s*\d+(?:\s*(?:-|–|—|to)\s*\d+)?\s+([a-z][a-z -]*?)s?\s*\)/i;

/** Does the parenthetical's noun appear in the food's own name? */
export function parenNamesFood(display: string, name: string): boolean {
  const m = FOOD_COUNT_PAREN.exec(display);
  if (!m) return false;
  const noun = m[1].trim().toLowerCase();
  if (noun.length < 3) return false;
  return new RegExp(`(^|[^a-z])${noun}(e?s)?([^a-z]|$)`, "i").test(name);
}

// ── F3 — a canned good bought more than one at a time ──────────────────────
const SINGLE_CONTAINER = /^(can|jar|box|bottle|tube|pouch)s?$/i;

/**
 * [grocery] F Part E (E4.3) — RULED CORRECT, so the sweep stops reporting it.
 *
 * `pouch sticky rice` at "2 pouches" was the one row F3 could not decide.
 * Ruled by Hans on 2026-09-30: it really does ship as a 2-pack, so the stored
 * value is right and the detector is what is wrong about it.
 *
 * ⚠️ AN ALLOW-LIST, NOT A WIDENED DETECTOR. The rule stays "a single-container
 * pack bought more than one at a time is suspect"; this records the one row
 * where the answer has been given, by name, so a NEW row of the same shape
 * still reports. Loosening `SINGLE_CONTAINER` to exempt every pouch would have
 * hidden the next one.
 */
const F3_RULED_CORRECT: ReadonlySet<string> = new Set(["pouch sticky rice"]);

// ── F4 — category outliers, tested against SIBLINGS not against a hunch ────
//
// Each rule is "a name matching X is never category Y". They are the two shapes
// the census's D8 gate is blind to (its NOT_FRESH exemption swallows /vinegar/
// and its NOT_MEAT exemption swallows /soup/) plus the fresh-chile class D8
// already sees.
export const CATEGORY_RULES: { label: string; match: RegExp; never: string[]; want: string }[] = [
  {
    label: "a vinegar is a shelf-stable condiment",
    match: /\bvinegars?\b/i,
    never: ["Produce", "Protein", "Dairy", "Frozen", "Bakery"],
    want: "Pantry",
  },
  {
    label: "a condensed/canned soup is a canned good",
    match: /\b(cream of \w+|condensed \w+)\s+soup\b|\bcondensed soup\b/i,
    never: ["Protein", "Produce", "Dairy", "Bakery"],
    want: "Canned",
  },
  {
    label: "a FRESH chile or pepper is produce",
    match: /\b(poblano|serrano|habanero|anaheim|ancho chile pepper|jalape[nñ]o|tomatillo)s?\b/i,
    never: ["Pantry", "Protein", "Dairy", "Bakery"],
    want: "Produce",
  },
];

/** Modifiers that move a food out of the fresh aisle — the same trap D8 names. */
export const NOT_FRESH_FORM =
  /\b(dried|ground|powder|flakes?|canned|pickled|jarred|roasted|frozen|smoked|paste|sauce|salsa|brine|in adobo|chipotle)\b/i;

async function main() {
  assertDevHost();
  const prisma = new PrismaClient();
  const rows = (await prisma.ingredient.findMany({
    select: {
      id: true, canonicalName: true, displayName: true, category: true,
      purchaseUnit: true, purchaseQuantity: true, purchaseDisplay: true,
    },
    orderBy: { canonicalName: "asc" },
  })) as CatRow[];
  console.log(`\ncatalog rows: ${rows.length}`);

  // ── F2 ──
  const f2 = rows.filter(
    (r) => r.purchaseDisplay && parenNamesFood(r.purchaseDisplay, `${r.canonicalName} ${r.displayName}`),
  );
  console.log(`\n══ F2 — pack parentheticals that COUNT THE FOOD (${f2.length}) ══`);
  for (const r of f2) {
    console.log(`  ${r.canonicalName.padEnd(34)} ${String(r.category).padEnd(8)} "${r.purchaseDisplay}"`);
  }

  // ── F3 ──
  const f3 = rows.filter(
    (r) =>
      r.purchaseUnit != null &&
      SINGLE_CONTAINER.test(r.purchaseUnit) &&
      r.purchaseQuantity != null &&
      r.purchaseQuantity > 1 &&
      !F3_RULED_CORRECT.has(r.canonicalName),
  );
  console.log(`\n══ F3 — a single-container pack bought ${">"} 1 at a time (${f3.length}) ══`);
  console.log(
    `   (ruled correct and suppressed: ${[...F3_RULED_CORRECT].join(", ") || "none"})`,
  );
  for (const r of f3) {
    console.log(
      `  ${r.canonicalName.padEnd(40)} ${String(r.category).padEnd(8)} unit=${r.purchaseUnit} qty=${r.purchaseQuantity}  "${r.purchaseDisplay}"`,
    );
  }

  // ── F4 ──
  console.log(`\n══ F4 — category outliers ══`);
  let f4total = 0;
  for (const rule of CATEGORY_RULES) {
    const hits = rows.filter((r) => {
      if (!rule.match.test(r.canonicalName)) return false;
      if (rule.want === "Produce" && NOT_FRESH_FORM.test(r.canonicalName)) return false;
      return r.category !== null && rule.never.includes(r.category);
    });
    f4total += hits.length;
    console.log(`\n  ${rule.label} — want ${rule.want} — ${hits.length} outliers`);
    for (const r of hits) console.log(`      [${r.category}] ${r.canonicalName}`);
    // the siblings, so the outlier is visibly an outlier
    const all = rows.filter((r) => rule.match.test(r.canonicalName) && !(rule.want === "Produce" && NOT_FRESH_FORM.test(r.canonicalName)));
    const hist = new Map<string, number>();
    for (const r of all) hist.set(r.category ?? "(null)", (hist.get(r.category ?? "(null)") ?? 0) + 1);
    console.log(`      siblings: ${[...hist.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  }
  console.log(`\n  F4 outliers total: ${f4total}`);
  await prisma.$disconnect();
}
if (process.argv[1]?.includes("catalog-sweep")) main().catch((e) => { console.error(e); process.exit(1); });
