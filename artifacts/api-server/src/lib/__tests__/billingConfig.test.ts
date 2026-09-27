// Row 9 (1.1) · Stripe S1 Part A — the billing environment contract.
//
// Three things are defended here, and the third is the one that is new to this
// server:
//
//   1. THE OFF STATE IS REAL. Any of the five required variables missing means
//      billing is unavailable, the routes 503, and the boot line names WHICH
//      variables — because "Stripe is off" without the names sends whoever
//      reads that log into the console guessing.
//
//   2. NOTHING LEAKS. `STRIPE_SECRET_KEY` is a live key against money and
//      `STRIPE_WEBHOOK_SECRET` is what stops a stranger writing subscription
//      rows. Same assertion shape as oauthConfig.test.ts's: serialise every
//      logged object AND message and search for the values, rather than
//      checking a field list, which only catches the leak you thought of.
//
//   3. 🔴 ONE STATE REFUSES TO BOOT. Every other feature in this server
//      degrades when misconfigured. `BILLING_ENFORCED=true` with Stripe
//      unconfigured must not: it is a locked door with no key cut, for every
//      user, and a throw on Cloud Run rolls the traffic back to the previous
//      revision by itself. The test asserts the throw AND asserts the two
//      neighbouring states do NOT throw, because a boot check that is too eager
//      is the same outage in the other direction.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BillingEnforcedWithoutStripeError,
  DEFAULT_EARLY_PAY_BONUS_DAYS,
  ENV_BILLING_EARLY_PAY_BONUS_DAYS,
  ENV_BILLING_ENFORCED,
  ENV_BILLING_RETURN_URL_BASE,
  ENV_STRIPE_PRICE_ANNUAL,
  ENV_STRIPE_PRICE_MONTHLY,
  ENV_STRIPE_SECRET_KEY,
  ENV_STRIPE_WEBHOOK_SECRET,
  logBillingConfig,
  readBillingConfig,
  REQUIRED_STRIPE_VARS,
} from "../billing/config";

function recorder() {
  const lines: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  const push = (level: string) => (obj: object, msg: string) =>
    void lines.push({ level, obj: obj as Record<string, unknown>, msg });
  return {
    log: { info: push("info"), warn: push("warn"), error: push("error") },
    lines,
    at: (level: string) => lines.filter((l) => l.level === level),
    dump: () => JSON.stringify(lines),
  };
}

const SECRETS = {
  [ENV_STRIPE_SECRET_KEY]: "sk_test_51NotARealKeyAtAll000000",
  [ENV_STRIPE_WEBHOOK_SECRET]: "whsec_NotARealSigningSecret000",
  [ENV_STRIPE_PRICE_MONTHLY]: "price_MonthlyNotReal000",
  [ENV_STRIPE_PRICE_ANNUAL]: "price_AnnualNotReal000",
  [ENV_BILLING_RETURN_URL_BASE]: "https://app.kitchenwizard.ai",
};

/** A fully configured env, with `over` applied on top. `null` deletes a key. */
function env(over: Record<string, string | null> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...SECRETS };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

// ── reading ──────────────────────────────────────────────────────────────

