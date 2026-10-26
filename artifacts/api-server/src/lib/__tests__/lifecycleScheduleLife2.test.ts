// LIFE-2 — the eight event-driven lifecycle emails, by clock. Pure: no database, no sender.
//
// One table row per kind, and every row runs the same six checks: due inside
// its window · not due before it · skipped by its rule · not due after the
// window · held by the weekly cap · held by quiet hours. Then the two changes
// to the live six (day3, day5), the cap's "wait, and the window decides",
// next_week's per-plan key, and the priority order.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  WEEKLY_CAP,
  currentPlan,
  dueKinds,
  formatPlanEndDay,
  morningAfter,
  refIdFor,
  sendKey,
  zonedTime,
  type LifecycleFacts,
  type LifecycleKind,
} from "../lifecycle/schedule";

const H = 60 * 60 * 1000;
const D = 24 * H;
const t = (iso: string) => new Date(iso);
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

// Tuesday 2026-10-20 12:00 EDT (16:00Z): an event inside sending hours.
const EVENT = t("2026-10-20T16:00:00Z");

/** An account three weeks old, its day emails long gone, its free time ending far ahead. */
function facts(over: Partial<LifecycleFacts> = {}): LifecycleFacts {
  return {
    createdAt: t("2026-10-01T15:00:00Z"),
    timezone: "America/New_York",
    optedOut: false,
    hasPlan: true,
    freeTimeEndsAt: t("2026-12-31T17:00:00Z"),
    paying: false,
    billingEnforced: true,
    sent: new Set(["welcome", "day1", "day3", "day5"]),
    capClaims: [],
    firstPlanAt: null,
    secondPlanAt: null,
    datedPlans: [],
    firstListAt: null,
    secondListAt: null,
    sentToInstacart: false,
    firstPrepAt: null,
    firstCookFinishedAt: null,
    hasPlaylist: false,
    lastActiveAt: null,
    ...over,
  };
}

interface Row {
  kind: LifecycleKind;
  /** The facts that make the kind apply. */
  base: Partial<LifecycleFacts>;
  /** Inside the window, in sending hours. */
  due: Date;
  /** Before the window opens, in sending hours. */
  before: Date;
  /** After the window closes, in sending hours. */
  after: Date;
  /** Facts that trigger the skip rule (each one alone). */
  skips: Array<[string, Partial<LifecycleFacts>]>;
  /** Inside the window, in quiet hours (America/New_York). */
  quiet: Date;
}

const WEEK_PLAN = { id: "plan-oct18", firstDay: "2026-10-18", lastDay: "2026-10-24" }; // Sun–Sat
const COOKED = t("2026-10-20T23:30:00Z"); // Tue 19:30 EDT

