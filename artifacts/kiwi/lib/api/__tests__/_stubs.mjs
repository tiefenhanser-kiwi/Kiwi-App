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
