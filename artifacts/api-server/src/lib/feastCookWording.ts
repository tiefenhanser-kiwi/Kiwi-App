// THX-3d (C, R2) — PREP FEEDS COOK: A FEAST DISH'S COOK STEPS, WORDED AT READ TIME.
//
// Hans, October 21: in Prep the feast he zested and juiced the orange, rinsed the
// cranberries and measured the cranberry mix, marked them done — and Monday's Cook Mode
// opened with "zest and juice the orange, set aside", then "combine 9⅝ oz rinsed
// cranberries, 1½ cups sugar, the orange juice and zest, ¼ cup water, 1 cinnamon stick
// and a pinch of salt". He asked for the most reliable shape, one that holds when a user
// swaps or adds a dish: "I'm also totally fine to have the steps in cook mode for the
// feast meals 'skip if you prepped. otherwise, zest and juice 3/4 orange and set aside'."
//
// So the words are produced HERE, when the meal is read in its plan, from the feast's
// own Prep the feast build (deterministic, no AI) — never written into the recipe, so a
// dish added to the feast is worded the same way, and nothing depends on a tick:
//
//   1. a step whose whole job Prep the feast did — every food it names was cut or
//      measured there, the way the step cuts it — opens "Skip if you prepped. Otherwise,";
//   3. at the step a mix enters (the first that states two of its members — the
//      closing line's rule), the members listed there name the MIX instead ("the
//      Cranberry-Orange Sauce dry mix"): the first becomes the mix, the others leave;
//   4. prepped produce is named by its container — only when one list in the step
//      names everything the dish's container holds ("the Pan Gravy vegetables you
//      prepped", "the yellow onion and celery you prepped"); a shared tub's food by the
//      tub, when the step cuts it that way ("the minced garlic you prepped"). A plate's
//      piles stay as written.
// (2, the split of a step that mixes prep and the rest, is content: patch.ts.)
//
// Only what a step MEASURES is touched — a food with an amount, or one in a list beside
// one — and only within one list: "until the cranberries burst", "dissolve the sugar"
// and a member in another clause stay as they are. Every surviving amountRef moves with
// its text; one in a removed item goes with it.

import type { PrismaClient } from "@prisma/client";
import { buildFeastSession, type PrepWeekBuild } from "./prepWeekBuild";
import { ingredientGroupKey } from "./ingredientRelations";
import { FEAST_MEAL_TAG, loadPrepWeekInput } from "./prepWeekAggregation";
import { dishScalesOf, scaleFrames } from "./feastScaleFrames";
import type { FeastLabelKind } from "./prepFeastLabels";

/**
 * GET /meals/:id?planItemId= — a feast meal read in its plan: each dish's steps
 * worded from that plan's Prep the feast. Returns the new text and refs by dish id
 * and step index (only the steps that change); empty for any other meal. The caller
 * must already have scoped the plan to the user (the plan item read does).
 */
export async function feastCookWordingFor(
  prisma: PrismaClient,
  args: { planId: string; userId: string; mealTags: readonly string[]; dishes: readonly { dishId: string; title: string; steps: readonly { stepIndex: number; text: string; amountRefs?: unknown }[] }[]; now?: Date },
): Promise<Map<string, Map<number, { text: string; amountRefs: WordingRef[] | null }>>> {
  const out = new Map<string, Map<number, { text: string; amountRefs: WordingRef[] | null }>>();
  if (!args.mealTags.includes(FEAST_MEAL_TAG) || args.dishes.length === 0) return out;
  const load = await loadPrepWeekInput({ planId: args.planId, userId: args.userId, prisma, ...(args.now ? { now: args.now } : {}) });
  const build = buildFeastSession(load);
  if (!build) return out;
  const facts = feastDishFacts(build);
  // Round 2 (O) — the counts this plan shows as one, and its servings, per dish.
  const scales = dishScalesOf(load);
  const rows = await prisma.dishIngredient.findMany({
    where: { dishId: { in: args.dishes.map((d) => d.dishId) } },
    select: { dishId: true, ingredientId: true, ingredient: { select: { canonicalName: true } } },
  });
  const titles = args.dishes.map((d) => d.title);
  for (const d of args.dishes) {
    const before = d.steps.map((s) => ({ stepIndex: s.stepIndex, text: s.text, amountRefs: Array.isArray(s.amountRefs) ? (s.amountRefs as WordingRef[]) : null }));
    const after = rewordFeastSteps(before, rows.filter((r) => r.dishId === d.dishId).map((r) => ({ ingredientId: r.ingredientId, name: r.ingredient.canonicalName })), facts.get(d.dishId), titles)
      .map((s) => scaleFrames(s, scales.get(d.dishId)));
    after.forEach((a, i) => {
      if (a.text === before[i].text) return;
      if (!out.has(d.dishId)) out.set(d.dishId, new Map());
      out.get(d.dishId)!.set(a.stepIndex, { text: a.text, amountRefs: a.amountRefs });
    });
  }
  return out;
}

