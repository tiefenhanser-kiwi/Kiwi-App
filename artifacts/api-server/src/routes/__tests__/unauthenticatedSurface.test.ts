// Row 13 "Test Kitchen" · Block 1 — THE UNAUTHENTICATED SURFACE GUARD.
//
// Phase 0 asked for this, and the reason is specific to what this block did:
// Row 13 is the first change in the project's history that adds a route an
// anonymous caller may reach, and it does it by introducing a SECOND auth
// guard (requireGuestOrAuth). Both of those make it easier than it has ever
// been for a route to end up reachable without meaning to — a missing guard
// in a router factory, a guard applied to the wrong overload, a new route
// pasted next to a guarded neighbour.
//
// So: enumerate every route Express actually mounted, probe each one with NO
// Authorization header, and assert the set that does not answer 401/403 is
// EXACTLY the known list. This is a canary, not a policy — when it fails, the
// question to ask is "should that route be public?", and the list below is
// widened only with an answer.
//
// ⚠️ The probe sends no body and no auth. A route that 400s on a missing body
// BEFORE it authenticates is treated as UNAUTHENTICATED here, deliberately:
// answering "your body is wrong" to a stranger is itself a disclosure, and
// more to the point it means the handler ran before the guard did.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express, type IRouter } from "express";

import router from "../index";

// ── the known list ───────────────────────────────────────────────────────
//
// Every entry is here because someone decided it should be, and the comment
// says who and why. Adding a line to this list is a security decision.
const KNOWN_PUBLIC = new Set<string>([
  // Liveness / readiness — probed by Cloud Run itself, before any user exists.
  "GET /healthz",
  "GET /readyz",
  "GET /health",
  // The auth doors. These ARE the unauthenticated surface by definition; each
  // has its own limiter (authLimiter / resetLimiter).
  "POST /auth/signup",
  "POST /auth/login",
  "POST /auth/logout",
  "POST /auth/password-reset/request",
  "POST /auth/password-reset/confirm",
  // 🔴 ROW 9 (1.1) · OAUTH BLOCK 1 — the two social doors, and they belong
  // here for exactly the reason /auth/login does: they ARE the unauthenticated
  // surface. There is no session to present; the CREDENTIAL IS THE BODY — an
  // identity token verified against Apple's or Google's published keys before
  // anything else happens (lib/oauth/verify.ts), which is a stronger check
  // than the password one beside them, not a weaker one.
  //
  // Both carry `authLimiter`, the same limiter as signup and login. An unset
  // audience list answers 503 `oauth_unavailable` and every verification
  // failure answers one generic 401 — a stranger learns nothing from either.
  "POST /auth/oauth/apple",
  "POST /auth/oauth/google",
  // Redeemed from an emailed link, in whatever browser the person opened the
  // mail in — there is no session to present. The purpose-scoped,
  // single-use (BUG-233) token in the body IS the credential, exactly as on
  // /auth/password-reset/confirm. Rate-limited by passwordChangeLimiter.
  // FOUND BY THIS TEST on its first run, which is the test working.
  "POST /me/email/verify-change",
  // 🔴 ROW 13 · BLOCK 1 — THE ONE ROUTE THIS BLOCK ADDS TO THIS LIST.
  // Rate-limited, and Turnstile-gated the moment TURNSTILE_SECRET_KEY is set.
  // The other three /guest routes sit behind requireGuestOrAuth and must NOT
  // appear here.
  "POST /guest/session",
  // 🔴 ROW 9 (1.1) · STRIPE S1 — THE ONE ROUTE THAT BLOCK ADDS, and it is the
  // second unauthenticated WRITE surface in the server.
  //
  // It belongs here for the same reason the OAuth doors do: THE CREDENTIAL IS
  // THE REQUEST. The `stripe-signature` header is an HMAC over the raw body with
  // a timestamp window, verified against STRIPE_WEBHOOK_SECRET before anything
  // else happens — a check Stripe alone can satisfy, and a stronger one than the
  // password beside it. A caller with no signature gets 400 and learns nothing.
  //
  // It CANNOT be authenticated any other way: Stripe's servers have no Kiwi
  // session and their source addresses are not a stable allowlist. There is also
  // no rate limiter, deliberately — a 429 makes Stripe retry the whole burst for
  // three days, and renewals legitimately arrive in bursts.
  //
  // ⚠️ This test probes with no body. The route answers 400 (no signature) BEFORE
  // it reads anything, which is the correct order and is why it shows up here.
  "POST /webhooks/stripe",
  // 🔴 RESUBMISSION B1 — THE ONE ROUTE THAT BLOCK ADDS: the store rail's
  // webhook (Apple In-App Purchase / Google Play Billing, via RevenueCat).
  //
  // Same reasoning as Stripe's: THE CREDENTIAL IS THE REQUEST. RevenueCat sends
  // the Authorization header configured in its dashboard on every delivery; the
  // WHOLE header is compared to REVENUECAT_WEBHOOK_AUTH in constant time before
  // anything else, and a mismatch is 401 with no claim and no read. RevenueCat's
  // servers have no Kiwi session either, and no rate limiter, for Stripe's
  // reason — its retries reuse the event id and a 429 only defers them.
  //
  // It is also a weaker write than Stripe's by design: the route NEVER writes
  // the payload. It re-reads each affected customer from RevenueCat with the
  // secret key, so a forged-but-authenticated body can at most trigger a re-read
  // of the truth. (Probed here with RevenueCat unconfigured, it answers 503
  // before reading anything, which is why it appears.)
  "POST /webhooks/revenuecat",
]);

