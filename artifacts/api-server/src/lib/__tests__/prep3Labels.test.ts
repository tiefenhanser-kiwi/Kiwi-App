// PREP-3 (R3) — fewer containers a cook can label: one plate per meal, one juice tub per
// fruit, no bag for one counted food, every container labelled at read time — by its dish
// (3c), never its day — and Prep the Week opening with "Label N containers". hh2's week
// (dump0) printed 20.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildPrepWeekPlan } from "../prepWeekBuild";
import { WEEK_LABEL_STEP_KEY, weekLabelMap, weekShortOf } from "../prepWeekLabels";
import { containers, load, uuid, wire, type Meal } from "./fixtures/prep3Week";

const monday: Meal = {
  id: uuid(1), name: "Grilled Chicken with Garlic Herb Rice", day: "Monday", lag: 1,
  dishes: [
    { id: uuid(11), name: "Garlic Herb Rice",
      ings: [{ id: uuid(101), name: "fresh flat-leaf parsley", category: "Produce", quantity: 1, unit: "tbsp", note: "finely chopped" }],
      steps: [{ i: 0, phase: "assemble", text: "Fluff the rice and stir in 1 tablespoon finely chopped parsley.", ids: [uuid(101)] }] },
    { id: uuid(12), name: "Roasted Asparagus with Lemon",
      ings: [
        { id: uuid(102), name: "asparagus", category: "Produce", quantity: 1, unit: "lb", note: "woody ends snapped off" },
        { id: uuid(103), name: "lemon", category: "Produce", quantity: 0.5, unit: "each", note: "juiced" },
      ],
      steps: [
        { i: 0, phase: "cook", text: "Roast the asparagus at 425°F for 12 minutes.", ids: [uuid(102)] },
        { i: 1, phase: "assemble", text: "Squeeze the juice of ½ lemon over the asparagus.", ids: [uuid(103)] },
      ] },
    { id: uuid(13), name: "Grilled Chicken Breasts",
      ings: [{ id: uuid(104), name: "boneless skinless chicken breasts", category: "Protein", quantity: 1, unit: "lb", note: "pounded to an even thickness" }],
      steps: [{ i: 0, phase: "cook", text: "Grill the chicken breasts for 12 minutes.", ids: [uuid(104)] }] },
  ],
};
const thursday: Meal = {
  id: uuid(2), name: "Lentil Dal with Rice", day: "Thursday", lag: 3,
  dishes: [{ id: uuid(21), name: "Red Lentil Dal",
    ings: [
      { id: uuid(201), name: "fresh lemon juice", category: "Produce", quantity: 0.5, unit: "tbsp" },
      { id: uuid(202), name: "yellow onion", category: "Produce", quantity: 0.5, unit: "each", note: "finely diced" },
      { id: uuid(203), name: "dried red chili peppers", category: "Pantry", quantity: 6, unit: "each", note: "whole, stems removed" },
      // (A dry spice is measured only beside 3+ of its dish's: the chiles ride that tier.)
      { id: uuid(204), name: "ground cumin", category: "Pantry", quantity: 0.75, unit: "tsp" },
      { id: uuid(205), name: "ground coriander", category: "Pantry", quantity: 0.5, unit: "tsp" },
      { id: uuid(206), name: "ground turmeric", category: "Pantry", quantity: 0.5, unit: "tsp" },
    ],
    steps: [
      { i: 0, phase: "cook", text: "Cook the diced onion in the ghee for 8 minutes.", ids: [uuid(202)] },
      { i: 3, phase: "cook", text: "Stir in ¾ teaspoon ground cumin, ½ teaspoon ground coriander and ½ teaspoon ground turmeric.", ids: [uuid(204), uuid(205), uuid(206)] },
      { i: 1, phase: "cook", text: "Add 6 dried red chili peppers and fry 30 seconds.", ids: [uuid(203)] },
      { i: 2, phase: "assemble", text: "Stir in ½ tablespoon fresh lemon juice.", ids: [uuid(201)] },
    ] }],
};

