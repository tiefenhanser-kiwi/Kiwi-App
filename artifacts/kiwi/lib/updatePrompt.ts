// BUG-525 (1.2-NATIVE A) — a phone that stays warm never cold-starts, so it
// never applies the update expo-updates downloaded at its last launch: it runs
// an old bundle for days. On every return to the foreground the app now asks
// for the newest update, downloads it, and says so in one quiet line; the
// reload happens only when the cook taps it.
//
// Pure, so it is tested here. The expo-updates calls are injected (the live
// ones are in components/UpdateReadyLine.tsx), like lib/cooking's notifier.
// Nothing here needs a 1.2 binary: expo-updates is in the 1.1 binary too, so
// this half reaches 1.1 phones by update (release/1.1).

/** At most one check per this gap: a foreground every few seconds (a share
 *  sheet, a permission dialog) must not hit u.expo.dev each time. */
export const UPDATE_CHECK_MIN_GAP_MS = 10 * 60_000;

/** The line shows this long, then hides; the next foreground shows it again
 *  while the update is still waiting. Persistent, it would cover the Header's
 *  back button (it sits where Toast does). */
export const UPDATE_LINE_MS = 8_000;

export const UPDATE_LINE_TEXT = "Kiwi updated — tap to restart";

/**
 * The routes the line never shows on, by their first segment: Cook Mode and
 * Prep the Week. A cook with wet hands must not lose the step they are on to a
 * stray tap, and the line must not cover a step either.
 */
export const NO_UPDATE_LINE_ROUTES: readonly string[] = ["cook-session", "prep-cook"];

export interface UpdateCheckInput {
  platform: string;
  /** expo-updates' isEnabled: false in a dev build (Metro serves the JS). */
  isEnabled: boolean;
  /** An update is already downloaded and waiting: nothing to check. */
  isPending: boolean;
  /** When the last check started (ms), or null for never. */
  lastCheckAt: number | null;
  now: number;
}

export function shouldCheckForUpdate(i: UpdateCheckInput): boolean {
  if (i.platform === "web" || !i.isEnabled || i.isPending) return false;
  return i.lastCheckAt === null || i.now - i.lastCheckAt >= UPDATE_CHECK_MIN_GAP_MS;
}

/** The slice of expo-updates the check uses. */
export interface UpdatesApi {
  checkForUpdateAsync(): Promise<{ isAvailable: boolean }>;
  fetchUpdateAsync(): Promise<{ isNew: boolean }>;
}

export type UpdateCheckResult = "downloaded" | "none" | "failed";

/** Check, and download what the check found. Never throws: a phone offline or
 *  a slow u.expo.dev is "failed", and the next foreground tries again. */
export async function checkAndFetchUpdate(api: UpdatesApi): Promise<UpdateCheckResult> {
  try {
    const check = await api.checkForUpdateAsync();
    if (!check.isAvailable) return "none";
    const fetched = await api.fetchUpdateAsync();
    return fetched.isNew ? "downloaded" : "none";
  } catch {
    return "failed";
  }
}

/** The line shows when an update is waiting and the cook is not in Cook Mode
 *  or Prep the Week. `route` is the first route segment. */
export function updateLineVisible(isPending: boolean, route: string | undefined): boolean {
  return isPending && !(route !== undefined && NO_UPDATE_LINE_ROUTES.includes(route));
}
