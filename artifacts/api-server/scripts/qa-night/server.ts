// QA-NIGHT-1 — the night run OWNS its api-server.
//
//   • a child on :3100, from this repo's src, `node --import tsx` (NOT `tsx
//     watch`: another lane's save must not restart the server mid-household);
//   • env = artifacts/api-server/.env parsed here and passed explicitly, with
//     the mail switches laid over it (EMAIL_OFF). NO --env-file: the dev .env
//     sets RESEND_API_KEY and LIFECYCLE_EMAIL_ENABLED, and a file the child
//     loads itself could refill a key Windows dropped as empty;
//   • two proofs, both from the child's own stdout, before the first request:
//       1. bootProof.ts (a preload) prints the switches read by the server's
//          own readers — "empty" or "unset" for the key and the alert address;
//       2. the server's own boot line, lifecycle/run.ts "lifecycle email: off";
//   • stopServer() kills the child (and only it). Hans's :3000 is never probed,
//     never started, never stopped.
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { join } from "node:path";

export const QA_PORT = 3100;
export const QA_API = `http://localhost:${QA_PORT}/api`;

export interface BootProof {
  event: "qa_night_boot_env";
  pid: number;
  port: string | null;
  RESEND_API_KEY: string;
  SIGNUP_ALERT_TO: string;
  LIFECYCLE_EMAIL_ENABLED: string | null;
  lifecycleEmailEnabled: boolean;
}

export interface OwnedServer {
  child: ChildProcess;
  proof: BootProof;
  /** The server's own lifecycle_email_config line said off. */
  lifecycleOffLine: true;
  logPath: string;
}

/** The .env as a map. Values are never printed. */
export function readDotEnv(apiRoot: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of readFileSync(join(apiRoot, ".env"), "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(l);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export const EMAIL_OFF = {
  RESEND_API_KEY: "",
  SIGNUP_ALERT_TO: "",
  LIFECYCLE_EMAIL_ENABLED: "false",
  // Not in the brief's three, blanked for the same reason: feedback mails
  // FEEDBACK_TO, and the guest path's bot check would refuse a script.
  FEEDBACK_TO: "",
  TURNSTILE_SECRET_KEY: "",
} as const;

/** "empty" and "unset" are both off: the child loads no .env that could refill an unset key. */
const OFF = new Set(["empty", "unset"]);

/** Every value off, or the reason it is not. */
export function proofProblems(p: BootProof): string[] {
  const out: string[] = [];
  if (p.port !== String(QA_PORT)) out.push(`port ${p.port} (want ${QA_PORT})`);
  if (!OFF.has(p.RESEND_API_KEY)) out.push(`RESEND_API_KEY ${p.RESEND_API_KEY}`);
  if (!OFF.has(p.SIGNUP_ALERT_TO)) out.push(`SIGNUP_ALERT_TO ${p.SIGNUP_ALERT_TO}`);
  if (p.LIFECYCLE_EMAIL_ENABLED !== "false") out.push(`LIFECYCLE_EMAIL_ENABLED ${p.LIFECYCLE_EMAIL_ENABLED}`);
  if (p.lifecycleEmailEnabled !== false) out.push("lifecycleEmailEnabled() is true");
  return out;
}

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${QA_API}/healthz`);
    return r.ok;
  } catch {
    return false;
  }
}

export async function startServer(apiRoot: string, outDir: string): Promise<OwnedServer> {
  if (await healthy()) {
    throw new Error(`:${QA_PORT} already answers — refusing to share a server the run does not own`);
  }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...readDotEnv(apiRoot),
    ...EMAIL_OFF,
    PORT: String(QA_PORT),
    LOG_LEVEL: process.env.KIWI_QA_LOG_LEVEL ?? "info",
  };
  const logPath = join(outDir, "server.log");
  const log = createWriteStream(logPath);
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--import", "./scripts/qa-night/bootProof.ts", "src/index.ts"],
    { cwd: apiRoot, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  child.stdout!.pipe(log, { end: false });
  child.stderr!.pipe(log, { end: false });

  let proof: BootProof | null = null;
  let lifecycleOffLine = false;
  let buf = "";
  child.stdout!.on("data", (d: Buffer) => {
    if (proof && lifecycleOffLine) return;
    // pino-pretty colours its lines outside production; strip ANSI first.
    buf += d.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "");
    for (const line of buf.split(/\r?\n/)) {
      if (/lifecycle email: off/.test(line)) lifecycleOffLine = true;
      if (proof || !line.includes('"qa_night_boot_env"')) continue;
      try {
        proof = JSON.parse(line) as BootProof;
      } catch {
        /* a partial line; the next chunk completes it */
      }
    }
  });
  let exited: number | null = null;
  child.once("exit", (code) => {
    exited = code ?? -1;
  });

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`api-server child exited (${exited}) during boot — see ${logPath}`);
    if (proof && lifecycleOffLine && (await healthy())) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const problems = proof ? proofProblems(proof) : ["no qa_night_boot_env line from the child"];
  if (!lifecycleOffLine) problems.push('the server never logged "lifecycle email: off"');
  if (!(await healthy())) problems.push(`:${QA_PORT} never answered /api/healthz`);
  if (problems.length > 0) {
    child.kill();
    throw new Error(`boot proof refused (${logPath}): ${problems.join("; ")}`);
  }
  return { child, proof: proof!, lifecycleOffLine: true, logPath };
}

export async function stopServer(s: OwnedServer): Promise<void> {
  if (s.child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      s.child.kill("SIGKILL");
      resolve();
    }, 5000);
    s.child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    s.child.kill("SIGTERM");
  });
}
