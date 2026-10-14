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
export type Kind = "feast" | "alternate" | "friday";
export type Difficulty = GenProfile["difficulty"];

export interface DishSpec {
  name: string;
  role: Role;
  course?: CourseTag;
  /** Make-Ahead only: the day the step is done, written into the step text. */
  dayNote?: string;
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
    if (!["feast", "alternate", "friday"].includes(t.kind)) errs.push(`${at}: kind "${t.kind}"`);
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
    if (t.kind === "friday" && t.servings !== 4) errs.push(`${at}: Friday meals are authored at 4 (the catalog default)`);
    if (t.plan !== "make-ahead" && dishes.some((d) => d.dayNote)) {
      errs.push(`${at}: day notes belong to the Make-Ahead plan only`);
    }
  }
  return errs;
}

// ── per-target run options ───────────────────────────────────────────────────

export function mealTags(t: Thx2Target): string[] {
  return t.kind === "alternate" ? [THANKSGIVING_TAG, ALTERNATE_TAG, t.dishes[0].course as string] : [THANKSGIVING_TAG];
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
  } else if (t.kind === "alternate") {
    const d = t.dishes[0];
    parts.push(
      `ONE Thanksgiving dish (${(d.course ?? "").replace("course-", "")}), cuisine ${t.cuisine}, authored ALONE so a cook can swap it into a Thanksgiving feast's dish list. Author exactly one dish, "${d.name}", with role ${d.role}.`,
      `This request is NOT a complete dinner and the complete-dinner rules do not apply to it: do not add a protein, a starch, a side or a sauce to make it one.`,
      `Size it for ${t.servings} people at a holiday table, as one dish among about eight.`,
    );
  } else {
    parts.push(
      `The Friday after Thanksgiving, dinner for ${t.servings}, cuisine ${t.cuisine}: an easy weeknight dinner built from Thursday's leftovers.`,
    );
    if (t.leftovers && t.leftovers.length > 0) {
      parts.push(
        `The leftovers on the shortcut line are already cooked and in the fridge: list each as a plain ingredient under exactly that name, buy no raw turkey, and roast nothing to replace them.`,
      );
    }
  }
  if (t.products.length > 0) {
    parts.push(`Name each store-bought product in the ingredient list exactly as written on the shortcut line, parenthetical included.`);
  }
  if (t.note) parts.push(t.note);
  return parts.join(" ");
}

/** The finalize call's brief: the Make-Ahead day notes, so they reach the STEPS
 *  (the generate brief never reaches the finalize call). */
export function composeFinalizeBrief(t: Thx2Target): string | undefined {
  const notes = t.dishes.map((d, i) => ({ i, d })).filter(({ d }) => d.dayNote);
  if (notes.length === 0) return undefined;
  return [
    `This is a MAKE-AHEAD Thanksgiving: write the day into the step text of each make-ahead step, in the cook's words (for example "Up to 3 days ahead (we suggest Monday): …").`,
    `The days, by dish: ${notes.map(({ i, d }) => `dishIndex ${i} ${d.name}: ${d.dayNote}`).join("; ")}.`,
    `A wait that spans days (a dry brine, chilling overnight) is stated in the text of the step that starts it; that step's estimatedMinutes counts only its own hands-on work, so the timed steps stay Thursday's work plus the reheats and bakes.`,
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
  "limit" | "dishes" | "profiles" | "maxDishes" | "maxOutputTokens" | "isPublic" | "completeness" | "brief" | "finalizeBrief" | "tags" | "dishTags" | "transactionTimeoutMs"
>;

/** The per-meal write's transaction timeout. The dev pilot's 8-dish feast
 *  overran Prisma's 5 s default (P2028); 60 s is the wizard activation's value. */
export const TRANSACTION_TIMEOUT_MS = 60_000;

export function runOptionsFor(t: Thx2Target, file: TargetsFile): Thx2RunOptions {
  const finalizeBrief = composeFinalizeBrief(t);
  return {
    limit: 1,
    dishes: [toTargetDish(t)],
    profiles: [profileFor(t)],
    maxDishes: file.maxDishes,
    maxOutputTokens: file.maxOutputTokens,
    isPublic: false,
    completeness: t.kind === "alternate" ? "single_dish" : "meal",
    brief: composeBrief(t),
    ...(finalizeBrief ? { finalizeBrief } : {}),
    tags: mealTags(t),
    dishTags: dishTags(t),
    transactionTimeoutMs: TRANSACTION_TIMEOUT_MS,
  };
}

// ── flags (reported, never fixed here) ──────────────────────────────────────

export interface Flag {
  code: "product_not_listed" | "product_renamed" | "product_allergens_missing" | "product_in_substitution" | "buys_turkey" | "dish_count" | "dish_order";
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
export function flagsFor(
  t: Thx2Target,
  file: TargetsFile,
  meal: { dishTitles: string[]; ingredientNames: string[]; stamp: string[]; substitutionProducts: string[] },
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
    const raw = meal.ingredientNames.filter((n) => /\bturkey\b/i.test(n) && !/leftover/i.test(n));
    if (raw.length > 0) flags.push({ code: "buys_turkey", detail: `turkey bought beside the leftovers: ${raw.map((n) => `"${n}"`).join(", ")}` });
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
