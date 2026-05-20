// One-shot end-to-end smoke for WS6 6a-3.5.
//
// Sequence:
//   1. Upsert a smoke-test user (idempotent — re-runs are safe).
//   2. Populate UserPreferences with non-default values for the hidden-
//      context fields (equipment without instant_pot to verify exclusion,
//      spiceTolerance=mild, etc).
//   3. Issue a real authenticated POST /api/wizard/build-plans against the
//      running api-server. This hits the real Anthropic API.
//   4. Read the LLMCallLog row written by the call and print it.
//   5. Print the response payload so we can confirm no Instant-Pot recipes,
//      no shrimp (allergy), and the candidate set looks fresh.

import { PrismaClient } from "@prisma/client";
import { signToken } from "../src/lib/auth.ts";

const prisma = new PrismaClient();
const API_BASE = "http://localhost:3000/api";
const SMOKE_USER_ID = "smoke-ws6-6a-3-5-user";
const SMOKE_USER_EMAIL = "smoke+ws6-6a-3-5@kiwi.dev";

async function main() {
  // 1. Upsert smoke-test user.
  const user = await prisma.user.upsert({
    where: { id: SMOKE_USER_ID },
    update: {},
    create: {
      id: SMOKE_USER_ID,
      email: SMOKE_USER_EMAIL,
      firstName: "Smoke",
      lastName: "Test",
      defaultHouseholdSize: 2,
    },
  });

  // 2. Upsert UserPreferences with hidden-context values that are easy to
  //    verify in the response (no instant_pot → no Instant-Pot recipes; mild
  //    spiceTolerance + cilantro avoidance).
  await prisma.userPreferences.upsert({
    where: { userId: user.id },
    update: {
      cookingEquipment: ["oven", "stove", "microwave"],
      spiceTolerance: "mild",
      budgetLevel: "economy",
      pickyAvoidances: ["cilantro"],
      recurringGroceryItems: ["olive_oil", "salt", "garlic"],
    },
    create: {
      userId: user.id,
      householdSize: 2,
      wantsLeftovers: true,
      cookingEquipment: ["oven", "stove", "microwave"],
      spiceTolerance: "mild",
      budgetLevel: "economy",
      pickyAvoidances: ["cilantro"],
      recurringGroceryItems: ["olive_oil", "salt", "garlic"],
    },
  });

  // 3. Issue a real auth'd request. We do NOT post the hidden-context fields
  //    in the body — the route is what injects them from UserPreferences.
  const token = signToken(user.id);
  const requestBody = {
    planDurationDays: 5,
    householdSize: 2,
    wantsLeftovers: true,
    cuisines: ["Italian", "Mediterranean"],
    eatingStyles: [],
    allergiesAndAvoidances: ["Shellfish"],
    difficulty: "easy",
    weeklyPacing: "one_fancy_night", // canonical value from this sub-phase
  };

  console.log("\n── REQUEST ─────────────────────────────────────────────");
  console.log(JSON.stringify(requestBody, null, 2));

  const startedAt = Date.now();
  const res = await fetch(`${API_BASE}/wizard/build-plans`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(requestBody),
  });
  const elapsedMs = Date.now() - startedAt;
  const text = await res.text();
  console.log(`\n── RESPONSE (HTTP ${res.status}, ${elapsedMs}ms) ────────`);
  console.log(text);

  if (!res.ok) {
    process.exitCode = 1;
    return;
  }

  // 4. Read the LLMCallLog row that this call wrote.
  const log = await prisma.lLMCallLog.findFirst({
    where: { userId: user.id, promptKey: "wizard.set_preferences.generate" },
    orderBy: { createdAt: "desc" },
  });
  console.log("\n── LLMCallLog row ───────────────────────────────────────");
  console.log(JSON.stringify(log, null, 2));

  // 5. Print the prefs row so we can confirm the new fields are stored
  //    where the route reads them.
  const prefs = await prisma.userPreferences.findUnique({
    where: { userId: user.id },
    select: {
      cookingEquipment: true,
      spiceTolerance: true,
      budgetLevel: true,
      pickyAvoidances: true,
      recurringGroceryItems: true,
    },
  });
  console.log("\n── UserPreferences (hidden-context fields) ──────────────");
  console.log(JSON.stringify(prefs, null, 2));

  console.log("\n── SMOKE OK ─────────────────────────────────────────────");
}

main()
  .catch((err) => {
    console.error("smoke failed", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
