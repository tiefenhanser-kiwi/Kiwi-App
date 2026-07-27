// Node loader hook — intercepts imports of Expo native-only modules and
// returns inline JS stubs. Lets the WS7-1 wrapper + AuthContext-adjacent
// modules be tested under plain Node without bundling react-native.
//
// Stubs are inline ESM source so the loader can return them via the
// `source` data URL trick — no separate stub files needed on disk
// beyond the strings in _stubs.mjs.

import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { transform as sucraseTransform } from "sucrase";

import {
  SecureStoreStub,
  ImageManipulatorStub,
  AsyncStorageStub,
  ExpoFetchStub,
} from "./_stubs.mjs";

// Inline-source stubs (don't import React; safe to ship as data-style modules
// via the load() hook).
const STUBS = new Map([
  ["expo-secure-store", SecureStoreStub],
  ["expo-image-manipulator", ImageManipulatorStub],
  ["@react-native-async-storage/async-storage", AsyncStorageStub],
  ["expo/fetch", ExpoFetchStub],
]);

// WS7-4-B c6 — physical stub files. These need real file URLs so the loader
// can resolve their own `import React from "react"` against the kiwi package
// scope. The data-URL "stub:" route used for the inline stubs above cannot
// satisfy that because there's no package.json scope for a stub: URL.
const PHYSICAL_STUBS = new Map([
  ["react-native", "./stubs/react-native.mjs"],
  ["@expo/vector-icons", "./stubs/expo-vector-icons.mjs"],
  ["react-native-safe-area-context", "./stubs/safe-area-context.mjs"],
  ["expo-router", "./stubs/expo-router.mjs"],
  ["expo-haptics", "./stubs/expo-haptics.mjs"],
]);

// kiwi/ root, used to resolve the `@/*` tsconfig path alias.
const KIWI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function splitQuery(s) {
  const i = s.indexOf("?");
  if (i === -1) return [s, ""];
  return [s.slice(0, i), s.slice(i)];
}

function hasJsTsExt(s) {
  return /\.[mc]?[jt]sx?$/.test(s);
}

export async function resolve(specifier, context, nextResolve) {
  if (STUBS.has(specifier)) {
    return {
      shortCircuit: true,
      url: `stub:${specifier}`,
      format: "module",
    };
  }
  if (PHYSICAL_STUBS.has(specifier)) {
    const relPath = PHYSICAL_STUBS.get(specifier);
    const abs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), relPath);
    return await nextResolve(pathToFileURL(abs).href, context);
  }
  // Handle tsconfig `@/*` path alias → kiwi/*.
  if (specifier.startsWith("@/")) {
    const [bare, query] = splitQuery(specifier.slice(2));
    const candidates = hasJsTsExt(bare)
      ? [bare]
      : [bare + ".ts", bare + ".tsx", bare];
    for (const c of candidates) {
      try {
        const abs = path.join(KIWI_ROOT, c);
        const url = pathToFileURL(abs).href + query;
        return await nextResolve(url, context);
      } catch {
        // try next candidate
      }
    }
  }
  // Node's ESM resolver requires explicit file extensions for relative
  // imports. tsx / metro both add `.ts` automatically — under native
  // `--experimental-strip-types` we recreate that behavior here so test
  // sources don't need to spell out `.ts` on every relative import.
  if (specifier.startsWith(".")) {
    const [bare, query] = splitQuery(specifier);
    if (!hasJsTsExt(bare)) {
      for (const ext of [".ts", ".tsx"]) {
        try {
          return await nextResolve(bare + ext + query, context);
        } catch {
          // try next
        }
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("stub:")) {
    const name = url.slice("stub:".length);
    const source = STUBS.get(name);
    if (source) {
      return { format: "module", shortCircuit: true, source };
    }
  }
  // WS7-4-B c6 — Node's --experimental-strip-types handles .ts but not .tsx
  // (no JSX transform). Pipe .tsx through sucrase so component tests can
  // import .tsx React components directly.
  if (url.startsWith("file://") && url.endsWith(".tsx")) {
    const filePath = fileURLToPath(url);
    const src = await readFile(filePath, "utf8");
    const out = sucraseTransform(src, {
      transforms: ["typescript", "jsx"],
      jsxRuntime: "classic",
      production: false,
      filePath,
    });
    return { format: "module", shortCircuit: true, source: out.code };
  }
  return nextLoad(url, context);
}
