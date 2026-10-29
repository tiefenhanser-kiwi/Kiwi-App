// QA-COOK-1 — what a step asks of the cook, read from its PROSE.
//
// The Sequencer decides who may overlap from two flags (cookingScheduler.ts
// isUnattended: a `cook` step that is not timing-sensitive is hands-free). A
// home cook reads the words. "Warm the tortillas one at a time for 20–30
// seconds per side" is phase `cook`, not timing-sensitive — hands-free to the
// Sequencer, both hands and full attention to the cook. This module is the
// cook's reading; the simulator compares it with the Sequencer's.
//
// Pure, deterministic, no AI. Every regex is a reading of real dev steps; the
// tests in sim.test.ts pin the ones the K-flags hang on.
import { isOvenStep, isUnattended } from "../../src/lib/cookingScheduler";
import type { ShownStep } from "./types";

/** What the step occupies the cook with. */
export type Attention =
  /** hands busy, no heat (knife, mixing, assembling) */
  | "hands"
  /** at the stove and cannot leave it: one at a time, searing, shimmering oil, stirring constantly */
  | "constant"
  /** at the stove, stirring now and then: a sauté, "stirring occasionally" — can't wander off for knife work */
  | "frequent"
  /** started and left: a simmer, a bake, a boil, a marinade, a rest */
  | "background";

export type Heat = "oven" | "stove" | "grill" | "appliance" | null;

export interface StepRead {
  heat: Heat;
  attention: Attention;
  /** True when the words say how much the cook is needed; false when attention is the fallback guess (phase and minutes). */
  proseAttention: boolean;
  /** A knife or board task, no heat. */
  knife: boolean;
  /** Normalised vessel the step works in: skillet, saucepan, pot, wok, griddle, sheet, dish… */
  vessel: string | null;
  /** "the same skillet", "the skillet you used": reuses a vessel. */
  sameVessel: boolean;
  ovenTempF: number | null;
  /** Ends with the food off the heat: transfer to a plate, remove from heat, drain, turn off. */
  offHeat: boolean;
  keepWarm: boolean;
  keepCold: boolean;
  /** "one at a time", "in batches": the minutes grow with the servings. */
  batchwise: boolean;
  serve: boolean;
  /** The Sequencer's own reading (isUnattended on phase + timing flag). */
  serverHandsFree: boolean;
}

const lc = (s: string) => s.toLowerCase();

export const KNIFE = /\b(chop|chopped|dice|diced|mince|minced|slice|sliced|cut|julienne|seed|seeded|halve|halved|quarter|quartered|peel|peeled|trim|trimmed|grate|grated|zest|zested|shred|shredded|crush|crushed|smash|core|cored|pit|pitted|tear|torn|snip|carve|carving|butterfly|cube|cubed)\b/i;
const MIXING = /\b(whisk|stir together|combine|mix|blend|toss|season|rub|coat|pat dry|measure|set out|arrange|spread|assemble|fill|roll|shape|form|brush|wrap|stack|squeeze|mash)\b/i;
const STOVE = /\b(skillet|frying pan|saucepan|sauce pan|pot|stockpot|dutch oven|wok|griddle|grill pan|burner|stovetop|stove|over (?:low|medium|medium-low|medium-high|high|moderate) heat|simmer\w*|boil\w*|saut[eé]\w*|sear\w*|fry|fries|frying|stir-?fr\w*|bring\b[^.]*\bto a boil)\b/i;
const GRILL = /\b(grill|grilling|grilled|grill grates)\b(?!\s+pan)/i;
const HEAT_VERB = /\b(heat\w*|cook\w*|simmer\w*|boil\w*|saut[eé]\w*|sear\w*|fry|fries|fried|frying|stir-?fr\w*|toast\w*|warm\w*|melt\w*|brown\w*|char\w*|reduc\w*|bring|blanch\w*|poach\w*|steam\w*|braise\w*|wilt\w*|caramel\w*|render\w*|scrambl\w*|grill\w*|burner on|turn on|over (?:low|medium|medium-low|medium-high|high|moderate) heat)\b/i;
const APPLIANCE = /\b(slow cooker|crock-?pot|pressure cooker|instant pot|rice cooker|air fryer|microwave)\b/i;
const OVEN = /\b(oven|bake|baking|roast|roasting|broil|broiling)\b/i;
const BROILER = /\b(broiler|broil|broiling)\b/i;

