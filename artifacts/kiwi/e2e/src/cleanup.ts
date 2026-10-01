// ─────────────────────────────────────────────────────────────────────────────
// ARCHIVE WHAT THIS HARNESS CREATED — and nothing else.
//
//   KIWI_E2E_CLEANUP=dry   pnpm run e2e -- cleanup   # prints the plan only
//   KIWI_E2E_CLEANUP=apply pnpm run e2e -- cleanup   # composts them
//
// Driven by specs/cleanup.spec.ts rather than a `node --import tsx` entry
// point: `tsx` is not a dependency of @workspace/kiwi, and Playwright already
// transpiles this folder, so running it as a spec adds no third devDependency
// for a script that runs twice a pass.
//
// 🔴 HOW "THIS HARNESS CREATED IT" IS DECIDED, AND WHY IT IS A KEEP-LIST.
//
// There is no marker on a harness plan. `/plans/from-meals` names a plan
// deterministically from the user's first name and the week start
// (lib/planTitle.ts), so a harness plan is titled exactly like one Hans made by
// hand, and the "(2)", "(3)" suffixes are the only difference between two of
// mine. Matching on the title would be guessing, and guessing wrong here
// deletes the user's own work.
//
// So the rule is inverted: FOUR plans are the account's seed data, measured and
// recorded before this harness ever ran (Part A §2 — "its four existing plans
// are seed data"). Everything else on this account was created by a harness
// run. The keep-list is explicit, by id, and anything not on it and not
// recognised is REPORTED rather than touched.
//
// ⛔ NOT A HARD DELETE. `DELETE /plans/:id` is the compost path: the row stays,
// `status` flips to "past", `compostedAt` is stamped, `isArchived` becomes true,
// `revisionId` bumps — and in the SAME transaction the plan's grocery lists get
// `status: "archived"` (D-WS9-001, scoped to non-archived rows so a re-run is a
// no-op). One call archives both halves, and nothing is erased.
// ─────────────────────────────────────────────────────────────────────────────
import { Api } from "./api";
import { API_SERVER_ORIGIN, assertDevDatabase } from "./env";

/**
 * The browser-test account's seed plans, as measured at the start of Part A
 * (2026-09-30, before the first harness run): 4 plans, 4 grocery lists.
 * ⚠️ IDS, NOT TITLES. See the header.
 */
const SEED_PLAN_IDS = new Set([
  "1e41fc0c-7294-4bd3-a14a-302e44bbcd7c", // Tacos & Enchiladas + Three Easy Fall Weeknights
  "b4aa6fee-70b1-4990-a596-05087ac904c5", // Your 5 Meals, Exactly as You Planned Them
  "b5263268-64c7-41ff-a8f2-20c01a2b905e", // Your 5-Meal Lineup — Exactly as You Described
  "1cf373bc-a2cb-4469-90ef-bb87d0327343", // Your 5-Meal Lineup
]);

interface PlanRow {
  id: string;
  name: string | null;
  status?: string;
  isActiveThisWeek?: boolean;
}

export async function cleanup(apply: boolean): Promise<void> {
  const db = assertDevDatabase();
  console.log(`[cleanup] ${db.note}`);
  if (!db.ok) throw new Error("refusing: not the dev database");

  // Straight at the api-server: this pass has no page, so the web server on
  // :9000 being up or down is irrelevant to it.
  const api = new Api(`${API_SERVER_ORIGIN}/api`);
  await api.login();

  const before = await inventory(api);
  console.log(
    `[cleanup] BEFORE — ${before.plans.length} plan(s), ${before.lists.length} grocery list(s)`,
  );

  const seed = before.plans.filter((p) => SEED_PLAN_IDS.has(p.id));
  const mine = before.plans.filter((p) => !SEED_PLAN_IDS.has(p.id));

  console.log(`[cleanup] keeping ${seed.length} seed plan(s):`);
  for (const p of seed) {
    console.log(`    keep  ${p.id.slice(0, 8)}  ${String(p.name).slice(0, 56)}`);
  }
  console.log(`[cleanup] ${mine.length} plan(s) created by this harness:`);
  for (const p of mine) {
    const active = p.isActiveThisWeek ? "  ← currently 'this week'" : "";
    console.log(`    archive ${p.id.slice(0, 8)}  ${String(p.name).slice(0, 50)}${active}`);
  }

  // A seed plan that has gone missing is worth saying out loud: it means the
  // keep-list is stale and this script's whole premise needs re-checking.
  const missing = [...SEED_PLAN_IDS].filter((id) => !before.plans.some((p) => p.id === id));
  if (missing.length > 0) {
    console.log(
      `[cleanup] ⚠️ ${missing.length} seed plan(s) are no longer on the account ` +
        `(${missing.map((i) => i.slice(0, 8)).join(", ")}) — the keep-list may be stale`,
    );
  }

  if (!apply) {
    console.log("[cleanup] DRY RUN — nothing was changed. Re-run with --apply.");
    return;
  }

  let ok = 0;
  const failed: string[] = [];
  for (const p of mine) {
    try {
      await api.compostPlan(p.id);
      ok++;
    } catch (e) {
      failed.push(`${p.id.slice(0, 8)}: ${String((e as Error).message).slice(0, 160)}`);
    }
  }

  const after = await inventory(api);
  console.log(`[cleanup] composted ${ok}/${mine.length} plan(s)`);
  for (const f of failed) console.log(`    FAILED  ${f}`);
  console.log(
    `[cleanup] AFTER — ${after.plans.length} plan(s), ${after.lists.length} grocery list(s)`,
  );
  const stillActive = after.plans.find((p) => p.isActiveThisWeek);
  console.log(
    `[cleanup] 'this week' is now: ${
      stillActive ? `${stillActive.id.slice(0, 8)} ${String(stillActive.name).slice(0, 48)}` : "none"
    }`,
  );
}

async function inventory(api: Api): Promise<{ plans: PlanRow[]; lists: { id: string }[] }> {
  const p = await api.plans();
  const l = await api.groceryLists();
  return { plans: p, lists: l };
}

