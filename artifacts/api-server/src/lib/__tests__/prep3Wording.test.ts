// PREP-3 (R1, R2) — a weeknight's Cook Mode words, from what the cook ticked: a mix or a
// prepped cut named where a step uses it, a shared tub with the step's own amount, a
// prepped cut clause gone from a step that does more, a marinade named where it is used,
// a step Cook Mode collapses left as it is. The steps are the dumps' own (dump0).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rewordFeastSteps, weeknightCookWordingFor, type FeastDishFacts, type WordingStep } from "../feastCookWording";
import { deriveAmountRefs } from "../stepAmountRefs";
import { feastWordingFindings } from "../feastWordingWalk";
import { ingredientGroupKey } from "../ingredientRelations";

type Row = { ingredientId: string; name: string; quantity: number; unit: string };
const step = (i: number, text: string, rows: Row[]): WordingStep => ({ stepIndex: i, text, amountRefs: deriveAmountRefs(text, rows).amountRefs as never });
const words = (title: string, rows: Row[], facts: FeastDishFacts, texts: string[]) =>
  rewordFeastSteps(texts.map((t, i) => step(i, t, rows)), rows, facts, [title], { weeknight: true }).map((s) => s.text);
const cut = (id: string, name: string, into: string, note: string, kind: "own" | "shared" | "plate" | "mix") => ({ id, key: ingredientGroupKey(name), into, note, kind });
const mix = (name: string, rows: Row[]) => ({ name, ids: new Set(rows.map((r) => r.ingredientId)), keys: new Set(rows.map((r) => ingredientGroupKey(r.name))) });

describe("PREP-3 (R1) — a prepped cut leaves a step that does more", () => {
  it("Wednesday's eggs are beaten; the scallions are on Wednesday's plate", () => {
    const rows: Row[] = [{ ingredientId: "egg", name: "large eggs", quantity: 2, unit: "each" }, { ingredientId: "wp", name: "white pepper", quantity: 0.125, unit: "tsp" }, { ingredientId: "sc", name: "scallions", quantity: 1.5, unit: "each" }, { ingredientId: "gar", name: "garlic cloves", quantity: 1, unit: "clove" }];
    const out = words("Egg Fried Rice", rows, { dishId: "f", mixes: [], cuts: [cut("sc", "scallions", "Teriyaki plate", "thinly sliced, whites and greens separated", "plate"), cut("gar", "garlic cloves", "Minced garlic", "minced", "shared")] }, [
      "Lightly beat 2 large eggs with ⅛ teaspoon white pepper in a small bowl, and thinly slice 1½ scallions, keeping the whites and greens separated.",
      "Add 2 minced garlic cloves and the scallion whites and stir-fry for 30 seconds until fragrant.",
    ]);
    assert.equal(out[0], "Lightly beat 2 large eggs with ⅛ teaspoon white pepper in a small bowl.");
    // (R2) the shared tub keeps the step's amount; the whites are the scallions' own.
    assert.equal(out[1], "Add the minced garlic you prepped (2 cloves) and the scallion whites you prepped and stir-fry for 30 seconds until fragrant.");
  });

  it("the snap peas' strings are pulled; the sliced garlic is on the plate", () => {
    const rows: Row[] = [{ ingredientId: "sp", name: "fresh snap peas", quantity: 6, unit: "oz" }, { ingredientId: "gar", name: "garlic cloves", quantity: 1, unit: "clove" }];
    const out = words("Stir-Fried Snap Peas", rows, { dishId: "p", mixes: [], cuts: [cut("gar", "garlic cloves", "Teriyaki plate", "thinly sliced", "plate")] }, ["Pull the strings from 6 oz fresh snap peas and thinly slice 1 garlic clove."]);
    assert.equal(out[0], "Pull the strings from 6 oz fresh snap peas.");
  });

  it("\"Zest and juice\" is one clause: never \"Zest, then whisk…\"", () => {
    const rows: Row[] = [{ ingredientId: "lem", name: "lemon", quantity: 0.5, unit: "each" }, { ingredientId: "oil", name: "extra-virgin olive oil", quantity: 2, unit: "tbsp" }];
    const out = words("Lemon Vinaigrette", rows, { dishId: "v", mixes: [], cuts: [cut("lem", "lemon", "Lemon juice", "zested and juiced", "shared")] }, [
      "Zest and juice ½ lemon, then whisk the zest and juice with 2 tablespoons extra-virgin olive oil.",
    ]);
    assert.equal(out[0], "Whisk the zest and juice with 2 tablespoons extra-virgin olive oil.");
  });

  it("a list of cuts keeps the one not prepped, capitalised", () => {
    const rows: Row[] = [{ ingredientId: "gar", name: "garlic cloves", quantity: 4, unit: "clove" }, { ingredientId: "sh", name: "shallots", quantity: 3, unit: "each" }, { ingredientId: "go", name: "green onions", quantity: 4, unit: "each" }, { ingredientId: "pn", name: "roasted unsalted peanuts", quantity: 0.5, unit: "cup" }];
    const out = words("Tofu Pad Thai", rows, { dishId: "pt", mixes: [], cuts: [cut("gar", "garlic cloves", "Minced garlic", "minced", "shared"), cut("sh", "shallots", "Pad thai plate", "thinly sliced", "plate"), cut("go", "green onions", "Pad thai plate", "cut into 1-inch pieces", "plate")] }, [
      "Mince the 4 garlic cloves, thinly slice the 3 shallots, cut the 4 green onions into 1-inch pieces, and roughly chop the ½ cup peanuts.",
    ]);
    assert.equal(out[0], "Roughly chop the ½ cup peanuts.");
  });
});

