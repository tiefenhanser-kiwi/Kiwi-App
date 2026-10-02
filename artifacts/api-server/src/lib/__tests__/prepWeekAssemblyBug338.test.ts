// WS9 BUG-338 / D-WS9-297 — the Prep & Cook pass, B1 prep rulings 8, 9 and 10.
//
// Ruling 7 (glyphs and counts) is asserted in prepWeekAssembly.test.ts, beside
// the formatMeasure tests it changed. This file covers the three rulings that
// needed new data to flow, and each fixture is a repro reduced from the 13-plan
// census (scripts/prep-cook-census).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { combinePrep, type PrepCombineInput } from "../prepCombineEngine";
import { buildStepPlan } from "../prepWeekAssembly";

// ── fixture builder ─────────────────────────────────────────────────────────

interface IngSpec {
  id: string;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  note?: string;
  sourceYield?: { fromName: string; quantity: number; unit: string };
}

function input(dishes: { dishId: string; dishName: string; ingredients: IngSpec[] }[]): PrepCombineInput {
  return {
    meals: [
      {
        mealId: "meal-1",
        mealName: "Test Meal",
        dishes: dishes.map((d) => ({
          dishId: d.dishId,
          dishName: d.dishName,
          dishRole: "main" as const,
          ingredients: d.ingredients.map((i) => ({
            ingredientId: i.id,
            ingredientName: i.name,
            category: i.category,
            quantity: i.quantity,
            unit: i.unit,
            preparationNote: i.note ?? null,
            sourceYield: i.sourceYield ?? null,
          })),
        })),
      },
    ],
  };
}

const plan = (i: PrepCombineInput) => buildStepPlan(combinePrep(i), "Test Plan");
/** Every measure across every step, flattened, for the assertions below. */
const allMeasures = (i: PrepCombineInput) =>
  plan(i).steps.flatMap((s) =>
    s.components.flatMap((c) => c.measures.map((m) => ({ step: s, ingredient: c.ingredientName, ...m }))),
  );

// ── ruling 8 — how many limes is that ──────────────────────────────────────

describe("D-WS9-301 rule 14 — the source parenthetical is GONE from every step", () => {
  const limeJuice = (quantity: number, unit: string): PrepCombineInput =>
    input([
      {
        dishId: "d1",
        dishName: "Carne Asada",
        ingredients: [
          {
            id: "ing-lime-juice",
            name: "lime juice",
            category: "Produce",
            quantity,
            unit,
            sourceYield: { fromName: "lime", quantity: 2, unit: "tbsp" },
          },
        ],
      },
    ]);

  it("🔴 a derived ingredient no longer carries '(from 2 limes)'", () => {
    // D-WS9-297 ruling 8 ADDED this, to fix P-R6: a juice step that never said
    // how many limes it took. Hans read the result on the device and ruled the
    // other way — "'3 cloves garlic', never '3 cloves garlic (from 1 garlic
    // head)' … the count stays in the grocery list where it belongs." A prep
    // card is for the cook at the counter, who has already shopped.
    for (const demand of [limeJuice(3, "tbsp"), limeJuice(4, "tbsp"), limeJuice(2, "tbsp"), limeJuice(0.25, "cup")]) {
      const m = allMeasures(demand).find((x) => x.ingredient === "lime juice");
      assert.ok(m, "the measure should still exist");
      assert.equal(
        (m as unknown as { fromSource?: string }).fromSource,
        undefined,
        "a source parenthetical survived",
      );
    }
  });

  it("…and no step's prose input can reach one either", () => {
    // Structural, not per-field: nothing in the narration input may carry the
    // string, or the narrator will echo it back.
    const json = JSON.stringify(
      buildStepPlan(combinePrep(limeJuice(3, "tbsp")), "Test Plan").narrationInput,
    );
    assert.ok(!json.includes("fromSource"), "fromSource reached the narration input");
    assert.ok(!/from \d+ lime/i.test(json), "a '(from N limes)' string reached the narration input");
  });

  it("🔴 but the ARITHMETIC survives, because the clock still needs it", () => {
    // Retiring the display must not retire the knowledge. 3 tbsp of lime juice
    // is still two limes to squeeze, and BUG-204's timing is costed on exactly
    // that number — so the yield has to keep reaching the engine even though
    // nothing prints it.
    const sp = buildStepPlan(combinePrep(limeJuice(3, "tbsp")), "Test Plan");
    const step = sp.steps.find((x) => x.components.some((c) => c.ingredientName === "lime juice"));
    assert.ok(step, "the lime-juice step should exist");
    // Two limes at 1.5 min each = 3.
    assert.equal(step!.estimatedMinutes, 3);
  });

  it("an ingredient with no component parent is unchanged", () => {
    const i = input([
      { dishId: "d1", dishName: "Pico", ingredients: [{ id: "ing-tom", name: "roma tomatoes", category: "Produce", quantity: 3, unit: "each" }] },
    ]);
    const m = allMeasures(i).find((x) => x.ingredient === "roma tomatoes");
    assert.ok(m, "the tomato measure should exist");
    // And D-WS9-297 ruling 7: the placeholder unit is still gone.
    assert.equal(m!.amount, "3");
  });
});

