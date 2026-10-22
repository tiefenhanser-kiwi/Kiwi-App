// WS7-8b BUG-003 Block 1 — render-time segmentation of a step's text using its
// derived amountRefs. Where highlightQuantities (cookSession.ts) is a
// regex-based, LOSSLESS reconstruction of the original literal, this builder
// REPLACES each ref span with the structured amount scaled by the meal-detail
// multiplier — so a rescale renders from one structured source and the step's
// literal is never shown.
//
// Used by:
//   - Meal Detail (the scaling screen): multiplier = displayServings/servings.
//   - Cook Mode: multiplier = 1 (renders the structured base amount; Cook Mode
//     does not scale — only the literal is bypassed in favor of the ref value).

import type { AmountRef } from "../api/meals";
import { unitWordFor } from "../format/grocery";
import {
  displayedQuantity,
  formatQuantity,
  isBirdPart,
  isEquipment,
  ONE_BIRD,
  packageUse,
  wholeItemMultiplier,
  type BirdLine,
} from "../format/quantity";

// ── WS9 BUG-326 — A RANGE IS NOT ITS MIDPOINT ──────────────────────────────
//
// The catalog's amount extractor resolves an authored range to a single
// number, and the number it picks is the MIDDLE: "3–4 shallow cuts" carries
// `quantity: 3.5`, "2–3 tablespoons" carries 2.5. This builder then replaces
// the authored span with that number, so the cook reads "3½ shallow cuts" and
// "2.5 tablespoons" — an instruction no recipe has ever contained, and for a
// countable thing an impossible one.
//
// The ref is not WRONG as data: a midpoint is a reasonable scalar for a range,
// and the grocery consolidation wants a scalar. It is wrong as PROSE. So the
// guard is render-side and narrow: when the span's AUTHORED TEXT holds a range,
// that text is what the step shows, and the structured value is not consulted.
//
// ⚠️ `isRef` STAYS TRUE. The span is still an amount and still earns the
// terracotta treatment — it is the author's amount rather than the derived one.
// Flipping it to plain text would silently de-highlight 68 steps.
//
// ⚠️ SCALING LEAVES A RANGE AS WRITTEN (ruled). There is no honest way to scale
// "2–3 tablespoons" by 1.5: scaling both ends invents a range the author did
// not write, and scaling the midpoint is the defect. A range is a tolerance,
// not a quantity, so it rides through the servings stepper untouched.
const NUM = String.raw`\d+(?:\.\d+)?`;
/** An authored range: "3-4", "2–3", "60 to 70". Hyphen, en/em dash, or "to". */
const AUTHORED_RANGE = new RegExp(`${NUM}\\s*(?:-|–|—|to)\\s*${NUM}`);

/** Does this span's authored text state a range rather than one amount? */
export function spanHoldsRange(spanText: string): boolean {
  return AUTHORED_RANGE.test(spanText);
}

// ── 🔴 WS9 BUG-334 — A UNIT THAT OPENS WITH A NUMBER IS NOT A UNIT ──────────
//
// Hans's device pass, item 16. A step authored "Whisk together 1½ cups
// all-purpose flour…" renders "1½ ½ cups", and Cook Mode on the same meal reads
// "the 1 3/4 3/4 lbs chicken thighs". The catalog's amount extractor split the
// authored mixed number and the fraction landed in BOTH fields:
//
//     authored "1½ cups"   ref { quantity: 1.5, unit: "½ cups" }
//     authored "1 3/4 lbs" ref { quantity: 1,   unit: "3/4 lbs" }
//
// so this builder prints the quantity AND a unit that repeats it.
//
// MEASURED on dev, 2026-09-30: 3,266 refs over 3,037 steps and 2,013 dishes —
// 7.5% of every ref in the catalog. 1,521 of those dishes are public and are
// repaired by scripts/grocery-f/bug334-repair.ts; **492 are user-owned copies
// and are never repaired** (D-WS9-230, fixes are forward-only for user data).
// This guard is what serves those, permanently, and it is why it shipped before
// the repair rather than after.
//
// ⚠️ THE RANGE GUARD ABOVE IS NOT THE MECHANISM, AND THE REPORT'S OWN
// HYPOTHESIS WAS WRONG ABOUT THAT. "Cover and cook on low for 5½ ½–6 hours"
// looks like BUG-326 letting "½–6 hours" through as a unit. It is not: the ref
// is `{ quantity: 5.5, unit: "½" }` and its span is the four characters "5½".
// The "–6 hours" is ordinary surrounding prose that this builder never touched.
// Measured across all 3,266: **zero** authored spans contain a range at all, so
// `spanHoldsRange` correctly fires on none of them. Two independent defects
// that happened to print next to each other.
//
// ⚠️ DETECTED BY SHAPE, NOT BY A LIST OF BAD STRINGS. No real unit token in
// this project begins with a digit, a vulgar fraction or a slash — not one of
// the 49 spellings the catalog carries, and not one of the 42 in
// `dish_ingredients.unit`. Those three openings are exactly the three ways a
// number can lead. A false positive costs that span its SCALING and nothing
// else: the authored text still renders, still highlights, and is what the
// author wrote. That asymmetry is what makes a shape test the honest detector
// here rather than an enumeration that would go stale on the next import.
const FRACTION_GLYPHS = "¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞";
const CORRUPT_UNIT = new RegExp(`^\\s*[0-9/${FRACTION_GLYPHS}]`);

