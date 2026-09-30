// ─────────────────────────────────────────────────────────────────────────────
// THE BROWSER'S OWN RULES — B-R1…B-R3.
//
// 🔴 WHY THERE ARE ANY AT ALL, when the point of this harness is to reuse the
// census checkers rather than write new detectors.
//
// The censuses render through the phone's format modules and score the STRING
// those modules return. That is most of the row — but not the row. Three things
// about the grocery screen exist only after React has run, and no server-side
// harness can reach them:
//
//   1. WHETHER THE SCREEN SHOWS THE ROW AT ALL. The census scores 64 composed
//      lines whether or not the list renders 64, 63, or a spinner. A row lost
//      to a virtualised list, a filter, or a section that failed to expand is
//      invisible to it and glaring in a screenshot.
//
//   2. R3's THREE SENTENCES. `app/grocery-list/[id].tsx:1527` replaces the need
//      parenthetical with `recurringDetail(item.recurringFacets)` —
//      "5 limes — 2 recurring + 9 for meals". That sentence is composed CLIENT
//      SIDE from a wire field, and `renderRow()` in grocery-census/census.ts
//      does not call `recurringDetail` at all. So the census's `line` for a
//      recurring row is NOT what the shopper reads, and D6's glyph check and
//      D7's R3 arm both score text the screen never shows. The three ruled
//      forms (D-WS9-188) have no server-side detector anywhere.
//
//   3. THEREFORE THE GLYPH LADDER AND BUG-317's "each" RULE ARE UNCHECKED ON
//      THAT SENTENCE. B-R3 walks the rendered text, which is the only place the
//      two halves of the row appear together.
//
// Every rule here is a PREDICATE OVER TEXT, never an exact-text assertion: it
// asks "is there a raw decimal anywhere in the need column", not "does the row
// say ½ cup". The AI parts vary run to run and the rules must not.
// ─────────────────────────────────────────────────────────────────────────────
import type { GroceryItemWire } from "./api";