export interface WordingRef { ingredientId: string; quantity: number; unit: string; charStart: number; charEnd: number }
export interface WordingStep { stepIndex: number; text: string; amountRefs: WordingRef[] | null }
export interface WordingRow { ingredientId: string; name: string }

export interface FeastDishFacts {
  dishId: string;
  /** The mixes and jars Prep the feast fills for this dish (members by id and by food). */
  mixes: { name: string; ids: Set<string>; keys: Set<string> }[];
  /** Produce cut ahead for this dish: the food, the container it went into, its cut words. */
  cuts: { id: string; key: string; into: string | null; note: string; kind?: FeastLabelKind | null }[];
}

/** The per-dish facts of a feast session build (its kept steps; a portion held for cook day is not prepped). */
export function feastDishFacts(build: PrepWeekBuild): Map<string, FeastDishFacts> {
  const out = new Map<string, FeastDishFacts>();
  const of = (dishId: string) => {
    let f = out.get(dishId);
    if (!f) out.set(dishId, (f = { dishId, mixes: [], cuts: [] }));
    return f;
  };
  for (const st of build.stepPlan.steps) {
    if (st.demoted) continue;
    const hold = build.holds.get(st.stepKey);
    if (hold?.all) continue;
    const components = hold ? hold.keptComponents : st.components;
    if ((st.phase === "seasonings_dry" || st.phase === "sauces_marinades") && st.bowlName) {
      for (const c of components) {
        for (const m of c.measures) {
          if (!m.dishId) continue;
          const f = of(m.dishId);
          let mix = f.mixes.find((x) => x.name === st.bowlName);
          if (!mix) f.mixes.push((mix = { name: st.bowlName!, ids: new Set(), keys: new Set() }));
          if (m.ingredientId) mix.ids.add(m.ingredientId);
          mix.keys.add(ingredientGroupKey(c.ingredientName));
        }
      }
    }
    if (st.phase === "produce") {
      for (const c of components) {
        for (const m of c.measures) {
          if (!m.dishId) continue;
          // Round 2 (N) — the container's label and what it is (prepFeastLabels).
          of(m.dishId).cuts.push({ id: m.ingredientId ?? "", key: ingredientGroupKey(c.ingredientName), into: m.destination ?? null, note: `${m.preparationNote ?? ""} ${c.preparationNote ?? ""}`.toLowerCase(), kind: m.destination ? build.stepPlan.feastLabels?.kinds.get(m.destination) ?? null : null });
        }
      }
    }
  }
  return out;
}

const DAY_PREFIX = /^(\s*(?:Make ahead \([A-Za-z]+(?: night)?\)|On [A-Za-z]+day|Thaw \(start [A-Za-z]+\))\s*:\s*)/i;
/** The code-written raise and serve steps name dishes, not foods: never reworded. */
const CODE_WRITTEN = /^\s*(?:Raise the oven to \d{3}\s*°\s*F and put in|Serve the .+ with the )/i;
/** The words a step whose whole job is prep may use besides its foods. */
const PREP_WORD = /^(?:and|the|then|of|from|a|an|into|in|to|small|large|medium|bowl|set|aside|finely|thinly|roughly|coarsely|lightly|leaves?|stems?|zest|juice|peel|core|slice|sliced|dice|diced|mince|minced|chop|chopped|cut|trim|trimmed|halve|halved|quarter|quartered|grate|grated|pick|picked|strip|stripped|rinse|rinsed|over|measure|mix|whisk|combine|stir|together|discarding|any|soft|shriveled|bad|ones|seeds?|leave|leaving|some|for|more|heat|inch|chunks|pieces|rings|separate|keep|reserve|reserving|both|each|all|your|it|them|out|on|board|sprigs?|cloves?|stalks?|tablespoons?|teaspoons?|tbsp|tsp|cups?|oz|ounces?|lbs?|pounds?|pinch|seed|seeded|thick|wedges|cubes|slices)$/i;
/** Only foods and prep words in the text once the mentions are cut out. */
const onlyPrepWords = (text: string, ms: readonly Mention[], from = 0) =>
  ms.reduceRight((t, m) => t.slice(0, m.start) + " " + t.slice(m.end), text).slice(from)
    .split(/[\s,;:.()–\-/]+/).filter(Boolean).every((w) => PREP_WORD.test(w) || /^[\d½¼¾⅓⅔⅛⅜⅝⅞×x]+$/.test(w));
