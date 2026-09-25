// Row 5 · Block 1c (D-WS9-248) — the internal routes: things a scheduler
// calls, never a client.
//
//   POST /api/internal/images/drain — one tick of the on-save image queue
//   (lib/images/imageQueue.ts). Cloud Scheduler fires it once a minute with
//   an OIDC identity token; the route verifies the token against Google's
//   JWKS (lib/googleOidc.ts) and refuses everything else.
//
// CONFIGURATION, NOT A SECRET (both plain env; names in .env.example):
//   IMAGE_DRAIN_OIDC_EMAIL    — the scheduler job's service-account email
//                               (comma-separated allowlist)
//   IMAGE_DRAIN_OIDC_AUDIENCE — the `aud` the job was created with; the
//                               drain's own URL by Cloud Scheduler's default
//
// ⚠️ FAIL CLOSED. Either unset → the route answers 404 to everyone and logs
// `image_drain_not_configured` once per process, so a scheduler pointed at an
// unconfigured revision shows up as a failing job, not a silent no-op.
// ⚠️ Creating the Cloud Scheduler job (and enabling the API on kiwi-prod)
// is a Hans step — see DEPLOY.md.

import type { PrismaClient } from "@prisma/client";
import { Router, type IRouter, type Request } from "express";

import { GoogleJwksCache, parseEmailAllowlist, verifyGoogleIdToken, type JwksFetch, type OidcExpectation } from "../lib/googleOidc";
import { runImageDrain, type ImageDrainDeps } from "../lib/images/imageQueue";
import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";

export const ENV_IMAGE_DRAIN_OIDC_EMAIL = "IMAGE_DRAIN_OIDC_EMAIL";
export const ENV_IMAGE_DRAIN_OIDC_AUDIENCE = "IMAGE_DRAIN_OIDC_AUDIENCE";
// Row 13 "Test Kitchen" · Block 1 — the guest sweep's own pair, same shape,
// same fail-closed rule. A SECOND pair rather than reusing the drain's,
// because the two jobs are separately grantable: the sweep deletes rows and
// the drain spends money, and a deploy should be able to run one without the
// other.
export const ENV_GUEST_SWEEP_OIDC_EMAIL = "GUEST_SWEEP_OIDC_EMAIL";
export const ENV_GUEST_SWEEP_OIDC_AUDIENCE = "GUEST_SWEEP_OIDC_AUDIENCE";

// Row 13 · Block 1 — the two horizons, and they are different questions.
//
// An UNCLAIMED session is dead weight 7 days past its expiry: the visitor did
// not sign up, the plan was never theirs, and a guest plan never becomes
// catalog (scope §3.5).
//
// A CLAIMED session is FUNNEL EVIDENCE — it is the row that says this account
// came from the Test Kitchen — so it is kept much longer, and 30 days past
// the claim is long enough to answer "did the funnel convert last month?"
// without keeping a visitor's preferences blob indefinitely.
export const GUEST_UNCLAIMED_SWEEP_DAYS = 7;
export const GUEST_CLAIMED_SWEEP_DAYS = 30;

export interface InternalRouterDeps {
  prisma: PrismaClient;
  // The drain's real wiring is assembled lazily by live.ts (the ONE file that
  // holds the network + bucket seam); tests hand in stubs.
  drainDeps: () => Promise<ImageDrainDeps>;
  jwksFetch: JwksFetch;
  env: NodeJS.ProcessEnv;
}

export function readDrainExpectation(env: NodeJS.ProcessEnv): OidcExpectation | null {
  const emails = parseEmailAllowlist(env[ENV_IMAGE_DRAIN_OIDC_EMAIL]);
  const audience = env[ENV_IMAGE_DRAIN_OIDC_AUDIENCE]?.trim() ?? "";
  if (emails.length === 0 || !audience) return null;
  return { emails, audience };
}

export function readGuestSweepExpectation(
  env: NodeJS.ProcessEnv,
): OidcExpectation | null {
  const emails = parseEmailAllowlist(env[ENV_GUEST_SWEEP_OIDC_EMAIL]);
  const audience = env[ENV_GUEST_SWEEP_OIDC_AUDIENCE]?.trim() ?? "";
  if (emails.length === 0 || !audience) return null;
  return { emails, audience };
}

function bearer(req: Request): string | undefined {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return m?.[1];
}

