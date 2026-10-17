// FIX-2 (BUG-058 / D-WS9-102) — the Swap for Similar pool and its form
// pre-filter (lib/similar/swapPool.ts, lib/similar/dishForm.ts). Pure: no
// database, no AI. The fixtures are real dev catalog titles.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assembleSwapPool,
  preFilterByForm,
  toCandidate,
  type SwapPoolMealRow,
} from "../similar/swapPool";
import { dishFormProfile, formScore, isSameDish } from "../similar/dishForm";

let seq = 0;
function row(
  title: string,
  opts: { id?: string; dishes?: string[]; sides?: string[]; cuisine?: string; userId?: string | null; fork?: string } = {},
): SwapPoolMealRow {
  const id = opts.id ?? `m-${++seq}`;
  const links = [
    ...(opts.dishes ?? [title]).map((t, i) => ({ roleLabel: "main" as const, positionIndex: i, dish: { title: t } })),
    ...(opts.sides ?? []).map((t, i) => ({ roleLabel: "side" as const, positionIndex: 10 + i, dish: { title: t } })),
  ];
  return {
    id,
    title,
    cuisineType: opts.cuisine ?? "American",
    tags: [],
    userId: opts.userId ?? null,
    isPublic: opts.userId ? false : true,
    mealType: "dinner",
    sourceStoreMealId: opts.fork ?? null,
    dishLinks: links,
  } as SwapPoolMealRow;
}

const titles = (cs: { row: { title: string } }[]) => cs.map((c) => c.row.title);

describe("swap pool — exclusions (the plan's own meals never come back)", () => {
  const source = row("Chicken Piccata with Lemon-Caper Sauce and Angel Hair Pasta", { id: "fork-src", userId: "u1", fork: "cat-piccata" });
  const catalog = [
    row("Chicken Piccata with Lemon-Caper Sauce and Angel Hair Pasta", { id: "cat-piccata" }),
    row("Crispy Baked Chicken Parmesan with Spaghetti and Garlic Green Beans", { id: "cat-parm" }),
    row("Pesto Pasta with Cherry Tomatoes and Mozzarella", { id: "cat-pesto" }),
    row("Chicken Piccata with Creamy Polenta", { id: "cat-piccata-2" }),
    row("Chicken Francese with Angel Hair Pasta", { id: "cat-francese" }),
    row("Chicken Parmesan Pasta", { id: "cat-parm-pasta" }),
    row("Pork Milanese with Arugula, Lemon, and Shaved Parmesan", { id: "cat-milanese" }),
  ];
  // The plan: the source plus forks of parm and pesto (every plan meal is a fork).
  const planMeals = [
    { id: "fork-src", title: source.title, sourceStoreMealId: "cat-piccata" },
    { id: "fork-parm", title: "Crispy Baked Chicken Parmesan with Spaghetti and Garlic Green Beans", sourceStoreMealId: "cat-parm" },
    { id: "fork-pesto", title: "Pesto Pasta with Cherry Tomatoes and Mozzarella", sourceStoreMealId: "cat-pesto" },
  ];
  const userRows = [
    source,
    row(planMeals[1].title, { id: "fork-parm", userId: "u1", fork: "cat-parm" }),
    row(planMeals[2].title, { id: "fork-pesto", userId: "u1", fork: "cat-pesto" }),
    row("Grandma's Breaded Pork Cutlets", { id: "own-cutlets", userId: "u1" }),
  ];
  const pool = assembleSwapPool({ source, planMeals, catalogRows: catalog, userRows });
  const ids = new Set(pool.map((c) => c.row.id));

  it("drops the source, its catalog original, and every plan meal by id and by lineage", () => {
    for (const id of ["fork-src", "cat-piccata", "fork-parm", "cat-parm", "fork-pesto", "cat-pesto"]) {
      assert.equal(ids.has(id), false, `${id} must not be in the pool`);
    }
  });

  it("drops another version of the source or of a plan meal (same dish, other sides)", () => {
    assert.equal(ids.has("cat-piccata-2"), false, "Chicken Piccata with Creamy Polenta is the source dish");
    assert.equal(ids.has("cat-parm-pasta"), false, "Chicken Parmesan Pasta is a version of the plan's chicken parm");
  });

  it("keeps different meals of the same form, and the user's own non-fork meal", () => {
    for (const id of ["cat-francese", "cat-milanese", "own-cutlets"]) assert.ok(ids.has(id), `${id} kept`);
  });
});

