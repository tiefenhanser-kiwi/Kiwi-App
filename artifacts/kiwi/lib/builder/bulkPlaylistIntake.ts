// WS9 Redesign Arc Block 2c Part A (D-WS9-244) — the Playlist BULK intake.
//
// Hans, September 16: "bulk playlist should be included for launch, but the
// parallel AI calls is not. so, each box calls the AI and we don't have to
// worry about serialization or caching." And the shape: "a multiple text box
// UI … each time they add a meal, the text from each text box would hit the
// add meal AI call and then auto-save the meal."
//
// 🔴 SEQUENTIAL IS THE SPECIFICATION. One Ask-Kiwi meal call per non-empty
// box, ONE AT A TIME, in box order — no Promise.all, no batching, no
// prompt-cache work. A box that fails does not stop the rest and does not
// lose the ones already saved; it stays on screen with its text and a Retry.
//
// Each box takes EXACTLY the single Ask-Kiwi path, minus the human in the
// middle: POST /builder/parse-meal (the same call app/ask-kiwi.tsx makes, the
// same two live prompt rules — a brand name is a product, a plain name a
// plain dish) → parsedMealToDraft (the Mode-A adapter) → the Meal Builder's
// own draft hydration + manual save serializer (hydrateBuilderDishesFromDraft
// + buildManualSaveMealInput, sourceType "directed" — what the builder's Save
// posts for an untouched draft) → saveMeal (POST /me/meals) → addToPlaylist
// (POST /me/playlist, the completePlaylistSave step). The screen injects the
// real calls; tests inject fakes and assert the ORDER.

import type { ParseMealInput, ParseMealResult } from "@/lib/api/builder";
import {
  ApiError,
  UpgradeRequiredError,
  spendGuardRefusal,
} from "@/lib/api/errors";
import type { SaveMealInput, SaveMealResponse } from "@/lib/api/meals";
import {
  buildManualSaveMealInput,
  hydrateBuilderDishesFromDraft,
  type UidAllocator,
} from "@/lib/meal-builder-state";
import type { DraftMeal } from "@/lib/types";

import { ASK_KIWI_AI_FAILED_MESSAGE } from "./askKiwiSubmit";
import { parsedMealToDraft } from "./parsedMealToDraft";

// ── Copy (Hans's words where he gave them) ──────────────────────────────────
export const BULK_SECTION_LABEL = "Several at once";
export const BULK_SECTION_TITLE = "Name the meals you already cook";
export const BULK_SECTION_SUBLINE = "One per box — Kiwi does the rest";
export const BULK_PLACEHOLDERS = [
  "grilled chicken breasts, box of rice pilaf, roasted broccoli",
  "chicken thigh tacos with pico and saucy black beans",
  "frozen cheese pizza and chicken caesar salad",
] as const;
export const BULK_ADD_ANOTHER = "+ Add another meal";
export const BULK_SUBMIT = "Add these meals";
export const BULK_SUBMIT_CAPTION = "Kiwi drafts each one and saves it to your playlist";
export const BULK_STATUS_WAITING = "waiting";
export const BULK_STATUS_WRITING = "Kiwi is writing this one…";
export const BULK_STATUS_SAVED = "saved ✓";
export const BULK_STATUS_FAILED = "failed";
export const BULK_RETRY = "Retry";
export const BULK_UPGRADE_MESSAGE = "Asking Kiwi for meals needs an upgrade.";

export type BulkBoxStatus = "idle" | "waiting" | "writing" | "saved" | "failed";

export interface BulkBox {
  id: string;
  text: string;
  status: BulkBoxStatus;
  /** Set on "saved". */
  mealId?: string;
  title?: string;
  /** Set on "failed". */
  error?: string;
}

export const BULK_INITIAL_BOXES = 3;

let boxSeq = 0;
export function newBox(): BulkBox {
  boxSeq += 1;
  return { id: `box-${boxSeq}`, text: "", status: "idle" };
}
export function initialBoxes(n: number = BULK_INITIAL_BOXES): BulkBox[] {
  return Array.from({ length: n }, () => newBox());
}
export function addBox(boxes: BulkBox[]): BulkBox[] {
  return [...boxes, newBox()];
}
export function setBoxText(boxes: BulkBox[], id: string, text: string): BulkBox[] {
  return boxes.map((b) =>
    b.id === id
      ? // Editing a failed box's text puts it back to idle; a saved box is inert.
        { ...b, text, ...(b.status === "failed" ? { status: "idle" as const, error: undefined } : {}) }
      : b,
  );
}
/** The boxes a run will process: non-empty text, not already saved. */
export function runnableBoxes(boxes: readonly BulkBox[]): BulkBox[] {
  return boxes.filter((b) => b.text.trim().length > 0 && b.status !== "saved");
}
export function savedBoxes(boxes: readonly BulkBox[]): { mealId: string; title: string }[] {
  return boxes
    .filter((b): b is BulkBox & { mealId: string } => b.status === "saved" && !!b.mealId)
    .map((b) => ({ mealId: b.mealId, title: b.title ?? b.text.trim() }));
}

// ── The draft → save body, exactly as the builder's Save would post it ──────
/**
 * What the Meal Builder posts for an UNTOUCHED draft: its form state is
 * hydrated from the draft (title, cuisine, difficulty, minutes as a string,
 * servings, notes) and its dishes through hydrateBuilderDishesFromDraft; the
 * manual serializer then builds the POST /me/meals body with sourceType
 * "directed". Same functions, same values — no second save path.
 */
