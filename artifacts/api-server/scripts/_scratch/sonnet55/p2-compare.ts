// Sonnet 5.5 side-by-side · P2 — the comparison harness. MEASURE ONLY.
//
// Every Sonnet key on a live user path runs on IDENTICAL inputs per arm:
//   A = today (AI_MODEL_OVERRIDE_SONNET unset → claude-sonnet-4-6)
//   B = AI_MODEL_OVERRIDE_SONNET=claude-sonnet-5-5 (model-default adaptive thinking)
//   C = B + AI_SONNET55_THINKING=between_tools (thinking off) — heavy keys only
// The override is read at call time, so arms flip in-process via env.
//
// Calls go through the REAL doors (runAICall / streamPlanCandidates) with the
// REAL DB prompt bodies; inputs are built by the same helpers the routes use.
// Expand + finalize get identical inputs by chaining from arm A's outputs.
//
// 🔒 DB guard = dev. Prisma is wrapped so ANY write except an LLMCallLog row
// throws: no prep cache, no plan, no draft, no batch, no user. Plan
// e55a9305 is not read at all. No userId is passed to an AI call (system
// rows; the spend guard's per-user cap is not in play).
//
// Run: node --env-file=.env --import tsx scripts/_scratch/sonnet55/p2-compare.ts <phase> [arms]
//   phase: narr | gen | expfin | other     arms: e.g. AB (default) or C
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient } from "@prisma/client";

import { runAICall } from "../../../src/lib/ai/runAICall";
import { streamPlanCandidates, type StreamCapableMessages } from "../../../src/lib/ai/streamPlanCandidates";
import { PrepNarrationResultSchema } from "../../../src/lib/ai/schemas/prepNarration";
import {
  WizardExpandResultDetailsSchema,
  WizardFinalizeStepsResultSchema,
  WizardInputSchema,
  WizardPlanCandidatesResultSchema,
  type WizardPlanCandidate,
} from "../../../src/lib/ai/schemas/wizard";
import { ParsedIntentSchema } from "../../../src/lib/ai/schemas/tellKiwi";
import { ScaleResponseSchema } from "../../../src/lib/ai/schemas/scale";
import { loadPrepWeekInput } from "../../../src/lib/prepWeekAggregation";
import { buildPrepCombineInput } from "../../../src/lib/prepCombineAdapter";
import { combinePrep } from "../../../src/lib/prepCombineEngine";
import { assemblePrepWeekResult, buildStepPlan } from "../../../src/lib/prepWeekAssembly";
import { buildPlanningContext, buildRecentRotation } from "../../../src/lib/planningContext";
import {
  discoveryLevelFromInput,
  resolveAllergenPreference,
  resolveEffectivePreferences,
} from "../../../src/lib/wizardPreferences";
import { addPlaylistToShelf, retrieveShelf } from "../../../src/lib/store/shelf";
import { consolidatePlanIngredients } from "../../../src/lib/groceryList";
import { loadRelationRows } from "../../../src/lib/relationIndexLoader";
import { buildRelationIndex } from "../../../src/lib/ingredientRelations";
import { generateFinalGroceryList } from "../../../src/lib/groceryListAI";
import { reformatRecipeForKiwi } from "../../../src/lib/recipeImport";

// ── guards ──────────────────────────────────────────────────────────────
if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) {
  throw new Error("REFUSING: not the dev branch");
}
const WRITE_OPS = new Set([
  "create", "createMany", "createManyAndReturn", "update", "updateMany",
  "updateManyAndReturn", "upsert", "delete", "deleteMany",
]);
const base = new PrismaClient();
const prisma = base.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (WRITE_OPS.has(operation) && model !== "LLMCallLog") {
          throw new Error(`WRITE BLOCKED: ${model}.${operation}`);
        }
        return query(args);
      },
    },
  },
}) as unknown as PrismaClient;