const CONSTANT = /\b(one at a time|a few at a time|in batches|in two batches|per side|seconds per side|stir(?:ring)? constantly|whisk(?:ing)? constantly|constantly|without stopping|sear|searing|flip|turn(?:ing)? (?:once|halfway|them|it|occasionally)|until shimmering|until (?:just )?smoking|until fragrant|stir-?fr\w*|toss(?:ing)? (?:often|frequently|constantly)|keep (?:it |them )?moving|watch(?:ing)? (?:it |them )?closely|careful not to (?:burn|scorch)|broil|broiling|30 seconds|\d+ seconds)\b/i;
const FREQUENT = /\b(stir(?:ring)? (?:occasionally|often|frequently|now and then)|stirring|saut[eé]\w*|fry|frying|until (?:softened|soft|tender|golden|browned|translucent|wilted|thickened|crisp|charred|reduced|caramelized)|cook,? stirring|cook until|toss\w*)\b/i;
const BACKGROUND_STOVE = /\b(simmer\w*|bring\b[^.]*\bto a (?:rolling )?boil|boil\w*|braise\w*|cover(?:ed)? and cook|cover and simmer|reduce (?:the )?heat to low|steam\w*|poach\w*|cook (?:the )?(?:pasta|rice|noodles|potatoes|orzo|quinoa|grains?))\b/i;
const PASSIVE = /\b(marinat\w*|let (?:it |them |the [a-z ]+ )?(?:sit|stand|rest|cool|soak|rise|drain)|rest(?:ing)? for|refrigerat\w*|chill\w*|soak\w*|set aside to (?:cool|rest)|cool (?:completely|slightly|for))\b/i;

const VESSELS: [RegExp, string][] = [
  [/\b(?:cast-iron |nonstick |large |medium |small |heavy |deep |wide |dry |\d+-inch )*(skillet|frying pan|fry pan|saut[eé] pan)\b/i, "skillet"],
  [/\bgrill pan\b/i, "grill-pan"],
  [/\bgriddle\b/i, "griddle"],
  [/\bwok\b/i, "wok"],
  [/\b(saucepan|sauce pan)\b/i, "saucepan"],
  [/\b(dutch oven|stockpot|stock pot|soup pot)\b/i, "pot"],
  [/\bpot\b/i, "pot"],
  [/\b(sheet pan|baking sheet|rimmed sheet|sheet tray)\b/i, "sheet"],
  [/\b(baking dish|casserole dish|9x13|9×13|gratin dish|pie dish|pie plate|loaf pan|cake pan)\b/i, "dish"],
  [/\b(roasting pan)\b/i, "roasting-pan"],
];

export const KEEP_WARM = /\b(keep\w* (?:it |them |everything |the [a-z -]+ )?warm|stay\w* warm|hold\w* warm|tent\w*|cover(?:ed)? (?:loosely )?with foil|wrap\w* (?:them |it |the [a-z ]+ )?(?:in|with) (?:a )?(?:clean )?(?:kitchen )?(?:towel|foil)|(?:warm|low) oven|lowest heat|over low heat until serving|until (?:ready to )?serv\w*|turn the oven off and leave|keep (?:it |them |the pot )?covered|leave (?:it |them )?covered|(?:let|leave) (?:it |them |the [a-z]+ )?(?:stand|sit|steam|rest),? covered|cover (?:the pot |the pan )?and let (?:it |them )?(?:stand|steam|sit|rest)|cover to keep|covered,? off the heat)\b/i;
/** A meal-wide keep-warm: the feast's "Turn the oven off and leave the sides inside, covered…". */
export const KEEP_ALL_WARM = /\bturn the oven off and leave the sides inside\b|\bkeep (?:the sides|everything) warm\b/i;
export const KEEP_COLD = /\b(refrigerat\w*|chill\w*|in the fridge|keep (?:it |them )?cold|cover and (?:refrigerate|chill)|on ice|press plastic wrap)\b/i;
const OFF_HEAT = /\b(transfer\w*|remove\w* (?:from|off) (?:the )?heat|off the heat|take (?:it |them |the [a-z ]+ )?off|turn off|drain\w*|set aside|to a plate|to a bowl|onto a plate|out of the (?:pan|skillet|pot|oven)|remove from the oven|take (?:it |them |the [a-z ]+ )?out)\b/i;
const SAME_VESSEL = /\b(?:the same (skillet|pan|pot|saucepan|wok|griddle|sheet|dish)|(?:skillet|pan|pot|wok) you used|wipe (?:out )?the (?:skillet|pan|pot|wok))\b/i;
export const SERVE = /\b(serve|serving|plate|platter|to the table|at the table)\b/i;
const BATCH = /\b(one at a time|a few at a time|in batches|in two batches|in 2 batches|working in batches)\b/i;

