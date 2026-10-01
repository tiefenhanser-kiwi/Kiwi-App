// D-WS9-289 — a local notification when a Cook Mode timer runs out.
//
// Hans, verbatim: "we should ask for notification permission on the next
// submission to the appstore and allow for notifications when timers go off.
// roadmap wise, we want to tell people when to start cooking, but that's not
// near term."
//
// ⚠️ iOS ONLY, AND THAT IS A RULING, NOT A SHORTCUT. (Hans, Sept 30.)
//
// expo-notifications schedules on Android through AlarmManager, and
// ExpoSchedulingDelegate.setupAlarm takes the EXACT path only when
// `SDK_INT < S || alarmManager.canScheduleExactAlarms()`. Kiwi declares neither
// SCHEDULE_EXACT_ALARM nor USE_EXACT_ALARM (the module's own manifest carries
// only RECEIVE_BOOT_COMPLETED + POST_NOTIFICATIONS, and its config plugin adds
// no permission), so on Android 12+ every scheduled timer takes the INEXACT
// branch, setAndAllowWhileIdle. Android's own documentation on that path: "On
// Android 12 (API level 31) and higher, the system invokes the alarm within one
// hour of the supplied trigger time, unless any battery-saving restrictions are
// in effect." A kitchen timer that can fire an hour late is worse than no
// notification at all — it is actively misleading about food.
//
// So on Android we schedule NOTHING and ask for NO permission. The completion
// haptic in useStepTimers is unchanged and remains the whole Android story.
// Buying exactness would mean declaring SCHEDULE_EXACT_ALARM, which is a Play
// Console declaration against a policy that restricts it to alarm-clock, timer
// and calendar apps — a launch decision, deliberately not taken here.
//
// ⚠️ NO app.json CHANGE WAS NEEDED. Commit 1025a96 ("[packaging] Part C")
// already installed expo-notifications ~0.32.17 and added its config plugin
// with { "mode": "production" }. The original design-review prompt listed the
// plugin entry as 1.1's native update; it was already done.
//
// ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
// hooks/ and app/ are awkward places for this logic: the permission state
// machine has a rule that only a test can hold honest ("a denial is never
// re-asked in this session"), and the platform gate has to be an INPUT so the
// Android branch is provable rather than merely believed. Everything here is
// pure and injected; the live expo-notifications wiring is the ~30 lines in
// liveTimerNotifier.ts, which has no branches to get wrong.

/** Platform.OS, narrowed to the three values this app ships on. */
export type TimerPlatform = "ios" | "android" | "web";

/** What a permission call resolves to. Only "granted" grants. */
export interface PermissionResult {
  status: string;
}

/**
 * The slice of expo-notifications this module uses, and nothing more. Written
 * as an interface so the tests inject a recorder and `expo-notifications` never
 * enters the test module graph.
 */
export interface NotificationsModule {
  getPermissionsAsync(): Promise<PermissionResult>;
  requestPermissionsAsync(): Promise<PermissionResult>;
  /** Resolves to the scheduled notification's identifier. */
  scheduleNotificationAsync(request: unknown): Promise<string>;
  cancelScheduledNotificationAsync(identifier: string): Promise<void>;
  setNotificationHandler(handler: unknown): void;
}

export interface TimerNotifierDeps {
  platform: TimerPlatform;
  notifications: NotificationsModule;
  /**
   * Builds the schedule request. Injected so this module states the POLICY
   * (when to ask, when to schedule, when to cancel) and liveTimerNotifier owns
   * the expo-notifications payload shape, which is a versioned API.
   */
  buildRequest(args: { label: string; endsAtMs: number }): unknown;
  /** The foreground-presentation handler, opaque here. */
  handler: unknown;
}

export type PermissionState = "unknown" | "granted" | "denied";

export interface TimerNotifier {
  /**
   * Schedule (or RE-schedule) the alert for `key`. Called on start and again on
   * every "Add a minute" — rescheduling is cancel-then-schedule, so there is
   * never more than one pending alert per timer.
   */
  schedule(key: string, label: string, endsAtMs: number): Promise<void>;
  /** Cancel the pending alert for `key`. Never asks for permission. */
  cancel(key: string): Promise<void>;
  /** Inspection, for tests and for nothing else. */
  permissionState(): PermissionState;
  pendingKeys(): string[];
}

/** Used by the no-op branches. Resolved, not undefined, so callers can await. */
const DONE = Promise.resolve();

