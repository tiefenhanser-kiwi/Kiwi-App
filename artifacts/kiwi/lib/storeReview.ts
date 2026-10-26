// 1.2-NATIVE C — the live half of lib/reviewPrompt.ts: the device's count of
// Cook Mode finishes, and expo-store-review's native sheet.
//
// expo-store-review is never imported at the top: its JS calls
// requireNativeModule() on load, which throws on a binary without it (1.1). It
// is required only after hasNativeModule("storeReview") says the binary has it.
import { Platform } from "react-native";

import { hasNativeModule } from "./nativeModules";
import {
  INITIAL_REVIEW_STATE,
  REVIEW_DELAY_MS,
  markReviewAsked,
  readReviewState,
  recordCookFinish,
  shouldAskForReview,
} from "./reviewPrompt";
import { loadJSON, saveJSON } from "./storage";

const STORAGE_KEY = "storeReview";

type StoreReviewModule = typeof import("expo-store-review");

function loadStoreReview(): StoreReviewModule | null {
  if (!hasNativeModule("storeReview")) return null;
  try {
    return require("expo-store-review") as StoreReviewModule;
  } catch {
    return null;
  }
}

/** The cook left Cook Mode on its last live step. Never throws. */
export async function noteCookFinished(signupAt: string | null | undefined): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const state = recordCookFinish(readReviewState(await loadJSON<unknown>(STORAGE_KEY, INITIAL_REVIEW_STATE)));
    await saveJSON(STORAGE_KEY, state);
    const now = Date.now();
    if (!shouldAskForReview({ platform: Platform.OS, state, signupAt, now })) return;
    const review = loadStoreReview();
    if (!review || !(await review.isAvailableAsync())) return;
    // Stamped before asking: the OS decides whether the sheet shows (Apple caps
    // it at 3 a year), and a stamp after could be lost to a crash and re-ask.
    await saveJSON(STORAGE_KEY, markReviewAsked(state, now));
    setTimeout(() => {
      review.requestReview().catch(() => {});
    }, REVIEW_DELAY_MS);
  } catch {
    // A review prompt is never worth an error.
  }
}
