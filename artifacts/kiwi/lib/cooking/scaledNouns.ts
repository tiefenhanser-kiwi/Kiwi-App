// CLIENT-8 B (BUG-618) — THE NOUN AFTER A SCALED COUNT, SAID FOR THE NUMBER SHOWN.
//
// buildAmountRefSegments puts the scaled number in a unit-less ref's place
// ("Cut 2 limes" at 2 of 4 → "Cut 1 …") and used to keep the authored noun:
// Meal Detail's servings stepper read "1 limes". A plan's meal read already has
// its nouns agreed by the server (SERVER-10 E, api-server lib/feastScaleFrames.ts
// refNounEdits); the stepper, the Recipes tab's Cook Now and a dish have no plan
// item, so only the client can say them.
//
// ⚠️ KEEP IN SYNC with api-server src/lib/feastScaleFrames.ts (singularOf,
// pluralOf, NOUN_STOP, COUNT_NOUN, refNounEdits). It is the same rule, so a
// server-agreed step and a client-agreed one never differ. Two client facts:
//   - the client has no ref → ingredient mapping (its ingredient lines carry no
//     id), so the plural guard's "the food's own head noun" is any food of the
//     step's dish (`foods`);
//   - a step the server already agreed must not move again. Going plural, a
//     head that is already plural ("1 garlic cloves", the server's words for
//     ×2) is the head, and stays; going singular, a server-agreed step has no
//     plural head left.

//
// CLIENT-9 B (BUG-634) — SERVER-13 F's fix (3c24834c), ported: a range keeps its
// plural, mango and chili(l)ies singularise, a mass noun has no plural, "round" is
// a count noun. Both sides read api-server src/lib/__tests__/shared/scaledNounVectors.mts.

const NOUN_STOP = /^(?:and|or|with|into|in|to|for|from|of|on|over|until|at|then|each|the|a|an)$/i;
/** The words that count a food whatever its name says ("1 garlic clove", "1 celery stalk"). */
// CLIENT-9 B — "round" ("1 refrigerated pie dough round"): without it the head was
// the food's own "dough", and ×2 wrote "doughs round".
const COUNT_NOUN = /^(?:clove|stalk|rib|sprig|leaf|head|slice|piece|strip|wedge|stick|packet|pouch|ball|half|heart|fillet|breast|thigh|yolk|white|ear|bulb|round)$/i;
/** Foods measured, never counted: said the same for one and for many. */
const MASS_NOUN = /^(?:dough|powder|flour|sugar|rice|salt|butter|milk|cream|water|oil|paste|broth|stock|juice|zest)$/i;
/**
 * A range ("Place 1–2 fish strips"): the ref is "1–2" and its number the middle (1.5),
 * so at ×0.5 it read as one and wrote "1–2 fish strip". A range keeps its plural; it
 * can still go plural ("½–1 lime" at ×2). The ref itself, or a ref after "N–", "N to", "N or".
 */
const RANGE_REF = /\d\s*(?:[–—-]|to|or)\s*[\d½¼¾⅓⅔⅛]/i;
const RANGE_BEFORE = /\d\s*(?:[–—-]|to|or)\s*$/i;

/** "leaves" → "leaf", "potatoes" → "potato", "cherries" → "cherry", "jalapeños" → "jalapeño". */
export function singularOf(w: string): string {
  if (/(?:lea|loa|hal|shea)ves$/i.test(w)) return w.replace(/ves$/i, "f");
  if (/knives$/i.test(w)) return w.replace(/ves$/i, "fe");
  // CLIENT-9 B (BUG-634) — "mangoes" was "mangoe", "chilies" was "chily".
  if (/(?:tomato|potato|mango)es$/i.test(w)) return w.replace(/es$/i, "");
  if (/chill?ies$/i.test(w)) return w.replace(/es$/i, "");
  if (/[^aeiou]ies$/i.test(w)) return w.replace(/ies$/i, "y");
  if (/(?:ch|sh|x|ss)es$/i.test(w)) return w.replace(/es$/i, "");
  return w.replace(/s$/i, "");
}

/** "lime" → "limes", "leaf" → "leaves", "tomato" → "tomatoes", "cherry" → "cherries". */
export function pluralOf(w: string): string {
  if (/^(?:anise|zucchini|broccoli|shrimp|fish|salmon|cod|tuna|lettuce|celery)$/i.test(w)) return w;
  // CLIENT-9 B (BUG-634) — a mass noun has no plural ("1 onion powder" is not
  // "powders"); chili is the catalog's "chilies".
  if (MASS_NOUN.test(w)) return w;
  if (/chill?i$/i.test(w)) return `${w.slice(0, -1)}ies`;
  if (/(?:lea|loa|hal|shea)f$/i.test(w)) return w.replace(/f$/i, "ves");
  if (/mango$/i.test(w)) return `${w}es`;
  if (/kni(?:fe)$/i.test(w)) return w.replace(/fe$/i, "ves");
  if (/(?:tomato|potato)$/i.test(w)) return `${w}es`;
  if (/[^aeiou]y$/i.test(w)) return w.replace(/y$/i, "ies");
  if (/(?:s|x|z|ch|sh)$/i.test(w)) return `${w}es`;
  return `${w}s`;
}

/** Each food's head noun, singular: "red bell pepper" → pepper, "bay leaves" → leaf. */
export function foodHeads(foods: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const f of foods) {
    const last = f.toLowerCase().split(/[,(]/)[0].split(/[^a-zà-ÿ'-]+/).filter(Boolean).slice(-1);
    for (const w of last) out.add(singularOf(w));
  }
  return out;
}

export interface NounEdit {
  start: number;
  end: number;
  text: string;
}

const isPlural = (w: string) => /s$/i.test(w) && !/(?:ss|us)$/i.test(w);

/**
 * The noun after a unit-less amount at `end` (the ref's charEnd), agreed with the
 * number shown: authored more than one and shown one or less goes singular,
 * authored one or less and shown more than one goes plural. The head is the last
 * noun-like word within five after the number, before a joining word. Going
 * plural it must name a food of the dish or be a count noun (the server's sweep:
 * a bare last-word rule wrote "lengthwises", "yellows"). Null when nothing moves.
 * CLIENT-9 B — `start` is the ref's charStart: a range never goes singular.
 */
export function refNounEdit(
  text: string,
  start: number,
  end: number,
  authored: number,
  shown: number,
  heads: ReadonlySet<string>,
): NounEdit | null {
  const range = RANGE_REF.test(text.slice(start, end)) || RANGE_BEFORE.test(text.slice(0, start));
  const toOne = authored > 1 && shown <= 1 && !range;
  const toMany = authored <= 1 && shown > 1;
  if (!toOne && !toMany) return null;
  const after = /^((?:\s+[A-Za-zÀ-ÿ'-]+){1,5})/.exec(text.slice(end))?.[1] ?? "";
  let head: RegExpMatchArray | undefined;
  for (const w of after.matchAll(/[A-Za-zÀ-ÿ'-]+/g)) {
    if (NOUN_STOP.test(w[0])) break;
    if (toOne) {
      if (isPlural(w[0])) head = w;
      continue;
    }
    const one = isPlural(w[0]) ? singularOf(w[0]) : w[0];
    if (heads.has(one.toLowerCase()) || COUNT_NOUN.test(one)) head = w;
  }
  if (!head) return null;
  if (toMany && isPlural(head[0])) return null; // already said for many
  const at = end + head.index!;
  const said = toOne ? singularOf(head[0]) : pluralOf(head[0]);
  if (said === head[0]) return null; // a mass noun: nothing to say differently
  return { start: at, end: at + head[0].length, text: said };
}
