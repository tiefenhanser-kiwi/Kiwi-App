// THX-2G — make reviewed Thanksgiving meals PUBLIC (isPublic → true). NOT RUN BY
// THX-2G. It runs only after Hans's review of the review page AND after THX-2S
// deploys the everyday-shelf exclusion for the `thanksgiving` tag.
//
//   node --env-file=.env --import tsx scripts/thx2/approve.ts --all                 # dry run: what would flip
//   node --env-file=.env --import tsx scripts/thx2/approve.ts --keys <k,k,…>        # dry run, these keys
//   node --env-file=.env --import tsx scripts/thx2/approve.ts --all --apply         # flip
//
// REFUSES (exit 2) unless the code it runs with carries the shelf exclusion:
// src/lib/store/storeShortlist.ts must export EVERYDAY_SHELF_EXCLUDED_TAGS
// containing "thanksgiving" (thx2Core.SHELF_EXCLUSION_EXPORT — the contract
// THX-2S builds to). ⚠️ That proves the exclusion is in THIS checkout, not that
// the deployed server runs it: run approve only after the deploy is live.
// Also refuses any selected meal that has no image, no allergen stamp or no
// derived time — a public catalog meal needs all three.
import { PrismaClient } from "@prisma/client";

import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import { approveRefusal, KEY_PREFIX } from "./thx2Core";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const ALL = argv.includes("--all");
const keysIdx = argv.indexOf("--keys");
const KEYS = keysIdx >= 0 ? (argv[keysIdx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : null;

const { host, mode } = assertScriptDatabase("thx2/approve");
console.log(`database: ${host} (${mode})`);
if (ALL === Boolean(KEYS)) { console.error("pass exactly one of --all or --keys <k,k,…>"); process.exit(2); }

const shortlist = (await import("../../src/lib/store/storeShortlist")) as unknown as Record<string, unknown>;
const refusal = approveRefusal(shortlist);
if (refusal) { console.error(`🔴 REFUSING: ${refusal}`); process.exit(2); }
console.log("shelf exclusion: present in this checkout (confirm the deploy is live before --apply)");

const prisma = new PrismaClient();
const meals = await prisma.meal.findMany({
  where: { sourceType: "batch_generated", dishFamilyKey: KEYS ? { in: KEYS } : { startsWith: KEY_PREFIX } },
  select: { id: true, dishFamilyKey: true, title: true, isPublic: true, imageStatus: true, imageUrl: true, allergensStampedAt: true, activeTimeMinutes: true, tags: true },
  orderBy: { dishFamilyKey: "asc" },
});
if (KEYS) {
  const missing = KEYS.filter((k) => !meals.some((m) => m.dishFamilyKey === k));
  if (missing.length) { console.error(`🔴 REFUSING: not in the database: ${missing.join(", ")}`); await prisma.$disconnect(); process.exit(2); }
}
const unready = meals.filter((m) => String(m.imageStatus) !== "ready" || !m.imageUrl || m.allergensStampedAt === null || m.activeTimeMinutes === null || !m.tags.includes("thanksgiving"));
for (const m of meals) console.log(`  ${String(m.dishFamilyKey).padEnd(42)} public=${m.isPublic} image=${m.imageStatus} stamped=${m.allergensStampedAt ? "yes" : "NO"} active=${m.activeTimeMinutes ?? "NONE"} "${m.title.slice(0, 50)}"`);
if (unready.length) { console.error(`🔴 REFUSING: ${unready.length} meal(s) lack an image, a stamp, a derived time or the thanksgiving tag: ${unready.map((m) => m.dishFamilyKey).join(", ")}`); await prisma.$disconnect(); process.exit(2); }
const toFlip = meals.filter((m) => !m.isPublic);
console.log(`${meals.length} selected · ${toFlip.length} to flip public · ${meals.length - toFlip.length} already public`);
if (!APPLY) { console.log("DRY — nothing changed. Re-run with --apply."); await prisma.$disconnect(); process.exit(0); }
const res = await prisma.meal.updateMany({ where: { id: { in: toFlip.map((m) => m.id) }, isPublic: false }, data: { isPublic: true } });
console.log(`flipped ${res.count} meal(s) public`);
await prisma.$disconnect();
