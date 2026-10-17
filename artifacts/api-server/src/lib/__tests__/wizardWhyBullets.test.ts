// FIX-2 (Part B) — "Why this works" may only name what the card holds.
// Fixtures are TRIAGE-0's live cards (dev, October 16), verbatim.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fallbackBullet, groundWhyBullets, unsupportedClaims } from "../wizardWhyBullets";
import { toWireCandidate } from "../wizardCandidateMeals";
import type { WizardPlanCandidate } from "../ai/schemas/wizard";

const meals = (titles: string[], descriptions: (string | null)[] = []) =>
  titles.map((title, i) => ({ title, description: descriptions[i] ?? null }));

// Run 2's only card: the bullets said Chicken Parmesan; the card had Pork Milanese.
const COZY_FALL = meals(
  [
    "Shrimp Scampi over Creamy Polenta",
    "Cacio e Pepe with a Green Salad",
    "Pork Milanese with Arugula, Lemon, and Shaved Parmesan",
    "Turkey Meatballs in Marinara over Spaghetti",
    "Salsa Verde Sheet-Pan Chicken Fajitas",
  ],
  [
    "Garlicky butter-and-white-wine shrimp scampi spooned over a rich, parmesan-laced polenta — a satisfying Italian-American dinner that comes together in under an hour.",
    "Silky spaghetti tossed in a glossy Pecorino-Parmesan sauce with a generous hit of cracked black pepper, alongside a crisp green salad with a bright lemon vinaigrette.",
    "Crispy breaded pork cutlets topped with a bright arugula salad, fresh lemon juice, and shaved Parmesan — a classic Italian trattoria dinner on the table in under an hour.",
    "Tender ground turkey meatballs simmered in a rich tomato marinara, served over a generous bed of spaghetti with fresh basil and Parmesan.",
    "Juicy chicken thighs and charred peppers roasted with tangy salsa verde, served with warm flour tortillas and all the classic fajita toppings.",
  ],
);
const COZY_FALL_BULLETS = [
  "Italian is one of your three preferred cuisines, and this plan leans into it with a pasta, a breaded cutlet, and a shrimp dinner — three distinct expressions of the cuisine",
  "Weeknight pacing is mostly easy: Shrimp Scampi and Cacio e Pepe both come together quickly, with Chicken Parmesan as the one night worth a little more effort",
  "All five meals stay at or under medium difficulty, your stated ceiling",
];

// Run 1, card 1: "a hearty bake" with no bake on the card.
const ITALIAN_TEXMEX = meals([
  "Bruschetta Chicken with Garlic Pasta",
  "Classic Tex-Mex Ground Beef Tacos",
  "Cashew Shrimp Stir-Fry with Snap Peas and Steamed Rice",
  "Spicy Arrabbiata Spaghetti and Meatballs",
  "Crispy Chicken Tacos with Shredded Cabbage and Salsa Roja",
]);
const ITALIAN_TEXMEX_BULLETS = [
  "Four of five nights are easy-difficulty dinners, matching your mostly-easy pacing preference.",
  "Italian and Mexican cuisines both represented across the week, with a Chinese-American night rounding out your Asian preference.",
  "A mix of pasta, tacos, stir-fry, and a hearty bake — chicken, beef, and shrimp so no two nights feel alike.",
];

// Run 1's saved plan: "braised ragu" with no ragu.
const ITALIAN_CLASSICS = meals([
  "Chicken Piccata with Wilted Spinach and Crusty Bread",
  "White Cheese Pizza with Garlic and Olive Oil",
  "Smoky Chipotle Ground Beef Tacos with Avocado Crema",
  "Teriyaki Chicken Rice Bowl with Pickled Carrots, Edamame, and Sriracha Mayo",
  "Grilled Chicken Alfredo with Fettuccine and Roasted Broccoli",
]);

// Run 1, card 2: every bullet is true — none may be dropped.
const BOLD_ASIAN = meals([
  "Thai Red Curry with Rice Noodles",
  "Al Pastor Pork Tacos with Charred Pineapple, Cotija, and Cilantro-Lime Slaw",
  "Extra-Crispy General Tso's Chicken with Steamed Jasmine Rice and Stir-Fried Broccoli",
  "Shrimp Quesadilla with Avocado Salsa and Sour Cream",
  "Classic Pepper Steak with Bell Peppers in Brown Sauce",
]);
const BOLD_ASIAN_BULLETS = [
  "Leans into your Asian and Mexican cuisine preferences with Thai, Chinese-American, and Mexican dinners as the backbone of the week.",
  "Four of five dinners are easy-difficulty, keeping the week low-pressure as you asked.",
  "Chicken, beef, shrimp, and pork across the week — varied proteins so the rotation stays interesting through Friday.",
];