const OUT = path.resolve(import.meta.dirname, "out");
fs.mkdirSync(OUT, { recursive: true });
const SPEND_CAP_USD = 3.6;
const RATES: Record<string, [number, number]> = {
  "claude-sonnet-4-6": [3, 15],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-4-5-20251001": [1, 5],
};

// ── spend ledger (all phases, persisted) ────────────────────────────────
const LEDGER = path.join(OUT, "spend.json");
let spent = fs.existsSync(LEDGER) ? (JSON.parse(fs.readFileSync(LEDGER, "utf8")).usd as number) : 0;
function addSpend(usd: number) {
  spent += usd;
  fs.writeFileSync(LEDGER, JSON.stringify({ usd: spent }));
  if (spent > SPEND_CAP_USD) throw new Error(`SPEND CAP: $${spent.toFixed(3)} > $${SPEND_CAP_USD}`);
}

// ── recording client: every attempt's model, stop, blocks, usage, ms ────
interface Attempt {
  model: string;
  ms: number;
  stop: string | null;
  blocks: string[];
  inTok: number;
  outTok: number;
  cacheRd: number;
  cacheWr: number;
  usd: number;
  error?: string;
}
let attempts: Attempt[] = [];
const real = new Anthropic();
function attemptOf(model: string, ms: number, r: Anthropic.Message): Attempt {
  const u = r.usage;
  const [i, o] = RATES[model] ?? [0, 0];
  const cacheRd = u.cache_read_input_tokens ?? 0;
  const cacheWr = u.cache_creation_input_tokens ?? 0;
  const usd = (u.input_tokens * i + cacheWr * i * 1.25 + cacheRd * i * 0.1 + u.output_tokens * o) / 1e6;
  return { model, ms, stop: r.stop_reason, blocks: r.content.map((b) => b.type), inTok: u.input_tokens, outTok: u.output_tokens, cacheRd, cacheWr, usd };
}
const rec = {
  messages: {
    create: async (p: Anthropic.MessageCreateParamsNonStreaming) => {
      const t = Date.now();
      try {
        const r = await real.messages.create(p);
        const a = attemptOf(p.model, Date.now() - t, r);
        attempts.push(a);
        addSpend(a.usd);
        return r;
      } catch (e) {
        attempts.push({ model: p.model, ms: Date.now() - t, stop: null, blocks: [], inTok: 0, outTok: 0, cacheRd: 0, cacheWr: 0, usd: 0, error: String((e as Error).message).slice(0, 200) });
        throw e;
      }
    },
    stream: (p: Anthropic.MessageStreamParams) => {
      const t = Date.now();
      const s = real.messages.stream(p);
      const orig = s.finalMessage.bind(s);
      (s as { finalMessage: () => Promise<Anthropic.Message> }).finalMessage = async () => {
        try {
          const r = await orig();
          const a = attemptOf(p.model, Date.now() - t, r);
          attempts.push(a);
          addSpend(a.usd);
          return r;
        } catch (e) {
          attempts.push({ model: p.model, ms: Date.now() - t, stop: null, blocks: [], inTok: 0, outTok: 0, cacheRd: 0, cacheWr: 0, usd: 0, error: String((e as Error).message).slice(0, 200) });
          throw e;
        }
      };
      return s;
    },
  },
} as unknown as Pick<Anthropic, "messages">;

// ── arms ────────────────────────────────────────────────────────────────
type Arm = "A" | "B" | "C";
function setArm(arm: Arm) {
  delete process.env.AI_MODEL_OVERRIDE_SONNET;
  delete process.env.AI_SONNET55_THINKING;
  if (arm !== "A") process.env.AI_MODEL_OVERRIDE_SONNET = "claude-sonnet-5-5";
  if (arm === "C") process.env.AI_SONNET55_THINKING = "between_tools";
}

