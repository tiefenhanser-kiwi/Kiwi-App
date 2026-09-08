// WS9A BUG-234 — test-stub support for the session revocation guard.
//
// requireAuth used to be pure: verify the JWT, done, no database. It now reads
// User.tokensValidFrom, which means every stub Prisma passed to a router
// factory has to model `user.findUnique` or the guard cannot run. Most stubs in
// this suite predate the guard and model only the tables their own route
// touches, so they get this.
//
// ⚠️ WHAT THIS DOES NOT DO: it does not weaken the guard, and it must never be
// used to test it. The stub answers `null` — "no such user row" — which the
// guard treats as "nothing to revoke", exactly the behaviour at c38a596. So a
// suite wrapped in this sees the same auth outcomes it saw before this commit,
// which is the point: these files test grocery lists and meal plans, not
// revocation.
//
// The revocation guard's OWN tests (bug233SingleUseTokens, bug234Session-
// Invalidation) build their own stubs that return real rows with real
// tokensValidFrom stamps, so that deleting the check turns them RED. If you
// find yourself reaching for this helper in a test about revocation, the test
// is wrong.
//
// An existing `user.findUnique` is always preserved — files that already model
// the users table keep their own behaviour untouched.

/* eslint-disable @typescript-eslint/no-explicit-any */

export function withSessionUser<T>(stub: T): T {
  const existing = (stub as any)?.user;
  if (existing && typeof existing.findUnique === "function") return stub;
  return {
    ...(stub as any),
    user: {
      ...(existing ?? {}),
      // `null` => no row => no epoch => nothing revoked. Pre-guard behaviour.
      findUnique: async () => null,
    },
  } as T;
}

/**
 * WS9A BUG-233 — a stub UsedToken ledger that actually models the constraint
 * the real fix depends on.
 *
 * This is deliberately NOT a no-op fake. `create` enforces primary-key
 * uniqueness and throws a Prisma-shaped `P2002` on a duplicate `jti`, which is
 * the exact signal redeemPurposeToken() reads to decide "already spent". A stub
 * that accepted every insert would let a replayed token through and the
 * single-use guards would pass while the defect shipped — the tautology this
 * suite has been bitten by before.
 *
 * `deleteMany({ where: { expiresAt: { lt } } })` is modelled too, so the sweep
 * has something real to sweep.
 */
export interface UsedTokenRow {
  jti: string;
  userId: string;
  purpose: string;
  expiresAt: Date;
  usedAt: Date;
}

export function makeUsedTokenLedger(seed: UsedTokenRow[] = []) {
  const rows = new Map<string, UsedTokenRow>(seed.map((r) => [r.jti, r]));
  return {
    create: async ({ data }: { data: Omit<UsedTokenRow, "usedAt"> }) => {
      if (rows.has(data.jti)) {
        // Shaped like Prisma's unique-constraint error, because that shape is
        // load-bearing: redeemPurposeToken only treats `code === "P2002"` as
        // "already used" and rethrows anything else.
        throw Object.assign(new Error("Unique constraint failed on the fields: (`jti`)"), {
          code: "P2002",
          meta: { target: ["jti"] },
        });
      }
      const row: UsedTokenRow = { ...data, usedAt: new Date() };
      rows.set(data.jti, row);
      return row;
    },
    deleteMany: async ({ where }: { where: { expiresAt: { lt: Date } } }) => {
      const cutoff = where.expiresAt.lt;
      let count = 0;
      for (const [jti, row] of [...rows]) {
        if (row.expiresAt < cutoff) {
          rows.delete(jti);
          count++;
        }
      }
      return { count };
    },
    /** Test-only view of the ledger. Not part of the Prisma surface. */
    _rows: () => [...rows.values()],
  };
}
