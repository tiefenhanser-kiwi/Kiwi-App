// WS7-3 Block C1 — server-side smoke for every endpoint the C1 mobile getters
// call. Mounts the real route handlers on an ephemeral Express server backed
// by the live (seeded) Neon DB, signs a session token for the dev user, and
// exercises each endpoint over HTTP — the non-Expo verification path between
// C1 and C2.
//
// Run (from artifacts/api-server/):
//   node --env-file=.env --import tsx scripts/c1-endpoints-smoke.ts
// or, from anywhere in the repo:
//   pnpm --filter @workspace/api-server exec tsx scripts/c1-endpoints-smoke.ts
//
// Prereq: prisma:seed:dev (Hans's account + plans). Every surface is a read —
// idempotent, no teardown, safe to re-run immediately.
//
// NOTE: this smoke deliberately does NOT import the mobile Zod schemas to
// validate responses. Those live in @workspace/kiwi and transitively pull
// expo-only modules that cannot load in a plain Node process (see C1 Phase 3
// §7). Schema-vs-reality parity is covered by the C1 module tests (schemas
// parsed against fixtures) and is finally ratified when C2-C4 screens consume
// live data; this smoke prints each full JSON payload so it can be eyeballed
// against the schemas in lib/api/*.ts.

import express, { type Express, type IRouter, Router } from "express";
import type { Server } from "node:http";
import { PrismaClient } from "@prisma/client";

import { signToken } from "../src/lib/auth";
import { createDishesRouter } from "../src/routes/dishes";
import { createGroceryListsRouter } from "../src/routes/groceryLists";
import { createHomeRouter } from "../src/routes/home";
import { createMealsRouter } from "../src/routes/meals";
import { createMeRouter } from "../src/routes/me";
import { createPlansRouter } from "../src/routes/plans";

const DEV_USER_EMAIL = "hans.tiefenthaler+8@gmail.com";
// Fallback plan id when the seeded user owns no instance plan (see getDevUserId
// teardown note in ws6-6c-7-smoke.ts — same seeded plan).
const DEV_PLAN_ID = "dev-plan-instance-spice-it-up";

const prisma = new PrismaClient();

type Json = unknown;
type Rec = Record<string, unknown>;

interface Surface {
  key: string;
  label: string;
  status: number;
  ok: boolean;
  note: string;
}

const surfaces: Surface[] = [];

function arrLen(x: unknown): number | string {
  return Array.isArray(x) ? x.length : "?";
}

// ── Server wiring ───────────────────────────────────────────────────────────

// Mirror routes/index.ts: every router mounts under /api. Each factory is
// given the smoke's own PrismaClient; the AI / macro / subscription deps fall
// back to production defaults — none are exercised by these read endpoints.
function buildApp(): Express {
  const app: Express = express();
  app.use(express.json());
  const api: IRouter = Router();
  api.use(createHomeRouter({ prisma }));
  api.use(createPlansRouter({ prisma }));
  api.use(createDishesRouter({ prisma }));
  api.use(createMealsRouter({ prisma }));
  api.use(createMeRouter({ prisma }));
  api.use(createGroceryListsRouter({ prisma }));
  app.use("/api", api);
  return app;
}

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

