// PREP-3 (R3, 3c) — THE WEEK'S CONTAINERS, LABELLED BY DISH, AT READ TIME.
//
// A label stays true when the week moves: "meal day assignments can change, moods change,
// people get busy" (Hans, Oct 23) — a jar taped "Tuesday sauce" lies once the fajitas move
// to Thursday. So a week's container is labelled the way Prep the feast labels one,
// <dish short name> <role>:
//   a dish's jar or mix       → "Skewers marinade", "Tso's sauce", "Meatballs dry mix"
//   a meal's plate            → its main dish's: "Skewers plate" (the Greek salad's piles too)
//   a cold mixture's bowl     → the dish itself: "Tzatziki", "Guacamole", "Pico"
//   a sauce dish's jar        → "Chipotle crema sauce"
//   a dish's own vegetables   → by its foods when the dish is one: "Broccoli & garlic"
//   a protein's package       → "Tso's chicken", "Steak"
//   a shared tub              → its food: "Minced garlic", "Lemon juice"
// Two dishes of one week that shorten alike are told apart by their meal ("Chicken
// skewers" / "Beef skewers"), never by a weekday. Prep the Week opens with "Label N
// containers: …", as Prep the feast does, in the week's order.
//
// 🔴 AT READ TIME, NEVER INTO THE NARRATION. The engine names containers by their meal and
// dish, the narrator uses those names verbatim, and `finishPrepWeek` puts these labels on
// every read: the stored model never carries a label.

import type { PrepWeekResult, PrepWeekStep } from "./ai/schemas/prepWeek";
import { destinationPhrase, type StepPlan } from "./prepWeekAssembly";
import { AROMATIC, foodOf, HERB, renamed, type FeastLabelKind, type FeastLabels } from "./prepFeastLabels";

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

// A dish name's words that say how it is made, not what it is.
const DESCRIPTOR = /^(?:crisp|crispy|seared|grilled|classic|simple|fresh|steamed|toasted|marinated|roasted|baked|chunky|homemade|easy|quick|creamy|spicy|smoky|sautéed|sauteed|braised|charred|glazed|crusted|broiled|poached|shaved|melted|warm|loaded|perfect|best|general|traditional|rustic|golden|tender|juicy|seasoned|velvety|the)$/i;
// …and the hyphenated ones ("Extra-Crispy", "Sheet-Pan", "Cumin-Spiced", "Taco Bell–Style").
const HYPHEN_DESCRIPTOR = /^(?:extra|sheet|stir|slow|one|pan|oven|air|deep)[-–]|[-–](?:crusted|spiced|glazed|roasted|fried|seared|style|simmered|marinated|sautéed|baked|cooker)$/i;
const CONNECTOR = /^(?:and|&|of)$/i;
// A head word every other dish shares: the word before it is the dish ("Caesar", "Taco").
const GENERIC_HEAD = /^(?:salad|filling|bowls?|sauce|dressing|breasts?|thighs?|fillets?|tenders|cutlets?|skillet|bake)$/i;
const MEAT = /^(?:chicken|pork|beef|turkey|lamb)$/i;
const FLAVOR = /^(?:lemon|lime|orange|pepper|garlic|butter|herb|honey|ginger|sesame|chili|chile|maple|mustard|balsamic|soy|miso|teriyaki|bbq|jerk|curry|hot)$/i;
// A word that names its dish only with the next ("Greek salad", "Italian sausage", "Meat sauce").
const WITH_HEAD = /^(?:greek|italian|thai|mexican|indian|cuban|chinese|japanese|korean|vietnamese|french|spanish|mediterranean|cajun|moroccan|asian|southern|cobb|chopped|garden|house|green|meat)$/i;
// A meat said with the word before it ("Ground beef", "Whole chicken").
const KEEP_MEAT = /^(?:ground|whole|stuffed|minced|shredded|pulled)$/i;
// A head that is said with the word before it ("Pork chops", "Jasmine rice", "Beef stew").
const PAIRED_HEAD = /^(?:potatoes|beans|bars|chops|peas|sprouts|greens|noodles|ribs|rice|wings|bites|strips|rolls?|mac|pie|soup|stew|chili|chowder|bread|tenderloin|thai)$/i;
// A dish that IS a sauce or a cold mixture: said with the word before it ("Chipotle crema").
const SAUCE_DISH = /^(?:crema|tzatziki|salsa|guacamole|aioli|pesto|chimichurri|vinaigrette|raita|hummus|slaw|relish|gremolata)$/i;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const isDescriptor = (x: string) => DESCRIPTOR.test(x) || HYPHEN_DESCRIPTOR.test(x);

