// WS9 BUG-204 / D-WS9-301 H2 — HOW LONG A PREP STEP ACTUALLY TAKES.
//
// Pure, I/O-free, deterministic, and NOT the model's opinion.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// The per-step estimate used to come out of `prep.narrate_steps`, and it was
// inflated: mean 6.6 min per step across the 14-plan corpus, 3 min to halve and
// seed one poblano, 4 min to dice an onion. For most of a year that was a
// cosmetic annoyance on individual cards. D-WS9-301 ruling 4 put the SUM in the
// header — "18 containers · about 120 min" for work that takes about forty — and
// a number that wrong in the header is worse than no number, because Hans's
// whole condition for showing it was trust: "I just want to be sure 40 minutes is
// no more than 50 minutes or so in reality, otherwise, people won't trust it."
//
// A duration is a fact about an action and a quantity. The model writes the
// prose; the code owns the clock, exactly as it owns the amounts.
//
// 🔴 EVERY NUMBER BELOW IS A CONSTANT IN ONE PLACE, ON PURPOSE. These are
// chat-Claude's starting values and they are expected to be re-tuned once Hans
// times a real session. Re-tuning must be editing `MINUTES`, not hunting
// arithmetic through a function body.

/** The time table. Minutes. Re-tune HERE, nowhere else. */
export const MINUTES = {
  /** Measuring one dry or wet item into a container. */
  perMeasuredItem: 0.5,
  /** No container is worth less than this, however little is in it. */
  containerFloor: 1,
  /** Mincing garlic: 1 min per 3 cloves. */
  garlicPerClove: 1 / 3,
  // ── H6.1 ruling 2 — ONE RATE WAS FOUR JOBS ────────────────────────────────
  //
  // `perCutVegetable: 2` costed an onion, a bell pepper, a celery stalk and a
  // carrot the same, so 3 celery stalks read 6 minutes on the sample plan. These
  // are the H2 table's own figures, restored; Hans's calibration was "an onion in
  // 2, others take 3".
  /** Dicing one onion, pepper or tomato. */
  perCutVegetable: 2.5,
  /** Slicing one celery stalk — the cheapest cut on the board. */
  perCutCelery: 0.5,
  /** Cutting one carrot (peeling is charged separately). */
  perCutCarrot: 1,
  /** Peeling one carrot, on top of cutting it. */
  perPeelCarrot: 0.5,
  /** Cutting one potato. */
  perCutPotato: 1.5,
  /** Chopping herbs: 1 min per ¼ cup. */
  herbsPerCup: 4,
  /** Zesting AND juicing one citrus fruit. */
  citrusZestJuice: 1.5,
  /** Cutting one citrus into wedges. */
  citrusWedges: 1,
  /** Husking / trimming / snapping / peeling a batch: 1 min per ½ lb. */
  batchPerLb: 2,
  /** …and a batch is never quicker than this. */
  batchFloor: 2,
  // ── Part J.1c (BUG-355 item 4) — A PROTEIN IS TIMED BY THE VERB ITS STEP SAYS ───
  //
  // Hans, October 4, on his own plan: pound 2½ lb chicken breasts + trim 1¾ lb thighs +
  // cube 2 lb beef chuck read 22 minutes — "that's like 12 minutes ish". The rates
  // were H2's starting values, never timed (4/lb to cube, 3/lb for anything else), and
  // they keyed on the catalog NOTE, so a pounding the title announced was charged as a
  // 3/lb "portion" because the note did not say "pound". Now the step's own verbs
  // (rule 12, the ones the title shows) pick the rate, the slowest verb wins ("cube and
  // trim" is a cube), and the note is the fallback when the recipe names no verb.
  // Home-cook rates, per lb:
  /** Cubing a roast into stew pieces, trimming as you go: 2 lb chuck ≈ 5 min. */
  meatCubePerLb: 2.5,
  /** Slicing into strips (fajitas, stir-fry): the same knife work as cubing. */
  meatStripsPerLb: 2.5,
  /** Trimming the fat off thighs or a roast: ~35 s a thigh, about six to 1¾ lb. */
  meatTrimPerLb: 2,
  /** Butterflying breasts or a chop, or spatchcocking: a cut and a press per piece. */
  meatButterflyPerLb: 2,
  /** Pounding breasts to an even thickness under plastic: ~45 s a breast. */
  meatPoundPerLb: 1.5,
  /** Pulling the skin off. */
  meatSkinPerLb: 1.5,
  /** Dividing a pack into its meals' shares — no knife precision. */
  meatPortionPerLb: 1.5,
  /** Whisking a marinade or dressing together, once per such container. */
  whisk: 1,
  /** A step can never show less than this. */
  stepFloor: 1,
  /**
   * 🔴 AND NEVER MORE THAN THIS. Anything that computes above 15 minutes is a
   * CLASSIFICATION ERROR, not a long step — a quantity parsed into the wrong
   * unit family, or a batch rule applied to something that is not a batch. The
   * cap keeps a single bad row from poisoning the header, and `overCap` reports
   * it so the row can be found instead of silently flattened.
   */
  stepCap: 15,
  /**
   * Getting the containers out, finding the lids, wiping the board down. The
   * ONLY padding, applied once to the plan total — per-step padding would
   * compound and put the header back where it was.
   */
  overheadFraction: 0.1,
} as const;