describe("swap pool — fork folding and duplicates", () => {
  it("folds a fork onto its catalog meal (one row, the catalog one)", () => {
    const source = row("Slow-Cooker Chicken and Dumplings", { id: "src" });
    const pool = assembleSwapPool({
      source,
      planMeals: [],
      catalogRows: [row("Classic Chicken Pot Pie", { id: "cat-pie" })],
      userRows: [row("Classic Chicken Pot Pie", { id: "fork-pie", userId: "u1", fork: "cat-pie" })],
    });
    assert.deepEqual(pool.map((c) => c.row.id), ["cat-pie"]);
  });

  it("the shortlist holds one row per title and per dish (no five Al Pastor tacos)", () => {
    const source = toCandidate(row("Chicken Tinga Tacos with Rice", { id: "src", cuisine: "Mexican" }));
    const pool = [
      row("Al Pastor Tacos with Black Bean and Avocado Salad"),
      row("Al Pastor Tacos with Black Bean and Avocado Salad"),
      row("Al Pastor Tacos with Charred Street Corn"),
      row("Al Pastor Pork Tacos with Charred Pineapple, Cotija, and Cilantro-Lime Slaw"),
      row("Baja Fish Tacos with Quick Slaw and Lime Crema"),
    ].map(toCandidate);
    const short = preFilterByForm(source, pool);
    const pastor = titles(short).filter((t) => /al pastor/i.test(t));
    assert.equal(pastor.length, 1, `one Al Pastor row, got ${JSON.stringify(pastor)}`);
    assert.ok(titles(short).includes("Baja Fish Tacos with Quick Slaw and Lime Crema"));
  });

  it("the shortlist keeps one version of a dish (no three slow-cooker beef stews)", () => {
    const source = toCandidate(row("Slow-Cooker Chicken and Dumplings", { id: "src" }));
    const pool = [
      row("Classic Slow-Cooker Beef Stew"),
      row("Red Wine Slow-Cooker Beef Stew"),
      row("Tomato-Based Slow-Cooker Beef Stew"),
      row("Chicken Pot Pie with Biscuit Topping"),
    ].map(toCandidate);
    const stews = titles(preFilterByForm(source, pool)).filter((t) => /beef stew/i.test(t));
    assert.equal(stews.length, 1, JSON.stringify(stews));
  });

  it("isSameDish: same dish with other sides is one dish; two different pastas are not", () => {
    assert.equal(isSameDish("Al Pastor Tacos with Corn", "Al Pastor Pork Tacos with Slaw"), true);
    assert.equal(isSameDish("Classic Beef Stew", "Beef Stew with Crusty Bread"), true);
    assert.equal(isSameDish("Cacio e Pepe", "Spaghetti Carbonara"), false);
  });
});

