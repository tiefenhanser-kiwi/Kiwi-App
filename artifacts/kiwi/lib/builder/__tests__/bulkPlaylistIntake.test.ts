// WS9 Redesign Arc Block 2c Part A (D-WS9-244) — the bulk intake runner.
//
// Pins the specification: one Ask-Kiwi call per NON-EMPTY box, ONE AT A TIME,
// in box order (the ordering assertion below reads the interleaving, not the
// count); a middle box that throws does not stop the others and loses
// nothing already saved; empty boxes are skipped; the save body is what the
// Meal Builder posts for an untouched draft; Retry on a saved-but-not-added
// box re-runs only the add.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ParseMealInput, ParseMealResult } from "@/lib/api/builder";
import { ApiError, UpgradeRequiredError } from "@/lib/api/errors";
import type { SaveMealInput } from "@/lib/api/meals";
import {
  addBox,
  BULK_UPGRADE_MESSAGE,
  draftToSaveMealInput,
  initialBoxes,
  retryBox,
  runBulkIntake,
  runnableBoxes,
  savedBoxes,
  setBoxText,
  type BulkBox,
} from "../bulkPlaylistIntake";
import { parsedMealToDraft } from "../parsedMealToDraft";

function parsed(title: string): ParseMealResult {
  return {
    meal: {
      title,
      cuisine: "American",
      estimatedPrepMinutes: 10,
      estimatedCookMinutes: 20,
      servingsDefault: 4,
      difficulty: "easy",
      tags: ["weeknight"],
      subDishes: [
        {
          title,
          ingredients: [{ name: "chicken", quantity: 1, unit: "lb" }],
          steps: [
            { content: "Cook it.", estimatedMinutes: 20, isTimingSensitive: false, phaseType: "cook" },
          ],
        },
      ],
    },
  } as ParseMealResult;
}

function defer<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(opts: {
  parseImpl?: (input: ParseMealInput, n: number) => Promise<ParseMealResult>;
  addImpl?: (mealId: string) => Promise<unknown>;
} = {}) {
  const log: string[] = [];
  const updates: BulkBox[] = [];
  let n = 0;
  let saved = 0;
  const deps = {
    parseMeal: async (input: ParseMealInput) => {
      n += 1;
      log.push(`parse:${input.freeText}`);
      const r = opts.parseImpl ? await opts.parseImpl(input, n) : parsed(`Meal ${input.freeText}`);
      log.push(`parsed:${input.freeText}`);
      return r;
    },
    saveMeal: async (input: SaveMealInput) => {
      saved += 1;
      log.push(`save:${input.title}`);
      return { id: `m${saved}`, dishIds: [], linksCreated: 0 };
    },
    addToPlaylist: async (mealId: string) => {
      log.push(`add:${mealId}`);
      if (opts.addImpl) return opts.addImpl(mealId);
      return {};
    },
    servings: 4,
    onBoxUpdate: (b: BulkBox) => updates.push(b),
  };
  return { deps, log, updates };
}

function filled(texts: string[]): BulkBox[] {
  let boxes = initialBoxes(texts.length);
  texts.forEach((t, i) => {
    boxes = setBoxText(boxes, boxes[i].id, t);
  });
  return boxes;
}

test("three filled boxes → three parse calls IN SEQUENCE (each finishes before the next starts) → three saves → three adds", async () => {
  const gates = [defer<void>(), defer<void>(), defer<void>()];
  const { deps, log } = harness({
    parseImpl: async (input, n) => {
      await gates[n - 1].promise;
      return parsed(`Meal ${input.freeText}`);
    },
  });
  const run = runBulkIntake(filled(["tacos", "pizza", "salad"]), deps);
  await new Promise((r) => setTimeout(r, 5));
  // 🔴 THE BREAK THIS CATCHES (Promise.all): all three parses would be in
  // flight here. Sequential = ONLY the first has started.
  assert.deepEqual(log, ["parse:tacos"], "only the first box is in flight");
  gates[0].resolve();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(log, ["parse:tacos", "parsed:tacos", "save:Meal tacos", "add:m1", "parse:pizza"]);
  gates[1].resolve();
  gates[2].resolve();
  const outcome = await run;
  assert.deepEqual(log, [
    "parse:tacos", "parsed:tacos", "save:Meal tacos", "add:m1",
    "parse:pizza", "parsed:pizza", "save:Meal pizza", "add:m2",
    "parse:salad", "parsed:salad", "save:Meal salad", "add:m3",
  ]);
  assert.deepEqual(outcome.saved, [
    { mealId: "m1", title: "Meal tacos" },
    { mealId: "m2", title: "Meal pizza" },
    { mealId: "m3", title: "Meal salad" },
  ]);
  assert.deepEqual(outcome.failed, []);
  assert.equal(outcome.upgradeRequired, false);
});

