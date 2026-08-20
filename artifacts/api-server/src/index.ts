import app from "./app";
import { logger } from "./lib/logger";
import { prisma } from "./lib/prisma";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// BUG-103 — warm the connection pool before the first request arrives.
// lib/prisma.ts is a bare singleton with no boot-time connect, so Prisma
// connected LAZILY on the first query: whichever user happened to hit the
// server first after a deploy (or after Neon auto-suspended an idle branch)
// paid the whole cold-start inside their request, and if the branch was still
// waking they got the failure.
//
// Deliberately NOT awaited before listen() and deliberately NOT fatal: a
// database that is unreachable at boot must not stop the process from serving
// (health checks, and the DB is usually up moments later). We log the failure
// and continue — the terminal error handler turns any resulting request-time
// P1001 into a typed 503 rather than an HTML stack trace.
prisma
  .$connect()
  .then(() => logger.info({ event: "prisma_connected" }, "Prisma connected"))
  .catch((err: unknown) => {
    logger.error(
      { event: "prisma_connect_failed", err },
      "Prisma boot-time connect failed — continuing; requests will retry lazily",
    );
  });

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// Graceful shutdown so the workflow can be restarted without orphaning the
// port. We give in-flight requests a short window, then force-exit so the
// next dev cycle never hits EADDRINUSE.
let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");

  const forceExit = setTimeout(() => {
    logger.warn("Force exit after shutdown timeout");
    process.exit(0);
  }, 2500);
  forceExit.unref();

  server.close((err) => {
    if (err) {
      logger.error({ err }, "Error closing server");
      process.exit(1);
    }
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