/** Has this ref's `unit` swallowed part of the authored number? */
export function unitIsCorrupt(unit: string | null | undefined): boolean {
  return CORRUPT_UNIT.test(unit ?? "");
}

/**
 * FIX-7 — the noun phrase after an amount span, standing in for the
 * ingredient name: up to the first clause break (punctuation, a conjunction,
 * a preposition), at most 40 characters. "1 egg, 2 minced garlic cloves" gives
 * " egg" for the "1", and "3 bell peppers into strips" gives " bell peppers" —
 * never the strips the peppers are cut into.
 */
export function followingWords(text: string, from: number, max = 40): string {
  const rest = text.slice(from, from + max);
  const stop = rest.search(
    /[,;.:()]|\s(?:and|or|with|then|into|in|to|for|on|over|until|from|according|per|at|by|of)\b/i,
  );
  return stop === -1 ? rest : rest.slice(0, stop);
}

// ── WEB-4 (BUG-443, BUG-450) — AMOUNTS THAT ARE NOT QUANTITIES ─────────────
//
// Some step amounts are not how much of an ingredient to use, so the servings
// multiplier has no business with them. MEASURED on the public dev catalog
// (32,083 refs, 2026-10-20):
//
//   - 374 refs are a SIZE written with a hyphen: "the 28-oz can", "6-oz salmon
//     fillets", "a 6-quart saucepan". The number belongs to the can, the fillet
//     or the pot, and at household 2 it read "the 14-oz can". When the noun
//     after the hyphenated unit is a package or a piece of equipment
//     (PACKAGE_NOUN), or a per-piece cut sized in ounces (PIECE_NOUN), the span
//     prints as written. A piece bought by its own weight — "the 3-pound chuck
//     roast", "the 1¾-pound flank steak" — still scales, so the step agrees
//     with the ingredient line.
//   - 11 refs carry a TIME unit ("1½ minutes" → "¾ minute"), and 5 unit-less
//     refs are followed by one ("2 days ahead"). A duration never scales.
//     BUG-450's "keeps up to 1⅝ days" (a Thanksgiving make-ahead) is this class.
//
// Same output path as BUG-326's ranges: the authored text, still highlighted.
const TIME_UNIT = /^(?:s|secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|weeks?|months?|nights?)$/i;
const TIME_AFTER = /^\s*(?:secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|weeks?|months?|nights?)\b/i;
/** "-oz", "-pound", "-quart" … right after the number. */
const SIZE_AFTER =
  /^[-‑]\s*(?:oz|ounces?|lbs?|pounds?|g|grams?|kg|kilograms?|qt|quarts?|cups?|liters?|litres?|ml|inch(?:es)?|in)\b/i;
/** What a hyphenated size describes when its number is not an amount to
 *  scale: a package (or a beer, which is one), or a piece of equipment. */
const PACKAGE_NOUN =
  /\b(?:cans?|jars?|bottles?|packages?|pkgs?|packets?|bags?|box(?:es)?|cartons?|containers?|tubs?|tubes?|pouch(?:es)?|blocks?|sticks?|loaf|loaves|sheets?|lagers?|beers?|ales?|stouts?|saucepans?|stockpots?|pots?|pans?|skillets?|dutch ovens?|slow cookers?|baking dish(?:es)?|casserole dish(?:es)?|ramekins?|molds?)\b/i;
/** A per-piece cut, sized in OUNCES or grams ("6-oz salmon fillets", "4-oz
 *  patties"). Sized in pounds the same noun is usually the whole amount — "the
 *  1¾-pound flank steak" is one steak, and it scales with its line. */
