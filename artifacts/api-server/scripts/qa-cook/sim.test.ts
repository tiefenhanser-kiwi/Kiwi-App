// QA-COOK-1 — the kitchen simulator's K-flags on hand-made Cook Mode sessions.
// Each flag has a session that must raise it and a near-twin that must not.
//   node --import tsx --test scripts/qa-cook/sim.test.ts   (from artifacts/api-server)
import assert from "node:assert/strict";
import { test } from "node:test";

import { patternOfFinding, patternOfIssue } from "./patterns";
import { caughtFajita, interruptionsFor } from "./personas";
import { readStep } from "./lexicon";
import { simulate } from "./simulator";
import type { CookView, KFlag, ShownStep } from "./types";

type S = Partial<ShownStep> & { text: string; phaseType: string; estimatedMinutes: number; dishId?: string };

function view(steps: S[], opts: Partial<CookView> & { dishes?: CookView["dishes"] } = {}): CookView {
  const idx = new Map<string, number>();
  const shown: ShownStep[] = steps.map((s, i) => {
    const d = s.dishId ?? "d1";
    const k = idx.get(d) ?? 0;
    idx.set(d, k + 1);
    return {
      n: i + 1, key: `${d}#${s.stepIndex ?? k}`, dishId: d, stepIndex: s.stepIndex ?? k, isTimingSensitive: false, doneInPrep: false, preppedLabels: [],
      parallelGroup: null, ...s,
    } as ShownStep;
  });
  const dishIds = [...new Set(shown.map((s) => s.dishId!))];
  return {
    sourceMealId: "m1", title: "Test meal", category: "multi-dish", servings: 4, authoredServings: 4, prepped: false,
    multiDish: dishIds.length > 1, isFeast: false,
    dishes: opts.dishes ?? dishIds.map((d) => ({ dishId: d, title: d, servedCold: false })),
    steps: shown, totalMinutes: null, recap: [], ...opts,
  };
}

const flags = (v: CookView, flag: KFlag) => simulate(v).findings.filter((f) => f.flag === flag);

// ── the fajita meal, as dev's Cook Mode shows it (QA-COOK-1 capture, 2 servings) ──
const FAJITA_DISHES = [
  { dishId: "chicken", title: "Smoky Chipotle Chicken with Peppers and Onions", servedCold: false },
  { dishId: "tortillas", title: "Warm Flour Tortillas", servedCold: false },
  { dishId: "toppings", title: "Fajita Toppings", servedCold: false },
];
const FAJITA: S[] = [
  { dishId: "chicken", stepIndex: 0, phaseType: "prep", estimatedMinutes: 8, startOffsetMinutes: -35, text: "Mince 1 chipotle chile in adobo sauce and 2 garlic cloves, then whisk together with lime juice, olive oil, cumin and smoked paprika in a large bowl." },
  { dishId: "chicken", stepIndex: 2, phaseType: "rest", estimatedMinutes: 15, startOffsetMinutes: -27, parallelGroup: "w2", text: "Slice 1 pound boneless skinless chicken thighs into ½-inch strips, add to the marinade, toss to coat, and let sit for 15 minutes." },
  { dishId: "chicken", stepIndex: 3, phaseType: "prep", estimatedMinutes: 6, startOffsetMinutes: -27, parallelGroup: "w2", text: "Seed and slice 1 red bell pepper into strips, and halve and slice ½ yellow onion into half-moons." },
  { dishId: "tortillas", stepIndex: 0, phaseType: "cook", estimatedMinutes: 6, startOffsetMinutes: -21, cue: "With the Smoky Chipotle Chicken with Peppers and Onions resting, start on the Warm Flour Tortillas.", text: "Heat a dry skillet or griddle over medium-high heat, then warm the flour tortillas one at a time for 20–30 seconds per side until pliable and lightly toasted in spots." },
  { dishId: "toppings", stepIndex: 0, phaseType: "prep", estimatedMinutes: 2, startOffsetMinutes: -21, cue: "With the Smoky Chipotle Chicken with Peppers and Onions resting, start on the Fajita Toppings.", text: "Cut 1 lime into wedges." },
  { dishId: "chicken", stepIndex: 4, phaseType: "preheat", estimatedMinutes: 2, startOffsetMinutes: -19, parallelGroup: "w2", text: "Heat ½ tablespoon olive oil in a large cast-iron skillet over high heat until shimmering." },
  { dishId: "chicken", stepIndex: 5, phaseType: "cook", isTimingSensitive: true, estimatedMinutes: 6, startOffsetMinutes: -18, parallelGroup: "w2", text: "Add the bell peppers and onion to the skillet and cook, stirring occasionally, for 5–6 minutes until charred at the edges and just tender, then transfer to a plate." },
  { dishId: "tortillas", stepIndex: 1, phaseType: "hold", estimatedMinutes: 1, startOffsetMinutes: -15, text: "Stack the warmed tortillas and wrap in a clean kitchen towel or foil to keep them warm until serving." },
  { dishId: "chicken", stepIndex: 6, phaseType: "cook", isTimingSensitive: true, estimatedMinutes: 7, startOffsetMinutes: -12, text: "Add the marinated chicken strips to the same skillet in a single layer and sear undisturbed for 3 minutes, then stir and cook another 3–4 minutes until cooked through." },
  { dishId: "chicken", stepIndex: 7, phaseType: "cook", isTimingSensitive: true, estimatedMinutes: 1, startOffsetMinutes: -2, text: "Return the peppers and onions to the skillet, toss everything together over high heat for 1 minute, then remove from heat." },
  { dishId: "toppings", stepIndex: 1, phaseType: "assemble", estimatedMinutes: 3, startOffsetMinutes: -1, text: "Set out sour cream, guacamole, pico de gallo, shredded cheese and the lime wedges in small bowls for the table." },
  { dishId: "chicken", stepIndex: 8, phaseType: "assemble", estimatedMinutes: 1, startOffsetMinutes: 0, text: "Scatter chopped fresh cilantro over the chicken and peppers and serve immediately." },
];