interface Row {
  key: string;
  label: string;
  arm: Arm;
  model: string;
  success: boolean;
  reason: string | null;
  retries: number;
  inTok: number;
  outTok: number;
  cacheRd: number;
  cacheWr: number;
  usd: number;
  ms: number;
  stops: string[];
  thinkingBlocks: number;
  ttfcMs?: number;
  extra?: Record<string, unknown>;
}
function record(row: Row, output: unknown) {
  fs.appendFileSync(path.join(OUT, "results.jsonl"), JSON.stringify(row) + "\n");
  fs.writeFileSync(path.join(OUT, `${row.key}__${row.label}__${row.arm}.json`), JSON.stringify(output, null, 2));
  console.log(
    `${row.arm} ${row.key.padEnd(32)} ${row.label.padEnd(14)} ${row.success ? "OK  " : "FAIL"} ${row.reason ?? ""}` +
      ` retries=${row.retries} in=${row.inTok}+${row.cacheRd}r/${row.cacheWr}w out=${row.outTok} $${row.usd.toFixed(4)}` +
      ` ${row.ms}ms stops=${row.stops.join(",")}${row.ttfcMs != null ? ` ttfc=${row.ttfcMs}ms` : ""}  [spent $${spent.toFixed(3)}]`,
  );
}

type AnyResult = { success: boolean; reason?: string; metadata: { model?: string; latencyMs?: number; retryCount?: number } };
async function measure<T extends AnyResult>(
  key: string,
  label: string,
  arm: Arm,
  fn: () => Promise<T>,
  extra?: (r: T) => Record<string, unknown>,
): Promise<T> {
  setArm(arm);
  attempts = [];
  const t = Date.now();
  const r = await fn();
  const ms = Date.now() - t;
  const sum = (f: (a: Attempt) => number) => attempts.reduce((s, a) => s + f(a), 0);
  record(
    {
      key,
      label,
      arm,
      model: attempts[0]?.model ?? r.metadata.model ?? "?",
      success: r.success,
      reason: r.success ? null : (r.reason ?? null),
      retries: Math.max(0, attempts.length - 1),
      inTok: sum((a) => a.inTok),
      outTok: sum((a) => a.outTok),
      cacheRd: sum((a) => a.cacheRd),
      cacheWr: sum((a) => a.cacheWr),
      usd: sum((a) => a.usd),
      ms,
      stops: attempts.map((a) => a.error ? `ERR(${a.error.slice(0, 80)})` : String(a.stop)),
      thinkingBlocks: attempts.reduce((s, a) => s + a.blocks.filter((b) => b === "thinking").length, 0),
      extra: extra?.(r),
    },
    r,
  );
  return r;
}

const argArms = (process.argv[3] ?? "AB").split("") as Arm[];
const phase = process.argv[2];
const GEN_USER = "76f9d078-830e-45ef-beb3-11474dae716e"; // owner of 2251c7f5 — READ only

// ── narration ───────────────────────────────────────────────────────────
const NARR_PLANS = ["2251c7f5", "d06a721d", "c62587bb", "425da049", "163875ec"];
async function narr() {
  for (const p of NARR_PLANS) {
    const row = await prisma.mealPlanInstance.findFirst({ where: { id: { startsWith: p } }, select: { id: true, userId: true } });
    if (!row) throw new Error(`plan ${p} missing`);
    const loaded = await loadPrepWeekInput({ planId: row.id, userId: row.userId, prisma } as never);
    const texts = new Map<string, string[]>();
    for (const m of loaded.input.meals) for (const d of m.dishes) texts.set(d.dishId, d.stepTexts);
    const sp = buildStepPlan(
      combinePrep(buildPrepCombineInput(loaded.input), loaded.identity.foldedIdByIngredientId),
      loaded.input.planName,
      texts,
      loaded.cookDays.lagByMealId,
    );
    fs.writeFileSync(path.join(OUT, `narrInput__${p}.json`), JSON.stringify(sp.narrationInput, null, 2));
    for (const arm of argArms) {
      await measure(
        "prep.narrate_steps",
        p,
        arm,
        () =>
          runAICall("prep.narrate_steps", { prepNarrationInput: sp.narrationInput }, PrepNarrationResultSchema, {
            prisma: prisma as never,
            maxTokens: 16384, // PREP_NARRATION_MAX_TOKENS, routes/cooking.ts
            client: rec,
          }),
        (r) => {
          if (!r.success) return { plannedSteps: sp.steps.length };
          // The route's fail-closed check: every planned step narrated.
          try {
            assemblePrepWeekResult(sp, (r as { data: never }).data);
            return { plannedSteps: sp.steps.length, assembled: true };
          } catch (e) {
            return { plannedSteps: sp.steps.length, assembled: false, assembleError: String((e as Error).message).slice(0, 200) };
          }
        },
      );
    }
  }
}

