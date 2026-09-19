// SystemSetting readers — one place for "read a tunable, fall back on
// anything odd, warn once". Row 8 Block 1 extracted the number reader from
// routes/wizard.ts (which now delegates here) and added the boolean sibling
// for the `retailer.instacart_enabled` flag. The 60 s per-consumer cache is
// the same one wizard.ts kept in its closure, offered as a factory so each
// router instance owns its own window (tests build a router per case and
// must never see a stale flag from the previous one).
//
// A read NEVER throws: a missing row, a wrong-typed value, or a database
// error all yield the fallback with a warn, so a flag cannot take a route
// down — the same posture as the TRUST_PROXY_HOPS / BUG-263 env parsers.

import type { PrismaClient } from "@prisma/client";

import { logger } from "./logger";

type SettingsClient = Pick<PrismaClient, "systemSetting">;

export const SETTINGS_CACHE_MS = 60_000;

export async function readNumberSetting(
  prisma: SettingsClient,
  key: string,
  fallback: number,
): Promise<number> {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key } });
    if (row && typeof row.value === "number" && Number.isFinite(row.value)) {
      return row.value;
    }
    if (row && typeof row.value === "string") {
      const n = Number(row.value);
      if (Number.isFinite(n)) return n;
    }
    return fallback;
  } catch (err) {
    logger.warn(
      { event: "system_setting_read", key, err },
      "Falling back to default",
    );
    return fallback;
  }
}

/**
 * JSON `true` / `false` is the contract; the string spellings and 1/0 are
 * accepted because an admin editing the JSON column by hand will write them.
 * Anything else is the fallback.
 */
export async function readBooleanSetting(
  prisma: SettingsClient,
  key: string,
  fallback: boolean,
): Promise<boolean> {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key } });
    if (!row) return fallback;
    const v = row.value;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (v === 1) return true;
      if (v === 0) return false;
      return fallback;
    }
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
      if (s === "false" || s === "0" || s === "no" || s === "off") return false;
    }
    return fallback;
  } catch (err) {
    logger.warn(
      { event: "system_setting_read", key, err },
      "Falling back to default",
    );
    return fallback;
  }
}

/** Wrap a reader in a time-boxed cache. One window per call of this factory. */
export function createCachedSettingReader<T>(
  read: () => Promise<T>,
  ttlMs: number = SETTINGS_CACHE_MS,
): () => Promise<T> {
  let cached: { value: T; expiresAt: number } | null = null;
  return async () => {
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await read();
    cached = { value, expiresAt: Date.now() + ttlMs };
    return value;
  };
}
