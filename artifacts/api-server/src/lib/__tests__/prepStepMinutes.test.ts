// WS9 BUG-204 — the clock the code owns.
//
// The per-step estimate used to be the model's, and across the 14-plan corpus it
// ran about 3x long (mean 6.6 min; 3 min to halve one poblano). That was
// cosmetic until D-WS9-301 ruling 4 put the SUM in the header: "18 containers ·
// about 120 min" for work that takes about forty. Hans's condition for showing a
// total at all was trust — "40 minutes is no more than 50 minutes or so in
// reality" — and the number was failing it in the expensive direction.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MINUTES, timeRow, timeStep, planMinutes, parseAmount } from "../prepStepMinutes";

const comp = (
  ingredientName: string,
  preparationNote: string | null,
  ...amounts: string[]
) => ({
  ingredientName,
  preparationNote,
  measures: amounts.map((amount) => ({ amount, preparationNote: null })),
});

// ── the three shapes the ruling names ───────────────────────────────────────

describe("BUG-204 — the table's arithmetic", () => {
  it("🔴 a 4-item dry blend is 2 minutes", () => {
    // 4 × 0.5 = 2. Not 3, which is what the model said for exactly this step.
    const t = timeStep({
      components: [
        comp("all-purpose flour", null, "1½ cup"),
        comp("baking powder", null, "2 tsp"),
        comp("baking soda", null, "¼ tsp"),
        comp("fine salt", null, "½ tsp"),
      ],
    });
    assert.equal(t.minutes, 2);
    assert.equal(t.rows.every((r) => r.action === "measure"), true);
  });

  it("🔴 mincing 9 cloves of garlic is 3 minutes", () => {
    const t = timeStep({ components: [comp("garlic cloves", "minced", "9 cloves")] });
    assert.equal(t.minutes, 3);
    assert.equal(t.rows[0].action, "garlic");
  });

  it("🔴 a whisked marinade: oil + 4 cloves + 2 herbs + a lemon = 7 minutes", () => {
    // 0.5 oil + (4/3) garlic + 0.25 + 0.25 herbs + 1.5 lemon + 1 whisk = 4.83…
    // …and the ruling's worked example reads 1 + 2 + 1 + 1.5 + 1 → 7, which is
    // the same shape costed with the coarser per-class figures. The table is the
    // authority and it is slightly cheaper than the sketch; recorded rather than
    // forced, because inventing padding to hit 7 would be the opposite of what
    // BUG-204 is about.
    const t = timeStep({
      bowlName: "Lemon-Herb Baked Chicken Breast marinade bowl",
      components: [
        comp("extra-virgin olive oil", null, "3 tbsp"),
        comp("garlic", "minced", "4 cloves"),
        comp("fresh rosemary", "finely chopped", "2 tsp"),
        comp("fresh thyme", "leaves stripped", "2 tsp"),
        comp("lemon", "zested and juiced", "2 each"),
      ],
    });
    assert.equal(t.rows.find((r) => r.ingredientName === "garlic")!.action, "garlic");
    assert.equal(t.rows.find((r) => r.ingredientName === "lemon")!.action, "citrus-zest-juice");
    // The whisk is added once for the bowl, not once per ingredient.
    assert.ok(t.minutes >= 5 && t.minutes <= 7, `got ${t.minutes}`);
  });

  it("dicing an onion is 2½ minutes, and a whole onion counts as one", () => {
    // H6.1 ruling 2 — the single `perCutVegetable: 2` costed an onion, a pepper, a
    // celery stalk and a carrot alike. These are the H2 table's own per-vegetable
    // figures, which H2 · 1 collapsed at authoring time: onion 2.5, celery 0.5,
    // carrot 1 (+0.5 to peel), potato 1.5.
    assert.equal(timeStep({ components: [comp("yellow onion", "diced", "1 each")] }).minutes, 3);
    assert.equal(timeStep({ components: [comp("yellow onion", "finely diced", "2 each")] }).minutes, 5);
  });

  it("🔴 and a celery stalk is NOT an onion", () => {
    // 3 stalks read 6 minutes on Hans's plan. The table says 0.5 each.
    assert.equal(timeStep({ components: [comp("celery stalks", "sliced", "3 each")] }).minutes, 2);
    assert.equal(timeStep({ components: [comp("carrots", "sliced", "2 each")] }).minutes, 2);
    // Peeling is charged on top, and only for a carrot.
    assert.equal(timeStep({ components: [comp("carrots", "peeled and sliced", "2 each")] }).minutes, 3);
    // A potato reads its own rate only once it is in CUT_VEG; before that it took
    // the batch floor, where 2 potatoes cost the same as 20.
    assert.equal(timeStep({ components: [comp("baby Yukon gold potatoes", "halved", "2 each")] }).minutes, 3);
  });

  it("🔴 a bare count on a clove-shaped name is a CLOVE count", () => {
    // The old line demanded the unit token be literally "clove(s)" and charged ONE
    // clove otherwise, so a merged garlic group of 27 cost 20 seconds. 16 of the
    // corpus's 79 garlic measures were being charged as one clove.
    assert.equal(timeStep({ components: [comp("garlic cloves", "minced", "27 cloves")] }).minutes, 9);
    assert.equal(timeStep({ components: [comp("garlic cloves", "minced", "27")] }).minutes, 9);
    assert.equal(timeStep({ components: [comp("garlic", "minced", "3 cloves")] }).minutes, 1);
  });

  it("a batch vegetable is costed by weight, with a floor", () => {
    // 1¼ lb asparagus × 2 = 2.5 → 3.
    assert.equal(timeStep({ components: [comp("asparagus", "woody ends snapped off", "1¼ lb")] }).minutes, 3);
    // A small batch still costs the floor.
    assert.equal(timeStep({ components: [comp("asparagus", "trimmed", "½ lb")] }).minutes, 2);
  });

  it("meat: cubing costs more per lb than portioning", () => {
    const cube = timeStep({ components: [comp("beef chuck", "cut into ¾-inch cubes", "2 lb")] });
    const portion = timeStep({ components: [comp("chicken thighs", null, "2 lb")] });
    assert.equal(cube.minutes, 8);
    assert.equal(portion.minutes, 6);
    assert.equal(cube.rows[0].action, "meat-cube");
    assert.equal(portion.rows[0].action, "meat-portion");
  });

  it("🔴 a container is never worth less than a minute, and never zero", () => {
    assert.equal(timeStep({ components: [comp("hot sauce", null, "1 tbsp")] }).minutes, 1);
    assert.equal(timeStep({ components: [] }).minutes, MINUTES.stepFloor);
  });

  it("🔴 garlic powder is not garlic, and that is a 1-minute difference", () => {
    assert.equal(timeRow("garlic powder", null as unknown as string, "½ tsp").action, "measure");
    assert.equal(timeRow("garlic", "minced", "3 cloves").action, "garlic");
  });

  it("an unreadable amount counts as one item rather than guessing a magnitude", () => {
    assert.deepEqual(parseAmount("a splash"), { quantity: null, unit: "a splash" });
    const t = timeStep({ components: [comp("soy sauce", null, "a splash")] });
    assert.equal(t.minutes, 1);
  });
});

