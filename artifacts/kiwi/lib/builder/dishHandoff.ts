// WS7-6 G3-fix — in-place handoff for the dish-side "Ask Kiwi" launched FROM
// the Meal Builder's Add-a-dish sheet.
//
// The problem it solves: tapping Ask Kiwi inside the Meal Builder pushed the
// ask-kiwi-dish input screen (then the Dish Builder), where the drafted dish
// was saved STANDALONE and the user landed on Dish Detail — the dish never made
// it onto the meal they were building, and they lost their place. Every OTHER
// add-dish option (pick saved / simple / create-from-scratch) instead appends
// straight to the meal's in-memory dishes[] and stays put.
//
// expo-router keeps the Meal Builder mounted beneath the pushed input screen,
// so a module-level one-shot callback is the simplest reliable way to hand the
// parsed dish back on a `router.back()` pop (the router can't pass data back to
// an underlying screen). The Meal Builder arms a consumer right before
// navigating; ask-kiwi-dish delivers the parsed draft and pops.

import type { DraftDish } from "./parsedDishToDraft";

type DishConsumer = (draft: DraftDish) => void;

let consumer: DishConsumer | null = null;

/** Meal Builder arms this before pushing ask-kiwi-dish (returnToMeal flow). */
export function armDishHandoff(fn: DishConsumer): void {
  consumer = fn;
}

/** Cleared on Meal Builder unmount so a stale closure can't fire post-unmount. */
export function disarmDishHandoff(): void {
  consumer = null;
}

export function isDishHandoffArmed(): boolean {
  return consumer !== null;
}

/**
 * Deliver a parsed dish to the armed Meal Builder consumer. One-shot: clears
 * the consumer after firing. Returns false when nothing was armed (the caller
 * then falls back to the standalone Dish Builder so the draft isn't lost).
 */
export function deliverDishToBuilder(draft: DraftDish): boolean {
  if (!consumer) return false;
  const fn = consumer;
  consumer = null;
  fn(draft);
  return true;
}
