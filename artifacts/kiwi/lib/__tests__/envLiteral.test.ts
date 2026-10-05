// BUG-357 — EVERY `process.env` READ THE APP SHIPS IS A LITERAL MEMBER
// EXPRESSION, and this is the list of what those reads are.
//
// babel-preset-expo inlines an EXPO_PUBLIC_ variable only where the source
// spells out `process.env.EXPO_PUBLIC_NAME`
// (node_modules/babel-preset-expo/build/inline-env-vars.js). Anything else — an
// alias (`env = process.env`), a bracket (`process.env[key]`), a destructure —
// survives the build as a runtime read of a `process.env` that holds no
// EXPO_PUBLIC_ values, and the feature behind it is silently off in every build.
// Resub C1 found that in lib/guest/turnstile.ts; C2 found it in
// lib/oauth/providers.ts (no Google button in any build). This walks every file
// Metro can bundle so the third one fails here instead of in a store build.
//
// The second test pins the full list of names, which is the list Hans sets as
// EAS environment variables. A new name is a deliberate edit to this file.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const KIWI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// What Metro bundles: the route tree and everything it imports. scripts/ and
// e2e/ run under Node, where process.env is the real environment.
const ROOTS = ["app", "components", "constants", "contexts", "hooks", "lib"];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Comments may quote the bad shape on purpose; only code counts. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const FILES = ROOTS.flatMap((r) => sources(path.join(KIWI, r)));

test("🔴 no process.env read in bundled code is anything but process.env.NAME", () => {
  assert.ok(FILES.length > 100, `walked ${FILES.length} files — the walk is broken`);
  const bad: string[] = [];
  for (const f of FILES) {
    const code = stripComments(readFileSync(f, "utf8"));
    const re = /process\.env(?!\.[A-Za-z_][A-Za-z0-9_]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const line = code.slice(0, m.index).split("\n").length;
      bad.push(`${path.relative(KIWI, f)}:${line}`);
    }
  }
  assert.deepEqual(bad, [], "aliased / bracketed / destructured process.env reads");
});

test("the EXPO_PUBLIC_ names the app reads — the EAS environment list", () => {
  const names = new Set<string>();
  for (const f of FILES) {
    const code = stripComments(readFileSync(f, "utf8"));
    for (const m of code.matchAll(/process\.env\.(EXPO_PUBLIC_[A-Z0-9_]+)/g)) names.add(m[1]);
  }
  assert.deepEqual([...names].sort(), [
    "EXPO_PUBLIC_API_BASE_URL",
    "EXPO_PUBLIC_APPLE_SERVICES_ID",
    "EXPO_PUBLIC_APPLE_WEB_REDIRECT_URI",
    "EXPO_PUBLIC_DOMAIN",
    "EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID",
    "EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID",
    "EXPO_PUBLIC_REVENUECAT_ANDROID_KEY",
    "EXPO_PUBLIC_REVENUECAT_IOS_KEY",
    "EXPO_PUBLIC_TURNSTILE_SITE_KEY",
  ]);
});
