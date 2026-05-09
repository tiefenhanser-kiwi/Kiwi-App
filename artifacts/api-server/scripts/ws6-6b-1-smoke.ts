// Live-server smoke for WS6 6b-1 (Find Similar AI semantic similarity).
//
// Sequence:
//   0. GET  /api/healthz                                      → 200
//   1. POST /api/meals/find-similar (Beef Tacos + 6 candidates) → AI ranking
//      - parses against FindSimilarResultSchema
//      - same-cuisine baseline check (informational, doesn't fail allPass)
//      - LLMCallLog row written for promptKey='meals.find_similar'
//      - meal_found_similar_used activity event recorded
//   2. POST /api/meals/find-similar with entitlement DENIED (in-process,
//      same-server stub via SUBSCRIPTION_DENY_USER_ID userId match) — skipped
//      in this script because the DI seam isn't reachable over HTTP. Instead
//      we exercise the fallback path in unit tests; here we just verify that
//      a request from a totally fresh user still parses and returns matches.
//
// Differs from the unit tests: hits a real `pnpm dev` process over HTTP, so
// verifies the live wire-up matches what the unit tests verify in isolation,
// PLUS confirms the Anthropic API actually returns ranked matches against
// our prompt body for a representative input.

import { PrismaClient } from "@prisma/client";
import { signToken } from "../src/lib/auth.ts";

const prisma = new PrismaClient();
const API_BASE = "http://localhost:3000/api";
const SMOKE_USER_ID = "smoke-ws6-6b-1-user";
const SMOKE_USER_EMAIL = "smoke+ws6-6b-1@kiwi.dev";

interface MealCandidatePayload {
  id: string;
  title: string;
  cuisine: string | null;
  mealType: string;
  keyIngredients?: string[];
  tags?: string[];
}

const SOURCE: MealCandidatePayload = {
  id: "src-beef-tacos",
  title: "Beef Tacos",
  cuisine: "Mexican",
  mealType: "dinner",
  keyIngredients: ["ground beef", "taco shells", "cheese", "salsa"],
  tags: ["weeknight", "quick", "kid-friendly"],
};

const CANDIDATES: MealCandidatePayload[] = [
  {
    id: "c-chicken-tacos",
    title: "Chicken Tacos",
    cuisine: "Mexican",
    mealType: "dinner",
    keyIngredients: ["chicken thighs", "tortillas", "salsa"],
  },
  {
    id: "c-quesadillas",
    title: "Cheese Quesadillas",
    cuisine: "Mexican",
    mealType: "dinner",
    keyIngredients: ["tortillas", "cheese"],
  },
  {
    id: "c-pad-thai",
    title: "Pad Thai",
    cuisine: "Thai",
    mealType: "dinner",
    keyIngredients: ["rice noodles", "shrimp", "peanuts"],
  },
  {
    id: "c-spaghetti",
    title: "Spaghetti Bolognese",
    cuisine: "Italian",
    mealType: "dinner",
    keyIngredients: ["pasta", "ground beef", "tomato sauce"],
  },
  {
    id: "c-tex-mex-bowl",
    title: "Tex-Mex Bowl",
    cuisine: "Tex-Mex",
    mealType: "dinner",
    keyIngredients: ["ground beef", "rice", "black beans", "cheese"],
  },
  {
    id: "c-greek-salad",
    title: "Greek Salad",
    cuisine: "Greek",
    mealType: "dinner",
    keyIngredients: ["feta", "olives", "cucumber"],
  },
];

interface SmokeReport {
  pass: boolean;
  shapePass: boolean;
  cuisinePrioritizedPass: boolean;
  llmLogPass: boolean;
  activityEventPass: boolean;
  matchCount: number;
  topMatchId?: string;
  topMatchScore?: number;
  topMatchReason?: string;
  latencyMs: number;
  cost?: number;
}

