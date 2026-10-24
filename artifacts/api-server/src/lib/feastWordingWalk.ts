// THX-3d round 2 (L) — WHAT PREP THE FEAST MADE, COOK MODE USES BY ITS NAME. The walk.
//
// Two rules over a feast dish's steps AS COOK MODE WORDS THEM (feastCookWording), each
// a finding when broken:
//   loose  — a step adds a food a prep container holds for the dish (an amount, or a
//            list beside one) without naming the container: Small's "2 sprigs finely
//            chopped rosemary" with the rosemary on the turkey's plate; a mix's member
//            beside the mix at its entry step (Vegetarian's cranberry sugar).
//   double — a food is in a mix AND added by a step for the same moment: what the mix
//            holds plus what the other steps add is more than the dish lists (New
//            Twist's cheesecake beat in ⅓ cup sugar and whisked in the mix that held it).
// A "Skip if you prepped. Otherwise, …" step is the prep itself, said for a cook who did
// not prep: exempt. Read-only; thx3dFeastWalk (THX3D_DB=1) runs it on the five feasts.

import { convertAmount } from "./feastAmountWalk";
import { measured, mentionsOf, WORKED_BEFORE, type FeastDishFacts, type Mention, type WordingRow, type WordingStep } from "./feastCookWording";
import { ingredientGroupKey } from "./ingredientRelations";

export interface WordingFinding { stepIndex: number; kind: "loose" | "double" | "recut" | "protein" | "bare"; detail: string }
export interface WalkWordingRow extends WordingRow { quantity: number; unit: string }

const DAY_PREFIX = /^(\s*(?:Make ahead \([A-Za-z]+(?: night)?\)|On [A-Za-z]+day|Thaw \(start [A-Za-z]+\))\s*:\s*)/i;
const SKIP = /^\s*skip if you prepped\b/i;
/** A cut verb right before a food: its amount, article and adverbs between. */
const RECUT = /\b(?:cut|chop|mince|slice|dice)\s+(?:(?:the|a|an|of|finely|thinly|roughly|coarsely)\s+|[\d½¼¾⅓⅔⅛⅜⅝⅞./-]+\s+|(?:pounds?|lbs?|oz|ounces?|cups?|tablespoons?|teaspoons?|cloves?)\s+)*$/i;
/** The cut a verb asks for, as a prepped note says it ("slice" → "slic", "cut" → "cut"). */
const STEM: Record<string, RegExp> = { cut: /\bcut\b/, chop: /\bchop/, mince: /\bminc/, slice: /\bslic/, dice: /\bdic/ };

/** The step with every container it names blanked (so "Stuffing onion & celery" is not an onion). */
function masked(step: WordingStep, names: readonly string[]): WordingStep {
  // (PREP-3 3c — and a group of foods, as the reworder writes it: "the squeezed cucumber, finely
  // minced garlic and chopped dill you prepped". A list with an amount in it is not one.)
  let text = step.text.replace(/\bthe (?:[^,;.\d]+?, )*[^,;.\d]*? you prepped\b/gi, (m) => " ".repeat(m.length));
  for (const n of [...names].sort((a, b) => b.length - a.length)) if (n) text = text.split(n).join(" ".repeat(n.length));
  return { ...step, text };
}

