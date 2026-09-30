// ─────────────────────────────────────────────────────────────────────────────
// PREFLIGHT — what must be true before a flow runs, checked and reported
// rather than assumed.
//
// 🔴 THE TWO THINGS THIS FILE WILL NOT DO:
//   • it never starts an api-server. :3000 is Hans's dev server (tsx watch);
//     a second one would fight it for the port and the dev DB. If :3000 is not
//     listening the harness STOPS and says so.
//   • it never stops anything. If :9000 is already serving, the harness
//     attaches to whatever is there and leaves it running at the end.
//
// It will start serve-proxy.cjs as a child ONLY when :9000 is free, and then it
// is the harness's own child and the harness kills it on the way out.
// ─────────────────────────────────────────────────────────────────────────────
import { type ChildProcess, spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  API_SERVER_ORIGIN,
  KIWI_ROOT,
  SERVE_PROXY_PATH,
  WEB_ORIGIN,
  assertDevDatabase,
} from "./env";
import { censusHarnessesPresent } from "./censusBridge";

function portOf(origin: string): number {
  const p = new URL(origin).port;
  return p ? Number(p) : 80;
}

export function isListening(port: number, host = "127.0.0.1", timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

export interface Preflight {
  ok: boolean;
  checks: { name: string; ok: boolean; note: string }[];
  /** Non-null only when THIS harness started it and must therefore stop it. */
  ownedProxy: ChildProcess | null;
}

export async function preflight(): Promise<Preflight> {
  const checks: Preflight["checks"] = [];
  let ownedProxy: ChildProcess | null = null;

  // 1 — the dev database, tested but never printed.
  const db = assertDevDatabase();
  checks.push({ name: "dev database (ep-broad-haze)", ...db });

  // 2 — the api-server. PROBED, NEVER STARTED.
  //
  // ⚠️ IT WAITS, BECAUSE THE DEV SERVER IS A WATCHER. `pnpm --filter
  // @workspace/api-server dev` is `tsx watch`, and any edit under
  // artifacts/api-server/src kills the child and starts a new one — the port is
  // genuinely closed for a second or two. With two other lanes editing that
  // tree, a bare one-shot probe fails the whole suite on somebody else's save.
  //
  // This is a WAIT FOR A SERVER THAT IS COMING BACK, not a retry that hides a
  // flake: the harness still never starts one, and it still fails if the port
  // stays shut. The elapsed wait is reported so a slow restart is visible.
  const apiPort = portOf(API_SERVER_ORIGIN);
  const waitStart = Date.now();
  let apiUp = await isListening(apiPort);
  const restartGraceMs = Number(process.env.KIWI_E2E_API_WAIT_MS ?? 60_000);
  while (!apiUp && Date.now() - waitStart < restartGraceMs) {
    await new Promise((r) => setTimeout(r, 1000));
    apiUp = await isListening(apiPort);
  }
  const waitedMs = Date.now() - waitStart;
  checks.push({
    name: `api-server on :${apiPort}`,
    ok: apiUp,
    note: apiUp
      ? `PASS — listening after ${(waitedMs / 1000).toFixed(1)}s (attached; this harness ` +
        `never starts or stops it)`
      : `FAIL — nothing on :${apiPort} after ${(waitedMs / 1000).toFixed(0)}s. Start the dev ` +
        `api-server yourself; the harness will not.`,
  });

  // 3 — the web export. Its freshness is a real trap: a stale dist/ silently
  // tests last week's bundle against today's server, and every rule then
  // measures the wrong build. Reported as an age, so a reader can judge it.
  const indexHtml = join(KIWI_ROOT, "dist", "index.html");
  if (!existsSync(indexHtml)) {
    checks.push({
      name: "web export at artifacts/kiwi/dist",
      ok: false,
      note: "FAIL — no dist/index.html. Run: pnpm --filter @workspace/kiwi exec expo export --platform web",
    });
  } else {
    const ageH = (Date.now() - statSync(indexHtml).mtimeMs) / 3_600_000;
    // The bundle must point at the SAME ORIGIN it is served from, or the page
    // loads and every request fails CORS — which reads as an auth bug.
    const jsDir = join(KIWI_ROOT, "dist", "_expo", "static", "js", "web");
    let baked = "(not found)";
    try {
      const { readdirSync } = await import("node:fs");
      for (const f of readdirSync(jsDir)) {
        if (!f.endsWith(".js")) continue;
        const m = /https?:\/\/[0-9a-zA-Z.:_-]+\/api/.exec(readFileSync(join(jsDir, f), "utf8"));
        if (m) {
          baked = m[0];
          break;
        }
      }
    } catch {
      /* reported as not-found below */
    }
    const wantBase = `${WEB_ORIGIN}/api`;
    const okBase = baked === wantBase;
    checks.push({
      name: "web export freshness + baked API base",
      ok: okBase,
      note: okBase
        ? `PASS — dist is ${ageH.toFixed(1)}h old and baked EXPO_PUBLIC_API_BASE_URL=${baked}`
        : `FAIL — dist bakes ${baked}, but it is served from ${WEB_ORIGIN}. Re-export with ` +
          `EXPO_PUBLIC_API_BASE_URL=${wantBase} or every request will be cross-origin.`,
    });
  }

  // 4 — the same-origin server. Started only if the port is free.
  const webPort = portOf(WEB_ORIGIN);
  const webUp = await isListening(webPort);
  if (webUp) {
    checks.push({
      name: `same-origin web server on :${webPort}`,
      ok: true,
      note: "PASS — already listening (attached; left running on exit)",
    });
  } else if (!existsSync(SERVE_PROXY_PATH)) {
    checks.push({
      name: `same-origin web server on :${webPort}`,
      ok: false,
      note: `FAIL — :${webPort} is free and no serve-proxy at ${SERVE_PROXY_PATH}`,
    });
  } else {
    ownedProxy = spawn(process.execPath, [SERVE_PROXY_PATH], {
      env: { ...process.env, PORT: String(webPort) },
      stdio: "ignore",
      windowsHide: true,
    });
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      up = await isListening(webPort);
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    checks.push({
      name: `same-origin web server on :${webPort}`,
      ok: up,
      note: up
        ? "PASS — started by this harness as a child (it will be stopped on exit)"
        : "FAIL — started serve-proxy but the port never opened",
    });
  }

  // 5 — the checkers this harness refuses to reimplement.
  const census = censusHarnessesPresent();
  checks.push({
    name: "census checkers (grocery + prep-cook)",
    ok: census.ok,
    note: census.ok ? `PASS — ${census.note}` : `FAIL — ${census.note}`,
  });

  return { ok: checks.every((c) => c.ok), checks, ownedProxy };
}

export function teardown(pf: Preflight): void {
  // Only ever our own child. Anything that was already listening stays up.
  if (pf.ownedProxy && !pf.ownedProxy.killed) pf.ownedProxy.kill();
}