const PIECE_NOUN = /\b(?:fillets?|steaks?|portions?|slices?|balls?|patt(?:y|ies)|links?|cutlets?|chops?)\b/i;
const OUNCE_SIZE = /^[-‑]\s*(?:oz|ounces?|g|grams?)\b/i;
/** "the 3-pound chicken", "the 4-pound whole chicken": a whole bird by its
 *  weight (BUG-453's floor), never a cut of one. */
const HYPHEN_BIRD =
  /^[-‑]\s*(lbs?|pounds?|oz|ounces?|g|grams?|kg)\s+(?:whole\s+|spatchcock(?:ed)?\s+)?(chickens?|turkeys?|ducks?|goose|hens?)\b(?!\s+(?:thighs?|breasts?|wings?|drumsticks?|legs?|tenders?|tenderloins?|cutlets?|pieces?|parts?|quarters?|broth|stock))/i;

/**
 * WEB-4d (R5) — a size in PARENTHESES: "2 boxes (8.5 oz each) cornbread mix",
 * "one can (13.5 oz) of coconut milk", "8 balls (4 oz each)". After a package
 * noun, or marked "each", the number is the package's or the piece's, and the
 * count before it is what scales. A TOTAL scales ("broth cartons (8 cups
 * total)", "(30 oz total)").
 */
const PAREN_AFTER_PACKAGE = new RegExp(`${PACKAGE_NOUN.source}\\s*\\(\\s*$`, "i");
const EACH_THEN_CLOSE = /^\s*(?:each|apiece)\s*\)/i;
const TOTAL_THEN_CLOSE = /^\s*total\b/i;
/**
 * WEB-4d — a package size written WITHOUT a hyphen: "the two 10¾ oz cans", "the
 * 14⅞ fl oz can of Guinness". The ounce rule rounded these even at household 4
 * (10¾ → 11), so the hyphen-only guard above is not enough any more.
 */
const SIZE_UNIT = /^(?:fl\.?\s*oz|oz|ounces?|lbs?|pounds?|g|grams?|kg|ml|liters?|litres?)$/i;
/** The package comes right after the size ("10¾ oz cans", "14.5 oz can crushed
 *  tomatoes"; a unit-less ref needs its unit first: "14⅞ fl oz can")… */
const PACKAGE_NEXT = new RegExp(`^\\s+${PACKAGE_NOUN.source}`, "i");
const UNIT_THEN_PACKAGE = new RegExp(
  `^\\s*(?:fl\\.?\\s*oz|oz|ounces?|lbs?|pounds?|g|grams?|kg|ml)\\s+${PACKAGE_NOUN.source}`,
  "i",
);
/** …or it is the HEAD of the words that follow ("8.5 oz microwavable white rice
 *  pouches"), up to the first preposition, so "8 oz pasta to the pot" is pasta. */
const PACKAGE_HEAD = new RegExp(`${PACKAGE_NOUN.source}\\s*$`, "i");
const LEADING_SIZE_UNIT = /^\s*(?:fl\.?\s*oz|oz|ounces?|lbs?|pounds?|g|grams?|kg|ml)\s/i;

