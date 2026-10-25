// THX-3d round 3b (C1) — DEV ONLY: production's five feasts, from exportFeasts.ts's file,
// imported onto dev as COPIES so patch.ts can be proven against production's own content
// (dev's feasts are a different generation). Each copy is a new catalog meal tagged
// `thx2-prod-copy`, dishFamilyKey `prodcopy:<target key>` (not `thx2-…`, so revert.ts,
// generate.ts and every dev-feast lookup never see it); patch.ts --targets prod-copy
// addresses them.
//
//   node --env-file=.env --import tsx scripts/thx2/importFeastCopies.ts --in scripts/_scratch/thx-3d/prod-feasts.json
//
// Every id is derived from production's id (copyId), so a second run RESETS the copies in
// place to the file — meal and dish columns, every step, every dish ingredient (what
// patch.ts added goes) — and the ids stay the same: that is the proof's "restore".
// Ingredients are the shared catalog: each maps to dev's row by canonicalName; a name dev
// lacks is created from production's row. It REFUSES any database but dev.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { Prisma, PrismaClient } from "@prisma/client";

import { assertScriptDatabase, DEV_HOST_MARKER } from "../../src/lib/scripts/requireDatabaseHost";

export const PROD_COPY_TAG = "thx2-prod-copy";
export const prodCopyKey = (key: string) => `prodcopy:${key}`;

const argv = process.argv.slice(2);
const inIdx = argv.indexOf("--in");
const IN = inIdx >= 0 ? argv[inIdx + 1] : undefined;
if (!IN) { console.error("usage: importFeastCopies.ts --in <exportFeasts file>"); process.exit(2); }

const { host, mode } = assertScriptDatabase("thx2/importFeastCopies");
if (mode !== "dev" || !host.includes(DEV_HOST_MARKER)) {
  console.error(`refusing: importFeastCopies.ts is dev only (database ${host}, ${mode})`);
  process.exit(2);
}

/** A uuid-shaped id derived from production's — the same copy every run. */
function copyId(prodId: string): string {
  const h = createHash("sha256").update(`${PROD_COPY_TAG}:${prodId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** A nullable Json column: null must be written as DbNull. */
const json = (v: unknown) => (v === null || v === undefined ? Prisma.DbNull : (v as Prisma.InputJsonValue));

type Row = Record<string, any>;
const file = JSON.parse(readFileSync(IN, "utf8")) as { exportedAt: string; meals: Row[]; dishLinks: Row[]; dishes: Row[]; dishIngredients: Row[]; ingredients: Row[]; steps: Row[] };
console.log(`database: ${host} (dev) · file ${IN} exported ${file.exportedAt}`);

const prisma = new PrismaClient();

// Ingredients — production id → dev id.
const ingredientId = new Map<string, string>();
const created: string[] = [];
let differing = 0;
for (const ing of file.ingredients) {
  const dev = await prisma.ingredient.findUnique({ where: { canonicalName: ing.canonicalName } });
  if (dev) {
    ingredientId.set(ing.id, dev.id);
    const cols = ["defaultUnit", "category", "conversionRef", "purchaseUnit", "purchaseQuantity", "packYieldUnit", "packYieldPerPack"];
    if (cols.some((c) => JSON.stringify((dev as Row)[c]) !== JSON.stringify(ing[c]))) differing++;
    continue;
  }
  const taken = await prisma.ingredient.findUnique({ where: { id: ing.id }, select: { id: true } });
  const id = taken ? copyId(ing.id) : ing.id;
  await prisma.ingredient.create({ data: { ...ing, id, nutritionRefPerUnit: json(ing.nutritionRefPerUnit), conversionRef: json(ing.conversionRef) } as Prisma.IngredientUncheckedCreateInput });
  ingredientId.set(ing.id, id);
  created.push(ing.canonicalName);
}
console.log(`ingredients: ${file.ingredients.length} — ${file.ingredients.length - created.length} mapped by name (${differing} with other grocery columns on dev), ${created.length} created${created.length ? `: ${created.join(", ")}` : ""}`);

const mapRefs = (refs: unknown) =>
  Array.isArray(refs) ? refs.map((r: Row) => (r && typeof r === "object" && "ingredientId" in r ? { ...r, ingredientId: ingredientId.get(r.ingredientId) ?? r.ingredientId } : r)) : refs;

for (const m of file.meals) {
  const mealId = copyId(m.id);
  const links = file.dishLinks.filter((l) => l.mealId === m.id);
  const dishIds = links.map((l) => l.dishId);
  const existed = !!(await prisma.meal.findUnique({ where: { id: mealId }, select: { id: true } }));
  await prisma.$transaction(async (tx) => {
    const mealData = {
      ...m, id: mealId, dishFamilyKey: prodCopyKey(m.dishFamilyKey), tags: [...m.tags.filter((t: string) => t !== PROD_COPY_TAG), PROD_COPY_TAG],
      sourceStoreMealId: null, timesCooked: 0, lastUsedAt: null, likeCount: 0, saveCount: 0, useCount: 0, isPublic: false,
      allergenSources: json(m.allergenSources), createdAt: undefined, updatedAt: undefined,
    } as Prisma.MealUncheckedCreateInput;
    await tx.meal.upsert({ where: { id: mealId }, create: mealData, update: { ...mealData, id: undefined } as Prisma.MealUncheckedUpdateInput });
    for (const dishId of dishIds) {
      const d = file.dishes.find((x) => x.id === dishId)!;
      const id = copyId(d.id);
      const dishData = {
        ...d, id, timesCooked: 0, lastUsedAt: null, createdAt: undefined, updatedAt: undefined,
        substitutions: json(d.substitutions), componentRegistry: json(d.componentRegistry), componentSelections: json(d.componentSelections),
      } as Prisma.DishUncheckedCreateInput;
      await tx.dish.upsert({ where: { id }, create: dishData, update: { ...dishData, id: undefined } as Prisma.DishUncheckedUpdateInput });
      await tx.dishIngredient.deleteMany({ where: { dishId: id } });
      await tx.recipeInstructionStep.deleteMany({ where: { ownerType: "dish", ownerId: id } });
      await tx.dishIngredient.createMany({
        data: file.dishIngredients.filter((r) => r.dishId === d.id).map((r) => ({ ...r, id: copyId(r.id), dishId: id, ingredientId: ingredientId.get(r.ingredientId)! }) as Prisma.DishIngredientCreateManyInput),
      });
      await tx.recipeInstructionStep.createMany({
        data: file.steps.filter((s) => s.ownerType === "dish" && s.ownerId === d.id).map((s) => ({ ...s, id: copyId(s.id), ownerId: id, amountRefs: json(mapRefs(s.amountRefs)) }) as Prisma.RecipeInstructionStepCreateManyInput),
      });
    }
    for (const l of links) {
      const id = copyId(l.id);
      const data = { id, mealId, dishId: copyId(l.dishId), positionIndex: l.positionIndex, roleLabel: l.roleLabel };
      await tx.mealDishLink.upsert({ where: { id }, create: data, update: { positionIndex: l.positionIndex, roleLabel: l.roleLabel } });
    }
  }, { timeout: 60_000, maxWait: 20_000 });
  const steps = file.steps.filter((s) => dishIds.includes(s.ownerId)).length;
  const rows = file.dishIngredients.filter((r) => dishIds.includes(r.dishId)).length;
  console.log(`${existed ? "reset" : "+"} ${prodCopyKey(m.dishFamilyKey)} ${mealId} (production ${m.id}) · ${links.length} dishes · ${rows} rows · ${steps} steps`);
}
await prisma.$disconnect();
