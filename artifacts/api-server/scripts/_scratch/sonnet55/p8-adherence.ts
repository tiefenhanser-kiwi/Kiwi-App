// Part J.0 D3 — adherence on generation, Sonnet 4.6 vs 5.5 (thinking off, the
// coded default since J.0). NOT a gate: Hans has ruled "switch".
//
// 10 runs per model per set (gf30, family4picky), identical inputs: the inputs are
// built ONCE per set by the route's own helpers (mirrored from p2-compare.ts) and
// replayed through the real streaming door (streamPlanCandidates) with an explicit
// `model`, so the only thing that differs between arms is the model.
//
// Rules, per candidate:
//   count     — candidates returned == wizard.candidate_count
//   playlist  — store slots on an `isPlaylist` shelf row == playlistMealsPerWeek
//   cap30     — gf30 only: no non-playlist STORE slot over 30 min (playlist rows are
//               exempt by the BUG-245 ruling; a LIVE slot carries no time at all,
//               so it cannot be checked and is counted separately)
//
// 🔒 dev only; every Prisma write except an LLMCallLog row throws; READ-only on
// GEN_USER (as p2-compare). Run:
//   node --env-file=.env --import tsx scripts/_scratch/sonnet55/p8-adherence.ts [runs=10] [budget=2.2]
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient } from "@prisma/client";

import { streamPlanCandidates, type StreamCapableMessages } from "../../../src/lib/ai/streamPlanCandidates";
import { WizardInputSchema } from "../../../src/lib/ai/schemas/wizard";
import { buildPlanningContext, buildRecentRotation } from "../../../src/lib/planningContext";
import { discoveryLevelFromInput, resolveAllergenPreference, resolveEffectivePreferences } from "../../../src/lib/wizardPreferences";
import { addPlaylistToShelf, retrieveShelf } from "../../../src/lib/store/shelf";

if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) throw new Error("REFUSING: not the dev branch");
const WRITE_OPS = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany"]);
const base = new PrismaClient();
const prisma = base.$extends({
  query: { $allModels: { async $allOperations({ model, operation, args, query }) {
    if (WRITE_OPS.has(operation) && model !== "LLMCallLog") throw new Error(`WRITE BLOCKED: ${model}.${operation}`);
    return query(args);
  } } },
}) as unknown as PrismaClient;

const RUNS = Number(process.argv[2] ?? 10);
const BUDGET = Number(process.argv[3] ?? 2.2);
const OUT = path.resolve(import.meta.dirname, "out");
fs.mkdirSync(OUT, { recursive: true });
const RATES: Record<string, [number, number]> = { "claude-sonnet-4-6": [3, 15], "claude-sonnet-5-5": [2, 10] };
const MODELS = (process.env.P8_MODELS ?? "claude-sonnet-4-6,claude-sonnet-5-5").split(",");
const GEN_USER = "76f9d078-830e-45ef-beb3-11474dae716e"; // as p2-compare — READ only

const PREF_SETS: Record<string, Record<string, unknown>> = {
  family4picky: {
    planDurationDays: 5, householdSize: 4, cuisines: ["American", "Italian", "Mexican"], eatingStyles: [], allergiesAndAvoidances: [],
    difficulty: "easy", weeklyPacing: "mostly_easy",
    dietaryNotes: "Two picky kids (6 and 9): nothing spicy, no visible onions or mushrooms.",
    additionalNotes: "The kids will eat pasta, chicken, tacos and anything with cheese. Weeknights are rushed.",
  },
  gf30: {
    planDurationDays: 5, householdSize: 2, cuisines: [], eatingStyles: [], allergiesAndAvoidances: ["Gluten-free"],
    difficulty: "easy", weeklyPacing: "minimal_effort", maxCookTimeMinutes: 30, maxCookTimeCoverage: "all",
    dietaryNotes: "Celiac in the house: strictly gluten-free, including sauces.",
  },
};

let spent = 0;
const real = new Anthropic();
function recClient(): StreamCapableMessages {
  return {
    stream: (p: Anthropic.MessageStreamParams) => {
      const s = real.messages.stream(p);
      const orig = s.finalMessage.bind(s);
      (s as { finalMessage: () => Promise<Anthropic.Message> }).finalMessage = async () => {
        const r = await orig();
        const [i, o] = RATES[p.model] ?? [0, 0];
        const u = r.usage;
        spent += (u.input_tokens * i + (u.cache_creation_input_tokens ?? 0) * i * 1.25 + (u.cache_read_input_tokens ?? 0) * i * 0.1 + u.output_tokens * o) / 1e6;
        return r;
      };
      return s;
    },
  } as unknown as StreamCapableMessages;
}

