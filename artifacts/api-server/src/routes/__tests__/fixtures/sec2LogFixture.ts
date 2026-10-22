// SEC-2 #12 + #15 log fixture — NOT a test file (lives under fixtures/, outside
// the package.json:test glob). Run in a CHILD PROCESS with NODE_ENV=production
// by sec2Logs.test.ts, for the reason bug219LogFixture.ts gives: pino writes to
// fd 1 through SonicBoom, so the only honest assertion is on the child's real
// stdout, in the production JSON shape.
//
// Drives four requests whose log lines used to carry something they should
// not, each with a distinctive marker the parent then searches the bytes for:
//   · GET /healthz with an x-forwarded-for chain   → no address logged
//   · a failing grocery lookup with a search term  → length, not text
//   · a refused recipe import with a path + query  → host, not path or query
//   · a signup claiming a guest session it cannot  → no guest session id
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../../lib/auth";
import { createAuthRouter } from "../../auth";
import { createGroceryListsRouter } from "../../groceryLists";
import { createHealthRouter } from "../../health";
import { createRecipesRouter } from "../../recipes";
import { MARKERS } from "./sec2LogFixture.markers";

// Every unmodelled Prisma call throws — the grocery lookup is meant to fail.
const throwing = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error("stub: not modelled");
    },
  },
);
const prisma = new Proxy(
  {
    user: {
      findUnique: async () => ({ tokensValidFrom: null }),
    },
  } as Record<string, unknown>,
  { get: (t, p) => (p in t ? t[p as string] : throwing) },
) as never;

async function main(): Promise<void> {
  const app: Express = express();
  app.use(express.json());
  app.use(createHealthRouter({ prisma }));
  app.use(createGroceryListsRouter({ prisma }));
  app.use(createRecipesRouter({ prisma, subscriptionService: { can: async () => ({ allowed: true }) } as never }));
  // Signup reaches the claim inside its transaction: a new user, then the
  // claim refuses (no guest token) and rolls it back.
  const tx = {
    user: { create: async () => ({ id: "u-zz", onboardingComplete: false }) },
    subscription: { create: async () => ({}) },
  };
  app.use(
    createAuthRouter({
      prisma: {
        user: { findUnique: async () => null },
        $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      } as never,
    }),
  );
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const auth = { authorization: `Bearer ${signToken("sec2-log-user")}`, "content-type": "application/json" };

  const health = await fetch(`${base}/healthz`, { headers: { "x-forwarded-for": `${MARKERS.xff}, 10.0.0.1` } });
  process.stdout.write(`
SEC2_HEALTHZ_STATUS ${health.status}
`);
  await fetch(`${base}/grocery-items/lookup?q=${MARKERS.groceryTerm}`, { headers: auth });
  await fetch(`${base}/recipes/import-url`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ url: `http://example.com:8080/${MARKERS.importPath}?t=${MARKERS.importQuery}` }),
  });
  await fetch(`${base}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "zz-log@example.com",
      password: "a-password-1",
      firstName: "L",
      lastName: "G",
      guestSessionId: MARKERS.guestId,
    }),
  });
  await new Promise((r) => setTimeout(r, 100));
  server.close();
  process.stdout.write("\nSEC2_LOG_FIXTURE_DONE\n", () => process.exit(0));
}

void main();