/** Walk the mounted router and return "METHOD /path" for every layer. */
function enumerateRoutes(r: IRouter): string[] {
  const out: string[] = [];
  const walk = (stack: unknown[], prefix: string): void => {
    for (const layer of stack as Array<Record<string, unknown>>) {
      const route = layer.route as
        | { path: string; methods?: Record<string, boolean>; stack?: unknown[] }
        | undefined;
      if (route) {
        const methods =
          route.methods ??
          ((route as unknown as { stack: Array<{ method?: string }> }).stack ?? [])
            .reduce<Record<string, boolean>>((acc, s) => {
              if (s.method) acc[s.method] = true;
              return acc;
            }, {});
        for (const m of Object.keys(methods)) {
          out.push(`${m.toUpperCase()} ${prefix}${route.path}`);
        }
      } else if (layer.handle && (layer.handle as { stack?: unknown[] }).stack) {
        walk((layer.handle as { stack: unknown[] }).stack, prefix);
      }
    }
  };
  walk((r as unknown as { stack: unknown[] }).stack, "");
  return [...new Set(out)];
}

describe("the unauthenticated surface", () => {
  it("is EXACTLY the known list plus POST /guest/session", async () => {
    const app: Express = express();
    app.use(express.json());
    app.use("/api", router);
    const server = await new Promise<import("node:http").Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = server.address() as { port: number };

    try {
      const routes = enumerateRoutes(router);
      assert.ok(
        routes.length > 50,
        `the enumeration found only ${routes.length} routes — it is not walking the tree`,
      );

      const unauthenticated: string[] = [];
      for (const entry of routes) {
        const [method, path] = entry.split(" ");
        // Only probe paths with no parameters; a :id probe would 400/404 for
        // reasons unrelated to auth and muddy the signal.
        if (path.includes(":")) continue;
        // The internal routes are OIDC-gated and answer 404 when unconfigured,
        // which is indistinguishable from "not mounted" by design — they are
        // covered by their own tests (internalImageDrain, guestSweep).
        if (path.startsWith("/internal/")) continue;

        const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(method === "GET" || method === "HEAD"
            ? {}
            : { body: JSON.stringify({}) }),
        });
        if (res.status !== 401 && res.status !== 403) {
          unauthenticated.push(entry);
        }
      }

      // The list must not rot in the other direction either: an entry that no
      // longer names a reachable public route is a stale exemption, and a
      // stale exemption is how a future route gets waved through by accident.
      const probed = new Set(
        routes.filter((e) => {
          const p = e.split(" ")[1];
          return !p.includes(":") && !p.startsWith("/internal/");
        }),
      );
      const stale = [...KNOWN_PUBLIC].filter(
        (e) => probed.has(e) && !unauthenticated.includes(e),
      );
      assert.deepEqual(
        stale,
        [],
        `these KNOWN_PUBLIC entries are now guarded — remove them:\n  ${stale.join("\n  ")}`,
      );

      const unexpected = unauthenticated.filter((e) => !KNOWN_PUBLIC.has(e));
      assert.deepEqual(
        unexpected,
        [],
        `these routes answered an unauthenticated caller without 401/403:\n  ${unexpected.join("\n  ")}\n` +
          `If that is intended, add each to KNOWN_PUBLIC with a comment saying why.`,
      );

      // The other half of the guard: the three guest routes that are NOT
      // public must actually be guarded, and this asserts it positively
      // rather than relying on their absence from a list.
      for (const guarded of ["GET /guest/session", "GET /guest/draft", "POST /guest/events"]) {
        assert.ok(
          !unauthenticated.includes(guarded),
          `${guarded} must require a guest token`,
        );
      }
      assert.ok(
        unauthenticated.includes("POST /guest/session"),
        "POST /guest/session must be reachable without a token — it is how a guest gets one",
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