/** The fajita meal written the way a cook would: chop first, tortillas last and wrapped at once. */
const FAJITA_FIXED: S[] = [
  { ...FAJITA[0], startOffsetMinutes: -45 },
  { ...FAJITA[1], startOffsetMinutes: -37 },
  { ...FAJITA[2], startOffsetMinutes: -37 },
  { ...FAJITA[4], startOffsetMinutes: -31, cue: undefined },
  { ...FAJITA[5], startOffsetMinutes: -29 },
  { ...FAJITA[6], startOffsetMinutes: -27 },
  { ...FAJITA[8], startOffsetMinutes: -21 },
  { ...FAJITA[9], startOffsetMinutes: -14, text: "Return the peppers and onions to the skillet, toss everything together over high heat for 1 minute, then remove from heat and cover to keep warm." },
  { ...FAJITA[10], startOffsetMinutes: -13 },
  { ...FAJITA[3], startOffsetMinutes: -10, cue: undefined },
  { ...FAJITA[7], startOffsetMinutes: -1 },
  { ...FAJITA[11], startOffsetMinutes: 0 },
];

test("the lexicon reads one-at-a-time tortillas as constant attention, though the Sequencer calls the step hands-free", () => {
  const r = readStep({ text: FAJITA[3].text, phaseType: "cook", estimatedMinutes: 6, isTimingSensitive: false });
  assert.equal(r.attention, "constant");
  assert.equal(r.heat, "stove");
  assert.equal(r.batchwise, true);
  assert.equal(r.serverHandsFree, true);
});

test("the fajita meal: K1 (tortillas held, wrapped late), K2 (one-at-a-time overlapped), K3 (lime inside the stove work)", () => {
  const v = view(FAJITA, { dishes: FAJITA_DISHES, servings: 6 });
  const k1 = flags(v, "K1");
  assert.ok(k1.some((f) => /^K1:(keep-warm-late|held-uncovered):bread$/.test(f.signature) && f.steps.includes(4)), JSON.stringify(k1));
  const k2 = flags(v, "K2");
  assert.ok(k2.some((f) => f.signature === "K2:uncued:flagged-hands-free:bread" && f.steps[0] === 4 && f.steps.includes(5)), JSON.stringify(k2));
  const k3 = flags(v, "K3");
  assert.ok(k3.some((f) => f.steps.join() === "4,5" && f.severity === "high"), JSON.stringify(k3));
});

test("the fajita meal written well raises no K1, K2 or K3", () => {
  const v = view(FAJITA_FIXED, { dishes: FAJITA_DISHES, servings: 6 });
  assert.deepEqual(flags(v, "K1"), []);
  assert.deepEqual(flags(v, "K2"), []);
  assert.deepEqual(flags(v, "K3"), []);
});

