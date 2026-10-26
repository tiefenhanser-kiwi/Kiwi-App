// 1.2-NATIVE E — the 1.2 binary is push-ready, and dormant.
//
// iOS: expo-notifications' plugin (mode "production") already writes the
// aps-environment entitlement — the 1.1 binary has it too. Android: remote push
// needs Firebase in the binary, i.e. google-services.json at prebuild. Nothing
// asks for a push permission or registers a token in 1.2: both ship later by
// update, with the server half (D-WS9-324's thaw reminder first).
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const KIWI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const app = JSON.parse(readFileSync(path.join(KIWI, "app.json"), "utf8")).expo;

test("Android points at google-services.json; iOS keeps the production push entitlement", () => {
  assert.equal(app.android.googleServicesFile, "./google-services.json");
  const notif = app.plugins.find((p: unknown) => Array.isArray(p) && p[0] === "expo-notifications");
  assert.deepEqual(notif?.[1], { mode: "production" });
});

// The file is Hans's to drop in (Firebase console). Until then this skips; once
// it is there, a Firebase app for another package would build a binary whose
// pushes never arrive.
test("google-services.json, when present, is the Firebase app for com.kitchenwizard.kiwi", (t) => {
  const file = path.join(KIWI, "google-services.json");
  if (!existsSync(file)) {
    t.skip("google-services.json not added yet — an EAS build fails at prebuild until it is");
    return;
  }
  const json = JSON.parse(readFileSync(file, "utf8")) as {
    client?: Array<{ client_info?: { android_client_info?: { package_name?: string } } }>;
  };
  const pkgs = (json.client ?? []).map((c) => c.client_info?.android_client_info?.package_name);
  assert.ok(pkgs.includes(app.android.package), `packages in the file: ${pkgs.join(", ")}`);
});

test("dormant: nothing gets or registers a push token", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(path.join(KIWI, dir))) {
      const rel = path.join(dir, name);
      if (statSync(path.join(KIWI, rel)).isDirectory()) {
        if (!["node_modules", "dist", "__tests__", "e2e", "assets", "public", "server", "scripts"].includes(name)) walk(rel);
      } else if (/\.(ts|tsx)$/.test(name)) {
        if (/getDevicePushTokenAsync|getExpoPushTokenAsync|addPushTokenListener/.test(readFileSync(path.join(KIWI, rel), "utf8"))) offenders.push(rel);
      }
    }
  };
  walk(".");
  assert.deepEqual(offenders, []);
});
