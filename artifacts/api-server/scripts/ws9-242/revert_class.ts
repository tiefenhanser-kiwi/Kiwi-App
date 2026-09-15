// WS9 D-WS9-242 — restore Dish.componentRegistry from a derive_class.ts pre-image. Dry by default.
//
//   node --env-file=.env --import tsx scripts/ws9-242/revert_class.ts [--file <preimage.json>]            # dry: which rows would change
//   node --env-file=.env --import tsx scripts/ws9-242/revert_class.ts [--file <preimage.json>] --apply    # restore
//
// Without --file the newest scripts/output/ws9-242/preimage_*.json is used. Restores EXACTLY the
// dishes in the file to EXACTLY the registry recorded there; touches nothing else.
import { Prisma, PrismaClient } from "@prisma/client";
import { readdirSync, readFileSync } from "node:fs";

const OUT = "scripts/output/ws9-242";
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const fileIdx = argv.indexOf("--file");
const FILE = fileIdx >= 0 ? argv[fileIdx + 1] : `${OUT}/${readdirSync(OUT).filter((f) => f.startsWith("preimage_") && f.endsWith(".json")).sort().at(-1)}`;

const pre = JSON.parse(readFileSync(FILE, "utf8")) as { writtenAt: string; dishes: Record<string, unknown[]> };
const ids = Object.keys(pre.dishes);
const prisma = new PrismaClient();
console.log(`DB HOST = ${new URL(process.env.DATABASE_URL!).host} · pre-image ${FILE} (written ${pre.writtenAt}, ${ids.length} dishes) · mode ${APPLY ? "APPLY" : "DRY"}`);
const now = await prisma.dish.findMany({ where: { id: { in: ids } }, select: { id: true, componentRegistry: true } });
const nowMap = new Map(now.map((d) => [d.id, d.componentRegistry]));
const differ = ids.filter((id) => JSON.stringify(nowMap.get(id)) !== JSON.stringify(pre.dishes[id]));
const missing = ids.filter((id) => !nowMap.has(id));
console.log(`rows in DB: ${now.length}/${ids.length} · missing: ${missing.length} · would restore (registry differs from pre-image): ${differ.length} · already equal: ${ids.length - differ.length - missing.length}`);
for (const id of differ.slice(0, 5)) console.log(`  ${id}: now ${JSON.stringify(nowMap.get(id))?.slice(0, 160)} → pre ${JSON.stringify(pre.dishes[id]).slice(0, 160)}`);
if (!APPLY) { console.log("DRY — nothing written."); await prisma.$disconnect(); process.exit(0); }
let n = 0;
for (let i = 0; i < differ.length; i += 100) {
  const batch = differ.slice(i, i + 100);
  await prisma.$transaction(batch.map((id) => prisma.dish.update({ where: { id }, data: { componentRegistry: pre.dishes[id] as unknown as Prisma.InputJsonValue }, select: { id: true } })));
  n += batch.length;
}
const back = await prisma.dish.findMany({ where: { id: { in: differ } }, select: { id: true, componentRegistry: true } });
const bad = back.filter((d) => JSON.stringify(d.componentRegistry) !== JSON.stringify(pre.dishes[d.id])).length;
console.log(`restored ${n} · re-read mismatches ${bad}`);
await prisma.$disconnect();
process.exit(bad ? 1 : 0);