// ── the cap ─────────────────────────────────────────────────────────────────

describe("BUG-204 — the cap reports, it does not hide", () => {
  it("🔴 anything over 15 minutes is a CLASSIFICATION ERROR and says so", () => {
    // 10 lb of chuck at 4 min/lb is 40 minutes. No prep step is 40 minutes; a
    // number that size means a quantity or a unit was read wrong, and the cap
    // keeps one bad row from poisoning the header.
    const t = timeStep({ components: [comp("beef chuck", "cut into cubes", "10 lb")] });
    assert.equal(t.minutes, MINUTES.stepCap);
    assert.equal(t.overCap, true);
    assert.equal(t.rawMinutes, 40);
  });

  it("a step inside the cap does not raise the flag", () => {
    const t = timeStep({ components: [comp("beef chuck", "cut into cubes", "2 lb")] });
    assert.equal(t.overCap, false);
  });
});

// ── the plan total ──────────────────────────────────────────────────────────

describe("BUG-204 — the header total: 10% overhead, then UP to the next 5", () => {
  it("🔴 36 minutes of steps states 40", () => {
    // 36 × 1.1 = 39.6 → 40. The overhead is getting containers out and wiping
    // the board down, and it is the ONLY padding.
    assert.equal(planMinutes([10, 8, 6, 5, 4, 3]), 40);
  });

  it("🔴 ROUNDS UP, NEVER DOWN — the direction is the trust condition", () => {
    assert.equal(planMinutes([10]), 15); // 11 → 15, not 10
    assert.equal(planMinutes([4]), 5);
    assert.equal(planMinutes([40]), 45); // 44 → 45
  });

  it("an empty plan is zero, so the header can hide itself", () => {
    assert.equal(planMinutes([]), 0);
  });

  it("the overhead is applied ONCE to the plan, not per step", () => {
    // Per-step padding compounds, and compounding is what put "about 120 min"
    // on a 40-minute plan in the first place.
    const twenty = planMinutes([20]);
    const tens = planMinutes([10, 10]);
    assert.equal(twenty, tens);
  });
});

