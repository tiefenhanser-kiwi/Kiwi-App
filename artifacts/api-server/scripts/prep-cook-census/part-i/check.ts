// [prepcook] Part I — the checker for the rules Part A's check.ts never had:
// the H-rules on Prep the Week, Prep Selected Meals parity, and Cook Mode's
// prepped path / single-dish render. K-R1…K-R6 and P-R1…P-R6 still come from
// ../check.ts (run with --tag parti over the legacy records run.ts writes).
//
//   node --import tsx scripts/prep-cook-census/part-i/check.ts
//
// ⚠️ INDEPENDENT OF THE CODE UNDER TEST, like ../check.ts: nothing here imports
// prepWeekAssembly / prepStorage / prepClasses. It reads the saved JSON. Food
// classes come from Ingredient.category (data); the few word lists below are
// the checker's own and are written to match a SUBJECT, not a passing noun.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");

// ── shapes (as run.ts writes them; declared, not imported) ──────────────────
interface WStep {
  stepKey: string; phase: string; number: number; title: string; instructions: string; estimatedMinutes: number;
  storageNote: string | null; skipSuggested: boolean; rendered: boolean; holdsNoContainer: boolean;
  containerId: string | null; containerNames: string[]; contributesToMealIds: string[]; destinationLabels: string[];
}
interface Wire { status: number; error: string | null; containerCount: number | null; statedMinutes: number | null; serverTotal: number | null; phoneTotal: number | null; heldForCookDay: string[]; steps: WStep[] }
interface Measure { amount: string; forDish: string; destination?: string; preparationNote?: string }
interface EStep {
  stepKey: string; phase: string; isBlend: boolean; bowlName: string | null; containerId: string | null; closes: string[];
  demoted: string | null; daysUntilCook: number | null; holdsNoContainer: boolean; cookDaySentence: string | null;
  marinadeJoin: { marinates?: boolean; seafood?: boolean; acidic?: boolean; bowl: string } | null; estimatedMinutes: number;
  contributesToMealIds: string[]; components: { ingredientName: string; preparationNote: string | null; measures: Measure[] }[];
}
interface Ing { mealId: string; dishId: string; dishName: string; ingredientId: string; name: string; category: string | null; purchaseUnit: string | null; note: string | null; qty: number; unit: string }
interface CStep { stepIndex: number; text: string; componentKey: string | null; phaseType: string; ingredientIds: string[] }
interface Engine { steps: EStep[]; ingredients: Ing[]; componentSteps: Record<string, CStep[]>; lagByMealId: Record<string, number>; dayNameByMealId: Record<string, string>; containerExtras: Record<string, unknown> }
interface CookStep { sequenceIndex: number; dishId: string; dishTitle: string | null; startOffsetMinutes: number | null; estimatedMinutes: number; phaseType: string; isTimingSensitive: boolean; cue: string | null; text: string; isPrep: boolean }
interface Meal { mealId: string; mealTitle: string; dishCount: number; isMultiDish: boolean; sequenceTotalMinutes: number; cardTotalMinutes: number; derivedTotalMinutes: number | null; phoneFooterMinutes: number; steps: CookStep[]; phoneSteps: CookStep[]; componentSelections: unknown }
interface Rec {
  code: string; planId: string; mealCount: number; shapes: string[]; titleByMealId: Record<string, string>;
  dayByMealId: Record<string, { day: string | null }>;
  staleCache: null | { cacheHit: boolean; promptVersion: number | null; blobKeys: number; headKeys: number; missingFromBlob: string[]; extraInBlob: string[] };
  full: Wire; parity: null | { wireNotEngine: string[]; engineNotWire: string[] }; engineFull: Engine;
  subsetMealIds: string[]; subset: Wire; engineSubset: Engine | { error: string };
  subsetTick: { keysTicked: string[]; notInFull: string[]; isPrepped: Record<string, boolean>; requiredForSubsetMeals: string[]; uncovered: string[] };
  meals: Meal[]; cookErrors: string[];
  prepped: null | {
    mealId: string; mealTitle: string; isPreppedAfterRendered: boolean | null; isPreppedAfterAll: boolean | null;
    renderedKeysTicked: number; allKeysTicked: number;
    blockers: { stepKey: string; onWire: boolean; rendered: boolean; title: string | null; skipSuggested: boolean | null }[];
    prepStepsForMeal: { stepKey: string; title: string; rendered: boolean; phase: string; instructions: string }[];
    forcedPrepped: { recap: string[]; steps: { dishTitle: string | null; phaseType: string; isPrep: boolean; text: string }[]; footer: number };
    asServed: { gate: string; recapShown: boolean };
  };
}

const recs: Rec[] = readdirSync(OUT)
  .filter((f) => /^[0-9a-f]{8}\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(join(OUT, f), "utf8")));

// ── findings ────────────────────────────────────────────────────────────────
interface F { surface: string; rule: string; plan: string; where: string; text: string }
const found: F[] = [];
const denom: Record<string, number> = {};
const RULES: Record<string, string[]> = { prep: [], subset: [], cook: [] };
function rule(surface: "prep" | "subset" | "cook", id: string) { if (!RULES[surface].includes(id)) RULES[surface].push(id); denom[id] ??= 0; }
const hit = (surface: "prep" | "subset" | "cook", id: string, r: Rec, where: string, text: string) => { rule(surface, id); found.push({ surface, rule: id, plan: `${r.planId.slice(0, 8)} ${r.code}`, where, text }); };
const bump = (surface: "prep" | "subset" | "cook", id: string, n = 1) => { rule(surface, id); denom[id] += n; };
const q = (s: string, n = 160) => s.replace(/\s+/g, " ").trim().slice(0, n);

