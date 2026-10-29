// QA-COOK-1 — the sample: N meals from the dev catalog, chosen by a fixed seed
// and spread across five kinds of cooking (the brief's list).
//
//   bread       a tortilla, bread or flatbread is warmed, toasted or baked — and
//               ALWAYS the fajita meal ("Smoky Chipotle Chicken Fajitas with
//               Peppers and Warm Flour Tortillas", dev's public copy);
//   one-pan     one dish, or a one-pan / sheet-pan / one-pot / skillet meal;
//   stove+oven  at least one oven step and one stovetop step;
//   multi-dish  three or more dishes (a main and two sides), not the above;
//   feast       the Thanksgiving feasts — private prod-copies on dev (no public
//               template), forked for the run's account like QA-NIGHT-1's.
//
// Public, unarchived catalog meals only (feasts excepted); one per title. The
// pool is read in id order and shuffled by the seed, so a seed is one sample.
import type { PrismaClient } from "@prisma/client";

import { isOvenStep } from "../../src/lib/cookingScheduler";
import type { SampleCategory } from "./types";

export interface SampleMeal {
  id: string;
  title: string;
  category: SampleCategory;
  dishCount: number;
}

export const FAJITA_MEAL_ID = "24c07e6d-7d9d-44a3-b46c-47264c59726e";

/** The feast sources on dev (null-owner prod-copies), one per kind, in a fixed order. */
export const FEAST_SOURCES: { id: string; title: string }[] = [
  { id: "afb99193-0861-45ae-8aee-5fa8dc9d4794", title: "Classic Thanksgiving Dinner with All the Trimmings" },
  { id: "b597cdc6-690e-4ed3-87be-df508654919f", title: "Make-Ahead Thanksgiving Dinner" },
  { id: "4d543799-a411-4bda-9b31-ccaf130e6382", title: "Vegetarian Friendsgiving Dinner" },
  { id: "705343ed-1100-4c52-897f-c265ccc1ab4b", title: "Small Thanksgiving Dinner for Four" },
  { id: "c2aefa50-a9a4-42af-863b-a09fe227d194", title: "A New Twist Thanksgiving Dinner" },
];

/** How many of each, for a sample of 30 (scaled for other sizes, feasts capped at 5). */
export function quotas(total: number): Record<SampleCategory, number> {
  const feast = Math.min(5, Math.max(1, Math.round(total / 6)));
  const rest = total - feast;
  const bread = Math.round(rest * 0.24);
  const multi = Math.round(rest * 0.28);
  const oven = Math.round(rest * 0.24);
  return { feast, bread, "multi-dish": multi, "stove+oven": oven, "one-pan": rest - bread - multi - oven };
}

const BREAD = /\b(tortillas?|flatbreads?|naan|pitas?|breads?|garlic toast|toasts?|crostini|focaccia|biscuits?|rolls|buns|chapatis?|rotis?|arepas?|bruschetta|ciabatta|baguette|sourdough|cornbread)\b/i;
const NOT_BREAD = /bread ?crumbs?|panko|tortilla (soup|chips?)|tortilla-crusted|shortbread/i;
const WARMED = /\b(warm|toast|grill|char|heat|bake|griddle|crisp)\w*/i;
const ONE_PAN = /\b(sheet[- ]pan|one[- ]pan|one[- ]pot|skillet|stir[- ]fry|traybake|tray bake)\b/i;
const STOVE = /\b(skillet|saucepan|pot|wok|stovetop|griddle|dutch oven|over (?:low|medium|medium-low|medium-high|high) heat|simmer|boil|saut[eé])\w*/i;