// ── classification ──────────────────────────────────────────────────────────

const GARLIC = /\bgarlic\b(?!\s*(?:powder|salt|granules))/i;
/**
 * H6.1 ruling 2 — the per-vegetable rate, by what is being cut. Order matters
 * only in that each arm is tested against the whole name; the fallback is the
 * onion rate, which is the most common cut and the one Hans timed.
 */
const CUT_RATES: ReadonlyArray<[RegExp, number]> = [
  [/\bcelery\b/i, MINUTES.perCutCelery],
  [/\bcarrots?\b/i, MINUTES.perCutCarrot],
  [/\bpotato(?:es)?\b/i, MINUTES.perCutPotato],
];
/** Peeling, when the note says so, on top of the cut. */
const PEEL_NOTE = /\bpeel\w*\b/i;
function cutRateFor(name: string, note: string): number {
  for (const [re, rate] of CUT_RATES) {
    if (!re.test(name)) continue;
    const peel = /\bcarrots?\b/i.test(name) && PEEL_NOTE.test(note) ? MINUTES.perPeelCarrot : 0;
    return rate + peel;
  }
  return MINUTES.perCutVegetable;
}
const CUT_VEG =
  /\b(onions?|shallots?|leeks?|scallions?|green onions?|peppers?|jalapeños?|jalapenos?|serranos?|poblanos?|chil[ei]s?|celery|carrots?|cucumbers?|radishes?|zucchini|squash|fennel|cabbage|tomatoes?|tomatillos?|mushrooms?|potatoes?)\b/i;
const HERBS =
  /\b(cilantro|parsley|basil|mint|dill|tarragon|chives|rosemary|thyme|oregano|sage|scallions?|green onions?)\b/i;
const CITRUS = /\b(lime|lemon|orange|grapefruit)s?\b/i;
const BATCH =
  /\b(asparagus|potatoes?|tomatillos?|broccoli|cauliflower|green beans?|brussels sprouts?|squash|sweet potatoes?)\b/i;
const MEAT =
  /\b(chicken|turkey|beef|pork|lamb|veal|steak|chuck|brisket|tenderloin|roast|salmon|cod|halibut|tilapia|tuna|snapper|trout|shrimp|prawns?|scallops?|fish|fillets?|breasts?|thighs?|drumsticks?|cutlets?|chops?)\b/i;

/** Part J.1c — rule 12 verb (prepComponents PROTEIN_VERBS) → its rate per lb. */
const VERB_RATE: Record<string, number> = {
  cube: MINUTES.meatCubePerLb,
  "cut into strips": MINUTES.meatStripsPerLb,
  trim: MINUTES.meatTrimPerLb,
  butterfly: MINUTES.meatButterflyPerLb,
  pound: MINUTES.meatPoundPerLb,
  skin: MINUTES.meatSkinPerLb,
  portion: MINUTES.meatPortionPerLb,
};

const CUBE_NOTE = /\b(cube[sd]?|cut into|chunk|trim|strips?|pound|butterfl|slice)\b/i;
// "zested and juiced" is the note the catalog actually carries, and `\bzest\b`
// does not match "zested" — the boundary fails on the following letter. Same
// mistake shape as the `\bham\b` gap in the storage table.
const ZEST_JUICE_NOTE = /\b(zest\w*|juic\w*)\b/i;
const WEDGE_NOTE = /\bwedge/i;
const BATCH_NOTE = /\b(husk|trim|snap|peel|halve[sd]?|quarter)\b/i;
const CUT_NOTE = /\b(dice[sd]?|diced|slice[sd]?|sliced|chop|chopped|mince[sd]?|minced|shred)\b/i;
const WET_MIXTURE_NOUN = /\b(marinade|dressing|vinaigrette|glaze|sauce|crema|aioli|pesto|chimichurri|brine)\b/i;

