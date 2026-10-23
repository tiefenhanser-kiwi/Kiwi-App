// PREP-3 (R9) — one moment per jar member, and a storage line that names a shared tub's
// food. The dishes are the catalog's own (hh2 Friday, hh4-mixed Monday, Thursday, Friday),
// cut to what the mechanism reads.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildPrepWeekPlan } from "../prepWeekBuild";
import { containers, load, uuid, wire, type Meal } from "./fixtures/prep3Week";

const together = (b: ReturnType<typeof buildPrepWeekPlan>, a: RegExp, z: RegExp) =>
  [...containers(b)].filter(([, items]) => items.some((i) => a.test(i)) && items.some((i) => z.test(i))).map(([n]) => n);

describe("PREP-3 (R9) — one moment per jar member", () => {
  it("the pork chops' Dijon, brushed on in step 1, is not stirred into the crumb crust", () => {
    const pork: Meal = {
      id: uuid(1), name: "Parmesan-Crusted Baked Pork Chops", day: "Friday", lag: 1,
      dishes: [{
        id: uuid(11), name: "Parmesan-Crusted Baked Pork Chops",
        ings: [
          { id: uuid(101), name: "bone-in pork chops", category: "Protein", quantity: 4, unit: "each", note: "patted dry" },
          { id: uuid(102), name: "panko breadcrumbs", category: "Pantry", quantity: 0.75, unit: "cup" },
          { id: uuid(103), name: "garlic powder", category: "Pantry", quantity: 1, unit: "tsp" },
          { id: uuid(104), name: "smoked paprika", category: "Pantry", quantity: 0.5, unit: "tsp" },
          { id: uuid(105), name: "dried italian seasoning", category: "Pantry", quantity: 0.5, unit: "tsp" },
          { id: uuid(106), name: "dijon mustard", category: "Pantry", quantity: 2, unit: "tbsp" },
          { id: uuid(107), name: "olive oil", category: "Pantry", quantity: 2, unit: "tbsp" },
        ],
        steps: [
          { i: 0, phase: "preheat", text: "Preheat the oven to 425°F and line a rimmed baking sheet with a wire rack." },
          { i: 1, phase: "prep", text: "Pat the 4 bone-in pork chops dry and brush both sides evenly with 2 tablespoons Dijon mustard.", ids: [uuid(101), uuid(106)] },
          { i: 2, phase: "prep", text: "In a shallow bowl, combine ¾ cup panko breadcrumbs, 1 teaspoon garlic powder, ½ teaspoon smoked paprika, ½ teaspoon dried Italian seasoning; drizzle in 2 tablespoons olive oil and toss to combine.", ids: [uuid(102), uuid(103), uuid(104), uuid(105), uuid(107)], key: "crust" },
          { i: 3, phase: "assemble", text: "Press the breadcrumb mixture onto each mustard-coated pork chop." },
          { i: 4, phase: "cook", text: "Bake at 425°F for 20–25 minutes." },
        ],
      }],
    };
    const b = buildPrepWeekPlan(load([pork]));
    assert.deepEqual(together(b, /dijon/i, /panko/i), [], JSON.stringify([...containers(b)]));
  });

  it("the Caesar's croutons keep their oil and their rubbing garlic: neither is in the dressing jar", () => {
    const caesar: Meal = {
      id: uuid(2), name: "Garlic Butter Grilled Salmon with Crisp Caesar Salad", day: "Thursday", lag: 1,
      dishes: [{
        id: uuid(21), name: "Crisp Caesar Salad with Homemade Croutons",
        ings: [
          { id: uuid(201), name: "day-old sourdough", category: "Bakery", quantity: 4, unit: "oz", note: "torn into 3/4-inch pieces" },
          { id: uuid(202), name: "olive oil", category: "Pantry", quantity: 2, unit: "tbsp", note: "for croutons" },
          { id: uuid(203), name: "garlic", category: "Produce", quantity: 1, unit: "clove", note: "halved, for rubbing croutons" },
          { id: uuid(204), name: "fresh lemon juice", category: "Produce", quantity: 2, unit: "tbsp" },
          { id: uuid(205), name: "dijon mustard", category: "Pantry", quantity: 1, unit: "tsp" },
          { id: uuid(206), name: "worcestershire sauce", category: "Pantry", quantity: 0.5, unit: "tsp" },
          { id: uuid(203), name: "garlic", category: "Produce", quantity: 1, unit: "clove", note: "minced to a paste for dressing" },
          { id: uuid(207), name: "extra-virgin olive oil", category: "Pantry", quantity: 3, unit: "tbsp", note: "for dressing" },
        ],
        steps: [
          { i: 2, phase: "prep", text: "Mince 1 garlic clove to a fine paste.", ids: [uuid(203)], key: "dressing" },
          { i: 3, phase: "prep", text: "Whisk together the garlic paste, 2 tablespoons fresh lemon juice, 1 teaspoon Dijon mustard, and ½ teaspoon Worcestershire sauce in a medium bowl.", ids: [uuid(204), uuid(205), uuid(206)], key: "dressing" },
          { i: 4, phase: "prep", text: "Slowly drizzle in 3 tablespoons extra-virgin olive oil while whisking constantly to emulsify into a creamy dressing.", ids: [uuid(207)], key: "dressing" },
          { i: 6, phase: "prep", text: "Tear 4 oz day-old sourdough into ¾-inch pieces, toss with 2 tablespoons olive oil, then rub the torn pieces with the cut side of a halved garlic clove.", ids: [uuid(201), uuid(202)], key: "croutons" },
          { i: 7, phase: "cook", text: "Toast the bread pieces in a dry skillet over medium heat for 6–8 minutes until golden.", key: "croutons" },
          { i: 9, phase: "assemble", text: "Drizzle the dressing over the chilled romaine and toss, then add the croutons." },
        ],
      }],
    };
    const b = buildPrepWeekPlan(load([caesar]));
    assert.deepEqual(together(b, /lemon juice/i, /for croutons|rubbing croutons|sourdough/i), [], JSON.stringify([...containers(b)]));
    // The croutons' step is never labelled by the dressing's, two steps on: with no note
    // to say whose it is, their oil is still not the dressing's.
    const unnoted = { ...caesar, dishes: [{ ...caesar.dishes[0], ings: caesar.dishes[0].ings.filter((i) => i.id !== uuid(202)).concat({ id: uuid(208), name: "extra-virgin olive oil", category: "Pantry", quantity: 2, unit: "tbsp" }), steps: caesar.dishes[0].steps.map((s) => (s.i === 6 ? { ...s, text: s.text.replace("2 tablespoons olive oil", "2 tablespoons extra-virgin olive oil"), ids: [uuid(201), uuid(208)] } : s)) }] };
    const u = buildPrepWeekPlan(load([unnoted]));
    assert.deepEqual(together(u, /lemon juice/i, /sourdough/i), [], JSON.stringify([...containers(u)]));
    assert.ok(![...containers(u)].some(([, items]) => items.some((i) => /lemon juice/i.test(i)) && items.filter((i) => /extra-virgin olive oil/i.test(i)).length > 1), JSON.stringify([...containers(u)]));
  });

  it("the meatballs' searing oil is heated in the pan, not jarred with the breadcrumbs", () => {
    const meatballs: Meal = {
      id: uuid(3), name: "Classic Meatball Sub", day: "Friday", lag: 1,
      dishes: [{
        id: uuid(31), name: "Beef and Pork Meatballs in Marinara",
        ings: [
          { id: uuid(301), name: "plain breadcrumbs", category: "Pantry", quantity: 0.5, unit: "cup" },
          { id: uuid(302), name: "dried oregano", category: "Pantry", quantity: 0.5, unit: "tsp" },
          { id: uuid(303), name: "red pepper flakes", category: "Pantry", quantity: 0.25, unit: "tsp" },
          { id: uuid(304), name: "ground beef", category: "Protein", quantity: 0.75, unit: "lb" },
          { id: uuid(305), name: "extra-virgin olive oil", category: "Pantry", quantity: 2, unit: "tbsp" },
        ],
        steps: [
          { i: 0, phase: "prep", text: "Combine ½ cup plain breadcrumbs and ¼ cup whole milk in a large bowl and let soak for 2 minutes.", ids: [uuid(301)] },
          { i: 1, phase: "prep", text: "Add ¾ pound ground beef, ½ teaspoon dried oregano and ¼ teaspoon red pepper flakes to the soaked breadcrumbs and mix gently.", ids: [uuid(304), uuid(302), uuid(303)] },
          { i: 3, phase: "preheat", text: "Heat 2 tablespoons extra-virgin olive oil in a large, wide skillet or Dutch oven over medium-high heat until shimmering.", ids: [uuid(305)] },
          { i: 4, phase: "cook", text: "Sear the meatballs in a single layer until browned on all sides." },
        ],
      }],
    };
    const b = buildPrepWeekPlan(load([meatballs]));
    assert.deepEqual(together(b, /olive oil/i, /breadcrumbs|oregano/i), [], JSON.stringify([...containers(b)]));
  });
});

