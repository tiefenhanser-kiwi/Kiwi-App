// SEC-2 — OWNERSHIP (IDOR): user A must get 403 or 404 — never 200, never a
// write — on user B's plans, plan items, meals, dishes, grocery lists and
// items, prep-week state, cooking sequence, favorites, playlist and drafts.
//
// ── WHY THIS RUNS AGAINST THE DEV DATABASE, AND ONLY ON REQUEST ─────────
//
// The rest of the suite is hermetic: stub Prisma clients that answer whatever
// the test hands them. That cannot test this. An IDOR is a `where` clause that
// forgot `userId` — and a stub that ignores the where clause (as every stub
// here does) passes the vulnerable query and the safe one alike. Only the real
// query planner can say which rows a request reaches.
//
// So: SKIPPED by default (`pnpm test` stays hermetic and offline), and run
// with `SEC2_IDOR_DB=1`. It refuses any DATABASE_URL that is not the dev Neon
// branch. It seeds two throwaway users with one of everything, drives the REAL
// app (src/app.ts) in-process as user A against user B's ids, then checks B's
// rows are byte-for-byte what they were, and deletes everything it made.
// AI, image and mail keys are blanked before the app loads: a route that let A
// through would reach a model call with no key, never a paid one. Run it with
// the sec-2 no-egress preload (scripts/_scratch/sec-2/noegress.mjs) and no
// outbound request leaves the machine at all — Instacart keeps its key so the
// instacart-link route gets as far as its ownership check.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { PrismaClient } from "@prisma/client";

const RUN = process.env["SEC2_IDOR_DB"] === "1";
const DEV_HOST = /ep-broad-haze/;

for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "RESEND_API_KEY", "PEXELS_API_KEY", "PIXABAY_API_KEY"]) {
  process.env[k] = "";
}
process.env["LIFECYCLE_EMAIL_ENABLED"] = "false";

interface Owned {
  userId: string;
  token: string;
  mealId: string;
  dishId: string;
  templateId: string;
  planId: string;
  itemId: string;
  listId: string;
  groceryItemId: string;
  draftId: string;
  stapleId: string;
}

