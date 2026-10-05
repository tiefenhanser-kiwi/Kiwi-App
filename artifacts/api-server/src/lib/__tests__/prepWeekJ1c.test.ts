// [prepcook] Part J.1c — Hans's device pass on Prep the Week (BUG-355) and long
// container names (BUG-354), through the real adapter, engine, assembly and
// `finishPrepWeek` — what the route serves.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { LoadPrepWeekInputResult, PrepLoadedPlan } from "../prepWeekAggregation";
import { buildPrepWeekPlan, finishPrepWeek, type PrepWeekBuild } from "../prepWeekBuild";
import { assemblePrepWeekResult, buildStepPlan, composePortionStep, fitDishName, summarizePrepWeek } from "../prepWeekAssembly";
import { combinePrep } from "../prepCombineEngine";
import { proteinVerbsFor } from "../prepComponents";
import { closingNote } from "../prepStorage";
import { PrepWeekResultSchema, type PrepWeekResult } from "../ai/schemas/prepWeek";

type Ing = { id: string; name: string; category: string; quantity: number; unit: string; note?: string; pack?: string };
type St = { i: number; phase: string; text: string; ids?: string[]; key?: string };
type Dish = { id: string; name: string; ings: Ing[]; steps: St[] };
type Meal = { id: string; name: string; day: string; lag: number; dishes: Dish[] };

