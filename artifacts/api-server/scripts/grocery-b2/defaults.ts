// [grocery] B2 · Part A2(b) — THE DEFAULTS LIST. READ-ONLY.
//
//   node --env-file=.env --import tsx scripts/grocery-b2/defaults.ts  -> out/defaults.txt
//
// One numbered line per generic that (i) has subsumes-variants and (ii) appears
// on a dish. NOT gated on confidence — see the note at the filter. Reply by number:  7 bone-in, 41 no
//
// NONE IS THE NORM. Hans: "if the recipe is specific, we honor it. but in lieu
// of that, we go generic." A default is proposed only where the plain name is
// not itself something a shopper can pick up.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { normalizeIngredientName } from "../../src/lib/groceryNormalization";
import { classifyEdge, DEFAULTS, packUnitCarriesShares } from "./proposals";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const CORPUS = join(HERE, "..", "grocery-census", "out");
mkdirSync(OUT, { recursive: true });

const host = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
const prisma = new PrismaClient();

// ── which of the 20 corpus lists demands each canonical name? ──────────────
const corpusFiles = readdirSync(CORPUS).filter((f) => f.startsWith("b1__") && f.endsWith(".json"));
const listsDemanding = new Map<string, Set<string>>();
for (const f of corpusFiles) {
  const j = JSON.parse(readFileSync(join(CORPUS, f), "utf8"));
  const tag = f.replace(/^b1__|__r1\.json$/g, "");
  for (const r of j.consolidated ?? []) {
    const n = normalizeIngredientName(r.canonicalName);
    let s = listsDemanding.get(n);
    if (!s) { s = new Set(); listsDemanding.set(n, s); }
    s.add(tag);
  }
}

// ── the live subsumes population, the same selection the dry run uses ──────
const usedIds = new Set(
  (await prisma.dishIngredient.groupBy({ by: ["ingredientId"] })).map((u) => u.ingredientId),
);
const rows = await prisma.ingredientRelation.findMany({
  where: { label: "subsumes" },
  select: {
    fromIngredientId: true, toIngredientId: true, confidence: true, reviewedByHuman: true,
    from: { select: { canonicalName: true, purchaseUnit: true, purchaseDisplay: true, category: true } },
    to: { select: { canonicalName: true } },
  },
});
// ⚠️ THE POPULATION HERE IS NOT THE DRY RUN'S. The dry run reads the edges past
// the admission gate (`reviewedByHuman OR high`). A DEFAULT cannot be selected
// from that set, because the gate is the thing a default has to get past:
// `chicken thighs -> bone-in skin-on chicken thighs` is `medium` and unreviewed,
// so filtering by the gate first proposed ZERO defaults including the one Hans
// had already ruled. The reachability test — both endpoints on a dish — is the
// right filter, and each variant's confidence is printed beside it.
const live = rows.filter(
  (r) => usedIds.has(r.fromIngredientId) && usedIds.has(r.toIngredientId),
);

interface Generic {
  name: string;
  purchaseUnit: string | null;
  purchaseDisplay: string | null;
  category: string;
  specifics: { name: string; gate: boolean; confidence: string }[];
}
const byGeneric = new Map<string, Generic>();
for (const r of live) {
  const k = r.from.canonicalName;
  let g = byGeneric.get(k);
  if (!g) {
    g = {
      name: k, purchaseUnit: r.from.purchaseUnit, purchaseDisplay: r.from.purchaseDisplay,
      category: r.from.category, specifics: [],
    };
    byGeneric.set(k, g);
  }
  if (!g.specifics.some((x) => x.name === r.to.canonicalName)) {
    g.specifics.push({
      name: r.to.canonicalName,
      gate: r.reviewedByHuman || r.confidence === "high",
      confidence: r.confidence,
    });
  }
}

const proposedByGeneric = new Map(DEFAULTS.map((d) => [d.generic, d]));

const L: string[] = [];
let n = 0;
const num = () => String(++n).padStart(4, " ");

