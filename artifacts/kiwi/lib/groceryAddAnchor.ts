// WS9 BUG-140 — the in-list "+ Add item" controls, anchored to the ONE add
// surface at the top of the screen.
//
// ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
// Every per-section "+ Add item" control was `onPress={() => {}}` — a literal
// no-op — under a comment claiming it "focuses the top input via natural tab
// order". There is no tab order in React Native; that comment describes a web
// mechanism that has never existed on this platform, which is why the dead
// control survived review: it read as implemented.
//
// ── THE FIX (Hans, ruled) ───────────────────────────────────────────────────
// The inline controls do NOT get their own add handler. They ANCHOR to the top
// input: scroll it back into view and focus it. One add surface, several entry
// points — no second route, no second validation path, no second typeahead.
//
// ── WHY THIS IS A SEPARATE, PURE MODULE ─────────────────────────────────────
// The picker/list suites in this package are pure `.test.ts` running under
// node --experimental-strip-types; there is no React renderer, so "the input
// receives focus" cannot be asserted by rendering. Taking the two refs as
// plain structural types makes the behaviour a unit: a test passes stubs and
// asserts focus() was called. That is testing by DESTINATION — a control that
// merely fires *some* handler would pass a naive tap test and still be dead.

/** The subset of a TextInput ref this needs. Structural on purpose. */
export interface FocusableInput {
  focus: () => void;
}

/** The subset of a ScrollView ref this needs. */
export interface ScrollableView {
  scrollTo: (options: { y: number; animated: boolean }) => void;
}

/**
 * Bring the single add surface back to the user and put the cursor in it.
 *
 * Order is deliberate: scroll FIRST, then focus. Focusing an off-screen input
 * on iOS scrolls the keyboard-avoiding view by itself and can land the field
 * under the keyboard; scrolling to the top first makes the final position
 * deterministic.
 *
 * Both refs are optional and null-tolerant — a ref is null on the first render
 * and after unmount, and a dead control is precisely the bug being fixed here,
 * so this must never throw its way back into being a no-op.
 */
export function focusAddItemInput(
  input: FocusableInput | null | undefined,
  scroll: ScrollableView | null | undefined,
): void {
  scroll?.scrollTo({ y: 0, animated: true });
  input?.focus();
}
