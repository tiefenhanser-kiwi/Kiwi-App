// WS9-2 2e Part 2 Phase 2 (D-WS9-162) — TellKiwiCard.
//
// This component had NO test file and it is the make lane's hero. The two
// things most worth guarding are behavioural, not cosmetic:
//   • the THIRD OPTION is conditional, and the condition is subtle enough to be
//     "simplified" back to isFirstRun by someone who does not know that
//     firstPlanCreatedAt is a permanent stamp;
//   • the placeholder ROTATION must stop on focus and once text exists, and
//     must not run at all under reduce-motion — none of which is visible in a
//     screenshot, and all of which is disorienting when wrong.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import {
  TellKiwiCard,
  TELL_KIWI_PLACEHOLDERS,
  ADD_OWN_MEALS_SUBLINE,
  DEFAULT_SUBTITLE,
  PLACEHOLDER_INTERVAL_MS,
} from "../TellKiwiCard";
import { Colors, Components, Palette, Typography } from "@/constants/tokens";

type Json = {
  type: string;
  props: Record<string, unknown>;
  children: (Json | string)[] | null;
};

let mounted: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function render(props: Partial<React.ComponentProps<typeof TellKiwiCard>> = {}) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(TellKiwiCard, {
        // Default to the reduced-motion branch so no test accidentally leaves a
        // live 2.6s interval running in the runner.
        __forceReduceMotion: true,
        ...props,
      }),
    );
  });
  mounted = tree;
  return { tree, root: tree.toJSON() as unknown as Json };
}

function walk(node: Json | string | null): Json[] {
  if (node == null || typeof node === "string") return [];
  const kids = Array.isArray(node.children)
    ? node.children.flatMap((c) => walk(c))
    : [];
  return [node, ...kids];
}
function allText(node: Json | string | null): string[] {
  if (node == null) return [];
  if (typeof node === "string") return [node];
  return Array.isArray(node.children) ? node.children.flatMap(allText) : [];
}
/**
 * Flatten a style prop. ⚠️ Pressable takes a FUNCTION of ({ pressed }) — the
 * stub passes it through verbatim, so a helper that only handles arrays reads
 * every Pressable as having no style at all (and then cheerfully "proves"
 * there are no terracotta fills anywhere).
 */
function flatten(style: unknown): Record<string, unknown> {
  const resolved =
    typeof style === "function"
      ? (style as (s: { pressed: boolean }) => unknown)({ pressed: false })
      : style;
  const parts = Array.isArray(resolved) ? resolved : [resolved];
  return Object.assign({}, ...parts.filter(Boolean));
}
function byType(root: Json, type: string): Json[] {
  return walk(root).filter((n) => n.type === type);
}
/** The nearest onPress-bearing node whose descendant text includes `label`. */
function pressableByText(root: Json, label: string): Json | null {
  return (
    walk(root).find(
      (n) =>
        (n.props as { onPress?: unknown }).onPress &&
        allText(n).includes(label),
    ) ?? null
  );
}

// ── §4.5 the conditional third option ───────────────────────────────────────

test("§4.5: the standard card shows TWO options — no 'Add my own meals'", () => {
  const { root } = render();
  const t = allText(root);
  assert.ok(t.includes("Surprise me"));
  assert.ok(t.includes("Use my preferences"));
  assert.ok(
    !t.includes("Add my own meals"),
    "the third option must be absent unless the user has no saved plans",
  );
  assert.ok(!t.includes(ADD_OWN_MEALS_SUBLINE), "its sub-line must be absent too");
});

test("§4.5: showAddOwnMeals adds the third option AND its sub-line", () => {
  const { root } = render({ showAddOwnMeals: true });
  const t = allText(root);
  assert.ok(t.includes("Add my own meals"));
  assert.ok(t.includes("Start from a recipe you know"));
  assert.ok(t.includes(ADD_OWN_MEALS_SUBLINE));
});

test("§4.5: the sub-line copy is verbatim, em dash included", () => {
  assert.equal(
    ADD_OWN_MEALS_SUBLINE,
    "or bring in recipes you already love — by link, photo, or paste.",
  );
});

test("§4.5: tapping the third option fires onAddOwnMeals", () => {
  let fired = 0;
  const { root } = render({
    showAddOwnMeals: true,
    onAddOwnMeals: () => (fired += 1),
  });
  const btn = pressableByText(root, "Add my own meals");
  assert.ok(btn, "third option not found");
  act(() => {
    (btn!.props.onPress as () => void)();
  });
  assert.equal(fired, 1);
});