test("one at a time grows with the servings", () => {
  const at = (servings: number) => simulate(view([FAJITA[3]], { servings, authoredServings: 4 })).steps[0];
  assert.equal(at(4).end - at(4).start, 6);
  assert.equal(at(8).end - at(8).start, 12);
  assert.equal(at(2).end - at(2).start, 3);
});

// ── K1 ──
test("K1: a hot dish done early with nothing keeping it warm; the same dish finished last does not", () => {
  const bread = { dishId: "bread", phaseType: "cook", estimatedMinutes: 5, text: "Toast the garlic bread under the broiler until golden, about 3 minutes." };
  const stew = [
    { dishId: "stew", phaseType: "cook", estimatedMinutes: 20, isTimingSensitive: true, text: "Brown the beef in a large pot over medium-high heat, stirring often, until browned on all sides." },
    { dishId: "stew", phaseType: "assemble", estimatedMinutes: 1, text: "Ladle the stew into bowls and serve." },
  ];
  const dishes = [{ dishId: "bread", title: "Garlic Bread", servedCold: false }, { dishId: "stew", title: "Beef Stew", servedCold: false }];
  const bad = flags(view([bread, ...stew], { dishes }), "K1");
  assert.ok(bad.some((f) => f.signature === "K1:held-uncovered:bread" && f.severity === "high"), JSON.stringify(bad));
  assert.deepEqual(flags(view([stew[0], bread, stew[1]], { dishes }), "K1"), []);
  // Kept warm right away: covered.
  assert.deepEqual(flags(view([{ ...bread, text: `${bread.text} Wrap in foil to keep warm.` }, ...stew], { dishes }), "K1"), []);
});

test("K1: a cold, browning component sits out; covered and chilled it does not", () => {
  const dishes = [{ dishId: "guac", title: "Guacamole", servedCold: true }, { dishId: "chili", title: "Chili", servedCold: false }];
  const guac = { dishId: "guac", phaseType: "prep", estimatedMinutes: 5, text: "Mash 2 avocados with lime juice, onion and cilantro." };
  const chili = { dishId: "chili", phaseType: "cook", estimatedMinutes: 30, text: "Simmer the chili, covered, for 30 minutes." };
  const serve = { dishId: "chili", phaseType: "assemble", estimatedMinutes: 1, text: "Serve the chili with the guacamole." };
  assert.ok(flags(view([guac, chili, serve], { dishes }), "K1").some((f) => f.signature.startsWith("K1:cold-held")));
  assert.deepEqual(flags(view([{ ...guac, text: `${guac.text} Press plastic wrap on the surface and refrigerate.` }, chili, serve], { dishes }), "K1"), []);
});

// ── K2 ──
test("K2: the Sequencer overlaps a hands-on step flagged hands-free; set after it, no K2", () => {
  const dishes = [{ dishId: "a", title: "Pan Sauce", servedCold: false }, { dishId: "b", title: "Salad", servedCold: true }];
  const stir = { dishId: "a", phaseType: "cook", estimatedMinutes: 8, startOffsetMinutes: -10, text: "Whisk the sauce in a saucepan over medium heat, stirring constantly, until thick." };
  const chop = { dishId: "b", phaseType: "prep", estimatedMinutes: 5, startOffsetMinutes: -8, text: "Chop the romaine and slice the cucumber." };
  const k2 = flags(view([stir, chop], { dishes }), "K2");
  assert.ok(k2.some((f) => f.signature === "K2:uncued:flagged-hands-free:sauce" && f.severity === "high"), JSON.stringify(k2));
  assert.deepEqual(flags(view([stir, { ...chop, startOffsetMinutes: -2 }], { dishes }), "K2"), []);
  // A passive simmer under the knife work is what overlap is for.
  assert.deepEqual(flags(view([{ ...stir, text: "Simmer the sauce in a saucepan, covered, for 8 minutes." }, chop], { dishes }), "K2"), []);
});

