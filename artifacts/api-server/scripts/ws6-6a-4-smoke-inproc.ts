// In-process variant of ws6-6a-4-smoke.ts that doesn't depend on a running
// dev server. Spins up a temporary Express instance using the production
// router + production runAICall (real Anthropic calls), exercises 5 inputs,
// and reports results.
//
// Use this when the dev server is held by another process or you want to
// guarantee fresh code is exercised.

import express, { type Express } from "express";
import type { Server } from "node:http";
import { PrismaClient } from "@prisma/client";

import { signToken } from "../src/lib/auth.ts";
import { createWizardRouter } from "../src/routes/wizard.ts";

const prisma = new PrismaClient();
const SMOKE_USER_ID = "smoke-ws6-6a-4-user";
const SMOKE_USER_EMAIL = "smoke+ws6-6a-4@kiwi.dev";

interface SmokeCase {
  label: string;
  expectedScenario:
    | "vague"
    | "partial"
    | "fully_specified"
    | "overflow"
    | "unclear";
  expectedCandidates: number;
  description: string;
}

const CASES: SmokeCase[] = [
  {
    label: "vague",
    expectedScenario: "vague",
    expectedCandidates: 3,
    description: "Make me an easy week",
  },
  {
    label: "partial",
    expectedScenario: "partial",
    expectedCandidates: 3,
    description: "I want tacos one night and pasta one night",
  },
  {
    label: "fully_specified",
    expectedScenario: "fully_specified",
    expectedCandidates: 1,
    description:
      "Mon: tacos, Tue: salmon, Wed: stir fry, Thu: pizza, Fri: pasta",
  },
  {
    label: "overflow",
    expectedScenario: "overflow",
    expectedCandidates: 1,
    description:
      "I want tacos, salmon, lasagna, stir fry, pizza, pasta, soup, sandwiches",
  },
  {
    label: "unclear",
    expectedScenario: "unclear",
    expectedCandidates: 0,
    description: "yellow",
  },
];

interface ScenarioReport {
  label: string;
  scenarioPass: boolean;
  candidatesPass: boolean;
  llmCallsPass: boolean;
  scenario?: string;
  candidates: number;
  llmCallCount: number;
  parsedIntent: unknown;
  needsClarification?: unknown;
  candidateTitles: string[];
  candidateMealTitles: string[][];
}