/**
 * PREP-3 3c — a week dish's short name, 1–2 words, said on tape: "Lemon-Herb Marinated
 * Chicken Skewers" → "Skewers", "Extra-Crispy General Tso's Chicken" → "Tso's", "Crisp Caesar
 * Salad with Homemade Croutons" → "Caesar", "Greek Salad with Warm Pita" → "Greek salad",
 * "Chipotle Crema" → "Chipotle crema", "Cilantro-Lime Rice" → "Cilantro-lime rice",
 * "Classic Arroz con Pollo" → "Arroz con pollo", "Fresh Pico de Gallo" → "Pico".
 */
export function weekShortOf(title: string): string {
  if (/\bpico de gallo\b/i.test(title)) return "Pico";
  const base = title.split(/\s+(?:with|in|over)\s+|,\s*/i)[0];
  const raw = base.split(/\s+/).filter((x) => x && !isDescriptor(x));
  const w = raw.filter((x) => !/[-–]/.test(x));
  while (w.length > 1 && CONNECTOR.test(w[0])) w.shift();
  if (w.length === 0) return cap(raw.pop() ?? base.split(/\s+/).pop() ?? title);
  // A lone generic head keeps the hyphenated word that names it: "Cucumber-dill salad".
  if (w.length === 1 && (GENERIC_HEAD.test(w[0]) || PAIRED_HEAD.test(w[0]))) {
    const before = raw[raw.indexOf(w[0]) - 1];
    return cap(before ? `${before} ${w[0]}` : w[0]);
  }
  let head: string | undefined;
  while (w.length > 1 && (GENERIC_HEAD.test(w[w.length - 1]) || CONNECTOR.test(w[w.length - 1]))) {
    const x = w.pop()!;
    if (!head && GENERIC_HEAD.test(x)) head = x;
  }
  // A meat said last is the dish's only when nothing names it better: "Tso's Chicken" →
  // "Tso's", but "Butter chicken", "Lemon pepper" (chicken breasts), "Ground beef".
  if (w.length > 1 && MEAT.test(w[w.length - 1])) {
    const prior = w[w.length - 2];
    if (FLAVOR.test(prior)) return cap(w.length > 2 && FLAVOR.test(w[w.length - 3]) ? `${w[w.length - 3]} ${prior}` : `${prior} ${w[w.length - 1]}`);
    if (WITH_HEAD.test(prior) || KEEP_MEAT.test(prior)) return cap(`${prior} ${w[w.length - 1]}`);
    w.pop();
  }
  const last = w[w.length - 1];
  const prev = w.length > 1 ? w[w.length - 2] : undefined;
  if (head && WITH_HEAD.test(last)) return cap(`${last} ${head}`);
  if (prev && WITH_HEAD.test(prev)) return cap(`${prev} ${last}`);
  if (SAUCE_DISH.test(last)) return cap(prev && !CONNECTOR.test(prev) ? `${prev} ${last}` : last);
  if (prev && /^(?:con|de|al|alla|au|en)$/i.test(prev) && w.length > 2) return cap(`${w[w.length - 3]} ${prev} ${last}`);
  if (prev && CONNECTOR.test(prev) && w.length > 2) return cap(`${w[w.length - 3]} & ${last}`);
  if (prev && PAIRED_HEAD.test(last)) return cap(`${prev} ${last}`);
  return cap(last);
}

/**
 * The dish a meal's plate is labelled by: its main dish — of several, the one that names a
 * protein ("Grilled Chicken Breasts", not "Garlic Herb Rice"), else the first.
 */
export function mainDishOf<D extends { dishName: string; dishRole: string }>(dishes: readonly D[]): D | undefined {
  const mains = dishes.filter((d) => d.dishRole === "main");
  const pool = mains.length > 0 ? mains : dishes;
  return pool.find((d) => new RegExp(PROTEIN.source, "i").test(d.dishName)) ?? pool[0];
}

/** A dish's short name as Cook Mode compares it with a label (lower case). */
export function shortDish(title: string): string {
  return weekShortOf(title).toLowerCase();
}

