// THX-2G (D-WS9-311 / D-WS9-313) — the pure rules of the Thanksgiving generation
// script. No database, no network: generate.ts, review.ts, approve.ts and the
// tests import from here.
//
// targets.json is the list (five feasts, sixteen alternates, five Friday meals).
// Each target becomes ONE runStoreFill call with the script-only options
// (storeFill.ts, THX-2G block), so every option is per-target by construction.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ALLERGEN_TOKENS } from "../../src/lib/allergens";
import type { GenProfile, StoreFillOptions } from "../../src/lib/storeFill";
import type { TargetDish } from "../../src/lib/storeFillDishes";

export const KEY_PREFIX = "thx2-";
/** D-WS9-311: a feast is ONE meal of up to 8 dishes. */
export const MAX_FEAST_DISHES = 8;
export const THANKSGIVING_TAG = "thanksgiving";
export const ALTERNATE_TAG = "thanksgiving-alternate";
export const COURSE_TAGS = [
  "course-turkey",
  "course-stuffing",
  "course-potatoes",
  "course-cranberry",
  "course-sides",
  "course-dessert",
] as const;
export type CourseTag = (typeof COURSE_TAGS)[number];
/** The generate schema's roles minus topping/optional. No dessert role exists:
 *  a pie rides as a `side`, positioned last (THX-2-0). */
export const ROLES = ["main", "side", "sauce", "base"] as const;
export type Role = (typeof ROLES)[number];
/** `weeknight`: the one Wednesday meal every plan shares (pizza night, D-WS9-313). */
export type Kind = "feast" | "alternate" | "friday" | "weeknight";
export const KINDS: readonly Kind[] = ["feast", "alternate", "friday", "weeknight"];
export type Difficulty = GenProfile["difficulty"];

/** A make-ahead day before Thanksgiving Thursday. */
export type AheadDay = "mon" | "tue" | "wed";
export const AHEAD_DAYS: readonly AheadDay[] = ["mon", "tue", "wed"];
const DAY_NAME: Record<AheadDay, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday" };
const DAY_INDEX: Record<AheadDay | "thu", number> = { mon: 1, tue: 2, wed: 3, thu: 4 };
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface DishSpec {
  name: string;
  role: Role;
  course?: CourseTag;
  /** Follow-up E (feast dishes only; the tag contract PREP-1 builds against):
   *  the day the dish, or its make-ahead part, is made → `ahead-<day>`. */
  ahead?: AheadDay;
  /** Whole days it keeps in the fridge once made → `keeps-<n>d`. */
  keeps?: number;
  /** Whole bird: days a frozen bird needs in the fridge → `thaw-<n>d`. */
  thaw?: number;
  /** Brined or dry-brined bird: the day it goes into the brine → `brine-<day>`. */
  brine?: AheadDay;
  /** What is made ahead, in the cook's words (reaches both briefs). */
  dayNote?: string;
}

/** The make-ahead dish tags, written by code from the fields above — never
 *  from model output. Order: ahead, keeps, thaw, brine. */
export function aheadTags(d: DishSpec): string[] {
  return [
    ...(d.ahead ? [`ahead-${d.ahead}`] : []),
    ...(d.keeps !== undefined ? [`keeps-${d.keeps}d`] : []),
    ...(d.thaw !== undefined ? [`thaw-${d.thaw}d`] : []),
    ...(d.brine ? [`brine-${d.brine}`] : []),
  ];
}

export interface Thx2Target {
  key: string;
  kind: Kind;
  plan?: string;
  title: string;
  cuisine: string;
  servings: number;
  difficulty: Difficulty;
  dishes: DishSpec[];
  /** Store-bought shortcut products (D-WS9-243 shortcut mode), keys of `products`. */
  products: string[];
  /** Friday: Thursday's leftovers, plain ingredients on the shortcut line. */
  leftovers?: string[];
  /** Follow-up C: the vegetarian rules (no rennet cheese, no Worcestershire…). */
  vegetarian?: boolean;
  note?: string;
}

export interface TargetsFile {
  keyPrefix: string;
  maxDishes: number;
  maxOutputTokens: number;
  spendCapUsd: number;
  /** product name → the allergen tokens it usually carries. */
  products: Record<string, string[]>;
  targets: Thx2Target[];
}

export const TARGETS_PATH = join(dirname(fileURLToPath(import.meta.url)), "targets.json");

export function loadTargets(path = TARGETS_PATH): TargetsFile {
  return JSON.parse(readFileSync(path, "utf8")) as TargetsFile;
}

// ── validation ───────────────────────────────────────────────────────────────

const KEY_RE = /^thx2-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "fancy"];