// ── checker-local knowledge ─────────────────────────────────────────────────
const PROTEIN_CAT = /^(protein|meat|poultry|seafood|fish)$/i;
const AROMATIC = /\b(garlic|ginger|shallots?|scallions?|green onions?|jalape[nñ]os?|serranos?|fresnos?|habaneros?|chil(?:e|i)s?|cilantro|parsley|basil|mint|dill|thyme|rosemary|oregano|sage|chives|lemongrass|lime|lemon|orange|zest|juice)\b/i;
const CITRUS = ["lemon", "lime", "orange", "grapefruit"];
const HEAT = /\b(bak\w*|roast\w*|grill\w*|boil\w*|simmer\w*|brais\w*|steam\w*|sear\w*|saut[eé]\w*|fry\w*|fried|cook\w*|smok\w*|broil\w*|poach\w*|toast\w*|melt\w*|preheat\w*|skillet|oven|heat\w*)\b/i;
// ⚠️ A SENTENCE THAT OPENS WITH THE VERB. The first version matched anywhere and
// found "Roast" in "Dry-Rubbed Roast Chicken dry mix" and "smoked" in a spice —
// the name-pattern-eats-a-noun lesson, in the detector this time.
const HEAT_ACTION_IN_PREP = /(?:^|[.\n:]\s*)(saut[eé]|sear|roast|bake|toast|simmer|boil|fry|grill|broil|melt|brown)\b/i;
const LEAFY_LABEL = /\b(greens|leaves|lettuce)\b/i;
const CUT_VEG = /\b(cabbage|carrots?|fennel)\b/i;
// Scallions are counted naturally ("2 scallions"); BUG-346e is the leafy herb with no unit.
const HERB = /(cilantro|parsley|basil|mint|dill|thyme|rosemary|chives|oregano|sage)/i;
const JAR = /^(jar|bottle|tube|can)$/i;

/** P protein · V cut vegetable · R aromatic produce (free to join anything but P) · A seasonings/liquids/dairy. */
type Cls = "P" | "V" | "R" | "A";
function clsOf(ing: Ing | undefined, name: string): Cls {
  if (ing && PROTEIN_CAT.test(ing.category ?? "")) return "P";
  // The aromatic NAME wins over the category: "garlic cloves" is filed Pantry on dev.
  if (AROMATIC.test(name) && !/\b(powder|ground|dried|seed)\b/i.test(name)) return "R";
  if (ing && /^produce$/i.test(ing.category ?? "")) return "V";
  return "A";
}
/** H7: a container never holds protein with anything, nor cut vegetables with seasonings/liquids. */
const impure = (cls: Set<Cls>) => (cls.has("P") && cls.size > 1) || (cls.has("V") && cls.has("A"));
const baseFood = (n: string) => n.toLowerCase().replace(/\b(fresh|juice|zest|wedges?|large|small|medium|whole)\b/g, " ").replace(/\s+/g, " ").trim();