export function vesselOf(text: string): string | null {
  for (const [re, name] of VESSELS) if (re.test(text)) return name;
  return null;
}

export function ovenTempOf(text: string): number | null {
  // The oven's setting, not a thermometer's reading ("until it registers 165°F").
  for (const m of text.matchAll(/(\d{3})\s*(?:°\s*F?|degrees)/gi)) {
    const before = text.slice(Math.max(0, m.index! - 45), m.index!);
    if (/\b(register|registers|reaches|reach|internal|thermometer|reads)\b/i.test(before)) continue;
    const t = Number(m[1]);
    if (t >= 200 && t <= 550) return t;
  }
  return null;
}

export function readStep(s: Pick<ShownStep, "text" | "phaseType" | "estimatedMinutes" | "isTimingSensitive">): StepRead {
  const text = s.text;
  const phase = s.phaseType as never;
  // The Sequencer's oven reading, plus the broiler it does not name ("under the broiler").
  const oven = isOvenStep({ phaseType: phase, text }) || (s.phaseType === "preheat" && OVEN.test(text)) || ((s.phaseType === "cook" || s.phaseType === "preheat") && BROILER.test(text));
  const appliance = APPLIANCE.test(text);
  // A vessel alone is not heat ("put them in a large pot, cover with water"): a heat verb is.
  const grillFirst = GRILL.test(text) && !/\b(skillet|frying pan|saucepan|pot|wok|griddle|grill pan)\b/i.test(text);
  const stove = !oven && !appliance && !grillFirst && STOVE.test(text) && HEAT_VERB.test(text);
  const grill = !oven && !stove && GRILL.test(text) && HEAT_VERB.test(text);
  const heat: Heat = oven ? "oven" : appliance ? "appliance" : stove ? "stove" : grill ? "grill" : null;
  const knife = heat === null && KNIFE.test(text);
  let attention: Attention;
  // proseAttention: the words say the cook is needed (or not); false when the reading below is a guess.
  let proseAttention = true;
  if (s.phaseType === "rest" || s.phaseType === "hold") attention = "background";
  else if (heat === null) attention = PASSIVE.test(text) ? "background" : "hands";
  else if (heat === "oven") attention = BROILER.test(text) ? "constant" : "background";
  else if (heat === "appliance") attention = "background";
  else if (CONSTANT.test(text)) attention = "constant";
  else if (/\bstir(?:ring)? (?:often|frequently)\b/i.test(text)) attention = "frequent";
  // A long stove step (a braise, a stock, "until tender" over an hour) is started and left, whatever else it says.
  else if (s.estimatedMinutes >= 20) attention = "background";
  else if (BACKGROUND_STOVE.test(text) && !/\bstir(?:ring)? (?:often|frequently|constantly)\b/i.test(text)) attention = "background";
  else if (FREQUENT.test(text)) attention = "frequent";
  else if (s.phaseType === "preheat") attention = heat === "stove" ? "constant" : "background";
  else {
    attention = s.isTimingSensitive || s.estimatedMinutes <= 10 ? "frequent" : "background";
    proseAttention = false;
  }
  // A rest/marinate step that also slices and tosses has hands work up front (handled by the simulator's hands minutes).
  const same = SAME_VESSEL.exec(text);
  return {
    heat,
    attention,
    proseAttention,
    knife,
    vessel: vesselOf(text) ?? (same ? lc(same[1] ?? "skillet").replace("pan", "skillet") : null),
    sameVessel: !!same,
    ovenTempF: heat === "oven" ? ovenTempOf(text) : null,
    offHeat: OFF_HEAT.test(text),
    keepWarm: KEEP_WARM.test(text),
    keepCold: KEEP_COLD.test(text),
    batchwise: BATCH.test(text),
    serve: SERVE.test(text),
    serverHandsFree: isUnattended({ phaseType: phase, isTimingSensitive: s.isTimingSensitive }),
  };
}