// ── ruling 9 — a blend of one is not a blend ────────────────────────────────

describe("BUG-338 ruling 9 — a one-component blend folds into its dish's sauce step", () => {
  // THE BBQ DRUMSTICKS REPRO. Its prep was two piles: "seasonings_dry:{smoked
  // paprika}" and "sauces_marinades:{bbq sauce}". Two steps, two containers, for
  // one sauce.
  const drumsticks = input([
    {
      dishId: "d1",
      dishName: "BBQ Chicken Drumsticks",
      ingredients: [
        // Three dry spices on this dish is what makes them blend components at
        // all (the <3-per-dish noise filter); two of them are shared with the
        // other dish so only one survives onto THIS dish's blend step.
        { id: "ing-paprika", name: "smoked paprika", category: "Pantry", quantity: 1, unit: "tsp" },
        { id: "ing-bbq", name: "bbq sauce", category: "Pantry", quantity: 0.5, unit: "cup", note: "for brushing" },
      ],
    },
    {
      dishId: "d2",
      dishName: "Charred Bell Peppers",
      ingredients: [
        { id: "ing-cumin", name: "ground cumin", category: "Pantry", quantity: 1, unit: "tsp" },
        { id: "ing-chili", name: "chili powder", category: "Pantry", quantity: 1, unit: "tsp" },
        { id: "ing-paprika", name: "smoked paprika", category: "Pantry", quantity: 1, unit: "tsp" },
      ],
    },
  ]);

  it("the folded dish gets no separate seasonings_dry step", () => {
    const steps = plan(drumsticks).steps;
    const blendForD1 = steps.find((s) => s.stepKey === "seasonings_dry#dish#d1");
    assert.equal(blendForD1, undefined, "the one-component blend step should be gone");
  });

  it("its component rides on the sauce step instead, so nothing is lost", () => {
    const steps = plan(drumsticks).steps;
    const sauce = steps.find((s) => s.stepKey === "sauces_marinades#dish#d1");
    assert.ok(sauce, "the sauce step should exist");
    const names = sauce!.components.map((c) => c.ingredientName);
    assert.ok(names.includes("smoked paprika"), `paprika missing from the sauce step: ${names.join(", ")}`);
    assert.ok(names.includes("bbq sauce"), `bbq sauce missing: ${names.join(", ")}`);
  });

  it("🔴 no step points at another container — `blendSpiceDish` is retired", () => {
    // B1 asserted that the FOLDED dish's linkage sentence was suppressed. The
    // field is gone entirely now (D-WS9-296): a mixture is one named vessel, so
    // there is never a second container to point at.
    for (const st of plan(drumsticks).steps) {
      assert.ok(!("blendSpiceDish" in st), `${st.stepKey} still carries blendSpiceDish`);
    }
    for (const st of plan(drumsticks).narrationInput.steps) {
      assert.ok(!("blendSpiceDish" in st), `${st.stepId} still sends blendSpiceDish`);
    }
  });

  it("a MULTI-component blend is untouched — this is not a general collapse", () => {
    const steps = plan(drumsticks).steps;
    const blendForD2 = steps.find((s) => s.stepKey === "seasonings_dry#dish#d2");
    assert.ok(blendForD2, "the three-spice blend should still be its own step");
    assert.equal(blendForD2!.isBlend, true);
    assert.equal(blendForD2!.components.length, 3);
  });

  it("a one-component blend on a dish with NO sauce step is left alone, not dropped", () => {
    // The other 5 of the census's 17. Dropping prep work is Hans's call.
    const noSauce = input([
      {
        dishId: "d1",
        dishName: "Lemon-Herb Chicken",
        ingredients: [{ id: "ing-oregano", name: "dried oregano", category: "Pantry", quantity: 1, unit: "tsp" }],
      },
      {
        dishId: "d2",
        dishName: "Roasted Potatoes",
        ingredients: [
          { id: "ing-oregano", name: "dried oregano", category: "Pantry", quantity: 1, unit: "tsp" },
          { id: "ing-paprika", name: "smoked paprika", category: "Pantry", quantity: 1, unit: "tsp" },
          { id: "ing-garlicp", name: "garlic powder", category: "Pantry", quantity: 1, unit: "tsp" },
        ],
      },
    ]);
    const steps = plan(noSauce).steps;
    const oregano = steps.filter((s) => s.components.some((c) => c.ingredientName === "dried oregano"));
    assert.ok(oregano.length > 0, "the lone oregano must still be prepped somewhere");
  });
});