// ── PREP THE WEEK ───────────────────────────────────────────────────────────
for (const r of recs) {
  const w = r.full;
  if (w.status !== 200) { hit("prep", "P0 route error", r, "full", `HTTP ${w.status}: ${w.error}`); continue; }
  const E = r.engineFull;
  const live = w.steps.filter((s) => s.rendered);
  const eByKey = new Map(E.steps.map((s) => [s.stepKey, s]));
  const ingBy = new Map<string, Ing>();
  for (const i of E.ingredients) ingBy.set(`${i.dishName}|${i.name}`, i);

  // containers: name → members, from the ENGINE's destinations on rendered steps
  const members = new Map<string, { name: string; dish: string; stepKey: string; phase: string; ing?: Ing }[]>();
  const order: string[] = []; // stepKeys in screen order
  for (const s of w.steps) order.push(s.stepKey);
  const renderedKeys = new Set(live.map((s) => s.stepKey));
  for (const es of E.steps) {
    if (!renderedKeys.has(es.stepKey) || es.holdsNoContainer) continue;
    for (const c of es.components) {
      for (const m of c.measures) {
        const name = m.destination ?? es.bowlName ?? `(own) ${c.ingredientName} — ${m.forDish}`;
        const l = members.get(name) ?? [];
        l.push({ name: c.ingredientName, dish: m.forDish, stepKey: es.stepKey, phase: es.phase, ing: ingBy.get(`${m.forDish}|${c.ingredientName}`) });
        members.set(name, l);
      }
    }
  }

  // P-R1 vessels, single-member containers, 10–15
  bump("prep", "P-R1 header outside 10–15");
  const n = w.containerCount ?? 0;
  if (n < 10 || n > 15) hit("prep", "P-R1 header outside 10–15", r, `${r.mealCount} meals`, `header ${n} containers · ${w.statedMinutes} min`);
  for (const [name, ms] of members) {
    bump("prep", "P-R1 single-member container");
    const distinct = new Set(ms.map((m) => `${m.name}|${m.dish}`));
    if (distinct.size === 1) hit("prep", "P-R1 single-member container", r, name, `holds only ${ms[0].name} (${ms[0].dish})`);
  }

  // class purity + two moments
  for (const [name, ms] of members) {
    if (name.startsWith("(own)")) continue;
    bump("prep", "H7 class mix in one container");
    const cls = new Set(ms.map((m) => clsOf(m.ing, m.name)));
    if (impure(cls)) hit("prep", "H7 class mix in one container", r, name, `classes ${[...cls].join("+")}: ${ms.map((m) => `${m.name}[${clsOf(m.ing, m.name)}]`).join(", ")}`);
    // moments: the first cook-side step (amountRefs) each member's ingredient enters
    const byDish = new Map<string, typeof ms>();
    for (const m of ms) { const l = byDish.get(m.dish) ?? []; l.push(m); byDish.set(m.dish, l); }
    for (const [dish, dm] of byDish) {
      const ing0 = dm.find((m) => m.ing)?.ing;
      if (!ing0 || dm.length < 2) continue;
      const cs = E.componentSteps[ing0.dishId] ?? [];
      const entry = (m: (typeof dm)[number]) => {
        if (!m.ing) return null;
        const s = cs.find((x) => x.ingredientIds.includes(m.ing!.ingredientId) && x.phaseType !== "prep");
        return s ?? null;
      };
      const ents = dm.map((m) => ({ m, s: entry(m) })).filter((x) => x.s);
      const idx = new Set(ents.map((x) => x.s!.stepIndex));
      bump("prep", "H7 two cooking moments in one container");
      if (idx.size > 1 && ents.some((x) => HEAT.test(x.s!.text))) {
        hit("prep", "H7 two cooking moments in one container", r, `${name}`, `${dish}: ${ents.map((x) => `${x.m.name}→step ${x.s!.stepIndex} "${q(x.s!.text, 50)}"`).join(" | ")}`);
      }
    }
  }

  // raw-mix rule only on no-heat dishes; cabbage/carrot/fennel are cut veg, not leafy
  for (const [name, ms] of members) {
    const veg = ms.filter((m) => clsOf(m.ing, m.name) === "V");
    if (veg.length < 2 || name.startsWith("(own)")) continue;
    const ing0 = veg.find((m) => m.ing)?.ing;
    if (!ing0) continue;
    const cs = E.componentSteps[ing0.dishId] ?? [];
    const dishHasHeat = cs.some((x) => x.phaseType === "cook" || (x.phaseType !== "prep" && HEAT.test(x.text)));
    // A shared tub of ONE food is not a raw mix. And a member enters at heat by its
    // amountRef OR by name in a non-prep heat step — "Add the diced onion and cook"
    // carries no amount, so amountRefs alone said "never heated" about every onion.
    if (new Set(veg.map((m) => baseFood(m.name))).size < 2) continue;
    const word = (n: string) => baseFood(n).split(" ").pop()!.replace(/(es|s)$/, "");
    const entersAtHeat = veg.some((m) => cs.some((x) => x.phaseType !== "prep" && HEAT.test(x.text) &&
      ((m.ing && x.ingredientIds.includes(m.ing.ingredientId)) || new RegExp(`\\b${word(m.name)}`, "i").test(x.text))));
    bump("prep", "H7.1 raw-mix grouping on a heated dish");
    if (dishHasHeat && !entersAtHeat) hit("prep", "H7.1 raw-mix grouping on a heated dish", r, name, `${ing0.dishName} has heat steps; members ${veg.map((m) => m.name).join(", ")} enter at no heat step`);
    bump("prep", "H7.1 cut veg in a leafy-greens container");
    if (LEAFY_LABEL.test(name) && veg.some((m) => CUT_VEG.test(m.name))) hit("prep", "H7.1 cut veg in a leafy-greens container", r, name, `members ${veg.map((m) => m.name).join(", ")}`);
  }

  // one food → one produce step; one citrus → one step
  const produceSteps = live.filter((s) => s.phase === "produce" && !s.holdsNoContainer);
  const foodSteps = new Map<string, Set<string>>();
  for (const s of produceSteps) {
    for (const c of eByKey.get(s.stepKey)?.components ?? []) {
      const f = baseFood(c.ingredientName);
      const set = foodSteps.get(f) ?? new Set<string>(); set.add(`${s.number}. ${s.title}`); foodSteps.set(f, set);
    }
  }
  for (const [f, set] of foodSteps) {
    bump("prep", "H6 one food in >1 produce step");
    if (set.size > 1) hit("prep", "H6 one food in >1 produce step", r, f, [...set].join(" ∥ "));
  }
  for (const fruit of CITRUS) {
    const re = new RegExp(`\\b${fruit}s?\\b(?!\\s+leaves)`, "i");
    const st = live.filter((s) => (eByKey.get(s.stepKey)?.components ?? []).some((c) => re.test(c.ingredientName)));
    if (st.length === 0) continue;
    bump("prep", "H7 one citrus in >1 step");
    if (st.length > 1) hit("prep", "H7 one citrus in >1 step", r, fruit, st.map((s) => `[${s.phase}] ${s.number}. ${s.title}`).join(" ∥ "));
  }

  // named containers; labels; duplicate lines; close exactly once on the last step
  for (const s of live) {
    if (s.holdsNoContainer) continue;
    bump("prep", "H6 portion without a named container");
    const t = s.instructions;
    const m = /their own (?:portion|tub|container)|same (?:tub|container|bowl)(?! labelled)|into a (?:small )?(?:tub|container|bowl)(?! labelled)[.,;]|\bseparate (?:tub|container)s?\b(?! labelled)/i.exec(t);
    if (m) hit("prep", "H6 portion without a named container", r, `${s.phase} ${s.number}. ${s.title}`, `"…${q(t.slice(Math.max(0, m.index - 40), m.index + 60))}…"`);
    bump("prep", "H6 '+N more' / truncated label");
    const lab = /labelled "([^"]*(?:\+\d+ more|…)[^"]*)"/.exec(t) ?? (s.containerNames.find((x) => /\+\d+ more|…/.test(x)) ? [null, s.containerNames.find((x) => /\+\d+ more|…/.test(x))!] : null);
    if (lab) hit("prep", "H6 '+N more' / truncated label", r, `${s.phase} ${s.number}. ${s.title}`, `"${lab[1]}"`);
    bump("prep", "H6 duplicate portion line in one step");
    const lines = t.split("\n").map((x) => x.trim()).filter((x) => /labelled|into the/i.test(x));
    const dup = lines.find((x, i) => lines.indexOf(x) !== i);
    if (dup) hit("prep", "H6 duplicate portion line in one step", r, `${s.phase} ${s.number}. ${s.title}`, `"${q(dup)}" printed twice`);
  }
  {
    const closers = new Map<string, string[]>();
    for (const es of E.steps) { if (!renderedKeys.has(es.stepKey)) continue; for (const c of es.closes) { const l = closers.get(c) ?? []; l.push(es.stepKey); closers.set(c, l); } }
    const lastToucher = new Map<string, string>();
    for (const k of order) { const es = eByKey.get(k); if (!es || !renderedKeys.has(k)) continue; for (const c of es.components) for (const m of c.measures) { const nme = m.destination ?? es.bowlName; if (nme) lastToucher.set(nme, k); } }
    for (const [nme, last] of lastToucher) {
      bump("prep", "H7 container not closed exactly once on its last step");
      const cl = closers.get(nme) ?? [];
      const title = (k: string) => { const s = w.steps.find((x) => x.stepKey === k); return s ? `${s.phase} ${s.number}. ${s.title}` : k; };
      if (cl.length !== 1) hit("prep", "H7 container not closed exactly once on its last step", r, nme, `closed by ${cl.length} steps${cl.length ? `: ${cl.map(title).join(" ∥ ")}` : ""}; last toucher ${title(last)}`);
      else if (cl[0] !== last) hit("prep", "H7 container not closed exactly once on its last step", r, nme, `closed on ${title(cl[0])} but last touched by ${title(last)}`);
    }
  }

  // no-work: heated steps never prep; single-item measures never prep; floors
  for (const s of live) {
    if (s.holdsNoContainer) continue;
    bump("prep", "H7 heat action inside a prep step");
    const m = HEAT_ACTION_IN_PREP.exec(`${s.title}. ${s.instructions}`);
    if (m && !/cook day|on the day|that (?:morning|night)|when you (?:cook|roast|bake)|after (?:baking|roasting|cooking)|goes? on after|before serving|garnish/i.test(s.instructions.slice(Math.max(0, m.index - 80), m.index + 80)) && !/\b(roasted|toasted|smoked|fried|baked|grilled|cooked)\b/i.test(m[0])) {
      hit("prep", "H7 heat action inside a prep step", r, `${s.phase} ${s.number}. ${s.title}`, `"…${q(s.instructions.slice(Math.max(0, m.index - 50), m.index + 70))}…"`);
    }
  }
  for (const [name, ms] of members) {
    if (name.startsWith("(own)")) continue;
    const phases = new Set(ms.map((m) => m.phase));
    const distinct = [...new Set(ms.map((m) => m.name))];
    const allA = ms.every((m) => clsOf(m.ing, m.name) === "A");
    if (phases.size === 1 && phases.has("seasonings_dry")) {
      bump("prep", "H7 dry blend under 3");
      // H7.1 ruled dried chiles their own bag.
      if (distinct.length < 3 && !/dried chiles?/i.test(name)) hit("prep", "H7 dry blend under 3", r, name, distinct.join(", "));
    } else if (allA && (phases.has("sauces_marinades") || /sauce|marinade|dressing|jar|bowl/i.test(name))) {
      bump("prep", "H7 wet mix under 3 (not a sitting pair)");
      const sits = /marinade|dressing|pickl|brine|quick-pickled/i.test(name) || Object.prototype.hasOwnProperty.call(E.containerExtras, name);
      if (distinct.length < 3 && !(distinct.length === 2 && sits)) hit("prep", "H7 wet mix under 3 (not a sitting pair)", r, name, distinct.join(", "));
    }
  }
  for (const s of live) {
    const es = eByKey.get(s.stepKey);
    if (!es || s.holdsNoContainer || s.phase === "proteins") continue;
    const portions = es.components.flatMap((c) => c.measures.map((m) => ({ c, m })));
    bump("prep", "H7 single-item measure as its own step");
    if (portions.length === 1 && !portions[0].m.destination && !es.bowlName && !/\b(dice|mince|chop|slice|shred|grate|zest|juice|peel|trim|cut|halve|quarter|julienne|pick|strip|chiffonade|seed|core|smash|crush|toast|pound|cube)\w*/i.test(`${s.title} ${portions[0].c.preparationNote ?? ""}`)) {
      hit("prep", "H7 single-item measure as its own step", r, `${s.phase} ${s.number}. ${s.title}`, `${portions[0].m.amount} ${portions[0].c.ingredientName}`);
    }
  }

  // dry phase holds only dry items
  for (const s of live.filter((x) => x.phase === "seasonings_dry")) {
    for (const c of eByKey.get(s.stepKey)?.components ?? []) {
      const dish = c.measures[0]?.forDish ?? "";
      const ing = ingBy.get(`${dish}|${c.ingredientName}`);
      bump("prep", "H7 wet/jarred item in the dry phase");
      if ((ing && JAR.test(ing.purchaseUnit ?? "")) || (/\b(sauce|oil|vinegar|paste|syrup|honey|juice|mustard|mayo|ketchup|broth|stock)\b/i.test(c.ingredientName) && !/\b(dry|dried|ground|powder)\b/i.test(c.ingredientName))) {
        hit("prep", "H7 wet/jarred item in the dry phase", r, `${s.number}. ${s.title}`, `${c.ingredientName} (purchaseUnit ${ing?.purchaseUnit ?? "null"}, category ${ing?.category ?? "?"})`);
      }
    }
  }

  // protein: named, demoted when > 2 days out, night-before line, held list
  const lagOf = (ids: string[]) => ids.map((id) => E.lagByMealId[id]).filter((x) => x !== undefined);
  for (const s of w.steps.filter((x) => x.phase === "proteins")) {
    const es = eByKey.get(s.stepKey);
    const lags = lagOf(s.contributesToMealIds);
    const max = lags.length ? Math.max(...lags) : null;
    const min = lags.length ? Math.min(...lags) : null;
    if (s.rendered) {
      bump("prep", "H3 protein step title does not name its dish");
      const dishes = (es?.components ?? []).flatMap((c) => c.measures.map((m) => m.forDish));
      if (!dishes.some((d) => s.title.toLowerCase().includes(d.toLowerCase().slice(0, 18))) && !s.contributesToMealIds.some((id) => s.title.includes((r.titleByMealId[id] ?? "").slice(0, 18)))) {
        hit("prep", "H3 protein step title does not name its dish", r, `${s.number}. ${s.title}`, `for ${[...new Set(dishes)].join(", ")}`);
      }
      bump("prep", "D-WS9-298 protein rendered > 2 days out");
      if (max !== null && max > 2) hit("prep", "D-WS9-298 protein rendered > 2 days out", r, `${s.number}. ${s.title}`, `lags ${lags.join(",")}`);
    } else {
      bump("prep", "D-WS9-298 protein held although a meal is ≤ 2 days out");
      if (min !== null && min <= 2 && max !== null && max > 2) hit("prep", "D-WS9-298 protein held although a meal is ≤ 2 days out", r, `${s.title}`, `lags ${s.contributesToMealIds.map((id) => `${(r.titleByMealId[id] ?? "").slice(0, 26)}=${E.lagByMealId[id]}`).join(", ")}`);
    }
    if (es?.marinadeJoin?.marinates && max !== null) {
      const bowl = es.marinadeJoin.bowl;
      const closers = w.steps.filter((x) => x.rendered && (eByKey.get(x.stepKey)?.closes ?? []).includes(bowl));
      const closeText = closers.map((x) => x.storageNote ?? "").join(" ");
      const note = s.storageNote ?? "";
      const both = `${note} ${closeText}`;
      const seafoodAcid = es.marinadeJoin.seafood && es.marinadeJoin.acidic;
      const dishes = [...new Set(es.components.flatMap((c) => c.measures.map((m) => m.forDish)))];
      const recipe = dishes.flatMap((d) => { const i = E.ingredients.find((x) => x.dishName === d); return i ? (E.componentSteps[i.dishId] ?? []) : []; }).map((x) => x.text).join(" ");
      const hoursCap = /up to (\d+) hours?/i.exec(recipe);
      bump("prep", "H7.1 marinade close points at a protein step not on screen");
      if (!s.rendered && /at the proteins step/i.test(closeText)) hit("prep", "H7.1 marinade close points at a protein step not on screen", r, bowl, `protein step "${s.title}" is render-omitted (${es.demoted ?? "overlay demotion"}); close reads "${q(closeText, 150)}"`);
      bump("prep", "H7.1 marinade timing contradicts the recipe or the day");
      if (seafoodAcid && /to marinate|marinate until/i.test(both)) hit("prep", "H7.1 marinade timing contradicts the recipe or the day", r, bowl, `seafood into an acidic marinade ahead: "${q(both, 150)}"`);
      else if (hoursCap && Number(hoursCap[1]) < 12 && /until cook day|night before|cook within 1 day/i.test(both)) hit("prep", "H7.1 marinade timing contradicts the recipe or the day", r, bowl, `recipe caps it at ${hoursCap[1]} h ("…${q(recipe.slice(Math.max(0, hoursCap.index - 60), hoursCap.index + 20), 90)}"); prep says "${q(closeText || note, 110)}"`);
      else if (max > 1 && !/night before/i.test(both)) hit("prep", "H7.1 marinade timing contradicts the recipe or the day", r, bowl, `cook day ${max} out, no "night before" line — close "${q(closeText, 120)}"`);
      else if (max > 1 && !/(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/i.test(both)) hit("prep", "H7.1 marinade timing contradicts the recipe or the day", r, bowl, `night-before line without a weekday: "${q(closeText, 120)}"`);
    }
  }
  for (const s of live) {
    bump("prep", "Storage: one note gives two different windows");
    const ws = [...(s.storageNote ?? "").matchAll(/up to (\d+) days?/gi)].map((m) => m[1]);
    if (new Set(ws).size > 1) hit("prep", "Storage: one note gives two different windows", r, `${s.phase} ${s.number}. ${s.title}`, `"${q(s.storageNote ?? "", 170)}"`);
  }
  const lateProtein = E.steps.some((s) => s.phase === "proteins" && s.daysUntilCook !== null && s.daysUntilCook > 2);
  if (lateProtein) {
    bump("prep", "D-WS9-301 heldForCookDay empty with a late protein");
    if (w.heldForCookDay.length === 0) hit("prep", "D-WS9-301 heldForCookDay empty with a late protein", r, "", "server phase carries no held list");
    bump("prep", "D-WS9-301 heldForCookDay stripped by the client schema");
    hit("prep", "D-WS9-301 heldForCookDay stripped by the client schema", r, "", `server sends ${w.heldForCookDay.length} line(s) — e.g. "${q(w.heldForCookDay[0] ?? "", 120)}" — kiwi/lib/api/cooking.ts PrepWeekPhaseSchema has no heldForCookDay, so Zod drops it`);
  }

  // storage class from identity; herb units; decimals
  for (const s of live) {
    if (s.phase === "proteins" || !s.storageNote) continue;
    const es = eByKey.get(s.stepKey);
    const anyProtein = (es?.components ?? []).some((c) => clsOf(ingBy.get(`${c.measures[0]?.forDish}|${c.ingredientName}`), c.ingredientName) === "P");
    bump("prep", "BUG-346a protein storage line on a non-protein step");
    if (!anyProtein && /\b(raw (?:meat|fish|chicken|poultry)|cook within (?:1|one|2|two) day)/i.test(s.storageNote)) hit("prep", "BUG-346a protein storage line on a non-protein step", r, `${s.phase} ${s.number}. ${s.title}`, `"${s.storageNote}"`);
  }
  for (const s of live) {
    bump("prep", "BUG-346e herb count without a unit");
    const m = new RegExp(`(?:^|[\\s(])(\\d+|[½¼¾⅓⅔⅛]|\\d+[½¼¾⅓⅔⅛])\\s+(?:fresh\\s+)?${HERB.source}\\b`, "i").exec(s.instructions);
    if (m) hit("prep", "BUG-346e herb count without a unit", r, `${s.phase} ${s.number}. ${s.title}`, `"…${q(s.instructions.slice(Math.max(0, m.index - 20), m.index + 40))}…"`);
    bump("prep", "P-R5 decimal quantity");
    const d = /(?<![\d.])(\d+\.\d+)(?!\d*\s*(?:°|inch|in\b|cm|%|oz\)|-inch))/.exec(`${s.title} ${s.instructions}`);
    if (d) hit("prep", "P-R5 decimal quantity", r, `${s.phase} ${s.number}. ${s.title}`, `"${d[1]}"`);
  }

  // minutes: header vs engine sum vs phone vs server
  {
    const engineSum = live.reduce((t, s) => t + (eByKey.get(s.stepKey)?.estimatedMinutes ?? 0), 0);
    bump("prep", "Minutes: header ≠ rounded engine sum of rendered steps");
    const roundedUp5 = Math.ceil(engineSum / 5) * 5;
    if (w.statedMinutes !== null && Math.abs(w.statedMinutes - engineSum) > 5) hit("prep", "Minutes: header ≠ rounded engine sum of rendered steps", r, "", `header ${w.statedMinutes} · engine Σ rendered ${engineSum} (→${roundedUp5}) · phone total ${w.phoneTotal} · server total ${w.serverTotal}`);
    bump("prep", "Minutes: three numbers disagree (header / phone / server)");
    if (new Set([w.statedMinutes, w.phoneTotal, w.serverTotal]).size === 3) hit("prep", "Minutes: three numbers disagree (header / phone / server)", r, "", `header ${w.statedMinutes} · phone ${w.phoneTotal} · server ${w.serverTotal}`);
    for (const s of live.filter((x) => x.phase === "produce")) {
      const es = eByKey.get(s.stepKey);
      if (!es || es.components.length !== 1) continue;
      const c = es.components[0];
      const total = c.measures.reduce((t, m) => { const x = /^(\d+)(?:\s*([½¼¾⅓⅔]))?\s*(cloves?|onions?|$|large|medium|small|yellow|white|red)/i.exec(m.amount); return t + (x ? Number(x[1]) + ({ "½": .5, "¼": .25, "¾": .75, "⅓": 1 / 3, "⅔": 2 / 3 }[x[2] ?? ""] ?? 0) : 0); }, 0);
      if (/^garlic$|garlic cloves?/i.test(c.ingredientName) && total > 0) {
        bump("prep", "Minutes: garlic vs ⅓ min/clove");
        const want = Math.max(1, Math.ceil(total / 3));
        if (Math.abs(s.estimatedMinutes - want) > 1) hit("prep", "Minutes: garlic vs ⅓ min/clove", r, `${s.number}. ${s.title}`, `${total} cloves → ${s.estimatedMinutes} min (⅓/clove ⇒ ${want})`);
      }
      if (/\bonions?\b/i.test(c.ingredientName) && !/green|spring|pearl|powder/i.test(c.ingredientName) && total > 0) {
        bump("prep", "Minutes: onion vs 2.5 min/onion");
        const want = Math.ceil(total * 2.5);
        if (Math.abs(s.estimatedMinutes - want) > 1) hit("prep", "Minutes: onion vs 2.5 min/onion", r, `${s.number}. ${s.title}`, `${total} onion(s) → ${s.estimatedMinutes} min (2.5/onion ⇒ ${want})`);
      }
    }
  }

  // bought paths: does prep ask for work a selected/default bought path removes?
  for (const m of r.meals) {
    if (!m.componentSelections) continue;
    bump("prep", "Bought path: per-plan selection ignored");
    const sel = m.componentSelections as Record<string, Record<string, string>>;
    const comps = Object.values(sel).flatMap((x) => Object.keys(x));
    const mine = live.filter((s) => s.contributesToMealIds.includes(m.mealId));
    const relevant = mine.filter((s) => comps.some((c) => new RegExp(c.split("-")[0].replace(/guac/, "avocado|guac|lime|cilantro|onion|jalape").replace(/slaw/, "cabbage|carrot|slaw"), "i").test(`${s.title} ${s.instructions}`)));
    hit("prep", "Bought path: per-plan selection ignored", r, m.mealTitle, `item selects ${JSON.stringify(sel).slice(0, 90)} — prep still shows ${relevant.length} step(s) for that component, e.g. ${relevant.slice(0, 2).map((s) => `"${s.number}. ${s.title}"`).join(", ") || "(none matched)"}`);
  }

  // cache staleness and wire/engine parity
  if (r.staleCache) {
    bump("prep", "Cache served a blob HEAD's engine would not write");
    if (r.staleCache.cacheHit && (r.staleCache.missingFromBlob.length || r.staleCache.extraInBlob.length)) {
      hit("prep", "Cache served a blob HEAD's engine would not write", r, `prompt v${r.staleCache.promptVersion}`, `cache HIT: blob ${r.staleCache.blobKeys} keys vs HEAD ${r.staleCache.headKeys}; ${r.staleCache.missingFromBlob.length} HEAD keys absent, ${r.staleCache.extraInBlob.length} stale — e.g. ${[...r.staleCache.extraInBlob.slice(0, 1), ...r.staleCache.missingFromBlob.slice(0, 1)].join(" / ")}`);
    }
  }
  if (r.parity) {
    bump("prep", "Wire stepKeys ≠ engine stepKeys");
    if (r.parity.wireNotEngine.length || r.parity.engineNotWire.length) hit("prep", "Wire stepKeys ≠ engine stepKeys", r, "", JSON.stringify(r.parity).slice(0, 160));
  }
}

