// WEB-1 Part A — the guard that stops the class coming back.
//
// react-native-web's Alert is an empty stub: `Alert.alert(...)` on the web
// shows nothing and runs no button's onPress. Every dialog goes through
// lib/dialog.ts (Alert on native, DialogHost on web). Any `Alert.alert(` or
// `Alert.prompt(` in app/, components/, lib/ or hooks/ outside lib/dialog.ts
// is a dialog the web will silently swallow — this test fails on it.
//
// __tests__ directories are skipped: tests may name the stub they drive.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(name)) out.push(p);
  }
  return out;
}

test("no Alert.alert( / Alert.prompt( outside lib/dialog.ts", () => {
  const allowed = resolve(root, "lib/dialog.ts");
  const hits: string[] = [];
  for (const d of ["app", "components", "lib", "hooks"]) {
    for (const p of walk(resolve(root, d))) {
      if (p === allowed) continue;
      readFileSync(p, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/Alert\.(alert|prompt)\(/.test(line)) {
            hits.push(`${relative(root, p).replace(/\\/g, "/")}:${i + 1}`);
          }
        });
    }
  }
  assert.deepEqual(hits, [], `use dialog.alert from @/lib/dialog instead:\n${hits.join("\n")}`);
});

test("the guard can see: lib/dialog.ts itself still holds the one native pass-through", () => {
  // A walk that silently found nothing would pass the test above vacuously.
  const src = readFileSync(resolve(root, "lib/dialog.ts"), "utf8");
  assert.match(src, /Alert\.alert\(title, message, buttons, options\)/);
  const files = ["app", "components", "lib", "hooks"].flatMap((d) => walk(resolve(root, d)));
  assert.ok(files.length > 100, `walked only ${files.length} files`);
  assert.ok(
    files.some((p) => readFileSync(p, "utf8").includes("dialog.alert(")),
    "no dialog.alert( call found anywhere — the walk is not reading the tree",
  );
});
