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
  assert.match(builder, /const newMealId = await createLatch\.meal\(\(\) => saveMeal\(input\)\);/);
  assert.doesNotMatch(builder, /= await saveMeal\(input\)/, "no unlatched create left");
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
