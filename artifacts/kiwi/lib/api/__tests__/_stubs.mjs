// Virtual replacements for Expo native modules so the pure-TS modules
// can be tested under plain Node. Loaded by _loader.mjs.

export const SecureStoreStub = `
let __store = new Map();
let __throwOn = null;
export function __resetForTests() { __store.clear(); __throwOn = null; }
export function __setForTests(k, v) { __store.set(k, v); }
export function __setThrowOn(method) { __throwOn = method; }
export async function getItemAsync(key) {
  if (__throwOn === "getItemAsync") throw new Error("stub: getItemAsync forced failure");
  return __store.get(key) ?? null;
}
export async function setItemAsync(key, value) {
  if (__throwOn === "setItemAsync") throw new Error("stub: setItemAsync forced failure");
  __store.set(key, value);
}
export async function deleteItemAsync(key) {
  if (__throwOn === "deleteItemAsync") throw new Error("stub: deleteItemAsync forced failure");
  __store.delete(key);
}
`;

export const ImageManipulatorStub = `
export const SaveFormat = { JPEG: "jpeg" };
export async function manipulateAsync() {
  return { width: 100, height: 100, base64: "stub" };
}
`;

// Note: react-native, @expo/vector-icons, and react-native-safe-area-context
// stubs live as physical .mjs files in ./stubs/ (WS7-4-B c6). They import
// React, which the inline data-URL stub channel here cannot satisfy because
// it has no package.json scope; the loader routes those specifiers to the
// physical files via PHYSICAL_STUBS in _loader.mjs.

// expo/fetch — the streaming fetch. Tests inject a fetchImpl into
// streamWizardPlans, so this module-level export is only here to satisfy the
// import graph; calling it directly in a test is a mistake and throws loudly.
export const ExpoFetchStub = `
export async function fetch() {
  throw new Error("stub: expo/fetch called without an injected fetchImpl");
}
`;

// In-memory AsyncStorage — lets AppContext (and lib/storage) load + run under
// plain Node. Default export mirrors the real module's surface; the named
// __resetForTests lets test harnesses clear state between cases.
export const AsyncStorageStub = `
let __store = new Map();
const AsyncStorage = {
  async getItem(key) { return __store.has(key) ? __store.get(key) : null; },
  async setItem(key, value) { __store.set(key, String(value)); },
  async removeItem(key) { __store.delete(key); },
  async clear() { __store.clear(); },
  async getAllKeys() { return [...__store.keys()]; },
  async multiGet(keys) {
    return keys.map((k) => [k, __store.has(k) ? __store.get(k) : null]);
  },
  async multiSet(pairs) {
    for (const [k, v] of pairs) __store.set(k, String(v));
  },
  async multiRemove(keys) {
    for (const k of keys) __store.delete(k);
  },
  // Test-only — exposed both on the default object and as a named export.
  __resetForTests() { __store.clear(); },
};
export function __resetForTests() { __store.clear(); }
export default AsyncStorage;
`;

// Row 9 (1.1) · OAuth Block 2 Part D — expo-crypto, backed by node:crypto.
//
// A REAL implementation, not a canned string: lib/oauth/nonce.ts's whole job is
// the hex contract, and a stub that returned a fixed value would make the test
// that matters vacuous. The three production implementations were read and all
// three return lower-case hex of the UTF-8 bytes (see nonce.ts's header); this
// matches them.
//
// It exists so lib/oauth/appleWeb.ts is importable under `node --test` —
// readAppleWebSuccess is pure and worth pinning, and it lives in the same
// module as the script loading.
export const ExpoCryptoStub = `
import { createHash, randomFillSync } from "node:crypto";
export const CryptoDigestAlgorithm = { SHA256: "SHA-256" };
export const CryptoEncoding = { HEX: "hex", BASE64: "base64" };
export async function digestStringAsync(algorithm, data, options = { encoding: "hex" }) {
  if (algorithm !== "SHA-256") throw new Error("stub: only SHA-256 is wired");
  return createHash("sha256").update(data, "utf8").digest(options.encoding);
}
export function getRandomBytes(byteCount) {
  return randomFillSync(new Uint8Array(byteCount));
}
export async function getRandomBytesAsync(byteCount) {
  return getRandomBytes(byteCount);
}
export function getRandomValues(typedArray) {
  return randomFillSync(typedArray);
}
export function randomUUID() {
  return "00000000-0000-4000-8000-000000000000";
}
`;