// ── ruling 10 — the join sentence, as far as it reaches ─────────────────────

// ── 🔴 RULING 10's TWO TESTS ARE GONE, WITH THE INTERIM THEY PINNED ────────
//
// B1 set `blendSpiceDish` on a single-dish produce step so the carne asada's
// orange juice could at least get the sentence the teriyaki glaze got, and the
// second test RECORDED THE GAP: a produce step feeding three dishes got
// nothing, because the field is one dish name and naming one would have told
// the cook to tip three portions into one bowl.
//
// D-WS9-296 closes that gap rather than widening the interim, so both tests
// are retired with the field. The replacement is prepComponentsBug338.test.ts:
// the shared lime juice now reaches each dish's own bowl, which is the thing
// the gap was about.
// ── ruling 13 — the cook day reaches the narration input ────────────────────

describe("BUG-338 ruling 13 — daysUntilCook rides on the step", () => {
  // Two meals, one shared ingredient. The loader's job (reading assignedDate) is
  // covered in prepWeekAggregation.test.ts; this is the arithmetic that turns a
  // per-meal date into a per-step lag.
  const twoMeals: PrepCombineInput = {
    meals: [
      {
        mealId: "meal-tue",
        mealName: "Tuesday Meal",
        dishes: [
          {
            dishId: "d1",
            dishName: "Stir-Fry",
            dishRole: "main",
            ingredients: [
              { ingredientId: "ing-garlic", ingredientName: "garlic", category: "Produce", quantity: 2, unit: "clove", preparationNote: "minced", sourceYield: null },
            ],
          },
        ],
      },
      {
        mealId: "meal-sat",
        mealName: "Saturday Meal",
        dishes: [
          {
            dishId: "d2",
            dishName: "Tacos",
            dishRole: "main",
            ingredients: [
              { ingredientId: "ing-garlic", ingredientName: "garlic", category: "Produce", quantity: 3, unit: "clove", preparationNote: "minced", sourceYield: null },
            ],
          },
        ],
      },
    ],
  };

  const lagMap = new Map([
    ["meal-tue", 2],
    ["meal-sat", 6],
  ]);

  it("takes the LATEST cook day, because that is what the portion must survive to", () => {
    const sp = buildStepPlan(combinePrep(twoMeals), "Test Plan", new Map(), lagMap);
    const garlic = sp.steps.find((s) => s.components.some((c) => c.ingredientName === "garlic"));
    assert.ok(garlic, "the garlic step should exist");
    // One step feeds both meals; min would be 2 and would let it spoil by Saturday.
    assert.equal(garlic!.daysUntilCook, 6);
  });

  it("🔴 does NOT reach the narration input — the prompt never sees a date", () => {
    // THIS TEST WAS THE OPPOSITE ASSERTION IN B1 and chat-Claude reversed the
    // ruling. Sending the lag to the narrator bought nothing the model needed,
    // and it made the PROSE day-dependent — which in turn made every day
    // reassignment a cache miss (~73 s, ~$0.125) for text that would not have
    // changed. Hans moves days ad hoc all week. Every date-dependent behaviour
    // D-WS9-298 adds is deterministic and lives in code, so the lag stays on the
    // skeleton and out of the AI's input.
    const sp = buildStepPlan(combinePrep(twoMeals), "Test Plan", new Map(), lagMap);
    // D-WS9-301 rule 10 — steps[0] may now be the wash step, which feeds no
    // meal and carries no lag. Ask the first step that does.
    const dated = sp.steps.find((s) => s.components.length > 0)!;
    assert.equal(dated.daysUntilCook, 6, "the skeleton keeps it");
    for (const s of sp.narrationInput.steps) {
      assert.ok(
        !("daysUntilCook" in s),
        `the narration input must carry no date: ${JSON.stringify(s.stepId)}`,
      );
    }
    // And nothing date-shaped anywhere in the serialised input the model receives.
    assert.ok(
      !/daysUntilCook|prepDay|assignedDate/.test(JSON.stringify(sp.narrationInput)),
      "a date field reached the narration input",
    );
  });

  it("absent — not zero — when the plan carries no dates", () => {
    // 4 of the 13 census plans. A fabricated 0 would read as "cooked the same
    // day", which is a claim the data does not make.
    const sp = buildStepPlan(combinePrep(twoMeals), "Test Plan", new Map(), new Map());
    for (const s of sp.steps) assert.equal(s.daysUntilCook, undefined);
  });

  it("a step whose only destination is undated gets no lag", () => {
    const sp = buildStepPlan(combinePrep(twoMeals), "Test Plan", new Map(), new Map([["meal-tue", 2]]));
    const garlic = sp.steps.find((s) => s.components.some((c) => c.ingredientName === "garlic"));
    // This step feeds BOTH meals and only one is dated, so the known lag stands —
    // partial knowledge is still knowledge, and it is the conservative direction
    // only because the unknown one might be later. Recorded, not asserted as ideal.
    assert.equal(garlic!.daysUntilCook, 2);
  });
});

