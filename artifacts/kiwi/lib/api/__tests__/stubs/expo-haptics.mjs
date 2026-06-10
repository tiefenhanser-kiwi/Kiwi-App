// WS7-6 C-fix Block 4 — physical expo-haptics stub for node:test. Loaded via
// the _loader.mjs resolve hook (specifier "expo-haptics" maps to this file).
// Needed so component tests can import the shared Button (which fires a
// selection haptic) without pulling expo-haptics' native .ts source — which
// --experimental-strip-types refuses to strip under node_modules.

export function selectionAsync() {
  return Promise.resolve();
}

export function impactAsync() {
  return Promise.resolve();
}

export function notificationAsync() {
  return Promise.resolve();
}

export const ImpactFeedbackStyle = { Light: "light", Medium: "medium", Heavy: "heavy" };
export const NotificationFeedbackType = {
  Success: "success",
  Warning: "warning",
  Error: "error",
};
