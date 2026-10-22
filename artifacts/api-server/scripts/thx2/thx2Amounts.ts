// THX-3c (F) — "ADD THE DICED ONIONS AND CELERY" NAMES ITS AMOUNTS.
//
// The stored feast steps add their cut food with no amount ("add the diced onions
// and celery and cook"), so Cook Mode has nothing to scale and the cook nothing to
// check the prep tub against. SAFE-1's writer rule says to reuse the numbers
// (storeFillPrompts.ts), and the generator did not. This rewrites such a phrase
// with the dish's own amounts, at the recipe's servings:
//
//   "add the diced onions and celery"  →  "add the 2 diced onions and 6 diced celery stalks"
//
// Only "the <cut> <food>[ and <food>]", where every food is one of the dish's own
// rows and the step names no amount for it yet. Anything else is left as written.
// Pure; patch.ts applies it (no AI) and re-derives the refs of the steps it changed.
// New generations get FINALIZE_RULES (h).

import { formatMeasure } from "../../src/lib/prepWeekAssembly";
import { proseNames } from "../../src/lib/prepMoments";
import { cutOf } from "../../src/lib/prepClasses";

export interface AmountRow {
  /** The row's own name ("yellow onion", "celery stalks"). */
  name: string;
  quantity: number;
  unit: string;
  /** Its preparation note: a listed food after the first takes ITS OWN cut ("roughly chopped"). */
  note?: string | null;
}

const CUT = String.raw`(?:(?:finely|thinly|roughly|coarsely)\s+)?(?:diced|chopped|minced|sliced|smashed|quartered|halved|grated|shredded|crushed|cubed|julienned)`;
/** Words that end a food phrase: a verb, a preposition, a list joint. */
const STOP = /^(and|or|to|into|in|over|with|until|on|then|for|from|at|of|by|as|cook|stir|toss|add|until|while|plus)$/i;
/** The words right before a list that adds food: "add", "stir in", "stuff the cavity with". */
const ADDING = /\b(?:add|stir in|toss|combine|fold in|scatter|stuff\b[^.;]*\bwith|with|into)\s+$/i;
/** A count noun a row's name may end with, kept when the step's phrase leaves it off. */
const COUNT_NOUN = /\s(stalks?|cloves?|sprigs?|heads?|bulbs?|ribs?)$/i;

const SHAPE_END = /\s(thirds|halves|quarters|pieces|chunks|wedges)$/i;

/**
 * THX-3d — the repair for what THX-3c's naming already wrote: "2 celery thirds stalks"
 * → "2 celery stalks, cut into thirds,". Round 3 (U): no parentheses — and THX-3d's own
 * "(cut into thirds)" reads the same way. Idempotent (the repaired text never matches).
 */
export function repairShapeCounts(text: string): string {
  return text
    .replace(/\b(\d+) ([a-z]+) (thirds|halves|quarters|pieces|chunks|wedges) (stalks?|cloves?|ribs?|sprigs?)\b/gi, "$1 $2 $4, cut into $3,")
    .replace(/ \(cut into (thirds|halves|quarters|pieces|chunks|wedges)\)/gi, ", cut into $1,");
}