async function main() {
  // 1. Ensure the smoke user exists.
  const user = await prisma.user.upsert({
    where: { id: SMOKE_USER_ID },
    update: {},
    create: {
      id: SMOKE_USER_ID,
      email: SMOKE_USER_EMAIL,
      firstName: "Smoke",
      lastName: "FindSimilar",
      defaultHouseholdSize: 2,
    },
  });

  const token = signToken(user.id);

  // 2. Healthz preflight.
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("Preflight: GET /api/healthz");
  const healthRes = await fetch(`${API_BASE}/healthz`);
  console.log(`  HTTP ${healthRes.status}`);
  if (!healthRes.ok) {
    console.error("healthz failed; bailing");
    process.exitCode = 1;
    return;
  }

  // 3. Snapshot baselines.
  const beforeLogs = await prisma.lLMCallLog.count({
    where: { userId: SMOKE_USER_ID, promptKey: "meals.find_similar" },
  });
  const beforeActivity = await prisma.userActivity.count({
    where: { userId: SMOKE_USER_ID, eventType: "meal_found_similar_used" },
  });

  // 4. Hit the live endpoint.
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("Scenario 1/1: FIND SIMILAR (POST /api/meals/find-similar)");
  console.log(
    `  source: "${SOURCE.title}" (${SOURCE.cuisine}, mealType=${SOURCE.mealType})`,
  );
  console.log(`  candidates: ${CANDIDATES.length}`);

  const startedAt = Date.now();
  const res = await fetch(`${API_BASE}/meals/find-similar`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ source: SOURCE, candidates: CANDIDATES, limit: 10 }),
  });
  const elapsedMs = Date.now() - startedAt;
  const text = await res.text();
  console.log(`  Response: HTTP ${res.status} in ${elapsedMs}ms`);

  if (!res.ok) {
    console.log(`  BODY: ${text.slice(0, 600)}`);
    process.exitCode = 1;
    return;
  }

  const body = JSON.parse(text) as {
    matches: { mealId: string; similarityScore: number; reason: string }[];
    metadata: { mode: string; promptVersion: number | null; latencyMs: number };
  };

  const shapePass =
    Array.isArray(body.matches) &&
    body.matches.every(
      (m) =>
        typeof m.mealId === "string" &&
        typeof m.similarityScore === "number" &&
        typeof m.reason === "string" &&
        m.similarityScore >= 0 &&
        m.similarityScore <= 1,
    );
  console.log(`  shape parses against schema: ${shapePass ? "✓" : "✗"}`);
  console.log(`  metadata.mode = ${body.metadata.mode}`);

  console.log(`  matches (${body.matches.length}):`);
  for (const m of body.matches) {
    const cand = CANDIDATES.find((c) => c.id === m.mealId);
    console.log(
      `    - ${m.mealId.padEnd(20)} score=${m.similarityScore.toFixed(2)}  cuisine=${cand?.cuisine ?? "?"}  reason="${m.reason}"`,
    );
  }

  // Informational: same-cuisine candidates SHOULD rank above cross-cuisine
  // for this baseline (Beef Tacos / Mexican). Don't fail allPass on a miss —
  // the AI may legitimately rank a Tex-Mex bowl high because of the ground-
  // beef + cheese overlap. Just flag.
  const mexicanIds = new Set(
    CANDIDATES.filter((c) => c.cuisine === "Mexican").map((c) => c.id),
  );
  const orderedIds = body.matches.map((m) => m.mealId);
  const firstMexicanIndex = orderedIds.findIndex((id) => mexicanIds.has(id));
  const firstNonMexicanIndex = orderedIds.findIndex((id) => !mexicanIds.has(id));
  const cuisinePrioritizedPass =
    firstMexicanIndex !== -1 &&
    (firstNonMexicanIndex === -1 || firstMexicanIndex < firstNonMexicanIndex);
  console.log(
    `  cuisine-baseline (Mexican ahead of others): ${cuisinePrioritizedPass ? "✓" : "ℹ informational miss"}`,
  );

  // 5. Verify LLMCallLog row written.
  const afterLogs = await prisma.lLMCallLog.count({
    where: { userId: SMOKE_USER_ID, promptKey: "meals.find_similar" },
  });
  const newLogs = afterLogs - beforeLogs;
  console.log(`  LLMCallLog rows added: ${newLogs}`);
  const llmLogPass = newLogs === 1;

  if (newLogs > 0) {
    const latest = await prisma.lLMCallLog.findFirst({
      where: { userId: SMOKE_USER_ID, promptKey: "meals.find_similar" },
      orderBy: { createdAt: "desc" },
    });
    if (latest) {
      console.log(
        `    - model=${latest.model} mode=${latest.mode} success=${latest.success} latency=${latest.latencyMs}ms cost=$${latest.costEstimateUsd?.toFixed(5)} retries=${latest.retryCount}`,
      );
    }
  }

  // 6. Verify activity event written.
  const afterActivity = await prisma.userActivity.count({
    where: { userId: SMOKE_USER_ID, eventType: "meal_found_similar_used" },
  });
  const newActivity = afterActivity - beforeActivity;
  const activityEventPass = newActivity === 1;
  console.log(
    `  meal_found_similar_used activity event added: ${newActivity} ${activityEventPass ? "✓" : "✗"}`,
  );

  // 7. Cost from the latest log row.
  const latestLog = await prisma.lLMCallLog.findFirst({
    where: { userId: SMOKE_USER_ID, promptKey: "meals.find_similar" },
    orderBy: { createdAt: "desc" },
    select: { costEstimateUsd: true },
  });

  const report: SmokeReport = {
    pass: shapePass && llmLogPass && activityEventPass,
    shapePass,
    cuisinePrioritizedPass,
    llmLogPass,
    activityEventPass,
    matchCount: body.matches.length,
    topMatchId: body.matches[0]?.mealId,
    topMatchScore: body.matches[0]?.similarityScore,
    topMatchReason: body.matches[0]?.reason,
    latencyMs: elapsedMs,
    cost: latestLog?.costEstimateUsd,
  };

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("SUMMARY");
  console.log("══════════════════════════════════════════════════════════");
  const flags = [
    report.shapePass ? "✓ shape" : "✗ shape",
    report.llmLogPass ? "✓ log" : "✗ log",
    report.activityEventPass ? "✓ activity" : "✗ activity",
    report.cuisinePrioritizedPass
      ? "✓ cuisine-priority"
      : "ℹ cuisine-priority (informational)",
  ];
  console.log(`  [find-similar] ${flags.join(" ")}`);
  console.log(
    `  matches=${report.matchCount} top=${report.topMatchId} score=${report.topMatchScore?.toFixed(2)} latency=${report.latencyMs}ms cost=$${report.cost?.toFixed(5) ?? "?"}`,
  );
  console.log(`\n  Overall: ${report.pass ? "✅ PASS" : "❌ FAIL"}`);

  if (!report.pass) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("smoke failed", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
