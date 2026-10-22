// LIFE-1 — Profile's "Send feedback" and "Rate Kiwi", the parts with no React.
//
// Pure on purpose: the platform comes in as a string, so every branch is
// tested in lib/__tests__/feedback.test.ts without a device.

/** The Play listing's package (app.json android.package). */
export const ANDROID_PACKAGE = "com.kitchenwizard.kiwi";

/**
 * Apple's NUMERIC App Store id (App Store Connect → App Information → Apple ID).
 *
 * FIX-7 — read from App Store Connect by Hans, October 18 2026. Empty hides the
 * "Rate Kiwi" row on iOS (storeReviewUrl returns null), which is how LIFE-1
 * shipped it while the iOS app was still in review.
 */
export const IOS_APP_STORE_ID = "6816201328";

/** Mirrors the server's FEEDBACK_MAX_CHARS (routes/feedback.ts). */
export const FEEDBACK_MAX_CHARS = 4000;

/**
 * SEC-3 E — the room the device lines take at the end of the message (Hans,
 * Oct 21: "we should include that in the feedback emails automatically").
 * routes/feedback.ts's schema is `.strict()`, so a field of its own would 400
 * every send until the server accepts one; the message is the one place it
 * reaches the email today. What the member types is capped below this.
 */
export const FEEDBACK_DEVICE_MAX_CHARS = 300;
export const FEEDBACK_MESSAGE_MAX_CHARS = FEEDBACK_MAX_CHARS - FEEDBACK_DEVICE_MAX_CHARS;

export interface DeviceFacts {
  os: string;
  /** Platform.Version: the API level on Android, the iOS version string on iOS. */
  version?: string | number | null;
  /** Android's release ("14"), from Platform.constants.Release. */
  release?: string | null;
  /** The browser's user agent, on the web (it carries the OS and its version). */
  userAgent?: string | null;
}

/** The platform and its OS version, e.g. "Android 14 (API 34)", "iOS 17.4". */
export function osLine(f: DeviceFacts): string {
  if (f.os === "android") {
    const api = f.version != null && f.version !== "" ? ` (API ${f.version})` : "";
    return `Android ${f.release || "unknown"}${api}`;
  }
  if (f.os === "ios") return `iOS ${f.version || "unknown"}`;
  if (f.os === "web") return f.userAgent ? `web · ${f.userAgent}` : "web";
  return f.os;
}

/**
 * The message as sent: the member's text, then Profile's footer line and the
 * OS line under a rule. The two lines together never pass
 * FEEDBACK_DEVICE_MAX_CHARS (a long user agent is cut), so a message within
 * FEEDBACK_MESSAGE_MAX_CHARS always fits the server's limit.
 */
export function withDeviceLines(message: string, bundle: string, os: string): string {
  const lines = `${bundle}\n${os}`;
  const room = FEEDBACK_DEVICE_MAX_CHARS - "\n\n—\n".length;
  return `${message}\n\n—\n${lines.length > room ? `${lines.slice(0, room - 1)}…` : lines}`;
}

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
  return t.length > 0 && t.length <= FEEDBACK_MESSAGE_MAX_CHARS;
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
