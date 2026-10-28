// QA-NIGHT-1 — a PRELOAD, run INSIDE the api-server child the night run starts on
// :3100 (`node --import tsx --import ./scripts/qa-night/bootProof.ts src/index.ts`).
//
// src/index.ts logs nothing about the mail switches, and this lane changes no
// server source. So the child proves them itself: before index.ts runs, this
// file reads the switches (lifecycle through the SERVER'S OWN reader,
// lifecycle/run.ts lifecycleEmailEnabled) and writes one JSON line to stdout.
// server.ts refuses to send a request until it has read this line from the
// child's own output and every value is off.
//
// ⚠️ MAIN THREAD ONLY. Node 25 also evaluates --import modules in the module
// hooks worker, where tsx's resolver is not installed, so a static import of
// server source fails there and takes the process down. The import is dynamic
// and the worker skips it.
//
// ⛔ Values are never echoed: a key is reported as "empty", "unset" or "SET (n chars)".
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  const { lifecycleEmailEnabled } = await import("../../src/lib/lifecycle/run.ts");
  const state = (key: string): string => {
    const raw = process.env[key];
    if (raw === undefined) return "unset";
    return raw.trim() === "" ? "empty" : `SET (${raw.length} chars)`;
  };
  process.stdout.write(
    `${JSON.stringify({
      event: "qa_night_boot_env",
      pid: process.pid,
      port: process.env.PORT ?? null,
      RESEND_API_KEY: state("RESEND_API_KEY"),
      SIGNUP_ALERT_TO: state("SIGNUP_ALERT_TO"),
      LIFECYCLE_EMAIL_ENABLED: process.env.LIFECYCLE_EMAIL_ENABLED ?? null,
      lifecycleEmailEnabled: lifecycleEmailEnabled(process.env),
    })}\n`,
  );
}