// ── D-WS9-296 — the bowl reaches the narrator ───────────────────────────────

describe("D-WS9-296 — a component step carries its bowl to the prompt", () => {
  const BOWL = "Carne Asada marinade bowl";
  /** A dish whose three spices already carry a component, as the adapter sets it. */
  const withBowl = (): PrepCombineInput => ({
    meals: [
      {
        mealId: "meal-1",
        mealName: "Carne Asada Tacos",
        dishes: [
          {
            dishId: "d1",
            dishName: "Carne Asada",
            dishRole: "main",
            ingredients: [
              { ingredientId: "cumin", ingredientName: "ground cumin", category: "Pantry", quantity: 1, unit: "tsp", preparationNote: null, sourceYield: null, component: { key: "marinade", noun: "marinade", bowlName: BOWL } },
              { ingredientId: "chili", ingredientName: "chili powder", category: "Pantry", quantity: 1, unit: "tsp", preparationNote: null, sourceYield: null, component: { key: "marinade", noun: "marinade", bowlName: BOWL } },
              { ingredientId: "oregano", ingredientName: "dried oregano", category: "Pantry", quantity: 0.5, unit: "tsp", preparationNote: null, sourceYield: null, component: { key: "marinade", noun: "marinade", bowlName: BOWL } },
            ],
          },
        ],
      },
    ],
  });

  it("emits ONE step for the mixture, named for the bowl", () => {
    const sp = plan(withBowl());
    const bowls = sp.steps.filter((s) => s.bowlName);
    assert.equal(bowls.length, 1, `expected one bowl step, got ${sp.steps.length} steps`);
    assert.equal(bowls[0].bowlName, BOWL);
    assert.equal(bowls[0].components.reduce((n, c) => n + c.measures.length, 0), 3);
  });

  it("🔴 the bowl reaches the NARRATION INPUT — a nameless vessel is the defect", () => {
    // D-WS9-296 is not "group the measures", it is "give the container a name the
    // cook can find on Friday". A step that groups and does not name has done
    // half the job and looks entirely correct.
    const sp = plan(withBowl());
    const step = sp.steps.find((s) => s.bowlName)!;
    const ni = sp.narrationInput.steps.find((s) => s.stepId === step.stepId)!;
    assert.equal(ni.bowlName, BOWL);
  });

  it("no measure of the mixture is ALSO portioned on its own", () => {
    // The `claimed` filter. Without it the cumin appears twice: once in the bowl
    // and once in the dish's spice blend.
    const sp = plan(withBowl());
    const names = sp.steps.flatMap((s) => s.components.map((c) => c.ingredientName));
    assert.deepEqual(
      names.filter((n) => n === "ground cumin").length,
      1,
      `cumin measured ${names.filter((n) => n === "ground cumin").length} times`,
    );
  });

  it("a plain portion carries NO bowl — one is never invented", () => {
    const plain: PrepCombineInput = input([
      { dishId: "d1", dishName: "Pico", ingredients: [{ id: "t", name: "roma tomatoes", category: "Produce", quantity: 3, unit: "each", note: "diced" }] },
    ]);
    for (const st of plan(plain).steps) assert.equal(st.bowlName, undefined);
  });
});

