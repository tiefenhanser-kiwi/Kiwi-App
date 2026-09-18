// Row 5 · Block 1c-fix — revision kiwi-api-00010-fs2 failed its startup
// probe with `Cannot find package '@google-cloud/storage' imported from
// /app/dist/index.mjs`. build.mjs listed "@google-cloud/*" as external,
// live.ts imports @google-cloud/storage, esbuild (bundle, no splitting)
// inlined live.ts and hoisted that import to the top of the bundle, and the
// repo-root Dockerfile's runtime tree carries @prisma/client and nothing
// else. `pnpm build` was green throughout: nothing tied "what the bundle
// leaves external" to "what the container carries".
//
// This test ties them, in the suite, where a change to EITHER side turns it
// red before a deploy:
//
//   1. RUNTIME_PACKAGES (bundleExternals.mjs) must equal the set of packages
//      the Dockerfile's runtime-assembly step copies into
//      /runtime/node_modules — parsed from the Dockerfile itself, so editing
//      the copies without the list (or vice versa) fails here.
//   2. The bundle, built with build.mjs's own config into a temp dir, must
//      leave no bare import outside RUNTIME_PACKAGES — so re-externalising a
//      package the code imports fails here (§27.4 break: put "@google-cloud/*"
//      back in build.mjs's `external`).
//   3. The checker can express the failure (§27.5): a synthetic bundle with
//      the exact import that killed 00010-fs2 is reported missing.
//
// The Dockerfile sits OUTSIDE artifacts/api-server — this test reads it by
// path from the repo root, which is the point: the package's deployability is
// controlled from there, and the package's own suite now looks.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RUNTIME_PACKAGES, bareImportsOf, checkBundle, isBarePackageSpecifier, packageOf } from "../../../bundleExternals.mjs";
import { buildBundle } from "../../../build.mjs";

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPO_ROOT = join(API_DIR, "..", "..");
const DOCKERFILE = join(REPO_ROOT, "Dockerfile");

