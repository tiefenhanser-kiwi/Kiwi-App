// [prepcook] Part J.1 — Hans's October 3 rulings (R1 one Sunday session, R2 raw
// parts of a cooked dish) and the census's smaller prep defects, through the real
// adapter, engine, assembly and `finishPrepWeek` — what the route serves.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { LoadPrepWeekInputResult, PrepLoadedPlan } from "../prepWeekAggregation";
import { buildPrepWeekPlan, dropHeldCuts, finishPrepWeek, tickableStepRefs, type PrepWeekBuild } from "../prepWeekBuild";
import { assemblePrepWeekResult, marinadeWindow, renderPortionLines, summarizePrepWeek } from "../prepWeekAssembly";
import { closingNote, fitNote, STORAGE_TABLE, storageClassFor } from "../prepStorage";
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
    assert.match(plateNote ?? "", /(?:^|: )Separate piles \(iceberg lettuce, roma tomatoes and white onion\) on a small plate, under plastic wrap in the fridge — up to \d days\.$/);
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

describe("J.1b — the audit's follow-ups", () => {
  const tacos = (lag: number): Meal => ({
    id: uuid(140), name: "Beef Tacos", day: "Tuesday", lag,
    dishes: [{
      id: uuid(141), name: "Beef Tacos",
      ings: [
        { id: uuid(1401), name: "ground beef", category: "Protein", quantity: 1, unit: "lb" },
        { id: uuid(1402), name: "iceberg lettuce", category: "Produce", quantity: 2, unit: "cup", note: "shredded, for topping" },
        { id: uuid(1403), name: "roma tomatoes", category: "Produce", quantity: 2, unit: "each", note: "diced, for topping" },
        { id: uuid(1404), name: "white onion", category: "Produce", quantity: 0.5, unit: "each", note: "finely diced, to serve" },
      ],
      steps: [{ i: 0, phase: "cook", text: "Brown the ground beef for 8 minutes.", ids: [uuid(1401)] }, { i: 1, phase: "assemble", text: "Fill the shells and top with lettuce, tomato and onion.", ids: [uuid(1402), uuid(1403), uuid(1404)] }],
    }],
  });

  it("1 — a plate holds per pile: lettuce and onion go on Sunday, only the tomatoes wait, and the plate's line names its piles", () => {
    const b = buildPrepWeekPlan(load([tacos(3)]));
    const r = wire(b);
    const live = allSteps(r).filter((s) => !s.skipSuggested);
    const liveKey = (id: number) => live.some((s) => s.stepKey === `produce#${uuid(id)}`);
    assert.ok(liveKey(1402), "the lettuce (3 days) is on the plate Sunday");
    assert.ok(liveKey(1404), "the onion (4 days) is on the plate Sunday");
    assert.ok(!liveKey(1403), "the tomatoes (2 days) wait");
    assert.deepEqual(held(r), ["Beef Tacos (Tuesday, 3 days out) — dice the roma tomatoes that morning and add them to the Beef Tacos toppings plate."]);
    const plateNote = live.map((s) => s.storageNote ?? "").find((n) => /plate/.test(n))!;
    assert.match(plateNote, /Separate piles \((?:iceberg lettuce and white onion|white onion and iceberg lettuce)\) on a small plate/);
    assert.doesNotMatch(plateNote, /tomato/);
  });

  it("1 — a mixed bowl holds whole: Saturday's pico waits entire, onion and jalapeño with the tomatoes", () => {
    const r = wire(buildPrepWeekPlan(load([pico(3, "Tuesday")])));
    for (const ing of ["roma tomato", "white onion", "jalapeño"]) {
      assert.ok(!allSteps(r).some((s) => !s.skipSuggested && s.instructions.includes(ing) && s.instructions.includes("pico de gallo bowl")), `${ing} is cut Sunday into a bowl that will not keep`);
    }
  });

  it("2 — one line per meal, prep only: three held members in one sentence, no lone measure", () => {
    const r = wire(buildPrepWeekPlan(load([pico(6, "Saturday")])));
    const lines = held(r).filter((l) => l.startsWith("Fish Tacos"));
    assert.equal(lines.length, 1, held(r).join(" | "));
    assert.match(lines[0], /^Fish Tacos \(Saturday, 6 days out\) — .*roma tomatoes.*white onion.*jalapeño.* that morning\.$/);
    assert.equal((lines[0].match(/Saturday/g) ?? []).length, 1, "the weekday once");
    for (const l of held(r)) assert.doesNotMatch(l, /\bmeasure\b|ground cumin|chili powder|smoked paprika/, l);
  });

  it("2 — a held sauce jar's measures and a package protein never reach the list", () => {
    const r = wire(buildPrepWeekPlan(load([{
      id: uuid(150), name: "Hummus Night", day: "Sunday", lag: 7,
      dishes: [{
        id: uuid(151), name: "Sesame Noodles",
        ings: [
          { id: uuid(1502), name: "soy sauce", category: "Pantry", quantity: 2, unit: "tbsp" },
          { id: uuid(1503), name: "rice vinegar", category: "Pantry", quantity: 1, unit: "tbsp" },
          { id: uuid(1504), name: "toasted sesame oil", category: "Pantry", quantity: 1, unit: "tsp" },
          { id: uuid(1505), name: "italian sausage", category: "Protein", quantity: 1, unit: "lb" },
        ],
        steps: [
          { i: 0, phase: "prep", text: "Whisk the soy sauce, rice vinegar and sesame oil into a sauce.", ids: [uuid(1502), uuid(1503), uuid(1504)], key: "sauce" },
          { i: 1, phase: "cook", text: "Brown the italian sausage for 8 minutes.", ids: [uuid(1505)] },
        ],
      }],
    }])));
    // The jar keeps 5 days and the meal is 7 out, so the jar IS held — and still not listed.
    assert.ok(allSteps(r).some((x) => x.skipSuggested && /sauce jar/.test(x.containerNames?.join(" ") ?? "")), "fixture: the sauce jar is held");
    for (const l of held(r)) assert.doesNotMatch(l, /measure|soy sauce|vinegar|sesame|sausage|package/, l);
  });

  it("3 — a protein's verb comes from the sentences that NAME it, not from the butter", () => {
    const b = buildPrepWeekPlan(load([{
      id: uuid(160), name: "Dumplings", day: "Monday", lag: 1,
      dishes: [{
        id: uuid(161), name: "Slow-Cooker Chicken and Dumplings",
        ings: [
          { id: uuid(1601), name: "boneless skinless chicken thighs", category: "Protein", quantity: 1.75, unit: "lb", note: "trimmed of excess fat" },
          { id: uuid(1602), name: "unsalted butter", category: "Dairy", quantity: 4, unit: "tbsp", note: "cold, cubed" },
        ],
        steps: [
          { i: 0, phase: "cook", text: "Place the trimmed 1¾ lb chicken thighs in the slow cooker.", ids: [uuid(1601)] },
          { i: 1, phase: "cook", text: "Remove the chicken thighs, shred them with two forks and return them.", ids: [] },
          { i: 2, phase: "prep", text: "Cut in 4 tablespoons cold cubed unsalted butter until the mixture resembles coarse crumbs.", ids: [uuid(1602)] },
        ],
      }],
    }]));
    const thighs = b.stepPlan.steps.find((s) => s.phase === "proteins")!;
    assert.deepEqual(thighs.knifeVerbs, ["trim"]);
  });

  it("5 — a storage line says a dash label in words", () => {
    const r = wire(buildPrepWeekPlan(load([{
      id: uuid(170), name: "Rice Night", day: "Monday", lag: 1,
      dishes: [{
        id: uuid(171), name: "Herb Rice",
        ings: [
          { id: uuid(1701), name: "fresh parsley", category: "Produce", quantity: 0.25, unit: "cup", note: "chopped" },
          { id: uuid(1702), name: "fresh cilantro", category: "Produce", quantity: 0.25, unit: "cup", note: "chopped" },
        ],
        steps: [{ i: 0, phase: "cook", text: "Simmer the rice for 18 minutes.", ids: [] }],
      }],
    }])));
    const notes = allSteps(r).map((s) => s.storageNote ?? "").filter(Boolean);
    assert.ok(notes.some((n) => n.startsWith("The herb tub for the Herb Rice: airtight in the fridge")), notes.join(" | "));
    assert.ok(!notes.some((n) => n.includes("Herb Rice — herbs")), "a raw label inside a storage sentence");
  });

  it("5 — a partly held step's opening lists only the cuts it still does", () => {
    const c = (cut: string, mealId: string) => ({ ingredientName: "yellow onion", measures: [{ amount: "1", forDish: "D", dishRole: "main" as const, preparationNote: cut, mealId }] });
    const before = [c("thinly sliced", "a"), c("finely diced", "b"), c("roughly chopped", "c")];
    const after = [c("thinly sliced", "a"), c("finely diced", "b")];
    assert.equal(
      dropHeldCuts("Work through 2 yellow onions: thinly sliced, finely diced and roughly chopped.", before, after),
      "Work through 2 yellow onions: thinly sliced and finely diced.",
    );
    assert.equal(dropHeldCuts("Mince 8 cloves of garlic.", before, after), "Mince 8 cloves of garlic.", "no list, nothing to drop");
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
    // J.1c (BUG-355 item 3) — one tub still, named by class: the dish's juice jar.
    assert.deepEqual([...new Set([...destinations(b, "lime"), ...destinations(b, "lime juice")])], ["Shrimp Tacos citrus jar"]);
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
    // J.1c (BUG-355 item 3) — the cornbread's lone jalapeño takes its class lid, not "— diced jalapeño".
    assert.ok(jal.containerNames?.includes("Jalapeño Cheddar Cornbread vegetables"), "the label is still the container's name");
    for (const line of jal.instructions.split("\n").slice(1)) {
      assert.equal(line.split(" — ").length, 2, `a raw label inside a sentence: ${line}`);
    }
    assert.match(jal.instructions, /into the Jalapeño Cheddar Cornbread vegetables container/);
  });

  it("J.1b — a long cook-day line fits by naming briefly, never by cutting a word", () => {
    const name = "Lemon-Herb Roasted Chicken Breasts with Baby Yukon Gold Potatoes and Tomato Relish";
    const ing = (n: number, nm: string, note: string): Ing => ({ id: uuid(n), name: nm, category: "Produce", quantity: 2, unit: "each", note });
    const r = wire(buildPrepWeekPlan(load([{
      id: uuid(90), name, day: "Wednesday", lag: 4,
      dishes: [{
        id: uuid(91), name,
        ings: [
          { id: uuid(901), name: "boneless skinless chicken breasts", category: "Protein", quantity: 2, unit: "lb", note: "patted dry" },
          { id: uuid(902), name: "fresh lemon juice", category: "Produce", quantity: 2, unit: "tbsp" },
          { id: uuid(903), name: "extra-virgin olive oil", category: "Pantry", quantity: 2, unit: "tbsp", pack: "bottle" },
          ing(904, "heirloom roma tomatoes", "diced, for topping"),
          ing(905, "ripe hass avocados", "diced, for topping"),
          ing(906, "english cucumbers", "diced, for topping"),
          ing(907, "baby yukon gold potatoes", "halved"),
        ],
        steps: [
          { i: 0, phase: "prep", text: "Whisk the lemon juice and olive oil into a marinade.", ids: [uuid(902), uuid(903)], key: "marinade" },
          { i: 1, phase: "prep", text: "Coat the chicken breasts in the marinade and refrigerate overnight.", ids: [uuid(901)] },
          { i: 2, phase: "cook", text: "Roast the chicken and potatoes at 425°F for 30 minutes.", ids: [uuid(907)] },
          { i: 3, phase: "assemble", text: "Top with the tomatoes, avocado and cucumber.", ids: [uuid(904), uuid(905), uuid(906)] },
        ],
      }],
    }])));
    assert.ok(held(r).length >= 1, "the meal has a cook-day line");
    for (const l of held(r)) {
      assert.ok(l.length <= 200, `${l.length}: ${l}`);
      assert.match(l, /[.…]$/, `a cut line: ${l}`);
      assert.doesNotMatch(l, /\bthe mar$|\bmar\.$/, l);
    }
  });

  it("J.1b — two plates that keep alike say it once, whatever their piles", () => {
    const note = closingNote([
      { name: "Classic Chili Fixings plate", text: "", ingredientNames: ["fresh cilantro"], own: false },
      { name: "Taco Toppings plate", text: "", ingredientNames: ["fresh cilantro", "white onion"], own: true },
    ]);
    assert.match(note, /^Both containers: Separate piles on a small plate, under plastic wrap in the fridge — up to \d days\.$/, note);
    assert.equal(fitNote(["Plate, wrapped, fridge, up to 3 days.", "Plate, wrapped, fridge, up to 3 days.", "x".repeat(199) + "."]).split("Plate,").length, 2, "an identical compact sentence is said once");
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
    // J.1b — one line for the meal, the clause once, and no "that morning" for a protein
    // that is handled the night before.
    assert.deepEqual(held(r), ["Harissa Night (Tuesday, 3 days out) — add the chicken thighs to the marinade the night before."]);
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
    // J.1c — both piles go on one plate, so they are one line that opens on it.
    assert.equal(r.lines[0], "Into the Tacos toppings plate: 2 tbsp fresh cilantro · 4 green onions");
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
