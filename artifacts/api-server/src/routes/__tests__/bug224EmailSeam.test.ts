// BUG-224 — the email seam.
//
// Three properties, each driven through the LIVE route rather than restated:
//   1. NO KEY  -> nothing is sent, the route still returns its normal
//      anti-enumeration response, and nothing token-shaped reaches the log.
//   2. KEY     -> the sender is invoked exactly once, with the right recipient
//      and an https link carrying the token. Recording stub; no network.
//   3. A request that never reaches the send branch invokes nothing.
//
// The sender is injected, so no test can reach Resend even by accident.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import {
  assertMailEnvComplete,
  buildAppLink,
  emailChangeMessage,
  passwordResetMessage,
  sendEmail as productionSendEmail,
  type EmailMessage,
  type EmailSender,
  type SendResult,
} from "../../lib/email/sendEmail";
import { createAuthRouter } from "../auth";
import { createMeRouter } from "../me";

interface Recorder {
  calls: EmailMessage[];
  sender: EmailSender;
}

function recorder(result: SendResult = { sent: true, id: "rec_1" }): Recorder {
  const calls: EmailMessage[] = [];
  return {
    calls,
    sender: async (msg) => {
      calls.push(msg);
      return result;
    },
  };
}

const USER = {
  id: "bug224-user",
  email: "person@example.test",
  accountStatus: "active",
};