/** Is this ref's number a duration or a package / piece / pan size? */
export function refIsNotAQuantity(
  text: string,
  ref: Pick<AmountRef, "unit" | "charEnd"> & { charStart?: number },
): boolean {
  const unit = (ref.unit ?? "").trim();
  if (TIME_UNIT.test(unit)) return true;
  const after = text.slice(ref.charEnd);
  if (ref.charStart !== undefined && /\(\s*$/.test(text.slice(0, ref.charStart))) {
    if (EACH_THEN_CLOSE.test(after)) return true;
    if (PAREN_AFTER_PACKAGE.test(text.slice(0, ref.charStart)) && !TOTAL_THEN_CLOSE.test(after)) return true;
  }
  if (unit && SIZE_UNIT.test(unit) && PACKAGE_NEXT.test(after)) return true;
  if (!unit && UNIT_THEN_PACKAGE.test(after)) return true;
  // 60, not 40: "8.5 oz microwavable white rice pouches according…" cut at 40
  // leaves "accordi", which no stop word matches.
  const head = followingWords(text, ref.charEnd, 60);
  if (unit && SIZE_UNIT.test(unit) && PACKAGE_HEAD.test(head.trim())) return true;
  if (!unit && LEADING_SIZE_UNIT.test(after) && PACKAGE_HEAD.test(head.trim())) return true;
  if (!unit && TIME_AFTER.test(after)) return true;
  if (!unit && SIZE_AFTER.test(after) && !HYPHEN_BIRD.test(after)) {
    const noun = followingWords(text, ref.charEnd);
    return PACKAGE_NOUN.test(noun) || (OUNCE_SIZE.test(after) && PIECE_NOUN.test(noun));
  }
  return false;
}

// ── WEB-4d (R5) — "1 can (15 oz)" IN A STEP KEEPS THE USE, LIKE ITS LINE ──────
//
// The size in the parentheses never scales (above), so on its own the step at 4
// of 10 read "beat in 1 can (15 oz) pumpkin purée" beside a line saying "use 6
// oz", and New Twist's "Bake 2 boxes (8.5 oz each)" kept its unreffed 2. So the
// whole clause — a count, a package, its size — renders as one amount: the
// count by the package rule (whole, up, never below 1), the size as written, and
// the use when the count was rounded: "1 can (15 oz, use 6 oz)", "1 box (8.5 oz
// each, use 7 oz)". Digit and glyph counts only ("one can (13.5 oz)" keeps its
// word; its size is still held). A TOTAL is not a package size: not matched.
const CLAUSE_COUNT = String.raw`(\d+(?:\.\d+)?|\d*[¼½¾⅛⅜⅝⅞⅓⅔])`;
const PACKAGE_CLAUSE = new RegExp(
  String.raw`(?<![\d.])${CLAUSE_COUNT}\s+(cans?|box(?:es)?|bags?|jars?|packages?|packets?)\s*\(\s*(\d+(?:\.\d+)?)\s*[-‑]?\s*(fl\.?\s*oz|oz|ounces?|lbs?|pounds?|g|grams?|ml)(\s+each)?\s*\)`,
  "gi",
);
const GLYPH_VALUE: Record<string, number> = { "¼": 1 / 4, "½": 1 / 2, "¾": 3 / 4, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8, "⅓": 1 / 3, "⅔": 2 / 3 };

function clauseCount(token: string): number {
  const glyph = GLYPH_VALUE[token.slice(-1)];
  if (glyph === undefined) return Number(token);
  return (token.length > 1 ? Number(token.slice(0, -1)) : 0) + glyph;
}

/** The package clauses in a step, each with its rendered text. */
function packageClauses(text: string, multiplier: number): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  for (const m of text.matchAll(PACKAGE_CLAUSE)) {
    const [whole, count, noun, size, sizeUnit, each = ""] = m;
    const n = clauseCount(count);
    if (!(n > 0)) continue;
    const scaled = n * multiplier;
    const shown = displayedQuantity(scaled, noun);
    const use = packageUse(scaled, `${noun} (${size} ${sizeUnit})`, "");
    const rendered =
      Math.abs(shown - n) < 1e-9 && !use
        ? whole
        : `${formatQuantity(scaled, noun)} ${unitWordFor(noun, shown)} (${size} ${sizeUnit}${each}${use ? `, ${use}` : ""})`;
    out.push({ start: m.index!, end: m.index! + whole.length, text: rendered });
  }
  return out;
}

export interface AmountSegment {
  text: string;
  /** true → a structured ref amount (style it terracotta); false → plain text. */
  isRef: boolean;
}

/**
 * Slice `text` into plain + ref segments. Refs are taken in document order on
 * their char-spans; each ref span's text becomes the scaled structured amount
 * (`ref.quantity × multiplier`, rounded by formatQuantity) plus its unit.
 *
 * Defensive: ignores refs with out-of-range or overlapping spans so a bad
 * payload can never drop or reorder characters of the surrounding prose. When
 * no usable ref remains, returns a single plain segment === the original text.
 */
