import type { Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";

import { logger } from "../lib/logger";

// BUG-103 — the terminal error boundary.
//
// Before this, the app's chain ended at `app.use("/api", router)` with NOTHING
// after it: there was no 4-arg error-handling middleware anywhere in the
// codebase. Any throw outside a route's own try/catch fell through to Express's
// `finalhandler`, which answers with an HTML body — carrying a full stack trace
// whenever NODE_ENV !== "production" — to a client that only ever parses JSON.
// The mobile app's `res.json()` then threw its own parse error on top, so the
// real fault never surfaced anywhere useful.
//
// This is a BACKSTOP, not a rewrite. Routes that already catch and shape their
// own 500 keep doing so and never reach here; this only catches what escapes.
// It also respects a response that has already begun streaming (the wizard SSE
// route) by delegating to Express's default handler, which closes the socket —
// writing a JSON body into a half-sent event-stream would corrupt it.

// Prisma's "cannot reach the database server" error. Neon serverless
// auto-suspends an idle branch, so the first request after a quiet period can
// hit this while the compute wakes — a transient, retryable condition that is
// categorically different from a bug in our code, and the client should be
// able to tell them apart rather than seeing one undifferentiated 500.
const DB_UNREACHABLE_CODES = new Set(["P1001", "P1002", "P1017"]);

export function isDbUnreachable(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) {
    // errorCode is optional on this class; treat ANY initialization failure as
    // "the database was not reachable", which is what it means in practice.
    return true;
  }
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    DB_UNREACHABLE_CODES.has(err.code)
  ) {
    return true;
  }
  return false;
}

// Express identifies an error handler by ARITY — it must declare four
// parameters, and `next` must stay in the signature even though the common
// path never calls it. Do not "clean up" the unused parameter.
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Log the real error server-side, always, before deciding what to answer.
  const requestId = (req as Request & { id?: unknown }).id;
  logger.error(
    {
      event: "unhandled_route_error",
      method: req.method,
      path: req.path,
      userId: req.userId ?? null,
      requestId: requestId ?? null,
      err,
    },
    "Unhandled error escaped a route handler",
  );

  // Headers already flushed (SSE, or a route that threw mid-write): Express's
  // default handler is the only correct move — it destroys the socket instead
  // of appending a JSON body to a partial response.
  if (res.headersSent) {
    return next(err);
  }

  if (isDbUnreachable(err)) {
    // 503 + Retry-After, not 500: this is "come back in a moment", and it is
    // NOT the caller's bug nor ours. The machine-readable `code` is what lets
    // the client distinguish "the database was asleep" (offer a retry) from
    // "the server has a bug" (show the generic failure state). Retry-After of
    // 2s is sized to a Neon cold start, which is typically sub-second to a
    // couple of seconds.
    res.setHeader("Retry-After", "2");
    res.status(503).json({
      error: "database unavailable",
      code: "db_unavailable",
      retryable: true,
    });
    return;
  }

  // Errors raised by Express's own middleware (chiefly body-parser: a
  // malformed JSON body, a body over the size limit) carry an intended status.
  // Honour it — turning body-parser's 400 into a blanket 500 would be a
  // regression, not a backstop. Only 4xx is honoured: a 5xx suggestion from an
  // arbitrary throw is not information we trust.
  const status = (err as { status?: unknown; statusCode?: unknown } | null)?.status
    ?? (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    res.status(status).json({ error: "bad request" });
    return;
  }

  // Everything else. NEVER ship the message or the stack — the throw site is
  // unknown by definition, so its text may carry a connection string, a token,
  // or a row's contents. The server log above has the whole thing.
  res.status(500).json({ error: "internal server error" });
}
