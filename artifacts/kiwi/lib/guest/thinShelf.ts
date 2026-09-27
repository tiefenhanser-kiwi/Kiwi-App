// Row 13 "Test Kitchen" · Block 2b (BUG-316) — WHERE THE CATALOG-GAP REFUSAL
// APPEARS.
//
// The server half is correct and untouched: a candidate the catalog cannot fill
// every slot of is refused before any AI call (POST /wizard/expand 409
// `catalog_only_gap`, D-WS9-260), and the refusal IS the door.
//
// 🔴 WHAT WAS WRONG WAS PURELY POSITIONAL. options.tsx held the refusal in one
// screen-level `thinShelf` state and rendered the banner ABOVE the first card.
// The browser pass tapped the THIRD candidate, at the bottom of the list, so the
// banner mounted ~1,400 px above the viewport: the 409 landed, the `thin_shelf`
// event landed, and nothing at all changed where the visitor was looking. A
// refusal the visitor cannot see is a dead button.
//
// So the refusal is keyed to the candidate that earned it. This module is that
// key, as a pure derivation, so "inline in the tapped card, and NOT at the top
// of the list" is a tested fact rather than a JSX reading.

/** A `catalog_only_gap` refusal, tagged with the card that produced it. */
export interface ThinShelfRefusal {
  /** options.tsx's per-card key (`${index}-${candidate.title}`) — the same value
   *  its busy state is keyed on, so the two cannot disagree about which card the
   *  visitor tapped. */
  candidateKey: string;
  /** The server's `liveSlotTitles` from the 409, carried for the event and for
   *  any future copy that wants to name the slots it could fill. */
  liveSlotTitles: string[];
}

/**
 * The banner placement for one render of the options list.
 *
 * `topOfList` exists as an explicit `false` rather than as an absence: the whole
 * defect was a banner at the top of the list, and a field that is always false
 * is what lets a test assert it stayed gone.
 */
export interface ThinShelfPlacement {
  /** 🔴 Always false. BUG-316: the banner must never mount above the cards. */
  topOfList: false;
  /** The card key whose action row the banner replaces, or null for no refusal. */
  inlineCardKey: string | null;
}

export function deriveThinShelfPlacement(
  refusal: ThinShelfRefusal | null,
): ThinShelfPlacement {
  return { topOfList: false, inlineCardKey: refusal?.candidateKey ?? null };
}

/**
 * True when THIS card renders the banner in place of its "See this plan" button.
 * Exactly one card can, and only the one that was tapped.
 *
 * Takes the PLACEMENT rather than the refusal, so the screen has to go through
 * deriveThinShelfPlacement to ask — there is one decision, not two that could
 * drift.
 */
export function thinShelfShowsOnCard(
  placement: ThinShelfPlacement,
  candidateKey: string,
): boolean {
  return placement.inlineCardKey === candidateKey;
}