// D-WS9-289 — expo-notifications. Stubbed for the same reason every other Expo
// native module here is: importing the real one pulls \`expo\` itself into the
// graph, and node's --experimental-strip-types refuses .ts under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING on expo/src/Expo.ts).
//
// ⚠️ THIS STUB IS NOT WHAT THE TESTS ASSERT AGAINST. The notification policy is
// tested against an injected recorder in lib/cooking/__tests__/timerNotifications.test.ts;
// this exists only so hooks/useStepTimers.ts can keep a STATIC import of
// lib/cooking/liveTimerNotifier.ts (which is the honest production shape) while
// being mountable under node:test. Every function here throws if actually
// called, so a test that reaches the live wiring by accident FAILS rather than
// silently passing against a fake.
export const ExpoNotificationsStub = `
const unreachable = (name) => {
  throw new Error(
    "stub: expo-notifications." + name + " was called. The tests inject a " +
    "TimerNotifier; reaching the live module means the seam was bypassed."
  );
};
export const SchedulableTriggerInputTypes = { DATE: "date", TIME_INTERVAL: "timeInterval" };
export async function getPermissionsAsync() { unreachable("getPermissionsAsync"); }
export async function requestPermissionsAsync() { unreachable("requestPermissionsAsync"); }
export async function scheduleNotificationAsync() { unreachable("scheduleNotificationAsync"); }
export async function cancelScheduledNotificationAsync() { unreachable("cancelScheduledNotificationAsync"); }
export function setNotificationHandler() { unreachable("setNotificationHandler"); }
`;

// Sept 29 design review, item 10 — expo-keep-awake. Native-only, so the node
// suite needs a stand-in for CookSessionView to keep importing.
//
// ⚠️ useKeepAwake IS A NO-OP HERE, not a throw — unlike the expo-notifications
// stub beside it. The difference is deliberate: a notification reaching the live
// module would mean the injected seam was bypassed and the test is lying, whereas
// a wake lock has no seam and nothing observable under node. There is nothing for
// a test to assert, which is exactly why item 10 is reported as device-verified
// only rather than as covered.
export const ExpoKeepAwakeStub = `
export function useKeepAwake() {}
export async function activateKeepAwakeAsync() {}
export async function deactivateKeepAwake() {}
export async function isAvailableAsync() { return false; }
export const ExpoKeepAwakeTag = "ExpoKeepAwakeDefaultTag";
`;

// Resub C2 — react-native-purchases (RevenueCat). The real module reaches a
// native module at import. lib/billing/store.ts takes its SDK by injection
// (__setStoreSdkForTests), so this default only has to exist; every method
// throws so a test that forgot to inject fails loudly instead of "buying".
export const RevenueCatStub = `
function notInjected(name) {
  return () => { throw new Error("stub: react-native-purchases." + name + " called without __setStoreSdkForTests"); };
}
const Purchases = {
  configure: notInjected("configure"),
  logIn: notInjected("logIn"),
  logOut: notInjected("logOut"),
  isAnonymous: notInjected("isAnonymous"),
  getAppUserID: notInjected("getAppUserID"),
  getOfferings: notInjected("getOfferings"),
  purchasePackage: notInjected("purchasePackage"),
  restorePurchases: notInjected("restorePurchases"),
};
export const PURCHASES_ERROR_CODE = { PURCHASE_CANCELLED_ERROR: "1", PAYMENT_PENDING_ERROR: "20" };
export default Purchases;
`;
