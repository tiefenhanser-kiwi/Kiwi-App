// R3-0 — the data scripts' database guard. The production arm must be
// impossible to satisfy by accident: exact hostname, typed by the operator.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertScriptDatabase } from "../scripts/requireDatabaseHost";

const DEV_URL = "postgresql://dev_user:devsecret@ep-broad-haze-a1b2c3-pooler.us-east-2.aws.neon.tech/neondb";
const PROD_HOST = "ep-quiet-river-z9y8x7-pooler.us-east-2.aws.neon.tech";
const PROD_URL = `postgresql://prod_user:prodsecret@${PROD_HOST}/neondb`;

function run(env: NodeJS.ProcessEnv) {
  const lines: string[] = [];
  try {
    return { result: assertScriptDatabase("test", env, (l) => lines.push(l)), lines, error: null };
  } catch (e) {
    return { result: null, lines, error: e as Error };
  }
}

describe("assertScriptDatabase", () => {
  it("dev host passes with no override, silently", () => {
    const r = run({ DATABASE_URL: DEV_URL });
    assert.equal(r.error, null);
    assert.deepEqual(r.result, { host: "ep-broad-haze-a1b2c3-pooler.us-east-2.aws.neon.tech", mode: "dev" });
    assert.deepEqual(r.lines, []);
  });

  it("production host with no override throws", () => {
    const r = run({ DATABASE_URL: PROD_URL });
    assert.ok(r.error);
    assert.match(r.error.message, /^refusing: DATABASE_URL host ".*" is not the dev branch and KIWI_PRODUCTION_HOST does not name it$/);
    assert.ok(r.error.message.includes(PROD_HOST));
  });

  it("production host with a mismatched override throws, naming both hostnames", () => {
    const r = run({ DATABASE_URL: PROD_URL, KIWI_PRODUCTION_HOST: "ep-other-host.us-east-2.aws.neon.tech" });
    assert.ok(r.error);
    assert.ok(r.error.message.includes(`"${PROD_HOST}"`));
    assert.ok(r.error.message.includes(`"ep-other-host.us-east-2.aws.neon.tech"`));
  });

  it("production host with the exact override passes, mode production, one stderr line", () => {
    const r = run({ DATABASE_URL: PROD_URL, KIWI_PRODUCTION_HOST: PROD_HOST });
    assert.equal(r.error, null);
    assert.deepEqual(r.result, { host: PROD_HOST, mode: "production" });
    assert.deepEqual(r.lines, [`test: PRODUCTION host ${PROD_HOST} (KIWI_PRODUCTION_HOST matched)`]);
  });

  it("a sub-string of the host is not the host", () => {
    const r = run({ DATABASE_URL: PROD_URL, KIWI_PRODUCTION_HOST: "ep-quiet-river" });
    assert.ok(r.error);
    assert.equal(r.result, null);
  });

  it("a case difference is not the host", () => {
    const r = run({ DATABASE_URL: PROD_URL, KIWI_PRODUCTION_HOST: PROD_HOST.toUpperCase() });
    assert.ok(r.error);
    assert.equal(r.result, null);
  });

  it("an empty override is no override", () => {
    const r = run({ DATABASE_URL: PROD_URL, KIWI_PRODUCTION_HOST: "" });
    assert.ok(r.error);
    assert.ok(!r.error.message.includes("KIWI_PRODUCTION_HOST is"));
  });

  it("an override pasted as a URL is refused and never echoed", () => {
    const r = run({ DATABASE_URL: PROD_URL, KIWI_PRODUCTION_HOST: PROD_URL });
    assert.ok(r.error);
    assert.ok(!r.error.message.includes("prodsecret"));
    assert.ok(!r.error.message.includes("prod_user"));
  });

  it("no DATABASE_URL throws, and no message ever carries credentials", () => {
    const r = run({});
    assert.ok(r.error);
    for (const env of [{ DATABASE_URL: PROD_URL }, { DATABASE_URL: PROD_URL, KIWI_PRODUCTION_HOST: "x.example" }]) {
      const m = run(env).error?.message ?? "";
      assert.ok(!m.includes("prodsecret") && !m.includes("prod_user"), m);
    }
  });
});