// ── generation ──────────────────────────────────────────────────────────
const PREF_SETS: Record<string, Record<string, unknown>> = {
  family4picky: {
    planDurationDays: 5,
    householdSize: 4,
    cuisines: ["American", "Italian", "Mexican"],
    eatingStyles: [],
    allergiesAndAvoidances: [],
    difficulty: "easy",
    weeklyPacing: "mostly_easy",
    dietaryNotes: "Two picky kids (6 and 9): nothing spicy, no visible onions or mushrooms.",
    additionalNotes: "The kids will eat pasta, chicken, tacos and anything with cheese. Weeknights are rushed.",
  },
  med2: {
    planDurationDays: 5,
    householdSize: 2,
    cuisines: ["Mediterranean", "Greek", "Middle Eastern"],
    eatingStyles: [],
    allergiesAndAvoidances: [],
    difficulty: "medium",
    weeklyPacing: "mixed",
    additionalNotes: "We love fish, chickpeas, lemon and herbs.",
  },
  gf30: {
    planDurationDays: 5,
    householdSize: 2,
    cuisines: [],
    eatingStyles: [],
    allergiesAndAvoidances: ["Gluten-free"],
    difficulty: "easy",
    weeklyPacing: "minimal_effort",
    maxCookTimeMinutes: 30,
    maxCookTimeCoverage: "all",
    dietaryNotes: "Celiac in the house: strictly gluten-free, including sauces.",
  },
};