// ── K3 ──
test("K3: a knife task between shimmering oil and the food that goes in it; before the oil, none", () => {
  const oil = { phaseType: "preheat", estimatedMinutes: 2, text: "Heat 1 tablespoon oil in a large skillet over high heat until shimmering." };
  const lime = { phaseType: "prep", estimatedMinutes: 2, text: "Cut 1 lime into wedges." };
  const peppers = { phaseType: "cook", estimatedMinutes: 6, isTimingSensitive: true, text: "Add the peppers to the skillet and cook, stirring occasionally, until charred." };
  const k3 = flags(view([oil, lime, peppers]), "K3");
  assert.ok(k3.some((f) => f.signature.startsWith("K3:knife-inside-constant") && f.severity === "high" && f.steps.join() === "1,2"), JSON.stringify(k3));
  assert.deepEqual(flags(view([lime, oil, peppers]), "K3"), []);
  // Off the heat first: no pan needs the cook.
  assert.deepEqual(flags(view([{ ...peppers, text: `${peppers.text} Transfer to a plate.` }, lime]), "K3"), []);
});

// ── K4 ──
test("K4: the oven at two temperatures at once; at one temperature, none", () => {
  const dishes = [{ dishId: "a", title: "Roast Chicken", servedCold: false }, { dishId: "b", title: "Cornbread", servedCold: false }];
  const pre = { dishId: "a", phaseType: "preheat", estimatedMinutes: 10, text: "Preheat the oven to 425°F." };
  const roast = { dishId: "a", phaseType: "cook", estimatedMinutes: 40, text: "Roast the chicken in the oven for 40 minutes." };
  const bake = { dishId: "b", phaseType: "cook", estimatedMinutes: 25, text: "Bake the cornbread at 350°F for 25 minutes." };
  assert.ok(flags(view([pre, roast, bake], { dishes }), "K4").some((f) => f.signature === "K4:oven-two-temps" && f.severity === "high"));
  assert.deepEqual(flags(view([pre, roast, { ...bake, text: "Bake the cornbread at 425°F for 20 minutes." }], { dishes }), "K4"), []);
  // The feast's own "Raise the oven to 350°F and put in …" changes the one oven for everything in it: not two temperatures.
  const raise = { dishId: "b", phaseType: "cook", estimatedMinutes: 30, text: "Raise the oven to 375°F and put in the stuffing." };
  assert.deepEqual(flags(view([{ ...pre, text: "Preheat the oven to 325°F." }, roast, raise], { dishes }), "K4"), []);
});

test("K4: 'the same skillet' while another dish still has it on the heat", () => {
  const dishes = [{ dishId: "a", title: "Sauce", servedCold: false }, { dishId: "b", title: "Steak", servedCold: false }];
  const sauce = { dishId: "a", phaseType: "cook", estimatedMinutes: 15, text: "Simmer the tomatoes in the skillet, covered, for 15 minutes." };
  const steak = { dishId: "b", phaseType: "cook", estimatedMinutes: 8, isTimingSensitive: true, text: "In the same skillet, sear the steak 4 minutes per side." };
  assert.ok(flags(view([sauce, steak], { dishes }), "K4").some((f) => f.signature === "K4:same-pan-busy:skillet"));
  assert.deepEqual(flags(view([{ ...sauce, text: "Simmer the tomatoes in a saucepan, covered, for 15 minutes." }, { ...steak, text: "In a skillet, sear the steak 4 minutes per side." }], { dishes }), "K4").filter((f) => f.signature.startsWith("K4:same")), []);
});

// ── K5 ──
test("K5: a 30-minute wait with chopping still ahead; chopped first, no K5", () => {
  const simmer = { phaseType: "cook", estimatedMinutes: 30, text: "Simmer the stew, covered, for 30 minutes." };
  const cream = { phaseType: "cook", estimatedMinutes: 2, isTimingSensitive: true, text: "Stir the cream into the stew and heat through." };
  const parsley = { phaseType: "prep", estimatedMinutes: 3, text: "Chop the parsley." };
  const k5 = flags(view([simmer, cream, parsley]), "K5");
  assert.ok(k5.some((f) => f.signature === "K5:idle-wait:garnish" && f.steps.join() === "2,3"), JSON.stringify(k5));
  assert.deepEqual(flags(view([simmer, parsley, cream]), "K5"), []);
});