describe("PREP-3 (R1, R2, R4) — mixes and tubs named where they are used", () => {
  const lp: Row[] = [
    { ingredientId: "lem", name: "lemon", quantity: 1, unit: "each" }, { ingredientId: "oil", name: "olive oil", quantity: 3, unit: "tbsp" },
    { ingredientId: "pep", name: "coarsely cracked black pepper", quantity: 1.5, unit: "tsp" }, { ingredientId: "gp", name: "garlic powder", quantity: 1, unit: "tsp" },
    { ingredientId: "op", name: "onion powder", quantity: 0.5, unit: "tsp" }, { ingredientId: "salt", name: "kosher salt", quantity: 1, unit: "tsp" }, { ingredientId: "thy", name: "fresh thyme leaves", quantity: 1, unit: "tsp" },
  ];
  const marinade = [
    "Zest and juice 1 lemon, then whisk together the zest, juice, 3 tablespoons olive oil, 1½ teaspoons cracked black pepper, 1 teaspoon garlic powder, ½ teaspoon onion powder, 1 teaspoon kosher salt, and 1 teaspoon fresh thyme leaves into a marinade.",
    "Coat the chicken breasts evenly in the marinade and let sit at room temperature for 10 minutes.",
  ];
  const facts = (covered: number[]): FeastDishFacts => ({ dishId: "c", covered: new Set(covered), mixes: [mix("Lemon pepper marinade", lp)], cuts: [cut("lem", "lemon", "Lemon pepper marinade", "1 zested and juiced", "mix"), cut("thy", "fresh thyme leaves", "Lemon pepper marinade", "", "mix")] });

  it("\"Coat the chicken … in the Lemon pepper marinade\"; the step Cook Mode collapses keeps its words", () => {
    const out = words("Grilled Lemon Pepper Chicken Breasts", lp, facts([0]), marinade);
    assert.equal(out[0], marinade[0]);
    assert.equal(out[1], "Coat the chicken breasts evenly in the Lemon pepper marinade and let sit at room temperature for 10 minutes.");
  });

  it("\"the marinade bowl\" is the Lemon pepper marinade too", () => {
    const out = words("Grilled Lemon Pepper Chicken Breasts", lp, facts([0]), [marinade[0], "Add the chicken to the marinade bowl, tossing well to coat."]);
    assert.equal(out[1], "Add the chicken to the Lemon pepper marinade, tossing well to coat.");
  });

  it("a list's \"and\" stays the list's: \"…olives, and the red onion you prepped\", never \"the and red onion\"", () => {
    const rows: Row[] = [{ ingredientId: "rom", name: "romaine lettuce", quantity: 4, unit: "cup" }, { ingredientId: "ct", name: "cherry tomatoes", quantity: 1, unit: "cup" }, { ingredientId: "ol", name: "kalamata olives", quantity: 0.33, unit: "cup" }, { ingredientId: "ro", name: "red onion", quantity: 0.25, unit: "each" }];
    const out = words("Greek Salad", rows, { dishId: "g", mixes: [], cuts: [cut("ct", "cherry tomatoes", "Skewers plate", "halved", "plate"), cut("ro", "red onion", "Skewers plate", "thinly sliced", "plate")] }, [
      "Combine the romaine, cherry tomatoes, ⅓ cup Kalamata olives, and red onion in a large salad bowl.",
    ]);
    assert.doesNotMatch(out[0], /the and/);
    assert.match(out[0], /⅓ cup Kalamata olives, and the red onion you prepped in a large salad bowl\./);
  });

  it("Tuesday's spices are named at the step that measured them; the salt and pepper stay", () => {
    const taco: Row[] = [{ ingredientId: "cp", name: "chili powder", quantity: 1.5, unit: "tsp" }, { ingredientId: "cu", name: "ground cumin", quantity: 1, unit: "tsp" }, { ingredientId: "pa", name: "smoked paprika", quantity: 0.5, unit: "tsp" }, { ingredientId: "or", name: "dried oregano", quantity: 0.5, unit: "tsp" }, { ingredientId: "salt", name: "kosher salt", quantity: 0.75, unit: "tsp" }, { ingredientId: "pep", name: "black pepper", quantity: 0.25, unit: "tsp" }];
    const out = words("Green Chile Ground Beef Taco Filling", taco, { dishId: "tf", mixes: [mix("Taco spices", taco.slice(0, 4))], cuts: [] }, [
      "In a small bowl, combine 1½ teaspoons chili powder, 1 teaspoon cumin, ½ teaspoon smoked paprika, ½ teaspoon dried oregano, ¾ teaspoon kosher salt, and ¼ teaspoon black pepper.",
    ]);
    assert.equal(out[0], "In a small bowl, combine the Taco spices, ¾ teaspoon kosher salt, and ¼ teaspoon black pepper.");
  });

  it("the tzatziki's own bowl by its foods (it is named for the dish), the shared garlic and lemon with their amounts, and no \"the squeezed the cucumber\"", () => {
    const tz: Row[] = [{ ingredientId: "yog", name: "full-fat greek yogurt", quantity: 1, unit: "cup" }, { ingredientId: "cuc", name: "english cucumber", quantity: 0.5, unit: "each" }, { ingredientId: "gar", name: "garlic cloves", quantity: 2, unit: "clove" }, { ingredientId: "dill", name: "fresh dill", quantity: 2, unit: "tbsp" }, { ingredientId: "lj", name: "fresh lemon juice", quantity: 1, unit: "tbsp" }, { ingredientId: "oil", name: "extra-virgin olive oil", quantity: 1, unit: "tbsp" }];
    const out = words("Tzatziki", tz, { dishId: "t", mixes: [], cuts: [cut("cuc", "english cucumber", "Tzatziki", "grated and squeezed dry", "own"), cut("gar", "garlic cloves", "Minced garlic", "minced", "shared"), cut("dill", "fresh dill", "Tzatziki", "finely chopped", "own"), cut("lj", "fresh lemon juice", "Lemon juice", "freshly squeezed juice", "shared")] }, [
      "Stir together 1 cup full-fat Greek yogurt, the squeezed cucumber, 2 minced garlic cloves, 2 tablespoons finely chopped fresh dill, 1 tablespoon lemon juice, 1 tablespoon olive oil, and ¼ teaspoon kosher salt until fully combined.",
    ]);
    assert.equal(out[0], "Stir together 1 cup full-fat Greek yogurt, the squeezed cucumber you prepped, the minced garlic you prepped (2 cloves), the finely chopped dill you prepped, the lemon juice you prepped (1 tablespoon), 1 tablespoon olive oil, and ¼ teaspoon kosher salt until fully combined.");
  });

  // hh4-mixed, dump1 (ticked).
  it("a bowl named for the dish being cooked is said by its foods: never \"Fold in the Guacamole you prepped\"", () => {
    const g: Row[] = [{ ingredientId: "ro", name: "red onion", quantity: 0.25, unit: "cup" }, { ingredientId: "ja", name: "jalapeño", quantity: 1, unit: "each" }, { ingredientId: "ci", name: "fresh cilantro", quantity: 3, unit: "tbsp" }, { ingredientId: "salt", name: "kosher salt", quantity: 0.5, unit: "tsp" }];
    const out = words("Chunky Guacamole", g, { dishId: "g", mixes: [], cuts: [cut("ro", "red onion", "Guacamole", "finely diced", "own"), cut("ja", "jalapeño", "Guacamole", "seeded and minced", "own"), cut("ci", "fresh cilantro", "Guacamole", "finely chopped", "own")] }, [
      "Fold in the red onion, jalapeño, cilantro, and ½ teaspoon kosher salt; taste and adjust salt or lime as needed.",
    ]);
    assert.equal(out[0], "Fold in the red onion, jalapeño and cilantro you prepped and ½ teaspoon kosher salt; taste and adjust salt or lime as needed.");
  });

  it("\"fresh lemon juice\" is the lemon juice prepped into the Caesar sauce: it goes in once", () => {
    const c: Row[] = [{ ingredientId: "yolk", name: "egg yolks", quantity: 1, unit: "each" }, { ingredientId: "lj", name: "fresh lemon juice", quantity: 2, unit: "tbsp" }, { ingredientId: "dij", name: "dijon mustard", quantity: 1, unit: "tsp" }, { ingredientId: "wor", name: "worcestershire sauce", quantity: 0.5, unit: "tsp" }];
    // (The combine groups the two lemon rows under one id: the cut's is the group's.)
    const out = words("Crisp Caesar Salad", c, { dishId: "c", mixes: [mix("Caesar sauce", c.slice(2))], cuts: [cut("grp", "lemon juice", "Caesar sauce", " freshly squeezed juice", "mix")] }, [
      "Whisk together the anchovy-garlic paste, 1 egg yolk, 2 tablespoons fresh lemon juice, 1 teaspoon Dijon mustard, and ½ teaspoon Worcestershire sauce in a medium bowl until combined.",
    ]);
    assert.doesNotMatch(out[0], /lemon/, out[0]);
    assert.match(out[0], /the Caesar sauce/);
  });

  it("the cuts gone, the step that stirs \"both\" names them, a shared tub's amount kept", () => {
    const s: Row[] = [{ ingredientId: "gar", name: "garlic", quantity: 4, unit: "clove" }, { ingredientId: "par", name: "fresh flat-leaf parsley", quantity: 2, unit: "tbsp" }, { ingredientId: "but", name: "unsalted butter", quantity: 3, unit: "tbsp" }, { ingredientId: "salt", name: "kosher salt", quantity: 1, unit: "tsp" }];
    const out = words("Garlic Butter Grilled Salmon", s, { dishId: "s", mixes: [], cuts: [cut("gar", "garlic", "Minced garlic", "minced", "shared"), cut("par", "fresh flat-leaf parsley", "Chopped flat-leaf parsley", "finely chopped", "shared")] }, [
      "Mince 4 garlic cloves and finely chop 2 tablespoons flat-leaf parsley, then stir both into 3 tablespoons melted unsalted butter with 1 teaspoon kosher salt to make the basting butter.",
    ]);
    assert.equal(out[0], "Stir the minced garlic (4 cloves) and chopped flat-leaf parsley (2 tablespoons) you prepped into 3 tablespoons melted unsalted butter with 1 teaspoon kosher salt to make the basting butter.");
  });

  it("\"2 tablespoons hoisin sauce\" is the hoisin, not the soy sauce a list item before: General Tso's sauce is named", () => {
    const t: Row[] = [{ ingredientId: "soy", name: "soy sauce", quantity: 3, unit: "tbsp" }, { ingredientId: "hoi", name: "hoisin sauce", quantity: 2, unit: "tbsp" }, { ingredientId: "rv", name: "rice vinegar", quantity: 2, unit: "tbsp" }, { ingredientId: "br", name: "chicken broth", quantity: 0.25, unit: "cup" }];
    const out = words("Extra-Crispy General Tso's Chicken", t, { dishId: "t", mixes: [mix("Tso's sauce", [t[0], t[1], t[2]])], cuts: [] }, [
      "Whisk together 3 tablespoons soy sauce, 2 tablespoons hoisin sauce, 2 tablespoons rice vinegar, and ¼ cup chicken broth in a small bowl; set aside.",
    ]);
    assert.equal(out[0], "Whisk together the Tso's sauce and ¼ cup chicken broth in a small bowl; set aside.");
  });

  it("a mix enters where its first member is stated (the breadcrumbs soak), and a member restated after it goes", () => {
    const mb: Row[] = [{ ingredientId: "bc", name: "plain breadcrumbs", quantity: 0.5, unit: "cup" }, { ingredientId: "milk", name: "whole milk", quantity: 0.25, unit: "cup" }, { ingredientId: "beef", name: "ground beef", quantity: 0.75, unit: "lb" }, { ingredientId: "salt", name: "kosher salt", quantity: 1, unit: "tsp" }, { ingredientId: "or", name: "dried oregano", quantity: 0.5, unit: "tsp" }, { ingredientId: "rpf", name: "red pepper flakes", quantity: 0.25, unit: "tsp" }];
    const dry = { ...mix("Meatballs dry mix", [mb[0], mb[4], mb[5]]), amounts: new Map([["plain breadcrumbs", { qty: 0.5, unit: "cup" }], ["dried oregano", { qty: 0.5, unit: "teaspoon" }], ["red pepper flakes", { qty: 0.25, unit: "teaspoon" }]]) };
    const out = words("Beef and Pork Meatballs in Marinara", mb, { dishId: "mb", mixes: [dry], cuts: [] }, [
      "Combine ½ cup plain breadcrumbs and ¼ cup whole milk in a large bowl and let soak for 2 minutes.",
      "Add ¾ pound ground beef, 1 teaspoon kosher salt, ½ teaspoon dried oregano, and ¼ teaspoon red pepper flakes to the soaked breadcrumbs and mix gently.",
    ]);
    assert.equal(out[0], "Combine the Meatballs dry mix and ¼ cup whole milk in a large bowl and let soak for 2 minutes.");
    assert.equal(out[1], "Add ¾ pound ground beef and 1 teaspoon kosher salt to the soaked breadcrumbs and mix gently.");
    // …a second portion (another amount) is the step's own: it stays.
    const twice = words("Beef and Pork Meatballs in Marinara", mb, { dishId: "mb", mixes: [dry], cuts: [] }, [
      "Combine ½ cup plain breadcrumbs and ¼ cup whole milk in a large bowl and let soak for 2 minutes.",
      "Add ¾ pound ground beef, ½ teaspoon dried oregano, and ¼ teaspoon red pepper flakes to the soaked breadcrumbs.",
      "Scatter 2 tablespoons plain breadcrumbs over the top.",
    ]);
    assert.equal(twice[2], "Scatter 2 tablespoons plain breadcrumbs over the top.");
    // …and a step with nothing else is left as written, never "Stir in into the sauce."
    const alone = words("Beef and Pork Meatballs in Marinara", mb, { dishId: "mb", mixes: [dry], cuts: [] }, [
      "Combine ½ cup plain breadcrumbs and ¼ cup whole milk in a large bowl and let soak for 2 minutes.",
      "Add ¾ pound ground beef, ½ teaspoon dried oregano, and ¼ teaspoon red pepper flakes to the soaked breadcrumbs.",
      "Stir ¼ teaspoon red pepper flakes into the sauce.",
    ]);
    assert.equal(alone[1], "Add ¾ pound ground beef to the soaked breadcrumbs.");
    assert.equal(alone[2], "Stir ¼ teaspoon red pepper flakes into the sauce.");
  });

  it("bite-sized florets are a cut; a measure of what the ticked mix holds goes; a long clause with no row is a clause", () => {
    const b: Row[] = [{ ingredientId: "bro", name: "broccoli florets", quantity: 1, unit: "lb" }, { ingredientId: "soy", name: "soy sauce", quantity: 1, unit: "tbsp" }, { ingredientId: "w", name: "water", quantity: 2, unit: "tbsp" }];
    const out = words("Stir-Fried Broccoli with Garlic", b, { dishId: "b", mixes: [], cuts: [cut("bro", "broccoli florets", "Broccoli & garlic", "cut into bite-sized pieces", "own")] }, [
      "Cut 1 pound broccoli into bite-sized florets; stir together 1 tablespoon soy sauce and 2 tablespoons water in a small bowl.",
    ]);
    assert.equal(out[0], "Stir together 1 tablespoon soy sauce and 2 tablespoons water in a small bowl.");
    const cr: Row[] = [{ ingredientId: "chi", name: "chipotle peppers in adobo sauce", quantity: 2, unit: "each" }, { ingredientId: "ado", name: "adobo sauce", quantity: 1, unit: "tbsp" }, { ingredientId: "gp", name: "garlic powder", quantity: 0.25, unit: "tsp" }];
    const out2 = words("Chipotle Crema", cr, { dishId: "cr", mixes: [mix("Chipotle crema sauce", cr.slice(1))], cuts: [] }, [
      "Mince 2 chipotle peppers in adobo to a smooth paste and measure 1 tablespoon adobo sauce from the can.",
    ]);
    assert.equal(out2[0], "Mince 2 chipotle peppers in adobo to a smooth paste.");
  });

  // hh4-mixed Tuesday #1 (3c): labelled "Chipotle crema" — the dish's own name — the jar was
  // read as the dish being made and never said: "…, the chipotle paste, the lime juice you prepped, …".
  it("a sauce dish's jar is said by its label, the lime juice prepped into it with it", () => {
    const cr: Row[] = [{ ingredientId: "chi", name: "chipotle peppers in adobo sauce", quantity: 2, unit: "each" }, { ingredientId: "ado", name: "adobo sauce", quantity: 1, unit: "tbsp" }, { ingredientId: "gp", name: "garlic powder", quantity: 0.25, unit: "tsp" }, { ingredientId: "lj", name: "lime juice", quantity: 1, unit: "tbsp" }];
    const jar = { ...mix("Chipotle crema sauce", [cr[1], cr[2]]), amounts: new Map([["adobo sauce", { qty: 1, unit: "tbsp" }], ["garlic powder", { qty: 0.25, unit: "tsp" }]]) };
    const out = words("Chipotle Crema", cr, { dishId: "cr", mixes: [jar], cuts: [{ ...cut("lj", "lime juice", "Chipotle crema sauce", "freshly squeezed juice", "mix"), amount: "1 tbsp" }] }, [
      "Mince 2 chipotle peppers in adobo to a smooth paste and measure 1 tablespoon adobo sauce from the can.",
      "In a small bowl, whisk together ¾ cup sour cream, the chipotle paste, 1 tablespoon adobo sauce, 1 tablespoon lime juice, ¼ teaspoon garlic powder, and ¼ teaspoon kosher salt until smooth.",
    ]);
    assert.equal(out[1], "In a small bowl, whisk together ¾ cup sour cream, the chipotle paste, the Chipotle crema sauce you prepped, and ¼ teaspoon kosher salt until smooth.");
  });
});