describe("readBillingConfig", () => {
  it("a fully configured env is available, with no missing and no invalid", () => {
    const c = readBillingConfig(env());
    assert.equal(c.available, true);
    assert.deepEqual(c.missing, []);
    assert.deepEqual(c.invalid, []);
    assert.equal(c.enforced, false, "enforcement is OFF unless asked for");
    assert.equal(c.earlyPayBonusDays, DEFAULT_EARLY_PAY_BONUS_DAYS);
  });

  it("an empty env is unavailable and names ALL FIVE required variables", () => {
    const c = readBillingConfig({});
    assert.equal(c.available, false);
    assert.deepEqual(c.missing, [...REQUIRED_STRIPE_VARS]);
  });

  it("each required variable ALONE is enough to make billing unavailable", () => {
    for (const name of REQUIRED_STRIPE_VARS) {
      const c = readBillingConfig(env({ [name]: null }));
      assert.equal(c.available, false, `${name} unset should disable billing`);
      assert.deepEqual(c.missing, [name]);
    }
  });

  it("a blank or whitespace value counts as UNSET, not as a configured empty string", () => {
    assert.equal(readBillingConfig(env({ [ENV_STRIPE_SECRET_KEY]: "" })).available, false);
    assert.equal(readBillingConfig(env({ [ENV_STRIPE_SECRET_KEY]: "   " })).available, false);
  });

  it("trims the return base's trailing slashes so no call site has to", () => {
    for (const raw of ["https://a.example", "https://a.example/", "https://a.example///"]) {
      assert.equal(readBillingConfig(env({ [ENV_BILLING_RETURN_URL_BASE]: raw })).returnUrlBase, "https://a.example");
    }
  });

  it("BILLING_ENFORCED: truthy words on, falsy words off, garbage OFF and invalid", () => {
    for (const raw of ["1", "true", "yes", "on", "TRUE", " on "]) {
      assert.equal(readBillingConfig(env({ [ENV_BILLING_ENFORCED]: raw })).enforced, true, raw);
    }
    for (const raw of ["0", "false", "no", "off", ""]) {
      const c = readBillingConfig(env({ [ENV_BILLING_ENFORCED]: raw }));
      assert.equal(c.enforced, false, raw);
      assert.deepEqual(c.invalid, [], `${raw} is a falsy WORD, not garbage`);
    }
    // The direction a typo must fail in: off, and loudly.
    const c = readBillingConfig(env({ [ENV_BILLING_ENFORCED]: "ture" }));
    assert.equal(c.enforced, false, "a typo must never switch enforcement ON");
    assert.deepEqual(c.invalid, [ENV_BILLING_ENFORCED]);
  });

  it("BILLING_EARLY_PAY_BONUS_DAYS: 0 is VALID (no bonus), garbage falls back and is invalid", () => {
    assert.equal(readBillingConfig(env({ [ENV_BILLING_EARLY_PAY_BONUS_DAYS]: "7" })).earlyPayBonusDays, 7);
    // 0 ends the experiment without a deploy — it must not read as "unset".
    const zero = readBillingConfig(env({ [ENV_BILLING_EARLY_PAY_BONUS_DAYS]: "0" }));
    assert.equal(zero.earlyPayBonusDays, 0);
    assert.deepEqual(zero.invalid, []);
    for (const raw of ["-1", "abc", "7.5", "1e3x"]) {
      const c = readBillingConfig(env({ [ENV_BILLING_EARLY_PAY_BONUS_DAYS]: raw }));
      assert.equal(c.earlyPayBonusDays, DEFAULT_EARLY_PAY_BONUS_DAYS, raw);
      assert.deepEqual(c.invalid, [ENV_BILLING_EARLY_PAY_BONUS_DAYS], raw);
    }
  });
});

// ── the boot line ────────────────────────────────────────────────────────