describe("PREP-3 (R3) — one plate per meal, one juice tub per fruit, no bag for one counted food", () => {
  const b = buildPrepWeekPlan(load([monday, thursday]));
  const all = [...containers(b)];

  it("a meal's lone cuts and garnish are piles on ITS one plate", () => {
    const plate = all.find(([, items]) => items.some((i) => /parsley/.test(i)));
    assert.ok(plate, JSON.stringify(all));
    assert.equal(plate![0], "Grilled Chicken with Garlic Herb Rice plate");
    assert.ok(plate![1].some((i) => /asparagus/.test(i)), "the asparagus is a pile on the same plate");
  });

  it("the lemon juiced for the asparagus and the dal's lemon juice share ONE tub", () => {
    const tubs = all.filter(([, items]) => items.some((i) => /lemon/.test(i)));
    assert.equal(tubs.length, 1, JSON.stringify(tubs));
    assert.match(tubs[0][0], /^Lemon juice — /);
  });

  it("six whole dried chiles are counted out at the stove, not bagged", () => {
    assert.ok(!all.some(([, items]) => items.some((i) => /chili peppers/.test(i))), JSON.stringify(all));
  });
});

describe("PREP-3 (R3, 3c) — the labels, by dish, at read time", () => {
  const b = buildPrepWeekPlan(load([monday, thursday]));
  const r = wire(b);
  const steps = r.phases.flatMap((p) => p.steps);

  it("Prep the Week opens with \"Label N containers\", N the header's count, in the week's order", () => {
    const first = r.phases.find((p) => p.steps.length > 0)!.steps[0];
    assert.equal(first.stepKey, WEEK_LABEL_STEP_KEY);
    assert.equal(first.title, `Label ${r.containerCount} containers`);
    // The plate takes the meal's main dish (of three "main" dishes, the one naming a protein).
    assert.match(first.instructions, /^Write these on tape, one per container: Chicken plate · Chicken · Dal spices · Dal plate · Lemon juice\.$/);
  });

  it("every container on screen is said by its label, never the engine's name", () => {
    const names = new Set(steps.flatMap((s) => s.containerNames ?? []));
    assert.deepEqual([...names].sort(), ["Chicken", "Chicken plate", "Dal plate", "Dal spices", "Lemon juice"]);
    for (const s of steps) assert.doesNotMatch(`${s.title} ${s.instructions}`, /Grilled Chicken with Garlic Herb Rice plate|Lemon juice — /);
  });

  it("no day reaches the narration: the cached prose names containers by meal and dish", () => {
    assert.doesNotMatch(JSON.stringify(b.stepPlan.narrationInput), /\b(?:Monday|Thursday) (?:plate|chicken|sauce|spices|marinade)\b/);
  });

  it("3c — a label stays true when the week moves: Thursday's dinner moved to Wednesday keeps every label", () => {
    const moved = wire(buildPrepWeekPlan(load([monday, { ...thursday, day: "Wednesday", lag: 2 }])));
    const names = (x: typeof r) => [...new Set(x.phases.flatMap((p) => p.steps).flatMap((s) => s.containerNames ?? []))].sort();
    assert.deepEqual(names(moved), names(r));
    for (const s of moved.phases.flatMap((p) => p.steps)) for (const n of s.containerNames ?? []) assert.doesNotMatch(n, /day\b/, n);
  });
});

