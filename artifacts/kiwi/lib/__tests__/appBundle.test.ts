// BUG-445 — Profile's footer says which bundle is running.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { bundleLine } from "../appBundle.ts";

const base = { platform: "android", version: "1.1.0", runtimeVersion: "1.1.0" };

test("an OTA update: version, runtime and the update id's first 8 characters", () => {
  assert.equal(
    bundleLine({ ...base, updateId: "0193b2c4-7e1f-7a2b-9c3d-4e5f6a7b8c9d", isEmbeddedLaunch: false }),
    "Version 1.1.0 · runtime 1.1.0 · update 0193b2c4",
  );
});

test("the binary's own bundle reads 'built-in' (BUG-441's case)", () => {
  assert.equal(
    bundleLine({ ...base, updateId: "0193b2c4-7e1f-7a2b-9c3d-4e5f6a7b8c9d", isEmbeddedLaunch: true }),
    "Version 1.1.0 · runtime 1.1.0 · built-in",
  );
  assert.equal(bundleLine({ ...base, updateId: null, isEmbeddedLaunch: false }), "Version 1.1.0 · runtime 1.1.0 · built-in");
});

test("the web export has no OTA: version and 'web'", () => {
  assert.equal(bundleLine({ ...base, platform: "web", updateId: null, isEmbeddedLaunch: false }), "Version 1.1.0 · web");
});

test("missing facts say so rather than vanish", () => {
  assert.equal(
    bundleLine({ platform: "ios", version: undefined, runtimeVersion: null, updateId: null, isEmbeddedLaunch: true }),
    "Version unknown · runtime unknown · built-in",
  );
});

// SEC-3 E — the read moved to lib/runningBundle.ts, shared by Profile's footer
// and "Send feedback", so both say the same line.
test("Profile renders it, from expo-updates and expo-constants (app/** is outside the glob)", () => {
  const read = readFileSync(new URL("../runningBundle.ts", import.meta.url), "utf8");
  assert.match(read, /import \* as Updates from "expo-updates";/);
  assert.match(read, /bundleLine\(\{/);
  assert.match(read, /isEmbeddedLaunch: Updates\.isEmbeddedLaunch/);
  assert.match(read, /updateId: Updates\.updateId/);
  const profile = readFileSync(new URL("../../app/(tabs)/profile.tsx", import.meta.url), "utf8");
  assert.match(profile, /import \{ BUNDLE_LINE \} from "@\/lib\/runningBundle";/);
  assert.match(profile, /testID="profile-bundle-line"/);
  const feedback = readFileSync(new URL("../../app/feedback.tsx", import.meta.url), "utf8");
  assert.match(feedback, /withDeviceLines\(message\.trim\(\), BUNDLE_LINE, OS_LINE\)/);
});
