// THX-3d round 2 (M) — A CUT HELD FOR COOK DAY IS A STEP ON THAT DAY (content, patch.ts).
//
// Prep the feast holds a cut that browns ("cut the Russet potatoes that morning"); that
// line lived only in a note under Prep the feast, and the dish's own steps began
// "Place 5 lb peeled, 2-inch potato chunks in a large pot". On the dish's day the cut is
// now its first step, in the row's own words ("On Thursday: Peel and cut 5 lb russet
// potatoes into 2-inch chunks"); how it waits, and the scheduler doing it in the morning,
// are src/lib/heldMorning's (Hans, Oct 22 — patch.ts item 16 puts them together).
// The holds are Prep the feast's own (buildFeastSession on the catalog meal, read-only).

import type { PrismaClient } from "@prisma/client";

import { HOLD_BOILED, HOLD_BROWNS, HOLD_OTHER, HOLD_OTHER_PLURAL, HOLD_TOSSED } from "../../src/lib/cookingScheduler";
import { loadPrepWeekInput } from "../../src/lib/prepWeekAggregation";
import { buildFeastSession } from "../../src/lib/prepWeekBuild";
import { readOnlyPrisma } from "./thx2Prep";

export const HELD_READ_AT = new Date("2026-11-22T15:00:00Z");
const WEEK_START = new Date("2026-11-23T00:00:00Z");

/** A held cut: the dish and the row (its day is the day the dish first uses the food). */
export interface HeldCut { dishId: string; ingredientName: string }

/**
 * Prep the feast's held cuts for a catalog feast meal (read-only build at its authored
 * servings, read the Sunday before): what heldLinesFor lists under "Held for cook day" —
 * a portion held by date, produce that browns once cut (demoted "does-not-hold"), and a
 * garnish rule 7 drops in a feast.
 */
export async function heldCutsOf(prisma: PrismaClient, mealId: string): Promise<HeldCut[]> {
  const meal = await prisma.meal.findUniqueOrThrow({
    where: { id: mealId },
    include: { dishLinks: { orderBy: { positionIndex: "asc" }, include: { dish: { include: { dishIngredients: { orderBy: { positionIndex: "asc" }, include: { ingredient: true } } } } } } },
  });
  const plan = { id: `thx-3d-held-${mealId}`, userId: "thx-3d-held", titleOverride: meal.title, startDate: WEEK_START, revisionId: 0, items: [{ id: "held", mealId, positionIndex: 0, assignedDayOfWeek: "Thursday", assignedDate: new Date("2026-11-26T00:00:00Z"), servingsOverride: null, meal }] };
  const load = await loadPrepWeekInput({ planId: plan.id, userId: plan.userId, prisma: readOnlyPrisma(prisma, plan), now: HELD_READ_AT });
  const build = buildFeastSession(load);
  if (!build) return [];
  const titleToId = new Map(meal.dishLinks.map((l) => [l.dish.title, l.dish.id]));
  const out: HeldCut[] = [];
  const add = (dishId: string | undefined | null, ingredientName: string) => {
    if (dishId && !out.some((x) => x.dishId === dishId && x.ingredientName === ingredientName)) out.push({ dishId, ingredientName });
  };
  for (const st of build.stepPlan.steps) {
    const h = build.holds.get(st.stepKey);
    if (h && st.phase !== "seasonings_dry" && st.phase !== "sauces_marinades") for (const p of h.heldPortions) add(p.dish ? titleToId.get(p.dish) : null, p.ingredientName);
    const why = st.demoted?.reason ?? "";
    if (why === "does-not-hold" || why.startsWith("rule 7")) {
      for (const c of st.components) for (const m of c.measures) add(m.dishId, c.ingredientName);
    }
  }
  return out;
}

// The cut's words and the already-cut test are the server's (the weeknight read path
// words a plan's held cuts the same way).
export { alreadyCut, cutSentence } from "../../src/lib/heldMorning";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * THX-3d 3b — a make-ahead day's cut without its hold line (Hans, Oct 23: the cut and the
 * pot are that day's work, back to back). "…; put them in a large pot, cover with cold
 * water, and leave the pot on the stove, off, until it's time to cook." → "…; put them in
 * a large pot and cover with cold water."; "…; keep them in cold water until it's time to
 * cook." and the others → the cut alone. Unchanged when the step holds nothing.
 */
export function unholdMakeAhead(text: string): string {
  const boiled = new RegExp(`, ([^,;]+), ${escape(HOLD_BOILED)}\\.`);
  if (boiled.test(text)) return text.replace(boiled, " and $1.");
  let out = text.replace(`, ${HOLD_BOILED}`, "");
  for (const hold of [HOLD_BROWNS, HOLD_TOSSED, HOLD_OTHER, HOLD_OTHER_PLURAL]) out = out.replace(new RegExp(`;\\s*${escape(hold)}\\.`), ".");
  return out;
}

const RUN_PREFIX = /^\s*(Make ahead \(([A-Za-z]+(?: night)?)\)|On ([A-Za-z]+day))\s*:\s*/i;

/**
 * Where a held cut goes in a dish's steps: the first step of the day-run in which the
 * dish first names the food, the prefix that step carries, and the run's texts (to test
 * whether it already cuts the food). Null when no step names it.
 */
export function heldCutPlace(steps: readonly { stepIndex: number; text: string }[], name: string): { at: number; prefix: string; firstText: string; runTexts: string[] } | null {
  const head = name.toLowerCase().split(/[,(]/)[0].trim().split(/\s+/).pop()!.replace(/(?:es|s)$/, "");
  const sorted = [...steps].sort((a, b) => a.stepIndex - b.stepIndex);
  let day = "";
  const dayOf = sorted.map((s) => {
    const m = RUN_PREFIX.exec(s.text);
    if (m) day = m[2] ?? m[3];
    return day;
  });
  const first = sorted.findIndex((s) => new RegExp(`\\b${head}`, "i").test(s.text));
  if (first < 0) return null;
  const runDay = dayOf[first];
  const runStart = dayOf.findIndex((d) => d === runDay);
  const run = sorted.filter((_, i) => dayOf[i] === runDay);
  return { at: sorted[runStart].stepIndex, prefix: RUN_PREFIX.exec(sorted[runStart].text)?.[0] ?? "", firstText: sorted[runStart].text, runTexts: run.map((s) => s.text) };
}