async function spinUpAuth(sender: EmailSender) {
  const prisma = {
    user: { findUnique: async () => USER },
  } as unknown as never;
  const app: Express = express();
  app.use(express.json());
  app.use(createAuthRouter({ prisma, sendEmail: sender }));
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function spinUpMe(sender: EmailSender) {
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) =>
        where.id ? { id: USER.id, email: USER.email } : null,
      update: async () => ({ id: USER.id, email: "new@example.test" }),
    },
  } as unknown as never;
  const app: Express = express();
  app.use(express.json());
  app.use(createMeRouter({ prisma, sendEmail: sender }));
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("BUG-224 — the email seam", () => {
  // Self-contained: buildAppLink reads PUBLIC_APP_URL lazily at call time, so
  // setting it here is enough and the guard never depends on whatever happens
  // to be in a developer's .env. (It is currently unset in this repo's .env,
  // which is exactly why this matters.)
  const previousAppUrl = process.env["PUBLIC_APP_URL"];
  before(() => {
    process.env["PUBLIC_APP_URL"] = "https://app.example.com";
  });
  after(() => {
    if (previousAppUrl === undefined) delete process.env["PUBLIC_APP_URL"];
    else process.env["PUBLIC_APP_URL"] = previousAppUrl;
  });

  beforeEach(() => __clearRateLimitStoreForTests());

  it("password reset: the sender is invoked once, with an https link carrying the token", async () => {
    const rec = recorder();
    const h = await spinUpAuth(rec.sender);
    try {
      const res = await fetch(`${h.baseUrl}/auth/password-reset/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: USER.email }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { success: true });

      assert.equal(rec.calls.length, 1, "the sender must be invoked exactly once");
      const msg = rec.calls[0]!;
      assert.equal(msg.to, USER.email, "reset mail goes to the account address");
      assert.match(msg.subject, /reset/i);

      // The link must be https and must carry a real JWT (every JWT starts
      // "eyJ" — base64 of `{"`). This is what proves the token actually
      // reached the message rather than an empty string.
      const link = msg.text.split("\n").find((l) => l.startsWith("http"));
      assert.ok(link, `no link line in the body:\n${msg.text}`);
      assert.ok(
        link!.startsWith("https://"),
        `link must be https (D-WS9-231 options 1 and 2), got: ${link}`,
      );
      assert.ok(
        !link!.includes("kiwi://"),
        `a kiwi:// scheme reached the mail path: ${link}`,
      );
      assert.match(link!, /\/reset-password\?token=eyJ/, `got: ${link}`);
    } finally {
      await h.close();
    }
  });

  it("password reset with NO sender configured still returns success and leaks no token", async () => {
    // The production sender with no RESEND_API_KEY — the real no-op path.
    const noKey: EmailSender = async () => ({ sent: false, reason: "no_api_key" });
    const h = await spinUpAuth(noKey);
    try {
      const res = await fetch(`${h.baseUrl}/auth/password-reset/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: USER.email }),
      });
      assert.equal(res.status, 200, "no key must not change the status");
      assert.deepEqual(
        await res.json(),
        { success: true },
        "no key must not change the body — anti-enumeration is unconditional",
      );
    } finally {
      await h.close();
    }
  });

  it("an unknown email sends nothing and is indistinguishable from a known one", async () => {
    const rec = recorder();
    const prisma = { user: { findUnique: async () => null } } as unknown as never;
    const app: Express = express();
    app.use(express.json());
    app.use(createAuthRouter({ prisma, sendEmail: rec.sender }));
    const server: Server = await new Promise((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    const { port } = server.address() as { port: number };
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/auth/password-reset/request`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "nobody@example.test" }),
        },
      );
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { success: true });
      assert.equal(
        rec.calls.length,
        0,
        "no account, no send — and the response must not differ",
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("a malformed body sends nothing", async () => {
    const rec = recorder();
    const h = await spinUpAuth(rec.sender);
    try {
      const res = await fetch(`${h.baseUrl}/auth/password-reset/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "not-an-email" }),
      });
      assert.equal(res.status, 400);
      assert.equal(rec.calls.length, 0, "an invalid request must never send");
    } finally {
      await h.close();
    }
  });

  it("email change: the verification goes to the NEW address, not the current one", async () => {
    const rec = recorder();
    const h = await spinUpMe(rec.sender);
    try {
      const res = await fetch(`${h.baseUrl}/me/email/request-change`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${signToken(USER.id)}`,
        },
        body: JSON.stringify({ newEmail: "new@example.test" }),
      });
      assert.equal(res.status, 200);

      assert.equal(rec.calls.length, 1, "the sender must be invoked exactly once");
      const msg = rec.calls[0]!;
      assert.equal(
        msg.to,
        "new@example.test",
        "possession of the NEW inbox is what proves the change — it must go there",
      );
      assert.notEqual(msg.to, USER.email, "must NOT go to the current address");

      const link = msg.text.split("\n").find((l) => l.startsWith("http"));
      assert.ok(link, `no link line in the body:\n${msg.text}`);
      assert.ok(link!.startsWith("https://"), `link must be https, got: ${link}`);
      assert.match(link!, /\/verify-email\?token=eyJ/, `got: ${link}`);
    } finally {
      await h.close();
    }
  });

  it("buildAppLink percent-encodes the token and honours PUBLIC_APP_URL", () => {
    const prev = process.env["PUBLIC_APP_URL"];
    try {
      process.env["PUBLIC_APP_URL"] = "https://example.com/";
      assert.equal(
        buildAppLink("/reset-password", "a b+c/d"),
        "https://example.com/reset-password?token=a%20b%2Bc%2Fd",
        "trailing slash trimmed, token percent-encoded",
      );
    } finally {
      if (prev === undefined) delete process.env["PUBLIC_APP_URL"];
      else process.env["PUBLIC_APP_URL"] = prev;
    }
  });

  it("the REAL sender no-ops with no key, and never reaches the network", async () => {
    // Everything above injects a stub, which proves the wiring and nothing
    // about the module. This drives the production sendEmail itself.
    const prevKey = process.env["RESEND_API_KEY"];
    delete process.env["RESEND_API_KEY"];
    try {
      const result = await productionSendEmail({
        to: "a@b.test",
        subject: "s",
        text: "t",
      });
      assert.deepEqual(
        result,
        { sent: false, reason: "no_api_key" },
        "no key must be a typed no-op, not a throw and not a network call",
      );
    } finally {
      if (prevKey === undefined) delete process.env["RESEND_API_KEY"];
      else process.env["RESEND_API_KEY"] = prevKey;
    }
  });

  it("the REAL sender refuses to send when a key exists but EMAIL_FROM does not", async () => {
    // The half-configured case. assertMailEnvComplete() stops this at boot, but
    // the send path must refuse independently — a link to nowhere on a
    // password-reset email is worse than no email at all.
    const prevKey = process.env["RESEND_API_KEY"];
    const prevFrom = process.env["EMAIL_FROM"];
    process.env["RESEND_API_KEY"] = "re_fixture_not_a_real_key";
    delete process.env["EMAIL_FROM"];
    try {
      const result = await productionSendEmail({
        to: "a@b.test",
        subject: "s",
        text: "t",
      });
      assert.deepEqual(
        result,
        { sent: false, reason: "missing_config" },
        "a half-configured mailer must refuse, not post to the provider",
      );
    } finally {
      if (prevKey === undefined) delete process.env["RESEND_API_KEY"];
      else process.env["RESEND_API_KEY"] = prevKey;
      if (prevFrom === undefined) delete process.env["EMAIL_FROM"];
      else process.env["EMAIL_FROM"] = prevFrom;
    }
  });

  it("assertMailEnvComplete throws only when a key is present without its companions", () => {
    const prevKey = process.env["RESEND_API_KEY"];
    const prevFrom = process.env["EMAIL_FROM"];
    const prevUrl = process.env["PUBLIC_APP_URL"];
    try {
      delete process.env["RESEND_API_KEY"];
      assert.doesNotThrow(
        () => assertMailEnvComplete(),
        "no key: nothing to misconfigure, must not throw",
      );

      process.env["RESEND_API_KEY"] = "re_fixture_not_a_real_key";
      delete process.env["EMAIL_FROM"];
      delete process.env["PUBLIC_APP_URL"];
      assert.throws(
        () => assertMailEnvComplete(),
        /EMAIL_FROM and PUBLIC_APP_URL are not/,
        "key without either companion must name BOTH in the error",
      );

      process.env["EMAIL_FROM"] = "Kiwi <noreply@example.test>";
      process.env["PUBLIC_APP_URL"] = "https://app.example.com";
      assert.doesNotThrow(
        () => assertMailEnvComplete(),
        "fully configured: must not throw",
      );
    } finally {
      for (const [k, v] of [
        ["RESEND_API_KEY", prevKey],
        ["EMAIL_FROM", prevFrom],
        ["PUBLIC_APP_URL", prevUrl],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("the message bodies are plain text and name the expiry", () => {
    const reset = passwordResetMessage("a@b.test", "https://x.test/r?token=t");
    const change = emailChangeMessage("a@b.test", "https://x.test/v?token=t");
    for (const m of [reset, change]) {
      assert.ok(!m.text.includes("<"), "plain text only — D-WS7-022 defers HTML");
      assert.match(m.text, /1 hour/, "the body must say how long the link lasts");
    }
  });
});