/** Every problem with the file, as one line each. Empty = valid. */
export function validateTargets(file: TargetsFile): string[] {
  const errs: string[] = [];
  if (file.keyPrefix !== KEY_PREFIX) errs.push(`keyPrefix must be "${KEY_PREFIX}" (got "${file.keyPrefix}")`);
  if (!Number.isInteger(file.maxDishes) || file.maxDishes < 1 || file.maxDishes > MAX_FEAST_DISHES) {
    errs.push(`maxDishes must be an integer 1–${MAX_FEAST_DISHES} (got ${file.maxDishes})`);
  }
  if (!(file.maxOutputTokens > 4096) || file.maxOutputTokens > 21000) {
    errs.push(`maxOutputTokens must be above 4,096 and at most 21,000 (the SDK's non-streaming ceiling is 21,333; got ${file.maxOutputTokens})`);
  }
  if (!(file.spendCapUsd > 0) || file.spendCapUsd > 15) errs.push(`spendCapUsd must be in (0, 15] (got ${file.spendCapUsd})`);
  for (const [product, tokens] of Object.entries(file.products ?? {})) {
    if (!Array.isArray(tokens) || tokens.length === 0) errs.push(`product "${product}": no usual allergens listed`);
    for (const t of tokens ?? []) if (!ALLERGEN_TOKENS.includes(t)) errs.push(`product "${product}": "${t}" is not an allergen token`);
  }
  if (!Array.isArray(file.targets) || file.targets.length === 0) {
    errs.push("targets: empty");
    return errs;
  }
  const seen = new Set<string>();
  for (const t of file.targets) {
    const at = `target ${t.key ?? "(no key)"}`;
    if (typeof t.key !== "string" || !KEY_RE.test(t.key)) errs.push(`${at}: key must match ${KEY_RE}`);
    else if (t.key.length > 120) errs.push(`${at}: key over 120 chars`);
    if (seen.has(t.key)) errs.push(`${at}: duplicate key`);
    seen.add(t.key);
    if (!KINDS.includes(t.kind)) errs.push(`${at}: kind "${t.kind}"`);
    if (!t.title?.trim()) errs.push(`${at}: no title`);
    if (!t.cuisine?.trim()) errs.push(`${at}: no cuisine`);
    if (!Number.isInteger(t.servings) || t.servings < 1 || t.servings > 30) errs.push(`${at}: servings must be an integer 1–30 (got ${t.servings})`);
    if (!DIFFICULTIES.includes(t.difficulty)) errs.push(`${at}: difficulty "${t.difficulty}"`);
    const dishes = Array.isArray(t.dishes) ? t.dishes : [];
    if (dishes.length < 1 || dishes.length > file.maxDishes) errs.push(`${at}: ${dishes.length} dishes (allowed 1–${file.maxDishes})`);
    const names = new Set<string>();
    for (const d of dishes) {
      if (!d.name?.trim()) errs.push(`${at}: a dish has no name`);
      if (names.has(d.name)) errs.push(`${at}: dish "${d.name}" twice`);
      names.add(d.name);
      if (!ROLES.includes(d.role)) errs.push(`${at}: dish "${d.name}" role "${d.role}"`);
      if (d.course !== undefined && !COURSE_TAGS.includes(d.course)) errs.push(`${at}: dish "${d.name}" course "${d.course}"`);
    }
    if (dishes.filter((d) => d.role === "main").length > 1) errs.push(`${at}: more than one main`);
    for (const p of t.products ?? []) if (!(p in (file.products ?? {}))) errs.push(`${at}: product "${p}" is not in the products table`);
    if (t.kind === "feast") {
      if (dishes.length < 2) errs.push(`${at}: a feast needs at least 2 dishes`);
      if (dishes[0]?.role !== "main") errs.push(`${at}: a feast's first dish must be the main`);
      if (t.servings !== 10 && t.servings !== 4) errs.push(`${at}: a feast is authored at 10 (or 4 for Small)`);
    }
    if (t.kind === "alternate") {
      if (dishes.length !== 1) errs.push(`${at}: an alternate is exactly one dish`);
      if (!dishes[0]?.course) errs.push(`${at}: an alternate needs its course tag`);
      if (t.servings !== 10) errs.push(`${at}: alternates are authored at 10`);
    }
    if ((t.kind === "friday" || t.kind === "weeknight") && t.servings !== 4) errs.push(`${at}: ${t.kind} meals are authored at 4 (the catalog default)`);
    if (t.kind === "weeknight" && !t.note?.trim()) errs.push(`${at}: a weeknight meal needs its brief in \`note\``);
    for (const d of dishes) {
      const has = d.ahead !== undefined || d.keeps !== undefined || d.thaw !== undefined || d.brine !== undefined;
      if (has && t.kind !== "feast") errs.push(`${at}: dish "${d.name}" — make-ahead fields belong on feast dishes only`);
      if (d.ahead !== undefined && !AHEAD_DAYS.includes(d.ahead)) errs.push(`${at}: dish "${d.name}" ahead "${d.ahead}"`);
      if (d.brine !== undefined && !AHEAD_DAYS.includes(d.brine)) errs.push(`${at}: dish "${d.name}" brine "${d.brine}"`);
      if ((d.ahead === undefined) !== (d.keeps === undefined)) errs.push(`${at}: dish "${d.name}" — ahead and keeps go together`);
      if (d.keeps !== undefined && (!Number.isInteger(d.keeps) || d.keeps < 1 || d.keeps > 14)) errs.push(`${at}: dish "${d.name}" keeps ${d.keeps}`);
      if (d.thaw !== undefined && (!Number.isInteger(d.thaw) || d.thaw < 1 || d.thaw > 7)) errs.push(`${at}: dish "${d.name}" thaw ${d.thaw}`);
      if ((d.thaw !== undefined || d.brine !== undefined) && d.role !== "main") errs.push(`${at}: dish "${d.name}" — thaw and brine belong on the bird`);
      if (d.dayNote && d.ahead === undefined && d.brine === undefined) errs.push(`${at}: dish "${d.name}" has a dayNote but no make-ahead day`);
    }
  }
  return errs;
}