// Mirror of POST /wizard/build-plans steps 1–4b (routes/wizard.ts), as p2-compare.
async function buildGenerateVars(body: Record<string, unknown>) {
  const userId = GEN_USER;
  const parsed = WizardInputSchema.omit({ hiddenContext: true }).parse(body);
  const ccRow = await prisma.systemSetting.findUnique({ where: { key: "wizard.candidate_count" } });
  const requestedCandidateCount = ccRow ? Number(ccRow.value) : 3;
  const [prefs, pantry, recent] = await Promise.all([
    prisma.userPreferences.findUnique({ where: { userId }, select: { cookingEquipment: true, spiceTolerance: true, budgetLevel: true, pickyAvoidances: true, recurringGroceryItems: true } }),
    prisma.pantryStaple.findMany({ where: { userId, isActive: true }, select: { ingredientName: true } }),
    prisma.userActivity.findMany({ where: { userId, eventType: "cook_meal", entityType: "meal" }, orderBy: { createdAt: "desc" }, take: 10, select: { entityId: true } }),
  ]);
  const hiddenContext = {
    equipment: prefs?.cookingEquipment ?? [], spiceTolerance: prefs?.spiceTolerance ?? undefined, budgetLevel: prefs?.budgetLevel ?? undefined,
    pickyAvoidances: prefs?.pickyAvoidances ?? [], recurringItems: prefs?.recurringGroceryItems ?? [],
    pantryStaples: pantry.map((p) => p.ingredientName), recentMealIds: recent.map((a) => a.entityId).filter((id): id is string => !!id),
  };
  const [planningContext, recentRotation] = await Promise.all([buildPlanningContext(prisma, userId), buildRecentRotation(prisma, userId)]);
  const { discoveryLevel, playlistLevel, saucePreference, maxCookTimeMinutes, maxCookTimeCoverage, ...aiInput } = parsed;
  const preferencesContext = await resolveEffectivePreferences(prisma, userId,
    { discoveryLevel: discoveryLevelFromInput({ discoveryLevel }), playlistLevel, saucePreference, maxCookTimeMinutes, maxCookTimeCoverage },
    { planDurationDays: aiInput.planDurationDays });
  const { recentMeals: _r, ...planningContextBase } = planningContext;
  const resolvedAllergens = await resolveAllergenPreference(prisma, userId, aiInput.allergiesAndAvoidances, { route: "wizard.build_plans" });
  const wizardInput = { ...aiInput, allergiesAndAvoidances: resolvedAllergens.allergiesAndAvoidances, hiddenContext, planningContext: planningContextBase, preferencesContext, recentRotation, requestedCandidateCount };
  const baseShortlist = await retrieveShelf(prisma, {
    cuisines: aiInput.cuisines ?? [], allergiesAndAvoidances: resolvedAllergens.allergiesAndAvoidances, difficulty: aiInput.difficulty, userId,
    excludeMealIds: hiddenContext.recentMealIds, maxCookTimeMinutes: preferencesContext.maxCookTimeMinutes, maxCookTimeCoverage: preferencesContext.maxCookTimeCoverage,
  });
  const storeShortlist = preferencesContext.playlistMealsPerWeek > 0
    ? await addPlaylistToShelf(prisma, baseShortlist, { userId, allergiesAndAvoidances: resolvedAllergens.allergiesAndAvoidances, difficulty: aiInput.difficulty })
    : baseShortlist;
  return { wizardInput, storeShortlist, preferencesContext, requestedCandidateCount };
}

interface Cand { mealTitles: string[]; storeSlots?: { slotIndex: number; storeMealId: string }[] }
interface RunRow {
  set: string; model: string; run: number; success: boolean; reason: string | null;
  candidates: number; wantCandidates: number; wantPlaylist: number;
  perCandidate: { playlist: number; storeSlots: number; liveSlots: number; overCap: number; meals: number }[];
}

async function main() {
  const rows: RunRow[] = [];
  for (const [set, body] of Object.entries(PREF_SETS)) {
    const v = await buildGenerateVars(body);
    const byAlias = new Map(v.storeShortlist.forPrompt.map((m) => [m.id, m]));
    const cap = v.preferencesContext.maxCookTimeMinutes ?? null;
    console.error(`${set}: N playlist=${v.preferencesContext.playlistMealsPerWeek} cap=${cap} candidates=${v.requestedCandidateCount} shelf=${v.storeShortlist.forPrompt.length} (playlist rows ${v.storeShortlist.forPrompt.filter((m) => m.isPlaylist).length})`);
    for (let run = 0; run < RUNS; run++) {
      // Interleave the models so drift over the hour hits both arms alike.
      await Promise.all(MODELS.map(async (model) => {
        if (spent >= BUDGET) throw new Error(`BUDGET $${spent.toFixed(3)}`);
        const r = await streamPlanCandidates("wizard.set_preferences.generate",
          { wizardInput: v.wizardInput, storeShortlist: v.storeShortlist.forPrompt },
          { prisma: prisma as never, model, cacheSplitMarker: "{{storeShortlist}}", client: recClient() });
        const cands: Cand[] = r.success ? (r as unknown as { data: { candidates: Cand[] } }).data.candidates : [];
        const row: RunRow = {
          set, model, run, success: r.success, reason: r.success ? null : (r as { reason?: string }).reason ?? null,
          candidates: cands.length, wantCandidates: v.requestedCandidateCount, wantPlaylist: v.preferencesContext.playlistMealsPerWeek,
          perCandidate: cands.map((c) => {
            const slots = (c.storeSlots ?? []).map((s) => byAlias.get(s.storeMealId));
            return {
              meals: c.mealTitles.length,
              storeSlots: slots.filter(Boolean).length,
              liveSlots: c.mealTitles.length - slots.filter(Boolean).length,
              playlist: slots.filter((m) => m?.isPlaylist).length,
              overCap: cap === null ? 0 : slots.filter((m) => m && !m.isPlaylist && m.estimatedTimeMinutes > cap).length,
            };
          }),
        };
        rows.push(row);
        fs.appendFileSync(path.join(OUT, process.env.P8_OUT ?? "p8-adherence.jsonl"), JSON.stringify(row) + "\n");
        console.error(`${set} ${model} #${run} ${row.success ? "ok" : `FAIL ${row.reason}`} cands=${row.candidates} playlist=${row.perCandidate.map((p) => p.playlist).join("/")} overCap=${row.perCandidate.map((p) => p.overCap).join("/")} live=${row.perCandidate.map((p) => p.liveSlots).join("/")} [$${spent.toFixed(3)}]`);
      }));
    }
  }
  fs.writeFileSync(path.join(OUT, "p8-adherence.json"), JSON.stringify({ spentUsd: Number(spent.toFixed(4)), rows }, null, 2));
  console.error(`spent $${spent.toFixed(4)}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => base.$disconnect());