// ── H2b — the two measured inflations ───────────────────────────────────────

/** A yield lookup in the shape `buildStepPlan` passes: "lime → 2 tbsp of juice". */
function yields(table: Record<string, { fromName: string; quantity: number; unit: string }>) {
  const TBSP: Record<string, number> = { tbsp: 1, tsp: 1 / 3, cup: 16 };
  return (name: string) => {
    const y = table[name];
    if (!y) return null;
    return {
      yield: y,
      count: (q: number | null, u: string | null) => {
        if (q == null || !u) return null;
        const inTbsp = (TBSP[u] ?? null) === null ? null : q * TBSP[u];
        if (inTbsp == null) return null;
        return Math.ceil(inTbsp / y.quantity - 1e-9);
      },
    };
  };
}

describe("H2b ruling 1 — a shared container's knife work is costed ONCE", () => {
  it("🔴 four per-dish measures of one onion are ONE dicing, sized by the total", () => {
    // Rule 5 gives a shared container a measure per destination dish: "1 white
    // onion for the enchiladas, ½ for the sauce, ½ for the rice, ½ for the
    // fixings". Costed per measure that is four separate onion-dicings — the
    // counter-version of the rule that created the container.
    const t = timeStep({
      components: [
        {
          ingredientName: "white onion",
          preparationNote: "finely diced",
          measures: [
            { amount: "1 each", preparationNote: null },
            { amount: "½ each", preparationNote: null },
            { amount: "½ each", preparationNote: null },
            { amount: "½ each", preparationNote: null },
          ],
        },
      ],
    });
    const cuts = t.rows.filter((r) => r.action === "cut-vegetable");
    assert.equal(cuts.length, 1, `the cut was charged ${cuts.length} times`);
    assert.equal(cuts[0].quantity, 2.5, "the total is 2½ onions");
    // 2½ onions rounds up to 3 whole ones × 2 min. Not 4 × 2 = 8.
    // 1 + ½ + ½ + ½ = 2½ onions, ROUNDED to 3 whole onions (you dice a whole one),
    // at 2.5 each = 7.5 → 8. The rounding is pre-existing; only the rate moved.
    assert.equal(t.minutes, 8);
  });

  it("…and one dish's single measure is unaffected", () => {
    const t = timeStep({
      components: [{ ingredientName: "yellow onion", preparationNote: "diced", measures: [{ amount: "1 each", preparationNote: null }] }],
    });
    assert.equal(t.minutes, 3);
  });
});

