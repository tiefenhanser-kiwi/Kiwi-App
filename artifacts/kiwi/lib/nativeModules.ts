// 1.2-NATIVE G — every native module the 1.2 binary adds is reached through
// this check, never by a top-level import of its package. expo-store-review
// and expo-web-browser call requireNativeModule() when their JS loads, which
// THROWS on a binary without them: one stray import and a 1.1 binary that
// somehow got a 1.2 bundle would crash at launch. With this check it only
// loses the feature.
//
// The 1.1 modules (expo-updates, expo-notifications, expo-crypto, ...) are in
// both binaries and are imported as before.
import { TurboModuleRegistry } from "react-native";
import { requireOptionalNativeModule } from "expo";

/** Native module names, as the packages register them. */
export const NATIVE_MODULE = {
  /** @sentry/react-native (TurboModule; its JS reads it with .get, never getEnforcing). */
  sentry: "RNSentry",
  /** expo-store-review (expo module). */
  storeReview: "ExpoStoreReview",
  /** expo-web-browser (expo module) — D-WS9-325, unused so far. */
  webBrowser: "ExpoWebBrowser",
} as const;

export type NativeModuleKey = keyof typeof NATIVE_MODULE;

/** True when the running binary carries the module. Never throws. */
export function hasNativeModule(key: NativeModuleKey): boolean {
  try {
    if (key === "sentry") return TurboModuleRegistry.get(NATIVE_MODULE.sentry) != null;
    return requireOptionalNativeModule(NATIVE_MODULE[key]) != null;
  } catch {
    return false;
  }
}