test("the other two options fire their own handlers, not each other's", () => {
  const fired: string[] = [];
  const { root } = render({
    onSurprise: () => fired.push("surprise"),
    onUsePreferences: () => fired.push("prefs"),
  });
  act(() => {
    (pressableByText(root, "Surprise me")!.props.onPress as () => void)();
  });
  act(() => {
    (pressableByText(root, "Use my preferences")!.props.onPress as () => void)();
  });
  assert.deepEqual(fired, ["surprise", "prefs"]);
});

test("every option row carries its one-line description", () => {
  const t = allText(render({ showAddOwnMeals: true }).root);
  for (const d of [
    "A full week, chosen for you",
    "Built from what you already like",
    "Start from a recipe you know",
  ]) {
    assert.ok(t.includes(d), `missing description: ${d}`);
  }
});

// ── the send button is the ONLY terracotta fill ─────────────────────────────

test("D-WS9-162: exactly ONE terracotta FILL on the card, and it is the send button", () => {
  const { root } = render({ showAddOwnMeals: true });
  const filled = walk(root).filter(
    (n) => flatten(n.props.style).backgroundColor === Colors.terracotta[400],
  );
  assert.equal(
    filled.length,
    1,
    "the send button owns the card's only terracotta fill",
  );
  assert.equal(filled[0].props.accessibilityLabel, "Send");
});

test("the option rows are SOLID WHITE surfaces, not alpha hairlines", () => {
  // The retired chips were 55%-alpha borders measuring 2.54:1 on sage — below
  // the 3:1 non-text bar. Their text was 4.62:1, only 0.12 above AA, so a
  // darker tint was never an available fix. Surface, not tint.
  const { root } = render({ showAddOwnMeals: true });
  const rows = walk(root).filter(
    (n) => flatten(n.props.style).backgroundColor === Colors.neutral[0],
  );
  assert.equal(rows.length, 3, "three white option surfaces");
  for (const r of rows) {
    const s = flatten(r.props.style);
    assert.equal(s.borderWidth, undefined, "no hairline border on a solid row");
  }
});

test("the option ICONS are a terracotta tint, never a fill", () => {
  const { root } = render();
  const icons = byType(root, "icon-feather").filter(
    (n) => n.props.color === Components.tellKiwi.optionIcon,
  );
  assert.equal(icons.length, 2, "one tinted icon per option row");
  for (const i of icons) {
    assert.equal(
      flatten(i.props.style).backgroundColor,
      undefined,
      "an icon tint must not also paint a background",
    );
  }
});

test("the connector line is LIGHT, not the muted-dark sub tone", () => {
  const { root } = render();
  const node = walk(root).find(
    (n) => allText(n).join("") === "or let Kiwi take it from here",
  );
  assert.ok(node, "connector line not found");
  const c = flatten(node!.props.style).color;
  assert.equal(c, Palette.text.onSage, "light: #F4F1E6 → 4.62:1 on sage[600]");
  assert.notEqual(
    c,
    Palette.text.onSageSub,
    "onSageSub is 3.71:1 on this surface — below AA",
  );
});

test("no on-sage text is left on the sub tone that measures 3.71:1", () => {
  // Not a 2e ruling — but fixing the connector while its neighbour kept
  // failing beside it would not be a fix. Both sit at 4.62:1 now; they are
  // told apart by weight.
  const { root } = render();
  const onSub = walk(root).filter(
    (n) => flatten(n.props.style).color === Palette.text.onSageSub,
  );
  assert.deepEqual(
    onSub.map((n) => allText(n).join("")),
    [],
    "onSageSub is 3.71:1 on sage[600] — below AA for body text",
  );
});

// ── the rotating placeholder ────────────────────────────────────────────────

test("D-WS9-162: the five placeholders are verbatim and in ruled order", () => {
  assert.deepEqual(
    [...TELL_KIWI_PLACEHOLDERS],
    [
      "something cozy for a rainy week…",
      "tacos twice, and something light…",
      "I have chicken and no time…",
      "feed six people on Saturday…",
      "meatless, but not boring…",
    ],
  );
  assert.equal(PLACEHOLDER_INTERVAL_MS, 2600);
});

test("reduce-motion renders the FIRST placeholder, statically", () => {
  const { root } = render({ __forceReduceMotion: true });
  assert.ok(allText(root).includes(TELL_KIWI_PLACEHOLDERS[0]));
});

test("reduce-motion starts NO timer — the string never advances", async () => {
  const { root, tree } = render({ __forceReduceMotion: true });
  assert.ok(allText(root).includes(TELL_KIWI_PLACEHOLDERS[0]));
  // Real elapsed time well past one interval; under reduce-motion nothing
  // should have been scheduled to change it.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
  const after = allText(tree.toJSON() as unknown as Json);
  assert.ok(after.includes(TELL_KIWI_PLACEHOLDERS[0]));
  assert.ok(!after.includes(TELL_KIWI_PLACEHOLDERS[1]));
});