/** What one measured row of a step is, for timing. */
export type ActionClass =
  | "garlic"
  | "cut-vegetable"
  | "herbs"
  | "citrus-zest-juice"
  | "citrus-wedges"
  | "batch"
  | "meat-cube"
  | "meat-portion"
  | "measure";

export interface TimedRow {
  ingredientName: string;
  preparationNote: string;
  /** The parsed amount, when it could be read. */
  quantity: number | null;
  unit: string | null;
  action: ActionClass;
  minutes: number;
  /**
   * H2b ruling 2 — the WHOLE FRUIT (or other source) this row is handling, when
   * the row is a derived component. Two rows sharing it are two operations on one
   * piece of food: zesting a lime and juicing the same lime is one lime.
   */
  sourceName?: string;
  /**
   * False when this row was folded into a sibling off the same source (zesting
   * and juicing one lime). Set by `timeStep`; undefined on a bare `timeRow`.
   */
  charged?: boolean;
}

/**
 * Read a finished display amount back into a number and a unit.
 *
 * ⚠️ THE STRING IS THE ENGINE'S OWN OUTPUT, so the vulgar-fraction glyphs are
 * the ones `toEighths`/`toCount` write, unspaced ("1½ lb"). Anything unreadable
 * returns nulls and the caller falls back to counting the row as one item —
 * guessing a magnitude from an unparseable string is how a 3-minute poblano
 * becomes a 12-minute one.
 */
const GLYPHS: Record<string, number> = {
  "⅛": 0.125, "¼": 0.25, "⅜": 0.375, "½": 0.5, "⅝": 0.625, "¾": 0.75, "⅞": 0.875,
  "⅓": 1 / 3, "⅔": 2 / 3,
};

export function parseAmount(amount: string): { quantity: number | null; unit: string | null } {
  // A DECIMAL is accepted as well as the glyphs: the engine writes "1½ lb", but
  // `timeStep` re-renders a summed component as "2.5 each" and an integer-only
  // pattern read that as 2 with the unit ".5 each".
  const m = amount.trim().match(/^(\d+(?:\.\d+)?)?\s*([⅛¼⅜½⅝¾⅞⅓⅔])?\s*(.*)$/u);
  if (!m) return { quantity: null, unit: null };
  const whole = m[1] ? Number(m[1]) : 0;
  const frac = m[2] ? GLYPHS[m[2]] ?? 0 : 0;
  const q = whole + frac;
  const unit = (m[3] ?? "").trim().toLowerCase() || null;
  if (q === 0 && !m[1] && !m[2]) return { quantity: null, unit };
  return { quantity: q, unit };
}

/** Pounds, when the unit is a weight this table understands. */
function toPounds(quantity: number, unit: string | null): number | null {
  if (quantity <= 0 || !unit) return null;
  if (/^lbs?$|^pounds?$/.test(unit)) return quantity;
  if (/^oz$|^ounces?$/.test(unit)) return quantity / 16;
  return null;
}

/**
 * How many WHOLE things an amount names, when its unit is a count.
 *
 * A unit that is not a count means the number is a measure, not a tally: "3 tbsp"
 * is three tablespoons of one lime, not three limes. Returning 1 there is what
 * keeps a volume from being charged as a quantity of fruit.
 */
function countOf(quantity: number | null, unit: string | null): number {
  if (quantity == null || quantity <= 0) return 1;
  if (unit === null || /^(each|whole|large|medium|small|cloves?|stalks?|sprigs?|heads?|bunch(?:es)?)$/.test(unit)) {
    return Math.max(1, Math.round(quantity));
  }
  return 1;
}

/** D-WS9-297 ruling 8's yield edge, as this module needs it. */
export interface SourceYieldLike {
  fromName: string;
  quantity: number;
  unit: string;
}

/**
 * H2b ruling 2 — HOW MANY WHOLE FRUIT AN AMOUNT OF JUICE OR ZEST TAKES.
 *
 * `ingredient_relations` already carries it: a `component` edge says "lime →
 * lime juice : 2 tbsp" (D-WS9-194), which is exactly the conversion the timing
 * needs. The same arithmetic produces the "(from 2 limes)" the prose shows, and
 * `prepWeekAssembly.sourceCountFor` now calls this so there is ONE copy of it.
 *
 * Rounds UP to a whole fruit: you cannot squeeze three fifths of a lime.
 */
