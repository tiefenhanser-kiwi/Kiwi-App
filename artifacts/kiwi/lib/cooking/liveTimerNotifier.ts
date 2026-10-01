// D-WS9-289 — the only place expo-notifications is imported.
//
// Deliberately branchless: every decision (when to ask, when to schedule, when
// to cancel, and the iOS-only gate) lives in timerNotifications.ts, where it is
// tested. This file supplies the module, the platform and the two payload
// shapes, which are versioned expo-notifications API and not policy.
//
// ⚠️ THE PAYLOADS ARE 0.32 SHAPES. `shouldShowAlert` is deprecated in
// expo-notifications 0.32 in favour of `shouldShowBanner` + `shouldShowList`
// (Notifications.types.d.ts:603-607), and a date trigger is
// { type: "date", date } (SchedulableTriggerInputTypes.DATE). If either moves
// in a later SDK, it moves here and nowhere else.

import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import {
  createTimerNotifier,
  type TimerNotifier,
  type TimerPlatform,
} from "@/lib/cooking/timerNotifications";

// Foreground presentation. Without this, iOS suppresses the banner AND the
// sound while the app is open — which is the single most likely state for a
// cook timer to fire in, since the user is standing at the stove with Cook Mode
// on screen and keep-awake holding it there.
//
// ⚠️ THE SOUND IS THE FEATURE. There is no audio asset in this app; the alert
// tone is the notification's own, which is why shouldPlaySound must be true on
// both the handler and the request.
const FOREGROUND_HANDLER = {
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
};

export function createLiveTimerNotifier(): TimerNotifier {
  return createTimerNotifier({
    platform: Platform.OS as TimerPlatform,
    notifications: Notifications,
    handler: FOREGROUND_HANDLER,
    buildRequest: ({ label, endsAtMs }) => ({
      content: {
        // The step's own label as the title: on a lock screen "Braise the short
        // ribs" is the useful line, and "Timer done" is the predictable one.
        title: label,
        body: "Timer done.",
        sound: true,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: endsAtMs,
      },
    }),
  });
}
