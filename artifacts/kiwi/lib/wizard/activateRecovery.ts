// D-WS7-080 fix — recovery helper for the "404 on /wizard/drafts/:id/activate"
// case. Lifted into its own module so the routing decision is pinned by a
// unit test without mounting the full wizard-plan-details screen.
//
// Why this exists: the activate endpoint can complete server-side (drafts
// row promoted to a real plan + isActiveThisWeek=true) while the mobile
// client drops the 201 — a fetch timeout, the OS killing the network task
// when the app backgrounds, the screen unmounting, etc. The next user tap
// re-fires /activate against a draft id that no longer exists as a draft,
// and the server (correctly) returns 404 "draft not found".
//
// Before this fix the screen rendered that 404 as a red error and the user
// concluded their plan was lost — then re-ran the wizard, displacing their
// own good plan via the single-active invariant. The plan was always safe;
// the client just didn't know its id.
//
// The fix: on 404, fetch GET /plans once. The server stamps `activeThisWeek`
// on every response, so the now-active plan id is right there — route to
// /plan/[id]. If activeThisWeek is null (shouldn't happen post-activation,
// but possible on a multi-device race), fall back to landing on the My
// Plans tab so the user can find the new plan there rather than seeing red.

import type { getPlans as GetPlans } from "../api/plans";

export type ActivateRecoveryRoute =
  | { kind: "plan"; planId: string }
  | { kind: "plansTab" };

/**
 * Resolve where to send the user when /wizard/drafts/:id/activate returns
 * 404 (i.e. the draft was already consumed by a prior in-flight call).
 *
 * Passes `getPlans` as a dependency so the unit test can supply a stub
 * without mocking the apiClient layer.
 *
 * Throws whatever `getPlans` throws — callers decide how to surface a
 * recovery-fetch failure (we don't want to swallow a genuine network
 * error here and pretend the recovery worked).
 */
export async function resolveActivatedPlanRouteAfter404(
  getPlans: typeof GetPlans,
): Promise<ActivateRecoveryRoute> {
  const list = await getPlans();
  const id = list.activeThisWeek?.id;
  if (id) return { kind: "plan", planId: id };
  return { kind: "plansTab" };
}