const ROWS: Row[] = [
  {
    kind: "list_nudge",
    base: { firstPlanAt: EVENT },
    due: plus(EVENT, 24 * H), // Wed 12:00 EDT
    before: plus(EVENT, 23 * H),
    after: plus(EVENT, 48 * H),
    skips: [["a grocery list exists", { firstListAt: plus(EVENT, 2 * H) }]],
    quiet: plus(EVENT, 34 * H), // Wed 22:00 EDT
  },
  {
    kind: "prep_nudge",
    base: { firstPlanAt: plus(EVENT, -D * 3), firstListAt: EVENT },
    due: plus(EVENT, 24 * H),
    before: plus(EVENT, 23 * H),
    after: plus(EVENT, 48 * H),
    skips: [
      ["a prep session has started", { firstPrepAt: plus(EVENT, 3 * H) }],
      ["a cook session has finished", { firstCookFinishedAt: plus(EVENT, 3 * H) }],
    ],
    quiet: plus(EVENT, 34 * H),
  },
  {
    kind: "first_cook",
    base: { firstCookFinishedAt: COOKED },
    due: t("2026-10-21T12:00:00Z"), // Wed 08:00 EDT, the morning after
    before: plus(COOKED, 1 * H), // Tue 20:30 EDT, the same evening
    after: t("2026-10-22T12:00:00Z"),
    skips: [],
    quiet: t("2026-10-22T02:00:00Z"), // Wed 22:00 EDT
  },
  {
    kind: "next_week",
    base: { datedPlans: [WEEK_PLAN] },
    due: t("2026-10-22T13:00:00Z"), // Thu 09:00 EDT, two days before Saturday
    before: t("2026-10-21T20:00:00Z"), // Wed 16:00 EDT
    after: t("2026-10-25T14:00:00Z"), // Sun: the plan no longer covers today
    skips: [["a later plan exists", { datedPlans: [WEEK_PLAN, { id: "plan-oct25", firstDay: "2026-10-25", lastDay: "2026-10-31" }] }]],
    quiet: t("2026-10-23T02:00:00Z"), // Thu 22:00 EDT
  },
  {
    kind: "playlist_nudge",
    base: { firstPlanAt: plus(EVENT, -7 * D), secondPlanAt: EVENT },
    due: plus(EVENT, 1 * H),
    before: plus(EVENT, -1 * H),
    after: plus(EVENT, 48 * H),
    skips: [["a Playlist exists", { hasPlaylist: true }]],
    quiet: plus(EVENT, 10 * H),
  },
  {
    kind: "instacart_nudge",
    base: { firstListAt: plus(EVENT, -7 * D), secondListAt: EVENT, firstPrepAt: plus(EVENT, -6 * D) },
    due: plus(EVENT, 1 * H),
    before: plus(EVENT, -1 * H),
    after: plus(EVENT, 48 * H),
    skips: [["a list already went to Instacart", { sentToInstacart: true }]],
    quiet: plus(EVENT, 10 * H),
  },
  {
    kind: "still_here",
    base: { lastActiveAt: plus(EVENT, -7 * D) },
    due: plus(EVENT, 1 * H),
    before: plus(EVENT, -1 * H),
    after: plus(EVENT, 48 * H),
    skips: [
      ["active since (the anchor moved)", { lastActiveAt: plus(EVENT, -2 * D) }],
      ["the free time has ended", { freeTimeEndsAt: plus(EVENT, -1 * H) }],
      ["no free time (not trialing)", { freeTimeEndsAt: null }],
      ["paying", { paying: true }],
    ],
    quiet: plus(EVENT, 10 * H),
  },
  {
    kind: "come_back",
    base: { freeTimeEndsAt: plus(EVENT, -10 * D) },
    due: plus(EVENT, 1 * H),
    before: plus(EVENT, -1 * H),
    after: plus(EVENT, 7 * D),
    skips: [
      ["paying (subscribed)", { paying: true }],
      ["billing not enforced (nobody's free time ended)", { billingEnforced: false }],
    ],
    quiet: plus(EVENT, 10 * H),
  },
];

describe("LIFE-2 schedule — each kind's table", () => {
  for (const r of ROWS) {
    describe(r.kind, () => {
      const f = facts(r.base);

      it("due inside its window", () => {
        assert.deepEqual(dueKinds(f, r.due), [r.kind]);
      });

      it("not due before the window opens", () => {
        assert.ok(!dueKinds(f, r.before).includes(r.kind));
      });

      it("not due once the window has closed", () => {
        assert.ok(!dueKinds(f, r.after).includes(r.kind));
      });

      for (const [why, over] of r.skips) {
        it(`🔴 skipped: ${why}`, () => {
          assert.ok(!dueKinds(facts({ ...r.base, ...over }), r.due).includes(r.kind));
        });
      }

      it("🔴 not due once sent (the send log)", () => {
        const sent = new Set([...f.sent, sendKey(r.kind, refIdFor(r.kind, f, r.due))]);
        assert.deepEqual(dueKinds(facts({ ...r.base, sent }), r.due), []);
      });

      it(`🔴 capped: ${WEEKLY_CAP} non-welcome emails in the last 7 days hold it`, () => {
        const capClaims = [plus(r.due, -1 * D), plus(r.due, -6 * D)];
        assert.deepEqual(dueKinds(facts({ ...r.base, capClaims }), r.due), []);
        // One claim 7 days and an hour old has aged out: the kind goes.
        const aged = [plus(r.due, -1 * D), plus(r.due, -7 * D - H)];
        assert.deepEqual(dueKinds(facts({ ...r.base, capClaims: aged }), r.due), [r.kind]);
      });

      it("held through quiet hours (21:00–08:00 on the account's clock)", () => {
        assert.deepEqual(dueKinds(f, r.quiet), []);
      });

      it("🔴 an opted-out account is due nothing", () => {
        assert.deepEqual(dueKinds(facts({ ...r.base, optedOut: true }), r.due), []);
      });
    });
  }
});