// ── per-target run options ───────────────────────────────────────────────────

/** Follow-up E: the meal's ROLE in the week, the exact strings the Cookbook's
 *  seasonal chips key on (src/lib/cookbook/seasons.ts). Pizza night has none. */
export const FEAST_TAG = "thanksgiving-feast";
export const LEFTOVERS_TAG = "thanksgiving-leftovers";

export function mealTags(t: Thx2Target): string[] {
  if (t.kind === "alternate") return [THANKSGIVING_TAG, ALTERNATE_TAG, t.dishes[0].course as string];
  if (t.kind === "feast") return [THANKSGIVING_TAG, FEAST_TAG];
  if (t.kind === "friday") return [THANKSGIVING_TAG, LEFTOVERS_TAG];
  return [THANKSGIVING_TAG];
}

/**
 * Follow-up E: per generated dish, its make-ahead tags — matched to the target's
 * dish by TITLE (titleMatches), so a model that reorders the dishes cannot hand
 * the pie's tags to the gravy; position is the fallback only when no title
 * matches. Each target dish is used once.
 */
export function aheadTagsFor(t: Thx2Target): (dish: { title: string }, index: number) => string[] {
  const used = new Set<number>();
  return (dish, index) => {
    let at = t.dishes.findIndex((d, i) => !used.has(i) && titleMatches(d.name, dish.title));
    if (at < 0 && index < t.dishes.length && !used.has(index)) at = index;
    if (at < 0) return [];
    used.add(at);
    return aheadTags(t.dishes[at]);
  };
}

/** Make-ahead day lines for a feast, for both briefs. Empty when none. */
export function dayPlanLines(t: Thx2Target): string[] {
  const lines: string[] = [];
  t.dishes.forEach((d, i) => {
    if (d.ahead) {
      lines.push(`dishIndex ${i} ${d.name}: Make ahead (${DAY_NAME[d.ahead]}) — ${d.dayNote ?? "make it"}; it keeps up to ${d.keeps} day${d.keeps === 1 ? "" : "s"} in the fridge.`);
    }
    if (d.thaw !== undefined) {
      // The bird is needed on the earliest of its brine day and any giblet-stock day.
      const gibletDays = t.dishes.filter((x) => x.ahead && /giblet/i.test(x.dayNote ?? "")).map((x) => DAY_INDEX[x.ahead as AheadDay]);
      const needed = Math.min(DAY_INDEX.thu, ...(d.brine ? [DAY_INDEX[d.brine]] : []), ...gibletDays);
      const start = WEEKDAY[(((needed - d.thaw) % 7) + 7) % 7];
      lines.push(`dishIndex ${i} ${d.name}: a frozen bird needs about ${d.thaw} days in the fridge to thaw — move it there by ${start}${d.brine ? `; Make ahead (${DAY_NAME[d.brine]}): it goes into the brine` : ""}.`);
    }
  });
  return lines;
}

/** Dish.tags: only an alternate's dish, so the meal-edit browse lists exactly the
 *  alternates (five near-identical feast cranberry sauces would flood it). */
export function dishTags(t: Thx2Target): string[] {
  return t.kind === "alternate" ? mealTags(t) : [];
}