/** The food phrase that starts at `rest`: its words up to a stop word or punctuation. */
function phraseAt(rest: string): string {
  const words: string[] = [];
  for (const m of rest.matchAll(/[A-Za-zÀ-ÿ'-]+|[^A-Za-zÀ-ÿ'\s-]/g)) {
    const w = m[0];
    if (!/^[A-Za-zÀ-ÿ'-]+$/.test(w) || STOP.test(w) || words.length >= 4) break;
    words.push(w);
  }
  return words.join(" ");
}

/** The amount in front of a food: "2", "4 cloves", "¼ cup"; bare when the phrase already says the unit. */
function amountFor(row: AmountRow, phrase: string): { amount: string; phrase: string } {
  const full = formatMeasure(row.quantity, row.unit, row.name);
  const [num, ...unitWords] = full.split(" ");
  const unit = unitWords.join(" ");
  const singular = (w: string) => w.replace(/s$/i, "");
  if (unit && new RegExp(`\\b${singular(unit)}s?\\b`, "i").test(phrase)) return { amount: num, phrase };
  // A bare count of a row named by its stalks ("6 each celery stalks") keeps the noun.
  let shown = phrase;
  const noun = COUNT_NOUN.exec(row.name)?.[1];
  if (!unit && noun && !new RegExp(`\\b${singular(noun)}s?\\b`, "i").test(phrase)) {
    // THX-3d — "celery thirds" is 2 celery STALKS cut in thirds, never "2 celery thirds stalks".
    const shape = SHAPE_END.exec(phrase);
    shown = shape ? `${phrase.slice(0, shape.index)} ${noun.toLowerCase()}, cut into ${shape[1].toLowerCase()},` : `${phrase} ${noun.toLowerCase()}`;
    if (shape) return { amount: num === "1" ? "1" : num, phrase: shown };
  }
  // "2 diced onion" → "2 diced onions" (a count above one, a singular head).
  if (!unit && Number.parseFloat(num) > 1 && !/s$/i.test(shown)) shown = /(ch|sh|x|o)$/i.test(shown) ? `${shown}es` : `${shown}s`;
  // THX-3c (item 4) — a count of one reads without the number: "the chopped onion".
  if (!unit && num === "1") return { amount: "", phrase: shown };
  return { amount: unit ? `${num} ${unit}` : num, phrase: shown };
}

/**
 * The step with its cut foods' amounts named. `measured` = the rows (by name) the
 * step already gives an amount for (its amountRefs): those are left alone.
 */
export function nameCutAmounts(text: string, rows: readonly AmountRow[], measured: ReadonlySet<string> = new Set()): string {
  const head = (s: string) => (s.toLowerCase().trim().split(/\s+/).pop() ?? "").replace(/(?:es|s)$/, "");
  const rowFor = (phrase: string) => {
    if (!phrase) return undefined;
    const open = rows.filter((r) => r.quantity > 0 && !measured.has(r.name));
    const hits = open.filter((r) => proseNames(phrase, r.name));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return undefined;
    // "the sliced mushrooms" for the dish's one "cremini mushrooms" row: its head noun.
    const byHead = open.filter((r) => head(r.name) === head(phrase));
    return byHead.length === 1 ? byHead[0] : undefined;
  };
  // THX-3c (item 4) — "the <cut> <food>", or "the <food>" opening a LIST of the dish's
  // cut foods ("stuff the cavity with the lemon halves, quartered onion, …").
  const re = new RegExp(String.raw`\b([Tt]he) (?:(${CUT}) )?`, "g");
  const leadCut = new RegExp(String.raw`^(${CUT}) `, "i");
  const words = (...xs: (string | undefined)[]) => xs.filter((x) => !!x).join(" ");
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index!;
    if (at < last) continue;
    // A number already in front ("the 2 diced onions") is no food phrase — nothing to do.
    const afterLead = at + m[0].length;
    const first = phraseAt(text.slice(afterLead));
    const r1 = rowFor(first);
    if (!r1) continue;
    let end = afterLead + first.length;
    const a1 = amountFor(r1, first);
    let rewritten = `${m[1]} ${words(a1.amount, m[2], a1.phrase)}`;
    // "… and celery", "…, celery, and carrots", "…, quartered onion": each a row of the
    // dish with no number of its own, with its own cut (the one it is written with, or
    // its note's).
    const used = new Set([r1]);
    for (;;) {
      const joint = /^(?:,\s*and |,\s*| and )/.exec(text.slice(end));
      if (!joint) break;
      const rest = text.slice(end + joint[0].length);
      const adj = leadCut.exec(rest);
      const next = phraseAt(rest.slice(adj ? adj[0].length : 0));
      const r = next ? rowFor(next) : undefined;
      if (!r || used.has(r)) break;
      used.add(r);
      const a = amountFor(r, next);
      rewritten += `${joint[0]}${words(a.amount, adj?.[1] ?? cutOf([r.note ?? ""]) ?? undefined, a.phrase)}`;
      end += joint[0].length + (adj ? adj[0].length : 0) + next.length;
    }
    // Without a cut word in front, only a LIST OF CUT FOODS being added counts: "until
    // the onion is soft" is no list, "Remove the cinnamon stick and cloves" and "Pat the
    // neck and giblets" are no cut foods, and "Drain the potatoes and garlic" adds nothing.
    if (!m[2]) {
      const cutNoted = (r: AmountRow) => !!cutOf([r.note ?? ""]) || /\b(halved|quartered|halves)\b/i.test(r.note ?? "");
      if (used.size < 2 || ![...used].every(cutNoted) || !ADDING.test(text.slice(Math.max(0, at - 40), at))) continue;
    }
    out += text.slice(last, at) + rewritten;
    last = end;
  }
  return out + text.slice(last);
}
