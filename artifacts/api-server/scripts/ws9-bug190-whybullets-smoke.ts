// WS9 BUG-190 smoke — one live build-plans generation, whyBullets printed
// verbatim for audit.
//
// BUG-190: the plan rationale claimed non-advantages ("asparagus in two meals"
// as a saving, "3 vegetables can be bought in one farmer's market trip" as an
// advantage). whyBullets are authored at CANDIDATE time, where no ingredient or
// pack data exists, so sharing/waste claims are now BANNED there and the bullets
// lead on preference fit — the user's own words first (WHY_BULLETS_RULES in
// prisma/seeds/aiPrompts.ts).
//
// This drives ONE real Sonnet call through the production wizard router with a
// preference set that is deliberately loud in free text (mushroom avoidance,
// toddler-on-hip note, a 30-minute cap), prints every bullet verbatim, and flags
// any bullet carrying a banned shape. It does NOT pass/fail the block — Hans's
// device read is the gate; this exists so the wording can be audited without a
// phone.
//
// In-process (no dev server needed), same idiom as ws6-6a-4-smoke-inproc.ts.
//
// Run: pnpm --filter @workspace/api-server exec tsx scripts/ws9-bug190-whybullets-smoke.ts
// Prereq: prisma:seed (for the BUG-190 prompt versions) + ANTHROPIC_API_KEY.

import express, { type Express } from "express";
import type { Server } from "node:http";
import { PrismaClient } from "@prisma/client";

import { signToken } from "../src/lib/auth.ts";
import { createWizardRouter } from "../src/routes/wizard.ts";

const prisma = new PrismaClient();
const SMOKE_USER_ID = "smoke-ws9-bug190-user";
const SMOKE_USER_EMAIL = "smoke+ws9-bug190@kiwi.dev";

// Free text the bullets SHOULD reach for, and a cap they can honestly claim.
const ADDITIONAL_NOTES =
  "No mushrooms anywhere, my daughter gags on them. I'm usually cooking with a toddler on my hip so nothing that needs two hands the whole time.";
const DIETARY_NOTES = "Trying to eat less red meat, not none.";

// Shapes the rewrite bans. Substring match is deliberately blunt — this is an
// audit aid that surfaces candidates for a human read, not a validator.
const BANNED_SHAPES: ReadonlyArray<readonly [string, string]> = [
  ["shares", "sharing claim"],
  ["share the same", "sharing claim"],
  ["carries across", "sharing claim"],
  ["carry across", "sharing claim"],
  ["used up", "waste claim"],
  ["use up", "waste claim"],
  ["no waste", "waste claim"],
  ["less waste", "waste claim"],
  ["nothing goes to waste", "waste claim"],
  ["half-bunch", "quantity claim"],
  ["one bunch", "quantity claim"],
  ["one pack", "quantity claim"],
  ["one trip", "one-shopping-trip filler"],
  ["shopping trip", "one-shopping-trip filler"],
  ["farmer's market", "one-shopping-trip filler"],
  ["saves you time", "time-saved claim"],
  ["saves time", "time-saved claim"],
  ["healthy and delicious", "says-nothing filler"],
];

async function spinUp(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app: Express = express();
  app.use(express.json());
  // Real production deps — real prisma, real runAICall, real Anthropic.
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

async function main() {
  const user = await prisma.user.upsert({
    where: { id: SMOKE_USER_ID },
    update: {},
    create: {
      id: SMOKE_USER_ID,
      email: SMOKE_USER_EMAIL,
      firstName: "Smoke",
      lastName: "WhyBullets",
      defaultHouseholdSize: 4,
    },
  });

  const prefs = {
    householdSize: 4,
    wantsLeftovers: false,
    cookingEquipment: ["oven", "stove", "microwave"],
    spiceTolerance: "mild",
    budgetLevel: "economy",
    pickyAvoidances: ["mushrooms", "olives"],
    recurringGroceryItems: ["olive oil", "salt", "garlic"],
    dietaryNotes: DIETARY_NOTES,
    maxCookTimeMinutes: 30,
    maxCookTimeCoverage: "all",
  };
  await prisma.userPreferences.upsert({
    where: { userId: user.id },
    update: prefs,
    create: { userId: user.id, ...prefs },
  });

  const harness = await spinUp();
  const token = signToken(user.id);

  const requestBody = {
    planDurationDays: 5,
    householdSize: 4,
    cuisines: ["Mexican", "Italian", "Mediterranean"],
    eatingStyles: [],
    allergiesAndAvoidances: [],
    difficulty: "easy",
    weeklyPacing: "one_fancy_night",
    dietaryNotes: DIETARY_NOTES,
    additionalNotes: ADDITIONAL_NOTES,
    maxCookTimeMinutes: 30,
    maxCookTimeCoverage: "all",
  };

  console.log("BUG-190 whyBullets smoke — one live build-plans generation");
  console.log(`  additionalNotes: "${ADDITIONAL_NOTES}"`);
  console.log(`  dietaryNotes:    "${DIETARY_NOTES}"`);
  console.log(`  pickyAvoidances: ${JSON.stringify(prefs.pickyAvoidances)}`);
  console.log(`  cook-time cap:   ${prefs.maxCookTimeMinutes} min (all nights)`);

  const startedAt = Date.now();
  const res = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Plain JSON, not text/event-stream: one buffered call, easier to read.
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(requestBody),
  });
  const elapsedMs = Date.now() - startedAt;
  const text = await res.text();
  console.log(`\nHTTP ${res.status} in ${elapsedMs}ms`);

  if (!res.ok) {
    console.log(text.slice(0, 1200));
    await harness.close();
    await prisma.$disconnect();
    process.exitCode = 1;
    return;
  }

  const body = JSON.parse(text) as {
    candidates: { title: string; whyBullets: string[]; mealTitles: string[] }[];
    metadata?: { promptVersion?: number };
  };

  console.log(`promptVersion: v${body.metadata?.promptVersion ?? "?"}`);

  let flagged = 0;
  for (const [i, c] of body.candidates.entries()) {
    console.log(`\n─── candidate ${i + 1}: ${c.title}`);
    console.log(`    meals: ${c.mealTitles.join(" · ")}`);
    console.log(`    whyBullets (${c.whyBullets.length}):`);
    for (const b of c.whyBullets) {
      const lower = b.toLowerCase();
      const hits = BANNED_SHAPES.filter(([needle]) => lower.includes(needle));
      const mark = hits.length > 0 ? "  ⚠ " : "  • ";
      console.log(`  ${mark}${b}`);
      for (const [needle, why] of hits) {
        flagged++;
        console.log(`         ↳ ${why} — matched "${needle}"`);
      }
    }
  }

  const log = await prisma.lLMCallLog.findFirst({
    where: { userId: SMOKE_USER_ID, promptKey: "wizard.set_preferences.generate" },
    orderBy: { createdAt: "desc" },
  });
  if (log) {
    console.log(
      `\nLLMCallLog: v${log.promptVersion} model=${log.model} success=${log.success} latency=${log.latencyMs}ms cost=$${log.costEstimateUsd?.toFixed(5)}`,
    );
  }
  console.log(
    flagged === 0
      ? "\nNo banned shapes matched. Read the bullets above — the gate is whether they are TRUE, which only a human can say."
      : `\n${flagged} banned-shape match(es) flagged above. Read them: a match is a candidate for review, not proof of a bad bullet.`,
  );

  await harness.close();
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
