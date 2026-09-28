// Grocery census — Part A probe 3. READ-ONLY.
// A6 data counts (dual-path, capitalisation, amountRefs) + the plan behind a
// named list + yield-coverage inputs.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) {
    throw new Error("REFUSING: not the dev branch");
  }

  // ── A6.1 — dual-path population ───────────────────────────────────────────
  const stepsTagged = await prisma.recipeInstructionStep.groupBy({
    by: ["pathKey"],
    _count: { _all: true },
  });
  console.log("STEPS BY pathKey:", JSON.stringify(stepsTagged));
  const stepsComp = await prisma.recipeInstructionStep.count({
    where: { componentKey: { not: null } },
  });
  console.log("STEPS with componentKey:", stepsComp);

  const diTagged = await prisma.dishIngredient.groupBy({
    by: ["pathKey"],
    _count: { _all: true },
  });
  console.log("DISH INGREDIENTS BY pathKey:", JSON.stringify(diTagged));
  const diComp = await prisma.dishIngredient.count({
    where: { componentKey: { not: null } },
  });
  console.log("DISH INGREDIENTS with componentKey:", diComp);

  // Meals with tagged steps (steps are polymorphic: ownerType dish|meal).
  const taggedSteps = await prisma.recipeInstructionStep.findMany({
    where: { pathKey: { not: null } },
    select: { ownerType: true, ownerId: true, pathKey: true, componentKey: true },
  });
  const dishIdsTagged = new Set(
    taggedSteps.filter((s) => s.ownerType === "dish").map((s) => s.ownerId),
  );
  const mealIdsTaggedDirect = new Set(
    taggedSteps.filter((s) => s.ownerType === "meal").map((s) => s.ownerId),
  );
  console.log("dishes with tagged steps:", dishIdsTagged.size);
  console.log("meals with directly-tagged steps:", mealIdsTaggedDirect.size);

  const links = await prisma.mealDishLink.findMany({
    where: { dishId: { in: [...dishIdsTagged] } },
    select: { mealId: true, dishId: true },
  });
  const mealsViaDish = new Set(links.map((l) => l.mealId));
  console.log("meals reached via a tagged dish:", mealsViaDish.size);

  // Components with ONLY bought steps (no scratch counterpart).
  const byComp = new Map<string, Set<string>>();
  for (const s of taggedSteps) {
    if (!s.componentKey) continue;
    const k = `${s.ownerType}:${s.ownerId}:${s.componentKey}`;
    const set = byComp.get(k) ?? new Set<string>();
    set.add(s.pathKey ?? "null");
    byComp.set(k, set);
  }
  let bothPaths = 0, onlyBought = 0, onlyScratch = 0;
  for (const set of byComp.values()) {
    const hasB = set.has("bought"), hasS = set.has("scratch");
    if (hasB && hasS) bothPaths++;
    else if (hasB) onlyBought++;
    else if (hasS) onlyScratch++;
  }
  console.log(
    `COMPONENTS: total=${byComp.size} both=${bothPaths} onlyBought=${onlyBought} onlyScratch=${onlyScratch}`,
  );

  // Which corpus-eligible plans contain a dual-path dish?
  const planItems = await prisma.mealPlanItem.findMany({
    where: { mealId: { in: [...mealsViaDish, ...mealIdsTaggedDirect] } },
    select: { mealPlanInstanceId: true, mealId: true },
  });
  const plansWithDual = [...new Set(planItems.map((p) => p.mealPlanInstanceId))];
  console.log("PLANS containing a path-tagged meal:", plansWithDual.length);
  if (plansWithDual.length > 0) {
    const rows = await prisma.mealPlanInstance.findMany({
      where: { id: { in: plansWithDual } },
      select: {
        id: true, createdAt: true, titleOverride: true,
        template: { select: { title: true } },
        _count: { select: { items: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    for (const r of rows) {
      console.log(
        `   ${r.id.slice(0, 8)}  meals=${r._count.items}  ${r.createdAt.toISOString().slice(0, 10)}  ${(r.titleOverride ?? r.template?.title ?? "").slice(0, 40)}`,
      );
    }
  }

  // ── A6.4 — capitalisation ─────────────────────────────────────────────────
  const allIng = await prisma.ingredient.findMany({
    select: { canonicalName: true, displayName: true },
  });
  const leadCap = (s: string) => /^[A-Z]/.test(s);
  const allLower = (s: string) => s === s.toLowerCase();
  console.log(
    `INGREDIENT rows=${allIng.length}` +
      `  canonicalName leadingCap=${allIng.filter((i) => leadCap(i.canonicalName)).length}` +
      `  displayName leadingCap=${allIng.filter((i) => leadCap(i.displayName)).length}` +
      `  displayName allLower=${allIng.filter((i) => allLower(i.displayName)).length}`,
  );
  const capSamples = allIng.filter((i) => leadCap(i.displayName)).slice(0, 25);
  console.log("  leading-cap displayName samples:", JSON.stringify(capSamples.map((i) => i.displayName)));
  // Interior capitals (a proper noun / brand — a render rule cannot fix these).
  const interiorCap = allIng.filter(
    (i) => /[A-Z]/.test(i.displayName.slice(1)) && !leadCap(i.displayName),
  );
  const leadCapOnly = allIng.filter(
    (i) => leadCap(i.displayName) && !/[A-Z]/.test(i.displayName.slice(1)),
  );
  const leadAndInterior = allIng.filter(
    (i) => leadCap(i.displayName) && /[A-Z]/.test(i.displayName.slice(1)),
  );
  console.log(
    `  leadCap-ONLY (a lowercase render rule would fix)=${leadCapOnly.length}` +
      `  leadCap+interiorCap (a render rule would BREAK)=${leadAndInterior.length}` +
      `  interiorCap-only=${interiorCap.length}`,
  );
  console.log("  leadCap+interior samples:", JSON.stringify(leadAndInterior.slice(0, 20).map((i) => i.displayName)));

  // Same question on the live grocery rows (what actually renders).
  const gliNames = await prisma.groceryListItem.findMany({
    select: { displayName: true },
  });
  console.log(
    `GROCERY LIST ITEM rows=${gliNames.length}  leadingCap=${gliNames.filter((g) => leadCap(g.displayName)).length}`,
  );

  // ── A6.5 — amountRefs spans that do not contain their quantity ────────────
  const withRefs = await prisma.recipeInstructionStep.findMany({
    where: { amountRefs: { not: null } },
    select: { id: true, stepTextRaw: true, amountRefs: true },
  });
  let spanTotal = 0, spanNoDigit = 0, spanOutOfRange = 0, spanMismatch = 0;
  const examples: string[] = [];
  for (const s of withRefs) {
    const refs = s.amountRefs as unknown;
    if (!Array.isArray(refs)) continue;
    for (const r of refs as { charStart: number; charEnd: number; quantity: number; unit: string }[]) {
      spanTotal++;
      if (
        !Number.isInteger(r.charStart) || !Number.isInteger(r.charEnd) ||
        r.charStart < 0 || r.charEnd > s.stepTextRaw.length || r.charStart >= r.charEnd
      ) {
        spanOutOfRange++;
        continue;
      }
      const span = s.stepTextRaw.slice(r.charStart, r.charEnd);
      if (!/[0-9¼½¾⅓⅔⅛⅜⅝⅞]/.test(span)) {
        spanNoDigit++;
        if (examples.length < 15) examples.push(`"${span}"  (ref ${r.quantity} ${r.unit})  in: ${s.stepTextRaw.slice(0, 70)}`);
      } else {
        const m = /[\d.]+/.exec(span);
        const n = m ? parseFloat(m[0]) : NaN;
        if (Number.isFinite(n) && Math.abs(n - r.quantity) > 0.01 + 1e-9) spanMismatch++;
      }
    }
  }
  console.log(
    `AMOUNTREFS: steps=${withRefs.length} spans=${spanTotal} noDigitInSpan=${spanNoDigit} outOfRange=${spanOutOfRange} digitMismatch=${spanMismatch}`,
  );
  for (const e of examples) console.log("   ", e);

  // ── the plan behind the named lists ───────────────────────────────────────
  for (const p of ["739fe494", "65eac724", "a47cf201", "adf4a44b", "1589fe77"]) {
    const l = await prisma.groceryList.findFirst({
      where: { id: { startsWith: p } },
      select: { id: true, mealPlanInstanceId: true, createdAt: true, _count: { select: { items: true } } },
    });
    console.log(`LIST ${p} → plan ${l?.mealPlanInstanceId?.slice(0, 8) ?? "?"}  rows=${l?._count.items}  ${l?.createdAt.toISOString().slice(0, 10)}`);
  }
}

main()
  .catch((e) => {
    console.error("FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