describe("form pre-filter — D-WS9-102 ruling 3 (form and eating experience, across proteins)", () => {
  const profile = (title: string, dishes?: string[], sides?: string[]) =>
    dishFormProfile({ title, mainDishTitles: dishes ?? [title], sideDishTitles: sides ?? [] });

  it("chicken parm: a different-protein cutlet outranks a same-protein roast and any BBQ", () => {
    const parm = profile("Crispy Baked Chicken Parmesan with Spaghetti and Garlic Green Beans", ["Crispy Baked Chicken Parmesan"], ["Spaghetti", "Garlic Green Beans"]);
    const milanese = formScore(parm, profile("Pork Milanese with Arugula, Lemon, and Shaved Parmesan"));
    const tenders = formScore(parm, profile("Crispy Baked Panko Chicken Tenders with Honey-Mustard Dip"));
    const meatballs = formScore(parm, profile("Classic Tomato Spaghetti and Meatballs"));
    const wholeChicken = formScore(parm, profile("Lemon-Herb Roasted Whole Chicken with Potatoes"));
    const bbq = formScore(parm, profile("BBQ Glazed Chicken Thighs with Corn"));
    assert.ok(milanese > wholeChicken, `milanese ${milanese} > whole chicken ${wholeChicken}`);
    assert.ok(tenders > wholeChicken, `tenders ${tenders} > whole chicken ${wholeChicken}`);
    assert.ok(meatballs > bbq, `spaghetti and meatballs ${meatballs} > bbq ${bbq}`);
    assert.ok(bbq < 1, `BBQ chicken shares no form with chicken parm (${bbq})`);
  });

  it("chicken and dumplings: soup, pot pie and beef stew outrank BBQ pork chops (Hans's second calibration)", () => {
    const src = profile("Slow-Cooker Chicken and Dumplings");
    const pie = formScore(src, profile("Chicken Pot Pie with Biscuit Topping"));
    const soup = formScore(src, profile("Lemon-Herb Chicken Noodle Soup"));
    const beefStew = formScore(src, profile("Classic Slow-Cooker Beef Stew"));
    const chops = formScore(src, profile("BBQ Glazed Pork Chops with Mac and Cheese"));
    const flatbread = formScore(src, profile("BBQ Pulled Chicken Flatbreads with Cheddar and Ranch"));
    for (const [name, s] of [["pot pie", pie], ["soup", soup], ["beef stew", beefStew]] as const) {
      assert.ok(s > chops && s > flatbread, `${name} ${s} must beat BBQ chops ${chops} / flatbread ${flatbread}`);
    }
  });

  it("the shortlist keeps a same-form, different-protein meal and leaves the BBQ out", () => {
    const source = toCandidate(row("Slow-Cooker Chicken and Dumplings", { id: "src" }));
    const pool = [
      row("BBQ Glazed Pork Chops with Mac and Cheese"),
      row("BBQ Pulled Chicken Flatbreads with Cheddar and Ranch"),
      row("Classic Slow-Cooker Beef Stew"),
      row("Chicken Pot Pie with Biscuit Topping"),
      row("Hearty Beef Vegetable Soup"),
      ...Array.from({ length: 20 }, (_, i) => row(`Filler Dish Number ${i}`)),
    ].map(toCandidate);
    const short = titles(preFilterByForm(source, pool, 6));
    assert.deepEqual(short.slice(0, 3).sort(), ["Chicken Pot Pie with Biscuit Topping", "Classic Slow-Cooker Beef Stew", "Hearty Beef Vegetable Soup"]);
    assert.equal(short.some((t) => /BBQ/.test(t)), false, `no BBQ in ${JSON.stringify(short)}`);
  });

  it("a side dish does not set the form: a salmon plate with a ragout is not a stew", () => {
    const p = profile("Baked Lemon-Herb Salmon with White Bean and Tomato Ragout", ["Baked Lemon-Herb Salmon"], ["White Bean and Tomato Ragout"]);
    assert.ok(p.main.has("fillet_plate"));
    assert.equal(p.main.has("stew"), false);
  });

  it("word traps: chicken fried rice is not a cutlet; chili-rubbed and sweet chili are not chili", () => {
    assert.equal(profile("Garlic Butter Chicken Fried Rice").main.has("cutlet"), false);
    assert.equal(profile("Chili-Rubbed Fajitas with Peppers").main.has("stew"), false);
    assert.equal(profile("Sweet Chili Chicken with Jasmine Rice").main.has("stew"), false);
    assert.ok(profile("Classic Red Turkey Chili").main.has("stew"));
  });
});
