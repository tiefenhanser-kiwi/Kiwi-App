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

import { loadPrepWeekInput } from "../../src/lib/prepWeekAggregation";
import { buildFeastSession } from "../../src/lib/prepWeekBuild";
import { formatMeasure } from "../../src/lib/prepWeekAssembly";
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

const PARTICIPLES: Record<string, string> = {
  peeled: "peel", cut: "cut", sliced: "slice", diced: "dice", chopped: "chop", minced: "mince", cubed: "cube",
  halved: "halve", quartered: "quarter", trimmed: "trim", grated: "grate", scrubbed: "scrub", cored: "core", seeded: "seed",
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "5 pound russet potatoes, peeled and cut into 2-inch chunks" → "Peel and cut 5 lb russet potatoes into 2-inch chunks." Null when there is nothing to cut. How the cut waits is heldMorning's, by what comes next. */
export function cutSentence(row: { quantity: number; unit: string; name: string; note: string | null }): string | null {
  const note = (row.note ?? "").split(/,\s*(?:for|to)\b|\(/i)[0].trim().toLowerCase();
  const m = /^((?:(?:finely|thinly|roughly|coarsely)\s+)?[a-z]+(?:(?:,\s*|\s+and\s+)(?:(?:finely|thinly|roughly|coarsely)\s+)?[a-z]+)*)(.*)$/.exec(note);
  if (!m) return null;
  const words = m[1].split(/(?:,\s*|\s+and\s+)/);
  const verbs = words.map((w) => {
    const [adv, part] = /\s/.test(w) ? w.split(/\s+/) : ["", w];
    const v = PARTICIPLES[part];
    return v ? `${adv ? `${adv} ` : ""}${v}` : null;
  });
  if (verbs.length === 0 || verbs.some((v) => v === null)) return null;
  const list = verbs.length === 1 ? verbs[0]! : `${verbs.slice(0, -1).join(", ")} and ${verbs[verbs.length - 1]}`;
  const amount = formatMeasure(row.quantity, row.unit, row.name, { asWritten: true });
  const name = row.name.toLowerCase().split(/[,(]/)[0].trim();
  const rest = m[2].trim();
  return `${cap(list)} ${amount} ${name}${rest ? ` ${rest}` : ""}.`;
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

/** True when a step already cuts this food (a cut verb, then its head word, in one clause). */
export function alreadyCut(texts: readonly string[], name: string): boolean {
  const head = name.toLowerCase().split(/[,(]/)[0].trim().split(/\s+/).pop()!.replace(/(?:es|s)$/, "");
  return texts.some((t) => new RegExp(`\\b(?:peel|cut|slice|dice|chop|mince|grate|core|scrub|halve|quarter|trim|cube)\\b[^.;]{0,80}\\b${head}`, "i").test(t));
}