describe("PREP-3 (R9) — a storage line names a shared tub's food, never its dishes", () => {
  it("\"Stir in 1 tbsp of the lemon juice\", not \"Stir in the Tzatziki, Garlic Butter Grilled Salmon …\"", () => {
    const tzatziki: Meal = {
      id: uuid(4), name: "Mediterranean Chicken Skewers", day: "Monday", lag: 1,
      dishes: [{
        id: uuid(41), name: "Tzatziki",
        ings: [
          { id: uuid(401), name: "english cucumber", category: "Produce", quantity: 0.5, unit: "each", note: "grated and squeezed dry" },
          { id: uuid(402), name: "full-fat greek yogurt", category: "Dairy", quantity: 1, unit: "cup" },
          { id: uuid(403), name: "fresh dill", category: "Produce", quantity: 2, unit: "tbsp", note: "finely chopped" },
          { id: uuid(404), name: "fresh lemon juice", category: "Produce", quantity: 1, unit: "tbsp" },
        ],
        steps: [
          { i: 0, phase: "prep", text: "Grate ½ English cucumber and squeeze it dry.", ids: [uuid(401)] },
          { i: 1, phase: "assemble", text: "Stir together 1 cup full-fat Greek yogurt, the squeezed cucumber, 2 tablespoons finely chopped fresh dill and 1 tablespoon fresh lemon juice.", ids: [uuid(402), uuid(403), uuid(404)] },
          { i: 3, phase: "rest", text: "Cover the tzatziki and refrigerate until ready to serve." },
        ],
      }],
    };
    const salmon: Meal = {
      id: uuid(5), name: "Garlic Butter Grilled Salmon", day: "Thursday", lag: 3,
      dishes: [{
        id: uuid(51), name: "Garlic Butter Grilled Salmon",
        ings: [{ id: uuid(404), name: "fresh lemon juice", category: "Produce", quantity: 1, unit: "tbsp" }, { id: uuid(502), name: "unsalted butter", category: "Dairy", quantity: 3, unit: "tbsp" }],
        steps: [{ i: 0, phase: "prep", text: "Stir 1 tablespoon fresh lemon juice into 3 tablespoons melted unsalted butter.", ids: [uuid(404), uuid(502)] }],
      }],
    };
    const r = wire(buildPrepWeekPlan(load([tzatziki, salmon])));
    const notes = r.phases.flatMap((p) => p.steps).map((s) => s.storageNote ?? "").filter((n) => /Stir in|Keep the/.test(n));
    assert.ok(notes.length > 0, "the tzatziki's lemon juice has a line");
    for (const n of notes) {
      assert.doesNotMatch(n, /Garlic Butter Grilled Salmon|Tzatziki,/, n);
      assert.match(n, /\b(?:Stir in|Keep) 1 tbsp of the (?:fresh )?lemon juice\b/, n);
    }
  });
});
