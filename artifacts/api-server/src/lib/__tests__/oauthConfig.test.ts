// Row 9 (1.1) · OAuth Block 1 Part A — the environment contract and the
// refresh-token box.
//
// Two things are being defended here and they are different:
//
//   1. THE OFF STATE IS REAL. An unset audience list is not "permissive by
//      accident" — it is empty, and the route reads empty as 503. The boot
//      line has to say so, and it has to say so per PROVIDER, because Apple
//      configured and Google not is a state a real deploy will pass through.
//
//   2. NOTHING LEAKS. `APPLE_PRIVATE_KEY` is a live signing key and
//      `APPLE_REFRESH_TOKEN_ENC_KEY` decrypts every stored Apple refresh
//      token. `da8969b` established the pattern for this assertion (BUG-263's
//      "no env leakage" test); it is extended here to the two new secrets, by
//      serialising every logged object AND message and searching for the
//      values — not by checking a field list, which only catches the leak you
//      already thought of.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ENV_APPLE_KEY_ID,
  ENV_APPLE_OAUTH_AUDIENCES,
  ENV_APPLE_PRIVATE_KEY,
  ENV_APPLE_REFRESH_TOKEN_ENC_KEY,
  ENV_APPLE_TEAM_ID,
  ENV_GOOGLE_OAUTH_CLIENT_IDS,
  logOAuthConfig,
  missingAppleSigningVars,
  normalizePrivateKey,
  parseAudienceList,
  readOAuthConfig,
} from "../oauth/config";
import { decryptSecret, encryptSecret, SecretBoxError } from "../oauth/secretBox";

function recorder() {
  const lines: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  const push = (level: string) => (obj: object, msg: string) =>
    void lines.push({ level, obj: obj as Record<string, unknown>, msg });
  return {
    log: { info: push("info"), warn: push("warn"), error: push("error") },
    lines,
    at: (level: string) => lines.filter((l) => l.level === level),
    /** Everything this call would have written, as one string. */
    dump: () => JSON.stringify(lines),
  };
}

// ── parsing ──────────────────────────────────────────────────────────────

describe("parseAudienceList", () => {
  it("splits, trims and drops blanks; unset and blank are both []", () => {
    assert.deepEqual(parseAudienceList("a,b ,, c "), ["a", "b", "c"]);
    assert.deepEqual(parseAudienceList(undefined), []);
    assert.deepEqual(parseAudienceList("   "), []);
    assert.deepEqual(parseAudienceList(",,,"), []);
  });

  it("PRESERVES case — a bundle id is matched byte-for-byte against `aud`", () => {
    // The sibling parseEmailAllowlist() in googleOidc.ts lower-cases, because
    // its values are email addresses. Doing that here would make a mixed-case
    // Services ID unverifiable and the failure would look like a bad token.
    assert.deepEqual(parseAudienceList("com.KitchenWizard.Kiwi"), ["com.KitchenWizard.Kiwi"]);
  });
});