// ── PREP SELECTED MEALS ─────────────────────────────────────────────────────
for (const r of recs) {
  if (r.subset.status !== 200) { if (r.full.status === 200) hit("subset", "S0 subset route error", r, "", `HTTP ${r.subset.status}: ${r.subset.error}`); continue; }
  if (r.full.status !== 200) continue;
  const sub = new Set(r.subsetMealIds);
  const fullBy = new Map(r.full.steps.map((s) => [s.stepKey, s]));
  const subLive = r.subset.steps.filter((s) => s.rendered && !s.holdsNoContainer);
  for (const s of subLive) {
    bump("subset", "S1 subset step not in the full plan");
    const f = fullBy.get(s.stepKey);
    if (!f) { hit("subset", "S1 subset step not in the full plan", r, `${s.phase} ${s.number}. ${s.title}`, `stepKey ${s.stepKey}`); continue; }
    bump("subset", "S2 container names differ from the full plan");
    const a = [...s.containerNames].sort().join(" | "), b = [...f.containerNames].filter((n) => true).sort().join(" | ");
    if (a !== b) hit("subset", "S2 container names differ from the full plan", r, `${s.phase} ${s.number}. ${s.title}`, `subset [${q(a, 110)}] vs full [${q(b, 110)}]`);
    bump("subset", "S3 unselected meal attributed in the subset");
    const foreign = s.contributesToMealIds.filter((id) => !sub.has(id));
    if (foreign.length) hit("subset", "S3 unselected meal attributed in the subset", r, s.title, foreign.map((id) => r.titleByMealId[id]).join(", "));
  }
  // quantities: per (stepKey, ingredient, dish) for the selected meals, engine vs engine
  if (!("error" in r.engineSubset)) {
    const subDishNames = new Set(r.engineSubset.ingredients.map((i) => i.dishName));
    const fullAmt = new Map<string, string>();
    for (const es of r.engineFull.steps) for (const c of es.components) for (const m of c.measures) if (subDishNames.has(m.forDish)) fullAmt.set(`${es.stepKey}|${c.ingredientName}|${m.forDish}`, m.amount);
    for (const es of r.engineSubset.steps) {
      if (es.demoted) continue;
      for (const c of es.components) for (const m of c.measures) {
        bump("subset", "S4a subset quantity ≠ the full plan's for the same dish");
        bump("subset", "S4b subset drops the unit the full plan prints");
        const k = `${es.stepKey}|${c.ingredientName}|${m.forDish}`;
        const fa = fullAmt.get(k);
        if (fa === undefined || fa === m.amount) continue;
        const num = (x: string) => x.replace(/[^\d½¼¾⅓⅔⅛⅜⅝⅞]/g, "");
        if (num(fa) !== num(m.amount)) hit("subset", "S4a subset quantity ≠ the full plan's for the same dish", r, `${c.ingredientName} for ${m.forDish}`, `subset ${m.amount} vs full ${fa}`);
        else hit("subset", "S4b subset drops the unit the full plan prints", r, `${c.ingredientName} for ${m.forDish}`, `subset "${m.amount}" vs full "${fa}"`);
      }
    }
  }
  bump("subset", "S5 subset ticks do not make the selected meals prepped");
  const notPrepped = Object.entries(r.subsetTick.isPrepped).filter(([, v]) => !v);
  if (notPrepped.length) hit("subset", "S5 subset ticks do not make the selected meals prepped", r, notPrepped.map(([k]) => r.titleByMealId[k]?.slice(0, 40)).join(" + "), `ticked ${r.subsetTick.keysTicked.length} rendered subset keys; ${r.subsetTick.uncovered.length} of ${r.subsetTick.requiredForSubsetMeals.length} required keys uncovered: ${r.subsetTick.uncovered.slice(0, 3).join(", ")}`);
}