function listen(app: Express): Promise<Harness> {
  return new Promise<Harness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("server did not bind"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/api`,
        close: () =>
          new Promise<void>((r, j) =>
            server.close((err) => (err ? j(err) : r())),
          ),
      });
    });
  });
}

async function getDevUserId(): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { email: DEV_USER_EMAIL },
    select: { id: true },
  });
  if (!user) {
    throw new Error(
      `dev user ${DEV_USER_EMAIL} not found — run ` +
        `pnpm --filter @workspace/api-server prisma:seed:dev`,
    );
  }
  return user.id;
}

// ── Surface runner ──────────────────────────────────────────────────────────

async function hit(
  harness: Harness,
  token: string,
  path: string,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${harness.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body: Json = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

// Runs one surface, prints its header + full JSON, records pass/fail.
async function run(
  harness: Harness,
  token: string,
  key: string,
  label: string,
  path: string,
  summary: (body: Json) => string,
): Promise<Json> {
  let status = 0;
  let body: Json = null;
  let note = "";
  try {
    const r = await hit(harness, token, path);
    status = r.status;
    body = r.body;
    note =
      status === 200
        ? summary(body)
        : `non-200 — ${JSON.stringify(body)}`;
  } catch (err) {
    note = `request threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  const ok = status === 200;
  surfaces.push({ key, label, status, ok, note });
  console.log(
    `\n══ [${key}] ${label}  →  ${status || "ERROR"}${note ? `  (${note})` : ""}`,
  );
  console.log(JSON.stringify(body, null, 2));
  return body;
}

function recordSkip(key: string, label: string, why: string): void {
  surfaces.push({ key, label, status: 0, ok: false, note: `SKIPPED — ${why}` });
  console.log(`\n══ [${key}] ${label}  →  SKIPPED  (${why})`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const runStart = new Date().toISOString();
  console.log("═".repeat(60));
  console.log("=== WS7-3 C1 endpoints smoke ===");
  console.log(`Run date: ${runStart}`);
  console.log(`Dev user: ${DEV_USER_EMAIL}`);

  const userId = await getDevUserId();
  const token = signToken(userId);
  const app = buildApp();
  const harness = await listen(app);

  try {
    // ── id-free surfaces ──────────────────────────────────────────────────
    await run(harness, token, "home", "GET /home", "/home", (b) => {
      const r = b as Rec;
      return `todaysMeal=${r?.todaysMeal ? "set" : "null"}, activePlan=${
        r?.activePlan ? "set" : "null"
      }, discoveryCards=${arrLen(r?.planDiscoveryCards)}`;
    });

    const plans = await run(
      harness,
      token,
      "plans",
      "GET /plans",
      "/plans",
      (b) => {
        const r = b as Rec;
        return `plans=${arrLen(r?.plans)}, activeThisWeek=${
          r?.activeThisWeek ? "set" : "null"
        }`;
      },
    );

    const meMeals = await run(
      harness,
      token,
      "me-meals",
      "GET /me/meals",
      "/me/meals",
      (b) => `meals=${arrLen((b as Rec)?.meals)}`,
    );

    const meDishes = await run(
      harness,
      token,
      "me-dishes",
      "GET /me/dishes",
      "/me/dishes",
      (b) => `dishes=${arrLen((b as Rec)?.dishes)}`,
    );

    await run(
      harness,
      token,
      "grocery",
      "GET /grocery-lists",
      "/grocery-lists",
      (b) => `groceryLists=${arrLen((b as Rec)?.groceryLists)}`,
    );

    // ── id-derived surfaces ───────────────────────────────────────────────
    const planRows = ((plans as Rec)?.plans as Rec[]) ?? [];
    const instancePlan = planRows.find((p) => p.source === "instance");
    const planId = (instancePlan?.id as string | undefined) ?? DEV_PLAN_ID;

    const planDetail = await run(
      harness,
      token,
      "plan-detail",
      `GET /plans/:id`,
      `/plans/${encodeURIComponent(planId)}`,
      (b) => `id=${planId}, items=${arrLen(((b as Rec)?.plan as Rec)?.items)}`,
    );

    // A meal id + a dish id, derived from the plan detail's composed items,
    // falling back to the /me/* list rows.
    const items = (((planDetail as Rec)?.plan as Rec)?.items as Rec[]) ?? [];
    const itemWithMeal = items.find((it) => it.meal);
    const mealId =
      (itemWithMeal?.mealId as string | undefined) ??
      (((meMeals as Rec)?.meals as Rec[])?.[0]?.id as string | undefined) ??
      null;
    const dishId =
      (((itemWithMeal?.meal as Rec)?.dishes as Rec[])?.[0]?.dishId as
        | string
        | undefined) ??
      (((meDishes as Rec)?.dishes as Rec[])?.[0]?.id as string | undefined) ??
      null;

    if (mealId) {
      await run(
        harness,
        token,
        "meal-detail",
        "GET /meals/:id",
        `/meals/${encodeURIComponent(mealId)}`,
        (b) =>
          `id=${mealId}, dishes=${arrLen(((b as Rec)?.meal as Rec)?.dishes)}`,
      );
    } else {
      recordSkip(
        "meal-detail",
        "GET /meals/:id",
        "no meal id derivable from /plans/:id or /me/meals — seed incomplete",
      );
    }

    if (dishId) {
      await run(
        harness,
        token,
        "dish-detail",
        "GET /dishes/:id",
        `/dishes/${encodeURIComponent(dishId)}`,
        (b) =>
          `id=${dishId}, ingredients=${arrLen(
            ((b as Rec)?.dish as Rec)?.ingredients,
          )}`,
      );
    } else {
      recordSkip(
        "dish-detail",
        "GET /dishes/:id",
        "no dish id derivable from /plans/:id or /me/dishes — seed incomplete",
      );
    }
  } finally {
    await harness.close();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const passCount = surfaces.filter((s) => s.ok).length;
  const failCount = surfaces.length - passCount;
  console.log(`\n${"═".repeat(60)}`);
  console.log("=== Summary ===");
  console.log(
    `${surfaces.length} surfaces — ${passCount} PASS, ${failCount} FAIL`,
  );
  for (const s of surfaces) {
    const verdict = s.ok ? "PASS" : s.status === 0 ? "SKIP/ERR" : "FAIL";
    console.log(
      `  [${s.key}]`.padEnd(16) +
        s.label.padEnd(22) +
        `${s.status || "-"}`.padEnd(6) +
        verdict,
    );
  }
  console.log(
    "\nAll surfaces are reads — idempotent, no teardown, safe to re-run.",
  );
  process.exitCode = failCount === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error("\nSMOKE CRASHED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
