// WS9 D-WS9-189 A1 — chat-Claude's triage of the 99 review rows, September 1 2026.
//
// D-WS9-203: chat-Claude reads the sheet first and Hans sees only what
// chat-Claude cannot settle. 99 rows in, 2 out. Everything below is a decision
// already made; this file applies it so the sheet carries the outcome rather
// than the question.
//
// Each entry becomes a `human-reviewed` row carrying the `reviewed ` marker, so
// `--apply` treats it as a human verdict and never re-judges it.

export interface TriageRuling {
  a: string;
  b: string;
  label: "SYNONYM" | "COMPONENT" | "DISTINCT" | "SUBSUMES";
  /** Written into judge_reason after the `reviewed <date>: ` prefix. */
  why: string;
  /** SUBSUMES only. */
  genericIs?: string;
}

// ── B — arbiter_still_unsure, 2 of 4 settled ───────────────────────────────
//
// The other two were already right and are left alone: `medium carrots ~
// shredded carrots` DISTINCT, and `sliced radishes ~ thinly sliced radish`
// SYNONYM.
export const TRIAGE_B: TriageRuling[] = [
  // The two the arbiter could not settle but chat-Claude confirmed were already
  // right. Recorded as reviewed rather than left flagged: a confirmed row and an
  // unexamined one are different facts, and only one of them should reach a
  // human again.
  {
    a: "medium carrots",
    b: "shredded carrots",
    label: "DISTINCT",
    why:
      "confirmed correct — 'shredded carrots' is a pre-shredded bag, a different purchase from whole carrots " +
      "of any size",
  },
  {
    a: "sliced radishes",
    b: "thinly sliced radish",
    label: "SYNONYM",
    why:
      "confirmed correct — both are prep of the same radish. ⚠️ Both SHOULD have prep-collapsed to 'radish' " +
      "and did not: the prefix form falls outside the comma-suffix rule",
  },
  {
    a: "fresh ramen noodles",
    b: "ramen noodles",
    label: "DISTINCT",
    why:
      "subsumption must be SATISFIABLE and a dried packet does not satisfy a recipe calling for fresh ramen; " +
      "unqualified 'ramen noodles' is the dried/instant default variety, so it is a sibling (D-WS9-202)",
  },
  {
    a: "pickled ginger",
    b: "pickled ginger (beni shoga)",
    label: "DISTINCT",
    why:
      "bare pickled ginger defaults to gari, the pale sushi kind; beni shoga is red, shredded, and used on " +
      "gyudon and okonomiyaki. Gari does not satisfy beni shoga",
  },
];

// ── C-2 — the thick-cut class, 9 rows overturned to DISTINCT ───────────────
//
// 🔴 `thick-cut` IS NOT A SIZE QUALIFIER. It is a different product on the
// shelf and the bare name is the default variety — Hans's tortilla rule applied
// to a pattern nobody had spotted. Regular and thick-cut bacon are separate
// SKUs at separate prices; plain sandwich bread and Texas toast are separate
// loaves. A shopper holding regular bacon has not satisfied a recipe that wants
// thick-cut.
const THICK_CUT_WHY =
  "'thick-cut' is a default-variety marker, not a size grade: regular and thick-cut are separate SKUs at " +
  "separate prices, so the bare name does not subsume the thick-cut one";

export const TRIAGE_C2: TriageRuling[] = [
  { a: "bacon", b: "thick-cut bacon", label: "DISTINCT", why: THICK_CUT_WHY },
  { a: "bacon", b: "thick-cut bacon strips", label: "DISTINCT", why: THICK_CUT_WHY },
  { a: "bacon", b: "thick-cut bacon, cut into lardons", label: "DISTINCT", why: THICK_CUT_WHY },
  { a: "bacon strips", b: "thick-cut bacon strips", label: "DISTINCT", why: THICK_CUT_WHY },
  { a: "sandwich bread", b: "thick-cut white sandwich bread", label: "DISTINCT", why: THICK_CUT_WHY },
  { a: "thick-cut white sandwich bread", b: "white sandwich bread", label: "DISTINCT", why: THICK_CUT_WHY },
  { a: "sourdough bread", b: "thick-cut sourdough bread", label: "DISTINCT", why: THICK_CUT_WHY },
  { a: "corn tortilla chips", b: "thick-cut corn tortilla chips", label: "DISTINCT", why: THICK_CUT_WHY },
  { a: "thick-cut corn tortilla chips", b: "tortilla chips", label: "DISTINCT", why: THICK_CUT_WHY },
];

