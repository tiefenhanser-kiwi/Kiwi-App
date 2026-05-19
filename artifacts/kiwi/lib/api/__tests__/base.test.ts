import assert from "node:assert/strict";
import { test } from "node:test";

// `apiBase` resolves at module load from process.env. To exercise each
// precedence branch, we re-import the module via a fresh URL query for
// each test (process.env mutation alone doesn't re-run the top-level).

async function freshImport(env: Record<string, string | undefined>) {
  // Snapshot + mutate process.env around the import.
  const snapshot: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    snapshot[k] = process.env[k];
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    // Cache-busting query so each test gets a fresh module evaluation.
    const mod = (await import(`../base?${Date.now()}-${Math.random()}`)) as {
      apiBase: string;
    };
    return mod.apiBase;
  } finally {
    for (const [k, v] of Object.entries(snapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("apiBase: EXPO_PUBLIC_API_BASE_URL wins when set", async () => {
  const base = await freshImport({
    EXPO_PUBLIC_API_BASE_URL: "https://api.example.com/api",
    EXPO_PUBLIC_DOMAIN: "ignored.replit.dev",
  });
  assert.equal(base, "https://api.example.com/api");
});

test("apiBase: falls through to EXPO_PUBLIC_DOMAIN-derived URL", async () => {
  const base = await freshImport({
    EXPO_PUBLIC_API_BASE_URL: undefined,
    EXPO_PUBLIC_DOMAIN: "kiwi-app.replit.dev",
  });
  assert.equal(base, "https://kiwi-app.replit.dev/api");
});

test("apiBase: falls through to localhost when neither set", async () => {
  const base = await freshImport({
    EXPO_PUBLIC_API_BASE_URL: undefined,
    EXPO_PUBLIC_DOMAIN: undefined,
  });
  assert.equal(base, "http://localhost:3000/api");
});

test("apiBase: empty EXPO_PUBLIC_API_BASE_URL falls through to DOMAIN (|| semantics)", async () => {
  // This is the historical lib/auth.ts footgun fix — `||` not `??`, so an
  // explicitly-empty env value falls through instead of short-circuiting to "".
  const base = await freshImport({
    EXPO_PUBLIC_API_BASE_URL: "",
    EXPO_PUBLIC_DOMAIN: "kiwi-app.replit.dev",
  });
  assert.equal(base, "https://kiwi-app.replit.dev/api");
});
