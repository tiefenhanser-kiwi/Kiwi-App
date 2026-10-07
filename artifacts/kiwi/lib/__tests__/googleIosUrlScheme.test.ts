// Resub C3 (D-WS9-269) — the Google iOS URL scheme, owed before the 1.1 iOS
// build. The Google Sign-In SDK on iOS returns from Google's sheet through this
// scheme (the reversed iOS client ID); without it the plugin registers none and
// the native sign-in cannot come back to the app. It was deliberately never
// placeholdered, so the literal value is pinned here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const KIWI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const appJson = JSON.parse(readFileSync(path.join(KIWI, "app.json"), "utf8")) as {
  expo: { plugins: Array<string | [string, Record<string, unknown>]> };
};

test("the google-signin plugin carries the iOS URL scheme", () => {
  const entry = appJson.expo.plugins.find((p) =>
    Array.isArray(p) ? p[0] === "@react-native-google-signin/google-signin" : p === "@react-native-google-signin/google-signin",
  );
  assert.ok(Array.isArray(entry), "configured with options, not a bare name");
  assert.equal(
    (entry as [string, Record<string, unknown>])[1].iosUrlScheme,
    "com.googleusercontent.apps.166146829159-vnkrpvlnpg7i69tgrcfp4jbbv115vfql",
  );
});
