// CLIENT-6 B (BUG-584) — which foods a cook step names, and what a prep step's own words did.

import assert from "node:assert/strict";
import { test } from "node:test";

import { foodOf, namedFoods, prepCovers, prepWorkWords } from "@/lib/cooking/prepFoods";

test("foodOf: the food, not its part or its descriptors", () => {
  assert.deepEqual(foodOf("garlic cloves"), { name: "garlic cloves", head: "garlic", before: null });
  assert.deepEqual(foodOf("celery stalks"), { name: "celery stalks", head: "celery", before: null });
  assert.equal(foodOf("ground beef (85% lean)")?.head, "beef");
  assert.equal(foodOf("fresh flat-leaf parsley")?.head, "parsley");
  assert.equal(foodOf("roma tomatoes")?.head, "tomato");
  assert.equal(foodOf("fresh thyme leaves")?.head, "thyme");
  // Ambiguous heads keep the word before them.
  assert.deepEqual(foodOf("yellow onion"), { name: "yellow onion", head: "onion", before: "yellow" });
  assert.deepEqual(foodOf("Kashmiri chili powder"), { name: "Kashmiri chili powder", head: "powder", before: "chili" });
  assert.equal(foodOf(""), null);
});

test("namedFoods: by head, so a step names more rather than less", () => {
  const names = namedFoods("Finely dice the yellow onion and mince the 2 garlic cloves.", ["yellow onion", "garlic cloves", "fresh ginger"]);
  assert.deepEqual(names.map((f) => f.head), ["onion", "garlic"]);
  assert.deepEqual(namedFoods("Season with salt and pepper.", ["Kosher salt", "black pepper", "yellow onion"]).map((f) => f.head), ["salt", "pepper"]);
});

test("namedFoods: another ingredient's own 'sesame oil' does not name the vegetable oil; a bare 'oil' names both", () => {
  const ings = ["sesame oil", "vegetable oil", "yellow onion", "diced white onion"];
  assert.deepEqual(namedFoods("Whisk in 1 teaspoon sesame oil.", ings).map((f) => f.name), ["sesame oil"]);
  assert.deepEqual(namedFoods("Heat the oil.", ings).map((f) => f.name), ["sesame oil", "vegetable oil"]);
  assert.deepEqual(namedFoods("Finely dice the yellow onion.", ings).map((f) => f.name), ["yellow onion"]);
  assert.deepEqual(namedFoods("Add the onion.", ings).map((f) => f.name), ["yellow onion", "diced white onion"]);
});

test("prepWorkWords: the title and each line's work, never where it goes", () => {
  const w = prepWorkWords({
    title: "Mince all garlic",
    instructions: "Mince 31 cloves of garlic.\nInto the Minced garlic tub: 5 cloves for the Creamy Beef and Mushroom Stroganoff\n3 cloves — into a small bowl for the Honey garlic sauce",
  });
  assert.ok(w.includes("garlic"));
  for (const gone of ["beef", "mushroom", "stroganoff", "honey", "sauce"]) assert.ok(!w.includes(gone), gone);
  assert.ok(prepWorkWords({ title: "Measure the Curry spices", instructions: "Get a small bowl for the Curry spices. Into the bowl:\n3¾ tsp ground cumin" }).includes("cumin"));
});

test("prepCovers: an ambiguous food needs its word before", () => {
  const onion = foodOf("yellow onion")!;
  assert.equal(prepCovers(prepWorkWords({ title: "Dice all yellow onions" }), onion), true);
  assert.equal(prepCovers(prepWorkWords({ title: "Slice the green onions" }), onion), false);
  assert.equal(prepCovers(prepWorkWords({ title: "Dice the onion" }), onion), false);
  assert.equal(prepCovers(prepWorkWords({ title: "Grate the ginger" }), foodOf("fresh ginger")!), true);
});
