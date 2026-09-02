// WS9 BUG-157 / BUG-106 — contrast guards on the text tokens.
//
// ⚠️ ANTI-TAUTOLOGY DISCIPLINE, and it is the whole point of this file.
// Every expected value below is an explicit hex LITERAL, and `ratio` is written
// here from the WCAG 2.x definition rather than imported from anything the app
// reads. An assertion that computes its expectation from the same constant the
// code under test uses pins nothing: this repo has already shipped a test that
// asserted `deepEqual(rendered, [...STEP_ICONS])` while rendering FROM
// STEP_ICONS, and it survived exactly the defect it existed to catch.
//
// The BACKGROUNDS are pinned to literals too, in both directions: if a surface
// token is re-valued darker, these fail rather than silently re-baselining.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Colors, Palette, Components } from "@/constants/tokens";

// ── WCAG 2.x relative luminance + contrast ratio, written from the spec ──────
function channel(srgb8: number): number {
  const c = srgb8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  assert.equal(h.length, 6, `expected a 6-digit hex, got "${hex}"`);
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** Four decimals, always. A value of 2.9966 prints as "3.00" at two and reads
 *  as passing; anything near a threshold at low precision is unverified. */
const at4 = (n: number) => Number(n.toFixed(4));

const AA_TEXT = 4.5;

// The surfaces placeholders and body text actually sit on, as LITERALS.
const CARD = "#ffffff";
const INPUT = "#FDFAF4";
const PAPER = "#FBF7EF";
const SAGE_50 = "#f1f4ec";
const PLACEHOLDER_SURFACES = [CARD, INPUT, PAPER, SAGE_50];

// ── the calculator itself, checked against a figure the repo already recorded ─
describe("the contrast function in this file is correct", () => {
  it("reproduces the 2.9966:1 figure recorded in app/plan/[id].tsx", () => {
    // That file rejected neutral[600] on the sage[100] action panel at
    // "2.9966:1". If this helper disagrees, every other number here is suspect.
    assert.equal(at4(ratio("#8A8474", "#e2e9d8")), 2.9966);
  });

  it("reproduces the two BUG-157 canon figures (paper and card)", () => {
    assert.equal(at4(ratio("#8A8474", PAPER)), 3.4886);
    assert.equal(at4(ratio("#8A8474", CARD)), 3.7278);
  });

  it("returns 1 for a colour on itself and 21 for black on white", () => {
    assert.equal(at4(ratio(CARD, CARD)), 1);
    assert.equal(at4(ratio("#000000", "#ffffff")), 21);
  });
});

// ── the surfaces have not moved out from under the numbers above ────────────
describe("surface tokens still hold the values these guards assume", () => {
  it("pins each background to its literal", () => {
    assert.equal(Palette.background.card, CARD);
    assert.equal(Palette.background.input, INPUT);
    assert.equal(Palette.background.app, PAPER);
    assert.equal(Colors.sage[50], SAGE_50);
  });
});

// ── BUG-157 A/B/C: the placeholder token ────────────────────────────────────
describe("BUG-157 — Palette.text.placeholder", () => {
  it("holds the corrected value, not the #A89A7A it replaced", () => {
    assert.equal(Palette.text.placeholder, "#776D5D");
    assert.notEqual(
      Palette.text.placeholder,
      "#A89A7A",
      "#A89A7A measured 2.5967 on paper / 2.7748 on card — below even the 3:1 " +
        "non-text floor, and WORSE than the neutral[600] it nominally softened",
    );
  });

  it("clears AA on every surface a placeholder sits on", () => {
    const expected = [5.0849, 4.8808, 4.7586, 4.5744];
    PLACEHOLDER_SURFACES.forEach((bg, i) => {
      const r = at4(ratio(Palette.text.placeholder, bg));
      assert.equal(r, expected[i], `${Palette.text.placeholder} on ${bg}`);
      assert.ok(r >= AA_TEXT, `${r}:1 on ${bg} is below ${AA_TEXT}:1`);
    });
  });

  it("sage[50] is the binding constraint, and #7B7161 fails it", () => {
    // The next-lighter candidate on the same ramp line. Recorded so a future
    // "soften it one step" edit has to argue with a number.
    assert.equal(at4(ratio("#7B7161", SAGE_50)), 4.3163);
    assert.ok(4.3163 < AA_TEXT);
  });

  it("Components.tellKiwi.inputPlaceholder points AT it, not at a rival value", () => {
    // BUG-157 C — the locked file used to hold two different answers to one
    // question. One token now, and this is a pointer.
    assert.equal(Components.tellKiwi.inputPlaceholder, Palette.text.placeholder);
    assert.equal(Components.tellKiwi.inputBackground, PAPER);
    assert.equal(
      at4(ratio(Components.tellKiwi.inputPlaceholder, Components.tellKiwi.inputBackground)),
      4.7586,
    );
  });
});

// ── BUG-157 D: the body-text token ──────────────────────────────────────────
describe("BUG-157 — neutral[700] is the body-text value", () => {
  it("holds its literal and clears AA on all four surfaces", () => {
    assert.equal(Colors.neutral[700], "#6B5E4D");
    const expected = [6.2999, 6.047, 5.8956, 5.6674];
    PLACEHOLDER_SURFACES.forEach((bg, i) => {
      const r = at4(ratio(Colors.neutral[700], bg));
      assert.equal(r, expected[i], `neutral[700] on ${bg}`);
      assert.ok(r >= AA_TEXT);
    });
  });

  it("also clears AA on the two dual-site surfaces", () => {
    // tab bar + PrepCookHub chip both sit on neutral[200].
    assert.equal(Colors.neutral[200], "#F1EADC");
    assert.equal(at4(ratio(Colors.neutral[700], "#F1EADC")), 5.2627);
    assert.ok(at4(ratio(Colors.neutral[700], "#F1EADC")) >= AA_TEXT);
  });
});

// ── BUG-157: the quiet tier was PRESERVED, not swept ─────────────────────────
describe("BUG-157 — neutral[600] keeps its value and its role", () => {
  it("still holds #8A8474 — the sweep re-pointed sites, it did not re-value this", () => {
    assert.equal(Colors.neutral[600], "#8A8474");
    assert.equal(Palette.text.muted, "#8A8474");
  });

  it("Cook Mode's dimmed next-step preview still reads it (ruled to stay)", () => {
    assert.equal(Palette.cookMode.nextPreview, Colors.neutral[600]);
  });

  it("the three text greys are pairwise distinct", () => {
    const trio: Array<[string, string]> = [
      ["placeholder", Palette.text.placeholder],
      ["neutral[700]", Colors.neutral[700]],
      ["neutral[600]", Colors.neutral[600]],
    ];
    for (let i = 0; i < trio.length; i++) {
      for (let j = i + 1; j < trio.length; j++) {
        assert.notEqual(
          trio[i][1],
          trio[j][1],
          `${trio[i][0]} and ${trio[j][0]} collapsed to the same value — the ` +
            "A1 three-tier hierarchy is flattened",
        );
      }
    }
  });
});

// ── BUG-106: the primary CTA ────────────────────────────────────────────────
describe("BUG-106 — primary CTA text on terracotta", () => {
  it("clears AA on the locked terracotta accent", () => {
    assert.equal(Colors.terracotta[400], "#C24F25");
    assert.equal(Palette.button.primary.background, "#C24F25");
    assert.equal(Palette.button.primary.text, "#FFFFFF");
    const r = at4(ratio(Palette.button.primary.text, Palette.button.primary.background));
    assert.equal(r, 4.7308);
    assert.ok(r >= AA_TEXT);
  });

  it("records why '#FBF7EF' could not stay", () => {
    // 4.4273 prints as "4.43" and reads as a near-miss. It is a miss.
    assert.equal(at4(ratio("#FBF7EF", "#C24F25")), 4.4273);
    assert.ok(4.4273 < AA_TEXT);
    assert.notEqual(Palette.button.primary.text, "#FBF7EF");
  });

  it("the selected chip carries the same pair and the same fix", () => {
    assert.equal(Palette.chip.selected.background, "#C24F25");
    assert.equal(Palette.chip.selected.text, "#FFFFFF");
    assert.ok(
      at4(ratio(Palette.chip.selected.text, Palette.chip.selected.background)) >= AA_TEXT,
    );
  });

  it("terracotta[400] is untouched — it is a LOCKED A1 accent", () => {
    assert.equal(Colors.terracotta[400], "#C24F25");
  });
});
