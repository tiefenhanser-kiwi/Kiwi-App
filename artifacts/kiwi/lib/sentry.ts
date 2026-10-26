// 1.2-NATIVE B — the live Sentry wiring (native). The rules are in
// lib/crashReporting.ts; lib/sentry.web.ts is the no-op web twin, so the web
// bundle carries none of the SDK.
//
// @sentry/react-native is import-safe on a binary without RNSentry (its JS
// looks the module up with TurboModuleRegistry.get), but init still waits on
// hasNativeModule("sentry"): a 1.1 binary running a 1.2 bundle reports nothing
// rather than half of it.
import { Platform } from "react-native";
import * as Sentry from "@sentry/react-native";
import * as Crypto from "expo-crypto";

import {
  crashReportingEnabled,
  crashUserIdInput,
  scrubBreadcrumb,
  scrubEvent,
} from "./crashReporting";
import { hasNativeModule } from "./nativeModules";

let active = false;

/** Once, at module load of app/_layout.tsx, before the first render. */
export function initCrashReporting(): void {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!crashReportingEnabled({ platform: Platform.OS, dsn, isDev: __DEV__, hasNative: hasNativeModule("sentry") })) {
    return;
  }
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    attachScreenshot: false,
    attachViewHierarchy: false,
    // Crashes only: no performance tracing, no touch tracing, no failed-request
    // events (those carry the request).
    enableAutoPerformanceTracing: false,
    enableUserInteractionTracing: false,
    enableCaptureFailedRequests: false,
    maxBreadcrumbs: 30,
    beforeBreadcrumb: (b) => scrubBreadcrumb(b),
    beforeSend: (e) => scrubEvent(e),
  });
  active = true;
}

/** The signed-in user as a hashed id, or none. */
export async function setCrashUser(userId: string | null): Promise<void> {
  if (!active) return;
  if (!userId) {
    Sentry.setUser(null);
    return;
  }
  try {
    const id = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, crashUserIdInput(userId));
    Sentry.setUser({ id });
  } catch {
    Sentry.setUser(null);
  }
}

/** components/ErrorBoundary's onError: a render crash the boundary caught. */
export function reportBoundaryError(error: Error): void {
  if (!active) return;
  Sentry.captureException(error);
}
