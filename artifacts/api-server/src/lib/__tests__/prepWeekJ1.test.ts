// [prepcook] Part J.1 — Hans's October 3 rulings (R1 one Sunday session, R2 raw
// parts of a cooked dish) and the census's smaller prep defects, through the real
// adapter, engine, assembly and `finishPrepWeek` — what the route serves.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { LoadPrepWeekInputResult, PrepLoadedPlan } from "../prepWeekAggregation";
import { buildPrepWeekPlan, finishPrepWeek, tickableStepRefs, type PrepWeekBuild } from "../prepWeekBuild";
import { assemblePrepWeekResult, marinadeWindow, renderPortionLines, summarizePrepWeek } from "../prepWeekAssembly";
import { fitNote, STORAGE_TABLE, storageClassFor } from "../prepStorage";
import { derivePrepCompletion } from "../prepCompletion";
import { PrepWeekResultSchema, type PrepWeekResult } from "../ai/schemas/prepWeek";

type Ing = { id: string; name: string; category: string; quantity: number; unit: string; note?: string; pack?: string; from?: { fromName: string; quantity: number; unit: string } };
type St = { i: number; phase: string; text: string; ids?: string[]; key?: string };
type Dish = { id: string; name: string; ings: Ing[]; steps: St[] };
type Meal = { id: string; name: string; day: string; lag: number; dishes: Dish[] };

const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

function load(meals: Meal[]): LoadPrepWeekInputResult {
  const input: PrepLoadedPlan = {
    planId: uuid(999),
    planName: "J.1",
    meals: meals.map((m) => ({
      mealId: m.id,
      mealName: m.name,
      cuisine: null,
      servingsOverride: null,
      dishes: m.dishes.map((d) => ({
        dishId: d.id,
        dishName: d.name,
        dishRole: "main" as const,
        baseServings: 4,
        authoredBaseServings: 4,
        ingredients: d.ings.map((x) => ({
          ingredientId: x.id, ingredientName: x.name, category: x.category, quantity: x.quantity, unit: x.unit,
          preparationNote: x.note ?? null, sourceYield: x.from ?? null, purchaseUnit: x.pack ?? null,
        })),
        stepTexts: d.steps.map((s) => s.text),
        componentSteps: d.steps.map((s) => ({ stepIndex: s.i, text: s.text, componentKey: s.key ?? null, ingredientIds: s.ids ?? [], phaseType: s.phase })),
      })),
    })),
  };
  return {
    input,
    planRevisionId: 1,
    cookDays: {
      prepDay: "2026-10-04",
      lagByMealId: new Map(meals.map((m) => [m.id, m.lag])),
      dayNameByMealId: new Map(meals.map((m) => [m.id, m.day])),
    },
    identity: { foldedIdByIngredientId: new Map() },
  };
}

function wire(build: PrepWeekBuild): PrepWeekResult {
  const narration = { steps: build.stepPlan.narrationInput.steps.map((s) => ({ stepId: s.stepId, title: "Do it", instructions: "Do it." })) };
  const res = summarizePrepWeek(finishPrepWeek(assemblePrepWeekResult(build.stepPlan, narration), build));
  const v = PrepWeekResultSchema.safeParse(res);
  assert.ok(v.success, v.success ? "" : JSON.stringify(v.error.flatten()));
  return res;
}
const allSteps = (r: PrepWeekResult) => r.phases.flatMap((p) => p.steps);
const held = (r: PrepWeekResult) => r.phases.find((p) => p.phase === "proteins")!.heldForCookDay ?? [];
const destinations = (b: PrepWeekBuild, ingredient: string) =>
  b.stepPlan.steps.flatMap((s) => s.components.filter((c) => c.ingredientName === ingredient).flatMap((c) => c.measures.map((m) => m.destination)));

// ── fixtures ────────────────────────────────────────────────────────────────