describe("PREP-3 3c — a dish's short name, 1–2 words", () => {
  it("Hans's week: Skewers, Tso's, Caesar, Meatballs, Chipotle crema, Greek salad, Pico", () => {
    const cases: [string, string][] = [
      ["Lemon-Herb Marinated Chicken Skewers", "Skewers"],
      ["Extra-Crispy General Tso's Chicken", "Tso's"],
      ["Crisp Caesar Salad with Homemade Croutons", "Caesar"],
      ["Beef and Pork Meatballs in Marinara", "Meatballs"],
      ["Chipotle Crema", "Chipotle crema"],
      ["Greek Salad with Warm Pita", "Greek salad"],
      ["Fresh Pico de Gallo", "Pico"],
      ["Seared Skirt Steak", "Steak"],
      ["Chunky Guacamole", "Guacamole"],
      // A meat said last keeps the word that names it; a generic head keeps its hyphenated word.
      ["Grilled Lemon Pepper Chicken Breasts", "Lemon pepper"],
      ["Taco Bell–Style Seasoned Ground Beef", "Ground beef"],
      ["Cilantro-Lime Rice", "Cilantro-lime rice"],
      ["Parmesan-Crusted Baked Pork Chops", "Pork chops"],
      ["Classic Arroz con Pollo", "Arroz con pollo"],
      ["Hummus Bowls and Cucumber-Tomato Salad", "Hummus"],
    ];
    for (const [title, short] of cases) assert.equal(weekShortOf(title), short, title);
  });

  it("two dishes of one week that shorten alike are told apart by their meal, never the weekday", () => {
    const skewers = (n: number, name: string, dish: string, day: string, lag: number): Meal => ({
      id: uuid(n), name, day, lag,
      dishes: [{ id: uuid(n + 1), name: dish,
        ings: [
          { id: uuid(n + 2), name: "extra-virgin olive oil", category: "Pantry", quantity: 2, unit: "tbsp", pack: "bottle" },
          { id: uuid(n + 3), name: "red wine vinegar", category: "Pantry", quantity: 1, unit: "tbsp", pack: "bottle" },
          { id: uuid(n + 4), name: "dried oregano", category: "Pantry", quantity: 1, unit: "tsp" },
        ],
        steps: [{ i: 0, phase: "prep", text: "Whisk the olive oil, vinegar and oregano into a marinade.", ids: [uuid(n + 2), uuid(n + 3), uuid(n + 4)], key: "marinade" }] }],
    });
    const r = wire(buildPrepWeekPlan(load([
      skewers(500, "Greek Chicken Skewers with Rice", "Lemon-Herb Chicken Skewers", "Monday", 1),
      skewers(510, "Beef Skewers with Peppers", "Garlic Beef Skewers", "Thursday", 3),
    ])));
    const names = [...new Set(r.phases.flatMap((p) => p.steps).flatMap((s) => s.containerNames ?? []))].sort();
    assert.deepEqual(names, ["Beef skewers marinade", "Chicken skewers marinade"]);
  });

  it("the held line says the marinade by its label", () => {
    const tso: Meal = {
      id: uuid(600), name: "General Tso's Night", day: "Thursday", lag: 4,
      dishes: [{ id: uuid(601), name: "Extra-Crispy General Tso's Chicken",
        ings: [
          { id: uuid(602), name: "boneless skinless chicken thighs", category: "Protein", quantity: 1, unit: "lb", note: "cut into 1-inch pieces" },
          { id: uuid(603), name: "soy sauce", category: "Pantry", quantity: 2, unit: "tbsp", pack: "bottle" },
          { id: uuid(604), name: "rice vinegar", category: "Pantry", quantity: 1, unit: "tbsp", pack: "bottle" },
          { id: uuid(605), name: "toasted sesame oil", category: "Pantry", quantity: 1, unit: "tsp", pack: "bottle" },
        ],
        steps: [
          { i: 0, phase: "prep", text: "Whisk the soy sauce, rice vinegar and sesame oil into a marinade.", ids: [uuid(603), uuid(604), uuid(605)], key: "marinade" },
          { i: 1, phase: "prep", text: "Coat the chicken thighs in the marinade and refrigerate overnight.", ids: [uuid(602)] },
        ] }],
    };
    const r = wire(buildPrepWeekPlan(load([tso])));
    const held = r.phases.flatMap((p) => p.heldForCookDay ?? []);
    assert.ok(held.some((l) => /add the boneless skinless chicken thighs to the Tso.s marinade the night before/.test(l)), held.join(" | "));
  });
});

describe("PREP-3 — a container's line says its OWN day", () => {
  it("the Tuesday pico's lime: combined Tuesday, though its step also cuts Thursday's cilantro", () => {
    const tuesday: Meal = {
      id: uuid(3), name: "Tacos", day: "Tuesday", lag: 1,
      dishes: [{ id: uuid(31), name: "Fresh Pico de Gallo",
        ings: [
          { id: uuid(301), name: "roma tomatoes", category: "Produce", quantity: 2, unit: "each", note: "seeded and finely diced" },
          { id: uuid(302), name: "white onion", category: "Produce", quantity: 0.5, unit: "each", note: "finely diced" },
          { id: uuid(303), name: "fresh cilantro", category: "Produce", quantity: 0.125, unit: "cup", note: "finely chopped" },
          { id: uuid(304), name: "lime juice", category: "Produce", quantity: 1, unit: "tbsp" },
        ],
        steps: [
          { i: 0, phase: "prep", text: "Seed and finely dice the tomatoes, finely dice the onion and finely chop the cilantro.", ids: [uuid(301), uuid(302), uuid(303)] },
          { i: 1, phase: "assemble", text: "Combine the tomatoes, onion, cilantro and 1 tablespoon lime juice in a bowl.", ids: [uuid(304)] },
        ] }],
    };
    const dal: Meal = { id: uuid(4), name: "Dal", day: "Thursday", lag: 3, dishes: [{ id: uuid(41), name: "Red Lentil Dal",
      ings: [{ id: uuid(303), name: "fresh cilantro", category: "Produce", quantity: 0.125, unit: "cup", note: "chopped" }],
      steps: [{ i: 0, phase: "assemble", text: "Garnish with ⅛ cup chopped cilantro.", ids: [uuid(303)] }] }] };
    const r = wire(buildPrepWeekPlan(load([tuesday, dal])));
    const lines = r.phases.flatMap((p) => p.steps).map((s) => s.storageNote ?? "").filter((n) => /lime juice/.test(n));
    assert.ok(lines.length > 0, "the pico's lime has a line");
    for (const l of lines) assert.doesNotMatch(l, /\(Thursday\)/, l);
  });
});

