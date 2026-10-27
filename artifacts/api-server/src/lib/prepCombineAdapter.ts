// WS7-8a Block 2 — loader → engine adapter.
//
// Maps the enriched prep-week loader output (PrepLoadedPlan) into the pure
// engine's input (PrepCombineInput). Two responsibilities the engine cannot do
// itself (both require data the engine input deliberately omits):
//
//  1. SERVINGS-SCALING — the loader ships RAW dish-ingredient quantities. We
//     scale per-dish, mirroring groceryList.ts exactly: the base is
//     dish.servingsDefault and the override is the plan-item's servingsOverride
//     (carried at meal level), so multiplier = (override ?? base) / base. No
//     override → multiplier 1. The engine then sums effective quantities.
//
//  2. "6 oz" COMPOUND-UNIT SPLIT — the one real seed unit that doesn't
//     canonicalize. `salmon fillets` is stored as quantity=2, unit="6 oz"
//     (2 fillets of 6 oz = 12 oz). We split the leading number out of the unit
//     and fold it into the quantity (2 × 6 = 12 oz) so it joins the weight
//     family instead of bucketing alone as an unknown unit.
//
// category comes straight off the Ingredient row (the loader now carries it);
// inferCategory is a defensive pocket fallback only, for the theoretical
// empty-category row.

import { dishRowMultipliers, weighedTurkeyOf } from "./prepQuantity";
import { birdLineAtWeight } from "./birdWeight";
import { inferCategory } from "./ingredientResolve";
import { assignPhase, isNeverMeasured, isSaltOrPepper } from "./prepCombineEngine";
import { resolveDishComponents } from "./prepComponents";
import { mixtureEntryKey, proseNames, resolveMoments } from "./prepMoments";
import { cutOf } from "./prepClasses";
import type { PrepCombineDish, PrepCombineInput } from "./prepCombineEngine";
import type { PrepLoadedDish, PrepLoadedPlan } from "./prepWeekAggregation";

// Leading "<number> <unit>" compound, e.g. "6 oz", "1.5 lb". The number is a
// per-unit pack size folded into the quantity; the remainder is the real unit.
const COMPOUND_UNIT_RE = /^\s*(\d+(?:\.\d+)?)\s+(\S.*?)\s*$/;

/** Part J.1 (R2) — heat in a step's own words, for a component whose steps are not tagged `cook`. */
const HEAT_VERB =
  /\b(saut[ée]\w*|simmer\w*|bak(?:e|ed|ing)|roast\w*|broil\w*|grill\w*|fry|fried|frying|boil\w*|sear\w*|toast\w*|braise\w*|steam\w*|char\w*)\b/i;

/** PREP-3 (R9) — a step that puts a food ON something: a use, not the food's own prep. */
const APPLIES_TO_FOOD = /\b(?:brush\w*|spread\w*|rub(?:s|bed|bing)?|coat\w*|dredg\w*|slather\w*|smear\w*|bast\w*|dip(?:s|ped|ping)?)\b/i;

/** THX-3c (E) — the fresh herbs (and green onions) a feast cuts for its garnish. */
const FEAST_HERB = /\b(chives|parsley|cilantro|dill|basil|mint|tarragon|thyme|sage|rosemary|green onions?|scallions?)\b/i;

export function splitCompoundUnit(
  quantity: number,
  unit: string,
): { quantity: number; unit: string } {
  const m = unit.match(COMPOUND_UNIT_RE);
  if (!m) return { quantity, unit };
  const factor = Number.parseFloat(m[1]);
  if (!Number.isFinite(factor) || factor <= 0) return { quantity, unit };
  return { quantity: quantity * factor, unit: m[2] };
}

// ── H5.3 — THE SERVICE PORTION IS NOT PREP ──────────────────────────────────
//
// Hans, October 2: "Rounds / wedges / slices 'for topping' or 'for serving' are
// cook-day work, not prep." Cut citrus is also rule 6's first drop class, so it
// is doubly not prep — and a round sliced on Sunday is limp by Thursday.
//
// 🔴 IT IS REMOVED HERE, AT THE SOURCE, and therefore from the step, the
// container count and the minutes together. Demoting it later leaves the work
// costed and the vessel counted for something the cook is told not to do.
//
// 🔴 THIS IS THE PREP LANE ONLY. The limes stay in the recipe, the grocery list
// and Cook Mode, which read their own paths — the cook still cuts wedges on the
// night, which is the whole point.
const SERVICE_PURPOSE =
  /\bfor (?:topping|toppings|serving|garnish|the table)\b|\bto (?:serve|garnish)\b/i;
/** The cut forms that are service work when they are for service. */
const SERVICE_CUT =
  /\b(rounds?|wedges?|wedged|slices?|sliced|halves|halved|quartered)\b/i;