/** Minutes of the cook's hands a step takes, and how long it runs in all, at these servings. */
export function stepMinutes(s: Pick<ShownStep, "text" | "phaseType" | "estimatedMinutes" | "isTimingSensitive">, r: StepRead, servingsRatio: number): { hands: number; total: number } {
  const est = Math.max(1, s.estimatedMinutes || 1);
  // One at a time / in batches: the authored minutes are for the authored servings.
  const total = r.batchwise ? Math.max(est * 0.5, est * servingsRatio) : est;
  if (r.attention !== "background") return { hands: total, total };
  // Started and left: a minute or two to set it going, more when the step also cuts or mixes.
  const setUp = r.heat === null ? (KNIFE.test(s.text) || MIXING.test(s.text) ? Math.min(4, Math.max(1, est * 0.3)) : 0) : Math.min(2, est);
  return { hands: setUp, total };
}

// ── what a step makes, sets aside, and refers back to ────────────────────────

const STOP = new Set(
  "chop chopped dice diced mince minced slice sliced peel peeled seed seeded halve halved trim trimmed about above add added adding after again all also along and another any around back bake baked baking before both bowl bring brown browned but cook cooked cooking cover covered cups cup cut dish divide each else everything evenly extra few fine finely for fresh from golden heat heated high hot inch into just large let lightly little low medium more minute minutes mix mixed mixture more must off once one onto other over pan pinch place plate pot remaining remove rest serve served serving set side sides skillet small some spoon still stir stirring the then they this through time top toss transfer turn two until use using very warm warmed well when while with your sheet oven water salt pepper black kosher olive oil tablespoon tablespoons teaspoon teaspoons pound pounds ounce ounces about half quarter whole aside seconds second per inside outside cooked cooking prepared reserved"
    .split(" "),
);

export function singular(w: string): string {
  return w.toLowerCase().replace(/(?:(?<=[sxz]|ch|sh)es|ies|s)$/, (m) => (m === "ies" ? "y" : "")).replace(/[^a-z-]/g, "");
}

/** The step's content nouns (singular, stop words out). */
export function contentWords(text: string): string[] {
  return [...new Set((lc(text).match(/[a-z][a-z-]{2,}/g) ?? []).map(singular).filter((w) => w.length >= 4 && !STOP.has(w)))];
}

export function mentions(text: string, words: readonly string[]): string | null {
  const own = new Set(contentWords(text));
  for (const w of words) if (own.has(w)) return w;
  return null;
}

/** "Transfer the peppers to a plate", "set the chicken aside", "reserve ½ cup sauce": the thing put aside. */
const SET_ASIDE_RES: RegExp[] = [
  /\b(?:transfer|move|remove)\s+(?:the\s+|them\s+|it\s+)?([a-z][a-z -]{1,40}?)\s+(?:to|onto)\s+(?:a\s+|the\s+)?(?:clean\s+|large\s+|paper[- ]towel[- ]lined\s+)?(?:plate|platter|bowl|paper towels?)\b/i,
  /\bset\s+(?:the\s+)?([a-z][a-z -]{1,40}?)\s+aside\b/i,
  /\breserve\s+(?:\S+\s+(?:cup|tablespoons?|teaspoons?)\s+(?:of\s+)?)?(?:the\s+)?([a-z][a-z -]{2,30}?)(?=[,.;]|\s+(?:for|and|to)\b|$)/i,
];
const IT_ASIDE = /\b(?:transfer|move|remove)\s+(?:it|them)\b|\bset\s+(?:it|them)?\s*aside\b|\bkeep (?:it|them) warm\b|\band set aside\b/i;

export interface AsideRead {
  /** The words that name it (for the pickup search). */
  words: string[];
  /** As written ("the peppers", or the step's subject when the text says "it"). */
  name: string;
}