export function feastWordingFindings(
  steps: readonly WordingStep[],
  rows: readonly WalkWordingRow[],
  facts: FeastDishFacts | undefined,
  titles: readonly string[] = [],
  /**
   * PREP-3 3b — a week's three more (Cook Mode words from what the cook ticked):
   *   recut   — a cut verb (cut, chop, mince, slice, dice) on a food a container holds
   *             for the dish ("Cut the red onion into 1½-inch chunks", on the Monday plate);
   *   protein — a protein cut in Proteins named with its cut in a day step ("Cut the
   *             2 pounds of chicken thighs into 1½-inch chunks");
   *   bare    — a shared tub's food worked by a step without "you prepped" ("Combine the
   *             romaine, …" with the romaine in the shared tub).
   */
  opts: { weeknight?: boolean } = {},
): WordingFinding[] {
  if (!facts) return [];
  const out: WordingFinding[] = [];
  const names = [...facts.mixes.map((m) => m.name), ...facts.cuts.map((c) => c.into ?? "")];
  const inMix = (mix: FeastDishFacts["mixes"][number], m: Mention) => mix.ids.has(m.id) || mix.keys.has(m.key);
  const live = steps.filter((s) => !SKIP.test(s.text.replace(DAY_PREFIX, "")));
  // A mix's entry step: the step that names it.
  const entryOf = new Map(facts.mixes.map((x) => [x.name, live.find((s) => s.text.includes(x.name))?.stepIndex ?? null]));
  for (const s of live) {
    const view = masked(s, names);
    const ms = measured(view.text, mentionsOf(view, rows, titles));
    for (const m of ms) {
      const said = s.text.slice(m.start, m.end);
      const cut = facts.cuts.find((c) => (c.id === m.id || c.key === m.key) && c.into && m.cut.every((w) => c.note.includes(w)));
      if (cut) out.push({ stepIndex: s.stepIndex, kind: "loose", detail: `"${said}" — prepped into ${cut.into}` });
      const mix = facts.mixes.find((x) => inMix(x, m) && entryOf.get(x.name) === s.stepIndex);
      if (mix) out.push({ stepIndex: s.stepIndex, kind: "loose", detail: `"${said}" — beside the ${mix.name} that holds it` });
    }
  }
  if (opts.weeknight) {
    for (const s of live) {
      const prepped = [...s.text.matchAll(/\bthe [^,;.]*? you prepped\b/gi)].map((x) => [x.index!, x.index! + x[0].length]);
      for (const m of mentionsOf(s, rows, titles)) {
        if (prepped.some(([a, b]) => m.start >= a && m.end <= b)) continue;
        const said = s.text.slice(m.start, m.end);
        const clause = s.text.slice(0, m.start).split(/[;:.]\s+/).pop() ?? "";
        const verb = (RECUT.exec(clause)?.[0] ?? (/^cut\b/i.test(clause.trim()) && /^\s+into\b/i.test(s.text.slice(m.end)) ? "cut" : "")).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
        const same = (c: { id: string; key: string }) => c.id === m.id || c.key === m.key;
        // (The cut it was prepped to: "slice the steak thinly" after the sear is not the trim.)
        const asked = (c: { note: string }) => !!verb && (STEM[verb]?.test(c.note) ?? false);
        const protein = (facts.proteins ?? []).find((c) => same(c) && asked(c));
        const cut = facts.cuts.find((c) => same(c) && c.into && asked(c));
        if (protein) out.push({ stepIndex: s.stepIndex, kind: "protein", detail: `"${said}" — cut in Proteins (${protein.note.trim()})` });
        else if (cut) out.push({ stepIndex: s.stepIndex, kind: "recut", detail: `"${said}" — prepped into ${cut.into}` });
        const tub = facts.cuts.find((c) => same(c) && c.kind === "shared");
        if (tub && !verb && WORKED_BEFORE.test(clause)) out.push({ stepIndex: s.stepIndex, kind: "bare", detail: `"${said}" — in the ${tub.into} tub, not said "you prepped"` });
      }
    }
  }
  // double: what a mix holds plus what the other steps add, over the dish's own line.
  for (const mix of facts.mixes) {
    for (const [key, held] of mix.amounts ?? []) {
      const lines = rows.filter((r) => ingredientGroupKey(r.name) === key);
      if (lines.length === 0) continue;
      const unit = lines[0].unit;
      const total = lines.reduce((t, r) => t + (convertAmount(r.quantity, r.unit, unit) ?? 0), 0);
      const inMixQ = convertAmount(held.qty, held.unit, unit);
      if (inMixQ === null) continue;
      let added = 0;
      const where: number[] = [];
      for (const s of live) {
        if (s.stepIndex === entryOf.get(mix.name)) continue;
        for (const r of s.amountRefs ?? []) {
          if (!lines.some((l) => l.ingredientId === r.ingredientId)) continue;
          const q = convertAmount(r.quantity, r.unit, unit);
          if (q === null) continue;
          added += q;
          where.push(s.stepIndex);
        }
      }
      if (added > 0 && inMixQ + added > total * 1.02 + 1e-6) {
        out.push({ stepIndex: where[0], kind: "double", detail: `${lines[0].name}: the ${mix.name} holds ${+inMixQ.toFixed(3)} ${unit} and step${where.length > 1 ? "s" : ""} ${where.map((x) => `#${x}`).join(", ")} add ${+added.toFixed(3)}; the dish lists ${+total.toFixed(3)}` });
      }
    }
  }
  return out;
}