describe("PREP-3 3c — each container kind, labelled by its dish", () => {
  // A plan's steps as the engine names them: container name → [dish, meal, foods].
  const plan = (rows: [string, string, string, string[]][], proteins: [string, string, string][] = []) => ({
    steps: [
      ...rows.map(([name, dish, mealId, foods], i) => ({
        stepKey: `s${i}`, phase: "produce", bowlName: undefined,
        components: foods.map((f) => ({ ingredientName: f, measures: [{ forDish: dish, mealId, destination: name }] })),
      })),
      ...proteins.map(([food, dish, mealId], i) => ({
        stepKey: `p${i}`, phase: "proteins",
        components: [{ ingredientName: food, measures: [{ forDish: dish, mealId }] }],
      })),
    ],
  }) as never;
  const days = new Map([["m1", "Monday"], ["m2", "Tuesday"]]);

  it("a role word in any case, a dish's own '<dish> — foods' box, a main dish's bowl, the produce rule, a protein's last word", () => {
    const { map, proteins } = weekLabelMap(plan([
      ["Toum Garlic Sauce jar", "Toum Garlic Sauce", "m1", ["garlic"]],
      ["Classic Tomato-Vegetable Minestrone — medium zucchini and green beans", "Classic Tomato-Vegetable Minestrone with Ditalini", "m1", ["medium zucchini", "green beans"]],
      ["Sheet-Pan Italian Sausage with Roasted Bell Peppers bowl", "Sheet-Pan Italian Sausage with Roasted Bell Peppers", "m2", ["red bell pepper", "garlic"]],
      ["Stir-Fried Broccoli vegetables", "Stir-Fried Broccoli with Garlic", "m2", ["garlic", "broccoli florets"]],
      ["Chipotle Crema sauce jar", "Chipotle Crema", "m2", ["adobo sauce", "garlic powder"]],
    ], [["chicken sausage", "Chicken Sausage and Peppers", "m2"]]), days, new Map([["m2", "Sheet-Pan Italian Sausage with Roasted Bell Peppers"]]));
    // A sauce dish's jar keeps its role (named "Chipotle crema", Cook Mode never said the jar).
    assert.equal(map.get("Chipotle Crema sauce jar"), "Chipotle crema sauce");
    assert.equal(map.get("Toum Garlic Sauce jar"), "Garlic sauce");
    assert.equal(map.get("Classic Tomato-Vegetable Minestrone — medium zucchini and green beans"), "Minestrone vegetables");
    assert.equal(map.get("Sheet-Pan Italian Sausage with Roasted Bell Peppers bowl"), "Italian sausage bowl");
    assert.equal(map.get("Stir-Fried Broccoli vegetables"), "Broccoli & garlic");
    assert.equal(proteins.get("p0")?.get("m2"), "Sausage & peppers");
  });

  it("one meal's two dishes that shorten alike: a number, not a word the meal does not say", () => {
    const { map } = weekLabelMap(plan([
      ["Harissa Chicken marinade bowl", "Harissa Chicken", "m1", ["harissa paste"]],
      ["Harissa Chicken Bowls marinade bowl", "Harissa Chicken Bowls", "m1", ["harissa paste"]],
    ]), days, new Map(), new Map([["m1", "Harissa Night"]]));
    assert.deepEqual([...map.values()], ["Harissa marinade", "Harissa marinade 2"]);
  });
});