/** Mulberry32: a small seeded PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(xs: readonly T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

interface PoolMeal {
  id: string;
  title: string;
  dishTitles: string[];
  steps: { phaseType: string; text: string }[];
}

export function categorize(m: PoolMeal): SampleCategory | null {
  const titles = [m.title, ...m.dishTitles].join(" | ");
  const breadDish = m.dishTitles.some((t) => BREAD.test(t) && !NOT_BREAD.test(t));
  const breadStep = m.steps.some((s) => BREAD.test(s.text) && !NOT_BREAD.test(s.text) && WARMED.test(s.text));
  if ((breadDish || (BREAD.test(m.title) && !NOT_BREAD.test(m.title))) && breadStep) return "bread";
  if (m.dishTitles.length === 1 || (m.dishTitles.length <= 2 && ONE_PAN.test(titles))) return "one-pan";
  const oven = m.steps.some((s) => isOvenStep({ phaseType: s.phaseType as never, text: s.text }));
  const stove = m.steps.some((s) => STOVE.test(s.text));
  if (oven && stove) return "stove+oven";
  if (m.dishTitles.length >= 3) return "multi-dish";
  return null;
}

export async function drawSample(prisma: PrismaClient, opts: { size: number; seed: number }): Promise<SampleMeal[]> {
  const meals = await prisma.meal.findMany({
    where: { isPublic: true, isArchived: false, NOT: { tags: { has: "thanksgiving-feast" } } },
    orderBy: { id: "asc" },
    select: { id: true, title: true, dishLinks: { orderBy: { positionIndex: "asc" }, select: { dish: { select: { id: true, title: true } } } } },
  });
  const dishIds = meals.flatMap((m) => m.dishLinks.map((l) => l.dish.id));
  const steps = await prisma.recipeInstructionStep.findMany({
    // NOT { pathKey: "bought" } would also drop every NULL (base) step in SQL.
    where: { ownerType: "dish", ownerId: { in: dishIds }, OR: [{ pathKey: null }, { pathKey: { not: "bought" } }] },
    select: { ownerId: true, phaseType: true, stepTextTranslated: true },
  });
  const byDish = new Map<string, { phaseType: string; text: string }[]>();
  for (const s of steps) {
    const list = byDish.get(s.ownerId) ?? [];
    list.push({ phaseType: s.phaseType, text: s.stepTextTranslated });
    byDish.set(s.ownerId, list);
  }
  const seen = new Set<string>();
  const pools: Record<SampleCategory, PoolMeal[]> = { bread: [], "one-pan": [], "stove+oven": [], "multi-dish": [], feast: [] };
  for (const m of meals) {
    const key = m.title.trim().toLowerCase();
    if (seen.has(key) || m.dishLinks.length === 0) continue;
    seen.add(key);
    const pm: PoolMeal = {
      id: m.id,
      title: m.title,
      dishTitles: m.dishLinks.map((l) => l.dish.title),
      steps: m.dishLinks.flatMap((l) => byDish.get(l.dish.id) ?? []),
    };
    if (pm.steps.length === 0) continue;
    const c = categorize(pm);
    if (c) pools[c].push(pm);
  }

  const q = quotas(opts.size);
  const rand = rng(opts.seed);
  const out: SampleMeal[] = [];
  const take = (c: SampleCategory, forced: PoolMeal[] = []) => {
    const picked = [...forced];
    for (const m of shuffle(pools[c], rand)) {
      if (picked.length >= q[c]) break;
      if (!picked.some((p) => p.id === m.id)) picked.push(m);
    }
    for (const m of picked) out.push({ id: m.id, title: m.title, category: c, dishCount: m.dishTitles.length });
  };
  const fajita = pools.bread.find((m) => m.id === FAJITA_MEAL_ID);
  if (!fajita) throw new Error(`the fajita meal ${FAJITA_MEAL_ID} is not in the bread pool (categorize changed?)`);
  take("bread", [fajita]);
  take("one-pan");
  take("stove+oven");
  take("multi-dish");
  for (const f of FEAST_SOURCES.slice(0, q.feast)) out.push({ id: f.id, title: f.title, category: "feast", dishCount: 0 });
  return out;
}