/** The shortcut line's products: store-bought products, then leftovers. */
export function shortcutFor(t: Thx2Target): string | undefined {
  const all = [...(t.products ?? []), ...(t.leftovers ?? [])];
  return all.length > 0 ? all.join("; ") : undefined;
}

function roleList(t: Thx2Target): string {
  return t.dishes.map((d, i) => `${i + 1}. ${d.name} (role ${d.role})`).join("; ");
}

export function composeBrief(t: Thx2Target): string {
  const parts: string[] = [];
  if (t.kind === "feast") {
    parts.push(
      `Thanksgiving dinner for ${t.servings}: ONE meal of ${t.dishes.length} dishes, the whole holiday table, cuisine ${t.cuisine}. Dishes and roles, in this order: ${roleList(t)}.`,
      `There is no dessert role, so the dessert is a side, positioned last.`,
      `Size every dish for ${t.servings} people at a holiday table, where each plate carries a little of every dish: quantities a real host would buy for this crowd, not ${t.servings} full dinner portions of each dish. Macros are per serving of each dish at that size.`,
    );
    const plan = dayPlanLines(t);
    if (plan.length > 0) parts.push(`Make-ahead plan for this feast (Thanksgiving is Thursday); the ingredients must support it: ${plan.join(" ")}`);
  } else if (t.kind === "alternate") {
    const d = t.dishes[0];
    parts.push(
      `ONE Thanksgiving dish (${(d.course ?? "").replace("course-", "")}), cuisine ${t.cuisine}, authored ALONE so a cook can swap it into a Thanksgiving feast's dish list. Author exactly one dish, "${d.name}", with role ${d.role}.`,
      `This request is NOT a complete dinner and the complete-dinner rules do not apply to it: do not add a protein, a starch, a side or a sauce to make it one.`,
      `Size it for ${t.servings} people at a holiday table, as one dish among about eight.`,
    );
  } else if (t.kind === "weeknight") {
    // The note IS the brief (pizza night's words are ruled, D-WS9-313).
    parts.push(`Thanksgiving week, dinner for ${t.servings}, cuisine ${t.cuisine}.`);
  } else if (t.leftovers && t.leftovers.length > 0) {
    parts.push(
      `The Friday after Thanksgiving, dinner for ${t.servings}, cuisine ${t.cuisine}: an easy weeknight dinner built from Thursday's leftovers.`,
      `The leftovers on the shortcut line are already cooked and in the fridge: list each as a plain ingredient under exactly that name, buy no raw turkey, and roast nothing to replace them.`,
      FRIDAY_SELF_CONTAINED,
    );
  } else {
    // Follow-up C: "built from Thursday's leftovers" with NO leftovers named is
    // how the vegetarian soup came to list "cooked wild rice, leftover from
    // Thanksgiving" — a dish no feast makes.
    parts.push(
      `The Friday after Thanksgiving, dinner for ${t.servings}, cuisine ${t.cuisine}: an easy weeknight dinner that uses NO leftovers.`,
      FRIDAY_SELF_CONTAINED,
    );
  }
  if (t.products.length > 0) {
    parts.push(`Name each store-bought product in the ingredient list exactly as written on the shortcut line, parenthetical included.`);
  }
  if (t.vegetarian) parts.push(VEGETARIAN_RULE);
  if (t.note) parts.push(t.note);
  parts.push(GENERATE_RULES);
  return parts.join(" ");
}

// ── follow-up C: the recipe-quality rules (script-only; user-body text, so the
// cached prefix is untouched — the sha256 test in the suite proves it) ───────

export const FRIDAY_SELF_CONTAINED =
  `Everything except the named leftovers is bought and cooked in this recipe: no ingredient is "leftover from Thanksgiving" unless the shortcut line names it (a wild rice soup cooks its own wild rice).`;

export const VEGETARIAN_RULE =
  `VEGETARIAN: no meat, poultry, fish or seafood; no meat stock; no gelatin; no Worcestershire sauce (it contains anchovies); and no cheese traditionally made with animal rennet unless it is labelled vegetarian — that rules out Parmesan, Pecorino, Grana Padano, Gruyère, Comté, Emmental, Manchego and Gorgonzola; write "vegetarian Parmesan-style cheese", or use a cheese like sharp cheddar, fontina or mozzarella labelled vegetarian.`;