export function wholeFruitCount(
  y: SourceYieldLike | null | undefined,
  quantity: number | null,
  unit: string | null,
  canon: (u: string | null | undefined) => string,
  convert: (q: number, from: string, to: string) => number | null,
): number | null {
  if (!y || !(y.quantity > 0) || quantity == null || quantity <= 0) return null;
  const demand = canon(unit);
  const yielded = canon(y.unit);
  const inYieldUnit = demand === yielded ? quantity : convert(quantity, demand, yielded);
  if (inYieldUnit === null || !Number.isFinite(inYieldUnit) || inYieldUnit <= 0) return null;
  // The 1e-9 is the same guard sourceCountFor uses: 2 tbsp of a 2-tbsp yield is
  // one lime, not two, and floating point should not decide that.
  const count = Math.ceil(inYieldUnit / y.quantity - 1e-9);
  return Number.isFinite(count) && count >= 1 ? count : null;
}

/** Cups, when the unit is a volume this table understands. */
function toCups(quantity: number, unit: string | null): number | null {
  if (quantity <= 0 || !unit) return null;
  if (/^cups?$/.test(unit)) return quantity;
  if (/^tbsp$|^tablespoons?$/.test(unit)) return quantity / 16;
  if (/^tsp$|^teaspoons?$/.test(unit)) return quantity / 48;
  return null;
}

/**
 * Classify and time ONE measured row.
 *
 * The order is the precedence, and it matters: garlic before the cut-vegetable
 * class (garlic is minced by the clove, not diced by the unit), citrus before
 * herbs (a lemon is not a herb but "lemon-herb" prose is everywhere), batch
 * before cut-vegetable (halving 1½ lb of potatoes is one batch action, not one
 * potato at a time).
 */