export interface RuleResult {
  rule: string;
  title: string;
  /** null when the rule had no candidates — 0-of-0, not a pass. */
  pass: boolean | null;
  candidates: number;
  violations: { where: string; detail: string; offendingText: string }[];
  /** Free-form context a reader needs to judge the number. */
  note?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** One haystack for containment tests, plus the line list for reporting. */
function haystack(text: string[]): string {
  return norm(text.join("  "));
}

// ── B-R1 — the screen shows every row the wire returned ─────────────────────

export function bR1_everyRowRendered(
  items: GroceryItemWire[],
  text: string[],
): RuleResult {
  const live = items.filter((i) => !i.deletedAt);
  const hay = haystack(text);
  const violations: RuleResult["violations"] = [];
  for (const it of live) {
    // The row's NAME is the anchor. The pack prefix and the need are composed
    // (and for a recurring row, replaced), so the display name is the only part
    // guaranteed to survive every branch.
    const name = norm(it.displayName);
    // A resolved ambiguity renders userResolvedTo instead (WS7-7-A B5).
    const shown = it.userResolvedTo ? norm(it.userResolvedTo) : name;
    if (!hay.includes(shown) && !hay.includes(name)) {
      violations.push({
        where: `item ${it.id.slice(0, 8)}`,
        detail: `the wire returned "${it.displayName}" but no rendered text contains it`,
        offendingText: it.displayName,
      });
    }
  }
  return {
    rule: "B-R1",
    title: "every row the wire returned is on the screen",
    pass: live.length === 0 ? null : violations.length === 0,
    candidates: live.length,
    violations,
    note: `${live.length} live row(s) on the wire; ${text.length} rendered text run(s) on screen`,
  };
}

// ── B-R2 — R3's three ruled forms actually render ────────────────────────────

export async function bR2_recurringFormsRender(
  items: GroceryItemWire[],
  text: string[],
): Promise<RuleResult & { branches: Record<string, number>; sentences: string[] }> {
  const { recurringDetail } = await import("../../lib/format/recurringLine");
  const hay = haystack(text);
  const recurring = items.filter((i) => !i.deletedAt && i.isRecurringItem);
  const violations: RuleResult["violations"] = [];
  const branches: Record<string, number> = {
    summed: 0,
    default_purchase: 0,
    recurring_only: 0,
  };
  /** The composed sentences, handed to B-R3 — the only text "each" is scanned in. */
  const sentences: string[] = [];

  for (const it of recurring) {
    const facets = (it as unknown as { recurringFacets?: unknown }).recurringFacets;
    const line = recurringDetail(facets as never) as { detail: string; branch: string } | null;
    if (!line) {
      violations.push({
        where: `${it.displayName}`,
        detail:
          "row is isRecurringItem but carries no recurringFacets, so the screen can " +
          "render no R3 sentence for it",
        offendingText: it.displayName,
      });
      continue;
    }
    branches[line.branch] = (branches[line.branch] ?? 0) + 1;
    sentences.push(line.detail);
    if (!hay.includes(norm(line.detail))) {
      violations.push({
        where: `${it.displayName} (${line.branch})`,
        detail: `recurringDetail composes "${line.detail}" but it is not in the rendered text`,
        offendingText: line.detail,
      });
    }
  }

  return {
    rule: "B-R2",
    title: "R3 — each recurring row renders the sentence its facets compose",
    pass: recurring.length === 0 ? null : violations.length === 0,
    candidates: recurring.length,
    violations,
    branches,
    sentences,
    note:
      `branches seen — summed ${branches.summed}, default_purchase ${branches.default_purchase}, ` +
      `recurring_only ${branches.recurring_only}. All three of D-WS9-188's ruled forms need ` +
      `a run where each is non-zero; a zero is missing coverage, not a failure.`,
  };
}

// ── B-R3 — the glyph ladder and BUG-317's "each", on the pixels ─────────────

/**
 * A raw decimal in a quantity position. Deliberately narrow: a temperature
 * ("425°F"), a percentage, and a PACK SIZE ("1 package (0.25 oz)", "1.5 lb
 * bag") are the store's own words, not the need column.
 *
 * ── ⚠️ NARROWED TWICE. The second time was a regex bug, not a ruling ────────
 *
 * Run 5 of the first full pass reported one violation: `0.2` in
 * "1 package (0.25 oz) instant yeast". The unit exclusion was already there and
 * it was defeated by BACKTRACKING — `(\d+\.\d+)` matched "0.25", the lookahead
 * saw " oz" and rejected it, so the engine backed off to "0.2", whose lookahead
 * then saw "5 oz" and passed. `(?!\d)` pins the decimal to its full length so
 * it cannot shrink out from under its own exclusion.
 *
 * Worth keeping as a comment because it is the failure mode of every
 * lookahead-guarded numeric pattern, and the symptom — a captured value that is
 * a PREFIX of the number actually on screen — is the tell.
 */
const RAW_DECIMAL =
  /(?<![\d.°%$])(\d+\.\d+)(?!\d)(?!\s*(?:°|%|oz|ounces?|ml|l\b|g\b|kg|lb|pound|inch|in\b|cm|mm|%))/i;

/** BUG-317 / [grocery] F5.5 — "1 each for meals" is not English. */
const BARE_EACH = /\b\d+\s+each\b/i;

// ── ⚠️ THIS DETECTOR WAS NARROWED AFTER ITS FIRST RUN, AND THE NARROWING IS
//    THE POINT ────────────────────────────────────────────────────────────────
//
// The first version applied BARE_EACH to every rendered line and reported 21
// violations of 161 on run 1 — all of them the NEED PARENTHETICAL: "(4 each)",
// "(12 each)", "(1 each)". Every one was a false positive, and the authority
// says so twice:
//
//   • BUG-160's entry in the bug log quotes Hans ruling the shape acceptable
//     outright: "that should work better and say `1 orange bell pepper
//     (1 pepper)` or `(1 each)`." The parenthetical is allowed to say "each".
//   • lib/__tests__/grocery-format.test.ts:84 asserts
//     `pluralizeNeedUnit("each", 3) === "each"` with the comment "not in the
//     allow-list" — the app intends the pass-through.
//
// BUG-317's ruling ("a count unit is a placeholder for the ABSENCE of a unit")
// and [grocery] F5.5's fix landed on the INGREDIENT LINES and on the RECURRING
// SENTENCE — "— recurring; 1 each for meals" → "1 for meals". So the rule is
// real and its scope is the recurring sentence, which is exactly the text the
// census cannot see. BARE_EACH now runs on those sentences ONLY.
//
// The census README records three of its own detectors being narrowed the same
// way, for the same reason: a detector that reports a ruled shape as a defect
// buries the real ones.

export function bR3_glyphsAndEach(
  text: string[],
  recurringSentences: string[] = [],
): RuleResult {
  const violations: RuleResult["violations"] = [];
  let candidates = 0;

  // ── the glyph ladder: every rendered line that carries a quantity ────────
  for (const line of text) {
    if (!/\d/.test(line)) continue;
    candidates++;
    const dec = RAW_DECIMAL.exec(line);
    if (dec) {
      violations.push({
        where: "rendered text",
        detail: `raw decimal "${dec[1]}" off the glyph ladder (½ ⅓ ¼ … are the ruled forms)`,
        offendingText: line,
      });
    }
  }

  // ── "each": the recurring sentence only (see the narrowing note above) ───
  for (const s of recurringSentences) {
    const each = BARE_EACH.exec(s);
    if (each) {
      violations.push({
        where: "R3 recurring sentence",
        detail:
          `"${each[0]}" in a recurring clause — BUG-317 / [grocery] F5.5: a count unit is ` +
          `the ABSENCE of a unit, never a word, in this sentence`,
        offendingText: s,
      });
    }
  }

  return {
    rule: "B-R3",
    title: 'glyph ladder everywhere + no bare "each" in an R3 recurring sentence',
    pass: candidates === 0 && recurringSentences.length === 0 ? null : violations.length === 0,
    candidates,
    violations,
    note:
      `${candidates} rendered line(s) carried a digit; ${recurringSentences.length} recurring ` +
      `sentence(s) scanned for "each". The need parenthetical is NOT scanned for "each" — ` +
      `BUG-160 rules "(1 each)" acceptable there.`,
  };
}

// ── the screen-shape sanity rules, one per screen ───────────────────────────
//
// These are not census rules and not render rules — they are the "did the
// screen actually arrive" gate, without which every rule above scores a blank
// page as a pass. Kept separate and named so a reader can see that the flow
// reached each destination.

export function screenReached(
  screen: string,
  text: string[],
  mustContain: RegExp[],
): RuleResult {
  const hay = haystack(text);
  const violations: RuleResult["violations"] = [];
  for (const re of mustContain) {
    if (!re.test(hay)) {
      violations.push({
        where: screen,
        detail: `nothing on the screen matched ${re}`,
        offendingText: text.slice(0, 8).join(" | ").slice(0, 300),
      });
    }
  }
  // An error surface is never a reached screen, whatever else matched.
  if (/something went wrong|couldn't load|failed to load|try again/.test(hay)) {
    violations.push({
      where: screen,
      detail: "the screen rendered an error surface",
      offendingText: text.slice(0, 12).join(" | ").slice(0, 400),
    });
  }
  return {
    rule: `SCREEN:${screen}`,
    title: `${screen} rendered`,
    pass: violations.length === 0,
    candidates: mustContain.length,
    violations,
    note: `${text.length} rendered text run(s)`,
  };
}