describe("H2b ruling 2 — juice and zest are charged on the FRUIT COUNT", () => {
  const LIME = yields({ "lime juice": { fromName: "lime", quantity: 2, unit: "tbsp" } });

  it("🔴 3 tbsp of lime juice is TWO limes, so three minutes of squeezing", () => {
    // Not three limes (the first error) and not the ¼-cup floor of 1.5 min (the
    // second). `ingredient_relations` says a lime gives 2 tbsp, so 3 tbsp is two
    // limes — the same number the prose already prints as "(from 2 limes)".
    const t = timeStep(
      { components: [{ ingredientName: "lime juice", preparationNote: null, measures: [{ amount: "3 tbsp", preparationNote: null }] }] },
      LIME,
    );
    const row = t.rows.find((r) => r.action === "citrus-zest-juice")!;
    assert.equal(row.minutes, 3);
    assert.equal(row.sourceName, "lime");
    assert.equal(t.minutes, 3);
  });

  it("2 tbsp is ONE lime, not two — the boundary is not a rounding artefact", () => {
    const t = timeStep(
      { components: [{ ingredientName: "lime juice", preparationNote: null, measures: [{ amount: "2 tbsp", preparationNote: null }] }] },
      LIME,
    );
    assert.equal(t.minutes, 2); // 1.5 → ceil 2
  });

  it("🔴 ZESTING AND JUICING ONE LIME IS ONE LIME", () => {
    // The corpus had a step wanting ½ tsp of zest AND 2 tbsp of juice, each
    // resolving to one lime, each charged 1.5 min. The table's 1.5 is for doing
    // BOTH to one fruit.
    const both = yields({
      "lime juice": { fromName: "lime", quantity: 2, unit: "tbsp" },
      "lime zest": { fromName: "lime", quantity: 1, unit: "tsp" },
    });
    const t = timeStep(
      {
        components: [
          { ingredientName: "lime zest", preparationNote: null, measures: [{ amount: "½ tsp", preparationNote: null }] },
          { ingredientName: "lime juice", preparationNote: null, measures: [{ amount: "2 tbsp", preparationNote: null }] },
        ],
      },
      both,
    );
    const charged = t.rows.filter((r) => r.charged !== false);
    assert.equal(charged.length, 1, "both operations on one lime were charged");
    assert.equal(t.rows.length, 2, "…but both rows are still reported");
    assert.equal(t.minutes, 2); // one lime, 1.5 → ceil 2
  });

  it("…while juice from DIFFERENT fruit is charged separately", () => {
    const two = yields({
      "lime juice": { fromName: "lime", quantity: 2, unit: "tbsp" },
      "lemon juice": { fromName: "lemon", quantity: 3, unit: "tbsp" },
    });
    const t = timeStep(
      {
        components: [
          { ingredientName: "lime juice", preparationNote: null, measures: [{ amount: "2 tbsp", preparationNote: null }] },
          { ingredientName: "lemon juice", preparationNote: null, measures: [{ amount: "3 tbsp", preparationNote: null }] },
        ],
      },
      two,
    );
    assert.equal(t.rows.filter((r) => r.charged !== false).length, 2);
    assert.equal(t.minutes, 3); // 1.5 + 1.5
  });

  it("🔴 and the per-dish split is summed BEFORE the fruit count is taken", () => {
    // Three dishes wanting 2 tbsp each is 6 tbsp — three limes, not three
    // separate one-lime charges. Ruling 1 and ruling 2 are the same defect in
    // two domains, and the fold is what makes them one fix.
    const t = timeStep(
      {
        components: [
          {
            ingredientName: "lime juice",
            preparationNote: null,
            measures: [
              { amount: "2 tbsp", preparationNote: null },
              { amount: "2 tbsp", preparationNote: null },
              { amount: "2 tbsp", preparationNote: null },
            ],
          },
        ],
      },
      LIME,
    );
    const row = t.rows.find((r) => r.action === "citrus-zest-juice")!;
    assert.equal(row.quantity, 6, "the three dishes' shares were not summed");
    assert.equal(row.minutes, 4.5); // 3 limes × 1.5
  });

  it("no yield edge falls back to the count rule, unchanged", () => {
    const t = timeStep({
      components: [{ ingredientName: "lemon", preparationNote: "zested and juiced", measures: [{ amount: "2 each", preparationNote: null }] }],
    });
    assert.equal(t.minutes, 3); // 2 fruit × 1.5
  });
});