describe("normalizePrivateKey", () => {
  it("unescapes a one-line PEM, leaves a real multi-line one alone, null stays null", () => {
    assert.equal(
      normalizePrivateKey("-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----"),
      "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    );
    const real = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    assert.equal(normalizePrivateKey(real), real);
    assert.equal(normalizePrivateKey(null), null);
  });
});

// ── readOAuthConfig ──────────────────────────────────────────────────────

describe("readOAuthConfig", () => {
  it("all unset → both providers off, no signing, no enc secret", () => {
    const c = readOAuthConfig({});
    assert.deepEqual(c.appleAudiences, []);
    assert.deepEqual(c.googleClientIds, []);
    assert.equal(c.appleSigning, null);
    assert.equal(c.appleRefreshEncSecret, null);
  });

  it("the Apple signing trio is ALL THREE OR NOTHING", () => {
    const two = readOAuthConfig({
      [ENV_APPLE_TEAM_ID]: "TEAM1",
      [ENV_APPLE_KEY_ID]: "KEY1",
    });
    assert.equal(two.appleSigning, null, "two of three is not configured");
    assert.deepEqual(missingAppleSigningVars({ [ENV_APPLE_TEAM_ID]: "TEAM1", [ENV_APPLE_KEY_ID]: "KEY1" }), [
      ENV_APPLE_PRIVATE_KEY,
    ]);

    const all = readOAuthConfig({
      [ENV_APPLE_TEAM_ID]: "TEAM1",
      [ENV_APPLE_KEY_ID]: "KEY1",
      [ENV_APPLE_PRIVATE_KEY]: "-----BEGIN PRIVATE KEY-----\\nk\\n-----END PRIVATE KEY-----",
    });
    assert.deepEqual(all.appleSigning, {
      teamId: "TEAM1",
      keyId: "KEY1",
      privateKey: "-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----",
    });
  });

  it("a variable set to whitespace is unset, not a value", () => {
    const c = readOAuthConfig({
      [ENV_APPLE_TEAM_ID]: "  ",
      [ENV_APPLE_REFRESH_TOKEN_ENC_KEY]: "   ",
      [ENV_APPLE_OAUTH_AUDIENCES]: "  ",
    });
    assert.equal(c.appleSigning, null);
    assert.equal(c.appleRefreshEncSecret, null);
    assert.deepEqual(c.appleAudiences, []);
  });
});

// ── the boot line ────────────────────────────────────────────────────────

describe("logOAuthConfig (BUG-263 posture)", () => {
  it("all unset → a warn per provider, one info summary, nothing fatal", () => {
    const r = recorder();
    const c = logOAuthConfig({}, r.log);
    assert.equal(r.at("warn").length, 2);
    assert.deepEqual(
      r.at("warn").map((l) => l.obj.provider),
      ["apple", "google"],
    );
    assert.equal(r.at("error").length, 0, "an unconfigured feature is not an error");
    const info = r.at("info");
    assert.equal(info.length, 1);
    assert.equal(info[0].obj.apple, "disabled");
    assert.equal(info[0].obj.google, "disabled");
    assert.equal(info[0].obj.appleRevocation, "disabled");
    assert.match(info[0].msg, /apple off · google off · apple revocation off/);
    assert.deepEqual(c.appleAudiences, []);
  });

  it("one provider on, the other off — the two are independent", () => {
    const r = recorder();
    logOAuthConfig({ [ENV_GOOGLE_OAUTH_CLIENT_IDS]: "web.apps.googleusercontent.com" }, r.log);
    const warns = r.at("warn");
    assert.equal(warns.length, 1);
    assert.equal(warns[0].obj.provider, "apple");
    assert.deepEqual(warns[0].obj.vars, [ENV_APPLE_OAUTH_AUDIENCES]);
    assert.equal(r.at("info")[0].obj.google, "configured");
    assert.equal(r.at("info")[0].obj.googleClientIdCount, 1);
  });

  it("🔴 Apple ON with no signing trio → ERROR naming 5.1.1(v) and the missing vars", () => {
    const r = recorder();
    logOAuthConfig({ [ENV_APPLE_OAUTH_AUDIENCES]: "com.kitchenwizard.kiwi" }, r.log);
    const errs = r.at("error");
    assert.equal(errs.length, 1);
    assert.equal(errs[0].obj.event, "oauth_apple_revocation_unavailable");
    assert.deepEqual(errs[0].obj.vars, [ENV_APPLE_TEAM_ID, ENV_APPLE_KEY_ID, ENV_APPLE_PRIVATE_KEY]);
    assert.match(errs[0].msg, /5\.1\.1\(v\)/);
    // …and sign-in is still ON. The revocation gap must not disable the route.
    assert.equal(r.at("info")[0].obj.apple, "configured");
  });

  it("🔴 Apple ON, trio set, enc key missing → ERROR: nothing to revoke later", () => {
    const r = recorder();
    logOAuthConfig(
      {
        [ENV_APPLE_OAUTH_AUDIENCES]: "com.kitchenwizard.kiwi",
        [ENV_APPLE_TEAM_ID]: "TEAM1",
        [ENV_APPLE_KEY_ID]: "KEY1",
        [ENV_APPLE_PRIVATE_KEY]: "pem",
      },
      r.log,
    );
    const errs = r.at("error");
    assert.equal(errs.length, 1);
    assert.equal(errs[0].obj.event, "oauth_apple_refresh_storage_unavailable");
    assert.deepEqual(errs[0].obj.vars, [ENV_APPLE_REFRESH_TOKEN_ENC_KEY]);
    assert.equal(r.at("info")[0].obj.appleRevocation, "disabled");
  });

  it("fully configured → no warn, no error, revocation on", () => {
    const r = recorder();
    logOAuthConfig(
      {
        [ENV_APPLE_OAUTH_AUDIENCES]: "com.kitchenwizard.kiwi,com.kitchenwizard.kiwi.web",
        [ENV_GOOGLE_OAUTH_CLIENT_IDS]: "a,b,c",
        [ENV_APPLE_TEAM_ID]: "TEAM1",
        [ENV_APPLE_KEY_ID]: "KEY1",
        [ENV_APPLE_PRIVATE_KEY]: "pem",
        [ENV_APPLE_REFRESH_TOKEN_ENC_KEY]: "s3cret",
      },
      r.log,
    );
    assert.equal(r.at("warn").length, 0);
    assert.equal(r.at("error").length, 0);
    const info = r.at("info")[0];
    assert.equal(info.obj.appleAudienceCount, 2);
    assert.equal(info.obj.googleClientIdCount, 3);
    assert.equal(info.obj.appleRevocation, "configured");
    assert.match(info.msg, /apple on · google on · apple revocation on/);
  });

  it("🔴 NO ENV LEAKAGE — no value reaches any log line, at any level", () => {
    // da8969b's pattern. The assertion is over the SERIALISED output, message
    // included, so a value smuggled into a template string is caught too.
    const SECRETS = {
      [ENV_APPLE_PRIVATE_KEY]: "-----BEGIN PRIVATE KEY-----\\nSUPERSECRETKEYMATERIAL\\n-----END PRIVATE KEY-----",
      [ENV_APPLE_REFRESH_TOKEN_ENC_KEY]: "ENCSECRET-do-not-log-me",
      [ENV_APPLE_TEAM_ID]: "TEAMIDVALUE",
      [ENV_APPLE_KEY_ID]: "KEYIDVALUE",
      [ENV_APPLE_OAUTH_AUDIENCES]: "com.audience.value",
      [ENV_GOOGLE_OAUTH_CLIENT_IDS]: "client-id-value.apps.googleusercontent.com",
    };
    const r = recorder();
    logOAuthConfig(SECRETS, r.log);
    const dump = r.dump();
    for (const value of Object.values(SECRETS)) {
      assert.ok(!dump.includes(value), `a value leaked into the boot log: ${value.slice(0, 12)}…`);
    }
    // The NAMES are expected to be there — that is the whole point of the line.
    assert.ok(dump.includes(ENV_APPLE_OAUTH_AUDIENCES) || r.at("warn").length === 0);
  });
});

// ── the refresh-token box ────────────────────────────────────────────────

describe("secretBox (AES-256-GCM)", () => {
  const KEY = "an-env-secret-of-arbitrary-length";
  const TOKEN = "r.AdYAB1.apple-refresh-token-value";

  it("round-trips, and the blob reveals nothing of the plaintext", () => {
    const blob = encryptSecret(TOKEN, KEY);
    assert.match(blob, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.ok(!blob.includes(TOKEN));
    assert.ok(!blob.includes(KEY));
    assert.equal(decryptSecret(blob, KEY), TOKEN);
  });

  it("the IV is fresh every time — the same input twice gives two blobs", () => {
    const a = encryptSecret(TOKEN, KEY);
    const b = encryptSecret(TOKEN, KEY);
    assert.notEqual(a, b, "a deterministic ciphertext leaks equality of plaintexts");
    assert.equal(decryptSecret(a, KEY), decryptSecret(b, KEY));
  });

  it("a wrong key is refused by the GCM tag, not returned as garbage", () => {
    const blob = encryptSecret(TOKEN, KEY);
    assert.throws(() => decryptSecret(blob, "a-different-secret"), SecretBoxError);
  });

  it("tampering with any part is refused", () => {
    const [v, iv, tag, ct] = encryptSecret(TOKEN, KEY).split(".");
    const flip = (s: string) => (s[0] === "A" ? `B${s.slice(1)}` : `A${s.slice(1)}`);
    assert.throws(() => decryptSecret([v, flip(iv!), tag, ct].join("."), KEY), SecretBoxError);
    assert.throws(() => decryptSecret([v, iv, flip(tag!), ct].join("."), KEY), SecretBoxError);
    assert.throws(() => decryptSecret([v, iv, tag, flip(ct!)].join("."), KEY), SecretBoxError);
  });

  it("an unversioned, short or future blob is refused by shape", () => {
    assert.throws(() => decryptSecret("", KEY), SecretBoxError);
    assert.throws(() => decryptSecret("not-a-blob", KEY), SecretBoxError);
    assert.throws(() => decryptSecret("v2.a.b.c", KEY), SecretBoxError);
    assert.throws(() => decryptSecret("v1.a.b", KEY), SecretBoxError);
  });

  it("an empty secret is refused rather than silently deriving a key", () => {
    assert.throws(() => encryptSecret(TOKEN, "   "), SecretBoxError);
  });

  it("a long unicode token survives the round trip", () => {
    const weird = "üñí—🌱".repeat(200);
    assert.equal(decryptSecret(encryptSecret(weird, KEY), KEY), weird);
  });
});