export function setAsideOf(text: string): AsideRead | null {
  for (const re of SET_ASIDE_RES) {
    const m = re.exec(text);
    if (m) {
      const words = contentWords(m[1]);
      if (words.length) return { words, name: m[1].trim() };
    }
  }
  if (IT_ASIDE.test(text)) {
    // "…cook the bacon until crisp, then transfer it to paper towels": the step's own food.
    const words = contentWords(text.split(/,?\s*(?:then\s+)?(?:transfer|move|remove|set|and set|keep)\b/i)[0]);
    if (words.length) return { words: words.slice(0, 4), name: words.slice(0, 3).join(" ") };
  }
  return null;
}

/** "the reserved sauce", "the dressing you made", "the marinade": references back to a made thing. */
const MADE_THING = /\b(sauce|marinade|dressing|glaze|mixture|paste|rub|slurry|batter|spice mix|seasoning|vinaigrette|crema|compound butter|topping|filling|stock|broth|syrup|roux|gravy|pesto|salsa|aioli)\b/i;
const REF_RES: RegExp[] = [
  /\bthe ([a-z][a-z -]{2,30}?) (?:you|that you) (?:made|prepared|mixed|whisked|set aside|reserved|cooked)\b/gi,
  /\bthe reserved ([a-z][a-z -]{2,30}?)(?=[,.;]|\s+(?:and|to|into|over|on|with|in|back|for)\b)/gi,
];

export interface RefRead {
  phrase: string;
  head: string;
  explicit: boolean;
}

export function refsOf(text: string): RefRead[] {
  const out: RefRead[] = [];
  for (const re of REF_RES) {
    for (const m of text.matchAll(re)) {
      const words = contentWords(m[1]);
      if (words.length) out.push({ phrase: m[0], head: words[words.length - 1], explicit: true });
    }
  }
  return out;
}

/** True when a step makes a mixture (whisk/combine/stir together) or names one it makes. */
export function makesMixture(text: string): boolean {
  return /\b(whisk|stir together|combine|mix|blend|puree|purée|make the|prepare the|in a (?:small |medium |large )?bowl)\b/i.test(text) && (MADE_THING.test(text) || /\b(whisk|combine|stir together|mix)\b/i.test(text));
}

export { MADE_THING };

/** A coarse subject class for signatures: what kind of food the finding is about. */
export function subjectClass(text: string): string {
  const t = lc(text);
  if (/\b(tortillas?|flatbreads?|naan|pitas?|bread|toast|crostini|garlic bread|rolls?|buns?|biscuits?|focaccia|chapati|roti|arepas?|baguette|ciabatta|sourdough|cornbread)\b/.test(t) && !/bread ?crumbs?/.test(t)) return "bread";
  if (/\b(eggs?|omelet|frittata)\b/.test(t) && /\b(fry|fried|poach|scramble|sunny)/.test(t)) return "eggs";
  if (/\b(fries|fried|crispy|crisp|tempura|breaded|crust)\b/.test(t)) return "crisp";
  if (/\b(steak|chicken|pork|beef|lamb|salmon|fish|shrimp|tuna|cod|tofu|sausage|pork chops?|lamb chops?|thighs?|breasts?|meatballs?|turkey|bacon)\b/.test(t)) return "protein";
  if (/\b(pasta|noodles?|rice|orzo|quinoa|couscous|polenta|grits|risotto|potato\w*)\b/.test(t)) return "starch";
  if (/\b(lime|lemon|cilantro|parsley|herbs?|scallions?|green onions?|garnish|wedges?)\b/.test(t)) return "garnish";
  if (/\b(sauce|gravy|dressing|glaze|salsa|crema|aioli|pesto|vinaigrette)\b/.test(t)) return "sauce";
  if (/\b(salad|slaw|greens|lettuce|cucumber|avocado|guacamole)\b/.test(t)) return "salad";
  if (/\b(peppers?|onions?|broccoli|asparagus|beans?|carrots?|zucchini|spinach|mushrooms?|corn|vegetables?|veggies|squash|cauliflower|brussels)\b/.test(t)) return "veg";
  return "other";
}
