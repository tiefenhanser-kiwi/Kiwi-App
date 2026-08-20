// BUG-103 — the terminal error boundary.
//
// Before this, src/app.ts's chain ended at `app.use("/api", router)` with
// nothing after it — no 4-arg error handler anywhere in the codebase. Anything
// that threw outside a route's own try/catch reached Express's finalhandler and
// answered with an HTML body (carrying a stack trace whenever NODE_ENV is not
// "production") to a JSON-only client.
//
// Two harnesses:
//   • the REAL app, driven through a malformed JSON body — the only way to make
//     a real route throw without a database. Proves the handler is actually
//     mounted, and that a body-parser 400 is still a 400.
//   • a probe app mounting the SAME exported errorHandler behind routes that
//     throw on demand, for the cases the real app cannot be made to produce
//     (an arbitrary throw, a Prisma P1001, a throw after headers are sent).

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import express from "express";
import { Prisma } from "@prisma/client";

import app from "../../app";
import { errorHandler, isDbUnreachable } from "../../middleware/errorHandler";

interface Harness {
  origin: string;
  close: () => Promise<void>;
}

function listen(target: express.Express): Promise<Harness> {
  return new Promise((resolve) => {
    const server: Server = target.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r, j) =>
            server.close((err) => (err ? j(err) : r())),
          ),
      });
    });
  });
}