const pico = (lag: number, day: string): Meal => ({
  id: uuid(10 + lag), name: "Fish Tacos", day, lag,
  dishes: [{
    id: uuid(100 + lag), name: "Fish Tacos",
    ings: [
      { id: uuid(201), name: "cod fillets", category: "Protein", quantity: 1, unit: "lb", note: "cut into strips" },
      { id: uuid(202), name: "roma tomatoes", category: "Produce", quantity: 3, unit: "each", note: "diced" },
      { id: uuid(203), name: "white onion", category: "Produce", quantity: 0.5, unit: "each", note: "finely diced" },
      { id: uuid(204), name: "jalapeño", category: "Produce", quantity: 1, unit: "each", note: "seeded and minced" },
      { id: uuid(205), name: "fresh cilantro", category: "Produce", quantity: 0.25, unit: "cup", note: "chopped" },
      { id: uuid(206), name: "ground cumin", category: "Pantry", quantity: 1, unit: "tsp" },
      { id: uuid(207), name: "chili powder", category: "Pantry", quantity: 1, unit: "tsp" },
      { id: uuid(208), name: "smoked paprika", category: "Pantry", quantity: 1, unit: "tsp" },
    ],
    steps: [
      { i: 0, phase: "prep", text: "Combine the tomatoes, onion, jalapeño and cilantro for the pico de gallo.", ids: [uuid(202), uuid(203), uuid(204), uuid(205)], key: "pico de gallo" },
      { i: 1, phase: "prep", text: "Rub the cod with the cumin, chili powder and smoked paprika.", ids: [uuid(201), uuid(206), uuid(207), uuid(208)] },
      { i: 2, phase: "cook", text: "Fry the cod in hot oil for 4 minutes until golden.", ids: [] },
    ],
  }],
});

describe("J.1 R1 — one Sunday session; a window that does not reach the cook day is a cook-day line", () => {
  it("an expired window goes on the cook-day list with its day — never a second session", () => {
    const b = buildPrepWeekPlan(load([pico(6, "Saturday")]));
    const r = wire(b);
    // Cut tomato keeps 2 days, so Saturday's pico is diced Saturday.
    const tomato = allSteps(r).find((s) => s.stepKey.startsWith("produce#") && s.instructions.includes("roma tomato"));
    assert.ok(!tomato || tomato.skipSuggested === true, "Saturday's tomato is not cut on Sunday");
    assert.ok(held(r).some((l) => /^Fish Tacos \(Saturday, 6 days out\) — .*dice the roma tomatoes.* that morning\.$/.test(l)), held(r).join(" | "));
    // …and the spice blend still is: it keeps for weeks.
    assert.ok(allSteps(r).some((s) => !s.skipSuggested && /spice blend/.test(s.instructions + s.title + (s.containerNames ?? []).join(" "))), "the blend is still prepped");
    // No step that renders promises a window shorter than its own cook day.
    for (const s of allSteps(r).filter((x) => !x.skipSuggested && x.storageNote)) {
      const n = /up to (\d+) days/.exec(s.storageNote!);
      if (n) assert.ok(Number(n[1]) >= 6 || !s.contributesToMealIds.length, `${s.stepKey}: ${s.storageNote}`);
    }
    for (const s of allSteps(r)) assert.doesNotMatch(s.instructions + (s.storageNote ?? ""), /\b(mid-?week|second session|Wednesday session)\b/i);
  });

  it("the storage table matches the reviewed after-table (USDA FoodKeeper)", () => {
    const days = Object.fromEntries(STORAGE_TABLE.map((c) => [c.key, c.days]));
    assert.deepEqual(days, {
      "raw-fish": 2, "raw-meat": 2, "cut-tomato": 2, "leafy-herbs": 3, "cut-brassica-mushroom": 3, slaw: 3,
      "citrus-wedges": 4, "cut-alliums": 4, "cut-peppers": 4, "cooked-grains": 4, "sauces-dressings": 5,
      "citrus-juice": 6, "hardy-herbs": 7, "hardy-roots": 7, "spice-blend": 7, "dry-mix": 14,
    });
    assert.equal(storageClassFor("carrots", "", ["carrots"]).days, 7);
    assert.equal(storageClassFor("celery", "", ["celery"]).days, 7);
    assert.equal(storageClassFor("roma tomatoes", "", ["roma tomatoes"]).days, 2);
    assert.equal(storageClassFor("fresh rosemary", "", ["fresh rosemary"]).days, 7);
    assert.equal(storageClassFor("lime juice", "", ["lime juice"]).days, 6);
  });

  it("a protein serving two meals: the near portion is prepped, the far one held", () => {
    const thighs = (meal: number, name: string, day: string, lag: number): Meal => ({
      id: uuid(meal), name, day, lag,
      dishes: [{
        id: uuid(meal + 50), name,
        ings: [{ id: uuid(301), name: "boneless skinless chicken thighs", category: "Protein", quantity: 1.5, unit: "lb", note: "trimmed and cut into 1-inch pieces" }],
        steps: [{ i: 0, phase: "prep", text: "Trim the chicken thighs and cut them into 1-inch pieces.", ids: [uuid(301)] }, { i: 1, phase: "cook", text: "Sear the chicken for 8 minutes.", ids: [] }],
      }],
    });
    const b = buildPrepWeekPlan(load([thighs(1, "Chicken Stir Fry", "Monday", 1), thighs(2, "Chicken Curry", "Friday", 5)]));
    const r = wire(b);
    const step = allSteps(r).find((s) => s.stepKey.startsWith("proteins#"))!;
    assert.notEqual(step.skipSuggested, true, "the near share is prepped");
    assert.deepEqual(step.contributesToMealIds, [uuid(1)]);
    const lines = step.instructions.split("\n").slice(1);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /for Chicken Stir Fry$/);
    assert.ok(held(r).some((l) => l.startsWith("Chicken Curry (Friday, 5 days out) — ")), held(r).join(" | "));
    // isPrepped: Monday waits for the step, Friday does not.
    const refs = tickableStepRefs(b).filter((x) => x.stepKey === step.stepKey);
    assert.deepEqual(refs[0].contributesToMealIds, [uuid(1)]);
    assert.equal(derivePrepCompletion([uuid(2)], tickableStepRefs(b), new Set()).perMeal[uuid(2)], true);
  });
});