/** "Minced garlic cloves — …" → "Minced garlic"; "Juiced lemon — …" → "Lemon juice". */
function tubFood(name: string): string {
  let food = name.split(" — ")[0].replace(/\([^)]*\)/g, "").replace(/\bfresh\s+/gi, "").replace(/\b(?:finely|thinly|roughly|coarsely)\s+/gi, "")
    .replace(/\s+(?:cloves?|stalks?|sprigs?|leaves|heads?)\b/gi, "").replace(/\s+/g, " ").trim();
  food = food.replace(/^juiced (.+)$/i, "$1 juice").replace(/^zested (.+)$/i, "$1 zest");
  return food.charAt(0).toUpperCase() + food.slice(1).toLowerCase();
}

interface Found { name: string; dishes: Set<string>; mealIds: Set<string>; members: Set<string> }

const PROTEIN = /\b(chicken|turkey|beef|steak|pork|lamb|veal|salmon|cod|tuna|halibut|tilapia|shrimp|scallops|fish|sausages?|kielbasa|andouille|chorizo|tofu|tempeh|duck|bacon|ham)\b/gi;
/** "boneless skinless chicken breasts" → "chicken", "skirt steak" → "steak", "chicken sausage" → "sausage". */
function proteinWord(name: string): string {
  return ([...name.matchAll(PROTEIN)].pop()?.[1] ?? name.split(/[,(]/)[0].trim().split(/\s+/).pop() ?? "protein").toLowerCase();
}

/**
 * Each container's label from the plan's own names (engine name → label). `mainDishByMealId`
 * names the dish a meal's plate is labelled by; the days only order the label step.
 */
export function weekLabelMap(
  plan: Pick<StepPlan, "steps">,
  dayNameByMealId: ReadonlyMap<string, string>,
  mainDishByMealId: ReadonlyMap<string, string> = new Map(),
  mealNameById: ReadonlyMap<string, string> = new Map(),
): { map: Map<string, string>; labels: FeastLabels; proteins: Map<string, Map<string, string>>; rank: Map<string, number> } {
  const found = new Map<string, Found>();
  const mealsOfDish = new Map<string, Set<string>>();
  for (const st of plan.steps) {
    if (st.demoted) continue;
    for (const c of st.components) {
      for (const m of c.measures) {
        if (m.forDish && m.mealId) mealsOfDish.set(m.forDish, (mealsOfDish.get(m.forDish) ?? new Set()).add(m.mealId));
        for (const name of [st.bowlName, m.destination]) {
          if (!name) continue;
          const f = found.get(name) ?? { name, dishes: new Set<string>(), mealIds: new Set<string>(), members: new Set<string>() };
          if (m.forDish) f.dishes.add(m.forDish);
          if (m.mealId) f.mealIds.add(m.mealId);
          f.members.add(c.ingredientName);
          found.set(name, f);
        }
      }
    }
  }
  const titles = new Set([...found.values()].flatMap((f) => [...f.dishes]));
  // "<dish> — its foods" is the dish's own container, even when the engine named it by the
  // dish's first words ("Classic Tomato-Vegetable Minestrone — medium zucchini and green beans"
  // for "… Minestrone with Ditalini"); "<food> — <dishes>" is a shared tub.
  const ownProduce = (f: Found) => {
    const [head, tail = ""] = f.name.split(" — ");
    return [...titles].some((t) => f.name.startsWith(`${t} — `))
      || (f.dishes.size === 1 && [...f.dishes].some((t) => t.startsWith(`${head} `)) && [...f.members].some((m) => tail.toLowerCase().includes(m.toLowerCase())));
  };
  const isShared = (f: Found) => / — /.test(f.name) && !ownProduce(f);
  const roleOf = (f: Found): Role | null => (/ — /.test(f.name) && !/ — herbs$/.test(f.name) ? "vegetables" : ROLE.find(([re]) => re.test(f.name.toLowerCase()))?.[1] ?? null);
  const plateMeal = (f: Found) => [...f.mealIds][0];
  const plateDish = (f: Found) => mainDishByMealId.get(plateMeal(f) ?? "") ?? [...f.dishes][0] ?? f.name;

  // The short name of every dish a label names, and two dishes that shorten alike told
  // apart by the word their meal says before it: "Chicken skewers" / "Beef skewers".
  const named = new Set<string>();
  for (const f of found.values()) if (!isShared(f)) named.add(roleOf(f) === "plate" || roleOf(f) === null ? plateDish(f) : ([...f.dishes][0] ?? f.name));
  for (const st of plan.steps) if (!st.demoted && st.phase === "proteins") for (const c of st.components) for (const m of c.measures) if (m.forDish) named.add(m.forDish);
  const shortOfTitle = new Map([...named].map((t) => [t, weekShortOf(t)]));
  const plain = new Map(shortOfTitle);
  const mealsOf = (d: string) => mealsOfDish.get(d) ?? new Set<string>();
  for (const [t, s] of plain) {
    const alike = [...plain].filter(([o, x]) => o !== t && x === s).map(([o]) => o);
    if (alike.length === 0) continue;
    // One meal's two dishes: the meal cannot tell them apart (a number does, below).
    if (alike.some((o) => [...mealsOf(o)].some((id) => mealsOf(t).has(id)))) continue;
    const meal = [...mealsOf(t)].map((id) => mealNameById.get(id)).find(Boolean) ?? t;
    const words = meal.split(/\s+/).filter((x) => !/[-–]/.test(x) && !isDescriptor(x));
    const head = s.split(" ").pop()!.toLowerCase().replace(/s$/, "");
    const at = words.findIndex((x) => x.toLowerCase().replace(/s$/, "") === head);
    const mine = new Set(s.toLowerCase().split(" "));
    const q = words.slice(0, Math.max(0, at)).reverse().find((x) => !CONNECTOR.test(x) && !/^(?:with|a|the)$/i.test(x) && !mine.has(x.toLowerCase())) ?? weekShortOf(meal);
    if (q.toLowerCase() !== s.toLowerCase()) shortOfTitle.set(t, cap(`${q} ${s}`));
  }
  const short = (t: string) => shortOfTitle.get(t) ?? weekShortOf(t);

  const map = new Map<string, string>();
  const kinds = new Map<string, FeastLabelKind>();
  for (const f of found.values()) {
    if (isShared(f)) {
      map.set(f.name, tubFood(f.name));
      kinds.set(map.get(f.name)!, "shared");
      continue;
    }
    const role = roleOf(f);
    let label: string;
    let kind: FeastLabelKind = "own";
    if (role === "plate" || role === null) { label = `${short(plateDish(f))} plate`; kind = "plate"; } else {
      const s = short([...f.dishes][0] ?? f.name);
      const own = (x: string) => x.includes(s.toLowerCase().slice(0, 6));
      const foods = [...new Set([...f.members].map((x) => foodOf(x).replace(/\s+florets$/, "")))].sort((a, b) => Number(own(b)) - Number(own(a)));
      const dish = [...f.dishes][0];
      // A side's bowl is the side ("Tzatziki"); a main dish's is its bowl ("Hummus bowl").
      // (A sauce dish's jar keeps its role: "Chipotle crema sauce". Named as the dish, Cook
      // Mode reads it as the dish being made and never says the jar.)
      if (role === "bowl") label = dish && [...f.mealIds].some((id) => mainDishByMealId.get(id) === dish) ? `${s} bowl` : s;
      // The feast's produce rule: herbs; a food that is the dish's own name says it, first
      // ("Broccoli & garlic"); aromatics; vegetables. (Not the feast's "<dish> <food> &
      // <food>": "Fajita strips bell pepper & green bell pepper" does not fit on tape.)
      else if (role === "vegetables") {
        label = foods.every((x) => HERB.test(x)) ? `${s} herbs`
          : foods.length <= 2 && foods.some(own) ? cap(foods.join(" & "))
          : foods.every((x) => HERB.test(x) || AROMATIC.test(x)) ? `${s} aromatics`
          : `${s} vegetables`;
      } else label = `${s} ${role}`;
      if (role === "marinade" || role === "sauce" || role === "spices" || role === "dry mix") kind = "mix";
    }
    map.set(f.name, label);
    kinds.set(label, kind);
  }
  // Two containers, one label (one dish's two sauce jars, a dish cooked twice): a number.
  const used = new Set<string>();
  for (const [old, label] of [...map]) {
    if (!used.has(label) || kinds.get(label) === "shared") { used.add(label); continue; }
    let n = 2;
    while (used.has(`${label} ${n}`)) n++;
    map.set(old, `${label} ${n}`);
    kinds.set(`${label} ${n}`, kinds.get(label) ?? "own");
    used.add(`${label} ${n}`);
  }

  // A protein stays in its own package, one per meal, labelled by its dish: "Skewers
  // chicken", "Tso's chicken" (the thighs trimmed for both go in two bags), "Steak".
  // stepKey → mealId → label.
  const proteins = new Map<string, Map<string, string>>();
  for (const st of plan.steps) {
    if (st.demoted || st.phase !== "proteins" || st.bowlName || st.cookDaySentence) continue;
    const byMeal = new Map<string, string>();
    for (const c of st.components) {
      for (const m of c.measures) {
        if (!m.mealId || m.destination) continue;
        const food = proteinWord(c.ingredientName);
        const s = m.forDish ? short(m.forDish) : "";
        let label = !s ? cap(food) : s.toLowerCase().includes(food) || food.includes(s.toLowerCase()) ? s : `${s} ${food}`;
        let n = 2;
        while (used.has(label) && byMeal.get(m.mealId) !== label) label = `${label.replace(/ \d+$/, "")} ${n++}`;
        used.add(label);
        byMeal.set(m.mealId, label);
      }
    }
    if (byMeal.size > 0) proteins.set(st.stepKey, byMeal);
  }

  // The label step's order: the week's, a meal's containers together, the shared tubs last.
  const dayIndex = (ids: Iterable<string>) => Math.min(7, ...[...ids].map((id) => WEEKDAYS.indexOf(dayNameByMealId.get(id) ?? "")).filter((i) => i >= 0));
  const rank = new Map<string, number>();
  const ordered: string[] = [];
  for (const st of plan.steps) {
    if (st.demoted) continue;
    for (const n of [st.bowlName, ...st.components.flatMap((c) => c.measures.map((m) => m.destination))]) {
      const l = n ? map.get(n) : undefined;
      if (!l || ordered.includes(l)) continue;
      ordered.push(l);
      rank.set(l, kinds.get(l) === "shared" ? 8 : dayIndex(found.get(n!)!.mealIds));
    }
  }
  for (const byMeal of proteins.values()) for (const [id, l] of byMeal) if (!rank.has(l)) rank.set(l, dayIndex([id]));
  ordered.sort((a, b) => (rank.get(a) ?? 8) - (rank.get(b) ?? 8));
  return { map, labels: { kinds, ordered }, proteins, rank };
}

/**
 * The served week with its containers labelled, and its "Label N containers" step first.
 * Only the labels of containers still on screen today are listed.
 */
export function labelWeekResult(result: PrepWeekResult, labels: { map: ReadonlyMap<string, string>; proteins?: ReadonlyMap<string, ReadonlyMap<string, string>>; labels?: FeastLabels; rank?: ReadonlyMap<string, number> }): PrepWeekResult {
  // PREP-3 3b — a shared tub is said by its label wherever a sentence names it: "for the
  // shared finely chopped fresh flat-leaf parsley tub" → "for the Chopped flat-leaf parsley
  // tub", "Into one shared lemon-juice tub:" → "Into the Lemon juice tub:".
  const tubs = [...labels.map].filter(([, l]) => labels.labels?.kinds.get(l) === "shared").flatMap(([name, l]): [string, string][] => {
    const words = destinationPhrase(name, "shared").first.replace(/^into the /, "");
    return [[`Into one ${words}`, `Into the ${l} tub`], [`The ${words}`, `The ${l} tub`], [`the ${words}`, `the ${l} tub`]];
  });
  const pairs = [...[...labels.map].filter(([a, b]) => a !== b), ...tubs].sort((x, y) => y[0].length - x[0].length);
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
  // In the week's order, then the shared tubs: the cook writes a meal's labels together.
  shown.sort((a, b) => (labels.rank?.get(a) ?? 8) - (labels.rank?.get(b) ?? 8));
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
  // PREP-3 3b — the labels are written first and are never skipped with the phase they
  // open (Dry ingredients is otherwise skippable): its phase is not skippable.
  phases[at] = { ...phase, skippable: false, steps: [step, ...phase.steps.map((s) => ({ ...s, number: s.number + 1 }))] };
  return { ...out, phases };
}
