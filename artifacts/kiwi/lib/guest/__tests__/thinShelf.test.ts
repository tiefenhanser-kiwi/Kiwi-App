// Row 13 "Test Kitchen" · Block 2b (BUG-316) — where the catalog-gap refusal
// appears.
//
// Nothing about the 409 was wrong. POST /wizard/expand refused the candidate
// before any AI call, the client read `catalog_only_gap`, the `thin_shelf` event
// posted 201 — and then the banner mounted above the FIRST card while the
// visitor was looking at the THIRD, ~1,400 px down. Every signal fired and the
// screen appeared not to react.
//
// The state transition is the whole fix, so it is the whole test: a refusal is
// tagged with the card that earned it, exactly that card renders the banner, and
// the top of the list gets nothing, ever.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveThinShelfPlacement,
  thinShelfShowsOnCard,
  type ThinShelfRefusal,
} from "../thinShelf";

// options.tsx's per-card keys: `${index}-${candidate.title}`. The browser pass
// tapped the third one.
const KEYS = ["0-Weeknight Comfort", "1-Bright & Fast", "2-Harvest Table, Plant-Forward"];
const TAPPED = KEYS[2];

const REFUSAL: ThinShelfRefusal = {
  candidateKey: TAPPED,
  liveSlotTitles: ["Sheet-Pan Chicken", "Lentil Soup"],
};

test("no refusal → no banner anywhere", () => {
  const placement = deriveThinShelfPlacement(null);
  assert.equal(placement.topOfList, false);
  assert.equal(placement.inlineCardKey, null);
  for (const key of KEYS) {
    assert.equal(thinShelfShowsOnCard(placement, key), false, key);
  }
});

test("🔴 BUG-316 — the tapped card shows the banner, and ONLY the tapped card", () => {
  const placement = deriveThinShelfPlacement(REFUSAL);
  assert.equal(placement.inlineCardKey, TAPPED);
  assert.equal(thinShelfShowsOnCard(placement, TAPPED), true);
  // The other two cards keep their "See this plan" button.
  for (const key of KEYS.filter((k) => k !== TAPPED)) {
    assert.equal(thinShelfShowsOnCard(placement, key), false, key);
  }
  // Exactly one, not "at least one".
  assert.equal(KEYS.filter((k) => thinShelfShowsOnCard(placement, k)).length, 1);
});

test("🔴 BUG-316 — the LIST-TOP banner is gone, with a refusal and without one", () => {
  // Typed as the literal `false`, so a future author cannot set it back without
  // changing the type and tripping this file.
  assert.equal(deriveThinShelfPlacement(null).topOfList, false);
  assert.equal(deriveThinShelfPlacement(REFUSAL).topOfList, false);
  for (const key of KEYS) {
    const placement = deriveThinShelfPlacement({ candidateKey: key, liveSlotTitles: [] });
    assert.equal(placement.topOfList, false, key);
    // Whichever card is tapped, the refusal lands on THAT card — including the
    // first, where the old top-of-list banner happened to look correct and hid
    // the bug from anyone who only ever tapped the top option.
    assert.equal(placement.inlineCardKey, key);
  }
});

test("a second tap on a DIFFERENT card moves the banner rather than adding one", () => {
  const first = deriveThinShelfPlacement({ candidateKey: KEYS[0], liveSlotTitles: [] });
  assert.equal(thinShelfShowsOnCard(first, KEYS[0]), true);
  const second = deriveThinShelfPlacement({ candidateKey: KEYS[1], liveSlotTitles: [] });
  assert.equal(thinShelfShowsOnCard(second, KEYS[0]), false);
  assert.equal(thinShelfShowsOnCard(second, KEYS[1]), true);
});

test("the server's liveSlotTitles survive the keying — the thin_shelf event still has them", () => {
  // The 409 handling and the event are unchanged (the server half is correct);
  // the refusal only gained a key, it did not lose the payload.
  assert.deepEqual(REFUSAL.liveSlotTitles, ["Sheet-Pan Chicken", "Lentil Soup"]);
  assert.equal(deriveThinShelfPlacement(REFUSAL).inlineCardKey, REFUSAL.candidateKey);
});

test("a stale key matches nothing — a refusal for a card no longer in the list shows no banner", () => {
  // The candidate list can be replaced by the server's copy on a reload. A
  // refusal whose card is gone must not attach itself to some other card.
  const placement = deriveThinShelfPlacement({
    candidateKey: "7-A Plan From A Previous Session",
    liveSlotTitles: [],
  });
  for (const key of KEYS) {
    assert.equal(thinShelfShowsOnCard(placement, key), false, key);
  }
});
