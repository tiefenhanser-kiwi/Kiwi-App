// WS9 BUG-204 — the clock the code owns.
//
// The per-step estimate used to be the model's, and across the 14-plan corpus it
// ran about 3x long (mean 6.6 min; 3 min to halve one poblano). That was
// cosmetic until D-WS9-301 ruling 4 put the SUM in the header: "18 containers ·
// about 120 min" for work that takes about forty. Hans's condition for showing a
// total at all was trust — "40 minutes is no more than 50 minutes or so in
// reality" — and the number was failing it in the expensive direction.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MINUTES, timeRow, timeStep, planMinutes, parseAmount } from "../prepStepMinutes";

const comp = (
  ingredientName: string,
  preparationNote: string | null,
  ...amounts: string[]
) => ({
  ingredientName,
  preparationNote,
  measures: amounts.map((amount) => ({ amount, preparationNote: null })),
});

// ── the three shapes the ruling names ───────────────────────────────────────

describe("BUG-204 — the table's arithmetic", () => {
  it("🔴 a 4-item dry blend is 2 minutes", () => {
    // 4 × 0.5 = 2. Not 3, which is what the model said for exactly this step.
    const t = timeStep({
      components: [
        comp("all-purpose flour", null, "1½ cup"),
        comp("baking powder", null, "2 tsp"),
        comp("baking soda", null, "¼ tsp"),
        comp("fine salt", null, "½ tsp"),
      ],
    });
    assert.equal(t.minutes, 2);
    assert.equal(t.rows.every((r) => r.action === "measure"), true);
  });

  it("🔴 mincing 9 cloves of garlic is 3 minutes", () => {
    const t = timeStep({ components: [comp("garlic cloves", "minced", "9 cloves")] });
    assert.equal(t.minutes, 3);
    assert.equal(t.rows[0].action, "garlic");
  });

  it("🔴 a whisked marinade: oil + 4 cloves + 2 herbs + a lemon = 7 minutes", () => {
    // 0.5 oil + (4/3) garlic + 0.25 + 0.25 herbs + 1.5 lemon + 1 whisk = 4.83…
    // …and the ruling's worked example reads 1 + 2 + 1 + 1.5 + 1 → 7, which is
    // the same shape costed with the coarser per-class figures. The table is the
    // authority and it is slightly cheaper than the sketch; recorded rather than
    // forced, because inventing padding to hit 7 would be the opposite of what
    // BUG-204 is about.
    const t = timeStep({
      bowlName: "Lemon-Herb Baked Chicken Breast marinade bowl",
      components: [
        comp("extra-virgin olive oil", null, "3 tbsp"),
        comp("garlic", "minced", "4 cloves"),
        comp("fresh rosemary", "finely chopped", "2 tsp"),
        comp("fresh thyme", "leaves stripped", "2 tsp"),
        comp("lemon", "zested and juiced", "2 each"),
      ],
    });
    assert.equal(t.rows.find((r) => r.ingredientName === "garlic")!.action, "garlic");
    assert.equal(t.rows.find((r) => r.ingredientName === "lemon")!.action, "citrus-zest-juice");
    // The whisk is added once for the bowl, not once per ingredient.
    assert.ok(t.minutes >= 5 && t.minutes <= 7, `got ${t.minutes}`);
  });

  it("dicing an onion is 2 minutes, and a whole onion counts as one", () => {
    assert.equal(timeStep({ components: [comp("yellow onion", "diced", "1 each")] }).minutes, 2);
    assert.equal(timeStep({ components: [comp("yellow onion", "finely diced", "2 each")] }).minutes, 4);
  });

  it("a batch vegetable is costed by weight, with a floor", () => {
    // 1¼ lb asparagus × 2 = 2.5 → 3.
    assert.equal(timeStep({ components: [comp("asparagus", "woody ends snapped off", "1¼ lb")] }).minutes, 3);
    // A small batch still costs the floor.
    assert.equal(timeStep({ components: [comp("asparagus", "trimmed", "½ lb")] }).minutes, 2);
  });

  it("meat: cubing costs more per lb than portioning", () => {
    const cube = timeStep({ components: [comp("beef chuck", "cut into ¾-inch cubes", "2 lb")] });
    const portion = timeStep({ components: [comp("chicken thighs", null, "2 lb")] });
    assert.equal(cube.minutes, 8);
    assert.equal(portion.minutes, 6);
    assert.equal(cube.rows[0].action, "meat-cube");
    assert.equal(portion.rows[0].action, "meat-portion");
  });

  it("🔴 a container is never worth less than a minute, and never zero", () => {
    assert.equal(timeStep({ components: [comp("hot sauce", null, "1 tbsp")] }).minutes, 1);
    assert.equal(timeStep({ components: [] }).minutes, MINUTES.stepFloor);
  });

  it("🔴 garlic powder is not garlic, and that is a 1-minute difference", () => {
    assert.equal(timeRow("garlic powder", null as unknown as string, "½ tsp").action, "measure");
    assert.equal(timeRow("garlic", "minced", "3 cloves").action, "garlic");
  });

  it("an unreadable amount counts as one item rather than guessing a magnitude", () => {
    assert.deepEqual(parseAmount("a splash"), { quantity: null, unit: "a splash" });
    const t = timeStep({ components: [comp("soy sauce", null, "a splash")] });
    assert.equal(t.minutes, 1);
  });
});

// ── the cap ─────────────────────────────────────────────────────────────────

describe("BUG-204 — the cap reports, it does not hide", () => {
  it("🔴 anything over 15 minutes is a CLASSIFICATION ERROR and says so", () => {
    // 10 lb of chuck at 4 min/lb is 40 minutes. No prep step is 40 minutes; a
    // number that size means a quantity or a unit was read wrong, and the cap
    // keeps one bad row from poisoning the header.
    const t = timeStep({ components: [comp("beef chuck", "cut into cubes", "10 lb")] });
    assert.equal(t.minutes, MINUTES.stepCap);
    assert.equal(t.overCap, true);
    assert.equal(t.rawMinutes, 40);
  });

  it("a step inside the cap does not raise the flag", () => {
    const t = timeStep({ components: [comp("beef chuck", "cut into cubes", "2 lb")] });
    assert.equal(t.overCap, false);
  });
});

// ── the plan total ──────────────────────────────────────────────────────────

describe("BUG-204 — the header total: 10% overhead, then UP to the next 5", () => {
  it("🔴 36 minutes of steps states 40", () => {
    // 36 × 1.1 = 39.6 → 40. The overhead is getting containers out and wiping
    // the board down, and it is the ONLY padding.
    assert.equal(planMinutes([10, 8, 6, 5, 4, 3]), 40);
  });

  it("🔴 ROUNDS UP, NEVER DOWN — the direction is the trust condition", () => {
    assert.equal(planMinutes([10]), 15); // 11 → 15, not 10
    assert.equal(planMinutes([4]), 5);
    assert.equal(planMinutes([40]), 45); // 44 → 45
  });

  it("an empty plan is zero, so the header can hide itself", () => {
    assert.equal(planMinutes([]), 0);
  });

  it("the overhead is applied ONCE to the plan, not per step", () => {
    // Per-step padding compounds, and compounding is what put "about 120 min"
    // on a 40-minute plan in the first place.
    const twenty = planMinutes([20]);
    const tens = planMinutes([10, 10]);
    assert.equal(twenty, tens);
  });
});