export function draftToSaveMealInput(draft: DraftMeal): SaveMealInput {
  let uid = 0;
  const allocUid: UidAllocator = () => ++uid;
  return buildManualSaveMealInput({
    mealName: draft.title,
    cuisineType: draft.cuisineType ?? "",
    difficulty: draft.difficulty,
    estimatedTimeMinutes: String(draft.estimatedTimeMinutes),
    servingsDefault: draft.servingsDefault,
    notes: draft.notes ?? "",
    dishes: hydrateBuilderDishesFromDraft(draft, allocUid),
    sourceType: "directed",
    // WS9 BUG-288 — the parse's headnote + tags reach the save body.
    ...(draft.description ? { description: draft.description } : {}),
    tags: draft.tags,
  });
}

// ── The sequential runner ───────────────────────────────────────────────────
export interface BulkIntakeDeps {
  /** Real impl: parseMeal from lib/api/builder (the single Ask-Kiwi call). */
  parseMeal: (input: ParseMealInput) => Promise<ParseMealResult>;
  /** Real impl: useApp().saveMeal (POST /me/meals + the meals-list invalidation). */
  saveMeal: (input: SaveMealInput) => Promise<SaveMealResponse>;
  /** Real impl: addToPlaylist from lib/api/playlist (POST /me/playlist). */
  addToPlaylist: (mealId: string) => Promise<unknown>;
  /** Servings for the parse — the Ask-Kiwi screen's default. */
  servings: number;
  /** Every state change, in order; the screen re-renders from these. */
  onBoxUpdate: (box: BulkBox) => void;
}

export interface BulkIntakeOutcome {
  saved: { mealId: string; title: string }[];
  failed: string[];
  /** A 402 stopped the run — route to the upgrade modal. */
  upgradeRequired: boolean;
}

function failureMessage(err: unknown): string {
  if (err instanceof UpgradeRequiredError) return BULK_UPGRADE_MESSAGE;
  if (err instanceof ApiError) {
    const refusal = spendGuardRefusal(err.body);
    if (refusal) return refusal.message;
    // A save-side 400 carries the validation reason; a parse 502 does not.
    if (err.status === 400 && err.userFacingMessage) return err.userFacingMessage;
    return ASK_KIWI_AI_FAILED_MESSAGE;
  }
  return ASK_KIWI_AI_FAILED_MESSAGE;
}

/**
 * Run the boxes ONE AT A TIME, in order. Each box: parse → draft → save body
 * → save → add to playlist. A failure marks that box and moves on; an
 * UpgradeRequiredError (402) stops the run — every later box would 402 too —
 * leaving the rest untouched (idle) for after the upgrade. Never throws.
 */
export async function runBulkIntake(
  boxes: readonly BulkBox[],
  deps: BulkIntakeDeps,
): Promise<BulkIntakeOutcome> {
  const queue = runnableBoxes(boxes);
  const outcome: BulkIntakeOutcome = { saved: [], failed: [], upgradeRequired: false };
  for (const b of queue) deps.onBoxUpdate({ ...b, status: "waiting", error: undefined });

  // 🔴 A plain for…of with an await per box IS the specification (sequential,
  // in order). Do not "optimise" this into Promise.all.
  for (const box of queue) {
    if (outcome.upgradeRequired) {
      deps.onBoxUpdate({ ...box, status: "idle", error: undefined });
      continue;
    }
    deps.onBoxUpdate({ ...box, status: "writing", error: undefined });
    try {
      const { meal } = await deps.parseMeal({
        freeText: box.text.trim(),
        servings: deps.servings,
      });
      const draft = parsedMealToDraft(meal);
      const input = draftToSaveMealInput(draft);
      const { id: mealId } = await deps.saveMeal(input);
      // The meal IS saved from here; a playlist-add failure still counts the
      // meal as saved on the single path (completePlaylistSave navigates
      // anyway) — here it reads as failed so the user gets a Retry, and the
      // retry's second POST /me/meals would duplicate the meal. So: the add
      // is retried alone when the save already landed.
      await addWithSavedMeal(deps, box, mealId, input.title, outcome);
    } catch (err) {
      const message = failureMessage(err);
      if (err instanceof UpgradeRequiredError) outcome.upgradeRequired = true;
      outcome.failed.push(box.id);
      deps.onBoxUpdate({ ...box, status: "failed", error: message });
    }
  }
  return outcome;
}

async function addWithSavedMeal(
  deps: BulkIntakeDeps,
  box: BulkBox,
  mealId: string,
  title: string,
  outcome: BulkIntakeOutcome,
): Promise<void> {
  try {
    await deps.addToPlaylist(mealId);
  } catch (err) {
    // Saved but not on the playlist: surface it as failed WITH the meal id so
    // Retry re-runs only the add (see retryBox).
    outcome.failed.push(box.id);
    deps.onBoxUpdate({
      ...box,
      status: "failed",
      mealId,
      title,
      error: `Saved, but adding it to your playlist failed: ${failureMessage(err)}`,
    });
    return;
  }
  outcome.saved.push({ mealId, title });
  deps.onBoxUpdate({ ...box, status: "saved", mealId, title, error: undefined });
}

/**
 * Retry ONE failed box. A box whose meal already saved (mealId set) retries
 * only the playlist add — a second parse + save would duplicate the meal.
 */
export async function retryBox(box: BulkBox, deps: BulkIntakeDeps): Promise<BulkIntakeOutcome> {
  if (box.status === "failed" && box.mealId) {
    const outcome: BulkIntakeOutcome = { saved: [], failed: [], upgradeRequired: false };
    deps.onBoxUpdate({ ...box, status: "writing", error: undefined });
    await addWithSavedMeal(deps, box, box.mealId, box.title ?? box.text.trim(), outcome);
    return outcome;
  }
  return runBulkIntake([{ ...box, status: "idle", error: undefined }], deps);
}