test("a middle box that throws → the other two still save; the failed box keeps its text and reads failed with a message", async () => {
  const { deps, log, updates } = harness({
    parseImpl: async (input) => {
      if (input.freeText === "pizza") throw new ApiError("Request failed (502)", { status: 502, body: { error: "ai_failed" } });
      return parsed(`Meal ${input.freeText}`);
    },
  });
  const boxes = filled(["tacos", "pizza", "salad"]);
  const outcome = await runBulkIntake(boxes, deps);
  assert.deepEqual(outcome.saved.map((s) => s.mealId), ["m1", "m2"]);
  assert.deepEqual(outcome.failed, [boxes[1].id]);
  assert.ok(!log.includes("save:Meal pizza"));
  const last = (id: string) => [...updates].reverse().find((u) => u.id === id)!;
  assert.equal(last(boxes[0].id).status, "saved");
  assert.equal(last(boxes[1].id).status, "failed");
  assert.equal(last(boxes[1].id).text, "pizza", "the failed box keeps its text");
  assert.ok(last(boxes[1].id).error, "a message for the row");
  assert.equal(last(boxes[2].id).status, "saved");
});

test("empty boxes are skipped; 'Add another meal' grows the list; a saved box is not re-run", () => {
  let boxes = initialBoxes();
  assert.equal(boxes.length, 3);
  boxes = addBox(boxes);
  assert.equal(boxes.length, 4);
  boxes = setBoxText(boxes, boxes[0].id, "tacos");
  boxes = setBoxText(boxes, boxes[2].id, "   ");
  boxes = setBoxText(boxes, boxes[3].id, "salad");
  assert.deepEqual(runnableBoxes(boxes).map((b) => b.text), ["tacos", "salad"]);
  const done = boxes.map((b, i) => (i === 0 ? { ...b, status: "saved" as const, mealId: "m1", title: "Tacos" } : b));
  assert.deepEqual(runnableBoxes(done).map((b) => b.text), ["salad"]);
  assert.deepEqual(savedBoxes(done), [{ mealId: "m1", title: "Tacos" }]);
});

test("empty boxes make no calls at all", async () => {
  const { deps, log } = harness();
  const boxes = setBoxText(initialBoxes(), initialBoxes()[0].id, "");
  const outcome = await runBulkIntake(boxes, deps);
  assert.deepEqual(log, []);
  assert.deepEqual(outcome.saved, []);
});

test("the save body is what the Meal Builder posts for an untouched draft (per-dish steps, directed source, hard→fancy)", () => {
  const draft = parsedMealToDraft(parsed("Chicken Thighs").meal);
  const input = draftToSaveMealInput({ ...draft, difficulty: "hard" });
  assert.equal(input.title, "Chicken Thighs");
  assert.equal(input.sourceType, "directed");
  assert.equal(input.difficulty, "fancy");
  assert.equal(input.cuisineType, "American");
  assert.equal(input.estimatedTimeMinutes, 30);
  assert.equal(input.servingsDefault, 4);
  assert.equal(input.dishes.length, 1);
  const dish = input.dishes[0] as { kind: string; steps?: { text: string; phaseType?: string }[]; ingredients?: unknown[] };
  assert.equal(dish.kind, "new");
  assert.equal(dish.steps?.[0].text, "Cook it.");
  assert.equal(dish.steps?.[0].phaseType, "cook", "BUG-273/278 — phaseType survives");
});

test("saved-but-not-added → failed WITH the meal id; Retry re-runs ONLY the add (no second save)", async () => {
  let addCalls = 0;
  const { deps, log, updates } = harness({
    addImpl: async () => {
      addCalls += 1;
      if (addCalls === 1) throw new ApiError("Request failed (500)", { status: 500, body: {} });
      return {};
    },
  });
  const boxes = filled(["tacos"]);
  const first = await runBulkIntake(boxes, deps);
  assert.deepEqual(first.saved, []);
  const failedBox = [...updates].reverse().find((u) => u.id === boxes[0].id)!;
  assert.equal(failedBox.status, "failed");
  assert.equal(failedBox.mealId, "m1", "the meal id rides on the failed box");
  const second = await retryBox(failedBox, deps);
  assert.deepEqual(second.saved, [{ mealId: "m1", title: "Meal tacos" }]);
  assert.deepEqual(log, ["parse:tacos", "parsed:tacos", "save:Meal tacos", "add:m1", "add:m1"]);
});

test("a 402 stops the run: that box fails with the upgrade message, the rest go back to idle untouched", async () => {
  const { deps, log, updates } = harness({
    parseImpl: async () => {
      throw new UpgradeRequiredError({ status: 402, body: { error: "upgrade_required" } });
    },
  });
  const boxes = filled(["tacos", "pizza"]);
  const outcome = await runBulkIntake(boxes, deps);
  assert.equal(outcome.upgradeRequired, true);
  assert.deepEqual(log, ["parse:tacos"], "the second box never called");
  const last = (id: string) => [...updates].reverse().find((u) => u.id === id)!;
  assert.equal(last(boxes[0].id).error, BULK_UPGRADE_MESSAGE);
  assert.equal(last(boxes[1].id).status, "idle");
});