describe("BUG-103 — the real app answers JSON, not HTML, when middleware throws", () => {
  let harness: Harness;
  before(async () => {
    harness = await listen(app);
  });
  after(async () => {
    await harness.close();
  });

  it("a malformed JSON body produces a JSON error body (was HTML + stack trace)", async () => {
    const res = await fetch(`${harness.origin}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    const contentType = res.headers.get("content-type") ?? "";
    assert.ok(
      contentType.includes("application/json"),
      `expected a JSON response, got content-type: ${contentType}`,
    );
    const text = await res.text();
    assert.ok(
      !text.includes("<html") && !text.includes("<pre>"),
      "the error boundary must never render HTML to an API client",
    );
    assert.ok(
      !text.includes("at "),
      "the error boundary must never ship a stack trace to the client",
    );
    // body-parser's intended status survives — a backstop must not turn a 400
    // into a 500.
    assert.equal(res.status, 400);
    assert.deepEqual(JSON.parse(text), { error: "bad request" });
  });
});

describe("BUG-103 — errorHandler behaviour", () => {
  let harness: Harness;

  before(async () => {
    const probe = express();
    probe.get("/boom", () => {
      throw new Error("secret: postgres://user:hunter2@host/db");
    });
    probe.get("/async-boom", (_req, _res, next) => {
      // Express 5 forwards a rejected async handler to next() automatically.
      next(new Error("async explosion"));
    });
    probe.get("/db-down", (_req, _res, next) => {
      next(
        new Prisma.PrismaClientInitializationError(
          "Can't reach database server",
          "6.19.3",
          "P1001",
        ),
      );
    });
    probe.get("/route-owns-its-500", (_req, res) => {
      // Mirrors the shape every route already uses. It must reach the client
      // untouched — the boundary is a backstop, not a rewrite.
      res.status(500).json({ error: "internal server error" });
    });
    probe.get("/stream-then-boom", (_req, res, next) => {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.write("data: {}\n\n");
      next(new Error("failed mid-stream"));
    });
    probe.use(errorHandler);
    harness = await listen(probe);
  });
  after(async () => {
    await harness.close();
  });

  it("a synchronous throw becomes a JSON 500 with no message leak", async () => {
    const res = await fetch(`${harness.origin}/boom`);
    assert.equal(res.status, 500);
    assert.ok((res.headers.get("content-type") ?? "").includes("application/json"));
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: "internal server error" });
    assert.ok(
      !text.includes("hunter2") && !text.includes("postgres://"),
      "the throw site is unknown by definition — its message may carry secrets and must never ship",
    );
  });

  it("an error forwarded via next() is handled the same way", async () => {
    const res = await fetch(`${harness.origin}/async-boom`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "internal server error" });
  });

  it("a Prisma P1001 becomes a distinguishable 503 with Retry-After", async () => {
    const res = await fetch(`${harness.origin}/db-down`);
    assert.equal(
      res.status,
      503,
      "the database being asleep is not the same failure as the server having a bug",
    );
    assert.equal(res.headers.get("retry-after"), "2");
    assert.deepEqual(await res.json(), {
      error: "database unavailable",
      code: "db_unavailable",
      retryable: true,
    });
  });

  it("a route that shapes its OWN 500 is passed through untouched", async () => {
    const res = await fetch(`${harness.origin}/route-owns-its-500`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "internal server error" });
    assert.equal(
      res.headers.get("retry-after"),
      null,
      "a route's own 500 never went through the boundary, so it gains nothing from it",
    );
  });

  it("an error after headers are sent does NOT append a JSON body to the stream", async () => {
    const res = await fetch(`${harness.origin}/stream-then-boom`);
    // End-to-end sanity only. NOTE: this assertion does NOT by itself lock the
    // headersSent guard — with the guard removed, res.json() throws
    // ERR_HTTP_HEADERS_SENT before writing anything and the socket is destroyed
    // either way, so the observable body is the same. The guard is pinned
    // directly by the unit test below; this one exists to prove the real
    // end-to-end path does not corrupt a stream.
    let body = "";
    try {
      body = await res.text();
    } catch {
      body = "";
    }
    assert.ok(
      !body.includes("internal server error"),
      "writing a JSON body into a half-sent event-stream would corrupt it",
    );
  });

  it("GUARD LOCK: with headersSent, the handler delegates to next() and touches neither status nor json", () => {
    // Called directly so the delegation is observable. Removing the
    // `if (res.headersSent) return next(err)` branch makes this fail — the
    // handler starts trying to write a response over a sent one, which is
    // precisely the contract Express asks error handlers to respect.
    const err = new Error("mid-stream");
    let nextArg: unknown = "not-called";
    let statusCalls = 0;
    let jsonCalls = 0;
    const req = {
      method: "GET",
      path: "/stream",
      userId: "u-1",
    } as unknown as express.Request;
    const res = {
      headersSent: true,
      setHeader: () => {
        throw new Error("setHeader must not be called after headers are sent");
      },
      status: () => {
        statusCalls++;
        return res;
      },
      json: () => {
        jsonCalls++;
        return res;
      },
    } as unknown as express.Response & { headersSent: boolean };

    errorHandler(err, req, res, ((e: unknown) => {
      nextArg = e;
    }) as unknown as express.NextFunction);

    assert.equal(nextArg, err, "the error must be forwarded to Express's default handler");
    assert.equal(statusCalls, 0);
    assert.equal(jsonCalls, 0);
  });
});

describe("BUG-103 — isDbUnreachable classification", () => {
  it("classifies PrismaClientInitializationError as unreachable", () => {
    assert.equal(
      isDbUnreachable(
        new Prisma.PrismaClientInitializationError("nope", "6.19.3", "P1001"),
      ),
      true,
    );
  });

  it("classifies a P1001 known-request error as unreachable", () => {
    assert.equal(
      isDbUnreachable(
        new Prisma.PrismaClientKnownRequestError("nope", {
          code: "P1001",
          clientVersion: "6.19.3",
        }),
      ),
      true,
    );
  });

  it("does NOT classify an ordinary query error (P2002 unique violation) as unreachable", () => {
    assert.equal(
      isDbUnreachable(
        new Prisma.PrismaClientKnownRequestError("dup", {
          code: "P2002",
          clientVersion: "6.19.3",
        }),
      ),
      false,
      "a constraint violation is our bug, not a sleeping database — it must not be sold to the client as retryable",
    );
  });

  it("does NOT classify a plain Error as unreachable", () => {
    assert.equal(isDbUnreachable(new Error("boom")), false);
  });
});
