// SEC-2 #16 — one free trial per person (Hans, October 21: "if I sign up for
// 2 weeks with hans.tiefenthaler@gmail.com and then sign up with
// hans.tiefenthaler+1@gmail.com and so on").
//
//   · canonicalEmail: lower-case, "+tag" off, gmail/googlemail dots off and
//     domain unified — the same rule the migration's backfill runs in SQL;
//   · a signup (password or OAuth — both go through createAccountInTx) whose
//     canonical email another account already holds is CREATED, but starts
//     with no trial: status `none`, no trialEndsAt, trialDeniedReason set;
//   · TRIAL_DUPLICATE_EXEMPT (default kitchenwizard.ai) keeps the team's own
//     aliases on trials; an address entry exempts its aliases too;
//   · the 402 reason and the wire say why, and never name the other account;
//   · a verified email change moves the canonical form with the address.

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { createAccountInTx } from "../../lib/authAccount";
import { canonicalEmail, isTrialDuplicateExempt, readTrialDuplicateExempt } from "../../lib/emailCanonical";
import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import { createSubscriptionService } from "../../lib/subscriptionService";
import { createAuthRouter } from "../auth";
import { createMeRouter } from "../me";
import { makeUsedTokenLedger } from "./fixtures/sessionUserStub";

describe("SEC-2 #16 — canonicalEmail", () => {
  const cases: Array<[string, string]> = [
    ["Hans.Tiefenthaler@Gmail.com", "hanstiefenthaler@gmail.com"],
    ["hans.tiefenthaler+1@gmail.com", "hanstiefenthaler@gmail.com"],
    ["h.a.n.s+x+y@googlemail.com", "hans@gmail.com"],
    ["  Mixed.Case+tag@Example.COM ", "mixed.case@example.com"],
    ["first.last@gmail.co", "first.last@gmail.co"],
    ["+onlytag@example.com", "+onlytag@example.com"],
    ["...@gmail.com", "...@gmail.com"],
    ["a@b@c.com", "a@b@c.com"],
    ["no-at-sign", "no-at-sign"],
  ];
  for (const [input, want] of cases) it(`${JSON.stringify(input)} → ${want}`, () => assert.equal(canonicalEmail(input), want));

  it("exemptions: a domain covers its subdomains; an address covers its aliases; unset is kitchenwizard.ai; empty is nobody", () => {
    assert.deepEqual(readTrialDuplicateExempt({}), ["kitchenwizard.ai"]);
    assert.deepEqual(readTrialDuplicateExempt({ TRIAL_DUPLICATE_EXEMPT: "" }), []);
    const def = readTrialDuplicateExempt({});
    assert.equal(isTrialDuplicateExempt("hans+3@kitchenwizard.ai", def), true);
    assert.equal(isTrialDuplicateExempt("x@qa.kitchenwizard.ai", def), true);
    assert.equal(isTrialDuplicateExempt("x@notkitchenwizard.ai", def), false);
    const addr = readTrialDuplicateExempt({ TRIAL_DUPLICATE_EXEMPT: "Hans.Tiefenthaler@gmail.com, example.org" });
    assert.equal(isTrialDuplicateExempt("hanstiefenthaler+7@gmail.com", addr), true);
    assert.equal(isTrialDuplicateExempt("someone.else@gmail.com", addr), false);
    assert.equal(isTrialDuplicateExempt("a@example.org", addr), true);
  });
});

// ── a users table that knows emailCanonical ──────────────────────────────
interface Row {
  id: string;
  email: string;
  emailCanonical: string | null;
  [k: string]: unknown;
}
function makeTables() {
  const users: Row[] = [];
  const subs: Array<Record<string, unknown>> = [];
  const user = {
    findFirst: async ({ where }: { where: { emailCanonical: string } }) =>
      users.find((u) => u.emailCanonical === where.emailCanonical) ? { id: "someone" } : null,
    findUnique: async ({ where, include }: { where: { id?: string; email?: string }; include?: { subscription?: boolean } }) => {
      const u = users.find((r) => (where.id ? r.id === where.id : r.email === where.email));
      if (!u) return null;
      return include?.subscription ? { ...u, subscription: subs.find((s) => s["userId"] === u.id) ?? null } : u;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: `u-${users.length + 1}`,
        phone: null,
        zipCode: null,
        timezone: "America/New_York",
        accountStatus: "active",
        subscriptionStatus: "trialing",
        defaultHouseholdSize: 2,
        lastPlanDiscoveryFilters: [],
        lastPlansFilters: [],
        lastMealsFilters: [],
        marketingConsentEmail: false,
        marketingConsentSms: false,
        onboardingComplete: false,
        firstRunChoiceMade: false,
        signupSource: null,
        personalizeNudgeDismissedAt: null,
        tokensValidFrom: null,
        createdAt: new Date(),
        ...data,
      } as unknown as Row;
      users.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const u = users.find((r) => r.id === where.id)!;
      Object.assign(u, data);
      return u;
    },
  };
  const subscription = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { currentPeriodEnd: null, trialDeniedReason: null, ...data };
      subs.push(row);
      return row;
    },
  };
  const prisma = { user, subscription, usedToken: makeUsedTokenLedger(), $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma) };
  return { prisma, users, subs };
}

