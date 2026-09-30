// ─────────────────────────────────────────────────────────────────────────────
// The dev test account, read at runtime from outside the repo.
//
// 🔴 THE ONE RULE IN THIS FILE: the password never leaves this module's return
// value. It is not logged, not stored in out/, not put in a screenshot, and not
// interpolated into a URL. `redact()` exists so that anything the harness DOES
// write can be swept for it first.
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, readFileSync } from "node:fs";

import { CREDS_PATH } from "./env";

export interface Creds {
  email: string;
  password: string;
}

let cached: Creds | null = null;

export function readCreds(): Creds {
  if (cached) return cached;
  if (!existsSync(CREDS_PATH)) {
    throw new Error(
      `no test-account file at ${CREDS_PATH} — set KIWI_E2E_CREDS or create it (dev only)`,
    );
  }
  const txt = readFileSync(CREDS_PATH, "utf8");
  const email = /^\s*email:\s*(.+)$/im.exec(txt)?.[1]?.trim();
  const password = /^\s*password:\s*(.+)$/im.exec(txt)?.[1]?.trim();
  if (!email || !password) {
    throw new Error(
      `${CREDS_PATH} did not yield an "email:" and a "password:" line — refusing to guess`,
    );
  }
  cached = { email, password };
  return cached;
}

/**
 * Strip the account's secrets out of any text the harness is about to persist.
 * The email is masked too: it identifies the account, and results.json is a
 * file Hans may paste anywhere.
 */
export function redact(text: string): string {
  if (!cached) return text;
  return text
    .split(cached.password)
    .join("«password»")
    .split(cached.email)
    .join("«test-account»");
}