L.push("[grocery] B2 · A2(b) — THE DEFAULTS LIST · September 28, 2026");
L.push("");
L.push("Reply by number. Two ways to answer a line:");
L.push('  "41 no"                 -> leave it NONE (H3). Nothing to do; NONE is the norm.');
L.push('  "41 bone-in pork chops" -> that specific becomes the default (H2).');
L.push("");
L.push("A line marked `?` is one this lane PROPOSES. Everything else is NONE and");
L.push("needs no reply — it is listed so any of them can be overridden by number.");
L.push("");
L.push("WHAT A DEFAULT DOES (H2): the plain name joins the default's line and is");
L.push("named as the default. `chicken thighs` 2 lb + `bone-in chicken thighs` 3 lb");
L.push("becomes one line reading `bone-in chicken thighs`. It does NOT touch the");
L.push("other variants — `boneless skinless chicken thighs` stays its own line (H1).");
L.push("");
L.push("WHAT NONE DOES (H3): the plain name stays generic. If a recipe ALSO named a");
L.push("variety and the generic is count-sold, the generic line carries it in whole");
L.push("counts (`6 bell peppers, at least 2 green`). Otherwise both stand alone.");
L.push("");

const noPackCount = [...byGeneric.values()].filter((g) => !g.purchaseUnit || !g.purchaseDisplay).length;
const noneOnly: string[] = [];
let proposedCount = 0;

for (const g of [...byGeneric.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  const lists = listsDemanding.get(normalizeIngredientName(g.name)) ?? new Set<string>();
  const prop = proposedByGeneric.get(g.name);
  const classes = g.specifics.map((s) => `${s.name} [${classifyEdge(g.name, s.name).hClass}${s.gate ? "" : ", below the gate: " + s.confidence}]`);
  const carries = packUnitCarriesShares(g.purchaseUnit);

  const head = prop?.def
    ? `${num()}. ${prop.uncertain ? "?" : " "} ${g.name} → default: ${prop.reads}`
    : `${num()}.   ${g.name} → NONE (H3)`;
  L.push(`${head} · corpus lists affected: ${lists.size}`);
  L.push(`        pack: ${g.purchaseDisplay ?? "(none stated)"} [${g.purchaseUnit ?? "-"}] · ${carries ? "count-sold, CAN carry shares" : "weight/volume-sold, H5 blocks shares"} · ${g.category}`);
  L.push(`        variants: ${classes.join(" · ")}`);
  if (prop?.def) {
    proposedCount++;
    L.push(`        canonical to fold onto: ${prop.def}`);
    L.push(`        why: ${prop.why}`);
  } else {
    noneOnly.push(g.name);
  }
  if (lists.size > 0) L.push(`        lists: ${[...lists].sort().join(" ")}`);
}

L.push("");
L.push("=".repeat(78));
L.push(`generics with live subsumes-variants on a dish   ${byGeneric.size}`);
L.push(`  proposed a default                             ${proposedCount}`);
L.push(`  left at NONE (H3)                              ${noneOnly.length}`);
L.push(`generics that appear in the 20-list corpus       ${[...byGeneric.keys()].filter((k) => (listsDemanding.get(normalizeIngredientName(k))?.size ?? 0) > 0).length}`);
L.push("");
L.push("WHY SO FEW PROPOSALS. The bar the go-ahead set is that the plain name is not");
L.push("itself something a shopper can pick up. Two generics clear it, and both are");
L.push("chicken: a meat case has no unqualified `chicken thighs` or `chicken breast`");
L.push("bin — every pack states its cut. `ribeye steak`, `smoked sausage`,");
L.push("`hamburger buns`, `kale`, `kidney beans` and the rest are all sold under");
L.push("exactly their plain name, so a default would substitute where H4 forbids it.");
L.push("");
L.push(`⚠️ A TEMPTING WRONG SIGNAL, measured and rejected: ${noPackCount} of the ${byGeneric.size}`);
L.push("generics carry NO pack at all (purchaseUnit and purchaseDisplay both null).");
L.push("That looks like 'unbuyable' and is not — `arugula`, `kale`, `brown rice` and");
L.push("`hamburger buns` are in that set. It measures how far the catalog's pack");
L.push("backfill got, not what a store sells. No default was proposed from it.");
L.push("");
L.push("ONE MORE THIS LANE CONSIDERED AND DID NOT PROPOSE: `corn kernels`. Its only");
L.push("variants are `fresh corn kernels` and `frozen corn kernels`, and loose corn");
L.push("kernels are genuinely not a thing you pick up — but picking one would be");
L.push("choosing between two products H1 keeps apart, which is the substitution H4");
L.push("forbids. It is listed at NONE; override it by number if that is wrong.");

writeFileSync(join(OUT, "defaults.txt"), L.join("\n"), "utf8");
console.log(L.join("\n"));
console.log(`\n-> ${join(OUT, "defaults.txt")}  (${n} numbered lines)`);
await prisma.$disconnect();