const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-00000000c1c0`;

function load(meals: Meal[]): LoadPrepWeekInputResult {
  const input: PrepLoadedPlan = {
    planId: uuid(999),
    planName: "J.1c",
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
          preparationNote: x.note ?? null, sourceYield: null, purchaseUnit: x.pack ?? null,
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

/**
 * The route's path with a narrator that writes what the real one does on a portion
 * step: the knife work with the code's own total ("Slice 3 celery stalks.").
 * `opening` overrides it per food, to play a narrator that gets the number wrong.
 */
function wire(build: PrepWeekBuild, opening: (food: string, total: string) => string = (f, t) => `Cut ${t} ${f}.`): PrepWeekResult {
  const narration = {
    steps: build.stepPlan.narrationInput.steps.map((s) => ({
      stepId: s.stepId,
      title: "Do it",
      instructions: s.portionsByApp ? opening(s.portionsByApp.food, s.portionsByApp.total) : "Do it.",
    })),
  };
  const res = summarizePrepWeek(finishPrepWeek(assemblePrepWeekResult(build.stepPlan, narration), build));
  const v = PrepWeekResultSchema.safeParse(res);
  assert.ok(v.success, v.success ? "" : JSON.stringify(v.error.flatten()));
  return res;
}
const allSteps = (r: PrepWeekResult) => r.phases.flatMap((p) => p.steps);
const live = (r: PrepWeekResult) => allSteps(r).filter((s) => !s.skipSuggested);
const destinations = (b: PrepWeekBuild, ingredient: string) =>
  [...new Set(b.stepPlan.steps.flatMap((s) => s.components.filter((c) => c.ingredientName === ingredient).flatMap((c) => c.measures.map((m) => m.destination))))];

const ing = (n: number, name: string, quantity: number, unit: string, note?: string, category = "Produce"): Ing => ({ id: uuid(n), name, category, quantity, unit, ...(note ? { note } : {}) });

describe("J.1c BUG-355 — Hans's device pass", () => {
  // Two dishes wanting the same cut: rule 5's shared tub. The chili and the tacos.
  const onionWeek = (): Meal[] => [
    { id: uuid(1), name: "Texas-Style Beef Chili", day: "Monday", lag: 1, dishes: [{
      id: uuid(11), name: "Texas-Style Beef Chili",
      ings: [ing(101, "yellow onion", 1, "each", "finely diced"), ing(102, "ground beef", 2, "lb", undefined, "Protein")],
      steps: [{ i: 0, phase: "cook", text: "Brown the beef with the onion for 8 minutes.", ids: [uuid(101), uuid(102)] }],
    }] },
    { id: uuid(2), name: "Tex-Mex Seasoned Ground Beef", day: "Tuesday", lag: 2, dishes: [{
      id: uuid(21), name: "Tex-Mex Seasoned Ground Beef",
      ings: [ing(101, "yellow onion", 1, "each", "finely diced"), ing(103, "lean ground beef", 1, "lb", undefined, "Protein")],
      steps: [{ i: 0, phase: "cook", text: "Cook the beef and onion in a skillet for 10 minutes.", ids: [uuid(101), uuid(103)] }],
    }] },
  ];

  it("1 — a shared tub is named ONCE, at the head of its line; 'same tub' never renders", () => {
    const r = wire(buildPrepWeekPlan(load(onionWeek())));
    const onion = live(r).find((s) => s.instructions.includes("yellow onion"))!;
    const lines = onion.instructions.split("\n");
    assert.equal(lines.length, 2, onion.instructions);
    assert.equal(lines[1], "Into one shared finely diced yellow onion tub: 1 for the Texas-Style Beef Chili · 1 for the Tex-Mex Seasoned Ground Beef");
    for (const s of allSteps(r)) assert.doesNotMatch(s.instructions, /\bsame (tub|bowl|jar|container|bag|plate)\b/, s.instructions);
  });

  // One dish, one destination: the slow cooker's celery.
  const soup = (opening?: string): Meal[] => [{
    id: uuid(3), name: "Slow-Cooker Chicken and Dumplings", day: "Monday", lag: 1, dishes: [{
      id: uuid(31), name: "Slow-Cooker Chicken and Dumplings",
      ings: [ing(301, "celery stalks", 3, "each", "sliced into ½-inch pieces"), ing(302, "carrots", 3, "each", "peeled and sliced into ½-inch coins")],
      steps: [{ i: 0, phase: "cook", text: `${opening ?? "Scatter the celery and carrots in the slow cooker"} and cook on low for 6 hours.`, ids: [uuid(301), uuid(302)] }],
    }] },
  ];

  it("2 — one destination is ONE sentence: the code's amount, the narrator's cut, the lid", () => {
    const b = buildPrepWeekPlan(load(soup()));
    const r = wire(b, (food, total) => (/celery/.test(food) ? `Slice ${total} into ½-inch pieces.` : `Peel ${total} and slice them into ½-inch coins.`));
    const celery = live(r).find((s) => s.instructions.includes("celery"))!;
    assert.equal(celery.instructions, "Slice 3 celery stalks into ½-inch pieces for the Slow-Cooker Chicken vegetables container.");
    const carrots = live(r).find((s) => s.instructions.includes("carrot"))!;
    assert.equal(carrots.instructions.split("\n").length, 1, carrots.instructions);
  });

  it("5 — the fold never drops the code's number: an opening that says 2 carrots keeps the code's '3 carrots' line", () => {
    // D-WS9-301: quantities are the code's. A narrator that writes "Peel 2 carrots" over a
    // 3-carrot portion must not become the only number on screen.
    const r = wire(buildPrepWeekPlan(load(soup())), (food, total) => (/carrot/.test(food) ? "Peel 2 carrots and slice them into ½-inch coins." : `Slice ${total}.`));
    const carrots = live(r).find((s) => s.instructions.includes("carrot"))!;
    const lines = carrots.instructions.split("\n");
    assert.equal(lines.length, 2, carrots.instructions);
    assert.match(lines[1], /^3 carrots\b/);
    // …and an opening with no number at all keeps the line too.
    assert.equal(composePortionStep("Peel and slice the carrots.", buildPrepWeekPlan(load(soup())).stepPlan.steps.find((s) => s.components.some((c) => c.ingredientName === "carrots"))!.components).split("\n").length, 2);
  });

  it("3 — one dish's lone items take its class lids: citrus juice → citrus jar, garnish → toppings plate, a cut → vegetables", () => {
    const b = buildPrepWeekPlan(load([{
      id: uuid(4), name: "Lemon Chicken Night", day: "Monday", lag: 1, dishes: [
        { id: uuid(41), name: "Roasted Asparagus with Lemon",
          ings: [ing(401, "asparagus", 1.25, "lb", "woody ends snapped off"), ing(402, "lemon juice", 1, "tbsp", "freshly squeezed")],
          steps: [{ i: 0, phase: "cook", text: "Roast the asparagus for 12 minutes.", ids: [uuid(401)] }, { i: 1, phase: "assemble", text: "Drizzle with the lemon juice.", ids: [uuid(402)] }] },
        { id: uuid(42), name: "Garlic Herb Roasted Potatoes",
          ings: [ing(403, "fresh flat-leaf parsley", 1, "tbsp", "chopped")],
          steps: [{ i: 0, phase: "assemble", text: "Sprinkle with the parsley and serve.", ids: [uuid(403)] }] },
        { id: uuid(43), name: "Jalapeño Cheddar Cornbread",
          ings: [ing(404, "jalapeño", 1, "each", "finely diced")],
          steps: [{ i: 0, phase: "assemble", text: "Fold the jalapeño into the batter.", ids: [uuid(404)] }] },
      ],
    }]));
    assert.deepEqual(destinations(b, "lemon juice"), ["Roasted Asparagus with Lemon citrus jar"]);
    assert.deepEqual(destinations(b, "fresh flat-leaf parsley"), ["Garlic Herb Roasted Potatoes toppings plate"]);
    assert.deepEqual(destinations(b, "jalapeño"), ["Jalapeño Cheddar Cornbread vegetables"]);
    assert.deepEqual(destinations(b, "asparagus"), ["Roasted Asparagus with Lemon vegetables"]);
    for (const n of b.stepPlan.steps.flatMap((s) => s.components.flatMap((c) => c.measures.map((m) => m.destination ?? "")))) {
      assert.ok(!n.includes(" — "), `a contents-named lid for one dish: ${n}`);
    }
  });

  it("3 — the thing garnished is not the garnish: 'Sprinkle the asparagus with salt' keeps the asparagus off the plate", () => {
    // e55a9305's re-render put "Snap the woody ends off 1¼ lb asparagus" on the
    // Roasted Asparagus toppings plate — the sentence named asparagus and said sprinkle.
    const b = buildPrepWeekPlan(load([{
      id: uuid(14), name: "Asparagus Night", day: "Monday", lag: 1, dishes: [{
        id: uuid(141), name: "Roasted Asparagus with Lemon",
        ings: [ing(1401, "asparagus", 1.25, "lb", "woody ends snapped off"), ing(1402, "fresh parsley", 1, "tbsp", "chopped")],
        steps: [
          { i: 0, phase: "cook", text: "Toss the asparagus with oil, sprinkle the asparagus with salt and roast for 12 minutes.", ids: [uuid(1401)] },
          { i: 1, phase: "assemble", text: "Scatter the parsley over the top and serve.", ids: [uuid(1402)] },
        ],
      }],
    }]));
    assert.deepEqual(destinations(b, "asparagus"), ["Roasted Asparagus with Lemon vegetables"]);
    assert.deepEqual(destinations(b, "fresh parsley"), ["Roasted Asparagus with Lemon toppings plate"]);
  });

  it("3 — a citrus juiced by its NOTE is the juice too ('lemon', juiced → the citrus jar)", () => {
    const b = buildPrepWeekPlan(load([{
      id: uuid(12), name: "Broccolini Night", day: "Monday", lag: 1, dishes: [{
        id: uuid(121), name: "Sautéed Broccolini with Garlic and Chili Flake",
        ings: [ing(1201, "lemon", 0.5, "each", "juiced")],
        steps: [{ i: 0, phase: "assemble", text: "Squeeze the lemon over the broccolini.", ids: [uuid(1201)] }],
      }],
    }]));
    assert.deepEqual(destinations(b, "lemon"), ["Sautéed Broccolini with Garlic and Chili Flake citrus jar"]);
  });

  it("3 — several lone cuts of one dish: ONE prep plate, a pile each, and its line names the piles", () => {
    // A chicken salad printed three lids — romaine, celery, cherry tomatoes — each named
    // after itself. The recipe never says they meet, so they must not share a tub; piles
    // on one plate keep them apart under one lid named by its form.
    const b = buildPrepWeekPlan(load([{
      id: uuid(13), name: "Salad Night", day: "Monday", lag: 1, dishes: [{
        id: uuid(131), name: "Chicken Salad",
        ings: [ing(1301, "romaine lettuce hearts", 2, "cup", "chopped"), ing(1302, "celery stalks", 2, "each", "thinly sliced"), ing(1303, "cherry tomatoes", 1, "cup", "halved")],
        steps: [{ i: 0, phase: "prep", text: "Chop the romaine, slice the celery and halve the tomatoes.", ids: [uuid(1301), uuid(1302), uuid(1303)] }],
      }],
    }]));
    for (const n of ["romaine lettuce hearts", "celery stalks", "cherry tomatoes"]) assert.deepEqual(destinations(b, n), ["Chicken Salad prep plate"], n);
    const r = wire(b);
    const note = live(r).map((s) => s.storageNote ?? "").find((n) => /plate/.test(n)) ?? "";
    assert.match(note, /^(?:Chicken Salad prep plate: )?Separate piles \(romaine lettuce hearts, celery stalks and cherry tomatoes\) on a small plate/, note);
  });

  it("3 — a step closing two lids that keep differently names each of them", () => {
    const note = closingNote([
      { name: "Warm Cinnamon Applesauce citrus jar", text: "", ingredientNames: ["fresh lemon juice"], own: true },
      { name: "Roasted Green Beans citrus jar", text: "", ingredientNames: ["lemon", "fresh green beans"], own: true },
    ]);
    assert.doesNotMatch(note, /^Both containers: /, `fixture: the two jars keep differently (${note})`);
    assert.match(note, /Warm Cinnamon Applesauce citrus jar: /, note);
    assert.match(note, /Roasted Green Beans citrus jar: /, note);
  });

  it("3 — lids that keep alike share ONE sentence, so every lid the step closes is still named", () => {
    // f49f5209's parsley closes two toppings plates and an aromatics container. Named one
    // by one, the line passed 200 and the aromatics container's sentence was dropped.
    const note = closingNote([
      { name: "Creamy Beef and Mushroom Stroganoff toppings plate", text: "", ingredientNames: ["fresh flat-leaf parsley"], own: true },
      { name: "Buttered Egg Noodles toppings plate", text: "", ingredientNames: ["fresh flat-leaf parsley"], own: true },
      { name: "Buttered Egg Noodles aromatics", text: "", ingredientNames: ["fresh flat-leaf parsley"], own: true },
    ]);
    assert.ok(note.length <= 200, `${note.length}: ${note}`);
    assert.match(note, /^Creamy Beef and Mushroom Stroganoff toppings plate and Buttered Egg Noodles toppings plate: (?:Separate piles on a small plate|Plate, wrapped)/, note);
    assert.match(note, /Buttered Egg Noodles aromatics: /, note);
  });

  it("3 — a lone juice joins the dish's sauce jar when it has one", () => {
    const b = buildPrepWeekPlan(load([{
      id: uuid(5), name: "Dressed Greens", day: "Monday", lag: 1, dishes: [{
        id: uuid(51), name: "Herb Vinaigrette Salad",
        ings: [
          { ...ing(501, "extra-virgin olive oil", 3, "tbsp", undefined, "Pantry"), pack: "bottle" }, { ...ing(502, "red wine vinegar", 1, "tbsp", undefined, "Pantry"), pack: "bottle" },
          { ...ing(503, "honey", 1, "tbsp", undefined, "Pantry"), pack: "jar" }, ing(504, "lemon juice", 1, "tbsp", "freshly squeezed"),
        ],
        steps: [
          { i: 0, phase: "prep", text: "Whisk the oil, vinegar and mustard into a dressing.", ids: [uuid(501), uuid(502), uuid(503)], key: "dressing" },
          { i: 1, phase: "assemble", text: "Toss the greens and squeeze over the lemon juice.", ids: [uuid(504)] },
        ],
      }],
    }]));
    const jar = b.stepPlan.steps.find((s) => s.bowlName)?.bowlName;
    assert.ok(jar && / sauce jar$/.test(jar), `fixture: a sauce jar formed (${jar})`);
    assert.deepEqual(destinations(b, "lemon juice"), [jar]);
  });

  it("3 — a tub shared by two dishes keeps its contents name", () => {
    const b = buildPrepWeekPlan(load(onionWeek()));
    const [d] = destinations(b, "yellow onion");
    assert.match(d ?? "", /^Finely diced yellow onion — /);
  });

  it("3 — a lone cut is NEVER put into a vegetables container that already exists (it goes in at another moment)", () => {
    // The moments are stated, as the adapter states them for a recipe that says so: the
    // onion and pepper into the pan at step 1, the garlic at step 2 (H7.1 1's shape).
    const sp = buildStepPlan(combinePrep({
      meals: [{ mealId: "m", mealName: "Taco Night", dishes: [{ dishId: "d-taco", dishName: "Taco Filling", dishRole: "main", ingredients: [
        { ingredientId: "on", ingredientName: "yellow onion", category: "Produce", quantity: 1, unit: "each", preparationNote: "diced", momentKey: "s:1" },
        { ingredientId: "pe", ingredientName: "green bell pepper", category: "Produce", quantity: 1, unit: "each", preparationNote: "diced", momentKey: "s:1" },
        { ingredientId: "ga", ingredientName: "garlic", category: "Produce", quantity: 3, unit: "clove", preparationNote: "minced", momentKey: "s:2" },
      ] }] }],
    }), "P");
    const dest = (n: string) => sp.steps.find((s) => s.components.some((c) => c.ingredientName === n))?.components[0].measures[0].destination;
    assert.equal(dest("yellow onion"), "Taco Filling vegetables", "fixture: the onion and pepper share the pan's container");
    assert.notEqual(dest("garlic"), dest("yellow onion"), "the later garlic joined the onion");
    assert.equal(dest("garlic"), "Taco Filling prep plate");
  });

  it("4 — a hyphenated weight is not the verb: '3-pound pork shoulder' is never 'Pound the pork shoulder'", () => {
    assert.deepEqual(proteinVerbsFor(null, "Season the 3-pound pork shoulder all over."), []);
    assert.deepEqual(proteinVerbsFor(null, "Rub a 4-pound whole chicken with oil."), []);
    assert.deepEqual(proteinVerbsFor(null, "Pound the chicken to an even ½ inch."), ["pound"]);
  });

  it("4 — Hans's three proteins, through the engine: about 12 minutes, not 22", () => {
    const b = buildPrepWeekPlan(load([
      { id: uuid(7), name: "Lemon-Herb Baked Chicken Breast", day: "Monday", lag: 1, dishes: [{ id: uuid(71), name: "Lemon-Herb Baked Chicken Breast",
        ings: [ing(701, "boneless skinless chicken breasts", 2.5, "lb", "pounded to even thickness (~¾ inch)", "Protein")],
        steps: [{ i: 0, phase: "prep", text: "Pound the chicken breasts to an even ¾ inch.", ids: [uuid(701)] }, { i: 1, phase: "cook", text: "Bake for 20 minutes.", ids: [] }] }] },
      { id: uuid(8), name: "Slow-Cooker Chicken and Dumplings", day: "Monday", lag: 1, dishes: [{ id: uuid(81), name: "Slow-Cooker Chicken and Dumplings",
        ings: [ing(801, "boneless skinless chicken thighs", 1.75, "lb", "trimmed of excess fat", "Protein")],
        steps: [{ i: 0, phase: "cook", text: "Place the trimmed chicken thighs in the slow cooker and cook 6 hours.", ids: [uuid(801)] }] }] },
      { id: uuid(9), name: "Texas-Style Beef Chili", day: "Monday", lag: 1, dishes: [{ id: uuid(91), name: "Texas-Style Beef Chili",
        ings: [ing(901, "beef chuck", 2, "lb", "cut into ¾-inch cubes, trimmed of excess fat", "Protein")],
        steps: [{ i: 0, phase: "prep", text: "Cube the beef chuck and trim off excess fat.", ids: [uuid(901)] }, { i: 1, phase: "cook", text: "Brown the beef for 10 minutes.", ids: [] }] }] },
    ]));
    const proteins = b.stepPlan.steps.filter((s) => s.phase === "proteins" && !s.demoted);
    assert.equal(proteins.length, 3);
    const total = proteins.reduce((n, s) => n + s.estimatedMinutes, 0);
    assert.ok(total >= 12 && total <= 13, `${total} minutes: ${proteins.map((s) => `${s.knifeVerbs?.join("+")} ${s.estimatedMinutes}`).join(", ")}`);
  });
});

describe("J.1c BUG-354 — a long dish name never fails the response", () => {
  // 118 characters: past the ~105 where "<dish> toppings plate" crossed the 120 cap.
  const LONG = "Grandmother's Sunday Slow-Roasted Herb-Crusted Chicken Thighs with Charred Lemon, Crispy Shallots and Garden Herb Salsa";

  it("every container name fits the wire in whole words, and the response validates", () => {
    assert.ok(LONG.length >= 118, `${LONG.length}`);
    const b = buildPrepWeekPlan(load([{
      id: uuid(10), name: LONG, day: "Monday", lag: 1, dishes: [{
        id: uuid(110), name: LONG,
        ings: [
          ing(1001, "roma tomatoes", 2, "each", "diced, for topping"), ing(1002, "white onion", 0.5, "each", "finely diced, to serve"),
          ing(1003, "lemon juice", 1, "tbsp", "freshly squeezed"), ing(1004, "fresh parsley", 2, "tbsp", "chopped"),
          ing(1005, "shallots", 2, "each", "thinly sliced"), ing(1006, "chicken thighs", 2, "lb", "trimmed", "Protein"),
          ing(1007, "ground cumin", 1, "tsp", undefined, "Pantry"), ing(1008, "smoked paprika", 1, "tsp", undefined, "Pantry"), ing(1009, "dried oregano", 1, "tsp", undefined, "Pantry"),
        ],
        steps: [
          { i: 0, phase: "prep", text: "Rub the chicken with the cumin, paprika and oregano.", ids: [uuid(1006), uuid(1007), uuid(1008), uuid(1009)] },
          { i: 1, phase: "cook", text: "Fry the shallots until crisp, 6 minutes.", ids: [uuid(1005)] },
          { i: 2, phase: "assemble", text: "Top with the tomatoes, onion and parsley, and drizzle with the lemon juice.", ids: [uuid(1001), uuid(1002), uuid(1003), uuid(1004)] },
        ],
      }],
    }]));
    const r = wire(b); // asserts the schema: the whole response validates
    const names = [...new Set(allSteps(r).flatMap((s) => s.containerNames ?? []))];
    assert.ok(names.length > 0);
    const words = new Set(LONG.split(/\s+/));
    for (const n of names) {
      assert.ok(n.length <= 120, `${n.length}: ${n}`);
      // the dish part is whole words of the dish (or its short name), never a cut word
      const head = n.split(/ (?:toppings plate|prep plate|plate|citrus jar|juice jar|vegetables|aromatics|spice blend|dry mix|sauce jar|marinade bowl|bowl)$| — /)[0];
      for (const w of head.split(/\s+/)) assert.ok(words.has(w) || words.has(`${w},`), `a cut word "${w}" in ${n}`);
    }
    for (const s of allSteps(r)) assert.ok(s.title.length <= 120);
  });

  it("fitDishName — full when it fits, the short name next, then whole words; the use is never cut", () => {
    assert.equal(fitDishName("Fish Tacos", " toppings plate"), "Fish Tacos toppings plate");
    const fitted = fitDishName(LONG, " toppings plate");
    assert.ok(fitted.length <= 104, `${fitted.length}`);
    assert.match(fitted, / toppings plate$/);
    assert.equal(fitted, "Chicken Thighs toppings plate", "the short name: the dish before \" with …\"");
    const noShort = "Aaaa Bbbbbbbbb Cccccccccc Dddddddddd Eeeeeeeeee Ffffffffff Gggggggggg Hhhhhhhhhh Iiiiiiiiii Jjjjjjjjjj Kkkkkkkkkk Llllllllll";
    const cut = fitDishName(noShort, " toppings plate");
    assert.ok(cut.length <= 104 && cut.endsWith(" toppings plate"), cut);
    for (const w of cut.replace(/ toppings plate$/, "").split(" ")) assert.ok(noShort.split(" ").includes(w), `cut word ${w}`);
  });
});
