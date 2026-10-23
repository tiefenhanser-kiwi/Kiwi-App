// PREP-3 (R3) — THE WEEK'S CONTAINERS, LABELLED BY DAY, AT READ TIME.
//
// A cook who forgets everything but the label in front of them needs the label to say
// when it is used. Prep the Week's containers get short labels by rule:
//   a meal's plate            → "Tuesday plate"
//   a dish's jar or mix       → "Monday marinade", "Wednesday sauce", "Tuesday spices",
//                               "Friday dry mix" — "<Day> <dish> <role>" when the day has
//                               two of the role ("Wednesday chicken sauce")
//   a cold mixture's bowl     → "Tuesday pico", "Monday tzatziki"
//   a shared tub              → its food: "Minced garlic", "Lemon juice"
// and Prep the Week opens with "Label N containers: …", as Prep the feast does.
//
// 🔴 AT READ TIME, NEVER INTO THE NARRATION. The narration is cached on the plan's
// composition (D-WS9-298) and a day is not part of it: a label with a day in it written
// into the cached prose would still say "Tuesday" after the tacos moved to Wednesday. So
// the engine names containers by their meal and dish, the narrator uses those names
// verbatim, and `finishPrepWeek` puts these labels on, from today's days, on every read.

import type { PrepWeekResult, PrepWeekStep } from "./ai/schemas/prepWeek";
import type { StepPlan } from "./prepWeekAssembly";
import { renamed, shortOf, type FeastLabelKind, type FeastLabels } from "./prepFeastLabels";

export const WEEK_LABEL_STEP_KEY = "week-labels";
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const ROLE = [
  [/ marinade bowl(?: \d+)?$/, "marinade"],
  [/ sauce jar(?: \d+)?$/, "sauce"],
  [/ spice blend(?: \d+)?$/, "spices"],
  [/ dry mix(?: \d+)?$/, "dry mix"],
  [/ citrus jar(?: \d+)?$/, "citrus"],
  [/ juice jar(?: \d+)?$/, "juice"],
  [/ dried-chile bag(?: \d+)?$/, "chiles"],
  [/ bowl(?: \d+)?$/, "bowl"],
  [/ (?:prep |toppings )?plate(?: \d+)?$/, "plate"],
  [/ (?:vegetables|aromatics|herbs)(?: \d+)?$/, "vegetables"],
] as const;
type Role = (typeof ROLE)[number][1];

/** A dish's short name, said on tape: "Fresh Pico de Gallo" → "pico", "Chunky Guacamole" → "guacamole". */
function shortDish(title: string): string {
  if (/\bpico de gallo\b/i.test(title)) return "pico";
  return shortOf(title).toLowerCase();
}

/** "Minced garlic cloves — …" → "Minced garlic"; "Juiced lemon — …" → "Lemon juice". */
function tubFood(name: string): string {
  let food = name.split(" — ")[0].replace(/\([^)]*\)/g, "").replace(/\bfresh\s+/gi, "").replace(/\b(?:finely|thinly|roughly|coarsely)\s+/gi, "")
    .replace(/\s+(?:cloves?|stalks?|sprigs?|leaves|heads?)\b/gi, "").replace(/\s+/g, " ").trim();
  food = food.replace(/^juiced (.+)$/i, "$1 juice").replace(/^zested (.+)$/i, "$1 zest");
  return food.charAt(0).toUpperCase() + food.slice(1).toLowerCase();
}

interface Found { name: string; dishes: Set<string>; mealIds: Set<string> }

