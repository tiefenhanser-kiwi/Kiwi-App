// THX-3d round 4 — the content half (patch.ts): what the raise puts in, what waits, the
// put-in steps, the sheet-pan counts (BUG-496).
//   node --import tsx --test scripts/thx2/thx2Round4.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { panCountEdits, type OvenDish, type OvenStepRow } from "./thx2Oven";
import { putInEdits } from "./thx2PutIn";
import { thursdayPostPass } from "./thx2Thursday";

const row = (ownerId: string, stepIndex: number, phaseType: string, estimatedMinutes: number, text: string): OvenStepRow => ({
  ownerId, stepIndex, stepTextTranslated: text, phaseType, estimatedMinutes, isTimingSensitive: false, parallelGroup: null, componentKey: null, pathKey: null,
});
const BIRD: OvenDish = { dishId: "t", title: "Herb-Roasted Whole Turkey", positionIndex: 0 };
const birdRows = (raise: string | null): OvenStepRow[] => [
  row("t", 0, "prep", 5, "On Thursday: Pat the turkey dry."),
  row("t", 1, "preheat", 15, "Preheat the oven to 325°F."),
  ...(raise
    ? [row("t", 2, "cook", 150, "Roast the turkey at 325°F for about 2½ hours."), row("t", 3, "preheat", 5, raise), row("t", 4, "cook", 20, "Keep roasting the turkey at 350°F for about 20 more minutes, until an instant-read thermometer in the thickest part of the thigh reads 165°F."), row("t", 5, "rest", 25, "Transfer the turkey to a carving board and rest 20–30 minutes."), row("t", 6, "assemble", 10, "Carve the turkey.")]
    : [row("t", 2, "cook", 180, "Roast the turkey at 325°F for about 3 hours, until the thigh reads 165°F."), row("t", 3, "rest", 25, "Transfer the turkey to a carving board and rest 20–30 minutes."), row("t", 4, "assemble", 10, "Carve the turkey.")]),
];
const casserole = (id: string, title: string, pos: number, covered: number, uncovered: number): { dish: OvenDish; rows: OvenStepRow[] } => ({
  dish: { dishId: id, title, positionIndex: pos, ovenRacks: 0.5, ovenVessel: "dish" },
  rows: [
    row(id, 0, "prep", 5, "Make ahead (Wednesday): Spread it in a buttered 9×13-inch baking dish, cover with foil and refrigerate."),
    row(id, 1, "cook", covered, `On Thursday: Bake the ${title.toLowerCase()} covered at 350°F for ${covered} minutes.`),
    row(id, 2, "cook", uncovered, `Uncover and bake ${uncovered} minutes more.`),
  ],
});