describe("PREP-3 (R1) — the words come from what the cook ticked", () => {
  it("a weeknight plan with nothing ticked keeps every stored word (and reads no week)", async () => {
    let loaded = false;
    const prisma = {
      prepStepCompletion: { findMany: async () => [] },
      mealPlanInstance: { findUnique: async () => { loaded = true; return null; } },
    };
    const out = await weeknightCookWordingFor(prisma as never, { planId: "p", userId: "u", mealTags: [], dishes: [{ dishId: "d", title: "Tacos", steps: [{ stepIndex: 0, text: "In a small bowl, combine 1 teaspoon cumin." }] }] });
    assert.equal(out.size, 0);
    assert.equal(loaded, false);
  });

  it("a feast is never worded here (feastCookWordingFor's)", async () => {
    const out = await weeknightCookWordingFor({} as never, { planId: "p", userId: "u", mealTags: ["thanksgiving-feast"], prepped: true, dishes: [{ dishId: "d", title: "Turkey", steps: [] }] });
    assert.equal(out.size, 0);
  });
});

describe("PREP-3 3b (A) — a partly covered step never cuts again what prep cut", () => {
  const sk: Row[] = [{ ingredientId: "thi", name: "boneless skinless chicken thighs", quantity: 2, unit: "lb" }, { ingredientId: "ro", name: "red onion", quantity: 1, unit: "each" }, { ingredientId: "skw", name: "wooden or metal skewers", quantity: 8, unit: "each" }];
  const skFacts: FeastDishFacts = {
    dishId: "sk", mixes: [], cuts: [cut("ro", "red onion", "Skewers plate", "cut into 1½-inch chunks, for threading", "plate")],
    proteins: [{ id: "thi", key: ingredientGroupKey("boneless skinless chicken thighs"), into: "Skewers chicken", note: "cut into 1½-inch chunks", amount: "2 lb" }],
  };
  it("Monday #3: the chicken chunks cut in Proteins go into the marinade", () => {
    const out = words("Lemon-Herb Marinated Chicken Skewers", sk, skFacts, ["Cut the 2 pounds of chicken thighs into 1½-inch chunks and add them to the marinade bowl, tossing well to coat; cover and refrigerate for at least 20 minutes (up to 2 hours)."]);
    assert.equal(out[0], "Add the chicken chunks you prepped (2 pounds) to the marinade bowl, tossing well to coat; cover and refrigerate for at least 20 minutes (up to 2 hours).");
  });
  it("Monday #7: the red onion chunks on the Skewers plate are threaded, never cut", () => {
    const out = words("Lemon-Herb Marinated Chicken Skewers", sk, skFacts, ["Cut the red onion into 1½-inch chunks and thread the chicken and onion pieces alternately onto the 8 skewers."]);
    assert.equal(out[0], "Thread the chicken and the red onion chunks you prepped alternately onto the 8 skewers.");
  });
  it("a cut to another shape is the step's own: \"cut into strips\" stays", () => {
    const out = words("Lemon-Herb Marinated Chicken Skewers", sk, skFacts, ["Cut the red onion into thin strips and thread the chicken and onion pieces alternately onto the 8 skewers."]);
    assert.equal(out[0], "Cut the red onion into thin strips and thread the chicken and onion pieces alternately onto the 8 skewers.");
  });
  const cz: Row[] = [{ ingredientId: "gar", name: "garlic", quantity: 1, unit: "clove" }, { ingredientId: "anc", name: "anchovy fillets in oil", quantity: 4, unit: "each" }];
  const czFacts: FeastDishFacts = { dishId: "cz", mixes: [], cuts: [cut("gar", "garlic", "Salmon plate", "halved, for rubbing croutons minced", "plate"), cut("gar", "garlic", "Minced garlic", "minced to a paste for dressing minced", "shared")] };
  it("Thursday #3: the minced garlic in the shared tub is mashed with the anchovies", () => {
    const out = words("Crisp Caesar Salad with Homemade Croutons", cz, czFacts, ["Mince 1 garlic clove to a fine paste, then mash 4 drained anchovy fillets into the paste using the flat of a knife until a smooth paste forms."]);
    assert.equal(out[0], "Mash the minced garlic you prepped (1 clove) and 4 drained anchovy fillets together using the flat of a knife until a smooth paste forms.");
  });
  it("count agreement: a share Cook Mode shows as 1 reads \"(1 clove)\", never \"(1 cloves)\"", () => {
    const rows: Row[] = [{ ingredientId: "gar", name: "garlic cloves", quantity: 2, unit: "clove" }, { ingredientId: "sc", name: "scallions", quantity: 1, unit: "each" }];
    const facts: FeastDishFacts = { dishId: "f", mixes: [], cuts: [cut("gar", "garlic cloves", "Minced garlic", "minced", "shared")] };
    const text = "Add 2 minced garlic cloves and 1 scallion and stir-fry for 30 seconds until fragrant.";
    const half = rewordFeastSteps([step(0, text, rows)], rows, facts, ["Egg Fried Rice"], { weeknight: true, countOf: (r) => r.quantity * 0.5 })[0].text;
    assert.equal(half, "Add the minced garlic you prepped (2 clove) and 1 scallion and stir-fry for 30 seconds until fragrant.");
    const whole = rewordFeastSteps([step(0, text, rows)], rows, facts, ["Egg Fried Rice"], { weeknight: true })[0].text;
    assert.equal(whole, "Add the minced garlic you prepped (2 cloves) and 1 scallion and stir-fry for 30 seconds until fragrant.");
  });
  it("Monday #14: a shared tub's member named without an amount takes the tub's share", () => {
    const rows: Row[] = [{ ingredientId: "rom", name: "romaine lettuce", quantity: 4, unit: "cup" }, { ingredientId: "ct", name: "cherry tomatoes", quantity: 1, unit: "cup" }, { ingredientId: "kal", name: "kalamata olives", quantity: 0.33, unit: "cup" }];
    const facts: FeastDishFacts = { dishId: "g", mixes: [], cuts: [{ ...cut("rom", "romaine lettuce", "Chopped romaine lettuce", "roughly chopped", "shared"), amount: "4 cups" }, cut("ct", "cherry tomatoes", "Skewers plate", "halved", "plate")] };
    const out = words("Greek Salad with Warm Pita", rows, facts, ["Combine the romaine, cherry tomatoes, ⅓ cup Kalamata olives in a large salad bowl."]);
    assert.equal(out[0], "Combine the chopped romaine lettuce you prepped (4 cups), the cherry tomatoes you prepped, ⅓ cup Kalamata olives in a large salad bowl.");
  });
});

