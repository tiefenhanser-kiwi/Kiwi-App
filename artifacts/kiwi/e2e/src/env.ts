// ─────────────────────────────────────────────────────────────────────────────
// Paths, origins, and the two fences every entry point re-asserts.
//
// Nothing here reads a secret. The test account's email and password live ONLY
// in C:\Cooking App\kiwi-local-tools\browser-test-account.local.txt and are
// read at runtime by creds.ts — never copied into this folder, never printed,
// never written to out/.
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ⚠️ `__dirname`, NOT `import.meta.url`. Playwright transpiles this folder to
// CommonJS — artifacts/kiwi/package.json has no `"type": "module"`, and adding
// one to make `import.meta` legal here would change module resolution for the
// whole Expo app. So the anchor is the CJS one, declared because the tsconfig
// targets ESNext modules.
declare const __dirname: string;

const HERE = __dirname;

/** artifacts/kiwi/e2e */
export const E2E_ROOT = resolve(HERE, "..");
/** artifacts/kiwi */
export const KIWI_ROOT = resolve(E2E_ROOT, "..");
/** the repo root */
export const REPO_ROOT = resolve(KIWI_ROOT, "..", "..");
/** artifacts/api-server — the census harnesses and the dev .env live here */
export const API_SERVER_ROOT = join(REPO_ROOT, "artifacts", "api-server");

export const GROCERY_CENSUS_DIR = join(API_SERVER_ROOT, "scripts", "grocery-census");
export const PREP_COOK_CENSUS_DIR = join(API_SERVER_ROOT, "scripts", "prep-cook-census");

/** The dev-only test account. Read at runtime, from outside the repo. */
export const CREDS_PATH =
  process.env.KIWI_E2E_CREDS ??
  "C:\\Cooking App\\kiwi-local-tools\\browser-test-account.local.txt";

/** serve-proxy.cjs — started as a child only when :9000 is free. */
export const SERVE_PROXY_PATH =
  process.env.KIWI_E2E_SERVE_PROXY ??
  "C:\\Cooking App\\kiwi-local-tools\\serve-proxy.cjs";

export const WEB_ORIGIN = process.env.KIWI_E2E_WEB_ORIGIN ?? "http://localhost:9000";
export const API_BASE = `${WEB_ORIGIN}/api`;
/** The api-server the proxy forwards to. Probed, never started. */
export const API_SERVER_ORIGIN = process.env.KIWI_E2E_API_ORIGIN ?? "http://localhost:3000";

/** One folder per invocation: out/<run>/ */
export const RUN_ID =
  process.env.KIWI_E2E_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
export const OUT_ROOT = join(E2E_ROOT, "out");
export const RUN_DIR = join(OUT_ROOT, RUN_ID);

export function ensureRunDir(): string {
  mkdirSync(RUN_DIR, { recursive: true });
  return RUN_DIR;
}

// ── fence 1: the dev database, and nothing else ─────────────────────────────
//
// The harness itself never opens a DB connection for the flow — it drives the
// browser and the HTTP API. But it DOES shell out to the census checkers, which
// do connect, and it resolves ingredient canonical names for the bridge. So it
// asserts the same host check those harnesses assert, up front, from the same
// artifacts/api-server/.env, and reports PASS/FAIL without ever printing the URL.
export function assertDevDatabase(): { ok: boolean; note: string } {
  const envPath = join(API_SERVER_ROOT, ".env");
  if (!existsSync(envPath)) {
    return { ok: false, note: `FAIL — no ${envPath}` };
  }
  const line = readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((l) => /^\s*DATABASE_URL\s*=/.test(l));
  if (!line) return { ok: false, note: "FAIL — no DATABASE_URL in artifacts/api-server/.env" };
  const raw = line.replace(/^\s*DATABASE_URL\s*=\s*/, "").replace(/^["']|["']$/g, "");
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return { ok: false, note: "FAIL — DATABASE_URL is not a URL" };
  }
  // ⛔ The host is TESTED, never printed. A pasted connection string in a
  // transcript is the one way this folder could leak a production credential.
  return host.includes("ep-broad-haze")
    ? { ok: true, note: "PASS — DATABASE_URL host contains ep-broad-haze (dev branch)" }
    : { ok: false, note: "FAIL — DATABASE_URL host is NOT the dev branch" };
}

/** The dev .env, parsed, for the child processes that need DATABASE_URL. */
export function apiServerEnv(): Record<string, string> {
  const envPath = join(API_SERVER_ROOT, ".env");
  const out: Record<string, string> = {};
  for (const l of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(l);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