describe("THX-3d round 4 (A3) — the raise names only what fits beside the bird", () => {
  it("the bird and three 9×13s: the raise names two, the third goes in when the turkey comes out", () => {
    const s = casserole("s", "Sage Stuffing", 1, 30, 15);
    const g = casserole("g", "Green Bean Casserole", 2, 25, 15);
    const p = casserole("p", "Sweet Potato Casserole", 3, 25, 15);
    const dishes = [BIRD, s.dish, g.dish, p.dish];
    const e = thursdayPostPass(dishes, [...birdRows(null), ...s.rows, ...g.rows, ...p.rows]);
    const raise = e.creates.find((c) => /^Raise the oven/.test(c.text))!;
    assert.equal(raise.text, "Raise the oven to 350°F and put in the Sage Stuffing and Green Bean Casserole; the Sweet Potato Casserole goes in when the turkey comes out.");
  });

  it("nothing waits when all fits beside the bird (Make-Ahead's two 9×13s)", () => {
    const s = casserole("s", "Sage Stuffing", 1, 35, 15);
    const m = casserole("m", "Mashed Potato Casserole", 2, 45, 15);
    const e = thursdayPostPass([BIRD, s.dish, m.dish], [...birdRows(null), ...s.rows, ...m.rows]);
    assert.equal(e.creates.find((c) => /^Raise the oven/.test(c.text))!.text, "Raise the oven to 350°F and put in the Sage Stuffing and Mashed Potato Casserole.");
  });

  it("an existing raise is rewritten in place, and a side it no longer names gets its own put-in", () => {
    const s = casserole("s", "Sage Stuffing", 1, 30, 15);
    const sweet: OvenDish = { dishId: "v", title: "Maple-Roasted Sweet Potatoes", positionIndex: 2, ovenRacks: 1, ovenVessel: "sheet" };
    const vRows = [row("v", 0, "prep", 2, "On Thursday: Spread the sweet potatoes on a large rimmed sheet pan."), row("v", 1, "cook", 35, "The sweet potatoes are in at 350°F. Roast 30–35 minutes.")];
    const sRows = [s.rows[0], row("s", 1, "cook", 30, "On Thursday: The stuffing is in at 350°F, covered. Bake 30 minutes."), row("s", 2, "cook", 15, "Uncover and bake 15 minutes more.")];
    const rows = [...birdRows("Raise the oven to 350°F and put in the Sage Stuffing and Maple-Roasted Sweet Potatoes."), ...sRows, ...vRows];
    const e = thursdayPostPass([BIRD, s.dish, sweet], rows);
    const text = e.updates.find((u) => u.dishId === "t" && u.stepIndex === 3)?.text;
    assert.equal(text, "Raise the oven to 350°F and put in the Sage Stuffing; the Maple-Roasted Sweet Potatoes go in when the turkey comes out.");
    const after = rows.map((r) => (r.ownerId === "t" && r.stepIndex === 3 ? { ...r, stepTextTranslated: text! } : r));
    const p = putInEdits([BIRD, s.dish, sweet], after);
    assert.deepEqual(p.creates.map((c) => [c.dishId, c.stepIndex, c.text]), [["v", 1, "Put the sweet potatoes in the oven now that the turkey is out."]]);
    assert.deepEqual(p.renumber, [{ dishId: "v", from: 1, to: 2 }]);
  });

  it("when what waits would not fit beside the raise's sides, they are done as the bird comes out: covered, then reheated", () => {
    const s = casserole("s", "Cornbread Stuffing", 1, 30, 12);
    const pot: OvenDish = { dishId: "k", title: "Smashed Potatoes", positionIndex: 2, ovenRacks: 2, ovenVessel: "sheet" };
    const kRows = [row("k", 0, "prep", 3, "On Thursday: Brush two rimmed sheet pans with oil."), row("k", 1, "cook", 35, "Roast at 350°F for 30–35 minutes.")];
    const e = thursdayPostPass([BIRD, s.dish, pot], [...birdRows(null), ...s.rows, ...kRows]);
    const keep = e.creates.find((c) => /^Keep roasting/.test(c.text))!;
    assert.equal(keep.estimatedMinutes, 42, "the bird roasts the stuffing's whole 42 minutes after the raise");
    assert.deepEqual(e.creates.filter((c) => c.dishId === "s").map((c) => c.text), [
      "Cover the Cornbread Stuffing with foil to keep it warm.",
      "Return the Cornbread Stuffing, uncovered, to the 350°F oven for 10 minutes, until hot again.",
    ]);
    assert.match(e.creates.find((c) => /^Raise the oven/.test(c.text))!.text, /; the Smashed Potatoes go in when the turkey comes out\.$/);
  });
});

describe("THX-3d round 4 (A1) — the sheet pans, as the pounds need them", () => {
  it("a 5 lb dish written on 'two' pans is corrected to three; one already right is left", () => {
    const big: OvenDish = { dishId: "b", title: "Roasted Brussels Sprouts", positionIndex: 1, ovenRacks: 3, ovenVessel: "sheet" };
    const ok: OvenDish = { dishId: "o", title: "Roasted Carrots", positionIndex: 2, ovenRacks: 1, ovenVessel: "sheet" };
    const rows = [...birdRows(null), row("b", 0, "prep", 3, "On Thursday: Spread the sprouts across two large rimmed sheet pans."), row("b", 1, "cook", 25, "Roast at 325°F for 25 minutes."), row("o", 0, "prep", 3, "On Thursday: Spread the carrots on a rimmed sheet pan."), row("o", 1, "cook", 25, "Roast at 325°F for 25 minutes.")];
    assert.deepEqual(panCountEdits([BIRD, big, ok], rows), [{ dishId: "b", stepIndex: 0, text: "On Thursday: Spread the sprouts across three large rimmed sheet pans." }]);
  });
});
