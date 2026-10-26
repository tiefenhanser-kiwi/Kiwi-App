// LIFE-2 — User.lastActiveAt: the last authenticated request, at most hourly.
//
// The column existed since the first schema and nothing wrote it. The
// lifecycle schedule's still_here email ("It's been a week since you were in
// Kiwi") anchors on it, so requireAuth now writes it after a request has
// authenticated.
//
// THREE RULES, all for the request's sake:
//   • Never block it. The write is fire-and-forget: requireAuth calls touch()
//     and moves on; nothing awaits the update.
//   • Never fail it. A rejected or thrown write is logged and dropped.
//   • Never a write per request. An in-process map remembers when each user was
//     last written; a second request inside TOUCH_INTERVAL_MS writes nothing.
//     The map is per instance, so N Cloud Run instances can write the same user
//     up to N times an hour — still bounded, and an hour is far finer than the
//     7 days the email measures.
//
// The throttle is armed BEFORE the write is attempted, so a failing database
// costs one attempt per user per hour, not one per request.
//
// RAW SQL, ONE COLUMN. A Prisma `user.update` would also move User.updatedAt
// (@updatedAt) every hour for every active account, so "updated" would stop
// meaning the account changed. The UPDATE writes lastActiveAt and nothing
// else; a missing row is 0 rows, not a throw.

import type { PrismaClient } from "@prisma/client";

import { logger } from "./logger";

export const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
/** Above this many remembered users, entries older than the interval are dropped. */
const PRUNE_AT = 10_000;

type UserWriter = Pick<PrismaClient, "$executeRaw">;

export interface LastActiveToucher {
  /** Fire-and-forget. Returns true when a write was started (for tests). */
  touch(userId: string): boolean;
}

export function createLastActiveToucher(
  prisma: UserWriter,
  opts: { now?: () => Date; intervalMs?: number } = {},
): LastActiveToucher {
  const now = opts.now ?? (() => new Date());
  const interval = opts.intervalMs ?? TOUCH_INTERVAL_MS;
  const lastWrite = new Map<string, number>();

  const prune = (t: number) => {
    for (const [id, at] of lastWrite) if (t - at >= interval) lastWrite.delete(id);
  };

  return {
    touch(userId: string): boolean {
      const at = now();
      const t = at.getTime();
      const prev = lastWrite.get(userId);
      if (prev !== undefined && t - prev < interval) return false;
      if (lastWrite.size >= PRUNE_AT) prune(t);
      lastWrite.set(userId, t);
      const fail = (err: unknown) =>
        logger.warn(
          { event: "last_active_write_failed", userId, error: err instanceof Error ? err.message : String(err) },
          "lastActiveAt was not written — the request is unaffected",
        );
      try {
        void Promise.resolve(
          prisma.$executeRaw`UPDATE "users" SET "lastActiveAt" = ${at} WHERE "id" = ${userId}`,
        ).catch(fail);
      } catch (err) {
        fail(err);
      }
      return true;
    },
  };
}