describe("logBillingConfig", () => {
  it("configured + not enforced: one info line, no warn, no throw", () => {
    const r = recorder();
    const c = logBillingConfig(env(), r.log);
    assert.equal(c.available, true);
    assert.equal(r.at("info").length, 1);
    assert.equal(r.at("warn").length, 0);
    assert.equal(r.at("error").length, 0);
    assert.match(r.at("info")[0].msg, /stripe on/);
    assert.match(r.at("info")[0].msg, /enforcement off/);
  });

  it("unconfigured: warns, NAMES the missing variables, and still returns", () => {
    const r = recorder();
    const c = logBillingConfig({}, r.log);
    assert.equal(c.available, false);
    const warn = r.at("warn");
    assert.equal(warn.length, 1);
    for (const name of REQUIRED_STRIPE_VARS) {
      assert.ok(warn[0].msg.includes(name), `the warn must name ${name}`);
    }
    assert.match(warn[0].msg, /billing_unavailable/);
    assert.match(r.at("info")[0].msg, /stripe off/);
  });

  it("an unparseable variable logs an error naming it, and does not throw", () => {
    const r = recorder();
    logBillingConfig(env({ [ENV_BILLING_EARLY_PAY_BONUS_DAYS]: "two weeks" }), r.log);
    const errors = r.at("error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].obj.envVar, ENV_BILLING_EARLY_PAY_BONUS_DAYS);
  });

  // ── 🔴 the one state that refuses to boot ──────────────────────────────

  it("BILLING_ENFORCED with Stripe unconfigured THROWS a named error listing what is missing", () => {
    const r = recorder();
    assert.throws(
      () => logBillingConfig({ [ENV_BILLING_ENFORCED]: "true" }, r.log),
      (err: unknown) => {
        assert.ok(err instanceof BillingEnforcedWithoutStripeError);
        assert.equal(err.name, "BillingEnforcedWithoutStripeError");
        assert.deepEqual(err.missing, [...REQUIRED_STRIPE_VARS]);
        // The message has to be actionable on its own — it is the last line
        // in the log before the process dies.
        for (const name of REQUIRED_STRIPE_VARS) assert.ok(err.message.includes(name));
        return true;
      },
    );
    // The error was logged BEFORE the throw, so a log sink that never sees the
    // crash still sees the reason.
    assert.ok(r.at("error").some((l) => l.obj.event === "billing_enforced_without_stripe"));
  });

  it("enforcement on with ONE variable missing still throws, and names only that one", () => {
    assert.throws(
      () =>
        logBillingConfig(
          env({ [ENV_STRIPE_WEBHOOK_SECRET]: null, [ENV_BILLING_ENFORCED]: "1" }),
          recorder().log,
        ),
      (err: unknown) =>
        err instanceof BillingEnforcedWithoutStripeError &&
        err.missing.length === 1 &&
        err.missing[0] === ENV_STRIPE_WEBHOOK_SECRET,
    );
  });

  it("the two NEIGHBOURING states boot fine — an over-eager check is the same outage", () => {
    // Enforced AND configured: the real production target.
    const on = logBillingConfig(env({ [ENV_BILLING_ENFORCED]: "true" }), recorder().log);
    assert.equal(on.enforced, true);
    assert.equal(on.available, true);
    // Unconfigured and NOT enforced: today, and every deploy until Hans flips it.
    const off = logBillingConfig({}, recorder().log);
    assert.equal(off.enforced, false);
    assert.equal(off.available, false);
  });

  it("a BILLING_ENFORCED typo does not throw — it is off, and said so", () => {
    const r = recorder();
    const c = logBillingConfig({ [ENV_BILLING_ENFORCED]: "ture" }, r.log);
    assert.equal(c.enforced, false);
    assert.ok(r.at("error").some((l) => l.obj.envVar === ENV_BILLING_ENFORCED));
  });

  // ── nothing leaks ─────────────────────────────────────────────────────

  it("NO VALUE reaches the log — not the key, the webhook secret, the prices or the base", () => {
    const r = recorder();
    logBillingConfig(env({ [ENV_BILLING_ENFORCED]: "true" }), r.log);
    const dump = r.dump();
    for (const value of Object.values(SECRETS)) {
      assert.ok(
        !dump.includes(value),
        `a value leaked into the boot log: ${value.slice(0, 12)}…`,
      );
    }
  });

  it("the unconfigured warn leaks nothing either (it names variables, not values)", () => {
    const r = recorder();
    logBillingConfig(env({ [ENV_STRIPE_SECRET_KEY]: null }), r.log);
    const dump = r.dump();
    for (const value of Object.values(SECRETS)) {
      assert.ok(!dump.includes(value), `leaked: ${value.slice(0, 12)}…`);
    }
  });
});