test("rotation is OFF while the field holds text — a moving placeholder under a cursor", () => {
  // With text present the placeholder is not even visible; animating it would
  // burn a timer redrawing something nobody can see.
  const { root } = render({ __forceReduceMotion: false, value: "tacos" });
  const ph = walk(root).find((n) => n.type === "rn-animated-text");
  assert.ok(ph, "placeholder node found");
  assert.equal(
    allText(ph!).join(""),
    "",
    "no placeholder text renders once the user has typed",
  );
});

// ⚠️ Part 4 Item 4 — THIS TEST CHANGED. It used to assert that the placeholder
// was still showing TELL_KIWI_PLACEHOLDERS[0] after focus, i.e. that focus
// stopped the rotation but left the string painted. Focus now CLEARS it: a
// frozen suggestion under a live cursor looks like text the user has to delete,
// and the only way to learn it is not real text is to try.
//
// The original intent — "focused: the placeholder must not advance" — is kept
// and strengthened: it must not advance AND must not be visible at all.
test("focus CLEARS the placeholder, and nothing advances while focused", async () => {
  const { root, tree } = render({ __forceReduceMotion: false });
  const input = byType(root, "rn-text-input")[0];
  assert.ok(input, "input found");
  assert.ok(
    allText(root).includes(TELL_KIWI_PLACEHOLDERS[0]),
    "unfocused: a suggestion is showing",
  );

  act(() => {
    (input.props.onFocus as () => void)();
  });
  const ph = () =>
    walk(tree.toJSON() as unknown as Json).find(
      (n) => n.type === "rn-animated-text",
    );
  assert.equal(
    allText(ph()!).join(""),
    "",
    "focused: the user types into a genuinely empty field",
  );

  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
  assert.equal(
    allText(ph()!).join(""),
    "",
    "focused: nothing advances underneath, either",
  );
  // And no OTHER placeholder leaked into the tree in its place.
  const after = allText(tree.toJSON() as unknown as Json);
  for (const p of TELL_KIWI_PLACEHOLDERS) {
    assert.ok(!after.includes(p), `placeholder still painted while focused: ${p}`);
  }
});

test("blur RESTORES the placeholder on an empty field", () => {
  // The clear is a focus state, not a one-way door: an empty field that stays
  // blank after the user taps away has simply lost its invitation.
  const { root, tree } = render({ __forceReduceMotion: false });
  const input = byType(root, "rn-text-input")[0];
  act(() => {
    (input.props.onFocus as () => void)();
  });
  act(() => {
    (input.props.onBlur as () => void)();
  });
  const ph = walk(tree.toJSON() as unknown as Json).find(
    (n) => n.type === "rn-animated-text",
  );
  assert.equal(allText(ph!).join(""), TELL_KIWI_PLACEHOLDERS[0]);
});

test("blur does NOT restore a placeholder over text the user typed", () => {
  // `hasText` already blanks it; the focus clear must not have introduced a
  // path where blurring a filled field repaints a suggestion behind the value.
  const { root, tree } = render({ __forceReduceMotion: false, value: "tacos" });
  const input = byType(root, "rn-text-input")[0];
  act(() => {
    (input.props.onFocus as () => void)();
  });
  act(() => {
    (input.props.onBlur as () => void)();
  });
  const ph = walk(tree.toJSON() as unknown as Json).find(
    (n) => n.type === "rn-animated-text",
  );
  assert.equal(allText(ph!).join(""), "");
});

test("blurring an empty field resumes from the FIRST string, not a half-faded frame", () => {
  const { root, tree } = render({ __forceReduceMotion: false });
  const input = byType(root, "rn-text-input")[0];
  act(() => {
    (input.props.onFocus as () => void)();
  });
  act(() => {
    (input.props.onBlur as () => void)();
  });
  assert.ok(
    allText(tree.toJSON() as unknown as Json).includes(
      TELL_KIWI_PLACEHOLDERS[0],
    ),
  );
});

test("the native placeholder prop stays empty so two strings can never both paint", () => {
  const { root } = render();
  const input = byType(root, "rn-text-input")[0];
  assert.equal(input.props.placeholder, "");
});

// ── structure ───────────────────────────────────────────────────────────────