/** Ingredient-level rules for the GENERATE call (quantities, swaps, produce). */
export const GENERATE_RULES = [
  `Recipe rules for this request:`,
  `(1) Fit the vessel: size each dish to a pan that holds it — about 12–14 cups fills a 9×13 dish; about 4 cups fills a standard 9-inch pie dish (deep-dish about 6); a 12-inch skillet takes about 1½ lb of vegetables in one batch. When the servings need more, plan two pans or a sheet pan. A pie that names two crusts makes two pies of filling: about 4 cups per 9-inch pie, so two pies need a doubled one-pie filling (twice the eggs, milk and purée). One 9-inch pie serves 8; serve 10 with two pies, or one deep-dish pie.`,
  `(2) Swaps: a substitution names a real retail product a shopper can find (never a blend you describe), and replaces from-scratch work — never a store-bought ingredient with another store-bought one, never a product with itself. Store-bought turkey or chicken stock IS a fair swap for stock the recipe makes from the neck and giblets. If a product's package needs add-ins (eggs, milk, oil), those add-ins are in this dish's ingredient list.`,
  `(3) Buy whole produce: list "2 oranges" with the zest and the juice as preparation notes, never "orange juice" or "orange zest" when the cook is squeezing an orange; the same for lemons and limes. Garlic is counted in cloves.`,
  `(4) Quantities are cook's fractions (⅛, ¼, ⅓, ½, ⅔, ¾); an amount under ⅛ teaspoon is "1 pinch". Every ingredient has a buyable amount (a pan of cornbread is "1 (8×8) pan cornbread" or the mix and its add-ins, not "10 cups day-old cornbread").`,
  `(5) A whole bird brines in a brining bag (or an unscented, food-safe bag) set in a roasting pan or cooler in the fridge. Use enough liquid to cover it — for a 12–14 lb bird about 1 gallon of liquid in total — and scale the salt to the liquid (about ½ cup kosher salt per gallon for a 12–24 hour brine). A bought brine mix makes the same volume as the scratch brine.`,
  `(7) Buy what the recipe uses: a product sold in a multi-pack is listed as the packs needed, not packs times count. Put the pack in the QUANTITY and UNIT and keep the product's name exactly as given: two pie crusts is quantity 1, unit "package (2-count)", name "refrigerated pie crust (contains wheat)".`,
  `(6) A gravy that needs stock before Thursday makes it from about 2 lb turkey wings, or from the neck and giblets with a thaw note; a classic gravy may make its stock from the neck and giblets, with store-bought turkey stock as the swap.`,
].join(" ");

/** Step-level rules for the FINALIZE call (vessels, paths, safety, timeline). */
export const FINALIZE_RULES = [
  `Step rules for this request:`,
  `(a) Keep every step's text under 300 characters; split a long step into two.`,
  `(b) Name the pan and its size in the step that uses it, and choose one that holds the volume (about 12–14 cups in a 9×13; about 4 cups in a 9-inch pie dish, 6 in a deep-dish; about 1½ lb of vegetables per batch in a 12-inch skillet). Otherwise use two pans, batches or a sheet pan. A spatchcocked turkey roasts flat on a rimmed sheet pan, not on a roasting rack.`,
  `(c) Both paths are complete: every ingredient the dish lists is used on the path that keeps it — if the scratch path makes an herb butter and the bought path uses a rub packet, the bought path still uses the butter and anything the packet does not replace. On a path that uses a pre-seasoned product (a stuffing mix, a seasoning packet, a brine mix) add no extra salt. A mix's package add-ins are used on its path. On a gravy's bought path, the gravy still works from the drippings plus the bought stock.`,
  `(d) Make-ahead prerequisites: when a step uses the giblets or neck before Thursday, the earliest turkey step says a frozen 14-lb turkey thaws in the fridge 3–4 days, so it goes in before the giblets are needed. Bread to be dried gets its own cube-and-dry step and day. Reheat times assume the dish comes straight from the fridge (a cold casserole or a big pan of mashed potatoes needs about 45–60 minutes covered at 350°F).`,
  `(e) Poultry: never rinse raw poultry, the neck or the giblets; pat the bird dry with paper towels. A whole bird brines in a brining bag set in a roasting pan or cooler in the fridge, turned halfway through. A whole unstuffed turkey roasts about 13–15 minutes per pound at 325°F (a 14-lb bird about 3 to 3½ hours) to 165°F in the thickest part of the thigh; a spatchcocked one roasts hotter and faster (about 80–90 minutes at 425–450°F for 12–14 lb). Glaze only in the last 20–30 minutes, once the thigh reads about 155°F, and finish at 165°F.`,
  `(f) A spatchcock recipe includes the cut (kitchen shears down both sides of the backbone, then press flat) or says "ask the butcher to spatchcock". Warm corn tortillas before rolling them so they don't crack.`,
].join(" ");

