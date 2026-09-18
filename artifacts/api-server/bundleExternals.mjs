// Row 5 · Block 1c-fix — the guard for the class of failure that took down
// revision kiwi-api-00010-fs2: build.mjs externalised a package the code
// imports (@google-cloud/storage), esbuild hoisted the import to the top of
// dist/index.mjs, and the repo-root Dockerfile's runtime tree — which carries
// @prisma/client and nothing else — could not resolve it. `pnpm build` was
// green; the container died at boot with ERR_MODULE_NOT_FOUND.
//
// The property asserted: EVERY bare specifier that survives into the bundle
// (a top-level `import … from "pkg"` or a literal `import("pkg")`) is a
// package the Dockerfile copies into /runtime/node_modules. Node builtins
// (with or without the `node:` prefix) are not packages and are skipped.
//
// Three consumers, same code:
//   • build.mjs — runs checkBundle() after every build and exits 1 on a
//     miss, so `pnpm build` (locally and inside `docker build`) is red.
//   • the Dockerfile — runs the CLI with --resolve-from /runtime against the
//     tree it just assembled, so the check is against the real layout.
//   • src/lib/__tests__/bundleExternals.test.ts — parses the Dockerfile and
//     fails if RUNTIME_PACKAGES below drifts from what it copies, then builds
//     the bundle into a temp dir and runs the same check in the suite.
//
// This file lives BESIDE build.mjs, not under scripts/: .dockerignore keeps
// scripts/ out of the build context and the Dockerfile has to run it.

import { builtinModules, createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The packages the repo-root Dockerfile copies into /runtime/node_modules.
 * Keep in lockstep with the `cp -r … /runtime/node_modules/<pkg>` lines
 * there — bundleExternals.test.ts diffs the two and fails on drift.
 */
export const RUNTIME_PACKAGES = ["@prisma/client"];

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** "@scope/name/sub/path" → "@scope/name"; "name/sub" → "name". */
export function packageOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** A bare specifier is not relative, not absolute, not a URL, not a builtin. */
export function isBarePackageSpecifier(specifier) {
  if (BUILTINS.has(specifier)) return false;
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(specifier)) return false;
  if (/^[a-z]+:/.test(specifier)) return false; // file:, data:, node: (already excluded), …
  return true;
}

// esbuild writes every hoisted external import at column 0 of the bundle,
// as `import X from "p";`, `import { a } from "p";`, `import * as X from "p";`
// or a bare `import "p";`. A literal dynamic `import("p")` of an external is
// left in place, so it is caught too (the (c)-route hazard: laziness hides a
// missing package until the code path runs). Bundled-CJS `__require("p")`
// calls are NOT scanned: the only non-builtin one in the bundle is
// node-fetch's optional, try-wrapped `encoding`, and a false red there would
// teach people to ignore the guard.
const STATIC_IMPORT = /^import\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']\s*;?\s*$/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Every bare package specifier the bundle source imports, with how.
 * @returns {{ specifier: string, package: string, kind: "static" | "dynamic" }[]} sorted, unique per (specifier, kind)
 */
export function bareImportsOf(source) {
  const seen = new Map();
  const add = (specifier, kind) => {
    if (!isBarePackageSpecifier(specifier)) return;
    const key = `${kind}\0${specifier}`;
    if (!seen.has(key)) seen.set(key, { specifier, package: packageOf(specifier), kind });
  };
  for (const m of source.matchAll(STATIC_IMPORT)) add(m[1], "static");
  for (const m of source.matchAll(DYNAMIC_IMPORT)) add(m[1], "dynamic");
  return [...seen.values()].sort((a, b) => a.specifier.localeCompare(b.specifier) || a.kind.localeCompare(b.kind));
}

/**
 * Check a built bundle. With `resolveFrom`, each specifier must resolve from
 * that directory (the assembled runtime tree); without it, each specifier's
 * package must be in RUNTIME_PACKAGES.
 * @returns {{ imports: ReturnType<typeof bareImportsOf>, missing: ReturnType<typeof bareImportsOf> }}
 */
export function checkBundle(bundlePath, { resolveFrom, runtimePackages = RUNTIME_PACKAGES } = {}) {
  const imports = bareImportsOf(readFileSync(bundlePath, "utf8"));
  let missing;
  if (resolveFrom) {
    const req = createRequire(pathToFileURL(path.join(path.resolve(resolveFrom), "package.json")));
    missing = imports.filter((i) => {
      try {
        req.resolve(i.specifier);
        return false;
      } catch {
        return true;
      }
    });
  } else {
    const allowed = new Set(runtimePackages);
    missing = imports.filter((i) => !allowed.has(i.package));
  }
  return { imports, missing };
}

export function formatMissing(bundlePath, missing, resolveFrom) {
  const where = resolveFrom ? `resolvable from ${path.resolve(resolveFrom)}` : "carried by the Dockerfile runtime tree";
  const lines = missing.map((i) => `  - ${i.specifier} (${i.kind} import)`);
  return [
    `bundle externals: ${missing.length} import(s) in ${bundlePath} not ${where}:`,
    ...lines,
    "  Either bundle the package (narrow the `external` list in build.mjs) or carry it:",
    "  add it to the runtime-tree copies in the repo-root Dockerfile AND to RUNTIME_PACKAGES",
    "  in bundleExternals.mjs. A container that boots without it dies with ERR_MODULE_NOT_FOUND.",
  ].join("\n");
}

// CLI: node bundleExternals.mjs <bundle.mjs> [--resolve-from <dir>]
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const rf = args.indexOf("--resolve-from");
  const resolveFrom = rf >= 0 ? args[rf + 1] : undefined;
  const bundlePath = args.find((a, i) => !a.startsWith("--") && (rf < 0 || i !== rf + 1));
  if (!bundlePath) {
    console.error("usage: node bundleExternals.mjs <bundle.mjs> [--resolve-from <dir>]");
    process.exit(2);
  }
  const { imports, missing } = checkBundle(bundlePath, { resolveFrom });
  if (missing.length > 0) {
    console.error(formatMissing(bundlePath, missing, resolveFrom));
    process.exit(1);
  }
  const list = imports.map((i) => i.specifier).join(", ") || "(none)";
  console.log(`bundle externals: ok — ${imports.length} bare import(s) [${list}] ${resolveFrom ? `resolve from ${path.resolve(resolveFrom)}` : "all carried by the Dockerfile runtime tree"}`);
}