describe("LIFE-2 schedule — the changes to the live six", () => {
  const SIGNUP = t("2026-10-20T18:00:00Z"); // Tue 14:00 EDT
  const fresh = (over: Partial<LifecycleFacts> = {}) =>
    facts({ createdAt: SIGNUP, hasPlan: false, sent: new Set(["welcome", "day1"]), ...over });

  it("🔴 day3 is skipped once a grocery list exists (#8 takes over)", () => {
    assert.deepEqual(dueKinds(fresh(), plus(SIGNUP, 73 * H)), ["day3"]);
    assert.deepEqual(dueKinds(fresh({ firstListAt: plus(SIGNUP, 30 * H) }), plus(SIGNUP, 73 * H)), ["prep_nudge"]);
    assert.deepEqual(dueKinds(fresh({ firstListAt: plus(SIGNUP, 10 * H) }), plus(SIGNUP, 73 * H)), []);
  });

  it("🔴 day5 is skipped once a prep session has started", () => {
    const sent = new Set(["welcome", "day1", "day3"]);
    assert.deepEqual(dueKinds(fresh({ sent }), plus(SIGNUP, 121 * H)), ["day5"]);
    assert.deepEqual(dueKinds(fresh({ sent, firstPrepAt: plus(SIGNUP, 100 * H) }), plus(SIGNUP, 121 * H)), []);
  });

  it("🔴 the cap counts the live six too, the welcome excepted: day1 + day3 hold day5", () => {
    const sent = new Set(["welcome", "day1", "day3"]);
    const capClaims = [plus(SIGNUP, 24 * H), plus(SIGNUP, 72 * H)];
    assert.deepEqual(dueKinds(fresh({ sent, capClaims }), plus(SIGNUP, 121 * H)), []);
  });

  it("🔴 the free-time pair is never HELD by the cap (the Nov 2 cohort: next_week Oct 29 + ending Oct 31)", () => {
    const NOV2 = t("2026-11-03T04:59:59Z");
    const f = facts({
      freeTimeEndsAt: NOV2,
      sent: new Set(["welcome", "day1", "day3", "day5", "next_week:plan-wk44", "trial_ending"]),
      capClaims: [t("2026-10-29T12:05:00Z"), t("2026-10-31T12:05:00Z")],
    });
    // Nov 3 08:05 EST: the cap is full until Nov 5 12:05Z, trial_ended's window closes Nov 5 04:59Z.
    assert.deepEqual(dueKinds(f, t("2026-11-03T13:05:00Z")), ["trial_ended"]);
    const ending = facts({ freeTimeEndsAt: NOV2, capClaims: [t("2026-10-29T12:05:00Z"), t("2026-10-30T12:05:00Z")] });
    assert.deepEqual(dueKinds(ending, t("2026-10-31T12:05:00Z")), ["trial_ending"]);
  });

  it("🔴 …but the pair COUNTS toward the cap: ending + ended hold a nudge", () => {
    const f = facts({ firstPlanAt: EVENT, capClaims: [plus(EVENT, -2 * D), plus(EVENT, -1 * D)] }); // the two free-time claims
    assert.deepEqual(dueKinds(f, plus(EVENT, 24 * H)), []);
  });

  it("🔴 the welcome is never capped", () => {
    const capClaims = [plus(SIGNUP, -1 * H), plus(SIGNUP, -2 * H), plus(SIGNUP, -3 * H)];
    assert.deepEqual(dueKinds(facts({ createdAt: SIGNUP, sent: new Set(), capClaims }), SIGNUP), ["welcome"]);
  });
});

describe("LIFE-2 schedule — a capped kind waits; its window decides", () => {
  const f = (capClaims: Date[]) => facts({ firstPlanAt: EVENT, capClaims });
  const opens = plus(EVENT, 24 * H); // list_nudge: Wed 12:00 EDT → Thu 12:00 EDT

  it("the cap frees inside the window → it goes then", () => {
    const claims = [plus(opens, -6 * D - 20 * H), plus(opens, -1 * D)]; // the first ages out at opens + 4 h
    assert.deepEqual(dueKinds(f(claims), opens), []);
    assert.deepEqual(dueKinds(f(claims), plus(opens, 4 * H + 1)), ["list_nudge"]);
  });

  it("the cap frees after the window → it never goes", () => {
    const claims = [plus(opens, -2 * D), plus(opens, -1 * D)];
    for (let h = 0; h < 48; h++) assert.ok(!dueKinds(f(claims), plus(opens, h * H)).includes("list_nudge"));
  });
});