describe("PREP-3 3b (A5) — the wording walk's three weeknight shapes", () => {
  it("dump1's misses are found (protein, recut, bare) and 3b's words are clean", () => {
    const rows = [
      { ingredientId: "thi", name: "boneless skinless chicken thighs", quantity: 2, unit: "lb" }, { ingredientId: "ro", name: "red onion", quantity: 1, unit: "each" },
      { ingredientId: "gar", name: "garlic", quantity: 1, unit: "clove" }, { ingredientId: "rom", name: "romaine lettuce", quantity: 4, unit: "cup" }, { ingredientId: "kal", name: "kalamata olives", quantity: 0.33, unit: "cup" },
    ];
    const facts: FeastDishFacts = {
      dishId: "m", mixes: [],
      cuts: [cut("ro", "red onion", "Skewers plate", "cut into 1½-inch chunks, for threading", "plate"), cut("gar", "garlic", "Minced garlic", "minced to a paste for dressing minced", "shared"), { ...cut("rom", "romaine lettuce", "Chopped romaine lettuce", "roughly chopped", "shared"), amount: "4 cups" }],
      proteins: [{ id: "thi", key: ingredientGroupKey("boneless skinless chicken thighs"), into: "Skewers chicken", note: "cut into 1½-inch chunks", amount: "2 lb" }],
    };
    const texts = [
      "Cut the 2 pounds of chicken thighs into 1½-inch chunks and add them to the marinade bowl, tossing well to coat.",
      "Cut the red onion into 1½-inch chunks and thread the chicken and onion pieces alternately onto the 8 skewers.",
      "Mince 1 garlic clove to a fine paste, then mash 4 drained anchovy fillets into the paste using the flat of a knife.",
      "Combine the romaine, ⅓ cup Kalamata olives in a large salad bowl.",
      "Slice the chicken thinly and serve.",
    ];
    const before = texts.map((t, i) => step(i, t, rows));
    const kinds = (ss: WordingStep[]) => feastWordingFindings(ss, rows, facts, ["Skewers"], { weeknight: true }).filter((f) => f.kind !== "loose" && f.kind !== "double").map((f) => `${f.stepIndex}:${f.kind}`);
    // (#4 slices the cooked chicken: Proteins cut it into chunks, never sliced it.)
    assert.deepEqual(kinds(before), ["0:protein", "1:recut", "2:recut", "3:bare"]);
    assert.deepEqual(kinds(rewordFeastSteps(before, rows, facts, ["Skewers"], { weeknight: true })), []);
  });

  // 3c — 93d49a0f's Tzatziki #1, its bowl labelled "Tzatziki" and said by its foods.
  it("a group of foods said as prepped is not loose; a list with an amount in it still is", () => {
    const rows = [
      { ingredientId: "yog", name: "full-fat greek yogurt", quantity: 1, unit: "cup" }, { ingredientId: "cuc", name: "english cucumber", quantity: 0.5, unit: "each" },
      { ingredientId: "gar", name: "garlic", quantity: 1, unit: "clove" }, { ingredientId: "dill", name: "fresh dill", quantity: 1, unit: "tbsp" },
      { ingredientId: "lj", name: "lemon juice", quantity: 1, unit: "tbsp" }, { ingredientId: "oil", name: "olive oil", quantity: 1, unit: "tbsp" },
    ];
    const facts: FeastDishFacts = { dishId: "t", mixes: [], cuts: [cut("cuc", "english cucumber", "Tzatziki", "grated and squeezed", "own"), cut("gar", "garlic", "Tzatziki", "finely minced", "own"), cut("dill", "fresh dill", "Tzatziki", "chopped", "own"), cut("lj", "lemon juice", "Lemon juice", "freshly squeezed juice", "shared")] };
    const loose = (t: string) => feastWordingFindings([step(1, t, rows)], rows, facts, ["Tzatziki"], { weeknight: true }).filter((f) => f.kind === "loose").length;
    assert.equal(loose("In a bowl, combine 1 cup full-fat Greek yogurt, the squeezed cucumber, finely minced garlic and chopped dill you prepped, the lemon juice you prepped (1 tablespoon), 1 tablespoon olive oil, and ¼ teaspoon kosher salt; stir well."), 0);
    assert.equal(loose("In a bowl, combine the squeezed cucumber, 1 tablespoon chopped dill and minced garlic you prepped."), 3);
  });
});