describe("SEC-2 — ownership: A cannot read or write B's things", { skip: RUN ? false : "set SEC2_IDOR_DB=1 to run against the dev database" }, () => {
  let prisma: PrismaClient;
  let server: Server;
  let base = "";
  let A: Owned;
  let B: Owned;
  const stamp = Date.now().toString(36);
  let before_: unknown;

  async function seed(who: "a" | "b"): Promise<Owned> {
    const { signToken } = await import("../../lib/auth");
    const user = await prisma.user.create({
      data: { email: `sec2-idor-${who}-${stamp}@example.com`, firstName: `Idor${who}`, lastName: "Probe", passwordHash: null },
    });
    await prisma.subscription.create({
      data: { userId: user.id, planCode: "free", status: "trialing", trialEndsAt: new Date(Date.now() + 14 * 864e5) },
    });
    const meal = await prisma.meal.create({ data: { title: `IDOR ${who} private meal`, userId: user.id, isPublic: false } });
    const dish = await prisma.dish.create({ data: { title: `IDOR ${who} private dish`, userId: user.id } });
    await prisma.mealDishLink.create({ data: { mealId: meal.id, dishId: dish.id } });
    const template = await prisma.mealPlanTemplate.create({ data: { userId: user.id, title: `IDOR ${who} template` } });
    const plan = await prisma.mealPlanInstance.create({
      data: { userId: user.id, mealPlanTemplateId: template.id, titleOverride: `IDOR ${who} plan` },
    });
    const item = await prisma.mealPlanItem.create({ data: { mealPlanInstanceId: plan.id, mealId: meal.id } });
    const list = await prisma.groceryList.create({ data: { userId: user.id, title: `IDOR ${who} list`, mealPlanInstanceId: plan.id } });
    const gItem = await prisma.groceryListItem.create({ data: { groceryListId: list.id, displayName: `IDOR ${who} item` } });
    await prisma.favorite.create({ data: { userId: user.id, mealId: meal.id } });
    await prisma.playlistMeal.create({ data: { userId: user.id, mealId: meal.id } });
    // SERVER-13 A — a staple (the user row's cascade removes it).
    const staple = await prisma.pantryStaple.create({ data: { userId: user.id, ingredientName: `idor ${who} staple ${stamp}` } });
    const draft = await prisma.mealPlanInstance.create({
      data: { userId: user.id, isWizardDraft: true, wizardDraftPayload: { candidateId: "c", title: "t" } },
    });
    return {
      userId: user.id,
      token: signToken(user.id),
      mealId: meal.id,
      dishId: dish.id,
      templateId: template.id,
      planId: plan.id,
      itemId: item.id,
      listId: list.id,
      groceryItemId: gItem.id,
      draftId: draft.id,
      stapleId: staple.id,
    };
  }

  /** Every row of B's that A's requests could touch, as plain data. */
  async function snapshotB(): Promise<unknown> {
    const [user, meal, dish, template, plans, items, lists, gItems, favs, playlist, links, completions, structures, staples] = await Promise.all([
      prisma.user.findUnique({ where: { id: B.userId } }),
      prisma.meal.findUnique({ where: { id: B.mealId } }),
      prisma.dish.findUnique({ where: { id: B.dishId } }),
      prisma.mealPlanTemplate.findUnique({ where: { id: B.templateId } }),
      prisma.mealPlanInstance.findMany({ where: { userId: B.userId }, orderBy: { id: "asc" } }),
      prisma.mealPlanItem.findMany({ where: { planInstance: { userId: B.userId } }, orderBy: { id: "asc" } }),
      prisma.groceryList.findMany({ where: { userId: B.userId }, orderBy: { id: "asc" } }),
      prisma.groceryListItem.findMany({ where: { groceryList: { userId: B.userId } }, orderBy: { id: "asc" } }),
      prisma.favorite.findMany({ where: { userId: B.userId } }),
      prisma.playlistMeal.findMany({ where: { userId: B.userId } }),
      prisma.mealDishLink.findMany({ where: { meal: { userId: B.userId } } }),
      prisma.prepStepCompletion.findMany({ where: { planId: B.planId } }).catch(() => "n/a"),
      prisma.prepWeekStructure.findMany({ where: { planId: B.planId } }).catch(() => "n/a"),
      prisma.pantryStaple.findMany({ where: { userId: B.userId }, orderBy: { id: "asc" } }),
    ]);
    return JSON.parse(JSON.stringify({ user, meal, dish, template, plans, items, lists, gItems, favs, playlist, links, completions, structures, staples }));
  }

  before(async () => {
    const url = process.env["DATABASE_URL"] ?? "";
    if (!DEV_HOST.test(new URL(url).hostname)) throw new Error("refusing: DATABASE_URL is not the dev Neon branch");
    prisma = (await import("../../lib/prisma")).prisma as PrismaClient;
    const app = (await import("../../app")).default;
    A = await seed("a");
    B = await seed("b");
    before_ = await snapshotB();
    server = await new Promise((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });

  after(async () => {
    server?.close();
    if (!prisma || !A || !B) return;
    const ids = [A.userId, B.userId];
    const plans = (await prisma.mealPlanInstance.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((p) => p.id);
    const steps: Array<() => Promise<unknown>> = [
      () => prisma.prepStepCompletion.deleteMany({ where: { planId: { in: plans } } }),
      () => prisma.prepWeekStructure.deleteMany({ where: { planId: { in: plans } } }),
      () => prisma.groceryListItem.deleteMany({ where: { groceryList: { userId: { in: ids } } } }),
      () => prisma.groceryList.deleteMany({ where: { userId: { in: ids } } }),
      () => prisma.mealPlanItem.deleteMany({ where: { mealPlanInstanceId: { in: plans } } }),
      () => prisma.mealPlanInstance.deleteMany({ where: { userId: { in: ids } } }),
      () => prisma.mealPlanTemplate.deleteMany({ where: { userId: { in: ids } } }),
      () => prisma.mealDishLink.deleteMany({ where: { meal: { userId: { in: ids } } } }),
      () => prisma.meal.deleteMany({ where: { userId: { in: ids } } }),
      () => prisma.dishIngredient.deleteMany({ where: { dish: { userId: { in: ids } } } }),
      () => prisma.dish.deleteMany({ where: { userId: { in: ids } } }),
      () => prisma.userActivity.deleteMany({ where: { userId: { in: ids } } }),
      () => prisma.user.deleteMany({ where: { id: { in: ids } } }),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (err) {
        console.error("sec2Idor cleanup step failed:", err instanceof Error ? err.message : err);
      }
    }
    await prisma.$disconnect();
  });

  // Every request A makes against B. `allow` is the refusal set: 403/404, and
  // for a caller-scoped delete (it can only ever remove A's OWN row) 204 too —
  // what matters there is that B's row survives, which the final check proves.
  const cases = (): Array<{ route: string; method: string; path: string; body?: unknown; allow?: number[] }> => [
    // plans
    { route: "GET /plans/:id", method: "GET", path: `/plans/${B.planId}` },
    { route: "PATCH /plans/:id", method: "PATCH", path: `/plans/${B.planId}`, body: { name: "pwned" } },
    { route: "DELETE /plans/:id", method: "DELETE", path: `/plans/${B.planId}` },
    { route: "POST /plans/:id/copy", method: "POST", path: `/plans/${B.planId}/copy`, body: {} },
    { route: "POST /plans/:id/recalc-macros", method: "POST", path: `/plans/${B.planId}/recalc-macros`, body: {} },
    { route: "GET /plans/templates/:id", method: "GET", path: `/plans/templates/${B.templateId}` },
    { route: "POST /plans/use-template/:templateId", method: "POST", path: `/plans/use-template/${B.templateId}`, body: {} },
    // plan items — B's plan, and A's plan wired to B's item
    { route: "POST /plans/:id/items (B's plan)", method: "POST", path: `/plans/${B.planId}/items`, body: { mealId: A.mealId } },
    { route: "POST /plans/:id/items (A's plan, B's private meal)", method: "POST", path: `/plans/${A.planId}/items`, body: { mealId: B.mealId } },
    { route: "PATCH /plans/:id/items/:itemId (B's)", method: "PATCH", path: `/plans/${B.planId}/items/${B.itemId}`, body: { notes: "pwned" } },
    { route: "PATCH /plans/:id/items/:itemId (A's plan, B's item)", method: "PATCH", path: `/plans/${A.planId}/items/${B.itemId}`, body: { notes: "pwned" } },
    { route: "PATCH /plans/:id/items/:itemId (A's item → B's private meal)", method: "PATCH", path: `/plans/${A.planId}/items/${A.itemId}`, body: { mealId: B.mealId } },
    { route: "DELETE /plans/:id/items/:itemId (B's)", method: "DELETE", path: `/plans/${B.planId}/items/${B.itemId}` },
    { route: "DELETE /plans/:id/items/:itemId (A's plan, B's item)", method: "DELETE", path: `/plans/${A.planId}/items/${B.itemId}` },
    { route: "POST /plans/:id/items/:itemId/promote-override", method: "POST", path: `/plans/${B.planId}/items/${B.itemId}/promote-override`, body: {} },
    { route: "POST /plans/from-meals (B's private meal)", method: "POST", path: `/plans/from-meals`, body: { mealIds: [B.mealId], planDurationDays: 1 } },
    // meals and dishes
    { route: "GET /meals/:id", method: "GET", path: `/meals/${B.mealId}` },
    { route: "PATCH /me/meals/:id", method: "PATCH", path: `/me/meals/${B.mealId}`, body: { title: "pwned" } },
    { route: "POST /me/meals/:mealId/dishes/from-catalog (B's meal)", method: "POST", path: `/me/meals/${B.mealId}/dishes/from-catalog`, body: { sourceMealId: A.mealId } },
    { route: "POST /me/meals/:mealId/dishes/from-catalog (A's meal, B's source)", method: "POST", path: `/me/meals/${A.mealId}/dishes/from-catalog`, body: { sourceMealId: B.mealId } },
    { route: "GET /dishes/:id", method: "GET", path: `/dishes/${B.dishId}` },
    { route: "PATCH /me/dishes/:id", method: "PATCH", path: `/me/dishes/${B.dishId}`, body: { title: "pwned" } },
    // cooking + prep
    { route: "POST /meals/:mealId/cooking-sequence", method: "POST", path: `/meals/${B.mealId}/cooking-sequence`, body: {} },
    { route: "POST /plans/:planId/prep-week", method: "POST", path: `/plans/${B.planId}/prep-week`, body: {} },
    { route: "GET /plans/:planId/prep-week/structure", method: "GET", path: `/plans/${B.planId}/prep-week/structure` },
    { route: "GET /plans/:planId/prep-week/completions", method: "GET", path: `/plans/${B.planId}/prep-week/completions` },
    { route: "PUT /plans/:planId/prep-week/completions", method: "PUT", path: `/plans/${B.planId}/prep-week/completions`, body: { stepKey: "k" } },
    { route: "DELETE /plans/:planId/prep-week/completions", method: "DELETE", path: `/plans/${B.planId}/prep-week/completions`, body: { stepKey: "k" } },
    // grocery
    { route: "GET /grocery-lists/:id", method: "GET", path: `/grocery-lists/${B.listId}` },
    { route: "PATCH /grocery-lists/:id", method: "PATCH", path: `/grocery-lists/${B.listId}`, body: { status: "completed" } },
    { route: "POST /grocery-lists/:id/items", method: "POST", path: `/grocery-lists/${B.listId}/items`, body: { itemName: "pwned", storeSection: "produce" } },
    { route: "PATCH /grocery-lists/:id/items/:itemId (B's)", method: "PATCH", path: `/grocery-lists/${B.listId}/items/${B.groceryItemId}`, body: { isChecked: true } },
    { route: "PATCH /grocery-lists/:id/items/:itemId (A's list, B's item)", method: "PATCH", path: `/grocery-lists/${A.listId}/items/${B.groceryItemId}`, body: { isChecked: true } },
    { route: "DELETE /grocery-lists/:id/items/:itemId (B's)", method: "DELETE", path: `/grocery-lists/${B.listId}/items/${B.groceryItemId}` },
    { route: "DELETE /grocery-lists/:id/items/:itemId (A's list, B's item)", method: "DELETE", path: `/grocery-lists/${A.listId}/items/${B.groceryItemId}` },
    { route: "POST /grocery-lists/:id/items/:itemId/restore (B's)", method: "POST", path: `/grocery-lists/${B.listId}/items/${B.groceryItemId}/restore`, body: {} },
    { route: "POST /grocery-lists/:id/items/:itemId/restore (A's list, B's item)", method: "POST", path: `/grocery-lists/${A.listId}/items/${B.groceryItemId}/restore`, body: {} },
    { route: "POST /grocery-lists/:id/instacart-link (B's)", method: "POST", path: `/grocery-lists/${B.listId}/instacart-link`, body: { items: [{ groceryListItemId: B.groceryItemId }] } },
    { route: "POST /grocery-lists/:id/instacart-link (A's list, B's item)", method: "POST", path: `/grocery-lists/${A.listId}/instacart-link`, body: { items: [{ groceryListItemId: B.groceryItemId }] } },
    { route: "POST /plans/:id/generate-grocery-list", method: "POST", path: `/plans/${B.planId}/generate-grocery-list`, body: {} },
    // favorites + playlist
    { route: "POST /me/favorites (B's private meal)", method: "POST", path: `/me/favorites`, body: { mealId: B.mealId } },
    // Caller-scoped no-ops: deleteMany/updateMany WHERE userId = A. A foreign id
    // answers exactly as a nonexistent one, and the snapshot proves B's row
    // survives — so their 200 is not access.
    { route: "DELETE /me/favorites/:mealId (scoped no-op)", method: "DELETE", path: `/me/favorites/${B.mealId}`, allow: [403, 404, 200, 204] },
    { route: "POST /me/playlist (B's private meal)", method: "POST", path: `/me/playlist`, body: { mealId: B.mealId } },
    { route: "DELETE /me/playlist/:mealId (scoped no-op)", method: "DELETE", path: `/me/playlist/${B.mealId}`, allow: [403, 404, 200, 204] },
    // staples (SERVER-13 A)
    { route: "POST /me/staples (B's grocery item)", method: "POST", path: `/me/staples`, body: { groceryItemId: B.groceryItemId } },
    { route: "DELETE /me/staples/:id (B's)", method: "DELETE", path: `/me/staples/${B.stapleId}` },
    // wizard drafts
    { route: "GET /wizard/drafts/:id", method: "GET", path: `/wizard/drafts/${B.draftId}` },
    { route: "POST /wizard/drafts/:id/dismiss (scoped no-op, {dismissed:false})", method: "POST", path: `/wizard/drafts/${B.draftId}/dismiss`, body: {}, allow: [403, 404, 200] },
    { route: "POST /wizard/drafts/:id/save", method: "POST", path: `/wizard/drafts/${B.draftId}/save`, body: {} },
    { route: "POST /wizard/drafts/:id/activate", method: "POST", path: `/wizard/drafts/${B.draftId}/activate`, body: {} },
  ];

  const results: Array<{ route: string; status: number }> = [];

  it("every request A makes against B's ids is refused (403/404)", async () => {
    const failures: string[] = [];
    for (const c of cases()) {
      const res = await fetch(`${base}${c.path}`, {
        method: c.method,
        headers: { authorization: `Bearer ${A.token}`, "content-type": "application/json" },
        body: c.body === undefined ? undefined : JSON.stringify(c.body),
      });
      const text = await res.text();
      results.push({ route: c.route, status: res.status });
      const allow = c.allow ?? [403, 404];
      if (!allow.includes(res.status)) failures.push(`${c.route} → ${res.status} ${text.slice(0, 160)}`);
      // A refusal must not carry B's data either.
      if (text.includes("IDOR b ")) failures.push(`${c.route} → response carries B's data`);
    }
    console.log(results.map((r) => `${String(r.status).padEnd(4)} ${r.route}`).join("\n"));
    assert.deepEqual(failures, []);
  });

  it("…and nothing of B's changed", async () => {
    assert.deepEqual(await snapshotB(), before_);
  });

  it("control: B can read their own plan, meal and list (the ids are real)", async () => {
    for (const path of [`/plans/${B.planId}`, `/meals/${B.mealId}`, `/grocery-lists/${B.listId}`, `/dishes/${B.dishId}`]) {
      const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${B.token}` } });
      assert.equal(res.status, 200, path);
    }
  });
});