/** The cut words a step may ask of a food (each must be among the prepped cut's words). */
const CUT_WORDS = ["zest", "juice", "mince", "dice", "chop", "slice", "halve", "quarter", "smash", "grate", "trim", "peel", "rinse", "pick", "strip", "cube"];
const CITRUS = /\b(lemons?|limes?|oranges?|grapefruits?)$/i;
/** After a food's head word: the plural noun it is counted in, and a citrus's parts. */
const TRAILING = /^(?:\s+(?:cloves?|stalks?|sprigs?|leaves|pieces|halves|ribs?|bunch(?:es)?|pods?))?(?:\s+(?:juice|zest)(?:\s+and\s+(?:juice|zest))?)?/i;
/** Before a food: an article, "a pinch of", "the juice of", and up to four cut words or adjectives. */
const LEADING = /(?:\b(?:the|a|an)\s+(?:pinch\s+of\s+)?|\ba\s+pinch\s+of\s+|\b(?:the\s+)?(?:zest|juice)(?:\s+and\s+(?:zest|juice))?\s+of\s+(?:the\s+)?)?(?:(?:zest(?:ed)?|juice(?:d)?|and|minced|smashed|diced|finely|thinly|roughly|coarsely|chopped|sliced|quartered|halved|trimmed|peeled|rinsed|picked|grated|stripped|fresh|whole|large|small|medium|cold|softened|packed|light|dark|ground|kosher|granulated)\s+){0,4}$/i;
/** Words of a food's name that do not tell two rows apart. */
const GENERIC_WORD = /^(?:fresh|whole|large|small|medium|light|dark|packed|ground|kosher|granulated|all-purpose|unsalted|salted|cold|low-sodium|extra-virgin|pure|sea|flaky|dried|frozen|canned|store-bought|or)$/i;
const FORM_WORD = /^(?:halves|leaves|stalks|cloves|sprigs|sticks?|pieces|florets|heads|bulbs)$/i;
const SEPARATOR_BEFORE = /(?:,\s+(?:and\s+)?|\s+and\s+)$/;
const SEPARATOR_AFTER = /^(?:,\s+(?:and\s+)?|\s+and\s+)/;
const CLAUSE_END = /[;:.]/;

interface Mention { id: string; key: string; name: string; start: number; end: number; ref: boolean; cut: string[] }