describe("J.1 R2 — raw parts of a cooked dish", () => {
  it("a raw mix groups by its COMPONENT inside a dish that fries", () => {
    const b = buildPrepWeekPlan(load([pico(1, "Monday")]));
    for (const ing of ["roma tomatoes", "white onion", "jalapeño"]) {
      assert.deepEqual(destinations(b, ing), ["Fish Tacos pico de gallo bowl"], ing);
    }
  });

  it("one toppings plate per dish, the leafy topping on it too", () => {
    const b = buildPrepWeekPlan(load([{
      id: uuid(40), name: "Beef Tacos", day: "Monday", lag: 1,
      dishes: [{
        id: uuid(41), name: "Beef Tacos",
        ings: [
          { id: uuid(401), name: "ground beef", category: "Protein", quantity: 1, unit: "lb" },
          { id: uuid(402), name: "iceberg lettuce", category: "Produce", quantity: 2, unit: "cup", note: "shredded, for topping" },
          { id: uuid(403), name: "roma tomatoes", category: "Produce", quantity: 2, unit: "each", note: "diced, for topping" },
          { id: uuid(404), name: "white onion", category: "Produce", quantity: 0.5, unit: "each", note: "finely diced, to serve" },
        ],
        steps: [{ i: 0, phase: "cook", text: "Brown the ground beef for 8 minutes.", ids: [uuid(401)] }, { i: 1, phase: "assemble", text: "Fill the shells and top with lettuce, tomato and onion.", ids: [uuid(402), uuid(403), uuid(404)] }],
      }],
    }]));
    for (const ing of ["iceberg lettuce", "roma tomatoes", "white onion"]) {
      assert.deepEqual(destinations(b, ing), ["Beef Tacos toppings plate"], ing);
    }
    const r = wire(b);
    const plateNote = allSteps(r).map((s) => s.storageNote ?? "").find((n) => /plate/.test(n));
    assert.match(plateNote ?? "", /(?:^|: )Separate piles on a small plate, under plastic wrap in the fridge — up to \d days\.$/);
  });

  it("container names come from class and form; dry pasta is no-work", () => {
    const b = buildPrepWeekPlan(load([{
      id: uuid(50), name: "Tetrazzini", day: "Monday", lag: 1,
      dishes: [{
        id: uuid(51), name: "Chicken Tetrazzini",
        ings: [
          { id: uuid(501), name: "spaghetti", category: "Pantry", quantity: 8, unit: "oz" },
          { id: uuid(502), name: "all-purpose flour", category: "Pantry", quantity: 3, unit: "tbsp" },
          { id: uuid(503), name: "ground nutmeg", category: "Pantry", quantity: 0.25, unit: "tsp" },
          { id: uuid(504), name: "panko breadcrumbs", category: "Pantry", quantity: 0.5, unit: "cup" },
          { id: uuid(505), name: "soy sauce", category: "Pantry", quantity: 2, unit: "tbsp" },
          { id: uuid(506), name: "rice vinegar", category: "Pantry", quantity: 1, unit: "tbsp" },
          { id: uuid(507), name: "toasted sesame oil", category: "Pantry", quantity: 1, unit: "tsp" },
        ],
        steps: [
          // Two runs (a cook step between them), so the dry whisk is its own container.
          { i: 0, phase: "prep", text: "Whisk the soy sauce, rice vinegar and sesame oil into a sauce.", ids: [uuid(505), uuid(506), uuid(507)], key: "sauce" },
          { i: 1, phase: "cook", text: "Boil the spaghetti for 9 minutes.", ids: [uuid(501)] },
          { i: 2, phase: "prep", text: "Whisk the flour, nutmeg and panko together.", ids: [uuid(502), uuid(503), uuid(504)] },
          { i: 3, phase: "cook", text: "Bake for 20 minutes.", ids: [] },
        ],
      }],
    }]));
    const names = new Set(b.stepPlan.steps.map((s) => s.bowlName).filter(Boolean));
    assert.ok(names.has("Chicken Tetrazzini dry mix"), [...names].join(" | "));
    assert.ok(names.has("Chicken Tetrazzini sauce jar"), [...names].join(" | "));
    assert.ok(!destinations(b, "spaghetti").some(Boolean), "the spaghetti is in no container");
    assert.ok(b.stepPlan.steps.every((s) => !s.bowlName || s.components.every((c) => c.ingredientName !== "spaghetti")));
  });

  it("a heated component is never a raw mix, whatever its combine step says", () => {
    const b = buildPrepWeekPlan(load([{
      id: uuid(60), name: "Steak Night", day: "Monday", lag: 1,
      dishes: [{
        id: uuid(61), name: "Roasted Green Beans",
        ings: [
          { id: uuid(601), name: "green beans", category: "Produce", quantity: 12, unit: "oz", note: "trimmed" },
          { id: uuid(602), name: "shallots", category: "Produce", quantity: 2, unit: "each", note: "thinly sliced" },
        ],
        steps: [
          { i: 0, phase: "prep", text: "Toss the green beans and shallots together with oil and salt.", ids: [uuid(601), uuid(602)] },
          { i: 1, phase: "cook", text: "Roast at 425°F for 15 minutes.", ids: [] },
        ],
      }],
    }]));
    for (const ing of ["green beans", "shallots"]) {
      assert.ok(!destinations(b, ing).some((d) => d === "Roasted Green Beans bowl"), `${ing} went into a raw-mix bowl`);
    }
    // …it is the vegetables class at its oven moment: one tray-bound container.
    assert.deepEqual([...new Set([...destinations(b, "green beans"), ...destinations(b, "shallots")])], ["Roasted Green Beans vegetables"]);
  });

  it("cabbage is a cut vegetable: a slaw's cabbages and carrot are one bowl, never '— greens'", () => {
    const b = buildPrepWeekPlan(load([{
      id: uuid(70), name: "Slaw Night", day: "Monday", lag: 1,
      dishes: [{
        id: uuid(71), name: "Vinegar Slaw",
        ings: [
          { id: uuid(701), name: "green cabbage", category: "Produce", quantity: 3, unit: "cup", note: "shredded" },
          { id: uuid(702), name: "red cabbage", category: "Produce", quantity: 1, unit: "cup", note: "shredded" },
          { id: uuid(703), name: "carrots", category: "Produce", quantity: 1, unit: "each", note: "grated" },
        ],
        steps: [{ i: 0, phase: "prep", text: "Toss the cabbages and carrot with the vinegar dressing.", ids: [uuid(701), uuid(702), uuid(703)] }],
      }],
    }]));
    for (const ing of ["green cabbage", "red cabbage", "carrots"]) assert.deepEqual(destinations(b, ing), ["Vinegar Slaw bowl"], ing);
    assert.ok(!b.stepPlan.steps.flatMap((s) => s.components.flatMap((c) => c.measures.map((m) => m.destination ?? ""))).some((d) => /— greens/.test(d)));
  });
});

