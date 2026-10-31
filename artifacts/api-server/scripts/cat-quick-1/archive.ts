// CAT-QUICK-1 — archive catalog meals (Meal.isArchived = true), dev only. Dry unless --apply.
// Used for the two exact duplicates Hans ruled on (BLT ×2, Reuben ×2) and for a km30 meal whose
// quick rebuild stamped ≤30. Writes the before-state to scripts/output/cat-quick-1/archive-<stamp>.json;
// --revert <file> puts each meal's isArchived back, only where it is still what this script set.
//
//   node --env-file=.env --import tsx scripts/cat-quick-1/archive.ts --ids <id,id> --why "<reason>" [--apply]
//   node --env-file=.env --import tsx scripts/cat-quick-1/archive.ts --revert <file> [--apply]
import { PrismaClient } from "@prisma/client";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";

const OUT = "scripts/output/cat-quick-1";
type Entry = { id: string; title: string; dishFamilyKey: string | null; wasArchived: boolean; why: string };

export async function archiveMeals(prisma: PrismaClient, ids: string[], why: string, apply: boolean): Promise<Entry[]> {
  const meals = await prisma.meal.findMany({ where: { id: { in: ids }, userId: null }, select: { id: true, title: true, dishFamilyKey: true, isArchived: true } });
  if (meals.length !== ids.length) throw new Error(`expected ${ids.length} catalog meals, found ${meals.length}: ${ids.filter((i) => !meals.some((m) => m.id === i)).join(",")}`);
  const entries = meals.map((m) => ({ id: m.id, title: m.title, dishFamilyKey: m.dishFamilyKey, wasArchived: m.isArchived, why }));
  if (apply) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `archive-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify(entries, null, 1));
    await prisma.meal.updateMany({ where: { id: { in: ids }, userId: null }, data: { isArchived: true } });
  }
  return entries;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const apply = argv.includes("--apply");
  const { host, mode } = assertScriptDatabase("cat-quick-1/archive");
  if (mode !== "dev") throw new Error("dev only");
  const prisma = new PrismaClient();
  const revert = arg("--revert");
  if (revert) {
    const entries = JSON.parse(readFileSync(revert, "utf8")) as Entry[];
    for (const e of entries) {
      const now = await prisma.meal.findUnique({ where: { id: e.id }, select: { isArchived: true } });
      const action = !now ? "gone" : now.isArchived && !e.wasArchived ? "restore" : "unchanged";
      console.log(`${action.padEnd(9)} ${e.id} ${e.title}`);
      if (apply && action === "restore") await prisma.meal.update({ where: { id: e.id }, data: { isArchived: false } });
    }
  } else {
    const ids = (arg("--ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const why = arg("--why") ?? "";
    if (!ids.length || !why) throw new Error("--ids <id,…> --why <reason>");
    for (const e of await archiveMeals(prisma, ids, why, apply)) console.log(`${apply ? "archived" : "would archive"} ${e.id} ${e.dishFamilyKey} "${e.title}" (was archived: ${e.wasArchived})`);
  }
  console.log(`database: ${host} (${mode}) · ${apply ? "APPLIED" : "dry run"}`);
  await prisma.$disconnect();
}
if (process.argv[1]?.replace(/\\/g, "/").endsWith("cat-quick-1/archive.ts")) main().catch((e) => { console.error(e); process.exit(1); });