describe("LIFE-2 schedule — next_week, keyed per plan", () => {
  it("🔴 sent for this plan → not again; sent for last week's plan → this week's still goes", () => {
    const at = t("2026-10-22T13:00:00Z");
    const f = facts({ datedPlans: [WEEK_PLAN] });
    assert.equal(refIdFor("next_week", f, at), "plan-oct18");
    assert.deepEqual(dueKinds(facts({ datedPlans: [WEEK_PLAN], sent: new Set(["next_week:plan-oct18"]) }), at), []);
    assert.deepEqual(dueKinds(facts({ datedPlans: [WEEK_PLAN], sent: new Set(["next_week:plan-oct11"]) }), at), ["next_week"]);
  });

  it("recurs: the next week's plan gets its own, two days before ITS last day", () => {
    const next = { id: "plan-oct25", firstDay: "2026-10-25", lastDay: "2026-10-31" };
    const f = facts({ datedPlans: [WEEK_PLAN, next], sent: new Set(["next_week:plan-oct18"]) });
    assert.deepEqual(dueKinds(f, t("2026-10-29T13:00:00Z")), ["next_week"]); // Thu 09:00 EDT
    assert.equal(refIdFor("next_week", f, t("2026-10-29T13:00:00Z")), "plan-oct25");
  });

  it("the window opens at 00:00 two days before the last day, on the account's clock", () => {
    const f = facts({ datedPlans: [WEEK_PLAN], timezone: "America/Los_Angeles" });
    assert.deepEqual(dueKinds(f, t("2026-10-22T06:59:00Z")), []); // Wed 23:59 PDT
    assert.deepEqual(dueKinds(f, t("2026-10-22T15:00:00Z")), ["next_week"]); // Thu 08:00 PDT
    assert.deepEqual(dueKinds(f, t("2026-10-25T03:00:00Z")), ["next_week"]); // Sat 20:00 PDT, the last day
    assert.deepEqual(dueKinds(f, t("2026-10-25T07:00:00Z")), []); // Sun 00:00 PDT
  });

  it("two plans cover today → the one that runs out last is the current plan", () => {
    const short = { id: "plan-short", firstDay: "2026-10-20", lastDay: "2026-10-22" };
    const f = facts({ datedPlans: [short, WEEK_PLAN] });
    assert.equal(currentPlan(f, t("2026-10-21T16:00:00Z"))?.id, "plan-oct18");
    // The short plan running out is not "next week is unplanned": the week plan still covers it.
    assert.deepEqual(dueKinds(f, t("2026-10-21T16:00:00Z")), []);
  });

  it("{planEndDay} is the weekday of the plan's last day", () => {
    assert.equal(formatPlanEndDay("2026-10-24"), "Saturday");
    assert.equal(formatPlanEndDay("2026-10-30"), "Friday");
  });
});

describe("LIFE-2 schedule — first_cook's morning", () => {
  it("an evening cook → 08:00 the next day; an after-midnight cook → 08:00 that same day", () => {
    const tz = "America/New_York";
    assert.equal(morningAfter(t("2026-10-20T23:30:00Z"), tz).toISOString(), "2026-10-21T12:00:00.000Z"); // 19:30 → Wed 08:00
    assert.equal(morningAfter(t("2026-10-21T04:30:00Z"), tz).toISOString(), "2026-10-21T12:00:00.000Z"); // 00:30 → 08:00 same day
    assert.equal(morningAfter(t("2026-10-20T16:00:00Z"), tz).toISOString(), "2026-10-21T12:00:00.000Z"); // a lunch cook → the next morning
  });

  it("08:00 across the November 1 DST change is 08:00 EST", () => {
    assert.equal(zonedTime("2026-11-01", 8, "America/New_York").toISOString(), "2026-11-01T13:00:00.000Z");
    assert.equal(zonedTime("2026-10-31", 8, "America/New_York").toISOString(), "2026-10-31T12:00:00.000Z");
  });
});

describe("LIFE-2 schedule — priority", () => {
  it("🔴 the free-time pair first, then the event nudges oldest anchor first, then still_here / come_back", () => {
    // At Thu Oct 22 15:00 EDT: trial_ending (end Oct 24 15:00), list_nudge (first plan Wed 12:00 → opened Thu 12:00),
    // playlist_nudge (second plan Thu 10:00), next_week (opened Thu 00:00), still_here (idle since Oct 15 14:00).
    const now = t("2026-10-22T19:00:00Z");
    const f = facts({
      freeTimeEndsAt: t("2026-10-24T19:00:00Z"),
      firstPlanAt: t("2026-10-21T16:00:00Z"),
      secondPlanAt: t("2026-10-22T14:00:00Z"),
      datedPlans: [WEEK_PLAN],
      lastActiveAt: t("2026-10-15T18:00:00Z"),
    });
    assert.deepEqual(dueKinds(f, now), ["trial_ending", "next_week", "playlist_nudge", "list_nudge", "still_here"]);
  });

  it("come_back trails still_here", () => {
    // Both can only meet when facts disagree (still_here needs the free time running); the order is the rule.
    const f = facts({ freeTimeEndsAt: plus(EVENT, -10 * D), lastActiveAt: plus(EVENT, -7 * D) });
    assert.deepEqual(dueKinds(f, plus(EVENT, H)), ["come_back"]);
  });
});
