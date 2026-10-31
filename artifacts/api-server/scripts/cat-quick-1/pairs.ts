// CAT-QUICK-1 E (D-WS9-363 phase 0) — cook once, eat twice, as data on both meals, no migration
// (Hans, Oct 30): the meal cooked first carries `pair:leads-to:<key>`, the follow-on carries
// `pair:leftover-of:<key>`, where <key> is the other meal's dishFamilyKey (its id when it has none).
// The client hides the `pair:` prefix in a later lane; until then the tags render as pills.
//
// The research's 16 pairs (kiwi_quick_meals_concepts.md §3), each endpoint a concept built here
// (`n`) or an existing catalog meal (`id` prefix). A pair whose meal was not built (dropped) is
// reported and skipped. Pairs the catalog cannot hold are listed in NOT_LINKED with the reason.
// Dev only; dry unless --apply; before-state to scripts/output/cat-quick-1/pairs-<stamp>.json.
//
//   node --env-file=.env --import tsx scripts/cat-quick-1/pairs.ts [--apply]
//   node --env-file=.env --import tsx scripts/cat-quick-1/pairs.ts --revert <file> [--apply]
import { PrismaClient } from "@prisma/client";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import { KEY_PREFIX } from "./targets";

type End = { n: number } | { id: string; note: string };
export const PAIRS: { research: number; from: End; to: End }[] = [
  { research: 1, from: { n: 24 }, to: { n: 12 } },
  { research: 2, from: { id: "bd57e0d7", note: "Classic Tex-Mex Sheet-Pan Chicken Fajitas" }, to: { n: 105 } },
  { research: 3, from: { id: "7728c5ee", note: "Chicken Tinga Rice Bowls" }, to: { n: 99 } },
  { research: 5, from: { id: "c07e5532", note: "km30 Smash Burger Tacos" }, to: { n: 84 } },
  { research: 5, from: { id: "c07e5532", note: "km30 Smash Burger Tacos" }, to: { id: "03d13a7b", note: "Classic Beef Chili Mac" } },
  { research: 7, from: { n: 42 }, to: { n: 44 } },
  { research: 7, from: { id: "9f74b96f", note: "Honey Garlic Salmon with Roasted Broccoli and Rice" }, to: { n: 44 } },
  { research: 9, from: { n: 114 }, to: { id: "a19ff990", note: "Garlic-Butter Shrimp Tacos with Cotija" } },
  { research: 10, from: { n: 1 }, to: { n: 57 } },
  { research: 10, from: { n: 1 }, to: { n: 101 } },
  { research: 12, from: { n: 78 }, to: { id: "8a388f57", note: "Spicy Three-Bean Chili Mac (vegetarian, as the chili is)" } },
  { research: 15, from: { n: 37 }, to: { n: 39 } },
];
export const NOT_LINKED: Record<number, string> = {
  4: "Korean ground beef → lettuce wraps / fried rice: the catalog's lettuce wraps and fried rice are chicken and shrimp; no beef follow-on",
  6: "egg roll in a bowl → next-day fried rice: no fried-rice concept that starts from it",
  8: "hot honey salmon → salmon tacos with slaw: no salmon-taco concept (#48 is white fish in foil)",
  11: "crispy chickpeas → harvest bowl / stuffed pitas: not concepts",
  13: "curried chickpeas / chana masala → stuffed sweet potatoes: no chickpea-stuffed sweet potato (the catalog's is black bean)",
  14: "rotisserie chicken → enchiladas / coq au vin / soup: the base is a store product, not a meal (#99 already starts from it)",
  16: "chicken pesto pasta / dense bean salad → lunches: not dinner concepts",
};

type Meal = { id: string; title: string; dishFamilyKey: string | null; tags: string[] };
async function resolve(prisma: PrismaClient, e: End): Promise<Meal | null> {
  const select = { id: true, title: true, dishFamilyKey: true, tags: true };
  if ("n" in e) return prisma.meal.findFirst({ where: { userId: null, isArchived: false, dishFamilyKey: { startsWith: `${KEY_PREFIX}${String(e.n).padStart(3, "0")}-` } }, select });
  return prisma.meal.findFirst({ where: { userId: null, isArchived: false, id: { startsWith: e.id } }, select });
}
const keyOf = (m: Meal) => m.dishFamilyKey ?? m.id;
const label = (e: End) => ("n" in e ? `#${e.n}` : `${e.id} ${e.note}`);

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const { host, mode } = assertScriptDatabase("cat-quick-1/pairs");
  if (mode !== "dev") throw new Error("dev only");
  const prisma = new PrismaClient();
  const revertIdx = argv.indexOf("--revert");
  if (revertIdx >= 0) {
    const before = JSON.parse(readFileSync(argv[revertIdx + 1], "utf8")) as { id: string; tags: string[] }[];
    for (const b of before) {
      console.log(`${apply ? "restored" : "would restore"} ${b.id} tags → [${b.tags.join(", ")}]`);
      if (apply) await prisma.meal.update({ where: { id: b.id }, data: { tags: b.tags } });
    }
    await prisma.$disconnect();
    return;
  }
  const add = new Map<string, { meal: Meal; tags: Set<string> }>();
  const linked: string[] = [];
  for (const p of PAIRS) {
    const [a, b] = [await resolve(prisma, p.from), await resolve(prisma, p.to)];
    if (!a || !b) { console.log(`  skip pair ${p.research}: ${label(p.from)} → ${label(p.to)} (${!a ? label(p.from) : label(p.to)} not in the catalog)`); continue; }
    for (const [m, t] of [[a, `pair:leads-to:${keyOf(b)}`], [b, `pair:leftover-of:${keyOf(a)}`]] as const) {
      const e = add.get(m.id) ?? { meal: m, tags: new Set<string>() };
      e.tags.add(t);
      add.set(m.id, e);
    }
    linked.push(`pair ${p.research}: ${a.title} → ${b.title}`);
  }
  for (const l of linked) console.log(`  ${l}`);
  for (const [n, why] of Object.entries(NOT_LINKED)) console.log(`  not linked ${n}: ${why}`);
  const changes = [...add.values()].filter((e) => [...e.tags].some((t) => !e.meal.tags.includes(t)));
  console.log(`database: ${host} (${mode}) · ${linked.length} links · ${changes.length} meals to tag · ${apply ? "APPLY" : "dry run"}`);
  if (apply && changes.length) {
    const file = join("scripts/output/cat-quick-1", `pairs-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify(changes.map((e) => ({ id: e.meal.id, tags: e.meal.tags })), null, 1));
    for (const e of changes) await prisma.meal.update({ where: { id: e.meal.id }, data: { tags: [...new Set([...e.meal.tags, ...e.tags])] } });
    console.log(`before-state: ${file}`);
  }
  await prisma.$disconnect();
}
if (process.argv[1]?.replace(/\\/g, "/").endsWith("cat-quick-1/pairs.ts")) main().catch((e) => { console.error(e); process.exit(1); });