describe("J.1 §2 — the smaller defects", () => {
  it("one citrus, one step, one tub: a dish's zest and juice go together", () => {
    const b = buildPrepWeekPlan(load([{
      id: uuid(80), name: "Shrimp Tacos", day: "Monday", lag: 1,
      dishes: [{
        id: uuid(81), name: "Shrimp Tacos",
        ings: [
          { id: uuid(801), name: "lime", category: "Produce", quantity: 1, unit: "each", note: "zested" },
          { id: uuid(802), name: "lime juice", category: "Produce", quantity: 1, unit: "tbsp", note: "freshly squeezed", from: { fromName: "lime", quantity: 2, unit: "tbsp" } },
          { id: uuid(803), name: "roma tomatoes", category: "Produce", quantity: 2, unit: "each", note: "diced" },
          { id: uuid(804), name: "white onion", category: "Produce", quantity: 0.5, unit: "each", note: "diced" },
        ],
        steps: [{ i: 0, phase: "prep", text: "Combine the tomatoes, onion, lime zest and lime juice.", ids: [uuid(801), uuid(802), uuid(803), uuid(804)] }],
      }],
    }]));
    const limeSteps = b.stepPlan.steps.filter((s) => s.components.some((c) => /lime/.test(c.ingredientName)));
    assert.equal(limeSteps.length, 1, "one step for the lime");
    assert.deepEqual([...new Set([...destinations(b, "lime"), ...destinations(b, "lime juice")])], ["Shrimp Tacos — lime zest and juice"]);
  });

  it("no raw `<Dish> — <contents>` label inside a sentence; the label stays the container's name", () => {
    const r = wire(buildPrepWeekPlan(load([{
      id: uuid(90), name: "Chili Night", day: "Monday", lag: 1,
      dishes: [
        { id: uuid(91), name: "Texas-Style Beef Chili", ings: [{ id: uuid(901), name: "yellow onion", category: "Produce", quantity: 1, unit: "each", note: "diced" }], steps: [{ i: 0, phase: "cook", text: "Cook the onion in the pot for 5 minutes.", ids: [uuid(901)] }] },
        { id: uuid(92), name: "Jalapeño Cheddar Cornbread", ings: [{ id: uuid(902), name: "jalapeño", category: "Produce", quantity: 1, unit: "each", note: "diced" }], steps: [{ i: 0, phase: "assemble", text: "Fold the jalapeño into the batter.", ids: [uuid(902)] }] },
      ],
    }])));
    const jal = allSteps(r).find((s) => s.instructions.includes("jalapeño") && !s.skipSuggested)!;
    assert.ok(jal.containerNames?.includes("Jalapeño Cheddar Cornbread — diced jalapeño"), "the label is still the container's name");
    for (const line of jal.instructions.split("\n").slice(1)) {
      assert.equal(line.split(" — ").length, 2, `a raw label inside a sentence: ${line}`);
    }
    assert.match(jal.instructions, /into the diced-jalapeño tub for the Jalapeño Cheddar Cornbread/);
  });

  it("0c — one cook-day list, no duplicates: two marinades for one protein print its line once", () => {
    const harissa = (n: number, name: string): Dish => ({
      id: uuid(n), name,
      ings: [
        { id: uuid(851), name: "chicken thighs", category: "Protein", quantity: 1, unit: "lb", note: "patted dry" },
        { id: uuid(n + 1), name: "harissa paste", category: "Pantry", quantity: 2, unit: "tbsp", pack: "jar" },
        { id: uuid(n + 2), name: "extra-virgin olive oil", category: "Pantry", quantity: 2, unit: "tbsp", pack: "bottle" },
        { id: uuid(n + 3), name: "red wine vinegar", category: "Pantry", quantity: 1, unit: "tbsp", pack: "bottle" },
      ],
      steps: [
        { i: 0, phase: "prep", text: "Whisk the harissa paste, olive oil and vinegar into a marinade.", ids: [uuid(n + 1), uuid(n + 2), uuid(n + 3)], key: "marinade" },
        { i: 1, phase: "prep", text: "Coat the chicken thighs in the marinade and refrigerate overnight.", ids: [uuid(851)] },
        { i: 2, phase: "cook", text: "Roast the chicken thighs at 425°F for 25 minutes.", ids: [] },
      ],
    });
    const r = wire(buildPrepWeekPlan(load([{ id: uuid(85), name: "Harissa Night", day: "Tuesday", lag: 3, dishes: [harissa(860, "Harissa Chicken"), harissa(870, "Harissa Chicken Bowls")] }])));
    const line = "Add the chicken thighs the night before you cook them (Tuesday).";
    assert.equal(held(r).filter((l) => l === line).length, 1, held(r).join(" | "));
  });

  it("the marinade window is the recipe's: parsed from its own steps", () => {
    assert.deepEqual(marinadeWindow(["Coat the chicken and refrigerate for at least 2 hours."]), { windowHours: 2, overnight: false });
    assert.deepEqual(marinadeWindow(["Marinate for 30 minutes or up to 8 hours."]), { windowHours: 0.5, overnight: false });
    assert.deepEqual(marinadeWindow(["Cover and marinate overnight."]), { windowHours: null, overnight: true });
    assert.deepEqual(marinadeWindow(["Roast for 2 hours."]), { windowHours: null, overnight: false }, "a roast is not a marinade");
  });

  it("0d — a storage note is never cut mid-sentence and always fits 200", () => {
    const long = [
      "Fresh Pico de Gallo: Airtight in the fridge, with a barely damp paper towel — up to 3 days.",
      "Airtight in the fridge — up to 4 days. It will scent the shelf; a sealed jar helps.",
      "Stir in the Avocado Crema and the Fresh Pico de Gallo lime juice now — it is eaten within a day.",
      "Keep the dressing separate; combine on cook day (Saturday).",
    ];
    const n = fitNote(long);
    assert.ok(n.length <= 200, `${n.length}`);
    assert.ok(!n.includes("…"));
    for (const s of n.split(/(?<=\.)\s+/)) assert.match(s, /\.$/, `a cut sentence: ${s}`);
  });

  it("BUG-346 (a) — storage class from identity, never from a note", () => {
    assert.notEqual(storageClassFor("baking soda (for tenderizing beef)", "", ["baking soda"]).days, 2);
    assert.notEqual(storageClassFor("cornstarch for velveting the chicken", "", ["cornstarch"]).days, 2);
  });

  it("BUG-346 (e) — herb counts carry their unit", () => {
    const r = renderPortionLines({
      components: [
        { ingredientName: "fresh cilantro", measures: [{ amount: "2 tbsp", forDish: "Tacos", dishRole: "main", destination: "Tacos toppings plate", qty: 2, unit: "tbsp" }] },
        { ingredientName: "green onions", measures: [{ amount: "4", forDish: "Tacos", dishRole: "main", destination: "Tacos toppings plate", qty: 4, unit: "each" }] },
      ],
    })!;
    assert.match(r.lines[0], /^2 tbsp fresh cilantro /);
    assert.match(r.lines[1], /^4 green onions /);
  });

  it(
    "componentSelections 'guac: bought' drops the guacamole prep",
    { skip: "D-WS9-068 / D-WS7-215 read side unbuilt — MealPlanItem.componentSelections is read by nothing (row 3c owns it)" },
    () => {
      const l = load([{
        id: uuid(95), name: "Fajitas", day: "Monday", lag: 1,
        dishes: [{
          id: uuid(96), name: "Fajita Toppings",
          ings: [{ id: uuid(951), name: "roma tomatoes", category: "Produce", quantity: 2, unit: "each", note: "diced" }, { id: uuid(952), name: "white onion", category: "Produce", quantity: 0.5, unit: "each", note: "diced" }],
          steps: [{ i: 0, phase: "prep", text: "Mash the avocado with tomato and onion for the guacamole.", ids: [uuid(951), uuid(952)], key: "guacamole" }],
        }],
      }]);
      (l.input.meals[0] as unknown as { componentSelections: unknown }).componentSelections = { [uuid(96)]: { guacamole: "bought" } };
      const b = buildPrepWeekPlan(l);
      assert.deepEqual(destinations(b, "roma tomatoes").filter(Boolean), [], "a bought guacamole is not prepped");
    },
  );
});
