// THX-3d round 2 — H (two phases, two steps), I (the put-in step), J (the warm steps),
// K (every step names its subject): the content passes, on the real sentences.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { splitTwoPhase } from "./thx2Phases";

describe("THX-3d H — a two-phase bake or roast is two timed steps", () => {
  it("Classic's stuffing: covered 30, then uncovered 20–25", () => {
    assert.deepEqual(splitTwoPhase("On Thursday: Bake the stuffing covered for 30 minutes, then uncover and bake 20–25 minutes more until the top is golden and the center is set.", 55), {
      first: "On Thursday: Bake the stuffing covered for 30 minutes.",
      second: "Uncover and bake 20–25 minutes more until the top is golden and the center is set.",
      firstMinutes: 30, secondMinutes: 25,
    });
  });
  it("Small's breast: the temperature change is its own step; a make-ahead pie keeps its day on both", () => {
    const b = splitTwoPhase("Set the turkey breast skin-side up on the vegetable bed and roast at 425°F for 20 minutes to brown the skin, then reduce the oven to 325°F and continue roasting for about 30 minutes.", 49)!;
    assert.equal(b.second, "Reduce the oven to 325°F and continue roasting for about 30 minutes.");
    assert.deepEqual([b.firstMinutes, b.secondMinutes], [20, 30]);
    const p = splitTwoPhase("Make ahead (Wednesday): Bake at 425°F for 15 minutes, then reduce the oven to 350°F and bake 40–45 minutes more until set.", 15)!;
    assert.equal(p.second, "Make ahead (Wednesday): Reduce the oven to 350°F and bake 40–45 minutes more until set.");
    assert.equal(p.secondMinutes, 45, "the second phase takes its own minutes");
  });
  it("New Twist's Parmesan and Make-Ahead's cheddar: \"; scatter … and roast/bake N more\"", () => {
    assert.equal(splitTwoPhase("Roast at 350°F for 20 minutes; scatter 1 cup finely grated Parmesan over the potatoes and roast 5–8 minutes more until crisp.", 28)?.second, "Scatter 1 cup finely grated Parmesan over the potatoes and roast 5–8 minutes more until crisp.");
    assert.equal(splitTwoPhase("On Thursday: Bake the casserole, still covered in foil, for 45 minutes; uncover, scatter 1 cup cheddar over the top, and bake 15 minutes more.", 60)?.firstMinutes, 45);
  });
  it("a second clause out of the oven is no phase (\"; cool at least 20 minutes\"), and each half is one phase", () => {
    assert.equal(splitTwoPhase("Bake the apple crisp uncovered at 350°F for 45–50 minutes until golden; cool at least 20 minutes before serving.", 48), null);
    assert.equal(splitTwoPhase("Bake the pie at 350°F for 30 minutes, then top with 1 cup whipped cream and let it stand 10 minutes.", 30), null);
    assert.equal(splitTwoPhase("On Thursday: Bake the stuffing covered for 30 minutes.", 30), null);
    assert.equal(splitTwoPhase("Uncover and bake 20–25 minutes more until golden.", 25), null);
  });
});
