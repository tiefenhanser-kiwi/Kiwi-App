// One-shot end-to-end smoke for WS6 6a-4 — Tell Kiwi two-step pipeline.
//
// Sequence (5 inputs, one per scenario):
//   1. "Make me an easy week"                                       → vague
//   2. "I want tacos one night and pasta one night"                  → partial
//   3. "Mon: tacos, Tue: salmon, Wed: stir fry, Thu: pizza, Fri: pasta" → fully_specified
//   4. "I want tacos, salmon, lasagna, stir fry, pizza, pasta, soup, sandwiches" → overflow
//   5. "yellow"                                                      → unclear
//
// For each input: print parsedIntent, candidate count, and LLMCallLog row
// counts (2 rows for the first 4 scenarios, 1 for unclear). The smoke uses
// the 6a-3.5 user (already populated with hidden context) so we exercise the
// real injection path too.

import { PrismaClient } from "@prisma/client";
import { signToken } from "../src/lib/auth.ts";

const prisma = new PrismaClient();
const API_BASE = "http://localhost:3000/api";
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
  expectedCandidates: number; // -1 means "any non-zero" for vague/partial
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

async function runOne(
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

  // Snapshot LLMCallLog count before the request so we can isolate this run's
  // log writes from any earlier ones.
  const beforeLogs = await prisma.lLMCallLog.count({
    where: {
      userId: SMOKE_USER_ID,
      promptKey: { in: ["wizard.directed.parse_intent", "wizard.directed.generate"] },
    },
  });

  const startedAt = Date.now();
  const res = await fetch(`${API_BASE}/wizard/build-from-text`, {
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
    console.log(`  BODY: ${text.slice(0, 400)}`);
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

  // Pull the new log rows for this user since we started.
  const afterLogs = await prisma.lLMCallLog.findMany({
    where: {
      userId: SMOKE_USER_ID,
      promptKey: { in: ["wizard.directed.parse_intent", "wizard.directed.generate"] },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  const newLogs = afterLogs.slice(0, afterLogs.length - beforeLogs);
  console.log(`  LLMCallLog rows added: ${newLogs.length}`);
  for (const log of newLogs) {
    console.log(
      `    - ${log.promptKey} | model=${log.model} mode=${log.mode} success=${log.success} latency=${log.latencyMs}ms cost=$${log.costEstimateUsd?.toFixed(5)}`,
    );
  }

  const expectedLogs = c.expectedScenario === "unclear" ? 1 : 2;
  const llmCallsPass = newLogs.length === expectedLogs;
  const scenarioPass = body.parsedIntent.scenario === c.expectedScenario;
  const candidatesPass = body.candidates.length === c.expectedCandidates;

  return {
    label: c.label,
    scenarioPass,
    candidatesPass,
    llmCallsPass,
    scenario: body.parsedIntent.scenario,
    candidates: body.candidates.length,
    llmCallCount: newLogs.length,
    parsedIntent: body.parsedIntent,
    needsClarification: body.needsClarification,
    candidateTitles: body.candidates.map((cd) => cd.title),
    candidateMealTitles: body.candidates.map((cd) => cd.mealTitles),
  };
}

async function main() {
  // Reuse the 6a-3.5 user (or create a 6a-4 user with similar prefs).
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

  const token = signToken(user.id);

  const reports: ScenarioReport[] = [];
  for (let i = 0; i < CASES.length; i++) {
    const r = await runOne(token, CASES[i], i);
    reports.push(r);
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

  // Partial-scenario contract: every candidate must include all explicit meals.
  const partial = reports.find((r) => r.label === "partial");
  if (partial) {
    const required = ["taco", "pasta"];
    const allHaveAll = partial.candidateMealTitles.every((titles) => {
      const joined = titles.join(" | ").toLowerCase();
      return required.every((m) => joined.includes(m));
    });
    console.log(
      `  [partial-explicit-meals] ${allHaveAll ? "✓" : "✗"} all candidates contain tacos + pasta`,
    );
  }

  const allPass = reports.every(
    (r) => r.scenarioPass && r.candidatesPass && r.llmCallsPass,
  );
  console.log(
    `\n  Overall: ${allPass ? "✅ PASS" : "❌ FAIL — see details above"}`,
  );

  if (!allPass) process.exitCode = 1;

  // Print full output dump for the chat report.
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