/**
 * Follow-up B: EVERY target's finalize call carries the long-wait rule. A
 * brine, an overnight chill or a day's rest written as a timed step lands in
 * the derived time (the buttermilk turkey read 808 min — a Cookbook card
 * number). Such a wait becomes a make-ahead line in the text of the step that
 * starts it. "Several hours" is drawn at 4: a pie cooling 2 hours or a turkey
 * resting 30 minutes stays a timed step.
 */
export const LONG_WAIT_RULE =
  `Any passive wait of 4 hours or more (brining, marinating, chilling or resting overnight, a day in the fridge) is a MAKE-AHEAD NOTE, not a timed step: write it into the text of the step that starts it, in the cook's words (for example "Brine overnight, 8 to 24 hours, the day before."), and give that step only its own hands-on minutes. No step's estimatedMinutes includes such a wait. A DESSERT's cooling or setting of 1 hour or more (a pie, cheesecake bars, a custard) is a note too, in the last step's text (for example "Cool at least 2 hours before slicing, or bake the day before."), never a timed step. Savoury rests stay timed steps as usual (resting the turkey 30–45 minutes).`;

/** The finalize call's brief: the long-wait rule for every target, plus the
 *  Make-Ahead day notes (the generate brief never reaches the finalize call). */
export function composeFinalizeBrief(t: Thx2Target): string {
  const plan = dayPlanLines(t);
  const base = [LONG_WAIT_RULE, FINALIZE_RULES, ...(t.vegetarian ? [VEGETARIAN_RULE] : [])];
  if (plan.length === 0) return base.join(" ");
  return [
    ...base,
    ...(t.plan === "make-ahead" ? [`This is a MAKE-AHEAD Thanksgiving: most of the work is done before Thursday.`] : []),
    // Follow-up E: ONE phrase, so a reader (and PREP-1) can find the make-ahead part.
    `MAKE-AHEAD DAYS (Thanksgiving is Thursday). For each dish below, the make-ahead step's text opens with exactly "Make ahead (<Day>):" and the dish's Thursday part opens with exactly "On Thursday:"; an overnight wait keeps the wait-rule phrasing inside that step.`,
    `The days, by dish: ${plan.join(" ")}`,
    `Work done on an earlier day keeps only its hands-on minutes, so the timed steps stay Thursday's work plus the reheats and bakes.`,
  ].join(" ");
}

export function profileFor(t: Thx2Target): GenProfile {
  return { key: `thx2-${t.kind}-${t.servings}-${t.difficulty}`, servings: t.servings, difficulty: t.difficulty };
}

export function toTargetDish(t: Thx2Target): TargetDish {
  return {
    rank: 1,
    dish: t.title,
    key: t.key,
    category: t.cuisine,
    parentDish: t.title,
    band: "midtail",
    siblingCount: 1,
    dishes: t.dishes.map((d) => d.name),
    shortcut: shortcutFor(t),
  };
}

/** The runStoreFill options for one target (everything but deps, apply, rate,
 *  breaker and log, which the caller owns). */
export type Thx2RunOptions = Pick<
  StoreFillOptions,
  "limit" | "dishes" | "profiles" | "maxDishes" | "maxOutputTokens" | "isPublic" | "completeness" | "brief" | "finalizeBrief" | "tags" | "dishTags" | "dishTagsFor" | "transactionTimeoutMs" | "storedDifficulty"
>;

/** Hans (follow-up B): every feast is stored as medium, whatever its ceiling.
 *  Alternates, Friday and the weeknight keep the model's value. */
export const FEAST_STORED_DIFFICULTY = "medium" as const;

/** The per-meal write's transaction timeout. The dev pilot's 8-dish feast
 *  overran Prisma's 5 s default (P2028); 60 s is the wizard activation's value. */
export const TRANSACTION_TIMEOUT_MS = 60_000;

export function runOptionsFor(t: Thx2Target, file: TargetsFile): Thx2RunOptions {
  return {
    limit: 1,
    dishes: [toTargetDish(t)],
    profiles: [profileFor(t)],
    maxDishes: file.maxDishes,
    maxOutputTokens: file.maxOutputTokens,
    isPublic: false,
    completeness: t.kind === "alternate" ? "single_dish" : "meal",
    brief: composeBrief(t),
    finalizeBrief: composeFinalizeBrief(t),
    tags: mealTags(t),
    dishTags: dishTags(t),
    ...(t.kind === "feast" ? { dishTagsFor: aheadTagsFor(t) } : {}),
    transactionTimeoutMs: TRANSACTION_TIMEOUT_MS,
    ...(t.kind === "feast" ? { storedDifficulty: FEAST_STORED_DIFFICULTY } : {}),
  };
}

// ── flags (reported, never fixed here) ──────────────────────────────────────

