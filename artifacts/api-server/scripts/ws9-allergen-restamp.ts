// ws9-allergen-restamp.ts — re-derive Meal.allergens across the shared pool
// under the corrected vocabulary in src/lib/allergens.ts.
//
// WHY. The stamp vocabulary carried four defects and a coverage collapse:
//   1. "eggplant" and "parmigiano-reggiano" both contain the substring "egg", so
//      31 meals were falsely stamped `egg`.
//   2. "corn tortilla" and "rice noodle" contain the words `tortilla`/`noodle`,
//      so ~90 naturally gluten-free meals were falsely stamped `wheat`.
//   3. Gluten-free mapped to `wheat` alone — barley/farro/rye had no token, so
//      gluten-containing meals passed a Gluten-free filter.
//   4. Crawfish matched `fish` and nothing matched `shellfish`, so a crawfish
//      dish reached a Shellfish-free user.
//   5. Named pasta shapes (spaghetti, rigatoni, ...) and bakery breads
//      (baguette, ciabatta, brioche) were absent from the wheat vocabulary
//      entirely — 28 meals stamped-but-missing `wheat`, the largest defect.
//
// SCOPE. The public pool only (isPublic, not archived) — that is what retrieval
// reads, and Meal.allergens is not rendered anywhere in the mobile app. Private
// user meals are left alone; the paths that could later publish one
// (publishMealToStore, promoteInstanceToTemplate) now stamp at publish time.
//
// ⚠️ NO TEST DATABASE EXISTS (D-WS9-181). --apply writes to live data. The
// default is --dry-run and it must stay that way.
//
// Usage:
//   pnpm --filter @workspace/api-server exec tsx scripts/ws9-allergen-restamp.ts
//   pnpm --filter @workspace/api-server exec tsx scripts/ws9-allergen-restamp.ts --apply

import { PrismaClient } from "@prisma/client";

import { ALLERGEN_TOKENS, deriveAllergensFromNames } from "../src/lib/allergens";

const prisma = new PrismaClient();

// ── the PRE-FIX vocabulary, frozen ───────────────────────────────────────────
// Kept verbatim ONLY so the dry-run can attribute each removed token to the
// ingredient that used to trigger it. Never used to write anything. Do not
// "keep it in sync" — it is a historical record, and its wrongness is the point.
const LEGACY: Record<string, readonly string[]> = {
  dairy: ["milk", "butter", "cheese", "cream", "yogurt", "parmesan", "mozzarella", "feta", "ricotta", "ghee", "paneer"],
  egg: ["egg"],
  peanut: ["peanut"],
  tree_nut: ["almond", "walnut", "pecan", "cashew", "pistachio", "hazelnut", "macadamia", "pine nut"],
  soy: ["soy", "tofu", "tempeh", "edamame", "miso", "tamari"],
  wheat: ["wheat", "flour", "bread", "pasta", "noodle", "tortilla", "couscous", "cracker", "panko", "breadcrumb", "soy sauce"],
  fish: ["fish", "salmon", "tuna", "cod", "tilapia", "trout", "halibut", "anchovy"],
  shellfish: ["shrimp", "prawn", "crab", "lobster", "scallop", "clam", "mussel", "oyster"],
  sesame: ["sesame", "tahini"],
};

