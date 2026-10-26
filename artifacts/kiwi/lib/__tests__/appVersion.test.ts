// Resubmission C2 §8 — the store version was 1.1.0; 1.2-NATIVE G moves it to
// 1.2.0 (the binary with Sentry, the store review prompt, expo-web-browser and
// the Firebase file). 1.1.0 updates now ship from release/1.1.
//
// D-WS9-279: the marketing version moves BEFORE any `eas update` is ever run,
// because `runtimeVersion.policy` is "appVersion" — an update published against
// 1.0.0 would target the binary Apple rejected. Build numbers are NOT set here:
// eas.json's `appVersionSource: "remote"` auto-increments them, and a number
// written into app.json would be ignored at best and contradict the remote
// counter at worst.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const KIWI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const appJson = JSON.parse(readFileSync(path.join(KIWI, "app.json"), "utf8")) as {
  expo: {
    version: string;
    runtimeVersion?: { policy?: string };
    ios?: { buildNumber?: string };
    android?: { versionCode?: number };
  };
};
const easJson = JSON.parse(readFileSync(path.join(KIWI, "eas.json"), "utf8")) as {
  cli: { appVersionSource?: string };
  build: { production: { autoIncrement?: boolean } };
};

test("🔴 the app version is 1.2.0", () => {
  assert.equal(appJson.expo.version, "1.2.0");
});

test("updates are keyed to the app version, so 1.2.0 is its own runtime", () => {
  assert.equal(appJson.expo.runtimeVersion?.policy, "appVersion");
});

test("build numbers stay remote and auto-incremented — none in app.json", () => {
  assert.equal(appJson.expo.ios?.buildNumber, undefined);
  assert.equal(appJson.expo.android?.versionCode, undefined);
  assert.equal(easJson.cli.appVersionSource, "remote");
  assert.equal(easJson.build.production.autoIncrement, true);
});

// BUG-525 (1.2-NATIVE A) — the native half. A fresh install waits up to 5 s on
// the splash for the current update instead of running the binary's own
// bundle; the wait applies to every cold start, and only costs time when the
// check is slow or an update is downloading. checkAutomatically stays at its
// default (ON_LOAD): the launch check is what the wait waits for.
test("a cold start waits up to 5000 ms for the current update; the launch check stays on", () => {
  const updates = (appJson.expo as { updates?: { fallbackToCacheTimeout?: number; checkAutomatically?: string } }).updates;
  assert.equal(updates?.fallbackToCacheTimeout, 5000);
  assert.equal(updates?.checkAutomatically, undefined);
});
