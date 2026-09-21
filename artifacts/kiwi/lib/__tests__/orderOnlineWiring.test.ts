// Row 8 Block 3 — the screen-side wiring, pinned at source level on the
// bulkIntakeHeadingOwner.test.ts precedent: app/** is outside the test glob
// and both routes are far too large to mount here. What is pinned:
//
//   • The D-WS9-158 "Coming soon" order stub is GONE from the tree — Plan
//     Review and its Home twin both route through lib/orderOnline.ts.
//   • "Order Online" on Plan Review keeps its label / icon / variant / slot
//     and its onPress is the new handler; the handler's generate sink is the
//     EXISTING handleGroceryListPress (one request path — lib/groceryHandoff).
//   • The confirmation maps the spec onto Alert.alert with a cancel-styled
//     "Not now" and "Create list" → onConfirm.
//   • The grocery screen mounts InstacartOrderPanel exactly ONCE, as the first
//     child of the scroll (top of the page), guarded out of the completed
//     state, and no longer in the bottom action area.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

const plan = read("app/plan/[id].tsx");
const home = read("app/(tabs)/index.tsx");
const grocery = read("app/grocery-list/[id].tsx");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

test("the coming-soon order stub string is gone from the tree", () => {
  const STUB = "you'll be able to send this list to a grocery service";
  const hits = ["app", "components", "lib", "hooks", "contexts"]
    .flatMap((d) => walk(resolve(root, d)))
    .filter((p) => readFileSync(p, "utf8").includes(STUB));
  assert.deepEqual(hits, [], `stub copy still present in: ${hits.join(", ")}`);
});

test("Plan Review: 'Order Online' keeps its cell and is wired to the new handler", () => {
  const cell = plan.match(
    /<Button\s+label="Order Online"\s+variant="secondary"\s+size="sm"\s+style=\{s\.panelCell\}[\s\S]*?onPress=\{handleOrderOnlinePress\}\s*\/>/,
  );
  assert.ok(cell, "the Order Online cell: same label/variant/size/slot, onPress={handleOrderOnlinePress}");
  assert.match(cell![0], /name="shopping-cart"/, "icon unchanged");
  assert.match(cell![0], /Colors\.terracotta\[400\]/, "icon colour unchanged");
  assert.equal(plan.match(/label="Order Online"/g)?.length, 1);
});

for (const [name, src, generateFlow] of [
  ["Plan Review", plan, "handleGroceryListPress"],
  ["Home", home, "handleStripGroceryList"],
] as const) {
  test(`${name}: the handler dispatches through lib/orderOnline with the existing generate flow as its sink`, () => {
    assert.match(src, /import \{ dispatchOrderOnline \} from "@\/lib\/orderOnline";/);
    const handler = src.match(
      name === "Home"
        ? /const handleStripOrderOnline = \(\) => \{[\s\S]*?\n  \};/
        : /const handleOrderOnlinePress = \(\) => \{[\s\S]*?\n  \};/,
    );
    assert.ok(handler, "handler present");
    const body = handler![0];
    assert.match(body, /dispatchOrderOnline\(/);
    // Cache reads only — no fetch on the tap.
    assert.match(body, /getQueriesData<GroceryListListItem\[\]>\(\{ queryKey: \["groceries", "list"\] \}\)/);
    assert.doesNotMatch(body, /await |generateGroceryListForPlan\(/, "no request in the handler itself");
    // The generate sink IS the existing flow, called once, unchanged.
    assert.match(body, new RegExp(`generate: \\(\\) => void ${generateFlow}\\(\\)`));
    // The confirmation → Alert.alert(title, body, [cancel-styled "Not now", "Create list" → onConfirm]).
    assert.match(
      body,
      /Alert\.alert\(spec\.title, spec\.body, \[\s*\{ text: spec\.cancelLabel, style: "cancel" \},\s*\{ text: spec\.confirmLabel, onPress: spec\.onConfirm \},\s*\]\)/,
    );
    // Navigate sink → the list screen.
    assert.match(body, /pathname: "\/grocery-list\/\[id\]", params: \{ id: listId \}/);
  });
}

test("Home: the This-Week card's Order Online cell still points at the (now wired) handler", () => {
  assert.match(home, /onOrderOnline=\{handleStripOrderOnline\}/);
});

test("Grocery screen: InstacartOrderPanel mounted once, first in the scroll, not in the completed state", () => {
  const mounts = grocery.match(/<InstacartOrderPanel/g) ?? [];
  assert.equal(mounts.length, 1, "exactly one mount");
  const panelAt = grocery.indexOf("<InstacartOrderPanel");
  const scrollOpen = grocery.indexOf("<KeyboardAwareScrollViewCompat");
  const scrollBodyStart = grocery.indexOf(">", grocery.indexOf('keyboardShouldPersistTaps="handled"', scrollOpen));
  const firstBannerAt = grocery.indexOf("{unresolvedItems.length > 0 && (");
  const viewPlanAt = grocery.indexOf("{list.planId && (");
  const completedBranchAt = grocery.indexOf('{list.status === "completed" ? (');
  const markDoneAt = grocery.indexOf("<View style={s.markDoneWrap}>");
  assert.ok(scrollOpen > 0 && scrollBodyStart > scrollOpen);
  assert.ok(panelAt > scrollBodyStart, "inside the scroll (below the fixed Header + progress band)");
  assert.ok(panelAt < firstBannerAt && panelAt < viewPlanAt, "first child of the scroll — above the clarify banner and View plan");
  assert.ok(panelAt < completedBranchAt && panelAt < markDoneAt, "not in the bottom action area any more");
  // Guarded out of the completed state.
  const guarded = grocery.slice(panelAt - 200, panelAt);
  assert.match(guarded, /\{list\.status !== "completed" && \(\s*$/, "wrapped in the not-completed guard");
  // Nothing about Instacart inside the completed branch.
  const completedBranch = grocery.slice(completedBranchAt, grocery.indexOf(") : (", completedBranchAt));
  assert.doesNotMatch(completedBranch, /Instacart/);
  // The bottom action area holds only the button now.
  const markDoneWrap = grocery.slice(markDoneAt, grocery.indexOf("</View>", markDoneAt));
  assert.doesNotMatch(markDoneWrap, /<InstacartOrderPanel/);
  assert.match(markDoneWrap, /label="Mark Shopping Done ✓"/);
});