// ── the wire contract on the keys ───────────────────────────────────────────

describe("D-WS9-296 — every generated stepKey fits the wire", () => {
  it("🔴 stepKey stays inside the schema's 80-character cap", () => {
    // THE CENSUS CAUGHT THIS AND NO TEST DID. `cookday#${uuid}#${uuid}` is 81
    // characters before a noun is involved, so PrepWeekResultSchema rejected the
    // assembled result and EVERY plan 502'd — after paying for its AI call. The
    // route tests missed it because their stub input carries no componentSteps
    // and therefore emits no component step at all.
    const withBowl: PrepCombineInput = {
      meals: [
        {
          mealId: "11111111-1111-4111-8111-111111111111",
          mealName: "A Meal With A Long Name For The Bowl Label",
          dishes: [
            {
              dishId: "22222222-2222-4222-8222-222222222222",
              dishName: "A Dish With A Very Long Title Indeed",
              dishRole: "main",
              ingredients: [
                { ingredientId: "33333333-3333-4333-8333-333333333333", ingredientName: "ground cumin", category: "Pantry", quantity: 1, unit: "tsp", preparationNote: null, sourceYield: null, component: { key: "marinade", noun: "marinade", bowlName: "A Dish With A Very Long marinade bowl" } },
                { ingredientId: "44444444-4444-4444-8444-444444444444", ingredientName: "chili powder", category: "Pantry", quantity: 1, unit: "tsp", preparationNote: null, sourceYield: null, component: { key: "marinade", noun: "marinade", bowlName: "A Dish With A Very Long marinade bowl" } },
                // A THIRD spice, because classifyPrepWorthy only admits a pantry
                // seasoning that is part of a 3+ blend on its dish — with two, both
                // are filtered upstream and no component bucket ever forms.
                { ingredientId: "66666666-6666-4666-8666-666666666666", ingredientName: "smoked paprika", category: "Pantry", quantity: 0.5, unit: "tsp", preparationNote: null, sourceYield: null, component: { key: "marinade", noun: "marinade", bowlName: "A Dish With A Very Long marinade bowl" } },
                { ingredientId: "55555555-5555-4555-8555-555555555555", ingredientName: "skirt steak", category: "Protein", quantity: 1.5, unit: "lb", preparationNote: null, sourceYield: null, cookDayInto: "A Dish With A Very Long marinade bowl" },
              ],
            },
          ],
        },
      ],
    };
    const sp = buildStepPlan(combinePrep(withBowl), "Test Plan");
    assert.ok(sp.steps.length > 0);
    for (const st of sp.steps) {
      assert.ok(
        st.stepKey.length <= 80,
        `${st.stepKey} is ${st.stepKey.length} chars — PrepWeekStepSchema caps it at 80`,
      );
    }
    // Both new key shapes are present, or the test is asserting nothing.
    // H4 / rule 11(c) — the container key gained its phase: `cnt#<phase>#…`. A
    // container has up to two steps now (its dry measure, then its wet finish)
    // and each needs its own stable checkbox, so one `cmp#` key cannot serve
    // both. The container half of the key is unchanged, which is what keeps a
    // day change a cache HIT (G1) — but a tick stored against an old `cmp#`
    // container step IS orphaned once, and that is the known cost of 11(c).
    assert.ok(sp.steps.some((s) => s.stepKey.startsWith("cnt#")), "no container key in the fixture");
    assert.ok(sp.steps.some((s) => s.stepKey.startsWith("cd#")), "no cook-day key in the fixture");
  });
});
