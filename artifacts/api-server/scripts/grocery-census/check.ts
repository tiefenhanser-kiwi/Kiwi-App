// ─────────────────────────────────────────────────────────────────────────────
// THE CHECKER — D1..D8 over every rendered list in out/. READ-ONLY.
//
// Runs against the JSON the harness wrote, not against the database, so it is
// re-runnable and deterministic. The one DB read is the relation index (D1's
// "a relation row links them" arm) and the ingredientId resolution, both of
// which are pure SELECTs.
//
//   node --env-file=.env --import tsx scripts/grocery-census/check.ts --tag live
// ─────────────────────────────────────────────────────────────────────────────
import { PrismaClient } from "@prisma/client";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRelationIndex } from "../../src/lib/relationIndexLoader.js";
import { normalizeIngredientName } from "../../src/lib/groceryNormalization.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");

const prisma = new PrismaClient();
if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) {
  throw new Error("REFUSING: not the dev branch");
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

// ── unit knowledge (checker-local; deliberately independent of the code under
//    test, so a shared bug cannot hide from its own detector) ────────────────
const G_PER: Record<string, number> = {
  g: 1, gram: 1, grams: 1, kg: 1000, kilogram: 1000,
  oz: 28.349523125, ounce: 28.349523125, ounces: 28.349523125,
  lb: 453.59237, lbs: 453.59237, pound: 453.59237, pounds: 453.59237,
};
const ML_PER: Record<string, number> = {
  ml: 1, milliliter: 1, l: 1000, liter: 1000,
  tsp: 4.92892159375, teaspoon: 4.92892159375, teaspoons: 4.92892159375,
  tbsp: 14.78676478125, tablespoon: 14.78676478125, tablespoons: 14.78676478125,
  cup: 236.5882365, cups: 236.5882365,
  pint: 473.176473, quart: 946.352946, gallon: 3785.411784,
  "fl oz": 29.5735295625, floz: 29.5735295625,
};
// Containers whose printed "oz" is FLUID ounces, not weight.
const LIQUID_PACK_NOUNS = new Set([
  "can", "cans", "bottle", "bottles", "carton", "cartons", "jar", "jars", "tub",
]);
const COUNT_UNITS = new Set([
  "each", "", "clove", "cloves", "head", "heads", "bunch", "bunches", "slice",
  "slices", "piece", "pieces", "sprig", "sprigs", "stalk", "stalks", "ear",
  "ears", "leaf", "leaves", "can", "cans", "jar", "bottle", "bag", "box",
  "package", "packet", "container", "loaf", "stick", "sticks", "wedge",
  "block", "fillet", "fillets", "breast", "breasts", "thigh", "thighs",
  "dozen", "bulb", "sheet", "strip", "cube", "roll", "wrap", "pinch",
]);
const MEASURE_UNITS = new Set([...Object.keys(G_PER), ...Object.keys(ML_PER)]);
// A pack size stated as a COUNT rather than a measure: "1 package (12 count)".
const COUNT_SIZE_WORDS = new Set(["ct", "count", "pack", "pk", "each"]);
const KNOWN_UNITS = new Set([...COUNT_UNITS, ...MEASURE_UNITS]);
// Count nouns the plural engine SHOULD have agreed (grocery.ts COUNT_NOUN_PLURALS).
const PLURALISABLE = new Set([
  "clove", "head", "slice", "piece", "can", "jar", "bottle", "bunch", "bag",
  "box", "package", "packet", "carton", "container", "ear", "stalk", "sprig",
  "fillet", "breast", "thigh", "wedge", "block", "stick", "loaf", "bulb",
  "sheet", "strip", "cube", "leaf", "wrap", "roll", "pint", "quart", "gallon",
]);

function toGrams(q: number, u: string): number | null {
  const k = u.trim().toLowerCase();
  return G_PER[k] !== undefined ? q * G_PER[k] : null;
}
function toMl(q: number, u: string): number | null {
  const k = u.trim().toLowerCase();
  return ML_PER[k] !== undefined ? q * ML_PER[k] : null;
}

/** The pack's printed size: the leading amount, or the "(14.5 oz)" parenthetical. */
function packSize(display: string): { amt: number; unit: string; noun: string } | null {
  const nounM = /^\s*[\d.]+\s+([A-Za-z-]+)/.exec(display);
  const noun = (nounM?.[1] ?? "").toLowerCase();
  // A parenthetical size wins — "1 can (14.5 oz)" / "1 bag (5-6 oz)".
  const par = /\(\s*~?\s*([\d.]+)(?:\s*-\s*([\d.]+))?\s*([A-Za-z ]+?)\s*(?:each)?\s*\)/.exec(display);
  if (par) {
    // A RANGE ("5-6 oz") is checked at its LOWER bound: that is what the shopper
    // may actually come home with.
    const amt = parseFloat(par[1]);
    const unit = par[3].trim().toLowerCase();
    if (Number.isFinite(amt) && MEASURE_UNITS.has(unit)) return { amt, unit, noun };
    // A COUNT-stated pack size — "(10 ct)", "(12 count)", "(8 count)". These are
    // directly comparable to an `each` need and nothing in the shipped
    // packsToCoverNeed can read them.
    if (Number.isFinite(amt) && COUNT_SIZE_WORDS.has(unit)) return { amt, unit: "each", noun };
  }
  // "(6-pack)", "(12-pack)", "(4 sticks)", "(~6 scallions)" — a count in the
  // parenthetical stated as a hyphenated pack or a named unit.
  const packN = /\(\s*~?\s*([\d.]+)(?:\s*-\s*[\d.]+)?\s*-?\s*(pack|ct|count|rolls?|sticks?|sheets?)\b/i.exec(display);
  if (packN) {
    const amt = parseFloat(packN[1]);
    if (Number.isFinite(amt)) return { amt, unit: "each", noun };
  }
  const lead = /^\s*([\d.]+)\s+([A-Za-z]+)/.exec(display);
  if (lead) {
    const amt = parseFloat(lead[1]);
    const unit = lead[2].toLowerCase();
    if (Number.isFinite(amt) && MEASURE_UNITS.has(unit)) return { amt, unit, noun };
  }
  return null;
}

/** Coverage ratio (ordered / needed) or null when the two cannot be related. */
function coverage(
  need: number,
  needUnit: string,
  packs: number,
  display: string,
): { ratio: number; basis: string } | null {
  const size = packSize(display);
  if (!size) return null;
  const nu = needUnit.trim().toLowerCase();
  const ordered = packs * size.amt;

  // Weight ↔ weight.
  const ng = toGrams(need, nu);
  const og = toGrams(ordered, size.unit);
  // "oz" printed on a can/bottle/carton is FLUID oz — check volume first for those.
  const packIsLiquid = LIQUID_PACK_NOUNS.has(size.noun);
  const nml = toMl(need, nu);
  const oml = packIsLiquid && (size.unit === "oz" || size.unit === "ounce")
    ? ordered * ML_PER["fl oz"]
    : toMl(ordered, size.unit);

  if (nml !== null && oml !== null) {
    return { ratio: oml / nml, basis: packIsLiquid && size.unit.startsWith("o") ? "volume(fl oz)" : "volume" };
  }
  if (ng !== null && og !== null) return { ratio: og / ng, basis: "weight" };
  if (nu === size.unit) return { ratio: ordered / need, basis: "same-unit" };
  return null;
}

// ── plausibility map for D8 ──────────────────────────────────────────────────
//
// ⚠️ A produce WORD inside a DRIED/GROUND product name is exactly BUG-232's
// trap ("celery seed" is not produce; "garlic powder" is not produce). The
// detector must not make the same mistake it is measuring, so a name carrying
// any of these modifiers is exempted from the produce hint before it is tested.
const NOT_FRESH = /\b(powder|seed|seeds|dried|ground|flakes?|extract|paste|sauce|salt|sugar|oil|vinegar|juice|broth|stock|canned|pickled|roasted red|sun-?dried|puree|purée|concentrate|seasoning|spice|chips|crisps|frozen|jarred|brine)\b/i;
// The peppercorn family: "black/white/cayenne/red pepper" is a spice, not produce.
const SPICE_PEPPER = /\b(black|white|cayenne|red|green|pink|szechuan|sichuan|lemon)\s+pepper(corns?)?\b/i;

// An animal word inside a BROTH / STOCK / BOUILLON name is a shelf-stable
// pantry or canned good, not the meat counter. Same trap, other aisle.
const NOT_MEAT = /\b(broth|stock|bouillon|base|soup|consomm|gravy|seasoning|flavou?r|bacon bits|sauce|paste|powder|salt|spice)\b/i;
// A produce word inside a BAKED or MILLED good is not produce either.
const NOT_PRODUCE_FORM = /\b(tortillas?|bread|bun|roll|baguette|pita|naan|flour|meal|starch|pasta|noodles?|crackers?|muffins?|cake|chips?)\b/i;

const SECTION_HINTS: [RegExp, string][] = [
  [/\b(lettuce|romaine|spinach|kale|onion|garlic|pepper(s)?|tomato|potato|carrot|celery|cilantro|parsley|basil|thyme|rosemary|mint|dill|scallion|green onion|lime|lemon|orange|apple|avocado|cucumber|zucchini|mushroom|broccoli|cabbage|ginger|jalapeno|jalapeño|shallot|corn|herb)\b/i, "produce"],
  [/\b(chicken|beef|pork|turkey|lamb|bacon|sausage|shrimp|salmon|steak|ribs|ground (beef|pork|turkey|chicken|lamb|veal|sausage))\b/i, "meat_seafood"],
  [/\b(milk|cream|butter|cheese|yogurt|egg|eggs|parmesan|mozzarella|cheddar|feta|sour cream)\b/i, "dairy_eggs"],
  [/\b(bread|tortilla|baguette|bun|roll|loaf|pita|naan)\b/i, "bakery_bread"],
  [/\b(canned|can of|broth|stock|diced tomatoes|crushed tomatoes|tomato paste|tomato sauce|coconut milk|chickpeas|black beans|kidney beans)\b/i, "canned"],
  [/\b(frozen|ice cream|frozen peas)\b/i, "frozen"],
  [/\b(chips|crackers|pretzels|popcorn|nuts|peanuts)\b/i, "snacks"],
  [/\b(foil|paper towel|plastic wrap|parchment|trash bag|dish soap)\b/i, "household"],
];

// R7 shoppability: an over-specific buy name a store search will not match.
const OVERSPECIFIC = [
  /\bneutral oil\b/i,
  /\bbone-?in,? skin-?on\b/i,
  /\bskin-?on,? bone-?in\b/i,
  /\b(about|approximately|roughly)\b/i,
  /\b\d+(\.\d+)?[- ]?inch\b/i,
  /,\s*(cut|sliced|diced|chopped|minced|torn|trimmed|halved|quartered|grated|shredded|cubed|julienned|thinly|finely|coarsely|room temperature|at room temp|divided|plus more)/i,
  /\bor\b.*\b(substitute|instead)\b/i,
  /\bpreferably\b/i,
  /\bhomemade\b/i,
  /\bhigh[- ]quality\b/i,
  // Not sold in any shape: a prepared or aged state of another food.
  /\bday-?old\b/i,
  /\bleftover\b/i,
  /\bfreshly\b/i,
  // A brine, a stem, a leaf or a zest is a PART of a purchase, not a purchase.
  /\b(brine|stems?|leaves|zest|juice of|rind)\b/i,
];

// ── the finding record ───────────────────────────────────────────────────────
interface Finding {
  detector: string;
  sub: string;
  file: string;
  planId: string;
  rows: number[];
  lines: string[];
  detail: string;
}

function relKey(rel: { groupKey(n: string): string }, name: string): string {
  return rel.groupKey(name);
}

async function main() {
  const tag = arg("tag", "live")!;
  const files = readdirSync(OUT)
    .filter((f) => f.startsWith(`${tag}__`) && f.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Error(`no out/${tag}__*.json`);

  const relations = await loadRelationIndex(prisma);

  // Live relation edges, so D1 can say WHICH edge links two rows.
  const edges = await prisma.ingredientRelation.findMany({
    select: {
      label: true,
      from: { select: { canonicalName: true } },
      to: { select: { canonicalName: true } },
    },
  });
  const edgeBetween = new Map<string, string>();
  for (const e of edges) {
    const a = normalizeIngredientName(e.from.canonicalName);
    const b = normalizeIngredientName(e.to.canonicalName);
    edgeBetween.set(`${a}||${b}`, e.label);
    edgeBetween.set(`${b}||${a}`, e.label);
  }

  const findings: Finding[] = [];
  const perList: Record<string, Record<string, number>> = {};

  for (const file of files) {
    const r = JSON.parse(readFileSync(join(OUT, file), "utf8"));
    const planId: string = r.planId;
    const final: {
      canonicalName: string; displayName: string; quantity: number; unit: string;
      sectionKey: string; isUniversalStaple: boolean; isUserPantryStaple: boolean;
      isRecurringItem: boolean; purchaseUnit: string | null; purchaseQuantity: number | null;
      purchaseDisplay: string | null; notes: string | null;
    }[] = r.final;
    const rendered: { line: string; packName: string; needText: string; packCount: number | null }[] = r.rendered;
    const counts: Record<string, number> = {};
    const bump = (d: string) => { counts[d] = (counts[d] ?? 0) + 1; };
    const push = (f: Omit<Finding, "file" | "planId">) => {
      findings.push({ ...f, file, planId });
      bump(f.detector);
    };

    // ── D1 — same food on two rows ─────────────────────────────────────────
    const byGroup = new Map<string, number[]>();
    const byNorm = new Map<string, number[]>();
    final.forEach((it, i) => {
      const g = relKey(relations, it.canonicalName);
      (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(i);
      const n = normalizeIngredientName(it.canonicalName);
      (byNorm.get(n) ?? byNorm.set(n, []).get(n)!).push(i);
    });
    const reportedPairs = new Set<string>();
    for (const [g, idxs] of byGroup) {
      if (idxs.length < 2) continue;
      const key = idxs.join(",");
      if (reportedPairs.has(key)) continue;
      reportedPairs.add(key);
      const names = idxs.map((i) => normalizeIngredientName(final[i].canonicalName));
      const units = new Set(idxs.map((i) => final[i].unit.trim().toLowerCase()));
      const sameName = new Set(names).size === 1;
      let sub: string;
      let edgeLabel: string | undefined;
      for (let a = 0; a < names.length && !edgeLabel; a++)
        for (let b = a + 1; b < names.length && !edgeLabel; b++)
          edgeLabel = edgeBetween.get(`${names[a]}||${names[b]}`);
      const anyRecurring = idxs.some((i) => final[i].isRecurringItem);
      const allRecurring = idxs.every((i) => final[i].isRecurringItem);
      if (sameName && units.size > 1) sub = "unit split";
      else if (sameName) sub = "same normalised name";
      else if (anyRecurring && !allRecurring) sub = "recurring twin";
      else if (edgeLabel === "component") sub = "component-pool miss";
      else if (edgeLabel) sub = `relation row links them (${edgeLabel})`;
      else sub = "other (same fold group)";
      push({
        detector: "D1", sub, rows: idxs,
        lines: idxs.map((i) => rendered[i].line),
        detail: `fold group "${g}"; units {${[...units].join(", ")}}`,
      });
    }
    // Names that differ only by a leading qualifier — R5's ungrouped case.
    for (let i = 0; i < final.length; i++) {
      for (let j = i + 1; j < final.length; j++) {
        const a = normalizeIngredientName(final[i].canonicalName);
        const b = normalizeIngredientName(final[j].canonicalName);
        if (relKey(relations, final[i].canonicalName) === relKey(relations, final[j].canonicalName)) continue;
        const shorter = a.length <= b.length ? a : b;
        const longer = a.length <= b.length ? b : a;
        if (shorter.length < 4) continue;
        if (longer.endsWith(` ${shorter}`) || longer.endsWith(shorter) && longer !== shorter && / /.test(longer)) {
          const lbl = edgeBetween.get(`${a}||${b}`);
          push({
            detector: "D1", sub: lbl ? `relation row links them (${lbl})` : "other (generic/specific, no relation row)",
            rows: [i, j], lines: [rendered[i].line, rendered[j].line],
            detail: `"${shorter}" ⊇ "${longer}"; R5 says one row with a qualifier`,
          });
        }
      }
    }

    // ── D2 / D3 — order vs need ────────────────────────────────────────────
    final.forEach((it, i) => {
      if (it.isUniversalStaple || it.isUserPantryStaple) return; // staples show no pack
      const display = it.purchaseDisplay;
      if (!display) return;
      const packs = rendered[i].packCount ?? 1; // null → the phone shows the stored pack as-is
      const cov = coverage(it.quantity, it.unit, packs, display);
      if (!cov) return;
      if (cov.ratio < 0.999) {
        push({
          detector: "D2", sub: rendered[i].packCount === null ? "pack not scaled (packsToCoverNeed null)" : "scaled pack still short",
          rows: [i], lines: [rendered[i].line],
          detail: `orders ${(cov.ratio * 100).toFixed(0)}% of the need (${cov.basis}); need ${it.quantity} ${it.unit} vs ${packs} × "${display}"`,
        });
      } else if (cov.ratio > 2.0) {
        push({
          detector: "D3", sub: rendered[i].packCount !== null && rendered[i].packCount! > 1 ? "rounded up past 2×" : "smallest pack already >2× the need",
          rows: [i], lines: [rendered[i].line],
          detail: `orders ${cov.ratio.toFixed(1)}× the need (${cov.basis}); need ${it.quantity} ${it.unit} vs ${packs} × "${display}"`,
        });
      }
    });

    // ── D4 — unshoppable / over-specific buy name ──────────────────────────
    final.forEach((it, i) => {
      for (const re of OVERSPECIFIC) {
        if (re.test(it.displayName)) {
          push({
            detector: "D4", sub: re.source.slice(0, 40),
            rows: [i], lines: [rendered[i].line],
            detail: `buy name "${it.displayName}"`,
          });
          break;
        }
      }
    });

    // ── D5 — junk unit / baked pack prefix / repeated residue ──────────────
    final.forEach((it, i) => {
      const u = it.unit.trim().toLowerCase();
      if (u !== "" && !KNOWN_UNITS.has(u)) {
        push({ detector: "D5", sub: "unrecognised unit token", rows: [i], lines: [rendered[i].line], detail: `unit "${it.unit}"` });
      }
      if (/^\s*\d/.test(it.displayName)) {
        push({ detector: "D5", sub: "pack prefix baked into displayName", rows: [i], lines: [rendered[i].line], detail: `displayName "${it.displayName}"` });
      }
      const residue = (it.purchaseDisplay ?? "").replace(/^\s*[\d.]+\s+/, "").trim().toLowerCase();
      if (residue && rendered[i].packName.toLowerCase().split(residue).length > 2) {
        push({ detector: "D5", sub: "pack residue repeated in the line", rows: [i], lines: [rendered[i].line], detail: `residue "${residue}"` });
      }
      if (/\d/.test(it.unit)) {
        push({ detector: "D5", sub: "a quantity in the unit slot", rows: [i], lines: [rendered[i].line], detail: `unit "${it.unit}"` });
      }
    });

    // ── D6 — display ───────────────────────────────────────────────────────
    final.forEach((it, i) => {
      const line = rendered[i].line;
      if (/^[A-Z]/.test(it.displayName) && !/^[A-Z][A-Z]/.test(it.displayName)) {
        const interior = /[A-Z]/.test(it.displayName.slice(1));
        push({
          detector: "D6", sub: interior ? "leading capital (proper noun — a render rule would break it)" : "leading capital on a common noun",
          rows: [i], lines: [line], detail: `displayName "${it.displayName}"`,
        });
      }
      // A long decimal that never became a glyph.
      if (/\d\.\d{3,}/.test(rendered[i].needText)) {
        push({ detector: "D6", sub: "raw decimal in the need (off the glyph ladder)", rows: [i], lines: [line], detail: `need "${rendered[i].needText}"` });
      }
      // A pluralisable count unit left singular against a plural count.
      const u = it.unit.trim().toLowerCase();
      if (PLURALISABLE.has(u) && it.quantity > 1 && new RegExp(`\\b${u}\\b(?!s)`).test(rendered[i].needText)) {
        push({ detector: "D6", sub: "count unit left singular", rows: [i], lines: [line], detail: `${it.quantity} ${it.unit}` });
      }
    });

    // ── D7 — recurring / staple display ────────────────────────────────────
    final.forEach((it, i) => {
      if ((it.isUniversalStaple || it.isUserPantryStaple) && it.purchaseDisplay && rendered[i].packName !== it.displayName) {
        push({ detector: "D7", sub: "staple renders a pack (R4 says need only)", rows: [i], lines: [rendered[i].line], detail: `pack "${it.purchaseDisplay}"` });
      }
      if (it.isRecurringItem) {
        const hasSplit = /recurring|for meals|\+/i.test(it.notes ?? "");
        const alsoMeal = (r.consolidated as { canonicalName: string; sources: unknown[] }[])
          .some((c) => normalizeIngredientName(c.canonicalName) === normalizeIngredientName(it.canonicalName) && (c.sources?.length ?? 0) > 0);
        if (alsoMeal && !hasSplit) {
          push({ detector: "D7", sub: "recurring + meal need merged with no annotated split (R3)", rows: [i], lines: [rendered[i].line], detail: `notes=${JSON.stringify(it.notes)}` });
        }
      }
    });

    // ── D8 — aisle plausibility ────────────────────────────────────────────
    final.forEach((it, i) => {
      const dried = NOT_FRESH.test(it.displayName) || SPICE_PEPPER.test(it.displayName);
      for (const [re, expected] of SECTION_HINTS) {
        if (re.test(it.displayName)) {
          // A modifier that moves the food out of the hinted aisle exempts it.
          if (expected === "produce" && (dried || NOT_PRODUCE_FORM.test(it.displayName))) break;
          if (expected === "meat_seafood" && NOT_MEAT.test(it.displayName)) break;
          // BUG-191 ruled egg PASTA is Pantry, not Dairy — the detector agrees.
          if (expected === "dairy_eggs" && /\b(noodles?|pasta|wash|bread|roll)\b/i.test(it.displayName)) break;
          if (it.sectionKey !== expected) {
            push({
              detector: "D8", sub: `${it.sectionKey} → expected ${expected}`,
              rows: [i], lines: [rendered[i].line],
              detail: `"${it.displayName}" filed under ${it.sectionKey}`,
            });
          }
          break;
        }
      }
      if (it.sectionKey === "extras") {
        push({ detector: "D8", sub: "left in extras", rows: [i], lines: [rendered[i].line], detail: `"${it.displayName}"` });
      }
    });

    perList[file] = counts;
  }

  // ── output ───────────────────────────────────────────────────────────────
  const totals: Record<string, number> = {};
  const subTotals: Record<string, number> = {};
  for (const f of findings) {
    totals[f.detector] = (totals[f.detector] ?? 0) + 1;
    const k = `${f.detector} · ${f.sub}`;
    subTotals[k] = (subTotals[k] ?? 0) + 1;
  }

  const L: string[] = [];
  L.push(`CHECKER — tag=${tag}, ${files.length} lists`);
  L.push("");
  L.push("TOTALS BY DETECTOR");
  for (const d of ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8"]) {
    L.push(`  ${d}  ${totals[d] ?? 0}`);
  }
  L.push("");
  L.push("BY CAUSE (sub-class), descending");
  for (const [k, v] of Object.entries(subTotals).sort((a, b) => b[1] - a[1])) {
    L.push(`  ${String(v).padStart(4)}  ${k}`);
  }
  L.push("");
  L.push("PER LIST");
  for (const [file, c] of Object.entries(perList)) {
    const tot = Object.values(c).reduce((a, b) => a + b, 0);
    L.push(`  ${file.padEnd(34)} total=${String(tot).padStart(4)}  ${["D1","D2","D3","D4","D5","D6","D7","D8"].map((d) => `${d}=${c[d] ?? 0}`).join(" ")}`);
  }
  L.push("");
  L.push("EVERY FINDING");
  for (const f of findings) {
    L.push(`[${f.detector}] ${f.sub}`);
    L.push(`   ${f.file}  rows ${f.rows.join(",")}`);
    for (const ln of f.lines) L.push(`   | ${ln}`);
    L.push(`   ${f.detail}`);
  }

  writeFileSync(join(OUT, `_findings__${tag}.txt`), L.join("\n"));
  writeFileSync(
    join(OUT, `_findings__${tag}.json`),
    JSON.stringify({ tag, lists: files.length, totals, subTotals, perList, findings }, null, 1),
  );
  console.log(L.slice(0, L.indexOf("EVERY FINDING")).join("\n"));
  console.log(`\n→ out/_findings__${tag}.txt  (${findings.length} findings)`);
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
