// SERVER-7 A (BUG-559, ruled D-WS9-337) — THE WEIGHT RULE'S THAW, WEIGHT OR NO WEIGHT.
// USDA keeps a thawed bird 1–2 days in the fridge; the authored "6 days, Friday" left a
// 14-lb bird thawed about 2½ days before the roast. With no weight chosen, the meal read
// and the Hub's row thaw the bird by weighedThaw at the recipe's own weight, and the
// bird row's note says that day. The authored weight and no weight agree on the thaw;
// nothing else in a null-weight read moves.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyBirdWeightToRead } from "../birdWeightRead";
import { makeAheadForPlan } from "../makeAheadSchedule";

type Row = { name: string; quantity: number; unit: string; preparationNote: string | null };
type Step = { stepIndex: number; text: string; estimatedMinutes: number; phaseType: string; amountRefs: null; unmatchedAmount: boolean };
const st = (stepIndex: number, text: string, estimatedMinutes = 5, phaseType = "cook"): Step => ({ stepIndex, text, estimatedMinutes, phaseType, amountRefs: null, unmatchedAmount: false });

// Dev's three families, as the census read them (scripts/_scratch/server-7/birds.json).
const FAMILIES = {
  // Classic "with All the Trimmings": the row's note names the day too.
  classic: {
    tags: ["thaw-6d", "brine-wed"],
    rows: [
      { name: "whole turkey", quantity: 14, unit: "pound", preparationNote: "thawed (move from freezer to fridge Friday if frozen); neck and giblets reserved for gravy" },
      { name: "kosher salt", quantity: 0.5, unit: "cup", preparationNote: null },
    ],
    steps: [
      st(0, "Thaw (start Friday): if the turkey is frozen, move it to the fridge on Friday — a 14-lb bird takes 3–4 days to thaw fully, so it will be ready by Monday night.", 5, "prep"),
      st(1, "Make ahead (Wednesday night): Rub the turkey all over with the salt and refrigerate uncovered.", 10, "prep"),
      st(2, "Roast the turkey at 325°F for about 3 hours, until the thigh reads 165°F.", 187),
    ],
  },
  // Make-Ahead: brined Tuesday night, so 4 fridge days start Friday — the day does not move.
  makeAhead: {
    tags: ["thaw-6d", "brine-tue"],
    rows: [{ name: "whole turkey", quantity: 14, unit: "pound", preparationNote: "thawed; neck and giblets reserved for gravy" }],
    steps: [
      st(0, "Thaw (start Friday): If the turkey is frozen, move it to the fridge on Friday — a 14-lb bird needs 3–4 days to thaw fully. Keep it in its original packaging on a rimmed tray.", 5, "prep"),
      st(1, "Roast the turkey at 325°F for about 2¾ hours.", 171),
    ],
  },
  // New Twist (an older copy): one spatchcock bird by count, its weight in the name.
  newTwist: {
    tags: ["thaw-6d", "brine-wed"],
    rows: [{ name: "whole turkey (12–14 lb)", quantity: 1, unit: "each", preparationNote: "neck and giblets reserved for gravy; backbone removed (spatchcocked)" }],
    steps: [
      st(0, "Thaw (start Friday): If the turkey is frozen, move it to the fridge on Friday — a 12–14 lb bird needs 3–4 days to thaw fully before Wednesday's brine.", 5, "prep"),
      st(1, "Roast the spatchcocked turkey at 425°F for about 1¾ hours.", 104),
    ],
  },
} as const;
type Family = keyof typeof FAMILIES;

function meal(f: Family) {
  const fam = FAMILIES[f];
  const title = f === "newTwist" ? "Citrus-Herb Spatchcock Turkey" : "Herb-Roasted Whole Turkey";
  return {
    tags: ["thanksgiving-feast"],
    dishes: [
      { dishId: "bird", title, servings: 10, authoredServingsDefault: 10, ingredients: fam.rows.map((r) => ({ ...r })) as Row[], steps: fam.steps.map((s) => ({ ...s })) as Step[] },
      { dishId: "stuffing", title: "Sage and Onion Stuffing", servings: 10, authoredServingsDefault: 10, ingredients: [{ name: "yellow onion", quantity: 2, unit: "each", preparationNote: "diced" }] as Row[], steps: [st(0, "Make ahead (Wednesday): Dry the bread cubes.", 10)] },
    ],
  };
}
const prismaFor = (f: Family) => ({ dish: { findUnique: async () => ({ tags: [...FAMILIES[f].tags] }) } }) as never;

async function read(f: Family, birdWeightLb: number | null, assignedDayOfWeek: string | null = "Thursday") {
  const m = meal(f);
  const stored = new Map(m.dishes.map((d) => [d.dishId, d.steps.map((s) => s.text)]));
  const fields = await applyBirdWeightToRead(prismaFor(f), m, { birdWeightLb, servingsOverride: null, assignedDayOfWeek }, stored);
  return { m, fields };
}
const thawText = (m: ReturnType<typeof meal>) => m.dishes[0].steps[0].text;
const birdNote = (m: ReturnType<typeof meal>) => m.dishes[0].ingredients[0].preparationNote;