describe("whyBullets grounding — TRIAGE-0's three wrong bullets are dropped", () => {
  it("'with Chicken Parmesan as the one night' on a card without it", () => {
    const g = groundWhyBullets(COZY_FALL_BULLETS, COZY_FALL);
    assert.deepEqual(g.whyBullets, [COZY_FALL_BULLETS[0], COZY_FALL_BULLETS[2]]);
    assert.deepEqual(g.dropped[0].unsupported, ["chicken parmesan"]);
  });

  it("'a hearty bake' on a card without one", () => {
    const g = groundWhyBullets(ITALIAN_TEXMEX_BULLETS, ITALIAN_TEXMEX);
    assert.deepEqual(g.whyBullets, ITALIAN_TEXMEX_BULLETS.slice(0, 2));
    assert.deepEqual(g.dropped[0].unsupported, ["hearty bake"]);
  });

  it("'braised ragu' on a plan without it", () => {
    const bad = "Fall-friendly warm dishes — creamy pasta, braised ragu, and a cheesy pizza night — suit the October weather";
    assert.deepEqual(unsupportedClaims(bad, ITALIAN_CLASSICS).sort(), ["braised", "ragu"]);
  });

  it("a cuisine no meal belongs to", () => {
    assert.deepEqual(unsupportedClaims("A Mexican night breaks up the week", COZY_FALL.slice(0, 4)), ["mexican"]);
  });
});

describe("whyBullets grounding — true bullets survive", () => {
  it("keeps all three of a correct card's bullets (cuisines by their dishes, proteins by their cuts)", () => {
    const g = groundWhyBullets(BOLD_ASIAN_BULLETS, BOLD_ASIAN);
    assert.deepEqual(g.whyBullets, BOLD_ASIAN_BULLETS);
    assert.equal(g.dropped.length, 0);
  });

  it("a negated food word is a statement about absence, not a claim", () => {
    const b = "Skipped salmon — you marked pescatarian-no-fish; subbed shrimp.";
    assert.deepEqual(unsupportedClaims(b, meals(["Garlic Shrimp Linguine"])), []);
    assert.deepEqual(unsupportedClaims("No beef anywhere, as you asked", meals(["Chicken Tikka Masala"])), []);
  });

  it("a preference or pacing claim names no food and is left alone", () => {
    assert.deepEqual(unsupportedClaims(COZY_FALL_BULLETS[2], COZY_FALL), []);
  });
});

describe("whyBullets grounding — never empty", () => {
  it("when every bullet fails, one plain bullet built from the final meals stands in", () => {
    const g = groundWhyBullets(["A cozy curry night and a salmon bake"], ITALIAN_TEXMEX.slice(0, 3));
    assert.equal(g.usedFallback, true);
    assert.deepEqual(g.whyBullets, [
      "Three different dinners: Bruschetta Chicken, Classic Tex-Mex Ground Beef Tacos and Cashew Shrimp Stir-Fry",
    ]);
    // ...and the stand-in is itself grounded.
    assert.deepEqual(unsupportedClaims(g.whyBullets[0], ITALIAN_TEXMEX.slice(0, 3)), []);
  });

  it("fallbackBullet handles one meal", () => {
    assert.equal(fallbackBullet(meals(["Pesto Pasta with Cherry Tomatoes"])), "Pesto Pasta, picked for this week");
  });
});

describe("toWireCandidate grounds whyBullets against the card's own meals", () => {
  it("the wire candidate carries only the grounded bullets (the one place every path passes)", () => {
    const candidate: WizardPlanCandidate = {
      id: "c1",
      title: "Cozy Fall Italian Nights",
      tags: [],
      mealTitles: COZY_FALL.map((m) => m.title),
      mealDescriptions: COZY_FALL.map((m) => m.description ?? ""),
      dailyMacros: { calories: 631, proteinG: 37, carbsG: 53, fatG: 24 },
      whyBullets: COZY_FALL_BULLETS,
    };
    const wire = toWireCandidate(candidate, { descriptionById: new Map() });
    assert.deepEqual(wire.whyBullets, [COZY_FALL_BULLETS[0], COZY_FALL_BULLETS[2]]);
    assert.equal(wire.meals.length, 5);
  });
});