export function timeRow(
  ingredientName: string,
  preparationNote: string,
  amount: string,
  /** H2b ruling 2 — the yield edge for this ingredient, when it has one. */
  yieldFor?: (name: string) => { yield: SourceYieldLike | null; count: (q: number | null, u: string | null) => number | null } | null,
  /** Part J.1c — the protein step's own verbs (rule 12), when it has them. */
  verbs?: readonly string[],
): TimedRow {
  const { quantity, unit } = parseAmount(amount);
  const name = ingredientName.toLowerCase();
  const note = (preparationNote ?? "").toLowerCase();
  const both = `${name} ${note}`;
  const row = (action: ActionClass, minutes: number): TimedRow => ({
    ingredientName, preparationNote: preparationNote ?? "", quantity, unit, action, minutes,
  });

  // Meat: by weight, at the rate of the slowest verb the step names (Part J.1c); with
  // none, the note says whether it is cubing or portioning.
  if (MEAT.test(name)) {
    const byVerb = (verbs ?? []).map((v) => VERB_RATE[v]).filter((r): r is number => r !== undefined);
    const perLb = byVerb.length > 0 ? Math.max(...byVerb) : CUBE_NOTE.test(note) ? MINUTES.meatCubePerLb : MINUTES.meatPortionPerLb;
    const action: ActionClass = perLb === MINUTES.meatPortionPerLb && byVerb.length === 0 ? "meat-portion" : "meat-cube";
    const lb = quantity == null ? null : toPounds(quantity, unit);
    if (lb != null) return row(action, lb * perLb);
    return row(action, perLb);
  }

  // Garlic, by the clove.
  if (GARLIC.test(name)) {
    // 🔴 A BARE COUNT ON A CLOVE-SHAPED NAME IS A CLOVE COUNT. The old line
    // demanded the unit token be literally "clove(s)" and charged ONE clove
    // otherwise — so "garlic cloves: 17" cost 20 seconds. The engine renders a
    // count-unit ingredient's amount as a bare number, so the unit was simply
    // absent, and 16 of the corpus's 79 garlic measures were charged as one clove.
    //
    // The name is the other half of the evidence: when it already says "clove",
    // the number beside it counts cloves and needs no unit to prove it.
    const nameSaysCloves = /\bcloves?\b/i.test(name);
    const unitSaysCloves = unit != null && /^cloves?$/.test(unit);
    const cloves =
      quantity != null && quantity > 0 && (unitSaysCloves || (nameSaysCloves && unit == null))
        ? quantity
        : 1;
    return row("garlic", cloves * MINUTES.garlicPerClove);
  }

  // Citrus: zested-and-juiced, or wedged, or just measured (its juice).
  if (CITRUS.test(name)) {
    if (WEDGE_NOTE.test(note)) return row("citrus-wedges", countOf(quantity, unit) * MINUTES.citrusWedges);
    if (ZEST_JUICE_NOTE.test(both)) {
      // 🔴 "3 tbsp lime juice" IS NOT THREE LIMES. The first version multiplied
      // the per-fruit cost by whatever number was in the amount, whatever its
      // unit, and charged 4½ minutes to juice three tablespoons. Measured over
      // the corpus that one error was 12% of all prep minutes — the third-largest
      // class, on 50 rows, most of them a volume of juice rather than a fruit.
      //
      // …AND IT IS NOT ¼ CUP EITHER. H2 replaced the first error with a ¼-cup
      // proxy, which pinned all 37 volume rows in the corpus to the 1.5-minute
      // floor — the opposite error, and just as invented.
      //
      // The real answer was already in the data. `ingredient_relations` carries
      // "lime → lime juice : 2 tbsp" (D-WS9-194), which is what the prose's
      // "(from 2 limes)" is built from. 3 tbsp is two limes, and two limes is
      // three minutes of squeezing.
      const viaYield = yieldFor?.(ingredientName) ?? null;
      const fruit = viaYield ? viaYield.count(quantity, unit) : null;
      if (fruit != null && viaYield?.yield) {
        const r = row("citrus-zest-juice", fruit * MINUTES.citrusZestJuice);
        // The SOURCE, so `timeStep` can see that this row and a zest row off the
        // same lime are two operations on ONE lime.
        r.sourceName = viaYield.yield.fromName;
        return r;
      }
      return row("citrus-zest-juice", countOf(quantity, unit) * MINUTES.citrusZestJuice);
    }
    return row("measure", MINUTES.perMeasuredItem);
  }

  // A batch vegetable, husked / trimmed / snapped / peeled by weight.
  if (BATCH.test(name) && (BATCH_NOTE.test(note) || !CUT_NOTE.test(note))) {
    const lb = quantity == null ? null : toPounds(quantity, unit);
    if (lb != null) return row("batch", Math.max(MINUTES.batchFloor, lb * MINUTES.batchPerLb));
    // A count of batch vegetables with no weight ("1 poblano, halved") is knife
    // work on that many items, not a batch.
    if (CUT_VEG.test(name)) return row("cut-vegetable", (quantity ?? 1) * cutRateFor(name, note));
    return row("batch", MINUTES.batchFloor);
  }

  // Herbs, by volume of chopped leaves.
  if (HERBS.test(name) && CUT_NOTE.test(note)) {
    const cups = quantity == null ? null : toCups(quantity, unit);
    if (cups != null) return row("herbs", cups * MINUTES.herbsPerCup);
    return row("herbs", MINUTES.herbsPerCup / 4);
  }

  // Knife work on a vegetable: per item, and a whole onion counts as one.
  if (CUT_VEG.test(name) && CUT_NOTE.test(note)) {
    const count =
      unit === null || /^(each|whole|large|medium|small)$/.test(unit) ? Math.max(1, Math.round(quantity ?? 1)) : 1;
    return row("cut-vegetable", count * cutRateFor(name, note));
  }

  // Everything else is a measure into a container.
  return row("measure", MINUTES.perMeasuredItem);
}

export interface StepTiming {
  minutes: number;
  rows: TimedRow[];
  /** True when the raw sum exceeded the cap — a classification error to chase. */
  overCap: boolean;
  rawMinutes: number;
}

/**
 * Time one planned step from what it contains.
 *
 * `isMixture` adds the whisk, once, for a container whose name says it is a wet
 * mixture — the stirring is real work and it happens once per bowl, not once per
 * ingredient.
 */
