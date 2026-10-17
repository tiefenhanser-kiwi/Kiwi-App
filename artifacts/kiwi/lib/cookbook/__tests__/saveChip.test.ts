// BOOK-1C2 — the Save chip's face (lib/cookbook/saveChip.ts).

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { SAVE_CHIP_MIN_HIT, saveChipView, saveToastMessage } from "../saveChip";

describe("saveChipView", () => {
  test("unsaved: 'Save', light sage, a bookmark", () => {
    const v = saveChipView(false);
    assert.equal(v.label, "Save");
    assert.equal(v.tone, "light");
    assert.equal(v.icon, "bookmark");
    assert.equal(v.accessibilityLabel, "Save to My Meals");
  });

  test("saved: 'Saved', dark sage, a check", () => {
    const v = saveChipView(true);
    assert.equal(v.label, "Saved");
    assert.equal(v.tone, "dark");
    assert.equal(v.icon, "check");
    assert.equal(v.accessibilityLabel, "Saved to My Meals");
  });

  test("the spoken label contains the visible word in both states, and the two states differ", () => {
    for (const saved of [false, true]) {
      const v = saveChipView(saved);
      assert.ok(v.accessibilityLabel.startsWith(v.label), `${v.accessibilityLabel} / ${v.label}`);
    }
    assert.notEqual(saveChipView(false).accessibilityLabel, saveChipView(true).accessibilityLabel);
    assert.notEqual(saveChipView(false).accessibilityHint, saveChipView(true).accessibilityHint);
  });

  test("the hit area is at least 44 pt", () => {
    assert.ok(SAVE_CHIP_MIN_HIT >= 44);
  });
});

describe("saveToastMessage", () => {
  test("names the state the tap moves to", () => {
    assert.equal(saveToastMessage(true), "Saved to My Meals");
    assert.equal(saveToastMessage(false), "Removed from My Meals");
  });
});