// ── C-3 — a prep form or a colour acting as the generic, 6 rows ────────────
//
// ⚠️ THE GENERALISABLE FINDING: A PREFIX PREP WORD DENOTES A PURCHASED PREPARED
// PRODUCT; A COMMA-SUFFIX PREP WORD DENOTES AN INSTRUCTION. `shredded carrots`
// is a bag you buy. `carrots, shredded` is something you do to carrots. The
// comma-suffix collapse rule is right and must NOT be extended to the prefix
// form.
const PREP_GENERIC_WHY =
  "a prep form cannot be generic over a whole vegetable; this row should have prep-collapsed to its base";

export const TRIAGE_C3: TriageRuling[] = [
  { a: "carrots, peeled and grated", b: "large carrot", label: "DISTINCT", why: PREP_GENERIC_WHY },
  { a: "carrots, peeled and grated", b: "medium carrots", label: "DISTINCT", why: PREP_GENERIC_WHY },
  { a: "carrots, peeled and sliced", b: "large carrot", label: "DISTINCT", why: PREP_GENERIC_WHY },
  { a: "carrots, peeled and sliced", b: "medium carrots", label: "DISTINCT", why: PREP_GENERIC_WHY },
  {
    a: "large carrot",
    b: "shredded carrots",
    label: "DISTINCT",
    why:
      "'shredded carrots' is a PRE-SHREDDED BAG, a different purchase entirely — consistent with the run's own " +
      "'medium carrots ~ shredded carrots' DISTINCT",
  },
  {
    a: "red beets",
    b: "small beet",
    label: "DISTINCT",
    why:
      "direction was inverted: 'red beets' is colour-specified while 'small beet' is colour-unspecified, so " +
      "neither is generic over the other",
  },
];

// ── C-4 — Hans-ruled, 3 rows ──────────────────────────────────────────────
export const TRIAGE_C4: TriageRuling[] = [
  {
    a: "pizza dough",
    b: "thin-crust pizza dough",
    label: "DISTINCT",
    why:
      "Hans: there are par-baked pizza doughs that may come in thin crust, so I say go as them being distinct",
  },
  {
    a: "soy sauce",
    b: "thin soy sauce",
    label: "DISTINCT",
    why:
      "Hans: 'thin soy sauce' should be called 'light soy sauce' and it's a different ingredient than soy sauce " +
      "(the rename is a separate catalog action, not this label)",
  },
  {
    a: "flour tortillas (10-inch)",
    b: "large flour tortillas",
    label: "SYNONYM",
    why: "Hans's size ruling: 'large' is burrito size and 10-inch is burrito size, so these name one purchase",
  },
];

// ── A — garlic, applied mechanically rather than row by row ────────────────
//
// Two entities are in play and the detector flagged the whole closure class
// instead of the crossing edge. The rule: every edge CROSSING the two groups is
// COMPONENT at 10 cloves/head; every edge WITHIN a group is SYNONYM.
export const GARLIC_CLOVE_GROUP = ["garlic", "fresh garlic", "garlic, minced"];
export const GARLIC_HEAD_GROUP = ["garlic head", "head of garlic", "whole garlic head"];
export const GARLIC_YIELD = { qty: 10, unit: "clove", coHarvestable: false };

/** True when a pair crosses the clove/head boundary. */
export function isGarlicCrossing(a: string, b: string): boolean {
  const inClove = (n: string): boolean => GARLIC_CLOVE_GROUP.includes(n);
  const inHead = (n: string): boolean => GARLIC_HEAD_GROUP.includes(n);
  return (inClove(a) && inHead(b)) || (inHead(a) && inClove(b));
}

/** True when a pair sits inside one garlic group. */
export function isGarlicWithin(a: string, b: string): boolean {
  const bothClove = GARLIC_CLOVE_GROUP.includes(a) && GARLIC_CLOVE_GROUP.includes(b);
  const bothHead = GARLIC_HEAD_GROUP.includes(a) && GARLIC_HEAD_GROUP.includes(b);
  return bothClove || bothHead;
}

export const ALL_TRIAGE: TriageRuling[] = [
  ...TRIAGE_B,
  ...TRIAGE_C2,
  ...TRIAGE_C3,
  ...TRIAGE_C4,
];

// ── C-1 — 71 rows accepted as genuine size-axis subsumption ────────────────
//
// Applied as a default rather than enumerated: any row still carrying
// `size_qualified_subsumes` after the overturns above is one chat-Claude
// accepted. Shrimp count grades, pork-chop thickness specs, ribeye cuts, rice
// noodle widths, carrot and potato sizes — the bare name is a genuine wildcard
// and the qualifier is a real size grade.
export const C1_ACCEPT_WHY =
  "accepted as genuine size-axis subsumption: the bare name is a wildcard on the size axis and the qualifier " +
  "is a real grade (chat-Claude triage)";