// The packages the Dockerfile copies into the runtime tree: destination
// paths of `cp` lines under /runtime/node_modules/. A leading-dot entry
// (.prisma/client — the generated client, reached by @prisma/client's own
// relative require) is not a bare package and is excluded; scope dirs made by
// `mkdir -p` are not `cp` destinations and never match.
function dockerfileRuntimePackages(dockerfile: string): string[] {
  const out = new Set<string>();
  for (const line of dockerfile.split("\n")) {
    if (!/\bcp\s+/.test(line)) continue;
    const m = line.match(/\/runtime\/node_modules\/([^\s"'\\]+)/);
    if (m && !m[1].startsWith(".")) out.add(m[1]);
  }
  return [...out].sort();
}

describe("bundle externals — the Dockerfile carries what the bundle leaves external", () => {
  it("the repo-root Dockerfile exists and has the runtime-assembly step", () => {
    assert.ok(existsSync(DOCKERFILE), `no Dockerfile at ${DOCKERFILE}`);
    const src = readFileSync(DOCKERFILE, "utf8");
    assert.match(src, /\/runtime\/node_modules\//, "Dockerfile no longer assembles /runtime/node_modules — rewrite this test");
    assert.match(src, /bundleExternals\.mjs .*--resolve-from \/runtime/, "Dockerfile no longer runs the resolve-from check against /runtime");
  });

  it("RUNTIME_PACKAGES equals the packages the Dockerfile copies into /runtime/node_modules", () => {
    const fromDockerfile = dockerfileRuntimePackages(readFileSync(DOCKERFILE, "utf8"));
    assert.ok(fromDockerfile.length > 0, "parsed no cp targets from the Dockerfile — the pattern drifted");
    assert.deepEqual(
      [...RUNTIME_PACKAGES].sort(),
      fromDockerfile,
      "RUNTIME_PACKAGES (bundleExternals.mjs) and the Dockerfile's runtime copies disagree — change both or neither",
    );
  });

  describe("the built bundle", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kiwi-bundle-"));
    after(() => rmSync(tmp, { recursive: true, force: true }));

    it("leaves no bare import the runtime tree does not carry", async () => {
      const bundlePath = await buildBundle(tmp); // throws (red) on a miss — the same check `pnpm build` runs
      const { imports, missing } = checkBundle(bundlePath);
      assert.deepEqual(missing, [], `not carried by the Dockerfile runtime tree: ${missing.map((m) => m.specifier).join(", ")}`);
      // The bundle does import something external — an empty list would mean the scan found nothing, not that all is well.
      assert.ok(imports.some((i) => i.package === "@prisma/client"), "expected @prisma/client among the bundle's bare imports");
      // The package that killed 00010-fs2 is bundled now, not imported.
      assert.ok(!imports.some((i) => i.package === "@google-cloud/storage"), "@google-cloud/storage is external again — the container will not boot");
    });

    it("§27.5 — the checker reports the exact import that killed 00010-fs2", () => {
      const fake = join(tmp, "fake-bundle.mjs");
      writeFileSync(
        fake,
        [
          `import { PrismaClient } from "@prisma/client";`,
          `import { Storage } from "@google-cloud/storage";`,
          `import { createHash } from "node:crypto";`,
          `import fs from "fs";`,
          `const lazy = () => import("sharp");`,
          `console.log(PrismaClient, Storage, createHash, fs, lazy);`,
        ].join("\n"),
      );
      const { imports, missing } = checkBundle(fake);
      assert.deepEqual(
        imports.map((i) => `${i.kind}:${i.specifier}`),
        ["static:@google-cloud/storage", "static:@prisma/client", "dynamic:sharp"],
      );
      assert.deepEqual(
        missing.map((i) => `${i.kind}:${i.specifier}`),
        ["static:@google-cloud/storage", "dynamic:sharp"],
      );
      // --resolve-from against a tree that has nothing: everything bare is missing, builtins still are not.
      const { missing: unresolved } = checkBundle(fake, { resolveFrom: tmp });
      assert.deepEqual(unresolved.map((i) => i.specifier).sort(), ["@google-cloud/storage", "@prisma/client", "sharp"]);
    });
  });

  describe("specifier classification", () => {
    it("builtins (both spellings), relative, absolute and URL specifiers are not bare packages", () => {
      for (const s of ["fs", "node:fs", "node:stream/web", "crypto", "./x", "../y.mjs", "/abs", "C:\\abs", "file:///x", "data:text/javascript,1"]) {
        assert.equal(isBarePackageSpecifier(s), false, s);
      }
      for (const s of ["@prisma/client", "@google-cloud/storage", "sharp", "express/lib/router"]) {
        assert.equal(isBarePackageSpecifier(s), true, s);
      }
    });

    it("packageOf reduces subpaths to the package", () => {
      assert.equal(packageOf("@google-cloud/storage/build/esm/src/index.js"), "@google-cloud/storage");
      assert.equal(packageOf("express/lib/router"), "express");
      assert.equal(packageOf("sharp"), "sharp");
    });

    it("bareImportsOf reads every static import form esbuild emits, and ignores indented (non-hoisted) lines", () => {
      const src = [
        `import a from "pkg-default";`,
        `import { b } from 'pkg-named';`,
        `import * as c from "pkg-ns";`,
        `import "pkg-side-effect";`,
        `import { d as e, f } from "@scope/pkg/sub";`,
        `  import x from "indented-is-not-top-level";`,
        `import { g } from "./relative";`,
        `import { h } from "node:path";`,
      ].join("\n");
      assert.deepEqual(
        bareImportsOf(src).map((i) => i.package),
        ["@scope/pkg", "pkg-default", "pkg-named", "pkg-ns", "pkg-side-effect"],
      );
    });
  });
});