export function timeStep(
  input: {
    components: { ingredientName: string; preparationNote?: string | null; measures: { amount: string; preparationNote?: string | null }[] }[];
    bowlName?: string;
    /** Part J.1c — a protein step's verbs (rule 12): they, not the note, pick the rate. */
    verbs?: readonly string[];
  },
  /**
   * H2b ruling 2 — the yield edge per ingredient name, so juice and zest are
   * charged on the FRUIT COUNT rather than on a volume. Optional: a caller
   * without the engine's groups in hand (a test, a fixture) falls back to the
   * count rule, and the fallback is the same one that was there before.
   */
  yieldFor?: (name: string) => { yield: SourceYieldLike | null; count: (q: number | null, u: string | null) => number | null } | null,
): StepTiming {
  // ── 🔴 ONE INGREDIENT IS ONE ACTION, SIZED BY ITS TOTAL ───────────────────
  //
  // D-WS9-301 rule 5 makes a shared ingredient ONE container with a measure per
  // destination dish — "1 white onion for the enchiladas, ½ for the sauce, ½ for
  // the rice, ½ for the fixings". Costing each MEASURE separately charges the
  // cook four separate onion-dicings for one onion-dicing session, and on the
  // sample plan that alone was 7 minutes for 2½ onions.
  //
  // So the measures of one component are folded into a single amount before
  // timing, when their units agree. They disagree only where an ingredient is
  // demanded in incompatible families (the engine keeps those as separate lines
  // on purpose), and then each is timed on its own because they really are
  // different actions.
  const rows: TimedRow[] = [];
  for (const c of input.components) {
    const byUnit = new Map<string, { quantity: number; amount: string; note: string }>();
    const unparsed: { amount: string; note: string }[] = [];
    for (const m of c.measures) {
      const note = m.preparationNote ?? c.preparationNote ?? "";
      const { quantity, unit } = parseAmount(m.amount);
      if (quantity == null) {
        unparsed.push({ amount: m.amount, note });
        continue;
      }
      const key = unit ?? "";
      const prev = byUnit.get(key);
      if (prev) prev.quantity += quantity;
      else byUnit.set(key, { quantity, amount: m.amount, note });
    }
    for (const [unit, agg] of byUnit) {
      // Re-render the summed amount in the same shape `parseAmount` reads. The
      // fraction glyphs are not needed: a decimal parses, and only the magnitude
      // is used from here on.
      rows.push(timeRow(c.ingredientName, agg.note, `${agg.quantity} ${unit}`.trim(), yieldFor, input.verbs));
    }
    for (const u of unparsed) rows.push(timeRow(c.ingredientName, u.note, u.amount, yieldFor, input.verbs));
  }

  // ── 🔴 ONE LIME IS ONE LIME, however many of its parts a step uses ─────────
  //
  // The corpus had a step wanting "½ tsp lime zest" AND "2 tbsp lime juice", each
  // resolving to one lime, each charged 1.5 min: three minutes to zest and juice
  // one lime, when the table's figure of 1.5 is for doing BOTH to one fruit.
  //
  // Rows that name the same source are operations on the same food, so the group
  // costs the MAXIMUM of its rows, not the sum — the fruit count that satisfies
  // the hungriest of them also satisfies the others.
  const bySource = new Map<string, TimedRow[]>();
  for (const r of rows) {
    if (!r.sourceName) continue;
    const l = bySource.get(r.sourceName) ?? [];
    l.push(r);
    bySource.set(r.sourceName, l);
  }
  const collapsed = new Set<TimedRow>();
  for (const group of bySource.values()) {
    if (group.length < 2) continue;
    const keep = group.reduce((a, b) => (b.minutes > a.minutes ? b : a));
    for (const r of group) if (r !== keep) collapsed.add(r);
  }
  // Marked rather than removed: a report that wants per-class totals has to be
  // able to tell a charged row from one folded into its sibling, and dropping
  // them would make the rows lie about what the step contains.
  for (const r of rows) r.charged = !collapsed.has(r);
  let sum = rows.reduce((n, r) => n + (r.charged ? r.minutes : 0), 0);
  // A container is never worth less than a minute, however little is in it.
  if (rows.length > 0) sum = Math.max(MINUTES.containerFloor, sum);
  if (input.bowlName && WET_MIXTURE_NOUN.test(input.bowlName)) sum += MINUTES.whisk;
  const raw = Math.ceil(sum);
  return {
    minutes: Math.min(MINUTES.stepCap, Math.max(MINUTES.stepFloor, raw)),
    rows,
    overCap: raw > MINUTES.stepCap,
    rawMinutes: raw,
  };
}

/**
 * D-WS9-301 ruling 4 — the plan total the header states.
 *
 * Sum of the RENDERED steps, plus 10% overhead, rounded UP to the next 5. The
 * round-up and the overhead both go the same way on purpose: a stated number the
 * cook beats is one they trust, and one they miss is one they stop reading.
 */
export function planMinutes(stepMinutes: readonly number[]): number {
  const sum = stepMinutes.reduce((n, m) => n + m, 0);
  if (sum === 0) return 0;
  const withOverhead = sum * (1 + MINUTES.overheadFraction);
  return Math.ceil(withOverhead / 5) * 5;
}