/** A leading count on a clause: "1 zested and juiced". */
const LEADING_COUNT = /^\s*(\d+(?:\.\d+)?|½|¼|¾|⅓|⅔)\s+(.*)$/;
const GLYPH: Record<string, number> = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3 };

/**
 * Split one ingredient row into the part that is PREP and the part that is
 * service. Returns null when the whole row is service and nothing is left to do
 * ahead.
 *
 * Only ever reduces: a note it does not recognise returns the row untouched.
 */
/**
 * Split one ingredient row into the part that is PREP and the part that is
 * cook-day service work. Returns null when nothing is left to do ahead.
 *
 * 🔴 ONLY CUT FORMS LEAVE. A chopped herb for garnish keeps everything —
 * including the words "for garnish" in its note, which is how rule 7's drop
 * class recognises it (lowValueClass). Stripping them would blind the drop pass.
 *
 * Only ever reduces: a shape it does not recognise returns the row untouched.
 */
export function prepPortion(
  ingredientName: string,
  quantity: number,
  unit: string,
  preparationNote: string | null,
): { quantity: number; preparationNote: string | null } | null {
  const note = (preparationNote ?? "").trim();
  const unchanged = { quantity, preparationNote };
  if (note === "") return unchanged;

  const clauses = note.split(/\s*,\s*/).map((c) => c.trim()).filter((c) => c !== "");
  // A purpose stated anywhere in the note governs the whole of it: "cut into
  // wedges, for serving" is one instruction split by a comma.
  const purposeSomewhere = clauses.some((c) => SERVICE_PURPOSE.test(c));
  if (!purposeSomewhere) return unchanged;

  // The cut may be named by the ingredient instead of the note: "lemon wedges".
  const nameIsCut = SERVICE_CUT.test(ingredientName);
  const isServiceClause = (c: string) =>
    SERVICE_CUT.test(c) || (SERVICE_PURPOSE.test(c) && nameIsCut);
  const serviceClauses = clauses.filter(isServiceClause);
  if (serviceClauses.length === 0) {
    // A purpose with no cut — "chopped, for garnish". Rule 7's business, not
    // this function's, and its note must survive for the drop pass to see it.
    return unchanged;
  }

  const keptClauses = clauses.filter(
    (c) => !isServiceClause(c) && !SERVICE_PURPOSE.test(c),
  );
  // Nothing but the cut and its purpose: the whole row is cook-day work.
  if (keptClauses.length === 0) return null;

  // A split row on a COUNT unit, where every clause states its own count. Less
  // regular than that and the quantity stands — a wrong number is worse than an
  // undivided one.
  const counted = (c: string): number | null => {
    const m = LEADING_COUNT.exec(c);
    if (!m) return null;
    const n = GLYPH[m[1]] ?? Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const keptNote = keptClauses.join(", ");
  const keptCounts = keptClauses.map(counted);
  const isCount = /^(each|whole|clove|cloves|head|heads|stalk|stalks|sprig|sprigs)$/i.test(
    unit.trim(),
  );
  if (!isCount || keptCounts.some((n) => n === null)) {
    return { quantity, preparationNote: keptNote };
  }
  const prepTotal = (keptCounts as number[]).reduce((x, y) => x + y, 0);
  // Never invent more than the row had.
  return { quantity: Math.min(quantity, prepTotal), preparationNote: keptNote };
}
export function buildPrepCombineInput(
  loaded: PrepLoadedPlan,
  /**
   * THX-3 — the feast session. Its salt and pepper are measures (prepCombineEngine
   * CombineOptions), and they join a mixture only by their OWN step or tag: Classic's
   * herb-butter pepper rode the run proxy into the brine's bowl. A make-ahead dish
   * (`makeAhead`) brings only its shelf-stable dry members (D-WS9-316).
   */
  opts: { feast?: boolean } = {},
): PrepCombineInput {
  return {
    meals: loaded.meals.map((meal) => {
      // One dish → its engine rows (THX-3b: called again over a dish's portion view).
      const mapDish = (dish: PrepLoadedDish, listingStep?: ReadonlyMap<string, number>): PrepCombineDish => {
        // ── WS9 D-WS9-296 — resolve this dish's mixtures ────────────────────
        //
        // Done HERE and not in the engine because it needs the dish's STEPS,
        // which the engine's input deliberately omits — the same reason the
        // servings scaling and the compound-unit split live in this adapter.
        //
        // `assignPhase` is called for the protein test (ruling 1) rather than a
        // second copy of the category rules; the engine exports it for exactly
        // this kind of pre-pass.
        const resolved = resolveDishComponents(
          dish.dishName,
          meal.mealName,
          // `?? []` on purpose: the field is new, and the loader always sets it,
          // but several hand-built fixtures are `as never`-cast and predate it.
          // A missing field must degrade to "no components", never throw.
          dish.componentSteps ?? [],
          // 🔴 THE PREP NOTE, NOT THE RAW ONE. H5.3 removes a service clause in the
          // row mapping below, and this call used to run before it on the raw text —
          // so a lemon noted "1 zested and juiced, 1 sliced into rounds for topping"
          // read as a service form, and signal 4 refused to claim it from its own
          // marinade step. The resolver has to see the note the cook will see.
          dish.ingredients.map((i) => ({
            ingredientId: i.ingredientId,
            ingredientName: i.ingredientName,
            preparationNote:
              prepPortion(i.ingredientName, 1, "each", i.preparationNote)?.preparationNote ??
              i.preparationNote,
            phase: assignPhase(i.category, i.ingredientName, i.purchaseUnit),
          })),
        );
        // ── Part J.1 (R2) — IS A COMPONENT COOKED? ITS OWN STEPS SAY ─────────
        //
        // A `cook`-phase step, or a heat verb in one of the component's own steps.
        // The roasted green beans' "toss with oil and salt" has no heat word, but
        // the same component roasts them two steps later — a raw mix it is not.
        //
        // The component's own steps, and the heat that FOLLOWS it: a later heat step
        // that names one of its members ("roast the beans"), or the very next step
        // being heat and naming no ingredient at all ("Roast at 425°F for 15
        // minutes" — it can only mean what was just tossed). "Fry the cod" names the
        // cod, not the pico, so the pico beside it stays raw.
        const ordered = [...(dish.componentSteps ?? [])].sort((a, b) => a.stepIndex - b.stepIndex);
        const stepByIndex = new Map(ordered.map((s) => [s.stepIndex, s]));
        const isHeat = (s: { phaseType: string; text: string }) => s.phaseType === "cook" || HEAT_VERB.test(s.text);
        const head = (n: string) => n.toLowerCase().replace(/^(fresh|dried|ground|large|small|medium)\s+/, "").split(/\s+/).slice(-1)[0].replace(/e?s$/, "");
        const namesOf = (ids: readonly string[]) =>
          dish.ingredients.filter((i) => ids.includes(i.ingredientId)).map((i) => head(i.ingredientName));
        const allNames = dish.ingredients.map((i) => head(i.ingredientName));
        const mentions = (text: string, names: readonly string[]) => names.some((n) => n.length > 2 && text.toLowerCase().includes(n));
        const componentHeated = (indexes: readonly number[], memberIds: readonly string[]): boolean => {
          if (indexes.some((i) => { const s = stepByIndex.get(i); return !!s && isHeat(s); })) return true;
          if (indexes.length === 0) return false;
          const last = Math.max(...indexes);
          const later = ordered.filter((s) => s.stepIndex > last);
          const members = namesOf(memberIds);
          if (later.some((s) => isHeat(s) && (s.ingredientIds.some((id) => memberIds.includes(id)) || mentions(s.text, members)))) return true;
          const next = later[0];
          return !!next && isHeat(next) && next.ingredientIds.length === 0 && !mentions(next.text, allNames);
        };
        // ── D-WS9-301 rule 1 — the MOMENT each ingredient enters ───────────
        //
        // Same reason this lives in the adapter as the components above: it
        // needs the dish's STEPS, which the engine's input omits. One call per
        // dish; the result is an opaque per-ingredient key the assembly layer
        // buckets on.
        const moments = resolveMoments(
          dish.componentSteps ?? [],
          dish.ingredients.map((i) => ({
            ingredientId: i.ingredientId,
            ingredientName: i.ingredientName,
            preparationNote: i.preparationNote,
            phase: assignPhase(i.category, i.ingredientName, i.purchaseUnit),
          })),
          listingStep,
          // THX-3d (R1) — in the feast, another vessel is another run (prepMoments NEW_VESSEL).
          { vesselRuns: !!opts.feast },
        );
        // ── D-WS9-301 rule 1's INVERSE CASE — a component absorbs its run ───
        //
        // "The lemon-herb marinade… all its parts enter together (into the
        // marinade), so it is ONE container finished in ONE step — zest and
        // juice the lemon inside that step, never deferred to the produce
        // phase." The sample plan did the opposite and said so out loud: "Note:
        // the lemon zest and juice for this marinade are handled in the lemon
        // prep step — add them to this bowl once prepped."
        //
        // The marinade's own steps carry the component tag; the lemon's amount
        // is stated on a step that carries none. So the component supplies the
        // NAME and the run supplies MEMBERSHIP: whatever is measured in the same
        // run as a resolved component belongs in it.
        //
        // ⚠️ Proteins are excluded — ruling 1 again: raw flesh has a destination,
        // not a seat, and joins on cook day.
        // 🔴 AND RULE 2 IS WHAT STOPS IT SWALLOWING THE TACO ONION. "Dry blend:
        // 3+ dry items for one dish → one shelf-stable container… DRY ONLY.
        // Garlic, onion and fresh herbs never join a dry blend."
        //
        // Both of Hans's examples are "an unclaimed ingredient shares a run with
        // a component", and they must go opposite ways: the lemon DOES belong in
        // the marinade, the diced onion does NOT belong in the taco seasoning.
        // What tells them apart is the component itself — a marinade is wet and
        // things get added to it, a spice blend is dry and must stay shelf
        // stable. So an all-dry component absorbs nothing fresh.
        // ── D-WS9-301 rule 1, SCOPED BY H6.1 ruling 3 ─────────────────────────
        //
        // A resolved component occupies the run its members are measured in, and an
        // unclaimed ingredient measured in that run joins it. That is what puts the
        // lemon in the lemon-herb marinade, which is Hans's own rule 1.
        //
        // ⚠️ THE allDry GUARD IS NOT ENOUGH ON ITS OWN, and H6.0 found out how: the
        // taco's `seasoning` tag sits on the spice step AND on the later "stir in the
        // spice blend and 2 tablespoons tomato paste" step, so TOMATO PASTE is a
        // member, `every(dry)` is false, and the blend absorbed the diced garlic.
        // The guard stays — it is right about what it can see — and ruling 3's order
        // of authority does the rest: see `momentKeyFor`.
        const phaseOfIngredient = new Map(
          dish.ingredients.map((i) => [i.ingredientId, assignPhase(i.category, i.ingredientName, i.purchaseUnit)]),
        );
        const componentByRun = new Map<number, (typeof resolved.components)[number]>();
        for (const comp of resolved.components) {
          const allDry = comp.memberIds.every(
            (id) => phaseOfIngredient.get(id) === "seasonings_dry",
          );
          if (allDry) continue;
          for (const memberId of comp.memberIds) {
            const run = moments.runByIngredientId.get(memberId);
            if (run === undefined) continue;
            if (!componentByRun.has(run)) componentByRun.set(run, comp);
          }
        }
        // ── BUG-358 / D-WS9-301 MOMENT AUTHORITY — ONE COMPONENT, ONE MOMENT ────
        //
        // A component is not a moment. The nacho cheese sauce is one authored
        // `sauce` across four steps: the roux's flour goes into the butter (s1),
        // the milk after it (s2), the spices and hot sauce at the end (s3). Keyed on
        // the component alone, the flour and the hot sauce shared a jar. The BBQ
        // meatballs did the same with a binder made cold at s0 and a glaze poured
        // into the pan at s5.
        //
        // So a member's key is its component AND the moment it enters
        // (`mixtureEntryKey`): the step it goes into heat at, or the run of the cold
        // step that mixes it. A marinade built over three prep steps stays one
        // container; a run-absorbed ingredient is keyed the same way, so a glaze
        // simmered at s3 no longer rides a rub measured at s0.
        const entryOf = (id: string, name: string) => mixtureEntryKey(ordered, id, name, { vesselRuns: !!opts.feast });
        // THX-3 — in a feast, a salt or pepper rides its run into a mixture only beside a
        // DRY partner named in the same step that rides it too (the brine's salt with its
        // sugar). Alone in its step — the herb butter's pepper — it does not.
        const partneredSeasoning = (id: string): boolean => {
          const run = moments.runByIngredientId.get(id);
          return ordered.some((s) => s.ingredientIds.includes(id) && s.ingredientIds.some((o) => {
            if (o === id || phaseOfIngredient.get(o) !== "seasonings_dry") return false;
            const other = dish.ingredients.find((i) => i.ingredientId === o);
            // Named in the step's own words too: an amountRef can mis-bind ("leaves from 3
            // thyme sprigs" resolves to bay leaves on Classic's herb-butter step).
            return !!other && !isSaltOrPepper(other.ingredientName) && !isNeverMeasured(other.ingredientName) &&
              moments.runByIngredientId.get(o) === run && proseNames(s.text, other.ingredientName);
          }));
        };
        const momentKeyFor = (ing: { ingredientId: string; category: string; ingredientName: string }): string | null => {
          // THX-3 — IN A FEAST, A SALT OR PEPPER JOINS THE MIX IT IS MEASURED WITH: the
          // moment of a dry partner its own amount-referenced step names in words (the
          // brine's salt beside its sugar, the pie's salt beside its spices). The prose
          // resolver gave Vegetarian's apple-pie salt the step that says "unsalted butter".
          if (opts.feast && isSaltOrPepper(ing.ingredientName)) {
            // The seasoning's own head word, whole: "pepper" is not "peppercorns" (an
            // amountRef bound Make-Ahead's "1 teaspoon black peppercorns" to black pepper),
            // and "salt" is not "unsalted".
            const head = ing.ingredientName.toLowerCase().trim().split(/\s+/).pop() ?? "";
            const namesIt = (text: string) => new RegExp(`\\b${head}\\b`, "i").test(text);
            // THX-3d (R1) — BY THE STEP'S WORDS when no step states its amount: "a pinch
            // of kosher salt" has no amountRef, and the cranberry step that says it
            // beside the sugar and the cinnamon stick is still where it goes in.
            const stated = ordered.some((s) => s.ingredientIds.includes(ing.ingredientId));
            for (const s of ordered) {
              if ((stated && !s.ingredientIds.includes(ing.ingredientId)) || !namesIt(s.text)) continue;
              const partner = dish.ingredients.find((o) =>
                o.ingredientId !== ing.ingredientId &&
                s.ingredientIds.includes(o.ingredientId) &&
                phaseOfIngredient.get(o.ingredientId) === "seasonings_dry" &&
                !isSaltOrPepper(o.ingredientName) &&
                !isNeverMeasured(o.ingredientName) &&
                proseNames(s.text, o.ingredientName));
              if (partner) return momentKeyFor({ ingredientId: partner.ingredientId, category: partner.category, ingredientName: partner.ingredientName });
            }
            // No dry partner: seasoning to taste, measured at the stove — in no container.
            // Not a component's key (Classic's herb-butter pepper carried the brine's tag
            // and sat in the brine's bowl), and not its step's either (the Wellington's
            // salt and pepper joined the sherry-and-soy jar). `v:` groups with nothing.
            return `v:season:${ing.ingredientId}`;
          }
          const own = resolved.byIngredient.get(ing.ingredientId);
          if (own) return `c:${own.key}@${entryOf(ing.ingredientId, ing.ingredientName)}`;
          if (assignPhase(ing.category, ing.ingredientName) === "proteins") {
            return moments.keyByIngredientId.get(ing.ingredientId) ?? null;
          }
          // ── H6.1 ruling 3 — THE ORDER OF AUTHORITY, IN ONE PLACE ───────────
          //
          //   1. the ingredient's OWN tag        — `resolved.byIngredient`, above
          //   2. a cook step that names it       — an `s:` key from resolveMoments
          //   3. the run proxy, and only then the tag of a component sharing it
          //
          // 🔴 THE THIRD LINE IS WHAT SEPARATES THE TACO FROM THE LEMON, with no new
          // vocabulary. The garlic has "Add the minced garlic and cook…", so its key
          // is `s:4` and it is no longer a run neighbour — the spice blend cannot
          // reach it. The lemon has no cook step naming it, so it is still `r:0`,
          // and the marinade's tag takes it, which is rule 1.
          const resolvedKey = moments.keyByIngredientId.get(ing.ingredientId) ?? null;
          if (resolvedKey !== null && !resolvedKey.startsWith("r:")) return resolvedKey;
          // BUG-358 — a run is not a moment when the ingredient's own first use says
          // otherwise. The biryani's whole spices (fried at s5), its ground spices
          // (s6) and its yogurt marinade (s1) all sat in run 0 — consecutive cook
          // steps never open a new run, and an authored tag (`masala`) keeps
          // resolveMoments' prose override away — so they shared one "sauce jar".
          const entry = resolvedKey === null ? null : entryOf(ing.ingredientId, ing.ingredientName);
          if (entry !== null && entry.startsWith("s:")) return entry;
          const run = moments.runByIngredientId.get(ing.ingredientId);
          const shared = run === undefined ? undefined : componentByRun.get(run);
          // PREP-3 (R9) — ONE MOMENT PER JAR MEMBER. A run neighbour stays out of the
          // component when every step that states its amount USES it on something else
          // ("Pat the pork chops dry and brush both sides with 2 tablespoons Dijon"): the
          // Dijon shared the cold run with the crumb crust (step 2) and was stirred into
          // the crumbs. A step that only prepares it ("Zest and juice one lemon", D-WS9-301
          // rule 1's lemon), one of the component's own steps, or one that states another
          // of its members keeps the run's word; so does a food no step states.
          const statedIn = ordered.filter((s) => s.ingredientIds.includes(ing.ingredientId));
          const sameMoment = !shared || statedIn.length === 0 || statedIn.some((s) =>
            s.componentKey === shared.key ||
            shared.memberIds.some((m) => m !== ing.ingredientId && s.ingredientIds.includes(m)) ||
            !APPLIES_TO_FOOD.test(s.text));
          if (shared && sameMoment && !(opts.feast && isSaltOrPepper(ing.ingredientName) && !partneredSeasoning(ing.ingredientId))) return `c:${shared.key}@${entryOf(ing.ingredientId, ing.ingredientName)}`;
          return resolvedKey;
        };
        // PREP-3 (R4) — a component its own steps call a marinade IS one, whatever its
        // tag: the lemon-pepper chicken's `seasoning` is whisked "into a marinade" the
        // chicken is then coated in. (Weeknights: a feast's mixtures keep their nouns.)
        const saysMarinade = (comp: (typeof resolved.components)[number]): boolean =>
          !opts.feast && (comp.noun === "marinade" || comp.stepIndexes.some((i) => /\bmarinade\b/i.test(stepByIndex.get(i)?.text ?? "")));
        // Ruling 1 — a raw protein named by a mixture's steps joins it on cook
        // day. One protein can only join one bowl; first by component order.
        const cookDayIntoByIngredientId = new Map<string, string>();
        for (const c of resolved.components) {
          for (const id of c.cookDayIds) {
            if (!cookDayIntoByIngredientId.has(id)) cookDayIntoByIngredientId.set(id, c.bowlName);
          }
        }
        // WS7-8 BUG-003 — DENOMINATOR is the immutable authored anchor
        // (authoredBaseServings ?? baseServings); the NUMERATOR keeps its
        // no-override fallback of the live baseServings (= servingsDefault).
        // Anchor == baseServings until a future canonical promote, so today the
        // multiplier is unchanged.
        const authoredBase = dish.authoredBaseServings ?? dish.baseServings;
        const base = authoredBase > 0 ? authoredBase : 1;
        const effective = meal.servingsOverride ?? dish.baseServings;
        const multiplier = effective / base;
        // THX-3b (BUG-454) — a whole-bird dish scales by its bird, and the bird's own
        // parts never scale (prepQuantity `dishRowMultipliers`, the client's rule).
        const birdRows = dish.ingredients.map((i) => ({ ...splitCompoundUnit(i.quantity, i.unit), name: i.ingredientName, note: i.preparationNote }));
        const chosenLb = meal.bird?.dishId === dish.dishId ? meal.bird.lb : undefined;
        const rowMultiplier = dishRowMultipliers(
          birdRows,
          multiplier,
          // THX-3c (item 2) — a dish follows a bird by count only in a feast.
          // THX-4 (D-WS9-324) — the turkey's dish follows the weight the cook chose.
          { feast: !!meal.feast, ...(chosenLb !== undefined ? { birdLb: chosenLb } : {}) },
        );
        // SERVER-6 BUG-537 — a turkey written by count says the chosen weight in its note.
        const countBirdRow = chosenLb === undefined ? -1 : ((t) => (t?.byCount ? t.row : -1))(weighedTurkeyOf(birdRows));
        return {
          dishId: dish.dishId,
          dishName: dish.dishName,
          dishRole: dish.dishRole,
          ingredients: dish.ingredients.flatMap((ing, row) => {
            const split = splitCompoundUnit(ing.quantity, ing.unit);
            // H5.3 — drop the service portion before anything downstream can
            // cost it, name it or count a vessel for it.
            // THX-3c (E) — in the feast a FRESH HERB sliced "for topping" is still knife
            // work the session holds (Make-Ahead's chives): kept whole, its note intact, so
            // the holds decide whether it is cut ahead or "that morning". Citrus rounds and
            // wedges for serving stay out, as H5.3 ruled.
            const prep =
              prepPortion(ing.ingredientName, split.quantity, split.unit, ing.preparationNote) ??
              (opts.feast && FEAST_HERB.test(ing.ingredientName) ? { quantity: split.quantity, preparationNote: ing.preparationNote } : null);
            if (prep === null) return [];
            const category =
              ing.category && ing.category.trim() !== ""
                ? ing.category
                : inferCategory(ing.ingredientName);
            // ── THX-3 (D-WS9-316, Hans October 19) — A MAKE-AHEAD DISH BRINGS ITS
            // SHELF-STABLE MIX. "if the user can 'prep the feast' and combine all the
            // pie's dry ingredients ahead of time they should … then when it's time to make
            // the pie they combine that with the wet, mix, and bake."
            //
            // 🔴 THX-3c (E) — AND ITS PRODUCE CUTS. Hans, October 20: "the cook mode during
            // the week is expecting prep to happen ahead of it (which is good). and the prep
            // the feast is thin (which is bad) because it needs more prep work (which is
            // missing)". THX-3 dropped every perishable of a make-ahead dish here, but its
            // steps say "add the diced onions and celery": the cuts were nowhere (Classic's
            // produce steps 12 → 0). The cut onions, celery, carrots, garlic, herbs, citrus
            // and potatoes come back; their holds are measured to the DISH's day
            // (prepWeekBuild feastPortionDays), never Thursday. Liquids, dairy, eggs and
            // proteins still stay out — those are made on the day. Dropped HERE, after the
            // moments were resolved over the whole dish, so the dry mix keeps its moment.
            if (opts.feast && (dish.makeAheadDays?.length ?? 0) > 0) {
              const phase = assignPhase(category, ing.ingredientName, ing.purchaseUnit);
              const kept = phase === "seasonings_dry" || phase === "produce" || isSaltOrPepper(ing.ingredientName);
              if (isNeverMeasured(ing.ingredientName) || !kept) return [];
            }
            const claimed = resolved.byIngredient.get(ing.ingredientId) ?? null;
            // PREP-3 (R9) — a listing whose note names ANOTHER of the dish's components
            // ("1 clove garlic, halved, for rubbing croutons") is that one's, not the
            // claimant's: the Caesar lists garlic twice and the dressing, which states one
            // clove, took both — the croutons' rubbing clove sat in the dressing jar.
            const forWhat = /\bfor (?:rubbing |the |making |tossing )?([a-z-]+)/i.exec(prep.preparationNote ?? "")?.[1]?.toLowerCase().replace(/s$/, "");
            const otherComponent = !!claimed && !!forWhat && ordered.some((s) => s.componentKey && s.componentKey !== claimed.key && s.componentKey.toLowerCase().replace(/s$/, "") === forWhat);
            const comp = otherComponent ? null : claimed;
            const cookDayInto = cookDayIntoByIngredientId.get(ing.ingredientId) ?? null;
            return [{
              ingredientId: ing.ingredientId,
              ingredientName: ing.ingredientName,
              category,
              // THX-3b (BUG-454) — the row's own multiplier: the bird's factor in a
              // whole-bird dish, 1 for a neck or giblets, else the servings.
              quantity: prep.quantity * rowMultiplier[row],
              unit: split.unit,
              // THX-3d round 2 (P) — at its own servings the amount prints as written.
              ...(Math.abs(rowMultiplier[row] - 1) < 1e-9 ? { asWritten: true } : {}),
              // THX-3d round 2 (L) — a feast cavity's vegetable with no cut ("celery, for
              // cavity") is trimmed in Prep the feast, beside the onion and the lemon that
              // go in with it: Cook Mode named those as prepped and listed the celery raw.
              preparationNote: opts.feast && category.toLowerCase() === "produce" && /\bfor (?:the )?cavity\b/i.test(prep.preparationNote ?? "") && !cutOf([prep.preparationNote ?? ""])
                ? `trimmed, ${prep.preparationNote}`
                : row === countBirdRow && chosenLb !== undefined
                  ? birdLineAtWeight({ name: ing.ingredientName, note: prep.preparationNote }, chosenLb).note
                  : prep.preparationNote,
              component: comp
                ? { key: comp.key, noun: saysMarinade(comp) ? "marinade" : comp.noun, bowlName: comp.bowlName, heated: componentHeated(comp.stepIndexes, comp.memberIds) }
                : null,
              cookDayInto,
              // H6.2 follow-up — THE COOK STEP THAT NAMES THIS PORTION, when one does.
              // The moment says which mixture it belongs to; this says whether it goes
              // into the pot later than the things it was cut beside, which is the one
              // case where sharing a bowl would make the cook unpack it.
              entryStep: (() => {
                const k = moments.keyByIngredientId.get(ing.ingredientId);
                // (THX-3d round 2 — a feast key carries its clause: "s:4/c1".)
                const m = k ? /^s:(\d+)(?:\/c\d+)?$/.exec(k) : null;
                return m ? Number(m[1]) : null;
              })(),
              momentKey: otherComponent ? `v:for:${forWhat}:${ing.ingredientId}` : momentKeyFor({
                ingredientId: ing.ingredientId,
                category,
                ingredientName: ing.ingredientName,
              }),
              // D-WS9-297 ruling 8 — passed straight through. The compound-unit
              // split above touches the DEMAND's unit; the yield is a property
              // of the ingredient and is unaffected by it.
              sourceYield: ing.sourceYield,
              // H7 2e — the catalog pack, so the engine's phase split agrees with
              // the one computed above for the component and moment passes.
              purchaseUnit: ing.purchaseUnit ?? null,
            }];
          }),
        };
      };
      // ── THX-3b (BUG-456) — ONE INGREDIENT LISTED TWICE, EACH PORTION WITH ITS STEP ──
      //
      // The Sweet Potato Casserole lists brown sugar twice — ¼ cup for the filling,
      // ½ cup for the topping — and both portions sat in the filling's dry mix: every
      // moment below is keyed on the ingredient id, which the two rows share. So the
      // dish is mapped again over a VIEW in which each extra row has an id of its own
      // and each step lists the row its amountRef measures; the view is kept only when
      // some ingredient's rows now enter at different moments (otherwise the dish is
      // mapped exactly as before), and its rows go out under the real id with a
      // `portion` the assembly keys on.
      return {
      mealId: meal.mealId,
      mealName: meal.mealName,
      dishes: meal.dishes.map((loadedDish) => {
        const plain = mapDish(loadedDish);
        const view = portionView(loadedDish);
        if (!view) return plain;
        const split = mapDish(
          view.dish,
          new Map([...view.rowOf].filter(([, r]) => r.step !== null).map(([id, r]) => [id, r.step!])),
        );
        const keysOf = new Map<string, Set<string>>();
        for (const r of split.ingredients) {
          const real = view.rowOf.get(r.ingredientId)?.real ?? r.ingredientId;
          keysOf.set(real, (keysOf.get(real) ?? new Set()).add(r.momentKey ?? ""));
        }
        const splitIds = new Set([...keysOf].filter(([id, keys]) => view.listedTwice.has(id) && keys.size > 1).map(([id]) => id));
        if (splitIds.size === 0) return plain;
        return {
          ...split,
          ingredients: split.ingredients.map((r) => {
            const row = view.rowOf.get(r.ingredientId);
            if (!row) return r;
            return splitIds.has(row.real)
              ? { ...r, ingredientId: row.real, portion: row.portion, ...(row.step !== null ? { portionStep: row.step } : {}) }
              : { ...r, ingredientId: row.real };
          }),
        };
      }),
      };
    }),
  };
}

/**
 * THX-3b (BUG-456) — a dish that lists one ingredient more than once, seen with one
 * id per row: the first row keeps the real id, the n-th becomes `<id>#<n>`, and each
 * step's ingredientIds name the row whose amountRef it carries (by quantity, then in
 * order). Null for a dish that lists every ingredient once.
 */
export function portionView(dish: PrepLoadedDish): {
  dish: PrepLoadedDish;
  /** The ids that are listed twice. */
  listedTwice: Set<string>;
  /** view id → the real id, the row's portion ("1", "2"…) and the step it is measured at. */
  rowOf: Map<string, { real: string; portion: string; step: number | null }>;
} | null {
  const rowsById = new Map<string, number[]>();
  dish.ingredients.forEach((i, n) => rowsById.set(i.ingredientId, [...(rowsById.get(i.ingredientId) ?? []), n]));
  const twice = [...rowsById].filter(([, rows]) => rows.length > 1);
  if (twice.length === 0) return null;
  const ordered = [...(dish.componentSteps ?? [])].sort((a, b) => a.stepIndex - b.stepIndex);
  const viewId = dish.ingredients.map((i) => i.ingredientId);
  const stepOfRow = new Map<number, number>();
  const rowOf = new Map<string, { real: string; portion: string; step: number | null }>();
  for (const [id, rows] of twice) {
    const refs = ordered.flatMap((s) => (s.refs ?? []).filter((r) => r.ingredientId === id).map((r) => ({ step: s.stepIndex, q: r.quantity })));
    const taken = new Set<number>();
    const take = (n: number, match: (r: { q: number }) => boolean) => {
      const k = refs.findIndex((r, j) => !taken.has(j) && match(r));
      if (k >= 0) { taken.add(k); stepOfRow.set(n, refs[k].step); }
    };
    for (const n of rows) take(n, (r) => Math.abs(r.q - dish.ingredients[n].quantity) < 1e-9);
    for (const n of rows) if (!stepOfRow.has(n)) take(n, () => true);
    rows.forEach((n, i) => {
      if (i > 0) viewId[n] = `${id}#${i + 1}`;
      rowOf.set(viewId[n], { real: id, portion: String(i + 1), step: stepOfRow.get(n) ?? null });
    });
  }
  const listedTwice = new Set(twice.map(([id]) => id));
  return {
    listedTwice,
    rowOf,
    dish: {
      ...dish,
      ingredients: dish.ingredients.map((i, n) => ({ ...i, ingredientId: viewId[n] })),
      componentSteps: ordered.map((s) => ({
        ...s,
        ingredientIds: [...new Set(s.ingredientIds.flatMap((id) => {
          if (!listedTwice.has(id)) return [id];
          const mine = rowsById.get(id)!.filter((n) => stepOfRow.get(n) === s.stepIndex).map((n) => viewId[n]);
          return mine.length > 0 ? mine : [id];
        }))],
      })),
    },
  };
}