test("title and input share ONE row", () => {
  const { root } = render();
  const row = walk(root).find(
    (n) => n.type === "rn-view" && flatten(n.props.style).flexDirection === "row",
  );
  assert.ok(row, "head row found");
  assert.ok(allText(row!).includes("Tell Kiwi"));
  assert.equal(
    byType(row!, "rn-text-input").length,
    1,
    "the input sits in the same row as the title",
  );
});

// ── Part 4 Item 4: the vertical order ───────────────────────────────────────
//
// The copy lines are DIVIDERS — each introduces the path below it. That is a
// claim about ORDER, so order is what gets pinned. Reading it off the rendered
// tree rather than off the source means a re-shuffle cannot pass by looking
// plausible in a diff.

/** Every rendered string, in render (document) order. */
function orderedText(root: Json): string[] {
  return allText(root).filter((s) => s.trim().length > 0);
}
function indexOf(root: Json, needle: string): number {
  return orderedText(root).indexOf(needle);
}

test("Item 4: the sub-line LEADS — it sits ABOVE the input, not below it", () => {
  // It used to sit under the input, reading as a footnote to a control the user
  // had already decided about.
  const { root } = render();
  const sub = indexOf(root, DEFAULT_SUBTITLE);
  const title = indexOf(root, "Tell Kiwi");
  assert.ok(sub >= 0, "sub-line not found");
  assert.ok(title >= 0, "title not found");
  assert.ok(sub < title, "the sub-line must precede the Tell Kiwi input row");
});

test("Item 4: the sub-line is one step UP the type scale", () => {
  // It read slightly small on device, and it is now the first line on the card.
  const { root } = render();
  const node = walk(root).find(
    (n) => allText(n).join("") === DEFAULT_SUBTITLE,
  );
  assert.ok(node, "sub-line node not found");
  const s = flatten(node!.props.style);
  assert.equal(s.fontSize, Typography.fontSize.base, "14px, not 12px");
  assert.notEqual(
    s.fontSize,
    Typography.fontSize.sm,
    "fontSize.sm is the size it was bumped off",
  );
});

test("Item 4: 'Use my preferences' comes BEFORE 'Surprise me' — reversed, ruled", () => {
  const { root } = render();
  const prefs = indexOf(root, "Use my preferences");
  const surprise = indexOf(root, "Surprise me");
  assert.ok(prefs >= 0 && surprise >= 0, "both options render");
  assert.ok(
    prefs < surprise,
    "2e Part 2 shipped these the other way round; Part 4 reverses it",
  );
});

test("Item 4: the conditional connector introduces the option BELOW it", () => {
  const { root } = render({ showAddOwnMeals: true });
  const line = indexOf(root, ADD_OWN_MEALS_SUBLINE);
  const option = indexOf(root, "Add my own meals");
  assert.ok(line >= 0 && option >= 0, "both render together");
  assert.ok(
    line < option,
    "it was a caption under the option; it is now a divider above it",
  );
});

test("Item 4: the WHOLE card reads in the ruled order, top to bottom", () => {
  // One assertion over the real render order, so a re-shuffle of any pair is
  // caught even if each pairwise test above were individually satisfied.
  const { root } = render({ showAddOwnMeals: true });
  const marks = [
    DEFAULT_SUBTITLE,
    "Tell Kiwi",
    "or let Kiwi take it from here",
    "Use my preferences",
    "Surprise me",
    ADD_OWN_MEALS_SUBLINE,
    "Add my own meals",
  ];
  const positions = marks.map((m) => indexOf(root, m));
  for (const [i, p] of positions.entries()) {
    assert.ok(p >= 0, `missing from the card: ${marks[i]}`);
  }
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
    `render order was ${JSON.stringify(
      positions.map((p, i) => [marks[i], p]),
    )}`,
  );
});

test("Item 4: D-WS9-163's gate is UNCHANGED — the connector is gated too", () => {
  // Both the connector and the option hang off the same flag. If the connector
  // ever escaped the gate, a user with saved plans would see a line introducing
  // a path that is not there.
  const t = allText(render().root);
  assert.ok(!t.includes("Add my own meals"));
  assert.ok(
    !t.includes(ADD_OWN_MEALS_SUBLINE),
    "the connector must not render without the option it introduces",
  );
});

test("submit fires from both the keyboard and the send button", () => {
  let fired = 0;
  const { root } = render({ onSubmit: () => (fired += 1) });
  const input = byType(root, "rn-text-input")[0];
  act(() => {
    (input.props.onSubmitEditing as () => void)();
  });
  const send = walk(root).find((n) => n.props.accessibilityLabel === "Send");
  act(() => {
    (send!.props.onPress as () => void)();
  });
  assert.equal(fired, 2);
});
