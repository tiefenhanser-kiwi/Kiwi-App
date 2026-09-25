// Row 13 "Test Kitchen" · Block 1 (D-WS9-259) — the guest session routes.
//
//   POST /guest/session — mint a guest session + a 24 h purpose:"guest" token.
//                         The ONE new unauthenticated route this block adds.
//   POST /guest/events  — one funnel event (scope §3.8).
//   GET  /guest/session — what the client needs to resume (never the ipHash).
//   GET  /guest/draft   — the expanded plan, in GET /wizard/drafts/:id's shape.
//
// The guest's whole plan lives on the GuestSession row as JSON, because Phase 0
// established that it cannot live anywhere else: every plan table's userId is
// NOT NULL. See prisma/schema.prisma's GuestSession comment.

import { createHash } from "node:crypto";

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import { signToken } from "../lib/auth";
import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { clientIp, rateLimit } from "../lib/rateLimit";
import { parseTrustProxyHops } from "../lib/trustProxy";
import {
  createRequireGuestOrAuth,
  GUEST_SESSION_TTL_MS,
  GUEST_TOKEN_EXPIRY,
} from "../middleware/guestAuth";
import {
  createRequireTurnstile,
  type RequireTurnstileDeps,
} from "../middleware/turnstile";

// ── the funnel's closed event list (scope §3.8) ──────────────────────────
//
// ONE exported const, and a plain string column behind it, so widening the
// funnel is a line here and a deploy — never a migration. GuestEvent.event is
// deliberately not an enum for exactly this reason (see the schema comment).
export const GUEST_EVENTS = [
  "session_created",
  "wizard_step",
  "generated",
  "thin_shelf",
  "plan_opened",
  "recipe_opened",
  "door_tapped",
  "signup_started",
  "signup_completed",
  "claimed",
] as const;
export type GuestEvent = (typeof GUEST_EVENTS)[number];

/** Per-IP cap: 3 sessions in a rolling 24 h. INERT until TRUST_PROXY_HOPS > 0. */
export const GUEST_SESSIONS_PER_IP_PER_DAY = 3;

const guestEventSchema = z.object({
  event: z.enum(GUEST_EVENTS),
  step: z.string().max(80).optional(),
  // 2 KB, measured on the serialised form — the only bound that means anything
  // for a JSONB column a public route writes into.
  meta: z
    .unknown()
    .optional()
    .refine(
      (v) => v === undefined || JSON.stringify(v ?? null).length <= 2048,
      { message: "meta must serialise to 2KB or less" },
    ),
});

const guestSessionCreateSchema = z.object({
  turnstileToken: z.string().max(4096).optional(),
});

/**
 * sha256(ip + JWT_SECRET). The salt is what stops the hash being a rainbow
 * table over the IPv4 space — an unsalted sha256 of an address is the address.
 * NEVER the raw value: the cap needs to recognise a repeat visitor, not to
 * know where they live, and the row is readable by anyone with DB access.
 */
export function hashIp(ip: string, secret: string): string | null {
  if (!ip || ip === "unknown") return null;
  return createHash("sha256").update(`${ip}:${secret}`).digest("hex");
}

export interface GuestRouterDeps {
  prisma: PrismaClient;
  env: NodeJS.ProcessEnv;
  /** Test seam for the Turnstile outbound call + its env. */
  turnstileDeps: Partial<RequireTurnstileDeps>;
  /** Override the session-creation limiter for tests. */
  rateLimiterOpts: { capacity: number; refillPerSec: number };
  now: () => Date;
}