const singular = (w: string) => w.toLowerCase().replace(/(?:(?<=[sxz]|ch|sh|o)es|s)$/, "");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The dish's foods a step names, with where (dish titles masked out). */
export function mentionsOf(step: WordingStep, rows: readonly WordingRow[], titles: readonly string[]): Mention[] {
  let masked = step.text;
  for (const t of titles) if (t) masked = masked.split(t).join(" ".repeat(t.length));
  const lower = masked.toLowerCase();
  const out: Mention[] = [];
  const refs = step.amountRefs ?? [];
  // The longer name first: "packed light brown sugar" claims its words before "granulated sugar" can.
  const byLength = [...rows].sort((a, b) => b.name.split(/[,(]/)[0].trim().split(/\s+/).length - a.name.split(/[,(]/)[0].trim().split(/\s+/).length);
  for (const row of byLength) {
    const named = row.name.toLowerCase().split(/[,(]/)[0].trim().split(/\s+/).filter(Boolean);
    // "pecan halves", "sage leaves": the food is also the word before its form.
    // ("ground cloves" is the food itself.)
    const forms = FORM_WORD.test(named[named.length - 1] ?? "") && named.length >= 2 && !GENERIC_WORD.test(named[named.length - 2]) ? [named, named.slice(0, -1)] : [named];
    for (const words of forms) {
    const head = singular(words[words.length - 1] ?? "");
    if (head.length < 3) continue;
    // The words that tell this row from another of the same head ("brown" of brown sugar).
    // (Only asked when another row shares the head: "old-fashioned" rolled oats is written "rolled oats".)
    const shared = rows.some((o) => o !== row && singular(o.name.toLowerCase().split(/[,(]/)[0].trim().split(/\s+/).pop() ?? "") === head);
    const telling = shared ? words.slice(0, -1).filter((w) => !GENERIC_WORD.test(w)).map(singular) : [];
    for (const m of lower.matchAll(new RegExp(`\\b${escape(head)}(?:e?s)?\\b`, "gi"))) {
      let start = m.index!;
      let end = start + m[0].length;
      const before = lower.slice(Math.max(0, start - 40), start);
      if (telling.some((w) => !new RegExp(`\\b${escape(w)}`).test(before))) continue;
      // A form ("leaves", "stick") is this row's only right after its food ("thyme leaves" is not sage).
      if (forms.length > 1 && words === named && !new RegExp(`\\b${escape(words[words.length - 2])}\\s+$`).test(before)) continue;
      end += TRAILING.exec(step.text.slice(end))?.[0].length ?? 0;
      // "(optional)" is the food's: it leaves with it when the food joins a mix.
      end += /^\s*\((?:optional|if using)\)/i.exec(step.text.slice(end))?.[0].length ?? 0;
      // The row's own words before its head ("cinnamon" stick, "cremini" mushrooms).
      for (const w of words.slice(0, -1).reverse()) {
        const own = new RegExp(`\\b${escape(w)}\\s+$`, "i").exec(step.text.slice(Math.max(0, start - w.length - 3), start));
        if (own) start -= own[0].length;
      }
      const lead = LEADING.exec(step.text.slice(Math.max(0, start - 60), start));
      if (lead) start -= lead[0].length;
      // An amount right before it is its amount, whichever row the matcher bound it to.
      const ref = refs.find((r) => r.charEnd <= start && /^\s*$/.test(step.text.slice(r.charEnd, start)) && start - r.charEnd <= 2);
      if (ref) start = ref.charStart;
      const partOf = /\b(?:the\s+)?(?:juice|zest)(?:\s+and\s+(?:juice|zest))?\s+of\s+$/i.exec(step.text.slice(Math.max(0, start - 30), start));
      if (partOf) start -= partOf[0].length;
      const leadThe = /\bthe\s+$/i.exec(step.text.slice(Math.max(0, start - 4), start));
      if (leadThe) start -= leadThe[0].length;
      if (out.some((o) => o.start < end && start < o.end)) continue;
      const span = step.text.slice(start, end).toLowerCase();
      out.push({ id: row.ingredientId, key: ingredientGroupKey(row.name), name: row.name, start, end, ref: !!ref || refs.some((r) => r.charStart >= start && r.charEnd <= end), cut: CUT_WORDS.filter((c) => span.includes(c)) });
    }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Two mentions are in one list: only separators (and list items with no clause end) between them. */
function listed(text: string, a: Mention, b: Mention): boolean {
  const [x, y] = a.start < b.start ? [a, b] : [b, a];
  const gap = text.slice(x.end, y.start);
  if (CLAUSE_END.test(gap)) return false;
  return /^(?:,\s+(?:and\s+)?|\s+and\s+)(?:[^,]{0,40}(?:,\s+(?:and\s+)?|\s+and\s+))*$/.test(gap);
}

/** Measured: a food with an amount, or one in a list beside one. */
function measured(text: string, ms: readonly Mention[]): Mention[] {
  const keep = new Set<Mention>(ms.filter((m) => m.ref));
  let grew = true;
  while (grew) {
    grew = false;
    for (let i = 0; i < ms.length; i++) {
      if (keep.has(ms[i])) continue;
      if ([ms[i - 1], ms[i + 1]].some((o) => o && keep.has(o) && listed(text, ms[i], o))) { keep.add(ms[i]); grew = true; }
    }
  }
  return ms.filter((m) => keep.has(m));
}

/** The phrase prepped produce goes by: the dish's own container ("whole"), or a shared tub's food. */
export function cutPhrase(into: string, titles: readonly string[] = [], kind?: FeastLabelKind | null): { phrase: string; whole: boolean } | null {
  // Round 2 (N) — a labelled container is said by its label: "the Gravy vegetables you
  // prepped", "the minced garlic you prepped"; a plate's piles stay as written.
  if (kind === "own" || kind === "mix") return { phrase: `the ${into} you prepped`, whole: true };
  if (kind === "shared") return { phrase: `the ${into.toLowerCase()} you prepped`, whole: false };
  if (kind === "plate") return null;
  const clean = into.replace(/\s*\([^)]*\)/g, "");
  const dash = /^(.+?) — (.+)$/.exec(clean);
  if (dash) {
    // "<dish> — its members" is the dish's own container; "<food> — <dishes>" a shared tub.
    if (titles.some((t) => t === dash[1])) return { phrase: `the ${dash[2]} you prepped`, whole: true };
    // A citrus tub by what is in it: "the lemon juice you prepped", not "the juiced lemon".
    const food = dash[1].toLowerCase()
      .replace(/^(?:zested and juiced|zested, then juiced) (.+)$/, "$1 zest and juice")
      .replace(/^juiced (.+)$/, "$1 juice")
      .replace(/^zested (.+)$/, "$1 zest");
    return { phrase: `the ${food} you prepped`, whole: false };
  }
  if (/ citrus jar$/i.test(clean)) return { phrase: `the ${clean}`, whole: true };
  const veg = /^(.+?) (vegetables|aromatics)$/i.exec(clean);
  if (veg) return { phrase: `the ${veg[1]} ${veg[2]} you prepped`, whole: true };
  return null; // a prep plate or a toppings plate: separate piles, named as written
}

const CUT_LEAD = /^(?:zest|juice|trim|peel|core|mince|chop|dice|slice|measure|rinse|halve|quarter|grate|seed|pick|strip|smash|finely|thinly|roughly|coarsely)\b/i;
const WORK_LEAD = /^(?:(?:in|on) (?:a|the) [a-z -]{0,30}, )?(?:combine|whisk|stir|add|toss|mix|pour|fold|place|transfer|melt|heat|bring|cook|roast|spread|arrange|season|scatter|sprinkle|layer)\b/i;

/**
 * Rule 2 (content — patch.ts writes it, never read time): a step that opens with prep
 * and then does the dish's work is two steps, so rule 1 can say "skip" to the first
 * and the second still reads whole ("Zest 2 oranges, then juice them; combine the
 * cranberries…" → "Zest 2 oranges, then juice them." + "Combine the cranberries…").
 * The split is at "; " or ". " before a work verb; a work verb followed straight by
 * "into"/"in"/"with"/"over" takes "them" ("whisk into the filling" → "Whisk them into
 * the filling."). Both keep the day prefix. Null when the step is one or the other.
 */
const PARTICIPLE: Record<string, string> = { slice: "sliced", dice: "diced", chop: "chopped", mince: "minced", grate: "grated", cube: "cubed", halve: "halved", quarter: "quartered", shred: "shredded" };

/** What a prep clause leaves on the board: "the sliced shallots", "the potato chunks", "the green beans". */
function subjectOf(clause: string, ms: readonly Mention[]): string {
  const verb = /^(?:\w+ly\s+)?(\w+)/.exec(clause.trim())?.[1].toLowerCase() ?? "";
  // The food as the clause writes it ("6 shallots" → shallots), its amount and cut words gone.
  const asWritten = (m: Mention) =>
    clause.slice(m.start, m.end).toLowerCase()
      .replace(/^(?:the\s+)?[\d½¼¾⅓⅔⅛⅜⅝⅞.\s-]*(?:(?:pounds?|lbs?|oz|ounces?|teaspoons?|tablespoons?|tsp|tbsp|cups?|cloves?|sprigs?|stalks?|heads?|bunch(?:es)?)\s+)?/, "")
      .replace(/^(?:(?:finely|thinly|roughly|coarsely|chopped|sliced|minced|diced|trimmed|peeled|rinsed|fresh|whole|large|small|medium|ground)\s+)+/, "")
      .trim();
  const names = [...new Set(ms.map((m) => asWritten(m) || m.name.toLowerCase().split(/[,(]/)[0].trim().split(/\s+/).filter((w) => !GENERIC_WORD.test(w)).join(" ")))];
  const list = names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const participle = PARTICIPLE[verb];
  if (participle) return `the ${participle} ${list}`;
  const shape = /\binto\s+(?:[\d½¼¾⅓⅔.]+[-\s]?inch\s+)?(chunks|pieces|cubes|rings|wedges|strips|slices)\b/i.exec(clause)?.[1];
  if (shape && names.length === 1) return `the ${singular(names[0].split(/\s+/).pop()!)} ${shape.toLowerCase()}`;
  return `the ${list}`;
}

export function splitPrepClause(text: string, rows: readonly WordingRow[], titles: readonly string[] = []): { prep: string; work: string } | null {
  const prefix = DAY_PREFIX.exec(text)?.[1] ?? "";
  const body = text.slice(prefix.length);
  if (!CUT_LEAD.test(body)) return null;
  // ("Trim 1 pound green beans and toss…": "and" or "then" before a work verb splits too.)
  for (const m of body.matchAll(/[;.]\s+|,?\s+(?:and|then)\s+/g)) {
    const a = body.slice(0, m.index);
    const b = body.slice(m.index! + m[0].length);
    if (!WORK_LEAD.test(b)) continue;
    const ms = mentionsOf({ stepIndex: 0, text: a, amountRefs: null }, rows, titles);
    if (ms.length === 0 || !onlyPrepWords(a, ms)) return null;
    // Round 2 (K) — the work half NAMES what it works, never "them": Cook Mode interleaves
    // dishes, so the step before it on the screen is another dish's ("Toss them with
    // ¼ cup flour" followed the turkey's carve). "the sliced shallots", "the potato chunks".
    const subject = subjectOf(a, ms);
    const named = /\bthem\b/i.test(b.split(/[;,.]/)[0])
      ? b.replace(/\bthem\b/i, subject)
      : b.replace(/^(\w+)\s+(?=(?:in|into|with|over|onto)\b)/i, `$1 ${subject} `);
    const work = named.charAt(0).toUpperCase() + named.slice(1);
    // "On Thursday:" once, on the first half; a make-ahead day stays on both (the Hub reads it).
    return { prep: `${prefix}${a.replace(/[,\s]+$/, "")}.`, work: `${/^\s*On /i.test(prefix) ? "" : prefix}${work}` };
  }
  return null;
}

interface Piece { text: string; from?: number }

/** Rebuild from pieces; a ref inside a copied piece moves with it, the rest are dropped. */
function rebuild(pieces: readonly Piece[], refs: readonly WordingRef[]): { text: string; refs: WordingRef[] } {
  let text = "";
  const out: WordingRef[] = [];
  for (const p of pieces) {
    const at = text.length;
    text += p.text;
    if (p.from === undefined) continue;
    for (const r of refs) if (r.charStart >= p.from && r.charEnd <= p.from + p.text.length) out.push({ ...r, charStart: at + r.charStart - p.from, charEnd: at + r.charEnd - p.from });
  }
  return { text, refs: out.sort((a, b) => a.charStart - b.charStart) };
}

/** One feast dish's steps, reworded (see the header). A step with nothing to change is returned as it was. */
export function rewordFeastSteps(
  steps: readonly WordingStep[],
  rows: readonly WordingRow[],
  facts: FeastDishFacts | undefined,
  /** The meal's dish titles: masked ("Sage and Onion Stuffing" is not sage) and a container's owner. */
  titles: readonly string[] = [],
): WordingStep[] {
  if (!facts || (facts.mixes.length === 0 && facts.cuts.length === 0)) return [...steps];
  const inMix = (mix: FeastDishFacts["mixes"][number], m: Mention) => mix.ids.has(m.id) || mix.keys.has(m.key);
  const cutsOf = (m: Mention) => facts.cuts.filter((c) => c.id === m.id || c.key === m.key);
  /** The prepped cut this mention asks for, when one matches its cut words. */
  const cutFor = (m: Mention) => cutsOf(m).find((c) => m.cut.every((w) => c.note.includes(w))) ?? null;
  const mentionsBy = new Map(steps.map((s) => [s.stepIndex, mentionsOf(s, rows, titles)]));
  // Rule 3 — each mix's entry step: the first that states two of its members (one for a one-member mix).
  const entryOf = new Map<string, number>();
  for (const mix of facts.mixes) {
    const n = Math.min(2, Math.max(1, mix.keys.size));
    const at = [...steps].sort((a, b) => a.stepIndex - b.stepIndex).find((s) => new Set((mentionsBy.get(s.stepIndex) ?? []).filter((m) => m.ref && inMix(mix, m)).map((m) => m.key)).size >= n);
    if (at) entryOf.set(mix.name, at.stepIndex);
  }

  return steps.map((step) => {
    if (CODE_WRITTEN.test(step.text)) return step;
    const prefix = DAY_PREFIX.exec(step.text)?.[1] ?? "";
    const body = step.text.slice(prefix.length);
    if (/^\s*skip if you prepped/i.test(body)) return step;
    const all = mentionsBy.get(step.stepIndex) ?? [];
    if (all.length === 0) return step;
    const mixHere = (m: Mention) => facts.mixes.find((x) => inMix(x, m) && entryOf.get(x.name) === step.stepIndex) ?? null;

    // ── Rule 1: the whole job was Prep the feast's ───────────────────────────
    const prepOnly = onlyPrepWords(step.text, all, prefix.length);
    const allPrepped = all.every((m) => {
      if (facts.mixes.some((x) => inMix(x, m))) return true;
      const c = cutFor(m);
      if (!c) return false;
      // A citrus the step zests AND juices must have been prepped both ways.
      if (CITRUS.test(m.name.split(/[,(]/)[0].trim())) {
        if (/\bzest/i.test(body) && !c.note.includes("zest")) return false;
        if (/\bjuic/i.test(body) && !c.note.includes("juic")) return false;
      }
      return true;
    });
    if (prepOnly && allPrepped) {
      const r = rebuild([{ text: prefix, from: 0 }, { text: "Skip if you prepped. Otherwise, " }, { text: body.slice(0, 1).toLowerCase() }, { text: body.slice(1), from: prefix.length + 1 }], step.amountRefs ?? []);
      return { ...step, text: r.text, amountRefs: step.amountRefs ? r.refs : step.amountRefs };
    }

    // ── Rules 3 and 4 ─────────────────────────────────────────────────────────
    const ms = measured(step.text, all);
    const groupOf = new Map<Mention, string>();
    for (const m of ms) {
      const mix = mixHere(m);
      if (mix) { groupOf.set(m, `the ${mix.name}`); continue; }
      if (facts.mixes.some((x) => inMix(x, m))) continue; // a mix member away from its entry step: as written
      const c = cutFor(m);
      // A cut that went into the jar entering here IS that jar (Small's stripped thyme in
      // the sweet potatoes' sauce): one mention, the jar's.
      if (c?.into && c.kind === "mix" && facts.mixes.some((x) => x.name === c.into && entryOf.get(x.name) === step.stepIndex)) { groupOf.set(m, `the ${c.into}`); continue; }
      const p = c?.into ? cutPhrase(c.into, titles, c.kind) : null;
      if (!p) continue;
      if (p.whole) {
        // Only when the step names everything that container holds for this dish.
        const members = new Set(facts.cuts.filter((x) => x.into === c!.into).map((x) => x.key));
        const named = new Set(ms.filter((o) => cutsOf(o).some((x) => x.into === c!.into)).map((o) => o.key));
        if ([...members].some((k) => !named.has(k))) continue;
      }
      groupOf.set(m, p.phrase);
    }
    // A group spans one list only: members in another clause leave the whole group as written.
    // And never as a cut verb's object ("mince the minced shallot you prepped"): that step
    // is rule 1's, or the patch splits it.
    for (const phrase of new Set(groupOf.values())) {
      const members = ms.filter((m) => groupOf.get(m) === phrase);
      const oneList = members.every((m, i) => i === 0 || listed(step.text, members[i - 1], m));
      const cutVerb = /\b(?:chop|mince|dice|slice|trim|peel|zest|juice|grate|pick|strip|halve|quarter|rinse|measure|cut|squeeze)(?:\s+and\s+(?:chop|mince|dice|slice|trim|peel|zest|juice|grate|halve))?\s+(?:the\s+)?$/i.test(step.text.slice(Math.max(0, members[0].start - 30), members[0].start));
      if (!oneList || cutVerb) for (const m of members) groupOf.delete(m);
    }
    if (groupOf.size === 0) return step;

    type Edit = { start: number; end: number; text: string };
    const edits: Edit[] = [];
    const firsts = new Map<string, Mention>();
    for (const m of ms) if (groupOf.has(m) && !firsts.has(groupOf.get(m)!)) firsts.set(groupOf.get(m)!, m);
    const removed: { m: Mention; start: number; end: number; hadAnd: boolean }[] = [];
    for (const m of ms) {
      const g = groupOf.get(m);
      if (!g) continue;
      if (firsts.get(g) === m) {
        if (step.text.slice(m.start, m.end).toLowerCase() !== g.toLowerCase()) edits.push({ start: m.start, end: m.end, text: g });
        continue;
      }
      const before = SEPARATOR_BEFORE.exec(step.text.slice(0, m.start));
      if (before) {
        edits.push({ start: m.start - before[0].length, end: m.end, text: "" });
        removed.push({ m, start: m.start - before[0].length, end: m.end, hadAnd: /\band\b/.test(before[0]) });
      } else {
        const after = SEPARATOR_AFTER.exec(step.text.slice(m.end));
        edits.push({ start: m.start, end: m.end + (after?.[0].length ?? 0), text: "" });
      }
    }
    // A removed last item took the list's "and": the separator before the new last item
    // takes it — ", and " with three or more items left, " and " with two.
    // A kept ", and " left after one item reads " and ".
    const gone = (at: number) => edits.some((e) => e.text === "" && e.start <= at && at < e.end);
    const fixed = new Set<number>();
    for (const r of removed) {
      // The list starts at its first food ("In a medium bowl, combine" is not an item).
      const clauseFrom = Math.max(prefix.length, ...[...step.text.slice(0, r.start).matchAll(/[;:.]\s*/g)].map((x) => (x.index ?? 0) + x[0].length));
      const clauseStart = Math.min(r.m.start, ...all.filter((o) => o.start >= clauseFrom).map((o) => o.start), ...(step.amountRefs ?? []).filter((x) => x.charStart >= clauseFrom).map((x) => x.charStart));
      if (!r.hadAnd) {
        const tail = step.text.slice(r.end);
        const and = /^[^;:.]*?,\s+and\s+/.exec(tail);
        if (!and) continue;
        const at = r.end + and[0].length - and[0].replace(/^[^;:.]*?(?=,\s+and\s+)/, "").length;
        if (gone(at) || fixed.has(at)) continue;
        const before = [...step.text.slice(clauseStart, at).matchAll(/,\s+/g)].map((x) => clauseStart + (x.index ?? 0)).filter((c) => !gone(c));
        if (before.length === 0) { fixed.add(at); edits.push({ start: at, end: at + /^,\s+/.exec(step.text.slice(at))![0].length, text: " " }); }
        continue;
      }
      const commas = [...step.text.slice(clauseStart, r.start).matchAll(/,\s+/g)]
        .map((x) => clauseStart + (x.index ?? 0))
        .filter((at) => !gone(at));
      const lastComma = commas[commas.length - 1];
      if (lastComma === undefined) continue;
      edits.push({ start: lastComma, end: lastComma + 2, text: commas.length >= 2 ? ", and " : " and " });
    }
    edits.sort((a, b) => a.start - b.start || b.end - a.end);
    const pieces: Piece[] = [];
    let cursor = 0;
    for (const e of edits) {
      if (e.start < cursor) continue;
      pieces.push({ text: step.text.slice(cursor, e.start), from: cursor }, { text: e.text });
      cursor = e.end;
    }
    pieces.push({ text: step.text.slice(cursor), from: cursor });
    const r = rebuild(pieces, step.amountRefs ?? []);
    if (r.text === step.text) return step;
    return { ...step, text: r.text, amountRefs: step.amountRefs ? r.refs : step.amountRefs };
  });
}
