// [grocery] B2 — REPORT ONLY, NOTHING WRITTEN.
//
//   node --env-file=.env --import tsx scripts/grocery-b2/probe16.ts -> out/bonein-recipes.txt
//
// Hans's amendment: "a recipe wanting bone-in must SAY so … 'oven roasted chicken
// thighs' or 'grilled whole thighs' would be scenarios that call for the actual
// bone in skin on variety."
//
// So this is the OTHER side of H2's rule. H2 makes the plain name mean boneless
// skinless, which is right for the shopping list and WRONG for any public recipe
// whose steps assume skin. This finds those recipes and lists them. It changes
// nothing: whether a recipe gets relabelled is a recipe-authoring decision.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });
const host = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
const prisma = new PrismaClient();

/** The plain names H2 now reinterprets. */
const PLAIN = ["chicken thighs", "chicken thigh", "chicken breast", "chicken breasts"];

/**
 * Step phrases that assume the BONE-IN SKIN-ON pack.
 *
 * Deliberately narrow. "bone" alone would catch "boneless"; "roast" alone catches
 * every roasted vegetable in the catalog. Each pattern below is a phrase that only
 * makes sense if the pack has skin or bone.
 */
const TELLS: { re: RegExp; why: string }[] = [
  { re: /\bskin[- ]side\b/i, why: "names a skin side" },
  { re: /\bcrispy skin\b/i, why: "wants crispy skin" },
  { re: /\bcrisp(?:s|ed|ing)?\s+the\s+skin\b/i, why: "crisps the skin" },
  { re: /\bskin\s+is\s+(?:crisp|golden|brown)/i, why: "judges doneness by the skin" },
  { re: /\bpat\s+the\s+skin\b/i, why: "pats the skin dry" },
  { re: /\bunder\s+the\s+skin\b/i, why: "goes under the skin" },
  { re: /\bskin[- ]on\b/i, why: "says skin-on in the step" },
  { re: /\bbone[- ]in\b/i, why: "says bone-in in the step" },
  { re: /\bagainst\s+the\s+bone\b/i, why: "temps against the bone" },
  { re: /\bnear\s+the\s+bone\b/i, why: "temps near the bone" },
  { re: /\boff\s+the\s+bone\b/i, why: "pulls meat off the bone" },
  { re: /\bwhole\s+thighs?\b/i, why: "says whole thighs" },
  { re: /\bwhole\s+breasts?\b/i, why: "says whole breasts" },
];

// RecipeInstructionStep is a POLYMORPHIC table (ownerType 'meal' | 'dish') with no
// FK, so the steps cannot be included on the dish — they are a second read keyed
// on ownerId. Same for the meal side: the join is MealDishLink.
const dishes = await prisma.dish.findMany({
  where: {
    dishIngredients: { some: { ingredient: { canonicalName: { in: PLAIN } } } },
  },
  select: {
    id: true,
    title: true,
    mealLinks: { select: { meal: { select: { id: true, title: true, isPublic: true } } } },
    dishIngredients: {
      select: { ingredient: { select: { canonicalName: true } } },
    },
  },
});
const stepsByOwner = new Map<string, { stepIndex: number; instruction: string }[]>();
for (const st of await prisma.recipeInstructionStep.findMany({
  where: { ownerType: "dish", ownerId: { in: dishes.map((d) => d.id) } },
  select: { ownerId: true, stepIndex: true, stepTextRaw: true, stepTextTranslated: true },
})) {
  let a = stepsByOwner.get(st.ownerId);
  if (!a) { a = []; stepsByOwner.set(st.ownerId, a); }
  // Both texts are scanned: the translated one is what the cook reads, the raw one
  // is what the import produced, and a tell can survive in either.
  a.push({ stepIndex: st.stepIndex, instruction: `${st.stepTextTranslated} ${st.stepTextRaw}` });
}

interface Hit {
  isPublic: boolean;
  dishId: string;
  dishTitle: string;
  mealTitles: string[];
  plain: string[];
  tells: { step: number; why: string; phrase: string }[];
}

const hits: Hit[] = [];
let publicDishes = 0;
for (const d of dishes) {
  const meals = d.mealLinks.map((l) => l.meal);
  const isPublic = meals.some((m) => m.isPublic);
  if (isPublic) publicDishes++;
  const plain = [
    ...new Set(
      d.dishIngredients
        .map((di) => di.ingredient.canonicalName)
        .filter((n) => PLAIN.includes(n)),
    ),
  ];
  const tells: Hit["tells"] = [];
  for (const st of stepsByOwner.get(d.id) ?? []) {
    for (const t of TELLS) {
      const m = t.re.exec(st.instruction);
      if (!m) continue;
      const i = Math.max(0, (m.index ?? 0) - 40);
      tells.push({
        step: st.stepIndex,
        why: t.why,
        phrase: st.instruction.slice(i, Math.min(st.instruction.length, (m.index ?? 0) + 60)).trim(),
      });
    }
  }
  if (tells.length > 0) {
    hits.push({
      isPublic,
      dishId: d.id,
      dishTitle: d.title,
      mealTitles: [...new Set(meals.filter((m) => m.isPublic).map((m) => m.title))],
      plain,
      tells,
    });
  }
}

const L: string[] = [];
L.push("[grocery] B2 — PUBLIC recipes whose plain chicken should probably be bone-in");
L.push("REPORT ONLY. Nothing was changed.");
L.push("");
L.push("Hans, September 28: a recipe wanting bone-in must SAY so. H2 now makes a");
L.push('plain "chicken thighs" mean boneless skinless on the shopping list, which is');
L.push("right for shopping and wrong for any recipe whose STEPS assume skin or bone.");
L.push("This is the recipe-authoring side of the same rule.");
L.push("");
L.push(`dishes using a plain chicken name: ${dishes.length}  (PUBLIC: ${publicDishes})`);
L.push(`…of those, dishes whose steps tell on them: ${hits.length}  (PUBLIC: ${hits.filter((h) => h.isPublic).length})`);
L.push("");
L.push("⚠️ THE PUBLIC POPULATION IS TINY AND THAT IS THE POINT. Almost every catalog");
L.push("recipe already NAMES its cut — which is Hans's rule working before it was");
L.push("written down. The plain name is mostly a USER-authored shape, and a user's own");
L.push("recipe is theirs to word.");
L.push("");
for (const h of hits.sort((a, b) => a.dishTitle.localeCompare(b.dishTitle))) {
  L.push(`## ${h.dishTitle}${h.isPublic ? "   [PUBLIC]" : "   [private]"}`);
  L.push(`   dish id: ${h.dishId}`);
  L.push(`   meal(s): ${h.mealTitles.join(" · ") || "(none public)"}`);
  L.push(`   plain ingredient: ${h.plain.join(", ")}`);
  for (const t of [...new Map(h.tells.map((x) => [`${x.step}|${x.why}`, x])).values()]) {
    L.push(`   step ${t.step} — ${t.why}: "${t.phrase}"`);
  }
  L.push("");
}
if (hits.length === 0) {
  L.push("Nothing found. Either every bone-in recipe already names the cut, or the");
  L.push("patterns above are too narrow — they are listed in the script so the next");
  L.push("reader can judge which.");
}

writeFileSync(join(OUT, "bonein-recipes.txt"), L.join("\n"), "utf8");
console.log(L.join("\n"));
await prisma.$disconnect();