export function createInternalRouter(deps: Partial<InternalRouterDeps> = {}): IRouter {
  const env = deps.env ?? process.env;
  const prisma = deps.prisma ?? productionPrisma;
  const jwksFetch: JwksFetch = deps.jwksFetch ?? ((url) => globalThis.fetch(url));
  const drainDeps =
    deps.drainDeps ??
    (async () => (await import("../lib/images/live")).createLiveImageDrainDeps(prisma));
  const jwks = new GoogleJwksCache({ fetch: jwksFetch });
  const router: IRouter = Router();
  let warnedUnconfigured = false;

  router.post("/internal/images/drain", async (req, res) => {
    const expect = readDrainExpectation(env);
    if (!expect) {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        logger.warn(
          { event: "image_drain_not_configured", vars: [ENV_IMAGE_DRAIN_OIDC_EMAIL, ENV_IMAGE_DRAIN_OIDC_AUDIENCE] },
          "Image drain route is unconfigured — answering 404 to every caller",
        );
      }
      return res.status(404).json({ error: "not found" });
    }
    const verdict = await verifyGoogleIdToken(bearer(req), expect, jwks);
    if (!verdict.ok) {
      logger.warn({ event: "image_drain_refused", reason: verdict.reason, detail: verdict.detail }, "Image drain caller refused");
      // The JWKS endpoint being down is our problem, not the caller's.
      if (verdict.reason === "jwks_unavailable") {
        res.setHeader("Retry-After", "30");
        return res.status(503).json({ error: "jwks_unavailable", retryable: true });
      }
      return res.status(401).json({ error: "unauthorized" });
    }
    try {
      const summary = await runImageDrain(await drainDeps());
      return res.status(200).json({ ok: true, caller: verdict.email, ...summary });
    } catch (err) {
      logger.error({ event: "image_drain_failed", err }, "Image drain tick failed");
      res.setHeader("Retry-After", "60");
      return res.status(503).json({ error: "drain_failed", retryable: true });
    }
  });

  // ── POST /internal/guest/sweep — Row 13 · Block 1 (D-WS9-259) ─────────
  //
  // Body-less. Deletes expired, unclaimed guest sessions and long-claimed
  // ones (see the two horizons above). GuestEvent rows CASCADE with the
  // session; LLMCallLog.guestSessionId is a plain string with NO FK and so
  // SURVIVES, by design — the cost ledger must outlive the session that spent
  // it or a sweep would quietly rewrite last month's spend.
  let warnedSweepUnconfigured = false;
  router.post("/internal/guest/sweep", async (req, res) => {
    const expect = readGuestSweepExpectation(env);
    if (!expect) {
      if (!warnedSweepUnconfigured) {
        warnedSweepUnconfigured = true;
        logger.warn(
          {
            event: "guest_sweep_not_configured",
            vars: [ENV_GUEST_SWEEP_OIDC_EMAIL, ENV_GUEST_SWEEP_OIDC_AUDIENCE],
          },
          "Guest sweep route is unconfigured — answering 404 to every caller",
        );
      }
      return res.status(404).json({ error: "not found" });
    }
    const verdict = await verifyGoogleIdToken(bearer(req), expect, jwks);
    if (!verdict.ok) {
      logger.warn(
        { event: "guest_sweep_refused", reason: verdict.reason, detail: verdict.detail },
        "Guest sweep caller refused",
      );
      if (verdict.reason === "jwks_unavailable") {
        res.setHeader("Retry-After", "30");
        return res.status(503).json({ error: "jwks_unavailable", retryable: true });
      }
      return res.status(401).json({ error: "unauthorized" });
    }
    try {
      const now = Date.now();
      const unclaimedBefore = new Date(
        now - GUEST_UNCLAIMED_SWEEP_DAYS * 24 * 60 * 60 * 1000,
      );
      const claimedBefore = new Date(
        now - GUEST_CLAIMED_SWEEP_DAYS * 24 * 60 * 60 * 1000,
      );
      // Two deleteMany calls, not one OR'd where: the predicates read against
      // DIFFERENT columns (expiresAt vs claimedAt) and the counts are worth
      // having separately — "unclaimed swept" is the funnel's abandonment
      // number, and folding it into a total would lose it.
      const unclaimed = await prisma.guestSession.deleteMany({
        where: { expiresAt: { lt: unclaimedBefore }, claimedAt: null },
      });
      const claimed = await prisma.guestSession.deleteMany({
        where: { claimedAt: { lt: claimedBefore } },
      });
      logger.info(
        {
          event: "guest_sweep_complete",
          caller: verdict.email,
          unclaimedDeleted: unclaimed.count,
          claimedDeleted: claimed.count,
        },
        "Guest session sweep complete",
      );
      return res.status(200).json({
        ok: true,
        caller: verdict.email,
        unclaimedDeleted: unclaimed.count,
        claimedDeleted: claimed.count,
      });
    } catch (err) {
      logger.error({ event: "guest_sweep_failed", err }, "Guest sweep failed");
      res.setHeader("Retry-After", "60");
      return res.status(503).json({ error: "sweep_failed", retryable: true });
    }
  });

  return router;
}

const router: IRouter = createInternalRouter();
export default router;
