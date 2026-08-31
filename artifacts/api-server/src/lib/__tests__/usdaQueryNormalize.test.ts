// D-WS9-050 Phase 3 — USDA query normalizer unit tests (BUG-044).
// Run via: pnpm --filter @workspace/api-server test
// Pure function — no I/O, no live USDA.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeUsdaQuery } from "../usda/usdaQueryNormalize";

describe("normalizeUsdaQuery", () => {
  it("strips trailing prep phrases (S1.1)", () => {
    const r = normalizeUsdaQuery("yukon gold potatoes, cut into chunks", "Produce");
    assert.equal(r.normalized, "yukon gold potatoes raw");
    // base-noun tier peels the variety adjectives
    assert.equal(r.baseNoun, "potatoes raw");
    assert.equal(r.hasFallback, true);
  });

  it("strips inline prep words anywhere (S1.1)", () => {
    assert.equal(normalizeUsdaQuery("carrots, peeled and sliced", "Produce").normalized, "carrots raw");
    assert.equal(normalizeUsdaQuery("garlic cloves, minced", "Produce").normalized, "garlic cloves raw");
    assert.equal(normalizeUsdaQuery("sliced almonds", "Pantry").normalized, "almonds");
  });

  it("drops macro-neutral grade/sourcing qualifiers but not the food (S1.2)", () => {
    assert.equal(normalizeUsdaQuery("extra-virgin olive oil", "Pantry").normalized, "olive oil");
    assert.equal(normalizeUsdaQuery("store-bought naan", "Bakery").normalized, "naan");
    assert.equal(normalizeUsdaQuery("romaine lettuce hearts", "Produce").normalized, "romaine lettuce raw");
    assert.equal(normalizeUsdaQuery("asparagus spears", "Produce").normalized, "asparagus raw");
    // sodium-only qualifier is macro-neutral for the 4 tracked macros
    assert.equal(normalizeUsdaQuery("unsalted butter", "Dairy").normalized, "butter");
  });

  it("RETAINS macro-relevant skin/bone/milk-fat qualifiers in tier-1 (S1.2)", () => {
    const r = normalizeUsdaQuery("bone-in, skin-on chicken thighs", "Protein");
    assert.equal(r.normalized, "bone-in skin-on chicken thighs raw");
    assert.deepEqual(r.retained.sort(), ["bone-in", "skin-on"]);
    // fallback peels them
    assert.equal(r.baseNoun, "chicken thighs raw");

    const b = normalizeUsdaQuery("boneless skinless chicken thighs", "Protein");
    assert.equal(b.normalized, "boneless skinless chicken thighs raw");
    assert.equal(b.baseNoun, "chicken thighs raw");

    const m = normalizeUsdaQuery("shredded whole-milk mozzarella", "Dairy");
    assert.equal(m.normalized, "whole-milk mozzarella");
    assert.equal(m.baseNoun, "mozzarella");
  });

  it("peels variety adjectives to a base noun on fallback (S1.3)", () => {
    assert.equal(normalizeUsdaQuery("roma tomatoes", "Produce").baseNoun, "tomatoes raw");
    // R1: rice is a Pantry dry good → the base noun now carries the "raw" form token
    assert.equal(normalizeUsdaQuery("basmati rice", "Pantry").baseNoun, "rice raw");
    assert.equal(normalizeUsdaQuery("cremini mushrooms", "Produce").baseNoun, "mushrooms raw");
    assert.equal(normalizeUsdaQuery("cherry tomatoes", "Produce").baseNoun, "tomatoes raw");
    assert.equal(normalizeUsdaQuery("shredded sharp cheddar cheese", "Dairy").baseNoun, "cheddar cheese");
  });

  it("maps single-token varieties the positional rule cannot decompose (S1.3)", () => {
    assert.equal(normalizeUsdaQuery("orzo", "Pantry").normalized, "pasta");
    assert.equal(normalizeUsdaQuery("linguine", "Pantry").normalized, "pasta");
    assert.equal(normalizeUsdaQuery("rigatoni", "Pantry").normalized, "pasta");
    // WS9 BUG-186 — parmigiano-reggiano is a Dairy row now (it was mis-filed
    // Pantry, which is the bug). The fixture carries the corrected category so
    // the case stays truthful about the catalog.
    assert.equal(normalizeUsdaQuery("parmigiano-reggiano", "Dairy").normalized, "parmesan");
    assert.equal(normalizeUsdaQuery("panko breadcrumbs", "Pantry").normalized, "bread crumbs");
  });

  it("deaccents so accented spellings match ASCII USDA descriptions", () => {
    assert.equal(normalizeUsdaQuery("jalapeño", "Produce").normalized, "jalapeno raw");
    assert.equal(normalizeUsdaQuery("gruyère cheese", "Dairy").normalized, "gruyere cheese");
  });

  it("adds form tokens by state/category (S1.4)", () => {
    const ft = normalizeUsdaQuery("canned fire-roasted diced tomatoes", "Canned");
    assert.equal(ft.normalized, "canned fire-roasted tomatoes"); // 'diced' stripped, variety kept in tier-1
    assert.equal(ft.baseNoun, "canned tomatoes"); // fallback peels 'fire-roasted'
    // cooked-state names are left alone (no 'raw' forced)
    assert.equal(normalizeUsdaQuery("roasted red peppers", "Produce").normalized, "roasted red peppers");
    // keeps 'ground' — it selects a real USDA record
    assert.match(normalizeUsdaQuery("80/20 ground beef", "Protein").normalized, /ground beef/);
    // no 'raw' for oils/condiments even when (mis)categorized as Produce/Protein
    assert.equal(normalizeUsdaQuery("neutral oil (such as avocado)", "Produce").normalized, "neutral oil");
    assert.equal(normalizeUsdaQuery("fish sauce", "Protein").normalized, "fish sauce");
  });

  it("drops parenthetical asides", () => {
    assert.equal(
      normalizeUsdaQuery("neutral oil (such as avocado or vegetable)", "Pantry").normalized,
      "neutral oil",
    );
  });

  it("returns a single tier when nothing further can be stripped", () => {
    const r = normalizeUsdaQuery("prosciutto", "Protein");
    assert.equal(r.hasFallback, false);
    assert.equal(r.normalized, r.baseNoun);
  });

  // ── R1 (P3-REBUILD-2): Pantry dry-goods "raw" form token ──────────────────
  it("appends 'raw' to Pantry dry seeds/grains/pulses (R1.1)", () => {
    // rice — the swamped-by-snacks case the token disambiguates
    const bas = normalizeUsdaQuery("basmati rice", "Pantry");
    assert.equal(bas.normalized, "basmati rice raw");
    assert.equal(bas.baseNoun, "rice raw");
    assert.equal(bas.hasFallback, true);
    assert.equal(normalizeUsdaQuery("jasmine rice", "Pantry").baseNoun, "rice raw");
    assert.equal(normalizeUsdaQuery("white basmati rice", "Pantry").baseNoun, "white rice raw");
    // legumes take the token too
    assert.equal(normalizeUsdaQuery("green lentils", "Pantry").normalized, "green lentils raw");
    // milled flours are EXCLUDED — no USDA raw state (R1.2, no over-fit)
    assert.equal(normalizeUsdaQuery("all-purpose flour", "Pantry").normalized, "all-purpose flour");
    // the token only fires for the dry-goods class, not every Pantry item
    assert.equal(normalizeUsdaQuery("extra-virgin olive oil", "Pantry").normalized, "olive oil");
  });

  // ── R2 (P3-REBUILD-2): general shape→pasta rule ───────────────────────────
  it("collapses any pasta shape to 'pasta' (R2)", () => {
    for (const shape of ["elbow macaroni", "penne", "ziti", "rigatoni", "farfalle", "linguine"]) {
      const r = normalizeUsdaQuery(shape, "Pantry");
      assert.equal(r.normalized, "pasta", `${shape} → pasta`);
      assert.equal(r.hasFallback, false);
    }
    // guard: spaghetti squash is a vegetable, NOT pasta
    assert.equal(normalizeUsdaQuery("spaghetti squash", "Produce").normalized, "spaghetti squash raw");
  });

  // ── R3 (P3-REBUILD-2): general bun→rolls rule ─────────────────────────────
  it("maps buns to the USDA 'rolls' head noun (R3)", () => {
    assert.equal(normalizeUsdaQuery("brioche burger buns", "Bakery").normalized, "rolls hamburger");
    assert.equal(normalizeUsdaQuery("potato hamburger bun", "Bakery").normalized, "rolls hamburger");
    assert.equal(normalizeUsdaQuery("brioche hot dog bun", "Bakery").normalized, "rolls hot dog");
    assert.equal(normalizeUsdaQuery("brioche burger buns", "Bakery").hasFallback, false);
  });
});
