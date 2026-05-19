// Virtual replacements for Expo native modules so the pure-TS modules
// can be tested under plain Node. Loaded by _loader.mjs.

export const SecureStoreStub = `
let __store = new Map();
export function __resetForTests() { __store.clear(); }
export function __setForTests(k, v) { __store.set(k, v); }
export async function getItemAsync(key) { return __store.get(key) ?? null; }
export async function setItemAsync(key, value) { __store.set(key, value); }
export async function deleteItemAsync(key) { __store.delete(key); }
`;

export const ImageManipulatorStub = `
export const SaveFormat = { JPEG: "jpeg" };
export async function manipulateAsync() {
  return { width: 100, height: 100, base64: "stub" };
}
`;
