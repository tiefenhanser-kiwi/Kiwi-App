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
import { TONE_STYLE } from "@/components/PrepCookHubView";

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

  it("is NOT read by Cook Mode any more — BUG-199 reversed that", () => {
    // ⚠️ This assertion used to read `assert.equal(Palette.cookMode.nextPreview,
    // Colors.neutral[600])` with the note "ruled to stay". The Sept 2 device
    // pass amended BUG-157's Aug 31 ruling: the quiet tier survives for section
    // labels and small-caps eyebrows, and dies inside Cook Mode.
    assert.notEqual(
      Palette.cookMode.nextPreview,
      Colors.neutral[600],
      "the quiet tier no longer reaches Cook Mode",
    );
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

// ── BUG-199 A — Cook Mode leaves the quiet tier ─────────────────────────────
// The Sept 2 device pass AMENDS BUG-157's Aug 31 ruling. Hans's reasoning
// generalises: a quiet tier is a reading-room decision, and Cook Mode is not a
// reading room — phone propped by a cutting board, wet hands, glare.
describe("BUG-199 — the three Cook Mode greys clear AA", () => {
  // The Cook Mode footer sits on neutral[100] paper; the step card is white.
  const COOK_FOOTER_BG = "#FBF7EF";
  const COOK_CARD_BG = "#ffffff";

  it("Palette.cookMode.nextPreview is neutral[700] and clears AA on the footer", () => {
    assert.equal(Palette.cookMode.nextPreview, "#6B5E4D");
    const r = at4(ratio(Palette.cookMode.nextPreview, COOK_FOOTER_BG));
    assert.equal(r, 5.8956);
    assert.ok(r >= AA_TEXT);
  });

  it("records what it moved FROM, so the regression is legible", () => {
    // #8A8474 on the footer. If someone reverts the token, the test above goes
    // red against this number rather than against a vague "too low".
    assert.equal(at4(ratio("#8A8474", COOK_FOOTER_BG)), 3.4886);
    assert.ok(3.4886 < AA_TEXT);
    assert.equal(at4(ratio("#8A8474", COOK_CARD_BG)), 3.7278);
  });

  it("the token has exactly one consumer, and re-valuing it was therefore safe", () => {
    // Two differently shaped searches found CookFooter.tsx:97 and nothing else
    // outside the definition, this file, and comments. Pinned as a tripwire: if
    // a second Cook-Mode-external reader appears, the token's meaning has drifted
    // and this note is the place that says so.
    assert.equal(Palette.cookMode.nextPreview, Colors.neutral[700]);
  });
});

// ── BUG-199 C — the hub's neutral tone chip ─────────────────────────────────
// Hans, on device: "the chips are neutral that's slightly darker than the
// neutral background." Both halves were wrong at once — the chip barely
// separated from the page AND its text was the dimmer of the three tones.
describe("BUG-199 — the PrepCookHub neutral chip separates from the page and carries its text", () => {
  // ⚠️ CHIP_BG / CHIP_FG are read from the COMPONENT'S OWN MAP, not restated
  // from tokens. An earlier draft of this block asserted the literals directly:
  // reverting TONE_STYLE.neutral.bg to neutral[200] left all 26 tests GREEN,
  // because nothing here touched the map. That break is why TONE_STYLE is
  // exported. The expected VALUES below stay literals, so the assertion still
  // cannot derive its expectation from the constant under test.
  const HUB_PAGE = "#FBF7EF"; // Palette.background.app
  const CHIP_BG = TONE_STYLE.neutral.bg;
  const CHIP_FG = TONE_STYLE.neutral.fg;
  const AA_NON_TEXT = 3.0;

  it("the chip actually uses the values these ratios assume", () => {
    assert.equal(Palette.background.app, HUB_PAGE);
    assert.equal(CHIP_BG, "#E4DCCB", "TONE_STYLE.neutral.bg drifted");
    assert.equal(CHIP_FG, "#4A3F30", "TONE_STYLE.neutral.fg drifted");
  });

  it("the sibling tones are the ones this block says they are", () => {
    assert.equal(TONE_STYLE.sage.bg, "#e2e9d8");
    assert.equal(TONE_STYLE.gold.bg, "#F6E8C8");
  });

  it("the chip fill separates from the page MORE than it used to", () => {
    const before = at4(ratio("#F1EADC", HUB_PAGE)); // neutral[200], the old fill
    const after = at4(ratio(CHIP_BG, HUB_PAGE));
    assert.equal(before, 1.1203);
    assert.equal(after, 1.2763);
    assert.ok(after > before, "the fill must separate more, not less");
  });

  it("the chip text clears AA against the chip's own fill, by a wider margin", () => {
    const before = at4(ratio("#6B5E4D", "#F1EADC")); // old fg on old bg
    const after = at4(ratio(CHIP_FG, CHIP_BG));
    assert.equal(before, 5.2627);
    assert.equal(after, 7.5303);
    assert.ok(after >= AA_TEXT);
    assert.ok(after > before, "the text must get easier to read, not harder");
  });

  it("the chip's ICON half still clears the 3:1 non-text bar", () => {
    // `fg` drives a Feather icon as well as the <Text>.
    assert.ok(at4(ratio(CHIP_FG, CHIP_BG)) >= AA_NON_TEXT);
  });

  it("⚠️ the sage and gold tones are UNTOUCHED — the family must still read as one", () => {
    // Their page separation (1.1642 / 1.1363) is no better than the neutral
    // chip's WAS. They read fine anyway because they separate by HUE, which is
    // the whole diagnosis: the neutral chip shares the page's hue and had
    // nothing to separate with. Pinned so a later "consistency" pass does not
    // darken these too.
    assert.equal(at4(ratio("#e2e9d8", HUB_PAGE)), 1.1642); // sage[100]
    assert.equal(at4(ratio("#F6E8C8", HUB_PAGE)), 1.1363); // gold.background
  });

  it("⚠️ FOUND, NOT FIXED: the gold chip's own text is 3.7593:1, under AA", () => {
    // gold.text on gold.background. Out of BUG-199's scope — Hans device-
    // confirmed the gold tone reads fine and only the neutral one was ruled.
    // Recorded here so it is a known number rather than a future surprise.
    assert.equal(at4(ratio(Colors.gold.text, Colors.gold.background)), 3.7593);
  });
});

// ── BUG-199 §2B — the Prep-the-Week CTA's ring ──────────────────────────────
// The CTA became <Button variant="primary"> on the hub's sage[600] lane. Its
// LABEL is fine; its SHAPE is not, and the ring is what fixes that.
describe("BUG-199 §2B — a primary button on a coloured surface needs a light ring", () => {
  const SAGE_LANE = "#5C7350"; // Colors.sage[600], the locked Prep lane surface

  it("the lane token still holds the value these ratios assume", () => {
    assert.equal(Colors.sage[600], SAGE_LANE);
  });

  it("the label clears AA on the fill — this half was never the problem", () => {
    assert.equal(
      at4(ratio(Palette.button.primary.text, Palette.button.primary.background)),
      4.7308,
    );
  });

  it("⚠️ the FILL does not separate from the lane, which is why a ring exists", () => {
    // 1.1033 is not a text failure — it is the button's outline against the card
    // it sits on, and it is red-on-green, the pair that collapses under
    // red-green colour blindness. Without a ring the edge effectively vanishes.
    const r = at4(ratio(Palette.button.primary.background, SAGE_LANE));
    assert.equal(r, 1.1033);
    assert.ok(r < 3.0, "if this ever clears 3:1 the ring may be reconsidered");
  });

  it("the ring carries the boundary by luminance, on BOTH sides", () => {
    // Same value as the label (Palette.button.primary.text), so the edge and the
    // type cannot drift apart.
    assert.equal(at4(ratio(Palette.button.primary.text, SAGE_LANE)), 5.2197);
    assert.equal(at4(ratio(Palette.button.primary.text, Palette.button.primary.background)), 4.7308);
    assert.ok(at4(ratio(Palette.button.primary.text, SAGE_LANE)) >= 3.0);
  });

  it("the cream it replaced was the weaker candidate on both sides", () => {
    // Palette.text.inverse #FBF7EF — 4.8848 / 4.4273. Recorded so "just use
    // CREAM, it is already imported" has a number to argue with.
    assert.equal(at4(ratio("#FBF7EF", SAGE_LANE)), 4.8848);
    assert.equal(at4(ratio("#FBF7EF", Palette.button.primary.background)), 4.4273);
  });
});
