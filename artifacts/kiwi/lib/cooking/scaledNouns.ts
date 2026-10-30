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

const NOUN_STOP = /^(?:and|or|with|into|in|to|for|from|of|on|over|until|at|then|each|the|a|an)$/i;
/** The words that count a food whatever its name says ("1 garlic clove", "1 celery stalk"). */
const COUNT_NOUN = /^(?:clove|stalk|rib|sprig|leaf|head|slice|piece|strip|wedge|stick|packet|pouch|ball|half|heart|fillet|breast|thigh|yolk|white|ear|bulb)$/i;

/** "leaves" → "leaf", "potatoes" → "potato", "cherries" → "cherry", "jalapeños" → "jalapeño". */
export function singularOf(w: string): string {
  if (/(?:lea|loa|hal|shea)ves$/i.test(w)) return w.replace(/ves$/i, "f");
  if (/knives$/i.test(w)) return w.replace(/ves$/i, "fe");
  if (/(?:tomato|potato)es$/i.test(w)) return w.replace(/es$/i, "");
  if (/[^aeiou]ies$/i.test(w)) return w.replace(/ies$/i, "y");
  if (/(?:ch|sh|x|ss)es$/i.test(w)) return w.replace(/es$/i, "");
  return w.replace(/s$/i, "");
}

/** "lime" → "limes", "leaf" → "leaves", "tomato" → "tomatoes", "cherry" → "cherries". */
export function pluralOf(w: string): string {
  if (/^(?:anise|zucchini|broccoli|shrimp|fish|salmon|cod|tuna|lettuce|celery)$/i.test(w)) return w;
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
 */
export function refNounEdit(
  text: string,
  end: number,
  authored: number,
  shown: number,
  heads: ReadonlySet<string>,
): NounEdit | null {
  const toOne = authored > 1 && shown <= 1;
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
  return { start: at, end: at + head[0].length, text: toOne ? singularOf(head[0]) : pluralOf(head[0]) };
}
