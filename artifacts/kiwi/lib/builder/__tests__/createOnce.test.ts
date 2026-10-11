// WEB-1 Part D (BUG-385) — Ask Kiwi for a meal → Save → Save put two copies in
// the plan. The builder's CREATE branch ran twice (the confirm that led back to
// the plan was a no-op on web), so it made a second meal and a second plan add.
// The latch makes the create run once per screen; the screen lands on the plan
// before it confirms. app/** is outside the test glob, so the screen wiring is
// pinned at source level (orderOnlineWiring precedent).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createOnce } from "../createOnce";
import { buildCreateRetryUpdate } from "@/lib/meal-builder-state";

test("the meal is created ONCE — a second call reuses the id", async () => {
  const latch = createOnce();
  let creates = 0;
  const create = async () => ({ id: `meal-${++creates}` });
  assert.equal(await latch.meal(create), "meal-1");
  assert.equal(await latch.meal(create), "meal-1");
  assert.equal(creates, 1);
  assert.equal(latch.mealId, "meal-1");
});

test("a FAILED create is retried (nothing was created)", async () => {
  const latch = createOnce();
  await assert.rejects(latch.meal(async () => {
    throw new Error("500");
  }));
  assert.equal(latch.mealId, null);
  assert.equal(await latch.meal(async () => ({ id: "meal-2" })), "meal-2");
});

test("done flips only on finish()", async () => {
  const latch = createOnce();
  await latch.meal(async () => ({ id: "m" }));
  assert.equal(latch.done, false, "a saved meal whose plan add failed may still retry the plan add");
  latch.finish();
  assert.equal(latch.done, true);
});

const here = dirname(fileURLToPath(import.meta.url));
const builder = readFileSync(resolve(here, "../../../app/meal-builder.tsx"), "utf8");

test("meal-builder: the CREATE branch is latched and the save goes through it", () => {
  assert.match(builder, /const \[createLatch\] = useState\(createOnce\);/);
  assert.match(
    builder,
    /if \(createLatch\.done\) return;\s*savingRef\.current = true;/,
    "a completed create is never re-run",
  );
  assert.match(builder, /const newMealId = await createLatch\.meal\(\(\) => saveMeal\(input\), \{/);
  assert.doesNotMatch(builder, /= await saveMeal\(input\)/, "no unlatched create left");
});

// ── WEB-2 Part D (BUG-387) — a retry carries the edits made after the failure ─

type Input = { title: string; servingsDefault: number; dishes: unknown[]; tags?: string[] };

/** The builder's CREATE branch, as far as the latch sees it (plan-back). */
function builderFlow(latch: ReturnType<typeof createOnce>, io: {
  creates: Input[];
  patches: { id: string; body: unknown }[];
  addOk: () => boolean;
}) {
  return async (input: Input) => {
    const id = await latch.meal(
      async () => {
        io.creates.push(input);
        return { id: `meal-${io.creates.length}` };
      },
      {
        key: JSON.stringify(input),
        update: async (mealId) => {
          io.patches.push({ id: mealId, body: buildCreateRetryUpdate(input as never) });
        },
      },
    );
    if (!io.addOk()) throw new Error("plan add failed");
    latch.finish();
    return id;
  };
}

test("BUG-387: save ok → add fails → edit → Save: the PATCH carries the edit, then the add; ONE meal", async () => {
  const latch = createOnce();
  const io = { creates: [] as Input[], patches: [] as { id: string; body: unknown }[], addOk: () => false };
  const save = builderFlow(latch, io);

  const first: Input = { title: "Weeknight Chili", servingsDefault: 4, dishes: [{ kind: "new", name: "Chili" }] };
  await assert.rejects(save(first), /plan add failed/);
  assert.equal(io.creates.length, 1);
  assert.equal(io.patches.length, 0, "nothing to amend yet");

  const edited: Input = { ...first, title: "Smoky Weeknight Chili", servingsDefault: 6 };
  io.addOk = () => true;
  assert.equal(await save(edited), "meal-1", "the retry adds the SAME meal");
  assert.equal(io.creates.length, 1, "no second meal");
  assert.equal(io.patches.length, 1);
  assert.equal(io.patches[0].id, "meal-1");
  const body = io.patches[0].body as { title: string; servingsDefault: number; dishes: unknown[] };
  assert.equal(body.title, "Smoky Weeknight Chili", "the edit rides the PATCH");
  assert.equal(body.servingsDefault, 6, "the create form's servings ride it too");
  assert.deepEqual(body.dishes, first.dishes);
  assert.equal(latch.done, true);
});

test("BUG-387: a retry with an UNCHANGED form sends no PATCH", async () => {
  const latch = createOnce();
  const io = { creates: [] as Input[], patches: [] as { id: string; body: unknown }[], addOk: () => false };
  const save = builderFlow(latch, io);
  const input: Input = { title: "Chili", servingsDefault: 4, dishes: [] };
  await assert.rejects(save(input));
  io.addOk = () => true;
  await save({ ...input });
  assert.equal(io.creates.length, 1);
  assert.equal(io.patches.length, 0);
});

test("BUG-387: a FAILED PATCH is retried on the next Save (the saved form did not move)", async () => {
  const latch = createOnce();
  await latch.meal(async () => ({ id: "m" }), { key: "a", update: async () => {} });
  let patches = 0;
  await assert.rejects(
    latch.meal(async () => ({ id: "x" }), {
      key: "b",
      update: async () => {
        patches++;
        throw new Error("503");
      },
    }),
  );
  await latch.meal(async () => ({ id: "x" }), { key: "b", update: async () => void patches++ });
  assert.equal(patches, 2);
  await latch.meal(async () => ({ id: "x" }), { key: "b", update: async () => void patches++ });
  assert.equal(patches, 2, "landed once; the same form again writes nothing");
});

test("BUG-387: buildCreateRetryUpdate is the edit PATCH plus the create form's servings and tags", () => {
  const body = buildCreateRetryUpdate({
    title: "T",
    servingsDefault: 3,
    tags: ["weeknight"],
    sourceType: "manual",
    dishes: [],
  } as never);
  assert.equal(body.title, "T");
  assert.equal(body.servingsDefault, 3);
  assert.deepEqual(body.tags, ["weeknight"]);
  assert.deepEqual(body.dishes, []);
});

test("meal-builder: the latch's retry PATCH is the meal PATCH with the current form", () => {
  assert.match(builder, /key: JSON\.stringify\(input\),\s*update: \(id\) => updateMeal\(id, buildCreateRetryUpdate\(input\)\),/);
});

test("meal-builder: plan-back / plan-replace land on the plan BEFORE the confirm", () => {
  for (const [call, title] of [
    ["await addMealToPlan(nav.planId, newMealId);", "Saved and added to plan"],
    ["await changeMealForPlanItem(nav.planId, nav.planItemId, newMealId);", "Saved and swapped in"],
  ] as const) {
    const at = builder.indexOf(call);
    assert.ok(at > 0, call);
    const body = builder.slice(at, builder.indexOf("} catch (planErr)", at));
    const nav = body.indexOf("applyNav();");
    const confirm = body.indexOf(`"${title}"`);
    assert.ok(nav > 0 && confirm > nav, `${title}: applyNav() before the confirm`);
    assert.match(body, /createLatch\.finish\(\);\s*setSaveDone\(true\);/);
    assert.doesNotMatch(body, /onPress: applyNav/, "the OK is no longer the only way back");
  }
});

test("meal-builder: Save is disabled once the create is done", () => {
  assert.match(builder, /disabled=\{\s*saving \|\|[\s\S]{0,120}saveDone \|\|/);
});