export function buildAmountRefSegments(
  text: string,
  amountRefs: AmountRef[] | null | undefined,
  multiplier: number,
  /** WEB-4c (BUG-462, BUG-464) — the step's dish's bird line: parts, equipment, bird sizes. */
  birds: BirdLine = ONE_BIRD,
): AmountSegment[] {
  if (!amountRefs || amountRefs.length === 0) {
    return [{ text, isRef: false }];
  }
  // WEB-4d — a package clause renders whole; a ref inside one is its count or
  // its size, and is rendered by it.
  const clauses = packageClauses(text, multiplier);
  const inClause = (r: AmountRef) => clauses.some((c) => r.charStart < c.end && r.charEnd > c.start);
  const refs = [...amountRefs]
    .filter(
      (r) =>
        Number.isInteger(r.charStart) &&
        Number.isInteger(r.charEnd) &&
        r.charStart >= 0 &&
        r.charEnd <= text.length &&
        r.charStart < r.charEnd &&
        !inClause(r),
    )
    .sort((a, b) => a.charStart - b.charStart);

  const out: AmountSegment[] = [];
  let cursor = 0;
  const items: ({ clause: { start: number; end: number; text: string } } | { ref: AmountRef })[] = [
    ...clauses.map((clause) => ({ clause })),
    ...refs.map((ref) => ({ ref })),
  ].sort((a, b) => ("clause" in a ? a.clause.start : a.ref.charStart) - ("clause" in b ? b.clause.start : b.ref.charStart));
  for (const item of items) {
    if ("clause" in item) {
      const c = item.clause;
      if (c.start < cursor) continue;
      if (c.start > cursor) out.push({ text: text.slice(cursor, c.start), isRef: false });
      out.push({ text: c.text, isRef: true });
      cursor = c.end;
      continue;
    }
    const r = item.ref;
    if (r.charStart < cursor) continue; // skip overlap — never mangle prose
    if (r.charStart > cursor) out.push({ text: text.slice(cursor, r.charStart), isRef: false });
    const authored = text.slice(r.charStart, r.charEnd);
    if (spanHoldsRange(authored) || unitIsCorrupt(r.unit) || refIsNotAQuantity(text, r)) {
      // BUG-326 — the author wrote a range; print the range.
      // BUG-334 — the unit swallowed part of the number, so the structured
      // amount cannot be printed without saying the fraction twice. Same
      // answer, same path: show what the author wrote.
      //
      // ⚠️ `isRef` STAYS TRUE, for BUG-326's reason and one of its own: the
      // span IS an amount and still earns the terracotta treatment, and
      // flipping it would de-highlight 3,266 spans to fix a duplicated glyph.
      out.push({ text: authored, isRef: true });
    } else {
      // FIX-7 (BUG-437) — the ref carries no ingredient name (the client
      // ingredient has no id to resolve `ingredientId` against), so the words
      // that FOLLOW the span stand in for it: "the 3 eggs in a bowl" → " eggs
      // in a bowl", "the 4-pound whole chicken" → "-pound whole chicken". That
      // is what lets "½ egg" become "1 egg" here exactly as on the line.
      const name = followingWords(text, r.charEnd);
      // A size descriptor ("4-pound") names its unit after the hyphen; the ref's
      // own unit is "". Read it only for the whole-bird check (rule 4).
      const birdUnit = r.unit || (/^-\s*([a-z]+)/i.exec(name)?.[1] ?? "");
      // WEB-4 (BUG-453) — "the 3-pound chicken" is a whole bird too: give the
      // bird rule its kind, its weight unit and the ref's own quantity (the
      // floor), and round it as that weight (¼ lb steps), not as a count.
      const hyphenBird = r.unit ? null : HYPHEN_BIRD.exec(text.slice(r.charEnd));
      const birdName = hyphenBird ? `whole ${hyphenBird[2]}` : name;
      // WEB-4b (BUG-454) — `multiplier` is the step's DISH factor; "1 turkey
      // neck" is one neck per bird. WEB-4c (BUG-464) — "8 skewers" is eight
      // skewers at any size (the words up to the first preposition: "8 flour
      // tortillas in foil" is not equipment). WEB-4c (BUG-462) — a bird's own
      // size is per bird: in a dish of two birds by count, "a frozen 14-lb
      // turkey" is still 14 lb (the dish factor ÷ the birds).
      const amount = isEquipment(name)
        ? r.quantity * birds.birds
        : isBirdPart(name)
          ? r.quantity * birds.parts
          : r.quantity * wholeItemMultiplier(hyphenBird ? multiplier / birds.birds : multiplier, birdUnit, birdName, r.quantity);
      const scaled = hyphenBird ? formatQuantity(amount, hyphenBird[1], "") : formatQuantity(amount, r.unit, name);
      // BUG-321 — the unit is a WORD here, same as on an ingredient line, and
      // pluralized on the DISPLAYED amount so "1 cups" cannot happen. FIX-7 —
      // and singularized there too: the ref's unit is authored ("pounds").
      const unit = r.unit
        ? unitWordFor(r.unit, displayedQuantity(amount, r.unit, name))
        : "";
      out.push({ text: unit ? `${scaled} ${unit}` : scaled, isRef: true });
    }
    cursor = r.charEnd;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), isRef: false });
  return out.length > 0 ? out : [{ text, isRef: false }];
}
