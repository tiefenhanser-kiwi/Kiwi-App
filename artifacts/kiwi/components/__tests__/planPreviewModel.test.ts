// PREVIEW-1 — the featured-plan preview's view model (components/planPreview/
// previewModel.ts): TemplateDetail → rows, day order, image url or null,
// minutes, and the header meta line.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPlanPreview,
  formatDaySpan,
  previewRowMetaLine,
} from "../planPreview/previewModel";
import type { TemplateDetail } from "@/lib/api/plans";
import type { MealDetail } from "@/lib/api/meals";

function meal(id: string, over: Partial<MealDetail> = {}): MealDetail {
  return {
    id,
    title: `Meal ${id}`,
    displayTitle: null,
    description: null,
    cuisine: "",
    minutes: 30,
    activeTimeMinutes: null,
    servings: 4,
    authoredServingsDefault: 4,
    effectiveServings: 4,
    calories: 500,
    protein: 30,
    carbs: 40,
    fat: 18,
    tags: [],
    image: null,
    difficulty: "easy",
    mealType: "dinner",
    sourceType: "curated",
    isPublic: true,
    userId: null,
    dishes: [],
    steps: [],
    notes: null,
    ...over,
  };
}

type Item = TemplateDetail["items"][number];
function item(
  id: string,
  day: string | null,
  positionIndex: number,
  m: MealDetail | null,
  slot: Partial<Pick<Item, "isBreakfast" | "isLunch" | "isDinner">> = {},
): Item {
  return {
    id,
    mealId: m?.id ?? `gone-${id}`,
    positionIndex,
    assignedDayOfWeek: day,
    isBreakfast: false,
    isLunch: false,
    isDinner: true,
    ...slot,
    meal: m,
  };
}

function template(items: Item[]): TemplateDetail {
  return {
    id: "tmpl-1",
    userId: "owner",
    title: "Sheet Pan Easy",
    description: null,
    image: null,
    tags: [],
    sourceType: "curated",
    defaultDaysCount: 5,
    optimizationNotes: [],
    items,
  };
}

test("maps each item to a row: image url or null, minutes, Plan Review's meta line", () => {
  const model = buildPlanPreview(
    template([
      item("ti-1", "Monday", 0, meal("a", { image: "https://img/a.jpg", minutes: 25 })),
      item("ti-2", "Tuesday", 1, meal("b", { image: null, minutes: 40, activeTimeMinutes: 15, difficulty: "medium", servings: 2 })),
    ]),
  );
  assert.deepEqual(
    model.scheduled.map((r) => ({ id: r.itemId, day: r.day, img: r.imageUrl, min: r.minutes, meta: r.metaLine })),
    [
      { id: "ti-1", day: "Monday", img: "https://img/a.jpg", min: 25, meta: "Easy · 25 min · serves 4" },
      { id: "ti-2", day: "Tuesday", img: null, min: 40, meta: "Medium · 40 min · 15 min hands-on · serves 2" },
    ],
  );
  assert.equal(model.unscheduled.length, 0);
});

test("day order is Plan Review's: Sun → Sat, then positionIndex; null days split out newest-first", () => {
  const model = buildPlanPreview(
    template([
      item("fri", "Friday", 0, meal("f")),
      item("u-old", null, 1, meal("u1")),
      item("mon-2", "Monday", 5, meal("m2")),
      item("sun", "Sunday", 2, meal("s")),
      item("mon-1", "Monday", 3, meal("m1")),
      item("u-new", null, 7, meal("u2")),
      item("sat", "Saturday", 4, meal("sa")),
    ]),
  );
  assert.deepEqual(
    model.scheduled.map((r) => r.itemId),
    ["sun", "mon-1", "mon-2", "fri", "sat"],
  );
  assert.deepEqual(model.unscheduled.map((r) => r.itemId), ["u-new", "u-old"]);
});

test("a junk day string narrows to unscheduled; an archived (null) meal is dropped", () => {
  const model = buildPlanPreview(
    template([
      item("ok", "Wednesday", 0, meal("w")),
      item("junk", "wednesday", 1, meal("j")),
      item("gone", "Thursday", 2, null),
    ]),
  );
  assert.deepEqual(model.scheduled.map((r) => r.itemId), ["ok"]);
  assert.deepEqual(model.unscheduled.map((r) => r.itemId), ["junk"]);
  assert.match(model.metaLine, /^2 dinners/);
});

test("header meta line: count + noun, day span, average derived time", () => {
  const five = buildPlanPreview(
    template(
      ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((d, i) =>
        item(`ti-${i}`, d, i, meal(`m${i}`, { minutes: 30 + i })),
      ),
    ),
  );
  assert.equal(five.metaLine, "5 dinners · Mon–Fri · avg 32 min");

  const mixed = buildPlanPreview(
    template([
      item("a", "Monday", 0, meal("a"), { isDinner: false, isLunch: true }),
      item("b", "Wednesday", 1, meal("b", { minutes: 0 })),
    ]),
  );
  assert.equal(mixed.metaLine, "2 meals · Mon, Wed · avg 30 min");

  assert.equal(buildPlanPreview(template([])).metaLine, "0 meals");
});

test("formatDaySpan: single, contiguous, gapped, duplicates, empty", () => {
  assert.equal(formatDaySpan(["Monday"]), "Mon");
  assert.equal(formatDaySpan(["Friday", "Monday", "Wednesday", "Tuesday", "Thursday"]), "Mon–Fri");
  assert.equal(formatDaySpan(["Sunday", "Saturday"]), "Sun, Sat");
  assert.equal(formatDaySpan(["Monday", "Monday", "Tuesday"]), "Mon–Tue");
  assert.equal(formatDaySpan([]), null);
});

test("previewRowMetaLine omits an empty difficulty rather than rendering a blank part", () => {
  assert.equal(previewRowMetaLine(meal("x", { difficulty: "" })), "30 min · serves 4");
});
