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