export interface Flag {
  code: "product_not_listed" | "product_renamed" | "product_allergens_missing" | "product_in_substitution" | "buys_turkey" | "dish_count" | "dish_order" | "path_unused" | "vegetarian_rennet_cheese";
  detail: string;
}

/** The product's core noun: its last two words without the allergen
 *  parenthetical ("refrigerated pie crust (contains wheat)" → "pie crust"), so a
 *  renamed line ("crispy fried onions") is still recognised as the product. */
const stripParen = (s: string) => s.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase().split(/\s+/).slice(-2).join(" ");

/**
 * Flags for one written meal against its target.
 *
 * product_allergens_missing is THE flag the prompt asks for: a store-bought
 * product whose usual allergens (the products table) are not all on the meal's
 * stamp — puff pastry without dairy. The rest explain why: the product was not
 * listed, or was listed under another name, so the parenthetical never reached
 * the stamp.
 */
/** Follow-up C: raw turkey only — a whole bird or a raw cut. Broth, stock and
 *  gravy (the false positive on "low-sodium chicken or turkey broth"), and
 *  leftover, cooked, deli or smoked turkey, are not a purchase of a turkey. */
export function isRawTurkey(name: string): boolean {
  const n = name.toLowerCase();
  if (!/\bturkey\b/.test(n)) return false;
  if (/\b(broth|stock|gravy|leftover|cooked|deli|smoked|bacon|sausage|pepperoni)\b/.test(n)) return false;
  return n.trim() === "turkey" || /\b(whole|breasts?|thighs?|legs?|wings?|drumsticks?|ground|bone-in|tenderloins?|cutlets?)\b/.test(n);
}

/** Follow-up C, report only: cheeses whose traditional (often protected) recipe
 *  uses animal rennet. The vegetarian rule names Parmesan; the dev re-pilot
 *  slipped Gruyère past it. */
export const RENNET_CHEESE = /\b(parmesan|parmigiano|reggiano|pecorino|romano|grana padano|gruy[eè]re|comt[eé]|emmental(er)?|manchego|gorgonzola)\b/i;

/** One dish as the path check reads it (the stored rows). */
export interface PathDish {
  title: string;
  ingredients: Array<{ name: string }>;
  substitutions: Array<{ product: string; replaces: string[] }>;
  steps: Array<{ text: string; pathKey: string | null; componentKey: string | null }>;
}

const UNIT_WORDS = new Set(["clove", "cloves", "sprig", "sprigs", "leaf", "leaves", "stalk", "stalks", "head", "heads", "bunch", "can", "cans"]);

/** The word a step uses for an ingredient: its last word, unless that is a
 *  counting word ("garlic cloves" → "garlic"). Parentheticals dropped. */
export function mentionWord(name: string): string {
  const words = name.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z\- ]+/g, " ").split(/\s+/).filter(Boolean);
  let i = words.length - 1;
  while (i > 0 && UNIT_WORDS.has(words[i])) i--;
  return words[i] ?? "";
}

function mentions(text: string, word: string): boolean {
  if (!word) return false;
  const stem = word.replace(/(es|s)$/, "");
  return new RegExp(`\\b(${word}|${stem}|${stem}s|${stem}es)\\b`, "i").test(text);
}

/**
 * Follow-up C, REPORT ONLY: an ingredient that only one path uses and that the
 * dish's swaps do not replace — on the other path it is bought and never used
 * (the herb butter's butter, sage and garlic on a rub-packet path). Matching is
 * by the ingredient's last word in the step text, so it is a review prompt, not
 * a verdict.
 */
export function pathFlags(dishes: readonly PathDish[]): Flag[] {
  const flags: Flag[] = [];
  for (const d of dishes) {
    if (!d.steps.some((s) => s.pathKey)) continue;
    const replaced = new Set(d.substitutions.flatMap((s) => s.replaces.map((r) => r.toLowerCase().trim())));
    for (const ing of d.ingredients) {
      const w = mentionWord(ing.name);
      const where = d.steps.filter((s) => mentions(s.text, w));
      if (where.length === 0) continue;
      const base = where.some((s) => !s.pathKey);
      const scratch = where.some((s) => s.pathKey === "scratch");
      const bought = where.some((s) => s.pathKey === "bought");
      if (base || scratch === bought) continue;
      if (scratch && replaced.has(ing.name.toLowerCase().trim())) continue;
      flags.push({
        code: "path_unused",
        detail: `${d.title}: "${ing.name}" is used only on the ${scratch ? "scratch" : "bought"} path — on the ${scratch ? "bought" : "scratch"} path it is bought and never used`,
      });
    }
  }
  return flags;
}

