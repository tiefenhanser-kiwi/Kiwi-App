// CAT-Q0 — a shape probe of the catalog read (read-only): sizes, amountRefs
// coverage, unit vocabulary, featured templates.
//   node --env-file=.env --import tsx scripts/_scratch/cat-q0/probe.ts
import { PrismaClient } from "@prisma/client";

import { assertScriptDatabase } from "../../../src/lib/scripts/requireDatabaseHost";
import { loadCatalog, loadFeaturedMealIds } from "./catalogDb";

const { host, mode } = assertScriptDatabase("cat-q0/probe");
console.log(`database: ${host} (${mode})`);
const prisma = new PrismaClient();
const t0 = Date.now();
const meals = await loadCatalog(prisma);
const featured = await loadFeaturedMealIds(prisma);
await prisma.$disconnect();
console.log(`loaded ${meals.length} meals in ${Date.now() - t0} ms`);
const count = (f: (m: (typeof meals)[number]) => string) => {
  const c = new Map<string, number>();
  for (const m of meals) c.set(f(m), (c.get(f(m)) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]);
};
console.log("mealType", count((m) => m.mealType));
console.log("sourceType", count((m) => m.sourceType));
console.log("userId null?", count((m) => String(m.userId === null)));
console.log("thx tags", count((m) => m.tags.filter((t) => /thanksgiving|feast|leftover|holiday/i.test(t)).join(",") || "-"));
const dishes = meals.flatMap((m) => m.dishes);
const steps = dishes.flatMap((d) => d.steps);
console.log(`dishes ${dishes.length} · default-path steps ${steps.length} · with amountRefs ${steps.filter((s) => s.amountRefs.length).length}`);
console.log(`dishes with no steps ${dishes.filter((d) => d.allSteps.length === 0).length} · meals with null derived total ${meals.filter((m) => m.derived.totalMinutes == null).length}`);
const units = new Map<string, number>();
for (const d of dishes) for (const i of d.ingredients) units.set(i.unit, (units.get(i.unit) ?? 0) + 1);
console.log("units", [...units.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60));
console.log("stored vs derived total mismatch", meals.filter((m) => m.derived.totalMinutes != null && m.derived.totalMinutes !== m.estimatedTimeMinutes).length);
for (const f of featured) console.log(f.templateId, f.title, f.anchored ? "anchored" : "everyday", f.mealIds.length, "in catalog:", f.mealIds.filter((id) => meals.some((m) => m.id === id)).length);
const sample = meals[0];
console.log(JSON.stringify(sample.dishes[0].steps[0]), JSON.stringify(sample.dishes[0].ingredients[0]));
