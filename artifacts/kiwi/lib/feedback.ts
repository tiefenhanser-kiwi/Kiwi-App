// LIFE-1 — Profile's "Send feedback" and "Rate Kiwi", the parts with no React.
//
// Pure on purpose: the platform comes in as a string, so every branch is
// tested in lib/__tests__/feedback.test.ts without a device.

/** The Play listing's package (app.json android.package). */
export const ANDROID_PACKAGE = "com.kitchenwizard.kiwi";

/**
 * Apple's NUMERIC App Store id (App Store Connect → App Information → Apple ID).
 *
 * ⚠️ EMPTY UNTIL HANS FILLS IT IN. It exists nowhere in the repo or canon, and
 * the iOS app was still in review when this was written. While it is empty the
 * "Rate Kiwi" row is hidden on iOS; filling it in is a one-line OTA.
 */
export const IOS_APP_STORE_ID = "";

/** Mirrors the server's FEEDBACK_MAX_CHARS (routes/feedback.ts). */
export const FEEDBACK_MAX_CHARS = 4000;

/**
 * The store link "Rate Kiwi" opens, or null when the row should not show.
 *   android — the Play app (market://), with an https fallback below
 *   ios     — the App Store's write-a-review sheet, once IOS_APP_STORE_ID is set
 *   web     — never: there is no store to send a browser to
 */
export function storeReviewUrl(os: string, iosAppStoreId: string = IOS_APP_STORE_ID): string | null {
  if (os === "android") return `market://details?id=${ANDROID_PACKAGE}`;
  if (os === "ios" && iosAppStoreId) {
    return `itms-apps://apps.apple.com/app/id${iosAppStoreId}?action=write-review`;
  }
  return null;
}

/** The https page to open when the store app itself cannot be (no Play Store, an emulator). */
export function storeWebUrl(os: string, iosAppStoreId: string = IOS_APP_STORE_ID): string | null {
  if (os === "android") return `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`;
  if (os === "ios" && iosAppStoreId) return `https://apps.apple.com/app/id${iosAppStoreId}`;
  return null;
}

export function canSendFeedback(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= FEEDBACK_MAX_CHARS;
}

export function feedbackPlatform(os: string): "ios" | "android" | "web" | undefined {
  return os === "ios" || os === "android" || os === "web" ? os : undefined;
}

/** What the screen says when a send fails, by the server's answer. */
export function feedbackErrorText(status: number | null): string {
  if (status === 429) return "That's a lot of feedback at once. Please try again in a few minutes.";
  if (status === 503) return "Feedback isn't available right now. You can email support@kitchenwizard.ai instead.";
  if (status === null) return "Couldn't reach Kiwi. Check your connection and try again.";
  return "Couldn't send your feedback. Please try again.";
}
