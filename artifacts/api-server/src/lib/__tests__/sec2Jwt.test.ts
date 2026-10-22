// SEC-2 #14 — the session JWT is HS256 and nothing else.
//
// jsonwebtoken already refuses `alg: none` and an asymmetric alg against a
// string secret. The pin adds the rest: an HS384/HS512 token signed with the
// right secret is refused, because this server never mints one.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

import { signToken, verifyToken } from "../auth";

const SECRET = process.env["JWT_SECRET"]!;
const claims = { userId: "u-jwt", purpose: "session" };

describe("SEC-2 #14 — verifyToken accepts HS256 only", () => {
  it("our own token verifies, and it is HS256", () => {
    const t = signToken("u-jwt");
    assert.equal(JSON.parse(Buffer.from(t.split(".")[0]!, "base64url").toString()).alg, "HS256");
    assert.equal(verifyToken(t, "session")?.userId, "u-jwt");
  });
  for (const alg of ["HS384", "HS512"] as const) {
    it(`a ${alg} token signed with the real secret is refused`, () => {
      assert.equal(verifyToken(jwt.sign(claims, SECRET, { algorithm: alg, expiresIn: "1h" }), "session"), null);
    });
  }
  it("alg:none is refused", () => {
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
    assert.equal(verifyToken(none, "session"), null);
  });
});
