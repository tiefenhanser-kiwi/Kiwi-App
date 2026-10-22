// SEC-2 #2 — POST /recipes/import-url answers every fetch failure the same way:
// no `internalError`, no redirect target, no upstream status, and a blocked
// host is indistinguishable from an unreachable one. Every URL here is refused
// before a socket opens, so the suite makes no outbound request.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import { createRecipesRouter } from "../recipes";
import { withSessionUser } from "./fixtures/sessionUserStub";

describe("SEC-2 #2 — import-url replies carry no internals", () => {
  let baseUrl = "";
  let server: Server;
  const token = signToken("sec2-import-user");

  before(async () => {
    __clearRateLimitStoreForTests();
    const app: Express = express();
    app.use(express.json());
    app.use(
      createRecipesRouter({
        prisma: withSessionUser({}) as never,
        subscriptionService: { can: async () => ({ allowed: true }) } as never,
      }),
    );
    server = await new Promise((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => new Promise<void>((r) => server.close(() => r())));

  for (const url of [
    "http://[::1]/api/healthz",
    "http://169.254.169.254/computeMetadata/v1/",
    "http://metadata.google.internal/",
    "http://example.com:3100/",
  ]) {
    it(`${url} → generic fetch_error`, async () => {
      const res = await fetch(`${baseUrl}/recipes/import-url`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ url }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body["success"], false);
      assert.equal(body["reason"], "fetch_error");
      assert.equal("internalError" in body, false);
      assert.doesNotMatch(JSON.stringify(body), /Blocked|169\.254|::1|3100/);
    });
  }
});
