// Node loader hook — intercepts imports of Expo native-only modules and
// returns inline JS stubs. Lets the WS7-1 wrapper + AuthContext-adjacent
// modules be tested under plain Node without bundling react-native.
//
// Stubs are inline ESM source so the loader can return them via the
// `source` data URL trick — no separate stub files needed on disk
// beyond the strings in _stubs.mjs.

import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { SecureStoreStub, ImageManipulatorStub } from "./_stubs.mjs";

const STUBS = new Map([
  ["expo-secure-store", SecureStoreStub],
  ["expo-image-manipulator", ImageManipulatorStub],
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
  return nextLoad(url, context);
}
