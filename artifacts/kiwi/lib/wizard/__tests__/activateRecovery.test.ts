// D-WS7-080 fix — tests for the activate-404 recovery helper.
//
// The helper decides where to route the user when /wizard/drafts/:id/
// activate returns 404 on a retry (server already promoted the draft to
// a real active plan; the success response from the first call was
// dropped by a platform timeout / app backgrounding). Pinning the routing
// rule here keeps it testable without mounting the wizard-plan-details
// screen.

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveActivatedPlanRouteAfter404 } from "../activateRecovery";
import type { PlanListResponse } from "../../api/plans";

function plansWith(
  activeThisWeek: PlanListResponse["activeThisWeek"],
): PlanListResponse {
  return {
    plans: [],
    activeThisWeek,
    nextCursor: null,
  };
}

test("routes to /plan/[id] using activeThisWeek.id when the server has the new plan", async () => {
  const list = plansWith({
    id: "plan-recovered-1",
    name: "Recovered Plan",
    status: "active",
    startDate: "2026-05-31",
    endDate: "2026-06-06",
    revisionId: 2,
  });
  const getPlans = async () => list;
  const route = await resolveActivatedPlanRouteAfter404(getPlans);
  assert.deepEqual(route, { kind: "plan", planId: "plan-recovered-1" });
});

test("falls back to plansTab when activeThisWeek is null (defensive)", async () => {
  const getPlans = async () => plansWith(null);
  const route = await resolveActivatedPlanRouteAfter404(getPlans);
  assert.deepEqual(route, { kind: "plansTab" });
});

test("propagates getPlans failure (caller decides how to surface recovery-fetch errors)", async () => {
  const boom = new Error("network down");
  const getPlans = async () => {
    throw boom;
  };
  await assert.rejects(
    () => resolveActivatedPlanRouteAfter404(getPlans),
    (err: unknown) => err === boom,
  );
});

// D-WS7-080 fix — the recovery helper does exactly one /plans fetch. If
// it ever started looping or retrying internally it could pile up network
// load while the user is already on a degraded path; pinning the call
// count keeps that boundary explicit.
test("invokes getPlans exactly once per recovery attempt", async () => {
  let calls = 0;
  const getPlans = async () => {
    calls += 1;
    return plansWith({
      id: "plan-x",
      name: "X",
      status: "active",
      startDate: null,
      endDate: null,
      revisionId: 2,
    });
  };
  await resolveActivatedPlanRouteAfter404(getPlans);
  assert.equal(calls, 1);
});