// Mirror of the closure in routes/wizard.ts (buildHiddenContext) — reads only.
async function buildHiddenContext(userId: string) {
  const [preferences, pantryStaples, recentMeals] = await Promise.all([
    prisma.userPreferences.findUnique({
      where: { userId },
      select: { cookingEquipment: true, spiceTolerance: true, budgetLevel: true, pickyAvoidances: true, recurringGroceryItems: true },
    }),
    prisma.pantryStaple.findMany({ where: { userId, isActive: true }, select: { ingredientName: true } }),
    prisma.userActivity.findMany({
      where: { userId, eventType: "cook_meal", entityType: "meal" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { entityId: true },
    }),
  ]);
  return {
    equipment: preferences?.cookingEquipment ?? [],
    spiceTolerance: preferences?.spiceTolerance ?? undefined,
    budgetLevel: preferences?.budgetLevel ?? undefined,
    pickyAvoidances: preferences?.pickyAvoidances ?? [],
    recurringItems: preferences?.recurringGroceryItems ?? [],
    pantryStaples: pantryStaples.map((p) => p.ingredientName),
    recentMealIds: recentMeals.map((a) => a.entityId).filter((id): id is string => !!id),
  };
}

async function candidateCount(): Promise<number> {
  const row = await prisma.systemSetting.findUnique({ where: { key: "wizard.candidate_count" } });
  return row ? Number(row.value) : 3;
}

// Mirror of POST /wizard/build-plans steps 1–4b (routes/wizard.ts).
async function buildGenerateVars(body: Record<string, unknown>) {
  const userId = GEN_USER;
  const parsed = WizardInputSchema.omit({ hiddenContext: true }).parse(body);
  const requestedCandidateCount = await candidateCount();
  const hiddenContext = await buildHiddenContext(userId);
  const [planningContext, recentRotation] = await Promise.all([
    buildPlanningContext(prisma, userId),
    buildRecentRotation(prisma, userId),
  ]);
  const { discoveryLevel, playlistLevel, saucePreference, maxCookTimeMinutes, maxCookTimeCoverage, ...aiInput } = parsed;
  const preferencesContext = await resolveEffectivePreferences(
    prisma,
    userId,
    { discoveryLevel: discoveryLevelFromInput({ discoveryLevel }), playlistLevel, saucePreference, maxCookTimeMinutes, maxCookTimeCoverage },
    { planDurationDays: aiInput.planDurationDays },
  );
  const { recentMeals: _r, ...planningContextBase } = planningContext;
  const resolvedAllergens = await resolveAllergenPreference(prisma, userId, aiInput.allergiesAndAvoidances, { route: "wizard.build_plans" });
  const wizardInput = {
    ...aiInput,
    allergiesAndAvoidances: resolvedAllergens.allergiesAndAvoidances,
    hiddenContext,
    planningContext: planningContextBase,
    preferencesContext,
    recentRotation,
    requestedCandidateCount,
  };
  const baseShortlist = await retrieveShelf(prisma, {
    cuisines: aiInput.cuisines ?? [],
    allergiesAndAvoidances: resolvedAllergens.allergiesAndAvoidances,
    difficulty: aiInput.difficulty,
    userId,
    excludeMealIds: hiddenContext.recentMealIds,
    maxCookTimeMinutes: preferencesContext.maxCookTimeMinutes,
    maxCookTimeCoverage: preferencesContext.maxCookTimeCoverage,
  });
  const storeShortlist =
    preferencesContext.playlistMealsPerWeek > 0
      ? await addPlaylistToShelf(prisma, baseShortlist, {
          userId,
          allergiesAndAvoidances: resolvedAllergens.allergiesAndAvoidances,
          difficulty: aiInput.difficulty,
        })
      : baseShortlist;
  return { wizardInput, storeShortlist, resolvedAllergens, preferencesContext, aiInput };
}

async function gen() {
  for (const [label, body] of Object.entries(PREF_SETS)) {
    const v = await buildGenerateVars(body);
    for (const arm of argArms) {
      let first: number | undefined;
      const t0 = Date.now();
      await measure(
        "wizard.set_preferences.generate",
        label,
        arm,
        () =>
          streamPlanCandidates(
            "wizard.set_preferences.generate",
            { wizardInput: v.wizardInput, storeShortlist: v.storeShortlist.forPrompt },
            {
              prisma: prisma as never,
              cacheSplitMarker: "{{storeShortlist}}",
              client: rec.messages as unknown as StreamCapableMessages,
              onCandidate: () => {
                first ??= Date.now() - t0;
              },
            },
          ),
        (r) => ({
          ttfcMs: first,
          candidates: r.success ? (r as unknown as { data: { candidates: unknown[] } }).data.candidates.length : 0,
          aliasToId: Object.fromEntries(v.storeShortlist.aliasToId ?? []),
        }),
      );
    }
  }
}

// ── expand + finalize (inputs chained from arm A) ───────────────────────
const EXPAND_PICKS: Array<[string, number]> = [["family4picky", 2], ["med2", 2], ["gf30", 1]];
async function expfin() {
  const units: Array<{ label: string; candidate: WizardPlanCandidate; title: string; ctx: Record<string, unknown> }> = [];
  for (const [set, n] of EXPAND_PICKS) {
    // Source = arm A's candidates; arm C's where A failed (med2: A hit
    // max_tokens). Either way every expand arm gets the SAME input.
    const read = (arm: string) => JSON.parse(fs.readFileSync(path.join(OUT, `wizard.set_preferences.generate__${set}__${arm}.json`), "utf8"));
    let genOut = read("A");
    if (!genOut.success) genOut = read("C");
    if (!genOut.success) throw new Error(`no generate output for ${set}`);
    const cands = WizardPlanCandidatesResultSchema.parse(genOut.data).candidates;
    // A LIVE slot is what reaches the expand AI (store slots compose from the DB).
    let picked = 0;
    for (const c of cands) {
      const store = new Set((c.storeSlots ?? []).map((s) => s.slotIndex));
      c.mealTitles.forEach((title, i) => {
        if (picked < n && !store.has(i)) {
          picked++;
          units.push({ label: `${set}#${units.length}`, candidate: c, title, ctx: PREF_SETS[set] });
        }
      });
      if (picked >= n) break;
    }
  }
  const expandedA: Record<string, unknown> = {};
  for (const u of units) {
    // Mirror of wizardExpansion.ts expandCandidate → expandOneMeal input shaping.
    const ctx = u.ctx as Record<string, never>;
    const resolved = await resolveEffectivePreferences(prisma, GEN_USER, {
      saucePreference: ctx.saucePreference,
      maxCookTimeMinutes: ctx.maxCookTimeMinutes,
      maxCookTimeCoverage: ctx.maxCookTimeCoverage,
    });
    const allergens = await resolveAllergenPreference(prisma, GEN_USER, ctx.allergiesAndAvoidances, { route: "wizard.expand" });
    const candidateContext = {
      planDurationDays: ctx.planDurationDays,
      householdSize: ctx.householdSize,
      wantsLeftovers: false,
      allergiesAndAvoidances: allergens.allergiesAndAvoidances,
      eatingStyles: ctx.eatingStyles ?? [],
      difficulty: ctx.difficulty,
      saucePreference: resolved.saucePreference,
      maxCookTimeMinutes: resolved.maxCookTimeMinutes,
      maxCookTimeCoverage: resolved.maxCookTimeCoverage,
    };
    const { meals: _m, mealDescriptions: _d, ...promptCandidate } = u.candidate as WizardPlanCandidate & { meals?: unknown; mealDescriptions?: unknown };
    const expandInput = { candidate: { ...promptCandidate, mealTitles: [u.title] }, candidateContext };
    fs.writeFileSync(path.join(OUT, `expandInput__${u.label}.json`), JSON.stringify(expandInput, null, 2));
    for (const arm of argArms) {
      const r = await measure("wizard.candidate.expand", u.label, arm, () =>
        runAICall("wizard.candidate.expand", { expandInput }, WizardExpandResultDetailsSchema, {
          prisma: prisma as never,
          maxTokens: 8192, // WIZARD_EXPAND_PER_MEAL_MAX_TOKENS
          client: rec,
        }),
      );
      if (arm === "A" && r.success) expandedA[u.label] = { candidate: u.candidate, data: (r as never as { data: unknown }).data };
    }
  }
  for (const u of units) {
    const a = expandedA[u.label] as { candidate: WizardPlanCandidate; data: { meals: Array<Record<string, unknown>> } } | undefined;
    if (!a) continue;
    // Mirror of wizardFinalize.ts finalizeOneMeal input shaping.
    const { activeTimeMinutes: _a, authoredEstimatedTimeMinutes: _b, timeSource: _c, ...meal } = a.data.meals[0];
    const finalizeInput = {
      candidateId: a.candidate.id,
      title: a.candidate.title,
      tags: a.candidate.tags,
      whyBullets: a.candidate.whyBullets,
      meals: [
        {
          ...meal,
          dishes: (meal.dishes as Array<Record<string, unknown>>).map(({ outline: _o, ...dish }) => dish),
        },
      ],
    };
    fs.writeFileSync(path.join(OUT, `finalizeInput__${u.label}.json`), JSON.stringify(finalizeInput, null, 2));
    for (const arm of argArms) {
      await measure("wizard.candidate.finalize_steps", u.label, arm, () =>
        runAICall("wizard.candidate.finalize_steps", { finalizeInput }, WizardFinalizeStepsResultSchema, {
          prisma: prisma as never,
          maxTokens: 4096, // WIZARD_FINALIZE_STEPS_PER_MEAL_MAX_TOKENS
          client: rec,
        }),
      );
    }
  }
}

// ── the rest of the live Sonnet keys, once each ─────────────────────────
const KNOWN_SECTIONS = ["produce", "meat_seafood", "dairy_eggs", "bakery_bread", "pantry", "canned", "frozen", "snacks", "household", "extras"];
const IMPORT_TEXT = `Lemony Chickpea and Spinach Skillet
Serves 4. Ready in 30 minutes.

Ingredients
2 tbsp olive oil
1 medium yellow onion, finely chopped
4 cloves garlic, minced
1 tsp ground cumin
1/2 tsp smoked paprika
2 cans (15 oz each) chickpeas, drained and rinsed
1 can (14.5 oz) diced tomatoes
1/2 cup vegetable broth
5 oz baby spinach
Zest and juice of 1 lemon
1/3 cup crumbled feta
Salt and pepper to taste

Method
1. Heat the oil in a large skillet over medium heat. Add the onion and cook until soft, about 6 minutes.
2. Stir in the garlic, cumin and paprika and cook 1 minute until fragrant.
3. Add the chickpeas, tomatoes and broth. Simmer 10 minutes, until slightly thickened, lightly mashing a few chickpeas.
4. Stir in the spinach a handful at a time until wilted. Add lemon zest and juice; season with salt and pepper.
5. Scatter with feta and serve with crusty bread.`;

async function other() {
  // wizard.directed.generate — one Tell Kiwi request; the Haiku parse runs once.
  setArm("A");
  const directedBody = {
    description: "Quick weeknight dinners for 3. One of us is vegetarian, and I have a big bag of spinach to use up. Nothing over 40 minutes.",
    householdSize: 3,
    cuisines: [],
    eatingStyles: [],
    allergiesAndAvoidances: [],
  };
  const hiddenContext = await buildHiddenContext(GEN_USER);
  const allergens = await resolveAllergenPreference(prisma, GEN_USER, [], { route: "wizard.tell_kiwi" });
  const parse = await runAICall(
    "wizard.directed.parse_intent",
    { parseInput: { userInput: directedBody.description, planDurationDays: 5, householdSize: 3, wantsLeftovers: false, eatingStyles: [], allergiesAndAvoidances: allergens.allergiesAndAvoidances, dietaryNotes: "", hiddenContext } },
    ParsedIntentSchema,
    { prisma: prisma as never, temperature: 0, client: rec },
  );
  addSpend(0); // Haiku spend already counted by rec
  if (!parse.success) throw new Error("haiku parse_intent failed");
  const [planningContext, recentRotation] = await Promise.all([buildPlanningContext(prisma, GEN_USER), buildRecentRotation(prisma, GEN_USER)]);
  const preferencesContext = await resolveEffectivePreferences(prisma, GEN_USER, { discoveryLevel: discoveryLevelFromInput({}) }, { planDurationDays: 5 });
  const { recentMeals: _r, ...planningContextForPrompt } = planningContext;
  const generateInput = {
    parsedIntent: parse.data,
    userInput: directedBody.description,
    planDurationDays: 5,
    householdSize: 3,
    wantsLeftovers: false,
    cuisines: [],
    weeklyPacing: undefined,
    eatingStyles: [],
    allergiesAndAvoidances: allergens.allergiesAndAvoidances,
    dietaryNotes: "",
    hiddenContext,
    planningContext: planningContextForPrompt,
    preferencesContext,
    recentRotation,
    requestedCandidateCount: await candidateCount(),
  };
  const tkPrefs = await prisma.userPreferences.findUnique({ where: { userId: GEN_USER }, select: { difficultyDefault: true } });
  const shelf = await retrieveShelf(prisma, {
    cuisines: [],
    allergiesAndAvoidances: allergens.allergiesAndAvoidances,
    difficulty: tkPrefs?.difficultyDefault ?? "easy",
    userId: GEN_USER,
    excludeMealIds: hiddenContext.recentMealIds,
    maxCookTimeMinutes: preferencesContext.maxCookTimeMinutes,
    maxCookTimeCoverage: preferencesContext.maxCookTimeCoverage,
  });
  for (const arm of argArms) {
    await measure("wizard.directed.generate", "spinach3", arm, () =>
      runAICall("wizard.directed.generate", { generateInput, storeShortlist: shelf.forPrompt }, WizardPlanCandidatesResultSchema, {
        prisma: prisma as never,
        client: rec,
      }),
    );
  }

}

async function grocery() {
  // grocery.generate_list — plan 96a94410, the only corpus plan whose AI subset
  // is non-empty (p3-grocerysubset.ts: 2 of 77 rows; every other plan 0). ⚠️ fillPurchaseSizesWithWriteBack is
  // SKIPPED (it writes Ingredient rows); the consolidated rows go in as-is.
  const plan = await prisma.mealPlanInstance.findFirst({
    where: { id: { startsWith: "96a94410" } },
    select: { id: true, userId: true, titleOverride: true, template: { select: { title: true } } },
  });
  const relationRows = await loadRelationRows(prisma);
  const relations = buildRelationIndex(relationRows);
  const consolidated = await consolidatePlanIngredients({ prisma, planId: plan!.id, userId: plan!.userId, relations, relationRows } as never);
  for (const arm of argArms) {
    await measure("grocery.generate_list", "96a94410", arm, async () => {
      try {
        const out = await generateFinalGroceryList(plan!.titleOverride ?? plan!.template?.title ?? "", consolidated, KNOWN_SECTIONS as never, {
          prisma: prisma as never,
          relations,
          client: rec,
        } as never);
        return { success: true, data: out, metadata: {} };
      } catch (e) {
        return { success: false, reason: String((e as Error).message).slice(0, 160), metadata: {} };
      }
    }, (r) => ({ consolidatedRows: consolidated.length, outRows: r.success ? (r as never as { data: { items: unknown[] } }).data.items.length : 0 }));
  }

}

async function importScale() {
  // import.reformat_for_kiwi — a fixed text recipe.
  for (const arm of argArms) {
    await measure("import.reformat_for_kiwi", "chickpea", arm, () =>
      reformatRecipeForKiwi({ rawText: IMPORT_TEXT }, { prisma: prisma as never, client: rec }),
    );
  }

  // recipes.scale_ingredients — the route's exact call, fixed input.
  const scaleInput = {
    recipeTitle: "Lemony Chickpea and Spinach Skillet",
    fromServings: 4,
    toServings: 6,
    ingredients: [
      { name: "olive oil", amount: "2 tbsp" },
      { name: "yellow onion", amount: "1 medium" },
      { name: "garlic", amount: "4 cloves" },
      { name: "ground cumin", amount: "1 tsp" },
      { name: "smoked paprika", amount: "1/2 tsp" },
      { name: "chickpeas", amount: "2 cans (15 oz each)" },
      { name: "diced tomatoes", amount: "1 can (14.5 oz)" },
      { name: "vegetable broth", amount: "1/2 cup" },
      { name: "baby spinach", amount: "5 oz" },
      { name: "lemon", amount: "1" },
      { name: "feta", amount: "1/3 cup" },
    ],
  };
  for (const arm of argArms) {
    await measure("recipes.scale_ingredients", "chickpea4to6", arm, () =>
      runAICall("recipes.scale_ingredients", { scaleInput }, ScaleResponseSchema, {
        prisma: prisma as never,
        temperature: 0,
        client: rec,
      }),
    );
  }
}

// "other" = directed only now; grocery + importScale split out (re-runnable alone).
const phases: Record<string, () => Promise<void>> = { narr, gen, expfin, other, grocery, importScale };
if (!phases[phase]) throw new Error(`phase? ${Object.keys(phases).join("|")}`);
try {
  await phases[phase]();
} finally {
  console.log(`\nphase ${phase} done · total spent $${spent.toFixed(3)}`);
  await base.$disconnect();
}