export function flagsFor(
  t: Thx2Target,
  file: TargetsFile,
  meal: { dishTitles: string[]; ingredientNames: string[]; stamp: string[]; substitutionProducts: string[]; dishes?: readonly PathDish[] },
): Flag[] {
  const flags: Flag[] = [];
  const names = meal.ingredientNames.map((n) => n.toLowerCase());
  const stamp = new Set(meal.stamp);
  for (const p of t.products) {
    const base = stripParen(p);
    const exact = names.includes(p.toLowerCase());
    const listed = exact || names.some((n) => n.includes(base));
    if (!listed) flags.push({ code: "product_not_listed", detail: `"${p}" is not in any ingredient line` });
    else if (!exact) flags.push({ code: "product_renamed", detail: `"${p}" is listed under another name: ${meal.ingredientNames.filter((n) => n.toLowerCase().includes(base)).map((n) => `"${n}"`).join(", ")}` });
    const missing = (file.products[p] ?? []).filter((tok) => !stamp.has(tok));
    if (missing.length > 0) flags.push({ code: "product_allergens_missing", detail: `"${p}" usually carries ${missing.join(", ")}, not on the stamp [${meal.stamp.join(", ")}]` });
    const subs = meal.substitutionProducts.filter((s) => s.toLowerCase().includes(base));
    if (subs.length > 0) flags.push({ code: "product_in_substitution", detail: `"${p}" appears as a substitution (${subs.join(", ")}) — shortcut mode forbids it` });
  }
  if (t.kind === "friday" && (t.leftovers ?? []).some((l) => /\bturkey\b/.test(l))) {
    const raw = meal.ingredientNames.filter(isRawTurkey);
    if (raw.length > 0) flags.push({ code: "buys_turkey", detail: `turkey bought beside the leftovers: ${raw.map((n) => `"${n}"`).join(", ")}` });
  }
  if (meal.dishes) flags.push(...pathFlags(meal.dishes));
  if (t.vegetarian) {
    const rennet = meal.ingredientNames.filter((n) => RENNET_CHEESE.test(n) && !/\bvegetarian\b/i.test(n));
    if (rennet.length > 0) flags.push({ code: "vegetarian_rennet_cheese", detail: `traditionally made with animal rennet, not labelled vegetarian: ${rennet.map((n) => `"${n}"`).join(", ")}` });
  }
  if (meal.dishTitles.length !== t.dishes.length) {
    flags.push({ code: "dish_count", detail: `${meal.dishTitles.length} dishes stored, ${t.dishes.length} asked` });
  } else {
    const off = t.dishes.map((d, i) => ({ i, asked: d.name, stored: meal.dishTitles[i] })).filter((x) => !titleMatches(x.asked, x.stored));
    if (off.length > 0) flags.push({ code: "dish_order", detail: off.map((x) => `#${x.i} asked "${x.asked}", stored "${x.stored}"`).join("; ") });
  }
  return flags;
}

const STOP = new Set(["and", "with", "the", "a", "of", "for", "in", "on"]);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w && !STOP.has(w));

/** Does a stored dish title name the asked dish? Every content word of the
 *  asked name appears in the stored title (the model may embellish, never drop). */
export function titleMatches(asked: string, stored: string): boolean {
  const have = new Set(words(stored));
  return words(asked).every((w) => have.has(w) || have.has(w.replace(/es$|s$/, "")) || have.has(`${w}s`));
}

// ── the approve guard ────────────────────────────────────────────────────────

/**
 * The name of the constant THX-2S exports from src/lib/store/storeShortlist.ts:
 * the tags the everyday shelf excludes. approve.ts imports the module and
 * refuses unless this export exists and contains `thanksgiving`.
 *
 * An import, not a grep: `thanksgiving` already appears in this repo's comments,
 * and a grep cannot tell a comment from a filter.
 */
export const SHELF_EXCLUSION_EXPORT = "EVERYDAY_SHELF_EXCLUDED_TAGS";

export function shelfExclusionPresent(mod: Record<string, unknown>): boolean {
  const v = mod[SHELF_EXCLUSION_EXPORT];
  if (Array.isArray(v)) return v.includes(THANKSGIVING_TAG);
  if (v instanceof Set) return v.has(THANKSGIVING_TAG);
  return false;
}

/** approve.ts's guard: the refusal line, or null when approve may proceed. */
export function approveRefusal(shortlistModule: Record<string, unknown>): string | null {
  return shelfExclusionPresent(shortlistModule)
    ? null
    : `the everyday-shelf exclusion is not in this code: src/lib/store/storeShortlist.ts does not export ${SHELF_EXCLUSION_EXPORT} containing "${THANKSGIVING_TAG}" (THX-2S builds it). Making these meals public now would put them on every user's weekly shelf.`;
}
