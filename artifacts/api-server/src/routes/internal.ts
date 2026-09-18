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

  return router;
}

const router: IRouter = createInternalRouter();
export default router;
