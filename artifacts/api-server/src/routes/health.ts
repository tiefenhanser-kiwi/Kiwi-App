import { Router, type IRouter } from "express";
import type { PrismaClient } from "@prisma/client";
import { HealthCheckResponse } from "@workspace/api-zod";

import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";

// BUG-221 — LIVENESS AND READINESS ARE DIFFERENT QUESTIONS. THEY MUST NOT
// SHARE A ROUTE.
//
// Before this, /healthz was the only health surface and it returns a parsed
// literal that never touches the database. index.ts, separately and correctly
// (BUG-103), does not await $connect() and does not make a boot-time connect
// failure fatal — a database that is briefly unreachable must not stop the
// process from serving. Each decision is right on its own. Composed, they made
// a deploy gate that CANNOT FAIL. Measured: a process booted with a
// syntactically valid but unreachable DATABASE_URL logs prisma_connect_failed
// and still answers `GET /api/healthz -> 200 {"status":"ok"}` — so the
// revision goes green, takes 100% of traffic, and 503s every real request.
// That is the hardest outage to diagnose precisely because the platform is
// reporting success.
//
//   /healthz  LIVENESS  — "is this process alive?" Stays pure, on purpose. A
//                         liveness probe must not fail because the DB blipped;
//                         that restarts a healthy container mid-incident.
//   /readyz   READINESS — "should this instance receive traffic?" Proves the
//                         database with a trivial bounded query.
//
// ⚠️ A FAILING READINESS CHECK NEVER EXITS THE PROCESS. Readiness is designed
// to flap: it goes false while Neon wakes an auto-suspended branch and true
// again moments later. Exiting on it would turn a transient blip into a crash
// loop — strictly worse than the bug being fixed.
//
// The readiness body is deliberately NOT a @workspace/api-zod contract: it is
// a platform probe read by Cloud Run, not a client-facing response shape.

const READINESS_TIMEOUT_MS = 2_000;

export interface HealthRouterDeps {
  prisma: PrismaClient;
}

export function createHealthRouter(
  deps: Partial<HealthRouterDeps> = {},
): IRouter {
  const prisma = deps.prisma ?? productionPrisma;
  const router: IRouter = Router();

  router.get("/healthz", (_req, res) => {
    const data = HealthCheckResponse.parse({ status: "ok" });
    res.json(data);
  });

  router.get("/readyz", async (_req, res) => {
    const started = Date.now();
    try {
      // Bounded. A connection that hangs must still answer the probe rather
      // than hold it open until the platform's own timeout fires.
      await Promise.race([
        prisma.$queryRaw`SELECT 1`,
        new Promise((_resolve, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(
                  `readiness query exceeded ${READINESS_TIMEOUT_MS}ms`,
                ),
              ),
            READINESS_TIMEOUT_MS,
          ).unref();
        }),
      ]);
      return res
        .status(200)
        .json({ status: "ready", latencyMs: Date.now() - started });
    } catch (err) {
      logger.warn(
        {
          event: "readiness_check_failed",
          latencyMs: Date.now() - started,
          err,
        },
        "Readiness check failed — this instance should not receive traffic",
      );
      // 503 + Retry-After mirrors the terminal error handler's shape for the
      // same underlying condition. NOT a process exit — see the note above.
      res.setHeader("Retry-After", "2");
      return res.status(503).json({
        status: "not_ready",
        code: "db_unavailable",
        retryable: true,
      });
    }
  });

  return router;
}

const router: IRouter = createHealthRouter();
export default router;
