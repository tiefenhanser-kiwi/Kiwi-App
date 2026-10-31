// SERVER-13 D (BUG-628) — a feast's Cook Mode cues tell the truth, as SEQ-1 made an
// everyday meal's (BUG-596, cookStateOf). The feast's cues were frozen on
// passiveStateOf, whose `brin\w*` (meant for brine) read "Bring to a boil" as
// brining: "With the Mashed Potatoes marinating" on Thanksgiving. Only the cue words
// change; the feast's steps, order and times are its own (scripts/thx2/feastCues.ts
// diffs every dev feast: 1,284 cue lines, nothing else).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { scheduleCookingSequence, type SchedulerDish, type SchedulerPhase } from "../cookingScheduler";

const st = (stepIndex: number, phaseType: SchedulerPhase, estimatedMinutes: number, text: string, isTimingSensitive = false) => ({ stepIndex, phaseType, estimatedMinutes, text, isTimingSensitive });
const dish = (dishId: string, title: string, positionIndex: number, steps: ReturnType<typeof st>[]): SchedulerDish => ({ dishId, title, positionIndex, steps });

const MASH = dish("mash", "Mashed Potatoes", 1, [
  st(0, "prep", 10, "On Thursday: Peel and cut 5 lb russet potatoes into 2-inch chunks and cover with cold water in a large pot."),
  st(1, "cook", 25, "Bring to a boil over high heat, then reduce to a vigorous simmer and cook until fork-tender, 15–20 minutes."),
  st(2, "cook", 3, "Drain the potatoes and return them to the pot.", true),
  st(3, "assemble", 4, "Mash with the butter and warm milk; season and transfer to a warmed bowl."),
]);
const GRAVY = dish("gravy", "Pan Gravy", 2, [
  st(0, "prep", 4, "On Thursday: Pour the turkey drippings into a fat separator."),
  st(1, "cook", 4, "Whisk the flour into 4 tablespoons of the fat over medium heat.", true),
  st(2, "cook", 10, "Gradually whisk in the stock and simmer until thickened."),
  st(3, "assemble", 2, "Season and pour into a warmed gravy boat."),
]);
const STUFFING = dish("stuffing", "Herb Stuffing", 0, [
  st(9, "cook", 55, "On Thursday: Preheat the oven to 350°F; bake the stuffing covered for 30 minutes, then uncover and bake 20–25 minutes more."),
  st(10, "assemble", 2, "Serve the stuffing directly from the 9×13-inch baking dish."),
]);

const cues = (ds: SchedulerDish[]) => scheduleCookingSequence(ds, { feastOven: true }).steps.map((s) => s.reason).filter((r): r is string => !!r);

describe("SERVER-13 D — a feast's cues name what the dish is doing", () => {
  it("a pot brought to a boil is simmering, never marinating", () => {
    const got = cues([MASH, GRAVY]);
    assert.ok(got.includes("With the Mashed Potatoes simmering, start on the Pan Gravy."), JSON.stringify(got));
    assert.ok(!got.some((c) => /marinating/.test(c)), JSON.stringify(got));
  });

  it("a dish baking is in the oven (it read \"cooking\")", () => {
    const got = cues([STUFFING, MASH, GRAVY]);
    assert.ok(got.includes("With the Herb Stuffing in the oven, start on the Mashed Potatoes."), JSON.stringify(got));
    assert.ok(!got.some((c) => /\bcooking,/.test(c)), JSON.stringify(got));
  });
});
