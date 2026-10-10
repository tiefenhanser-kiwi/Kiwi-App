// Row 8 Block 3 — the screen-side wiring, pinned at source level on the
// bulkIntakeHeadingOwner.test.ts precedent: app/** is outside the test glob
// and both routes are far too large to mount here. What is pinned:
//
//   • The D-WS9-158 "Coming soon" order stub is GONE from the tree — Plan
//     Review and its Home twin both route through lib/orderOnline.ts.
//   • "Order Online" on Plan Review keeps its label / icon / variant / slot
//     and its onPress is the new handler; the handler's generate sink is the
//     EXISTING handleGroceryListPress (one request path — lib/groceryHandoff).
//   • The confirmation maps the spec onto dialog.alert (WEB-1 — Alert.alert is
//     a no-op on web) with a cancel-styled "Not now" and "Create list" →
//     onConfirm.
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
    // Store-prep lane — Plan Review now also imports showOrderOnline for the
    // flag gate, so the import is matched by NAME rather than by the exact
    // one-symbol clause.
    assert.match(
      src,
      /import \{[^}]*\bdispatchOrderOnline\b[^}]*\} from "@\/lib\/orderOnline";/,
    );
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
    // The confirmation → dialog.alert(title, body, [cancel-styled "Not now", "Create list" → onConfirm]).
    assert.match(
      body,
      /dialog\.alert\(spec\.title, spec\.body, \[\s*\{ text: spec\.cancelLabel, style: "cancel" \},\s*\{ text: spec\.confirmLabel, onPress: spec\.onConfirm \},\s*\]\)/,
    );
    // Navigate sink → the list screen.
    assert.match(body, /pathname: "\/grocery-list\/\[id\]", params: \{ id: listId \}/);
  });
}

// Store-prep lane (Hans, September 22) — with the Instacart flag off, nothing
// Instacart-shaped renders. On Plan Review that is this gate. The cell and its
// handler are otherwise untouched; only their visibility became conditional.
test("Plan Review: the Order Online cell is gated on the server flag", () => {
  assert.match(
    plan,
    /import \{[^}]*\bshowOrderOnline\b[^}]*\} from "@\/lib\/orderOnline";/,
    "the decision comes from the tested pure function, not an inline expression",
  );
  assert.match(
    plan,
    /const orderOnlineVisible = showOrderOnline\(/,
    "one gate, named",
  );
  assert.match(
    plan,
    /showOrderOnline\(\s*queryClient\.getQueryData<HomePayload>\(\["home", "payload"\]\),\s*\)/,
    "read out of the cached home payload — no network on render",
  );
  assert.match(
    plan,
    /\{orderOnlineVisible \? \(\s*<Button\s+label="Order Online"/,
    "the cell renders only when the flag is on",
  );
  // The Grocery List cell is NOT gated: it is the plan's own list, not a
  // retailer surface, and with no retailer it is how the user reaches the list.
  // (Its label is the isGeneratingList ternary, hence the loose match.)
  assert.match(plan, /"Generating…" : "Grocery List"/);
  assert.doesNotMatch(plan, /orderOnlineVisible \? \([\s\S]{0,300}"Grocery List"/);
});

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

test("Part D: the panel reads list.items and its Add is the row's own opt-in — ONE staple opt-in path on the screen", () => {
  const mount = grocery.slice(grocery.indexOf("<InstacartOrderPanel"), grocery.indexOf("/>", grocery.indexOf("<InstacartOrderPanel")));
  assert.match(mount, /items=\{list\.items\}/, "the count line reads the same rows the tap sends from");
  assert.match(mount, /onAddStaple=\{handleStapleOptIn\}/);
  // Lifted, not duplicated: exactly one opt-in mutation call, inside handleStapleOptIn,
  // and handleItemTap delegates to it.
  assert.equal(grocery.match(/toggleGroceryStapleSelection\(listId, item\.id, true\)/g)?.length, 1);
  assert.match(grocery, /const handleStapleOptIn = \(item: GroceryListItem\) => \{[\s\S]*?toggleGroceryStapleSelection\(listId, item\.id, true\)/);
  assert.match(grocery, /if \(item\.isUniversalStaple && !\(item\.stapleOptedIn \?\? false\)\) \{\s*handleStapleOptIn\(item\);\s*return;\s*\}/);
});