// ── K6 ──
test("K6: 'the reserved sauce' with no sauce made; made first, none", () => {
  const fish = { phaseType: "cook", estimatedMinutes: 8, isTimingSensitive: true, text: "Sear the salmon in a skillet 4 minutes per side." };
  const drizzle = { phaseType: "assemble", estimatedMinutes: 1, text: "Drizzle the reserved glaze over the salmon and serve." };
  const k6 = flags(view([fish, drizzle]), "K6");
  assert.ok(k6.some((f) => f.signature === "K6:ref-never-made:sauce"), JSON.stringify(k6));
  const glaze = { phaseType: "prep", estimatedMinutes: 3, text: "Whisk honey, soy and garlic into a glaze; reserve 2 tablespoons." };
  assert.deepEqual(flags(view([glaze, fish, drizzle]), "K6"), []);
});

test("K6: a dish uses another's food before that dish is made (the Sequencer's dishUses)", () => {
  const dishes = [{ dishId: "tacos", title: "Fish Tacos", servedCold: false }, { dishId: "salsa", title: "Mango Salsa", servedCold: true }];
  const top = { dishId: "tacos", phaseType: "assemble", estimatedMinutes: 2, text: "Spoon the salsa over the fish and serve." };
  const fish = { dishId: "tacos", phaseType: "cook", estimatedMinutes: 6, isTimingSensitive: true, text: "Sear the fish in a skillet until flaky." };
  const salsa = { dishId: "salsa", phaseType: "prep", estimatedMinutes: 5, text: "Dice the mango and red onion and toss with lime juice." };
  assert.ok(flags(view([fish, top, salsa], { dishes }), "K6").some((f) => f.signature.startsWith("K6:uses-before-made")));
  assert.deepEqual(flags(view([salsa, fish, top], { dishes }), "K6"), []);
});

// ── K7 ──
test("K7: bacon set aside and never used again; crumbled over at the end, none", () => {
  const bacon = { phaseType: "cook", estimatedMinutes: 8, isTimingSensitive: true, text: "Cook the bacon in a skillet until crisp, then transfer it to a paper towel-lined plate." };
  const eggs = { phaseType: "cook", estimatedMinutes: 4, isTimingSensitive: true, text: "Scramble the eggs in the skillet until just set." };
  const serve = { phaseType: "assemble", estimatedMinutes: 1, text: "Spoon the eggs onto plates and serve." };
  assert.ok(flags(view([bacon, eggs, serve]), "K7").some((f) => f.signature.startsWith("K7:never-picked-up")));
  assert.deepEqual(flags(view([bacon, eggs, { ...serve, text: "Spoon the eggs onto plates, crumble the bacon over the top and serve." }]), "K7"), []);
});

// ── patterns and the persona helpers ──
test("patterns: sim signatures and persona issues land in the same pattern", () => {
  assert.equal(patternOfFinding({ flag: "K1", severity: "high", signature: "K1:keep-warm-late:bread", steps: [], quote: "", detail: "" }), "P1");
  assert.equal(patternOfFinding({ flag: "K2", severity: "high", signature: "K2:uncued:flagged-hands-free:bread", steps: [], quote: "", detail: "" }), "P1");
  assert.equal(patternOfFinding({ flag: "K3", severity: "high", signature: "K3:knife-inside-constant:protein", steps: [], quote: "", detail: "" }), "P2");
  assert.equal(patternOfIssue({ step: 4, quote: "warm the flour tortillas one at a time", type: "held-too-long", whatWentWrong: "The tortillas sat uncovered and went cold and stiff.", severity: "high", suggestedRewrite: "" }, "beginner"), "P1");
  assert.equal(patternOfIssue({ step: 5, quote: "Cut 1 lime into wedges.", type: "two-at-once", whatWentWrong: "I'm cutting limes while the skillet heats behind me.", severity: "medium", suggestedRewrite: "" }, "beginner"), "P2");
  assert.equal(caughtFajita({ persona: "beginner", model: "m", view: { sourceMealId: "", title: "", servings: 2, prepped: false }, issues: [{ step: 4, quote: "warm the flour tortillas", type: "order", whatWentWrong: "much too early; they will sit out and go cold", severity: "high", suggestedRewrite: "" }], log: [], usd: 0, calls: 0, ms: 0 }).length, 1);
});

test("the interrupted parent is called away at seeded steps, never step 1, the same every night", () => {
  const v = view(FAJITA, { dishes: FAJITA_DISHES });
  const a = interruptionsFor(v, 1028);
  assert.deepEqual([...a], [...interruptionsFor(v, 1028)]);
  assert.ok(a.size >= 1 && !a.has(1));
});
