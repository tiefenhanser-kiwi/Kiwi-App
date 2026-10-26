// BUG-525 (1.2-NATIVE A) — the foreground update check and its quiet line.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  UPDATE_CHECK_MIN_GAP_MS,
  checkAndFetchUpdate,
  shouldCheckForUpdate,
  updateLineVisible,
  type UpdatesApi,
} from "../updatePrompt.ts";

const NOW = 1_800_000_000_000;
const base = { platform: "ios", isEnabled: true, isPending: false, lastCheckAt: null, now: NOW };

test("a first foreground checks", () => {
  assert.equal(shouldCheckForUpdate(base), true);
  assert.equal(shouldCheckForUpdate({ ...base, platform: "android" }), true);
});

test("a check inside the gap does not; one at the gap does", () => {
  assert.equal(shouldCheckForUpdate({ ...base, lastCheckAt: NOW - UPDATE_CHECK_MIN_GAP_MS + 1 }), false);
  assert.equal(shouldCheckForUpdate({ ...base, lastCheckAt: NOW - UPDATE_CHECK_MIN_GAP_MS }), true);
});

test("never on web, never in a dev build, never with an update already waiting", () => {
  assert.equal(shouldCheckForUpdate({ ...base, platform: "web" }), false);
  assert.equal(shouldCheckForUpdate({ ...base, isEnabled: false }), false);
  assert.equal(shouldCheckForUpdate({ ...base, isPending: true }), false);
});

function fakeApi(opts: { available?: boolean; isNew?: boolean; throwOn?: "check" | "fetch" }) {
  const calls: string[] = [];
  const api: UpdatesApi = {
    async checkForUpdateAsync() {
      calls.push("check");
      if (opts.throwOn === "check") throw new Error("offline");
      return { isAvailable: opts.available ?? false };
    },
    async fetchUpdateAsync() {
      calls.push("fetch");
      if (opts.throwOn === "fetch") throw new Error("timeout");
      return { isNew: opts.isNew ?? false };
    },
  };
  return { api, calls };
}

test("an available update is downloaded: check, then fetch", async () => {
  const f = fakeApi({ available: true, isNew: true });
  assert.equal(await checkAndFetchUpdate(f.api), "downloaded");
  assert.deepEqual(f.calls, ["check", "fetch"]);
});

test("nothing available: no download", async () => {
  const f = fakeApi({ available: false });
  assert.equal(await checkAndFetchUpdate(f.api), "none");
  assert.deepEqual(f.calls, ["check"]);
});

test("a fetch that brings nothing new is not 'downloaded'", async () => {
  assert.equal(await checkAndFetchUpdate(fakeApi({ available: true, isNew: false }).api), "none");
});

test("offline or a failed download never throws", async () => {
  assert.equal(await checkAndFetchUpdate(fakeApi({ throwOn: "check" }).api), "failed");
  assert.equal(await checkAndFetchUpdate(fakeApi({ available: true, throwOn: "fetch" }).api), "failed");
});

test("the line: only with an update waiting, never in Cook Mode or Prep the Week", () => {
  assert.equal(updateLineVisible(true, "(tabs)"), true);
  assert.equal(updateLineVisible(true, undefined), true);
  assert.equal(updateLineVisible(false, "(tabs)"), false);
  assert.equal(updateLineVisible(true, "cook-session"), false);
  assert.equal(updateLineVisible(true, "prep-cook"), false);
});

// app/** and components/** live wiring is outside the pure tests; pin the shape.
test("the live line reloads only on tap, from the root layout", () => {
  const line = readFileSync(new URL("../../components/UpdateReadyLine.tsx", import.meta.url), "utf8");
  assert.match(line, /onPress=\{\(\) => \{\s*void Updates\.reloadAsync\(\)/);
  assert.equal(line.match(/reloadAsync/g)?.length, 1);
  assert.match(line, /AppState\.addEventListener\("change"/);
  const layout = readFileSync(new URL("../../app/_layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /\{UPDATE_LINE_ENABLED && <UpdateReadyLine \/>\}/);
});