describe("SERVER-7 A — the meal read's thaw with no weight chosen", () => {
  it("Classic: Friday → Saturday, 4 days, ready by Wednesday night; the note says Saturday", async () => {
    const { m } = await read("classic", null);
    assert.equal(thawText(m), "Thaw (start Saturday): If the turkey is frozen, move it to the fridge on Saturday — a 14-lb bird takes about 4 days to thaw fully, so it is ready by Wednesday night.");
    assert.equal(birdNote(m), "thawed (move from freezer to fridge Saturday if frozen); neck and giblets reserved for gravy");
  });

  it("Make-Ahead: the day stays Friday (Tuesday's brine), the words are the rule's", async () => {
    const { m } = await read("makeAhead", null);
    assert.equal(thawText(m), "Thaw (start Friday): If the turkey is frozen, move it to the fridge on Friday — a 14-lb bird takes about 4 days to thaw fully, so it is ready by Tuesday night.");
    assert.equal(birdNote(m), "thawed; neck and giblets reserved for gravy");
  });

  it("New Twist, by count: the name's 14 lb, Saturday", async () => {
    const { m } = await read("newTwist", null);
    assert.match(thawText(m), /^Thaw \(start Saturday\): .* a 14-lb bird takes about 4 days to thaw fully, so it is ready by Wednesday night\.$/);
  });

  it("counted back from the brine, not the feast: a Friday feast still thaws from Saturday; unscheduled is Thursday", async () => {
    const { m } = await read("classic", null, "Friday");
    assert.match(thawText(m), /^Thaw \(start Saturday\).*ready by Wednesday night\.$/);
    const unscheduled = await read("classic", null, null);
    assert.equal(thawText(unscheduled.m), thawText((await read("classic", null)).m));
  });

  for (const f of Object.keys(FAMILIES) as Family[]) {
    it(`${f}: the authored weight and no weight say the same thaw (step and note)`, async () => {
      const none = await read(f, null);
      const authored = await read(f, 14);
      assert.equal(thawText(authored.m), thawText(none.m));
      assert.equal(birdNote(authored.m), birdNote(none.m));
    });

    it(`${f}: with no weight, nothing but the thaw step and the bird's note moves`, async () => {
      const before = meal(f);
      const { m, fields } = await read(f, null);
      const blank = (x: ReturnType<typeof meal>) => {
        const c = structuredClone(x);
        c.dishes[0].steps[0] = { ...c.dishes[0].steps[0], text: "", unmatchedAmount: false };
        c.dishes[0].ingredients[0] = { ...c.dishes[0].ingredients[0], preparationNote: "" };
        return JSON.stringify(c);
      };
      assert.equal(blank(m), blank(before));
      assert.equal(fields?.birdWeightLb, null);
    });
  }

  it("a chosen weight still says its own thaw (THX-4), and its note follows", async () => {
    const { m } = await read("classic", 18);
    assert.match(thawText(m), /^Thaw \(start Friday\): .* an? 18-lb bird takes about 5 days/);
    assert.match(birdNote(m)!, /fridge Friday if frozen/);
  });
});

describe("SERVER-7 A — the Hub's thaw row with no weight chosen", () => {
  const plan = (f: Family, birdWeightLb: number | null) => ({
    startDate: new Date("2026-11-22T00:00:00Z"),
    items: [{
      id: "item", mealId: "feast", assignedDayOfWeek: "Thursday", birdWeightLb,
      meal: {
        tags: ["thanksgiving-feast"],
        dishes: meal(f).dishes.map((d) => ({ dishId: d.dishId, title: d.title, steps: d.steps.map((s) => ({ text: s.text })), ingredients: d.ingredients })),
      },
    }],
  });
  const prisma = (f: Family) => ({ dish: { findMany: async () => [{ id: "bird", tags: [...FAMILIES[f].tags] }, { id: "stuffing", tags: ["ahead-wed"] }] } }) as never;
  const thawRow = async (f: Family, lb: number | null) => (await makeAheadForPlan(prisma(f), plan(f, lb)))!.rows.find((r) => r.kind === "thaw")!;

  it("Classic: Saturday, 5 days out (was the tag's Friday, 6)", async () => {
    const r = await thawRow("classic", null);
    assert.deepEqual([r.dayName, r.daysBefore, r.thawDays, r.date], ["Saturday", 5, 5, "2026-11-21"]);
  });

  it("Make-Ahead: Friday, 6 days out, as before", async () => {
    const r = await thawRow("makeAhead", null);
    assert.deepEqual([r.dayName, r.daysBefore], ["Friday", 6]);
  });

  for (const f of Object.keys(FAMILIES) as Family[]) {
    it(`${f}: the authored weight and no weight give the same schedule`, async () => {
      assert.deepEqual(await makeAheadForPlan(prisma(f), plan(f, null)), await makeAheadForPlan(prisma(f), plan(f, 14)));
    });
  }
});