async function spinUp(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app: Express = express();
  app.use(express.json());
  // Real production deps — pulls real prisma + runAICall (real Anthropic).
  app.use("/api", createWizardRouter());

  return await new Promise((resolve, reject) => {
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

async function runOne(
  baseUrl: string,
  token: string,
  c: SmokeCase,
  index: number,
): Promise<ScenarioReport> {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log(`Scenario ${index + 1}/5: ${c.label.toUpperCase()}`);
  console.log(`  Description: "${c.description}"`);

  const requestBody = {
    description: c.description,
    householdSize: 2,
    wantsLeftovers: true,
    eatingStyles: [],
    allergiesAndAvoidances: [],
    planDurationDays: 5,
  };

  const beforeLogs = await prisma.lLMCallLog.count({
    where: {
      userId: SMOKE_USER_ID,
      promptKey: { in: ["wizard.directed.parse_intent", "wizard.directed.generate"] },
    },
  });

  const startedAt = Date.now();
  const res = await fetch(`${baseUrl}/wizard/build-from-text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(requestBody),
  });
  const elapsedMs = Date.now() - startedAt;
  const text = await res.text();
  console.log(`  Response: HTTP ${res.status} in ${elapsedMs}ms`);

  if (!res.ok) {
    console.log(`  BODY: ${text.slice(0, 600)}`);
    return {
      label: c.label,
      scenarioPass: false,
      candidatesPass: false,
      llmCallsPass: false,
      candidates: 0,
      llmCallCount: 0,
      parsedIntent: null,
      candidateTitles: [],
      candidateMealTitles: [],
    };
  }

  const body = JSON.parse(text) as {
    candidates: { title: string; mealTitles: string[] }[];
    parsedIntent: { scenario: string };
    needsClarification?: { reason?: string; options?: string[] };
  };

  console.log(`  parsedIntent.scenario = ${body.parsedIntent.scenario}`);
  console.log(`  candidates = ${body.candidates.length}`);
  if (body.needsClarification) {
    console.log(`  needsClarification = ${JSON.stringify(body.needsClarification)}`);
  }

  const afterCount = await prisma.lLMCallLog.count({
    where: {
      userId: SMOKE_USER_ID,
      promptKey: { in: ["wizard.directed.parse_intent", "wizard.directed.generate"] },
    },
  });
  const newCount = afterCount - beforeLogs;
  const newLogs = newCount > 0
    ? await prisma.lLMCallLog.findMany({
        where: {
          userId: SMOKE_USER_ID,
          promptKey: { in: ["wizard.directed.parse_intent", "wizard.directed.generate"] },
        },
        orderBy: { createdAt: "desc" },
        take: newCount,
      })
    : [];
  console.log(`  LLMCallLog rows added: ${newCount}`);
  for (const log of newLogs.reverse()) {
    console.log(
      `    - ${log.promptKey} | model=${log.model} mode=${log.mode} success=${log.success} latency=${log.latencyMs}ms cost=$${log.costEstimateUsd?.toFixed(5)}`,
    );
  }

  const expectedLogs = c.expectedScenario === "unclear" ? 1 : 2;
  const llmCallsPass = newCount === expectedLogs;
  const scenarioPass = body.parsedIntent.scenario === c.expectedScenario;
  const candidatesPass = body.candidates.length === c.expectedCandidates;

  return {
    label: c.label,
    scenarioPass,
    candidatesPass,
    llmCallsPass,
    scenario: body.parsedIntent.scenario,
    candidates: body.candidates.length,
    llmCallCount: newCount,
    parsedIntent: body.parsedIntent,
    needsClarification: body.needsClarification,
    candidateTitles: body.candidates.map((cd) => cd.title),
    candidateMealTitles: body.candidates.map((cd) => cd.mealTitles),
  };
}

async function main() {
  const user = await prisma.user.upsert({
    where: { id: SMOKE_USER_ID },
    update: {},
    create: {
      id: SMOKE_USER_ID,
      email: SMOKE_USER_EMAIL,
      firstName: "Smoke",
      lastName: "TellKiwi",
      defaultHouseholdSize: 2,
    },
  });

  await prisma.userPreferences.upsert({
    where: { userId: user.id },
    update: {
      equipment: ["oven", "stove", "microwave"],
      spiceTolerance: "mild",
      dailyCalorieTarget: 1800,
      budgetLevel: "budget",
      pickyAvoidances: [],
      recurringItems: ["olive_oil", "salt", "garlic"],
    },
    create: {
      userId: user.id,
      householdSize: 2,
      wantsLeftovers: true,
      equipment: ["oven", "stove", "microwave"],
      spiceTolerance: "mild",
      dailyCalorieTarget: 1800,
      budgetLevel: "budget",
      pickyAvoidances: [],
      recurringItems: ["olive_oil", "salt", "garlic"],
    },
  });

  const harness = await spinUp();
  const token = signToken(user.id);

  const reports: ScenarioReport[] = [];
  try {
    for (let i = 0; i < CASES.length; i++) {
      const r = await runOne(harness.baseUrl, token, CASES[i], i);
      reports.push(r);
    }
  } finally {
    await harness.close();
  }

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("SUMMARY");
  console.log("══════════════════════════════════════════════════════════");
  for (const r of reports) {
    const flags = [
      r.scenarioPass ? "✓ scenario" : "✗ scenario",
      r.candidatesPass ? "✓ candidates" : "✗ candidates",
      r.llmCallsPass ? "✓ logs" : "✗ logs",
    ];
    console.log(
      `  [${r.label.padEnd(16)}] ${flags.join(" ")}  (got ${r.scenario}, ${r.candidates} candidates, ${r.llmCallCount} logs)`,
    );
  }

  const partial = reports.find((r) => r.label === "partial");
  if (partial) {
    // Accept common pasta-shape synonyms — AI tends to substitute spaghetti /
    // penne / linguine / fettuccine etc. when the user said "pasta".
    const tacoTokens = ["taco"];
    const pastaTokens = [
      "pasta",
      "spaghetti",
      "penne",
      "linguine",
      "fettuccine",
      "rigatoni",
      "ziti",
      "macaroni",
      "noodle",
      "lasagna",
    ];
    const allHaveAll = partial.candidateMealTitles.every((titles) => {
      const joined = titles.join(" | ").toLowerCase();
      const hasTaco = tacoTokens.some((t) => joined.includes(t));
      const hasPasta = pastaTokens.some((t) => joined.includes(t));
      return hasTaco && hasPasta;
    });
    console.log(
      `  [partial-explicit-meals] ${allHaveAll ? "✓" : "✗"} all candidates contain tacos + pasta (or shape synonyms)`,
    );
  }

  const allPass = reports.every(
    (r) => r.scenarioPass && r.candidatesPass && r.llmCallsPass,
  );
  console.log(
    `\n  Overall: ${allPass ? "✅ PASS" : "❌ FAIL — see details above"}`,
  );

  if (!allPass) process.exitCode = 1;

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("DETAILED PER-SCENARIO OUTPUT");
  console.log("══════════════════════════════════════════════════════════");
  for (const r of reports) {
    console.log(`\n── ${r.label.toUpperCase()} ──────────────────`);
    console.log("parsedIntent:", JSON.stringify(r.parsedIntent, null, 2));
    if (r.needsClarification) {
      console.log("needsClarification:", JSON.stringify(r.needsClarification, null, 2));
    }
    if (r.candidateTitles.length > 0) {
      console.log("candidates:");
      for (let i = 0; i < r.candidateTitles.length; i++) {
        console.log(`  ${i + 1}. ${r.candidateTitles[i]}`);
        for (const m of r.candidateMealTitles[i]) {
          console.log(`     • ${m}`);
        }
      }
    }
  }
}

main()
  .catch((err) => {
    console.error("smoke failed", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