export function createGuestRouter(deps: Partial<GuestRouterDeps> = {}): IRouter {
  const prisma = deps.prisma ?? productionPrisma;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const requireGuestOrAuth = createRequireGuestOrAuth({ prisma });
  const requireTurnstile = createRequireTurnstile({
    env,
    ...(deps.turnstileDeps ?? {}),
  });

  // ⚠️ THE SAME CAVEAT AS THE PER-IP CAP BELOW, AND IT IS NOT COSMETIC. This
  // limiter keys on clientIp(), and with TRUST_PROXY_HOPS unset (its state on
  // Cloud Run today) req.ip is Google's front end for every request on earth —
  // so this is ONE GLOBAL BUCKET, not a per-visitor one. Same shape as
  // authLimiter, same measured weakness (BUG-223 / Phase 0 §9.5). Held
  // deliberately loose for that reason: a global 30/min is a speed bump that
  // will become a real per-IP limit the moment the hop count is measured.
  const sessionLimiter = rateLimit(
    deps.rateLimiterOpts ?? { capacity: 30, refillPerSec: 30 / 60 },
  );

  const router: IRouter = Router();

  /** Guest-ONLY. A signed-in user hitting these has no business here. */
  function guestOnly(req: Request, res: Response, next: NextFunction): void {
    if (!req.guestSessionId) {
      res.status(403).json({ code: "guest_only" });
      return;
    }
    next();
  }

  // ── POST /guest/session ──────────────────────────────────────────────
  router.post(
    "/guest/session",
    sessionLimiter,
    requireTurnstile,
    async (req, res) => {
      const parsed = guestSessionCreateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid request body" });
      }

      const secret = env["JWT_SECRET"];
      if (!secret) {
        // lib/auth.ts throws at import without this, so reaching here means a
        // test handed in an env without it. Refuse rather than hash with "".
        logger.error(
          { event: "guest_session_no_secret" },
          "JWT_SECRET missing — cannot salt the guest ipHash",
        );
        return res.status(503).json({ error: "guest sessions unavailable" });
      }

      const ipHash = hashIp(clientIp(req), secret);

      // ── the per-IP cap ────────────────────────────────────────────────
      //
      // 🔴 GATED ON TRUST_PROXY_HOPS > 0, AND THE GATE IS THE WHOLE POINT.
      // Phase 0 §9.5: the variable is UNSET on the service and has never been
      // measured, so req.ip is Google's front end for every visitor. Running
      // this cap in that state would not be a weak per-IP cap — it would be a
      // GLOBAL cap of three guest sessions per day for the entire internet,
      // which is an outage dressed as a guard. So it is inert until a deploy
      // vouches for a hop count (DEPLOY.md names the two-network curl that
      // measures it), and the boot line says which state we are in.
      const hops = parseTrustProxyHops(env["TRUST_PROXY_HOPS"]);
      if (hops > 0 && ipHash) {
        const since = new Date(now().getTime() - 24 * 60 * 60 * 1000);
        const recent = await prisma.guestSession.count({
          where: { ipHash, createdAt: { gte: since } },
        });
        if (recent >= GUEST_SESSIONS_PER_IP_PER_DAY) {
          logger.warn(
            { event: "guest_session_ip_capped", recent },
            "Guest session refused — per-IP daily cap",
          );
          res.setHeader("Retry-After", "3600");
          return res.status(429).json({ code: "guest_ip_cap" });
        }
      }

      try {
        const expiresAt = new Date(now().getTime() + GUEST_SESSION_TTL_MS);
        const session = await prisma.guestSession.create({
          data: {
            expiresAt,
            ipHash,
            // The wizard has not run yet. The body lands here at build-plans.
            preferences: {},
            lastEvent: "session_created",
          },
          select: { id: true, expiresAt: true },
        });
        // The session id rides in the token's `userId` slot — see lib/auth.ts.
        const token = signToken(session.id, {
          purpose: "guest",
          expiresIn: GUEST_TOKEN_EXPIRY,
        });
        await prisma.guestEvent
          .create({
            data: { guestSessionId: session.id, event: "session_created" },
          })
          .catch((err) => {
            // Funnel telemetry never sinks the funnel.
            logger.warn(
              { event: "guest_event_write_failed", err },
              "Failed to write the session_created guest event",
            );
          });
        logger.info(
          { event: "guest_session_created", guestSessionId: session.id },
          "Guest session created",
        );
        return res.status(201).json({
          guestSessionId: session.id,
          token,
          expiresAt: session.expiresAt.toISOString(),
        });
      } catch (err) {
        logger.error(
          { event: "guest_session_create_failed", err },
          "Failed to create a guest session",
        );
        return res.status(500).json({ error: "failed to create guest session" });
      }
    },
  );

  // ── POST /guest/events ───────────────────────────────────────────────
  router.post(
    "/guest/events",
    requireGuestOrAuth,
    guestOnly,
    async (req, res) => {
      const parsed = guestEventSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid request body",
          details: parsed.error.flatten(),
        });
      }
      const guestSessionId = req.guestSessionId!;
      const { event, step, meta } = parsed.data;
      try {
        await prisma.guestEvent.create({
          data: {
            guestSessionId,
            event,
            step: step ?? null,
            ...(meta === undefined ? {} : { meta: meta as never }),
          },
        });
        // Denormalised so "where did they stop?" is one read of the session
        // row; guest_events stays the record.
        await prisma.guestSession.update({
          where: { id: guestSessionId },
          data: { lastEvent: event },
        });
        return res.status(201).json({ ok: true });
      } catch (err) {
        logger.error(
          { event: "guest_event_failed", guestSessionId, err },
          "Failed to record a guest event",
        );
        return res.status(500).json({ error: "failed to record event" });
      }
    },
  );

  // ── GET /guest/session ───────────────────────────────────────────────
  router.get("/guest/session", requireGuestOrAuth, guestOnly, async (req, res) => {
    const guestSessionId = req.guestSessionId!;
    try {
      const row = await prisma.guestSession.findUnique({
        where: { id: guestSessionId },
        // ipHash is NOT in this select and must never be: it is the one field
        // on the row the visitor is not entitled to read back about themselves.
        select: {
          id: true,
          expiresAt: true,
          generationCount: true,
          preferences: true,
          draft: true,
        },
      });
      if (!row) return res.status(404).json({ code: "no_session" });
      return res.json({
        id: row.id,
        expiresAt: row.expiresAt.toISOString(),
        generationCount: row.generationCount,
        hasDraft: row.draft !== null,
        preferences: row.preferences,
      });
    } catch (err) {
      logger.error(
        { event: "guest_session_read_failed", guestSessionId, err },
        "Failed to read the guest session",
      );
      return res.status(500).json({ error: "failed to read session" });
    }
  });

  // ── GET /guest/draft ─────────────────────────────────────────────────
  //
  // Returns EXACTLY what GET /wizard/drafts/:id returns —
  // { draft: { id, createdAt }, expanded } — so the mobile draft screen
  // renders a guest plan through the code path it already has. The stored blob
  // IS that object; this route is a read, not a re-shape.
  router.get("/guest/draft", requireGuestOrAuth, guestOnly, async (req, res) => {
    const guestSessionId = req.guestSessionId!;
    try {
      const row = await prisma.guestSession.findUnique({
        where: { id: guestSessionId },
        select: { draft: true },
      });
      if (!row || row.draft === null) {
        return res.status(404).json({ code: "no_draft" });
      }
      return res.json(row.draft);
    } catch (err) {
      logger.error(
        { event: "guest_draft_read_failed", guestSessionId, err },
        "Failed to read the guest draft",
      );
      return res.status(500).json({ error: "failed to read draft" });
    }
  });

  return router;
}

const router: IRouter = createGuestRouter();
export default router;