const PROTEIN = /\b(chicken|turkey|beef|steak|pork|lamb|veal|salmon|cod|tuna|halibut|tilapia|shrimp|scallops|fish|sausages?|tofu|tempeh|duck|bacon|ham)\b/i;
/** "boneless skinless chicken breasts" → "chicken", "skirt steak" → "steak". */
function proteinWord(name: string): string {
  return (PROTEIN.exec(name)?.[1] ?? name.split(/[,(]/)[0].trim().split(/\s+/).pop() ?? "protein").toLowerCase();
}

/** Each container's label from the plan's own names and today's days (engine name → label). */
export function weekLabelMap(plan: Pick<StepPlan, "steps">, dayNameByMealId: ReadonlyMap<string, string>): { map: Map<string, string>; labels: FeastLabels; proteins: Map<string, Map<string, string>> } {
  // A protein stays in its own package, one per meal, labelled by its day: "Monday
  // chicken", "Wednesday chicken" (the thighs trimmed for both go in two bags).
  // stepKey → mealId → label.
  const proteins = new Map<string, Map<string, string>>();
  for (const st of plan.steps) {
    if (st.demoted || st.phase !== "proteins" || st.bowlName || st.cookDaySentence) continue;
    const byMeal = new Map<string, string>();
    for (const c of st.components) {
      for (const m of c.measures) {
        if (!m.mealId || m.destination) continue;
        const day = dayNameByMealId.get(m.mealId);
        const food = proteinWord(c.ingredientName);
        byMeal.set(m.mealId, day ? `${day} ${food}` : food.charAt(0).toUpperCase() + food.slice(1));
      }
    }
    if (byMeal.size > 0) proteins.set(st.stepKey, byMeal);
  }
  const found = new Map<string, Found>();
  for (const st of plan.steps) {
    if (st.demoted) continue;
    for (const c of st.components) {
      for (const m of c.measures) {
        for (const name of [st.bowlName, m.destination]) {
          if (!name) continue;
          const f = found.get(name) ?? { name, dishes: new Set<string>(), mealIds: new Set<string>() };
          if (m.forDish) f.dishes.add(m.forDish);
          if (m.mealId) f.mealIds.add(m.mealId);
          found.set(name, f);
        }
      }
    }
  }
  const titles = new Set([...found.values()].flatMap((f) => [...f.dishes]));
  const isShared = (f: Found) => / — /.test(f.name) && ![...titles].some((t) => f.name.startsWith(`${t} — `));
  const map = new Map<string, string>();
  const kinds = new Map<string, FeastLabelKind>();
  const dayOf = (f: Found): string | null => {
    const days = [...new Set([...f.mealIds].map((id) => dayNameByMealId.get(id)).filter((d): d is string => !!d))];
    return days.length === 1 ? days[0] : null;
  };
  const roleOf = (f: Found): Role | null => ROLE.find(([re]) => re.test(f.name))?.[1] ?? null;
  // How many containers of each role a day has, to say which one when there are two.
  const perDayRole = new Map<string, number>();
  for (const f of found.values()) {
    const r = roleOf(f);
    const d = dayOf(f);
    if (!r || !d || isShared(f)) continue;
    perDayRole.set(`${d}|${r}`, (perDayRole.get(`${d}|${r}`) ?? 0) + 1);
  }
  for (const f of found.values()) {
    if (isShared(f)) {
      map.set(f.name, tubFood(f.name));
      kinds.set(map.get(f.name)!, "shared");
      continue;
    }
    const role = roleOf(f);
    const day = dayOf(f);
    const short = shortDish([...f.dishes][0] ?? f.name);
    const lead = day ?? (short.charAt(0).toUpperCase() + short.slice(1));
    let label: string;
    if (role === "plate" || role === null) label = day ? `${day} plate` : `${lead} plate`;
    else if (role === "bowl") label = day ? `${day} ${short}` : `${lead} bowl`;
    else if (!day) label = `${lead} ${role}`;
    else label = (perDayRole.get(`${day}|${role}`) ?? 0) > 1 ? `${day} ${short} ${role}` : `${day} ${role}`;
    map.set(f.name, label);
    kinds.set(label, role === "plate" || role === null ? "plate" : role === "marinade" || role === "sauce" || role === "spices" || role === "dry mix" ? "mix" : "own");
  }
  // Two containers, one label (two plates of one day: a lunch and a dinner): the dish
  // says which, then a number.
  const used = new Map<string, string>();
  for (const [old, label] of [...map]) {
    if (!used.has(label)) { used.set(label, old); continue; }
    const f = found.get(old)!;
    let next = `${label.replace(/ plate$/, "")} ${shortDish([...f.dishes][0] ?? old)}${/ plate$/.test(label) ? " plate" : ""}`;
    let n = 2;
    while (used.has(next)) next = `${label} ${n++}`;
    map.set(old, next);
    kinds.set(next, kinds.get(label) ?? "own");
    used.set(next, old);
  }
  const ordered: string[] = [];
  for (const st of plan.steps) {
    if (st.demoted) continue;
    for (const n of [st.bowlName, ...st.components.flatMap((c) => c.measures.map((m) => m.destination))]) {
      const l = n ? map.get(n) : undefined;
      if (l && !ordered.includes(l)) ordered.push(l);
    }
  }
  return { map, labels: { kinds, ordered }, proteins };
}

/**
 * The served week with its containers labelled, and its "Label N containers" step first.
 * Only the labels of containers still on screen today are listed.
 */
export function labelWeekResult(result: PrepWeekResult, labels: { map: ReadonlyMap<string, string>; proteins?: ReadonlyMap<string, ReadonlyMap<string, string>> }): PrepWeekResult {
  const pairs = [...labels.map].filter(([a, b]) => a !== b).sort((x, y) => y[0].length - x[0].length);
  const renamedResult = renamed(result, pairs);
  // A protein step's packages, for the meals it is prepped for today.
  const out: PrepWeekResult = {
    ...renamedResult,
    phases: renamedResult.phases.map((ph) => ({
      ...ph,
      steps: ph.steps.map((s) => {
        const byMeal = labels.proteins?.get(s.stepKey);
        if (!byMeal || s.skipSuggested || s.containerNames?.length) return s;
        const names = [...new Set(s.contributesToMealIds.map((id) => byMeal.get(id)).filter((n): n is string => !!n))];
        return names.length > 0 ? { ...s, containerNames: names } : s;
      }),
    })),
  };
  const shown: string[] = [];
  for (const ph of out.phases) {
    for (const s of ph.steps) {
      if (s.skipSuggested || s.holdsNoContainer) continue;
      for (const n of s.containerNames ?? []) if (!shown.includes(n)) shown.push(n);
    }
  }
  // (The first phase with room: the wire holds 30 steps a phase.)
  // By day, Monday first, then the shared tubs: the cook writes a day's labels together.
  const dayIndex = (l: string) => { const i = WEEKDAYS.indexOf(l.split(" ")[0]); return i < 0 ? 7 : i; };
  shown.sort((a, b) => dayIndex(a) - dayIndex(b));
  const at = out.phases.findIndex((p) => p.steps.length > 0 && p.steps.length < 30);
  if (shown.length === 0 || at < 0) return out;
  const phase = out.phases[at];
  const meals = [...new Set(out.phases.flatMap((p) => p.steps.flatMap((s) => s.contributesToMealIds)))].slice(0, 20);
  const step: PrepWeekStep = {
    number: 1,
    stepKey: WEEK_LABEL_STEP_KEY,
    title: `Label ${shown.length} containers`,
    instructions: `Write these on tape, one per container: ${shown.join(" · ")}.`.slice(0, 800),
    estimatedMinutes: Math.max(1, Math.ceil(shown.length / 5)),
    contributesToMealIds: meals,
    holdsNoContainer: true,
  };
  const phases = [...out.phases];
  phases[at] = { ...phase, steps: [step, ...phase.steps.map((s) => ({ ...s, number: s.number + 1 }))] };
  return { ...out, phases };
}