export function createTimerNotifier(deps: TimerNotifierDeps): TimerNotifier {
  const { platform, notifications, buildRequest, handler } = deps;

  // ⚠️ SESSION-SCOPED, and that is the point of holding it here rather than
  // asking the OS each time. Once the user has said no, the app must not ask
  // again for the rest of the session: a permission sheet that reappears on
  // every timer is the behaviour that gets an app uninstalled. A fresh launch
  // rebuilds this notifier, so a user who changed their mind in Settings is
  // picked up then — we read getPermissionsAsync before ever prompting.
  // ⚠️ THE iOS GATE IS DOUBLED ON PURPOSE, and both halves are load-bearing
  // belt-and-braces rather than one of them being dead code:
  //
  //   1. this initialiser — a non-iOS session starts "denied", so ensurePermission
  //      short-circuits and no OS call is ever made;
  //   2. the `platform !== "ios"` guards at the top of schedule() and cancel().
  //
  // Each independently prevents every Android/web call, which is why a
  // deliberate break that removed only ONE of them left the Android test GREEN
  // (recorded Sept 30 — the break was re-run against both halves at once, which
  // is red). Do not delete either as redundant: the whole point is that turning
  // Android on has to be a deliberate, visible, two-place change.
  let permission: PermissionState = platform === "ios" ? "unknown" : "denied";
  let handlerSet = false;

  /** key -> the scheduled notification identifier we hold for it. */
  const ids = new Map<string, string>();
  // Per-key monotonic token. "Add a minute" tapped twice in a second issues two
  // overlapping schedules; whichever resolves second is the one that counts,
  // and the loser's identifier is cancelled rather than leaked into `ids` where
  // nothing would ever cancel it.
  const tokens = new Map<string, number>();

  async function ensurePermission(): Promise<boolean> {
    if (permission === "granted") return true;
    if (permission === "denied") return false;

    // Already granted from a previous session? Then never prompt.
    const existing = await notifications.getPermissionsAsync();
    if (existing.status === "granted") {
      permission = "granted";
      return true;
    }
    // ⚠️ THE ASK HAPPENS HERE — at the user's FIRST TIMER START, never at
    // signup and never in onboarding. The request is legible at this moment
    // ("you started a timer") and meaningless at the other two.
    const asked = await notifications.requestPermissionsAsync();
    permission = asked.status === "granted" ? "granted" : "denied";
    return permission === "granted";
  }

  async function schedule(key: string, label: string, endsAtMs: number): Promise<void> {
    if (platform !== "ios") return DONE;
    if (!(await ensurePermission())) return DONE; // silent fallback to the haptic

    // The handler is set lazily, on the first alert we actually schedule,
    // rather than at app boot. It cannot be late: nothing can be delivered
    // before something is scheduled. And a user who never starts a timer never
    // pays for it.
    if (!handlerSet) {
      notifications.setNotificationHandler(handler);
      handlerSet = true;
    }

    const token = (tokens.get(key) ?? 0) + 1;
    tokens.set(key, token);

    // Reschedule is cancel-then-schedule. Drop the old id BEFORE awaiting so a
    // concurrent cancel() cannot cancel it twice.
    const previous = ids.get(key);
    if (previous !== undefined) {
      ids.delete(key);
      await notifications.cancelScheduledNotificationAsync(previous);
    }

    const id = await notifications.scheduleNotificationAsync(
      buildRequest({ label, endsAtMs }),
    );
    if (tokens.get(key) !== token) {
      // A newer schedule() or a cancel() overtook us. Ours is orphaned.
      await notifications.cancelScheduledNotificationAsync(id);
      return;
    }
    ids.set(key, id);
  }

  async function cancel(key: string): Promise<void> {
    if (platform !== "ios") return DONE;
    // Bump the token so an in-flight schedule() for this key discards itself.
    tokens.set(key, (tokens.get(key) ?? 0) + 1);
    const id = ids.get(key);
    // ⚠️ NO ensurePermission() HERE. Cancelling must never surface a permission
    // prompt, and there is nothing to cancel if we never scheduled.
    if (id === undefined) return DONE;
    ids.delete(key);
    await notifications.cancelScheduledNotificationAsync(id);
  }

  return {
    schedule,
    cancel,
    permissionState: () => permission,
    pendingKeys: () => [...ids.keys()],
  };
}