/** Which ingredient names used to trigger `token` under the legacy rule. */
function legacyCause(token: string, names: readonly string[]): string[] {
  const subs = LEGACY[token];
  if (!subs) return [];
  return names.filter((n) => {
    const l = n.toLowerCase();
    return subs.some((s) => l.includes(s));
  });
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

async function main() {
  const apply = process.argv.includes("--apply");
  const mode = apply ? "APPLY (writes live data)" : "DRY-RUN (no writes)";
  console.log(`\nws9-allergen-restamp — ${mode}\n${"=".repeat(72)}`);

  const meals = await prisma.meal.findMany({
    where: { isPublic: true, isArchived: false },
    select: {
      id: true, title: true, allergens: true, sourceType: true, mealType: true,
      dishLinks: {
        select: {
          dish: { select: { dishIngredients: { select: { ingredient: { select: { displayName: true } } } } } },
        },
      },
    },
    orderBy: { id: "asc" },
  });

  interface Row {
    id: string; title: string; sourceType: string; mealType: string;
    names: string[]; before: string[]; after: string[];
    removed: string[]; added: string[];
  }
  const rows: Row[] = meals.map((m) => {
    const names = [...new Set(m.dishLinks.flatMap((l) => l.dish.dishIngredients.map((d) => d.ingredient.displayName)))];
    const before = [...m.allergens].sort();
    const after = deriveAllergensFromNames(names);
    return {
      id: m.id, title: m.title, sourceType: m.sourceType, mealType: m.mealType,
      names, before, after,
      removed: before.filter((t) => !after.includes(t)),
      added: after.filter((t) => !before.includes(t)),
    };
  });

  const changed = rows.filter((r) => !sameSet(r.before, r.after));
  const removals = changed.filter((r) => r.removed.length > 0);
  const additionsOnly = changed.filter((r) => r.removed.length === 0 && r.added.length > 0);
  const newlyStamped = changed.filter((r) => r.before.length === 0 && r.after.length > 0);
  const nowEmpty = changed.filter((r) => r.after.length === 0 && r.before.length > 0);

  console.log(`\nscope: public + non-archived meals = ${rows.length} (${rows.filter((r) => r.mealType === "dinner").length} dinners)`);
  console.log(`unstamped before : ${rows.filter((r) => r.before.length === 0).length}`);
  console.log(`unstamped after  : ${rows.filter((r) => r.after.length === 0).length}`);

  console.log(`\n── PER-TOKEN, public dinner pool ──`);
  const dinners = rows.filter((r) => r.mealType === "dinner");
  const toks = [...new Set([...ALLERGEN_TOKENS, ...Object.keys(LEGACY)])].sort();
  console.table(toks.map((t) => ({
    token: t,
    before: dinners.filter((r) => r.before.includes(t)).length,
    after: dinners.filter((r) => r.after.includes(t)).length,
    delta: dinners.filter((r) => r.after.includes(t)).length - dinners.filter((r) => r.before.includes(t)).length,
  })));

  console.log(`\n── BY DIRECTION ──`);
  console.log(`  meals changed                : ${changed.length}`);
  console.log(`  REMOVALS (token taken away)  : ${removals.length}   <-- the dangerous direction`);
  console.log(`  additions only               : ${additionsOnly.length}`);
  console.log(`  newly stamped (were empty)   : ${newlyStamped.length}`);
  console.log(`  became empty (were stamped)  : ${nowEmpty.length}`);

  const byToken: Record<string, number> = {};
  for (const r of removals) for (const t of r.removed) byToken[t] = (byToken[t] ?? 0) + 1;
  console.log(`  removals by token            : ${JSON.stringify(byToken)}`);

  console.log(`\n── FULL REMOVAL LIST (${removals.length}) — the review gate ──`);
  removals.forEach((r, i) => {
    const causes = r.removed.map((t) => `${t} <- ${legacyCause(t, r.names).join(" / ") || "(unattributed)"}`);
    console.log(`${String(i + 1).padStart(3)}. [${r.sourceType}] ${r.title}`);
    console.log(`     ${JSON.stringify(r.before)} -> ${JSON.stringify(r.after)}`);
    console.log(`     removed: ${causes.join("  |  ")}`);
    if (r.added.length) console.log(`     added:   ${JSON.stringify(r.added)}`);
  });

  if (nowEmpty.length) {
    console.log(`\n⚠️  BECAME EMPTY (${nowEmpty.length}) — these fall back to fail-closed exclusion for every allergic user:`);
    nowEmpty.forEach((r) => console.log(`     ${r.title}  was ${JSON.stringify(r.before)}`));
  }

  if (!apply) {
    console.log(`\n${"=".repeat(72)}\nDRY-RUN — nothing written. ${changed.length} meals would change.`);
    console.log(`Re-run with --apply to write.`);
    return;
  }

  console.log(`\n${"=".repeat(72)}\nAPPLYING ${changed.length} updates...`);
  let written = 0;
  for (const r of changed) {
    await prisma.meal.update({ where: { id: r.id }, data: { allergens: r.after } });
    written++;
    if (written % 100 === 0) console.log(`  ...${written}/${changed.length}`);
  }
  console.log(`APPLIED. ${written} meals updated.`);
  console.log(`Re-run WITHOUT --apply to confirm idempotency (expect "0 meals would change").`);
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