describe("SEC-2 #16 — a second account on the same inbox starts without a trial", () => {
  let server: Server;
  let base = "";
  let t: ReturnType<typeof makeTables>;
  const saved = process.env["TRIAL_DUPLICATE_EXEMPT"];

  before(async () => {
    t = makeTables();
    const app: Express = express();
    app.use(express.json());
    app.use(createAuthRouter({ prisma: t.prisma as never, signupAlert: async () => {}, welcomeEmail: async () => {} }));
    app.use(createMeRouter({ prisma: t.prisma as never, sendEmail: (async () => ({ sent: true, id: "x" })) as never }));
    server = await new Promise((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => {
    if (saved === undefined) delete process.env["TRIAL_DUPLICATE_EXEMPT"];
    else process.env["TRIAL_DUPLICATE_EXEMPT"] = saved;
    await new Promise<void>((r) => server.close(() => r()));
  });
  afterEach(() => __clearRateLimitStoreForTests());

  const signup = async (email: string) => {
    __clearRateLimitStoreForTests();
    const res = await fetch(`${base}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "a-password-1", firstName: "T", lastName: "R" }),
    });
    return { status: res.status, body: (await res.json()) as { user: { subscription: Record<string, unknown> } } };
  };

  it("the first account gets the trial; +1 and dotted aliases get an account and no trial", async () => {
    delete process.env["TRIAL_DUPLICATE_EXEMPT"];
    const first = await signup("hans.tiefenthaler@gmail.com");
    assert.equal(first.status, 201);
    assert.equal(first.body.user.subscription["status"], "trialing");
    assert.ok(first.body.user.subscription["trialEndsAt"]);
    assert.equal(first.body.user.subscription["trialDeniedReason"], null);

    for (const alias of ["hans.tiefenthaler+1@gmail.com", "HansTiefenthaler@googlemail.com"]) {
      const again = await signup(alias);
      assert.equal(again.status, 201, "the account is created");
      assert.equal(again.body.user.subscription["status"], "none");
      assert.equal(again.body.user.subscription["trialEndsAt"], null);
      assert.equal(again.body.user.subscription["trialDeniedReason"], "trial_already_used");
      assert.doesNotMatch(JSON.stringify(again.body), /u-1|hans\.tiefenthaler@gmail\.com/, "never names the other account");
    }
    assert.deepEqual(t.users.map((u) => u.emailCanonical), Array(3).fill("hanstiefenthaler@gmail.com"));
  });

  it("the team's domain is exempt by default; an exempted address exempts its aliases", async () => {
    delete process.env["TRIAL_DUPLICATE_EXEMPT"];
    assert.equal((await signup("qa@kitchenwizard.ai")).body.user.subscription["status"], "trialing");
    assert.equal((await signup("qa+2@kitchenwizard.ai")).body.user.subscription["status"], "trialing");
    process.env["TRIAL_DUPLICATE_EXEMPT"] = "tester@example.com";
    assert.equal((await signup("tester@example.com")).body.user.subscription["status"], "trialing");
    assert.equal((await signup("tester+9@example.com")).body.user.subscription["status"], "trialing");
    // …and the default domain is no longer exempt once the list is replaced.
    assert.equal((await signup("qa+3@kitchenwizard.ai")).body.user.subscription["status"], "none");
  });

  it("a verified email change carries the canonical form with it", async () => {
    const id = t.users[0]!.id;
    const link = signToken(id, { purpose: "email_change", expiresIn: "1h", extra: { newEmail: "New.Person+x@Gmail.com" } });
    const res = await fetch(`${base}/me/email/verify-change`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: link }),
    });
    assert.equal(res.status, 200);
    assert.equal(t.users[0]!.emailCanonical, "newperson@gmail.com");
  });
});

describe("SEC-2 #16 — the OAuth lane shares the rule (createAccountInTx)", () => {
  it("a new OAuth account on an inbox that had a trial starts without one", async () => {
    const t = makeTables();
    const mk = (email: string) =>
      createAccountInTx({ tx: t.prisma as never, email, passwordHash: null, firstName: "", lastName: "", signupSource: null, via: "oauth_google", env: {} });
    assert.equal((await mk("someone@gmail.com")).subscription.status, "trialing");
    const dup = await mk("some.one+apple@gmail.com");
    assert.equal(dup.subscription.status, "none");
    assert.equal((dup.subscription as { trialDeniedReason?: string }).trialDeniedReason, "trial_already_used");
  });
});

describe("SEC-2 #16 — the 402 says why", () => {
  it("an enforced deploy refuses a trial-denied account with the trial-used reason", async () => {
    const svc = createSubscriptionService({
      prisma: {
        subscription: {
          findUnique: async () => ({
            status: "none",
            planCode: "free",
            trialEndsAt: null,
            currentPeriodEnd: null,
            cancelAtPeriodEnd: false,
            stripeCustomerId: null,
            stripeSubscriptionId: null,
            source: null,
            storeManagementUrl: null,
            trialDeniedReason: "trial_already_used",
          }),
        },
      } as never,
      readConfig: () => ({ enforced: true }) as never,
    });
    const verdict = await svc.can("u-x", "kitchen_wizard_set_preferences");
    assert.equal(verdict.allowed, false);
    assert.match(String((verdict as { reason?: string }).reason), /Your free trial was already used with this email\./);
  });
});
