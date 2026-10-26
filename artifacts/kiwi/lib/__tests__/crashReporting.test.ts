// 1.2-NATIVE B — crash reporting: when it is on, and what an event may carry.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  CRASH_MESSAGE_MAX,
  crashReportingEnabled,
  crashUserIdInput,
  scrubBreadcrumb,
  scrubEvent,
  scrubText,
  scrubUrl,
} from "../crashReporting.ts";

const KIWI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(path.join(KIWI, rel), "utf8");

const on = { platform: "ios", dsn: "https://fake0001@o1.ingest.sentry.io/1", isDev: false, hasNative: true };

test("on only with a DSN, a native module, a release build, off web", () => {
  assert.equal(crashReportingEnabled(on), true);
  assert.equal(crashReportingEnabled({ ...on, platform: "android" }), true);
  assert.equal(crashReportingEnabled({ ...on, dsn: undefined }), false, "no DSN: the code lands before the account");
  assert.equal(crashReportingEnabled({ ...on, dsn: "  " }), false);
  assert.equal(crashReportingEnabled({ ...on, hasNative: false }), false, "a 1.1 binary with a 1.2 bundle");
  assert.equal(crashReportingEnabled({ ...on, isDev: true }), false);
  assert.equal(crashReportingEnabled({ ...on, platform: "web" }), false);
});

test("URLs lose their query and fragment: a reset token never leaves the phone", () => {
  assert.equal(scrubUrl("https://app.kitchenwizard.ai/reset-password?token=fake-token-0001"), "https://app.kitchenwizard.ai/reset-password");
  assert.equal(scrubUrl("kiwi://reset-password?token=fake-token-0001#x"), "kiwi://reset-password");
  assert.equal(scrubUrl("https://api.example/plans/abc#frag"), "https://api.example/plans/abc");
  assert.equal(scrubUrl("/plan/abc"), "/plan/abc");
});

test("free text: URLs scrubbed, emails masked, capped", () => {
  assert.equal(
    scrubText("GET https://kiwi-api.example/api/auth/reset?token=fake-0001 failed for jo.cook@example.com"),
    "GET https://kiwi-api.example/api/auth/reset failed for [email]",
  );
  const long = scrubText("x".repeat(CRASH_MESSAGE_MAX + 50));
  assert.equal(long.length, CRASH_MESSAGE_MAX + 1);
  assert.ok(long.endsWith("…"));
});

test("breadcrumbs: console, touch and ui are dropped; kept ones carry only scrubbed URLs and status", () => {
  assert.equal(scrubBreadcrumb({ category: "console", message: "server said: Grandma's lasagna" }), null);
  assert.equal(scrubBreadcrumb({ category: "touch", message: "Pressable 'Grandma's lasagna'" }), null);
  assert.equal(scrubBreadcrumb({ category: "ui.click" }), null);
  assert.equal(scrubBreadcrumb({ message: "no category" }), null);
  assert.deepEqual(
    scrubBreadcrumb({
      category: "fetch",
      type: "http",
      data: { url: "https://kiwi-api.example/api/me?token=fake-0002", method: "POST", status_code: 500, request_body_size: 42 },
    }),
    { category: "fetch", type: "http", data: { url: "https://kiwi-api.example/api/me", method: "POST", status_code: 500 } },
  );
  assert.deepEqual(
    scrubBreadcrumb({ category: "navigation", data: { from: "/(auth)/reset-password?token=fake-0003", to: "/(tabs)" } }),
    { category: "navigation", data: { from: "/(auth)/reset-password", to: "/(tabs)" } },
  );
});

test("events: the request is a scrubbed URL, the user a hashed id, no extra, no device name", () => {
  const e = scrubEvent({
    message: "boom at https://app.kitchenwizard.ai/reset-password?token=fake-0004",
    exception: { values: [{ type: "Error", value: "bad reply for jo.cook@example.com" }] },
    request: { url: "https://x.example/a?b=c", query_string: "b=c", cookies: { s: "fake" }, headers: { Authorization: "fake" }, data: "{}" },
    breadcrumbs: [{ category: "console", message: "hi" }, { category: "app.lifecycle", message: "foreground" }],
    user: { id: "f".repeat(64), email: "jo.cook@example.com", ip_address: "203.0.113.9", username: "jo" },
    extra: { recipe: "Grandma's lasagna" },
    server_name: "Jo's iPhone",
    contexts: { device: { name: "Jo's iPhone", model: "iPhone15,2" }, os: { name: "iOS" } },
  });
  assert.equal(e.message, "boom at https://app.kitchenwizard.ai/reset-password");
  assert.equal(e.exception?.values?.[0].value, "bad reply for [email]");
  assert.equal(e.exception?.values?.[0].type, "Error");
  assert.deepEqual(e.request, { url: "https://x.example/a" });
  assert.deepEqual(e.breadcrumbs, [{ category: "app.lifecycle", message: "foreground" }]);
  assert.deepEqual(e.user, { id: "f".repeat(64) });
  assert.equal("extra" in e, false);
  assert.equal("server_name" in e, false);
  assert.deepEqual(e.contexts, { device: { model: "iPhone15,2" }, os: { name: "iOS" } });
});