describe("PREP-3 3b (A) — the walk's catalog misses", () => {
  it("a shared-tub food a step adds is the tub's, measured or not (R2, every member)", () => {
    const rows: Row[] = [{ ingredientId: "gar", name: "garlic", quantity: 2, unit: "clove" }, { ingredientId: "bu", name: "unsalted butter", quantity: 1, unit: "tbsp" }];
    const facts: FeastDishFacts = { dishId: "r", mixes: [], cuts: [{ ...cut("gar", "garlic", "Minced garlic", "minced", "shared"), amount: "2 cloves" }] };
    const out = words("Garlic Herb Rice", rows, facts, ["Melt 1 tablespoon unsalted butter in a medium saucepan over medium heat, add the minced garlic, and sauté 1 minute until fragrant."]);
    assert.equal(out[0], "Melt 1 tablespoon unsalted butter in a medium saucepan over medium heat, add the minced garlic you prepped (2 cloves), and sauté 1 minute until fragrant.");
  });
  it("a verb whose object was the dropped cut takes it: \"and add to the bowl\"", () => {
    const rows: Row[] = [{ ingredientId: "jal", name: "jalapeño", quantity: 1, unit: "each" }];
    const out = words("Radish and Cabbage Slaw", rows, { dishId: "s", mixes: [], cuts: [cut("jal", "jalapeño", "Tacos plate", "thinly sliced, seeded", "plate")] }, ["Thinly slice the jalapeño, removing the seeds for less heat, and add to the bowl (optional)."]);
    assert.equal(out[0], "Add the sliced jalapeño you prepped to the bowl (optional).");
  });
  it("\"the 4 bacon slices\" are not sliced: the bacon cut in Proteins leaves the step", () => {
    const rows: Row[] = [{ ingredientId: "bac", name: "bacon", quantity: 4, unit: "slice" }, { ingredientId: "pot", name: "russet potatoes", quantity: 1.25, unit: "lb" }];
    const facts: FeastDishFacts = { dishId: "z", mixes: [], cuts: [], proteins: [{ id: "bac", key: ingredientGroupKey("bacon"), into: "Tuesday bacon", note: "cut into 1/2-inch pieces", amount: "4 slices" }] };
    const out = words("Zuppa Toscana", rows, facts, ["Cut the 4 bacon slices into ½-inch pieces, and halve then slice the 1¼ lb russet potatoes ¼-inch thick."]);
    assert.equal(out[0], "Halve then slice the 1¼ lb russet potatoes ¼-inch thick.");
  });
  it("\"and set aside\" stays with its own clause: the next clause's cut can still leave", () => {
    const rows: Row[] = [{ ingredientId: "tk", name: "boneless skinless turkey breast", quantity: 3, unit: "cup" }, { ingredientId: "on", name: "yellow onion", quantity: 1, unit: "each" }];
    const out = words("Classic Turkey Pot Pie", rows, { dishId: "t", mixes: [], cuts: [cut("on", "yellow onion", "Turkey vegetables", "finely diced", "own")] }, ["Shred 3 cups of rotisserie chicken or turkey breast and set aside; finely dice the yellow onion."]);
    assert.equal(out[0], "Shred 3 cups of rotisserie chicken or turkey breast and set aside.");
  });
  it("\"Thinly slice\" is never the pepperoni slices", () => {
    const rows: Row[] = [{ ingredientId: "pep", name: "pepperoni slices", quantity: 3, unit: "oz" }, { ingredientId: "mu", name: "cremini mushrooms", quantity: 6, unit: "oz" }, { ingredientId: "moz", name: "low-moisture whole-milk mozzarella", quantity: 10, unit: "oz" }];
    const out = words("Pepperoni and Mushroom Pizza", rows, { dishId: "p", mixes: [], cuts: [cut("mu", "cremini mushrooms", "Pizza vegetables", "thinly sliced", "own")] }, ["Thinly slice the 6 oz cremini mushrooms; shred the 10 oz mozzarella if not pre-shredded."]);
    assert.equal(out[0], "Shred the 10 oz mozzarella if not pre-shredded.");
  });
});