// ── COOK MODE ───────────────────────────────────────────────────────────────
const COLD = /\b(slaw|pico|salsa|salad|guacamole|crema|raita|tzatziki|dressing|vinaigrette|dip|relish|sour cream|pickled)\b/i;
const isUnattended = (s: CookStep) => s.phaseType === "preheat" || s.phaseType === "rest" || s.phaseType === "hold" || (s.phaseType === "cook" && !s.isTimingSensitive);
for (const r of recs) {
  for (const m of r.meals) {
    // K-R6 footer = card, by render path (BUG-344)
    bump("cook", `K-R6 footer ≠ card (${m.isMultiDish ? "sequenced" : "flattened single-dish"})`);
    if (m.phoneFooterMinutes !== m.cardTotalMinutes) hit("cook", `K-R6 footer ≠ card (${m.isMultiDish ? "sequenced" : "flattened single-dish"})`, r, m.mealTitle, `footer ${m.phoneFooterMinutes} min vs card ${m.cardTotalMinutes} (scheduler ${m.sequenceTotalMinutes}, fresh derive ${m.derivedTotalMinutes})`);
    if (!m.isMultiDish) {
      bump("cook", "BUG-344 single-dish meal never sequenced");
      hit("cook", "BUG-344 single-dish meal never sequenced", r, m.mealTitle, `flattened: ${m.phoneSteps.length} steps, no offsets, no cues; the scheduler had ${m.steps.filter((s) => s.cue).length} cue(s) and a ${m.sequenceTotalMinutes}-min plan`);
      bump("cook", "D-WS7-152 single-dish shows a dish/meal label");
      const lab = m.phoneSteps.find((s) => s.dishTitle) ?? m.phoneSteps.find((s) => new RegExp(`\\bfor (?:the )?${m.mealTitle.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(s.text));
      if (lab) hit("cook", "D-WS7-152 single-dish shows a dish/meal label", r, m.mealTitle, `"${lab.dishTitle ?? q(lab.text)}"`);
    }
    // D-WS9-297 cold dish pulled forward into a passive window
    const byDish = new Map<string, CookStep[]>();
    for (const s of m.steps) { const l = byDish.get(s.dishId) ?? []; l.push(s); byDish.set(s.dishId, l); }
    for (const [, ds] of byDish) {
      const title = ds[0]?.dishTitle ?? "";
      if (!COLD.test(title) || ds.some((s) => s.startOffsetMinutes == null)) continue;
      const end = Math.max(...ds.map((s) => (s.startOffsetMinutes ?? 0) + s.estimatedMinutes));
      const start = Math.min(...ds.map((s) => s.startOffsetMinutes ?? 0));
      const host = m.steps.find((o) => o.dishId !== ds[0].dishId && isUnattended(o) && o.estimatedMinutes >= 10 && (o.startOffsetMinutes ?? 0) <= start && (o.startOffsetMinutes ?? 0) + o.estimatedMinutes > start);
      bump("cook", "D-WS9-297 cold dish pulled into a passive window (for Hans to rule)");
      if (host && end < -5) hit("cook", "D-WS9-297 cold dish pulled into a passive window (for Hans to rule)", r, `${m.mealTitle.slice(0, 40)} · ${title}`, `made T${start}..T${end} inside "${host.dishTitle}" ${host.phaseType} T${host.startOffsetMinutes}..T${(host.startOffsetMinutes ?? 0) + host.estimatedMinutes} — first step "${q(ds[0].text, 80)}"`);
    }
  }
  if (r.prepped) {
    const p = r.prepped;
    bump("cook", "Prepped path: ticking every rendered prep step leaves isPrepped false");
    if (p.isPreppedAfterRendered === false) hit("cook", "Prepped path: ticking every rendered prep step leaves isPrepped false", r, p.mealTitle, `${p.renderedKeysTicked} rendered keys ticked; blockers: ${p.blockers.map((b) => `${b.title ?? b.stepKey} (${b.onWire ? (b.rendered ? "rendered" : "render-omitted") : "not on the wire"})`).join("; ")}; after ticking all ${p.allKeysTicked} wire keys → ${p.isPreppedAfterAll}`);
    bump("cook", "Prepped path: recap is not built from the prep steps");
    const prepTitles = p.prepStepsForMeal.filter((s) => s.rendered).map((s) => s.title);
    hit("cook", "Prepped path: recap is not built from the prep steps", r, p.mealTitle, `recap = ${p.forcedPrepped.recap.length} cook-side phaseType=prep step text(s) (e.g. "${q(p.forcedPrepped.recap[0] ?? "(empty → 'Everything from your prep session.')", 90)}"); the plan's ${prepTitles.length} prep steps for it (e.g. "${prepTitles[0] ?? "-"}") are not read`);
    bump("cook", "Prepped path: cook steps that redo prep work after the filter");
    const redo = p.forcedPrepped.steps.find((s) => /^(finely |thinly |roughly )?(dice|mince|chop|slice|shred|grate|zest|juice|peel|trim|cut|halve|julienne)\b/i.test(s.text));
    if (redo) hit("cook", "Prepped path: cook steps that redo prep work after the filter", r, p.mealTitle, `${redo.phaseType} step kept: "${q(redo.text, 110)}"`);
    bump("cook", "Prepped path: kept cook steps that lost their quantity");
    const lost = p.forcedPrepped.steps.filter((s) => /\bthe (diced|minced|chopped|sliced|shredded|grated|prepared|reserved)\b/i.test(s.text) && !/\d|[½¼¾⅓⅔⅛]/.test(s.text));
    if (lost.length) hit("cook", "Prepped path: kept cook steps that lost their quantity", r, p.mealTitle, `${lost.length} step(s), e.g. "${q(lost[0].text, 100)}"`);
  }
}

// ── K-R5 by cause, from ../check.ts's own findings over the same corpus ─────
let kr5: string[] = [];
try {
  const legacy = JSON.parse(readFileSync(join(HERE, "..", "out", "parti__check.json"), "utf8")) as { findings: { rule: string; plan: string; where: string; detail: string }[] };
  const k = legacy.findings.filter((f) => f.rule === "K-R5");
  const cause = (d: string) => {
    const mv = /e\.g\. "([^:]+): (.*)"$/.exec(d)?.[2] ?? "";
    if (/^(serve|plate|top|garnish|spoon|divide|assemble|arrange|drizzle)/i.test(mv)) return "only serve/assemble work was left to move";
    if (/(slaw|salsa|pico|crema|guac|dressing|raita|tzatziki|salad)/i.test(d)) return "a cold dish was available but sat elsewhere";
    if (/rest/.test(d)) return "a rest window with knife work still waiting";
    if (/preheat/.test(d)) return "the preheat window";
    return "a cook window with startable prep of another dish";
  };
  const by = new Map<string, string[]>();
  for (const f of k) { const c = cause(f.detail); const l = by.get(c) ?? []; l.push(`[${f.where}] ${f.detail}`); by.set(c, l); }
  kr5 = [...by].map(([c, l]) => `  ${c}: ${l.length}\n${l.slice(0, 2).map((x) => `      • ${q(x, 260)}`).join("\n")}`);
} catch { kr5 = ["  (run ../check.ts --tag parti first)"]; }

// ── report ──────────────────────────────────────────────────────────────────
const L: string[] = [];
L.push(`PART I CHECKER — ${recs.length} plans · ${recs.reduce((t, r) => t + r.meals.length, 0)} meals · ${recs.reduce((t, r) => t + r.full.steps.length, 0)} full-plan prep steps · ${recs.reduce((t, r) => t + r.subset.steps.length, 0)} subset steps`);
for (const surface of ["prep", "subset", "cook"] as const) {
  L.push("", `═══ ${surface === "prep" ? "PREP THE WEEK" : surface === "subset" ? "PREP SELECTED MEALS" : "COOK MODE"} ═══`, "| rule | count | of | plans |", "|---|---|---|---|");
  for (const id of RULES[surface]) {
    const f = found.filter((x) => x.rule === id);
    L.push(`| ${id} | ${f.length} | ${denom[id] || "—"} | ${new Set(f.map((x) => x.plan)).size}/${recs.length} |`);
  }
  for (const id of RULES[surface]) {
    const f = found.filter((x) => x.rule === id);
    if (f.length === 0) continue;
    L.push("", `── ${id} — ${f.length}`);
    const seen = new Set<string>();
    const firsts = f.filter((x) => (seen.has(x.plan) ? false : (seen.add(x.plan), true)));
    const picks = [...firsts, ...f.filter((x) => !firsts.includes(x))].slice(0, 2);
    for (const x of picks) L.push(`  • ${x.plan} · ${x.where} — ${x.text}`);
  }
}
L.push("", "═══ K-R5 idle passive windows, by cause ═══", ...kr5);
const text = L.join("\n");
writeFileSync(join(OUT, "check.txt"), text);
writeFileSync(join(OUT, "check.json"), JSON.stringify({ denom, found }, null, 2));
console.log(text);