test("the hashed id has a fixed prefix", () => {
  assert.equal(crashUserIdInput("cm0fakeuser0001"), "kiwi-user:cm0fakeuser0001");
});

// The live wiring (lib/sentry.ts, app/_layout.tsx) is outside the pure tests; pin its shape.
test("Sentry: off without the DSN or the native module; no screenshot, hierarchy or tracing; the scrubbers run", () => {
  const live = read("lib/sentry.ts");
  assert.match(live, /process\.env\.EXPO_PUBLIC_SENTRY_DSN/);
  assert.match(live, /hasNative: hasNativeModule\("sentry"\)/);
  for (const opt of ["sendDefaultPii: false", "attachScreenshot: false", "attachViewHierarchy: false", "enableAutoPerformanceTracing: false", "enableUserInteractionTracing: false", "enableCaptureFailedRequests: false"]) {
    assert.ok(live.includes(opt), opt);
  }
  assert.match(live, /beforeBreadcrumb: \(b\) => scrubBreadcrumb\(b\)/);
  assert.match(live, /beforeSend: \(e\) => scrubEvent\(e\)/);
  assert.match(live, /CryptoDigestAlgorithm\.SHA256, crashUserIdInput\(userId\)/);
  assert.doesNotMatch(read("lib/sentry.web.ts"), /from "@sentry/, "the web twin loads no SDK");
  const layout = read("app/_layout.tsx");
  assert.match(layout, /^initCrashReporting\(\);$/m);
  assert.match(layout, /<ErrorBoundary onError=\{reportBoundaryError\}>/);
  assert.doesNotMatch(layout, /Sentry\.wrap/, "no touch breadcrumbs: a label can be a recipe title");
});

test("the 1.2 binary: Sentry's plugin, metro debug ids, no upload until the token is set, crash data declared", () => {
  const app = JSON.parse(read("app.json")).expo;
  assert.ok(app.plugins.includes("@sentry/react-native"));
  assert.match(read("metro.config.js"), /getSentryExpoConfig\(__dirname\)/);
  const eas = JSON.parse(read("eas.json")).build;
  for (const p of ["development", "preview", "production"]) {
    assert.equal(eas[p].env.SENTRY_DISABLE_AUTO_UPLOAD, "true", p);
  }
  const types = app.ios.privacyManifests.NSPrivacyCollectedDataTypes;
  assert.deepEqual(types.map((t: { NSPrivacyCollectedDataType: string }) => t.NSPrivacyCollectedDataType), ["NSPrivacyCollectedDataTypeCrashData"]);
  assert.equal(types[0].NSPrivacyCollectedDataTypeLinked, true, "a hashed id is still linked");
  assert.equal(types[0].NSPrivacyCollectedDataTypeTracking, false);
});

test("1.2 native modules: none imported at top level outside lib/sentry.ts", () => {
  // expo-store-review / expo-web-browser throw at import on a binary without
  // them; they are reached by require() after hasNativeModule (lib/nativeModules.ts).
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(path.join(KIWI, dir), { withFileTypes: true })) {
      const rel = `${dir}/${name.name}`;
      if (name.isDirectory()) {
        if (!["node_modules", "dist", "__tests__", "e2e", "assets", "public", "server", "scripts"].includes(name.name)) walk(rel);
      } else if (/\.(ts|tsx)$/.test(name.name)) {
        const src = read(rel);
        if (/^import [^;]*from "expo-(store-review|web-browser)"/m.test(src)) offenders.push(rel);
        if (rel !== "./lib/sentry.ts" && /^import [^;]*from "@sentry\/react-native"/m.test(src)) offenders.push(rel);
      }
    }
  };
  walk(".");
  assert.deepEqual(offenders, []);
});
